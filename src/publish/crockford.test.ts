import { describe, expect, it } from 'vitest'
import { hexToCrockford256, servedTreeLabel } from './crockford.js'

describe('hexToCrockford256', () => {
  it('matches the canonical encoder (known answer from a live publish)', () => {
    // myth-home's published tree → its canonical subdomain label, as returned
    // by the publish worker (which uses the canonical TS implementation this
    // module is a port of). If this fails, the vendored port has drifted.
    expect(
      hexToCrockford256('368b1d5bc3bf92da6d535733d010bf6e95dc4af0f3d1dbb68dbd6d5ee85f6850'),
    ).toBe('6t5htpy3qy9dmvakawsx045zdtaxrjqgyf8xqdmdqnpnxt2zd18f')
  })

  it('rejects malformed input', () => {
    expect(hexToCrockford256('abc')).toBeNull()
    expect(hexToCrockford256('Z'.repeat(64))).toBeNull()
  })
})

describe('servedTreeLabel', () => {
  it('extracts the 52-char tree label from the outer page', async () => {
    const tree52 = '6t5htpy3qy9dmvakawsx045zdtaxrjqgyf8xqdmdqnpnxt2zd18f'
    const html = `<iframe src="https://${tree52}abc.llama.space/"></iframe>`
    const fetchImpl = (async () => new Response(html)) as typeof fetch
    expect(await servedTreeLabel('https://llama.space/', fetchImpl)).toBe(tree52)
  })

  it('returns null on non-OK / non-matching / failing responses', async () => {
    const notOk = (async () => new Response('x', { status: 404 })) as typeof fetch
    expect(await servedTreeLabel('https://llama.space/', notOk)).toBeNull()
    const noMatch = (async () => new Response('<html>plain</html>')) as typeof fetch
    expect(await servedTreeLabel('https://llama.space/', noMatch)).toBeNull()
    const boom = (async () => {
      throw new Error('net down')
    }) as unknown as typeof fetch
    expect(await servedTreeLabel('https://llama.space/', boom)).toBeNull()
  })
})
