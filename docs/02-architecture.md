# Architecture

## Shape

One engine, two front-ends. The engine runs as a **headless daemon** that owns all run state; the CLI and the desktop app are both thin JSON-RPC clients. This is the decision everything else hangs off, and the reason is concrete: you can start a run in the desktop app, close it, and attach from the terminal — or vice versa. Approvals raised by a run reach whichever client is attached. Neither front-end can hold state the other can't see.

```
┌─────────────┐   ┌──────────────────┐
│  CLI (Ink)  │   │ Desktop(Electron)│      front-ends: render + input only
└──────┬──────┘   └────────┬─────────┘
       │  JSON-RPC 2.0 over WS (127.0.0.1, token-auth)
       └────────┬──────────┘
         ┌──────▼───────┐
         │  @aca/daemon │              run lifecycle, subscriptions, approvals
         └──────┬───────┘
         ┌──────▼───────┐
         │  @aca/core   │              guard→plan→schedule→execute→gate→writeback
         └──┬────────┬──┘
   ┌────────▼──┐  ┌──▼──────────┐
   │@aca/tools │  │@aca/providers│     sandbox + registry  |  models + router
   └───────────┘  └──────────────┘
         ┌──────────────┐
         │ SQLite (WAL) │              events, runs, nodes, memory, vectors
         └──────────────┘
```

## Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript, Node 24 (already installed) | One language across engine, CLI, and desktop renderer. Node 24 has stable `node:sqlite`, native fetch, `AbortSignal` everywhere. |
| Monorepo | pnpm workspaces (9.15 installed) | Strict node_modules; catches accidental cross-package imports. |
| Validation | Zod | Schemas are shared between the protocol, tool arg validation, and structured-output enforcement — one definition, three uses. |
| Storage | better-sqlite3 + `sqlite-vec` + FTS5 | Synchronous API suits the event-fold pattern; vectors and full-text in the same file as the run state, so a run is one portable `.db`. |
| CLI | Ink (React for terminal) | Shares component logic and mental model with the desktop renderer. |
| Desktop | **Electron + React + Vite** | See decision below. |
| Test | Vitest + a record/replay cassette provider | Deterministic agent tests without a live model. |

### Desktop shell: Electron over Tauri

Tauri wins on bundle size (~10 MB vs ~150 MB) and memory. It loses here for three reasons specific to this project:

1. **No Rust toolchain on this machine.** Tauri needs Rust + MSVC build tools before line one.
2. **The engine is Node.** In Tauri it must ship as a sidecar binary and be process-managed by Rust — you get the Electron process count anyway, plus a language boundary.
3. **The engine needs native Node modules** — `better-sqlite3`, `node-pty` for interactive tool sessions, `keytar` for the OS keychain. All are first-class in Electron.

Electron is the pragmatic pick. The cost of being wrong is bounded: only `packages/desktop` is shell-specific, roughly 15% of the codebase, and the JSON-RPC boundary means a Tauri renderer would talk to the same daemon unchanged.

## Packages

```
auto-code-agent/
├─ packages/
│  ├─ protocol/    @aca/protocol   Zod schemas + RPC types. Zero runtime deps.
│  ├─ core/        @aca/core       The flow diagram, implemented.
│  ├─ providers/   @aca/providers  Ollama/LM Studio/llama.cpp/cloud + router.
│  ├─ tools/       @aca/tools      Tool registry, sandbox tiers, epoch cache.
│  ├─ daemon/      @aca/daemon     WS server, run supervisor, approval broker.
│  ├─ cli/         @aca/cli        Ink TUI + scriptable non-interactive mode.
│  └─ desktop/     @aca/desktop    Electron main + React renderer.
└─ docs/
```

`core` depends on `protocol`, `providers`, `tools`. Nothing depends on `daemon`. `cli` and `desktop` depend only on `protocol` — enforced by an ESLint boundary rule, because the moment a front-end imports `core` directly, the two-client guarantee is dead.

## Core module map

Each module traces to a box in the flow diagram.

```
core/src/
├─ run/           Run supervisor, cancellation tokens, resume        (F14)
├─ events/        Append-only log; state = fold(events)              (F18)
├─ guard/
│  ├─ input-guard.ts      PII redaction, injection heuristics, scope
│  └─ output-guard.ts     Nonce-fenced data envelope, artifact spill (F11)
├─ prompt/        Intent + scope + acceptance-criteria compiler
├─ preflight/     Tool registry resolve, permission matrix, health
├─ context/
│  ├─ assembler.ts        Priority ladder, per-branch budgets        (F8)
│  ├─ budget.ts           Per-call precondition vs selected model
│  └─ compactor.ts        Summarize done nodes, evict raw turns
├─ plan/
│  ├─ planner.ts          DAG w/ deps, contracts, read+write sets
│  ├─ replan.ts           Rejection reason as hard constraint        (F16)
│  └─ validate.ts         Acyclicity, write-set sanity, coverage
├─ scheduler/
│  ├─ ready-queue.ts      Topological ready set
│  ├─ locks.ts            Canonical-order acquisition, no deadlock   (F3)
│  ├─ conflict.ts         Path-prefix + glob write-set intersection
│  ├─ barrier.ts          Join barrier for parallel siblings
│  ├─ park.ts             Escalation parking, locks retained         (F5)
│  └─ rollback.ts         Checkpoint restore + cascade invalidate    (F6)
├─ persona/       Lazy registry; personas declare capability needs   (F17)
├─ agent/         Sub-agent loop in an isolated window
├─ gates/         Gate vector: build/types/lint/unit/contract/secrets(F12)
├─ review/        LLM critic, bounded rounds, critique dedup         (F2)
├─ recovery/      Error taxonomy; attempts-first classification      (F1)
├─ approval/      HITL broker; irreversible-action class             (F13)
├─ budget/        Token/USD/latency meters, stop-or-ask              (F15)
└─ memory/        T1–T4 tiers + hybrid retrieval + write-back
```

## Data model

SQLite, WAL mode, one database per workspace at `.aca/state.db`.

```sql
-- Provenance. Everything else is derivable from this.           (F18)
CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL,
  node_id    TEXT,
  ts         INTEGER NOT NULL,
  type       TEXT NOT NULL,   -- run.started, node.routed, tool.called,
                              -- gate.failed, approval.granted, node.rolled_back…
  payload    TEXT NOT NULL    -- JSON, zod-validated on write
);
CREATE INDEX idx_events_run ON events(run_id, seq);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, workspace TEXT, status TEXT,
  spec TEXT, budget TEXT, created_at INTEGER, updated_at INTEGER
);

CREATE TABLE nodes (
  id TEXT, run_id TEXT, persona TEXT, status TEXT,
  deps TEXT, read_set TEXT, write_set TEXT, contract TEXT,
  attempts INTEGER DEFAULT 0,          -- F1: counter lives here
  review_rounds INTEGER DEFAULT 0,     -- F2
  route TEXT,                          -- F9: chosen provider/model
  checkpoint_id TEXT,
  PRIMARY KEY (run_id, id)
);

-- F3: lock table; acquisition ordered by canonical resource id
CREATE TABLE locks (
  resource TEXT PRIMARY KEY, run_id TEXT, node_id TEXT,
  mode TEXT,                            -- 'read' | 'write'
  acquired_at INTEGER, parked INTEGER DEFAULT 0
);

-- F7: monotonic epoch per resource; part of every cache key
CREATE TABLE resource_epochs (resource TEXT PRIMARY KEY, epoch INTEGER NOT NULL);

CREATE TABLE tool_cache (
  key TEXT PRIMARY KEY,                 -- hash(tool, args, epochs[])
  result_ref TEXT, created_at INTEGER, expires_at INTEGER
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, run_id TEXT, node_id TEXT,
  path TEXT, bytes INTEGER, sha256 TEXT,
  pinned INTEGER, summary TEXT, trust TEXT   -- 'untrusted' for tool output
);

-- Memory tiers
CREATE TABLE mem_task    (id TEXT PRIMARY KEY, run_id TEXT, kind TEXT,
                          content TEXT, node_id TEXT, ts INTEGER);        -- T2
CREATE TABLE mem_lessons (id TEXT PRIMARY KEY, scope TEXT, trigger TEXT,
                          lesson TEXT, evidence TEXT, confidence REAL,
                          uses INTEGER, wins INTEGER);                    -- T4
CREATE TABLE mem_chunks  (id TEXT PRIMARY KEY, source TEXT, content TEXT,
                          sha256 TEXT, relevance REAL DEFAULT 0);         -- T3
CREATE VIRTUAL TABLE mem_fts USING fts5(content, content=mem_chunks);
CREATE VIRTUAL TABLE mem_vec USING vec0(id TEXT PRIMARY KEY, embedding float[768]);

CREATE TABLE model_scorecards (                  -- see 03-model-layer.md
  provider TEXT, model TEXT, probed_at INTEGER,
  tools TEXT, structured TEXT, real_ctx INTEGER,
  tok_per_sec REAL, ttft_ms REAL, reliability REAL,
  PRIMARY KEY (provider, model)
);
```

**Why event-sourced.** Run state is a fold over `events`. That single decision buys resume after crash (F14), the desktop timeline view, deterministic replay for tests, and a real audit trail — instead of three separate mechanisms.

## Memory tiers

The diagram's `Write back (T1/T2 delta, T4 lesson, T3 relevance)` maps cleanly:

| Tier | Name | Lifetime | Store | Written when |
|---|---|---|---|---|
| **T1** | Working | One node | In-window only | Continuously; discarded on node completion |
| **T2** | Task / episodic | One run | `mem_task` | Node completion — decisions, outputs, contracts met |
| **T3** | Semantic / retrieval | Workspace | `mem_chunks` + `mem_vec` + `mem_fts` | Indexed on file change; **relevance score updated** when a chunk contributed to a passing node |
| **T4** | Procedural / lessons | Cross-workspace | `mem_lessons` | On gate failure, reviewer rejection, or rollback |

**T4 promotion is gated**, or it becomes a garbage accumulator. A lesson is only injected into future context after it has been confirmed on a second independent occurrence, and it carries `uses`/`wins` counters — a lesson whose win rate drops below 0.5 over ≥5 uses is retired automatically.

**Retrieval is hybrid**: FTS5 BM25 + vector cosine, fused with reciprocal-rank fusion. Pure vector search is bad at identifiers (`getUserById`); pure BM25 is bad at intent. Embeddings come from `text-embedding-nomic-embed-text-v1.5`, already loaded in your LM Studio (768-dim, hence `float[768]`).

## Context assembly — the priority ladder

Assembly fills a budget derived from the **selected model's real context window** (F8/F9), reserving 25% headroom for output. Ladder, highest first:

1. System + persona contract *(never evicted)*
2. Node contract, acceptance criteria, declared write set *(never evicted)*
3. Active critique constraints from the review loop *(capped slice — F2)*
4. Confirmed T4 lessons matching this node's trigger
5. T2 deltas from direct dependency nodes
6. T3 retrieved chunks, RRF-ranked
7. Tool result summaries *(untrusted envelope)*
8. Raw recent turns *(first to be evicted — this is what `Compact` drops)*

Per-branch budgets: each DAG branch gets a share proportional to its subtree weight, so one exploratory branch can't starve its siblings.

## Sandbox tiers (F10)

| Tier | Isolation | Used for | Limits |
|---|---|---|---|
| **T0** | In-process | Pure functions — parse, diff, hash | 5s, no I/O |
| **T1** | Subprocess, cwd jail, scrubbed env, FS overlay, network denied | Default for build/test/lint/git | 120s, 2 GB, 10 MB output |
| **T2** | Docker container, no volume mounts beyond the overlay | Untrusted code, anything needing network | 600s, configurable |

**Windows caveat, stated plainly.** There is no `seccomp`/`bubblewrap` equivalent. At T1, path jailing is enforced by our tool layer (path normalization + allow-list check before every FS call) and process control by **Job Objects** (memory cap, CPU cap, kill-on-close). This is defence against *mistakes*, not against a determined sandbox escape. Anything genuinely untrusted must go to T2 — Docker 29.5 is installed and is the real boundary.

**Write-set enforcement (F4)** lives in the overlay: a copy-on-write layer that materializes only declared-writable paths. Writes outside the declared set fail at the syscall wrapper and raise `WriteSetViolation` — a hard node failure. Checkpoint = snapshot of the overlay's base state; rollback = discard the overlay.

## Daemon protocol

JSON-RPC 2.0 over WebSocket on `127.0.0.1:<ephemeral>`. The port and a 32-byte token are written to `%LOCALAPPDATA%\aca\daemon.json` with restrictive ACLs; clients read it to connect. No network listener beyond loopback, ever.

**Client → daemon**
```ts
// workspaces — everything else is scoped to one
workspace.list() / workspace.open(path) / workspace.clone(url, path)
workspace.close(id) / workspace.forget(id)
workspace.index(id, { full? })       // → progress events
workspace.status(id)                 // index freshness, locks held, branch
files.tree(wsId, { path, depth })    // + git status, lock, write-set, index flags
files.read(wsId, path) / files.state(wsId, path)

// chat — a conversation, not a run
chat.create(wsId): { threadId }
chat.send(threadId, { text, model?, tools?, attachments? })
chat.subscribe(threadId): stream of ChatChunk
chat.escalate(threadId): { planId }   // conversation → proposed plan
chat.setModel(threadId, modelRef)

// runs — spawned from an approved plan
run.createFromPlan(planId) / run.create(spec: TaskSpec): { runId }
run.start(runId) / run.cancel(runId) / run.resume(runId)
run.subscribe(runId): stream of Event
plan.approve(planId, { approved, reason? })       // F16 carries reason
approval.respond(approvalId, { granted, scope })  // F13
node.retry(runId, nodeId) / node.skip(runId, nodeId)

models.list() / models.probe(id) / models.load(id) / models.unload(id)
memory.query(q) / memory.forget(id)
config.get() / config.set()
```

**Daemon → client** (notifications)
```ts
event(runId, Event)               // every append to the event log
approval.requested(Approval)      // blocks the node until answered
stream.token(runId, nodeId, tok)  // live model output
budget.warning(runId, meter)      // F15 stop-or-ask
chat.chunk(threadId, ChatChunk)   // chat streaming, incl. thinking
plan.proposed(threadId, Plan)     // renders as a card in the thread
index.progress(wsId, { done, total })
files.changed(wsId, paths)        // tree refresh, lock/write-set overlays
```

The approval broker fans a request to every attached client and accepts the first response — so an approval raised by a desktop-started run can be answered from the CLI.

## Security posture

- **Trust boundary.** Everything from a tool, a file, or the network is `untrusted` and is wrapped in a nonce-fenced envelope before entering any context. Nonces are per-run random, so injected text cannot forge a fence close.
- **Secrets** live in the Windows Credential Manager via `keytar`, never in config files. The env scrubber strips anything matching secret-like patterns before a subprocess starts, and the output guard redacts on the way back.
- **Permission matrix** is `(persona × tool × resource-scope) → allow | ask | deny`, resolved at pre-flight so a node cannot discover new permissions mid-run.
- **Injection corpus** ships as a test suite — poisoned README, malicious test fixture, hostile dependency changelog, a tool result claiming to be a system message. CI fails if the guard regresses.
