import { describe, expect, it, vi } from 'vitest'
import { printPublishWarnings } from './index.js'

function captureLogs(fn: () => void): string[] {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.join(' '))
  })
  try {
    fn()
  } finally {
    spy.mockRestore()
  }
  return lines
}

const hp = (name: string) => `Ignoring ${name}@workspace:*; this app uses the host-provided ${name}@1.0.0 instead.`

describe('printPublishWarnings (AGE-78 host-provided collapse)', () => {
  it('collapses 3+ host-provided warnings into ONE summary naming the deps', () => {
    const w = [
      hp('@orbitcode/auth'),
      hp('@orbitcode/kernel'),
      hp('@orbitcode/host-iframe'),
      hp('@orbitcode/collab'),
    ]
    const out = captureLogs(() => printPublishWarnings(w))
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('4 host-provided deps skipped')
    expect(out[0]).toContain('@orbitcode/auth, @orbitcode/kernel, @orbitcode/host-iframe')
    expect(out[0]).toContain('+1 more')
  })

  it('keeps 1–2 host-provided warnings as full per-dep lines', () => {
    const w = [hp('@orbitcode/auth'), hp('@orbitcode/kernel')]
    const out = captureLogs(() => printPublishWarnings(w))
    expect(out).toHaveLength(2)
    expect(out[0]).toContain('host-provided @orbitcode/auth@1.0.0')
  })

  it('prints non-host-provided warnings individually alongside the collapse', () => {
    const w = [hp('@orbitcode/auth'), hp('@orbitcode/kernel'), hp('@orbitcode/db'), 'Something else entirely happened.']
    const out = captureLogs(() => printPublishWarnings(w))
    expect(out.some(l => l.includes('3 host-provided deps skipped'))).toBe(true)
    expect(out.some(l => l.includes('Something else entirely happened.'))).toBe(true)
    expect(out).toHaveLength(2)
  })

  it('no warnings → no output', () => {
    expect(captureLogs(() => printPublishWarnings([]))).toHaveLength(0)
  })
})
