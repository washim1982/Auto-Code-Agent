import { randomUUID } from "node:crypto";
import type { PlanNode } from "@aca/protocol";
import { MemoryWriteback, RunSupervisor, type SupervisorHooks } from "@aca/core";
import { makeExecutor } from "./executor.ts";
import { makeReviewer } from "./reviewer.ts";
import type { WorkspaceServices } from "./workspace-service.ts";

type ApprovalRequest = Parameters<NonNullable<SupervisorHooks["requestApproval"]>>[0];
type ApprovalReply = Awaited<ReturnType<NonNullable<SupervisorHooks["requestApproval"]>>>;

export interface RunnerOptions {
  services: WorkspaceServices;
  runId: string;
  localOnly?: boolean;
  maxTokens?: number;
  maxWallMs?: number;
  verbose?: boolean;
  /** A gate the supervisor raises — a blocked node, a budget ceiling. */
  requestApproval(approval: ApprovalRequest): Promise<ApprovalReply>;
  /** An irreversible tool call, asked at execution time regardless of F13. */
  requestIrreversible(summary: string, detail: string): Promise<boolean>;
  onRoute?(nodeId: string, model: string): void;
}

/**
 * Builds a supervisor and its executor sharing one budget meter.
 *
 * Extracted because every front-end needs the identical assembly, and the
 * two-phase construction in the middle of it is a trap: the executor needs the
 * supervisor's meter and the supervisor needs the executor, so a front-end
 * wiring it by hand can easily give the executor a meter of its own. That is
 * exactly what made the budget inert twice — a run burning a GPU for minutes
 * and reporting zero tokens. One copy, one chance to get it wrong.
 */
export async function buildRunner(options: RunnerOptions): Promise<RunSupervisor> {
  const { services, runId } = options;
  const localOnly = options.localOnly ?? services.config.router.privacy === "local-only";
  const nodeModels = new Map<string, string>();

  let execute: SupervisorHooks["executeNode"] | null = null;

  const supervisor = new RunSupervisor(
    services.db,
    services.events,
    {
      executeNode: (node, token) => {
        if (!execute) throw new Error("executor not initialised");
        return execute(node, token);
      },
      writeback: new MemoryWriteback(services.memory),
      review: makeReviewer({
        root: services.root,
        runId,
        router: services.router,
        events: services.events,
        personas: services.personas,
        localOnly,
        coderModelFor: (nodeId) => nodeModels.get(nodeId),
      }),
      rollback: async (node: PlanNode) => {
        services.events.append(runId, "node.rolled_back", { nodeId: node.id }, node.id);
      },
      requestApproval: options.requestApproval,
    },
    {
      maxAttempts: services.config.run.maxAttempts,
      maxReviewRounds: services.config.run.maxReviewRounds,
      // Width is clamped by provider slots, not CPU count.
      concurrency: Math.max(1, Math.min(await services.residency.totalSlots(), 3)),
      budget: {
        maxTokens: options.maxTokens ?? services.config.budget.maxTokens,
        maxWallMs: options.maxWallMs ?? services.config.budget.maxWallMs,
      },
    },
  );

  execute = makeExecutor({
    root: services.root,
    runId,
    router: services.router,
    registry: services.tools,
    events: services.events,
    cache: services.cache,
    guard: services.guard,
    memory: services.memory,
    personas: services.personas,
    localOnly,
    meter: supervisor.meter,
    maxSteps: services.config.run.maxSteps,
    maxOutputTokens: services.config.run.maxOutputTokens,
    maxReads: services.config.run.maxReads,
    maxNodeTokens: services.config.run.maxNodeTokens,
    twoPhase: services.config.run.twoPhase,
    ...(options.verbose ? { verbose: true } : {}),
    onRoute: (nodeId, model) => {
      nodeModels.set(nodeId, model);
      options.onRoute?.(nodeId, model);
    },
    requestApproval: options.requestIrreversible,
  });

  return supervisor;
}

/** An approval reply for a front-end that only has yes/no to offer. */
export function reply(
  approval: ApprovalRequest,
  granted: boolean,
  scope: "once" | "run" = "once",
  reason = "",
): ApprovalReply {
  return { approvalId: approval.id, granted, scope, reason };
}

export { randomUUID };
