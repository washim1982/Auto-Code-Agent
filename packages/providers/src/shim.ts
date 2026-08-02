import type { ChatChunk, ChatMessage, ChatRequest, ModelDescriptor } from "@aca/protocol";
import type { ModelProvider } from "./types.ts";
import { tryParse } from "./structured.ts";

const CALL_OPEN = "<tool_call>";
const CALL_CLOSE = "</tool_call>";

/**
 * Drives tool use through prompting for models that cannot do it natively.
 *
 * Without this, `tools: "none"` and `tools: "shim"` models are dead entries in
 * the catalogue — which on a local-first setup means throwing away the small
 * fast models that are exactly right for classification and summarisation.
 *
 * The protocol is deliberately dumb: describe the tools in the system prompt,
 * ask for a single fenced JSON object, and parse it out. Dumb survives contact
 * with a 1B model; anything cleverer does not.
 *
 * Core cannot tell the difference — it receives `tool_call` chunks either way.
 */
export class ToolCallShim {
  private inner: ModelProvider;

  constructor(inner: ModelProvider) {
    this.inner = inner;
  }

  get id(): string {
    return this.inner.id;
  }

  /** Wraps a chat stream, translating fenced JSON into tool_call chunks. */
  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    if (!req.tools?.length) {
      yield* this.inner.chat(req, signal);
      return;
    }

    const messages: ChatMessage[] = [
      { role: "system", content: renderToolPrompt(req.tools) },
      ...req.messages,
    ];

    // Buffer text so a call can be recognised only once complete; emitting a
    // half-written JSON envelope as prose would be worse than a short delay.
    let buffer = "";
    let emittedCall = false;

    for await (const chunk of this.inner.chat({ ...req, tools: undefined, messages }, signal)) {
      if (chunk.type === "text") {
        buffer += chunk.delta;
        continue;
      }
      if (chunk.type === "done") {
        const parsed = extractCall(buffer);
        if (parsed) {
          emittedCall = true;
          yield {
            type: "tool_call",
            call: {
              id: `${parsed.name}-${Math.random().toString(36).slice(2, 8)}`,
              name: parsed.name,
              args: parsed.args,
            },
          };
        } else if (buffer.trim()) {
          yield { type: "text", delta: buffer };
        }
        yield { type: "done", stopReason: emittedCall ? "tool_calls" : chunk.stopReason };
        continue;
      }
      yield chunk;
    }
  }
}

export function renderToolPrompt(
  tools: { name: string; description: string; schema: unknown }[],
): string {
  return [
    "You can call ONE tool per reply.",
    "",
    "To call a tool, reply with exactly this and nothing else:",
    `${CALL_OPEN}{"name": "<tool name>", "arguments": {…}}${CALL_CLOSE}`,
    "",
    "No prose before or after the tags. If no tool is needed, answer normally.",
    "",
    "Available tools:",
    ...tools.map(
      (t) => `- ${t.name}: ${t.description}\n  arguments: ${JSON.stringify(t.schema)}`,
    ),
  ].join("\n");
}

/**
 * Pulls a tool call out of a model's reply.
 *
 * Accepts the tagged form first, then falls back to a bare JSON object with a
 * `name` field — models drop the tags constantly, and refusing the call for
 * that reason would make the shim useless.
 */
export function extractCall(
  text: string,
): { name: string; args: Record<string, unknown> } | null {
  const tagged = new RegExp(`${CALL_OPEN}([\\s\\S]*?)${CALL_CLOSE}`).exec(text);
  const candidates = [tagged?.[1], text];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = tryParse(candidate);
    if (!parsed.ok) continue;
    const obj = parsed.value as Record<string, unknown>;
    const name = obj["name"] ?? obj["tool"];
    if (typeof name !== "string") continue;
    const rawArgs = obj["arguments"] ?? obj["args"] ?? obj["parameters"] ?? {};
    return {
      name,
      args: rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {},
    };
  }
  return null;
}

/** Wraps a provider when the model's measured tool support needs it. */
export function withShimIfNeeded(
  provider: ModelProvider,
  descriptor: ModelDescriptor,
): ModelProvider {
  if (descriptor.caps.tools === "native") return provider;
  const shim = new ToolCallShim(provider);
  return {
    ...provider,
    chat: (req, signal) => shim.chat(req, signal),
  } as ModelProvider;
}
