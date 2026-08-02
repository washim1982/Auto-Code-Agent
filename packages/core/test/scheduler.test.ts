import { describe, expect, it } from "vitest";
import { PlanNode } from "@aca/protocol";
import { Db } from "../src/db/client.ts";
import { EventLog } from "../src/events/log.ts";
import { LockManager } from "../src/scheduler/locks.ts";
import { cascadeInvalidate } from "../src/scheduler/cascade.ts";
import {
  canonicalSort,
  normalizeResource,
  resourcesIntersect,
  setsIntersect,
} from "../src/scheduler/resource.ts";
import { classify, WriteSetViolation } from "../src/recovery/classifier.ts";
import { ReviewLoop, semanticHash } from "../src/review/loop.ts";
import { EpochCache } from "../src/cache/epoch.ts";
import { mulberry32, pick } from "./helpers.ts";

function ctx() {
  const db = new Db(":memory:");
  const events = new EventLog(db);
  return { db, events, locks: new LockManager(db, events), cache: new EpochCache(db, events) };
}

function node(id: string, over: Partial<PlanNode> = {}): PlanNode {
  return PlanNode.parse({
    id,
    title: id,
    sets: { read: [], write: [] },
    ...over,
  });
}

// ---------------------------------------------------------------- F3 resources

describe("resource intersection (F3)", () => {
  it("normalises separators, ./ prefixes and trailing slashes to one form", () => {
    expect(normalizeResource("./src\\mw//rateLimit.ts")).toBe("src/mw/rateLimit.ts");
    expect(normalizeResource("src/mw/")).toBe("src/mw");
  });

  it("treats a directory as conflicting with files beneath it", () => {
    expect(resourcesIntersect("src", "src/api/x.ts")).toBe(true);
    expect(resourcesIntersect("src/api/x.ts", "src")).toBe(true);
  });

  it("does not conflict on a shared name prefix that is not a path prefix", () => {
    // The bug string equality *and* naive startsWith both get wrong.
    expect(resourcesIntersect("src/mw", "src/mwx/y.ts")).toBe(false);
  });

  it("expands globs to the subtree they cover", () => {
    expect(resourcesIntersect("src/**", "src/mw/rateLimit.ts")).toBe(true);
    expect(resourcesIntersect("src/*", "src/mw/rateLimit.ts")).toBe(true);
    expect(resourcesIntersect("test/**", "src/mw/rateLimit.ts")).toBe(false);
  });

  it("produces a stable total order regardless of input order or spelling", () => {
    const a = canonicalSort(["./b/x.ts", "a", "b\\x.ts"]);
    const b = canonicalSort(["b/x.ts", "a"]);
    expect(a).toEqual(b);
  });

  it("detects set-level intersection", () => {
    expect(setsIntersect(["src/**"], ["src/mw/a.ts"])).toBe(true);
    expect(setsIntersect(["docs/**"], ["src/mw/a.ts"])).toBe(false);
  });
});

// -------------------------------------------------------------------- F3 locks

describe("lock manager (F3)", () => {
  it("blocks a conflicting write and reports the holder", () => {
    const { locks } = ctx();
    const first = locks.acquire({ runId: "r", nodeId: "n1", write: ["src/mw/a.ts"], read: [] });
    expect(first.ok).toBe(true);

    const second = locks.acquire({ runId: "r", nodeId: "n2", write: ["src/mw/**"], read: [] });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.blockedOn.heldBy).toBe("n1");
  });

  it("acquires nothing when any member of the set conflicts", () => {
    const { locks, db } = ctx();
    locks.acquire({ runId: "r", nodeId: "n1", write: ["b.ts"], read: [] });

    // n2 wants a.ts (free) and b.ts (held). It must end up holding neither —
    // a partial hold is what re-introduces hold-and-wait.
    const out = locks.acquire({ runId: "r", nodeId: "n2", write: ["a.ts", "b.ts"], read: [] });
    expect(out.ok).toBe(false);

    const held = db.all("SELECT resource FROM locks WHERE node_id = 'n2'");
    expect(held).toHaveLength(0);
  });

  it("lets a reader through when no writer holds the resource", () => {
    const { locks } = ctx();
    locks.acquire({ runId: "r", nodeId: "n1", write: ["src/a.ts"], read: [] });
    const reader = locks.acquire({ runId: "r", nodeId: "n2", write: [], read: ["docs/x.md"] });
    expect(reader.ok).toBe(true);
  });

  it("blocks a reader against a held write", () => {
    const { locks } = ctx();
    locks.acquire({ runId: "r", nodeId: "n1", write: ["src/a.ts"], read: [] });
    const reader = locks.acquire({ runId: "r", nodeId: "n2", write: [], read: ["src/**"] });
    expect(reader.ok).toBe(false);
  });

  it("RETAINS locks when a node parks (F5)", () => {
    const { locks, db } = ctx();
    locks.acquire({ runId: "r", nodeId: "n1", write: ["src/a.ts"], read: [] });
    locks.park("r", "n1");

    // The lock is still there, marked parked — releasing it would let a sibling
    // mutate the resource and invalidate n1's checkpoint.
    const row = db.get("SELECT parked FROM locks WHERE resource = 'src/a.ts'");
    expect(Number(row?.["parked"])).toBe(1);

    const other = locks.acquire({ runId: "r", nodeId: "n2", write: ["src/a.ts"], read: [] });
    expect(other.ok).toBe(false);
  });

  it("does not release parked locks via the normal release path", () => {
    const { locks, db } = ctx();
    locks.acquire({ runId: "r", nodeId: "n1", write: ["src/a.ts"], read: [] });
    locks.park("r", "n1");
    locks.release("r", "n1");
    expect(db.all("SELECT resource FROM locks")).toHaveLength(1);
  });

  /**
   * The property the original flow could not hold: with runtime happens-before
   * edges added in discovery order, two nodes can each end up ordered after the
   * other and the ready queue stalls forever.
   *
   * Canonical-order all-or-nothing acquisition makes that unreachable, so a
   * randomised soak must always drain to zero held locks.
   */
  it("fuzz: never deadlocks across randomised interleavings", () => {
    const paths = ["src/a.ts", "src/b.ts", "src/mw/**", "test/x.ts", "docs", "src"];
    let progressFailures = 0;

    for (let trial = 0; trial < 300; trial++) {
      const { locks } = ctx();
      const rand = mulberry32(trial);
      const nodes = Array.from({ length: 5 }, (_, i) => ({
        id: `n${i}`,
        write: pick(paths, 1 + Math.floor(rand() * 2), rand),
        read: pick(paths, Math.floor(rand() * 2), rand),
        held: false,
      }));

      // Interleave acquire/release randomly, as a real scheduler would.
      for (let step = 0; step < 60; step++) {
        const n = nodes[Math.floor(rand() * nodes.length)]!;
        if (!n.held) {
          const out = locks.acquire({ runId: "r", nodeId: n.id, write: n.write, read: n.read });
          if (out.ok) n.held = true;
        } else {
          locks.release("r", n.id);
          n.held = false;
        }
      }

      // Drain: every node releases. If any lock survives, some node was holding
      // a partial set it could never complete — the deadlock signature.
      for (const n of nodes) {
        locks.release("r", n.id);
        n.held = false;
      }
      if (locks.held("r").length !== 0) progressFailures++;
    }

    expect(progressFailures).toBe(0);
  });
});

// ------------------------------------------------------------------ F6 cascade

describe("cascade invalidation (F6)", () => {
  it("requeues a node whose read set intersects the rolled-back write set", () => {
    const nodes = [
      node("n1", { status: "rolled_back", sets: { read: [], write: ["src/mw/a.ts"] } }),
      node("n2", { status: "done", sets: { read: ["src/mw/**"], write: ["test/a.spec.ts"] } }),
      node("n3", { status: "done", sets: { read: ["docs/**"], write: [] } }),
    ];
    const out = cascadeInvalidate(nodes, "n1");
    expect(out.dirtied.map((d) => d.nodeId)).toEqual(["n2"]);
    expect(out.dirtied[0]!.via).toContain("src/mw/**");
  });

  it("propagates transitively — a dirtied node's own consumers are suspect", () => {
    const nodes = [
      node("n1", { status: "rolled_back", sets: { read: [], write: ["a.ts"] } }),
      node("n2", { status: "done", sets: { read: ["a.ts"], write: ["b.ts"] } }),
      node("n3", { status: "done", sets: { read: ["b.ts"], write: ["c.ts"] } }),
      node("n4", { status: "done", sets: { read: ["c.ts"], write: [] } }),
    ];
    const out = cascadeInvalidate(nodes, "n1");
    expect(out.dirtied.map((d) => d.nodeId).sort()).toEqual(["n2", "n3", "n4"]);
  });

  it("ignores nodes that have not consumed anything yet", () => {
    const nodes = [
      node("n1", { status: "rolled_back", sets: { read: [], write: ["a.ts"] } }),
      node("n2", { status: "pending", sets: { read: ["a.ts"], write: [] } }),
    ];
    expect(cascadeInvalidate(nodes, "n1").dirtied).toHaveLength(0);
  });

  it("caps depth so a rollback storm cannot livelock", () => {
    const nodes = [node("n0", { status: "rolled_back", sets: { read: [], write: ["f0"] } })];
    for (let i = 1; i <= 20; i++) {
      nodes.push(
        node(`n${i}`, { status: "done", sets: { read: [`f${i - 1}`], write: [`f${i}`] } }),
      );
    }
    const out = cascadeInvalidate(nodes, "n0", { maxDepth: 3 });
    expect(out.truncated).toBe(true);
    expect(out.dirtied.length).toBeLessThan(20);
  });
});

// --------------------------------------------------------------- F1 classifier

describe("error classifier (F1)", () => {
  it("forces permanent once attempts reach the cap, whatever the error looks like", () => {
    // ECONNRESET reads as transient all day; the counter must win.
    const v = classify({
      node: { id: "n1", attempts: 2 },
      error: new Error("ECONNRESET"),
      maxAttempts: 2,
    });
    expect(v.failure).toBe("permanent");
    expect(v.action).toBe("rollback");
    expect(v.reason).toMatch(/retries exhausted/);
  });

  it("still retries below the cap", () => {
    const v = classify({
      node: { id: "n1", attempts: 1 },
      error: new Error("ECONNRESET"),
      maxAttempts: 2,
    });
    expect(v.failure).toBe("transient");
    expect(v.action).toBe("retry");
  });

  it("cannot loop: repeated classification terminates at the cap", () => {
    let attempts = 0;
    const maxAttempts = 2;
    let guard = 0;
    for (;;) {
      if (guard++ > 50) throw new Error("classifier looped");
      const v = classify({
        node: { id: "n1", attempts },
        error: new Error("ETIMEDOUT"),
        maxAttempts,
      });
      if (v.action !== "retry") break;
      attempts++;
    }
    expect(attempts).toBe(maxAttempts);
  });

  it("never retries a write-set violation", () => {
    const v = classify({
      node: { id: "n1", attempts: 0 },
      error: new WriteSetViolation("src/evil.ts", ["src/ok.ts"]),
      maxAttempts: 2,
    });
    expect(v.failure).toBe("write_set_violation");
    expect(v.action).toBe("rollback");
  });

  it("routes a dead provider to fallback, not to retry", () => {
    const v = classify({
      node: { id: "n1", attempts: 0 },
      error: new Error("connect ECONNREFUSED 127.0.0.1:11434"),
      maxAttempts: 2,
    });
    expect(v.failure).toBe("provider_unavailable");
    expect(v.action).toBe("fallback_provider");
  });

  it("routes a retrieval miss to a wider query", () => {
    const v = classify({
      node: { id: "n1", attempts: 0 },
      error: new Error("insufficient context to answer"),
      maxAttempts: 2,
    });
    expect(v.action).toBe("widen_retrieval");
  });
});

// -------------------------------------------------------------- F2 review loop

describe("review loop (F2)", () => {
  it("escalates instead of looping once the round cap is passed", () => {
    const loop = new ReviewLoop({ maxRounds: 2 });
    expect(loop.reject("bucket map is unbounded").action).toBe("rerun");
    expect(loop.reject("missing Retry-After header").action).toBe("rerun");
    const third = loop.reject("naming could be clearer");
    expect(third.action).toBe("escalate");
  });

  it("treats a re-worded repeat as non-progress and escalates", () => {
    const loop = new ReviewLoop({ maxRounds: 5 });
    loop.reject("The bucket map is unbounded and will leak memory.");
    const again = loop.reject("unbounded bucket map — it leaks memory!");
    expect(again.action).toBe("escalate");
  });

  it("hashes re-phrasings of the same objection identically", () => {
    expect(semanticHash("The bucket map is unbounded")).toBe(
      semanticHash("bucket map, unbounded!"),
    );
    expect(semanticHash("bucket map is unbounded")).not.toBe(
      semanticHash("missing Retry-After header"),
    );
  });

  it("evicts oldest critiques to stay inside the budget", () => {
    const loop = new ReviewLoop({ maxRounds: 10, critiqueBudget: 30 });
    loop.reject("a".repeat(80)); // ~20 tokens
    loop.reject("b".repeat(80));
    loop.reject("c".repeat(80));
    const total = loop.active.reduce((s, c) => s + c.tokens, 0);
    expect(total).toBeLessThanOrEqual(30);
    expect(loop.active.length).toBeLessThan(3);
  });

  it("renders critiques as hard constraints, not suggestions", () => {
    const loop = new ReviewLoop();
    loop.reject("cap the LRU at 10k keys");
    expect(loop.render()).toMatch(/HARD CONSTRAINTS/);
    expect(loop.render()).toContain("cap the LRU at 10k keys");
  });
});

// -------------------------------------------------------------- F7 epoch cache

describe("epoch cache (F7)", () => {
  it("serves a hit while nothing has been written", () => {
    const { cache } = ctx();
    const input = { tool: "read_file", args: { path: "a.ts" }, reads: ["a.ts"] };
    cache.set(input, { content: "v1" });
    expect(cache.get(input)).toEqual({ content: "v1" });
  });

  it("misses after a committed write to the same resource", () => {
    const { cache } = ctx();
    const input = { tool: "read_file", args: { path: "a.ts" }, reads: ["a.ts"] };
    cache.set(input, { content: "v1" });

    cache.bump("r", ["a.ts"]);

    // Same tool, same args — but the resource moved, so the key no longer
    // resolves. This is the stale-read the original flow would have served.
    expect(cache.get(input)).toBeUndefined();
  });

  it("invalidates a glob read when a file beneath it is written", () => {
    const { cache } = ctx();
    const input = { tool: "grep", args: { q: "x" }, reads: ["src/**"] };
    cache.set(input, { hits: 3 });
    expect(cache.get(input)).toEqual({ hits: 3 });

    cache.bump("r", ["src/mw/rateLimit.ts"]);
    expect(cache.get(input)).toBeUndefined();
  });

  it("leaves unrelated resources alone", () => {
    const { cache } = ctx();
    const docs = { tool: "read_file", args: { path: "docs/a.md" }, reads: ["docs/a.md"] };
    cache.set(docs, { content: "unchanged" });
    cache.bump("r", ["src/mw/a.ts"]);
    expect(cache.get(docs)).toEqual({ content: "unchanged" });
  });

  it("is insensitive to argument key order", () => {
    const { cache } = ctx();
    cache.set({ tool: "t", args: { a: 1, b: 2 }, reads: [] }, "x");
    expect(cache.get({ tool: "t", args: { b: 2, a: 1 }, reads: [] })).toBe("x");
  });
});
