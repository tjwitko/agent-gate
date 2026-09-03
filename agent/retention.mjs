// Does anything delete the records before the retention period the task asked for?
//
// Retention has been a stated requirement in every run of the webhook task and has had zero
// coverage across roughly sixteen deliverables. Not one implemented it; nothing looked. The one
// time a deliverable addressed it at all, it set `backup_retention_period = 35` on an RDS cluster
// and reported the seven-year requirement as met -- a backup window is how far back you can restore
// the database, not how long a record survives in it, and the two are not related. That confusion
// is the single most likely wrong answer here, so this check names it explicitly rather than
// staying silent about a setting it does not accept.
//
// The property tested is deliberately NOT "does the source say seven years somewhere". Demanding a
// spelling is the defect shape this project keeps paying for: a hardcoded list of incantations,
// drawn from whatever the last benchmark produced, standing in for a test of shape. It also gets
// the logic backwards. Records that are never deleted satisfy a seven-year requirement completely,
// and a project whose store has no expiry configured is compliant, not deficient.
//
// So the finding is the reverse: something is configured to DELETE records, on a horizon shorter
// than the requirement or on a horizon that cannot be established from the source at all. That is
// provable from the configuration, it is the only state that actually loses the records, and it
// cannot be satisfied by writing a number in a comment.
import path from "path";

import { walk, uncommented } from "./source-files.mjs";
import { hclResources, hclBlocks, hclAttr, hclNumber, hclBool, hclVariableDefaults } from "./hcl-blocks.mjs";

const UNIT_DAYS = { day: 1, week: 7, month: 30, year: 365 };
// Written from one phrasing of one task, so it stopped at twelve: "90 days" was read and "ninety
// days" was not. The tens matter most -- a retention period is far more often thirty, ninety or a
// hundred and eighty days than eleven of anything.
const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

// Months and years are approximated at 30 and 365 days. The comparison this feeds is "is the
// configured expiry shorter than the requirement", and no realistic configuration sits inside the
// few days of slack that leap years and month lengths introduce.
function toDays(count, unit) {
  return count * (UNIT_DAYS[unit.toLowerCase().replace(/s$/, "")] ?? 0);
}

// Longest first, so "seventeen" is not read as "seven" with a stray "teen".
const AMOUNT = `(\\d+|${Object.keys(WORD_NUMBERS).sort((a, b) => b.length - a.length).join("|")})`;
const UNIT = "(day|week|month|year)s?";
// [^.;\n], not [^.]. With [^.] the span ran through a semicolon and read a deployment cadence as a
// retention requirement -- "Keep the log short; rotate it every 7 days" produced a 7-day
// requirement, "Keep it lean; deploys go out every 2 weeks" a 14-day one. Fabricating a requirement
// is worse than missing one: it switches this check on and has it report against a period the task
// never stated.
const NEAR = (n) => `[^.;\\n]{0,${n}}?`;
// Keeping a record is said in more ways than "retain": it must remain available, we must be able to
// produce it, nothing may be deleted before, records live for. The verbs of destruction belong here
// too -- a sentence about when something may be deleted states the same requirement from the other
// side.
const KEEP =
  "retain|retention|kept|keep|stored?|storage|preserv|archiv|hold|held|available|access\\w*|" +
  "produce|reproduce|live|lives|survive|remain|deleted?|delete|purge[ds]?|remove[ds]?|destroy\\w*|expire[ds]?";
const RETENTION_PHRASES = [
  new RegExp(`\\b(?:${KEEP})\\w*\\b${NEAR(45)}\\b${AMOUNT}[- ]?${UNIT}\\b`, "i"),
  new RegExp(`\\b${AMOUNT}[- ]?${UNIT}\\b${NEAR(30)}\\b(?:retention|retained|retain)\\b`, "i"),
];

/**
 * The retention period the task states, as { days, phrase }, or null when it states none.
 * Gated on the task the same way immutability and secret rotation are: a project nobody asked to
 * retain anything is not defective for not retaining it.
 */
export function taskRetentionRequirement(taskText = "") {
  for (const re of RETENTION_PHRASES) {
    const m = re.exec(taskText);
    if (!m) continue;
    const raw = m[1].toLowerCase();
    const count = WORD_NUMBERS[raw] ?? Number(raw);
    const days = toDays(count, m[2]);
    if (days > 0) return { days, phrase: m[0].trim() };
  }
  return null;
}

// Stores whose whole purpose is to expire. A lock table, a cache or a rate-limit counter with a TTL
// is correct, and blocking on one would be the kind of noise that gets a gate switched off.
// Terraform's own state plumbing is excluded for the reason immutability learned the hard way: a
// state-lock table given `attribute_not_exists` advice breaks exactly the write locking depends on.
const NOT_A_RECORD_STORE =
  /terraform|tfstate|\bstate\b|\block(s|ing)?\b|backend|migration|cache|session|rate_?limit|throttl|nonce|idempoten|\btemp\b|\btmp\b|scratch/i;

// Days unless the figure is a whole number of years. A `days = 90` setting rendered as "3 month(s)"
// sends the reader looking for a number that is not in their file; the message has to name the
// value they can actually find and change.
// Log groups that belong to the platform rather than to the application's records. `/aws/eks/...`,
// a Lambda's own group, VPC flow logs: every one of these exists in a normal deployment and none of
// them holds a callback. EKS in particular publishes a log type literally called "audit", so a name
// test alone would keep re-catching it.
const INFRA_LOG_GROUP =
  /(^|\/)aws\/|\beks\b|\bcluster\b|control[-_]?plane|\blambda\b|apigateway|api[-_]?gateway|\brds\b|\bvpc\b|flow[-_]?log|codebuild|ecs\b|\bnginx\b|ingress/i;

// A name that says it holds the records the task is about.
const RECORD_STORE_NAME =
  /(audit|webhook|callback|event|record|receipt|notification|ledger|journal|trail|payment|delivery)/i;

const humanDays = (d) => (d >= 365 && d % 365 === 0 ? `${d / 365} year(s)` : `${d} day(s)`);


// --- can the store itself be destroyed? -----------------------------------
// The checks above establish that nothing EXPIRES the records early. That is not the same as the
// records surviving seven years, and the difference is one command. A deliverable declared
// `enable_deletion_protection = true` -- on its load balancer. Its actual record store, an
// aws_db_instance holding the callbacks, had no protection at all, so a single `terraform destroy`
// erases the seven-year record while a grep for "deletion_protection" says the project is covered.
//
// What counts as protection is per resource type, because AWS spells it differently in each:
const STORE_PROTECTION = [
  {
    type: /^aws_dynamodb_table$/,
    label: "DynamoDB table",
    protected: (body) => hclBool(body, "deletion_protection_enabled") === true || preventsDestroy(body),
    missing: "deletion_protection_enabled = true, or lifecycle { prevent_destroy = true }",
  },
  {
    type: /^(aws_db_instance|aws_rds_cluster)$/,
    label: "RDS store",
    protected: (body) => hclBool(body, "deletion_protection") === true || preventsDestroy(body),
    missing: "deletion_protection = true, or lifecycle { prevent_destroy = true }",
  },
  {
    type: /^aws_s3_bucket$/,
    label: "S3 bucket",
    // force_destroy is the opposite of protection: it exists so Terraform can delete a bucket that
    // still has objects in it. A COMPLIANCE-mode Object Lock is protection on its own -- nobody can
    // delete the objects, and a bucket that cannot be emptied cannot be destroyed. GOVERNANCE is
    // not, because it can be bypassed.
    protected: (body, ctx) =>
      hclBool(body, "force_destroy") !== true && (preventsDestroy(body) || ctx.complianceLocked),
    missing: "lifecycle { prevent_destroy = true }, a COMPLIANCE-mode Object Lock, or force_destroy left off",
  },
];

function preventsDestroy(body) {
  return hclBlocks(body, "lifecycle").some((l) => hclBool(l, "prevent_destroy") === true);
}

/**
 * Whether the store holding the records can be destroyed, and whether its key can.
 * Returns { unprotected, governanceLocks, deletableKeys }.
 */
export function checkRetentionDurability(tfText) {
  // Which buckets are held by a COMPLIANCE-mode lock, by the label the lock resource points at.
  const complianceLocked = new Set();
  for (const r of hclResources(tfText, /^aws_s3_bucket_object_lock_configuration$/)) {
    const compliance = hclBlocks(r.body, "default_retention").some((dr) => /\bmode\s*=\s*"COMPLIANCE"/i.test(dr));
    if (!compliance) continue;
    const ref = /\bbucket\s*=\s*aws_s3_bucket\.(\w+)/.exec(r.body);
    complianceLocked.add(ref ? ref[1] : r.label);
  }

  const unprotected = [];
  for (const spec of STORE_PROTECTION) {
    for (const r of hclResources(tfText, spec.type)) {
      // This BLOCKS, so it fires only on a store whose name says it holds the records. A bucket of
      // load-balancer logs or build artifacts is not a seven-year archive, and demanding
      // prevent_destroy on one would be a false block. The cost is a store called `main` or
      // `primary` going unchecked -- the safe direction for a blocking finding, and the same rule
      // already used for CloudWatch log groups.
      if (NOT_A_RECORD_STORE.test(r.label) || !RECORD_STORE_NAME.test(r.label)) continue;
      if (spec.protected(r.body, { complianceLocked: complianceLocked.has(r.label) })) continue;
      unprotected.push({ what: `${spec.label} "${r.label}"`, missing: spec.missing });
    }
  }

  // GOVERNANCE mode is bypassable by any principal holding s3:BypassGovernanceRetention. For a
  // regulatory hold that is a different control from COMPLIANCE, which nobody can shorten -- not
  // the account root, not AWS.
  const governanceLocks = [];
  for (const r of [
    ...hclResources(tfText, /^aws_s3_bucket_object_lock_configuration$/),
    ...hclResources(tfText, /^aws_s3_bucket$/),
  ]) {
    for (const dr of hclBlocks(r.body, "default_retention")) {
      if (/\bmode\s*=\s*"GOVERNANCE"/i.test(dr)) governanceLocks.push(r.label);
    }
  }

  // Ciphertext whose key is gone is not a record. A customer-managed key that terraform can
  // schedule for deletion takes the archive with it.
  const deletableKeys = hclResources(tfText, /^aws_kms_key$/)
    .filter((k) => !preventsDestroy(k.body))
    .map((k) => k.label);

  return { unprotected, governanceLocks, deletableKeys };
}

/**
 * What in this project deletes records, and on what horizon.
 * Returns { ran, unknown, deleters, credits, backupOnly }.
 */
export function checkRetention(projectDir, { requiredDays } = {}) {
  const files = walk(projectDir);
  if (files.length === 0) return { ran: false, unknown: "no readable source files", deleters: [], credits: [], backupOnly: [] };

  const tf = files.filter((f) => path.extname(f.rel) === ".tf" || path.extname(f.rel) === ".tfvars");
  if (tf.length === 0) {
    return {
      ran: false,
      unknown: "no Terraform configuration, so where these records live and how long they survive is not described anywhere this check can read",
      deleters: [],
      credits: [],
      backupOnly: [],
    };
  }
  const tfText = uncommented(tf.map((f) => f.text).join("\n"));

  const deleters = [];
  const credits = [];
  const backupOnly = [];
  // Expiries on things this check cannot tell apart from the record store. Reported, never blocking.
  const unnamed = [];

  // --- DynamoDB TTL -------------------------------------------------------
  // TTL deletes items. The expiry itself is a per-item attribute written by the application, so
  // Terraform cannot show the horizon -- which is precisely why an enabled TTL on a record table is
  // reported rather than assumed adequate.
  for (const r of hclResources(tfText, /^aws_dynamodb_table$/)) {
    if (NOT_A_RECORD_STORE.test(r.label)) continue;
    for (const ttl of hclBlocks(r.body, "ttl")) {
      if (hclBool(ttl, "enabled") === true) {
        deleters.push({
          what: `DynamoDB TTL on table "${r.label}"`,
          horizonDays: null,
          detail:
            "TTL deletes items, and the expiry timestamp is written per item by the application, so " +
            "nothing in this configuration establishes how long a record survives. Either remove the " +
            "TTL from the table holding the records, or show the expiry being computed from the " +
            "retention period where the item is written",
        });
      }
    }
  }

  // --- S3 lifecycle expiration -------------------------------------------
  const s3Lifecycle = [
    ...hclResources(tfText, /^aws_s3_bucket_lifecycle_configuration$/).map((r) => ({ label: r.label, body: r.body })),
    ...hclResources(tfText, /^aws_s3_bucket$/).flatMap((r) =>
      hclBlocks(r.body, "lifecycle_rule").map((body) => ({ label: r.label, body }))
    ),
  ];
  for (const rule of s3Lifecycle) {
    if (NOT_A_RECORD_STORE.test(rule.label)) continue;
    for (const exp of [...hclBlocks(rule.body, "expiration"), ...hclBlocks(rule.body, "noncurrent_version_expiration")]) {
      const days = hclNumber(exp, "days") ?? hclNumber(exp, "noncurrent_days");
      if (days !== null) {
        deleters.push({
          what: `S3 lifecycle expiration on "${rule.label}"`,
          horizonDays: days,
          detail: `objects are deleted after ${humanDays(days)}`,
        });
      }
    }
  }

  // --- CloudWatch log retention ------------------------------------------
  // The one place this check drew a false positive on its first real run: it blocked a deliverable
  // over `aws_cloudwatch_log_group "eks_cluster"` at 400 days -- the EKS control plane's own log
  // group, which every cluster ships and which holds no callback records at all. The deliverable's
  // records were in DynamoDB and were never deleted. Telemetry is excluded outright, and what
  // remains only blocks when its name says it holds the records; anything else is reported without
  // blocking, because a log group is infrastructure by default and guessing wrong here rewrites
  // configuration that was correct.
  for (const r of hclResources(tfText, /^aws_cloudwatch_log_group$/)) {
    const name = hclAttr(r.body, "name") || "";
    const identity = `${r.label} ${name}`;
    if (NOT_A_RECORD_STORE.test(identity) || INFRA_LOG_GROUP.test(identity)) continue;
    const days = hclNumber(r.body, "retention_in_days");
    if (days === null || days <= 0) continue;
    const entry = {
      what: `CloudWatch log group "${r.label}"`,
      horizonDays: days,
      detail: `log events are deleted after ${humanDays(days)}`,
    };
    if (RECORD_STORE_NAME.test(identity)) deleters.push(entry);
    else unnamed.push(entry);
  }

  // --- Object Lock, which actually is record retention --------------------
  for (const r of [
    ...hclResources(tfText, /^aws_s3_bucket_object_lock_configuration$/),
    ...hclResources(tfText, /^aws_s3_bucket$/),
  ]) {
    for (const dr of hclBlocks(r.body, "default_retention")) {
      const years = hclNumber(dr, "years");
      const days = hclNumber(dr, "days");
      const held = years !== null ? years * 365 : days;
      if (held !== null) {
        credits.push({ what: `S3 Object Lock on "${r.label}"`, horizonDays: held });
      }
    }
  }

  // --- AWS Backup, which is record retention when the horizon is long enough -
  // Missed on first contact with a real deliverable. A run kept its records for seven years with an
  // aws_backup_plan whose `delete_after` came from a variable defaulting to 2555, guarded by a
  // validation block refusing anything shorter -- and this check, knowing only TTLs, lifecycle
  // rules and Object Lock, told the reader "nothing here establishes it either". Not a false block,
  // since it is advisory, but a confident statement about a requirement the project had met.
  const vars = hclVariableDefaults(tfText);
  const resolveDays = (raw) => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "number") return raw;
    const v = /^var\.(\w+)$/.exec(String(raw).trim());
    if (v) {
      const d = vars.get(v[1]);
      return d === undefined ? null : Number(d);
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  for (const plan of hclResources(tfText, /^aws_backup_plan$/)) {
    for (const rule of hclBlocks(plan.body, "rule")) {
      for (const lc of hclBlocks(rule, "lifecycle")) {
        const raw = hclNumber(lc, "delete_after") ?? (/\bdelete_after\s*=\s*(var\.\w+)/.exec(lc) || [])[1];
        const days = resolveDays(raw);
        const name = hclAttr(rule, "rule_name") || plan.label;
        if (days === null) {
          // A horizon that cannot be resolved is not a horizon. Reported, never credited.
          unnamed.push({
            what: `AWS Backup plan rule "${name}"`,
            horizonDays: null,
            detail: "its delete_after could not be resolved to a number here",
          });
        } else {
          credits.push({ what: `AWS Backup plan rule "${name}"`, horizonDays: days });
        }
      }
    }
  }
  for (const lock of hclResources(tfText, /^aws_backup_vault_lock_configuration$/)) {
    const days = resolveDays(hclNumber(lock.body, "min_retention_days") ?? (/\bmin_retention_days\s*=\s*(var\.\w+)/.exec(lock.body) || [])[1]);
    if (days !== null) credits.push({ what: `AWS Backup vault lock on "${lock.label}"`, horizonDays: days });
  }

  // --- settings that are about restoring a database, not keeping a record --
  const backupDays = hclNumber(tfText, "backup_retention_period");
  if (backupDays !== null) backupOnly.push({ what: "backup_retention_period", horizonDays: backupDays });
  for (const r of hclResources(tfText, /^aws_dynamodb_table$/)) {
    for (const pitr of hclBlocks(r.body, "point_in_time_recovery")) {
      if (hclBool(pitr, "enabled") === true) backupOnly.push({ what: `point_in_time_recovery on "${r.label}"`, horizonDays: 35 });
    }
  }

  return { ran: true, unknown: null, deleters, credits, backupOnly, unnamed,
           durability: checkRetentionDurability(tfText), requiredDays };
}

/**
 * Blocking failures and advisories for the loop.
 * Blocks only on a mechanism that deletes records before the required period, or on one whose
 * horizon cannot be established at all. Absence of any expiry is compliance, not a finding.
 */
export function retentionFailures(projectDir, { requiredDays } = {}) {
  if (!requiredDays) {
    return { failures: [], advisories: ["retention: not checked — the task states no retention period"] };
  }

  const report = checkRetention(projectDir, { requiredDays });
  const need = humanDays(requiredDays);

  // A check that could not run says so. It must never read as "nothing deletes these records".
  if (!report.ran) {
    return {
      failures: [],
      advisories: [
        `retention: NOT CHECKED — ${report.unknown}. The task requires records to be kept for ${need}; ` +
          `nothing here was examined, so treat that requirement as unverified rather than met.`,
      ],
    };
  }

  const failures = [];
  const advisories = [];

  const tooShort = report.deleters.filter((d) => d.horizonDays === null || d.horizonDays < requiredDays);
  for (const d of tooShort) {
    failures.push(
      `retention: ${d.what} destroys records before the ${need} the task requires — ${d.detail}. ` +
        `Retention is not a property of the application: the records are gone whatever the API does or ` +
        `does not offer, and a dispute raised years later is exactly the case this requirement exists for.`
    );
  }

  // The likely wrong answer, named. Only when nothing else establishes retention, so a project that
  // has both a backup window and real retention is not lectured about the backup window.
  if (!failures.length && !report.credits.length && report.backupOnly.length) {
    advisories.push(
      `retention: ${report.backupOnly.map((b) => b.what).join(", ")} is set, and it is not record retention. ` +
        `A backup window is how far back the store can be restored — at most 35 days on RDS and DynamoDB — ` +
        `not how long a record survives inside it. The task asks for ${need}. Nothing here deletes the ` +
        `records, so the requirement is not violated, but nothing here establishes it either.`
    );
  }

  if (!failures.length && report.credits.length) {
    const best = Math.max(...report.credits.map((c) => c.horizonDays));
    const line = report.credits.map((c) => `${c.what} (${humanDays(c.horizonDays)})`).join(", ");
    if (best < requiredDays) {
      failures.push(
        `retention: ${line} holds records for less than the ${need} the task requires. Object Lock is ` +
          `the right mechanism; the period is short.`
      );
    } else {
      advisories.push(`retention: ${line} holds records for at least the ${need} required.`);
    }
  }

  for (const u of report.unnamed) {
    if (u.horizonDays !== null && u.horizonDays >= requiredDays) continue;
    // An unresolvable horizon is not a short one. Saying "shorter than the 7 years required" about
    // a period this check simply could not read is a claim it has no basis for.
    advisories.push(
      u.horizonDays === null
        ? `retention: ${u.what} — ${u.detail}, so whether it satisfies the ${need} the task ` +
            `requires could not be established here. Check it yourself rather than assuming either way.`
        : `retention: ${u.what} — ${u.detail}, which is shorter than the ${need} the task requires. ` +
            `Not blocking, because nothing here says whether this holds the records or only this ` +
            `service's own logs. If the records are in it, this deletes them.`
    );
  }

  // Emitted on the EXPIRY verdict alone. Gating it on total silence meant a durability finding
  // suppressed it, and the reader lost the answer to "does anything delete these records" -- two
  // separate properties, and each needs its own line.
  if (!failures.length && !advisories.length) {
    advisories.push(
      `retention: nothing here deletes the records — no TTL, no lifecycle expiration, no log retention — ` +
        `so the ${need} requirement is not violated by this configuration. That is the whole of what was ` +
        `established here; whether the store survives the period is reported separately.`
    );
  }

  // Surviving the period is a separate property from not being expired early, and it is checked
  // separately. A store nothing expires but anything can drop is not retained.
  const dur = report.durability || { unprotected: [], governanceLocks: [], deletableKeys: [] };
  for (const u of dur.unprotected) {
    failures.push(
      `retention: ${u.what} holds the records and can be destroyed — no ${u.missing}. Nothing here ` +
        `expires these records, but one \`terraform destroy\`, or one resource replacement, ends the ` +
        `${need} the task requires. Declaring protection on some other resource does not count: a ` +
        `deliverable set enable_deletion_protection on its load balancer while the database holding ` +
        `the callbacks had none.`
    );
  }
  if (dur.governanceLocks.length) {
    advisories.push(
      `retention: Object Lock on ${dur.governanceLocks.map((l) => `"${l}"`).join(", ")} is in ` +
        `GOVERNANCE mode, which any principal holding s3:BypassGovernanceRetention can shorten. ` +
        `COMPLIANCE mode cannot be shortened by anyone, including the account root and AWS. For a ` +
        `${need} regulatory hold that is the difference between a control and a default.`
    );
  }
  if (dur.deletableKeys.length && (dur.unprotected.length === 0 || dur.governanceLocks.length)) {
    advisories.push(
      `retention: KMS key(s) ${dur.deletableKeys.map((k) => `"${k}"`).join(", ")} have no ` +
        `lifecycle { prevent_destroy = true }. If the records are encrypted with a key this ` +
        `configuration can schedule for deletion, destroying the key destroys the archive: ` +
        `ciphertext without its key is not a record. Protecting the store and not its key leaves ` +
        `the shorter of the two paths open.`
    );
  }

  return { failures, advisories };
}
