import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import path from "path";

import {
  parseArgs, writeMcpJson, writeStanza, writeHook, validateCommand, HOOK, STANZA_START,
  upgradeMcp, upgradeStanza, upgradeHook, recoverTask, VERSION,
} from "./init.mjs";

function project(files = {}, { git = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "init-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  if (git) spawnSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}
const collect = () => {
  const seen = { wrote: [], ok: [], left: [], warn: [], updated: [] };
  return [seen, { wrote: (m) => seen.wrote.push(m), ok: (m) => seen.ok.push(m),
                  left: (m) => seen.left.push(m), warn: (m) => seen.warn.push(m),
                  updated: (m) => seen.updated.push(m) }];
};
const OPTS = { dir: ".", task: null, agents: "AGENTS.md", hook: false, mcp: true, isNew: false, force: [] };

// --- arguments -------------------------------------------------------------------------------

test("parseArgs: rejects what it does not understand rather than ignoring it", () => {
  assert.match(parseArgs(["--nope"]).error, /unknown option/);
  assert.match(parseArgs(["a", "b"]).error, /at most one project directory/);
  assert.equal(parseArgs(["--new", "--hook", "proj"]).opts.dir, "proj");
  assert.equal(parseArgs(["--task", "t.txt"]).opts.task, "t.txt");
});

// --- .mcp.json -------------------------------------------------------------------------------

test("writeMcpJson merges into an existing config instead of replacing it", () => {
  // A project's MCP config is its own. This is one caller adding four entries to it, and a
  // setup tool that overwrites the file takes someone's other servers with it.
  const dir = project({ ".mcp.json": JSON.stringify({ mcpServers: { mine: { command: "node", args: ["x.mjs"] } } }) });
  try {
    const [seen, log] = collect();
    writeMcpJson(dir, OPTS, log);
    const doc = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    assert.ok(doc.mcpServers.mine, "the project's own server survives");
    assert.ok(doc.mcpServers["secret-guard"], "and the controls are added");
    assert.equal(seen.left.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("writeMcpJson leaves a control the project already defined", () => {
  const dir = project({ ".mcp.json": JSON.stringify({ mcpServers: { "secret-guard": { command: "custom" } } }) });
  try {
    const [, log] = collect();
    writeMcpJson(dir, OPTS, log);
    const doc = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    assert.equal(doc.mcpServers["secret-guard"].command, "custom", "theirs, not ours");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("writeMcpJson refuses to touch a config it cannot parse", () => {
  // Rewriting it would discard whatever the author meant, and the parse failure is the only
  // evidence there was something to discard.
  const dir = project({ ".mcp.json": "{ not json" });
  try {
    const [seen, log] = collect();
    writeMcpJson(dir, OPTS, log);
    assert.equal(readFileSync(path.join(dir, ".mcp.json"), "utf8"), "{ not json");
    assert.match(seen.left[0], /could not be parsed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- the agent stanza ------------------------------------------------------------------------

test("writeStanza appends to an existing AGENTS.md and is idempotent", () => {
  const dir = project({ "AGENTS.md": "# House rules\n\nBe careful.\n" });
  try {
    const [, log] = collect();
    writeStanza(dir, OPTS, log);
    const first = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    assert.match(first, /# House rules/, "what was there stays");
    assert.match(first, /A refusal is not a pass/, "and the stanza is added");

    const [seen2, log2] = collect();
    writeStanza(dir, OPTS, log2);
    assert.equal(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), first, "a second run changes nothing");
    assert.match(seen2.ok[0], /already carries/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("writeStanza fills in the command rather than leaving the placeholder", () => {
  const dir = project();
  try {
    const [, log] = collect();
    writeStanza(dir, { ...OPTS, task: "task.txt" }, log);
    const body = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    assert.ok(!body.includes("{{VALIDATE_COMMAND}}"), "no unreplaced placeholder");
    assert.match(body, /task\.txt/);
    assert.ok(body.includes(STANZA_START), "marked, so a rewording does not defeat idempotency");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- the hook --------------------------------------------------------------------------------

test("writeHook refuses when core.hooksPath points elsewhere", () => {
  // Writing .git/hooks/pre-commit while core.hooksPath is set installs a hook that never runs.
  // A guard that is present and inert is the exact shape this project refuses.
  const dir = project();
  try {
    spawnSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: dir });
    const [seen, log] = collect();
    writeHook(dir, OPTS, log);
    assert.equal(existsSync(path.join(dir, ".git", "hooks", "pre-commit")), false);
    assert.match(seen.left[0], /core\.hooksPath/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("writeHook leaves an existing hook alone unless forced", () => {
  const dir = project();
  try {
    mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho mine\n");
    const [seen, log] = collect();
    writeHook(dir, OPTS, log);
    assert.match(readFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "utf8"), /echo mine/);
    assert.match(seen.left[0], /already exists/);

    const [, log2] = collect();
    writeHook(dir, { ...OPTS, force: ["hook"] }, log2);
    assert.match(readFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "utf8"), /agent-gate-init/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("writeHook says so rather than writing into a directory that is not a repository", () => {
  const dir = project({}, { git: false });
  try {
    const [seen, log] = collect();
    writeHook(dir, OPTS, log);
    assert.match(seen.left[0], /not a git repository/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- what the hook does ------------------------------------------------------------------------

test("the hook blocks on exit 3, not only on findings", () => {
  // Exit 3 means part of the gate could not run. A hook that treated it as success would let
  // through precisely the commits nothing checked.
  const script = HOOK("agent-gate . --pre-commit");
  assert.match(script, /if \[ "\$status" -ne 0 \]/, "anything non-zero blocks");
  assert.ok(!/status" -eq 1/.test(script), "not keyed to exit 1 alone");
});

test("the hook fails closed when the gate is missing", () => {
  const script = HOOK("agent-gate . --pre-commit");
  const guard = script.slice(script.indexOf("if !"), script.indexOf("fi") + 2);
  assert.match(guard, /exit 1/, "no gate means no commit");
  assert.ok(!/exit 0/.test(guard), "never waved through");
});

test("the hook runs with --pre-commit and the stanza does not", () => {
  // The uncommitted-work check must be off in a hook, where a commit satisfies its premise, and on
  // for an agent, where finishing with work uncommitted means it has not finished.
  const dir = project();
  try {
    assert.match(validateCommand(dir, "task.txt", { preCommit: true }), /--pre-commit$/);
    assert.ok(!validateCommand(dir, "task.txt").includes("--pre-commit"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the installed command is what lands in a committed file", () => {
  // The stanza is committed and read by teammates; an absolute path out of one machine's checkout
  // is wrong on every other. node resolution walks up for node_modules, so this does too.
  const dir = project();
  try {
    mkdirSync(path.join(dir, "nested"), { recursive: true });
    mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", ".bin", "agent-gate"), "#!/bin/sh\n");
    assert.match(validateCommand(path.join(dir, "nested"), "t.txt"), /^npx agent-gate/,
      "found by walking up, as node would");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// --- upgrading --------------------------------------------------------------------------------
//
// Upgrading the package moves the gate and the controls; it does not touch what setup wrote into a
// project. These pin that --upgrade refreshes exactly what agent-gate-init wrote and nothing else.

// What v1.1.3 wrote, exactly: markers and hook header carried no version then.
const V113_STANZA = "<!-- agent-gate:start -->\n## Security gate\n\n    npx agent-gate . task.txt\n\nold words\n<!-- agent-gate:end -->\n";
const V113_HOOK = "#!/usr/bin/env bash\n# Installed by agent-gate-init. Blocks a commit whose tree does not pass the gate.\nnpx agent-gate . task.txt --pre-commit\n";

test("a stanza written by v1.1.3 is recognised, not duplicated", () => {
  // The unstamped marker must still read as ours. Otherwise the first run of a newer init on a
  // project set up by the older one appends a second stanza beneath the first.
  const dir = project({ "AGENTS.md": "# House rules\n\n" + V113_STANZA });
  try {
    const [seen, log] = collect();
    writeStanza(dir, OPTS, log);
    const body = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    assert.equal((body.match(/agent-gate:start/g) || []).length, 1);
    assert.match(seen.ok[0], /already carries/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("upgrade refreshes a v1.1.3 stanza and keeps its task file", () => {
  const dir = project({ "AGENTS.md": "# House rules\n\n" + V113_STANZA + "\n## After\n" });
  try {
    const [seen, log] = collect();
    upgradeStanza(dir, OPTS, log);
    const body = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    assert.equal((body.match(/agent-gate:start/g) || []).length, 1, "replaced, not appended");
    assert.ok(body.includes(`<!-- agent-gate:start v${VERSION} -->`));
    assert.match(body, /task\.txt/, "the task file survives, or six checks go quiet");
    assert.doesNotMatch(body, /old words/);
    assert.match(body, /# House rules/, "what surrounds it is untouched");
    assert.match(body, /## After/);
    assert.match(seen.updated[0], /an earlier version → v/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("upgrade is a no-op the second time", () => {
  const dir = project({ "AGENTS.md": V113_STANZA });
  try {
    const [, log] = collect();
    upgradeStanza(dir, OPTS, log);
    const once = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    const [seen, log2] = collect();
    upgradeStanza(dir, OPTS, log2);
    assert.equal(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), once);
    assert.match(seen.ok[0], /current/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("upgrade refuses a stanza whose end marker is gone", () => {
  // Guessing where it stops could eat the rest of the file.
  const dir = project({ "AGENTS.md": "<!-- agent-gate:start -->\nhalf a stanza\n\n## Someone's section\n" });
  try {
    const [seen, log] = collect();
    upgradeStanza(dir, OPTS, log);
    assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /Someone's section/);
    assert.match(seen.left[0], /without its end marker/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("upgrade refreshes a hook agent-gate-init wrote and keeps its task file", () => {
  const dir = project();
  try {
    mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "hooks", "pre-commit"), V113_HOOK);
    const [seen, log] = collect();
    upgradeHook(dir, OPTS, log);
    const hook = readFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "utf8");
    assert.match(hook, new RegExp(`Installed by agent-gate-init v${VERSION.replace(/\./g, "\\.")}\\.`));
    assert.match(hook, /\. task\.txt --pre-commit/);
    assert.match(seen.updated[0], /an earlier version → v/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("upgrade never touches a hook someone else wrote", () => {
  // This is the case --force gets wrong, and the reason --upgrade exists rather than a
  // recommendation to re-run with --force.
  const dir = project();
  try {
    mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho mine\n");
    const [seen, log] = collect();
    upgradeHook(dir, OPTS, log);
    assert.equal(readFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "utf8"), "#!/bin/sh\necho mine\n");
    assert.match(seen.warn[0], /not installed by agent-gate-init/);
    assert.equal(seen.left.length, 0, "someone else's hook is not a failed upgrade");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("upgrade keeps a control the project defined itself, and says it will not follow", () => {
  const dir = project({ ".mcp.json": JSON.stringify({ mcpServers: { "secret-guard": { command: "docker", args: ["run", "sg"] } } }) });
  try {
    const [seen, log] = collect();
    upgradeMcp(dir, OPTS, log);
    const doc = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    assert.equal(doc.mcpServers["secret-guard"].command, "docker", "theirs, untouched");
    assert.match(seen.left[0], /does not follow this upgrade/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("upgrade repoints a control whose install moved", () => {
  // What setup wrote, pointing at a node_modules that is no longer there.
  const stale = { command: "node", args: ["/old/place/node_modules/@tjwitko/dep-audit-mcp/index.mjs"], env: { SCAN_ROOT: "/old" } };
  const dir = project({ ".mcp.json": JSON.stringify({ mcpServers: { "dep-audit": stale } }) });
  try {
    const [seen, log] = collect();
    upgradeMcp(dir, OPTS, log);
    const doc = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    assert.notEqual(doc.mcpServers["dep-audit"].args[0], stale.args[0]);
    assert.equal(doc.mcpServers["dep-audit"].env.SCAN_ROOT, path.resolve(dir));
    assert.match(seen.updated[0], /dep-audit v/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recoverTask reads back the task file setup was given", () => {
  assert.equal(recoverTask("    npx agent-gate . task.txt"), "task.txt");
  assert.equal(recoverTask("npx agent-gate . specs/task.md --pre-commit"), "specs/task.md");
  assert.equal(recoverTask("node /x/bin/validate.mjs . t.txt --pre-commit"), "t.txt");
  assert.equal(recoverTask("npx agent-gate . --pre-commit"), null, "a flag is not a task file");
  assert.equal(recoverTask("npx agent-gate ."), null);
});
