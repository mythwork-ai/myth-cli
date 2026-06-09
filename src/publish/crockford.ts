/**
 * Crockford-32 content-address encoding + served-tree probe.
 *
 * `hexToCrockford256` is a byte-identical port of the canonical TS
 * implementation in the mythwork repo (`shared/crockford32.ts`, format v0:
 * 256 hash bits + a 4-bit checksum/version nibble → 52 lowercase chars).
 * myth-cli is dependency-free by design, so the ~30 lines are vendored;
 * keep them in lockstep with the canonical source.
 *
 * `servedTreeLabel` extracts the 52-char canonical tree label a zone URL is
 * CURRENTLY serving, from the outer page's content-addressed inner-iframe
 * origin (`{label52}{token3}.zone`). Comparing it against the local tree's
 * encoding is the publish no-op check: only "the target already serves this
 * exact content" skips — mere CAS membership would wrongly no-op a revert.
 */

const CROCKFORD_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

export function hexToCrockford256(hex: string): string | null {
  if (typeof hex !== 'string' || hex.length !== 64 || /[^0-9a-f]/.test(hex)) return null
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  let b = 0
  for (let i = 0; i < 32; i++) b ^= bytes[i]!
  const nibble = ((b >> 4) ^ (b & 0x0f)) & 0x0f // checksum4 + FORMAT_VERSION(0)
  const out: string[] = []
  let acc = 0
  let bits = 0
  for (let i = 0; i < 32; i++) {
    acc = (acc << 8) | bytes[i]!
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out.push(CROCKFORD_ALPHABET[(acc >>> bits) & 0x1f]!)
    }
  }
  acc = (acc << 4) | nibble
  bits += 4
  while (bits >= 5) {
    bits -= 5
    out.push(CROCKFORD_ALPHABET[(acc >>> bits) & 0x1f]!)
  }
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
