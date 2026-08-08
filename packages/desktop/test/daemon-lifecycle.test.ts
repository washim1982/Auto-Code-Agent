import { describe, expect, it } from "vitest";
import {
  hasUnfinishedRuns,
  needsEngineReplacement,
} from "../src/main/daemon-lifecycle.ts";

describe("desktop daemon lifecycle", () => {
  it("replaces a daemon from an older build", () => {
    expect(needsEngineReplacement({ engineBuild: "old" }, "current")).toBe(true);
    expect(needsEngineReplacement({ engineBuild: "current" }, "current")).toBe(false);
  });

  it("treats a daemon without a build id as stale", () => {
    expect(needsEngineReplacement({}, "current")).toBe(true);
  });

  it("does not replace a daemon that owns running or approval state", () => {
    expect(hasUnfinishedRuns([{ status: "running" }])).toBe(true);
    expect(hasUnfinishedRuns([{ status: "awaiting_approval" }])).toBe(true);
    expect(hasUnfinishedRuns([{ status: "done" }, { status: "done" }])).toBe(false);
  });
});
