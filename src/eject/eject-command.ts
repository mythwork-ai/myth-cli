/**
 * Orchestrator for `myth eject` — download a published app and write a fully
 * standalone, runnable Vite/React project to disk, depending on nothing of
 * ours. The pure transform lives in `./index.ts` (`eject()`); this wrapper is
 * everything that touches the outside world plus the two things the pure core
 * deliberately does NOT handle:
 *
 *   1. Binary files. `eject()` is `Record<string,string>` in/out, so binary
 *      blobs (images, fonts) are split out FIRST via a lossless UTF-8 probe and
 *      written back byte-for-byte — never round-tripped through a string.
 *   2. The app's own toolchain. A published app carries its own package.json /
 *      tsconfig / vite.config / index.html (see `selectSourceFiles`); those are
 *      dropped so eject's clean, platform-free toolchain wins. Deps are
 *      reconstructed from the app's actual imports by the transform.
 *
 * Order is load-bearing: everything above is done in memory, and the
 * destination directory is created only AFTER the residual-platform gate
 * passes — a failed eject never leaves a stray folder behind (matching the
 * same discipline `pull` keeps around its network calls).
 */

import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { downloadObjectGraph, type DownloadOptions } from '../publish/download.js'
import { planTree, type PlannedFile } from '../publish/read-objects.js'
import { eject } from './index.js'

export type EjectReason =
  | 'residual_platform'
  | 'not_ejectable'
  | 'decode_failed'
  | 'unsafe_output'

/** Thrown for eject-specific failures — a leftover platform specifier the
 *  portability gate rejects, an app that can't be ejected (a monorepo), a
 *  source file that isn't valid UTF-8, or an unsafe emitted path. The command
 *  dispatcher maps these to a printed message + non-zero exit. */
export class EjectError extends Error {
  constructor(
    public reason: EjectReason,
    message: string,
    public details?: { residual?: Record<string, string[]>; path?: string },
  ) {
    super(message)
    this.name = 'EjectError'
  }
}

export interface EjectCommandOptions extends DownloadOptions {
  /** Local directory to write the standalone project into. */
  destDir: string
  /** package.json name for the emitted project (default: the alias). */
  pkgName?: string
}

export interface EjectCommandResult {
  fileCount: number
  /** Platform features that degraded to a single-user/no-op fallback. */
  degraded: string[]
  /** npm deps written unpinned (`latest`) the user must review before deploy. */
  reviewDeps: string[]
  /** Human-readable notes from the transform. */
  warnings: string[]
  /** True when the browser-key-exposing secrets shim was vendored (→ warn). */
  secretsVendored: boolean
  headCommit: string
  rootTree: string
  canonical: string
}

/** Toolchain / manifest files eject regenerates cleanly — dropped from the app
 *  source so the platform-free versions win (deps are rebuilt from imports). */
const REGENERATED_EXACT = new Set([
  'package.json',
  'vite.config.ts',
  'vite.config.js',
  'index.html',
  '.gitignore',
  'myth.config.json',
  '.npmrc',
])
const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'])
/** tsconfig.json and its variants (tsconfig.app.json, tsconfig.node.json, …). */
const TSCONFIG_RE = /^tsconfig(\.[\w-]+)?\.json$/
/** Root-level markers that mean "this is a workspace, not a single package". */
const MONOREPO_MARKERS = new Set(['pnpm-workspace.yaml', 'lerna.json'])
const CODE_FILE_RE = /\.(tsx?|jsx?|mjs|cjs)$/

function isRegeneratedToolchain(relPath: string): boolean {
  return REGENERATED_EXACT.has(relPath) || LOCKFILES.has(relPath) || TSCONFIG_RE.test(relPath)
}

/** Reject an emitted path that isn't a safe project-relative path before we
 *  join it onto destDir — defense in depth (emitted keys are constant/derived,
 *  but never trust a path you're about to write). */
function assertSafeRelPath(relPath: string): void {
  if (relPath.length === 0 || relPath.startsWith('/') || relPath.includes('\\')) {
    throw new EjectError('unsafe_output', `Refusing to write unsafe path: ${JSON.stringify(relPath)}`, {
      path: relPath,
    })
  }
  for (const seg of relPath.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new EjectError('unsafe_output', `Refusing to write unsafe path: ${JSON.stringify(relPath)}`, {
        path: relPath,
      })
    }
  }
}

export async function ejectCommand(opts: EjectCommandOptions): Promise<EjectCommandResult> {
  const { site, objects } = await downloadObjectGraph(opts)
  const plan = planTree(site.rootTree, objects)

  // Refuse a workspace/monorepo: eject emits a single flat package and can't
  // reason about workspace layout, so a partial export would be worse than an
  // honest refusal. Checked against the RAW plan, before anything is dropped.
  const monorepoMarker = plan.find(f => MONOREPO_MARKERS.has(f.relPath))
  if (monorepoMarker) {
    throw new EjectError(
      'not_ejectable',
      `This app is a workspace/monorepo (found ${monorepoMarker.relPath}); ` +
        `eject only supports single-package apps for now.`,
    )
  }

  // Split the app source: text files feed the string-only transform; binary
  // blobs bypass it entirely and are written back byte-for-byte. A UTF-8 blob
  // re-encodes identically, so classifying by a lossless fatal decode (not a
  // NUL scan) is the only way that never silently corrupts a binary.
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const textFiles: Record<string, string> = {}
  const binaryFiles: PlannedFile[] = []
  for (const file of plan) {
    if (isRegeneratedToolchain(file.relPath)) continue // eject emits clean versions
    let text: string | null = null
    try {
      text = decoder.decode(file.content)
    } catch {
      text = null
    }
    if (text === null) {
      // A source file that isn't valid UTF-8 is genuinely broken — fail loudly
      // rather than smuggle it through as a binary and emit a non-building app.
      if (CODE_FILE_RE.test(file.relPath)) {
        throw new EjectError('decode_failed', `Source file is not valid UTF-8: ${file.relPath}`, {
          path: file.relPath,
        })
      }
      binaryFiles.push(file)
    } else {
      textFiles[file.relPath] = text
    }
  }

  // The pure transform — rewrite imports, vendor the runtime, emit toolchain.
  const result = eject(textFiles, { name: opts.pkgName ?? opts.name })

  // Portability gate: a residual platform specifier means the export still
  // depends on us — fail before writing anything (defense in depth; the
  // transform's own tests assert this stays empty for a well-formed app).
  const residualPaths = Object.keys(result.residual)
  if (residualPaths.length > 0) {
    throw new EjectError(
      'residual_platform',
      `Export still references platform packages in ${residualPaths.length} file(s): ` +
        `${residualPaths.join(', ')}. This is a bug — update myth-cli (its platform-` +
        `specifier list may be stale) and re-run.`,
      { residual: result.residual },
    )
  }

  // Everything above was in memory. Only now touch disk — a failed eject never
  // leaves a stray directory behind.
  await mkdir(opts.destDir, { recursive: true })
  const encoder = new TextEncoder()
  for (const [relPath, content] of Object.entries(result.files)) {
    assertSafeRelPath(relPath)
    const full = path.join(opts.destDir, ...relPath.split('/'))
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, encoder.encode(content))
  }
  for (const file of binaryFiles) {
    assertSafeRelPath(file.relPath)
    const full = path.join(opts.destDir, ...file.relPath.split('/'))
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, file.content)
  }

  const fileCount = Object.keys(result.files).length + binaryFiles.length
  return {
    fileCount,
    degraded: result.degraded,
    reviewDeps: result.reviewDeps,
    warnings: result.warnings,
    secretsVendored: 'src/_portable/secrets.ts' in result.files,
    headCommit: site.headCommit,
    rootTree: site.rootTree,
    canonical: site.canonical,
  }
}
