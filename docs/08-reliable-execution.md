# 08 — Reliable node execution

A node must finish the work it declared. Today it can run out of budget mid-research,
get blamed for writing nothing, and be failed permanently on its first attempt with no
feedback carried anywhere. This document is the plan to close that.

Evidence throughout is from `run-msg2lqcd` in `new-project-test`, the run that produced
the symptom.

## What actually happened

Node `analyze_requirements`, declared write set `["Implementation_steps.md"]`, routed to
`qwen3.6:35b`.

```
#147  node.routed      qwen3.6:35b
#149  read_file        project_context.md (30 079 bytes)
 …    36 tool calls:   12 read_file · 10 grep · 8 glob · 6 list_dir
#196  node.failed      declared writes (Implementation_steps.md) but modified nothing
                       attempts: 1 → permanent → rollback
#200  run.paused       no runnable nodes
```

`write_file` was called **zero** times across all 61 events.

The tempting read is "the model was lazy." It was not. There are exactly **12**
`model.response` events, and the tool loop is `for (let step = 0; step < 12; step++)`
([executor.ts:203](../packages/cli/src/executor.ts:203)). The model did not stop — it was
cut off, still reading, and never reached the write.

## Root cause chain

Five separate defects compound into one dead run. Each is independently fixable and each
one alone would have softened the failure.

| # | Defect | Where |
|---|---|---|
| 1 | Step cap is hardcoded at 12, never surfaced to the model, and consumed entirely by research | [executor.ts:203](../packages/cli/src/executor.ts:203) |
| 2 | Cap exhaustion is indistinguishable from natural completion — both just exit the loop | [executor.ts:240](../packages/cli/src/executor.ts:240) |
| 3 | The post-loop check reports cap exhaustion as "modified nothing", blaming the model for a budget failure | [executor.ts:349](../packages/cli/src/executor.ts:349) |
| 4 | That error is a plain `Error`, so `classify()` falls through to `permanent`/`rollback` on attempt 1 of 2 | [classifier.ts:134](../packages/core/src/recovery/classifier.ts:134) |
| 5 | Even when a retry *does* fire, it carries no feedback — `case "retry"` sets `status = "ready"` and nothing else | [supervisor.ts:339](../packages/core/src/run/supervisor.ts:339) |

Defects 4 and 5 matter beyond this run. The executor comment at defect 3 states the
intent plainly — *"Better to fail and let the retry carry the feedback than to report
success"* — and neither half of that is true today: the retry does not happen, and if it
did it would carry nothing. Retries are currently blind repeats of the same attempt with
the same context.

Defect 4 is also a known trap in this codebase. `GateFailure` exists solely to escape it;
its docstring says a failing unit test *"produces a message that matches none of the
transient patterns, so pattern matching alone classifies it `permanent` and rolls the node
back on the first try."* Same shape, different error, and this one never got its class.

## P0 — the node must be able to finish

### 0.1 Separate the two loop exits

Track why the loop ended.

```ts
let exhausted = true;
for (let step = 0; step < maxSteps; step++) {
  …
  if (calls.length === 0) { exhausted = false; break; }
}
```

`exhausted` then drives a different error and a different verdict. Nothing else in this
plan works without it, because today both paths produce the same misleading message.

### 0.2 Warn the model before the cap, not after

At two-thirds of the budget, push a tool-role message into `messages`:

> You have N steps left. Stop gathering context. Write every path in your declared write
> set now, then say DONE.

This is the single highest-value change here. The model had the context it needed by
roughly step 6; it kept reading because nothing told it the clock was running. Same
mechanism as the `seenCalls` and `EmptyResultStreak` nudges already in the loop — a
message the model can act on, rather than a limit it discovers by being killed.

### 0.3 Make the budget fit the work, and configurable

12 steps is too few for a node that must read several files *and* write. Replace the
literal with a config value (default 24) plus a floor scaled to the declared write set —
a node writing three files needs at least three steps it cannot spend on research.

Cost note: steps are model round-trips. Raising the default trades tokens for completion
rate. 24 is a starting point to be tuned against real runs, not a settled number.

**Shipped.** [`StepBudget`](../packages/core/src/run/step-budget.ts), config `run.maxSteps`
(default 24). The floor is `declaredWrites + 1` rather than a research allowance added on
top: the first draft used `RESEARCH_STEPS + writes`, which silently overrode a
deliberately small configured maximum. A test caught it. The reserve, not the floor, is
what protects research budget from being spent on writes.

### 0.4 The output ceiling is a second invisible budget

Found by running stage 1. `analyze_context` passed — the warning fired at step 16 and the
node went `DONE`. `implement_features` then failed the same way for a different reason:

```
#297  model.response   outputTokens: 2000      ← exactly the ceiling
#298  node.failed      declared writes (8 paths) but modified nothing
```

`maxTokens` was hardcoded at `2000` ([executor.ts](../packages/cli/src/executor.ts)). The
model spent ten steps researching, then began emitting `write_file` with a full source
file and was cut off mid-JSON. A truncated tool call does not parse, so `calls.length ===
0`, which the loop read as *the model is finished* — `exhausted` stayed false and the node
was failed for writing nothing. It was mid-write.

Every provider already yields `{ type: "done", stopReason }`, and the executor handled
`text`, `tool_call` and `usage` but never `done`. The truncation signal was on the wire
the whole time and thrown away.

**Shipped.** Two changes. The ceiling now comes from the routed model's own
`caps.maxOutputTokens`, clamped by config `run.maxOutputTokens` (default 8192) — the
literal was discarding three quarters of what `qwen3.6:35b` offers. And `stopReason ===
"length"` with no parseable call no longer ends the loop: it emits `model.truncated`,
tells the model its call was cut off and to write one file per step, and continues.

This is the same defect as 1, 2 and 3 in a third place: a limit the model cannot see,
enforced by silent truncation, reported as a decision the model did not make. Worth
checking whether any other hardcoded ceiling has the same shape.

## P1 — recovery does what it says

### 1.1 `ContractUnmet` error class

Follows the `GateFailure` precedent exactly ([classifier.ts:65](../packages/core/src/recovery/classifier.ts:65)):

```ts
export class ContractUnmet extends Error {
  readonly declared: readonly string[];
  readonly exhausted: boolean;   // from 0.1
}
```

Classified as `transient`/`retry` when attempts remain. A node that ran out of steps has
an obvious next move; a node that stopped early with budget to spare is the more
interesting case and should still get its second attempt, since attempt 2 will now carry
feedback it did not have.

### 1.2 Retries carry the failure forward

`case "retry"` must record why. Add a `retryReason` to the node record, and have the
executor inject it as a pinned context layer:

> Attempt 1 failed: you declared `Implementation_steps.md` and did not write it. Write it
> this time before doing anything else.

Without this, attempt 2 is a coin flip on identical input — which is why the current
retry path rarely changes an outcome.

**Shipped.** `ContractUnmet` classified as `transient`/`retry`; `retryReason` on the node
record, set by `case "retry"` and folded into the node brief.

Folded into the brief, specifically — not added as its own pinned layer, which is what the
first version did. Pinned layers reach the model through `NODE_SYSTEM` and the brief, and
`context` is built from the *unpinned* ones, so a pinned retry layer was accounted for
against the budget and then rendered nowhere. A test caught it. The lesson generalises:
`assembled.layers` is a budget model, not the message list.

### 1.3 Why prose kept winning

Run `run-msgwg30c` failed after all of P0: the warning fired correctly at 8 steps
remaining, and the model answered with 1493 tokens of prose and no tool call. Not
truncated, not out of steps — it wrote the file contents into its reply.

`NODE_SYSTEM` said "Read before you write" and the `coder` persona said "Read before
writing", and nothing anywhere said a description is not a change. Worse, `lowStepsNotice`
ended with "say what is missing", which reads as an invitation to explain rather than act.

Both fixed: the system prompt now states that the contract is unsatisfied until every
declared path has been written and that only a tool call changes a file, and the low-steps
notice tells the model that contents in a reply change nothing and the node will fail.

## P2 — stop biasing the prompt toward reading

`NODE_SYSTEM` says *"Read before you write"*; the `coder` persona says *"Read before
writing"*. Two instructions to read, none to finish, and no mention of a budget.

Add to `NODE_SYSTEM` ([executor.ts:60](../packages/cli/src/executor.ts:60)):

> Your contract is not satisfied until every path in your declared write set has been
> written. Gather only the context you need, then write. If you cannot write a declared
> path, say why — do not stop silently.

## P3 — make this visible and testable

### 3.1 Surface step usage

Emit `node.steps_exhausted` and include `steps: used/max` in `node.done` and
`node.failed`. Right now the only way to learn a node hit the cap is to count
`model.response` events by hand against a literal in the source — which is how this
diagnosis was made, and is not a reasonable ask of the UI.

### 3.2 An executor test harness

Three fixes now ride on `makeExecutor` with no test covering it: the read-only gate skip,
the `EmptyResultStreak` wiring, and everything in P0 above. A harness needs a fake
provider with a scripted tool-call script, an in-memory registry, and a temp workspace —
real work, but every item in P0/P1 is a behaviour that should be asserted rather than
argued.

Cases worth pinning: cap exhaustion vs natural exit; the warning fires once at the right
step; a node that writes its declared set passes; a node that does not fails with
`ContractUnmet`; attempt 2 sees the retry reason.

**Shipped.** [`executor-harness.ts`](../packages/cli/test/executor-harness.ts) plus twelve
tests. Everything is real except the round-trips — real registry, real builtins, real
checkpoint against a real temp workspace; only the model is scripted, one turn per
request, with `stopReason` and `caps` under the test's control.

All twelve passed on the first run, which is the point at which a test suite deserves
suspicion rather than confidence. Mutation-checked by reverting each fix in turn: ignoring
`stopReason` fails 2, restoring the unconditional gate call fails 1, restoring `maxTokens:
2000` fails 2, and dropping the `exhausted` distinction fails 1. Six tests demonstrably
bind to the behaviour they claim to.

## Sequencing

| Stage | Items | Unblocks |
|---|---|---|
| 1 ✅ | 0.1, 0.2, 0.3 | Nodes finish. This alone probably fixes the observed run. |
| 2 ✅ | 1.1, 1.2 | A node that still fails gets a real second attempt. |
| 3 ✅ | 2 | Fewer first-attempt failures. |
| 4 | 3.1, **3.2 ✅** | The next failure of this kind is diagnosable from the UI, and the above stays fixed. |

Stage 1 is worth shipping and testing against a real run before starting stage 2 — if the
budget fix alone clears it, stages 2 and 3 change from urgent to routine hardening.

### 1.4 A retry reason that says nothing

Run `run-msgy5akh` is the first where the model actually wrote: six `write_file` calls, a
real retry, two attempts. It failed on `src/types.ts(369,18): error TS1005` — invalid
TypeScript in a file the node itself had just written, correctly caught by the gates.

The retry then learned nothing, because `GateFailure` was constructed from gate *names*
only. `retryReason` came out as `gates failed: typecheck, unit` — that it failed, and
nothing to act on. The compiler output sat in `GateResult.detail` and was discarded.

**Shipped.** `GateFailure` takes a `details` string, built by `gateDetail()`, which strips
ANSI (vitest wraps everything in it), keeps the first 8 lines and 600 characters per gate,
and reports how many lines it dropped. Raw output is not usable as feedback: tsc will list
every error in the project and vitest emits screenfuls, both burying the lines that say
what to fix — and the tail of that goes straight into the next prompt.

### 1.5 Budget

That run ended `BudgetExceeded: tokens 403191 of 400000`. That is F15 working, not a
defect. But it is worth reading together with 1.4: a retry that could not see the compiler
error spent a full second attempt re-deriving the same broken file. Fixing the feedback is
the cheaper half of fixing the budget. `budget.maxTokens` is the knob if a run legitimately
needs more.

### 1.6 The same defect in the planner

The doc noted after 0.4 that it was worth checking whether any other hardcoded ceiling had
the same shape. It did.

`collectText` — the shared stream drain used by the structured-output path and the probe
suite — accumulated text, thinking, tool calls and usage, and dropped `stopReason` on the
floor exactly as the executor once did. So `generateStructured` could not tell a reply cut
off mid-JSON from a model that simply emits malformed JSON, and its repair turn told a
truncated model to "return only a JSON object, no prose, no code fence" — advice that
cannot help, since the problem was length. Three attempts, same wall.

The surface error was `model lmstudio/google/gemma-4-31b could not produce valid output
after 3 attempts`: the model's name and nothing else. The Zod issues and the raw attempts
were both computed and both discarded.

**Shipped.** `collectText` returns `stopReason`. `generateStructured` keeps the last
problem — the failing field path, or truncation — and puts it in the thrown message, so it
reaches the chat surface instead of dying in the loop. A truncated attempt now gets told to
return the same structure *much shorter* rather than to reformat. And the ceiling comes
from `descriptor.caps.maxOutputTokens` (floor 2048, cap 8192) rather than a flat 2048,
which a plan DAG with read and write sets does not fit inside.

That makes four places the same defect appeared: node step budget, node output ceiling,
gate detail, and now structured output. The shape is always **a limit or a diagnosis the
system has and does not pass on**.

### 1.7 The loop pays for itself, repeatedly

The budget wall was not a budget problem. Measured on `run-msi9tf83`:

| node | steps | input tokens | output tokens |
|---|---|---|---|
| `analyze` | 17 | 113,186 | 9,058 |
| `implement` | 41 | 263,402 | 17,812 |
| | | **376,588** | **26,870** |

**Input is 93% of the spend.** The context assembler (F8) sizes the *opening* context
against the model's window and then hands the loop a message list that nothing ever
trims. Every step re-sends the whole conversation, so cost grows with the square of the
step count, and a read from step 2 is still being paid for at step 41. Raising
`budget.maxTokens` would buy a few more steps of the same curve.

**Shipped.** [`compactMessages`](../packages/core/src/run/compaction.ts), run at the top of
each step once the conversation passes half the model's window. It elides the *bodies* of
old tool results and nothing else:

- The message stays, only its content is replaced. Providers reject a conversation where a
  `tool` result does not answer an assistant `tool_calls` entry, so dropping them outright
  breaks the request instead of shrinking it.
- The system prompt and node contract are never touched, for the same reason the assembler
  pins them.
- The last 8 messages are never touched — that is the model's working memory.
- The model's own turns are never touched. Its reasoning is how it knows what it already
  tried; a tool result is the part it has already taken what it needs from.
- The stub says the result is retrievable (`call read_file again`) rather than implying the
  information is gone.

### 1.8 Wasted round-trips leave permanent residue

The same run had 15 failed `run_command` calls: `spawn cat ENOENT`, `path escapes the
workspace: /tmp/extract_steps.js`, `Cannot find module`, null bytes in args. The model was
reaching for shell one-liners to read and transform files on a platform with no shell.

Each failure costs a round-trip *and* leaves its error in the conversation for every later
step to re-send. The tool description now says plainly that there is no shell, that `cat`,
`ls`, `echo`, `sed` and `grep` do not exist, that `/tmp` does not exist, and that the
dedicated file tools are what to use instead.

## 2 — Context as a budget, not a hope

Reviewed end to end, there are four mechanisms, and they were not connected.

| Mechanism | Scope | State |
|---|---|---|
| `ContextAssembler` | opening context per node | works; runs once |
| `compactMessages` | inside the tool loop | added in 1.7 |
| `OutputGuard` | tool output over 2 KB → `.aca/artifacts/<id>.txt` | wrote files nothing could read |
| `MemoryStore` T2/T3/T4 | across nodes and runs | T3/T4 read; **T2 write-only** |

### 2.1 The artifact store was write-only

The guard has always spilled results over 2 KB to disk and handed the model an id, a
summary, and the first 800 characters. There was no tool to fetch the rest. A model needing
line 400 of a 30 KB result could only call `read_file` again — spilling again, seeing the
same 800 characters. Saving to a file that cannot be read back is not offloading; it is
losing the data with extra steps.

**Shipped.** `read_artifact(id, startLine, endLine)` — pure, `t0`, allowed for every
persona that can read files and denied to the summariser (F11). The id is validated as a
content hash before it is joined onto a path. This is what makes "keep big things in files"
real: content lives on disk and the window pays only for the slice actually needed.

### 2.2 T2 was written and never read

`MemoryWriteback.onNodeDone` records what each node concluded. `taskMemory()`'s only caller
was a test. Rank 5 of the ladder in [02-architecture.md](02-architecture.md) — "T2 deltas
from direct dependency nodes" — existed on paper while every node rediscovered the
repository from scratch through tool calls. That is a large part of why one node cost
113,186 input tokens and the next cost 263,402.

**Shipped.** The executor now reads `taskMemory(runId, node.deps)` and injects it as rank 5,
scoped to direct dependencies so a node inherits its predecessors' conclusions and nothing
else.

### 2.3 The planner was told to make nodes large

`Prefer 3-6 nodes. One node per coherent unit of work, not per file.` The node that
exhausted a 400,000-token budget without finishing declared **eight** write paths. The
planner was doing as instructed.

**Shipped.** The prompt now asks for 4-10 small nodes, at most 3 write paths each, split by
file or concern rather than by phase. `validatePlan` raises a warning above three write
paths, which feeds the existing repair loop — so an oversized plan gets one chance to split
itself before a human sees it.

## What this does not fix

- **Model capability.** If `qwen3.6:35b` cannot produce a correct implementation plan, a
  larger step budget only lets it fail more thoroughly. The speculative-tiering escalation
  in [03-model-layer.md](03-model-layer.md#speculative-tiering) is the lever for that,
  not this document.
- **Plans that declare the wrong write set.** A node told to write a file it has no
  business writing fails correctly today. That is a planner problem.
- **Token cost.** Every item in P0 raises tokens per node. The budget meter (F15) already
  reports it; watch it after stage 1.
