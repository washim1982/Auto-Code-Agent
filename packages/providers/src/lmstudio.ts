import type { ModelDescriptor } from "@aca/protocol";
import { fetchJson } from "./types.ts";
import { OpenAiCompatProvider } from "./openai-compat.ts";

interface LmStudioModel {
  id: string;
  type?: string;
  state?: string;
  max_context_length?: number;
  quantization?: string;
  arch?: string;
}

/**
 * LM Studio.
 *
 * Inference goes over the OpenAI-compatible `/v1`, but discovery uses the
 * native `/api/v0/models`, which is strictly richer: it reports load state,
 * real max context, quantization and architecture. Without it every model
 * looks identical and "cold" is invisible — and a cold 17 GB model means the
 * first request stalls for 30-60s while it loads, which the router must be
 * able to price in rather than appear hung.
 */
export class LmStudioProvider extends OpenAiCompatProvider {
  constructor(id = "lmstudio", host = "http://127.0.0.1:1234") {
    super({
      id,
      baseUrl: `${host}/v1`,
      kind: "lmstudio",
      privacyTier: "local",
      defaultCaps: { tools: "native", structured: "json_schema", concurrency: 1 },
    });
    this.host = host;
  }

  private host: string;

  override async listModels(): Promise<ModelDescriptor[]> {
    try {
      const data = await fetchJson<{ data: LmStudioModel[] }>(`${this.host}/api/v0/models`, {
        timeoutMs: 5000,
      });
      return (data.data ?? []).map((m) => {
        const base = this.describe(m.id, m.state === "loaded" ? "resident" : "cold");
        return {
          ...base,
          quantization: m.quantization ?? "",
          caps: {
            ...base.caps,
            contextWindow: m.max_context_length ?? base.caps.contextWindow,
            ...(m.type === "embeddings"
              ? { tools: "none" as const, structured: "none" as const }
              : {}),
          },
        };
      });
    } catch {
      // Older builds may not expose /api/v0; fall back to plain /v1/models.
      return await super.listModels();
    }
  }

  readonly residency = {
    resident: async (): Promise<string[]> => {
      try {
        const data = await fetchJson<{ data: LmStudioModel[] }>(`${this.host}/api/v0/models`, {
          timeoutMs: 4000,
        });
        return (data.data ?? []).filter((m) => m.state === "loaded").map((m) => m.id);
      } catch {
        return [];
      }
    },
  };
}
