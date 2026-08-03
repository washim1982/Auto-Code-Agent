import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { PlanNode } from "@aca/protocol";
import {
  ApprovalPrompt,
  DagPanel,
  INK,
  RAMP,
  StageList,
  StatusStrip,
  Turn,
  type NodeMeta,
  type Stage,
} from "./components.tsx";

export type View = "thread" | "graph";
export type Focus = "input" | "graph" | "node";
/** What the node drawer is showing — the `d`/`l`/`v` keys in the spec. */
export type Drawer = "contract" | "diff" | "log";

export interface ThreadEntry {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  model?: string;
  thinking?: string;
}

export interface PendingApproval {
  id: string;
  summary: string;
  detail: string;
  irreversible: boolean;
}

export interface AppState {
  workspace: string;
  model: string;
  thread: ThreadEntry[];
  stages: Stage[];
  nodes: PlanNode[];
  nodeMeta: Record<string, NodeMeta>;
  nodeDiffs: Record<string, string>;
  nodeLogs: Record<string, string>;
  approval: PendingApproval | null;
  tokens: number;
  costUsd: number;
  startedAt: number;
  busy: boolean;
  /** Streaming text for the turn in flight, rendered before it is committed. */
  streaming: string | null;
  notice: string | null;
}

export interface AppCallbacks {
  onSubmit(input: string): void;
  onApproval(id: string, granted: boolean, scope: "once" | "run"): void;
  onCancel(): void;
}

/**
 * The interactive TUI from docs/06-ui-design.md.
 *
 * Two representations of one session — `thread` and `graph` — swapped by a
 * toggle rather than being separate modes, because a run is something a
 * conversation escalates into, not a different application.
 */
export function App({
  state,
  callbacks,
}: {
  state: AppState;
  callbacks: AppCallbacks;
}): JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 96;

  const [view, setView] = useState<View>("thread");
  const [focus, setFocus] = useState<Focus>("input");
  const [input, setInput] = useState("");
  const [showThinking, setShowThinking] = useState(false);
  const [selected, setSelected] = useState(0);
  const [drawer, setDrawer] = useState<Drawer>("contract");
  const [showHelp, setShowHelp] = useState(false);
  const [showPlan, setShowPlan] = useState(false);

  // Elapsed times tick while nodes run, so the panel is not frozen between
  // events — a node that takes 90s would otherwise look stuck at 0s.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!state.busy) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [state.busy]);

  // A run appearing should pull the user to the graph once, but never fight
  // them if they deliberately switched back.
  const [autoSwitched, setAutoSwitched] = useState(false);
  useEffect(() => {
    if (state.nodes.length > 0 && !autoSwitched) {
      setView("graph");
      setAutoSwitched(true);
    }
  }, [state.nodes.length, autoSwitched]);

  const focusedNode = useMemo(
    () =>
      state.nodes.length > 0 ? state.nodes[Math.min(selected, state.nodes.length - 1)] : null,
    [state.nodes, selected],
  );

  const submit = useCallback(() => {
    const value = input.trim();
    if (!value) return;
    setInput("");
    callbacks.onSubmit(value);
  }, [input, callbacks]);

  useInput((char, key) => {
    // An approval takes over the keyboard entirely: it is the one thing a user
    // must not be able to type past by accident.
    if (state.approval) {
      if (char === "a") callbacks.onApproval(state.approval.id, true, "once");
      else if (char === "A") callbacks.onApproval(state.approval.id, true, "run");
      else if (char === "r") callbacks.onApproval(state.approval.id, false, "once");
      return;
    }

    if (key.escape) {
      if (state.busy) callbacks.onCancel();
      else exit();
      return;
    }

    if (key.tab) {
      setFocus((f) => (f === "input" ? "graph" : f === "graph" ? "node" : "input"));
      return;
    }

    if (focus === "input") {
      if (key.return) submit();
      else if (key.backspace || key.delete) setInput((s) => s.slice(0, -1));
      else if (char && !key.ctrl && !key.meta) setInput((s) => s + char);
      return;
    }

    // Navigation keys only bite once focus has left the composer, so typing
    // "graph" into a message does not switch views.
    if (char === "g") setView("graph");
    else if (char === "t") setView("thread");
    else if (char === "T") setShowThinking((s) => !s);
    else if (char === "?") setShowHelp((s) => !s);
    else if (char === "v") setShowPlan((s) => !s);
    // The drawer tabs from the spec. Pressing the same key again closes it,
    // so one key both opens and dismisses.
    else if (char === "d") setDrawer((d) => (d === "diff" ? "contract" : "diff"));
    else if (char === "l") setDrawer((d) => (d === "log" ? "contract" : "log"));
    else if (key.downArrow || char === "j") {
      setSelected((i) => Math.min(i + 1, Math.max(0, state.nodes.length - 1)));
    } else if (key.upArrow || char === "k") setSelected((i) => Math.max(0, i - 1));
  });

  return (
    <Box flexDirection="column" width={width}>
      <Box>
        <Text color={INK.dim}>workspace </Text>
        <Text bold>{state.workspace}</Text>
        <Text color={INK.dim}> model </Text>
        <Text bold>{state.model}</Text>
        <Box flexGrow={1} />
        <Text color={view === "thread" ? INK.ember : INK.dim}>thread</Text>
        <Text color={INK.dim}> | </Text>
        <Text color={view === "graph" ? INK.ember : INK.dim}>graph</Text>
      </Box>

      <Box marginY={1} flexDirection="column">
        {view === "thread" ? (
          <Box flexDirection="column">
            {state.thread.slice(-12).map((t) => (
              <Turn
                key={t.id}
                role={t.role}
                content={t.content}
                {...(t.model ? { model: t.model } : {})}
                {...(t.thinking ? { thinking: t.thinking } : {})}
                showThinking={showThinking}
              />
            ))}
            {state.streaming !== null && (
              <Turn
                role="assistant"
                content={state.streaming || "…"}
                model={state.model}
                showThinking={showThinking}
              />
            )}
            {state.thread.length === 0 && state.streaming === null && (
              <Text color={INK.dim}>Ask a question, or describe a change to plan.</Text>
            )}
            {state.stages.length > 0 && (
              <Box marginTop={1}>
                <StageList stages={state.stages} />
              </Box>
            )}
          </Box>
        ) : (
          <Box flexDirection="column">
            {state.stages.length > 0 && (
              <Box marginBottom={1}>
                <StageList stages={state.stages} />
              </Box>
            )}
            {state.nodes.length > 0 ? (
              <DagPanel
                nodes={state.nodes}
                meta={state.nodeMeta}
                width={width}
                focusedId={focus === "node" ? (focusedNode?.id ?? null) : null}
              />
            ) : (
              <Text color={INK.dim}>No active run. Describe a change to plan one.</Text>
            )}
            {focus === "node" && focusedNode && (
              <NodeDrawer
                node={focusedNode}
                tab={drawer}
                diff={state.nodeDiffs[focusedNode.id] ?? ""}
                log={state.nodeLogs[focusedNode.id] ?? ""}
                meta={state.nodeMeta[focusedNode.id] ?? {}}
              />
            )}
          </Box>
        )}
      </Box>

      {state.approval && (
        <Box marginBottom={1}>
          <ApprovalPrompt
            summary={state.approval.summary}
            detail={state.approval.detail}
            irreversible={state.approval.irreversible}
          />
        </Box>
      )}

      {showPlan && state.nodes.length > 0 && (
        <Box marginBottom={1} flexDirection="column" paddingLeft={2}>
          <Text color={INK.dim}>plan detail</Text>
          {state.nodes.map((n) => (
            <Text key={n.id} color={INK.dim}>
              {n.id} <Text color={INK.text}>{n.title}</Text> · {n.persona} · reads{" "}
              {n.sets.read.length} · writes {n.sets.write.join(", ") || "none"}
            </Text>
          ))}
        </Box>
      )}

      {showHelp && (
        <Box marginBottom={1} flexDirection="column" paddingLeft={2}>
          <Text color={INK.dim}>keys</Text>
          <Text color={INK.dim}>
            tab focus · g graph · t thread · v plan detail · d diff · l model log
          </Text>
          <Text color={INK.dim}>
            T thinking · ↑↓ node · a/A/r approve, approve-for-run, reject · esc cancel · ? help
          </Text>
          <Text color={INK.dim}>/model /index /lessons /help</Text>
        </Box>
      )}

      {state.notice && (
        <Box marginBottom={1}>
          <Text color={RAMP.approval}>{state.notice}</Text>
        </Box>
      )}

      <Box>
        <Text color={focus === "input" ? INK.ember : INK.dim}>› </Text>
        <Text>{input}</Text>
        {focus === "input" && <Text color={INK.ember}>▌</Text>}
        {state.busy && !input && <Text color={INK.dim}>working…</Text>}
      </Box>

      <Box marginTop={1}>
        <StatusStrip
          workspace={state.workspace}
          model={state.model}
          tokens={state.tokens}
          costUsd={state.costUsd}
          elapsedMs={Date.now() - state.startedAt}
          hint={
            focus === "input"
              ? "tab focus · esc cancel · ? help"
              : "g graph · t thread · v plan · d diff · l log · ↑↓ node · ? help"
          }
        />
      </Box>
    </Box>
  );
}

/**
 * The focused node's detail, one tab at a time.
 *
 * Matches the drawer in the desktop app rather than inventing a second
 * vocabulary: the same four questions get asked of a node wherever you are —
 * what it promised, what it changed, and what the model actually said.
 */
function NodeDrawer({
  node,
  tab,
  diff,
  log,
  meta,
}: {
  node: PlanNode;
  tab: Drawer;
  diff: string;
  log: string;
  meta: NodeMeta;
}): JSX.Element {
  return (
    <Box marginTop={1} flexDirection="column" paddingLeft={2}>
      <Box>
        <Text color={INK.dim}>{node.id} </Text>
        <Text color={tab === "contract" ? INK.ember : INK.dim}>contract</Text>
        <Text color={INK.dim}> · </Text>
        <Text color={tab === "diff" ? INK.ember : INK.dim}>diff</Text>
        <Text color={INK.dim}> · </Text>
        <Text color={tab === "log" ? INK.ember : INK.dim}>log</Text>
        {meta.model && <Text color={INK.dim}> · {meta.model}</Text>}
      </Box>

      {tab === "contract" && (
        <Box flexDirection="column">
          <Text>{node.contract || "(none stated)"}</Text>
          <Text color={INK.dim}>reads: {node.sets.read.join(", ") || "—"}</Text>
          <Text color={INK.dim}>writes: {node.sets.write.join(", ") || "—"}</Text>
        </Box>
      )}

      {tab === "diff" && (
        <Text color={INK.dim}>
          {diff || (node.status === "done" ? "no changes recorded" : "not run yet")}
        </Text>
      )}

      {tab === "log" && (
        <Text color={INK.dim}>{log || "nothing logged for this node yet"}</Text>
      )}
    </Box>
  );
}
