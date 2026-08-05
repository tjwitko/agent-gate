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
                                                  └─ POST /v1/chat/completions
                                                         │
                                                         ▼
                                              llama-server (from local-copilot-stack)
                                                    http://localhost:8080
```

This project is **only the delegation client** — it does not run or manage a
model itself. It expects an OpenAI-compatible chat completions endpoint to
already be reachable (by default `http://localhost:8080`, i.e. the
`llama-server` instance already set up and kept running by the separate
[`local-copilot-stack`](../local-copilot-stack) project). If that project
isn't installed and running, this server's tool calls will fail with a clear
"could not reach the local model" error rather than crashing.

## The tool

**`delegate_to_local_model`** — one tool, one job. Takes:

- `task` (required): a **fully self-contained** description of the work,
  including any code/schema/examples/constraints it needs. The local model
  has no memory of the calling conversation and cannot ask follow-up
  questions, so everything relevant has to be in this string.
- `system_prompt` (optional): role/constraints/output-format guidance.
- `max_tokens` (optional, default 2048): the local Qwen3.5 model "thinks"
  before answering (a separate `reasoning_content` field, not returned by
  this tool), which consumes part of the token budget before it reaches the
  actual answer — keep this generous enough to cover reasoning + output, or
  a low value can produce an empty result with `finish_reason: length`.

The tool's own description (in `index.mjs`) is deliberately opinionated about
*when* to use it — bounded, mechanical, easily-verified work only, not
anything requiring judgment or high-stakes correctness — since that
description is what actually shapes whether a calling model reaches for it
appropriately.

## Known operational caveat: memory pressure

On a 16GB Mac running `llama-server` + Docker (SearXNG) + VS Code + other
apps concurrently, this machine runs close to its memory ceiling already.
During testing, firing overlapping/concurrent delegation calls (e.g. killing
one test before its connection closed and immediately starting another)
caused severe thrashing — generation speed dropped from ~17.5 tok/s to
~0.13 tok/s (visible in `llama-server`'s own timing logs) until the backlog
cleared. The tool itself doesn't queue or rate-limit concurrent calls today.
If you're delegating multiple subtasks, do it serially rather than firing
several in parallel, especially on memory-constrained hardware.

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

Optional environment variable:

- `LOCAL_LLM_URL` — base URL of the OpenAI-compatible endpoint (default `http://localhost:8080`)

## Status

Built and verified standalone (`tools/list` and `tools/call` round-trip
tested directly against the running `llama-server`, plus the unreachable-
endpoint error path). **Not yet wired into any MCP client** — that'll happen
when the test project this is meant for gets set up.
