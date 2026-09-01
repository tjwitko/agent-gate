import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { validateProject } from "./agent-loop.mjs";

// A scan pointed at the wrong tree is the failure this covers. It happened for real: the runner set
// SECRETGUARD_WORKING_ROOT, secret-guard reads SCAN_ROOT, an unrecognised variable is not an error,
// and the server fell back to the caller's cwd and scanned an entire monorepo. Sixteen credentials
// belonging to sibling repos were reported as blocking findings in a project that had none. The
// same misconfiguration pointed at a directory that happens to be clean would have reported a pass.
function registryReturning(payload) {
  return new Map([
    ["scan_path", { kind: "mcp", server: { call: async () => JSON.stringify(payload) } }],
  ]);
}

function inEmptyProject(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "scanroot-"));
  writeFileSync(path.join(dir, "index.mjs"), "export const x = 1;\n");
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const scanFailures = (r) => r.failures.filter((f) => f.includes("scan_path"));

test("a scan of a different directory is reported as unperformed, not as findings", async () => {
  await inEmptyProject(async (dir) => {
    const r = await validateProject(
      dir,
      registryReturning({ clean: false, target: path.dirname(dir), summary: { total: 16 } }),
      ""
    );
    const hit = scanFailures(r);
    assert.equal(hit.length, 1);
    assert.match(hit[0], /did NOT run against this project/);
    assert.doesNotMatch(hit[0], /16 hardcoded/); // the count is not this project's to answer for
  });
});

test("a CLEAN scan of a different directory is not accepted as a pass", async () => {
  await inEmptyProject(async (dir) => {
    const r = await validateProject(
      dir,
      registryReturning({ clean: true, target: path.dirname(dir), summary: { total: 0 } }),
      ""
    );
    assert.equal(scanFailures(r).length, 1);
  });
});

test("a scan of a subdirectory of the project is accepted", async () => {
  await inEmptyProject(async (dir) => {
    const r = await validateProject(
      dir,
      registryReturning({ clean: true, target: path.join(dir, "src"), summary: { total: 0 } }),
      ""
    );
    assert.equal(scanFailures(r).length, 0);
  });
});

test("real findings in the project itself still block", async () => {
  await inEmptyProject(async (dir) => {
    const r = await validateProject(
      dir,
      registryReturning({ clean: false, target: dir, summary: { total: 2 } }),
      ""
    );
    const hit = scanFailures(r);
    assert.equal(hit.length, 1);
    assert.match(hit[0], /2 hardcoded credential/);
  });
});
