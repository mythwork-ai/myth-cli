/**
 * Select the source files to upload for `myth publish`.
 *
 * Inclusion = every regular file under the project root, minus:
 *   - hard heuristic excludes (node_modules/.git anywhere; build-output dirs at
 *     the root: dist, .next, .turbo, .cache, .vercel, .wrangler)
 *   - a hard secret-file floor (`.env`, `*.pem`, `*.key`, …) applied even when
 *     the project has no `.gitignore` — a defense-in-depth backstop so secrets
 *     never leave the machine regardless of the user's ignore rules
 *   - anything matched by the project's `.gitignore` files (root *and* nested),
 *     so the user's own ignore rules are honored at every directory level
 *
 * `.gitignore` matching is delegated to the `ignore` package (full gitignore
 * semantics: globs, anchoring, negation, dir patterns). Symlinks are skipped
 * entirely — source apps don't contain symlinked source, and skipping avoids
 * both dangling-link crashes and traversal outside the project root.
 *
 * Returns POSIX-style relative paths, sorted for determinism.
 *
 * The secret floor is the one exclusion a project cannot infer from its own
 * config, so `selectSourceFilesReporting` also reports what it removed and
 * `secretExclusionNotice` turns that into the line `myth publish` prints.
 */
import { readdirSync, readFileSync, lstatSync, existsSync } from 'node:fs'
import path from 'node:path'
import ignore from 'ignore'

type Matcher = ReturnType<typeof ignore>

/** Excluded wherever they appear in the tree (always junk / never source). */
// `.claude`/`.worktrees` hold agent session worktrees (full nested checkouts
// of this or other repos) — never app source, and recursing into them can
// publish an entire second working tree.
const HARD_EXCLUDE_DIRS_ANY = new Set(['node_modules', '.git', '.claude', '.worktrees'])

/** Excluded only at the project root (a nested `dist/` may be committed source). */
const HARD_EXCLUDE_DIRS_ROOT = new Set([
  'dist',
  '.next',
  '.turbo',
  '.cache',
  '.vercel',
  '.wrangler',
])

/**
 * Hard secret-file floor — applied independently of `.gitignore` so a project
 * with no (or an incomplete) `.gitignore` still never uploads credentials.
 * `.env.example`/`.sample`/`.template` are re-included (safe, commonly shared).
 */
const SECRET_PATTERNS = [
  '.env',
  '.env.*',
  '!.env.example',
  '!.env.sample',
  '!.env.template',
  '!.env.defaults',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.keystore',
  '*.jks',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]

/** A `.gitignore` matcher scoped to the directory it was loaded from. */
interface ScopedMatcher {
  /** POSIX dir path relative to root ('' for the root .gitignore). */
  baseRel: string
  ig: Matcher
}

/** True if `relPosix` is ignored by any ancestor `.gitignore` matcher. */
function gitignored(
  relPosix: string,
  matchers: ScopedMatcher[],
  isDir: boolean,
): boolean {
  for (const m of matchers) {
    // Path of the target relative to this matcher's own directory.
    const sub = m.baseRel === '' ? relPosix : relPosix.slice(m.baseRel.length + 1)
    if (!sub) continue
    // Test both the bare path and a trailing-slash form so dir-only patterns
    // (`coverage/`) prune the directory here.
    if (m.ig.ignores(sub) || (isDir && m.ig.ignores(sub + '/'))) return true
  }
  return false
}

/** What `selectSourceFilesReporting` found: the upload set, plus what the
 *  secret floor took out of it. */
export interface SourceSelection {
  /** The files to upload. */
  files: string[]
  /** Paths removed by the hard secret floor (`SECRET_PATTERNS`) rather than by
   *  `.gitignore` or a build-output heuristic. Reported because the floor is
   *  invisible to the caller otherwise: a project can commit `.env.production`
   *  on purpose, watch a publish succeed, and never learn the file did not
   *  travel — which is exactly how myth-fff shipped a build with no Sentry DSN
   *  or Amplitude keys inlined and no signal that anything was missing. */
  secretsExcluded: string[]
}

/** `selectSourceFiles`, but also reporting what the secret floor excluded. Both
 *  come from the same single walk, so this costs nothing extra. */
export function selectSourceFilesReporting(root: string): SourceSelection {
  const secret = ignore().add(SECRET_PATTERNS)
  const out: string[] = []
  const secretsExcluded: string[] = []

  function walk(dir: string, relDir: string, matchers: ScopedMatcher[]): void {
    // Layer this directory's own .gitignore (if any) onto the inherited set.
    let scoped = matchers
    const giPath = path.join(dir, '.gitignore')
    if (existsSync(giPath)) {
      scoped = [...matchers, { baseRel: relDir, ig: ignore().add(readFileSync(giPath, 'utf-8')) }]
    }

    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      const relPosix = relDir === '' ? name : `${relDir}/${name}`
      const st = lstatSync(full)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        if (HARD_EXCLUDE_DIRS_ANY.has(name)) continue
        if (relDir === '' && HARD_EXCLUDE_DIRS_ROOT.has(name)) continue
        if (gitignored(relPosix, scoped, true)) continue
        walk(full, relPosix, scoped)
      } else if (st.isFile()) {
        // Secret floor first — basename or full relative path.
        if (secret.ignores(name) || secret.ignores(relPosix)) {
          secretsExcluded.push(relPosix)
          continue
        }
        if (gitignored(relPosix, scoped, false)) continue
        out.push(relPosix)
      }
    }
  }

  walk(root, '', [])
  return { files: out.sort(), secretsExcluded: secretsExcluded.sort() }
}

export function selectSourceFiles(root: string): string[] {
  return selectSourceFilesReporting(root).files
}

/** How many excluded paths to name before summarising the rest. */
const NOTICE_LIST_LIMIT = 5

/**
 * The publish-time notice for secret-floor exclusions, or null when there is
 * nothing to report. Pure and exported so the wording is unit-tested rather
 * than only ever seen in a publish log.
 *
 * Deliberately phrased as information, not a warning: excluding these is
 * correct and stays correct. What was missing is any statement that it
 * happened, and the one consequence a caller cannot otherwise guess — the
 * server-side build does not see the file either.
 */
export function secretExclusionNotice(secretsExcluded: string[]): string | null {
  if (secretsExcluded.length === 0) return null
  const shown = secretsExcluded.slice(0, NOTICE_LIST_LIMIT).join(', ')
  const rest = secretsExcluded.length - NOTICE_LIST_LIMIT
  const list = rest > 0 ? `${shown}, and ${rest} more` : shown
  return (
    `[myth] Not uploaded (secret-file rule): ${list}\n` +
    `[myth]   The server-side build does not see these either. A value a build ` +
    `needs must live in committed source, not a .env file.`
  )
}
