/**
 * Top-level orchestrator for `myth unpublish`.
 *
 *   1. Resolve project root via loadConfigOrThrow (same as publish).
 *   2. Require --name (unpublishing is deliberate — no config default).
 *   3. Acquire a session token via the same env → cache → browser flow
 *      that publish uses (shared via acquireSessionToken + resolveBackend
 *      from src/publish/index.ts).
 *   4. DELETE /publish/site/{name} with Bearer JWT.
 *   5. Print a success/error message.
 *
 * Default backend is prod (api.myth.work). `--staging` switches to
 * api.llama.space. `--api` overrides entirely.
 */

import { loadConfigOrThrow } from '../virtual-html.js'
import { acquireSessionToken, resolveBackend } from './index.js'
import { deletePublishedSite, PublishError } from './client.js'

export interface UnpublishOptions {
  /** Working directory the command was invoked from. */
  cwd: string
  /** The alias short-name to delete. REQUIRED. */
  name: string
  /** When true, target api.llama.space (staging). Default: api.myth.work (prod). */
  staging?: boolean
  /** Override the worker base URL (escape hatch for local dev). */
  apiUrl?: string
  /** Override the auth origin (escape hatch / for local dev). */
  authOrigin?: string
  /** Override fetch (for tests). */
  fetch?: typeof fetch
}

/**
 * Public entry point — wired into `bin/myth.ts` as the `unpublish` case.
 * Throws on hard failures; the dispatcher prints the message and exits non-zero.
 */
export async function unpublishCommand(opts: UnpublishOptions): Promise<void> {
  // Config check: must be run from a project dir (same discipline as publish).
  loadConfigOrThrow(opts.cwd)

  const { apiUrl, authOrigin } = resolveBackend(opts)
  console.log(`[myth] Backend: ${apiUrl}`)

  const session = await acquireSessionToken(authOrigin)
  console.log(`[myth] ✓ Signed in as ${session.who}`)

  await deletePublishedSite(opts.name, {
    apiUrl,
    sessionToken: session.token,
    fetch: opts.fetch,
  })

  console.log(
    `[myth] ✓ Unpublished '${opts.name}'. Refs released for GC; the alias is gone.`,
  )
}

export { PublishError }
