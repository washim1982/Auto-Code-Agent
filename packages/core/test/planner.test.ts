import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PlannedDag, type PlannedNode } from "../src/plan/schema.ts";
import { findCycle, validatePlan } from "../src/plan/validate.ts";
import { normalizeDag } from "../src/plan/normalize.ts";
import {
  Planner,
  PlanValidationError,
  toPlan,
  type StructuredGenerator,
} from "../src/plan/planner.ts";

function n(over: Partial<PlannedNode> & { id: string }): PlannedNode {
  return {
    title: `do ${over.id}`,
    persona: "coder",
    deps: [],
    reads: [],
    writes: [],
    contract: "",
    ...over,
  };
}

const dag = (nodes: PlannedNode[]): PlannedDag => ({ reasoning: "r", nodes });

describe("plan validation", () => {
  it("accepts a well-formed linear plan", () => {
    const out = validatePlan(
      dag([
        n({ id: "n1", writes: ["src/a.ts"] }),
        n({ id: "n2", deps: ["n1"], reads: ["src/a.ts"], writes: ["test/a.spec.ts"] }),
      ]),
      [],
    );
    expect(out.ok).toBe(true);
  });

  it("rejects a dependency on a node that does not exist", () => {
    const out = validatePlan(dag([n({ id: "n1", deps: ["ghost"] })]), []);
    expect(out.ok).toBe(false);
    expect(out.problems.some((p) => p.message.includes("ghost"))).toBe(true);
  });

  it("rejects a self-dependency", () => {
    const out = validatePlan(dag([n({ id: "n1", deps: ["n1"] })]), []);
    expect(out.ok).toBe(false);
    expect(out.problems.some((p) => p.message.includes("itself"))).toBe(true);
  });

  it("rejects duplicate node ids", () => {
    const out = validatePlan(dag([n({ id: "n1" }), n({ id: "n1" })]), []);
    expect(out.ok).toBe(false);
    expect(out.problems.some((p) => p.message.includes("duplicate"))).toBe(true);
  });

  it("detects a dependency cycle and names it", () => {
    const d = dag([
      n({ id: "a", deps: ["c"] }),
      n({ id: "b", deps: ["a"] }),
      n({ id: "c", deps: ["b"] }),
    ]);
    expect(findCycle(d)).not.toBeNull();
    const out = validatePlan(d, []);
    expect(out.ok).toBe(false);
    expect(out.problems.some((p) => p.message.includes("cycle"))).toBe(true);
  });

  it("rejects a write set that escapes the workspace", () => {
    const out = validatePlan(dag([n({ id: "n1", writes: ["../outside.ts"] })]), []);
    expect(out.ok).toBe(false);
    expect(out.problems.some((p) => p.message.includes("workspace-relative"))).toBe(true);
  });

  it("rejects a write set covering the whole tree", () => {
    // `**` would make every node conflict with every other, so conflict
    // detection would degenerate into full serialisation.
    const out = validatePlan(dag([n({ id: "n1", writes: ["**"] })]), []);
    expect(out.ok).toBe(false);
    expect(out.problems.some((p) => p.message.includes("entire workspace"))).toBe(true);
  });

  it("warns when two unordered nodes write overlapping paths", () => {
    const out = validatePlan(
      dag([n({ id: "a", writes: ["src/mw/x.ts"] }), n({ id: "b", writes: ["src/mw/**"] })]),
      [],
    );
    // A warning, not an error: the scheduler will serialise them safely, but
    // the order becomes non-deterministic across runs.
    expect(out.ok).toBe(true);
    expect(out.problems.some((p) => p.message.includes("neither depends"))).toBe(true);
  });

  it("does not warn when the overlap is already ordered by a dependency", () => {
    const out = validatePlan(
      dag([
        n({ id: "a", writes: ["src/mw/x.ts"] }),
        n({ id: "b", deps: ["a"], writes: ["src/mw/x.ts"] }),
      ]),
      [],
    );
    expect(out.problems.some((p) => p.message.includes("neither depends"))).toBe(false);
  });

  it("flags an acceptance criterion no node appears to address", () => {
    const out = validatePlan(
      dag([n({ id: "n1", title: "add rate limiter", contract: "limiter exists" })]),
      ["rate limiter returns 429 with a Retry-After header", "documentation is updated"],
    );
    expect(out.problems.some((p) => p.message.includes("documentation"))).toBe(true);
  });
});

describe("planner", () => {
  /** A generator that replays canned model outputs, so no server is needed. */
  function fakeGenerator(responses: unknown[]): { gen: StructuredGenerator; calls: number } {
    let i = 0;
    const state = { calls: 0 };
    const gen: StructuredGenerator = async <T>(req: {
      schema: z.ZodType<T>;
    }): Promise<{ value: T; model: string; provider: string }> => {
      state.calls++;
      const value = responses[Math.min(i++, responses.length - 1)];
      return {
        value: req.schema.parse(value),
        model: "fake-model",
        provider: "fake",
      };
    };
    return {
      gen,
      get calls() {
        return state.calls;
      },
    } as never;
  }

  const spec = {
    intent: "add rate limiting",
    scope: ["src/mw"],
    nonGoals: [],
    acceptance: ["limiter caps at 100 req/min"],
  };

  it("compiles a spec then produces a validated plan", async () => {
    const good = dag([
      n({ id: "n1", title: "implement limiter", writes: ["src/mw/rateLimit.ts"] }),
      n({
        id: "n2",
        title: "test limiter caps at 100 req/min",
        deps: ["n1"],
        reads: ["src/mw/rateLimit.ts"],
        writes: ["test/rateLimit.spec.ts"],
      }),
    ]);
    const { gen } = fakeGenerator([spec, good]);
    const planner = new Planner(gen);
    const result = await planner.plan("add rate limiting");

    expect(result.plan.nodes).toHaveLength(2);
    expect(result.repairs).toBe(0);
    expect(result.spec.acceptance).toHaveLength(1);
    // Read/write sets survive onto the runtime node shape.
    expect(result.plan.nodes[1]!.sets.read).toContain("src/mw/rateLimit.ts");
  });

  it("repairs a structurally invalid plan and succeeds", async () => {
    const broken = dag([n({ id: "n1", deps: ["missing"], writes: ["a.ts"] })]);
    const fixed = dag([n({ id: "n1", writes: ["a.ts"] })]);
    const { gen } = fakeGenerator([spec, broken, fixed]);

    const result = await new Planner(gen).plan("goal");
    expect(result.repairs).toBe(1);
    expect(result.plan.nodes).toHaveLength(1);
  });

  it("gives up rather than looping when the plan never validates", async () => {
    const broken = dag([n({ id: "n1", deps: ["missing"] })]);
    const { gen } = fakeGenerator([spec, broken, broken, broken, broken]);

    await expect(new Planner(gen, { maxRepairs: 2 }).plan("goal")).rejects.toThrow(
      PlanValidationError,
    );
  });

  it("carries rejection reasons into the planning prompt (F16)", async () => {
    const seen: string[] = [];
    const gen: StructuredGenerator = async <T>(req: {
      schema: z.ZodType<T>;
      messages: { role: string; content: string }[];
    }): Promise<{ value: T; model: string; provider: string }> => {
      seen.push(...req.messages.map((m) => m.content));
      const value =
        seen.filter((s) => s.includes("Request:")).length > 0 && seen.length > 3
          ? dag([n({ id: "n1", writes: ["a.ts"] })])
          : spec;
      return { value: req.schema.parse(value), model: "m", provider: "p" };
    };

    await new Planner(gen).plan("goal", {
      rejectionReasons: ["do not touch the database layer"],
    });

    expect(seen.some((s) => s.includes("do not touch the database layer"))).toBe(true);
    expect(seen.some((s) => s.includes("REJECTED"))).toBe(true);
  });
});

describe("toPlan projection", () => {
  it("normalises paths and drops duplicates", () => {
    const plan = toPlan(
      "goal",
      dag([
        n({
          id: "n1",
          reads: ["./src/a.ts", "src\\a.ts", ""],
          writes: ["src/b.ts", "src/b.ts"],
        }),
      ]),
      [],
    );
    expect(plan.nodes[0]!.sets.read).toEqual(["src/a.ts"]);
    expect(plan.nodes[0]!.sets.write).toEqual(["src/b.ts"]);
  });

  it("initialises runtime state the model must not supply", () => {
    const plan = toPlan("goal", dag([n({ id: "n1" })]), []);
    const node = plan.nodes[0]!;
    expect(node.attempts).toBe(0);
    expect(node.reviewRounds).toBe(0);
    expect(node.route).toBeNull();
    expect(node.status).toBe("pending");
  });
});

describe("deterministic plan repair", () => {
  it("moves a path-shaped dep into reads instead of burning a repair round", () => {
    const { dag: fixed, notes } = normalizeDag(
      dag([n({ id: "modify-divide", deps: ["src/math.js"], writes: ["src/math.js"] })]),
    );
    expect(fixed.nodes[0]!.deps).toEqual([]);
    expect(fixed.nodes[0]!.reads).toContain("src/math.js");
    expect(notes[0]!.message).toMatch(/moved/);
    expect(validatePlan(fixed, []).ok).toBe(true);
  });

  it("leaves real node dependencies alone", () => {
    const { dag: fixed, notes } = normalizeDag(
      dag([n({ id: "a", writes: ["x.ts"] }), n({ id: "b", deps: ["a"] })]),
    );
    expect(fixed.nodes[1]!.deps).toEqual(["a"]);
    expect(notes).toHaveLength(0);
  });

  it("still reports a genuinely unknown dep rather than silently dropping it", () => {
    // Not path-shaped, so this is a real mistake the model must fix.
    const { dag: fixed } = normalizeDag(dag([n({ id: "a", deps: ["nonexistent"] })]));
    expect(fixed.nodes[0]!.deps).toEqual(["nonexistent"]);
    expect(validatePlan(fixed, []).ok).toBe(false);
  });

  it("does not duplicate a path already declared in reads", () => {
    const { dag: fixed } = normalizeDag(
      dag([n({ id: "a", deps: ["src/x.ts"], reads: ["src/x.ts"] })]),
    );
    expect(fixed.nodes[0]!.reads).toEqual(["src/x.ts"]);
  });
});
