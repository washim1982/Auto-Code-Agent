import { z } from "zod";

export const ProviderKind = z.enum([
  "ollama",
  "lmstudio",
  "llamacpp",
  "openai-compat",
  "anthropic",
]);
export type ProviderKind = z.infer<typeof ProviderKind>;

export const ModelCapabilities = z.object({
  contextWindow: z.number().int(),
  maxOutputTokens: z.number().int().default(4096),
  /** `shim` means we drive tool calls through constrained prompting instead. */
  tools: z.enum(["native", "shim", "none"]),
  structured: z.enum(["grammar", "json_schema", "json_mode", "none"]),
  vision: z.boolean().default(false),
  thinking: z.boolean().default(false),
  streaming: z.boolean().default(true),
  /** Real parallel slots, not wishful thinking. Clamps scheduler width. */
  concurrency: z.number().int().min(1).default(1),
  costPer1kIn: z.number().default(0),
  costPer1kOut: z.number().default(0),
  privacyTier: z.enum(["local", "cloud"]).default("local"),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilities>;

export const ModelDescriptor = z.object({
  provider: z.string(),
  kind: ProviderKind,
  id: z.string(),
  /** `resident` models are already in VRAM — a large routing bonus. */
  state: z.enum(["resident", "cold", "unavailable"]).default("cold"),
  sizeBytes: z.number().default(0),
  quantization: z.string().default(""),
  caps: ModelCapabilities,
});
export type ModelDescriptor = z.infer<typeof ModelDescriptor>;

/**
 * What a node needs from a model. The router filters on this, never on a
 * model name — there is no `if (model.startsWith("gpt-"))` anywhere in core.
 */
export const ModelRequirement = z.object({
  purpose: z.enum(["plan", "code", "review", "summarize", "classify", "chat", "embed"]),
  needsTools: z.boolean().default(false),
  needsVision: z.boolean().default(false),
  needsStructured: z.boolean().default(false),
  minContext: z.number().int().default(4096),
  qualityTier: z.enum(["draft", "standard", "critical"]).default("standard"),
  privacy: z.enum(["local-only", "prefer-local", "any"]).default("prefer-local"),
  maxCostUsd: z.number().optional(),
  /** Models to avoid — used to keep the reviewer independent of the coder. */
  excludeModels: z.array(z.string()).default([]),
});
export type ModelRequirement = z.infer<typeof ModelRequirement>;

export const ChatRole = z.enum(["system", "user", "assistant", "tool"]);

export const ToolCall = z.object({
  id: z.string(),
  name: z.string(),
  args: z.record(z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ChatMessage = z.object({
  role: ChatRole,
  content: z.string(),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
  /**
   * The calls an assistant turn requested.
   *
   * Every provider API requires the assistant turn to carry its own tool calls
   * before a `tool` message answering them means anything: OpenAI binds on
   * `tool_call_id`, Anthropic on `tool_use_id`, Ollama on position. Omitting
   * this drops the link between a call and its result, so the model cannot see
   * that it already ran the tool — and it calls it again, every round, until
   * the step budget is gone.
   */
  toolCalls: z.array(ToolCall).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export type ChatChunk =
  | { type: "thinking"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: "done"; stopReason: string };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: { name: string; description: string; schema: unknown }[];
  /** JSON Schema for constrained decoding when the backend supports it. */
  responseSchema?: unknown;
  temperature?: number;
  maxTokens?: number;
  think?: boolean;
  numCtx?: number;
}
