import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveStage } from "./stage.js";

describe("resolveStage", () => {
  afterEach(() => {
    delete process.env.MYTH_STAGE;
    vi.restoreAllMocks();
  });

  it("defaults to prod (matches `myth publish`)", () => {
    const s = resolveStage();
    expect(s.name).toBe("prod");
    expect(s.apiOrigin).toBe("https://api.myth.work");
    expect(s.authOrigin).toBe("https://auth.myth.work");
    expect(s.serveOrigin).toBe("https://myth.work");
    expect(s.collabUrl).toBe("wss://collab.myth.work");
  });

  it("resolves staging to the llama.space stack", () => {
    const s = resolveStage("staging");
    expect(s.apiOrigin).toBe("https://api.llama.space");
    expect(s.authOrigin).toBe("https://auth.llama.space");
    expect(s.serveOrigin).toBe("https://llama.space");
    expect(s.collabUrl).toBe("wss://collab.llama.space");
  });

  it("resolves local to the mythwork `make dev` stack, auth by hostname", () => {
    const s = resolveStage("local");
    expect(s.apiOrigin).toBe("http://localhost:8801");
    expect(s.authOrigin).toBe("http://auth.localhost:8801");
    expect(s.serveOrigin).toBe("http://localhost:8802");
    expect(s.collabUrl).toBe("ws://localhost:1234");
  });

  it("reads MYTH_STAGE when no flag is given, flag wins over env", () => {
    process.env.MYTH_STAGE = "staging";
    expect(resolveStage().name).toBe("staging");
    expect(resolveStage("local").name).toBe("local");
  });

  it("exits on an unknown stage name", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => resolveStage("qa")).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("resolveStage env origin overrides", () => {
  it("applies MYTH_*_ORIGIN overrides over the named stage", () => {
    const s = resolveStage("staging", {
      MYTH_SERVE_ORIGIN: "http://localhost:8899",
      MYTH_COLLAB_URL: "ws://localhost:1234",
    } as NodeJS.ProcessEnv);
    expect(s.serveOrigin).toBe("http://localhost:8899");
    expect(s.collabUrl).toBe("ws://localhost:1234");
    // untouched pieces keep the stage defaults
    expect(s.apiOrigin).toBe("https://api.llama.space");
    expect(s.authOrigin).toBe("https://auth.llama.space");
  });
});
