import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { resolveHooksDir, resolveSecretScannerEntry } from "./agent-loop.mjs";

const findsNothing = {
  resolve() {
    throw new Error("Cannot find module");
  },
};

function scratch(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "siblings-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Both of these resolved a sibling checkout and returned a benign value when it was absent. The
// hook is the only enforcement boundary that survives outside the loop, and the loop's own gate is
// a SUBSET of what it runs -- so on a machine without that checkout, commits landed unvalidated
// and nothing said so. Returning null is correct; doing it in silence was not, and the callers
// now say so out loud.
test("no hook directory resolves to null rather than a path", () => {
  scratch((root) => {
    const from = path.join(root, "repo", "agent");
    mkdirSync(from, { recursive: true });
    assert.equal(resolveHooksDir(from, { env: {} }), null);
  });
});

test("a sibling hooks directory is found", () => {
  scratch((root) => {
    const from = path.join(root, "repo", "agent");
    mkdirSync(from, { recursive: true });
    const hooks = path.join(root, "local-copilot-stack", "githooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\n");
    assert.equal(resolveHooksDir(from, { env: {} }), hooks);
  });
});

// A directory that exists but holds no hook is not a hook directory. Accepting it would point
// core.hooksPath at nothing, which git treats as "no hooks" -- the silent version again.
test("a hooks directory without a pre-commit hook does not count", () => {
  scratch((root) => {
    const from = path.join(root, "repo", "agent");
    mkdirSync(from, { recursive: true });
    const hooks = path.join(root, "local-copilot-stack", "githooks");
    mkdirSync(hooks, { recursive: true });
    assert.equal(resolveHooksDir(from, { env: {} }), null);
  });
});

test("AGENT_GATE_HOOKS_PATH overrides the sibling lookup", () => {
  scratch((root) => {
    const custom = path.join(root, "my-hooks");
    mkdirSync(custom, { recursive: true });
    writeFileSync(path.join(custom, "pre-commit"), "#!/bin/sh\n");
    assert.equal(resolveHooksDir(path.join(root, "repo", "agent"), { env: { AGENT_GATE_HOOKS_PATH: custom } }), custom);
  });
});

// The write_file scanner is the layer that stops a credential reaching disk at all. Absent, it
// returned null and every write went unscanned -- on every machine without the sibling checkout.
test("an unresolvable secret scanner is null, not a silent skip", () => {
  scratch((root) => {
    const from = path.join(root, "repo", "agent");
    mkdirSync(from, { recursive: true });
    assert.equal(resolveSecretScannerEntry(from, { resolver: findsNothing, env: {} }), null);
  });
});

test("a sibling secret-guard checkout is found", () => {
  scratch((root) => {
    const from = path.join(root, "repo", "agent");
    mkdirSync(from, { recursive: true });
    const lib = path.join(root, "secret-guard-mcp", "lib");
    mkdirSync(lib, { recursive: true });
    const entry = path.join(lib, "gitleaks.mjs");
    writeFileSync(entry, "export const checkGitleaksInstalled = () => true;\n");
    assert.equal(resolveSecretScannerEntry(from, { resolver: findsNothing, env: {} }), entry);
  });
});

test("an installed package wins over a sibling checkout", () => {
  const resolved = "/n/node_modules/@tjwitko/secret-guard-mcp/lib/gitleaks.mjs";
  const findsPackage = {
    resolve(spec) {
      if (spec.startsWith("@tjwitko/")) return resolved;
      throw new Error("Cannot find module");
    },
  };
  assert.equal(resolveSecretScannerEntry("/anywhere", { resolver: findsPackage, env: {} }), resolved);
});

// SECRETGUARD_LIB is an explicit instruction. Pointing it somewhere that does not exist is an
// error in the instruction, not a reason to quietly use something else -- the same rule the
// control resolver applies to TFGUARD_SERVER and friends.
test("SECRETGUARD_LIB pointing nowhere does not fall through to a sibling", () => {
  scratch((root) => {
    const from = path.join(root, "repo", "agent");
    mkdirSync(from, { recursive: true });
    const lib = path.join(root, "secret-guard-mcp", "lib");
    mkdirSync(lib, { recursive: true });
    writeFileSync(path.join(lib, "gitleaks.mjs"), "export const checkGitleaksInstalled = () => true;\n");

    const missing = path.join(root, "does-not-exist.mjs");
    assert.equal(resolveSecretScannerEntry(from, { resolver: findsNothing, env: { SECRETGUARD_LIB: missing } }), null);
  });
});

test("the scoped specifier is tried before the bare one", () => {
  const tried = [];
  const record = {
    resolve(spec) {
      tried.push(spec);
      throw new Error("Cannot find module");
    },
  };
  resolveSecretScannerEntry("/anywhere", { resolver: record, env: {} });
  assert.equal(tried[0], "@tjwitko/secret-guard-mcp/lib/gitleaks.mjs");
  assert.equal(tried[1], "secret-guard-mcp/lib/gitleaks.mjs");
});
