import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { declaredFixtures, fixtureReason, isDeclaredFixture, FIXTURE_MARKERS } from "./fixture-markers.mjs";

function scratch(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "fixture-markers-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const mark = (dir, file, body) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), body);
};

// A security tool's own fixtures are broken on purpose. terraform-guard's fixtures/aws-insecure is
// what proves its scanner works, and the gate planned it and reported the finding it was written to
// produce — so the two repositories that most obviously should pass the gate could not.
test("a marked directory is a declared fixture", () => {
  scratch((root) => {
    const d = path.join(root, "fixtures", "aws-insecure");
    mark(d, ".tfguard-fixture", "Insecure on purpose: proves the scanner detects insecurity.\n");
    assert.equal(isDeclaredFixture(d), true);
    assert.match(fixtureReason(d).reason, /Insecure on purpose/);
    assert.equal(fixtureReason(d).marker, ".tfguard-fixture");
  });
});

test("both marker names are recognised", () => {
  scratch((root) => {
    for (const m of FIXTURE_MARKERS) {
      const d = path.join(root, m.replace(".", ""));
      mark(d, m, "deliberately unrepresentative\n");
      assert.equal(isDeclaredFixture(d), true, `${m} must be honoured`);
    }
  });
});

// The escape hatch gets the same treatment as identity-guard's own: a marker with nothing in it
// exempts nothing. Told to remove an exemption, a model once emptied the file instead.
test("a blank marker exempts nothing", () => {
  scratch((root) => {
    const d = path.join(root, "fixtures");
    mark(d, ".identity-exception", "   \n\n");
    assert.equal(isDeclaredFixture(d), false);
  });
});

test("a comment-only marker exempts nothing", () => {
  scratch((root) => {
    const d = path.join(root, "fixtures");
    mark(d, ".identity-exception", "# TODO: explain this\n# later\n");
    assert.equal(isDeclaredFixture(d), false);
  });
});

test("an unmarked directory is not a fixture", () => {
  scratch((root) => {
    const d = path.join(root, "src");
    mkdirSync(d, { recursive: true });
    assert.equal(isDeclaredFixture(d), false);
    assert.equal(fixtureReason(d), null);
  });
});

test("declaredFixtures reports the path, the reason and which marker", () => {
  scratch((root) => {
    mark(path.join(root, "fixtures", "aws-insecure"), ".tfguard-fixture", "proves the scanner works\n");
    mkdirSync(path.join(root, "src"), { recursive: true });
    const found = declaredFixtures(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].path, path.join("fixtures", "aws-insecure"));
    assert.equal(found[0].reason, "proves the scanner works");
    assert.equal(found[0].marker, ".tfguard-fixture");
  });
});

// Reporting a marked directory and then each of its marked children would say the same thing
// several times, and the whole subtree is out of scope either way.
test("it does not descend into a declared fixture", () => {
  scratch((root) => {
    const outer = path.join(root, "fixtures");
    mark(outer, ".identity-exception", "scanner test data\n");
    mark(path.join(outer, "violating"), ".tfguard-fixture", "also deliberate\n");
    const found = declaredFixtures(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "fixtures");
  });
});

// The scan root is refused for the reason identity-guard refuses one there: at the root, the scope
// of "this one directory, for this reason" is the entire project.
test("a marker at the scan root exempts nothing", () => {
  scratch((root) => {
    writeFileSync(path.join(root, ".tfguard-fixture"), "the whole project, apparently\n");
    assert.deepEqual(declaredFixtures(root), []);
  });
});
