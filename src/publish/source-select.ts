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
 */
import { readdirSync, readFileSync, lstatSync, existsSync } from 'node:fs'
import path from 'node:path'
import ignore from 'ignore'

type Matcher = ReturnType<typeof ignore>

/** Excluded wherever they appear in the tree (always junk / never source). */
const HARD_EXCLUDE_DIRS_ANY = new Set(['node_modules', '.git'])

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

export function selectSourceFiles(root: string): string[] {
  const secret = ignore().add(SECRET_PATTERNS)
  const out: string[] = []

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
        if (secret.ignores(name) || secret.ignores(relPosix)) continue
        if (gitignored(relPosix, scoped, false)) continue
        out.push(relPosix)
      }
    }
  }

  walk(root, '', [])
  return out.sort()
}
