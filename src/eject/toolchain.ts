// Ported from mythwork/shared/eject/toolchain.ts @ 6551446 (PR #655). See
// ./README.md for provenance + convergence. Maintenance note: REACT_VERSION /
// KNOWN_VERSIONS are hardcoded and must be bumped in lockstep with the
// platform's pinned versions (orbit-runtime-bundles) — tracked as a follow-up.
/**
 * Toolchain emission for the P6 eject transform.
 *
 * Given the rewrite report (which npm deps the app uses) + the detected entry,
 * emit the standard Vite/React project files that make the ejected source run
 * with `pnpm i && pnpm dev` (and `pnpm build` → static dist) — zero manual steps
 * for a Tier-1 app, zero mythwork dependency. Design §6 "toolchain emission".
 */

import type { RewriteReport } from './rewrite-imports.js'

/** React version the platform compiles against — keep the export in lockstep. */
export const REACT_VERSION = '19.2.7'

/** Best-known versions for blessed deps; unpinned ones default to `latest` and
 * are flagged in the README (the platform resolves them unversioned via esm.sh). */
const KNOWN_VERSIONS: Record<string, string> = {
  react: `^${REACT_VERSION}`,
  'react-dom': `^${REACT_VERSION}`,
  // Blessed deps (orbit-runtime-bundles/blessed.ts) — pinned to their current majors
  // for reproducible installs; only genuinely-unknown specifiers fall back to `latest`.
  'react-router-dom': '^7',
  yjs: '^13',
  lib0: '^0.2',
  'y-protocols': '^1',
  'y-codemirror.next': '^0.3',
  '@codemirror/state': '^6',
  '@codemirror/view': '^6',
  '@codemirror/commands': '^6',
  '@codemirror/lang-javascript': '^6',
  '@isomorphic-git/lightning-fs': '^4',
}

function depVersion(pkg: string): string {
  return KNOWN_VERSIONS[pkg] ?? 'latest'
}

export interface ToolchainOptions {
  /** Package name for the export (slugified elsewhere). */
  name?: string
  /** Entry module the HTML should load, e.g. `src/main.tsx`. */
  entry: string
}

/** Emit `package.json` (deps from the rewrite report + react + toolchain devDeps). */
export function emitPackageJson(report: RewriteReport, name: string): string {
  const deps: Record<string, string> = {
    react: depVersion('react'),
    'react-dom': depVersion('react-dom'),
  }
  for (const pkg of report.npmDeps) {
    if (pkg === 'react' || pkg === 'react-dom') continue
    deps[pkg] = depVersion(pkg)
  }
  const sorted = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)))
  const pkg = {
    name,
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'vite build',
      preview: 'vite preview',
    },
    dependencies: sorted,
    devDependencies: {
      '@types/react': `^${REACT_VERSION}`,
      '@types/react-dom': `^${REACT_VERSION}`,
      '@vitejs/plugin-react': '^4',
      typescript: '^5.9',
      vite: '^7',
    },
  }
  return `${JSON.stringify(pkg, null, 2)}\n`
}

/** Emit `vite.config.ts` — React plugin + the `@portable` → `src/_portable` alias. */
export function emitViteConfig(): string {
  return `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// '@portable/*' resolves to the vendored portable runtime in src/_portable/*
// (the standalone re-implementations of the mythwork runtime surface).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@portable': fileURLToPath(new URL('./src/_portable', import.meta.url)),
    },
  },
})
`
}

/** Emit `tsconfig.json` — React JSX + the matching `@portable/*` path mapping. */
export function emitTsconfig(): string {
  const cfg = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      types: ['vite/client'],
      baseUrl: '.',
      paths: { '@portable/*': ['./src/_portable/*'] },
    },
    include: ['src'],
  }
  return `${JSON.stringify(cfg, null, 2)}\n`
}

/** Emit `index.html` loading the detected entry module. */
export function emitIndexHtml(name: string, entry: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/${entry}"></script>
  </body>
</html>
`
}

/** Emit `.gitignore` — keep `.env` and build output out of the repo. */
export function emitGitignore(): string {
  return ['node_modules', 'dist', '.env', '.env.*', '!.env.example', ''].join('\n')
}

/** Minimal bootstrap entry, emitted only when the app has no entry of its own. */
export function emitBootstrapEntry(): string {
  return `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`
}

/** Emit every always-safe toolchain config file (not the HTML/entry, which
 * depend on the detected entry — the pipeline adds those). */
export function emitToolchain(
  report: RewriteReport,
  opts: ToolchainOptions,
): Record<string, string> {
  const name = opts.name ?? 'my-app'
  return {
    'package.json': emitPackageJson(report, name),
    'vite.config.ts': emitViteConfig(),
    'tsconfig.json': emitTsconfig(),
    '.gitignore': emitGitignore(),
    'index.html': emitIndexHtml(name, opts.entry),
  }
}
