// Ported from mythwork/shared/eject/portable-runtime.ts @ 6551446 (PR #655). See
// ./README.md for provenance + convergence.
/**
 * Vendored portable runtime for the P6 eject transform.
 *
 * `rewrite-imports` maps every platform specifier (`@mythwork/<sub>` /
 * `@orbitcode/<sub>`) to `@portable/<sub>`, aliased by the emitted vite/tsconfig
 * to `src/_portable/<sub>`. This module holds the STANDALONE re-implementations
 * of that surface — standard-web backends, same public API — emitted verbatim
 * into the export so the ejected app depends on nothing of ours (true no-lock-in;
 * design §6, "vendor the shim source").
 *
 * Scope (Tier-1, this slice): `store` (localStorage-backed persistence),
 * `secrets` (proxyFetch→fetch + import.meta.env), and `react`/`project` (project
 * context becomes a local no-op). Platform features with no standard-web
 * equivalent — collab, auth, AI, file, git — get honest stubs that keep the app
 * BUILDING and RUNNING single-user, and `eject()` surfaces them as warnings so
 * the export README documents exactly what changed. Full shims for those are the
 * scoped fast-follow.
 *
 * These strings are app source (compiled by the USER's vite/tsc, not ours) — so
 * they are stored as data here, never type-checked in this repo.
 */

/** Persistence — @mythwork/store: useVar/useMap over localStorage (reactive). */
const STORE = `// Portable @mythwork/store — localStorage-backed, standalone (P6 eject).
// Same API as the platform hook; per-origin instead of per-project host RPC.
import { useCallback, useSyncExternalStore } from 'react'

const listeners = new Map()
function subscribe(key, cb) {
  let set = listeners.get(key)
  if (!set) { set = new Set(); listeners.set(key, set) }
  set.add(cb)
  const onStorage = (e) => { if (e.key === key) cb() }
  window.addEventListener('storage', onStorage)
  return () => { set.delete(cb); window.removeEventListener('storage', onStorage) }
}
function emit(key) { const s = listeners.get(key); if (s) for (const cb of s) cb() }

// Cache snapshots by raw string so useSyncExternalStore gets a STABLE reference
// until the stored value actually changes (else it re-renders forever).
const snap = new Map()
function read(key, dflt) {
  let raw = null
  try { raw = localStorage.getItem(key) } catch {}
  const cached = snap.get(key)
  if (cached && cached.raw === raw) return cached.val
  let val
  try { val = raw == null ? dflt : JSON.parse(raw) } catch { val = dflt }
  snap.set(key, { raw, val })
  return val
}
function write(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)) } catch {}
  emit(key)
}

export function useVar(key, defaultValue) {
  const value = useSyncExternalStore(
    (cb) => subscribe(key, cb),
    () => read(key, defaultValue),
    () => defaultValue,
  )
  const setValue = useCallback((next) => {
    const prev = read(key, defaultValue)
    write(key, typeof next === 'function' ? next(prev) : next)
  }, [key])
  return [value, setValue, false]
}

const EMPTY = Object.freeze({})
export function useMap(name) {
  const entries = useSyncExternalStore(
    (cb) => subscribe(name, cb),
    () => read(name, EMPTY),
    () => EMPTY,
  )
  const set = useCallback(async (k, v) => {
    write(name, { ...read(name, EMPTY), [k]: v })
  }, [name])
  const remove = useCallback(async (k) => {
    const cur = { ...read(name, EMPTY) }
    delete cur[k]
    write(name, cur)
  }, [name])
  return [entries, { set, remove }, false]
}
`

/** External data — @mythwork/secrets: proxyFetch→fetch, keys from import.meta.env. */
const SECRETS = `// Portable @mythwork/secrets — standalone (P6 eject).
// proxyFetch becomes a direct fetch; the server-side secret proxy is gone, so
// {{NAME}} placeholders are filled from Vite env (VITE_<NAME>) at the client.
// NOTE: this exposes keys to the browser — fine for personal/local use; for a
// public deploy, front real secrets with your own server. (README documents this.)
function fill(str) {
  return String(str).replace(/\\{\\{([A-Z0-9_]+)\\}\\}/g, (_, name) => {
    const v = import.meta.env['VITE_' + name]
    return v == null ? '' : String(v)
  })
}
export async function proxyFetch(url, options) {
  const u = fill(url)
  const opts = { ...(options || {}) }
  if (opts.headers) {
    const h = {}
    for (const [k, val] of Object.entries(opts.headers)) h[k] = fill(val)
    opts.headers = h
  }
  return fetch(u, opts)
}
export function useHasSecret(name) {
  const has = import.meta.env['VITE_' + name] != null
  return { hasSecret: has, loading: false }
}
`

/** Project context — @mythwork/react / @mythwork/project: local no-op off-platform. */
const PROJECT_REACT = `// Portable @mythwork/react — standalone (P6 eject).
// Off-platform there is no host project; ProjectProvider is a passthrough and the
// project hooks report a local, ready single project so store hooks resolve.
export function ProjectProvider({ children }) { return children }
export function useProject() { return { projectId: 'local', loading: false } }
export function useProjectStatus() { return { ready: true, loading: false } }
`

/** Honest single-user / no-op stubs for platform features with no standalone
 * equivalent. They keep the app compiling and running; behavior is documented as
 * degraded in the export README. `warn` fires once so it's visible, not silent. */
function stub(subpath: string, body: string): string {
  return `// Portable @mythwork/${subpath} — standalone stub (P6 eject).
// This platform feature has no standard-web equivalent off mythwork; the export
// degrades to single-user/no-op. See README "What changed". Full shim = fast-follow.
let warned = false
function warn() { if (!warned) { warned = true; try { console.warn('[portable] ${subpath}: degraded off-platform (single-user/no-op).') } catch {} } }
${body}
`
}

/**
 * Vendored module source keyed by platform subpath. Subpaths without a full shim
 * fall back to a generic no-op via `vendorPortable`; ones listed here export the
 * real names app code imports so the export still builds.
 */
export const PORTABLE_MODULES: Record<string, string> = {
  store: STORE,
  secrets: SECRETS,
  react: PROJECT_REACT,
  project: PROJECT_REACT,
  'project/react': PROJECT_REACT,
  auth: stub('auth', 'export function useUser() { warn(); return { user: null, loading: false } }'),
  'auth/react': stub(
    'auth/react',
    'export function useUser() { warn(); return { user: null, loading: false } }',
  ),
  collab: stub(
    'collab',
    'export function useCollabRoom() { warn(); return null }\nexport function useRoomList() { warn(); return [] }',
  ),
  'collab/react': stub(
    'collab/react',
    'export function useCollabRoom() { warn(); return null }\nexport function useRoomList() { warn(); return [] }',
  ),
  'sdk/react': stub(
    'sdk/react',
    'export function useCompletion() { warn(); return { complete: async () => "", text: "", isStreaming: false, error: new Error("AI unavailable off-platform — wire your own provider"), stop() {} } }',
  ),
}

/** Platform subpaths that eject fully to a standard-web equivalent (Tier-1 core). */
export const FULLY_SUPPORTED: ReadonlySet<string> = new Set([
  'store',
  'secrets',
  'react',
  'project',
  'project/react',
])

/** Fallback for a used subpath with no explicit shim. Provides a DEFAULT export
 * (so `import X from '@portable/<sub>'` resolves). A NAMED import from such a
 * subpath (`import { useX } from …`) can't be satisfied statically and would fail
 * the build — so `eject()` lists every unshimmed subpath in `degraded` and the
 * export README flags it for a manual shim. Surfaced, not silent. */
function genericStub(subpath: string): string {
  return stub(
    subpath,
    'const handler = { get: () => () => { warn(); return undefined } }\nexport default new Proxy({}, handler)',
  )
}

/**
 * Given the platform subpaths an app actually imports (from the rewrite report),
 * return the `src/_portable/<sub>.ts` files to vendor into the export.
 */
export function vendorPortable(subpaths: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const sub of subpaths) {
    const src = PORTABLE_MODULES[sub] ?? genericStub(sub)
    out[`src/_portable/${sub}.ts`] = src
  }
  return out
}
