/**
 * Pre-flight validation for Tier-1 source publish. The edge compiler resolves
 * react-family / @orbitcode natively and routes other bare specifiers through
 * an esm.sh importmap (generated edge-side from package.json). We validate up
 * front so failures are actionable here, not a 422 at serve time.
 */

const NATIVE_PREFIXES = ['@orbitcode/']
const NATIVE_EXACT = new Set(['react', 'react-dom', 'react-dom/client'])

/**
 * Packages that cannot work over esm.sh in a browser (native bindings,
 * build-time tooling, etc.). Conservative; extend over time.
 */
const PROBLEMATIC = new Set([
  'sharp',
  'fsevents',
  'esbuild',
  'canvas',
  'better-sqlite3',
  'node-gyp',
])

export interface DepClassification {
  /** Resolved by the edge runtime without esm.sh. */
  native: string[]
  /** Routed through the edge-generated esm.sh importmap. */
  viaEsm: string[]
  /** Cannot be served at the edge — publish should be blocked. */
  problematic: string[]
}

export function classifyDependencies(deps: Record<string, string>): DepClassification {
  const native: string[] = []
  const viaEsm: string[] = []
  const problematic: string[] = []
  for (const name of Object.keys(deps).sort()) {
    if (NATIVE_EXACT.has(name) || NATIVE_PREFIXES.some(p => name.startsWith(p))) {
      native.push(name)
    } else if (PROBLEMATIC.has(name)) {
      problematic.push(name)
    } else {
      viaEsm.push(name)
    }
  }
  return { native, viaEsm, problematic }
}

export interface ValidateInput {
  /** POSIX relative paths in the upload set. */
  files: string[]
  /** package.json dependencies map. */
  deps: Record<string, string>
}

/**
 * Return a list of human-readable, actionable errors. Empty array = OK to
 * publish. Each error explains the problem and how to fix it.
 */
export function validateSource(input: ValidateInput): string[] {
  const errors: string[] = []

  // CSS-first Tailwind only — reject legacy JS config / JS plugins (they would
  // require executing user code at the edge; unsupported by the Tier-1 path).
  for (const f of input.files) {
    if (/(^|\/)tailwind\.config\.(js|cjs|mjs|ts)$/.test(f)) {
      errors.push(
        `Found ${f}: server-side Tailwind requires CSS-first config ` +
          `(@import "tailwindcss" + @theme), not a JS config. ` +
          `Remove it or move its theme into CSS.`,
      )
    }
  }

  const { problematic } = classifyDependencies(input.deps)
  for (const p of problematic) {
    errors.push(
      `Dependency "${p}" cannot be served at the edge (native/build-time package). ` +
        `Remove it or replace with a browser-compatible alternative.`,
    )
  }

  return errors
}
