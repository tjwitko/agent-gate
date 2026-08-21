#!/usr/bin/env node
// Compare several candidate models across several benchmark tasks in ONE Langfuse experiment,
// so "which model should go into presets.ini?" is answered by a table rather than by diffing
// bench-report.json files by hand.
//
// Relationship to run-benchmark.mjs: this is a thin comparison layer over it, not a second
// implementation. Each cell in the model × task grid is a real `node run-benchmark.mjs` child
// process, so every guarantee that script provides — the real delegation path through
// index.mjs, escalating max_tokens on truncation, the dependency-completeness check, the
// task-appropriate verification — holds here unchanged. This file only decides what to run,
// reads back the bench-report.json each run already writes, and turns those numbers into
// scored experiment items.
//
// Two consequences of the child-process design, both intentional:
//   - Each child emits its own detailed trace (per-attempt generations, verification spans).
//     Those stay separate from the experiment trace; the experiment's metadata carries the run
//     label so you can find them.
//   - Runs are strictly sequential. They contend for one llama-server, so any parallelism would
//     distort exactly the wall-clock and token numbers the comparison exists to measure.
//
// Usage:
//   node run-experiment.mjs --models delegate-fast,Qwen3.5-9B-UD-Q4_K_XL.gguf
//   node run-experiment.mjs --models delegate-fast --tasks task.json,task-iac.json
//   --name <str>            experiment name (default: local-delegate-bench)
//   --start-max-tokens <n>  passed through to run-benchmark.mjs
//   --max-attempts <n>      passed through to run-benchmark.mjs
//
// Requires the langfuse-local stack to be up; without it there is nowhere to record an
// experiment, so unlike run-benchmark.mjs this script exits rather than degrading.

import { spawnSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { LangfuseClient } from "@langfuse/client";
import { getLangfuseConfig } from "./langfuse-tracing.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, "run-benchmark.mjs");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { models: [], tasks: ["task.json"], name: "local-delegate-bench", startMaxTokens: null, maxAttempts: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--models") opts.models = args[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (args[i] === "--tasks") opts.tasks = args[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (args[i] === "--name") opts.name = args[++i];
    else if (args[i] === "--start-max-tokens") opts.startMaxTokens = args[++i];
    else if (args[i] === "--max-attempts") opts.maxAttempts = args[++i];
  }
  if (opts.models.length === 0) {
    console.error("usage: node run-experiment.mjs --models <alias>[,<alias>...] [--tasks task.json,task-iac.json] [--name str]");
    process.exit(1);
  }
  return opts;
}

// Turn "delegate-fast" + "task-iac.json" into a filesystem-safe runs/ label.
const labelFor = (model, taskFile) =>
  `${model}__${path.basename(taskFile, ".json")}`.replace(/[^A-Za-z0-9_.-]/g, "-");

function runOne({ model, taskFile, opts }) {
  const label = labelFor(model, taskFile);
  const argv = [RUNNER, "--model", model, "--task", taskFile, "--label", label];
  if (opts.startMaxTokens) argv.push("--start-max-tokens", opts.startMaxTokens);
  if (opts.maxAttempts) argv.push("--max-attempts", opts.maxAttempts);

  console.log(`\n─── ${model} × ${taskFile} ─────────────────────────────────`);
  // stdio inherited so a long run still shows the child's live progress, exactly as it looks
  // when run-benchmark.mjs is invoked directly.
  const res = spawnSync("node", argv, { cwd: __dirname, stdio: "inherit" });

  const reportPath = path.join(__dirname, "runs", label, "bench-report.json");
  if (!existsSync(reportPath)) {
    // The child died before writing a report at all — a crashed llama-server, most likely.
    return { model, taskFile, label, completed: false, harnessFailed: true, exitCode: res.status };
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  return { ...report, model, taskFile, label, harnessFailed: false, exitCode: res.status };
}

// --- per-item evaluators -----------------------------------------------------------------
// Each returns a number, because Langfuse charts numeric scores over time and the entire point
// is trend comparison across candidate models.

const completed = async ({ output }) => ({
  name: "completed",
  value: output.completed ? 1 : 0,
  comment: output.harnessFailed ? `harness failure (exit ${output.exitCode})` : output.completed ? "complete response" : "never completed within budget",
});

const verificationPassed = async ({ output }) => {
  // Which check counts as "passed" depends on the task shape, and a skipped check (null, because
  // terraform/docker was not on PATH) is deliberately not scored as a failure.
  if (typeof output.testsPassedCleanly === "boolean") {
    return { name: "verification_passed", value: output.testsPassedCleanly ? 1 : 0, comment: `tests ${output.testsPass ?? "?"} pass / ${output.testsFail ?? "?"} fail` };
  }
  const tf = output.terraformValid;
  const dk = output.dockerBuildOk;
  if (typeof tf === "boolean" || typeof dk === "boolean") {
    const failed = tf === false || dk === false;
    return { name: "verification_passed", value: failed ? 0 : 1, comment: `terraform=${tf ?? "skipped"} docker=${dk ?? "skipped"}` };
  }
  return { name: "verification_passed", value: 0, comment: "never reached verification" };
};

const attempts = async ({ output }) => ({
  name: "attempts", value: output.attempts ?? 0, comment: "lower is better",
});

const tokens = async ({ output }) => ({
  name: "total_local_tokens", value: output.totalLocalTokens ?? 0, comment: "lower is better",
});

const wallClock = async ({ output }) => ({
  name: "wall_clock_seconds", value: output.totalElapsedSeconds ?? 0, comment: "lower is better",
});

const undeclaredDeps = async ({ output }) => ({
  name: "missing_dependencies",
  value: Array.isArray(output.missingDependencies) ? output.missingDependencies.length : 0,
  comment: output.missingDependencies?.join(", ") || "none",
});

// --- run-level aggregates ----------------------------------------------------------------

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const valuesOf = (itemResults, name) =>
  itemResults.flatMap((r) => r.evaluations ?? []).filter((e) => e.name === name).map((e) => Number(e.value));

const passRate = async ({ itemResults }) => {
  const vs = valuesOf(itemResults, "verification_passed");
  const avg = mean(vs);
  return { name: "pass_rate", value: avg, comment: avg === null ? "no items" : `${vs.filter(Boolean).length}/${vs.length} tasks verified clean` };
};

const avgAttempts = async ({ itemResults }) => ({
  name: "avg_attempts", value: mean(valuesOf(itemResults, "attempts")),
});

const totalTokens = async ({ itemResults }) => {
  const sum = valuesOf(itemResults, "total_local_tokens").reduce((a, b) => a + b, 0);
  return { name: "total_tokens_all_tasks", value: sum, comment: "total local tokens burned across every task" };
};

const totalWallClock = async ({ itemResults }) => {
  const sum = valuesOf(itemResults, "wall_clock_seconds").reduce((a, b) => a + b, 0);
  return { name: "total_wall_clock_seconds", value: sum };
};

async function main() {
  const opts = parseArgs();
  const cfg = getLangfuseConfig();
  if (!cfg.publicKey || !cfg.secretKey) {
    console.error("error: no Langfuse credentials found.");
    console.error("       start the stack first: ../langfuse-local/langfuse.sh up");
    process.exit(1);
  }

  for (const taskFile of opts.tasks) {
    if (!existsSync(path.join(__dirname, taskFile))) {
      console.error(`error: task file not found: bench/${taskFile}`);
      process.exit(1);
    }
  }

  const langfuse = new LangfuseClient({ publicKey: cfg.publicKey, secretKey: cfg.secretKey, baseUrl: cfg.baseUrl });

  // One dataset item per task; one experiment run per model. Same items across models is what
  // makes the comparison meaningful.
  const data = opts.tasks.map((taskFile) => {
    const task = JSON.parse(readFileSync(path.join(__dirname, taskFile), "utf8"));
    return {
      input: { taskFile, taskType: task.taskType || "node-rest" },
      expectedOutput: { completed: true, verificationPassed: true },
      metadata: { requiredMarkers: task.requiredMarkers?.length ?? null, expectedOutputLines: task.expected_output_lines ?? null },
    };
  });

  console.log(`==> experiment "${opts.name}": ${opts.models.length} model(s) × ${opts.tasks.length} task(s), run sequentially`);

  const summaries = [];
  for (const model of opts.models) {
    const result = await langfuse.experiment.run({
      name: opts.name,
      runName: model,
      description: `local-delegate-mcp benchmark: ${model} across ${opts.tasks.join(", ")}`,
      data,
      task: async ({ input }) => runOne({ model, taskFile: input.taskFile, opts }),
      evaluators: [completed, verificationPassed, attempts, tokens, wallClock, undeclaredDeps],
      runEvaluators: [passRate, avgAttempts, totalTokens, totalWallClock],
      // One local llama-server: parallelism here would corrupt the timing numbers.
      maxConcurrency: 1,
      metadata: { models: opts.models, tasks: opts.tasks, runLabels: opts.tasks.map((t) => labelFor(model, t)) },
    });
    summaries.push({ model, result });
  }

  for (const { model, result } of summaries) {
    console.log(`\n══ ${model} ${"═".repeat(Math.max(0, 60 - model.length))}`);
    try {
      console.log(await result.format());
    } catch {
      console.log("  (no formatted summary available)");
    }
  }

  await langfuse.flush();
  await langfuse.shutdown();

  console.log(`\n==> done. Compare runs side by side at ${cfg.baseUrl} → Experiments → "${opts.name}".`);
  console.log("==> reminder: a clean pass is not a code review. Read bench/runs/<label>/ before adopting a model.");
}

main().catch((err) => {
  console.error("experiment failed:", err);
  process.exit(1);
});
