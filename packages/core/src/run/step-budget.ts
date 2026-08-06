/**
 * The step budget for one node's tool loop, and the warning that goes with it.
 *
 * A step is one model round-trip. The loop used to run to a hardcoded 12 and
 * then simply stop, which produced the worst version of every failure: a node
 * spent all twelve reading and grepping, got cut off still gathering context,
 * and was then reported as having "modified nothing" — blamed for a budget
 * failure it was never told about. See docs/08-reliable-execution.md.
 *
 * Two things fix that. The budget has to leave room for the writes the node
 * actually declared, and the model has to hear about the limit while it can
 * still act on it rather than discovering it by being killed.
 */

export interface StepBudgetOptions {
  /** From `run.maxSteps`. */
  maxSteps?: number;
  /** `node.sets.write.length` — one step per declared path, at minimum. */
  declaredWrites?: number;
}

export class StepBudget {
  /** Total steps this node may spend. */
  readonly total: number;
  /**
   * Steps held back for writing.
   *
   * Once the remaining budget drops to this, the node is told to stop gathering
   * context. A node writing ten files needs more than the flat third that
   * suffices for one.
   */
  readonly reserve: number;

  private consumed = 0;
  private warned = false;

  constructor(options: StepBudgetOptions = {}) {
    const configured = Math.max(1, options.maxSteps ?? 24);
    const writes = Math.max(0, options.declaredWrites ?? 0);

    // A node that must write more paths than the configured budget allows for
    // is not over budget, it is under-provisioned. Grow rather than truncate —
    // one step per declared path, plus one to finish. A configured maximum
    // above that floor is honoured exactly, including a deliberately small one.
    this.total = Math.max(configured, writes + 1);
    this.reserve = Math.max(writes + 1, Math.ceil(this.total / 3));
  }

  /** Records one model round-trip. */
  consume(): void {
    this.consumed++;
  }

  get used(): number {
    return this.consumed;
  }

  get remaining(): number {
    return Math.max(0, this.total - this.consumed);
  }

  /**
   * True exactly once, at the step where the node should stop researching.
   *
   * Once, because repeating it every step turns a directive into noise and
   * spends the very budget it is trying to protect.
   */
  shouldWarn(): boolean {
    if (this.warned) return false;
    if (this.remaining > this.reserve) return false;
    this.warned = true;
    return true;
  }
}

/** What the model is told when the budget runs low. */
export function lowStepsNotice(remaining: number, declared: readonly string[]): string {
  const paths = declared.join(", ");
  return (
    `You have ${remaining} step${remaining === 1 ? "" : "s"} left in this node. ` +
    `Stop gathering context now. ` +
    (paths
      ? `Write ${paths} using write_file with the full file contents, then say DONE. `
      : `Finish with what you have, then say DONE. `) +
    `If you cannot, say what is missing — do not keep reading.`
  );
}
