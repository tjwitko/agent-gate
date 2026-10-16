#!/usr/bin/env node
// agent-gate — run the full validator suite against a project directory.
//
//   agent-gate <project-dir> [task-file] [--json]
//
// Exit codes are the contract and nothing may collapse them:
//   0  nothing blocking
//   1  blocking findings
//   2  usage error
//   3  part of the gate could not run
//
// Exit 3 is the valuable one. "Could not run" is not "passed", and anything consuming this result
// -- a CI job, a required status check, a human reading a summary -- has to be able to tell those
// apart. Two failures here were exactly that confusion: a runner that passed an empty tool registry
// and printed "BLOCKING: none", and a control that connected and was never asked anything for ten
// graded runs while a similarly-named check ran beside it.
import path from "path";
import { readFileSync, realpathSync, existsSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { loadRequirements, checkBaselineInput } from "../lib/requirements.mjs";
import { sourceCoverage, coverageLine } from "../agent/coverage.mjs";
import { splitSentences, unjudgedSentences } from "../agent/requirement-sentences.mjs";

import { validateProject, localTools, McpClient } from "../lib/gate-core.mjs";
import { resolveControls, readConfig, CONFIG_FILE } from "../lib/resolve-controls.mjs";
import { toolchain } from "../lib/toolchain.mjs";

const EXIT = { CLEAN: 0, BLOCKED: 1, USAGE: 2, INCOMPLETE: 3 };

// Input the gate cannot use. Thrown rather than left to surface as ENOENT, ENOTDIR or EISDIR from
// deep inside -- each of which crashed the process with Node's exit 1, which is this gate's
// "blocked". A mistyped path was reported as a verdict on the project.
export class UsageError extends Error {}

function checkInputs(projectDir, taskFile, baselineFile) {
  if (!existsSync(projectDir)) throw new UsageError(`${projectDir} does not exist`);
  if (!statSync(projectDir).isDirectory()) throw new UsageError(`${projectDir} is not a directory`);
  if (taskFile) {
    if (!existsSync(taskFile)) throw new UsageError(`the task file ${taskFile} does not exist`);
    if (!statSync(taskFile).isFile()) throw new UsageError(`the task file ${taskFile} is not a file`);
  }
  if (baselineFile) {
    const bad = checkBaselineInput(baselineFile);
    if (bad) throw new UsageError(bad);
  }
}

/**
 * The last resort, for anything not foreseen. It returns what to print and the code to exit with,
 * so it can be tested without crashing a process.
 *
 * Exit 3, never Node's default 1. Exit 1 says the gate ran in full and found blocking problems; a
 * gate that fell over did neither. In --json mode it still writes one document, because the Action
 * and the corpus parse stdout, and an empty one made the Action print "? blocking finding(s). The
 * gate ran in full; these are real." -- unless the result was already written, since two documents
 * are as unparseable as none.
 */
export function failClosed(err, { json, wroteResult }) {
  const reason = (err && err.message) || String(err);
  const stderr =
    `agent-gate: the gate itself failed: ${(err && err.stack) || reason}\n` +
    `This is not a verdict on the project. Exit 3: the gate could not run.\n`;
  const stdout =
    json && !wroteResult
      ? `${JSON.stringify({ exitCode: EXIT.INCOMPLETE, incomplete: true, error: `the gate itself failed: ${reason}` })}\n`
      : "";
  return { code: EXIT.INCOMPLETE, stdout, stderr };
}

let wroteResult = false;

/**
 * How many sentences of a requirement text a check read, and the ones none did. Null when there is
 * no text. Headings are not counted: they are labels, not requirements.
 */
export function requirementsRead(text) {
  if (!text || !text.trim()) return null;
  const sentences = splitSentences(text).filter((s) => !s.heading).length;
  const unread = unjudgedSentences(text);
  return { sentences, read: sentences - unread.length, unread };
}

export async function runGate(projectDirArg, taskFile, { env = process.env, preCommit = false, baselineFile = null } = {}) {
  const projectDir = path.resolve(projectDirArg);
  checkInputs(projectDir, taskFile, baselineFile);
  // Several checks are gated on what the task asked for -- immutability, retention, secret rotation
  // and both quality checks stay silent unless the requirement is stated. Without the task text
  // they report "not checked", which is correct and much less useful. The baseline, when there is
  // one, is requirement text from outside the project; see lib/requirements.mjs for why both exist.
  const requirements = loadRequirements(projectDir, taskFile, { preCommit, baselineFile });
  // When, and with what. osv-scanner answers from a live database, so the same tree and the same
  // pins can give different dependency findings on different days; a report that does not say when it
  // was made cannot be compared with another. The probe runs beside the checks rather than before.
  const scannedAt = new Date().toISOString();
  const tools = toolchain({ env });
  const taskText = requirements.text;

  const { config, error: configError } = readConfig(projectDir);
  const controls = resolveControls(projectDir, { config, env });

  const registry = new Map();
  const clients = [];
  const unreachable = [];

  // build_check is a local tool rather than an MCP one. It was once omitted for the same reason the
  // MCP tools were: the registry handed to validateProject was empty.
  for (const [name, def] of Object.entries(localTools(projectDir, null))) {
    registry.set(name, { kind: "local", run: def.run });
  }

  for (const c of controls) {
    if (!c.entry) {
      unreachable.push({ name: c.name, provides: c.provides, why: c.error });
      continue;
    }
    try {
      // cwd as well as env: every one of these servers falls back to its startup cwd when its root
      // variable is unset, and callers pass relative targets like ".".
      const client = new McpClient(c.name, "node", [c.entry], { [c.rootVar]: projectDir }, projectDir);
      const tools = await client.init();
      clients.push(client);
      for (const t of tools) {
        if (t.name === "terraform_apply") continue; // never reachable from a validation pass
        registry.set(t.name, { kind: "mcp", server: client, toolName: t.name });
      }
    } catch (err) {
      unreachable.push({ name: c.name, provides: c.provides, why: `${c.source}: ${err && err.message}` });
    }
  }

  const r = await validateProject(projectDir, registry, taskText, { preCommit });
  r.failures.unshift(...requirements.failures);
  r.advisories.unshift(...requirements.advisories);
  for (const c of clients) c.proc?.kill();

  // A server that connected but whose tool the gate never invoked. Not the same as one that could
  // not be reached, and harder to see: identity-guard was spawned by nothing for ten graded runs
  // while every report printed a line called `authentication` -- the in-process route check, a
  // different thing. `provides` is an assertion, not documentation.
  // A tool with nothing to examine did not fail to run. terraform_plan on a project with no
  // Terraform is the common case, and counting it as silent made every such project INCOMPLETE.
  const inapplicable = r.inapplicable || [];
  const outOfScope = new Set(inapplicable.map((i) => i.tool));

  const silent = [];
  for (const c of controls) {
    if (!c.entry || unreachable.some((u) => u.name === c.name)) continue;
    const missing = c.provides.filter(
      (tool) => !outOfScope.has(tool) && !r.ran.some((x) => x === tool || x.startsWith(`${tool}(`))
    );
    if (missing.length) silent.push({ name: c.name, provides: missing });
  }

  // A checker that could not run counts exactly as an unreachable control does. An in-process
  // check is not more trustworthy than an MCP one for being in-process: `build_check` reported
  // blocking "STATIC ERRORS" on any machine without ruff, and read a missing Go toolchain as a
  // pass, and neither showed up here at all.
  const couldNotRun = r.couldNotRun || [];
  const incomplete =
    unreachable.length > 0 || silent.length > 0 || couldNotRun.length > 0 || Boolean(configError);
  return {
    projectDir,
    taskFile: taskFile || null,
    baseline: requirements.baseline,
    scannedAt,
    // End-of-life dates are judged as of this day instead of the clock when it is set, as the corpus
    // does to keep a frozen verdict from ageing. Recorded so a pinned run does not pass for a live one.
    judgedAsOf: env.AGENT_GATE_TODAY || null,
    toolchain: await tools,
    // Which sentences of the requirements switched no check on. A gated-off check says only "not
    // checked", so a requirement nothing recognised was otherwise visible nowhere.
    requirementsRead: { task: requirementsRead(requirements.taskText), baseline: requirementsRead(requirements.baselineText) },
    coverage: sourceCoverage(projectDir),
    configError,
    controls,
    ran: r.ran,
    failures: r.failures,
    advisories: r.advisories,
    unreachable,
    silent,
    couldNotRun,
    inapplicable,
    exempt: r.exempt || [],
    incomplete,
    exitCode: incomplete ? EXIT.INCOMPLETE : r.failures.length ? EXIT.BLOCKED : EXIT.CLEAN,
  };
}

function human(result) {
  const out = [];
  out.push(`project        : ${result.projectDir}`);
  out.push(`task text      : ${result.taskFile || (result.baseline ? "NONE — the baseline only" : "NONE — checks gated on the task will report as not checked")}`);
  if (result.baseline) out.push(`baseline       : ${result.baseline}`);
  const taskRead = result.requirementsRead?.task;
  if (taskRead) {
    out.push(
      `task sentences : ${taskRead.sentences}, ${taskRead.read} read by a check, ${taskRead.unread.length} by none` +
        `${taskRead.unread.length ? " (--json lists them)" : ""}`
    );
  }
  for (const c of result.controls) {
    const v = c.entry ? (c.version ? `v${c.version}` : "v?").padEnd(8) : "";
    out.push(`control        : ${c.name.padEnd(16)} ${v}${c.entry ? c.source : `NOT RESOLVED — ${c.error}`}`);
  }
  out.push(`validators run : ${result.ran.join(", ")}\n`);

  // Printed before the verdict, deliberately. A reader who stops at "BLOCKING: none" must not be
  // able to miss that a control was absent.
  if (result.configError) out.push(`!! ${result.configError}\n`);
  if (result.unreachable.length) {
    out.push(`!! ${result.unreachable.length} CONTROL(S) COULD NOT BE REACHED — this run is INCOMPLETE`);
    for (const u of result.unreachable) out.push(`   - ${u.name}: ${u.why} — ${u.provides.join(", ")} did NOT run`);
    out.push("");
  }
  if (result.silent.length) {
    out.push(`!! ${result.silent.length} CONTROL(S) CONNECTED AND WERE NEVER CALLED — this run is INCOMPLETE`);
    for (const s of result.silent) out.push(`   - ${s.name} connected, but ${s.provides.join(", ")} was never called`);
    out.push("   A server that starts and is never asked anything reports nothing, which is");
    out.push("   indistinguishable from a server that found nothing.");
    out.push("");
  }
  // A baseline is requirements set from outside the project, by someone who meant every sentence. A
  // sentence of it that no check reads is one the project is not being held to, and the person who
  // wrote it is not the one reading the task file -- so each is printed, above the verdict.
  const baselineUnread = result.requirementsRead?.baseline?.unread || [];
  if (baselineUnread.length) {
    out.push(`!! ${baselineUnread.length} BASELINE SENTENCE(S) NO CHECK READ — the project is not held to these:`);
    for (const s of baselineUnread) out.push(`   - line ${s.line}: ${s.text}`);
    out.push("   Checks that run on every project still ran. None of them was switched on by these.");
    out.push("");
  }
  // Above the verdict for the same reason as the lines before it: a Rust project exited 0, and the
  // only sign that none of its code was read was one advisory among several.
  const notRead = coverageLine(result.coverage);
  if (notRead) out.push(`!! ${notRead}\n`);

  if (result.couldNotRun.length) {
    out.push(`!! ${result.couldNotRun.length} CHECK(S) COULD NOT RUN — this run is INCOMPLETE`);
    for (const c of result.couldNotRun) out.push(`   - ${c}`);
    out.push("   The code was not checked. That is not the same as the code being fine.");
    out.push("");
  }

  for (const i of result.inapplicable || []) {
    out.push(`not applicable  : ${i.tool} — ${i.why}`);
  }
  for (const e of result.exempt || []) {
    out.push(`exempt          : ${e.path} — ${e.reason} (${e.marker})`);
  }
  if ((result.inapplicable || []).length || (result.exempt || []).length) out.push("");

  const qualifier = result.incomplete ? " FROM THE CHECKS THAT RAN (see above)" : "";
  out.push(`BLOCKING        : ${result.failures.length ? result.failures.length : `none${qualifier}`}\n`);
  for (const f of result.failures) out.push(`  - ${f}\n`);
  out.push(`advisory        : ${result.advisories.length || "none"}\n`);
  for (const a of result.advisories) out.push(`  · ${a}\n`);
  return out.join("\n");
}

function machine(result) {
  return JSON.stringify(
    {
      project: result.projectDir,
      taskFile: result.taskFile,
      baseline: result.baseline,
      scannedAt: result.scannedAt,
      judgedAsOf: result.judgedAsOf,
      // Per requirement text: sentences, how many a check read, and the ones none did.
      requirementsRead: result.requirementsRead,
      notRead: result.coverage.unread,
      coverage: coverageLine(result.coverage),
      exitCode: result.exitCode,
      incomplete: result.incomplete,
      blocking: result.failures.length,
      controls: result.controls.map((c) => ({
        name: c.name,
        provides: c.provides,
        resolvedFrom: c.source,
        version: c.version || null,
        entry: c.entry,
        status: !c.entry
          ? "could-not-run"
          : result.unreachable.some((u) => u.name === c.name) || result.silent.some((s) => s.name === c.name)
            ? "could-not-run"
            : "ran",
        error: c.error || null,
      })),
      // Every tool the checks shell out to, null where it is not on PATH.
      toolchain: result.toolchain,
      validatorsRun: result.ran,
      couldNotRun: result.couldNotRun,
      notApplicable: result.inapplicable,
      exempt: result.exempt,
      findings: result.failures.map((f) => ({ severity: "blocking", message: f })),
      advisories: result.advisories.map((a) => ({ severity: "advisory", message: a })),
    },
    null,
    2
  );
}

const USAGE = `usage: agent-gate <project-dir> [task-file] [--baseline=<file>] [--json] [--pre-commit]
       agent-gate --version     this release, its four controls, and the scanners on PATH
       agent-gate --help

exit 0 nothing blocking, 1 blocking findings, 2 usage, 3 part of the gate could not run.

controls resolve from, in order: an env var, ${CONFIG_FILE} in the project,
node_modules, then a sibling checkout. A control that resolves from nowhere exits 3.`;

async function main() {
  const args = process.argv.slice(2);
  // What you are on, and which controls that brings with it. Answered before anything else, because
  // the first question during an upgrade is whether the upgrade took -- and "the package moved" is
  // not the same answer as "the controls that will run moved". v1.1.1 is the release where they
  // did not.
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exit(EXIT.CLEAN);
  }
  if (args.includes("--version")) {
    const self = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(`agent-gate ${self.version}`);
    for (const c of resolveControls(process.cwd())) {
      const v = c.entry ? (c.version ? `v${c.version}` : "v?").padEnd(8) : "".padEnd(8);
      console.log(`  ${c.name.padEnd(16)} ${v}${c.entry ? c.source : `NOT RESOLVED — ${c.error}`}`);
    }
    // The controls are a fraction of what decides a verdict; the scanners they and the checks shell
    // out to are the rest. A missing one is listed as missing -- leaving it out is how a machine
    // without Go came to look like one where Go's checks had passed.
    console.log("tools on PATH");
    for (const [name, v] of Object.entries(await toolchain())) {
      console.log(`  ${name.padEnd(16)} ${v === null ? "not found" : v}`);
    }
    process.exit(EXIT.CLEAN);
  }
  const json = args.includes("--json");
  // Set by the pre-commit hook agent-gate-init writes. It disables exactly one check, the one
  // whose premise a commit satisfies by existing; everything else runs, and the skip is reported.
  const preCommit = args.includes("--pre-commit");
  const positional = args.filter((a) => !a.startsWith("--"));
  // Requirement text from outside the project, which the project cannot edit. `=` form only: a
  // separate value would be read as the task file.
  const baselineArg = args.find((a) => a.startsWith("--baseline"));
  if (baselineArg !== undefined && !/^--baseline=.+/.test(baselineArg)) {
    console.error("agent-gate: --baseline takes a file: --baseline=<file>");
    process.exit(EXIT.USAGE);
  }
  const baselineFile = baselineArg ? baselineArg.slice("--baseline=".length) : null;
  if (positional.length < 1) {
    console.error(USAGE);
    process.exit(EXIT.USAGE);
  }
  // In --json mode stdout carries exactly one thing: the result document. The validators share
  // their code with the agent loop, which narrates progress to console.log, so a single narration
  // line lands in front of the JSON and makes it unparseable. That is how the corpus first failed
  // on CI -- `[gate] check_dependencies: ... (no lockfile)` wedged ahead of the document, and a
  // SyntaxError pointing at the narration rather than at the gate.
  //
  // Silencing the one line that leaked would leave every other console.log in that shared code one
  // refactor away from doing the same, so stdout is closed to narration for the duration instead.
  // The narration is not discarded -- it goes to stderr, where a human still reads it.
  const narrate = console.log;
  if (json) console.log = (...a) => console.error(...a);
  let result;
  try {
    result = await runGate(positional[0], positional[1], { preCommit, baselineFile });
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.log = narrate;
    console.error(`agent-gate: ${err.message}`);
    console.error("usage: agent-gate <project-dir> [task-file] [--baseline=<file>] [--json] [--pre-commit]");
    if (json) process.stdout.write(`${JSON.stringify({ exitCode: EXIT.USAGE, error: err.message })}\n`);
    process.exit(EXIT.USAGE);
  } finally {
    console.log = narrate;
  }
  wroteResult = true;
  process.stdout.write(`${json ? machine(result) : human(result)}\n`);
  process.exit(result.exitCode);
}

// Whether this file was executed rather than imported.
//
// This used `path.resolve(process.argv[1])`, which does not resolve symlinks -- and npm installs a
// bin as a symlink, so `npx agent-gate` had argv[1] pointing at node_modules/.bin/agent-gate while
// import.meta.url pointed at the real file. The comparison was false, main() never ran, and the
// command exited 0 with no output. Silent success, from the entry point of a tool whose whole
// subject is checks that quietly do not run.
//
// Nothing caught it because nothing ran the installed command: the corpus and the GitHub Action
// both invoke `node bin/validate.mjs` by path, which is the one way it worked.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that cannot be resolved is not this file.
    return false;
  }
}

// Anything that escapes main() -- a throw, a rejected promise, an 'error' event nobody listened for
// -- would otherwise end the process with Node's exit 1, which is "blocked".
if (invokedDirectly()) {
  const json = process.argv.includes("--json");
  const crash = (err) => {
    const r = failClosed(err, { json, wroteResult });
    if (r.stdout) process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    process.exit(r.code);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  try {
    await main();
  } catch (err) {
    crash(err);
  }
}
