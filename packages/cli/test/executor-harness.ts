import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatChunk, ModelDescriptor, PlanNode } from "@aca/protocol";
import { PlanNode as PlanNodeSchema } from "@aca/protocol";
import {
  BudgetMeter,
  MemoryStore,
  CancellationToken,
  Db,
  EpochCache,
  EventLog,
  OutputGuard,
  PersonaRegistry,
} from "@aca/core";
import { ModelRouter, type ModelProvider } from "@aca/providers";
import { registerBuiltins, ToolRegistry } from "@aca/tools";
import { makeExecutor } from "../src/executor.ts";

/**
 * A test rig for `makeExecutor`.
 *
 * The tool loop is the most consequential code in the project and was the only
 * part with no test at all — six fixes landed in it on argument alone, and the
 * failure it kept producing (a node reported as "modified nothing" when it had
 * actually been cut off) is precisely the kind that reading the code does not
 * reveal. See docs/08-reliable-execution.md.
 *
 * Everything here is real except the model: real registry, real builtins, real
 * checkpoint against a real temp workspace. Only the round-trips are scripted,
 * because that is the one thing that cannot be made deterministic.
 */

/** One scripted model turn. */
export interface Turn {
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  /** Defaults to "stop", or "tool_calls" when the turn calls tools. */
  stopReason?: string;
  outputTokens?: number;
}

function turnToChunks(turn: Turn): ChatChunk[] {
  const chunks: ChatChunk[] = [];
  if (turn.text) chunks.push({ type: "text", delta: turn.text });
  for (const [i, call] of (turn.toolCalls ?? []).entries()) {
    chunks.push({
      type: "tool_call",
      call: { id: `call-${i}-${call.name}`, name: call.name, args: call.args },
    });
  }
  chunks.push({
    type: "usage",
    inputTokens: 100,
    outputTokens: turn.outputTokens ?? 20,
    costUsd: 0,
  });
  chunks.push({
    type: "done",
    stopReason: turn.stopReason ?? (turn.toolCalls?.length ? "tool_calls" : "stop"),
  });
  return chunks;
}

export interface ScriptedProvider extends ModelProvider {
  /** Requests seen so far, in order — for asserting on what the model was told. */
  readonly seen: {
    messages: { role: string; content: string }[];
    maxTokens?: number;
    tools?: string[];
  }[];
}

/**
 * A provider that plays one turn per request.
 *
 * Once the script runs out it keeps replying with bare text and no tool calls,
 * which is how a well-behaved model signals it is finished — so a test that
 * under-scripts ends the loop rather than hanging.
 */
export function scriptedProvider(
  turns: Turn[],
  caps: Partial<ModelDescriptor["caps"]> = {},
): ScriptedProvider {
  let next = 0;
  const seen: ScriptedProvider["seen"] = [];

  return {
    id: "scripted",
    kind: "openai-compat",
    privacyTier: "local",
    baseUrl: "scripted://",
    seen,
    async health() {
      return { up: true, latencyMs: 0 };
    },
    async listModels() {
      return [
        {
          provider: "scripted",
          kind: "openai-compat",
          id: "scripted-model",
          state: "resident",
          sizeBytes: 8_000_000_000,
          quantization: "",
          caps: {
            contextWindow: 32_768,
            maxOutputTokens: 4096,
            tools: "native",
            structured: "json_schema",
            vision: false,
            thinking: false,
            streaming: true,
            concurrency: 1,
            costPer1kIn: 0,
            costPer1kOut: 0,
            privacyTier: "local",
            ...caps,
          },
        },
      ];
    },
    async *chat(req) {
      seen.push({
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        ...(req.maxTokens === undefined ? {} : { maxTokens: req.maxTokens }),
        ...(req.tools === undefined ? {} : { tools: req.tools.map((t) => t.name) }),
      });
      const turn = turns[next++] ?? { text: "DONE" };
      for (const chunk of turnToChunks(turn)) yield chunk;
    },
  };
}

export interface Harness {
  root: string;
  events: EventLog;
  memory: MemoryStore;
  provider: ScriptedProvider;
  run(node: Partial<PlanNode> & { id: string }): Promise<unknown>;
  /** Event types in order, for asserting on what the loop recorded. */
  types(): string[];
  payloads(type: string): Record<string, unknown>[];
  cleanup(): void;
}

export function harness(options: {
  turns: Turn[];
  files?: Record<string, string>;
  maxSteps?: number;
  maxOutputTokens?: number;
  maxReads?: number;
  maxNodeTokens?: number;
  twoPhase?: boolean;
  caps?: Partial<ModelDescriptor["caps"]>;
}): Harness {
  const root = mkdtempSync(join(tmpdir(), "aca-exec-"));
  for (const [path, content] of Object.entries(options.files ?? {})) {
    const abs = join(root, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  const db = new Db(":memory:");
  const events = new EventLog(db);
  const cache = new EpochCache(db, events);
  const guard = new OutputGuard({ artifactDir: join(root, ".aca", "artifacts") });
  const tools = new ToolRegistry();
  registerBuiltins(tools);

  const memory = new MemoryStore(db);
  const provider = scriptedProvider(options.turns, options.caps ?? {});
  const runId = "run-test";

  const execute = makeExecutor({
    root,
    runId,
    router: new ModelRouter([provider]),
    registry: tools,
    events,
    cache,
    guard,
    localOnly: true,
    meter: new BudgetMeter({}),
    personas: new PersonaRegistry(),
    memory,
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    ...(options.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: options.maxOutputTokens }),
    ...(options.maxReads === undefined ? {} : { maxReads: options.maxReads }),
    ...(options.maxNodeTokens === undefined ? {} : { maxNodeTokens: options.maxNodeTokens }),
    ...(options.twoPhase === undefined ? {} : { twoPhase: options.twoPhase }),
  });

  return {
    root,
    events,
    memory,
    provider,
    run(node) {
      const full = PlanNodeSchema.parse({
        title: node.id,
        persona: "coder",
        sets: { read: [], write: [] },
        ...node,
      });
      return execute(full, new CancellationToken());
    },
    types() {
      return events.read(runId).map((e) => e.type);
    },
    payloads(type) {
      return events
        .read(runId)
        .filter((e) => e.type === type)
        .map((e) => e.payload);
    },
    cleanup() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
