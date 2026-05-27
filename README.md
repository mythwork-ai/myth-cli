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

1. Runs `vite build` to produce `dist/`.
2. Opens your browser to sign in (one-time per publish — Google OAuth via `auth.myth.work`).
3. Uploads the bundle as git-format objects to the publish worker.
4. Prints the canonical URL (content-addressed) and your `my-app.myth.work` alias.

By default this publishes to **prod** (`api.myth.work`). Pass `--staging` to publish to `api.llama.space` instead (useful for testing the publish flow without touching prod):

```bash
myth publish --name my-app --staging
```

### Flags

```bash
myth publish [--name <shortName>] [--staging] [--api <url>] [--entry <file>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--name` | none (canonical only) | Request `{name}.myth.work` alias. First-claim-wins. |
| `--staging` | unset (publishes to prod) | Publish to `api.llama.space` instead of `api.myth.work`. |
| `--api` | derived from `--staging` | Override the worker base URL (escape hatch for local dev). |
| `--entry` | auto-detected | Override the auto-detected Vite entry. |

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
| `myth publish [flags]` | Build and publish to `myth.work` (or staging) |
| `myth help` | Show the help text |
