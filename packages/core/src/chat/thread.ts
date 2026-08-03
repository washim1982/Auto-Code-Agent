import type { ChatMessage, ToolCall } from "@aca/protocol";
import type { Db } from "../db/client.ts";

export interface StoredMessage extends ChatMessage {
  id: string;
  ts: number;
  meta: Record<string, unknown>;
}

/**
 * A persisted conversation.
 *
 * Chat is the default interaction, not a lesser mode bolted beside runs: most
 * of what you do with a coding agent is ask questions and read code. Threads
 * persist so a conversation survives a crash and can be escalated into a run
 * without losing the context that motivated it.
 */
export class ChatThread {
  private db: Db;
  readonly id: string;

  constructor(db: Db, id: string) {
    this.db = db;
    this.id = id;
    const existing = db.get("SELECT id FROM threads WHERE id = ?", id);
    if (!existing) {
      db.run(
        "INSERT INTO threads (id, title, model, created_at) VALUES (?, '', NULL, ?)",
        id,
        Date.now(),
      );
    }
  }

  append(message: ChatMessage, meta: Record<string, unknown> = {}): StoredMessage {
    const stored: StoredMessage = {
      ...message,
      id: `${this.id}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
      ts: Date.now(),
      meta,
    };
    this.db.run(
      "INSERT INTO thread_messages (id, thread_id, role, content, meta, ts) VALUES (?, ?, ?, ?, ?, ?)",
      stored.id,
      this.id,
      stored.role,
      stored.content,
      JSON.stringify(meta),
      stored.ts,
    );
    return stored;
  }

  messages(limit = 200): StoredMessage[] {
    return this.db
      .all(
        "SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY ts LIMIT ?",
        this.id,
        limit,
      )
      .map((r) => ({
        id: String(r["id"]),
        role: String(r["role"]) as ChatMessage["role"],
        content: String(r["content"]),
        ts: Number(r["ts"]),
        meta: JSON.parse(String(r["meta"])) as Record<string, unknown>,
      }));
  }

  setModel(model: string): void {
    this.db.run("UPDATE threads SET model = ? WHERE id = ?", model, this.id);
  }

  model(): string | null {
    const row = this.db.get("SELECT model FROM threads WHERE id = ?", this.id);
    return row?.["model"] == null ? null : String(row["model"]);
  }

  /**
   * Renders the thread as provider-shaped messages.
   *
   * Tool calls are dropped unless their results are also in the thread. A
   * dangling call is rejected outright by Anthropic and silently confuses the
   * OpenAI-compatible servers, so one interrupted turn would otherwise poison
   * every later turn in the conversation.
   */
  toChatMessages(): ChatMessage[] {
    const stored = this.messages();
    const answered = new Set(
      stored
        .filter((m) => m.role === "tool" && m.meta["toolCallId"])
        .map((m) => String(m.meta["toolCallId"])),
    );

    return stored.map((m) => {
      const calls = (m.meta["toolCalls"] as ToolCall[] | undefined)?.filter((c) =>
        answered.has(c.id),
      );
      return {
        role: m.role,
        content: m.content,
        ...(m.meta["toolCallId"] ? { toolCallId: String(m.meta["toolCallId"]) } : {}),
        ...(m.meta["name"] ? { name: String(m.meta["name"]) } : {}),
        ...(calls?.length ? { toolCalls: calls } : {}),
      };
    });
  }
}

export function toolResultMessage(call: ToolCall, guardedContent: string): ChatMessage {
  return {
    role: "tool",
    content: guardedContent,
    toolCallId: call.id,
    name: call.name,
  };
}
