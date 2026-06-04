/**
 * Tailwind pre-bake for Tier-1 publish. The edge inlines static CSS but does
 * not run Tailwind's JIT, so when an app uses Tailwind we generate the utility
 * CSS locally and upload it as a plain stylesheet.
 *
 * `detectTailwind` is a cheap signal (dependency presence). Actual generation
 * is performed by `prebakeTailwind`, which shells out to the project's own
 * Tailwind so the version/config match the user's setup.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export function detectTailwind(deps: Record<string, string>): boolean {
  return Object.keys(deps).some(
    d => d === 'tailwindcss' || d.startsWith('@tailwindcss/'),
  )
}

export interface PrebakeResult {
  /** Relative path (POSIX) of the stylesheet whose contents were replaced. */
  generatedCssPath: string
  /** The compiled CSS contents. */
  css: string
}

/**
 * Generate Tailwind CSS for the project and overwrite the entry stylesheet
 * in place with the compiled output, so the source packager picks up static
 * CSS the edge can inline. `entryCss` is a POSIX relative path to the
 * stylesheet that contains `@import "tailwindcss"` (or @tailwind directives).
 *
 * Throws a clear error if the entry is missing or Tailwind can't be invoked.
 */
export function prebakeTailwind(root: string, entryCss: string): PrebakeResult {
  const inputPath = path.join(root, entryCss)
  if (!existsSync(inputPath)) {
    throw new Error(`Tailwind entry CSS not found: ${entryCss}`)
  }
  // Generate into a temp dir (outside the project) so we never leave a stray
  // file that would itself be uploaded.
  const outDir = mkdtempSync(path.join(tmpdir(), 'myth-tw-'))
  const outPath = path.join(outDir, 'tailwind.generated.css')
  let css: string
  try {
    // Use the project's own Tailwind CLI (v4): `tailwindcss -i in -o out`.
    execFileSync(
      'npx',
      ['--no-install', 'tailwindcss', '-i', inputPath, '-o', outPath, '--minify'],
      { cwd: root, stdio: 'pipe' },
    )
    css = readFileSync(outPath, 'utf-8')
  } catch (e) {
    throw new Error(
      `Tailwind generation failed. Ensure tailwindcss is installed in the project. ` +
        `Underlying error: ${(e as Error).message}`,
    )
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
  // Replace the entry stylesheet contents with the compiled CSS so the upload
  // set contains static, edge-inlinable CSS (no @import "tailwindcss").
  writeFileSync(inputPath, css)
  return { generatedCssPath: entryCss, css }
}
