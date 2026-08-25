import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { checkImmutability, immutabilityFailures } from "./immutability.mjs";

function withProject(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "immutability-"));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

const run = (files, fn) => {
  const dir = withProject(files);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// The claim this check exists to refuse, quoted from a real run: "The logs are immutable as the
// service only provides endpoints for adding and reading logs."
test("an audit table with no trigger and no revoke fails", () => {
  const { failures } = run(
    {
      "app/models.py": 'from sqlalchemy import Column\nclass LogEntry(Base):\n    __tablename__ = "audit_logs"\n',
      "README.md": "The logs are immutable as the service only provides endpoints for adding and reading.\n",
    },
    immutabilityFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /relational store \(table "audit_logs"\)/);
  assert.match(failures[0], /is not a control/);
});

test("triggers plus a revoke satisfy it", () => {
  const { failures } = run(
    {
      "app/models.py": 'class LogEntry(Base):\n    __tablename__ = "audit_logs"\nimport sqlalchemy\n',
      "db/init.sql":
        "CREATE OR REPLACE FUNCTION f() RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 'no'; END; $$ LANGUAGE plpgsql;\n" +
        "CREATE TRIGGER t BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION f();\n" +
        "CREATE TRIGGER d BEFORE DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION f();\n" +
        "REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM app_role;\n",
    },
    immutabilityFailures
  );
  assert.deepEqual(failures, []);
});

// PutItem replaces an item whose key exists, so the IAM policy looking right is not enough. This is
// the pair that a real run shipped: correct-looking IAM, unconditional write.
test("dynamodb needs the conditional write, not just a restricted policy", () => {
  const withoutCondition = run(
    {
      "app/db.py": "import boto3\ntable.put_item(Item=item)\n",
      "terraform/main.tf":
        'resource "aws_dynamodb_table" "audit_logs" {}\n' +
        'resource "aws_iam_policy" "p" { policy = jsonencode({ Action = ["dynamodb:PutItem","dynamodb:Query"] }) }\n',
    },
    immutabilityFailures
  );
  assert.equal(withoutCondition.failures.length, 1);
  assert.match(withoutCondition.failures[0], /attribute_not_exists/);

  const withCondition = run(
    {
      "app/db.py": 'import boto3\ntable.put_item(Item=item, ConditionExpression="attribute_not_exists(id)")\n',
      "terraform/main.tf":
        'resource "aws_dynamodb_table" "audit_logs" {}\n' +
        'resource "aws_iam_policy" "p" { policy = jsonencode({ Action = ["dynamodb:PutItem","dynamodb:Query"] }) }\n',
    },
    immutabilityFailures
  );
  assert.deepEqual(withCondition.failures, []);
});

test("a policy that still grants DeleteItem fails even with a conditional write", () => {
  const { failures } = run(
    {
      "app/db.py": 'table.put_item(Item=i, ConditionExpression="attribute_not_exists(id)")\nimport boto3\n',
      "terraform/main.tf":
        'resource "aws_dynamodb_table" "audit_logs" {}\n' +
        'resource "aws_iam_policy" "p" { policy = jsonencode({ Action = ["dynamodb:PutItem","dynamodb:DeleteItem"] }) }\n',
    },
    immutabilityFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /DeleteItem/);
});

// There is no control to look for: the process that owns the list can rewrite it, and a restart
// erases it. A real run shipped exactly this with two replicas behind a load balancer.
test("an in-memory store fails with no control to suggest", () => {
  const { failures } = run(
    { "app/main.py": "logs_db = []\n\ndef add(x):\n    logs_db.append(x)\n" },
    immutabilityFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /cannot be immutable/);
});

// Narrow on purpose. Firing on every table would make this noise, and noise is how a blocking
// check gets switched off.
test("an ordinary table that is not an audit log is out of scope", () => {
  const { failures, advisories } = run(
    { "app/models.py": 'import sqlalchemy\nclass User(Base):\n    __tablename__ = "users"\n' },
    immutabilityFailures
  );
  assert.deepEqual(failures, []);
  assert.match(advisories[0], /no append-only store could be identified/);
});

// The rule every silent-success bug in this stack came from breaking.
test("an undetermined answer is reported, never passed silently", () => {
  const report = run({ "README.md": "nothing here\n" }, checkImmutability);
  assert.ok(report.unknown, "must say it could not tell");
  const { failures, advisories } = run({ "README.md": "nothing here\n" }, immutabilityFailures);
  assert.deepEqual(failures, []);
  assert.equal(advisories.length, 1);
});

test("S3 needs Object Lock", () => {
  const unlocked = run(
    { "terraform/main.tf": 'resource "aws_s3_bucket" "audit_logs" { bucket = "x" }\n' },
    immutabilityFailures
  );
  assert.equal(unlocked.failures.length, 1);
  assert.match(unlocked.failures[0], /Object Lock/);

  const locked = run(
    {
      "terraform/main.tf":
        'resource "aws_s3_bucket" "audit_logs" { bucket = "x"\n  object_lock_enabled = true\n}\n',
    },
    immutabilityFailures
  );
  assert.deepEqual(locked.failures, []);
});
