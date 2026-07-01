/**
 * Poll /build-status/{tree} after a successful finalize and print lifecycle
 * messages to stdout.
 *
 * Behavior:
 *
 *   endpointUnavailable → silently exit, today's fire-and-forget
 *   none (persists ~10s) → Tier-1/instant path, exit 0 quietly
 *                          (UNLESS the publish was deferred — then keep
 *                          polling: `none` just means the status write
 *                          hasn't propagated yet)
 *   pending (first seen) → print "Building with full compiler… (job <short>)"
 *   ok  → print "Build complete: success" + "App deployed" + URL, exit 0
 *   failed → print "Build failed: <reason>", exit 1
 *   auth lost (401) → print re-auth + re-subscribe hint, exit 0
 *   other stream error → print one-line warning + re-subscribe hint, exit 0
 *   timeout (240s)  → print re-subscribe hint, exit 0
 *   SIGINT          → abort the in-flight fetch/sleep, print detach hint, exit 0
 *
 * All timing + SIGINT registration are injectable so tests can run
 * synchronously with fake clocks. Cancellation is real: an AbortController
 * created per poll is wired into fetch and the inter-poll sleep, so a SIGINT
 * detach settles everything immediately (no hung fetch keeping the process
 * alive, no post-detach status lines).
 */

import { fetchBuildStatus } from './build-status.js'
import type { BuildStatusOptions } from './build-status.js'
import { PublishError, sleep } from './client.js'

export const POLL_INTERVAL_MS = 2_000
export const TOTAL_TIMEOUT_MS = 240_000
/** After this many ms of seeing only "none", treat as Tier-1 and exit. */
export const NONE_TIER1_THRESHOLD_MS = 10_000

export interface PollOptions extends BuildStatusOptions {
  /** Short alias URL to print on success (e.g. "myapp.myth.work"). */
  aliasUrl?: string
  /**
   * True when finalize reported a DEFERRED alias cutover (the new tree goes
   * live only after the Tier-2 build succeeds). Disables the "sustained
   * `none` ⇒ Tier-1, exit quietly" shortcut: with a deferred publish there
   * IS a tracked build, its status write just hasn't propagated yet, so we
   * keep polling until a real status appears or the overall timeout fires.
   */
  deferred?: boolean
  /** Injected sleep for tests; defaults to the shared abortable sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
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
  | 'auth_error'
  | 'stream_error'
  | 'timeout'
  | 'sigint'

export interface PollResult {
  exitCode: 0 | 1
  reason: PollExitReason
}

/** True for a fetch/sleep rejection caused by AbortController.abort(). */
function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

/**
 * Stream build status for `tree`. Returns a PollResult that the caller
 * uses to set the process exit code.
 *
 * Never throws — all errors are captured into the result.
 */
export async function pollBuildStatus(tree: string, opts: PollOptions): Promise<PollResult> {
  const sleepFn = opts.sleep ?? sleep
  const nowFn = opts.now ?? Date.now
  const treeShort = tree.slice(0, 12)
  const resubscribeHint = `myth publish --subscribe ${tree}`

  let printedPending = false
  let firstNoneAt: number | null = null
  const startedAt = nowFn()

  // SIGINT → detach cleanly. Aborting the controller FIRST makes the race
  // deterministic: any in-flight fetch or sleep rejects immediately, and the
  // poll loop returns silently without printing a competing status line.
  const abort = new AbortController()
  const signal = abort.signal
  const detached: PollResult = { exitCode: 0, reason: 'sigint' }
  let installedHandler: (() => void) | null = null
  const sigintPromise = new Promise<PollResult>(resolve => {
    const handler = () => {
      abort.abort()
      process.stdout.write('\n')
      console.log(`[myth] Detached. Re-attach with:  ${resubscribeHint}`)
      resolve(detached)
    }
    if (opts.suppressSigint) {
      // Don't register — caller handles SIGINT externally.
    } else if (opts.registerSigint) {
      opts.registerSigint(handler)
    } else {
      installedHandler = handler
      process.on('SIGINT', handler)
    }
  })

  const pollLoop = async (): Promise<PollResult> => {
    while (true) {
      if (signal.aborted) return detached

      const elapsed = nowFn() - startedAt
      if (elapsed >= TOTAL_TIMEOUT_MS) {
        console.log(
          `[myth] Build may still be running; re-subscribe with:  ${resubscribeHint}`,
        )
        return { exitCode: 0, reason: 'timeout' }
      }

      let result: Awaited<ReturnType<typeof fetchBuildStatus>>
      try {
        result = await fetchBuildStatus(tree, { ...opts, signal })
      } catch (e) {
        // SIGINT already printed the detach hint — return silently.
        if (signal.aborted || isAbortError(e)) return detached
        // The publish itself succeeded; the STATUS STREAM hit a hard error.
        // Never exit silently — say what happened and how to re-attach.
        if (e instanceof PublishError && e.code === 'session_expired') {
          console.log(
            '[myth] ⚠ Publish succeeded, but the session expired while streaming build status.',
          )
          console.log(`[myth]   Sign in again, then re-attach with:  ${resubscribeHint}`)
          return { exitCode: 0, reason: 'auth_error' }
        }
        const msg = e instanceof Error ? e.message : String(e)
        console.log(
          `[myth] ⚠ Build-status stream stopped (${msg}); re-attach with:  ${resubscribeHint}`,
        )
        return { exitCode: 0, reason: 'stream_error' }
      }
      // A fetch that ignored the abort and resolved anyway must not print
      // status lines after "Detached".
      if (signal.aborted) return detached

      if (!result.available) {
        // Genuine endpoint-not-deployed (404 / non-JSON) — the only path
        // allowed to stay quiet (fire-and-forget fallback).
        return { exitCode: 0, reason: 'endpoint_unavailable' }
      }

      const { status, reason } = result

      if (status === 'none') {
        if (firstNoneAt === null) firstNoneAt = nowFn()
        const noneDuration = nowFn() - firstNoneAt
        // Deferred cutover: there IS a tracked build (the alias flips only
        // after it succeeds) — sustained `none` just means the status write
        // hasn't propagated, so never take the Tier-1 shortcut.
        if (!opts.deferred && noneDuration >= NONE_TIER1_THRESHOLD_MS) {
          // Tier-1 instant publish — no tracked build, exit quietly.
          return { exitCode: 0, reason: 'none_tier1' }
        }
        // Keep polling (KV may be catching up).
        try {
          await sleepFn(POLL_INTERVAL_MS, signal)
        } catch {
          return detached
        }
        continue
      }

      // Reset the none-timer if we see any tracked status.
      firstNoneAt = null

      if (status === 'pending') {
        if (!printedPending) {
          printedPending = true
          console.log(`[myth] Building with full compiler… (job ${treeShort})`)
        }
        try {
          await sleepFn(POLL_INTERVAL_MS, signal)
        } catch {
          return detached
        }
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

  // Race the poll loop against SIGINT. After a SIGINT the abort makes the
  // loop's pending fetch/sleep reject immediately, so nothing is left
  // holding the event loop and no contradictory line can print.
  const result = await Promise.race([sigintPromise, pollLoop()])

  // Deregister OUR listener only (process.off, not removeAllListeners —
  // other modules' SIGINT handlers must survive). Listeners added via
  // registerSigint are the caller's concern.
  if (installedHandler) {
    process.off('SIGINT', installedHandler)
  }

  return result
}
