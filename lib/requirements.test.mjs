import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

import { loadRequirements } from "./requirements.mjs";
import { localTools } from "./gate-core.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "validate.mjs");
const WANTS_TESTS = "Build a webhook receiver.\nInclude unit tests.\n";
const NO_TESTS = "Build a webhook receiver.\n";

function git(dir, ...args) {
  const r = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

// A project holding a task file and one source file, committed.
function repo(task = WANTS_TESTS) {
  const dir = mkdtempSync(path.join(tmpdir(), "requirements-"));
  writeFileSync(path.join(dir, "task.txt"), task);
  writeFileSync(path.join(dir, "index.js"), "module.exports = () => 1;\n");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

const cleanup = (d) => rmSync(d, { recursive: true, force: true });

// The case the check exists for: blocked by a requirement, delete it and commit.
test("a commit that edits the task file is blocked, and checked against the task as it was", () => {
  const d = repo();
  try {
    writeFileSync(path.join(d, "task.txt"), NO_TESTS);
    git(d, "add", "task.txt");
    const r = loadRequirements(d, path.join(d, "task.txt"), { preCommit: true });
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /this commit changes task\.txt/);
    assert.match(r.failures[0], /git commit --no-verify -- task\.txt/);
    assert.equal(r.text, WANTS_TESTS, "the requirement the commit removed is still checked");
  } finally {
    cleanup(d);
  }
});

test("a commit that deletes the task file is blocked", () => {
  const d = repo();
  try {
    git(d, "rm", "-q", "--cached", "task.txt");
    const r = loadRequirements(d, path.join(d, "task.txt"), { preCommit: true });
    assert.match(r.failures[0], /this commit deletes task\.txt/);
    assert.equal(r.text, WANTS_TESTS);
  } finally {
    cleanup(d);
  }
});

test("an unstaged edit cannot loosen the task: the committed version is what is checked", () => {
  const d = repo();
  try {
    writeFileSync(path.join(d, "task.txt"), NO_TESTS);
    const r = loadRequirements(d, path.join(d, "task.txt"), { preCommit: true });
    assert.deepEqual(r.failures, []);
    assert.equal(r.text, WANTS_TESTS);
    assert.match(r.advisories[0], /changes that are not part of this commit/);
  } finally {
    cleanup(d);
  }
});

test("adding a task file is not changing one, so a project's first commit is unaffected", () => {
  const d = mkdtempSync(path.join(tmpdir(), "requirements-"));
  try {
    git(d, "init", "-q");
    writeFileSync(path.join(d, "task.txt"), WANTS_TESTS);
    git(d, "add", "task.txt");
    const r = loadRequirements(d, path.join(d, "task.txt"), { preCommit: true });
    assert.deepEqual(r.failures, []);
    assert.equal(r.text, WANTS_TESTS);
  } finally {
    cleanup(d);
  }
});

test("outside --pre-commit, and outside a repository, the file on disk is the task", () => {
  const d = repo();
  const plain = mkdtempSync(path.join(tmpdir(), "requirements-plain-"));
  try {
    writeFileSync(path.join(d, "task.txt"), NO_TESTS);
    git(d, "add", "task.txt");
    assert.deepEqual(loadRequirements(d, path.join(d, "task.txt")), { text: NO_TESTS, taskText: NO_TESTS, baselineText: "", failures: [], advisories: [], baseline: null });
    writeFileSync(path.join(plain, "task.txt"), NO_TESTS);
    const r = loadRequirements(plain, path.join(plain, "task.txt"), { preCommit: true });
    assert.equal(r.text, NO_TESTS);
    assert.deepEqual(r.failures, []);
  } finally {
    cleanup(d);
    cleanup(plain);
  }
});

test("a baseline is appended to the task, and one inside the project is called out", () => {
  const d = repo(NO_TESTS);
  const outside = mkdtempSync(path.join(tmpdir(), "requirements-baseline-"));
  try {
    writeFileSync(path.join(outside, "baseline.txt"), "Include unit tests.\n");
    const r = loadRequirements(d, path.join(d, "task.txt"), { baselineFile: path.join(outside, "baseline.txt") });
    assert.equal(r.text, `${NO_TESTS}\n\nInclude unit tests.\n`);
    assert.deepEqual(r.advisories, []);

    writeFileSync(path.join(d, "baseline.txt"), "Include unit tests.\n");
    const inside = loadRequirements(d, null, { baselineFile: path.join(d, "baseline.txt") });
    assert.equal(inside.text, "Include unit tests.\n");
    assert.match(inside.advisories[0], /inside the project, so whoever writes the code can edit it/);
  } finally {
    cleanup(d);
    cleanup(outside);
  }
});

test("the agent loop refuses to write or delete the task file", () => {
  const d = repo();
  try {
    const tools = localTools(d, null, { protect: [path.join(d, "task.txt")] });
    assert.match(String(tools.write_file.run({ path: "task.txt", content: NO_TESTS })), /^REFUSED: task\.txt was NOT written/);
    assert.match(String(tools.delete_file.run({ path: "./task.txt" })), /^REFUSED: \.\/task\.txt was NOT deleted/);
    assert.ok(existsSync(path.join(d, "task.txt")));
    assert.doesNotMatch(String(tools.write_file.run({ path: "other.txt", content: "x\n" })), /REFUSED/);
  } finally {
    cleanup(d);
  }
});

// Through the real CLI, because the verdict is what an agent meets.
function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--json"], { encoding: "utf8", timeout: 300_000 });
  return { code: r.status, doc: JSON.parse(r.stdout), stderr: r.stderr };
}
const messages = (doc) => (doc.findings || []).map((f) => f.message).join("\n");

test("end to end: deleting the tests requirement and committing does not get past the hook", () => {
  const d = repo();
  try {
    writeFileSync(path.join(d, "task.txt"), NO_TESTS);
    git(d, "add", "task.txt");
    const r = cli([d, path.join(d, "task.txt"), "--pre-commit"]);
    // 1, or 3 where a scanner is missing -- the unit job installs only osv-scanner. Both block the
    // commit; what this test is about is the findings, not which scanners the machine has.
    assert.ok([1, 3].includes(r.code), `exit ${r.code}: ${r.stderr.slice(-400)}`);
    assert.match(messages(r.doc), /this commit changes task\.txt/);
    assert.match(messages(r.doc), /test/i, "and the removed requirement is still enforced");
  } finally {
    cleanup(d);
  }
});

test("end to end: a baseline switches on a check the task does not ask for", () => {
  const d = repo(NO_TESTS);
  const outside = mkdtempSync(path.join(tmpdir(), "requirements-baseline-"));
  try {
    const without = cli([d, path.join(d, "task.txt")]);
    writeFileSync(path.join(outside, "baseline.txt"), "Include unit tests.\n");
    const withBaseline = cli([d, path.join(d, "task.txt"), `--baseline=${path.join(outside, "baseline.txt")}`]);
    assert.ok(withBaseline.doc.blocking > without.doc.blocking, `baseline added nothing: ${without.doc.blocking} -> ${withBaseline.doc.blocking}`);
    assert.equal(withBaseline.doc.baseline, path.join(outside, "baseline.txt"));
    assert.match(messages(withBaseline.doc), /test/i);
  } finally {
    cleanup(d);
    cleanup(outside);
  }
});

test("a missing baseline file is a usage error, exit 2", () => {
  const d = repo();
  try {
    const r = spawnSync(process.execPath, [CLI, d, "--baseline=/nonexistent/baseline.txt"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /the baseline file .* does not exist/);
    const bare = spawnSync(process.execPath, [CLI, d, "--baseline"], { encoding: "utf8" });
    assert.equal(bare.status, 2);
  } finally {
    cleanup(d);
  }
});
