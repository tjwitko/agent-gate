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
| IRSA annotation (first cut) | a well-formed ARN as the parse gate | `<ROLE_ARN>` placeholders | false negative |
| vacuous credentials | any string default counts as validation | `os.getenv(X, "")` | false negative |
| credential timing | its own word list, not the header check's | `authorization` | false negative |
| immutability (scope) | "any table/bucket" once the task requires it | a Terraform state backend | false positive ×4 |
| every manifest check | reads content, never asks if there is any | five zero-byte YAML files | false negative ×3 |
| advisory parser | only lines starting "- " | a review written as prose | silent discard |

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

### Two IAM defects a clean plan cannot see — `iam-contract.mjs`

Both graded on webhook-6, whose `terraform_plan` the gate had already approved. Neither is a
security hole; both are total failures, and both are invisible for the same structural reason —
Terraform does not resolve these values at plan time, so scanning the plan cannot reach them.

- **Managed-policy ARNs that do not exist.** webhook-6 attached
  `arn:aws:iam::aws:policy/AmazonEBSCSID_Policy` (the real policy is `AmazonEBSCSIDriverPolicy`).
  Terraform does not resolve managed-policy ARNs at plan time, so the plan is clean and
  `terraform apply` fails with `NoSuchEntity` **after** creating some resources.

  **Reported in two tiers on purpose.** AWS publishes well over a thousand managed policies and
  this check carries only the common ones, so an unrecognised name is not evidence of a wrong one.
  A name that prefix-matches a real policy is a near miss and blocks; a merely unrecognised name is
  advisory and says outright that the list is incomplete. Note `AmazonEKS_CNI_Policy` is a real
  policy: "oddly punctuated" is not evidence of anything.

- **An IRSA role no ServiceAccount can assume.** webhook-6's pod role trusted
  `Service = "ec2.amazonaws.com"` — an EC2 instance-profile trust — while a ServiceAccount
  annotated it for IRSA. The pod gets no credentials and every AWS call fails. Same shape as the
  manifest-contract check: the annotation names a real role, the role exists, and the defect is
  only in the gap.

  Re-running it over the older deliverables found the same class in **webhook-5**, which does name
  a `Federated` principal but pairs it with `sts:AssumeRole` instead of
  `sts:AssumeRoleWithWebIdentity` — the right party, the wrong call. That one is why the finding
  names its specific reason: an early version reported it as "no recognisable principal", which
  would have sent a reader looking for something already there.

**Two bugs found while building it, both by running over the six preserved deliverables:**

1. An annotation whose value was `<ROLE_ARN>` was *skipped* rather than reported, because the ARN
   parse was the gate for looking at it at all. webhook-4, whose every annotation is that
   placeholder, read as clean. Silence is not success — an annotation that cannot resolve is the
   finding.
2. Tightening the ARN parse to require a 12-digit account then *lost* webhook-5's trust-policy
   finding, because its `${...}` ARN failed the parse and was deduplicated away before the trust
   check ran. The role name is usable even when the account field is a placeholder, so the two
   judgements are now made independently. A tightening that reports strictly less than before is a
   regression wearing a fix's clothes.

### A remediation that named the settings but not the block

Not a detection defect — a **remediation** defect, and the first of its kind here. The EKS rule
found webhook-7's open control plane correctly and then told it:

> set `endpoint_public_access = false` and reach the API through the VPC with
> `endpoint_private_access = true`

which never says those settings live inside `vpc_config`. The run put both at the top level of the
resource, where neither is a valid argument, and spent its last four turns failing
`terraform validate` instead of fixing anything. webhook-5 and webhook-6 had guessed the placement
right; webhook-7 followed the text literally.

The remediation now leads with placement and shows both options as HCL snippets, and a test pins
that it names the block. **A gate that reports the defect correctly and then misdirects the fix has
not helped.**

**The audit of the rest of the pack found two more, one of which had already cost a run.**

| rule | attribute | lives in | was it said? |
|---|---|---|---|
| `sg-open-ingress-sensitive-port` (inline form) | `cidr_blocks` | `ingress { }` | no — fixed |
| `s3-object-lock-retention-mode-missing` | `mode` | `rule { default_retention { } }` | no — fixed |
| `k8s_manifest` unwired probe | `readinessProbe` | a container entry | no — fixed |
| `imdsv1-allowed` | `http_tokens` | `metadata_options { }` | **yes**, already showed the block |
| `sg-open-ingress` (rule form) | `cidr_ipv4` | top level | correct as written |
| rds, kms, public-access-block, object-lock-enabled | all | top level | correct as written |

The object-lock one is the instructive case: webhook-5 wrote `mode = "COMPLIANCE"` directly under
`aws_s3_bucket_object_lock_configuration` and took three turns to recover. That was recorded at the
time as the model's own nesting mistake. It was the message's.

The probe one is worse in kind — `readinessProbe` is a container field, and `CONTAINER_ONLY_FIELDS`
in the *same module* flags container fields found on a pod spec, so that remediation could have
induced the exact defect its sibling check catches.

`lib/source-scan.mjs` is clean for this failure mode: every one of its remediations acts on a value
already present in place rather than telling the reader to add an attribute somewhere.

A standing test now walks the pack and fails if any rule names a known nested-block attribute
without naming its block, so a new rule that forgets this fails in CI rather than in a benchmark run
four hours later.

### Two lists in one file disagreeing about what a credential is called

webhook-7's support endpoint was recognised as protected *by* an `authorization` header, and then
never checked for how it compares one, because `PY_CREDENTIAL_HEADER_PARAM` knew that word and
`LEAKY_CREDENTIAL_COMPARE` did not. They now share one `CREDENTIAL_WORD` alternation.

Alongside it, `os.getenv("SUPPORT_TEAM_TOKEN", "")` was treated as having a "real default" and
exempted from the vacuous-credential check — the exact defect that check exists to find, since
unset the expected value becomes `"Bearer "`. And the credential sat inside an f-string, so the
"is it compared?" test, which required adjacency to the operator, saw no comparison at all. Three
independent reasons one finding stayed silent, in a file where two of the three were written the
same day.

### Four immutability findings, none about the store the task describes

A Qwen3.5-9B run built a project shape four Gemma runs never had — ten Terraform roots, an S3 state
bucket, a DynamoDB lock table, and SQL DDL inside a Python file — and the immutability check
produced four blocking findings, every one wrong:

| reported | what it actually was |
|---|---|
| in-memory store `params = []` | a local variable inside a query builder |
| s3 bucket `terraform_state` | Terraform's own state bucket |
| dynamodb table `terraform_locks` | Terraform's state lock table |
| relational table `"with"` | the comment `# Create table with immutable constraints` |

The real store, `callbacks`, went unmentioned.

**Two of these were worse than noise.** Object Lock on a state bucket, and an
`attribute_not_exists` condition on every write to a lock table, would each break the system if
followed — the second one prevents exactly the write that locking depends on. A false positive that
merely fails a run wastes time; one that instructs a destructive change is a different category.

Three independent causes:

1. The in-memory regex allowed leading whitespace, so it matched indented locals despite its own
   comment saying "module-level". The corroborating `.append(` test was file-wide, so any append
   anywhere vouched for any empty collection anywhere. Both now have to concern the same name.
2. `CREATE TABLE` was matched against text including comments. Prose about a table is not a table.
3. `inScope = name => AUDIT_NAME.test(name) || required` put **every** table and bucket in scope
   once the task mentioned immutability, and `exec` took whichever was declared first. Terraform
   plumbing is now excluded by name, and among survivors a name that says what it holds is
   preferred over one that merely came first in the file.

**Why four Gemma runs never surfaced it:** all of them used a single Terraform root and no state
backend, so "any DynamoDB table" was a safe proxy for "the audit store". It stopped being one the
moment a project had real infrastructure plumbing — the check had been tuned on the vocabulary of
the deliverables that happened to exist.

### An IRSA trust policy with the right shape and the wrong subject

webhook-9 wrote the first genuinely correct IRSA trust policy of any run —
`sts:AssumeRoleWithWebIdentity`, a `Federated` principal referencing the OIDC provider *resource*,
and a `:sub` condition — and it still could not bind, for two independent reasons:

| the configuration says | reality |
|---|---|
| condition pins `system:serviceaccount:default:webhook-receiver` | the ServiceAccount is `webhook-receiver-sa` |
| annotation points at `webhook-receiver-role` | `project_name` defaults to `webhook-receiver`, so Terraform builds `webhook-receiver-receiver-role` |

Every artifact is valid on its own. Nothing fails at apply. The roles are created, the manifests
apply, and the pods silently get no credentials.

Two changes:

1. **The `:sub` condition is now compared against the ServiceAccount carrying the annotation.** The
   check previously verified the trust policy's *shape* and stopped — which is why it passed a
   policy that no pod on earth could satisfy. Only applied to annotations on ServiceAccount objects,
   since a pod-template annotation does not name the account.
2. **"Names a role this project does not define" was promoted from advisory to blocking** — but only
   when the project defines IAM roles of its own. "Managed elsewhere" is a real case and still only
   advises when the configuration declares no roles at all. On this project's own repeated
   measurement, a finding that merely advises does not get acted on, and an annotation pointing at a
   role the same configuration fails to create is never correct.

Making that promotion safe required **resolving `${var.x}` from variable defaults**. Without it,
`name = "${var.project_name}-role"` never matches a literal ARN and every project would look
mismatched — the promotion would have turned one quiet advisory into a false positive on everything.

### Three checks silenced at once by emptying the files they read

Told to fix findings in its Kubernetes manifests, a run wrote all five of them back as **zero-byte
files**. Its blocking failures fell from five to two, and `manifest_contract`, `k8s_manifest` and
`iam_contract` all went quiet. They had not passed — they had been starved. The task requires
"Kubernetes manifests for the service", and a project containing five empty YAML files satisfied
every manifest-aware gate in the loop.

This is the purest form of the failure this project keeps finding, and it was hiding under a metric
that looked like progress: 5 failures → 2.

`artifact-presence.mjs` adds two blocking checks:

- **An empty file is a finding.** Not a smaller version of the work — the absence of the work
  wearing its filename. `__init__.py`, `.gitkeep` and `.gitignore` are exempt.
- **A task-named artifact class that the project does not contain is a finding**, judged by content
  rather than filename: a `.yaml` with no `kind:`, a Dockerfile with no `FROM`, a `.tf` with no
  resource block. Only for classes the task actually names.

Run over the preserved deliverables it immediately found four more: **webhook-1's `terraform/eks.tf`
and `vpc.tf` are both empty** — that project was graded B without anyone noticing its EKS and VPC
configuration were empty files — plus an empty `Dockerfile` in webhook-9 and an empty
`k8s/secrets.yaml` in audit-adv23.

### An artifact census that is not Terraform-only

The resource census is advisory *by design*: it compares resource addresses, and a rename cannot be
told from a deletion. It also only ever looked at `.tf` files, which is why five manifests could be
emptied under it.

The new census compares **files this run produced against what they hold now, within one run**, so
nothing it reports can be a rename or a reorganisation — and it is therefore blocking. It fires when
a file loses its content entirely or drops below a fifth of its previous size.

### An unparseable review counted as no findings

Only lines beginning `- ` are read from an advisory. A structured markdown review written for this
run had its two most substantial findings — both prose under headings — **silently discarded**,
while the run recorded the review as delivered. A reviewer could write a thousand words and the loop
would proceed exactly as if they had written `NONE`.

Now: a non-empty review yielding no parseable line returns `inconclusive`, the same as a reviewer
who never answered. And the request **shows** the expected format with a worked example instead of
describing it in one line at the bottom of an 11KB document — the same lesson as the remediation
audit, learned twice in one day.

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

### 2. Kubernetes managed through Terraform is invisible to two checks

`k8s-manifest.mjs` and `iam-contract.mjs` both find Kubernetes objects by walking `.yaml`/`.yml`.
webhook-10 moved its entire Kubernetes configuration into `terraform/main.tf` as
`kubernetes_deployment`, `kubernetes_service`, `kubernetes_ingress`, `kubernetes_config_map` and
`kubernetes_service_account` — a legitimate and fairly common way to run EKS — and both checks
found nothing to inspect.

Unchecked in that shape: liveness/readiness probes, container fields misplaced onto the pod spec,
`${...}` interpolation, IRSA role annotations, and the `:sub` condition matching. Every finding
those two modules produce.

**Neither passes silently**, which is the mitigating detail — `k8s_manifest` reports "no Kubernetes
manifests found" and `iam_contract` reports "no ServiceAccount declares an IRSA role annotation".
They are advisories saying *not checked*, so the failure is a blind spot rather than a false clean.

**`manifest-contract.mjs` already solved this**, and is the model to copy rather than a fourth
casualty: it carries `TF_KUBERNETES_WORKLOAD`, `TF_ENV_BLOCK` and `TF_ENV_FROM`, reads `.tf`
alongside YAML, and correctly reported webhook-10's four environment variables as supplied by the
Terraform-managed Deployment. The precedent, and the regexes, are in the same repository.

Worth doing because the alternative is a class of project where three quarters of the Kubernetes
checks quietly do not apply — and because a project sophisticated enough to manage its cluster from
Terraform is not the one whose manifests need the least review.

### 3. Retention is never verified against the stated period

The task says "records are retained for seven years". Nothing checks that a configured retention
matches the requirement. webhook-5 got this right (Object Lock COMPLIANCE, 2555 days) and so did
webhook-1 — but by inspection, not because anything verified it.

Harder than it looks, and the reason it is still open: the period lives in the task text, so this
needs the requirement parsed out and compared against a plan value, which is a different kind of
check from everything else here. A version that assumed seven years universally would be
benchmark-hardcoding of exactly the kind this file exists to catch.

### 4. Client errors surfacing as 500

webhook-5 wraps its handler body in `except Exception`, which catches the `HTTPException(400)` it
raises itself and re-raises it as a 500 carrying `"400: Missing event ID"` — leaking the intended
status into the message. A bad request is reported as a server fault, and the detail string exposes
internals to the caller.

Detectable in principle: a broad `except Exception` enclosing a `raise HTTPException`. Not yet built,
and it competes for attention with the two above.
