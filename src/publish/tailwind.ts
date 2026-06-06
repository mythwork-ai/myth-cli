/**
 * Tailwind pre-bake for Tier-1 publish. The edge inlines static CSS but does
 * not run Tailwind's JIT, so when an app uses Tailwind we generate the utility
 * CSS locally and upload it in place of the entry stylesheet.
 *
 * `detectTailwind` is a cheap signal (dependency presence). `findTailwindEntry`
 * locates the actual entry stylesheet by scanning for the `@import "tailwindcss"`
 * (or `@tailwind`) directive — so we never bake against the wrong file.
 * `prebakeTailwind` shells out to the project's own Tailwind (version/config
 * match the user's setup) and **returns** the compiled CSS; it does not mutate
 * the user's working tree — the caller injects the result into the upload set.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export function detectTailwind(deps: Record<string, string>): boolean {
  return Object.keys(deps).some(
    d => d === 'tailwindcss' || d.startsWith('@tailwindcss/'),
  )
}

/** Matches a CSS-first Tailwind entry: `@import "tailwindcss"` or `@tailwind`. */
const TAILWIND_DIRECTIVE = /@import\s+["']tailwindcss["']|@tailwind\b/

/**
 * Find the project's Tailwind entry stylesheet — the `.css` file that actually
 * pulls in Tailwind — by scanning candidate file contents for the directive.
 * Returns its POSIX relative path, or undefined if none is found (caller should
 * then skip pre-bake rather than guess at a file to overwrite).
 */
export function findTailwindEntry(
  root: string,
  files: string[],
  read: (p: string) => string = p => readFileSync(p, 'utf-8'),
): string | undefined {
  for (const f of files) {
    if (!f.endsWith('.css')) continue
    try {
      if (TAILWIND_DIRECTIVE.test(read(path.join(root, f)))) return f
    } catch {
      // Unreadable file — skip; not a candidate.
    }
  }
  return undefined
}

export interface PrebakeResult {
  /** POSIX relative path of the stylesheet whose contents should be replaced. */
  generatedCssPath: string
  /** The compiled CSS contents (caller uploads this in place of the entry). */
  css: string
}

/** Injectable seams for testing `prebakeTailwind` without real Tailwind/IO. */
export interface PrebakeDeps {
  /** Run Tailwind: compile `inputPath` to `outPath` (cwd = project root). */
  runTailwind?: (root: string, inputPath: string, outPath: string) => void
  /** Read a generated file's contents. */
  readFile?: (p: string) => string
}

function defaultRunTailwind(root: string, inputPath: string, outPath: string): void {
  // Use the project's own Tailwind CLI (v4): `tailwindcss -i in -o out`.
  execFileSync(
    'npx',
    ['--no-install', 'tailwindcss', '-i', inputPath, '-o', outPath, '--minify'],
    { cwd: root, stdio: 'pipe' },
  )
}

/**
 * Compile the project's Tailwind CSS and return it. `entryCss` is a POSIX
 * relative path to the stylesheet that imports Tailwind. Generation runs in a
 * temp dir outside the project; the user's files are left untouched.
 *
 * Throws a clear error if the entry is missing or Tailwind can't be invoked.
 */
export function prebakeTailwind(
  root: string,
  entryCss: string,
  injected: PrebakeDeps = {},
): PrebakeResult {
  const runTailwind = injected.runTailwind ?? defaultRunTailwind
  const read = injected.readFile ?? (p => readFileSync(p, 'utf-8'))
  const inputPath = path.join(root, entryCss)
  if (!existsSync(inputPath)) {
    throw new Error(`Tailwind entry CSS not found: ${entryCss}`)
  }
  // Generate into a temp dir (outside the project) so we never leave a stray
  // file behind, and never mutate the user's source.
  const outDir = mkdtempSync(path.join(tmpdir(), 'myth-tw-'))
  const outPath = path.join(outDir, 'tailwind.generated.css')
  let css: string
  try {
    runTailwind(root, inputPath, outPath)
    css = read(outPath)
  } catch (e) {
    throw new Error(
      `Tailwind generation failed. Ensure tailwindcss is installed in the project. ` +
        `Underlying error: ${(e as Error).message}`,
    )
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
  return { generatedCssPath: entryCss, css }
}
