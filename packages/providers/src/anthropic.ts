import type { ChatChunk, ChatRequest, ModelCapabilities, ModelDescriptor } from "@aca/protocol";
import { sseStream, type Health, type ModelProvider } from "./types.ts";

interface AnthropicOptions {
  id?: string;
  apiKey: string;
  baseUrl?: string;
}

/**
 * Known Claude models. Hard-coded because the Messages API has no list
 * endpoint, and guessing capabilities from a name is exactly the string
 * matching the router is built to avoid.
 */
const MODELS: Record<string, Partial<ModelCapabilities>> = {
  "claude-opus-4-20250514": {
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    costPer1kIn: 0.015,
    costPer1kOut: 0.075,
    thinking: true,
    vision: true,
  },
  "claude-sonnet-4-20250514": {
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    costPer1kIn: 0.003,
    costPer1kOut: 0.015,
    thinking: true,
    vision: true,
  },
  "claude-haiku-4-5-20251001": {
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    costPer1kIn: 0.001,
    costPer1kOut: 0.005,
    vision: true,
  },
};

/**
 * Anthropic Messages API.
 *
 * Separate from the OpenAI-compatible adapter because the wire format differs
 * in ways that matter: content blocks rather than a string, `input_json_delta`
 * for streamed tool arguments, and `cache_control` — which is worth the whole
 * adapter on its own. A run's system prompt, persona and workspace map are
 * identical across every node, so marking that prefix cacheable turns the
 * dominant token cost into a rounding error.
 */
export class AnthropicProvider implements ModelProvider {
  readonly kind = "anthropic" as const;
  readonly privacyTier = "cloud" as const;
  readonly id: string;
  readonly baseUrl: string;
  private apiKey: string;

  constructor(options: AnthropicOptions) {
    this.id = options.id ?? "anthropic";
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com/v1";
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  async health(): Promise<Health> {
    const started = Date.now();
    try {
      // No cheap ping endpoint; a 1-token call is the honest probe.
      const res = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      return {
        up: res.ok,
        latencyMs: Date.now() - started,
        detail: res.ok ? "" : `${res.status}`,
      };
    } catch (err) {
      return { up: false, latencyMs: Date.now() - started, detail: (err as Error).message };
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return Object.entries(MODELS).map(([id, caps]) => ({
      provider: this.id,
      kind: this.kind,
      id,
      state: "resident" as const, // hosted; there is no cold start to price in
      sizeBytes: 0,
      quantization: "",
      caps: {
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        tools: "native" as const,
        structured: "json_schema" as const,
        vision: false,
        thinking: false,
        streaming: true,
        concurrency: 8,
        costPer1kIn: 0,
        costPer1kOut: 0,
        privacyTier: "cloud" as const,
        ...caps,
      },
    }));
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content);
    const rest = req.messages.filter((m) => m.role !== "system");

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      stream: true,
      messages: rest.map((m) => ({
        role: m.role === "tool" ? "user" : m.role,
        content:
          m.role === "tool"
            ? [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content }]
            : m.content,
      })),
    };

    if (system.length > 0) {
      // The stable prefix is identical across every node in a run, so caching
      // it is the single largest cost lever available on this provider.
      body["system"] = [
        { type: "text", text: system.join("\n\n"), cache_control: { type: "ephemeral" } },
      ];
    }
    if (req.temperature != null) body["temperature"] = req.temperature;
    if (req.tools?.length) {
      body["tools"] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
      }));
    }

    const res = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`anthropic chat failed: ${res.status} ${detail.slice(0, 200)}`);
    }

    const caps = (await this.listModels()).find((m) => m.id === req.model)?.caps;
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = "stop";
    const pending = new Map<number, { id: string; name: string; json: string }>();

    for await (const frame of sseStream(res.body)) {
      const f = frame as {
        type?: string;
        index?: number;
        delta?: {
          type?: string;
          text?: string;
          thinking?: string;
          partial_json?: string;
          stop_reason?: string;
        };
        content_block?: { type?: string; id?: string; name?: string };
        message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        usage?: { output_tokens?: number };
      };

      switch (f.type) {
        case "message_start":
          inputTokens = f.message?.usage?.input_tokens ?? 0;
          break;
        case "content_block_start":
          if (f.content_block?.type === "tool_use") {
            pending.set(f.index ?? 0, {
              id: f.content_block.id ?? "",
              name: f.content_block.name ?? "",
              json: "",
            });
          }
          break;
        case "content_block_delta": {
          if (f.delta?.text) yield { type: "text", delta: f.delta.text };
          if (f.delta?.thinking) yield { type: "thinking", delta: f.delta.thinking };
          if (f.delta?.partial_json != null) {
            const slot = pending.get(f.index ?? 0);
            if (slot) slot.json += f.delta.partial_json;
          }
          break;
        }
        case "message_delta":
          outputTokens = f.usage?.output_tokens ?? outputTokens;
          if (f.delta?.stop_reason) stopReason = f.delta.stop_reason;
          break;
        default:
          break;
      }
    }

    for (const slot of pending.values()) {
      if (!slot.name) continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(slot.json || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      yield { type: "tool_call", call: { id: slot.id, name: slot.name, args } };
    }

    yield {
      type: "usage",
      inputTokens,
      outputTokens,
      costUsd:
        (inputTokens / 1000) * (caps?.costPer1kIn ?? 0) +
        (outputTokens / 1000) * (caps?.costPer1kOut ?? 0),
    };
    yield { type: "done", stopReason };
  }
}
