/**
 * Top-level orchestrator for `myth pull` — the reverse of `myth publish`.
 *
 *   1. Resolve backend + auth (identical env → cache → browser flow
 *      `publish`/`unpublish` use — see `acquireSessionToken` in index.ts).
 *   2. GET /publish/site/{name} to find the currently-live head commit +
 *      root tree for that alias (`resolvePublishedSite` in client.ts).
 *   3. GET /publish/pack/{rootTree} to fetch every object reachable from
 *      that tree (`fetchObjectPack` in pack-download.ts).
 *   4. Index the pack into a hash -> object map (`indexPackObjects`) and
 *      materialize it into real files (`materializeTree`), both in
 *      read-objects.ts.
 *
 * Unlike `publish`/`unpublish`, this deliberately does NOT call
 * `loadConfigOrThrow` — there is no existing project to anchor to; `pull`
 * creates a brand-new directory, the same spirit as `clone`. The
 * destination directory is only created AFTER both network calls succeed,
 * so a failed pull (404/403/network error) never leaves a stray folder
 * behind.
 */

import { mkdir } from 'node:fs/promises'
import { PublishError } from './client.js'
import { downloadObjectGraph, type DownloadOptions } from './download.js'
import { materializeTree, ReconstructError } from './read-objects.js'

export interface PullOptions extends DownloadOptions {
  /** Local directory to materialize the app into. Created if it doesn't exist. */
  destDir: string
}

export interface PullResult {
  fileCount: number
  headCommit: string
  rootTree: string
  canonical: string
}

/**
 * Public entry point — wired into `bin/myth.ts` as the `pull` case.
 * Throws on hard failures (name not found, not the owner, network errors,
 * a corrupt object graph); the dispatcher prints the message and exits
 * non-zero.
 */
export async function pullCommand(opts: PullOptions): Promise<PullResult> {
  const { site, objects } = await downloadObjectGraph(opts)

  // Only create the destination directory once both network calls have
  // succeeded — a failed pull never leaves a stray folder behind.
  await mkdir(opts.destDir, { recursive: true })
  const result = await materializeTree(site.rootTree, objects, opts.destDir)

  console.log(
    `[myth] ✓ Pulled '${opts.name}' — ${result.fileCount} file${result.fileCount === 1 ? '' : 's'}.`,
  )

  return {
    fileCount: result.fileCount,
    headCommit: site.headCommit,
    rootTree: site.rootTree,
    canonical: site.canonical,
  }
}

export { PublishError, ReconstructError }
