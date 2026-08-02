import { ScorecardStore } from "@aca/core";
import { ProbeSuite } from "@aca/providers";
import { c } from "../theme.ts";
import { openWorkspace } from "../workspace-service.ts";
import type { ExtraOptions } from "./extra.ts";

/**
 * Measures what models can actually do, then persists the scorecards.
 *
 * Until this has run, routing filters on numbers the provider claimed rather
 * than numbers anyone checked. `qwen3.5:0.8b` advertises a 262k window and
 * cannot retrieve a fact past roughly 32k; a model tagged `tools` may emit
 * malformed calls a third of the time. Both surface as node failures deep in a
 * run, where they look like the agent being bad rather than the router picking
 * wrong.
 *
 * Costs a few minutes per model, once.
 */
export async function probeCommand(options: ExtraOptions): Promise<number> {
  const services = await openWorkspace(options.root, { localOnly: options.localOnly });
  const store = new ScorecardStore(services.db);
  const suite = new ProbeSuite({ trials: 3 });

  try {
    const only = options.positional[2];
    const models = (await services.router.catalogue(true)).filter(
      (m) => (!only || m.id.toLowerCase().includes(only.toLowerCase())) && !/embed/i.test(m.id),
    );

    if (models.length === 0) {
      process.stderr.write(c.crimson("no models to probe\n"));
      return 1;
    }

    for (const [i, m] of models.entries()) {
      if (!options.json) {
        process.stdout.write(
          `${c.dim(`[${i + 1}/${models.length}]`)} ${c.bold(m.id)} ${c.dim(m.provider)}\n`,
        );
      }
      const provider = services.router.provider(m.provider);
      if (!provider) continue;

      try {
        const card = await suite.run(m, provider);
        store.put(card);

        if (!options.json) {
          // Flag the gap loudly when measurement contradicts the advert — that
          // divergence is the entire reason this command exists.
          const drift = card.realContext < m.caps.contextWindow;
          const ctx = drift
            ? `${c.crimson(fmt(card.realContext))} ${c.dim(`(claims ${fmt(m.caps.contextWindow)})`)}`
            : fmt(card.realContext);
          process.stdout.write(
            `    ${c.moss("✓")} ${c.dim("tools")} ${toolColour(card.tools)} · ` +
              `${c.dim("ctx")} ${ctx} · ` +
              `${c.dim("speed")} ${card.tokPerSec.toFixed(0)} tok/s · ` +
              `${c.dim("reliability")} ${reliabilityColour(card.reliability)}\n`,
          );
        }
      } catch (err) {
        process.stdout.write(`    ${c.crimson("✗")} ${(err as Error).message.slice(0, 70)}\n`);
      }
    }

    if (options.json) {
      process.stdout.write(JSON.stringify(store.all(), null, 2) + "\n");
    } else {
      process.stdout.write(
        `\n${c.dim("scorecards saved — routing now filters on measured capabilities")}\n`,
      );
    }
    return 0;
  } finally {
    services.close();
  }
}

function fmt(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}k` : String(n);
}

function toolColour(tools: string): string {
  if (tools === "native") return c.moss(tools);
  if (tools === "shim") return c.wheat(tools);
  return c.crimson(tools);
}

function reliabilityColour(r: number): string {
  const text = r.toFixed(2);
  if (r >= 0.8) return c.moss(text);
  if (r >= 0.5) return c.wheat(text);
  return c.crimson(text);
}
