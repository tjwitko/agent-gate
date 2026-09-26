# CLAUDE.md

**This directory is published as [`agent-gate`](https://github.com/tjwitko/agent-gate)** — a set of
deterministic security controls that run against a project and return one verdict: clean, blocked,
or could-not-run. It is a CLI, a GitHub Action and a library, and it is what the repository is
named, versioned and released as.

It used to be `local-delegate-mcp` as well — an MCP server that delegates subtasks to a
locally-hosted model. That came first and the gate grew around it. It now lives in
[delegate-mcp](https://github.com/tjwitko/delegate-mcp), extracted at `6e08218`, because keeping
both here cost three releases' worth of packaging defects: `main` resolved to the delegation server,
and a security package listed `axios` as a runtime dependency. Nothing in this repository calls a
model.

## The gate

```
agent-gate <project-dir> [task-file]  ->  bin/validate.mjs
```

It spawns the four control servers itself, runs ~18 validators, and exits with a contract nothing
may collapse: **0** clean, **1** blocking findings, **2** usage error, **3** part of the gate could
not run. Exit 1 and exit 3 must never become each other — a check that cannot run says so and never
passes, which is the single rule the whole project is built around.

The controls are the four sibling MCP servers, resolved via `lib/resolve-controls.mjs` from an
explicit env var, `.agent-gate.json`, `node_modules`, or a sibling checkout, in that order. A
control that resolves from nowhere is an exit-3 condition and never a silent skip, which is why that
file reports *how* each control resolved rather than only *that* it did.

**The gate is deliberately not an MCP tool.** Across four runs of one task the model called
`terraform_plan` 3, 1, 4 and 0 times and never called `check_dependencies` at all. A tool the model
may or may not invoke is not a guardrail, so enforcement lives where a model cannot route around it:
the CLI, the pre-commit hook, and CI.

## Key files

- `bin/validate.mjs` — the CLI and the package entry point. Exports `runGate()` and guards `main()`
  behind an entry-point check, so it is importable without side effects.
- `lib/resolve-controls.mjs` — where the four controls come from, and the reporting of it.
- `agent/` — the validators, one file per check, plus the tool-calling agent loop described below.
- `action.yml` — the GitHub Action. Renders the result with its own script; that renderer once
  printed findings and not `couldNotRun`, `notApplicable` or `exempt`, so in CI a check that could
  not run was indistinguishable from one that found nothing. Two renderers of the same document
  disagreeing about what matters is a bug in one of them.
- `corpus/` — fixtures with known verdicts, frozen, so a rule change that moves a verdict is caught.
- `bench/` — `new-run.sh` scaffolds a run, `grade-run.sh` grades one and verifies what it was
  actually configured with, `control-set.mjs` decides whether two runs are comparable. Not shipped,
  except `bench/langfuse-tracing.mjs`, which `agent/agent-loop.mjs` imports. The model benchmark
  that used to live here went to delegate-mcp with the server it drives.

### The agent loop

`agent/agent-loop.mjs` is an MCP-enabled tool-calling loop that lets a model drive the sibling MCP
servers and validate its own work. Its central design decision: **the model saying DONE is a
request, not the exit condition** — the harness runs the validators itself and only ends the run
when they pass. See `agent/README.md`.

It refuses to let a run end with uncommitted work, because the loop's own validator set is a
*subset* of what the pre-commit hook runs — three separate runs reported "validation PASSED" with
the real deliverable sitting uncommitted, having never been seen by the boundary that runs the full
check set.

Its `write_file` handler refuses content containing hardcoded credentials, using
`../secret-guard-mcp`'s scanner as a **library** rather than through MCP — the check has to run
inside the synchronous write handler, and the whole point is that the bytes never reach disk. A
secret caught there never enters git history, so there is nothing to rotate. Verified against a real
run: asked to write a file containing a GitHub PAT, the model got `REFUSED: settings.py was NOT
written` and no file appeared. The gate additionally runs `scan_path` over the whole tree, which
covers files the model did not write.

Runs are traced to Langfuse via `bench/langfuse-tracing.mjs` — one generation per turn, a span per
tool call, spans for each gate round and the advisor wait, and six scores. Tracing is best-effort
and no-ops when the stack is down; a run is 40 minutes of real model time and must never be lost to
a sidecar.

### Task-gated validators

`agent/immutability.mjs` is the one **blocking** validator that judges the task's requirement
rather than the code's correctness, and it exists because of a measured failure. Across nineteen
runs of an "immutable audit log" task, not one deliverable implemented an immutability control
before review — 0 for 4 in the runs whose round-1 state was preserved. That is not forgetfulness:
the model states its reasoning in its own comments ("The logs are immutable as the service only
provides endpoints for adding and reading logs"), and the reasoning is coherent if this client is
the only thing holding the credential. Advisory findings never changed it in any run; in the same
run where immutability was advised and ignored, five refused `write_file` calls moved a hardcoded
credential to AWS Secrets Manager. Advice was not working, refusal was. Three properties to keep:
it fires only on a store that names itself an audit log (firing on every table is how a blocking
check gets switched off), an undetermined answer is an advisory and never a pass, and it is tested
against the four real deliverables whose ground truth is known — two protected, two not, 4 for 4.

`agent/authentication.mjs` is the second such validator, added for the same measured reason: "no
endpoint authenticates" appeared in 5 of 5 preserved reviews and was still unfixed six runs later.
It is paired with the immutability check deliberately — an immutable store filled by anonymous
writers is a tamper-proof record of unattributable claims, so closing one without the other buys
little. Two properties to keep: it judges **per route**, because a real run authenticated POST and
left GET open and any project-level "is there auth here" test would have passed it; and it does not
treat `Depends(...)` as authentication, because another run had `Depends(get_db)` on every route and
authenticated none — that distinction is the whole check. Health and readiness probes are exempt.
Validated against the five preserved deliverables whose auth state is known by hand, including both
partial cases: 5 for 5.

Both test files run per-file (`node --test agent/immutability.test.mjs`). Note the path must be the
file: `node --test agent/` tries to load the directory as a module and fails.


## Common commands

```sh
npm install
node bin/validate.mjs <project-dir> <task-file>   # the gate, against a project
npm test                                          # node --test agent/*.test.mjs
npm run corpus                                    # the frozen-verdict fixtures
```

Tests run per-file (`node --test agent/immutability.test.mjs`). The path must be the file:
`node --test agent/` tries to load the directory as a module and fails.

## Things to know

- **The commit gate must fail when it cannot run, not disappear.** The uncommitted-work check was
  wrapped in `if (status.status === 0)`, and `git status` exits non-zero outside a repository — so
  a run into a plain directory made 26 `write_file` calls, got `Not a git repository` from all four
  `git_commit` calls, and reported `validation PASSED`. There was no failure, no advisory, and no
  `uncommitted_work` entry in the validators-run list, which is what made it invisible rather than
  merely wrong. This matters more than a missed lint: the pre-commit hook is the **only** place the
  workload-identity scan and terraform-guard's source scan run in this pipeline. `ensureRepo()` now
  `git init`s the project at startup so the boundary exists before the model writes anything — the
  loop cannot create it later, because `git_commit` is broken in exactly the case that needs it —
  and the gate fails loudly if `git status` still errors.
- **`GUARD_CONFIG_FILES` must name every sibling's suppression file.** It listed `.gitleaksignore`,
  `.gitleaks.toml` and `.tfguard-fixture` but not `.identity-exception`, so a model blocked from
  committing wrote one and the commit went through — the guard the model can edit is not a guard,
  which is the reason the list exists. The basename is hardcoded rather than imported, to avoid
  depending on an optional sibling repo loading at startup; `identity-guard-mcp`'s test suite pins
  the value so a rename cannot drift the two apart silently.
- **`git commit` commits the index, not what your process just staged.** Two agent sessions sharing
  this working tree produced a commit containing one intended file plus 1,715 lines another session
  had staged, under a message describing only the first. Nothing warns about this. Use
  `git commit -- <paths>` when anything else might be working in the tree, and read the
  `N files changed` line afterwards — that line is what caught it, one commit late.
