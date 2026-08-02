export interface BudgetLimits {
  maxTokens?: number;
  maxCostUsd?: number;
  maxWallMs?: number;
  /** Fraction of a limit at which to warn before stopping. */
  warnAt?: number;
}

export class BudgetExceeded extends Error {
  readonly kind: "tokens" | "cost" | "time";
  readonly used: number;
  readonly limit: number;

  constructor(kind: "tokens" | "cost" | "time", used: number, limit: number) {
    super(`budget exceeded: ${kind} ${used} of ${limit}`);
    this.name = "BudgetExceeded";
    this.kind = kind;
    this.used = used;
    this.limit = limit;
  }
}

export type BudgetState = "ok" | "warning" | "exceeded";

/**
 * Token / cost / wall-clock accounting (flow review F15).
 *
 * The original flow metered nothing. With cloud models in the routing pool a
 * runaway DAG is a billing incident, and even fully local it is a way to burn
 * an afternoon of GPU on a loop nobody is watching.
 *
 * Crossing a threshold produces `warning` (stop-or-ask) rather than a hard
 * stop, so the human decides — but `check()` throws once a limit is actually
 * passed, because at that point asking is what the run already did.
 */
export class BudgetMeter {
  private tokens = 0;
  private costUsd = 0;
  private startedAt = Date.now();
  private warned = new Set<string>();

  private limits: BudgetLimits;

  constructor(limits: BudgetLimits = {}) {
    this.limits = limits;
  }

  get usage(): { tokens: number; costUsd: number; wallMs: number } {
    return { tokens: this.tokens, costUsd: this.costUsd, wallMs: Date.now() - this.startedAt };
  }

  add(tokens: number, costUsd = 0): void {
    this.tokens += tokens;
    this.costUsd += costUsd;
  }

  reset(): void {
    this.tokens = 0;
    this.costUsd = 0;
    this.startedAt = Date.now();
    this.warned.clear();
  }

  /** Returns the state without throwing — for status strips and meters. */
  state(): { state: BudgetState; kind?: "tokens" | "cost" | "time"; ratio: number } {
    const warnAt = this.limits.warnAt ?? 0.8;
    let worst: { kind: "tokens" | "cost" | "time"; ratio: number } | null = null;

    const consider = (kind: "tokens" | "cost" | "time", used: number, limit?: number) => {
      if (!limit || limit <= 0) return;
      const ratio = used / limit;
      if (!worst || ratio > worst.ratio) worst = { kind, ratio };
    };

    consider("tokens", this.tokens, this.limits.maxTokens);
    consider("cost", this.costUsd, this.limits.maxCostUsd);
    consider("time", Date.now() - this.startedAt, this.limits.maxWallMs);

    if (!worst) return { state: "ok", ratio: 0 };
    const w = worst as { kind: "tokens" | "cost" | "time"; ratio: number };
    if (w.ratio >= 1) return { state: "exceeded", kind: w.kind, ratio: w.ratio };
    if (w.ratio >= warnAt) return { state: "warning", kind: w.kind, ratio: w.ratio };
    return { state: "ok", kind: w.kind, ratio: w.ratio };
  }

  /** Call before every model request. Throws once a limit is actually passed. */
  check(): void {
    const s = this.state();
    if (s.state !== "exceeded" || !s.kind) return;
    const limit =
      s.kind === "tokens"
        ? (this.limits.maxTokens ?? 0)
        : s.kind === "cost"
          ? (this.limits.maxCostUsd ?? 0)
          : (this.limits.maxWallMs ?? 0);
    const used =
      s.kind === "tokens" ? this.tokens : s.kind === "cost" ? this.costUsd : this.usage.wallMs;
    throw new BudgetExceeded(s.kind, used, limit);
  }

  /** True the first time a given threshold is crossed, so we warn once. */
  shouldWarn(): boolean {
    const s = this.state();
    if (s.state !== "warning" || !s.kind) return false;
    if (this.warned.has(s.kind)) return false;
    this.warned.add(s.kind);
    return true;
  }
}
