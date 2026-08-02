import React, { useCallback, useEffect, useState } from "react";
import { RendererClient } from "./rpc.ts";
import {
  DagCanvas,
  EventTimeline,
  FileTree,
  ModelTable,
  type ModelRow,
  type NodeRow,
  type TreeEntry,
} from "./views.tsx";

type View = "session" | "files" | "timeline" | "models" | "settings";

interface Workspace {
  id: string;
  name: string;
  root: string;
  indexedChunks: number;
  indexStale: boolean;
}

interface AcaEvent {
  seq?: number;
  runId: string;
  nodeId: string | null;
  ts: number;
  type: string;
  payload: Record<string, unknown>;
}

const client = new RendererClient();

export function App(): JSX.Element {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [open, setOpen] = useState<{
    name: string;
    root: string;
    branch: string | null;
  } | null>(null);
  const [view, setView] = useState<View>("session");

  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [events, setEvents] = useState<AcaEvent[]>([]);
  const [scrub, setScrub] = useState(0);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileBody, setFileBody] = useState<string>("");
  const [approval, setApproval] = useState<{
    id: string;
    summary: string;
    detail: string;
    irreversible: boolean;
  } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        await client.connect();
        setConnected(true);
        setWorkspaces(await client.call<Workspace[]>("workspace.list"));
      } catch (err) {
        setError((err as Error).message);
      }
    })();

    return client.onNotification((method, params) => {
      if (method === "event") {
        const event = (params as { event: AcaEvent }).event;
        // Live events append; the scrubber follows unless the user has moved it.
        setEvents((prev) => {
          const next = [...prev, event];
          setScrub((s) => (s === (prev.at(-1)?.seq ?? 0) ? (event.seq ?? s) : s));
          return next;
        });
      } else if (method === "approval.requested") {
        const a = (
          params as {
            approval: { id: string; summary: string; detail: string; irreversible: boolean };
          }
        ).approval;
        setApproval(a);
      } else if (method === "approval.resolved") {
        setApproval(null);
      }
    });
  }, []);

  const openWorkspace = useCallback(async (root: string) => {
    try {
      const info = await client.call<{ name: string; root: string; branch: string | null }>(
        "workspace.open",
        { path: root },
      );
      setOpen(info);
      setTree(await client.call<TreeEntry[]>("files.tree", { path: root }));
      setModels(await client.call<ModelRow[]>("models.list", { path: root }));
      await client.call("run.subscribe", { path: root });
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const pickFolder = useCallback(async () => {
    const picked = await window.aca.pickWorkspace();
    if (picked) await openWorkspace(picked);
  }, [openWorkspace]);

  const respondApproval = useCallback(
    async (granted: boolean) => {
      if (!approval) return;
      await client.call("approval.respond", {
        approvalId: approval.id,
        granted,
        scope: "once",
      });
      setApproval(null);
    },
    [approval],
  );

  const openFile = useCallback(
    async (path: string) => {
      if (!open) return;
      setSelectedFile(path);
      try {
        const res = await client.call<{ content: string }>("files.read", {
          path: open.root,
          file: path,
        });
        setFileBody(res.content.slice(0, 20_000));
      } catch (err) {
        setFileBody(`cannot read: ${(err as Error).message}`);
      }
    },
    [open],
  );

  if (error && !connected) {
    return (
      <div className="empty" style={{ marginTop: 120 }}>
        <div style={{ color: "var(--crimson)", marginBottom: 12 }}>Cannot reach the daemon</div>
        <div className="mono" style={{ fontSize: 11 }}>
          {error}
        </div>
        <div className="dim" style={{ marginTop: 16 }}>
          Start it with: pnpm daemon
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <Launcher
        workspaces={workspaces}
        onOpen={openWorkspace}
        onPick={pickFolder}
        connected={connected}
      />
    );
  }

  const focused = nodes.find((n) => n.id === selectedNode) ?? null;

  return (
    <>
      <div className="titlebar">
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: connected ? "var(--moss)" : "var(--crimson)",
          }}
        />
        <span>{open.name}</span>
        <span className="dim">{open.root}</span>
        {open.branch && <span className="dim">· {open.branch}</span>}
        <div style={{ flex: 1 }} />
        <button className="btn interactive" onClick={() => setOpen(null)}>
          switch
        </button>
      </div>

      <div className="body">
        <nav className="rail">
          <RailButton
            label="Session"
            active={view === "session"}
            onClick={() => setView("session")}
          >
            <path d="M21 11.5a8 8 0 0 1-8 8H8.2L3.5 22.5V17A8 8 0 1 1 21 11.5z" />
          </RailButton>
          <RailButton label="Files" active={view === "files"} onClick={() => setView("files")}>
            <path d="M4 4v16M4 7h5M4 12h5M4 17h5M12 5h8M12 10h8M12 15h8M12 20h5" />
          </RailButton>
          <RailButton
            label="Timeline"
            active={view === "timeline"}
            onClick={() => setView("timeline")}
          >
            <path d="M3 12h18M7 8v8M12 5v14M17 9v6" />
          </RailButton>
          <RailButton
            label="Models"
            active={view === "models"}
            onClick={() => setView("models")}
          >
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <path d="M9 9h6v6H9z" />
          </RailButton>
          <div className="spacer" />
          <RailButton
            label="Settings"
            active={view === "settings"}
            onClick={() => setView("settings")}
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
          </RailButton>
        </nav>

        <div className="col left">
          <div className="phead">
            Files
            <span className="r">
              <span>{tree.filter((t) => t.lockedBy).length} locked</span>
            </span>
          </div>
          <div className="pbody">
            <FileTree entries={tree} selected={selectedFile} onSelect={openFile} />
          </div>
        </div>

        <div className="col center">
          <div className="phead">
            {view === "session" ? "Run graph" : view}
            <span className="r">
              <span>{nodes.length} nodes</span>
              <span>{events.length} events</span>
            </span>
          </div>
          <div className="pbody flush">
            {view === "session" && (
              <DagCanvas nodes={nodes} selected={selectedNode} onSelect={setSelectedNode} />
            )}
            {view === "files" && (
              <pre
                className="mono"
                style={{
                  margin: 0,
                  padding: 12,
                  fontSize: 11.5,
                  userSelect: "text",
                  overflow: "auto",
                }}
              >
                {fileBody || "Select a file."}
              </pre>
            )}
            {view === "timeline" && (
              <EventTimeline events={events} position={scrub} onScrub={setScrub} />
            )}
            {view === "models" && (
              <div style={{ padding: 12 }}>
                <ModelTable models={models} />
              </div>
            )}
            {view === "settings" && <Settings root={open.root} />}
          </div>
        </div>

        <div className="col right">
          <div className="phead">{focused ? `Node ${focused.id}` : "Detail"}</div>
          <div className="pbody">
            {approval && (
              <div className="approval">
                <div className="hd">⚠ approval required</div>
                <div className="cmd">{approval.summary}</div>
                {approval.irreversible && (
                  <div style={{ color: "var(--crimson)", fontSize: 12, marginBottom: 8 }}>
                    irreversible — rollback cannot undo this
                  </div>
                )}
                <div className="dim" style={{ fontSize: 12, marginBottom: 10 }}>
                  {approval.detail}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn primary" onClick={() => void respondApproval(true)}>
                    Approve
                  </button>
                  <button className="btn danger" onClick={() => void respondApproval(false)}>
                    Reject
                  </button>
                </div>
              </div>
            )}

            {focused ? (
              <div style={{ fontSize: 12.5 }}>
                <div
                  className="dim mono"
                  style={{
                    fontSize: 10,
                    letterSpacing: ".1em",
                    textTransform: "uppercase",
                    marginBottom: 6,
                  }}
                >
                  contract
                </div>
                <div style={{ marginBottom: 12 }}>{focused.contract || "(none stated)"}</div>
                <div className="ladder">
                  <div className="lr">
                    <span className="l">status</span>
                    <span className="tk">{focused.status}</span>
                  </div>
                  <div className="lr">
                    <span className="l">attempts</span>
                    <span className="tk">{focused.attempts}</span>
                  </div>
                  <div className="lr">
                    <span className="l">model</span>
                    <span className="tk">{focused.route?.model ?? "—"}</span>
                  </div>
                  <div className="lr">
                    <span className="l">reads</span>
                    <span className="tk">{focused.sets.read.join(", ") || "—"}</span>
                  </div>
                  <div className="lr">
                    <span className="l">writes</span>
                    <span className="tk">{focused.sets.write.join(", ") || "—"}</span>
                  </div>
                </div>
              </div>
            ) : (
              !approval && <div className="empty">Select a node.</div>
            )}
          </div>
        </div>
      </div>

      <div className="strip">
        <span className="seg">
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: connected ? "var(--moss)" : "var(--crimson)",
            }}
          />
          <b>daemon</b> {connected ? "connected" : "offline"}
        </span>
        <span className="seg">
          <b>models</b> <span className="num">{models.length}</span>
        </span>
        <span className="seg">
          <b>events</b> <span className="num">{events.length}</span>
        </span>
        <span className="seg last">
          <b>workspace</b> {open.name}
        </span>
      </div>
    </>
  );
}

function RailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button className={active ? "on" : ""} title={label} onClick={onClick}>
      <svg viewBox="0 0 24 24">{children}</svg>
    </button>
  );
}

/**
 * The no-workspace-open state.
 *
 * Index freshness is shown per workspace because it is the most common reason
 * an agent gives a bad answer about an unfamiliar repo, and it is otherwise
 * completely invisible.
 */
function Launcher({
  workspaces,
  onOpen,
  onPick,
  connected,
}: {
  workspaces: Workspace[];
  onOpen: (root: string) => void;
  onPick: () => void;
  connected: boolean;
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
              Everything is scoped to it — permissions, memory, and run history.
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
                <div>
                  <div className="wn">{w.name}</div>
                  <div className="wp">{w.root}</div>
                </div>
                <div className="wr">
                  {w.indexStale ? (
                    <span style={{ color: "var(--wheat)" }}>index stale</span>
                  ) : (
                    <span style={{ color: "var(--moss)" }}>{w.indexedChunks} chunks</span>
                  )}
                </div>
              </div>
            ))}

            <div style={{ display: "flex", gap: 7, marginTop: 18 }}>
              <button className="btn primary" onClick={onPick}>
                Open folder…
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Settings({ root }: { root: string }): JSX.Element {
  return (
    <div style={{ padding: 16, fontSize: 12.5, maxWidth: 620 }}>
      <div
        className="mono dim"
        style={{
          fontSize: 10,
          letterSpacing: ".1em",
          textTransform: "uppercase",
          marginBottom: 10,
        }}
      >
        Workspace
      </div>
      <div className="ladder">
        <div className="lr">
          <span className="l">root</span>
          <span className="tk">{root}</span>
        </div>
        <div className="lr">
          <span className="l">config</span>
          <span className="tk">.aca/config.json</span>
        </div>
        <div className="lr">
          <span className="l">state</span>
          <span className="tk">.aca/state.db</span>
        </div>
      </div>
      <p className="dim" style={{ marginTop: 16, lineHeight: 1.6 }}>
        Settings are edited in <span className="mono">.aca/config.json</span>. A workspace value
        overrides your personal default, so a repo can pin{" "}
        <span className="mono">local-only</span> and have it hold.
      </p>
    </div>
  );
}
