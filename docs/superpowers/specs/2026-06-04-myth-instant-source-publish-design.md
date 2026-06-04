# Design: Instant Source Publish for the myth CLI

**Date:** 2026-06-04
**Status:** Approved design (pre-implementation-plan)
**Repos touched:** `myth-cli` (this repo), `orbitcode` (serve worker + compile package + publish worker)

---

## 1. Summary

Let a developer take a **standard local React app** and `myth publish` it so that:

1. The CLI uploads the app's **source** (not a local `vite build` artifact).
2. The platform compiles + serves it **at the edge**, with compiled output living in
   Cloudflare cache and regenerated on miss (durable storage holds *source*, not build output).
3. Publish feels **instant** — the critical path is `put commit → transform → live`.

This is the first slice of a larger vision (hosting + alias + storage + platform APIs +
dashboard + discoverability + sessions). It is deliberately scoped to **making a standard
React app go live instantly via source upload**. Everything else is a later spec.

---

## 2. Background / current state

- `myth publish` today runs `vite build` locally and uploads the compiled `dist/` as
  git-format objects (blobs/trees/commit, SHA-256 content-addressed) to the publish worker
  (`api.myth.work`). See `src/publish/build-objects.ts:86` (`buildAndHash` → `viteBuild`).
- The **serve worker already compiles source at the edge**: `orbitcode/workers/serve/src/inner.ts:139`
  (`serveInner`) does cache-lookup (CF cache, keyed by tree hash) → on miss walks the tree to
  `Map<path, source>` → `compile({ files, target: 'react' })` (Sucrase) → caches compiled HTML.
  This is exactly the "store source, compile at edge, cache compiled output" model we want.
- The edge compiler is **strict on dependencies**: `orbitcode/packages/compile/src/react-target.ts`
  resolves React-family, `@orbitcode/*`, a curated "blessed" importmap, and **literal
  `https://esm.sh/...` URLs in source** — and rejects any other bare specifier
  (`react-target.ts:169`, `unresolved-import`). There is no `package.json`-driven resolution today.
- CSS **is** supported (the header docstring saying "No CSS" is stale): relative CSS imports
  are collected during the walk and inlined as a `<style>` block (`react-target.ts:139, 481,
  610, 800`), with a reset stylesheet and a `<div id="root">`.
- The serve path has a **synchronous scan gate**: `inner.ts:189` reads `TREE_SCANS` KV;
  missing → 404, not-passed → 451. Today this must pass before anything is served.

**Mismatch being corrected:** the CLI uploads *built* `dist/`, but the serve worker is built
to compile *source*. This slice aligns the CLI to the serve worker's source model.

---

## 3. Goals & non-goals

### Goals (this slice)
- `myth publish` uploads **source** of a standard React/Vite app + a dependency manifest.
- The edge compiler resolves **`package.json` dependencies** (Tier 1) so a standard app's
  npm imports work without the user rewriting their source.
- Publish is **instant**: no local build, no synchronous scan, no bundling on the critical path.
- The author can **preview immediately** (pre-scan); the public sees it once the async scan passes.
- CSS works (relative imports inlined; Tailwind pre-baked by the CLI).

### Non-goals (explicitly later, separate specs)
- **Tier 2 container bundling** and traffic-based promotion (documented as north star in §7).
- **Lifecycle commands** (`ls` / `open` / `delete` / persistent login).
- **Sessions** (new/pause/resume/fork/delete) — gated on a state backend that doesn't exist.
- **Arbitrary-npm guarantees.** Tier 1 is bounded by what esm.sh can serve; we validate and
  give clear errors, we do not promise every package works.

---

## 4. Architecture: tiered compilation (the cost model)

Two **permanent** tiers. An app is born on Tier 1 and only moves to Tier 2 if traffic justifies it.

| | **Tier 1 — transform + importmap (default)** | **Tier 2 — container bundle (promoted)** |
|---|---|---|
| Engine | WASM transformer in the serve/compile worker | Native esbuild in a Cloudflare Container |
| Deps | esm.sh importmap generated from `package.json` | bundled into the artifact (no runtime CDN) |
| Output | user modules concatenated to one file; deps loaded at runtime | one/few self-contained files |
| When | every app, immediately | apps over a traffic threshold (e.g. >1000 hits/day) |
| Cost | ~free (worker CPU) | container build, amortized over high traffic |

**Why this is the right cost model:** the long tail of low-traffic apps never pays for
bundling; only apps with real traffic get the expensive, higher-quality Tier 2 build, where
the per-build cost is amortized across many requests. Tier 2 builds are also infrequent
(per promotion / per republish), and the artifact is cached durably — so containers run rarely.

**This slice implements Tier 1 only.** Tier 1's design must stay forward-compatible with Tier 2
(see §7): the serve worker selects a tier per tree, cache keys include the tier, and the
publish/serve contract does not bake in Tier-1-only assumptions.

---

## 5. Instant-publish flow (critical path)

```
CLI: detect → select source → resolve deps → (pre-bake Tailwind) → validate → upload objects → finalize
Edge (first hit): cache miss → transform (Tier 1) → serve to AUTHOR immediately
Async: scan runs → on pass, public serving opens; on fail, 451
```

Critical path to "you're live": **`put commit → transform → live`** (to the author).
No local build, no synchronous scan, no bundle.

### 5.1 CLI responsibilities (`myth-cli`)

`myth publish` is **replaced** (per decision: no dual mode). New pipeline:

1. **Detect & validate** a standard React app: `package.json` present; a resolvable entry
   against the compiler's fallbacks (`main.tsx` / `index.tsx` / `App.tsx` / `src/*`).
2. **Select source files** to upload: `src/**`, entry, project CSS, `public/` assets,
   `package.json` (+ lockfile). **Exclude** `node_modules`, `dist`, `.git`, and build configs
   not needed at the edge.
3. **Resolve dependencies** into a normalized manifest: read `package.json` + lockfile, pin
   **exact installed versions** (lockfile is the source of truth), emit a manifest the edge
   uses to build the importmap deterministically. (Mechanism detail in §6.)
4. **Pre-bake Tailwind** if present: run Tailwind locally → emit a plain `.css` file, rewrite
   the import to it. (The edge inlines plain CSS but cannot run Tailwind's JIT.)
5. **Pre-flight validation** — fail *before upload* with precise, actionable messages for:
   unresolvable entry, dependencies esm.sh cannot serve, anything the edge would `422` on.
   Document the supported subset in the README.
6. **Hash source → git objects → check/upload/finalize** — reuse the existing object-graph
   machinery (`build-objects.ts` `hashDirectory` retained; the `viteBuild` call removed) and
   the existing `client.ts` upload + `finalizePublish`. Print the alias URL + an author
   preview hint.

### 5.2 Edge responsibilities (`orbitcode`)

1. **`package.json`-driven importmap (Tier 1).** The compiler reads the uploaded dependency
   manifest (or `package.json` + lockfile) and **generates esm.sh importmap entries** for
   declared deps at pinned versions, instead of rejecting non-blessed bare specifiers. React-
   family / `@orbitcode/*` / blessed handling is unchanged; user-module concatenation and CSS
   inlining are unchanged.
2. **Async scan.** On publish, write a `pending` scan record. The serve worker's access rules:
   - `pending` → serve **only to the authenticated publishing user** (author preview); others get a "review in progress" response (not 404, to avoid implying failure).
   - `pass` → serve publicly (current behavior).
   - `fail` → `451` (current behavior).
3. **Author identity for pre-scan serving.** The serve worker must distinguish the author from
   the public during the `pending` window. Mechanism options (decide in plan): a signed
   **preview token** returned to the CLI at publish and presented by the author's browser, or
   gating the public **alias** while allowing the **canonical** URL with an author-scoped token.
   Requirement: no unauthenticated user can view `pending` content.

---

## 6. Dependency resolution detail (Tier 1)

- The importmap maps **top-level bare specifiers** to pinned esm.sh URLs
  (`https://esm.sh/<pkg>@<exact-version><subpath>`). esm.sh resolves each package's **own
  sub-dependencies** internally (its returned modules import back into esm.sh with `?deps`
  pinning), so we only enumerate the app's direct deps.
- **No source rewriting.** The user's import statements are untouched; resolution is entirely
  via the generated importmap (this was an explicit requirement — we are not mutating source).
- **Versioning:** exact versions come from the lockfile so the importmap is deterministic and
  reproducible. Ranges in `package.json` are pinned to the installed version.
- **Known bound:** packages that don't work over esm.sh (native bindings, build-time codegen,
  certain CSS-side-effect packages) are detected in pre-flight (§5.1.5) and rejected with a
  clear message rather than failing later with a `422`. This is the documented Tier-1 limit;
  Tier 2 (real bundling) removes it.
- **Runtime cost acknowledged:** Tier 1 means the browser loads deps from esm.sh at runtime
  (a request waterfall + a third-party runtime dependency + a looser CSP). This is the
  accepted Tier-1 tradeoff; it is the *reason* Tier 2 exists for high-traffic apps.

---

## 7. North star (later specs — keep Tier 1 forward-compatible)

### 7.1 Tier 2 — container bundling (traffic-promoted)
- Serve worker, on cache miss for a **promoted** tree, calls a **Cloudflare Container** running
  **native esbuild** that resolves `package.json` and bundles user code + deps into one/few
  **self-contained** files (no runtime CDN, tree-shaken, minified, tight CSP). Output cached
  durably (keyed by source-tree hash + tier), so containers run ~once per publish/promotion.
- **Isolation:** esbuild core does not execute user code, but `npm install` runs postinstall
  scripts — the **container is the sandbox**: `--ignore-scripts` where possible, egress
  allowlisted to the registry, ephemeral FS.
- **node_modules caching** (research-backed): per-project **Durable Object routing**
  (`getByName(projectId)`) pins a project to a warm instance reusing its (ephemeral) disk; for
  cold starts, **snapshot node_modules to R2 and rehydrate** (Cloudflare's documented pattern;
  native "snapshots" are forthcoming). No EFS-style shared volume exists; R2-via-FUSE is the
  closest durable shared store.
- **Promotion trigger:** per-tree/alias traffic counter (from serve analytics) crossing a
  threshold (e.g. >1000 hits/day) enqueues a bundle job; once the artifact exists, the serve
  worker prefers it over the Tier-1 output.

### 7.2 Forward-compatibility constraints on Tier 1
- Serve worker **selects tier per tree**; **cache keys include the tier** (and compiler version).
- The publish/serve contract carries source + manifest in a way both tiers consume (Tier 2
  needs the same `package.json`/lockfile Tier 1 uses).
- Nothing in Tier 1 assumes "deps are always runtime importmap" beyond the Tier-1 code path.

### 7.3 Other future slices
- Lifecycle commands (`ls` / `open` / `delete`, persistent login).
- Sessions (new/pause/resume/fork/delete) — gated on a state backend.

---

## 8. Testing

- **vitest units (CLI):** dependency classification, lockfile version pinning, manifest
  emission, source-file selection (include/exclude rules), Tailwind pre-bake, pre-flight
  validation errors.
- **Edge units:** `package.json` → importmap generation (pinned versions, subpaths,
  blessed/react passthrough); scan-state access rules (pending→author-only, pass→public,
  fail→451).
- **Integration smoke:** publish a sample standard React app (an npm dep + relative CSS +
  Tailwind) to **staging**; assert (a) author can preview while `pending`, (b) public is
  withheld while `pending`, (c) after scan pass the app serves styled with deps resolved.

---

## 9. Open questions / verify-first

1. **How are current `dist/` publishes actually served** vs. the source-compile path? Confirm
   before cutting `myth publish` over to source upload, so nothing depends on the old shape.
2. **Author-identity mechanism** for pre-scan serving (preview token vs. canonical-with-token).
3. **Manifest format**: reuse `package.json` + lockfile as-is at the edge, or emit a normalized
   `myth.deps.json`? (Leaning normalized for deterministic edge behavior.)
4. **esm.sh bundling params** (`?bundle`, `?deps`, standalone builds) — can they cut the Tier-1
   runtime request count without changing the model? Worth a small evaluation during the plan.
5. **Traffic counter location/threshold** for Tier 2 promotion (later spec, but note the data
   the serve worker must emit now so it's available when Tier 2 lands).

---

## 10. Decisions captured

- Compilation model: **upload source, compile at edge, cache compiled output** (matches the
  serve worker's existing design). Skip "compiler modernization" as a separate effort.
- Dependency approach: **`package.json`-driven importmap, no source rewriting** (Tier 1).
- `myth publish`: **replaced** by source-upload (no dual mode).
- CSS: **supported** (relative inline + CLI Tailwind pre-bake) — not unsupported, not blocking.
- Tiering: **Tier 1 default for all apps; Tier 2 container bundle promoted by traffic.**
- Scan: **async**, with **author-only preview** until pass — yielding `put commit → transform → live`.
- Tier 2 engine: **native esbuild in a Cloudflare Container** (WASM bundling is not viable in a
  Worker isolate per research; transformers can't produce a single no-CDN file).
