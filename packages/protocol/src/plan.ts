import { z } from "zod";
import { NodeId, NodeStatus, ResourceId } from "./primitives.ts";

/**
 * A node declares BOTH sets, not just writes.
 *
 * The original flow only declared write sets, which made rollback unsound: a
 * sibling could have consumed a rolled-back write through the join barrier and
 * nothing would know to requeue it (flow review F6). Read sets are what make
 * cascade invalidation possible.
 */
export const NodeSets = z.object({
  read: z.array(ResourceId).default([]),
  write: z.array(ResourceId).default([]),
});
export type NodeSets = z.infer<typeof NodeSets>;

export const AcceptanceCriterion = z.object({
  id: z.string(),
  text: z.string(),
  met: z.boolean().nullable().default(null),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const PlanNode = z.object({
  id: NodeId,
  title: z.string(),
  persona: z.string().default("coder"),
  deps: z.array(NodeId).default([]),
  sets: NodeSets,
  /** What this node promises to produce; the reviewer checks against it. */
  contract: z.string().default(""),
  acceptance: z.array(AcceptanceCriterion).default([]),
  status: NodeStatus.default("pending"),

  /**
   * Attempt counter lives on the record, not in the classifier (F1).
   * A stateless classifier re-labels the same failure `transient` forever;
   * classification must read this first and force `permanent` past the cap.
   */
  attempts: z.number().int().min(0).default(0),
  /** Bounded review loop (F2). */
  reviewRounds: z.number().int().min(0).default(0),

  route: z.object({ provider: z.string(), model: z.string() }).nullable().default(null),
  checkpointId: z.string().nullable().default(null),
  /** Set when the node was requeued because a dependency rolled back (F6). */
  dirtyReason: z.string().nullable().default(null),
});
export type PlanNode = z.infer<typeof PlanNode>;

export const Plan = z.object({
  id: z.string(),
  goal: z.string(),
  nodes: z.array(PlanNode),
  createdAt: z.number(),
  /**
   * Why a previous plan was rejected. Carried into replanning as a hard
   * constraint so the planner does not regenerate the same plan (F16).
   */
  rejectionReasons: z.array(z.string()).default([]),
});
export type Plan = z.infer<typeof Plan>;

export const TaskSpec = z.object({
  goal: z.string(),
  intent: z.string().default(""),
  scope: z.array(z.string()).default([]),
  nonGoals: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).default([]),
});
export type TaskSpec = z.infer<typeof TaskSpec>;
