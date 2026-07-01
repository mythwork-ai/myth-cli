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

describe('pollBuildStatus — hard errors from the status endpoint are surfaced, never silent', () => {
  it('prints the re-auth + re-subscribe hint and exits 0 on a 401 mid-poll', async () => {
    const consoleLogs: string[] = []
    vi.spyOn(console, 'log').mockImplementation(msg => consoleLogs.push(msg as string))

    // First poll: pending (build in progress). Second poll: session expired.
    let call = 0
    const fakeFetch = vi.fn(async () => {
      call++
      if (call === 1) return jsonRes({ tree: TREE, builderVersion: 'v1', status: 'pending' })
      return jsonRes({ error: 'Unauthorized' }, 401)
    }) as unknown as typeof fetch

    const result = await pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      fetch: fakeFetch,
      sleep: instantSleep,
      now: makeFakeClock(POLL_INTERVAL_MS),
      suppressSigint,
    })

    // Exit 0 — the publish itself succeeded — but NEVER silently.
    expect(result).toEqual({ exitCode: 0, reason: 'auth_error' })
    expect(consoleLogs.some(l => l.includes('session expired'))).toBe(true)
    expect(consoleLogs.some(l => l.includes('Publish succeeded'))).toBe(true)
    expect(consoleLogs.some(l => l.includes(`myth publish --subscribe ${TREE}`))).toBe(true)

    vi.restoreAllMocks()
  })

  it('prints a one-line warning with the re-subscribe hint on a non-auth hard error (400)', async () => {
    const consoleLogs: string[] = []
    vi.spyOn(console, 'log').mockImplementation(msg => consoleLogs.push(msg as string))

    const fakeFetch = vi.fn(async () =>
      jsonRes({ error: 'bad tree' }, 400),
    ) as unknown as typeof fetch

    const result = await pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      fetch: fakeFetch,
      sleep: instantSleep,
      now: makeFakeClock(POLL_INTERVAL_MS),
      suppressSigint,
    })

    expect(result).toEqual({ exitCode: 0, reason: 'stream_error' })
    expect(consoleLogs.some(l => l.includes('Build-status stream stopped'))).toBe(true)
    expect(consoleLogs.some(l => l.includes(`myth publish --subscribe ${TREE}`))).toBe(true)

    vi.restoreAllMocks()
  })
})

describe('pollBuildStatus — SIGINT cancellation (abort semantics)', () => {
  it('aborts an in-flight fetch on SIGINT and resolves promptly without extra output', async () => {
    const consoleLogs: string[] = []
    vi.spyOn(console, 'log').mockImplementation(msg => consoleLogs.push(msg as string))
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    let capturedHandler: (() => void) | undefined
    let sawAbort = false
    // A fetch that hangs forever UNLESS its signal aborts (like a stalled
    // connection): only real cancellation can settle it.
    const hangingFetch = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            sawAbort = true
            reject(new DOMException('This operation was aborted', 'AbortError'))
          })
        }),
    ) as unknown as typeof fetch

    const pollPromise = pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      fetch: hangingFetch,
      sleep: instantSleep,
      now: makeFakeClock(POLL_INTERVAL_MS),
      registerSigint: h => {
        capturedHandler = h
      },
    })

    // Let the first fetch start, then detach.
    await new Promise(r => setTimeout(r, 0))
    expect(capturedHandler).toBeDefined()
    capturedHandler!()

    const result = await pollPromise
    expect(result).toEqual({ exitCode: 0, reason: 'sigint' })
    expect(sawAbort).toBe(true)
    expect(consoleLogs.some(l => l.includes('Detached. Re-attach with'))).toBe(true)
    // No status line may follow the detach.
    expect(consoleLogs.some(l => l.includes('Build complete') || l.includes('Build failed'))).toBe(
      false,
    )

    vi.restoreAllMocks()
  })

  it('suppresses status prints when a fetch ignores the abort and resolves AFTER detach', async () => {
    const consoleLogs: string[] = []
    vi.spyOn(console, 'log').mockImplementation(msg => consoleLogs.push(msg as string))
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    let capturedHandler: (() => void) | undefined
    let release!: () => void
    const gate = new Promise<void>(r => {
      release = r
    })
    // Simulates a fetch impl that doesn't honor the signal: it resolves
    // with a terminal "ok" only after the user already detached.
    const fetchIgnoringAbort = vi.fn(async () => {
      await gate
      return jsonRes({ tree: TREE, builderVersion: 'v1', status: 'ok' })
    }) as unknown as typeof fetch

    const pollPromise = pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      fetch: fetchIgnoringAbort,
      sleep: instantSleep,
      now: makeFakeClock(POLL_INTERVAL_MS),
      registerSigint: h => {
        capturedHandler = h
      },
    })

    await new Promise(r => setTimeout(r, 0))
    capturedHandler!() // detach while the fetch is in flight
    release() // now the ignored fetch resolves "ok"

    const result = await pollPromise
    // Give the orphaned loop iteration a tick to (not) print.
    await new Promise(r => setTimeout(r, 0))

    expect(result).toEqual({ exitCode: 0, reason: 'sigint' })
    expect(consoleLogs.some(l => l.includes('Detached. Re-attach with'))).toBe(true)
    // The contradictory post-detach "Build complete" must NOT appear.
    expect(consoleLogs.some(l => l.includes('Build complete'))).toBe(false)
    expect(consoleLogs.some(l => l.includes('App deployed'))).toBe(false)

    vi.restoreAllMocks()
  })

  it('aborts the inter-poll sleep on SIGINT (no timer left holding the process)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    let capturedHandler: (() => void) | undefined
    // Sleep that only settles via its abort signal — a non-abortable
    // implementation would hang this test.
    const abortOnlySleep = (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        )
      })

    const pollPromise = pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      fetch: makeFakeFetch([{ status: 'pending' }]),
      sleep: abortOnlySleep,
      now: makeFakeClock(POLL_INTERVAL_MS),
      registerSigint: h => {
        capturedHandler = h
      },
    })

    await new Promise(r => setTimeout(r, 0))
    capturedHandler!()

    const result = await pollPromise
    expect(result).toEqual({ exitCode: 0, reason: 'sigint' })

    vi.restoreAllMocks()
  })

  it('removes only its own SIGINT listener, leaving unrelated listeners registered', async () => {
    const unrelated = () => {}
    process.on('SIGINT', unrelated)
    const before = process.listeners('SIGINT').length
    try {
      // Default registration path (no registerSigint / suppressSigint) —
      // the poller adds its own process listener and must remove ONLY it.
      const result = await pollBuildStatus(TREE, {
        apiUrl: API,
        sessionToken: TOKEN,
        fetch: makeFakeFetch([{ status: 'ok' }]),
        sleep: instantSleep,
        now: makeFakeClock(POLL_INTERVAL_MS),
      })
      expect(result.reason).toBe('ok')
      const after = process.listeners('SIGINT')
      expect(after).toContain(unrelated)
      expect(after.length).toBe(before)
    } finally {
      process.off('SIGINT', unrelated)
      vi.restoreAllMocks()
    }
  })
})

describe('pollBuildStatus — deferred cutover (finalize returned deferred:true)', () => {
  it('keeps polling through sustained none instead of exiting as Tier-1', async () => {
    const consoleLogs: string[] = []
    vi.spyOn(console, 'log').mockImplementation(msg => consoleLogs.push(msg as string))

    // Far more consecutive "none" polls than the Tier-1 threshold allows,
    // then the real status finally propagates.
    const statuses = [
      ...Array.from({ length: 20 }, () => ({ status: 'none' })),
      { status: 'pending' },
      { status: 'ok' },
    ]
    const result = await pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      deferred: true,
      fetch: makeFakeFetch(statuses),
      sleep: instantSleep,
      now: makeFakeClock(POLL_INTERVAL_MS),
      suppressSigint,
    })

    expect(result).toEqual({ exitCode: 0, reason: 'ok' })
    expect(consoleLogs.some(l => l.includes('Building with full compiler'))).toBe(true)
    expect(consoleLogs.some(l => l.includes('Build complete: success'))).toBe(true)

    vi.restoreAllMocks()
  })

  it('falls through to the overall timeout (with re-subscribe hint) when none never resolves', async () => {
    const consoleLogs: string[] = []
    vi.spyOn(console, 'log').mockImplementation(msg => consoleLogs.push(msg as string))

    const result = await pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      deferred: true,
      fetch: makeFakeFetch([{ status: 'none' }]),
      sleep: instantSleep,
      now: makeFakeClock(POLL_INTERVAL_MS),
      suppressSigint,
    })

    expect(result).toEqual({ exitCode: 0, reason: 'timeout' })
    expect(consoleLogs.some(l => l.includes(`myth publish --subscribe ${TREE}`))).toBe(true)

    vi.restoreAllMocks()
  })

  it('deferred absent/false keeps the old Tier-1 shortcut on sustained none', async () => {
    const result = await pollBuildStatus(TREE, {
      apiUrl: API,
      sessionToken: TOKEN,
      fetch: makeFakeFetch([{ status: 'none' }]),
      sleep: instantSleep,
      now: makeFakeClock(POLL_INTERVAL_MS),
      suppressSigint,
    })
    expect(result).toEqual({ exitCode: 0, reason: 'none_tier1' })
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
