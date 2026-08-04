import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { secretExclusionNotice, selectSourceFiles, selectSourceFilesReporting } from './source-select.js'

function scaffold(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'myth-src-'))
  mkdirSync(path.join(root, 'src'), { recursive: true })
  mkdirSync(path.join(root, 'public'), { recursive: true })
  mkdirSync(path.join(root, 'node_modules', 'react'), { recursive: true })
  mkdirSync(path.join(root, 'dist'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'main.tsx'), 'export default 1')
  writeFileSync(path.join(root, 'src', 'index.css'), 'body{}')
  writeFileSync(path.join(root, 'public', 'logo.svg'), '<svg/>')
  writeFileSync(path.join(root, 'package.json'), '{"name":"x"}')
  writeFileSync(path.join(root, 'package-lock.json'), '{}')
  writeFileSync(path.join(root, 'node_modules', 'react', 'index.js'), 'x')
  writeFileSync(path.join(root, 'dist', 'bundle.js'), 'x')
  writeFileSync(path.join(root, '.env'), 'SECRET=1')
  writeFileSync(path.join(root, '.gitignore'), '.env\ncoverage/\n')
  mkdirSync(path.join(root, 'coverage'), { recursive: true })
  writeFileSync(path.join(root, 'coverage', 'report.html'), 'x')
  return root
}

describe('selectSourceFiles', () => {
  let root: string
  beforeEach(() => {
    root = scaffold()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('includes source, css, public, package.json, lockfile', () => {
    const files = selectSourceFiles(root)
    expect(files).toContain('src/main.tsx')
    expect(files).toContain('src/index.css')
    expect(files).toContain('public/logo.svg')
    expect(files).toContain('package.json')
    expect(files).toContain('package-lock.json')
  })

  it('excludes node_modules, dist, and .git by heuristic', () => {
    const files = selectSourceFiles(root)
    expect(files.some(f => f.startsWith('node_modules/'))).toBe(false)
    expect(files.some(f => f.startsWith('dist/'))).toBe(false)
  })

  it('excludes anything matched by .gitignore', () => {
    const files = selectSourceFiles(root)
    expect(files).not.toContain('.env')
    expect(files.some(f => f.startsWith('coverage/'))).toBe(false)
  })

  it('excludes glob-matched secrets (the security boundary)', () => {
    // Common secret patterns that a naive matcher would miss.
    writeFileSync(path.join(root, '.gitignore'), '*.pem\n.env*\n**/secret.txt\n')
    writeFileSync(path.join(root, 'server.pem'), 'KEY')
    writeFileSync(path.join(root, '.env.production'), 'SECRET=1')
    mkdirSync(path.join(root, 'src', 'deep'), { recursive: true })
    writeFileSync(path.join(root, 'src', 'deep', 'secret.txt'), 'SECRET')
    const files = selectSourceFiles(root)
    expect(files).not.toContain('server.pem')
    expect(files).not.toContain('.env.production')
    expect(files).not.toContain('src/deep/secret.txt')
    // Non-matching source still included.
    expect(files).toContain('src/main.tsx')
  })

  it('honors leading-slash anchoring (root-only)', () => {
    writeFileSync(path.join(root, '.gitignore'), '/build\n')
    mkdirSync(path.join(root, 'build'), { recursive: true })
    writeFileSync(path.join(root, 'build', 'root.js'), 'x')
    mkdirSync(path.join(root, 'src', 'build'), { recursive: true })
    writeFileSync(path.join(root, 'src', 'build', 'nested.js'), 'x')
    const files = selectSourceFiles(root)
    expect(files.some(f => f.startsWith('build/'))).toBe(false) // root build excluded
    expect(files).toContain('src/build/nested.js') // nested build kept
  })

  it('applies the hard secret floor even with no .gitignore', () => {
    rmSync(path.join(root, '.gitignore'), { force: true })
    writeFileSync(path.join(root, 'server.pem'), 'KEY')
    writeFileSync(path.join(root, 'app.key'), 'KEY')
    writeFileSync(path.join(root, '.env.production'), 'SECRET=1')
    writeFileSync(path.join(root, '.env.example'), 'SECRET=')
    const files = selectSourceFiles(root)
    expect(files).toContain('src/main.tsx')
    expect(files.some(f => f.startsWith('node_modules/'))).toBe(false)
    // Secrets dropped by the floor regardless of .gitignore.
    expect(files).not.toContain('.env')
    expect(files).not.toContain('.env.production')
    expect(files).not.toContain('server.pem')
    expect(files).not.toContain('app.key')
    // Safe sample files are re-included.
    expect(files).toContain('.env.example')
  })

  it('excludes node_modules/.git at any depth but keeps nested build dirs', () => {
    rmSync(path.join(root, '.gitignore'), { force: true })
    mkdirSync(path.join(root, 'packages', 'a', 'node_modules'), { recursive: true })
    writeFileSync(path.join(root, 'packages', 'a', 'node_modules', 'dep.js'), 'x')
    mkdirSync(path.join(root, 'src', 'dist'), { recursive: true })
    writeFileSync(path.join(root, 'src', 'dist', 'keep.js'), 'x')
    const files = selectSourceFiles(root)
    expect(files.some(f => f.includes('node_modules/'))).toBe(false)
    expect(files).toContain('src/dist/keep.js') // nested dist kept (only root dist drops)
  })

  it('honors nested .gitignore files, not just the root one', () => {
    rmSync(path.join(root, '.gitignore'), { force: true })
    mkdirSync(path.join(root, 'src', 'sub'), { recursive: true })
    writeFileSync(path.join(root, 'src', '.gitignore'), 'sub/\nlocal.json\n')
    writeFileSync(path.join(root, 'src', 'local.json'), '{}')
    writeFileSync(path.join(root, 'src', 'sub', 'ignored.ts'), 'x')
    const files = selectSourceFiles(root)
    expect(files).not.toContain('src/local.json')
    expect(files.some(f => f.startsWith('src/sub/'))).toBe(false)
    expect(files).toContain('src/main.tsx') // sibling source untouched
  })

  it('skips symlinks and does not crash on a dangling one', () => {
    rmSync(path.join(root, '.gitignore'), { force: true })
    symlinkSync('/nonexistent/target', path.join(root, 'dangling'))
    symlinkSync(path.join(root, 'src', 'main.tsx'), path.join(root, 'linked.tsx'))
    let files: string[] = []
    expect(() => {
      files = selectSourceFiles(root)
    }).not.toThrow()
    expect(files).not.toContain('dangling')
    expect(files).not.toContain('linked.tsx')
    expect(files).toContain('src/main.tsx')
  })

  it('returns POSIX-style relative paths, sorted, deterministic', () => {
    expect(selectSourceFiles(root)).toEqual([...selectSourceFiles(root)].sort())
  })
})

describe('selectSourceFilesReporting', () => {
  let root: string
  beforeEach(() => {
    root = scaffold()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('reports what the secret floor removed, not what .gitignore removed', () => {
    // The floor is the exclusion a project cannot infer from its own config:
    // `.gitignore` is the project's own file, and build-output dirs are
    // conventional. Only the floor is invisible, so only it is reported.
    writeFileSync(path.join(root, 'app.pem'), 'x')
    const { files, secretsExcluded } = selectSourceFilesReporting(root)
    expect(secretsExcluded).toEqual(['.env', 'app.pem'])
    expect(files).not.toContain('.env')
    expect(files).not.toContain('app.pem')
    // coverage/ and dist/ are excluded too, but not by the floor.
    expect(secretsExcluded).not.toContain('coverage/report.html')
    expect(secretsExcluded).not.toContain('dist/bundle.js')
  })

  it('reports a nested committed env file — the myth-fff case', () => {
    // app/.env.production is matched by the floor's `.env.*`, so a project can
    // commit it deliberately and still publish a tree without it.
    mkdirSync(path.join(root, 'app'), { recursive: true })
    writeFileSync(path.join(root, 'app', '.env.production'), 'VITE_KEY=abc')
    const { files, secretsExcluded } = selectSourceFilesReporting(root)
    expect(secretsExcluded).toContain('app/.env.production')
    expect(files).not.toContain('app/.env.production')
  })

  it('does not report the re-included example files', () => {
    writeFileSync(path.join(root, '.env.example'), 'KEY=')
    const { files, secretsExcluded } = selectSourceFilesReporting(root)
    expect(secretsExcluded).not.toContain('.env.example')
    expect(files).toContain('.env.example')
  })

  it('agrees with selectSourceFiles, which stays a thin wrapper', () => {
    expect(selectSourceFiles(root)).toEqual(selectSourceFilesReporting(root).files)
  })
})

describe('secretExclusionNotice', () => {
  it('is silent when nothing was excluded', () => {
    expect(secretExclusionNotice([])).toBeNull()
  })

  it('names the files and states the build consequence', () => {
    const notice = secretExclusionNotice(['app/.env.production'])
    expect(notice).toContain('app/.env.production')
    // The consequence a caller cannot otherwise guess: the server-side build
    // runs on the uploaded tree, so it does not see the file either.
    expect(notice).toContain('server-side build')
  })

  it('summarises past five files instead of printing a wall', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => `${n}/.env`)
    const notice = secretExclusionNotice(many)
    expect(notice).toContain('a/.env')
    expect(notice).toContain('e/.env')
    expect(notice).not.toContain('f/.env')
    expect(notice).toContain('and 2 more')
  })
})
