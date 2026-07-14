/**
 * Host- and path-keyed reverse proxy for the `myth run` dev server.
 *
 * Production splits the platform across hostnames (api.{zone}, auth.{zone},
 * the serve worker on the zone apex). The dev server mirrors that layout on
 * `*.localhost` subdomains of ONE vite listener, so cookies set by the
 * proxied workers stay first-party (localhost and its subdomains are the
 * same site) — the property the whole auth-iframe/session design relies on.
 *
 * Vite's built-in `server.proxy` keys on path only, so this is a small
 * fetch()-based streaming proxy keyed on the classified Host instead.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

/** What a request's Host header means under the myth run host layout. */
export type HostKind = "outer" | "app" | "api" | "auth" | "unknown";

/**
 * Classify a request Host header. `localhost`/`127.0.0.1` is the outer
 * wrapper page; `app.` / `api.` / `auth.` `.localhost` subdomains mirror the
 * production host split. Port is ignored — one listener serves all of them.
 */
export function classifyHost(hostHeader: string | undefined): HostKind {
  const host = (hostHeader ?? "").split(":")[0].toLowerCase();
  if (host === "localhost" || host === "127.0.0.1") return "outer";
  if (host === "app.localhost") return "app";
  if (host === "api.localhost") return "api";
  if (host === "auth.localhost") return "auth";
  return "unknown";
}

/** Hop-by-hop headers that must not be forwarded in either direction. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

/**
 * Build the header set to send upstream: everything except hop-by-hop
 * headers (fetch sets Host from the target URL). The browser's Origin /
 * Cookie headers pass through untouched — the upstream workers' CORS layer
 * explicitly allows localhost origins, and their cookies are host-only so
 * they round-trip cleanly onto the proxied `*.localhost` host.
 */
export function upstreamHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase()) || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return headers;
}

/**
 * Forward `req` to `${upstreamOrigin}${req.url}` and stream the response
 * back. Redirects are NOT followed — the browser must see them (OAuth
 * round-trips). The response's Set-Cookie headers pass through verbatim:
 * the workers set host-only cookies (no Domain attribute), so the browser
 * scopes them to the proxied `*.localhost` host, which is exactly right.
 */
export async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamOrigin: string,
): Promise<void> {
  const url = `${upstreamOrigin}${req.url ?? "/"}`;
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method,
      headers: upstreamHeaders(req),
      body: hasBody ? (Readable.toWeb(req) as unknown as BodyInit) : undefined,
      redirect: "manual",
      // Node's fetch requires this for streaming request bodies.
      ...(hasBody ? { duplex: "half" as const } : {}),
    });
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/plain");
    res.end(`[myth] proxy to ${upstreamOrigin} failed: ${(e as Error).message}`);
    return;
  }

  res.statusCode = upstream.status;
  // getSetCookie() preserves the individual Set-Cookie lines that
  // Headers.entries() would fold into one comma-joined (and thus broken)
  // value.
  for (const cookie of upstream.headers.getSetCookie()) {
    res.appendHeader("Set-Cookie", cookie);
  }
  upstream.headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (HOP_BY_HOP.has(n) || n === "set-cookie") return;
    // fetch already decompressed the body; the original encoding headers
    // would make the browser mis-parse the re-streamed bytes.
    if (n === "content-encoding" || n === "content-length") return;
    res.setHeader(name, value);
  });

  if (upstream.body) {
    Readable.fromWeb(upstream.body as never).pipe(res);
  } else {
    res.end();
  }
}
