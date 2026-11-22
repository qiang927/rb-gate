import test from "node:test";
import assert from "node:assert/strict";
import { FrameStream, buildGenerateWire, isStudioModel, listStudioModels, parseFrame } from "../src/aistudio.js";

const model = { id: "studio-gemini-4-neon", upstream: "models/gemini-4-neon", name: "flash" };

test("lists studio models with upstream ids", () => {
  const models = listStudioModels();
  assert.ok(models.length >= 4);
  for (const item of models) {
    assert.match(item.id, /^studio-/);
    assert.match(item.upstream, /^models\//);
  }
  assert.equal(isStudioModel("studio-gemini-4-neon"), true);
  assert.equal(isStudioModel("web-gemini-4-hydrogen"), false);
});

test("builds the AI Studio wire", () => {
  const { wire, binding } = buildGenerateWire(model, {
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
    max_tokens: 64,
    temperature: 0.5,
    top_p: 0.9,
    top_k: 40,
  });
  assert.equal(wire[0], "models/gemini-4-neon");
  assert.deepEqual(wire[1], [
    [[[null, "hi"]], "user"],
    [[[null, "hello"]], "model"],
  ]);
  assert.deepEqual(wire[3], [null, null, null, 64, 0.5, 0.9, 40]);
  assert.equal(wire[4], null);
  assert.deepEqual(wire[5], [[[null, "be brief"]], "user"]);
  assert.equal(binding, "hi hello");
});

test("parses a candidate frame with usage", () => {
  const parts = [
    [null, "Hel"],
    [null, "lo"],
    [null, "thinking", null, null, null, null, null, null, null, null, 1],
  ];
  const frame = [[[[parts, "model"], 1]], null, [7, 3, 10, 0, null, null, null, 0, null, 2]];
  const parsed = parseFrame(frame);
  assert.equal(parsed.text, "Hello");
  assert.equal(parsed.thoughts, "thinking");
  assert.equal(parsed.finishReason, 1);
  assert.deepEqual(parsed.usage, {
    promptTokens: 7,
    completionTokens: 3,
    totalTokens: 10,
    cachedTokens: 0,
    toolTokens: 0,
    reasoningTokens: 2,
  });
});

test("FrameStream decodes frames from a chunked response", () => {
  const parts = [[null, "Hello"], [null, " world"]];
  const frame = [[[[parts, "model"], 0]]];
  const raw = JSON.stringify([[frame], null]);
  const stream = new FrameStream();
  const frames = [];
  for (let i = 0; i < raw.length; i += 5) {
    frames.push(...stream.push(raw.slice(i, i + 5)));
  }
  assert.equal(frames.length, 1);
  assert.equal(frames[0].text, "Hello world");
});

test("FrameStream ignores a null frame list until data arrives", () => {
  const stream = new FrameStream();
  assert.deepEqual(stream.push("[null,"), []);
  assert.deepEqual(stream.push(" null]"), []);
});

test("sapisidHeader builds SAPISIDHASH and the 1P/3P variants", async () => {
  const { sapisidHeader } = await import("../src/aistudio.js");
  const header = sapisidHeader(
    "SID=a; SAPISID=b; __Secure-1PAPISID=c; __Secure-3PAPISID=d",
  );
  assert.match(header, /^SAPISIDHASH \d+_[0-9a-f]{40} SAPISID1PHASH \d+_[0-9a-f]{40} SAPISID3PHASH \d+_[0-9a-f]{40}$/);
  assert.equal(sapisidHeader("SID=a"), "");
});

test("benefit tiers and model gating map to the official headers", async () => {
  const { tierFromBenefit, studioRequiredTier } = await import("../src/aistudio.js");
  assert.deepEqual(tierFromBenefit(1), { raw: 1, label: "Pro", tier: "TIER1" });
  assert.deepEqual(tierFromBenefit(2), { raw: 2, label: "Ultra", tier: "TIER2" });
  assert.deepEqual(tierFromBenefit(3), { raw: 3, label: "Plus", tier: "TIER0" });
  assert.deepEqual(tierFromBenefit(0), { raw: 0, label: "Free", tier: "" });
  assert.equal(studioRequiredTier("models/gemini-4-carbon"), "Ultra");
  assert.equal(studioRequiredTier("models/gemini-4-neon"), "Pro");
  assert.equal(studioRequiredTier("models/gemini-3.6-flash"), "Free");
});
