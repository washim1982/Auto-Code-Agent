import type { Db } from "../db/client.ts";
import type { EventLog } from "../events/log.ts";
import { canonicalSort, resourcesIntersect } from "./resource.ts";

export interface LockRequest {
  runId: string;
  nodeId: string;
  write: readonly string[];
  read: readonly string[];
}

export type LockOutcome =
  | { ok: true; acquired: string[] }
  | { ok: false; blockedOn: { resource: string; heldBy: string } };

/**
 * Deadlock-free lock manager (flow review F3).
 *
 * The original flow added `happens-before` edges at runtime in *discovery
 * order*, which can form a cycle: A finds a conflict with B and is ordered
 * after B; later B finds a conflict with A and is ordered after A. The ready
 * queue then never produces a node, and nothing in that flow notices.
 *
 * The fix is not cycle detection — it is removing the possibility. A node
 * acquires its entire set in canonical resource order, all-or-nothing. Since
 * every node walks the same total order, hold-and-wait cannot cycle.
 */
export class LockManager {
  private db: Db;
  private events: EventLog;

  constructor(db: Db, events: EventLog) {
    this.db = db;
    this.events = events;
  }

  /**
   * All-or-nothing acquisition in canonical order.
   *
   * On conflict we release everything already taken and report the blocker,
   * so the caller requeues rather than holding a partial set — partial holds
   * are exactly what re-introduces hold-and-wait.
   */
  acquire(req: LockRequest): LockOutcome {
    const writes = canonicalSort(req.write);
    const reads = canonicalSort(req.read);

    return this.db.tx(() => {
      const taken: string[] = [];

      const rollback = () => {
        for (const r of taken) {
          this.db.run("DELETE FROM locks WHERE resource = ?", r);
        }
      };

      // Writes first: exclusive, and they are what conflicts hardest.
      for (const resource of writes) {
        const holder = this.findConflict(resource, req.nodeId);
        if (holder) {
          rollback();
          this.events.append(
            req.runId,
            "lock.contended",
            { resource, heldBy: holder.nodeId, mode: "write" },
            req.nodeId,
          );
          return { ok: false, blockedOn: { resource, heldBy: holder.nodeId } };
        }
        this.db.run(
          "INSERT OR REPLACE INTO locks (resource, run_id, node_id, mode, acquired_at, parked) VALUES (?, ?, ?, 'write', ?, 0)",
          resource,
          req.runId,
          req.nodeId,
          Date.now(),
        );
        taken.push(resource);
      }

      // Reads only conflict with writes held by *other* nodes.
      for (const resource of reads) {
        const holder = this.findConflict(resource, req.nodeId, "write");
        if (holder) {
          rollback();
          this.events.append(
            req.runId,
            "lock.contended",
            { resource, heldBy: holder.nodeId, mode: "read" },
            req.nodeId,
          );
          return { ok: false, blockedOn: { resource, heldBy: holder.nodeId } };
        }
      }

      this.events.append(req.runId, "lock.acquired", { resources: taken }, req.nodeId);
      return { ok: true, acquired: taken };
    });
  }

  /**
   * Finds a lock held by a different node that intersects `resource`.
   * `onlyMode` restricts which held modes count as a conflict.
   */
  private findConflict(
    resource: string,
    selfNodeId: string,
    onlyMode?: "write" | "read",
  ): { resource: string; nodeId: string } | null {
    const rows = this.db.all("SELECT resource, node_id, mode FROM locks");
    for (const row of rows) {
      const held = String(row["resource"]);
      const nodeId = String(row["node_id"]);
      const mode = String(row["mode"]);
      if (nodeId === selfNodeId) continue;
      if (onlyMode && mode !== onlyMode) continue;
      if (resourcesIntersect(held, resource)) return { resource: held, nodeId };
    }
    return null;
  }

  release(runId: string, nodeId: string): string[] {
    const rows = this.db.all(
      "SELECT resource FROM locks WHERE run_id = ? AND node_id = ? AND parked = 0",
      runId,
      nodeId,
    );
    const resources = rows.map((r) => String(r["resource"]));
    if (resources.length === 0) return [];
    this.db.run(
      "DELETE FROM locks WHERE run_id = ? AND node_id = ? AND parked = 0",
      runId,
      nodeId,
    );
    this.events.append(runId, "lock.released", { resources }, nodeId);
    return resources;
  }

  /**
   * Parks a node's locks instead of releasing them (flow review F5).
   *
   * The original flow said "park node, release locks". That is unsafe: while
   * the human deliberates, a sibling can mutate the resource, and when the node
   * resumes its checkpoint no longer describes the filesystem — its rollback
   * point is a lie. We retain the locks and mark them parked so the scheduler
   * can surface starvation instead.
   */
  park(runId: string, nodeId: string): string[] {
    const rows = this.db.all(
      "SELECT resource FROM locks WHERE run_id = ? AND node_id = ?",
      runId,
      nodeId,
    );
    this.db.run("UPDATE locks SET parked = 1 WHERE run_id = ? AND node_id = ?", runId, nodeId);
    const resources = rows.map((r) => String(r["resource"]));
    this.events.append(runId, "node.parked", { resources, locksRetained: true }, nodeId);
    return resources;
  }

  unpark(runId: string, nodeId: string): void {
    this.db.run("UPDATE locks SET parked = 0 WHERE run_id = ? AND node_id = ?", runId, nodeId);
  }

  /** Force-releases parked locks — only when the operator cancels the node. */
  forceRelease(runId: string, nodeId: string): void {
    this.db.run("DELETE FROM locks WHERE run_id = ? AND node_id = ?", runId, nodeId);
    this.events.append(runId, "lock.released", { forced: true }, nodeId);
  }

  held(runId: string): { resource: string; nodeId: string; parked: boolean }[] {
    return this.db
      .all("SELECT resource, node_id, parked FROM locks WHERE run_id = ?", runId)
      .map((r) => ({
        resource: String(r["resource"]),
        nodeId: String(r["node_id"]),
        parked: Number(r["parked"]) === 1,
      }));
  }
}
