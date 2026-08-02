import { estimateTokens } from "../review/loop.ts";

export interface ContextLayer {
  /** Ladder position — lower is higher priority. */
  rank: number;
  label: string;
  content: string;
  tokens: number;
  /** Pinned layers are never evicted, whatever the budget. */
  pinned: boolean;
  trust: "trusted" | "untrusted";
}

export interface AssembledContext {
  layers: ContextLayer[];
  text: string;
  tokens: number;
  budget: number;
  evicted: string[];
  /** True when even the pinned layers exceed the budget — an unrunnable node. */
  overflow: boolean;
}

export interface AssembleInput {
  /** Real context window of the SELECTED model — not a global constant (F8/F9). */
  contextWindow: number;
  /** Fraction of the window reserved for output. */
  headroom?: number;
  layers: Omit<ContextLayer, "tokens">[];
}

/**
 * Priority-ladder context assembler (flow review F8).
 *
 * The original flow checked the token budget once, above the planner. But the
 * recovery path re-assembles a node's context "with a wider query", and there
 * is no compaction step anywhere inside the node loop — so that widening can
 * silently blow the window.
 *
 * Here, assembly is a precondition of every model call and is measured against
 * the window of the model actually selected for this call. A 262k Qwen node and
 * a 4k local node do not get the same budget.
 */
export class ContextAssembler {
  assemble(input: AssembleInput): AssembledContext {
    const headroom = input.headroom ?? 0.25;
    const budget = Math.floor(input.contextWindow * (1 - headroom));

    const layers: ContextLayer[] = input.layers
      .map((l) => ({ ...l, tokens: estimateTokens(l.content) }))
      .sort((a, b) => a.rank - b.rank);

    const pinnedTokens = layers.filter((l) => l.pinned).reduce((s, l) => s + l.tokens, 0);

    const kept: ContextLayer[] = [];
    const evicted: string[] = [];
    let total = 0;

    // Pinned first, unconditionally — they define what the node even is.
    for (const l of layers) {
      if (!l.pinned) continue;
      kept.push(l);
      total += l.tokens;
    }

    // Then optional layers in ladder order until the budget is spent. Eviction
    // is bottom-up, which is exactly what "Compact: evict raw turns" meant.
    for (const l of layers) {
      if (l.pinned) continue;
      if (total + l.tokens > budget) {
        evicted.push(l.label);
        continue;
      }
      kept.push(l);
      total += l.tokens;
    }

    kept.sort((a, b) => a.rank - b.rank);

    return {
      layers: kept,
      text: kept.map((l) => l.content).join("\n\n"),
      tokens: total,
      budget,
      evicted,
      overflow: pinnedTokens > budget,
    };
  }
}
