import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "..", "bin", "validate.mjs");

/**
 * npm installs a bin as a SYMLINK into node_modules/.bin, so this is how every installed user runs
 * the command and the only way it was never run here. The entry-point guard compared
 * `path.resolve(process.argv[1])` against `import.meta.url`; path.resolve does not resolve
 * symlinks, so through the symlink the two never matched, main() never ran, and `npx agent-gate`
 * exited 0 having printed nothing and checked nothing.
 *
 * Exit 0 with no output is the worst available answer for this tool: a CI step reads it as clean.
 * Neither the corpus nor the GitHub Action caught it, because both invoke `node bin/validate.mjs`
 * by path -- the one form that worked.
 */
function runCli(args, { viaSymlink }) {
  const dir = mkdtempSync(path.join(tmpdir(), "cli-entry-"));
  try {
    let entry = CLI;
    if (viaSymlink) {
      entry = path.join(dir, "agent-gate");
      symlinkSync(CLI, entry);
    }
    return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("run directly with no arguments, it reports usage and exits 2", () => {
  const r = runCli([], { viaSymlink: false });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: agent-gate/);
});

test("run through a symlink, it still reports usage and exits 2", () => {
  const r = runCli([], { viaSymlink: true });
  assert.equal(r.status, 2, "the installed command must actually run");
  assert.match(r.stderr, /usage: agent-gate/);
});

// The specific shape of the bug: not a crash, not an error, just nothing.
test("the installed command never exits 0 without having done anything", () => {
  const r = runCli([], { viaSymlink: true });
  assert.notEqual(r.status, 0, "exit 0 with no work done reads as a clean verdict");
  assert.ok(
    (r.stdout || "").trim().length > 0 || (r.stderr || "").trim().length > 0,
    "a run that produces no output at all cannot be distinguished from a run that passed"
  );
});
