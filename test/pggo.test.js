import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DATA_DIR = "/tmp/robin-gateway-test-data";

const { normalizeCookie } = await import("../src/credentials.js");
const { credentialGroup } = await import("../src/store.js");
const { listModels } = await import("../src/models.js");

test("normalizeCookie keeps cookie pairs and strips attributes", () => {
  const raw = "SID=abc123; __Secure-1PSID=def456; Path=/; Domain=.google.com; Secure; HttpOnly; AEC=xyz";
  assert.equal(normalizeCookie(raw), "SID=abc123; __Secure-1PSID=def456; AEC=xyz");
});

test("normalizeCookie accepts newline separated browser export", () => {
  const raw = "SID=a\n__Secure-1PSID=b\nNID=c\n";
  assert.equal(normalizeCookie(raw), "SID=a; __Secure-1PSID=b; NID=c");
});

test("normalizeCookie strips a Cookie: prefix and empty values", () => {
  assert.equal(normalizeCookie("Cookie: SID=a; HSID=b"), "SID=a; HSID=b");
  assert.equal(normalizeCookie("   "), "");
});

test("credentialGroup maps types to channel groups", () => {
  assert.equal(credentialGroup({ type: "robin" }), "robin");
  assert.equal(credentialGroup({ type: "pggo" }), "pggo");
  assert.equal(credentialGroup({ type: "oauth" }), "agy");
  assert.equal(credentialGroup({ type: "agy" }), "agy");
  assert.equal(credentialGroup({ type: "robin", group: "pggo" }), "pggo");
  assert.equal(credentialGroup(null), "");
});

test("Code Assist models are tagged with the agy group", () => {
  const models = listModels();
  assert.ok(models.length > 0);
  assert.ok(models.every((model) => Array.isArray(model.groups) && model.groups.includes("agy")));
});
