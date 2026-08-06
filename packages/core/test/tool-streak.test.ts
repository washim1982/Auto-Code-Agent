import { describe, expect, it } from "vitest";
import { EmptyResultStreak, exhaustedNotice } from "../src/run/tool-streak.ts";

describe("empty-result circuit breaker", () => {
  it("opens after three consecutive empty results from one tool", () => {
    const s = new EmptyResultStreak();
    expect(s.record("grep", "")).toBe(false);
    expect(s.record("grep", "")).toBe(false);
    expect(s.record("grep", "")).toBe(true);
    expect(s.count("grep")).toBe(3);
  });

  it("opens regardless of the arguments varying, which is the whole point", () => {
    // The executor's `seenCalls` guard keys on tool + args, so a model that
    // rewords its pattern every attempt slips past it entirely. This breaker
    // watches results, so it does not care that each call looked new.
    const s = new EmptyResultStreak();
    const patterns = ["missing", "incomplete", "not implemented"];
    const opened = patterns.map((_, i) => s.record("grep", ""));
    expect(opened).toEqual([false, false, true]);
  });

  it("clears the count on any non-empty result", () => {
    const s = new EmptyResultStreak();
    s.record("grep", "");
    s.record("grep", "");
    expect(s.record("grep", "src/a.ts:1: hit")).toBe(false);
    expect(s.count("grep")).toBe(0);
    // A later dry spell gets its own full allowance rather than inheriting a
    // primed breaker.
    expect(s.record("grep", "")).toBe(false);
    expect(s.record("grep", "")).toBe(false);
    expect(s.record("grep", "")).toBe(true);
  });

  it("treats whitespace-only output as empty", () => {
    const s = new EmptyResultStreak();
    expect(s.record("grep", "  ")).toBe(false);
    expect(s.record("grep", "\n")).toBe(false);
    expect(s.record("grep", "\t\n  ")).toBe(true);
  });

  it("counts each tool separately", () => {
    const s = new EmptyResultStreak();
    s.record("grep", "");
    s.record("glob", "");
    s.record("grep", "");
    s.record("glob", "");
    // Two empties each — neither has earned a breaker yet.
    expect(s.count("grep")).toBe(2);
    expect(s.count("glob")).toBe(2);
    expect(s.record("grep", "")).toBe(true);
    expect(s.record("glob", "")).toBe(true);
  });

  it("honours a custom limit", () => {
    const s = new EmptyResultStreak(1);
    expect(s.record("grep", "")).toBe(true);
  });

  it("tells the model to stop rather than handing back another empty result", () => {
    const notice = exhaustedNotice("grep", 3);
    expect(notice).toContain("grep");
    expect(notice).toContain("3 times in a row");
    expect(notice).toMatch(/do not call grep again/i);
  });
});
