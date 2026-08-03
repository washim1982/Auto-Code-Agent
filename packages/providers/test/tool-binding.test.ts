import { afterEach, describe, expect, it } from "vitest";
import type { ChatChunk, ChatMessage } from "@aca/protocol";
import { OllamaProvider } from "../src/ollama.ts";
import { OpenAiCompatProvider } from "../src/openai-compat.ts";
import { AnthropicProvider } from "../src/anthropic.ts";
import { flattenForPrompt } from "../src/shim.ts";

/**
 * A tool result is only meaningful if the assistant turn that requested it says
 * so. Every provider binds the pair differently and all of them silently ignore
 * an unbound result, which reads to the model as "the tool was never called" —
 * so it calls again, every round, until the step budget is gone.
 */
const CONVERSATION: ChatMessage[] = [
  { role: "user", content: "what is in the repo?" },
  {
    role: "assistant",
    content: "Let me look.",
    toolCalls: [{ id: "call_1", name: "list_dir", args: { path: "." } }],
  },
  { role: "tool", content: "README.md\nsrc/", toolCallId: "call_1", name: "list_dir" },
];

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

/** Captures the outgoing request body and answers with an empty stream. */
function captureBody(): { body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    captured = JSON.parse(init.body) as Record<string, unknown>;
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
    };
  }) as unknown as typeof fetch;
  return { body: () => captured };
}

async function drain(stream: AsyncIterable<ChatChunk>): Promise<void> {
  for await (const _ of stream) void _;
}

describe("tool call / result binding", () => {
  it("openai-compat puts tool_calls on the assistant turn", async () => {
    const cap = captureBody();
    const provider = new OpenAiCompatProvider({ id: "lmstudio", baseUrl: "http://x/v1" });
    await drain(provider.chat({ model: "m", messages: CONVERSATION }));

    const messages = cap.body()["messages"] as Record<string, unknown>[];
    const assistant = messages[1]!;
    const calls = assistant["tool_calls"] as { id: string; function: { name: string } }[];

    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("call_1");
    expect(calls[0]!.function.name).toBe("list_dir");
    // The result must reference exactly that id, or the server drops it.
    expect(messages[2]!["tool_call_id"]).toBe("call_1");
  });

  it("ollama carries the call and names the result", async () => {
    const cap = captureBody();
    const provider = new OllamaProvider("ollama", "http://x");
    await drain(provider.chat({ model: "m", messages: CONVERSATION }));

    const messages = cap.body()["messages"] as Record<string, unknown>[];
    const calls = messages[1]!["tool_calls"] as { function: { name: string } }[];

    expect(calls[0]!.function.name).toBe("list_dir");
    // Ollama matches a result to its call by name, not by id.
    expect(messages[2]!["tool_name"]).toBe("list_dir");
  });

  it("anthropic emits tool_use before tool_result", async () => {
    const cap = captureBody();
    const provider = new AnthropicProvider({ apiKey: "key" });
    await drain(provider.chat({ model: "m", messages: CONVERSATION }));

    const messages = cap.body()["messages"] as { role: string; content: unknown }[];
    const blocks = messages[1]!.content as { type: string; id?: string; name?: string }[];

    expect(blocks.map((b) => b.type)).toEqual(["text", "tool_use"]);
    expect(blocks[1]!.id).toBe("call_1");
    // A tool_result whose id was never introduced is a hard 400, not a warning.
    const result = messages[2]!.content as { tool_use_id: string }[];
    expect(result[0]!.tool_use_id).toBe("call_1");
  });

  it("anthropic omits the text block when the turn was only a call", async () => {
    const cap = captureBody();
    const provider = new AnthropicProvider({ apiKey: "key" });
    await drain(
      provider.chat({
        model: "m",
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "c", name: "list_dir", args: {} }],
          },
          { role: "tool", content: "ok", toolCallId: "c", name: "list_dir" },
        ],
      }),
    );

    const messages = cap.body()["messages"] as { content: { type: string }[] }[];
    // An empty text block is itself rejected.
    expect(messages[1]!.content.map((b) => b.type)).toEqual(["tool_use"]);
  });
});

describe("shim flattening", () => {
  it("renders calls and results as prose a shimmed model can read", () => {
    const assistant = flattenForPrompt(CONVERSATION[1]!);
    expect(assistant.content).toContain("<tool_call>");
    expect(assistant.content).toContain("list_dir");
    expect(assistant.toolCalls).toBeUndefined();

    // A shimmed model has no `tool` role at all.
    const result = flattenForPrompt(CONVERSATION[2]!);
    expect(result.role).toBe("user");
    expect(result.content).toContain("README.md");
  });
});
