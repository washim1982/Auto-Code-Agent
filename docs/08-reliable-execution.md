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
retry path rarely changes an outcome. The plumbing exists: `dirtyReason` already lives on
the node record ([supervisor.ts:391](../packages/core/src/run/supervisor.ts:391)) and the
assembler already takes pinned layers.

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

## Sequencing

| Stage | Items | Unblocks |
|---|---|---|
| 1 ✅ | 0.1, 0.2, 0.3 | Nodes finish. This alone probably fixes the observed run. |
| 2 | 1.1, 1.2 | A node that still fails gets a real second attempt. |
| 3 | 2 | Fewer first-attempt failures. |
| 4 | 3.1, 3.2 | The next failure of this kind is diagnosable from the UI, and the above stays fixed. |

Stage 1 is worth shipping and testing against a real run before starting stage 2 — if the
budget fix alone clears it, stages 2 and 3 change from urgent to routine hardening.

## What this does not fix

- **Model capability.** If `qwen3.6:35b` cannot produce a correct implementation plan, a
  larger step budget only lets it fail more thoroughly. The speculative-tiering escalation
  in [03-model-layer.md](03-model-layer.md#speculative-tiering) is the lever for that,
  not this document.
- **Plans that declare the wrong write set.** A node told to write a file it has no
  business writing fails correctly today. That is a planner problem.
- **Token cost.** Every item in P0 raises tokens per node. The budget meter (F15) already
  reports it; watch it after stage 1.
