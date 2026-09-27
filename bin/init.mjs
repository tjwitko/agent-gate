#!/usr/bin/env node
// agent-gate-init — wire a project to the gate.
//
//   agent-gate-init [project-dir] [--new] [--task <file>] [--agents <file>] [--hook] [--no-mcp]
//   agent-gate-init [project-dir] --upgrade        refresh what an earlier version wrote
//   agent-gate-init --version
//
// Two jobs, which are the same job: make a directory one the gate runs against. `--new` creates it
// and `git init`s it first; without it, an existing project is updated in place.
//
// Nothing here overwrites. A file that already exists is left alone and reported, because the
// likeliest reason a project already has an AGENTS.md or a pre-commit hook is that someone meant
// it. `--force` is the way to say otherwise, per file, out loud.
//
// Exit codes are deliberately NOT the gate's. This is a setup tool: 0 wrote or confirmed
// everything, 1 left something alone that it would otherwise have written, 2 usage. The gate's
// exit 3 -- a check could not run -- has no meaning here and must not be borrowed, because the one
// thing that contract cannot survive is a second meaning for the same number.
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, realpathSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { resolveControls, readConfig, CONFIG_FILE } from "../lib/resolve-controls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const EXIT = { OK: 0, LEFT_ALONE: 1, USAGE: 2 };

const VERSION = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version;

// The marker is how a second run knows it has already written the stanza. Matching on the prose
// would break the moment the template is reworded, which it will be. Stamped with the version that
// wrote it, so an upgrade can say what it replaced -- and matched with or without the stamp, because
// v1.1.3 wrote it without one, and a project set up then must be recognised rather than handed a
// second stanza beneath the first.
const STANZA_START = `<!-- agent-gate:start v${VERSION} -->`;
const STANZA_START_RE = /<!-- agent-gate:start(?: v([^\s>]+))? -->/;
const STANZA_END = "<!-- agent-gate:end -->";
const STANZA_BLOCK_RE = new RegExp(`${STANZA_START_RE.source}[\\s\\S]*?${STANZA_END}\\n?`);

// The same for the hook. What identifies a hook as ours is this line; a hook without it belongs to
// someone else and an upgrade never touches it.
const HOOK_MARK_RE = /^# Installed by agent-gate-init(?: v([^\s.]+(?:\.[^\s.]+)*))?\./m;

function parseArgs(argv) {
  const opts = { dir: ".", task: null, agents: "AGENTS.md", hook: false, mcp: true, isNew: false, force: [], upgrade: false, version: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--new") opts.isNew = true;
    else if (a === "--hook") opts.hook = true;
    else if (a === "--no-mcp") opts.mcp = false;
    else if (a === "--upgrade") opts.upgrade = true;
    else if (a === "--version") opts.version = true;
    else if (a === "--task") opts.task = argv[++i];
    else if (a === "--agents") opts.agents = argv[++i];
    else if (a === "--force") opts.force.push(argv[++i] ?? "all");
    else if (a.startsWith("--")) return { error: `unknown option ${a}` };
    else rest.push(a);
  }
  if (rest.length > 1) return { error: "give at most one project directory" };
  if (rest.length === 1) opts.dir = rest[0];
  if (opts.task === undefined || opts.agents === undefined) return { error: "--task and --agents take a value" };
  return { opts };
}

const forced = (opts, what) => opts.force.includes("all") || opts.force.includes(what);

/** The command the stanza and the hook both tell people to run. */
function validateCommand(projectDir, taskFile, { preCommit = false } = {}) {
  // Walk up for node_modules the way node resolution does. `npx agent-gate` is what belongs in a
  // committed AGENTS.md: an absolute path out of this machine's checkout is wrong on a teammate's,
  // and the stanza is the file most likely to be read by someone who did not run this tool.
  let found = false;
  for (let d = path.resolve(projectDir); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, "node_modules", ".bin", "agent-gate"))) { found = true; break; }
    if (d === path.dirname(d)) break;
  }
  const cmd = found ? "npx agent-gate" : `node ${path.join(PKG_ROOT, "bin", "validate.mjs")}`;
  // --pre-commit only in the hook. It disables the uncommitted-work check, whose premise a commit
  // satisfies by existing -- without it the hook blocks every commit forever and teaches people to
  // pass --no-verify, which costs the whole hook. The stanza's command keeps the check, because an
  // agent that says it is done with work uncommitted has not finished.
  const flags = preCommit ? " --pre-commit" : "";
  return taskFile ? `${cmd} . ${taskFile}${flags}` : `${cmd} .${flags}`;
}

/**
 * Merge the four controls into .mcp.json. Merge, never replace: a project's MCP config is its own,
 * and this is one caller adding four entries to it.
 */
function writeMcpJson(projectDir, opts, log) {
  const file = path.join(projectDir, ".mcp.json");
  const { config } = readConfig(projectDir);
  const controls = resolveControls(projectDir, { config });

  const unresolved = controls.filter((c) => !c.entry);
  if (unresolved.length) {
    log.warn(
      `.mcp.json: ${unresolved.map((c) => c.name).join(", ")} could not be located, so ${
        unresolved.length === 1 ? "it is" : "they are"
      } not in the config. Install @tjwitko/agent-gate's dependencies, or set ${unresolved
        .map((c) => c.envVar)
        .join(" / ")}.`
    );
  }

  let doc = { mcpServers: {} };
  if (existsSync(file)) {
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      log.left(`.mcp.json exists and could not be parsed (${err.message}) — leaving it alone`);
      return;
    }
    doc.mcpServers ||= {};
  }

  const added = [];
  const kept = [];
  for (const c of controls) {
    if (!c.entry) continue;
    if (doc.mcpServers[c.name] && !forced(opts, "mcp")) {
      kept.push(c.name);
      continue;
    }
    // Absolute, because an MCP client's working directory is its own business and a relative entry
    // point resolves against whatever that happens to be.
    doc.mcpServers[c.name] = {
      command: "node",
      args: [c.entry],
      env: { [c.rootVar]: path.resolve(projectDir) },
    };
    added.push(c.name);
  }

  if (!added.length) {
    log.ok(`.mcp.json already has ${kept.join(", ")}`);
    return;
  }
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  log.wrote(`.mcp.json — added ${added.join(", ")}${kept.length ? `; kept existing ${kept.join(", ")}` : ""}`);
}

/** Append the agent stanza, filled in, between markers. */
function writeStanza(projectDir, opts, log) {
  const tmpl = path.join(PKG_ROOT, "templates", "AGENTS.md.tmpl");
  if (!existsSync(tmpl)) {
    log.left(`${opts.agents}: the template is missing from this install (${tmpl})`);
    return;
  }
  const body = readFileSync(tmpl, "utf8").replaceAll(
    "{{VALIDATE_COMMAND}}",
    validateCommand(projectDir, opts.task)
  );
  const file = path.join(projectDir, opts.agents);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";

  if (STANZA_START_RE.test(existing) && !forced(opts, "agents")) {
    log.ok(`${opts.agents} already carries the stanza`);
    return;
  }
  const block = `${STANZA_START}\n${body.trim()}\n${STANZA_END}\n`;
  const next = STANZA_START_RE.test(existing)
    ? existing.replace(STANZA_BLOCK_RE, block)
    : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${existing ? "\n" : ""}${block}`;
  writeFileSync(file, next);
  log.wrote(`${opts.agents} — ${existing ? "appended" : "created with"} the gate stanza`);
}

/**
 * A pre-commit hook that runs the gate.
 *
 * It fails closed. If the gate cannot be found the hook blocks the commit rather than letting it
 * through, because a hook that passes when it could not run is worse than no hook: the repository
 * looks protected and is not. `git commit --no-verify` is the deliberate way past, and unlike
 * quietly deleting the hook it is visible to whoever reads the reflog.
 */
function HOOK(command) {
  return `#!/usr/bin/env bash
# Installed by agent-gate-init v${VERSION}. Blocks a commit whose tree does not pass the gate.
#
# MCP registration makes a validator available to an assistant; nothing makes it run. Measured
# across four runs of one task with identical tooling, a model called the Terraform validator 3, 1,
# 4 and 0 times. Git is a boundary the project owns: an assistant can write anything, and cannot
# land it until these pass.
#
# Deliberate bypass, visible afterwards:  git commit --no-verify
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 1

if ! ${command.split(" ")[0]} --help >/dev/null 2>&1 && ! command -v ${command.split(" ")[0]} >/dev/null 2>&1; then
  echo "pre-commit: agent-gate is not available here, so nothing checked this commit." >&2
  echo "            Install it, or bypass deliberately with: git commit --no-verify" >&2
  exit 1
fi

${command}
status=$?

# 0 clean. Anything else blocks -- including 3, which means part of the gate could not run. A check
# that produced no evidence must not read as one that passed.
if [ "$status" -ne 0 ]; then
  echo "" >&2
  echo "pre-commit: the gate exited $status, so this commit is blocked." >&2
  echo "            1 = blocking findings, 2 = usage, 3 = part of the gate could not run." >&2
  exit "$status"
fi
`;
}

function writeHook(projectDir, opts, log) {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: projectDir, encoding: "utf8" });
  if (top.status !== 0) {
    log.left("pre-commit hook: not a git repository — run `git init` first, or pass --new");
    return;
  }
  const hooksDir = path.join(top.stdout.trim(), ".git", "hooks");
  const file = path.join(hooksDir, "pre-commit");

  // core.hooksPath wins over .git/hooks, so writing there while it points elsewhere installs a hook
  // that never runs -- the silent-success shape this project exists to refuse.
  const configured = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: projectDir, encoding: "utf8" });
  const hooksPath = (configured.stdout || "").trim();
  if (hooksPath) {
    log.left(
      `pre-commit hook: core.hooksPath is set to ${hooksPath}, so a hook in .git/hooks would never ` +
        `run. Put the hook there instead, or unset it with \`git config --unset core.hooksPath\`.`
    );
    return;
  }

  if (existsSync(file) && !forced(opts, "hook")) {
    log.left("pre-commit hook: one already exists — leaving it alone (--force hook to replace)");
    return;
  }
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(file, HOOK(validateCommand(projectDir, opts.task, { preCommit: true })));
  chmodSync(file, 0o755);
  log.wrote(`.git/hooks/pre-commit — runs the gate, and blocks on exit 1, 2 and 3 alike`);
}

// --- upgrading ---------------------------------------------------------------------------------
//
// Refresh what an earlier agent-gate-init wrote, and nothing else. Upgrading the package moves the
// gate and the controls; it does not touch what setup wrote into a project -- the stanza in
// AGENTS.md, the hook in .git/hooks, the control entries in .mcp.json -- so without this a project
// keeps whatever an older release put there, indefinitely and silently. `--force` would refresh
// them too, and would also overwrite a hook someone wrote themselves. This only touches what carries
// agent-gate-init's own mark.

// The task file the project was set up with, read back from what setup wrote, so an upgrade does
// not need it repeated -- and does not quietly drop it, which would switch six checks off.
function recoverTask(text) {
  const m = /(?:npx agent-gate|validate\.mjs) \.(?: (?!--)(\S+))?/.exec(text || "");
  return m ? m[1] || null : null;
}

const from = (v) => (v ? `v${v}` : "an earlier version");

function upgradeStanza(projectDir, opts, log) {
  const file = path.join(projectDir, opts.agents);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const start = STANZA_START_RE.exec(existing);
  if (!start) {
    log.warn(`${opts.agents}: no stanza from agent-gate-init to upgrade — run without --upgrade to add one`);
    return;
  }
  const block = STANZA_BLOCK_RE.exec(existing);
  if (!block) {
    log.left(`${opts.agents}: the stanza's start marker is there without its end marker — not guessing where it stops`);
    return;
  }
  const tmpl = path.join(PKG_ROOT, "templates", "AGENTS.md.tmpl");
  const task = opts.task ?? recoverTask(block[0]);
  const body = readFileSync(tmpl, "utf8").replaceAll("{{VALIDATE_COMMAND}}", validateCommand(projectDir, task));
  const next = existing.replace(STANZA_BLOCK_RE, `${STANZA_START}\n${body.trim()}\n${STANZA_END}\n`);
  if (next === existing) {
    log.ok(`${opts.agents}: stanza is current (v${VERSION})`);
    return;
  }
  writeFileSync(file, next);
  log.updated(`${opts.agents}: stanza ${from(start[1])} → v${VERSION}${task ? ` (task file ${task} kept)` : ""}`);
}

function upgradeHook(projectDir, opts, log) {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: projectDir, encoding: "utf8" });
  if (top.status !== 0) return;
  const file = path.join(top.stdout.trim(), ".git", "hooks", "pre-commit");
  if (!existsSync(file)) {
    log.warn("pre-commit hook: none installed — add one with --hook");
    return;
  }
  const text = readFileSync(file, "utf8");
  const mark = HOOK_MARK_RE.exec(text);
  if (!mark) {
    log.warn("pre-commit hook: not installed by agent-gate-init, so an upgrade does not touch it");
    return;
  }
  const hooksPath = (spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: projectDir, encoding: "utf8" }).stdout || "").trim();
  if (hooksPath) {
    // Refreshing it would be pointless and would read as protection: git is not running it.
    log.left(`pre-commit hook: core.hooksPath is now ${hooksPath}, so the hook in .git/hooks does not run at all`);
    return;
  }
  const task = opts.task ?? recoverTask(text);
  const next = HOOK(validateCommand(projectDir, task, { preCommit: true }));
  if (next === text) {
    log.ok(`pre-commit hook: current (v${VERSION})`);
    return;
  }
  writeFileSync(file, next);
  chmodSync(file, 0o755);
  log.updated(`pre-commit hook: ${from(mark[1])} → v${VERSION}`);
}

function upgradeMcp(projectDir, opts, log) {
  const file = path.join(projectDir, ".mcp.json");
  if (!existsSync(file)) {
    log.warn(".mcp.json: none to upgrade — run without --upgrade to add one");
    return;
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    log.left(`.mcp.json could not be parsed (${err.message}) — leaving it alone`);
    return;
  }
  doc.mcpServers ||= {};
  const { config } = readConfig(projectDir);
  const changed = [];
  const current = [];
  const custom = [];
  for (const c of resolveControls(projectDir, { config })) {
    if (!c.entry) {
      log.warn(`.mcp.json: ${c.name} could not be located in this install — set ${c.envVar}`);
      continue;
    }
    const want = { command: "node", args: [c.entry], env: { [c.rootVar]: path.resolve(projectDir) } };
    const have = doc.mcpServers[c.name];
    const label = `${c.name} ${c.version ? `v${c.version}` : "v?"}`;
    if (!have) {
      // A control this release has and the project does not -- how a new one reaches an existing
      // project at all.
      doc.mcpServers[c.name] = want;
      changed.push(`${label} (added)`);
    } else if (JSON.stringify(have) === JSON.stringify(want)) {
      current.push(label);
    } else if (have.command === "node" && typeof have.args?.[0] === "string" && have.args[0].endsWith(path.join(c.pkg, "index.mjs"))) {
      doc.mcpServers[c.name] = want;
      changed.push(label);
    } else {
      custom.push(c.name);
    }
  }
  if (changed.length) {
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    log.updated(`.mcp.json: ${changed.join(", ")}`);
  }
  if (current.length) log.ok(`.mcp.json: ${current.join(", ")} current`);
  if (custom.length) {
    log.left(
      `.mcp.json: kept ${custom.join(", ")} as defined — ${custom.length === 1 ? "it points" : "they point"} ` +
        `somewhere agent-gate did not write, so ${custom.length === 1 ? "it does" : "they do"} not follow this upgrade`
    );
  }
}

async function main() {
  const { opts, error } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(`agent-gate-init: ${error}`);
    console.error("usage: agent-gate-init [project-dir] [--new] [--task <file>] [--agents <file>] [--hook] [--no-mcp]\n       agent-gate-init [project-dir] --upgrade\n       agent-gate-init --version");
    process.exit(EXIT.USAGE);
  }

  if (opts.version) {
    console.log(`agent-gate-init ${VERSION}`);
    process.exit(EXIT.OK);
  }
  if (opts.upgrade && (opts.isNew || opts.hook || opts.force.length)) {
    console.error("agent-gate-init: --upgrade refreshes what is already there; it does not take --new, --hook or --force");
    process.exit(EXIT.USAGE);
  }

  const projectDir = path.resolve(opts.dir);
  if (!existsSync(projectDir)) {
    if (!opts.isNew) {
      console.error(`agent-gate-init: ${projectDir} does not exist. Pass --new to create it.`);
      process.exit(EXIT.USAGE);
    }
    mkdirSync(projectDir, { recursive: true });
  }
  if (opts.isNew && spawnSync("git", ["rev-parse", "--git-dir"], { cwd: projectDir }).status !== 0) {
    spawnSync("git", ["init", "-q"], { cwd: projectDir });
  }

  let leftAlone = 0;
  const log = {
    wrote: (m) => console.log(`  wrote   ${m}`),
    updated: (m) => console.log(`  updated ${m}`),
    ok: (m) => console.log(`  ok      ${m}`),
    left: (m) => { leftAlone++; console.log(`  left    ${m}`); },
    warn: (m) => console.log(`  note    ${m}`),
  };

  if (opts.upgrade) {
    console.log(`agent-gate-init ${VERSION}: upgrading ${projectDir}`);
    if (opts.mcp) upgradeMcp(projectDir, opts, log);
    upgradeStanza(projectDir, opts, log);
    upgradeHook(projectDir, opts, log);
    console.log("");
    console.log("  confirm: npx agent-gate --version     (the controls that will actually run)");
    process.exit(leftAlone ? EXIT.LEFT_ALONE : EXIT.OK);
  }

  console.log(`agent-gate-init: ${projectDir}`);
  if (opts.mcp) writeMcpJson(projectDir, opts, log);
  writeStanza(projectDir, opts, log);
  if (opts.hook) writeHook(projectDir, opts, log);

  console.log("");
  console.log(`  next:   ${validateCommand(projectDir, opts.task)}`);
  if (!opts.task) {
    console.log("          Six checks are gated on the task text. Write one and pass --task, or");
    console.log("          they report \"not checked\" — accurate, and much less useful.");
  }
  process.exit(leftAlone ? EXIT.LEFT_ALONE : EXIT.OK);
}

// realpathSync, not path.resolve. npm installs a bin as a symlink, so `npx agent-gate-init` has
// argv[1] pointing at node_modules/.bin/agent-gate-init while import.meta.url points at the real
// file; path.resolve does not follow symlinks, the comparison is false, main() never runs, and the
// command exits 0 having done nothing. bin/validate.mjs shipped exactly this bug once and carries
// the same comment. Writing a second entry point reproduced it within the hour, which is the
// argument for testing the INSTALLED command rather than `node bin/...` by path -- that is the one
// invocation under which it works.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) await main();

export {
  parseArgs, writeMcpJson, writeStanza, writeHook, validateCommand, HOOK, EXIT, STANZA_START,
  upgradeMcp, upgradeStanza, upgradeHook, recoverTask, VERSION,
};
