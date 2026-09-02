import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { checkCodeQuality, codeQualityFailures, taskWantsTests, taskWantsErrorDistinction } from "./code-quality.mjs";

function run(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "quality-"));
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

const WANTS = "Automated tests that someone else can run. Errors distinguished from faults: a bad request is not our service failing.";
const NEUTRAL = "Build a webhook receiver.";
const APP = "@app.post('/webhook')\ndef hook():\n    return {}\n";

test("the task's wording drives both checks", () => {
  assert.equal(taskWantsTests(WANTS), true);
  assert.equal(taskWantsTests(NEUTRAL), false);
  assert.equal(taskWantsErrorDistinction(WANTS), true);
  assert.equal(taskWantsErrorDistinction(NEUTRAL), false);
});

test("no tests fails when the task asks for them", () => {
  const { failures } = run({ "app/main.py": APP }, (d) => codeQualityFailures(d, WANTS));
  assert.ok(failures.find((f) => /contains none/.test(f)));
});

// A project nobody asked to test is not defective for having none.
test("no tests is only an advisory when the task never asked", () => {
  const { failures, advisories } = run({ "app/main.py": APP }, (d) => codeQualityFailures(d, NEUTRAL));
  assert.deepEqual(failures, []);
  assert.equal(advisories.length, 1);
});

test("a real test satisfies it", () => {
  const { failures } = run(
    { "app/main.py": APP, "tests/test_sig.py": "def test_rejects_forged():\n    assert verify(b'x', 'bad') is False\n" },
    (d) => codeQualityFailures(d, WANTS)
  );
  assert.deepEqual(failures.filter((f) => /contains none/.test(f)), []);
});

// Naming alone is not enough: a file that runs code without checking anything passes whatever the
// code does, and rewarding it would teach precisely the wrong thing.
test("a test-named file with no assertion does not count", () => {
  const { failures } = run(
    { "app/main.py": APP, "tests/test_sig.py": "def test_todo():\n    pass  # TODO\n" },
    (d) => codeQualityFailures(d, WANTS)
  );
  const f = failures.find((x) => /contains none/.test(x));
  assert.ok(f);
  assert.match(f, /named like tests but contain no assertion/);
});

test("Go and JS test conventions are recognised", () => {
  for (const [name, body] of [
    ["internal/verify_test.go", "func TestVerify(t *testing.T) {\n  if !ok { t.Fatalf(\"bad\") }\n}\n"],
    ["src/verify.test.ts", "it('rejects', () => { expect(verify()).toBe(false); });\n"],
  ]) {
    const { failures } = run({ "app/main.py": APP, [name]: body }, (d) => codeQualityFailures(d, WANTS));
    assert.deepEqual(failures.filter((f) => /contains none/.test(f)), [], name);
  }
});

// --- errors reported as faults --------------------------------------------------------------------

const SWALLOWS =
  "@app.post('/webhook')\ndef hook():\n    try:\n        if not event_id:\n" +
  "            raise HTTPException(status_code=400, detail='Missing event id')\n" +
  "    except Exception as e:\n        raise HTTPException(status_code=500, detail=str(e))\n";

test("a broad catch that re-raises as 5xx is reported", () => {
  const { failures } = run({ "app/main.py": SWALLOWS, "tests/t_test.py": "def test_x():\n    assert 1\n" }, (d) =>
    codeQualityFailures(d, WANTS)
  );
  const f = failures.find((x) => /server fault/.test(x));
  assert.ok(f);
  assert.match(f, /leaking the\s+intended status/);
});

test("catching a specific exception is clean", () => {
  const good =
    "@app.post('/webhook')\ndef hook():\n    try:\n        data = json.loads(body)\n" +
    "    except json.JSONDecodeError:\n        raise HTTPException(status_code=400, detail='Invalid JSON')\n";
  const { failures } = run({ "app/main.py": good, "tests/t_test.py": "def test_x():\n    assert 1\n" }, (d) =>
    codeQualityFailures(d, WANTS)
  );
  assert.deepEqual(failures.filter((f) => /server fault/.test(f)), []);
});

test("the error finding is silent when the task never asked", () => {
  const { failures } = run({ "app/main.py": SWALLOWS }, (d) => codeQualityFailures(d, NEUTRAL));
  assert.deepEqual(failures.filter((f) => /server fault/.test(f)), []);
});

test("no source files is reported as not-checked", () => {
  const { advisories } = run({ "README.md": "hi" }, (d) => codeQualityFailures(d, WANTS));
  assert.match(advisories[0], /not checked/);
});

// --- tests are read, never run --------------------------------------------------------------------
// Three runs each produced a test file with real assertions, and all three suites failed when
// finally executed — one could not compile at all. "Tests exist" was reported as though it meant
// "tests pass", which it never did.

// The property, not the wording: finding test files must never read as the tests passing. Execution
// moved to its own check, so this advisory no longer claims the tests "were NOT executed" -- that
// would now be false -- but it still must not imply they work.
test("finding tests never reads as the tests passing", () => {
  const { advisories } = run(
    { "app/main.py": APP, "tests/test_sig.py": "def test_x():\n    assert verify(b'x', 'bad') is False\n" },
    (d) => codeQualityFailures(d, WANTS)
  );
  const a = advisories.find((x) => /test file\(s\) found and read/.test(x));
  assert.ok(a, "the presence finding must disclaim correctness");
  assert.match(a, /not what happens when they run/);
  assert.doesNotMatch(a, /\bpass(es|ing)?\b(?![^.]*not)/i);
});

test("a patch target the module does not define is reported", () => {
  const { failures } = run(
    {
      "app/main.py": "SIGNING = os.environ['S']\n" + APP,
      "tests/test_sig.py": 'from unittest.mock import patch\ndef test_x():\n    with patch("app.main.SECRET_KEY", "s"):\n        assert True\n',
    },
    (d) => codeQualityFailures(d, WANTS)
  );
  const f = failures.find((x) => /patch target/.test(x));
  assert.ok(f);
  assert.match(f, /app\/main\.py defines no SECRET_KEY/);
  assert.match(f, /AttributeError at run time/);
});

test("a patch target that does exist is clean", () => {
  const { failures } = run(
    {
      "app/main.py": "SECRET_KEY = os.environ['S']\n" + APP,
      "tests/test_sig.py": 'from unittest.mock import patch\ndef test_x():\n    with patch("app.main.SECRET_KEY", "s"):\n        assert True\n',
    },
    (d) => codeQualityFailures(d, WANTS)
  );
  assert.deepEqual(failures.filter((f) => /patch target/.test(f)), []);
});

// An attribute reached through one that exists — patch("main.table.put_item") where main defines
// `table` — is not this check's business, and neither is a target in a dependency.
test("a nested attribute on an existing binding is not reported", () => {
  const { failures } = run(
    {
      "main.py": "table = boto3.resource('dynamodb').Table('t')\n" + APP,
      "tests/test_x.py": 'from unittest.mock import patch\ndef test_x():\n    with patch("main.table.put_item"):\n        assert True\n',
    },
    (d) => codeQualityFailures(d, WANTS)
  );
  assert.deepEqual(failures.filter((f) => /patch target/.test(f)), []);
});

test("a patch target outside the project is left alone", () => {
  const { failures } = run(
    {
      "app/main.py": APP,
      "tests/test_x.py": 'from unittest.mock import patch\ndef test_x():\n    with patch("boto3.client"):\n        assert True\n',
    },
    (d) => codeQualityFailures(d, WANTS)
  );
  assert.deepEqual(failures.filter((f) => /patch target/.test(f)), []);
});

// --- the task's wording, not one phrasing of it ---------------------------
// Measured before this change: 3 of 8 rephrasings recognised, plus one false positive. Both
// triggers gate BLOCKING findings, and taskWantsTests also decides whether the suite is executed at
// all -- so a miss here silences the newest blocking check entirely.
const WANTS_TESTS = [
  "Automated tests that someone else can run.",
  "Include a test suite covering the signature check.",
  "Write unit tests for the happy path.",
  "Prove the signature check works with automated checks someone else can run.",
  "Cover the forged-callback path with specs.",
  "CI must run the suite on every commit.",
  "Ship it with coverage for the duplicate-delivery case.",
  "We need regression coverage before this goes live.",
];
for (const task of WANTS_TESTS) {
  test(`a test requirement survives being rephrased: ${task.slice(0, 40)}`, () => {
    assert.ok(taskWantsTests(task), task);
  });
}

// Widening a trigger is how false positives get made. These ask for no tests, and the last one is
// the case the old bare `tests?` invented a requirement from.
const WANTS_NO_TESTS = [
  "Build a REST API for managing users.",
  "Deploy the service to production.",
  "Run it in the test environment first.",
  "Load the test data into the staging account.",
  "Give me the deployment specs and the pod specs.",
  "Our product suite includes three services.",
];
for (const task of WANTS_NO_TESTS) {
  test(`a wider vocabulary does not invent a test requirement: ${task.slice(0, 40)}`, () => {
    assert.equal(taskWantsTests(task), false, task);
  });
}

const WANTS_ERROR_DISTINCTION = [
  "Errors distinguished from faults: a bad request from the provider is not the same as our service failing.",
  "A bad request must not be reported as a server error.",
  "Distinguish client mistakes from infrastructure faults.",
  "Return 4xx for malformed input and 5xx only when we break.",
  "Do not return 500 for a malformed payload.",
  "A caller's mistake is not an outage.",
  "Client errors and server errors must be separated.",
];
for (const task of WANTS_ERROR_DISTINCTION) {
  test(`an error-distinction requirement survives being rephrased: ${task.slice(0, 40)}`, () => {
    assert.ok(taskWantsErrorDistinction(task), task);
  });
}

// The trap the shared matcher exists to pay for: [^.]{0,80} ran through a semicolon.
const NO_ERROR_DISTINCTION = [
  "Handle errors gracefully.",
  "Log every failure.",
  "Return JSON responses.",
  "A bad request is fine; the cluster is not our concern.",
  "Distinguish the two providers; faults are logged separately.",
];
for (const task of NO_ERROR_DISTINCTION) {
  test(`a proximity pair does not cross a clause: ${task.slice(0, 40)}`, () => {
    assert.equal(taskWantsErrorDistinction(task), false, task);
  });
}
