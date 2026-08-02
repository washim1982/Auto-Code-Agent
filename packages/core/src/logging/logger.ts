export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Patterns redacted from every log line, unconditionally.
 *
 * Logs are the quiet leak: they are durable, they get pasted into issues, and
 * nobody reviews them. Redacting at the sink rather than at every call site is
 * the only version that actually holds, because it cannot be forgotten.
 */
const REDACTIONS: { re: RegExp; label: string }[] = [
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, label: "anthropic-key" },
  { re: /\bsk-[A-Za-z0-9]{32,}/g, label: "openai-key" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, label: "github-token" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "aws-key" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, label: "slack-token" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, label: "private-key" },
  { re: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}/g, label: "bearer" },
  {
    re: /"(?:password|secret|token|apiKey|api_key)"\s*:\s*"[^"]+"/gi,
    label: "credential-field",
  },
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const r of REDACTIONS) out = out.replace(r.re, `[REDACTED:${r.label}]`);
  return out;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** NDJSON to stderr, for machine consumption. */
  json?: boolean;
  sink?: (line: string) => void;
}

export class Logger {
  private level: LogLevel;
  private json: boolean;
  private sink: (line: string) => void;
  private scope: string;

  constructor(scope = "aca", options: LoggerOptions = {}) {
    this.scope = scope;
    this.level = options.level ?? (process.env["ACA_LOG"] as LogLevel) ?? "info";
    this.json = options.json ?? false;
    this.sink = options.sink ?? ((line) => process.stderr.write(line + "\n"));
  }

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, {
      level: this.level,
      json: this.json,
      sink: this.sink,
    });
  }

  private emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;

    if (this.json) {
      this.sink(
        redactSecrets(
          JSON.stringify({ ts: Date.now(), level, scope: this.scope, message, ...fields }),
        ),
      );
      return;
    }

    const extra = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
    this.sink(redactSecrets(`${level.padEnd(5)} ${this.scope} ${message}${extra}`));
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.emit("debug", message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.emit("info", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.emit("warn", message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.emit("error", message, fields);
  }
}

export const log = new Logger();
