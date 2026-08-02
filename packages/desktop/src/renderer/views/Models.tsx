import React, { useMemo, useState } from "react";
import { fmtBytes, fmtCtx, type ModelRow, type Scorecard } from "./shared.ts";

export interface ProviderHealth {
  id: string;
  up: boolean;
  models: number;
  detail: string;
}

/**
 * Model manager.
 *
 * Two things here that most model pickers omit and that matter on a
 * local-first setup: context shown as *probed / advertised* so the gap is
 * visible, and a routing simulator whose excluded list explains why each
 * candidate lost. The exclusions are the more useful half — "why did it pick
 * that one" is usually really "why not this one".
 */
export function Models({
  models,
  scorecards,
  providers,
  resident,
  slots,
  probing,
  onProbe,
}: {
  models: ModelRow[];
  scorecards: Scorecard[];
  providers: ProviderHealth[];
  resident: { provider: string; model: string }[];
  slots: number;
  probing: { model: string; done: number; total: number } | null;
  onProbe: (model?: string) => void;
}): JSX.Element {
  const [purpose, setPurpose] = useState<"code" | "review" | "plan" | "summarize">("code");
  const [minContext, setMinContext] = useState(16384);
  const [localOnly, setLocalOnly] = useState(true);

  const cards = useMemo(
    () => new Map(scorecards.map((s) => [`${s.provider}/${s.model}`, s])),
    [scorecards],
  );

  /**
   * Mirrors the router's hard filter. Deliberately a re-implementation rather
   * than an RPC: the point is to answer "why would this node route here"
   * instantly while the user drags the sliders.
   */
  const simulation = useMemo(() => {
    const eligible: { m: ModelRow; score: number }[] = [];
    const excluded: { m: ModelRow; reason: string }[] = [];

    for (const m of models) {
      const card = cards.get(`${m.provider}/${m.id}`);
      const realCtx = card?.realContext ?? m.caps.contextWindow;
      const tools = card?.tools ?? m.caps.tools;

      if (localOnly && m.caps.privacyTier !== "local") {
        excluded.push({ m, reason: "privacy is local-only" });
      } else if (/embed/i.test(m.id)) {
        excluded.push({ m, reason: "embedding-only model" });
      } else if (tools === "none" && purpose !== "summarize") {
        excluded.push({ m, reason: "no tool support" });
      } else if (realCtx < minContext) {
        excluded.push({
          m,
          reason: `context ${fmtCtx(realCtx)} < required ${fmtCtx(minContext)}${card ? " (measured)" : ""}`,
        });
      } else {
        const scale =
          m.sizeBytes > 0
            ? Math.min(Math.log10(m.sizeBytes / 1e9 + 1) / Math.log10(41), 1)
            : 0.5;
        const capability = card ? 0.5 * scale + 0.5 * card.reliability : scale;
        const residencyBonus = m.state === "resident" ? 1 : 0;
        const weights =
          purpose === "review" || purpose === "plan"
            ? { cap: 0.58, res: 0.05 }
            : purpose === "summarize"
              ? { cap: 0.1, res: 0.4 }
              : { cap: 0.3, res: 0.35 };
        eligible.push({
          m,
          score: weights.cap * capability + weights.res * residencyBonus + 0.3,
        });
      }
    }

    eligible.sort((a, b) => b.score - a.score);
    return { eligible, excluded };
  }, [models, cards, purpose, minContext, localOnly]);

  return (
    <>
      <div className="col left" style={{ width: 260 }}>
        <div className="phead">
          Providers
          <span className="r">
            <span>{providers.filter((p) => p.up).length}</span>
          </span>
        </div>
        <div className="pbody">
          {providers.map((p) => (
            <div key={p.id} className="provcard">
              <div className="ph3">
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: p.up ? "var(--moss)" : "var(--slate)",
                  }}
                />
                <span className="pn3">{p.id}</span>
                <span
                  className={`pill ${p.up ? "p-done" : "p-block"}`}
                  style={{ marginLeft: "auto" }}
                >
                  {p.up ? "up" : "down"}
                </span>
              </div>
              <div className="pm">
                <span>{p.detail}</span>
                <span>{p.models} models</span>
              </div>
            </div>
          ))}

          <div
            className="phead"
            style={{ margin: "14px -12px 0", borderTop: "1px solid var(--line)" }}
          >
            Resident
            <span className="r">
              <span>{slots} slots</span>
            </span>
          </div>
          <div
            style={{
              paddingTop: 10,
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              color: "var(--ink-3)",
            }}
          >
            {resident.length === 0 && <div>nothing loaded</div>}
            {resident.map((r) => (
              <div
                key={`${r.provider}/${r.model}`}
                style={{ display: "flex", gap: 8, padding: "3px 0" }}
              >
                <span style={{ color: "var(--ember)" }}>●</span>
                <span>{r.model}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="col center">
        <div className="phead">
          Installed models
          <span className="r">
            <span>ctx shown as probed / advertised</span>
            <button className="btn" onClick={() => onProbe()} disabled={Boolean(probing)}>
              {probing ? `probing ${probing.done}/${probing.total}` : "probe all"}
            </button>
          </span>
        </div>
        <div className="pbody">
          {probing && (
            <div className="dim mono" style={{ fontSize: 11, marginBottom: 10 }}>
              measuring {probing.model} — this takes a few minutes per model, once
            </div>
          )}
          <table className="dt">
            <thead>
              <tr>
                <th>Model</th>
                <th>Provider</th>
                <th>State</th>
                <th>Ctx</th>
                <th>Quant</th>
                <th>Size</th>
                <th>Tools</th>
                <th>Reliability</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const card = cards.get(`${m.provider}/${m.id}`);
                const drift = card && card.realContext < m.caps.contextWindow;
                return (
                  <tr key={`${m.provider}/${m.id}`}>
                    <td className="name">{m.id}</td>
                    <td>{m.provider}</td>
                    <td>
                      <span className={`pill ${m.state === "resident" ? "p-run" : "p-block"}`}>
                        {m.state}
                      </span>
                    </td>
                    <td style={drift ? { color: "var(--crimson)" } : undefined}>
                      {card ? fmtCtx(card.realContext) : "—"}
                      <span className="dim"> / {fmtCtx(m.caps.contextWindow)}</span>
                    </td>
                    <td>{m.quantization || "—"}</td>
                    <td>{fmtBytes(m.sizeBytes)}</td>
                    <td
                      style={{
                        color:
                          (card?.tools ?? m.caps.tools) === "native"
                            ? "var(--moss)"
                            : "var(--wheat)",
                      }}
                    >
                      {card?.tools ?? m.caps.tools}
                    </td>
                    <td>
                      {card ? (
                        <>
                          <span
                            className="bar-outer"
                            style={{
                              display: "inline-block",
                              width: 40,
                              height: 4,
                              background: "var(--s3)",
                              borderRadius: 2,
                              marginRight: 6,
                              verticalAlign: "middle",
                            }}
                          >
                            <span
                              style={{
                                display: "block",
                                height: "100%",
                                width: `${card.reliability * 100}%`,
                                background:
                                  card.reliability >= 0.8
                                    ? "var(--moss)"
                                    : card.reliability >= 0.5
                                      ? "var(--wheat)"
                                      : "var(--crimson)",
                              }}
                            />
                          </span>
                          {card.reliability.toFixed(2)}
                        </>
                      ) : (
                        <span className="dim">unprobed</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {scorecards.length === 0 && (
            <p
              className="dim"
              style={{ fontSize: 12, marginTop: 14, lineHeight: 1.6, maxWidth: "60ch" }}
            >
              Nothing has been probed yet, so routing is filtering on numbers the provider
              claimed rather than numbers anyone checked. Probing takes a few minutes per model
              and pays for itself immediately.
            </p>
          )}
        </div>
      </div>

      <div className="col right">
        <div className="phead">Routing simulator</div>
        <div className="pbody">
          <div
            className="dim mono"
            style={{
              fontSize: 10,
              letterSpacing: ".1em",
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            Requirement
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
            <label className="sel">
              <span>purpose</span>
              <select
                value={purpose}
                onChange={(e) => setPurpose(e.target.value as typeof purpose)}
              >
                <option value="code">code</option>
                <option value="review">review</option>
                <option value="plan">plan</option>
                <option value="summarize">summarize</option>
              </select>
            </label>
            <label className="sel">
              <span>min ctx</span>
              <select
                value={minContext}
                onChange={(e) => setMinContext(Number(e.target.value))}
              >
                {[8192, 16384, 32768, 65536, 131072].map((n) => (
                  <option key={n} value={n}>
                    {fmtCtx(n)}
                  </option>
                ))}
              </select>
            </label>
            <label
              className="sel"
              onClick={() => setLocalOnly((v) => !v)}
              style={{ cursor: "pointer" }}
            >
              <span>privacy</span>
              <span className="v" style={localOnly ? { color: "var(--ember)" } : undefined}>
                {localOnly ? "local-only" : "any"}
              </span>
            </label>
          </div>

          <div
            className="dim mono"
            style={{
              fontSize: 10,
              letterSpacing: ".1em",
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            Ranked
          </div>
          {simulation.eligible.slice(0, 4).map((e, i) => (
            <div
              key={e.m.id}
              style={{ borderBottom: "1px solid var(--line)", padding: "6px 0" }}
            >
              <div style={{ display: "flex", gap: 8, fontFamily: "var(--mono)", fontSize: 11 }}>
                <span style={{ color: i === 0 ? "var(--ember)" : "var(--ink-3)" }}>
                  {i + 1}
                </span>
                <span style={{ flex: 1, color: i === 0 ? "var(--ink)" : "var(--ink-2)" }}>
                  {e.m.id}
                </span>
                <span style={{ color: i === 0 ? "var(--ember)" : "var(--ink-3)" }}>
                  {e.score.toFixed(2)}
                </span>
              </div>
              {i === 0 && (
                <div className="dim" style={{ fontSize: 10.5, paddingLeft: 18 }}>
                  {e.m.state === "resident" ? "resident · no load cost" : "cold · pays a load"}
                </div>
              )}
            </div>
          ))}
          {simulation.eligible.length === 0 && (
            <div style={{ color: "var(--crimson)", fontSize: 12 }}>
              No model satisfies this requirement.
            </div>
          )}

          <div
            className="dim mono"
            style={{
              fontSize: 10,
              letterSpacing: ".1em",
              textTransform: "uppercase",
              margin: "16px 0 8px",
            }}
          >
            Excluded
          </div>
          {simulation.excluded.slice(0, 8).map((e) => (
            <div
              key={e.m.id}
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10.5,
                color: "var(--ink-3)",
                padding: "3px 0",
              }}
            >
              <span style={{ color: "var(--crimson)" }}>✗</span> {e.m.id} — {e.reason}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
