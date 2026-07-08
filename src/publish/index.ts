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
  type FinalizeResult,
  finalizePublish,
  provisionProject,
  PublishError,
  uploadBlobs,
} from './client.js'
import { uploadBlobsPacked } from './pack-upload.js'
import { createProgress } from './progress.js'
import { pollBuildStatus } from './build-status-poller.js'

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
  /**
   * Skip the post-finalize build-status stream; exit immediately after
   * printing "✓ Published." (today's fire-and-forget behaviour). This is an
   * explicit escape hatch for callers who genuinely want fire-and-forget —
   * it is NOT the default for deferred (Tier-2) publishes: a deferred build
   * that later fails must not be reported as a silent success, so deferred
   * publishes always stream build status regardless of TTY unless the
   * caller passes --no-wait explicitly.
   */
  noWait?: boolean
  /**
   * Force build-status streaming even when stdout is not a TTY (e.g. the
   * user explicitly asked to watch in a CI log). Has no effect when
   * --no-wait is also set, and has no effect on deferred (Tier-2) publishes,
   * which always stream regardless of this flag.
   */
  watch?: boolean
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
 * The project to publish to when explicitly pinned. `MYTH_PROJECT_ID` (set by
 * CI per stage — staging and prod own DIFFERENT pids) takes precedence over a
 * committed `config.projectId`; with neither set the caller is name-only and
 * the project is resolved via the idempotent provision lookup (AGE-81).
 *
 * Keeping the per-stage pin in the ENVIRONMENT — not myth.config.json — lets a
 * single committed name-only config serve both stages: each workflow exports
 * the pid its OIDC identity owns, so finalize goes straight to the publish
 * worker (which accepts the GitHub-OIDC token) rather than the provision
 * endpoint (which only accepts a session JWT, so OIDC CI would 401 there). A
 * blank/whitespace `MYTH_PROJECT_ID` is treated as unset.
 */
export function resolvePinnedProjectId(
  config: { projectId?: string },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = env.MYTH_PROJECT_ID?.trim()
  if (fromEnv) return fromEnv
  return config.projectId
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
export async function acquireSessionToken(authOrigin: string): Promise<{
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
 * Whether to stream (and block on) build status after a finalize.
 *
 * Deferred (Tier-2) publishes always stream, regardless of TTY or --watch:
 * the alias doesn't cut over until the server-side build succeeds, so a
 * caller that doesn't wait for the result can't tell a failed build from a
 * successful one — exactly the gap that let a `no_lockfile` Tier-2 build
 * failure report as a silent CI-green success. `--no-wait` is the one
 * explicit override that still forces fire-and-forget, even when deferred.
 *
 * Non-deferred (Tier-1) publishes keep the original behavior: stream only
 * in an interactive TTY, or when `--watch` forces it in a non-TTY context.
 *
 * Pure function of plain booleans (no `process.stdout.isTTY` read inside)
 * so it's unit-testable without mocking global state.
 */
export function shouldStreamBuildStatus(opts: {
  noWait?: boolean
  watch?: boolean
  isTTY: boolean
  deferred: boolean
}): boolean {
  return !opts.noWait && (opts.watch || opts.isTTY || opts.deferred)
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
  const pinnedProjectId = resolvePinnedProjectId(config)
  const zoneSuffix = inferZoneSuffix(apiUrl)
  console.log(
    `[myth] Project: ${config.name}${pinnedProjectId ? ` (pinned ${pinnedProjectId})` : ''}`,
  )
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
    const progress = createProgress('Uploading', Boolean(process.stdout.isTTY), formatBytes)
    try {
      await uploadBlobsPacked(toUpload, {
        apiUrl,
        sessionToken: session.token,
        rootTree: built.rootTree,
        shortName,
        onProgress: e => {
          // Drive the bar by bytes flushed to the socket so it fills smoothly
          // even when the whole publish is a single pack POST. The first
          // 'upload-bytes' event (sent=0) fires synchronously and draws the
          // empty bar.
          if (e.kind === 'upload-bytes') {
            progress.update(e.sent, e.total)
          }
        },
      })
    } finally {
      // Terminate the bar's line even on error, so a thrown PublishError prints
      // on its own line instead of colliding with the half-drawn bar.
      progress.finish()
    }
  }

  // 5. Resolve the target project, then finalize.
  const finalizeBase = {
    apiUrl,
    sessionToken: session.token,
    rootTree: built.rootTree,
    shortName,
    apex: opts.apex,
  }
  const localId = slugifyLocalId(config.name)

  // AGE-81: the projectId is per-(user, stage) DERIVED state — never committed.
  // Committing it dirties the tree and 403s every OTHER user/stage (the exact
  // failure the AGE-55→67 chain kept hitting).
  //
  //  - Name-only config (the normal case): resolve the project at publish via
  //    the idempotent POST /project/provision. The provision call IS the lookup
  //    — (owner, slug) ⇒ the SAME pid every time (~100ms) — so there is no
  //    write-back, no sidecar, no state to drift. Two users publishing the same
  //    app name each converge on their own project per stage.
  //  - projectId PINNED (env MYTH_PROJECT_ID — wins — or a committed
  //    config.projectId): an explicit TEAM-SHARED pin — "publish to exactly
  //    this project, membership required." Try it directly; on a not-owner 403
  //    the caller isn't a member, so fall back to their OWN project (same
  //    idempotent provision) and WARN — rather than silently burying the
  //    pin or writing over it.
  let result: FinalizeResult
  if (pinnedProjectId) {
    console.log('[myth] Finalizing...')
    try {
      result = await finalizePublish(built.headCommit, {
        ...finalizeBase,
        projectId: pinnedProjectId,
      })
    } catch (e) {
      if (!(e instanceof PublishError) || e.code !== 'not_owner') throw e
      console.log(
        `[myth] ⚠ Pinned projectId '${pinnedProjectId}' isn't yours to publish to — ` +
          `using your own project for '${config.name}' instead.`,
      )
      const ownId = await provisionProject({
        apiUrl,
        sessionToken: session.token,
        localId,
        projectName: config.name,
      })
      result = await finalizePublish(built.headCommit, { ...finalizeBase, projectId: ownId })
    }
  } else {
    const projectId = await provisionProject({
      apiUrl,
      sessionToken: session.token,
      localId,
      projectName: config.name,
    })
    console.log('[myth] Finalizing...')
    result = await finalizePublish(built.headCommit, { ...finalizeBase, projectId })
  }
  if (result.timings) {
    const t = result.timings
    const scan = t.scanCached ? 'scan cached' : `scan ${(t.scanMs / 1000).toFixed(1)}s`
    console.log(
      `[myth] Finalized in ${(t.totalMs / 1000).toFixed(1)}s (walk ${(t.walkMs / 1000).toFixed(1)}s · ${scan} · compile ${(t.compileMs / 1000).toFixed(1)}s)`,
    )
  }
  console.log('[myth] ✓ Published. (Live for you now; public once the safety scan passes.)')
  console.log(`[myth]   Canonical: https://${result.canonical}.${zoneSuffix}`)
  if (result.alias) {
    console.log(`[myth]   Alias:     https://${result.alias}.${zoneSuffix}`)
  }
  if (result.apex) {
    console.log(`[myth]   Apex:      https://${zoneSuffix}  (default app set)`)
  }
  printPublishWarnings(result.warnings)
  if (result.deferred) {
    console.log(
      '[myth] Deferred cutover: current version stays live until the new build succeeds.',
    )
  }

  // Stream Tier-2 build status when appropriate.
  //
  // Deferred (Tier-2) publishes ALWAYS stream and block on the result — in
  // CI, in scripts, everywhere — because the alias doesn't cut over until
  // the server-side build succeeds, and a build that later fails must not
  // report a silent success. This was resolved after an incident where a
  // Tier-2 build failed (`no_lockfile`) after a non-TTY CI invocation
  // exited 0 immediately, so the alias never promoted but the GitHub
  // Actions job stayed green throughout.
  //
  // Non-deferred (Tier-1) publishes keep the original default: stream only
  // in interactive TTY contexts, or when --watch forces it in a non-TTY
  // context (e.g. a CI log the caller wants to watch anyway).
  //
  // --no-wait is still an explicit escape hatch that forces fire-and-forget
  // even for deferred publishes, for callers who deliberately want it.
  const shouldStream = shouldStreamBuildStatus({
    noWait: opts.noWait,
    watch: opts.watch,
    isTTY: Boolean(process.stdout.isTTY),
    deferred: result.deferred,
  })
  if (shouldStream) {
    const aliasUrl = result.alias ? `${result.alias}.${zoneSuffix}` : undefined
    const pollResult = await pollBuildStatus(result.tree, {
      apiUrl,
      sessionToken: session.token,
      aliasUrl,
      deferred: result.deferred,
    })
    if (pollResult.exitCode !== 0) {
      process.exitCode = pollResult.exitCode
    }
  }
}

/**
 * Subscribe to build status for an already-published tree without
 * re-packaging or re-uploading. Used by `myth publish --subscribe <tree>`.
 * Always streams regardless of TTY.
 */
export async function subscribeCommand(opts: {
  tree: string
  staging?: boolean
  apiUrl?: string
  authOrigin?: string
}): Promise<void> {
  const { apiUrl, authOrigin } = resolveBackend(opts)
  const session = await acquireSessionToken(authOrigin)
  const zoneSuffix = inferZoneSuffix(apiUrl)
  console.log(`[myth] Subscribing to build status for ${opts.tree.slice(0, 12)}…`)
  const pollResult = await pollBuildStatus(opts.tree, {
    apiUrl,
    sessionToken: session.token,
    aliasUrl: undefined,
  })
  // surfacing a deploy URL isn't possible here (no alias info at subscribe time),
  // but the poller still prints "App deployed" on success.
  void zoneSuffix
  if (pollResult.exitCode !== 0) {
    process.exitCode = pollResult.exitCode
  }
}

/**
 * Print finalize warnings, collapsing the host-provided-dep family (AGE-78).
 * The edge emits one `Ignoring <name>@<range>; this app uses the host-provided
 * …` warning PER workspace/host-provided dep — 8 near-identical lines for a
 * monorepo app drowns out anything else. Collapse 3+ of them into one summary
 * (naming the deps); other warnings still print individually.
 */
export function printPublishWarnings(warnings: string[]): void {
  const hostProvided: string[] = []
  const other: string[] = []
  for (const w of warnings) {
    const name = hostProvidedDepName(w)
    if (name) hostProvided.push(name)
    else other.push(w)
  }
  if (hostProvided.length >= 3) {
    const shown = hostProvided.slice(0, 3).join(', ')
    const more = hostProvided.length > 3 ? `, +${hostProvided.length - 3} more` : ''
    console.log(
      `[myth] ⚠ ${hostProvided.length} host-provided deps skipped from the importmap (${shown}${more}) — served by the platform runtime, not esm.sh.`,
    )
  } else {
    // 0–2: keep the full per-dep message (low volume, more informative).
    for (const name of hostProvided) {
      const full = warnings.find(w => hostProvidedDepName(w) === name)
      if (full) console.log(`[myth] ⚠ ${full}`)
    }
  }
  for (const w of other) console.log(`[myth] ⚠ ${w}`)
}

/**
 * Return the dep name from a host-provided "Ignoring <name>@<range>; this app
 * uses the host-provided …" warning, or null if it isn't one. Uses the last
 * `@` so scoped names (`@orbitcode/auth`) survive.
 */
function hostProvidedDepName(w: string): string | null {
  if (!w.startsWith('Ignoring ') || !w.includes('host-provided')) return null
  const semi = w.indexOf(';')
  const head = semi === -1 ? w.slice('Ignoring '.length) : w.slice('Ignoring '.length, semi)
  const at = head.lastIndexOf('@')
  return at > 0 ? head.slice(0, at) : head
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

/**
 * Stable provision key for an app (AGE-67). Idempotent provisioning is keyed
 * by (owner, localId); deriving it from the config name means repeat publishes
 * of the same app on a stage converge on ONE project instead of minting
 * strays. `website-tennis` → `website-tennis`; empty/odd names → `app`.
 */
export function slugifyLocalId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'app'
}
