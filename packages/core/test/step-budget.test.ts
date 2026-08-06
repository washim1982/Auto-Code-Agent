import { describe, expect, it } from "vitest";
import { StepBudget, lowStepsNotice } from "../src/run/step-budget.ts";

describe("step budget", () => {
  it("defaults to 24 steps rather than the old hardcoded 12", () => {
    expect(new StepBudget().total).toBe(24);
  });

  it("honours a configured maximum", () => {
    expect(new StepBudget({ maxSteps: 40 }).total).toBe(40);
  });

  it("grows past the configured max when a node declares more writes than it allows", () => {
    // Under-provisioned, not over budget: 20 files need at least 20 steps to
    // write, whatever the config says.
    const b = new StepBudget({ maxSteps: 12, declaredWrites: 20 });
    expect(b.total).toBe(21); // one per path, plus one to finish
  });

  it("honours a deliberately small configured maximum", () => {
    // The write floor must not quietly override an explicit low setting; only
    // a node that could not physically finish gets grown.
    expect(new StepBudget({ maxSteps: 3 }).total).toBe(3);
  });

  it("never returns a total below one step", () => {
    expect(new StepBudget({ maxSteps: 0 }).total).toBeGreaterThanOrEqual(1);
    expect(new StepBudget({ maxSteps: -5 }).total).toBeGreaterThanOrEqual(1);
  });

  it("warns once the remaining budget drops into the write reserve", () => {
    const b = new StepBudget({ maxSteps: 24, declaredWrites: 1 });
    expect(b.reserve).toBe(8); // a third of 24 beats writes + 1

    for (let i = 0; i < 15; i++) {
      b.consume();
      expect(b.shouldWarn()).toBe(false);
    }
    b.consume(); // 16 used, 8 remaining — down to the reserve
    expect(b.shouldWarn()).toBe(true);
  });

  it("warns only once, so the directive does not become noise", () => {
    const b = new StepBudget({ maxSteps: 6, declaredWrites: 1 });
    let warnings = 0;
    for (let i = 0; i < b.total; i++) {
      b.consume();
      if (b.shouldWarn()) warnings++;
    }
    expect(warnings).toBe(1);
  });

  it("reserves more for a node with many writes than the flat third", () => {
    const many = new StepBudget({ maxSteps: 24, declaredWrites: 12 });
    expect(many.reserve).toBe(13); // writes + 1 now beats a third of the total

    for (let i = 0; i < 10; i++) many.consume();
    expect(many.remaining).toBe(14);
    expect(many.shouldWarn()).toBe(false);
    many.consume();
    expect(many.shouldWarn()).toBe(true); // 13 remaining, one per declared write
  });

  it("tracks used and remaining, and does not go negative", () => {
    const b = new StepBudget({ maxSteps: 3 });
    expect(b.total).toBe(3);
    b.consume();
    expect(b.used).toBe(1);
    expect(b.remaining).toBe(2);
    for (let i = 0; i < 10; i++) b.consume();
    expect(b.remaining).toBe(0);
  });
});

describe("low-steps notice", () => {
  it("names the paths the node still has to write", () => {
    const notice = lowStepsNotice(8, ["Implementation_steps.md", "src/App.tsx"]);
    expect(notice).toContain("8 steps left");
    expect(notice).toContain("Implementation_steps.md");
    expect(notice).toContain("src/App.tsx");
    expect(notice).toContain("write_file");
  });

  it("still tells a read-only node to wrap up", () => {
    const notice = lowStepsNotice(3, []);
    expect(notice).toContain("3 steps left");
    expect(notice).not.toContain("write_file");
    expect(notice).toMatch(/DONE/);
  });

  it("agrees with itself about singular and plural", () => {
    expect(lowStepsNotice(1, [])).toContain("1 step left");
    expect(lowStepsNotice(2, [])).toContain("2 steps left");
  });
});
