import { c } from "../theme.ts";

/**
 * The interactive CLI's opening screen.
 *
 * Built rather than pasted: the box is sized from the longest command in the
 * list, so adding one cannot leave a border half a character out. Hand-drawn
 * ASCII survives exactly until someone edits it.
 *
 * Colour is applied after padding, never before — an ANSI escape is several
 * characters that occupy no columns, so measuring a coloured string is how box
 * corners end up ragged.
 */

/** 24 columns wide, 6 rows. Every row is padded to the same width. */
const WORDMARK = [
  " █████╗  ██████╗ █████╗ ",
  "██╔══██╗██╔════╝██╔══██╗",
  "███████║██║     ███████║",
  "██╔══██║██║     ██╔══██║",
  "██║  ██║╚██████╗██║  ██║",
  "╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝",
];

/** Kept in step with packages/cli/package.json. */
export const CLI_VERSION = "0.1.0";

const ART_WIDTH = 24;
/** Space between the wordmark column and the command box. */
const GUTTER = 3;

export interface BannerCommand {
  keys: string;
  help: string;
}

/**
 * The two front ends accept different commands, so each passes its own list.
 *
 * A banner advertising `/ws` to a TUI that answers "unknown command /ws" is
 * worse than no banner: it is documentation that lies on first use. These are
 * read off `handleCommand` in run-tui.tsx and the REPL loop in chat.ts.
 */
export const TUI_COMMANDS: BannerCommand[] = [
  { keys: "/model [name]", help: "Change active model" },
  { keys: "/index", help: "Index stats for this workspace" },
  { keys: "/lessons", help: "View learned lessons" },
  { keys: "/help", help: "Show all commands" },
  { keys: "esc", help: "Cancel, or quit when idle" },
];

/** `aca chat` / `aca --plain` — the readline REPL. */
export const CHAT_COMMANDS: BannerCommand[] = [
  { keys: "/ws", help: "List known workspaces" },
  { keys: "/model [name]", help: "Change active model" },
  { keys: "/models", help: "List every model" },
  { keys: "/usage", help: "Tokens, cost, elapsed" },
  { keys: "/help", help: "Show all commands" },
  { keys: "/exit", help: "Quit" },
];

export interface BannerInfo {
  version: string;
  workspace: string;
  model: string;
  /** Free text: "ready", "not indexed", "1 240 chunks". */
  index: string;
  /** Shown only when set — a local-only session is worth stating. */
  privacy?: string;
  commands?: BannerCommand[];
  /** Terminal width; defaults to `process.stdout.columns`. */
  columns?: number;
}

export function banner(info: BannerInfo): string {
  const commands = info.commands ?? TUI_COMMANDS;
  const columns = info.columns ?? process.stdout.columns ?? 80;

  const keyWidth = Math.max(...commands.map((cmd) => cmd.keys.length));
  const rows = commands.map((cmd) => `${cmd.keys.padEnd(keyWidth)}  ${cmd.help}`);
  const title = " Auto-Code-Agent ";
  const wanted = Math.max(...rows.map((r) => r.length), "Commands:".length, title.length) + 4;

  // Below this the two columns collide, so the wordmark is dropped rather than
  // wrapped — a broken box reads as a bug, a smaller banner does not.
  const wide = columns >= ART_WIDTH + GUTTER + wanted + 2;

  // Dropping the wordmark is not enough on its own: the box is sized by its
  // longest command, which can still be wider than the terminal. Clamp it and
  // let the help text truncate — an overflowing box wraps and looks broken.
  const inner = wide ? wanted : Math.max(title.length + 2, Math.min(wanted, columns - 2));
  const fitted = rows.map((r) => (r.length > inner - 4 ? `${r.slice(0, inner - 5)}…` : r));

  const box = renderBox(title, fitted, inner);
  const left = wide ? leftColumn(info.version, box.length) : [];
  const lines = wide ? zip(left, box) : box;

  return [...lines, "", statusLine(info, columns)].join("\n");
}

/** The wordmark column, vertically centred against a box of `height` rows. */
function leftColumn(version: string, height: number): string[] {
  const block = [
    ...WORDMARK.map((row) => c.ember(row)),
    "",
    c.dim(center("AUTONOMOUS CODING", ART_WIDTH)),
    c.dim(center("A  G  E  N  T", ART_WIDTH)),
    "",
    c.dim(center(version, ART_WIDTH)),
  ];

  const pad = Math.max(0, Math.floor((height - block.length) / 2));
  const out = [...Array<string>(pad).fill(""), ...block];
  while (out.length < height) out.push("");
  return out.slice(0, height);
}

function renderBox(title: string, rows: string[], inner: number): string[] {
  const top = `┌─${title}${"─".repeat(Math.max(0, inner - title.length - 1))}┐`;
  const bottom = `└${"─".repeat(inner)}┘`;
  const line = (text = ""): string => `│  ${text.padEnd(inner - 2)}│`;

  return [
    c.dim(top),
    c.dim(line()),
    c.dim("│  ") + c.bold("Commands:") + c.dim(" ".repeat(inner - 11) + "│"),
    c.dim(line()),
    ...rows.map((row, i) => {
      const cmd = row.slice(0, row.indexOf("  "));
      const help = row.slice(row.indexOf("  "));
      void i;
      return c.dim("│  ") + c.ember(cmd) + c.dim(help.padEnd(inner - 2 - cmd.length)) + c.dim("│");
    }),
    c.dim(line()),
    c.dim(bottom),
  ];
}

/**
 * Workspace, model and index state.
 *
 * Stacks when it will not fit. The box shrinks to the terminal but this line
 * does not, so on a narrow window it was the thing that overflowed and wrapped
 * — after all the work to stop the box doing exactly that.
 */
function statusLine(info: BannerInfo, columns: number): string {
  const parts: [string, string][] = [
    ["ws", info.workspace],
    ["model", info.model],
    ["index", info.index],
    ...(info.privacy ? ([["privacy", info.privacy]] as [string, string][]) : []),
  ];

  const oneLine = 2 + parts.map(([k, v]) => `${k} ${v}`).join("   ").length;
  const paint = ([k, v]: [string, string]): string => `${c.dim(k)} ${c.ink(v)}`;

  if (oneLine <= columns) return `  ${parts.map(paint).join(c.dim("   "))}\n`;
  return parts.map((p) => `  ${paint(p)}`).join("\n") + "\n";
}

/** Joins two columns, padding the left one to a fixed visual width. */
function zip(left: string[], right: string[]): string[] {
  const height = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < height; i++) {
    const l = left[i] ?? "";
    // The wordmark rows are already coloured, so pad by their visual width.
    const padding = " ".repeat(Math.max(0, ART_WIDTH - visibleWidth(l)));
    out.push(`${l}${padding}${" ".repeat(GUTTER)}${right[i] ?? ""}`.trimEnd());
  }
  return out;
}

function center(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return " ".repeat(pad) + text;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

/** Columns a string occupies once escape sequences are stripped. */
export function visibleWidth(s: string): number {
  return s.replace(ANSI, "").length;
}
