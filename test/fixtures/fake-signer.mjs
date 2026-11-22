#!/usr/bin/env node
// Minimal stand-in for waa-signer: same NDJSON protocol, fake proofs.
process.stdin.setEncoding("utf8");
let buffer = "";
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
write({ id: 0, event: "ready", ok: true, engine: "spidermonkey-152" });

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.method === "shutdown") {
      write({ id: message.id, ok: true });
      process.exit(0);
    }
    if (message.method === "health") {
      write({ id: message.id, ok: true, engine: "spidermonkey-152", workers: 0 });
      continue;
    }
    if (message.method === "proof.mint") {
      const cookies = String(message.params?.cookies || "");
      if (cookies.includes("SAPISID=bad")) {
        write({ id: message.id, ok: false, error: "初始化 SpiderMonkey WAA Worker 失败: 隔离登录态失效 url=https://accounts.google.com/ServiceLogin" });
        continue;
      }
      write({
        id: message.id,
        ok: true,
        proof: "!FAKE_PROOF",
        digest: "fake-digest",
        poolState: "hot",
        headers: { "X-Goog-Api-Key": "AIzaFAKE", Cookie: cookies, "User-Agent": "Mozilla/5.0 Firefox/152.0" },
      });
      continue;
    }
    write({ id: message.id, ok: false, error: `unknown method ${message.method}` });
  }
});
process.on("SIGTERM", () => process.exit(0));
