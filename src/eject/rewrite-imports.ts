// Ported from mythwork/shared/eject/rewrite-imports.ts @ 579ec13 (base of PR
// #655). See ./README.md for provenance + convergence.
/**
 * Import-rewrite codemod — the deterministic heart of the eject transform.
 *
 * Rewrites platform (`@mythwork/*` / `@orbitcode/*`) import specifiers in an
 * app source file to the vendored portable runtime (`@portable/*`, aliased to
 * `src/_portable/*` by the emitted vite/tsconfig), and reports:
 *   - which platform subpaths were used (→ the portable modules to vendor),
 *   - which npm packages to declare in the emitted package.json,
 *   - the portability audit (any platform specifier left un-rewritten — must be
 *     empty; this is the eval-gate's "0 residual specifiers" check).
 *
 * Specifier positions handled: `... from '<s>'`, side-effect `import '<s>'`,
 * dynamic `import('<s>')`, and `require('<s>')`. Rewriting is idempotent — a
 * `@portable/*` target is not a platform org, so re-running is a no-op.
 */

import { classifySpecifier } from './platform-specifiers.js'

export interface RewriteReport {
  /** Platform subpaths used anywhere in the app (→ vendor these portable modules). */
  platformSubpaths: Set<string>
  /** npm packages to declare in the emitted package.json (blessed + other + react). */
  npmDeps: Set<string>
  /** Non-blessed bare npm specifiers — kept, but surfaced for review. */
  otherNpm: Set<string>
}

export function emptyReport(): RewriteReport {
  return { platformSubpaths: new Set(), npmDeps: new Set(), otherNpm: new Set() }
}

const SPEC_PATTERNS: RegExp[] = [
  /\bfrom\s+(['"])([^'"\n]+)\1/g, // import x from '...'; export x from '...'
  /\bimport\s+(['"])([^'"\n]+)\1/g, // side-effect: import '...'
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1/g, // dynamic: import('...')
  /\brequire\s*\(\s*(['"])([^'"\n]+)\1/g, // require('...')
]

/** Classify a specifier, fold it into the report, and return its rewrite. */
function handleSpecifier(specifier: string, report: RewriteReport): string {
  const cls = classifySpecifier(specifier)
  switch (cls.kind) {
    case 'platform':
      report.platformSubpaths.add(cls.subpath)
      return cls.portable
    case 'blessed-npm':
      report.npmDeps.add(cls.pkg)
      return specifier
    case 'react':
      report.npmDeps.add('react')
      report.npmDeps.add('react-dom')
      return specifier
    case 'other-npm':
      report.npmDeps.add(cls.pkg)
      report.otherNpm.add(cls.pkg)
      return specifier
    default: // relative
      return specifier
  }
}

/**
 * Rewrite one file's platform imports to `@portable/*`, folding usage into
 * `report`. Returns the rewritten source.
 */
export function rewriteFileImports(content: string, report: RewriteReport): string {
  let out = content
  for (const pattern of SPEC_PATTERNS) {
    out = out.replace(pattern, match => {
      // The quoted specifier is the last quoted run in the match; rewrite it
      // in place so the surrounding syntax (quotes, `from`, parens) is intact.
      const q = match.match(/(['"])([^'"\n]+)\1/)
      if (!q) return match
      const [quoted, quote, spec] = q
      const rewritten = handleSpecifier(spec ?? '', report)
      return rewritten === spec ? match : match.replace(quoted, `${quote}${rewritten}${quote}`)
    })
  }
  return out
}

/**
 * Portability audit: any residual platform specifier left in `content` after a
 * rewrite. Must be empty for an export to be "clean" (the eval-gate check).
 */
export function auditResidualPlatform(content: string): string[] {
  const found = new Set<string>()
  const re = /(['"])(@(?:mythwork|orbitcode)\/[^'"\n]+)\1/g
  for (const m of content.matchAll(re)) {
    if (m[2]) found.add(m[2])
  }
  return [...found]
}

export interface EjectFilesResult {
  files: Record<string, string>
  report: RewriteReport
  /** Files → residual platform specifiers (portability audit). Empty = clean. */
  residual: Record<string, string[]>
}

/** Rewrite an entire file map; only .ts/.tsx/.js/.jsx are transformed. */
export function rewriteImports(files: Record<string, string>): EjectFilesResult {
  const report = emptyReport()
  const out: Record<string, string> = {}
  const residual: Record<string, string[]> = {}
  for (const [path, content] of Object.entries(files)) {
    if (/\.(tsx?|jsx?|mjs|cjs)$/.test(path)) {
      const rewritten = rewriteFileImports(content, report)
      out[path] = rewritten
      const left = auditResidualPlatform(rewritten)
      if (left.length > 0) residual[path] = left
    } else {
      out[path] = content
    }
  }
  return { files: out, report, residual }
}
