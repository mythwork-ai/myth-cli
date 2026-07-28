/**
 * Tests for the eject transform core: specifier classification (namespace-
 * agnostic across the partial @orbitcode→@mythwork rename), import rewriting to
 * the vendored @portable/* runtime, the usage report, and the portability audit.
 */
import { describe, expect, it } from 'vitest'
import { classifySpecifier, matchPlatformSubpath } from './platform-specifiers.js'
import {
  auditResidualPlatform,
  rewriteFileImports,
  rewriteImports,
  emptyReport,
} from './rewrite-imports.js'

describe('classifySpecifier', () => {
  it('classifies platform specifiers under BOTH org prefixes', () => {
    expect(classifySpecifier('@mythwork/store')).toMatchObject({
      kind: 'platform',
      subpath: 'store',
      portable: '@portable/store',
    })
    expect(classifySpecifier('@orbitcode/store')).toMatchObject({
      kind: 'platform',
      subpath: 'store',
    })
    expect(classifySpecifier('@mythwork/project/react')).toMatchObject({
      kind: 'platform',
      subpath: 'project/react',
    })
  })

  it('classifies blessed npm, react, relative, and other-npm', () => {
    expect(classifySpecifier('yjs')).toEqual({ kind: 'blessed-npm', pkg: 'yjs' })
    expect(classifySpecifier('y-protocols/awareness')).toEqual({
      kind: 'blessed-npm',
      pkg: 'y-protocols',
    })
    expect(classifySpecifier('react')).toEqual({ kind: 'react' })
    expect(classifySpecifier('react-dom/client')).toEqual({ kind: 'react' })
    expect(classifySpecifier('./Foo')).toEqual({ kind: 'relative' })
    expect(classifySpecifier('../lib/x')).toEqual({ kind: 'relative' })
    expect(classifySpecifier('lodash')).toEqual({ kind: 'other-npm', pkg: 'lodash' })
    expect(classifySpecifier('@scope/pkg')).toEqual({ kind: 'other-npm', pkg: '@scope/pkg' })
  })

  it('does not treat an unknown @mythwork subpath as platform', () => {
    // Only manifest subpaths are platform; an unlisted one is other-npm.
    expect(classifySpecifier('@mythwork/not-a-real-entry').kind).toBe('other-npm')
    expect(matchPlatformSubpath('@mythwork/store')).toBe('store')
    expect(matchPlatformSubpath('@mythwork')).toBeNull()
  })
})

describe('rewriteFileImports', () => {
  it('rewrites platform imports to @portable/* across import forms', () => {
    const report = emptyReport()
    const src = [
      "import { useVar } from '@mythwork/store'",
      "import { proxyFetch } from '@orbitcode/secrets'",
      "export { X } from '@mythwork/project/react'",
      "import '@mythwork/shim-transport'",
      "const m = await import('@mythwork/git')",
      "import Button from './Button'",
      "import * as Y from 'yjs'",
    ].join('\n')
    const out = rewriteFileImports(src, report)

    expect(out).toContain("from '@portable/store'")
    expect(out).toContain("from '@portable/secrets'")
    expect(out).toContain("from '@portable/project/react'")
    expect(out).toContain("import '@portable/shim-transport'")
    expect(out).toContain("import('@portable/git')")
    // untouched
    expect(out).toContain("from './Button'")
    expect(out).toContain("from 'yjs'")

    expect([...report.platformSubpaths].sort()).toEqual(
      ['git', 'project/react', 'secrets', 'shim-transport', 'store'].sort(),
    )
    expect(report.npmDeps.has('yjs')).toBe(true)
  })

  it('records react and other-npm deps', () => {
    const report = emptyReport()
    rewriteFileImports(
      "import React from 'react'\nimport { createRoot } from 'react-dom/client'\nimport dayjs from 'dayjs'",
      report,
    )
    expect(report.npmDeps.has('react')).toBe(true)
    expect(report.npmDeps.has('react-dom')).toBe(true)
    expect(report.npmDeps.has('dayjs')).toBe(true)
    expect(report.otherNpm.has('dayjs')).toBe(true)
  })

  it('is idempotent (re-running does not re-rewrite @portable/*)', () => {
    const report = emptyReport()
    const once = rewriteFileImports("import { useVar } from '@mythwork/store'", report)
    const twice = rewriteFileImports(once, emptyReport())
    expect(twice).toBe(once)
  })
})

describe('auditResidualPlatform', () => {
  it('flags any residual platform specifier and is clean after rewrite', () => {
    expect(auditResidualPlatform("import x from '@mythwork/store'")).toEqual(['@mythwork/store'])
    expect(auditResidualPlatform("import x from '@orbitcode/collab'")).toEqual([
      '@orbitcode/collab',
    ])
    const clean = rewriteFileImports("import { useVar } from '@mythwork/store'", emptyReport())
    expect(auditResidualPlatform(clean)).toEqual([])
  })
})

describe('rewriteImports (file map)', () => {
  it('transforms only code files, leaves others, and reports clean residual', () => {
    const result = rewriteImports({
      '/App.tsx':
        "import { useVar } from '@mythwork/store'\nexport default function App() { return null }",
      '/styles.css': '.x { color: red } /* @mythwork/store is just text here */',
      '/data.json': '{"note":"@mythwork/store"}',
    })
    expect(result.files['/App.tsx']).toContain('@portable/store')
    // non-code files are untouched (the CSS/JSON mention is not an import)
    expect(result.files['/styles.css']).toContain('@mythwork/store')
    expect(result.residual).toEqual({}) // no residual platform IMPORTS in code
    expect(result.report.platformSubpaths.has('store')).toBe(true)
  })
})
