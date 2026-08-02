import React from "react";
import { Box, Text } from "ink";
import type { PlanNode } from "@aca/protocol";
import { GLYPH, stateOf, type StateKey } from "../theme.ts";

/**
 * Ink colours for the heat ramp in docs/06-ui-design.md.
 *
 * Ink takes named or hex colours rather than our ANSI helpers, so the ramp is
 * restated here as hex. Same five values, same meanings.
 */
export const RAMP: Record<StateKey, string> = {
  queued: "#6B7C8C",
  done: "#7FA05F",
  approval: "#D9B24C",
  running: "#E07B45",
  failed: "#D1525F",
};

export const INK = { dim: "#6E747C", ember: "#E07B45", text: "#E4E2DE" } as const;

export function StatusChip({ state, label }: { state: StateKey; label?: string }): JSX.Element {
  return (
    <Text color={RAMP[state]}>
      {GLYPH[state]}
      {label ? ` ${label}` : ""}
    </Text>
  );
}

export interface NodeMeta {
  model?: string;
  elapsedMs?: number;
  detail?: string;
}

/**
 * The DAG panel. Columns collapse as the terminal narrows, but the node's
 * identity and state are the last things to go — they are what the panel is
 * for.
 */
export function DagPanel({
  nodes,
  meta = {},
  width,
  focusedId,
}: {
  nodes: readonly PlanNode[];
  meta?: Record<string, NodeMeta>;
  width: number;
  focusedId?: string | null;
}): JSX.Element {
  const showModel = width >= 88;
  const showElapsed = width >= 80;
  const running = nodes.filter((n) => n.status === "running").length;
  const blocked = nodes.filter((n) => n.status === "blocked" || n.status === "parked").length;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={INK.dim}>plan graph </Text>
        <Text color={INK.dim}>
          {nodes.length} nodes · {running} running · {blocked} blocked
        </Text>
      </Box>
      <Text color={INK.dim}>{"─".repeat(Math.min(width - 2, 92))}</Text>

      {nodes.map((node) => {
        const state = stateOf(node.status);
        const m = meta[node.id] ?? {};
        const focused = focusedId === node.id;
        const sub = subLine(node, m.detail);

        return (
          <Box key={node.id} flexDirection="column">
            <Box>
              <Text color={RAMP[state]}>{focused ? "▸" : " "}</Text>
              <Text color={RAMP[state]}> {GLYPH[state]} </Text>
              <Box width={showModel ? 34 : 44}>
                <Text bold={focused} wrap="truncate-end">
                  <Text color={INK.dim}>{node.id}</Text> {node.title}
                </Text>
              </Box>
              <Box width={12}>
                <Text color={RAMP[state]} wrap="truncate-end">
                  {statusLabel(node)}
                </Text>
              </Box>
              {showModel && (
                <Box width={17}>
                  <Text color={INK.dim} wrap="truncate-end">
                    {m.model ?? "—"}
                  </Text>
                </Box>
              )}
              {showElapsed && (
                <Box width={7} justifyContent="flex-end">
                  <Text color={INK.dim}>{fmtMs(m.elapsedMs)}</Text>
                </Box>
              )}
            </Box>
            {sub && (
              <Box>
                <Text color={INK.dim}>{"   └ "}</Text>
                <Text color={sub.color} wrap="truncate-end">
                  {sub.text}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function statusLabel(n: PlanNode): string {
  if (n.status === "failed" && n.attempts > 0) return `retry ${n.attempts}`;
  if (n.status === "parked") return "approval";
  if (n.status === "rolled_back") return "rolled back";
  return n.status;
}

function subLine(n: PlanNode, detail?: string): { text: string; color: string } | null {
  if (detail) return { text: detail, color: INK.dim };
  if (n.dirtyReason) return { text: n.dirtyReason, color: RAMP.failed };
  if (n.status === "blocked")
    return { text: "write set held by a sibling", color: RAMP.queued };
  if (n.sets.write.length > 0) {
    return { text: `write ▸ ${n.sets.write.join(", ")}`, color: INK.dim };
  }
  return null;
}

function fmtMs(ms?: number): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Wheat-bordered and unmissable — the one thing a user must not scroll past. */
export function ApprovalPrompt({
  summary,
  detail,
  irreversible,
}: {
  summary: string;
  detail: string;
  irreversible: boolean;
}): JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={RAMP.approval} paddingX={1}>
      <Text color={RAMP.approval}>⚠ approval required</Text>
      <Text bold>{summary}</Text>
      {irreversible && (
        <Text color={RAMP.failed}>irreversible — rollback cannot undo this</Text>
      )}
      {detail ? <Text color={INK.dim}>{detail}</Text> : null}
      <Box marginTop={1}>
        <Text color={RAMP.approval}>[a]</Text>
        <Text> approve once </Text>
        <Text color={RAMP.approval}>[A]</Text>
        <Text> approve for run </Text>
        <Text color={RAMP.failed}>[r]</Text>
        <Text> reject</Text>
      </Box>
    </Box>
  );
}

export function StatusStrip({
  workspace,
  model,
  tokens,
  costUsd,
  elapsedMs,
  hint,
}: {
  workspace: string;
  model: string;
  tokens: number;
  costUsd: number;
  elapsedMs: number;
  hint: string;
}): JSX.Element {
  return (
    <Box>
      <Text color={INK.dim}>{workspace}</Text>
      <Text color={INK.dim}> · </Text>
      <Text color={INK.dim}>{model}</Text>
      <Text color={INK.dim}> · </Text>
      <Text color={INK.text}>{tokens.toLocaleString()}</Text>
      <Text color={INK.dim}> tok · </Text>
      <Text color={INK.text}>${costUsd.toFixed(4)}</Text>
      <Text color={INK.dim}> · {(elapsedMs / 1000).toFixed(0)}s</Text>
      <Box flexGrow={1} />
      <Text color={INK.dim}>{hint}</Text>
    </Box>
  );
}

/** Thinking is collapsed by default: on reasoning models it dwarfs the answer. */
export function Turn({
  role,
  content,
  model,
  thinking,
  showThinking,
}: {
  role: "user" | "assistant" | "tool";
  content: string;
  model?: string;
  thinking?: string;
  showThinking?: boolean;
}): JSX.Element {
  const badge = role === "user" ? "YOU" : role === "tool" ? "TOOL" : (model ?? "AI");
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={role === "user" ? INK.dim : INK.ember}>{badge}</Text>
        {thinking && !showThinking ? (
          <Text color={INK.dim}> · {Math.ceil(thinking.length / 4)} thinking tokens (t)</Text>
        ) : null}
      </Box>
      {thinking && showThinking ? (
        <Box
          paddingLeft={1}
          borderStyle="single"
          borderColor={RAMP.queued}
          borderTop={false}
          borderRight={false}
          borderBottom={false}
        >
          <Text color={INK.dim}>{thinking}</Text>
        </Box>
      ) : null}
      <Text>{content}</Text>
    </Box>
  );
}
