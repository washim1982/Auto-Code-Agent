import type { ChatChunk } from "@aca/protocol";
import { OllamaProvider } from "./ollama.ts";
import { LmStudioProvider } from "./lmstudio.ts";
import { LlamaCppProvider } from "./llamacpp.ts";
import { OpenAiCompatProvider } from "./openai-compat.ts";
import { AnthropicProvider } from "./anthropic.ts";
import type { ModelProvider } from "./types.ts";

export interface DiscoverOptions {
  ollamaHost?: string;
  lmStudioHost?: string;
  llamaCppHost?: string;
  anthropicKey?: string;
  openaiKey?: string;
  /** Drops every cloud provider regardless of configured keys. */
  localOnly?: boolean;
}

/**
 * Builds the provider list, probing local servers and including cloud
 * providers only when a key exists AND local-only mode is off.
 *
 * Health is checked here so an unreachable backend never reaches the router
 * and never shows up as a phantom candidate.
 */
export async function discoverProviders(
  options: DiscoverOptions = {},
): Promise<{ providers: ModelProvider[]; skipped: { id: string; reason: string }[] }> {
  const candidates: ModelProvider[] = [
    new OllamaProvider("ollama", options.ollamaHost ?? "http://127.0.0.1:11434"),
    new LmStudioProvider("lmstudio", options.lmStudioHost ?? "http://127.0.0.1:1234"),
    new LlamaCppProvider("llamacpp", options.llamaCppHost ?? "http://127.0.0.1:8080"),
  ];

  if (!options.localOnly && options.openaiKey) {
    candidates.push(
      new OpenAiCompatProvider({
        id: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: options.openaiKey,
        privacyTier: "cloud",
        defaultCaps: {
          tools: "native",
          structured: "json_schema",
          contextWindow: 128_000,
          concurrency: 8,
          costPer1kIn: 0.0025,
          costPer1kOut: 0.01,
          privacyTier: "cloud",
        },
      }),
    );
  }

  const providers: ModelProvider[] = [];
  const skipped: { id: string; reason: string }[] = [];

  await Promise.all(
    candidates.map(async (p) => {
      const health = await p.health().catch((e: Error) => ({
        up: false,
        latencyMs: 0,
        detail: e.message,
      }));
      if (health.up) providers.push(p);
      else skipped.push({ id: p.id, reason: health.detail ?? "unreachable" });
    }),
  );

  if (options.anthropicKey) {
    if (options.localOnly) {
      skipped.push({ id: "anthropic", reason: "local-only mode" });
    } else {
      const anthropic = new AnthropicProvider({ apiKey: options.anthropicKey });
      const health = await anthropic
        .health()
        .catch(() => ({ up: false, latencyMs: 0, detail: "" }));
      if (health.up) providers.push(anthropic);
      else skipped.push({ id: "anthropic", reason: health.detail || "unreachable" });
    }
  }

  return { providers, skipped };
}

/** Drains a chat stream into its text, thinking, tool calls and usage. */
export async function collectText(stream: AsyncIterable<ChatChunk>): Promise<{
  text: string;
  thinking: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  /**
   * Why generation stopped. `"length"` means the reply was cut off at the token
   * ceiling — which callers parsing JSON must distinguish from a model that
   * simply produced something malformed, because the fixes are opposite.
   */
  stopReason: string;
}> {
  let text = "";
  let thinking = "";
  let stopReason = "";
  const toolCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];
  let usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  for await (const chunk of stream) {
    if (chunk.type === "text") text += chunk.delta;
    else if (chunk.type === "thinking") thinking += chunk.delta;
    else if (chunk.type === "tool_call") toolCalls.push(chunk.call);
    else if (chunk.type === "done") stopReason = chunk.stopReason;
    else if (chunk.type === "usage") {
      usage = {
        inputTokens: chunk.inputTokens,
        outputTokens: chunk.outputTokens,
        costUsd: chunk.costUsd,
      };
    }
  }

  return { text, thinking, toolCalls, usage, stopReason };
}
