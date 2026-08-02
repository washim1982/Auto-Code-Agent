import { createHash } from "node:crypto";
import type { Db } from "../db/client.ts";
import type { EventLog } from "../events/log.ts";
import { resourcesIntersect } from "../scheduler/resource.ts";

export interface CacheKeyInput {
  tool: string;
  args: Record<string, unknown>;
  /** Resources this call reads. Their epochs become part of the key. */
  reads: readonly string[];
}

/**
 * Epoch-keyed idempotent cache (flow review F7).
 *
 * The original flow served a cache hit whenever the call was "idempotent",
 * with no invalidation anywhere. That is only sound if nothing has mutated the
 * underlying resource since the entry was written — so a mutating write to `x`
 * followed by a cached `read_file(x)` serves stale bytes, silently.
 *
 * Fix: every resource carries a monotonic epoch, bumped on each committed
 * write. The cache key includes the epoch of every resource the call reads, so
 * a write makes prior keys unreachable rather than requiring us to hunt down
 * and delete them.
 */
export class EpochCache {
  private db: Db;
  private events: EventLog;

  constructor(db: Db, events: EventLog) {
    this.db = db;
    this.events = events;
  }

  epochOf(resource: string): number {
    const row = this.db.get("SELECT epoch FROM resource_epochs WHERE resource = ?", resource);
    return row ? Number(row["epoch"]) : 0;
  }

  /**
   * Bumps the epoch of every resource intersecting `written`.
   *
   * Intersection, not equality: writing `src/mw/rateLimit.ts` must invalidate
   * a cached read of `src/mw/**`.
   */
  bump(runId: string, written: readonly string[], nodeId: string | null = null): void {
    const known = this.db
      .all("SELECT resource FROM resource_epochs")
      .map((r) => String(r["resource"]));

    const toBump = new Set<string>(written);
    for (const k of known) {
      if (written.some((w) => resourcesIntersect(k, w))) toBump.add(k);
    }

    for (const resource of toBump) {
      this.db.run(
        `INSERT INTO resource_epochs (resource, epoch) VALUES (?, 1)
         ON CONFLICT(resource) DO UPDATE SET epoch = epoch + 1`,
        resource,
      );
      this.events.append(
        runId,
        "epoch.bumped",
        { resource, epoch: this.epochOf(resource) },
        nodeId,
      );
    }

    if (toBump.size > 0) {
      this.events.append(
        runId,
        "cache.invalidated",
        { resources: [...toBump], reason: "committed write" },
        nodeId,
      );
    }
  }

  key(input: CacheKeyInput): string {
    const epochs = [...input.reads]
      .sort()
      .map((r) => `${r}@${this.epochOf(r)}`)
      .join("|");
    const payload = JSON.stringify({
      tool: input.tool,
      args: sortKeys(input.args),
      epochs,
    });
    return createHash("sha256").update(payload).digest("hex");
  }

  get(input: CacheKeyInput): unknown | undefined {
    const k = this.key(input);
    const row = this.db.get("SELECT result, expires_at FROM tool_cache WHERE key = ?", k);
    if (!row) return undefined;
    const expires = row["expires_at"];
    if (expires != null && Number(expires) < Date.now()) {
      this.db.run("DELETE FROM tool_cache WHERE key = ?", k);
      return undefined;
    }
    return JSON.parse(String(row["result"])) as unknown;
  }

  /**
   * Declares a resource so `bump` can find it later.
   *
   * Without this, a cached read of `src/**` is invisible to the epoch table
   * until something writes to that exact string — so a write to
   * `src/mw/rateLimit.ts` would not invalidate it and we would serve stale
   * bytes. Registering at cache-write time guarantees anything cacheable is
   * discoverable.
   */
  private register(resources: readonly string[]): void {
    for (const r of resources) {
      this.db.run(
        "INSERT INTO resource_epochs (resource, epoch) VALUES (?, 0) ON CONFLICT(resource) DO NOTHING",
        r,
      );
    }
  }

  set(input: CacheKeyInput, result: unknown, ttlMs?: number): void {
    const k = this.key(input);
    this.register(input.reads);
    this.db.run(
      "INSERT OR REPLACE INTO tool_cache (key, tool, result, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      k,
      input.tool,
      JSON.stringify(result ?? null),
      Date.now(),
      ttlMs ? Date.now() + ttlMs : null,
    );
  }

  size(): number {
    return Number(this.db.get("SELECT COUNT(*) AS c FROM tool_cache")?.["c"] ?? 0);
  }
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) {
    const v = o[k];
    out[k] =
      v && typeof v === "object" && !Array.isArray(v)
        ? sortKeys(v as Record<string, unknown>)
        : v;
  }
  return out;
}
