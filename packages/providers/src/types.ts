import type {
  ChatChunk,
  ChatRequest,
  ModelCapabilities,
  ModelDescriptor,
  ProviderKind,
} from "@aca/protocol";

export interface Health {
  up: boolean;
  latencyMs: number;
  detail?: string;
}

export interface ResidencyControl {
  /** Models currently in VRAM, as the provider itself reports them. */
  resident(): Promise<string[]>;
  load?(model: string): Promise<void>;
  unload?(model: string): Promise<void>;
}

export interface ModelProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly privacyTier: "local" | "cloud";
  readonly baseUrl: string;

  health(): Promise<Health>;
  listModels(): Promise<ModelDescriptor[]>;
  chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;
  embed?(texts: string[], model: string): Promise<number[][]>;
  residency?: ResidencyControl;
}

export const DEFAULT_CAPS: ModelCapabilities = {
  contextWindow: 8192,
  maxOutputTokens: 4096,
  tools: "shim",
  structured: "json_mode",
  vision: false,
  thinking: false,
  streaming: true,
  concurrency: 1,
  costPer1kIn: 0,
  costPer1kOut: 0,
  privacyTier: "local",
};

export async function fetchJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? 10_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: init?.signal ?? ac.signal });
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText} from ${url}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Splits a byte stream into lines, tolerating chunk boundaries mid-line. */
export async function* lineStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) yield line;
      }
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    reader.releaseLock();
  }
}

/** Server-sent-events payload lines (`data: {...}`), stopping at `[DONE]`. */
export async function* sseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  for await (const line of lineStream(body)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return;
    try {
      yield JSON.parse(payload);
    } catch {
      // partial or keep-alive frame — skip
    }
  }
}
