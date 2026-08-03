import type { ThreadEntry } from "./shared.ts";

/**
 * One tool call and the result that answered it.
 *
 * They arrive as two separate notifications, and rendering them as two rows
 * doubled an already long list — the call and its result are one event.
 */
export interface ActivityStep {
  id: string;
  toolName: string;
  args: string;
  result: string | null;
  untrusted: boolean;
  forgery: boolean;
}

export type ThreadGroup =
  | { kind: "message"; entry: ThreadEntry }
  | { kind: "activity"; id: string; steps: ActivityStep[]; thinking: string };

/**
 * Folds a turn's intermediate work into one collapsible group.
 *
 * A model answering a question about a repo makes a dozen tool calls and
 * thinks between each one. Rendered flat, that buries the answer under a
 * screen of chips — the work becomes the content and the content becomes a
 * footnote. Grouping keeps it available without letting it dominate.
 *
 * A group runs until the next thing a person actually said or was told: a
 * user message, or an assistant turn carrying prose.
 */
export function groupThread(entries: ThreadEntry[]): ThreadGroup[] {
  const groups: ThreadGroup[] = [];
  let current: Extract<ThreadGroup, { kind: "activity" }> | null = null;

  const close = (): void => {
    current = null;
  };

  for (const entry of entries) {
    const isWork = entry.role === "tool" || (entry.role === "assistant" && !entry.content);

    if (!isWork) {
      close();
      groups.push({ kind: "message", entry });
      continue;
    }

    if (!current) {
      current = { kind: "activity", id: `act-${entry.id}`, steps: [], thinking: "" };
      groups.push(current);
    }

    // An assistant turn with no prose is a round that only called tools; its
    // thinking belongs to the group rather than to a bubble of its own.
    if (entry.role === "assistant") {
      if (entry.thinking) {
        current.thinking = current.thinking
          ? `${current.thinking}\n\n${entry.thinking}`
          : entry.thinking;
      }
      continue;
    }

    // Results are flagged untrusted; calls are not. A result attaches to the
    // most recent unanswered call of the same tool.
    if (entry.untrusted) {
      const open = [...current.steps]
        .reverse()
        .find((s) => s.result === null && s.toolName === entry.toolName);
      if (open) {
        open.result = entry.content;
        open.untrusted = true;
        open.forgery = open.forgery || Boolean(entry.forgery);
        continue;
      }
    }

    current.steps.push({
      id: entry.id,
      toolName: entry.toolName ?? "tool",
      args: entry.untrusted ? "" : entry.content,
      result: entry.untrusted ? entry.content : null,
      untrusted: Boolean(entry.untrusted),
      forgery: Boolean(entry.forgery),
    });
  }

  return groups;
}

/** "read_file ×6 · glob ×4" — what the group actually did, most-used first. */
export function summarise(steps: ActivityStep[]): string {
  const counts = new Map<string, number>();
  for (const s of steps) counts.set(s.toolName, (counts.get(s.toolName) ?? 0) + 1);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(" · ");
}
