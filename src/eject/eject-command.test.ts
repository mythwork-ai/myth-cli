/**
 * Integration tests for `myth eject` (ejectCommand). Mirrors pull.test.ts: the
 * `fetch` boundary is mocked with real buildObjectsFromFiles/encodePack
 * fixtures (a true round-trip of the production encoder), MYTH_SESSION_TOKEN
 * bypasses the browser handshake, and assertions run against the real files
 * written into a fresh temp directory.
 *
 * The load-bearing guarantees under test:
 *   - The exported project has ZERO residual platform specifiers, and the app's
 *     own platform-flavored toolchain (package.json/tsconfig/index.html) is
 *     REPLACED by eject's clean one — deps rebuilt from the app's imports.
 *   - Binary blobs survive byte-for-byte (never round-tripped through a string).
 *   - Every failure path (monorepo, non-UTF-8 source, residual gate, a 404)
 *     fails BEFORE any directory is created — no stray folder left behind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildObjectsFromFiles } from '../publish/build-objects.js'
import { encodePack } from '../publish/pack-codec.js'
import { ejectCommand, EjectError } from './eject-command.js'

const TOKEN = 'fake.session.jwt'
const PROD_API = 'https://api.myth.work'
const STAGING_API = 'https://api.llama.space'
const enc = new TextEncoder()

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

/** Publish `files` through the real encoder and return a fetch mock that serves
 *  the resulting site + pack, recording the URLs it was called with. */
async function fakeBackend(files: Map<string, Uint8Array>) {
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
  return { fetch: fakeFetch, calls, built }
}

describe('ejectCommand', () => {
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

  async function readOut(rel: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path.join(destDir, ...rel.split('/'))))
  }
  async function readOutText(rel: string): Promise<string> {
    return readFile(path.join(destDir, ...rel.split('/')), 'utf-8')
  }

  it('exports a standalone project: imports rewritten, runtime vendored, toolchain replaced', async () => {
    // A real published app carries its own platform-flavored package.json /
    // tsconfig / index.html — all of which must be replaced by eject's clean set.
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x10])
    const files = new Map<string, Uint8Array>([
      [
        'src/App.tsx',
        enc.encode(
          "import { useVar } from '@mythwork/store'\n" +
            "import { proxyFetch } from '@orbitcode/secrets'\n" +
            "import { Header } from './Header'\n" +
            'export default function App() { const [n] = useVar("n", 0); return <Header n={n} /> }\n',
        ),
      ],
      ['src/Header.tsx', enc.encode('export function Header(p: { n: number }) { return <b>{p.n}</b> }\n')],
      [
        'src/main.tsx',
        enc.encode(
          "import { createRoot } from 'react-dom/client'\nimport App from './App'\n" +
            "createRoot(document.getElementById('root')!).render(<App />)\n",
        ),
      ],
      // The app's OWN toolchain — platform-flavored, must be dropped:
      ['package.json', enc.encode('{"name":"tennis","dependencies":{"@mythwork/store":"*"}}')],
      ['tsconfig.json', enc.encode('{"extends":"./platform-tsconfig.json"}')],
      ['index.html', enc.encode('<!doctype html><div id="root"></div>')],
      ['package-lock.json', enc.encode('{"lockfileVersion":3}')],
      // Passthrough content:
      ['README.md', enc.encode('# tennis\n')],
      ['public/logo.png', pngBytes],
    ])
    const { fetch, calls } = await fakeBackend(files)

    const result = await ejectCommand({ name: 'tennis', destDir, fetch })

    expect(calls[0]).toBe(`${PROD_API}/publish/site/tennis`)

    // Imports rewritten to the vendored runtime; nothing of ours remains.
    const app = await readOutText('src/App.tsx')
    expect(app).toContain("from '@portable/store'")
    expect(app).toContain("from '@portable/secrets'")
    expect(app).toContain("from './Header'") // relative untouched
    expect(app).not.toContain('@mythwork')
    expect(app).not.toContain('@orbitcode')
    expect(await pathExists(path.join(destDir, 'src/_portable/store.ts'))).toBe(true)
    expect(await pathExists(path.join(destDir, 'src/_portable/secrets.ts'))).toBe(true)

    // The app's package.json was REPLACED, not kept: named after the alias, no
    // @mythwork dep, react + a real build toolchain present.
    const pkg = JSON.parse(await readOutText('package.json'))
    expect(pkg.name).toBe('tennis')
    expect(pkg.dependencies['@mythwork/store']).toBeUndefined()
    expect(pkg.dependencies.react).toMatch(/^\^19/)
    expect(pkg.devDependencies.vite).toBeTruthy()
    // tsconfig replaced with the standalone one (no `extends`, has the alias).
    const tsconfig = await readOutText('tsconfig.json')
    expect(tsconfig).toContain('@portable/*')
    expect(tsconfig).not.toContain('extends')
    // Lockfile dropped (a fresh install regenerates it).
    expect(await pathExists(path.join(destDir, 'package-lock.json'))).toBe(false)

    // Binary asset survives byte-for-byte.
    expect(await readOut('public/logo.png')).toEqual(pngBytes)
    // Passthrough text survives.
    expect(await readOutText('README.md')).toBe('# tennis\n')
    // Notes emitted; secrets shim → warning flag set.
    expect(await pathExists(path.join(destDir, 'EJECT_NOTES.md'))).toBe(true)
    expect(result.secretsVendored).toBe(true)
    expect(result.degraded).toEqual([])
  })

  it('--pkg-name overrides the emitted package.json name (positional stays the alias)', async () => {
    const files = new Map<string, Uint8Array>([
      ['src/main.tsx', enc.encode("import { useVar } from '@mythwork/store'\nexport default 1\n")],
    ])
    const { fetch, calls } = await fakeBackend(files)
    await ejectCommand({ name: 'tennis', destDir, pkgName: 'renamed', fetch })
    expect(calls[0]).toBe(`${PROD_API}/publish/site/tennis`) // fetched by alias
    const pkg = JSON.parse(await readOutText('package.json'))
    expect(pkg.name).toBe('renamed') // emitted under the override
  })

  it('staging: targets the staging API', async () => {
    const files = new Map<string, Uint8Array>([['src/main.tsx', enc.encode('export default 1\n')]])
    const { fetch, calls } = await fakeBackend(files)
    await ejectCommand({ name: 'app', destDir, staging: true, fetch })
    expect(calls[0]).toMatch(new RegExp(`^${STAGING_API}/`))
  })

  it('refuses a workspace/monorepo and never creates destDir', async () => {
    const files = new Map<string, Uint8Array>([
      ['pnpm-workspace.yaml', enc.encode("packages:\n  - 'app'\n")],
      ['app/src/main.tsx', enc.encode('export default 1\n')],
    ])
    const { fetch } = await fakeBackend(files)
    await expect(ejectCommand({ name: 'mono', destDir, fetch })).rejects.toMatchObject({
      reason: 'not_ejectable',
    })
    expect(await pathExists(destDir)).toBe(false)
  })

  it('rejects a non-UTF-8 source file (decode_failed) and never creates destDir', async () => {
    const files = new Map<string, Uint8Array>([
      ['src/main.tsx', enc.encode('export default 1\n')],
      ['src/bad.ts', new Uint8Array([0xff, 0xfe, 0x00, 0x01])], // not valid UTF-8
    ])
    const { fetch } = await fakeBackend(files)
    await expect(ejectCommand({ name: 'app', destDir, fetch })).rejects.toBeInstanceOf(EjectError)
    await expect(ejectCommand({ name: 'app', destDir, fetch })).rejects.toMatchObject({
      reason: 'decode_failed',
    })
    expect(await pathExists(destDir)).toBe(false)
  })

  it('the residual-platform gate fails in memory, before any directory is created', async () => {
    // A bare platform specifier in a STRING LITERAL (not an import position) is
    // not rewritten but is still flagged by the residual audit — a known
    // regex-codemod false positive. Regardless of that, this asserts the gate
    // runs before disk is touched: a rejected export leaves no stray folder.
    const files = new Map<string, Uint8Array>([
      ['src/main.tsx', enc.encode('export default 1\n')],
      ['src/brand.ts', enc.encode('export const PKG = "@mythwork/store"\n')],
    ])
    const { fetch } = await fakeBackend(files)
    await expect(ejectCommand({ name: 'app', destDir, fetch })).rejects.toMatchObject({
      reason: 'residual_platform',
    })
    expect(await pathExists(destDir)).toBe(false)
  })

  it('a 404 resolving the site rejects not_found and never creates destDir', async () => {
    const fakeFetch = vi.fn(async () => jsonRes({}, 404)) as unknown as typeof fetch
    await expect(ejectCommand({ name: 'gone', destDir, fetch: fakeFetch })).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(await pathExists(destDir)).toBe(false)
  })
})
