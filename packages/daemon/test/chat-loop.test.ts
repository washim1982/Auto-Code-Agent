import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Db, PersonaRegistry } from "@aca/core";
import { ToolRegistry } from "@aca/tools";
import type { ChatChunk, ChatRequest } from "@aca/protocol";
import type { WorkspaceServices } from "@aca/cli";
import { SessionManager } from "../src/sessions.ts";
import type { RpcNotification } from "../src/rpc.ts";

/**
 * A model that never stops asking for tools.
 *
 * This is not a contrived case — it is what a mid-sized local model does when
 * it cannot see its own tool results, and it is exactly what the desktop app
 * showed: eight identical `list_dir` calls and no answer.
 */
function loopingProvider(onRequest?: (req: ChatRequest) => void): {
  id: string;
  calls: number;
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
} {
  const provider = {
    id: "fake",
    calls: 0,
    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      provider.calls++;
      onRequest?.(req);

      // Without tools offered it can only answer — which is how the loop is
      // broken once the step budget runs out.
      if (!req.tools?.length) {
        yield { type: "text", delta: "Here is what I found: README.md" };
        yield { type: "done", stopReason: "stop" };
        return;
      }

      yield { type: "thinking", delta: "I should list the files. " };
      yield {
        type: "tool_call",
        call: { id: `c${provider.calls}`, name: "list_dir", args: { path: "." } },
      };
      yield { type: "done", stopReason: "tool_calls" };
    },
  };
  return provider;
}

function fakeServices(provider: ReturnType<typeof loopingProvider>): {
  services: WorkspaceServices;
  toolRuns: () => number;
} {
  const db = new Db(":memory:");
  const tools = new ToolRegistry();
  let runs = 0;

  tools.register({
    name: "list_dir",
    description: "List a directory",
    schema: z.object({ path: z.string() }),
    purity: "pure",
    tier: "t0",
    async run() {
      runs++;
      return { content: "README.md\nsrc/" };
    },
  });

  const services = {
    root: process.cwd(),
    db,
    tools,
    personas: new PersonaRegistry(),
    guard: { guard: async (raw: string) => ({ text: raw }) },
    config: { router: { privacy: "prefer-local" } },
    router: {
      pinnedModel: "fake-model",
      async catalogue() {
        return [{ id: "fake-model", provider: "fake" }];
      },
      provider: () => provider,
    },
  } as unknown as WorkspaceServices;

  return { services, toolRuns: () => runs };
}

describe("chat tool loop", () => {
  it("always settles with an assistant turn, even when the model never stops calling tools", async () => {
    const provider = loopingProvider();
    const { services } = fakeServices(provider);
    const sessions = new SessionManager();
    const sent: RpcNotification[] = [];

    const result = await sessions.chat(services, "t1", "review the project", (n) =>
      sent.push(n),
    );

    // The symptom in the desktop app was the absence of this: the client only
    // ever clears its streaming bubble on `chat.turn`, so without a terminal
    // one the UI streams forever and no answer appears.
    const turns = sent.filter(
      (n) => n.method === "chat.turn" && n.params?.["role"] === "assistant",
    );
    expect(turns.length).toBeGreaterThan(0);

    const last = turns.at(-1)!;
    expect(String(last.params?.["content"] ?? "")).not.toBe("");
    expect(result.text).not.toBe("");
  });

  it("refuses to re-run an identical call and tells the model it already has the result", async () => {
    const provider = loopingProvider();
    const { services, toolRuns } = fakeServices(provider);
    const sessions = new SessionManager();

    await sessions.chat(services, "t2", "review the project", () => {});

    // Six rounds of the same call, executed once.
    expect(toolRuns()).toBe(1);
  });

  it("gives the model back its own calls bound to their results", async () => {
    const seen: ChatRequest[] = [];
    const provider = loopingProvider((req) => seen.push(structuredClone(req)));
    const { services } = fakeServices(provider);
    const sessions = new SessionManager();

    await sessions.chat(services, "t3", "review the project", () => {});

    // The second request is the first one that could carry history.
    const second = seen[1]!;
    const assistant = second.messages.find((m) => m.role === "assistant");
    const toolMessage = second.messages.find((m) => m.role === "tool");

    expect(assistant?.toolCalls?.[0]?.name).toBe("list_dir");
    // Bound by id — this link is what stops the model repeating itself.
    expect(toolMessage?.toolCallId).toBe(assistant?.toolCalls?.[0]?.id);
    expect(toolMessage?.content).toContain("README.md");
  });

  it("persists tool activity so the next turn still has the context", async () => {
    const provider = loopingProvider();
    const { services } = fakeServices(provider);
    const sessions = new SessionManager();

    await sessions.chat(services, "t4", "review the project", () => {});

    const rows = services.db.all("SELECT role FROM thread_messages WHERE thread_id = ?", "t4");
    // A thread holding only the user's question is why the context panel read
    // 272 tokens after seventeen turns of work.
    expect(rows.some((r) => r["role"] === "tool")).toBe(true);
    expect(rows.some((r) => r["role"] === "assistant")).toBe(true);
  });
});
