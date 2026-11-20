import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { getEncryptionKey } from "./crypto.js";
import { FrameStream, AI_STUDIO_RPC, PUBLIC_WEB_API_KEY } from "./aistudio.js";
import { logInfo, logWarn } from "./logger.js";

/**
 * Browser executors
 * -----------------
 * A page script running on aistudio.google.com connects out to this gateway
 * over WebSocket. The gateway can then hand it AI Studio RPC jobs: the page
 * owns the session cookie and the Web Attestation (BotGuard) service, so it
 * can mint the WAA proof that the request needs.
 */

const clients = new Set();
let wss = null;

export function executorToken() {
  if (config.executorToken) return config.executorToken;
  const key = getEncryptionKey(config.dataDir);
  return createHmac("sha256", key).update("robin/executor/v1").digest("hex").slice(0, 40);
}

export function executorStatus() {
  return {
    connected: clients.size,
    clients: [...clients].map((client) => ({
      id: client.id,
      label: client.label,
      models: client.models,
      connectedAt: client.connectedAt,
      lastSeenAt: client.lastSeenAt,
      busy: Boolean(client.job),
    })),
  };
}

export function hasExecutor() {
  return clients.size > 0;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function attachExecutor(server) {
  wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/executor/ws") return;
    if (!safeEqual(executorToken(), url.searchParams.get("token") || "")) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => register(ws, req));
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const client of clients) {
      if (now - client.lastSeenAt > 90_000) {
        logWarn(`executor: dropping stale client ${client.label || client.id}`);
        client.ws.terminate();
        continue;
      }
      try {
        client.ws.send(JSON.stringify({ type: "ping", t: now }));
      } catch {
        client.ws.terminate();
      }
    }
  }, 25_000);
  heartbeat.unref?.();

  return {
    close: () => {
      clearInterval(heartbeat);
      for (const client of clients) {
        try {
          client.ws.close(1001, "gateway shutting down");
        } catch {
          /* ignore */
        }
      }
      wss.close();
    },
  };
}

function register(ws, req) {
  const client = {
    id: randomUUID(),
    ws,
    label: String(req.headers["user-agent"] || "browser").slice(0, 80),
    models: [],
    connectedAt: new Date().toISOString(),
    lastSeenAt: Date.now(),
    job: null,
  };
  clients.add(client);
  logInfo(`executor: connected ${client.label} (${clients.size} total)`);

  ws.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    client.lastSeenAt = Date.now();
    handleMessage(client, message);
  });

  const cleanup = () => {
    clients.delete(client);
    if (client.job) {
      client.job.fail(new Error("executor disconnected during the request"));
      client.job = null;
    }
    logInfo(`executor: disconnected ${client.label} (${clients.size} left)`);
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);

  send(client, { type: "hello", rpc: AI_STUDIO_RPC, token: undefined });
}

function send(client, payload) {
  try {
    client.ws.send(JSON.stringify(payload));
  } catch {
    client.ws.terminate();
  }
}

function handleMessage(client, message) {
  const type = message?.type;
  if (type === "ready") {
    client.models = Array.isArray(message.models) ? message.models.map(String) : [];
    if (message.label) client.label = String(message.label).slice(0, 80);
    logInfo(`executor: thread ready ${client.label} models=${client.models.join(",") || "(page default)"}`);
    return;
  }
  if (type === "pong") return;
  if (type === "chunk") {
    const job = client.job;
    if (!job || job.id !== message.id) return;
    job.onChunk(String(message.text || ""));
    return;
  }
  if (type === "done") {
    const job = client.job;
    if (!job || job.id !== message.id) return;
    client.job = null;
    job.finish();
    return;
  }
  if (type === "error") {
    const job = client.job;
    if (!job || job.id !== message.id) return;
    client.job = null;
    job.fail(new Error(String(message.message || message.error || "executor error")));
  }
}

function pickClient() {
  const idle = [...clients];
  if (!idle.length) return null;
  idle.sort((a, b) => Number(Boolean(a.job)) - Number(Boolean(b.job)));
  return idle[0];
}

/**
 * Run one AI Studio GenerateContent call through a connected browser.
 * Resolves with { text, thoughts, finishReason, usage } once the page reports
 * `done`; `onEvent` receives incremental { type: "text" | "thought" } events.
 */
export function runExecutorJob({ wire, binding, apiKey = PUBLIC_WEB_API_KEY }, { onEvent, signal, timeoutMs = 180_000 } = {}) {
  const client = pickClient();
  if (!client) {
    const error = new Error("no browser executor is connected: open the executor script on aistudio.google.com");
    error.code = "no_pggo_executor";
    throw error;
  }

  const id = randomUUID();
  const stream = new FrameStream();
  const state = { text: "", thoughts: "", finishReason: null, usage: null, done: false };

  return new Promise((resolve, reject) => {
    let settled = false;
    const jobFail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      if (client.job?.id === id) client.job = null;
      jobFail(new Error("executor request timed out"));
    }, timeoutMs);
    timer.unref?.();

    const job = {
      id,
      onChunk(raw) {
        for (const frame of stream.push(raw)) {
          if (frame.text) {
            state.text += frame.text;
            onEvent?.({ type: "text", text: frame.text });
          }
          if (frame.thoughts) {
            state.thoughts += frame.thoughts;
            onEvent?.({ type: "thought", text: frame.thoughts });
          }
          if (frame.finishReason != null) state.finishReason = frame.finishReason;
          if (frame.usage) state.usage = frame.usage;
        }
      },
      finish() {
        if (state.done) return;
        state.done = true;
        clearTimeout(timer);
        resolve({ ...state });
      },
      fail(error) {
        if (state.done) return;
        state.done = true;
        clearTimeout(timer);
        reject(error);
      },
    };
    client.job = job;

    const onAbort = () => {
      client.job = null;
      jobFail(new Error("request aborted"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });

    send(client, {
      type: "job",
      id,
      rpc: AI_STUDIO_RPC,
      apiKey,
      binding,
      wire,
    });
  });
}
