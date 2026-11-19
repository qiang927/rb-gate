import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGeminiRequest, buildOpenaiResponse, readCandidate, sanitizeSchema } from "../src/translate.js";

test("maps system messages into systemInstruction", () => {
  const { request, model } = buildGeminiRequest({
    model: "gemini-3-flash",
    messages: [
      { role: "system", content: "You are terse." },
      { role: "user", content: "hello" },
    ],
  });
  assert.equal(model, "gemini-3-flash");
  assert.equal(request.systemInstruction.parts[0].text, "You are terse.");
  assert.deepEqual(request.contents, [{ role: "user", parts: [{ text: "hello" }] }]);
});

test("maps tool calls and tool results", () => {
  const { request } = buildGeminiRequest({
    model: "gemini-3-flash",
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"temp":21}' },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Look up weather",
          parameters: { type: "object", properties: { city: { type: "string", description: "city" } }, required: ["city"] },
        },
      },
    ],
  });
  const modelTurn = request.contents.find((turn) => turn.role === "model");
  assert.deepEqual(modelTurn.parts[0].functionCall, { name: "get_weather", args: { city: "Paris" } });
  const toolTurn = request.contents.at(-1);
  assert.deepEqual(toolTurn.parts[0].functionResponse, { name: "get_weather", response: { temp: 21 } });
  assert.equal(request.tools[0].functionDeclarations[0].name, "get_weather");
});

test("caps max output tokens for Claude models and clamps stop sequences", () => {
  const { request } = buildGeminiRequest({
    model: "claude-sonnet-4-6",
    max_tokens: 999_999,
    stop: ["a", "b"],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(request.generationConfig.maxOutputTokens, 64000);
  assert.deepEqual(request.generationConfig.stopSequences, ["a", "b"]);
});

test("carries json mode and reasoning effort", () => {
  const { request } = buildGeminiRequest({
    model: "gemini-3-flash",
    response_format: { type: "json_object" },
    reasoning_effort: "high",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(request.generationConfig.responseMimeType, "application/json");
  assert.equal(request.generationConfig.thinkingConfig.thinkingBudget, 24576);
  assert.equal(request.generationConfig.thinkingConfig.includeThoughts, true);
});

test("sanitizeSchema drops unsupported keywords", () => {
  const cleaned = sanitizeSchema({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: { name: { type: "string", minLength: 3 } },
    required: ["name"],
  });
  assert.equal(cleaned.$schema, undefined);
  assert.equal(cleaned.additionalProperties, undefined);
  assert.deepEqual(cleaned.properties, { name: { type: "string" } });
});

test("reads a wrapped upstream payload into an OpenAI response", () => {
  const payload = {
    response: {
      candidates: [
        {
          content: { parts: [{ text: "pong" }, { thought: true, text: "thinking" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, thoughtsTokenCount: 2, totalTokenCount: 6 },
    },
  };
  // unwrap happens before readCandidate in the pipeline
  const unwrapped = payload.response;
  const candidate = readCandidate(unwrapped);
  assert.equal(candidate.text, "pong");
  assert.equal(candidate.thought, "thinking");
  const response = buildOpenaiResponse({
    text: candidate.text,
    reasoning: candidate.thought,
    toolCalls: candidate.toolCalls,
    finishReason: candidate.finishReason,
    usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
    model: "gemini-3-flash",
  });
  assert.equal(response.choices[0].message.content, "pong");
  assert.equal(response.choices[0].message.reasoning_content, "thinking");
  assert.equal(response.choices[0].finish_reason, "stop");
});
