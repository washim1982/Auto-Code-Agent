import { z } from "zod";

export type JsonSchema = Record<string, unknown>;

/**
 * Zod → JSON Schema.
 *
 * Deliberately narrow: it covers exactly the constructs our tool arguments and
 * plan output use. A general converter would be a dependency and a liability —
 * the whole point is that one Zod schema drives validation, the model's
 * structured-output constraint, and the GBNF grammar, so the three can never
 * drift. Anything it cannot express is something we should not be asking a
 * model to produce.
 */
export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const described = (out: JsonSchema): JsonSchema => {
    const desc = schema.description;
    return desc ? { ...out, description: desc } : out;
  };

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = toJsonSchema(value);
      if (!value.isOptional()) required.push(key);
    }
    return described({ type: "object", properties, required, additionalProperties: false });
  }

  if (schema instanceof z.ZodString) {
    const checks = (schema._def.checks ?? []) as { kind: string; value?: number }[];
    const out: JsonSchema = { type: "string" };
    for (const c of checks) {
      if (c.kind === "min" && c.value != null) out["minLength"] = c.value;
      if (c.kind === "max" && c.value != null) out["maxLength"] = c.value;
    }
    return described(out);
  }

  if (schema instanceof z.ZodNumber) {
    const isInt = ((schema._def.checks ?? []) as { kind: string }[]).some(
      (c) => c.kind === "int",
    );
    return described({ type: isInt ? "integer" : "number" });
  }

  if (schema instanceof z.ZodBoolean) return described({ type: "boolean" });

  if (schema instanceof z.ZodArray) {
    const out: JsonSchema = {
      type: "array",
      items: toJsonSchema(schema.element as z.ZodTypeAny),
    };
    const def = schema._def as { minLength?: { value: number }; maxLength?: { value: number } };
    if (def.minLength) out["minItems"] = def.minLength.value;
    if (def.maxLength) out["maxItems"] = def.maxLength.value;
    return described(out);
  }

  if (schema instanceof z.ZodEnum) {
    return described({ type: "string", enum: schema.options as string[] });
  }

  if (schema instanceof z.ZodLiteral) {
    return described({ const: schema.value as unknown });
  }

  if (schema instanceof z.ZodUnion) {
    return described({
      anyOf: (schema.options as z.ZodTypeAny[]).map((o) => toJsonSchema(o)),
    });
  }

  if (schema instanceof z.ZodNullable) {
    return described({
      anyOf: [toJsonSchema(schema.unwrap() as z.ZodTypeAny), { type: "null" }],
    });
  }

  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return toJsonSchema(schema._def.innerType as z.ZodTypeAny);
  }

  if (schema instanceof z.ZodRecord) {
    return described({ type: "object", additionalProperties: true });
  }

  return described({});
}
