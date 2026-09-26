// The gate: everything `agent-gate` runs, and nothing that talks to a model.
//
// This was the back half of agent/agent-loop.mjs, a 2336-line module that held both the validators
// and the loop that drives a model through them. bin/validate.mjs imported three symbols from it
// and got the whole thing, which is why a security package listed @anthropic-ai/sdk as a runtime
// dependency: not because the gate needs Anthropic, but because `validateProject` shared a file
// with something that does. `validateProject` itself contains no reference to either model client.
//
// The split is by what the code talks to, not by what it does. Nothing here opens a socket to a
// model, and nothing here imports the tracing module, so the gate's dependency list is now a
// statement about the gate. agent-loop.mjs imports what it needs from here and re-exports the
// names it used to own, so every existing importer keeps working.
//
// Note on `__dirname`: the resolvers below default `fromDir` to it and then walk `../..` to reach
// the sibling checkouts. lib/ and agent/ are both one level under the repository root, so that
// still lands in the same place -- checked before moving, because "worked only where it was
// written" is the defect this estate keeps finding.

import { spawn, spawnSync } from "child_process";
import { createHash } from "crypto";
import { createRequire } from "module";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { immutabilityFailures, taskRequiresImmutability } from "../agent/immutability.mjs";
import { retentionFailures, taskRetentionRequirement } from "../agent/retention.mjs";
import { testExecutionReport } from "../agent/test-execution.mjs";
import { authenticationFailures } from "../agent/authentication.mjs";
import { manifestContractFailures } from "../agent/manifest-contract.mjs";
import { k8sManifestFailures } from "../agent/k8s-manifest.mjs";
import { secretRotationFailures } from "../agent/secret-rotation.mjs";
import { iamContractFailures } from "../agent/iam-contract.mjs";
import { artifactPresenceFailures, artifactInventory, artifactRegressions } from "../agent/artifact-presence.mjs";
import { codeQualityFailures, taskWantsTests } from "../agent/code-quality.mjs";
import { SKIP_DIRS } from "../agent/skip-dirs.mjs";
import { findsLockfile, NOT_AUTHORITATIVE_NOTE } from "../agent/lockfiles.mjs";
import { declaredFixtures, isDeclaredFixture } from "../agent/fixture-markers.mjs";
import { ensureGitignore, isArtifact, ensureRepo } from "../agent/commit-gate.mjs";

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

// Exported for agent-loop.mjs: a run must not be able to write outside the project it was given.
export function protectRepo(projectDir) {
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
// Exported for agent-loop.mjs, which needs the same scanner instance the gate's write path uses.
export async function loadSecretScanner() {
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

// Loaded from terraform-guard so the loop and the tool share one definition of what went
// missing. Absent sibling repo => no findings, the non-blocking direction.
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

// Whether a dependency scan is authoritative. This reads agent/lockfiles.mjs, which holds its own
// copy of the rule ON PURPOSE -- see the comment there. It used to resolve the list from a sibling
// checkout and return false when that path was missing, so on every machine except one developer's
// every project counted as having no lockfile and every high-severity finding was silently
// downgraded to advisory. Do not re-introduce a sibling lookup here.
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

export async function validateProject(projectDir, toolRegistry, taskText = "", { preCommit = false } = {}) {
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
  // In a pre-commit hook this check's premise is satisfied by the act that invoked it: the work
  // is uncommitted because it is being committed right now. Left in, it fails every commit
  // forever, which teaches people to pass --no-verify and costs the whole hook.
  //
  // Recorded as inapplicable rather than dropped. A check that vanishes from the report is the
  // shape this gate exists to refuse -- the reader sees the name and the reason, not a shorter
  // list of validators and no explanation for it.
  if (preCommit) {
    inapplicable.push({
      tool: "uncommitted_work",
      why: "running as a pre-commit hook, where the work is uncommitted because it is being committed",
    });
  } else {
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
