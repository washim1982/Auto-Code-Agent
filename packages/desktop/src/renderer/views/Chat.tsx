import React, { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown.tsx";
import type { ModelRow } from "./shared.ts";

export interface ThreadEntry {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  model?: string;
  thinking?: string;
  untrusted?: boolean;
  /** The result tried to close its own fence — an attack, not routine. */
  forgery?: boolean;
  toolName?: string;
}

export interface PlanProposal {
  runId: string;
  nodes: { id: string; title: string; deps: string[]; sets: { write: string[] } }[];
  acceptance: string[];
  problems: { severity: string; nodeId?: string; message: string }[];
  model: string;
}

export interface ContextLayer {
  rank: number;
  label: string;
  tokens: number;
  pinned: boolean;
  untrusted: boolean;
}

/**
 * The chat view — the spine of the product.
 *
 * A run is not a separate mode: it is what a conversation escalates into, and
 * the plan arrives inline as a card rather than in a modal. The turn that
 * produced it stays in the thread as provenance.
 */
export function Chat({
  thread,
  streaming,
  plan,
  models,
  activeModel,
  contextLayers,
  contextWindow,
  busy,
  onSend,
  onModelChange,
  onApprovePlan,
  onRejectPlan,
}: {
  thread: ThreadEntry[];
  streaming: { text: string; thinking: string } | null;
  plan: PlanProposal | null;
  models: ModelRow[];
  activeModel: string;
  contextLayers: ContextLayer[];
  contextWindow: number;
  busy: boolean;
  onSend: (text: string) => void;
  onModelChange: (id: string) => void;
  onApprovePlan: (runId: string) => void;
  onRejectPlan: (runId: string, reason: string) => void;
}): JSX.Element {
  const [input, setInput] = useState("");
  const [showThinking, setShowThinking] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread.length, streaming?.text, plan]);

  const send = (): void => {
    const value = input.trim();
    if (!value || busy) return;
    setInput("");
    onSend(value);
  };

  const totalTokens = contextLayers.reduce((s, l) => s + l.tokens, 0);
  const resident = models.filter((m) => m.state === "resident");
  const cold = models.filter((m) => m.state !== "resident" && !/embed/i.test(m.id));

  return (
    <>
      <div className="col center">
        <div className="phead">
          Session
          <span className="r">
            <button
              className={`btn${showThinking ? " primary" : ""}`}
              onClick={() => setShowThinking((s) => !s)}
              title="Thinking tokens are often the majority of the spend"
            >
              thinking
            </button>
            <span>{thread.length} turns</span>
          </span>
        </div>

        <div className="pbody flush" style={{ display: "flex", flexDirection: "column" }}>
          <div className="thread" style={{ flex: 1, overflow: "auto" }}>
            {thread.length === 0 && !streaming && (
              <div className="empty">
                Ask a question about this workspace, or describe a change to plan one.
              </div>
            )}

            {thread.map((t) => (
              <Turn key={t.id} entry={t} showThinking={showThinking} />
            ))}

            {streaming && (
              <Turn
                entry={{
                  id: "streaming",
                  role: "assistant",
                  content: streaming.text,
                  model: activeModel,
                  ...(streaming.thinking ? { thinking: streaming.thinking } : {}),
                }}
                showThinking={showThinking}
                live
              />
            )}

            {plan && <PlanCard plan={plan} onApprove={onApprovePlan} onReject={onRejectPlan} />}

            <div ref={bottom} />
          </div>

          <div className="composer">
            <textarea
              value={input}
              placeholder={busy ? "working…" : "Ask, or describe a change…"}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; shift+enter is a newline. Reversing this is the
                // single most complained-about choice in any chat UI.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="crow">
              <label className="sel">
                <span>model</span>
                <select value={activeModel} onChange={(e) => onModelChange(e.target.value)}>
                  {resident.length > 0 && (
                    <optgroup label="resident">
                      {resident.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {cold.length > 0 && (
                    <optgroup label="cold — first use pays the load">
                      {cold.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
              <span className="sel">
                <span>tools</span>
                <span className="v">read-only</span>
              </span>
              <span style={{ marginLeft: "auto" }}>
                {totalTokens.toLocaleString()} / {contextWindow.toLocaleString()} ctx
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="col right">
        <div className="phead">
          Context
          <span className="r">
            <span>live</span>
          </span>
        </div>
        <div className="pbody">
          <ContextInspector layers={contextLayers} window={contextWindow} model={activeModel} />
        </div>
      </div>
    </>
  );
}

function Turn({
  entry,
  showThinking,
  live,
}: {
  entry: ThreadEntry;
  showThinking: boolean;
  live?: boolean;
}): JSX.Element {
  if (entry.role === "tool") {
    return (
      <div className="turn">
        <span className="av" style={{ background: "var(--s3)", color: "var(--ink-3)" }}>
          ⚙
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span className="toolchip">
            <span style={{ color: "var(--moss)" }}>✓</span>
            <b>{entry.toolName ?? "tool"}</b>
            <span className="dim">{entry.content.slice(0, 70)}</span>
            {/* Fencing happens to every tool result, so it is a quiet badge
                rather than a banner — a warning shown every single time is one
                nobody reads. */}
            {entry.untrusted && (
              <span
                className="fence"
                title="Tool output is wrapped in an untrusted-data envelope before the model sees it. The model is instructed to treat it as data and never as instructions. This is routine, not a problem."
              >
                fenced
              </span>
            )}
          </span>
          {/* This one is not routine: the content tried to close the envelope
              from the inside, which only happens on purpose. */}
          {entry.forgery && (
            <div className="untrusted" style={{ marginTop: 7 }}>
              ⚠ this content tried to break out of its untrusted-data fence — neutralised
            </div>
          )}
        </div>
      </div>
    );
  }

  const isUser = entry.role === "user";
  return (
    <div className={`turn ${isUser ? "user" : "model"}`}>
      <span className="av">
        {isUser ? "YOU" : (entry.model ?? "AI").slice(0, 3).toUpperCase()}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="who">
          {isUser ? "you" : (entry.model ?? "assistant")}
          {live && <span style={{ color: "var(--ember)" }}> · streaming</span>}
          {entry.thinking && !showThinking && (
            <span className="dim">
              {" "}
              · {Math.ceil(entry.thinking.length / 4)} thinking tokens
            </span>
          )}
        </div>
        {entry.thinking && showThinking && <div className="think">{entry.thinking}</div>}
        {/* The user's own text is shown exactly as typed; only the model
            answers in Markdown. */}
        {isUser ? (
          <div className="msg">{entry.content}</div>
        ) : (
          <Markdown source={entry.content} />
        )}
      </div>
    </div>
  );
}

/**
 * The plan, inline in the thread.
 *
 * The write-set column is the load-bearing one: it is what the user is really
 * approving, because it bounds everything the run can touch.
 */
function PlanCard({
  plan,
  onApprove,
  onReject,
}: {
  plan: PlanProposal;
  onApprove: (runId: string) => void;
  onReject: (runId: string, reason: string) => void;
}): JSX.Element {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const warnings = plan.problems.filter((p) => p.severity === "warning");

  return (
    <div className="plancard">
      <div className="ph2">
        <span>▸ proposed plan · {plan.nodes.length} nodes</span>
        <span
          style={{ marginLeft: "auto", textTransform: "none", letterSpacing: 0 }}
          className="dim"
        >
          {plan.model}
        </span>
      </div>

      <div style={{ padding: "8px 0" }}>
        {plan.nodes.map((n) => (
          <div key={n.id} className="pn2">
            <span className="dim" style={{ width: 90, flex: "none" }}>
              {n.id}
            </span>
            <span>
              {n.title}
              {n.deps.length > 0 && <span className="dim"> ←{n.deps.join(",")}</span>}
            </span>
            <span className="w">{n.sets.write.join(", ") || "read-only"}</span>
          </div>
        ))}
      </div>

      {plan.acceptance.length > 0 && (
        <div style={{ borderTop: "1px solid var(--line)", padding: "8px 11px" }}>
          <div
            className="dim mono"
            style={{
              fontSize: 9.5,
              letterSpacing: ".1em",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Acceptance
          </div>
          {plan.acceptance.map((a) => (
            <div key={a} style={{ fontSize: 12.5, color: "var(--ink-2)", padding: "2px 0" }}>
              <span style={{ color: "var(--slate)" }}>○</span> {a}
            </div>
          ))}
        </div>
      )}

      {warnings.length > 0 && (
        <div style={{ borderTop: "1px solid var(--line)", padding: "8px 11px" }}>
          {warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 12, color: "var(--wheat)" }}>
              ⚠ {w.nodeId ? `[${w.nodeId}] ` : ""}
              {w.message}
            </div>
          ))}
        </div>
      )}

      <div className="pf">
        {rejecting ? (
          <>
            <input
              autoFocus
              value={reason}
              placeholder="why? (fed into replanning)"
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onReject(plan.runId, reason)}
              style={{
                flex: 1,
                background: "var(--s2)",
                border: "1px solid var(--line-2)",
                borderRadius: 2,
                color: "var(--ink)",
                padding: "4px 8px",
                fontFamily: "var(--mono)",
                fontSize: 11,
              }}
            />
            <button className="btn danger" onClick={() => onReject(plan.runId, reason)}>
              Reject
            </button>
          </>
        ) : (
          <>
            <button className="btn primary" onClick={() => onApprove(plan.runId)}>
              Approve &amp; run
            </button>
            <button className="btn danger" onClick={() => setRejecting(true)}>
              Reject
            </button>
            <span
              className="dim"
              style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10 }}
            >
              irreversible steps ask again at execution
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What is in the window right now, as the priority ladder.
 *
 * "What did the model actually see" is the first question in every agent
 * debugging session and is normally unanswerable.
 */
export function ContextInspector({
  layers,
  window: windowSize,
  model,
}: {
  layers: ContextLayer[];
  window: number;
  model: string;
}): JSX.Element {
  if (layers.length === 0) {
    return <div className="empty">Nothing assembled yet.</div>;
  }
  const total = layers.reduce((s, l) => s + l.tokens, 0);
  const budget = Math.floor(windowSize * 0.75);

  return (
    <div className="ladder">
      <div
        className="dim mono"
        style={{
          fontSize: 10,
          letterSpacing: ".1em",
          textTransform: "uppercase",
          marginBottom: 8,
        }}
      >
        Assembled window · priority ladder
      </div>
      {layers.map((l, i) => (
        <div
          key={l.label}
          className="lr"
          style={l.untrusted ? { background: "var(--crimson-dim)" } : undefined}
        >
          <span className="n">{i + 1}</span>
          <span className="l" style={l.untrusted ? { color: "var(--crimson)" } : undefined}>
            {l.untrusted ? "⚠ " : ""}
            {l.label}
          </span>
          <span className="tk">{l.tokens.toLocaleString()}</span>
          {l.pinned && <span className="pill p-mute">pinned</span>}
        </div>
      ))}
      <div style={{ display: "flex", paddingTop: 9, color: "var(--ink-3)", fontSize: 11 }}>
        <span>
          {total.toLocaleString()} / {budget.toLocaleString()}
        </span>
        <span style={{ marginLeft: "auto", color: "var(--ink)" }}>{model}</span>
      </div>
      <div className="meter">
        <i style={{ width: `${Math.min(100, (total / Math.max(budget, 1)) * 100)}%` }} />
      </div>
      <p className="dim" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.5 }}>
        25% of the window is held back for output. Unpinned layers are evicted bottom-up when
        the budget is tight.
      </p>
    </div>
  );
}
