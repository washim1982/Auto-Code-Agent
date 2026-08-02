export type FindingKind = "pii" | "secret" | "injection" | "scope";

export interface GuardFinding {
  kind: FindingKind;
  label: string;
  /** Character span in the ORIGINAL text, for UI highlighting. */
  start: number;
  end: number;
  severity: "block" | "redact" | "warn";
}

export interface InputGuardResult {
  /** Text safe to send onward; secrets and PII replaced by placeholders. */
  text: string;
  findings: GuardFinding[];
  /** True when the input must not proceed at all. */
  blocked: boolean;
  reason?: string;
}

export interface InputGuardOptions {
  /**
   * Cloud routing makes PII redaction load-bearing rather than hygienic: the
   * data leaves the machine. Locally it still matters for the event log, which
   * is durable and gets exported.
   */
  redactPii?: boolean;
  workspaceRoot?: string;
  /** Paths outside the workspace are out of scope by definition. */
  enforceScope?: boolean;
}

interface Pattern {
  kind: FindingKind;
  label: string;
  re: RegExp;
  severity: "block" | "redact" | "warn";
  /** Extra check to cut false positives (card numbers via Luhn, etc). */
  verify?: (match: string) => boolean;
}

const SECRET_PATTERNS: Pattern[] = [
  {
    kind: "secret",
    label: "anthropic key",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
    severity: "block",
  },
  { kind: "secret", label: "openai key", re: /\bsk-[A-Za-z0-9]{32,}/g, severity: "block" },
  {
    kind: "secret",
    label: "github token",
    re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
    severity: "block",
  },
  { kind: "secret", label: "aws access key", re: /\bAKIA[0-9A-Z]{16}\b/g, severity: "block" },
  {
    kind: "secret",
    label: "slack token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    severity: "block",
  },
  {
    kind: "secret",
    label: "private key",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    severity: "block",
  },
  {
    kind: "secret",
    label: "bearer token",
    re: /\b[Aa]uthorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/g,
    severity: "block",
  },
];

const PII_PATTERNS: Pattern[] = [
  {
    kind: "pii",
    label: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    severity: "redact",
  },
  {
    kind: "pii",
    label: "credit card",
    re: /\b(?:\d[ -]*?){13,16}\b/g,
    severity: "redact",
    // Without Luhn this fires on every long number — version strings, ids,
    // timestamps — and users learn to ignore the guard entirely.
    verify: luhn,
  },
  { kind: "pii", label: "us ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g, severity: "redact" },
  {
    kind: "pii",
    label: "phone",
    re: /\b\+?\d{1,3}[ -]?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b/g,
    severity: "redact",
  },
];

/**
 * Phrases that only appear when someone is trying to talk past the system
 * prompt. Matched against USER input, where they are suspicious but not
 * necessarily hostile — a developer may legitimately be asking about prompt
 * injection. So these warn rather than block; the hard boundary is the output
 * guard, which is where genuinely untrusted content arrives.
 */
const INJECTION_PATTERNS: Pattern[] = [
  {
    kind: "injection",
    label: "instruction override",
    re: /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:your\s+|the\s+|previous\s+|prior\s+|above\s+)+(?:instructions?|rules?|prompts?|directives?)/gi,
    severity: "warn",
  },
  {
    kind: "injection",
    label: "role reassignment",
    re: /\byou\s+are\s+now\s+(?:a|an|the)\b|\bnew\s+system\s+prompt\b|\bdeveloper\s+mode\b/gi,
    severity: "warn",
  },
  {
    kind: "injection",
    label: "forged role marker",
    re: /^\s*(?:system|assistant)\s*:/gim,
    severity: "warn",
  },
  {
    kind: "injection",
    label: "fence forgery",
    re: /<<<\/?(?:END_)?UNTRUSTED_DATA/gi,
    severity: "block",
  },
];

/**
 * The first box in the flow: "Guard the input (PII, injection, scope)".
 *
 * Note what this is NOT. It is not the defence against prompt injection from
 * tool output — that is the output guard, and it works by fencing rather than
 * pattern matching, because pattern matching hostile content is a losing game.
 * This guard exists for two narrower jobs it can actually do well:
 *
 *   1. Stop a credential the user pasted from being shipped to a cloud model
 *      and then written into a durable event log.
 *   2. Notice when the user's own text contains something shaped like an
 *      injection, which usually means they pasted content from elsewhere and
 *      should be told where it came from.
 *
 * Fence-forgery markers are the one hard block: those exist only to break the
 * output guard's envelope, and there is no legitimate reason for them to
 * appear in typed input.
 */
export class InputGuard {
  private options: InputGuardOptions;

  constructor(options: InputGuardOptions = {}) {
    this.options = options;
  }

  inspect(input: string): InputGuardResult {
    const findings: GuardFinding[] = [];
    const active: Pattern[] = [
      ...SECRET_PATTERNS,
      ...(this.options.redactPii === false ? [] : PII_PATTERNS),
      ...INJECTION_PATTERNS,
    ];

    for (const pattern of active) {
      pattern.re.lastIndex = 0;
      for (const m of input.matchAll(pattern.re)) {
        const value = m[0];
        if (pattern.verify && !pattern.verify(value)) continue;
        findings.push({
          kind: pattern.kind,
          label: pattern.label,
          start: m.index ?? 0,
          end: (m.index ?? 0) + value.length,
          severity: pattern.severity,
        });
      }
    }

    if (this.options.enforceScope && this.options.workspaceRoot) {
      for (const m of input.matchAll(/(?:^|\s)((?:[A-Za-z]:[\\/]|\/)[^\s'"`]{4,})/g)) {
        const path = m[1] ?? "";
        if (isInside(path, this.options.workspaceRoot)) continue;
        findings.push({
          kind: "scope",
          label: `path outside workspace: ${path}`,
          start: m.index ?? 0,
          end: (m.index ?? 0) + m[0].length,
          severity: "warn",
        });
      }
    }

    const blocking = findings.filter((f) => f.severity === "block");
    const text = redact(
      input,
      findings.filter((f) => f.severity === "redact" || f.severity === "block"),
    );

    return {
      text,
      findings: findings.sort((a, b) => a.start - b.start),
      blocked: blocking.length > 0,
      ...(blocking.length > 0
        ? {
            reason:
              `input contains ${blocking.map((f) => f.label).join(", ")}. ` +
              `Remove it and try again — it was not sent to any model and is not in the event log.`,
          }
        : {}),
    };
  }
}

/** Replaces spans right-to-left so earlier offsets stay valid. */
function redact(input: string, findings: readonly GuardFinding[]): string {
  const ordered = [...findings].sort((a, b) => b.start - a.start);
  let out = input;
  for (const f of ordered) {
    out = out.slice(0, f.start) + `[REDACTED:${f.label}]` + out.slice(f.end);
  }
  return out;
}

function isInside(path: string, root: string): boolean {
  const norm = (s: string): string => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const p = norm(path);
  const r = norm(root);
  return p === r || p.startsWith(r + "/");
}

/** Luhn checksum — the difference between a card number and any long number. */
export function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
