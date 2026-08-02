import type { z } from "zod";
import { toJsonSchema, type ChatMessage, type ModelDescriptor } from "@aca/protocol";
import { jsonSchemaToGbnf } from "./gbnf.ts";
import { LlamaCppProvider } from "./llamacpp.ts";
import { collectText } from "./discover.ts";
import type { ModelProvider } from "./types.ts";

export interface StructuredRequest<T> {
  schema: z.ZodType<T>;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Attempts to repair invalid output before giving up. */
  maxRepairs?: number;
  signal?: AbortSignal;
}

export interface StructuredResult<T> {
  value: T;
  strategy: "grammar" | "json_schema" | "json_mode" | "prompt";
  repairs: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

export class StructuredOutputError extends Error {
  readonly attempts: string[];

  constructor(message: string, attempts: string[]) {
    super(message);
    this.name = "StructuredOutputError";
    this.attempts = attempts;
  }
}

/**
 * Gets structured output from any backend, using the strongest mechanism the
 * chosen model actually supports.
 *
 *   grammar      llama.cpp GBNF — token-level, cannot produce invalid output
 *   json_schema  server-side constrained decoding (Ollama `format`, LM Studio, OpenAI)
 *   json_mode    "must be JSON" plus validation
 *   prompt       fenced extraction, the weakest fallback
 *
 * Every strategy is followed by Zod validation, and a failure feeds the
 * validation error back to the model as a repair turn. That loop is what lets
 * small local models participate in structured stages at all — a 3B model
 * rarely nails a nested schema first try, but it corrects reliably when told
 * exactly which field was wrong.
 */
export async function generateStructured<T>(
  descriptor: ModelDescriptor,
  provider: ModelProvider,
  req: StructuredRequest<T>,
): Promise<StructuredResult<T>> {
  const jsonSchema = toJsonSchema(req.schema);
  const maxRepairs = req.maxRepairs ?? 2;
  const attempts: string[] = [];

  const messages: ChatMessage[] = [...req.messages];
  let usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const strategy = strategyFor(descriptor);

  for (let repair = 0; repair <= maxRepairs; repair++) {
    let raw: string;

    if (strategy === "grammar" && provider instanceof LlamaCppProvider) {
      const grammar = jsonSchemaToGbnf(jsonSchema);
      raw = await provider.completeWithGrammar(renderPrompt(messages), grammar, req.signal);
    } else {
      const stream = provider.chat(
        {
          model: descriptor.id,
          messages:
            strategy === "json_schema"
              ? messages
              : [...messages, { role: "system", content: schemaInstruction(jsonSchema) }],
          ...(strategy === "json_schema" ? { responseSchema: jsonSchema } : {}),
          maxTokens: req.maxTokens ?? 2048,
          temperature: 0,
        },
        req.signal,
      );
      const out = await collectText(stream);
      raw = out.text;
      usage = {
        inputTokens: usage.inputTokens + out.usage.inputTokens,
        outputTokens: usage.outputTokens + out.usage.outputTokens,
        costUsd: usage.costUsd + out.usage.costUsd,
      };
    }

    attempts.push(raw.slice(0, 500));

    const parsed = tryParse(raw);
    if (parsed.ok) {
      const validated = req.schema.safeParse(parsed.value);
      if (validated.success) {
        return { value: validated.data, strategy, repairs: repair, usage };
      }
      // Tell the model exactly which field is wrong — vague feedback produces
      // a vague correction.
      messages.push({ role: "assistant", content: raw.slice(0, 2000) });
      messages.push({
        role: "user",
        content:
          `That output did not validate. Fix ONLY these problems and return the corrected JSON:\n` +
          validated.error.issues
            .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("\n"),
      });
      continue;
    }

    messages.push({ role: "assistant", content: raw.slice(0, 2000) });
    messages.push({
      role: "user",
      content: `That was not valid JSON (${parsed.error}). Return only a JSON object, no prose, no code fence.`,
    });
  }

  throw new StructuredOutputError(
    `model ${descriptor.provider}/${descriptor.id} could not produce valid output after ${maxRepairs + 1} attempts`,
    attempts,
  );
}

function strategyFor(d: ModelDescriptor): StructuredResult<unknown>["strategy"] {
  switch (d.caps.structured) {
    case "grammar":
      return "grammar";
    case "json_schema":
      return "json_schema";
    case "json_mode":
      return "json_mode";
    default:
      return "prompt";
  }
}

function schemaInstruction(schema: Record<string, unknown>): string {
  return [
    "Respond with a single JSON object and nothing else.",
    "No prose before or after. No markdown code fence.",
    "It must validate against this JSON Schema:",
    JSON.stringify(schema),
  ].join("\n");
}

function renderPrompt(messages: ChatMessage[]): string {
  return (
    messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n") +
    "\n\nASSISTANT: "
  );
}

/**
 * Extracts JSON from a model response.
 *
 * Models wrap output in code fences and add commentary even when told not to,
 * so we strip fences and, failing that, scan for the outermost balanced object.
 */
export function tryParse(
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  candidates.push(trimmed);

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());

  const balanced = extractBalanced(trimmed);
  if (balanced) candidates.push(balanced);

  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, error: "no parseable JSON object found" };
}

/** Outermost balanced {...}, ignoring braces inside strings. */
function extractBalanced(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
