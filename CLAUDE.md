# CLAUDE.md

An MCP server that lets an LLM (Claude, or any MCP-capable client) delegate
self-contained, low-skill subtasks to a locally-hosted model instead of
doing the work itself — to save tokens on mechanical, easily-verified work.

## Architecture

Calling model → MCP tool `delegate_to_local_model` → this server
(`index.mjs`, Node/stdio) → `POST /v1/chat/completions {"model": <alias>}`
→ `llama-server` in router mode at `http://localhost:8080`, run and kept
alive by the separate [`local-copilot-stack`](../local-copilot-stack)
project. This repo is **only the delegation client** — it doesn't run or
manage any model itself, and its tool calls fail with a clear error if
`local-copilot-stack` isn't installed and running.

Two router aliases:
- `delegate-fast` (Qwen2.5-Coder-7B) — default, no reasoning phase
- `Qwen3.5-9B-UD-Q4_K_XL.gguf` — same model VS Code Copilot Chat uses, opt-in via `model: "capable"`

## Key files

- `index.mjs` — the entire server: env sanitization, credential scanning, the one tool, the HTTP call

There is no test directory in this repo. Ad-hoc testing during development
has used a throwaway harness script (spawn `index.mjs` as a child process,
drive raw MCP JSON-RPC over its stdin/stdout: `initialize` →
`notifications/initialized` → `tools/call`) kept outside the repo, not
committed here.

## Common commands

```sh
npm install
node --check index.mjs          # syntax check, no server needed
curl http://localhost:8080/health   # confirm local-copilot-stack's llama-server is reachable first
```

No build step. Run directly by an MCP client via:
```json
{"command": "node", "args": ["/absolute/path/to/local-delegate-mcp/index.mjs"]}
```

## Things to know

- **`task` must be fully self-contained.** The local model has no memory of
  the calling conversation and can't ask follow-up questions.
- **Never put real secrets in `task`/`system_prompt`.** Both are scanned for
  credential-shaped content and the call is refused if something matches —
  use placeholders and substitute real values into the result afterward.
- **`model: "capable"` (9B) can silently burn its whole budget on "thinking"**
  with zero actual answer content (`finish_reason: length`, empty `content`)
  if `max_tokens` is too low — budget generously for that tier, or just
  don't reach for it. Default to `"fast"`.
- **Request timeout scales with `max_tokens`**: `30s + max_tokens * 150ms`,
  not fixed — a fixed timeout was cutting off legitimately-still-running
  generations.
- **Delegate serially, not in parallel.** The tool doesn't queue/rate-limit
  concurrent calls, and a 16GB Mac running both model tiers hot at once
  (~10GB combined) is still tight.
- **Env sanitization allowlist**: `PATH`, `HOME`, `LOCAL_LLM_URL`,
  `FAST_MODEL_ALIAS`, `CAPABLE_MODEL_ALIAS`. Everything else in
  `process.env` is deleted at startup, so this server never inherits
  secrets from whatever spawned it.
