import React, { useMemo, useState } from "react";
import { nodeClass, pillClass, type AcaEvent, type NodeRow } from "./shared.ts";

export type DrawerTab = "context" | "model" | "tools" | "gates" | "diff";

/**
 * DAG canvas.
 *
 * Laid out by dependency depth rather than a force simulation. A plan is small
 * and its shape carries meaning — dependents below dependencies — so a
 * deterministic layout reads better than anything physics-based, and it does
 * not move under the cursor while a run progresses.
 */
export function DagCanvas({
  nodes,
  selected,
  onSelect,
}: {
  nodes: NodeRow[];
  selected: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const layout = useMemo(() => {
    const depth = new Map<string, number>();
    const compute = (id: string, seen = new Set<string>()): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (seen.has(id)) return 0; // defensive: the planner rejects cycles
      seen.add(id);
      const node = nodes.find((n) => n.id === id);
      const d = node?.deps.length ? Math.max(...node.deps.map((x) => compute(x, seen))) + 1 : 0;
      depth.set(id, d);
      return d;
    };
    for (const n of nodes) compute(n.id);

    const rows = new Map<number, NodeRow[]>();
    for (const n of nodes) {
      const d = depth.get(n.id) ?? 0;
      rows.set(d, [...(rows.get(d) ?? []), n]);
    }
    const positions = new Map<string, { x: number; y: number }>();
    for (const [d, rowNodes] of rows) {
      rowNodes.forEach((n, i) => positions.set(n.id, { x: 20 + i * 232, y: 16 + d * 108 }));
    }
    return {
      positions,
      height: 24 + (Math.max(0, ...depth.values()) + 1) * 108,
      width: 40 + Math.max(1, ...[...rows.values()].map((r) => r.length)) * 232,
    };
  }, [nodes]);

  if (nodes.length === 0) {
    return (
      <div className="empty">No active run. Describe a change in the thread to plan one.</div>
    );
  }

  return (
    <div className="canvas">
      <div style={{ position: "relative", height: layout.height, minWidth: layout.width }}>
        <svg
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: layout.height,
            overflow: "visible",
          }}
        >
          {nodes.flatMap((n) =>
            n.deps.map((dep) => {
              const from = layout.positions.get(dep);
              const to = layout.positions.get(n.id);
              if (!from || !to) return null;
              const x1 = from.x + 105;
              const y1 = from.y + 68;
              const x2 = to.x + 105;
              const y2 = to.y;
              // A blocked node's incoming edge is dashed slate: the reason it
              // is not running is upstream, and the edge is where to look.
              const blocked = n.status === "blocked";
              return (
                <path
                  key={`${dep}->${n.id}`}
                  d={`M ${x1} ${y1} C ${x1} ${y1 + 22}, ${x2} ${y2 - 22}, ${x2} ${y2}`}
                  fill="none"
                  stroke={blocked ? "var(--slate)" : "var(--line-2)"}
                  strokeWidth={1.25}
                  strokeDasharray={blocked ? "3 3" : undefined}
                />
              );
            }),
          )}
        </svg>

        {nodes.map((n) => {
          const p = layout.positions.get(n.id)!;
          return (
            <div
              key={n.id}
              className={`node ${nodeClass(n.status)}${selected === n.id ? " sel" : ""}`}
              style={{ left: p.x, top: p.y }}
              onClick={() => onSelect(n.id)}
            >
              <div className="top">
                <span className="id">{n.id}</span>
                <span className="ttl">{n.title}</span>
              </div>
              <div className="ws">
                {n.dirtyReason
                  ? n.dirtyReason
                  : n.sets.write.length
                    ? `write ▸ ${n.sets.write.join(", ")}`
                    : "read-only"}
              </div>
              <div className="meta">
                <span className={`pill ${pillClass(n.status)}`}>{n.status}</span>
                {n.route && <span>{n.route.model}</span>}
                {n.attempts > 1 && <span>attempt {n.attempts}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The node drawer.
 *
 * The Context tab is the reason this exists. "What did the model actually see"
 * is the first question in any agent debugging session and is normally
 * unanswerable; here it is one click, with the trust boundary visible.
 */
export function NodeDrawer({
  node,
  events,
  tab,
  onTab,
}: {
  node: NodeRow | null;
  events: AcaEvent[];
  tab: DrawerTab;
  onTab: (t: DrawerTab) => void;
}): JSX.Element {
  if (!node) return <div className="empty">Select a node.</div>;

  const forNode = events.filter((e) => e.nodeId === node.id);
  const toolCalls = forNode.filter(
    (e) => e.type === "tool.called" || e.type === "tool.cache_hit",
  );
  const gates = forNode.filter((e) => e.type.startsWith("gate."));
  const guards = forNode.filter((e) => e.type === "guard.fenced");
  const routed = forNode.find((e) => e.type === "node.routed");

  return (
    <>
      <div className="dtabs">
        {(["context", "model", "tools", "gates", "diff"] as DrawerTab[]).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => onTab(t)}>
            {t}
          </button>
        ))}
      </div>

      <div className="pbody">
        {tab === "context" && (
          <div className="ladder">
            <div
              className="dim mono"
              style={{
                fontSize: 10,
                letterSpacing: ".1em",
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              Assembled window
            </div>
            <div className="lr">
              <span className="n">1</span>
              <span className="l">System + persona contract</span>
              <span className="pill p-mute">pinned</span>
            </div>
            <div className="lr">
              <span className="n">2</span>
              <span className="l">Node contract &amp; write set</span>
              <span className="pill p-mute">pinned</span>
            </div>
            <div className="lr">
              <span className="n">4</span>
              <span className="l">Confirmed lessons (T4)</span>
            </div>
            <div className="lr">
              <span className="n">6</span>
              <span className="l">T3 retrieved chunks</span>
            </div>
            {guards.length > 0 && (
              <div className="lr" style={{ background: "var(--crimson-dim)" }}>
                <span className="n">7</span>
                <span className="l" style={{ color: "var(--crimson)" }}>
                  ⚠ Tool results · fenced
                </span>
                <span className="tk">{guards.length}</span>
              </div>
            )}

            <div style={{ marginTop: 14 }}>
              <div
                className="dim mono"
                style={{
                  fontSize: 10,
                  letterSpacing: ".1em",
                  textTransform: "uppercase",
                  marginBottom: 6,
                }}
              >
                Contract
              </div>
              <div style={{ fontSize: 12.5 }}>{node.contract || "(none stated)"}</div>
            </div>

            <p className="dim" style={{ fontSize: 12, marginTop: 14, lineHeight: 1.5 }}>
              Untrusted rows are content a tool returned. They are fenced before the model sees
              them and are data, never instructions.
            </p>
          </div>
        )}

        {tab === "model" && (
          <div>
            <div className="specrow">
              <b>routed to</b>
              <span>{node.route ? `${node.route.provider}/${node.route.model}` : "—"}</span>
            </div>
            <div className="specrow">
              <b>persona</b>
              <span>{node.persona}</span>
            </div>
            <div className="specrow">
              <b>attempts</b>
              <span>{node.attempts}</span>
            </div>
            <div className="specrow">
              <b>review rounds</b>
              <span>{node.reviewRounds}</span>
            </div>
            {routed && (
              <p className="dim" style={{ fontSize: 12, marginTop: 14, lineHeight: 1.5 }}>
                Routing is per node: the persona declares what it needs and the router filters
                on measured capability, not on a model name.
              </p>
            )}
          </div>
        )}

        {tab === "tools" && (
          <div>
            {toolCalls.length === 0 && <div className="empty">No tool calls yet.</div>}
            {toolCalls.map((e) => (
              <div key={e.seq} className="specrow">
                <b>{String(e.payload["tool"] ?? "tool")}</b>
                <span>{e.type === "tool.cache_hit" ? "cache hit" : "executed"}</span>
              </div>
            ))}
          </div>
        )}

        {tab === "gates" && (
          <div>
            {gates.length === 0 && <div className="empty">Gates have not run.</div>}
            {gates.map((e) => (
              <div key={e.seq} className="specrow">
                <b
                  style={{ color: e.type === "gate.passed" ? "var(--moss)" : "var(--crimson)" }}
                >
                  {e.type === "gate.passed" ? "✓" : "✗"} {String(e.payload["gate"])}
                </b>
                <span>{String(e.payload["detail"] ?? "").slice(0, 40) || "—"}</span>
              </div>
            ))}
          </div>
        )}

        {tab === "diff" && (
          <div>
            <div
              className="dim mono"
              style={{
                fontSize: 10,
                letterSpacing: ".1em",
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              Declared write set
            </div>
            {node.sets.write.length === 0 && <div className="empty">Read-only node.</div>}
            {node.sets.write.map((w) => (
              <div key={w} className="specrow">
                <b style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{w}</b>
              </div>
            ))}
            <p className="dim" style={{ fontSize: 12, marginTop: 14, lineHeight: 1.5 }}>
              A write outside this list fails the node — it is enforced, not advisory. Open the
              Diff view for side-by-side review.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
