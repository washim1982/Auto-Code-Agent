import { describe, expect, it } from "vitest";
import { Db } from "../src/db/client.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { chunkFile } from "../src/memory/chunker.ts";
import {
  cosineSimilarity,
  fromBlob,
  reciprocalRankFusion,
  toBlob,
} from "../src/memory/retrieval.ts";

const TS_SOURCE = `import { z } from "zod";

export function getUserById(id: string): User | null {
  const row = db.get("SELECT * FROM users WHERE id = ?", id);
  return row ? toUser(row) : null;
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  create(userId: string): Session {
    const s = { id: crypto.randomUUID(), userId };
    this.sessions.set(s.id, s);
    return s;
  }
}
`;

describe("chunker", () => {
  it("splits on declaration boundaries rather than fixed windows", () => {
    const chunks = chunkFile("src/users.ts", TS_SOURCE);
    const symbols = chunks.map((c) => c.symbol).filter(Boolean);
    expect(symbols).toContain("getUserById");
    expect(symbols).toContain("SessionManager");
  });

  it("keeps a function whole, so its signature and body retrieve together", () => {
    const chunks = chunkFile("src/users.ts", TS_SOURCE);
    const fn = chunks.find((c) => c.symbol === "getUserById");
    expect(fn?.content).toContain("export function getUserById");
    expect(fn?.content).toContain("return row ? toUser(row) : null;");
  });

  it("is not fooled by braces inside strings", () => {
    const src = `export function f() {\n  const s = "}{";\n  return s;\n}\n`;
    const chunks = chunkFile("a.ts", src);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain("return s;");
  });

  it("windows prose instead of hunting for declarations", () => {
    const prose = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkFile("README.md", prose, { maxLines: 50, overlapLines: 5 });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.symbol === null)).toBe(true);
  });

  it("records line ranges so results can cite path:line", () => {
    const chunks = chunkFile("src/users.ts", TS_SOURCE);
    for (const c of chunks) {
      expect(c.startLine).toBeGreaterThan(0);
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
      expect(c.id).toContain("src/users.ts:");
    }
  });
});

describe("vector helpers", () => {
  it("round-trips a vector through a blob", () => {
    const v = [0.1, -0.5, 0.75];
    const back = fromBlob(toBlob(v));
    expect(Array.from(back).map((x) => Number(x.toFixed(4)))).toEqual(v);
  });

  it("scores identical vectors at 1 and orthogonal at 0", () => {
    const a = Float32Array.from([1, 0, 0]);
    expect(cosineSimilarity(a, Float32Array.from([1, 0, 0]))).toBeCloseTo(1);
    expect(cosineSimilarity(a, Float32Array.from([0, 1, 0]))).toBeCloseTo(0);
  });

  it("survives an unaligned buffer, which SQLite hands back routinely", () => {
    const padded = new Uint8Array(13);
    padded.set(toBlob([1, 2, 3]), 1);
    expect(() => fromBlob(padded.subarray(1))).not.toThrow();
  });
});

describe("reciprocal rank fusion", () => {
  it("rewards a document both rankers agree on", () => {
    const bm25 = [
      { id: "a", score: 9 },
      { id: "b", score: 8 },
    ];
    const vector = [
      { id: "b", score: 0.9 },
      { id: "c", score: 0.8 },
    ];
    expect(reciprocalRankFusion([bm25, vector])[0]!.id).toBe("b");
  });

  it("ignores incomparable score scales and uses rank only", () => {
    // BM25 scores are unbounded, cosine is [-1,1]. Fusing raw scores would let
    // BM25 dominate purely by magnitude.
    const huge = [{ id: "x", score: 10_000 }];
    const small = [
      { id: "y", score: 0.99 },
      { id: "x", score: 0.98 },
    ];
    const fused = reciprocalRankFusion([huge, small]);
    expect(fused.find((f) => f.id === "x")!.score).toBeGreaterThan(
      fused.find((f) => f.id === "y")!.score,
    );
  });
});

describe("T3 index and retrieval", () => {
  const fakeEmbedder = async (texts: string[]): Promise<number[][]> =>
    // Deterministic pseudo-embedding: token presence in a tiny vocabulary.
    texts.map((t) => {
      const vocab = ["user", "session", "delete", "auth", "create"];
      return vocab.map((w) => (t.toLowerCase().includes(w) ? 1 : 0));
    });

  it("indexes a file and finds it by identifier", async () => {
    const store = new MemoryStore(new Db(":memory:"), fakeEmbedder);
    await store.indexFile("src/users.ts", TS_SOURCE);
    const hits = await store.search("getUserById");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.source).toBe("src/users.ts");
  });

  it("skips re-indexing an unchanged file", async () => {
    const store = new MemoryStore(new Db(":memory:"), fakeEmbedder);
    const first = await store.indexFile("a.ts", TS_SOURCE);
    const second = await store.indexFile("a.ts", TS_SOURCE);
    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(true);
  });

  it("re-indexes when content changes and drops the stale chunks", async () => {
    const store = new MemoryStore(new Db(":memory:"), fakeEmbedder);
    await store.indexFile("a.ts", TS_SOURCE);
    await store.indexFile("a.ts", "export function replaced() { return 1; }\n");
    const hits = await store.search("getUserById");
    expect(hits.every((h) => !h.content.includes("getUserById"))).toBe(true);
  });

  it("still returns results when the embedding server is unavailable", async () => {
    // The embedder is a separate process; BM25 alone has to stay useful.
    const store = new MemoryStore(new Db(":memory:"), async () => {
      throw new Error("ECONNREFUSED");
    });
    await store.indexFile("src/users.ts", TS_SOURCE);
    const hits = await store.search("SessionManager");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("does not choke on punctuation in the query", async () => {
    // FTS5 treats punctuation as syntax; a raw `getUser()` is a parse error.
    const store = new MemoryStore(new Db(":memory:"), fakeEmbedder);
    await store.indexFile("src/users.ts", TS_SOURCE);
    await expect(store.search("getUserById(id: string)")).resolves.toBeDefined();
  });

  it("reports index stats", async () => {
    const store = new MemoryStore(new Db(":memory:"), fakeEmbedder);
    await store.indexFile("src/users.ts", TS_SOURCE);
    const stats = store.indexStats();
    expect(stats.files).toBe(1);
    expect(stats.chunks).toBeGreaterThan(0);
    expect(stats.embedded).toBe(stats.chunks);
  });
});

describe("T2 episodic memory", () => {
  it("returns only the requested nodes' deltas", () => {
    const store = new MemoryStore(new Db(":memory:"));
    store.writeTask("r1", "n1", "delta", "found the middleware chain");
    store.writeTask("r1", "n2", "delta", "wrote the limiter");
    expect(store.taskMemory("r1", ["n1"])).toHaveLength(1);
    expect(store.taskMemory("r1")).toHaveLength(2);
  });
});

describe("T4 lessons", () => {
  it("does not inject a lesson seen only once", () => {
    // One failure is circumstance; the gate is what stops T4 accumulating junk.
    const store = new MemoryStore(new Db(":memory:"));
    const l = store.recordLesson("workspace", "npm test on windows", "npm is a cmd shim");
    expect(l.confirmed).toBe(false);
    expect(store.applicableLessons("running npm test on windows")).toHaveLength(0);
  });

  it("confirms on a second independent occurrence", () => {
    const store = new MemoryStore(new Db(":memory:"));
    store.recordLesson("workspace", "npm test on windows", "npm is a cmd shim");
    const second = store.recordLesson("workspace", "npm test on windows", "npm is a cmd shim");
    expect(second.confirmed).toBe(true);
    expect(store.applicableLessons("npm test failing on windows").length).toBeGreaterThan(0);
  });

  it("does not surface a lesson whose trigger does not match", () => {
    const store = new MemoryStore(new Db(":memory:"));
    store.recordLesson("workspace", "database migrations", "always back up first");
    store.recordLesson("workspace", "database migrations", "always back up first");
    expect(store.applicableLessons("adding a react component")).toHaveLength(0);
  });

  it("retires a lesson that stops paying off", () => {
    const store = new MemoryStore(new Db(":memory:"));
    const l = store.recordLesson("workspace", "trigger words here", "bad advice");
    store.recordLesson("workspace", "trigger words here", "bad advice");

    let retired = false;
    for (let i = 0; i < 5; i++) retired = store.scoreLesson(l.id, false).retired || retired;

    expect(retired).toBe(true);
    expect(store.lesson(l.id)!.confirmed).toBe(false);
    expect(store.applicableLessons("trigger words here")).toHaveLength(0);
  });

  it("keeps a lesson that keeps working", () => {
    const store = new MemoryStore(new Db(":memory:"));
    const l = store.recordLesson("workspace", "trigger words here", "good advice");
    store.recordLesson("workspace", "trigger words here", "good advice");
    for (let i = 0; i < 6; i++) store.scoreLesson(l.id, true);
    expect(store.lesson(l.id)!.confirmed).toBe(true);
  });
});
