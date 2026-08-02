#!/usr/bin/env node
import { resolve } from "node:path";
import { WorkspaceRegistry } from "@aca/core";
import { discoverProviders, ModelRouter, ResidencyManager } from "@aca/providers";
import { c } from "./theme.ts";
import { renderModelTable } from "./render.ts";
import { runChat } from "./chat.ts";
import { runPlan } from "./run.ts";
import { startTui } from "./tui/run-tui.tsx";
import { daemonCommand, memoryCommand, runsCommand } from "./commands/extra.ts";

const HELP = `${c.bold("aca")} — autonomous coding agent

${c.dim("USAGE")}
  aca                          interactive session (TUI)
  aca chat "<question>"        one-shot question, then exit
  aca plan "<goal>"            plan a change and show it; never executes
  aca run "<goal>"             plan, ask for approval, then execute
  aca models                   every provider and model, with capabilities
  aca doctor                   provider health, residency, slots
  aca ws list|add <path>       workspaces
  aca memory index|query|lessons  build the T3 index, search it, list T4 lessons
  aca runs [show <id>]         run history, straight from the event log
  aca daemon status            daemon health
  aca memory index|query|lessons  build the T3 index, search it, list T4 lessons
  aca runs [show <id>]         run history, straight from the event log
  aca daemon status            daemon health
  aca memory index|query|lessons  build the T3 index, search it, list T4 lessons
  aca runs [show <id>]         run history, straight from the event log
  aca daemon status            daemon health
  aca memory index|query|lessons   T3 index and T4 lessons
  aca runs [show <id>]        run history from the event log
  aca daemon status           daemon health

${c.dim("FLAGS")}
  --model <name>               pin a model for this session
  --local-only                 disable every cloud provider
  --yes                        skip the approval gate (CI)
  --json                       machine-readable output (NDJSON events)
  --max-tokens <n>             run budget, default 400000
  --plain                      readline REPL instead of the TUI
  --cwd <path>                 workspace root (default: current directory)
`;

async function main(argv: string[]): Promise<number> {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }

  const root = resolve(String(flags.get("cwd") ?? process.cwd()));
  const localOnly = flags.get("local-only") === true;
  const json = flags.get("json") === true;
  const model = typeof flags.get("model") === "string" ? String(flags.get("model")) : undefined;
  const command = positional[0];

  if (flags.get("help") || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  switch (command) {
    case undefined:
      // Interactive TUI by default; --plain falls back to the readline REPL
      // for terminals that cannot do full-screen rendering.
      if (flags.get("plain") === true || !process.stdout.isTTY) {
        return await runChat({ root, model, localOnly });
      }
      return await startTui({ root, localOnly, ...(model ? { model } : {}) });

    case "chat": {
      const question = positional.slice(1).join(" ");
      return await runChat({
        root,
        model,
        localOnly,
        json,
        ...(question ? { once: question } : {}),
      });
    }

    case "plan":
    case "run": {
      const goal = positional.slice(1).join(" ");
      if (!goal) {
        process.stderr.write(
          c.crimson(`${command} needs a goal, e.g. aca ${command} "add tests"\n`),
        );
        return 1;
      }
      const maxTokens = Number(flags.get("max-tokens"));
      return await runPlan({
        root,
        goal,
        localOnly,
        json,
        yes: flags.get("yes") === true,
        dryRun: command === "plan",
        ...(model ? { model } : {}),
        ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
      });
    }

    case "models": {
      const { providers, skipped } = await discoverProviders({ localOnly });
      const router = new ModelRouter(providers);
      const models = await router.catalogue(true);
      if (json) {
        process.stdout.write(JSON.stringify({ models, skipped }, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(renderModelTable(models) + "\n");
      for (const s of skipped) {
        process.stdout.write(`${c.slate("○")} ${c.dim(`${s.id}: ${s.reason.slice(0, 70)}`)}\n`);
      }
      return 0;
    }

    case "doctor": {
      const { providers, skipped } = await discoverProviders({ localOnly });
      const residency = new ResidencyManager(providers);
      const lines: string[] = [];

      for (const p of providers) {
        const h = await p.health();
        const models = await p.listModels().catch(() => []);
        lines.push(
          `${c.moss("✓")} ${c.bold(p.id.padEnd(10))} ${c.dim(`${p.baseUrl} · ${models.length} models · ${h.latencyMs}ms`)}`,
        );
      }
      for (const s of skipped) {
        lines.push(
          `${c.slate("○")} ${c.bold(s.id.padEnd(10))} ${c.dim(s.reason.slice(0, 60))}`,
        );
      }

      const resident = await residency.snapshot();
      lines.push("");
      lines.push(
        `${resident.length ? c.moss("✓") : c.slate("○")} ${c.bold("resident".padEnd(10))} ${c.dim(
          resident.length
            ? resident.map((r) => `${r.provider}/${r.model}`).join(", ")
            : "nothing loaded",
        )}`,
      );
      lines.push(
        `${c.moss("✓")} ${c.bold("slots".padEnd(10))} ${c.dim(String(await residency.totalSlots()))}`,
      );

      const ws = new WorkspaceRegistry().list();
      lines.push(
        `${ws.length ? c.moss("✓") : c.slate("○")} ${c.bold("workspaces".padEnd(10))} ${c.dim(
          ws.length ? ws.map((w) => w.name).join(", ") : "none registered",
        )}`,
      );

      process.stdout.write(lines.join("\n") + "\n");
      return providers.length === 0 ? 1 : 0;
    }

    case "ws": {
      const registry = new WorkspaceRegistry();
      const sub = positional[1] ?? "list";
      if (sub === "add") {
        const target = positional[2] ?? root;
        const entry = registry.add(target);
        process.stdout.write(
          `${c.moss("✓")} added ${c.bold(entry.name)} ${c.dim(entry.root)}\n`,
        );
        return 0;
      }
      const list = registry.list();
      if (json) {
        process.stdout.write(JSON.stringify(list, null, 2) + "\n");
        return 0;
      }
      if (list.length === 0) {
        process.stdout.write(c.dim("no workspaces registered. Run `aca ws add .`\n"));
        return 0;
      }
      for (const e of list) {
        const state = e.indexStale
          ? c.wheat("index stale")
          : c.moss(`${e.indexedChunks} chunks`);
        process.stdout.write(
          `${c.dim("▸")} ${c.bold(e.name.padEnd(20))} ${c.dim(e.root.padEnd(44))} ${state}\n`,
        );
      }
      return 0;
    }

    case "memory":
      return await memoryCommand({ root, localOnly, json, positional });

    case "runs":
      return await runsCommand({ root, localOnly, json, positional });

    case "daemon":
      return await daemonCommand({ root, localOnly, json, positional });

    default:
      process.stderr.write(c.crimson(`unknown command: ${command}\n\n`) + HELP);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: Error) => {
    process.stderr.write(c.crimson(`${err.message}\n`));
    process.exit(1);
  });
