import { describe, expect, it } from "vitest";
import type { ChatChunk, ChatRequest } from "@aca/protocol";
import { extractCall, renderToolPrompt, ToolCallShim } from "../src/shim.ts";
import type { ModelProvider } from "../src/types.ts";

function fakeProvider(reply: string): ModelProvider {
  return {
    id: "fake",
    kind: "ollama",
    privacyTier: "local",
    baseUrl: "http://fake",
    async health() {
      return { up: true, latencyMs: 1 };
    },
    async listModels() {
      return [];
    },
    async *chat(): AsyncIterable<ChatChunk> {
      // Stream it in pieces, as a real provider would.
      for (const piece of reply.match(/.{1,7}/gs) ?? []) {
        yield { type: "text", delta: piece };
      }
      yield { type: "usage", inputTokens: 10, outputTokens: 5, costUsd: 0 };
      yield { type: "done", stopReason: "stop" };
    },
  };
}

const req: ChatRequest = {
  model: "tiny",
  messages: [{ role: "user", content: "read the file" }],
  tools: [
    {
      name: "read_file",
      description: "Read a file",
      schema: { type: "object", properties: { path: { type: "string" } } },
    },
  ],
};

async function drain(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

describe("tool-call extraction", () => {
  it("reads the tagged form", () => {
    const call = extractCall(
      '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>',
    );
    expect(call).toEqual({ name: "read_file", args: { path: "a.ts" } });
  });

  it("accepts a bare object when the model drops the tags", () => {
    // Small models omit the tags constantly; refusing the call for that reason
    // would make the shim useless.
    expect(extractCall('{"name":"read_file","arguments":{"path":"a.ts"}}')).toEqual({
      name: "read_file",
      args: { path: "a.ts" },
    });
  });

  it("tolerates the common argument-key aliases", () => {
    expect(extractCall('{"tool":"grep","args":{"q":"x"}}')?.name).toBe("grep");
    expect(extractCall('{"name":"grep","parameters":{"q":"x"}}')?.args).toEqual({ q: "x" });
  });

  it("digs the call out of surrounding prose", () => {
    const call = extractCall(
      'Sure, I will read it.\n{"name":"read_file","arguments":{"path":"a.ts"}}',
    );
    expect(call?.name).toBe("read_file");
  });

  it("returns null for a plain answer", () => {
    expect(extractCall("The file contains a React component.")).toBeNull();
  });

  it("returns null for JSON with no tool name", () => {
    expect(extractCall('{"result": 42}')).toBeNull();
  });
});

describe("shim streaming", () => {
  it("turns a prompted reply into a real tool_call chunk", async () => {
    const shim = new ToolCallShim(
      fakeProvider('<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>'),
    );
    const chunks = await drain(shim.chat(req));
    const call = chunks.find((c) => c.type === "tool_call");
    expect(call).toBeDefined();
    if (call?.type === "tool_call") {
      expect(call.call.name).toBe("read_file");
      expect(call.call.args).toEqual({ path: "a.ts" });
    }
    // Core cannot tell this apart from native tool calling.
    expect(chunks.at(-1)).toEqual({ type: "done", stopReason: "tool_calls" });
  });

  it("does not leak a half-written envelope as prose", async () => {
    const shim = new ToolCallShim(
      fakeProvider('<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>'),
    );
    const chunks = await drain(shim.chat(req));
    const text = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { delta: string }).delta)
      .join("");
    expect(text).toBe("");
  });

  it("passes ordinary answers through as text", async () => {
    const shim = new ToolCallShim(fakeProvider("It is a React component."));
    const chunks = await drain(shim.chat(req));
    const text = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { delta: string }).delta)
      .join("");
    expect(text).toContain("React component");
    expect(chunks.some((c) => c.type === "tool_call")).toBe(false);
  });

  it("stays out of the way when no tools are declared", async () => {
    const shim = new ToolCallShim(fakeProvider("hello"));
    const chunks = await drain(shim.chat({ model: "tiny", messages: [] }));
    expect(chunks.some((c) => c.type === "text")).toBe(true);
  });

  it("preserves usage accounting through the wrapper", async () => {
    const shim = new ToolCallShim(fakeProvider("plain answer"));
    const chunks = await drain(shim.chat(req));
    expect(chunks.find((c) => c.type === "usage")).toMatchObject({ inputTokens: 10 });
  });
});

describe("tool prompt", () => {
  it("names every tool and inlines its schema", () => {
    const prompt = renderToolPrompt([
      { name: "read_file", description: "Read a file", schema: { type: "object" } },
      { name: "grep", description: "Search", schema: { type: "object" } },
    ]);
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("grep");
    expect(prompt).toContain('"type":"object"');
    expect(prompt).toContain("ONE tool per reply");
  });
});
