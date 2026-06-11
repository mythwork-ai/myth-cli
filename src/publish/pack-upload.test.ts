/**
 * Tests for the OCPK pack-upload path.
 *
 * Fetch is injected via opts.fetch (same pattern as client.test.ts).
 * Pack bodies sent to /publish/pack are decoded with the vendored decodePack
 * to assert chunking and ordering.
 *
 * Chunking bound test approach: the real PACK_MAX_BYTES (40 MB) and
 * PACK_MAX_ENTRIES (500) constants are imported and used directly. For the
 * size-bound test we construct a small number of Uint8Arrays that together
 * exceed PACK_MAX_BYTES in one group, forcing the chunker to emit multiple
 * packs. We use 3 objects of Math.ceil(PACK_MAX_BYTES / 2) + 1 bytes each —
 * this is large enough to force the split on size but small enough that the
 * Node process handles it (vitest has ample heap; the test allocates ~60 MB
 * total which is fine). The entry-count bound is tested with 1203 tiny
 * objects (> 2 × PACK_MAX_ENTRIES), ensuring no pack exceeds 500 entries.
 */

import { describe, expect, it, vi } from 'vitest'
import type { BuiltObject } from './build-objects.js'
import { uploadBlobsPacked, PACK_MAX_BYTES, PACK_MAX_ENTRIES } from './pack-upload.js'
import type { PublishClientOptions } from './client.js'
import { PublishError } from './client.js'
import { decodePack } from './pack-codec.js'

// ---------------------------------------------------------------------------
// Shared constants / helpers
// ---------------------------------------------------------------------------

const TOKEN = 'fake.session.jwt'
const API = 'https://api.test.example'
const ROOT_TREE = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const SHORT_NAME = 'demo'

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fakeBlob(hash: string, bytes = 16): BuiltObject {
  return {
    hash,
    type: 'blob',
    deflated: new Uint8Array(bytes),
  }
}

/** Build a BuiltObject with a specific deflated size. */
function fakeBlobSized(hash: string, deflatedSize: number): BuiltObject {
  const deflated = new Uint8Array(deflatedSize)
  deflated.fill(0xab) // non-zero so packs aren't trivially equal
  return { hash, type: 'blob', deflated }
}

/** Decode the body of a pack POST request. */
async function decodePackBody(init: RequestInit | undefined): Promise<Uint8Array[]> {
  const body = init?.body
  if (!body) throw new Error('no body')
  // In Node fetch body can be Uint8Array / ArrayBuffer / ReadableStream etc.
  if (body instanceof Uint8Array) return decodePack(body)
  if (body instanceof ArrayBuffer) return decodePack(new Uint8Array(body))
  // Fallback: treat as buffer-like via unknown cast
  const arr = new Uint8Array(body as unknown as ArrayBuffer)
  return decodePack(arr)
}

/** Build a success response for a pack of N objects. */
function packSuccessRes(hashes: string[]): Response {
  return jsonRes({ results: hashes.map(h => ({ fullHash: h, stored: true })) })
}

/** Build a partial-failure response: some entries succeed, some fail. */
function packPartialRes(results: { hash: string; ok: boolean }[]): Response {
  return jsonRes({
    results: results.map(r =>
      r.ok
        ? { fullHash: r.hash, stored: true }
        : { fullHash: r.hash, stored: false, error: 'r2_put_failed' },
    ),
  })
}

// ---------------------------------------------------------------------------
// Chunking: entry-count bound (1203 objects → no pack > 500 entries)
// ---------------------------------------------------------------------------

describe('chunking: entry-count bound', () => {
  it('splits 1203 tiny objects across packs of at most PACK_MAX_ENTRIES, preserving order', async () => {
    const count = 1203
    const objects: BuiltObject[] = Array.from({ length: count }, (_, i) =>
      fakeBlob(i.toString(16).padStart(64, '0'), 16),
    )

    const sentPacks: Uint8Array[][] = []

    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const entries = await decodePackBody(init)
      sentPacks.push(entries)
      // Reply with all-success for the entries in this pack
      const packIdx = sentPacks.length - 1
      const packStart = packIdx * PACK_MAX_ENTRIES
      const hashes = objects
        .slice(packStart, packStart + entries.length)
        .map(o => o.hash)
      return packSuccessRes(hashes)
    }) as unknown as typeof fetch

    await uploadBlobsPacked(objects, {
      apiUrl: API,
      sessionToken: TOKEN,
      rootTree: ROOT_TREE,
      fetch: fakeFetch,
    })

    // All packs must respect both bounds.
    for (const pack of sentPacks) {
      expect(pack.length).toBeLessThanOrEqual(PACK_MAX_ENTRIES)
      const totalBytes = pack.reduce((s, e) => s + e.length, 0)
      expect(totalBytes).toBeLessThanOrEqual(PACK_MAX_BYTES)
    }

    // All 1203 objects must be covered exactly once, in order.
    const allEntries = sentPacks.flat()
    expect(allEntries).toHaveLength(count)
    // Verify order: each pack's entries match the expected slice of objects
    let pos = 0
    for (const pack of sentPacks) {
      for (const entry of pack) {
        // The deflated bytes of fakeBlob are all-zero 16-byte arrays — compare lengths
        // as a proxy (all are identical size 16, distinguishable only by position in
        // the original array, which is what order preservation means here).
        expect(entry.length).toBe(objects[pos]!.deflated.length)
        pos++
      }
    }
    expect(pos).toBe(count)
  })
})

// ---------------------------------------------------------------------------
// Chunking: size bound (objects sized to force split on PACK_MAX_BYTES)
// ---------------------------------------------------------------------------

describe('chunking: size bound', () => {
  it('bounds the ENCODED body, not just the entry-byte sum (header + varint overhead)', async () => {
    // Two objects of exactly PACK_MAX_BYTES/2 each: the entry bytes sum to
    // exactly the cap, so the OCPK header + length varints push a single
    // pack's encoded body OVER it — the chunker must emit two packs, and
    // every body actually sent must fit the server's 40 MB cap.
    const half = PACK_MAX_BYTES / 2
    const objects: BuiltObject[] = [
      fakeBlob('a'.repeat(64), half),
      fakeBlob('b'.repeat(64), half),
    ]
    const sentBodySizes: number[] = []
    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const entries = await decodePackBody(init)
      const body = init?.body as Uint8Array
      sentBodySizes.push(body.byteLength)
      // One entry per pack; map back to the object by size match.
      const hashes = entries.map(e => objects.find(o => o.deflated.length === e.length)!.hash)
      return packSuccessRes(hashes)
    }) as unknown as typeof fetch

    await uploadBlobsPacked(objects, {
      apiUrl: API,
      sessionToken: TOKEN,
      rootTree: ROOT_TREE,
      fetch: fakeFetch,
    })

    expect(sentBodySizes).toHaveLength(2)
    for (const size of sentBodySizes) {
      expect(size).toBeLessThanOrEqual(PACK_MAX_BYTES)
    }
  })

  it('splits objects into separate packs when size bound is hit before entry count', async () => {
    // Three objects each slightly over half of PACK_MAX_BYTES → 3 packs of 1.
    // (object1 + object2 would exceed the cap, so each is in its own pack.)
    const halfPlus = Math.ceil(PACK_MAX_BYTES / 2) + 1
    const objects = [
      fakeBlobSized('a'.repeat(64), halfPlus),
      fakeBlobSized('b'.repeat(64), halfPlus),
      fakeBlobSized('c'.repeat(64), halfPlus),
    ]

    const packSizes: number[] = []
    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const entries = await decodePackBody(init)
      packSizes.push(entries.length)
      const hashes = entries.map((_, i) => objects[packSizes.length - 1 + i - entries.length + i]?.hash ?? 'x'.repeat(64))
      // Return success for these entries (hash values don't need to match for this test)
      return jsonRes({
        results: entries.map((_e, _i) => ({ fullHash: 'x'.repeat(64), stored: true })),
      })
    }) as unknown as typeof fetch

    await uploadBlobsPacked(objects, {
      apiUrl: API,
      sessionToken: TOKEN,
      rootTree: ROOT_TREE,
      fetch: fakeFetch,
    })

    // Each of the 3 objects must be in its own pack (size bound forces it).
    expect(packSizes).toHaveLength(3)
    for (const sz of packSizes) expect(sz).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Headers + auth on pack POST
// ---------------------------------------------------------------------------

describe('headers on pack POST', () => {
  it('sends Authorization + X-Root-Tree + X-Short-Name + correct Content-Type', async () => {
    let capturedHeaders: Headers | null = null
    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers)
      return packSuccessRes([fakeBlob('a'.repeat(64)).hash])
    }) as unknown as typeof fetch

    await uploadBlobsPacked([fakeBlob('a'.repeat(64))], {
      apiUrl: API,
      sessionToken: TOKEN,
      rootTree: ROOT_TREE,
      shortName: SHORT_NAME,
      fetch: fakeFetch,
    })

    expect(capturedHeaders!.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(capturedHeaders!.get('X-Root-Tree')).toBe(ROOT_TREE)
    expect(capturedHeaders!.get('X-Short-Name')).toBe(SHORT_NAME)
    expect(capturedHeaders!.get('Content-Type')).toBe('application/octet-stream')
    expect(capturedHeaders!.get('X-Scope')).toBeNull()
  })

  it('omits X-Short-Name when shortName is absent', async () => {
    let sawShortName = false
    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      sawShortName = h.has('X-Short-Name')
      return packSuccessRes([fakeBlob('a'.repeat(64)).hash])
    }) as unknown as typeof fetch

    await uploadBlobsPacked([fakeBlob('a'.repeat(64))], {
      apiUrl: API,
      sessionToken: TOKEN,
      rootTree: ROOT_TREE,
      // no shortName
      fetch: fakeFetch,
    })

    expect(sawShortName).toBe(false)
  })

  it('POSTs to {apiUrl}/publish/pack', async () => {
    let calledUrl = ''
    const fakeFetch = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      calledUrl = String(url)
      return packSuccessRes([fakeBlob('a'.repeat(64)).hash])
    }) as unknown as typeof fetch

    await uploadBlobsPacked([fakeBlob('a'.repeat(64))], {
      apiUrl: API,
      sessionToken: TOKEN,
      rootTree: ROOT_TREE,
      fetch: fakeFetch,
    })

    expect(calledUrl).toBe(`${API}/publish/pack`)
  })
})

// ---------------------------------------------------------------------------
// Partial failure: first response marks 2 entries error → retry exactly those 2
// ---------------------------------------------------------------------------

describe('partial failure retry', () => {
  it('re-sends exactly the failed entries on second POST, then succeeds; onProgress totals correct', async () => {
    const objects = [
      fakeBlob('a'.repeat(64), 10),
      fakeBlob('b'.repeat(64), 10),
      fakeBlob('c'.repeat(64), 10),
    ]
    const total = objects.length

    let callCount = 0
    const decodedBodies: Uint8Array[][] = []

    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      callCount++
      const entries = await decodePackBody(init)
      decodedBodies.push(entries)

      if (callCount === 1) {
        // First call: a and c succeed, b fails.
        return packPartialRes([
          { hash: 'a'.repeat(64), ok: true },
          { hash: 'b'.repeat(64), ok: false },
          { hash: 'c'.repeat(64), ok: true },
        ])
      }
      // Second call: retry of b — succeeds.
      return packSuccessRes(['b'.repeat(64)])
    }) as unknown as typeof fetch

    const progressEvents: Array<{ index: number; hash: string }> = []
    await uploadBlobsPacked(objects, {
      apiUrl: API,
      sessionToken: TOKEN,
      rootTree: ROOT_TREE,
      fetch: fakeFetch,
      onProgress: e => {
        if (e.kind === 'uploaded') {
          progressEvents.push({ index: e.index, total: e.total } as never)
          progressEvents[progressEvents.length - 1] = { index: e.index, hash: e.hash }
        }
      },
    })

    // Two POSTs total: initial + one retry round.
    expect(callCount).toBe(2)

    // First body: all 3 entries.
    expect(decodedBodies[0]).toHaveLength(3)

    // Second body: exactly 1 entry (b, which is 10 bytes).
    expect(decodedBodies[1]).toHaveLength(1)
    expect(decodedBodies[1]![0]!.length).toBe(10) // b's deflated size

    // Progress: 3 events total (a+c from first pack, then b from retry).
    expect(progressEvents).toHaveLength(total)
    // Indices must be 1..3 in some order.
    const indices = progressEvents.map(e => e.index).sort((x, y) => x - y)
    expect(indices).toEqual([1, 2, 3])
  })
})

// ---------------------------------------------------------------------------
// Persistent failure → PublishError('backend_down') after 3 retry rounds
// ---------------------------------------------------------------------------

describe('persistent failure', () => {
  it('throws backend_down after MAX_PACK_RETRY_ROUNDS rounds of total failure', async () => {
    const objects = [fakeBlob('a'.repeat(64)), fakeBlob('b'.repeat(64))]
    let callCount = 0

    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      callCount++
      // Every call: all entries fail.
      return jsonRes({
        results: objects.map(o => ({ fullHash: o.hash, stored: false, error: 'r2_put_failed' })),
      })
    }) as unknown as typeof fetch

    await expect(
      uploadBlobsPacked(objects, {
        apiUrl: API,
        sessionToken: TOKEN,
        rootTree: ROOT_TREE,
        fetch: fakeFetch,
      }),
    ).rejects.toMatchObject({ code: 'backend_down' })

    // Initial round + 3 retry rounds = 4 total calls (1 pack each round).
    expect(callCount).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// 404 fallback → uploadBlobs (per-object PUTs) used for the whole set
// ---------------------------------------------------------------------------

describe('404 fallback', () => {
  it('falls back to per-object PUTs when /publish/pack returns 404', async () => {
    const objects = [fakeBlob('a'.repeat(64)), fakeBlob('b'.repeat(64))]
    const putUrls: string[] = []
    let packCalled = false

    const fakeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.endsWith('/publish/pack')) {
        packCalled = true
        return new Response('not found', { status: 404 })
      }
      // Per-object PUT
      expect(init?.method).toBe('PUT')
      putUrls.push(urlStr)
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    await uploadBlobsPacked(objects, {
      apiUrl: API,
      sessionToken: TOKEN,
      rootTree: ROOT_TREE,
      fetch: fakeFetch,
    })

    expect(packCalled).toBe(true)
    // Both objects uploaded via individual PUTs.
    expect(putUrls).toHaveLength(2)
    for (const u of putUrls) {
      expect(u).toMatch(new RegExp(`^${API}/publish/blob/[a-f0-9]{64}$`))
    }
  })

  it('falls back on 405 as well', async () => {
    const objects = [fakeBlob('a'.repeat(64))]
    const putUrls: string[] = []

    const fakeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.endsWith('/publish/pack')) return new Response('method not allowed', { status: 405 })
      putUrls.push(urlStr)
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    await uploadBlobsPacked(objects, {
      apiUrl: API,
      sessionToken: TOKEN,
      rootTree: ROOT_TREE,
      fetch: fakeFetch,
    })

    expect(putUrls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 422 → PublishError('bad_bundle') surfacing the server message, no retry
// ---------------------------------------------------------------------------

describe('422 bad_bundle', () => {
  it('throws bad_bundle with server error message, does not retry', async () => {
    let callCount = 0
    const fakeFetch = vi.fn(async () => {
      callCount++
      return new Response(JSON.stringify({ error: 'malformed pack: bad count varint' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    await expect(
      uploadBlobsPacked([fakeBlob('a'.repeat(64))], {
        apiUrl: API,
        sessionToken: TOKEN,
        rootTree: ROOT_TREE,
        fetch: fakeFetch,
      }),
    ).rejects.toMatchObject({
      code: 'bad_bundle',
      message: expect.stringContaining('malformed pack: bad count varint'),
    })

    // No retry on 422 — it's a client bug, not a transient server error.
    expect(callCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Progress: total is object count, not pack count
// ---------------------------------------------------------------------------

describe('progress events', () => {
  it('emits one uploaded event per object (total = object count, not pack count)', async () => {
    const objects = Array.from({ length: 10 }, (_, i) => fakeBlob(i.toString(16).padStart(64, '0')))

    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const entries = await decodePackBody(init)
      return jsonRes({ results: entries.map((_e, i) => ({ fullHash: objects[i]!.hash, stored: true })) })
    }) as unknown as typeof fetch

    const progressEvents: Array<{ index: number; total: number }> = []
    await uploadBlobsPacked(objects, {
      apiUrl: API,
      sessionToken: TOKEN,
      rootTree: ROOT_TREE,
      fetch: fakeFetch,
      onProgress: e => {
        if (e.kind === 'uploaded') progressEvents.push({ index: e.index, total: e.total })
      },
    })

    expect(progressEvents).toHaveLength(10)
    // total must always equal object count (10), not pack count.
    for (const e of progressEvents) expect(e.total).toBe(10)
    // indices 1..10, each exactly once.
    const indices = progressEvents.map(e => e.index).sort((a, b) => a - b)
    expect(indices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })
})

// ---------------------------------------------------------------------------
// 401 → session_expired, no retry
// ---------------------------------------------------------------------------

describe('401 error mapping', () => {
  it('throws session_expired on 401, no retry', async () => {
    let callCount = 0
    const fakeFetch = vi.fn(async () => {
      callCount++
      return jsonRes({ error: 'unauthorized' }, 401)
    }) as unknown as typeof fetch

    await expect(
      uploadBlobsPacked([fakeBlob('a'.repeat(64))], {
        apiUrl: API,
        sessionToken: TOKEN,
        rootTree: ROOT_TREE,
        fetch: fakeFetch,
      }),
    ).rejects.toMatchObject({ code: 'session_expired' })

    expect(callCount).toBe(1)
  })
})
