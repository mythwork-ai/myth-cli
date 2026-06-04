/**
 * Top-level orchestrator for `myth publish`.
 *
 *   1. Resolve project root by walking up to myth.config.json (same
 *      discipline as `myth run` — see `src/virtual-html.ts:loadConfigOrThrow`).
 *   2. Validate + package the app's SOURCE (no local build) and emit the git
 *      object graph in memory. Compilation happens at the edge at serve time.
 *   3. Run the browser-mediated auth handshake to get a session JWT.
 *   4. POST /publish/check to find which blobs need uploading.
 *   5. PUT each missing blob (concurrency 6, retries on 5xx).
 *   6. POST /publish to finalize. Worker derives the canonical URL.
 *   7. Print the canonical + optional alias URLs.
 *
 * Default backend is prod (api.myth.work). `--staging` switches to
 * api.llama.space. Per spec amendment 2026-05-26: users typing `myth
 * publish` expect their app to land at *.myth.work; staging is a
 * tester's opt-in.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadConfigOrThrow, OrbitConfigError } from '../virtual-html.js'
import { assembleSourceAndHash } from './build-objects.js'
import { selectSourceFiles } from './source-select.js'
import { validateSource } from './validate.js'
import { detectTailwind, prebakeTailwind } from './tailwind.js'
import { runAuthHandshake } from './auth-handshake.js'
import {
  checkBlobs,
  finalizePublish,
  PublishError,
  uploadBlobs,
} from './client.js'
import { createProgress } from './progress.js'

export interface PublishOptions {
  /** Working directory the command was invoked from. */
  cwd: string
  /** Optional alias short-name (becomes {name}.myth.work). */
  shortName?: string
  /** When true, publish against api.llama.space (staging). Default: api.myth.work (prod). */
  staging?: boolean
  /** Override the worker base URL (escape hatch for local dev). */
  apiUrl?: string
  /** Override the auth origin (escape hatch / for local dev). */
  authOrigin?: string
  /** Override the auto-detected entry. */
  entry?: string
}

const PROD_API_URL = 'https://api.myth.work'
const STAGING_API_URL = 'https://api.llama.space'
const PROD_AUTH_ORIGIN = 'https://auth.myth.work'
const STAGING_AUTH_ORIGIN = 'https://auth.llama.space'

/**
 * Resolve which backend pair to use. Precedence:
 *   1. Explicit `--api` flag (always wins for the API; auth follows
 *      `--staging` unless `MYTH_AUTH_URL` is set).
 *   2. `MYTH_API_URL` env var.
 *   3. `--staging` flag → api.llama.space + auth.llama.space.
 *   4. Default → api.myth.work + auth.myth.work.
 */
export function resolveBackend(opts: {
  staging?: boolean
  apiUrl?: string
  authOrigin?: string
  env?: NodeJS.ProcessEnv
}): { apiUrl: string; authOrigin: string } {
  const env = opts.env ?? process.env
  const apiUrl =
    opts.apiUrl ??
    env.MYTH_API_URL ??
    (opts.staging ? STAGING_API_URL : PROD_API_URL)
  const authOrigin =
    opts.authOrigin ??
    env.MYTH_AUTH_URL ??
    (opts.staging ? STAGING_AUTH_ORIGIN : PROD_AUTH_ORIGIN)
  return { apiUrl, authOrigin }
}

/**
 * Public entry point — wired into `bin/myth.ts` as the `publish` case.
 * Throws on hard failures (config missing, build fails, upload aborts);
 * the dispatcher prints the message and exits non-zero.
 */
export async function publishCommand(opts: PublishOptions): Promise<void> {
  const loaded = loadConfigOrThrow(opts.cwd)
  const root = loaded.root
  const config = loaded.config
  // shortName precedence: --name flag > config.defaultPublishName.
  const shortName =
    opts.shortName ??
    (typeof (config as { defaultPublishName?: unknown }).defaultPublishName === 'string'
      ? ((config as { defaultPublishName?: string }).defaultPublishName as string)
      : undefined)

  const { apiUrl, authOrigin } = resolveBackend(opts)
  console.log(`[myth] Project: ${config.name} (${config.projectId})`)
  console.log(`[myth] Backend: ${apiUrl}`)

  // 1. Validate + assemble source (no local build — the edge compiles).
  const pkgPath = path.join(root, 'package.json')
  const deps: Record<string, string> = existsSync(pkgPath)
    ? (JSON.parse(readFileSync(pkgPath, 'utf-8')).dependencies ?? {})
    : {}
  const files = selectSourceFiles(root)
  const errors = validateSource({ files, deps })
  if (errors.length > 0) {
    throw new OrbitConfigError('Cannot publish — fix these first:\n  - ' + errors.join('\n  - '))
  }
  if (detectTailwind(deps)) {
    console.log('[myth] Tailwind detected — pre-baking CSS...')
    // Entry CSS heuristic: the project stylesheet that imports tailwind.
    // Default to src/index.css; fall back to the first *.css in the upload set.
    const entryCss =
      files.find(f => f === 'src/index.css') ?? files.find(f => f.endsWith('.css')) ?? 'src/index.css'
    prebakeTailwind(root, entryCss)
  }
  const buildStart = Date.now()
  console.log('[myth] Packaging source...')
  const built = await assembleSourceAndHash(root)
  const buildSec = ((Date.now() - buildStart) / 1000).toFixed(1)
  console.log(
    `[myth] Packaged in ${buildSec}s. ${built.fileCount} files, ` +
      `${formatBytes(built.totalBytes)}.`,
  )

  // 2. Auth.
  const handshake = await runAuthHandshake({ authOrigin })
  const who = handshake.userEmail ?? handshake.userId ?? '(unknown user)'
  console.log(`[myth] ✓ Signed in as ${who}`)

  // 3. Check. The worker derives the GC scope server-side from the
  // authenticated user + rootTree + shortName; we only send those inputs.
  const allHashes = [...built.objects.keys()]
  console.log(`[myth] Checking blob storage (${allHashes.length} objects)...`)
  const missing = await checkBlobs(allHashes, {
    apiUrl,
    sessionToken: handshake.sessionToken,
    rootTree: built.rootTree,
    shortName,
  })
  const already = allHashes.length - missing.length
  console.log(`[myth] ${already} already stored, ${missing.length} to upload.`)

  // 4. Upload.
  if (missing.length > 0) {
    const toUpload = missing.map(hash => {
      const obj = built.objects.get(hash)
      if (!obj) {
        // Shouldn't happen — the worker can only report hashes we sent.
        throw new PublishError('unknown', `worker reported unknown missing hash: ${hash}`)
      }
      return obj
    })
    const progress = createProgress('Uploading', Boolean(process.stdout.isTTY))
    progress.update(0, missing.length)
    await uploadBlobs(toUpload, {
      apiUrl,
      sessionToken: handshake.sessionToken,
      rootTree: built.rootTree,
      shortName,
      onProgress: e => {
        if (e.kind === 'uploaded') {
          progress.update(e.index, e.total)
        }
      },
    })
    progress.finish()
  }

  // 5. Finalize.
  console.log('[myth] Finalizing...')
  const result = await finalizePublish(built.headCommit, {
    apiUrl,
    sessionToken: handshake.sessionToken,
    rootTree: built.rootTree,
    shortName,
  })
  console.log('[myth] ✓ Published. (Live for you now; public once the safety scan passes.)')
  const zoneSuffix = inferZoneSuffix(apiUrl)
  console.log(`[myth]   Canonical: https://${result.canonical}.${zoneSuffix}`)
  if (result.alias) {
    console.log(`[myth]   Alias:     https://${result.alias}.${zoneSuffix}`)
  }
}

/**
 * Derive the serve zone (the host suffix that maps to the serve worker)
 * from the API URL. api.myth.work serves *.myth.work; api.llama.space
 * serves *.llama.space. Defaults to myth.work for unparseable URLs
 * (which is the prod default — see resolveBackend).
 */
function inferZoneSuffix(apiUrl: string): string {
  try {
    const u = new URL(apiUrl)
    const host = u.hostname
    if (host.startsWith('api.')) return host.slice(4)
    return host
  } catch {
    return 'myth.work'
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
