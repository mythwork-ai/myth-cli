/**
 * Decoder for the path-tagged OCPK export pack that `GET /publish/eject/{name}`
 * returns — the inverse of the backend's `packExport` (mythwork
 * `shared/build/export-pack.ts`). Each OCPK entry is
 *
 *     varint(pathByteLen) ‖ pathUtf8 ‖ fileBytes
 *
 * so this reuses the CLI's own OCPK codec (`decodePack` + `decodeVarint`) for
 * the outer framing and the same length-varint reader, keeping the wire format
 * byte-identical to the producer. `fileBytes` are zero-copy subarray views into
 * `pack` — copy if you need to retain them past the pack's lifetime (the eject
 * command writes them straight to disk, so views are fine there).
 *
 * Hand-kept in sync with the backend producer, exactly as pack-codec.ts is with
 * the blob worker — one format, decoded here, encoded there.
 */

import { decodePack, decodeVarint, PackDecodeError } from './pack-codec.js'

export function unpackExport(pack: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  const decoder = new TextDecoder()
  let index = 0
  for (const entry of decodePack(pack)) {
    const { value: pathLen, bytesRead } = decodeVarint(
      entry,
      0,
      'truncated_entry',
      'varint_too_long',
    )
    const pathEnd = bytesRead + pathLen
    // Bounds-check the declared path length against the entry — a malformed
    // entry must error, not silently yield a truncated path + empty body
    // (mirrors read-objects.ts's parseFrame length check).
    if (pathEnd > entry.length) {
      throw new PackDecodeError(
        'truncated_entry',
        `export pack entry ${index}: path length ${pathLen} exceeds entry size ${entry.length}`,
        index,
      )
    }
    const path = decoder.decode(entry.subarray(bytesRead, pathEnd))
    files.set(path, entry.subarray(pathEnd))
    index++
  }
  return files
}
