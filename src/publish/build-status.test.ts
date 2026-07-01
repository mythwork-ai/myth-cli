/**
 * Tests for the build-status client (GET /build-status/{tree}).
 *
 * All network is mocked via the injected `fetch` option.
 * No real HTTP calls are made.
 */

import { describe, expect, it, vi } from 'vitest'
import { fetchBuildStatus } from './build-status.js'
import { PublishError } from './client.js'

const API = 'https://api.test.example'
const TOKEN = 'fake.jwt.token'
const TREE = 'a'.repeat(64) // 64 hex chars

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function textRes(body: string, status = 200): Response {
  return new Response(body, { status })
}

describe('fetchBuildStatus', () => {
  it('parses a status=ok response and returns available:true', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonRes({ tree: TREE, builderVersion: 'v1', status: 'ok' }),
    ) as unknown as typeof fetch

    const result = await fetchBuildStatus(TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch })

    expect(result).toEqual({
      available: true,
      status: 'ok',
      reason: undefined,
      builderVersion: 'v1',
    })
  })

  it('parses a status=pending response', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonRes({ tree: TREE, builderVersion: 'v2', status: 'pending' }),
    ) as unknown as typeof fetch

    const result = await fetchBuildStatus(TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch })

    expect(result).toEqual({
      available: true,
      status: 'pending',
      reason: undefined,
      builderVersion: 'v2',
    })
  })

  it('parses a status=failed response with reason', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonRes({ tree: TREE, builderVersion: 'v1', status: 'failed', reason: 'SyntaxError in App.tsx' }),
    ) as unknown as typeof fetch

    const result = await fetchBuildStatus(TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch })

    expect(result).toEqual({
      available: true,
      status: 'failed',
      reason: 'SyntaxError in App.tsx',
      builderVersion: 'v1',
    })
  })

  it('parses a status=none response', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonRes({ tree: TREE, builderVersion: 'v1', status: 'none' }),
    ) as unknown as typeof fetch

    const result = await fetchBuildStatus(TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch })

    expect(result).toEqual({
      available: true,
      status: 'none',
      reason: undefined,
      builderVersion: 'v1',
    })
  })

  it('treats a 404 as endpoint unavailable', async () => {
    const fakeFetch = vi.fn(async () => textRes('Not Found', 404)) as unknown as typeof fetch

    const result = await fetchBuildStatus(TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch })

    expect(result).toEqual({ available: false })
  })

  it('treats a 500 server error as endpoint unavailable', async () => {
    const fakeFetch = vi.fn(async () => textRes('Internal Server Error', 500)) as unknown as typeof fetch

    const result = await fetchBuildStatus(TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch })

    expect(result).toEqual({ available: false })
  })

  it('treats garbage / non-JSON response body as endpoint unavailable', async () => {
    const fakeFetch = vi.fn(async () => textRes('not json at all', 200)) as unknown as typeof fetch

    const result = await fetchBuildStatus(TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch })

    expect(result).toEqual({ available: false })
  })

  it('treats a 200 response missing the status field as endpoint unavailable', async () => {
    const fakeFetch = vi.fn(async () => jsonRes({ tree: TREE })) as unknown as typeof fetch

    const result = await fetchBuildStatus(TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch })

    expect(result).toEqual({ available: false })
  })

  it('treats a 200 with an unknown status value as endpoint unavailable', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonRes({ tree: TREE, builderVersion: 'v1', status: 'building' }),
    ) as unknown as typeof fetch

    const result = await fetchBuildStatus(TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch })

    expect(result).toEqual({ available: false })
  })

  it('sends an Authorization: Bearer header', async () => {
    let capturedHeaders: Headers | undefined
    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers)
      return jsonRes({ tree: TREE, builderVersion: 'v1', status: 'ok' })
    }) as unknown as typeof fetch

    await fetchBuildStatus(TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch })

    expect(capturedHeaders?.get('Authorization')).toBe(`Bearer ${TOKEN}`)
  })

  it('sends GET to the correct URL', async () => {
    let capturedUrl: string | undefined
    let capturedMethod: string | undefined
    const fakeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedMethod = init?.method
      return jsonRes({ tree: TREE, builderVersion: 'v1', status: 'ok' })
    }) as unknown as typeof fetch

    await fetchBuildStatus(TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch })

    expect(capturedUrl).toBe(`${API}/build-status/${TREE}`)
    expect(capturedMethod).toBe('GET')
  })

  it('throws PublishError(session_expired) on 401', async () => {
    const fakeFetch = vi.fn(async () => jsonRes({ error: 'Unauthorized' }, 401)) as unknown as typeof fetch

    await expect(
      fetchBuildStatus(TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch }),
    ).rejects.toMatchObject({ code: 'session_expired' })
  })

  it('throws PublishError(bad_bundle) on 400', async () => {
    const fakeFetch = vi.fn(async () => jsonRes({ error: 'bad tree' }, 400)) as unknown as typeof fetch

    await expect(
      fetchBuildStatus(TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch }),
    ).rejects.toMatchObject({ code: 'bad_bundle' })
  })

  it('treats a network error as endpoint unavailable', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    const result = await fetchBuildStatus(TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch })
    expect(result).toEqual({ available: false })
  })

  it('uses a missing builderVersion field gracefully', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonRes({ tree: TREE, status: 'pending' }),
    ) as unknown as typeof fetch

    const result = await fetchBuildStatus(TREE, { apiUrl: API, sessionToken: TOKEN, fetch: fakeFetch })
    expect(result).toEqual({
      available: true,
      status: 'pending',
      reason: undefined,
      builderVersion: 'unknown',
    })
  })
})
