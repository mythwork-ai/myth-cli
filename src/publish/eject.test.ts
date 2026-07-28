/**
 * Tests for `myth eject` (ejectCommand) — the thin client for the server-side
 * eject endpoint. The `fetch` boundary is mocked: the fake backend returns a
 * path-tagged OCPK pack (built here with the same framing the server's
 * `packExport` produces), and assertions run against the real files written
 * into a fresh temp directory. MYTH_SESSION_TOKEN bypasses the browser
 * handshake, same convention as pull.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { encodePack, encodeVarint } from './pack-codec.js'
import { ejectCommand } from './eject.js'

const TOKEN = 'fake.session.jwt'
const PROD_API = 'https://api.myth.work'
const STAGING_API = 'https://api.llama.space'
const enc = new TextEncoder()

/** Mirror of the backend's packExport: each OCPK entry is
 *  varint(pathByteLen) ‖ pathUtf8 ‖ fileBytes. */
function packExport(files: Record<string, Uint8Array>): Uint8Array {
  const entries: Uint8Array[] = []
  for (const [p, bytes] of Object.entries(files)) {
    const pathBytes = enc.encode(p)
    const lenVarint = encodeVarint(pathBytes.length)
    const entry = new Uint8Array(lenVarint.length + pathBytes.length + bytes.length)
    entry.set(lenVarint, 0)
    entry.set(pathBytes, lenVarint.length)
    entry.set(bytes, lenVarint.length + pathBytes.length)
    entries.push(entry)
  }
  return encodePack(entries)
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function packRes(pack: Uint8Array): Response {
  return new Response(pack as unknown as BodyInit, { status: 200 })
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe('ejectCommand (thin client)', () => {
  let parentDir: string
  let destDir: string

  beforeEach(async () => {
    parentDir = await mkdtemp(path.join(os.tmpdir(), 'myth-eject-test-'))
    destDir = path.join(parentDir, 'out')
    process.env.MYTH_SESSION_TOKEN = TOKEN
  })

  afterEach(async () => {
    delete process.env.MYTH_SESSION_TOKEN
    await rm(parentDir, { recursive: true, force: true })
  })

  it('downloads the server-ejected project and writes it to disk byte-for-byte', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00])
    const project: Record<string, Uint8Array> = {
      'src/main.tsx': enc.encode("import { useVar } from '@portable/store'\nexport default 1\n"),
      'src/_portable/store.ts': enc.encode('export function useVar() {}\n'),
      'package.json': enc.encode('{"name":"mysite","dependencies":{"react":"^19.2.7"}}'),
      'public/logo.png': png,
      'EJECT_NOTES.md': enc.encode('# mysite\n'),
    }
    const pack = packExport(project)
    const calls: string[] = []
    const fakeFetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url)
      calls.push(u)
      if (u.includes('/publish/eject/')) return packRes(pack)
      throw new Error(`unexpected fetch: ${u}`)
    }) as unknown as typeof fetch

    const result = await ejectCommand({ name: 'mysite', destDir, fetch: fakeFetch })

    expect(calls[0]).toBe(`${PROD_API}/publish/eject/mysite`)
    expect(result.fileCount).toBe(5)
    expect(result.secretsVendored).toBe(false)
    for (const [rel, bytes] of Object.entries(project)) {
      const actual = new Uint8Array(await readFile(path.join(destDir, ...rel.split('/'))))
      expect(actual).toEqual(bytes)
    }
  })

  it('flags secretsVendored when the pack includes the secrets shim', async () => {
    const pack = packExport({ 'src/_portable/secrets.ts': enc.encode('export function proxyFetch() {}\n') })
    const fakeFetch = vi.fn(async () => packRes(pack)) as unknown as typeof fetch
    const result = await ejectCommand({ name: 'x', destDir, fetch: fakeFetch })
    expect(result.secretsVendored).toBe(true)
  })

  it('succeeds when destDir already exists but is empty', async () => {
    await mkdir(destDir, { recursive: true })
    const pack = packExport({ 'a.txt': enc.encode('a') })
    const fakeFetch = vi.fn(async () => packRes(pack)) as unknown as typeof fetch
    const result = await ejectCommand({ name: 'x', destDir, fetch: fakeFetch })
    expect(result.fileCount).toBe(1)
  })

  it('staging: targets the staging API', async () => {
    const pack = packExport({ 'a.txt': enc.encode('a') })
    const calls: string[] = []
    const fakeFetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url))
      return packRes(pack)
    }) as unknown as typeof fetch
    await ejectCommand({ name: 'x', destDir, staging: true, fetch: fakeFetch })
    expect(calls[0]).toMatch(new RegExp(`^${STAGING_API}/`))
  })

  it('a 404 rejects not_found and never creates destDir', async () => {
    const fakeFetch = vi.fn(async () => jsonRes({ error: 'no such app' }, 404)) as unknown as typeof fetch
    await expect(ejectCommand({ name: 'gone', destDir, fetch: fakeFetch })).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(await pathExists(destDir)).toBe(false)
  })

  it('a 409 (not ejectable, e.g. monorepo) rejects and never creates destDir', async () => {
    const fakeFetch = vi.fn(async () => jsonRes({ error: 'cannot eject a monorepo' }, 409)) as unknown as typeof fetch
    await expect(ejectCommand({ name: 'mono', destDir, fetch: fakeFetch })).rejects.toMatchObject({
      code: 'bad_bundle',
    })
    expect(await pathExists(destDir)).toBe(false)
  })

  it('rejects a pack containing an unsafe path and never writes anything', async () => {
    const pack = packExport({ '../evil.txt': enc.encode('pwned') })
    const fakeFetch = vi.fn(async () => packRes(pack)) as unknown as typeof fetch
    await expect(ejectCommand({ name: 'x', destDir, fetch: fakeFetch })).rejects.toMatchObject({
      code: 'corrupt_pack',
    })
    expect(await pathExists(destDir)).toBe(false)
  })
})
