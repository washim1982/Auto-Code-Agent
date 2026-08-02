import { statSync } from "node:fs";
import type { ModelDescriptor } from "@aca/protocol";
import { fetchJson, type Health } from "./types.ts";
import { OpenAiCompatProvider } from "./openai-compat.ts";

interface LlamaProps {
  role?: string;
  default_generation_settings?: { n_ctx?: number };
  model_path?: string;
  total_slots?: number;
}

interface RouterModel {
  id: string;
  status?: { value?: string; args?: string[] };
}

/** Value following `flag` in an argv array, or null. */
function argValue(args: readonly string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? (args[i + 1] ?? null) : null;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function quantFromName(id: string): string {
  return /(?:^|[-_.])(IQ\d\w*|Q\d_[KM0-9_A-Z]*|F16|BF16|F32)/i.exec(id)?.[1] ?? "";
}

/**
 * llama.cpp `llama-server`.
 *
 * Attach mode only for now — managed mode (spawning `llama-server` against a
 * chosen .gguf) needs a configured binary path and is gated behind that.
 *
 * The reason this backend earns its own adapter rather than being just another
 * OpenAI-compatible endpoint: `/completion` accepts a GBNF `grammar` that
 * constrains decoding at the token level. That is the difference between
 * parse-and-pray and a structural guarantee, and for plan DAGs it is the
 * strongest correctness lever available on local hardware.
 */
export class LlamaCppProvider extends OpenAiCompatProvider {
  private host: string;

  constructor(id = "llamacpp", host = "http://127.0.0.1:8080") {
    super({
      id,
      baseUrl: `${host}/v1`,
      kind: "llamacpp",
      privacyTier: "local",
      defaultCaps: {
        tools: "native",
        // Token-level constraint, not best-effort JSON.
        structured: "grammar",
        concurrency: 1,
      },
    });
    this.host = host;
  }

  override async health(): Promise<Health> {
    const started = Date.now();
    try {
      await fetchJson(`${this.host}/health`, { timeoutMs: 2500 });
      return { up: true, latencyMs: Date.now() - started };
    } catch (err) {
      return { up: false, latencyMs: Date.now() - started, detail: (err as Error).message };
    }
  }

  override async listModels(): Promise<ModelDescriptor[]> {
    const props = await fetchJson<LlamaProps>(`${this.host}/props`, { timeoutMs: 4000 });

    // Two deployment shapes, and they report themselves very differently.
    //
    //   single   one model per server; /props describes it directly
    //   router   (Llama AI Studio and newer llama-server) manages a pool of
    //            GGUFs and autoloads on demand. /props then describes the
    //            *router*, with model_path "none" and n_ctx 0 — which naively
    //            read produces a phantom zero-context model that the router
    //            would then have to exclude on every single request.
    if (props.role === "router") return await this.listRouterModels();

    const name = (props.model_path ?? "llama.cpp").split(/[\\/]/).pop() ?? "llama.cpp";
    const ctx = props.default_generation_settings?.n_ctx ?? 0;
    if (!ctx) return []; // nothing actually loaded — advertise nothing

    const base = this.describe(name, "resident");
    return [
      {
        ...base,
        caps: {
          ...base.caps,
          contextWindow: ctx,
          concurrency: props.total_slots ?? 1, // real slots, from the server
        },
      },
    ];
  }

  private async listRouterModels(): Promise<ModelDescriptor[]> {
    const data = await fetchJson<{ data?: RouterModel[] }>(`${this.host}/v1/models`, {
      timeoutMs: 5000,
    });

    return (data.data ?? []).map((m) => {
      // The launch argv the router will use carries the real settings.
      const args = m.status?.args ?? [];
      const ctx = Number(argValue(args, "--ctx-size") ?? 0) || 4096;
      const parallel = Number(argValue(args, "--parallel") ?? 0) || 1;
      const modelPath = argValue(args, "--model");

      const base = this.describe(m.id, m.status?.value === "loaded" ? "resident" : "cold");
      return {
        ...base,
        // Weights on disk are the honest capability signal; the router does not
        // report a size, but it does tell us where the file is.
        sizeBytes: modelPath ? fileSize(modelPath) : 0,
        quantization: quantFromName(m.id),
        caps: { ...base.caps, contextWindow: ctx, concurrency: parallel },
      };
    });
  }

  /**
   * Constrained completion via GBNF. Bypasses the chat API deliberately —
   * `/completion` is where the grammar parameter lives.
   */
  async completeWithGrammar(
    prompt: string,
    grammar: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const res = await fetch(`${this.host}/completion`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, grammar, n_predict: 2048, stream: false }),
      signal,
    });
    if (!res.ok) throw new Error(`llama.cpp completion failed: ${res.status}`);
    const data = (await res.json()) as { content?: string };
    return data.content ?? "";
  }

  readonly residency = {
    resident: async (): Promise<string[]> => {
      const models = await this.listModels().catch(() => []);
      return models.filter((m) => m.state === "resident").map((m) => m.id);
    },
  };
}
