import type { Plugin } from "vite";
import { existsSync, readFileSync } from "node:fs";
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
  'Create one with: {"projectId":"<17-char pid>","name":"<app name>"}.';

/**
 * Walk up from `start` looking for myth.config.json. Returns the
 * directory containing it. This is how `orbit run` finds the project
 * root regardless of which subdirectory the user invoked from — same
 * pattern as `npm`/`git`/`cargo` walking up to find package.json /
 * .git / Cargo.toml.
 */
function findConfigRoot(start: string): string | null {
  let dir = path.resolve(start);
  while (true) {
    if (existsSync(path.join(dir, "myth.config.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface LoadedConfig {
  config: OrbitConfig & { projectId: string; name: string };
  /** Directory containing the discovered myth.config.json. */
  root: string;
}

/**
 * Load myth.config.json by walking up from `start`. Errors out if
 * the file isn't found anywhere up the tree or `projectId` is absent
 * — orbit run only works against a provisioned project (or a stable
 * dev pid the user pasted).
 */
export function loadConfigOrThrow(start: string): LoadedConfig {
  const root = findConfigRoot(start);
  if (root === null) {
    throw new OrbitConfigError(
      `myth.config.json not found in ${start} or any parent directory. ${CREATE_HINT}`,
    );
  }
  const configPath = path.join(root, "myth.config.json");
  let parsed: OrbitConfig;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (e) {
    throw new OrbitConfigError(
      `myth.config.json in ${root} is not valid JSON: ${(e as Error).message}`,
    );
  }
  if (!parsed.projectId) {
    throw new OrbitConfigError(
      `myth.config.json in ${root} has no "projectId". ${CREATE_HINT}`,
    );
  }
  return {
    config: {
      ...parsed,
      projectId: parsed.projectId,
      name: parsed.name ?? "OrbitCode App",
    },
    root,
  };
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
    (api.orbitcode.app by default; override with ORBIT_BACKEND_ORIGIN).
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
        console.error('[orbit] host-frame bundle not loaded from /dev/host-frame.js');
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
          console.error('[orbit] host-frame bundle never loaded after 5s. Backend down?');
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
    name: "orbit-host-frame",
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
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}
