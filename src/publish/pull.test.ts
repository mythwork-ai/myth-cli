/**
 * Tests for `myth pull` (pullCommand). The `fetch` boundary is mocked for
 * both new endpoints (GET /publish/site/{name}, GET /publish/pack/{tree}) —
 * we never hit a real backend. Assertions cover:
 *
 *   - Full happy path: real buildObjectsFromFiles/encodePack fixtures land
 *     as the exact expected file tree in a fresh temp directory.
 *   - Succeeds when destDir already exists but is empty (mkdir on an
 *     existing empty dir is a no-op — the non-empty-dir refusal itself is
 *     a bin/myth.ts-layer guard, tested in bin/myth.test.ts).
 *   - MYTH_SESSION_TOKEN bypasses the interactive browser handshake (same
 *     convention as unpublish.test.ts).
 *   - Error propagation: a 404 resolving the site, or a 403 fetching the
 *     pack, both reject with the right PublishError code AND leave the
 *     destination directory untouched (mkdir only happens after both
 *     network calls succeed).
 *   - --staging selects api.llama.space.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildObjectsFromFiles } from './build-objects.js'
import { encodePack } from './pack-codec.js'
import { pullCommand } from './pull.js'

const TOKEN = 'fake.session.jwt'
const PROD_API = 'https://api.myth.work'
const STAGING_API = 'https://api.llama.space'

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe('pullCommand', () => {
  let parentDir: string
  let destDir: string

  beforeEach(async () => {
    parentDir = await mkdtemp(path.join(os.tmpdir(), 'myth-pull-test-'))
    destDir = path.join(parentDir, 'my-app')
    process.env.MYTH_SESSION_TOKEN = TOKEN
  })

  afterEach(async () => {
    delete process.env.MYTH_SESSION_TOKEN
    await rm(parentDir, { recursive: true, force: true })
  })

  it('happy path: reconstructs the exact published file tree into destDir', async () => {
    const enc = new TextEncoder()
    const files = new Map<string, Uint8Array>([
      ['src/main.tsx', enc.encode('export default 1')],
      ['package.json', enc.encode('{"name":"my-app"}')],
    ])
    const built = await buildObjectsFromFiles(files)
    const pack = encodePack([...built.objects.values()].map(o => o.deflated))

    const calls: string[] = []
    const fakeFetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url)
      calls.push(u)
      if (u.includes('/publish/site/')) {
        return jsonRes({ headCommit: built.headCommit, rootTree: built.rootTree, canonical: 'abc123' })
      }
      if (u.includes('/publish/pack/')) {
        return new Response(pack as unknown as BodyInit, { status: 200 })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }) as unknown as typeof fetch

    const result = await pullCommand({ name: 'my-app', destDir, fetch: fakeFetch })

    expect(result.fileCount).toBe(2)
    expect(result.rootTree).toBe(built.rootTree)
    expect(result.canonical).toBe('abc123')
    expect(calls[0]).toBe(`${PROD_API}/publish/site/my-app`)
    expect(calls[1]).toBe(`${PROD_API}/publish/pack/${built.rootTree}`)

    for (const [relPath, expectedBytes] of files) {
      const actual = await readFile(path.join(destDir, ...relPath.split('/')))
      expect(new Uint8Array(actual)).toEqual(expectedBytes)
    }
  })

  it('succeeds when destDir already exists but is empty', async () => {
    await mkdir(destDir, { recursive: true })
    const built = await buildObjectsFromFiles(new Map([['a.txt', new TextEncoder().encode('a')]]))
    const pack = encodePack([...built.objects.values()].map(o => o.deflated))
    const fakeFetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url)
      if (u.includes('/publish/site/')) {
        return jsonRes({ headCommit: built.headCommit, rootTree: built.rootTree, canonical: 'abc123' })
      }
      return new Response(pack as unknown as BodyInit, { status: 200 })
    }) as unknown as typeof fetch

    const result = await pullCommand({ name: 'my-app', destDir, fetch: fakeFetch })
    expect(result.fileCount).toBe(1)
  })

  it('staging: calls staging API URL when staging=true', async () => {
    const built = await buildObjectsFromFiles(new Map([['a.txt', new TextEncoder().encode('a')]]))
    const pack = encodePack([...built.objects.values()].map(o => o.deflated))
    const calls: string[] = []
    const fakeFetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url)
      calls.push(u)
      if (u.includes('/publish/site/')) {
        return jsonRes({ headCommit: built.headCommit, rootTree: built.rootTree, canonical: 'abc123' })
      }
      return new Response(pack as unknown as BodyInit, { status: 200 })
    }) as unknown as typeof fetch

    await pullCommand({ name: 'my-app', destDir, staging: true, fetch: fakeFetch })
    expect(calls[0]).toMatch(new RegExp(`^${STAGING_API}/`))
  })

  it('a 404 resolving the site rejects not_found and never creates destDir', async () => {
    const fakeFetch = vi.fn(async () => jsonRes({}, 404)) as unknown as typeof fetch

    await expect(pullCommand({ name: 'gone', destDir, fetch: fakeFetch })).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(await pathExists(destDir)).toBe(false)
  })

  it('a 403 fetching the pack rejects not_owner and never creates destDir', async () => {
    const fakeFetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url)
      if (u.includes('/publish/site/')) {
        return jsonRes({ headCommit: 'a'.repeat(64), rootTree: 'b'.repeat(64), canonical: 'abc123' })
      }
      return jsonRes({}, 403)
    }) as unknown as typeof fetch

    await expect(pullCommand({ name: 'not-mine', destDir, fetch: fakeFetch })).rejects.toMatchObject({
      code: 'not_owner',
    })
    expect(await pathExists(destDir)).toBe(false)
  })

  it('a 401 resolving the site rejects session_expired', async () => {
    const fakeFetch = vi.fn(async () => jsonRes({}, 401)) as unknown as typeof fetch

    await expect(pullCommand({ name: 'my-app', destDir, fetch: fakeFetch })).rejects.toMatchObject({
      code: 'session_expired',
    })
  })
})
