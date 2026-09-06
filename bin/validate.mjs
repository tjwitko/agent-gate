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
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

import { validateProject, localTools, McpClient } from "../agent/agent-loop.mjs";
import { resolveControls, readConfig, CONFIG_FILE } from "../lib/resolve-controls.mjs";

const EXIT = { CLEAN: 0, BLOCKED: 1, USAGE: 2, INCOMPLETE: 3 };

export async function runGate(projectDirArg, taskFile, { env = process.env } = {}) {
  const projectDir = path.resolve(projectDirArg);
  // Several checks are gated on what the task asked for -- immutability, retention, secret rotation
  // and both quality checks stay silent unless the requirement is stated. Without the task text
  // they report "not checked", which is correct and much less useful.
  const taskText = taskFile ? readFileSync(taskFile, "utf8") : "";

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

  const r = await validateProject(projectDir, registry, taskText);
  for (const c of clients) c.proc?.kill();

  // A server that connected but whose tool the gate never invoked. Not the same as one that could
  // not be reached, and harder to see: identity-guard was spawned by nothing for ten graded runs
  // while every report printed a line called `authentication` -- the in-process route check, a
  // different thing. `provides` is an assertion, not documentation.
  const silent = [];
  for (const c of controls) {
    if (!c.entry || unreachable.some((u) => u.name === c.name)) continue;
    const missing = c.provides.filter((tool) => !r.ran.some((x) => x === tool || x.startsWith(`${tool}(`)));
    if (missing.length) silent.push({ name: c.name, provides: missing });
  }

  const incomplete = unreachable.length > 0 || silent.length > 0 || Boolean(configError);
  return {
    projectDir,
    taskFile: taskFile || null,
    configError,
    controls,
    ran: r.ran,
    failures: r.failures,
    advisories: r.advisories,
    unreachable,
    silent,
    incomplete,
    exitCode: incomplete ? EXIT.INCOMPLETE : r.failures.length ? EXIT.BLOCKED : EXIT.CLEAN,
  };
}

function human(result) {
  const out = [];
  out.push(`project        : ${result.projectDir}`);
  out.push(`task text      : ${result.taskFile || "NONE — checks gated on the task will report as not checked"}`);
  for (const c of result.controls) {
    out.push(`control        : ${c.name.padEnd(16)} ${c.entry ? c.source : `NOT RESOLVED — ${c.error}`}`);
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
      exitCode: result.exitCode,
      incomplete: result.incomplete,
      blocking: result.failures.length,
      controls: result.controls.map((c) => ({
        name: c.name,
        provides: c.provides,
        resolvedFrom: c.source,
        entry: c.entry,
        status: !c.entry
          ? "could-not-run"
          : result.unreachable.some((u) => u.name === c.name) || result.silent.some((s) => s.name === c.name)
            ? "could-not-run"
            : "ran",
        error: c.error || null,
      })),
      validatorsRun: result.ran,
      findings: result.failures.map((f) => ({ severity: "blocking", message: f })),
      advisories: result.advisories.map((a) => ({ severity: "advisory", message: a })),
    },
    null,
    2
  );
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length < 1) {
    console.error("usage: agent-gate <project-dir> [task-file] [--json]");
    console.error(`\ncontrols resolve from, in order: an env var, ${CONFIG_FILE} in the project,`);
    console.error("node_modules, then a sibling checkout. A control that resolves from nowhere exits 3.");
    process.exit(EXIT.USAGE);
  }
  const result = await runGate(positional[0], positional[1]);
  console.log(json ? machine(result) : human(result));
  process.exit(result.exitCode);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
