import crypto from "node:crypto";
import path from "node:path";
import express from "express";
import { config, ensureConfigWarnings } from "./config.js";
import { importAistudio, importWebCookie, testCredential } from "./credentials.js";
import { GoogleWebSession, WebError, fetchWebModelCatalog, fetchWebUsage, hydrateCatalog, probeWebCookie, resolveCatalogModel, serializeCatalog, splitWebModelId, thinkingFromBody } from "./googleweb.js";
import { decryptString } from "./crypto.js";
import { isStudioModel, listStudioModels, lookupStudioModel, studioRequiredTier } from "./aistudio.js";
import { completeStudioChat, streamStudioChat } from "./studio.js";
import { explainWaaError, waaSigner } from "./waa.js";
import { store } from "./store.js";
import {
  buildOpenaiChunk,
  buildOpenaiResponse,
  openaiSseHeaders,
} from "./translate.js";
import { logAi, logError, logInfo, logWarn, recentLogs } from "./logger.js";
import { beginAiRequest, endAiRequest, initProxyPool, isAbuseBlock, proxyPool } from "./proxypool.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Api-Key, X-Admin-Password");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
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
const ADMIN_COOKIE = "webg-gateway_admin";
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


const WEB_CATALOG_TTL_MS = 10 * 60 * 1000;
const webCatalogs = new Map();
let webModelsCache = null;

function webCredentialList({ includeDisabled = false } = {}) {
  return store.credentials().filter(
    (cred) =>
      cred.type !== "aistudio" &&
      (cred.webCookieEnc || cred.masterTokenEnc) &&
      (includeDisabled || cred.status !== "disabled"),
  );
}

function webCatalogKey(cred) {
  return `${cred.id}:${cred.updatedAt || ""}`;
}

/** Load (and cache) the account's real picker-derived model catalog. */
async function getWebCatalog(cred, { force = false } = {}) {
  const key = webCatalogKey(cred);
  const hit = webCatalogs.get(key);
  if (!force && hit && Date.now() - hit.fetchedAt < WEB_CATALOG_TTL_MS) return hit.catalog;
  if (!force && !hit && cred.webCatalog && cred.webCatalogAt) {
    // After a restart the in-memory map is empty; trust a recently persisted
    // catalog instead of paying a live round-trip on the first chat.
    const age = Date.now() - Date.parse(cred.webCatalogAt);
    const catalog = Number.isFinite(age) && age >= 0 && age < WEB_CATALOG_TTL_MS ? hydrateCatalog(cred.webCatalog) : null;
    if (catalog) {
      webCatalogs.set(key, { catalog, fetchedAt: Date.now() - age });
      return catalog;
    }
  }
  try {
    const catalog = await fetchWebModelCatalog(webSessionFor(cred));
    webCatalogs.set(key, { catalog, fetchedAt: Date.now() });
    const fresh = store.rawCredential(cred.id);
    if (fresh) {
      store.saveCredential({
        ...fresh,
        webCatalog: serializeCatalog(catalog),
        webCatalogAt: new Date(catalog.checkedAt).toISOString(),
      });
    }
    return catalog;
  } catch (error) {
    if (hit) {
      // Serve the previous catalog but don't hammer Google on every request.
      hit.fetchedAt = Date.now() - WEB_CATALOG_TTL_MS + 60_000;
      return hit.catalog;
    }
    if (cred.webCatalog) {
      const stale = hydrateCatalog(cred.webCatalog);
      if (stale) {
        webCatalogs.set(key, { catalog: stale, fetchedAt: Date.now() - WEB_CATALOG_TTL_MS + 60_000 });
        return stale;
      }
    }
    throw error;
  }
}

function catalogEntries(catalogs = []) {
  const entries = new Map();
  for (const catalog of catalogs) {
    for (const spec of catalog.models || []) {
      if (entries.has(spec.id)) continue;
      entries.set(spec.id, {
        id: spec.id,
        display_name: spec.label,
        object: "model",
        created: 1735689600,
        owned_by: "google-web",
        groups: ["webg-gateway"],
        metadata: {
          preset: spec.preset,
          base_model: spec.baseName,
          hash: spec.hash,
          model_number: spec.modelNumber,
          capacity: catalog.capacity,
          capacity_field: catalog.capacityField,
          required_tier: catalog.tierLabel,
          account_tier: catalog.tierLabel,
          thinking_level: spec.level?.name || null,
          thinking_levels: (spec.levels || []).map((level) => level.name),
          served_name: spec.isAuto ? "自动路由" : spec.expectedServed,
          available: true,
          checked_at: catalog.checkedAt,
        },
      });
    }
  }
  return [...entries.values()];
}

function updateWebModelsCache(entries, checkedAt) {
  if (!entries.length) return;
  webModelsCache = {
    checkedAt,
    models: entries.map((entry) => ({
      id: entry.id,
      label: entry.display_name,
      ok: true,
      ms: null,
      sample: entry.metadata.served_name,
    })),
  };
}

function cachedWebCatalogs() {
  const catalogs = [];
  for (const cred of webCredentialList()) {
    const hit = webCatalogs.get(webCatalogKey(cred));
    const catalog = hit?.catalog || (cred.webCatalog ? hydrateCatalog(cred.webCatalog) : null);
    if (catalog) catalogs.push(catalog);
  }
  return catalogs;
}

function cachedWebModelEntries() {
  const catalogs = cachedWebCatalogs();
  const entries = catalogEntries(catalogs);
  if (entries.length) updateWebModelsCache(entries, Math.max(...catalogs.map((catalog) => catalog.checkedAt || 0)));
  return entries;
}

/** Fetches every enabled web account's catalog and merges the visible models. */
async function webModelEntries({ force = false } = {}) {
  const catalogs = [];
  const creds = webCredentialList();
  const loaded = await Promise.all(
    creds.map(async (cred) => {
      try {
        return await getWebCatalog(cred, { force });
      } catch (error) {
        logWarn(`web catalog: ${cred.email || cred.id}: ${error.message}`);
        return null;
      }
    }),
  );
  for (const catalog of loaded) if (catalog) catalogs.push(catalog);
  const entries = catalogEntries(catalogs);
  if (entries.length) updateWebModelsCache(entries, Math.max(...catalogs.map((catalog) => catalog.checkedAt || 0)));
  return entries;
}

/**
 * Find a credential whose own catalog contains the requested model and
 * thinking level. Accounts with Carbon (Ultra) can serve it; Pro accounts
 * cannot, so a Carbon request falls through to 404 instead of a silent 4
 * Hydrogen answer.
 */
async function resolveWebRequest(modelId, thinking = null) {
  const creds = webCredentialList();
  if (!creds.length) {
    throw new WebError("no Gemini web credential; import a web cookie first", { status: 503, code: "no_web_credential" });
  }
  const byLastUsed = (a, b) => String(a.lastUsedAt || "").localeCompare(String(b.lastUsedAt || ""));
  const withQuota = creds.filter((cred) => !usageExhausted(cred.usage)).sort(byLastUsed);
  const exhausted = creds.filter((cred) => usageExhausted(cred.usage)).sort(byLastUsed);
  const candidates = [...withQuota, ...exhausted];
  let lastModelError = null;
  let lastCatalogError = null;
  let sawCatalog = false;
  for (const cred of candidates) {
    let catalog;
    try {
      catalog = await getWebCatalog(cred);
    } catch (error) {
      lastCatalogError = error;
      continue;
    }
    sawCatalog = true;
    try {
      const spec = resolveCatalogModel(catalog, modelId, thinking);
      return { cred, catalog, session: webSessionFor(cred), spec };
    } catch (error) {
      if (error.code === "model_not_available") {
        lastModelError = error;
        continue;
      }
      throw error;
    }
  }
  if (!sawCatalog) {
    throw lastCatalogError || new WebError("could not load the Gemini model catalog", { status: 502, code: "catalog_unavailable" });
  }
  throw lastModelError || new WebError(`model ${modelId} is not available for this account`, { status: 404, code: "model_not_available" });
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
    service: "webg-gateway",
    version: "0.1.0",
    credentials: {
      total: credentials.length,
      active: credentials.filter((cred) => cred.status === "active").length,
      error: credentials.filter((cred) => cred.status === "error").length,
    },
    models: cachedWebModelEntries().length + studioModelEntries().length,
  });
});

app.get("/v1/models", async (req, res) => {
  const cached = cachedWebModelEntries();
  const web = cached.length ? cached : await webModelEntries().catch(() => []);
  res.json({
    object: "list",
    data: [...web, ...studioModelEntries()],
  });
});

app.get("/v1/models/:id", async (req, res) => {
  const cached = cachedWebModelEntries();
  const web = cached.length ? cached : await webModelEntries().catch(() => []);
  const model = [...web, ...studioModelEntries()].find((item) => item.id === req.params.id);
  if (model) return res.json(model);
  return sendOpenaiError(res, 404, `model ${req.params.id} not found`, { code: "model_not_found" });
});

// Every chat completion counts as an in-flight AI request while it runs. The
// proxy pool uses this to postpone auto-fastest switching until the response
// is finished, so a node change cannot break a running stream.
async function withAiRequestTracking(handler, ...args) {
  beginAiRequest();
  try {
    return await handler(...args);
  } finally {
    endAiRequest();
  }
}

function rejectChatRequest(req, res, status, message, code) {
  logAi("rejected", {
    id: req.requestId,
    model: req.body?.model,
    status,
    code,
    error: message,
    phase: "validate",
  });
  return sendOpenaiError(res, status, message, { code });
}

app.post("/v1/chat/completions", requireApiKey, (req, res) => withAiRequestTracking(handleChatCompletions, req, res));

// The whole route counts as one in-flight AI request, including credential and
// model catalog resolution: those lookups also use the outbound proxy, so an
// auto-fastest switch in the middle would break the request before it starts.
async function handleChatCompletions(req, res) {
  req.requestId = `req_${crypto.randomBytes(6).toString("hex")}`;
  res.setHeader("X-Request-Id", req.requestId);
  const body = req.body || {};
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return rejectChatRequest(req, res, 400, "messages must be a non-empty array", "invalid_messages");
  }
  const stream = Boolean(body.stream);
  if (isStudioModel(body.model)) return handleStudioChat(req, res, body, body.model, stream);
  const web = splitWebModelId(body.model);
  if (!String(web.model || "").startsWith("web-")) {
    return rejectChatRequest(req, res, 404, `model ${body.model || "(missing)"} is not available`, "model_not_found");
  }
  let resolved;
  try {
    resolved = await resolveWebRequest(web.model, web.thinking || thinkingFromBody(body));
  } catch (error) {
    return rejectChatRequest(req, res, error.status || 502, error.message, error.code || "web_error");
  }
  return handleWebChat(req, res, body, resolved, stream);
}


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

async function handleWebChat(req, res, body, { cred, session, spec }, stream) {
  const model = body.model || spec.id;
  const prompt = webPrompt(Array.isArray(body.messages) ? body.messages : []);
  const temporary = Boolean(body.temporary || body.web_temporary);
  const controller = new AbortController();
  res.on("close", () => controller.abort(new Error("client closed the connection")));
  const requestId = req.requestId || "-";
  const startedAt = Date.now();
  let firstAt = null;
  let chars = 0;

  const markStart = () => {
    if (firstAt !== null) return;
    firstAt = Date.now();
    logAi("response", { id: requestId, model, stream, ms: firstAt - startedAt });
  };
  const logFinish = (status, code, message) => {
    const fields = {
      id: requestId,
      model,
      stream,
      phase: firstAt === null ? "request" : "response",
      ms: Date.now() - startedAt,
      status,
      chars,
    };
    if (code) fields.code = code;
    if (message) fields.error = message;
    logAi(code ? "failed" : "done", fields);
  };

  const withAbuseRetry = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      if (!isAbuseBlock(error) || !proxyPool.running || proxyPool.nodes.length < 2) throw error;
      const next = await proxyPool.rotate().catch(() => "");
      if (!next) throw error;
      logWarn(`web: abuse page from Google, switched proxy node to ${next}`);
      return await fn();
    }
  };

  logAi("request", {
    id: requestId,
    model,
    stream,
    messages: Array.isArray(body.messages) ? body.messages.length : 0,
  });

  if (!stream) {
    try {
      const text = await withAbuseRetry(() => session.complete(prompt, { spec, temporary, onStart: markStart }));
      chars = text.length;
      store.markUsed(cred.id);
      store.markOk(cred.id);
      scheduleUsageRefresh(cred);
      logFinish(200);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.json(buildOpenaiResponse({ text, model, toolCalls: [] }));
    } catch (error) {
      if (controller.signal.aborted) {
        logAi("aborted", { id: requestId, model, stream, phase: firstAt === null ? "request" : "response", ms: Date.now() - startedAt, chars });
        return res.end();
      }
      const status = error.status || 502;
      store.markError(cred.id, error.message, { cooldownMs: status === 429 ? 60_000 : 0 });
      logFinish(status, error.code || "web_failed", error.message);
      return sendOpenaiError(res, status, error.message, { type: "web_error", code: error.code || "web_failed" });
    }
  }

  // Pull the first frame before flushing SSE headers so auth/abuse failures can
  // still be answered with a normal JSON error (and retried on another node).
  let iterator = null;
  let firstStep = null;
  try {
    firstStep = await withAbuseRetry(async () => {
      const candidate = session.chat(prompt, { spec, temporary, onStart: markStart })[Symbol.asyncIterator]();
      const first = await candidate.next();
      iterator = candidate;
      return first;
    });
  } catch (error) {
    if (controller.signal.aborted) {
      logAi("aborted", { id: requestId, model, stream, phase: firstAt === null ? "request" : "response", ms: Date.now() - startedAt, chars });
      return res.end();
    }
    logFinish(error.status || 502, error.code || "web_failed", error.message);
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
      markStart();
      if (!wroteRole) {
        send(buildOpenaiChunk({ id, model, created, delta: { role: "assistant" } }));
        wroteRole = true;
      }
      chars += String(delta || "").length;
      send(buildOpenaiChunk({ id, model, created, delta: { content: delta } }));
      step = await iterator.next();
    }
    store.markUsed(cred.id);
    store.markOk(cred.id);
    scheduleUsageRefresh(cred);
    logFinish(200);
    send(buildOpenaiChunk({ id, model, created, delta: {}, finishReason: "stop" }));
    if (body.stream_options?.include_usage) {
      send(buildOpenaiChunk({ id, model, created, delta: {}, finishReason: null, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    if (controller.signal.aborted) {
      logAi("aborted", { id: requestId, model, stream, phase: firstAt === null ? "request" : "response", ms: Date.now() - startedAt, chars });
      return res.end();
    }
    const status = error.status || 502;
    const code = error.code || "web_failed";
    store.markError(cred.id, error.message, { cooldownMs: status === 429 ? 60_000 : 0 });
    logFinish(status, code, error.message);
    if (!res.headersSent) {
      return sendOpenaiError(res, status, error.message, { type: "web_error", code });
    }
    res.write(`data: ${JSON.stringify({ error: { message: error.message, type: "web_error", code, status } })}\n\n`);
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
  if (!model) return rejectChatRequest(req, res, 404, `model ${modelId} not found`, "model_not_found");
  const credential = findStudioCredential();
  if (!credential) {
    return rejectChatRequest(req, res, 503, "no pggo credential: import an aistudio.google.com cookie first", "no_pggo_credential");
  }
  let cookie;
  try {
    cookie = decryptString(credential.cookieEnc, config.dataDir);
  } catch (error) {
    return rejectChatRequest(req, res, 500, `could not decrypt the AI Studio cookie: ${error.message}`, "pggo_cookie_decrypt_failed");
  }
  const signer = waaSigner.status();
  if (!signer.enabled) {
    return rejectChatRequest(req, res, 503, "the WAA signer is disabled (WAA_DISABLED=1)", "waa_disabled");
  }
  if (!signer.binaryExists) {
    return rejectChatRequest(req, res, 503, "the WAA signer binary is missing; rebuild the container image", "waa_missing_binary");
  }

  const controller = new AbortController();
  res.on("close", () => controller.abort(new Error("client closed the connection")));
  const requestId = req.requestId || "-";
  const startedAt = Date.now();
  let firstAt = null;
  let chars = 0;
  const markStart = () => {
    if (firstAt !== null) return;
    firstAt = Date.now();
    logAi("response", { id: requestId, model: modelId, stream, ms: firstAt - startedAt });
  };
  const logFinish = (status, code, message) => {
    const fields = {
      id: requestId,
      model: modelId,
      stream,
      phase: firstAt === null ? "request" : "response",
      ms: Date.now() - startedAt,
      status,
      chars,
    };
    if (code) fields.code = code;
    if (message) fields.error = message;
    logAi(code ? "failed" : "done", fields);
  };
  const options = { cookie, model, body, signal: controller.signal, tier: credential.tier || undefined };

  logAi("request", {
    id: requestId,
    model: modelId,
    stream,
    messages: Array.isArray(body.messages) ? body.messages.length : 0,
  });

  if (!stream) {
    try {
      const result = await completeStudioChat({ ...options, onStart: markStart });
      const text = String(result.text || "").trim();
      if (!text) throw new Error("AI Studio returned an empty response");
      chars = text.length;
      store.markUsed(credential.id);
      store.markOk(credential.id);
      logFinish(200);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.json(buildOpenaiResponse({ text, model: modelId, toolCalls: [], usage: openaiUsage(result.usage) }));
    } catch (error) {
      if (controller.signal.aborted) {
        logAi("aborted", { id: requestId, model: modelId, stream, phase: firstAt === null ? "request" : "response", ms: Date.now() - startedAt, chars });
        return res.end();
      }
      const status = error.status || 502;
      const code = error.code || "pggo_failed";
      store.markError(credential.id, error.message, { cooldownMs: status === 429 ? 60_000 : 0 });
      logFinish(status, code, error.message);
      return sendOpenaiError(res, status, explainWaaError(error), {
        type: "pggo_error",
        code,
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
    if (controller.signal.aborted) {
      logAi("aborted", { id: requestId, model: modelId, stream, phase: firstAt === null ? "request" : "response", ms: Date.now() - startedAt, chars });
      return res.end();
    }
    const status = error.status || 502;
    const code = error.code || "pggo_failed";
    logFinish(status, code, error.message);
    return sendOpenaiError(res, status, explainWaaError(error), { type: "pggo_error", code });
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
      markStart();
      if (frame.usage) usage = frame.usage;
      if (frame.text) {
        chars += frame.text.length;
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
    logFinish(200);
    send(buildOpenaiChunk({ id, model: modelId, created, delta: {}, finishReason: "stop" }));
    if (body.stream_options?.include_usage) {
      send(buildOpenaiChunk({ id, model: modelId, created, delta: {}, finishReason: null, usage: openaiUsage(usage) }));
    }
    res.write("data: [DONE]\n\n");
    res.end();
    stopHeartbeat();
  } catch (error) {
    stopHeartbeat();
    const status = error.status || 502;
    const code = error.code || "pggo_failed";
    store.markError(credential.id, error.message);
    logFinish(status, code, error.message);
    if (!res.headersSent) {
      return sendOpenaiError(res, status, explainWaaError(error), { type: "pggo_error", code });
    }
    res.write(`data: ${JSON.stringify({ error: { message: explainWaaError(error), type: "pggo_error", code, status } })}\n\n`);
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
  res.json({ logs: recentLogs(Number(req.query.limit) || 30) });
});

app.get("/admin/api/web/models", requireAdmin, (req, res) => {
  res.json({ ok: true, ...(webModelsCache || { checkedAt: null, models: [] }) });
});

app.post("/admin/api/web/models/probe", requireAdmin, async (req, res) => {
  const creds = webCredentialList();
  if (!creds.length) return res.status(400).json({ ok: false, error: "还没有导入 Gemini 网页版 Cookie" });
  try {
    const entries = await webModelEntries({ force: true });
    if (!entries.length) throw new Error("账号没有返回可用的 Gemini 模型目录");
    store.markUsed(creds[0].id);
    store.markOk(creds[0].id);
    logInfo(`web catalog: ${entries.length} models for ${creds.length} account(s)`);
    res.json({ ok: true, ...(webModelsCache || { checkedAt: Date.now(), models: [] }) });
  } catch (error) {
    store.markError(creds[0].id, error.message);
    logWarn(`web catalog probe failed: ${error.message}`);
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
    const status = await proxyPool.importSubscription(url);
    logInfo(`proxy pool: imported ${status.nodes.length} nodes into ${status.group}`);
    res.json({ ok: true, proxy: status });
  } catch (error) {
    logWarn(`proxy pool import failed: ${error.message}`);
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/admin/api/proxy/fastest", requireAdmin, (req, res) => {
  try {
    const proxy = proxyPool.configureFastest(req.body?.minutes);
    res.json({ ok: true, proxy });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/admin/api/proxy/start", requireAdmin, async (req, res) => {
  try {
    const status = await proxyPool.start();
    logInfo(`proxy pool: resumed with ${status.nodes.length} nodes`);
    res.json({ ok: true, proxy: status });
  } catch (error) {
    logWarn(`proxy pool resume failed: ${error.message}`);
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

app.post("/admin/api/proxy/remove-all", requireAdmin, async (req, res) => {
  try {
    const status = await proxyPool.removeAll();
    logInfo(`proxy pool: group cleared, ${status.removed} nodes marked removed`);
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
  // Stop using the pool as the outbound VPN; keep the default group, its
  // nodes, and the subscription URL so "启用" can resume without re-importing.
  await proxyPool.stop();
  res.json({ ok: true, proxy: proxyPool.status() });
});

app.get("/admin/api/overview", requireAdmin, async (req, res) => {
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
    models: [...cachedWebModelEntries(), ...studioModelEntries()],
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
    const name = String(req.body?.name || "new key").slice(0, 60);
    const key = String(req.body?.key || "");
    const entry = store.addApiKey(name, key);
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
  const code = error?.type === "entity.parse.failed" ? "invalid_json" : "internal_error";
  logError(`unhandled ${req.method} ${req.originalUrl} status=${status} code=${code} error=${error?.message || "internal error"}`);
  sendOpenaiError(res, status, error?.message || "internal error", { type: "server_error", code });
});

await store.init();
void initProxyPool();

const server = app.listen(config.port, config.host, () => {
  const admin = store.admin();
  const keys = store.listApiKeys();
  const lines = [
    "",
    "  webg-gateway  (OpenAI-compatible, Code Assist upstream)",
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
    void proxyPool.stop({ persist: false }).catch(() => {});
    void waaSigner.stop().catch(() => {});
    void store.flush().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app, server };
