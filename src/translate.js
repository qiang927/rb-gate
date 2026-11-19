import crypto from "node:crypto";
import { isClaudeModel, maxOutputTokens as modelMaxOutput, resolveModelId } from "./models.js";

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && (part.type === "text" || typeof part.text === "string"))
      .map((part) => part.text || "")
      .join("");
  }
  return "";
}

function imagePart(imageUrl) {
  const url = typeof imageUrl === "string" ? imageUrl : imageUrl?.url;
  if (!url) return null;
  const dataMatch = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (dataMatch) {
    return { inlineData: { mimeType: dataMatch[1], data: dataMatch[2] } };
  }
  if (/^https?:\/\//i.test(url)) {
    return { fileData: { mimeType: "image/*", fileUri: url } };
  }
  return null;
}

function userParts(content) {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: "" }];
  const parts = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ text: part.text });
    } else if (part.type === "image_url") {
      const converted = imagePart(part.image_url);
      if (converted) parts.push(converted);
    } else if (part.type === "input_text" && typeof part.text === "string") {
      parts.push({ text: part.text });
    }
  }
  return parts.length ? parts : [{ text: "" }];
}

function toolDeclarations(tools) {
  if (!Array.isArray(tools)) return null;
  const declarations = [];
  for (const tool of tools) {
    if (tool?.type === "function" && tool.function?.name) {
      declarations.push({
        name: tool.function.name,
        description: tool.function.description || "",
        parameters: sanitizeSchema(tool.function.parameters || { type: "object", properties: {} }),
      });
    }
  }
  return declarations.length ? [{ functionDeclarations: declarations }] : null;
}

/**
 * Gemini/Code Assist rejects JSON-schema keywords it does not implement.
 * Keep the structural subset and let the model infer the rest.
 */
export function sanitizeSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const allowed = new Set([
    "type",
    "properties",
    "required",
    "items",
    "enum",
    "description",
    "nullable",
    "format",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "propertyOrdering",
    "anyOf",
  ]);
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 12) return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (!allowed.has(key)) continue;
      if (key === "properties" && value && typeof value === "object") {
        out.properties = {};
        for (const [prop, propSchema] of Object.entries(value)) {
          out.properties[prop] = walk(propSchema, depth + 1);
        }
      } else if (key === "items" || key === "anyOf") {
        out[key] = walk(value, depth + 1);
      } else if (key === "type" && Array.isArray(value)) {
        const types = value.filter((type) => type !== "null");
        out.type = types[0] || "string";
        if (value.includes("null")) out.nullable = true;
      } else {
        out[key] = value;
      }
    }
    if (out.type === "object" && !out.properties) out.properties = {};
    if (out.type === "array" && !out.items) out.items = { type: "string" };
    return out;
  };
  return walk(schema);
}

function generationConfig(body, model) {
  const gen = {};
  if (Number.isFinite(body.temperature)) gen.temperature = body.temperature;
  if (Number.isFinite(body.top_p)) gen.topP = body.top_p;
  if (Number.isFinite(body.top_k)) gen.topK = body.top_k;
  if (body.stop !== undefined) {
    const stops = Array.isArray(body.stop) ? body.stop : [body.stop];
    const filtered = stops.filter((s) => typeof s === "string" && s.length > 0).slice(0, 5);
    if (filtered.length) gen.stopSequences = filtered;
  }
  const requestedMax = body.max_completion_tokens ?? body.max_tokens;
  if (Number.isFinite(requestedMax) && requestedMax > 0) {
    const cap = modelMaxOutput(model);
    gen.maxOutputTokens = cap ? Math.min(requestedMax, cap) : requestedMax;
  }
  if (body.response_format?.type === "json_object") {
    gen.responseMimeType = "application/json";
  } else if (body.response_format?.type === "json_schema") {
    gen.responseMimeType = "application/json";
    const schema = body.response_format.json_schema?.schema;
    if (schema) gen.responseSchema = sanitizeSchema(schema);
  }

  const effort = body.reasoning_effort || body.reasoning?.effort;
  const thinking = body.thinking;
  if (typeof thinking?.budget_tokens === "number" && thinking.budget_tokens >= 0) {
    gen.thinkingConfig = { thinkingBudget: thinking.budget_tokens, includeThoughts: thinking.budget_tokens > 0 };
  } else if (typeof effort === "string") {
    const budgets = { minimal: 0, low: 1024, medium: 8192, high: 24576, xhigh: 32768 };
    const budget = budgets[effort.toLowerCase()];
    if (budget !== undefined) gen.thinkingConfig = { thinkingBudget: budget, includeThoughts: budget > 0 };
  }
  return gen;
}

/**
 * Convert an OpenAI Chat Completions request into the inner "request" object
 * accepted by Code Assist's v1internal:generateContent.
 */
export function buildGeminiRequest(body, { stream = false } = {}) {
  const model = resolveModelId(body.model || "gemini-3-flash");
  const messages = Array.isArray(body.messages) ? body.messages : [];

  const systemTexts = [];
  const contents = [];
  const toolNameByCallId = new Map();

  const pushContent = (role, parts) => {
    if (!parts || parts.length === 0) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
      return;
    }
    contents.push({ role, parts });
  };

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = message.role || "user";
    if (role === "system" || role === "developer") {
      const text = textOf(message.content);
      if (text) systemTexts.push(text);
      continue;
    }
    if (role === "user") {
      pushContent("user", userParts(message.content));
      continue;
    }
    if (role === "assistant") {
      const parts = [];
      const text = textOf(message.content);
      if (text) parts.push({ text });
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!call?.function?.name) continue;
          const callId = call.id || `call_${crypto.randomBytes(6).toString("hex")}`;
          toolNameByCallId.set(callId, call.function.name);
          let args = {};
          try {
            args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            args = { value: call.function.arguments };
          }
          parts.push({ functionCall: { name: call.function.name, args } });
        }
      }
      pushContent("model", parts);
      continue;
    }
    if (role === "tool" || role === "function") {
      const name = message.name || toolNameByCallId.get(message.tool_call_id) || "tool";
      const parts = [{ functionResponse: { name, response: parseToolResult(message.content) } }];
      pushContent("user", parts);
    }
  }

  if (contents.length === 0) contents.push({ role: "user", parts: [{ text: "" }] });
  // Gemini requires the conversation to start with a user turn.
  if (contents[0].role !== "user") contents.unshift({ role: "user", parts: [{ text: "Continue." }] });

  const request = {
    contents,
    ...(systemTexts.length ? { systemInstruction: { parts: [{ text: systemTexts.join("\n\n") }] } } : {}),
    generationConfig: generationConfig(body, model),
  };

  const tools = toolDeclarations(body.tools);
  if (tools) {
    request.tools = tools;
    const choice = body.tool_choice;
    let mode = "AUTO";
    if (choice === "none") mode = "NONE";
    else if (choice === "required") mode = "ANY";
    else if (choice && typeof choice === "object" && choice.type === "function") mode = "ANY";
    if (isClaudeModel(model) && mode === "AUTO") mode = "VALIDATED";
    if (mode !== "AUTO") {
      request.toolConfig = { functionCallingConfig: { mode } };
    } else if (isClaudeModel(model)) {
      request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
    }
  }

  if (!stream) request.stream = undefined;
  return { model, request, stream };
}

function parseToolResult(content) {
  const text = textOf(content);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return { result: parsed };
  } catch {
    return { result: text };
  }
}

export function mapFinishReason(reason) {
  switch (reason) {
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL":
      return "tool_calls";
    default:
      return "stop";
  }
}

/**
 * Normalize either the raw Gemini payload or the {"response": ...} wrapper
 * returned by the Code Assist v1internal endpoints.
 */
export function unwrapPayload(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.response && typeof obj.response === "object") return obj.response;
  return obj;
}

export function readCandidate(payload) {
  const candidate = payload?.candidates?.[0];
  if (!candidate) return { text: "", thought: "", toolCalls: [], finishReason: "" };
  let text = "";
  let thought = "";
  const toolCalls = [];
  for (const part of candidate.content?.parts || []) {
    if (typeof part.text === "string") {
      if (part.thought === true) thought += part.text;
      else text += part.text;
    } else if (part.functionCall?.name) {
      toolCalls.push({
        id: `call_${crypto.randomBytes(6).toString("hex")}`,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }
  return { text, thought, toolCalls, finishReason: candidate.finishReason || "" };
}

export function readUsage(payload) {
  const u = payload?.usageMetadata;
  if (!u) return null;
  return {
    prompt_tokens: u.promptTokenCount || 0,
    completion_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
    total_tokens: u.totalTokenCount || (u.promptTokenCount || 0) + (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
    cached_tokens: u.cachedContentTokenCount || 0,
    reasoning_tokens: u.thoughtsTokenCount || 0,
  };
}

export function buildOpenaiResponse({ text, reasoning, toolCalls, finishReason, usage, model }) {
  const message = { role: "assistant", content: text || null };
  if (toolCalls.length) {
    message.tool_calls = toolCalls;
    message.content = text || null;
  }
  if (reasoning) message.reasoning_content = reasoning;
  const effectiveFinish = toolCalls.length ? "tool_calls" : mapFinishReason(finishReason);
  return {
    id: `chatcmpl-${crypto.randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: effectiveFinish, logprobs: null }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function buildOpenaiChunk({ id, model, delta, finishReason, usage, created }) {
  return {
    id,
    object: "chat.completion.chunk",
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason || null,
        logprobs: null,
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

export function openaiSseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}
