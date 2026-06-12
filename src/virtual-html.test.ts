import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { generateLocalPid, loadConfigOrThrow, OrbitConfigError } from './virtual-html.js'

describe('loadConfigOrThrow projectId optionality (AGE-78)', () => {
  let root = ''
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('accepts a NAME-ONLY config (no projectId) — no throw, projectId undefined', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'myth-cfg-'))
    await writeFile(path.join(root, 'myth.config.json'), `${JSON.stringify({ name: 'tennis' })}\n`)
    const loaded = loadConfigOrThrow(root)
    expect(loaded.config.name).toBe('tennis')
    expect(loaded.config.projectId).toBeUndefined()
  })

  it('still carries a present projectId through', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'myth-cfg-'))
    await writeFile(path.join(root, 'myth.config.json'), `${JSON.stringify({ name: 'x', projectId: 'p123' })}\n`)
    expect(loadConfigOrThrow(root).config.projectId).toBe('p123')
  })

  it('still throws when no config file exists anywhere up the tree', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'myth-nocfg-'))
    expect(() => loadConfigOrThrow(root)).toThrow(OrbitConfigError)
  })
})

describe('generateLocalPid (shared, AGE-78)', () => {
  it('is a stable 17-char lowercase hex slice of the seed hash', () => {
    const a = generateLocalPid('tennis::/x')
    expect(a).toMatch(/^[a-f0-9]{17}$/)
    expect(generateLocalPid('tennis::/x')).toBe(a) // deterministic
    expect(generateLocalPid('tennis::/y')).not.toBe(a) // seed-sensitive
  })
})
