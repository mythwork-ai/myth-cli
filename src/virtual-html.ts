import type { Plugin } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Stage } from "./stage.js";
import { classifyHost, proxyRequest } from "./dev-proxy.js";

const VIRTUAL_ENTRY_ID = "virtual:myth-entry";
const RESOLVED_ENTRY_ID = "\0" + VIRTUAL_ENTRY_ID;

interface OrbitConfig {
  projectId?: string;
  name?: string;
  /** Pin the dev server's port. Useful when the app's Google OAuth
   * client only authorizes a specific localhost:<port> origin. */
  devPort?: number;
  icon?: string;
  defaultTheme?: "dark" | "light";
}

export class OrbitConfigError extends Error {}

const CREATE_HINT =
  'Add a "mythwork" block to package.json (e.g. {"mythwork":{"displayName":"<app name>"}}), ' +
  'or create a legacy myth.config.json ({"projectId":"<17-char pid>","name":"<app name>"}).';

/**
 * AGE-97 content block carried in package.json's "mythwork" field. App trees
 * moved their project content here when myth.config.json was deleted; only
 * `displayName` (and an optional `theme`) feed the loader — the per-(user,
 * stage) projectId stays in the MYTH_PROJECT_ID env, never package.json.
 */
interface MythworkBlock {
  displayName?: string;
  theme?: string;
}

/**
 * Walk up from `start` looking for the project root: the nearest ancestor dir
 * containing EITHER myth.config.json (legacy/explicit root) OR package.json
 * (AGE-97 modern root — content lives in its "mythwork" block). When both sit
 * at the same level the config file wins (resolved in the loader). Same
 * walk-up discipline as `npm`/`git`/`cargo` finding package.json / .git /
 * Cargo.toml — this is how `myth run`/`publish` find the project root
 * regardless of which subdirectory the user invoked from.
 */
function findConfigRoot(start: string): string | null {
  let dir = path.resolve(start);
  while (true) {
    if (
      existsSync(path.join(dir, "myth.config.json")) ||
      existsSync(path.join(dir, "package.json"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface LoadedConfig {
  config: OrbitConfig & { name: string };
  /** Directory containing the discovered myth.config.json or package.json. */
  root: string;
}

/**
 * Load the project config by walking up from `start`. Prefers a legacy
 * myth.config.json (byte-identical to its historical behavior — landing relies
 * on this); when only package.json is present (AGE-97 deleted the config file
 * from app trees), the "mythwork" block supplies the same LoadedConfig shape.
 * Throws only when NEITHER file exists anywhere up the tree.
 *
 * projectId stays OPTIONAL either way: `myth publish` resolves the per-(user,
 * stage) pin from the MYTH_PROJECT_ID env (see resolvePinnedProjectId), and
 * `myth run` derives an ephemeral local pid when none is set.
 */
export function loadConfigOrThrow(start: string): LoadedConfig {
  const root = findConfigRoot(start);
  if (root === null) {
    throw new OrbitConfigError(
      `No myth project found in ${start} or any parent directory. ${CREATE_HINT}`,
    );
  }

  // Legacy/explicit root: myth.config.json wins when present (unchanged).
  const configPath = path.join(root, "myth.config.json");
  if (existsSync(configPath)) {
    let parsed: OrbitConfig;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (e) {
      throw new OrbitConfigError(
        `myth.config.json in ${root} is not valid JSON: ${(e as Error).message}`,
      );
    }
    return {
      config: {
        ...parsed,
        name: parsed.name ?? "OrbitCode App",
      },
      root,
    };
  }

  // AGE-97 modern path: derive content from package.json's "mythwork" block.
  // projectId/icon/devPort are absent here (projectId comes from the env pin).
  let pkg: { name?: string; mythwork?: MythworkBlock };
  try {
    pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));
  } catch (e) {
    throw new OrbitConfigError(
      `package.json in ${root} is not valid JSON: ${(e as Error).message}`,
    );
  }
  const config = configFromPackageJson(pkg);
  return {
    config: { ...config, name: config.name ?? "OrbitCode App" },
    root,
  };
}

/**
 * Map a package.json's AGE-97 "mythwork" block onto an OrbitConfig. The single
 * source of truth for the package.json fallback, shared by `loadConfigOrThrow`
 * (publish/run gate) and `readConfigSafe` (dev-server wrapper HTML).
 */
function configFromPackageJson(pkg: { name?: string; mythwork?: MythworkBlock }): OrbitConfig {
  const mythwork = pkg.mythwork ?? {};
  const theme = mythwork.theme;
  return {
    name: mythwork.displayName ?? pkg.name,
    defaultTheme: theme === "light" || theme === "dark" ? theme : undefined,
  };
}

/**
 * Derive a stable 17-char lowercase-alphanumeric local pid from a seed,
 * matching the production pid shape so URL matchers / kernel validators
 * accept it. Used by `myth run` for an UNPROVISIONED app's local-only dev
 * session (never written to disk — publish provisions the real one).
 */
export function generateLocalPid(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 17).toLowerCase();
}

export interface WrapperOptions {
  projectId: string;
  projectName: string;
  stage: Stage;
  /** Port of the dev listener, taken from the incoming request's Host. */
  port: string;
}

/**
 * Outer host-frame wrapper HTML, served for EVERY top-level document request
 * on the `localhost` (outer) host — mirroring workers/serve, which renders
 * the outer wrapper unconditionally around every deployed app. The app's own
 * index.html is never the outer document; it loads inside the iframe from the
 * `app.localhost` origin, the dev parallel of the `{tree}{token}.{zone}`
 * inner origin (same listener, but a genuinely distinct browser origin).
 *
 * The host-frame bundle loads from /_hf/host-frame.js — proxied to the target
 * stage's serve worker, so the wrapper always boots the exact bundle version
 * that stage runs. The bundle's prelude sets window.__OC_HOST_CONFIG
 * (googleClientId) before `__hf` is defined.
 */
export function generateWrapperHtml(opts: WrapperOptions, config: OrbitConfig): string {
  const title = config.name ?? "OrbitCode App";
  const icon = config.icon ?? "\u{1FA90}";
  const bgColor = config.defaultTheme === "light" ? "#ffffff" : "#0e1418";
  const appOrigin = `http://app.localhost:${opts.port}`;
  const authOrigin = `http://auth.localhost:${opts.port}`;
  const apiOrigin = `http://api.localhost:${opts.port}`;
  const projectIdJson = JSON.stringify(opts.projectId);
  const projectNameJson = JSON.stringify(opts.projectName);
  const backendOriginsJson = JSON.stringify({
    api: apiOrigin,
    auth: authOrigin,
    collab: opts.stage.collabUrl,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text x='50' y='75' font-size='70' text-anchor='middle'>${icon}</text></svg>">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: ${bgColor}; }
    iframe#app-frame { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none; }
  </style>
  <!--
    Same bundle the target stage's serve worker inlines into deployed
    outer pages; /_hf/* is proxied there, so no version skew. Its prelude
    sets window.__OC_HOST_CONFIG (googleClientId).
  -->
  <script src="/_hf/host-frame.js"></script>
</head>
<body>
  <iframe id="app-frame"
    sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
    allow="autoplay; fullscreen"></iframe>
  <script>
    // The inner app serves the SAME path scheme as the outer page (single-SPA
    // layout — production passes pathAndSearch straight through to the inner
    // origin), so forward the outer URL verbatim to the app origin.
    (function () {
      var src = ${JSON.stringify(appOrigin)}
        + (location.pathname || '/') + location.search + location.hash;
      document.getElementById('app-frame').src = src;
    })();

    // Sync the outer URL bar when the inner app posts 'oc-navigate' (apps
    // push their canonical share URLs; the outer address bar mirrors them).
    window.addEventListener('message', function (e) {
      var frame = document.getElementById('app-frame');
      if (e.source !== (frame && frame.contentWindow)) return;
      if (!e.data || e.data.type !== 'oc-navigate') return;
      var p = typeof e.data.path === 'string' ? e.data.path : null;
      if (!p || p.charAt(0) !== '/') return;
      if (location.pathname === p) return;
      history.pushState(null, '', p);
    });

    function bootHostFrame() {
      var hf = window.__hf;
      if (!hf) {
        console.error('[myth] host-frame bundle not loaded from /_hf/host-frame.js. Stage down?');
        return;
      }
      var serverConfig = window.__OC_HOST_CONFIG || {};
      hf.init({
        projectId: ${projectIdJson},
        projectName: ${projectNameJson},
        appId: ${projectIdJson},
        iframeOrigin: ${JSON.stringify(appOrigin)},
        authOrigin: ${JSON.stringify(authOrigin)},
        backendOrigins: ${backendOriginsJson},
        googleClientId: serverConfig.googleClientId,
      });
    }
    if (typeof window.__hf !== 'undefined') {
      bootHostFrame();
    } else {
      var attempts = 0;
      var id = setInterval(function () {
        if (typeof window.__hf !== 'undefined') {
          clearInterval(id);
          bootHostFrame();
        } else if (++attempts > 50) {
          clearInterval(id);
          console.error('[myth] host-frame bundle never loaded after 5s. Stage down?');
        }
      }, 100);
    }
  </script>
</body>
</html>`;
}

/**
 * Inner-app HTML for LEGACY apps that ship no index.html of their own (the
 * original single-component `myth run` layout). Served on the app.localhost
 * origin; boots the resolved entry via vite's virtual module. Modern apps
 * (own index.html) never see this — vite serves their real document.
 */
export function generateAppHtml(config: OrbitConfig): string {
  const title = config.name ?? "OrbitCode App";
  const bgColor = config.defaultTheme === "light" ? "#ffffff" : "#000000";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body, #root { width: 100%; height: 100%; background: ${bgColor}; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/@id/__x00__virtual:myth-entry"></script>
</body>
</html>`;
}

function buildVirtualEntry(entry: string): string {
  return `
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import App from '/${entry}';
createRoot(document.getElementById('root')).render(createElement(App));
`;
}

/** True for vite-internal / asset-ish URLs that must reach vite untouched. */
export function isAssetUrl(url: string): boolean {
  return (
    url.startsWith("/@") || url.startsWith("/node_modules/") || /\.[a-z0-9]+($|\?)/i.test(url)
  );
}

export interface HostFramePluginOptions {
  projectId: string;
  projectName: string;
  stage: Stage;
  /**
   * Entry file for LEGACY apps with no root index.html (default-export
   * component layout). `null` for modern apps — their own index.html is the
   * inner document and no virtual entry is mounted.
   */
  entry: string | null;
}

/**
 * Deployment-shaped dev host, mirroring the production host split on
 * `*.localhost` subdomains of the one vite listener:
 *
 *   localhost:{port}       → outer host-frame wrapper (ALWAYS — like
 *                            workers/serve, regardless of the app's own
 *                            index.html)
 *   app.localhost:{port}   → the app document (vite-served index.html, or
 *                            the legacy virtual-entry shell)
 *   api.localhost:{port}   → proxied to the stage's api host
 *   auth.localhost:{port}  → proxied to the stage's auth host
 *   /_hf/*, /_oc/*         → proxied to the stage's serve worker
 */
export function hostFramePlugin(opts: HostFramePluginOptions): Plugin {
  let root: string;
  const virtualEntry = opts.entry === null ? null : buildVirtualEntry(opts.entry);

  return {
    name: "myth-host-frame",
    enforce: "pre",

    configResolved(config) {
      root = config.root;
    },

    resolveId(id) {
      if (id === VIRTUAL_ENTRY_ID && virtualEntry !== null) {
        return RESOLVED_ENTRY_ID;
      }
      return null;
    },

    load(id) {
      if (id === RESOLVED_ENTRY_ID && virtualEntry !== null) {
        return virtualEntry;
      }
      return null;
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "/";
        const kind = classifyHost(req.headers.host);

        // Backend hosts — mirror the production hostname split.
        if (kind === "api") {
          void proxyRequest(req, res, opts.stage.apiOrigin);
          return;
        }
        if (kind === "auth") {
          void proxyRequest(req, res, opts.stage.authOrigin);
          return;
        }

        // Serve-worker paths, on any remaining host: the host-frame bundle +
        // first-party token (/_hf/*) for the outer page, and the preview
        // compiler (/_oc/*) for inner apps like myth-ide.
        if (url.startsWith("/_hf/") || url.startsWith("/_oc/")) {
          void proxyRequest(req, res, opts.stage.serveOrigin);
          return;
        }

        // Outer host: every document request renders the wrapper —
        // production's serve worker wraps unconditionally, so we do too.
        if (kind === "outer") {
          const port = (req.headers.host ?? "").split(":")[1] ?? "80";
          const config = readConfigSafe(root);
          res.setHeader("Content-Type", "text/html");
          res.end(
            generateWrapperHtml(
              {
                projectId: opts.projectId,
                projectName: opts.projectName,
                stage: opts.stage,
                port,
              },
              config,
            ),
          );
          return;
        }

        // App host, legacy layout: no real index.html to serve, so answer
        // every document-ish URL with the virtual-entry shell (SPA fallback
        // included). Modern apps fall through to vite, whose own SPA
        // fallback serves their real index.html.
        if (kind === "app" && virtualEntry !== null && !isAssetUrl(url)) {
          const config = readConfigSafe(root);
          res.setHeader("Content-Type", "text/html");
          res.end(generateAppHtml(config));
          return;
        }

        next();
      });
    },
  };
}

function readConfigSafe(root: string): OrbitConfig {
  const configPath = path.join(root, "myth.config.json");
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      return {};
    }
  }
  // AGE-97: no myth.config.json — fall back to package.json's "mythwork" block
  // so the dev wrapper still gets the right title/theme.
  try {
    return configFromPackageJson(
      JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")),
    );
  } catch {
    return {};
  }
}
