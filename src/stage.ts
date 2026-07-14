/**
 * Stage resolution for `myth run`.
 *
 * `myth run` simulates the DEPLOYED shape of an app: an outer host-frame page
 * wrapping the app's own document, with every platform call mediated by the
 * host frame against a real backend stack. A "stage" names which stack:
 *
 *   prod    → myth.work     (default — matches `myth publish`'s default)
 *   staging → llama.space
 *   local   → the mythwork repo's `make dev` stack (api/auth :8801,
 *             serve :8802, collab :1234)
 *
 * The dev server mirrors production's host layout on `*.localhost`
 * subdomains (RFC 6761 — browsers resolve them to loopback, and they are
 * same-site with `localhost`, so proxied auth/api cookies stay first-party):
 *
 *   localhost:{port}       → outer host-frame wrapper   (≈ {app}.{zone})
 *   app.localhost:{port}   → the app itself, vite-served (≈ {tree}{token}.{zone})
 *   api.localhost:{port}   → proxied to api.{zone}
 *   auth.localhost:{port}  → proxied to auth.{zone}
 *   /_hf/* and /_oc/*      → proxied to the stage's serve worker
 */

export interface Stage {
  name: "prod" | "staging" | "local";
  /** Human-readable stack label for startup logging. */
  label: string;
  /** Upstream for the api.localhost proxy (api.{zone}). */
  apiOrigin: string;
  /** Upstream for the auth.localhost proxy (auth.{zone}). */
  authOrigin: string;
  /** Upstream for /_hf/* + /_oc/* (the serve worker / zone apex). */
  serveOrigin: string;
  /** Collab WebSocket base, handed straight to the kernel (no proxy — WS). */
  collabUrl: string;
}

const STAGES: Record<Stage["name"], Stage> = {
  prod: {
    name: "prod",
    label: "myth.work (prod)",
    apiOrigin: "https://api.myth.work",
    authOrigin: "https://auth.myth.work",
    serveOrigin: "https://myth.work",
    collabUrl: "wss://collab.myth.work",
  },
  staging: {
    name: "staging",
    label: "llama.space (staging)",
    apiOrigin: "https://api.llama.space",
    authOrigin: "https://auth.llama.space",
    serveOrigin: "https://llama.space",
    collabUrl: "wss://collab.llama.space",
  },
  // The mythwork repo's `make dev` stack (scripts/system-dev.sh): the api
  // worker dispatches auth by HOSTNAME (auth.localhost), same as deployed.
  local: {
    name: "local",
    label: "local mythwork stack (make dev)",
    apiOrigin: "http://localhost:8801",
    authOrigin: "http://auth.localhost:8801",
    serveOrigin: "http://localhost:8802",
    collabUrl: "ws://localhost:1234",
  },
};

/**
 * Resolve the target stage from the `--stage` flag (or the MYTH_STAGE env
 * var; the flag wins). Unknown names exit with the valid choices.
 *
 * Individual origins can then be overridden via MYTH_API_ORIGIN /
 * MYTH_AUTH_ORIGIN / MYTH_SERVE_ORIGIN / MYTH_COLLAB_URL — for pointing one
 * piece of the stack at a local build (e.g. a locally-run serve worker)
 * while the rest stays deployed.
 */
export function resolveStage(flag?: string, env: NodeJS.ProcessEnv = process.env): Stage {
  const name = flag ?? env.MYTH_STAGE ?? "prod";
  const stage = STAGES[name as Stage["name"]];
  if (!stage) {
    console.error(
      `[myth] unknown stage "${name}". Valid stages: ${Object.keys(STAGES).join(", ")}.`,
    );
    process.exit(1);
  }
  return {
    ...stage,
    apiOrigin: env.MYTH_API_ORIGIN ?? stage.apiOrigin,
    authOrigin: env.MYTH_AUTH_ORIGIN ?? stage.authOrigin,
    serveOrigin: env.MYTH_SERVE_ORIGIN ?? stage.serveOrigin,
    collabUrl: env.MYTH_COLLAB_URL ?? stage.collabUrl,
  };
}
