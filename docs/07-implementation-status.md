# Implementation Status

What exists in code today, which flow-review finding each piece closes, and where the
implementation deviates from the plan. Updated as of the first implementation pass.

**95 tests passing across 5 files. `tsc --noEmit` clean. Verified live against Ollama, LM Studio,
and llama.cpp on this machine.**

```bash
pnpm install
pnpm test          # 95 tests
pnpm typecheck
node --experimental-strip-types packages/cli/src/bin.ts doctor
```

## Findings closed

Each has a test that fails if the fix regresses — the point is that these are *proven*, not asserted.

| # | Finding | Where | Proof |
|---|---|---|---|
| **F1** | Retry exhaustion had no exit | [`recovery/classifier.ts`](../packages/core/src/recovery/classifier.ts) | Attempt count is checked **before** the taxonomy, against a counter on the node record. A loop test drives the classifier repeatedly and asserts it terminates. |
| **F2** | Reviewer loop unbounded | [`review/loop.ts`](../packages/core/src/review/loop.ts) | Round cap escalates instead of looping; critiques deduped by stemmed semantic hash so a re-worded repeat counts as non-progress; critique block evicts oldest-first to stay in budget. |
| **F3** | Runtime edges could deadlock | [`scheduler/locks.ts`](../packages/core/src/scheduler/locks.ts), [`scheduler/resource.ts`](../packages/core/src/scheduler/resource.ts) | Canonical-order, all-or-nothing acquisition. **300-trial randomised fuzz** asserts zero surviving locks after drain. Conflict detection is path-prefix and glob aware. |
| **F4** | Write sets declared, never enforced | [`tools/checkpoint.ts`](../packages/tools/src/checkpoint.ts) | `assertWritable` gates the tool API; `verify()` re-hashes the tree to catch a subprocess writing behind the API's back. |
| **F5** | Park released locks unsafely | [`scheduler/locks.ts`](../packages/core/src/scheduler/locks.ts) | `park()` retains locks and flags them; the normal release path skips parked locks. |
| **F6** | No cascade invalidation | [`scheduler/cascade.ts`](../packages/core/src/scheduler/cascade.ts) | Nodes declare read sets; rollback transitively dirties every consumer whose read set intersects. Depth-capped so a rollback storm cannot livelock. |
| **F7** | Cache never invalidated | [`cache/epoch.ts`](../packages/core/src/cache/epoch.ts) | Keys include a per-resource epoch; a committed write makes prior keys unreachable. Resources are registered at cache-write time so glob reads are discoverable. |
| **F8** | Budget checked once | [`context/assembler.ts`](../packages/core/src/context/assembler.ts) | Assembly measured against the **selected model's** window, with pinned/evictable layers and an `overflow` signal. |
| **F9** | No model selection stage | [`providers/router.ts`](../packages/providers/src/router.ts) | Hard filter → weighted rank → circuit breaker → fallback. `capability_mismatch` and `provider_unavailable` are first-class failure classes. |
| **F10** | Sandbox undefined | [`tools/sandbox/exec.ts`](../packages/tools/src/sandbox/exec.ts), [`tools/paths.ts`](../packages/tools/src/paths.ts) | T0/T1/T2 tiers, wall-clock kill (SIGTERM→SIGKILL), output cap, env scrubbing, path jail. |
| **F11** | Summariser was an injection surface | [`guard/output-guard.ts`](../packages/core/src/guard/output-guard.ts) | Per-run random nonce; fence-forgery neutralised; artifact spill keeps the summary inside the envelope. |
| **F12** | Gates were one boolean | [`gates/vector.ts`](../packages/core/src/gates/vector.ts) | Per-gate severity and retryability. `GateFailure` carries retryability into the classifier. |
| **F13** | Deployment ungated | [`tools/builtins.ts`](../packages/tools/src/builtins.ts) | `purity: "irreversible"`; `git_push` asks at execution time regardless of plan approval. |
| **F14** | No cancellation | [`run/cancellation.ts`](../packages/core/src/run/cancellation.ts) | Cooperative token + `AbortSignal`; cancel checkpoints rather than discards. |
| **F15** | No cost accounting | [`budget/meter.ts`](../packages/core/src/budget/meter.ts) | Token/cost/wall meters, warn-once at threshold, throw past the limit. |
| **F16** | Rejection reason lost | [`protocol/plan.ts`](../packages/protocol/src/plan.ts) | `Plan.rejectionReasons` carried into replanning. |
| **F17** | Persona not bound to capability | [`tools/registry.ts`](../packages/tools/src/registry.ts) | Permission matrix is persona-scoped; the summariser is granted no tools at all. |
| **F18** | No provenance | [`events/log.ts`](../packages/core/src/events/log.ts), [`events/fold.ts`](../packages/core/src/events/fold.ts) | Append-only log; run state is `fold(events)`. |

The corrected flow is wired end to end in
[`run/supervisor.ts`](../packages/core/src/run/supervisor.ts).

## Deviations from the plan

Four, all deliberate.

**`node:sqlite` instead of better-sqlite3.** Node 24 ships SQLite in core, which removes a native
compile step on Windows — a real source of install friction. It is imported through `createRequire`
because Vite 5's builtin list predates `node:sqlite` and rewrites the specifier to a bare `sqlite`
package that does not exist.

**No parameter properties anywhere.** Node's `--experimental-strip-types` rejects them, and running
TypeScript directly with no build step is worth more than the syntax sugar. Fields are declared
explicitly.

**Typecheck-only tsconfig, no emit.** Source runs directly; `tsc` is a checker, not a compiler.

**Chat before the DAG.** [Milestone 3](05-implementation-plan.md#m3--workspace--chat-7d) shipped
first, as planned — the chat REPL, workspace registry, tool loop and output guard all work today.
The planner that produces a DAG does not exist yet, so `RunSupervisor` is driven by tests and by
hand-built plans rather than by a model.

## What works end to end

```bash
node --experimental-strip-types packages/cli/src/bin.ts doctor
node --experimental-strip-types packages/cli/src/bin.ts models
node --experimental-strip-types packages/cli/src/bin.ts chat "how does the lock manager work?" \
  --model granite4:latest --local-only
```

Verified on this machine: all three local backends discovered, 14 models catalogued with real
capabilities, live streaming with native tool calls, tool results fenced as untrusted, and the
path jail rejecting a hallucinated absolute path (`/home/runner/work`) mid-conversation.

One finding worth recording: the llama.cpp adapter had to learn **router mode**. Llama AI Studio
runs `llama-server` as a router whose `/props` describes the router itself — `model_path: "none"`,
`n_ctx: 0` — so a naive read produced a phantom zero-context model. Reading `/v1/models` and parsing
each entry's launch argv instead yields 7 real GGUFs with correct residency, context and quantization.

## Not built yet

- **Planner** — a model producing a schema-constrained DAG. `RunSupervisor` consumes plans; nothing
  generates them.
- **Memory T2/T3/T4** — tables exist, retrieval and write-back do not.
- **Capability probing** — scorecard table exists; the probe suite does not, so context windows are
  advertised rather than measured.
- **Daemon and desktop app** — the CLI talks to the engine in-process.
- **llama.cpp GBNF path** — `completeWithGrammar` exists; the Zod→GBNF compiler does not.
- **Injection red-team corpus** — output-guard unit tests cover fence forgery; the full corpus does not exist.
