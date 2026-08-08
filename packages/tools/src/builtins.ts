import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { WriteSetViolation } from "@aca/core";
import { resolveInWorkspace, toResourceId } from "./paths.ts";
import { DEFAULT_IGNORES } from "./checkpoint.ts";
import { execSandboxed } from "./sandbox/exec.ts";
import type { ToolDef, ToolRegistry } from "./registry.ts";

const readFileTool: ToolDef = {
  name: "read_file",
  description: "Read a UTF-8 text file from the workspace.",
  schema: z.object({ path: z.string() }),
  purity: "pure",
  tier: "t0",
  async run(args, ctx) {
    const { path } = args as { path: string };
    const abs = resolveInWorkspace(ctx.root, path);
    const resource = toResourceId(ctx.root, abs);
    try {
      return { content: readFileSync(abs, "utf8"), reads: [resource] };
    } catch (err) {
      return {
        content: `cannot read ${resource}: ${(err as Error).message}`,
        reads: [resource],
        isError: true,
      };
    }
  },
};

const listDirTool: ToolDef = {
  name: "list_dir",
  description: "List entries in a workspace directory.",
  schema: z.object({ path: z.string().default(".") }),
  purity: "pure",
  tier: "t0",
  async run(args, ctx) {
    const { path } = args as { path: string };
    const abs = resolveInWorkspace(ctx.root, path || ".");
    const resource = toResourceId(ctx.root, abs) || ".";
    const entries = readdirSync(abs, { withFileTypes: true })
      .filter((e) => !DEFAULT_IGNORES.includes(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return { content: entries.join("\n"), reads: [`${resource}/*`] };
  },
};

const globTool: ToolDef = {
  name: "glob",
  description: "Find files matching a glob-ish pattern (supports * and **).",
  schema: z.object({ pattern: z.string(), path: z.string().default(".") }),
  purity: "pure",
  tier: "t0",
  async run(args, ctx) {
    const { pattern, path } = args as { pattern: string; path: string };
    const base = resolveInWorkspace(ctx.root, path || ".");
    const re = globToRegExp(pattern);
    const hits: string[] = [];
    walk(base, (abs) => {
      const rel = relative(ctx.root, abs).split(sep).join("/");
      if (re.test(rel)) hits.push(rel);
    });
    const scope = toResourceId(ctx.root, base);
    return {
      content: hits.slice(0, 500).join("\n"),
      reads: [scope ? `${scope}/**` : "**"],
    };
  },
};

const grepTool: ToolDef = {
  name: "grep",
  description: "Search file contents with a regular expression.",
  schema: z.object({
    pattern: z.string(),
    path: z.string().default("."),
    maxResults: z.number().default(100),
  }),
  purity: "pure",
  tier: "t0",
  async run(args, ctx) {
    const { pattern, path, maxResults } = args as {
      pattern: string;
      path: string;
      maxResults: number;
    };
    const base = resolveInWorkspace(ctx.root, path || ".");
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch (err) {
      return { content: `bad pattern: ${(err as Error).message}`, isError: true };
    }

    const out: string[] = [];
    walk(base, (abs) => {
      if (out.length >= maxResults) return;
      let text: string;
      try {
        if (statSync(abs).size > 1_000_000) return;
        text = readFileSync(abs, "utf8");
      } catch {
        return;
      }
      const rel = relative(ctx.root, abs).split(sep).join("/");
      text.split("\n").forEach((line, i) => {
        if (out.length >= maxResults) return;
        if (re.test(line)) out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
      });
    });

    const scope = toResourceId(ctx.root, base);
    return { content: out.join("\n"), reads: [scope ? `${scope}/**` : "**"] };
  },
};

/**
 * Reads back output the guard spilled to an artifact.
 *
 * The guard already writes every tool result over 2 KB to
 * `.aca/artifacts/<id>.txt` and hands the model an id, a summary and the first
 * 800 characters. Until now there was no way to fetch the rest, so the file was
 * write-only: a model needing line 400 of a 30 KB result could only call
 * `read_file` again, spill again, and see the same first 800 characters. That
 * is the loop that made large files unworkable rather than merely large.
 *
 * With line ranges, big content lives on disk and the window pays only for the
 * slice actually needed — which is the whole point of spilling it.
 */
const readArtifactTool: ToolDef = {
  name: "read_artifact",
  description:
    "Read a slice of a spilled tool result by its artifact id (shown as '[artifact <id> ...]'). " +
    "Use this instead of re-running a tool whose output was too large. " +
    "Give startLine/endLine to page through it; the default is the first 200 lines.",
  schema: z.object({
    id: z.string().describe("The artifact id, for example 'd286a0982426'."),
    // Coerced, not validated: a model passing 0 got a zod error and burned a
    // whole round-trip on an off-by-one it could not see.
    startLine: z.number().int().default(1),
    endLine: z.number().int().default(200),
  }),
  purity: "pure",
  tier: "t0",
  async run(args, ctx) {
    const { id, startLine, endLine } = args as {
      id: string;
      startLine: number;
      endLine: number;
    };
    // The id is a content hash, so anything else is a model mistake — and
    // joining an arbitrary string onto a path is how a jail gets escaped.
    if (!/^[0-9a-f]{6,64}$/i.test(id)) {
      return { content: `bad artifact id: ${id}`, isError: true };
    }

    const from = Math.max(1, startLine);
    const to = Math.max(from, endLine);
    const abs = join(resolve(ctx.root), ".aca", "artifacts", `${id}.txt`);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      return { content: `no artifact ${id}`, isError: true };
    }

    const lines = text.split("\n");
    const slice = lines.slice(from - 1, to);
    const header =
      `[artifact ${id} · lines ${from}-${Math.min(to, lines.length)} of ${lines.length}]`;
    return { content: `${header}\n${slice.join("\n")}` };
  },
};

const writeFileTool: ToolDef = {
  name: "write_file",
  description: "Write a UTF-8 text file. Must be inside the node's declared write set.",
  schema: z.object({ path: z.string(), content: z.string() }),
  purity: "mutating",
  tier: "t1",
  async run(args, ctx) {
    const { path, content } = args as { path: string; content: string };
    if (!ctx.checkpoint) {
      throw new WriteSetViolation(path, []);
    }
    // Throws WriteSetViolation when outside the declaration (F4).
    const resource = ctx.checkpoint.write(path, content);
    return {
      content: `wrote ${resource} (${Buffer.byteLength(content)} bytes)`,
      writes: [resource],
    };
  },
};

const editFileTool: ToolDef = {
  name: "edit_file",
  description: "Replace an exact string in a file. Fails if the string is absent or ambiguous.",
  schema: z.object({ path: z.string(), oldText: z.string(), newText: z.string() }),
  purity: "mutating",
  tier: "t1",
  async run(args, ctx) {
    const { path, oldText, newText } = args as {
      path: string;
      oldText: string;
      newText: string;
    };
    if (!ctx.checkpoint) throw new WriteSetViolation(path, []);

    const abs = resolveInWorkspace(ctx.root, path);
    const resource = toResourceId(ctx.root, abs);
    const before = readFileSync(abs, "utf8");
    const occurrences = before.split(oldText).length - 1;

    if (occurrences === 0) {
      return { content: `no match for the given text in ${resource}`, isError: true };
    }
    if (occurrences > 1) {
      return {
        content: `text appears ${occurrences} times in ${resource}; make it unique`,
        isError: true,
      };
    }

    ctx.checkpoint.write(path, before.replace(oldText, newText));
    return { content: `edited ${resource}`, writes: [resource] };
  },
};

const runCommandTool: ToolDef = {
  name: "run_command",
  description:
    "Run one executable directly in the workspace sandbox (no network at T1). " +
    "Put only the executable in command and each argument in args; shell lines, pipes, and redirects are unsupported. " +
    // Every one of these was a real failure mode in a single run: 15 wasted
    // round-trips on `cat`, `/tmp`, and `node -e` one-liners, each of which also
    // left its error in the context for every later step to pay for.
    "There is no shell, so `cat`, `ls`, `echo`, `sed` and `grep` are NOT available — " +
    "use the read_file, list_dir, write_file and grep tools instead. " +
    "Do not shell out to read or write files, and do not use /tmp: only paths inside " +
    "the workspace exist. Prefer the dedicated tools; use this for git, npm and node scripts only.",
  schema: z.object({
    command: z
      .string()
      .describe("One executable only, such as git, npm, or node. Never a full shell command."),
    args: z
      .array(z.string())
      .describe("Arguments as separate strings, for example ['diff', 'HEAD', '--', 'package.json'].")
      .default([]),
    timeoutMs: z.number().default(120_000),
  }),
  purity: "mutating",
  tier: "t1",
  async run(args, ctx) {
    const {
      command,
      args: argv,
      timeoutMs,
    } = args as {
      command: string;
      args: string[];
      timeoutMs: number;
    };
    const wholeShellLine =
      argv.length === 0 &&
      /\s/.test(command.trim()) &&
      !existsSync(command) &&
      !existsSync(join(ctx.root, command));
    if (wholeShellLine) {
      return {
        content:
          'invalid run_command input: "command" must contain one executable, not a shell line. ' +
          'Retry with separate arguments, for example {"command":"git","args":["diff","HEAD","--","package.json"]}.',
        isError: true,
      };
    }
    const res = await execSandboxed(command, argv, {
      cwd: ctx.root,
      tier: "t1",
      timeoutMs,
      signal: ctx.signal,
    });
    const parts = [
      `exit ${res.code}${res.timedOut ? " (timed out)" : ""} in ${res.durationMs}ms`,
      res.stdout && `--- stdout ---\n${res.stdout}`,
      res.stderr && `--- stderr ---\n${res.stderr}`,
    ].filter(Boolean);
    return { content: parts.join("\n"), isError: res.code !== 0 };
  },
};

/**
 * Irreversible (F13). Checkpoint/rollback covers reversible mutations only —
 * once this succeeds there is nothing to restore, so it asks at execution time
 * regardless of any plan-level approval already granted.
 */
const gitPushTool: ToolDef = {
  name: "git_push",
  description: "Push the current branch to a remote. Irreversible.",
  schema: z.object({ remote: z.string().default("origin"), branch: z.string() }),
  purity: "irreversible",
  tier: "t1",
  async run(args, ctx) {
    const { remote, branch } = args as { remote: string; branch: string };
    const granted = ctx.requestApproval
      ? await ctx.requestApproval(
          `git push ${remote} ${branch}`,
          "Publishes commits to a remote. This cannot be rolled back by the checkpoint system.",
        )
      : false;
    if (!granted) {
      return { content: "push rejected by operator", isError: true };
    }
    const res = await execSandboxed("git", ["push", remote, branch], {
      cwd: ctx.root,
      tier: "t1",
      signal: ctx.signal,
    });
    return { content: `${res.stdout}\n${res.stderr}`.trim(), isError: res.code !== 0 };
  },
};

export const BUILTIN_TOOLS: ToolDef[] = [
  readFileTool,
  readArtifactTool,
  listDirTool,
  globTool,
  grepTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  gitPushTool,
];

export function registerBuiltins(registry: ToolRegistry): void {
  for (const t of BUILTIN_TOOLS) registry.register(t);
}

// ------------------------------------------------------------------ internals

function walk(dir: string, onFile: (abs: string) => void, depth = 0): void {
  if (depth > 24) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Scoping a search to one file is the obvious thing to ask for, and
    // `readdirSync` on a file throws ENOTDIR. Returning here made `grep` answer
    // "no matches" instead of "wrong shape", so a model that narrowed to a
    // single file just kept retrying with different patterns against silence.
    try {
      if (statSync(dir).isFile()) onFile(dir);
    } catch {
      // genuinely missing or unreadable
    }
    return;
  }
  for (const e of entries) {
    if (DEFAULT_IGNORES.includes(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(abs, onFile, depth + 1);
    else if (e.isFile()) onFile(abs);
  }
}

/**
 * Glob -> RegExp.
 *
 * `**` crosses path separators, `*` and `?` do not. Written as a scanner
 * rather than chained string replaces, because the replace order matters and
 * goes silently wrong the moment a pattern mixes `**` and `*`.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?"; // `**/` may match zero directories
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if ("\^$.|+()[]{}".includes(c)) {
      out += "\\" + c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return new RegExp("^" + out + "$");
}
