// Ported from mythwork/shared/eject/platform-specifiers.ts @ 579ec13 (base of PR
// #655). See ./README.md for provenance + convergence. Mirror of the platform's
// orbit-runtime-bundles manifest/blessed lists — keep in sync when those change.
/**
 * Platform-specifier inventory + classifier for the P6 eject transform.
 *
 * An exported app imports three kinds of specifier:
 *   1. PLATFORM runtime (`@mythwork/*` / legacy `@orbitcode/*`) — host-frame
 *      coupled, bundled from workspace source, NOT on npm. This is the lock-in:
 *      the eject transform rewrites these to the vendored portable runtime
 *      (`@portable/*` → `src/_portable/*`), so the export depends on nothing of
 *      ours. Source of truth: orbit-runtime-bundles `manifest.ts` ENTRY_SUBPATHS
 *      + `@mythwork/store` + `@mythwork/secrets`.
 *   2. BLESSED npm packages — real packages resolved via esm.sh in-platform;
 *      off-platform they are ordinary npm deps (kept as-is, added to
 *      package.json). Source of truth: orbit-runtime-bundles `blessed.ts`.
 *   3. Everything else — relative imports (kept), react/react-dom (deps), and
 *      any other bare npm specifier (kept + added to deps, flagged for review).
 *
 * The classifier is NAMESPACE-AGNOSTIC: the orbitcode→mythwork rename (#635) is
 * partial, so published app source may carry either org prefix. We match on the
 * SUBPATH after the org and normalize both to the same portable target.
 */

/** Org prefixes a platform specifier may use (rename #635 is partial). */
const PLATFORM_ORGS = ['@mythwork', '@orbitcode'] as const

/**
 * Platform runtime subpaths (the part after `@org/`). Kept in one place; adding
 * a new blessed platform entry to `manifest.ts` means adding it here too (the
 * eject transform is only correct if this mirrors the manifest).
 */
export const PLATFORM_SUBPATHS: readonly string[] = [
  'project',
  'project/react',
  'project/react/internal',
  'react',
  'collab',
  'collab/react',
  'file',
  'file/react',
  'git',
  'git/react',
  'auth',
  'auth/react',
  'shim-transport',
  'sdk',
  'sdk/react',
  'store',
  'secrets',
]

/** Blessed npm packages (from blessed.ts) — ordinary npm deps off-platform. */
export const BLESSED_NPM: readonly string[] = [
  'yjs',
  'lib0',
  'y-protocols',
  'y-codemirror.next',
  'react-router-dom',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/commands',
  '@codemirror/lang-javascript',
  '@isomorphic-git/lightning-fs',
]

const PLATFORM_SUBPATH_SET = new Set(PLATFORM_SUBPATHS)

export type SpecifierClass =
  | { kind: 'platform'; subpath: string; portable: string }
  | { kind: 'blessed-npm'; pkg: string }
  | { kind: 'react' }
  | { kind: 'relative' }
  | { kind: 'other-npm'; pkg: string }

/** Split a bare specifier into its top-level package name and subpath. */
function splitBare(specifier: string): { pkg: string; subpath: string } {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    const pkg = parts.slice(0, 2).join('/')
    return { pkg, subpath: parts.slice(2).join('/') }
  }
  return { pkg: parts[0] ?? specifier, subpath: parts.slice(1).join('/') }
}

/**
 * Match a platform specifier regardless of org prefix. `@mythwork/project/react`
 * and `@orbitcode/project/react` both → subpath `project/react`.
 */
export function matchPlatformSubpath(specifier: string): string | null {
  for (const org of PLATFORM_ORGS) {
    if (specifier === org) return null
    if (specifier.startsWith(`${org}/`)) {
      const subpath = specifier.slice(org.length + 1)
      return PLATFORM_SUBPATH_SET.has(subpath) ? subpath : null
    }
  }
  return null
}

/** The vendored portable target a platform subpath rewrites to. */
export function portableTarget(subpath: string): string {
  return `@portable/${subpath}`
}

/** Classify one import specifier for the eject transform. */
export function classifySpecifier(specifier: string): SpecifierClass {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return { kind: 'relative' }
  }
  const subpath = matchPlatformSubpath(specifier)
  if (subpath) {
    return { kind: 'platform', subpath, portable: portableTarget(subpath) }
  }
  const { pkg } = splitBare(specifier)
  if (pkg === 'react' || pkg === 'react-dom') return { kind: 'react' }
  if (BLESSED_NPM.includes(pkg)) return { kind: 'blessed-npm', pkg }
  return { kind: 'other-npm', pkg }
}
