// Ported from mythwork/shared/eject/index.ts @ 6551446 (PR #655). See ./README.md
// for provenance, the .js-extension rationale, and the convergence plan.
/**
 * P6 eject pipeline — pure `fileMap → standalone fileMap`.
 *
 * Composes the crux transform (Phoenix: `rewrite-imports` + `platform-specifiers`)
 * with the vendored portable runtime + toolchain emission so the output is a
 * self-contained Vite/React project that runs off-platform with `pnpm i && pnpm
 * dev`, depending on nothing of ours. Pure and deterministic — golden-testable,
 * no host/server/network. Wiring (host "Download" bridge, server env-decrypt,
 * eval-gate) is the scoped fast-follow; this is the transform core it plugs into.
 */

import { rewriteImports } from './rewrite-imports.js'
import { FULLY_SUPPORTED, vendorPortable } from './portable-runtime.js'
import { emitBootstrapEntry, emitToolchain } from './toolchain.js'

// Real entry modules only (a module that mounts the app), NOT App components:
// an App-only app gets a synthesized bootstrap (below) that imports it, which
// is the correct off-platform behavior. `src/main.ts` is added to match
// bin/myth.ts's DEFAULT_ENTRY_CANDIDATES — `myth run` accepts it, so `myth
// eject` must recognize it too rather than synthesize a redundant bootstrap.
const ENTRY_CANDIDATES = [
  'src/main.tsx',
  'src/main.ts',
  'src/main.jsx',
  'src/index.tsx',
  'src/index.jsx',
  'main.tsx',
  'index.tsx',
]

export interface EjectOptions {
  /** Package name for the emitted project (default 'my-app'). */
  name?: string
}

export interface EjectResult {
  /** The complete standalone project: rewritten app source + vendored runtime + toolchain + README. */
  files: Record<string, string>
  /** Platform subpaths the app used that degrade off-platform (README documents them). */
  degraded: string[]
  /** Non-blessed npm specifiers the user must pin/verify manually. */
  reviewDeps: string[]
  /** Files → residual platform specifiers after rewrite. MUST be empty (the portability gate). */
  residual: Record<string, string[]>
  /** Human-readable notes about what the transform assumed/changed. */
  warnings: string[]
}

function detectEntry(files: Record<string, string>): string | null {
  for (const c of ENTRY_CANDIDATES) if (c in files) return c
  return null
}

/** Run the full eject transform over a pulled app file map. */
export function eject(files: Record<string, string>, opts: EjectOptions = {}): EjectResult {
  const name = opts.name ?? 'my-app'
  const warnings: string[] = []

  // 1. Rewrite platform imports → @portable/* (Phoenix's crux transform).
  const { files: rewritten, report, residual } = rewriteImports(files)

  // 2. Entry: reuse the app's own if present, else emit a bootstrap (needs App).
  let entry = detectEntry(rewritten)
  const out: Record<string, string> = { ...rewritten }
  if (!entry) {
    // The bootstrap imports './App' relative to its OWN location, so place it
    // next to the App component it renders — beside src/App.* (the common case)
    // or beside a root-level App.* — else the emitted import wouldn't resolve.
    const hasSrcApp = 'src/App.tsx' in rewritten || 'src/App.jsx' in rewritten
    const hasRootApp = 'App.tsx' in rewritten || 'App.jsx' in rewritten
    entry = hasRootApp && !hasSrcApp ? 'main.tsx' : 'src/main.tsx'
    out[entry] = emitBootstrapEntry()
    const hasApp = hasSrcApp || hasRootApp
    warnings.push(
      hasApp
        ? `No entry module found; emitted a bootstrap ${entry} that renders ./App.`
        : `No entry module and no App component found; emitted ${entry} importing ./App — verify the entry after export.`,
    )
  }

  // 3. Vendor the portable runtime for every platform subpath the app imports.
  Object.assign(out, vendorPortable(report.platformSubpaths))

  // 4. Toolchain — add only files the app doesn't already provide.
  const toolchain = emitToolchain(report, { name, entry })
  for (const [path, content] of Object.entries(toolchain)) {
    if (path in out) warnings.push(`Kept the app's existing ${path} (did not overwrite).`)
    else out[path] = content
  }

  // 5. Secrets scaffold. The secrets shim reads {{NAME}} placeholders from Vite
  //    env as VITE_<NAME>, so an app that uses secrets needs a .env.example
  //    telling the user exactly which vars to fill — otherwise the README's
  //    "copy .env.example" step points at a file that doesn't exist. Emit it
  //    from the placeholders the app actually references (never overwrite one
  //    the app already shipped).
  const usesSecrets = report.platformSubpaths.has('secrets')
  if (usesSecrets && !('.env.example' in out)) {
    out['.env.example'] = emitEnvExample(name, collectSecretPlaceholders(rewritten))
  }

  // 6. Degradation accounting → README.
  const degraded = [...report.platformSubpaths].filter(s => !FULLY_SUPPORTED.has(s)).sort()
  const reviewDeps = [...report.otherNpm].sort()
  out['EJECT_NOTES.md'] = emitReadme({ name, degraded, reviewDeps, usesSecrets })

  return { files: out, degraded, reviewDeps, residual, warnings }
}

/** Secret placeholders (`{{NAME}}`) the app references, sorted. Mirrors the fill
 *  regex in the vendored secrets shim so the .env.example lists exactly the
 *  VITE_<NAME> vars the running app will look up. */
function collectSecretPlaceholders(files: Record<string, string>): string[] {
  const names = new Set<string>()
  const re = /\{\{([A-Z0-9_]+)\}\}/g
  for (const content of Object.values(files)) {
    for (const m of content.matchAll(re)) if (m[1]) names.add(m[1])
  }
  return [...names].sort()
}

/** Emit `.env.example` — the VITE_<NAME> vars the secrets shim fills into
 *  `{{NAME}}` placeholders. Header explains the client-exposure caveat; a
 *  commented example keeps the file self-documenting when no placeholder was
 *  found statically (e.g. a dynamically-built URL). */
function emitEnvExample(name: string, placeholders: string[]): string {
  const header = `# Environment for ${name} — values fill {{NAME}} placeholders in proxyFetch
# calls at runtime, read as VITE_<NAME> (see EJECT_NOTES.md).
# WARNING: VITE_* vars are bundled into the client build, so they are exposed to
# the browser. Fine for local/personal use; front real secrets with your own
# server before a public deploy. Copy this file to .env and fill in the values.
`
  const body = placeholders.length
    ? placeholders.map(p => `VITE_${p}=`).join('\n')
    : '# No {{NAME}} placeholders were detected in the source. Add any the app needs:\n# VITE_EXAMPLE_API_KEY='
  return `${header}\n${body}\n`
}

interface ReadmeInput {
  name: string
  degraded: string[]
  reviewDeps: string[]
  /** Whether the app uses the secrets shim (gates the secrets/.env guidance). */
  usesSecrets: boolean
}

/** Honest export README — how to run + exactly what changed vs mythwork.
 * No two-way-sync claims: this is a one-way escape hatch (design §2/§9). */
function emitReadme(input: ReadmeInput): string {
  const degradedBlock = input.degraded.length
    ? `## Features that changed off-platform

These used platform capabilities have no standard-web equivalent, so the export
degrades them to a single-user / no-op fallback (the app still builds and runs;
this behavior differs from mythwork). Wire your own replacement if you need them:

${input.degraded.map(d => `- \`${d}\``).join('\n')}
`
    : `## Features that changed off-platform

None — this app only used capabilities that eject cleanly (persistence, secrets,
UI). It behaves the same standalone.
`

  const depsBlock = input.reviewDeps.length
    ? `## Dependencies to verify

These npm packages were detected but aren't on the platform's pinned list — they
were added to \`package.json\` as \`latest\`; pin a version you trust:

${input.reviewDeps.map(d => `- \`${d}\``).join('\n')}
`
    : ''

  const secretsBlock = input.usesSecrets
    ? `- **Secrets** (\`proxyFetch\`) now calls \`fetch\` directly and fills \`{{NAME}}\`
  placeholders from **Vite env** (\`VITE_<NAME>\` in \`.env\`). WARNING: this exposes
  keys to the browser — fine for personal/local use; for a public deploy, front
  real secrets with your own server. Copy \`.env.example\` → \`.env\` and fill it.
- \`.env\` is git-ignored — keep your keys out of version control.
`
    : ''

  return `# ${input.name}

Your app, ejected from mythwork — a clean, standard Vite + React project that is
**yours**. It depends on nothing of mythwork's: the platform runtime is vendored
into \`src/_portable/\`.

## Run it

\`\`\`bash
pnpm install
pnpm dev      # http://localhost:5173
pnpm build    # static site → dist/
\`\`\`

## What's portable, and what changed

- **Persistence** (\`useVar\`/\`useMap\`) now uses **localStorage** in the browser
  instead of mythwork's per-project store. Data is per-browser, not synced across
  devices. Same API — no app-code changes.
${secretsBlock}${degradedBlock}${depsBlock}
## Scope

This is a **one-way escape hatch**: a snapshot you fully own. It does **not** sync
back to mythwork — edits here stay here. (Two-way sync is out of scope by design.)

*Generated by the mythwork P6 eject transform.*
`
}

export { rewriteImports } from './rewrite-imports.js'
export { vendorPortable, PORTABLE_MODULES, FULLY_SUPPORTED } from './portable-runtime.js'
export { emitToolchain } from './toolchain.js'
