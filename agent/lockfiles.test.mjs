import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import { LOCKFILES, findsLockfile } from "./lockfiles.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function project(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "lockfiles-"));
  for (const rel of files) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, "");
  }
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a lockfile at the root is found", () => {
  project(["package.json", "package-lock.json"], (d) => assert.equal(findsLockfile(d), true));
});

// The layout is the project's choice. A root-only check downgrades a properly-locked project to
// advisory, which is the failure direction that teaches people to ignore the result.
test("a lockfile in a subdirectory is found", () => {
  project(["app/go.mod", "app/go.sum"], (d) => assert.equal(findsLockfile(d), true));
});

test("a project with no lockfile is reported as having none", () => {
  project(["package.json", "src/index.js"], (d) => assert.equal(findsLockfile(d), false));
});

// node_modules carries thousands of lockfiles belonging to other people's packages. Counting one
// of those would make every npm project authoritative regardless of what it committed.
test("a lockfile inside a skipped directory does not count", () => {
  project(["package.json", "node_modules/left-pad/package-lock.json"], (d) =>
    assert.equal(findsLockfile(d), false)
  );
});

test("an unreadable directory is not a lockfile", () => {
  assert.equal(findsLockfile(path.join(tmpdir(), "definitely-not-here-" + Date.now())), false);
});

// The list is pinned because this decides whether a security control blocks. Adding a format is a
// deliberate act; losing one silently downgrades every project using it.
test("the lockfile list covers the ecosystems the gate scans", () => {
  for (const f of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "go.sum", "Cargo.lock", "poetry.lock", "Pipfile.lock", "Gemfile.lock", "composer.lock"]) {
    assert.ok(LOCKFILES.includes(f), `${f} must be recognised as a lockfile`);
  }
});

// local-copilot-stack runs the same decision at commit time from its own copy. A control that
// answers differently at two enforcement points is a bug at one of them, and the two lists drifting
// apart is how that would happen. Checked only when that checkout is present -- its absence is not
// a pass here, it simply cannot be compared, which is why the gate no longer DEPENDS on it being
// there: resolving it and returning false when missing is what disabled check_dependencies on
// every machine but one.
test("the sibling copy agrees, when there is one to compare against", async () => {
  const sibling = path.resolve(__dirname, "..", "..", "local-copilot-stack", "validate", "lockfiles.mjs");
  if (!existsSync(sibling)) {
    assert.ok(true, "local-copilot-stack is not checked out beside this repo; nothing to compare");
    return;
  }
  const other = await import(pathToFileURL(sibling).href);
  assert.deepEqual(
    [...LOCKFILES].sort(),
    [...other.LOCKFILES].sort(),
    "agent-gate and local-copilot-stack disagree about what a lockfile is"
  );
});
