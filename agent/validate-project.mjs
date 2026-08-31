#!/usr/bin/env node
// Run the agent loop's full validator suite against a project directory, without running the loop.
//
// The controls live in two places: terraform-guard, secret-guard, identity-guard and dep-audit are
// MCP servers any session can call, while immutability, authentication, manifest_contract,
// k8s_manifest, secret_rotation, iam_contract, artifact_presence, artifact_census and code_quality
// only ever ran inside agent-loop.mjs. A session that is not the loop would otherwise get four of
// the controls and not the other nine.
//
//   node agent/validate-project.mjs <project-dir> [task-file]
//
// Exits 1 if anything blocks, so it can gate a commit.
import { validateProject } from "./agent-loop.mjs";
import { readFileSync } from "fs";

const [, , projectDir, taskFile] = process.argv;
if (!projectDir) {
  console.error("usage: node agent/validate-project.mjs <project-dir> [task-file]");
  process.exit(2);
}
// Several checks are gated on what the task actually asked for -- immutability, secret rotation and
// the quality checks all stay silent unless the requirement is stated. Without the task text they
// report "not checked" rather than passing, which is correct but much less useful.
const taskText = taskFile ? readFileSync(taskFile, "utf8") : "";
if (!taskFile) {
  console.warn("No task file given: checks gated on the task's wording will report as not checked.\n");
}

const r = await validateProject(projectDir, new Map(), taskText);

console.log(`validators run : ${r.ran.join(", ")}\n`);
if (r.failures.length === 0) console.log("BLOCKING        : none");
else {
  console.log(`BLOCKING        : ${r.failures.length}`);
  for (const f of r.failures) console.log(`\n  - ${f}`);
}
if (r.advisories.length) {
  console.log(`\nadvisory        : ${r.advisories.length}`);
  for (const a of r.advisories) console.log(`\n  · ${a.split("\n")[0]}`);
}
process.exit(r.failures.length ? 1 : 0);
