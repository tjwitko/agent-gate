import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { authenticationFailures } from "./authentication.mjs";
import { artifactPresenceFailures } from "./artifact-presence.mjs";
import { checkCodeQuality } from "./code-quality.mjs";
import { unscannedManifests } from "./unscanned-manifests.mjs";
import { localTools } from "../lib/gate-core.mjs";

// A declared fixture is out of scope for every check that reads the project's source. Six walks did
// not ask: a samples directory marked with .identity-exception still had its routes reported as
// unauthenticated endpoints and its Go file built with `go build ./...` -- which failed, at a root
// with no module. Each test below puts the same content in a fixture and expects it not to count.

const REASON = "Deliberately unrepresentative samples.\n";

function project(files, marker = REASON) {
  const dir = mkdtempSync(path.join(tmpdir(), "fixture-scope-"));
  for (const [rel, body] of Object.entries({ ...files, ...(marker === null ? {} : { "samples/.identity-exception": marker }) })) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const within = (files, fn, marker) => {
  const d = project(files, marker);
  try {
    return fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};

const ROUTE = 'from flask import Flask\napp = Flask(__name__)\n@app.get("/users")\ndef users():\n    return "[]"\n';

test("authentication: a fixture's routes are not the service's", () => {
  const r = within({ "samples/app.py": ROUTE, "index.js": "module.exports = 1;\n" }, authenticationFailures);
  assert.deepEqual(r.failures, []);
});

test("a marker with no reason exempts nothing", () => {
  const r = within({ "samples/app.py": ROUTE }, authenticationFailures, "# just a comment\n");
  assert.match(r.failures.join("\n"), /GET \/users \(samples\/app\.py:3\)/);
});

test("build_check: a fixture's Go is not built", () => {
  const out = within({ "samples/main.go": "package main\nfunc main() {}\n", "index.js": "module.exports = 1;\n" }, (d) =>
    String(localTools(d, null).build_check.run({}))
  );
  assert.doesNotMatch(out, /go /i);
  assert.match(out, /javascript syntax: OK \(1 files\)/);
});

test("build_check: a fixture's Python is neither compiled nor linted", () => {
  // An undefined name in the fixture would be a ruff F finding if ruff walked into it.
  const out = within({ "samples/bad.py": "print(undefined_name)\n", "app.py": "print(1)\n" }, (d) =>
    String(localTools(d, null).build_check.run({}))
  );
  assert.match(out, /python syntax: OK \(1 files\)/);
  assert.doesNotMatch(out, /undefined_name/);
});

test("artifact presence: a fixture's Dockerfile does not satisfy the project's requirement", () => {
  const r = within({ "samples/Dockerfile": "FROM node:24\n", "index.js": "module.exports = 1;\n" }, (d) =>
    artifactPresenceFailures(d, "Ship a Dockerfile.")
  );
  assert.match(r.failures.join("\n"), /asks for a Dockerfile, and the project contains none/);
});

test("code quality: a fixture's tests are not the project's tests", () => {
  const q = within({ "samples/a.test.js": 'test("x", () => {});\n', "index.js": "module.exports = 1;\n" }, (d) =>
    checkCodeQuality(d, "Include unit tests.")
  );
  assert.deepEqual(q.tests, []);
});

// The deliberate exception. osv-scanner reads the whole tree, fixtures included, so exempting a
// fixture's manifest from the lockfile rule could only loosen the dependency checks.
test("dependency checks still cover fixtures", () => {
  const u = within({ "samples/package.json": '{"dependencies":{"lodash":"4.17.4"}}' }, unscannedManifests);
  assert.deepEqual(u.map((x) => x.manifest), ["samples/package.json"]);
});
