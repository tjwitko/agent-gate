#!/usr/bin/env node
// An MCP-enabled tool-calling loop for a local model served by llama-server.
//
// Purpose: local-delegate-mcp makes a single completion call with no tool loop, so a local model
// driven through it can never reach an MCP server. This closes that gap — it plays the role
// VS Code Copilot Chat plays: hold the MCP connections, advertise their tools to the model,
// execute the calls the model emits, feed results back, repeat.
//
// Usage:
//   node agent-loop.mjs --model <alias> --project <dir> --task <file> [--max-turns 40]

import { spawn, spawnSync } from "child_process";
import { createHash } from "crypto";
import { createRequire } from "module";
import http from "http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Imported eagerly but constructed lazily — the SDK client is only built on first hosted call,
// so a local run never needs ANTHROPIC_API_KEY to be set.
import { chatAnthropic, DEFAULT_MODEL as ANTHROPIC_DEFAULT_MODEL } from "./anthropic-adapter.mjs";
import { immutabilityFailures, taskRequiresImmutability } from "./immutability.mjs";
import { retentionFailures, taskRetentionRequirement } from "./retention.mjs";
import { testExecutionReport } from "./test-execution.mjs";
import { authenticationFailures } from "./authentication.mjs";
import { manifestContractFailures } from "./manifest-contract.mjs";
import { k8sManifestFailures } from "./k8s-manifest.mjs";
import { secretRotationFailures } from "./secret-rotation.mjs";
import { iamContractFailures } from "./iam-contract.mjs";
import { artifactPresenceFailures, artifactInventory, artifactRegressions } from "./artifact-presence.mjs";
import { codeQualityFailures, taskWantsTests } from "./code-quality.mjs";
import { SKIP_DIRS } from "./skip-dirs.mjs";
import { findsLockfile, NOT_AUTHORITATIVE_NOTE } from "./lockfiles.mjs";
import { declaredFixtures, isDeclaredFixture } from "./fixture-markers.mjs";
import { ensureGitignore, isArtifact, ensureRepo } from "./commit-gate.mjs";
// Shared with bench/, not duplicated: one definition of how this repo talks to Langfuse means the
// loop and the benchmark can never disagree about which instance or which credentials. Everything
// it exports degrades to a no-op with the same shape when the stack is down, so tracing can never
// fail a run -- the same constraint bench/ was written under, and it matters more here, where a
// run is 40 minutes of real model time.
import {
  initTracing, tracingEnabled, startRun, startAttempt, finishAttempt, startStep, scoreRun, shutdownTracing,
} from "../bench/langfuse-tracing.mjs";

// The gate lives in lib/gate-core.mjs. These five are what driving a model through it needs;
// the re-exports below keep every existing importer of this file working unchanged.
import {
  McpClient, localTools, validateProject, loadSecretScanner, protectRepo,
  resolveHooksDir, resolveSecretScannerEntry, resolveCensusEntry, terraformRoots,
  unavailableCheckers, UNAVAILABLE,
} from "../lib/gate-core.mjs";

export {
  McpClient, localTools, validateProject, resolveHooksDir, resolveSecretScannerEntry,
  resolveCensusEntry, terraformRoots, unavailableCheckers, UNAVAILABLE,
};

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { model: null, project: null, task: null, maxTurns: 40, maxTokens: 4000, webSearch: false, maxValidationRounds: 3, advisor: null, advisorFile: null, provider: "local" };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--model") o.model = a[++i];
    else if (a[i] === "--project") o.project = path.resolve(a[++i]);
    else if (a[i] === "--task") o.task = a[++i];
    else if (a[i] === "--max-turns") o.maxTurns = Number(a[++i]);
    else if (a[i] === "--max-tokens") o.maxTokens = Number(a[++i]);
    else if (a[i] === "--web-search") o.webSearch = true;
    else if (a[i] === "--max-validation-rounds") o.maxValidationRounds = Number(a[++i]);
    // Defaults to the builder model itself (resolved after parsing). Self-review is the weakest
    // form — a model grading work it just declared finished — but it is what avoids swapping
    // model tiers mid-run, which this project has crashed llama-server with three times. Read a
    // positive result here as a floor, not a ceiling: an independent reviewer can only do better.
    else if (a[i] === "--advisor") o.advisor = a[++i];
    // Hands the review to a human (or a stronger assistant driving this loop from outside):
    // the gate writes the deliverable to <path>.request.md and blocks until <path>.advisory.md
    // appears. Exists to measure what a better reviewer is worth, against the same task and the
    // same builder, without pretending a 12B self-review is the ceiling.
    else if (a[i] === "--advisor-file") o.advisorFile = path.resolve(a[++i]);
    else if (a[i] === "--no-advisor") o.advisor = "none";
    // "anthropic" routes the builder to a hosted Claude model. Everything else about the run is
    // unchanged — same tools, same gate, same advisory channel — so a hosted run and a local run
    // differ in the model and nothing else, and any behavioural difference is attributable.
    else if (a[i] === "--provider") o.provider = a[++i];
  }
  if (o.provider === "anthropic" && !o.model) o.model = ANTHROPIC_DEFAULT_MODEL;
  if (!o.model || !o.project || !o.task) {
    console.error(
      "usage: agent-loop.mjs --model <alias> --project <dir> --task <file> " +
        "[--max-turns 40] [--max-tokens 4000] [--web-search] [--max-validation-rounds 3] " +
        "[--advisor <alias>|--no-advisor]"
    );
    process.exit(1);
  }
  if (o.advisorFile) o.advisor = null;
  else if (o.advisor === null) o.advisor = o.model;
  else if (o.advisor === "none") o.advisor = null;
  return o;
}

// ---------------------------------------------------------------------------
// Minimal MCP stdio client. Speaks the same JSON-RPC handshake the probe scripts
// in this scratchpad use: initialize -> notifications/initialized -> tools/list / tools/call.
// ---------------------------------------------------------------------------

const LLAMA_URL = process.env.LOCAL_LLM_URL || "http://localhost:8080";
// Tool results feed straight back into a 32k context window, so an unbounded terraform plan
// dump or file read would eat the budget the model needs for actual work.
const MAX_TOOL_RESULT_CHARS = 2500;
// Identical consecutive writes to the same path. Two could be a hiccup; by the third the model is
// looping, and by the fifth it has proven it will not stop on its own.
// A model cannot act on more than a handful of failures per turn, and an uncapped list can exceed
// the context window on its own.
const MAX_FAILURES_SHOWN = 8;
const NO_PROGRESS_NUDGE = 3;
const NO_PROGRESS_STOP = 5;
// How many recent versions of each file to remember. Progress was originally judged against the
// immediately preceding write only, which catches a model repeating itself and misses one
// oscillating: a real run alternated between a 20-line and a 26-line provider.tf for its last ten
// writes -- 26, 20, 26, 20, 26, 20 -- and never produced two identical writes in a row, so the
// counter reset every time and the run burned all 120 turns. Remembering a short history catches
// both shapes, since a repeat is a repeat whether or not something else came between.
const WRITE_HISTORY = 6;

// ---------------------------------------------------------------------------
// Advisory pass. The deterministic validators answer "is this well-formed?"; nothing in the
// stack answers "does this do what was asked?" — and that is where the real defects have been.
// A run whose Terraform validated, whose security scan passed, whose dependency scan passed and
// whose pre-commit hook passed still shipped an audit log whose immutability was decorative and
// a Kubernetes manifest that could only ever CrashLoopBackOff. No rule catches either.
//
// Strictly advisory: it never sets validationPassed to false and never blocks the run. It is a
// sampled opinion, and letting a sampled opinion gate anything converts a hard boundary into a
// soft one. It is delivered through the gate's message because that is the one channel in this
// system with guaranteed attention — the model must read it to know whether it may stop.
// ---------------------------------------------------------------------------

const ADVISOR_MAX_FILE_CHARS = 6000;
const ADVISOR_MAX_TOTAL_CHARS = 40000;

// Measured, not guessed. This model emits chain-of-thought into a separate `reasoning_content`
// channel and only then writes `content`; on a real project it spent 16k characters reasoning
// before its first finding. At 600 and at 2500 the whole allowance went to reasoning and
// `content` came back EMPTY with finish_reason "length" — which reads as "the reviewer found
// nothing", the most dangerous way for a check to fail. At 5000 it answered in 8.7k tokens.
const ADVISOR_MAX_TOKENS = 5000;

function collectProjectFiles(projectDir) {
  const skipDirs = new Set([".git", "node_modules", ".terraform", "__pycache__", ".venv", "venv"]);
  const parts = [];
  let total = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (skipDirs.has(e.name) || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (total >= ADVISOR_MAX_TOTAL_CHARS) return;
      let body;
      try {
        if (statSync(full).size > 1024 * 1024) continue;
        body = readFileSync(full, "utf8");
      } catch {
        continue; // binary or unreadable
      }
      const rel = path.relative(projectDir, full);
      const clipped = body.slice(0, ADVISOR_MAX_FILE_CHARS);
      parts.push(`===== ${rel} =====\n${clipped}${body.length > clipped.length ? "\n... (truncated)" : ""}`);
      total += clipped.length;
    }
  };
  walk(projectDir);
  return parts.join("\n\n");
}

const ADVISOR_SYSTEM =
  "You are a security-minded staff engineer reviewing a deliverable against the requirement it " +
  "was built from. You are not checking syntax — automated tools already did that and passed. " +
  "You are answering one question: does this actually do what was asked?\n\n" +
  "Report only defects you can point at in the files shown. For each, name the file and say what " +
  "goes wrong in concrete terms — what an attacker or an operator would actually experience. " +
  "Prioritise: (1) a stated requirement that is not really met, however much it looks met; " +
  "(2) something that cannot work at runtime; (3) a security property that is claimed but not " +
  "enforced.\n\n" +
  "Do not suggest style changes, extra tests, more logging, or nice-to-haves. Do not repeat " +
  "something the automated checks would already catch. If the deliverable genuinely meets the " +
  "requirement, reply with exactly: NONE\n\n" +
  "Format: at most 5 items, one per line, each starting '- <file>: '.";

// Returns { findings: string[], usage } — never throws. An advisor that is down, slow, or
// talking nonsense must not affect a run that was otherwise fine.
//
// Budget generously. Measured on Gemma against a four-line file: max_tokens 600 returned EMPTY
// content with finish_reason "length" — it spent the whole allowance before writing anything —
// while 1200 answered correctly in 826 tokens. A too-small advisory budget does not produce a
// short review, it produces silence that looks exactly like "nothing wrong here".
// Blocks until an external reviewer answers. Deliberately blocking rather than polling-with-
// default: an external review that silently times out and returns "no findings" is the same
// dangerous failure as the empty-answer case below — it reads as a clean bill of health.
async function runExternalAdvisor(projectDir, taskText, basePath, advisories = []) {
  const files = collectProjectFiles(projectDir);
  const requestPath = `${basePath}.request.md`;
  const answerPath = `${basePath}.advisory.md`;

  writeFileSync(
    requestPath,
    `# Advisory request\n\n## The requirement the developer was given\n\n${taskText}\n\n` +
      `## The files they produced\n\n${files}\n\n` +
      // Surfaced to the reviewer rather than blocking the run. A rename and a deletion are
      // identical to the census; only a reviewer can tell them apart.
      (advisories.length
        ? `## Automated checks flagged these, without blocking\n\n` +
          advisories.map((a) => `- ${a}`).join("\n") + `\n\n`
        : "") +
      `---\n` +
      `## How to answer\n\n` +
      `Write your review to ${answerPath}.\n\n` +
      `ONLY lines beginning "- " are read. Headings, prose and code blocks are discarded without\n` +
      `warning, so a finding that is not on such a line does not reach the developer. Put the whole\n` +
      `finding on the line:\n\n` +
      "```\n" +
      `- The get_item check before put_item is a race: two callbacks with the same id can both read\n` +
      `  absent and both write. Use ConditionExpression="attribute_not_exists(event_id)" instead.\n` +
      `- SUPPORT_API_KEY is read by the app and set by no manifest, so unset it compares None to\n` +
      `  None and the endpoint serves anyone.\n` +
      "```\n\n" +
      `Or the single word NONE if there is nothing to report.\n`
  );
  console.log(`[advisor] waiting for an external review`);
  console.log(`[advisor]   request: ${requestPath}`);
  console.log(`[advisor]   answer here: ${answerPath}`);

  const deadline = Date.now() + 60 * 60 * 1000;
  while (!existsSync(answerPath)) {
    if (Date.now() > deadline) {
      console.warn("[advisor] no external review after 60 min — treating this run as UNREVIEWED");
      return { findings: [], usage: null, inconclusive: true };
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  const text = readFileSync(answerPath, "utf8").trim();
  if (/^NONE\b/i.test(text)) return { findings: [], usage: null };
  const findings = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-"));
  // A review that says something but yields no parseable finding is NOT the same as a review that
  // says NONE, and treating them alike let a reviewer's substantive findings vanish: a structured
  // markdown review was written here, only its incidental bullets matched, and the two most
  // important items -- both prose under headings -- were silently discarded while the run recorded
  // the review as delivered. Reported as inconclusive, the same as a reviewer who never answered.
  if (findings.length === 0) {
    console.warn(
      `[advisor] the review at ${answerPath} contains no line starting with "- " and is not the ` +
        `word NONE, so nothing could be read from it — treating this run as UNREVIEWED. Findings ` +
        `must be one per line starting "- ".`
    );
    return { findings: [], usage: null, inconclusive: true };
  }
  return { findings, usage: null };
}

async function runAdvisor(projectDir, taskText, advisorModel, maxTokens) {
  const files = collectProjectFiles(projectDir);
  if (!files.trim()) return { findings: [], usage: null };

  const messages = [
    { role: "system", content: ADVISOR_SYSTEM },
    {
      role: "user",
      content:
        `THE REQUIREMENT THE DEVELOPER WAS GIVEN:\n${taskText}\n\n` +
        `THE FILES THEY PRODUCED:\n\n${files}\n\n` +
        `List the ways this fails to meet the requirement, or reply NONE.`,
    },
  ];

  let response;
  try {
    response = await chat(advisorModel, messages, undefined, maxTokens);
  } catch (error) {
    console.warn(`[advisor] unavailable (${error.message}) — continuing without advisory findings`);
    return { findings: [], usage: null };
  }

  const choice = response.choices?.[0] || {};
  const text = (choice.message?.content || "").trim();
  const usage = response.usage || null;

  // Silence is not a clean bill of health. An empty answer that ran out of budget must be
  // reported as a failed review, never folded in with "found nothing".
  if (!text) {
    if (choice.finish_reason === "length") {
      console.warn(
        `[advisor] produced no answer — it used its entire ${maxTokens}-token budget on internal ` +
          `reasoning. Treat this run as UNREVIEWED, not as clean.`
      );
    }
    return { findings: [], usage, inconclusive: true };
  }
  if (/^NONE\b/i.test(text)) return { findings: [], usage };

  const findings = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-"))
    .slice(0, 5);
  return { findings, usage };
}

// Deliberately node:http rather than fetch. llama-server sends no response headers until the
// whole generation has finished, and Node's fetch enforces a 300s headers timeout
// (undici UND_ERR_HEADERS_TIMEOUT) that CANNOT be raised with AbortSignal.timeout — verified
// directly: a 405s AbortSignal still died at 300s. A long generation over a large prompt on a
// 12B model exceeds that on this hardware, and it surfaces as a bare "fetch failed",
// indistinguishable from the server being down. Callers that treat a failed call as an empty
// result therefore report success on work that never ran.
//
// Same timeout scaling index.mjs already uses. setTimeout here is socket inactivity, which for a
// server that streams nothing is effectively total elapsed time — the semantics we want.
// The prompt term is not optional at large context. This formula originally scaled with
// max_tokens alone — i.e. with GENERATION — and a run died at turn 71 with the server perfectly
// healthy: 55,905 tokens of context, and prefill alone took longer than the whole 630s budget
// that 4,000 max_tokens buys. Re-reading the entire conversation is work the model does before it
// emits a single token, and it grows every turn, so a generation-only budget gets tighter exactly
// as the run gets more expensive.
//
// 15ms per prompt token is calibrated from that failure, not chosen: it leaves the ceiling
// unchanged for small contexts (where the old value was fine for eleven runs) and roughly doubles
// it by 55K. Raising the ceiling does delay detection of a genuinely wedged server — acceptable
// here, because these runs are unattended and a false timeout discards real work, while a hung
// server costs only waiting.
// Loading the weights is not a function of how many tokens were asked for, so the formula below
// cannot cover it. A 12B model at a 64k context is roughly 9GB, and on a machine under memory
// pressure that first read took longer than the entire per-request budget: three consecutive runs
// died on `turn 1 request failed: llama-server did not respond within 637s`, while the identical
// request -- same ten tool schemas, same 7,439 bytes -- answered in 60s once the model was resident.
//
// So the first request of a run is made deliberately, tiny, and with a budget sized for a disk
// read rather than a generation. It turns a mid-run failure into a startup wait that says what it
// is waiting for.
const WARMUP_TIMEOUT_MS = 15 * 60 * 1000;

async function warmModel(model, provider) {
  if (provider !== "local") return; // hosted providers have no local load to pay for
  const started = Date.now();
  try {
    await postJson(
      `${LLAMA_URL}/v1/chat/completions`,
      { model, messages: [{ role: "user", content: "ready" }], max_tokens: 1 },
      WARMUP_TIMEOUT_MS
    );
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    if (Number(secs) > 20) console.log(`[loop] model loaded in ${secs}s (cold start)`);
  } catch (error) {
    // Not fatal: the turn loop reports the real failure with better context than a warmup can.
    console.warn(`[loop] warmup failed after ${((Date.now() - started) / 1000).toFixed(0)}s: ${error.message}`);
  }
}

// The per-token term is a throughput floor in disguise: at 150ms/token a full-budget generation
// has to sustain 6.4 tok/s to finish inside its own timeout. This machine measured 5.5, 11.0, 15.9,
// 19.3 and 21.7 tok/s across one afternoon depending on memory pressure -- the floor sat inside the
// observed range, so a run died whenever it landed at the low end. Three did, and the failure reads
// as "llama-server did not respond", which points at the server when the server was generating
// normally and the client gave up: its own log records `Connection handling canceled`, not an error.
//
// 400ms/token puts the floor at 2.5 tok/s, below anything measured here. The cost of being wrong in
// this direction is a slow run; the cost of being wrong in the other is a dead one, and a dead run
// throws away everything before it.
const MS_PER_OUTPUT_TOKEN = 400;
const MS_PER_PROMPT_TOKEN = 15;

function requestTimeoutMs(maxTokens, promptTokens = 0) {
  return 30_000 + (maxTokens || 0) * MS_PER_OUTPUT_TOKEN + promptTokens * MS_PER_PROMPT_TOKEN;
}

// Prompt size in tokens, near enough. ~4 chars/token is crude but this only has to pick a
// timeout, and being wrong by a third moves the budget by minutes on a budget already measured
// in tens of minutes.
function estimatePromptTokens(messages) {
  let chars = 0;
  for (const m of messages || []) {
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) chars += JSON.stringify(m.content).length;
    for (const c of m.tool_calls || []) chars += (c.function?.arguments || "").length;
  }
  return Math.ceil(chars / 4);
}

// keepAlive:false is not incidental. With Node's default agent, llama-server closes the socket
// after answering and the next request reuses the dead one — the second turn of a run dies with
// "socket hang up" while the server is perfectly healthy. Reconnecting per request costs nothing
// next to a multi-second generation.
const LLAMA_AGENT = new http.Agent({ keepAlive: false });

function postJson(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: "POST",
        agent: LLAMA_AGENT,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Connection: "close",
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`llama-server ${res.statusCode}: ${data.slice(0, 500)}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`llama-server sent unparseable JSON: ${data.slice(0, 300)}`));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error(`llama-server did not respond within ${Math.round(timeoutMs / 1000)}s`))
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function chat(model, messages, tools, maxTokens, provider = "local") {
  if (provider === "anthropic") return chatAnthropic(model, messages, tools, maxTokens);
  return postJson(
    `${LLAMA_URL}/v1/chat/completions`,
    { model, messages, tools, max_tokens: maxTokens },
    requestTimeoutMs(maxTokens, estimatePromptTokens(messages))
  );
}

// Runs every validator that applies to what is actually on disk, without waiting to be asked.
//
// This is the difference between a checklist and a gate. Measured across four runs of the same
// task with identical tooling, the model called terraform_plan 3, 1, 4 and 0 times, and never
// called check_dependencies or web_search at all. A tool the model may or may not invoke is not a
// guardrail. Note the gate is on validators *passing*, not on tools having been *called* — a model
// can call a validator, receive errors, and finish anyway, which is exactly what happened in one run.
async function main() {
  const opts = parseArgs();
  mkdirSync(opts.project, { recursive: true });
  ensureRepo(opts.project);

  // Server paths resolve relative to this repo rather than a hardcoded $HOME/LLM, so a checkout
  // anywhere works as long as the sibling repos sit alongside it. Override individually with the
  // TFGUARD_SERVER / DEPAUDIT_SERVER / WEBSEARCH_SERVER env vars; a server whose file is missing
  // is skipped with a warning instead of taking the whole run down.
  const siblings = path.resolve(__dirname, "..", "..");
  const candidates = [
    {
      name: "terraform-guard",
      envVar: "TFGUARD_SERVER",
      // The interesting one: it can refuse, and its refusals come back as structured violations
      // the model can parse and act on.
      entry: process.env.TFGUARD_SERVER || path.join(siblings, "terraform-guard-mcp", "index.mjs"),
      env: { TF_WORKING_ROOT: opts.project },
    },
    {
      name: "dep-audit",
      envVar: "DEPAUDIT_SERVER",
      entry: process.env.DEPAUDIT_SERVER || path.join(siblings, "dep-audit-mcp", "index.mjs"),
      env: { SCAN_ROOT: opts.project },
    },
    {
      name: "identity-guard",
      envVar: "IDENTITYGUARD_SERVER",
      entry: process.env.IDENTITYGUARD_SERVER || path.join(siblings, "identity-guard-mcp", "index.mjs"),
      env: { SCAN_ROOT: opts.project },
    },
    {
      // Registered so the model can sweep the whole tree on demand. Note this is the *weaker*
      // half of the secret protection: the half that actually holds is the write_file
      // interception above, which does not depend on the model choosing to call anything.
      name: "secret-guard",
      envVar: "SECRETGUARD_SERVER",
      entry: process.env.SECRETGUARD_SERVER || path.join(siblings, "secret-guard-mcp", "index.mjs"),
      env: { SCAN_ROOT: opts.project },
    },
    {
      // Web search (SearXNG-backed), opt-in via --web-search. Off by default because this repo's
      // own CLAUDE.md argues against giving a local model live fetch access: it has no
      // instruction-hierarchy training, so fetched pages become an injection surface. That
      // reasoning was written about poisoning a context_file during delegation and applies less
      // directly to a standalone agent whose output gets reviewed — but the injection surface is
      // real either way, so it stays something you turn on deliberately. Empirically the model
      // also never called it across three runs where it was available.
      name: "web-search",
      envVar: "WEBSEARCH_SERVER",
      entry:
        process.env.WEBSEARCH_SERVER ||
        // The author's checkout. Any MCP server exposing a `web_search` tool works, and unlike
        // the four controls this one has no published home, so WEBSEARCH_SERVER is the path
        // anyone else will take.
        path.join(siblings, "local-copilot-stack", "mcp-web-search", "index.mjs"),
      env: {},
      optIn: true,
    },
  ];

  // local-delegate is deliberately never exposed — a local model delegating to a local model is
  // circular.
  const servers = [];
  for (const c of candidates) {
    if (c.optIn && !opts.webSearch) continue;
    if (!existsSync(c.entry)) {
      // Name the override. The sibling default is a convenience, not a requirement -- web-search
      // defaults into local-copilot-stack, which is not published, so without this the message
      // reads as "you are missing something you cannot get" rather than "tell me where yours is".
      console.error(
        `[loop] skipping ${c.name}: no server at ${c.entry}. Set ${c.envVar} to its entry point.`
      );
      continue;
    }
    servers.push(new McpClient(c.name, "node", [c.entry], c.env));
  }

  const toolRegistry = new Map();
  const toolSchemas = [];

  protectRepo(opts.project);
  const secretScanner = await loadSecretScanner();
  const local = localTools(opts.project, secretScanner);
  for (const [name, def] of Object.entries(local)) {
    toolRegistry.set(name, { kind: "local", run: def.run });
    toolSchemas.push(def.schema);
  }

  for (const server of servers) {
    const tools = await server.init();
    for (const t of tools) {
      // terraform_apply is withheld deliberately: this experiment is about whether scanning
      // improves generated code, and nothing here should be able to mutate infrastructure.
      if (t.name === "terraform_apply") continue;
      toolRegistry.set(t.name, { kind: "mcp", server, toolName: t.name });
      toolSchemas.push({
        type: "function",
        function: {
          name: t.name,
          description: (t.description || "").slice(0, 1200),
          parameters: t.inputSchema || { type: "object", properties: {} },
        },
      });
    }
    console.log(`[loop] ${server.name}: ${tools.map((t) => t.name).join(", ")}`);
  }

  console.log(`[loop] ${toolSchemas.length} tools advertised to ${opts.model}\n`);

  const messages = [
    {
      role: "system",
      content:
        "You are a software engineer working in a project directory. You have tools to write and read files, " +
        "and tools to validate code and infrastructure. Build what the user asks for by calling write_file for " +
        "each file. After writing source files, call build_check and fix every error it reports — code that " +
        "does not compile is not done. When you have written Terraform, validate it with the terraform_plan " +
        "tool and fix anything it reports. When you have written a dependency manifest, check it with " +
        "check_dependencies. When the project is complete, commit it with git_commit — the repository runs " +
        "checks that can reject the commit, and you are not done until it is accepted. Then say DONE.",
    },
    { role: "user", content: readFileSync(opts.task, "utf8") },
  ];

  const usage = { prompt: 0, completion: 0, total: 0, calls: 0 };
  const toolCallLog = [];
  let validationRounds = 0;
  let truncatedStreak = 0;
  let finalValidation = null;
  const taskText = readFileSync(opts.task, "utf8");
  const advisorUsage = { prompt: 0, completion: 0, total: 0, calls: 0 };
  let advisoryFindings = null;   // null = not run yet
  let advisoryDelivered = false;
  let advisoryInconclusive = false;
  // path -> { hashes: recent content digests, revisits: how often a version came back }
  const writeHistory = new Map();
  let noProgressNudged = null;   // the path that triggered the nudge, or null
  let noProgressStopped = null;
  const regressionWarnings = [];
  let lastTracedMessageCount = 0;

  // Before the first turn, so a cold model load is a startup wait rather than a failed turn 1.
  console.log(`[loop] warming ${opts.model}...`);
  await warmModel(opts.model, opts.provider);

  await initTracing();
  const run = startRun(`agent-loop:${path.basename(opts.project)}`, {
    input: taskText,
    metadata: {
      model: opts.model,
      provider: opts.provider,
      project: opts.project,
      maxTurns: opts.maxTurns,
      maxTokens: opts.maxTokens,
      maxValidationRounds: opts.maxValidationRounds,
      advisor: opts.advisorFile ? `external:${path.basename(opts.advisorFile)}` : opts.advisor || null,
      tools: toolSchemas.map((t) => t.function.name),
    },
  });

  // Generations and tool spans are both children of the run rather than nested under a per-turn
  // span. A turn span would be the tidier tree, but this loop exits a turn through eight different
  // `continue`/`break` paths and a span left unclosed on any one of them is worse than a flat
  // tree: it reports as an unfinished observation and makes the run look hung. Each observation
  // carries its turn number in metadata, which is what the flat shape costs and recovers.
  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    let response;
    // Opened before the call, not after: an observation's duration runs from creation, so building
    // it afterwards records a 0s generation and throws away the per-turn wall clock. It also means
    // a turn that never returns shows up as in-flight rather than vanishing.
    const gen = startAttempt(run, {
      name: `turn ${turn}`,
      model: opts.model,
      modelParameters: { max_tokens: opts.maxTokens },
      // The delta since the last turn, not the whole conversation. A 41-turn run re-sends a
      // context that reaches 22k tokens, so recording the full array each time stores the same
      // prose 41 times and buries what actually changed. Total context size is in metadata below.
      input: messages.slice(lastTracedMessageCount),
    });
    lastTracedMessageCount = messages.length;
    try {
      response = await chat(opts.model, messages, toolSchemas, opts.maxTokens, opts.provider);
    } catch (error) {
      finishAttempt(gen, { level: "ERROR", statusMessage: error.message, metadata: { turn } });
      console.log(`[loop] turn ${turn} request failed: ${error.message}`);
      break;
    }

    if (response.usage) {
      usage.prompt += response.usage.prompt_tokens || 0;
      usage.completion += response.usage.completion_tokens || 0;
      usage.total += response.usage.total_tokens || 0;
      usage.calls++;
    }

    const choice = response.choices?.[0];
    const msg = choice?.message || {};
    messages.push(msg);

    const calls = msg.tool_calls || [];
    const preview = (msg.content || "").trim().replace(/\s+/g, " ").slice(0, 160);
    console.log(
      `[turn ${turn}] finish=${choice?.finish_reason} tools=${calls.length} ctx=${response.usage?.prompt_tokens || "?"} ${preview ? `| ${preview}` : ""}`
    );
    finishAttempt(gen, {
      output: { content: msg.content || "", toolCalls: calls.map((c) => c.function?.name) },
      usage: response.usage,
      // A truncated turn is a real event with a real cost, not an error: it is the shape that
      // killed one run at turn 23 and it should be findable in the UI without reading the log.
      level: choice?.finish_reason === "length" ? "WARNING" : undefined,
      statusMessage: choice?.finish_reason === "length" ? "output truncated at max_tokens" : undefined,
      metadata: { turn, finishReason: choice?.finish_reason, contextMessages: messages.length },
    });

    // A tool call cut off by the token limit has truncated JSON arguments — a write_file whose
    // `content` string never closes. Keeping it in the history is fatal on the NEXT request:
    // llama-server re-parses the conversation and returns 500 "Failed to parse tool call
    // arguments as JSON", which killed a real run at turn 23 while the model was emitting a
    // 94-line Terraform file. Drop the partial message rather than record it, and tell the model
    // why, since the fix it needs is to write less per call.
    if (calls.length > 0 && choice?.finish_reason === "length") {
      messages.pop();
      truncatedStreak++;
      console.log(`[loop] turn ${turn} tool call was cut off mid-argument — discarding it`);
      if (truncatedStreak >= 3) {
        console.log("[loop] stopping: three truncated tool calls in a row.");
        break;
      }
      messages.push({
        role: "user",
        content:
          "Your last tool call was cut off before it finished, so it was discarded and nothing " +
          "was written. The file you were writing is too large for one call. Split it into " +
          "smaller files, or write it in sections with several write_file calls, and keep each " +
          "single call well under the token limit.",
      });
      continue;
    }

    // A turn that hits the token limit with no tool call leaves a truncated assistant message. If
    // the next turn does the same, the history ends with two assistant messages in a row and
    // llama-server rejects the request outright ("Cannot have 2 or more assistant messages at the
    // end of the list"), killing the run. Break the streak with a user turn instead.
    if (calls.length === 0 && choice?.finish_reason === "length") {
      truncatedStreak++;
      if (truncatedStreak >= 2) {
        console.log("[loop] stopping: model produced truncated output with no tool calls twice in a row.");
        break;
      }
      messages.push({
        role: "user",
        content:
          "Your last message was cut off before you called a tool. Do not restate your plan in " +
          "prose — make the next tool call directly.",
      });
      continue;
    }
    truncatedStreak = 0;

    if (calls.length === 0) {
      if (/\bDONE\b/i.test(msg.content || "") || choice?.finish_reason === "stop") {
        // The model wanting to stop is a request, not the exit condition. Validators run here
        // whether or not the model ever called them, and failures go back as work to do.
        const gateSpan = startStep(run, `gate:round-${validationRounds + 1}`, { metadata: { turn } });
        const { ran, failures, advisories } = await validateProject(opts.project, toolRegistry, taskText);
        validationRounds++;
        gateSpan
          .update({
            output: { ran, failing: failures.length, failures, advisories },
            level: failures.length ? "WARNING" : "DEFAULT",
          })
          .end();
        console.log(
          `[gate] validation round ${validationRounds}: ran ${ran.join(", ") || "nothing"} — ` +
            `${failures.length} failing`
        );
        finalValidation = { ran, failures, advisories };
        for (const a of advisories) console.log(`[gate] advisory (not blocking): ${a}`);

        // Run once, on the first time the model tries to stop — that is the moment the whole
        // deliverable exists and the model is still in a position to act on what comes back.
        if (opts.advisorFile && advisoryFindings === null) {
          // The external advisor blocks on a human or another agent writing a file, so this span
          // is mostly wall-clock spent waiting. That is worth seeing: it is the single longest
          // thing in most runs and it is invisible in token counts.
          const advSpan = startStep(run, "advisor:external", {
            input: { requestPath: `${opts.advisorFile}.request.md`, advisories },
            metadata: { turn },
          });
          const advice = await runExternalAdvisor(opts.project, taskText, opts.advisorFile, advisories);
          advisoryFindings = advice.findings;
          advisoryInconclusive = !!advice.inconclusive;
          advSpan
            .update({
              output: { findings: advice.findings, inconclusive: !!advice.inconclusive },
              level: advice.inconclusive ? "WARNING" : "DEFAULT",
            })
            .end();
          console.log(`[advisor] external review: ${advisoryFindings.length} finding(s)`);
          for (const f of advisoryFindings) console.log(`    ${f}`);
        } else if (opts.advisor && advisoryFindings === null) {
          const advice = await runAdvisor(opts.project, taskText, opts.advisor, ADVISOR_MAX_TOKENS);
          advisoryFindings = advice.findings;
          if (advice.usage) {
            advisorUsage.prompt += advice.usage.prompt_tokens || 0;
            advisorUsage.completion += advice.usage.completion_tokens || 0;
            advisorUsage.total += advice.usage.total_tokens || 0;
            advisorUsage.calls++;
          }
          advisoryInconclusive = Boolean(advice.inconclusive);
          console.log(
            `[advisor] ${opts.advisor}: ` +
              (advisoryInconclusive ? "INCONCLUSIVE (no answer)" : `${advisoryFindings.length} requirement finding(s)`) +
              (advice.usage ? ` (${advice.usage.total_tokens} tokens)` : "")
          );
          for (const f of advisoryFindings) console.log(`    ${f}`);
        }

        const advisoryText = (advisoryFindings || []).length
          ? `\n\nA reviewer also raised the following about whether this meets the requirement. ` +
            `These are NOT automated check failures and may be wrong — judge each one, fix what is ` +
            `genuinely wrong, and ignore what is not:\n${advisoryFindings.join("\n")}`
          : "";

        if (failures.length === 0) {
          // Advisories never make validation fail. But letting the run end the instant the
          // deterministic checks pass would mean nobody ever reads them — so spend exactly one
          // extra turn offering them, then stop regardless of what the model does with it.
          if (advisoryText && !advisoryDelivered) {
            advisoryDelivered = true;
            console.log("[loop] validation passed; delivering advisory findings for one turn.");
            messages.push({
              role: "user",
              content:
                `All automated checks pass, so you may stop after this turn.${advisoryText}\n\n` +
                `If any of these are real, fix them now and commit. If none are, say DONE.`,
            });
            continue;
          }
          console.log("[loop] model finished and validation passed.");
          break;
        }
        // Capped because iteration is not free of risk: a model that cannot converge starts
        // deleting working code to satisfy the validator. Better to stop and report honestly
        // than to let it thrash indefinitely.
        if (validationRounds > opts.maxValidationRounds) {
          console.log(`[loop] stopping: validation still failing after ${opts.maxValidationRounds} rounds.`);
          break;
        }
        // Capped, because the failure list is built from however many things the validators found
        // and is fed straight back into the conversation. One run produced thousands of failures and
        // the resulting request was 143,066 tokens against a 65,536-token context -- the gate killed
        // the run it was meant to guide. Whatever causes that many failures, the model cannot act on
        // more than a handful at once anyway.
        const shown = failures.slice(0, MAX_FAILURES_SHOWN);
        const omitted = failures.length - shown.length;
        messages.push({
          role: "user",
          content:
            (advisoryDelivered ? "" : ((advisoryDelivered = true), advisoryText)) +
            `Validation failed. You are not finished. Fix these and do not remove working code ` +
            `to make them pass:\n\n${shown.join("\n\n")}` +
            (omitted > 0
              ? `\n\n(+${omitted} more failure(s) not shown. Fix these first, then the rest will be ` +
                `reported again.)`
              : ""),
        });
        continue;
      }
      continue;
    }

    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        // A malformed arguments blob is the model's error to see and correct, not a crash here.
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `ERROR: arguments were not valid JSON: ${(call.function?.arguments || "").slice(0, 300)}`,
        });
        continue;
      }

      const entry = toolRegistry.get(name);
      const toolSpan = startStep(run, `tool:${name}`, { input: args, metadata: { turn, kind: entry?.kind } });
      let result;
      if (!entry) {
        result = `ERROR: no such tool "${name}".`;
      } else {
        try {
          result = entry.kind === "local" ? entry.run(args) : await entry.server.call(entry.toolName, args);
        } catch (error) {
          result = `ERROR: ${error.message}`;
        }
      }
      // A refusal is not an exception, so it would otherwise be indistinguishable from a normal
      // write in the trace -- and refusals (a blocked credential, a guard-config file) are exactly
      // what a run gets reviewed for afterwards.
      const refused = typeof result === "string" && /^(ERROR|REFUSED|COMMIT REJECTED)\b/.test(result);
      toolSpan
        .update({
          output: typeof result === "string" ? result.slice(0, 4000) : result,
          level: refused ? "WARNING" : undefined,
        })
        .end();

      // No-progress detection. The gate asks whether the validators pass; nothing asked whether
      // the model was still moving. A real run wrote app/database.py 39 times across turns 41-70,
      // mostly byte-identical, and burned its entire turn budget without changing anything —
      // rewriting a file with the same bytes is definitionally not progress.
      //
      // Nudge first, then stop. A model that has genuinely lost the thread will not be rescued by
      // a fourth attempt, but one that is merely repeating itself sometimes recovers when told.
      if (name === "write_file" && args.path) {
        const digest = createHash("sha1").update(args.content ?? "").digest("hex");
        const seen = writeHistory.get(args.path) || { hashes: [], revisits: 0 };
        // Content this file has already held is not progress, whether it came back immediately or
        // after a detour through another version. Genuinely new content resets the count, so a
        // model that reverts one bad edit and moves on is not penalised for it.
        if (seen.hashes.includes(digest)) seen.revisits++;
        else seen.revisits = 0;
        seen.hashes.push(digest);
        if (seen.hashes.length > WRITE_HISTORY) seen.hashes.shift();
        writeHistory.set(args.path, seen);

        if (seen.revisits === NO_PROGRESS_NUDGE) {
          console.log(`[loop] ${args.path} keeps returning to content it already had — nudging`);
          noProgressNudged = args.path;
        } else if (seen.revisits >= NO_PROGRESS_STOP) {
          console.log(
            `[loop] stopping: ${args.path} has been rewritten ${seen.revisits} times with content ` +
              `it already had — the run is cycling, not making progress.`
          );
          noProgressStopped = args.path;
          break;
        }
      }

      // The regression warning arrives buried in a tool response, ~600 characters in, and the
      // per-call log line shows only the first line while the report preview caps at 200. A real
      // run deleted three Terraform resources and the warning was, for all practical purposes,
      // unobservable afterwards: fourteen plan calls and no way to establish whether the
      // guardrail had fired. Give it its own line, like [gate] and [advisor] have.
      const regression = /\[REGRESSION WARNING\][^\n]*/.exec(String(result));
      if (regression) {
        console.log(`    [census] ${regression[0].slice(0, 220)}`);
        regressionWarnings.push({ turn, text: regression[0] });
      }

      const short = String(result).slice(0, MAX_TOOL_RESULT_CHARS);
      toolCallLog.push({ turn, name, args: name === "write_file" ? { path: args.path } : args, resultPreview: short.slice(0, 200) });
      console.log(`    -> ${name}(${name === "write_file" ? args.path : JSON.stringify(args).slice(0, 80)}) : ${short.split("\n")[0].slice(0, 120)}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: short });
    }

    if (noProgressStopped) break;
    if (noProgressNudged) {
      const cyclingPath = noProgressNudged;
      noProgressNudged = null;
      messages.push({
        role: "user",
        content:
          `You keep rewriting ${cyclingPath} with content it has already held — switching between ` +
          `versions you have written before, so nothing is changing. Whatever you are trying to ` +
          `fix, this is not fixing it. Read the file, do something genuinely different, or say ` +
          `DONE and explain what is unresolved.`,
      });
    }
  }

  // Always re-validate against the files as they finally stand, rather than reusing the last
  // gate result. The loop can exit on max-turns after the model has already fixed what the gate
  // complained about, and reporting the stale verdict would claim a failure that no longer exists
  // — the same class of dishonest signal this gate exists to remove.
  const finalSpan = startStep(run, "gate:final", {
    metadata: { note: "re-run against the files as they finally stand, not the last gate result" },
  });
  finalValidation = await validateProject(opts.project, toolRegistry, taskText);
  finalSpan
    .update({
      output: {
        ran: finalValidation.ran,
        failing: finalValidation.failures.length,
        failures: finalValidation.failures,
        advisories: finalValidation.advisories || [],
      },
      level: finalValidation.failures.length ? "WARNING" : "DEFAULT",
    })
    .end();
  // Servers are torn down only after the final validation — killing them first left the
  // re-validation writing to dead stdin and crashing the run with EPIPE.
  for (const s of servers) s.kill();
  const report = {
    model: opts.model,
    project: opts.project,
    usage,
    toolCalls: toolCallLog.length,
    validation: { rounds: validationRounds, ran: finalValidation.ran, failures: finalValidation.failures, advisories: finalValidation.advisories || [] },
    validationPassed: finalValidation.failures.length === 0,
    // Deliberately outside `validation`: advisory findings are a sampled opinion and must never
    // be mistaken for, or folded into, the deterministic verdict.
    advisory: { model: opts.advisor, usage: advisorUsage, inconclusive: advisoryInconclusive, findings: advisoryFindings || [] },
    // Recorded so "validation failed" is distinguishable from "the run never got anywhere".
    stoppedForNoProgress: noProgressStopped,
    regressionWarnings,
    toolCallLog,
  };
  // Kept inside the project directory rather than beside it, so a run leaves nothing behind in
  // whatever directory happened to be the parent.
  const reportPath = path.join(opts.project, "agent-run-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`report            : ${reportPath}`);
  console.log("\n=== RUN SUMMARY ===");
  console.log(`local model calls : ${usage.calls}`);
  console.log(`prompt tokens     : ${usage.prompt}`);
  console.log(`completion tokens : ${usage.completion}`);
  console.log(`total tokens      : ${usage.total}`);
  console.log(`tool calls        : ${toolCallLog.length}`);
  const byTool = {};
  for (const c of toolCallLog) byTool[c.name] = (byTool[c.name] || 0) + 1;
  console.log(`by tool           : ${JSON.stringify(byTool)}`);
  console.log(`validators run    : ${finalValidation.ran.join(", ") || "none"}`);
  console.log(`validation        : ${report.validationPassed ? "PASSED" : `FAILED (${finalValidation.failures.length})`}`);
  if (opts.advisor) {
    console.log(`advisory          : ${advisoryInconclusive ? "INCONCLUSIVE" : `${(advisoryFindings || []).length} finding(s)`}, ${advisorUsage.total} local tokens`);
    for (const f of advisoryFindings || []) console.log(`  ${f}`);
  }
  if (!report.validationPassed) {
    for (const f of finalValidation.failures) console.log(`  - ${f.split("\n")[0]}`);
  }

  // Scores rather than metadata, because these are the numbers worth comparing across runs. The
  // adv-series has produced fifteen of them and every comparison so far has been done by hand
  // against saved logs; charted, "did raising the context window change anything?" stops being an
  // archaeology exercise.
  scoreRun(run, { name: "validation-passed", value: report.validationPassed ? 1 : 0 });
  scoreRun(run, { name: "turns-used", value: usage.calls });
  scoreRun(run, { name: "tool-calls", value: toolCallLog.length });
  scoreRun(run, { name: "total-tokens", value: usage.total });
  scoreRun(run, { name: "validation-rounds", value: validationRounds });
  scoreRun(run, {
    name: "advisory-findings",
    value: (advisoryFindings || []).length,
    comment: advisoryInconclusive ? "advisor returned no answer" : undefined,
  });
  run
    .update({
      output: {
        validationPassed: report.validationPassed,
        failures: finalValidation.failures,
        validatorsRun: finalValidation.ran,
        stoppedForNoProgress: noProgressStopped,
        regressionWarnings,
        byTool,
        usage,
      },
      level: report.validationPassed ? "DEFAULT" : "WARNING",
    })
    .end();
  // Before process.exit, or the OTel processor is killed with spans still buffered and the run
  // that just finished never appears. Bounded inside shutdownTracing, so an unreachable server
  // cannot turn a completed run into a hung process.
  if (tracingEnabled()) console.log("[loop] flushing traces to langfuse...");
  await shutdownTracing();
  process.exit(0);
}

// Only when run as a script. Exporting validateProject is what makes the per-check isolation
// testable at all, and an unguarded main() would start a whole agent run on import.
const INVOKED_DIRECTLY = process.argv[1] && process.argv[1].endsWith("agent-loop.mjs");
if (INVOKED_DIRECTLY) main().catch(async (e) => {
  console.error(e);
  // A crashed run is the one most worth having a trace of.
  await shutdownTracing();
  process.exit(1);
});

