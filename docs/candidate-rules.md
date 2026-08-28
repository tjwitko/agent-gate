# Gate defects and candidate checks

A running list for the agent-loop validators in `agent/`. Companion to
`terraform-guard-mcp/docs/candidate-rules.md`, which tracks the opposite problem — Terraform
findings that are advisory and arguably should block. This file tracks the gates themselves:
where they are wrong, and what they don't check yet.

Almost everything here is found the same way — by **grading a deliverable through execution** and
comparing what the run actually does against what the gate said about it. Reading the code has not
once surfaced one of these; running it has surfaced all of them.

## The recurring shape

Every gate defect found so far is the same mistake wearing different clothes: **a hardcoded list of
spellings standing in for a test of shape.** The list is drawn from whatever the last benchmark
happened to produce, so the next project's ordinary idiom reads as a violation.

| gate | list that was wrong | what broke it | direction |
|---|---|---|---|
| immutability | `ConditionExpression =` | TypeScript writes `:` | false positive |
| authentication (JS) | handlers resolved by identifier | inline arrow handlers | false positive |
| authentication (Py) | six credential header names | `x_internal_token` | false positive |
| vacuous credentials | `os.getenv` only | TypeScript `process.env` | false negative |

Three of four are false positives, which is the direction that gets a gate switched off. The fix is
the same each time: test the shape, not the spelling.

---

## Resolved

### Python credential headers were a fixed list of six names

`PY_AUTH_HEADER_PARAM` matched only
`x_api_key|api_key|authorization|x_auth_token|access_token|bearer`. webhook-5 guarded its support
endpoint with `x_internal_token: str = Header(None)` and a 403 on mismatch; the gate reported it as
"accepting requests from anyone who can reach the service".

The finding was **right for the wrong reason**, which is the most dangerous way to be right: that
endpoint is indeed broken, but in the opposite direction — a bug returns 403 to *everyone*,
including support. Anyone acting on the gate's stated reason would have gone looking for a missing
auth check that was already there.

Fixed by matching the credential-ish word a parameter name contains (`api_key`, `token`, `secret`,
`credential`, `authorization`) rather than enumerating spellings.

**Widening the names required tightening something else.** Declaring a credential parameter is not
checking it, and this codebase's own rule is that a gate which *invents* protection is worse than
one that misses it. So a credential header now only counts when the handler both references the
parameter and has a rejection path — mirroring the corroboration the signature branch already
required via `verifiesSignature()`. That tightening caught two existing tests whose fixtures were
`def add(x_api_key: str = Header(...)): pass` — a handler ignoring its own credential, which the
old gate passed.

Signature headers are deliberately excluded from the credential words: a machine sender proves
identity by signing, and that path must keep demanding proof that something verifies the signature.

---

## Open

### 1. Health endpoint is never wired to a probe

The task asks for "a health endpoint for the load balancer". webhook-5 exposes `GET /health`
returning 200 and declares **no** `livenessProbe` or `readinessProbe`, so nothing consumes it.

Measured consequence, not a hypothetical: with `SECRET_ID` unset, `/health` returned 200 while every
webhook returned 500. A load balancer would have kept routing to a pod that recorded nothing. The
manifest contract check catches the missing variable; nothing catches the unwired probe.

**Shape to test, not spelling:** a container exposing an HTTP health path with no probe referencing
it. Beware the inverse false positive — probes are legitimately absent for Jobs and CronJobs.

### 2. Timing-unsafe comparison for non-signature credentials

`leakySignatureCheck` covers signature comparison only. webhook-5 compares its support token with
`x_internal_token != internal_token` — an ordinary `!=`, byte-short-circuiting, on a bearer-style
secret an attacker can retry freely.

The reason it is not simply an extension of the existing check is recorded in `authentication.mjs`:
`timingSafeEqual` on its own is how *any* secret should be compared, so accepting it as evidence of
a *signature* would label a key check as signature verification. The verdict would be the same; the
reason given to the reader would be wrong. A separate finding, sharing the comparison logic.

### 3. Retention is never verified against the stated period

The task says "records are retained for seven years". Nothing checks that any configured retention
matches the requirement. webhook-5 got this right (Object Lock COMPLIANCE, 2555 days) and so did
webhook-1 — but by inspection, not because anything verified it.

Harder than it looks, and the reason it is still open: the period lives in the task text, so this
needs the requirement parsed out and compared against a plan value, which is a different kind of
check from everything else here. A version that assumed seven years universally would be
benchmark-hardcoding of exactly the kind this file exists to catch.
