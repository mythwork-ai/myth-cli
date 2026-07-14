# myth-cli

Run and publish [mythwork](https://myth.work) apps locally with your own IDE.

## Install

```bash
git clone https://github.com/mythwork-ai/myth-cli.git
cd myth-cli && npm install && npm link
```

`npm link` symlinks this checkout's `myth` binary onto your global `$PATH`, so
`myth` anywhere now runs your local `dist/bin/myth.js` (rebuilt via the
`prepare` script). Re-run `npm link` after pulling or making local changes to
pick up a rebuild. Other mythwork repos that shell out to `myth run` directly
(e.g. myth-agent's eval harness) require this link step first — if a caller
can't find `myth` on `$PATH`, run `npm link` here.

## Example

```bash
myth clone mythwork-logo
cd mythwork-logo
myth run
```

Opens http://localhost:5173 with HMR — wrapped in the **same host frame a
deployed app gets**. `myth run` simulates deployment: the outer page on
`localhost` boots the target stage's real host-frame bundle (fetched from its
serve worker, so there's no version skew), your app loads inside the iframe
from `app.localhost` (a genuinely distinct origin, like the `{tree}{token}`
inner origin in production), and every platform call travels over the same
`oc-ping`/`oc-init` MessagePort handshake `@mythwork/sdk`'s `connect()` runs
in production. `api.localhost` / `auth.localhost` proxy to the stage's api and
auth hosts so cookies stay first-party (`*.localhost` is same-site with
`localhost` and resolves to loopback per RFC 6761 — no `/etc/hosts` edits).

Pick the backend stack with `--stage`:

```bash
myth run                  # myth.work (prod — matches `myth publish`'s default)
myth run --stage staging  # llama.space
myth run --stage local    # the mythwork repo's `make dev` stack (:8801/:8802/:1234)
```

Apps that ship their own `index.html` (all modern mythwork apps) are served
as-is inside the frame. Legacy single-component apps (no `index.html`,
default-exported `App`) still work: `myth run` looks for `src/main.tsx`, then
`src/main.ts`, then `src/App.tsx`, then `App.tsx`. Use `--entry` to point at a
different file:

```bash
myth run --entry MyApp.tsx
```

## Publish

Once your app runs locally, share it with a real URL:

```bash
myth publish --name my-app
```

This:

1. Packages your app's **source** (no local build — see below).
2. Opens your browser to sign in (one-time per publish — Google OAuth via `auth.myth.work`).
3. Uploads the source as git-format objects to the publish worker.
4. Prints the canonical URL (content-addressed) and your `my-app.myth.work` alias.

Your app is **live for you immediately**, and becomes **public once an automated safety scan passes**. The platform compiles your source **at the edge** on first view and caches the result — there's no local `vite build` step anymore (the CLI is a source packager, not a builder).

### What gets uploaded

`myth publish` uploads your source tree, honoring your `.gitignore` files (root **and** nested). It always **excludes** `node_modules` and `.git` (anywhere), root-level build output (`dist`, `.next`, build caches), and anything your `.gitignore` lists. As a safety net, common secret files (`.env`, `.env.*`, `*.pem`, `*.key`, private SSH keys, …) are **always** excluded even if you have no `.gitignore` — so secrets and local artifacts never leave your machine. (`.env.example` / `.sample` / `.template` are kept.) Symlinks are skipped. Your `package.json` + lockfile are uploaded so the platform can resolve your dependencies.

### Supported subset (current)

- **Standard React + TypeScript** apps (entry auto-detected: `main.tsx` / `index.tsx` / `App.tsx` / `src/*`).
- **Dependencies** are resolved via [esm.sh](https://esm.sh) at the edge. Most pure-JS npm packages work; **native / build-time packages don't** (e.g. `sharp`, `fsevents`, `canvas`) — `myth publish` will tell you up front if one is unsupported.
- **CSS**: relative CSS imports (`import './index.css'`) are inlined automatically.
- **Tailwind**: compiled **server-side** by the platform at serve time — the CLI uploads your source untouched. Use **CSS-first config** (`@import "tailwindcss"` + `@theme`); a `tailwind.config.js` is not supported (publish will ask you to migrate it).

By default this publishes to **prod** (`api.myth.work`). Pass `--staging` to publish to `api.llama.space` instead (useful for testing the publish flow without touching prod):

```bash
myth publish --name my-app --staging
```

To take a published app down again:

```bash
myth unpublish --name my-app
```

## Pull

Bring a published app's source back down to your own machine, as real files
in a new local directory — the reverse of `myth publish`:

```bash
myth pull my-app
cd my-app
myth run
```

`myth pull` reconstructs exactly what's currently live at `my-app.myth.work`
using the same content-addressed object graph `myth publish` builds — it
refuses to overwrite an existing non-empty directory (same spirit as
`git clone`). Supports `--staging` and `--api <url>` like the other commands,
and `--dir <path>` to materialize into a directory with a different name than
the app itself.

### Flags

```bash
myth publish [--name <shortName>] [--default] [--force] [--staging] [--api <url>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--name` | none (canonical only) | Request `{name}.myth.work` alias. First-claim-wins. |
| `--default` / `--apex` | unset | Also set this publish as the zone apex (`https://{zone}/`, the reserved `~apex` pointer). Owner-gated: your signed-in user must match the deployed `APEX_OWNER_USER_ID`. `--name ~apex` is sugar for this. |
| `--force` | unset | Publish even when the target URL already serves identical content. Without it, an exact served-tree match no-ops (no commit minted). |
| `--staging` | unset (publishes to prod) | Publish to `api.llama.space` instead of `api.myth.work`. |
| `--api` | derived from `--staging` | Override the worker base URL (escape hatch for local dev). |

> The entry point is auto-detected at the edge (`main.tsx` / `index.tsx` / `App.tsx` / `src/*`); there's no publish-time `--entry` flag in the source model.

Environment variables (lower precedence than flags):

- `MYTH_API_URL` — same as `--api`.
- `MYTH_AUTH_URL` — override the auth landing origin.

Sessions are acquired as: `MYTH_SESSION_TOKEN` env (headless/CI) → on-disk
cache at `~/.config/myth/session-{auth-host}.json` (0600, reused until 5
minutes before expiry) → browser handshake (then cached for next time).

## Config

App identity lives in your `package.json` — the `"mythwork"` block, falling back to the package `name`:

```json
{
  "name": "my-app",
  "mythwork": { "displayName": "My App", "theme": "light" }
}
```

`myth run` and `myth publish` walk up from `cwd` to find it (same discipline as `npm`/`git`). A standalone `myth.config.json` (`{ "name": "<app name>" }`) is the legacy fallback — `myth init` creates one, and it takes precedence if both are present.

The `projectId` is **not** committed — it is
per-(user, stage) derived state. On publish the CLI resolves it via an
idempotent provision call keyed by `(owner, name)`, so the same user converges
on the same project every time without any local state to drift or to 403 a
teammate.

## Commands

| Command | Purpose |
|---|---|
| `myth clone <name>` | Clone `https://github.com/mythwork-ai/<name>` into the current directory |
| `myth pull <name> [--dir <path>]` | Reconstruct a published app's current source into a new local directory |
| `myth init` | Create a new `myth.config.json` in the current directory |
| `myth run [--entry <file>] [--port <port>] [--stage <name>]` | Run the app in a deployment-shaped host frame (port 5173; stage prod / staging / local) |
| `myth publish [flags]` | Upload source + publish to `myth.work` (or staging); compiles at the edge |
| `myth unpublish --name <shortName>` | Take down a published app (owner-gated) |
| `myth help` | Show the help text |
