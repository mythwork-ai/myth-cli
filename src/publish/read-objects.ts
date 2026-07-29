/**
 * Decode + materialize the git-format object graph `build-objects.ts` builds
 * for publish, in reverse — the offline half of `myth pull`.
 *
 * Mirrors `build-objects.ts` exactly, one step at a time, undone:
 *
 *   - `inflateFrame` undoes `deflateSync` (with an output-size cap — a
 *     zip-bomb defense, since these bytes ultimately come from the network).
 *   - `parseFrame` undoes the `<type> <len>\0<body>` header framing.
 *   - `parseTreeEntries` undoes the `<mode> <name>\0<32 raw hash bytes>`
 *     tree-entry encoding.
 *   - `indexPackObjects` turns a flat list of raw pack entries into a
 *     hash -> {type, body} map, deriving each hash itself (the wire format
 *     carries no explicit hash tag, same as the upload path).
 *   - `materializeTree` recursively writes a tree's blobs out as real files.
 *
 * `materializeTree` is deliberately two-phase: it walks and fully validates
 * the whole graph in memory first (every hash present, every entry name
 * safe, every mode known), and only writes to disk once that validation
 * completes without error. A corrupt or malicious response can therefore
 * never leave a half-written destination directory behind.
 *
 * No network code lives in this file, mirroring `build-objects.ts`'s purity.
 */

import { inflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { GitObjectType } from './build-objects.js'

const TEXT_DEC = new TextDecoder()

/** Cap on a single inflated object's size — zip-bomb defense for objects
 *  arriving over the network. Generous relative to the 50 MB single-blob
 *  upload cap the publish worker enforces (see client.ts's `too_large`
 *  error message). */
const INFLATE_MAX_BYTES = 64 * 1024 * 1024

export type ReconstructReason =
  | 'missing_object'
  | 'malformed_object'
  | 'unsafe_path'
  | 'unsupported_mode'

/** Thrown by any step in this file on a structural problem with the object
 *  graph — corrupt framing, a dangling hash reference, an unsafe tree-entry
 *  name, or a tree-entry mode the encoder never emits (e.g. a symlink). */
export class ReconstructError extends Error {
  constructor(
    public reason: ReconstructReason,
    message: string,
    public details?: { hash?: string; name?: string; mode?: string },
  ) {
    super(message)
    this.name = 'ReconstructError'
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0')
  return out
}

/** Inflate one deflated object. Throws ReconstructError('malformed_object')
 *  on a bad zlib stream or output exceeding INFLATE_MAX_BYTES. */
export function inflateFrame(deflated: Uint8Array): Uint8Array {
  try {
    return new Uint8Array(inflateSync(deflated, { maxOutputLength: INFLATE_MAX_BYTES }))
  } catch (e) {
    throw new ReconstructError('malformed_object', `Failed to inflate object: ${(e as Error).message}`)
  }
}

/** sha256 hex of the full inflated framing — the object's canonical hash,
 *  matching `sha256Hex` in build-objects.ts. */
export function hashFrame(framed: Uint8Array): string {
  return createHash('sha256').update(framed).digest('hex')
}

/** Parse the `<type> <len>\0<body>` framing. Validates the type tag is one
 *  of blob/tree/commit and that <len> exactly matches the actual body
 *  length. Throws ReconstructError('malformed_object') otherwise. */
export function parseFrame(framed: Uint8Array): { type: GitObjectType; body: Uint8Array } {
  const nulIdx = framed.indexOf(0)
  if (nulIdx === -1) {
    throw new ReconstructError('malformed_object', 'Object frame is missing its header terminator')
  }
  const header = TEXT_DEC.decode(framed.subarray(0, nulIdx))
  const spaceIdx = header.indexOf(' ')
  if (spaceIdx === -1) {
    throw new ReconstructError('malformed_object', `Malformed object header: ${JSON.stringify(header)}`)
  }
  const type = header.slice(0, spaceIdx)
  if (type !== 'blob' && type !== 'tree' && type !== 'commit') {
    throw new ReconstructError('malformed_object', `Unknown object type in header: ${JSON.stringify(type)}`)
  }
  const lenStr = header.slice(spaceIdx + 1)
  const len = Number.parseInt(lenStr, 10)
  if (!Number.isInteger(len) || len < 0 || String(len) !== lenStr) {
    throw new ReconstructError('malformed_object', `Malformed object length in header: ${JSON.stringify(lenStr)}`)
  }
  const body = framed.subarray(nulIdx + 1)
  if (body.length !== len) {
    throw new ReconstructError(
      'malformed_object',
      `Object declared length ${len} does not match actual body length ${body.length}`,
    )
  }
  return { type, body }
}

export interface ParsedTreeEntry {
  mode: '100644' | '100755' | '40000'
  name: string
  hash: string
}

const KNOWN_MODES = new Set(['100644', '100755', '40000'])

/** Parse a tree object's body into entries, undoing `buildTree`'s
 *  `<mode> <name>\0<32 raw hash bytes>` encoding. Throws
 *  ReconstructError('malformed_object') on truncated framing, and
 *  ReconstructError('unsupported_mode') on any octal-looking mode outside
 *  the known set (e.g. `120000`, a symlink — the encoder never emits one,
 *  so any occurrence is either corruption or an attack). */
export function parseTreeEntries(body: Uint8Array): ParsedTreeEntry[] {
  const entries: ParsedTreeEntry[] = []
  let pos = 0
  while (pos < body.length) {
    const spaceIdx = body.indexOf(0x20, pos)
    if (spaceIdx === -1) {
      throw new ReconstructError('malformed_object', 'Truncated tree entry: missing mode separator')
    }
    const mode = TEXT_DEC.decode(body.subarray(pos, spaceIdx))
    const nulIdx = body.indexOf(0x00, spaceIdx + 1)
    if (nulIdx === -1) {
      throw new ReconstructError('malformed_object', 'Truncated tree entry: missing name terminator')
    }
    const name = TEXT_DEC.decode(body.subarray(spaceIdx + 1, nulIdx))
    const hashStart = nulIdx + 1
    const hashEnd = hashStart + 32
    if (hashEnd > body.length) {
      throw new ReconstructError('malformed_object', `Truncated tree entry: hash for "${name}" is incomplete`)
    }
    const hash = bytesToHex(body.subarray(hashStart, hashEnd))
    if (!KNOWN_MODES.has(mode)) {
      if (/^[0-7]{5,6}$/.test(mode)) {
        throw new ReconstructError('unsupported_mode', `Unsupported tree entry mode: ${mode}`, { name, mode })
      }
      throw new ReconstructError('malformed_object', `Malformed tree entry mode: ${JSON.stringify(mode)}`)
    }
    entries.push({ mode: mode as ParsedTreeEntry['mode'], name, hash })
    pos = hashEnd
  }
  return entries
}

export interface IndexedObject {
  type: GitObjectType
  body: Uint8Array
}

/** Build a hash -> {type, body} map from raw OCPK pack entries (already
 *  decodePack()-ed into Uint8Array views). Inflates + hashes each entry to
 *  derive its key itself — the wire format carries no explicit hash tag.
 *  Throws ReconstructError('malformed_object') on any entry that fails to
 *  inflate or parse (fails the whole pull rather than silently dropping a
 *  corrupt entry). */
export function indexPackObjects(deflatedEntries: Uint8Array[]): Map<string, IndexedObject> {
  const objects = new Map<string, IndexedObject>()
  for (const deflated of deflatedEntries) {
    const framed = inflateFrame(deflated)
    const hash = hashFrame(framed)
    const { type, body } = parseFrame(framed)
    objects.set(hash, { type, body })
  }
  return objects
}

/** A tree-entry name can never legitimately contain a path separator — any
 *  occurrence is either corruption or a deliberate tar-slip-style
 *  traversal attempt. */
function isSafeEntryName(name: string): boolean {
  if (name.length === 0) return false
  if (name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\')) return false
  if (name.includes('\0')) return false
  return true
}

export interface PlannedFile {
  /** POSIX-relative path (never absolute, no `.`/`..`/separator tricks — every
   *  segment passed `isSafeEntryName` during the walk). */
  relPath: string
  /** Raw file bytes (framing already stripped) — byte-exact, never re-encoded. */
  content: Uint8Array
}

export interface MaterializeResult {
  fileCount: number
  paths: string[]
}

/**
 * Walk the tree at `rootTreeHash` in memory and return a flat, validated write
 * plan (path -> raw bytes) — phase 1 of `materializeTree`, extracted so callers
 * that transform the app in memory (e.g. `myth eject`) can reuse the exact same
 * validated graph walk without writing to disk. Validates every hash is present,
 * every entry name is safe, and every mode is known; throws `ReconstructError`
 * on any structural problem before returning. Blobs carry raw bytes — the
 * executable bit is intentionally not represented (publish always encodes
 * 100644; a 100755 entry is accepted purely for forward-compatibility).
 */
export function planTree(
  rootTreeHash: string,
  objects: Map<string, IndexedObject>,
): PlannedFile[] {
  const plan: PlannedFile[] = []

  function walk(treeHash: string, relDir: string): void {
    const obj = objects.get(treeHash)
    if (!obj) {
      throw new ReconstructError('missing_object', `Missing tree object: ${treeHash}`, { hash: treeHash })
    }
    if (obj.type !== 'tree') {
      throw new ReconstructError('malformed_object', `Expected a tree object at ${treeHash}, got "${obj.type}"`, {
        hash: treeHash,
      })
    }
    for (const entry of parseTreeEntries(obj.body)) {
      if (!isSafeEntryName(entry.name)) {
        throw new ReconstructError('unsafe_path', `Unsafe tree entry name: ${JSON.stringify(entry.name)}`, {
          name: entry.name,
          hash: entry.hash,
        })
      }
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      if (entry.mode === '40000') {
        walk(entry.hash, relPath)
        continue
      }
      // 100644 or 100755 — a file.
      const blob = objects.get(entry.hash)
      if (!blob) {
        throw new ReconstructError('missing_object', `Missing blob object: ${entry.hash}`, {
          hash: entry.hash,
          name: entry.name,
        })
      }
      if (blob.type !== 'blob') {
        throw new ReconstructError(
          'malformed_object',
          `Expected a blob object at ${entry.hash} ("${entry.name}"), got "${blob.type}"`,
          { hash: entry.hash, name: entry.name },
        )
      }
      plan.push({ relPath, content: blob.body })
    }
  }

  walk(rootTreeHash, '')
  return plan
}

/**
 * Recursively materialize the tree at `rootTreeHash` into real files under
 * `destDir`. Two-phase: phase 1 (`planTree`) walks and fully validates the
 * whole graph in memory; phase 2, only once phase 1 succeeds completely,
 * writes that plan to disk. `destDir` is expected to already exist (the caller
 * creates it); this function only creates SUBdirectories under it. Blobs are
 * always written as plain files — executable bits are never restored.
 */
export async function materializeTree(
  rootTreeHash: string,
  objects: Map<string, IndexedObject>,
  destDir: string,
): Promise<MaterializeResult> {
  // Phase 1: validate the whole graph in memory. Nothing touches disk
  // until this returns without throwing.
  const plan = planTree(rootTreeHash, objects)

  // Phase 2: write the validated plan.
  for (const file of plan) {
    const fullPath = path.join(destDir, ...file.relPath.split('/'))
    await mkdir(path.dirname(fullPath), { recursive: true })
    await writeFile(fullPath, file.content)
  }

  return { fileCount: plan.length, paths: plan.map(f => f.relPath) }
}
