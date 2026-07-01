/**
 * Tests for myth publish flag parsing (parsePubArgs).
 *
 * parsePubArgs is a pure function — no process.exit, no imports — so it
 * can be tested synchronously without mocking the entire publish pipeline.
 */

import { describe, expect, it } from 'vitest'
import { parsePubArgs } from './myth.js'

describe('parsePubArgs — --subscribe', () => {
  it('parses --subscribe <tree> and sets subscribeTree', () => {
    const tree = 'a'.repeat(64)
    const result = parsePubArgs(['--subscribe', tree])
    expect(result.subscribeTree).toBe(tree)
  })

  it('parses --subscribe=<tree> (equals syntax)', () => {
    const tree = 'b'.repeat(64)
    const result = parsePubArgs([`--subscribe=${tree}`])
    expect(result.subscribeTree).toBe(tree)
  })

  it('combines --subscribe with --staging', () => {
    const tree = 'c'.repeat(64)
    const result = parsePubArgs(['--subscribe', tree, '--staging'])
    expect(result.subscribeTree).toBe(tree)
    expect(result.staging).toBe(true)
  })

  it('combines --subscribe with --api', () => {
    const tree = 'd'.repeat(64)
    const result = parsePubArgs(['--subscribe', tree, '--api', 'http://localhost:8787'])
    expect(result.subscribeTree).toBe(tree)
    expect(result.apiUrl).toBe('http://localhost:8787')
  })

  it('leaves subscribeTree undefined when --subscribe is absent', () => {
    const result = parsePubArgs(['--name', 'my-app'])
    expect(result.subscribeTree).toBeUndefined()
  })
})

describe('parsePubArgs — --no-wait', () => {
  it('sets noWait to true when --no-wait is present', () => {
    const result = parsePubArgs(['--no-wait'])
    expect(result.noWait).toBe(true)
  })

  it('defaults noWait to false when absent', () => {
    const result = parsePubArgs([])
    expect(result.noWait).toBe(false)
  })

  it('works alongside --name and --staging', () => {
    const result = parsePubArgs(['--name', 'demo', '--staging', '--no-wait'])
    expect(result.noWait).toBe(true)
    expect(result.shortName).toBe('demo')
    expect(result.staging).toBe(true)
  })
})

describe('parsePubArgs — --watch', () => {
  it('sets watch to true when --watch is present', () => {
    const result = parsePubArgs(['--watch'])
    expect(result.watch).toBe(true)
  })

  it('defaults watch to false when absent', () => {
    const result = parsePubArgs([])
    expect(result.watch).toBe(false)
  })
})

describe('parsePubArgs — existing flags still work', () => {
  it('parses --name', () => {
    const result = parsePubArgs(['--name', 'my-app'])
    expect(result.shortName).toBe('my-app')
    expect(result.apex).toBe(false)
  })

  it('maps --name ~apex to apex=true and no shortName', () => {
    const result = parsePubArgs(['--name', '~apex'])
    expect(result.apex).toBe(true)
    expect(result.shortName).toBeUndefined()
  })

  it('parses --default as apex=true', () => {
    const result = parsePubArgs(['--default'])
    expect(result.apex).toBe(true)
  })

  it('parses --force', () => {
    const result = parsePubArgs(['--force'])
    expect(result.force).toBe(true)
  })

  it('parses --staging', () => {
    const result = parsePubArgs(['--staging'])
    expect(result.staging).toBe(true)
  })

  it('all flags default to false/undefined when absent', () => {
    const result = parsePubArgs([])
    expect(result).toEqual({
      subscribeTree: undefined,
      shortName: undefined,
      apiUrl: undefined,
      staging: false,
      apex: false,
      force: false,
      noWait: false,
      watch: false,
    })
  })
})
