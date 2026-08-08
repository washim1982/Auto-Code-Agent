import { describe, expect, it } from "vitest";
import {
  classify,
  ContractUnmet,
  GateFailure,
  WriteSetViolation,
} from "../src/recovery/classifier.ts";

const node = (attempts = 0): { id: string; attempts: number } => ({ id: "n1", attempts });

describe("contract failures in the recovery taxonomy", () => {
  it("retries a node that did not write what it declared", () => {
    // Thrown as a bare Error this matched no pattern list and fell through to
    // `permanent`, rolling the node back on its first attempt — the exact trap
    // GateFailure exists to escape.
    const verdict = classify({
      node: node(1),
      error: new ContractUnmet("declared writes but modified nothing", ["out.md"], false),
      maxAttempts: 2,
    });

    expect(verdict.action).toBe("retry");
    expect(verdict.failure).toBe("transient");
    expect(verdict.reason).toContain("modified nothing");
  });

  it("retries a node that ran out of steps just the same", () => {
    const verdict = classify({
      node: node(1),
      error: new ContractUnmet("ran out of steps (24/24)", ["out.md"], true),
      maxAttempts: 2,
    });

    expect(verdict.action).toBe("retry");
  });

  it("still stops once attempts are exhausted", () => {
    // Exhaustion is checked before the taxonomy (F1), so the retryable class
    // must not become an infinite loop.
    const verdict = classify({
      node: node(2),
      error: new ContractUnmet("declared writes but modified nothing", ["out.md"], false),
      maxAttempts: 2,
    });

    expect(verdict.action).toBe("rollback");
    expect(verdict.failure).toBe("permanent");
  });

  it("does not make every failure retryable", () => {
    expect(
      classify({
        node: node(0),
        error: new WriteSetViolation("elsewhere.ts", ["out.md"]),
        maxAttempts: 2,
      }).action,
    ).toBe("rollback");

    expect(
      classify({
        node: node(0),
        error: new GateFailure(["secrets"], false),
        maxAttempts: 2,
      }).action,
    ).toBe("rollback");

    expect(
      classify({ node: node(0), error: new Error("something odd"), maxAttempts: 2 }).action,
    ).toBe("rollback");
  });
});

describe("gate failures carry what to fix", () => {
  it("puts the compiler output in the message, not just the gate name", () => {
    // "gates failed: typecheck" tells a retrying model that it failed and
    // nothing it can act on. The reason travels into the next attempt.
    const err = new GateFailure(
      ["typecheck"],
      true,
      "typecheck:\nsrc/types.ts(369,18): error TS1005: '=>' expected",
    );

    expect(err.message).toContain("TS1005");
    expect(err.message).toContain("src/types.ts(369,18)");

    const verdict = classify({ node: node(1), error: err, maxAttempts: 2 });
    expect(verdict.action).toBe("retry");
    expect(verdict.reason).toContain("TS1005");
  });

  it("still reads sensibly with no detail to report", () => {
    expect(new GateFailure(["secrets"], false).message).toBe("gates failed: secrets");
  });
});
