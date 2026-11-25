import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";

let server;
let base;
const seen = { path: "", body: null, headers: null };

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.path = req.url;
      seen.body = raw ? JSON.parse(raw) : null;
      seen.headers = req.headers;
      if (req.url.includes("streamGenerateContent")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}}\n\n');
        res.write(
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":2,"totalTokenCount":4}}}\n\n',
        );
        res.end();
        return;
      }
      if (req.url.includes("generateContent")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "pong" }] }, finishReason: "STOP" }] } }));
        return;
      }
      res.writeHead(404).end("nope");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.UPSTREAM_BASE = base;
  process.env.DATA_DIR = "/tmp/webg-gateway-test-data";
});

after(() => new Promise((resolve) => server.close(resolve)));
after(() => {
  delete process.env.UPSTREAM_BASE;
});

test("generateContent posts a wrapped request and unwraps the response", async () => {
  const { generateContent } = await import("../src/upstream.js");
  const payload = await generateContent({
    credential: { projectId: "proj-1", userAgent: "test-ua" },
    accessToken: "token-1",
    model: "gemini-3-flash",
    request: { contents: [{ role: "user", parts: [{ text: "ping" }] }] },
  });
  assert.equal(payload.candidates[0].content.parts[0].text, "pong");
  assert.match(seen.path, /v1internal:generateContent$/);
  assert.equal(seen.body.model, "gemini-3-flash");
  assert.equal(seen.body.project, "proj-1");
  assert.equal(seen.body.userAgent, "antigravity");
  assert.equal(seen.body.requestType, "agent");
  assert.ok(seen.body.requestId.startsWith("agent-"));
  assert.deepEqual(seen.body.request.contents[0].parts, [{ text: "ping" }]);
  assert.equal(seen.headers.authorization, "Bearer token-1");
  assert.equal(seen.headers["user-agent"], "test-ua");
});

test("streamGenerateContent yields unwrapped SSE payloads", async () => {
  const { streamGenerateContent } = await import("../src/upstream.js");
  const texts = [];
  let usage = null;
  for await (const payload of streamGenerateContent({
    credential: {},
    accessToken: "token-2",
    model: "gemini-3-flash",
    request: { contents: [{ role: "user", parts: [{ text: "ping" }] }] },
  })) {
    const part = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (part) texts.push(part);
    if (payload.usageMetadata) usage = payload.usageMetadata;
  }
  assert.equal(texts.join(""), "Hello");
  assert.equal(usage.totalTokenCount, 4);
  assert.match(seen.path, /streamGenerateContent\?alt=sse$/);
  assert.equal(seen.body.request.stream ?? undefined, undefined, "stream flag must not be sent inside the request");
});
