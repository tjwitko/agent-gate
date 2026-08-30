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
