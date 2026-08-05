#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";

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
sanitizeEnv(["PATH", "HOME", "LOCAL_LLM_URL"]);

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

const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || "http://localhost:8080";
const DEFAULT_MAX_TOKENS = 2048;
// Observed throughput on this hardware is ~17.5 tok/s in the normal case, i.e. ~57ms/token —
// budget generously above that (150ms/token) plus fixed overhead for connection/prompt processing,
// since a fixed timeout independent of max_tokens was cutting off legitimately-still-running generations.
const TIMEOUT_BASE_MS = 30_000;
const TIMEOUT_PER_TOKEN_MS = 150;

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
    "review the returned output before relying on it; it can be wrong.",
  {
    task: z
      .string()
      .describe(
        "A fully self-contained description of the work to do, including all relevant context " +
          "(code, schema, examples, constraints). The local model cannot see this conversation " +
          "and cannot ask follow-up questions."
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
  },
  async ({ task, system_prompt, max_tokens }) => {
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

    const messages = [];
    if (system_prompt) {
      messages.push({ role: "system", content: system_prompt });
    }
    messages.push({ role: "user", content: task });

    const effectiveMaxTokens = max_tokens || DEFAULT_MAX_TOKENS;
    const requestTimeoutMs = TIMEOUT_BASE_MS + effectiveMaxTokens * TIMEOUT_PER_TOKEN_MS;

    try {
      const response = await axios.post(
        `${LOCAL_LLM_URL}/v1/chat/completions`,
        {
          model: "local",
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
          `[usage] prompt_tokens=${usage.prompt_tokens} completion_tokens=${usage.completion_tokens} total_tokens=${usage.total_tokens}`
        );
      }

      if (!content) {
        return {
          content: [
            {
              type: "text",
              text: `Local model returned no content. finish_reason: ${choice?.finish_reason ?? "unknown"}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: content }],
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
        message = `Local model request timed out after ${Math.round(requestTimeoutMs / 1000)}s (max_tokens=${effectiveMaxTokens}).`;
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
