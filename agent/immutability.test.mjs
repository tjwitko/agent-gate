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

// --- the webhook-8 false-positive cascade ---------------------------------------------------------
// One Qwen run produced four immutability findings, none about the store the task describes, and
// two carrying advice that would BREAK the system if followed. Each cause is pinned below.

const REQ = { required: true };

test("an indented local list is not the project's record store", () => {
  const { stores } = run(
    {
      "app/database.py":
        "def build_query(filters):\n" +
        "        params = []\n" +
        "        for f in filters:\n" +
        "            params.append(f)\n" +
        "        return params\n",
    },
    (d) => checkImmutability(d, REQ)
  );
  assert.deepEqual(stores.filter((s) => s.kind === "in-memory"), []);
});

test("a module-level collection that is appended to is still a store", () => {
  const { stores } = run(
    { "app/main.py": "records = []\n\ndef add(r):\n    records.append(r)\n" },
    (d) => checkImmutability(d, REQ)
  );
  assert.equal(stores.filter((s) => s.kind === "in-memory").length, 1);
});

// The append test was file-wide: any .append() anywhere corroborated any empty collection anywhere.
test("an unrelated append does not corroborate an unrelated collection", () => {
  const { stores } = run(
    { "app/main.py": "cache = {}\n\ndef add(r):\n    other_list.append(r)\n" },
    (d) => checkImmutability(d, REQ)
  );
  assert.deepEqual(stores.filter((s) => s.kind === "in-memory"), []);
});

test("prose about a table is not a table", () => {
  const { stores } = run(
    {
      "app/database.py":
        "import psycopg2\n" +
        "# Create table with immutable constraints\n" +
        'cursor.execute("""\n    CREATE TABLE IF NOT EXISTS callbacks (\n      id TEXT PRIMARY KEY\n    )\n""")\n',
    },
    (d) => checkImmutability(d, REQ)
  );
  const rel = stores.find((s) => s.kind === "relational");
  assert.ok(rel, "the real table should still be found");
  assert.match(rel.evidence, /callbacks/);
  assert.doesNotMatch(rel.evidence, /"with"/);
});

// Terraform's own backend is not the application's record store. Object Lock on a state bucket and
// attribute_not_exists on a lock table would break Terraform, so this advice was worse than absent.
test("the Terraform state bucket and lock table are not record stores", () => {
  const { stores, unknown } = run(
    {
      "app/main.py": "import boto3\n",
      "terraform/backend.tf":
        'resource "aws_s3_bucket" "terraform_state" {\n  bucket = "tf-state"\n}\n\n' +
        'resource "aws_dynamodb_table" "terraform_locks" {\n  name = "tf-locks"\n}\n',
    },
    (d) => checkImmutability(d, REQ)
  );
  assert.deepEqual(stores.filter((s) => /terraform/.test(s.evidence)), []);
  assert.ok(unknown, "with only plumbing present, it must say it found nothing rather than pass");
});

test("a real store declared after the plumbing is still the one reported", () => {
  const { stores } = run(
    {
      "app/main.py": "import boto3\n",
      "terraform/backend.tf": 'resource "aws_s3_bucket" "terraform_state" {\n  bucket = "tf-state"\n}\n',
      "terraform/s3.tf": 'resource "aws_s3_bucket" "audit_logs" {\n  bucket = "audit"\n}\n',
    },
    (d) => checkImmutability(d, REQ)
  );
  const s3 = stores.find((s) => s.kind === "s3");
  assert.ok(s3);
  assert.match(s3.evidence, /audit_logs/);
});

// --- a mention of dynamodb is not a use of dynamodb ------------------------
// A commented-out `dynamodb_table` in a terraform backend block -- state locking, not a data store
// -- made this check report a "boto3 dynamodb client" in a TypeScript project with no Python and
// no DynamoDB, and block on a ConditionExpression for a table that does not exist. It then never
// looked at the store the project actually had.
const TS_POSTGRES_STORE = {
  "src/db/database.ts": `
    import { Pool } from 'pg';
    export class Database {
      async initialize() {
        await this.pool.query(\`
          CREATE TABLE IF NOT EXISTS webhooks (
            id UUID PRIMARY KEY,
            event_id VARCHAR(255) NOT NULL,
            UNIQUE(event_id, provider_id)
          );
        \`);
        await this.pool.query(\`
          CREATE OR REPLACE FUNCTION prevent_webhook_modification() RETURNS TRIGGER AS $$
          BEGIN RAISE EXCEPTION 'Webhooks are immutable'; END;
          $$ LANGUAGE plpgsql;
          CREATE TRIGGER no_modify BEFORE UPDATE OR DELETE ON webhooks
            FOR EACH ROW EXECUTE FUNCTION prevent_webhook_modification();
        \`);
      }
    }`,
  "terraform/backend.tf": `
    terraform {
      # backend "s3" {
      #   bucket         = "webhook-receiver-terraform-state"
      #   dynamodb_table = "webhook-receiver-terraform-locks"
      # }
    }`,
  "terraform/main.tf": `resource "aws_rds_cluster" "main" { engine = "aurora-postgresql" }`,
};

test("a commented-out terraform lock table is not a DynamoDB store", () => {
  run(TS_POSTGRES_STORE, (dir) => {
    const r = checkImmutability(dir, { required: true });
    assert.equal(r.stores.filter((s) => s.kind === "dynamodb").length, 0);
  });
});

test("a node-postgres store behind an Aurora cluster is found and judged", () => {
  run(TS_POSTGRES_STORE, (dir) => {
    const r = checkImmutability(dir, { required: true });
    const rel = r.stores.find((s) => s.kind === "relational");
    assert.ok(rel, "the relational store was not identified at all");
    assert.match(rel.evidence, /webhooks/);
    // The trigger is present and must be credited; the REVOKE is genuinely absent.
    assert.match(rel.missing, /REVOKE/);
    assert.doesNotMatch(rel.missing, /BEFORE UPDATE and BEFORE DELETE trigger/);
  });
});

test("a real DynamoDB client is still detected", () => {
  run(
    {
      "src/store.ts":
        'import { DynamoDBClient } from "@aws-sdk/client-dynamodb";\n' +
        'await client.send(new PutItemCommand({ TableName: "audit_log", Item: item }));',
      "main.tf": 'resource "aws_dynamodb_table" "audit_log" { name = "audit_log" }',
    },
    (dir) => {
      const r = checkImmutability(dir, { required: true });
      assert.ok(r.stores.some((s) => s.kind === "dynamodb"), "a declared table went undetected");
    }
  );
});

// --- a ConditionExpression reached through a variable ---------------------
// Go's SDK field is a *string, so the idiomatic form takes the address of a local. A deliverable
// wrote exactly that and spent three commits rewriting it: its first version used aws.String(...),
// which this check accepts, and trying to satisfy the check it moved AWAY from the accepted form
// twice, renaming the variable on the last attempt to make the intent "more explicit". Every
// version was correct. Fourth language, fourth spelling, and the first to destroy work rather than
// merely block it.
const GO_STORE = (putItem) => ({
  "main.go": `
    package main
    import ("github.com/aws/aws-sdk-go-v2/service/dynamodb")
    func record(a *App, item map[string]types.AttributeValue) error {
      ${putItem}
      return err
    }`,
  "main.tf": `resource "aws_dynamodb_table" "callbacks" {
    name = "callbacks"
    deletion_protection_enabled = true
  }`,
});

const guarded = (r) => r.stores.filter((s) => s.kind === "dynamodb" && !s.protected);

for (const [label, put] of [
  ["address of a local", `immutabilityProtection := "attribute_not_exists(event_id)"
      _, err := a.db.PutItem(ctx, &dynamodb.PutItemInput{ Item: item, ConditionExpression: &immutabilityProtection })`],
  ["aws.String helper", `_, err := a.db.PutItem(ctx, &dynamodb.PutItemInput{ Item: item, ConditionExpression: aws.String("attribute_not_exists(event_id)") })`],
  ["plain identifier", `cond := "attribute_not_exists(event_id)"
      _, err := a.db.PutItem(ctx, &dynamodb.PutItemInput{ Item: item, ConditionExpression: cond })`],
]) {
  test(`a conditional write is recognised: ${label}`, () => {
    run(GO_STORE(put), (dir) => {
      const r = checkImmutability(dir, { required: true });
      const missing = guarded(r).filter((s) => /ConditionExpression/.test(s.missing || ""));
      assert.equal(missing.length, 0, `${label} was reported as missing its condition`);
    });
  });
}

// Loosening a blocking check risks accepting something that is not protection. The identifier must
// be assigned a string that actually contains attribute_not_exists -- a name that sounds right is
// not evidence.
test("an identifier that is never assigned the condition is not protection", () => {
  run(
    GO_STORE(`immutabilityProtection := "event_id = :id"
      _, err := a.db.PutItem(ctx, &dynamodb.PutItemInput{ Item: item, ConditionExpression: &immutabilityProtection })`),
    (dir) => {
      const r = checkImmutability(dir, { required: true });
      assert.ok(
        guarded(r).some((s) => /ConditionExpression/.test(s.missing || "")),
        "a condition that does not test existence must still be reported"
      );
    }
  );
});

test("no ConditionExpression at all is still reported", () => {
  run(
    GO_STORE(`_, err := a.db.PutItem(ctx, &dynamodb.PutItemInput{ Item: item })`),
    (dir) => {
      const r = checkImmutability(dir, { required: true });
      assert.ok(guarded(r).some((s) => /ConditionExpression/.test(s.missing || "")));
    }
  );
});

// --- the requirement, without crossing a clause ---------------------------
// The proximity span used [^.]{0,60}, which stops at a full stop and runs straight through a
// semicolon and a newline. "Users cannot register themselves; an admin adds them and can later
// remove an account" was read as a requirement that records be immutable -- and the consequence is
// blocking: once the gate believes immutability was required, a project with no identifiable
// append-only store fails outright. An ordinary sentence in a task description could stop correct
// work from completing.
//
// secret-rotation and the shared task-phrases matcher already spell this [^.;\n], each after the
// same bug was found there. This was the oldest requirement-reader and the last to get it.
const REQUIRES = [
  "Once a callback has been recorded, its contents must stay exactly as received.",
  "Nothing in the running system should be able to change or remove a record.",
  "A stored callback must not be modified after it is written.",
  "The audit log is immutable.",
  "Records are append-only.",
  "Write-once storage for the receipts.",
];
for (const task of REQUIRES) {
  test(`an immutability requirement is recognised: ${task.slice(0, 44)}`, () => {
    assert.equal(taskRequiresImmutability(task), true, task);
  });
}

const DOES_NOT_REQUIRE = [
  "Support lookups by event id.",
  "Users can update their profile.",
  // Each of these crossed a clause boundary before the span was constrained.
  "Users cannot register themselves; an admin adds them and can later remove an account.",
  "The service must not restart during a deploy; rolling updates change one pod at a time.",
  "A request may not exceed 1MB; larger payloads are truncated before we modify the record store.",
  "The queue must not back up\nworkers delete messages after processing.",
];
for (const task of DOES_NOT_REQUIRE) {
  test(`no immutability requirement is invented from: ${task.slice(0, 44)}`, () => {
    assert.equal(taskRequiresImmutability(task), false, task);
  });
}
