/**
 * Fast, local, pre-publish lockfile-drift check.
 *
 * Background: the server-side Tier-2 build container (mythwork's
 * build-orchestrator) runs `npm ci --ignore-scripts` (or
 * `pnpm install --frozen-lockfile --ignore-scripts` when `pnpm-lock.yaml` is
 * present) before `vite build`. When a `package.json` dependency bump ships
 * without a regenerated lockfile, that server-side install fails and the
 * build is marked `no_lockfile` — but the developer only learns this minutes
 * later, after packaging + upload + finalize + a queued build round-trip.
 *
 * This check reproduces the SAME install command locally, in a read-only
 * mode, before any packaging/upload begins, so lockfile drift is caught in
 * well under a second instead of minutes.
 *
 * Scope (deliberately conservative — see `checkLockfile` below): only runs
 * when a lockfile is already present. There is no local (or server-side)
 * signal that distinguishes a "Tier-2 app" from a "Tier-1 app" before
 * publish — tier is an ops-written property of the project on the server
 * (`project_app_config`) — so this check applies to any project with a
 * lockfile, Tier-1 or Tier-2. That's safe: a Tier-1 app with a lockfile that
 * happens to be out of sync is *also* worth flagging, and a project with no
 * lockfile at all is skipped rather than guessed at.
 */

import { access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type LockfilePackageManager = 'pnpm' | 'npm'

/** A process runner. Injected so unit tests never spawn real processes.
 *  Mirrors the `Runner` type in the build-orchestrator container. */
export type LockfileRunner = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<void>

export interface LockfileCheckResult {
  /** True when no lockfile exists — the check was skipped entirely. */
  skipped: boolean
  /** True when a lockfile exists and is in sync (or the check was skipped). */
  ok: boolean
  packageManager?: LockfilePackageManager
  /** The real npm/pnpm error text, present only when `ok` is false. */
  errorText?: string
}

/**
 * Which package manager to check, by lockfile presence in `root`. pnpm wins
 * if both are present — same precedence as the container's
 * `detectPackageManager` (pnpm-lock.yaml is the platform default). Returns
 * null when neither lockfile exists.
 */
export async function detectLockfilePackageManager(
  root: string,
): Promise<LockfilePackageManager | null> {
  const has = async (f: string): Promise<boolean> => {
    try {
      await access(join(root, f))
      return true
    } catch {
      return false
    }
  }
  if (await has('pnpm-lock.yaml')) return 'pnpm'
  if (await has('package-lock.json')) return 'npm'
  return null
}

/**
 * Production runner: real `execFile`, no shell. Exercised directly by the
 * gated integration test (see lockfile-check.integration.test.ts) against a
 * real fixture, so a future npm/pnpm release silently changing this
 * behavior is caught.
 *
 * On failure, `execFile`'s rejection has a useless bare `.message`
 * ("Command failed: <cmd> <args>") — the actual npm/pnpm diagnostic (npm's
 * EUSAGE text on stderr; pnpm's ERR_PNPM_OUTDATED_LOCKFILE text on stdout)
 * lives on the error's `.stdout`/`.stderr` properties, which `execFile`
 * (unlike a bare `spawn`) attaches even though they aren't part of the
 * `Error` type. Re-throw with those appended so callers — and the
 * developer-facing message this feeds — see the real diagnostic instead of
 * just "Command failed".
 */
export const realLockfileRunner: LockfileRunner = async (cmd, args, cwd) => {
  try {
    await execFileAsync(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 })
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string }
    const detail = [err.stdout, err.stderr].filter(s => s && s.trim()).join('\n')
    throw detail ? new Error(`${err.message}\n${detail}`) : err
  }
}

/**
 * The read-only verification command per package manager. Both are
 * confirmed (against real fixtures) to leave `node_modules` and the
 * lockfile untouched in both the in-sync and out-of-sync case:
 *
 *   npm:  `npm ci --dry-run` — npm's own dry-run mode. Exits 0 silently
 *         when in sync; exits non-zero with the real EUSAGE "can only
 *         install ... in sync" text on drift.
 *
 *   pnpm: `pnpm install --frozen-lockfile --lockfile-only` — pnpm has NO
 *         `--dry-run` flag for `install` (confirmed against pnpm 11.2.2: it
 *         hard-errors "Unknown option: 'dry-run'" unconditionally, which
 *         would false-positive-block every pnpm project). `--lockfile-only`
 *         is the side-effect-free substitute: combined with
 *         `--frozen-lockfile` it performs the same up-to-date check and
 *         fails with the real `ERR_PNPM_OUTDATED_LOCKFILE` message on
 *         drift, but never writes to `node_modules`. Confirmed it also
 *         does not rewrite the lockfile in the passing case (frozen-lockfile
 *         forbids that by definition).
 */
function checkCommand(pm: LockfilePackageManager): { cmd: string; args: string[] } {
  if (pm === 'npm') return { cmd: 'npm', args: ['ci', '--dry-run'] }
  return { cmd: 'pnpm', args: ['install', '--frozen-lockfile', '--lockfile-only'] }
}

/**
 * Run the pre-publish lockfile check. Skips (returns `{ skipped: true, ok:
 * true }`) when no lockfile is present at `root` — see the module doc for
 * why that's the conservative choice. Never mutates `node_modules` or the
 * lockfile.
 */
export async function checkLockfile(
  root: string,
  runner: LockfileRunner = realLockfileRunner,
): Promise<LockfileCheckResult> {
  const pm = await detectLockfilePackageManager(root)
  if (pm === null) return { skipped: true, ok: true }

  const { cmd, args } = checkCommand(pm)
  try {
    await runner(cmd, args, root)
    return { skipped: false, ok: true, packageManager: pm }
  } catch (e) {
    const errorText = e instanceof Error ? e.message : String(e)
    return { skipped: false, ok: false, packageManager: pm, errorText }
  }
}

/**
 * Format the actionable failure message printed to the developer when
 * `checkLockfile` fails. States the mismatch, shows the real npm/pnpm error,
 * and says exactly how to fix it.
 */
export function formatLockfileDriftMessage(result: LockfileCheckResult): string {
  const pm = result.packageManager
  const fixCmd = pm === 'pnpm' ? 'pnpm install' : 'npm install'
  return (
    `package.json and your lockfile are out of sync` +
    (pm ? ` (${pm})` : '') +
    `. The server-side build would fail the same way. Run \`${fixCmd}\` to ` +
    `regenerate the lockfile, then commit it, and publish again.\n\n${result.errorText ?? ''}`
  )
}
