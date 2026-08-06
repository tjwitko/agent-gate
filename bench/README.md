# bench/

A reusable benchmark for deciding whether a candidate local model is worth adopting into
`local-copilot-stack`'s `presets.ini`, before spending disk/RAM on it permanently. Grew out of
manually comparing Qwen2.5-Coder-7B, Qwen3.5-9B, and Gemma 4 12B on this project's Mac — see
`local-copilot-stack`'s README for what that comparison found and why size alone was a bad
predictor of which model would actually work well here.

## What it does

Runs the same standardized four-file REST-resource codegen task (`task.json`) against a target
model, through `local-delegate-mcp`'s real `delegate_to_local_model` tool — not a raw completion
call — so the numbers reflect what actually happens in production use, including the tool's own
guardrails and ratio-warning. `reference/` is the known-good pattern (a `users` resource) the
task asks the model to extend with `projects` and `tasks` resources, matching the exact setup
used for every model tested so far.

It automates:
- calling the model with an escalating `max_tokens` budget when a response comes back truncated
  or empty (the two failure signatures found manually: hitting `max_tokens` mid-file, or filling
  the whole context window with `reasoning_content` before producing any real output)
- splitting the response into files, installing dependencies, running the test suite
- reporting attempts needed, total local tokens burned, wall-clock time, and pass/fail

It does **not** automate code review. A model can pass every test and still have real bugs, or
fail tests for a reason unrelated to model quality (rerun and look at `runs/<label>/` by hand).

## Usage

```bash
node bench/run-benchmark.mjs --model <router-preset-alias>
```

The alias must already be registered in the live `presets.ini` (add it there and restart
`llama-server` first — this script doesn't touch router config, on purpose: that's a shared
service other tools depend on, so changing it stays a deliberate, reviewed step, not something
a benchmark script does silently).

Options:
- `--start-max-tokens <n>` — initial budget (default 3000)
- `--max-tokens-ceiling <n>` — stop escalating past this (default 20000)
- `--max-attempts <n>` — give up after this many tries (default 3)
- `--label <name>` — subdirectory under `runs/` (default: the model alias)
- `--task <path>` — alternate task JSON (default: `task.json`). Use this for model-specific
  prompt tweaks rather than editing the shared task — `task-no-think.json` is an example,
  prepending Qwen3's documented `/no_think` flag for a model whose reasoning is optional
  rather than built-in.

Output lands in `bench/runs/<label>/` (gitignored — each run does its own `npm install`) along
with `bench-report.json` and `test-output.txt`.

## Interpreting results

Compare `attempts`, `totalLocalTokens`, and `totalElapsedSeconds` across candidates — lower is
better on all three, and a model needing multiple attempts or hitting the token ceiling without
completing is a bad sign regardless of final code quality. `testsPassedCleanly: false` doesn't
automatically disqualify a model (the 7B needed a one-line fix in earlier manual testing and
still won overall) — read the diff yourself before deciding.

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
