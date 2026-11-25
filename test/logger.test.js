import assert from "node:assert/strict";
import test from "node:test";
import { logAi, logInfo, recentLogs } from "../src/logger.js";

test("log ring keeps at most 30 entries", () => {
  for (let i = 0; i < 45; i += 1) logInfo(`entry ${i}`);
  const logs = recentLogs(100);
  assert.equal(logs.length, 30);
  assert.equal(logs[logs.length - 1].message, "entry 44");
  assert.equal(logs[0].message, "entry 15");
});

test("logAi records request lifecycle without prompt content", () => {
  logAi("request", { id: "req_test", model: "web-gemini-4-neon-low", stream: true, messages: 2 });
  logAi("response", { id: "req_test", model: "web-gemini-4-neon-low", stream: true, ms: 120 });
  logAi("done", {
    id: "req_test",
    model: "web-gemini-4-neon-low",
    stream: true,
    phase: "response",
    ms: 900,
    status: 200,
    chars: 42,
  });
  const [request, response, done] = recentLogs(3);
  assert.equal(request.message, "ai request #req_test model=web-gemini-4-neon-low stream=true messages=2");
  assert.equal(response.message, "ai response #req_test model=web-gemini-4-neon-low stream=true ms=120");
  assert.equal(done.message, "ai done #req_test model=web-gemini-4-neon-low stream=true phase=response ms=900 status=200 chars=42");
});

test("logAi exposes failure code and status", () => {
  logAi("failed", {
    id: "req_bad",
    model: "web-gemini-4-carbon-low",
    stream: false,
    phase: "request",
    ms: 30,
    status: 404,
    code: "model_not_available",
    error: "model is not available",
  });
  const entry = recentLogs(1)[0];
  assert.equal(entry.level, "error");
  assert.match(entry.message, /status=404 code=model_not_available/);
  assert.match(entry.message, /error=model is not available/);
});
