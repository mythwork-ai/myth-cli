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

import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadConfigOrThrow, OrbitConfigError } from '../virtual-html.js'
import { assembleSourceAndHash } from './build-objects.js'
import { selectSourceFiles } from './source-select.js'
import { validateSource } from './validate.js'
import { runAuthHandshake } from './auth-handshake.js'
import { hexToCrockford256, servedTreeLabel } from './crockford.js'
import {
  checkBlobs,
  finalizePublish,
  PublishError,
  uploadBlobs,
} from './client.js'
import { uploadBlobsPacked } from './pack-upload.js'
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
  /**
   * Set this publish as the zone's apex default app (https://{zone}/ —
   * the reserved `~apex` pointer). Owner-gated server-side: the session's
   * userId must equal the deployed APEX_OWNER_USER_ID.
   */
  apex?: boolean
  /** Publish even when the target URL already serves this exact content. */
  force?: boolean
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


// ===========================================================================
// Session-token acquisition: env → cache → browser handshake
// ===========================================================================

function tokenCachePath(authOrigin: string): string {
  const host = (() => {
    try {
      return new URL(authOrigin).hostname
    } catch {
      return 'default'
    }
  })()
  return path.join(os.homedir(), '.config', 'myth', `session-${host}.json`)
}

/** JWT exp (unix seconds) without verification — good enough to skip a
 *  cached token the worker would reject anyway. */
function jwtExp(token: string): number | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      exp?: unknown
    }
    return typeof parsed.exp === 'number' ? parsed.exp : null
  } catch {
    return null
  }
}

const TOKEN_EXP_MARGIN_SECONDS = 300

/**
 * Persist the session cache with owner-only permissions ENFORCED, not just
 * requested: `writeFile`'s `mode` applies only when the file is created
 * (O_CREAT); the default 'w' flag truncates an existing inode and keeps its
 * old permission bits. The explicit chmod covers the overwrite path (and a
 * pre-existing loose file); the dir is owner-only too. Exported for tests.
 */
export async function writeSessionCache(
  cacheFile: string,
  token: string,
  who: string,
): Promise<void> {
  await mkdir(path.dirname(cacheFile), { recursive: true, mode: 0o700 })
  await writeFile(cacheFile, JSON.stringify({ token, who }), { mode: 0o600 })
  await chmod(cacheFile, 0o600)
}

/**
 * Acquire a session token. `MYTH_SESSION_TOKEN` (headless/CI) wins; then a
 * cached token that isn't within 5 minutes of expiry; else the browser
 * handshake, whose token is cached for next time.
 */
async function acquireSessionToken(authOrigin: string): Promise<{
  token: string
  who: string
}> {
  const envToken = process.env.MYTH_SESSION_TOKEN
  if (envToken) return { token: envToken, who: '(MYTH_SESSION_TOKEN)' }

  const cacheFile = tokenCachePath(authOrigin)
  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf-8')) as {
      token?: unknown
      who?: unknown
    }
    if (typeof cached.token === 'string') {
      const exp = jwtExp(cached.token)
      if (exp !== null && exp > Date.now() / 1000 + TOKEN_EXP_MARGIN_SECONDS) {
        return {
          token: cached.token,
          who: typeof cached.who === 'string' ? cached.who : '(cached session)',
        }
      }
    }
  } catch {
    // no cache / unreadable — fall through to the handshake
  }

  const handshake = await runAuthHandshake({ authOrigin })
  const who = handshake.userEmail ?? handshake.userId ?? '(unknown user)'
  try {
    await writeSessionCache(cacheFile, handshake.sessionToken, who)
  } catch {
    // cache write is best-effort; the publish proceeds either way
  }
  return { token: handshake.sessionToken, who }
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
  const zoneSuffix = inferZoneSuffix(apiUrl)
  console.log(`[myth] Project: ${config.name} (${config.projectId})`)
  console.log(`[myth] Backend: ${apiUrl}${opts.apex ? ' (apex default)' : ''}`)

  // 1. Validate + assemble source (no local build — the edge compiles).
  const pkgPath = path.join(root, 'package.json')
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {}
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    } catch (e) {
      throw new OrbitConfigError(`Cannot parse ${pkgPath}: ${(e as Error).message}`)
    }
  }
  // Runtime deps drive validation + the edge importmap. (peerDependencies are
  // not validated — an app's own imports come from its dependencies; a peer dep
  // it actually imports should also appear in dependencies.)
  const deps: Record<string, string> = pkg.dependencies ?? {}
  const files = selectSourceFiles(root)
  const errors = validateSource({ files, deps })
  if (errors.length > 0) {
    throw new OrbitConfigError('Cannot publish — fix these first:\n  - ' + errors.join('\n  - '))
  }
  // No local build of any kind — Tailwind included. The platform compiles
  // source server-side (Sucrase + Tailwind v4 + esm.sh importmaps), so the
  // published tree is exactly the source: deterministic hashes, one bake path.
  const buildStart = Date.now()
  console.log('[myth] Packaging source...')
  // Reuse the already-computed file list (avoid a second filesystem walk).
  const built = await assembleSourceAndHash(root, files)
  const buildSec = ((Date.now() - buildStart) / 1000).toFixed(1)
  console.log(
    `[myth] Packaged in ${buildSec}s. ${built.fileCount} files, ` +
      `${formatBytes(built.totalBytes)} (tree ${built.rootTree.slice(0, 12)}…).`,
  )

  // 2. No-op check: compare against what the target URL CURRENTLY serves
  // (extracted from the outer page's content-addressed inner origin). Mere
  // CAS membership would wrongly no-op a revert; only an exact served-tree
  // match skips. Skipping mints no commit, so commit dates stay meaningful.
  if (!opts.force) {
    const targetUrl = opts.apex
      ? `https://${zoneSuffix}/`
      : shortName
        ? `https://${shortName}.${zoneSuffix}/`
        : null
    if (targetUrl) {
      const served = await servedTreeLabel(targetUrl)
      if (served !== null && served === hexToCrockford256(built.rootTree)) {
        console.log(`[myth] ${targetUrl} already serves this exact content — nothing to publish.`)
        console.log('[myth] Pass --force to publish anyway (fresh commit, recompile/rescan).')
        return
      }
    }
  }

  // 3. Auth (MYTH_SESSION_TOKEN env → ~/.config/myth cache → browser).
  const session = await acquireSessionToken(authOrigin)
  console.log(`[myth] ✓ Signed in as ${session.who}`)

  // 3. Check. The worker derives the GC scope server-side from the
  // authenticated user + rootTree + shortName; we only send those inputs.
  const allHashes = [...built.objects.keys()]
  console.log(`[myth] Checking blob storage (${allHashes.length} objects)...`)
  const missing = await checkBlobs(allHashes, {
    apiUrl,
    sessionToken: session.token,
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
    await uploadBlobsPacked(toUpload, {
      apiUrl,
      sessionToken: session.token,
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
    sessionToken: session.token,
    rootTree: built.rootTree,
    shortName,
    apex: opts.apex,
  })
  console.log('[myth] ✓ Published. (Live for you now; public once the safety scan passes.)')
  console.log(`[myth]   Canonical: https://${result.canonical}.${zoneSuffix}`)
  if (result.alias) {
    console.log(`[myth]   Alias:     https://${result.alias}.${zoneSuffix}`)
  }
  if (result.apex) {
    console.log(`[myth]   Apex:      https://${zoneSuffix}  (default app set)`)
  }
  for (const w of result.warnings) {
    console.log(`[myth] ⚠ ${w}`)
  }
}

/**
 * Derive the serve zone (the host suffix that maps to the serve worker)
 * from the API URL. api.myth.work serves *.myth.work; api.llama.space
 * serves *.llama.space. Defaults to myth.work for unparseable URLs
 * (which is the prod default — see resolveBackend).
 */
export function inferZoneSuffix(apiUrl: string): string {
  try {
    const u = new URL(apiUrl)
    const host = u.hostname
    if (host.startsWith('api.')) return host.slice(4)
    return host
  } catch {
    return 'myth.work'
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
