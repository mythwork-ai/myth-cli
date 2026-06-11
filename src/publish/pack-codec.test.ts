/**
 * Vendored codec tests — adapted from shared/pack/codec.test.ts (ocpk-pack
 * branch). Import paths updated for the myth-cli vendored copy; otherwise
 * identical to the canonical source.
 */
import { describe, it, expect } from 'vitest'
import { encodePack, decodePack, PackDecodeError, encodeVarint, decodeVarint } from './pack-codec.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function makeEntry(size: number, fill = 0xaa): Uint8Array {
  const buf = new Uint8Array(size)
  buf.fill(fill)
  return buf
}

// ---------------------------------------------------------------------------
// encodeVarint / decodeVarint
// ---------------------------------------------------------------------------

describe('encodeVarint', () => {
  it('encodes 0 as a single zero byte', () => {
    expect(encodeVarint(0)).toEqual(new Uint8Array([0x00]))
  })

  it('encodes 127 as a single byte', () => {
    expect(encodeVarint(127)).toEqual(new Uint8Array([0x7f]))
  })

  it('encodes 128 as two bytes (LEB-128 boundary)', () => {
    expect(encodeVarint(128)).toEqual(new Uint8Array([0x80, 0x01]))
  })

  it('encodes 16383 (0x3FFF) as two bytes', () => {
    expect(encodeVarint(16383)).toEqual(new Uint8Array([0xff, 0x7f]))
  })

  it('encodes 16384 (0x4000) as three bytes', () => {
    expect(encodeVarint(16384)).toEqual(new Uint8Array([0x80, 0x80, 0x01]))
  })

  it('encodes 40*1024*1024 (40 MiB) within 5 bytes', () => {
    const v = encodeVarint(40 * 1024 * 1024)
    expect(v.length).toBeLessThanOrEqual(5)
  })

  it('throws for negative values', () => {
    expect(() => encodeVarint(-1)).toThrow(RangeError)
  })

  it('throws for non-integer values', () => {
    expect(() => encodeVarint(1.5)).toThrow(RangeError)
  })
})

describe('decodeVarint round-trip', () => {
  const values = [0, 1, 127, 128, 255, 16383, 16384, 40 * 1024 * 1024, 0xffff_ffff]

  for (const v of values) {
    it(`round-trips value ${v}`, () => {
      const encoded = encodeVarint(v)
      const buf = new Uint8Array(encoded.length + 2)
      buf.set(encoded, 0)
      const result = decodeVarint(buf, 0, 'truncated_header', 'varint_too_long')
      expect(result.value).toBe(v >>> 0) // unsigned
      expect(result.bytesRead).toBe(encoded.length)
    })
  }

  it('throws truncated_header when buffer is too short', () => {
    const buf = new Uint8Array([0x80]) // continuation bit set but no next byte
    expect(() => decodeVarint(buf, 0, 'truncated_header', 'varint_too_long')).toThrow(
      PackDecodeError,
    )
    try {
      decodeVarint(buf, 0, 'truncated_header', 'varint_too_long')
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).reason).toBe('truncated_header')
    }
  })

  it('throws varint_too_long when varint exceeds 5 bytes', () => {
    // 6 bytes with continuation bits set -> too long
    const buf = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00])
    expect(() => decodeVarint(buf, 0, 'truncated_header', 'varint_too_long')).toThrow(
      PackDecodeError,
    )
    try {
      decodeVarint(buf, 0, 'truncated_header', 'varint_too_long')
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).reason).toBe('varint_too_long')
    }
  })

  it('passes entryIndex through in the thrown error', () => {
    const buf = new Uint8Array([0x80]) // truncated
    try {
      decodeVarint(buf, 0, 'truncated_entry', 'varint_too_long', 3)
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).entryIndex).toBe(3)
    }
  })
})

// ---------------------------------------------------------------------------
// Round-trip: 0 entries
// ---------------------------------------------------------------------------

describe('round-trip: 0 entries', () => {
  it('encodes and decodes an empty pack', () => {
    const pack = encodePack([])
    const entries = decodePack(pack)
    expect(entries).toHaveLength(0)
  })

  it('produces the minimal header (magic + version + count=0)', () => {
    const pack = encodePack([])
    // "OCPK" + 0x01 + 0x00 = 6 bytes
    expect(pack.length).toBe(6)
    expect(pack[0]).toBe(0x4f) // O
    expect(pack[1]).toBe(0x43) // C
    expect(pack[2]).toBe(0x50) // P
    expect(pack[3]).toBe(0x4b) // K
    expect(pack[4]).toBe(0x01) // format
    expect(pack[5]).toBe(0x00) // count = 0
  })
})

// ---------------------------------------------------------------------------
// Round-trip: 1 entry
// ---------------------------------------------------------------------------

describe('round-trip: 1 entry', () => {
  it('encodes and decodes a single small entry', () => {
    const entry = new Uint8Array([1, 2, 3, 4, 5])
    const pack = encodePack([entry])
    const [decoded] = decodePack(pack)
    expect(bytesEqual(decoded!, entry)).toBe(true)
  })

  it('handles an empty entry (length = 0)', () => {
    const pack = encodePack([new Uint8Array(0)])
    const [decoded] = decodePack(pack)
    expect(decoded).toBeInstanceOf(Uint8Array)
    expect(decoded!.length).toBe(0)
  })

  it('handles binary bytes including 0x00 and 0xFF', () => {
    const entry = new Uint8Array(256)
    for (let i = 0; i < 256; i++) entry[i] = i
    const pack = encodePack([entry])
    const [decoded] = decodePack(pack)
    expect(bytesEqual(decoded!, entry)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Round-trip: 3 entries
// ---------------------------------------------------------------------------

describe('round-trip: 3 entries', () => {
  it('preserves all three entries with different sizes', () => {
    const a = new Uint8Array([0x00, 0x01])
    const b = makeEntry(200, 0x7f)
    const c = makeEntry(1, 0xff)
    const pack = encodePack([a, b, c])
    const decoded = decodePack(pack)
    expect(decoded).toHaveLength(3)
    expect(bytesEqual(decoded[0]!, a)).toBe(true)
    expect(bytesEqual(decoded[1]!, b)).toBe(true)
    expect(bytesEqual(decoded[2]!, c)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Round-trip: 500 entries
// ---------------------------------------------------------------------------

describe('round-trip: 500 entries', () => {
  it('round-trips 500 random-sized entries (0..255 bytes each)', () => {
    const original: Uint8Array[] = []
    for (let i = 0; i < 500; i++) {
      const size = i % 256
      const buf = new Uint8Array(size)
      for (let j = 0; j < size; j++) buf[j] = (i + j * 7) & 0xff
      original.push(buf)
    }
    const pack = encodePack(original)
    const decoded = decodePack(pack)
    expect(decoded).toHaveLength(500)
    for (let i = 0; i < 500; i++) {
      expect(bytesEqual(decoded[i]!, original[i]!)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Views-not-copies: decoded entries are subarray views into the input
// ---------------------------------------------------------------------------

describe('views-not-copies', () => {
  it('mutating the input buffer is reflected in decoded entries', () => {
    const entry = new Uint8Array([10, 20, 30])
    const pack = encodePack([entry])
    const [view] = decodePack(pack)
    // Before mutation
    expect(view![0]).toBe(10)
    // Mutate the pack buffer in-place at the entry's position
    // The entry data starts after: magic(4) + format(1) + count varint(1) + len varint(1) = offset 7
    pack[7] = 0xff
    // The view should reflect the change (it's a subarray, not a copy)
    expect(view![0]).toBe(0xff)
  })
})

// ---------------------------------------------------------------------------
// Adversarial: bad magic
// ---------------------------------------------------------------------------

describe('adversarial: bad_magic', () => {
  it('throws bad_magic when magic bytes are wrong', () => {
    const pack = encodePack([])
    // Corrupt the first byte
    const corrupt = new Uint8Array(pack)
    corrupt[0] = 0x00
    try {
      decodePack(corrupt)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).reason).toBe('bad_magic')
    }
  })

  it('throws bad_magic for a completely different payload', () => {
    const garbage = new Uint8Array([0x47, 0x49, 0x54, 0x00, 0x00, 0x00])
    try {
      decodePack(garbage)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).reason).toBe('bad_magic')
    }
  })
})

// ---------------------------------------------------------------------------
// Adversarial: unknown_format
// ---------------------------------------------------------------------------

describe('adversarial: unknown_format', () => {
  it('throws unknown_format for format byte 0x00', () => {
    const pack = encodePack([])
    const corrupt = new Uint8Array(pack)
    corrupt[4] = 0x00 // format byte position
    try {
      decodePack(corrupt)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).reason).toBe('unknown_format')
    }
  })

  it('throws unknown_format for format byte 0x02', () => {
    const pack = encodePack([])
    const corrupt = new Uint8Array(pack)
    corrupt[4] = 0x02
    try {
      decodePack(corrupt)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).reason).toBe('unknown_format')
    }
  })

  it('unknown_format reason is distinct from bad_magic', () => {
    const pack = encodePack([])
    const corrupt = new Uint8Array(pack)
    corrupt[4] = 0xff
    try {
      decodePack(corrupt)
    } catch (e) {
      expect((e as PackDecodeError).reason).toBe('unknown_format')
      expect((e as PackDecodeError).reason).not.toBe('bad_magic')
    }
  })
})

// ---------------------------------------------------------------------------
// Adversarial: truncated_header
// ---------------------------------------------------------------------------

describe('adversarial: truncated_header', () => {
  it('throws truncated_header when pack is shorter than 5 bytes', () => {
    for (let len = 0; len < 5; len++) {
      try {
        decodePack(new Uint8Array(len))
        throw new Error('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(PackDecodeError)
        expect((e as PackDecodeError).reason).toBe('truncated_header')
      }
    }
  })

  it('throws truncated_header when count varint is cut off', () => {
    // Magic + format, then multi-byte varint cut in the middle
    const partial = new Uint8Array([0x4f, 0x43, 0x50, 0x4b, 0x01, 0x80])
    // 0x80 = continuation byte with no following byte -> truncated
    try {
      decodePack(partial)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).reason).toBe('truncated_header')
    }
  })
})

// ---------------------------------------------------------------------------
// Adversarial: truncated_entry (varint and data)
// ---------------------------------------------------------------------------

describe('adversarial: truncated_entry', () => {
  it('throws truncated_entry with correct entryIndex when entry data is cut off', () => {
    // Two entries: first is fine, second is truncated
    const a = makeEntry(10)
    const b = makeEntry(20)
    const pack = encodePack([a, b])
    // Truncate before the second entry's data ends
    const truncated = pack.subarray(0, pack.length - 5)
    try {
      decodePack(truncated)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).reason).toBe('truncated_entry')
      expect((e as PackDecodeError).entryIndex).toBe(1)
    }
  })

  it('throws truncated_entry with entryIndex=0 when first entry is cut off', () => {
    const pack = encodePack([makeEntry(50)])
    const truncated = pack.subarray(0, pack.length - 10)
    try {
      decodePack(truncated)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).reason).toBe('truncated_entry')
      expect((e as PackDecodeError).entryIndex).toBe(0)
    }
  })

  it('throws truncated_entry when entry length varint is cut off', () => {
    // Build a pack manually: header + count=1 + a multi-byte len varint cut short
    const header = new Uint8Array([
      0x4f,
      0x43,
      0x50,
      0x4b, // OCPK
      0x01, // format
      0x01, // count = 1
      0x80, // start of multi-byte len varint, continuation bit set but buffer ends
    ])
    try {
      decodePack(header)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).reason).toBe('truncated_entry')
      expect((e as PackDecodeError).entryIndex).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Adversarial: varint_too_long (> 5 bytes in entry context)
// ---------------------------------------------------------------------------

describe('adversarial: varint_too_long', () => {
  it('throws varint_too_long for a 6-byte count varint', () => {
    // Build a pack manually with a count varint that has 6 continuation bytes
    const longVarint = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00])
    const buf = new Uint8Array(4 + 1 + longVarint.length)
    buf.set([0x4f, 0x43, 0x50, 0x4b, 0x01], 0)
    buf.set(longVarint, 5)
    try {
      decodePack(buf)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).reason).toBe('varint_too_long')
    }
  })

  it('throws varint_too_long for a 6-byte entry length varint', () => {
    // count=1, then a 6-byte varint for entry length
    const longVarint = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00])
    const buf = new Uint8Array(4 + 1 + 1 + longVarint.length)
    buf.set([0x4f, 0x43, 0x50, 0x4b, 0x01, 0x01], 0)
    buf.set(longVarint, 6)
    try {
      decodePack(buf)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).reason).toBe('varint_too_long')
    }
  })
})

// ---------------------------------------------------------------------------
// Adversarial: too_many_entries
// ---------------------------------------------------------------------------

describe('adversarial: too_many_entries', () => {
  it('throws too_many_entries when count exceeds maxEntries', () => {
    const pack = encodePack([makeEntry(1), makeEntry(1), makeEntry(1)])
    try {
      decodePack(pack, { maxEntries: 2 })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).reason).toBe('too_many_entries')
    }
  })

  it('accepts packs at exactly the maxEntries limit', () => {
    const pack = encodePack([makeEntry(1), makeEntry(1)])
    expect(() => decodePack(pack, { maxEntries: 2 })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Adversarial: entry_too_large (declared len > MAX_ENTRY_BYTES = 40 MiB)
// ---------------------------------------------------------------------------

describe('adversarial: entry_too_large', () => {
  it('throws entry_too_large when a declared entry length exceeds 40 MiB', () => {
    // Manually construct a pack with count=1 and entry length = 40MiB+1
    const tooLarge = 40 * 1024 * 1024 + 1
    const lenVarint = encodeVarint(tooLarge)
    // Pack: magic(4) + format(1) + count=1(1) + len varint + no data
    const buf = new Uint8Array(4 + 1 + 1 + lenVarint.length)
    buf.set([0x4f, 0x43, 0x50, 0x4b, 0x01, 0x01], 0)
    buf.set(lenVarint, 6)
    try {
      decodePack(buf)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).reason).toBe('entry_too_large')
      expect((e as PackDecodeError).entryIndex).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Adversarial: total_size_exceeded
// ---------------------------------------------------------------------------

describe('adversarial: total_size_exceeded', () => {
  it('throws total_size_exceeded when accumulated bytes exceed maxBytes', () => {
    const pack = encodePack([makeEntry(100), makeEntry(100), makeEntry(100)])
    try {
      decodePack(pack, { maxBytes: 250 })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).reason).toBe('total_size_exceeded')
      // Exceeds at entry index 2 (0+100+100+100 > 250)
      expect((e as PackDecodeError).entryIndex).toBe(2)
    }
  })

  it('accepts packs at exactly the maxBytes limit', () => {
    const pack = encodePack([makeEntry(100), makeEntry(100)])
    expect(() => decodePack(pack, { maxBytes: 200 })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Adversarial: trailing_garbage
// ---------------------------------------------------------------------------

describe('adversarial: trailing_garbage', () => {
  it('throws trailing_garbage when extra bytes follow the last entry', () => {
    const pack = encodePack([makeEntry(5)])
    const withGarbage = new Uint8Array(pack.length + 1)
    withGarbage.set(pack)
    withGarbage[pack.length] = 0x00
    try {
      decodePack(withGarbage)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).reason).toBe('trailing_garbage')
    }
  })

  it('throws trailing_garbage for multiple extra bytes', () => {
    const pack = encodePack([makeEntry(5)])
    const withGarbage = new Uint8Array(pack.length + 10)
    withGarbage.set(pack)
    try {
      decodePack(withGarbage)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PackDecodeError)
      expect((e as PackDecodeError).reason).toBe('trailing_garbage')
    }
  })
})

// ---------------------------------------------------------------------------
// Varint edge values
// ---------------------------------------------------------------------------

describe('varint edge values encode/decode correctly', () => {
  const edgeCases = [0, 127, 128, 16383, 16384, 40 * 1024 * 1024]

  for (const v of edgeCases) {
    it(`value ${v} round-trips`, () => {
      const encoded = encodeVarint(v)
      const buf = new Uint8Array(encoded.length)
      buf.set(encoded)
      const { value, bytesRead } = decodeVarint(buf, 0, 'truncated_header', 'varint_too_long')
      expect(value).toBe(v)
      expect(bytesRead).toBe(encoded.length)
    })
  }

  it('0 encodes as 1 byte', () => {
    expect(encodeVarint(0).length).toBe(1)
  })

  it('127 encodes as 1 byte', () => {
    expect(encodeVarint(127).length).toBe(1)
  })

  it('128 encodes as 2 bytes', () => {
    expect(encodeVarint(128).length).toBe(2)
  })

  it('16383 encodes as 2 bytes', () => {
    expect(encodeVarint(16383).length).toBe(2)
  })

  it('16384 encodes as 3 bytes', () => {
    expect(encodeVarint(16384).length).toBe(3)
  })

  it('40 MiB encodes as at most 5 bytes', () => {
    expect(encodeVarint(40 * 1024 * 1024).length).toBeLessThanOrEqual(5)
  })
})

// ---------------------------------------------------------------------------
// PackDecodeError shape
// ---------------------------------------------------------------------------

describe('PackDecodeError', () => {
  it('has name "PackDecodeError"', () => {
    const e = new PackDecodeError('bad_magic', 'test')
    expect(e.name).toBe('PackDecodeError')
  })

  it('is instanceof Error', () => {
    const e = new PackDecodeError('bad_magic', 'test')
    expect(e).toBeInstanceOf(Error)
  })

  it('exposes reason field', () => {
    const e = new PackDecodeError('truncated_entry', 'msg', 5)
    expect(e.reason).toBe('truncated_entry')
  })

  it('exposes entryIndex field when provided', () => {
    const e = new PackDecodeError('truncated_entry', 'msg', 7)
    expect(e.entryIndex).toBe(7)
  })

  it('entryIndex is undefined when not provided', () => {
    const e = new PackDecodeError('bad_magic', 'msg')
    expect(e.entryIndex).toBeUndefined()
  })
})
