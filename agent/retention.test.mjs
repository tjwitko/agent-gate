import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { taskRetentionRequirement, checkRetention, retentionFailures } from "./retention.mjs";

function run(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "retention-"));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SEVEN_YEARS = 7 * 365;

// --- reading the requirement ----------------------------------------------
test("the period is read from the task in the forms a task actually writes it", () => {
  const cases = [
    ["Records are retained for seven years.", SEVEN_YEARS],
    ["Records are retained for 7 years.", SEVEN_YEARS],
    ["Callbacks must be kept for 90 days.", 90],
    ["The system has a 7-year retention period.", SEVEN_YEARS],
    ["Store every event for six months.", 180],
  ];
  for (const [text, days] of cases) {
    assert.equal(taskRetentionRequirement(text)?.days, days, text);
  }
});

test("a task with no retention requirement produces none", () => {
  assert.equal(taskRetentionRequirement("Accept HTTP callbacks and verify signatures."), null);
  assert.equal(taskRetentionRequirement(""), null);
});

test("with no stated period the check does not run and says so", () => {
  run({ "main.tf": "" }, (dir) => {
    const r = retentionFailures(dir, {});
    assert.equal(r.failures.length, 0);
    assert.match(r.advisories[0], /not checked/i);
  });
});

// --- the finding ----------------------------------------------------------
test("a lifecycle expiration shorter than the requirement blocks", () => {
  run(
    {
      "main.tf": `
        resource "aws_s3_bucket" "callbacks" { bucket = "callbacks" }
        resource "aws_s3_bucket_lifecycle_configuration" "callbacks" {
          rule { id = "expire"  expiration { days = 90 } }
        }`,
    },
    (dir) => {
      const r = retentionFailures(dir, { requiredDays: SEVEN_YEARS });
      assert.equal(r.failures.length, 1);
      assert.match(r.failures[0], /destroys records before/);
      assert.match(r.failures[0], /90 day/);
    }
  );
});

test("an enabled DynamoDB TTL blocks, because the horizon is not in the configuration", () => {
  run(
    {
      "main.tf": `
        resource "aws_dynamodb_table" "callbacks" {
          name = "callbacks"
          ttl { attribute_name = "expires_at"  enabled = true }
        }`,
    },
    (dir) => {
      const r = retentionFailures(dir, { requiredDays: SEVEN_YEARS });
      assert.equal(r.failures.length, 1);
      assert.match(r.failures[0], /TTL/);
    }
  );
});

test("a TTL that is present but disabled is not a finding", () => {
  run(
    {
      "main.tf": `
        resource "aws_dynamodb_table" "callbacks" {
          ttl { attribute_name = "expires_at"  enabled = false }
        }`,
    },
    (dir) => {
      assert.equal(retentionFailures(dir, { requiredDays: SEVEN_YEARS }).failures.length, 0);
    }
  );
});

// --- the noise this must not make -----------------------------------------
// A lock table, a cache and a rate limiter exist in order to expire. Blocking on one is how a gate
// gets switched off, and terraform's own state plumbing has already cost this project a run.
test("TTL on lock, cache and rate-limit tables is not a finding", () => {
  for (const label of ["terraform_locks", "session_cache", "rate_limit_counters", "idempotency_keys"]) {
    run(
      { "main.tf": `resource "aws_dynamodb_table" "${label}" { ttl { enabled = true } }` },
      (dir) => {
        assert.equal(
          retentionFailures(dir, { requiredDays: SEVEN_YEARS }).failures.length,
          0,
          `${label} should not block`
        );
      }
    );
  }
});

test("a commented-out expiration is not a deleter", () => {
  run(
    {
      "main.tf": `
        resource "aws_s3_bucket_lifecycle_configuration" "callbacks" {
          # rule { expiration { days = 30 } }
        }`,
    },
    (dir) => {
      assert.equal(retentionFailures(dir, { requiredDays: SEVEN_YEARS }).failures.length, 0);
    }
  );
});

test("no expiry anywhere is compliance, not a finding", () => {
  run(
    { "main.tf": `resource "aws_dynamodb_table" "callbacks" { name = "callbacks" }` },
    (dir) => {
      const r = retentionFailures(dir, { requiredDays: SEVEN_YEARS });
      assert.equal(r.failures.length, 0);
      assert.match(r.advisories[0], /nothing here deletes the records/);
      // and it must not overclaim
      assert.match(r.advisories[0], /durability of the store itself was not checked/);
    }
  );
});

// --- the wrong answer this exists to name ---------------------------------
test("a backup window is reported as not being record retention", () => {
  run(
    {
      "main.tf": `resource "aws_rds_cluster" "main" { backup_retention_period = 35 }`,
    },
    (dir) => {
      const r = retentionFailures(dir, { requiredDays: SEVEN_YEARS });
      assert.equal(r.failures.length, 0, "a backup window deletes no records, so it must not block");
      assert.match(r.advisories[0], /not record retention/);
      assert.match(r.advisories[0], /7 year/);
    }
  );
});

// --- Object Lock, the mechanism that actually satisfies this --------------
test("Object Lock long enough is credited; too short is a finding", () => {
  const lock = (years) => ({
    "main.tf": `
      resource "aws_s3_bucket_object_lock_configuration" "callbacks" {
        rule { default_retention { mode = "COMPLIANCE"  years = ${years} } }
      }`,
  });
  run(lock(7), (dir) => {
    const r = retentionFailures(dir, { requiredDays: SEVEN_YEARS });
    assert.equal(r.failures.length, 0);
    assert.match(r.advisories[0], /at least the 7 year/);
  });
  run(lock(1), (dir) => {
    const r = retentionFailures(dir, { requiredDays: SEVEN_YEARS });
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /the period is short/);
  });
});

// --- silence is never a pass ----------------------------------------------
test("a project with no Terraform reports NOT CHECKED rather than passing", () => {
  run({ "index.mjs": "export const x = 1;" }, (dir) => {
    const r = retentionFailures(dir, { requiredDays: SEVEN_YEARS });
    assert.equal(r.failures.length, 0);
    assert.match(r.advisories[0], /NOT CHECKED/);
    assert.match(r.advisories[0], /unverified rather than met/);
  });
});

// --- the false positive this check drew on its own first real run ---------
// `aws_cloudwatch_log_group "eks_cluster"` at 400 days is the EKS control plane's own log group.
// Every cluster ships one, it holds no callbacks, and blocking on it sends a model rewriting
// infrastructure that was correct.
test("a platform log group is not the record store", () => {
  for (const [label, name] of [
    ["eks_cluster", "/aws/eks/webhook-eks/cluster"],
    ["lambda_logs", "/aws/lambda/processor"],
    ["vpc_flow", "/aws/vpc/flow-logs"],
  ]) {
    run(
      {
        "main.tf": `resource "aws_cloudwatch_log_group" "${label}" {
          name = "${name}"
          retention_in_days = 30
        }`,
      },
      (dir) => {
        const r = retentionFailures(dir, { requiredDays: SEVEN_YEARS });
        assert.equal(r.failures.length, 0, `${label} must not block`);
        assert.doesNotMatch(r.advisories.join(" "), new RegExp(label));
      }
    );
  }
});

test("a log group named for the records does block", () => {
  run(
    {
      "main.tf": `resource "aws_cloudwatch_log_group" "callback_audit" {
        name = "/webhook/callbacks"
        retention_in_days = 30
      }`,
    },
    (dir) => {
      const r = retentionFailures(dir, { requiredDays: SEVEN_YEARS });
      assert.equal(r.failures.length, 1);
      assert.match(r.failures[0], /30 day/);
    }
  );
});

test("an ambiguous log group is reported without blocking", () => {
  run(
    {
      "main.tf": `resource "aws_cloudwatch_log_group" "app" {
        name = "/srv/app"
        retention_in_days = 14
      }`,
    },
    (dir) => {
      const r = retentionFailures(dir, { requiredDays: SEVEN_YEARS });
      assert.equal(r.failures.length, 0);
      assert.match(r.advisories.join(" "), /nothing here says whether this holds the records/);
    }
  );
});

// --- AWS Backup, missed on first contact with a real deliverable ----------
// A run kept its records for seven years with an aws_backup_plan whose delete_after came from a
// variable defaulting to 2555, guarded by a validation block refusing anything shorter. This check
// knew only TTLs, lifecycle rules and Object Lock, and told the reader "nothing here establishes it
// either" -- a confident statement about a requirement the project had met.
const BACKUP_PLAN = (days) => ({
  "terraform/variables.tf": `
    variable "backup_retention_days" {
      type    = number
      default = ${days}
    }`,
  "terraform/backup.tf": `
    resource "aws_backup_plan" "events_log" {
      name = "events-log-retention"
      rule {
        rule_name         = "seven-year-retention"
        target_vault_name = aws_backup_vault.events_log.name
        lifecycle { delete_after = var.backup_retention_days }
      }
    }`,
});

test("an AWS Backup plan long enough is credited, through the variable", () => {
  run(BACKUP_PLAN(2555), (dir) => {
    const r = retentionFailures(dir, { requiredDays: SEVEN_YEARS });
    assert.equal(r.failures.length, 0);
    assert.match(r.advisories[0], /AWS Backup plan rule "seven-year-retention"/);
    assert.match(r.advisories[0], /at least the 7 year/);
  });
});

test("an AWS Backup plan that is too short is a finding", () => {
  run(BACKUP_PLAN(90), (dir) => {
    const r = retentionFailures(dir, { requiredDays: SEVEN_YEARS });
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /the period is short/);
  });
});

test("a delete_after that cannot be resolved is reported, never credited", () => {
  run(
    {
      "terraform/backup.tf": `
        resource "aws_backup_plan" "events_log" {
          rule {
            rule_name = "retain"
            lifecycle { delete_after = var.undeclared_somewhere_else }
          }
        }`,
    },
    (dir) => {
      const r = retentionFailures(dir, { requiredDays: SEVEN_YEARS });
      assert.equal(r.failures.length, 0);
      assert.match(r.advisories.join(" "), /could not be resolved/);
      // and it must not claim the period is short when it simply could not read it
      assert.doesNotMatch(r.advisories.join(" "), /shorter than/);
    }
  );
});

test("a vault lock minimum is credited", () => {
  run(
    {
      "terraform/backup.tf": `
        resource "aws_backup_vault_lock_configuration" "events_log" {
          backup_vault_name = "events-log-vault"
          min_retention_days = 2555
        }`,
    },
    (dir) => {
      const r = retentionFailures(dir, { requiredDays: SEVEN_YEARS });
      assert.equal(r.failures.length, 0);
      assert.match(r.advisories.join(" "), /vault lock/);
    }
  );
});

// --- the period, however the task words it --------------------------------
// Measured before this change: 5 of 10 rephrasings recognised. Worse, [^.] let a proximity span run
// through a semicolon and FABRICATE a period from a deployment cadence -- "Keep the log short;
// rotate it every 7 days" produced a 7-day requirement. Inventing one is worse than missing one: it
// switches this check on and has it report against a period the task never stated.
const STATES_A_PERIOD = [
  ["Records are retained for seven years.", SEVEN_YEARS],
  ["Callbacks must be kept for 90 days.", 90],
  ["The system has a 7-year retention period.", SEVEN_YEARS],
  ["Records must remain available for seven years.", SEVEN_YEARS],
  ["We are required to produce any callback for up to seven years.", SEVEN_YEARS],
  ["Nothing may be deleted for at least seven years.", SEVEN_YEARS],
  ["Store every event for six months.", 180],
  ["Keep the audit trail for ninety days.", 90],
  ["Records live for seven years before they may be purged.", SEVEN_YEARS],
  ["Regulatory hold: seven years.", SEVEN_YEARS],
];
for (const [task, days] of STATES_A_PERIOD) {
  test(`a retention period survives being rephrased: ${task.slice(0, 40)}`, () => {
    assert.equal(taskRetentionRequirement(task)?.days, days, task);
  });
}

const STATES_NO_PERIOD = [
  "Accept HTTP callbacks and verify signatures.",
  "The provider rotates its signing secret every quarter.",
  "Respond within 200 milliseconds.",
  "Deploy every two weeks.",
  "Remove the feature flag after the launch.",
  // The three that were fabricated before the clause bound was fixed.
  "Keep the log short; rotate it every 7 days.",
  "Keep it lean; deploys go out every 2 weeks.",
  "Store the config in git; review it every 6 months.",
];
for (const task of STATES_NO_PERIOD) {
  test(`no period is invented from: ${task.slice(0, 40)}`, () => {
    assert.equal(taskRetentionRequirement(task), null, task);
  });
}

// The word list was written from one task and stopped at twelve, so "90 days" was read and "ninety
// days" was not. Longest-first alternation keeps "seventeen" from being read as "seven".
test("number words above twelve are read, and longer words win", () => {
  assert.equal(taskRetentionRequirement("Keep it for thirty days")?.days, 30);
  assert.equal(taskRetentionRequirement("Keep it for ninety days")?.days, 90);
  assert.equal(taskRetentionRequirement("Keep it for seventeen days")?.days, 17);
  assert.equal(taskRetentionRequirement("Keep it for seven days")?.days, 7);
});
