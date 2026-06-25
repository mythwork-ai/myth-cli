/**
 * One-line progress printer for `myth publish` uploads.
 *
 * Uses simple `\r` carriage-return rewrites if stdout is a TTY, falling
 * back to a per-update newline when piped (so logs stay readable). No
 * ANSI escape sequences beyond `\r` — the spec asks for "boring and
 * pipe-safe".
 *
 * `current`/`total` are unitless; pass `formatValue` to label them (e.g.
 * bytes as "12.3 MB"). Updates can arrive at any granularity — the bar is
 * driven by the `current/total` ratio, so byte-level updates render a
 * smoothly-filling bar, not just one jump at the end.
 */

export interface ProgressPrinter {
  update(current: number, total: number): void
  finish(): void
}

export function createProgress(
  label: string,
  isTty: boolean,
  formatValue: (n: number) => string = String,
): ProgressPrinter {
  let lastLen = 0
  // Piped mode: track the last 10% bucket we logged so a flood of fine-grained
  // (e.g. byte-level) updates collapses to ~10 lines, not hundreds.
  let lastBucket = -1
  return {
    update(current, total) {
      if (isTty) {
        const line = `[myth] ${label} ${renderBar(current, total)} ${formatValue(current)}/${formatValue(total)}`
        process.stdout.write('\r' + line + ' '.repeat(Math.max(0, lastLen - line.length)))
        lastLen = line.length
      } else {
        // Piped: emit on each 10%-bucket crossing (and at completion) so logs
        // stay readable regardless of how often update() is called.
        const bucket = total <= 0 ? 10 : Math.floor((current / total) * 10)
        if (current >= total || bucket > lastBucket) {
          lastBucket = bucket
          process.stdout.write(`[myth] ${label} ${formatValue(current)}/${formatValue(total)}\n`)
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
