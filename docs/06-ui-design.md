# UI Design Spec

Visual mockup: [`design/ui-design.html`](../design/ui-design.html) — open it in a browser, or view the
published version. This document is the buildable spec; the mockup is the reference render.

This supersedes the sketches in [04-interfaces.md](04-interfaces.md), which described *what* each
surface shows. This one fixes *how*.

---

## Concept

The subject's own world is warm/cold model residency, VRAM pressure, and token throughput, so the
identity is a **thermal instrument panel**, not a chat window and not a hacker terminal. Node state is
encoded as temperature, and urgency rises with heat — the eye lands on the warm end first.

Two consequences that drive every other decision:

- **Mono carries the identity.** Every measurement, ID, state, path, and label is monospaced with
  tabular figures. Sans is used only for prose. This is inverted from a typical app, and it is honest
  to a tool where the data *is* the interface.
- **Console density, not cards.** Hairline-divided flush panels on a 4px grid, 3px corners maximum,
  no drop shadows, no floating rounded cards.

---

## Tokens

Declare once as custom properties on `:root`, redefine under `@media (prefers-color-scheme: dark)`,
then again under `:root[data-theme="dark"]` / `:root[data-theme="light"]` so an explicit toggle wins
in both directions. Components style through tokens only — never a raw hex, never a color inside a
media query.

### Neutrals

Biased slightly warm so the ember accent never looks pasted on.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--ground` | `#131519` | `#EEEDE9` | App background, canvas |
| `--s1` | `#191C21` | `#F7F6F3` | Rails, side panels, status strip |
| `--s2` | `#1F2329` | `#FFFFFF` | Raised: inputs, node cards, table hover |
| `--s3` | `#262B32` | `#E7E5E0` | Active tab, meter track |
| `--line` | `#2A2F37` | `#DBD8D2` | Hairline dividers |
| `--line-2` | `#3A414B` | `#BFBBB3` | Component borders |
| `--ink` | `#E4E2DE` | `#1E2126` | Primary text |
| `--ink-2` | `#A6A9AE` | `#54585E` | Secondary |
| `--ink-3` | `#6E747C` | `#878C93` | Labels, dimmed data |

### The heat ramp

Semantic, and separate from any brand accent. Ember doubles as the interactive accent — live work
and clickable share one hue, which is correct here because the running node *is* the thing you act on.

| State | Token | Dark | Light | Glyph | Treatment |
|---|---|---|---|---|---|
| Queued / blocked | `--slate` | `#6B7C8C` | `#4F6072` | `○` | Card at 72% opacity; lock glyph if lock-blocked |
| Done | `--moss` | `#7FA05F` | `#5A7A3C` | `✓` | Quiet — finished work recedes |
| Waiting on you | `--wheat` | `#D9B24C` | `#8C6A12` | `⚠` | 3px glow ring; the only state that pulses |
| Running | `--ember` | `#E07B45` | `#B75A21` | `▶` | 3px glow ring; full-weight border |
| Failed / untrusted | `--crimson` | `#D1525F` | `#B03546` | `✗` | Also tints untrusted-content rows |

Each ships a `-dim` variant at ~13% alpha for fills (`--ember-dim`, etc.).

**State is encoded three ways at once** — hue, glyph, and border weight — so it survives `NO_COLOR`,
monochrome terminals, and color-vision deficiency. Never encode state in hue alone.

### Type

The Artifact/Electron CSP blocks font CDNs, and inlining a full face as a data URI is not worth the
weight for a tool UI. Use considered system stacks; on this machine both resolve to real faces.

```css
--mono: "Cascadia Code","Cascadia Mono","JetBrains Mono",ui-monospace,Consolas,monospace;
--sans: "Segoe UI Variable Text","Segoe UI",ui-sans-serif,-apple-system,system-ui,sans-serif;
```

| Role | Family | Size | Treatment |
|---|---|---|---|
| Micro label | mono | 10–11px | uppercase, `letter-spacing:.10–.12em`, `--ink-3` |
| Data / identifier | mono | 11–12px | `font-variant-numeric: tabular-nums` |
| Node title | sans | 12.5px | 500 |
| UI body | sans | 13px | 400 |
| Panel/view title | sans | 15–20px | 600, `letter-spacing:-.01em` |

`tabular-nums` is mandatory anywhere digits stack — token counts, elapsed, VRAM, tok/s, reliability.
Prose blocks cap at 68ch.

---

## Interaction model — chat is the spine

**A run is not a mode. It is something a conversation escalates into.**

The first version of this design treated every input as the start of a DAG, which was wrong: most of
what you do with a coding agent is ask questions, read code, and think. Forcing that through a
planner is ceremony, and it hides the models behind an orchestration layer you did not ask for.

So the session has two representations of one thread, swapped by a `thread | graph` toggle in the
panel header:

| | Chat | Run |
|---|---|---|
| Entry | Default. Type anything. | Escalated from chat, or `aca run` / `/plan` |
| Tools | Read-only by default, toggleable in the composer | Full permission matrix |
| Model | One model, picked directly in the composer | Routed per node |
| Gates | None | Full gate vector + reviewer |
| Cost | Metered, not budgeted | Budgeted with stop-or-ask |

The escalation is visible: when the model decides work is needed, a **plan card** renders inline in
the thread — node list with declared write sets, cost estimate, and `Approve & run / Edit / Reject`.
Approving spawns the DAG in the graph representation. The chat turn that produced it stays in the
thread as provenance.

This also means **the model picker belongs in the composer**, not buried in settings. With four
backends, "ask the 35b" versus "ask the 3.4b" is a decision you make per message, and the picker
groups by residency — resident, cold (with load size and the warning that first use pays for the
load), then cloud — because that is the cost you actually care about.

## Workspaces

Everything is scoped to a workspace: permissions, T3 index, memory, run history, `.aca/state.db`.
There is therefore a real "no workspace open" state, and it needs a real screen.

- **Launcher** — recent workspaces, each showing **index state** (`indexed 4,812 chunks` / `stale, 214
  files changed` / `not indexed`), last run, and the model it used. Plus Open folder, Clone from git,
  and Attach to running daemon. Provider health sits at the bottom so you learn your models are down
  *before* a run fails, not after.
- **Workspace switcher** — dropdown from the title-bar pill. Recent list with index state, open/clone,
  and Re-index.

Index state is surfaced everywhere a workspace is named. It is the single most common reason an agent
gives a bad answer about an unfamiliar repo, and it is invisible unless you show it.

## File browser

A file tree that shows **agent state, not just git state** — locks, write sets, and index coverage
are things only this app knows.

| Marker | Meaning |
|---|---|
| `●` moss | Modified by the agent, uncommitted |
| `▶` ember | In a running node's write set |
| `🔒` slate | Locked — held by a running node, read-only until released |
| `+84` moss | Line delta from the current run |
| dimmed | Excluded from the T3 index (gitignored, `node_modules`, `dist`) |

Selecting a file shows its full agent state — git status, owning node, lock holder, chunk count,
**resource epoch**, and checkpoint sequence — with actions for Attach to conversation (`@`), Show
retrieved chunks, Exclude from index, and Roll back to checkpoint.

The tree is a persistent left panel across both Chat and Run, so context never shifts under you.

## Desktop layout

Frameless Electron window. Minimum 1024 × 640; reference render 1240 × 812.

```
┌──────────────────────────────────────────────────────────┐ 36  title bar
├────┬──────────────┬─────────────────┬────────────────────┤
│    │              │                 │                    │
│rail│  left panel  │  primary area   │   detail drawer    │
│ 52 │     300      │      flex       │        380         │
│    │              │                 │                    │
├────┴──────────────┴─────────────────┴────────────────────┤
└──────────────────────────────────────────────────────────┘ 28  status strip
```

| Element | Size |
|---|---|
| Base grid | 4px |
| Title bar / status strip | 36px / 28px |
| Icon rail | 52px (36 × 34px targets) |
| File tree panel | 240px in Chat/Run, 300px in Files (resizable, 200 min) |
| Detail drawer | 340px in Chat, 380px in Run (resizable, 320 min) |
| Panel header | 34px |
| Table row | 26px |
| Panel padding | 12px |
| Corner radius | 3px (5px on the window frame only) |

**Title bar** — workspace pill with a daemon health dot and a `▾` affordance at left (opens the
workspace switcher); run status chip centered; Windows controls right. Draggable region excludes all
controls.

**Icon rail** — Session, Files, Diff, Timeline, Models, then Settings pinned to the bottom. Session
covers both chat and graph because they are one thing. Active state is a filled `--ember-dim` tile
with an ember glyph — not a left indicator bar.

**Status strip** — segments divided by 1px rules: daemon + port · active route · VRAM meter · tokens ·
cost + privacy mode · elapsed + cancel. Always visible, every view.

### Chat view (default)

- **Left** — file tree (240px).
- **Center** — the conversation thread. User turns, model turns with streaming, thinking rendered in
  a slate-bordered collapsible block, tool calls as inline chips showing name and target. Plan cards
  render inline. Composer pinned to the bottom carrying the model picker, mode (`chat` / `plan & run`),
  tool-access level, and the `@ file · # symbol · / command` affordances.
- **Right** — live context inspector (the same priority ladder as the run drawer, showing what is in
  the window *right now*) and the model picker grouped by residency.

### Run view

- **Left** — the same file tree, now showing locks and write sets for the active run, plus acceptance
  criteria with live per-criterion status.
- **Center** — DAG canvas on a 22px dot grid. Node cards 200 × 64: status glyph + id + title, write-set
  line, then model chip and elapsed on the baseline. Edges are bezier `M x1 y1 C x1 y1+16, x2 y2-16,
  x2 y2`; active edges ember, lock-blocked edges dashed slate.
- **Right** — node drawer, tabs: **Context** / Model / Tools / Gates / Diff.

**The Context tab is the differentiator.** It renders the assembled window as the priority ladder,
numbered 1–8, each row showing its token count, with pinned rows marked, evictable rows dimmed, and
the untrusted tool-result row tinted crimson and fenced. "What did the model actually see" is the
first question in any agent debugging session and is normally unanswerable — here it is one click.

### Model manager

Left column: per-provider health cards + a resident-model list against a VRAM meter. Center: the
capability table. Right: the routing simulator, which shows ranked candidates *with their scoring
terms* and — more usefully — an **excluded** list with the reason each candidate was filtered out.

Context is rendered `probed / advertised`. When they diverge the probed value is shown in crimson,
because that gap is the whole reason the probe suite exists.

### Diff review

Changed files grouped by node, side-by-side Monaco, reviewer note pinned to the right with a critique
composer beneath it. Rejecting a hunk attaches the note as a hard constraint and re-runs the node;
the remaining round count is stated inline so the 3-round cap is never a surprise.

### Timeline

Six event lanes — node, model, tool, gate, lock, approval — sharing the heat ramp, with a draggable
playhead. Below: the events at the playhead, and a state summary. Scrubbing replays the fold over the
event log, the same mechanism behind crash resume and offline test replay.

### Settings

The permission matrix is the centerpiece: persona × tool → allow / ask / deny, with irreversible tools
flagged in crimson. Privacy mode is a prominent ember-bordered toggle, because `local-only` changes
what the whole product is allowed to do.

### Electron specifics

`contextIsolation: true`, `nodeIntegration: false`, strict CSP, no remote content. The preload bridge
exposes only the JSON-RPC client and keychain read/write. The daemon is a **separate OS process** —
closing the window must not kill a running DAG.

---

## CLI layout

Ink TUI at 96 columns, degrading cleanly to 80 (drop the model column first, then elapsed).

**It opens in chat.** `aca` in a directory starts a conversation in that workspace — a header line
with workspace, branch, and index state, a second with the active model and its capabilities, then a
prompt. Ask a question, get an answer. No plan, no DAG, no ceremony.

```
workspace  api-svc  ~/projects/api-svc · feature/rate-limit · indexed 4,812 chunks
model      qwen3.6:35b  ollama · resident · tools native · local-only
/model to switch · /ws to change workspace · @path to attach a file · /plan to escalate

› how does the upload endpoint authenticate right now?
  └ ✓ read_file src/mw/auth.ts  ✓ grep "upload" · 6 hits
Bearer token via requireAuth (src/mw/auth.ts:34), applied per-route rather than globally.
```

When you ask for work, the plan arrives inline as a bordered card with the same node list and write
sets as the desktop, and `[a] approve & run  [e] edit plan  [r] reject`. Only after approval does the
DAG panel appear.

**Workspace selection** is `/ws` (a picker showing index state per workspace) or the flag surface:
`aca ws list | add <path> [--index] | switch <name> | index | forget`.

**Then the DAG panel becomes the centre of gravity.** Every node gets a line carrying glyph, id,
title, state, model, and elapsed, with an indented sub-line for its write set or its failure reason.

```
┌─ plan graph ──────────────────── 6 nodes · 2 running · 1 blocked ─┐
│ ✓  n1 read middleware config     done      granite4:3.4b    1.2s  │
│ ▶  n2 implement limiter          running   qwen3.6:35b     14.1s  │
│    └ write ▸ src/mw/rateLimit.ts                                  │
│ ○  n4 wire into router           blocked   —                   —  │
│    └ 🔒 write set src/mw/** held by n2                            │
│ ✗  n5 benchmark throughput       retry 1/2 gemma4:8b         6.4s │
│    └ gate unit ✗ — 2 of 14 failed                                 │
│ ⚠  n6 push branch                approval  irreversible      held │
└───────────────────────────────────────────────────────────────────┘
```

Column widths: glyph 2 · title flex · state 10 · model 14 · elapsed 6 (right-aligned, tabular).

**Approvals interrupt in a wheat-bordered panel** stating what will be written, what it cannot roll
back, and the four responses. Other nodes keep running underneath — an approval blocks its node, not
the run.

**Node focus** (`tab`) shows the same priority ladder as the desktop Context tab, plus the one-line
routing rationale.

### Keymap

| Action | Key |
|---|---|
| Switch model | `/model` |
| Switch workspace | `/ws` |
| Attach a file / symbol to context | `@path` / `#symbol` |
| Escalate the conversation to a plan | `/plan` |
| Cycle focus — input / graph / node | `tab` |
| View full plan | `v` |
| Diff for focused node | `d` |
| Raw model log | `l` |
| Node detail tabs | `←` `→` |
| Approve / reject | `a` / `r` |
| Approve for whole run | `shift+a` |
| Retry / skip focused node | `R` / `S` |
| Cancel run (checkpoints) | `esc` |
| Help | `?` |

### Headless

`--json` emits one NDJSON event per line — the identical stream the desktop consumes. Every
interactive action has a flag equivalent; nothing is TUI-only. `aca doctor` uses the same ramp and
glyphs as the TUI so the two are visually continuous.

---

## Rules both surfaces obey

1. **Untrusted content is visibly fenced.** Anything from a tool, file, or network carries a crimson
   rule and an `untrusted` tag wherever it renders. Users should be able to *see* the trust boundary
   the guard enforces.
2. **Cancel is always one keystroke or click away**, and always checkpoints — never discards.
3. **Nothing is interactive-only.** Flag parity is a hard requirement, not a nice-to-have.
4. **Irreversible needs a fresh yes** at execution time, in wheat, regardless of plan-level approval.
5. **Thinking tokens render distinctly from output tokens** and are collapsible — on reasoning models
   they are often the majority of the spend, so they must be visible to the budget meter and to the user.
6. **Respect `prefers-reduced-motion`.** The only ambient motion in the product is the running/approval
   pulse; it is disabled under that query.

---

## Accessibility

- Contrast: body text ≥ 7:1, secondary and micro labels ≥ 4.5:1, in both themes. The light-theme ramp
  is darkened specifically to hold ratio on a paper ground — it is not the dark palette inverted.
- Every state carries a glyph as well as a hue.
- Visible focus ring: `2px solid var(--ember)`, `outline-offset: 2px`.
- The DAG canvas has a keyboard-navigable list equivalent — the graph is a rendering of the node list,
  never the only way to reach a node.
