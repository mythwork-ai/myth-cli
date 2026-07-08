/**
 * Tests for shouldStreamBuildStatus — the pure decision of whether to
 * stream (and block on) build status after a finalize.
 *
 * Regression coverage for the incident where a Tier-2 (deferred) build
 * failed with `no_lockfile` after a non-TTY CI invocation exited 0
 * immediately without ever checking build status: the alias never
 * promoted, but the GitHub Actions job reported green throughout.
 */

import { describe, expect, it } from 'vitest'
import { shouldStreamBuildStatus } from './index.js'

describe('shouldStreamBuildStatus', () => {
  const cases: Array<{
    name: string
    opts: { noWait?: boolean; watch?: boolean; isTTY: boolean; deferred: boolean }
    expected: boolean
  }> = [
    {
      name: 'deferred + non-TTY + no flags → true (the bug fix: always block on Tier-2)',
      opts: { noWait: false, watch: false, isTTY: false, deferred: true },
      expected: true,
    },
    {
      name: 'non-deferred + non-TTY + no flags → false (Tier-1 CI default unchanged)',
      opts: { noWait: false, watch: false, isTTY: false, deferred: false },
      expected: false,
    },
    {
      name: 'non-deferred + TTY → true (existing TTY behavior unchanged)',
      opts: { noWait: false, watch: false, isTTY: true, deferred: false },
      expected: true,
    },
    {
      name: '--no-wait overrides even when deferred → false',
      opts: { noWait: true, watch: false, isTTY: false, deferred: true },
      expected: false,
    },
    {
      name: '--watch forces streaming for non-deferred in non-TTY → true (existing override unchanged)',
      opts: { noWait: false, watch: true, isTTY: false, deferred: false },
      expected: true,
    },
  ]

  for (const { name, opts, expected } of cases) {
    it(`${name}`, () => {
      expect(shouldStreamBuildStatus(opts)).toBe(expected)
    })
  }
})
