import React from "react";

export interface Workspace {
  id: string;
  name: string;
  root: string;
  indexedChunks: number;
  indexStale: boolean;
  lastRunAt: number | null;
}

/**
 * The no-workspace-open state.
 *
 * Index freshness is shown per workspace because it is the most common reason
 * an agent gives a bad answer about an unfamiliar repo — and it is otherwise
 * completely invisible until a run goes wrong.
 */
export function Launcher({
  workspaces,
  connected,
  onOpen,
  onPick,
}: {
  workspaces: Workspace[];
  connected: boolean;
  onOpen: (root: string) => void;
  onPick: () => void;
}): JSX.Element {
  return (
    <>
      <div className="titlebar">
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: connected ? "var(--moss)" : "var(--ink-3)",
          }}
        />
        <span className="dim">no workspace</span>
      </div>

      <div className="body">
        <div className="launch">
          <div className="lcard">
            <div
              className="mono"
              style={{
                fontSize: 10,
                letterSpacing: ".14em",
                textTransform: "uppercase",
                color: "var(--ember)",
                marginBottom: 10,
              }}
            >
              Auto-Code-Agent
            </div>
            <h3 style={{ fontSize: 22, margin: "0 0 6px" }}>Open a workspace</h3>
            <p className="dim" style={{ marginBottom: 22 }}>
              A workspace is a repo the agent can read, index, and write to. Everything is
              scoped to it — permissions, memory, and run history.
            </p>

            {workspaces.length > 0 && (
              <div
                className="mono dim"
                style={{
                  fontSize: 9.5,
                  letterSpacing: ".1em",
                  textTransform: "uppercase",
                  marginBottom: 9,
                }}
              >
                Recent
              </div>
            )}

            {workspaces.map((w) => (
              <div key={w.id} className="wsitem" onClick={() => onOpen(w.root)}>
                <span style={{ color: "var(--ember)" }}>▸</span>
                <div style={{ minWidth: 0 }}>
                  <div className="wn">{w.name}</div>
                  <div className="wp" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                    {w.root}
                  </div>
                </div>
                <div className="wr">
                  <div>
                    {w.indexStale ? (
                      <span style={{ color: "var(--wheat)" }}>⚠ index stale</span>
                    ) : (
                      <span style={{ color: "var(--moss)" }}>✓ {w.indexedChunks} chunks</span>
                    )}
                  </div>
                  <div>{w.lastRunAt ? `last run ${relative(w.lastRunAt)}` : "never run"}</div>
                </div>
              </div>
            ))}

            {workspaces.length === 0 && (
              <p className="dim" style={{ fontSize: 13 }}>
                No workspaces yet.
              </p>
            )}

            <div style={{ display: "flex", gap: 7, marginTop: 18 }}>
              <button className="btn primary" onClick={onPick}>
                Open folder…
              </button>
            </div>

            <div
              style={{
                marginTop: 26,
                paddingTop: 16,
                borderTop: "1px solid var(--line)",
                fontFamily: "var(--mono)",
                fontSize: 10.5,
                color: "var(--ink-3)",
              }}
            >
              {/* Provider health before you start, not after a run fails. */}
              <span style={{ color: connected ? "var(--moss)" : "var(--crimson)" }}>
                ●
              </span>{" "}
              daemon {connected ? "connected" : "unreachable — run: pnpm daemon"}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function relative(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
