import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { selectSourceFiles } from './source-select.js'

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
