import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Plan, PlanNode, type GateVector } from "@aca/protocol";
import { Db } from "../src/db/client.ts";
import { EventLog } from "../src/events/log.ts";
import { fold } from "../src/events/fold.ts";
import { Planner, type StructuredGenerator } from "../src/plan/planner.ts";
import { RunSupervisor, type NodeExecution } from "../src/run/supervisor.ts";

/**
 * The corrected flow, end to end, with no model and no network.
 *
 * This is the test that would catch a regression in how the stages fit
 * together — every other suite exercises one box of the diagram in isolation.
 * The generator replays fixed outputs, so a change in behaviour here is a
 * change in OUR logic, never in a model's mood.
 */

const SPEC = {
  intent: "make divide reject a zero denominator",
  scope: ["src/math.js"],
  nonGoals: ["changing the add function"],
  acceptance: ["divide throws when b is zero", "existing tests still pass"],
};

const GOLDEN_DAG = {
  reasoning: "One node to change the function, one to test it.",
  nodes: [
    {
      id: "guard",
      title: "add a zero check to divide",
      persona: "coder" as const,
      deps: [],
      reads: ["src/math.js"],
      writes: ["src/math.js"],
      contract: "divide throws when b is zero",
    },
    {
      id: "verify",
      title: "test that divide throws and existing tests still pass",
      persona: "tester" as const,
      deps: ["guard"],
      reads: ["src/math.js"],
      writes: ["test/math.test.js"],
      contract: "a failing-if-unmet test exists",
    },
  ],
};

function generatorFor(responses: unknown[]): StructuredGenerator {
  let i = 0;
  return async <T>(req: {
    schema: z.ZodType<T>;
  }): Promise<{
    value: T;
    model: string;
    provider: string;
  }> => ({
    value: req.schema.parse(responses[Math.min(i++, responses.length - 1)]),
    model: "golden",
    provider: "fixture",
  });
}

const passingGates: GateVector = {
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
    {
      gate: "secrets",
      passed: true,
      severity: "blocking",
      autoRetryable: false,
      detail: "",
      durationMs: 1,
    },
  ],
};

describe("golden flow: goal to completed run, offline", () => {
  it("produces the expected DAG shape", async () => {
    const planner = new Planner(generatorFor([SPEC, GOLDEN_DAG]));
    const result = await planner.plan("make divide throw when b is zero");

    expect(result.plan.nodes.map((n) => n.id)).toEqual(["guard", "verify"]);
    expect(result.plan.nodes[1]!.deps).toEqual(["guard"]);
    // Read/write sets are what the scheduler reasons over; if these drift, the
    // conflict and cascade machinery silently loses its input.
    expect(result.plan.nodes[0]!.sets.write).toEqual(["src/math.js"]);
    expect(result.plan.nodes[1]!.sets.read).toEqual(["src/math.js"]);
    expect(result.spec.acceptance).toHaveLength(2);
  });

  it("executes the plan and records a complete, foldable history", async () => {
    const db = new Db(":memory:");
    const events = new EventLog(db);
    const planner = new Planner(generatorFor([SPEC, GOLDEN_DAG]));
    const { plan } = await planner.plan("make divide throw when b is zero");

    const executed: string[] = [];
    const supervisor = new RunSupervisor(db, events, {
      executeNode: async (node): Promise<NodeExecution> => {
        executed.push(node.id);
        return { gates: passingGates, writes: node.sets.write };
      },
      review: async () => null,
    });

    const outcome = await supervisor.run("golden", plan);

    expect(outcome.status).toBe("completed");
    // Dependency order is the plan's, not the array's.
    expect(executed).toEqual(["guard", "verify"]);

    const state = fold(events.read("golden"));
    expect(state.status).toBe("completed");
    expect([...state.nodes.values()].every((n) => n.status === "done")).toBe(true);
    // Locks must not survive a completed run.
    expect(state.locksHeld.size).toBe(0);
  });

  it("replays to any point, which is what resume and the timeline rely on", async () => {
    const db = new Db(":memory:");
    const events = new EventLog(db);
    const { plan } = await new Planner(generatorFor([SPEC, GOLDEN_DAG])).plan("goal");

    const supervisor = new RunSupervisor(db, events, {
      executeNode: async (node) => ({ gates: passingGates, writes: node.sets.write }),
    });
    await supervisor.run("golden", plan);

    const all = events.read("golden");
    const midpoint = all.filter((e) => (e.seq ?? 0) <= Math.floor((all.at(-1)?.seq ?? 0) / 2));
    const partial = fold(midpoint);
    const complete = fold(all);

    expect(partial.status).not.toBe("completed");
    expect(complete.status).toBe("completed");
    expect(partial.lastSeq).toBeLessThan(complete.lastSeq);
  });

  it("rolls back and cascades when a downstream node fails permanently", async () => {
    const db = new Db(":memory:");
    const events = new EventLog(db);
    const { plan } = await new Planner(generatorFor([SPEC, GOLDEN_DAG])).plan("goal");

    const supervisor = new RunSupervisor(
      db,
      events,
      {
        executeNode: async (node) => {
          if (node.id === "guard") throw new Error("unrecoverable");
          return { gates: passingGates, writes: node.sets.write };
        },
      },
      { maxAttempts: 1 },
    );

    const outcome = await supervisor.run("golden", plan);
    expect(outcome.status).toBe("failed");

    const types = events.read("golden").map((e) => e.type);
    expect(types).toContain("node.rolled_back");
    // `verify` depends on `guard`, so it must never have run.
    expect(types.filter((t) => t === "node.done")).toHaveLength(0);
  });

  it("serialises nodes with conflicting write sets", async () => {
    const conflicting = Plan.parse({
      id: "p",
      goal: "g",
      createdAt: Date.now(),
      nodes: [
        PlanNode.parse({ id: "a", title: "a", sets: { read: [], write: ["src/**"] } }),
        PlanNode.parse({ id: "b", title: "b", sets: { read: [], write: ["src/math.js"] } }),
      ],
    });

    const db = new Db(":memory:");
    const events = new EventLog(db);
    let concurrent = 0;
    let peak = 0;

    const supervisor = new RunSupervisor(
      db,
      events,
      {
        executeNode: async (node) => {
          concurrent++;
          peak = Math.max(peak, concurrent);
          await new Promise((r) => setTimeout(r, 10));
          concurrent--;
          return { gates: passingGates, writes: node.sets.write };
        },
      },
      { concurrency: 4 },
    );

    const outcome = await supervisor.run("golden", conflicting);
    expect(outcome.status).toBe("completed");
    // `src/**` and `src/math.js` overlap, so they must never overlap in time.
    expect(peak).toBe(1);
  });
});
