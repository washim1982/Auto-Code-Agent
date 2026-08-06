# Auto-Code-Agent

An autonomous coding agent with an interactive CLI and a desktop app, running against local models (Ollama, LM Studio, llama.cpp) and cloud models, routed per task.

**Status:** all 12 milestones implemented. 244 tests passing; all 18 flow-review findings closed; the full goal-to-execution flow runs on local models, with a daemon, a TUI and an Electron desktop app.
See [07 — Implementation status](docs/07-implementation-status.md).

```bash
pnpm install && pnpm test
pnpm daemon                 # engine
pnpm aca                    # interactive TUI
pnpm aca doctor
pnpm aca run "add a guard clause to divide" --local-only
```

**Desktop app:** `pnpm --filter auto-code-agent dist` builds a Windows installer and a portable exe
into `packages/desktop/release/`. The engine ships inside the app, so an installed copy needs
nothing else — not even Node.

## Start here

| | |
|---|---|
| **[guide.md](guide.md)** | How to use it — commands, workflows, troubleshooting. Start here. |
| **[Project_context.md](Project_context.md)** | How the system works — architecture, concepts, data model, interfaces. |
| **[Project_Progress.md](Project_Progress.md)** | What changed from the original design, bugs found running it, and what is left to do. |

## Design records

| | |
|---|---|
| [01 — Flow review](docs/01-flow-review.md) | Review of the source flow diagram: 18 findings by severity, plus a corrected flow |
| [02 — Architecture](docs/02-architecture.md) | Daemon + two thin clients, packages, data model, memory tiers, sandbox, security |
| [03 — Model layer](docs/03-model-layer.md) | Provider adapters, capability probing, routing, residency, structured output |
| [04 — Interfaces](docs/04-interfaces.md) | What each surface shows — CLI TUI and desktop |
| [05 — Implementation plan](docs/05-implementation-plan.md) | 12 milestones, 83 days, risks, testing |
| [06 — UI design spec](docs/06-ui-design.md) | Tokens, dimensions, layout rules · mockup: [`design/ui-design.html`](design/ui-design.html) |
| [07 — Implementation status](docs/07-implementation-status.md) | Milestone state, findings closed, deviations, known limits |
| [08 — Reliable node execution](docs/08-reliable-execution.md) | Why nodes run out of steps mid-work, and the plan to make them finish |

## Shape in one paragraph

You open a **workspace** (a repo), browse it, and **chat** with any of your local or cloud models about it. When you ask for actual work, the model proposes a plan inline and — once you approve it — that conversation escalates into a **run**: a DAG with declared read/write sets, deadlock-free lock ordering, per-node model routing by capability/privacy/cost/residency, tools executed in tiered sandboxes with checkpoint and rollback, a vector of static gates plus an independent LLM reviewer, and write-back into four memory tiers. A headless **daemon** owns all of it; the CLI and desktop app are both JSON-RPC clients, so work started in one is visible and controllable from the other. State is an append-only event log, which is what makes resume, the timeline UI, and deterministic replay possible.

## Environment (probed)

| | |
|---|---|
| Node 24.18 · pnpm 9.15 · Python 3.14 · git 2.54 · Docker 29.5 | no Rust/Go |
| **Ollama** 0.32.4 `:11434` | `qwen3.6:35b` · `gemma4:8b` · `granite4:3.4b` · `qwen3.5:0.8b` |
| **LM Studio** `:1234` | `qwen3.6-27b` · `gemma-4-31b` · `nomic-embed-text-v1.5` |
| **llama.cpp** | not running — attach or managed mode |

## Key decisions

- **TypeScript monorepo, pnpm workspaces.** One language across engine, CLI, and desktop renderer.
- **Electron over Tauri.** No Rust toolchain here; the engine is Node and needs native modules (`better-sqlite3`, `node-pty`, `keytar`). The swap cost is confined to `packages/desktop`. — [rationale](docs/02-architecture.md#desktop-shell-electron-over-tauri)
- **Daemon-first.** Front-ends never hold run state.
- **Capability-based routing, never model-name branching.** Advertised capabilities are verified by a probe suite and stored as scorecards.
- **llama.cpp GBNF grammars** for hard structured-output guarantees where correctness matters.
- **Event-sourced state.** Resume, audit, timeline, and replay from one mechanism.

## First milestone to demo

[M3 — Workspace + chat](docs/05-implementation-plan.md#m3--workspace--chat-7d) (~day 22): open a repo, browse it, and talk to your local models about it — tool calls visible, results fenced, model switchable mid-conversation. Useful on its own, before any orchestration exists.

Autonomous execution starts at M4; a conversation escalates into a run rather than replacing one.
