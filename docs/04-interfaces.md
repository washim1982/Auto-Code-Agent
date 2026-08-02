# Interfaces — CLI and Desktop

Both are thin clients over the daemon's JSON-RPC. Neither holds run state.

> **Superseded in part by [06-ui-design.md](06-ui-design.md).** That document adds the launcher,
> workspace switcher, chat surface, and file browser, and establishes that chat — not a run — is the
> default interaction. Where the two disagree, 06 wins.

## CLI (`aca`)

### Interactive mode — `aca` with no args

Ink TUI. A REPL that is *not* just a chat box: the plan and the DAG are the primary objects.

```
┌─ Auto-Code-Agent ──────────────── qwen3.6:35b · ollama · 12.4k/262k ─┐
│                                                                      │
│  › add rate limiting to the /api/upload endpoint                     │
│                                                                      │
│  ✓ guard        no PII, no injection, in scope                       │
│  ✓ optimize     3 acceptance criteria extracted                      │
│  ✓ preflight    7 tools, 2 require approval                          │
│  ✓ plan         5 nodes, 2 parallel branches           [v] view      │
│                                                                      │
│  ┌─ DAG ──────────────────────────────────────────────────────────┐  │
│  │  ●─ n1 read middleware config      done    granite4:3.4b  1.2s │  │
│  │  ├─ n2 implement limiter       ▶ running   qwen3.6:35b   14.1s │  │
│  │  │     └ write ▸ src/mw/rateLimit.ts                           │  │
│  │  ├─ n3 add tests               ▶ running   qwen3.6-27b    9.7s │  │
│  │  ○─ n4 wire into router          blocked   (write-set: n2)     │  │
│  │  ○─ n5 update docs               ready                         │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  n2 › thinking… ▸ needs to handle the burst case separately          │
│                                                                      │
│  budget  18.2k tok · $0.00 · 41s        [tab] focus  [esc] cancel    │
└──────────────────────────────────────────────────────────────────────┘
```

Keys: `tab` cycle focus (input / DAG / node detail) · `v` plan detail · `d` diff for focused node · `l` raw model log · `esc` cancel run (checkpoints, does not discard) · `a`/`r` approve/reject at a gate · `?` help.

Approvals interrupt inline and cannot be missed:

```
  ⚠ approval required — node n4
    git push origin feature/rate-limit          [irreversible]
    reason: node contract declares remote publish
    [a] approve once   [A] approve for this run   [r] reject   [e] edit
```

### Non-interactive — scriptable

```bash
aca                                                         # chat in the current workspace
aca chat "how does auth work here?" --model granite4:3.4b

aca ws list                                                 # workspaces + index state
aca ws add ~/work/infra-terraform --index
aca ws switch dashboard-ui
aca ws index --full

aca run "add rate limiting to /api/upload" --yes --json     # CI mode, NDJSON events
aca plan "refactor auth" --dry-run                          # plan only, no execution
aca resume <run-id>
aca runs list / aca runs show <id> / aca runs export <id> --format=md

aca models list                     # every provider, capability grid
aca models probe --all              # run the scorecard suite
aca models load qwen3.6:35b
aca doctor                          # health of all providers, GPU, disk, perms

aca memory query "how does auth work"
aca memory lessons --scope=workspace
aca index .                         # build T3 over the workspace

aca config set router.privacy local-only
aca daemon start|stop|status
```

`--json` emits one NDJSON event per line — the same event stream the UI consumes, so anything the TUI can show, a script can parse.

**Design rule:** every interactive action has a flag equivalent. No capability exists only in the TUI.

## Desktop (Electron)

Five surfaces. The main window is a workspace, not a chat window.

### 1. Run view
Split: conversation/instruction pane left, **DAG canvas** right. Canvas nodes are colour-coded by status and show persona, chosen model, elapsed time, and token spend. Click a node → detail drawer with tabs: **Context** (exactly what was assembled, in ladder order, with the untrusted envelopes visibly marked), **Model** (why the router picked it, the candidates it rejected and why), **Tools** (each call, args, result, cache hit/miss), **Gates** (the vector, per-gate output), **Diff**.

The context tab matters more than it sounds. "What did the model actually see" is the first question in every agent debugging session, and it is normally unanswerable.

### 2. Timeline
Horizontal event-log scrubber. Drag back to any point and inspect full state at that moment — a direct payoff of event sourcing. Filter by type (tool calls, model calls, approvals, rollbacks).

### 3. Diff review
Monaco side-by-side per node, grouped by write set. Accept / reject / annotate per hunk; a rejection becomes a critique constraint and re-runs the node (F2). This is where a human actually reviews the agent's work.

### 4. Model manager
All four backends in one grid: provider, model, state (resident / cold / not-installed), context, quantization, VRAM estimate, scorecard results, tok/s. Load/unload buttons. Live VRAM bar. Routing policy editor with a "why would this node route here?" simulator.

### 5. Settings
Providers and endpoints · API keys (written to Credential Manager, shown only as `••••`) · permission matrix editor · sandbox tier defaults · budget caps · privacy mode (`local-only` disables cloud adapters globally and greys them out).

### Electron process model
- **Main** — window lifecycle, daemon supervision (spawn on launch if not running, adopt if it is), OS keychain, deep links, auto-update.
- **Renderer** — React + Vite, `contextIsolation: true`, `nodeIntegration: false`, no remote content, strict CSP.
- **Preload** — narrow bridge exposing only the JSON-RPC client and keychain read/write. The renderer never touches `fs`, `child_process`, or the network directly.

The daemon runs as a **separate OS process**, not inside Electron's main process. Closing the window must not kill a running DAG, and the CLI must be able to attach to the same run.

## Shared design constraints

- **Streaming everywhere.** Thinking tokens are visually distinct from output tokens and collapsible.
- **Untrusted content is visually marked** in both front-ends. If a tool result is rendered, it is fenced and labelled. Users should be able to see the trust boundary the guard enforces.
- **Cancellation is always one keystroke/click away** and always checkpoints (F14).
- **Nothing irreversible happens without a modal at execution time**, regardless of plan-level approval (F13).
