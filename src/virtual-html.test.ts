import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Plugin } from 'vite'
import {
  generateLocalPid,
  generateWrapperHtml,
  hostFramePlugin,
  isAssetUrl,
  loadConfigOrThrow,
  OrbitConfigError,
} from './virtual-html.js'

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

describe('loadConfigOrThrow package.json fallback (AGE-97)', () => {
  let root = ''
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('resolves name+root from package.json mythwork.displayName when no myth.config.json (CI case)', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'myth-pkg-'))
    await writeFile(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'explore', mythwork: { displayName: 'explore' } })}\n`,
    )
    const loaded = loadConfigOrThrow(root)
    expect(loaded.config.name).toBe('explore')
    expect(loaded.root).toBe(root)
    // projectId comes from MYTH_PROJECT_ID env via resolvePinnedProjectId — never package.json.
    expect(loaded.config.projectId).toBeUndefined()
  })

  it('falls back to pkg.name when mythwork is absent', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'myth-pkg-'))
    await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: 'home' })}\n`)
    expect(loadConfigOrThrow(root).config.name).toBe('home')
  })

  it('maps mythwork.theme to defaultTheme only for light|dark', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'myth-pkg-'))
    await writeFile(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'x', mythwork: { displayName: 'X', theme: 'light' } })}\n`,
    )
    expect(loadConfigOrThrow(root).config.defaultTheme).toBe('light')
  })

  it('ignores a non-light/dark mythwork.theme (defaultTheme undefined)', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'myth-pkg-'))
    await writeFile(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'x', mythwork: { displayName: 'X', theme: 'sunset' } })}\n`,
    )
    expect(loadConfigOrThrow(root).config.defaultTheme).toBeUndefined()
  })

  it('myth.config.json wins when BOTH files are present (byte-identical legacy behavior)', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'myth-both-'))
    await writeFile(
      path.join(root, 'myth.config.json'),
      `${JSON.stringify({ name: 'legacy', projectId: 'p123' })}\n`,
    )
    await writeFile(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'pkgname', mythwork: { displayName: 'pkgdisplay' } })}\n`,
    )
    const loaded = loadConfigOrThrow(root)
    expect(loaded.config.name).toBe('legacy')
    expect(loaded.config.projectId).toBe('p123')
  })

  it('nearest myth.config.json wins over an ancestor package.json (legacy root unchanged)', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'myth-walk-'))
    await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: 'monorepo' })}\n`)
    const appDir = path.join(root, 'app')
    await mkdir(appDir)
    await writeFile(path.join(appDir, 'myth.config.json'), `${JSON.stringify({ name: 'tennis' })}\n`)
    const loaded = loadConfigOrThrow(appDir)
    expect(loaded.config.name).toBe('tennis')
    expect(loaded.root).toBe(appDir)
  })

  it('throws with a message naming BOTH modern package.json and legacy myth.config.json when neither is found', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'myth-neither-'))
    expect(() => loadConfigOrThrow(root)).toThrow(OrbitConfigError)
    expect(() => loadConfigOrThrow(root)).toThrow(/package\.json/)
    expect(() => loadConfigOrThrow(root)).toThrow(/mythwork/)
    expect(() => loadConfigOrThrow(root)).toThrow(/myth\.config\.json/)
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

describe('generateWrapperHtml (deployment-shaped dev wrapper)', () => {
  const stage = {
    name: 'prod',
    label: 'myth.work (prod)',
    apiOrigin: 'https://api.myth.work',
    authOrigin: 'https://auth.myth.work',
    serveOrigin: 'https://myth.work',
    collabUrl: 'wss://collab.myth.work',
  } as const
  const html = generateWrapperHtml(
    { projectId: 'abc123abc123abc12', projectName: 'Lab Nav', stage, port: '5173' },
    { name: 'Lab Nav' },
  )

  it('loads the host-frame bundle from the proxied /_hf path', () => {
    expect(html).toContain('<script src="/_hf/host-frame.js"></script>')
  })

  it('frames the app on the app.localhost origin, same path scheme (no /app prefix)', () => {
    expect(html).toContain('"http://app.localhost:5173"')
    expect(html).not.toContain("'/app'")
  })

  it('boots __hf.init with the proxied backend origins and the stage collab url', () => {
    expect(html).toContain('iframeOrigin: "http://app.localhost:5173"')
    expect(html).toContain('authOrigin: "http://auth.localhost:5173"')
    expect(html).toContain(
      'backendOrigins: {"api":"http://api.localhost:5173","auth":"http://auth.localhost:5173","collab":"wss://collab.myth.work"}',
    )
    expect(html).toContain('appId: "abc123abc123abc12"')
  })

  it('keeps the production sandbox attributes on the app frame', () => {
    expect(html).toContain('sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"')
  })
})

describe('isAssetUrl', () => {
  it('lets vite-internal and extensioned URLs through', () => {
    expect(isAssetUrl('/@vite/client')).toBe(true)
    expect(isAssetUrl('/@id/__x00__virtual:myth-entry')).toBe(true)
    expect(isAssetUrl('/node_modules/.vite/deps/react.js')).toBe(true)
    expect(isAssetUrl('/src/main.tsx')).toBe(true)
    expect(isAssetUrl('/styles.css?t=123')).toBe(true)
  })

  it('treats document-ish routes as non-assets (SPA fallback territory)', () => {
    expect(isAssetUrl('/')).toBe(false)
    expect(isAssetUrl('/project/abc123')).toBe(false)
    expect(isAssetUrl('/discover?tags=ai')).toBe(false)
  })
})

describe('hostFramePlugin legacy app-host document', () => {
  const stage = {
    name: 'prod',
    label: 'myth.work (prod)',
    apiOrigin: 'https://api.myth.work',
    authOrigin: 'https://auth.myth.work',
    serveOrigin: 'https://myth.work',
    collabUrl: 'wss://collab.myth.work',
  } as const

  const respond = async (
    url: string,
    entry: string | null,
    transformIndexHtml: (url: string, html: string) => Promise<string> = async (_url, html) =>
      html.replace('<body>', '<body>\n<script type="module" src="/@react-refresh"></script>'),
  ) => {
    const plugin = hostFramePlugin({
      projectId: 'abc123abc123abc12',
      projectName: 'Probe',
      stage,
      entry,
    }) as Plugin & {
      configResolved: (c: { root: string }) => void
      configureServer: (s: unknown) => void
    }
    plugin.configResolved({ root: os.tmpdir() })

    let handler: ((req: unknown, res: unknown, next: (e?: unknown) => void) => void) | undefined
    const transformed: string[] = []
    plugin.configureServer({
      middlewares: { use: (h: typeof handler) => void (handler = h) },
      transformIndexHtml: async (url: string, html: string) => {
        transformed.push(html)
        return transformIndexHtml(url, html)
      },
    })

    const chunks: string[] = []
    let nexted = false
    let nextedErr: unknown
    const done = new Promise<void>(resolve => {
      handler?.(
        { url, headers: { host: 'app.localhost:5173' }, originalUrl: url },
        {
          setHeader: () => {},
          end: (body: string) => {
            chunks.push(body)
            resolve()
          },
        },
        (e?: unknown) => {
          nexted = true
          nextedErr = e
          resolve()
        },
      )
    })
    await done
    return { body: chunks[0], nexted, nextedErr, transformed }
  }

  it('runs the virtual shell through transformIndexHtml so the react preamble lands', async () => {
    const { body, transformed } = await respond('/', 'src/App.tsx')
    expect(transformed).toHaveLength(1)
    expect(transformed[0]).toContain('/@id/__x00__virtual:myth-entry')
    expect(body).toContain('<script type="module" src="/@react-refresh"></script>')
  })

  it('leaves asset URLs and modern apps to vite', async () => {
    expect((await respond('/src/App.tsx', 'src/App.tsx')).nexted).toBe(true)
    expect((await respond('/', null)).nexted).toBe(true)
  })

  it('forwards a transformIndexHtml rejection to next(err) instead of writing a response', async () => {
    const transformErr = new Error('boom: bad html transform')
    const { body, nexted, nextedErr } = await respond('/', 'src/App.tsx', async () => {
      throw transformErr
    })
    expect(nexted).toBe(true)
    expect(nextedErr).toBe(transformErr)
    expect(body).toBeUndefined()
  })
})
