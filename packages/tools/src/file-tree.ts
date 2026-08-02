import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DEFAULT_IGNORES } from "./checkpoint.ts";

export interface TreeEntry {
  path: string;
  name: string;
  kind: "file" | "dir";
  depth: number;
  /** git porcelain code: M, A, D, ?? … or null when clean/untracked-ignored. */
  git: string | null;
  /** Node id holding a write lock on this path, when a run is active. */
  lockedBy: string | null;
  /** True when a running node declared this path in its write set. */
  inWriteSet: boolean;
  indexed: boolean;
  sizeBytes: number;
}

export interface TreeOptions {
  maxDepth?: number;
  maxEntries?: number;
  /** resource → nodeId, from the lock table. */
  locks?: Map<string, string>;
  writeSets?: Set<string>;
  indexedSources?: Set<string>;
}

/**
 * The file tree the desktop and CLI render.
 *
 * The point of building this rather than shelling out to `ls` is the overlay:
 * git status is public knowledge, but locks, declared write sets and index
 * coverage are things only this app knows, and they are exactly what a user
 * needs to see while a run is touching their working tree.
 */
export function fileTree(root: string, options: TreeOptions = {}): TreeEntry[] {
  const maxDepth = options.maxDepth ?? 3;
  const maxEntries = options.maxEntries ?? 500;
  const git = gitStatus(root);
  const entries: TreeEntry[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || entries.length >= maxEntries) return;
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const dirs = items
      .filter((i) => i.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = items.filter((i) => i.isFile()).sort((a, b) => a.name.localeCompare(b.name));

    for (const item of [...dirs, ...files]) {
      if (entries.length >= maxEntries) return;
      const abs = join(dir, item.name);
      const rel = relative(root, abs).split(sep).join("/");
      const ignored = DEFAULT_IGNORES.includes(item.name);

      entries.push({
        path: rel,
        name: item.name,
        kind: item.isDirectory() ? "dir" : "file",
        depth,
        git: git.get(rel) ?? null,
        lockedBy: lockHolder(rel, options.locks),
        inWriteSet: options.writeSets
          ? [...options.writeSets].some((w) => covers(w, rel))
          : false,
        indexed: options.indexedSources?.has(rel) ?? false,
        sizeBytes: item.isFile() ? safeSize(abs) : 0,
      });

      if (item.isDirectory() && !ignored) walk(abs, depth + 1);
    }
  };

  walk(root, 0);
  return entries;
}

function lockHolder(path: string, locks?: Map<string, string>): string | null {
  if (!locks) return null;
  for (const [resource, nodeId] of locks) {
    if (covers(resource, path)) return nodeId;
  }
  return null;
}

/** True when `resource` (possibly a glob or directory) covers `path`. */
function covers(resource: string, path: string): boolean {
  const r = resource.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
  return path === r || path.startsWith(r + "/") || r === "";
}

function safeSize(abs: string): number {
  try {
    return statSync(abs).size;
  } catch {
    return 0;
  }
}

/**
 * git status as a path → code map.
 *
 * Shelled out rather than reimplemented: the index format is not something to
 * reverse-engineer, and every developer machine already has git.
 */
export function gitStatus(root: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const raw = execSync("git status --porcelain=v1 -z", {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const record of raw.split("\0")) {
      if (record.length < 4) continue;
      out.set(record.slice(3).replace(/\\/g, "/"), record.slice(0, 2).trim());
    }
  } catch {
    // Not a repo, or git unavailable. The tree is still worth rendering.
  }
  return out;
}

export function currentBranch(root: string): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
