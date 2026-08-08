# 09 — Loop redesign, and MCP tools

Two decisions drive this document: the node execution loop is redesigned rather than tuned,
and ACA becomes an MCP **client** so local models can reach third-party tools.

They turn out to be one design. The redesign is what makes third-party tools safe to run at
all, and third-party tools are what make the redesign worth doing.

## 1 — What the current loop costs

Every number here is measured, not estimated. Sources are the event logs from
`new-project-test` and `TEST_PROJECT_01`.

| run | node | steps | input | output |
|---|---|---|---|---|
| `msi9tf83` | `implement` | 41 | 263,402 | 17,812 |
| `msiaqs6f` | `update_types` | 57 | 372,695 | 34,915 |
| `msieyxg0` | `impl_electron_main` | 54 | 177,728 | 33,034 |

**Input is 88–96% of every run.** The agent produced ~16–35k tokens of work and spent
180–370k re-reading its own conversation. Cost grows with the square of the step count,
because each step re-sends the whole message list.

The tool mix says what those steps were spent on:

```
run-msiaqs6f    read_artifact 144   grep 27   read_file 18   write_file 6
run-msieyxg0    read_artifact  38   grep 48   read_file 16   write_file  4
```

Roughly 30 reads per write.

## 2 — Why eight guards accumulated

`executor.ts` is now 1,016 lines and holds eight independent mechanisms, every one added
after a specific failure:

| guard | added because |
|---|---|
| `StepBudget` | a node spent 12 hardcoded steps reading and never wrote |
| `lowStepsNotice` | the cap was invisible until it killed the node |
| `EmptyResultStreak` | 39 greps returned nothing and it kept rewording |
| `seenCalls` | identical repeated calls |
| `ReadBudget` + tool withdrawal | it ignored the notice and read anyway |
| `compactMessages` | the conversation grew without bound |
| `spentByNode` | one node ate a whole run's token budget |
| truncation retry | a cut-off `write_file` read as "model finished" |

Each is individually correct and mutation-tested. Together they are a control system bolted
onto a loop whose real problem they never address: **research and writing share one context
and one budget**, so the model can spend the writing budget on reading, and every guard is a
different way of shouting at it not to.

That is the thing to redesign. Not one more guard.

## 3 — Two-phase node execution

Split the node into a **gather** phase and an **apply** phase, with a structured handoff
between them instead of a shared transcript.

```
   contract + T2 deltas + T3 chunks
                │
                ▼
        ┌───────────────┐   read tools only, MCP tools allowed
        │    GATHER     │   bounded by steps and reads
        └───────┬───────┘   produces a NodeBrief (structured, small)
                │
          NodeBrief  ── files it needs, facts it found, what it plans to change
                │
                ▼
        ┌───────────────┐   write tools only, no read tools at all
        │     APPLY     │   context = contract + brief + target file contents
        └───────┬───────┘   fresh message list; the gather transcript is gone
                │
                ▼
             gates
```

### What this fixes, mechanically

**The quadratic cost.** Apply starts from a fresh, small, bounded context: the contract,
the brief, and the current contents of the files it may write. It never carries 40 fenced
tool results. On the measured runs, apply would open at roughly 3–6k tokens instead of
inheriting 170k.

**The research/write transition.** It is a phase boundary, not a nudge. There is no step at
which the model *could* keep reading, so nothing has to detect that it is and intervene.

**The guards.** Most stop being separate mechanisms:

| guard | becomes |
|---|---|
| `ReadBudget`, tool withdrawal, `writeOnlyNotice` | the gather phase's step cap |
| `lowStepsNotice` | gather tells the model its remaining budget as a matter of course |
| `compactMessages` | unnecessary in apply; still useful inside a long gather |
| `EmptyResultStreak`, `seenCalls` | gather-phase only |
| `spentByNode` | unchanged — still the ceiling for both phases together |
| truncation retry | unchanged — still a real provider behaviour |

Net: fewer moving parts than today, and the two that remain (`spentByNode`, truncation)
are the two that have nothing to do with the research/write conflation.

### The handoff

```ts
interface NodeBrief {
  /** What it learned, in its own words. Bounded. */
  findings: string[];
  /** Paths it read and considers relevant, with why. */
  relevant: { path: string; why: string }[];
  /** What it intends to change, per declared write path. */
  plan: { path: string; change: string }[];
  /** Anything it could not determine — surfaces as a node failure reason. */
  blockers: string[];
}
```

Generated with `generateStructured`, so it is schema-validated and repairable — the
machinery already exists and is tested. A gather phase that cannot produce a brief fails
the node *before* any write is attempted, with `blockers` as the reason. That is a better
failure than today's "declared writes but modified nothing".

### Cost of the design

Two model calls minimum per node instead of one, so a trivial node gets more expensive. The
measured runs suggest that is not the case to optimise for: no node in this session finished
in under 24 steps.

Apply cannot discover a file it did not gather. If the brief is wrong, apply writes the
wrong thing and the gates catch it — which is the same recovery path as today, and the
retry now carries the gate output (docs/08 §1.4).

## 4 — MCP as a client

### Where MCP tools fit

Only in **gather**. That is not a limitation to work around, it is the reason the split
makes MCP safe.

ACA's safety model depends on tools reporting what they touched: `ToolResult.reads` feeds
the epoch cache (F7), `writes` bumps epochs and enforces the declared write set (F4), and
`Checkpoint` makes rollback possible. **A third-party MCP server cannot report any of
that**, and it runs outside the T1/T2 sandbox entirely.

So a writing MCP tool would be invisible to write-set enforcement until `checkpoint.verify()
caught it out of band and failed the node. Confining MCP to gather means the question never
arises: gather changes nothing, so nothing needs tracking.

### Shape

```
packages/tools/src/mcp/
  client.ts      one stdio or SSE connection, initialise + tools/list + tools/call
  registry.ts    maps an MCP tool descriptor to a ToolDef
  config.ts      servers from .aca/config.json, zod-validated
```

The mapping is the whole integration, and `ToolDef` already fits:

| ToolDef field | from MCP |
|---|---|
| `name` | `mcp__<server>__<tool>` — namespaced, so servers cannot collide with builtins |
| `description` | the server's, verbatim |
| `schema` | its JSON Schema, converted to zod for validation before the call |
| `purity` | forced `"pure"` — it is read-only by policy, see above |
| `tier` | `"t0"`; the server is a separate process ACA does not sandbox |
| `run` | `tools/call`, result text through the existing `OutputGuard` |

Three things the existing design already gives us for free:

- **Fencing.** MCP results are untrusted content from a third party, and the output guard
  already wraps every tool result in `<<<UNTRUSTED_DATA>>>` with forgery detection.
- **Permissions.** `DEFAULT_MATRIX` is per persona; MCP tools default to deny and are
  granted to `planner`/`coder`/`reviewer` gather phases explicitly.
- **Spill.** Oversized MCP output goes to an artifact like anything else, readable back
  through `read_artifact`.

### Config

```json
{
  "mcp": {
    "servers": {
      "fetch":  { "command": "uvx",  "args": ["mcp-server-fetch"] },
      "sqlite": { "command": "uvx",  "args": ["mcp-server-sqlite", "--db", "./data.db"] }
    },
    "startupTimeoutMs": 10000
  }
}
```

A server that fails to start is skipped with a warning, exactly as `discoverProviders`
treats an unreachable model backend. An agent that cannot run because a docs server is down
is worse than one that runs without it.

## 5 — Sequencing

| stage | work | why this order |
|---|---|---|
| 1 | `NodeBrief` schema + gather/apply split behind a config flag | The redesign is the load-bearing change; MCP on the old loop inherits every problem in §2. |
| 2 | Measure both loops on the same goal | Input tokens per node, steps to first write, completion rate. If two-phase is not cheaper, stop. |
| 3 | Delete the guards the split subsumes | Only after the measurement says the split works. |
| 4 | MCP client + config + one server end to end | Smallest real integration; `fetch` proves the path without a database. |
| 5 | Grant MCP tools to gather, per persona | Permissions last, so nothing is reachable before it is reviewed. |

Stage 2 is a gate, not a formality. Every change this session that was not measured against
a real run turned out to be wrong in a way reading the code did not reveal.

## 6 — What this does not fix

- **Model quality.** `qwen3.6:35b` wrote invalid TypeScript on every attempt it made. A
  cleaner loop gets a better-shaped prompt to the same model. Routing (`gemma-4-31b` at
  reliability 1.00) and quantisation are the levers there, not this.
- **Planning.** A plan whose nodes are wrong stays wrong. The persona/write-set validation
  in docs/08 §2.3 is the guard for that.
- **MCP server tool quality.** A third-party tool that returns 40 KB of JSON per call will
  burn a gather budget exactly as `read_artifact` did. The read budget stays for that
  reason.
