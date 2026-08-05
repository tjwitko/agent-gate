#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";

const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || "http://localhost:8080";
const DEFAULT_MAX_TOKENS = 2048;
const REQUEST_TIMEOUT_MS = 120_000;

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
    const messages = [];
    if (system_prompt) {
      messages.push({ role: "system", content: system_prompt });
    }
    messages.push({ role: "user", content: task });

    try {
      const response = await axios.post(
        `${LOCAL_LLM_URL}/v1/chat/completions`,
        {
          model: "local",
          messages,
          max_tokens: max_tokens || DEFAULT_MAX_TOKENS,
        },
        { timeout: REQUEST_TIMEOUT_MS }
      );

      const choice = response.data?.choices?.[0];
      const content = choice?.message?.content;

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
        message = `Local model request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`;
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
