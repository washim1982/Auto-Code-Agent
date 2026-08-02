import type { Db } from "../db/client.ts";

export interface StoredScorecard {
  provider: string;
  model: string;
  probedAt: number;
  tools: "native" | "shim" | "none";
  structured: "grammar" | "json_schema" | "json_mode" | "none";
  realContext: number;
  tokPerSec: number;
  ttftMs: number;
  reliability: number;
}

/**
 * Persisted capability measurements.
 *
 * The whole reason this table exists: advertised capabilities lie in both
 * directions and the lies are expensive. `qwen3.5:0.8b` advertises a 262k
 * window and cannot retrieve a fact past ~32k; a model tagged `tools` may emit
 * malformed calls a third of the time. Routing on advertised numbers surfaces
 * those as node failures deep in a run, where they look like the agent being
 * bad rather than the router picking wrong.
 *
 * Lives in `core` rather than `providers` because `core` owns the database and
 * `providers` must not depend on it.
 */
export class ScorecardStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  put(card: StoredScorecard): void {
    this.db.run(
      `INSERT OR REPLACE INTO model_scorecards
       (provider, model, probed_at, tools, structured, real_ctx, tok_per_sec, ttft_ms, reliability)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      card.provider,
      card.model,
      card.probedAt,
      card.tools,
      card.structured,
      card.realContext,
      card.tokPerSec,
      card.ttftMs,
      card.reliability,
    );
  }

  get(provider: string, model: string): StoredScorecard | null {
    const r = this.db.get(
      "SELECT * FROM model_scorecards WHERE provider = ? AND model = ?",
      provider,
      model,
    );
    return r ? rowTo(r) : null;
  }

  all(): StoredScorecard[] {
    return this.db.all("SELECT * FROM model_scorecards ORDER BY reliability DESC").map(rowTo);
  }

  /**
   * Scorecards keyed `provider/model`, for the router.
   *
   * Stale cards are dropped rather than trusted: a model can be re-quantised
   * or a server reconfigured, and a six-month-old measurement is a worse guide
   * than the advertised number because it carries false confidence.
   */
  index(maxAgeMs = 30 * 24 * 60 * 60_000): Map<string, StoredScorecard> {
    const cutoff = Date.now() - maxAgeMs;
    const out = new Map<string, StoredScorecard>();
    for (const card of this.all()) {
      if (card.probedAt < cutoff) continue;
      out.set(`${card.provider}/${card.model}`, card);
    }
    return out;
  }

  clear(): void {
    this.db.run("DELETE FROM model_scorecards");
  }
}

function rowTo(r: Record<string, unknown>): StoredScorecard {
  return {
    provider: String(r["provider"]),
    model: String(r["model"]),
    probedAt: Number(r["probed_at"]),
    tools: String(r["tools"]) as StoredScorecard["tools"],
    structured: String(r["structured"]) as StoredScorecard["structured"],
    realContext: Number(r["real_ctx"]),
    tokPerSec: Number(r["tok_per_sec"]),
    ttftMs: Number(r["ttft_ms"]),
    reliability: Number(r["reliability"]),
  };
}
