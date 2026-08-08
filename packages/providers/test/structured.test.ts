import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toJsonSchema, type ChatChunk, type ModelDescriptor } from "@aca/protocol";
import { jsonSchemaToGbnf } from "../src/gbnf.ts";
import { generateStructured, StructuredOutputError, tryParse } from "../src/structured.ts";
import type { ModelProvider } from "../src/types.ts";

describe("Zod to JSON Schema", () => {
  it("marks defaulted and optional fields as not required", () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
      defaulted: z.number().default(3),
    });
    const json = toJsonSchema(schema);
    expect(json["required"]).toEqual(["required"]);
  });

  it("distinguishes integer from number", () => {
    const json = toJsonSchema(z.object({ a: z.number().int(), b: z.number() })) as {
      properties: Record<string, { type: string }>;
    };
    expect(json.properties["a"]!.type).toBe("integer");
    expect(json.properties["b"]!.type).toBe("number");
  });

  it("carries descriptions through, since they are the model's instructions", () => {
    const json = toJsonSchema(z.string().describe("a path")) as { description: string };
    expect(json.description).toBe("a path");
  });

  it("emits enums as a constrained string", () => {
    const json = toJsonSchema(z.enum(["a", "b"])) as { enum: string[] };
    expect(json.enum).toEqual(["a", "b"]);
  });

  it("closes objects so the model cannot invent fields", () => {
    const json = toJsonSchema(z.object({ a: z.string() }));
    expect(json["additionalProperties"]).toBe(false);
  });
});

describe("GBNF compiler", () => {
  it("emits a root rule plus shared primitives", () => {
    const grammar = jsonSchemaToGbnf(toJsonSchema(z.object({ a: z.string() })));
    expect(grammar.split("\n")[0]).toMatch(/^root ::=/);
    expect(grammar).toMatch(/^string ::=/m);
    expect(grammar).toMatch(/^ws ::=/m);
  });

  it("requires required keys and makes optional ones skippable", () => {
    const grammar = jsonSchemaToGbnf(
      toJsonSchema(z.object({ req: z.string(), opt: z.string().optional() })),
    );
    expect(grammar).toContain('"\\"req\\""');
    // the optional pair is wrapped in a `( ... )?` group
    expect(grammar).toMatch(/\(\s*ws\s*","\s*ws\s*"\\"opt\\""[^)]*\)\?/);
  });

  it("forbids an empty array when the schema demands members", () => {
    const nonEmpty = jsonSchemaToGbnf(
      toJsonSchema(z.object({ xs: z.array(z.string()).min(1) })),
    );
    const anySize = jsonSchemaToGbnf(toJsonSchema(z.object({ xs: z.array(z.string()) })));
    // A min(1) array must not permit `[]` — that is the degenerate plan we are
    // trying to make structurally impossible.
    const nonEmptyRule = /xs-arr[^\n]*::= ([^\n]*)/.exec(nonEmpty)?.[1] ?? "";
    const anySizeRule = /xs-arr[^\n]*::= ([^\n]*)/.exec(anySize)?.[1] ?? "";
    expect(nonEmptyRule).not.toContain("?");
    expect(anySizeRule).toContain("?");
  });

  it("expands enums to a literal alternation", () => {
    const grammar = jsonSchemaToGbnf(
      toJsonSchema(z.object({ p: z.enum(["coder", "tester"]) })),
    );
    expect(grammar).toContain('"\\"coder\\""');
    expect(grammar).toContain('"\\"tester\\""');
  });

  it("names nested rules rather than inlining them repeatedly", () => {
    const schema = z.object({
      nodes: z.array(z.object({ id: z.string(), deps: z.array(z.string()) })),
    });
    const grammar = jsonSchemaToGbnf(toJsonSchema(schema));
    const ruleNames = [...grammar.matchAll(/^([a-z0-9-]+) ::=/gm)].map((m) => m[1]);
    expect(new Set(ruleNames).size).toBe(ruleNames.length);
    expect(ruleNames.length).toBeGreaterThan(6);
  });

  it("handles the real plan schema without throwing", () => {
    const plannedNode = z.object({
      id: z.string(),
      title: z.string(),
      persona: z.enum(["coder", "tester", "reviewer", "planner"]),
      deps: z.array(z.string()),
      reads: z.array(z.string()),
      writes: z.array(z.string()),
      contract: z.string(),
    });
    const grammar = jsonSchemaToGbnf(
      toJsonSchema(z.object({ reasoning: z.string(), nodes: z.array(plannedNode).min(1) })),
    );
    expect(grammar).toMatch(/^root ::=/);
    expect(grammar.length).toBeGreaterThan(200);
  });
});

describe("JSON extraction", () => {
  it("parses a bare object", () => {
    expect(tryParse('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it("unwraps a markdown code fence, which models emit despite instructions", () => {
    const out = tryParse('Here you go:\n```json\n{"a":1}\n```\nHope that helps!');
    expect(out).toEqual({ ok: true, value: { a: 1 } });
  });

  it("finds an object buried in prose", () => {
    const out = tryParse('Sure. {"a":1} — let me know.');
    expect(out).toEqual({ ok: true, value: { a: 1 } });
  });

  it("is not fooled by braces inside strings", () => {
    const out = tryParse('prefix {"a":"}{"} suffix');
    expect(out).toEqual({ ok: true, value: { a: "}{" } });
  });

  it("reports failure rather than throwing", () => {
    const out = tryParse("no json at all");
    expect(out.ok).toBe(false);
  });
});

const shape = z.object({ name: z.string(), nodes: z.array(z.string()) });

function descriptor(over: Partial<ModelDescriptor["caps"]> = {}): ModelDescriptor {
  return {
    provider: "lmstudio",
    kind: "openai-compat",
    id: "google/gemma-4-31b",
    state: "resident",
    sizeBytes: 0,
    quantization: "",
    caps: {
      contextWindow: 32_768,
      maxOutputTokens: 4096,
      tools: "native",
      structured: "json_mode",
      vision: false,
      thinking: false,
      streaming: true,
      concurrency: 1,
      costPer1kIn: 0,
      costPer1kOut: 0,
      privacyTier: "local",
      ...over,
    },
  };
}

/** Replies with the given turns in order, each with its own stop reason. */
function replying(turns: { text: string; stopReason?: string }[]): ModelProvider & {
  asked: number[];
  prompts: string[];
} {
  let n = 0;
  const asked: number[] = [];
  const prompts: string[] = [];
  return {
    id: "lmstudio",
    kind: "openai-compat",
    privacyTier: "local",
    baseUrl: "test://",
    asked,
    prompts,
    async health() {
      return { up: true, latencyMs: 0 };
    },
    async listModels() {
      return [];
    },
    async *chat(req): AsyncIterable<ChatChunk> {
      asked.push(req.maxTokens ?? 0);
      for (const m of req.messages) prompts.push(m.content);
      const turn = turns[n++] ?? turns.at(-1)!;
      yield { type: "text", delta: turn.text };
      yield { type: "usage", inputTokens: 10, outputTokens: 10, costUsd: 0 };
      yield { type: "done", stopReason: turn.stopReason ?? "stop" };
    },
  };
}

describe("structured output failures", () => {
  it("says which field was wrong, not just that it failed", async () => {
    // "could not produce valid output after 3 attempts" names the model and
    // nothing else — there is no next step a person can take from it.
    const provider = replying([{ text: '{"name":"x"}' }]);

    await expect(
      generateStructured(descriptor(), provider, { schema: shape, messages: [] }),
    ).rejects.toThrow(/nodes/);
  });

  it("names truncation as truncation rather than as bad JSON", async () => {
    const provider = replying([{ text: '{"name":"x","nodes":["a"', stopReason: "length" }]);

    const err = (await generateStructured(descriptor(), provider, {
      schema: shape,
      messages: [],
    }).catch((e: unknown) => e)) as StructuredOutputError;

    expect(err.name).toBe("StructuredOutputError");
    expect(err.message).toMatch(/output limit/);
    expect(err.message).toMatch(/cut off/);
  });

  it("asks a truncated model to be shorter, not to 'return only JSON'", async () => {
    // Telling a model that ran out of room to return only JSON gets the same
    // overlong reply again; it has to be told to produce less.
    const provider = replying([{ text: '{"name":"x","nodes":[', stopReason: "length" }]);

    await generateStructured(descriptor(), provider, { schema: shape, messages: [] }).catch(
      () => undefined,
    );

    expect(provider.prompts.some((m) => /much shorter/i.test(m))).toBe(true);
    expect(provider.prompts.some((m) => /no prose, no code fence/i.test(m))).toBe(false);
  });

  it("keeps the raw attempts for debugging", async () => {
    const provider = replying([{ text: "not json at all" }]);

    const err = (await generateStructured(descriptor(), provider, {
      schema: shape,
      messages: [],
    }).catch((e: unknown) => e)) as StructuredOutputError;

    expect(err.attempts).toHaveLength(3);
    expect(err.attempts[0]).toContain("not json at all");
  });

  it("still recovers when the repair turn works", async () => {
    const provider = replying([
      { text: '{"name":"x"}' },
      { text: '{"name":"x","nodes":["a"]}' },
    ]);

    const result = await generateStructured(descriptor(), provider, {
      schema: shape,
      messages: [],
    });

    expect(result.value).toEqual({ name: "x", nodes: ["a"] });
    expect(result.repairs).toBe(1);
  });
});

describe("the output ceiling for structured calls", () => {
  it("asks for the model's real ceiling rather than a flat 2048", async () => {
    const provider = replying([{ text: '{"name":"x","nodes":[]}' }]);
    await generateStructured(descriptor({ maxOutputTokens: 8192 }), provider, {
      schema: shape,
      messages: [],
    });
    expect(provider.asked[0]).toBe(8192);
  });

  it("never asks for more than the model can produce", async () => {
    const provider = replying([{ text: '{"name":"x","nodes":[]}' }]);
    await generateStructured(descriptor({ maxOutputTokens: 3000 }), provider, {
      schema: shape,
      messages: [],
    });
    expect(provider.asked[0]).toBe(3000);
  });

  it("lets the caller pin it explicitly", async () => {
    const provider = replying([{ text: '{"name":"x","nodes":[]}' }]);
    await generateStructured(descriptor(), provider, {
      schema: shape,
      messages: [],
      maxTokens: 3000,
    });
    expect(provider.asked[0]).toBe(3000);
  });
});
