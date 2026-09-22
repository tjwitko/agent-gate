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
export class McpClient {
  constructor(name, command, args, env, cwd) {
    this.name = name;
    // cwd matters: each control server resolves its scan root from an env var *or its startup cwd*,
    // and tools are called with relative targets. Left undefined it inherits ours, which is only
    // correct by accident.
    this.proc = spawn(command, args, { env: { ...process.env, ...env }, cwd, stdio: ["pipe", "pipe", "pipe"] });
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
/**
 * The directory holding the pre-commit hook, or null. Exported so the not-found branch is testable
 * without deleting a checkout other work depends on -- that branch is the one that was wrong.
 */
export function resolveHooksDir(fromDir = __dirname, { env = process.env } = {}) {
  const dir =
    env.AGENT_GATE_HOOKS_PATH ||
    path.join(path.resolve(fromDir, "..", ".."), "local-copilot-stack", "githooks");
  return existsSync(path.join(dir, "pre-commit")) ? dir : null;
}

/**
 * Where secret-guard's scanner library is, or null. Installed package first, then SECRETGUARD_LIB,
 * then a sibling checkout. Exported for the same reason as resolveHooksDir.
 */
export function resolveSecretScannerEntry(fromDir = __dirname, { resolver, env = process.env } = {}) {
  if (env.SECRETGUARD_LIB) return existsSync(env.SECRETGUARD_LIB) ? env.SECRETGUARD_LIB : null;
  const require = resolver || createRequire(import.meta.url);
  for (const spec of ["@tjwitko/secret-guard-mcp/lib/gitleaks.mjs", "secret-guard-mcp/lib/gitleaks.mjs"]) {
    try {
      return require.resolve(spec);
    } catch {
      /* not installed under that specifier */
    }
  }
  const sibling = path.join(path.resolve(fromDir, "..", ".."), "secret-guard-mcp", "lib", "gitleaks.mjs");
  return existsSync(sibling) ? sibling : null;
}

function protectRepo(projectDir) {
  const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectDir, encoding: "utf8" });
  if (inRepo.status !== 0) return null;

  // The hook belongs to local-copilot-stack, which is not a dependency of this package and cannot
  // be, so a sibling checkout is a legitimate way to find it -- unlike the census and the lockfile
  // list, which had installable homes. What was not legitimate was returning null in silence: the
  // hook is the only enforcement boundary that survives outside this loop, the loop's own gate is
  // a SUBSET of what it runs, and on any machine without that checkout commits were landing
  // unvalidated with nothing anywhere saying so. AGENT_GATE_HOOKS_PATH names it elsewhere.
  const hooksDir = resolveHooksDir();
  if (!hooksDir) {
    console.warn(
      `[loop] NO COMMIT HOOK: no pre-commit hook at ${hooksDir}, so commits in this project are ` +
        `NOT validated by the full check set. This loop's own gate is a subset of it — the ` +
        `workload-identity scan and terraform-guard's source scan run only at commit time. Set ` +
        `AGENT_GATE_HOOKS_PATH to a directory holding a pre-commit hook, or check out ` +
        `local-copilot-stack beside this repository.`
    );
    return null;
  }

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
  // secret-guard is a declared dependency now, so the installed package is the normal answer and
  // the sibling checkout is the development one. It used to be the sibling alone: absent, this
  // returned null and every write went unscanned, on every machine but one.
  const entry = resolveSecretScannerEntry();
  if (!entry) {
    // Not fatal: the gate still runs scan_path across the whole tree afterwards, so this is the
    // inner of two layers. It is said out loud anyway, because the layer that is missing is the
    // one that stops a credential reaching disk at all -- and a secret caught only by the later
    // scan is already in the working tree and may already be committed.
    console.warn(
      "[loop] WRITES UNGUARDED: secret-guard's scanner could not be resolved from node_modules, " +
        "SECRETGUARD_LIB or a sibling checkout, so file writes are NOT scanned for credentials " +
        "before they reach disk. The whole-tree scan still runs at validation time."
    );
    return null;
  }
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
// .identity-exception was missing from this list for one release and a run found the gap: blocked
// from committing, the model wrote one and the commit went through. It is the same shape as
// .tfguard-fixture -- identity-guard's own scan.mjs says so in a comment -- and the two must be
// added and renamed together. identity-guard/test/scan.test.mjs pins the basename for that reason.
const GUARD_CONFIG_FILES = [
  ".gitleaksignore",
  ".gitleaks.toml",
  ".tfguard-fixture",
  ".identity-exception",
];

// The marker build_check uses to say a checker did not run, and the only thing that reads it.
// Emitter and detector share this constant rather than agreeing on a spelling, because the whole
// class of defect it exists to fix was a check whose outcome was inferred from the wording of a
// message. "Could not run" is neither a finding nor a pass: a blocking gate that fabricates
// defects from a missing binary destroys correct work, and one that reads an unavailable
// toolchain as success is the silent pass this control set exists to remove. Both were live here
// at the same time -- an absent `ruff` produced blocking "STATIC ERRORS" against code it never
// read, while an absent Go toolchain produced a sentence matching no blocking pattern, so it
// passed. It routes to the same exit-3 path as an unreachable MCP control.
export const UNAVAILABLE = "COULD NOT RUN";

/** The `COULD NOT RUN` lines in a build_check result, if any. */
export function unavailableCheckers(buildCheckOutput) {
  return String(buildCheckOutput)
    .split("\n")
    .filter((line) => line.startsWith(`${UNAVAILABLE}:`))
    .map((line) => line.slice(`${UNAVAILABLE}:`.length).trim());
}

export function localTools(projectDir, secretScanner) {
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
    // Added because its absence was causing real damage. The tool set could create and overwrite
    // files but never remove one, so a model that needed a file gone had exactly one move:
    // overwrite it with something inert. Two runs did precisely that — one wrote all five of its
    // Kubernetes manifests back as empty files, which silenced three checks at once and looked
    // like progress; another left `removed_provider.tf` containing nothing but a comment saying
    // the content had moved. Both were read at the time as the model mishandling its work. It was
    // the tool set offering no way to do the thing it needed.
    //
    // The artifact-presence check then told it to "delete the file rather than leaving an empty
    // one behind" — advice it could not act on. A remediation that asks for an impossible action
    // is the same defect as one that names a setting without naming its block, and it cost a run
    // when that happened.
    //
    // Safe to add now, and not before: the artifact census added alongside it compares files this
    // run produced against what they hold now, so a deletion that loses work is caught and blocks.
    // The capability arrives with the guardrail rather than ahead of it.
    delete_file: {
      schema: {
        type: "function",
        function: {
          name: "delete_file",
          description:
            "Remove a file from the project. Use this when a file should no longer exist — do NOT " +
            "overwrite it with empty or placeholder content, which leaves a broken artifact behind " +
            "and hides the fact that it is gone.",
          parameters: {
            type: "object",
            properties: { path: { type: "string", description: "Path relative to the project root" } },
            required: ["path"],
          },
        },
      },
      run: ({ path: rel }) => {
        const target = containedPath(projectDir, rel);
        if (!existsSync(target)) return `No such file: ${rel} — nothing to delete.`;
        // A guard the model can remove is not a guard, for the same reason it may not write one.
        if (GUARD_CONFIG_FILES.includes(path.basename(rel))) {
          return (
            `REFUSED: ${rel} was NOT deleted. That file governs a security check, and removing it ` +
            `is not fixing a finding.`
          );
        }
        // Deleting the repository, its history or its ignore rules is never the fix for anything
        // this loop asks for.
        const first = rel.split(/[\\/]/)[0];
        if (first === ".git" || path.basename(rel) === ".gitignore") {
          return `REFUSED: ${rel} was NOT deleted. That is repository infrastructure, not project work.`;
        }
        try {
          if (statSync(target).isDirectory()) {
            return `REFUSED: ${rel} is a directory. Delete the files inside it individually.`;
          }
          unlinkSync(target);
          return `Deleted ${rel}.`;
        } catch (err) {
          return `Could not delete ${rel}: ${err.message}`;
        }
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
          if (compile.error || compile.status === null) {
            results.push(`${UNAVAILABLE}: python3 is not installed or not on PATH, so ${py.length} Python file(s) were not syntax-checked.`);
          } else {
            results.push(
              compile.status === 0
                ? `python syntax: OK (${py.length} files)`
                : `python SYNTAX ERRORS:\n${(compile.stderr || "").slice(0, 1500)}`
            );
          }

          // ruff exits 1 for findings and 2 for its own errors, so the two are distinguished by
          // exit status rather than by reading the message. Before this, a machine without ruff
          // produced `status: null`, which is not 0, and the gate reported an empty list of
          // "STATIC ERRORS" as a blocking finding against code it had never looked at.
          const ruff = spawnSync("ruff", ["check", "--select", "F", "--no-cache", projectDir], { encoding: "utf8" });
          if (ruff.error || ruff.status === null) {
            results.push(`${UNAVAILABLE}: ruff is not installed or not on PATH, so the Python static check did not run.`);
          } else if (ruff.status > 1) {
            results.push(`${UNAVAILABLE}: ruff exited ${ruff.status} without checking the code — ${(ruff.stderr || "").slice(0, 400).trim() || "no detail"}`);
          } else {
            results.push(
              ruff.status === 0
                ? "python static check (ruff F): OK"
                : `python STATIC ERRORS (undefined names, bad imports):\n${(ruff.stdout || ruff.stderr || "").slice(0, 2000)}`
            );
          }
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
          // Pulled as its own step, for two reasons. `docker run` streams the pull transcript to
          // stderr, and reporting stderr verbatim on failure buried the real error under a screen
          // of layer-download lines. And it separates "the image could not be obtained" -- no
          // docker binary, no daemon, no network -- from "the code does not build", which the
          // combined command could only express as the latter.
          const image = "golang:1.22";
          const pull = spawnSync("docker", ["pull", "-q", image], { encoding: "utf8" });
          if (pull.error || pull.status === null) {
            results.push(`${UNAVAILABLE}: docker is not installed or not on PATH, so the Go build did not run.`);
          } else if (pull.status !== 0) {
            results.push(`${UNAVAILABLE}: could not obtain ${image}, so the Go build did not run — ${(pull.stderr || "").slice(0, 400).trim() || "no detail"}`);
          } else {
            // -buildvcs=false because this is a build check, not a release. With stamping on, a
            // bind-mounted repository owned by a different uid than the container user makes git
            // refuse the directory, and `go build` fails with "error obtaining VCS status" before
            // it compiles anything -- reported, until this change, as the project's build errors.
            const go = spawnSync(
              "docker",
              ["run", "--rm", "-v", `${projectDir}:/src`, "-w", "/src", image,
               "sh", "-c", "export GOFLAGS=-mod=mod; go mod tidy >/dev/null 2>&1; go build -buildvcs=false ./..."],
              { encoding: "utf8" }
            );
            if (go.error || go.status === null) {
              results.push(`${UNAVAILABLE}: the Go toolchain could not be started (${go.error ? go.error.message : "no exit status"}).`);
            } else {
              results.push(
                go.status === 0
                  ? "go build: OK"
                  : `go BUILD ERRORS:\n${(go.stderr || go.stdout || "").slice(0, 2000)}`
              );
            }
          }
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
// Loaded from local-copilot-stack so the loop and the git hook cannot disagree about what makes
// a dependency scan authoritative. Absent sibling repo => treat as not authoritative, which is
// the advisory (non-blocking) direction.
// Loaded from terraform-guard so the loop and the tool share one definition of what went
// missing. Absent sibling repo => no findings, the non-blocking direction.
// Checkov, advisory only. It earns its place for one reason: it parses HCL directly, so it runs
// on configurations that cannot produce a plan — which was six out of six generated deliverables.
// Every plan-based check (this project's rule engine, and OPA/Conftest equally) had nothing to
// evaluate on any of them.
//
// Three things it does that would mislead an agent if passed through raw:
//
//  1. Without --download-external-modules it silently skips files whose modules it cannot resolve.
//  2. WITH that flag it reports findings inside the downloaded modules — 9 of 11 on one real
//     config. Those are not the caller's to fix, and this project has already watched a model
//     rewrite its own working files ten times chasing errors that lived in vendored code.
//  3. A file that fails to parse is skipped, and unless parsing_errors is read back the result of
//     a broken config is few findings, which reads as a clean one.
//
// So: the flag is on, vendored findings are dropped (and counted, never silently), coverage is
// reported against the .tf files actually present, and parsing errors are named.
const CHECKOV_TIMEOUT_MS = 180_000;
const VENDORED_PATH_RE = /external_modules|\.terraform/;

// --quiet is deliberately NOT passed. It suppresses passed_checks, skipped_checks and
// parsing_errors from the JSON, leaving only failures — which made the coverage figure below
// structurally incapable of exceeding the number of files that had findings. A clean
// configuration reported "evaluated 0 of 13 .tf files", i.e. it read as unscanned when it had in
// fact been scanned completely. Coverage derived from a field the flag removes is not coverage.
function checkovAdvisory(dir, projectDir) {
  const probe = spawnSync("checkov", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) return null; // not installed — absence is the non-blocking direction

  // Counted recursively, because `checkov -d` scans recursively. Counting only this directory's own
  // .tf files while reading checkov's evaluated set -- which includes the child modules it walked
  // into -- produced "covering 5 of 2 .tf file(s)". A ratio above one is nonsense, and it discredits
  // the sentence it appears in.
  const countTf = (d, acc = []) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return acc;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name) || VENDORED_PATH_RE.test(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) countTf(full, acc);
      else if (e.name.endsWith(".tf")) acc.push(path.relative(dir, full));
    }
    return acc;
  };
  const present = countTf(dir);
  if (present.length === 0) return null;

  const rel = path.relative(projectDir, dir) || ".";
  const run = spawnSync(
    "checkov",
    ["-d", dir, "--framework", "terraform", "--download-external-modules", "true",
     "--compact", "-o", "json"],
    { encoding: "utf8", timeout: CHECKOV_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }
  );

  // A tool that could not run must say so. Returning null here would drop checkov out of the run
  // summary entirely, which is indistinguishable from it having been clean.
  if (run.error || run.signal) {
    return `checkov (${rel}): did NOT run to completion (${run.signal ? `killed by ${run.signal}, likely the ${CHECKOV_TIMEOUT_MS / 1000}s timeout` : run.error.message}). Nothing here was scanned by checkov — this is unknown, not clean.`;
  }
  if (!run.stdout) {
    return `checkov (${rel}): produced no output (exit ${run.status}). ${(run.stderr || "").trim().slice(0, 300) || "No stderr."} Nothing here was scanned by checkov — this is unknown, not clean.`;
  }

  let report;
  try {
    const parsed = JSON.parse(run.stdout);
    report = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return `checkov (${rel}): output could not be parsed as JSON, so its findings are unavailable. This is unknown, not clean.`;
  }

  const failed = report?.results?.failed_checks || [];
  const passed = report?.results?.passed_checks || [];
  const skipped = report?.results?.skipped_checks || [];
  const own = failed.filter((c) => !VENDORED_PATH_RE.test(c.file_path || ""));
  const vendored = failed.length - own.length;

  // Which of the caller's own .tf files checkov actually looked at. A file with no resources, or
  // only resource types checkov ships no policy for, legitimately appears in none of the three
  // lists — so this remains a floor. The difference from before is that it is now computed from
  // every list checkov populates rather than from failures alone.
  const evaluated = new Set(
    [...own, ...passed, ...skipped]
      .map((c) => (c.file_path || "").replace(/^\//, ""))
      .filter((p) => p && !VENDORED_PATH_RE.test(p))
  );

  // The direct signal, rather than inferring unscanned files from silence.
  const parseErrors = report?.results?.parsing_errors || [];
  const parseErrorCount = Number(report?.summary?.parsing_errors ?? parseErrors.length) || 0;
  const parseNote = parseErrorCount
    ? ` ${parseErrorCount} file(s) FAILED TO PARSE and were skipped${parseErrors.length ? `: ${parseErrors.slice(0, 5).join(", ")}` : ""} — whatever is in them is unscanned.`
    : " No files failed to parse.";

  const checksRun = passed.length + failed.length;
  const resources = report?.summary?.resource_count ?? "unknown";

  const lines = own.slice(0, 12).map((c) => `    ${c.check_id} ${c.resource} — ${c.check_name}`);
  const more = own.length > 12 ? `\n    (+${own.length - 12} more)` : "";

  return (
    `checkov (${rel}): ${own.length} finding(s) in your own configuration — advisory, not blocking. ` +
    `${vendored ? `${vendored} further finding(s) inside downloaded modules were suppressed: they are ` +
      `not yours to fix and rewriting your files will not clear them. ` : ""}` +
    `${checksRun} check(s) ran against ${resources} resource(s), covering ${evaluated.size} of ` +
    `${present.length} .tf file(s) here; a file declaring no resources checkov has a policy for is ` +
    `not a gap.${parseNote}` +
    (lines.length ? `\n${lines.join("\n")}${more}` : "")
  );
}

/**
 * The census belongs to terraform-guard, so the loop and the tool share one definition of what
 * went missing rather than two that can disagree.
 *
 * Resolved the way the controls themselves are resolved -- an installed package first, the sibling
 * checkout second -- because it used to be the sibling path alone, and returned an empty list when
 * that directory was not there. Empty means "nothing went missing", so on every machine without
 * that checkout the census reported a clean result it had never computed. Same defect as
 * lockfilePresent, one severity lower only because this check is advisory.
 *
 * Returns { removals, unavailable }. `unavailable` is a string when the census could not run at
 * all, and that is reported rather than being rendered as an empty census.
 */
/**
 * Where the census module is, or null. Separated and exported so the not-found branch can be
 * tested: it is the branch that was wrong, and reproducing it in place would mean deleting a
 * sibling checkout that other work in this tree depends on.
 */
export function resolveCensusEntry(fromDir = __dirname, { resolver } = {}) {
  const require = resolver || createRequire(import.meta.url);
  for (const spec of [
    "@tjwitko/terraform-guard-mcp/lib/resource-census.mjs",
    "terraform-guard-mcp/lib/resource-census.mjs",
  ]) {
    try {
      return require.resolve(spec);
    } catch {
      /* not installed under that specifier */
    }
  }
  const sibling = path.join(path.resolve(fromDir, "..", ".."), "terraform-guard-mcp", "lib", "resource-census.mjs");
  return existsSync(sibling) ? sibling : null;
}

async function pendingResourceRemovals(dir) {
  const entry = resolveCensusEntry();
  if (!entry) {
    return { removals: [], unavailable: "terraform-guard's resource census could not be resolved from node_modules or a sibling checkout" };
  }
  try {
    const { pendingRemovals } = await import(pathToFileURL(entry).href);
    return { removals: [...pendingRemovals(dir)] };
  } catch (err) {
    return { removals: [], unavailable: `terraform-guard's resource census could not be loaded — ${err && err.message}` };
  }
}

function lockfilePresent(projectDir) {
  return findsLockfile(projectDir);
}

// Carried across validation rounds within a single run. Module-level rather than threaded through
// the signature because one run is one process, and the comparison is only meaningful inside a run:
// across runs a missing file means a different project, not a regression.
let previousInventory = null;


/**
 * Every directory under `projectDir` that is a Terraform ROOT: it holds .tf files and is not
 * referenced as a child module by another directory.
 *
 * A child module is not a root. A deliverable that split its infrastructure into
 * terraform/modules/{vpc,rds,eks,security_groups} -- the first here to modularise, and the right way
 * to write it -- drew FOUR blocking findings, one per module, every one of them
 * "provider-authentication". Of course: only the root declares `provider "aws"`, and planning a
 * child module standalone is meaningless. The gate was penalising the better practice, and only
 * because every earlier deliverable had been one flat directory.
 *
 * Read from the `source` attribute rather than guessed from the path, so `modules/` in a name proves
 * nothing either way and a genuine root that happens to live under one is still planned.
 */
export function terraformRoots(projectDir) {
  const dirs = [];
  const findTf = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // `.external_modules` holds Checkov's downloaded modules and lives INSIDE the project. Without
      // it here, a run with one vendored EKS module presented 2,499 Terraform roots, 2,490 of them
      // third-party, and the gate ran init+validate+plan against every one -- hours of work, and a
      // failure list so long the next request was 143,066 tokens against a 65,536 context, which
      // ended the run outright.
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      // A directory declared a fixture is not a Terraform root of this project. terraform-guard's
      // own `fixtures/aws-insecure` is insecure on purpose -- it is what proves the scanner works --
      // and planning it produced the finding it was written to produce. See fixture-markers.mjs.
      if (e.isDirectory()) {
        if (!isDeclaredFixture(full)) findTf(full);
      } else if (e.name.endsWith(".tf") && !dirs.includes(dir)) dirs.push(dir);
    }
  };
  findTf(projectDir);

  const childModules = new Set();
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".tf"))) {
      let text = "";
      try {
        text = readFileSync(path.join(dir, f), "utf8");
      } catch {
        continue;
      }
      for (const m of text.matchAll(/\bsource\s*=\s*"(\.\.?\/[^"]*)"/g)) {
        childModules.add(path.resolve(dir, m[1]));
      }
    }
  }
  return dirs.filter((d) => !childModules.has(path.resolve(d)));
}

export async function validateProject(projectDir, toolRegistry, taskText = "") {
  // Every check runs behind this. A Helm chart made one check throw on a shape it assumed, the
  // exception escaped checkManifestContract, and validateProject aborted — so ZERO of the fourteen
  // validators ran and the gate reported nothing at all. Fourteen checks in sequence with no
  // isolation is one point of failure, not fourteen.
  //
  // A crashed check is reported, never skipped quietly, and never treated as a pass: it appears in
  // `ran` as CRASHED so the run summary cannot be mistaken for a clean sweep. It is an advisory
  // rather than a failure on purpose — the defect is in this repository, not in the deliverable, and
  // blocking a run over a harness bug would make the model thrash on something it cannot fix, which
  // is the most expensive mistake this project knows how to make.
  const guarded = (name, fn) => {
    try {
      const out = fn();
      ran.push(name);
      // A check that ran but could not measure anything reports that upward rather than leaving an
      // advisory to be totalled up by a reader who will not total it up.
      for (const why of out?.couldNotRun ?? []) couldNotRun.push(`${name}: ${why}`);
      return { failures: out?.failures ?? [], advisories: out?.advisories ?? [] };
    } catch (err) {
      ran.push(`${name}(CRASHED)`);
      // The advisory below already says "do not read its silence as a pass" -- and then the exit
      // code read it as a pass anyway, because nothing carried it. A crashed check covers whatever
      // it covers exactly as little as a control that never started.
      couldNotRun.push(`${name}: the check itself crashed and did not run — ${err && err.message}`);
      return {
        failures: [],
        advisories: [
          `${name}: the check itself crashed and did not run — ${err && err.message}. This is a ` +
            `defect in the checking tool, not in the project, so nothing here is a finding about ` +
            `your code — but it also means this project is UNVERIFIED for whatever ${name} covers. ` +
            `Do not read its silence as a pass.`,
        ],
      };
    }
  };

  const failures = [];
  // Reported to the reviewer, never blocking. See the resource-census block below.
  const advisories = [];
  const ran = [];
  // Checkers that could not run at all. Neither findings nor passes: they make the run incomplete,
  // the same as an MCP control that could not be reached.
  const couldNotRun = [];
  // Tools with nothing in scope: reported so the reader can see they were considered, but not
  // counted as checks that could not run.
  const inapplicable = [];

  const buildCheck = toolRegistry.get("build_check");
  if (buildCheck) {
    const result = String(buildCheck.run({}));
    ran.push("build_check");
    // Checkers that did not run are pulled out FIRST, so the blocking test never sees them. They
    // make the run incomplete instead: the code was not checked, which is not the same as the code
    // being fine, and not the same as the code being broken.
    for (const why of unavailableCheckers(result)) couldNotRun.push(`build_check: ${why}`);
    const judged = result
      .split("\n")
      .filter((line) => !line.startsWith(`${UNAVAILABLE}:`))
      .join("\n");
    if (/ERRORS|SYNTAX ERROR|BUILD ERRORS/.test(judged)) failures.push(`build_check:\n${judged}`);
  }

  // Every Terraform ROOT under the project. Child modules are excluded: see terraformRoots.
  const tfDirs = terraformRoots(projectDir);
  // A tool that had nothing to examine is not a tool that failed to run. Without this, a project
  // with no Terraform -- which is most projects -- reported terraform_plan as a control that
  // connected and was never called, and the whole run came back INCOMPLETE. That is a false
  // could-not-run, and a gate that says INCOMPLETE on every ordinary project gets switched off,
  // which costs more than the silent pass the check exists to catch.
  if (!tfDirs.length) inapplicable.push({ tool: "terraform_plan", why: "no Terraform configuration was found" });

  const tfPlan = toolRegistry.get("terraform_plan");
  for (const dir of tfDirs) {
    if (!tfPlan) break;
    const rel = path.relative(projectDir, dir) || ".";
    const result = await tfPlan.server.call("terraform_plan", { working_dir: rel });
    ran.push(`terraform_plan(${rel})`);
    // A credentials failure means the plan-based rules could not run — an unscanned result, not a
    // passing one, but an environment limitation the model cannot fix by editing code. Schema
    // errors and violations are its problem; missing cloud credentials are not.
    //
    // This used to be decided by `/could not authenticate|credential/i` over the whole response,
    // which is wrong in both directions and was wrong in practice. Every credential finding
    // contains the word "credential", so a real hardcoded secret found by the credential-free
    // source scan was classified as an authentication failure and demoted to advisory — a run
    // shipped `db_password = "dummypassword"` in a .tfvars file and reported validation PASSED.
    // terraform_plan now reports `planScanned` and `violations` as structured fields; read those.
    let parsed = null;
    try {
      parsed = JSON.parse(result);
    } catch {
      /* older/plain-text responses fall back to the prose check below */
    }
    const planScanned = parsed ? parsed.planScanned !== false : !/could not authenticate/i.test(result);
    // Findings are the model's problem whether or not the plan itself ran. The source scan needs no
    // credentials, so this is exactly the path where its findings are the only signal there is.
    const findings = parsed?.violations || [];
    if (findings.length > 0) {
      failures.push(
        `terraform_plan(${rel}):\n${(parsed.message || result).slice(0, 1500)}`
      );
    } else if (!planScanned && parsed?.unscannableReason !== "provider-authentication") {
      // Scanned nothing, but not because of credentials — a validate or schema error, which is the
      // model's to fix. This has to sit ahead of the advisory branch: both look like "the plan did
      // not run", and only authentication is outside the model's control. The old prose check got
      // this wrong too, matching the word "credential" anywhere in the response.
      failures.push(`terraform_plan(${rel}):\n${(parsed?.message || result).slice(0, 1500)}`);
    } else if (!planScanned) {
      // Not the model's problem to fix, so it must not block — but it must not read as a pass
      // either. Every run of this experiment so far reported terraform as validated while not one
      // plan-based security rule had run: there are no AWS credentials on this machine, the plan
      // errored at provider configuration, and this branch swallowed it in silence. Same failure
      // shape the advisor timeout already refuses to have — a check that could not run is not a
      // check that passed.
      advisories.push(
        `terraform_plan(${rel}): the plan could not authenticate to the cloud provider, so NO ` +
          `plan-based security rule ran against this ` +
          `configuration. The credential-free source scan did run and found nothing. This is an ` +
          `environment limitation, not a defect in the code — but treat the Terraform here as ` +
          `UNSCANNED, not as clean.`
      );
    } else if (/TOOL REPORTED A PROBLEM|Refusing to plan-approve/.test(result)) {
      // Scanned, no findings, but still refused: a schema or validate error. The model's to fix.
      failures.push(`terraform_plan(${rel}):\n${result.slice(0, 1500)}`);
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
  if (!manifestFound) {
    inapplicable.push({ tool: "check_dependencies", why: "no dependency manifest was found" });
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
        const authoritative = lockfilePresent(projectDir);
        const line = `check_dependencies: ${parsed.findings.length} finding(s) at or above high severity`;
        if (authoritative) {
          failures.push(`${line}:\n${result.slice(0, 1200)}`);
        } else {
          // An advisory, not a console.log. This decides whether a security control blocks, and it
          // was announced on a stream no report reads and no exit code reflects -- so a project
          // with high-severity vulnerabilities and no lockfile produced a clean verdict with
          // nothing anywhere saying why.
          advisories.push(`${line} — NOT BLOCKING: ${NOT_AUTHORITATIVE_NOTE}`);
        }
      }
    } catch {
      // Not the model's problem to fix, and not a pass either. Swallowed entirely before this, so
      // a dependency scan that never produced a result was indistinguishable in the report from
      // one that ran and found nothing.
      couldNotRun.push("check_dependencies: the scan produced no parseable result, so no dependency was checked");
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
  // Blocking, and deliberately so. Across nineteen runs of an "immutable audit log" task, not one
  // deliverable implemented an immutability control before review, and advisory findings never
  // changed that -- while in the same run, five refused write_file calls moved a hardcoded
  // credential to a secret manager. Advice was not working; refusal was. This moves the task's
  // central requirement from the column that gets ignored into the column that gets fixed.
  //
  // It stays quiet unless it can identify an append-only store that names itself as one, and an
  // undetermined answer is reported as an advisory rather than passed silently.
  // The task text is the only evidence of what was actually asked for. Without it this check
  // cannot tell "no audit store in this project" from "the audit store is named `records`".
  const immutability = guarded("immutability", () => immutabilityFailures(projectDir, {
    taskRequiresImmutability: taskRequiresImmutability(taskText),
  }));
  failures.push(...immutability.failures);
  advisories.push(...immutability.advisories);

  // Blocking for the same measured reason as immutability, and paired with it deliberately: an
  // immutable store filled by anonymous writers is a tamper-proof record of unattributable claims,
  // so closing Tampering while leaving Spoofing open buys very little. "No endpoint authenticates"
  // appeared in 5 of 5 preserved reviews and was still unfixed six runs later.
  const authentication = guarded("authentication", () => authenticationFailures(projectDir));
  failures.push(...authentication.failures);
  advisories.push(...authentication.advisories);

  // Blocking, and it is the only check that looks at two artifacts at once. Each is correct on its
  // own terms -- the code reads a variable, the manifests set some variables -- so nothing else
  // here can see the gap between them, which is where a whole class of deployment failures lives.
  const contract = guarded("manifest_contract", () => manifestContractFailures(projectDir));
  failures.push(...contract.failures);
  advisories.push(...contract.advisories);

  // Manifests that parse as YAML but are not valid Kubernetes. Blocking because the failure is
  // total rather than partial: a container field on a PodSpec means the API server rejects the
  // object, so the workload does not deploy at all. Also catches ${...} interpolation, which
  // Kubernetes never expands, and a health endpoint with no probe wired to it -- graded once as a
  // receiver answering /health with 200 while every real request failed.
  const k8s = guarded("k8s_manifest", () => k8sManifestFailures(projectDir));
  failures.push(...k8s.failures);
  advisories.push(...k8s.advisories);

  // Gated on the task stating that a secret rotates, the same way immutability is gated on the task
  // stating immutability: caching a secret is ordinary and correct when nothing rotates it. When the
  // task does say so, an unbounded cache fails in both directions at once -- the new secret is
  // rejected and the retired one keeps working until every replica restarts.
  const rotation = guarded("secret_rotation", () => secretRotationFailures(projectDir, taskText));
  failures.push(...rotation.failures);
  advisories.push(...rotation.advisories);

  // Retention had been stated in every run of this task and checked in none of them -- roughly
  // sixteen deliverables, no coverage at all. Gated on the task like its two neighbours, and it
  // blocks only on a mechanism that actually deletes the records early: never deleting them
  // satisfies a seven-year requirement outright, so "no expiry configured" is compliance and must
  // not be reported as a defect.
  const retention = guarded("retention", () =>
    retentionFailures(projectDir, { requiredDays: taskRetentionRequirement(taskText)?.days })
  );
  failures.push(...retention.failures);
  advisories.push(...retention.advisories);

  // Reading the tests was never the same as running them. code_quality said so honestly and it was
  // not enough: a deliverable shipped a jest config, thirteen cases and no installed toolchain, and
  // reported "comprehensive test coverage". Installed, its suite failed 3 of 12 -- and those three
  // were exactly the acceptance criteria the task names, sitting among nine that passed.
  //
  // Blocking only when the suite RAN and reported failures, because that needs no interpretation:
  // the project's own tests contradict its own code. A missing toolchain, a timeout or an
  // unreadable summary stays advisory -- those are facts about this machine, and blocking on them
  // would fail work that may be correct, which is how a gate gets switched off.
  const tests = guarded("tests", () =>
    testExecutionReport(projectDir, { wanted: taskWantsTests(taskText) })
  );
  failures.push(...tests.failures);
  advisories.push(...tests.advisories);

  // Two IAM defects a clean plan cannot see. Terraform does not resolve managed-policy ARNs at
  // plan time, so a name that does not exist plans clean and fails at apply; and it has no idea
  // what a ServiceAccount annotation means, so a role annotated onto a pod with an instance-profile
  // trust policy looks fine from either artifact alone. Both were graded on deliverables whose
  // terraform_plan the gate had already approved.
  const iam = guarded("iam_contract", () => iamContractFailures(projectDir));
  failures.push(...iam.failures);
  advisories.push(...iam.advisories);

  // Blocking. An empty file passes every check that reads it, because there is nothing to read --
  // a run emptied all five of its Kubernetes manifests while fixing findings in them, and three
  // separate manifest-aware checks went quiet at once. They had not passed; they had been starved.
  const presence = guarded("artifact_presence", () => artifactPresenceFailures(projectDir, taskText));

  // The only check here that is not security-shaped. A three-run series with an unchanged gate
  // produced a deliverable with clearly the best architecture and the WORST gate score: nothing
  // measured structure, tests or error handling, so gate score and code quality were uncorrelated
  // and no amount of adding security rules would have changed that. Gated on the task asking for
  // the property, like immutability — a project nobody asked to test is not defective untested.
  const quality = guarded("code_quality", () => codeQualityFailures(projectDir, taskText));
  failures.push(...quality.failures);
  advisories.push(...quality.advisories);
  failures.push(...presence.failures);
  advisories.push(...presence.advisories);

  // The artifact census, across every file type rather than Terraform alone. Unlike the resource
  // census this is unambiguous and therefore blocking: it compares files THIS run produced against
  // what they hold now, within one run, so nothing here can be a rename.
  const inventory = artifactInventory(projectDir);
  const lost = artifactRegressions(previousInventory, inventory);
  if (lost.length > 0) {
    failures.push(
      `artifact census: ${lost.length} file(s) held content earlier in this run and have lost most ` +
        `or all of it — ${lost.map((l) => `${l.rel} (${l.was} chars -> ${l.now})`).join(", ")}.\n` +
        `These are files this run wrote itself, compared against themselves, so this is not a rename ` +
        `and not a reorganisation. Content that disappears while other findings are being fixed is ` +
        `the failure mode this exists to catch: the checks that read those files stop reporting, ` +
        `which looks like progress and is not.`
    );
  }
  previousInventory = inventory;
  ran.push("artifact_census");

  for (const dir of tfDirs) {
    const ckv = checkovAdvisory(dir, projectDir);
    if (ckv) {
      advisories.push(ckv);
      ran.push(`checkov(${path.relative(projectDir, dir) || "."})`);
    }

    const census = await pendingResourceRemovals(dir);
    const rel = path.relative(projectDir, dir) || ".";
    if (census.unavailable) {
      // Reported once, however many Terraform roots there are: the reason is the same for all of
      // them and repeating it buries the rest of the report.
      if (!couldNotRun.some((c) => c.startsWith("resource_census:"))) {
        couldNotRun.push(`resource_census: ${census.unavailable}`);
      }
    } else {
      // Recorded whether or not anything was found. It used to be pushed only when there WERE
      // removals, so a census that ran and found nothing was absent from the validators-run list
      // in exactly the same way as one that never ran -- and `provides` is checked against that
      // list.
      ran.push(`resource_census(${rel})`);
      if (census.removals.length) {
        advisories.push(
          `resource census (${rel}): these resources were declared earlier in this run and are now ` +
            `gone: ${census.removals.join(", ")}. Renaming a resource looks identical to deleting one here, ` +
            `so this is a question, not a verdict — check whether each was replaced or simply lost.`
        );
      }
    }
  }

  // Work that was never committed was never seen by the pre-commit hook, and the hook is the
  // boundary that runs the full check set. Three separate runs ended "validation PASSED" with the
  // real deliverable sitting uncommitted in the working tree — the loop's own gate is a subset of
  // what the hook runs, so passing it proves less than it appears to.
  //
  // Artifacts are excluded, or this would be unsatisfiable for any project that has run
  // `terraform init`.
  //
  // The `status !== 0` branch is the one that matters, and it was missing. Outside a repository
  // `git status` exits non-zero, so this whole block used to be skipped in silence: no failure, no
  // advisory, and no `uncommitted_work` entry in `ran` either, which is what made it invisible. A
  // run whose deliverable was never committed reported PASSED, having never met the hook at all. A
  // check that could not run is not a check that passed, so it now fails outright -- the same rule
  // this gate applies to everything else.
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf8" });
  if (status.status !== 0) {
    ran.push("uncommitted_work");
    failures.push(
      `uncommitted work: could not determine what is committed — \`git status\` failed in ` +
        `${projectDir} (${(status.stderr || "").trim().split("\n")[0] || `exit ${status.status}`}). ` +
        `Usually this means the directory is not a git repository, so nothing has been committed ` +
        `and the repository's own checks — which are a superset of the ones run here — have never ` +
        `seen this work. Run git_commit; if it reports that this is not a repository, say so in ` +
        `your final message rather than continuing.`
    );
  } else {
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
  // Workload identity. Registered in .mcp.json since the beginning and never invoked by the gate,
  // so check_auth_posture ran in no grade at all -- the `authentication` line in every run is the
  // in-process route check, which is a different thing. Registration is not enforcement, which is
  // the observation this whole project started from.
  //
  // Its own blocking/advisory split is respected rather than re-derived: a heuristic finding it
  // marks advisory stays advisory here.
  const authPosture = toolRegistry.get("check_auth_posture");
  if (authPosture) {
    const result = await authPosture.server.call("check_auth_posture", { directory: "." });
    ran.push("check_auth_posture");
    try {
      const parsed = JSON.parse(result);
      const scanned = parsed.root ? path.resolve(parsed.root) : null;
      const root = path.resolve(projectDir);
      if (scanned && scanned !== root && !scanned.startsWith(root + path.sep)) {
        failures.push(
          `check_auth_posture scanned ${scanned}, which is not this project (${root}). The ` +
            `workload-identity check did NOT run against this project — treat it as unperformed.`
        );
      } else {
        const blocking = (parsed.findings || []).filter((f) => !f.heuristic && f.severity !== "low");
        const advisory = (parsed.findings || []).filter((f) => f.heuristic || f.severity === "low");
        for (const f of blocking) {
          failures.push(`workload identity: ${f.file}: ${f.message}${f.remediation ? ` — ${f.remediation}` : ""}`);
        }
        if (advisory.length) {
          advisories.push(
            `workload identity: ${advisory.length} heuristic finding(s) — ` +
              advisory.map((f) => `${f.file}: ${f.message}`).join("; ")
          );
        }
        // An allowance is never silence. Writing `# identity-guard:allow <rule> <reason>` costs a
        // model nothing and needs no understanding -- it is strictly easier to produce than any of
        // the fixes this gate asks for -- so every one is named in the report with its reason, and
        // a deliverable carrying five reads differently from one carrying none. The reader decides
        // whether the reason holds; the gate only guarantees they see it.
        const allowed = parsed.allowances || [];
        if (allowed.length) {
          advisories.push(
            `workload identity: ${allowed.length} finding(s) were opted out of in the manifests, ` +
              `not fixed — ` +
              allowed.map((a) => `${a.file}: ${a.ruleId} ("${a.reason}")`).join("; ") +
              `. Each is a claim someone made. Check that the reason is true of this project before ` +
              `treating the rule as satisfied.`
          );
        }
        for (const r of parsed.refusedAllowances || []) {
          advisories.push(
            `workload identity: an opt-out in ${r.file} names ${r.ruleId} and gives no reason, so it ` +
              `had no effect. An allowance has to say what it is for, or it does not exist.`
          );
        }
      }
    } catch {
      advisories.push(
        `workload identity: check_auth_posture returned output that could not be parsed, so nothing ` +
          `was established about how these workloads authenticate.`
      );
    }
  }

  const secretScan = toolRegistry.get("scan_path");
  if (secretScan) {
    const result = await secretScan.server.call("scan_path", { target: "." });
    ran.push("scan_path");
    try {
      const parsed = JSON.parse(result);
      // A scan pointed somewhere else is not a result about this project in either direction: its
      // findings are someone else's and its silence proves nothing here. This has happened -- the
      // server fell back to the caller's cwd and scanned a whole monorepo -- and it presented as
      // sixteen blocking credentials in a project that had none.
      const scanned = parsed.target ? path.resolve(parsed.target) : null;
      const root = path.resolve(projectDir);
      if (scanned && scanned !== root && !scanned.startsWith(root + path.sep)) {
        failures.push(
          `scan_path scanned ${scanned}, which is not this project (${root}). Its findings are not ` +
            `about these files and its silence is not evidence about them either. The secret scan ` +
            `did NOT run against this project — treat the credential check as unperformed.`
        );
      } else if (!parsed.clean) {
        failures.push(
          `scan_path: ${parsed.summary.total} hardcoded credential(s):\n${result.slice(0, 1200)}`
        );
      }
    } catch {
      // Same reasoning as the dependency scan above: a secret scan that produced nothing readable
      // has not cleared this project of hardcoded credentials.
      couldNotRun.push("scan_path: the scan produced no parseable result, so no file was checked for credentials");
    }
  }

  // Reported, never silent. A directory that opted out is a fact the reader needs; an exemption
  // nobody can see is indistinguishable from a check that did not run.
  const exempt = declaredFixtures(projectDir);

  return { ran, failures, advisories, couldNotRun, inapplicable, exempt };
}

// The pre-commit hook is the only boundary that runs the *full* check set -- the workload-identity
// scan and terraform-guard's source scan run nowhere else in this pipeline. A project directory
// that is not a repository has no such boundary, and the loop cannot create one after the fact
// because git_commit fails on every call with "Not a git repository". One real run made 26
// write_file calls and 4 git_commit calls into a plain directory, committed nothing, and reported
// validation PASSED. Initializing here means the boundary exists before the model writes anything.
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
