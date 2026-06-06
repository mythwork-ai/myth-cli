# myth-cli

Run and publish [mythwork](https://myth.work) apps locally with your own IDE.

## Install

```bash
git clone https://github.com/mythwork-ai/myth-cli.git
cd myth-cli && npm install && npm link
```

## Example

```bash
myth clone mythwork-logo
cd mythwork-logo
myth run
```

Opens http://localhost:5173 with HMR.

By default `myth run` looks for `src/main.tsx`, then `src/main.ts`, then `src/App.tsx`, then `App.tsx`. Use `--entry` to point at a different file:

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
- **Tailwind**: if detected, the CLI pre-bakes your Tailwind CSS locally before upload. Use **CSS-first config** (`@import "tailwindcss"` + `@theme`); a `tailwind.config.js` is not supported (publish will ask you to migrate it).

By default this publishes to **prod** (`api.myth.work`). Pass `--staging` to publish to `api.llama.space` instead (useful for testing the publish flow without touching prod):

```bash
myth publish --name my-app --staging
```

### Flags

```bash
myth publish [--name <shortName>] [--staging] [--api <url>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--name` | none (canonical only) | Request `{name}.myth.work` alias. First-claim-wins. |
| `--staging` | unset (publishes to prod) | Publish to `api.llama.space` instead of `api.myth.work`. |
| `--api` | derived from `--staging` | Override the worker base URL (escape hatch for local dev). |

> The entry point is auto-detected at the edge (`main.tsx` / `index.tsx` / `App.tsx` / `src/*`); there's no publish-time `--entry` flag in the source model.

Environment variables (lower precedence than flags):

- `MYTH_API_URL` — same as `--api`.
- `MYTH_AUTH_URL` — override the auth landing origin.

Token storage is in-memory per invocation. Each publish runs the browser handshake fresh — no on-disk cache (yet).

## Config

`myth run` and `myth publish` walk up from `cwd` looking for `myth.config.json`. Create one with:

```json
{
  "projectId": "<17-char pid>",
  "name": "<app name>"
}
```

`myth init` creates this for you (derives a stable local `projectId` from the directory).

## Commands

| Command | Purpose |
|---|---|
| `myth clone <name>` | Clone `https://github.com/mythwork-ai/<name>` into the current directory |
| `myth init` | Create a new `myth.config.json` in the current directory |
| `myth run [--entry <file>] [--port <port>]` | Start the Vite dev server (port 5173 by default) |
| `myth publish [flags]` | Upload source + publish to `myth.work` (or staging); compiles at the edge |
| `myth help` | Show the help text |
