import { describe, expect, it } from "vitest";
import {
  parseBlocks,
  parseInline,
  safeHref,
  type Block,
} from "../src/renderer/views/markdown.ts";

/** Compact shape for asserting structure without the inline noise. */
function shape(blocks: Block[]): string[] {
  return blocks.map((b) => {
    if (b.type === "heading") return `h${b.level}`;
    if (b.type === "list") return `${b.ordered ? "ol" : "ul"}:${b.items.length}`;
    if (b.type === "code") return `code:${b.lang}`;
    if (b.type === "table") return `table:${b.rows.length}`;
    return b.type;
  });
}

function text(nodes: ReturnType<typeof parseInline>): string {
  return nodes
    .map((n) => {
      if (n.type === "text") return n.value;
      if (n.type === "code") return `\`${n.value}\``;
      return text(n.children);
    })
    .join("");
}

describe("markdown blocks", () => {
  it("reads the shape of a typical model reply", () => {
    // Close to what the screenshot showed rendered as literal text.
    const source = [
      "This is **Llama Forge Studio** — a desktop app.",
      "",
      "## How to Run",
      "",
      "### Prerequisites",
      "- **Windows 10/11**",
      "- **Node.js 20+**",
      "",
      "1. Run the batch script:",
      "2. Start the dev server:",
      "",
      "```bash",
      "npm install --legacy-peer-deps",
      "npm run dev",
      "```",
    ].join("\n");

    expect(shape(parseBlocks(source))).toEqual([
      "paragraph",
      "h2",
      "h3",
      "ul:2",
      "ol:2",
      "code:bash",
    ]);
  });

  it("keeps code fences literal", () => {
    const [block] = parseBlocks("```ts\nconst x = **not bold**;\n```");
    expect(block).toEqual({ type: "code", lang: "ts", value: "const x = **not bold**;" });
  });

  it("runs an unterminated fence to the end rather than dropping it", () => {
    // Streaming means a half-written block is the normal case.
    const [block] = parseBlocks("```\nhalf a code block");
    expect(block).toMatchObject({ type: "code", value: "half a code block" });
  });

  it("parses a table only when the divider row is present", () => {
    const table = parseBlocks("| Command | Description |\n|---|---|\n| `npm run dev` | Start |");
    expect(shape(table)).toEqual(["table:1"]);

    // Pipes alone are just prose.
    expect(shape(parseBlocks("a | b | c"))).toEqual(["paragraph"]);
  });

  it("does not treat a horizontal rule as a heading or a list", () => {
    expect(shape(parseBlocks("above\n\n---\n\nbelow"))).toEqual([
      "paragraph",
      "rule",
      "paragraph",
    ]);
  });
});

describe("markdown inline", () => {
  it("reads bold, italic, code and links", () => {
    const nodes = parseInline("**bold** and *italic* and `code` and [link](https://x.dev)");
    expect(nodes.map((n) => n.type)).toEqual([
      "strong",
      "text",
      "em",
      "text",
      "code",
      "text",
      "link",
    ]);
    expect(text(nodes)).toBe("bold and italic and `code` and link");
  });

  it("does not split bold into two italics", () => {
    const [node] = parseInline("**both**");
    expect(node!.type).toBe("strong");
  });

  it("leaves emphasis inside code spans alone", () => {
    const [node] = parseInline("`a ** b`");
    expect(node).toEqual({ type: "code", value: "a ** b" });
  });

  it("keeps an unmatched asterisk as text", () => {
    expect(text(parseInline("2 * 3 = 6"))).toBe("2 * 3 = 6");
  });
});

describe("link safety", () => {
  it("allows ordinary web links", () => {
    for (const href of ["https://x.dev", "http://x.dev", "mailto:a@b.c", "#anchor", "/docs"]) {
      expect(safeHref(href)).toBe(true);
    }
  });

  it("refuses schemes that execute", () => {
    // Model output is untrusted text; the href is the one part of it that
    // would otherwise reach the DOM as something more than characters.
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      "file:///C:/Windows/System32",
    ]) {
      expect(safeHref(href)).toBe(false);
    }
  });
});
