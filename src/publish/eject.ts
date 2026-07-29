/**
 * `myth eject` — export a published app as a standalone, runnable Vite/React
 * project you own. THIN CLIENT: the eject transform runs server-side
 * (`GET /publish/eject/{name}`, backed by mythwork `shared/eject`), so the CLI
 * and the frontend "eject" button funnel through one implementation and get
 * byte-identical output. This file only: resolve backend + auth, download the
 * server-ejected project as a path-tagged OCPK pack, and write it to disk.
 *
 * Same discipline as `myth pull`: the destination directory is created only
 * after the download succeeds and every path in the pack is validated, so a
 * failed eject never leaves a stray folder behind.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { acquireSessionToken, resolveBackend } from './index.js'
import { fetchEjectPack, PublishError } from './client.js'
import { unpackExport } from './export-pack.js'

export interface EjectOptions {
  /** The published alias to eject, e.g. "my-app". */
  name: string
  /** Local directory to write the standalone project into. */
  destDir: string
  /** When true, target api.llama.space (staging). Default: api.myth.work (prod). */
  staging?: boolean
  /** Override the worker base URL (escape hatch for local dev). */
  apiUrl?: string
  /** Override the auth origin (escape hatch / for local dev). */
  authOrigin?: string
  /** Override fetch (for tests). */
  fetch?: typeof fetch
}

export interface EjectResult {
  fileCount: number
  /** True when the export vendored the secrets shim (browser-key exposure warning). */
  secretsVendored: boolean
}

/** Reject a pack path that isn't a safe project-relative path before joining it
 *  onto destDir — defense in depth against a malformed/hostile pack. */
function assertSafeRelPath(relPath: string): void {
  const unsafe =
    relPath.length === 0 ||
    relPath.startsWith('/') ||
    relPath.includes('\\') ||
    relPath.split('/').some(seg => seg === '' || seg === '.' || seg === '..')
  if (unsafe) {
    throw new PublishError('corrupt_pack', `eject pack contains an unsafe path: ${JSON.stringify(relPath)}`)
  }
}

/**
 * Public entry point — wired into `bin/myth.ts` as the `eject` case. Throws on
 * hard failures (name not found, not the owner, not ejectable, network); the
 * dispatcher prints the message and exits non-zero.
 */
export async function ejectCommand(opts: EjectOptions): Promise<EjectResult> {
  const { apiUrl, authOrigin } = resolveBackend(opts)
  console.log(`[myth] Backend: ${apiUrl}`)

  const session = await acquireSessionToken(authOrigin)
  console.log(`[myth] ✓ Signed in as ${session.who}`)

  console.log(`[myth] Ejecting '${opts.name}' (transform runs server-side)...`)
  const pack = await fetchEjectPack(opts.name, {
    apiUrl,
    sessionToken: session.token,
    fetch: opts.fetch,
  })
  const files = unpackExport(pack)

  // Validate every path in memory BEFORE creating the destination directory,
  // so a malformed pack never leaves a half-written folder behind.
  for (const relPath of files.keys()) assertSafeRelPath(relPath)

  await mkdir(opts.destDir, { recursive: true })
  for (const [relPath, bytes] of files) {
    const full = path.join(opts.destDir, ...relPath.split('/'))
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, bytes)
  }

  console.log(
    `[myth] ✓ Ejected '${opts.name}' — ${files.size} file${files.size === 1 ? '' : 's'}.`,
  )

  return { fileCount: files.size, secretsVendored: files.has('src/_portable/secrets.ts') }
}

export { PublishError }
