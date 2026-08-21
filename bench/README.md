# bench/

A reusable benchmark for deciding whether a candidate local model is worth adopting into
`local-copilot-stack`'s `presets.ini`, before spending disk/RAM on it permanently. Grew out of
manually comparing Qwen2.5-Coder-7B, Qwen3.5-9B, and Gemma 4 12B on this project's Mac — see
`local-copilot-stack`'s README for what that comparison found and why size alone was a bad
predictor of which model would actually work well here.

## What it does

Runs a codegen task against a target model, through `local-delegate-mcp`'s real
`delegate_to_local_model` tool — not a raw completion call — so the numbers reflect what actually
happens in production use, including the tool's own guardrails and ratio-warning. Each task JSON
is self-describing (`taskType`, `referenceDir`, `requiredMarkers`, `verify`), so the harness
itself doesn't hardcode any one task shape. Two shapes exist so far:

- **`node-rest`** (`task.json`, `task-no-think.json`) — the original four-file REST-resource
  codegen task. `reference/` is the known-good pattern (a `users` resource) the task asks the
  model to extend with `projects` and `tasks` resources. Verified by running the reference
  project's test suite (`node --test`).
- **`iac`** (`task-iac.json`) — a Terraform/Docker infrastructure task. `reference-iac/` is a
  known-good pattern (an S3 module with correct Object Lock config, wired into a root module with
  exactly one provider block) the task asks the model to extend with a second module (DynamoDB),
  plus write a Dockerfile from scratch for the reference app. Verified by `terraform validate`
  and `docker build`. Added after a real delegated round on an unrelated project shipped Terraform
  with a duplicate provider block, an invalid resource attribute, and undeclared variables, plus a
  Dockerfile whose build step shelled out to `docker build` from inside its own image build — all
  of it schema/structurally invalid, none of it caught by anything in this harness at the time.
  **What it still won't catch**: live-cloud-semantics bugs, like a storage class that silently
  breaks reads on real S3, or a wrong per-object API field name that only a real S3-compatible
  endpoint rejects. Those two were the worst bugs found in that same round and only surfaced
  against a real MinIO container — deliberately not folded into this generic harness, since it's
  heavy (container pull, bucket setup) and specific to whichever cloud service a given task
  happens to touch. Treat that class of bug as something to check by hand per task, the way it was
  found originally.

It automates, regardless of task shape:
- calling the model with an escalating `max_tokens` budget when a response comes back truncated
  or empty (the two failure signatures found manually: hitting `max_tokens` mid-file, or filling
  the whole context window with `reasoning_content` before producing any real output)
- splitting the response into files, installing dependencies (if `package.json` is present)
- checking every generated `.js`/`.mjs`/`.cjs` file's `import`/`require` specifiers against
  `package.json`'s declared dependencies, flagging anything imported but never declared — a real
  bug found in the same round (a model used `ajv` without adding it as a dependency) that isn't
  specific to either task shape
- running the task-appropriate verification (test suite, or terraform validate + docker build)
- reporting attempts needed, total local tokens burned, wall-clock time, and pass/fail

It does **not** automate code review. A model can pass every check here and still have real bugs
outside what these checks cover (rerun and look at `runs/<label>/` by hand) — see the live-cloud
caveat above for a concrete example of the gap.

## Usage

```bash
node bench/run-benchmark.mjs --model <router-preset-alias>
node bench/run-benchmark.mjs --model <router-preset-alias> --task task-iac.json
```

To compare several candidates across several tasks in one pass, see
[Tracing and comparing runs](#tracing-and-comparing-runs-langfuse) below.

The alias must already be registered in the live `presets.ini` (add it there and restart
`llama-server` first — this script doesn't touch router config, on purpose: that's a shared
service other tools depend on, so changing it stays a deliberate, reviewed step, not something
a benchmark script does silently). The `iac` task also needs `terraform` and `docker` on `PATH`;
if either is missing, that check is reported as skipped (`null`), not failed.

Options:
- `--start-max-tokens <n>` — initial budget (default 3000)
- `--max-tokens-ceiling <n>` — stop escalating past this (default 20000)
- `--max-attempts <n>` — give up after this many tries (default 3)
- `--label <name>` — subdirectory under `runs/` (default: the model alias)
- `--task <path>` — alternate task JSON (default: `task.json`). Use this for model-specific
  prompt tweaks (`task-no-think.json`, prepending Qwen3's documented `/no_think` flag) or an
  entirely different task shape (`task-iac.json`) rather than editing a shared task file.

Output lands in `bench/runs/<label>/` (gitignored — each run does its own `npm install`) along
with `bench-report.json` and, depending on task shape, `test-output.txt` or
`terraform-validate-output.txt` + `docker-build-output.txt`.

## Interpreting results

Compare `attempts`, `totalLocalTokens`, and `totalElapsedSeconds` across candidates — lower is
better on all three, and a model needing multiple attempts or hitting the token ceiling without
completing is a bad sign regardless of final code quality. `testsPassedCleanly: false` (or, for
`iac` tasks, `terraformValid: false` / `dockerBuildOk: false`) doesn't automatically disqualify a
model (the 7B needed a one-line fix in earlier manual testing and still won overall) — read the
diff yourself before deciding. A non-empty `missingDependencies` is worth checking regardless of
task shape or which other checks passed.

If a model can't complete even near the token ceiling, check whether `ctx-size` in `presets.ini`
is the real bottleneck before blaming the model — see the empirical note in that file's Gemma
entry. This script can't fix that for you: it would require editing and restarting a shared
service, which stays a manual, reviewed step.

If a model fails instantly on every attempt (`usage: null`, ~1s each), that's very likely
`llama-server`'s "Compute error" crash state, not the model or this script — check
`curl localhost:8080/health` and try a trivial direct request to the alias before concluding
anything. This has now been observed on two unrelated models in the same session (Gemma 4 12B,
then Qwen3-8B immediately after), so it looks like a router-mode/build-level stability issue
rather than something specific to one model — a `launchctl unload`/`load -w` restart clears it.

## Tracing and comparing runs (Langfuse)

Everything above works standalone and always has. This section is strictly additive: it exists
because comparing more than two or three candidates by reading `bench-report.json` files side by
side does not scale, and because `bench/runs/` is overwritten on the next run, so the history that
would answer "was the 9B ever better?" was being thrown away.

With the sibling [`../langfuse-local`](../../langfuse-local) stack running, each benchmark also
emits a trace: one **generation per attempt** carrying the model's own `prompt`/`completion`/`total`
token counts and the `max_tokens` budget that attempt used, spans for the file-split, dependency
and verification phases, and every number in `bench-report.json` attached as a **score** so
Langfuse can chart it across runs.

```bash
../langfuse-local/langfuse.sh up          # start the stack (see its README for the RAM tradeoff)
node bench/run-benchmark.mjs --model delegate-fast
```

The harness reads `../langfuse-local/.env` directly, so there is no export step. Point it
elsewhere with `LANGFUSE_ENV_FILE`, or by setting `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` /
`LANGFUSE_BASE_URL` in the environment, which take precedence over the file.

**Tracing can never fail a run.** A benchmark costs minutes of real model time, so losing one to a
down sidecar would be a bad trade. `langfuse-tracing.mjs` probes `/api/public/health` before
enabling and falls back to no-op objects with the same shape as real observations; with the stack
down, `run-benchmark.mjs` produces the same stdout, the same `bench-report.json` and the same exit
code it did before any of this existed. It prints one line saying tracing is off, and continues.

Note that the instrumentation lives in the **harness**, not in `index.mjs`. The server sanitizes
`process.env` down to a five-key allowlist; tracing from inside it would mean widening that
allowlist to carry Langfuse credentials into a process whose whole design point is a minimal
environment. The harness already parses the server's `[usage]` stderr line and owns all the
timing, so it can emit a complete generation without the server knowing Langfuse exists.

### Comparing models: `run-experiment.mjs`

```bash
node bench/run-experiment.mjs --models delegate-fast,Qwen3.5-9B-UD-Q4_K_XL.gguf
node bench/run-experiment.mjs --models delegate-fast --tasks task.json,task-iac.json
```

This is a thin comparison layer over `run-benchmark.mjs`, not a second implementation of it. Each
cell of the model × task grid is a real child-process invocation of the same script, so every
guarantee it makes — the real delegation path through `index.mjs`, escalating `max_tokens`,
the dependency check, the task-appropriate verification — holds unchanged. The experiment layer
only chooses what to run, reads back the `bench-report.json` each run already writes, and turns
those numbers into scored, comparable experiment items under one name in the Langfuse UI.

Runs are strictly **sequential**: they contend for a single `llama-server`, so parallelism would
distort exactly the wall-clock and token numbers being measured.

Unlike `run-benchmark.mjs`, this script *requires* the stack — there is nowhere to record an
experiment without it — and exits with a clear message if it is not up.

Scores recorded per item: `completed`, `verification_passed`, `attempts`, `total_local_tokens`,
`wall_clock_seconds`, `missing_dependencies`. Aggregated per model: `pass_rate`, `avg_attempts`,
`total_tokens_all_tasks`, `total_wall_clock_seconds`.

**None of this replaces reading the code.** A model can score perfectly on every metric here and
still have the live-cloud-semantics bugs described above. The scores tell you which candidates are
worth reviewing by hand, not which one to adopt.
