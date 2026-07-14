import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { mythPlugin } from "./myth-plugin.js";
import {
  generateLocalPid,
  hostFramePlugin,
  loadConfigOrThrow,
  OrbitConfigError,
} from "./virtual-html.js";
import { resolveStage } from "./stage.js";
import { exec } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, readdirSync } from "node:fs";

/** Candidate entry files tried in order for LEGACY apps (no index.html of
 * their own) when `myth run` is invoked without --entry: the original
 * single-component layout boots a default-exported React component. Modern
 * apps ship index.html + a self-mounting entry and never need this. */
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

/** Directories never worth scanning for the app's own stylesheets. */
const CSS_SCAN_SKIP = new Set(["node_modules", "dist", "build", ".git"]);

/**
 * Scan the project's CSS files for bare @import specifiers (npm packages),
 * e.g. `@import "tailwindcss"`. Walks the tree (skipping dependency/build
 * dirs, depth-bounded) because modern apps keep their stylesheets under
 * src/styles/, not at the root.
 */
function detectCssImports(root: string, depth = 4): string[] {
  const imports = new Set<string>();
  const importRe = /@import\s+["']([^./][^"']*)["']/g;
  const walk = (dir: string, remaining: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (remaining > 0 && !CSS_SCAN_SKIP.has(entry.name) && !entry.name.startsWith(".")) {
          walk(path.join(dir, entry.name), remaining - 1);
        }
      } else if (entry.name.endsWith(".css")) {
        const contents = readFileSync(path.join(dir, entry.name), "utf-8");
        for (const match of contents.matchAll(importRe)) {
          imports.add(match[1]);
        }
      }
    }
  };
  walk(root, depth);
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

export async function startServer(
  start: string,
  requestedEntry?: string,
  requestedPort?: number,
  requestedStage?: string,
) {
  const stage = resolveStage(requestedStage);

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

  // Modern apps ship their own index.html — that document IS the inner app
  // (vite serves it on the app.localhost origin). Only legacy component apps
  // need an entry resolved for the virtual shell.
  const hasOwnIndexHtml = existsSync(path.join(root, "index.html"));
  const entry = hasOwnIndexHtml ? null : resolveEntry(root, requestedEntry);

  // An unprovisioned app (no projectId in config — AGE-78) still needs a pid
  // for the local kernel; derive a stable ephemeral one (never persisted). A
  // real publish provisions + writes the canonical id.
  const devProjectId = config.projectId ?? generateLocalPid(`${config.name}::${root}`);

  const plugins: import("vite").PluginOption[] = [
    hostFramePlugin({
      projectId: devProjectId,
      projectName: config.name,
      stage,
      entry,
    }),
    mythPlugin(),
    react(),
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
      // === 'string'` at runtime and uses it instead of deriving from the
      // page origin. Lets an app that bundles the collab client reach the
      // stage's collab server from the app.localhost origin.
      __ORBIT_COLLAB_URL__: JSON.stringify(stage.collabUrl),
    },
    resolve: {
      alias: {
        // The conventional `@/` alias: `src/` when the app has one (the
        // vite/shadcn convention modern apps like landing rely on), else the
        // project root (legacy single-dir apps).
        "@/": path.join(root, existsSync(path.join(root, "src")) ? "src" : ".") + "/",
        ...cssAliases,
      },
    },
    server: {
      // `--port` (CLI) > config.devPort > vite default (5173). Some apps'
      // Google OAuth clients only authorize specific localhost:<port>
      // origins; using a different port produces Error 400: origin_mismatch
      // on sign-in.
      port: requestedPort ?? (typeof config.devPort === "number" ? config.devPort : undefined),
      strictPort: requestedPort !== undefined || typeof config.devPort === "number",
      // One listener serves the whole production-shaped host split:
      // localhost (outer wrapper), app.localhost (the app), api.localhost /
      // auth.localhost (proxied backends). *.localhost resolves to loopback
      // per RFC 6761, so no /etc/hosts edits.
      allowedHosts: [".localhost"],
      fs: {
        allow: [root, cliRoot],
      },
    },
  });

  await server.listen();
  console.log(`[myth] stage        → ${stage.label}`);
  console.log(`[myth] api/auth     → ${stage.apiOrigin} / ${stage.authOrigin} (proxied on *.localhost)`);
  console.log(`[myth] collab url   → ${stage.collabUrl}`);
  console.log(`[myth] project: ${config.name} (${devProjectId}${config.projectId ? "" : " — local, unprovisioned"})`);
  server.printUrls();

  // Only auto-open when a human is at the terminal — background/automation
  // runs (CI, agents, scripts) must not hijack the user's browser.
  const url = server.resolvedUrls?.local[0];
  if (url && process.stdout.isTTY) {
    exec(`open "${url}"`);
  }
}
