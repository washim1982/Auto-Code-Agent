import { describe, expect, it } from "vitest";
import React from "react";
import { render } from "ink";
import { PlanNode } from "@aca/protocol";
import { App, type AppState } from "../src/tui/app.tsx";

/**
 * Ink writes frames to a stream and reads keys from another.
 *
 * Faking both is what lets the TUI be asserted on at all: without a TTY,
 * `useInput` refuses to mount, so the whole component would be untestable and
 * every change to it would be verified by eye or not at all.
 */
function harness(): { stdout: NodeJS.WriteStream; frames: string[] } {
  const frames: string[] = [];
  const stdout = {
    columns: 100,
    rows: 40,
    write: (frame: string) => {
      frames.push(frame);
      return true;
    },
    on: () => stdout,
    off: () => stdout,
    removeListener: () => stdout,
  } as unknown as NodeJS.WriteStream;
  return { stdout, frames };
}

/**
 * Ink registers key handlers through the EventEmitter surface, so a stub that
 * only has `on` mounts and then throws from an effect — which surfaces as a
 * blank frame rather than an error, and looks exactly like a layout bug.
 */
function fakeStdin(): NodeJS.ReadStream {
  const noop = (): undefined => undefined;
  const stdin = {
    isTTY: true,
    setRawMode: noop,
    setEncoding: noop,
    resume: noop,
    pause: noop,
    read: () => null,
    ref: noop,
    unref: noop,
    on: () => stdin,
    off: () => stdin,
    once: () => stdin,
    addListener: () => stdin,
    removeListener: () => stdin,
    removeAllListeners: () => stdin,
    setMaxListeners: () => stdin,
    listenerCount: () => 0,
  };
  return stdin as unknown as NodeJS.ReadStream;
}

/** Built through the schema, so a fixture cannot drift from the real shape. */
function node(id: string, title: string, status: PlanNode["status"], write: string[]): PlanNode {
  return PlanNode.parse({
    id,
    title,
    persona: "coder",
    contract: `${title} contract`,
    deps: [],
    sets: { read: ["src/index.ts"], write },
    status,
  });
}

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    workspace: "demo",
    model: "qwen3.6:35b",
    thread: [],
    stages: [],
    nodes: [],
    nodeMeta: {},
    nodeDiffs: {},
    nodeLogs: {},
    approval: null,
    tokens: 0,
    costUsd: 0,
    startedAt: Date.now(),
    busy: false,
    streaming: null,
    notice: null,
    ...overrides,
  };
}

/**
 * Renders and returns the final frame as plain text.
 *
 * Awaits a tick first: the view auto-switches to the graph from an effect, so
 * reading synchronously would only ever see the thread.
 */
async function frameOf(state: AppState): Promise<string> {
  const { stdout, frames } = harness();
  const instance = render(
    <App state={state} callbacks={{ onSubmit: () => {}, onApproval: () => {}, onCancel: () => {} }} />,
    { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false },
  );
  await new Promise((r) => setTimeout(r, 20));
  instance.unmount();
  // Strip ANSI so assertions are about content, not colour codes.
  return frames.join("").replace(/\[[0-9;]*m/g, "");
}

describe("interactive TUI", () => {
  it("shows the pre-flight checklist as it resolves", async () => {
    const frame = await frameOf(
      baseState({
        stages: [
          { id: "guard", label: "guard", detail: "no secrets, in scope", state: "done" },
          { id: "spec", label: "spec", detail: "4 acceptance criteria", state: "done" },
          { id: "preflight", label: "preflight", detail: "9 tools, 1 requires approval", state: "done" },
          { id: "plan", label: "plan", detail: "2 nodes, 2 branches", state: "running" },
        ],
      }),
    );

    expect(frame).toContain("guard");
    expect(frame).toContain("4 acceptance criteria");
    expect(frame).toContain("9 tools, 1 requires approval");
    expect(frame).toContain("2 nodes, 2 branches");
  });

  it("renders the DAG with each node's status, model and elapsed time", async () => {
    const frame = await frameOf(
      baseState({
        nodes: [
          node("n1", "read middleware config", "done", []),
          node("n2", "implement limiter", "running", ["src/mw/rateLimit.ts"]),
        ],
        nodeMeta: {
          n1: { model: "granite4:3.4b", elapsedMs: 1200 },
          n2: { model: "qwen3.6:35b", elapsedMs: 14100 },
        },
      }),
    );

    expect(frame).toContain("n1");
    expect(frame).toContain("implement limiter");
    // The columns that were dead before: nothing ever populated meta.
    expect(frame).toContain("granite4:3.4b");
    expect(frame).toContain("14.1s");
    expect(frame).toContain("src/mw/rateLimit.ts");
    expect(frame).toContain("1 running");
  });

  it("makes an approval impossible to miss", async () => {
    const frame = await frameOf(
      baseState({
        approval: {
          id: "a1",
          summary: "git push origin feature/rate-limit",
          detail: "node contract declares remote publish",
          irreversible: true,
        },
      }),
    );

    expect(frame).toContain("git push origin feature/rate-limit");
    expect(frame).toContain("irreversible");
    expect(frame).toContain("[a]");
    expect(frame).toContain("[r]");
  });

  it("streams a reply before it is committed to the thread", async () => {
    const frame = await frameOf(baseState({ streaming: "partial answ", busy: true }));
    expect(frame).toContain("partial answ");
  });

  it("reports budget in the status strip", async () => {
    const frame = await frameOf(baseState({ tokens: 18200, costUsd: 0 }));
    expect(frame).toMatch(/18,200/);
  });

  it("says what to do when there is no run yet", async () => {
    const frame = await frameOf(baseState());
    expect(frame).toContain("Ask a question");
  });
});

describe("status strip layout", () => {
  it("keeps the hint away from the elapsed counter", async () => {
    // The flexGrow spacer needs a definite parent width; without one the two
    // ends collided and printed "…0stab focus · esc cancel".
    const frame = await frameOf(baseState({ tokens: 18200 }));
    expect(frame).not.toMatch(/\dstab focus/);
    expect(frame).toContain("tab focus");
  });
});
