#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";

// Remove all keys from process.env except those in the allowlist. A stdio MCP server
// spawned by an editor/CLI inherits its entire parent environment by default (API keys,
// tokens, etc. included) even though it only needs its own config vars — drop the rest.
function sanitizeEnv(allowlist) {
  for (const key in process.env) {
    if (!allowlist.includes(key)) {
      delete process.env[key];
    }
  }
}
sanitizeEnv(["PATH", "HOME", "LOCAL_LLM_URL", "FAST_MODEL_ALIAS", "CAPABLE_MODEL_ALIAS", "CONTEXT_ROOT"]);

// Refuse to forward anything that looks like a credential to the local model. Even though the
// model runs locally, secrets sent to it still land in its KV cache/memory and should never be
// typed into any LLM context — pass placeholders in delegated tasks, substitute real secrets
// into the result afterward, not before.
function findSecretLikeContent(text) {
  const matches = [];
  const placeholders = new Set([
    "xxx", "changeme", "example", "your_key_here", "redacted", "placeholder", "todo", "insert_key_here",
  ]);
  const isPlaceholder = (v) => placeholders.has(v.toLowerCase());
  const secretWords = "secret|password|passwd|token|api_key|apikey|access_key|private_key";

  if (/-----BEGIN (OPENSSH PRIVATE KEY|RSA PRIVATE KEY|PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/.test(text)) {
    matches.push("possible SSH/PGP private key");
  }
  if (/\bAKIA[A-Z0-9]{16}\b/.test(text)) {
    matches.push("possible AWS access key");
  }

  // KEY=value / KEY: value style (env files, yaml, shell exports)
  const assignRe = new RegExp(`\\b(\\w*(?:${secretWords})\\w*)\\s*[:=]\\s*["']?(\\S{8,}?)["']?(?:\\s|$)`, "gi");
  for (const m of text.matchAll(assignRe)) {
    if (!isPlaceholder(m[2])) matches.push(`possible secret-looking assignment: ${m[1]}`);
  }

  // JSON "key-name": "value" style
  const jsonRe = new RegExp(`"(\\w*(?:${secretWords})\\w*)"\\s*:\\s*"([^"]{8,})"`, "gi");
  for (const m of text.matchAll(jsonRe)) {
    if (!isPlaceholder(m[2])) matches.push(`possible secret-looking assignment: ${m[1]}`);
  }

  return [...new Set(matches)];
}

// context_files support: lets a caller point the local model at real files instead of pasting
// their contents into `task` (which costs the calling model output tokens to transcribe). Reads
// happen here in the server, never in the calling model's own output.
//
// CONTEXT_ROOT is the sole allowed read boundary — defaults to this process's cwd (wherever the
// MCP client launched it from) so a compromised/careless `task` can't reach outside the project
// being worked on. Override with the CONTEXT_ROOT env var if that default is wrong for a setup.
const CONTEXT_ROOT = path.resolve(process.env.CONTEXT_ROOT || process.cwd());
const MAX_CONTEXT_FILE_BYTES = 8_000;
const MAX_CONTEXT_TOTAL_BYTES = 16_000;
// Filenames that are refused outright regardless of content — a belt-and-suspenders check
// alongside findSecretLikeContent(), which only scans content and could miss a binary key file
// or a file whose secret value doesn't match the content patterns.
const SENSITIVE_FILENAME_RE =
  /(^|[/\\])(\.env(\..*)?|\.ssh|\.aws|\.npmrc|\.git-credentials|id_rsa\w*|.*\.pem|.*\.key|credentials\.json)$/i;

// Resolve relOrAbsPath against root and refuse anything that escapes it (via ../, a
// sibling-directory prefix collision, or an absolute path elsewhere on disk). The `+ path.sep`
// check matters: without it, a root of "/foo/bar" would incorrectly accept "/foo/barevil".
// `action` only shapes the error message ("read"/"write") — the containment rule is identical
// for both, and writes must never get a weaker boundary than reads.
function resolveWithinRoot(relOrAbsPath, root, action) {
  const resolved = path.resolve(root, relOrAbsPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`refuses to ${action} outside ${root}: ${relOrAbsPath}`);
  }
  return resolved;
}

function resolveContextPath(relOrAbsPath, contextRoot) {
  return resolveWithinRoot(relOrAbsPath, contextRoot, "read");
}

function formatContextBlock(files) {
  if (files.length === 0) return "";
  const parts = ["Reference files:", ""];
  for (const file of files) {
    parts.push(`--- ${file.path} ---`, file.content, "");
  }
  return parts.join("\n");
}

// Reads each requested path under CONTEXT_ROOT, applying the same guardrails as task/system_prompt:
// refuse sensitive filenames outright, scan content for secret-like text, and cap size so a large
// file can't silently blow past the model's context window or dominate the timeout budget.
function readContextFiles(relPaths) {
  const files = [];
  let totalBytes = 0;
  for (const relPath of relPaths) {
    const resolved = resolveContextPath(relPath, CONTEXT_ROOT);
    if (SENSITIVE_FILENAME_RE.test(resolved)) {
      throw new Error(`refusing to read a sensitive-looking file: ${relPath}`);
    }
    let content;
    try {
      content = readFileSync(resolved, "utf8");
    } catch (error) {
      throw new Error(`could not read ${relPath}: ${error.message}`);
    }
    if (Buffer.byteLength(content, "utf8") > MAX_CONTEXT_FILE_BYTES) {
      throw new Error(
        `${relPath} is larger than the ${MAX_CONTEXT_FILE_BYTES}-byte per-file context limit`
      );
    }
    const secretHits = findSecretLikeContent(content);
    if (secretHits.length > 0) {
      throw new Error(
        `refusing to read ${relPath}: looks like it contains a credential (${secretHits.join(", ")})`
      );
    }
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > MAX_CONTEXT_TOTAL_BYTES) {
      throw new Error(
        `context_files exceeds the ${MAX_CONTEXT_TOTAL_BYTES}-byte combined limit — pass fewer/smaller files`
      );
    }
    files.push({ path: relPath, content });
  }
  return files;
}

// output_files support: the whole point is that the calling model never has to transcribe the
// generated artifact. Without this, a delegated file comes back as text and then gets written
// out via the caller's own Write/Edit call — paying output tokens a SECOND time for content the
// local model already produced, which is exactly the do-it-yourself baseline and structurally
// caps savings near zero. Measured: the one delegation round that showed real savings (-65%)
// avoided the retype by splitting the response with an external awk script; a later round that
// hand-integrated the result paid ~541 tokens to retype it and landed at +173%.
const MAX_OUTPUT_FILE_BYTES = 200_000;

// The local model emits a fenced code block despite explicit "no markdown fences" instructions
// with some regularity (observed across three different models in testing). Harmless when the
// response is being read by a human/model; corrupts the file outright when written to disk.
function stripCodeFence(content) {
  const lines = content.split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === "") end--;
  if (start < end && /^```/.test(lines[start].trim()) && lines[end].trim() === "```") {
    return lines.slice(start + 1, end).join("\n");
  }
  return content;
}

// Splits a multi-file response on "===FILE: <path>===" marker lines. Anything before the first
// marker is discarded, which conveniently drops preamble chatter. Returns [] when there are no
// markers at all (single-file case, handled by the caller).
function splitResponseIntoFiles(text) {
  const files = [];
  let currentPath = null;
  let buffer = [];
  const flush = () => {
    if (currentPath !== null) files.push({ path: currentPath, content: buffer.join("\n") });
  };
  for (const line of text.split("\n")) {
    const marker = line.match(/^===FILE:\s*(.+?)\s*===$/);
    if (marker) {
      flush();
      currentPath = marker[1];
      buffer = [];
    } else if (currentPath !== null) {
      buffer.push(line);
    }
  }
  flush();
  return files;
}

// Writes the model's response to disk. Two-phase on purpose: every path is validated before ANY
// file is written, so a violation in the 3rd of 4 files doesn't leave the first two on disk.
//
// The caller declares the allowed paths up front and the model's own emitted paths are checked
// against that allowlist — the local model's output is not trusted to choose write destinations.
function writeOutputFiles(responseText, declaredPaths, allowOverwrite) {
  const parsed = splitResponseIntoFiles(responseText);
  let planned;
  if (parsed.length === 0) {
    if (declaredPaths.length !== 1) {
      throw new Error(
        `response contained no "===FILE: <path>===" markers, but ${declaredPaths.length} output ` +
          `files were declared. Either declare exactly one output file, or instruct the model in ` +
          `\`task\` to emit each file preceded by a line reading exactly "===FILE: <path>===".`
      );
    }
    planned = [{ path: declaredPaths[0], content: stripCodeFence(responseText) }];
  } else {
    planned = parsed.map((f) => ({ path: f.path, content: stripCodeFence(f.content) }));
  }

  // Phase 1: validate everything. Compare on resolved paths so "./a.js" and "a.js" match.
  const declaredResolved = new Map(
    declaredPaths.map((p) => [resolveWithinRoot(p, CONTEXT_ROOT, "write"), p])
  );
  const validated = [];
  for (const file of planned) {
    const resolved = resolveWithinRoot(file.path, CONTEXT_ROOT, "write");
    if (!declaredResolved.has(resolved)) {
      throw new Error(
        `the model's response tried to write "${file.path}", which is not in the declared ` +
          `output_files list (${declaredPaths.join(", ")}). Refusing all writes from this response.`
      );
    }
    if (SENSITIVE_FILENAME_RE.test(resolved)) {
      throw new Error(`refusing to write a sensitive-looking file: ${file.path}`);
    }
    if (Buffer.byteLength(file.content, "utf8") > MAX_OUTPUT_FILE_BYTES) {
      throw new Error(`${file.path} exceeds the ${MAX_OUTPUT_FILE_BYTES}-byte per-file output limit`);
    }
    if (existsSync(resolved) && !allowOverwrite) {
      throw new Error(
        `${file.path} already exists and allow_overwrite was not set. Refusing all writes from ` +
          `this response — review the existing file before letting an unreviewed local-model ` +
          `response replace it.`
      );
    }
    validated.push({ relPath: file.path, resolved, content: file.content });
  }

  // Phase 2: write.
  const written = [];
  for (const file of validated) {
    mkdirSync(path.dirname(file.resolved), { recursive: true });
    writeFileSync(file.resolved, file.content);
    written.push({
      path: file.relPath,
      bytes: Buffer.byteLength(file.content, "utf8"),
      lines: file.content.split("\n").length,
    });
  }
  return written;
}

const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || "http://localhost:8080";
// Router-mode model aliases (see local-copilot-stack's launchd/presets.ini.template).
// "fast" has no reasoning phase and is what this tool should default to for the
// bounded/mechanical work it's meant for; "capable" is the same model VS Code Copilot
// Chat uses, for the rare delegated task that genuinely needs more depth.
const FAST_MODEL_ALIAS = process.env.FAST_MODEL_ALIAS || "delegate-fast";
const CAPABLE_MODEL_ALIAS = process.env.CAPABLE_MODEL_ALIAS || "Qwen3.5-9B-UD-Q4_K_XL.gguf";
const DEFAULT_MAX_TOKENS = 2048;
// Observed throughput on this hardware is ~17.5 tok/s in the normal case, i.e. ~57ms/token —
// budget generously above that (150ms/token) plus fixed overhead for connection/prompt processing,
// since a fixed timeout independent of max_tokens was cutting off legitimately-still-running generations.
const TIMEOUT_BASE_MS = 30_000;
const TIMEOUT_PER_TOKEN_MS = 150;

// Below this, the fixed overhead of a warning isn't worth flagging even if the ratio is bad —
// a two-line task producing a one-line answer isn't a real problem, only a large one is.
const MIN_SPEC_CHARS_FOR_RATIO_WARNING = 300;

// --- Hard gate -------------------------------------------------------------------------------
// Advisory guidance in this tool's description empirically did not work: the context_files cost
// lesson was written down after one round and then violated in the very next one. So the
// thresholds below are enforced rather than suggested. Numbers come from six measured rounds —
// the single delegation that showed a real saving produced ~230 lines across 4 files; every
// round that lost produced well under 150. The higher bar for freshly-authored context files is
// because authoring one costs the caller the same output tokens as pasting the content would
// have, so it needs a correspondingly larger artifact to amortize.
//
// This is checked BEFORE the model is called: a refusal shouldn't also burn local compute.
const MIN_EXPECTED_OUTPUT_LINES = Number(process.env.MIN_EXPECTED_OUTPUT_LINES) || 150;
const MIN_EXPECTED_OUTPUT_LINES_FRESH_CONTEXT =
  Number(process.env.MIN_EXPECTED_OUTPUT_LINES_FRESH_CONTEXT) || 300;

// --- Cross-call ledger -----------------------------------------------------------------------
// An earlier version of this tool's docs claimed batching couldn't be enforced because the
// server had "no visibility across separate calls". That was simply wrong — nothing stops a
// stdio server from persisting state. This ledger is that state: it makes repeated small calls,
// inflated estimates, and a losing overall trend visible instead of invisible.
//
// Deliberately global rather than per-CONTEXT_ROOT: the behaviour being tracked belongs to the
// calling model, not to any one project.
const LEDGER_DIR = path.join(
  process.env.HOME || "/tmp",
  "Library",
  "Application Support",
  "local-delegate-mcp"
);
const LEDGER_PATH = path.join(LEDGER_DIR, "ledger.json");
const LEDGER_MAX_ENTRIES = 200;
const BATCHING_WINDOW_MS = 10 * 60 * 1000;
const BATCHING_MIN_RECENT_SMALL = 2;

function readLedger() {
  try {
    const parsed = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
    return Array.isArray(parsed?.calls) ? parsed : { calls: [] };
  } catch {
    return { calls: [] };
  }
}

// Returns the updated ledger, or null if anything went wrong. Ledger I/O must never be able to
// break a delegation — a bookkeeping failure is not a reason to lose a completed result.
function appendLedger(entry) {
  try {
    const ledger = readLedger();
    ledger.calls.push(entry);
    if (ledger.calls.length > LEDGER_MAX_ENTRIES) {
      ledger.calls = ledger.calls.slice(-LEDGER_MAX_ENTRIES);
    }
    mkdirSync(LEDGER_DIR, { recursive: true });
    writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
    return ledger;
  } catch {
    return null;
  }
}

// Only speaks up when there's something actionable — a note on every call trains the reader to
// skip it, so silence here is meant to be informative.
function buildLedgerNotes(ledger, current) {
  if (!ledger) return [];
  const notes = [];
  const prior = ledger.calls.slice(0, -1);

  // The gate is only as good as the estimate feeding it. If a declared size clears the bar but
  // the real output comes in far under, the gate was bypassed — accidentally or otherwise.
  if (
    current.outcome === "completed" &&
    current.declaredLines >= current.threshold &&
    current.actualLines < current.declaredLines * 0.5
  ) {
    notes.push(
      `Estimate was off by more than half: declared expected_output_lines=${current.declaredLines} ` +
        `(clearing the ${current.threshold}-line gate), actual output was ${current.actualLines} ` +
        `line${current.actualLines === 1 ? "" : "s"}. ` +
        `The gate can't protect against optimistic estimates — it only works if the number is honest.`
    );
  }

  const windowStart = current.at - BATCHING_WINDOW_MS;
  const recentSmall = prior.filter(
    (c) => c.at >= windowStart && typeof c.actualLines === "number" && c.actualLines < c.threshold
  );
  if (
    typeof current.actualLines === "number" &&
    current.actualLines < current.threshold &&
    recentSmall.length >= BATCHING_MIN_RECENT_SMALL
  ) {
    notes.push(
      `That makes ${recentSmall.length + 1} delegations in the last ` +
        `${Math.round(BATCHING_WINDOW_MS / 60000)} minutes whose output came in under the ` +
        `${current.threshold}-line bar. These very likely should have been one batched call.`
    );
  }

  const recentCompleted = ledger.calls.slice(-10).filter((c) => c.outcome === "completed");
  if (recentCompleted.length >= 5) {
    const underwater = recentCompleted.filter((c) => c.responseChars < c.specChars).length;
    if (underwater / recentCompleted.length >= 0.3) {
      notes.push(
        `Ledger: ${underwater} of the last ${recentCompleted.length} delegations produced less ` +
          `output than the spec that requested them. Delegation is losing more often than winning ` +
          `right now — consider doing this class of work directly.`
      );
    }
  }

  return notes;
}

// Guards against a second failure mode found empirically (see local-delegate-mcp's git history):
// delegating something so small that writing a precise spec for it costs more than just writing
// the thing directly. specChars/responseChars are a proxy for that — not exact token costs, but
// cheap to compute and good enough to flag the pattern to whichever model is calling this tool.
function buildRatioWarning(specChars, responseChars, minSpecChars) {
  if (specChars < minSpecChars) return null;
  if (responseChars < specChars) {
    return (
      `This response (${responseChars} chars) was shorter than the task/system_prompt spec ` +
      `that produced it (${specChars} chars) — for asks this small, consider doing it directly ` +
      `next time instead of delegating.`
    );
  }
  return null;
}

const server = new McpServer({
  name: "local-delegate",
  version: "1.0.0",
});

server.tool(
  "delegate_to_local_model",
  "Delegate a self-contained, low-skill subtask to a locally-hosted LLM running on this machine, " +
    "instead of doing it yourself. Use this ONLY for bounded, mechanical work you can specify " +
    "completely up front and can verify at a glance once it comes back: boilerplate generation, " +
    "repetitive scaffolding, simple formatting/renaming, straightforward test-stub generation, " +
    "mechanical refactors with an obvious correct answer. Do NOT use this for anything requiring " +
    "judgment, multi-step reasoning, security- or correctness-sensitive work, or anything you " +
    "can't easily verify — the local model is meaningfully less reliable than you are and has no " +
    "memory of this conversation, so `task` must contain everything it needs to know. Always " +
    "review the returned output before relying on it; it can be wrong. Don't delegate a single " +
    "small/isolated artifact (roughly under 20 lines) — writing a precise-enough spec for " +
    "something that small usually costs more than just writing it yourself. If you have several " +
    "small related mechanical asks, batch them into one `task` rather than one call per item — " +
    "each call pays a fixed overhead regardless of how small the ask is. When the result is " +
    "destined for files, pass `output_files` so this tool writes them directly; transcribing " +
    "the returned text into your own Write/Edit call means paying output tokens twice for the " +
    "same content and is the most common reason a delegation ends up more expensive than just " +
    "doing the work yourself. `expected_output_lines` is required and is enforced: small " +
    "delegations are refused outright, because measured evidence says they cost more than they " +
    "save. Estimate that number BEFORE writing the spec — if it's under the bar, skip this tool " +
    "rather than spending tokens on a spec that will be refused. If the task references a " +
    "specific version of an external library, framework, or infrastructure module (an API " +
    "shape, a Terraform registry module's inputs, a package's exports), verify its actual " +
    "current interface yourself first — the local model has no way to know its own knowledge " +
    "is stale, and will state a wrong interface with the same confidence as a correct one. Pass " +
    "the verified reference via `context_files` rather than trusting either your memory or its.",
  {
    task: z
      .string()
      .describe(
        "A fully self-contained description of the work to do. The local model cannot see this " +
          "conversation and cannot ask follow-up questions. Prefer `context_files` over pasting " +
          "file contents into this string — pasting costs you output tokens to transcribe. But " +
          "don't restate in prose what a context_files entry already shows structurally (field " +
          "names, shape, nesting) — that's redundant with the example and costs you twice. Only " +
          "add prose for what an example can't convey: exact thresholds, ordering/precedence " +
          "rules, edge-case handling. And if you've already written code that does part of what " +
          "you're asking for (a helper function, a type), reference it by name and ask the model " +
          "to use it — don't re-derive its exact logic in English when you could just point at it."
      ),
    context_files: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of file paths (relative to this server's working directory, or absolute " +
          "within it) whose contents should be given to the local model as reference material, " +
          "instead of pasting them into `task`. Refused if a path escapes the server's working " +
          "directory, looks like a sensitive file (.env, .ssh, *.pem, *.key, credentials, etc.), " +
          "or its content looks like it contains a credential. Capped at 8000 bytes per file, " +
          "16000 bytes combined. Only actually free if the file already exists for other " +
          "reasons — authoring a new file specifically to use this parameter costs the same " +
          "output tokens as pasting the same content into `task` would have. If you need to " +
          "demonstrate a real external schema/format that doesn't exist as a file yet, derive " +
          "one with a short script from data you can already fetch (an API response, a command's " +
          "output) rather than composing the example by hand — you pay for the script, not the " +
          "content it produces."
      ),
    output_files: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of file paths the response should be written to, relative to this " +
          "server's working directory. STRONGLY PREFERRED over taking the returned text and " +
          "writing it out yourself: transcribing the artifact into your own Write/Edit call " +
          "costs you output tokens a second time for content the local model already produced, " +
          "which is the single biggest reason a delegation ends up costing more than doing the " +
          "work directly. When set, the tool returns only a manifest (paths, sizes) instead of " +
          "the content — read the files back to review them. For more than one file, instruct " +
          "the model in `task` to precede each file with a line reading exactly " +
          "\"===FILE: <path>===\"; paths it emits must match this list or all writes are " +
          "refused. Existing files are never overwritten unless allow_overwrite is set."
      ),
    allow_overwrite: z
      .boolean()
      .optional()
      .describe(
        "Permit output_files to replace files that already exist (default false). Leave unset " +
          "when generating new files. Only set this when you have already looked at what's " +
          "there and intend for an unreviewed local-model response to replace it."
      ),
    expected_output_lines: z
      .number()
      .int()
      .positive()
      .describe(
        `REQUIRED. Your honest estimate of how many lines the response will contain. Calls ` +
          `below ${MIN_EXPECTED_OUTPUT_LINES} lines are refused (${MIN_EXPECTED_OUTPUT_LINES_FRESH_CONTEXT} ` +
          `if context_files had to be authored for this call), because measured evidence says ` +
          `delegating an artifact that small costs more in spec-writing than doing the work ` +
          `directly. Estimate before writing the spec — if the number is under the bar, skip the ` +
          `tool and write it yourself rather than spending tokens on a spec that gets refused. ` +
          `Inflating the number to get past the gate is self-defeating and is detected: the ` +
          `actual output size is compared against this and flagged when it's off by half.`
      ),
    context_files_are_preexisting: z
      .boolean()
      .optional()
      .describe(
        "REQUIRED whenever context_files is used. True only if every listed file already " +
          "existed for reasons independent of this delegation. False if you authored any of " +
          "them to support this call — that costs the same output tokens as pasting the content " +
          "into `task`, so a higher output threshold applies to make it worth doing."
      ),
    acknowledge_small_task: z
      .string()
      .optional()
      .describe(
        "Escape hatch for the expected_output_lines gate: a written reason why this " +
          "below-threshold delegation is worth doing anyway (e.g. the local model has context " +
          "you lack, or you're deliberately testing behaviour). Requires articulating the " +
          "justification rather than flipping a flag, and every use is recorded in the ledger — " +
          "if you find yourself reaching for this routinely, the gate is telling you something " +
          "real about how you're using the tool."
      ),
    system_prompt: z
      .string()
      .optional()
      .describe(
        "Optional role/constraints/output-format instructions for the local model. " +
          "Omit for a plain assistant role."
      ),
    max_tokens: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Maximum tokens the local model may generate. Defaults to ${DEFAULT_MAX_TOKENS}.`),
    model: z
      .enum(["fast", "capable"])
      .optional()
      .describe(
        "Which local model tier to use. \"fast\" (default) is a non-reasoning model — reliably " +
          "fast and cheap for the bounded/mechanical work this tool is meant for. \"capable\" is a " +
          "larger reasoning model, meaningfully slower and more resource-hungry; only ask for it " +
          "when a task genuinely needs more depth than \"fast\" can deliver — most delegated tasks " +
          "should not need this."
      ),
  },
  async ({
    task,
    system_prompt,
    max_tokens,
    model,
    context_files,
    output_files,
    allow_overwrite,
    expected_output_lines,
    context_files_are_preexisting,
    acknowledge_small_task,
  }) => {
    const specChars = task.length + (system_prompt ? system_prompt.length : 0);
    const usesContext = Array.isArray(context_files) && context_files.length > 0;

    // Gate first — before reading context files, before calling the model. A refusal that also
    // burned local compute would be pure waste.
    if (usesContext && typeof context_files_are_preexisting !== "boolean") {
      return {
        content: [
          {
            type: "text",
            text:
              `Refusing to delegate: context_files was provided without ` +
              `context_files_are_preexisting. Declare whether those files already existed ` +
              `independently of this delegation (true) or were authored to support it (false) — ` +
              `the second case costs you the same output tokens as pasting the content into ` +
              `\`task\`, so it has to clear a higher bar to be worth doing.`,
          },
        ],
        isError: true,
      };
    }

    const freshContext = usesContext && context_files_are_preexisting === false;
    const threshold = freshContext
      ? MIN_EXPECTED_OUTPUT_LINES_FRESH_CONTEXT
      : MIN_EXPECTED_OUTPUT_LINES;

    if (expected_output_lines < threshold && !acknowledge_small_task) {
      appendLedger({
        at: Date.now(),
        outcome: "refused-gate",
        specChars,
        declaredLines: expected_output_lines,
        threshold,
        freshContext,
      });
      return {
        content: [
          {
            type: "text",
            text:
              `Refusing to delegate: expected_output_lines=${expected_output_lines} is below the ` +
              `${threshold}-line threshold` +
              (freshContext
                ? ` that applies when context_files were authored for this call (a fresh context ` +
                  `file costs you the same output tokens as pasting its content, so the artifact ` +
                  `has to be correspondingly bigger to pay for it).`
                : `.`) +
              `\n\nAcross six measured rounds, every delegation producing an artifact this small ` +
              `cost more in spec-writing than doing the work directly — between +118% and +257% ` +
              `more. Write it yourself.\n\nIf several small related asks are queued up, batching ` +
              `them into one \`task\` may clear the bar legitimately. If this specific task is a ` +
              `genuine exception, pass acknowledge_small_task with the reason.`,
          },
        ],
        isError: true,
      };
    }

    const secretHits = [
      ...findSecretLikeContent(task),
      ...(system_prompt ? findSecretLikeContent(system_prompt) : []),
    ];
    if (secretHits.length > 0) {
      return {
        content: [
          {
            type: "text",
            text:
              `Refusing to delegate: task/system_prompt looks like it contains a credential ` +
              `(${secretHits.join(", ")}). Never put actual secret values in a delegated task — ` +
              `use a placeholder and substitute the real value into the result afterward.`,
          },
        ],
        isError: true,
      };
    }

    let contextBlock = "";
    if (context_files && context_files.length > 0) {
      try {
        contextBlock = formatContextBlock(readContextFiles(context_files));
      } catch (error) {
        return {
          content: [{ type: "text", text: `Refusing to delegate: ${error.message}` }],
          isError: true,
        };
      }
    }

    const messages = [];
    if (system_prompt) {
      messages.push({ role: "system", content: system_prompt });
    }
    messages.push({ role: "user", content: contextBlock ? `${contextBlock}\n${task}` : task });

    const effectiveMaxTokens = max_tokens || DEFAULT_MAX_TOKENS;
    // A model that's currently sleeping (router mode) needs a moment to wake up before it
    // starts generating — observed ~1s in testing, well within this fixed allowance on top
    // of the normal per-token budget.
    const requestTimeoutMs = TIMEOUT_BASE_MS + effectiveMaxTokens * TIMEOUT_PER_TOKEN_MS;
    const modelAlias = model === "capable" ? CAPABLE_MODEL_ALIAS : FAST_MODEL_ALIAS;

    try {
      const response = await axios.post(
        `${LOCAL_LLM_URL}/v1/chat/completions`,
        {
          model: modelAlias,
          messages,
          max_tokens: effectiveMaxTokens,
        },
        { timeout: requestTimeoutMs }
      );

      const choice = response.data?.choices?.[0];
      const content = choice?.message?.content;
      const usage = response.data?.usage;
      if (usage) {
        console.error(
          `[usage] model=${modelAlias} prompt_tokens=${usage.prompt_tokens} completion_tokens=${usage.completion_tokens} total_tokens=${usage.total_tokens}`
        );
      }

      if (!content) {
        return {
          content: [
            {
              type: "text",
              text: `Local model (${modelAlias}) returned no content. finish_reason: ${choice?.finish_reason ?? "unknown"}`,
            },
          ],
          isError: true,
        };
      }

      // specChars (computed at the top of the handler) deliberately excludes context_files
      // content: that's read server-side for free and isn't part of what the calling model paid
      // output tokens to write.
      const ratioWarning = buildRatioWarning(specChars, content.length, MIN_SPEC_CHARS_FOR_RATIO_WARNING);

      const ledgerEntry = {
        at: Date.now(),
        outcome: "completed",
        model: modelAlias,
        specChars,
        responseChars: content.length,
        declaredLines: expected_output_lines,
        actualLines: content.split("\n").length,
        threshold,
        freshContext,
        acknowledged: acknowledge_small_task || null,
        wroteFiles: Boolean(output_files && output_files.length > 0),
      };
      const ledgerNotes = buildLedgerNotes(appendLedger(ledgerEntry), ledgerEntry);

      const suffix =
        (ratioWarning ? `\n\n[${ratioWarning}]` : "") +
        (ledgerNotes.length > 0 ? `\n\n[${ledgerNotes.join("]\n[")}]` : "");

      if (output_files && output_files.length > 0) {
        let written;
        try {
          written = writeOutputFiles(content, output_files, allow_overwrite === true);
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Nothing written: ${error.message}\n\n` +
                  `The model's response is unsaved. Re-run with a corrected output_files list, ` +
                  `or omit output_files to get the raw text back.`,
              },
            ],
            isError: true,
          };
        }
        const manifest = written
          .map((f) => `  ${f.path} (${f.bytes} bytes, ${f.lines} lines)`)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text:
                `Wrote ${written.length} file${written.length === 1 ? "" : "s"}:\n${manifest}\n\n` +
                `Content was written directly and is NOT included above — read the files to ` +
                `review them. Local-model output still needs reviewing before you rely on it.` +
                suffix,
            },
          ],
        };
      }

      return {
        content: [{ type: "text", text: `${content}${suffix}` }],
      };
    } catch (error) {
      const isConnRefused = error.code === "ECONNREFUSED";
      const isTimeout = error.code === "ECONNABORTED";
      let message;
      if (isConnRefused) {
        message =
          `Could not reach the local model at ${LOCAL_LLM_URL} (connection refused). ` +
          `Is llama-server running? (managed by the local-copilot-stack project — ` +
          `check "launchctl list | grep local-copilot-stack" and "curl ${LOCAL_LLM_URL}/health")`;
      } else if (isTimeout) {
        message = `Local model (${modelAlias}) request timed out after ${Math.round(requestTimeoutMs / 1000)}s (max_tokens=${effectiveMaxTokens}).`;
      } else {
        message = `Error calling local model: ${error.message}`;
      }
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("local-delegate MCP server running on stdio");
}
main().catch(console.error);
