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
appropriately.

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
- **Advisory output only**: the local model only ever returns text; this tool
  never executes anything on its behalf. Its output must be reviewed by the
  calling agent before being used — see the tool's own description in
  `index.mjs` for what it's safe to delegate in the first place.

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
