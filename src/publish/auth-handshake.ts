/**
 * Browser-mediated OAuth handshake for `myth publish`. Spawns a tiny
 * HTTP listener on 127.0.0.1:<random port>, opens the user's browser to
 * `<authOrigin>/cli-auth?nonce=...&callback=http://127.0.0.1:<port>/cb`,
 * and waits for the auth.{zone} page to POST the session JWT back.
 *
 *   1. Generate a 32-byte CSRF nonce. Held in memory only.
 *   2. Bind 127.0.0.1 on an OS-assigned port (loopback only, no LAN
 *      exposure). Single-use: shuts down after the first valid callback.
 *   3. Open the user's default browser to the auth URL.
 *   4. Wait up to `timeoutMs` for `POST /cb` with the matching nonce.
 *   5. Decode the JWT (display only — signature verification happens
 *      server-side on every subsequent request).
 *   6. Resolve with { sessionToken, userEmail, userId }.
 *
 * No persistence — each `myth publish` triggers a fresh handshake.
 * Spec defers token caching to a future `--remember` flag.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { platform } from 'node:os'

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export interface HandshakeResult {
  /** Session JWT — paste into `Authorization: Bearer <jwt>` on publish calls. */
  sessionToken: string
  /** From the JWT payload (display only — signature not verified client-side). */
  userEmail: string | null
  /** From the JWT `sub` claim. Display only. */
  userId: string | null
  /** From the auth.{zone} POST. Optional. */
  userName: string | null
}

export interface HandshakeOptions {
  /** Origin of the auth host (e.g. https://auth.myth.work). No trailing slash. */
  authOrigin: string
  /** How long to wait before giving up. Default 5 minutes. */
  timeoutMs?: number
  /** Pin to a specific port (tests). Default: OS-assigned (port 0). */
  port?: number
  /** If false, don't spawn `open`/`xdg-open`/`start`. Used by tests. */
  openBrowser?: boolean
  /** Logger for status lines. Default: console.log. */
  log?: (line: string) => void
}

/**
 * Run the full handshake. Resolves with the captured token, or rejects
 * with a typed error on timeout / nonce mismatch / port collision.
 *
 * Listener lifecycle is bound to this call: it's spun up before the
 * browser launch and torn down (synchronously) before the promise
 * resolves or rejects — no dangling sockets.
 */
export async function runAuthHandshake(opts: HandshakeOptions): Promise<HandshakeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const log = opts.log ?? ((line: string) => console.log(line))
  const nonce = randomBytes(32).toString('base64url')

  const { server, port } = await startCallbackServer(opts.port ?? 0)
  const callbackUrl = `http://127.0.0.1:${port}/cb`
  const authUrl =
    `${opts.authOrigin}/cli-auth` +
    `?nonce=${encodeURIComponent(nonce)}` +
    `&callback=${encodeURIComponent(callbackUrl)}`

  log('[myth] Open this URL to sign in:')
  log(`[myth]   ${authUrl}`)

  if (opts.openBrowser !== false) {
    tryOpenBrowser(authUrl)
  }

  const minutes = Math.round(timeoutMs / 60000)
  log(`[myth] Waiting for sign-in (will time out in ${minutes} min)...`)

  try {
    return await waitForCallback(server, nonce, timeoutMs)
  } finally {
    server.close()
    server.closeAllConnections?.()
  }
}

// ===========================================================================
// Listener
// ===========================================================================

interface StartedServer {
  server: Server
  port: number
}

/**
 * Bind on 127.0.0.1:<port> (0 = OS-assigned). Exported for tests so they
 * can drive the listener directly without spawning a browser.
 */
export async function startCallbackServer(port: number): Promise<StartedServer> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr === 'string' || addr === null) {
        reject(new Error('listener bound to unexpected address'))
        return
      }
      resolve({ server, port: addr.port })
    })
  })
}

/**
 * Wait for the first POST /cb with a matching nonce. Any other request
 * gets a 404 (browser pre-flights, favicon, etc.). Mismatched-nonce POSTs
 * get a 400 but the listener stays open — a legitimate callback may
 * still arrive (the spec calls this out as the "legit callback may
 * still arrive" path).
 */
export function waitForCallback(
  server: Server,
  expectedNonce: string,
  timeoutMs: number,
): Promise<HandshakeResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.removeListener('request', onRequest)
      reject(new HandshakeTimeoutError(timeoutMs))
    }, timeoutMs)

    function done(value: HandshakeResult): void {
      clearTimeout(timer)
      server.removeListener('request', onRequest)
      resolve(value)
    }

    function onRequest(req: IncomingMessage, res: ServerResponse): void {
      // CORS preflight from the browser-mediated POST — the spec page
      // uses `mode: 'no-cors'` but some browsers still send OPTIONS for
      // simple requests with custom headers.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders())
        res.end()
        return
      }

      if (req.method !== 'POST' || req.url !== '/cb') {
        res.writeHead(404, { 'Content-Type': 'text/plain', ...corsHeaders() })
        res.end('not found')
        return
      }

      // Read body. Cap at 64 KB — JWTs are well under 8 KB; anything
      // larger is suspect.
      const chunks: Buffer[] = []
      let total = 0
      let aborted = false
      req.on('data', (chunk: Buffer) => {
        if (aborted) return
        total += chunk.length
        if (total > 64 * 1024) {
          aborted = true
          res.writeHead(413, { 'Content-Type': 'text/plain', ...corsHeaders() })
          res.end('payload too large')
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (aborted) return
        const raw = Buffer.concat(chunks).toString('utf-8')
        let parsed: {
          sessionToken?: unknown
          nonce?: unknown
          userEmail?: unknown
          userName?: unknown
        }
        try {
          parsed = JSON.parse(raw) as typeof parsed
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain', ...corsHeaders() })
          res.end('bad json')
          return
        }
        if (typeof parsed.nonce !== 'string' || parsed.nonce !== expectedNonce) {
          // Nonce mismatch: reject this caller but keep the listener
          // alive in case the legitimate browser tab is still loading.
          res.writeHead(400, { 'Content-Type': 'text/plain', ...corsHeaders() })
          res.end('bad nonce')
          return
        }
        if (typeof parsed.sessionToken !== 'string' || parsed.sessionToken.length === 0) {
          res.writeHead(400, { 'Content-Type': 'text/plain', ...corsHeaders() })
          res.end('missing sessionToken')
          return
        }

        const userEmail = typeof parsed.userEmail === 'string' ? parsed.userEmail : null
        const userName = typeof parsed.userName === 'string' ? parsed.userName : null
        const claims = decodeJwtPayloadSafe(parsed.sessionToken)
        const userId = typeof claims.sub === 'string' ? claims.sub : null
        const claimEmail = typeof claims.email === 'string' ? claims.email : null

        res.writeHead(200, { 'Content-Type': 'text/plain', ...corsHeaders() })
        res.end('ok')

        done({
          sessionToken: parsed.sessionToken,
          userEmail: userEmail ?? claimEmail,
          userId,
          userName,
        })
      })
    }

    server.on('request', onRequest)
  })
}

// ===========================================================================
// JWT decode (display only — not verified)
// ===========================================================================

interface JwtPayload {
  sub?: unknown
  email?: unknown
  [key: string]: unknown
}

/**
 * Decode (NOT verify) the payload of a JWT. Used only to surface
 * "Signed in as alice@example.com" in the CLI output. Signature
 * validation happens server-side on every subsequent request — the CLI
 * has no key material to verify with anyway.
 *
 * Returns an empty object on any malformed input; the caller treats
 * missing fields as "unknown" and proceeds.
 */
export function decodeJwtPayloadSafe(jwt: string): JwtPayload {
  const parts = jwt.split('.')
  if (parts.length < 2) return {}
  try {
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const raw = Buffer.from(padded, 'base64').toString('utf-8')
    return JSON.parse(raw) as JwtPayload
  } catch {
    return {}
  }
}

// ===========================================================================
// Browser launcher
// ===========================================================================

/**
 * Best-effort browser open. Doesn't block; doesn't fail the handshake
 * if the launcher exits non-zero — the user can still paste the URL
 * manually (the CLI already printed it).
 */
function tryOpenBrowser(url: string): void {
  const plat = platform()
  let cmd: string
  let args: string[]
  if (plat === 'darwin') {
    cmd = 'open'
    args = [url]
  } else if (plat === 'win32') {
    // `start` is a cmd.exe builtin; we shell through cmd /c so it
    // resolves. The empty "" is the window title (positional quirk).
    cmd = 'cmd'
    args = ['/c', 'start', '""', url]
  } else {
    cmd = 'xdg-open'
    args = [url]
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {
      // swallow — user has the URL on stdout
    })
    child.unref()
  } catch {
    // swallow
  }
}

// ===========================================================================
// Error types
// ===========================================================================

export class HandshakeTimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`No sign-in received within ${Math.round(timeoutMs / 1000)}s.`)
    this.name = 'HandshakeTimeoutError'
  }
}

function corsHeaders(): Record<string, string> {
  // The /cli-auth page POSTs with `mode: 'no-cors'` so these headers
  // aren't strictly necessary — but a permissive CORS reply costs
  // nothing and tolerates browsers that promote the POST to a CORS
  // request because of the JSON content type.
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}
