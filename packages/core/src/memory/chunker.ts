import { createHash } from "node:crypto";

export interface Chunk {
  id: string;
  source: string;
  content: string;
  startLine: number;
  endLine: number;
  sha256: string;
  /** Symbol name when the chunk maps to one — the strongest retrieval signal. */
  symbol: string | null;
}

export interface ChunkOptions {
  maxLines?: number;
  overlapLines?: number;
}

/**
 * Splits source into retrievable chunks along structural boundaries.
 *
 * Fixed-size windows cut functions in half, and half a function retrieves
 * badly: the signature ends up in one chunk and the behaviour in another, so
 * neither answers "what does X do". A tree-sitter parse would be exact, but it
 * is a native dependency per language. Brace-depth tracking plus declaration
 * detection gets most of the benefit for the C-family and TS, which is what
 * this codebase and most of its targets are.
 *
 * Falls back to windowing for prose and anything unparseable.
 */
export function chunkFile(
  source: string,
  content: string,
  options: ChunkOptions = {},
): Chunk[] {
  const maxLines = options.maxLines ?? 80;
  const overlap = options.overlapLines ?? 6;
  const lines = content.split("\n");

  if (!isCodeLike(source)) return windowChunks(source, lines, maxLines, overlap);

  const chunks: Chunk[] = [];
  let start = 0;
  let depth = 0;
  let currentSymbol: string | null = null;
  let pendingSymbol: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const declared = declarationName(line);
    if (declared && depth === 0) pendingSymbol = declared;

    for (const ch of stripStringsAndComments(line)) {
      if (ch === "{") {
        if (depth === 0 && pendingSymbol) {
          currentSymbol = pendingSymbol;
          pendingSymbol = null;
        }
        depth++;
      } else if (ch === "}") {
        depth = Math.max(0, depth - 1);
        // Closing back to top level ends a declaration — a natural boundary.
        if (depth === 0) {
          chunks.push(makeChunk(source, lines, start, i, currentSymbol));
          start = i + 1;
          currentSymbol = null;
        }
      }
    }

    // A declaration that never opened a brace (type alias, import block) still
    // has to be bounded, or one runaway chunk swallows the file.
    if (depth === 0 && i - start >= maxLines) {
      chunks.push(makeChunk(source, lines, start, i, currentSymbol));
      start = i + 1;
      currentSymbol = null;
    }
  }

  if (start < lines.length) {
    chunks.push(makeChunk(source, lines, start, lines.length - 1, currentSymbol));
  }

  return chunks.filter((c) => c.content.trim().length > 0);
}

function makeChunk(
  source: string,
  lines: string[],
  start: number,
  end: number,
  symbol: string | null,
): Chunk {
  const content = lines.slice(start, end + 1).join("\n");
  const sha256 = createHash("sha256").update(content).digest("hex");
  return {
    id: `${source}:${start + 1}-${end + 1}`,
    source,
    content,
    startLine: start + 1,
    endLine: end + 1,
    sha256,
    symbol,
  };
}

function windowChunks(
  source: string,
  lines: string[],
  maxLines: number,
  overlap: number,
): Chunk[] {
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += maxLines - overlap) {
    const end = Math.min(start + maxLines - 1, lines.length - 1);
    chunks.push(makeChunk(source, lines, start, end, null));
    if (end === lines.length - 1) break;
  }
  return chunks.filter((c) => c.content.trim().length > 0);
}

const DECL =
  /(?:^|\s)(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum|struct|impl|def|fn)\s+([A-Za-z_$][\w$]*)/;

function declarationName(line: string): string | null {
  return DECL.exec(line)?.[1] ?? null;
}

/** Braces inside strings and comments are not structure. */
function stripStringsAndComments(line: string): string {
  return line
    .replace(/\\./g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/\/\/.*$/, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function isCodeLike(source: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|java|c|h|cpp|hpp|cs|go|rs|swift|kt|scala|php|py)$/i.test(
    source,
  );
}
