import { CapabilityMismatch } from "@aca/core";
import type { ModelDescriptor, ModelRequirement } from "@aca/protocol";
import type { ModelProvider } from "./types.ts";

export interface Candidate {
  descriptor: ModelDescriptor;
  score: number;
  terms: Record<string, number>;
}

export interface RouteDecision {
  chosen: ModelDescriptor;
  provider: ModelProvider;
  ranked: Candidate[];
  excluded: { model: string; reason: string }[];
}

interface Breaker {
  failures: number;
  openUntil: number;
}

/**
 * Capability-based router (flow review F9).
 *
 * The original flow had no model-selection stage at all — the sub-agent simply
 * "proposed a tool call" and something, somewhere, ran an LLM. With four
 * backends of wildly different capability that is not a detail: it decides the
 * context budget, whether tool calling works, whether the request is even
 * legal under a local-only privacy policy, and what a failure means.
 *
 * Selection is: hard filter -> weighted rank -> circuit breaker -> fallback.
 * Nothing here ever branches on a model *name*.
 */
export class ModelRouter {
  private breakers = new Map<string, Breaker>();
  private cache: { at: number; models: ModelDescriptor[] } | null = null;

  private providers: ModelProvider[];
  private options: { cacheMs?: number; breakerThreshold?: number; breakerCooldownMs?: number };

  constructor(
    providers: ModelProvider[],
    options: { cacheMs?: number; breakerThreshold?: number; breakerCooldownMs?: number } = {},
  ) {
    this.providers = providers;
    this.options = options;
  }

  provider(id: string): ModelProvider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  async catalogue(force = false): Promise<ModelDescriptor[]> {
    const ttl = this.options.cacheMs ?? 15_000;
    if (!force && this.cache && Date.now() - this.cache.at < ttl) return this.cache.models;

    const all: ModelDescriptor[] = [];
    await Promise.all(
      this.providers.map(async (p) => {
        try {
          all.push(...(await p.listModels()));
        } catch {
          // an unreachable provider contributes nothing; the breaker handles it
        }
      }),
    );
    this.cache = { at: Date.now(), models: all };
    return all;
  }

  private pinned: string | null = null;

  /**
   * Restricts routing to a single model.
   *
   * The user pinning a model is a stronger signal than any capability score —
   * usually they are pinning something small and warm because they do not want
   * to wait 60s for a 17 GB model to page into VRAM. Capability filters still
   * apply, so a pin that genuinely cannot do the job still fails loudly rather
   * than silently producing garbage.
   */
  pin(modelId: string | null): void {
    this.pinned = modelId;
  }

  get pinnedModel(): string | null {
    return this.pinned;
  }

  private breakerKey(d: ModelDescriptor): string {
    return `${d.provider}:${d.id}`;
  }

  recordFailure(providerId: string, model: string): void {
    const key = `${providerId}:${model}`;
    const b = this.breakers.get(key) ?? { failures: 0, openUntil: 0 };
    b.failures++;
    if (b.failures >= (this.options.breakerThreshold ?? 3)) {
      b.openUntil = Date.now() + (this.options.breakerCooldownMs ?? 60_000);
      b.failures = 0;
    }
    this.breakers.set(key, b);
  }

  recordSuccess(providerId: string, model: string): void {
    this.breakers.delete(`${providerId}:${model}`);
  }

  private isOpen(d: ModelDescriptor): boolean {
    const b = this.breakers.get(this.breakerKey(d));
    return !!b && b.openUntil > Date.now();
  }

  async route(req: ModelRequirement): Promise<RouteDecision> {
    const models = await this.catalogue();
    const excluded: { model: string; reason: string }[] = [];
    const eligible: ModelDescriptor[] = [];

    for (const m of models) {
      const reason = this.rejectReason(m, req);
      if (reason) {
        excluded.push({ model: `${m.provider}/${m.id}`, reason });
        continue;
      }
      eligible.push(m);
    }

    if (eligible.length === 0) {
      throw new CapabilityMismatch(
        `no model satisfies ${req.purpose} requirement` +
          (excluded.length
            ? ` — closest rejections: ${excluded
                .slice(0, 3)
                .map((e) => `${e.model} (${e.reason})`)
                .join("; ")}`
            : " — no providers reachable"),
      );
    }

    const weights = WEIGHTS[req.qualityTier];
    const maxCost = Math.max(
      ...eligible.map((m) => m.caps.costPer1kIn + m.caps.costPer1kOut),
      0.000001,
    );

    const ranked: Candidate[] = eligible
      .map((d) => {
        const cost = (d.caps.costPer1kIn + d.caps.costPer1kOut) / maxCost;
        const terms = {
          capability: capabilityScore(d),
          nativeTools: d.caps.tools === "native" ? 1 : d.caps.tools === "shim" ? 0.4 : 0,
          cost: 1 - cost,
          // Choosing an already-loaded model over swapping in another can save
          // 20 GB of disk->VRAM transfer. On one GPU this dominates.
          residency: d.state === "resident" ? 1 : 0,
          local: d.caps.privacyTier === "local" ? 1 : 0,
        };
        const score =
          weights.capability * terms.capability +
          weights.nativeTools * terms.nativeTools +
          weights.cost * terms.cost +
          weights.residency * terms.residency +
          weights.local * terms.local;
        return { descriptor: d, score, terms };
      })
      .sort((a, b) => b.score - a.score);

    const chosen = ranked[0]!.descriptor;
    const provider = this.provider(chosen.provider);
    if (!provider) throw new CapabilityMismatch(`provider ${chosen.provider} vanished`);

    return { chosen, provider, ranked, excluded };
  }

  /** Why a model cannot serve this requirement, or null if it can. */
  private rejectReason(m: ModelDescriptor, req: ModelRequirement): string | null {
    if (this.pinned && m.id !== this.pinned) return `not the pinned model (${this.pinned})`;
    if (this.isOpen(m)) return "circuit breaker open";
    if (req.excludeModels.includes(m.id)) return "excluded by requirement";
    if (req.privacy === "local-only" && m.caps.privacyTier !== "local") {
      return "privacy is local-only";
    }
    if (req.needsTools && m.caps.tools === "none") return "no tool support";
    if (req.needsVision && !m.caps.vision) return "no vision support";
    if (req.needsStructured && m.caps.structured === "none") {
      return "no structured output";
    }
    if (m.caps.contextWindow < req.minContext) {
      return `context ${m.caps.contextWindow} < required ${req.minContext}`;
    }
    if (req.purpose === "embed" && !/embed/i.test(m.id)) return "not an embedding model";
    if (req.purpose !== "embed" && /embed/i.test(m.id)) return "embedding-only model";
    if (req.maxCostUsd != null && m.caps.costPer1kIn > req.maxCostUsd) {
      return "exceeds cost ceiling";
    }
    return null;
  }

  /**
   * Routes, then walks the ranked list on failure.
   *
   * This is the `provider_unavailable` recovery edge the original flow had no
   * class for: a dead provider is not a transient error and retrying the same
   * model cannot help.
   */
  async withFallback<T>(
    req: ModelRequirement,
    fn: (d: ModelDescriptor, p: ModelProvider) => Promise<T>,
    maxAttempts = 3,
  ): Promise<T> {
    const decision = await this.route(req);
    let lastError: unknown;

    for (const candidate of decision.ranked.slice(0, maxAttempts)) {
      const provider = this.provider(candidate.descriptor.provider);
      if (!provider) continue;
      try {
        const out = await fn(candidate.descriptor, provider);
        this.recordSuccess(candidate.descriptor.provider, candidate.descriptor.id);
        return out;
      } catch (err) {
        lastError = err;
        this.recordFailure(candidate.descriptor.provider, candidate.descriptor.id);
      }
    }
    throw lastError ?? new Error("all candidates failed");
  }
}

/**
 * How capable a model is likely to be, in [0,1].
 *
 * Context window alone is a terrible proxy: `qwen3.5:0.8b` advertises the same
 * 262k window as `qwen3.6:35b` and would tie with it for a coding node — which
 * is exactly what the first version of this function did. Weight parameter
 * scale much more heavily than window size, since a 0.8B model is not going to
 * write correct middleware however much context you hand it.
 *
 * `sizeBytes` (on-disk weights) is the honest signal available without a probe.
 * Where a provider does not report it we fall back to a neutral prior rather
 * than pretending to know; the probe suite is what resolves those properly.
 */
export function capabilityScore(d: ModelDescriptor): number {
  const scale =
    d.sizeBytes > 0
      ? // ~1 GB -> 0.19, ~8 GB -> 0.60, ~24 GB -> 0.87, 40 GB+ -> 1.0
        Math.min(Math.log10(d.sizeBytes / 1e9 + 1) / Math.log10(41), 1)
      : d.caps.privacyTier === "cloud"
        ? 0.9 // frontier cloud models are large by assumption
        : 0.5; // unknown local model — neutral prior, not a guess
  const window = Math.min(d.caps.contextWindow / 131072, 1);
  return 0.75 * scale + 0.25 * window;
}

/**
 * Weights per quality tier. `draft` buys speed and cheapness; `critical`
 * spends almost everything on capability and native tool support.
 */
const WEIGHTS: Record<
  ModelRequirement["qualityTier"],
  { capability: number; nativeTools: number; cost: number; residency: number; local: number }
> = {
  draft: { capability: 0.1, nativeTools: 0.15, cost: 0.3, residency: 0.4, local: 0.05 },
  standard: { capability: 0.3, nativeTools: 0.2, cost: 0.1, residency: 0.35, local: 0.05 },
  // At `critical` the residency bonus is deliberately small: paying a 20 GB
  // model load is the right trade when correctness is what you are buying.
  critical: { capability: 0.58, nativeTools: 0.3, cost: 0.02, residency: 0.05, local: 0.05 },
};
