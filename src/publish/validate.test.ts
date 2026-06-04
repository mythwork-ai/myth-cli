import { describe, it, expect } from 'vitest'
import { classifyDependencies, validateSource } from './validate.js'

describe('classifyDependencies', () => {
  it('marks react-family and @orbitcode as edge-native (no esm.sh needed)', () => {
    const r = classifyDependencies({
      react: '19.0.0',
      'react-dom': '19.0.0',
      '@orbitcode/store': '1.0.0',
    })
    expect(r.native).toEqual(
      expect.arrayContaining(['react', 'react-dom', '@orbitcode/store']),
    )
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
    expect(errs.some(e => /tailwind\.config\.js/i.test(e))).toBe(true)
  })

  it('rejects a Tailwind config with other extensions too', () => {
    expect(validateSource({ files: ['tailwind.config.ts'], deps: {} }).length).toBe(1)
    expect(validateSource({ files: ['cfg/tailwind.config.cjs'], deps: {} }).length).toBe(1)
  })

  it('reports problematic deps as errors', () => {
    const errs = validateSource({ files: ['src/main.tsx'], deps: { sharp: '0.33.0' } })
    expect(errs.some(e => /sharp/.test(e))).toBe(true)
  })

  it('passes a clean standard app', () => {
    const errs = validateSource({
      files: ['src/main.tsx', 'package.json'],
      deps: { react: '19.0.0' },
    })
    expect(errs).toEqual([])
  })
})
