/**
 * Tests for the publish-worker HTTP client. The `fetch` boundary is
 * mocked — we never hit a real backend. Assertions cover:
 *
 *   - Authorization is attached to every request; the blob scope is NOT
 *     client-supplied. Instead we send the worker the inputs it derives
 *     scope from: `rootTree` (+ optional `shortName`) in the /check body
 *     and as `X-Root-Tree` / `X-Short-Name` headers on each blob PUT.
 *   - The canonical-only path (no shortName) omits shortName entirely.
 *   - Error mapping for 401/403/413/502/400 produces the documented
 *     CLI messages.
 *   - uploadBlobs retries on 5xx and throws on the 4th failure.
 *   - finalizePublish parses the worker's JSON response.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  checkBlobs,
  finalizePublish,
  mapErrorResponse,
  PublishError,
  uploadBlobs,
} from './client.js'
import type { BuiltObject } from './build-objects.js'

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

describe('checkBlobs', () => {
  it('sends Authorization + rootTree/shortName in the body (no X-Scope), returns missing array', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fakeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return jsonRes({ missing: ['h1', 'h2'] })
    }) as unknown as typeof fetch
    const result = await checkBlobs(['h1', 'h2', 'h3'], {
      apiUrl: API,
      sessionToken: TOKEN,
      rootTree: ROOT_TREE,
      shortName: SHORT_NAME,
      fetch: fakeFetch,
    })
    expect(result).toEqual(['h1', 'h2'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${API}/publish/check`)
    const headers = new Headers(calls[0]!.init?.headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(headers.get('X-Scope')).toBeNull()
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      hashes: ['h1', 'h2', 'h3'],
      rootTree: ROOT_TREE,
      shortName: SHORT_NAME,
    })
  })

  it('omits shortName from the body on a canonical-only publish', async () => {
    let sentBody: Record<string, unknown> = {}
    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body))
      return jsonRes({ missing: [] })
    }) as unknown as typeof fetch
    await checkBlobs(['h1'], {
      apiUrl: API,
      sessionToken: TOKEN,
      rootTree: ROOT_TREE,
      fetch: fakeFetch,
    })
    expect(sentBody).toEqual({ hashes: ['h1'], rootTree: ROOT_TREE })
    expect('shortName' in sentBody).toBe(false)
  })

  it('maps 401 to session_expired', async () => {
    const fakeFetch = vi.fn(async () => jsonRes({ error: 'unauthorized' }, 401)) as unknown as typeof fetch
    await expect(
      checkBlobs(['h'], { apiUrl: API, sessionToken: TOKEN, rootTree: ROOT_TREE, fetch: fakeFetch }),
    ).rejects.toMatchObject({ code: 'session_expired' })
  })

  it('maps 400 to bad_bundle', async () => {
    const fakeFetch = vi.fn(async () => jsonRes({ error: 'bad' }, 400)) as unknown as typeof fetch
    await expect(
      checkBlobs(['h'], { apiUrl: API, sessionToken: TOKEN, rootTree: ROOT_TREE, fetch: fakeFetch }),
    ).rejects.toMatchObject({ code: 'bad_bundle' })
  })

  it('throws on malformed response (no `missing` array)', async () => {
    const fakeFetch = vi.fn(async () => jsonRes({})) as unknown as typeof fetch
    await expect(
      checkBlobs(['h'], { apiUrl: API, sessionToken: TOKEN, rootTree: ROOT_TREE, fetch: fakeFetch }),
    ).rejects.toMatchObject({ code: 'unknown' })
  })
})

describe('uploadBlobs', () => {
  it('PUTs each blob with Authorization + X-Root-Tree/X-Short-Name (no X-Scope), calls onProgress', async () => {
    const calls: string[] = []
    const fakeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
      expect(headers.get('X-Scope')).toBeNull()
      expect(headers.get('X-Root-Tree')).toBe(ROOT_TREE)
      expect(headers.get('X-Short-Name')).toBe(SHORT_NAME)
      expect(init?.method).toBe('PUT')
      calls.push(String(url))
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    const blobs = [fakeBlob('a'.repeat(64)), fakeBlob('b'.repeat(64)), fakeBlob('c'.repeat(64))]
    const progress: number[] = []
    await uploadBlobs(blobs, {
      apiUrl: API,
      sessionToken: TOKEN,
      rootTree: ROOT_TREE,
      shortName: SHORT_NAME,
      fetch: fakeFetch,
      onProgress: e => {
        if (e.kind === 'uploaded') progress.push(e.index)
      },
    })
    expect(calls).toHaveLength(3)
    expect(progress.sort()).toEqual([1, 2, 3])
    for (const u of calls) expect(u).toMatch(new RegExp(`^${API}/publish/blob/[a-f0-9]{64}$`))
  })

  it('omits X-Short-Name on a canonical-only publish', async () => {
    let sawShortName = true
    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('X-Root-Tree')).toBe(ROOT_TREE)
      sawShortName = headers.has('X-Short-Name')
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch
    await uploadBlobs([fakeBlob('a'.repeat(64))], {
      apiUrl: API,
      sessionToken: TOKEN,
      rootTree: ROOT_TREE,
      fetch: fakeFetch,
    })
    expect(sawShortName).toBe(false)
  })

  it('retries on 503 and succeeds on second attempt', async () => {
    let attempts = 0
    const fakeFetch = vi.fn(async () => {
      attempts++
      if (attempts === 1) return new Response('busy', { status: 503 })
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch
    await uploadBlobs([fakeBlob('a'.repeat(64))], {
      apiUrl: API,
      sessionToken: TOKEN,
      rootTree: ROOT_TREE,
      fetch: fakeFetch,
    })
    expect(attempts).toBe(2)
  })

  it('throws session_expired on 401 without retrying', async () => {
    let attempts = 0
    const fakeFetch = vi.fn(async () => {
      attempts++
      return new Response('unauth', { status: 401 })
    }) as unknown as typeof fetch
    await expect(
      uploadBlobs([fakeBlob('a'.repeat(64))], {
        apiUrl: API,
        sessionToken: TOKEN,
        rootTree: ROOT_TREE,
        fetch: fakeFetch,
      }),
    ).rejects.toMatchObject({ code: 'session_expired' })
    expect(attempts).toBe(1)
  })

  it('throws too_large on 413', async () => {
    const fakeFetch = vi.fn(async () => new Response('too big', { status: 413 })) as unknown as typeof fetch
    await expect(
      uploadBlobs([fakeBlob('a'.repeat(64))], {
        apiUrl: API,
        sessionToken: TOKEN,
        rootTree: ROOT_TREE,
        fetch: fakeFetch,
      }),
    ).rejects.toMatchObject({ code: 'too_large' })
  })

  it('throws backend_down after 4 retries on persistent 502', async () => {
    let attempts = 0
    const fakeFetch = vi.fn(async () => {
      attempts++
      return new Response('blob down', { status: 502 })
    }) as unknown as typeof fetch
    await expect(
      uploadBlobs([fakeBlob('a'.repeat(64))], {
        apiUrl: API,
        sessionToken: TOKEN,
        rootTree: ROOT_TREE,
        fetch: fakeFetch,
      }),
    ).rejects.toMatchObject({ code: 'backend_down' })
    expect(attempts).toBe(4) // 1 + 3 retries
  })
})

describe('finalizePublish', () => {
  it('sends headCommit + shortName (no X-Scope), parses canonical + alias', async () => {
    const fakeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(`${API}/publish`)
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
      expect(headers.get('X-Scope')).toBeNull()
      const body = JSON.parse(String(init?.body))
      expect(body.headCommit).toMatch(/^[a-f0-9]{64}$/)
      expect(body.shortName).toBe('myapp')
      return jsonRes({
        commit: body.headCommit,
        tree: 'b'.repeat(64),
        canonical: 'cccc'.repeat(13),
        alias: 'myapp',
      })
    }) as unknown as typeof fetch
    const result = await finalizePublish('a'.repeat(64), {
      apiUrl: API,
      sessionToken: TOKEN,
      rootTree: ROOT_TREE,
      shortName: 'myapp',
      fetch: fakeFetch,
    })
    expect(result.alias).toBe('myapp')
    expect(result.canonical).toBe('cccc'.repeat(13))
  })

  it('omits shortName from the body when undefined', async () => {
    const fakeFetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.shortName).toBeUndefined()
      return jsonRes({
        commit: 'a'.repeat(64),
        tree: 'b'.repeat(64),
        canonical: 'cccc'.repeat(13),
        alias: null,
      })
    }) as unknown as typeof fetch
    const result = await finalizePublish('a'.repeat(64), {
      apiUrl: API,
      sessionToken: TOKEN,
      rootTree: ROOT_TREE,
      fetch: fakeFetch,
    })
    expect(result.alias).toBeNull()
  })

  it('maps 403 to name_taken with the shortName in the message', async () => {
    const fakeFetch = vi.fn(async () => jsonRes({ error: 'taken' }, 403)) as unknown as typeof fetch
    await expect(
      finalizePublish('a'.repeat(64), {
        apiUrl: API,
        sessionToken: TOKEN,
        rootTree: ROOT_TREE,
        shortName: 'taken-name',
        fetch: fakeFetch,
      }),
    ).rejects.toMatchObject({ code: 'name_taken' })
  })
})

describe('mapErrorResponse', () => {
  it('produces the documented messages for each status code', async () => {
    const e401 = await mapErrorResponse(jsonRes({}, 401), { context: 'check' })
    expect(e401).toBeInstanceOf(PublishError)
    expect(e401.code).toBe('session_expired')

    const e403 = await mapErrorResponse(jsonRes({}, 403), {
      context: 'publish',
      shortName: 'foo',
    })
    expect(e403.code).toBe('name_taken')
    expect(e403.message).toContain('foo')

    const e413 = await mapErrorResponse(jsonRes({}, 413), {
      context: 'put',
      hash: 'a'.repeat(64),
    })
    expect(e413.code).toBe('too_large')

    const e502 = await mapErrorResponse(jsonRes({}, 502), { context: 'put' })
    expect(e502.code).toBe('backend_down')

    const e400 = await mapErrorResponse(jsonRes({ error: 'bad hash' }, 400), {
      context: 'publish',
    })
    expect(e400.code).toBe('bad_bundle')
    expect(e400.message).toContain('bad hash')

    const e418 = await mapErrorResponse(jsonRes({}, 418), { context: 'check' })
    expect(e418.code).toBe('unknown')
    expect(e418.details?.status).toBe(418)
  })
})
