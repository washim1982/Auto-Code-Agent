import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { resourcesIntersect, WriteSetViolation } from "@aca/core";
import { resolveInWorkspace, toResourceId } from "./paths.ts";

interface FileSnapshot {
  resource: string;
  existed: boolean;
  sha256: string;
  backupPath: string | null;
}

export interface VerifyResult {
  ok: boolean;
  violations: string[];
}

/**
 * Checkpoint / rollback with declared-write-set enforcement (flow review F4).
 *
 * The original flow had the planner declare write sets and the scheduler reason
 * over them, but nothing ever checked the sub-agent stayed inside its
 * declaration. One out-of-set write silently invalidates every conflict
 * decision the scheduler made.
 *
 * Two layers of enforcement here, because Windows gives us no syscall boundary:
 *
 *  1. `assertWritable` gates every write that goes through our tool API.
 *  2. `verify` re-hashes the workspace after a subprocess ran and reports any
 *     file that changed outside the declared set. A subprocess can write
 *     wherever the OS lets it, so detection after the fact is the only honest
 *     option — but detection is enough, because it fails the node.
 */
export class Checkpoint {
  private snapshots = new Map<string, FileSnapshot>();
  /** Hashes of the whole tracked tree, used for post-hoc verification. */
  private baseline = new Map<string, string>();
  readonly id: string;

  private root: string;
  private declaredWrite: readonly string[];
  private backupDir: string;

  constructor(root: string, declaredWrite: readonly string[], backupDir: string) {
    this.root = root;
    this.declaredWrite = declaredWrite;
    this.backupDir = backupDir;
    this.id = createHash("sha256")
      .update(`${root}:${Date.now()}:${Math.random()}`)
      .digest("hex")
      .slice(0, 12);
    mkdirSync(this.backupDirFor(), { recursive: true });
  }

  private backupDirFor(): string {
    return join(this.backupDir, this.id);
  }

  /** True when `resource` falls inside the declared write set. */
  isWritable(resource: string): boolean {
    return this.declaredWrite.some((d) => resourcesIntersect(d, resource));
  }

  assertWritable(absPath: string): string {
    const resource = toResourceId(this.root, absPath);
    if (!this.isWritable(resource)) {
      throw new WriteSetViolation(resource, this.declaredWrite);
    }
    return resource;
  }

  /**
   * Records the current contents of a path so it can be restored.
   * Idempotent — the first snapshot wins, so repeated writes to the same file
   * still roll back to the pre-node state rather than the previous write.
   */
  snapshot(absPath: string): void {
    const resource = toResourceId(this.root, absPath);
    if (this.snapshots.has(resource)) return;

    const existed = existsSync(absPath);
    let sha = "";
    let backupPath: string | null = null;

    if (existed) {
      const buf = readFileSync(absPath);
      sha = createHash("sha256").update(buf).digest("hex");
      backupPath = join(this.backupDirFor(), sha);
      if (!existsSync(backupPath)) {
        mkdirSync(dirname(backupPath), { recursive: true });
        copyFileSync(absPath, backupPath);
      }
    }

    this.snapshots.set(resource, { resource, existed, sha256: sha, backupPath });
  }

  /** Hashes the tracked tree so `verify` can detect out-of-set writes later. */
  captureBaseline(ignore: string[] = DEFAULT_IGNORES): void {
    this.baseline = hashTree(this.root, ignore);
  }

  /**
   * Detects files changed outside the declared write set.
   *
   * This is what catches a subprocess that ignored its instructions — the case
   * `assertWritable` structurally cannot see.
   */
  verify(ignore: string[] = DEFAULT_IGNORES): VerifyResult {
    const now = hashTree(this.root, ignore);
    const violations: string[] = [];

    for (const [resource, hash] of now) {
      if (this.baseline.get(resource) === hash) continue;
      if (!this.isWritable(resource)) violations.push(resource);
    }
    for (const resource of this.baseline.keys()) {
      if (now.has(resource)) continue;
      if (!this.isWritable(resource)) violations.push(`${resource} (deleted)`);
    }

    return { ok: violations.length === 0, violations };
  }

  /** Restores every snapshotted path to its pre-node contents. */
  rollback(): string[] {
    const restored: string[] = [];
    for (const snap of this.snapshots.values()) {
      const abs = resolveInWorkspace(this.root, snap.resource);
      if (snap.existed && snap.backupPath && existsSync(snap.backupPath)) {
        mkdirSync(dirname(abs), { recursive: true });
        copyFileSync(snap.backupPath, abs);
        restored.push(snap.resource);
      } else if (!snap.existed && existsSync(abs)) {
        // The node created this file; rolling back means it never existed.
        unlinkSync(abs);
        restored.push(snap.resource);
      }
    }
    return restored;
  }

  /** Paths this checkpoint actually touched — the real write set. */
  touched(): string[] {
    return [...this.snapshots.keys()];
  }

  dispose(): void {
    rmSync(this.backupDirFor(), { recursive: true, force: true });
  }

  /** Guarded write. Every mutating tool goes through here. */
  write(requestedPath: string, content: string): string {
    const abs = resolveInWorkspace(this.root, requestedPath);
    const resource = this.assertWritable(abs);
    this.snapshot(abs);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return resource;
  }
}

export const DEFAULT_IGNORES = [
  "node_modules",
  ".git",
  "dist",
  ".aca",
  "coverage",
  ".next",
  ".turbo",
];

function hashTree(root: string, ignore: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (ignore.includes(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile()) {
        try {
          const st = statSync(abs);
          // Size+mtime is a cheap proxy; content hash for small files where a
          // same-size same-second edit is plausible.
          const key = relative(root, abs).split(sep).join("/");
          const sig =
            st.size < 262144
              ? createHash("sha256").update(readFileSync(abs)).digest("hex")
              : `${st.size}:${st.mtimeMs}`;
          out.set(key, sig);
        } catch {
          // unreadable file — ignore rather than fail the whole verification
        }
      }
    }
  };
  walk(root);
  return out;
}
