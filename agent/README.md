# agent/

A tool-calling loop that lets a **local** model drive MCP servers, so it can write a project and
validate its own work.

## Why this exists

`delegate_to_local_model` makes a single completion call with no tool loop. A model driven through
it can never reach an MCP server — the servers are tools for whoever *calls* the delegation tool,
not for the model on the other side of it. This closes that gap by playing the role VS Code
Copilot Chat plays: hold the MCP connections, advertise their tools to the model, execute whatever
calls it emits, feed results back, repeat.

Gemma 4 12B was verified to handle the full OpenAI tool-calling round trip through llama-server —
emitting a well-formed call, consuming the result, and continuing — so this is not theoretical.

## Usage

```bash
node agent/agent-loop.mjs --model <router-alias> --project <dir> --task <file>
```

Options:
- `--max-turns <n>` — give up after this many model turns (default 40)
- `--max-tokens <n>` — per-turn completion budget (default 4000)
- `--web-search` — additionally expose the SearXNG-backed search server (off by default, see below)
- `--max-validation-rounds <n>` — how many times the gate will hand failures back (default 3)

## The validation gate

**The model saying DONE is a request, not the exit condition.** When it tries to finish, the
harness runs every validator that applies to what is on disk — `build_check`, `terraform_plan` for
each directory containing `.tf` files, `check_dependencies` if a manifest exists — regardless of
whether the model ever called them. Failures go back as work to do, and the run only ends when
validation passes or the round cap is hit.

This exists because tool availability turned out not to produce tool use (see below). Note the gate
is on validators *passing*, not on tools having been *called*: a model can invoke a validator,
receive errors, and finish anyway — which is precisely what happened in one run.

Two deliberate limits:

- **Rounds are capped**, because iteration is not risk-free. A model that cannot converge starts
  deleting working code to satisfy the validator; one run silently dropped the S3 bucket and Object
  Lock configuration the project existed for while chasing an unrelated error. Stopping and
  reporting honestly beats thrashing.
- **A Terraform credentials failure does not count as a validation failure.** It means the security
  rules could not run — an unscanned result rather than a passing one — but it is an environment
  limitation the model cannot fix by editing code. Schema errors and violations are its problem;
  missing cloud credentials are not.

The final verdict is always recomputed against the files as they finally stand, never reused from
an earlier round, and lands in `agent-run-report.json` as `validationPassed`.

Server paths resolve relative to this repo, expecting `terraform-guard-mcp`, `dep-audit-mcp` and
`local-copilot-stack` as siblings. Override any of them with `TFGUARD_SERVER`, `DEPAUDIT_SERVER`,
`WEBSEARCH_SERVER`. A server whose entry point is missing is skipped with a warning rather than
taking the run down.

Output: files land in `--project`, plus `agent-run-report.json` with token usage and every tool
call made.

## Tools the model gets

| Tool | Source | Purpose |
|---|---|---|
| `write_file`, `read_file`, `list_files` | local | produce and review the project |
| `build_check` | local | compile/syntax-check; detects Python, JavaScript and Go from the files present |
| `terraform_plan` | terraform-guard-mcp | validate and security-scan Terraform |
| `check_dependencies` | dep-audit-mcp | scan dependency manifests |
| `web_search` | local-copilot-stack | opt-in, see below |

`terraform_apply` is withheld deliberately — nothing here should be able to mutate real
infrastructure. `local-delegate` is never exposed either: a local model delegating to a local model
is circular.

`build_check` detects the language from the files actually present rather than being configured,
because which language the model picks is not under your control — three runs of the same prompt
produced Node, Python and Go. For Python it runs two passes: `py_compile` for syntax, then `ruff`'s
F rules for undefined names and bad imports. The second pass is the one that matters; a run shipped
code where syntax was valid and an undefined name was the actual defect.

## What was learned running this

Measured across four runs of the same task against Gemma 4 12B:

- **Tool availability is not tool use.** Invocation counts swung wildly with identical tooling —
  `terraform_plan` was called 3, 1, 4 and 0 times across four runs. `web_search` and
  `check_dependencies` went completely unused in every run where they were offered. `build_check`
  is the only tool called reliably, and it caught real errors both times it ran.
- **A tool the model may or may not call is not a guardrail.** The reliable version is running
  validation in the harness after each write, rather than hoping the model asks.
- **Feedback loops can regress the work.** In one run the model hit a validation error, rewrote
  its Terraform three times chasing it, and silently deleted the S3 bucket and Object Lock
  configuration the whole project existed for. Every individual response looked like a reasonable
  fix. That failure is what prompted the deleted-resource detection now in terraform-guard-mcp.
- **Bad tool errors cause bad model behaviour.** A stale-`.terraform` bug in terraform-guard-mcp
  produced an error that looked like the model's fault, and the model burned two destructive
  rewrites chasing a problem the tooling had invented.

## Web search is opt-in

This repo's `CLAUDE.md` argues against giving a local model live fetch access: it has no
instruction-hierarchy training, so fetched pages become an injection surface. That reasoning was
written about poisoning a `context_file` during delegation and applies less directly to a
standalone agent whose output gets reviewed before it goes anywhere — but the injection surface is
real either way, so it stays something you turn on deliberately with `--web-search`.

Empirically it also earned its default: the model never called it in three consecutive runs where
it was available, which matches the same doc's other prediction — a local model has no reliable
sense of when its own knowledge is stale, so it does not know when to look something up.
