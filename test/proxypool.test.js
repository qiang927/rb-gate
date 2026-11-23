import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMihomoConfig,
  filterRemovedNodes,
  isInfoNode,
  parseClashConfig,
  shouldAutoStart,
} from "../src/proxypool.js";

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

test("filterRemovedNodes keeps the rest of the default group", () => {
  const { proxies } = parseClashConfig(SAMPLE);
  const kept = filterRemovedNodes(proxies, ["node-a"]);
  assert.deepEqual(kept.map((node) => node.name), ["node-b"]);
  assert.deepEqual(filterRemovedNodes(proxies, []), proxies);
  assert.deepEqual(filterRemovedNodes(proxies, undefined).length, 2);
});

test("shouldAutoStart respects an explicit stop and legacy settings", () => {
  assert.equal(shouldAutoStart({ proxySubscription: "https://example.com/sub" }), true);
  assert.equal(shouldAutoStart({ proxySubscription: "https://example.com/sub", proxyEnabled: true }), true);
  assert.equal(shouldAutoStart({ proxySubscription: "https://example.com/sub", proxyEnabled: false }), false);
  assert.equal(shouldAutoStart({ proxySubscription: "", proxyEnabled: true }), false);
  assert.equal(shouldAutoStart(null), false);
});

test("info nodes are dropped from subscriptions", () => {
  assert.equal(isInfoNode("剩余流量 12GB"), true);
  assert.equal(isInfoNode("官网 t.me/example"), true);
  assert.equal(isInfoNode("06-07 06:56:37 | 科技共享 EDT 导航"), true);
  assert.equal(isInfoNode("CF 移动优选 | 104.17.50.245"), false);
  const parsed = parseClashConfig(`proxies:
  - { name: "剩余流量 12GB", type: ss, server: info.example.com, port: 1 }
  - { name: "CF 移动优选", type: ss, server: 1.2.3.4, port: 443 }
`);
  assert.equal(parsed.nodes.length, 1);
  assert.equal(parsed.nodes[0].name, "CF 移动优选");
});
