import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUBSCRIPTION = `proxies:
  - { name: "node-a", type: ss, server: 1.2.3.4, port: 443, cipher: aes-128-gcm, password: secret-a }
  - { name: "node-b", type: vmess, server: 5.6.7.8, port: 443, uuid: 00000000-0000-0000-0000-000000000000 }
  - { name: "node-c", type: trojan, server: 9.10.11.12, port: 443, password: secret-c }
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "webg-gateway-proxy-pool-"));
process.env.DATA_DIR = dataDir;
process.env.MIHOMO_PATH = fileURLToPath(new URL("./fixtures/fake-mihomo.mjs", import.meta.url));
process.env.PROXY_CONTROLLER_PORT = String(await freePort());
process.env.AUTO_FASTEST = "0";

const subscriptionServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/yaml; charset=utf-8" });
  res.end(SUBSCRIPTION);
});
await new Promise((resolve, reject) => {
  subscriptionServer.once("error", reject);
  subscriptionServer.listen(0, "127.0.0.1", resolve);
});
const subscriptionPort = subscriptionServer.address().port;
const subscriptionUrl = `http://127.0.0.1:${subscriptionPort}/subscribe`;
const host = `127.0.0.1:${subscriptionPort}`;

const { proxyPool, ProxyPool } = await import("../src/proxypool.js");
const { store } = await import("../src/store.js");

test("proxy pool keeps the default group across stop and supports deleting nodes", async (t) => {
  t.after(async () => {
    await proxyPool.stop({ persist: false }).catch(() => {});
    subscriptionServer.closeAllConnections?.();
    await new Promise((resolve) => subscriptionServer.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const imported = await proxyPool.importSubscription(subscriptionUrl);
  assert.equal(imported.running, true);
  assert.equal(imported.group, "默认分组");
  assert.deepEqual(imported.nodes, ["node-a", "node-b", "node-c"]);
  assert.equal(imported.subscriptionHost, host);
  assert.equal(imported.removed, 0);
  assert.equal(store.settings().proxyEnabled, true);
  assert.equal(store.settings().proxySubscription, subscriptionUrl);
  assert.deepEqual(store.settings().proxyNodes, imported.nodes);

  // 停止仅停止使用代理池：节点、订阅和分组都保留。
  await proxyPool.stop();
  const stopped = proxyPool.status();
  assert.equal(stopped.running, false);
  assert.equal(stopped.current, "");
  assert.deepEqual(stopped.nodes, ["node-a", "node-b", "node-c"]);
  assert.equal(stopped.hasSubscription, true);
  assert.equal(stopped.subscriptionHost, host);
  assert.equal(store.settings().proxyEnabled, false);
  assert.equal(store.settings().proxySubscription, subscriptionUrl);
  assert.deepEqual(store.settings().proxyNodes, stopped.nodes);

  // 重启进程后（新实例）仍能从设置里看到保留的分组。
  const afterRestart = new ProxyPool().status();
  assert.equal(afterRestart.running, false);
  assert.deepEqual(afterRestart.nodes, ["node-a", "node-b", "node-c"]);
  assert.equal(afterRestart.hasSubscription, true);

  // 启用不需要重新导入。
  const resumed = await proxyPool.start();
  assert.equal(resumed.running, true);
  assert.deepEqual(resumed.nodes, ["node-a", "node-b", "node-c"]);
  assert.equal(store.settings().proxyEnabled, true);

  // 运行中删除单个节点。
  const removedOne = await proxyPool.removeNode("node-b");
  assert.equal(removedOne.running, true);
  assert.deepEqual(removedOne.nodes, ["node-a", "node-c"]);
  assert.equal(removedOne.removed, 1);
  assert.deepEqual(store.settings().proxyNodes, ["node-a", "node-c"]);

  // 停止后仍可删除节点，且不会把代理池重新启动。
  await proxyPool.stop();
  const removedStopped = await proxyPool.removeNode("node-a");
  assert.equal(removedStopped.running, false);
  assert.deepEqual(removedStopped.nodes, ["node-c"]);
  assert.equal(removedStopped.removed, 2);
  assert.equal(proxyPool.running, false);

  const resumedAgain = await proxyPool.start();
  assert.equal(resumedAgain.running, true);
  assert.deepEqual(resumedAgain.nodes, ["node-c"]);

  // 删除最后一个节点：分组清空，代理池停止，但订阅 URL 仍保留。
  const cleared = await proxyPool.removeNode("node-c");
  assert.equal(cleared.running, false);
  assert.deepEqual(cleared.nodes, []);
  assert.equal(cleared.removed, 3);
  assert.equal(store.settings().proxyEnabled, false);
  assert.equal(store.settings().proxySubscription, subscriptionUrl);
  await assert.rejects(() => proxyPool.start(), /默认分组里的节点都被删除了/);
  assert.equal(proxyPool.running, false);

  // 重新导入订阅可一次恢复整个默认分组。
  const reimported = await proxyPool.importSubscription(subscriptionUrl);
  assert.equal(reimported.running, true);
  assert.deepEqual(reimported.nodes, ["node-a", "node-b", "node-c"]);
  assert.equal(reimported.removed, 0);
  assert.deepEqual(store.settings().proxyRemoved, []);

  // 一次性删除整组。
  const removedAll = await proxyPool.removeAll();
  assert.equal(removedAll.running, false);
  assert.deepEqual(removedAll.nodes, []);
  assert.equal(removedAll.removed, 3);
  assert.equal(removedAll.hasSubscription, true);
  assert.deepEqual(store.settings().proxyNodes, []);
  assert.equal(store.settings().proxyEnabled, false);
  assert.equal(store.settings().proxySubscription, subscriptionUrl);
  await assert.rejects(() => proxyPool.start(), /默认分组里的节点都被删除了/);

  // 关闭服务时的 stop({persist:false}) 不应把用户选择的“启用”状态改成停止。
  await proxyPool.importSubscription(subscriptionUrl);
  assert.equal(store.settings().proxyEnabled, true);
  await proxyPool.stop({ persist: false });
  assert.equal(proxyPool.running, false);
  assert.equal(store.settings().proxyEnabled, true);
  assert.deepEqual(proxyPool.status().nodes, ["node-a", "node-b", "node-c"]);
});
