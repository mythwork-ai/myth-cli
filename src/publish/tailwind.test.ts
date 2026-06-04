import { describe, it, expect } from 'vitest'
import { detectTailwind } from './tailwind.js'

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
