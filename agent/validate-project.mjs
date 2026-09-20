#!/usr/bin/env node
// Run the agent loop's full validator suite against a project directory, without running the loop.
//
// The controls live in two places: terraform-guard, secret-guard, identity-guard and dep-audit are
// MCP servers, while immutability, authentication, manifest_contract, k8s_manifest, secret_rotation,
// iam_contract, artifact_presence, artifact_census and code_quality only ever ran inside
// agent-loop.mjs. A session that is not the loop would otherwise get one half and not the other.
//
//   node agent/validate-project.mjs <project-dir> [task-file]
//
// Exits 1 if anything blocks, 2 on misuse, 3 if a control could not be reached — because a check
// that did not run must never be reported as one that passed. The first version of this script
// passed an empty tool registry, so terraform_plan, scan_path, check_dependencies and build_check
// were all silently skipped while it printed "BLOCKING: none". The security scan and the secret
// scan were both absent from a result that read as a clean pass.
import path from "path";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { validateProject, localTools, McpClient } from "./agent-loop.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [, , projectDirArg, taskFile] = process.argv;
if (!projectDirArg) {
  console.error("usage: node agent/validate-project.mjs <project-dir> [task-file]");
  process.exit(2);
}
const projectDir = path.resolve(projectDirArg);

// Several checks are gated on what the task actually asked for -- immutability, secret rotation and
// both quality checks stay silent unless the requirement is stated. Without the task text they
// report "not checked", which is correct and much less useful.
const taskText = taskFile ? readFileSync(taskFile, "utf8") : "";

const siblings = path.resolve(__dirname, "..", "..");
const CONTROLS = [
  { name: "terraform-guard", entry: process.env.TFGUARD_SERVER || path.join(siblings, "terraform-guard-mcp", "index.mjs"), provides: ["terraform_plan"], env: { TF_WORKING_ROOT: projectDir } },
  // Both of these read SCAN_ROOT, not a name of their own. Earlier this script invented
  // DEPAUDIT_WORKING_ROOT / SECRETGUARD_WORKING_ROOT; an unrecognised env var is not an error, so
  // both servers silently fell back to this process's cwd and scanned the whole monorepo --
  // scan_path then reported 16 credentials that belong to sibling repos and blocked a clean
  // project. Confirmed against secret-guard-mcp/index.mjs:29 and dep-audit-mcp/index.mjs:24.
  { name: "dep-audit", entry: process.env.DEPAUDIT_SERVER || path.join(siblings, "dep-audit-mcp", "index.mjs"), provides: ["check_dependencies"], env: { SCAN_ROOT: projectDir } },
  { name: "secret-guard", entry: process.env.SECRETGUARD_SERVER || path.join(siblings, "secret-guard-mcp", "index.mjs"), provides: ["scan_path"], env: { SCAN_ROOT: projectDir } },
  // Missing from this list since it was written, while the comment at the top of the file named it
  // as one of the four. check_auth_posture therefore ran in no grade at all: the `authentication`
  // line in every run's output is the in-process route check in agent/authentication.mjs, which is
  // a different thing from identity-guard's workload-identity scan. The pre-commit hook does run
  // it -- that is where "workload identity — N file(s) checked" comes from -- so it has been
  // guarding these repos and never a deliverable.
  { name: "identity-guard", entry: process.env.IDENTITYGUARD_SERVER || path.join(siblings, "identity-guard-mcp", "index.mjs"), provides: ["check_auth_posture"], env: { SCAN_ROOT: projectDir } },
];

const registry = new Map();
const unreachable = [];

// build_check is a local tool, not an MCP one, and was skipped for the same reason as the rest.
for (const [name, def] of Object.entries(localTools(projectDir, null))) {
  registry.set(name, { kind: "local", run: def.run });
}

const clients = [];
for (const c of CONTROLS) {
  if (!existsSync(c.entry)) {
    unreachable.push(`${c.name} (no server at ${c.entry}) — ${c.provides.join(", ")} did NOT run`);
    continue;
  }
  try {
    // cwd as well as env: every one of these servers falls back to its startup cwd when its root
    // variable is unset, and callers pass relative targets like ".".
    const client = new McpClient(c.name, "node", [c.entry], c.env, projectDir);
    const tools = await client.init();
    clients.push(client);
    for (const t of tools) {
      if (t.name === "terraform_apply") continue; // never reachable from a validation pass
      registry.set(t.name, { kind: "mcp", server: client, toolName: t.name });
    }
  } catch (err) {
    unreachable.push(`${c.name} (${err && err.message}) — ${c.provides.join(", ")} did NOT run`);
  }
}

const r = await validateProject(projectDir, registry, taskText);
for (const c of clients) c.proc?.kill();

// A server that connected but whose tool the gate never invoked. That is not the same as a server
// that could not be reached, and it is harder to see: identity-guard was declared in every run's
// .mcp.json, spawned by nothing, and absent from this list for ten graded deliverables, while every
// report printed a line called `authentication` -- the in-process route check, a different thing
// entirely. A check that was running concealed one that was not, and the name did the concealing.
//
// So `provides` is now an assertion rather than documentation: whatever a control claims to supply
// must appear in `ran`, or the run says so before its verdict.
const silent = [];
for (const c of CONTROLS) {
  if (unreachable.some((u) => u.startsWith(`${c.name} `))) continue;
  const missing = c.provides.filter((tool) => !r.ran.some((x) => x === tool || x.startsWith(`${tool}(`)));
  if (missing.length) silent.push(`${c.name} connected, but ${missing.join(", ")} was never called`);
}

console.log(`project        : ${projectDir}`);
console.log(`task text      : ${taskFile ? taskFile : "NONE — checks gated on the task will report as not checked"}`);
console.log(`validators run : ${r.ran.join(", ")}\n`);

// Printed before the verdict, deliberately. A reader who stops at "BLOCKING: none" must not be able
// to miss that a control was absent.
if (unreachable.length) {
  console.log(`!! ${unreachable.length} CONTROL(S) COULD NOT BE REACHED — this run is INCOMPLETE`);
  for (const u of unreachable) console.log(`   - ${u}`);
  console.log("");
}
if (silent.length) {
  console.log(`!! ${silent.length} CONTROL(S) CONNECTED AND WERE NEVER CALLED — this run is INCOMPLETE`);
  for (const u of silent) console.log(`   - ${u}`);
  console.log("   A server that starts and is never asked anything reports nothing, which is");
  console.log("   indistinguishable from a server that found nothing.");
  console.log("");
}

if (r.failures.length === 0) {
  console.log(unreachable.length ? "BLOCKING        : none FROM THE CHECKS THAT RAN (see above)" : "BLOCKING        : none");
} else {
  console.log(`BLOCKING        : ${r.failures.length}`);
  for (const f of r.failures) console.log(`\n  - ${f}`);
}
if (r.advisories.length) {
  console.log(`\nadvisory        : ${r.advisories.length}`);
  for (const a of r.advisories) console.log(`\n  · ${a.split("\n")[0]}`);
}

// Exit 3 covers both, because both mean the same thing to anything reading this result: part of the
// gate produced no evidence. A silent control is if anything the worse of the two, since an
// unreachable one at least announces itself the moment it fails to start.
// A checker that could not run makes this run incomplete for the same reason an unreachable
// control does: the code was not checked, which is neither a finding nor a pass.
if (r.couldNotRun?.length) {
  console.log(`\n!! ${r.couldNotRun.length} CHECK(S) COULD NOT RUN — this run is INCOMPLETE`);
  for (const c of r.couldNotRun) console.log(`   - ${c}`);
}
if (unreachable.length || silent.length || r.couldNotRun?.length) process.exit(3);
process.exit(r.failures.length ? 1 : 0);
