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
| secret rotation (first cut) | `get_secret(` as a fetch | an ordinary helper of that name | false positive |
| credential timing (first cut) | file-wide "compares in constant time" | one correct comparison beside one wrong one | false negative |

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

## Resolved (second pass — the webhook-5 misses)

webhook-5 passed every gate it reached and graded D. These are the checks written afterwards, each
against a defect confirmed by executing that deliverable.

### Kubernetes manifests that parse but are not valid Kubernetes — `k8s-manifest.mjs`

Three findings, all blocking, all previously invisible because the YAML is well-formed and each
file reads correctly on its own:

- **A container field on the PodSpec.** webhook-5 put `resources` on the pod spec. PodSpec has no
  such field, so the API server rejects the object — the Deployment does not deploy at all, rather
  than merely missing its limits.
- **`${...}` interpolation.** Kubernetes substitutes `$(VAR)` in container env and command, and
  nothing else. webhook-5 shipped `arn:aws:iam::${var.account_id}:role/...` as the IRSA annotation
  on both the ServiceAccount and the pod template, so the role binding could never resolve. The
  same defect turned out to be in webhook-1, which nobody had noticed.
- **A health endpoint with no probe wired to it** (was open item 1). Gated on the app actually
  exposing a health path, so it has a target rather than nagging; Jobs and CronJobs are exempt,
  since a batch task that exits is supposed to have no readiness probe.

### A secret cached forever under a stated rotation requirement — `secret-rotation.mjs`

Gated on the task saying the secret rotates, exactly as the immutability check is gated on the task
saying immutability: caching a secret is ordinary and correct when nothing rotates it.

**The first cut of this check was a false positive**, and it is worth keeping the reason. It matched
a bare `get_secret(` — an ordinary user-defined helper name — and accepted any nearby `if not X:` as
a cache guard. It fired on webhook-4, whose helper fetches fresh on *every* request: the one shape
that rotates correctly. Fixed by matching only real managed-store APIs, and by requiring the guard's
identifier to be the same identifier assigned near the fetch. A conditional guarding something else
is not evidence of a cache.

### Timing-unsafe comparison of a non-signature credential — `authentication.mjs` (was open item 2)

`leakySignatureCheck` covered signatures only. Kept as a separate finding rather than folded in, for
the reason already recorded on `CONSTANT_TIME_COMPARE`: `timingSafeEqual` is how *any* secret should
be compared, so merging them would report a bearer-token check as signature verification — same
verdict, wrong reason.

**The first cut of this one was a false negative**, and the shape is worth remembering. It stood down
whenever the file compared *anything* in constant time. webhook-5 used `hmac.compare_digest` for the
signature and a bare `!=` for the support token, so one correct comparison suppressed the report of
an incorrect one sitting forty lines below it. A constant-time call contains no equality operator,
so a match is evidence on its own and the file-wide gate was never needed.

---

## Open

### 1. A credential compared against a value of the wrong type

The defect that made webhook-5's support endpoint unusable: `get_internal_token()` returned the whole
parsed secret dict rather than the token field, so `x_internal_token != internal_token` compared a
`str` to a `dict` and was unequal for every caller, support included.

Still uncaught, and honestly assessed it is the hardest of the set — it is a type error in a
dynamically typed language, visible to `mypy` with annotations the model did not write, and invisible
to any pattern this file's checks use. The timing check now flags that exact line for a *different*
reason, which means the line gets attention, but nothing states the real defect.

**Worth noting the asymmetry:** the gate previously called this endpoint "open to anyone" when it was
closed to everyone. Being wrong in the reassuring direction and wrong in the alarming direction are
both wrong, but only one of them sends someone to read the code.

### 2. Retention is never verified against the stated period

The task says "records are retained for seven years". Nothing checks that a configured retention
matches the requirement. webhook-5 got this right (Object Lock COMPLIANCE, 2555 days) and so did
webhook-1 — but by inspection, not because anything verified it.

Harder than it looks, and the reason it is still open: the period lives in the task text, so this
needs the requirement parsed out and compared against a plan value, which is a different kind of
check from everything else here. A version that assumed seven years universally would be
benchmark-hardcoding of exactly the kind this file exists to catch.

### 3. Client errors surfacing as 500

webhook-5 wraps its handler body in `except Exception`, which catches the `HTTPException(400)` it
raises itself and re-raises it as a 500 carrying `"400: Missing event ID"` — leaking the intended
status into the message. A bad request is reported as a server fault, and the detail string exposes
internals to the caller.

Detectable in principle: a broad `except Exception` enclosing a `raise HTTPException`. Not yet built,
and it competes for attention with the two above.
