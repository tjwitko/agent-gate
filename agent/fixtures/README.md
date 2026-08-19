# Agent-loop task fixtures

Task files for `agent/agent-loop.mjs --task`. Distinct from `bench/*.json`, which drive the
model-comparison benchmark and carry their own verification config; these are plain prompts.

## `audit-task-py.txt`

The substrate for the audit-log-service experiment — fifteen runs to date, across four models.

**Do not edit it.** Every run from adv9 onward is calibrated against these exact bytes, and
changing a word silently invalidates comparison with all of them. If you want a different task,
add a file; don't revise this one.

It is deliberately underspecified, in the register a person actually writes in — including the
typo in "kubernettes". That is the point: it is a raw human instruction, not a spec, and the
experiment measures what a model does when the requirement ("logs should be immutable and
appropriate protections should be put in place") is stated as an outcome rather than a design.

It lives here because it was lost twice while living only in a scratchpad directory, each time to
a stray shell glob. Both times it was recovered from the `## The requirement the developer was
given` section of a saved advisory request, which embeds it verbatim — a workable fallback, but
not a reason to keep the only copy somewhere temporary.
