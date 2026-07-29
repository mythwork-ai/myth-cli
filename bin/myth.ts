#!/usr/bin/env node

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case "clone":
      await clone(args[1]);
      break;
    case "pull":
      await pull(args.slice(1));
      break;
    case "eject":
      await ejectApp(args.slice(1));
      break;
    case "init":
      await init();
      break;
    case "run":
      await run(args.slice(1));
      break;
    case "publish":
      await publish(args.slice(1));
      break;
    case "unpublish":
      await unpublish(args.slice(1));
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      if (!command) {
        printHelp();
      } else {
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
      }
  }
}

function printHelp() {
  console.log(`
myth - CLI for running and publishing mythwork apps

Usage:
  myth clone <name>              Clone an example from mythwork-ai/<name>
  myth pull <name>              Reconstruct <name>'s currently-published
               [--staging]      source into a new local dir ./<name>
               [--api <url>]    (refuses an existing non-empty dir).
               [--dir <path>]   Uses the same auth as publish.
  myth eject <name>             Export <name> as a fully standalone Vite/React
               [--staging]      project you own — platform imports rewritten to a
               [--api <url>]    vendored runtime, clean toolchain emitted, no
               [--dir <path>]   mythwork dependency. Runs with pnpm i && pnpm dev.
                                Transform runs server-side; refuses a non-empty dir.
  myth init                      Create myth.config.json (name only) in the
                                 current directory; first publish provisions the id
  myth run [--entry <file>]      Run the current directory as a mythwork app,
             [--port <port>]     wrapped in the SAME host frame a deployed app
             [--stage <name>]    gets (outer wrapper on localhost, the app on
                                 app.localhost, api/auth proxied on *.localhost).
                                 --stage prod (default) | staging | local
                                 (local = the mythwork repo's \`make dev\` stack).
                                 --entry only applies to legacy apps without
                                 their own index.html.
  myth publish [--name <name>]   Upload the current app's SOURCE to myth.work;
               [--default]       it compiles at the edge (no local build).
               [--staging]       --default (or --name ~apex) also sets the
               [--force]         zone apex, https://{zone}/ (owner-gated).
               [--api <url>]     Unchanged content no-ops unless --force.
               [--no-wait]       Skip build-status streaming; exit after upload.
               [--watch]         Stream build status even in non-TTY / CI.
               [--subscribe <t>] Stream status for an already-published tree.
                                 Default backend is prod (api.myth.work);
                                 --staging uses api.llama.space.
  myth unpublish --name <name>   Remove a published alias and release its
               [--staging]       refs for GC. --name is REQUIRED. Uses the
               [--api <url>]     same prod/staging/auth flow as publish.

Examples:
  myth clone reveal              # Clone the reveal example
  cd reveal
  myth pull my-app                # Reconstruct my-app into ./my-app
  myth eject my-app               # Export my-app as a standalone project you own
  myth init                      # Create myth.config.json
  myth run                       # Start the dev server
  myth run --entry MyApp.tsx     # Use a different entry file
  myth run --port 5174           # Pin to a port already in your OAuth origins
  myth publish                   # Publish to prod, canonical URL only
  myth publish --name my-app     # Publish with alias my-app.myth.work
  myth publish --name my-app --staging   # Publish to api.llama.space
  myth publish --no-wait         # Fire-and-forget (today's CI behaviour)
  myth publish --watch           # Force build-status stream even in CI
  myth publish --subscribe <tree># Re-attach to a detached build
  myth unpublish --name my-app           # Remove the my-app alias (prod)
  myth unpublish --name my-app --staging # Remove the my-app alias (staging)
`);
}

async function init() {
  const cwd = process.cwd();
  const configPath = path.join(cwd, "myth.config.json");
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    } catch (e) {
      console.error(
        `myth.config.json exists but isn't valid JSON: ${(e as Error).message}`,
      );
      process.exit(1);
    }
  }
  if (typeof existing.name === "string" && existing.name.length > 0) {
    console.log(`myth.config.json already initialized: name=${existing.name}`);
    console.log(`(at ${configPath})`);
    return;
  }
  const name = path.basename(cwd);
  // AGE-78: write a NAME-ONLY config — no projectId. `myth run` derives an
  // ephemeral local pid; the first `myth publish` provisions the real
  // canonical id and writes it back. The config never carries a fake/doomed id.
  const next = { name, ...existing };
  writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n");
  console.log(`Created ${configPath}`);
  console.log(`  name: ${name}`);
  console.log(`Run \`myth run\` to start the dev server, or \`myth publish\` to ship it.`);
}

/** Runs a git command via execFile (argv form, no shell). Injected so unit
 *  tests never spawn a real git process — mirrors the `LockfileRunner`
 *  injection pattern in src/publish/lockfile-check.ts. */
export type CloneRunner = (cmd: string, args: string[]) => Promise<void>;

export const realCloneRunner: CloneRunner = async (cmd, args) => {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    maxBuffer: 16 * 1024 * 1024,
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
};

export async function clone(
  name: string | undefined,
  runner: CloneRunner = realCloneRunner,
) {
  if (!name) {
    console.error("Usage: myth clone <name>");
    process.exit(1);
    return;
  }

  const repoUrl = `https://github.com/mythwork-ai/${name}`;
  console.log(`Cloning ${repoUrl}...`);

  try {
    // `name` (and therefore repoUrl) comes straight from argv. Passing it as
    // its own argv element to execFile — never interpolated into a shell
    // string — means shell metacharacters in `name` (e.g. `x; rm -rf ~`)
    // are just part of a single (invalid) URL argument, not executed.
    await runner("git", ["clone", repoUrl]);
    console.log(`\nCloned into ${name}\n\nRun:\n  cd ${name}\n  myth run`);
  } catch {
    console.error(`Failed to clone ${repoUrl}`);
    process.exit(1);
  }
}

/**
 * Parse the `myth pull` argument vector. The name is positional (the first
 * non-flag argument); everything else follows the same `--flag <value>` /
 * `--flag=value` convention as parsePubArgs. Exported for unit testing.
 */
export interface PullArgs {
  name?: string;
  apiUrl?: string;
  staging: boolean;
  dir?: string;
}

export function parsePullArgs(pullArgs: string[]): PullArgs {
  const name = pullArgs[0] && !pullArgs[0].startsWith("--") ? pullArgs[0] : undefined;
  const rest = name ? pullArgs.slice(1) : pullArgs;
  const apiUrl = parseStringFlag(rest, "--api");
  const staging = rest.includes("--staging");
  const dir = parseStringFlag(rest, "--dir");
  return { name, apiUrl, staging, dir };
}

/** True when `dir` exists and already contains at least one entry — the
 *  git-clone-style guard against clobbering existing work. An existing
 *  EMPTY directory is fine (matches `git clone`'s own behavior). Exported
 *  for unit testing. */
export function isNonEmptyDirectory(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).length > 0;
}

export async function pull(pullArgs: string[]) {
  const parsed = parsePullArgs(pullArgs);
  if (!parsed.name) {
    console.error("Usage: myth pull <name> [--staging] [--api <url>] [--dir <path>]");
    process.exit(1);
    return;
  }
  const destName = parsed.dir ?? parsed.name;
  const destDir = path.resolve(process.cwd(), destName);

  if (isNonEmptyDirectory(destDir)) {
    console.error(`[myth] Refusing to pull into existing non-empty directory: ${destName}`);
    process.exit(1);
    return;
  }

  const { PublishError } = await import("../src/publish/client.js");
  const { HandshakeTimeoutError } = await import("../src/publish/auth-handshake.js");
  const { ReconstructError } = await import("../src/publish/read-objects.js");
  const { pullCommand } = await import("../src/publish/pull.js");
  try {
    await pullCommand({
      name: parsed.name,
      destDir,
      staging: parsed.staging,
      apiUrl: parsed.apiUrl,
    });
    console.log(`\nPulled into ${destName}\n\nRun:\n  cd ${destName}\n  myth run`);
  } catch (err) {
    if (err instanceof PublishError) {
      if (err.code === "not_found") {
        console.error(`[myth] No published app named '${parsed.name}'.`);
      } else if (err.code === "not_owner") {
        console.error(`[myth] You are not the publisher of '${parsed.name}'.`);
      } else {
        console.error(`[myth] ${err.message}`);
      }
      process.exit(1);
      return;
    }
    if (err instanceof ReconstructError) {
      console.error(`[myth] ${err.message}`);
      process.exit(1);
      return;
    }
    if (err instanceof HandshakeTimeoutError) {
      console.error(`[myth] ${err.message}`);
      console.error("[myth] No sign-in received. Re-run `myth pull`.");
      process.exit(1);
      return;
    }
    console.error(`[myth] ${(err as Error).message ?? err}`);
    process.exit(1);
  }
}

/**
 * Parse the `myth eject` argument vector. Mirrors parsePullArgs — the name is
 * the positional published alias to export. Exported for unit testing.
 */
export interface EjectArgs {
  name?: string;
  apiUrl?: string;
  staging: boolean;
  dir?: string;
}

export function parseEjectArgs(ejectArgs: string[]): EjectArgs {
  const name = ejectArgs[0] && !ejectArgs[0].startsWith("--") ? ejectArgs[0] : undefined;
  const rest = name ? ejectArgs.slice(1) : ejectArgs;
  const apiUrl = parseStringFlag(rest, "--api");
  const staging = rest.includes("--staging");
  const dir = parseStringFlag(rest, "--dir");
  return { name, apiUrl, staging, dir };
}

export async function ejectApp(ejectArgs: string[]) {
  const parsed = parseEjectArgs(ejectArgs);
  if (!parsed.name) {
    console.error("Usage: myth eject <name> [--staging] [--api <url>] [--dir <path>]");
    process.exit(1);
    return;
  }
  const destName = parsed.dir ?? parsed.name;
  const destDir = path.resolve(process.cwd(), destName);

  if (isNonEmptyDirectory(destDir)) {
    console.error(`[myth] Refusing to eject into existing non-empty directory: ${destName}`);
    process.exit(1);
    return;
  }

  const { PublishError } = await import("../src/publish/client.js");
  const { HandshakeTimeoutError } = await import("../src/publish/auth-handshake.js");
  const { ejectCommand } = await import("../src/publish/eject.js");
  try {
    const result = await ejectCommand({
      name: parsed.name,
      destDir,
      staging: parsed.staging,
      apiUrl: parsed.apiUrl,
    });
    if (result.secretsVendored) {
      console.warn(
        "[myth] ⚠ Secrets are read from VITE_* env and bundled into the client — exposed to the browser. " +
          "Fine for local/personal use; front real secrets with your own server for a public deploy.",
      );
    }
    console.log(
      `\nEjected into ${destName} — a standalone project you own (see EJECT_NOTES.md for what changed).\n\nRun:\n  cd ${destName}\n  pnpm install\n  pnpm dev`,
    );
  } catch (err) {
    if (err instanceof PublishError) {
      if (err.code === "not_found") {
        console.error(`[myth] No published app named '${parsed.name}'.`);
      } else if (err.code === "not_owner") {
        console.error(`[myth] You are not the publisher of '${parsed.name}'.`);
      } else {
        // bad_bundle (not ejectable / residual), too_large, corrupt_pack,
        // backend_down, session_expired, unknown — err.message is user-facing.
        console.error(`[myth] ${err.message}`);
      }
      process.exit(1);
      return;
    }
    if (err instanceof HandshakeTimeoutError) {
      console.error(`[myth] ${err.message}`);
      console.error("[myth] No sign-in received. Re-run `myth eject`.");
      process.exit(1);
      return;
    }
    console.error(`[myth] ${(err as Error).message ?? err}`);
    process.exit(1);
  }
}

async function run(runArgs: string[]) {
  const explicitEntry = parseEntry(runArgs);
  const explicitPort = parsePort(runArgs);
  const explicitStage = parseStage(runArgs);
  const cwd = process.cwd();
  // startServer walks up from `cwd` to find myth.config.json and
  // anchors vite to that directory. Entry resolution happens there too
  // (so `myth run --entry src/main.tsx` is interpreted relative to the
  // workspace root, not the subdirectory we were invoked from).
  const { startServer } = await import("../src/run.js");
  await startServer(cwd, explicitEntry, explicitPort, explicitStage);
}

/** Parse `--stage <prod|staging|local>` (validated in src/stage.ts). */
function parseStage(runArgs: string[]): string | undefined {
  for (let i = 0; i < runArgs.length; i++) {
    const a = runArgs[i];
    if (a === "--stage") {
      const value = runArgs[i + 1];
      if (!value) {
        console.error("--stage requires a value (prod | staging | local)");
        process.exit(1);
      }
      return value;
    }
    if (a.startsWith("--stage=")) {
      return a.slice("--stage=".length);
    }
  }
  return undefined;
}

/**
 * Parse the `myth publish` argument vector into a typed options bag.
 * Exported for unit testing. Calls process.exit on bad input (e.g. a flag
 * that requires a value but got none).
 */
export interface PubArgs {
  subscribeTree?: string;
  shortName?: string;
  apiUrl?: string;
  staging: boolean;
  apex: boolean;
  force: boolean;
  noWait: boolean;
  watch: boolean;
}

export function parsePubArgs(pubArgs: string[]): PubArgs {
  const subscribeTree = parseStringFlag(pubArgs, "--subscribe");
  const apiUrl = parseStringFlag(pubArgs, "--api");
  const staging = pubArgs.includes("--staging");
  const force = pubArgs.includes("--force");
  const noWait = pubArgs.includes("--no-wait");
  const watch = pubArgs.includes("--watch");
  let shortName = parseStringFlag(pubArgs, "--name");
  let apex = pubArgs.includes("--default") || pubArgs.includes("--apex");
  // `--name ~apex` is sugar for --default: the reserved ~apex ALIASES key is
  // the apex pointer, but `~` is outside the alias grammar, so it maps to the
  // wire field `apex: true` instead of a literal shortName.
  if (shortName === "~apex") {
    apex = true;
    shortName = undefined;
  }
  return { subscribeTree, shortName, apiUrl, staging, apex, force, noWait, watch };
}

async function publish(pubArgs: string[]) {
  const { PublishError } = await import("../src/publish/client.js");
  const { HandshakeTimeoutError } = await import("../src/publish/auth-handshake.js");
  const parsed = parsePubArgs(pubArgs);

  // --subscribe <tree>: skip packaging entirely; just stream that tree's status.
  if (parsed.subscribeTree) {
    const { subscribeCommand } = await import("../src/publish/index.js");
    try {
      await subscribeCommand({ tree: parsed.subscribeTree, staging: parsed.staging, apiUrl: parsed.apiUrl });
    } catch (err) {
      if (err instanceof PublishError) {
        console.error(`[myth] ${err.message}`);
        process.exit(1);
      }
      if (err instanceof HandshakeTimeoutError) {
        console.error(`[myth] ${err.message}`);
        console.error("[myth] No sign-in received. Re-run `myth publish --subscribe`.");
        process.exit(1);
      }
      console.error(`[myth] ${(err as Error).message ?? err}`);
      process.exit(1);
    }
    return;
  }

  const { publishCommand } = await import("../src/publish/index.js");
  try {
    await publishCommand({
      cwd: process.cwd(),
      shortName: parsed.shortName,
      staging: parsed.staging,
      apiUrl: parsed.apiUrl,
      apex: parsed.apex,
      force: parsed.force,
      noWait: parsed.noWait,
      watch: parsed.watch,
    });
  } catch (err) {
    if (err instanceof PublishError) {
      console.error(`[myth] ${err.message}`);
      process.exit(1);
    }
    if (err instanceof HandshakeTimeoutError) {
      console.error(`[myth] ${err.message}`);
      console.error("[myth] No sign-in received. Re-run `myth publish`.");
      process.exit(1);
    }
    // Fall-through for OrbitConfigError + anything else.
    console.error(`[myth] ${(err as Error).message ?? err}`);
    process.exit(1);
  }
}

async function unpublish(unpubArgs: string[]) {
  const name = parseStringFlag(unpubArgs, "--name");
  if (!name) {
    console.error("[myth] --name is required for unpublish. Usage: myth unpublish --name <shortName>");
    process.exit(1);
  }
  const apiUrl = parseStringFlag(unpubArgs, "--api");
  const staging = unpubArgs.includes("--staging");
  const { unpublishCommand } = await import("../src/publish/unpublish.js");
  const { PublishError } = await import("../src/publish/client.js");
  const { HandshakeTimeoutError } = await import("../src/publish/auth-handshake.js");
  try {
    await unpublishCommand({
      cwd: process.cwd(),
      name,
      staging,
      apiUrl,
    });
  } catch (err) {
    if (err instanceof PublishError) {
      if (err.code === 'not_found') {
        console.error(`[myth] No app named '${name}'.`);
      } else if (err.code === 'not_owner') {
        console.error(`[myth] You are not the publisher of '${name}'.`);
      } else {
        console.error(`[myth] ${err.message}`);
      }
      process.exit(1);
    }
    if (err instanceof HandshakeTimeoutError) {
      console.error(`[myth] ${err.message}`);
      console.error("[myth] No sign-in received. Re-run `myth unpublish`.");
      process.exit(1);
    }
    // Fall-through for OrbitConfigError + anything else.
    console.error(`[myth] ${(err as Error).message ?? err}`);
    process.exit(1);
  }
}

/** Generic `--flag <value>` / `--flag=value` parser. Mutually exclusive
 *  from --entry / --port to keep the parser shape uniform. */
function parseStringFlag(argv: string[], flag: string): string | undefined {
  const eq = flag + "=";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag) {
      const value = argv[i + 1];
      if (!value) {
        console.error(`${flag} requires a value`);
        process.exit(1);
      }
      return value;
    }
    if (a.startsWith(eq)) {
      return a.slice(eq.length);
    }
  }
  return undefined;
}

function parsePort(runArgs: string[]): number | undefined {
  for (let i = 0; i < runArgs.length; i++) {
    const a = runArgs[i];
    if (a === "--port" || a === "-p") {
      const value = runArgs[i + 1];
      if (!value) {
        console.error(`${a} requires a port number`);
        process.exit(1);
      }
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
        console.error(`${a} must be a valid port number, got: ${value}`);
        process.exit(1);
      }
      return n;
    }
    if (a.startsWith("--port=")) {
      const value = a.slice("--port=".length);
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
        console.error(`--port must be a valid port number, got: ${value}`);
        process.exit(1);
      }
      return n;
    }
  }
  return undefined;
}

/** Candidate entry filenames tried in order when --entry isn't passed. */
const DEFAULT_ENTRY_CANDIDATES = [
  "src/main.tsx",
  "src/main.ts",
  "src/App.tsx",
  "App.tsx",
];

function parseEntry(runArgs: string[]): string | undefined {
  for (let i = 0; i < runArgs.length; i++) {
    const a = runArgs[i];
    if (a === "--entry" || a === "-e") {
      const value = runArgs[i + 1];
      if (!value) {
        console.error(`${a} requires a filename`);
        process.exit(1);
      }
      return value;
    }
    if (a.startsWith("--entry=")) {
      return a.slice("--entry=".length);
    }
  }
  return undefined;
}

export { DEFAULT_ENTRY_CANDIDATES };

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
