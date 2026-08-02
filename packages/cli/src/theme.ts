/**
 * Terminal palette, mapped from the heat ramp in docs/06-ui-design.md.
 *
 * State is encoded three ways at once — hue, glyph, and label — so it survives
 * NO_COLOR, a monochrome terminal, and colour-vision deficiency. The glyph is
 * the load-bearing signal; colour is the accelerant.
 */
const NO_COLOR =
  process.env["NO_COLOR"] != null || process.env["TERM"] === "dumb" || !process.stdout.isTTY;

const TRUECOLOR = /truecolor|24bit/i.test(process.env["COLORTERM"] ?? "");

function rgb(r: number, g: number, b: number, fallback: number): (s: string) => string {
  if (NO_COLOR) return (s) => s;
  const open = TRUECOLOR ? `[38;2;${r};${g};${b}m` : `[${fallback}m`;
  return (s) => `${open}${s}[39m`;
}

export const c = {
  // The ramp: cold -> hot. Urgency rises with temperature.
  slate: rgb(107, 124, 140, 90), // queued / blocked
  moss: rgb(127, 160, 95, 32), // done — deliberately quiet
  wheat: rgb(217, 178, 76, 33), // waiting on you
  ember: rgb(224, 123, 69, 33), // running, and the interactive accent
  crimson: rgb(209, 82, 95, 31), // failed / untrusted

  ink: rgb(228, 226, 222, 37),
  dim: rgb(110, 116, 124, 90),
  bold: (s: string) => (NO_COLOR ? s : `[1m${s}[22m`),
} as const;

export type StateKey = "queued" | "done" | "approval" | "running" | "failed";

export const GLYPH: Record<StateKey, string> = {
  queued: "○", // hollow circle
  done: "✓",
  approval: "⚠",
  running: "▶",
  failed: "✗",
};

const PAINT: Record<StateKey, (s: string) => string> = {
  queued: c.slate,
  done: c.moss,
  approval: c.wheat,
  running: c.ember,
  failed: c.crimson,
};

export function stateGlyph(state: StateKey): string {
  return PAINT[state](GLYPH[state]);
}

export function paint(state: StateKey, s: string): string {
  return PAINT[state](s);
}

/** Maps a node status onto the ramp. */
export function stateOf(status: string): StateKey {
  switch (status) {
    case "done":
      return "done";
    case "running":
      return "running";
    case "failed":
    case "rolled_back":
      return "failed";
    case "parked":
      return "approval";
    default:
      return "queued";
  }
}

/** Fixed-width cell with ellipsis, so columns line up like an instrument panel. */
export function cell(s: string, width: number, align: "left" | "right" = "left"): string {
  const plain = s.replace(/\[[0-9;]*m/g, "");
  if (plain.length > width) {
    const cut = width - 1;
    return align === "left" ? `${plain.slice(0, cut)}…` : `…${plain.slice(-cut)}`;
  }
  const pad = " ".repeat(width - plain.length);
  return align === "left" ? s + pad : pad + s;
}

export function rule(width = 78): string {
  return c.dim("─".repeat(width));
}
