import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DEFAULT_IGNORES } from "./checkpoint.ts";

export interface MapOptions {
  maxFiles?: number;
  maxDepth?: number;
  ignore?: string[];
}

/**
 * A compact tree of the workspace, for the planner's context.
 *
 * Without this the planner invents plausible-looking paths — `src/utils.ts`,
 * `lib/index.js` — and every node then declares a write set that does not
 * correspond to anything, which the write-set enforcement correctly rejects at
 * execution time. Showing the real tree up front is far cheaper than
 * discovering it through failed nodes.
 *
 * Directories are summarised rather than fully expanded past a budget, so a
 * large repo still fits in a planning context.
 */
export function workspaceMap(root: string, options: MapOptions = {}): string {
  const maxFiles = options.maxFiles ?? 300;
  const maxDepth = options.maxDepth ?? 4;
  const ignore = options.ignore ?? DEFAULT_IGNORES;

  const lines: string[] = [];
  let emitted = 0;
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || emitted >= maxFiles) {
      if (emitted >= maxFiles) truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const dirs = entries.filter((e) => e.isDirectory() && !ignore.includes(e.name));
    const files = entries.filter((e) => e.isFile() && !e.name.startsWith("."));

    for (const f of files) {
      if (emitted >= maxFiles) {
        truncated = true;
        return;
      }
      const abs = join(dir, f.name);
      const rel = relative(root, abs).split(sep).join("/");
      let size = 0;
      try {
        size = statSync(abs).size;
      } catch {
        // unreadable — still worth listing the path
      }
      lines.push(`${rel}${size ? ` (${fmtSize(size)})` : ""}`);
      emitted++;
    }

    for (const d of dirs) walk(join(dir, d.name), depth + 1);
  };

  walk(root, 0);
  lines.sort();

  if (truncated) {
    lines.push(`... truncated at ${maxFiles} files; ask for a listing if you need more`);
  }
  return lines.join("\n");
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}
