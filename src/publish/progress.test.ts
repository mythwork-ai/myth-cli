/**
 * Tests for the upload progress printer.
 *
 * stdout is captured via a spy so we can assert exactly what the user sees —
 * the \r-rewritten bar in TTY mode and the throttled line stream when piped.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProgress } from './progress.js'
import { formatBytes } from './index.js'

function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
  return { writes, restore: () => spy.mockRestore() }
}

afterEach(() => vi.restoreAllMocks())

describe('createProgress — TTY mode', () => {
  it('redraws on \\r and fills the bar proportionally as bytes arrive', () => {
    const { writes, restore } = captureStdout()
    const p = createProgress('Uploading', true, formatBytes)
    p.update(0, 1000)
    p.update(500, 1000)
    p.update(1000, 1000)
    p.finish()
    restore()

    // Every update is a single \r-prefixed rewrite (no newlines until finish).
    expect(writes[0]!.startsWith('\r')).toBe(true)
    expect(writes[0]).toContain('[----------') // 0% → empty bar
    expect(writes[1]).toContain('##########----------') // 50% → half full
    expect(writes[2]).toContain('####################') // 100% → full bar
    // Values are byte-formatted, not raw counts.
    expect(writes[2]).toContain('1000 B/1000 B')
    // finish() terminates the line.
    expect(writes.at(-1)).toBe('\n')
  })

  it('formats values with the supplied formatter (MB)', () => {
    const { writes, restore } = captureStdout()
    const p = createProgress('Uploading', true, formatBytes)
    const mb = 1024 * 1024
    p.update(mb, 5 * mb)
    restore()
    expect(writes[0]).toContain('1.0 MB/5.0 MB')
  })
})

describe('createProgress — piped mode', () => {
  it('throttles fine-grained updates to ~one line per 10% bucket, always ending at 100%', () => {
    const { writes, restore } = captureStdout()
    const p = createProgress('Uploading', false, formatBytes)
    // 100 byte-level updates over a 1000-byte transfer.
    for (let i = 1; i <= 100; i++) p.update(i * 10, 1000)
    p.finish() // no trailing newline in piped mode
    restore()

    // No carriage returns when piped; each emitted line ends in \n.
    for (const w of writes) {
      expect(w.startsWith('\r')).toBe(false)
      expect(w.endsWith('\n')).toBe(true)
    }
    // ~10 buckets (0..9 crossings) plus the final 100% line — far fewer than 100.
    expect(writes.length).toBeLessThanOrEqual(12)
    expect(writes.length).toBeGreaterThanOrEqual(10)
    expect(writes.at(-1)).toContain('1000 B/1000 B')
  })

  it('defaults to String formatting (raw counts) when no formatter is given', () => {
    const { writes, restore } = captureStdout()
    const p = createProgress('Uploading', false)
    p.update(10, 10)
    restore()
    expect(writes[0]).toBe('[myth] Uploading 10/10\n')
  })
})
