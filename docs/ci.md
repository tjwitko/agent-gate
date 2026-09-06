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
