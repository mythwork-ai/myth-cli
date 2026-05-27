/**
 * One-line progress printer for `myth publish` uploads.
 *
 * Uses simple `\r` carriage-return rewrites if stdout is a TTY, falling
 * back to a per-update newline when piped (so logs stay readable). No
 * ANSI escape sequences beyond `\r` — the spec asks for "boring and
 * pipe-safe".
 */

export interface ProgressPrinter {
  update(current: number, total: number): void
  finish(): void
}

export function createProgress(label: string, isTty: boolean): ProgressPrinter {
  let lastLen = 0
  return {
    update(current, total) {
      if (isTty) {
        const line = `[myth] ${label} ${renderBar(current, total)} ${current}/${total}`
        process.stdout.write('\r' + line + ' '.repeat(Math.max(0, lastLen - line.length)))
        lastLen = line.length
      } else {
        // Piped: one line per update would be noisy at 100 files. Emit
        // every 10% (or at completion) instead.
        if (current === total || total <= 10 || current % Math.max(1, Math.floor(total / 10)) === 0) {
          process.stdout.write(`[myth] ${label} ${current}/${total}\n`)
        }
      }
    },
    finish() {
      if (isTty && lastLen > 0) {
        process.stdout.write('\n')
        lastLen = 0
      }
    },
  }
}

/** 20-char bar. `#` for done, `-` for pending. */
function renderBar(current: number, total: number): string {
  const width = 20
  const ratio = total === 0 ? 1 : current / total
  const filled = Math.min(width, Math.max(0, Math.round(ratio * width)))
  return '[' + '#'.repeat(filled) + '-'.repeat(width - filled) + ']'
}
