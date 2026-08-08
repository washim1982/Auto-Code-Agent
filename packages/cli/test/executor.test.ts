import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { harness, type Harness } from "./executor-harness.ts";

let h: Harness;
afterEach(() => h?.cleanup());

describe("node tool loop", () => {
  it("runs tools and completes when the model stops calling them", async () => {
    h = harness({
      files: { "a.md": "hello\n" },
      turns: [
        { toolCalls: [{ name: "read_file", args: { path: "a.md" } }] },
        { text: "DONE" },
      ],
    });

    const result = await h.run({ id: "n1" });

    expect(h.types()).toContain("tool.called");
    expect(h.types()).toContain("tool.result");
    expect(h.payloads("tool.called")[0]).toMatchObject({
      tool: "read_file",
      input: '{\n  "path": "a.md"\n}',
    });
    expect(h.payloads("tool.result")[0]).toMatchObject({
      tool: "read_file",
      output: "hello\n",
      isError: false,
    });
    expect(h.payloads("tool.called")[0]?.["callId"]).toBe(
      h.payloads("tool.result")[0]?.["callId"],
    );
    expect((result as { gates: { passed: boolean } }).gates.passed).toBe(true);
  });

  it("writes a declared file and passes", async () => {
    h = harness({
      turns: [
        {
          toolCalls: [
            { name: "write_file", args: { path: "out.md", content: "# plan\n" } },
          ],
        },
        { text: "DONE" },
      ],
    });

    const result = await h.run({ id: "n1", sets: { read: [], write: ["out.md"] } });

    expect(readFileSync(join(h.root, "out.md"), "utf8")).toBe("# plan\n");
    expect((result as { writes: string[] }).writes).toContain("out.md");
    expect(h.payloads("tool.called")[0]).toMatchObject({
      codePath: "out.md",
      code: "# plan\n",
    });
  });
});

describe("gates on a read-only node", () => {
  it("does not run project-wide gates when the node declares no writes", async () => {
    // A package.json with a failing typecheck script is exactly the workspace
    // that killed run-msg1o2a4: the analysis node changed nothing and was
    // failed for breakage that predated the run.
    h = harness({
      files: {
        "package.json": JSON.stringify({
          scripts: { typecheck: "node -e \"process.exit(1)\"" },
        }),
      },
      turns: [{ text: "DONE" }],
    });

    const result = await h.run({ id: "analyze", sets: { read: [], write: [] } });

    expect((result as { gates: { passed: boolean; results: unknown[] } }).gates).toEqual({
      results: [],
      passed: true,
    });
  });

  it("runs only the secrets gate for a written analysis artifact", async () => {
    h = harness({
      files: {
        "package.json": JSON.stringify({
          scripts: { typecheck: "node -e \"process.exit(1)\"" },
        }),
      },
      turns: [
        {
          toolCalls: [
            {
              name: "write_file",
              args: { path: ".studio/gap_analysis.json", content: "{\"missing\":[]}\n" },
            },
          ],
        },
        { text: "DONE" },
      ],
    });

    const result = await h.run({
      id: "analyze_gaps",
      sets: { read: [], write: [".studio/gap_analysis.json"] },
    });
    const gates = (result as { gates: { passed: boolean; results: { gate: string }[] } }).gates;

    expect(gates.passed).toBe(true);
    expect(gates.results.map((gate) => gate.gate)).toEqual(["secrets"]);
  });

  it("does not blame a source edit for an unchanged pre-existing gate failure", async () => {
    h = harness({
      files: {
        "package.json": JSON.stringify({
          scripts: {
            typecheck:
              "node -e \"console.error('electron/main.ts(1,1): error TS2304: pre-existing'); process.exit(1)\"",
          },
        }),
      },
      turns: [
        {
          toolCalls: [
            { name: "write_file", args: { path: "src/new.ts", content: "export const ok = true;\n" } },
          ],
        },
        { text: "DONE" },
      ],
    });

    const result = await h.run({
      id: "implement",
      sets: { read: [], write: ["src/new.ts"] },
    });
    const gates = (
      result as { gates: { passed: boolean; results: { gate: string; detail: string }[] } }
    ).gates;

    expect(gates.passed).toBe(true);
    expect(gates.results.find((gate) => gate.gate === "typecheck")?.detail).toContain(
      "pre-existing",
    );
  });

  it("accepts a correct no-op when the node's write policy is optional", async () => {
    h = harness({
      files: { "package.json": "{\"dependencies\":{}}\n" },
      turns: [{ text: "No new packages are needed. DONE" }],
    });

    const result = await h.run({
      id: "update_deps",
      writePolicy: "optional",
      contract: "Update package.json only if new packages are needed.",
      sets: { read: ["package.json"], write: ["package.json"] },
    });

    expect((result as { writes: string[] }).writes).toEqual([]);
    expect((result as { gates: { passed: boolean } }).gates.passed).toBe(true);
    expect(h.provider.seen[0]!.messages.map((message) => message.content).join("\n")).toContain(
      "Write policy: OPTIONAL",
    );
  });
});

describe("step budget", () => {
  it("warns the model before the cap, naming the file it still owes", async () => {
    // Six steps, one declared write: reserve is max(2, 2) = 2, so the notice
    // lands with two steps left rather than after the loop has already ended.
    const turns = Array.from({ length: 10 }, () => ({
      toolCalls: [{ name: "list_dir", args: { path: "." } }],
    }));
    h = harness({ turns, maxSteps: 6 });

    await h.run({ id: "n1", sets: { read: [], write: ["out.md"] } }).catch(() => {});

    expect(h.payloads("node.steps_low")).toHaveLength(1);
    const warned = h.provider.seen.find((r) =>
      r.messages.some((m) => m.content.includes("steps left")),
    );
    expect(warned).toBeDefined();
    expect(
      warned!.messages.some((m) => m.content.includes("out.md") && m.content.includes("write_file")),
    ).toBe(true);
  });

  it("reports running out of steps as such, not as the model refusing to write", async () => {
    const turns = Array.from({ length: 20 }, () => ({
      toolCalls: [{ name: "list_dir", args: { path: "." } }],
    }));
    h = harness({ turns, maxSteps: 4 });

    await expect(
      h.run({ id: "n1", sets: { read: [], write: ["out.md"] } }),
    ).rejects.toThrow(/ran out of steps \(4\/4\)/);
  });

  it("still reports a genuine no-op as modifying nothing", async () => {
    h = harness({ turns: [{ text: "I would change out.md but I will not." }] });

    await expect(
      h.run({ id: "n1", sets: { read: [], write: ["out.md"] } }),
    ).rejects.toThrow(/but modified nothing/);
  });
});

describe("truncated responses", () => {
  it("does not mistake a cut-off response for a finished one", async () => {
    // The failure from run-msgrnd0w: the model began emitting write_file with a
    // whole source file, hit the output ceiling mid-JSON, and the unparseable
    // call read as "no tool calls" — i.e. as the model having finished.
    h = harness({
      turns: [
        { text: '{"path":"out.md","content":"# pl', stopReason: "length" },
        {
          toolCalls: [
            { name: "write_file", args: { path: "out.md", content: "# plan\n" } },
          ],
        },
        { text: "DONE" },
      ],
    });

    const result = await h.run({ id: "n1", sets: { read: [], write: ["out.md"] } });

    expect(h.payloads("model.truncated")).toHaveLength(1);
    expect((result as { writes: string[] }).writes).toContain("out.md");
    expect(readFileSync(join(h.root, "out.md"), "utf8")).toBe("# plan\n");
  });

  it("tells the model its call was cut off so the retry can be smaller", async () => {
    h = harness({
      turns: [
        { text: "partial", stopReason: "length" },
        { text: "DONE" },
      ],
    });

    await h.run({ id: "n1" });

    const told = h.provider.seen.some((r) =>
      r.messages.some((m) => m.content.includes("cut off at the output limit")),
    );
    expect(told).toBe(true);
  });

  it("asks for the model's real output ceiling rather than a hardcoded 2000", async () => {
    h = harness({
      turns: [{ text: "DONE" }],
      caps: { maxOutputTokens: 8192 },
    });

    await h.run({ id: "n1" });

    expect(h.provider.seen[0]?.maxTokens).toBe(8192);
  });

  it("never asks for more than the model can produce", async () => {
    h = harness({
      turns: [{ text: "DONE" }],
      caps: { maxOutputTokens: 1500 },
      maxOutputTokens: 8192,
    });

    await h.run({ id: "n1" });

    expect(h.provider.seen[0]?.maxTokens).toBe(1500);
  });
});

describe("repeated empty tool results", () => {
  it("tells the model to stop after three empty searches with differing arguments", async () => {
    h = harness({
      files: { "a.md": "hello\n" },
      turns: [
        { toolCalls: [{ name: "grep", args: { pattern: "alpha", path: "." } }] },
        { toolCalls: [{ name: "grep", args: { pattern: "beta", path: "." } }] },
        { toolCalls: [{ name: "grep", args: { pattern: "gamma", path: "." } }] },
        { text: "DONE" },
      ],
    });

    await h.run({ id: "n1" });

    expect(h.payloads("tool.exhausted")).toHaveLength(1);
    const told = h.provider.seen.some((r) =>
      r.messages.some((m) => m.content.includes("no results 3 times in a row")),
    );
    expect(told).toBe(true);
  });

  it("does not trip on a mutating tool that succeeds quietly", async () => {
    h = harness({
      turns: [
        { toolCalls: [{ name: "write_file", args: { path: "a.md", content: "1" } }] },
        { toolCalls: [{ name: "write_file", args: { path: "b.md", content: "2" } }] },
        { toolCalls: [{ name: "write_file", args: { path: "c.md", content: "3" } }] },
        { text: "DONE" },
      ],
    });

    await h.run({
      id: "n1",
      sets: { read: [], write: ["a.md", "b.md", "c.md"] },
    });

    expect(h.payloads("tool.exhausted")).toHaveLength(0);
  });
});

describe("contract failures feed the next attempt", () => {
  it("throws ContractUnmet, not a bare Error, so the classifier can retry it", async () => {
    h = harness({ turns: [{ text: "I would update out.md as follows: ..." }] });

    await expect(
      h.run({ id: "n1", sets: { read: [], write: ["out.md"] } }),
    ).rejects.toMatchObject({
      name: "ContractUnmet",
      declared: ["out.md"],
      exhausted: false,
    });
  });

  it("marks the failure as step exhaustion when that is what happened", async () => {
    const turns = Array.from({ length: 20 }, () => ({
      toolCalls: [{ name: "list_dir", args: { path: "." } }],
    }));
    h = harness({ turns, maxSteps: 4 });

    await expect(
      h.run({ id: "n1", sets: { read: [], write: ["out.md"] } }),
    ).rejects.toMatchObject({ name: "ContractUnmet", exhausted: true });
  });

  it("puts the previous failure in front of the model on the retry", async () => {
    h = harness({
      turns: [
        { toolCalls: [{ name: "write_file", args: { path: "out.md", content: "x" } }] },
        { text: "DONE" },
      ],
    });

    await h.run({
      id: "n1",
      attempts: 1,
      retryReason: "declared writes (out.md) but modified nothing",
      sets: { read: [], write: ["out.md"] },
    });

    const first = h.provider.seen[0]!;
    const shown = first.messages.map((m) => m.content).join("\n");
    expect(shown).toContain("attempt 2");
    expect(shown).toContain("The previous attempt FAILED");
    expect(shown).toContain("but modified nothing");
  });

  it("says nothing about retries on a first attempt", async () => {
    h = harness({ turns: [{ text: "DONE" }] });

    await h.run({ id: "n1" });

    const shown = h.provider.seen[0]!.messages.map((m) => m.content).join("\n");
    expect(shown).not.toContain("previous attempt");
  });

  it("tells the model that prose is not a write", async () => {
    h = harness({ turns: [{ text: "DONE" }] });

    await h.run({ id: "n1" });

    const system = h.provider.seen[0]!.messages.find((m) => m.role === "system")!;
    expect(system.content).toMatch(/describing a change in prose does nothing/i);
    expect(system.content).toMatch(/write policy.*required or optional/i);
  });
});

describe("the loop does not grow without bound", () => {
  it("elides old tool results once the conversation gets large", async () => {
    // 41 steps on one node cost 263,402 input tokens against 17,812 output —
    // 93% of the run budget spent re-sending the same reads — and the run died
    // at BudgetExceeded with the work unfinished.
    // Just under the guard's 2 KB spill threshold, so each result survives
    // into the conversation rather than being swapped for an artifact stub.
    const turns = Array.from({ length: 20 }, (_, i) => ({
      toolCalls: [{ name: "read_file", args: { path: `f${i}.txt` } }],
    }));
    const files = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`f${i}.txt`, "y".repeat(1900)]),
    );
    h = harness({ files, turns: [...turns, { text: "DONE" }], caps: { contextWindow: 16_384 } });

    await h.run({ id: "n1" });

    expect(h.payloads("context.compacted").length).toBeGreaterThan(0);
  });

  it("keeps the request valid — every tool result still answers its call", async () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({
      toolCalls: [{ name: "read_file", args: { path: `f${i}.txt` } }],
    }));
    const files = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`f${i}.txt`, "y".repeat(1900)]),
    );
    h = harness({ files, turns: [...turns, { text: "DONE" }], caps: { contextWindow: 16_384 } });

    await h.run({ id: "n1" });

    for (const req of h.provider.seen) {
      const roles = req.messages.map((m) => m.role);
      expect(roles[0]).toBe("system");
      // A tool message may only follow an assistant turn or another tool turn.
      for (const [i, role] of roles.entries()) {
        if (role !== "tool" || i === 0) continue;
        expect(["assistant", "tool"]).toContain(roles[i - 1]);
      }
    }
  });

  it("does not compact a short node at all", async () => {
    h = harness({
      files: { "a.md": "hello" },
      turns: [
        { toolCalls: [{ name: "read_file", args: { path: "a.md" } }] },
        { text: "DONE" },
      ],
    });

    await h.run({ id: "n1" });

    expect(h.payloads("context.compacted")).toHaveLength(0);
  });
});

describe("what a node inherits from its dependencies", () => {
  it("shows a node what the nodes it depends on concluded", async () => {
    // MemoryWriteback has written these since the tier was built, and
    // taskMemory()'s only caller was a test — so rank 5 of the ladder existed
    // on paper while every node rediscovered the repo through tool calls.
    h = harness({ turns: [{ text: "DONE" }] });
    h.memory.writeTask("run-test", "analyze", "delta", "types live in src/types.ts");
    h.memory.writeTask("run-test", "other", "delta", "unrelated node output");

    await h.run({ id: "impl", deps: ["analyze"] });

    const shown = h.provider.seen[0]!.messages.map((m) => m.content).join("\n");
    expect(shown).toContain("types live in src/types.ts");
    expect(shown).not.toContain("unrelated node output");
  });

  it("says nothing about dependencies when a node has none", async () => {
    h = harness({ turns: [{ text: "DONE" }] });
    h.memory.writeTask("run-test", "analyze", "delta", "types live in src/types.ts");

    await h.run({ id: "first" });

    const shown = h.provider.seen[0]!.messages.map((m) => m.content).join("\n");
    expect(shown).not.toContain("types live in src/types.ts");
  });
});

describe("forcing a stalled node to write", () => {
  it("withdraws the read tools once the reading budget is spent", async () => {
    // The measured failure: 144 read_artifact calls against 6 writes, one node
    // consuming a whole run's budget while four siblings never started. The
    // low-steps notice had already told it to stop reading.
    // Distinct arguments each time: identical calls are refused by the
    // duplicate guard and correctly never cost reading budget.
    const turns = Array.from({ length: 12 }, (_, i) => ({
      toolCalls: [{ name: "grep", args: { pattern: `x${i}`, path: "." } }],
    }));
    h = harness({
      files: { "a.md": "x0 x1 x2 x3 x4 x5 x6 x7 x8 x9 x10 x11 marks it\n" },
      turns: [
        ...turns,
        { toolCalls: [{ name: "write_file", args: { path: "out.md", content: "done\n" } }] },
        { text: "DONE" },
      ],
      maxReads: 4,
    });

    await h.run({ id: "n1", sets: { read: [], write: ["out.md"] } });

    expect(h.payloads("tools.withdrawn")).toHaveLength(1);

    // After withdrawal the model is offered writes and nothing else.
    const withdrawn = h.provider.seen.findIndex((r) =>
      r.messages.some((m) => m.content.includes("no longer available")),
    );
    expect(withdrawn).toBeGreaterThan(-1);
    expect(h.provider.seen[withdrawn]!.tools).toBeDefined();
    for (const name of h.provider.seen[withdrawn]!.tools!) {
      expect(["read_file", "read_artifact", "list_dir", "glob", "grep"]).not.toContain(name);
    }
  });

  it("leaves a read-only node alone", async () => {
    const turns = Array.from({ length: 12 }, () => ({
      toolCalls: [{ name: "grep", args: { pattern: "x", path: "." } }],
    }));
    h = harness({
      files: { "a.md": "x\n" },
      turns: [...turns, { text: "DONE" }],
      maxReads: 2,
    });

    await h.run({ id: "n1", sets: { read: [], write: [] } });

    expect(h.payloads("tools.withdrawn")).toHaveLength(0);
  });

  it("stops a node that would eat the whole run's token budget", async () => {
    // A run-wide budget is first-come: without a per-node share the first
    // greedy node spends everything and the rest of the plan never runs.
    const turns = Array.from({ length: 30 }, (_, i) => ({
      toolCalls: [{ name: "grep", args: { pattern: `x${i}`, path: "." } }],
      outputTokens: 5_000,
    }));
    h = harness({
      files: { "a.md": "x\n" },
      turns,
      maxNodeTokens: 20_000,
      maxReads: 500,
    });

    await expect(
      h.run({ id: "n1", sets: { read: [], write: ["out.md"] } }),
    ).rejects.toThrow(/over its 20000 share/);
  });
});

describe("holes found by measuring a real run", () => {
  it("stops reads inside a batched response, not only at the step boundary", async () => {
    // 114 read_artifact calls got past a 30-read budget because one response
    // can carry a dozen calls and the gate was consulted once per step — the
    // budget was right, it was simply checked five calls too late.
    h = harness({
      files: { "a.md": "x0 x1 x2 x3 x4 x5 x6 x7 x8\n" },
      turns: [
        {
          toolCalls: Array.from({ length: 9 }, (_, i) => ({
            name: "grep",
            args: { pattern: `x${i}`, path: "." },
          })),
        },
        { toolCalls: [{ name: "write_file", args: { path: "out.md", content: "ok\n" } }] },
        { text: "DONE" },
      ],
      maxReads: 3,
    });

    await h.run({ id: "n1", sets: { read: [], write: ["out.md"] } });

    // Nine reads were requested in one turn; only the first three may run.
    expect(h.payloads("tool.called").filter((p) => p["tool"] === "grep")).toHaveLength(3);
    expect(h.payloads("tools.withdrawn").length).toBeGreaterThan(0);
  });

  it("gives a node one token share, not one per attempt", async () => {
    // Measured per attempt this was worth double: a node with two attempts took
    // 240k of a 400k run and its siblings starved anyway.
    const greedy = Array.from({ length: 30 }, (_, i) => ({
      toolCalls: [{ name: "grep", args: { pattern: `y${i}`, path: "." } }],
      outputTokens: 4_000,
    }));
    h = harness({
      files: { "a.md": "y0 y1 y2\n" },
      turns: greedy,
      maxNodeTokens: 20_000,
      maxReads: 500,
    });

    const node = { id: "n1", sets: { read: [], write: ["out.md"] } };
    await h.run(node).catch(() => undefined);
    const afterFirst = h.provider.seen.length;

    await expect(h.run({ ...node, attempts: 1 })).rejects.toThrow(/over its 20000 share/);

    // Attempt 2 inherits what attempt 1 spent, so it stops before making a
    // single model call. Measured per attempt it got a whole second allowance,
    // which is how one node still took 240k of a 400k run.
    expect(h.provider.seen.length).toBe(afterFirst);
  });
});

describe("withdrawal never leaves a node with nothing", () => {
  it("does not strip the only tools a read-only persona has", async () => {
    // `extract_gaps` was planned as a `planner` node writing a JSON file. The
    // planner persona is permitted read tools and nothing else, so withdrawing
    // reads offered it an empty tool list — unable to write by construction,
    // then failed for "describing the change instead of calling write_file".
    const turns = Array.from({ length: 20 }, (_, i) => ({
      toolCalls: [{ name: "grep", args: { pattern: `x${i}`, path: "." } }],
    }));
    h = harness({
      files: { "a.md": "x0 x1 x2 x3 x4 x5 x6 x7 x8 x9\n" },
      turns,
      maxSteps: 6,
    });

    await h
      .run({
        id: "extract_gaps",
        persona: "planner",
        sets: { read: [], write: [".studio/plan/missing_features.json"] },
      })
      .catch(() => undefined);

    expect(h.payloads("tools.withdrawn")).toHaveLength(0);
    for (const req of h.provider.seen) {
      expect(req.tools?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("still withdraws for a persona that can write", async () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({
      toolCalls: [{ name: "grep", args: { pattern: `x${i}`, path: "." } }],
    }));
    h = harness({
      files: { "a.md": "x0 x1 x2 x3 x4 x5 x6 x7 x8 x9\n" },
      turns,
      maxSteps: 6,
    });

    await h
      .run({ id: "n1", persona: "coder", sets: { read: [], write: ["out.md"] } })
      .catch(() => undefined);

    expect(h.payloads("tools.withdrawn").length).toBeGreaterThan(0);
  });
});

describe("two-phase execution", () => {
  /** A gather turn, the brief, then apply turns. */
  const brief = (plan: { path: string; change: string }[]) =>
    JSON.stringify({
      findings: ["types are declared in the file"],
      relevant: [{ path: "notes.md", why: "context for the change" }],
      plan,
      blockers: [],
    });

  it("offers read tools while gathering and write tools while applying", async () => {
    h = harness({
      files: { "notes.md": "some context\n" },
      twoPhase: true,
      maxSteps: 8,
      turns: [
        { toolCalls: [{ name: "read_file", args: { path: "notes.md" } }] },
        { text: "DONE" },
        { text: brief([{ path: "out.md", change: "write a summary" }]) },
        { toolCalls: [{ name: "write_file", args: { path: "out.md", content: "ok\n" } }] },
        { text: "DONE" },
      ],
    });

    await h.run({ id: "n1", sets: { read: [], write: ["out.md"] } });

    const offered = h.provider.seen.map((r) => r.tools ?? []);
    // Gather sees reads and no writes; apply sees writes and no reads.
    expect(offered[0]).toContain("read_file");
    expect(offered[0]).not.toContain("write_file");
    const applyTurn = offered.find((t) => t.includes("write_file"))!;
    expect(applyTurn).not.toContain("read_file");
    expect(applyTurn).not.toContain("grep");
  });

  it("does not carry the gather transcript into apply", async () => {
    // This is the entire point: apply pays for the brief and its target files,
    // not for the forty fenced results gather accumulated.
    h = harness({
      files: { "notes.md": "SENTINEL_FROM_GATHER\n" },
      twoPhase: true,
      maxSteps: 8,
      turns: [
        { toolCalls: [{ name: "read_file", args: { path: "notes.md" } }] },
        { text: "DONE" },
        { text: brief([{ path: "out.md", change: "write a summary" }]) },
        { toolCalls: [{ name: "write_file", args: { path: "out.md", content: "ok\n" } }] },
        { text: "DONE" },
      ],
    });

    await h.run({ id: "n1", sets: { read: [], write: ["out.md"] } });

    const apply = h.provider.seen.find((r) => (r.tools ?? []).includes("write_file"))!;
    const text = apply.messages.map((m) => m.content).join("\n");
    expect(text).not.toContain("SENTINEL_FROM_GATHER");
    // But it does carry the brief.
    expect(text).toContain("write a summary");
  });

  it("gives apply the current contents of its write set", async () => {
    // Apply never saw gather's reads, so without this it edits blind.
    h = harness({
      files: { "out.md": "EXISTING_CONTENT\n" },
      twoPhase: true,
      maxSteps: 8,
      turns: [
        { text: "DONE" },
        { text: brief([{ path: "out.md", change: "append a line" }]) },
        { toolCalls: [{ name: "write_file", args: { path: "out.md", content: "new\n" } }] },
        { text: "DONE" },
      ],
    });

    await h.run({ id: "n1", sets: { read: [], write: ["out.md"] } });

    const apply = h.provider.seen.find((r) => (r.tools ?? []).includes("write_file"))!;
    expect(apply.messages.map((m) => m.content).join("\n")).toContain("EXISTING_CONTENT");
  });

  it("fails before applying when gather reports it cannot proceed", async () => {
    h = harness({
      twoPhase: true,
      maxSteps: 8,
      turns: [
        { text: "DONE" },
        {
          text: JSON.stringify({
            findings: [],
            relevant: [],
            plan: [],
            blockers: ["the upstream API is undocumented"],
          }),
        },
      ],
    });

    await expect(
      h.run({ id: "n1", sets: { read: [], write: ["out.md"] } }),
    ).rejects.toThrow(/cannot proceed: the upstream API is undocumented/);

    // No apply phase ran.
    expect(h.provider.seen.every((r) => !(r.tools ?? []).includes("write_file"))).toBe(true);
  });

  it("records the brief so a run can be inspected afterwards", async () => {
    h = harness({
      twoPhase: true,
      maxSteps: 8,
      turns: [
        { text: "DONE" },
        { text: brief([{ path: "out.md", change: "write it" }]) },
        { toolCalls: [{ name: "write_file", args: { path: "out.md", content: "ok\n" } }] },
        { text: "DONE" },
      ],
    });

    await h.run({ id: "n1", sets: { read: [], write: ["out.md"] } });

    expect(h.payloads("node.brief")[0]).toMatchObject({ plan: 1, blockers: [] });
  });

  it("stays single-phase for a read-only node", async () => {
    // Nothing to hand over, and no apply phase to hand it to.
    h = harness({
      files: { "a.md": "x\n" },
      twoPhase: true,
      turns: [
        { toolCalls: [{ name: "read_file", args: { path: "a.md" } }] },
        { text: "DONE" },
      ],
    });

    await h.run({ id: "n1", sets: { read: [], write: [] } });
    expect(h.payloads("node.brief")).toHaveLength(0);
  });

  it("leaves the single-phase loop untouched when the flag is off", async () => {
    h = harness({
      files: { "a.md": "x\n" },
      turns: [
        { toolCalls: [{ name: "read_file", args: { path: "a.md" } }] },
        { toolCalls: [{ name: "write_file", args: { path: "out.md", content: "ok\n" } }] },
        { text: "DONE" },
      ],
    });

    await h.run({ id: "n1", sets: { read: [], write: ["out.md"] } });

    expect(h.payloads("node.brief")).toHaveLength(0);
    // One list throughout, with both kinds of tool on offer.
    expect(h.provider.seen[0]!.tools).toEqual(
      expect.arrayContaining(["read_file", "write_file"]),
    );
  });
});

describe("gather cannot spend apply's tokens", () => {
  it("leaves budget for the brief and the write", async () => {
    // Measured on run-msjlvwoh: gather used 14 of 24 steps but the node's whole
    // 120k token share, so apply was killed before its first round-trip and the
    // split could not be evaluated at all. Reserving steps was not enough —
    // tokens are the binding constraint.
    // Sized so the arithmetic is visible: a 40k node share gives gather 20k,
    // and each scripted turn books 5,100 (5,000 out + 100 in). Gather therefore
    // stops after 4 turns, and the brief is the 5th thing the model is asked
    // for. Without the ceiling it would run to the step cap and leave nothing.
    const gatherTurns = Array.from({ length: 4 }, (_, i) => ({
      toolCalls: [{ name: "grep", args: { pattern: `x${i}`, path: "." } }],
      outputTokens: 5_000,
    }));
    h = harness({
      files: { "a.md": "x0 x1 x2 x3 x4 x5\n" },
      twoPhase: true,
      maxNodeTokens: 40_000,
      maxSteps: 40,
      maxReads: 500,
      turns: [
        ...gatherTurns,
        {
          text: JSON.stringify({
            findings: ["found it"],
            relevant: [],
            plan: [{ path: "out.md", change: "write it" }],
            blockers: [],
          }),
        },
        { toolCalls: [{ name: "write_file", args: { path: "out.md", content: "ok\n" } }] },
        { text: "DONE" },
      ],
    });

    await h.run({ id: "n1", sets: { read: [], write: ["out.md"] } });

    // Apply ran and wrote, rather than being starved by gather.
    expect(h.payloads("node.brief")).toHaveLength(1);
    expect(readFileSync(join(h.root, "out.md"), "utf8")).toBe("ok\n");
  });
});
