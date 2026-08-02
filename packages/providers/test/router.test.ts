import { describe, expect, it } from "vitest";
import type { ModelDescriptor, ModelRequirement } from "@aca/protocol";
import { CapabilityMismatch } from "@aca/core";
import { ModelRouter } from "../src/router.ts";
import type { ModelProvider } from "../src/types.ts";

function model(over: Partial<ModelDescriptor> & { id: string }): ModelDescriptor {
  return {
    provider: over.provider ?? "fake",
    kind: "ollama",
    id: over.id,
    state: over.state ?? "cold",
    sizeBytes: 0,
    quantization: "",
    caps: {
      contextWindow: 32_768,
      maxOutputTokens: 4096,
      tools: "native",
      structured: "json_schema",
      vision: false,
      thinking: false,
      streaming: true,
      concurrency: 1,
      costPer1kIn: 0,
      costPer1kOut: 0,
      privacyTier: "local",
      ...over.caps,
    },
  };
}

function fakeProvider(id: string, models: ModelDescriptor[]): ModelProvider {
  return {
    id,
    kind: "ollama",
    privacyTier: models[0]?.caps.privacyTier ?? "local",
    baseUrl: "http://fake",
    async health() {
      return { up: true, latencyMs: 1 };
    },
    async listModels() {
      return models.map((m) => ({ ...m, provider: id }));
    },
    // eslint-disable-next-line require-yield
    async *chat() {
      throw new Error("not used");
    },
  };
}

const req = (over: Partial<ModelRequirement> = {}): ModelRequirement => ({
  purpose: "code",
  needsTools: false,
  needsVision: false,
  needsStructured: false,
  minContext: 4096,
  qualityTier: "standard",
  privacy: "prefer-local",
  excludeModels: [],
  ...over,
});

describe("model router (F9)", () => {
  it("excludes a model whose real context is below the requirement", async () => {
    const r = new ModelRouter([
      fakeProvider("p", [
        model({ id: "small", caps: { contextWindow: 8192 } as never }),
        model({ id: "big", caps: { contextWindow: 131072 } as never }),
      ]),
    ]);
    const out = await r.route(req({ minContext: 48_000 }));
    expect(out.chosen.id).toBe("big");
    expect(out.excluded.some((e) => e.model.includes("small"))).toBe(true);
  });

  it("refuses cloud models under local-only privacy", async () => {
    const r = new ModelRouter([
      fakeProvider("cloud", [
        model({ id: "gpt", caps: { privacyTier: "cloud", contextWindow: 128000 } as never }),
      ]),
      fakeProvider("local", [model({ id: "qwen" })]),
    ]);
    const out = await r.route(req({ privacy: "local-only" }));
    expect(out.chosen.id).toBe("qwen");
    expect(out.excluded.find((e) => e.model.includes("gpt"))?.reason).toMatch(/local-only/);
  });

  it("throws CapabilityMismatch when nothing qualifies, naming why", async () => {
    const r = new ModelRouter([
      fakeProvider("p", [model({ id: "tiny", caps: { contextWindow: 2048 } as never })]),
    ]);
    await expect(r.route(req({ minContext: 200_000 }))).rejects.toThrow(CapabilityMismatch);
  });

  it("prefers a resident model over a cold one, all else equal", async () => {
    const r = new ModelRouter([
      fakeProvider("p", [
        model({ id: "cold-one", state: "cold" }),
        model({ id: "warm-one", state: "resident" }),
      ]),
    ]);
    expect((await r.route(req())).chosen.id).toBe("warm-one");
  });

  it("weights capability over residency at the critical tier", async () => {
    const r = new ModelRouter([
      fakeProvider("p", [
        model({ id: "small-warm", state: "resident", caps: { contextWindow: 8192 } as never }),
        model({ id: "big-cold", state: "cold", caps: { contextWindow: 262144 } as never }),
      ]),
    ]);
    expect((await r.route(req({ qualityTier: "draft" }))).chosen.id).toBe("small-warm");
    expect((await r.route(req({ qualityTier: "critical" }))).chosen.id).toBe("big-cold");
  });

  it("never shortlists an embedding model for a coding node", async () => {
    const r = new ModelRouter([
      fakeProvider("p", [
        model({
          id: "text-embedding-nomic",
          caps: { tools: "none", structured: "none" } as never,
        }),
        model({ id: "qwen3.6" }),
      ]),
    ]);
    const out = await r.route(req({ needsTools: true }));
    expect(out.chosen.id).toBe("qwen3.6");
    expect(out.excluded.some((e) => e.model.includes("nomic"))).toBe(true);
  });

  it("honours excludeModels, which is how the reviewer stays independent", async () => {
    const r = new ModelRouter([
      fakeProvider("p", [model({ id: "coder-model" }), model({ id: "other-model" })]),
    ]);
    const out = await r.route(req({ purpose: "review", excludeModels: ["coder-model"] }));
    expect(out.chosen.id).toBe("other-model");
  });

  it("opens a circuit breaker after repeated failures and routes elsewhere", async () => {
    const r = new ModelRouter(
      [fakeProvider("p", [model({ id: "flaky", state: "resident" }), model({ id: "steady" })])],
      { breakerThreshold: 2, breakerCooldownMs: 10_000 },
    );
    expect((await r.route(req())).chosen.id).toBe("flaky");

    r.recordFailure("p", "flaky");
    r.recordFailure("p", "flaky");

    const after = await r.route(req());
    expect(after.chosen.id).toBe("steady");
    expect(after.excluded.find((e) => e.model.includes("flaky"))?.reason).toMatch(/breaker/);
  });

  it("walks the ranked list when the top candidate throws", async () => {
    const r = new ModelRouter([
      fakeProvider("p", [model({ id: "first", state: "resident" }), model({ id: "second" })]),
    ]);
    const tried: string[] = [];
    const out = await r.withFallback(req(), async (d) => {
      tried.push(d.id);
      if (d.id === "first") throw new Error("ECONNREFUSED");
      return d.id;
    });
    expect(out).toBe("second");
    expect(tried).toEqual(["first", "second"]);
  });

  it("survives a provider that cannot be listed at all", async () => {
    const broken: ModelProvider = {
      id: "broken",
      kind: "ollama",
      privacyTier: "local",
      baseUrl: "http://nope",
      async health() {
        return { up: false, latencyMs: 0 };
      },
      async listModels() {
        throw new Error("ECONNREFUSED");
      },
      async *chat() {
        throw new Error("down");
      },
    };
    const r = new ModelRouter([broken, fakeProvider("ok", [model({ id: "alive" })])]);
    expect((await r.route(req())).chosen.id).toBe("alive");
  });
});
