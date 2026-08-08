import type { PlanNode } from "@aca/protocol";
import { c, cell, rule, stateGlyph, stateOf } from "./theme.ts";

/**
 * The DAG panel from docs/06-ui-design.md.
 *
 * Columns: glyph 2 | title flex | state 10 | model 16 | elapsed 7 right.
 * Below 80 columns the model column is dropped first, then elapsed — the node
 * identity and its state are the last things to go.
 */
export function renderDag(
  nodes: readonly PlanNode[],
  meta: Record<string, { model?: string; elapsedMs?: number; detail?: string }> = {},
  width = process.stdout.columns ?? 96,
): string {
  const showModel = width >= 88;
  const showElapsed = width >= 80;
  const titleWidth = Math.max(
    18,
    width - 2 - 12 - (showModel ? 17 : 0) - (showElapsed ? 8 : 0) - 4,
  );

  const running = nodes.filter((n) => n.status === "running").length;
  const blocked = nodes.filter((n) => n.status === "blocked" || n.status === "parked").length;

  const head =
    c.dim("plan graph") +
    "  " +
    c.dim(`${nodes.length} nodes · ${running} running · ${blocked} blocked`);

  const lines = nodes.map((n) => {
    const state = stateOf(n.status);
    const m = meta[n.id] ?? {};
    const parts = [
      stateGlyph(state),
      cell(`${c.dim(n.id)} ${n.title}`, titleWidth),
      cell(labelFor(n), 11),
    ];
    if (showModel) parts.push(cell(c.dim(m.model ?? "—"), 17));
    if (showElapsed) parts.push(cell(c.dim(fmtMs(m.elapsedMs)), 7, "right"));

    const row = ` ${parts.join(" ")}`;
    const sub = subLine(n, m.detail);
    return sub ? `${row}\n${sub}` : row;
  });

  return [head, rule(Math.min(width - 2, 96)), ...lines].join("\n");
}

function labelFor(n: PlanNode): string {
  const state = stateOf(n.status);
  if (n.status === "failed" && n.attempts > 0) {
    return c.crimson(`retry ${n.attempts}`);
  }
  const text =
    n.status === "parked" ? "approval" : n.status === "rolled_back" ? "rolled back" : n.status;
  return {
    queued: c.slate,
    done: c.moss,
    approval: c.wheat,
    running: c.ember,
    failed: c.crimson,
  }[state](text);
}

/** The indented sub-line: write set, lock holder, or failure reason. */
function subLine(n: PlanNode, detail?: string): string | null {
  if (detail) return `   ${c.dim("└")} ${c.dim(detail)}`;
  if (n.dirtyReason) return `   ${c.dim("└")} ${c.crimson(n.dirtyReason)}`;
  if (n.status === "blocked")
    return `   ${c.dim("└")} ${c.slate("🔒 write set held by a sibling")}`;
  if (n.sets.write.length > 0) {
    const label = n.writePolicy === "optional" ? "optional write" : "write";
    return `   ${c.dim("└")} ${c.dim(`${label} ▸ ${n.sets.write.join(", ")}`)}`;
  }
  return null;
}

function fmtMs(ms?: number): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Header shown when a chat session opens: workspace, model, affordances. */
export function renderSessionHeader(info: {
  workspace: string;
  root: string;
  branch?: string;
  indexed?: string;
  model: string;
  provider: string;
  state: string;
  tools: string;
  privacy: string;
}): string {
  return [
    `${c.dim("workspace")} ${c.bold(info.workspace)}  ${c.dim(
      [info.root, info.branch, info.indexed].filter(Boolean).join(" · "),
    )}`,
    `${c.dim("model")}     ${c.bold(info.model)}  ${c.dim(
      [info.provider, info.state, `tools ${info.tools}`, info.privacy].join(" · "),
    )}`,
    c.dim("/model to switch · /ws to change workspace · @path to attach · /plan to escalate"),
  ].join("\n");
}

/** The wheat-bordered approval block. Never quiet, never skippable. */
export function renderApproval(a: {
  nodeId: string | null;
  summary: string;
  detail: string;
  irreversible: boolean;
}): string {
  const w = Math.min((process.stdout.columns ?? 96) - 2, 92);
  const top = c.wheat(
    `┌─ ⚠ approval required${a.nodeId ? ` — node ${a.nodeId}` : ""} `.padEnd(w, "─") + "┐",
  );
  const bottom = c.wheat("└" + "─".repeat(w) + "┘");
  const body = [
    `  ${c.bold(a.summary)}`,
    a.irreversible ? `  ${c.crimson("irreversible — rollback cannot undo this")}` : "",
    `  ${c.dim(a.detail)}`,
    "",
    `  ${c.wheat("[a]")} approve once   ${c.wheat("[A]")} approve for run   ${c.crimson("[r]")} reject`,
  ]
    .filter(Boolean)
    .map((l) => c.wheat("│") + l.padEnd(w + l.length - stripLen(l)) + c.wheat("│"));

  return [top, ...body, bottom].join("\n");
}

function stripLen(s: string): number {
  return s.replace(/\[[0-9;]*m/g, "").length;
}

/** Model list grouped by residency — the cost you actually care about. */
export function renderModelTable(
  models: {
    provider: string;
    id: string;
    state: string;
    caps: { contextWindow: number; tools: string; structured: string; privacyTier: string };
    quantization: string;
  }[],
): string {
  const rows = models.map((m) => {
    const state =
      m.state === "resident"
        ? c.ember("resident")
        : m.state === "cold"
          ? c.slate("cold")
          : c.crimson(m.state);
    return [
      " ",
      cell(c.dim(m.provider), 10),
      cell(m.id, 36),
      cell(state, 10),
      cell(c.dim(fmtCtx(m.caps.contextWindow)), 8, "right"),
      cell(c.dim(m.quantization || "—"), 9),
      cell(m.caps.tools === "native" ? c.moss("native") : c.wheat(m.caps.tools), 8),
      cell(c.dim(m.caps.structured), 12),
    ].join(" ");
  });

  const header = [
    " ",
    cell(c.dim("PROVIDER"), 10),
    cell(c.dim("MODEL"), 36),
    cell(c.dim("STATE"), 10),
    cell(c.dim("CTX"), 8, "right"),
    cell(c.dim("QUANT"), 9),
    cell(c.dim("TOOLS"), 8),
    cell(c.dim("STRUCTURED"), 12),
  ].join(" ");

  return [header, rule(104), ...rows].join("\n");
}

function fmtCtx(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1024)}k` : String(n);
}
