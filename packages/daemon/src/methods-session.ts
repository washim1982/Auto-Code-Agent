import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChatThread, ScorecardStore } from "@aca/core";
import { DEFAULT_MATRIX, gitStatus } from "@aca/tools";
import { ProbeSuite } from "@aca/providers";
import type { WorkspaceServices } from "@aca/cli";
import type { Daemon } from "./server.ts";
import { notify, type RpcNotification } from "./rpc.ts";
import { SessionManager } from "./sessions.ts";

export interface SessionMethodDeps {
  daemon: Daemon;
  get(path: string): Promise<WorkspaceServices>;
}

/**
 * The methods that let a client *drive* the engine rather than observe it.
 *
 * Split from `methods.ts` because those are all read-shaped — open a
 * workspace, list something, fold the log — whereas these start work, and the
 * difference is worth seeing in the file layout.
 */
export function registerSessionMethods(deps: SessionMethodDeps): SessionManager {
  const { daemon, get } = deps;
  const sessions = new SessionManager();

  // Approvals raised anywhere in the engine route through the broker, so any
  // attached client can answer and the first response wins.
  sessions.approvals = (approval) => daemon.approvals.request(approval);
  const broadcast = (n: RpcNotification): void => daemon.approvals.broadcast(n);

  // ------------------------------------------------------------------ chat

  daemon.method("chat.create", async (params) => {
    const services = await get(String(params["path"] ?? process.cwd()));
    return { threadId: `chat-${Date.now().toString(36)}`, workspace: services.name };
  });

  daemon.method("chat.send", async (params) => {
    const services = await get(String(params["path"] ?? process.cwd()));
    return await sessions.chat(
      services,
      String(params["threadId"] ?? "default"),
      String(params["text"] ?? ""),
      broadcast,
      {
        ...(params["model"] ? { model: String(params["model"]) } : {}),
        localOnly: services.config.router.privacy === "local-only",
      },
    );
  });

  daemon.method("chat.history", async (params) => {
    const services = await get(String(params["path"] ?? process.cwd()));
    return new ChatThread(services.db, String(params["threadId"] ?? "default")).messages();
  });

  // -------------------------------------------------------------- planning

  daemon.method("run.plan", async (params) => {
    const services = await get(String(params["path"] ?? process.cwd()));
    return await sessions.plan(
      services,
      String(params["goal"] ?? ""),
      broadcast,
      String(params["threadId"] ?? "default"),
    );
  });

  daemon.method(
    "run.start",
    async (params) => await sessions.start(String(params["runId"]), broadcast),
  );

  daemon.method("run.reject", async (params) => {
    sessions.reject(String(params["runId"]), String(params["reason"] ?? ""));
    return { ok: true };
  });

  daemon.method("run.cancel", async (params) => ({
    cancelled: sessions.cancel(String(params["runId"])),
  }));

  daemon.method("run.active", async () => sessions.active());

  daemon.method(
    "run.nodes",
    async (params) => sessions.get(String(params["runId"]))?.nodes ?? [],
  );

  // ------------------------------------------------------------------ diff

  /**
   * Changed files with before/after.
   *
   * "Before" comes from git rather than the checkpoint store: checkpoints are
   * disposed once a node completes, and what a reviewer wants to see is the
   * diff against the committed tree, not against a mid-run snapshot.
   */
  daemon.method("diff.forRun", async (params) => {
    const services = await get(String(params["path"] ?? process.cwd()));
    const runId = params["runId"] ? String(params["runId"]) : null;

    const changed = new Set<string>();
    if (runId) {
      for (const e of services.events.read(runId)) {
        for (const w of (e.payload["writes"] as string[] | undefined) ?? []) changed.add(w);
      }
    }
    const status = gitStatus(services.root);
    for (const [path] of status) changed.add(path);

    return [...changed].map((file) => ({
      file,
      git: status.get(file) ?? null,
      before: gitShow(services.root, file),
      after: readOrEmpty(join(services.root, file)),
    }));
  });

  // -------------------------------------------------------------- settings

  daemon.method("config.get", async (params) => {
    const services = await get(String(params["path"] ?? process.cwd()));
    return { config: services.config, permissions: DEFAULT_MATRIX };
  });

  daemon.method("config.set", async (params) => {
    const services = await get(String(params["path"] ?? process.cwd()));
    const dir = join(services.root, ".aca");
    mkdirSync(dir, { recursive: true });
    // Written to the WORKSPACE layer, which sits above the user layer — so a
    // repo can pin `local-only` and have it hold for everyone who opens it.
    writeFileSync(join(dir, "config.json"), JSON.stringify(params["config"] ?? {}, null, 2));
    return { ok: true, note: "reopen the workspace for this to take effect" };
  });

  // ---------------------------------------------------------------- probes

  /**
   * Measures what models can actually do, then tells the router.
   *
   * Until this runs, routing filters on numbers the provider claimed rather
   * than numbers anyone checked — which is how a 0.8B model advertising a 262k
   * window gets shortlisted for work needing 48k of real recall.
   */
  daemon.method("models.probe", async (params, ctx) => {
    const services = await get(String(params["path"] ?? process.cwd()));
    const store = new ScorecardStore(services.db);
    const suite = new ProbeSuite({ trials: Number(params["trials"] ?? 3) });
    const only = params["model"] ? String(params["model"]) : null;

    const models = (await services.router.catalogue(true)).filter(
      (m) => (!only || m.id === only) && !/embed/i.test(m.id),
    );

    const cards = [];
    for (const [i, m] of models.entries()) {
      ctx.send(notify("probe.progress", { done: i, total: models.length, model: m.id }));
      const provider = services.router.provider(m.provider);
      if (!provider) continue;
      try {
        const card = await suite.run(m, provider);
        store.put(card);
        cards.push(card);
        ctx.send(notify("probe.result", { model: m.id, card }));
      } catch (err) {
        ctx.send(notify("probe.failed", { model: m.id, error: (err as Error).message }));
      }
    }

    applyScorecards(services);
    return { probed: cards.length, cards };
  });

  daemon.method("models.scorecards", async (params) => {
    const services = await get(String(params["path"] ?? process.cwd()));
    return new ScorecardStore(services.db).all();
  });

  return sessions;
}

/** Folds persisted measurements over the router's advertised capabilities. */
export function applyScorecards(services: WorkspaceServices): number {
  const cards = new ScorecardStore(services.db).index();
  services.router.applyScorecards(
    [...cards].map(([key, c]) => [
      key,
      {
        realContext: c.realContext,
        tools: c.tools,
        structured: c.structured,
        reliability: c.reliability,
      },
    ]),
  );
  return cards.size;
}

function gitShow(root: string, file: string): string {
  try {
    return execSync(`git show HEAD:${JSON.stringify(file)}`, {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).slice(0, 60_000);
  } catch {
    return ""; // new file, or not a repo
  }
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8").slice(0, 60_000);
  } catch {
    return ""; // deleted
  }
}
