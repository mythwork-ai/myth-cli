/**
 * publishCommand-level tests for project resolution (AGE-81, supersedes
 * AGE-67/78 write-back).
 *
 * The projectId is per-(user, stage) DERIVED state and is NEVER written back to
 * myth.config.json. Two cases:
 *
 *  - Name-only config (the normal case): ALWAYS resolve the project via the
 *    idempotent POST /project/provision — the provision call IS the lookup —
 *    then a single finalize with that pid. The committed config stays
 *    name-only.
 *  - projectId PRESENT (an explicit team-shared pin): finalize with it
 *    directly; on a not-owner 403 the caller isn't a member, so fall back to
 *    their OWN project (idempotent provision) and retry — WITHOUT rewriting the
 *    committed pin.
 *
 * `force: true` skips the served-tree no-op probe so the only network hits are
 * check → (provision) → finalize.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { publishCommand } from './index.js'

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('publishCommand pinned-projectId fallback (AGE-81)', () => {
  let root = ''
  let origToken: string | undefined

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'myth-age81-pin-'))
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(
      path.join(root, 'myth.config.json'),
      `${JSON.stringify({ projectId: 'notmine0000000000', name: 'tennis-demo' }, null, 2)}\n`,
    )
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'tennis-demo', dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' } }),
    )
    await writeFile(
      path.join(root, 'src', 'main.tsx'),
      "import { createRoot } from 'react-dom/client'\ncreateRoot(document.body).render(null)\n",
    )
    origToken = process.env.MYTH_SESSION_TOKEN
    process.env.MYTH_SESSION_TOKEN = 'fake.jwt.token'
  })

  afterEach(async () => {
    if (origToken === undefined) delete process.env.MYTH_SESSION_TOKEN
    else process.env.MYTH_SESSION_TOKEN = origToken
    vi.unstubAllGlobals()
    await rm(root, { recursive: true, force: true })
  })

  it('pinned pid not joinable → provisions own project, retries, does NOT rewrite the pin', async () => {
    const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = []
    let finalizeCount = 0
    const fakeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      calls.push({ url: u, method, body })
      if (u.endsWith('/publish/check')) return jsonRes({ missing: [] })
      if (u.endsWith('/project/provision')) return jsonRes({ projectId: 'pPROVISIONEDxyz789', alias: 'tennis-demo-ab12', anonymous: false })
      if (u.endsWith('/publish')) {
        finalizeCount++
        if (finalizeCount === 1) {
          return jsonRes({ error: 'projectId ownership mismatch', code: 'project_ownership' }, 403)
        }
        return jsonRes({ commit: 'a'.repeat(64), tree: 'b'.repeat(64), canonical: 'c'.repeat(52), alias: 'tennis-demo' })
      }
      throw new Error(`unexpected fetch: ${method} ${u}`)
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fakeFetch)

    await publishCommand({ cwd: root, shortName: 'tennis-demo', staging: true, force: true })

    // (1) provision called with the slugified localId + projectName (the fallback)
    const prov = calls.find(c => c.url.endsWith('/project/provision'))
    expect(prov).toBeDefined()
    expect(prov?.body).toEqual({ localId: 'tennis-demo', projectName: 'tennis-demo' })

    // (2) AGE-81: the committed pin is NOT rewritten — it stays exactly as authored.
    const cfg = JSON.parse(await readFile(path.join(root, 'myth.config.json'), 'utf-8')) as {
      projectId: string
      name: string
    }
    expect(cfg.projectId).toBe('notmine0000000000')
    expect(cfg.name).toBe('tennis-demo')

    // (3) two finalize calls: first the pinned pid, second the provisioned own pid
    const finals = calls.filter(c => c.url.endsWith('/publish') && c.method === 'POST')
    expect(finals).toHaveLength(2)
    expect(finals[0].body?.projectId).toBe('notmine0000000000')
    expect(finals[1].body?.projectId).toBe('pPROVISIONEDxyz789')
  })

  it('pinned pid owned → finalize succeeds first try, no provision, no rewrite', async () => {
    let provisionCalled = false
    const fakeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/publish/check')) return jsonRes({ missing: [] })
      if (u.endsWith('/project/provision')) { provisionCalled = true; return jsonRes({ projectId: 'x' }) }
      if (u.endsWith('/publish')) return jsonRes({ commit: 'a'.repeat(64), tree: 'b'.repeat(64), canonical: 'c'.repeat(52), alias: 'tennis-demo' })
      throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${u}`)
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fakeFetch)

    await publishCommand({ cwd: root, shortName: 'tennis-demo', staging: true, force: true })
    expect(provisionCalled).toBe(false)
    const cfg = JSON.parse(await readFile(path.join(root, 'myth.config.json'), 'utf-8')) as { projectId: string }
    expect(cfg.projectId).toBe('notmine0000000000') // untouched
  })

  it('rethrows (no loop) when the fallback finalize ALSO 403s project_ownership', async () => {
    let finalizeCount = 0
    const fakeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/publish/check')) return jsonRes({ missing: [] })
      if (u.endsWith('/project/provision')) return jsonRes({ projectId: 'pPROV999', anonymous: false })
      if (u.endsWith('/publish')) {
        finalizeCount++
        return jsonRes({ error: 'projectId ownership mismatch', code: 'project_ownership' }, 403)
      }
      throw new Error(`unexpected fetch: ${u}`)
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fakeFetch)

    await expect(
      publishCommand({ cwd: root, shortName: 'tennis-demo', staging: true, force: true }),
    ).rejects.toMatchObject({ code: 'not_owner' })
    // provision fired once, finalize attempted exactly twice — NO infinite loop
    expect(finalizeCount).toBe(2)
  })
})

describe('publishCommand name-only resolve-via-provision (AGE-81)', () => {
  let root = ''
  let origToken: string | undefined

  async function scaffold(config: Record<string, unknown>): Promise<void> {
    root = await mkdtemp(path.join(os.tmpdir(), 'myth-age81-name-'))
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'myth.config.json'), `${JSON.stringify(config, null, 2)}\n`)
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'tennis-demo', dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' } }),
    )
    await writeFile(path.join(root, 'src', 'main.tsx'), "import { createRoot } from 'react-dom/client'\ncreateRoot(document.body).render(null)\n")
    origToken = process.env.MYTH_SESSION_TOKEN
    process.env.MYTH_SESSION_TOKEN = 'fake.jwt.token'
  }

  afterEach(async () => {
    if (origToken === undefined) delete process.env.MYTH_SESSION_TOKEN
    else process.env.MYTH_SESSION_TOKEN = origToken
    vi.unstubAllGlobals()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('name-only config → resolves the project via provision, single finalize, config stays name-only', async () => {
    await scaffold({ name: 'tennis-demo' }) // NO projectId — the myth init default
    const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = []
    const fakeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      calls.push({ url: u, method: init?.method ?? 'GET', body })
      if (u.endsWith('/publish/check')) return jsonRes({ missing: [] })
      if (u.endsWith('/project/provision')) return jsonRes({ projectId: 'pRESOLVED12345', alias: 'tennis-demo-zz', anonymous: false })
      if (u.endsWith('/publish')) return jsonRes({ commit: 'a'.repeat(64), tree: 'b'.repeat(64), canonical: 'c'.repeat(52), alias: 'tennis-demo' })
      throw new Error(`unexpected fetch: ${u}`)
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fakeFetch)

    await publishCommand({ cwd: root, shortName: 'tennis-demo', staging: true, force: true })

    // provision is the lookup: called once with the slugified localId + name
    const prov = calls.find(c => c.url.endsWith('/project/provision'))
    expect(prov?.body).toEqual({ localId: 'tennis-demo', projectName: 'tennis-demo' })

    // AGE-81: NO write-back — the committed config stays name-only.
    const cfg = JSON.parse(await readFile(path.join(root, 'myth.config.json'), 'utf-8')) as {
      projectId?: string
    }
    expect(cfg.projectId).toBeUndefined()

    // exactly ONE finalize, carrying the resolved pid (no 403 round-trip)
    const finals = calls.filter(c => c.url.endsWith('/publish') && c.method === 'POST')
    expect(finals).toHaveLength(1)
    expect(finals[0].body?.projectId).toBe('pRESOLVED12345')
  })
})
