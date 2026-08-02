# Implementation Status

What exists in code today, which flow-review finding each piece closes, and where the
implementation deviates from the plan. Updated as of the first implementation pass.

**135 tests passing across 7 files. `tsc --noEmit` clean. The full flow — goal → spec → DAG →
approval → execution → gates → completion — runs end to end against local models only.**

```bash
pnpm install
pnpm test          # 135 tests
pnpm typecheck
node --experimental-strip-types packages/cli/src/bin.ts doctor
node --experimental-strip-types packages/cli/src/bin.ts run "<goal>" --local-only
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

## The planner

Two model calls, deliberately split: compile a spec, then plan against it. Asking for both at once
reliably produces acceptance criteria retrofitted to whatever plan the model already decided on,
which defeats the point of having a reviewer check against them.

- [`plan/schema.ts`](../packages/core/src/plan/schema.ts) — the narrow projection the model is
  qualified to produce. Deliberately *not* `PlanNode`: runtime state like `attempts` and
  `checkpointId` is not something a model should be inventing.
- [`plan/validate.ts`](../packages/core/src/plan/validate.ts) — acyclicity, dependency existence,
  workspace-relative writes, unordered write-set overlap, acceptance coverage.
- [`plan/normalize.ts`](../packages/core/src/plan/normalize.ts) — deterministic repair of
  unambiguous mistakes, before spending a model round-trip on them.
- [`providers/gbnf.ts`](../packages/providers/src/gbnf.ts) — JSON Schema → GBNF, so llama.cpp
  constrains decoding at the token level and malformed output is impossible rather than merely
  unlikely.
- [`providers/structured.ts`](../packages/providers/src/structured.ts) — strategy selection across
  `grammar` / `json_schema` / `json_mode` / `prompt`, with a repair loop that feeds Zod's exact
  field-level errors back to the model.

**End-to-end, verified:** `aca run "make divide throw a clear error when b is zero"` against a
scratch repo produced a 3-node DAG, executed it, and wrote the correct guard clause. 60s,
20k tokens, 57 events, local models only.

## Bugs the live runs found

The unit tests were green through all of these; only running it for real surfaced them.

| Symptom | Cause | Fix |
|---|---|---|
| `spawn npm ENOENT` recorded as a *gate failure*, retried twice, node rolled back | `npm` is a `.cmd` shim on Windows and `spawn` with `shell: false` cannot find it | [`resolveExecutable`](../packages/tools/src/sandbox/exec.ts) walks PATH for `.cmd`/`.exe`/`.bat` |
| Then `spawn EINVAL` | Node blocks spawning `.cmd` without a shell (CVE-2024-27980 mitigation) | [`windowsSpawnArgs`](../packages/tools/src/sandbox/exec.ts) invokes `cmd /d /s /c` with per-argument quoting, and **rejects** arguments containing `%`/`!`/`"` rather than risk injection — `shell: true` was never an option |
| `'C:\Program' is not recognized` | `cmd /s /c` strips only the outermost quote pair | Wrap the whole command line in an extra pair |
| Run reported `0 tokens` while burning GPU | The executor emitted usage *events* but never fed the supervisor's meter — F15 was inert in the live path | Executor and supervisor share one `BudgetMeter` |
| A 3B model read the same file 7 times and never wrote | Re-serving the cached result looks like new information | Duplicate tool-call signatures get told they already have the result |
| Node marked `done` having modified nothing | Gates pass trivially with no changed files | A node that declared writes and produced none now fails its contract |
| Planner burned all 3 repair rounds on the same mistake | Small models put file paths in `deps`; the error message was accurate but did not correct the misconception | Path-shaped deps are moved to `reads` deterministically |

## Not built yet

- **Memory T2/T3/T4** — tables exist, retrieval and write-back do not.
- **Reviewer** — `ReviewLoop` and the supervisor hook are implemented and tested; no critic model is
  wired into `aca run` yet, so nodes are accepted on gates alone.
- **Capability probing** — scorecard table exists; the probe suite does not, so context windows are
  advertised rather than measured.
- **Daemon and desktop app** — the CLI talks to the engine in-process.
- **Injection red-team corpus** — output-guard unit tests cover fence forgery; the full corpus does not exist.
