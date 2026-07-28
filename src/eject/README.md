# `src/eject` — the portable-export transform

The pure `fileMap → standalone Vite/React project` transform behind
`myth eject`. Given a published app's source, it rewrites the platform runtime
imports (`@mythwork/*` / legacy `@orbitcode/*`) to a vendored portable runtime
under `src/_portable/`, emits a clean toolchain (`package.json`, `vite.config.ts`,
`tsconfig.json`, `index.html`), and reports what degraded off-platform. The
result depends on nothing of ours — `pnpm install && pnpm dev` and it runs.

`eject()` (in `index.ts`) is pure and in-memory: `Record<string,string>` in,
`{ files, degraded, reviewDeps, residual, warnings }` out. No fs, no network,
no env. The CLI wrapper that downloads the app and writes the result to disk is
`eject-command.ts`; it also handles the two things the pure core deliberately
does not: binary files (never fed through the string-only transform) and the
app's own toolchain files (dropped so the clean emitted ones win).

## Provenance

`platform-specifiers.ts`, `rewrite-imports.ts`, `portable-runtime.ts`,
`toolchain.ts`, `index.ts`, and the two `*.test.ts` files are **ported** from
`mythwork-ai/mythwork` `shared/eject/`:

- pipeline + runtime + toolchain: `october/apollo-p6-eject-core` @ `6551446` (PR #655)
- classifier + import-rewrite: `feat/p6-code-ownership-export` @ `579ec13`

### Deviations from upstream (intentional)

1. **`.js` extensions on relative imports.** myth-cli ships raw compiled ESM and
   Node resolves `dist/` directly, so relative imports must carry `.js`
   (mythwork bundles `shared/`, so upstream is extensionless). Without this the
   binary throws `ERR_MODULE_NOT_FOUND` at runtime even though `tsc` and Vitest
   resolve it fine — so a CI check (`node dist/bin/myth.js eject` help path)
   guards against a regression.
2. **Entry candidates reconciled with `myth run`.** `index.ts`'s
   `ENTRY_CANDIDATES` is a superset of `bin/myth.ts`'s `DEFAULT_ENTRY_CANDIDATES`
   (`src/main.ts`, `src/App.tsx`, `App.tsx`) so an app that `myth run` launches
   is also one `myth eject` can find an entry for.
3. **`EJECT_NOTES.md` warning text** uses a plain `WARNING:` prefix instead of an
   emoji, matching the CLI's house style (`✓` / `⚠`, no emoji).

## Keeping in sync

These five source files are a **vendored copy**. The ported `*.test.ts` (with the
load-bearing "zero residual platform specifiers" assertion) are the drift guard.
Convergence path: once a second consumer (mythwork's server-side eject) ships,
graduate the pure files to a shared zero-dependency `@mythwork/eject-core`
package that both repos depend on, owned wherever `shared/` is owned. Until then,
re-port from the upstream SHA above when the transform changes.
