#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case "clone":
      await clone(args[1]);
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
  myth init                      Create myth.config.json in the current
                                 directory with a stable local projectId
  myth run [--entry <file>]      Run the current directory as a mythwork app
             [--port <port>]     (default entry: src/main.tsx, src/App.tsx, App.tsx)
  myth publish [--name <name>]   Build + upload the current project to the
               [--staging]       publish worker. Default backend is prod
               [--api <url>]     (api.myth.work); --staging uses api.llama.space.

Examples:
  myth clone reveal              # Clone the reveal example
  cd reveal
  myth init                      # Create myth.config.json
  myth run                       # Start the dev server
  myth run --entry MyApp.tsx     # Use a different entry file
  myth run --port 5174           # Pin to a port already in your OAuth origins
  myth publish                   # Publish to prod, canonical URL only
  myth publish --name my-app     # Publish with alias my-app.myth.work
  myth publish --name my-app --staging   # Publish to api.llama.space
`);
}

/**
 * Derive a stable 17-char lowercase-alphanumeric local projectId from
 * the given seed. Matches the production HMAC-signed pid shape so
 * downstream code (URL matchers, kernel pid validators) accepts it.
 *
 * Local-only: real apps publishing to production should re-mint via
 * the production /provision flow (browser-based Turnstile + DT cookie)
 * and overwrite this value. For local development against either
 * `myth run` or `make tennis-dev`, a stable hash is enough.
 */
function generateLocalPid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return hex.slice(0, 17).toLowerCase();
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
  if (typeof existing.projectId === "string" && existing.projectId.length > 0) {
    console.log(
      `myth.config.json already initialized: projectId=${existing.projectId}`,
    );
    console.log(`(at ${configPath})`);
    return;
  }
  const name =
    typeof existing.name === "string" && existing.name.length > 0
      ? existing.name
      : path.basename(cwd);
  // Seed includes the absolute cwd so two apps named "tennis" in
  // different directories don't collide on projectId.
  const projectId = generateLocalPid(`${name}::${cwd}`);
  const next = { projectId, name, ...existing };
  writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n");
  console.log(`Created ${configPath}`);
  console.log(`  projectId: ${projectId}`);
  console.log(`  name:      ${name}`);
  console.log(`Run \`myth run\` to start the dev server.`);
}

async function clone(name: string | undefined) {
  if (!name) {
    console.error("Usage: myth clone <name>");
    process.exit(1);
  }

  const repoUrl = `https://github.com/mythwork-ai/${name}`;
  console.log(`Cloning ${repoUrl}...`);

  try {
    execSync(`git clone ${repoUrl}`, { stdio: "inherit" });
    console.log(`\nCloned into ${name}\n\nRun:\n  cd ${name}\n  myth run`);
  } catch {
    console.error(`Failed to clone ${repoUrl}`);
    process.exit(1);
  }
}

async function run(runArgs: string[]) {
  const explicitEntry = parseEntry(runArgs);
  const explicitPort = parsePort(runArgs);
  const cwd = process.cwd();
  // startServer walks up from `cwd` to find myth.config.json and
  // anchors vite to that directory. Entry resolution happens there too
  // (so `myth run --entry src/main.tsx` is interpreted relative to the
  // workspace root, not the subdirectory we were invoked from).
  const { startServer } = await import("../src/run.js");
  await startServer(cwd, explicitEntry, explicitPort);
}

async function publish(pubArgs: string[]) {
  const shortName = parseStringFlag(pubArgs, "--name");
  const apiUrl = parseStringFlag(pubArgs, "--api");
  const staging = pubArgs.includes("--staging");
  const explicitEntry = parseEntry(pubArgs);
  const { publishCommand } = await import("../src/publish/index.js");
  const { PublishError } = await import("../src/publish/client.js");
  const { HandshakeTimeoutError } = await import("../src/publish/auth-handshake.js");
  try {
    await publishCommand({
      cwd: process.cwd(),
      shortName,
      staging,
      apiUrl,
      entry: explicitEntry,
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
