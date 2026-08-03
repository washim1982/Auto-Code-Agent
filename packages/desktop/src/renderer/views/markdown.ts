/**
 * A small Markdown parser, for model replies.
 *
 * Models answer in Markdown whether or not you ask them to, so rendering it as
 * plain text puts `##`, `**` and pipe-tables on screen as literal noise — which
 * is what a raw `white-space: pre-wrap` message does.
 *
 * Deliberately not a full CommonMark implementation. This covers the subset
 * models actually emit, and anything unrecognised falls through as a paragraph
 * rather than disappearing. Written rather than installed because the renderer
 * has no bundler-visible dependencies and one file is cheaper than the audit
 * surface of a Markdown package plus a sanitiser.
 */

export type Inline =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "strike"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; lang: string; value: string }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "quote"; children: Inline[] }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] }
  | { type: "rule" };

const FENCE = /^\s*(?:```|~~~)\s*(\S*)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:---+|\*\*\*+|___+)\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

/**
 * Whether a link from model output is safe to make clickable.
 *
 * The href is the one attribute that survives from untrusted text into the
 * DOM, so `javascript:` and `data:` are refused and the label renders as inert
 * text instead.
 */
export function safeHref(href: string): boolean {
  return /^(https?:\/\/|mailto:|#|\/)/i.test(href.trim());
}

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code. An unterminated fence runs to the end rather than being
    // dropped — a truncated stream is the common case, not a malformed one.
    const fence = FENCE.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence
      blocks.push({ type: "code", lang, value: body.join("\n") });
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]!.length,
        children: parseInline(heading[2]!),
      });
      i++;
      continue;
    }

    // A table needs its divider row to be a table at all; without one the
    // pipes are just text.
    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!)) {
      const head = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
        rows.push(splitRow(lines[i]!).map(parseInline));
        i++;
      }
      blocks.push({ type: "table", head, rows });
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        body.push(QUOTE.exec(lines[i]!)![1]!);
        i++;
      }
      blocks.push({ type: "quote", children: parseInline(body.join(" ")) });
      continue;
    }

    const isBullet = BULLET.test(line);
    if (isBullet || ORDERED.test(line)) {
      const ordered = !isBullet;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const match = ordered ? ORDERED.exec(lines[i]!) : BULLET.exec(lines[i]!);
        if (!match) break;
        items.push(parseInline(match[1]!));
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Paragraph: everything up to a blank line or the start of another block.
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!)) {
      para.push(lines[i]!.trim());
      i++;
    }
    if (para.length === 0) para.push(lines[i++]!.trim());
    blocks.push({ type: "paragraph", children: parseInline(para.join("\n")) });
  }

  return blocks;
}

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    QUOTE.test(line) ||
    RULE.test(line)
  );
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Inline emphasis, code spans and links. Code wins — its content is literal. */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let text = "";

  const flush = (): void => {
    if (text) out.push({ type: "text", value: text });
    text = "";
  };

  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);

    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      out.push({ type: "code", value: code[1]! });
      i += code[0].length;
      continue;
    }

    const link = /^\[([^\]]*)\]\(([^)\s]+)[^)]*\)/.exec(rest);
    if (link) {
      flush();
      out.push({ type: "link", href: link[2]!, children: parseInline(link[1]!) });
      i += link[0].length;
      continue;
    }

    const strong = /^(\*\*|__)(.+?)\1/.exec(rest);
    if (strong) {
      flush();
      out.push({ type: "strong", children: parseInline(strong[2]!) });
      i += strong[0].length;
      continue;
    }

    const strike = /^~~(.+?)~~/.exec(rest);
    if (strike) {
      flush();
      out.push({ type: "strike", children: parseInline(strike[1]!) });
      i += strike[0].length;
      continue;
    }

    // Single-character emphasis last, so `**bold**` is never read as two.
    const em = /^(\*|_)([^*_]+?)\1/.exec(rest);
    if (em) {
      flush();
      out.push({ type: "em", children: parseInline(em[2]!) });
      i += em[0].length;
      continue;
    }

    text += source[i];
    i++;
  }

  flush();
  return out;
}
