import { createInterface } from "node:readline/promises";
import { InputGuard, Planner, PlanValidationError } from "@aca/core";
import { workspaceMap } from "@aca/tools";
import type { Plan } from "@aca/protocol";
import { c } from "./theme.ts";
import { renderDag } from "./render.ts";
import { renderPlanCard } from "./plan-card.ts";
import { makeGenerator } from "./generator.ts";
import { Progress } from "./progress.ts";
import { buildRunner, reply } from "./supervisor.ts";
import { openWorkspace } from "./workspace-service.ts";

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
  // One bundle for the whole run, so the CLI, daemon and desktop cannot end up
  // holding different database handles for the same repo.
  const services = await openWorkspace(options.root, {
    ...(options.localOnly ? { localOnly: true } : {}),
    ...(options.model ? { pinnedModel: options.model } : {}),
  });
  // The rest of the bundle is wired by `buildRunner`, which is the one place
  // the supervisor and its executor get assembled.
  const { events, router } = services;
  const ws = { name: services.name, id: services.workspaceId };

  const catalogue = await router.catalogue(true);
  if (catalogue.length === 0) {
    process.stderr.write(
      c.crimson("no model provider reachable\n") +
        services.skippedProviders.map((s) => `  ${s.id}: ${s.reason}\n`).join(""),
    );
    services.close();
    return 1;
  }

  if (options.model && !router.pinnedModel) {
    process.stderr.write(c.crimson(`no model matching "${options.model}". Try: aca models\n`));
    services.close();
    return 1;
  }

  // The first box in the flow: guard the input before anything sees it.
  const inputGuard = new InputGuard({
    redactPii: !options.localOnly,
    workspaceRoot: options.root,
    enforceScope: true,
  });
  const guarded = inputGuard.inspect(options.goal);
  if (guarded.blocked) {
    process.stderr.write(
      c.crimson(`${guarded.reason}
`),
    );
    services.close();
    return 1;
  }
  const goal = guarded.text;

  const runId = `run-${Date.now().toString(36)}`;
  events.append(runId, "run.created", { goal, workspace: ws.name });
  for (const f of guarded.findings) {
    events.append(runId, "guard.blocked", {
      kind: f.kind,
      label: f.label,
      severity: f.severity,
    });
    if (!options.json) {
      process.stdout.write(`${c.wheat("⚠")} ${c.dim(`input guard: ${f.label} (${f.severity})`)}
`);
    }
  }

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
    result = await planner.plan(goal);
    progress.stop();
  } catch (err) {
    progress.stop();
    if (err instanceof PlanValidationError) {
      process.stderr.write(c.crimson(`${err.message}\n`));
    } else {
      process.stderr.write(c.crimson(`planning failed: ${(err as Error).message}\n`));
    }
    events.append(runId, "run.failed", { reason: (err as Error).message });
    services.close();
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
    services.close();
    return 0;
  }

  // The approval gate. F16: a rejection reason is captured so a replan does
  // not regenerate the same plan.
  if (!options.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    /**
     * Re-asks until the answer is one it understands.
     *
     * This used to treat everything that was not `a` or `y` as a rejection, so
     * a typo threw away a plan that took minutes and a model call to produce —
     * and the prompt read `[a/r]`, which invites typing exactly that. Rejection
     * is destructive and one-way; it should take a deliberate keystroke, not be
     * the default for anything unrecognised.
     */
    let approved = false;
    for (;;) {
      const answer = (await rl.question(c.ember("approve & run? [a]pprove / [r]eject ")))
        .trim()
        .toLowerCase();

      if (answer === "a" || answer === "y" || answer === "approve") {
        approved = true;
        break;
      }
      if (answer === "r" || answer === "n" || answer === "reject") break;

      process.stdout.write(
        c.dim(`  "${answer}" is not a/r — nothing has been approved or rejected yet\n`),
      );
    }

    if (!approved) {
      const reason = (await rl.question(c.dim("why? (fed into replanning) "))).trim();
      rl.close();
      events.append(runId, "plan.rejected", { reason });
      process.stdout.write(c.dim("plan rejected; nothing was executed\n"));
      services.close();
      return 0;
    }
    rl.close();
  }

  events.append(runId, "plan.approved", { planId: result.plan.id });

  /** One prompt shape for both gates, so they cannot drift apart. */
  const ask = async (title: string, summary: string, detail: string): Promise<boolean> => {
    if (options.yes) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(
      `\n${c.wheat(title)}  ${c.bold(summary)}\n  ${c.dim(detail)}\n`,
    );
    const a = (await rl.question(c.wheat("[a] approve  [r] reject "))).trim().toLowerCase();
    rl.close();
    return a === "a";
  };

  const supervisor = await buildRunner({
    services,
    runId,
    ...(options.localOnly ? { localOnly: true } : {}),
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
    ...(options.json ? {} : { verbose: true }),
    requestApproval: async (approval) =>
      reply(
        approval,
        await ask("⚠ node needs a decision", approval.summary, approval.detail),
        "once",
        options.yes ? "--yes" : "",
      ),
    // F13: irreversible actions ask at execution time regardless of the
    // plan-level approval already granted.
    requestIrreversible: async (summary, detail) =>
      await ask("⚠ approval required", summary, detail),
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

  services.registry.touch(ws.id);
  services.close();
  return outcome.status === "completed" ? 0 : 1;
}

export type { Plan };
