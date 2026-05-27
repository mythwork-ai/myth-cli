/**
 * Unit tests for the git-object builder. Drives `hashDirectory` (the
 * Vite-less subset of `buildAndHash`) against a tmpdir fixture and
 * asserts:
 *
 *   - Every emitted hash is 64-hex lowercase.
 *   - The same input produces deterministic output across runs.
 *   - The commit body decompresses + parses to a tree pointer that
 *     matches the directory's root tree (round-trips through the same
 *     framing the publish worker reads).
 *   - The hash of a leaf blob matches a known git-style SHA-256 of the
 *     framed object.
 */

import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { hashDirectory } from './build-objects.js'

const HEX_64 = /^[0-9a-f]{64}$/

async function makeFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'myth-publish-build-'))
  await writeFile(path.join(root, 'index.html'), '<!doctype html><h1>Hello</h1>\n')
  await mkdir(path.join(root, 'assets'))
  await writeFile(path.join(root, 'assets', 'app.js'), 'console.log("hi")\n')
  await writeFile(path.join(root, 'assets', 'style.css'), 'body { color: red; }\n')
  return root
}

describe('hashDirectory', () => {
  it('produces 64-hex hashes for every emitted object', async () => {
    const fixture = await makeFixture()
    const result = await hashDirectory(fixture)
    for (const [hash, obj] of result.objects) {
      expect(hash).toMatch(HEX_64)
      expect(obj.hash).toBe(hash)
      expect(obj.deflated.length).toBeGreaterThan(0)
    }
    expect(result.headCommit).toMatch(HEX_64)
    expect(result.rootTree).toMatch(HEX_64)
    // 3 files + 2 dirs (root, assets) + 1 commit = 6
    expect(result.fileCount).toBe(3)
    expect(result.objects.size).toBe(6)
  })

  it('is deterministic across invocations', async () => {
    const fixture = await makeFixture()
    const a = await hashDirectory(fixture)
    const b = await hashDirectory(fixture)
    expect(a.headCommit).toBe(b.headCommit)
    expect(a.rootTree).toBe(b.rootTree)
    expect([...a.objects.keys()].sort()).toEqual([...b.objects.keys()].sort())
  })

  it('emits a commit that parses back to the same root tree', async () => {
    const fixture = await makeFixture()
    const result = await hashDirectory(fixture)
    const commitObj = result.objects.get(result.headCommit)
    expect(commitObj).toBeDefined()
    const inflated = inflateSync(commitObj!.deflated)
    // Strip the framing header: "commit <size>\0".
    const nul = inflated.indexOf(0)
    expect(nul).toBeGreaterThan(0)
    const header = inflated.subarray(0, nul).toString('utf-8')
    expect(header).toMatch(/^commit \d+$/)
    const body = inflated.subarray(nul + 1).toString('utf-8')
    // First line is `tree <root>`.
    const firstLine = body.split('\n')[0]
    expect(firstLine).toBe(`tree ${result.rootTree}`)
  })

  it('hash matches git-style SHA-256 of framed blob (known fixture)', async () => {
    // Hand-compute the expected blob hash for a known content + framing.
    const content = Buffer.from('orbit\n', 'utf-8')
    const framed = Buffer.concat([Buffer.from(`blob ${content.length}\0`, 'utf-8'), content])
    const expectedHash = createHash('sha256').update(framed).digest('hex')

    const root = await mkdtemp(path.join(tmpdir(), 'myth-publish-hash-'))
    await writeFile(path.join(root, 'only.txt'), content)
    const result = await hashDirectory(root)
    // The blob hash should appear in the object map.
    expect(result.objects.has(expectedHash)).toBe(true)
    const blob = result.objects.get(expectedHash)!
    expect(blob.type).toBe('blob')
    // Round-trip: inflate and check the framing.
    const inflated = inflateSync(blob.deflated)
    expect(inflated.equals(framed)).toBe(true)
  })

  it('empty directory still emits a tree + commit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'myth-publish-empty-'))
    const result = await hashDirectory(root)
    // 1 empty tree + 1 commit = 2 objects, 0 files
    expect(result.fileCount).toBe(0)
    expect(result.objects.size).toBe(2)
    expect(result.rootTree).toMatch(HEX_64)
    expect(result.headCommit).toMatch(HEX_64)
  })
})
