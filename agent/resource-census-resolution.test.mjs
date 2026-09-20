import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { resolveCensusEntry } from "./agent-loop.mjs";

// A resolver that finds nothing, standing in for a machine where terraform-guard is not installed.
const findsNothing = {
  resolve() {
    throw new Error("Cannot find module");
  },
};

// The defect. The census was loaded from a sibling checkout alone, and an absent sibling returned
// an empty list -- which means "nothing went missing", so every machine without that checkout got
// a clean census it had never computed. Advisory rather than blocking, which is the only reason
// this ranks below the lockfile bug; the shape is identical.
test("an unresolvable census is null, not an empty result", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "nocensus-"));
  try {
    assert.equal(resolveCensusEntry(empty, { resolver: findsNothing }), null);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("a sibling checkout is found when there is no installed package", () => {
  const root = mkdtempSync(path.join(tmpdir(), "census-"));
  try {
    // resolveCensusEntry walks up two levels, matching agent/ inside the repo.
    const from = path.join(root, "repo", "agent");
    mkdirSync(from, { recursive: true });
    const lib = path.join(root, "terraform-guard-mcp", "lib");
    mkdirSync(lib, { recursive: true });
    const entry = path.join(lib, "resource-census.mjs");
    writeFileSync(entry, "export const pendingRemovals = () => [];\n");

    assert.equal(resolveCensusEntry(from, { resolver: findsNothing }), entry);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an installed package wins over a sibling checkout", () => {
  const resolved = "/somewhere/node_modules/@tjwitko/terraform-guard-mcp/lib/resource-census.mjs";
  const findsPackage = {
    resolve(spec) {
      if (spec.startsWith("@tjwitko/")) return resolved;
      throw new Error("Cannot find module");
    },
  };
  assert.equal(resolveCensusEntry("/anywhere", { resolver: findsPackage }), resolved);
});

// The scoped name is tried first for the same reason the controls try it first: a bare name is
// somebody else's package on npm, and this one is imported and executed.
test("the scoped specifier is tried before the bare one", () => {
  const tried = [];
  const record = {
    resolve(spec) {
      tried.push(spec);
      throw new Error("Cannot find module");
    },
  };
  resolveCensusEntry("/anywhere", { resolver: record });
  assert.equal(tried[0], "@tjwitko/terraform-guard-mcp/lib/resource-census.mjs");
  assert.equal(tried[1], "terraform-guard-mcp/lib/resource-census.mjs");
});
