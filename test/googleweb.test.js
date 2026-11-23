import test from "node:test";
import assert from "node:assert/strict";
import { buildWebInner, parseCookieJar, resolveThinkingLevel, splitWebModelId, thinkingFromBody } from "../src/googleweb.js";

test("parseCookieJar accepts a raw request-header string", () => {
  const jar = parseCookieJar("SID=abc; __Secure-1PSID=def; HSID=ghi");
  assert.deepEqual(jar, ["SID=abc", "__Secure-1PSID=def", "HSID=ghi"]);
});

test("parseCookieJar strips attributes and the Cookie: prefix", () => {
  const jar = parseCookieJar("Cookie: SID=abc; Path=/; Domain=.google.com; Secure; SameSite=None; NID=xyz");
  assert.deepEqual(jar, ["SID=abc", "NID=xyz"]);
});

test("parseCookieJar accepts newline separated pairs and ignores junk", () => {
  const jar = parseCookieJar("SID=abc\nAPISID=def\nnonsense\n=empty\n__Secure-3PSID=ghi");
  assert.deepEqual(jar, ["SID=abc", "APISID=def", "__Secure-3PSID=ghi"]);
});

test("buildWebInner leaves inner[80] empty when the client does not ask for a level", () => {
  const inner = buildWebInner("hi", "web-gemini-4-neon");
  assert.equal(inner[79], 2);
  assert.equal(inner[80], null);
  assert.deepEqual(inner[17], [[0]]);
  assert.deepEqual(inner[41], [2]);
});

test("buildWebInner maps low/medium/high onto inner[80] 1/2/3", () => {
  for (const [level, wire] of [["low", 1], ["medium", 2], ["high", 3]]) {
    const inner = buildWebInner("hi", "web-gemini-4-carbon", { thinking: level });
    assert.equal(inner[80], wire);
    assert.equal(inner[79], 3);
    assert.deepEqual(inner[17], [[4]]);
  }
});

test("buildWebInner ignores an unknown level and keeps the preset default", () => {
  const inner = buildWebInner("hi", "web-gemini-4-hydrogen", { thinking: "deep" });
  assert.equal(inner[80], null);
  assert.deepEqual(inner[17], [[4]]);
});

test("buildWebInner falls back to Hydrogen for an unknown model id", () => {
  const inner = buildWebInner("hi", "web-gemini-3.7-flash");
  assert.equal(inner[79], 1);
  assert.deepEqual(inner[17], [[4]]);
});

test("buildWebInner keeps the temporary-chat flags in sync", () => {
  const inner = buildWebInner("hi", "web-gemini-4-auto", { temporary: true });
  assert.deepEqual(inner[41], [1]);
  assert.equal(inner[45], 1);
});

test("resolveThinkingLevel accepts the aliases clients send", () => {
  assert.equal(resolveThinkingLevel("low"), "low");
  assert.equal(resolveThinkingLevel(" HIGH "), "high");
  assert.equal(resolveThinkingLevel("minimal"), "low");
  assert.equal(resolveThinkingLevel("xhigh"), "high");
  assert.equal(resolveThinkingLevel(2), "medium");
  assert.equal(resolveThinkingLevel(4), null);
  assert.equal(resolveThinkingLevel("banana"), null);
  assert.equal(resolveThinkingLevel(undefined), null);
});

test("splitWebModelId peels the @think suffix off a model id", () => {
  assert.deepEqual(splitWebModelId("web-gemini-4-neon@think=high"), { model: "web-gemini-4-neon", thinking: "high" });
  assert.deepEqual(splitWebModelId("web-gemini-4-neon"), { model: "web-gemini-4-neon", thinking: null });
  assert.deepEqual(splitWebModelId(""), { model: "", thinking: null });
});

test("thinkingFromBody reads reasoning_effort, reasoning.effort and a token budget", () => {
  assert.equal(thinkingFromBody({ reasoning_effort: "high" }), "high");
  assert.equal(thinkingFromBody({ reasoning: { effort: "medium" } }), "medium");
  assert.equal(thinkingFromBody({ thinking: { budget_tokens: 1024 } }), "low");
  assert.equal(thinkingFromBody({ thinking: { budget_tokens: 3000 } }), "medium");
  assert.equal(thinkingFromBody({ thinking: { budget_tokens: 8192 } }), "high");
  assert.equal(thinkingFromBody({}), null);
});
