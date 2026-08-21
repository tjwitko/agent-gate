#!/usr/bin/env node
// Reusable benchmark for evaluating a candidate local model on local-delegate-mcp's actual
// delegation path, before adopting it into presets.ini. Runs a standardized codegen task
// against the model alias given on the command line, via the real delegate_to_local_model tool
// (CAPABLE_MODEL_ALIAS is overridden for the run, same mechanism used manually during
// development — see local-copilot-stack's model-selection notes for why this exists).
//
// Automates the mechanical parts: call, detect truncation, retry with an escalated budget,
// integrate the result into a fresh copy of a reference project, verify it, and report
// comparable numbers (attempts, tokens, wall-clock, pass/fail). It does NOT automate code-quality
// review — inspect bench/runs/<label>/ yourself before trusting a "pass".
//
// Two task shapes are supported, selected by the task JSON's "taskType":
//   "node-rest" (default, e.g. task.json) — a REST-resource codegen task, verified by running
//     the reference project's test suite (`node --test`).
//   "iac" (e.g. task-iac.json) — a Terraform/Docker infrastructure task, verified by
//     `terraform validate` and `docker build`. Neither of those catches live-cloud-semantics bugs
//     (e.g. a storage-class choice that breaks reads on real S3) — only structural/schema
//     validity — see local-delegate-mcp/CLAUDE.md for why a real S3-backed smoke test wasn't
//     folded into this generic harness.
// Each task JSON also carries its own "requiredMarkers" (the ===FILE:...=== markers a complete
// response must contain) and "referenceDir" (which bench/ subdirectory to copy as the starting
// project) — nothing about the task shape is hardcoded here anymore.
//
// Regardless of task type, every run also checks for imports/requires of packages never declared
// in the generated project's package.json — a real bug found in a delegated run (a model used
// `ajv` without adding it as a dependency) that isn't specific to either task shape.
//
// If the sibling langfuse-local stack is running, every run is also traced to it: one
// generation per attempt (with the model's own token counts), spans for the verification
// phases, and the report's numbers attached as scores so runs are comparable in the UI over
// time. Tracing is strictly additive — with the stack down, this script behaves exactly as it
// did before, same stdout and same exit codes. See bench/README.md.
//
// Usage:
//   node run-benchmark.mjs --model <router-preset-alias> [options]
//   --start-max-tokens <n>    initial budget (default 3000)
//   --max-tokens-ceiling <n>  stop escalating past this (default 20000)
//   --max-attempts <n>        give up after this many tries (default 3)
//   --label <name>            runs/ subdirectory name (default: the model alias)
//   --task <path>             alternate task JSON (default: task.json) — e.g. a variant with a
//                             model-specific flag like Qwen3's "/no_think" in system_prompt, or
//                             a different task shape entirely like task-iac.json.

import { spawn, spawnSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { builtinModules } from "module";
import { initTracing, startRun, startStep, startAttempt, finishAttempt, scoreRun, shutdownTracing } from "./langfuse-tracing.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "index.mjs");
const TASK_PATH = path.join(__dirname, "task.json");
const RUNS_DIR = path.join(__dirname, "runs");

// Must match index.mjs's own formula so the harness never times out before the server would.
const TIMEOUT_BASE_MS = 30_000;
const TIMEOUT_PER_TOKEN_MS = 150;
const HARNESS_TIMEOUT_BUFFER_MS = 60_000;

// Fallback only — every task JSON in this repo now declares its own requiredMarkers explicitly.
const DEFAULT_REQUIRED_MARKERS = [
  "===FILE: src/resources/projects.js===",
  "===FILE: test/projects.test.js===",
  "===FILE: src/resources/tasks.js===",
  "===FILE: test/tasks.test.js===",
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { model: null, startMaxTokens: 3000, maxTokensCeiling: 20000, maxAttempts: 3, label: null, taskPath: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model") opts.model = args[++i];
    else if (args[i] === "--start-max-tokens") opts.startMaxTokens = Number(args[++i]);
    else if (args[i] === "--max-tokens-ceiling") opts.maxTokensCeiling = Number(args[++i]);
    else if (args[i] === "--max-attempts") opts.maxAttempts = Number(args[++i]);
    else if (args[i] === "--label") opts.label = args[++i];
    else if (args[i] === "--task") opts.taskPath = args[++i];
  }
  if (!opts.model) {
    console.error(
      "usage: node run-benchmark.mjs --model <router-preset-alias> " +
        "[--start-max-tokens 3000] [--max-tokens-ceiling 20000] [--max-attempts 3] [--label name] [--task path]"
    );
    process.exit(1);
  }
  opts.label = opts.label || opts.model;
  opts.taskPath = opts.taskPath || TASK_PATH;
  return opts;
}

// One raw MCP tools/call round-trip against local-delegate-mcp, run with cwd = runDir so
// context_files resolves against it (CONTEXT_ROOT defaults to the server's cwd).
function callDelegate({ cwd, args, timeoutMs, modelAlias }) {
  return new Promise((resolve) => {
    const p = spawn("node", [SERVER_PATH], { cwd, env: { ...process.env, CAPABLE_MODEL_ALIAS: modelAlias } });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => {
      stderr += d.toString();
      process.stderr.write(`[server] ${d}`);
    });

    const send = (msg) => p.stdin.write(JSON.stringify(msg) + "\n");
    const startedAt = Date.now();

    setTimeout(
      () =>
        send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "1" } },
        }),
      300
    );

    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delegate_to_local_model", arguments: args } });
    }, 700);

    const check = setInterval(() => {
      if (stdout.includes('"id":2')) {
        clearInterval(check);
        clearTimeout(timeout);
        finish();
      }
    }, 1000);

    const timeout = setTimeout(() => {
      clearInterval(check);
      p.kill();
      resolve({ ok: false, reason: "harness-timeout", elapsedMs: Date.now() - startedAt, usage: null });
    }, timeoutMs);

    function finish() {
      const elapsedMs = Date.now() - startedAt;
      p.kill();
      const usageLine = stderr.split("\n").find((l) => l.startsWith("[usage]"));
      const usage = usageLine ? Object.fromEntries(
        [...usageLine.matchAll(/(\w+)=(\S+)/g)].map(([, k, v]) => [k, /^\d+$/.test(v) ? Number(v) : v])
      ) : null;

      const responseLine = stdout.trim().split("\n").find((l) => l.includes('"id":2'));
      if (!responseLine) return resolve({ ok: false, reason: "no-response", elapsedMs, usage });
      let parsed;
      try {
        parsed = JSON.parse(responseLine);
      } catch {
        return resolve({ ok: false, reason: "bad-json", elapsedMs, usage });
      }
      const block = parsed.result?.content?.[0];
      if (parsed.result?.isError) {
        return resolve({ ok: false, reason: "tool-error", message: block?.text, elapsedMs, usage });
      }
      resolve({ ok: true, text: block?.text || "", elapsedMs, usage });
    }
  });
}

function looksComplete(result, requiredMarkers) {
  return result.ok && requiredMarkers.every((m) => result.text.includes(m));
}

function splitFiles(text, targetDir) {
  const lines = text.split("\n");
  let currentFile = null;
  let buffer = [];
  const flush = () => {
    if (currentFile) {
      const dest = path.join(targetDir, currentFile);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, buffer.join("\n"));
    }
  };
  for (const line of lines) {
    const m = line.match(/^===FILE: (.+)===$/);
    if (m) {
      flush();
      currentFile = m[1];
      buffer = [];
    } else if (currentFile) {
      buffer.push(line);
    }
  }
  flush();
}

// --- Generic dependency-completeness check (applies to any task shape) ---
// Written after a real delegated run shipped code that `require`d a package (ajv) never added to
// package.json — a bug class `node --test`/`npm install` don't reliably surface as *why* something
// broke, and `terraform validate`/`docker build` don't touch at all. Flags every bare import
// specifier with no matching entry in dependencies/devDependencies; doesn't fail the run by
// itself, just surfaces it in the report the same way testsPassedCleanly does.
const IMPORT_RE = /import\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /import\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/g;

function walkJsFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".terraform") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsFiles(full, acc);
    else if (/\.(m|c)?js$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

function extractImportSpecifiers(source) {
  const specifiers = new Set();
  for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) specifiers.add(m[1]);
  }
  return specifiers;
}

function toPackageName(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return null;
  if (builtinModules.includes(specifier)) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function checkDependencyCompleteness(runDir) {
  const pkgPath = path.join(runDir, "package.json");
  if (!existsSync(pkgPath)) return { checked: false, missing: [] };
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const declared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ]);
  const missing = new Set();
  for (const file of walkJsFiles(runDir)) {
    for (const spec of extractImportSpecifiers(readFileSync(file, "utf8"))) {
      const pkgName = toPackageName(spec);
      if (pkgName && !declared.has(pkgName)) missing.add(pkgName);
    }
  }
  return { checked: true, missing: [...missing] };
}

// --- IaC verification: terraform validate + docker build ---
// Both are static/structural checks with no cloud credentials required — deliberately not a live
// smoke test. They would have caught schema errors (wrong Object Lock attributes, a duplicate
// provider block, undeclared variables) and a broken Dockerfile (a build script that shelled out
// to `docker build` from inside its own image build), but NOT a bug like a storage class that
// silently breaks reads on real S3 — that only surfaced against a real S3-compatible endpoint.
// Missing `terraform`/`docker` binaries are reported as skipped (null), not a failure.
function verifyTerraformAndDocker(runDir, verify) {
  const result = { terraformValid: null, terraformOutput: "", dockerBuildOk: null, dockerOutput: "" };

  const tfDir = path.join(runDir, verify.terraformDir || "terraform");
  if (existsSync(tfDir)) {
    const init = spawnSync("terraform", ["init", "-backend=false", "-input=false"], { cwd: tfDir, encoding: "utf8" });
    if (init.error) {
      result.terraformOutput = `terraform not available: ${init.error.message}`;
    } else {
      const validate = spawnSync("terraform", ["validate"], { cwd: tfDir, encoding: "utf8" });
      result.terraformOutput = `--- init ---\n${init.stdout}${init.stderr}\n--- validate ---\n${validate.stdout}${validate.stderr}`;
      result.terraformValid = init.status === 0 && validate.status === 0;
    }
  }

  const dockerfilePath = path.join(runDir, verify.dockerfile || "Dockerfile");
  if (existsSync(dockerfilePath)) {
    const tag = `local-delegate-bench-${path.basename(runDir)}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
    const build = spawnSync("docker", ["build", "-t", tag, "-f", dockerfilePath, runDir], { encoding: "utf8" });
    if (build.error) {
      result.dockerOutput = `docker not available: ${build.error.message}`;
    } else {
      result.dockerOutput = build.stdout + build.stderr;
      result.dockerBuildOk = build.status === 0;
      if (result.dockerBuildOk) spawnSync("docker", ["rmi", "-f", tag]);
    }
  }

  return result;
}

async function main() {
  const opts = parseArgs();
  const task = JSON.parse(readFileSync(opts.taskPath, "utf8"));
  const requiredMarkers = task.requiredMarkers || DEFAULT_REQUIRED_MARKERS;
  const verifyType = task.verify?.type || "node-test";
  const referenceDir = path.join(__dirname, task.referenceDir || "reference");
  const runDir = path.join(RUNS_DIR, opts.label);

  console.log(`==> benchmarking "${opts.model}" (taskType=${task.taskType || "node-rest"}, run dir: ${runDir})`);

  await initTracing();
  const run = startRun(`bench:${task.taskType || "node-rest"}`, {
    input: { task: task.task, system_prompt: task.system_prompt, context_files: task.context_files },
    metadata: {
      modelAlias: opts.model,
      label: opts.label,
      taskType: task.taskType || "node-rest",
      taskFile: path.basename(opts.taskPath),
      startMaxTokens: opts.startMaxTokens,
      maxTokensCeiling: opts.maxTokensCeiling,
      maxAttempts: opts.maxAttempts,
      expectedOutputLines: task.expected_output_lines,
    },
  });

  cpSync(referenceDir, runDir, { recursive: true });
  if (existsSync(path.join(runDir, "package.json"))) {
    console.log("==> npm install...");
    spawnSync("npm", ["install", "--no-fund", "--no-audit"], { cwd: runDir, stdio: "inherit" });
  }

  let maxTokens = opts.startMaxTokens;
  const attempts = [];
  let finalResult = null;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const timeoutMs = TIMEOUT_BASE_MS + maxTokens * TIMEOUT_PER_TOKEN_MS + HARNESS_TIMEOUT_BUFFER_MS;
    console.log(`==> attempt ${attempt}/${opts.maxAttempts}: max_tokens=${maxTokens} (harness timeout ${Math.round(timeoutMs / 1000)}s)`);
    // Opened before the call so the generation's duration is the real model wall-clock.
    const attemptSpan = startAttempt(run, {
      name: `attempt-${attempt}`,
      model: opts.model,
      modelParameters: { max_tokens: maxTokens },
      input: { task: task.task, context_files: task.context_files },
    });

    const result = await callDelegate({
      cwd: runDir,
      args: { ...task, model: "capable", max_tokens: maxTokens },
      timeoutMs,
      modelAlias: opts.model,
    });
    // A failed attempt is closed out too, not skipped: "four instant tool-errors" is exactly the
    // llama-server crash signature the README warns about, and it should be visible in the UI.
    finishAttempt(attemptSpan, {
      output: result.ok ? result.text : null,
      usage: result.usage,
      level: result.ok ? "DEFAULT" : "ERROR",
      statusMessage: result.ok ? undefined : result.reason,
      metadata: { attempt, elapsedMs: result.elapsedMs, reason: result.reason, message: result.message },
    });

    attempts.push({ attempt, maxTokens, elapsedMs: result.elapsedMs, usage: result.usage, ok: result.ok, reason: result.reason });
    console.log(`    -> ${result.ok ? "responded" : `failed (${result.reason})`}, ${Math.round(result.elapsedMs / 1000)}s, usage=${JSON.stringify(result.usage)}`);

    if (looksComplete(result, requiredMarkers)) {
      finalResult = result;
      break;
    }
    if (maxTokens >= opts.maxTokensCeiling) {
      console.log("==> hit max-tokens-ceiling without a complete response, stopping");
      break;
    }
    maxTokens = Math.min(maxTokens * 2, opts.maxTokensCeiling);
  }

  const totalLocalTokens = attempts.reduce((sum, a) => sum + (a.usage?.total_tokens || 0), 0);
  const totalElapsedMs = attempts.reduce((sum, a) => sum + a.elapsedMs, 0);

  const report = {
    model: opts.model,
    taskType: task.taskType || "node-rest",
    attempts: attempts.length,
    attemptDetail: attempts,
    totalLocalTokens,
    totalElapsedSeconds: Math.round(totalElapsedMs / 1000),
    completed: !!finalResult,
  };

  // Every number the report compares across models becomes a score, so the UI can chart them.
  const emitScores = (r) => {
    scoreRun(run, { name: "completed", value: r.completed ? 1 : 0 });
    scoreRun(run, { name: "attempts", value: r.attempts, comment: "lower is better" });
    scoreRun(run, { name: "total_local_tokens", value: r.totalLocalTokens, comment: "lower is better" });
    scoreRun(run, { name: "wall_clock_seconds", value: r.totalElapsedSeconds, comment: "lower is better" });
    if (Array.isArray(r.missingDependencies)) {
      scoreRun(run, {
        name: "missing_dependencies",
        value: r.missingDependencies.length,
        comment: r.missingDependencies.join(", ") || "none",
      });
    }
    if (typeof r.testsPassedCleanly === "boolean") {
      scoreRun(run, { name: "tests_passed_cleanly", value: r.testsPassedCleanly ? 1 : 0 });
    }
    if (typeof r.testsPass === "number") scoreRun(run, { name: "tests_pass", value: r.testsPass });
    if (typeof r.testsFail === "number") scoreRun(run, { name: "tests_fail", value: r.testsFail });
    if (typeof r.terraformValid === "boolean") {
      scoreRun(run, { name: "terraform_valid", value: r.terraformValid ? 1 : 0 });
    }
    if (typeof r.dockerBuildOk === "boolean") {
      scoreRun(run, { name: "docker_build_ok", value: r.dockerBuildOk ? 1 : 0 });
    }
  };

  if (!finalResult) {
    console.log("\n==> RESULT: never produced a complete response within the attempt/token budget.");
    console.log(JSON.stringify(report, null, 2));
    writeFileSync(path.join(runDir, "bench-report.json"), JSON.stringify(report, null, 2));
    emitScores(report);
    run.update({ output: report, level: "ERROR", statusMessage: "no complete response within budget" }).end();
    // Flush before exiting, or the attempts just recorded never reach the server.
    await shutdownTracing();
    process.exit(1);
  }

  const splitSpan = startStep(run, "split-files");
  splitFiles(finalResult.text, runDir);
  splitSpan.update({ output: { runDir } }).end();

  const depSpan = startStep(run, "dependency-completeness");
  const depCheck = checkDependencyCompleteness(runDir);
  report.missingDependencies = depCheck.missing;
  depSpan.update({
    output: depCheck,
    level: depCheck.missing.length > 0 ? "WARNING" : "DEFAULT",
    statusMessage: depCheck.missing.length > 0 ? `undeclared: ${depCheck.missing.join(", ")}` : undefined,
  }).end();
  if (depCheck.missing.length > 0) {
    console.log(`==> WARNING: imported but not declared in package.json: ${depCheck.missing.join(", ")}`);
  }

  let passedCleanly;
  const verifySpan = startStep(run, `verify:${verifyType}`);
  if (verifyType === "terraform-docker") {
    console.log("==> running terraform validate + docker build...");
    const iacResult = verifyTerraformAndDocker(runDir, task.verify || {});
    report.terraformValid = iacResult.terraformValid;
    report.dockerBuildOk = iacResult.dockerBuildOk;
    writeFileSync(path.join(runDir, "terraform-validate-output.txt"), iacResult.terraformOutput);
    writeFileSync(path.join(runDir, "docker-build-output.txt"), iacResult.dockerOutput);
    passedCleanly = iacResult.terraformValid !== false && iacResult.dockerBuildOk !== false;
    verifySpan.update({
      output: { terraformValid: iacResult.terraformValid, dockerBuildOk: iacResult.dockerBuildOk },
    });
    if (iacResult.terraformValid === null) console.log("==> NOTE: terraform not available, skipped");
    if (iacResult.dockerBuildOk === null) console.log("==> NOTE: docker not available, skipped");
  } else {
    console.log("==> running test suite...");
    const testRun = spawnSync("node", ["--test"], { cwd: runDir, encoding: "utf8" });
    const testOutput = testRun.stdout + testRun.stderr;
    const passMatch = testOutput.match(/# pass (\d+)/) || testOutput.match(/ℹ pass (\d+)/);
    const failMatch = testOutput.match(/# fail (\d+)/) || testOutput.match(/ℹ fail (\d+)/);
    report.testsPass = passMatch ? Number(passMatch[1]) : null;
    report.testsFail = failMatch ? Number(failMatch[1]) : null;
    report.testsPassedCleanly = testRun.status === 0;
    writeFileSync(path.join(runDir, "test-output.txt"), testOutput);
    passedCleanly = report.testsPassedCleanly;
    verifySpan.update({
      output: { testsPass: report.testsPass, testsFail: report.testsFail, exitCode: testRun.status },
    });
  }
  verifySpan.update({ level: passedCleanly ? "DEFAULT" : "WARNING" }).end();

  console.log("\n==> RESULT");
  console.log(JSON.stringify(report, null, 2));
  writeFileSync(path.join(runDir, "bench-report.json"), JSON.stringify(report, null, 2));

  emitScores(report);
  run.update({
    output: report,
    level: passedCleanly ? "DEFAULT" : "WARNING",
    statusMessage: passedCleanly ? undefined : "verification did not pass cleanly",
  }).end();
  await shutdownTracing();

  if (!passedCleanly) {
    console.log(
      `\n==> verification did NOT pass cleanly. Review ${runDir} by hand — this is expected to need human review, not a script bug.`
    );
  }
}

main();
