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
import http from "http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Imported eagerly but constructed lazily — the SDK client is only built on first hosted call,
// so a local run never needs ANTHROPIC_API_KEY to be set.
import { chatAnthropic, DEFAULT_MODEL as ANTHROPIC_DEFAULT_MODEL } from "./anthropic-adapter.mjs";

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
class McpClient {
  constructor(name, command, args, env) {
    this.name = name;
    this.proc = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.proc.stdout.on("data", (d) => this.onData(d));
    this.proc.stderr.on("data", (d) => process.stderr.write(`[${this.name}] ${d}`));
  }

  onData(chunk) {
    this.buffer += chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ error: { message: `${this.name}.${method} timed out` } });
        }
      }, 600000);
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async init() {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agent-loop", version: "1" },
    });
    this.notify("notifications/initialized");
    const res = await this.send("tools/list", {});
    this.tools = res.result?.tools || [];
    return this.tools;
  }

  async call(toolName, args) {
    const res = await this.send("tools/call", { name: toolName, arguments: args });
    if (res.error) return `ERROR: ${res.error.message}`;
    const block = res.result?.content?.[0];
    const text = block?.text || "(no output)";
    return res.result?.isError ? `TOOL REPORTED A PROBLEM:\n${text}` : text;
  }

  kill() {
    this.proc.kill();
  }
}

// ---------------------------------------------------------------------------
// Local filesystem tools. The model needs these to actually produce a project;
// MCP servers alone only inspect. Every path is contained to the project dir.
// ---------------------------------------------------------------------------
function containedPath(projectDir, rel) {
  const resolved = path.resolve(projectDir, rel);
  if (resolved !== projectDir && !resolved.startsWith(projectDir + path.sep)) {
    throw new Error(`refuses to touch a path outside the project: ${rel}`);
  }
  return resolved;
}

// Points a project's repository at local-copilot-stack's pre-commit hook when nothing else has
// claimed core.hooksPath. The hook is the only enforcement boundary that survives outside this
// loop — but it only runs where someone remembered to configure it, and nobody configures a repo
// created five minutes ago by an agent. A control that depends on being remembered is the weakest
// link in the chain rather than a layer of it, so the loop sets it up itself.
//
// Never overwrites an existing value: that would silently disable husky, lefthook, or the
// pre-commit framework in a repo that already had its own hooks.
// Paths that are build output, not work. The gate below ignores them when deciding whether the
// tree is dirty, and the baseline .gitignore keeps them out of commits.
//
// This is not tidiness. `git add -A` with no .gitignore committed an 813MB Terraform provider
// binary in an earlier run, because .terraform/ holds the downloaded providers.
const ARTIFACT_PATTERNS = [
  ".terraform/",
  "*.tfstate",
  "*.tfstate.*",
  "__pycache__/",
  "*.pyc",
  "node_modules/",
  ".venv/",
  "agent-run-report.json",
];

function ensureGitignore(projectDir) {
  const file = path.join(projectDir, ".gitignore");
  if (existsSync(file)) return; // the project's own choices win
  try {
    writeFileSync(
      file,
      "# Written by the agent loop because none existed. Build output, not work.\n" +
        ARTIFACT_PATTERNS.join("\n") +
        "\n"
    );
  } catch {
    /* advisory scaffolding; never fail a run over it */
  }
}

function isArtifact(relPath) {
  return (
    relPath === "agent-run-report.json" ||
    relPath.endsWith(".pyc") ||
    /(^|\/)(\.terraform|__pycache__|node_modules|\.venv)(\/|$)/.test(relPath) ||
    /\.tfstate(\.|$)/.test(relPath)
  );
}

function protectRepo(projectDir) {
  const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectDir, encoding: "utf8" });
  if (inRepo.status !== 0) return null;

  const hooksDir = path.join(path.resolve(__dirname, "..", ".."), "local-copilot-stack", "githooks");
  if (!existsSync(path.join(hooksDir, "pre-commit"))) return null;

  const existing = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: projectDir, encoding: "utf8" });
  const current = (existing.stdout || "").trim();
  if (current && current !== hooksDir) {
    console.warn(`[loop] core.hooksPath already set to ${current} — leaving it alone`);
    return current;
  }
  if (current === hooksDir) return current;

  const set = spawnSync("git", ["config", "core.hooksPath", hooksDir], { cwd: projectDir, encoding: "utf8" });
  if (set.status !== 0) return null;
  console.log(`[loop] commit validation enabled for this repo (core.hooksPath -> ${hooksDir})`);
  return hooksDir;
}

// Loads secret-guard's scanner as a library rather than calling its MCP tool. The reason is
// timing, not convenience: this has to run *inside* write_file's handler, which is synchronous,
// and the point of the check is that the bytes never reach disk. Returns null — and writes stay
// unguarded, with a warning — if the sibling repo or the gitleaks binary is absent, because a
// missing optional scanner should not take a run down.
async function loadSecretScanner() {
  const entry =
    process.env.SECRETGUARD_LIB ||
    path.join(path.resolve(__dirname, "..", ".."), "secret-guard-mcp", "lib", "gitleaks.mjs");
  if (!existsSync(entry)) return null;
  try {
    const mod = await import(pathToFileURL(entry).href);
    if (!mod.checkGitleaksInstalled()) {
      console.warn("[loop] secret-guard found but gitleaks is not installed — writes unguarded");
      return null;
    }
    return mod;
  } catch (error) {
    console.warn(`[loop] secret-guard could not be loaded (${error.message}) — writes unguarded`);
    return null;
  }
}

// Files whose contents turn a security check off: gitleaks' allowlist and config, and the
// marker that excuses a Terraform directory from the security scan. Kept as basenames because
// they are meaningful at any depth in a project.
const GUARD_CONFIG_FILES = [".gitleaksignore", ".gitleaks.toml", ".tfguard-fixture"];

function localTools(projectDir, secretScanner) {
  // A rejected commit returns the hook's full report, which is what makes it actionable the first
  // time and a context sink every time after. One run burned its entire window on 13 consecutive
  // rejections of the same failure: the uncommitted-work gate says commit, the hook refuses
  // because validation fails, and the model retries rather than fixing the cause. Repeating a
  // report the model has already read three times adds no information — it just costs the context
  // needed to act on it.
  //
  // Deliberately not a hard refusal: a genuinely fixed commit must always be able to go through,
  // or the uncommitted-work gate becomes unsatisfiable. Only the repetition is suppressed.
  let commitRejectionStreak = 0;
  let lastRejectionOutput = null;
  return {
    write_file: {
      schema: {
        type: "function",
        function: {
          name: "write_file",
          description:
            "Create or overwrite a file in the project. Use this for every source file, config, manifest, and Terraform file you produce.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path relative to the project root, e.g. src/app.js" },
              content: { type: "string", description: "The complete file content" },
            },
            required: ["path", "content"],
          },
        },
      },
      run: ({ path: rel, content }) => {
        const dest = containedPath(projectDir, rel);

        // A guard the model can edit is not a guard. Blocked from committing a credential in a
        // Kubernetes Secret, a real run wrote the finding's fingerprint into .gitleaksignore and
        // the commit went through -- the gate was switched off by the thing it was gating.
        // Deciding a finding is a false positive is a human judgement, so the model does not get
        // to make it. Same reasoning as advisory findings never being allowed to clear a
        // refusal: a layer that can say "allow" undermines the layer that says "deny".
        if (GUARD_CONFIG_FILES.includes(path.basename(rel))) {
          return (
            `REFUSED: ${rel} was NOT written. That file suppresses a security check, and ` +
            `silencing a finding is not fixing it. If the finding is real, fix the code. If you ` +
            `believe it is a false positive, say so in your final message and leave it to a ` +
            `human — you cannot allowlist it yourself.`
          );
        }

        // Refuse before the bytes land. Scanning after the write would still find the secret,
        // but by then it is on disk and one `git add -A` from being in history, where deleting
        // the line no longer fixes anything. This is the earliest point the loop controls.
        if (secretScanner) {
          const scan = secretScanner.scanContent(content ?? "", { pathLabel: rel });
          if (scan.ok && scan.findings.length) {
            const items = scan.findings
              .map((f) => `  - line ${f.startLine}: ${f.rule} (${f.description})`)
              .join("\n");
            return (
              `REFUSED: ${rel} was NOT written — it contains hardcoded credentials:\n${items}\n\n` +
              `${secretScanner.REMEDIATION}\n\n` +
              `Rewrite the file reading these values from environment variables and call ` +
              `write_file again.`
            );
          }
        }

        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, content ?? "");
        return `Wrote ${rel} (${(content ?? "").split("\n").length} lines).`;
      },
    },
    read_file: {
      schema: {
        type: "function",
        function: {
          name: "read_file",
          description: "Read back a file you previously wrote, to review or correct it.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
      run: ({ path: rel }) => {
        const target = containedPath(projectDir, rel);
        if (!existsSync(target)) return `No such file: ${rel}`;
        return readFileSync(target, "utf8").slice(0, 6000);
      },
    },
    // Added after a run shipped code that did not compile: the tool set covered Terraform,
    // dependencies and web search, but the model chose Go and nothing could build Go. Language is
    // detected from the files actually present rather than configured, because which language the
    // model picks is not under the caller's control — three runs of the same prompt produced
    // Node, Python and Go.
    build_check: {
      schema: {
        type: "function",
        function: {
          name: "build_check",
          description:
            "Compile/syntax-check the code you have written. Detects the language automatically. " +
            "Call this after writing source files and fix anything it reports — it catches errors " +
            "that stop the program from running at all.",
          parameters: { type: "object", properties: {} },
        },
      },
      run: () => {
        const results = [];
        const py = [];
        const js = [];
        let hasGo = false;
        const walk = (dir) => {
          if (!existsSync(dir)) return;
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (["node_modules", ".terraform", ".git", ".venv", "__pycache__"].includes(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith(".py")) py.push(full);
            else if (/\.(m|c)?js$/.test(e.name)) js.push(full);
            else if (e.name.endsWith(".go")) hasGo = true;
          }
        };
        walk(projectDir);

        if (py.length) {
          // Two passes: py_compile catches syntax errors; ruff's F rules catch undefined names and
          // bad imports — the Python analogue of a compile error, which syntax checking alone misses.
          const compile = spawnSync("python3", ["-m", "py_compile", ...py], { encoding: "utf8" });
          results.push(
            compile.status === 0
              ? `python syntax: OK (${py.length} files)`
              : `python SYNTAX ERRORS:\n${(compile.stderr || "").slice(0, 1500)}`
          );
          const ruff = spawnSync("ruff", ["check", "--select", "F", "--no-cache", projectDir], { encoding: "utf8" });
          results.push(
            ruff.status === 0
              ? "python static check (ruff F): OK"
              : `python STATIC ERRORS (undefined names, bad imports):\n${(ruff.stdout || ruff.stderr || "").slice(0, 2000)}`
          );
        }

        if (js.length) {
          const bad = js
            .map((f) => ({ f, r: spawnSync("node", ["--check", f], { encoding: "utf8" }) }))
            .filter((x) => x.r.status !== 0);
          results.push(
            bad.length === 0
              ? `javascript syntax: OK (${js.length} files)`
              : `javascript SYNTAX ERRORS:\n${bad.map((x) => `${path.relative(projectDir, x.f)}: ${x.r.stderr}`).join("\n").slice(0, 1500)}`
          );
        }

        if (hasGo) {
          const go = spawnSync(
            "docker",
            ["run", "--rm", "-v", `${projectDir}:/src`, "-w", "/src", "golang:1.22",
             "sh", "-c", "export GOFLAGS=-mod=mod; go mod tidy >/dev/null 2>&1; go build ./..."],
            { encoding: "utf8" }
          );
          results.push(
            go.error
              ? `go: could not run the Go toolchain (${go.error.message})`
              : go.status === 0
                ? "go build: OK"
                : `go BUILD ERRORS:\n${(go.stderr || go.stdout || "").slice(0, 2000)}`
          );
        }

        return results.length ? results.join("\n\n") : "No source files found to check yet.";
      },
    },
    // Committing is how work actually lands, and it is the point at which a repository's
    // pre-commit hook gets to refuse. Without this tool the model writes files that no gate ever
    // sees. Contained to the project directory; it stages and commits nothing outside it.
    git_commit: {
      schema: {
        type: "function",
        function: {
          name: "git_commit",
          description:
            "Stage all changes in the project and commit them. The repository may run validation " +
            "hooks that reject the commit — if that happens, fix what they report and commit again.",
          parameters: {
            type: "object",
            properties: { message: { type: "string", description: "Commit message" } },
            required: ["message"],
          },
        },
      },
      run: ({ message }) => {
        const inRepo = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: projectDir, encoding: "utf8" });
        if (inRepo.status !== 0) return "Not a git repository, nothing to commit.";
        // Re-checked here, not only at startup: this is the moment the hook has to be in place,
        // and the repository may not have existed when the run began.
        protectRepo(projectDir);
        ensureGitignore(projectDir);
        spawnSync("git", ["add", "-A"], { cwd: projectDir, encoding: "utf8" });
        const commit = spawnSync("git", ["commit", "-m", message || "update"], {
          cwd: projectDir,
          encoding: "utf8",
        });
        const output = `${commit.stdout || ""}${commit.stderr || ""}`.slice(0, 2500);
        if (commit.status === 0) {
          commitRejectionStreak = 0;
          lastRejectionOutput = null;
          return `Commit succeeded.\n${output}`;
        }

        commitRejectionStreak++;
        const unchanged = output === lastRejectionOutput;
        lastRejectionOutput = output;

        // Only suppressed when the report is byte-identical: a different failure is new
        // information and always gets shown in full, however many attempts preceded it.
        if (commitRejectionStreak >= 3 && unchanged) {
          return (
            `COMMIT REJECTED — ${commitRejectionStreak} times in a row, with the identical failure ` +
            `each time. The report is unchanged from the one you already have, so it is not repeated ` +
            `here. Retrying cannot help: nothing about the working tree has changed since the last ` +
            `attempt. Fix what the checks reported, then commit.`
          );
        }
        return `COMMIT REJECTED — the repository's checks refused this change. Fix the problems below and commit again.\n${output}`;
      },
    },
    list_files: {
      schema: {
        type: "function",
        function: {
          name: "list_files",
          description: "List every file written to the project so far.",
          parameters: { type: "object", properties: {} },
        },
      },
      run: () => {
        const out = [];
        const walk = (dir, prefix = "") => {
          if (!existsSync(dir)) return;
          for (const e of readdirSync(dir)) {
            if (e === "node_modules" || e === ".terraform" || e === ".git") continue;
            const full = path.join(dir, e);
            const rel = prefix ? `${prefix}/${e}` : e;
            if (statSync(full).isDirectory()) walk(full, rel);
            else out.push(rel);
          }
        };
        walk(projectDir);
        return out.length ? out.join("\n") : "(no files yet)";
      },
    },
  };
}

// ---------------------------------------------------------------------------

const LLAMA_URL = process.env.LOCAL_LLM_URL || "http://localhost:8080";
// Tool results feed straight back into a 32k context window, so an unbounded terraform plan
// dump or file read would eat the budget the model needs for actual work.
const MAX_TOOL_RESULT_CHARS = 2500;
// Identical consecutive writes to the same path. Two could be a hiccup; by the third the model is
// looping, and by the fifth it has proven it will not stop on its own.
const NO_PROGRESS_NUDGE = 3;
const NO_PROGRESS_STOP = 5;

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
      `Write findings to ${answerPath}: one per line starting "- ", or the single word NONE.\n`
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
function requestTimeoutMs(maxTokens) {
  return 30_000 + (maxTokens || 0) * 150;
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
    requestTimeoutMs(maxTokens)
  );
}

// Runs every validator that applies to what is actually on disk, without waiting to be asked.
//
// This is the difference between a checklist and a gate. Measured across four runs of the same
// task with identical tooling, the model called terraform_plan 3, 1, 4 and 0 times, and never
// called check_dependencies or web_search at all. A tool the model may or may not invoke is not a
// guardrail. Note the gate is on validators *passing*, not on tools having been *called* — a model
// can call a validator, receive errors, and finish anyway, which is exactly what happened in one run.
// Loaded from local-copilot-stack so the loop and the git hook cannot disagree about what makes
// a dependency scan authoritative. Absent sibling repo => treat as not authoritative, which is
// the advisory (non-blocking) direction.
// Loaded from terraform-guard so the loop and the tool share one definition of what went
// missing. Absent sibling repo => no findings, the non-blocking direction.
async function pendingResourceRemovals(dir) {
  const entry = path.join(path.resolve(__dirname, "..", ".."), "terraform-guard-mcp", "lib", "resource-census.mjs");
  if (!existsSync(entry)) return [];
  try {
    const { pendingRemovals } = await import(pathToFileURL(entry).href);
    return [...pendingRemovals(dir)];
  } catch {
    return [];
  }
}

async function lockfilePresent(projectDir) {
  const entry = path.join(path.resolve(__dirname, "..", ".."), "local-copilot-stack", "validate", "lockfiles.mjs");
  if (!existsSync(entry)) return false;
  try {
    const { findsLockfile } = await import(pathToFileURL(entry).href);
    return findsLockfile(projectDir);
  } catch {
    return false;
  }
}

async function validateProject(projectDir, toolRegistry) {
  const failures = [];
  // Reported to the reviewer, never blocking. See the resource-census block below.
  const advisories = [];
  const ran = [];

  const buildCheck = toolRegistry.get("build_check");
  if (buildCheck) {
    const result = String(buildCheck.run({}));
    ran.push("build_check");
    if (/ERRORS|SYNTAX ERROR|BUILD ERRORS/.test(result)) failures.push(`build_check:\n${result}`);
  }

  // Any directory holding .tf files is a Terraform root worth validating.
  const tfDirs = [];
  const findTf = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if ([".terraform", "node_modules", ".git", ".venv"].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) findTf(full);
      else if (e.name.endsWith(".tf") && !tfDirs.includes(dir)) tfDirs.push(dir);
    }
  };
  try {
    findTf(projectDir);
  } catch {
    /* nothing to scan */
  }

  const tfPlan = toolRegistry.get("terraform_plan");
  for (const dir of tfDirs) {
    if (!tfPlan) break;
    const rel = path.relative(projectDir, dir) || ".";
    const result = await tfPlan.server.call("terraform_plan", { working_dir: rel });
    ran.push(`terraform_plan(${rel})`);
    // A credentials failure means the security rules could not run — that is an unscanned result,
    // not a passing one, but it is an environment limitation the model cannot fix by editing code.
    // Schema errors and violations are its problem; missing cloud credentials are not.
    const unscannable = /could not authenticate|credential/i.test(result);
    if (/TOOL REPORTED A PROBLEM|Refusing to plan-approve/.test(result) && !unscannable) {
      failures.push(`terraform_plan(${rel}):\n${result.slice(0, 1500)}`);
    } else if (unscannable) {
      // Not the model's problem to fix, so it must not block — but it must not read as a pass
      // either. Every run of this experiment so far reported terraform as validated while not one
      // plan-based security rule had run: there are no AWS credentials on this machine, the plan
      // errored at provider configuration, and this branch swallowed it in silence. Same failure
      // shape the advisor timeout already refuses to have — a check that could not run is not a
      // check that passed.
      advisories.push(
        `terraform_plan(${rel}): the plan could not authenticate to AWS, so NO plan-based ` +
          `security rule ran against this configuration. This is an environment limitation, not ` +
          `a defect in the code — but treat the Terraform here as UNSCANNED, not as clean.`
      );
    }
  }

  const depAudit = toolRegistry.get("check_dependencies");
  // Searched recursively, not just at the root: the model decides the layout, and it has put
  // requirements.txt under app/ before. A root-only check would silently skip the dependency scan
  // for exactly that structure — the tool would appear to be "not needed" rather than missed.
  // osv-scanner itself recurses, so finding a manifest anywhere is enough to justify one scan
  // rooted at the project.
  const manifests = ["package.json", "requirements.txt", "pyproject.toml", "Pipfile", "go.mod", "Cargo.toml", "pom.xml", "build.gradle"];
  const hasManifest = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if ([".terraform", "node_modules", ".git", ".venv", "__pycache__"].includes(e.name)) continue;
      if (e.isDirectory()) {
        if (hasManifest(path.join(dir, e.name))) return true;
      } else if (manifests.includes(e.name)) return true;
    }
    return false;
  };
  let manifestFound = false;
  try {
    manifestFound = hasManifest(projectDir);
  } catch {
    /* unreadable tree; nothing to scan */
  }
  if (depAudit && manifestFound) {
    const result = await depAudit.server.call("check_dependencies", { directory: ".", severity_threshold: "high" });
    ran.push("check_dependencies");
    try {
      const parsed = JSON.parse(result);
      if ((parsed.findings || []).length > 0) {
        // Same rule the git hook applies: without a lockfile, osv-scanner resolves transitive
        // dependencies to minimum-satisfying versions that no real install produces, so the
        // findings are advisory. This gate previously had no such check and failed a run over
        // exactly those phantoms — the same project was advisory at commit time and fatal
        // mid-run, which means one of the two was wrong.
        const authoritative = await lockfilePresent(projectDir);
        const line = `check_dependencies: ${parsed.findings.length} finding(s) at or above high severity`;
        if (authoritative) {
          failures.push(`${line}:\n${result.slice(0, 1200)}`);
        } else {
          console.log(`[gate] ${line} — advisory only (no lockfile)`);
        }
      }
    } catch {
      /* non-JSON output means the scan itself failed; not the model's problem to fix */
    }
  }

  // Deleting the resource that is the whole point of the project is not a judgment call the way
  // dismissing a false-positive CVE is. This was advisory, and a measured run read the warning and
  // deleted an S3 bucket, its versioning and its public-access block anyway, then carried on for
  // twelve more turns. An advisory control the model demonstrably ignores is not a control.
  //
  // Restoring the resource clears it automatically — pendingRemovals drops anything that comes
  // back. There is deliberately no way for the run to dismiss this itself.
  //
  // Reported, never blocking. It was blocking, and that was wrong: the census compares resource
  // ADDRESSES, so a rename is indistinguishable from a deletion. A real run was told (correctly)
  // that EKS needs subnets in two AZs and that one overloaded IAM role had to be split; it did
  // both, `aws_subnet.public` became `public_a`/`public_b`, and the gate then failed the run for
  // three "regressions" that were the requested fix. The model spent four validation rounds
  // trying to restore resources that were correctly gone — the exact thrashing this check exists
  // to prevent, caused by the check. terraform-guard, which owns the census, has always
  // documented it as advisory; only this gate disagreed.
  //
  // Advisory here does not mean discarded. The findings go to the reviewer via the advisory
  // request, which is the layer that can tell a rename from a regression.
  for (const dir of tfDirs) {
    const pending = await pendingResourceRemovals(dir);
    if (pending.length) {
      const rel = path.relative(projectDir, dir) || ".";
      advisories.push(
        `resource census (${rel}): these resources were declared earlier in this run and are now ` +
          `gone: ${pending.join(", ")}. Renaming a resource looks identical to deleting one here, ` +
          `so this is a question, not a verdict — check whether each was replaced or simply lost.`
      );
      ran.push(`resource_census(${rel})`);
    }
  }

  // Work that was never committed was never seen by the pre-commit hook, and the hook is the
  // boundary that runs the full check set. Three separate runs ended "validation PASSED" with the
  // real deliverable sitting uncommitted in the working tree — the loop's own gate is a subset of
  // what the hook runs, so passing it proves less than it appears to.
  //
  // Artifacts are excluded, or this would be unsatisfiable for any project that has run
  // `terraform init`.
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf8" });
  if (status.status === 0) {
    const dirty = status.stdout
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter((f) => f && !isArtifact(f));
    if (dirty.length) {
      ran.push("uncommitted_work");
      failures.push(
        `uncommitted work: ${dirty.length} file(s) are not committed — ${dirty.slice(0, 8).join(", ")}` +
          `${dirty.length > 8 ? `, +${dirty.length - 8} more` : ""}.\nCommit them with git_commit. ` +
          `The repository's checks run on commit, so until then nothing has actually validated ` +
          `this work. If the commit is rejected, fix what it reports and commit again.`
      );
    }
  }

  // Belt and braces behind the write_file interception. That check covers everything the model
  // writes; this covers everything else in the tree — files the project directory was seeded with
  // before the run, and anything a tool wrote as a side effect.
  const secretScan = toolRegistry.get("scan_path");
  if (secretScan) {
    const result = await secretScan.server.call("scan_path", { target: "." });
    ran.push("scan_path");
    try {
      const parsed = JSON.parse(result);
      if (!parsed.clean) {
        failures.push(
          `scan_path: ${parsed.summary.total} hardcoded credential(s):\n${result.slice(0, 1200)}`
        );
      }
    } catch {
      /* non-JSON output means the scan itself failed; not the model's problem to fix */
    }
  }

  return { ran, failures, advisories };
}

async function main() {
  const opts = parseArgs();
  mkdirSync(opts.project, { recursive: true });

  // Server paths resolve relative to this repo rather than a hardcoded $HOME/LLM, so a checkout
  // anywhere works as long as the sibling repos sit alongside it. Override individually with the
  // TFGUARD_SERVER / DEPAUDIT_SERVER / WEBSEARCH_SERVER env vars; a server whose file is missing
  // is skipped with a warning instead of taking the whole run down.
  const siblings = path.resolve(__dirname, "..", "..");
  const candidates = [
    {
      name: "terraform-guard",
      // The interesting one: it can refuse, and its refusals come back as structured violations
      // the model can parse and act on.
      entry: process.env.TFGUARD_SERVER || path.join(siblings, "terraform-guard-mcp", "index.mjs"),
      env: { TF_WORKING_ROOT: opts.project },
    },
    {
      name: "dep-audit",
      entry: process.env.DEPAUDIT_SERVER || path.join(siblings, "dep-audit-mcp", "index.mjs"),
      env: { SCAN_ROOT: opts.project },
    },
    {
      name: "identity-guard",
      entry: process.env.IDENTITYGUARD_SERVER || path.join(siblings, "identity-guard-mcp", "index.mjs"),
      env: { SCAN_ROOT: opts.project },
    },
    {
      // Registered so the model can sweep the whole tree on demand. Note this is the *weaker*
      // half of the secret protection: the half that actually holds is the write_file
      // interception above, which does not depend on the model choosing to call anything.
      name: "secret-guard",
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
      entry:
        process.env.WEBSEARCH_SERVER ||
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
      console.error(`[loop] skipping ${c.name}: no server at ${c.entry}`);
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
  let lastWrite = { path: null, content: null, repeats: 0 };
  let noProgressNudged = false;
  let noProgressStopped = null;
  const regressionWarnings = [];

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    let response;
    try {
      response = await chat(opts.model, messages, toolSchemas, opts.maxTokens, opts.provider);
    } catch (error) {
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
        const { ran, failures, advisories } = await validateProject(opts.project, toolRegistry);
        validationRounds++;
        console.log(
          `[gate] validation round ${validationRounds}: ran ${ran.join(", ") || "nothing"} — ` +
            `${failures.length} failing`
        );
        finalValidation = { ran, failures, advisories };
        for (const a of advisories) console.log(`[gate] advisory (not blocking): ${a}`);

        // Run once, on the first time the model tries to stop — that is the moment the whole
        // deliverable exists and the model is still in a position to act on what comes back.
        if (opts.advisorFile && advisoryFindings === null) {
          const advice = await runExternalAdvisor(opts.project, taskText, opts.advisorFile, advisories);
          advisoryFindings = advice.findings;
          advisoryInconclusive = !!advice.inconclusive;
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
        messages.push({
          role: "user",
          content:
            (advisoryDelivered ? "" : ((advisoryDelivered = true), advisoryText)) +
            `Validation failed. You are not finished. Fix these and do not remove working code ` +
            `to make them pass:\n\n${failures.join("\n\n")}`,
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

      // No-progress detection. The gate asks whether the validators pass; nothing asked whether
      // the model was still moving. A real run wrote app/database.py 39 times across turns 41-70,
      // mostly byte-identical, and burned its entire turn budget without changing anything —
      // rewriting a file with the same bytes is definitionally not progress.
      //
      // Nudge first, then stop. A model that has genuinely lost the thread will not be rescued by
      // a fourth attempt, but one that is merely repeating itself sometimes recovers when told.
      if (name === "write_file" && args.path) {
        if (args.path === lastWrite.path && (args.content ?? "") === lastWrite.content) {
          lastWrite.repeats++;
        } else {
          lastWrite = { path: args.path, content: args.content ?? "", repeats: 1 };
        }
        if (lastWrite.repeats === NO_PROGRESS_NUDGE) {
          console.log(`[loop] ${args.path} written ${lastWrite.repeats}x with identical content — nudging`);
          noProgressNudged = true;
        } else if (lastWrite.repeats >= NO_PROGRESS_STOP) {
          console.log(
            `[loop] stopping: ${args.path} written ${lastWrite.repeats} times with identical ` +
              `content — the run is not making progress.`
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
      noProgressNudged = false;
      messages.push({
        role: "user",
        content:
          `You have now written ${lastWrite.path} several times with exactly the same content, ` +
          `so nothing has changed. Whatever you are trying to fix, this is not fixing it. Read ` +
          `the file, do something different, or say DONE and explain what is unresolved.`,
      });
    }
  }

  // Always re-validate against the files as they finally stand, rather than reusing the last
  // gate result. The loop can exit on max-turns after the model has already fixed what the gate
  // complained about, and reporting the stale verdict would claim a failure that no longer exists
  // — the same class of dishonest signal this gate exists to remove.
  finalValidation = await validateProject(opts.project, toolRegistry);
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
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
