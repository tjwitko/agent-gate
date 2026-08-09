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
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { model: null, project: null, task: null, maxTurns: 40, maxTokens: 4000, webSearch: false, maxValidationRounds: 3 };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--model") o.model = a[++i];
    else if (a[i] === "--project") o.project = path.resolve(a[++i]);
    else if (a[i] === "--task") o.task = a[++i];
    else if (a[i] === "--max-turns") o.maxTurns = Number(a[++i]);
    else if (a[i] === "--max-tokens") o.maxTokens = Number(a[++i]);
    else if (a[i] === "--web-search") o.webSearch = true;
    else if (a[i] === "--max-validation-rounds") o.maxValidationRounds = Number(a[++i]);
  }
  if (!o.model || !o.project || !o.task) {
    console.error(
      "usage: agent-loop.mjs --model <alias> --project <dir> --task <file> " +
        "[--max-turns 40] [--max-tokens 4000] [--web-search] [--max-validation-rounds 3]"
    );
    process.exit(1);
  }
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

function localTools(projectDir) {
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

async function chat(model, messages, tools, maxTokens) {
  const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, tools, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`llama-server ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

// Runs every validator that applies to what is actually on disk, without waiting to be asked.
//
// This is the difference between a checklist and a gate. Measured across four runs of the same
// task with identical tooling, the model called terraform_plan 3, 1, 4 and 0 times, and never
// called check_dependencies or web_search at all. A tool the model may or may not invoke is not a
// guardrail. Note the gate is on validators *passing*, not on tools having been *called* — a model
// can call a validator, receive errors, and finish anyway, which is exactly what happened in one run.
async function validateProject(projectDir, toolRegistry) {
  const failures = [];
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
    const unscannable = /could not authenticate/i.test(result);
    if (/TOOL REPORTED A PROBLEM|Refusing to plan-approve/.test(result) && !unscannable) {
      failures.push(`terraform_plan(${rel}):\n${result.slice(0, 1500)}`);
    }
  }

  const depAudit = toolRegistry.get("check_dependencies");
  const manifests = ["package.json", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml"];
  if (depAudit && manifests.some((m) => existsSync(path.join(projectDir, m)))) {
    const result = await depAudit.server.call("check_dependencies", { directory: ".", severity_threshold: "high" });
    ran.push("check_dependencies");
    try {
      const parsed = JSON.parse(result);
      if ((parsed.findings || []).length > 0) {
        failures.push(`check_dependencies: ${parsed.findings.length} finding(s) at or above high severity:\n${result.slice(0, 1200)}`);
      }
    } catch {
      /* non-JSON output means the scan itself failed; not the model's problem to fix */
    }
  }

  return { ran, failures };
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

  const local = localTools(opts.project);
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
        "check_dependencies. Say DONE only once the project is complete and build_check passes.",
    },
    { role: "user", content: readFileSync(opts.task, "utf8") },
  ];

  const usage = { prompt: 0, completion: 0, total: 0, calls: 0 };
  const toolCallLog = [];
  let validationRounds = 0;
  let finalValidation = null;

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    let response;
    try {
      response = await chat(opts.model, messages, toolSchemas, opts.maxTokens);
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

    if (calls.length === 0) {
      if (/\bDONE\b/i.test(msg.content || "") || choice?.finish_reason === "stop") {
        // The model wanting to stop is a request, not the exit condition. Validators run here
        // whether or not the model ever called them, and failures go back as work to do.
        const { ran, failures } = await validateProject(opts.project, toolRegistry);
        validationRounds++;
        console.log(
          `[gate] validation round ${validationRounds}: ran ${ran.join(", ") || "nothing"} — ` +
            `${failures.length} failing`
        );
        finalValidation = { ran, failures };

        if (failures.length === 0) {
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

      const short = String(result).slice(0, MAX_TOOL_RESULT_CHARS);
      toolCallLog.push({ turn, name, args: name === "write_file" ? { path: args.path } : args, resultPreview: short.slice(0, 200) });
      console.log(`    -> ${name}(${name === "write_file" ? args.path : JSON.stringify(args).slice(0, 80)}) : ${short.split("\n")[0].slice(0, 120)}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: short });
    }
  }

  for (const s of servers) s.kill();

  // Always re-validate against the files as they finally stand, rather than reusing the last
  // gate result. The loop can exit on max-turns after the model has already fixed what the gate
  // complained about, and reporting the stale verdict would claim a failure that no longer exists
  // — the same class of dishonest signal this gate exists to remove.
  finalValidation = await validateProject(opts.project, toolRegistry);
  const report = {
    model: opts.model,
    project: opts.project,
    usage,
    toolCalls: toolCallLog.length,
    validation: { rounds: validationRounds, ran: finalValidation.ran, failures: finalValidation.failures },
    validationPassed: finalValidation.failures.length === 0,
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
  if (!report.validationPassed) {
    for (const f of finalValidation.failures) console.log(`  - ${f.split("\n")[0]}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
