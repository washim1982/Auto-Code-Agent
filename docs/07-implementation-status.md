# Implementation Status

What exists in code, which flow-review finding each piece closes, and where the implementation
deviates from the plan.

**244 tests across 15 files. `tsc --noEmit` clean. All 12 milestones implemented.**

```bash
pnpm install
pnpm test                                    # 244 tests, fully offline
pnpm typecheck
pnpm daemon                                  # engine, loopback JSON-RPC
pnpm aca                                     # interactive TUI
pnpm aca doctor
pnpm aca run "<goal>" --local-only
cd packages/desktop && pnpm build && pnpm dev # Electron app
```

## Milestones

| | Milestone | State |
|---|---|---|
| M0 | Spine | Workspace, protocol, SQLite, event log, layered config, secret store, redacting logger |
| M1 | Model layer | Ollama · LM Studio · llama.cpp · OpenAI-compatible · Anthropic, GBNF, router, residency, probe suite, tool-call shim |
| M2 | Tools & sandbox | Registry, permission matrix, T0/T1/T2, checkpoint + write-set enforcement, epoch cache, output guard |
| M3 | Workspace & chat | Registry, threads, file tree with agent overlays, read-only tool loop, model switching |
| M4 | Single-node execution | Input guard, spec compiler, context assembler, budget, agent loop, gate vector |
| M5 | Planner & scheduler | Schema-constrained DAG, validation, deterministic repair, canonical locks, personas, cancellation |
| M6 | Memory tiers | T2 episodic, T3 hybrid index (BM25 + vector, RRF), T4 lessons with confirmation and retirement |
| M7 | Gates, review, recovery | Gate vector, independent reviewer, error taxonomy, cascade invalidation, budget |
| M8 | Daemon | Loopback JSON-RPC over WebSocket, token auth at upgrade, workspace pool, approval broker |
| M9 | CLI | Ink TUI with thread/graph toggle and focus cycling, plus `plan` `run` `models` `doctor` `ws` `memory` `runs` `daemon` |
| M10 | Desktop | Electron, hardened preload, React renderer: launcher, session graph, files, timeline, models, settings |
| M11 | Hardening | Injection corpus, cassette replay, golden flow tests, scheduler fuzz |

## Findings closed

Each has a test that fails if the fix regresses.

| # | Finding | Where | How it is proven |
|---|---|---|---|
| **F1** | Retry exhaustion had no exit | [`recovery/classifier.ts`](../packages/core/src/recovery/classifier.ts) | Attempts checked **before** the taxonomy; a loop test drives the classifier repeatedly and asserts termination |
| **F2** | Reviewer loop unbounded | [`review/loop.ts`](../packages/core/src/review/loop.ts), [`reviewer.ts`](../packages/cli/src/reviewer.ts) | Round cap, stemmed semantic-hash dedup, budget eviction; live reviewer wired into `aca run` |
| **F3** | Runtime edges could deadlock | [`scheduler/locks.ts`](../packages/core/src/scheduler/locks.ts) | Canonical-order all-or-nothing acquisition; **300-trial fuzz** asserts no locks survive a drain |
| **F4** | Write sets declared, never enforced | [`tools/checkpoint.ts`](../packages/tools/src/checkpoint.ts) | API gate plus post-hoc tree verification that catches a subprocess |
| **F5** | Park released locks unsafely | [`scheduler/locks.ts`](../packages/core/src/scheduler/locks.ts) | Parked locks retained and skipped by the release path |
| **F6** | No cascade invalidation | [`scheduler/cascade.ts`](../packages/core/src/scheduler/cascade.ts) | Read sets tracked; rollback transitively dirties consumers, depth-capped |
| **F7** | Cache never invalidated | [`cache/epoch.ts`](../packages/core/src/cache/epoch.ts) | Resource epochs in the key; glob reads registered so writes beneath them invalidate |
| **F8** | Budget checked once | [`context/assembler.ts`](../packages/core/src/context/assembler.ts) | Measured against the *selected* model's window, with pinned/evictable layers |
| **F9** | No model selection stage | [`providers/router.ts`](../packages/providers/src/router.ts) | Capability filter → weighted rank → breaker → fallback; capability score weights parameter scale |
| **F10** | Sandbox undefined | [`sandbox/exec.ts`](../packages/tools/src/sandbox/exec.ts), [`paths.ts`](../packages/tools/src/paths.ts) | Tiers, kill escalation, output cap, env scrub, path jail |
| **F11** | Summariser was an injection surface | [`guard/output-guard.ts`](../packages/core/src/guard/output-guard.ts) | Per-run nonce, fence-forgery neutralisation, summary inside the envelope; 8-case corpus |
| **F12** | Gates were one boolean | [`gates/vector.ts`](../packages/core/src/gates/vector.ts) | Per-gate severity and retryability, carried into the classifier by `GateFailure` |
| **F13** | Deployment ungated | [`tools/builtins.ts`](../packages/tools/src/builtins.ts) | `purity: "irreversible"`; asks at execution time regardless of plan approval |
| **F14** | No cancellation | [`run/cancellation.ts`](../packages/core/src/run/cancellation.ts) | Cooperative token; cancel checkpoints rather than discards |
| **F15** | No cost accounting | [`budget/meter.ts`](../packages/core/src/budget/meter.ts) | Executor and supervisor share one meter, checked before every model call |
| **F16** | Rejection reason lost | [`plan/planner.ts`](../packages/core/src/plan/planner.ts) | Rejections carried into replanning as hard constraints |
| **F17** | Persona not bound to capability | [`persona/registry.ts`](../packages/core/src/persona/registry.ts) | Personas declare routing requirements; the reviewer requires model independence |
| **F18** | No provenance | [`events/log.ts`](../packages/core/src/events/log.ts) | Append-only log; state is `fold(events)`, which is also resume and the timeline |

## Verified live

- **Full flow**: `aca run "make divide throw a clear error when b is zero"` → 3-node DAG, executed, correct guard clause written, gates passed. 60s, 20k tokens, 57 events, local models only.
- **Model layer**: 14 models across Ollama, LM Studio and llama.cpp, with real capabilities and residency.
- **Memory**: this repo indexed to 950 chunks with live embeddings. An identifier query returns the exact definition; an intent query returns the right module.
- **Daemon**: every RPC exercised against a live instance — 158 tree entries with index overlay, model catalogue, memory query, run history.
- **Desktop**: launcher and session views captured from a running Electron window ([screens](../design/screens/)), connected to the daemon.
- **Path jail**: caught a model hallucinating `/home/runner/work` mid-conversation.

## Deviations from the plan

**`node:sqlite`, not better-sqlite3.** Node 24 ships SQLite, removing a native compile on Windows.
Imported via `createRequire` because Vite 5 rewrites the `node:` specifier.

**`tsx` loader, not plain type-stripping.** Node cannot handle JSX, and the TUI needs it. Source
still runs directly, with no build step outside the desktop app.

**No parameter properties.** They are not strippable, and running TS directly is worth more.

**Vectors scanned in JS, not `sqlite-vec`.** Embeddings are stored as BLOBs and cosine-scanned. At
repo scale (~1k chunks × 768 dims) that is milliseconds, and it avoids a native extension entirely.

**Secrets in a mode-0600 file, not an OS keychain.** `keytar` is a native module. Environment
variables are read first; the file is never merged into config and never logged.

## Known limits

- **Semantic retrieval is mediocre on prose-shaped queries.** Identifier lookup is excellent; "how does X work" returns the right area but noisy ordering. A code-specific embedding model would help more than tuning the fusion.
- **The TUI plans but does not execute.** `aca run` executes; the TUI currently hands off. Wiring the supervisor into the TUI event loop is the next obvious step.
- **The desktop app is read-mostly.** It shows runs, files, models and the timeline, and answers approvals. Starting a run from the desktop still goes through the CLI.
- **T2/T4 are not yet written by the run loop.** The stores and their tests exist; the supervisor does not call them, so lessons accumulate only when written explicitly.
- **Windows sandboxing is advisory at T1.** Path jailing and Job Objects guard against mistakes, not a determined escape. Docker T2 is the real boundary and is defined but never exercised.
- **The probe suite is not run automatically.** `ProbeSuite` exists and is wired to the scorecard table, but no command triggers it yet, so context windows remain advertised rather than measured.
