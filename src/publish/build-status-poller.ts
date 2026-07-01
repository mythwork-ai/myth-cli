/**
 * Poll /build-status/{tree} after a successful finalize and print lifecycle
 * messages to stdout.
 *
 * Behavior:
 *
 *   endpointUnavailable → silently exit, today's fire-and-forget
 *   none (persists ~10s) → Tier-1/instant path, exit 0 quietly
 *   pending (first seen) → print "Building with full compiler… (job <short>)"
 *   ok  → print "Build complete: success" + "App deployed" + URL, exit 0
 *   failed → print "Build failed: <reason>", exit 1
 *   timeout (240s)  → print re-subscribe hint, exit 0
 *   SIGINT          → print detach hint, exit 0
 *
 * All timing + SIGINT registration are injectable so tests can run
 * synchronously with fake clocks.
 */

import { fetchBuildStatus } from './build-status.js'
import type { BuildStatusOptions } from './build-status.js'

export const POLL_INTERVAL_MS = 2_000
export const TOTAL_TIMEOUT_MS = 240_000
/** After this many ms of seeing only "none", treat as Tier-1 and exit. */
export const NONE_TIER1_THRESHOLD_MS = 10_000

export interface PollOptions extends BuildStatusOptions {
  /** Short alias URL to print on success (e.g. "myapp.myth.work"). */
  aliasUrl?: string
  /** Injected sleep for tests; defaults to real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>
  /** Injected wall-clock for tests; defaults to Date.now. */
  now?: () => number
  /**
   * Called once with the SIGINT handler so tests can fire it.
   * Defaults to process.on('SIGINT', handler).
   */
  registerSigint?: (handler: () => void) => void
  /**
   * When true, print the SIGINT/detach hint instead of registering a
   * process signal. Useful when SIGINT isn't testable (non-TTY env).
   */
  suppressSigint?: boolean
}

export type PollExitReason =
  | 'ok'
  | 'failed'
  | 'none_tier1'
  | 'endpoint_unavailable'
  | 'timeout'
  | 'sigint'

export interface PollResult {
  exitCode: 0 | 1
  reason: PollExitReason
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Stream build status for `tree`. Returns a PollResult that the caller
 * uses to set the process exit code.
 *
 * Never throws — all errors are captured into the result.
 */
export async function pollBuildStatus(tree: string, opts: PollOptions): Promise<PollResult> {
  const sleepFn = opts.sleep ?? defaultSleep
  const nowFn = opts.now ?? Date.now
  const treeShort = tree.slice(0, 12)

  let printedPending = false
  let firstNoneAt: number | null = null
  const startedAt = nowFn()

  // SIGINT → detach cleanly.
  let sigintFired = false
  const sigintPromise = new Promise<PollResult>(resolve => {
    const handler = () => {
      sigintFired = true
      process.stdout.write('\n')
      console.log(`[myth] Detached. Re-attach with:  myth publish --subscribe ${tree}`)
      resolve({ exitCode: 0, reason: 'sigint' })
    }
    if (opts.suppressSigint) {
      // Don't register — caller handles SIGINT externally.
    } else if (opts.registerSigint) {
      opts.registerSigint(handler)
    } else {
      process.on('SIGINT', handler)
    }
  })

  const pollLoop = async (): Promise<PollResult> => {
    while (true) {
      if (sigintFired) return { exitCode: 0, reason: 'sigint' }

      const elapsed = nowFn() - startedAt
      if (elapsed >= TOTAL_TIMEOUT_MS) {
        console.log(
          `[myth] Build may still be running; re-subscribe with:  myth publish --subscribe ${tree}`,
        )
        return { exitCode: 0, reason: 'timeout' }
      }

      let result: Awaited<ReturnType<typeof fetchBuildStatus>>
      try {
        result = await fetchBuildStatus(tree, opts)
      } catch {
        // fetchBuildStatus only throws for hard auth errors; surface them
        // as fire-and-forget (caller already printed Published).
        return { exitCode: 0, reason: 'endpoint_unavailable' }
      }

      if (!result.available) {
        return { exitCode: 0, reason: 'endpoint_unavailable' }
      }

      const { status, reason } = result

      if (status === 'none') {
        if (firstNoneAt === null) firstNoneAt = nowFn()
        const noneDuration = nowFn() - firstNoneAt
        if (noneDuration >= NONE_TIER1_THRESHOLD_MS) {
          // Tier-1 instant publish — no tracked build, exit quietly.
          return { exitCode: 0, reason: 'none_tier1' }
        }
        // Still within the grace window; keep polling (KV may be catching up).
        await sleepFn(POLL_INTERVAL_MS)
        continue
      }

      // Reset the none-timer if we see any tracked status.
      firstNoneAt = null

      if (status === 'pending') {
        if (!printedPending) {
          printedPending = true
          console.log(`[myth] Building with full compiler… (job ${treeShort})`)
        }
        await sleepFn(POLL_INTERVAL_MS)
        continue
      }

      if (status === 'ok') {
        console.log('[myth] Build complete: success')
        if (opts.aliasUrl) {
          console.log(`[myth] App deployed:  https://${opts.aliasUrl}`)
        } else {
          console.log('[myth] App deployed')
        }
        return { exitCode: 0, reason: 'ok' }
      }

      if (status === 'failed') {
        const msg = reason ? `Build failed: ${reason}` : 'Build failed'
        console.log(`[myth] ${msg}`)
        return { exitCode: 1, reason: 'failed' }
      }

      // Unknown status — treat as not available.
      return { exitCode: 0, reason: 'endpoint_unavailable' }
    }
  }

  // Race the poll loop against SIGINT.
  const result = await Promise.race([sigintPromise, pollLoop()])

  // Deregister our listener so the process can exit cleanly.
  // (We can't remove a listener added via registerSigint — that's the
  // caller's concern; for the real process.on path we remove it ourselves.)
  if (!opts.registerSigint && !opts.suppressSigint) {
    process.removeAllListeners('SIGINT')
  }

  return result
}
