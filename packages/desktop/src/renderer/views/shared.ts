export interface TreeEntry {
  path: string;
  name: string;
  kind: "file" | "dir";
  depth: number;
  git: string | null;
  lockedBy: string | null;
  inWriteSet: boolean;
  indexed: boolean;
  sizeBytes: number;
}

export interface ModelRow {
  provider: string;
  id: string;
  state: string;
  quantization: string;
  sizeBytes: number;
  caps: {
    contextWindow: number;
    tools: string;
    structured: string;
    privacyTier: string;
    concurrency: number;
  };
}

export interface Scorecard {
  provider: string;
  model: string;
  probedAt: number;
  tools: string;
  structured: string;
  realContext: number;
  tokPerSec: number;
  reliability: number;
}

export interface NodeRow {
  id: string;
  title: string;
  status: string;
  persona: string;
  deps: string[];
  sets: { read: string[]; write: string[] };
  contract: string;
  attempts: number;
  reviewRounds: number;
  route: { provider: string; model: string } | null;
  dirtyReason: string | null;
}

export interface AcaEvent {
  seq?: number;
  runId: string;
  nodeId: string | null;
  ts: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface DiffFile {
  file: string;
  git: string | null;
  before: string;
  after: string;
}

/** Node status → the heat ramp. Shared so every view agrees. */
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
 * Event type → ramp colour.
 *
 * Grouped by what the event *means* rather than by prefix: a user scanning the
 * timeline is looking for trouble, and trouble is red wherever it came from.
 */
export function eventColor(type: string): string {
  if (/fail|rolled|violat|denied|exceeded/.test(type)) return "var(--crimson)";
  if (/guard/.test(type)) return "var(--crimson)";
  if (/done|passed|approved|completed|granted/.test(type)) return "var(--moss)";
  if (/approval|parked|warning|contended/.test(type)) return "var(--wheat)";
  if (/start|routed|called|proposed/.test(type)) return "var(--ember)";
  return "var(--ink-2)";
}

export function eventLane(type: string): string {
  if (type.startsWith("node.") || type.startsWith("run.")) return "node";
  if (type.startsWith("model.")) return "model";
  if (type.startsWith("tool.") || type.startsWith("cache.") || type.startsWith("epoch.")) {
    return "tool";
  }
  if (type.startsWith("gate.") || type.startsWith("review.")) return "gate";
  if (type.startsWith("lock.") || type.startsWith("checkpoint.")) return "lock";
  if (type.startsWith("approval.") || type.startsWith("plan.")) return "approval";
  return "node";
}

export const LANES = ["node", "model", "tool", "gate", "lock", "approval"] as const;

export function fmtCtx(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}k` : String(n);
}

export function fmtBytes(n: number): string {
  if (n <= 0) return "—";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
