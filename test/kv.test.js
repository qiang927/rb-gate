import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.CF_ACCOUNT_ID = "acc_test";
process.env.CF_KV_NAMESPACE_ID = "ns_test";
process.env.CF_KV_API_TOKEN = "token_test";
process.env.CF_KV_BASE_URL = "http://127.0.0.1:18901";

const kvStore = new Map();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const match = url.pathname.match(/\/storage\/kv\/namespaces\/ns_test\/values\/(.+)$/);
  if (!match) {
    res.writeHead(404);
    return res.end("no");
  }
  const key = decodeURIComponent(match[1]);
  if (req.method === "GET") {
    if (!kvStore.has(key)) {
      res.writeHead(404);
      return res.end("missing");
    }
    res.writeHead(200);
    return res.end(kvStore.get(key));
  }
  if (req.method === "PUT") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      kvStore.set(key, body);
      res.writeHead(200);
      res.end("ok");
    });
    return;
  }
  if (req.method === "DELETE") {
    kvStore.delete(key);
    res.writeHead(200);
    return res.end("ok");
  }
  res.writeHead(405);
  res.end();
});

test.before(async () => {
  await new Promise((resolve) => server.listen(18901, "127.0.0.1", resolve));
});
test.after(() => server.close());

test("kvConfigured requires the three credentials", async () => {
  const { kvConfigured } = await import("../src/kv.js");
  assert.equal(kvConfigured(), true);
});

test("put/get/delete round trip", async () => {
  const { kvPut, kvGet, kvDelete } = await import("../src/kv.js");
  await kvPut("webg-gateway/test", JSON.stringify({ a: 1 }));
  assert.equal(await kvGet("webg-gateway/test"), JSON.stringify({ a: 1 }));
  await kvDelete("webg-gateway/test");
  assert.equal(await kvGet("webg-gateway/test"), null);
});

test("get returns null for a missing key", async () => {
  const { kvGet } = await import("../src/kv.js");
  assert.equal(await kvGet("webg-gateway/nope"), null);
});
