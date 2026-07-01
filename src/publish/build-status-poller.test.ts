/**
 * Tests for the build-status poll loop (pollBuildStatus).
 *
 * All timing is injected (fake clock + instant sleep) and all network is
 * mocked via the injected `fetch` option. No real timers or HTTP.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  NONE_TIER1_THRESHOLD_MS,
  POLL_INTERVAL_MS,
  TOTAL_TIMEOUT_MS,
  pollBuildStatus,
} from './build-status-poller.js'

const API = 'https://api.test.example'
const TOKEN = 'fake.jwt'
const TREE = 'b'.repeat(64)

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Build a fake fetch that returns statuses in sequence (then repeats the last). */
function makeFakeFetch(statuses: Array<{ status: string; reason?: string }>): typeof fetch {
  let i = 0
  return vi.fn(async () => {
    const s = statuses[Math.min(i++, statuses.length - 1)]!
    return jsonRes({ tree: TREE, builderVersion: 'v1', status: s.status, reason: s.reason })
  }) as unknown as typeof fetch
}

/** Returns a fake clock advancing by `step` on each call. */
function makeFakeClock(step: number): () => number {
  let t = 0
  return () => (t += step)
}

/** Instant sleep (no actual delay). */
const instantSleep = () => Promise.resolve()

/** Suppress SIGINT in tests (don't bind process signals). */
const suppressSigint = true

describe('pollBuildStatus — pending → ok', () => {
  it('prints Building on first pending, then Build complete: success + App deployed on ok; exits 0', async () => {
    const consoleLogs: string[] = []
    vi.spyOn(console, 'log').mockImplementation(msg => consoleLogs.push(msg as string))

    const result = await pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      aliasUrl: 'myapp.myth.work',
      fetch: makeFakeFetch([
        { status: 'pending' },
        { status: 'pending' },
        { status: 'ok' },
      ]),
      sleep: instantSleep,
      now: makeFakeClock(POLL_INTERVAL_MS),
      suppressSigint,
    })

    expect(result).toEqual({ exitCode: 0, reason: 'ok' })
    expect(consoleLogs.some(l => l.includes('Building with full compiler'))).toBe(true)
    expect(consoleLogs.some(l => l.includes(TREE.slice(0, 12)))).toBe(true)
    expect(consoleLogs.some(l => l.includes('Build complete: success'))).toBe(true)
    expect(consoleLogs.some(l => l.includes('App deployed'))).toBe(true)
    expect(consoleLogs.some(l => l.includes('myapp.myth.work'))).toBe(true)

    vi.restoreAllMocks()
  })

  it('prints Building only once even with multiple pending polls', async () => {
    const consoleLogs: string[] = []
    vi.spyOn(console, 'log').mockImplementation(msg => consoleLogs.push(msg as string))

    await pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      fetch: makeFakeFetch([
        { status: 'pending' },
        { status: 'pending' },
        { status: 'pending' },
        { status: 'ok' },
      ]),
      sleep: instantSleep,
      now: makeFakeClock(POLL_INTERVAL_MS),
      suppressSigint,
    })

    const buildingCount = consoleLogs.filter(l => l.includes('Building with full compiler')).length
    expect(buildingCount).toBe(1)

    vi.restoreAllMocks()
  })
})

describe('pollBuildStatus — pending → failed', () => {
  it('prints Build failed with reason and exits 1', async () => {
    const consoleLogs: string[] = []
    vi.spyOn(console, 'log').mockImplementation(msg => consoleLogs.push(msg as string))

    const result = await pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      fetch: makeFakeFetch([
        { status: 'pending' },
        { status: 'failed', reason: 'SyntaxError: unexpected token' },
      ]),
      sleep: instantSleep,
      now: makeFakeClock(POLL_INTERVAL_MS),
      suppressSigint,
    })

    expect(result).toEqual({ exitCode: 1, reason: 'failed' })
    expect(consoleLogs.some(l => l.includes('Build failed: SyntaxError: unexpected token'))).toBe(true)

    vi.restoreAllMocks()
  })

  it('prints Build failed (without reason) when reason is absent', async () => {
    const consoleLogs: string[] = []
    vi.spyOn(console, 'log').mockImplementation(msg => consoleLogs.push(msg as string))

    const result = await pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      fetch: makeFakeFetch([{ status: 'failed' }]),
      sleep: instantSleep,
      now: makeFakeClock(POLL_INTERVAL_MS),
      suppressSigint,
    })

    expect(result).toEqual({ exitCode: 1, reason: 'failed' })
    expect(consoleLogs.some(l => l.includes('Build failed'))).toBe(true)

    vi.restoreAllMocks()
  })
})

describe('pollBuildStatus — none for 10s → Tier-1 exit', () => {
  it('exits 0 quietly after seeing none for >= NONE_TIER1_THRESHOLD_MS', async () => {
    const consoleLogs: string[] = []
    vi.spyOn(console, 'log').mockImplementation(msg => consoleLogs.push(msg as string))

    // Each poll step() call advances by POLL_INTERVAL_MS.
    // After NONE_TIER1_THRESHOLD_MS / POLL_INTERVAL_MS polls the threshold is met.
    const result = await pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      fetch: makeFakeFetch([{ status: 'none' }]),
      sleep: instantSleep,
      now: makeFakeClock(POLL_INTERVAL_MS),
      suppressSigint,
    })

    expect(result).toEqual({ exitCode: 0, reason: 'none_tier1' })
    // Should print nothing extra (no Building, no App deployed)
    expect(consoleLogs.filter(l => l.includes('[myth]')).some(l =>
      l.includes('Building') || l.includes('deployed') || l.includes('failed'),
    )).toBe(false)

    vi.restoreAllMocks()
  })
})

describe('pollBuildStatus — endpointUnavailable → fire-and-forget', () => {
  it('returns endpoint_unavailable and exits 0 on 404 from the status endpoint', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response('Not Found', { status: 404 }),
    ) as unknown as typeof fetch

    const result = await pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      fetch: fakeFetch,
      sleep: instantSleep,
      now: makeFakeClock(POLL_INTERVAL_MS),
      suppressSigint,
    })

    expect(result).toEqual({ exitCode: 0, reason: 'endpoint_unavailable' })
  })

  it('returns endpoint_unavailable on garbage response body', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response('not json', { status: 200 }),
    ) as unknown as typeof fetch

    const result = await pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      fetch: fakeFetch,
      sleep: instantSleep,
      now: makeFakeClock(POLL_INTERVAL_MS),
      suppressSigint,
    })

    expect(result).toEqual({ exitCode: 0, reason: 'endpoint_unavailable' })
  })
})

describe('pollBuildStatus — timeout', () => {
  it('prints re-subscribe hint and exits 0 when total time exceeds TOTAL_TIMEOUT_MS', async () => {
    const consoleLogs: string[] = []
    vi.spyOn(console, 'log').mockImplementation(msg => consoleLogs.push(msg as string))

    // Clock advances fast: each "tick" = TOTAL_TIMEOUT_MS so timeout fires immediately.
    const result = await pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      fetch: makeFakeFetch([{ status: 'pending' }]),
      sleep: instantSleep,
      now: makeFakeClock(TOTAL_TIMEOUT_MS),
      suppressSigint,
    })

    expect(result).toEqual({ exitCode: 0, reason: 'timeout' })
    expect(consoleLogs.some(l => l.includes('re-subscribe'))).toBe(true)
    expect(consoleLogs.some(l => l.includes(`myth publish --subscribe ${TREE}`))).toBe(true)

    vi.restoreAllMocks()
  })
})

describe('pollBuildStatus — SIGINT detach', () => {
  it('exits 0 and prints detach hint when SIGINT is fired', async () => {
    const consoleLogs: string[] = []
    vi.spyOn(console, 'log').mockImplementation(msg => consoleLogs.push(msg as string))
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    let capturedHandler: (() => void) | undefined
    const registerSigint = (h: () => void) => { capturedHandler = h }

    // Start a poll that would keep running forever on "pending"
    const pollPromise = pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      fetch: makeFakeFetch([{ status: 'pending' }]),
      // Sleep that fires the SIGINT after one iteration
      sleep: async () => {
        if (capturedHandler) capturedHandler()
      },
      now: makeFakeClock(POLL_INTERVAL_MS),
      registerSigint,
    })

    const result = await pollPromise

    expect(result).toEqual({ exitCode: 0, reason: 'sigint' })
    expect(consoleLogs.some(l => l.includes('Detached. Re-attach with'))).toBe(true)
    expect(consoleLogs.some(l => l.includes(`myth publish --subscribe ${TREE}`))).toBe(true)

    vi.restoreAllMocks()
  })
})

describe('pollBuildStatus — aliasUrl in ok message', () => {
  it('includes the alias URL when provided', async () => {
    const consoleLogs: string[] = []
    vi.spyOn(console, 'log').mockImplementation(msg => consoleLogs.push(msg as string))

    await pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      aliasUrl: 'demo.myth.work',
      fetch: makeFakeFetch([{ status: 'ok' }]),
      sleep: instantSleep,
      now: makeFakeClock(POLL_INTERVAL_MS),
      suppressSigint,
    })

    expect(consoleLogs.some(l => l.includes('https://demo.myth.work'))).toBe(true)

    vi.restoreAllMocks()
  })

  it('prints App deployed (no URL) when aliasUrl is not provided', async () => {
    const consoleLogs: string[] = []
    vi.spyOn(console, 'log').mockImplementation(msg => consoleLogs.push(msg as string))

    await pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      fetch: makeFakeFetch([{ status: 'ok' }]),
      sleep: instantSleep,
      now: makeFakeClock(POLL_INTERVAL_MS),
      suppressSigint,
    })

    expect(consoleLogs.some(l => l === '[myth] App deployed')).toBe(true)

    vi.restoreAllMocks()
  })
})
