import type { AcaEvent, NodeStatus, RunStatus } from "@aca/protocol";

export interface FoldedNode {
  id: string;
  status: NodeStatus;
  attempts: number;
  reviewRounds: number;
  route: { provider: string; model: string } | null;
  dirtyReason: string | null;
}

export interface FoldedRun {
  runId: string;
  status: RunStatus;
  nodes: Map<string, FoldedNode>;
  locksHeld: Set<string>;
  tokens: number;
  costUsd: number;
  lastSeq: number;
  pendingApprovals: string[];
}

function ensure(state: FoldedRun, id: string | null): FoldedNode | null {
  if (!id) return null;
  let n = state.nodes.get(id);
  if (!n) {
    n = { id, status: "pending", attempts: 0, reviewRounds: 0, route: null, dirtyReason: null };
    state.nodes.set(id, n);
  }
  return n;
}

/**
 * Derives current run state from the event log.
 *
 * This is what makes crash resume, the timeline scrubber, and deterministic
 * replay one mechanism instead of three: replaying to sequence N yields exactly
 * the state the run had at sequence N.
 */
export function fold(events: AcaEvent[]): FoldedRun {
  const state: FoldedRun = {
    runId: events[0]?.runId ?? "",
    status: "planning",
    nodes: new Map(),
    locksHeld: new Set(),
    tokens: 0,
    costUsd: 0,
    lastSeq: 0,
    pendingApprovals: [],
  };

  for (const e of events) {
    state.lastSeq = e.seq ?? state.lastSeq;
    const node = ensure(state, e.nodeId);

    switch (e.type) {
      case "run.created":
        state.status = "planning";
        break;
      case "plan.proposed":
        state.status = "awaiting_approval";
        break;
      case "plan.approved":
      case "run.started":
        state.status = "running";
        break;
      case "run.paused":
        state.status = "paused";
        break;
      case "run.cancelled":
        state.status = "cancelled";
        break;
      case "run.completed":
        state.status = "completed";
        break;
      case "run.failed":
        state.status = "failed";
        break;

      case "node.ready":
        if (node) node.status = "ready";
        break;
      case "node.started":
        if (node) node.status = "running";
        break;
      case "node.blocked":
        if (node) node.status = "blocked";
        break;
      case "node.parked":
        if (node) node.status = "parked";
        break;
      case "node.done":
        if (node) node.status = "done";
        break;
      case "node.failed":
        if (node) node.status = "failed";
        break;
      case "node.rolled_back":
        if (node) node.status = "rolled_back";
        break;
      case "node.dirtied":
        // F6: a rollback requeued this node because its read set intersected
        // the rolled-back write set.
        if (node) {
          node.status = "dirty";
          node.dirtyReason = String(e.payload["reason"] ?? "");
        }
        break;
      case "node.retried":
        if (node) node.attempts = Number(e.payload["attempts"] ?? node.attempts + 1);
        break;
      case "node.routed":
        if (node) {
          node.route = {
            provider: String(e.payload["provider"] ?? ""),
            model: String(e.payload["model"] ?? ""),
          };
        }
        break;

      case "review.rejected":
        if (node) node.reviewRounds = Number(e.payload["round"] ?? node.reviewRounds + 1);
        break;

      case "lock.acquired":
        for (const r of asArray(e.payload["resources"])) state.locksHeld.add(r);
        break;
      case "lock.released":
        for (const r of asArray(e.payload["resources"])) state.locksHeld.delete(r);
        break;

      case "model.response":
        state.tokens +=
          Number(e.payload["inputTokens"] ?? 0) + Number(e.payload["outputTokens"] ?? 0);
        state.costUsd += Number(e.payload["costUsd"] ?? 0);
        break;

      case "approval.requested":
        state.pendingApprovals.push(String(e.payload["approvalId"] ?? ""));
        break;
      case "approval.granted":
      case "approval.denied": {
        const id = String(e.payload["approvalId"] ?? "");
        state.pendingApprovals = state.pendingApprovals.filter((a) => a !== id);
        break;
      }
      default:
        break;
    }
  }

  return state;
}

function asArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}
