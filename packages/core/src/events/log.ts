import { AcaEvent, type EventType } from "@aca/protocol";
import type { Db, Row } from "../db/client.ts";

export type EventListener = (e: AcaEvent) => void;

/**
 * Append-only event log (flow review F18).
 *
 * Nothing mutates an event once written. Run state is derived by folding, so
 * "what happened" and "what is true now" can never drift apart.
 */
export class EventLog {
  private listeners = new Set<EventListener>();

  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  append(
    runId: string,
    type: EventType,
    payload: Record<string, unknown> = {},
    nodeId: string | null = null,
  ): AcaEvent {
    const e = AcaEvent.parse({ runId, nodeId, ts: Date.now(), type, payload });
    this.db.run(
      "INSERT INTO events (run_id, node_id, ts, type, payload) VALUES (?, ?, ?, ?, ?)",
      e.runId,
      e.nodeId,
      e.ts,
      e.type,
      JSON.stringify(e.payload),
    );
    const seq = Number((this.db.get("SELECT last_insert_rowid() AS s") as Row)["s"]);
    const stored: AcaEvent = { ...e, seq };
    for (const l of this.listeners) {
      try {
        l(stored);
      } catch {
        // A listener must never be able to break the write path.
      }
    }
    return stored;
  }

  read(runId: string, fromSeq = 0): AcaEvent[] {
    return this.db
      .all(
        "SELECT seq, run_id, node_id, ts, type, payload FROM events WHERE run_id = ? AND seq > ? ORDER BY seq",
        runId,
        fromSeq,
      )
      .map(rowToEvent);
  }

  readAll(limit = 1000): AcaEvent[] {
    return this.db
      .all("SELECT * FROM events ORDER BY seq DESC LIMIT ?", limit)
      .map(rowToEvent)
      .reverse();
  }

  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  count(runId?: string): number {
    const r = runId
      ? this.db.get("SELECT COUNT(*) AS c FROM events WHERE run_id = ?", runId)
      : this.db.get("SELECT COUNT(*) AS c FROM events");
    return Number(r?.["c"] ?? 0);
  }
}

function rowToEvent(r: Row): AcaEvent {
  return {
    seq: Number(r["seq"]),
    runId: String(r["run_id"]),
    nodeId: r["node_id"] == null ? null : String(r["node_id"]),
    ts: Number(r["ts"]),
    type: String(r["type"]) as EventType,
    payload: JSON.parse(String(r["payload"])) as Record<string, unknown>,
  };
}
