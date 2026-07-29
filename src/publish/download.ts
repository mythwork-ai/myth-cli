/**
 * Shared front half of `myth pull` / `myth eject`: resolve the backend, sign
 * in, resolve the published alias to its live root tree, fetch that tree's
 * object pack, and index it into a hash -> object map. Both commands diverge
 * only AFTER this — `pull` writes the tree to disk verbatim; `eject` transforms
 * it in memory first. Kept in one place so their auth/resolve/fetch behavior
 * (and the `[myth]` progress lines the user sees) can never drift apart.
 *
 * No disk writes happen here — a caller that fails partway (bad name, not the
 * owner, network error) never leaves anything behind.
 */

import { acquireSessionToken, resolveBackend } from './index.js'
import { resolvePublishedSite, type ResolveSiteResult } from './client.js'
import { fetchObjectPack } from './pack-download.js'
import { indexPackObjects, type IndexedObject } from './read-objects.js'

export interface DownloadOptions {
  /** The published alias to fetch, e.g. "my-app" for my-app.myth.work. */
  name: string
  /** When true, target api.llama.space (staging). Default: api.myth.work (prod). */
  staging?: boolean
  /** Override the worker base URL (escape hatch for local dev). */
  apiUrl?: string
  /** Override the auth origin (escape hatch / for local dev). */
  authOrigin?: string
  /** Override fetch (for tests). */
  fetch?: typeof fetch
}

export interface DownloadResult {
  /** The resolved live site: head commit, root tree, canonical subdomain. */
  site: ResolveSiteResult
  /** hash -> {type, body} for every object reachable from the root tree. */
  objects: Map<string, IndexedObject>
}

/**
 * Resolve + authenticate + fetch + index — everything up to (but not
 * including) materializing to disk. Throws `PublishError` (name not found, not
 * the owner, session expired, network) or `ReconstructError` (a corrupt pack)
 * on failure; the command dispatcher maps those to exit codes.
 */
export async function downloadObjectGraph(opts: DownloadOptions): Promise<DownloadResult> {
  const { apiUrl, authOrigin } = resolveBackend(opts)
  console.log(`[myth] Backend: ${apiUrl}`)

  const session = await acquireSessionToken(authOrigin)
  console.log(`[myth] ✓ Signed in as ${session.who}`)

  console.log(`[myth] Resolving '${opts.name}'...`)
  const site = await resolvePublishedSite(opts.name, {
    apiUrl,
    sessionToken: session.token,
    fetch: opts.fetch,
  })

  console.log(`[myth] Fetching object graph (tree ${site.rootTree.slice(0, 12)}…)...`)
  const packEntries = await fetchObjectPack(site.rootTree, {
    apiUrl,
    sessionToken: session.token,
    fetch: opts.fetch,
  })
  const objects = indexPackObjects(packEntries)

  return { site, objects }
}
