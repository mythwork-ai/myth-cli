/**
 * Top-level orchestrator for `orbit publish`.
 *
 *   1. Resolve project root by walking up to myth.config.json (same
 *      discipline as `orbit run` — see `src/virtual-html.ts:loadConfigOrThrow`).
 *   2. Run `vite build` and emit the git object graph in memory.
 *   3. Run the browser-mediated auth handshake to get a session JWT.
 *   4. POST /publish/check to find which blobs need uploading.
 *   5. PUT each missing blob (concurrency 6, retries on 5xx).
 *   6. POST /publish to finalize. Worker derives the canonical URL.
 *   7. Print the canonical + optional alias URLs.
 *
 * Default backend is staging (api.llama.space). `--prod` switches to
 * api.myth.work. Reasoning per the spec: this is a new flow with many
 * moving parts; the user explicitly called out the risk of accidental
 * prod publishes during testing.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadConfigOrThrow, OrbitConfigError } from '../virtual-html.js'
import { buildAndHash } from './build-objects.js'
import { runAuthHandshake } from './auth-handshake.js'
import {
  buildScope,
  checkBlobs,
  finalizePublish,
  PublishError,
  uploadBlobs,
} from './client.js'
import { createProgress } from './progress.js'

/** Vite entry candidates — same list as `orbit run` (src/run.ts). */
const DEFAULT_ENTRY_CANDIDATES = ['src/main.tsx', 'src/main.ts', 'src/App.tsx', 'App.tsx']

export interface PublishOptions {
  /** Working directory the command was invoked from. */
  cwd: string
  /** Optional alias short-name (becomes {name}.myth.work). */
  shortName?: string
  /** When true, publish against api.myth.work. Default: api.llama.space. */
  prod?: boolean
  /** Override the worker base URL (escape hatch for local dev). */
  apiUrl?: string
  /** Override the auth origin (escape hatch / for staging). */
  authOrigin?: string
  /** Override the auto-detected entry. */
  entry?: string
}

const PROD_API_URL = 'https://api.myth.work'
const STAGING_API_URL = 'https://api.llama.space'
const PROD_AUTH_ORIGIN = 'https://orbitcode.ai'
const STAGING_AUTH_ORIGIN = 'https://staging.orbitcode.ai'

/**
 * Resolve which backend pair to use. Precedence:
 *   1. Explicit `--api` flag (always wins for the API; auth follows
 *      `--prod` unless `ORBIT_AUTH_URL` is set).
 *   2. `ORBIT_API_URL` env var.
 *   3. `--prod` flag → api.myth.work + orbitcode.ai.
 *   4. Default → api.llama.space + staging.orbitcode.ai.
 */
export function resolveBackend(opts: {
  prod?: boolean
  apiUrl?: string
  authOrigin?: string
  env?: NodeJS.ProcessEnv
}): { apiUrl: string; authOrigin: string } {
  const env = opts.env ?? process.env
  const apiUrl =
    opts.apiUrl ??
    env.ORBIT_API_URL ??
    (opts.prod ? PROD_API_URL : STAGING_API_URL)
  const authOrigin =
    opts.authOrigin ??
    env.ORBIT_AUTH_URL ??
    (opts.prod ? PROD_AUTH_ORIGIN : STAGING_AUTH_ORIGIN)
  return { apiUrl, authOrigin }
}

function resolveEntry(root: string, requested: string | undefined): string {
  if (requested !== undefined) {
    if (!existsSync(path.join(root, requested))) {
      throw new OrbitConfigError(`entry not found: ${path.join(root, requested)}`)
    }
    return requested
  }
  for (const candidate of DEFAULT_ENTRY_CANDIDATES) {
    if (existsSync(path.join(root, candidate))) return candidate
  }
  throw new OrbitConfigError(
    `no entry file found in ${root}. Tried: ${DEFAULT_ENTRY_CANDIDATES.join(', ')}. ` +
      `Pass --entry <file> to override.`,
  )
}

/**
 * Public entry point — wired into `bin/orbit.ts` as the `publish` case.
 * Throws on hard failures (config missing, build fails, upload aborts);
 * the dispatcher prints the message and exits non-zero.
 */
export async function publishCommand(opts: PublishOptions): Promise<void> {
  const loaded = loadConfigOrThrow(opts.cwd)
  const root = loaded.root
  const config = loaded.config
  const entry = resolveEntry(root, opts.entry)
  // shortName precedence: --name flag > config.defaultPublishName.
  const shortName =
    opts.shortName ??
    (typeof (config as { defaultPublishName?: unknown }).defaultPublishName === 'string'
      ? ((config as { defaultPublishName?: string }).defaultPublishName as string)
      : undefined)

  const { apiUrl, authOrigin } = resolveBackend(opts)
  console.log(`[orbit] Project: ${config.name} (${config.projectId})`)
  console.log(`[orbit] Backend: ${apiUrl}`)

  // 1. Build + hash.
  const buildStart = Date.now()
  console.log('[orbit] Building app (vite build)...')
  const built = await buildAndHash(root, entry)
  const buildSec = ((Date.now() - buildStart) / 1000).toFixed(1)
  console.log(
    `[orbit] Built in ${buildSec}s. ${built.fileCount} files, ` +
      `${formatBytes(built.totalBytes)}.`,
  )

  // 2. Auth.
  const handshake = await runAuthHandshake({ authOrigin })
  const who = handshake.userEmail ?? handshake.userId ?? '(unknown user)'
  console.log(`[orbit] ✓ Signed in as ${who}`)

  // 3. Check.
  const scope = buildScope(built.rootTree, shortName)
  const allHashes = [...built.objects.keys()]
  console.log(`[orbit] Checking blob storage (${allHashes.length} objects)...`)
  const missing = await checkBlobs(allHashes, {
    apiUrl,
    sessionToken: handshake.sessionToken,
    scope,
  })
  const already = allHashes.length - missing.length
  console.log(`[orbit] ${already} already stored, ${missing.length} to upload.`)

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
      scope,
      onProgress: e => {
        if (e.kind === 'uploaded') {
          progress.update(e.index, e.total)
        }
      },
    })
    progress.finish()
  }

  // 5. Finalize.
  console.log('[orbit] Finalizing...')
  const result = await finalizePublish(built.headCommit, shortName, {
    apiUrl,
    sessionToken: handshake.sessionToken,
    scope,
  })
  console.log('[orbit] ✓ Published.')
  const zoneSuffix = inferZoneSuffix(apiUrl)
  console.log(`[orbit]   Canonical: https://${result.canonical}.${zoneSuffix}`)
  if (result.alias) {
    console.log(`[orbit]   Alias:     https://${result.alias}.${zoneSuffix}`)
  }
}

/**
 * Derive the serve zone (the host suffix that maps to the serve worker)
 * from the API URL. api.myth.work serves *.myth.work; api.llama.space
 * serves *.llama.space. Defaults to llama.space for unknown URLs (which
 * is the staging default anyway).
 */
function inferZoneSuffix(apiUrl: string): string {
  try {
    const u = new URL(apiUrl)
    const host = u.hostname
    if (host.startsWith('api.')) return host.slice(4)
    return host
  } catch {
    return 'llama.space'
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
