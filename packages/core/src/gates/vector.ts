import type { GateName, GateResult, GateVector } from "@aca/protocol";

export interface GateContext {
  cwd: string;
  changedFiles: string[];
  signal?: AbortSignal;
}

export interface GateRunner {
  name: GateName;
  severity: "blocking" | "advisory";
  autoRetryable: boolean;
  run(ctx: GateContext): Promise<{ passed: boolean; detail: string }>;
}

/**
 * Runs the gate vector (flow review F12).
 *
 * The original flow drew `Static gates pass?` as one boolean. But a lint
 * warning, a failing unit test, and a leaked credential have nothing in common
 * in terms of what should happen next — collapsing them loses exactly the
 * information the recovery path needs.
 *
 * So gates return a vector: each carries its own severity and its own
 * retryability. A secrets hit is never auto-retried and never silently rolled
 * back; it escalates.
 */
export async function runGates(
  runners: readonly GateRunner[],
  ctx: GateContext,
): Promise<GateVector> {
  const results: GateResult[] = [];

  for (const runner of runners) {
    if (ctx.signal?.aborted) break;
    const started = Date.now();
    let passed = false;
    let detail = "";
    try {
      const out = await runner.run(ctx);
      passed = out.passed;
      detail = out.detail;
    } catch (err) {
      passed = false;
      detail = err instanceof Error ? err.message : String(err);
    }
    results.push({
      gate: runner.name,
      passed,
      severity: runner.severity,
      autoRetryable: runner.autoRetryable,
      detail,
      durationMs: Date.now() - started,
    });
  }

  // Only blocking gates decide pass/fail; advisory ones are recorded so the
  // reviewer can see them without failing the node.
  const passed = results.every((r) => r.passed || r.severity === "advisory");
  return { results, passed };
}

/** Failing gates that a retry could plausibly fix. */
export function retryableFailures(v: GateVector): GateResult[] {
  return v.results.filter((r) => !r.passed && r.autoRetryable && r.severity === "blocking");
}

/** Failing gates that must go to a human regardless of attempts remaining. */
export function escalatingFailures(v: GateVector): GateResult[] {
  return v.results.filter((r) => !r.passed && !r.autoRetryable && r.severity === "blocking");
}
