import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toJsonSchema } from "@aca/protocol";
import { jsonSchemaToGbnf } from "../src/gbnf.ts";
import { tryParse } from "../src/structured.ts";

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
