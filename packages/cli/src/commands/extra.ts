import { c } from "../theme.ts";
import { indexWorkspace, openWorkspace } from "../workspace-service.ts";

export interface ExtraOptions {
  root: string;
  localOnly: boolean;
  json: boolean;
  positional: string[];
}

/**
 * The commands that read state rather than drive a run.
 *
 * Split out of `bin.ts` because the switch there was becoming the largest
 * thing in the package, and these share a shape: open the workspace, read
 * something, render it two ways.
 */
export async function memoryCommand(options: ExtraOptions): Promise<number> {
  const services = await openWorkspace(options.root, { localOnly: options.localOnly });
  const sub = options.positional[1] ?? "stats";

  try {
    if (sub === "index") {
      const out = await indexWorkspace(services, (p) => {
        if (!options.json && process.stdout.isTTY) {
          process.stdout.write(
            `\r\x1b[2K${c.dim(`indexing ${p.done}/${p.total}`)} ${p.file.slice(0, 48)}`,
          );
        }
      });
      if (!options.json && process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
      process.stdout.write(
        options.json
          ? JSON.stringify(out) + "\n"
          : `${c.moss("✓")} ${out.files} files · ${out.chunks} chunks · ${out.skipped} skipped\n`,
      );
      return 0;
    }

    if (sub === "query") {
      const q = options.positional.slice(2).join(" ");
      if (!q) {
        process.stderr.write(c.crimson("memory query needs a search string\n"));
        return 1;
      }
      const hits = await services.memory.search(q, 8);
      if (options.json) {
        process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
        return 0;
      }
      if (hits.length === 0) {
        process.stdout.write(c.dim("no matches — run `aca memory index` first\n"));
        return 0;
      }
      for (const h of hits) {
        const head =
          h.content
            .split("\n")
            .find((l) => l.trim())
            ?.slice(0, 68) ?? "";
        process.stdout.write(
          `${c.ember(h.source)}${c.dim(`:${h.startLine}`)}  ${h.symbol ? c.bold(h.symbol) + "  " : ""}${c.dim(head)}\n`,
        );
      }
      return 0;
    }

    if (sub === "lessons") {
      const lessons = services.memory.allLessons();
      if (options.json) {
        process.stdout.write(JSON.stringify(lessons, null, 2) + "\n");
        return 0;
      }
      if (lessons.length === 0) {
        process.stdout.write(c.dim("no lessons recorded yet\n"));
        return 0;
      }
      for (const l of lessons) {
        // Unconfirmed lessons are shown but marked: they are recorded and not
        // yet injected, and that distinction is the whole design.
        process.stdout.write(
          `${l.confirmed ? c.moss("✓") : c.slate("○")} ${c.bold(l.trigger)}  ${c.dim(l.lesson)} ${c.dim(`(${l.wins}/${l.uses})`)}\n`,
        );
      }
      return 0;
    }

    const stats = services.memory.indexStats();
    process.stdout.write(
      options.json
        ? JSON.stringify(stats) + "\n"
        : `${stats.files} files · ${stats.chunks} chunks · ${stats.embedded} embedded\n`,
    );
    return 0;
  } finally {
    services.close();
  }
}

export async function runsCommand(options: ExtraOptions): Promise<number> {
  const services = await openWorkspace(options.root, { localOnly: options.localOnly });
  try {
    if (options.positional[1] === "show" && options.positional[2]) {
      const events = services.events.read(String(options.positional[2]));
      process.stdout.write(
        options.json
          ? events.map((e) => JSON.stringify(e)).join("\n") + "\n"
          : events
              .map(
                (e) =>
                  `${String(e.seq).padStart(4)} ${c.dim((e.nodeId ?? "-").padEnd(16))} ${c.bold(e.type.padEnd(18))} ${c.dim(JSON.stringify(e.payload).slice(0, 60))}`,
              )
              .join("\n") + "\n",
      );
      return 0;
    }

    const runs = services.db.all(
      "SELECT run_id, MIN(ts) AS started, COUNT(*) AS events FROM events GROUP BY run_id ORDER BY started DESC LIMIT 25",
    );
    if (options.json) {
      process.stdout.write(JSON.stringify(runs, null, 2) + "\n");
      return 0;
    }
    if (runs.length === 0) {
      process.stdout.write(c.dim("no runs recorded in this workspace\n"));
      return 0;
    }
    for (const r of runs) {
      process.stdout.write(
        `${c.bold(String(r["run_id"]).padEnd(16))} ${c.dim(new Date(Number(r["started"])).toLocaleString())} ${c.dim(`${r["events"]} events`)}\n`,
      );
    }
    return 0;
  } finally {
    services.close();
  }
}

export async function daemonCommand(options: ExtraOptions): Promise<number> {
  const { DaemonClient } = await import("@aca/daemon");
  const sub = options.positional[1] ?? "status";
  const client = await DaemonClient.connect();

  if (!client) {
    process.stdout.write(
      `${c.slate("○")} ${c.dim("daemon not running — start it with: pnpm daemon")}\n`,
    );
    return 1;
  }

  try {
    if (sub === "status") {
      const status = (await client.call("daemon.status")) as Record<string, unknown>;
      process.stdout.write(
        options.json
          ? JSON.stringify(status, null, 2) + "\n"
          : `${c.moss("✓")} ${c.bold("daemon")} ${c.dim(
              `pid ${status["pid"]} · ${status["clients"]} client(s) · ${Math.round(Number(status["uptimeMs"]) / 1000)}s uptime`,
            )}\n`,
      );
      return 0;
    }
    process.stderr.write(c.crimson(`unknown daemon subcommand: ${sub}\n`));
    return 1;
  } finally {
    client.close();
  }
}
