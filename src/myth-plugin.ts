import type { Plugin } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliRoot = path.resolve(__dirname, "../..");
const cliPackageJson = path.join(cliRoot, "package.json");

// Modules that should resolve from myth-cli's own node_modules (not the
// user project's). Everything else that's a bare import falls through to
// the esm.sh redirect below so apps can `import 'three'` etc. without
// having to npm install it locally.
const KNOWN_MODULES = new Set([
  "react",
  "react-dom",
  "react-dom/client",
  "react-dom/test-utils",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
]);

/**
 * Minimal vite plugin that lets app source bare-import packages from
 * esm.sh (three, reveal.js, etc.) without having to install them.
 *
 * Known modules (react family) resolve from myth-cli's node_modules so
 * there's exactly one copy in the runtime. Everything else gets
 * redirected to esm.sh with react externalized so the CDN bundle uses
 * the same react instance the app does.
 */
export function mythPlugin(): Plugin {
  return {
    name: "myth",
    enforce: "pre",

    async resolveId(id, importer, options) {
      // Resolve known modules from CLI's node_modules (not user project)
      if (KNOWN_MODULES.has(id)) {
        const resolved = await this.resolve(id, cliPackageJson, { ...options, skipSelf: true });
        return resolved ?? null;
      }

      // @orbitcode/* are workspace packages that pnpm symlinks into the
      // user project's node_modules. Defer to vite's default resolver
      // (return null = "not mine"). NEVER fall back to esm.sh — those
      // packages aren't published, esm.sh always 404s.
      if (id.startsWith('@orbitcode/')) {
        return null;
      }

      // Other bare imports: try local resolve, fall back to esm.sh for
      // unbundled third-party libs (three, reveal.js, etc.). The
      // `?external=react,...` makes esm.sh emit bare specifiers that
      // resolve back through our KNOWN_MODULES alias above.
      if (isBareImport(id)) {
        const local = await this.resolve(id, importer, { ...options, skipSelf: true });
        if (local) return local;
        return {
          id: `https://esm.sh/${id}?external=react,react-dom,react/jsx-runtime&target=es2022`,
          external: true,
        };
      }

      return null;
    },
  };
}

function isBareImport(id: string): boolean {
  // Bare imports don't start with . or / and aren't URLs
  if (id.startsWith(".") || id.startsWith("/")) return false;
  if (id.startsWith("http://") || id.startsWith("https://")) return false;
  if (id.startsWith("\0")) return false; // virtual module
  return true;
}
