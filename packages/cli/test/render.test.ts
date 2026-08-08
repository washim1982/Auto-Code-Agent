import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PlanNode } from "@aca/protocol";
import { renderDag } from "../src/render.ts";
import { cell, GLYPH, stateOf } from "../src/theme.ts";

function node(id: string, over: Partial<PlanNode> = {}): PlanNode {
  return PlanNode.parse({ id, title: `do ${id}`, sets: { read: [], write: [] }, ...over });
}

const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

describe("heat ramp mapping", () => {
  it("maps every node status onto the ramp", () => {
    expect(stateOf("done")).toBe("done");
    expect(stateOf("running")).toBe("running");
    expect(stateOf("parked")).toBe("approval");
    expect(stateOf("failed")).toBe("failed");
    expect(stateOf("rolled_back")).toBe("failed");
    expect(stateOf("blocked")).toBe("queued");
  });

  it("gives each state a distinct glyph so colour is never load-bearing alone", () => {
    const glyphs = Object.values(GLYPH);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});

describe("cell", () => {
  it("pads to an exact width so columns line up", () => {
    expect(strip(cell("ab", 5))).toBe("ab   ");
    expect(strip(cell("ab", 5, "right"))).toBe("   ab");
  });

  it("truncates with an ellipsis rather than breaking the grid", () => {
    expect(strip(cell("abcdefgh", 4))).toHaveLength(4);
    expect(strip(cell("abcdefgh", 4))).toBe("abc…");
  });

  it("measures the visible string, not the escape codes", () => {
    const coloured = "[32mab[39m";
    expect(strip(cell(coloured, 5))).toBe("ab   ");
  });
});

describe("DAG panel", () => {
  const nodes = [
    node("n1", { title: "read middleware config", status: "done" }),
    node("n2", {
      title: "implement limiter",
      status: "running",
      sets: { read: [], write: ["src/mw/rateLimit.ts"] },
    }),
    node("n3", { title: "wire into router", status: "blocked" }),
    node("n4", { title: "push branch", status: "parked" }),
  ];

  it("renders one line per node with its state label", () => {
    const out = strip(renderDag(nodes, {}, 96));
    expect(out).toContain("n1 read middleware config");
    expect(out).toContain("done");
    expect(out).toContain("running");
    expect(out).toContain("approval");
  });

  it("summarises running and blocked counts in the header", () => {
    const out = strip(renderDag(nodes, {}, 96));
    expect(out).toContain("4 nodes");
    expect(out).toContain("1 running");
    expect(out).toContain("2 blocked");
  });

  it("shows the write set as an indented sub-line", () => {
    const out = strip(renderDag(nodes, {}, 96));
    expect(out).toContain("write ▸ src/mw/rateLimit.ts");
  });

  it("explains a blocked node rather than leaving it bare", () => {
    const out = strip(renderDag(nodes, {}, 96));
    expect(out).toContain("held by a sibling");
  });

  it("surfaces the cascade reason when a node was dirtied by a rollback", () => {
    const out = strip(
      renderDag([node("n5", { status: "ready", dirtyReason: "n2 rolled back" })], {}, 96),
    );
    expect(out).toContain("n2 rolled back");
  });

  it("drops the model column first when the terminal narrows", () => {
    const wide = strip(renderDag(nodes, { n2: { model: "qwen3.6:35b" } }, 96));
    const narrow = strip(renderDag(nodes, { n2: { model: "qwen3.6:35b" } }, 72));
    expect(wide).toContain("qwen3.6:35b");
    expect(narrow).not.toContain("qwen3.6:35b");
    // Node identity and state survive at every width.
    expect(narrow).toContain("n2 implement limiter");
    expect(narrow).toContain("running");
  });

  it("never emits a line wider than the terminal", () => {
    for (const width of [72, 80, 96, 120]) {
      const lines = strip(renderDag(nodes, {}, width)).split("\n");
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(width);
    }
  });
});

describe("the approval gate advertises only what it implements", () => {
  it("does not offer an edit key that no code handles", () => {
    // `[e] edit` was on the card and implemented nowhere, so pressing it fell
    // through to the reject branch and silently discarded the plan.
    const card = readFileSync(new URL("../src/plan-card.ts", import.meta.url), "utf8");
    const footer = card.slice(card.indexOf("approve & run"));
    expect(footer).not.toContain("[e]");
  });

  it("never treats an unrecognised answer as a rejection", () => {
    // Rejection is destructive and one-way; a typo must not trigger it.
    const run = readFileSync(new URL("../src/run.ts", import.meta.url), "utf8");
    const gate = run.slice(run.indexOf("approve & run?"), run.indexOf("plan rejected"));
    expect(gate).toMatch(/is not a\/r/);
    expect(gate).toMatch(/answer === "r"/);
  });
});
