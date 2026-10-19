/**
 * Served-tree probe.
 *
 * `servedTreeLabel` extracts the 52-char canonical tree label a zone URL is
 * CURRENTLY serving, from the outer page's content-addressed inner-iframe
 * origin (`{label52}{token3}.zone`). Comparing it against the local tree's
 * encoding is the publish no-op check: only "the target already serves this
 * exact content" skips — mere CAS membership would wrongly no-op a revert.
 */

const CROCKFORD_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
const FORMAT_VERSION = 0
const CHECK_NIBBLE_BITS = 4

function checksum4(bytes: Uint8Array): number {
  let b = 0
  for (let i = 0; i < bytes.length; i++) b ^= bytes[i]!
  return ((b >> 4) ^ (b & 0x0f)) & 0x0f
}

export function hexToCrockford256(hex: string): string | null {
  if (typeof hex !== 'string' || hex.length !== 64 || /[^0-9a-fA-F]/.test(hex)) return null
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  const checkNibble = (checksum4(bytes) + FORMAT_VERSION) & 0x0f
  const out: string[] = []
  let acc = 0
  let bits = 0
  const flush = () => {
    while (bits >= 5) {
      bits -= 5
      out.push(CROCKFORD_ALPHABET[(acc >>> bits) & 0x1f]!)
    }
    acc &= (1 << bits) - 1
  }
  for (let i = 0; i < 32; i++) {
    acc = (acc << 8) | bytes[i]!
    bits += 8
    flush()
  }
  acc = (acc << CHECK_NIBBLE_BITS) | checkNibble
  bits += CHECK_NIBBLE_BITS
  flush()
  return out.join('')
}

/**
 * The 52-char canonical tree label `url` currently serves, or null when it
 * doesn't serve a published app (404, network error, unexpected HTML).
 */
export async function servedTreeLabel(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(url)
    if (!res.ok) return null
    const m = (await res.text()).match(/https:\/\/([a-z0-9]{55})\./)
    return m ? m[1]!.slice(0, 52) : null
  } catch {
    return null
  }
}
