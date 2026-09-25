# agent-gate

[![gate](https://github.com/tjwitko/agent-gate/actions/workflows/gate.yml/badge.svg)](https://github.com/tjwitko/agent-gate/actions/workflows/gate.yml)
[![release](https://img.shields.io/github/v/release/tjwitko/agent-gate)](https://github.com/tjwitko/agent-gate/releases/latest)
[![license](https://img.shields.io/github/license/tjwitko/agent-gate)](LICENSE)

Run a set of security and completeness controls against a project directory and get back one
verdict: **clean**, **blocked**, or **could-not-run**.

It is built for code that an AI agent wrote. Agents produce plausible work quickly, and the usual
review signals — it builds, there are tests, the summary says "production-ready" — stop being
reliable. agent-gate checks the things that plausible-looking work gets wrong: infrastructure that
plans clean but is open to the world, dependencies with known CVEs, credentials hardcoded into
source, endpoints with no authentication, and test suites that do not run.

It is equally useful on code a human wrote. Nothing in it assumes an agent.

**The distinguishing feature is the third verdict.** Most gates have two answers: pass or fail. This
one refuses to report "clean" when part of it could not run — a missing scanner, an unreachable
control, a test suite whose toolchain is absent. "I could not check this" and "I checked this and it
is fine" are different facts, and collapsing them is how a gate quietly stops protecting anything.

---

## Getting started

### Requirements

- **Node.js 20 or newer**
- The scanners the controls drive. Install the ones matching your stack:

  ```bash
  brew install terraform gitleaks osv-scanner   # macOS
  pipx install checkov ruff
  python3 -m pip install pytest      # only if your project has a Python test suite
  ```

  | tool | needed for | required? |
  |---|---|---|
  | `gitleaks` | credential scanning | yes |
  | `osv-scanner` | dependency vulnerabilities | yes |
  | `terraform` | Terraform plan and policy checks | if the project has `.tf` files |
  | `checkov` | extra Terraform coverage | optional, advisory only |
  | `ruff` | Python static checks | if the project has Python |
  | `pytest` | running a Python test suite | if the project has Python tests |
  | `docker`, `go` | Go build and test | if the project has Go |

  A missing tool is **never** silently skipped. The run reports it and exits 3.

`pytest` is installed with `pip` rather than `pipx` on purpose: the gate runs a Python suite
with `python3 -m pytest`, so the module has to be importable by that interpreter. A console
script on `PATH` is a different fact and will not satisfy it.

### Install

Latest release: **[v1.1.0](https://github.com/tjwitko/agent-gate/releases/latest)**

```bash
npm install --save-dev github:tjwitko/agent-gate#v1.1.0
```

The four control servers come with it as dependencies — there is nothing else to clone or wire up.
They are pinned to their own `v1.0.0` tags, so this installs the same five components every time.
Drop the `#v1.1.0` to track `main` instead, which moves.

### Run it

```bash
npx agent-gate .
```

Point it at any directory. To get the most out of it, pass the task the code was written to satisfy:

```bash
npx agent-gate . task.txt
```

Six checks are gated on what the task asked for — immutability, retention, secret rotation, tests,
error distinction, and required artifacts. Without a task file they report "not checked", which is
honest and much less useful.

### What you get

```
project        : /home/you/webhook-receiver
control        : terraform-guard  node_modules @tjwitko/terraform-guard-mcp
control        : dep-audit        node_modules @tjwitko/dep-audit-mcp
control        : secret-guard     node_modules @tjwitko/secret-guard-mcp
control        : identity-guard   node_modules @tjwitko/identity-guard-mcp
validators run : build_check, terraform_plan(terraform), check_dependencies, immutability, ...

BLOCKING        : 2

  - scan_path: 1 hardcoded credential(s): src/config.js:14 aws-access-key
  - authentication: POST /webhook has no authentication ...

advisory        : 3
  · tests: ran under node --test — 19 of 19 passed.
  ...
```

Every control line says **how it resolved**, so you can see at a glance that all four actually ran.

---

## Use it in CI

The gate is most valuable where the agent has no vote — a required status check that runs after the
work is finished, on a machine the agent never touched.

```yaml
name: gate
on: [pull_request]

jobs:
  agent-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"

      # Install the scanners the controls drive.
      - run: |
          curl -fsSL -o /tmp/gitleaks.tar.gz \
            https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz
          sudo tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks
          sudo curl -fsSL -o /usr/local/bin/osv-scanner \
            https://github.com/google/osv-scanner/releases/download/v2.4.0/osv-scanner_linux_amd64
          sudo chmod +x /usr/local/bin/osv-scanner
      - uses: hashicorp/setup-terraform@v3
        with: { terraform_version: "1.15.8", terraform_wrapper: false }

      - uses: tjwitko/agent-gate@v1.1.0
        with:
          project: .
          task-file: task.txt
```

Then make it a required check in **Settings → Branches → Branch protection**.

### Action reference

| input | default | description |
|---|---|---|
| `project` | `.` | Directory to validate |
| `task-file` | *(none)* | The task the code was written to satisfy |
| `terraform-guard` | *(auto)* | Override path to a control server |
| `dep-audit` | *(auto)* | " |
| `secret-guard` | *(auto)* | " |
| `identity-guard` | *(auto)* | " |

| output | values |
|---|---|
| `outcome` | `clean` \| `blocked` \| `incomplete` |
| `blocking` | number of blocking findings |
| `result` | path to the machine-readable JSON |

`blocked` and `incomplete` both fail the build, and they are reported distinctly on purpose. Use
`outcome` if you want to treat them differently — for example, retrying an `incomplete` run on a
runner that has the missing scanner, which is never the right response to `blocked`.

See [`docs/ci.md`](docs/ci.md) for a full worked example including a pinned toolchain.

---

## Exit codes

| code | meaning | what to do |
|---|---|---|
| `0` | nothing blocking | ship it |
| `1` | blocking findings | fix them; they are real |
| `2` | usage error | check the arguments |
| `3` | **part of the gate could not run** | fix the environment, then re-run |

**Exit 3 is the one that matters.** It means the project was not fully checked. It is not a pass,
and it is not a normal failure. Treating it as either is the failure mode this project exists to
remove — and it has bitten this codebase twice, which is why the distinction is enforced and tested.

---

## What it checks

Four control servers, each in its own repository and each installed as a dependency:

| control | checks | backed by |
|---|---|---|
| [terraform-guard](https://github.com/tjwitko/terraform-guard-mcp) | Terraform plan, policy, and source scanning | `terraform`, `checkov` |
| [dep-audit](https://github.com/tjwitko/dep-audit-mcp) | dependency vulnerabilities, direct vs transitive | `osv-scanner` |
| [secret-guard](https://github.com/tjwitko/secret-guard-mcp) | hardcoded credentials | `gitleaks` |
| [identity-guard](https://github.com/tjwitko/identity-guard-mcp) | workload identity posture | — |

Plus in-process validators: `build_check`, `tests`, `immutability`, `authentication`,
`manifest_contract`, `k8s_manifest`, `secret_rotation`, `retention`, `iam_contract`,
`artifact_presence`, `code_quality`, `artifact_census`, `uncommitted_work`.

A few are worth calling out because they exist in response to measured failures:

- **`tests` runs the suite.** It does not check that test files exist. A deliverable once shipped a
  jest config, thirteen test cases, and no installed toolchain, and reported "comprehensive test
  coverage". Installed, three of twelve failed — and those three were exactly the acceptance
  criteria.
- **`authentication` judges per route.** A project-level "is there auth here" check passes a project
  that authenticates POST and leaves GET open. One did.
- **`uncommitted_work` blocks.** Work that was never committed was never seen by whatever runs at
  commit time.

---

## Configuration

Controls resolve in this order, and the run reports which rule won:

1. **Environment variable** — `TFGUARD_SERVER`, `DEPAUDIT_SERVER`, `SECRETGUARD_SERVER`, `IDENTITYGUARD_SERVER`
2. **`.agent-gate.json`** in the project being checked
3. **`node_modules`** — the normal case
4. **A sibling checkout** — for developing the controls themselves

```json
{
  "controls": {
    "terraform-guard": "./vendor/terraform-guard-mcp/index.mjs"
  }
}
```

An environment variable or config entry pointing at a file that does not exist is an **error**, not
a reason to fall through to the next rule. Someone said where the control was and was wrong; quietly
using a different one would hide that.

---

## Troubleshooting

**`exit 3` and "a control could not be reached"** — a control server did not resolve. The message
names which one and what to set. Usually the install did not complete, or an override points
somewhere stale.

**`exit 3` and "COULD NOT RUN"** — a scanner is missing from `PATH`. The message names the binary.
Install it and re-run; the verdict before it was installed proves nothing about your code.

**`check_dependencies` findings that look wrong** — if the project has no lockfile, `osv-scanner`
resolves the dependency graph to minimum-satisfying versions that no real install produces. Those
findings are reported as advisory rather than blocking, and the message says so. Commit a lockfile
to make the result authoritative.

**Terraform findings about credentials** — a plan needs to authenticate to your cloud provider. With
no credentials the plan-based rules cannot run, and the gate says the configuration is UNSCANNED
rather than clean. The credential-free source scan still runs.

---

## Development

```bash
git clone https://github.com/tjwitko/agent-gate
cd agent-gate
npm install
npm test          # unit tests
npm run corpus    # regression corpus — thirteen frozen projects
```

The corpus is the important one. **Every control defect in this project's history was found by
running real work through the controls, never by a unit test.** `npm run corpus` re-measures
thirteen frozen projects and fails on drift in either direction, because a control that stops
firing is as much a regression as one that starts over-firing.

Eleven are real deliverables, frozen with the verdict each one scored. The other two exist to cover
shapes the graded set does not have — a plain Node library with no infrastructure, and a Python
service — because a corpus in which every fixture was a Terraform-bearing webhook receiver could
not see a check that fires on projects which never asked for what it checks. Adding them found a
live false positive in a blocking validator the same afternoon.

It also records the toolchain that measured it and reports any difference, since a finding count
compared against a different scanner version looks exactly like a control that changed behaviour.

---

## Why this exists

The design comes from a measured experiment: the same task run fifteen times across models, graded
by one frozen gate. The short version:

- Twelve runs by a smaller model produced **zero** passes; three frontier-model runs passed on the
  first attempt.
- A control run with the gate available but **unmentioned in the prompt** consulted it zero times
  and finished with six blocking findings. The model did not route around the gate; it never
  reached it.
- Delivering the rules through a file the agent was expected to read worked **two times out of
  four**.

A mechanism that works half the time is a hint, not a control. That is the whole argument for
putting this in CI rather than in a prompt.

Full write-up: [`docs/haiku-experiment.md`](docs/haiku-experiment.md).

---

## Also in this repository

An MCP server for delegating mechanical subtasks to a locally-hosted model, which this project grew
out of. It is independent of the gate and documented in [`CLAUDE.md`](CLAUDE.md).

## License

[Apache License 2.0](LICENSE) © 2026 Tom Witkowski
