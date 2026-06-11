/**
 * OCPK wire-pack codec — vendored verbatim from the platform repo's
 * shared/pack/codec.ts (ocpk-pack branch).  myth-cli is dependency-free
 * by design; this follows the same vendoring pattern as crockford.ts.
 * Keep in lockstep with the canonical source.
 *
 * A lightweight framing format for batch-transferring git loose objects over
 * HTTP in a single request/response, replacing N parallel fetches with one.
 * Entries are opaque byte sequences — the codec never inflates or interprets
 * them (the callers own zlib and git framing).
 *
 * Wire format (all multi-byte integers are unsigned LEB-128 varints):
 *
 *   magic:   ASCII "OCPK"                  4 bytes
 *   format:  version byte                  1 byte  (must be 0x01)
 *   count:   unsigned LEB-128              1..5 bytes
 *   entries: count × ( len: LEB-128, <len bytes> )
 *
 * Varints are capped at 5 bytes (covers the full u32 range, 0..4 294 967 295).
 * Entry lengths are further capped at 40 MiB to match blob worker limits.
 *
 * The decoder returns subarray VIEWS into the input buffer — no copies —
 * so callers that already own the buffer pay no extra allocation cost.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Magic bytes at the start of every OCPK pack. */
const MAGIC = new Uint8Array([0x4f, 0x43, 0x50, 0x4b]) // "OCPK"

/** Only format version currently defined. */
const FORMAT_VERSION = 0x01

/** Max varint width (5 bytes covers u32). */
const MAX_VARINT_BYTES = 5

/** Maximum allowed entry byte length (40 MiB). */
const MAX_ENTRY_BYTES = 40 * 1024 * 1024

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/** Reasons a pack decode can fail — used by callers to map to HTTP status codes. */
export type PackDecodeReason =
  | 'bad_magic'
  | 'unknown_format'
  | 'truncated_header'
  | 'truncated_varint'
  | 'truncated_entry'
  | 'varint_too_long'
  | 'entry_too_large'
  | 'too_many_entries'
  | 'total_size_exceeded'
  | 'trailing_garbage'

/** Thrown by `decodePack` on any structural or limit violation. */
export class PackDecodeError extends Error {
  readonly reason: PackDecodeReason
  /** Zero-based index of the entry that triggered the error, where applicable. */
  readonly entryIndex: number | undefined

  constructor(reason: PackDecodeReason, message: string, entryIndex?: number) {
    super(message)
    this.name = 'PackDecodeError'
    this.reason = reason
    this.entryIndex = entryIndex
  }
}

// ---------------------------------------------------------------------------
// LEB-128 helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Encode a non-negative integer as an unsigned LEB-128 varint.
 * Throws if `value` is negative or non-integer.
 */
export function encodeVarint(value: number): Uint8Array {
  if (value < 0 || !Number.isInteger(value)) {
    throw new RangeError(`encodeVarint: value must be a non-negative integer, got ${value}`)
  }
  const bytes: number[] = []
  let v = value
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v !== 0) b |= 0x80
    bytes.push(b)
  } while (v !== 0)
  return new Uint8Array(bytes)
}

/**
 * Decode an unsigned LEB-128 varint from `buf` starting at `offset`.
 * Returns `{ value, bytesRead }` on success.
 * Throws `PackDecodeError` with the supplied reason on truncation or
 * oversized varint.
 */
export function decodeVarint(
  buf: Uint8Array,
  offset: number,
  truncatedReason: PackDecodeReason,
  tooLongReason: PackDecodeReason,
  entryIndex?: number,
): { value: number; bytesRead: number } {
  let value = 0
  let shift = 0
  let bytesRead = 0

  while (true) {
    if (offset + bytesRead >= buf.length) {
      throw new PackDecodeError(truncatedReason, `Truncated varint at offset ${offset}`, entryIndex)
    }
    const byte = buf[offset + bytesRead]!
    bytesRead++

    if (bytesRead > MAX_VARINT_BYTES) {
      throw new PackDecodeError(
        tooLongReason,
        `Varint at offset ${offset} exceeds ${MAX_VARINT_BYTES} bytes`,
        entryIndex,
      )
    }

    value |= (byte & 0x7f) << shift
    shift += 7

    if ((byte & 0x80) === 0) break
  }

  // `value` is the result of bitwise OR with signed 32-bit operations; force
  // to unsigned so callers see a non-negative number.
  return { value: value >>> 0, bytesRead }
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/**
 * Encode an array of opaque byte entries into an OCPK pack.
 *
 * The entries are written verbatim — the caller is responsible for
 * zlib-deflating git objects before passing them in.
 */
export function encodePack(entries: Uint8Array[]): Uint8Array {
  const countVarint = encodeVarint(entries.length)

  // Pre-compute each entry's length varint so we know the total size.
  const lenVarints = entries.map(e => encodeVarint(e.length))

  let totalSize = MAGIC.length + 1 + countVarint.length
  for (let i = 0; i < entries.length; i++) {
    totalSize += lenVarints[i]!.length + entries[i]!.length
  }

  const out = new Uint8Array(totalSize)
  let pos = 0

  // Magic
  out.set(MAGIC, pos)
  pos += MAGIC.length

  // Format version
  out[pos++] = FORMAT_VERSION

  // Count varint
  out.set(countVarint, pos)
  pos += countVarint.length

  // Entries
  for (let i = 0; i < entries.length; i++) {
    const lv = lenVarints[i]!
    const entry = entries[i]!
    out.set(lv, pos)
    pos += lv.length
    out.set(entry, pos)
    pos += entry.length
  }

  return out
}

// ---------------------------------------------------------------------------
// Decode options
// ---------------------------------------------------------------------------

export interface DecodeOpts {
  /** Maximum number of entries allowed in the pack. */
  maxEntries?: number
  /** Maximum total accumulated byte length of all entries. */
  maxBytes?: number
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/**
 * Decode an OCPK pack and return the entries as subarray VIEWS into `pack`
 * (zero-copy — mutations to `pack` are reflected in the returned arrays).
 *
 * Throws `PackDecodeError` on any structural violation or limit breach.
 * The `reason` field lets callers map to appropriate HTTP status codes
 * (e.g. `unknown_format` → 422, count/size caps → 413).
 */
export function decodePack(pack: Uint8Array, opts?: DecodeOpts): Uint8Array[] {
  let pos = 0

  // --- magic ---------------------------------------------------------------
  if (pack.length < MAGIC.length + 1) {
    throw new PackDecodeError('truncated_header', 'Pack too short to contain header')
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (pack[i] !== MAGIC[i]) {
      throw new PackDecodeError('bad_magic', `Bad magic bytes at offset ${i}`)
    }
  }
  pos += MAGIC.length

  // --- format version ------------------------------------------------------
  const fmt = pack[pos++]!
  if (fmt !== FORMAT_VERSION) {
    throw new PackDecodeError(
      'unknown_format',
      `Unknown pack format version: 0x${fmt.toString(16)}`,
    )
  }

  // --- count varint --------------------------------------------------------
  const countResult = decodeVarint(pack, pos, 'truncated_header', 'varint_too_long')
  pos += countResult.bytesRead
  const count = countResult.value

  // Check entry count cap
  if (opts?.maxEntries !== undefined && count > opts.maxEntries) {
    throw new PackDecodeError(
      'too_many_entries',
      `Pack contains ${count} entries, limit is ${opts.maxEntries}`,
    )
  }

  // --- entries -------------------------------------------------------------
  const entries: Uint8Array[] = []
  let totalBytes = 0

  for (let i = 0; i < count; i++) {
    // Entry length varint
    const lenResult = decodeVarint(pack, pos, 'truncated_entry', 'varint_too_long', i)
    pos += lenResult.bytesRead
    const entryLen = lenResult.value

    // Per-entry size cap
    if (entryLen > MAX_ENTRY_BYTES) {
      throw new PackDecodeError(
        'entry_too_large',
        `Entry ${i} declares length ${entryLen}, exceeds max ${MAX_ENTRY_BYTES}`,
        i,
      )
    }

    // Check remaining bytes before reading
    if (pos + entryLen > pack.length) {
      throw new PackDecodeError(
        'truncated_entry',
        `Entry ${i} declares length ${entryLen} but only ${pack.length - pos} bytes remain`,
        i,
      )
    }

    // Accumulate total and check cap
    totalBytes += entryLen
    if (opts?.maxBytes !== undefined && totalBytes > opts.maxBytes) {
      throw new PackDecodeError(
        'total_size_exceeded',
        `Total entry bytes ${totalBytes} exceeds limit ${opts.maxBytes}`,
        i,
      )
    }

    // Zero-copy subarray view
    entries.push(pack.subarray(pos, pos + entryLen))
    pos += entryLen
  }

  // --- trailing garbage ----------------------------------------------------
  if (pos !== pack.length) {
    throw new PackDecodeError(
      'trailing_garbage',
      `${pack.length - pos} trailing bytes after last entry`,
    )
  }

  return entries
}
