import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { classifyHost, rewriteFrameAncestorsForDev, upstreamHeaders } from "./dev-proxy.js";

describe("classifyHost", () => {
  it("maps localhost and 127.0.0.1 (any port) to the outer wrapper", () => {
    expect(classifyHost("localhost:5173")).toBe("outer");
    expect(classifyHost("localhost")).toBe("outer");
    expect(classifyHost("127.0.0.1:5173")).toBe("outer");
    expect(classifyHost("LOCALHOST:5173")).toBe("outer");
  });

  it("maps the *.localhost subdomains to their roles", () => {
    expect(classifyHost("app.localhost:5173")).toBe("app");
    expect(classifyHost("api.localhost:5173")).toBe("api");
    expect(classifyHost("auth.localhost:5173")).toBe("auth");
  });

  it("classifies anything else as unknown", () => {
    expect(classifyHost("evil.example.com")).toBe("unknown");
    expect(classifyHost("foo.localhost:5173")).toBe("unknown");
    expect(classifyHost(undefined)).toBe("unknown");
  });
});

describe("upstreamHeaders", () => {
  const req = (headers: IncomingMessage["headers"]) => ({ headers }) as IncomingMessage;

  it("drops hop-by-hop headers and Host, keeps the rest", () => {
    const h = upstreamHeaders(
      req({
        host: "api.localhost:5173",
        connection: "keep-alive",
        "transfer-encoding": "chunked",
        origin: "http://localhost:5173",
        cookie: "dt=abc",
        authorization: "Bearer t",
      }),
    );
    expect(h.get("host")).toBeNull();
    expect(h.get("connection")).toBeNull();
    expect(h.get("transfer-encoding")).toBeNull();
    // Origin/Cookie pass through: upstream CORS allows localhost origins,
    // and host-only cookies round-trip onto the proxied host.
    expect(h.get("origin")).toBe("http://localhost:5173");
    expect(h.get("cookie")).toBe("dt=abc");
    expect(h.get("authorization")).toBe("Bearer t");
  });

  it("expands multi-value headers", () => {
    const h = upstreamHeaders(req({ accept: ["a", "b"] as never }));
    expect(h.get("accept")).toBe("a, b");
  });
});

describe("rewriteFrameAncestorsForDev", () => {
  it("replaces frame-ancestors sources with local dev origins, keeps other directives", () => {
    const out = rewriteFrameAncestorsForDev(
      "default-src 'self'; frame-ancestors 'self' https://*.llama.space https://llama.space; img-src *",
    );
    expect(out).toContain("default-src 'self'");
    expect(out).toContain("img-src *");
    expect(out).toContain("frame-ancestors 'self' http://localhost:* http://127.0.0.1:*");
    expect(out).not.toContain("llama.space");
  });

  it("leaves a CSP without frame-ancestors untouched", () => {
    const csp = "default-src 'self'; script-src 'self'";
    expect(rewriteFrameAncestorsForDev(csp)).toBe(csp);
  });
});
