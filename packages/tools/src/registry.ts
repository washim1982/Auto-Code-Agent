import { z } from "zod";
import type { Permission, Purity, SandboxTier } from "@aca/protocol";
import type { Checkpoint } from "./checkpoint.ts";

export interface ToolContext {
  root: string;
  runId: string;
  nodeId: string | null;
  /** Present only for nodes that declared a write set. */
  checkpoint: Checkpoint | null;
  signal?: AbortSignal;
  /** Requests human approval; resolves false if denied (F13). */
  requestApproval?: (summary: string, detail: string) => Promise<boolean>;
}

export interface ToolResult {
  content: string;
  /** Resources actually read — feeds the epoch cache key (F7). */
  reads?: string[];
  /** Resources actually written — bumps epochs (F7). */
  writes?: string[];
  isError?: boolean;
}

export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  purity: Purity;
  tier: SandboxTier;
  /** Cheap TTL for network tools; pure filesystem tools use epochs instead. */
  cacheTtlMs?: number;
  run(args: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  /** Only `pure` tools are cacheable at all — the rest have side effects. */
  isCacheable(name: string): boolean {
    return this.tools.get(name)?.purity === "pure";
  }

  /** JSON-schema shapes for a model's native tool-calling API. */
  describe(names?: string[]): { name: string; description: string; schema: unknown }[] {
    return this.list()
      .filter((t) => !names || names.includes(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        schema: zodToJsonSchema(t.schema),
      }));
  }
}

/** Persona × tool → allow | ask | deny, resolved once at pre-flight. */
export type PermissionMatrix = Record<string, Record<string, Permission>>;

export const DEFAULT_MATRIX: PermissionMatrix = {
  planner: { read_file: "allow", read_artifact: "allow", list_dir: "allow", glob: "allow", grep: "allow" },
  coder: {
    read_file: "allow",
    read_artifact: "allow",
    list_dir: "allow",
    glob: "allow",
    grep: "allow",
    write_file: "allow",
    edit_file: "allow",
    run_command: "allow",
    git_commit: "allow",
    git_push: "ask",
  },
  tester: {
    read_file: "allow",
    read_artifact: "allow",
    list_dir: "allow",
    glob: "allow",
    grep: "allow",
    write_file: "allow",
    run_command: "allow",
  },
  reviewer: { read_file: "allow", read_artifact: "allow", list_dir: "allow", glob: "allow", grep: "allow" },
  // The summariser reads untrusted tool output, so it gets nothing (F11).
  summarizer: {},
  chat: { read_file: "allow", read_artifact: "allow", list_dir: "allow", glob: "allow", grep: "allow" },
};

export function resolvePermission(
  matrix: PermissionMatrix,
  persona: string,
  tool: string,
): Permission {
  return matrix[persona]?.[tool] ?? "deny";
}

/** Minimal Zod → JSON Schema for tool declarations. */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as { typeName?: string };
  const described = (value: Record<string, unknown>): Record<string, unknown> =>
    schema.description ? { ...value, description: schema.description } : value;

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!value.isOptional()) required.push(key);
    }
    return described({ type: "object", properties, required, additionalProperties: false });
  }
  if (schema instanceof z.ZodString) return described({ type: "string" });
  if (schema instanceof z.ZodNumber) return described({ type: "number" });
  if (schema instanceof z.ZodBoolean) return described({ type: "boolean" });
  if (schema instanceof z.ZodArray) {
    return described({
      type: "array",
      items: zodToJsonSchema(schema.element as z.ZodTypeAny),
    });
  }
  if (schema instanceof z.ZodEnum) {
    return described({ type: "string", enum: schema.options as string[] });
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return zodToJsonSchema(schema._def.innerType as z.ZodTypeAny);
  }
  if (schema instanceof z.ZodUnion) {
    return described({
      anyOf: (schema.options as z.ZodTypeAny[]).map((o) => zodToJsonSchema(o)),
    });
  }
  return described({ type: def.typeName === "ZodNull" ? "null" : "string" });
}
