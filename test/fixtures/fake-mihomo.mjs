#!/usr/bin/env node
// Minimal stand-in for mihomo used by the proxy-pool lifecycle test.
// It reads the generated config, binds the external controller it names, and
// answers the handful of endpoints the pool talks to.
import fs from "node:fs";
import http from "node:http";
import YAML from "yaml";

const args = process.argv.slice(2);
const fileIndex = args.indexOf("-f");
const configFile = fileIndex >= 0 ? args[fileIndex + 1] : "";
if (!configFile) {
  console.error("fake-mihomo: missing -f config");
  process.exit(2);
}

const config = YAML.parse(fs.readFileSync(configFile, "utf8"));
const controller = String(config?.["external-controller"] || "");
const separator = controller.lastIndexOf(":");
const host = controller.slice(0, separator) || "127.0.0.1";
const port = Number(controller.slice(separator + 1));
if (!port) {
  console.error("fake-mihomo: bad external-controller", controller);
  process.exit(2);
}

const json = (res, body, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (req.method === "GET" && url.pathname === "/version") {
    json(res, { version: "fake-mihomo", meta: true });
    return;
  }
  if (req.method === "PUT" && url.pathname.startsWith("/proxies/")) {
    req.resume();
    req.on("end", () => json(res, { ok: true }));
    return;
  }
  if (req.method === "GET" && /^\/proxies\/[^/]+\/delay$/.test(url.pathname)) {
    json(res, { delay: 120 });
    return;
  }
  json(res, { message: `fake-mihomo: no route for ${req.method} ${url.pathname}` }, 404);
});

server.on("error", (error) => {
  console.error(`fake-mihomo: ${error.message}`);
  process.exit(1);
});
server.listen(port, host, () => {
  console.log(`fake-mihomo listening on ${host}:${port}`);
});

const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
