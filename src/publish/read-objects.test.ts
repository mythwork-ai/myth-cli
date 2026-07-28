/**
 * Unit tests for the pull/reconstruct engine — the offline inverse of
 * build-objects.ts. The centerpiece is a round-trip: encode a synthetic
 * file tree with the EXISTING publish machinery, decode it back with this
 * file's NEW materialize machinery, and assert the files come back
 * byte-identical. Everything else is adversarial coverage for malformed or
 * malicious input, mirroring pack-codec.test.ts's style.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { buildObjectsFromFiles, __test__ as buildTest } from './build-objects.js'
import { encodePack, decodePack } from './pack-codec.js'
import {
  inflateFrame,
  parseFrame,
  hashFrame,
  parseTreeEntries,
  indexPackObjects,
  materializeTree,
  planTree,
  ReconstructError,
  type IndexedObject,
} from './read-objects.js'

async function tmpDestDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'myth-pull-'))
}

/** Build a raw tree body by hand — bypasses buildTree's type-safe TreeEntry
 *  shape so adversarial tests can encode modes/names the real encoder would
 *  never produce. This is exactly what a corrupt or malicious server
 *  response would look like: raw bytes, not something built through our
 *  own types. */
function manualTreeBody(entries: Array<{ mode: string; name: string; hashHex: string }>): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  for (const e of entries) {
    parts.push(enc.encode(`${e.mode} ${e.name}\0`))
    const hashBytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) hashBytes[i] = Number.parseInt(e.hashHex.slice(i * 2, i * 2 + 2), 16)
    parts.push(hashBytes)
  }
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const FAKE_HASH_A = 'aa'.repeat(32)
const FAKE_HASH_B = 'bb'.repeat(32)

describe('planTree (in-memory write plan — the seam myth eject reuses)', () => {
  it('returns the same path->bytes plan that materializeTree writes to disk', async () => {
    const enc = new TextEncoder()
    const files = new Map<string, Uint8Array>([
      ['src/main.tsx', enc.encode('export default 1')],
      ['src/nested/util.ts', enc.encode('export const x = 1')],
      ['logo.bin', new Uint8Array([0, 1, 2, 255])],
    ])
    const built = await buildObjectsFromFiles(files)
    const objects = indexPackObjects([...built.objects.values()].map(o => o.deflated))

    const plan = planTree(built.rootTree, objects)
    const byPath = new Map(plan.map(f => [f.relPath, f.content]))
    // Same set of paths, and byte-identical content, as the source tree.
    expect([...byPath.keys()].sort()).toEqual([...files.keys()].sort())
    for (const [rel, bytes] of files) {
      expect(byPath.get(rel)).toEqual(bytes)
    }

    // materializeTree writes exactly this plan — the refactor is behavior-preserving.
    const dest = await tmpDestDir()
    try {
      const result = await materializeTree(built.rootTree, objects, dest)
      expect(result.paths.sort()).toEqual(plan.map(f => f.relPath).sort())
      expect(result.fileCount).toBe(plan.length)
    } finally {
      await rm(dest, { recursive: true, force: true })
    }
  })

  it('validates in memory: throws ReconstructError on a missing object (no disk needed)', () => {
    const objects = new Map<string, IndexedObject>()
    expect(() => planTree(FAKE_HASH_A, objects)).toThrow(ReconstructError)
  })
})

describe('round-trip: buildObjectsFromFiles -> indexPackObjects -> materializeTree', () => {
  it('reconstructs a nested tree, an empty file, binary content, and a unicode filename byte-for-byte', async () => {
    const enc = new TextEncoder()
    const binary = new Uint8Array(256)
    for (let i = 0; i < 256; i++) binary[i] = i
    const files = new Map<string, Uint8Array>([
      ['src/main.tsx', enc.encode('export default 1')],
      ['src/nested/deep/util.ts', enc.encode('export const x = 1')],
      ['package.json', enc.encode('{"name":"x"}')],
      ['empty.txt', new Uint8Array(0)],
      ['assets/binary.bin', binary],
      ['assets/🎉.txt', enc.encode('emoji filename')],
    ])

    const built = await buildObjectsFromFiles(files)
    const objects = indexPackObjects([...built.objects.values()].map(o => o.deflated))

    const destDir = await tmpDestDir()
    try {
      const result = await materializeTree(built.rootTree, objects, destDir)
      expect(result.fileCount).toBe(files.size)

      for (const [relPath, expectedBytes] of files) {
        const actual = await readFile(path.join(destDir, ...relPath.split('/')))
        expect(new Uint8Array(actual)).toEqual(expectedBytes)
      }
    } finally {
      await rm(destDir, { recursive: true, force: true })
    }
  })
})

describe('round-trip: through the real OCPK wire codec (encodePack/decodePack)', () => {
  it('survives a full encode -> decode -> index -> materialize cycle', async () => {
    const enc = new TextEncoder()
    const files = new Map<string, Uint8Array>([
      ['src/App.tsx', enc.encode('export default function App() { return null }')],
      ['README.md', enc.encode('# hello')],
    ])
    const built = await buildObjectsFromFiles(files)
    const pack = encodePack([...built.objects.values()].map(o => o.deflated))
    const decodedEntries = decodePack(pack)
    const objects = indexPackObjects(decodedEntries)

    const destDir = await tmpDestDir()
    try {
      const result = await materializeTree(built.rootTree, objects, destDir)
      expect(result.fileCount).toBe(2)
      for (const [relPath, expectedBytes] of files) {
        const actual = await readFile(path.join(destDir, ...relPath.split('/')))
        expect(new Uint8Array(actual)).toEqual(expectedBytes)
      }
    } finally {
      await rm(destDir, { recursive: true, force: true })
    }
  })
})

describe('inflateFrame', () => {
  it('inflates a valid deflated frame', async () => {
    const blob = await buildTest.buildBlob(new TextEncoder().encode('hello'))
    const framed = inflateFrame(blob.deflated)
    expect(new TextDecoder().decode(framed)).toBe('blob 5\0hello')
  })

  it('throws malformed_object on a corrupt zlib stream', () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03])
    try {
      inflateFrame(garbage)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ReconstructError)
      expect((e as ReconstructError).reason).toBe('malformed_object')
    }
  })

  it('throws malformed_object when inflated output exceeds the size cap (zip-bomb defense)', () => {
    const huge = new Uint8Array(70 * 1024 * 1024) // 70 MiB of zeros — compresses to almost nothing
    const deflated = deflateSync(huge)
    try {
      inflateFrame(deflated)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ReconstructError)
      expect((e as ReconstructError).reason).toBe('malformed_object')
    }
  })
})

describe('parseFrame', () => {
  it('parses a valid blob frame', () => {
    const enc = new TextEncoder()
    const framed = enc.encode('blob 5\0hello')
    const parsed = parseFrame(framed)
    expect(parsed.type).toBe('blob')
    expect(new Uint8Array(parsed.body)).toEqual(enc.encode('hello'))
  })

  it('parses valid tree and commit frames', () => {
    const enc = new TextEncoder()
    expect(parseFrame(enc.encode('tree 0\0')).type).toBe('tree')
    const body = enc.encode('hi')
    expect(parseFrame(enc.encode(`commit ${body.length}\0hi`)).type).toBe('commit')
  })

  it('throws malformed_object when the header terminator is missing', () => {
    const framed = new TextEncoder().encode('blob 5 hello')
    try {
      parseFrame(framed)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ReconstructError).reason).toBe('malformed_object')
    }
  })

  it('throws malformed_object for an unknown type tag', () => {
    const framed = new TextEncoder().encode('widget 5\0hello')
    try {
      parseFrame(framed)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ReconstructError).reason).toBe('malformed_object')
    }
  })

  it('throws malformed_object when declared length does not match body length', () => {
    const framed = new TextEncoder().encode('blob 10\0hello') // declares 10, body is 5
    try {
      parseFrame(framed)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ReconstructError).reason).toBe('malformed_object')
    }
  })
})

describe('hashFrame', () => {
  it('matches the hash the encoder produced for the same object', async () => {
    const blob = await buildTest.buildBlob(new TextEncoder().encode('hello'))
    const framed = inflateFrame(blob.deflated)
    expect(hashFrame(framed)).toBe(blob.hash)
  })
})

describe('parseTreeEntries', () => {
  it('parses a valid multi-entry tree body', () => {
    const body = manualTreeBody([
      { mode: '100644', name: 'a.txt', hashHex: FAKE_HASH_A },
      { mode: '40000', name: 'sub', hashHex: FAKE_HASH_B },
    ])
    expect(parseTreeEntries(body)).toEqual([
      { mode: '100644', name: 'a.txt', hash: FAKE_HASH_A },
      { mode: '40000', name: 'sub', hash: FAKE_HASH_B },
    ])
  })

  it('throws malformed_object on a truncated hash', () => {
    const partial = new TextEncoder().encode('100644 a.txt\0') // no hash bytes at all
    try {
      parseTreeEntries(partial)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ReconstructError).reason).toBe('malformed_object')
    }
  })

  it('throws unsupported_mode for a symlink entry (120000)', () => {
    const body = manualTreeBody([{ mode: '120000', name: 'link', hashHex: FAKE_HASH_A }])
    try {
      parseTreeEntries(body)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ReconstructError)
      expect((e as ReconstructError).reason).toBe('unsupported_mode')
    }
  })

  it('throws malformed_object for a nonsensical mode', () => {
    const body = manualTreeBody([{ mode: 'notamode', name: 'x', hashHex: FAKE_HASH_A }])
    try {
      parseTreeEntries(body)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ReconstructError).reason).toBe('malformed_object')
    }
  })
})

describe('materializeTree — adversarial', () => {
  it('rejects a path-traversal entry name and leaves destDir empty', async () => {
    const objects = new Map<string, IndexedObject>([
      [FAKE_HASH_A, { type: 'blob', body: new TextEncoder().encode('pwned') }],
      [
        FAKE_HASH_B,
        { type: 'tree', body: manualTreeBody([{ mode: '100644', name: '../evil', hashHex: FAKE_HASH_A }]) },
      ],
    ])
    const destDir = await tmpDestDir()
    try {
      await expect(materializeTree(FAKE_HASH_B, objects, destDir)).rejects.toMatchObject({
        reason: 'unsafe_path',
      })
      expect(await readdir(destDir)).toHaveLength(0)
    } finally {
      await rm(destDir, { recursive: true, force: true })
    }
  })

  it('rejects an absolute-path entry name', async () => {
    const objects = new Map<string, IndexedObject>([
      [FAKE_HASH_A, { type: 'blob', body: new TextEncoder().encode('pwned') }],
      [
        FAKE_HASH_B,
        { type: 'tree', body: manualTreeBody([{ mode: '100644', name: '/etc/passwd', hashHex: FAKE_HASH_A }]) },
      ],
    ])
    const destDir = await tmpDestDir()
    try {
      await expect(materializeTree(FAKE_HASH_B, objects, destDir)).rejects.toMatchObject({
        reason: 'unsafe_path',
      })
    } finally {
      await rm(destDir, { recursive: true, force: true })
    }
  })

  it('rejects a bare ".." entry name', async () => {
    const objects = new Map<string, IndexedObject>([
      [FAKE_HASH_A, { type: 'blob', body: new TextEncoder().encode('x') }],
      [FAKE_HASH_B, { type: 'tree', body: manualTreeBody([{ mode: '40000', name: '..', hashHex: FAKE_HASH_A }]) }],
    ])
    const destDir = await tmpDestDir()
    try {
      await expect(materializeTree(FAKE_HASH_B, objects, destDir)).rejects.toMatchObject({
        reason: 'unsafe_path',
      })
    } finally {
      await rm(destDir, { recursive: true, force: true })
    }
  })

  it('throws missing_object when a referenced blob hash is absent, and leaves destDir empty', async () => {
    const enc = new TextEncoder()
    const files = new Map<string, Uint8Array>([
      ['a.txt', enc.encode('a')],
      ['b.txt', enc.encode('b')],
    ])
    const built = await buildObjectsFromFiles(files)
    const allObjects = indexPackObjects([...built.objects.values()].map(o => o.deflated))

    // Drop one blob's entry to simulate a corrupt/incomplete pack.
    const blobHashes = [...allObjects.entries()].filter(([, o]) => o.type === 'blob').map(([h]) => h)
    const incomplete = new Map(allObjects)
    incomplete.delete(blobHashes[0]!)

    const destDir = await tmpDestDir()
    try {
      await expect(materializeTree(built.rootTree, incomplete, destDir)).rejects.toMatchObject({
        reason: 'missing_object',
      })
      expect(await readdir(destDir)).toHaveLength(0)
    } finally {
      await rm(destDir, { recursive: true, force: true })
    }
  })

  it('throws malformed_object when the root hash points at a blob instead of a tree', async () => {
    const objects = new Map<string, IndexedObject>([
      [FAKE_HASH_A, { type: 'blob', body: new TextEncoder().encode('not a tree') }],
    ])
    const destDir = await tmpDestDir()
    try {
      await expect(materializeTree(FAKE_HASH_A, objects, destDir)).rejects.toMatchObject({
        reason: 'malformed_object',
      })
    } finally {
      await rm(destDir, { recursive: true, force: true })
    }
  })
})
