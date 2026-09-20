# agent-gate

A set of deterministic security controls that run against a project directory and return one
verdict, plus the MCP delegation server this repository grew out of.

The repository is published as [`agent-gate`](https://github.com/tjwitko/agent-gate); the package
is still named `local-delegate-mcp` and the command it installs is `agent-gate`. That mismatch is
historical: the delegation server came first, the control set grew inside it, and the control set
is now the larger half.

The project exists to answer one question with evidence rather than assertion: **does a
deterministic gate change what a model actually ships?** The measured answer, so far, is that
advice in a prompt does not and a gate does — which is why enforcement lives in CI and not in
wording.

---

## The gate

```
agent-gate <project-dir> [task-file] [--json]
```

| exit | meaning |
|---|---|
| 0 | nothing blocking |
| 1 | blocking findings |
| 2 | usage error |
| 3 | part of the gate could not run |

**Exit 3 is the one that matters.** "Could not run" is not "passed", and anything consuming this
result has to tell them apart. Two failures in this project's history were exactly that confusion:
a runner that handed the validators an empty tool registry and printed `BLOCKING: none`, and a
control that connected and was never asked anything through ten graded runs while a similarly-named
check ran beside it. Never collapse 3 into 1, and never treat it as 0.

In `--json` mode stdout carries only the result document. The validators share code with the agent
loop, which narrates to `console.log`, so narration is redirected to stderr for the duration of the
run — one narration line in front of the JSON is enough to make it unparseable, and that is how the
corpus once died on fixture five of eleven.

### Where the controls come from

Resolution runs in this order, and the run reports which rule won for each control:

1. an environment variable — `TFGUARD_SERVER`, `DEPAUDIT_SERVER`, `SECRETGUARD_SERVER`, `IDENTITYGUARD_SERVER`
2. `.agent-gate.json` in the project under test
3. `node_modules`, so the controls are ordinary npm dependencies
4. a sibling checkout — how this repository has always worked, kept for local development

```json
{
  "controls": {
    "terraform-guard": "./vendor/terraform-guard-mcp/index.mjs",
    "dep-audit": "../dep-audit-mcp/index.mjs"
  }
}
```

An environment variable or config entry pointing at a file that does not exist is an **error**, not
a reason to fall through to the next rule: someone said where the control was and was wrong, and
quietly using a different one would hide that. A control that resolves from nowhere exits 3.

### The task file

Six checks are gated on what the task asked for — immutability, retention, secret rotation, tests,
error distinction and required artifacts. Without a task file they report "not checked", which is
accurate and much less useful. Pass one.

---

## The controls

Four MCP guard servers, each in its own repository and each installable:

| control | tool | backed by |
|---|---|---|
| [`@tjwitko/terraform-guard-mcp`](https://github.com/tjwitko/terraform-guard-mcp) | `terraform_plan` | `terraform`, plus `checkov` (advisory) |
| [`@tjwitko/dep-audit-mcp`](https://github.com/tjwitko/dep-audit-mcp) | `check_dependencies` | `osv-scanner` |
| [`@tjwitko/secret-guard-mcp`](https://github.com/tjwitko/secret-guard-mcp) | `scan_path` | `gitleaks` |
| [`@tjwitko/identity-guard-mcp`](https://github.com/tjwitko/identity-guard-mcp) | `check_auth_posture` | pure JS, no external binary |

Alongside them the gate runs its own validators in-process: `build_check`, `immutability`,
`authentication`, `manifest_contract`, `k8s_manifest`, `secret_rotation`, `retention`, `tests`,
`iam_contract`, `artifact_presence`, `code_quality`, `artifact_census` and `uncommitted_work`.

**The `@tjwitko` scope is not cosmetic.** `dep-audit-mcp` is already taken on npm by a different
author. Depending on these by their bare names would let npm install a stranger's package which
this gate then *spawns as a trusted security control* — dependency confusion with arbitrary code
execution, in the component whose entire job is to be trustworthy. They are depended on by pinned
git commit, not by registry name.

### Prerequisites

Three of the four shell out to a scanner that `npm ci` does not carry:

```bash
brew install terraform gitleaks osv-scanner
pipx install checkov
```

A missing scanner is an exit-3 condition, not a silent pass. CI installs and **version-checks**
them before the jobs that need them; the versions are pinned to the ones the corpus was measured
with, because the corpus compares finding counts and a newer scanner with one extra rule is
indistinguishable from a control that regressed.

---

## Running it in CI

The gate ships as a composite GitHub Action. See [`docs/ci.md`](docs/ci.md).

```yaml
- uses: tjwitko/agent-gate@main
  with:
    project: .
    task-file: task.txt
```

It sets an `outcome` output of `clean`, `blocked` or `incomplete`, and `blocked` and `incomplete`
must never render identically — both fail the build, but one means "we looked and found problems"
and the other means "we did not finish looking." That distinction is asserted in this repository's
own workflow against fixtures with known verdicts, because for a while it was quietly broken:
GitHub runs composite steps under `bash -e`, `set -uo pipefail` does not clear an inherited `-e`,
and the gate's non-zero exit killed the step before it could set `outcome` at all. The action could
only ever report success.

This repository's workflow runs three jobs: `unit` (Node 20/22/24), `corpus`, and `action`.

---

## The regression corpus

Eleven real deliverables, frozen with the verdict each one scored, shipped as
`corpus/fixtures.tar.gz`.

```bash
npm run corpus           # check against the frozen verdicts
npm run corpus -- --update   # re-derive them, deliberately
```

It exists because **every control defect in this project's history was found by running real work
through the controls, never by a unit test.** The unit tests are still there and still pass; they
have never once caught one of these.

Each fixture is copied to scratch, `git init`-ed and committed before the gate runs, so
`terraform init` and `go build` cannot leave the vendored copies dirty. Drift prints the finding
text, not just the count — a count tells you *which* check moved and never *why*, and on a machine
that is not the one that recorded the expectations, why is the entire question.

Two lessons are baked into `corpus/vendor.mjs`, both the same shape — an artifact frozen on one
machine that silently only works on that machine:

- **AppleDouble companions.** macOS `bsdtar` writes a `._name` file beside every entry to carry
  extended attributes, and macOS `tar tzf` hides them again by merging them back on listing. The
  archive read as 407 files while holding 814, half of them binary metadata. GNU tar does no such
  merge: on Linux `._app.js` extracts as a real file, `node --check` reports a syntax error, and
  `build_check` turns that into a blocking finding against code that is fine. The archive is now
  built with `COPYFILE_DISABLE=1` and then *verified with Python's `tarfile`* rather than `tar` —
  the platform that creates the problem is the one platform that cannot see it.
- **Platform-specific provider locks.** `.terraform.lock.hcl` recorded one `h1:` hash, for the
  machine that ran `terraform init`. On Linux terraform appends its own, modifying the file, and
  `uncommitted_work` correctly reported a dirty tree. The fixtures are now locked for
  `linux_amd64` and `darwin_arm64`.

Neither was a control misbehaving. Both controls were reporting truthfully about a tree that really
did contain binary junk and really did get modified. A corpus whose job is catching "works on my
machine" had two instances of it committed into its own fixtures.

---

## Why enforcement is in CI and not in the prompt

The evidence, from a webhook-receiver task run repeatedly against a frozen control set:

- **Twelve Haiku runs produced zero passes; three frontier-model runs passed on first attempt.**
- **The decisive control (`haiku-5`):** the identical gate, with the two lines naming the validator
  removed from the prompt. Result: 0 validator runs, 0 commits, 6 blocking findings. The model did
  not route around the gate — it never reached it.
- **Delivering the rules via `AGENTS.md` worked 2 times out of 4**, and cleanly bimodally: 5
  validator runs when the file was read, 0 when it was not.

A mechanism that works half the time is a hint, not a control. That result is the entire argument
for putting the gate in CI, where nothing has to choose to read it.

Written up in [`docs/haiku-experiment.md`](docs/haiku-experiment.md). The `AGENTS.md` stanza is in
[`templates/AGENTS.md.tmpl`](templates/AGENTS.md.tmpl) — useful as a hint, and explicitly not
relied upon.

---

## The delegation server

The original half of this repository: an MCP server that lets a calling model hand self-contained,
mechanical subtasks to a locally-hosted model.

```
Claude / any MCP client
  └─ MCP tool "delegate_to_local_model" ──► index.mjs (Node/stdio)
        └─ POST /v1/chat/completions ──► llama-server, router mode (local-copilot-stack)
```

This is **only the delegation client** — it does not run or manage any model. It expects an
OpenAI-compatible endpoint (default `http://localhost:8080`) in router mode, as set up by the
separate [`local-copilot-stack`](../local-copilot-stack). If that is not running, tool calls fail
with a clear "could not reach the local model" error.

### What it measured

Across six measured rounds, only one showed a real saving (−65%); the rest ran +118% to +257% *more*
expensive than doing the work directly. The dominant factor was not spec quality or model choice —
the calling model **paid for the artifact twice**, once writing the spec and again transcribing the
result into its own `Write` call. That second payment is exactly the do-it-yourself baseline, which
caps savings near zero however good the rest of the delegation is. `output_files` exists to remove
it: the server writes the files, and the caller reads them back to review.

Two further measured results worth keeping:

- **Bigger and newer lost.** Qwen3.5-9B and Gemma 4 12B both lost to the 7B, decided by a reasoning
  phase burning the token budget before producing output. Qwen3-8B with reasoning *off* tied the
  7B almost exactly. Benchmark a candidate (`bench/run-benchmark.mjs`) rather than assuming size
  predicts anything.
- **The same validation-gate bug appeared in five independent generations across four models** —
  an optional field's validation copying the required-field gate. That is a standing review
  checkpoint for this task shape, not a model-quality signal.

### The size gate and the ledger

`expected_output_lines` is required, and calls under **150 lines** (300 when `context_files` were
authored for the call) are refused before the local model is contacted. This is enforcement rather
than advice because advice was tried and observably failed: the `context_files` cost lesson was
written into this repo's docs after one round and violated in the very next one.

**The gate cannot make the spec cheap.** By the time the tool is invoked the caller has already
spent the tokens writing `task`; a refusal is a lesson for the next call, not a save on this one.
`acknowledge_small_task` is the escape hatch and takes a written reason rather than a boolean.

Every call is appended to `~/Library/Application Support/local-delegate-mcp/ledger.json`, which
flags estimate miscalibration, three-plus small calls inside ten minutes, and a ≥30% losing rate
over the last ten delegations. It speaks up only when something fires, so silence is meaningful.

---

## Security & guardrails

- **Environment sanitization.** At startup the server keeps only `PATH`, `HOME`, `LOCAL_LLM_URL`,
  `FAST_MODEL_ALIAS`, `CAPABLE_MODEL_ALIAS` and `CONTEXT_ROOT`, deleting everything else, so it
  never inherits secrets from whatever spawned it.
- **Credential scanning.** `task`, `system_prompt` and `context_files` content are scanned for
  credential-shaped content and the call is refused on a match. The agent loop's `write_file`
  handler uses `secret-guard`'s scanner as a *library* rather than over MCP, so the check runs
  inside the synchronous write handler and the bytes never reach disk — a secret caught there never
  enters git history, so there is nothing to rotate.
- **Read and write containment.** `context_files` and `output_files` paths must resolve inside
  `CONTEXT_ROOT`, with a sensitive-filename denylist on both. For writes the caller declares the
  allowed paths up front and the model's own emitted paths are checked against that list — the
  model never chooses where bytes land. Existing files need `allow_overwrite`, and all paths are
  validated before any file is written.
- **Advisory output only.** The local model returns text; nothing is executed on its behalf.
  `output_files` writing text to disk is not running it, but unreviewed output can land in your
  tree. Read the files back.
- **The local model is never given internet access.** It has no instruction-hierarchy training, so
  fetched content would become a second, less reviewable injection surface. When a task depends on
  a versioned external interface, the *orchestrator* verifies it and passes the result through
  `context_files`.

---

## Setup

```bash
npm install
npm test          # unit tests
npm run corpus    # regression corpus (needs the scanners above)
```

No build step. Registered as an MCP server via:

```json
{ "command": "node", "args": ["/absolute/path/to/local-delegate-mcp/index.mjs"] }
```

Optional environment variables: `LOCAL_LLM_URL`, `FAST_MODEL_ALIAS`, `CAPABLE_MODEL_ALIAS`,
`CONTEXT_ROOT`.

## Status

The control set is the active half. The four guard servers are public and installable, the gate
runs as a CLI and as a GitHub Action, and the corpus guards it against regression. Unit tests pass
on Node 20, 22 and 24; the corpus passes locally on all eleven fixtures.

A check that cannot run now says so everywhere it can happen: an unreachable MCP control, a control
that connected and was never called, a checker whose toolchain is missing, a suite killed on a
timeout, and a check that crashed. All of them route to exit 3 rather than to a finding or a pass.

The sharpest demonstration came from the corpus itself. Three Go deliverables carried a clean
`tests` verdict measured on a machine with no Go toolchain; their suites had never compiled, and
only a run on a machine that had Go could see it. The check had behaved correctly the whole time —
it reported NOT EXECUTED as an advisory — and the corpus froze that non-answer as the answer.
Saying "I could not check this" is not enough on its own; something downstream has to act on it.
So `--update` now refuses to freeze an incomplete run, and the manifest records the toolchain that
measured it, where a `null` means that language's checks could not run at all.

One open item, recorded in [`docs/ci.md`](docs/ci.md): `check_dependencies` finds fewer
vulnerabilities on Linux CI than locally, on two fixtures, and the cause is not established. The
first thing to rule out is `dep-audit-mcp` reporting zero findings when it cannot reach the
vulnerability database, which would be a silent pass inside the control set.
