import { describe, expect, it } from "vitest";
import { NodeBrief, renderBrief, isBlocked } from "../src/run/brief.ts";

const brief = (over: Partial<NodeBrief> = {}): NodeBrief =>
  NodeBrief.parse({ findings: [], relevant: [], plan: [], blockers: [], ...over });

describe("the gather → apply handoff", () => {
  it("bounds every list, because an unbounded brief is the transcript again", () => {
    // The whole point of the split is that apply does not inherit 40 fenced
    // tool results. A brief with no ceiling reintroduces exactly that.
    expect(() => NodeBrief.parse({ ...brief(), findings: Array(11).fill("x") })).toThrow();
    expect(() =>
      NodeBrief.parse({ ...brief(), relevant: Array(13).fill({ path: "a", why: "b" }) }),
    ).toThrow();
    expect(() =>
      NodeBrief.parse({ ...brief(), plan: Array(9).fill({ path: "a", change: "b" }) }),
    ).toThrow();
    expect(() => NodeBrief.parse({ ...brief(), findings: ["x".repeat(401)] })).toThrow();
  });

  it("accepts a brief at the limits", () => {
    expect(() =>
      NodeBrief.parse({
        findings: Array(10).fill("x".repeat(400)),
        relevant: Array(12).fill({ path: "a", why: "b" }),
        plan: Array(8).fill({ path: "a", change: "b" }),
        blockers: Array(5).fill("b"),
      }),
    ).not.toThrow();
  });
});

describe("rendering a brief for the writer", () => {
  it("reads as instructions, not as a schema dump", () => {
    const text = renderBrief(
      brief({
        findings: ["Types live in src/types.ts and are re-exported from index.ts"],
        relevant: [{ path: "src/types.ts", why: "the interfaces are declared here" }],
        plan: [{ path: "src/types.ts", change: "add a ModelCapabilities interface" }],
      }),
    );

    expect(text).toContain("Types live in src/types.ts");
    expect(text).toContain("src/types.ts — the interfaces are declared here");
    expect(text).toContain("src/types.ts: add a ModelCapabilities interface");
    expect(text).not.toContain("{");
    expect(text).not.toContain('"findings"');
  });

  it("omits sections it has nothing for", () => {
    const text = renderBrief(brief({ plan: [{ path: "a.ts", change: "write it" }] }));
    expect(text).toContain("What to write:");
    expect(text).not.toContain("Files that matter");
    expect(text).not.toContain("Unresolved:");
  });

  it("renders an empty brief as nothing rather than empty headings", () => {
    expect(renderBrief(brief())).toBe("");
  });

  it("surfaces blockers to the writer rather than hiding them", () => {
    const text = renderBrief(
      brief({
        plan: [{ path: "a.ts", change: "write it" }],
        blockers: ["the API version is not pinned anywhere"],
      }),
    );
    expect(text).toContain("Unresolved:");
    expect(text).toContain("the API version is not pinned anywhere");
  });
});

describe("deciding a node is impossible", () => {
  it("does not stop for a blocker the model planned around anyway", () => {
    // Models report unknowns as blockers and then proceed. Treating any blocker
    // as fatal would fail nodes that were about to succeed.
    expect(
      isBlocked(brief({ blockers: ["unsure which version"], plan: [{ path: "a", change: "b" }] })),
    ).toBe(false);
  });

  it("stops when there are blockers and nothing to write", () => {
    expect(isBlocked(brief({ blockers: ["the file does not exist"] }))).toBe(true);
  });

  it("does not stop a brief that simply has no plan and no blockers", () => {
    // That is a different failure — the contract check catches it, and says so
    // more precisely than "blocked" would.
    expect(isBlocked(brief())).toBe(false);
  });
});
