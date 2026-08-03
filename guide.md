# User Guide

How to actually use this. Task-oriented — for _how it works inside_, see
[Project_context.md](Project_context.md).

---

## Before you start

You need at least one model server running. The agent discovers them automatically on the usual
ports:

| Server        | Default  | Get models                           |
| ------------- | -------- | ------------------------------------ |
| **Ollama**    | `:11434` | `ollama pull qwen3.6:35b`            |
| **LM Studio** | `:1234`  | Load a model, start the local server |
| **llama.cpp** | `:8080`  | `llama-server -m model.gguf`         |

Cloud is optional. If you set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in your environment (or in
`~/.aca/secrets.json`), those providers join the pool — unless you run `--local-only`.

An **embedding model** is worth having for code search. `nomic-embed-text-v1.5` in LM Studio works
well. Without one, search still works via BM25 — it just loses semantic matching.

```bash
pnpm install
pnpm test        # 244 tests, no network needed
```

---

## First five minutes

```bash
# 1. Is anything reachable?
pnpm aca doctor

# 2. Measure what your models can actually do (a few minutes, once)
pnpm aca models probe

# 3. Index a repo so the agent can find things in it
pnpm aca memory index --cwd /path/to/your/repo

# 4. Ask it something
pnpm aca chat "how does authentication work here?" --cwd /path/to/your/repo
```

Every command takes `--cwd`. Run them from this project directory and point at whatever repo you
are working on; omit it to use the current directory.

Step 2 matters more than it looks. Until you probe, routing filters on capabilities the _provider
claimed_. On this machine `granite4` advertises 128k context and actually manages 32k — probing is
what stops the router handing it a job it cannot do.

---

## Three ways to use it

### One-shot CLI — best for scripting and quick questions

```bash
aca chat "what does the rate limiter do?"
aca plan "add retry logic to the upload endpoint"    # plans, never executes
aca run "add retry logic to the upload endpoint"     # plans, asks, executes
```

### Interactive TUI — `aca` with no arguments

Opens a full-screen session in your terminal.

| Key                | Does                                                       |
| ------------------ | ---------------------------------------------------------- |
| `Enter`            | Send                                                       |
| `Tab`              | Cycle focus: input → graph → node                          |
| `g` / `t`          | Graph view / thread view _(when focus has left the input)_ |
| `T`                | Toggle thinking tokens                                     |
| `↑` `↓` or `j` `k` | Move between nodes                                         |
| `a` / `A` / `r`    | Approve once / approve for run / reject                    |
| `Esc`              | Cancel a running task, or quit                             |

Slash commands: `/model <name>` · `/index` · `/lessons` · `/help`

Use `--plain` if your terminal cannot handle full-screen rendering.

### Desktop app — the most complete surface

```bash
pnpm daemon                                    # terminal 1: the engine
cd packages/desktop && pnpm build && pnpm dev  # terminal 2: the app
```

The daemon must be running first. The app adopts it if it is already up, and outlives the window —
closing the app does not kill a run.

---

## Chat reads, runs write

Chat can only read. It gets four tools — `read_file`, `list_dir`, `glob`, `grep` — which is why the
desktop app shows **`tools read-only`** next to the model picker. That is the design, not a
misconfiguration or a setting to flip.

Writing goes through a run, because a run is what carries the machinery that makes writing safe: a
declared write set, an approval gate, checkpoints, rollback, gates and review. Chat has none of that,
so giving it `write_file` would mean edits with no record and no way back.

Escalating is just a matter of asking for the change rather than asking about the code:

| You type | What happens |
| --------- | ------------- |
| "how does the router pick a model?" | Chat answers, read-only |
| "add a retry to the upload endpoint" | A plan appears; approve it and it becomes a run |

The desktop app routes on the wording of your message, so a verb like _add_, _fix_, _rename_ or
_refactor_ is what triggers a plan. From the CLI it is explicit: `aca chat` never writes,
`aca run` does.

---

## Command reference

### Asking and doing

```bash
aca chat "<question>"              one-shot, then exit
aca plan "<goal>"                  show a plan, never execute
aca run "<goal>"                   plan → approve → execute
aca run "<goal>" --yes             skip the approval gate (CI)
aca run "<goal>" --json            NDJSON events on stdout
```

### Models

```bash
aca models                         catalogue with capabilities
aca models probe                   measure every model
aca models probe qwen3.6           measure one
aca doctor                         provider health, residency, slots
```

### Memory

```bash
aca memory index                   build the code index
aca memory query "<text>"          search it
aca memory lessons                 what the agent has learned from failures
aca memory                         index stats
```

### History and workspaces

```bash
aca runs                           past runs
aca runs show <run-id>             every event from that run
aca ws list                        registered workspaces
aca ws add <path>                  register one
aca daemon status                  is the engine up
```

### Flags worth knowing

| Flag               | Why                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------- |
| `--local-only`     | Nothing leaves the machine. Cloud providers are disabled entirely.                  |
| `--model <name>`   | Pin a model. Usually you want this to avoid a 20 GB cold load.                      |
| `--cwd <path>`     | Work on a different repo than the current directory.                                |
| `--max-tokens <n>` | Run budget. Default 400,000.                                                        |
| `--yes`            | No approval prompts. **Irreversible actions are auto-rejected**, not auto-approved. |

---

## Workflows

### Understand unfamiliar code

```bash
aca memory index                       # once per repo, then incrementally
aca chat "where is rate limiting handled?"
aca memory query "getUserById"         # direct search, no model call
```

Identifier searches are excellent. Conceptual questions ("how does X work") land in the right area
but with noisier ordering — that is a limitation of the general-purpose embedding model, not a bug.

### Make a change

```bash
aca run "make divide throw a clear error when b is zero" --local-only --model qwen3.6:35b
```

What happens:

1. **Input guard** — blocks secrets, redacts PII, warns on injection-shaped text
2. **Spec** — your sentence becomes intent, scope, non-goals and acceptance criteria
3. **Plan** — a DAG of nodes, each declaring what it reads and writes
4. **You approve** — this is the real gate. The write-set column bounds everything the run can touch
5. **Execute** — nodes run under checkpoint, in dependency order, conflicts serialised
6. **Gates** — build, typecheck, lint, tests, secret scan
7. **Review** — a different model checks the work against the contract
8. **Write back** — what it learned goes into memory

### Review what it did

In the desktop app, the **Diff review** tab gives side-by-side per file. Rejecting a hunk asks why,
and that note becomes a hard constraint on a re-run — it is not a comment, it changes behaviour.

From the CLI:

```bash
git diff                       # the change itself
aca runs show <run-id>         # every decision, in order
```

### When something goes wrong

The event log is the answer to almost every "why did it do that":

```bash
aca runs                       # find the run
aca runs show run-abc123       # read it
```

Each line is a decision: which model was routed, which tools were called, which gate failed, what
the classifier decided, whether anything rolled back.

---

## The desktop app

Eight views. The rail on the left switches between them.

| View            | Use it when                                                                             |
| --------------- | --------------------------------------------------------------------------------------- |
| **Launcher**    | Picking a repo. Shows index freshness — a stale index is the usual cause of bad answers |
| **Chat**        | Asking and describing work. Plans appear inline; approve or reject with a reason        |
| **Run graph**   | Watching a run. Click a node for its context, model, tools, gates and diff              |
| **Files**       | Seeing agent state — what is locked, what is in a write set, what is indexed            |
| **Diff review** | Reviewing changes per hunk, feeding rejections back into the loop                       |
| **Timeline**    | Debugging. Drag the playhead and read state at any moment                               |
| **Models**      | Checking what is loaded, probing, and asking "why would this route here"                |
| **Settings**    | Permission matrix, privacy mode, sandbox tiers, budgets                                 |

**The Context tab** (in the run graph node drawer) is the one to reach for when the agent does
something baffling — it shows exactly what was in the model's window, with untrusted tool output
marked in red.

**The routing simulator** (Models view) answers "why did it pick that model". The _excluded_ list
with reasons is usually the more useful half.

---

## Configuration

Layered, later wins: **defaults → `~/.aca/config.json` → `<repo>/.aca/config.json` → env → flags**.

Workspace sits above user on purpose: a repo can pin `local-only` and it holds for everyone who
opens it.

```json
{
  "router": { "privacy": "local-only", "pinnedModel": "qwen3.6:35b" },
  "budget": { "maxTokens": 200000, "maxWallMs": 1800000 },
  "run": { "maxAttempts": 2, "maxReviewRounds": 3 }
}
```

Environment: `ACA_PRIVACY` · `ACA_MODEL` · `ACA_MAX_TOKENS` · `ACA_OLLAMA_HOST` · `ACA_LOG=debug`

**Secrets never go in config.** Put API keys in your environment or `~/.aca/secrets.json` (mode
0600). They are never merged into config and are redacted from every log line.

Per-repo state lives in `<repo>/.aca/` — the database, artifacts and checkpoints. Add it to
`.gitignore`.

---

## Troubleshooting

**"planning…" sits there for a minute.** A cold model is loading — 17 GB takes a while. The status
line tells you which model and whether it is cold. Pin a resident one with `--model` to avoid it.

**`no model provider reachable`.** Run `aca doctor`. Usually the model server is not running, or is
on a non-default port — set `ACA_OLLAMA_HOST` or the equivalent.

**A gate fails with `spawn ... ENOENT` or `EINVAL`.** Should be fixed — `npm` and friends are `.cmd`
shims on Windows and need special handling. If you see it with another tool, that tool is not on
PATH from the sandbox's scrubbed environment.

**`planner could not produce an executable DAG`.** The model kept emitting an invalid plan. Try a
larger model with `--model`, or rephrase more concretely. Small models struggle with the
dependency graph.

**The agent invents file paths that do not exist.** The index is stale or missing. Run
`aca memory index`.

**It calls the same tool over and over instead of answering.** Fixed — the assistant turn now carries
its own tool calls, so the model can see the results it already has. If you still see it on some
model, that model is ignoring the binding; the loop now stops after six rounds and forces an answer
rather than hanging.

**Where did the tool calls go?** They are folded into one row per turn — `9 actions · read_file ×5 ·
glob ×2` — because a dozen chips per answer buries the answer. Click the row to expand it. A turn
that hit the fence guard expands on its own.

**A tool result is marked `fenced`.** Not a problem. Every tool result is wrapped in an
untrusted-data envelope before the model sees it, and the model is told to treat the contents as
data rather than instructions. It is on all of them.

**A tool result shows a red "tried to break out of its fence" warning.** This one is worth reading.
The content contained our envelope's own end marker, which only happens deliberately — something in
that file or command output was trying to end the quoting early so the text after it would be read
as trusted instructions. It was neutralised, and the model saw the escaped form. Look at what the
tool actually read.

**Retrieval returns irrelevant chunks.** Expected for conceptual queries with a general-purpose
embedding model. Identifier searches are much sharper — search for the symbol, not the concept.

**A node fails with `write outside declared set`.** Working as designed: the planner under-declared
what the node needed. The run rolls back. Rephrase the goal to make the scope explicit.

**`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` on exit.** Cosmetic — a known interaction
between the `tsx` loader and process exit. The command has already completed and its output is
valid.

**Everything is slow.** Check `aca doctor` for what is resident. Running two large models
concurrently on one GPU thrashes; the residency manager serialises loads but cannot create VRAM.

---

## Things to know before you rely on it

Stated plainly rather than buried:

**`aca run` bypasses the daemon.** It executes in-process, so a CLI-started run is not visible live
in a running desktop app — you would have to reload history. Daemon-started runs (from the desktop)
work as intended.

**Windows sandboxing is detection, not prevention.** Tools run at tier 1: a subprocess with a
scrubbed environment and a path jail enforced by our tool layer, not the OS. A checkpoint re-hashes
the tree afterwards to _detect_ out-of-set writes. If you point this at code you do not trust, that
is not a sufficient boundary — and the Docker tier that would be sufficient has never been
exercised.

**The reviewer needs a second model.** It deliberately refuses to review with the same model that
wrote the code. If only one model qualifies for a node, review is skipped and the node passes on
gates alone. Have two models available if you want review to actually happen.

**The TUI plans but does not execute.** Ask it for work and it will produce a plan, then hand you
off to `aca run`. Use the desktop app or the CLI for the complete path.

**Lessons need two occurrences.** The agent records a lesson the first time something fails but only
_uses_ it after the same failure happens again. Early on, `aca memory lessons` will show entries
marked unconfirmed — that is the design, not a bug.

---

## Quick reference

```bash
pnpm aca doctor                              # is anything reachable
pnpm aca models probe                        # measure capabilities (do this once)
pnpm aca memory index                        # index a repo (do this per repo)
pnpm aca                                     # interactive session
pnpm aca chat "question"                     # one-shot
pnpm aca run "goal" --local-only             # make a change
pnpm aca runs show <id>                      # why did it do that
pnpm daemon                                  # engine, for the desktop app
```
