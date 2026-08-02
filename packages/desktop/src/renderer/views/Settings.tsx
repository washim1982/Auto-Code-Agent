import React, { useState } from "react";

type Permission = "allow" | "ask" | "deny";
export type PermissionMatrix = Record<string, Record<string, Permission>>;

export interface AcaConfigShape {
  providers: { ollamaHost: string; lmStudioHost: string; llamaCppHost: string };
  router: { privacy: "local-only" | "prefer-local" | "any"; pinnedModel: string | null };
  budget: { maxTokens: number; maxCostUsd: number; maxWallMs: number };
  sandbox: { defaultTier: "t0" | "t1" | "t2"; timeoutMs: number; maxOutputBytes: number };
  run: { maxAttempts: number; maxReviewRounds: number; concurrency: number };
  memory: { embeddingModel: string; indexOnOpen: boolean };
}

const TOOLS = [
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "write_file",
  "edit_file",
  "run_command",
  "git_push",
];
const PERSONAS = ["planner", "coder", "tester", "reviewer", "summarizer", "chat"];

/**
 * Settings.
 *
 * The permission matrix is the centrepiece rather than an advanced tab: it is
 * the clearest statement of what the agent may do, resolved once at pre-flight
 * so a node can never discover new permissions mid-run.
 */
export function Settings({
  config,
  permissions,
  root,
  onSave,
}: {
  config: AcaConfigShape;
  permissions: PermissionMatrix;
  root: string;
  onSave: (next: AcaConfigShape) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(config);
  const [section, setSection] = useState<"permissions" | "privacy" | "sandbox" | "budget">(
    "permissions",
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);

  const localOnly = draft.router.privacy === "local-only";

  return (
    <>
      <div className="col left" style={{ width: 200 }}>
        <div className="phead">Settings</div>
        <div className="pbody">
          <div className="mono" style={{ fontSize: 11.5 }}>
            {(["permissions", "privacy", "sandbox", "budget"] as const).map((s) => (
              <div
                key={s}
                onClick={() => setSection(s)}
                style={{
                  padding: "6px 9px",
                  borderRadius: 2,
                  cursor: "pointer",
                  background: section === s ? "var(--ember-dim)" : undefined,
                  color: section === s ? "var(--ember)" : "var(--ink-3)",
                }}
              >
                {s}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="col center">
        <div className="phead">
          {section}
          <span className="r">
            {dirty && (
              <button className="btn primary" onClick={() => onSave(draft)}>
                Save to workspace
              </button>
            )}
          </span>
        </div>

        <div className="pbody">
          {section === "permissions" && (
            <>
              <p className="dim" style={{ fontSize: 13, marginBottom: 16, maxWidth: "62ch" }}>
                Resolved once at pre-flight. A node can never discover new permissions mid-run —
                if it needs something not granted here, it parks and escalates.
              </p>
              <table className="matrix">
                <thead>
                  <tr>
                    <th>Tool</th>
                    {PERSONAS.map((p) => (
                      <th key={p}>{p}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {TOOLS.map((tool) => (
                    <tr key={tool}>
                      <td>
                        {tool}
                        {tool === "git_push" && (
                          <span style={{ color: "var(--crimson)" }}> irreversible</span>
                        )}
                      </td>
                      {PERSONAS.map((p) => {
                        const v = permissions[p]?.[tool] ?? "deny";
                        return (
                          <td key={p}>
                            <span className={`mk ${v}`}>{v}</span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p
                className="dim"
                style={{ fontSize: 12.5, marginTop: 16, maxWidth: "62ch", lineHeight: 1.6 }}
              >
                The summarizer is denied everything by design — it reads untrusted tool output,
                so it runs tool-less in a disposable context.
              </p>
            </>
          )}

          {section === "privacy" && (
            <div style={{ maxWidth: 560 }}>
              <div
                style={{
                  border: `1px solid ${localOnly ? "var(--ember)" : "var(--line-2)"}`,
                  background: localOnly ? "var(--ember-dim)" : "var(--s2)",
                  borderRadius: "var(--r)",
                  padding: 12,
                  marginBottom: 18,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span
                    className="mono"
                    style={{ fontSize: 11, color: localOnly ? "var(--ember)" : "var(--ink-2)" }}
                  >
                    local-only
                  </span>
                  <button
                    className={`toggle${localOnly ? " on" : ""}`}
                    style={{ marginLeft: "auto" }}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        router: {
                          ...draft.router,
                          privacy: localOnly ? "prefer-local" : "local-only",
                        },
                      })
                    }
                  >
                    <i />
                  </button>
                </div>
                <p className="dim" style={{ fontSize: 12.5, margin: 0, lineHeight: 1.5 }}>
                  Cloud adapters are disabled globally and greyed out in the model manager. No
                  request leaves this machine.
                </p>
              </div>

              <div className="specrow">
                <b>ollama</b>
                <span>{draft.providers.ollamaHost}</span>
              </div>
              <div className="specrow">
                <b>lm studio</b>
                <span>{draft.providers.lmStudioHost}</span>
              </div>
              <div className="specrow">
                <b>llama.cpp</b>
                <span>{draft.providers.llamaCppHost}</span>
              </div>

              <p className="dim" style={{ fontSize: 12.5, marginTop: 16, lineHeight: 1.6 }}>
                Saving writes to <span className="mono">{root}/.aca/config.json</span>. The
                workspace layer sits above your personal default, so a repo can pin local-only
                and have it hold for everyone who opens it.
              </p>
            </div>
          )}

          {section === "sandbox" && (
            <div style={{ maxWidth: 560 }}>
              <div className="specrow">
                <b>default tier</b>
                <span>{draft.sandbox.defaultTier} — subprocess, cwd jail, no network</span>
              </div>
              <div className="specrow">
                <b>timeout</b>
                <span>{Math.round(draft.sandbox.timeoutMs / 1000)}s</span>
              </div>
              <div className="specrow">
                <b>output cap</b>
                <span>{Math.round(draft.sandbox.maxOutputBytes / 1024 / 1024)} MB</span>
              </div>
              <div className="specrow">
                <b>untrusted code</b>
                <span>T2 docker</span>
              </div>

              <p className="dim" style={{ fontSize: 12.5, marginTop: 16, lineHeight: 1.6 }}>
                Windows has no seccomp equivalent. At T1 the path jail is enforced by the tool
                layer rather than the OS — it guards against mistakes, not a determined escape,
                and the checkpoint re-hashes the tree afterwards to detect what it cannot
                prevent. Docker is the real boundary.
              </p>
            </div>
          )}

          {section === "budget" && (
            <div style={{ maxWidth: 560 }}>
              <div className="specrow">
                <b>max tokens per run</b>
                <span>{draft.budget.maxTokens.toLocaleString()}</span>
              </div>
              <div className="specrow">
                <b>max cost</b>
                <span>${draft.budget.maxCostUsd.toFixed(2)}</span>
              </div>
              <div className="specrow">
                <b>wall clock</b>
                <span>{Math.round(draft.budget.maxWallMs / 60000)} min</span>
              </div>
              <div className="specrow">
                <b>attempts per node</b>
                <span>{draft.run.maxAttempts}</span>
              </div>
              <div className="specrow">
                <b>review rounds</b>
                <span>{draft.run.maxReviewRounds}</span>
              </div>

              <p className="dim" style={{ fontSize: 12.5, marginTop: 16, lineHeight: 1.6 }}>
                Attempts are total executions, not retries on top of a first try. Crossing a
                budget threshold warns; passing it stops the run.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
