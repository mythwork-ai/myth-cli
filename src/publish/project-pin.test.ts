/**
 * Tests for `resolvePinnedProjectId` — the precedence that lets one committed
 * name-only myth.config.json serve both stages in CI: `MYTH_PROJECT_ID` (set
 * per stage by the workflow, each owning a DIFFERENT pid) wins over a committed
 * `config.projectId`; with neither set the caller is name-only (undefined ⇒
 * resolve via the idempotent provision lookup). A blank/whitespace env value is
 * treated as unset.
 */

import { describe, expect, it } from 'vitest'
import { resolvePinnedProjectId } from './index.js'

describe('resolvePinnedProjectId', () => {
  it('returns config.projectId when MYTH_PROJECT_ID is unset', () => {
    expect(resolvePinnedProjectId({ projectId: 'cfgpid0000000000' }, {})).toBe('cfgpid0000000000')
  })

  it('returns undefined for a name-only config with no env pin', () => {
    expect(resolvePinnedProjectId({}, {})).toBeUndefined()
  })

  it('MYTH_PROJECT_ID wins over a committed config.projectId', () => {
    expect(
      resolvePinnedProjectId({ projectId: 'cfgpid0000000000' }, { MYTH_PROJECT_ID: 'envpid1111111111' }),
    ).toBe('envpid1111111111')
  })

  it('MYTH_PROJECT_ID pins a name-only config (the CI case)', () => {
    expect(resolvePinnedProjectId({}, { MYTH_PROJECT_ID: 'envpid1111111111' })).toBe('envpid1111111111')
  })

  it('trims surrounding whitespace from MYTH_PROJECT_ID', () => {
    expect(resolvePinnedProjectId({}, { MYTH_PROJECT_ID: '  envpid1111111111\n' })).toBe(
      'envpid1111111111',
    )
  })

  it('treats a blank/whitespace MYTH_PROJECT_ID as unset (falls back to config)', () => {
    expect(resolvePinnedProjectId({ projectId: 'cfgpid0000000000' }, { MYTH_PROJECT_ID: '   ' })).toBe(
      'cfgpid0000000000',
    )
    expect(resolvePinnedProjectId({}, { MYTH_PROJECT_ID: '' })).toBeUndefined()
  })
})
