import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RendererClient } from "./rpc.ts";
import { Chat, type ContextLayer, type PlanProposal, type ThreadEntry } from "./views/Chat.tsx";
import { DagCanvas, NodeDrawer, type DrawerTab } from "./views/RunGraph.tsx";
import { DiffReview } from "./views/DiffReview.tsx";
import { FileDetail, FileLegend, FileTree, type FileState } from "./views/Files.tsx";
import { Models, type ProviderHealth } from "./views/Models.tsx";
import { Settings, type AcaConfigShape, type PermissionMatrix } from "./views/Settings.tsx";
import { Timeline } from "./views/Timeline.tsx";
import { Launcher, type Workspace } from "./views/Launcher.tsx";
import type {
  AcaEvent,
  DiffFile,
  ModelRow,
  NodeRow,
  Scorecard,
  TreeEntry,
} from "./views/shared.ts";

type View = "chat" | "graph" | "files" | "diff" | "timeline" | "models" | "settings";

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
  const [switcher, setSwitcher] = useState(false);
  const [view, setView] = useState<View>("chat");

  // Session
  const [threadId, setThreadId] = useState("default");
  const [thread, setThread] = useState<ThreadEntry[]>([]);
  const [streaming, setStreaming] = useState<{ text: string; thinking: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<PlanProposal | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  // Workspace data
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [scorecards, setScorecards] = useState<Scorecard[]>([]);
  const [providers, setProviders] = useState<ProviderHealth[]>([]);
  const [resident, setResident] = useState<{ provider: string; model: string }[]>([]);
  const [slots, setSlots] = useState(1);
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [events, setEvents] = useState<AcaEvent[]>([]);
  const [diffs, setDiffs] = useState<DiffFile[]>([]);
  const [indexStats, setIndexStats] = useState({ files: 0, chunks: 0, embedded: 0 });
  const [config, setConfig] = useState<AcaConfigShape | null>(null);
  const [permissions, setPermissions] = useState<PermissionMatrix>({});

  // Selection
  const [scrub, setScrub] = useState(0);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("context");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileBody, setFileBody] = useState("");
  const [activeModel, setActiveModel] = useState("");
  const [approval, setApproval] = useState<{
    id: string;
    summary: string;
    detail: string;
    irreversible: boolean;
  } | null>(null);
  const [probing, setProbing] = useState<{ model: string; done: number; total: number } | null>(
    null,
  );

  const rootRef = useRef<string | null>(null);

  // ------------------------------------------------------------- connect

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
      const p = params as Record<string, never>;

      if (method === "event") {
        const event = (params as unknown as { event: AcaEvent }).event;
        setEvents((prev) => {
          const atEnd = scrubAtEnd.current;
          const next = [...prev, event];
          if (atEnd) setScrub(event.seq ?? 0);
          return next;
        });
      } else if (method === "chat.delta") {
        const kind = String(p["kind"]);
        const delta = String(p["delta"]);
        setStreaming((s) => ({
          text: s ? s.text + (kind === "text" ? delta : "") : kind === "text" ? delta : "",
          thinking: s
            ? s.thinking + (kind === "thinking" ? delta : "")
            : kind === "thinking"
              ? delta
              : "",
        }));
      } else if (method === "chat.turn") {
        const role = String(p["role"]) as ThreadEntry["role"];
        const content = String(p["content"] ?? "");
        const thinking = String(p["thinking"] ?? "");
        // Always clears the live bubble — this is the only thing that does, so
        // missing it leaves the UI streaming forever.
        setStreaming(null);
        // A round that only called tools has no prose; rendering it would put
        // an empty assistant bubble above every tool chip.
        if (!content && !thinking) return;
        setThread((t) => [
          ...t,
          {
            id: `${Date.now()}-${t.length}`,
            role,
            content,
            ...(p["model"] ? { model: String(p["model"]) } : {}),
            ...(thinking ? { thinking } : {}),
          },
        ]);
      } else if (method === "chat.tool") {
        setThread((t) => [
          ...t,
          {
            id: `${Date.now()}-tool-${t.length}`,
            role: "tool",
            toolName: String(p["name"]),
            content: JSON.stringify(p["args"] ?? {}),
          },
        ]);
      } else if (method === "chat.toolResult") {
        setThread((t) => [
          ...t,
          {
            id: `${Date.now()}-res-${t.length}`,
            role: "tool",
            toolName: String(p["name"]),
            content: String(p["preview"] ?? "").slice(0, 120),
            untrusted: true,
          },
        ]);
      } else if (method === "run.proposed") {
        const proposal = params as unknown as {
          runId: string;
          plan: { nodes: NodeRow[] };
          spec: { acceptance: string[] };
          problems: { severity: string; nodeId?: string; message: string }[];
        };
        setPlan({
          runId: proposal.runId,
          nodes: proposal.plan.nodes,
          acceptance: proposal.spec.acceptance,
          problems: proposal.problems ?? [],
          model: activeModelRef.current,
        });
        setNodes(proposal.plan.nodes);
        setRunId(proposal.runId);
        setBusy(false);
      } else if (method === "run.started") {
        setPlan(null);
        setView("graph");
      } else if (method === "run.finished") {
        setBusy(false);
        void refreshRun(String(p["runId"]));
      } else if (method === "approval.requested") {
        setApproval((params as unknown as { approval: typeof approval }).approval);
      } else if (method === "approval.resolved") {
        setApproval(null);
      } else if (method === "probe.progress") {
        setProbing({
          model: String(p["model"]),
          done: Number(p["done"]),
          total: Number(p["total"]),
        });
      } else if (method === "index.progress") {
        setProbing(null);
      }
    });
  }, []);

  // Keeps live events following the playhead unless the user scrubbed back.
  const scrubAtEnd = useRef(true);
  useEffect(() => {
    scrubAtEnd.current = scrub >= (events.at(-1)?.seq ?? 0);
  }, [scrub, events]);

  const activeModelRef = useRef("");
  useEffect(() => {
    activeModelRef.current = activeModel;
  }, [activeModel]);

  // -------------------------------------------------------------- loading

  const refreshRun = useCallback(async (id: string) => {
    const root = rootRef.current;
    if (!root) return;
    try {
      const [nodeRows, diffRows] = await Promise.all([
        client.call<NodeRow[]>("run.nodes", { runId: id }),
        client.call<DiffFile[]>("diff.forRun", { path: root, runId: id }),
      ]);
      if (nodeRows.length > 0) setNodes(nodeRows);
      setDiffs(diffRows);
    } catch {
      // A finished run may already be gone from the session map; the event log
      // still has everything, and the timeline reads from that.
    }
  }, []);

  const openWorkspace = useCallback(
    async (root: string) => {
      try {
        rootRef.current = root;
        const info = await client.call<{
          name: string;
          root: string;
          branch: string | null;
          index: { files: number; chunks: number; embedded: number };
        }>("workspace.open", { path: root });
        setOpen(info);
        setIndexStats(info.index);
        setSwitcher(false);

        const [treeRows, modelRows, cards, cfg, status, residency] = await Promise.all([
          client.call<TreeEntry[]>("files.tree", { path: root }),
          client.call<ModelRow[]>("models.list", { path: root }),
          client.call<Scorecard[]>("models.scorecards", { path: root }),
          client.call<{ config: AcaConfigShape; permissions: PermissionMatrix }>("config.get", {
            path: root,
          }),
          client.call<{ providers?: unknown }>("workspace.status", { path: root }),
          client.call<{ resident: { provider: string; model: string }[]; slots: number }>(
            "models.residency",
            { path: root },
          ),
        ]);

        setTree(treeRows);
        setModels(modelRows);
        setScorecards(cards);
        setConfig(cfg.config);
        setPermissions(cfg.permissions);
        setResident(residency.resident);
        setSlots(residency.slots);
        void status;

        // Provider health, derived from what actually answered.
        const byProvider = new Map<string, number>();
        for (const m of modelRows)
          byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + 1);
        setProviders(
          [...byProvider].map(([id, count]) => ({
            id,
            up: true,
            models: count,
            detail: "reachable",
          })),
        );

        if (!activeModel && modelRows.length > 0) {
          const preferred =
            modelRows.find((m) => m.state === "resident" && !/embed/i.test(m.id)) ??
            modelRows.find((m) => !/embed/i.test(m.id));
          if (preferred) setActiveModel(preferred.id);
        }

        const created = await client.call<{ threadId: string }>("chat.create", { path: root });
        setThreadId(created.threadId);
        await client.call("run.subscribe", { path: root });
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [activeModel],
  );

  // -------------------------------------------------------------- actions

  const send = useCallback(
    async (text: string) => {
      const root = rootRef.current;
      if (!root) return;
      setBusy(true);
      // Not appended locally: the daemon echoes the turn to every client, and
      // doing both showed each message twice.

      try {
        // Keyword intent, deliberately crude: classifying with a model costs a
        // round-trip per message on local hardware, and the user can always
        // force either path.
        if (
          /\b(add|implement|fix|refactor|rename|remove|delete|migrate|create|write|update|change|make)\b/i.test(
            text,
          )
        ) {
          await client.call("run.plan", { path: root, threadId, goal: text });
        } else {
          await client.call("chat.send", { path: root, threadId, text, model: activeModel });
          setBusy(false);
        }
      } catch (err) {
        setThread((t) => [
          ...t,
          {
            id: `${Date.now()}-e`,
            role: "assistant",
            content: `error: ${(err as Error).message}`,
          },
        ]);
        setBusy(false);
      }
    },
    [threadId, activeModel],
  );

  const openFile = useCallback(async (path: string) => {
    const root = rootRef.current;
    if (!root) return;
    setSelectedFile(path);
    try {
      const res = await client.call<{ content: string }>("files.read", {
        path: root,
        file: path,
      });
      setFileBody(res.content.slice(0, 40_000));
    } catch (err) {
      setFileBody(`cannot read: ${(err as Error).message}`);
    }
  }, []);

  const fileState: FileState | null = useMemo(() => {
    const entry = tree.find((t) => t.path === selectedFile);
    if (!entry) return null;
    const epochEvent = events
      .filter((e) => e.type === "epoch.bumped" && e.payload["resource"] === entry.path)
      .at(-1);
    return {
      path: entry.path,
      git: entry.git,
      lockedBy: entry.lockedBy,
      inWriteSet: entry.inWriteSet,
      indexed: entry.indexed,
      sizeBytes: entry.sizeBytes,
      epoch: epochEvent ? Number(epochEvent.payload["epoch"]) : null,
    };
  }, [tree, selectedFile, events]);

  const focusedNode = nodes.find((n) => n.id === selectedNode) ?? null;
  const usage = useMemo(() => {
    let tokens = 0;
    let cost = 0;
    for (const e of events) {
      if (e.type !== "model.response") continue;
      tokens += Number(e.payload["inputTokens"] ?? 0) + Number(e.payload["outputTokens"] ?? 0);
      cost += Number(e.payload["costUsd"] ?? 0);
    }
    return { tokens, cost };
  }, [events]);

  const contextLayers: ContextLayer[] = useMemo(() => {
    const fenced = events.filter((e) => e.type === "guard.fenced").length;
    return [
      { rank: 1, label: "System + workspace map", tokens: 980, pinned: true, untrusted: false },
      {
        rank: 2,
        label: `Conversation · ${thread.filter((t) => t.role !== "tool").length} turns`,
        tokens: thread.reduce((s, t) => s + Math.ceil(t.content.length / 4), 0),
        pinned: false,
        untrusted: false,
      },
      ...(fenced > 0
        ? [
            {
              rank: 7,
              label: `Tool results · ${fenced} fenced`,
              tokens: fenced * 400,
              pinned: false,
              untrusted: true,
            },
          ]
        : []),
    ];
  }, [events, thread]);

  // ---------------------------------------------------------------- render

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
        connected={connected}
        onOpen={openWorkspace}
        onPick={async () => {
          const picked = await window.aca.pickWorkspace();
          if (picked) await openWorkspace(picked);
        }}
      />
    );
  }

  const activeWindow = models.find((m) => m.id === activeModel)?.caps.contextWindow ?? 8192;

  return (
    <>
      <div className="titlebar" style={{ position: "relative" }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: connected ? "var(--moss)" : "var(--crimson)",
          }}
        />
        <span
          className="interactive"
          style={{ cursor: "pointer", display: "flex", gap: 8, alignItems: "center" }}
          onClick={() => setSwitcher((s) => !s)}
        >
          <b>{open.name}</b>
          <span className="dim">{open.root}</span>
          {open.branch && <span className="dim">· {open.branch}</span>}
          <span style={{ color: "var(--ember)", fontSize: 9 }}>▾</span>
        </span>

        <div style={{ flex: 1 }} />
        {runId && (
          <span className={`pill ${busy ? "p-run" : "p-mute"}`}>
            {busy ? "▶ running" : "idle"} {runId}
          </span>
        )}

        {switcher && (
          <div className="dd interactive" style={{ left: 8, top: 34 }}>
            <div className="dh">Workspace</div>
            {workspaces.map((w) => (
              <div
                key={w.id}
                className={`di${w.root === open.root ? " on" : ""}`}
                onClick={() => void openWorkspace(w.root)}
              >
                <span>▸</span>
                <span>{w.name}</span>
                <span className="r2">
                  {w.indexStale ? "stale" : `${w.indexedChunks} chunks`}
                </span>
              </div>
            ))}
            <div className="sep" />
            <div
              className="di"
              onClick={async () => {
                const picked = await window.aca.pickWorkspace();
                if (picked) await openWorkspace(picked);
              }}
            >
              <span style={{ color: "var(--ember)" }}>+</span>
              <span>Open folder…</span>
            </div>
            <div
              className="di"
              onClick={() => {
                setSwitcher(false);
                void client.call("workspace.index", { path: open.root });
              }}
            >
              <span>⟳</span>
              <span>Re-index workspace</span>
              <span className="r2">{indexStats.chunks} chunks</span>
            </div>
          </div>
        )}
      </div>

      <div className="body">
        <nav className="rail">
          <Rail
            label="Session"
            active={view === "chat" || view === "graph"}
            onClick={() => setView("chat")}
          >
            <path d="M21 11.5a8 8 0 0 1-8 8H8.2L3.5 22.5V17A8 8 0 1 1 21 11.5z" />
          </Rail>
          <Rail label="Files" active={view === "files"} onClick={() => setView("files")}>
            <path d="M4 4v16M4 7h5M4 12h5M4 17h5M12 5h8M12 10h8M12 15h8M12 20h5" />
          </Rail>
          <Rail label="Diff review" active={view === "diff"} onClick={() => setView("diff")}>
            <path d="M4 5h7v14H4zM13 5h7v14h-7zM6.5 12h2M15.5 10h2M15.5 14h2" />
          </Rail>
          <Rail
            label="Timeline"
            active={view === "timeline"}
            onClick={() => setView("timeline")}
          >
            <path d="M3 12h18M7 8v8M12 5v14M17 9v6" />
          </Rail>
          <Rail label="Models" active={view === "models"} onClick={() => setView("models")}>
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <path d="M9 9h6v6H9z" />
          </Rail>
          <div className="spacer" />
          <Rail
            label="Settings"
            active={view === "settings"}
            onClick={() => setView("settings")}
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
          </Rail>
        </nav>

        {/* Files panel is persistent across session views, per the design. */}
        {(view === "chat" || view === "graph" || view === "files") && (
          <div className="col left">
            <div className="phead">
              Files
              <span className="r">
                <span>{tree.filter((t) => t.lockedBy).length} locked</span>
              </span>
            </div>
            <div className="pbody">
              <FileTree entries={tree} selected={selectedFile} onSelect={openFile} />
              <FileLegend />
            </div>
          </div>
        )}

        {view === "chat" && (
          <Chat
            thread={thread}
            streaming={streaming}
            plan={plan}
            models={models}
            activeModel={activeModel}
            contextLayers={contextLayers}
            contextWindow={activeWindow}
            busy={busy}
            onSend={(t) => void send(t)}
            onModelChange={setActiveModel}
            onApprovePlan={(id) => {
              setBusy(true);
              void client.call("run.start", { runId: id });
            }}
            onRejectPlan={(id, reason) => {
              setPlan(null);
              void client.call("run.reject", { runId: id, reason });
            }}
          />
        )}

        {view === "graph" && (
          <>
            <div className="col center">
              <div className="phead">
                Session
                <span className="r">
                  <span className="segbtn">
                    <button onClick={() => setView("chat")}>thread</button>
                    <button className="on">graph</button>
                  </span>
                  <span>{nodes.length} nodes</span>
                  {busy && runId && (
                    <button
                      className="btn danger"
                      onClick={() => void client.call("run.cancel", { runId })}
                    >
                      cancel
                    </button>
                  )}
                </span>
              </div>
              <div className="pbody flush">
                <DagCanvas nodes={nodes} selected={selectedNode} onSelect={setSelectedNode} />
              </div>
            </div>
            <div className="col right">
              <div className="phead">{focusedNode ? `Node ${focusedNode.id}` : "Detail"}</div>
              {approval ? (
                <ApprovalCard approval={approval} onRespond={(g) => void respond(g)} />
              ) : (
                <NodeDrawer
                  node={focusedNode}
                  events={events}
                  tab={drawerTab}
                  onTab={setDrawerTab}
                />
              )}
            </div>
          </>
        )}

        {view === "files" && (
          <>
            <div className="col center">
              <div className="phead">
                {selectedFile ?? "—"}
                <span className="r">
                  {fileState?.lockedBy && <span className="pill p-block">locked</span>}
                  {fileState?.inWriteSet && <span className="pill p-run">in write set</span>}
                </span>
              </div>
              <div className="pbody flush">
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
              </div>
            </div>
            <div className="col right">
              <div className="phead">File state</div>
              <div className="pbody">
                <FileDetail
                  state={fileState}
                  indexStats={indexStats}
                  onAttach={(p) => void send(`Look at ${p} and explain what it does.`)}
                  onRollback={(p) =>
                    void client.call("files.read", { path: open.root, file: p })
                  }
                />
              </div>
            </div>
          </>
        )}

        {view === "diff" && (
          <DiffReview
            files={diffs}
            reviewRoundsLeft={config?.run.maxReviewRounds ?? 3}
            onReject={(file, hunk, note) => {
              void send(
                `The change to ${file} (hunk ${hunk + 1}) is wrong: ${note}. Please fix it.`,
              );
              setView("chat");
            }}
          />
        )}

        {view === "timeline" && (
          <Timeline events={events} position={scrub} onScrub={setScrub} />
        )}

        {view === "models" && (
          <Models
            models={models}
            scorecards={scorecards}
            providers={providers}
            resident={resident}
            slots={slots}
            probing={probing}
            onProbe={(model) => {
              setProbing({ model: model ?? "all", done: 0, total: models.length });
              void client
                .call("models.probe", { path: open.root, ...(model ? { model } : {}) })
                .then(async () => {
                  setProbing(null);
                  setScorecards(
                    await client.call<Scorecard[]>("models.scorecards", { path: open.root }),
                  );
                })
                .catch(() => setProbing(null));
            }}
          />
        )}

        {view === "settings" && config && (
          <Settings
            config={config}
            permissions={permissions}
            root={open.root}
            onSave={(next) => {
              setConfig(next);
              void client.call("config.set", { path: open.root, config: next });
            }}
          />
        )}
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
          <b>model</b> {activeModel || "—"}
        </span>
        <span className="seg">
          <b>tokens</b> <span className="num">{usage.tokens.toLocaleString()}</span>
        </span>
        <span className="seg">
          <b>cost</b> <span className="num">${usage.cost.toFixed(4)}</span>{" "}
          {config?.router.privacy === "local-only" && <span className="dim">local-only</span>}
        </span>
        <span className="seg last">
          <b>events</b> <span className="num">{events.length}</span>
        </span>
      </div>
    </>
  );

  async function respond(granted: boolean): Promise<void> {
    if (!approval) return;
    await client.call("approval.respond", { approvalId: approval.id, granted, scope: "once" });
    setApproval(null);
  }
}

function ApprovalCard({
  approval,
  onRespond,
}: {
  approval: { summary: string; detail: string; irreversible: boolean };
  onRespond: (granted: boolean) => void;
}): JSX.Element {
  return (
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
        <button className="btn primary" onClick={() => onRespond(true)}>
          Approve
        </button>
        <button className="btn danger" onClick={() => onRespond(false)}>
          Reject
        </button>
      </div>
    </div>
  );
}

function Rail({
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
