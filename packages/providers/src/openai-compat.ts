import type {
  ChatChunk,
  ChatRequest,
  ModelCapabilities,
  ModelDescriptor,
  ProviderKind,
} from "@aca/protocol";
import { fetchJson, sseStream, type Health, type ModelProvider } from "./types.ts";
import { normaliseArgs } from "./ollama.ts";

export interface OpenAiCompatOptions {
  id: string;
  baseUrl: string;
  kind?: ProviderKind;
  apiKey?: string;
  privacyTier?: "local" | "cloud";
  defaultCaps?: Partial<ModelCapabilities>;
  /** Per-model capability overrides, keyed by exact model id. */
  capsByModel?: Record<string, Partial<ModelCapabilities>>;
}

/**
 * One adapter for every OpenAI-compatible `/v1` endpoint.
 *
 * Covers LM Studio, llama.cpp's server, OpenAI, OpenRouter, Groq, DeepSeek and
 * Together. The differences between them are declared as capability data, not
 * as code branches — the router never asks "which vendor is this".
 */
export class OpenAiCompatProvider implements ModelProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly privacyTier: "local" | "cloud";

  private options: OpenAiCompatOptions;

  constructor(options: OpenAiCompatOptions) {
    this.options = options;
    this.id = options.id;
    this.kind = options.kind ?? "openai-compat";
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.privacyTier = options.privacyTier ?? "local";
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
    };
  }

  async health(): Promise<Health> {
    const started = Date.now();
    try {
      await fetchJson(`${this.baseUrl}/models`, { headers: this.headers(), timeoutMs: 4000 });
      return { up: true, latencyMs: Date.now() - started };
    } catch (err) {
      return { up: false, latencyMs: Date.now() - started, detail: (err as Error).message };
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const data = await fetchJson<{ data: { id: string }[] }>(`${this.baseUrl}/models`, {
      headers: this.headers(),
    });
    return (data.data ?? []).map((m) => this.describe(m.id));
  }

  protected describe(modelId: string, state: "resident" | "cold" = "cold"): ModelDescriptor {
    const caps: ModelCapabilities = {
      contextWindow: 8192,
      maxOutputTokens: 4096,
      tools: "native",
      structured: "json_schema",
      vision: false,
      thinking: false,
      streaming: true,
      concurrency: 1,
      costPer1kIn: 0,
      costPer1kOut: 0,
      privacyTier: this.privacyTier,
      ...this.options.defaultCaps,
      ...this.options.capsByModel?.[modelId],
    };
    // An embedding model is not a chat model; saying so here keeps the router
    // from ever shortlisting it for a coding node.
    if (/embed/i.test(modelId)) {
      caps.tools = "none";
      caps.structured = "none";
    }
    return {
      provider: this.id,
      kind: this.kind,
      id: modelId,
      state,
      sizeBytes: 0,
      quantization: "",
      caps,
    };
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.name ? { name: m.name } : {}),
        // A `tool` message is only bindable if the assistant turn before it
        // declared the call. Without this the server drops the result and the
        // model re-issues the same call forever.
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : {}),
      })),
      stream: true,
      stream_options: { include_usage: true },
      ...(req.temperature != null ? { temperature: req.temperature } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    };

    if (req.responseSchema) {
      body["response_format"] = {
        type: "json_schema",
        json_schema: { name: "response", strict: true, schema: req.responseSchema },
      };
    }
    if (req.tools?.length) {
      body["tools"] = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.schema },
      }));
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `${this.id} chat failed: ${res.status} ${res.statusText} ${detail.slice(0, 200)}`,
      );
    }

    // Tool calls arrive as deltas indexed by position and must be reassembled
    // before they mean anything.
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason = "stop";

    for await (const frame of sseStream(res.body)) {
      const f = frame as {
        choices?: {
          delta?: {
            content?: string;
            reasoning_content?: string;
            tool_calls?: {
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
          finish_reason?: string;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const choice = f.choices?.[0];
      const delta = choice?.delta;

      if (delta?.reasoning_content) {
        yield { type: "thinking", delta: delta.reasoning_content };
      }
      if (delta?.content) yield { type: "text", delta: delta.content };

      for (const tc of delta?.tool_calls ?? []) {
        const slot = pending.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        pending.set(tc.index, slot);
      }

      if (choice?.finish_reason) stopReason = choice.finish_reason;
      if (f.usage) {
        usage = {
          inputTokens: f.usage.prompt_tokens ?? 0,
          outputTokens: f.usage.completion_tokens ?? 0,
        };
      }
    }

    for (const slot of pending.values()) {
      if (!slot.name) continue;
      yield {
        type: "tool_call",
        call: {
          id: slot.id || `${slot.name}-${Math.random().toString(36).slice(2, 8)}`,
          name: slot.name,
          args: normaliseArgs(slot.args),
        },
      };
    }

    const caps = this.describe(req.model).caps;
    yield {
      type: "usage",
      ...usage,
      costUsd:
        (usage.inputTokens / 1000) * caps.costPer1kIn +
        (usage.outputTokens / 1000) * caps.costPer1kOut,
    };
    yield { type: "done", stopReason };
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    const data = await fetchJson<{ data: { embedding: number[] }[] }>(
      `${this.baseUrl}/embeddings`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ model, input: texts }),
        timeoutMs: 60_000,
      },
    );
    return (data.data ?? []).map((d) => d.embedding);
  }
}
