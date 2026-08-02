import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { MIGRATIONS } from "./schema.ts";

/**
 * `node:sqlite` is a Node builtin, but Vite 5's builtin list predates it and
 * rewrites the specifier to a bare `sqlite` package that does not exist. Going
 * through createRequire keeps the import opaque to the bundler and resolves
 * identically under plain Node, vitest, and Electron.
 */
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = InstanceType<typeof DatabaseSync>;

export type Row = Record<string, unknown>;

/**
 * Thin synchronous wrapper over node:sqlite.
 *
 * Synchronous is the right shape here: run state is a fold over an event log,
 * and a fold that can suspend mid-way is a fold that can interleave with a
 * concurrent append. Keeping reads synchronous removes that whole class of bug.
 */
export class Db {
  readonly raw: DatabaseSync;

  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec(
      "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER)",
    );
    const applied = new Set(
      (this.raw.prepare("SELECT version FROM _migrations").all() as Row[]).map((r) =>
        Number(r["version"]),
      ),
    );
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.raw.exec(m.sql);
      this.raw
        .prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)")
        .run(m.version, Date.now());
    }
  }

  all(sql: string, ...params: unknown[]): Row[] {
    return this.raw.prepare(sql).all(...(params as never[])) as Row[];
  }

  get(sql: string, ...params: unknown[]): Row | undefined {
    return this.raw.prepare(sql).get(...(params as never[])) as Row | undefined;
  }

  run(sql: string, ...params: unknown[]): void {
    this.raw.prepare(sql).run(...(params as never[]));
  }

  /** Runs `fn` inside an IMMEDIATE transaction; rolls back on throw. */
  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }
}
