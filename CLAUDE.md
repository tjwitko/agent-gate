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
- `agent/` — an MCP-enabled tool-calling loop that lets a *local* model drive the sibling MCP
  servers and validate its own work. Exists because `delegate_to_local_model` is a single
  completion call with no tool loop, so a model driven through it can never reach an MCP server.
  Its central design decision: **the model saying DONE is a request, not the exit condition** —
  the harness runs the validators itself and only ends the run when they pass. That came from
  measuring four runs of one task where the model called `terraform_plan` 3, 1, 4 and 0 times and
  never called `check_dependencies` or `web_search` at all. A tool the model may or may not invoke
  is not a guardrail. See `agent/README.md`.
  Its `write_file` handler also refuses content containing hardcoded credentials, using
  `../secret-guard-mcp`'s scanner as a **library** rather than through MCP — the check has to run
  inside the synchronous write handler, and the whole point is that the bytes never reach disk.
  A secret caught there never enters git history, so there is nothing to rotate. Verified against
  a real run: asked to write a file containing a GitHub PAT, the model got
  `REFUSED: settings.py was NOT written` and no file appeared. The gate additionally runs
  `scan_path` over the whole tree, which covers files the model did not write.
- `bench/` — reusable benchmark for deciding whether a candidate local model is worth adopting
  into `local-copilot-stack`'s `presets.ini`. `bench/run-benchmark.mjs --model <alias>` runs a
  standardized codegen task through the real delegation tool, escalating `max_tokens`
  automatically on truncation, then reports attempts/tokens/wall-clock/pass-fail. Two task shapes,
  each fully self-describing via its own JSON (`taskType`, `referenceDir`, `requiredMarkers`,
  `verify`) — the harness has no hardcoded task shape:
  - `task.json` / `task-no-think.json` (`taskType: "node-rest"`) — verified by the reference
    project's test suite.
  - `task-iac.json` (`taskType: "iac"`) — a Terraform/Docker task, verified by `terraform
    validate` + `docker build` (needs both on `PATH`; missing either is reported as skipped, not
    failed). Added after a real delegated round shipped Terraform with a duplicate provider
    block, an invalid resource attribute, and undeclared variables, plus a Dockerfile that
    shelled out to `docker build` from inside its own image build. Confirmed working on first
    real run: caught a 7B-generated `aws_sqs_queue.this.queue_url` (real attribute is `.url`)
    that would otherwise have shipped silently. **Does not catch live-cloud-semantics
    bugs** — the same round's worst two bugs (a storage class that silently breaks reads on real
    S3, a per-object API field that only a real S3-compatible endpoint rejects) only surfaced
    against an actual MinIO container and were deliberately not folded into this generic harness;
    check that class by hand, per task.
  Regardless of task shape, every run also flags any `import`/`require` of a package never
  declared in the generated project's `package.json` (`missingDependencies` in the report) — a
  real bug from the same round (a model used `ajv` without declaring it) that isn't specific to
  either task shape. See `bench/README.md`. `bench/runs/` is gitignored scratch output.

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
- **Use `context_files` instead of pasting file contents into `task` — but
  only when the file already exists for other reasons.** Pasting costs
  output tokens to transcribe; empirically this made one real delegation
  (CLAUDE.md drafting) cost ~160% more Claude output tokens than just doing
  it directly. `context_files` is only actually free under that same
  precondition though: authoring a *new* file specifically to use this
  parameter costs the same as pasting would have — measured directly on a
  dep-audit-mcp delegation where a schema-reference file had to be created
  from scratch, contributing roughly half of a ~173% overhead. If you need
  to demonstrate a real external schema that isn't a file yet, derive one
  with a short script from data you can already fetch, rather than
  hand-composing the example — you pay for the script, not its output.
  Confined to `CONTEXT_ROOT` (default: cwd), refused if a path escapes it,
  matches a sensitive-filename denylist, or its content trips the same
  credential scan as `task`/`system_prompt`.
- **`expected_output_lines` is required and enforced.** Under 150 lines (300
  if `context_files` were authored for the call) the tool refuses before the
  model is contacted. Estimate the number *before* writing the spec — the
  spec's tokens are already spent by the time a refusal comes back, so the
  refusal saves nothing on the call it blocks, only on the next one. If the
  estimate is under the bar, don't write the spec at all: write the code.
  - `context_files_are_preexisting` is required alongside `context_files`.
  - `acknowledge_small_task` bypasses the gate but takes a written reason and
    is logged. Reaching for it repeatedly means the gate is right and the
    usage pattern is wrong.
  - Don't inflate the estimate to get through. The ledger compares declared
    against actual and flags anything off by more than half.
- **A cross-call ledger lives at `~/Library/Application Support/local-delegate-mcp/ledger.json`.**
  It flags estimate miscalibration, three-plus small calls inside ten
  minutes, and a ≥30% losing rate over the last ten delegations. It only
  emits a note when something fires, so silence is meaningful. (It also
  disproves an earlier claim in these docs that the server had no cross-call
  visibility — it does, via this file.)
- **Pass `output_files` whenever the result is destined for files.** Taking
  the returned text and writing it out yourself pays output tokens a *second*
  time for content the model already produced — that second payment is
  exactly the do-it-yourself baseline, so it structurally caps savings near
  zero. This was the dominant factor across six measured rounds: the only one
  that won (−65%) happened to avoid the retype via an external splitting
  script, and a later round that hand-integrated its result landed at +173%
  with the retype alone accounting for the entire baseline. The server writes
  the files; you get back a manifest and read them to review.
  - For multiple files, tell the model in `task` to precede each with a line
    reading exactly `===FILE: <path>===`.
  - The model's emitted paths are checked against your declared list, so it
    can't choose where bytes land. Existing files need `allow_overwrite`.
  - Markdown code fences are stripped automatically — the models emit them
    despite instructions often enough that unstripped fences would routinely
    corrupt written files.
- **Don't restate in prose what `context_files` already shows structurally,
  and don't re-derive in English the logic of code you've already written.**
  Both are redundant spec cost. Reserve prose for what an example can't
  convey (thresholds, ordering rules, edge cases), and reference an existing
  helper by name instead of describing what it does.
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
- **Verify versioned external interfaces yourself before delegating against
  them — don't give the local model internet access to do it.** A throwaway
  test (an immutable audit-log service with Kubernetes/Terraform deployment
  artifacts) surfaced 8 real bugs across two delegated calls, but only one —
  wrong field names for a pinned `terraform-aws-modules/eks/aws` version
  (`node_groups` instead of `eks_managed_node_groups`, `instance_type`
  instead of `instance_types`, `desired_capacity` instead of `desired_size`,
  plus the module referencing its own output as its own input) — was a
  stale/versioned-knowledge problem. The other seven (Express route
  shadowing, a `node:test`/`assert` import that doesn't exist, Docker
  `USER`/`COPY` ordering, an unpaired code fence, an Express default-status
  assumption, an immutable store's tests assuming reset semantics it can't
  have) were reasoning errors internet access wouldn't touch. For the one
  category it would help, giving the *local* model live fetch access is the
  wrong fix: it has no instruction-hierarchy training (same reason
  `context_files` content is scanned for secrets and Read containment
  exists), so fetched content becomes a second, less reviewable injection
  surface; it also has no reliable sense of when its own knowledge is stale,
  so it wouldn't know when to bother looking something up; and this
  project's own history is small-local-model tool-calling being unreliable
  (why Qwen2.5-Coder was swapped out as the interactive-chat model
  originally). What actually fixed the Terraform bug was the *orchestrator*
  fetching the module's real source (`WebFetch`/`curl` against the actual
  GitHub repo, not memory) and passing the verified interface through
  `context_files` — the same reviewed, sandboxed mechanism already used for
  everything else. Do that deliberately whenever a task references a
  specific version of a library, framework, or infrastructure module,
  instead of trusting either your memory or the local model's.
- **A model backend can crash into a persistent "Compute error" state under
  llama-server; the trigger looks like switching model tiers.** Three
  occurrences now: (1) Gemma 4 12B after a near-max-context generation, (2)
  Qwen3-8B immediately after Gemma's crash during the 4-model benchmark, (3)
  Qwen3-8B again after a run of `delegate-fast` calls switched to
  `model: "capable"`. Every case involved a tier swap shortly beforehand,
  and in every case the "broken" model worked perfectly once isolated after
  a restart — so this is a router-mode/build-level issue, not any model's
  architecture. It's per-slot, not whole-server: `delegate-fast` kept
  answering normally while the Qwen3-8B slot returned HTTP 500 on every
  request. **Practical consequence: avoid switching tiers mid-session when
  you can.** Symptoms are a `Compute error` 500 (or a ~1s tool-error that
  looks like a fast failure but isn't); a full `llama-server` restart
  (`launchctl unload`/`load -w` the plist) clears it. If a model that was
  working starts failing instantly, suspect this before the request or the
  model.
- **The two `context_files`/prose-cost fixes above are documentation-only,
  not code-enforced — and that's probably as far as this line of fixes
  goes.** The server can't tell whether a context file was already lying
  around or authored five minutes ago for this one call, or whether `task`
  prose duplicates an example — that distinction only exists in the calling
  model's own workflow history. Same situation as the batching guidance:
  fixable-in-code problems (context-paste cost, tiny-artifact cost) already
  have code fixes (`context_files`, the ratio warning); what's left is
  judgment calls only the caller can make.
