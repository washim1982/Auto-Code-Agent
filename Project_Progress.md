# Project Progress

What changed from the original design, what was learned building it, and what still needs doing.

For *how the system works*, see [Project_context.md](Project_context.md).

---

## Where this came from

The starting point was a flow diagram — *"How the coding agent runs a task"* — describing an agent
pipeline: guard input → optimize prompt → plan a DAG → schedule → execute in a sandbox → gate →
review → write back to four memory tiers.

The work went: **review the diagram → design the interfaces → implement it**.

| Stage | Output |
|---|---|
| Review | [docs/01-flow-review.md](docs/01-flow-review.md) — 18 findings, corrected flow |
| Design | [docs/02](docs/02-architecture.md)–[06](docs/06-ui-design.md), [design/ui-design.html](design/ui-design.html) |
| Implement | 7 packages, 244 tests, [docs/07](docs/07-implementation-status.md) |

**Current state:** all 12 milestones implemented. 244 tests passing, typecheck clean, verified live
against local models.

---

## Changes from the original flow

The diagram was sound in shape and better than most agent frameworks in several places — declared
write sets checked *before* execution, checkpoint-before-mutate, tool results tagged as data, a real
error taxonomy. Eighteen things needed fixing. All are closed with a test that fails on regression.

### Correctness — would corrupt state or hang

| # | Original behaviour | What it does now |
|---|---|---|
| **F1** | `Retry, max 2` written on the box, enforced nowhere. A stateless classifier re-labels the same failure transient forever. | Attempt counter lives on the node record and is checked **before** the taxonomy. A loop test asserts termination. |
| **F2** | Reviewer rejection re-ran the node with no cap and no progress check. | Round cap escalates instead of looping; critiques deduped by stemmed semantic hash; block evicts oldest-first to stay in budget. |
| **F3** | `happens-before` edges added in discovery order — A ordered after B, later B after A, ready queue stalls forever. | Canonical-order, all-or-nothing acquisition. Deadlock impossible by construction. **300-trial fuzz** asserts no locks survive a drain. |
| **F4** | Write sets declared by the planner, never verified against what the node actually did. | Enforced at the tool API, plus post-hoc tree verification that catches a subprocess writing behind our back. |
| **F5** | "Park node, release locks" — a sibling could mutate the resource while a human deliberated, making the checkpoint a lie. | Parked nodes **retain** their locks, flagged `parked`; the release path skips them. |
| **F6** | Rollback was node-local. Siblings that already *read* those writes kept conclusions built on data that no longer existed. | Nodes declare read sets; rollback transitively dirties and requeues every consumer, depth-capped against churn. |
| **F7** | Cache hit served whenever a call was "idempotent" — no invalidation at all. | Keys include a per-resource epoch; a committed write makes prior keys unreachable. Glob reads registered so writes beneath them invalidate. |

### Behaviour under load and attack

| # | Original behaviour | What it does now |
|---|---|---|
| **F8** | Budget checked once, above the planner — the recovery path could blow the window freely. | Precondition of every model call, measured against the *selected* model's real window. |
| **F9** | **No model-selection stage existed at all.** | Explicit routing: capability filter → weighted rank → circuit breaker → fallback, with `provider_unavailable` and `capability_mismatch` as first-class failure classes. |
| **F10** | "Execute tool in sandbox" appeared twice and was never defined. | T0/T1/T2 tiers with timeouts, SIGTERM→SIGKILL, output caps, env scrubbing, path jail. |
| **F11** | The >2KB path returned "handle plus summary" — but that summary came from a model reading untrusted bytes and flowed back unwrapped. | Nonce-fenced envelope, fence-forgery neutralisation, summary inside the envelope, summariser gets no tools. |
| **F12** | `Static gates pass?` was one boolean. | A vector with per-gate severity and retryability. A secrets hit never auto-retries. |
| **F13** | Deployment sat after the last approval point. | `purity: "irreversible"` — asks at execution time regardless of plan approval. |

### Missing capabilities

| # | Added |
|---|---|
| **F14** | Cooperative cancellation; cancel checkpoints rather than discards |
| **F15** | Token/cost/wall meters shared between executor and supervisor |
| **F16** | Rejection reasons carried into replanning as hard constraints |
| **F17** | Personas declare routing requirements; the reviewer requires model independence |
| **F18** | Append-only event log; run state is `fold(events)` |

---

## Milestone completion

| | Milestone | State |
|---|---|---|
| M0 | Spine | Workspace, protocol, SQLite, event log, layered config, secret store, redacting logger |
| M1 | Model layer | 5 adapters, GBNF, router, residency, probe suite, tool-call shim |
| M2 | Tools & sandbox | Registry, permission matrix, tiers, checkpoint, epoch cache, output guard |
| M3 | Workspace & chat | Registry, threads, file tree with agent overlays, read-only tool loop |
| M4 | Single-node execution | Input guard, spec compiler, assembler, budget, agent loop, gates |
| M5 | Planner & scheduler | Schema-constrained DAG, validation, deterministic repair, locks, personas |
| M6 | Memory tiers | T2, T3 hybrid retrieval, T4 with confirmation and retirement |
| M7 | Gates, review, recovery | Gate vector, independent reviewer, taxonomy, cascade |
| M8 | Daemon | JSON-RPC over WebSocket, workspace pool, approval broker |
| M9 | CLI | Ink TUI plus 9 commands with full flag parity |
| M10 | Desktop | Electron with hardened preload, 6 views |
| M11 | Hardening | Injection corpus, cassette replay, golden flow, scheduler fuzz |

---

## Deviations from the plan, and why

**`node:sqlite` instead of better-sqlite3.** Node 24 ships SQLite in core, removing a native compile
step on Windows — real install friction. Imported through `createRequire` because Vite 5's builtin
list predates `node:sqlite` and rewrites the specifier to a bare package that doesn't exist.

**`tsx` loader instead of plain `--experimental-strip-types`.** Node cannot handle JSX, and the TUI
needs it. Source still runs directly; the only build step is the desktop app.

**No TypeScript parameter properties anywhere.** Node's strip-only mode rejects them, and running TS
directly was worth more than the syntax sugar.

**Vectors scanned in JS, not `sqlite-vec`.** Embeddings stored as BLOBs and cosine-scanned. At repo
scale (~1k chunks × 768 dims) that is milliseconds and avoids a native extension entirely.

**Secrets in a mode-0600 file, not an OS keychain.** `keytar` is a native module. Environment
variables are read first; the file is never merged into config and never logged.

**Electron, not Tauri.** No Rust toolchain on this machine, and the engine is Node with native deps.
Cost of being wrong is confined to `packages/desktop`.

---

## Bugs found by running it live

Every one of these passed the unit tests. They are the argument for end-to-end verification, and for
the event log.

| Symptom | Root cause | Fix |
|---|---|---|
| Gate failed with `spawn npm ENOENT`, retried twice, node rolled back | `npm` is a `.cmd` shim on Windows; `spawn` with `shell:false` can't find it. An *environmental* failure was being recorded as a code failure. | `resolveExecutable` walks PATH for `.cmd`/`.exe`/`.bat` |
| Then `spawn EINVAL` | Node blocks spawning `.cmd` without a shell (CVE-2024-27980 mitigation) | `windowsSpawnArgs` invokes `cmd /d /s /c` with per-argument quoting, **rejecting** args containing `%`/`!`/`"` rather than reaching for `shell:true` |
| `'C:\Program' is not recognized` | `cmd /s /c` strips only the outermost quote pair | Wrap the whole command line in an extra pair |
| Run reported `0 tokens` while burning GPU for minutes | Executor emitted usage *events* but never fed the supervisor's meter — F15 was inert in the live path | Executor and supervisor share one `BudgetMeter` |
| A 3B model read the same file 7 times and never wrote | Re-serving the cached result looks like new information | Duplicate call signatures get told they already have the result |
| Node marked `done` having modified nothing | Gates pass trivially with no changed files | A node that declared writes and produced none now fails its contract |
| Planner burned all 3 repair rounds on one mistake | Small models put file paths in `deps`; the error was accurate but didn't correct the misconception | Path-shaped deps moved to `reads` deterministically, no round-trip |
| `qwen3.5:0.8b` tied with `qwen3.6:35b` for a coding task | Capability scored from context window alone; both advertise 262k | Weighted by on-disk weight size, log-scaled |
| llama.cpp advertised a phantom zero-context model | Llama AI Studio runs a **router** whose `/props` describes the router, not a model | Detect `role: "router"`, read `/v1/models`, parse each launch argv → 7 real GGUFs |
| Bad daemon token completed the handshake, then dropped | Auth ran after the socket opened, so `connect()` resolved | Authenticate during the HTTP upgrade via `verifyClient` |
| Indexing died entirely when the embedding server was down | The embedder throw propagated out of `indexFile` | Degrade to BM25-only; a text index beats no index |
| Desktop loaded `dist/main/dist/renderer/index.html` | `app.getAppPath()` returns the entry script's directory under `electron dist/main/index.cjs` | Resolve from `__dirname` |
| Critique dedup missed "it leaks memory" vs "will leak memory" | No stemming, so the reviewer could ping-pong on one objection | Suffix stripper before hashing |
| Cached `grep src/**` survived a write to `src/mw/x.ts` | Glob resources were never registered in the epoch table | Register read resources at cache-write time |
| Chat called `list_dir "."` eight times and never answered | `ChatMessage` had nowhere to put the assistant's tool calls, so every adapter sent a `tool` result bound to nothing. Providers drop an unbound result, so the model could not see that the tool had already run. | `toolCalls` on `ChatMessage`, emitted as `tool_calls` (OpenAI/Ollama) and `tool_use` blocks (Anthropic) |
| …and the answer never appeared in the desktop app | The step cap `break`s without broadcasting `chat.turn`, and that notification is the only thing that clears the client's streaming bubble | Every exit path settles through one function; exhausting the cap forces one tool-less answer |
| Thinking from six rounds piled into one unresolving bubble | Same cause — nothing cleared `streaming` between rounds | Intermediate rounds commit their turn, which clears it |
| Each message appeared twice in the desktop chat | The renderer appended the user turn optimistically *and* rendered the daemon's echo | The daemon is the single source of truth; `run.plan` now echoes the turn too, so the plan path still shows it |
| A model that writes `{"name": …}` as prose had it rendered as its answer | Advertised `tools: "native"`, so the shim never engaged and nobody parsed the text form | Salvage a text-shaped call when no native one arrives; `extractCall` scans balanced objects so two calls on two lines still parse |
| File tree showed every directory expanded, with a `▸` on each that did nothing | The caret was decorative; there was no collapse state anywhere | Real open/closed state, one-pass depth filtering, no caret on a directory the walk never entered |
| Model replies rendered `##`, `**` and pipe-tables as literal text | `.msg` was `white-space: pre-wrap` over a raw string — nothing parsed Markdown | A small parser and renderer, built from a tree so model output can never become markup; `javascript:` and `data:` hrefs render inert |
| Every tool result carried a crimson "fenced as untrusted" banner, read as an error | Routine fencing was styled with the palette's failure colour, so the one thing worth alarming about looked identical to the 99% that was not | Routine case is a slate `fenced` badge; crimson is now reserved for `forgeryNeutralised` — content that actually tried to close its own envelope |

---

## Corrections to earlier claims

Stated plainly because they were wrong when first reported.

**The CLI was not Ink.** A task was named "Build Ink CLI" and what shipped was a readline REPL
wearing the visual spec — no focus cycling, no thread/graph toggle, no live panels. That has since
been replaced with a real Ink TUI. The substitution should have been flagged when it was made.

**F17 was thinly closed, then properly closed.** It was first satisfied only by a persona-scoped
permission matrix. The finding was about *model capability* binding — "a reviewer persona on a 0.8B
model is worthless". `PersonaRegistry` now declares routing requirements per persona and the
reviewer requires independence from the coder's model.

**The plan total was misstated.** "~62 days" was reported when the milestones summed to 72, later
83 after chat and workspace management were added.

---

## What still needs doing

Ordered by value per effort. None of these block using what exists.

### High value, small effort

**1. Wire the probe suite to a command.** `ProbeSuite` is built and targets `model_scorecards`, but
nothing triggers it — so context windows are still *advertised* rather than *measured*. `qwen3.5:0.8b`
claims 262k and cannot retrieve past ~32k. An `aca models probe --all` command plus reading the
scorecard in `rejectReason` closes it. **~2 hours.**

**2. Have the run loop write T2 and T4.** The stores, confirmation gate and retirement logic are all
built and tested, but `RunSupervisor` never calls them — so lessons accumulate only when written by
hand, and node deltas never reach dependents. Two hooks in the supervisor. **~3 hours.**

**3. Inject retrieved context into node execution.** The T3 index is built and queryable, but
`makeExecutor` doesn't retrieve — nodes see only their contract. Adding a retrieval layer to the
context ladder is the single biggest quality improvement available. **~4 hours.**

### Medium

**4. Execute runs from the TUI.** It plans and hands off to `aca run`. The supervisor needs wiring
into the TUI event loop so the DAG panel updates live. **~1 day.**

**5. Start runs from the desktop app.** Currently read-mostly: it shows runs, files, models,
timeline and answers approvals, but starting one goes through the CLI. Needs `run.create`/`run.start`
RPC methods and a composer. **~2 days.**

**6. Exercise the Docker T2 sandbox.** Defined and reachable but never run. On Windows it is the only
real isolation boundary, so "untested" is a meaningful gap. **~half a day.**

### Larger

**7. A code-specific embedding model.** Semantic retrieval is mediocre on prose-shaped queries —
identifier lookup is excellent, "how does X work" returns the right area with noisy ordering. A
code-tuned embedding model would help more than tuning the fusion. **Evaluation work.**

**8. Diff review UI.** Designed in [docs/06](docs/06-ui-design.md) — per-hunk reject feeding the
critique loop — but not built in either front-end. **~2 days.**

**9. Packaging.** `electron-builder`, code signing, an installer. The desktop app currently runs from
source. **~2 days.**

### Known limits that are choices, not gaps

- **Windows T1 sandboxing is advisory.** Path jailing and Job Objects guard against mistakes, not a
  determined escape. Detection via `Checkpoint.verify()` is the honest compensation. Docker T2 is the
  boundary for anything genuinely untrusted.
- **Intent classification in the TUI is keyword-based.** Deciding "is this a question or a task?"
  with a model costs a round-trip per message on local hardware. `/plan` overrides it.
- **No multi-machine story.** The daemon binds loopback only and there is no remote access path,
  which is why the auth story is a single token.

---

## Commit history

| | |
|---|---|
| `cf068ca` | The full desktop UI from the design spec — all eight views |
| `44c6924` | Memory and probing gaps closed; clients can drive the engine |
| `63e5345` | Project_context and Project_Progress reference docs |
| `af302bb` | M10 desktop and M11 hardening — all 12 milestones implemented |
| `ce12877` | M0–M9: guard, personas, reviewer, memory, daemon, Ink TUI |
| `b7bee16` | The planner: goal to executed DAG on local models |
| `c367891` | The corrected agent flow from docs/01-flow-review.md |

---

## Verified live

- **Full flow** — `aca run "make divide throw a clear error when b is zero"` produced a 3-node DAG,
  executed it, wrote the correct guard clause, passed gates. 60s, 20k tokens, 57 events, local only.
- **Model layer** — 14 models across three backends with real capabilities and residency.
- **Memory** — this repo indexed to 950 chunks; `cascadeInvalidate` returns its exact definition,
  "how do we stop two nodes writing the same file" returns `resource.ts`.
- **Daemon** — every RPC exercised against a live instance.
- **Desktop** — all eight views captured from a running window against a live daemon
  ([design/screens](design/screens/)); chat with tool calls, streaming and diffs verified over RPC.
- **Probing** — granite4 measured at 32k real context against a 128k advertisement.
- **Path jail** — caught a model hallucinating `/home/runner/work` mid-conversation.
