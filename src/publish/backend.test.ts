/**
 * Tests for the backend zone selection logic. The CLI defaults to
 * prod (api.myth.work + auth.myth.work) and only switches to
 * staging (api.llama.space + auth.llama.space) when --staging is passed.
 *
 * Per spec section "Sample session" and "Backend changes required":
 *   default → api.myth.work / auth.myth.work
 *   --staging → api.llama.space / auth.llama.space
 *   --api or MYTH_API_URL → override
 *   MYTH_AUTH_URL → override auth side independently
 */

import { describe, expect, it } from 'vitest'
import { resolveBackend, inferZoneSuffix, formatBytes } from './index.js'

describe('resolveBackend', () => {
  it('defaults to prod when --staging is not set', () => {
    const { apiUrl, authOrigin } = resolveBackend({ env: {} })
    expect(apiUrl).toBe('https://api.myth.work')
    expect(authOrigin).toBe('https://auth.myth.work')
  })

  it('switches to staging when --staging is set', () => {
    const { apiUrl, authOrigin } = resolveBackend({ staging: true, env: {} })
    expect(apiUrl).toBe('https://api.llama.space')
    expect(authOrigin).toBe('https://auth.llama.space')
  })

  it('lets --api override the API URL', () => {
    const { apiUrl, authOrigin } = resolveBackend({
      apiUrl: 'http://localhost:8787',
      env: {},
    })
    expect(apiUrl).toBe('http://localhost:8787')
    // Auth still defaults to prod (no --staging).
    expect(authOrigin).toBe('https://auth.myth.work')
  })

  it('lets MYTH_API_URL override the API URL', () => {
    const { apiUrl } = resolveBackend({ env: { MYTH_API_URL: 'http://test:9999' } })
    expect(apiUrl).toBe('http://test:9999')
  })

  it('--api flag wins over MYTH_API_URL', () => {
    const { apiUrl } = resolveBackend({
      apiUrl: 'http://flag:1111',
      env: { MYTH_API_URL: 'http://env:2222' },
    })
    expect(apiUrl).toBe('http://flag:1111')
  })

  it('lets MYTH_AUTH_URL override the auth origin independently', () => {
    const { apiUrl, authOrigin } = resolveBackend({
      staging: true,
      env: { MYTH_AUTH_URL: 'http://local-auth' },
    })
    expect(apiUrl).toBe('https://api.llama.space')
    expect(authOrigin).toBe('http://local-auth')
  })
})

describe('inferZoneSuffix', () => {
  it('strips the api. prefix to get the serve zone', () => {
    expect(inferZoneSuffix('https://api.myth.work')).toBe('myth.work')
    expect(inferZoneSuffix('https://api.llama.space')).toBe('llama.space')
  })
  it('returns the host unchanged when there is no api. prefix', () => {
    expect(inferZoneSuffix('http://localhost:9999')).toBe('localhost')
  })
  it('falls back to myth.work for an unparseable URL', () => {
    expect(inferZoneSuffix('not a url')).toBe('myth.work')
  })
})

describe('formatBytes', () => {
  it('formats bytes, KB, and MB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
