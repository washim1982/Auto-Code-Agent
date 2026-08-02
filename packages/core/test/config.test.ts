import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, SecretStore } from "../src/config/config.ts";
import { Logger, redactSecrets } from "../src/logging/logger.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aca-cfg-"));
  mkdirSync(join(root, ".aca"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("layered config", () => {
  it("returns defaults when nothing is configured", () => {
    const { config } = loadConfig();
    expect(config.router.privacy).toBe("prefer-local");
    expect(config.run.maxAttempts).toBe(2);
  });

  it("lets a workspace tighten privacy, which is the point of the ordering", () => {
    // A repo must be able to enforce local-only regardless of the developer's
    // personal default — the safer setting has to be the one a project can pin.
    writeFileSync(
      join(root, ".aca", "config.json"),
      JSON.stringify({ router: { privacy: "local-only" } }),
    );
    const { config, sources } = loadConfig({ workspaceRoot: root });
    expect(config.router.privacy).toBe("local-only");
    expect(sources.some((s) => s.layer === "workspace")).toBe(true);
  });

  it("merges deeply instead of replacing whole sections", () => {
    writeFileSync(
      join(root, ".aca", "config.json"),
      JSON.stringify({ budget: { maxTokens: 999 } }),
    );
    const { config } = loadConfig({ workspaceRoot: root });
    expect(config.budget.maxTokens).toBe(999);
    expect(config.budget.maxWallMs).toBe(30 * 60_000); // sibling default survives
  });

  it("lets env override the workspace", () => {
    writeFileSync(
      join(root, ".aca", "config.json"),
      JSON.stringify({ router: { privacy: "any" } }),
    );
    const { config } = loadConfig({
      workspaceRoot: root,
      env: { ACA_PRIVACY: "local-only" },
    });
    expect(config.router.privacy).toBe("local-only");
  });

  it("lets flags override everything", () => {
    const { config } = loadConfig({
      env: { ACA_MAX_TOKENS: "100" },
      flags: { budget: { maxTokens: 42 } },
    });
    expect(config.budget.maxTokens).toBe(42);
  });

  it("ignores a malformed config file rather than refusing to start", () => {
    writeFileSync(join(root, ".aca", "config.json"), "{ not json");
    expect(() => loadConfig({ workspaceRoot: root })).not.toThrow();
  });
});

describe("secret store", () => {
  it("prefers the environment over the file", () => {
    const store = new SecretStore(join(root, "secrets.json"));
    store.set("TEST_KEY", "from-file");
    process.env["TEST_KEY"] = "from-env";
    expect(store.get("TEST_KEY")).toBe("from-env");
    delete process.env["TEST_KEY"];
    expect(store.get("TEST_KEY")).toBe("from-file");
  });

  it("lists names without ever exposing values", () => {
    const store = new SecretStore(join(root, "secrets.json"));
    store.set("ANTHROPIC_API_KEY", "sk-ant-secret");
    expect(store.list()).toEqual(["ANTHROPIC_API_KEY"]);
    expect(JSON.stringify(store.list())).not.toContain("sk-ant");
  });

  it("returns undefined for an unknown key", () => {
    expect(new SecretStore(join(root, "nope.json")).get("MISSING")).toBeUndefined();
  });
});

describe("log redaction", () => {
  it("redacts credentials at the sink, not at the call site", () => {
    // Call-site redaction is the version that gets forgotten; logs are durable
    // and get pasted into issues.
    expect(redactSecrets("key=sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa")).toContain("[REDACTED");
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toContain("[REDACTED:aws-key");
    expect(redactSecrets('{"password": "hunter2"}')).toContain("[REDACTED:credential-field]");
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecrets("node n2 wrote src/mw/rateLimit.ts")).toBe(
      "node n2 wrote src/mw/rateLimit.ts",
    );
  });

  it("redacts through the logger, including structured fields", () => {
    const lines: string[] = [];
    const logger = new Logger("test", {
      level: "debug",
      json: true,
      sink: (l) => lines.push(l),
    });
    logger.info("calling provider", { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" });
    expect(lines[0]).toContain("[REDACTED:bearer]");
    expect(lines[0]).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("honours the level threshold", () => {
    const lines: string[] = [];
    const logger = new Logger("test", { level: "warn", sink: (l) => lines.push(l) });
    logger.debug("noise");
    logger.info("noise");
    logger.error("real");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("real");
  });
});
