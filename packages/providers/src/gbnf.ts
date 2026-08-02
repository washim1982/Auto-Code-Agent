import type { JsonSchema } from "@aca/protocol";

/**
 * JSON Schema → GBNF grammar for llama.cpp.
 *
 * This is the strongest correctness lever available on local hardware. Every
 * other structured-output strategy is a request: "please emit JSON matching
 * this shape", followed by a parse and a prayer. A GBNF grammar constrains
 * decoding at the *token* level — the model is physically unable to emit a
 * token that would make the output invalid. For plan DAGs, where one malformed
 * field means the whole run cannot start, that difference is the point.
 *
 * The grammar is emitted as named rules so repeated sub-schemas share
 * definitions rather than being inlined once per use.
 */
export class GbnfCompiler {
  private rules = new Map<string, string>();
  private counter = 0;

  compile(schema: JsonSchema, rootName = "root"): string {
    this.rules.clear();
    this.counter = 0;
    this.addPrimitives();
    const body = this.visit(schema, rootName);
    this.rules.set(rootName, body);

    // root first, then everything else, so the grammar reads top-down.
    const ordered = [
      `${rootName} ::= ${this.rules.get(rootName)}`,
      ...[...this.rules.entries()]
        .filter(([name]) => name !== rootName)
        .map(([name, rule]) => `${name} ::= ${rule}`),
    ];
    return ordered.join("\n");
  }

  private addPrimitives(): void {
    this.rules.set("ws", `[ \\t\\n]*`);
    this.rules.set(
      "string",
      `"\\"" ( [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" (["\\\\bfnrt] | "u" [0-9a-fA-F]{4}) )* "\\""`,
    );
    this.rules.set("integer", `"-"? ([0-9] | [1-9] [0-9]*)`);
    this.rules.set("number", `"-"? ([0-9] | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [-+]? [0-9]+)?`);
    this.rules.set("boolean", `"true" | "false"`);
    this.rules.set("null", `"null"`);
  }

  private nextName(hint: string): string {
    const safe = hint.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase() || "rule";
    return `${safe}-${this.counter++}`;
  }

  private define(hint: string, body: string): string {
    const name = this.nextName(hint);
    this.rules.set(name, body);
    return name;
  }

  private visit(schema: JsonSchema, hint: string): string {
    if (schema["const"] !== undefined) {
      return `"${JSON.stringify(schema["const"]).replace(/"/g, '\\"')}"`;
    }

    if (Array.isArray(schema["enum"])) {
      const options = (schema["enum"] as unknown[]).map(
        (v) => `"${JSON.stringify(v).replace(/"/g, '\\"')}"`,
      );
      return `(${options.join(" | ")})`;
    }

    if (Array.isArray(schema["anyOf"])) {
      const options = (schema["anyOf"] as JsonSchema[]).map((s, i) =>
        this.visit(s, `${hint}-alt${i}`),
      );
      return `(${options.join(" | ")})`;
    }

    switch (schema["type"]) {
      case "string":
        return "string";
      case "integer":
        return "integer";
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";

      case "array": {
        const items = schema["items"] as JsonSchema | undefined;
        const inner = items ? this.visit(items, `${hint}-item`) : "string";
        const min = Number(schema["minItems"] ?? 0);
        // A non-empty array must be spelled out; `*` would permit `[]`, which
        // is exactly the degenerate plan we are trying to make impossible.
        const body =
          min > 0
            ? `"[" ws ${inner} (ws "," ws ${inner})* ws "]"`
            : `"[" ws ( ${inner} (ws "," ws ${inner})* ws )? "]"`;
        return this.define(`${hint}-arr`, body);
      }

      case "object": {
        const properties = (schema["properties"] ?? {}) as Record<string, JsonSchema>;
        const required = new Set((schema["required"] ?? []) as string[]);
        const keys = Object.keys(properties);
        if (keys.length === 0) return `"{" ws "}"`;

        // Required keys are emitted in a fixed order; optional ones are folded
        // in as skippable groups. Fixed ordering is what keeps the grammar
        // small enough to stay fast.
        const parts: string[] = [];
        let first = true;
        for (const key of keys) {
          const valueRule = this.visit(properties[key]!, `${hint}-${key}`);
          const pair = `"\\"${key}\\"" ws ":" ws ${valueRule}`;
          if (required.has(key)) {
            parts.push(first ? `ws ${pair}` : `ws "," ws ${pair}`);
            first = false;
          } else {
            parts.push(first ? `( ws ${pair} )?` : `( ws "," ws ${pair} )?`);
          }
        }
        return this.define(`${hint}-obj`, `"{" ${parts.join(" ")} ws "}"`);
      }

      default:
        // Unconstrained value — allow any JSON scalar rather than anything.
        return `(string | number | boolean | null)`;
    }
  }
}

export function jsonSchemaToGbnf(schema: JsonSchema): string {
  return new GbnfCompiler().compile(schema);
}
