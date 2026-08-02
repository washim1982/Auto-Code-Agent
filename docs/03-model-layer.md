# Model Layer — Ollama, LM Studio, llama.cpp, Cloud

This is the stage the original diagram is missing entirely (F9). It is not a thin wrapper: routing across four backends with wildly different capabilities changes budgeting, retry semantics, structured-output strategy, and concurrency.

## Detected environment

Probed on this machine:

| Provider | Endpoint | Status | Models |
|---|---|---|---|
| Ollama 0.32.4 | `http://localhost:11434` | running | `qwen3.6:35b` (36B · 262k · vision,tools,thinking) · `gemma4:8b` (tools,thinking) · `granite4:3.4b` (131k · tools) · `qwen3.5:0.8b` (873M · 262k · vision,tools,thinking) |
| LM Studio | `http://localhost:1234` | running | `qwen/qwen3.6-27b` · `google/gemma-4-31b` · `text-embedding-nomic-embed-text-v1.5` |
| llama.cpp | `http://localhost:8080` | not running | — (managed mode: we spawn `llama-server`) |
| Cloud | — | keys not configured | Anthropic / OpenAI-compatible / Google |

That is a genuinely capable local fleet. `qwen3.6:35b` can carry coding nodes; the small models are the right tool for classification and summarization; `nomic-embed` covers T3 retrieval without a cloud call.

## The provider interface

```ts
// packages/providers/src/types.ts
export interface ModelProvider {
  readonly id: string;
  readonly kind: 'ollama' | 'lmstudio' | 'llamacpp' | 'openai-compat' | 'anthropic';
  readonly privacyTier: 'local' | 'cloud';

  health(): Promise<{ up: boolean; latencyMs: number; detail?: string }>;
  listModels(): Promise<ModelDescriptor[]>;
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>;
  embed?(texts: string[], model: string): Promise<Float32Array[]>;
  residency?: ResidencyControl;   // load / unload / keepAlive / listResident
}

export interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  tools: 'native' | 'shim' | 'none';
  structured: 'grammar' | 'json_schema' | 'json_mode' | 'none';
  vision: boolean;
  thinking: boolean;
  streaming: boolean;
  concurrency: number;            // real parallel slots, not wishful
  costPer1kIn: number;            // 0 for local
  costPer1kOut: number;
}
```

Everything downstream reasons over `ModelCapabilities`, never over a model name string. No `if (model.startsWith('gpt-'))` anywhere in `core`.

## Adapters

### Ollama — `providers/src/ollama/`
- `POST /api/chat` — native tool calling, `think: true` for reasoning models, `format` accepts a **full JSON Schema** (not just `"json"`), `options.num_ctx` to override context, `keep_alive` to control residency.
- `GET /api/tags` → installed models; `POST /api/show` → per-model detail; **`GET /api/ps` → currently resident models**. That last one is what makes the residency manager possible.
- Concurrency is governed by the server's `OLLAMA_NUM_PARALLEL`; probe it and clamp our lease count to it.
- `keep_alive: 0` forces an immediate unload — our LRU eviction lever.

### LM Studio — `providers/src/lmstudio/`
- Two APIs, and we need both. `POST /v1/chat/completions` (OpenAI-compatible) for inference with `response_format: { type: 'json_schema' }` and OpenAI-style tools.
- `GET /api/v0/models` (native REST) is strictly richer: it reports **load state** (`loaded` / `not-loaded`), architecture, quantization, and max context. Use it for discovery and residency; use `/v1` for the actual call.
- JIT loading means a first request against an unloaded model can stall 30–60s. The adapter reports `state: 'cold'` so the router can prefer a warm model or surface a "loading…" event to the UI rather than looking hung.
- Configurable TTL auto-unloads idle models — cooperate with it instead of fighting it.

### llama.cpp — `providers/src/llamacpp/`
Two operating modes, both worth supporting:

- **Attach mode** — a `llama-server` you already run. Discover via `GET /props` and `GET /health`; `GET /slots` reports parallel slot occupancy, which feeds concurrency leasing precisely.
- **Managed mode** — we spawn and own it:
  ```
  llama-server -m <model.gguf> -c <ctx> -np <slots> --host 127.0.0.1 --port <p> \
               -ngl <gpu-layers> --jinja --chat-template-file <tmpl>
  ```
  Managed mode makes GGUF files first-class: point the app at a models directory, it reads GGUF metadata headers for arch/ctx/quant, and can start the right server per task.

**llama.cpp's decisive advantage is GBNF grammar.** `POST /completion` accepts a `grammar` field that constrains decoding at the token level — the output *cannot* be malformed. For plan DAGs and tool calls this is the difference between parse-and-pray and a guarantee. The layer compiles Zod → JSON Schema → GBNF, so the same schema that validates a tool's arguments also constrains the model that generates them. `--jinja` enables proper chat templates and native tool-call parsing for models that ship a tool template.

### Cloud — `providers/src/cloud/`
- `anthropic.ts` — Messages API, prompt caching (`cache_control` on the stable prefix — the system prompt, persona, and repo map rarely change across a run, so this is a large real saving), extended thinking, streaming.
- `openai-compat.ts` — one adapter covers OpenAI, OpenRouter, Groq, DeepSeek, Together, Fireworks; differences are declared in a capability table, not in code branches.
- `google.ts` — Gemini.
- Keys from Windows Credential Manager via `keytar`. Never written to config files, never logged, redacted by the output guard.

## Capability probing — the model scorecard

Advertised capabilities lie. A model tagged `tools` may emit malformed tool calls 30% of the time; a 262k context window may degrade badly past 32k. So: **probe once per model, cache the result** in `model_scorecards`.

```ts
// packages/providers/src/probe/suite.ts
const PROBE_SUITE = [
  { id: 'tool_call_simple',   asserts: 'emits one well-formed tool call' },
  { id: 'tool_call_parallel', asserts: 'emits two calls in one turn' },
  { id: 'json_schema_strict', asserts: 'nested schema, all fields, no prose' },
  { id: 'long_ctx_needle',    asserts: 'retrieves a fact at 75% depth' },
  { id: 'instruction_negate', asserts: 'honours a "do not" constraint' },
  { id: 'diff_format',        asserts: 'produces an applicable unified diff' },
  { id: 'refusal_calibration',asserts: 'says "insufficient context" when true' },
];
```

Each runs 3 times; the scorecard records pass rate, tokens/sec, and TTFT. Output:

- `tools: 'native'` if `tool_call_simple` ≥ 0.9, `'shim'` if 0.3–0.9, `'none'` below.
- `real_ctx` = the largest needle depth that passed, **not** the advertised number.
- `reliability` feeds the router's ranking directly.

`aca models probe --all` runs the suite; the desktop Model Manager shows the scorecard as a grid. This takes a few minutes once per model and pays for itself immediately — it is why the router can safely send a plan-generation node to a local model.

## Routing

```ts
export interface ModelRequirement {
  purpose: 'plan' | 'code' | 'review' | 'summarize' | 'classify' | 'embed';
  needsTools: boolean;
  needsVision: boolean;
  needsStructured: boolean;
  minContext: number;              // computed by the context assembler
  qualityTier: 'draft' | 'standard' | 'critical';
  privacy: 'local-only' | 'prefer-local' | 'any';
  maxCostUsd?: number;
  maxLatencyMs?: number;
}
```

Resolution order:

1. **Hard filter** — capability match, health up, circuit breaker closed, `real_ctx >= minContext`, privacy tier satisfied.
2. **Rank** — `score = w_q·reliability + w_c·(1 − normCost) + w_l·(1 − normLatency) + w_r·residencyBonus`. Weights come from `qualityTier`: `draft` weights cost and latency; `critical` weights reliability almost exclusively.
3. **Residency bonus is large.** Choosing an already-loaded 27B model over swapping in a 36B one saves ~20 GB of disk→VRAM transfer. In practice this dominates on a single-GPU box.
4. **Lease** a concurrency slot from the provider's semaphore; if none free, either wait or fall through to the next candidate — a policy knob.
5. **Fallback chain** on failure, with a circuit breaker: 3 consecutive failures opens the breaker for 60s, half-open probes on the next request.

### Default policy

Concretely, for your fleet:

| Purpose | Primary | Fallback | Rationale |
|---|---|---|---|
| `classify`, `route` | `granite4:3.4b` (Ollama) | `qwen3.5:0.8b` | Sub-second, near-free, keeps the big model resident for real work |
| `summarize` (artifact guard) | `qwen3.5:0.8b` | `granite4:3.4b` | Tool-less, disposable context — F11 requires the cheapest isolated model |
| `embed` | `nomic-embed-text-v1.5` (LM Studio) | Ollama embed | Already loaded, 768-dim |
| `plan` | `qwen3.6:35b` (Ollama, `format` = DAG schema) | cloud | Structured output must be schema-constrained |
| `code` | `qwen3.6:35b` | `qwen3.6-27b` (LM Studio) | 262k context, native tools, thinking |
| `review` (critical) | cloud, if configured | `gemma-4-31b` | An independent reviewer should not share the coder's failure modes |

**The reviewer should differ from the coder.** A model reviewing its own output rubber-stamps it. If no cloud key is set, route review to a *different local family* — `gemma-4-31b` reviewing `qwen3.6:35b` output is meaningfully independent.

### Speculative tiering
For `draft` nodes, run the small model first and escalate to the large one only if the static gates fail. On mechanical edits (rename, import fix, test scaffold) the small model succeeds often enough that the average cost per node drops sharply, and the gate vector makes the escalation decision automatic rather than a guess.

## Residency management

Three backends can each hold models in VRAM, and none knows about the others. Left alone, a parallel DAG will thrash a single GPU into uselessness.

```ts
// packages/providers/src/residency/manager.ts
class ResidencyManager {
  private loadMutex = new Mutex();          // one model load at a time, globally
  async ensure(model: ModelRef): Promise<Lease>
  async evictLRU(bytesNeeded: number): Promise<void>
  async snapshot(): Promise<ResidentModel[]>  // ollama /api/ps + LM Studio /api/v0 + llama.cpp /props
}
```

Rules:
- One load in flight globally — concurrent loads of two 20 GB models is the worst case, and it is easy to hit.
- VRAM accounting from file size × quant factor, with a configurable headroom.
- Eviction by LRU: Ollama `keep_alive: 0`, LM Studio unload endpoint, llama.cpp managed-process kill.
- Scheduler parallelism is clamped by the **sum of available slots across healthy providers**, not by CPU count. A 5-node-wide DAG against one Ollama instance with `NUM_PARALLEL=2` should launch 2, not 5.

## Structured output — three strategies, one interface

```ts
async function generateStructured<T>(schema: ZodSchema<T>, req): Promise<T>
```

Strategy chosen from `capabilities.structured`:

| Capability | Backend | Mechanism | Guarantee |
|---|---|---|---|
| `grammar` | llama.cpp | Zod → JSON Schema → GBNF, token-constrained decode | Hard — cannot produce invalid output |
| `json_schema` | Ollama `format`, LM Studio, OpenAI | Server-side constrained decoding | Strong |
| `json_mode` | older cloud | "must be JSON" + validate | Weak |
| `none` | anything | Prompt + fenced extraction | Weakest |

Every strategy is followed by Zod validation, and on failure a **repair loop**: feed the validation error back with the malformed output, max 2 attempts, then downgrade to a stricter-capability model. This is the mechanism that lets small local models participate in structured stages at all.

## Tool-call shim

Models with `tools: 'shim'` or `'none'` get a prompt-level protocol: the tool registry is rendered into the system prompt, and the response is constrained (grammar or schema) to a `{ tool, args }` envelope, parsed and validated against the same Zod schema the native path uses. `core` cannot tell the difference — it sees `ToolCall` objects either way. This is what keeps `granite4:3.4b` usable for real work instead of a dead entry in the model list.

## Unified streaming

```ts
type ChatChunk =
  | { type: 'thinking'; delta: string }     // qwen3.6, gemma4, extended thinking
  | { type: 'text';     delta: string }
  | { type: 'tool_call'; id, name, argsDelta }
  | { type: 'usage'; inputTokens, outputTokens, costUsd }
  | { type: 'done'; stopReason };
```

Every adapter normalizes to this. Thinking tokens are surfaced separately so the CLI can collapse them and the desktop can show them in a side panel — and so the budget meter (F15) can account for them, since on reasoning models they are often the majority of the spend.
