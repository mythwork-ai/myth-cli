/**
 * Select the source files to upload for `myth publish`.
 *
 * Inclusion = everything under the project root, minus:
 *   - hard heuristic excludes (node_modules, dist, .git, build caches)
 *   - anything matched by the project's .gitignore (the user's own rules)
 *
 * Returns POSIX-style relative paths, sorted for determinism.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'

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
 * Minimal .gitignore matcher: supports comments, blank lines, `dir/`,
 * leading-slash anchors, and bare names/globs matched per path segment or
 * full relative path. Good enough for excluding the common cases; not a full
 * gitignore spec implementation.
 */
function loadGitignore(root: string): (rel: string) => boolean {
  const file = path.join(root, '.gitignore')
  if (!existsSync(file)) return () => false
  const patterns = readFileSync(file, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'))
  return (rel: string) => {
    const posix = rel.split(path.sep).join('/')
    for (const raw of patterns) {
      const p = raw.replace(/^\//, '').replace(/\/$/, '')
      if (!p) continue
      // Match full path, any path prefix (dir match), or any basename segment.
      if (posix === p) return true
      if (posix.startsWith(p + '/')) return true
      const segs = posix.split('/')
      if (segs.includes(p)) return true
    }
    return false
  }
}

export function selectSourceFiles(root: string): string[] {
  const ignored = loadGitignore(root)
  const out: string[] = []
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      const rel = path.relative(root, full)
      const st = statSync(full)
      if (st.isDirectory()) {
        if (HARD_EXCLUDE_DIRS.has(name)) continue
        if (ignored(rel)) continue
        walk(full)
      } else if (st.isFile()) {
        if (ignored(rel)) continue
        out.push(rel.split(path.sep).join('/'))
      }
    }
  }
  walk(root)
  return out.sort()
}
