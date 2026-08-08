import { describe, expect, it } from "vitest";
import { banner, visibleWidth, TUI_COMMANDS as DEFAULT_COMMANDS } from "../src/tui/banner.ts";

const info = {
  version: "v0.1.0",
  workspace: "new-project-test",
  model: "google/gemma-4-31b",
  index: "ready",
  columns: 100,
};

/** What the terminal actually shows, escape sequences removed. */
const plain = (s: string): string[] => s.split("\n").map((l) => l.replace(/\[[0-9;]*m/g, ""));

describe("the CLI banner", () => {
  it("closes every box row at the same column", () => {
    // The failure this guards is invisible in code review and obvious on
    // screen: one ragged border and the whole thing looks broken.
    const rows = plain(banner(info)).filter((l) => l.includes("│") || l.includes("┐"));
    const widths = new Set(rows.map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  it("draws a complete border", () => {
    const lines = plain(banner(info));
    expect(lines.some((l) => l.includes("┌─ Auto-Code-Agent ") && l.endsWith("┐"))).toBe(true);
    // Whatever sits to its left — a blank row or the version — the bottom rule
    // must close the box.
    expect(lines.some((l) => /└─+┘$/.test(l))).toBe(true);
  });

  it("lists every command with its help text", () => {
    const text = plain(banner(info)).join("\n");
    for (const cmd of DEFAULT_COMMANDS) {
      expect(text).toContain(cmd.keys);
      expect(text).toContain(cmd.help);
    }
  });

  it("stays aligned when a longer command is added", () => {
    // The box is sized from its contents, so this must not need a manual edit.
    const wide = banner({
      ...info,
      commands: [
        ...DEFAULT_COMMANDS,
        { keys: "/somewhat-longer [arg]", help: "A considerably longer description" },
      ],
    });
    const rows = plain(wide).filter((l) => l.includes("│"));
    expect(new Set(rows.map((l) => l.length)).size).toBe(1);
    expect(plain(wide).join("\n")).toContain("/somewhat-longer [arg]");
  });

  it("shows the workspace, model and index state on one line when it fits", () => {
    const status = plain(banner(info)).at(-2)!;
    expect(status).toContain("new-project-test");
    expect(status).toContain("google/gemma-4-31b");
    expect(status).toContain("ready");
  });

  it("stacks the status when the terminal is too narrow for one line", () => {
    const tail = plain(banner({ ...info, columns: 50 })).slice(-4).join("\n");
    expect(tail).toContain("new-project-test");
    expect(tail).toContain("google/gemma-4-31b");
    expect(tail).toContain("ready");
  });

  it("mentions local-only, and stays quiet otherwise", () => {
    // Whether a session can reach the network is worth stating unprompted.
    expect(plain(banner({ ...info, privacy: "local-only" })).join("\n")).toContain("local-only");
    expect(plain(banner(info)).join("\n")).not.toContain("privacy");
  });

  it("drops the wordmark rather than overflow a narrow terminal", () => {
    const narrow = plain(banner({ ...info, columns: 50 }));
    expect(narrow.join("\n")).not.toContain("█");
    // Still usable: the commands and the status line survive.
    expect(narrow.join("\n")).toContain("/model [name]");
    expect(narrow.join("\n")).toContain("new-project-test");
  });

  it("never exceeds the terminal width it was given", () => {
    for (const columns of [50, 80, 100, 120]) {
      for (const line of plain(banner({ ...info, columns }))) {
        expect(line.length).toBeLessThanOrEqual(columns);
      }
    }
  });

  it("starts the box at the same column on every row", () => {
    // The wordmark's first row sits beside the box's top border, so the shared
    // landmark is where the box begins, not a `│` specifically.
    const lines = plain(banner(info)).filter((l) => /[┌│└]/.test(l));
    const columns = new Set(lines.map((l) => l.search(/[┌│└]/)));
    expect(columns.size).toBe(1);
  });
});

describe("visibleWidth", () => {
  it("ignores colour codes", () => {
    expect(visibleWidth("[38;2;1;2;3mabc[39m")).toBe(3);
    expect(visibleWidth("abc")).toBe(3);
  });
});
