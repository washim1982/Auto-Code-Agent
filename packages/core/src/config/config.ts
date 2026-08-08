import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export const AcaConfig = z.object({
  providers: z
    .object({
      ollamaHost: z.string().default("http://127.0.0.1:11434"),
      lmStudioHost: z.string().default("http://127.0.0.1:1234"),
      llamaCppHost: z.string().default("http://127.0.0.1:8080"),
    })
    .default({}),
  router: z
    .object({
      privacy: z.enum(["local-only", "prefer-local", "any"]).default("prefer-local"),
      pinnedModel: z.string().nullable().default(null),
    })
    .default({}),
  budget: z
    .object({
      maxTokens: z.number().default(400_000),
      maxCostUsd: z.number().default(5),
      maxWallMs: z.number().default(30 * 60_000),
    })
    .default({}),
  sandbox: z
    .object({
      defaultTier: z.enum(["t0", "t1", "t2"]).default("t1"),
      timeoutMs: z.number().default(120_000),
      maxOutputBytes: z.number().default(10 * 1024 * 1024),
    })
    .default({}),
  run: z
    .object({
      maxAttempts: z.number().default(2),
      maxReviewRounds: z.number().default(3),
      concurrency: z.number().default(0), // 0 = derive from provider slots
      /**
       * Model round-trips per node. Raised from a hardcoded 12, which a node
       * could spend entirely on research and never reach its writes; a node
       * with more declared writes than this grows past it rather than being
       * truncated. Trades tokens for completion rate — watch the meter.
       */
      maxSteps: z.number().default(24),
      /**
       * Output tokens per round-trip, clamped by the routed model's own
       * `maxOutputTokens`. Was hardcoded at 2000, which truncates a `write_file`
       * call carrying a source file — the node then fails having written
       * nothing.
       */
      maxOutputTokens: z.number().default(8192),
      /**
       * Read-only tool calls a node may make before writing becomes the only
       * available action. A node that has read 30 files and written nothing is
       * not gathering context, it is stalling.
       */
      maxReads: z.number().default(30),
      /**
       * Token ceiling for one node. Without it the run budget is first-come:
       * one node consumed all 400k and its four siblings never started.
       */
      maxNodeTokens: z.number().default(120_000),
      /**
       * Split each node into a read-only gather phase and a write-only apply
       * phase, handing a structured brief between them instead of the whole
       * transcript. Off by default until measured against the single-phase
       * loop on the same goal — see docs/09-loop-redesign.md §5.
       */
      twoPhase: z.boolean().default(false),
    })
    .default({}),
  memory: z
    .object({
      embeddingModel: z.string().default("text-embedding-nomic-embed-text-v1.5"),
      indexOnOpen: z.boolean().default(false),
    })
    .default({}),
});
export type AcaConfig = z.infer<typeof AcaConfig>;

export interface ConfigSource {
  layer: "defaults" | "user" | "workspace" | "env" | "flags";
  path?: string;
}

/**
 * Layered configuration: defaults → user → workspace → env → flags.
 *
 * Later layers win. Workspace config sits above user config specifically so a
 * repo can pin `privacy: local-only` and have that hold regardless of the
 * developer's personal default — the safer setting should be the one a project
 * can enforce, not merely suggest.
 */
export function loadConfig(
  options: {
    workspaceRoot?: string;
    env?: NodeJS.ProcessEnv;
    flags?: Record<string, unknown>;
  } = {},
): { config: AcaConfig; sources: ConfigSource[] } {
  const sources: ConfigSource[] = [{ layer: "defaults" }];
  let merged: Record<string, unknown> = {};

  const userPath = join(homedir(), ".aca", "config.json");
  if (existsSync(userPath)) {
    merged = deepMerge(merged, readJson(userPath));
    sources.push({ layer: "user", path: userPath });
  }

  if (options.workspaceRoot) {
    const wsPath = join(resolve(options.workspaceRoot), ".aca", "config.json");
    if (existsSync(wsPath)) {
      merged = deepMerge(merged, readJson(wsPath));
      sources.push({ layer: "workspace", path: wsPath });
    }
  }

  const env = options.env ?? process.env;
  const fromEnv = envOverrides(env);
  if (Object.keys(fromEnv).length > 0) {
    merged = deepMerge(merged, fromEnv);
    sources.push({ layer: "env" });
  }

  if (options.flags && Object.keys(options.flags).length > 0) {
    merged = deepMerge(merged, options.flags);
    sources.push({ layer: "flags" });
  }

  return { config: AcaConfig.parse(merged), sources };
}

function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = (path: string[], value: unknown): void => {
    let cursor = out;
    for (const key of path.slice(0, -1)) {
      cursor[key] = (cursor[key] as Record<string, unknown>) ?? {};
      cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[path[path.length - 1]!] = value;
  };

  if (env["ACA_OLLAMA_HOST"]) set(["providers", "ollamaHost"], env["ACA_OLLAMA_HOST"]);
  if (env["ACA_LMSTUDIO_HOST"]) set(["providers", "lmStudioHost"], env["ACA_LMSTUDIO_HOST"]);
  if (env["ACA_LLAMACPP_HOST"]) set(["providers", "llamaCppHost"], env["ACA_LLAMACPP_HOST"]);
  if (env["ACA_PRIVACY"]) set(["router", "privacy"], env["ACA_PRIVACY"]);
  if (env["ACA_MODEL"]) set(["router", "pinnedModel"], env["ACA_MODEL"]);
  if (env["ACA_MAX_TOKENS"]) set(["budget", "maxTokens"], Number(env["ACA_MAX_TOKENS"]));
  return out;
}

/**
 * Reads a config file, whatever the editor encoded it as.
 *
 * PowerShell's `>` writes UTF-16LE by default on Windows, so
 * `echo '{...}' > .aca/config.json` produces a file `JSON.parse` cannot read.
 * That is a normal thing for someone to type, and the old version caught the
 * error and returned `{}` — the setting was silently ignored, the run used the
 * defaults, and the person who wrote the file measured the wrong thing without
 * ever being told. A config that is present and unreadable is a mistake worth
 * reporting; only a config that is absent is uneventful.
 */
function readJson(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = decode(readFileSync(path));
  } catch (err) {
    process.stderr.write(`aca: cannot read ${path}: ${(err as Error).message}\n`);
    return {};
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(
      `aca: ignoring ${path} — it is not valid JSON (${(err as Error).message})\n`,
    );
    return {};
  }
}

/** Decodes by byte-order mark, defaulting to UTF-8. */
function decode(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE: Node has no decoder for it, so swap into LE order first.
    return buf.subarray(2).swap16().toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  return buf.toString("utf8");
}

function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(
        (out[k] as Record<string, unknown>) ?? {},
        v as Record<string, unknown>,
      );
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * API keys, kept out of config files.
 *
 * A proper OS keychain binding (`keytar`) needs a native module, which is the
 * install friction this project has otherwise avoided. The honest compromise:
 * read from the environment first, then a mode-0600 file that is never merged
 * into the config object and never logged. What we do NOT do is let a key sit
 * in `config.json` next to the workspace, where it gets committed.
 */
export class SecretStore {
  private file: string;

  constructor(file = join(homedir(), ".aca", "secrets.json")) {
    this.file = file;
  }

  get(name: string): string | undefined {
    const fromEnv = process.env[name];
    if (fromEnv) return fromEnv;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
      return data[name];
    } catch {
      return undefined;
    }
  }

  set(name: string, value: string): void {
    mkdirSync(dirname(this.file), { recursive: true });
    let data: Record<string, string> = {};
    try {
      data = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
    } catch {
      // first write
    }
    data[name] = value;
    writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Windows ignores POSIX modes; the file still sits under the user profile
    }
  }

  /** Names only. Never returns values, so it is safe to render. */
  list(): string[] {
    try {
      return Object.keys(JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>);
    } catch {
      return [];
    }
  }
}
