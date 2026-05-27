/**
 * HTTP client for the publish worker. Three operations:
 *
 *   1. POST /publish/check          — bulk dedup-check, returns the
 *                                     hashes that need uploading.
 *   2. PUT  /publish/blob/{hash}    — upload one zlib-deflated object.
 *   3. POST /publish                — finalize; returns canonical +
 *                                     optional alias URL.
 *
 * Every request carries `Authorization: Bearer <jwt>` and `X-Scope:
 * publish:{shortName}:{rootTree}` (or `publish:_canonical:{rootTree}`
 * for canonical-only publishes; see spec Open Question #1).
 *
 * Retry policy: each blob PUT retries up to 3 times on network errors /
 * 5xx with exponential backoff (250ms, 500ms, 1s). Check + finalize are
 * one-shot — they're idempotent enough that the caller can re-run the
 * whole publish command on failure.
 *
 * Error mapping: surface human-friendly messages for 401/403/413/502/400
 * per the spec table. Anything else falls through as a generic error
 * with the status code so debugging isn't silently lost.
 */

import type { BuiltObject } from './build-objects.js'

const MAX_PARALLEL_UPLOADS = 6
const PUT_RETRY_DELAYS_MS = [250, 500, 1000]

export interface PublishClientOptions {
  /** Worker base URL — e.g. https://api.myth.work or https://api.llama.space. */
  apiUrl: string
  /** Session JWT from the auth handshake. */
  sessionToken: string
  /** Computed once per publish; sent on every request. */
  scope: string
  /** Optional progress callback for upload UI. */
  onProgress?: (event: ProgressEvent) => void
  /** Override the fetch implementation (tests). */
  fetch?: typeof fetch
}

export type ProgressEvent =
  | { kind: 'checked'; total: number; missing: number }
  | { kind: 'uploaded'; index: number; total: number; hash: string }
  | { kind: 'finalized' }

export interface FinalizeResult {
  /** Always present. 64-hex commit hash echoed by the worker. */
  commit: string
  /** Always present. 64-hex root tree hash. */
  tree: string
  /** Crockford-32 canonical subdomain (52 chars). */
  canonical: string
  /** Alias short-name if shortName was provided. null otherwise. */
  alias: string | null
}

/**
 * Wrapper that converts publish-worker HTTP errors into a typed surface
 * the CLI can format nicely.
 */
export class PublishError extends Error {
  constructor(
    public code:
      | 'session_expired'
      | 'name_taken'
      | 'too_large'
      | 'backend_down'
      | 'bad_bundle'
      | 'network'
      | 'unknown',
    message: string,
    public details?: { status?: number; hash?: string; shortName?: string },
  ) {
    super(message)
    this.name = 'PublishError'
  }
}

/**
 * Build the X-Scope header string. Per spec Open Q #1, the blob worker
 * requires non-empty scope segments; we use `_canonical` as the
 * shortName placeholder when the caller didn't request an alias.
 */
export function buildScope(rootTree: string, shortName: string | undefined): string {
  const sn = shortName && shortName.length > 0 ? shortName : '_canonical'
  return `publish:${sn}:${rootTree}`
}

// ===========================================================================
// Step 1: /publish/check
// ===========================================================================

/**
 * POST /publish/check with the full hash list. Worker writes refs for
 * any dedup-hit hashes server-side and returns the list of hashes that
 * still need uploading.
 */
export async function checkBlobs(
  hashes: string[],
  opts: PublishClientOptions,
): Promise<string[]> {
  const fetchImpl = opts.fetch ?? fetch
  const res = await fetchImpl(`${opts.apiUrl}/publish/check`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.sessionToken}`,
      'X-Scope': opts.scope,
    },
    body: JSON.stringify({ hashes }),
  })
  if (!res.ok) {
    throw await mapErrorResponse(res, { context: 'check' })
  }
  const body = (await res.json()) as { missing?: unknown }
  if (!Array.isArray(body.missing)) {
    throw new PublishError('unknown', 'malformed /publish/check response')
  }
  return body.missing.map(String)
}

// ===========================================================================
// Step 2: PUT /publish/blob/{hash} × N
// ===========================================================================

/**
 * Upload every missing object with bounded concurrency. Retries each
 * PUT up to 3 times on network/5xx; on the 4th failure of a single
 * blob, aborts the whole upload with a clear error.
 *
 * Progress is reported via opts.onProgress as each PUT completes.
 */
export async function uploadBlobs(
  toUpload: BuiltObject[],
  opts: PublishClientOptions,
): Promise<void> {
  const total = toUpload.length
  let nextIndex = 0
  let completed = 0
  let firstError: PublishError | null = null

  async function worker(): Promise<void> {
    while (true) {
      if (firstError) return
      const i = nextIndex++
      if (i >= total) return
      const obj = toUpload[i]!
      try {
        await putBlobWithRetry(obj, opts)
      } catch (err) {
        const pe = err instanceof PublishError ? err : new PublishError('unknown', String(err))
        if (!firstError) firstError = pe
        return
      }
      completed++
      opts.onProgress?.({
        kind: 'uploaded',
        index: completed,
        total,
        hash: obj.hash,
      })
    }
  }

  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(MAX_PARALLEL_UPLOADS, total); i++) {
    workers.push(worker())
  }
  await Promise.all(workers)
  if (firstError) throw firstError
}

async function putBlobWithRetry(obj: BuiltObject, opts: PublishClientOptions): Promise<void> {
  const fetchImpl = opts.fetch ?? fetch
  let lastErr: PublishError | null = null
  for (let attempt = 0; attempt <= PUT_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await sleep(PUT_RETRY_DELAYS_MS[attempt - 1]!)
    }
    let res: Response
    try {
      res = await fetchImpl(`${opts.apiUrl}/publish/blob/${obj.hash}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${opts.sessionToken}`,
          'X-Scope': opts.scope,
        },
        // Node's fetch accepts Uint8Array (or Buffer) directly; the DOM
        // BodyInit typing is narrower than Node's so we cast through.
        body: obj.deflated as unknown as BodyInit,
      })
    } catch (err) {
      lastErr = new PublishError('network', `network error uploading ${obj.hash}: ${String(err)}`, {
        hash: obj.hash,
      })
      continue
    }
    if (res.ok) return
    // 401 / 403 / 413 / 4xx aren't retryable.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      throw await mapErrorResponse(res, { context: 'put', hash: obj.hash })
    }
    // 5xx and 408/429 retry.
    lastErr = await mapErrorResponse(res, { context: 'put', hash: obj.hash })
  }
  throw lastErr ?? new PublishError('unknown', `upload failed: ${obj.hash}`)
}

// ===========================================================================
// Step 3: POST /publish
// ===========================================================================

/**
 * Finalize the publish. Worker fetches the commit object, parses its
 * tree, optionally writes the site/{shortName} KV alias, and returns
 * the canonical Crockford-32 subdomain (always) plus the alias name
 * (if shortName was sent).
 */
export async function finalizePublish(
  headCommit: string,
  shortName: string | undefined,
  opts: PublishClientOptions,
): Promise<FinalizeResult> {
  const fetchImpl = opts.fetch ?? fetch
  const body: Record<string, string> = { headCommit }
  if (shortName) body.shortName = shortName
  const res = await fetchImpl(`${opts.apiUrl}/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.sessionToken}`,
      'X-Scope': opts.scope,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw await mapErrorResponse(res, { context: 'publish', shortName })
  }
  const parsed = (await res.json()) as {
    commit?: unknown
    tree?: unknown
    canonical?: unknown
    alias?: unknown
  }
  if (
    typeof parsed.commit !== 'string' ||
    typeof parsed.tree !== 'string' ||
    typeof parsed.canonical !== 'string'
  ) {
    throw new PublishError('unknown', 'malformed /publish response')
  }
  return {
    commit: parsed.commit,
    tree: parsed.tree,
    canonical: parsed.canonical,
    alias: typeof parsed.alias === 'string' ? parsed.alias : null,
  }
}

// ===========================================================================
// Error mapping
// ===========================================================================

/**
 * Map a non-2xx worker response onto a PublishError. We read the body
 * once for the error message but don't fail on bad JSON — the status
 * code is the primary signal.
 */
export async function mapErrorResponse(
  res: Response,
  ctx: { context: 'check' | 'put' | 'publish'; hash?: string; shortName?: string },
): Promise<PublishError> {
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

  if (status === 401) {
    return new PublishError(
      'session_expired',
      'Session expired. Re-run `myth publish`.',
      { status, hash: ctx.hash, shortName: ctx.shortName },
    )
  }
  if (status === 403) {
    return new PublishError(
      'name_taken',
      ctx.shortName
        ? `The name '${ctx.shortName}' belongs to another user. Pick a different --name.`
        : 'Forbidden by publish worker.',
      { status, shortName: ctx.shortName },
    )
  }
  if (status === 413) {
    return new PublishError(
      'too_large',
      `File ${ctx.hash ?? '(unknown)'} exceeds the 50 MB upload cap. Split or omit it.`,
      { status, hash: ctx.hash },
    )
  }
  if (status === 502 || status === 503 || status === 504) {
    return new PublishError(
      'backend_down',
      'Backend is having issues. Try again in a minute.',
      { status, hash: ctx.hash, shortName: ctx.shortName },
    )
  }
  if (status === 400) {
    return new PublishError(
      'bad_bundle',
      serverMsg
        ? `Internal error: ${serverMsg}. Please file an issue with --debug output.`
        : 'Internal error: malformed upload. Please file an issue with --debug output.',
      { status, hash: ctx.hash, shortName: ctx.shortName },
    )
  }
  return new PublishError(
    'unknown',
    `publish worker returned ${status}${serverMsg ? `: ${serverMsg}` : ''}`,
    { status, hash: ctx.hash, shortName: ctx.shortName },
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
