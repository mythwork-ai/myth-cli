/**
 * Tests for `unpackExport` — the CLI decoder for the server's path-tagged OCPK
 * export pack. The golden-bytes test is the cross-repo conformance pin: the same
 * byte string is asserted in mythwork's api.eject.test.ts (packExport side), so
 * the hand-synced wire format can't silently drift between producer and consumer.
 */

import { describe, expect, it } from 'vitest'
import { encodePack, encodeVarint, PackDecodeError } from './pack-codec.js'
import { unpackExport } from './export-pack.js'

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

describe('unpackExport', () => {
  it('golden conformance: shared cross-repo wire bytes decode to the exact fileMap (F2)', () => {
    // IDENTICAL byte string to mythwork's api.eject.test.ts packExport golden
    // test. If the OCPK / varint framing drifts between packExport (server) and
    // unpackExport (here), one of the two suites fails — the format is pinned.
    const GOLDEN = '4f43504b01030805612e74787468690d0b7372632f4170702e747378780906cf802e62696e00ff'
    const files = unpackExport(fromHex(GOLDEN))
    expect([...files.keys()].sort()).toEqual(['a.txt', 'src/App.tsx', 'π.bin'].sort())
    expect(new Uint8Array(files.get('a.txt')!)).toEqual(new Uint8Array([0x68, 0x69]))
    expect(new Uint8Array(files.get('src/App.tsx')!)).toEqual(new Uint8Array([0x78]))
    expect(new Uint8Array(files.get('π.bin')!)).toEqual(new Uint8Array([0x00, 0xff]))
  })

  it('round-trips a fileMap encoded with the same framing packExport uses', () => {
    const enc = new TextEncoder()
    const src: Array<[string, Uint8Array]> = [
      ['x.ts', enc.encode('hello')],
      ['assets/logo.bin', new Uint8Array([0, 1, 2, 255])],
    ]
    const entries = src.map(([p, bytes]) => {
      const pb = enc.encode(p)
      const lv = encodeVarint(pb.length)
      const e = new Uint8Array(lv.length + pb.length + bytes.length)
      e.set(lv, 0)
      e.set(pb, lv.length)
      e.set(bytes, lv.length + pb.length)
      return e
    })
    const files = unpackExport(encodePack(entries))
    expect(new Uint8Array(files.get('x.ts')!)).toEqual(enc.encode('hello'))
    expect(new Uint8Array(files.get('assets/logo.bin')!)).toEqual(new Uint8Array([0, 1, 2, 255]))
  })

  it('throws on a malformed entry whose declared path length exceeds the entry (F3)', () => {
    const short = new Uint8Array([0x61]) // 1 body byte
    const lv = encodeVarint(100) // but claims a 100-byte path
    const entry = new Uint8Array(lv.length + short.length)
    entry.set(lv, 0)
    entry.set(short, lv.length)
    expect(() => unpackExport(encodePack([entry]))).toThrow(PackDecodeError)
  })
})
