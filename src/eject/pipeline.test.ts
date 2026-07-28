/**
 * Tests for the P6 eject PIPELINE (portable runtime + toolchain emission + the
 * end-to-end transform), layered on the crux transform tested in eject.test.ts.
 * The load-bearing assertion is the portability gate: a fully-ejected project has
 * ZERO residual platform specifiers across every emitted file.
 */
import { describe, expect, it } from 'vitest'
import { auditResidualPlatform } from './rewrite-imports.js'
import { vendorPortable, FULLY_SUPPORTED } from './portable-runtime.js'
import { emitBootstrapEntry, emitPackageJson, emitToolchain } from './toolchain.js'
import { eject } from './index.js'
import { emptyReport } from './rewrite-imports.js'

describe('vendorPortable', () => {
  it('emits a src/_portable module per used subpath', () => {
    const files = vendorPortable(['store', 'secrets'])
    expect(Object.keys(files).sort()).toEqual([
      'src/_portable/secrets.ts',
      'src/_portable/store.ts',
    ])
  })

  it('vendored source carries no platform specifiers (it IS the replacement)', () => {
    for (const [, src] of Object.entries(vendorPortable([...FULLY_SUPPORTED, 'collab', 'auth']))) {
      expect(auditResidualPlatform(src)).toEqual([])
    }
  })

  it('store shim exports the real hook names app code imports', () => {
    const src = vendorPortable(['store'])['src/_portable/store.ts']
    expect(src).toContain('export function useVar')
    expect(src).toContain('export function useMap')
  })

  it('vendors a default-export stub for an unshimmed subpath, and eject() flags it degraded', () => {
    // Default imports resolve against the stub's `export default`. A NAMED import
    // from an unshimmed subpath can't be satisfied statically — so it must be
    // SURFACED (degraded list + README), never silently shipped as a broken build.
    const files = vendorPortable(['git/react'])
    expect(files['src/_portable/git/react.ts']).toContain('export default')
    const { degraded } = eject({
      'src/App.tsx':
        "import { useGit } from '@mythwork/git/react'\nexport const G = () => useGit()\n",
    })
    expect(degraded).toContain('git/react')
  })

  it('vendors a nested subpath at the path the @portable alias resolves to, clean', () => {
    // `import '@portable/git/react'` + the emitted vite alias (@portable → src/_portable)
    // and tsconfig path (@portable/* → ./src/_portable/*) resolve to this exact file.
    const files = vendorPortable(['git/react'])
    const resolved = 'src/_portable/git/react.ts'
    expect(files[resolved]).toBeTruthy()
    expect(auditResidualPlatform(files[resolved])).toEqual([]) // the stub is a real replacement
  })
})

describe('emitToolchain', () => {
  it('pins react and aliases @portable → src/_portable', () => {
    const report = emptyReport()
    const pkg = JSON.parse(emitPackageJson(report, 'demo'))
    expect(pkg.dependencies.react).toMatch(/^\^19/)
    expect(pkg.scripts.dev).toBe('vite')
    const tc = emitToolchain(report, { entry: 'src/main.tsx' })
    expect(tc['vite.config.ts']).toContain("'@portable'")
    expect(tc['tsconfig.json']).toContain('@portable/*')
    expect(tc['index.html']).toContain('/src/main.tsx')
  })

  it('emitBootstrapEntry has no residual platform specifiers', () => {
    expect(auditResidualPlatform(emitBootstrapEntry())).toEqual([])
  })
})

describe('eject (end-to-end)', () => {
  const app = {
    'src/App.tsx':
      "import { useVar } from '@orbitcode/store'\n" +
      "import { proxyFetch } from '@mythwork/secrets'\n" +
      "import { Header } from './Header'\n" +
      'export default function App() { const [n, setN] = useVar("n", 0); return <Header n={n} onInc={() => setN(v => v + 1)} /> }\n',
    'src/Header.tsx':
      'export function Header(p: { n: number; onInc: () => void }) { return <button onClick={p.onInc}>{p.n}</button> }\n',
    'src/main.tsx':
      "import { createRoot } from 'react-dom/client'\nimport App from './App'\ncreateRoot(document.getElementById('root')!).render(<App />)\n",
  }

  it('produces a standalone project with ZERO residual platform specifiers', () => {
    const { files, residual } = eject(app, { name: 'demo' })
    expect(residual).toEqual({})
    for (const [, content] of Object.entries(files)) {
      expect(auditResidualPlatform(content)).toEqual([])
    }
  })

  it('rewrites platform imports to @portable and vendors those modules', () => {
    const { files } = eject(app, { name: 'demo' })
    expect(files['src/App.tsx']).toContain("from '@portable/store'")
    expect(files['src/App.tsx']).toContain("from '@portable/secrets'")
    expect(files['src/App.tsx']).toContain("from './Header'") // relative untouched
    expect(files['src/_portable/store.ts']).toBeTruthy()
    expect(files['src/_portable/secrets.ts']).toBeTruthy()
  })

  it('emits a runnable toolchain and honest notes', () => {
    const { files } = eject(app, { name: 'demo' })
    expect(files['package.json']).toBeTruthy()
    expect(files['vite.config.ts']).toContain('@portable')
    expect(files['EJECT_NOTES.md']).toContain('one-way escape hatch')
    expect(files['.gitignore']).toContain('.env')
  })

  it('reuses the app entry (no bootstrap when src/main.tsx exists)', () => {
    const { files, warnings } = eject(app, { name: 'demo' })
    expect(files['index.html']).toContain('/src/main.tsx')
    expect(warnings.join(' ')).not.toContain('bootstrap')
  })

  it('cleanly ejects store/secrets — nothing degraded', () => {
    const { degraded } = eject(app, { name: 'demo' })
    expect(degraded).toEqual([])
  })

  it('emits a .env.example from the app\'s {{NAME}} placeholders when secrets are used', () => {
    const withSecrets = {
      ...app,
      'src/api.ts':
        "import { proxyFetch } from '@mythwork/secrets'\n" +
        "export const call = () => proxyFetch('https://api.openai.com/v1/chat', {\n" +
        "  headers: { Authorization: 'Bearer {{OPENAI_API_KEY}}', 'X-Org': '{{OPENAI_ORG}}' },\n" +
        '})\n',
    }
    const { files } = eject(withSecrets, { name: 'demo' })
    const env = files['.env.example']
    expect(env).toBeTruthy()
    // Placeholders surface as VITE_<NAME>, sorted, with the client-exposure caveat.
    expect(env).toContain('VITE_OPENAI_API_KEY=')
    expect(env).toContain('VITE_OPENAI_ORG=')
    expect(env).toContain('WARNING')
    // The README's copy-instruction now points at a file that exists.
    expect(files['EJECT_NOTES.md']).toContain('.env.example')
  })

  it('emits a self-documenting .env.example when secrets are used but no placeholder is found', () => {
    // app uses @mythwork/secrets but references no {{NAME}} literal.
    const { files } = eject(app, { name: 'demo' })
    expect(files['.env.example']).toBeTruthy()
    expect(files['.env.example']).toContain('VITE_')
  })

  it('does NOT emit .env.example or secrets guidance when the app never uses secrets', () => {
    const noSecrets = {
      'src/App.tsx':
        "import { useVar } from '@orbitcode/store'\nexport default function App() { const [n] = useVar('n', 0); return <div>{n}</div> }\n",
    }
    const { files } = eject(noSecrets, { name: 'demo' })
    expect(files['.env.example']).toBeUndefined()
    expect(files['EJECT_NOTES.md']).not.toContain('.env.example')
  })

  it('never overwrites a .env.example the app already shipped', () => {
    const shipped = { ...app, '.env.example': '# curated by the author\nVITE_CUSTOM=\n' }
    const { files } = eject(shipped, { name: 'demo' })
    expect(files['.env.example']).toBe('# curated by the author\nVITE_CUSTOM=\n')
  })

  it('flags degraded features (collab) in the result + README', () => {
    const withCollab = {
      ...app,
      'src/Room.tsx':
        "import { useCollabRoom } from '@mythwork/collab'\nexport const Room = () => useCollabRoom()\n",
    }
    const { degraded, files } = eject(withCollab, { name: 'demo' })
    expect(degraded).toContain('collab')
    expect(files['EJECT_NOTES.md']).toContain('collab')
  })

  it('synthesizes src/main.tsx and points to ./App when the app has App but no entry', () => {
    const noEntryWithApp = {
      'src/App.tsx':
        "import { useVar } from '@orbitcode/store'\nexport default function App() { const [n] = useVar('n', 0); return <div>{n}</div> }\n",
    }
    const { files, warnings, residual } = eject(noEntryWithApp, { name: 'demo' })
    expect(residual).toEqual({})
    expect(files['src/main.tsx']).toBeTruthy()
    expect(files['src/main.tsx']).toContain("import App from './App'")
    expect(files['src/main.tsx']).toContain('createRoot')
    expect(files['index.html']).toContain('/src/main.tsx')
    expect(warnings).toContain(
      'No entry module found; emitted a bootstrap src/main.tsx that renders ./App.',
    )
  })

  it('warns to verify the entry when neither entry nor App exists', () => {
    const bare = {
      'src/Widget.tsx':
        "import { useVar } from '@orbitcode/store'\nexport function Widget() { const [n] = useVar('n', 0); return <div>{n}</div> }\n",
    }
    const { files, warnings } = eject(bare, { name: 'demo' })
    expect(files['src/main.tsx']).toContain("import App from './App'")
    expect(warnings).toContain(
      'No entry module and no App component found; emitted src/main.tsx importing ./App — verify the entry after export.',
    )
  })
})
