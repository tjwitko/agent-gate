# agent-gate

[![gate](https://github.com/tjwitko/agent-gate/actions/workflows/gate.yml/badge.svg)](https://github.com/tjwitko/agent-gate/actions/workflows/gate.yml)
[![release](https://img.shields.io/github/v/release/tjwitko/agent-gate)](https://github.com/tjwitko/agent-gate/releases/latest)
[![license](https://img.shields.io/github/license/tjwitko/agent-gate)](LICENSE)

Run a set of security and completeness controls against a project directory and get back one
verdict: **clean**, **blocked**, or **could-not-run**.

It is built for code that an AI agent wrote. Agents produce plausible work quickly, and the usual
review signals — it builds, there are tests, the summary says "production-ready" — stop being
reliable. agent-gate checks the things that plausible-looking work gets wrong: infrastructure that
plans clean but is open to the world, dependencies with known CVEs — or with no lockfile, so nothing
scanned them — credentials hardcoded into source, request data reaching a shell or a SQL query,
endpoints with no authentication, container base images past end of life, and test suites that do
not run. Where the task states a requirement — tests, secret rotation, a retention period — the code
is held to it, and the code's author cannot quietly edit the requirement away.

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
  brew install terraform gitleaks osv-scanner semgrep   # macOS
  pipx install checkov ruff
  python3 -m pip install pytest      # only if your project has a Python test suite
  ```

  | tool | needed for | required? |
  |---|---|---|
  | `gitleaks` | credential scanning | yes |
  | `osv-scanner` | dependency vulnerabilities | yes |
  | `terraform` | Terraform plan and policy checks | if the project has `.tf` files |
  | `semgrep` | injection checks (`sast`) | if the project has Python, JavaScript/TypeScript, Go, Java, Ruby, C#, Rust, C or C++ |
  | `checkov` | extra Terraform and Dockerfile coverage | optional, advisory only |
  | `ruff` | Python static checks | if the project has Python |
  | `pytest` | running a Python test suite | if the project has Python tests |
  | `docker`, `go` | Go build and test | if the project has Go |

  A missing tool is **never** silently skipped. The run reports it and exits 3.

`pytest` is installed with `pip` rather than `pipx` on purpose: the gate runs a Python suite
with `python3 -m pytest`, so the module has to be importable by that interpreter. A console
script on `PATH` is a different fact and will not satisfy it.

### Install

Latest release: **[v1.1.16](https://github.com/tjwitko/agent-gate/releases/latest)**

```bash
npm install --save-dev github:tjwitko/agent-gate#v1.1.16
```

The four control servers come with it as dependencies — there is nothing else to clone or wire up.
They are pinned to specific release tags, so this installs the same five components every time;
`./node_modules/.bin/agent-gate --version` shows which.
Drop the `#v1.1.16` to track `main` instead, which moves.

### Run it

```bash
./node_modules/.bin/agent-gate .
```

Point it at any directory. To get the most out of it, pass the task the code was written to satisfy:

```bash
./node_modules/.bin/agent-gate . task.txt
```

**Not `npx agent-gate`**, which this README recommended up to v1.1.16. The package installs from
GitHub as `@tjwitko/agent-gate`; the unscoped name `agent-gate` is not on npm. Where agent-gate is
not installed, npx looks that name up on the public registry, and when stdin is not a terminal — as
in an agent's shell — npm answers its own install prompt with yes. Measured from a directory without
it: `npx agent-gate .` and `npm exec --no -- agent-gate .` queried the registry and exited 1, the
gate's code for blocking findings, and `npx --no agent-gate --version` printed npm's version and
exited 0. If anyone publishes that name, the same command runs their code. The path makes no request
and exits 127 when nothing is installed. `agent-gate-init --upgrade` moves a project set up by an
earlier version onto it.

Six checks are gated on what the task asked for — immutability, retention, secret rotation, tests,
error distinction, and required artifacts. Without a task file they report "not checked", which is
honest and much less useful.

### What goes in the task file

Prose, not configuration. It is the requirements as you would write them for a person, and the
checks read ordinary English — there are no keys, fields or front matter to fill in.

```text
Build and deploy a service that receives our Slack workspace's message events.

WHAT IT NEEDS TO DO
- Receive message events from Slack as they happen, and keep receiving them across a working week.
- Keep every message event received, so that a question raised weeks later can be settled.

REQUIREMENTS
- Once a message event has been recorded, its contents must stay exactly as received.
- Records are retained for three years.
- Both Slack tokens must be rotatable without redeploying the application.

HOW WE WILL JUDGE IT
- Automated tests that someone else can run, covering an event being acknowledged.
- Errors distinguished from faults: Slack refusing our token is not our service failing.

DEPLOYMENT
- AWS, single region. Terraform for all infrastructure. Kubernetes manifests. A Dockerfile.
```

Each gated check is looking for the shape of a requirement, not a topic:

| check | switched on by | stays off for |
| --- | --- | --- |
| immutability | "must not change once written", "an immutable audit log" | "store the events" |
| retention | "retained for three years", "keep every event for 90 days" | a period with no number |
| secret rotation | "the API key must be rotated every 90 days", "tokens must be rotatable" | "use an API key" |
| tests | "automated tests that someone else can run", "include unit tests" | "make it work" |
| error distinction | "a client error must not be reported as a 500" | "handle errors" |
| required artifacts | naming them: "Terraform", "Kubernetes manifests", "a Dockerfile" | "deploy it somehow" |

Two rules follow from that:

**State the requirement, don't gesture at the topic.** The retention check compares a configured
period against the one the task states, so it needs a number to compare against; "keep the records"
gives it nothing and the check stays off.

**Never write a requirement you don't have.** A fabricated one switches a check on and then reports
against a standard nobody asked for, which is worse than the check being off. The parsers are built
to resist it from their side too: "Keep the log short; rotate it every 7 days" once produced a
seven-day retention requirement, and the span a phrase may cross now stops at a semicolon so it no
longer does. That is the direction of the whole design — a check that stays quiet costs you a
finding, and a check that fires on a requirement nobody stated costs you working code.

**The gate says which sentences it read.** Every run counts the task's sentences and how many
switched a check on — `task sentences : 18, 9 read by a check, 9 by none` for the webhook task — and
`--json` lists the unread ones with their line numbers, under `requirementsRead`. Most are
requirements no check could hold code to ("accept HTTP callbacks at a public endpoint"); one you
expected a check to read is a phrasing to fix.

**Put each requirement in one sentence.** The checks read a sentence at a time, so "The signing
secret is kept in Secrets Manager. It must be rotated every 90 days." does not switch rotation on:
"it" is in a different sentence from the secret. "The signing secret must be rotated every 90
days." does. A line indented under a list item continues that item, so hard-wrapping is safe; any
other line break ends a thought.

If a check reports "not checked" and you expected it to run, the task text is where to look. The
four control repositories each keep one of these at `.github/gate-task.txt` if you want a smaller
worked example: they state tests and error distinction, and deliberately state nothing about
retention or immutability, because they store no records.

#### Requirements the code's author cannot remove

The task file usually lives in the repository it describes, so whoever writes the code can edit the
requirement the code is checked against. An agent blocked by "tokens must be rotatable" could delete
the sentence and commit. Two things stop that from being quiet:

- **At commit time**, a commit that changes or deletes a tracked task file is blocked, and the code is
  checked against the requirements as they were. The gate reads the version being committed, not the
  file on disk, so an unstaged edit does not loosen it either. Adding a task file is not changing
  one, so a project's first commit is unaffected. To change a requirement on purpose, commit it on its
  own: `git commit --no-verify -- task.txt`.
- **A baseline**, for requirements no project gets to opt out of: `--baseline=<file>` on the command
  line, or the Action's `baseline` input. Its sentences are added to the task text, so they switch on
  the same checks. It only does its job if it lives somewhere the code's author cannot edit — a
  baseline inside the project is reported as such. A baseline sentence that no check reads is printed
  with `!!` above the verdict, in the CLI and the Action's log alike: it is a requirement the project
  is not being held to, and whoever wrote the baseline is not the person reading the task file.

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

## Set it up

```bash
./node_modules/.bin/agent-gate-init --new my-project --hook --task task.txt   # a new project
./node_modules/.bin/agent-gate-init --hook --task task.txt                    # an existing one
```

Both do the same three things, and the second is the first without `--new`:

| | |
| --- | --- |
| `.mcp.json` | the four controls, with absolute entry points and the project as their scan root |
| `AGENTS.md` | the gate stanza, with `{{VALIDATE_COMMAND}}` filled in |
| `.git/hooks/pre-commit` | with `--hook`: runs the gate and blocks the commit unless it exits 0 |

**Nothing is overwritten.** An existing `.mcp.json` is merged into, not replaced — your own servers
survive, and a control you have already defined yourself is left as you defined it. An `AGENTS.md`
is appended to between markers, so a second run changes nothing. An existing pre-commit hook is
reported and left alone. `--force mcp|agents|hook` says otherwise, per file.

It exits **1** when it left something alone, so a script can tell "set up" from "already had one".

After upgrading the package, `agent-gate-init --upgrade` refreshes what it wrote — see [Upgrading](#upgrading).

### The pre-commit hook

```
git commit  ->  agent-gate . task.txt --pre-commit  ->  0 commit proceeds
                                                        1 findings                                                              2 usage          > blocked
                                                        3 could not run  /
```

**Exit 3 blocks.** A commit that nothing checked must not be easier to land than one that failed a
check. For the same reason the hook fails closed: if `agent-gate` is not installed it blocks with
exit 3 rather than waving the commit through, because a hook that passes when it could not run
leaves a repository that looks protected and is not. (Up to v1.1.16 the hook's check for this tested
for `npx`, which is always there, so in a clone without `node_modules` it went on to the public
registry and exited 1 — blocked, but reported as findings. `--upgrade` replaces it.)

`git commit --no-verify` is the deliberate way past, and unlike quietly deleting the hook it is
visible afterwards.

`--pre-commit` turns off exactly one check, `uncommitted_work`, and says so in the output. In a hook
its premise is satisfied by the act that invoked it — the work is uncommitted because it is being
committed. Left on, it fails every commit forever, which teaches people to bypass the hook and costs
you the whole thing. The stanza's command keeps that check, because an agent reporting it is done
with work uncommitted has not finished.

If `core.hooksPath` is set, the tool refuses rather than writing a hook into `.git/hooks` that would
never run.

## Use it with a coding agent

This is what the project was built for, and how every graded run in it was produced. The pattern has
two halves, and the split between them is deliberate.

**The four controls are MCP tools.** The agent calls them while it works, for cheap feedback on the
thing it just wrote. Point your client at them:

```json
{
  "mcpServers": {
    "terraform-guard": {
      "command": "node",
      "args": ["node_modules/@tjwitko/terraform-guard-mcp/index.mjs"],
      "env": { "TF_WORKING_ROOT": "/abs/path/to/project" }
    },
    "dep-audit": {
      "command": "node",
      "args": ["node_modules/@tjwitko/dep-audit-mcp/index.mjs"],
      "env": { "SCAN_ROOT": "/abs/path/to/project" }
    },
    "secret-guard": {
      "command": "node",
      "args": ["node_modules/@tjwitko/secret-guard-mcp/index.mjs"],
      "env": { "SCAN_ROOT": "/abs/path/to/project" }
    },
    "identity-guard": {
      "command": "node",
      "args": ["node_modules/@tjwitko/identity-guard-mcp/index.mjs"],
      "env": { "SCAN_ROOT": "/abs/path/to/project" }
    }
  }
}
```

**The gate is a command, not a tool.** The agent runs it and reads the exit code:

```bash
./node_modules/.bin/agent-gate . task.txt
```

**That asymmetry is the whole design.** Across four runs of one task with identical tooling, the
model called `terraform_plan` 3, 1, 4 and 0 times, and never called `check_dependencies` at all. A
tool the model may or may not invoke is not a guardrail. So the controls are available for the
agent's benefit, and the gate runs where the agent cannot route around it — a command in the
transcript, a pre-commit hook, a required check in CI. It spawns the four servers itself, so its
verdict does not depend on which tools the agent chose to call.

### What to put in the agent's instructions

Telling an agent to "run the gate" is not enough; a model that runs it and then describes a refusal
as a pass has satisfied the letter of that. [`templates/AGENTS.md.tmpl`](templates/AGENTS.md.tmpl)
is the stanza these runs used, and each paragraph in it exists because a run did the thing it
forbids. The four that earn their place:

- **A refusal is not a pass.** If a check refuses, errors, or reports that it did not run, it
  produced no evidence. Say so plainly rather than counting it toward "all checks green".
- **Tests are evidence only when they run and reach the code.** A suite that is never executed, or
  that imports nothing from the project, is not evidence — however many assertions it contains.
- **End the summary with what the gate did not establish.** Exit 0 means nothing is blocking. It
  does not mean everything was checked.
- **An opt-out goes where the gate will record it**, as an `identity-guard:allow <rule> <reason>`
  comment on the line, not as prose in a document the gate never reads.

Drop it into your `AGENTS.md`, `CLAUDE.md`, or system prompt, with `{{VALIDATE_COMMAND}}` replaced
by the command above.

### The loop that results

1. The agent builds, calling the MCP tools for feedback as it goes.
2. It runs `./node_modules/.bin/agent-gate . task.txt`.
3. **Exit 1** — blocking findings, each with a remediation. It fixes and repeats.
4. **Exit 3** — part of the gate could not run. Not a pass, and the output names which part.
5. **Exit 0** — nothing is blocking. The agent reports what was *not* established alongside that.

Pass the task file. Six checks are gated on what the task asked for, and without it they report
"not checked" — accurate, and much less useful. See [What goes in the task
file](#what-goes-in-the-task-file).

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

      # Your project's own dependencies. The `tests` check runs your suite, and without these it
      # cannot load its imports and every test file fails.
      - run: npm ci --ignore-scripts

      # Everything the controls drive, at the versions this release was tested with: Terraform,
      # gitleaks, osv-scanner, checkov, ruff and pytest, each checked after install.
      - uses: tjwitko/agent-gate/.github/actions/control-tooling@v1.1.16

      - uses: tjwitko/agent-gate@v1.1.16
        with:
          project: .
          task-file: task.txt
```

Two things in there are easy to leave out, and both fail quietly rather than loudly:

- **`npm ci`** — or your language's equivalent. Without it the gate's `tests` check runs your suite
  against no dependencies and reports every file failing, which reads like broken tests.
- **`control-tooling`**, rather than installing the scanners yourself. It pins them to the versions
  the release was tested with and verifies each one, and it moves when you upgrade the gate. A
  hand-written install stays at whatever you wrote, and a scanner that is missing reports its check
  as not run.

Both `uses:` lines name one repository and should always carry the same tag — see
[Upgrading](#upgrading).

Then make it a required check in **Settings → Branches → Branch protection**.

### Action reference

| input | default | description |
|---|---|---|
| `project` | `.` | Directory to validate |
| `task-file` | *(none)* | The task the code was written to satisfy |
| `baseline` | *(none)* | Requirement sentences the project is held to whatever its task file says — see [Requirements the code's author cannot remove](#requirements-the-codes-author-cannot-remove) |
| `terraform-guard` | *(auto)* | Override path to a control server |
| `dep-audit` | *(auto)* | " |
| `secret-guard` | *(auto)* | " |
| `identity-guard` | *(auto)* | " |

A `baseline` set in a workflow in the same repository is only as protected as that workflow file. For
a requirement every project must meet, set it in a workflow the project cannot edit — one an
organisation ruleset requires, for instance:

```yaml
      - uses: tjwitko/agent-gate@v1.1.16
        with:
          task-file: task.txt
          baseline: |
            Include automated tests that someone else can run.
            A client error must not be reported as a 500.
```

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

## Upgrading

The four controls come **with** the gate — `@tjwitko/agent-gate` pins them — so upgrading the gate
upgrades them. You only upgrade a control separately if you wired it into an editor on its own.

### 1. See what you are on

```text
$ ./node_modules/.bin/agent-gate --version
agent-gate 1.1.16
  terraform-guard  v1.1.2  node_modules @tjwitko/terraform-guard-mcp
  dep-audit        v1.0.2  node_modules @tjwitko/dep-audit-mcp
  secret-guard     v1.0.2  node_modules @tjwitko/secret-guard-mcp
  identity-guard   v1.0.2  node_modules @tjwitko/identity-guard-mcp
tools on PATH
  node             26.5.1
  go               1.27.1
  terraform        1.15.8
  gitleaks         8.30.1
  osv-scanner      2.4.0
  checkov          3.3.10
  python3          3.14.8
  ruff             0.16.2
  semgrep          1.180.0
  pytest           9.1.1
  docker           29.6.2
```

Run it again afterwards. **"The package moved" and "the controls that will run moved" are different
answers**, and only the second one protects anything: v1.1.1 shipped with terraform-guard a release
behind its own fixes, and nothing in the output said so. Every gate run now prints the version of
each control beside where it was found, in the CLI and in the Action's log alike.

The controls are not all that decides a verdict. The scanners they shell out to are the rest: a
semgrep upgrade moves `sast` findings with no agent-gate change, and osv-scanner answers from a live
database, so the same tree and pins can give different dependency findings on different days.
`--version` lists each one on `PATH`, and `not found` for one that is not — a missing scanner switches its checks off.
The `--json` report carries the same list as `toolchain`, and `scannedAt`, the time the run started.

### 2. Move the pin

**GitHub Action** — bump **both** references, which name one repository at one version:

```yaml
- uses: tjwitko/agent-gate/.github/actions/control-tooling@v1.1.16
- uses: tjwitko/agent-gate@v1.1.16
```

A workflow left at two versions runs one release's gate on another's toolchain. It is an easy one to
miss: a search for `agent-gate@` does not match the first line.

**npm:**

```bash
npm install --save-dev github:tjwitko/agent-gate#v1.1.16
```

### 3. Refresh what setup wrote

```bash
./node_modules/.bin/agent-gate-init --upgrade
```

Upgrading the package does not touch what `agent-gate-init` wrote into your project, so without this
a project keeps an older release's stanza and hook indefinitely. `--upgrade` refreshes exactly
those, and nothing it did not write:

| | refreshed when | left alone when |
| --- | --- | --- |
| `AGENTS.md` stanza | it sits between agent-gate's markers | there are no markers, or the end marker is missing |
| pre-commit hook | it carries the `Installed by agent-gate-init` header | anyone else wrote it |
| `.mcp.json` controls | the entry is one agent-gate wrote, or the control is missing | you defined the control yourself |

The task file is read back from what setup wrote, so you do not have to repeat it — and it is not
quietly dropped, which would switch six checks off. Running it twice changes nothing the second
time. It exits **1** if something of agent-gate's own could not be refreshed, and says what.

`--force` would also refresh these, and would also overwrite a hook you wrote. Use `--upgrade`.

### 4. Run the new version before you gate on it

**An upgrade can turn a passing project red, deliberately.** When a release fixes a check that was
passing something it should not have, projects relying on that gap start failing. v1.1.2 did this
for S3 buckets with no public access block of their own; v1.1.4 does it for services whose only
authentication was commented out. Release notes call these out under *expect this to fail*.

So run the new version locally first, read what it finds, and move the CI pin once you have — not
the other way round, where the first you hear of it is a red build on someone else's pull request.

### Keeping current

Dependabot's `github-actions` updater opens a pull request when a new tag is published:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

Check that the pull request moves **both** references before merging it.

### A control wired in on its own

If you run one of the four servers directly from an editor rather than through the gate, upgrade it
by its own tag — `npm install github:tjwitko/secret-guard-mcp#vX`, or `git pull && npm ci` in a
checkout — and then **restart the editor's MCP client**. A client starts each server once per
session, so a running editor keeps serving the old code until it is restarted, and nothing about
the upgrade tells you that.

### Rolling back

Pin the previous tag and run `npm install`. The stanza and hook a newer release wrote keep working
with an older gate, with one exception: **below v1.1.3, remove the pre-commit hook**. It passes
`--pre-commit`, which older releases do not know, so they run the uncommitted-work check inside the
hook — where a commit in progress always has uncommitted work — and block every commit.

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

A gate that crashes exits 3 too, never Node's default 1, and in `--json` mode still writes one
document: `{"exitCode": 3, "incomplete": true, "error": "..."}`. A usage error writes
`{"exitCode": 2, "error": "..."}`.

`agent-gate-init` has its own codes: `0` done, `1` left an existing file alone (reported, and
`--force` overrides), `2` usage error, `70` failed partway — rerun after fixing the cause, since
nothing it writes overwrites.

---

## What it checks

| concern | blocks on | reports, without blocking | covers |
|---|---|---|---|
| secrets | credentials hardcoded in any file; a credential-named value assembled from literals (split, joined, base64- or hex-encoded) | — | every file; assembly in Python, JavaScript/TypeScript, Go, Java, Ruby, C#, Rust |
| dependencies | high or critical CVEs; a manifest that declares dependencies with no lockfile the scanner can read | CVEs in an unlocked `requirements.txt`, `go.mod` or `pom.xml` | npm, PyPI, Go, Maven, Cargo, RubyGems, Packagist and the rest of [OSV](https://osv.dev) |
| injection | request data reaching a shell, a SQL statement, an evaluator, an outbound request's host (SSRF), a file path (path traversal) or a C format string; any use of `gets()` | a query or command built from a value of unknown origin; a non-literal C format string; an XML parser that resolves external entities (XXE) | Python, JavaScript/TypeScript, Go, Java, Ruby, C#, Rust, C, C++ — Flask, Django, FastAPI, Express, `net/http`, gin, Spring, servlets, Rails, Sinatra, ASP.NET Core, axum, actix-web; in C, CGI and sockets, and cpp-httplib, Crow, Drogon |
| authentication | routes anyone can call; a credential compared with `==` or accepted when unset | routes exempt by name, each listed | Python, JavaScript/TypeScript, Go, Java, Ruby |
| infrastructure | Terraform plan and policy violations; IAM, IRSA and Kubernetes manifests that contradict the code; workloads authenticating with held credentials | checkov's findings on Terraform for any cloud, CloudFormation, ARM and Bicep | blocking: Terraform (AWS), Kubernetes YAML; advisory: also CloudFormation, ARM, Bicep |
| containers | a base image past end of life, in any build stage | checkov's Dockerfile rules — `USER`, `HEALTHCHECK` | official `node`, `python`, `golang`, `ruby`, `php`, `debian`, `ubuntu`, `alpine`, `eclipse-temurin` images |
| build | syntax errors, undefined names, a Go build that fails | — | Python, JavaScript, Go |
| task requirements | tests that fail or do not exist, a store that can be altered, a retention period not met, a secret that cannot rotate, client errors reported as 500s, a named artifact missing — **each only when the task or a [baseline](#requirements-the-codes-author-cannot-remove) states it** | — | tests run under `node --test`, jest, vitest, pytest and `go test`; error distinction in Python |
| process | work not committed; a commit that edits the task file | — | — |

A check that could not run — a scanner missing, a control unreachable — makes the whole run exit 3,
never a pass. Code in a language nothing reads is named above the verdict.

The checks live in four control servers, each in its own repository and each installed as a
dependency:

| control | checks | backed by |
|---|---|---|
| [terraform-guard](https://github.com/tjwitko/terraform-guard-mcp) | Terraform plan, policy, and source scanning | `terraform`, `checkov` |
| [dep-audit](https://github.com/tjwitko/dep-audit-mcp) | dependency vulnerabilities, direct vs transitive | `osv-scanner` |
| [secret-guard](https://github.com/tjwitko/secret-guard-mcp) | hardcoded credentials | `gitleaks` |
| [identity-guard](https://github.com/tjwitko/identity-guard-mcp) | workload identity posture | — |

Plus in-process validators: `build_check`, `tests`, `immutability`, `authentication`,
`manifest_contract`, `k8s_manifest`, `secret_rotation`, `retention`, `iam_contract`,
`artifact_presence`, `dockerfile`, `sast`, `code_quality`, `artifact_census`, `uncommitted_work`.

A few are worth calling out because they exist in response to measured failures:

- **`tests` runs the suite.** It does not check that test files exist. A deliverable once shipped a
  jest config, thirteen test cases, and no installed toolchain, and reported "comprehensive test
  coverage". Installed, three of twelve failed — and those three were exactly the acceptance
  criteria.
- **`authentication` judges per route.** A project-level "is there auth here" check passes a project
  that authenticates POST and leaves GET open. One did.
- **`uncommitted_work` blocks.** Work that was never committed was never seen by whatever runs at
  commit time.
- **`dockerfile` reads the Dockerfile.** It blocks on a base image whose release is past end of life
  — `FROM node:14` passed until it existed, because the only check confirmed the file was there. The
  dates come from [endoflife.date](https://endoflife.date), for the official `node`, `python`,
  `golang`, `ruby`, `php`, `debian`, `ubuntu`, `alpine` and `eclipse-temurin` images, and the OS
  named in a language image's tag (`-buster`, `-alpine3.18`) is judged too. checkov's Dockerfile
  rules — no `USER`, no `HEALTHCHECK` — are reported as advisories.
- **`sast` blocks on injection** — request data reaching a shell, a SQL statement, `eval`, the host
  of an outbound request (SSRF) or a file path (path traversal), in Python, JavaScript/TypeScript, Go,
  Java, Ruby, C#, Rust, C and C++. A URL whose scheme and host are fixed in the code, with request data only in the
  path, is not SSRF and is not reported. It runs Semgrep with this project's own rules, and only the
  ones that trace data from an HTTP request to the dangerous call block. The [calibration
  corpus](#development) holds them to two answers at pinned commits. Across sixteen real
  applications, about 26,700 files in every language the rules cover except C++, they block twice:
  Jellyfin's admin endpoint that writes a file where the request says, which is what the rule
  describes. And they find the documented vulnerabilities in the deliberately vulnerable WebGoat (3),
  RailsGoat (6), Juice Shop (11), PyGoat (8) and dvcsharp-api (2). Code that builds a query or a shell
  command from a value of unknown origin is an advisory. Neither `.semgrepignore` nor an inline
  `# nosemgrep` hides code from it.
  In Python it also catches a broad `except Exception` that turns the handler's own 400 into a 500 —
  blocking when the task asks for error distinction — and exception text sent back to the caller.

---

## What it does not check

Listed so that a clean verdict is read for what it is.

- **Languages outside the table.** PHP, Kotlin, Swift, Scala and the rest get the project-wide scans —
  secrets, dependencies, infrastructure — and nothing that reads the code itself. The run says so above
  the verdict.
- **Injection across a function call.** Request data is followed within one function; Semgrep's
  open-source analysis does not cross calls. A helper that builds a query from its argument is reported
  as an advisory, not a finding: SQL text built from a value is reported where it is built, whichever
  function later runs it. A shell command built that way is reported only where it is run.
- **Other classes of injection.** Shell, SQL, evaluators, SSRF and path traversal are covered, and
  an XML parser configured to resolve external entities is an advisory. Cross-site scripting is not:
  templates escape by default, so what is worth checking is the escape hatches (`|safe`, `Markup()`,
  `dangerouslySetInnerHTML`, `html_safe`), and that is not written yet. Neither is server-side
  template injection, LDAP injection, open redirect or insecure deserialization.
- **Memory safety in C and C++.** Beyond `gets()`, buffer overflows, use-after-free and integer
  overflow are not checked: the patterns that find them flag most C code, and a check that blocks most
  projects gets switched off. A sanitiser build (`-fsanitize=address`) and a fuzzer find them better.
- **Proof that the Go, Rust, C and C++ rules find injection in real code.** They are tested on
  annotated samples and on real projects with none, which shows they do not over-fire; no
  deliberately vulnerable application in those languages is in the calibration corpus, so nothing
  shows they catch a real one. C++ has no real application in it at all.
- **Request data in a C buffer, used in another function.** Free Semgrep does not follow taint into a
  buffer, so a write into one is reported only when the same function passes it to the dangerous call.
- **Rocket, Warp and other Rust frameworks**, and ASP.NET WebForms. Their request types are not yet
  named as sources.
- **Authorisation.** `authentication` checks that a route requires a caller identity, not what that
  caller may then do.
- **The built image.** A Dockerfile's base image is judged; the packages inside a built image are not
  scanned. That needs a build or a pull, so it is a job for a CI step with Trivy or Grype.
- **Secrets assembled at run time.** gitleaks reads literals, including credentials that only look
  random, and a credential-named value assembled from literals — split, joined, reversed, base64- or
  hex-encoded — is caught too. A key built by a loop, fetched from somewhere unsafe, or held under a
  name that does not say what it is, is not seen.
- **Blocking infrastructure policy beyond Terraform on AWS and Kubernetes.** Terraform for Azure and
  GCP, CloudFormation, ARM and Bicep get checkov's findings as advisories; none of them can block.
  Pulumi programs are not read as infrastructure at all.
- **Requirements nobody stated.** The task-gated checks run only when the task or a baseline states
  the requirement. Without either they report "not checked", which is accurate and much less useful.
- **A commit made with `--no-verify`.** The hook is a convenience. CI with the gate as a required check
  is the enforcement point; see [Use it in CI](#use-it-in-ci).

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

**"builds on a base image past end of life"** — the release in a `FROM` line no longer gets security
fixes. The finding names the line, the date it ended and the supported releases. Every stage counts:
a build stage on an unsupported compiler ships its unpatched standard library in the binary. Floating
tags (`node:lts`, `python:3`) and other publishers' images (`bitnami/node`) are not judged; the
dates are refreshed with each release, so a release newer than the table is simply not judged yet.

**`sast: command injection` / `SQL injection` / `code injection`** — data from an HTTP request reaches
a shell, a SQL statement or an evaluator in the same function. The finding names each line and the
fix. The check follows data within a function, not across calls, so a request value passed to a helper
that builds the query shows up as an advisory about the helper instead ("built by string formatting…
not blocking").

**"NOT READ" above the verdict** — part of the project is in a language no language-aware check reads
(Rust, PHP, C#, Kotlin, Swift, C/C++, Scala, Elixir, Dart, Lua, Perl, JSX, Vue, Svelte). The
verdict says nothing about that code: only the project-wide scans — secrets, dependencies,
infrastructure — apply to it, and a requirement like "include unit tests" cannot be enforced on it.

**Routes "exempt by name"** — the authentication check leaves probe paths (`/health`, `/ping`,
`/metrics`…) and credential-issuing endpoints (`/login`, `/token`…) open, and lists each one it
skipped. The exemption is by path alone, so check the list: a route with one of those names that
reads input or changes state needs authentication like any other.

**"declare dependencies that no scanner read"** — `osv-scanner` reads lockfiles, and of manifests
only `requirements*.txt`, `go.mod` and `pom.xml`. A `package.json`, `Cargo.toml`, `pyproject.toml`,
`Pipfile`, `build.gradle`, `Gemfile` or `composer.json` that declares dependencies is scanned through
its lockfile or not at all, so without one this blocks: the alternative is reporting a dependency
check that looked at nothing as one that passed. The message names each manifest and the command
that writes its lockfile. `bun.lockb` does not count — it is binary and the scanner cannot read it;
`bun install --save-text-lockfile` writes `bun.lock`, which it can.

**`check_dependencies` findings that look wrong** — for the three manifests it does read without a
lockfile, `osv-scanner` resolves the dependency graph to minimum-satisfying versions that no real
install produces. Those findings are reported as advisory rather than blocking, and the message says
so. Commit a lockfile to make the result authoritative.

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
npm run calibration   # the sast rules on 22 real apps, cloned at pinned commits — about 75 minutes
node scripts/refresh-eol-data.mjs   # end-of-life dates for the dockerfile check, before a release
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

**The calibration corpus** does the same for the `sast` rules on other people's code. Its manifest,
[`calibration/manifest.json`](calibration/manifest.json), names 22 applications by repository and
full commit SHA, with the count each rule gave each one, blocking and advisory, measured with the
pinned semgrep. `npm run calibration` clones each at that commit, runs the `sast` validator on it —
only that: nothing is built, installed or run — compares, and deletes the clone. A rule that stops
finding WebGoat's SQL injection has broken; one that starts blocking Bitwarden is a false positive on
code people ship. No application's code is copied into this repository. It runs in its own workflow
when the rules or the validator change, and on demand; it is not a required check.

| language | known findings | known clean |
| --- | --- | --- |
| Java | WebGoat | Spring PetClinic, Spring RealWorld |
| Ruby | RailsGoat | rubygems.org, Mastodon |
| JavaScript/TypeScript | Juice Shop | Outline |
| Python | PyGoat | NetBox |
| C# | dvcsharp-api, Jellyfin | eShop, Bitwarden server |
| Go | **none** | Gitea |
| Rust | **none** | Lemmy, Meilisearch |
| C | **none** — Damn Vulnerable C Program's bugs are memory safety, and it correctly scores 0 | curl, git, Redis, nginx |
| C++ | **none** | **none** |

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
