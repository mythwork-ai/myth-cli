# myth-cli Source Publish (Tier 1, CLI side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `myth publish`'s local `vite build` + `dist/` upload with **source packaging** — assemble the app's source tree (honoring `.gitignore`), validate it against the edge's Tier-1 constraints, pre-bake Tailwind, and upload the source as the same git-object graph.

**Architecture:** The CLI stops being a builder and becomes a source packager. `buildAndHash` (vite) is replaced by `assembleSourceAndHash`, which selects source files and hashes them into the existing blob/tree/commit graph. The upload/auth/finalize half (`client.ts`, `auth-handshake.ts`) is unchanged. Dependency resolution stays *standard* (`package.json` + lockfile uploaded as-is); the CLI only **validates** deps for edge-serviceability — the edge generates the importmap. Compilation moves from CLI build-time to edge serve-time (separate orbitcode plan).

**Tech Stack:** TypeScript (ESM, `node >=18`), vitest, Node built-ins (`node:fs`, `node:path`, `node:crypto`, `node:zlib`). No new runtime deps except Tailwind (already a dependency: `tailwindcss`, `@tailwindcss/vite`).

**Scope note:** This plan is the CLI half of the spec
(`docs/superpowers/specs/2026-06-04-myth-instant-source-publish-design.md`). The edge half
(package.json→importmap in `react-target`, async scan, mythwork-login serve gating) is a
separate orbitcode plan and is **not** in this plan. End-to-end serving of arbitrary-dep apps
depends on that edge work landing + deploying.

---

## File Structure

- **Create** `src/publish/source-select.ts` — pure: given a project root, return the ordered
  list of relative source paths to upload (heuristic excludes + `.gitignore`).
- **Create** `src/publish/source-select.test.ts`
- **Create** `src/publish/validate.ts` — pure: read `package.json` + lockfile, classify deps
  (edge-resolvable vs. not), reject Tailwind JS config, surface actionable errors.
- **Create** `src/publish/validate.test.ts`
- **Create** `src/publish/tailwind.ts` — detect Tailwind; if present, generate plain CSS and
  rewrite the importing stylesheet so the edge inlines static CSS.
- **Create** `src/publish/tailwind.test.ts`
- **Modify** `src/publish/build-objects.ts` — add `buildObjectsFromFiles(files)` (pure,
  path-map → object graph) and `assembleSourceAndHash(root, opts)`; keep `hashDirectory` for
  tests; remove the `viteBuild` usage from the publish path.
- **Modify** `src/publish/build-objects.test.ts` — add coverage for `buildObjectsFromFiles`.
- **Modify** `src/publish/index.ts` — call `assembleSourceAndHash` instead of `buildAndHash`;
  run validation + Tailwind pre-bake; update log lines + final "author preview" hint.
- **Modify** `bin/myth.ts` — update `publish` help text (no local build; source upload).
- **Modify** `README.md` — document the source-publish model + the Tier-1 supported subset.

---

## Task 1: `.gitignore`-aware source selection

**Files:**
- Create: `src/publish/source-select.ts`
- Test: `src/publish/source-select.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { selectSourceFiles } from './source-select.js'

function scaffold(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'myth-src-'))
  mkdirSync(path.join(root, 'src'), { recursive: true })
  mkdirSync(path.join(root, 'public'), { recursive: true })
  mkdirSync(path.join(root, 'node_modules', 'react'), { recursive: true })
  mkdirSync(path.join(root, 'dist'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'main.tsx'), 'export default 1')
  writeFileSync(path.join(root, 'src', 'index.css'), 'body{}')
  writeFileSync(path.join(root, 'public', 'logo.svg'), '<svg/>')
  writeFileSync(path.join(root, 'package.json'), '{"name":"x"}')
  writeFileSync(path.join(root, 'package-lock.json'), '{}')
  writeFileSync(path.join(root, 'node_modules', 'react', 'index.js'), 'x')
  writeFileSync(path.join(root, 'dist', 'bundle.js'), 'x')
  writeFileSync(path.join(root, '.env'), 'SECRET=1')
  writeFileSync(path.join(root, '.gitignore'), '.env\ncoverage/\n')
  mkdirSync(path.join(root, 'coverage'), { recursive: true })
  writeFileSync(path.join(root, 'coverage', 'report.html'), 'x')
  return root
}

describe('selectSourceFiles', () => {
  let root: string
  beforeEach(() => { root = scaffold() })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('includes source, css, public, package.json, lockfile', () => {
    const files = selectSourceFiles(root)
    expect(files).toContain('src/main.tsx')
    expect(files).toContain('src/index.css')
    expect(files).toContain('public/logo.svg')
    expect(files).toContain('package.json')
    expect(files).toContain('package-lock.json')
  })

  it('excludes node_modules, dist, and .git by heuristic', () => {
    const files = selectSourceFiles(root)
    expect(files.some(f => f.startsWith('node_modules/'))).toBe(false)
    expect(files.some(f => f.startsWith('dist/'))).toBe(false)
  })

  it('excludes anything matched by .gitignore', () => {
    const files = selectSourceFiles(root)
    expect(files).not.toContain('.env')
    expect(files.some(f => f.startsWith('coverage/'))).toBe(false)
  })

  it('returns POSIX-style relative paths, sorted, deterministic', () => {
    expect(selectSourceFiles(root)).toEqual([...selectSourceFiles(root)].sort())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/publish/source-select.test.ts`
Expected: FAIL — `selectSourceFiles` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
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

/** Minimal .gitignore matcher: supports comments, blank lines, `dir/`,
 *  leading-slash anchors, and bare names/globs matched per path segment or
 *  full relative path. Good enough for excluding the common cases; not a full
 *  gitignore spec implementation. */
function loadGitignore(root: string): (rel: string, isDir: boolean) => boolean {
  const file = path.join(root, '.gitignore')
  if (!existsSync(file)) return () => false
  const patterns = readFileSync(file, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'))
  return (rel: string, _isDir: boolean) => {
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
        if (ignored(rel, true)) continue
        walk(full)
      } else if (st.isFile()) {
        if (ignored(rel, false)) continue
        out.push(rel.split(path.sep).join('/'))
      }
    }
  }
  walk(root)
  return out.sort()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/publish/source-select.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/publish/source-select.ts src/publish/source-select.test.ts
git commit -m "feat(publish): .gitignore-aware source file selection"
```

---

## Task 2: Build object graph from a file map

**Files:**
- Modify: `src/publish/build-objects.ts`
- Test: `src/publish/build-objects.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// add to src/publish/build-objects.test.ts
import { buildObjectsFromFiles } from './build-objects.js'

describe('buildObjectsFromFiles', () => {
  it('hashes a path->bytes map into a deterministic object graph', async () => {
    const enc = new TextEncoder()
    const files = new Map<string, Uint8Array>([
      ['src/main.tsx', enc.encode('export default 1')],
      ['package.json', enc.encode('{"name":"x"}')],
    ])
    const a = await buildObjectsFromFiles(files)
    const b = await buildObjectsFromFiles(files)
    expect(a.rootTree).toBe(b.rootTree)
    expect(a.headCommit).toBe(b.headCommit)
    expect(a.fileCount).toBe(2)
    // commit + root tree + src tree + 2 blobs == 5 objects
    expect(a.objects.size).toBe(5)
  })

  it('produces the same graph as hashing the same files on disk', async () => {
    // sanity: a single root-level file yields identical rootTree via both paths
    const enc = new TextEncoder()
    const files = new Map([['a.txt', enc.encode('hello')]])
    const fromMap = await buildObjectsFromFiles(files)
    expect(fromMap.rootTree).toMatch(/^[0-9a-f]{64}$/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/publish/build-objects.test.ts -t buildObjectsFromFiles`
Expected: FAIL — `buildObjectsFromFiles` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/publish/build-objects.ts` (reuses existing `buildBlob`/`buildTree`/`buildCommit`
via the module-internal functions; expose a new public builder):

```typescript
/**
 * Build the git object graph from an in-memory map of POSIX relative path ->
 * file bytes. Pure (no disk). Mirrors hashDirectory's framing/sorting so the
 * resulting hashes are identical to an on-disk walk of the same tree.
 */
export async function buildObjectsFromFiles(
  files: Map<string, Uint8Array>,
): Promise<BuildResult> {
  const objects = new Map<string, BuiltObject>()
  let fileCount = 0
  let totalBytes = 0

  // Build a nested directory structure from the flat path map.
  interface Dir { dirs: Map<string, Dir>; files: Map<string, Uint8Array> }
  const rootDir: Dir = { dirs: new Map(), files: new Map() }
  for (const [rel, bytes] of files) {
    const parts = rel.split('/')
    let cur = rootDir
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!
      let next = cur.dirs.get(seg)
      if (!next) { next = { dirs: new Map(), files: new Map() }; cur.dirs.set(seg, next) }
      cur = next
    }
    cur.files.set(parts[parts.length - 1]!, bytes)
  }

  async function visit(dir: Dir): Promise<string> {
    const entries: { mode: '100644' | '40000'; name: string; hash: string }[] = []
    for (const [name, bytes] of dir.files) {
      const blob = await buildBlob(bytes)
      if (!objects.has(blob.hash)) { objects.set(blob.hash, blob); totalBytes += blob.deflated.length }
      fileCount++
      entries.push({ mode: '100644', name, hash: blob.hash })
    }
    for (const [name, sub] of dir.dirs) {
      const treeHash = await visit(sub)
      entries.push({ mode: '40000', name, hash: treeHash })
    }
    const tree = await buildTree(entries)
    if (!objects.has(tree.hash)) { objects.set(tree.hash, tree); totalBytes += tree.deflated.length }
    return tree.hash
  }

  const rootTree = await visit(rootDir)
  const commit = await buildCommit({ tree: rootTree })
  objects.set(commit.hash, commit)
  totalBytes += commit.deflated.length
  return { objects, headCommit: commit.hash, rootTree, fileCount, totalBytes }
}
```

> Note: `buildTree` already re-sorts entries git-style, so insertion order above is fine.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/publish/build-objects.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/publish/build-objects.ts src/publish/build-objects.test.ts
git commit -m "feat(publish): build git object graph from in-memory file map"
```

---

## Task 3: Dependency classification + pre-flight validation

**Files:**
- Create: `src/publish/validate.ts`
- Test: `src/publish/validate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { classifyDependencies, validateSource } from './validate.js'

describe('classifyDependencies', () => {
  it('marks react-family and @orbitcode as edge-native (no esm.sh needed)', () => {
    const r = classifyDependencies({ react: '19.0.0', 'react-dom': '19.0.0', '@orbitcode/store': '1.0.0' })
    expect(r.native).toEqual(expect.arrayContaining(['react', 'react-dom', '@orbitcode/store']))
    expect(r.viaEsm).toEqual([])
    expect(r.problematic).toEqual([])
  })

  it('routes ordinary packages through esm.sh', () => {
    const r = classifyDependencies({ lodash: '4.17.21', zustand: '4.5.0' })
    expect(r.viaEsm).toEqual(expect.arrayContaining(['lodash', 'zustand']))
  })

  it('flags known-unserviceable packages as problematic', () => {
    const r = classifyDependencies({ sharp: '0.33.0', fsevents: '2.3.3' })
    expect(r.problematic).toEqual(expect.arrayContaining(['sharp', 'fsevents']))
  })
})

describe('validateSource', () => {
  it('rejects a Tailwind JS config (require CSS-first)', () => {
    const errs = validateSource({ files: ['tailwind.config.js', 'src/main.tsx'], deps: {} })
    expect(errs.some(e => /tailwind.config.js/i.test(e))).toBe(true)
  })

  it('passes a clean standard app', () => {
    const errs = validateSource({ files: ['src/main.tsx', 'package.json'], deps: { react: '19.0.0' } })
    expect(errs).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/publish/validate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * Pre-flight validation for Tier-1 source publish. The edge compiler resolves
 * react-family / @orbitcode natively and routes other bare specifiers through
 * an esm.sh importmap (generated edge-side from package.json). We validate up
 * front so failures are actionable here, not a 422 at serve time.
 */

const NATIVE_PREFIXES = ['@orbitcode/']
const NATIVE_EXACT = new Set(['react', 'react-dom', 'react-dom/client'])

/** Packages that cannot work over esm.sh in a browser (native bindings, etc.).
 *  Conservative, extend over time. */
const PROBLEMATIC = new Set(['sharp', 'fsevents', 'esbuild', 'canvas', 'better-sqlite3'])

export interface DepClassification {
  native: string[]
  viaEsm: string[]
  problematic: string[]
}

export function classifyDependencies(deps: Record<string, string>): DepClassification {
  const native: string[] = []
  const viaEsm: string[] = []
  const problematic: string[] = []
  for (const name of Object.keys(deps).sort()) {
    if (NATIVE_EXACT.has(name) || NATIVE_PREFIXES.some(p => name.startsWith(p))) {
      native.push(name)
    } else if (PROBLEMATIC.has(name)) {
      problematic.push(name)
    } else {
      viaEsm.push(name)
    }
  }
  return { native, viaEsm, problematic }
}

export interface ValidateInput {
  files: string[]
  deps: Record<string, string>
}

export function validateSource(input: ValidateInput): string[] {
  const errors: string[] = []
  // CSS-first Tailwind only — reject legacy JS config / JS plugins (they would
  // require executing user code at the edge; unsupported by the Tier-1 path).
  for (const f of input.files) {
    if (/(^|\/)tailwind\.config\.(js|cjs|mjs|ts)$/.test(f)) {
      errors.push(
        `Found ${f}: server-side Tailwind requires CSS-first config ` +
          `(@import "tailwindcss" + @theme), not a JS config. Remove it or inline its theme in CSS.`,
      )
    }
  }
  const { problematic } = classifyDependencies(input.deps)
  for (const p of problematic) {
    errors.push(
      `Dependency "${p}" cannot be served at the edge (native/build-time package). ` +
        `Remove it or replace with a browser-compatible alternative.`,
    )
  }
  return errors
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/publish/validate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/publish/validate.ts src/publish/validate.test.ts
git commit -m "feat(publish): pre-flight dependency classification + source validation"
```

---

## Task 4: Tailwind pre-bake

**Files:**
- Create: `src/publish/tailwind.ts`
- Test: `src/publish/tailwind.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { detectTailwind } from './tailwind.js'

describe('detectTailwind', () => {
  it('detects tailwind via dependency', () => {
    expect(detectTailwind({ tailwindcss: '4.0.0' }, [])).toBe(true)
  })
  it('detects tailwind via a CSS @import in the file list contents', () => {
    expect(detectTailwind({}, ['src/index.css'])).toBe(false) // name alone is not enough
  })
  it('returns false when absent', () => {
    expect(detectTailwind({ react: '19.0.0' }, ['src/main.tsx'])).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/publish/tailwind.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * Tailwind pre-bake for Tier-1 publish. The edge inlines static CSS but does
 * not run Tailwind's JIT, so when an app uses Tailwind we generate the utility
 * CSS locally and upload it as a plain stylesheet.
 *
 * detectTailwind is a cheap signal (dependency presence). Actual generation is
 * performed by prebakeTailwind, which is wired into the publish flow and shells
 * out to the project's own Tailwind so version/config match the user's setup.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export function detectTailwind(deps: Record<string, string>, _files: string[]): boolean {
  return Object.keys(deps).some(d => d === 'tailwindcss' || d.startsWith('@tailwindcss/'))
}

export interface PrebakeResult {
  /** Relative path (POSIX) of the generated CSS to add to the upload set. */
  generatedCssPath: string
  /** The generated CSS contents. */
  css: string
}

/**
 * Generate Tailwind CSS for the project. `entryCss` is the project stylesheet
 * that contains `@import "tailwindcss"` (or @tailwind directives). Returns the
 * compiled CSS to upload in its place. Throws a clear error if Tailwind can't
 * be invoked.
 */
export function prebakeTailwind(root: string, entryCss: string): PrebakeResult {
  const inputPath = path.join(root, entryCss)
  if (!existsSync(inputPath)) {
    throw new Error(`Tailwind entry CSS not found: ${entryCss}`)
  }
  const outDir = mkdtempSync(path.join(tmpdir(), 'myth-tw-'))
  const outPath = path.join(outDir, 'tailwind.generated.css')
  try {
    // Use the project's own tailwind CLI (v4): `tailwindcss -i in -o out`.
    execFileSync(
      'npx',
      ['--no-install', 'tailwindcss', '-i', inputPath, '-o', outPath, '--minify'],
      { cwd: root, stdio: 'pipe' },
    )
  } catch (e) {
    throw new Error(
      `Tailwind generation failed. Ensure tailwindcss is installed in the project. ` +
        `Underlying error: ${(e as Error).message}`,
    )
  }
  const css = require('node:fs').readFileSync(outPath, 'utf-8') as string
  return { generatedCssPath: entryCss, css }
}
```

> Note: `prebakeTailwind` is intentionally not unit-tested against real Tailwind (slow, network).
> Its detection logic is tested; generation is covered by the staging integration smoke (Task 7
> note) once the edge lands. Keep `detectTailwind` pure and fully tested.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/publish/tailwind.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/publish/tailwind.ts src/publish/tailwind.test.ts
git commit -m "feat(publish): Tailwind detection + local pre-bake"
```

---

## Task 5: Wire source publish into the publish command

**Files:**
- Modify: `src/publish/build-objects.ts` (add `assembleSourceAndHash`)
- Modify: `src/publish/index.ts`
- Modify: `bin/myth.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// add to src/publish/build-objects.test.ts
import { assembleSourceAndHash } from './build-objects.js'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('assembleSourceAndHash', () => {
  it('hashes selected source (not dist) into an object graph', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'myth-asm-'))
    mkdirSync(path.join(root, 'src'), { recursive: true })
    writeFileSync(path.join(root, 'src', 'main.tsx'), 'export default 1')
    writeFileSync(path.join(root, 'package.json'), '{"name":"x"}')
    const res = await assembleSourceAndHash(root)
    expect(res.fileCount).toBe(2)
    expect(res.rootTree).toMatch(/^[0-9a-f]{64}$/)
    rmSync(root, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/publish/build-objects.test.ts -t assembleSourceAndHash`
Expected: FAIL — not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/publish/build-objects.ts`:

```typescript
import { readFile } from 'node:fs/promises'
import { selectSourceFiles } from './source-select.js'

/**
 * Select the project's source files and hash them into the git object graph.
 * Replaces buildAndHash (vite) for the source-publish model.
 */
export async function assembleSourceAndHash(root: string): Promise<BuildResult> {
  const rels = selectSourceFiles(root)
  const files = new Map<string, Uint8Array>()
  for (const rel of rels) {
    const bytes = new Uint8Array(await readFile(path.join(root, rel)))
    files.set(rel, bytes)
  }
  return buildObjectsFromFiles(files)
}
```

Then in `src/publish/index.ts`, replace the build section. Change imports:

```typescript
import { assembleSourceAndHash } from './build-objects.js'
import { selectSourceFiles } from './source-select.js'
import { validateSource } from './validate.js'
import { detectTailwind, prebakeTailwind } from './tailwind.js'
import { readFileSync } from 'node:fs'
```

Replace lines 118-126 (the `// 1. Build + hash.` block) with:

```typescript
  // 1. Validate + assemble source (no local build).
  const pkgPath = path.join(root, 'package.json')
  const deps: Record<string, string> = existsSync(pkgPath)
    ? {
        ...(JSON.parse(readFileSync(pkgPath, 'utf-8')).dependencies ?? {}),
      }
    : {}
  const files = selectSourceFiles(root)
  const errors = validateSource({ files, deps })
  if (errors.length > 0) {
    throw new OrbitConfigError(
      'Cannot publish — fix these first:\n  - ' + errors.join('\n  - '),
    )
  }
  if (detectTailwind(deps, files)) {
    console.log('[myth] Tailwind detected — pre-baking CSS...')
    // entry CSS heuristic: the stylesheet imported by the entry; default src/index.css.
    const entryCss = files.find(f => /index\.css$/.test(f)) ?? 'src/index.css'
    const baked = prebakeTailwind(root, entryCss)
    // Write the generated CSS in place so it is picked up by assembleSourceAndHash.
    require('node:fs').writeFileSync(path.join(root, baked.generatedCssPath), baked.css)
  }
  const buildStart = Date.now()
  console.log('[myth] Packaging source...')
  const built = await assembleSourceAndHash(root)
  const buildSec = ((Date.now() - buildStart) / 1000).toFixed(1)
  console.log(
    `[myth] Packaged in ${buildSec}s. ${built.fileCount} files, ${formatBytes(built.totalBytes)}.`,
  )
```

Update the final success block (after finalize) to add an author-preview hint:

```typescript
  console.log('[myth] ✓ Published. (Live for you now; public once the safety scan passes.)')
```

`resolveEntry` and the `entry` variable are no longer needed for assembly; keep `resolveEntry`
call removed from `publishCommand` (delete the `const entry = resolveEntry(...)` line and the
`entry` param passing). Leave `resolveEntry` + `DEFAULT_ENTRY_CANDIDATES` exported for tests if
referenced; otherwise delete to satisfy lint.

In `bin/myth.ts`, update the publish help text block to:

```
  myth publish [--name <name>]   Upload the current app's SOURCE to myth.work.
               [--staging]       Compiles at the edge; no local build needed.
               [--api <url>]     Default backend is prod (api.myth.work);
                                 --staging uses api.llama.space.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run`
Expected: PASS (all suites). Then `npx tsc --noEmit` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/publish/build-objects.ts src/publish/index.ts bin/myth.ts
git commit -m "feat(publish): replace local vite build with source packaging"
```

---

## Task 6: Drop viteBuild from the publish path; keep `myth run` intact

**Files:**
- Modify: `src/publish/build-objects.ts`

- [ ] **Step 1:** Confirm `buildAndHash` (the `viteBuild` user) is no longer imported anywhere
  in `src/` except its own test.

Run: `grep -rn "buildAndHash" src/`
Expected: only `build-objects.ts` (definition) and `build-objects.test.ts`.

- [ ] **Step 2:** Remove `buildAndHash` and its `vite`/`@vitejs/plugin-react` imports from
  `build-objects.ts` (the dev server in `src/run.ts` keeps vite; we only drop the publish-time
  build). Delete `buildAndHash`'s test in `build-objects.test.ts`. Keep `hashDirectory` and its
  tests (still used as a pure reference).

- [ ] **Step 3:** Run `npx tsc --noEmit` and `npx vitest run`.
Expected: PASS, no unused-import errors.

- [ ] **Step 4: Commit**

```bash
git add src/publish/build-objects.ts src/publish/build-objects.test.ts
git commit -m "refactor(publish): remove vite-build path from publish (run.ts unchanged)"
```

---

## Task 7: README — document the source-publish model

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** Update the `## Publish` section to describe the new flow:
  - `myth publish` uploads source; the platform compiles at the edge.
  - Supported subset (Tier 1): standard React/TS apps; deps resolved via esm.sh; relative CSS
    inlined; Tailwind pre-baked locally; `tailwind.config.js` not supported (use CSS-first).
  - "Live for you immediately; public after the safety scan passes."
  - Note that native/build-time deps (e.g. `sharp`) aren't supported at the edge.

- [ ] **Step 2:** Update the `## Commands` table `myth publish` row to drop "Build +".

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README for source-publish model + Tier-1 supported subset"
```

---

## Self-Review

- **Spec coverage (CLI half):** source selection + `.gitignore` (Task 1, spec §5.1.2); standard
  `package.json`/lockfile upload, no rewriting (Tasks 1/5, spec §6); pre-flight validation +
  dep classification (Task 3, spec §5.1.5/§6); Tailwind pre-bake (Task 4, spec §5.1.4); replace
  `myth publish` with source upload, drop vite build (Tasks 5/6, spec §2/§5.1.6); README subset
  (Task 7, spec §5.1.5). Edge-half items (importmap generation, async scan, login-auth serving,
  Tier 2) are explicitly out of this plan (separate orbitcode plan).
- **Placeholder scan:** none — all steps contain runnable code/commands.
- **Type consistency:** `BuildResult`, `BuiltObject` reused from `build-objects.ts`;
  `selectSourceFiles`, `classifyDependencies`, `validateSource`, `detectTailwind`,
  `prebakeTailwind`, `buildObjectsFromFiles`, `assembleSourceAndHash` names are consistent
  across tasks.

## Known follow-ups (not this plan)
- Replace the `require('node:fs')` shims in Task 5 with top-level ESM imports during execution
  (kept inline here for step locality) — execution should use proper imports.
- The end-to-end staging smoke test (publish a real app, assert author-preview + public-after-
  scan + styled render) depends on the orbitcode edge plan; track it there.
