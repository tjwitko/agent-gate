import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { existsSync } from "fs";

import { detectSuite, runTests, testExecutionReport, parseCountsForTest } from "./test-execution.mjs";

function run(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "testexec-"));
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

const PASSING = `
  import test from "node:test";
  import assert from "node:assert/strict";
  test("adds", () => { assert.equal(1 + 1, 2); });
`;
const FAILING = `
  import test from "node:test";
  import assert from "node:assert/strict";
  test("a genuine callback is accepted", () => { assert.equal(1 + 1, 2); });
  test("a forged callback is rejected", () => { assert.equal(1 + 1, 3); });
`;

test("a passing suite is executed and reported as passing", () => {
  run({ "package.json": "{}", "src/a.test.mjs": PASSING }, (dir) => {
    const r = testExecutionReport(dir, { wanted: true });
    assert.equal(r.failures.length, 0);
    assert.match(r.advisories[0], /ran under node --test/);
    assert.match(r.advisories[0], /1 of 1 passed/);
  });
});

test("a failing suite blocks and names which tests failed", () => {
  run({ "package.json": "{}", "src/a.test.mjs": FAILING }, (dir) => {
    const r = testExecutionReport(dir, { wanted: true });
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /1 of 2 test\(s\) FAILED/);
    assert.match(r.failures[0], /a forged callback is rejected/);
    // The passing test must not be listed as a failure.
    assert.doesNotMatch(r.failures[0], /a genuine callback is accepted/);
  });
});

// The Haiku deliverable's exact state: a jest config, a test file, and no installed toolchain.
// Reported, never blocking -- a missing node_modules is an environment fact, and failing work that
// may be correct is how a gate gets switched off.
test("a declared runner that is not installed is reported, not blocked on", () => {
  run(
    {
      "package.json": JSON.stringify({ devDependencies: { jest: "^29.7.0" } }),
      "src/__tests__/a.test.ts": "it('x', () => {});",
    },
    (dir) => {
      const r = testExecutionReport(dir, { wanted: true });
      assert.equal(r.failures.length, 0);
      assert.match(r.advisories[0], /NOT EXECUTED/);
      assert.match(r.advisories[0], /jest.*not installed/s);
      assert.match(r.advisories[0], /npm install/);
    }
  );
});

test("a project with no tests at all is reported as having none to run", () => {
  run({ "package.json": "{}", "src/index.mjs": "export const x = 1;" }, (dir) => {
    const r = testExecutionReport(dir, { wanted: true });
    assert.equal(r.failures.length, 0);
    assert.match(r.advisories[0], /no test files were found/);
  });
});

test("nothing runs when the task did not ask for tests", () => {
  run({ "package.json": "{}", "src/a.test.mjs": FAILING }, (dir) => {
    const r = testExecutionReport(dir, { wanted: false });
    assert.deepEqual(r, { failures: [], advisories: [] });
  });
});

// The command that starts the suite must never be one the project wrote. `scripts.test` is a
// model-authored shell string; build_check's precedent is to call known tools by name.
test("a hostile scripts.test is never the command that runs", () => {
  run(
    {
      "package.json": JSON.stringify({ scripts: { test: "touch PWNED && exit 0" } }),
      "src/a.test.mjs": PASSING,
    },
    (dir) => {
      const suite = detectSuite(dir);
      assert.doesNotMatch(JSON.stringify(suite), /PWNED|npm/);
      assert.equal(suite.label, "node --test");
      testExecutionReport(dir, { wanted: true });
      assert.equal(existsSync(path.join(dir, "PWNED")), false);
    }
  );
});

test("a suite that hangs is killed and reported, not treated as passing", () => {
  run(
    {
      "package.json": "{}",
      "src/a.test.mjs": `
        import test from "node:test";
        test("hangs", async () => { await new Promise(() => {}); });
      `,
    },
    (dir) => {
      const r = runTests(dir, { timeoutMs: 2000 });
      assert.equal(r.ran, false);
      assert.equal(r.timedOut, true);
      assert.match(r.unavailable, /did not finish/);
    }
  );
});

// --- counter parsing, against each runner's real summary ------------------
// vitest's all-passing summary reported a nine-test suite as "1 of 1 passed": the anchored vitest
// pattern required a `N failed |` segment that was not there, so parsing fell through to the loose
// counter, which matched the "Test Files  1 passed (1)" line printed just above. An undercount that
// still says "passed" is the kind of wrong answer nobody goes looking for.
const E = "\u001B[";
const SUMMARIES = [
  ["vitest, all passing", " Test Files  1 passed (1)\n      Tests  9 passed (9)\n", { passed: 9, failed: 0, total: 9 }],
  ["vitest, with failures", " Test Files  1 failed (1)\n      Tests  3 failed | 6 passed (9)\n", { passed: 6, failed: 3, total: 9 }],
  ["vitest, coloured", `${E}2m Test Files ${E}22m ${E}32m1 passed${E}39m (1)\n${E}2m      Tests ${E}22m ${E}32m9 passed${E}39m (9)\n`, { passed: 9, failed: 0, total: 9 }],
  ["jest", "Tests:       3 failed, 9 passed, 12 total\n", { passed: 9, failed: 3, total: 12 }],
  ["node --test", "\u2139 tests 21\n\u2139 suites 0\n\u2139 pass 21\n\u2139 fail 0\n", { passed: 21, failed: 0, total: 21 }],
  ["pytest", "3 failed, 9 passed in 0.42s\n", { passed: 9, failed: 3, total: 12 }],
];

for (const [label, output, expected] of SUMMARIES) {
  test(`the ${label} summary is counted correctly`, () => {
    assert.deepEqual(parseCountsForTest(output), expected);
  });
}
