import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
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

  it('works with no .gitignore (heuristic excludes only)', () => {
    rmSync(path.join(root, '.gitignore'), { force: true })
    const files = selectSourceFiles(root)
    expect(files).toContain('src/main.tsx')
    expect(files.some(f => f.startsWith('node_modules/'))).toBe(false)
    expect(files).toContain('.env') // no gitignore → heuristic doesn't drop .env
  })

  it('returns POSIX-style relative paths, sorted, deterministic', () => {
    expect(selectSourceFiles(root)).toEqual([...selectSourceFiles(root)].sort())
  })
})
