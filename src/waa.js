// Native WAA (Web App Attestation / BotGuard) signer client.
//
// The signer is a self-contained Go binary (SpiderMonkey 152 + Firefox 152
// profile) that the container ships next to the gateway. It speaks NDJSON over
// stdin/stdout: one `ready` event on boot, then request/response messages
// correlated by `id`. Keeping the browser out of the loop is what makes the
// pggo channel cheap enough to run on a free 512MB instance.
//
//   -> {"id":1,"method":"health"}
//   <- {"id":1,"ok":true,"engine":"spidermonkey-152","workers":0}
//
//   -> {"id":2,"method":"proof.mint","params":{"cookies":"SID=...; SAPISID=...","authUser":0,
//        "g1Tier":"TIER1","model":"models/gemini-3.7-flash","prompt":"...","wireContents":[...]}}
//   <- {"id":2,"ok":true,"proof":"!...","digest":"...","poolState":"hot","headers":{...}}

import { spawn } from "node:child_process";
import fs from "node:fs";
import { config } from "./config.js";

export class WaaError extends Error {
  constructor(message, { code = "waa_error", status = 502, retryable = false } = {}) {
    super(message);
    this.name = "WaaError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const PROXY_ENV_NAMES = [
  "AISTUDIO_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
];

export class WaaSigner {
  constructor() {
    this.child = null;
    this.buffer = "";
    this.pending = new Map();
    this.seq = 0;
    this.ready = false;
    this.engine = null;
    this.lastError = null;
    this.lastReadyAt = 0;
    this.startedAt = 0;
    this.startPromise = null;
  }

  status() {
    return {
      enabled: config.waa.enabled,
      available: Boolean(this.child && this.ready),
      engine: this.engine,
      pid: this.child?.pid ?? null,
      pending: this.pending.size,
      lastError: this.lastError,
      lastReadyAt: this.lastReadyAt ? new Date(this.lastReadyAt).toISOString() : null,
      binary: config.waa.signerPath,
      binaryExists: fs.existsSync(config.waa.signerPath),
    };
  }

  /** Spawn the signer and wait for its `ready` event. Idempotent. */
  async start() {
    if (this.child && this.ready) return this;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async _start() {
    if (!config.waa.enabled) {
      throw new WaaError("WAA signer is disabled (WAA_DISABLED=1)", { code: "waa_disabled", status: 503 });
    }
    const binary = config.waa.signerPath;
    if (!fs.existsSync(binary)) {
      this.lastError = `signer binary not found at ${binary}`;
      throw new WaaError(
        `WAA signer binary not found at ${binary}. Build it with waa-signer/build.sh or use the container image.`,
        { code: "waa_missing_binary", status: 503 },
      );
    }
    fs.mkdirSync(config.waa.stateDir, { recursive: true });

    const env = { ...process.env };
    // Auto-detection would happily pick a dead 127.0.0.1:7890 left in the
    // environment of a PaaS box; strip proxies unless one was configured.
    if (!config.waa.proxy) {
      for (const name of PROXY_ENV_NAMES) delete env[name];
    }
    const args = ["-state-dir", config.waa.stateDir];
    if (config.waa.proxy) args.push("-proxy", config.waa.proxy);

    this._readyWaiters = {};
    this.child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], env });
    this.startedAt = Date.now();
    this.ready = false;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this._onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      const line = String(chunk).trim();
      if (line) console.error(`[waa-signer] ${line}`);
    });
    this.child.on("error", (error) => {
      this.lastError = error.message;
      this._failAll(new WaaError(`WAA signer failed to start: ${error.message}`, { code: "waa_spawn_failed" }));
    });
    this.child.on("exit", (code, signal) => {
      const detail = `WAA signer exited (code=${code}, signal=${signal})`;
      this.lastError = detail;
      this.ready = false;
      this.child = null;
      this._failAll(new WaaError(detail, { code: "waa_exited" }));
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop().catch(() => {});
        reject(new WaaError(`WAA signer did not become ready in ${config.waa.readyTimeoutMs}ms`, { code: "waa_ready_timeout" }));
      }, config.waa.readyTimeoutMs);
      this._readyWaiters = { resolve: () => { clearTimeout(timer); resolve(this); }, reject: (error) => { clearTimeout(timer); reject(error); } };
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this._dispatch(message);
    }
  }

  _dispatch(message) {
    if (message.event === "ready") {
      this.ready = true;
      this.engine = message.engine || "spidermonkey-152";
      this.lastReadyAt = Date.now();
      this.lastError = null;
      this._readyWaiters?.resolve?.();
      this._readyWaiters = null;
      return;
    }
    const id = message.id;
    if (id === undefined || id === null) return;
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    if (message.ok === false) {
      waiter.reject(
        new WaaError(String(message.error || "WAA signer returned an error"), { code: codeFromSignerError(message.error) }),
      );
      return;
    }
    waiter.resolve(message);
  }

  _failAll(error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this._readyWaiters?.reject?.(error);
    this._readyWaiters = null;
  }

  async request(method, params, { timeoutMs = config.waa.mintTimeoutMs } = {}) {
    await this.start();
    if (!this.child) throw new WaaError("WAA signer is not running", { code: "waa_not_running" });
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WaaError(`WAA signer ${method} timed out after ${timeoutMs}ms`, { code: "waa_timeout" }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new WaaError(`could not write to the WAA signer: ${error.message}`, { code: "waa_write_failed" }));
      }
    });
  }

  async health() {
    const response = await this.request("health", {}, { timeoutMs: 10_000 });
    return { ok: true, engine: response.engine || this.engine, workers: response.workers ?? 0 };
  }

  /**
   * Mint a fresh `!proof` bound to the request text.
   * Returns `{proof, digest, poolState, headers}`.
   */
  async mintProof({ cookies, authUser = 0, tier = "", model, prompt = "", wireContents, forceRecreate = false }) {
    const params = {
      cookies,
      authUser: Number.isFinite(Number(authUser)) ? Number(authUser) : 0,
      g1Tier: tierHeader(tier),
      model,
      prompt,
    };
    if (Array.isArray(wireContents)) params.wireContents = wireContents;
    if (forceRecreate) params.forceRecreate = true;
    const response = await this.request("proof.mint", params, { timeoutMs: config.waa.mintTimeoutMs });
    const proof = String(response.proof || "");
    if (!proof) throw new WaaError("WAA signer returned an empty proof", { code: "waa_empty_proof" });
    return {
      proof,
      digest: String(response.digest || ""),
      poolState: String(response.poolState || "unknown"),
      headers: response.headers && typeof response.headers === "object" ? response.headers : {},
    };
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.ready = false;
    this._failAll(new WaaError("WAA signer stopped", { code: "waa_stopped" }));
    try {
      child.stdin.end();
      child.kill("SIGTERM");
    } catch {}
  }
}

/**
 * Free accounts send no tier header; Plus is TIER0, Pro TIER1, Ultra TIER2.
 * Unknown values are treated as Free (no header).
 */
export function tierHeader(tier) {
  const value = String(tier || "").trim().toLowerCase();
  if (!value) return "";
  if (value === "pro" || value === "tier1") return "TIER1";
  if (value === "ultra" || value === "ultra_20x" || value === "tier2") return "TIER2";
  if (value === "plus" || value === "tier0") return "TIER0";
  return "";
}

function codeFromSignerError(message) {
  const text = String(message || "");
  if (/登录态失效|accounts\.google\.com|ServiceLogin/i.test(text)) return "waa_session_expired";
  if (/受限|restricted/i.test(text)) return "waa_account_restricted";
  return "waa_mint_failed";
}

export const waaSigner = new WaaSigner();

/** Human readable hint for an admin/chat error. */
export function explainWaaError(error) {
  const message = String(error?.message || error || "");
  if (/登录态失效|ServiceLogin|accounts\.google\.com/i.test(message)) {
    return "AI Studio Cookie 已失效：请在无痕窗口重新登录 aistudio.google.com，导出新的 Cookie。";
  }
  if (/受限|restricted/i.test(message)) {
    return "这个账号被 Google 判定受限，换一个账号或稍后再试。";
  }
  if (/not found|missing binary/i.test(message)) {
    return "容器里没有 WAA 签名二进制：用项目自带 Dockerfile 构建，或本地先跑 waa-signer/build.sh。";
  }
  return message;
}
