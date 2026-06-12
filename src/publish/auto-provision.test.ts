/**
 * publishCommand-level test for the AGE-67 auto-provision-and-retry path.
 *
 * Drives the full command with a temp project + stubbed global fetch: the
 * first finalize 403s with code project_ownership, and we assert the command
 * provisions the caller's own project (slugified localId), rewrites
 * myth.config.json with the returned pid, and retries finalize with it.
 * `force: true` skips the served-tree no-op probe so the only network hits are
 * check → finalize(403) → provision → finalize(200).
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

describe('publishCommand auto-provision-and-retry (AGE-67)', () => {
  let root = ''
  let origToken: string | undefined

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'myth-age67-'))
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

  it('provisions own project, rewrites config, retries finalize with the new pid', async () => {
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

    // (1) provision called with the slugified localId + projectName
    const prov = calls.find(c => c.url.endsWith('/project/provision'))
    expect(prov).toBeDefined()
    expect(prov?.body).toEqual({ localId: 'tennis-demo', projectName: 'tennis-demo' })

    // (2) myth.config.json rewritten with the provisioned pid; other fields kept
    const cfg = JSON.parse(await readFile(path.join(root, 'myth.config.json'), 'utf-8')) as {
      projectId: string
      name: string
    }
    expect(cfg.projectId).toBe('pPROVISIONEDxyz789')
    expect(cfg.name).toBe('tennis-demo')

    // (3) two finalize calls: first the old pid, second the provisioned one
    const finals = calls.filter(c => c.url.endsWith('/publish') && c.method === 'POST')
    expect(finals).toHaveLength(2)
    expect(finals[0].body?.projectId).toBe('notmine0000000000')
    expect(finals[1].body?.projectId).toBe('pPROVISIONEDxyz789')
  })

  it('does NOT provision when finalize succeeds first try (no spurious provision)', async () => {
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
})
