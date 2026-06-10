import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeSessionCache } from './index.js'

let dir: string
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('writeSessionCache', () => {
  it('creates the cache file owner-only (0600)', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'myth-cache-'))
    const f = path.join(dir, 'session-x.json')
    await writeSessionCache(f, 'tok', 'who')
    expect(((await stat(f)).mode & 0o777).toString(8)).toBe('600')
  })

  it('ENFORCES 0600 when overwriting a pre-existing loose file', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'myth-cache-'))
    const f = path.join(dir, 'session-x.json')
    // Simulate a world-readable leftover (writeFile mode only applies on create).
    await writeFile(f, 'old', { mode: 0o644 })
    expect(((await stat(f)).mode & 0o777).toString(8)).toBe('644')
    await writeSessionCache(f, 'tok', 'who')
    expect(((await stat(f)).mode & 0o777).toString(8)).toBe('600')
  })
})
