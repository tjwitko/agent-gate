import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { checkImmutability, immutabilityFailures, taskRequiresImmutability } from "./immutability.mjs";

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

// The control does not have to live in a .sql file. A run wrote both triggers, the REVOKE, and a
// separate admin connection as SQLAlchemy text() literals inside app/database.py, and an earlier
// version of this check called that missing -- while passing another run whose .sql file nothing
// ever executed. Judging the mechanism by its file extension measured the wrong thing.
test("SQL embedded in application code counts as a control", () => {
  const { failures } = run(
    {
      "app/models.py": 'import sqlalchemy\nclass LogEntry(Base):\n    __tablename__ = "audit_logs"\n',
      "app/database.py":
        "from sqlalchemy import text\n" +
        "def init_db_schema(admin_url):\n" +
        '    admin_db.execute(text("""\n' +
        "    CREATE OR REPLACE FUNCTION prevent_update_func() RETURNS trigger AS $$\n" +
        "    BEGIN RAISE EXCEPTION 'Updates are not allowed'; END; $$ LANGUAGE plpgsql;\n" +
        "    CREATE TRIGGER prevent_updates BEFORE UPDATE ON audit_logs\n" +
        "      FOR EACH ROW EXECUTE FUNCTION prevent_update_func();\n" +
        "    CREATE TRIGGER prevent_deletes BEFORE DELETE ON audit_logs\n" +
        "      FOR EACH ROW EXECUTE FUNCTION prevent_update_func();\n" +
        "    REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM audit_app;\n" +
        '    """))\n',
    },
    immutabilityFailures
  );
  assert.deepEqual(failures, []);
});

// The store's name is chosen by the model, and the heuristic only recognises audit-shaped names.
// A table called `records`, `ledger` or `journal` therefore produced zero findings on a project
// with no protection at all -- an advisory, in a module whose own argument is that advisories do
// not change behaviour. The harness knows what the task asked for; now this uses it.
test("an unidentifiable store blocks when the task demanded immutability", () => {
  const files = { "app/models.py": 'import sqlalchemy\nclass R(Base):\n    __tablename__ = "records"\n' };

  const withoutSignal = run(files, (d) => immutabilityFailures(d));
  assert.deepEqual(withoutSignal.failures, [], "not in scope when the task did not ask for it");
  assert.equal(withoutSignal.advisories.length, 1);

  // With the signal on, the store is in scope whatever it is called, so the failure names the
  // actual store and the actual missing control rather than reporting that nothing was found.
  // The name heuristic exists to avoid false positives on projects that are not record-keeping
  // systems, and that risk is gone once the task says immutability is required.
  const withSignal = run(files, (d) => immutabilityFailures(d, { taskRequiresImmutability: true }));
  assert.equal(withSignal.failures.length, 1);
  assert.match(withSignal.failures[0], /table "records"/);
  assert.match(withSignal.failures[0], /TRUNCATE does not fire row-level triggers/);
});

// The "nothing found at all" path still has to block when the task demanded immutability -- a
// project storing nothing durable fails the requirement as surely as one storing it unprotected.
test("a project with no store at all still blocks when immutability was required", () => {
  const { failures } = run(
    { "app/main.py": "from fastapi import FastAPI\napp = FastAPI()\n" },
    (d) => immutabilityFailures(d, { taskRequiresImmutability: true })
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no append-only store could be identified/);
});

// A second benchmark task requires exactly this property without ever using the word: "its
// contents must stay exactly as received", "Nothing in the running system should be able to change
// or remove a record". Testing only for /immutab/i would have downgraded the gate to advisory on
// the task it most needed to hold.
test("the task signal survives a task that never says the word", () => {
  assert.equal(
    taskRequiresImmutability("Once a callback has been recorded, its contents must stay exactly as received."),
    true
  );
  assert.equal(
    taskRequiresImmutability("Nothing in the running system should be able to change or remove a record."),
    true
  );
  assert.equal(taskRequiresImmutability("Build a CRUD todo app where users edit and delete their todos."), false);
  assert.equal(taskRequiresImmutability("Write a REST API for projects and tasks."), false);
});

// A project that genuinely has no audit store must not be dragged in by the same signal once a
// real, protected store is present.
test("the task signal does not override a store that is actually protected", () => {
  const { failures } = run(
    {
      "app/models.py": 'import sqlalchemy\nclass L(Base):\n    __tablename__ = "audit_logs"\n',
      "db/init.sql":
        "CREATE TRIGGER t BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION f();\n" +
        "CREATE TRIGGER d BEFORE DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION f();\n" +
        "RAISE EXCEPTION 'no';\nREVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM app_role;\n",
    },
    (d) => immutabilityFailures(d, { taskRequiresImmutability: true })
  );
  assert.deepEqual(failures, []);
});

// `=` is Python's assignment; `:` is a JavaScript object literal, which is how the AWS SDK v3 takes
// it. Requiring `=` cost a whole run: a TypeScript deliverable wrote the condition in round 1, this
// check called it missing in all five validation rounds, and the model rewrote that one file six
// times trying to satisfy a condition it had already met.
test("a DynamoDB condition written as an object literal counts", () => {
  const { failures } = run(
    {
      "src/services/dynamodb.ts":
        "import { PutCommand } from '@aws-sdk/lib-dynamodb';\n" +
        "const TABLE = 'webhook_records';\n" +
        "export async function save(id, payload) {\n" +
        "  const command = new PutCommand({\n" +
        "    TableName: TABLE,\n" +
        "    Item: { eventId: id, payload },\n" +
        '    ConditionExpression: "attribute_not_exists(eventId)",\n' +
        "  });\n};\n",
      "terraform/main.tf":
        'resource "aws_dynamodb_table" "webhook_records" {}\n' +
        'resource "aws_iam_role_policy" "p" { policy = jsonencode({ Action = ["dynamodb:PutItem","dynamodb:GetItem"] }) }\n',
    },
    (d) => immutabilityFailures(d, { taskRequiresImmutability: true })
  );
  assert.deepEqual(failures, []);
});
