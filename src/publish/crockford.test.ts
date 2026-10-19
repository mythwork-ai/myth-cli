import { describe, expect, it } from 'vitest'
import { hexToCrockford256, servedTreeLabel } from './crockford.js'

describe('hexToCrockford256', () => {
  it('matches the canonical encoder (known answer from a live publish)', () => {
    expect(
      hexToCrockford256('368b1d5bc3bf92da6d535733d010bf6e95dc4af0f3d1dbb68dbd6d5ee85f6850'),
    ).toBe('6t5htpy3qy9dmvakawsx045zdtaxrjqgyf8xqdmdqnpnxt2zd18f')
  })

  it('accepts uppercase hex like lowercase', () => {
    const hex = '368b1d5bc3bf92da6d535733d010bf6e95dc4af0f3d1dbb68dbd6d5ee85f6850'
    expect(hexToCrockford256(hex.toUpperCase())).toBe(hexToCrockford256(hex))
  })

  it.each([
    ['0000000000000000000000000000000000000000000000000000000000000000', '0000000000000000000000000000000000000000000000000000'],
    ['ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzg'],
    ['0123456789abcdeffedcba98765432100f1e2d3c4b5a69788796a5b4c3d2e1f0', '04hmasw9nf6yzzpwqac7cn1j207hwb9w9dd6jy47jtjv9gyjw7r0'],
    ['deadbeefcafebabe8badf00d0ddba11fee1dead5ca1ab1e0b16b00b5c0ffee00', 'vtpvxvyaztxbx2xdy06gvpx13zq1vtpns8db3r5hdc0bbg7zxr07'],
    ['a5a5a5a55a5a5a5a3c3c3c3cc3c3c3c3966996696996699612481248f0e1d2c3', 'mpjtb9atb9d5mf1w7gyc7gy3reb6k5k9d6b6k5gj9094hw71tb1g'],
    ['A5A5A5A55A5A5A5A3C3C3C3CC3C3C3C3966996696996699612481248F0E1D2C3', 'mpjtb9atb9d5mf1w7gyc7gy3reb6k5k9d6b6k5gj9094hw71tb1g'],
    ['00112233445566778899aabbccddeeff', null],
  ])('matches the mythwork encoder for %s', (hex, expected) => {
    expect(hexToCrockford256(hex)).toBe(expected)
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
