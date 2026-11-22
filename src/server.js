import crypto from "node:crypto";
import path from "node:path";
import express from "express";
import { config, ensureConfigWarnings } from "./config.js";
import { importAistudio, importWebCookie, testCredential } from "./credentials.js";
import { UpstreamError } from "./google.js";
import { GoogleWebSession, WEB_MODELS, fetchWebUsage, isWebModel, probeWebCookie, probeWebModels, requiredTierForModel } from "./googleweb.js";
import { decryptString } from "./crypto.js";
import { isStudioModel, listStudioModels, lookupStudioModel, studioRequiredTier } from "./aistudio.js";
import { completeStudioChat, streamStudioChat } from "./studio.js";
import { explainWaaError, waaSigner } from "./waa.js";
import { openStream, withCredential } from "./router.js";
import { store } from "./store.js";
import {
  buildGeminiRequest,
  buildOpenaiChunk,
  buildOpenaiResponse,
  openaiSseHeaders,
  readCandidate,
  readUsage,
} from "./translate.js";
import { generateContent } from "./upstream.js";
import { logError, logInfo, logWarn, recentLogs } from "./logger.js";
import { initProxyPool, isAbuseBlock, proxyPool } from "./proxypool.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Api-Key, X-Admin-Password");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.use(express.json({ limit: "64mb" }));

if (config.logRequests) {
  app.use((req, res, next) => {
    const url = req.originalUrl || "";
    if (!url.startsWith("/v1/") && !url.startsWith("/admin/api/")) return next();
    if (url.startsWith("/admin/api/logs")) return next();
    const started = Date.now();
    res.on("finish", () => {
      logInfo(`${req.method} ${url} -> ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });
}

// ---------------------------------------------------------------------------
// OpenAI-compatible error helpers
// ---------------------------------------------------------------------------
function sendOpenaiError(res, status, message, { type = "invalid_request_error", code = null } = {}) {
  if (res.headersSent) {
    res.write(`data: ${JSON.stringify({ error: { message, type, code } })}\n\n`);
    res.end();
    return;
  }
  res.status(status).json({ error: { message, type, code, param: null } });
}

function apiKeyOf(req) {
  const auth = req.get("authorization") || "";
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const header = req.get("x-api-key");
  if (header) return header.trim();
  return typeof req.query.key === "string" ? req.query.key.trim() : "";
}

function requireApiKey(req, res, next) {
  const key = apiKeyOf(req);
  if (key && store.findApiKey(key)) {
    req.apiKey = key;
    return next();
  }
  return sendOpenaiError(res, 401, "invalid or missing API key", { type: "authentication_error", code: "invalid_api_key" });
}

// ---------------------------------------------------------------------------
// Admin sessions (signed cookie, no server-side state)
// ---------------------------------------------------------------------------
const ADMIN_COOKIE = "robin_admin";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function secret() {
  return store.sessionSecret;
}

function signSession(expires) {
  const payload = String(expires);
  const mac = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

function verifySession(value) {
  if (!value || typeof value !== "string") return false;
  const [expires, mac] = value.split(".");
  if (!expires || !mac) return false;
  const expected = crypto.createHmac("sha256", secret()).update(expires).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(expires) > Date.now();
}

function parseCookies(header) {
  const out = {};
  for (const pair of String(header || "").split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    out[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return out;
}

function requireAdmin(req, res, next) {
  const headerPassword = req.get("x-admin-password");
  if (headerPassword && store.verifyAdminPassword(headerPassword)) return next();
  const cookies = parseCookies(req.get("cookie"));
  if (verifySession(cookies[ADMIN_COOKIE])) return next();
  return sendOpenaiError(res, 401, "admin authentication required", { type: "authentication_error", code: "admin_unauthorized" });
}


let webModelsCache = null;

function webModelEntries() {
  const probed = new Map(((webModelsCache && webModelsCache.models) || []).map((item) => [item.id, item]));
  return Object.entries(WEB_MODELS).map(([id, cfg]) => {
    const hit = probed.get(id);
    return {
      id,
      display_name: cfg.label,
      object: "model",
      created: 1735689600,
      owned_by: "google-web",
      groups: ["robin"],
      metadata: {
        mode: cfg.mode,
        required_tier: requiredTierForModel(id),
        available: hit ? hit.ok : null,
        latency_ms: hit ? hit.ms : null,
        checked_at: webModelsCache ? webModelsCache.checkedAt : null,
      },
    };
  });
}

function studioModelEntries() {
  const creds = store.credentials().filter((cred) => cred.type === "aistudio" && cred.status !== "disabled");
  if (!creds.length) return [];
  const advertised = new Set();
  for (const cred of creds) for (const upstream of cred.models || []) advertised.add(String(upstream));
  return listStudioModels()
    .filter((model) => !advertised.size || advertised.has(model.upstream))
    .map((model) => ({
      id: model.id,
      display_name: model.name,
      object: "model",
      created: 1735689600,
      owned_by: "google-aistudio",
      groups: ["pggo"],
      metadata: {
        upstream: model.upstream,
        required_tier: studioRequiredTier(model.upstream),
        available: null,
      },
    }));
}

// ---------------------------------------------------------------------------
// Public endpoints
// ---------------------------------------------------------------------------
app.get("/health", (req, res) => {
  const credentials = store.listCredentials();
  res.json({
    ok: true,
    service: "robin-gateway",
    version: "0.1.0",
    credentials: {
      total: credentials.length,
      active: credentials.filter((cred) => cred.status === "active").length,
      error: credentials.filter((cred) => cred.status === "error").length,
    },
    models: webModelEntries().length + studioModelEntries().length,
  });
});

app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [...webModelEntries(), ...studioModelEntries()],
  });
});

app.get("/v1/models/:id", (req, res) => {
  const model = [...webModelEntries(), ...studioModelEntries()].find((item) => item.id === req.params.id);
  if (model) return res.json(model);
  return sendOpenaiError(res, 404, `model ${req.params.id} not found`, { code: "model_not_found" });
});

app.post("/v1/chat/completions", requireApiKey, async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendOpenaiError(res, 400, "messages must be a non-empty array", { code: "invalid_messages" });
  }
  const stream = Boolean(body.stream);
  if (isStudioModel(body.model)) return handleStudioChat(req, res, body, body.model, stream);
  if (!isWebModel(body.model)) {
    return sendOpenaiError(res, 404, `model ${body.model || "(missing)"} is not available; only web-* models are served by this deployment`, {
      code: "model_not_found",
    });
  }
  return handleWebChat(req, res, body, body.model, stream);

  const controller = new AbortController();
  res.on("close", () => controller.abort(new Error("client closed the connection")));

  let prepared;
  try {
    prepared = buildGeminiRequest(body, { stream });
  } catch (error) {
    return sendOpenaiError(res, 400, `could not translate the request: ${error.message}`, { code: "bad_request" });
  }
  const { model, request } = prepared;

  if (!stream) {
    try {
      const payload = await withCredential(({ cred, accessToken }) =>
        generateContent({ credential: cred, accessToken, model, request, signal: controller.signal }),
      );
      const candidate = readCandidate(payload);
      const response = buildOpenaiResponse({
        text: candidate.text,
        reasoning: candidate.thought,
        toolCalls: candidate.toolCalls,
        finishReason: candidate.finishReason,
        usage: readUsage(payload),
        model,
      });
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.json(response);
    } catch (error) {
      if (controller.signal.aborted) return res.end();
      const status = error instanceof UpstreamError ? error.status || 502 : 500;
      logError(`chat failed (${status}): ${error.message}`);
      return sendOpenaiError(res, status, error.message, { type: "upstream_error", code: "upstream_failed" });
    }
  }

  let opened;
  try {
    opened = await openStream({ model, request, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) return res.end();
    const status = error instanceof UpstreamError ? error.status || 502 : 500;
    logError(`chat failed (${status}): ${error.message}`);
    return sendOpenaiError(res, status, error.message, { type: "upstream_error", code: "upstream_failed" });
  }

  const { generator, first } = opened;
  const id = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, openaiSseHeaders());

  const send = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  let usage = null;
  let finishReason = "";
  let wroteAny = false;
  const seenToolCalls = new Set();

  const emitPayload = (payload) => {
    if (!payload) return;
    if (payload.usageMetadata) usage = readUsage(payload);
    const candidate = readCandidate(payload);
    const delta = {};
    if (!wroteAny) {
      delta.role = "assistant";
      wroteAny = true;
    }
    if (candidate.thought) delta.reasoning_content = candidate.thought;
    if (candidate.text) delta.content = candidate.text;
    const freshCalls = candidate.toolCalls.filter((call) => {
      const key = `${call.function.name}:${call.function.arguments}`;
      if (seenToolCalls.has(key)) return false;
      seenToolCalls.add(key);
      return true;
    });
    if (freshCalls.length) delta.tool_calls = freshCalls.map((call, index) => ({ index, ...call }));
    if (candidate.finishReason) finishReason = candidate.finishReason;
    if (delta.role || delta.content || delta.reasoning_content || delta.tool_calls) {
      send(buildOpenaiChunk({ id, model, created, delta }));
    }
  };

  try {
    if (first && !first.done) emitPayload(first.value);
    for await (const payload of generator) emitPayload(payload);
    const finalFinish = seenToolCalls.size ? "tool_calls" : mapFinish(finishReason);
    send(
      buildOpenaiChunk({
        id,
        model,
        created,
        delta: {},
        finishReason: finalFinish,
        usage: usage || undefined,
      }),
    );
    if (body.stream_options?.include_usage && usage) {
      send(buildOpenaiChunk({ id, model, created, delta: {}, finishReason: null, usage }));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    logError(`[stream] ${error.message}`);
    sendOpenaiError(res, 502, error.message, { type: "upstream_error", code: "stream_failed" });
  }
});


const webSessions = new Map();

function usageExhausted(usage) {
  if (!usage) return false;
  const now = Date.now();
  for (const window of [usage.fiveHour, usage.weekly]) {
    if (!window || typeof window.remainingPercent !== "number") continue;
    if (window.remainingPercent > 0.5) continue;
    const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
    if (!Number.isFinite(reset) || reset > now) return true;
  }
  return false;
}

function findWebCredential() {
  const creds = store.credentials().filter(
    (cred) => cred.type !== "aistudio" && (cred.webCookieEnc || cred.masterTokenEnc),
  );
  if (!creds.length) return null;
  const pool = creds.filter((cred) => cred.status !== "disabled");
  const usable = pool.length ? pool : creds;
  // Prefer credentials that still have quota left; fall back to all when every
  // one is exhausted (the upstream may still allow a little overage).
  const withQuota = usable.filter((cred) => !usageExhausted(cred.usage));
  const candidates = withQuota.length ? withQuota : usable;
  // Least-recently used first, so multiple robin credentials rotate.
  candidates.sort((a, b) => String(a.lastUsedAt || "").localeCompare(String(b.lastUsedAt || "")));
  return candidates[0];
}

const usageRefreshing = new Set();
async function refreshCredentialUsage(cred, { force = false } = {}) {
  if (!cred?.webCookieEnc && !cred?.cookieEnc) {
    const error = new Error("credential has no Gemini web cookie");
    error.code = "no_cookie";
    error.status = 400;
    throw error;
  }
  if (!force && cred.usageAt && Date.now() - Date.parse(cred.usageAt) < 5 * 60 * 1000) {
    return cred.usage || null;
  }
  if (usageRefreshing.has(cred.id)) return cred.usage || null;
  usageRefreshing.add(cred.id);
  try {
    const usage = await fetchWebUsage(webSessionFor(cred));
    store.setCredentialUsage(cred.id, usage);
    logInfo(
      `usage: ${cred.email || cred.id} fp=${usage.accountFingerprint || "-"} tier=${usage.tier.label} ` +
      `5h=${usage.fiveHour ? usage.fiveHour.remainingPercent + "%" : "?"} ` +
      `7d=${usage.weekly ? usage.weekly.remainingPercent + "%" : "?"}`,
    );
    return usage;
  } finally {
    usageRefreshing.delete(cred.id);
  }
}

function scheduleUsageRefresh(cred) {
  const stale = !cred?.usageAt || Date.now() - Date.parse(cred.usageAt) > 10 * 60 * 1000;
  if (!stale) return;
  refreshCredentialUsage(cred).catch((error) => logWarn(`usage refresh failed: ${error.message}`));
}

function webSessionFor(cred) {
  const cacheKey = `${cred.id}:${cred.updatedAt || ""}`;
  let session = webSessions.get(cacheKey);
  if (!session) {
    if (cred.webCookieEnc || cred.cookieEnc) {
      session = new GoogleWebSession({
        email: cred.email,
        cookie: decryptString(cred.webCookieEnc || cred.cookieEnc, config.dataDir),
      });
    } else {
      session = new GoogleWebSession({
        email: cred.email,
        masterToken: decryptString(cred.masterTokenEnc, config.dataDir),
        androidId: cred.androidId,
        app: config.webApp,
        clientSig: config.webSig,
      });
    }
    webSessions.set(cacheKey, session);
  }
  return session;
}

function webPrompt(messages) {
  const parts = [];
  for (const message of messages) {
    let text = "";
    if (typeof message.content === "string") text = message.content;
    else if (Array.isArray(message.content)) {
      text = message.content
        .map((part) => (typeof part === "string" ? part : part?.type === "text" ? part.text : ""))
        .filter(Boolean)
        .join("\n");
    }
    if (!text) continue;
    if (message.role === "system") parts.push("System: " + text);
    else if (message.role === "assistant") parts.push("Assistant: " + text);
    else parts.push("User: " + text);
  }
  return parts.join("\n\n");
}

async function handleWebChat(req, res, body, model, stream) {
  const cred = findWebCredential();
  if (!cred) {
    return sendOpenaiError(res, 503, "no web credential: import a robin credential (oauth_token) first", { code: "no_web_credential" });
  }
  const session = webSessionFor(cred);
  const prompt = webPrompt(Array.isArray(body.messages) ? body.messages : []);
  const temporary = Boolean(body.temporary || body.web_temporary);
  const controller = new AbortController();
  res.on("close", () => controller.abort(new Error("client closed the connection")));

  const withAbuseRetry = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      if (!isAbuseBlock(error) || proxyPool.nodes.length < 2) throw error;
      const next = await proxyPool.rotate().catch(() => "");
      if (!next) throw error;
      logWarn(`web: abuse page from Google, switched proxy node to ${next}`);
      return await fn();
    }
  };

  if (!stream) {
    try {
      const text = await withAbuseRetry(() => session.complete(prompt, { model, temporary }));
      store.markUsed(cred.id);
      store.markOk(cred.id);
      scheduleUsageRefresh(cred);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.json(buildOpenaiResponse({ text, model, toolCalls: [] }));
    } catch (error) {
      if (controller.signal.aborted) return res.end();
      const status = error.status || 502;
      store.markError(cred.id, error.message, { cooldownMs: status === 429 ? 60_000 : 0 });
      logError(`web chat failed (${status}): ${error.message}`);
      return sendOpenaiError(res, status, error.message, { type: "web_error", code: error.code || "web_failed" });
    }
  }

  // Pull the first frame before flushing SSE headers so auth/abuse failures can
  // still be answered with a normal JSON error (and retried on another node).
  let iterator = null;
  let firstStep = null;
  try {
    firstStep = await withAbuseRetry(async () => {
      const candidate = session.chat(prompt, { model, temporary })[Symbol.asyncIterator]();
      const first = await candidate.next();
      iterator = candidate;
      return first;
    });
  } catch (error) {
    if (controller.signal.aborted) return res.end();
    logError(`web chat failed (${error.status || 502}): ${error.message}`);
    return sendOpenaiError(res, error.status || 502, error.message, { type: "web_error", code: error.code || "web_failed" });
  }

  const id = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, openaiSseHeaders());
  const send = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  let wroteRole = false;
  try {
    let step = firstStep;
    while (step && !step.done) {
      if (controller.signal.aborted) break;
      const delta = step.value;
      if (!wroteRole) {
        send(buildOpenaiChunk({ id, model, created, delta: { role: "assistant" } }));
        wroteRole = true;
      }
      send(buildOpenaiChunk({ id, model, created, delta: { content: delta } }));
      step = await candidate.next();
    }
    store.markUsed(cred.id);
    store.markOk(cred.id);
    scheduleUsageRefresh(cred);
    send(buildOpenaiChunk({ id, model, created, delta: {}, finishReason: "stop" }));
    if (body.stream_options?.include_usage) {
      send(buildOpenaiChunk({ id, model, created, delta: {}, finishReason: null, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    if (!controller.signal.aborted) store.markError(cred.id, error.message, { cooldownMs: error.status === 429 ? 60_000 : 0 });
    logError(`[web stream] ${error.message}`);
    if (!res.headersSent) {
      return sendOpenaiError(res, error.status || 502, error.message, { type: "web_error", code: error.code || "web_failed" });
    }
    res.write(`data: ${JSON.stringify({ error: { message: error.message, type: "web_error" } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

function findStudioCredential() {
  const creds = store.listCredentials().filter(
    (cred) => cred.type === "aistudio" && cred.hasCookie && cred.status !== "disabled",
  );
  if (!creds.length) return null;
  creds.sort((a, b) => String(a.lastUsedAt || "").localeCompare(String(b.lastUsedAt || "")));
  return store.rawCredential(creds[0].id);
}

async function handleStudioChat(req, res, body, modelId, stream) {
  const model = lookupStudioModel(modelId);
  if (!model) return sendOpenaiError(res, 404, `model ${modelId} not found`, { code: "model_not_found" });
  const credential = findStudioCredential();
  if (!credential) {
    return sendOpenaiError(res, 503, "no pggo credential: import an aistudio.google.com cookie first", {
      code: "no_pggo_credential",
    });
  }
  let cookie;
  try {
    cookie = decryptString(credential.cookieEnc, config.dataDir);
  } catch (error) {
    return sendOpenaiError(res, 500, `could not decrypt the AI Studio cookie: ${error.message}`, {
      code: "pggo_cookie_decrypt_failed",
    });
  }
  const signer = waaSigner.status();
  if (!signer.enabled) {
    return sendOpenaiError(res, 503, "the WAA signer is disabled (WAA_DISABLED=1)", { code: "waa_disabled" });
  }
  if (!signer.binaryExists) {
    return sendOpenaiError(res, 503, "the WAA signer binary is missing; rebuild the container image", {
      code: "waa_missing_binary",
    });
  }

  const controller = new AbortController();
  res.on("close", () => controller.abort(new Error("client closed the connection")));
  const options = { cookie, model, body, signal: controller.signal, tier: credential.tier || undefined };

  if (!stream) {
    try {
      const result = await completeStudioChat(options);
      const text = String(result.text || "").trim();
      if (!text) throw new Error("AI Studio returned an empty response");
      store.markUsed(credential.id);
      store.markOk(credential.id);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.json(buildOpenaiResponse({ text, model: modelId, toolCalls: [], usage: openaiUsage(result.usage) }));
    } catch (error) {
      if (controller.signal.aborted) return res.end();
      const status = error.status || 502;
      store.markError(credential.id, error.message, { cooldownMs: status === 429 ? 60_000 : 0 });
      logError(`pggo chat failed (${status}): ${error.message}`);
      return sendOpenaiError(res, status, explainWaaError(error), {
        type: "pggo_error",
        code: error.code || "pggo_failed",
      });
    }
  }

  // Fast failures (bad cookie, missing signer) should still be JSON, but a
  // slow model must not leave the connection silent: Render closes idle
  // connections after about 100s. Wait briefly for the first frame, then flush
  // SSE headers and keep the connection alive with comments while it thinks.
  const candidate = streamStudioChat(options)[Symbol.asyncIterator]();
  const pendingFirst = candidate.next();
  const slowMarker = Symbol("slow-first-frame");
  let firstStep;
  try {
    firstStep = await Promise.race([
      pendingFirst,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(slowMarker), SSE_FIRST_FRAME_WAIT_MS);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (controller.signal.aborted) return res.end();
    logError(`pggo chat failed (${error.status || 502}): ${error.message}`);
    return sendOpenaiError(res, error.status || 502, explainWaaError(error), {
      type: "pggo_error",
      code: error.code || "pggo_failed",
    });
  }

  const id = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, openaiSseHeaders());
  const send = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  const stopHeartbeat = startSseHeartbeat(res);
  let wroteRole = false;
  let usage = null;
  const ensureRole = () => {
    if (wroteRole) return;
    send(buildOpenaiChunk({ id, model: modelId, created, delta: { role: "assistant" } }));
    wroteRole = true;
  };
  try {
    if (firstStep === slowMarker) {
      ensureRole();
      firstStep = await pendingFirst;
    }
    let step = firstStep;
    while (!step.done) {
      const frame = step.value;
      if (frame.usage) usage = frame.usage;
      if (frame.text) {
        ensureRole();
        send(buildOpenaiChunk({ id, model: modelId, created, delta: { content: frame.text } }));
      }
      if (frame.thoughts) {
        ensureRole();
        send(buildOpenaiChunk({ id, model: modelId, created, delta: { reasoning_content: frame.thoughts } }));
      }
      step = await candidate.next();
    }
    ensureRole();
    store.markUsed(credential.id);
    store.markOk(credential.id);
    send(buildOpenaiChunk({ id, model: modelId, created, delta: {}, finishReason: "stop" }));
    if (body.stream_options?.include_usage) {
      send(buildOpenaiChunk({ id, model: modelId, created, delta: {}, finishReason: null, usage: openaiUsage(usage) }));
    }
    res.write("data: [DONE]\n\n");
    res.end();
    stopHeartbeat();
  } catch (error) {
    stopHeartbeat();
    logError(`[pggo stream] ${error.message}`);
    store.markError(credential.id, error.message);
    res.write(`data: ${JSON.stringify({ error: { message: explainWaaError(error), type: "pggo_error" } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

const SSE_FIRST_FRAME_WAIT_MS = 8_000;

function startSseHeartbeat(res, intervalMs = 10_000) {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(": keep-alive\n\n");
    } catch {
      /* the socket is gone; the stream loop will notice */
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function openaiUsage(usage) {
  if (!usage) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    prompt_tokens: usage.promptTokens || 0,
    completion_tokens: usage.completionTokens || 0,
    total_tokens: usage.totalTokens || 0,
  };
}

function mapFinish(reason) {
  switch (reason) {
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
      return "content_filter";
    default:
      return "stop";
  }
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------
app.post("/admin/api/login", (req, res) => {
  const password = String(req.body?.password || "");
  if (!password || !store.verifyAdminPassword(password)) {
    return sendOpenaiError(res, 401, "wrong password", { type: "authentication_error", code: "bad_password" });
  }
  const expires = Date.now() + SESSION_TTL_MS;
  res.cookie(ADMIN_COOKIE, signSession(expires), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
  });
  res.json({ ok: true, expires });
});

app.post("/admin/api/logout", (req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.json({ ok: true });
});

app.get("/admin/api/session", (req, res) => {
  const cookies = parseCookies(req.get("cookie"));
  res.json({ authenticated: verifySession(cookies[ADMIN_COOKIE]) });
});

app.post("/admin/api/password", requireAdmin, (req, res) => {
  if (config.adminPassword) {
    return sendOpenaiError(res, 409, "ADMIN_PASSWORD is set by the environment; change it in your deployment settings", {
      type: "invalid_request_error",
      code: "admin_password_env",
    });
  }
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  if (!store.verifyAdminPassword(currentPassword)) {
    return sendOpenaiError(res, 401, "current password is wrong", { type: "authentication_error", code: "bad_password" });
  }
  if (newPassword.length < 8 || newPassword.length > 128) {
    return sendOpenaiError(res, 400, "new password must be between 8 and 128 characters", {
      type: "invalid_request_error",
      code: "weak_password",
    });
  }
  store.setAdminPassword(newPassword);
  res.json({ ok: true });
});

app.get("/admin/api/logs", requireAdmin, (req, res) => {
  res.json({ logs: recentLogs(Number(req.query.limit) || 200) });
});

app.get("/admin/api/web/models", requireAdmin, (req, res) => {
  res.json({ ok: true, ...(webModelsCache || { checkedAt: null, models: [] }) });
});

app.post("/admin/api/web/models/probe", requireAdmin, async (req, res) => {
  const cred = findWebCredential();
  if (!cred) return res.status(400).json({ ok: false, error: "还没有导入 Gemini 网页版 Cookie" });
  try {
    const session = webSessionFor(cred);
    const models = await probeWebModels(session);
    webModelsCache = { checkedAt: Date.now(), models };
    const available = models.filter((item) => item.ok).length;
    logInfo(`web models: ${available}/${models.length} presets answered`);
    store.markUsed(cred.id);
    store.markOk(cred.id);
    res.json({ ok: true, ...webModelsCache });
  } catch (error) {
    store.markError(cred.id, error.message);
    logWarn(`web models probe failed: ${error.message}`);
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.post("/admin/api/credentials/import-web-cookie", requireAdmin, async (req, res) => {
  try {
    const result = await importWebCookie({
      email: String(req.body?.email || "").trim(),
      cookie: req.body?.cookie,
      label: String(req.body?.label || "").trim(),
    });
    logInfo(`gemini web cookie imported: ${result.credential?.email || "(no email)"} (${result.probe.cookies} cookies)`);
    res.json({ ok: true, credential: result.credential, probe: result.probe });
  } catch (error) {
    logWarn(`gemini web cookie import failed: ${error.message}`);
    res.status(error.status || 400).json({ ok: false, error: error.message, code: error.code || "import_failed" });
  }
});

app.post(["/admin/api/credentials/import-aistudio", "/admin/api/credentials/import-pggo"], requireAdmin, async (req, res) => {
  try {
    const result = await importAistudio({
      email: String(req.body?.email || "").trim(),
      cookie: req.body?.cookie,
      label: String(req.body?.label || "").trim(),
    });
    logInfo(
      `AI Studio cookie imported: ${result.credential?.email || "(no email)"} ` +
        `tier=${result.account.tier} models=${result.account.models.length}`,
    );
    res.json({ ok: true, credential: result.credential, account: result.account });
  } catch (error) {
    logWarn(`AI Studio cookie import failed: ${error.message}`);
    res.status(error.status || 400).json({ ok: false, error: error.message, code: error.code || "import_failed" });
  }
});

app.post("/admin/api/web/probe", requireAdmin, async (req, res) => {
  try {
    const result = await probeWebCookie(req.body?.cookie);
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/admin/api/proxy", requireAdmin, (req, res) => {
  res.json({ ok: true, proxy: proxyPool.status() });
});

app.post("/admin/api/proxy/import", requireAdmin, async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!url) return res.status(400).json({ ok: false, error: "缺少订阅 URL" });
  try {
    store.updateSettings({ proxyRemoved: [] });
    const status = await proxyPool.start(url);
    store.updateSettings({ proxySubscription: url });
    logInfo(`proxy pool: imported ${status.nodes.length} nodes`);
    res.json({ ok: true, proxy: status });
  } catch (error) {
    logWarn(`proxy pool import failed: ${error.message}`);
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/admin/api/proxy/select", requireAdmin, async (req, res) => {
  try {
    const status = await proxyPool.select(String(req.body?.name || ""));
    res.json({ ok: true, proxy: status });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/admin/api/proxy/rotate", requireAdmin, async (req, res) => {
  try {
    const name = await proxyPool.rotate();
    res.json({ ok: true, node: name, proxy: proxyPool.status() });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/admin/api/proxy/test-all", requireAdmin, async (req, res) => {
  try {
    const results = await proxyPool.testAll();
    res.json({ ok: true, results });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/admin/api/proxy/remove", requireAdmin, async (req, res) => {
  try {
    const status = await proxyPool.removeNode(String(req.body?.name || ""));
    logInfo(`proxy pool: node removed, ${status.nodes.length} left`);
    res.json({ ok: true, proxy: status });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/admin/api/proxy/test", requireAdmin, async (req, res) => {
  try {
    const result = await proxyPool.testNode(String(req.body?.name || ""));
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/admin/api/proxy/stop", requireAdmin, async (req, res) => {
  await proxyPool.stop();
  store.updateSettings({ proxySubscription: "" });
  res.json({ ok: true, proxy: proxyPool.status() });
});

app.get("/admin/api/overview", requireAdmin, (req, res) => {
  const credentials = store.listCredentials();
  const stats = {
    credentials: credentials.length,
    active: credentials.filter((cred) => cred.status === "active").length,
    error: credentials.filter((cred) => cred.status === "error").length,
    disabled: credentials.filter((cred) => cred.status === "disabled").length,
    uses: credentials.reduce((sum, cred) => sum + (cred.uses || 0), 0),
  };
  const tiers = {};
  for (const cred of credentials) {
    const label = cred.tierLabel || (cred.tier ? cred.tier : "未知");
    tiers[label] = (tiers[label] || 0) + 1;
  }
  res.json({
    credentials,
    tiers,
    stats,
    models: [...webModelEntries(), ...studioModelEntries()],
    apiKeys: store.listApiKeys(),
    admin: { source: store.adminSource() },
    webModels: webModelsCache || { checkedAt: null, models: [] },
    settings: {
      upstreamBase: config.upstreamBase,
      requestTimeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
      cooldownMs: config.cooldownMs,
      proxy: proxyPool.status(),
      waa: waaSigner.status(),
    },
    initialPassword: store.admin().generated ? store.admin().plaintextOnce || "" : "",
  });
});

app.post("/admin/api/credentials/:id/test", requireAdmin, async (req, res) => {
  try {
    const result = await testCredential(req.params.id);
    logInfo(`credential test ok: ${req.params.id} project=${result.projectId || "-"} tier=${result.tier || "-"}`);
    res.json({ ok: true, ...result });
  } catch (error) {
    logError(`credential test failed: ${req.params.id}: ${error.message}`);
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/admin/api/usage", requireAdmin, (req, res) => {
  const credentials = store.listCredentials().map((cred) => ({
    id: cred.id,
    email: cred.email,
    label: cred.label,
    tier: cred.tier || "",
    tierLabel: cred.tierLabel || null,
    usage: cred.usage || null,
    usageAt: cred.usageAt || null,
    exhausted: usageExhausted(cred.usage),
  }));
  res.json({ ok: true, credentials });
});

app.post("/admin/api/credentials/:id/usage", requireAdmin, async (req, res) => {
  const cred = store.rawCredential(req.params.id);
  if (!cred) return res.status(404).json({ ok: false, error: "credential not found" });
  try {
    const usage = await refreshCredentialUsage(cred, { force: true });
    res.json({ ok: true, usage });
  } catch (error) {
    const status = error.status && error.status < 500 ? error.status : 502;
    logWarn(`usage fetch failed: ${req.params.id}: ${error.message}`);
    res.status(status).json({ ok: false, code: error.code || "usage_failed", error: error.message });
  }
});

app.patch("/admin/api/credentials/:id", requireAdmin, (req, res) => {
  const cred = store.rawCredential(req.params.id);
  if (!cred) return res.status(404).json({ ok: false, error: "credential not found" });
  const { label, status } = req.body || {};
  if (label !== undefined) cred.label = String(label).slice(0, 120);
  if (status !== undefined && ["active", "disabled", "error"].includes(status)) cred.status = status;
  cred.updatedAt = new Date().toISOString();
  store.persist("credentials", { credentials: store.credentials() }, { immediate: true });
  res.json({ ok: true, credential: store.listCredentials().find((c) => c.id === cred.id) });
});

app.delete("/admin/api/credentials/:id", requireAdmin, (req, res) => {
  const removed = store.deleteCredential(req.params.id);
  res.json({ ok: removed });
});

app.get("/admin/api/keys", requireAdmin, (req, res) => {
  res.json({ keys: store.listApiKeys() });
});

app.post("/admin/api/keys", requireAdmin, (req, res) => {
  try {
    const entry = store.addApiKey(String(req.body?.name || "new key").slice(0, 60));
    res.json({ ok: true, key: { ...entry, key: entry.key } });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.delete("/admin/api/keys/:id", requireAdmin, (req, res) => {
  try {
    res.json({ ok: store.removeApiKey(req.params.id) });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});


// ---------------------------------------------------------------------------
// Admin UI + static assets
// ---------------------------------------------------------------------------
app.use("/admin", express.static(path.join(config.publicDir, "admin"), { extensions: ["html"] }));
app.use("/admin", (req, res) => {
  res.sendFile(path.join(config.publicDir, "admin", "index.html"));
});
app.use(express.static(config.publicDir));

app.use((req, res) => sendOpenaiError(res, 404, `not found: ${req.method} ${req.originalUrl}`, { code: "not_found" }));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error?.type === "entity.parse.failed" ? 400 : 500;
  sendOpenaiError(res, status, error?.message || "internal error", { type: "server_error", code: "internal_error" });
});

await store.init();
void initProxyPool();

const server = app.listen(config.port, config.host, () => {
  const admin = store.admin();
  const keys = store.listApiKeys();
  const lines = [
    "",
    "  robin-gateway  (OpenAI-compatible, Code Assist upstream)",
    "  -------------------------------------------------------",
    `  listening        http://${config.host}:${config.port}`,
    `  admin console    http://${config.host}:${config.port}/admin/`,
    `  data dir         ${config.dataDir}`,
    `  credentials      ${store.listCredentials().length}`,
  ];
  if (admin.generated && admin.plaintextOnce) {
    lines.push(`  admin password   ${admin.plaintextOnce}   (generated, shown once)`);
  } else if (!config.adminPassword) {
    lines.push("  admin password   (already generated; see data/admin.json or reset ADMIN_PASSWORD)");
  }
  for (const key of keys) {
    const shown = key.source === "env" ? "(from GATEWAY_API_KEYS)" : key.key;
    lines.push(`  api key [${key.name}]  ${shown}`);
  }
  for (const warning of ensureConfigWarnings()) lines.push(`  ! ${warning}`);
  lines.push("");
  console.log(lines.join("\n"));
  logInfo(`gateway listening on port ${config.port} (credentials=${store.listCredentials().length}, dataDir=${config.dataDir})`);
  for (const warning of ensureConfigWarnings()) logWarn(`config: ${warning}`);
});


function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  try {

  } catch {
    /* ignore */
  }
  server.close(() => {
    void proxyPool.stop().catch(() => {});
    void waaSigner.stop().catch(() => {});
    void store.flush().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app, server };
