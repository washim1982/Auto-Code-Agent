import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fold, WorkspaceRegistry } from "@aca/core";
import type { AcaEvent } from "@aca/protocol";
import { indexWorkspace, openWorkspace, treeFor, type WorkspaceServices } from "@aca/cli";
import type { Daemon } from "./server.ts";
import { notify } from "./rpc.ts";
import { applyScorecards, registerSessionMethods } from "./methods-session.ts";

/**
 * Keeps one set of services per workspace, shared across clients.
 *
 * Two clients opening the same repo must land on the same database handle;
 * two `Db` instances against one SQLite file would each hold their own
 * connection and see each other's writes only after a checkpoint, which is
 * exactly the kind of drift the daemon exists to prevent.
 */
class WorkspacePool {
  private open = new Map<string, WorkspaceServices>();

  async get(root: string): Promise<WorkspaceServices> {
    const key = resolve(root);
    const existing = this.open.get(key);
    if (existing) return existing;
    const services = await openWorkspace(key);
    // Fold any persisted measurements over the advertised capabilities before
    // the router is used for anything.
    applyScorecards(services);
    this.open.set(key, services);
    return services;
  }

  closeAll(): void {
    for (const s of this.open.values()) s.close();
    this.open.clear();
  }

  get roots(): string[] {
    return [...this.open.keys()];
  }
}

export interface MethodContext {
  pool: WorkspacePool;
  daemon: Daemon;
}

export function registerMethods(daemon: Daemon): { pool: WorkspacePool } {
  const pool = new WorkspacePool();
  const registry = new WorkspaceRegistry();
  registerSessionMethods({ daemon, get: (path) => pool.get(path) });

  daemon.method("daemon.status", async () => ({
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    clients: daemon.clientCount,
    openWorkspaces: pool.roots,
    pendingApprovals: daemon.approvals.outstanding.length,
  }));

  // ---------------------------------------------------------- workspaces

  daemon.method("workspace.list", async () => registry.list());

  daemon.method("workspace.open", async (params) => {
    const root = String(params["path"] ?? process.cwd());
    const services = await pool.get(root);
    return {
      id: services.workspaceId,
      name: services.name,
      root: services.root,
      branch: services.branch,
      index: services.memory.indexStats(),
      providers: {
        up: (await services.router.catalogue()).length,
        skipped: services.skippedProviders,
      },
    };
  });

  daemon.method("workspace.forget", async (params) => {
    registry.forget(String(params["id"]));
    return { ok: true };
  });

  daemon.method("workspace.index", async (params, ctx) => {
    const services = await pool.get(String(params["path"] ?? process.cwd()));
    const result = await indexWorkspace(services, (p) => {
      // Progress goes to the caller only; a full-repo index would otherwise
      // spam every attached client with thousands of frames.
      ctx.send(notify("index.progress", { root: services.root, ...p }));
    });
    return result;
  });

  daemon.method("workspace.status", async (params) => {
    const services = await pool.get(String(params["path"] ?? process.cwd()));
    return {
      root: services.root,
      branch: services.branch,
      index: services.memory.indexStats(),
      locks: services.db.all("SELECT resource, node_id, parked FROM locks"),
    };
  });

  // ---------------------------------------------------------------- files

  daemon.method("files.tree", async (params) => {
    const services = await pool.get(String(params["path"] ?? process.cwd()));
    const runId = params["runId"] ? String(params["runId"]) : undefined;
    return treeFor(services, runId);
  });

  daemon.method("files.read", async (params) => {
    const services = await pool.get(String(params["path"] ?? process.cwd()));
    const file = String(params["file"] ?? "");
    // Path containment is enforced here as well as in the tool layer: this
    // endpoint is reachable by any attached client, not just an agent.
    const abs = resolve(services.root, file);
    if (!abs.startsWith(resolve(services.root))) throw new Error("path escapes the workspace");
    return { file, content: readFileSync(abs, "utf8") };
  });

  // --------------------------------------------------------------- models

  daemon.method("models.list", async (params) => {
    const services = await pool.get(String(params["path"] ?? process.cwd()));
    return await services.router.catalogue(Boolean(params["refresh"]));
  });

  daemon.method("models.residency", async (params) => {
    const services = await pool.get(String(params["path"] ?? process.cwd()));
    return {
      resident: await services.residency.snapshot(),
      slots: await services.residency.totalSlots(),
    };
  });

  // --------------------------------------------------------------- memory

  daemon.method("memory.query", async (params) => {
    const services = await pool.get(String(params["path"] ?? process.cwd()));
    return await services.memory.search(
      String(params["q"] ?? ""),
      Number(params["limit"] ?? 8),
    );
  });

  daemon.method("memory.lessons", async (params) => {
    const services = await pool.get(String(params["path"] ?? process.cwd()));
    return services.memory.allLessons();
  });

  daemon.method("memory.forget", async (params) => {
    const services = await pool.get(String(params["path"] ?? process.cwd()));
    services.memory.forgetLesson(String(params["id"]));
    return { ok: true };
  });

  // ----------------------------------------------------------------- runs

  daemon.method("run.list", async (params) => {
    const services = await pool.get(String(params["path"] ?? process.cwd()));
    return services.db.all(
      "SELECT DISTINCT run_id, MIN(ts) AS started, MAX(ts) AS ended, COUNT(*) AS events FROM events GROUP BY run_id ORDER BY started DESC LIMIT 50",
    );
  });

  daemon.method("run.events", async (params) => {
    const services = await pool.get(String(params["path"] ?? process.cwd()));
    return services.events.read(String(params["runId"]), Number(params["fromSeq"] ?? 0));
  });

  /** Run state is a fold over the log, so "state at seq N" is free (F18). */
  daemon.method("run.state", async (params) => {
    const services = await pool.get(String(params["path"] ?? process.cwd()));
    const events = services.events.read(String(params["runId"]));
    const upTo = params["upToSeq"] ? Number(params["upToSeq"]) : Infinity;
    const state = fold(events.filter((e) => (e.seq ?? 0) <= upTo));
    return {
      runId: state.runId,
      status: state.status,
      tokens: state.tokens,
      costUsd: state.costUsd,
      lastSeq: state.lastSeq,
      locksHeld: [...state.locksHeld],
      pendingApprovals: state.pendingApprovals,
      nodes: [...state.nodes.values()],
    };
  });

  daemon.method("run.subscribe", async (params, ctx) => {
    const services = await pool.get(String(params["path"] ?? process.cwd()));
    const runId = params["runId"] ? String(params["runId"]) : null;

    const unsubscribe = services.events.subscribe((e: AcaEvent) => {
      if (runId && e.runId !== runId) return;
      ctx.send(notify("event", { event: e }));
    });
    // Sockets are per-client and short-lived relative to the daemon; dropping
    // the listener on close is what stops these accumulating. This used to be
    // `setTimeout(() => unsubscribe, 0)`, which builds a closure returning the
    // disposer and never calls it — so every reconnect left a live listener and
    // the next run was delivered once per past connection.
    ctx.onClose(unsubscribe);
    return { subscribed: true, runId };
  });

  // ------------------------------------------------------------ approvals

  daemon.method("approval.respond", async (params) => {
    const handled = daemon.approvals.respond({
      approvalId: String(params["approvalId"]),
      granted: Boolean(params["granted"]),
      scope: (params["scope"] === "run" ? "run" : "once") as "run" | "once",
      reason: String(params["reason"] ?? ""),
    });
    // A false result is normal, not an error: another client answered first.
    return { handled };
  });

  daemon.method("approval.pending", async () => daemon.approvals.outstanding);

  // ----------------------------------------------------------------- misc

  daemon.method("artifact.read", async (params) => {
    const services = await pool.get(String(params["path"] ?? process.cwd()));
    const id = String(params["id"]);
    const file = join(WorkspaceRegistry.artifactDir(services.root), `${id}.txt`);
    return { id, content: readFileSync(file, "utf8") };
  });

  return { pool };
}

export { WorkspacePool };
