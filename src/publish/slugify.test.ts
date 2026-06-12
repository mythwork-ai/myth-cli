import { describe, expect, it } from 'vitest'
import { slugifyLocalId } from './index.js'

describe('slugifyLocalId (AGE-67 stable provision key)', () => {
  it('keeps a clean name as-is', () => {
    expect(slugifyLocalId('website-tennis')).toBe('website-tennis')
  })
  it('lowercases + collapses non-alphanumerics to single hyphens', () => {
    expect(slugifyLocalId('My Cool App!!')).toBe('my-cool-app')
    expect(slugifyLocalId('Foo___Bar  Baz')).toBe('foo-bar-baz')
  })
  it('trims leading/trailing hyphens', () => {
    expect(slugifyLocalId('  spaced  ')).toBe('spaced')
    expect(slugifyLocalId('--edgy--')).toBe('edgy')
  })
  it('falls back to "app" for empty/symbol-only names (stable, never empty)', () => {
    expect(slugifyLocalId('')).toBe('app')
    expect(slugifyLocalId('!!!')).toBe('app')
  })
  it('is deterministic — same name → same key (idempotent provisioning relies on this)', () => {
    expect(slugifyLocalId('Tennis Blog')).toBe(slugifyLocalId('Tennis Blog'))
  })
})
