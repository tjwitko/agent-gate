import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { localTools, validateProject, unavailableCheckers, UNAVAILABLE } from "./agent-loop.mjs";

function project(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "buildcheck-"));
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

/**
 * Runs the real validator with build_check stubbed and every other control absent, then reports
 * only what build_check contributed. validateProject runs the whole suite, so the other validators
 * raise findings of their own about these throwaway directories -- counting all of them would make
 * these assertions depend on checks that are not under test.
 */
async function gate(dir, buildCheckOutput) {
  const registry = new Map();
  registry.set("build_check", { kind: "local", run: () => buildCheckOutput });
  const r = await validateProject(dir, registry, "");
  return {
    ...r,
    buildFailures: r.failures.filter((f) => f.startsWith("build_check:")),
  };
}

const buildCheck = (dir) => String(localTools(dir, null).build_check.run({}));

// The three states a checker can be in. The defect this file exists for is that the middle one did
// not exist: every non-zero exit was read as evidence about the code, and `spawnSync` returns
// status null when the binary is absent -- which is not zero.
test("clean code passes", () => {
  project({ "a.js": "export const x = 1;\n" }, (dir) => {
    const out = buildCheck(dir);
    assert.match(out, /javascript syntax: OK/);
    assert.ok(!out.includes(UNAVAILABLE), out);
  });
});

test("broken code is reported as broken", () => {
  project({ "a.js": "function ( {{{\n" }, (dir) => {
    const out = buildCheck(dir);
    assert.match(out, /javascript SYNTAX ERRORS/);
    assert.ok(!out.includes(UNAVAILABLE), out);
  });
});

test("a checker that could not run is neither a finding nor a pass", async () => {
  await project({ "a.js": "export const x = 1;\n" }, async (dir) => {
    const r = await gate(dir, `${UNAVAILABLE}: ruff is not installed or not on PATH, so the Python static check did not run.`);
    assert.equal(r.buildFailures.length, 0, "must not block on a checker that never read the code");
    assert.equal(r.couldNotRun.length, 1);
    assert.match(r.couldNotRun[0], /ruff is not installed/);
  });
});

// The exact shape of the original defect: an absent ruff produced the word ERRORS with an empty
// body, and the blocking test matched on the word. A project whose code is fine failed on a
// machine that merely lacked a linter.
test("an unavailable checker is not matched by the blocking test", async () => {
  await project({ "a.py": "x = 1\n" }, async (dir) => {
    const r = await gate(dir, [
      "python syntax: OK (1 files)",
      `${UNAVAILABLE}: ruff is not installed or not on PATH, so the Python static check did not run.`,
    ].join("\n"));
    assert.equal(r.buildFailures.length, 0);
    assert.equal(r.couldNotRun.length, 1);
  });
});

// The mirror-image half. A missing Go toolchain used to emit a sentence matching none of the
// blocking patterns, so it read as success -- the silent pass this control set exists to remove.
test("an unavailable toolchain does not read as a pass", async () => {
  await project({ "main.go": "package main\n" }, async (dir) => {
    const r = await gate(dir, `${UNAVAILABLE}: docker is not installed or not on PATH, so the Go build did not run.`);
    assert.equal(r.buildFailures.length, 0);
    assert.ok(r.couldNotRun.length > 0, "must make the run incomplete rather than silently pass");
  });
});

// Real findings and an unavailable checker in the same output: one must not mask the other.
test("a real failure still blocks when another checker could not run", async () => {
  await project({ "a.js": "x(\n" }, async (dir) => {
    const r = await gate(dir, [
      "javascript SYNTAX ERRORS:\na.js: unexpected end of input",
      `${UNAVAILABLE}: ruff is not installed or not on PATH, so the Python static check did not run.`,
    ].join("\n"));
    assert.equal(r.buildFailures.length, 1, "the real defect must still block");
    assert.equal(r.couldNotRun.length, 1, "and the unavailable checker must still be reported");
    assert.ok(!r.buildFailures[0].includes(UNAVAILABLE), "the blocking text must not carry the marker");
  });
});

test("unavailableCheckers reads only its own marker", () => {
  assert.deepEqual(unavailableCheckers("javascript syntax: OK (2 files)"), []);
  assert.deepEqual(
    unavailableCheckers(`${UNAVAILABLE}: ruff missing.\njavascript syntax: OK`),
    ["ruff missing."]
  );
  // A finding that merely mentions the words must not be mistaken for the marker, which is why
  // detection is anchored to the start of the line rather than a substring search.
  assert.deepEqual(unavailableCheckers("python STATIC ERRORS:\n  the test COULD NOT RUN: see above"), []);
});
