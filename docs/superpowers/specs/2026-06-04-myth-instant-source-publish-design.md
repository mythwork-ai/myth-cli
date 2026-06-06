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
  **Migration:** we drop the local `vite build` + `dist/` walk entirely and instead assemble the
  app's **source** tree (per §5.1) and hash *that* into the same git objects — repointing the
  existing object-graph machinery (`hashDirectory`) at source instead of build output. The
  client/upload/finalize half is unchanged; compilation simply moves from the CLI (build time)
  to the edge (serve time). This is the core simplification: the CLI stops being a builder and
  becomes a source packager.
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
| When | every app, immediately | apps over a traffic threshold (start ~40 distinct hits/day) |
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
   not needed at the edge — **and additionally exclude anything matched by the project's
   `.gitignore`** (respect the user's own ignore rules; heuristics are a floor, not a
   replacement). This keeps secrets/build output/local artifacts the user already ignores from
   ever being uploaded.
3. **Resolve dependencies** straight from the **standard `package.json` + lockfile** — no
   bespoke manifest format. Exact versions come from the lockfile (source of truth). The
   uploaded tree carries `package.json` (+ lockfile) as-is and the edge derives the importmap
   from them. (Rationale + mechanism in §6.)
4. **Pre-bake Tailwind** if present: run Tailwind locally → emit a plain `.css` file, rewrite
   the import to it. (The edge inlines plain CSS but does not run Tailwind's JIT.) This is the
   **v1 approach** and it ships as-is. **Known long-run gap:** source edited *server-side*
   (agent/in-browser, no CLI step) won't get this pre-bake — see §7.4 for the server-side
   Tailwind plan.
5. **Pre-flight validation** — fail *before upload* with precise, actionable messages for:
   unresolvable entry, dependencies esm.sh cannot serve, anything the edge would `422` on.
   Document the supported subset in the README.
6. **Hash source → git objects → check/upload/finalize** — reuse the existing object-graph
   machinery (`build-objects.ts` `hashDirectory` retained; the `viteBuild` call removed) and
   the existing `client.ts` upload + `finalizePublish`. Print the alias URL + an author
   preview hint.

### 5.2 Edge responsibilities (`orbitcode`)

1. **`package.json`-driven importmap (Tier 1).** The compiler reads the uploaded
   **`package.json` + lockfile** and **generates esm.sh importmap entries** for declared deps at
   pinned versions, instead of rejecting non-blessed bare specifiers. React-family /
   `@orbitcode/*` / blessed handling is unchanged; user-module concatenation and CSS inlining
   are unchanged.
2. **Async scan.** On publish, write a `pending` scan record. The serve worker's access rules:
   - `pending` → serve **only to the authenticated publishing user** (author preview); others get a "review in progress" response (not 404, to avoid implying failure).
   - `pass` → serve publicly (current behavior).
   - `fail` → `451` (current behavior).
3. **Author identity for pre-scan serving — must be the mythwork login credential.** During the
   `pending` window the serve worker authenticates the viewer against their **mythwork login
   session** and serves only if that identity matches the publisher. **No bearer/preview
   token.** Rationale (hard requirement): a transferable preview token can be appended to a URL
   and handed to a victim, forcing the platform to serve *unscanned* content to an unsuspecting
   user — a potent phishing vector (an unscanned app at a trusted `*.myth.work` origin). Tying
   pre-scan visibility to the author's own authenticated login makes the token non-transferable:
   a victim following the link is not logged in as the author, so they get the "review in
   progress" response, never the unscanned app. Requirement: **only the authenticated publishing
   user can view `pending` content; no token, cookie, or URL parameter may substitute.**

---

## 6. Dependency resolution detail (Tier 1)

- **Standard files, no bespoke manifest.** We use the app's **`package.json` + lockfile**
  verbatim — we do *not* invent a `myth.deps.json`. Standards mean existing tooling keeps
  working and existing codebases push up **unchanged** (no myth-specific file to add). The
  lockfile already gives us exact, deterministic versions, so a normalized manifest would buy
  nothing over the standard files.
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
  threshold enqueues a bundle job; once the artifact exists, the serve worker prefers it over
  the Tier-1 output. **Start the threshold low — ~40 hits in the trailing day** — because the
  per-build cost is small at low scale, so promoting early is cheap and improves more apps
  sooner. Over time, harden the counter against gaming: count **distinct IPs** (not raw hits),
  and weight toward **confirmed non-cloud / non-botnet** IPs (exclude datacenter/VPN ranges and
  known bot networks) so an attacker can't cheaply inflate an app into the expensive tier.

### 7.2 Forward-compatibility constraints on Tier 1
- Serve worker **selects tier per tree**; **cache keys include the tier** (and compiler version).
- The publish/serve contract carries source + manifest in a way both tiers consume (Tier 2
  needs the same `package.json`/lockfile Tier 1 uses).
- Nothing in Tier 1 assumes "deps are always runtime importmap" beyond the Tier-1 code path.

### 7.4 Server-side Tailwind (long-run — CLI pre-bake is v1)
We advise apps not to use Tailwind, but expect it anyway (users/agents adding it, especially to
source edited server-side with no CLI pre-bake step). Research bottom line on baking Tailwind
server-side **before the transform**:
- **Tier 2 (container): trivial.** Native Tailwind v4 runs in a Node container; a small-app
  build is ~100ms (incremental ~5ms). No real obstacle.
- **Tier 1 (Worker): feasible, with one spike.** Tailwind v4's **CSS-generation engine is pure
  TypeScript** (`compile(css).build(candidates)`), ~273 KB of JS, **no Oxide/WASM and no DOM** —
  well under the 10 MB Worker limit. We already tokenize the source during the TSX→JS pass, so
  we can extract class **candidates** ourselves and feed `build()` directly (the model the
  official `@tailwindcss/browser` build uses). **Decision: skip Lightning CSS for Tier 1** —
  ship the raw `build()` output (zero WASM, simplest Worker fit). Lightning CSS only does final
  prefixing/optimization; if output quality turns out to be insufficient, revisit by adding it
  as a **pre-compiled Worker WASM binding** (Workers forbid runtime WASM compilation). Do
  **not** plan around `@tailwindcss/oxide-wasm32-wasi` (needs WASI+threads, not available in
  Workers).
- **Security — no user-code execution.** Tailwind treats source as **plain text** for class
  detection; generation runs none of the user's JS. The only exec vectors are legacy
  `tailwind.config.js` / JS plugins — **reject those; require CSS-first config** (`@import
  "tailwindcss"`, `@theme`, `@source`). Caveat to document: dynamically-built class names
  (`` `bg-${c}-600` ``) won't be detected without static strings or `@source inline(...)`.
- **Caveat:** the programmatic `compile()`/`build()` API is currently internal/undocumented —
  pin the Tailwind version and re-verify on upgrade.

### 7.5 Other future slices
- Lifecycle commands (`ls` / `open` / `delete`, persistent login).
- Sessions (new/pause/resume/fork/delete) — gated on a state backend.

---

## 8. Testing

- **vitest units (CLI):** dependency classification, lockfile version pinning, source-file
  selection (heuristic **and** `.gitignore` exclude rules), Tailwind pre-bake, pre-flight
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
2. **Mythwork-login enforcement at the serve edge:** confirm the serve worker can authenticate
   the viewer's mythwork login session (not just the host-frame token) so pre-scan serving can
   be gated on author identity (§5.2.3). If it can't today, that capability is part of this slice.
3. **esm.sh bundling params** (`?bundle`, `?deps`, standalone builds) — can they cut the Tier-1
   runtime request count without changing the model? Worth a small evaluation during the plan.
4. **Traffic-counter data the serve worker must emit now** (distinct IPs, IP classification
   inputs) so the Tier 2 promotion signal is available when Tier 2 lands.

*Resolved (no longer open):* dependency manifest = standard `package.json` + lockfile (§6);
author-identity mechanism = mythwork login credential only, no preview token (§5.2.3).

---

## 10. Decisions captured

- Compilation model: **upload source, compile at edge, cache compiled output** (matches the
  serve worker's existing design). Skip "compiler modernization" as a separate effort.
- Dependency approach: **`package.json`-driven importmap, no source rewriting** (Tier 1), using
  **standard `package.json` + lockfile** (no bespoke manifest — standards keep existing tooling
  and codebases working unchanged).
- Source selection: heuristic excludes **plus the project's `.gitignore`**.
- `myth publish`: **replaced** by source-upload (no dual mode).
- CSS: **supported** (relative inline + CLI Tailwind pre-bake) — the stale "No CSS" header in
  `react-target.ts` is corrected. Server-side Tailwind is a documented long-run track (§7.4),
  not a v1 blocker.
- Tiering: **Tier 1 default for all apps; Tier 2 container bundle promoted by traffic** (start
  ~40 distinct hits/day; harden against gaming with distinct/non-cloud IP counting).
- Scan: **async**, with **author-only preview** until pass — yielding `put commit → transform → live`.
- Pre-scan auth: **mythwork login credential only — no transferable preview token** (prevents
  forcing unscanned content onto victims; anti-phishing).
- Tier 2 engine: **native esbuild in a Cloudflare Container** (WASM bundling is not viable in a
  Worker isolate per research; transformers can't produce a single no-CDN file).
