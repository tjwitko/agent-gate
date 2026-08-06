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
- `bench/` — reusable benchmark for deciding whether a candidate local model is worth adopting
  into `local-copilot-stack`'s `presets.ini`. `bench/run-benchmark.mjs --model <alias>` runs a
  standardized codegen task through the real delegation tool, escalating `max_tokens`
  automatically on truncation, then reports attempts/tokens/wall-clock/test-pass. See
  `bench/README.md`. `bench/runs/` is gitignored scratch output.

There is no other test directory in this repo. Ad-hoc testing during
development has used a throwaway harness script (spawn `index.mjs` as a
child process, drive raw MCP JSON-RPC over its stdin/stdout: `initialize` →
`notifications/initialized` → `tools/call`) — the same logic is now built
into `bench/run-benchmark.mjs` rather than living only in a scratchpad.

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
- **Use `context_files` instead of pasting file contents into `task`.**
  Pasting costs the *calling* model output tokens to transcribe; empirically
  this made one real delegation (CLAUDE.md drafting) cost ~160% more Claude
  output tokens than just doing it directly, because the task string had to
  re-transcribe most of a README. `context_files` reads paths server-side
  instead — confined to `CONTEXT_ROOT` (default: cwd), refused if a path
  escapes it, matches a sensitive-filename denylist, or its content trips
  the same credential scan as `task`/`system_prompt`.
- **Never put real secrets in `task`/`system_prompt`/`context_files`.** All
  three are scanned for credential-shaped content and the call is refused if
  something matches — use placeholders and substitute real values into the
  result afterward.
- **Don't delegate a single small/isolated artifact (roughly under 20 lines).**
  Empirically, writing a precise-enough spec for something that small costs
  more Claude output tokens than just writing it directly — measured at
  ~257% overhead for two ~8-line utility functions delegated separately.
  **Batch several small related asks into one `task` instead of one call per
  item** — this is stated in the tool's own description, but the server
  can't enforce it (no visibility across separate calls), so it's on
  whichever model is calling this tool to actually do it.
- **The tool self-reports when a delegation likely wasn't worth it.** If the
  response comes back shorter than the `task`/`system_prompt` that produced
  it (checked only once the spec is 300+ chars, so trivial cases don't
  trigger noise), a bracketed warning is appended to the returned text —
  read it, it's real-time signal, not just something in the usage log.
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
- **Bigger/newer isn't better for this tool's workload; reasoning is what
  matters.** Qwen3.5-9B and Gemma 4 12B both lost to the 7B — a reasoning
  phase burning the token budget before producing real output, not size,
  decided both. Qwen3-8B run with its `/no_think` flag (see
  `bench/task-no-think.json`) tied the 7B almost exactly (3,707 vs 3,618
  tokens, 110s vs 118s, 1 attempt each) — the first candidate beyond the
  original 7B that didn't lose, and it won by having reasoning off, not by
  being small. Benchmark any new candidate (`bench/run-benchmark.mjs`)
  rather than assuming size predicts the outcome either way; see
  `local-copilot-stack`'s README for the full checklist.
- **Expect the same validation-gate bug regardless of which model you use.**
  Five independent generations across four different models (7B twice,
  Qwen3.5-9B, Gemma, Qwen3-8B) all made the identical mistake: an optional
  field's validation copied the required-field gate (`!partial || field !==
  undefined`) instead of `field !== undefined`, incorrectly rejecting a
  create request that omits the field. This isn't a model-quality signal —
  it's a standing review checkpoint for this specific task pattern. Check
  optional-field validation first when a generated resource's create
  endpoint fails unexpectedly.
- **A model backend can crash into a persistent "Compute error" state under
  llama-server, and it isn't specific to any one model.** First observed
  with Gemma 4 12B after a near-max-context generation; later, in the same
  session, an entirely different model (Qwen3-8B) hit the identical failure
  immediately after Gemma's crash, then worked perfectly once isolated after
  a restart — pointing at a router-mode/build-level stability issue (likely
  tied to model swapping or sustained load), not Gemma's architecture
  specifically. Every subsequent request on the affected slot fails in ~1s
  regardless of content, which looks like a fast tool-error but isn't. A
  full `llama-server` restart (`launchctl unload`/`load -w` the plist)
  clears it. If a model that was working starts failing instantly, suspect
  this before suspecting the request or the model itself.
