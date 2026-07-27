import { describe, expect, it } from 'vitest'
import { servedTreeLabel } from './crockford.js'

// hexToCrockford256 now comes from @mythwork/shared/crockford32 — its tests
// live there, not vendored here alongside a duplicate implementation.

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
