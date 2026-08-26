import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import path from "path";

import { ARTIFACT_PATTERNS, ensureGitignore, isArtifact, ensureRepo } from "./commit-gate.mjs";

const tmp = () => mkdtempSync(path.join(tmpdir(), "commit-gate-"));

// isArtifact decides what the uncommitted-work gate counts as the model's work. A false negative
// makes the gate unsatisfiable -- the run cannot commit build output it did not create and cannot
// pass -- and a false positive lets real work go uncommitted while reporting success. Both have
// happened.
test("build output is not work", () => {
  for (const p of [
    "agent-run-report.json",
    "app/__pycache__/main.cpython-314.pyc",
    "terraform/.terraform/providers/registry.terraform.io/hashicorp/aws/x",
    "terraform/.external_modules/github.com/terraform-aws-modules/x/main.tf",
    "terraform/terraform.tfstate",
    "terraform/terraform.tfstate.backup",
    "node_modules/left-pad/index.js",
    ".venv/lib/python3.12/site-packages/x.py",
  ]) {
    assert.equal(isArtifact(p), true, p);
  }
});

test("the model's own files are work, including lookalikes", () => {
  for (const p of [
    "app/main.py",
    "terraform/main.tf",
    "schema.sql",
    "k8s/deployment.yaml",
    // Not build output: a source directory whose name merely contains one of the markers.
    "app/terraform_helpers.py",
    "docs/node_modules_guide.md",
  ]) {
    assert.equal(isArtifact(p), false, p);
  }
});

// Every pattern the generated .gitignore claims to cover must actually be recognised by the gate,
// or the two disagree about the same file: ignored by git, still counted as owed work.
test("the gitignore patterns and the gate agree", () => {
  for (const pattern of ARTIFACT_PATTERNS) {
    const sample = pattern.endsWith("/")
      ? `${pattern}some/file.txt`
      : pattern.startsWith("*")
        ? `dir/file${pattern.slice(1)}`
        : pattern;
    assert.equal(isArtifact(sample), true, `${pattern} -> ${sample}`);
  }
});

test("an existing .gitignore is never overwritten", () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, ".gitignore"), "# the project's own\nsecrets/\n");
    ensureGitignore(dir);
    assert.match(readFileSync(path.join(dir, ".gitignore"), "utf8"), /the project's own/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing .gitignore is written with the artifact patterns", () => {
  const dir = tmp();
  try {
    ensureGitignore(dir);
    const written = readFileSync(path.join(dir, ".gitignore"), "utf8");
    for (const pattern of ARTIFACT_PATTERNS) assert.ok(written.includes(pattern), pattern);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The failure this exists for: a run made 26 write_file calls and 4 git_commit calls into a plain
// directory, committed nothing, and reported validation PASSED. git_commit cannot create the
// repository itself, because it fails in exactly the case that needs it.
test("a plain directory is initialized so there is something to commit into", () => {
  const dir = tmp();
  try {
    assert.equal(existsSync(path.join(dir, ".git")), false);
    assert.equal(ensureRepo(dir), true);
    assert.equal(spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing repository is left alone", () => {
  const dir = tmp();
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "t@e"], { cwd: dir });
    writeFileSync(path.join(dir, "marker"), "x");
    assert.equal(ensureRepo(dir), true);
    assert.ok(existsSync(path.join(dir, "marker")), "must not reinitialize or clear anything");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// When it cannot be made a repository, it says so rather than claiming success -- the gate then
// refuses to pass, which is the fail-closed direction.
test("a directory that cannot become a repository reports false", () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, ".git"), "not a gitfile");
    assert.equal(ensureRepo(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
