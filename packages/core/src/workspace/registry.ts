import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface WorkspaceEntry {
  id: string;
  name: string;
  root: string;
  addedAt: number;
  lastRunAt: number | null;
  indexedChunks: number;
  indexStale: boolean;
}

/**
 * Global workspace registry.
 *
 * Everything else is workspace-scoped — permissions, memory, run history and
 * the state database all live under the workspace's own `.aca/`. Retrofitting
 * that scoping later is a migration nobody wants, so it exists from the start.
 */
export class WorkspaceRegistry {
  private file: string;
  private entries: WorkspaceEntry[] = [];

  constructor(file = join(homedir(), ".aca", "workspaces.json")) {
    this.file = file;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      this.entries = JSON.parse(readFileSync(this.file, "utf8")) as WorkspaceEntry[];
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.entries, null, 2), "utf8");
  }

  list(): WorkspaceEntry[] {
    return [...this.entries].sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0));
  }

  find(nameOrPath: string): WorkspaceEntry | undefined {
    const abs = resolve(nameOrPath);
    return this.entries.find((e) => e.name === nameOrPath || e.root === abs);
  }

  add(root: string): WorkspaceEntry {
    const abs = resolve(root);
    const existing = this.entries.find((e) => e.root === abs);
    if (existing) return existing;

    const entry: WorkspaceEntry = {
      id: Math.random().toString(36).slice(2, 10),
      name: basename(abs),
      root: abs,
      addedAt: Date.now(),
      lastRunAt: null,
      indexedChunks: 0,
      indexStale: true,
    };
    this.entries.push(entry);
    this.save();
    return entry;
  }

  /**
   * Records index freshness after an indexing pass.
   *
   * Without this the launcher and `ws list` permanently report "index stale"
   * even for a fully indexed repo — which is worse than showing nothing,
   * because index freshness is the signal users are meant to act on.
   */
  setIndexState(id: string, chunks: number, stale = false): void {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    e.indexedChunks = chunks;
    e.indexStale = stale;
    this.save();
  }

  touch(id: string): void {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    e.lastRunAt = Date.now();
    this.save();
  }

  forget(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.save();
  }

  /** Per-workspace state database. One portable file per repo. */
  static dbPath(root: string): string {
    return join(resolve(root), ".aca", "state.db");
  }

  static artifactDir(root: string): string {
    return join(resolve(root), ".aca", "artifacts");
  }

  static checkpointDir(root: string): string {
    return join(resolve(root), ".aca", "checkpoints");
  }
}
