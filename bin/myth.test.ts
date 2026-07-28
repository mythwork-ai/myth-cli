/**
 * Tests for myth publish flag parsing (parsePubArgs) and `myth clone`.
 *
 * parsePubArgs is a pure function — no process.exit, no imports — so it
 * can be tested synchronously without mocking the entire publish pipeline.
 */

import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  clone,
  isNonEmptyDirectory,
  parseEjectArgs,
  parsePubArgs,
  parsePullArgs,
  pull,
  type CloneRunner,
} from './myth.js'

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

describe('clone', () => {
  it('passes the repo URL as its own argv element, never through a shell', async () => {
    const runner: CloneRunner = vi.fn(async () => {})
    await clone('reveal', runner)
    expect(runner).toHaveBeenCalledWith('git', [
      'clone',
      'https://github.com/mythwork-ai/reveal',
    ])
  })

  it('does not let shell metacharacters in <name> escape the clone argument (regression for the execSync injection)', async () => {
    const runner: CloneRunner = vi.fn(async () => {})
    const maliciousName = 'x; rm -rf ~'
    await clone(maliciousName, runner)

    // The dangerous payload must arrive as a single argv element appended
    // to `git clone`, not spliced into a command string a shell could
    // split on `;`. With execFile/argv there is no shell in the loop, so
    // "rm" is never a command of its own — it's just part of one (invalid)
    // URL argument.
    expect(runner).toHaveBeenCalledTimes(1)
    const [cmd, cmdArgs] = (runner as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string[],
    ]
    expect(cmd).toBe('git')
    expect(cmdArgs).toEqual(['clone', `https://github.com/mythwork-ai/${maliciousName}`])
    expect(cmdArgs).not.toContain('rm')
    expect(cmdArgs.some((a) => a.includes(';'))).toBe(true) // it's inert text inside one arg
  })

  it('prints Usage and does not invoke the runner when name is missing', async () => {
    const runner: CloneRunner = vi.fn(async () => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(clone(undefined, runner)).rejects.toThrow('process.exit called')

    expect(errorSpy).toHaveBeenCalledWith('Usage: myth clone <name>')
    expect(runner).not.toHaveBeenCalled()

    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('reports failure and exits when the runner rejects', async () => {
    const runner: CloneRunner = vi.fn(async () => {
      throw new Error('git clone failed')
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(clone('reveal', runner)).rejects.toThrow('process.exit called')

    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to clone https://github.com/mythwork-ai/reveal',
    )

    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })
})

describe('parsePullArgs', () => {
  it('parses a positional name', () => {
    const result = parsePullArgs(['my-app'])
    expect(result.name).toBe('my-app')
    expect(result.staging).toBe(false)
  })

  it('parses --staging, --api, --dir alongside the name', () => {
    const result = parsePullArgs([
      'my-app',
      '--staging',
      '--api',
      'http://localhost:8787',
      '--dir',
      'somewhere',
    ])
    expect(result.name).toBe('my-app')
    expect(result.staging).toBe(true)
    expect(result.apiUrl).toBe('http://localhost:8787')
    expect(result.dir).toBe('somewhere')
  })

  it('supports --dir=value form', () => {
    const result = parsePullArgs(['my-app', '--dir=elsewhere'])
    expect(result.dir).toBe('elsewhere')
  })

  it('leaves name undefined when the first arg is a flag', () => {
    const result = parsePullArgs(['--staging'])
    expect(result.name).toBeUndefined()
    expect(result.staging).toBe(true)
  })

  it('leaves name undefined when args are empty', () => {
    const result = parsePullArgs([])
    expect(result.name).toBeUndefined()
  })
})

describe('parseEjectArgs', () => {
  it('parses a positional name', () => {
    const result = parseEjectArgs(['my-app'])
    expect(result.name).toBe('my-app')
    expect(result.staging).toBe(false)
    expect(result.pkgName).toBeUndefined()
  })

  it('parses --staging, --api, --dir, --pkg-name alongside the name', () => {
    const result = parseEjectArgs([
      'my-app',
      '--staging',
      '--api',
      'http://localhost:8787',
      '--dir',
      'somewhere',
      '--pkg-name',
      'renamed',
    ])
    expect(result.name).toBe('my-app')
    expect(result.staging).toBe(true)
    expect(result.apiUrl).toBe('http://localhost:8787')
    expect(result.dir).toBe('somewhere')
    expect(result.pkgName).toBe('renamed')
  })

  it('supports --pkg-name=value form', () => {
    const result = parseEjectArgs(['my-app', '--pkg-name=renamed'])
    expect(result.pkgName).toBe('renamed')
  })

  it('keeps the positional alias distinct from --pkg-name', () => {
    // The positional is the published alias to fetch; --pkg-name only renames
    // the emitted package.json — they must never collide.
    const result = parseEjectArgs(['my-app', '--pkg-name', 'renamed'])
    expect(result.name).toBe('my-app')
    expect(result.pkgName).toBe('renamed')
  })

  it('leaves name undefined when the first arg is a flag', () => {
    const result = parseEjectArgs(['--staging'])
    expect(result.name).toBeUndefined()
    expect(result.staging).toBe(true)
  })
})

describe('isNonEmptyDirectory', () => {
  it('is false for a directory that does not exist', () => {
    expect(isNonEmptyDirectory(path.join(os.tmpdir(), 'myth-does-not-exist-xyz'))).toBe(false)
  })

  it('is false for an existing empty directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'myth-empty-'))
    try {
      expect(isNonEmptyDirectory(dir)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is true for an existing non-empty directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'myth-nonempty-'))
    try {
      await writeFile(path.join(dir, 'existing.txt'), 'x')
      expect(isNonEmptyDirectory(dir)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('pull', () => {
  it('prints Usage and does not touch the filesystem when name is missing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(pull([])).rejects.toThrow('process.exit called')

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: myth pull <name>'),
    )

    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('refuses to pull into an existing non-empty directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'myth-pull-guard-'))
    await writeFile(path.join(dir, 'existing.txt'), 'x')

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(pull(['my-app', '--dir', dir])).rejects.toThrow('process.exit called')
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('non-empty directory'),
      )
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
