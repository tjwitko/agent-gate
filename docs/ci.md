# Wiring the gate as a required check

## Why this and not the other two layers

There are three places the controls can sit. Only one of them enforces anything, and the difference
is not a matter of degree.

**MCP servers do not enforce.** An MCP tool runs when the model chooses to call it. Offered the same
validator across four runs of the same task, one model called it 3, 1, 4 and 0 times, and never
called two of the other tools at all until the prompt named them. A run that called it zero times
produced six blocking findings and a summary describing the work as complete. The servers are useful
— they let a model find problems while it still has the context to fix them — but a control the
model may decline is a suggestion.

**Pre-commit hooks do not enforce either.** `git commit --no-verify` skips them, and so does
committing from anywhere that is not that working copy. They are worth installing; they are not the
boundary.

**A required status check enforces.** It runs server-side after the agent is finished, on a machine
the agent has no access to, against a branch protection rule the agent cannot edit. That is the only
layer where "did the model choose to comply" stops being a question.

A customer who believes the MCP layer is the control has bought the exact failure this project spent
a month removing: a gate that reports green because nobody asked it anything.

## The check

```yaml
- uses: your-org/agent-gate@v1
  with:
    project: .
    task-file: docs/task.md
```

Inputs `terraform-guard`, `dep-audit`, `secret-guard` and `identity-guard` take paths to the guard
servers when they are not resolvable as npm dependencies.

## Three outcomes, not two

| exit | outcome | meaning |
|---|---|---|
| 0 | `clean` | the gate ran in full and found nothing blocking |
| 1 | `blocked` | the gate ran in full and found blocking issues |
| 3 | `incomplete` | **part of the gate could not run** |

Both 1 and 3 fail the build. What must never happen is reporting them identically.

`incomplete` means the project was not fully checked — a control could not be resolved, a server
failed to start, or a server started and its tool was never invoked. The findings that came back are
real, but their absence proves nothing, and "no blocking findings" from an incomplete run is not a
pass. Two failures in this project's history were exactly this confusion: a runner that handed the
validators an empty tool registry and printed `BLOCKING: none`, and a control that connected and was
never asked anything through ten graded runs while a similarly-named check ran beside it.

If your pipeline branches on the result, branch on `outcome`, not on success/failure.

## Branch protection

Settings → Branches → add a rule for your default branch:

- **Require status checks to pass before merging** → select `gate this repository`
- **Require branches to be up to date before merging**
- **Do not allow bypassing the above settings** — including for administrators

The last one matters more than it looks. A required check an administrator can wave through is a
check the person under deadline pressure will wave through, and the agent's output arrives in a pull
request like anyone else's.

## The task file

Six checks are gated on what the task asked for: immutability, retention, secret rotation, tests,
error distinction, and required artifacts. Without a task file they report "not checked" — accurate,
and much less useful. If the work started from a written task, point the action at it.

## What the gate does not establish

It reports what it checked and says plainly what it could not. Read the control list in the log, not
only the verdict. A green build means every control that ran found nothing blocking; it does not
mean every control ran, which is what exit 3 exists to tell you.

## The scanners the controls need

Three of the four guard servers shell out to a binary that `npm ci` does not carry, so a runner
without them reports exit 3 on every project. The composite action at
`.github/actions/control-tooling` installs and then **version-checks** them:

| binary | pinned | needed by |
|---|---|---|
| `terraform` | 1.15.8 | terraform-guard |
| `gitleaks` | 8.30.1 | secret-guard |
| `osv-scanner` | 2.4.0 | dep-audit |
| `checkov` | 3.3.10 | the gate's advisory coverage report |

The versions are pinned to the ones `corpus/manifest.json` was measured with. The corpus compares
finding *counts*, so a newer scanner carrying one extra rule is indistinguishable from a control
that regressed. Bumping one of these is expected to arrive with a re-derived manifest in the same
commit.

The install step verifies rather than trusts, because a missing scanner does not make the gate
quiet — the servers report that they could not run and the gate exits 3 — but it does turn a job
meant to verify behaviour into a job that verifies nothing, twenty minutes later and one level less
obviously.

## Known environmental differences

The corpus passes on all thirteen fixtures on macOS. The differences below were found by running it
on Linux CI and are recorded here rather than suppressed.

**Fixed: `go build` inside a container over a bind-mounted git repository.** `build_check` runs the
Go toolchain in `golang:1.22` with the project bind-mounted. On a Linux runner the mounted tree is
owned by the runner UID while the container runs as root, so git refuses it as dubious ownership
and `go build` fails VCS stamping with `error obtaining VCS status: exit status 128` before it
compiles anything -- reported as the project's build errors. The build now passes `-buildvcs=false`,
which a build check has no use for either way. The image is also pulled as its own step, so the
pull transcript no longer lands inside the error text and "could not obtain the toolchain" is a
different exit status from "the code does not build".

**Fixed: a blocking check that could not run reported code defects.** `build_check` treated a
non-zero exit from `python3 -m py_compile` or `ruff` as evidence about the code, but `spawnSync`
returns `status: null` when the binary is absent, so a machine without `ruff` failed a project
whose code is fine. The Go branch had the mirror-image bug, emitting text that matched no blocking
pattern, so an absent toolchain read as a pass. Both now report `COULD NOT RUN`, which is neither a
finding nor a pass and routes to the same exit-3 path as an unreachable control.

**Open: `check_dependencies` finds less on CI.** Two fixtures (`webhook-haiku-2`,
`webhook-haiku-6`) score one blocking dependency finding locally and none on CI. Run directly
against the same vendored fixtures, `osv-scanner` reports 10 and 48 vulnerabilities locally. The
cause is not established. One candidate worth checking first: `dep-audit-mcp` parses
`JSON.parse(scan.stdout || "{}")` and only errors when there is no parseable JSON at all, so a scan
that ran but could not reach the vulnerability database would report zero findings without
reporting a problem -- which would be the silent pass this control set exists to remove, in the
control set itself.

**Fixed: the manifest recorded when it was measured, not with what.** `corpus/manifest.json` now
carries the toolchain -- node, go, terraform, gitleaks, osv-scanner, checkov, python3, ruff, docker
-- and a checking run reports any difference from it before printing a verdict. A `null` is the
informative value: it means the corpus was derived somewhere that could not run that language's
checks at all.

That gap hid a real defect. Three Go deliverables (`webhook-haiku-6`, `-7`, `-8`) carried a clean
`tests` verdict recorded on a machine with no Go toolchain. Their suites had never compiled --
unused imports and unused variables are compile errors in Go -- and only a run on a machine that
had Go could see it. The check behaved correctly throughout: it reported NOT EXECUTED as an
advisory. The corpus froze the non-answer as the answer.

Two changes close it. A check prevented from measuring anything -- absent toolchain, a runner that
will not start, a suite killed on a timeout, or a check that crashed -- now reports `COULD NOT RUN`
and makes the run incomplete, without blaming the project. And `--update` refuses to freeze an
incomplete run: it keeps the previous expectations, marks the entry `unmeasured`, and exits 3. A
checking run reports such entries and compares nothing for them, because matching an expectation
nobody measured confirms nothing.
