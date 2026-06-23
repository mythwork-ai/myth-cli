import type { Plugin } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

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

interface WrapperOptions {
  projectId: string;
  projectName: string;
  backendOrigin: string;
}

/**
 * Outer wrapper HTML served at `/`. It pulls /dev/host-frame.js through
 * the vite proxy (so it ends up at the backend), then iframes the app
 * at /app/<original-path>. The host-frame init script wires up
 * iframeOrigin + authOrigin to the page origin so all RPCs go through
 * the proxy (first-party cookies on localhost:5173).
 */
function generateWrapperHtml(opts: WrapperOptions, config: OrbitConfig): string {
  const title = config.name ?? "OrbitCode App";
  const icon = config.icon ?? "\u{1FA90}";
  const bgColor = config.defaultTheme === "light" ? "#ffffff" : "#0e1418";
  const projectIdJson = JSON.stringify(opts.projectId);
  const projectNameJson = JSON.stringify(opts.projectName);

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
    Loaded RELATIVE so vite's proxy forwards it to the backend
    (api.orbitcode.app by default; override with MYTH_BACKEND_ORIGIN).
    The worker inlines window.__OC_HOST_CONFIG into this bundle so
    googleClientId is available without a separate fetch.
  -->
  <script src="/dev/host-frame.js"></script>
</head>
<body>
  <iframe id="app-frame"
    sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
    allow="autoplay; fullscreen"></iframe>
  <script>
    // Build inner iframe URL from outer pathname so /match/xyz reaches
    // the app at /app/match/xyz. Runs before the iframe loads because
    // it has no static src attribute. Mirror tennis's wrapper logic.
    (function () {
      var outerPath = location.pathname || '/';
      var src = outerPath.indexOf('/app') === 0
        ? outerPath + location.search + location.hash
        : '/app' + (outerPath === '/' ? '/' : outerPath) + location.search + location.hash;
      document.getElementById('app-frame').src = src;
    })();

    // Sync outer URL bar when the inner App posts 'oc-navigate'.
    window.addEventListener('message', function (e) {
      var frame = document.getElementById('app-frame');
      if (e.source !== (frame && frame.contentWindow)) return;
      if (!e.data || e.data.type !== 'oc-navigate') return;
      var p = typeof e.data.path === 'string' ? e.data.path : null;
      if (!p || p.charAt(0) !== '/') return;
      if (location.pathname === p) return;
      history.pushState(null, '', p);
    });

    // Boot the host-frame bundle. iframeOrigin + authOrigin both point
    // at the page origin so every fetch travels through the proxy.
    function bootHostFrame() {
      var hf = window.__hf;
      if (!hf) {
        console.error('[myth] host-frame bundle not loaded from /dev/host-frame.js');
        return;
      }
      var serverConfig = window.__OC_HOST_CONFIG || {};
      hf.init({
        projectId: ${projectIdJson},
        projectName: ${projectNameJson},
        iframeOrigin: location.origin,
        authOrigin: location.origin,
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
          console.error('[myth] host-frame bundle never loaded after 5s. Backend down?');
        }
      }, 100);
    }
  </script>
</body>
</html>`;
}

/**
 * Inner-app HTML served at /app/ (and all SPA fallbacks under /app/).
 * Imports the app's entry as a module via vite's normal transform.
 */
function generateAppHtml(config: OrbitConfig, entry: string): string {
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

interface HostFramePluginOptions {
  projectId: string;
  projectName: string;
  backendOrigin: string;
  entry: string;
}

/**
 * Two-page wrapper:
 *   - GET /          → outer host-frame parent (iframes /app/)
 *   - GET /app/*     → inner app shell that boots <entry>
 *
 * /app/<anything> non-asset requests get rewritten to /app/ so vite
 * always serves the app shell HTML; the inner App reads the real path
 * from window.location.pathname (matching the tennis/lab-nav pattern).
 */
export function hostFramePlugin(opts: HostFramePluginOptions): Plugin {
  let root: string;
  const virtualEntry = buildVirtualEntry(opts.entry);

  return {
    name: "myth-host-frame",
    enforce: "pre",

    configResolved(config) {
      root = config.root;
    },

    resolveId(id) {
      if (id === VIRTUAL_ENTRY_ID) {
        return RESOLVED_ENTRY_ID;
      }
      return null;
    },

    load(id) {
      if (id === RESOLVED_ENTRY_ID) {
        return virtualEntry;
      }
      return null;
    },

    configureServer(server) {
      // SPA fallback for /app/* — rewrite non-asset URLs to /app/ so
      // vite serves the app shell on every nested route.
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "";
        if (
          url.startsWith("/app/") &&
          url !== "/app/" &&
          !/\.[a-z0-9]+($|\?)/i.test(url)
        ) {
          req.url = "/app/";
        }
        next();
      });

      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        const config = readConfigSafe(root);

        // Outer host-frame parent
        if (url === "/" || url === "/index.html") {
          const realHtml = path.join(root, "index.html");
          if (!existsSync(realHtml)) {
            res.setHeader("Content-Type", "text/html");
            res.end(
              generateWrapperHtml(
                {
                  projectId: opts.projectId,
                  projectName: opts.projectName,
                  backendOrigin: opts.backendOrigin,
                },
                config,
              ),
            );
            return;
          }
        }

        // Inner app shell — anything under /app/ that vite would
        // otherwise 404 on (no app/index.html in the workspace).
        if (url === "/app/" || url === "/app" || url === "/app/index.html") {
          const realHtml = path.join(root, "app", "index.html");
          if (!existsSync(realHtml)) {
            res.setHeader("Content-Type", "text/html");
            res.end(generateAppHtml(config, opts.entry));
            return;
          }
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
    return configFromPackageJson(JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")));
  } catch {
    return {};
  }
}
