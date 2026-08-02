import { createHash } from "node:crypto";
import type { Db } from "../db/client.ts";
import { chunkFile, type Chunk } from "./chunker.ts";
import {
  cosineSimilarity,
  fromBlob,
  reciprocalRankFusion,
  toBlob,
  type Ranked,
} from "./retrieval.ts";

export interface Retrieved {
  id: string;
  source: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
  symbol: string | null;
}

export interface Lesson {
  id: string;
  scope: string;
  trigger: string;
  lesson: string;
  confidence: number;
  uses: number;
  wins: number;
  confirmed: boolean;
}

export type Embedder = (texts: string[]) => Promise<number[][]>;

/**
 * The T2/T3/T4 memory tiers.
 *
 * T1 (working) lives in the context window and is deliberately not persisted.
 * The other three all exist because a run needs to remember something across a
 * boundary the window cannot cross: T2 across nodes, T3 across the repo, T4
 * across runs.
 */
export class MemoryStore {
  private db: Db;
  private embedder: Embedder | null;

  constructor(db: Db, embedder: Embedder | null = null) {
    this.db = db;
    this.embedder = embedder;
    this.ensureIndexTables();
  }

  private ensureIndexTables(): void {
    this.db.raw.exec(`
      CREATE TABLE IF NOT EXISTS mem_chunks (
        id         TEXT PRIMARY KEY,
        source     TEXT NOT NULL,
        content    TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line   INTEGER NOT NULL,
        sha256     TEXT NOT NULL,
        symbol     TEXT,
        embedding  BLOB,
        relevance  REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_source ON mem_chunks(source);
      CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(id UNINDEXED, content, symbol);
      CREATE TABLE IF NOT EXISTS index_files (
        source TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      );
    `);
  }

  // ------------------------------------------------------------------ T2

  /** Episodic: what a node concluded, available to its dependents. */
  writeTask(runId: string, nodeId: string | null, kind: string, content: string): void {
    this.db.run(
      "INSERT INTO mem_task (id, run_id, node_id, kind, content, ts) VALUES (?, ?, ?, ?, ?, ?)",
      `${runId}:${nodeId ?? "run"}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
      runId,
      nodeId,
      kind,
      content,
      Date.now(),
    );
  }

  taskMemory(
    runId: string,
    nodeIds?: readonly string[],
  ): { nodeId: string | null; kind: string; content: string }[] {
    const rows = nodeIds?.length
      ? this.db.all(
          `SELECT node_id, kind, content FROM mem_task WHERE run_id = ? AND node_id IN (${nodeIds.map(() => "?").join(",")}) ORDER BY ts`,
          runId,
          ...nodeIds,
        )
      : this.db.all(
          "SELECT node_id, kind, content FROM mem_task WHERE run_id = ? ORDER BY ts",
          runId,
        );
    return rows.map((r) => ({
      nodeId: r["node_id"] == null ? null : String(r["node_id"]),
      kind: String(r["kind"]),
      content: String(r["content"]),
    }));
  }

  // ------------------------------------------------------------------ T3

  /**
   * Indexes one file, skipping it when the content hash is unchanged.
   *
   * Re-embedding an unchanged file is the dominant cost of re-indexing, so the
   * hash check is what makes incremental indexing worth having at all.
   */
  async indexFile(
    source: string,
    content: string,
  ): Promise<{ chunks: number; skipped: boolean }> {
    const sha = createHash("sha256").update(content).digest("hex");
    const existing = this.db.get("SELECT sha256 FROM index_files WHERE source = ?", source);
    if (existing && String(existing["sha256"]) === sha) return { chunks: 0, skipped: true };

    this.db.run("DELETE FROM mem_chunks WHERE source = ?", source);
    this.db.run(
      "DELETE FROM mem_fts WHERE id IN (SELECT id FROM mem_chunks WHERE source = ?)",
      source,
    );

    const chunks = chunkFile(source, content);

    // The embedding server is a separate process and is routinely down. An
    // index built without vectors still answers identifier queries well via
    // BM25, which is far better than refusing to index at all — and the next
    // run re-embeds because the hash check only skips unchanged content.
    let embeddings: (number[] | null)[] = chunks.map(() => null);
    if (this.embedder) {
      try {
        embeddings = await this.embedder(chunks.map((c) => embedText(c)));
      } catch {
        embeddings = chunks.map(() => null);
      }
    }

    for (const [i, chunk] of chunks.entries()) {
      const vector = embeddings[i];
      this.db.run(
        `INSERT OR REPLACE INTO mem_chunks
         (id, source, content, start_line, end_line, sha256, symbol, embedding, relevance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT relevance FROM mem_chunks WHERE id = ?), 0))`,
        chunk.id,
        chunk.source,
        chunk.content,
        chunk.startLine,
        chunk.endLine,
        chunk.sha256,
        chunk.symbol,
        vector ? toBlob(vector) : null,
        chunk.id,
      );
      this.db.run(
        "INSERT INTO mem_fts (id, content, symbol) VALUES (?, ?, ?)",
        chunk.id,
        chunk.content,
        chunk.symbol ?? "",
      );
    }

    this.db.run(
      "INSERT OR REPLACE INTO index_files (source, sha256, indexed_at) VALUES (?, ?, ?)",
      source,
      sha,
      Date.now(),
    );
    return { chunks: chunks.length, skipped: false };
  }

  /**
   * Hybrid retrieval: BM25 and vector, fused by reciprocal rank.
   *
   * Relevance feedback is folded in as a small bonus — chunks that previously
   * contributed to a node that passed its gates get promoted slightly. It is
   * deliberately small: the feedback signal is noisy, and letting it dominate
   * turns retrieval into a popularity contest that never surfaces new code.
   */
  async search(query: string, limit = 8): Promise<Retrieved[]> {
    const lists: Ranked[][] = [];

    lists.push(this.searchText(query, limit * 4));

    if (this.embedder) {
      try {
        const [queryVector] = await this.embedder([query]);
        if (queryVector) lists.push(this.searchVector(queryVector, limit * 4));
      } catch {
        // Embeddings unavailable — BM25 alone still returns something useful,
        // which matters because the embedding server is a separate process.
      }
    }

    const fused = reciprocalRankFusion(lists).slice(0, limit * 2);
    if (fused.length === 0) return [];

    const byId = new Map(fused.map((f) => [f.id, f.score]));
    const rows = this.db.all(
      `SELECT id, source, content, start_line, end_line, symbol, relevance
       FROM mem_chunks WHERE id IN (${fused.map(() => "?").join(",")})`,
      ...fused.map((f) => f.id),
    );

    return rows
      .map((r) => ({
        id: String(r["id"]),
        source: String(r["source"]),
        content: String(r["content"]),
        startLine: Number(r["start_line"]),
        endLine: Number(r["end_line"]),
        symbol: r["symbol"] == null ? null : String(r["symbol"]),
        score: (byId.get(String(r["id"])) ?? 0) + Number(r["relevance"]) * 0.001,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private searchText(query: string, limit: number): Ranked[] {
    // FTS5 treats punctuation as syntax, so a raw query like `getUser()` is a
    // parse error rather than a search.
    const safe = query.replace(/[^\p{L}\p{N}\s_]/gu, " ").trim();
    if (!safe) return [];
    const terms = safe
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t}"`);
    try {
      return this.db
        .all(
          `SELECT id, bm25(mem_fts) AS rank FROM mem_fts WHERE mem_fts MATCH ? ORDER BY rank LIMIT ?`,
          terms.join(" OR "),
          limit,
        )
        .map((r) => ({ id: String(r["id"]), score: -Number(r["rank"]) }));
    } catch {
      return [];
    }
  }

  private searchVector(query: number[], limit: number): Ranked[] {
    const q = Float32Array.from(query);
    const rows = this.db.all(
      "SELECT id, embedding FROM mem_chunks WHERE embedding IS NOT NULL",
    );
    // Brute force. At repo scale (a few thousand chunks x 768 dims) this is a
    // few milliseconds, and it avoids a native vector extension entirely.
    return rows
      .map((r) => ({
        id: String(r["id"]),
        score: cosineSimilarity(q, fromBlob(r["embedding"] as Uint8Array)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Promotes chunks that contributed to work which passed its gates. */
  recordRelevance(chunkIds: readonly string[], delta = 1): void {
    for (const id of chunkIds) {
      this.db.run("UPDATE mem_chunks SET relevance = relevance + ? WHERE id = ?", delta, id);
    }
  }

  indexStats(): { files: number; chunks: number; embedded: number } {
    return {
      files: Number(this.db.get("SELECT COUNT(*) AS c FROM index_files")?.["c"] ?? 0),
      chunks: Number(this.db.get("SELECT COUNT(*) AS c FROM mem_chunks")?.["c"] ?? 0),
      embedded: Number(
        this.db.get("SELECT COUNT(*) AS c FROM mem_chunks WHERE embedding IS NOT NULL")?.[
          "c"
        ] ?? 0,
      ),
    };
  }

  // ------------------------------------------------------------------ T4

  /**
   * Records a lesson, confirming it on a second independent occurrence.
   *
   * The confirmation gate is what stops T4 becoming a garbage accumulator. A
   * single failure is usually circumstance; the same failure twice is a
   * pattern. Only confirmed lessons are ever injected into a context window.
   */
  recordLesson(scope: string, trigger: string, lesson: string, evidence = ""): Lesson {
    const id = createHash("sha256")
      .update(`${scope}:${trigger}:${lesson}`)
      .digest("hex")
      .slice(0, 16);
    const existing = this.db.get("SELECT * FROM mem_lessons WHERE id = ?", id);

    if (existing) {
      this.db.run(
        "UPDATE mem_lessons SET confirmed = 1, confidence = MIN(1.0, confidence + 0.3) WHERE id = ?",
        id,
      );
    } else {
      this.db.run(
        `INSERT INTO mem_lessons (id, scope, trigger, lesson, evidence, confidence, uses, wins, confirmed)
         VALUES (?, ?, ?, ?, ?, 0.4, 0, 0, 0)`,
        id,
        scope,
        trigger,
        lesson,
        evidence,
      );
    }
    return this.lesson(id)!;
  }

  lesson(id: string): Lesson | null {
    const r = this.db.get("SELECT * FROM mem_lessons WHERE id = ?", id);
    return r ? rowToLesson(r) : null;
  }

  /** Confirmed lessons whose trigger matches the context. Only these are injected. */
  applicableLessons(context: string, scope = "workspace", limit = 5): Lesson[] {
    const haystack = context.toLowerCase();
    return this.db
      .all(
        "SELECT * FROM mem_lessons WHERE confirmed = 1 AND (scope = ? OR scope = 'global')",
        scope,
      )
      .map(rowToLesson)
      .filter((l) => {
        const words = l.trigger
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3);
        if (words.length === 0) return true;
        return words.filter((w) => haystack.includes(w)).length / words.length >= 0.4;
      })
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit);
  }

  /**
   * Scores a lesson after use and retires it when it stops paying off.
   *
   * A lesson that keeps being applied and keeps preceding failures is actively
   * harmful — it is spending context to make things worse. Auto-retirement is
   * the mechanism that lets T4 be written to aggressively without the store
   * degrading over time.
   */
  scoreLesson(id: string, helped: boolean): { retired: boolean } {
    this.db.run(
      "UPDATE mem_lessons SET uses = uses + 1, wins = wins + ? WHERE id = ?",
      helped ? 1 : 0,
      id,
    );
    const l = this.lesson(id);
    if (!l) return { retired: false };

    if (l.uses >= 5 && l.wins / l.uses < 0.5) {
      this.db.run("UPDATE mem_lessons SET confirmed = 0, confidence = 0 WHERE id = ?", id);
      return { retired: true };
    }
    return { retired: false };
  }

  allLessons(): Lesson[] {
    return this.db.all("SELECT * FROM mem_lessons ORDER BY confidence DESC").map(rowToLesson);
  }

  forgetLesson(id: string): void {
    this.db.run("DELETE FROM mem_lessons WHERE id = ?", id);
  }
}

function rowToLesson(r: Record<string, unknown>): Lesson {
  return {
    id: String(r["id"]),
    scope: String(r["scope"]),
    trigger: String(r["trigger"]),
    lesson: String(r["lesson"]),
    confidence: Number(r["confidence"]),
    uses: Number(r["uses"]),
    wins: Number(r["wins"]),
    confirmed: Number(r["confirmed"]) === 1,
  };
}

/** Symbol names carry disproportionate retrieval signal, so they lead. */
function embedText(chunk: Chunk): string {
  return chunk.symbol ? `${chunk.symbol}\n${chunk.content}` : chunk.content;
}
