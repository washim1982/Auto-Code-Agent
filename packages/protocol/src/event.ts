import { z } from "zod";

/**
 * The append-only event log is the source of truth (flow review F18).
 * Run state is a fold over these. That single decision buys crash resume,
 * the timeline UI, deterministic replay, and an audit trail — instead of
 * four separate mechanisms.
 */
export const EventType = z.enum([
  "run.created",
  "run.started",
  "run.paused",
  "run.cancelled",
  "run.completed",
  "run.failed",

  "plan.proposed",
  "plan.approved",
  "plan.rejected",

  "node.ready",
  "node.routed",
  "node.started",
  "node.blocked",
  "node.parked",
  "node.done",
  "node.failed",
  "node.retried",
  "node.rolled_back",
  "node.dirtied",
  "node.steps_low",

  "lock.acquired",
  "lock.released",
  "lock.contended",

  "tool.called",
  "tool.result",
  "tool.cache_hit",
  "tool.exhausted",
  "cache.invalidated",
  "epoch.bumped",
  "checkpoint.taken",

  "guard.fenced",
  "guard.blocked",

  "model.request",
  "model.response",

  "gate.passed",
  "gate.failed",
  "review.requested",
  "review.approved",
  "review.rejected",

  "approval.requested",
  "approval.granted",
  "approval.denied",

  "budget.warning",
  "budget.exceeded",

  "chat.message",
]);
export type EventType = z.infer<typeof EventType>;

export const AcaEvent = z.object({
  seq: z.number().int().optional(),
  runId: z.string(),
  nodeId: z.string().nullable().default(null),
  ts: z.number(),
  type: EventType,
  payload: z.record(z.unknown()).default({}),
});
export type AcaEvent = z.infer<typeof AcaEvent>;

export const Approval = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string().nullable(),
  kind: z.enum(["plan", "irreversible", "permission", "budget"]),
  summary: z.string(),
  detail: z.string().default(""),
  /** True when the action cannot be undone by rollback (F13). */
  irreversible: z.boolean().default(false),
  createdAt: z.number(),
});
export type Approval = z.infer<typeof Approval>;

export const ApprovalResponse = z.object({
  approvalId: z.string(),
  granted: z.boolean(),
  /** `once` | `run` — scope of the grant. Never generalised beyond the run. */
  scope: z.enum(["once", "run"]).default("once"),
  reason: z.string().default(""),
});
export type ApprovalResponse = z.infer<typeof ApprovalResponse>;
