#!/usr/bin/env node
// Reusable benchmark for evaluating a candidate local model on local-delegate-mcp's actual
// delegation path, before adopting it into presets.ini. Runs the same standardized codegen
// task used to evaluate every model tested so far (Qwen2.5-Coder-7B, Qwen3.5-9B, Gemma 4 12B)
// against the model alias given on the command line, via the real delegate_to_local_model tool
// (CAPABLE_MODEL_ALIAS is overridden for the run, same mechanism used manually during
// development — see local-copilot-stack's model-selection notes for why this exists).
//
// Automates the mechanical parts: call, detect truncation, retry with an escalated budget,
// integrate the result into a fresh copy of the reference project, run its test suite, and
// report comparable numbers (attempts, tokens, wall-clock, pass/fail). It does NOT automate
// code-quality review — inspect bench/runs/<label>/ yourself before trusting a "pass".
//
// Usage:
//   node run-benchmark.mjs --model <router-preset-alias> [options]
//   --start-max-tokens <n>    initial budget (default 3000)
//   --max-tokens-ceiling <n>  stop escalating past this (default 20000)
//   --max-attempts <n>        give up after this many tries (default 3)
//   --label <name>            runs/ subdirectory name (default: the model alias)
//   --task <path>             alternate task JSON (default: task.json) — e.g. a variant with a
//                             model-specific flag like Qwen3's "/no_think" in system_prompt.
//                             Keep model-specific prompt tweaks in separate task files rather
//                             than branching on model name in here.

import { spawn, spawnSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "index.mjs");
const REFERENCE_DIR = path.join(__dirname, "reference");
const TASK_PATH = path.join(__dirname, "task.json");
const RUNS_DIR = path.join(__dirname, "runs");

// Must match index.mjs's own formula so the harness never times out before the server would.
const TIMEOUT_BASE_MS = 30_000;
const TIMEOUT_PER_TOKEN_MS = 150;
const HARNESS_TIMEOUT_BUFFER_MS = 60_000;

const REQUIRED_MARKERS = [
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

function looksComplete(result) {
  return result.ok && REQUIRED_MARKERS.every((m) => result.text.includes(m));
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

async function main() {
  const opts = parseArgs();
  const task = JSON.parse(readFileSync(opts.taskPath, "utf8"));
  const runDir = path.join(RUNS_DIR, opts.label);

  console.log(`==> benchmarking "${opts.model}" (run dir: ${runDir})`);
  cpSync(REFERENCE_DIR, runDir, { recursive: true });
  console.log("==> npm install...");
  spawnSync("npm", ["install", "--no-fund", "--no-audit"], { cwd: runDir, stdio: "inherit" });

  let maxTokens = opts.startMaxTokens;
  const attempts = [];
  let finalResult = null;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const timeoutMs = TIMEOUT_BASE_MS + maxTokens * TIMEOUT_PER_TOKEN_MS + HARNESS_TIMEOUT_BUFFER_MS;
    console.log(`==> attempt ${attempt}/${opts.maxAttempts}: max_tokens=${maxTokens} (harness timeout ${Math.round(timeoutMs / 1000)}s)`);
    const result = await callDelegate({
      cwd: runDir,
      args: { ...task, model: "capable", max_tokens: maxTokens },
      timeoutMs,
      modelAlias: opts.model,
    });
    attempts.push({ attempt, maxTokens, elapsedMs: result.elapsedMs, usage: result.usage, ok: result.ok, reason: result.reason });
    console.log(`    -> ${result.ok ? "responded" : `failed (${result.reason})`}, ${Math.round(result.elapsedMs / 1000)}s, usage=${JSON.stringify(result.usage)}`);

    if (looksComplete(result)) {
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
    attempts: attempts.length,
    attemptDetail: attempts,
    totalLocalTokens,
    totalElapsedSeconds: Math.round(totalElapsedMs / 1000),
    completed: !!finalResult,
  };

  if (!finalResult) {
    console.log("\n==> RESULT: never produced a complete response within the attempt/token budget.");
    console.log(JSON.stringify(report, null, 2));
    writeFileSync(path.join(runDir, "bench-report.json"), JSON.stringify(report, null, 2));
    process.exit(1);
  }

  splitFiles(finalResult.text, runDir);
  console.log("==> running test suite...");
  const testRun = spawnSync("node", ["--test"], { cwd: runDir, encoding: "utf8" });
  const testOutput = testRun.stdout + testRun.stderr;
  const passMatch = testOutput.match(/# pass (\d+)/) || testOutput.match(/ℹ pass (\d+)/);
  const failMatch = testOutput.match(/# fail (\d+)/) || testOutput.match(/ℹ fail (\d+)/);
  report.testsPass = passMatch ? Number(passMatch[1]) : null;
  report.testsFail = failMatch ? Number(failMatch[1]) : null;
  report.testsPassedCleanly = testRun.status === 0;

  console.log("\n==> RESULT");
  console.log(JSON.stringify(report, null, 2));
  writeFileSync(path.join(runDir, "bench-report.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(runDir, "test-output.txt"), testOutput);

  if (!report.testsPassedCleanly) {
    console.log(
      `\n==> tests did NOT pass out of the box (${report.testsPass ?? "?"} pass / ${report.testsFail ?? "?"} fail). ` +
        `Review ${runDir} by hand — this is expected to need human review, not a script bug.`
    );
  }
}

main();
