import type { ChatChunk, ChatRequest, ModelCapabilities, ModelDescriptor } from "@aca/protocol";
import { fetchJson, lineStream, type Health, type ModelProvider } from "./types.ts";

interface OllamaTag {
  name: string;
  size: number;
  details?: { parameter_size?: string; quantization_level?: string; context_length?: number };
  capabilities?: string[];
}

/**
 * Ollama adapter.
 *
 * Uses the native `/api/chat` rather than the OpenAI-compatible shim because
 * the native surface exposes three things we need and `/v1` does not:
 * `format` (a full JSON Schema for constrained decoding), `think`, and
 * `keep_alive` — which is our only lever for evicting a model from VRAM.
 * `/api/ps` is likewise the only honest source of what is currently resident.
 */
export class OllamaProvider implements ModelProvider {
  readonly kind = "ollama" as const;
  readonly privacyTier = "local" as const;

  readonly id: string;
  readonly baseUrl: string;

  constructor(id = "ollama", baseUrl = "http://127.0.0.1:11434") {
    this.id = id;
    this.baseUrl = baseUrl;
  }

  async health(): Promise<Health> {
    const started = Date.now();
    try {
      await fetchJson(`${this.baseUrl}/api/tags`, { timeoutMs: 3000 });
      return { up: true, latencyMs: Date.now() - started };
    } catch (err) {
      return { up: false, latencyMs: Date.now() - started, detail: (err as Error).message };
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const data = await fetchJson<{ models: OllamaTag[] }>(`${this.baseUrl}/api/tags`);
    const resident = new Set(await this.residency.resident());

    return (data.models ?? []).map((m) => {
      const caps = m.capabilities ?? [];
      const capabilities: ModelCapabilities = {
        contextWindow: m.details?.context_length ?? 8192,
        maxOutputTokens: 8192,
        tools: caps.includes("tools") ? "native" : "shim",
        // Ollama accepts a full JSON Schema in `format`, not just "json".
        structured: "json_schema",
        vision: caps.includes("vision"),
        thinking: caps.includes("thinking"),
        streaming: true,
        concurrency: 2,
        costPer1kIn: 0,
        costPer1kOut: 0,
        privacyTier: "local",
      };
      return {
        provider: this.id,
        kind: this.kind,
        id: m.name,
        state: resident.has(m.name) ? ("resident" as const) : ("cold" as const),
        sizeBytes: m.size ?? 0,
        quantization: m.details?.quantization_level ?? "",
        caps: capabilities,
      };
    });
  }

  readonly residency = {
    resident: async (): Promise<string[]> => {
      try {
        const data = await fetchJson<{ models?: { name: string }[] }>(
          `${this.baseUrl}/api/ps`,
          { timeoutMs: 3000 },
        );
        return (data.models ?? []).map((m) => m.name);
      } catch {
        return [];
      }
    },
    load: async (model: string): Promise<void> => {
      await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [], keep_alive: "10m" }),
      });
    },
    unload: async (model: string): Promise<void> => {
      // keep_alive: 0 is the eviction lever — there is no explicit unload API.
      await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [], keep_alive: 0 }),
      });
    },
  };

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      options: {
        ...(req.temperature != null ? { temperature: req.temperature } : {}),
        ...(req.numCtx ? { num_ctx: req.numCtx } : {}),
        ...(req.maxTokens ? { num_predict: req.maxTokens } : {}),
      },
    };
    if (req.think) body["think"] = true;
    if (req.responseSchema) body["format"] = req.responseSchema;
    if (req.tools?.length) {
      body["tools"] = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.schema },
      }));
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`ollama chat failed: ${res.status} ${res.statusText}`);
    }

    let inputTokens = 0;
    let outputTokens = 0;

    for await (const line of lineStream(res.body)) {
      let frame: {
        message?: { content?: string; thinking?: string; tool_calls?: unknown[] };
        done?: boolean;
        done_reason?: string;
        prompt_eval_count?: number;
        eval_count?: number;
      };
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }

      const msg = frame.message;
      if (msg?.thinking) yield { type: "thinking", delta: msg.thinking };
      if (msg?.content) yield { type: "text", delta: msg.content };

      for (const raw of msg?.tool_calls ?? []) {
        const tc = raw as { function?: { name?: string; arguments?: unknown } };
        if (!tc.function?.name) continue;
        yield {
          type: "tool_call",
          call: {
            id: `${tc.function.name}-${Math.random().toString(36).slice(2, 8)}`,
            name: tc.function.name,
            args: normaliseArgs(tc.function.arguments),
          },
        };
      }

      if (frame.done) {
        inputTokens = frame.prompt_eval_count ?? 0;
        outputTokens = frame.eval_count ?? 0;
        yield { type: "usage", inputTokens, outputTokens, costUsd: 0 };
        yield { type: "done", stopReason: frame.done_reason ?? "stop" };
      }
    }
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    const data = await fetchJson<{ embeddings: number[][] }>(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
      timeoutMs: 60_000,
    });
    return data.embeddings ?? [];
  }
}

/** Ollama sends tool arguments as an object; other backends send a JSON string. */
export function normaliseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}
