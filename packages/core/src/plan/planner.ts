import { Plan, PlanNode, type ModelRequirement } from "@aca/protocol";
import { CompiledSpec, PlannedDag, type PlannedNode } from "./schema.ts";
import { normalizeDag } from "./normalize.ts";
import { renderProblems, validatePlan, type PlanProblem } from "./validate.ts";
import { normalizeResource } from "../scheduler/resource.ts";

/**
 * Injected so `core` never imports `providers` — the dependency runs the other
 * way, and a planner that could reach into the model layer would make the flow
 * untestable without a live server.
 */
export interface StructuredGenerator {
  <T>(req: {
    requirement: ModelRequirement;
    schema: import("zod").ZodType<T>;
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<{ value: T; model: string; provider: string }>;
}

export interface PlannerOptions {
  /** Repair rounds for a structurally invalid plan before giving up. */
  maxRepairs?: number;
  /** Optional repo map so the planner declares paths that actually exist. */
  workspaceMap?: string;
}

export interface PlanResult {
  plan: Plan;
  spec: CompiledSpec;
  problems: PlanProblem[];
  model: string;
  provider: string;
  repairs: number;
}

const SPEC_SYSTEM = `You compile a vague developer request into a precise specification.

Be concrete and conservative:
- intent: one sentence, what they actually want
- scope: specific paths or areas, not "the codebase"
- nonGoals: things a careless implementer might do that they did NOT ask for
- acceptance: statements a machine or reviewer can objectively check

Do not invent requirements. If the request is small, the spec is small.`;

const PLAN_SYSTEM = `You break a specification into a DAG of executable sub-tasks.

Rules that the scheduler depends on — violating them breaks the run:
- Every node declares "writes": exactly the paths it may modify. A write
  outside this list fails the node at execution time.
- Every node declares "writePolicy". Use "required" when it must produce a
  diff. Use "optional" for conditional work where inspection may correctly
  conclude no change is needed (for example, "update dependencies if needed").
- Never combine writePolicy "required" with a contract saying "if needed",
  "only if", or "do not modify if". That makes a correct no-op impossible.
- Every node declares "reads": paths it depends on the content of. This is how
  a rollback knows which nodes to invalidate.
- If two nodes write overlapping paths, one MUST depend on the other. Parallel
  writes to the same file are a bug, not parallelism.
- deps must reference ids that exist in this plan. No cycles.
- Keep nodes SMALL. A node is executed by one model in one bounded context
  window, so its whole job must fit there alongside the files it has to read.
  Prefer 4-10 small nodes over 3 large ones.
- A node should declare at most 3 write paths. If a unit of work touches more,
  split it — one node that writes eight files cannot hold them all in context
  and will run out before it finishes.
- Only "coder" and "tester" may declare writes. An analysis node that must
  produce a file is a "coder" node, not a "planner" one.
- Split by file or by concern, not by phase. "Add the IPC handler" and "add the
  UI that calls it" are two nodes; "implement everything" is not a node.
- Put verification (tests, checks) in its own node that depends on the work.

Paths are workspace-relative. Never absolute, never outside the workspace.`;

/**
 * Turns a request into a validated plan.
 *
 * Two model calls: compile the spec, then plan against it. Splitting them is
 * what makes the acceptance criteria usable — asking for spec and DAG in one
 * shot reliably produces criteria retrofitted to whatever plan the model
 * already decided on, which defeats the point of having a reviewer.
 */
export class Planner {
  private generate: StructuredGenerator;
  private options: PlannerOptions;

  constructor(generate: StructuredGenerator, options: PlannerOptions = {}) {
    this.generate = generate;
    this.options = options;
  }

  async compileSpec(goal: string, signal?: AbortSignal): Promise<CompiledSpec> {
    const { value } = await this.generate({
      requirement: {
        purpose: "plan",
        needsTools: false,
        needsVision: false,
        needsStructured: true,
        minContext: 8192,
        qualityTier: "standard",
        privacy: "prefer-local",
        excludeModels: [],
      },
      schema: CompiledSpec,
      messages: [
        { role: "system", content: SPEC_SYSTEM },
        ...(this.options.workspaceMap
          ? [{ role: "user" as const, content: `Workspace:\n${this.options.workspaceMap}` }]
          : []),
        { role: "user", content: `Request: ${goal}` },
      ],
      ...(signal ? { signal } : {}),
    });
    return value;
  }

  /**
   * Generates a DAG, repairing structural problems in a bounded loop.
   *
   * `rejectionReasons` are prior human rejections, carried in as hard
   * constraints (F16). Without them replanning regenerates a near-identical
   * plan and the approval gate becomes an infinite loop with extra steps.
   */
  async plan(
    goal: string,
    options: { rejectionReasons?: string[]; signal?: AbortSignal } = {},
  ): Promise<PlanResult> {
    const spec = await this.compileSpec(goal, options.signal);
    const maxRepairs = this.options.maxRepairs ?? 2;

    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: PLAN_SYSTEM },
      ...(this.options.workspaceMap
        ? [{ role: "user" as const, content: `Workspace files:\n${this.options.workspaceMap}` }]
        : []),
      { role: "user", content: renderSpec(goal, spec) },
    ];

    if (options.rejectionReasons?.length) {
      messages.push({
        role: "user",
        content:
          "A previous plan was REJECTED. These are hard constraints, not suggestions:\n" +
          options.rejectionReasons.map((r) => `- ${r}`).join("\n"),
      });
    }

    let lastProblems: PlanProblem[] = [];

    for (let repair = 0; repair <= maxRepairs; repair++) {
      const { value, model, provider } = await this.generate({
        requirement: {
          purpose: "plan",
          needsTools: false,
          needsVision: false,
          needsStructured: true,
          minContext: 16_384,
          // Planning is where a bad model costs the most: every downstream node
          // inherits its mistakes.
          qualityTier: "critical",
          privacy: "prefer-local",
          excludeModels: [],
        },
        schema: PlannedDag,
        messages,
        maxTokens: 3000,
        ...(options.signal ? { signal: options.signal } : {}),
      });

      // Fix mechanical confusions deterministically before spending a repair
      // round on them — see plan/normalize.ts.
      const { dag: normalized, notes } = normalizeDag(value);
      const validation = validatePlan(normalized, spec.acceptance);
      lastProblems = [
        ...validation.problems,
        ...notes.map((n) => ({
          severity: "warning" as const,
          nodeId: n.nodeId,
          message: n.message,
        })),
      ];

      if (validation.ok) {
        return {
          plan: toPlan(goal, normalized, options.rejectionReasons ?? []),
          spec,
          problems: lastProblems,
          model,
          provider,
          repairs: repair,
        };
      }

      messages.push({ role: "assistant", content: JSON.stringify(normalized) });
      messages.push({
        role: "user",
        content: `That plan is not executable. Fix these problems and return the corrected plan:\n${renderProblems(
          validation.problems.filter((p) => p.severity === "error"),
        )}`,
      });
    }

    throw new PlanValidationError(
      `planner could not produce an executable DAG after ${maxRepairs + 1} attempts`,
      lastProblems,
    );
  }
}

export class PlanValidationError extends Error {
  readonly problems: PlanProblem[];

  constructor(message: string, problems: PlanProblem[]) {
    super(`${message}\n${renderProblems(problems)}`);
    this.name = "PlanValidationError";
    this.problems = problems;
  }
}

function renderSpec(goal: string, spec: CompiledSpec): string {
  return [
    `Goal: ${goal}`,
    `Intent: ${spec.intent}`,
    `Scope: ${spec.scope.join(", ") || "(unspecified)"}`,
    `Non-goals: ${spec.nonGoals.join(", ") || "(none)"}`,
    `Acceptance criteria:`,
    ...spec.acceptance.map((a, i) => `  ${i + 1}. ${a}`),
  ].join("\n");
}

/** Projects the model's output onto the runtime PlanNode shape. */
export function toPlan(goal: string, dag: PlannedDag, rejectionReasons: string[]): Plan {
  const nodes = dag.nodes.map((n) =>
    PlanNode.parse({
      id: n.id,
      title: n.title,
      persona: n.persona,
      deps: n.deps,
      sets: {
        read: dedupe(n.reads.map(normalizeResource)),
        write: dedupe(n.writes.map(normalizeResource)),
      },
      writePolicy: n.writePolicy,
      contract: n.contract,
      status: "pending",
    }),
  );

  return Plan.parse({
    id: `plan-${Date.now().toString(36)}`,
    goal,
    nodes,
    createdAt: Date.now(),
    rejectionReasons,
  });
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export type { PlannedNode };
