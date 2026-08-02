import React from "react";

export interface TreeEntry {
  path: string;
  name: string;
  kind: "file" | "dir";
  depth: number;
  git: string | null;
  lockedBy: string | null;
  inWriteSet: boolean;
  indexed: boolean;
}

export interface ModelRow {
  provider: string;
  id: string;
  state: string;
  quantization: string;
  caps: { contextWindow: number; tools: string; structured: string; privacyTier: string };
}

export interface NodeRow {
  id: string;
  title: string;
  status: string;
  deps: string[];
  sets: { read: string[]; write: string[] };
  contract: string;
  attempts: number;
  route: { provider: string; model: string } | null;
}

export function pillClass(status: string): string {
  switch (status) {
    case "done":
      return "p-done";
    case "running":
      return "p-run";
    case "parked":
      return "p-appr";
    case "failed":
    case "rolled_back":
      return "p-fail";
    default:
      return "p-block";
  }
}

export function nodeClass(status: string): string {
  switch (status) {
    case "done":
      return "st-done";
    case "running":
      return "st-run";
    case "parked":
      return "st-appr";
    case "failed":
    case "rolled_back":
      return "st-fail";
    default:
      return "st-block";
  }
}

/**
 * File tree with the agent-state overlay.
 *
 * git status is public knowledge; locks, write sets and index coverage are
 * things only this app knows, and they are what a user needs while a run is
 * touching their working tree.
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
          className={`fr${selected === e.path ? " on" : ""}${e.indexed ? "" : " dim"}`}
          style={{ paddingLeft: 6 + e.depth * 12 }}
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
              title={`locked by ${e.lockedBy}`}
            >
              🔒
            </span>
          )}
          {e.inWriteSet && (
            <span className="tw" style={{ color: "var(--ember)" }} title="in a write set">
              ▶
            </span>
          )}
          {e.git && (
            <span className="tw" style={{ color: "var(--moss)" }} title={`git: ${e.git}`}>
              {e.git}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The DAG canvas.
 *
 * Laid out by dependency depth rather than a force simulation: a plan is small
 * and its shape is meaningful, so a deterministic layout that puts dependents
 * below their dependencies reads better than anything physics-based.
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
  if (nodes.length === 0) {
    return (
      <div className="empty">No active run. Describe a change in the thread to plan one.</div>
    );
  }

  const depth = new Map<string, number>();
  const compute = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
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
    rowNodes.forEach((n, i) => positions.set(n.id, { x: 20 + i * 232, y: 16 + d * 104 }));
  }
  const height = 16 + (Math.max(...depth.values(), 0) + 1) * 104;

  return (
    <div className="canvas">
      <div style={{ position: "relative", height, minWidth: 480 }}>
        <svg
          style={{ position: "absolute", inset: 0, width: "100%", height, overflow: "visible" }}
        >
          {nodes.flatMap((n) =>
            n.deps.map((dep) => {
              const from = positions.get(dep);
              const to = positions.get(n.id);
              if (!from || !to) return null;
              const x1 = from.x + 105;
              const y1 = from.y + 64;
              const x2 = to.x + 105;
              const y2 = to.y;
              return (
                <path
                  key={`${dep}->${n.id}`}
                  d={`M ${x1} ${y1} C ${x1} ${y1 + 20}, ${x2} ${y2 - 20}, ${x2} ${y2}`}
                  fill="none"
                  stroke="var(--line-2)"
                  strokeWidth={1.25}
                />
              );
            }),
          )}
        </svg>

        {nodes.map((n) => {
          const p = positions.get(n.id)!;
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
                {n.sets.write.length ? `write ▸ ${n.sets.write.join(", ")}` : "read-only"}
              </div>
              <div className="meta">
                <span className={`pill ${pillClass(n.status)}`}>{n.status}</span>
                {n.route && <span>{n.route.model}</span>}
                {n.attempts > 0 && <span>attempt {n.attempts}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ModelTable({ models }: { models: ModelRow[] }): JSX.Element {
  if (models.length === 0) return <div className="empty">No models discovered.</div>;
  return (
    <table className="dt">
      <thead>
        <tr>
          <th>Model</th>
          <th>Provider</th>
          <th>State</th>
          <th>Ctx</th>
          <th>Quant</th>
          <th>Tools</th>
          <th>Structured</th>
        </tr>
      </thead>
      <tbody>
        {models.map((m) => (
          <tr key={`${m.provider}/${m.id}`}>
            <td className="name">{m.id}</td>
            <td>{m.provider}</td>
            <td>
              <span className={`pill ${m.state === "resident" ? "p-run" : "p-block"}`}>
                {m.state}
              </span>
            </td>
            <td>{Math.round(m.caps.contextWindow / 1024)}k</td>
            <td>{m.quantization || "—"}</td>
            <td style={{ color: m.caps.tools === "native" ? "var(--moss)" : "var(--wheat)" }}>
              {m.caps.tools}
            </td>
            <td>{m.caps.structured}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function EventTimeline({
  events,
  onScrub,
  position,
}: {
  events: { seq?: number; type: string; nodeId: string | null; ts: number }[];
  onScrub: (seq: number) => void;
  position: number;
}): JSX.Element {
  if (events.length === 0) return <div className="empty">No events yet.</div>;
  const last = events.at(-1)?.seq ?? 0;

  return (
    <div style={{ padding: 12 }}>
      <input
        type="range"
        min={0}
        max={last}
        value={position}
        onChange={(e) => onScrub(Number(e.target.value))}
        style={{ width: "100%" }}
      />
      <div className="mono dim" style={{ fontSize: 10.5, marginBottom: 12 }}>
        seq {position} of {last} — state is a fold to this point
      </div>
      {events
        .filter((e) => (e.seq ?? 0) <= position)
        .slice(-40)
        .map((e) => (
          <div
            key={e.seq}
            style={{ display: "flex", gap: 12, padding: "3px 0", fontSize: 11 }}
            className="mono"
          >
            <span className="dim">{String(e.seq).padStart(4)}</span>
            <span className="dim" style={{ width: 120 }}>
              {e.nodeId ?? "—"}
            </span>
            <span style={{ color: eventColor(e.type) }}>{e.type}</span>
          </div>
        ))}
    </div>
  );
}

function eventColor(type: string): string {
  if (type.includes("fail") || type.includes("rolled") || type.startsWith("guard")) {
    return "var(--crimson)";
  }
  if (type.includes("done") || type.includes("passed") || type.includes("approved")) {
    return "var(--moss)";
  }
  if (type.includes("approval") || type.includes("parked")) return "var(--wheat)";
  if (type.includes("start") || type.includes("routed") || type.includes("called")) {
    return "var(--ember)";
  }
  return "var(--ink-2)";
}
