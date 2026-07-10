/**
 * Pack-download path for `myth pull` — the read-direction sibling of
 * `pack-upload.ts`.
 *
 * GET /publish/pack/{rootTree} returns every object (tree + blob, not the
 * commit) reachable from that tree as a single OCPK pack — the SAME wire
 * format `POST /publish/pack` already uses for uploads. This file owns the
 * network call and the OCPK decode; it does not inflate/parse individual
 * objects — that's `read-objects.ts`'s job, kept offline and reusable.
 *
 * Error mapping mirrors `mapErrorResponse` in client.ts:
 *   401 → session_expired   (no retry — caller re-runs `myth pull`)
 *   403 → not_owner         (caller doesn't own a ref to this tree)
 *   404 → not_found         (rare race: tree GC'd between resolve and fetch)
 *   413 → too_large         (tree exceeds the single-response pack budget;
 *                            no pagination in v1 — the message says so
 *                            explicitly so it doesn't read as transient)
 *   5xx → backend_down
 * A structurally malformed pack body (bad magic, truncated varint, etc.)
 * is wrapped as PublishError('corrupt_pack', ...) regardless of status —
 * the server sent 200 but the bytes don't parse.
 */

import { decodePack, PackDecodeError } from './pack-codec.js'
import { PublishError } from './client.js'

/** Entry-count cap on a downloaded pack — matches the same defense-in-depth
 *  spirit as decodePack's own opts, just with a much higher ceiling than a
 *  single publish's upload packs (PACK_MAX_ENTRIES=500 in pack-upload.ts) —
 *  a pull fetches an app's ENTIRE object graph in one shot, not one upload
 *  batch. */
export const DEFAULT_MAX_PACK_ENTRIES = 200_000

/** Byte-size cap on a downloaded pack (deflated, as received). */
export const DEFAULT_MAX_PACK_BYTES = 512 * 1024 * 1024

export interface FetchObjectPackOptions {
  /** Worker base URL — e.g. https://api.myth.work or https://api.llama.space. */
  apiUrl: string
  /** Session JWT from the auth handshake. */
  sessionToken: string
  /** Override the fetch implementation (tests). */
  fetch?: typeof fetch
  /** Override the entry-count cap (tests). */
  maxEntries?: number
  /** Override the byte-size cap (tests). */
  maxBytes?: number
}

/**
 * GET /publish/pack/{rootTree}. Returns the pack decoded into an array of
 * opaque deflated entries — NOT yet hash-indexed; `indexPackObjects` in
 * read-objects.ts derives each entry's hash by inflating it.
 */
export async function fetchObjectPack(
  rootTree: string,
  opts: FetchObjectPackOptions,
): Promise<Uint8Array[]> {
  const fetchImpl = opts.fetch ?? fetch
  const res = await fetchImpl(`${opts.apiUrl}/publish/pack/${rootTree}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${opts.sessionToken}`,
    },
  })
  if (!res.ok) {
    throw await mapFetchPackErrorResponse(res, rootTree)
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  try {
    return decodePack(buf, {
      maxEntries: opts.maxEntries ?? DEFAULT_MAX_PACK_ENTRIES,
      maxBytes: opts.maxBytes ?? DEFAULT_MAX_PACK_BYTES,
    })
  } catch (e) {
    if (e instanceof PackDecodeError) {
      throw new PublishError('corrupt_pack', `Server sent a malformed object pack: ${e.message}`)
    }
    throw e
  }
}

async function mapFetchPackErrorResponse(res: Response, rootTree: string): Promise<PublishError> {
  const status = res.status
  let serverMsg: string | undefined
  try {
    const text = await res.text()
    if (text) {
      try {
        const j = JSON.parse(text) as { error?: unknown }
        if (typeof j.error === 'string') serverMsg = j.error
      } catch {
        serverMsg = text
      }
    }
  } catch {
    // best-effort
  }

  const treeShort = rootTree.slice(0, 12)

  if (status === 401) {
    return new PublishError('session_expired', 'Session expired while fetching your app. Re-run `myth pull`.', {
      status,
    })
  }
  if (status === 403) {
    return new PublishError('not_owner', 'You are not the publisher of this app.', { status })
  }
  if (status === 404) {
    return new PublishError('not_found', `No object graph found for tree ${treeShort}…`, { status })
  }
  if (status === 413) {
    return new PublishError(
      'too_large',
      `This app's published tree (${treeShort}…) is too large to pull in one request.`,
      { status },
    )
  }
  if (status === 502 || status === 503 || status === 504) {
    return new PublishError('backend_down', 'Backend is having issues. Try again in a minute.', { status })
  }
  return new PublishError('unknown', `publish worker returned ${status}${serverMsg ? `: ${serverMsg}` : ''}`, {
    status,
  })
}
