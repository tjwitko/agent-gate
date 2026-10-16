import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { toolchain, toolchainDrift } from "./toolchain.mjs";

const NAMES = ["node", "go", "terraform", "gitleaks", "osv-scanner", "checkov", "python3", "ruff", "semgrep", "pytest", "docker"];

// A PATH holding only the stand-ins given, so what is absent is known rather than whatever this
// machine happens to lack.
function fakePath(tools) {
  const bin = mkdtempSync(path.join(tmpdir(), "toolchain-"));
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  }
  return bin;
}

test("every tool is reported, and a missing one is null rather than left out", async () => {
  const bin = fakePath({ semgrep: 'echo "1.180.0"' });
  try {
    const t = await toolchain({ env: { PATH: bin } });
    assert.deepEqual(Object.keys(t), NAMES);
    assert.equal(t.semgrep, "1.180.0");
    for (const n of NAMES.filter((n) => !["node", "semgrep"].includes(n))) assert.equal(t[n], null, n);
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test("present but unreadable is 'unknown', not absent; failing to start is absent", async () => {
  const bin = fakePath({
    ruff: 'echo "ruff, a build from main"',
    gitleaks: 'echo "8.30.1"; exit 1',
    // python3 is there; the pytest module is not -- the interpreter exits non-zero.
    python3: 'if [ "$1" = "-m" ]; then echo "No module named pytest" >&2; exit 1; fi; echo "Python 3.14.8"',
  });
  try {
    const t = await toolchain({ env: { PATH: bin } });
    assert.equal(t.ruff, "unknown");
    assert.equal(t.gitleaks, null, "a probe that exits non-zero did not find a working tool");
    assert.equal(t.python3, "3.14.8");
    assert.equal(t.pytest, null, "an interpreter without the module is not pytest");
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test("the probes run side by side, not one after another", async () => {
  const slow = '/bin/sleep 1; echo "1.0.0"';
  const bin = fakePath({ go: slow, terraform: slow, gitleaks: slow, semgrep: slow, ruff: slow, checkov: slow });
  try {
    const started = Date.now();
    const t = await toolchain({ env: { PATH: bin } });
    assert.equal(t.go, "unknown", "ran, and answered with nothing `go version` would print");
    assert.equal(t.semgrep, "1.0.0");
    const took = Date.now() - started;
    assert.ok(took >= 1000, `took ${took}ms: the stand-ins did not sleep, so this measured nothing`);
    assert.ok(took < 4000, `took ${took}ms for six one-second probes`);
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test("drift names what appeared, what vanished and what moved", () => {
  const d = toolchainDrift({ go: "1.27.1", semgrep: null, ruff: "0.16.2" }, { go: null, semgrep: "1.180.0", ruff: "0.17.0" });
  assert.equal(d.length, 3);
  assert.match(d[0], /go: recorded 1\.27\.1, ABSENT here/);
  assert.match(d[1], /semgrep: absent when recorded, 1\.180\.0 here/);
  assert.match(d[2], /ruff: recorded 0\.16\.2, 0\.17\.0 here/);
  assert.deepEqual(toolchainDrift(null, {}), []);
});
