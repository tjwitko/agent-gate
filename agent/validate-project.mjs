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
  { name: "dep-audit", entry: process.env.DEPAUDIT_SERVER || path.join(siblings, "dep-audit-mcp", "index.mjs"), provides: ["check_dependencies"], env: { DEPAUDIT_WORKING_ROOT: projectDir } },
  { name: "secret-guard", entry: process.env.SECRETGUARD_SERVER || path.join(siblings, "secret-guard-mcp", "index.mjs"), provides: ["scan_path"], env: { SECRETGUARD_WORKING_ROOT: projectDir } },
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
    const client = new McpClient(c.name, "node", [c.entry], c.env);
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

if (unreachable.length) process.exit(3);
process.exit(r.failures.length ? 1 : 0);
