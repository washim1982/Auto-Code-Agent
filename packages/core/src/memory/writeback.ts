import type { PlanNode, Verdict } from "@aca/protocol";
import type { MemoryStore } from "./store.ts";

export interface WritebackOptions {
  scope?: string;
}

/**
 * The "Write back (T1/T2 delta, T4 lesson, T3 relevance)" box, made real.
 *
 * The original flow drew this as one step at the end of a successful node. It
 * is actually three different writes with three different triggers, and only
 * one of them happens on success:
 *
 *   T2  on completion — what this node concluded, for its dependents
 *   T3  on completion — which retrieved chunks actually contributed
 *   T4  on failure    — what went wrong, so the next run does not repeat it
 *
 * Failure is where the durable learning is. A run that only writes memory when
 * it succeeds learns nothing from the thing worth learning from.
 */
export class MemoryWriteback {
  private memory: MemoryStore;
  private scope: string;

  constructor(memory: MemoryStore, options: WritebackOptions = {}) {
    this.memory = memory;
    this.scope = options.scope ?? "workspace";
  }

  /** T2: a node's outcome, available to whatever depends on it. */
  onNodeDone(runId: string, node: PlanNode, writes: readonly string[]): void {
    const summary = [
      `${node.title}.`,
      node.contract ? `Contract: ${node.contract}` : "",
      writes.length ? `Changed: ${writes.join(", ")}` : "No files changed.",
    ]
      .filter(Boolean)
      .join(" ");
    this.memory.writeTask(runId, node.id, "delta", summary);
  }

  /** T3: chunks that contributed to work which passed its gates. */
  onRetrievalUsed(chunkIds: readonly string[]): void {
    if (chunkIds.length > 0) this.memory.recordRelevance(chunkIds);
  }

  /**
   * T4: a lesson from a failure.
   *
   * Recorded on the first occurrence but not injected until a second
   * independent one confirms it — a single failure is usually circumstance,
   * and without that gate the tier becomes a garbage accumulator that costs
   * context on every future run.
   *
   * Transient failures are deliberately skipped: "the network blipped" is not
   * a lesson, and recording it would drown the ones that are.
   */
  onNodeFailed(runId: string, node: PlanNode, verdict: Verdict): void {
    if (verdict.failure === "transient" || verdict.failure === "provider_unavailable") return;

    const trigger = [node.title, node.sets.write.join(" ")].join(" ").slice(0, 200);
    const lesson = lessonFor(node, verdict);
    this.memory.recordLesson(this.scope, trigger, lesson, `run ${runId}, node ${node.id}`);
    this.memory.writeTask(runId, node.id, "failure", `${verdict.failure}: ${verdict.reason}`);
  }

  /** Scores the lessons a node was given, so bad advice retires itself. */
  scoreApplied(lessonIds: readonly string[], helped: boolean): string[] {
    const retired: string[] = [];
    for (const id of lessonIds) {
      if (this.memory.scoreLesson(id, helped).retired) retired.push(id);
    }
    return retired;
  }
}

/**
 * Turns a failure into something actionable.
 *
 * Generic text ("the node failed") is worse than nothing: it occupies context
 * and tells a future run nothing it can act on. Each failure class gets phrasing
 * that names the thing to do differently.
 */
function lessonFor(node: PlanNode, verdict: Verdict): string {
  switch (verdict.failure) {
    case "write_set_violation":
      return `Declare a wider write set for work like "${node.title}" — it needed paths outside ${node.sets.write.join(", ") || "its declaration"}.`;
    case "capability_mismatch":
      return `Work like "${node.title}" needs a more capable model than was routed: ${verdict.reason}`;
    case "retrieval_miss":
      return `Work like "${node.title}" needs broader context up front: ${verdict.reason}`;
    case "permission_required":
      return `"${node.title}" requires a permission the persona lacks: ${verdict.reason}`;
    default:
      return `"${node.title}" failed permanently: ${verdict.reason.slice(0, 240)}`;
  }
}
