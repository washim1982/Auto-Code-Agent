import { createInterface } from "node:readline/promises";
import {
  Db,
  EpochCache,
  EventLog,
  OutputGuard,
  Planner,
  PlanValidationError,
  RunSupervisor,
  WorkspaceRegistry,
  type SupervisorHooks,
} from "@aca/core";
import { registerBuiltins, ToolRegistry, workspaceMap } from "@aca/tools";
import { discoverProviders, ModelRouter, ResidencyManager } from "@aca/providers";
import type { Plan, PlanNode } from "@aca/protocol";
import { c } from "./theme.ts";
import { renderDag } from "./render.ts";
import { renderPlanCard } from "./plan-card.ts";
import { makeGenerator } from "./generator.ts";
import { makeExecutor } from "./executor.ts";
import { Progress } from "./progress.ts";

export interface PlanRunOptions {
  root: string;
  goal: string;
  localOnly?: boolean;
  json?: boolean;
  /** Skip the approval gate. For CI. */
  yes?: boolean;
  /** Plan only; never execute. */
  dryRun?: boolean;
  maxTokens?: number;
  /** Pin every stage to one model, bypassing capability ranking. */
  model?: string;
}

/**
 * `aca plan` / `aca run` — the full corrected flow, driven from a goal.
 *
 * guard → compile spec → plan a DAG → validate → human approval → schedule →
 * execute with checkpoints → gate → write back, with every failure routed
 * through the taxonomy rather than a single retry edge.
 */
export async function runPlan(options: PlanRunOptions): Promise<number> {
  const registry = new WorkspaceRegistry();
  const ws = registry.add(options.root);

  const db = new Db(WorkspaceRegistry.dbPath(options.root));
  const events = new EventLog(db);
  const cache = new EpochCache(db, events);
  const guard = new OutputGuard({ artifactDir: WorkspaceRegistry.artifactDir(options.root) });
  const tools = new ToolRegistry();
  registerBuiltins(tools);

  const { providers, skipped } = await discoverProviders({ localOnly: options.localOnly });
  if (providers.length === 0) {
    process.stderr.write(
      c.crimson("no model provider reachable\n") +
        skipped.map((s) => `  ${s.id}: ${s.reason}\n`).join(""),
    );
    return 1;
  }

  const router = new ModelRouter(providers);
  const residency = new ResidencyManager(providers);

  if (options.model) {
    const catalogue = await router.catalogue(true);
    const match =
      catalogue.find((m) => m.id === options.model) ??
      catalogue.find((m) => m.id.toLowerCase().includes(options.model!.toLowerCase()));
    if (!match) {
      process.stderr.write(
        c.crimson(`no model matching "${options.model}". Try: aca models\n`),
      );
      db.close();
      return 1;
    }
    router.pin(match.id);
  }

  const runId = `run-${Date.now().toString(36)}`;
  events.append(runId, "run.created", { goal: options.goal, workspace: ws.name });

  // Give the planner the real tree; without it, it invents plausible paths and
  // every node's write set then fails enforcement at execution time.
  const map = workspaceMap(options.root, { maxFiles: 220, maxDepth: 4 });
  const planner = new Planner(makeGenerator(router), { workspaceMap: map });

  const progress = new Progress(!options.json && process.stdout.isTTY === true);

  if (!options.json) {
    process.stdout.write(
      `${c.dim("workspace")} ${c.bold(ws.name)}  ${c.dim(options.root)}\n` +
        `${c.ember("›")} ${c.bold(options.goal)}\n\n`,
    );
    // Name the model and whether it is cold, so a 60s VRAM load reads as
    // loading rather than hanging.
    const candidates = await router.catalogue();
    const likely = candidates.find((m) => !router.pinnedModel || m.id === router.pinnedModel);
    progress.start(
      "planning",
      likely
        ? `${likely.provider}/${likely.id}${likely.state === "cold" ? " · cold, loading" : ""}`
        : "",
    );
  }

  let result;
  try {
    result = await planner.plan(options.goal);
    progress.stop();
  } catch (err) {
    progress.stop();
    if (err instanceof PlanValidationError) {
      process.stderr.write(c.crimson(`${err.message}\n`));
    } else {
      process.stderr.write(c.crimson(`planning failed: ${(err as Error).message}\n`));
    }
    events.append(runId, "run.failed", { reason: (err as Error).message });
    db.close();
    return 1;
  }

  events.append(runId, "plan.proposed", {
    planId: result.plan.id,
    nodes: result.plan.nodes.length,
    model: result.model,
  });

  if (options.json) {
    process.stdout.write(
      JSON.stringify({ type: "plan.proposed", plan: result.plan, spec: result.spec }) + "\n",
    );
  } else {
    process.stdout.write(
      "\n" +
        renderPlanCard(result.plan, result.spec, {
          model: result.model,
          provider: result.provider,
          problems: result.problems,
          repairs: result.repairs,
        }) +
        "\n\n",
    );
  }

  if (options.dryRun) {
    db.close();
    return 0;
  }

  // The approval gate. F16: a rejection reason is captured so a replan does
  // not regenerate the same plan.
  if (!options.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(c.ember("approve & run? [a/r] "))).trim().toLowerCase();
    if (answer !== "a" && answer !== "y") {
      const reason = (await rl.question(c.dim("why? (fed into replanning) "))).trim();
      rl.close();
      events.append(runId, "plan.rejected", { reason });
      process.stdout.write(c.dim("plan rejected; nothing was executed\n"));
      db.close();
      return 0;
    }
    rl.close();
  }

  events.append(runId, "plan.approved", { planId: result.plan.id });

  // The executor needs the supervisor's meter and the supervisor needs the
  // executor, so the indirection is deliberate: they must share ONE meter or
  // the budget never sees real usage and F15 is inert in the live path.
  let execute: SupervisorHooks["executeNode"] | null = null;

  const supervisor = new RunSupervisor(
    db,
    events,
    {
      executeNode: (node, token) => {
        if (!execute) throw new Error("executor not initialised");
        return execute(node, token);
      },
      rollback: async (node: PlanNode) => {
        events.append(runId, "node.rolled_back", { nodeId: node.id }, node.id);
      },
      requestApproval: async (approval) => {
        if (options.yes) {
          return { approvalId: approval.id, granted: false, scope: "once", reason: "--yes" };
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        process.stdout.write(
          `\n${c.wheat("⚠ node needs a decision")}  ${c.bold(approval.summary)}\n  ${c.dim(approval.detail)}\n`,
        );
        const a = (await rl.question(c.wheat("[a] approve  [r] reject "))).trim().toLowerCase();
        rl.close();
        return {
          approvalId: approval.id,
          granted: a === "a",
          scope: "once" as const,
          reason: "",
        };
      },
    },
    {
      maxAttempts: 2,
      maxReviewRounds: 3,
      // Width is clamped by provider slots, not CPU count.
      concurrency: Math.max(1, Math.min(await residency.totalSlots(), 3)),
      budget: { maxTokens: options.maxTokens ?? 400_000, maxWallMs: 30 * 60_000 },
    },
  );

  execute = makeExecutor({
    root: options.root,
    runId,
    router,
    registry: tools,
    events,
    cache,
    guard,
    localOnly: options.localOnly ?? false,
    meter: supervisor.meter,
    verbose: !options.json,
    requestApproval: async (summary, detail) => {
      // F13: irreversible actions ask at execution time regardless of the
      // plan-level approval already granted.
      if (options.yes) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      process.stdout.write(
        `\n${c.wheat("⚠ approval required")}  ${c.bold(summary)}\n  ${c.dim(detail)}\n`,
      );
      const a = (await rl.question(c.wheat("[a] approve  [r] reject "))).trim().toLowerCase();
      rl.close();
      return a === "a";
    },
  });

  // esc / ctrl-c cancels and checkpoints, rather than discarding (F14).
  const onSigint = (): void => {
    process.stdout.write(c.wheat("\ncancelling — the run is checkpointed and resumable\n"));
    supervisor.cancel("interrupted");
  };
  process.on("SIGINT", onSigint);

  if (!options.json) process.stdout.write("\n" + renderDag(result.plan.nodes) + "\n\n");

  const outcome = await supervisor.run(runId, result.plan);
  process.off("SIGINT", onSigint);

  if (options.json) {
    for (const e of events.read(runId)) process.stdout.write(JSON.stringify(e) + "\n");
  } else {
    process.stdout.write("\n" + renderDag(outcome.nodes) + "\n\n");
    const u = supervisor.meter.usage;
    const status =
      outcome.status === "completed"
        ? c.moss("✓ completed")
        : outcome.status === "cancelled"
          ? c.wheat("⚠ cancelled")
          : c.crimson("✗ failed");
    process.stdout.write(
      `${status}  ${c.dim(
        `${u.tokens} tokens · $${u.costUsd.toFixed(4)} · ${(u.wallMs / 1000).toFixed(0)}s · ${events.count(runId)} events`,
      )}\n`,
    );
    if (outcome.reason) process.stdout.write(`${c.dim(outcome.reason)}\n`);
  }

  registry.touch(ws.id);
  db.close();
  return outcome.status === "completed" ? 0 : 1;
}

export type { Plan };
