# myth-cli

`myth` CLI — runs and publishes [mythwork](https://myth.work) apps. TypeScript/ESM; thin dispatcher in `bin/myth.ts`, command modules in `src/`.

## Commands
- Test: `npm test` (vitest run)
- Build / type-check: `npm run build` (tsc → `dist/`)
- Watch build: `npm run dev`

## Git workflow (draft-first PRs)
Branch off `main` (`feat/…`, `fix/…`, `ci/…`); never commit to `main` directly. Conventional Commits.

**Open every PR as a draft, and mark it ready only when the work is verified:**

```bash
gh pr create --draft --fill          # open as draft
# …iterate: commit + push as needed…
npm test && npm run build            # verify
gh pr ready <number>                 # intentional transition to "Ready for review"
```

Why: the CI in `.github/workflows/` is gated on draft state — both `Code Review`
and `Claude Auto-Approve` **skip draft PRs** and run only on `ready_for_review`
(and subsequent pushes). So a draft PR costs **zero** review/approve runs no
matter how many times you push. Marking it ready is the single intentional
signal that fires the (expensive, Opus-backed) review exactly once.

Corollary: don't force-push a *ready* PR repeatedly to polish — batch edits, or
flip it back to draft (`gh pr ready --undo <number>`) while iterating. Each push
to a ready PR re-runs the review (now deduped by a `concurrency` group, but
still not free).

## CI gates (`.github/workflows/`)
- `claude-review.yml` — posts a line-by-line review. Skips drafts + docs-only
  diffs (`paths-ignore`); `concurrency` cancels an in-flight review on a new push.
- `claude-auto-approve.yml` — submits an approving review at ≥0.90 confidence
  (fail-closed otherwise). Skips drafts. **Refuses to auto-approve any PR that
  touches `.github/`** — CI changes always need a human approving review.

## Conventions
- No new dependencies without asking — prefer stdlib / already-installed.
- Go for ~100% unit coverage on testable units (see global CLAUDE.md); inject
  mocks rather than leaving logic untested.
- Match surrounding style; formatting is not restated here.
