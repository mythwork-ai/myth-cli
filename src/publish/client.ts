/**
 * HTTP client for the publish worker. Three operations:
 *
 *   1. POST /publish/check          — bulk dedup-check, returns the
 *                                     hashes that need uploading.
 *   2. PUT  /publish/blob/{hash}    — upload one zlib-deflated object.
 *   3. POST /publish                — finalize; returns canonical +
 *                                     optional alias URL.
 *
 * Every request carries `Authorization: Bearer <jwt>`. The blob "scope"
 * (GC-ownership key) is NOT client-supplied — the worker derives it
 * server-side from the authenticated user (`publish:{userId}:{shortName||
 * _canonical}:{rootTree}`), so a caller can only ever own its own scope.
 * We just send the inputs the worker needs: the content address
 * (`rootTree`) and the optional alias `shortName`. /check carries them in
 * the JSON body; each blob PUT carries them as `X-Root-Tree` /
 * `X-Short-Name` headers; /publish derives the tree from the commit.
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

// 16-way: each PUT is an independent worker invocation server-side, so the
// practical bound is client sockets, not the platform. 6 left ~2.6x upload
// wall-clock on the table for a typical ~140-object publish.
export const MAX_PARALLEL_UPLOADS = 16
const PUT_RETRY_DELAYS_MS = [250, 500, 1000]

export interface PublishClientOptions {
  /** Worker base URL — e.g. https://api.myth.work or https://api.llama.space. */
  apiUrl: string
  /** Session JWT from the auth handshake. */
  sessionToken: string
  /**
   * Root tree hash (64 lowercase hex). Sent on /check and every blob PUT
   * so the worker can derive the GC scope server-side. Computed once per
   * publish.
   */
  rootTree: string
  /**
   * Optional alias short-name (becomes `{name}.{zone}`). Sent alongside
   * `rootTree` so the worker derives a per-name scope; omitted entirely
   * for canonical-only publishes (the worker uses `_canonical`).
   */
  shortName?: string
  /**
   * Set this publish as the zone's apex default app (the reserved `~apex`
   * pointer; https://{zone}/). Owner-gated server-side: the session's
   * userId must equal the deployed APEX_OWNER_USER_ID or /publish 403s.
   */
  apex?: boolean
  /**
   * Canonical project id from myth.config.json. Sent on finalize so the
   * worker keys the published app to its project (explore discovery,
   * app-index events) and verifies ownership against the caller's D1
   * `project_members` role — a write role passes, anything else 403s.
   */
  projectId?: string
  /** Optional progress callback for upload UI. */
  onProgress?: (event: ProgressEvent) => void
  /** Override the fetch implementation (tests). */
  fetch?: typeof fetch
}

export type ProgressEvent =
  | { kind: 'checked'; total: number; missing: number }
  | { kind: 'uploaded'; index: number; total: number; hash: string }
  // Byte-level upload progress. Emitted as the request body is flushed to the
  // socket so the bar fills smoothly even when the whole publish is one pack
  // POST. `sent`/`total` are deflated wire bytes; `sent` is clamped to `total`.
  | { kind: 'upload-bytes'; sent: number; total: number }
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
  /**
   * Server-measured finalize phase timings (platform ≥ publish-fastpath).
   * null when the backend predates the field.
   */
  timings: {
    walkMs: number
    scanMs: number
    compileMs: number
    totalMs: number
    scanCached: boolean
  } | null
  /** True when the worker also set this publish as the apex default. */
  apex: boolean
  /** Non-fatal advisories from the edge compile (e.g. host-version overrides). */
  warnings: string[]
  /**
   * True when the worker DEFERRED the alias cutover until the Tier-2 build
   * succeeds: the returned tree is not live yet, and a sustained `none`
   * build status right after publish just means the fire-and-forget status
   * write hasn't propagated. Additive — false when the backend predates
   * the field.
   */
  deferred: boolean
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
      | 'not_owner'
      | 'not_found'
      | 'too_large'
      | 'backend_down'
      | 'bad_bundle'
      | 'corrupt_pack'
      | 'network'
      | 'unknown',
    message: string,
    public details?: { status?: number; hash?: string; shortName?: string },
  ) {
    super(message)
    this.name = 'PublishError'
  }
}

// ===========================================================================
// Step 1: /publish/check
// ===========================================================================

/**
 * POST /publish/check with the full hash list. Worker writes refs for
 * any dedup-hit hashes server-side (under the scope it derives from
 * `rootTree` + `shortName` + the authenticated user) and returns the
 * list of hashes that still need uploading.
 */
export async function checkBlobs(
  hashes: string[],
  opts: PublishClientOptions,
): Promise<string[]> {
  const fetchImpl = opts.fetch ?? fetch
  const reqBody: { hashes: string[]; rootTree: string; shortName?: string } = {
    hashes,
    rootTree: opts.rootTree,
  }
  if (opts.shortName) reqBody.shortName = opts.shortName
  const res = await fetchImpl(`${opts.apiUrl}/publish/check`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.sessionToken}`,
    },
    body: JSON.stringify(reqBody),
  })
  if (!res.ok) {
    throw await mapErrorResponse(res, { context: 'check' })
  }
  const resBody = (await res.json()) as { missing?: unknown }
  if (!Array.isArray(resBody.missing)) {
    throw new PublishError('unknown', 'malformed /publish/check response')
  }
  return resBody.missing.map(String)
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
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      Authorization: `Bearer ${opts.sessionToken}`,
      'X-Root-Tree': opts.rootTree,
    }
    if (opts.shortName) headers['X-Short-Name'] = opts.shortName
    try {
      res = await fetchImpl(`${opts.apiUrl}/publish/blob/${obj.hash}`, {
        method: 'PUT',
        headers,
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
  opts: PublishClientOptions,
): Promise<FinalizeResult> {
  const fetchImpl = opts.fetch ?? fetch
  const body: Record<string, string | boolean> = { headCommit }
  if (opts.shortName) body.shortName = opts.shortName
  if (opts.apex) body.apex = true
  if (opts.projectId) body.projectId = opts.projectId
  const res = await fetchImpl(`${opts.apiUrl}/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.sessionToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw await mapErrorResponse(res, { context: 'publish', shortName: opts.shortName })
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
    apex: (parsed as { apex?: unknown }).apex === true,
    warnings: Array.isArray((parsed as { warnings?: unknown }).warnings)
      ? ((parsed as { warnings?: unknown }).warnings as unknown[]).filter(
          (w): w is string => typeof w === 'string',
        )
      : [],
    timings: parseTimings((parsed as { timings?: unknown }).timings),
    deferred: (parsed as { deferred?: unknown }).deferred === true,
  }
}

/** Validate the additive `timings` response field; null on absence/shape drift. */
function parseTimings(t: unknown): FinalizeResult['timings'] {
  if (t === null || typeof t !== 'object') return null
  const o = t as Record<string, unknown>
  if (
    typeof o.walkMs !== 'number' ||
    typeof o.scanMs !== 'number' ||
    typeof o.compileMs !== 'number' ||
    typeof o.totalMs !== 'number' ||
    typeof o.scanCached !== 'boolean'
  ) {
    return null
  }
  return {
    walkMs: o.walkMs,
    scanMs: o.scanMs,
    compileMs: o.compileMs,
    totalMs: o.totalMs,
    scanCached: o.scanCached,
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
  let serverCode: string | undefined
  try {
    const text = await res.text()
    if (text) {
      try {
        const j = JSON.parse(text) as { error?: unknown; code?: unknown; detail?: unknown }
        if (typeof j.error === 'string') serverMsg = j.error
        if (typeof j.code === 'string') serverCode = j.code
        // The worker attaches a structured `detail` on failures the top-level
        // `error` can't describe (e.g. a 422 "compile failed" whose detail is
        // the offending file + unresolved specifier). Surface it so the user
        // sees WHAT failed, not just that something did.
        if (j.detail != null) {
          const d = j.detail as { message?: unknown; path?: unknown; specifier?: unknown }
          const detailStr =
            typeof j.detail === 'string'
              ? j.detail
              : [
                  typeof d.message === 'string' ? d.message : undefined,
                  typeof d.path === 'string' ? `in ${d.path}` : undefined,
                  typeof d.specifier === 'string' ? `(${d.specifier})` : undefined,
                ]
                  .filter(Boolean)
                  .join(' ') || JSON.stringify(j.detail)
          serverMsg = serverMsg ? `${serverMsg} — ${detailStr}` : detailStr
        }
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
    // The worker 403s for two distinct reasons on /publish: an alias owned by
    // another user, or a projectId the session lacks a write role on. The
    // stable `code` field is the discriminator; the message substring is a
    // fallback for workers predating it.
    if (serverCode === 'project_ownership' || serverMsg?.includes('projectId')) {
      return new PublishError(
        'not_owner',
        'This project belongs to another user (projectId ownership check failed). ' +
          'Check the "projectId" in myth.config.json.',
        { status, shortName: ctx.shortName },
      )
    }
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

// ===========================================================================
// Unpublish: DELETE /publish/site/{name}
// ===========================================================================

export interface UnpublishClientOptions {
  /** Worker base URL — e.g. https://api.myth.work or https://api.llama.space. */
  apiUrl: string
  /** Session JWT from the auth handshake. */
  sessionToken: string
  /** Override the fetch implementation (tests). */
  fetch?: typeof fetch
}

/**
 * DELETE /publish/site/{name}. On success the alias is removed and its
 * objects are released for GC. Maps 404 → not_found, 403 → not_owner
 * (not the publisher), 401 → session_expired.
 */
export async function deletePublishedSite(
  name: string,
  opts: UnpublishClientOptions,
): Promise<void> {
  const fetchImpl = opts.fetch ?? fetch
  const res = await fetchImpl(`${opts.apiUrl}/publish/site/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${opts.sessionToken}`,
    },
  })
  if (res.ok) return
  throw await mapUnpublishErrorResponse(res, name)
}

/**
 * Map a non-2xx DELETE /publish/site/{name} response onto a PublishError.
 * Error taxonomy mirrors the publish worker spec:
 *   404 → not_found  (no app with that alias)
 *   403 → not_owner  (caller is not the publisher/owner)
 *   401 → session_expired
 *   400 → bad_bundle (invalid shortName)
 *   5xx → backend_down
 */
async function mapUnpublishErrorResponse(res: Response, name: string): Promise<PublishError> {
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
      `Session expired. Re-run \`myth unpublish --name ${name}\`.`,
      { status, shortName: name },
    )
  }
  if (status === 403) {
    return new PublishError(
      'not_owner',
      `You are not the publisher of '${name}'.`,
      { status, shortName: name },
    )
  }
  if (status === 404) {
    return new PublishError(
      'not_found',
      `No app named '${name}' found.`,
      { status, shortName: name },
    )
  }
  if (status === 400) {
    return new PublishError(
      'bad_bundle',
      serverMsg
        ? `Invalid name '${name}': ${serverMsg}`
        : `Invalid name '${name}'.`,
      { status, shortName: name },
    )
  }
  if (status === 502 || status === 503 || status === 504) {
    return new PublishError(
      'backend_down',
      'Backend is having issues. Try again in a minute.',
      { status, shortName: name },
    )
  }
  return new PublishError(
    'unknown',
    `publish worker returned ${status}${serverMsg ? `: ${serverMsg}` : ''}`,
    { status, shortName: name },
  )
}

// ===========================================================================
// Resolve: GET /publish/site/{name} (the `myth pull` read-side sibling of
// DELETE /publish/site/{name})
// ===========================================================================

export interface ResolveSiteResult {
  name: string
  /** 64-hex head commit hash for the currently-live tree. */
  headCommit: string
  /** 64-hex root tree hash — what `myth pull` actually fetches objects for. */
  rootTree: string
  /** Crockford-32 canonical subdomain. */
  canonical: string
  /** Canonical project id, when the backend reports one. */
  projectId?: string
}

export interface ResolveSiteOptions {
  /** Worker base URL — e.g. https://api.myth.work or https://api.llama.space. */
  apiUrl: string
  /** Session JWT from the auth handshake. */
  sessionToken: string
  /** Override the fetch implementation (tests). */
  fetch?: typeof fetch
}

/**
 * GET /publish/site/{name}. Resolves a published alias to the head commit
 * and root tree it's currently serving. Owner-gated, same as
 * `deletePublishedSite` — a caller can only resolve names they published.
 */
export async function resolvePublishedSite(
  name: string,
  opts: ResolveSiteOptions,
): Promise<ResolveSiteResult> {
  const fetchImpl = opts.fetch ?? fetch
  const res = await fetchImpl(`${opts.apiUrl}/publish/site/${encodeURIComponent(name)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${opts.sessionToken}`,
    },
  })
  if (!res.ok) {
    throw await mapResolveSiteErrorResponse(res, name)
  }
  const parsed = (await res.json()) as {
    headCommit?: unknown
    rootTree?: unknown
    canonical?: unknown
    projectId?: unknown
  }
  if (
    typeof parsed.headCommit !== 'string' ||
    typeof parsed.rootTree !== 'string' ||
    typeof parsed.canonical !== 'string'
  ) {
    throw new PublishError('unknown', 'malformed GET /publish/site response')
  }
  return {
    name,
    headCommit: parsed.headCommit,
    rootTree: parsed.rootTree,
    canonical: parsed.canonical,
    projectId: typeof parsed.projectId === 'string' ? parsed.projectId : undefined,
  }
}

/**
 * Map a non-2xx GET /publish/site/{name} response onto a PublishError.
 * Mirrors mapUnpublishErrorResponse's taxonomy (same underlying resource,
 * opposite HTTP verb): 404 → not_found, 403 → not_owner, 401 →
 * session_expired, 5xx → backend_down. No 400 case — there's no request
 * body here to be malformed.
 */
async function mapResolveSiteErrorResponse(res: Response, name: string): Promise<PublishError> {
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
    return new PublishError('session_expired', `Session expired. Re-run \`myth pull ${name}\`.`, {
      status,
      shortName: name,
    })
  }
  if (status === 403) {
    return new PublishError('not_owner', `You are not the publisher of '${name}'.`, { status, shortName: name })
  }
  if (status === 404) {
    return new PublishError('not_found', `No published app named '${name}'.`, { status, shortName: name })
  }
  if (status === 502 || status === 503 || status === 504) {
    return new PublishError('backend_down', 'Backend is having issues. Try again in a minute.', {
      status,
      shortName: name,
    })
  }
  return new PublishError(
    'unknown',
    `publish worker returned ${status}${serverMsg ? `: ${serverMsg}` : ''}`,
    { status, shortName: name },
  )
}

/**
 * GET /publish/eject/{name} — download the server-ejected standalone project as
 * a path-tagged OCPK pack. The eject transform runs SERVER-SIDE (shared/eject);
 * this is a thin client, so the CLI and the frontend button get byte-identical
 * output. Owner-gated identically to pull's pack download.
 */
export async function fetchEjectPack(name: string, opts: ResolveSiteOptions): Promise<Uint8Array> {
  const fetchImpl = opts.fetch ?? fetch
  const res = await fetchImpl(`${opts.apiUrl}/publish/eject/${encodeURIComponent(name)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${opts.sessionToken}`,
    },
  })
  if (!res.ok) {
    throw await mapEjectErrorResponse(res, name)
  }
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * Map a non-2xx GET /publish/eject/{name} response onto a PublishError. Mirrors
 * mapResolveSiteErrorResponse, plus the eject-specific 409 (can't be ejected —
 * e.g. a monorepo, or a residual-platform bug) and 413 (source too large).
 */
async function mapEjectErrorResponse(res: Response, name: string): Promise<PublishError> {
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
    return new PublishError('session_expired', `Session expired. Re-run \`myth eject ${name}\`.`, {
      status,
      shortName: name,
    })
  }
  if (status === 403) {
    return new PublishError('not_owner', `You are not the publisher of '${name}'.`, { status, shortName: name })
  }
  if (status === 404) {
    return new PublishError('not_found', `No published app named '${name}'.`, { status, shortName: name })
  }
  if (status === 409) {
    return new PublishError('bad_bundle', serverMsg ?? `'${name}' can't be ejected.`, { status, shortName: name })
  }
  if (status === 413) {
    return new PublishError('too_large', `'${name}' is too large to eject.`, { status, shortName: name })
  }
  if (status === 502 || status === 503 || status === 504) {
    return new PublishError('backend_down', 'Backend is having issues. Try again in a minute.', {
      status,
      shortName: name,
    })
  }
  return new PublishError(
    'unknown',
    `publish worker returned ${status}${serverMsg ? `: ${serverMsg}` : ''}`,
    { status, shortName: name },
  )
}

/**
 * Shared sleep helper (the single copy — client, pack-upload and the
 * build-status poller all use this one). Optionally abortable: when `signal`
 * aborts mid-sleep the timer is cleared (so it can't hold the event loop)
 * and the promise rejects with the signal's abort reason (an AbortError
 * DOMException by default).
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ===========================================================================
// Project resolution (AGE-114: GET /project/pool + POST /project/claim)
// ===========================================================================

export interface ProvisionOptions {
  apiUrl: string
  sessionToken: string
  /** Slugified app name (`slugifyLocalId(config.name)`). Used to rediscover an
   *  already-claimed owned project by its `{localId}`/`{localId}-xxxxxx`
   *  auto-alias, so repeat publishes converge on one project (no strays). */
  localId: string
  projectName: string
  fetch?: typeof fetch
}

interface ProjectRow {
  projectId: string
  alias: string
  role: string
}

/**
 * Resolve (or claim) the caller's canonical project for this app.
 *
 * The old single-call `POST /project/provision` (idempotent by (owner,
 * localId)) was removed by AGE-114 in favour of `GET /project/pool` (stateless
 * mint) + `POST /project/claim` (bind a minted id to its first owner). Claim is
 * idempotent by *projectId*, not by a free-form key, and a pool-minted id is
 * fresh random — so to avoid a new stray project on every publish we first
 * rediscover our own prior claim via `GET /projects`, matching the
 * `{localId}` / `{localId}-xxxxxx` auto-alias, before falling back to
 * pool+claim. This mirrors mythwork's own CI publisher (`resolveProject` in
 * `scripts/lib/ci-publish-lib.mjs`) and the host-iframe pool→claim path.
 *
 * Because claim binds to the CALLER, this can never hand back another user's
 * project — auto-resolve on a publish ownership 403 yields the user's OWN
 * project, it does not bypass the ownership gate. Returns the canonical
 * projectId.
 */
export async function provisionProject(opts: ProvisionOptions): Promise<string> {
  const fetchImpl = opts.fetch ?? fetch
  const auth = { Authorization: `Bearer ${opts.sessionToken}` }

  const listRes = await fetchImpl(`${opts.apiUrl}/projects`, { headers: auth })
  if (listRes.status === 401) {
    throw new PublishError('session_expired', 'Session expired during project resolution.', {
      status: listRes.status,
    })
  }
  if (listRes.ok) {
    const listed = (await listRes.json().catch(() => null)) as { projects?: ProjectRow[] } | null
    const owned = (listed?.projects ?? []).filter(
      (p) =>
        p.role === 'owner' &&
        (p.alias === opts.localId || p.alias.startsWith(`${opts.localId}-`)),
    )
    // Prefer an exact-alias match; else the first prefix match (deterministic
    // by list order) so repeat publishes reuse the same project.
    const match = owned.find((p) => p.alias === opts.localId) ?? owned[0]
    if (match) return match.projectId
  }

  const poolRes = await fetchImpl(`${opts.apiUrl}/project/pool?n=1`)
  if (!poolRes.ok) {
    const text = await poolRes.text().catch(() => '')
    throw new PublishError(
      'backend_down',
      `Project id mint failed (${poolRes.status})${text ? `: ${text.slice(0, 200)}` : ''}.`,
      { status: poolRes.status },
    )
  }
  const pool = (await poolRes.json().catch(() => null)) as { ids?: unknown } | null
  const mintedId = Array.isArray(pool?.ids) ? pool.ids[0] : undefined
  if (typeof mintedId !== 'string') {
    throw new PublishError('unknown', 'Project id mint returned no ids.')
  }

  const claimRes = await fetchImpl(`${opts.apiUrl}/project/claim`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: mintedId, projectName: opts.projectName }),
  })
  if (!claimRes.ok) {
    if (claimRes.status === 401) {
      throw new PublishError('session_expired', 'Session expired during project claim.', {
        status: claimRes.status,
      })
    }
    const text = await claimRes.text().catch(() => '')
    throw new PublishError(
      'backend_down',
      `Project claim failed (${claimRes.status})${text ? `: ${text.slice(0, 200)}` : ''}.`,
      { status: claimRes.status },
    )
  }
  const parsed = (await claimRes.json().catch(() => null)) as { projectId?: unknown } | null
  if (!parsed || typeof parsed.projectId !== 'string') {
    throw new PublishError('unknown', 'Project claim returned no projectId.')
  }
  return parsed.projectId
}
