import { createHash } from "node:crypto";

export interface Critique {
  round: number;
  text: string;
  hash: string;
  tokens: number;
}

export type ReviewDecision =
  | { action: "accept" }
  | { action: "rerun"; critiques: Critique[] }
  | { action: "escalate"; reason: string };

export interface ReviewLoopOptions {
  /** Hard cap on review rounds. Past this the node escalates, not loops. */
  maxRounds?: number;
  /** Token ceiling for the accumulated critique block. */
  critiqueBudget?: number;
}

/**
 * Bounded review loop (flow review F2).
 *
 * The original flow drew `Reviewer approves? -> no -> attach critique as a hard
 * constraint and re-run the node` with no cap and no progress check. Two ways
 * that hangs: the reviewer keeps finding a fresh nit forever, and the
 * accumulated critique block grows until it crowds the node's actual context
 * out of the window.
 *
 * So: a round cap that escalates rather than loops, semantic-hash dedup so a
 * re-worded repeat does not count as progress, and a token budget on the
 * critique block that evicts oldest-first.
 */
export class ReviewLoop {
  private critiques: Critique[] = [];
  private seen = new Set<string>();
  private rounds = 0;

  private options: ReviewLoopOptions;

  constructor(options: ReviewLoopOptions = {}) {
    this.options = options;
  }

  get maxRounds(): number {
    return this.options.maxRounds ?? 3;
  }

  get critiqueBudget(): number {
    return this.options.critiqueBudget ?? 1200;
  }

  get round(): number {
    return this.rounds;
  }

  get active(): Critique[] {
    return [...this.critiques];
  }

  accept(): ReviewDecision {
    return { action: "accept" };
  }

  /**
   * Records a rejection and decides what happens next.
   *
   * A repeated critique is a signal the loop is not converging, so it counts
   * as a round but adds nothing — and two repeats in a row escalate.
   */
  reject(text: string, tokens = estimateTokens(text)): ReviewDecision {
    this.rounds++;

    if (this.rounds > this.maxRounds) {
      return {
        action: "escalate",
        reason: `review did not converge after ${this.maxRounds} round(s)`,
      };
    }

    const hash = semanticHash(text);
    if (this.seen.has(hash)) {
      return {
        action: "escalate",
        reason: "reviewer repeated a critique the node already tried to satisfy",
      };
    }

    this.seen.add(hash);
    this.critiques.push({ round: this.rounds, text, hash, tokens });
    this.evictToBudget();

    return { action: "rerun", critiques: this.active };
  }

  /** Drops the oldest critiques until the block fits its slice of the window. */
  private evictToBudget(): void {
    let total = this.critiques.reduce((s, c) => s + c.tokens, 0);
    while (total > this.critiqueBudget && this.critiques.length > 1) {
      const dropped = this.critiques.shift();
      total -= dropped?.tokens ?? 0;
    }
  }

  /** Renders the active critiques as a hard-constraint block for the prompt. */
  render(): string {
    if (this.critiques.length === 0) return "";
    const lines = this.critiques.map((c) => `- [round ${c.round}] ${c.text.trim()}`);
    return [
      "HARD CONSTRAINTS from previous review rounds.",
      "These are not suggestions. A response that does not satisfy them will be rejected again.",
      ...lines,
    ].join("\n");
  }
}

/**
 * Normalises away wording so a re-phrased repeat hashes identically:
 * lowercase, strip punctuation and stopwords, stem, sort the token bag.
 *
 * Crude on purpose. It only has to catch the actual failure mode — the same
 * objection worded three different ways — and morphology is most of that:
 * "it leaks memory" and "will leak memory" are the same complaint.
 */
export function semanticHash(text: string): string {
  const norm = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map(stem)
    .sort()
    .join(" ");
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

/** Suffix stripper. Not linguistics — just enough to collapse plural/verb forms. */
function stem(w: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) {
      return w.slice(0, -suffix.length);
    }
  }
  return w;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "you",
  "should",
  "would",
  "could",
  "must",
  "will",
  "have",
  "has",
  "not",
  "but",
  "are",
  "was",
  "were",
  "its",
]);

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
