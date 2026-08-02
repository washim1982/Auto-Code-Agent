import React from "react";
import { fmtBytes, type TreeEntry } from "./shared.ts";

/**
 * File tree with the agent-state overlay.
 *
 * git status is public knowledge. Locks, declared write sets and index
 * coverage are things only this app knows, and they are exactly what a user
 * needs to see while a run is touching their working tree.
 */
export function FileTree({
  entries,
  selected,
  onSelect,
}: {
  entries: TreeEntry[];
  selected: string | null;
  onSelect: (path: string) => void;
}): JSX.Element {
  if (entries.length === 0) return <div className="empty">No files.</div>;

  return (
    <div className="ftree">
      {entries.map((e) => (
        <div
          key={e.path}
          className={`fr${selected === e.path ? " on" : ""}`}
          style={{
            paddingLeft: 6 + e.depth * 12,
            // Dimmed means excluded from the T3 index — the agent cannot
            // retrieve it, which is worth seeing at a glance.
            opacity: e.kind === "file" && !e.indexed ? 0.45 : 1,
          }}
          onClick={() => e.kind === "file" && onSelect(e.path)}
        >
          <span className="nm">
            {e.kind === "dir" ? "▸ " : ""}
            {e.name}
          </span>
          {e.lockedBy && (
            <span
              className="tw"
              style={{ color: "var(--slate)" }}
              title={`locked by node ${e.lockedBy}`}
            >
              🔒
            </span>
          )}
          {e.inWriteSet && (
            <span
              className="tw"
              style={{ color: "var(--ember)" }}
              title="in a running node's write set"
            >
              ▶
            </span>
          )}
          {e.git && (
            <span
              className="tw"
              style={{ color: e.git === "??" ? "var(--slate)" : "var(--moss)" }}
              title={`git: ${e.git}`}
            >
              {e.git === "??" ? "●" : e.git}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function FileLegend(): JSX.Element {
  return (
    <div
      className="mono"
      style={{
        fontSize: 10,
        color: "var(--ink-3)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        paddingTop: 11,
        marginTop: 11,
        borderTop: "1px solid var(--line)",
      }}
    >
      <div>
        <span style={{ color: "var(--moss)" }}>M</span> modified, uncommitted
      </div>
      <div>
        <span style={{ color: "var(--ember)" }}>▶</span> in a running node's write set
      </div>
      <div>
        <span style={{ color: "var(--slate)" }}>🔒</span> locked — read-only until released
      </div>
      <div>
        <span style={{ opacity: 0.45 }}>dimmed</span> excluded from the T3 index
      </div>
    </div>
  );
}

export interface FileState {
  path: string;
  git: string | null;
  lockedBy: string | null;
  inWriteSet: boolean;
  indexed: boolean;
  sizeBytes: number;
  epoch: number | null;
}

/** Per-file agent state, plus the actions only this app can offer. */
export function FileDetail({
  state,
  indexStats,
  onAttach,
  onRollback,
}: {
  state: FileState | null;
  indexStats: { files: number; chunks: number; embedded: number };
  onAttach: (path: string) => void;
  onRollback: (path: string) => void;
}): JSX.Element {
  if (!state) return <div className="empty">Select a file.</div>;

  const coverage =
    indexStats.files > 0 ? indexStats.embedded / Math.max(1, indexStats.chunks) : 0;

  return (
    <div>
      <div className="specrow">
        <b>git</b>
        <span style={{ color: state.git ? "var(--moss)" : undefined }}>
          {state.git ?? "clean"}
        </span>
      </div>
      <div className="specrow">
        <b>agent</b>
        <span style={{ color: state.inWriteSet ? "var(--ember)" : undefined }}>
          {state.inWriteSet ? "in a write set" : "not claimed"}
        </span>
      </div>
      <div className="specrow">
        <b>lock</b>
        <span style={{ color: state.lockedBy ? "var(--slate)" : undefined }}>
          {state.lockedBy ? `held by ${state.lockedBy}` : "free"}
        </span>
      </div>
      <div className="specrow">
        <b>indexed</b>
        <span>{state.indexed ? "yes" : "no"}</span>
      </div>
      <div className="specrow">
        <b>epoch</b>
        <span>{state.epoch ?? 0}</span>
      </div>
      <div className="specrow">
        <b>size</b>
        <span>{fmtBytes(state.sizeBytes)}</span>
      </div>

      <div
        className="dim mono"
        style={{
          fontSize: 10,
          letterSpacing: ".1em",
          textTransform: "uppercase",
          margin: "18px 0 9px",
        }}
      >
        Actions
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <button
          className="btn"
          style={{ textAlign: "left" }}
          onClick={() => onAttach(state.path)}
        >
          Attach to conversation &nbsp;<span className="dim">@</span>
        </button>
        <button
          className="btn danger"
          style={{ textAlign: "left" }}
          onClick={() => onRollback(state.path)}
          disabled={!state.git}
          title={state.git ? "Restore from HEAD" : "Nothing to roll back"}
        >
          Roll back to HEAD
        </button>
      </div>

      <div
        className="dim mono"
        style={{
          fontSize: 10,
          letterSpacing: ".1em",
          textTransform: "uppercase",
          margin: "20px 0 9px",
        }}
      >
        Index coverage
      </div>
      <div className="meter" style={{ height: 6 }}>
        <i style={{ width: `${Math.round(coverage * 100)}%`, background: "var(--moss)" }} />
      </div>
      <div className="dim mono" style={{ fontSize: 10.5, marginTop: 8 }}>
        {indexStats.chunks} chunks across {indexStats.files} files · {indexStats.embedded}{" "}
        embedded
      </div>

      <p className="dim" style={{ fontSize: 12, marginTop: 14, lineHeight: 1.5 }}>
        The epoch increments on every committed write and is part of every cache key, which is
        how a write invalidates reads of this file.
      </p>
    </div>
  );
}
