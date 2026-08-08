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

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

/**
 * A gate's output, trimmed to something worth putting in a prompt.
 *
 * Raw output is unusable as feedback: vitest emits screenfuls wrapped in ANSI
 * colour codes, and tsc will happily list every error in the project. Both
 * bury the first few lines, which are the ones that say what to fix — and the
 * whole point of carrying detail into a retry is that the model can act on it.
 */
export function gateDetail(
  results: readonly GateResult[],
  options: { maxLines?: number; maxChars?: number } = {},
): string {
  const maxLines = options.maxLines ?? 8;
  const maxChars = options.maxChars ?? 600;

  return results
    .filter((r) => !r.passed && r.detail.trim())
    .map((r) => {
      const lines = r.detail
        .replace(ANSI, "")
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.trim());

      const kept = lines.slice(0, maxLines).join("\n");
      const body = kept.length > maxChars ? `${kept.slice(0, maxChars - 1)}…` : kept;
      const omitted = lines.length - Math.min(lines.length, maxLines);

      return `${r.gate}:\n${body}${omitted > 0 ? `\n… and ${omitted} more line(s)` : ""}`;
    })
    .join("\n\n");
}

/** Failing gates that a retry could plausibly fix. */
export function retryableFailures(v: GateVector): GateResult[] {
  return v.results.filter((r) => !r.passed && r.autoRetryable && r.severity === "blocking");
}

/** Failing gates that must go to a human regardless of attempts remaining. */
export function escalatingFailures(v: GateVector): GateResult[] {
  return v.results.filter((r) => !r.passed && !r.autoRetryable && r.severity === "blocking");
}
