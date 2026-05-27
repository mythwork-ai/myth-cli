/**
 * Tests for the auth-handshake module. Drives the listener directly via
 * the exported `startCallbackServer` + `waitForCallback` helpers — no
 * real browser involved.
 *
 *   - Valid POST resolves with the captured token.
 *   - Mismatched nonce gets 400 but the listener stays open.
 *   - Wrong method / wrong path gets 404.
 *   - Timeout rejects with HandshakeTimeoutError.
 *   - JWT payload decode extracts sub + email (display only).
 */

import { describe, expect, it, vi } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import {
  HandshakeTimeoutError,
  decodeJwtPayloadSafe,
  startCallbackServer,
  waitForCallback,
} from './auth-handshake.js'

// Helper to mint a JWT-shaped token (NOT signed — the CLI doesn't
// verify, it just decodes the payload for display).
function mintFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.fake-signature`
}

async function post(
  port: number,
  body: unknown,
  pathSuffix = '/cb',
): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathSuffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: res.status, text: await res.text() }
}

describe('decodeJwtPayloadSafe', () => {
  it('extracts sub and email from a well-formed JWT', () => {
    const jwt = mintFakeJwt({ sub: 'user-123', email: 'alice@example.com' })
    const claims = decodeJwtPayloadSafe(jwt)
    expect(claims.sub).toBe('user-123')
    expect(claims.email).toBe('alice@example.com')
  })

  it('returns {} on malformed input', () => {
    // Single-segment garbage → no `.` to split → fewer than 2 parts.
    expect(decodeJwtPayloadSafe('garbage')).toEqual({})
    // Two segments but the payload isn't valid base64 of JSON.
    expect(decodeJwtPayloadSafe('a.!!!')).toEqual({})
    // Two segments where the payload decodes to non-JSON.
    expect(decodeJwtPayloadSafe('a.bm9uc2Vuc2U')).toEqual({})
  })

  it('parses a real-shaped JWT payload', () => {
    const claims = decodeJwtPayloadSafe(mintFakeJwt({ sub: 'u', email: 'e@x.com', extra: 1 }))
    expect(claims.sub).toBe('u')
    expect(claims.email).toBe('e@x.com')
    expect(claims.extra).toBe(1)
  })
})

describe('waitForCallback', () => {
  it('resolves with the captured session token on matching nonce', async () => {
    const { server, port } = await startCallbackServer(0)
    const expectedNonce = 'matching-nonce'
    const token = mintFakeJwt({ sub: 'u-1', email: 'alice@example.com' })

    const resultP = waitForCallback(server, expectedNonce, 2000)

    // Tiny delay to ensure the listener is attached before we POST.
    await delay(10)
    const res = await post(port, {
      sessionToken: token,
      nonce: expectedNonce,
      userEmail: 'alice@example.com',
      userName: 'Alice',
    })
    expect(res.status).toBe(200)

    const result = await resultP
    expect(result.sessionToken).toBe(token)
    expect(result.userEmail).toBe('alice@example.com')
    expect(result.userId).toBe('u-1')
    expect(result.userName).toBe('Alice')

    server.close()
  })

  it('falls back to JWT email when POST body omits userEmail', async () => {
    const { server, port } = await startCallbackServer(0)
    const token = mintFakeJwt({ sub: 'u-2', email: 'bob@example.com' })

    const resultP = waitForCallback(server, 'n', 2000)
    await delay(10)
    await post(port, { sessionToken: token, nonce: 'n' })
    const result = await resultP
    expect(result.userEmail).toBe('bob@example.com')
    expect(result.userId).toBe('u-2')

    server.close()
  })

  it('rejects mismatched nonce with 400 and stays open', async () => {
    const { server, port } = await startCallbackServer(0)
    const resultP = waitForCallback(server, 'right', 2000)

    await delay(10)
    const bad = await post(port, { sessionToken: 'x.y.z', nonce: 'wrong' })
    expect(bad.status).toBe(400)
    expect(bad.text).toBe('bad nonce')

    // Listener still open — POST again with the correct nonce.
    const good = await post(port, {
      sessionToken: mintFakeJwt({ sub: 's' }),
      nonce: 'right',
    })
    expect(good.status).toBe(200)
    const result = await resultP
    expect(result.userId).toBe('s')

    server.close()
  })

  it('returns 404 on wrong method or wrong path', async () => {
    const { server, port } = await startCallbackServer(0)
    const resultP = waitForCallback(server, 'n', 1000).catch(err => err)

    await delay(10)
    const get = await fetch(`http://127.0.0.1:${port}/cb`, { method: 'GET' })
    expect(get.status).toBe(404)
    const wrongPath = await post(port, {}, '/other')
    expect(wrongPath.status).toBe(404)

    // Now finalize with the real callback so the test cleans up cleanly.
    await post(port, { sessionToken: mintFakeJwt({}), nonce: 'n' })
    const result = await resultP
    expect((result as { sessionToken: string }).sessionToken).toBeDefined()

    server.close()
  })

  it('rejects with HandshakeTimeoutError when no callback arrives', async () => {
    const { server } = await startCallbackServer(0)
    const start = Date.now()
    await expect(waitForCallback(server, 'never', 150)).rejects.toBeInstanceOf(
      HandshakeTimeoutError,
    )
    expect(Date.now() - start).toBeGreaterThanOrEqual(140)
    server.close()
  })

  it('rejects empty sessionToken with 400', async () => {
    const { server, port } = await startCallbackServer(0)
    const resultP = waitForCallback(server, 'n', 2000).catch(err => err)

    await delay(10)
    const res = await post(port, { sessionToken: '', nonce: 'n' })
    expect(res.status).toBe(400)
    expect(res.text).toBe('missing sessionToken')

    // Finalize so the listener doesn't leak.
    await post(port, { sessionToken: mintFakeJwt({}), nonce: 'n' })
    await resultP

    server.close()
  })

  // Silence the "unused" warning for vi (kept as part of vitest's
  // suggested import even if we don't currently spy on anything).
  it('imports vi without using it', () => {
    expect(typeof vi.fn).toBe('function')
  })
})
