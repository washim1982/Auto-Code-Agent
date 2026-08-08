import type { FailureClass, PlanNode, Verdict } from "@aca/protocol";

export interface ClassifyInput {
  node: Pick<PlanNode, "id" | "attempts">;
  error: unknown;
  maxAttempts: number;
}

const TRANSIENT_PATTERNS = [
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EPIPE/i,
  /socket hang up/i,
  /rate.?limit/i,
  /\b429\b/,
  /\b50[234]\b/,
  /temporarily unavailable/i,
];

const PROVIDER_DOWN_PATTERNS = [
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /fetch failed/i,
  /provider unavailable/i,
  /model not found/i,
];

const RETRIEVAL_PATTERNS = [
  /insufficient context/i,
  /could not find/i,
  /no relevant/i,
  /not enough information/i,
];

const PERMISSION_PATTERNS = [/permission denied/i, /requires approval/i, /EACCES/i];

export class WriteSetViolation extends Error {
  readonly path: string;
  readonly declared: readonly string[];

  constructor(path: string, declared: readonly string[]) {
    super(`write outside declared set: ${path} (declared: ${declared.join(", ") || "none"})`);
    this.name = "WriteSetViolation";
    this.path = path;
    this.declared = declared;
  }
}

export class CapabilityMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityMismatch";
  }
}

/**
 * A blocking static gate failed.
 *
 * This has to be its own class rather than a generic Error: a failing unit test
 * produces a message that matches none of the transient patterns, so pattern
 * matching alone classifies it `permanent` and rolls the node back on the first
 * try. Whether a gate failure is worth retrying is a property of the gate (F12),
 * not of the words in its output.
 */
export class GateFailure extends Error {
  readonly gates: string[];
  readonly autoRetryable: boolean;
  /** Compiler and test output, trimmed — see `gateDetail`. */
  readonly details: string;

  /**
   * The message carries the detail, not just the gate names.
   *
   * "gates failed: typecheck, unit" tells a retrying model that it failed and
   * nothing it can act on; `src/types.ts(369,18): error TS1005` tells it what to
   * fix. The reason travels into the next attempt's context, so whatever is
   * left out here is information the retry does not get.
   */
  constructor(gates: string[], autoRetryable: boolean, details = "") {
    super(
      details
        ? `gates failed: ${gates.join(", ")}\n${details}`
        : `gates failed: ${gates.join(", ")}`,
    );
    this.name = "GateFailure";
    this.gates = gates;
    this.autoRetryable = autoRetryable;
    this.details = details;
  }
}

/**
 * A node finished without writing the paths it declared.
 *
 * Like `GateFailure`, this needs its own class rather than a generic `Error`:
 * its message matches none of the pattern lists, so classification fell through
 * to `permanent` and rolled the node back on its first attempt — which is
 * exactly what the throw site was trying to avoid. Small models narrate the
 * change instead of making it, and the second attempt, told plainly what went
 * wrong, is where they usually get it right.
 */
export class ContractUnmet extends Error {
  readonly declared: readonly string[];
  /** True when the tool loop hit its step budget rather than finishing. */
  readonly exhausted: boolean;

  constructor(message: string, declared: readonly string[], exhausted: boolean) {
    super(message);
    this.name = "ContractUnmet";
    this.declared = declared;
    this.exhausted = exhausted;
  }
}

/**
 * Classifies a node failure into the recovery taxonomy.
 *
 * The ordering here is the whole point (flow review F1). The original flow
 * drew `Transient error? -> yes -> Retry, max 2` with the cap written on the
 * box but enforced nowhere; a stateless classifier re-labels the same failure
 * `transient` on every pass and the node retries forever.
 *
 * So the exhaustion check runs FIRST, against a counter that lives on the node
 * record, before any pattern matching happens.
 */
export function classify(input: ClassifyInput): Verdict {
  const { node, error, maxAttempts } = input;
  const message = errorMessage(error);

  // F1: exhaustion is checked before the taxonomy, not after it.
  if (node.attempts >= maxAttempts) {
    return {
      failure: "permanent",
      action: "rollback",
      reason: `retries exhausted after ${node.attempts} attempt(s): ${message}`,
    };
  }

  // The gate itself decides whether a retry could help (F12).
  if (error instanceof GateFailure) {
    return error.autoRetryable
      ? { failure: "transient", action: "retry", reason: message }
      : { failure: "permanent", action: "rollback", reason: message };
  }

  // Retryable while attempts remain: the exhaustion check above already caps
  // it, and attempt 2 carries the reason this one failed.
  if (error instanceof ContractUnmet) {
    return { failure: "transient", action: "retry", reason: message };
  }

  // A write outside the declared set is never retryable — the plan was wrong,
  // not the weather (F4).
  if (error instanceof WriteSetViolation) {
    return { failure: "write_set_violation", action: "rollback", reason: message };
  }

  if (error instanceof CapabilityMismatch) {
    return { failure: "capability_mismatch", action: "fallback_provider", reason: message };
  }

  if (matches(message, PERMISSION_PATTERNS)) {
    return { failure: "permission_required", action: "escalate_to_human", reason: message };
  }

  if (matches(message, PROVIDER_DOWN_PATTERNS)) {
    return { failure: "provider_unavailable", action: "fallback_provider", reason: message };
  }

  if (matches(message, RETRIEVAL_PATTERNS)) {
    return { failure: "retrieval_miss", action: "widen_retrieval", reason: message };
  }

  if (matches(message, TRANSIENT_PATTERNS)) {
    return { failure: "transient", action: "retry", reason: message };
  }

  return { failure: "permanent", action: "rollback", reason: message };
}

export function isRetryable(f: FailureClass): boolean {
  return f === "transient" || f === "retrieval_miss";
}

function matches(s: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(s));
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
