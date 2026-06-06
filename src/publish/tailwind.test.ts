import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { detectTailwind, findTailwindEntry, prebakeTailwind } from './tailwind.js'

describe('detectTailwind', () => {
  it('detects tailwind via the tailwindcss dependency', () => {
    expect(detectTailwind({ tailwindcss: '4.0.0' })).toBe(true)
  })
  it('detects tailwind via a @tailwindcss/* dependency', () => {
    expect(detectTailwind({ '@tailwindcss/vite': '4.0.0' })).toBe(true)
  })
  it('returns false when absent', () => {
    expect(detectTailwind({ react: '19.0.0' })).toBe(false)
  })
  it('returns false for empty deps', () => {
    expect(detectTailwind({})).toBe(false)
  })
})

describe('findTailwindEntry', () => {
  const contents: Record<string, string> = {
    '/p/src/reset.css': 'body{margin:0}',
    '/p/src/index.css': '@import "tailwindcss";\n',
    '/p/src/legacy.css': '@tailwind base;\n',
  }
  const read = (p: string): string => contents[p] ?? ''

  it('picks the CSS file containing @import "tailwindcss" (not the first CSS)', () => {
    const files = ['src/reset.css', 'src/index.css']
    expect(findTailwindEntry('/p', files, read)).toBe('src/index.css')
  })

  it('also recognizes the legacy @tailwind directive', () => {
    expect(findTailwindEntry('/p', ['src/legacy.css'], read)).toBe('src/legacy.css')
  })

  it('ignores non-css files and returns undefined when no entry imports tailwind', () => {
    expect(findTailwindEntry('/p', ['src/main.tsx', 'src/reset.css'], read)).toBeUndefined()
  })

  it('skips files that cannot be read', () => {
    const throwRead = (): string => {
      throw new Error('boom')
    }
    expect(findTailwindEntry('/p', ['src/index.css'], throwRead)).toBeUndefined()
  })
})

describe('prebakeTailwind', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'myth-tw-test-'))
    writeFileSync(path.join(root, 'index.css'), '@import "tailwindcss";')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('throws when the entry stylesheet is missing', () => {
    expect(() => prebakeTailwind(root, 'nope.css')).toThrow(/entry CSS not found/i)
  })

  it('returns compiled CSS without mutating the entry file', () => {
    let ran: { input: string; out: string } | undefined
    const result = prebakeTailwind(root, 'index.css', {
      runTailwind: (_r, input, out) => {
        ran = { input, out }
      },
      readFile: () => '.text-red-500{color:red}',
    })
    expect(result.generatedCssPath).toBe('index.css')
    expect(result.css).toBe('.text-red-500{color:red}')
    expect(ran?.input).toBe(path.join(root, 'index.css'))
    // The user's source on disk is untouched (override is in-memory only).
    expect(readFileSync(path.join(root, 'index.css'), 'utf-8')).toBe('@import "tailwindcss";')
  })

  it('wraps generation failures in an actionable error', () => {
    expect(() =>
      prebakeTailwind(root, 'index.css', {
        runTailwind: () => {
          throw new Error('npx not found')
        },
      }),
    ).toThrow(/Tailwind generation failed.*npx not found/s)
  })
})
