#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import { readFileSync } from "fs";
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

// Resolve relOrAbsPath against contextRoot and refuse anything that escapes it (via ../, a
// sibling-directory prefix collision, or an absolute path elsewhere on disk). The `+ path.sep`
// check matters: without it, a root of "/foo/bar" would incorrectly accept "/foo/barevil".
function resolveContextPath(relOrAbsPath, contextRoot) {
  const resolved = path.resolve(contextRoot, relOrAbsPath);
  if (resolved !== contextRoot && !resolved.startsWith(contextRoot + path.sep)) {
    throw new Error(`refuses to read outside ${contextRoot}: ${relOrAbsPath}`);
  }
  return resolved;
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
    "each call pays a fixed overhead regardless of how small the ask is.",
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
  async ({ task, system_prompt, max_tokens, model, context_files }) => {
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

      // specChars deliberately excludes context_files content: that's read server-side for free
      // and isn't part of what the calling model paid output tokens to write.
      const specChars = task.length + (system_prompt ? system_prompt.length : 0);
      const ratioWarning = buildRatioWarning(specChars, content.length, MIN_SPEC_CHARS_FOR_RATIO_WARNING);

      return {
        content: [{ type: "text", text: ratioWarning ? `${content}\n\n[${ratioWarning}]` : content }],
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
