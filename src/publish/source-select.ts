/**
 * Select the source files to upload for `myth publish`.
 *
 * Inclusion = everything under the project root, minus:
 *   - hard heuristic excludes (node_modules, dist, .git, build caches)
 *   - anything matched by the project's .gitignore (the user's own rules)
 *
 * The .gitignore matching is delegated to the `ignore` package, which
 * implements full gitignore semantics (globs, anchoring, negation, dir
 * patterns) — this is a security boundary (it keeps secrets the user already
 * ignores, e.g. `.env*`, `*.pem`, out of the upload), so we use a well-tested
 * matcher rather than a hand-rolled one.
 *
 * Returns POSIX-style relative paths, sorted for determinism.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import ignore from 'ignore'

const HARD_EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '.vercel',
  '.wrangler',
])

/**
 * Build a predicate that reports whether a POSIX relative path is gitignored.
 * Returns a no-op (never-ignore) predicate when there is no .gitignore.
 */
function loadGitignore(root: string): (relPosix: string) => boolean {
  const file = path.join(root, '.gitignore')
  if (!existsSync(file)) return () => false
  const ig = ignore().add(readFileSync(file, 'utf-8'))
  return (relPosix: string) => relPosix.length > 0 && ig.ignores(relPosix)
}

export function selectSourceFiles(root: string): string[] {
  const ignored = loadGitignore(root)
  const out: string[] = []
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      const relPosix = path.relative(root, full).split(path.sep).join('/')
      const st = statSync(full)
      if (st.isDirectory()) {
        if (HARD_EXCLUDE_DIRS.has(name)) continue
        // Trailing slash so dir-only patterns (`coverage/`) prune here.
        if (ignored(relPosix + '/') || ignored(relPosix)) continue
        walk(full)
      } else if (st.isFile()) {
        if (ignored(relPosix)) continue
        out.push(relPosix)
      }
    }
  }
  walk(root)
  return out.sort()
}
