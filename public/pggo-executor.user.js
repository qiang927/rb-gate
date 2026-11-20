// ==UserScript==
// @name         Robin Gateway - AI Studio Executor
// @namespace    robin-gateway
// @version      0.1.0
// @description  把已登录的 AI Studio 页面接入 robin-gateway，为 pggo-* 模型提供 WAA 证明与真实会话
// @match        https://aistudio.google.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  "use strict";

  const PUBKEY = "AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs";
  const RPC_SUFFIX = "MakerSuiteService/GenerateContent";
  const state = {
    gateway: GM_getValue("gateway", ""),
    token: GM_getValue("token", ""),
    ws: null,
    retry: 1000,
    waaService: null,
    snapshotKey: null,
    apiKey: "",
    headers: null,
    busy: false,
  };

  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const log = (...args) => console.log("[robin-executor]", ...args);

  // ---------------------------------------------------------------- settings
  function askSettings() {
    const gateway = prompt("robin-gateway 地址，例如 https://robin-gateway.onrender.com", state.gateway || "");
    if (!gateway) return;
    const token = prompt("执行器 Token（管理面板 -> 执行器 里复制）", state.token || "");
    if (!token) return;
    state.gateway = gateway.replace(/\/+$/, "");
    state.token = token.trim();
    GM_setValue("gateway", state.gateway);
    GM_setValue("token", state.token);
    connect();
  }

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("设置网关地址 / Token", askSettings);
    GM_registerMenuCommand("重新连接", () => connect());
    GM_registerMenuCommand("测试 WAA 证明", async () => {
      try {
        const proof = await takeProof(await sha256Hex("robin test"));
        log("WAA proof ok", proof.slice(0, 16) + "…");
      } catch (error) {
        alert("WAA 失败: " + error.message);
      }
    });
  }

  // ------------------------------------------------------------------- utils
  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(String(text));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function sha1Hex(text) {
    const bytes = new TextEncoder().encode(String(text));
    const digest = await crypto.subtle.digest("SHA-1", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function cookie(name) {
    const found = document.cookie.split(";").map((pair) => pair.trim()).find((pair) => pair.startsWith(name + "="));
    return found ? decodeURIComponent(found.slice(name.length + 1)) : "";
  }

  async function authHeader() {
    const origin = "https://aistudio.google.com";
    const ts = Math.floor(Date.now() / 1000);
    const sapisid = cookie("SAPISID") || cookie("APISID");
    const secure1 = cookie("__Secure-1PAPISID") || sapisid;
    const secure3 = cookie("__Secure-3PAPISID") || sapisid;
    if (!sapisid) throw new Error("找不到 SAPISID：确定当前是已登录的 AI Studio 页面");
    const hash1 = await sha1Hex(`${ts} ${sapisid} ${origin}`);
    const hash2 = await sha1Hex(`${ts} ${secure1} ${origin}`);
    const hash3 = await sha1Hex(`${ts} ${secure3} ${origin}`);
    return `SAPISIDHASH ${ts}_${hash1} SAPISID1PHASH ${ts}_${hash2} SAPISID3PHASH ${ts}_${hash3}`;
  }

  // ------------------------------------------------------- WAA snapshot hook
  function installSnapshotHook() {
    const ms = W.default_MakerSuite;
    if (!ms) return false;
    if (state.snapshotKey && typeof ms[state.snapshotKey] === "function") return true;
    for (const key of Object.keys(ms)) {
      let fn;
      try {
        fn = ms[key];
      } catch {
        continue;
      }
      if (typeof fn !== "function") continue;
      const src = Function.prototype.toString.call(fn);
      if (!src.includes(".snapshot({") || !src.includes("content")) continue;
      const isGenerator = src.includes("yield") || fn.constructor?.name === "GeneratorFunction";
      if (isGenerator) {
        ms[key] = function* wrapped(...args) {
          if (args[0]) state.waaService = args[0];
          yield* fn.apply(this, args);
        };
      } else {
        ms[key] = function wrapped(...args) {
          if (args[0]) state.waaService = args[0];
          return fn.apply(this, args);
        };
      }
      state.snapshotKey = key;
      log("captured WAA snapshot function:", key);
      return true;
    }
    return false;
  }

  let hookTimer = setInterval(() => {
    if (installSnapshotHook()) clearInterval(hookTimer);
  }, 1500);

  async function takeProof(digest) {
    if (!installSnapshotHook() || !state.waaService) {
      throw new Error("WAA service 尚未就绪：请先在页面里正常发一条消息，或稍等几秒再试");
    }
    const ms = W.default_MakerSuite;
    const fn = ms[state.snapshotKey];
    let result = fn.call(ms, state.waaService, digest);
    if (result && typeof result.then === "function") result = await result;
    if (result && typeof result.next === "function") {
      const first = result.next();
      result = first?.value;
      if (result && typeof result.then === "function") result = await result;
    }
    const proof = typeof result === "string" ? result : result?.content || result?.proof || "";
    if (!proof || !proof.startsWith("!")) throw new Error("WAA 返回的 proof 格式不对");
    return proof;
  }

  // ------------------------------------------------------- capture api key
  const origFetch = W.fetch;
  W.fetch = function patchedFetch(input, init) {
    try {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes(RPC_SUFFIX)) {
        const headers = init?.headers || (typeof input !== "string" ? input.headers : null);
        const map = headers instanceof Headers ? Object.fromEntries(headers.entries()) : headers || {};
        for (const [key, value] of Object.entries(map)) {
          if (String(key).toLowerCase() === "x-goog-api-key" && value) state.apiKey = String(value);
        }
        state.headers = map;
      }
    } catch {
      /* ignore */
    }
    return origFetch.apply(this, arguments);
  };

  // ---------------------------------------------------------------- websocket
  function connect() {
    if (!state.gateway || !state.token) return;
    try {
      state.ws?.close();
    } catch {
      /* ignore */
    }
    const base = state.gateway.replace(/^http/, "ws");
    const ws = new WebSocket(`${base}/executor/ws?token=${encodeURIComponent(state.token)}`);
    state.ws = ws;

    ws.onopen = () => {
      state.retry = 1000;
      log("connected");
      ws.send(JSON.stringify({ type: "ready", label: "aistudio tab", models: [] }));
    };
    ws.onmessage = async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (message.type === "job") await runJob(message);
    };
    ws.onclose = () => {
      state.retry = Math.min(state.retry * 2, 30000);
      setTimeout(connect, state.retry);
    };
    ws.onerror = () => ws.close();
  }

  async function runJob(job) {
    const send = (payload) => {
      try {
        state.ws?.send(JSON.stringify(payload));
      } catch {
        /* ignore */
      }
    };
    try {
      const digest = await sha256Hex(job.binding || "");
      const proof = await takeProof(digest);
      const wire = JSON.parse(JSON.stringify(job.wire));
      wire[4] = proof;

      const headers = {
        "content-type": "application/json+protobuf",
        "x-goog-api-key": job.apiKey || state.apiKey || PUBKEY,
        "x-goog-api-client": "gl-js/7.4.0",
        "x-same-domain": "1",
        authorization: await authHeader(),
      };

      const response = await origFetch.call(W, job.rpc, {
        method: "POST",
        headers,
        body: JSON.stringify(wire),
        credentials: "include",
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        send({ type: "chunk", id: job.id, text: decoder.decode(value, { stream: true }) });
      }
      send({ type: "done", id: job.id });
    } catch (error) {
      send({ type: "error", id: job.id, message: error?.message || String(error) });
    }
  }

  // ------------------------------------------------------------------- boot
  if (!state.gateway || !state.token) {
    setTimeout(() => {
      log("not configured yet: use the Tampermonkey menu to set the gateway");
    }, 3000);
  } else {
    connect();
  }
})();
