/**
 * Unit tests for the pre-publish lockfile-drift check. The real npm/pnpm
 * process is never invoked here — `LockfileRunner` is mocked, mirroring
 * the build-orchestrator container's `Runner` injection pattern. A separate
 * gated integration test (lockfile-check.integration.test.ts) exercises the
 * real subprocess against a real fixture.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  checkLockfile,
  detectLockfilePackageManager,
  formatLockfileDriftMessage,
  type LockfileRunner,
} from './lockfile-check.js'

function scaffold(): string {
  return mkdtempSync(path.join(tmpdir(), 'myth-lockfile-'))
}

describe('detectLockfilePackageManager', () => {
  let root: string
  beforeEach(() => {
    root = scaffold()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns null when no lockfile is present', async () => {
    expect(await detectLockfilePackageManager(root)).toBeNull()
  })

  it('returns npm when only package-lock.json is present', async () => {
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    expect(await detectLockfilePackageManager(root)).toBe('npm')
  })

  it('returns pnpm when only pnpm-lock.yaml is present', async () => {
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    expect(await detectLockfilePackageManager(root)).toBe('pnpm')
  })

  it('prefers pnpm when both lockfiles are present (matches container precedence)', async () => {
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    expect(await detectLockfilePackageManager(root)).toBe('pnpm')
  })
})

describe('checkLockfile', () => {
  let root: string
  beforeEach(() => {
    root = scaffold()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('skips (ok: true, skipped: true) when no lockfile is present — never invokes the runner', async () => {
    let called = false
    const runner: LockfileRunner = async () => {
      called = true
    }
    const result = await checkLockfile(root, runner)
    expect(result).toEqual({ skipped: true, ok: true })
    expect(called).toBe(false)
  })

  it('passes silently when the runner resolves (in-sync lockfile), npm', async () => {
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = []
    const runner: LockfileRunner = async (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd })
    }
    const result = await checkLockfile(root, runner)
    expect(result.ok).toBe(true)
    expect(result.skipped).toBe(false)
    expect(result.packageManager).toBe('npm')
    expect(calls).toEqual([{ cmd: 'npm', args: ['ci', '--dry-run'], cwd: root }])
  })

  it('passes silently when the runner resolves (in-sync lockfile), pnpm', async () => {
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = []
    const runner: LockfileRunner = async (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd })
    }
    const result = await checkLockfile(root, runner)
    expect(result.ok).toBe(true)
    expect(result.packageManager).toBe('pnpm')
    expect(calls).toEqual([
      { cmd: 'pnpm', args: ['install', '--frozen-lockfile', '--lockfile-only'], cwd: root },
    ])
  })

  it('fails with the real error text when the runner rejects (out-of-sync lockfile), npm', async () => {
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    const npmError = new Error(
      "npm error code EUSAGE\nnpm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.",
    )
    const runner: LockfileRunner = async () => {
      throw npmError
    }
    const result = await checkLockfile(root, runner)
    expect(result.ok).toBe(false)
    expect(result.skipped).toBe(false)
    expect(result.packageManager).toBe('npm')
    expect(result.errorText).toContain('EUSAGE')
  })

  it('fails with the real error text when the runner rejects (out-of-sync lockfile), pnpm', async () => {
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    const pnpmError = new Error(
      'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json',
    )
    const runner: LockfileRunner = async () => {
      throw pnpmError
    }
    const result = await checkLockfile(root, runner)
    expect(result.ok).toBe(false)
    expect(result.packageManager).toBe('pnpm')
    expect(result.errorText).toContain('ERR_PNPM_OUTDATED_LOCKFILE')
  })

  it('handles a non-Error throw from the runner', async () => {
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    const runner: LockfileRunner = async () => {
      throw 'plain string failure'
    }
    const result = await checkLockfile(root, runner)
    expect(result.ok).toBe(false)
    expect(result.errorText).toBe('plain string failure')
  })
})

describe('formatLockfileDriftMessage', () => {
  it('names npm and suggests npm install', () => {
    const msg = formatLockfileDriftMessage({
      skipped: false,
      ok: false,
      packageManager: 'npm',
      errorText: 'npm error EUSAGE ...',
    })
    expect(msg).toContain('npm install')
    expect(msg).toContain('out of sync')
    expect(msg).toContain('EUSAGE')
  })

  it('names pnpm and suggests pnpm install', () => {
    const msg = formatLockfileDriftMessage({
      skipped: false,
      ok: false,
      packageManager: 'pnpm',
      errorText: 'ERR_PNPM_OUTDATED_LOCKFILE ...',
    })
    expect(msg).toContain('pnpm install')
    expect(msg).toContain('ERR_PNPM_OUTDATED_LOCKFILE')
  })
})
