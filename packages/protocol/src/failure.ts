import { z } from "zod";

/**
 * Error taxonomy. The original flow drew these as a chain of yes/no diamonds
 * with no exit when retries ran out (flow review F1) and no class for a dead
 * provider (F9). Both are fixed here: `retries_exhausted` is reachable, and
 * `provider_unavailable` / `capability_mismatch` are first-class.
 */
export const FailureClass = z.enum([
  "transient",
  "retrieval_miss",
  "provider_unavailable",
  "capability_mismatch",
  "permission_required",
  "write_set_violation",
  "permanent",
]);
export type FailureClass = z.infer<typeof FailureClass>;

export const RecoveryAction = z.enum([
  "retry",
  "widen_retrieval",
  "fallback_provider",
  "escalate_to_human",
  "rollback",
]);
export type RecoveryAction = z.infer<typeof RecoveryAction>;

export const Verdict = z.object({
  failure: FailureClass,
  action: RecoveryAction,
  reason: z.string(),
});
export type Verdict = z.infer<typeof Verdict>;

/** Individual static gates. Each carries its own severity and retryability (F12). */
export const GateName = z.enum(["build", "typecheck", "lint", "unit", "contract", "secrets"]);
export type GateName = z.infer<typeof GateName>;

export const GateResult = z.object({
  gate: GateName,
  passed: z.boolean(),
  /** `blocking` fails the node; `advisory` is recorded but does not fail it. */
  severity: z.enum(["blocking", "advisory"]),
  /**
   * A secrets hit is never auto-retried and never silently rolled back —
   * it escalates. That is why retryability is per gate, not per node.
   */
  autoRetryable: z.boolean(),
  detail: z.string().default(""),
  durationMs: z.number().default(0),
});
export type GateResult = z.infer<typeof GateResult>;

export const GateVector = z.object({
  results: z.array(GateResult),
  passed: z.boolean(),
});
export type GateVector = z.infer<typeof GateVector>;
