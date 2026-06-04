import { createServer } from "vite";
import type { ProxyOptions } from "vite";
import preact from "@preact/preset-vite";
import { mythPlugin } from "./myth-plugin.js";
import { hostFramePlugin, loadConfigOrThrow, OrbitConfigError } from "./virtual-html.js";
import { exec } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const require = createRequire(import.meta.url);

/**
 * Resolve a package's ESM ("module") entry to an absolute path. Aliasing
 * every preact/react subpath to the SAME resolved file is what guarantees a
 * single preact instance: two copies (one for the renderer, one for hooks)
 * make hooks read `undefined.__H` at render time.
 */
function resolveEsm(pkg: string): string {
  const pkgJsonPath = require.resolve(`${pkg}/package.json`);
  const pkgDir = path.dirname(pkgJsonPath);
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  return path.join(pkgDir, pkgJson.module);
}

/** Candidate entry files tried in order when `myth run` is invoked
 * without --entry. Matches the conventions in modern mythwork apps:
 * src/main.tsx (tennis, lab-nav), then ts/tsx variants, then the
 * legacy single-file App.tsx layout from older examples. */
const DEFAULT_ENTRY_CANDIDATES = [
  "src/main.tsx",
  "src/main.ts",
  "src/App.tsx",
  "App.tsx",
];

function resolveEntry(root: string, requested: string | undefined): string {
  if (requested !== undefined) {
    if (!existsSync(path.join(root, requested))) {
      console.error(`[myth] entry not found: ${path.join(root, requested)}`);
      process.exit(1);
    }
    return requested;
  }
  for (const candidate of DEFAULT_ENTRY_CANDIDATES) {
    if (existsSync(path.join(root, candidate))) return candidate;
  }
  console.error(
    `[myth] no entry file found in ${root}. Tried: ${DEFAULT_ENTRY_CANDIDATES.join(", ")}. ` +
      `Pass --entry <file> to override.`,
  );
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliRoot = path.resolve(__dirname, "../..");

// Every URL prefix the production hosting worker serves. Anything under
// these paths gets proxied through vite to the backend so the browser
// hits localhost:5173 (first-party cookies) while the actual response
// comes from api.orbitcode.app (or a local wrangler override).
const BACKEND_PREFIXES = [
  "/provision",
  "/auth",
  "/room",
  "/cas",
  "/sync",
  "/publish",
  "/secrets",
  "/collab",
  "/favorites",
  "/templates",
  "/billing",
  "/stats",
  "/discover",
  "/dev",
  "/admin",
];

// Only paths that actually carry WebSocket upgrades need ws:true.
// Setting ws:true on every prefix makes node-http-proxy hook into the
// HTTP server's `upgrade` event broadly, which can starve vite's own
// HMR WebSocket at `/` — the browser console fills with
// `WebSocket connection to 'ws://localhost:5173/' failed`.
const WS_PREFIXES = new Set(["/sync", "/collab"]);

function buildBackendProxy(backendOrigin: string): Record<string, ProxyOptions> {
  const proxy: Record<string, ProxyOptions> = {};
  const secure = backendOrigin.startsWith("https:");
  for (const p of BACKEND_PREFIXES) {
    proxy[p] = {
      target: backendOrigin,
      changeOrigin: true,
      ws: WS_PREFIXES.has(p),
      secure,
    };
  }
  return proxy;
}

/** Scan CSS files at the project root for bare @import specifiers (npm packages). */
function detectCssImports(root: string): string[] {
  const imports = new Set<string>();
  const importRe = /@import\s+["']([^./][^"']*)["']/g;
  for (const file of readdirSync(root)) {
    if (file.endsWith(".css")) {
      const contents = readFileSync(path.join(root, file), "utf-8");
      for (const match of contents.matchAll(importRe)) {
        imports.add(match[1]);
      }
    }
  }
  return [...imports];
}

/** Resolve a CSS package's entry file from myth-cli's node_modules. */
function resolveCssEntry(pkg: string): string | null {
  const pkgDir = path.join(cliRoot, "node_modules", pkg);
  try {
    const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
    // Check exports["."].style, then style field, then main
    const entry =
      pkgJson.exports?.["."]?.style ??
      pkgJson.style ??
      pkgJson.main;
    if (entry) {
      return path.join(pkgDir, entry);
    }
    // For packages like tailwindcss, the directory itself is enough
    return pkgDir;
  } catch {
    return null;
  }
}

function resolveCollabUrl(backendOrigin: string): string {
  if (process.env.ORBIT_COLLAB_URL) return process.env.ORBIT_COLLAB_URL;
  if (backendOrigin.includes("localhost")) return "ws://localhost:1234";
  return "wss://collab.orbitcode.ai";
}

export async function startServer(
  start: string,
  requestedEntry?: string,
  requestedPort?: number,
) {
  const backendOrigin = process.env.MYTH_BACKEND_ORIGIN ?? "https://api.orbitcode.app";
  const backendProxy = buildBackendProxy(backendOrigin);
  const collabUrl = resolveCollabUrl(backendOrigin);

  let loaded;
  try {
    loaded = loadConfigOrThrow(start);
  } catch (e) {
    if (e instanceof OrbitConfigError) {
      console.error(`[myth] ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  const config = loaded.config;
  // Use the discovered config dir as vite's root so `cd src && myth
  // run` resolves to the project workspace, not the subdirectory we
  // were invoked from.
  const root = loaded.root;
  const entry = resolveEntry(root, requestedEntry);

  // Pin every preact/react specifier to ONE resolved ESM file (the CLI's own
  // preact) so the renderer and hooks share a single instance.
  const preactPaths = {
    preact: resolveEsm("preact"),
    "preact/compat": resolveEsm("preact/compat"),
    "preact/hooks": resolveEsm("preact/hooks"),
    "preact/jsx-runtime": resolveEsm("preact/jsx-runtime"),
    "preact/jsx-dev-runtime": resolveEsm("preact/jsx-runtime"), // shares one module
    "preact/debug": resolveEsm("preact/debug"),
    "preact/devtools": resolveEsm("preact/devtools"),
  };

  const plugins: import("vite").PluginOption[] = [
    hostFramePlugin({
      projectId: config.projectId,
      projectName: config.name,
      backendOrigin,
      entry,
    }),
    mythPlugin(),
    // OrbitCode apps are preact (`preact/hooks`, JSX → preact). The preset
    // compiles JSX to preact; we map the react family ourselves via the
    // alias table below, so disable the preset's own react aliasing.
    preact({ reactAliasesEnabled: false }),
  ];

  // Auto-detect CSS dependencies and resolve them from myth-cli's node_modules
  const cssImports = detectCssImports(root);
  const cssAliases: Record<string, string> = {};
  const usesTailwind = cssImports.includes("tailwindcss");

  for (const pkg of cssImports) {
    const entry = resolveCssEntry(pkg);
    if (entry) {
      cssAliases[pkg] = entry;
    }
  }

  if (usesTailwind) {
    const tailwindcss = await import("@tailwindcss/vite");
    plugins.push(tailwindcss.default());
  }

  const server = await createServer({
    root,
    configFile: false,
    plugins,
    define: {
      // @orbitcode/collab/collab-funcs checks `typeof __ORBIT_COLLAB_URL__
      // === 'string'` at runtime and uses it instead of deriving from
      // the page origin. Lets the app reach the prod collab server
      // even when the host page is localhost:5173.
      __ORBIT_COLLAB_URL__: JSON.stringify(collabUrl),
    },
    resolve: {
      // Single preact instance: react family → preact/compat, and every
      // preact subpath → the one resolved ESM file. dedupe guards against a
      // second copy sneaking in from the user project's own node_modules.
      dedupe: ["preact", "preact/hooks", "preact/compat", "preact/jsx-runtime"],
      alias: {
        "@/": root + "/",
        ...cssAliases,
        "react/jsx-runtime": preactPaths["preact/jsx-runtime"],
        "react/jsx-dev-runtime": preactPaths["preact/jsx-dev-runtime"],
        "react-dom/client": preactPaths["preact/compat"],
        "react-dom/test-utils": preactPaths["preact/compat"],
        "react-dom": preactPaths["preact/compat"],
        react: preactPaths["preact/compat"],
        "preact/jsx-runtime": preactPaths["preact/jsx-runtime"],
        "preact/jsx-dev-runtime": preactPaths["preact/jsx-dev-runtime"],
        "preact/hooks": preactPaths["preact/hooks"],
        "preact/compat": preactPaths["preact/compat"],
        "preact/debug": preactPaths["preact/debug"],
        "preact/devtools": preactPaths["preact/devtools"],
        preact: preactPaths.preact,
      },
    },
    server: {
      // `--port` (CLI) > config.devPort > vite default (5173). Tennis
      // and lab-nav pre-myth-cli ran on specific ports registered in
      // the Google OAuth client's Authorized JavaScript Origins; using
      // a different port produces Error 400: origin_mismatch on sign-in.
      port: requestedPort ?? (typeof config.devPort === "number" ? config.devPort : undefined),
      strictPort: requestedPort !== undefined || typeof config.devPort === "number",
      proxy: backendProxy,
      fs: {
        allow: [root, cliRoot],
      },
    },
  });

  await server.listen();
  console.log(`[myth] backend proxy → ${backendOrigin}`);
  console.log(`[myth] collab url   → ${collabUrl}`);
  console.log(`[myth] project: ${config.name} (${config.projectId})`);
  server.printUrls();

  const url = server.resolvedUrls?.local[0];
  if (url) {
    exec(`open "${url}"`);
  }
}
