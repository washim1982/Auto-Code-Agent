import type {
  Approval,
  ApprovalResponse,
  GateVector,
  Plan,
  PlanNode,
  Verdict,
} from "@aca/protocol";
import type { Db } from "../db/client.ts";
import type { EventLog } from "../events/log.ts";
import { LockManager } from "../scheduler/locks.ts";
import { cascadeInvalidate } from "../scheduler/cascade.ts";
import { classify, GateFailure } from "../recovery/classifier.ts";
import { ReviewLoop } from "../review/loop.ts";
import { BudgetMeter, type BudgetLimits } from "../budget/meter.ts";
import { Cancelled, CancellationToken } from "./cancellation.ts";
import { escalatingFailures } from "../gates/vector.ts";

export interface NodeExecution {
  gates: GateVector;
  /** Resources the node actually wrote, for epoch bumping. */
  writes: string[];
}

export interface SupervisorHooks {
  /** Runs one node. Throws to signal failure; the classifier decides what next. */
  executeNode(node: PlanNode, token: CancellationToken): Promise<NodeExecution>;
  /** Independent critic. Returns null to accept, or a critique to reject. */
  review?(node: PlanNode, exec: NodeExecution): Promise<string | null>;
  /** Restores the node's write set. */
  rollback?(node: PlanNode): Promise<void>;
  requestApproval?(approval: Approval): Promise<ApprovalResponse>;
  /** Called when a node's context should be re-assembled more broadly. */
  widenRetrieval?(node: PlanNode): Promise<void>;
}

export interface SupervisorOptions {
  /**
   * Total executions of a node, not retries on top of a first try.
   * `maxAttempts: 2` means one initial attempt plus one retry.
   */
  maxAttempts?: number;
  maxReviewRounds?: number;
  budget?: BudgetLimits;
  /** Scheduler width. Clamp to summed provider slots, not CPU count. */
  concurrency?: number;
  /** Guards against a cascade requeue storm becoming a livelock. */
  maxCascadeDepth?: number;
}

export interface RunOutcome {
  status: "completed" | "failed" | "cancelled";
  nodes: PlanNode[];
  reason?: string;
}

/**
 * The corrected flow from docs/01-flow-review.md, wired end to end.
 *
 * Every deviation from the original diagram is marked with its finding id.
 * The shape is: pull a ready node -> acquire its whole lock set in canonical
 * order -> execute -> gate -> review -> write back, with failures routed
 * through the taxonomy rather than a single retry edge.
 */
export class RunSupervisor {
  private locks: LockManager;
  private budget: BudgetMeter;
  private reviews = new Map<string, ReviewLoop>();
  readonly token = new CancellationToken();

  private db: Db;
  private events: EventLog;
  private hooks: SupervisorHooks;
  private options: SupervisorOptions;

  constructor(
    db: Db,
    events: EventLog,
    hooks: SupervisorHooks,
    options: SupervisorOptions = {},
  ) {
    this.db = db;
    this.events = events;
    this.hooks = hooks;
    this.options = options;
    this.locks = new LockManager(db, events);
    this.budget = new BudgetMeter(options.budget ?? {});
  }

  get meter(): BudgetMeter {
    return this.budget;
  }

  cancel(reason = "cancelled by user"): void {
    this.token.cancel(reason);
  }

  async run(runId: string, plan: Plan): Promise<RunOutcome> {
    const nodes = plan.nodes.map((n) => ({ ...n }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    this.events.append(runId, "run.started", { plan: plan.id, nodes: nodes.length });

    try {
      for (;;) {
        this.token.throwIfCancelled();

        if (nodes.every((n) => n.status === "done")) {
          this.events.append(runId, "run.completed", {});
          return { status: "completed", nodes };
        }

        const ready = nodes.filter((n) => this.isReady(n, byId));
        if (ready.length === 0) {
          const stuck = nodes.filter(
            (n) => n.status !== "done" && n.status !== "failed" && n.status !== "rolled_back",
          );
          if (stuck.length === 0) {
            this.events.append(runId, "run.failed", { reason: "nodes failed permanently" });
            return { status: "failed", nodes, reason: "one or more nodes failed permanently" };
          }
          // Parked nodes retain their locks (F5), so a run can legitimately be
          // waiting on a human. That is a pause, not a deadlock.
          const parked = stuck.filter((n) => n.status === "parked");
          this.events.append(runId, "run.paused", {
            reason: parked.length ? "awaiting human approval" : "no runnable nodes",
            parked: parked.map((n) => n.id),
          });
          return {
            status: "failed",
            nodes,
            reason: parked.length
              ? `parked awaiting approval: ${parked.map((n) => n.id).join(", ")}`
              : "no runnable nodes remain",
          };
        }

        // Width is clamped by provider slots, not CPU count — a 5-wide DAG
        // against one Ollama with NUM_PARALLEL=2 must launch 2.
        const width = Math.max(1, this.options.concurrency ?? 1);
        const batch = ready.slice(0, width);
        await Promise.all(batch.map((node) => this.runNode(runId, node, nodes)));
      }
    } catch (err) {
      if (err instanceof Cancelled) {
        // Cancellation checkpoints rather than discards (F14).
        this.events.append(runId, "run.cancelled", { reason: err.message });
        return { status: "cancelled", nodes, reason: err.message };
      }
      this.events.append(runId, "run.failed", { reason: String(err) });
      return { status: "failed", nodes, reason: String(err) };
    }
  }

  private isReady(node: PlanNode, byId: Map<string, PlanNode>): boolean {
    if (node.status === "done" || node.status === "running") return false;
    if (node.status === "failed" || node.status === "rolled_back") return false;
    if (node.status === "parked") return false;
    return node.deps.every((d) => byId.get(d)?.status === "done");
  }

  private reviewLoopFor(nodeId: string): ReviewLoop {
    let loop = this.reviews.get(nodeId);
    if (!loop) {
      loop = new ReviewLoop({ maxRounds: this.options.maxReviewRounds ?? 3 });
      this.reviews.set(nodeId, loop);
    }
    return loop;
  }

  private async runNode(runId: string, node: PlanNode, all: PlanNode[]): Promise<void> {
    this.token.throwIfCancelled();

    // F3: whole set, canonical order, all-or-nothing. A blocked node returns to
    // the queue holding nothing, so hold-and-wait cannot form.
    const lock = this.locks.acquire({
      runId,
      nodeId: node.id,
      write: node.sets.write,
      read: node.sets.read,
    });
    if (!lock.ok) {
      node.status = "blocked";
      this.events.append(runId, "node.blocked", { blockedOn: lock.blockedOn }, node.id);
      return;
    }

    node.status = "running";
    this.events.append(runId, "node.started", { attempt: node.attempts + 1 }, node.id);

    try {
      // F15: budget is a precondition of doing work, not a post-hoc report.
      this.budget.check();
      if (this.budget.shouldWarn()) {
        this.events.append(runId, "budget.warning", this.budget.usage, node.id);
      }

      const exec = await this.hooks.executeNode(node, this.token);

      // F12: gates are a vector; only some failures are auto-retryable, and a
      // secrets hit escalates rather than retrying or rolling back silently.
      for (const g of exec.gates.results) {
        this.events.append(
          runId,
          g.passed ? "gate.passed" : "gate.failed",
          { gate: g.gate, detail: g.detail, severity: g.severity },
          node.id,
        );
      }

      if (!exec.gates.passed) {
        const mustEscalate = escalatingFailures(exec.gates);
        if (mustEscalate.length > 0) {
          await this.park(runId, node, `gate ${mustEscalate[0]!.gate} requires review`);
          return;
        }
        const failed = exec.gates.results.filter((r) => !r.passed && r.severity === "blocking");
        throw new GateFailure(
          failed.map((r) => r.gate),
          failed.every((r) => r.autoRetryable),
        );
      }

      // F2: bounded review with critique dedup; escalates instead of looping.
      if (this.hooks.review) {
        const critique = await this.hooks.review(node, exec);
        if (critique) {
          const loop = this.reviewLoopFor(node.id);
          const decision = loop.reject(critique);
          node.reviewRounds = loop.round;
          this.events.append(
            runId,
            "review.rejected",
            { round: loop.round, critique: critique.slice(0, 400) },
            node.id,
          );
          if (decision.action === "escalate") {
            await this.park(runId, node, decision.reason);
            return;
          }
          node.status = "ready";
          this.locks.release(runId, node.id);
          return;
        }
        this.events.append(runId, "review.approved", {}, node.id);
      }

      node.status = "done";
      this.events.append(runId, "node.done", { writes: exec.writes }, node.id);
      this.locks.release(runId, node.id);
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      await this.handleFailure(runId, node, all, err);
    }
  }

  private async park(runId: string, node: PlanNode, reason: string): Promise<void> {
    node.status = "parked";
    // F5: locks are RETAINED. Releasing them would let a sibling mutate the
    // resource while the human deliberates, making this node's checkpoint —
    // and therefore its rollback point — describe a world that no longer exists.
    this.locks.park(runId, node.id);

    const approval: Approval = {
      id: `${runId}:${node.id}:${Date.now()}`,
      runId,
      nodeId: node.id,
      kind: "permission",
      summary: `node ${node.id} needs a decision`,
      detail: reason,
      irreversible: false,
      createdAt: Date.now(),
    };
    this.events.append(
      runId,
      "approval.requested",
      { approvalId: approval.id, reason },
      node.id,
    );

    if (!this.hooks.requestApproval) return;
    const response = await this.hooks.requestApproval(approval);

    if (response.granted) {
      this.events.append(runId, "approval.granted", { approvalId: approval.id }, node.id);
      this.locks.unpark(runId, node.id);
      node.status = "ready";
      // Attempts reset on an explicit human go-ahead — the human is the new
      // evidence that a retry is worth making.
      node.attempts = 0;
    } else {
      this.events.append(runId, "approval.denied", { approvalId: approval.id }, node.id);
      this.locks.forceRelease(runId, node.id);
      node.status = "failed";
    }
  }

  private async handleFailure(
    runId: string,
    node: PlanNode,
    all: PlanNode[],
    err: unknown,
  ): Promise<void> {
    // F1: attempts live on the node record and are checked before the taxonomy,
    // so "max 2" is actually enforced instead of merely drawn on the box.
    node.attempts++;
    const verdict: Verdict = classify({
      node,
      error: err,
      maxAttempts: this.options.maxAttempts ?? 2,
    });

    this.events.append(
      runId,
      "node.failed",
      {
        failure: verdict.failure,
        action: verdict.action,
        reason: verdict.reason,
        attempts: node.attempts,
      },
      node.id,
    );

    switch (verdict.action) {
      case "retry":
        node.status = "ready";
        this.locks.release(runId, node.id);
        this.events.append(runId, "node.retried", { attempts: node.attempts }, node.id);
        return;

      case "widen_retrieval":
        await this.hooks.widenRetrieval?.(node);
        node.status = "ready";
        this.locks.release(runId, node.id);
        return;

      case "fallback_provider":
        // The router picks a different candidate on the next attempt; the node
        // itself just becomes runnable again.
        node.status = "ready";
        this.locks.release(runId, node.id);
        return;

      case "escalate_to_human":
        await this.park(runId, node, verdict.reason);
        return;

      case "rollback":
      default:
        await this.rollbackNode(runId, node, all, verdict.reason);
        return;
    }
  }

  private async rollbackNode(
    runId: string,
    node: PlanNode,
    all: PlanNode[],
    reason: string,
  ): Promise<void> {
    await this.hooks.rollback?.(node);
    node.status = "rolled_back";
    this.locks.release(runId, node.id);
    this.events.append(runId, "node.rolled_back", { reason }, node.id);

    // F6: this is the part the original flow was missing entirely. Rolling back
    // a write set invalidates every node that READ it — through the join
    // barrier a sibling may already have built conclusions on data that no
    // longer exists. Those nodes are dirtied and requeued, transitively.
    const cascade = cascadeInvalidate(all, node.id, {
      maxDepth: this.options.maxCascadeDepth ?? 8,
    });
    for (const d of cascade.dirtied) {
      const target = all.find((n) => n.id === d.nodeId);
      if (!target) continue;
      target.status = "ready";
      target.dirtyReason = `${node.id} rolled back; overlapping reads: ${d.via.join(", ")}`;
      target.attempts = 0;
      this.events.append(
        runId,
        "node.dirtied",
        { reason: target.dirtyReason, via: d.via },
        target.id,
      );
    }
    if (cascade.truncated) {
      this.events.append(runId, "run.failed", {
        reason: "cascade depth cap reached — escalating rather than churning",
      });
    }
  }
}
