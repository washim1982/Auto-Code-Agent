import { describe, expect, it } from "vitest";
import {
  describeEvent,
  progressLines,
  runIsActive,
} from "../src/renderer/views/event-lines.ts";
import type { AcaEvent } from "../src/renderer/views/shared.ts";

let seq = 0;
const ev = (
  type: string,
  payload: Record<string, unknown> = {},
  nodeId: string | null = null,
  runId = "run-1",
): AcaEvent => ({ seq: ++seq, runId, nodeId, ts: Date.now(), type, payload });

describe("narrating a run", () => {
  it("says what the agent is doing, in words", () => {
    expect(describeEvent(ev("node.routed", { model: "qwen3.6:35b" }, "impl"))?.text).toBe(
      "impl: using qwen3.6:35b",
    );
    expect(describeEvent(ev("tool.called", { tool: "read_file" }, "impl"))?.text).toBe(
      "impl: read_file",
    );
    expect(describeEvent(ev("plan.proposed", { nodes: 4, model: "qwen" }))?.text).toContain(
      "4 nodes",
    );
  });

  it("gives the slow silent phase a line of its own", () => {
    // Planning is the three-minute gap that showed nothing at all.
    const line = describeEvent(ev("run.created", { goal: "implement missing features" }));
    expect(line?.text).toContain("Planning");
    expect(line?.text).toContain("implement missing features");
  });

  it("surfaces the states a person has to act on", () => {
    expect(describeEvent(ev("node.steps_low", { remaining: 8 }, "impl"))).toMatchObject({
      tone: "warn",
    });
    expect(describeEvent(ev("model.truncated", {}, "impl"))).toMatchObject({ tone: "warn" });
    expect(describeEvent(ev("approval.requested"))).toMatchObject({ tone: "warn" });
    expect(describeEvent(ev("gate.failed", { gate: "unit" }, "impl"))).toMatchObject({
      tone: "bad",
    });
    expect(describeEvent(ev("node.done", {}, "impl"))).toMatchObject({ tone: "good" });
  });

  it("stays quiet about bookkeeping", () => {
    // Narrating every lock and checkpoint buries the handful of lines that
    // actually tell someone what is happening.
    for (const type of [
      "lock.acquired",
      "lock.released",
      "checkpoint.taken",
      "guard.fenced",
      "epoch.bumped",
      "model.response",
      "cache.invalidated",
    ]) {
      expect(describeEvent(ev(type))).toBeNull();
    }
  });

  it("does not print the duplicate rollback event twice", () => {
    // The supervisor emits node.rolled_back with a reason and the executor
    // without one; both would otherwise render the same line.
    expect(describeEvent(ev("node.rolled_back", { nodeId: "impl" }, "impl"))).toBeNull();
    expect(describeEvent(ev("node.rolled_back", { reason: "gates failed" }, "impl"))).not.toBeNull();
  });

  it("keeps a failure reason to one line", () => {
    const line = describeEvent(
      ev("node.failed", { reason: "Error: gates failed\nstack line\nanother" }, "impl"),
    );
    expect(line?.text).not.toContain("\n");
    expect(line?.text).not.toContain("Error:");
    expect(line?.text).toContain("gates failed");
  });
});

describe("the progress tail", () => {
  it("keeps only the most recent lines", () => {
    const events = Array.from({ length: 20 }, () => ev("tool.called", { tool: "grep" }, "n1"));
    expect(progressLines(events, { limit: 6 })).toHaveLength(6);
  });

  it("ignores events from other runs", () => {
    const events = [
      ev("tool.called", { tool: "grep" }, "n1", "run-old"),
      ev("tool.called", { tool: "read_file" }, "n1", "run-new"),
    ];
    const lines = progressLines(events, { runId: "run-new" });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain("read_file");
  });

  it("drops silent events rather than leaving blank rows", () => {
    const events = [ev("lock.acquired"), ev("tool.called", { tool: "grep" }, "n1")];
    expect(progressLines(events)).toHaveLength(1);
  });

  it("joins a tool result onto its expandable running row", () => {
    const events = [
      ev(
        "tool.called",
        {
          tool: "run_command",
          callId: "n1:1:0:call-1",
          command: "npm run typecheck",
          input: '{\n  "command": "npm"\n}',
        },
        "n1",
      ),
      ev(
        "tool.result",
        {
          tool: "run_command",
          callId: "n1:1:0:call-1",
          output: "exit 0\nchecks passed",
          bytes: 20,
          durationMs: 1250,
          isError: false,
          writes: [],
        },
        "n1",
      ),
    ];

    const lines = progressLines(events);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.detail).toMatchObject({
      tool: "run_command",
      status: "completed",
      command: "npm run typecheck",
      output: "exit 0\nchecks passed",
      durationMs: 1250,
    });
  });

  it("keeps generated file contents as an unescaped code block", () => {
    const lines = progressLines([
      ev(
        "tool.called",
        {
          tool: "write_file",
          callId: "write-1",
          input: '{\n  "path": "src/app.ts"\n}',
          codePath: "src/app.ts",
          code: "export const ready = true;\n",
        },
        "impl",
      ),
    ]);

    expect(lines[0]?.detail?.code).toBe("export const ready = true;\n");
    expect(lines[0]?.detail?.codePath).toBe("src/app.ts");
  });
});

describe("whether anything is still happening", () => {
  it("is live from the moment planning starts", () => {
    expect(runIsActive([ev("run.created", { goal: "x" })])).toBe(true);
  });

  it("goes quiet when the plan is waiting on the user", () => {
    // A proposed plan is a question, not work in progress — pulsing at someone
    // who is being asked to approve something is a lie.
    expect(runIsActive([ev("run.created"), ev("plan.proposed", { nodes: 3 })])).toBe(false);
  });

  it("is live again once the plan is approved", () => {
    expect(
      runIsActive([ev("run.created"), ev("plan.proposed"), ev("plan.approved")]),
    ).toBe(true);
  });

  it("stops on every terminal state", () => {
    for (const type of ["run.completed", "run.failed", "run.cancelled", "run.paused"]) {
      expect(runIsActive([ev("run.started"), ev(type)])).toBe(false);
    }
  });
});
