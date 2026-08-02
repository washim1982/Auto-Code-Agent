import React, { useMemo } from "react";
import { eventColor, eventLane, LANES, type AcaEvent } from "./shared.ts";

/**
 * Timeline with event lanes and a playhead.
 *
 * Scrubbing replays the fold over the event log, which is the same mechanism
 * behind crash resume and offline test replay — so "state at this moment" is
 * free rather than a feature that had to be built.
 */
export function Timeline({
  events,
  position,
  onScrub,
}: {
  events: AcaEvent[];
  position: number;
  onScrub: (seq: number) => void;
}): JSX.Element {
  const last = events.at(-1)?.seq ?? 0;
  const first = events[0]?.seq ?? 0;
  const span = Math.max(1, last - first);

  const lanes = useMemo(() => {
    const map = new Map<string, AcaEvent[]>();
    for (const lane of LANES) map.set(lane, []);
    for (const e of events) map.get(eventLane(e.type))?.push(e);
    return map;
  }, [events]);

  const state = useMemo(() => {
    const upTo = events.filter((e) => (e.seq ?? 0) <= position);
    const nodes = new Map<string, string>();
    let tokens = 0;
    let cost = 0;
    const locks = new Set<string>();

    for (const e of upTo) {
      if (e.nodeId) {
        if (e.type === "node.started") nodes.set(e.nodeId, "running");
        else if (e.type === "node.done") nodes.set(e.nodeId, "done");
        else if (e.type === "node.failed") nodes.set(e.nodeId, "failed");
        else if (e.type === "node.blocked") nodes.set(e.nodeId, "blocked");
        else if (e.type === "node.parked") nodes.set(e.nodeId, "parked");
      }
      if (e.type === "model.response") {
        tokens +=
          Number(e.payload["inputTokens"] ?? 0) + Number(e.payload["outputTokens"] ?? 0);
        cost += Number(e.payload["costUsd"] ?? 0);
      }
      if (e.type === "lock.acquired") {
        for (const r of (e.payload["resources"] as string[] | undefined) ?? []) locks.add(r);
      }
      if (e.type === "lock.released") {
        for (const r of (e.payload["resources"] as string[] | undefined) ?? []) locks.delete(r);
      }
    }
    return { nodes, tokens, cost, locks, count: upTo.length };
  }, [events, position]);

  if (events.length === 0) {
    return <div className="empty">No events yet.</div>;
  }

  const playheadPct = ((position - first) / span) * 100;

  return (
    <>
      <div className="col center">
        <div className="phead">
          Event lanes
          <span className="r">
            <span>{events.length} events</span>
            <span>seq {position}</span>
          </span>
        </div>

        <div className="pbody flush" style={{ overflow: "auto" }}>
          <div style={{ padding: "14px 12px", position: "relative" }}>
            <div
              className="playhead"
              style={{
                left: `calc(84px + ${Math.max(0, Math.min(100, playheadPct))}% * 0.82)`,
              }}
            />
            {LANES.map((lane) => (
              <div key={lane} className="lane">
                <span className="lname">{lane}</span>
                <div className="track">
                  {(lanes.get(lane) ?? []).map((e) => (
                    <span
                      key={e.seq}
                      className="ev"
                      title={`${e.seq} ${e.type}`}
                      style={{
                        left: `${(((e.seq ?? 0) - first) / span) * 100}%`,
                        width: 3,
                        background: eventColor(e.type),
                        opacity: (e.seq ?? 0) <= position ? 1 : 0.28,
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}

            <input
              type="range"
              min={first}
              max={last}
              value={position}
              onChange={(e) => onScrub(Number(e.target.value))}
              style={{ width: "100%", marginTop: 12 }}
            />
          </div>

          <div className="phead" style={{ borderTop: "1px solid var(--line)" }}>
            Events at playhead
          </div>
          <div style={{ padding: "8px 14px" }}>
            {events
              .filter((e) => (e.seq ?? 0) <= position)
              .slice(-30)
              .map((e) => (
                <div
                  key={e.seq}
                  style={{ display: "flex", gap: 12, padding: "3px 0", fontSize: 11 }}
                  className="mono"
                >
                  <span className="dim" style={{ width: 40 }}>
                    {e.seq}
                  </span>
                  <span className="dim" style={{ width: 130 }}>
                    {e.nodeId ?? "—"}
                  </span>
                  <span style={{ color: eventColor(e.type), width: 150 }}>{e.type}</span>
                  <span
                    className="dim"
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {JSON.stringify(e.payload).slice(0, 90)}
                  </span>
                </div>
              ))}
          </div>
        </div>
      </div>

      <div className="col right">
        <div className="phead">State at playhead</div>
        <div className="pbody">
          <div className="specrow">
            <b>events folded</b>
            <span>{state.count}</span>
          </div>
          <div className="specrow">
            <b>nodes done</b>
            <span>{[...state.nodes.values()].filter((s) => s === "done").length}</span>
          </div>
          <div className="specrow">
            <b>running</b>
            <span>{[...state.nodes.values()].filter((s) => s === "running").length}</span>
          </div>
          <div className="specrow">
            <b>blocked</b>
            <span>{[...state.nodes.values()].filter((s) => s === "blocked").length}</span>
          </div>
          <div className="specrow">
            <b>locks held</b>
            <span>{state.locks.size}</span>
          </div>
          <div className="specrow">
            <b>tokens</b>
            <span>{state.tokens.toLocaleString()}</span>
          </div>
          <div className="specrow">
            <b>cost</b>
            <span>${state.cost.toFixed(4)}</span>
          </div>

          <p className="dim" style={{ fontSize: 12, marginTop: 16, lineHeight: 1.6 }}>
            The event log is the source of truth — run state is a fold over it. Scrubbing
            replays that fold, which is the same mechanism behind crash resume and offline test
            replay.
          </p>
        </div>
      </div>
    </>
  );
}
