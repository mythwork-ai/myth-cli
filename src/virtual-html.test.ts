import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfigOrThrow, OrbitConfigError } from "./virtual-html.js";

/**
 * Config discovery is named `orbitcode.config.json` — the canonical name
 * used by the orbitcode workspace (templates seed it, the agent eval
 * checks for it). A fork's `orbit → myth` rename leaked `myth.config.json`
 * back upstream and broke `orbit run` against real workspaces.
 */
describe("loadConfigOrThrow", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "orbit-cli-cfg-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("loads orbitcode.config.json from the start directory", () => {
    writeFileSync(
      path.join(root, "orbitcode.config.json"),
      JSON.stringify({ projectId: "abcdefghijklmnopq", name: "My App" }),
    );
    const loaded = loadConfigOrThrow(root);
    expect(loaded.root).toBe(root);
    expect(loaded.config.projectId).toBe("abcdefghijklmnopq");
    expect(loaded.config.name).toBe("My App");
  });

  it("walks up parent directories to find orbitcode.config.json", () => {
    writeFileSync(
      path.join(root, "orbitcode.config.json"),
      JSON.stringify({ projectId: "abcdefghijklmnopq", name: "My App" }),
    );
    const nested = path.join(root, "src", "components");
    mkdirSync(nested, { recursive: true });
    const loaded = loadConfigOrThrow(nested);
    expect(loaded.root).toBe(root);
  });

  it("throws naming orbitcode.config.json when none is found", () => {
    expect(() => loadConfigOrThrow(root)).toThrow(OrbitConfigError);
    expect(() => loadConfigOrThrow(root)).toThrow(/orbitcode\.config\.json/);
  });
});
