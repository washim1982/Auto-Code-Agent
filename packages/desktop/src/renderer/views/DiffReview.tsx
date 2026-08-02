import React, { useMemo, useState } from "react";
import type { DiffFile } from "./shared.ts";

interface Hunk {
  id: number;
  beforeStart: number;
  afterStart: number;
  lines: { kind: "same" | "add" | "del"; text: string; beforeNo?: number; afterNo?: number }[];
}

/**
 * Line diff.
 *
 * A longest-common-subsequence walk rather than a word-level diff: reviewing
 * agent output is about "did it change the right lines", and character-level
 * highlighting inside a line is noise at that altitude.
 */
function diffLines(before: string, after: string): Hunk[] {
  const a = before.split("\n");
  const b = after.split("\n");

  // Standard LCS table. Files here are capped at 60k by the daemon, so the
  // quadratic table is bounded.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const rows: Hunk["lines"] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: "same", text: a[i]!, beforeNo: i + 1, afterNo: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ kind: "del", text: a[i]!, beforeNo: i + 1 });
      i++;
    } else {
      rows.push({ kind: "add", text: b[j]!, afterNo: j + 1 });
      j++;
    }
  }
  while (i < a.length) rows.push({ kind: "del", text: a[i]!, beforeNo: ++i });
  while (j < b.length) rows.push({ kind: "add", text: b[j]!, afterNo: ++j });

  // Group into hunks with three lines of context, so a large file with one
  // change does not render as thousands of unchanged rows.
  const changed = rows.map((r) => r.kind !== "same");
  const keep = new Set<number>();
  changed.forEach((isChanged, idx) => {
    if (!isChanged) return;
    for (let k = Math.max(0, idx - 3); k <= Math.min(rows.length - 1, idx + 3); k++)
      keep.add(k);
  });

  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  rows.forEach((row, idx) => {
    if (!keep.has(idx)) {
      current = null;
      return;
    }
    if (!current) {
      current = {
        id: hunks.length,
        beforeStart: row.beforeNo ?? 0,
        afterStart: row.afterNo ?? 0,
        lines: [],
      };
      hunks.push(current);
    }
    current.lines.push(row);
  });

  return hunks;
}

/**
 * Diff review with per-hunk rejection.
 *
 * Rejecting a hunk attaches the note as a hard constraint and re-runs the node
 * — this is where a human actually reviews the agent's work, and the round
 * count is stated inline so the cap is never a surprise.
 */
export function DiffReview({
  files,
  onReject,
  reviewRoundsLeft,
}: {
  files: DiffFile[];
  onReject: (file: string, hunk: number, note: string) => void;
  reviewRoundsLeft: number;
}): JSX.Element {
  const [selected, setSelected] = useState(0);
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [note, setNote] = useState("");

  const file = files[selected];
  const hunks = useMemo(() => (file ? diffLines(file.before, file.after) : []), [file]);

  if (files.length === 0) {
    return <div className="empty">No changes. Run something to review it here.</div>;
  }

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <div className="col left" style={{ width: 250, borderRight: "1px solid var(--line)" }}>
        <div className="phead">Changed files</div>
        <div className="pbody">
          <div className="ftree">
            {files.map((f, i) => {
              const h = diffLines(f.before, f.after);
              const adds = h.reduce(
                (s, x) => s + x.lines.filter((l) => l.kind === "add").length,
                0,
              );
              const dels = h.reduce(
                (s, x) => s + x.lines.filter((l) => l.kind === "del").length,
                0,
              );
              return (
                <div
                  key={f.file}
                  className={`fr${i === selected ? " on" : ""}`}
                  onClick={() => {
                    setSelected(i);
                    setRejecting(null);
                  }}
                >
                  <span className="nm">{f.file}</span>
                  <span className="tw" style={{ color: "var(--moss)" }}>
                    +{adds}
                  </span>
                  <span className="tw" style={{ color: "var(--crimson)" }}>
                    −{dels}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="col center">
        <div className="phead">
          {file?.file ?? "—"}
          <span className="r">
            <span>{hunks.length} hunks</span>
            <span>{reviewRoundsLeft} review rounds left</span>
          </span>
        </div>

        <div className="pbody flush" style={{ overflow: "auto" }}>
          {hunks.length === 0 && <div className="empty">Identical.</div>}

          {hunks.map((h) => (
            <div key={h.id} style={{ borderBottom: "1px solid var(--line)" }}>
              <div
                className="dl hunk"
                style={{ display: "flex", alignItems: "center", padding: "4px 8px" }}
              >
                <span style={{ fontFamily: "var(--mono)", fontSize: 10.5 }}>
                  @@ −{h.beforeStart} +{h.afterStart} @@
                </span>
                <span style={{ marginLeft: "auto" }}>
                  <button className="btn danger" onClick={() => setRejecting(h.id)}>
                    reject hunk
                  </button>
                </span>
              </div>

              <div className="diffpane" style={{ height: "auto" }}>
                <div>
                  {h.lines.map((l, k) =>
                    l.kind === "add" ? (
                      <div key={k} className="dl">
                        <span className="ln" />
                        <span className="tx" />
                      </div>
                    ) : (
                      <div key={k} className={`dl${l.kind === "del" ? " del" : ""}`}>
                        <span className="ln">{l.beforeNo ?? ""}</span>
                        <span className="tx">{l.text}</span>
                      </div>
                    ),
                  )}
                </div>
                <div>
                  {h.lines.map((l, k) =>
                    l.kind === "del" ? (
                      <div key={k} className="dl">
                        <span className="ln" />
                        <span className="tx" />
                      </div>
                    ) : (
                      <div key={k} className={`dl${l.kind === "add" ? " add" : ""}`}>
                        <span className="ln">{l.afterNo ?? ""}</span>
                        <span className="tx">{l.text}</span>
                      </div>
                    ),
                  )}
                </div>
              </div>

              {rejecting === h.id && (
                <div
                  style={{
                    padding: 10,
                    borderTop: "1px solid var(--line)",
                    background: "var(--s1)",
                  }}
                >
                  <input
                    autoFocus
                    value={note}
                    placeholder="what is wrong with this hunk? (becomes a hard constraint)"
                    onChange={(e) => setNote(e.target.value)}
                    style={{
                      width: "100%",
                      background: "var(--s2)",
                      border: "1px solid var(--line-2)",
                      borderRadius: 2,
                      color: "var(--ink)",
                      padding: "6px 9px",
                      fontSize: 12.5,
                      marginBottom: 8,
                    }}
                  />
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      className="btn danger"
                      onClick={() => {
                        if (file) onReject(file.file, h.id, note);
                        setRejecting(null);
                        setNote("");
                      }}
                    >
                      Reject &amp; re-run node
                    </button>
                    <button className="btn" onClick={() => setRejecting(null)}>
                      Cancel
                    </button>
                    <span
                      className="dim"
                      style={{ marginLeft: "auto", fontSize: 11, alignSelf: "center" }}
                    >
                      {reviewRoundsLeft} rounds remain before it escalates
                    </span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
