/**
 * Integration test for the pre-publish lockfile check: exercises the REAL
 * `npm ci --dry-run` / `pnpm install --frozen-lockfile --lockfile-only`
 * subprocess against a real fixture with a deliberately-stale lockfile.
 *
 * The unit tests in lockfile-check.test.ts mock the runner entirely and
 * can't catch a future npm/pnpm release silently changing dry-run/flag
 * behavior (this is exactly the kind of drift the task that created this
 * check was worried about — see lockfile-check.ts's module doc). This test
 * guards that by actually invoking the package managers.
 *
 * Gated behind MYTH_RUN_INTEGRATION_TESTS because it shells out to real
 * npm/pnpm and hits the local package cache/registry resolution — slower
 * and less hermetic than the rest of the (fully mocked) suite, and this
 * repo has no existing slow/integration tag convention to hook into
 * (checked: no vitest project split, no `it.skipIf` precedent). Opt in
 * with:
 *
 *   MYTH_RUN_INTEGRATION_TESTS=1 npm test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkLockfile, realLockfileRunner } from './lockfile-check.js'

const runIntegration = process.env.MYTH_RUN_INTEGRATION_TESTS ? describe : describe.skip

function scaffold(): string {
  return mkdtempSync(path.join(tmpdir(), 'myth-lockfile-integration-'))
}

runIntegration('checkLockfile — real npm subprocess', () => {
  let root: string
  beforeEach(() => {
    root = scaffold()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('passes for an in-sync package-lock.json, without touching node_modules', async () => {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }),
    )
    await realLockfileRunner('npm', ['install', '--package-lock-only', '--ignore-scripts'], root)

    const result = await checkLockfile(root)

    expect(result.ok).toBe(true)
    expect(result.packageManager).toBe('npm')
    expect(existsSync(path.join(root, 'node_modules'))).toBe(false)
  }, 30_000)

  it('fails with the real EUSAGE text for a stale package-lock.json, without mutating anything', async () => {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }),
    )
    await realLockfileRunner('npm', ['install', '--package-lock-only', '--ignore-scripts'], root)
    const lockBefore = readFileSync(path.join(root, 'package-lock.json'), 'utf-8')

    // Bump the dep WITHOUT regenerating the lockfile — the exact incident.
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { 'left-pad': '1.1.0' } }),
    )

    const result = await checkLockfile(root)

    expect(result.ok).toBe(false)
    expect(result.packageManager).toBe('npm')
    expect(result.errorText).toMatch(/EUSAGE|in sync/i)
    expect(existsSync(path.join(root, 'node_modules'))).toBe(false)
    expect(readFileSync(path.join(root, 'package-lock.json'), 'utf-8')).toBe(lockBefore)
  }, 30_000)
})

runIntegration('checkLockfile — real pnpm subprocess', () => {
  let root: string
  beforeEach(() => {
    root = scaffold()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('passes for an in-sync pnpm-lock.yaml, without touching node_modules', async () => {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }),
    )
    await realLockfileRunner('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], root)

    const result = await checkLockfile(root)

    expect(result.ok).toBe(true)
    expect(result.packageManager).toBe('pnpm')
    expect(existsSync(path.join(root, 'node_modules'))).toBe(false)
  }, 30_000)

  it('fails with the real ERR_PNPM_OUTDATED_LOCKFILE text for a stale pnpm-lock.yaml, without mutating anything', async () => {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }),
    )
    await realLockfileRunner('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], root)
    const lockBefore = readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf-8')

    // Bump the dep WITHOUT regenerating the lockfile — the exact incident.
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { 'left-pad': '1.1.0' } }),
    )

    const result = await checkLockfile(root)

    expect(result.ok).toBe(false)
    expect(result.packageManager).toBe('pnpm')
    expect(result.errorText).toMatch(/ERR_PNPM_OUTDATED_LOCKFILE/)
    expect(existsSync(path.join(root, 'node_modules'))).toBe(false)
    expect(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf-8')).toBe(lockBefore)
  }, 30_000)
})
