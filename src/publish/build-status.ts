/**
 * Client for GET /build-status/{tree} — Tier-2 build tracking.
 *
 * Returns the current status of a platform build keyed by content-addressed
 * tree hash. The server resolves BUILDER_VERSION server-side; the client
 * supplies ONLY the tree and the session Bearer token.
 *
 * Response shape (200):
 *   { tree, builderVersion, status: "pending"|"ok"|"failed"|"none", reason?: string }
 *   Cache-Control: no-store
 *
 * Error handling:
 *   - 400 → bad request (malformed tree); thrown as PublishError('bad_bundle').
 *   - 401 → session expired; thrown as PublishError('session_expired').
 *   - 404 / non-JSON / any other non-2xx → { available: false } (endpoint
 *     not deployed yet, or older backend without Tier-2 tracking).
 */

import { PublishError } from './client.js'

export type BuildStatusValue = 'pending' | 'ok' | 'failed' | 'none'

export type BuildStatusResult =
  | {
      available: true
      status: BuildStatusValue
      reason?: string
      builderVersion: string
    }
  | { available: false }

export interface BuildStatusOptions {
  apiUrl: string
  sessionToken: string
  /** Override fetch (tests). */
  fetch?: typeof fetch
  /**
   * Abort signal wired into the underlying fetch so a caller (e.g. the
   * poller's SIGINT detach) can cancel an in-flight request immediately.
   * An abort rejects the returned promise with the signal's abort reason.
   */
  signal?: AbortSignal
}

/**
 * Fetch the current build status for `tree`.
 *
 * Never throws for "endpoint not available" — callers treat that path as
 * fire-and-forget fallback. Only throws for hard errors (401, 400) that
 * the user must act on.
 */
export async function fetchBuildStatus(
  tree: string,
  opts: BuildStatusOptions,
): Promise<BuildStatusResult> {
  const fetchImpl = opts.fetch ?? fetch
  let res: Response
  try {
    res = await fetchImpl(`${opts.apiUrl}/build-status/${tree}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${opts.sessionToken}`,
      },
      signal: opts.signal,
    })
  } catch (e) {
    // Cancellation is not "unavailable" — rethrow so the caller can detach.
    if (opts.signal?.aborted || (e as Error | null)?.name === 'AbortError') {
      throw e
    }
    // Network error → treat as unavailable so CI isn't blocked.
    return { available: false }
  }

  // 401 / 400 are hard errors — surface them.
  if (res.status === 401) {
    throw new PublishError('session_expired', 'Session expired during build status check.')
  }
  if (res.status === 400) {
    throw new PublishError('bad_bundle', 'Malformed tree hash sent to /build-status.')
  }

  // 404 / 5xx / anything non-2xx or non-JSON → not available.
  if (!res.ok) {
    return { available: false }
  }

  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    return { available: false }
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('status' in parsed) ||
    typeof (parsed as Record<string, unknown>).status !== 'string'
  ) {
    return { available: false }
  }

  const body = parsed as Record<string, unknown>
  const status = body.status as string
  if (status !== 'pending' && status !== 'ok' && status !== 'failed' && status !== 'none') {
    return { available: false }
  }

  return {
    available: true,
    status: status as BuildStatusValue,
    reason: typeof body.reason === 'string' ? body.reason : undefined,
    builderVersion: typeof body.builderVersion === 'string' ? body.builderVersion : 'unknown',
  }
}
