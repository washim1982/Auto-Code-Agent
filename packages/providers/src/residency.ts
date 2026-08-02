import type { ModelProvider } from "./types.ts";

/**
 * A global mutex over "load a model into VRAM".
 *
 * Three backends can each hold models in VRAM and none knows about the others.
 * Left alone, a 5-wide DAG will ask for three different 30B models at once and
 * thrash a single GPU into uselessness. Serialising loads is the cheapest fix
 * that actually works.
 */
export class ResidencyManager {
  private chain: Promise<unknown> = Promise.resolve();

  private providers: ModelProvider[];

  constructor(providers: ModelProvider[]) {
    this.providers = providers;
  }

  /** Runs `fn` with the global load lock held. */
  async withLoadLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    // Keep the chain alive even if this load rejects.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Every resident model across every provider, as they report it. */
  async snapshot(): Promise<{ provider: string; model: string }[]> {
    const out: { provider: string; model: string }[] = [];
    await Promise.all(
      this.providers.map(async (p) => {
        if (!p.residency) return;
        try {
          for (const model of await p.residency.resident()) {
            out.push({ provider: p.id, model });
          }
        } catch {
          // a provider that cannot answer is simply not contributing
        }
      }),
    );
    return out;
  }

  async ensureLoaded(providerId: string, model: string): Promise<void> {
    const provider = this.providers.find((p) => p.id === providerId);
    if (!provider?.residency?.load) return;
    const resident = await provider.residency.resident().catch((): string[] => []);
    if (resident.includes(model)) return;
    await this.withLoadLock(async () => {
      await provider.residency!.load!(model);
    });
  }

  async unload(providerId: string, model: string): Promise<void> {
    const provider = this.providers.find((p) => p.id === providerId);
    await provider?.residency?.unload?.(model);
  }

  /**
   * Total parallel slots across healthy providers.
   *
   * Scheduler width must be clamped by this, not by CPU count: a 5-node-wide
   * DAG against one Ollama with NUM_PARALLEL=2 should launch 2.
   */
  async totalSlots(): Promise<number> {
    let slots = 0;
    for (const p of this.providers) {
      const health = await p.health().catch(() => ({ up: false, latencyMs: 0 }));
      if (!health.up) continue;
      const models = await p.listModels().catch(() => []);
      slots += Math.max(...models.map((m) => m.caps.concurrency), 1);
    }
    return Math.max(slots, 1);
  }
}
