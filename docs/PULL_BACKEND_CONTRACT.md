# Backend contract needed for `myth pull` — spec for the `mythwork` repo

The `myth-cli` side of `myth pull <name>` is fully built and tested (see
`docs/context-graph.md` and the `src/publish/pull.ts`, `pack-download.ts`,
`read-objects.ts`, and `client.ts`'s `resolvePublishedSite` in this repo).
It cannot go live against a real backend yet because the publish worker only
knows how to **receive** a publish today — it has no way to **serve one back
out**. This document is the exact, implementation-ready spec for the two new
read endpoints that unblock it. Nothing in this repo depends on how these
are implemented server-side, only on the shapes below.

## 1. `GET /publish/site/{name}`

Natural GET sibling of the existing `DELETE /publish/site/{name}` (same
resource, opposite side effect). Resolves a published alias to the head
commit and root tree it's currently serving.

- **Auth**: `Authorization: Bearer <jwt>` required.
- **Authorization rule**: owner-gated, same as the existing DELETE — only
  the publisher of `name` may resolve it.
- **Request**: no body.
- **Response 200**:
  ```json
  {
    "name": "my-app",
    "headCommit": "<64-hex>",
    "rootTree": "<64-hex>",
    "canonical": "<52-char crockford>",
    "projectId": "optional string"
  }
  ```
  `rootTree` is the field the CLI actually uses next (passed straight into
  endpoint #2). `headCommit`/`canonical`/`projectId` are informational.
- **Errors** (mirror the existing `DELETE /publish/site/{name}` mapping):
  - `401` → session expired
  - `403` → not the publisher of `name`
  - `404` → no app named `name`
  - `5xx` → backend having issues

## 2. `GET /publish/pack/{rootTree}`

Downloads every object (tree + blob — **not** the commit) reachable from
`rootTree`, as a single OCPK pack — the exact same wire format
`POST /publish/pack` already uses for uploads (see
`src/publish/pack-codec.ts` in this repo — `encodePack`/`decodePack`,
vendored from `shared/pack/codec.ts`). Reuse that codec as-is for the
response body; do not invent a new framing.

- **Auth**: `Authorization: Bearer <jwt>` required.
- **Authorization rule**: the caller must own a ref (canonical or aliased)
  pointing at exactly this `rootTree`. In practice the CLI always calls
  endpoint #1 first (which is the ownership-proven lookup) and passes that
  `rootTree` straight through — but this endpoint must enforce ownership
  independently too, in case it's ever called directly.
- **Request**: no body. (Not needed for v1, but worth reserving: an optional
  `?have=<hash,hash,...>` query param for a future incremental/delta pull.)
- **Response 200**: `Content-Type: application/octet-stream`, body = one
  OCPK pack containing every tree and blob object reachable from
  `rootTree`. Entries are the raw zlib-deflated object framing exactly as
  stored (`<type> <len>\0<body>`, then deflated) — no extra wrapping. The
  client derives each entry's hash itself by inflating + hashing, so no
  server-side hash tagging is needed.
- **Errors**:
  - `401` → session expired
  - `403` → caller doesn't own this tree
  - `404` → tree not found (rare race: GC'd between the two calls)
  - `413` → tree exceeds the single-response pack size budget (no
    pagination in v1 — message should say this plainly so it doesn't read
    as a transient/retryable error)
  - `5xx` → backend having issues

## Why no pagination / incremental pull in v1

Deliberately out of scope for the first version — see
`docs/context-graph.md` §"What we will NOT do in this pass" from the
approved implementation plan. A full one-shot pack per pull is simple and
correct; incremental pulls are a clean, separable fast-follow once this
ships and real usage shows it's needed.

## What the CLI does with the response (already built, for context)

1. `resolvePublishedSite(name)` → `{rootTree, ...}`
2. `fetchObjectPack(rootTree)` → raw pack entries, decoded via the existing
   `decodePack`
3. `indexPackObjects(entries)` → inflates + hashes each entry into a
   `hash -> {type, body}` map
4. `materializeTree(rootTree, objects, destDir)` → validates the *entire*
   graph is present and safe (every hash resolvable, every tree-entry name
   free of path-traversal characters) **before** writing anything to disk,
   then writes the real files

Steps 3–4 live in `src/publish/read-objects.ts` in this repo and are fully
unit-tested (round-trip tests, adversarial/malformed-input tests) — nothing
there needs to change regardless of how the server implements the two
endpoints above, as long as the response shapes match this document.
