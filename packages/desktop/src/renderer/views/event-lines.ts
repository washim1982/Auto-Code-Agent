import type { AcaEvent } from "./shared.ts";

/**
 * One event, one line of plain English.
 *
 * A run used to be silent from the moment it was approved: planning took three
 * minutes and the thread showed nothing, so the only signal that anything was
 * happening was the composer placeholder. Every event needed to say so was
 * already arriving over `run.subscribe` — it just went to the timeline, which
 * is not where anyone is looking while they wait.
 *
 * Returning `null` is how an event opts out. Most of the log is bookkeeping —
 * locks, checkpoints, epoch bumps — and narrating it would bury the four or
 * five lines that actually tell someone what the agent is doing.
 */

export type ProgressTone = "normal" | "good" | "warn" | "bad";

export interface ProgressLine {
  id: string;
  text: string;
  tone: ProgressTone;
  detail?: ToolProgressDetail;
}

export type ToolProgressStatus = "running" | "completed" | "failed" | "cached";

/** Data shown when a live backend step is expanded in the conversation. */
export interface ToolProgressDetail {
  tool: string;
  status: ToolProgressStatus;
  command: string;
  input: string;
  code: string;
  codePath: string;
  output: string;
  inputTruncated: boolean;
  codeTruncated: boolean;
  outputTruncated: boolean;
  bytes: number;
  durationMs: number;
  writes: string[];
  artifactId: string;
}

const str = (v: unknown, fallback = ""): string => (v == null ? fallback : String(v));
const num = (v: unknown, fallback = 0): number => (v == null ? fallback : Number(v));

/** Trims a failure reason to something that fits on one line. */
function short(reason: string, max = 120): string {
  const firstLine = reason.split("\n")[0] ?? "";
  const cleaned = firstLine.replace(/^Error:\s*/, "").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function describeEvent(e: AcaEvent): { text: string; tone: ProgressTone } | null {
  const p = e.payload ?? {};
  const node = e.nodeId ? `${e.nodeId}: ` : "";

  switch (e.type) {
    // ---------------------------------------------------------------- run
    case "run.created":
      return { text: `Planning — ${short(str(p["goal"]), 80)}`, tone: "normal" };
    case "plan.proposed":
      return { text: `Plan ready · ${num(p["nodes"])} nodes · ${str(p["model"])}`, tone: "good" };
    case "plan.approved":
      return { text: "Plan approved", tone: "normal" };
    case "plan.rejected":
      return { text: "Plan rejected — replanning", tone: "warn" };
    case "run.started":
      return { text: `Running ${num(p["nodes"])} nodes`, tone: "normal" };
    case "run.paused":
      return { text: `Paused — ${str(p["reason"], "no reason given")}`, tone: "warn" };
    case "run.completed":
      return { text: "Run complete", tone: "good" };
    case "run.failed":
      return { text: `Run failed — ${short(str(p["reason"]))}`, tone: "bad" };
    case "run.cancelled":
      return { text: "Run cancelled", tone: "warn" };

    // --------------------------------------------------------------- node
    case "node.started": {
      const attempt = num(p["attempt"], 1);
      return {
        text: `${node}starting${attempt > 1 ? ` (attempt ${attempt})` : ""}`,
        tone: "normal",
      };
    }
    case "node.routed":
      return { text: `${node}using ${str(p["model"])}`, tone: "normal" };
    case "node.retried":
      return { text: `${node}retrying — attempt ${num(p["attempts"]) + 1}`, tone: "warn" };
    case "node.done":
      return { text: `${node}done`, tone: "good" };
    case "node.failed":
      return { text: `${node}failed — ${short(str(p["reason"]))}`, tone: "bad" };
    case "node.rolled_back":
      // Emitted twice, once with a reason and once without; the bare one is a
      // duplicate of a line already shown.
      return p["reason"] ? { text: `${node}rolled back`, tone: "bad" } : null;
    case "node.parked":
      return { text: `${node}waiting for you`, tone: "warn" };
    case "node.blocked":
      return { text: `${node}blocked`, tone: "warn" };
    case "node.steps_low":
      return {
        text: `${node}${num(p["remaining"])} steps left — asking for the writes now`,
        tone: "warn",
      };

    // --------------------------------------------------------------- work
    case "tool.called":
      return { text: `${node}${str(p["tool"])}`, tone: "normal" };
    case "tool.cache_hit":
      return { text: `${node}${str(p["tool"])} (cached)`, tone: "normal" };
    case "tool.result":
      return {
        text: `${node}${str(p["tool"])} ${p["isError"] ? "failed" : "finished"}`,
        tone: p["isError"] ? "bad" : "normal",
      };
    case "tool.exhausted":
      return {
        text: `${node}${str(p["tool"])} found nothing ${num(p["streak"])}× — moving on`,
        tone: "warn",
      };
    case "model.truncated":
      return { text: `${node}reply hit the output limit — asking again`, tone: "warn" };

    // -------------------------------------------------------------- gates
    case "gate.passed":
      return { text: `${node}gate ${str(p["gate"])} passed`, tone: "good" };
    case "gate.failed":
      return { text: `${node}gate ${str(p["gate"])} failed`, tone: "bad" };
    case "review.requested":
      return { text: `${node}under review`, tone: "normal" };
    case "review.approved":
      return { text: `${node}review passed`, tone: "good" };
    case "review.rejected":
      return { text: `${node}review rejected — ${short(str(p["reason"]))}`, tone: "warn" };

    // ----------------------------------------------------------- approval
    case "approval.requested":
      return { text: `Waiting for your approval`, tone: "warn" };
    case "approval.granted":
      return { text: "Approved", tone: "good" };
    case "approval.denied":
      return { text: "Denied", tone: "warn" };

    // ------------------------------------------------------------ budget
    case "budget.warning":
      return { text: `Budget warning — ${short(str(p["detail"]))}`, tone: "warn" };
    case "budget.exceeded":
      return { text: "Budget exceeded", tone: "bad" };

    // Bookkeeping: locks, checkpoints, epochs, fencing, per-response usage.
    // Real but not worth a line — narrating them buries the ones that matter.
    default:
      return null;
  }
}

/**
 * The tail of a run, as lines.
 *
 * Only the most recent few: this sits under a live conversation, and the point
 * is to answer "is anything happening", not to reproduce the timeline.
 */
export function progressLines(
  events: readonly AcaEvent[],
  options: { runId?: string | null; limit?: number } = {},
): ProgressLine[] {
  const limit = options.limit ?? 6;
  const lines: ProgressLine[] = [];
  const toolsByCall = new Map<string, number>();

  for (const e of events) {
    if (options.runId && e.runId !== options.runId) continue;

    if (e.type === "tool.called" || e.type === "tool.cache_hit") {
      const described = describeEvent(e);
      if (!described) continue;
      const callId = str(e.payload["callId"]);
      const line: ProgressLine = {
        id: callId ? `tool-${callId}` : `${e.seq ?? lines.length}-${e.type}`,
        text: described.text,
        tone: described.tone,
        detail: toolDetail(
          e.payload,
          e.type === "tool.cache_hit" ? "cached" : "running",
        ),
      };
      lines.push(line);
      if (callId) toolsByCall.set(callId, lines.length - 1);
      continue;
    }

    // Results update the row that started the call rather than adding a second
    // line. While the tool is awaiting I/O the row says "running"; the same row
    // gains output and duration as soon as the backend event arrives.
    if (e.type === "tool.result") {
      const callId = str(e.payload["callId"]);
      const at = callId ? toolsByCall.get(callId) : undefined;
      const failed = e.payload["isError"] === true;
      const cached = e.payload["cached"] === true;
      const status: ToolProgressStatus = failed ? "failed" : cached ? "cached" : "completed";

      if (at !== undefined) {
        const current = lines[at]!;
        const result = toolDetail(e.payload, status);
        current.detail = {
          ...current.detail!,
          status,
          output: result.output,
          outputTruncated: result.outputTruncated,
          bytes: result.bytes,
          durationMs: result.durationMs,
          writes: result.writes,
          artifactId: result.artifactId,
        };
        if (failed) current.tone = "bad";
        continue;
      }

      const described = describeEvent(e);
      if (!described) continue;
      lines.push({
        id: callId ? `tool-${callId}` : `${e.seq ?? lines.length}-${e.type}`,
        text: described.text,
        tone: described.tone,
        detail: toolDetail(e.payload, status),
      });
      continue;
    }

    const described = describeEvent(e);
    if (!described) continue;
    lines.push({
      id: `${e.seq ?? lines.length}-${e.type}`,
      text: described.text,
      tone: described.tone,
    });
  }

  return lines.slice(-limit);
}

function toolDetail(
  payload: Record<string, unknown>,
  status: ToolProgressStatus,
): ToolProgressDetail {
  return {
    tool: str(payload["tool"]),
    status,
    command: str(payload["command"]),
    input: str(payload["input"]),
    code: str(payload["code"]),
    codePath: str(payload["codePath"]),
    output: str(payload["output"]),
    inputTruncated: payload["inputTruncated"] === true,
    codeTruncated: payload["codeTruncated"] === true,
    outputTruncated: payload["outputTruncated"] === true,
    bytes: num(payload["bytes"]),
    durationMs: num(payload["durationMs"]),
    writes: Array.isArray(payload["writes"]) ? payload["writes"].map(String) : [],
    artifactId: str(payload["artifactId"]),
  };
}

/** True while the run has started and nothing has ended it. */
export function runIsActive(events: readonly AcaEvent[], runId?: string | null): boolean {
  let active = false;
  for (const e of events) {
    if (runId && e.runId !== runId) continue;
    if (e.type === "run.created" || e.type === "run.started") active = true;
    if (
      e.type === "run.completed" ||
      e.type === "run.failed" ||
      e.type === "run.cancelled" ||
      e.type === "run.paused"
    ) {
      active = false;
    }
    // A proposed plan is a question for the user, not work in progress.
    if (e.type === "plan.proposed") active = false;
    if (e.type === "plan.approved") active = true;
  }
  return active;
}
