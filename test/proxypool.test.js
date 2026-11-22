import test from "node:test";
import assert from "node:assert/strict";
import { buildMihomoConfig, parseClashConfig } from "../src/proxypool.js";

const SAMPLE = `
port: 7890
proxies:
  - name: "node-a"
    type: ss
    server: 1.2.3.4
    port: 443
    cipher: aes-128-gcm
    password: secret
  - name: "node-b"
    type: vmess
    server: 5.6.7.8
    port: 443
    uuid: 00000000-0000-0000-0000-000000000000
  - name: incomplete
    type: ss
proxy-groups:
  - {name: PROXY, type: select, proxies: ["node-a", "node-b"]}
`;

test("parseClashConfig extracts usable nodes", () => {
  const { nodes, proxies } = parseClashConfig(SAMPLE);
  assert.deepEqual(nodes.map((node) => node.name), ["node-a", "node-b"]);
  assert.equal(proxies.length, 2);
});

test("parseClashConfig rejects non-clash payloads", () => {
  assert.throws(() => {
    const { nodes } = parseClashConfig("hello: world");
    if (!nodes.length) throw new Error("no nodes");
  });
});

test("buildMihomoConfig wires a selector group and match rule", () => {
  const { proxies } = parseClashConfig(SAMPLE);
  const cfg = buildMihomoConfig(proxies, { port: 7891, controllerPort: 9090, secret: "s" });
  assert.equal(cfg["mixed-port"], 7891);
  assert.equal(cfg["external-controller"], "127.0.0.1:9090");
  assert.equal(cfg.secret, "s");
  assert.deepEqual(cfg["proxy-groups"][0].proxies, ["node-a", "node-b"]);
  assert.deepEqual(cfg.rules, ["MATCH,POOL"]);
});
