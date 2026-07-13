/**
 * Tests for the pack-download HTTP layer (`myth pull`'s read-direction
 * sibling of pack-upload.ts). The `fetch` boundary is mocked — we never hit
 * a real backend. Assertions cover:
 *
 *   - Success path issues GET to the right URL with the right Authorization
 *     header, and decodes a real OCPK pack back into its original entries.
 *   - 401/403/404/413/5xx map to the documented PublishError codes.
 *   - A structurally malformed 200 response (bad OCPK framing) maps to
 *     PublishError('corrupt_pack', ...) regardless of status.
 *   - maxEntries/maxBytes caps are enforced and also surface as corrupt_pack.
 */

import { describe, expect, it, vi } from 'vitest'
import { encodePack } from './pack-codec.js'
import { fetchObjectPack } from './pack-download.js'
import { PublishError } from './client.js'

const TOKEN = 'fake.session.jwt'
const API = 'https://api.test.example'
const ROOT_TREE = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('fetchObjectPack', () => {
  it('success path: issues GET to {apiUrl}/publish/pack/{rootTree} with Bearer token', async () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([4, 5, 6, 7])
    const pack = encodePack([a, b])

    const calls: { url: string; method: string; auth: string | null }[] = []
    const fakeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        auth: headers.get('Authorization'),
      })
      return new Response(pack as unknown as BodyInit, { status: 200 })
    }) as unknown as typeof fetch

    const entries = await fetchObjectPack(ROOT_TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${API}/publish/pack/${ROOT_TREE}`)
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`)
    expect(entries).toHaveLength(2)
    expect(Array.from(entries[0]!)).toEqual(Array.from(a))
    expect(Array.from(entries[1]!)).toEqual(Array.from(b))
  })

  it('returns an empty array for a pack with zero entries', async () => {
    const pack = encodePack([])
    const fakeFetch = vi.fn(async () => new Response(pack as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch

    const entries = await fetchObjectPack(ROOT_TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch })
    expect(entries).toHaveLength(0)
  })

  it('maps 401 to session_expired', async () => {
    const fakeFetch = vi.fn(async () => jsonRes({}, 401)) as unknown as typeof fetch
    await expect(
      fetchObjectPack(ROOT_TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch }),
    ).rejects.toMatchObject({ code: 'session_expired' })
  })

  it('maps 403 to not_owner', async () => {
    const fakeFetch = vi.fn(async () => jsonRes({}, 403)) as unknown as typeof fetch
    await expect(
      fetchObjectPack(ROOT_TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch }),
    ).rejects.toMatchObject({ code: 'not_owner' })
  })

  it('maps 404 to not_found', async () => {
    const fakeFetch = vi.fn(async () => jsonRes({}, 404)) as unknown as typeof fetch
    await expect(
      fetchObjectPack(ROOT_TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('maps 413 to too_large with a non-transient-sounding message', async () => {
    const fakeFetch = vi.fn(async () => jsonRes({}, 413)) as unknown as typeof fetch
    await expect(
      fetchObjectPack(ROOT_TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch }),
    ).rejects.toMatchObject({ code: 'too_large', message: expect.stringContaining('too large') })
  })

  it('maps 502/503/504 to backend_down', async () => {
    for (const status of [502, 503, 504]) {
      const fakeFetch = vi.fn(async () => new Response('bad gateway', { status })) as unknown as typeof fetch
      await expect(
        fetchObjectPack(ROOT_TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch }),
      ).rejects.toMatchObject({ code: 'backend_down' })
    }
  })

  it('maps unknown status to unknown code', async () => {
    const fakeFetch = vi.fn(async () => new Response('teapot', { status: 418 })) as unknown as typeof fetch
    await expect(
      fetchObjectPack(ROOT_TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch }),
    ).rejects.toMatchObject({ code: 'unknown', message: expect.stringContaining('418') })
  })

  it('wraps a structurally malformed 200 response as corrupt_pack', async () => {
    const badMagic = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x01, 0x00])
    const fakeFetch = vi.fn(async () => new Response(badMagic as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch
    await expect(
      fetchObjectPack(ROOT_TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch }),
    ).rejects.toMatchObject({ code: 'corrupt_pack' })
  })

  it('is an instance of PublishError on a malformed pack', async () => {
    const badMagic = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x01, 0x00])
    const fakeFetch = vi.fn(async () => new Response(badMagic as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch
    try {
      await fetchObjectPack(ROOT_TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PublishError)
    }
  })

  it('enforces a caller-supplied maxEntries cap as corrupt_pack', async () => {
    const pack = encodePack([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])])
    const fakeFetch = vi.fn(async () => new Response(pack as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch
    await expect(
      fetchObjectPack(ROOT_TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch, maxEntries: 2 }),
    ).rejects.toMatchObject({ code: 'corrupt_pack' })
  })

  it('enforces a caller-supplied maxBytes cap as corrupt_pack', async () => {
    const pack = encodePack([new Uint8Array(100), new Uint8Array(100), new Uint8Array(100)])
    const fakeFetch = vi.fn(async () => new Response(pack as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch
    await expect(
      fetchObjectPack(ROOT_TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch, maxBytes: 250 }),
    ).rejects.toMatchObject({ code: 'corrupt_pack' })
  })
})
