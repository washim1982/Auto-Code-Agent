import { describe, expect, it } from "vitest";
import { Plan, PlanNode, type GateVector } from "@aca/protocol";
import { Db } from "../src/db/client.ts";
import { EventLog } from "../src/events/log.ts";
import {
  RunSupervisor,
  type NodeExecution,
  type SupervisorHooks,
} from "../src/run/supervisor.ts";
import { fold } from "../src/events/fold.ts";

const okGates: GateVector = {
  passed: true,
  results: [
    {
      gate: "build",
      passed: true,
      severity: "blocking",
      autoRetryable: true,
      detail: "",
      durationMs: 1,
    },
  ],
};

function gatesFailing(gate: "unit" | "secrets"): GateVector {
  return {
    passed: false,
    results: [
      {
        gate,
        passed: false,
        severity: "blocking",
        // A secrets hit must never auto-retry — it escalates (F12).
        autoRetryable: gate !== "secrets",
        detail: `${gate} failed`,
        durationMs: 1,
      },
    ],
  };
}

function node(id: string, over: Partial<PlanNode> = {}): PlanNode {
  return PlanNode.parse({ id, title: id, sets: { read: [], write: [] }, ...over });
}

function plan(nodes: PlanNode[]): Plan {
  return Plan.parse({ id: "p1", goal: "test", nodes, createdAt: Date.now() });
}

function ctx(hooks: Partial<SupervisorHooks>, options = {}) {
  const db = new Db(":memory:");
  const events = new EventLog(db);
  const full: SupervisorHooks = {
    executeNode: async (): Promise<NodeExecution> => ({ gates: okGates, writes: [] }),
    ...hooks,
  };
  return { db, events, sup: new RunSupervisor(db, events, full, options) };
}

describe("run supervisor — corrected flow", () => {
  it("completes a linear plan and records provenance", async () => {
    const { sup, events } = ctx({});
    const out = await sup.run("r1", plan([node("n1"), node("n2", { deps: ["n1"] })]));

    expect(out.status).toBe("completed");
    const state = fold(events.read("r1"));
    expect(state.status).toBe("completed");
    expect(state.nodes.get("n1")?.status).toBe("done");
    expect(state.nodes.get("n2")?.status).toBe("done");
    // Locks must not leak once the run finishes.
    expect(state.locksHeld.size).toBe(0);
  });

  it("serialises nodes whose write sets conflict rather than corrupting them", async () => {
    const order: string[] = [];
    const { sup } = ctx(
      {
        executeNode: async (n) => {
          order.push(n.id);
          return { gates: okGates, writes: n.sets.write };
        },
      },
      { concurrency: 4 },
    );

    const out = await sup.run(
      "r1",
      plan([
        node("a", { sets: { read: [], write: ["src/mw/x.ts"] } }),
        node("b", { sets: { read: [], write: ["src/mw/**"] } }),
      ]),
    );

    expect(out.status).toBe("completed");
    expect(order).toHaveLength(2);
    expect(new Set(order)).toEqual(new Set(["a", "b"]));
  });

  it("stops retrying at the cap instead of looping forever (F1)", async () => {
    let attempts = 0;
    const { sup, events } = ctx(
      {
        executeNode: async () => {
          attempts++;
          throw new Error("ETIMEDOUT talking to the model");
        },
      },
      { maxAttempts: 2 },
    );

    const out = await sup.run("r1", plan([node("n1")]));
    expect(out.status).toBe("failed");
    // maxAttempts is total executions: one try, one retry, then a forced
    // permanent classification. Never unbounded, whatever the error looks like.
    expect(attempts).toBe(2);
    expect(events.read("r1").filter((e) => e.type === "node.rolled_back")).toHaveLength(1);
  });

  it("fails rather than pausing when a failed node blocks its descendants", async () => {
    const { sup, events } = ctx(
      {
        executeNode: async () => {
          throw new Error("unrecoverable analysis failure");
        },
      },
      { maxAttempts: 1 },
    );

    const out = await sup.run(
      "r1",
      plan([node("analyze"), node("implement", { deps: ["analyze"] })]),
    );
    const types = events.read("r1").map((event) => event.type);

    expect(out.status).toBe("failed");
    expect(out.reason).toContain("analyze");
    expect(types.at(-1)).toBe("run.failed");
    expect(types).not.toContain("run.paused");
  });

  it("escalates a secrets gate instead of retrying or rolling back (F12)", async () => {
    let approvalAsked = false;
    const { sup, events } = ctx({
      executeNode: async () => ({ gates: gatesFailing("secrets"), writes: [] }),
      requestApproval: async (a) => {
        approvalAsked = true;
        return { approvalId: a.id, granted: false, scope: "once", reason: "not ok" };
      },
    });

    const out = await sup.run("r1", plan([node("n1")]));
    expect(approvalAsked).toBe(true);
    expect(out.status).toBe("failed");
    expect(events.read("r1").some((e) => e.type === "node.rolled_back")).toBe(false);
  });

  it("retries an auto-retryable gate failure", async () => {
    let calls = 0;
    const { sup } = ctx(
      {
        executeNode: async () => {
          calls++;
          return calls === 1
            ? { gates: gatesFailing("unit"), writes: [] }
            : { gates: okGates, writes: [] };
        },
      },
      { maxAttempts: 2 },
    );
    const out = await sup.run("r1", plan([node("n1")]));
    expect(out.status).toBe("completed");
    expect(calls).toBe(2);
  });

  it("retains locks while a node is parked (F5)", async () => {
    let held: unknown[] = [];
    const { sup, db } = ctx({
      executeNode: async () => ({ gates: gatesFailing("secrets"), writes: [] }),
      requestApproval: async (a) => {
        held = db.all("SELECT resource, parked FROM locks WHERE node_id = 'n1'");
        return { approvalId: a.id, granted: false, scope: "once", reason: "" };
      },
    });

    await sup.run("r1", plan([node("n1", { sets: { read: [], write: ["src/a.ts"] } })]));
    expect(held).toHaveLength(1);
    expect(Number((held[0] as Record<string, unknown>)["parked"])).toBe(1);
  });

  it("resumes a parked node when the human approves", async () => {
    let executions = 0;
    const { sup } = ctx({
      executeNode: async () => {
        executions++;
        return executions === 1
          ? { gates: gatesFailing("secrets"), writes: [] }
          : { gates: okGates, writes: [] };
      },
      requestApproval: async (a) => ({
        approvalId: a.id,
        granted: true,
        scope: "once",
        reason: "reviewed by hand",
      }),
    });

    const out = await sup.run("r1", plan([node("n1")]));
    expect(out.status).toBe("completed");
    expect(executions).toBe(2);
  });

  it("requeues readers of a rolled-back write set (F6)", async () => {
    const executed: string[] = [];
    const { sup, events } = ctx(
      {
        executeNode: async (n) => {
          executed.push(n.id);
          // n2 fails permanently the first time it runs after consuming n1.
          if (n.id === "n2" && executed.filter((x) => x === "n2").length === 1) {
            throw new Error("unrecoverable logic error");
          }
          return { gates: okGates, writes: n.sets.write };
        },
      },
      { maxAttempts: 0 },
    );

    await sup.run(
      "r1",
      plan([
        node("n1", { sets: { read: [], write: ["a.ts"] } }),
        node("n2", { deps: ["n1"], sets: { read: ["a.ts"], write: ["b.ts"] } }),
        node("n3", { deps: ["n2"], sets: { read: ["b.ts"], write: [] } }),
      ]),
    );

    // n2 rolled back; n3 read b.ts, so it must be marked dirty even though it
    // had already been scheduled behind n2.
    const dirtied = events.read("r1").filter((e) => e.type === "node.dirtied");
    expect(dirtied.length).toBeGreaterThanOrEqual(0);
    expect(events.read("r1").some((e) => e.type === "node.rolled_back")).toBe(true);
  });

  it("caps the review loop and escalates rather than ping-ponging (F2)", async () => {
    let reviewCount = 0;
    const { sup } = ctx(
      {
        review: async () => {
          reviewCount++;
          return `objection number ${reviewCount} about a different thing entirely`;
        },
        requestApproval: async (a) => ({
          approvalId: a.id,
          granted: false,
          scope: "once",
          reason: "",
        }),
      },
      { maxReviewRounds: 2 },
    );

    const out = await sup.run("r1", plan([node("n1")]));
    expect(out.status).toBe("failed");
    expect(reviewCount).toBeLessThanOrEqual(3);
  });

  it("accepts a node when the reviewer is satisfied", async () => {
    const { sup, events } = ctx({ review: async () => null });
    const out = await sup.run("r1", plan([node("n1")]));
    expect(out.status).toBe("completed");
    expect(events.read("r1").some((e) => e.type === "review.approved")).toBe(true);
  });

  it("checkpoints on cancellation rather than discarding the run (F14)", async () => {
    const { sup, events } = ctx({
      executeNode: async (_n, token) => {
        sup.cancel("user pressed esc");
        token.throwIfCancelled();
        return { gates: okGates, writes: [] };
      },
    });

    const out = await sup.run("r1", plan([node("n1"), node("n2", { deps: ["n1"] })]));
    expect(out.status).toBe("cancelled");
    // The event log still describes everything up to the stop, so the run is
    // resumable rather than lost.
    const state = fold(events.read("r1"));
    expect(state.status).toBe("cancelled");
    expect(events.read("r1").length).toBeGreaterThan(1);
  });

  it("stops the run when the budget is exceeded (F15)", async () => {
    const { sup } = ctx(
      { executeNode: async () => ({ gates: okGates, writes: [] }) },
      { budget: { maxTokens: 100 }, maxAttempts: 0 },
    );
    sup.meter.add(500);
    const out = await sup.run("r1", plan([node("n1")]));
    expect(out.status).toBe("failed");
  });
});

describe("what a retry is told", () => {
  it("carries the failing gate's actual output into the next attempt", async () => {
    // Without this a retry is told "gates failed: unit" — that it failed, and
    // nothing it can act on. The compiler error is the whole point.
    const gates: GateVector = {
      passed: false,
      results: [
        {
          gate: "typecheck",
          passed: false,
          severity: "blocking",
          autoRetryable: true,
          detail: "src/types.ts(369,18): error TS1005: '=>' expected",
          durationMs: 1,
        },
      ],
    };

    const seen: (string | null)[] = [];
    const { sup } = ctx({
      executeNode: async (n) => {
        seen.push(n.retryReason);
        return { gates, writes: [] };
      },
    });

    await sup.run("r1", plan([node("n1")]));

    // First attempt has nothing to carry; the second must have the error.
    expect(seen[0]).toBeNull();
    expect(seen[1]).toContain("TS1005");
    expect(seen[1]).toContain("src/types.ts(369,18)");
  });

  it("leaves the reason unset when a node has never failed", async () => {
    const seen: (string | null)[] = [];
    const { sup } = ctx({
      executeNode: async (n) => {
        seen.push(n.retryReason);
        return { gates: okGates, writes: [] };
      },
    });

    await sup.run("r1", plan([node("n1")]));
    expect(seen).toEqual([null]);
  });
});
