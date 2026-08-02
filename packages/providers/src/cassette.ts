import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatChunk, ChatRequest, ModelDescriptor } from "@aca/protocol";
import type { Health, ModelProvider } from "./types.ts";

interface Recording {
  key: string;
  request: { model: string; messages: unknown; tools?: unknown };
  chunks: ChatChunk[];
}

export type CassetteMode = "record" | "replay" | "auto";

/**
 * Record/replay provider.
 *
 * Agent behaviour is otherwise untestable in CI: a real model is slow,
 * non-deterministic, and unavailable on a build machine. Recording real
 * exchanges once and replaying them turns the whole pipeline — routing, tool
 * loops, gates, review, recovery — into something that runs offline in
 * milliseconds and fails loudly when behaviour changes.
 *
 * `auto` records on a miss and replays on a hit, which is what makes adding a
 * test cheap: write it against a live model, and it becomes deterministic from
 * the second run onward.
 */
export class CassetteProvider implements ModelProvider {
  readonly id: string;
  readonly kind = "openai-compat" as const;
  readonly privacyTier = "local" as const;
  readonly baseUrl = "cassette://";

  private inner: ModelProvider | null;
  private dir: string;
  private mode: CassetteMode;
  private descriptors: ModelDescriptor[];

  constructor(options: {
    dir: string;
    mode?: CassetteMode;
    inner?: ModelProvider;
    id?: string;
    descriptors?: ModelDescriptor[];
  }) {
    this.dir = options.dir;
    this.mode = options.mode ?? "replay";
    this.inner = options.inner ?? null;
    this.id = options.id ?? "cassette";
    this.descriptors = options.descriptors ?? [];
    mkdirSync(this.dir, { recursive: true });
  }

  async health(): Promise<Health> {
    return { up: true, latencyMs: 0 };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (this.descriptors.length > 0) {
      return this.descriptors.map((d) => ({ ...d, provider: this.id }));
    }
    return this.inner ? await this.inner.listModels() : [];
  }

  /**
   * Keys on the semantic content of the request, not its serialisation.
   *
   * Message order and content matter; a changed tool description or a
   * reordered key does not. Without that normalisation every cassette misses
   * after any unrelated refactor, and the suite silently starts hitting the
   * network again.
   */
  private key(req: ChatRequest): string {
    const canonical = JSON.stringify({
      model: req.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      tools: (req.tools ?? []).map((t) => t.name).sort(),
      schema: req.responseSchema ? true : false,
    });
    return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
  }

  private path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const key = this.key(req);
    const file = this.path(key);

    if (existsSync(file) && this.mode !== "record") {
      const recording = JSON.parse(readFileSync(file, "utf8")) as Recording;
      for (const chunk of recording.chunks) yield chunk;
      return;
    }

    if (!this.inner) {
      throw new Error(
        `cassette miss for ${key} and no live provider to record from. ` +
          `Re-run with a real provider and mode "auto" to record it.`,
      );
    }

    const chunks: ChatChunk[] = [];
    for await (const chunk of this.inner.chat(req, signal)) {
      chunks.push(chunk);
      yield chunk;
    }

    const recording: Recording = {
      key,
      request: {
        model: req.model,
        messages: req.messages.map((m) => ({
          role: m.role,
          content: m.content.slice(0, 4000),
        })),
        ...(req.tools ? { tools: req.tools.map((t) => t.name) } : {}),
      },
      chunks,
    };
    writeFileSync(file, JSON.stringify(recording, null, 2), "utf8");
  }

  has(req: ChatRequest): boolean {
    return existsSync(this.path(this.key(req)));
  }
}

/** Builds a fixed chunk sequence, for tests that need no recording at all. */
export function scriptedChunks(options: {
  text?: string;
  thinking?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  inputTokens?: number;
  outputTokens?: number;
}): ChatChunk[] {
  const chunks: ChatChunk[] = [];
  if (options.thinking) chunks.push({ type: "thinking", delta: options.thinking });
  if (options.text) chunks.push({ type: "text", delta: options.text });
  for (const call of options.toolCalls ?? []) {
    chunks.push({
      type: "tool_call",
      call: { id: `${call.name}-scripted`, name: call.name, args: call.args },
    });
  }
  chunks.push({
    type: "usage",
    inputTokens: options.inputTokens ?? 100,
    outputTokens: options.outputTokens ?? 20,
    costUsd: 0,
  });
  chunks.push({ type: "done", stopReason: "stop" });
  return chunks;
}

/** A provider that returns the same scripted chunks for every request. */
export function scriptedProvider(
  chunks: ChatChunk[],
  descriptor?: Partial<ModelDescriptor>,
): ModelProvider {
  return {
    id: descriptor?.provider ?? "scripted",
    kind: "openai-compat",
    privacyTier: "local",
    baseUrl: "scripted://",
    async health() {
      return { up: true, latencyMs: 0 };
    },
    async listModels() {
      return [
        {
          provider: descriptor?.provider ?? "scripted",
          kind: "openai-compat",
          id: descriptor?.id ?? "scripted-model",
          state: "resident",
          sizeBytes: 8_000_000_000,
          quantization: "",
          caps: {
            contextWindow: 32_768,
            maxOutputTokens: 4096,
            tools: "native",
            structured: "json_schema",
            vision: false,
            thinking: false,
            streaming: true,
            concurrency: 1,
            costPer1kIn: 0,
            costPer1kOut: 0,
            privacyTier: "local",
            ...descriptor?.caps,
          },
        },
      ];
    },
    async *chat() {
      for (const c of chunks) yield c;
    },
  };
}
