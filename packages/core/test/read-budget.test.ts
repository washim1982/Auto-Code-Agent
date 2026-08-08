import { describe, expect, it } from "vitest";
import {
  ReadBudget,
  READ_ONLY_TOOLS,
  mustWriteNow,
  writeOnlyNotice,
} from "../src/run/read-budget.ts";

describe("read budget", () => {
  it("counts only read-only tools", () => {
    const b = new ReadBudget({ maxReads: 3 });
    b.record("write_file");
    b.record("run_command");
    expect(b.reads).toBe(0);
    b.record("grep");
    b.record("read_artifact");
    expect(b.reads).toBe(2);
  });

  it("is exhausted at the limit", () => {
    const b = new ReadBudget({ maxReads: 2 });
    b.record("read_file");
    expect(b.exhausted).toBe(false);
    b.record("read_file");
    expect(b.exhausted).toBe(true);
  });

  it("treats every discovery tool as reading", () => {
    // read_artifact is the one that ran away: 144 calls against 6 writes.
    for (const t of ["read_file", "read_artifact", "list_dir", "glob", "grep"]) {
      expect(READ_ONLY_TOOLS.has(t)).toBe(true);
    }
    for (const t of ["write_file", "edit_file", "run_command", "git_push"]) {
      expect(READ_ONLY_TOOLS.has(t)).toBe(false);
    }
  });
});

describe("when reading is withdrawn", () => {
  const base = {
    writeRequired: true,
    declared: ["src/types.ts"],
    written: 0,
    readsExhausted: false,
    stepsLow: false,
  };

  it("does not fire while the node still has budget", () => {
    expect(mustWriteNow(base)).toBe(false);
  });

  it("fires when the reading budget is spent", () => {
    expect(mustWriteNow({ ...base, readsExhausted: true })).toBe(true);
  });

  it("fires when the step budget reaches its write reserve", () => {
    expect(mustWriteNow({ ...base, stepsLow: true })).toBe(true);
  });

  it("never fires for a node that has already written", () => {
    // A node that produced its diff is entitled to keep checking its work.
    expect(mustWriteNow({ ...base, written: 1, readsExhausted: true })).toBe(false);
  });

  it("never fires for a read-only node", () => {
    // Nothing to be forced towards.
    expect(mustWriteNow({ ...base, declared: [], readsExhausted: true })).toBe(false);
    expect(mustWriteNow({ ...base, writeRequired: false, readsExhausted: true })).toBe(false);
  });

  it("tells the model to write something rather than nothing", () => {
    const notice = writeOnlyNotice(["src/types.ts"]);
    expect(notice).toContain("src/types.ts");
    expect(notice).toMatch(/no longer available/i);
    expect(notice).toMatch(/producing nothing is the only outcome that fails/i);
  });
});
