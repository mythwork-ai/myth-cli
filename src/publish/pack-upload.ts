/**
 * Pack-upload path for `myth publish` (Phase 2, OCPK wire-pack).
 *
 * Instead of one PUT per object (`uploadBlobs`), `uploadBlobsPacked` groups
 * the missing objects into OCPK packs and sends them to POST /publish/pack.
 * A single ~140-object publish collapses from ~9 upload waves (Phase 1,
 * 16-way pool) to ~1–2 POST requests, each carrying a whole pack body.
 *
 * Pack grouping constraints (greedy, in check order):
 *   - ≤ 40 MB total deflated bytes per pack  (PACK_MAX_BYTES)
 *   - ≤ 500 entries per pack                 (PACK_MAX_ENTRIES)
 * A single object whose deflated length exceeds PACK_MAX_BYTES cannot fit in
 * any pack — such objects fall through to the per-object PUT path instead of
 * being silently dropped.
 *
 * Parallelism: 2 concurrent pack POSTs (packs are large; more would saturate
 * the connection before saturating the server).
 *
 * Retry logic: after each pack POST the response lists per-entry results.
 * Entries that report an `error` field are re-packed and re-sent in the next
 * round, up to MAX_PACK_RETRY_ROUNDS (3) rounds. The same exponential backoff
 * delays as per-object retry are reused. After the final round, any still-
 * failing entries throw PublishError('backend_down', ...).
 *
 * Fallback: a 404 or 405 from POST /publish/pack means the platform predates
 * packs. We fall back to the existing per-object uploadBlobs for the whole
 * missing set.
 *
 * Error mapping for non-retryable statuses mirrors mapErrorResponse in
 * client.ts:
 *   401 → session_expired  (no retry)
 *   403 → name_taken       (no retry)
 *   413 → too_large        (no retry)
 *   422 → bad_bundle with server's error message — means a malformed pack,
 *          i.e. a client bug; surfaces the server message so it's debuggable
 *   5xx → backend_down after exhausting retries
 */

import type { BuiltObject } from './build-objects.js'
import type { PublishClientOptions } from './client.js'
import { mapErrorResponse, PublishError, uploadBlobs } from './client.js'
import { encodePack } from './pack-codec.js'

// ---------------------------------------------------------------------------
// Constants — exported so tests can construct objects that exercise both
// bounds without allocating 40 MB of real data.
// ---------------------------------------------------------------------------

/** Maximum deflated bytes summed across entries in one pack (40 MB). */
export const PACK_MAX_BYTES = 40 * 1024 * 1024

/** Maximum entries in one pack. */
export const PACK_MAX_ENTRIES = 500

/** Pack POST parallelism — packs are large so 2 is the right saturation point. */
const PACK_PARALLELISM = 2

/** Retry rounds for partially-failed packs (same semantics as PUT retries). */
const MAX_PACK_RETRY_ROUNDS = 3

/** Backoff delays in ms — same schedule as per-object PUT retries. */
const PACK_RETRY_DELAYS_MS = [250, 500, 1000]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PackResult {
  fullHash: string
  stored: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Split `objects` into greedy packs respecting PACK_MAX_BYTES and
 * PACK_MAX_ENTRIES.  Objects that individually exceed PACK_MAX_BYTES are
 * returned in `oversized` for per-object fallback — they cannot be packed.
 * Order within each pack is preserved (same as input order).
 */
/** Encoded size of one entry: LEB128 length prefix (≤5 bytes for u32) + bytes. */
function encodedEntrySize(len: number): number {
  let varintLen = 1
  let v = len
  while (v >= 0x80) {
    v >>>= 7
    varintLen++
  }
  return varintLen + len
}

/** OCPK header: "OCPK" (4) + format (1) + count varint (≤2 bytes for ≤500). */
const PACK_HEADER_BYTES = 7

function chunkIntoPacks(objects: BuiltObject[]): {
  packs: BuiltObject[][]
  oversized: BuiltObject[]
} {
  const packs: BuiltObject[][] = []
  const oversized: BuiltObject[] = []
  let current: BuiltObject[] = []
  // The bound is on the ENCODED body the server receives, so account for the
  // pack header and each entry's varint length prefix, not just entry bytes.
  let currentBytes = PACK_HEADER_BYTES

  for (const obj of objects) {
    const size = encodedEntrySize(obj.deflated.length)

    // Guard: a single object larger than the pack cap can never be packed.
    if (PACK_HEADER_BYTES + size > PACK_MAX_BYTES) {
      oversized.push(obj)
      continue
    }

    // Would adding this object exceed either bound? Close the current pack
    // and start a new one.
    if (
      current.length > 0 &&
      (currentBytes + size > PACK_MAX_BYTES || current.length >= PACK_MAX_ENTRIES)
    ) {
      packs.push(current)
      current = []
      currentBytes = PACK_HEADER_BYTES
    }

    current.push(obj)
    currentBytes += size
  }

  if (current.length > 0) packs.push(current)
  return { packs, oversized }
}

// ---------------------------------------------------------------------------
// Single pack POST (no retry logic here — retry happens at uploadBlobsPacked)
// ---------------------------------------------------------------------------

async function postPack(
  packObjects: BuiltObject[],
  opts: PublishClientOptions,
): Promise<{ results: PackResult[]; status: number }> {
  const fetchImpl = opts.fetch ?? fetch
  const entries = packObjects.map(o => o.deflated)
  const body = encodePack(entries)

  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    Authorization: `Bearer ${opts.sessionToken}`,
    'X-Root-Tree': opts.rootTree,
  }
  if (opts.shortName) headers['X-Short-Name'] = opts.shortName

  const res = await fetchImpl(`${opts.apiUrl}/publish/pack`, {
    method: 'POST',
    headers,
    body: body as unknown as BodyInit,
  })

  return { results: await parsePackResponse(res, packObjects, opts), status: res.status }
}

/**
 * Parse a /publish/pack response.  Throws immediately for non-retryable
 * statuses (401/403/413/422/404/405).  Returns an empty array on 5xx so the
 * caller treats every entry as failed and retries.
 */
async function parsePackResponse(
  res: Response,
  packObjects: BuiltObject[],
  opts: PublishClientOptions,
): Promise<PackResult[]> {
  if (res.ok) {
    const body = (await res.json()) as { results?: unknown }
    if (!Array.isArray(body.results)) {
      throw new PublishError('unknown', 'malformed /publish/pack response: missing results array')
    }
    return body.results as PackResult[]
  }

  const status = res.status

  // 404 / 405 — the platform predates the pack endpoint. The sentinel is
  // caught in uploadBlobsPacked, which falls back to per-object PUTs.
  if (status === 404 || status === 405) {
    throw new PackUnavailableError()
  }

  // 422 — malformed pack body (client bug). Surface server message; don't
  // retry because re-sending the same malformed pack would fail again.
  if (status === 422) {
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
    throw new PublishError(
      'bad_bundle',
      serverMsg
        ? `Pack upload rejected by server: ${serverMsg}`
        : 'Pack upload rejected by server (422). This is likely a myth-cli bug; please file an issue.',
      { status },
    )
  }

  // 401 / 403 / 413 — map to the standard codes (not retryable).
  if (status === 401 || status === 403 || status === 413) {
    throw await mapErrorResponse(res, { context: 'put' })
  }

  // 5xx and anything else — treat all entries as failed so the caller retries.
  // We consume the body to be a good HTTP citizen but don't throw yet.
  try {
    await res.text()
  } catch {
    // ignore
  }
  // Return fabricated failures for each object so caller queues them for retry.
  return packObjects.map(o => ({ fullHash: o.hash, stored: false, error: `http_${status}` }))
}

// ---------------------------------------------------------------------------
// Sentinel error for 404/405 fallback
// ---------------------------------------------------------------------------

class PackUnavailableError extends Error {
  constructor() {
    super('pack endpoint unavailable')
    this.name = 'PackUnavailableError'
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Upload missing objects via OCPK packs (POST /publish/pack).
 *
 * Grouping: greedy in check order, ≤ 40 MB and ≤ 500 entries per pack.
 * Concurrency: 2 simultaneous pack POSTs.
 * Partial-failure retry: entries reported with `error` are re-packed and
 *   re-sent up to 3 rounds, with 250/500/1000ms backoff between rounds.
 * Fallback: 404/405 → falls back to per-object uploadBlobs for the whole set.
 * Progress: onProgress('uploaded', ...) events are emitted per-object as each
 *   pack completes (per-object granularity WITHIN a pack is not observable
 *   because the server processes entries in bulk; we advance the counter by
 *   the pack's entry count when the pack response arrives).
 */
export async function uploadBlobsPacked(
  toUpload: BuiltObject[],
  opts: PublishClientOptions,
): Promise<void> {
  if (toUpload.length === 0) return

  const total = toUpload.length
  let completedCount = 0

  // Helper: emit progress for a batch of objects completing together.
  function emitProgress(objects: BuiltObject[]): void {
    for (const obj of objects) {
      completedCount++
      opts.onProgress?.({
        kind: 'uploaded',
        index: completedCount,
        total,
        hash: obj.hash,
      })
    }
  }

  // --- Chunk into packs -----------------------------------------------------
  const { packs: initialPacks, oversized } = chunkIntoPacks(toUpload)
  const succeededHashes = new Set<string>()

  // Oversized objects fall back to per-object PUT immediately.
  if (oversized.length > 0) {
    // This is genuinely surprising (objects should be ≤ 50 MB inflated, much
    // less deflated), so log it clearly.
    console.log(
      `[myth] ${oversized.length} object(s) exceed the pack size cap; uploading individually.`,
    )
    await uploadBlobs(oversized, {
      ...opts,
      onProgress: e => {
        if (e.kind === 'uploaded') {
          completedCount++
          opts.onProgress?.({ ...e, index: completedCount, total })
        }
      },
    })
    // Mark them landed so a later 404 pack-fallback (which re-uploads
    // everything not in succeededHashes) doesn't re-PUT and double-count them.
    for (const obj of oversized) succeededHashes.add(obj.hash)
  }

  if (initialPacks.length === 0) return

  // --- Upload packs in rounds, retrying partial failures --------------------
  let pendingPacks = initialPacks

  for (let round = 0; round <= MAX_PACK_RETRY_ROUNDS; round++) {
    if (pendingPacks.length === 0) break

    if (round > 0) {
      // Backoff before re-sending failed subsets.
      await sleep(PACK_RETRY_DELAYS_MS[round - 1] ?? PACK_RETRY_DELAYS_MS[PACK_RETRY_DELAYS_MS.length - 1]!)
    }

    // Use a bounded worker pool (parallelism 2) over the pending packs.
    const failedObjects: BuiltObject[][] = []
    let nextPackIdx = 0
    let firstError: PublishError | null = null
    let shouldFallback = false

    async function packWorker(): Promise<void> {
      while (true) {
        if (firstError || shouldFallback) return
        const packIdx = nextPackIdx++
        if (packIdx >= pendingPacks.length) return
        const packObjs = pendingPacks[packIdx]!

        let results: PackResult[]
        try {
          const outcome = await postPack(packObjs, opts)
          results = outcome.results
        } catch (err) {
          if (err instanceof PackUnavailableError) {
            shouldFallback = true
            return
          }
          if (err instanceof PublishError) {
            if (!firstError) firstError = err
            return
          }
          // Network error
          if (!firstError) {
            firstError = new PublishError('network', `network error uploading pack: ${String(err)}`)
          }
          return
        }

        // Partition results into succeeded and failed.
        const succeeded: BuiltObject[] = []
        const failed: BuiltObject[] = []

        for (let i = 0; i < packObjs.length; i++) {
          const r = results[i]
          const obj = packObjs[i]!
          if (r && !r.error) {
            succeeded.push(obj)
          } else {
            failed.push(obj)
          }
        }

        if (succeeded.length > 0) {
          // Emit progress for objects that landed successfully in this pack.
          // Per-object granularity within a pack isn't visible to us; we advance
          // the counter by the whole pack's successful count at once.
          for (const obj of succeeded) succeededHashes.add(obj.hash)
          emitProgress(succeeded)
        }

        if (failed.length > 0) {
          failedObjects.push(failed)
        }
      }
    }

    const workers: Promise<void>[] = []
    for (let i = 0; i < Math.min(PACK_PARALLELISM, pendingPacks.length); i++) {
      workers.push(packWorker())
    }
    await Promise.all(workers)

    // --- Handle terminal conditions -----------------------------------------

    if (shouldFallback) {
      // 404/405: endpoint predates packs. Fall back to per-object PUTs for
      // whatever hasn't landed yet (a concurrent pack may have succeeded
      // before the 404 arrived; re-uploading those would only double-count
      // progress — dedup makes re-PUTs harmless but the counter wouldn't be).
      console.log('[myth] pack endpoint unavailable, falling back to per-object upload')
      const remaining = toUpload.filter(o => !succeededHashes.has(o.hash))
      await uploadBlobs(remaining, {
        ...opts,
        onProgress: e => {
          if (e.kind === 'uploaded') {
            completedCount++
            opts.onProgress?.({ ...e, index: completedCount, total })
          }
        },
      })
      return
    }

    if (firstError) throw firstError

    // Re-pack failed objects for the next round.
    if (failedObjects.length === 0) break // all packs succeeded

    const allFailed = failedObjects.flat()

    if (round === MAX_PACK_RETRY_ROUNDS) {
      throw new PublishError(
        'backend_down',
        `${allFailed.length} object(s) failed to upload after ${MAX_PACK_RETRY_ROUNDS} retry rounds.`,
        { status: undefined },
      )
    }

    // Re-chunk failed objects (they may fit into fewer packs now).
    const { packs: retryPacks, oversized: retryOversized } = chunkIntoPacks(allFailed)
    if (retryOversized.length > 0) {
      // Shouldn't happen (they already passed the cap check), but be safe.
      await uploadBlobs(retryOversized, {
        ...opts,
        onProgress: e => {
          if (e.kind === 'uploaded') {
            completedCount++
            opts.onProgress?.({ ...e, index: completedCount, total })
          }
        },
      })
    }
    pendingPacks = retryPacks
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
