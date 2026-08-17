/**
 * Served-tree probe.
 *
 * `servedTreeLabel` extracts the 52-char canonical tree label a zone URL is
 * CURRENTLY serving, from the outer page's content-addressed inner-iframe
 * origin (`{label52}{token3}.zone`). Comparing it against the local tree's
 * encoding is the publish no-op check: only "the target already serves this
 * exact content" skips — mere CAS membership would wrongly no-op a revert.
 *
 * The Crockford-32 encoder itself used to be vendored here as a dependency-
 * free port of the canonical implementation in the mythwork repo
 * (`shared/crockford32.ts`) — see @mythwork/shared/crockford32 instead now
 * that it's a real published package.
 */

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
