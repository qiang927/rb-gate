// ==UserScript==
// @name         Robin Gateway - AI Studio Executor
// @namespace    robin-gateway
// @version      0.2.0
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
    connected: false,
    retry: 1000,
    waaService: null,
    snapshotKey: null,
    apiKey: "",
    jobs: 0,
    lastError: "",
    lastJobAt: 0,
  };

  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const log = (...args) => console.log("[robin-executor]", ...args);

  // ------------------------------------------------------------------ panel
  const panel = {
    root: null,
    body: null,
    els: {},
    mounted: false,
  };

  function mountPanel() {
    if (panel.mounted || !document.body) return;
    const root = document.createElement("div");
    root.id = "robin-executor-panel";
    root.setAttribute(
      "style",
      [
        "position:fixed",
        "right:12px",
        "bottom:12px",
        "z-index:2147483647",
        "font:12px/1.6 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif",
        "background:#0f172a",
        "color:#e2e8f0",
        "border:1px solid #334155",
        "border-radius:10px",
        "padding:8px 10px",
        "box-shadow:0 10px 30px rgba(0,0,0,.4)",
        "min-width:210px",
        "max-width:280px",
      ].join(";"),
    );
    root.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <strong style="font-size:12px;letter-spacing:.02em">robin 执行器</strong>
        <button id="robin-exec-toggle" style="background:none;border:1px solid #334155;color:#94a3b8;border-radius:6px;font-size:11px;padding:1px 6px;cursor:pointer">－</button>
      </div>
      <div id="robin-exec-body" style="margin-top:6px;display:grid;grid-template-columns:auto 1fr;gap:2px 8px">
        <span style="color:#94a3b8">网关</span><span id="robin-exec-host" style="word-break:break-all">–</span>
        <span style="color:#94a3b8">连接</span><span id="robin-exec-conn">未连接</span>
        <span style="color:#94a3b8">WAA</span><span id="robin-exec-waa">等待页面初始化</span>
        <span style="color:#94a3b8">API Key</span><span id="robin-exec-key">未捕获</span>
        <span style="color:#94a3b8">任务</span><span id="robin-exec-jobs">0</span>
        <span style="color:#94a3b8">最新</span><span id="robin-exec-last">–</span>
      </div>
      <div id="robin-exec-err" style="color:#f87171;margin-top:4px;word-break:break-word"></div>
      <div style="margin-top:6px;display:flex;gap:6px">
        <button id="robin-exec-config" style="background:#1d4ed8;border:0;color:#fff;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer">设置网关/Token</button>
        <button id="robin-exec-reconnect" style="background:#1e293b;border:1px solid #334155;color:#cbd5e1;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer">重连</button>
      </div>
    `;
    document.body.appendChild(root);
    panel.root = root;
    panel.body = root.querySelector("#robin-exec-body");
    panel.els = {
      host: root.querySelector("#robin-exec-host"),
      conn: root.querySelector("#robin-exec-conn"),
      waa: root.querySelector("#robin-exec-waa"),
      key: root.querySelector("#robin-exec-key"),
      jobs: root.querySelector("#robin-exec-jobs"),
      last: root.querySelector("#robin-exec-last"),
      err: root.querySelector("#robin-exec-err"),
    };
    let collapsed = false;
    root.querySelector("#robin-exec-toggle").addEventListener("click", (event) => {
      collapsed = !collapsed;
      panel.body.style.display = collapsed ? "none" : "grid";
      event.currentTarget.textContent = collapsed ? "＋" : "－";
    });
    root.querySelector("#robin-exec-config").addEventListener("click", askSettings);
    root.querySelector("#robin-exec-reconnect").addEventListener("click", () => connect());
    panel.mounted = true;
    refreshPanel();
  }

  function dot(color, text) {
    return `<span style="color:${color}">${text}</span>`;
  }

  function refreshPanel() {
    if (!panel.mounted) return;
    const els = panel.els;
    els.host.textContent = state.gateway ? state.gateway.replace(/^https?:\/\//, "") : "未设置（点下面按钮）";
    els.conn.innerHTML = state.connected ? dot("#34d399", "已连接") : dot("#f87171", "未连接");
    els.waa.innerHTML = state.waaService && state.snapshotKey
      ? dot("#34d399", "就绪")
      : dot("#fbbf24", "等待中（先在页面正常发一条消息）");
    els.key.innerHTML = state.apiKey || state.connected ? dot("#34d399", state.apiKey ? "已捕获" : "用内置 key") : dot("#94a3b8", "未捕获");
    els.jobs.textContent = String(state.jobs);
    els.last.textContent = state.lastError ? "失败" : state.lastJobAt ? "成功" : "–";
    if (state.lastError) els.last.innerHTML = dot("#f87171", "失败");
    els.err.textContent = state.lastError || "";
  }

  setInterval(() => {
    if (!panel.mounted) mountPanel();
    refreshPanel();
  }, 1000);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPanel, { once: true });
  } else {
    mountPanel();
  }

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
    refreshPanel();
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
      refreshPanel();
      sendStatus();
      return true;
    }
    return false;
  }

  const hookTimer = setInterval(() => {
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
        refreshPanel();
      }
    } catch {
      /* ignore */
    }
    return origFetch.apply(this, arguments);
  };

  // ---------------------------------------------------------------- websocket
  function sendStatus() {
    if (!state.ws || state.ws.readyState !== 1) return;
    try {
      state.ws.send(
        JSON.stringify({
          type: "status",
          waa: Boolean(state.waaService && state.snapshotKey),
          hasApiKey: Boolean(state.apiKey),
          jobs: state.jobs,
          lastError: state.lastError,
        }),
      );
    } catch {
      /* ignore */
    }
  }

  function connect() {
    if (!state.gateway || !state.token) {
      refreshPanel();
      return;
    }
    try {
      state.ws?.close();
    } catch {
      /* ignore */
    }
    const base = state.gateway.replace(/^http/, "ws");
    const ws = new WebSocket(`${base}/executor/ws?token=${encodeURIComponent(state.token)}`);
    state.ws = ws;

    ws.onopen = () => {
      state.connected = true;
      state.retry = 1000;
      log("connected");
      refreshPanel();
      ws.send(JSON.stringify({ type: "ready", label: "aistudio tab", models: [] }));
      sendStatus();
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
      state.connected = false;
      refreshPanel();
      state.retry = Math.min(state.retry * 2, 30000);
      setTimeout(connect, state.retry);
    };
    ws.onerror = () => ws.close();
  }

  setInterval(sendStatus, 10000);

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
      state.jobs += 1;
      state.lastError = "";
      state.lastJobAt = Date.now();
    } catch (error) {
      state.lastError = error?.message || String(error);
      send({ type: "error", id: job.id, message: state.lastError });
    } finally {
      refreshPanel();
      sendStatus();
    }
  }

  // ------------------------------------------------------------------- boot
  if (!state.gateway || !state.token) {
    log("not configured yet: use the panel button or the Tampermonkey menu");
  } else {
    connect();
  }
})();
