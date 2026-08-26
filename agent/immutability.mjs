// Blocking check for the one requirement this harness has never managed to enforce.
//
// Across nineteen runs of an "immutable audit log" task, not one deliverable implemented an
// immutability control before review. That is not forgetfulness: the model states its reasoning in
// its own comments -- "The logs are immutable as the service only provides endpoints for adding and
// reading logs" -- and the reasoning is locally coherent. It is deciding that the API surface IS
// the control, which is true only if this client is the sole thing holding the credential.
//
// Advisory findings did not change that in any run. Blocking ones did, reliably: in the same run
// where immutability was advised and ignored, five refused write_file calls on a hardcoded
// credential moved the project to AWS Secrets Manager. So this check exists to move immutability
// from the column that gets ignored into the column that gets fixed.
//
// Two rules shape everything here:
//
//  1. **An undetermined answer is not a pass.** If the storage cannot be identified, this reports
//     `unknown` and the caller surfaces it -- it never silently succeeds. Every silent-success bug
//     found in this stack came from a check that could not run saying nothing.
//  2. **It only fires on a store that claims to be an audit log.** A project with an ordinary
//     `users` table is not in scope. Intent is read from the store's name, which is the only
//     evidence available without asking the model what it meant.

import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

// `.external_modules` holds Checkov's downloaded modules and lives inside the project. Reading it
// would let a third-party module's table decide this verdict, and would mean walking thousands of
// files on every gate round.
const SKIP_DIRS = new Set([
  ".git", ".terraform", ".external_modules", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
]);
const READ_EXT = new Set([".py", ".sql", ".tf", ".tfvars", ".js", ".mjs", ".ts", ".yaml", ".yml"]);

// The store is in scope only if it names itself after an audit trail. Deliberately narrow: firing
// on every table would make this noise, and noise is how a blocking check gets switched off.
const AUDIT_NAME = /(audit|auditd|log_?entr|logs?|event_?log|trail)/i;

function walk(dir, acc = [], root = dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, acc, root);
    } else if (READ_EXT.has(path.extname(e.name))) {
      try {
        if (statSync(full).size <= 512 * 1024) acc.push({ rel: path.relative(root, full), text: readFileSync(full, "utf8") });
      } catch {
        /* unreadable is not this check's problem to report */
      }
    }
  }
  return acc;
}

/**
 * Which append-only stores this project appears to use, and whether each is actually protected.
 * Returns { ran, stores: [{kind, evidence, protected, missing}], unknown }.
 */
export function checkImmutability(projectDir) {
  const files = walk(projectDir);
  if (files.length === 0) return { ran: false, stores: [], unknown: "no readable source files" };

  const all = files.map((f) => f.text).join("\n");
  // SQL wherever it lives, not only in .sql files. A run wrote a complete and correct control --
  // both triggers, the REVOKE, and a separate admin connection so the app would not own the table --
  // as SQLAlchemy text() literals inside app/database.py, and this check called it missing. That is
  // the better pattern of the two: embedded SQL that the application actually executes, against a
  // .sql file that another run shipped and nothing ever ran. Judging the mechanism by the file
  // extension it lives in measured the wrong thing.
  const sqlText = all;
  const tfText = files.filter((f) => f.rel.endsWith(".tf")).map((f) => f.text).join("\n");
  const stores = [];

  // ---- in-memory ---------------------------------------------------------
  // A process-memory list cannot be immutable and cannot be made immutable: the process that owns
  // it can rewrite it, and a restart erases it. There is no control to look for.
  const inMemory = /^\s*(\w*(?:log|audit|event)\w*)\s*(?::\s*[^=]+)?=\s*(\[\]|\{\})\s*$/im.exec(all);
  if (inMemory && /\.append\(|\.push\(/.test(all)) {
    stores.push({
      kind: "in-memory",
      evidence: `${inMemory[1]} = ${inMemory[2]}`,
      protected: false,
      missing:
        "a process-memory store cannot be immutable — the process that owns it can rewrite it, and a " +
        "restart erases every record. Move the log to a durable store before adding any control",
    });
  }

  // ---- relational (Postgres / SQLite) ------------------------------------
  const tableDecl =
    /__tablename__\s*=\s*["'](\w+)["']/i.exec(all) || /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+["']?(\w+)/i.exec(all);
  const usesRelational = /sqlalchemy|psycopg2|sqlite3|aws_db_instance/i.test(all);
  if (usesRelational && tableDecl && AUDIT_NAME.test(tableDecl[1])) {
    const hasTrigger = /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER[\s\S]{0,400}?BEFORE\s+(UPDATE|DELETE)/i.test(sqlText);
    const raises = /RAISE\s+(EXCEPTION|ABORT|FAIL)/i.test(sqlText);
    const revokes = /REVOKE\s+[^;]*\b(UPDATE|DELETE|ALL)\b/i.test(sqlText);
    const missing = [];
    if (!(hasTrigger && raises)) missing.push("a BEFORE UPDATE and BEFORE DELETE trigger that RAISEs");
    if (!revokes) missing.push("a REVOKE of UPDATE, DELETE and TRUNCATE from the application role");
    stores.push({
      kind: "relational",
      evidence: `table "${tableDecl[1]}"`,
      protected: missing.length === 0,
      missing:
        missing.join(", and ") +
        ". Both are needed: TRUNCATE does not fire row-level triggers, so the grant matters as much " +
        "as the trigger, and the application must not own the table or it can drop the trigger",
    });
  }

  // ---- DynamoDB ----------------------------------------------------------
  const ddbTable = /resource\s+"aws_dynamodb_table"\s+"(\w+)"/i.exec(tfText);
  const usesDdb = /dynamodb/i.test(all);
  if (usesDdb && (!ddbTable || AUDIT_NAME.test(ddbTable[1]))) {
    const conditional = /ConditionExpression\s*=\s*["'][^"']*attribute_not_exists/i.test(all);
    // Only judge the IAM policy if one actually grants DynamoDB actions here.
    const grants = [...tfText.matchAll(/"dynamodb:(\w+)"/g)].map((m) => m[1]);
    const mutating = grants.filter((a) => /^(DeleteItem|UpdateItem|BatchWriteItem)$/i.test(a));
    const missing = [];
    if (!conditional) {
      missing.push(
        'a ConditionExpression of "attribute_not_exists(<key>)" on every write — PutItem REPLACES an ' +
          "item whose key already exists, so without it anyone who can write can erase a record by " +
          "re-writing its id"
      );
    }
    if (mutating.length) missing.push(`removal of ${mutating.join(", ")} from the IAM policy`);
    if (grants.length === 0 && tfText) {
      missing.push("an IAM policy that grants writes without DeleteItem or UpdateItem (none found to check)");
    }
    stores.push({
      kind: "dynamodb",
      evidence: ddbTable ? `table "${ddbTable[1]}"` : "boto3 dynamodb client",
      protected: missing.length === 0,
      missing: missing.join(", and "),
    });
  }

  // ---- S3 ----------------------------------------------------------------
  const bucket = /resource\s+"aws_s3_bucket"\s+"(\w+)"/i.exec(tfText);
  if (bucket && AUDIT_NAME.test(bucket[1])) {
    const locked =
      /object_lock_enabled\s*=\s*true/i.test(tfText) ||
      /resource\s+"aws_s3_bucket_object_lock_configuration"/i.test(tfText);
    stores.push({
      kind: "s3",
      evidence: `bucket "${bucket[1]}"`,
      protected: locked,
      missing: "Object Lock, enabled on the bucket and configured with a retention mode",
    });
  }

  if (stores.length === 0) {
    return {
      ran: true,
      stores: [],
      unknown:
        "no append-only store could be identified, so nothing was checked. If this project stores " +
        "audit records, name the table, bucket or collection for what it is",
    };
  }
  return { ran: true, stores, unknown: null };
}

/** Human-readable failures for the gate. Empty array means every identified store is protected. */
export function immutabilityFailures(projectDir) {
  const report = checkImmutability(projectDir);
  if (!report.ran) return { failures: [], advisories: [`immutability: not checked — ${report.unknown}`] };
  if (report.unknown) return { failures: [], advisories: [`immutability: ${report.unknown}`] };

  const failures = report.stores
    .filter((s) => !s.protected)
    .map(
      (s) =>
        `immutability: the ${s.kind} store (${s.evidence}) has nothing preventing records from being ` +
        `changed or deleted. Missing ${s.missing}.\n` +
        `Not offering an UPDATE or DELETE endpoint is not a control — it describes this one client, ` +
        `while the credential this service holds can do both from anywhere else. The requirement asks ` +
        `for protections, so the protection has to live below the API.`
    );
  return { failures, advisories: [] };
}
