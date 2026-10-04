/**
 * Tests for the backend zone selection logic. The CLI defaults to
 * prod (api.mythwork.ai + auth.mythwork.ai) and only switches to
 * staging (api.llama.space + auth.llama.space) when --staging is passed.
 *
 * Per spec section "Sample session" and "Backend changes required":
 *   default → api.mythwork.ai / auth.mythwork.ai
 *   --staging → api.llama.space / auth.llama.space
 *   --api or MYTH_API_URL → override
 *   MYTH_AUTH_URL → override auth side independently
 */

import { describe, expect, it } from 'vitest'
import { resolveBackend, formatBytes } from './index.js'

describe('resolveBackend', () => {
  it('defaults to prod when --staging is not set', () => {
    const { apiUrl, authOrigin } = resolveBackend({ env: {} })
    expect(apiUrl).toBe('https://api.mythwork.ai')
    expect(authOrigin).toBe('https://auth.mythwork.ai')
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
    expect(authOrigin).toBe('https://auth.mythwork.ai')
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

describe('resolveBackend appZone', () => {
  it('serves prod apps under myth.work', () => {
    expect(resolveBackend({ env: {} }).appZone).toBe('myth.work')
  })
  it('serves staging apps under llama.space', () => {
    expect(resolveBackend({ staging: true, env: {} }).appZone).toBe('llama.space')
  })
  it('does not follow an --api override', () => {
    expect(resolveBackend({ apiUrl: 'https://api.example.test', env: {} }).appZone).toBe('myth.work')
  })
  it('lets MYTH_APP_ZONE override the app zone', () => {
    expect(resolveBackend({ staging: true, env: { MYTH_APP_ZONE: 'localhost' } }).appZone).toBe('localhost')
  })
})

describe('formatBytes', () => {
  it('formats bytes, KB, and MB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
