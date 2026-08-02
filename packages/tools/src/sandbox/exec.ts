import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SandboxTier } from "@aca/protocol";

export interface ExecOptions {
  cwd: string;
  tier: SandboxTier;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

/**
 * Environment variables that must never reach a sandboxed subprocess.
 * Scrubbing is by pattern, not allowlist of known names, because the set of
 * things that look like a credential grows faster than any list.
 */
const SECRET_PATTERNS = [
  /API[_-]?KEY/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /CREDENTIAL/i,
  /_PAT$/i,
  /SESSION/i,
  /AUTH/i,
];

export function scrubEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v == null) continue;
    if (SECRET_PATTERNS.some((p) => p.test(k))) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Runs a command in a sandbox tier (flow review F10).
 *
 * The original flow said "Execute tool in sandbox" twice and never defined it,
 * while resting the entire isolation story on those two boxes.
 *
 *   T0  in-process, pure functions only — never reaches this function
 *   T1  subprocess: cwd jail, scrubbed env, wall-clock cap, output cap
 *   T2  container — the real boundary for untrusted code
 *
 * Honest limitation, stated in the docs and repeated here: Windows has no
 * seccomp or bubblewrap equivalent. At T1 the cwd jail is advisory — the child
 * can write anywhere its user token allows. That is why `Checkpoint.verify()`
 * exists: we cannot always prevent an out-of-set write, but we always detect
 * one and fail the node. Anything genuinely untrusted belongs in T2.
 */
export async function execSandboxed(
  command: string,
  args: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  if (options.tier === "t0") {
    throw new Error("t0 is in-process only; it must not spawn a subprocess");
  }

  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024;
  const started = Date.now();

  const [cmd, cmdArgs, verbatim] =
    options.tier === "t2"
      ? ([...dockerWrap(command, args, options.cwd), false] as const)
      : windowsSpawnArgs(resolveExecutable(command), args);

  return await new Promise<ExecResult>((resolve) => {
    const child = spawn(cmd, [...cmdArgs], {
      cwd: options.cwd,
      env: { ...scrubEnv(), ...(options.env ?? {}) },
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });

    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const capture = (buf: Buffer, into: "out" | "err") => {
      if (bytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const room = maxOutputBytes - bytes;
      const slice = buf.subarray(0, room).toString("utf8");
      bytes += Buffer.byteLength(slice);
      if (buf.length > room) truncated = true;
      if (into === "out") stdout += slice;
      else stderr += slice;
    };

    child.stdout?.on("data", (b: Buffer) => capture(b, "out"));
    child.stderr?.on("data", (b: Buffer) => capture(b, "err"));

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offAbort?.();
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      });
    };

    // SIGTERM then SIGKILL — a hung process must not outlive its node.
    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2000).unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    timer.unref?.();

    let offAbort: (() => void) | undefined;
    if (options.signal) {
      const onAbort = () => {
        timedOut = false;
        kill();
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      offAbort = () => options.signal?.removeEventListener("abort", onAbort);
      if (options.signal.aborted) onAbort();
    }

    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/**
 * Resolves a bare command name to something Windows can actually spawn.
 *
 * `npm`, `npx`, `yarn` and `pnpm` are `.cmd` shims on Windows, and `spawn`
 * with `shell: false` will not find them — it fails with ENOENT, which then
 * gets recorded as a *gate failure* and retried twice before the node is rolled
 * back. An environmental problem masquerading as a code problem is the worst
 * kind of false signal, so resolve it here rather than reaching for
 * `shell: true`, which would open a command-injection hole.
 */
export function resolveExecutable(command: string): string {
  if (process.platform !== "win32") return command;
  if (/[\\/]/.test(command) || /\.(exe|cmd|bat|com)$/i.test(command)) return command;

  const dirs = (process.env["PATH"] ?? "").split(";").filter(Boolean);
  for (const ext of [".cmd", ".exe", ".bat"]) {
    for (const dir of dirs) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

export class UnsafeArgument extends Error {
  constructor(arg: string) {
    super(`argument cannot be safely passed through cmd.exe: ${arg}`);
    this.name = "UnsafeArgument";
  }
}

/**
 * Builds spawn arguments, working around Windows batch-shim restrictions.
 *
 * Since the CVE-2024-27980 mitigation, Node refuses to spawn a `.cmd` or
 * `.bat` without a shell — it fails with EINVAL. `npm`, `pnpm` and `npx` are
 * all batch shims, so every gate that runs one dies unless we invoke the
 * interpreter explicitly.
 *
 * We do NOT reach for `shell: true`: that concatenates the whole command line
 * and would let a model-supplied argument inject a second command. Instead we
 * call `cmd.exe /d /s /c` with each argument individually quoted, and reject
 * arguments containing characters whose behaviour inside cmd quoting is
 * unsafe or ambiguous (`%` expands variables even inside quotes; `!` does too
 * under delayed expansion). Failing loudly beats guessing.
 */
export function windowsSpawnArgs(
  executable: string,
  args: readonly string[],
): readonly [string, string[], boolean] {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(executable)) {
    return [executable, [...args], false] as const;
  }

  for (const a of args) {
    if (/[%!"]/.test(a)) throw new UnsafeArgument(a);
  }

  // With `/s`, cmd strips the FIRST and LAST character of the command line if
  // both are quotes and uses the rest verbatim. So the whole line needs an
  // extra enclosing pair — without it, a path like
  // `C:\Program Files\nodejs\npm.cmd` is split at the space and cmd reports
  // that 'C:\Program' is not recognised.
  const inner = [executable, ...args].map((a) => `"${a}"`).join(" ");
  const comspec = process.env["ComSpec"] ?? "cmd.exe";
  return [comspec, ["/d", "/s", "/c", `"${inner}"`], true] as const;
}

/** T2: run inside a container with the workspace as the only mount. */
function dockerWrap(command: string, args: string[], cwd: string): readonly [string, string[]] {
  return [
    "docker",
    [
      "run",
      "--rm",
      "--network=none",
      "--memory=2g",
      "--cpus=2",
      "-v",
      `${cwd}:/work`,
      "-w",
      "/work",
      "node:24-alpine",
      command,
      ...args,
    ],
  ] as const;
}
