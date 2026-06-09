/**
 * Build the in-memory git-format object graph that the publish worker stores.
 *
 * Three entry points:
 *   - `assembleSourceAndHash(root)` — the publish path: selects the app's
 *     SOURCE (heuristic + .gitignore excludes) and hashes it.
 *   - `buildObjectsFromFiles(map)` — pure path->bytes hashing (no disk).
 *   - `hashDirectory(dir)` — walks an on-disk directory tree (used as a
 *     reference/fixture helper in tests).
 *
 * All three emit:
 *
 *   - One blob object per file (raw file bytes framed as `blob <size>\0<bytes>`)
 *   - One tree object per directory (entries sorted git-style, framed as
 *     `tree <size>\0<entries>`, with 32 raw SHA-256 bytes per entry hash ref)
 *   - One commit object pointing at the root tree (framed as
 *     `commit <size>\0<body>`)
 *
 * Hash format: 64-hex SHA-256 of the UNCOMPRESSED framing. Matches git's
 * --object-format=sha256 native ID and the `HEX_64 = /^[0-9a-f]{64}$/`
 * validator at workers/publish/src/api.ts:31.
 *
 * Storage format: zlib-deflated framing bytes. Matches what the blob
 * worker stores under each hash and the parser at shared/git/parse.ts
 * expects to inflate.
 *
 * The commit author/committer is hardcoded to a stable identity so two
 * users publishing identical bundles produce identical commits — they
 * dedup at the canonical URL level. The user's identity is recorded
 * separately at the alias level via the JWT-derived `publisher` field.
 */

import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { selectSourceFiles } from './source-select.js'

const TEXT_ENC = new TextEncoder()

export type GitObjectType = 'blob' | 'tree' | 'commit'

export interface BuiltObject {
  /** 64-hex lowercase SHA-256 of the uncompressed framing. */
  hash: string
  /** Zlib-deflated framing bytes — what we PUT to the blob worker. */
  deflated: Uint8Array
  /** Object type — for debugging / logs only. */
  type: GitObjectType
}

export interface BuildResult {
  /** hash -> deflated body. Keys are 64-hex; insertion order is
   *  bottom-up so the commit is last. */
  objects: Map<string, BuiltObject>
  /** 64-hex SHA-256 of the commit object. Goes in POST /publish body. */
  headCommit: string
  /**
   * 64-hex SHA-256 of the root tree. Sent in the /check body and as the
   * `X-Root-Tree` header on each blob PUT so the worker can derive the
   * GC scope server-side.
   */
  rootTree: string
  /** Total file count (for progress logging). */
  fileCount: number
  /** Total deflated byte size of all objects (for progress logging). */
  totalBytes: number
}

// Internal tree entry shape — matches shared/git/build.ts:TreeEntryInput.
interface TreeEntry {
  /** ASCII octal. "100644" = file, "100755" = executable, "40000" = dir. */
  mode: '100644' | '100755' | '40000'
  name: string
  hash: string // 64-hex
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Walk a built directory and emit the git-object graph. Pure function of
 * the on-disk tree; no Vite involvement. Retained as a reference/fixture
 * helper and exercised by the unit tests; the publish path now uses
 * `assembleSourceAndHash`.
 */
export async function hashDirectory(distDir: string): Promise<BuildResult> {
  const objects = new Map<string, BuiltObject>()
  let fileCount = 0
  let totalBytes = 0

  // Bottom-up tree build. Recursive helper returns the tree hash for
  // each directory. Files emit blobs as we visit them.
  async function visitDir(dir: string): Promise<string> {
    const entries: TreeEntry[] = []
    const names = await readdir(dir)
    // Sort by raw name first; tree builder re-sorts with git's
    // directory-slash convention before encoding.
    names.sort()
    for (const name of names) {
      const full = path.join(dir, name)
      const st = await stat(full)
      if (st.isDirectory()) {
        const treeHash = await visitDir(full)
        entries.push({ mode: '40000', name, hash: treeHash })
      } else if (st.isFile()) {
        const bytes = new Uint8Array(await readFile(full))
        const blob = await buildBlob(bytes)
        if (!objects.has(blob.hash)) {
          objects.set(blob.hash, blob)
          totalBytes += blob.deflated.length
        }
        fileCount++
        const mode = (st.mode & 0o111) !== 0 ? '100755' : '100644'
        entries.push({ mode, name, hash: blob.hash })
      }
      // Symlinks and other special files: skipped. Vite output won't
      // contain them in practice.
    }
    const tree = await buildTree(entries)
    if (!objects.has(tree.hash)) {
      objects.set(tree.hash, tree)
      totalBytes += tree.deflated.length
    }
    return tree.hash
  }

  const rootTree = await visitDir(distDir)

  // Commit author identity is stable so identical bundles from any user
  // produce the same commit hash and therefore dedup at the canonical
  // URL level. Per-user provenance is recorded by the publish worker on
  // the KV alias row (publisher field), not in the commit.
  const commit = await buildCommit({ tree: rootTree })
  objects.set(commit.hash, commit)
  totalBytes += commit.deflated.length

  return {
    objects,
    headCommit: commit.hash,
    rootTree,
    fileCount,
    totalBytes,
  }
}

/**
 * Select the project's source files (heuristic + .gitignore excludes) and hash
 * them into the git object graph. Replaces buildAndHash (vite) for the
 * source-publish model — the CLI uploads source; the edge compiles.
 *
 * `preselected` lets the caller pass an already-computed file list (from
 * `selectSourceFiles`) to avoid a second filesystem walk. `overrides` maps a
 * relative path to replacement bytes used instead of the on-disk contents — the
 * Tailwind pre-bake injects compiled CSS this way without mutating the user's
 * working tree.
 */
export async function assembleSourceAndHash(
  root: string,
  preselected?: string[],
  overrides?: Map<string, Uint8Array>,
  opts: { timestamp?: number } = {},
): Promise<BuildResult> {
  const rels = preselected ?? selectSourceFiles(root)
  const files = new Map<string, Uint8Array>()
  for (const rel of rels) {
    const override = overrides?.get(rel)
    if (override) {
      files.set(rel, override)
      continue
    }
    const bytes = new Uint8Array(await readFile(path.join(root, rel)))
    files.set(rel, bytes)
  }
  return buildObjectsFromFiles(files, opts)
}

/**
 * Build the git object graph from an in-memory map of POSIX relative path ->
 * file bytes. Pure (no disk). Mirrors hashDirectory's framing/sorting, so for
 * non-executable files the resulting hashes are identical to an on-disk walk
 * of the same tree. (Unlike hashDirectory it has no file-mode information, so
 * every blob is recorded as mode 100644; executable bits are not preserved.
 * This is fine for the source-publish path — app source is not executable.)
 */
export async function buildObjectsFromFiles(
  files: Map<string, Uint8Array>,
  opts: { timestamp?: number } = {},
): Promise<BuildResult> {
  const objects = new Map<string, BuiltObject>()
  let fileCount = 0
  let totalBytes = 0

  interface Dir {
    dirs: Map<string, Dir>
    files: Map<string, Uint8Array>
  }
  const rootDir: Dir = { dirs: new Map(), files: new Map() }
  for (const [rel, bytes] of files) {
    const parts = rel.split('/')
    let cur = rootDir
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!
      let next = cur.dirs.get(seg)
      if (!next) {
        next = { dirs: new Map(), files: new Map() }
        cur.dirs.set(seg, next)
      }
      cur = next
    }
    cur.files.set(parts[parts.length - 1]!, bytes)
  }

  async function visit(dir: Dir): Promise<string> {
    const entries: TreeEntry[] = []
    for (const [name, bytes] of dir.files) {
      const blob = await buildBlob(bytes)
      if (!objects.has(blob.hash)) {
        objects.set(blob.hash, blob)
        totalBytes += blob.deflated.length
      }
      fileCount++
      entries.push({ mode: '100644', name, hash: blob.hash })
    }
    for (const [name, sub] of dir.dirs) {
      const treeHash = await visit(sub)
      entries.push({ mode: '40000', name, hash: treeHash })
    }
    const tree = await buildTree(entries)
    if (!objects.has(tree.hash)) {
      objects.set(tree.hash, tree)
      totalBytes += tree.deflated.length
    }
    return tree.hash
  }

  const rootTree = await visit(rootDir)
  // Real author date by default (meaningful in an exported git history);
  // the publish-level no-op skip is what prevents commit churn for
  // unchanged content. Tests pin `opts.timestamp` for determinism.
  const commit = await buildCommit({
    tree: rootTree,
    timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
  })
  objects.set(commit.hash, commit)
  totalBytes += commit.deflated.length

  return { objects, headCommit: commit.hash, rootTree, fileCount, totalBytes }
}

// ===========================================================================
// Object builders — mirror shared/git/build.ts, but Node-native (no Web
// Crypto, no CompressionStream).
// ===========================================================================

async function buildBlob(content: Uint8Array): Promise<BuiltObject> {
  return frameAndDeflate('blob', content)
}

async function buildTree(entries: TreeEntry[]): Promise<BuiltObject> {
  // Git tree sort: like strcmp on names, but a subdirectory name sorts
  // as if it had a trailing '/'. Required for git fsck to accept the
  // exported repo; the serve worker tolerates any order on read, but
  // matching the convention keeps things round-trippable.
  const sorted = [...entries].sort((a, b) => compareTreeNames(a, b))
  const parts: Uint8Array[] = []
  for (const e of sorted) {
    parts.push(TEXT_ENC.encode(`${e.mode} ${e.name}\0`))
    parts.push(hexToBytes(e.hash))
  }
  const body = concatBytes(parts)
  return frameAndDeflate('tree', body)
}

export interface CommitInput {
  tree: string // 64-hex
  author?: string
  committer?: string
  message?: string
  /** Fixed unix-time seconds for deterministic output. */
  timestamp?: number
}

async function buildCommit(input: CommitInput): Promise<BuiltObject> {
  // Stable timestamp by default so identical bundles produce identical
  // commits across machines and re-runs. Callers can override for tests.
  const ts = input.timestamp ?? 0
  const author = input.author ?? 'myth-cli <noreply@myth.work>'
  const committer = input.committer ?? author
  const message = input.message ?? 'myth publish\n'
  const lines = [`tree ${input.tree}`]
  lines.push(`author ${author} ${ts} +0000`)
  lines.push(`committer ${committer} ${ts} +0000`)
  lines.push('')
  const body = TEXT_ENC.encode(lines.join('\n') + '\n' + message)
  return frameAndDeflate('commit', body)
}

async function frameAndDeflate(
  type: GitObjectType,
  body: Uint8Array,
): Promise<BuiltObject> {
  const header = TEXT_ENC.encode(`${type} ${body.length}\0`)
  const framed = concatBytes([header, body])
  const hash = sha256Hex(framed)
  const deflated = new Uint8Array(deflateSync(framed))
  return { hash, deflated, type }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
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

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hex length not even: ${hex.length}`)
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const aKey = a.mode === '40000' ? a.name + '/' : a.name
  const bKey = b.mode === '40000' ? b.name + '/' : b.name
  if (aKey < bKey) return -1
  if (aKey > bKey) return 1
  return 0
}

// Exported for tests so they can poke a directory without invoking Vite.
export const __test__ = { buildBlob, buildTree, buildCommit }
