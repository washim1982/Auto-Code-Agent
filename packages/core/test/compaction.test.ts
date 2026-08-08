import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@aca/protocol";
import { compactMessages, messageTokens } from "../src/run/compaction.ts";

const big = (n: number): string => "x".repeat(n);

function conversation(toolResults: number, size = 4000): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "the node contract" },
  ];
  for (let i = 0; i < toolResults; i++) {
    messages.push({ role: "assistant", content: `thinking ${i}` });
    messages.push({
      role: "tool",
      content: big(size),
      toolCallId: `call-${i}`,
      name: "read_file",
    });
  }
  return messages;
}

describe("in-loop compaction", () => {
  it("leaves a small conversation alone", () => {
    const messages = conversation(2, 50);
    const out = compactMessages(messages, { budgetTokens: 10_000 });
    expect(out.elided).toBe(0);
    expect(out.messages).toEqual(messages);
  });

  it("elides old tool results once the budget is passed", () => {
    const out = compactMessages(conversation(20), { budgetTokens: 1000 });
    expect(out.elided).toBeGreaterThan(0);
    expect(out.tokensAfter).toBeLessThan(out.tokensBefore);
  });

  it("never drops a message, only its body", () => {
    // Providers reject a conversation where a tool result does not answer an
    // assistant tool_calls entry, so removing them breaks the request instead
    // of shrinking it.
    const messages = conversation(20);
    const out = compactMessages(messages, { budgetTokens: 1000 });

    expect(out.messages).toHaveLength(messages.length);
    for (const [i, m] of out.messages.entries()) {
      expect(m.role).toBe(messages[i]!.role);
      expect(m.toolCallId).toBe(messages[i]!.toolCallId);
    }
  });

  it("keeps the system prompt and the node contract whatever the pressure", () => {
    const messages = conversation(30);
    const out = compactMessages(messages, { budgetTokens: 1 });
    expect(out.messages[0]!.content).toBe("system prompt");
    expect(out.messages[1]!.content).toBe("the node contract");
  });

  it("keeps recent turns intact — that is the model's working memory", () => {
    const messages = conversation(20);
    const out = compactMessages(messages, { budgetTokens: 1000, keepRecent: 6 });

    const tail = out.messages.slice(-6);
    for (const [i, m] of tail.entries()) {
      expect(m.content).toBe(messages[messages.length - 6 + i]!.content);
    }
  });

  it("never touches the model's own turns, only tool output", () => {
    // Its reasoning is how it knows what it already tried; the tool result is
    // the part it has already extracted what it needs from.
    const messages = conversation(20);
    const out = compactMessages(messages, { budgetTokens: 1000 });

    for (const [i, m] of out.messages.entries()) {
      if (messages[i]!.role !== "tool") expect(m.content).toBe(messages[i]!.content);
    }
  });

  it("tells the model the result is retrievable rather than gone", () => {
    const out = compactMessages(conversation(20), { budgetTokens: 1000 });
    const stub = out.messages.find((m) => m.content.includes("elided"))!;
    expect(stub.content).toMatch(/call read_file again/i);
    expect(stub.content).toMatch(/KB/);
  });

  it("leaves short results alone — they are not the problem", () => {
    const messages = conversation(20, 50);
    const out = compactMessages(messages, { budgetTokens: 1, minElideChars: 400 });
    expect(out.elided).toBe(0);
  });

  it("measurably shrinks a realistic runaway loop", () => {
    // The shape that blew the budget: 40 steps, each carrying a 30 KB read.
    const messages = conversation(40, 30_000);
    const before = messageTokens(messages);
    const out = compactMessages(messages, { budgetTokens: 60_000 });

    expect(before).toBeGreaterThan(200_000);
    expect(out.tokensAfter).toBeLessThan(before * 0.2);
  });
});
