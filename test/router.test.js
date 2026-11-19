import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DATA_DIR = "/tmp/robin-gateway-test-data";

const { classifyError } = await import("../src/router.js");

test("400-level argument errors are not retried", () => {
  assert.equal(classifyError({ status: 400, message: "INVALID_ARGUMENT" }).retry, false);
  assert.equal(classifyError({ status: 404 }).retry, false);
});

test("auth and quota errors are retried with a cooldown", () => {
  const unauthorized = classifyError({ status: 401, message: "unauthenticated" });
  assert.equal(unauthorized.retry, true);
  assert.ok(unauthorized.cooldownMs >= 60_000);

  const limited = classifyError({ status: 429, message: "RESOURCE_EXHAUSTED", retryAfterMs: 120_000 });
  assert.equal(limited.retry, true);
  assert.equal(limited.cooldownMs, 120_000);
});

test("network errors are retried with the default cooldown", () => {
  const info = classifyError(new Error("fetch failed: ECONNRESET"));
  assert.equal(info.retry, true);
  assert.ok(info.cooldownMs > 0);
});

test("server errors are retried", () => {
  assert.equal(classifyError({ status: 502 }).retry, true);
  assert.equal(classifyError({ status: 503 }).retry, true);
});
