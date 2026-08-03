import { describe, expect, it } from "vitest";
import {
  directoriesWithChildren,
  visibleEntries,
  type TreeEntry,
} from "../src/renderer/views/shared.ts";

/** A flat pre-order walk, the shape the daemon sends. */
function entry(path: string, kind: "file" | "dir", depth: number): TreeEntry {
  return {
    path,
    name: path.split("/").pop() ?? path,
    kind,
    depth,
    git: null,
    lockedBy: null,
    inWriteSet: false,
    indexed: true,
    sizeBytes: 0,
  };
}

const TREE: TreeEntry[] = [
  entry("src", "dir", 0),
  entry("src/components", "dir", 1),
  entry("src/components/Button.tsx", "file", 2),
  entry("src/index.ts", "file", 1),
  entry("docs", "dir", 0),
  entry("docs/guide.md", "file", 1),
  entry("README.md", "file", 0),
];

describe("file tree collapsing", () => {
  it("shows only the top level when nothing is open", () => {
    const visible = visibleEntries(TREE, new Set());
    expect(visible.map((e) => e.path)).toEqual(["src", "docs", "README.md"]);
  });

  it("reveals one level per open directory", () => {
    const visible = visibleEntries(TREE, new Set(["src"]));
    expect(visible.map((e) => e.path)).toEqual([
      "src",
      "src/components",
      // Still closed, so its child stays hidden.
      "src/index.ts",
      "docs",
      "README.md",
    ]);
  });

  it("nests without leaking siblings", () => {
    const visible = visibleEntries(TREE, new Set(["src", "src/components"]));
    expect(visible.map((e) => e.path)).toEqual([
      "src",
      "src/components",
      "src/components/Button.tsx",
      "src/index.ts",
      "docs",
      "README.md",
    ]);
  });

  it("closing a parent hides an open child's contents too", () => {
    // `src` shut while `src/components` is still marked open — the child's
    // state must not resurrect its rows.
    const visible = visibleEntries(TREE, new Set(["src/components"]));
    expect(visible.map((e) => e.path)).toEqual(["src", "docs", "README.md"]);
  });

  it("marks only directories that have children in the listing", () => {
    const withChildren = directoriesWithChildren(TREE);
    expect([...withChildren].sort()).toEqual(["docs", "src", "src/components"]);

    // A directory the walk stopped at gets no caret, so it cannot be clicked
    // into an empty expansion.
    const truncated = [entry("node_modules", "dir", 0), entry("README.md", "file", 0)];
    expect(directoriesWithChildren(truncated).size).toBe(0);
  });
});
