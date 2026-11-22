import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { config } from "./config.js";
import { store } from "./store.js";
import { logInfo, logWarn } from "./logger.js";
import { setOutboundProxy } from "./proxyroute.js";

const CONTROLLER = "127.0.0.1";
const GROUP = "POOL";
const TEST_URL = "https://www.gstatic.com/generate_204";

function subscriptionUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (raw.startsWith("clash://")) {
    try {
      const inner = new URL(raw).searchParams.get("url");
      if (inner) return inner;
    } catch {
      /* fall through */
    }
  }
  return raw;
}

async function fetchText(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": "clash.meta/1.19 mihomo",
          accept: "*/*",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`订阅下载失败：HTTP ${res.status}`);
      return await res.text();
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw lastError;
}

export function parseClashConfig(text) {
  let doc = null;
  try {
    doc = YAML.parse(text);
  } catch {
    doc = null;
  }
  if (!doc || !Array.isArray(doc.proxies)) {
    // Some providers hand out a base64-encoded copy of the same YAML.
    try {
      const decoded = Buffer.from(String(text).trim(), "base64").toString("utf8");
      if (decoded.includes("proxies:")) doc = YAML.parse(decoded);
    } catch {
      /* ignore */
    }
  }
  const proxies = (Array.isArray(doc?.proxies) ? doc.proxies : []).filter(
    (item) => item && typeof item === "object" && item.name && item.type && item.server && item.port,
  );
  const nodes = proxies.map((item) => ({ name: String(item.name), type: String(item.type) }));
  return { nodes, proxies };
}

export function buildMihomoConfig(proxies, { port, controllerPort, secret }) {
  const names = proxies.map((item) => item.name);
  return {
    "mixed-port": port,
    "allow-lan": false,
    mode: "rule",
    "log-level": "warning",
    "external-controller": `${CONTROLLER}:${controllerPort}`,
    secret,
    "unified-delay": true,
    "tcp-concurrent": true,
    proxies,
    "proxy-groups": [{ name: GROUP, type: "select", proxies: names }],
    rules: [`MATCH,${GROUP}`],
  };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "订阅";
  }
}

class ProxyPool {
  constructor() {
    this.child = null;
    this.nodes = [];
    this.proxies = [];
    this.current = "";
    this.secret = "";
    this.error = "";
    this.subscription = "";
    this.startedAt = 0;
  }

  get port() {
    return config.proxyPort;
  }

  get controllerPort() {
    return config.proxyControllerPort;
  }

  get running() {
    return Boolean(this.child);
  }

  request(method, pathname, body = null) {
    return new Promise((resolve, reject) => {
      const payload = body === null ? null : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          host: CONTROLLER,
          port: this.controllerPort,
          path: pathname,
          method,
          headers: {
            authorization: `Bearer ${this.secret}`,
            ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
          },
          timeout: 8000,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let data = null;
            try {
              data = text ? JSON.parse(text) : null;
            } catch {
              data = { raw: text };
            }
            if (res.statusCode >= 400) {
              reject(new Error(`mihomo ${res.statusCode}: ${data?.message || text.slice(0, 200)}`));
              return;
            }
            resolve(data);
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("mihomo controller timeout")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async waitReady(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        await this.request("GET", "/version");
        return;
      } catch (error) {
        lastError = error;
        if (!this.child) throw new Error(this.error || "mihomo exited during startup");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error(`mihomo 启动超时：${lastError?.message || "unknown"}`);
  }

  async apply(proxies, { url = "" } = {}) {
    await this.stop();
    if (!proxies.length) throw new Error("没有可用节点");

    this.secret = crypto.randomBytes(16).toString("hex");
    const dir = path.join(config.dataDir, "proxy");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "config.yaml");
    const cfg = buildMihomoConfig(proxies, {
      port: this.port,
      controllerPort: this.controllerPort,
      secret: this.secret,
    });
    fs.writeFileSync(file, YAML.stringify(cfg), { mode: 0o600 });

    const child = spawn(config.mihomoPath, ["-d", dir, "-f", file], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.error = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const line = String(chunk).trim();
      if (line && /error|fatal|warn/i.test(line)) logWarn(`mihomo: ${line.slice(0, 300)}`);
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.error = `mihomo exited (code=${code}, signal=${signal})`;
        setOutboundProxy("");
        logWarn(this.error);
      }
    });

    try {
      await this.waitReady();
    } catch (error) {
      await this.stop();
      throw error;
    }

    this.proxies = proxies;
    this.nodes = proxies.map((node) => node.name);
    this.current = this.nodes[0];
    if (url) this.subscription = url;
    this.startedAt = Date.now();
    setOutboundProxy(`http://${CONTROLLER}:${this.port}`);
    logInfo(`proxy pool ready: ${this.nodes.length} nodes (${hostOf(this.subscription)})`);
    return this.status();
  }

  async start(inputUrl) {
    const url = subscriptionUrl(inputUrl);
    if (!url) throw new Error("缺少订阅 URL");
    const text = await fetchText(url);
    const { nodes, proxies } = parseClashConfig(text);
    if (!nodes.length) throw new Error("订阅里没有 Clash 节点（需要 proxies 列表，ss/vmess/trojan/hysteria2 等）");
    const removed = new Set(store.settings()?.proxyRemoved || []);
    const kept = proxies.filter((node) => !removed.has(node.name));
    if (!kept.length) throw new Error("所有节点都被删除了，重新导入订阅可恢复");
    return await this.apply(kept, { url });
  }

  async removeNode(name) {
    if (!this.running) throw new Error("代理池未启动");
    const target = String(name || "");
    if (!this.nodes.includes(target)) throw new Error("没有这个节点");
    const kept = this.proxies.filter((node) => node.name !== target);
    if (!kept.length) throw new Error("至少需要保留一个节点");
    const removed = new Set(store.settings()?.proxyRemoved || []);
    removed.add(target);
    store.updateSettings({ proxyRemoved: [...removed] });
    logInfo(`proxy pool: removed node ${target}`);
    return await this.apply(kept);
  }

  async testAll() {
    if (!this.running) throw new Error("代理池未启动");
    const results = new Array(this.nodes.length);
    let index = 0;
    const worker = async () => {
      while (index < this.nodes.length) {
        const slot = index;
        index += 1;
        const name = this.nodes[slot];
        try {
          const out = await this.request(
            "GET",
            `/proxies/${encodeURIComponent(name)}/delay?timeout=4000&url=${encodeURIComponent(TEST_URL)}`,
          );
          results[slot] = { name, ok: true, delay: Number(out?.delay) || 0 };
        } catch (error) {
          results[slot] = { name, ok: false, delay: null, error: error.message };
        }
      }
    };
    const workers = Array.from({ length: Math.min(8, this.nodes.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    this.nodes = [];
    this.proxies = [];
    this.current = "";
    this.error = "";
    this.startedAt = 0;
    setOutboundProxy("");
  }

  async select(name) {
    if (!this.running) throw new Error("代理池未启动");
    const target = String(name || "");
    if (!this.nodes.includes(target)) throw new Error("没有这个节点");
    await this.request("PUT", `/proxies/${encodeURIComponent(GROUP)}`, { name: target });
    this.current = target;
    return this.status();
  }

  async rotate() {
    if (!this.running || this.nodes.length < 2) return "";
    const index = Math.max(0, this.nodes.indexOf(this.current));
    const next = this.nodes[(index + 1) % this.nodes.length];
    await this.select(next);
    return next;
  }

  async testNode(name) {
    if (!this.running) throw new Error("代理池未启动");
    const target = String(name || this.current);
    const out = await this.request(
      "GET",
      `/proxies/${encodeURIComponent(target)}/delay?timeout=8000&url=${encodeURIComponent(TEST_URL)}`,
    );
    return { name: target, delay: out?.delay ?? null };
  }

  status() {
    return {
      running: this.running,
      nodes: this.nodes,
      current: this.current,
      error: this.error,
      port: this.port,
      subscriptionHost: this.subscription ? hostOf(this.subscription) : "",
      startedAt: this.startedAt,
      removed: (store.settings()?.proxyRemoved || []).length,
      binary: config.mihomoPath,
    };
  }
}

export const proxyPool = new ProxyPool();

export function isAbuseBlock(error) {
  const message = String(error?.message || "");
  return error?.code === "page_failed" && message.includes("/sorry/");
}

export async function initProxyPool() {
  const url = store.settings()?.proxySubscription || "";
  if (!url) return;
  // Give the instance a moment (slow cold start) and retry once on failure.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await proxyPool.start(url);
      return;
    } catch (error) {
      logWarn(`proxy pool failed to start (attempt ${attempt + 1}): ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
}
