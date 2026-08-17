// Lets the agent loop drive a hosted Claude model without the loop knowing.
//
// The loop speaks OpenAI chat-completions: tools as {type:"function", function:{...}}, calls as
// msg.tool_calls[], results as {role:"tool", tool_call_id}, and finish_reason/usage.prompt_tokens.
// The Anthropic Messages API differs on every one of those. Rather than rewrite the loop's dozen
// call sites — and re-derive behaviour that eleven measured runs are calibrated against — this
// translates in both directions and returns the exact shape `chat()` already returns.
//
// The value of keeping the loop unchanged is that a Haiku run and a Gemma run differ in the model
// and nothing else. Any behavioural difference is the model, not the harness.
import Anthropic from "@anthropic-ai/sdk";

// Haiku 4.5 predates adaptive thinking: `effort` is rejected outright, and thinking is off unless
// explicitly budgeted. Both are deliberate omissions rather than oversights — this workload wants
// the model acting, not deliberating, and the local models it is being compared against have no
// thinking phase either.
export const DEFAULT_MODEL = "claude-haiku-4-5";
const MAX_OUTPUT_TOKENS = 64000; // Haiku 4.5's ceiling; the loop's default of 4000 is far below it

let client = null;
function getClient() {
  // Constructed lazily so a run that never reaches a hosted model doesn't require a key.
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY, or an `ant auth login` profile
  return client;
}

// OpenAI wraps every tool in {type:"function", function:{name, description, parameters}};
// Anthropic takes {name, description, input_schema} flat.
function toAnthropicTools(tools) {
  return (tools || []).map((t) => {
    const fn = t.function || t;
    return {
      name: fn.name,
      description: fn.description || "",
      input_schema: fn.parameters || { type: "object", properties: {} },
    };
  });
}

// An assistant turn that called tools carries the calls as content blocks, not a sibling field.
function assistantContent(msg) {
  const blocks = [];
  const text = (msg.content || "").trim();
  if (text) blocks.push({ type: "text", text });
  for (const call of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(call.function?.arguments || "{}");
    } catch {
      // The loop already handles malformed arguments by telling the model. Sending {} keeps the
      // tool_use/tool_result pairing intact, which the API requires — dropping the block would
      // orphan the result that follows and 400 the whole request.
      input = {};
    }
    blocks.push({ type: "tool_use", id: call.id, name: call.function?.name, input });
  }
  // An assistant message with no blocks at all is rejected. That happens when a turn produced
  // only whitespace, which the truncation-recovery path can leave behind.
  return blocks.length ? blocks : [{ type: "text", text: "(no content)" }];
}

/**
 * Splits the OpenAI-shaped history into Anthropic's (system, messages) pair.
 *
 * Two structural differences drive everything here: `system` is a top-level parameter rather than
 * a message role, and tool results are user-turn content blocks rather than a `tool` role.
 * Consecutive tool results are merged into one user message because the API expects every result
 * for a given assistant turn to arrive together.
 */
export function toAnthropicMessages(messages) {
  const systemParts = [];
  const out = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : "";
      if (text.trim()) systemParts.push(text);
      continue;
    }

    if (msg.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: String(msg.content ?? "").slice(0, 200000) || "(empty)",
      };
      const prev = out[out.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content) && prev.content.every((b) => b.type === "tool_result")) {
        prev.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (msg.role === "assistant") {
      out.push({ role: "assistant", content: assistantContent(msg) });
      continue;
    }

    const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    out.push({ role: "user", content: [{ type: "text", text: text || "(empty)" }] });
  }

  return { system: systemParts.join("\n\n"), messages: out };
}

// The loop branches on finish_reason in four places; map onto the vocabulary it already knows so
// none of that logic has to change. `refusal` has no OpenAI equivalent and is passed through
// verbatim — it must not be silently laundered into a normal stop.
function toFinishReason(stopReason) {
  switch (stopReason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "end_turn":
    case "stop_sequence":
      return "stop";
    default:
      return stopReason || "stop";
  }
}

function toOpenAiResponse(message) {
  const textBlocks = message.content.filter((b) => b.type === "text");
  const toolBlocks = message.content.filter((b) => b.type === "tool_use");

  const msg = { role: "assistant", content: textBlocks.map((b) => b.text).join("\n") };
  if (toolBlocks.length) {
    msg.tool_calls = toolBlocks.map((b) => ({
      id: b.id,
      type: "function",
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));
  }

  const u = message.usage || {};
  // The loop logs prompt_tokens as its context-growth signal, so cached tokens have to be counted
  // in — they are part of the prompt the model saw, whatever they cost. The cache fields are
  // reported separately for the run report.
  const promptTokens =
    (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);

  return {
    choices: [{ message: msg, finish_reason: toFinishReason(message.stop_reason) }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: u.output_tokens || 0,
      total_tokens: promptTokens + (u.output_tokens || 0),
      cache_read_input_tokens: u.cache_read_input_tokens || 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    },
    stop_details: message.stop_details || null,
  };
}

/**
 * Places cache breakpoints. Two, both at stability boundaries:
 *
 *  1. the end of `system` — which caches the tool definitions too, since render order is
 *     tools → system → messages, and neither changes after startup;
 *  2. the last content block of the most recent turn, so each request reads the prefix the
 *     previous one wrote and only pays full price for what it added.
 *
 * Below ~4096 tokens Haiku 4.5 silently declines to cache, so early turns cost full price. That is
 * fine and needs no special case: early turns are small, and the entry appears once the
 * conversation is large enough to be worth caching.
 */
function applyCaching(system, messages) {
  const systemBlocks = system
    ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
    : undefined;

  const last = messages[messages.length - 1];
  if (last && Array.isArray(last.content) && last.content.length) {
    const block = last.content[last.content.length - 1];
    // Only text and tool_result blocks take cache_control; a trailing tool_use would throw.
    if (block.type === "text" || block.type === "tool_result") {
      block.cache_control = { type: "ephemeral" };
    }
  }

  return { systemBlocks, messages };
}

/**
 * Drop-in replacement for the loop's `chat()`. Same arguments, same returned shape.
 */
export async function chatAnthropic(model, messages, tools, maxTokens) {
  const converted = toAnthropicMessages(messages);
  const { systemBlocks } = applyCaching(converted.system, converted.messages);

  const request = {
    model: model || DEFAULT_MODEL,
    max_tokens: Math.min(maxTokens || 4000, MAX_OUTPUT_TOKENS),
    messages: converted.messages,
    tools: toAnthropicTools(tools),
  };
  if (systemBlocks) request.system = systemBlocks;

  const message = await getClient().messages.create(request);
  return toOpenAiResponse(message);
}
