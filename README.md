# local-delegate-mcp

An MCP server that lets an LLM (Claude, or any MCP-capable client) delegate
self-contained, low-skill subtasks to a locally-hosted model instead of doing
the work itself — to save tokens on mechanical, easily-verified work.

## Architecture

```
Claude / any MCP client
  │
  └─ MCP tool "delegate_to_local_model" ──► local-delegate-mcp (Node/stdio)
                                                  │
                                                  └─ POST /v1/chat/completions {"model": <alias>}
                                                         │
                                                         ▼
                                              llama-server, router mode (from local-copilot-stack)
                                                    http://localhost:8080
                                                         │
                                                         ├─ "delegate-fast" (Qwen2.5-Coder-7B — default)
                                                         └─ "Qwen3.5-9B-UD-Q4_K_XL.gguf" (same model VS Code uses)
```

This project is **only the delegation client** — it does not run or manage any
model itself. It expects an OpenAI-compatible chat completions endpoint to
already be reachable (by default `http://localhost:8080`), running in
**router mode** with both aliases above registered — i.e. the `llama-server`
instance already set up and kept running by the separate
[`local-copilot-stack`](../local-copilot-stack) project. If that project
isn't installed and running, this server's tool calls will fail with a clear
"could not reach the local model" error rather than crashing.

## The tool

**`delegate_to_local_model`** — one tool, one job. Takes:

- `task` (required): a **fully self-contained** description of the work,
  including any code/schema/examples/constraints it needs. The local model
  has no memory of the calling conversation and cannot ask follow-up
  questions, so everything relevant has to be in this string. Prefer
  `context_files` (below) over pasting file contents in here — pasting costs
  the calling model output tokens to transcribe them.
- `context_files` (optional): a list of file paths, read on the server side
  and handed to the local model as reference material instead of being
  pasted into `task`. Paths are resolved against — and must stay within —
  this server's working directory (override with `CONTEXT_ROOT`); anything
  that escapes it, looks like a sensitive file (`.env`, `.ssh`, `*.pem`,
  `*.key`, `credentials.json`, etc.), or whose content matches the same
  credential scan applied to `task` is refused. Capped at 8000 bytes/file,
  16000 bytes combined.
- `output_files` (optional): a list of paths the response should be written
  to, server-side. **This is the highest-leverage parameter in the tool** —
  see "Why `output_files` matters" below. For multiple files, instruct the
  model in `task` to precede each with a line reading exactly
  `===FILE: <path>===`; any path it emits that isn't in this list causes all
  writes to be refused. Same containment and sensitive-filename rules as
  `context_files`, plus: existing files are never overwritten unless
  `allow_overwrite` is set, and validation happens for every file before any
  file is written (so a violation partway through can't leave half the batch
  on disk). When set, the tool returns a manifest — paths, byte and line
  counts — instead of the content.
- `allow_overwrite` (optional, default false): permit `output_files` to
  replace files that already exist. Leave unset when generating new files.
- `expected_output_lines` (**required**): honest estimate of the response
  size. Enforced, not advisory — see "The gate" below.
- `context_files_are_preexisting` (**required whenever `context_files` is
  used**): true only if every listed file already existed independently of
  this delegation. False raises the gate's threshold, because authoring a
  context file costs the same as pasting its content.
- `acknowledge_small_task` (optional): a written reason for bypassing the
  gate. A string, not a boolean — the justification has to be articulated,
  and every use is recorded.
- `system_prompt` (optional): role/constraints/output-format guidance.
- `max_tokens` (optional, default 2048).
- `model` (optional, default `"fast"`): `"fast"` routes to the `delegate-fast`
  alias (Qwen2.5-Coder-7B, no reasoning phase — reliably quick for bounded,
  mechanical work); `"capable"` routes to the same 9B model VS Code Copilot
  Chat uses, for the rare delegated task that genuinely needs more depth.
  Default to `"fast"`; only ask for `"capable"` when a task has actually
  failed on `"fast"` for reasons other than a `max_tokens` shortfall.
  Note: the 9B model "thinks" before answering (a separate `reasoning_content`
  field, not returned by this tool) — this can consume most or all of the
  token budget on a `"capable"` call before it reaches the actual answer;
  budget `max_tokens` generously if you use that tier, or a low value can
  produce an empty result with `finish_reason: length`.

The tool's own description (in `index.mjs`) is deliberately opinionated about
*when* to use it — bounded, mechanical, easily-verified work only, not
anything requiring judgment or high-stakes correctness — since that
description is what actually shapes whether a calling model reaches for it
appropriately. It also warns against two failure modes found empirically
(not hypothetically — both were measured on real delegations, see git
history): pasting large context into `task` instead of using
`context_files`, and delegating a single small/isolated artifact where the
spec costs more to write than the artifact itself. It recommends batching
several small related asks into one `task` instead of one call per item —
now backed by the ledger described below, which detects runs of small calls
across separate invocations.

**Ratio warning.** If a response comes back shorter than the `task` +
`system_prompt` that produced it (only checked once the spec is long enough,
300+ chars, for the overhead to actually matter), the tool appends a bracketed
note to its own returned text flagging that this delegation likely wasn't
worth it — real-time, visible feedback rather than something only findable
later in the usage log.

## The gate

`expected_output_lines` is required, and calls below **150 lines** (or **300**
when `context_files` were authored for the call) are refused before the local
model is ever contacted. Both numbers come from the measured record: the one
round that saved tokens produced ~230 lines across four files, and every round
that lost produced well under 150.

This is deliberately enforcement rather than advice, because advice was tried
and observably failed — the `context_files` cost lesson was written into this
repo's docs after one round and then violated in the very next one. A note the
caller can skip isn't a guardrail.

The escape hatch (`acknowledge_small_task`) takes a written reason rather than
a boolean, and is logged. It exists because a hard wall with no exit would
just push a legitimate edge case into not using the tool at all, but it's
designed to cost more than a flag would.

**The gate cannot make the spec cheap.** By the time this tool is invoked, the
caller has already spent the output tokens writing `task` — a refusal doesn't
refund them. The number is meant to be estimated *before* the spec is written;
the refusal is a lesson for the next call, not a save on this one.

## The ledger

Every call — refused or completed — is appended to
`~/Library/Application Support/local-delegate-mcp/ledger.json` (last 200
entries, global rather than per-project, since it tracks the caller's habits
rather than a codebase). Ledger I/O is wrapped so a bookkeeping failure can
never lose a completed delegation.

It exists to surface three things that a single call can't see, and it only
speaks up when one of them fires — silence means nothing is wrong:

- **Estimate calibration.** If a declared size clears the gate but the actual
  output comes in under half of it, that's flagged. This is what stops the
  gate from being trivially bypassed by optimistic numbers.
- **Batching.** Three or more small results inside ten minutes get called out
  as work that should have been one call.
- **Overall trend.** When ≥30% of the last ten delegations produced less
  output than the spec that requested them, it says so plainly.

An earlier version of this README claimed batching *couldn't* be enforced
server-side for lack of cross-call visibility. That was wrong — nothing stops
a stdio server from persisting state, and this is that state.

## Why `output_files` matters

Across six measured delegation rounds during development, only one showed a
real token saving (−65%); the rest ran between +118% and +257% *more*
expensive than the orchestrator just doing the work itself. Reviewing why,
the dominant factor wasn't spec quality or model choice — it was that the
calling model **paid for the artifact twice**: once writing the spec, then
again transcribing the returned text into its own `Write`/`Edit` call. That
second payment is precisely the do-it-yourself baseline, which structurally
caps savings near zero no matter how good the rest of the delegation is.

The one round that won avoided the retype by accident — an external script
split the response into files, so the orchestrator never transcribed the
~8,700 characters it generated. `output_files` makes that the built-in path
instead of a lucky accident: the server writes the files, the caller's cost
drops to spec + review-and-fix only, and the artifact is never paid for
twice.

This does mean the content doesn't pass through the caller's output. **It
still has to be reviewed** — read the files back (cheap, they're input
tokens) before relying on them. "Written to disk" is not "verified correct."

## Security & Guardrails

- **Environment sanitization**: at startup, the server keeps only an explicit
  allowlist of `process.env` variables (`PATH`, `HOME`, `LOCAL_LLM_URL`) and
  deletes everything else, so it never inherits arbitrary secrets from
  whatever process spawned it (an editor, a CLI, a shell).
- **Credential scanning**: `task`, `system_prompt`, and any `context_files`
  content are scanned for anything that looks like a credential (SSH/PGP
  private key headers, AWS access keys, generic `key=value`/JSON
  secret-looking assignments) before anything is forwarded to the local
  model — the call is refused if something matches, rather than silently
  sending it.
- **File-read containment**: `context_files` paths must resolve within this
  server's working directory (`CONTEXT_ROOT`) — no `../` escapes, no
  absolute paths elsewhere on disk. Filenames matching a sensitive-file
  denylist (`.env`, `.ssh`, `*.pem`, `*.key`, `credentials.json`, etc.) are
  refused before the file is even opened, as a backstop for cases the
  content scan might miss.
- **File-write containment** (`output_files`): identical boundary to reads —
  paths must resolve within `CONTEXT_ROOT`, and the sensitive-filename
  denylist applies to writes too. Three further constraints, because writing
  is the destructive direction: the caller declares the allowed paths up
  front and **the local model's own emitted paths are checked against that
  allowlist** (the model never chooses where bytes land); existing files are
  refused unless `allow_overwrite` is explicitly set; and all paths are
  validated before any file is written, so a violation in the middle of a
  batch can't leave a partial write behind.
- **Advisory output only**: the local model only ever returns text; this tool
  never executes anything on its behalf. `output_files` writes that text to
  disk, which is not the same as running it — but it does mean unreviewed
  model output can land in your working tree, so read the files back before
  relying on them. See the tool's own description in `index.mjs` for what
  it's safe to delegate in the first place.

## Known operational notes

**Memory pressure — much better since `local-copilot-stack` moved to router
mode, but not eliminated.** `llama-server` now loads each model tier on
demand and sleeps it after a period of inactivity (releasing ~98% of its
RSS), rather than keeping both permanently resident. On a 16GB Mac also
running Docker (SearXNG) + VS Code + other apps, a brief window where both
tiers are hot at once (~10GB combined) is still tight. The tool doesn't queue
or rate-limit concurrent calls; delegating serially rather than firing
several requests in parallel remains the safer default, especially if VS
Code's interactive chat (the 9B tier) is also active at the same time.

**Timeout scales with `max_tokens`.** The request timeout is
`30s + max_tokens * 150ms`, not a fixed value — a fixed timeout was cutting
off legitimately-still-running generations on larger requests. This also
covers the ~1s a sleeping model needs to wake up before it starts generating.

**Why `"fast"` is the default.** Qwen3.5-9B's "thinking" phase can consume an
entire token budget on simple, well-specified coding tasks with zero tokens
left for the actual answer (`finish_reason: length`, empty content) —
observed repeatedly even at `max_tokens` up to 6000 for one task. The
non-reasoning `"fast"` tier (Qwen2.5-Coder-7B) skipped straight to the answer
on the identical task in under 100 completion tokens. Use `model: "capable"`
deliberately, not as a first troubleshooting step.

## Setup

```bash
cd local-delegate-mcp
npm install
```

No build step — `index.mjs` is run directly by an MCP client via:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/local-delegate-mcp/index.mjs"]
}
```

Optional environment variables:

- `LOCAL_LLM_URL` — base URL of the OpenAI-compatible endpoint (default `http://localhost:8080`)
- `FAST_MODEL_ALIAS` — router-mode alias for the `"fast"` tier (default `delegate-fast`)
- `CAPABLE_MODEL_ALIAS` — router-mode alias for the `"capable"` tier (default `Qwen3.5-9B-UD-Q4_K_XL.gguf`, matching `local-copilot-stack`'s interactive-chat alias)
- `CONTEXT_ROOT` — directory `context_files` paths are resolved against and confined to (default: this process's working directory at startup)

## Status

Built and verified standalone (`tools/list` and `tools/call` round-trips
tested directly against the running `llama-server`, including the
unreachable-endpoint error path, `context_files` reads, and its
path-traversal / sensitive-filename refusals). Registered as a
project-scoped Claude Code MCP server via `/Users/tomwitkowski/LLM/.mcp.json`
— not yet exercised through a live Claude Code chat turn, only through a
direct JSON-RPC test harness.
