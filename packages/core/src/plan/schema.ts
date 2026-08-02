import { z } from "zod";

/**
 * The shape the planner model must emit.
 *
 * Deliberately NOT `PlanNode` from the protocol: that carries runtime state
 * (attempts, review rounds, checkpoint id, route) which the model has no
 * business inventing. Asking a model for fields it cannot know is how you get
 * confidently wrong values written into your scheduler. This is the narrow
 * projection the model is actually qualified to produce.
 */
export const PlannedNode = z.object({
  id: z
    .string()
    .min(1)
    .describe("Short stable id such as n1, n2. Referenced by other nodes' deps."),
  title: z.string().min(1).describe("Imperative summary, under 60 characters."),
  persona: z
    .enum(["coder", "tester", "reviewer", "planner"])
    .describe("Which persona executes this node."),
  deps: z
    .array(z.string())
    .describe(
      "Ids of OTHER NODES in this plan that must finish first, e.g. ['n1']. " +
        "Never file paths — file dependencies belong in 'reads'. Empty array if none.",
    ),
  reads: z
    .array(z.string())
    .describe(
      "Workspace-relative paths or globs this node READS. Used to invalidate it if a dependency is rolled back.",
    ),
  writes: z
    .array(z.string())
    .describe(
      "Workspace-relative paths this node WRITES. Enforced at execution: a write outside this list fails the node.",
    ),
  contract: z
    .string()
    .describe("What this node promises to have produced. The reviewer checks against this."),
});
export type PlannedNode = z.infer<typeof PlannedNode>;

export const PlannedDag = z.object({
  reasoning: z
    .string()
    .describe("One or two sentences on how the work was split and why nodes were ordered."),
  nodes: z.array(PlannedNode).min(1).max(12),
});
export type PlannedDag = z.infer<typeof PlannedDag>;

/**
 * The compiled task specification.
 *
 * The original flow's "Optimize the prompt (intent, scope, acceptance
 * criteria)" box, made concrete. Acceptance criteria matter most: without
 * them the reviewer has nothing objective to check against and degenerates
 * into style opinions.
 */
export const CompiledSpec = z.object({
  intent: z.string().describe("What the user actually wants, in one sentence."),
  scope: z.array(z.string()).describe("Paths or areas of the codebase in scope. Be specific."),
  nonGoals: z.array(z.string()).describe("Things explicitly NOT to do."),
  acceptance: z
    .array(z.string())
    .min(1)
    .describe("Objectively checkable statements that must be true when done."),
});
export type CompiledSpec = z.infer<typeof CompiledSpec>;
