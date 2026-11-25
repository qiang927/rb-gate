import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "webg-store-test-"));
delete process.env.GATEWAY_API_KEYS;

const { store } = await import("../src/store.js");

test("addApiKey accepts a custom key", () => {
  const entry = store.addApiKey("laptop", "my-custom-key-123");
  assert.equal(entry.name, "laptop");
  assert.equal(entry.key, "my-custom-key-123");
  assert.equal(store.findApiKey("my-custom-key-123").id, entry.id);
});

test("addApiKey generates a key when none is supplied", () => {
  const entry = store.addApiKey("generated");
  assert.match(entry.key, /^sk-webg-gateway-[A-Za-z0-9_-]+$/);
  assert.equal(store.findApiKey(entry.key).id, entry.id);
});

test("addApiKey rejects invalid custom keys", () => {
  assert.throws(() => store.addApiKey("short", "1234567"), /8-200/);
  assert.throws(() => store.addApiKey("space", "has space here"), /ASCII/);
  assert.throws(() => store.addApiKey("newline", "line\nbreak"), /ASCII/);
  assert.throws(() => store.addApiKey("dup", "my-custom-key-123"), /已存在/);
});
