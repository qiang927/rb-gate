import crypto from "node:crypto";
import path from "node:path";
import express from "express";
import { config, ensureConfigWarnings } from "./config.js";
import { provisionOAuth, provisionRobin, testCredential } from "./credentials.js";
import { buildAuthUrl, createPkcePair, UpstreamError } from "./google.js";
import { listModels, resolveModelId } from "./models.js";
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
    models: listModels().length,
  });
});

app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: listModels().map((model) => ({
      id: model.id,
      object: "model",
      created: 1735689600,
      owned_by: model.ownedBy || "google",
    })),
  });
});

app.get("/v1/models/:id", (req, res) => {
  const model = listModels().find((item) => item.id === req.params.id);
  if (!model) return sendOpenaiError(res, 404, `model ${req.params.id} not found`, { code: "model_not_found" });
  res.json({ id: model.id, object: "model", created: 1735689600, owned_by: model.ownedBy || "google" });
});

app.post("/v1/chat/completions", requireApiKey, async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendOpenaiError(res, 400, "messages must be a non-empty array", { code: "invalid_messages" });
  }
  const stream = Boolean(body.stream);
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

app.get("/admin/api/overview", requireAdmin, (req, res) => {
  const credentials = store.listCredentials();
  const stats = {
    credentials: credentials.length,
    active: credentials.filter((cred) => cred.status === "active").length,
    error: credentials.filter((cred) => cred.status === "error").length,
    disabled: credentials.filter((cred) => cred.status === "disabled").length,
    uses: credentials.reduce((sum, cred) => sum + (cred.uses || 0), 0),
  };
  res.json({
    credentials,
    stats,
    models: listModels(),
    apiKeys: store.listApiKeys(),
    admin: { source: store.adminSource() },
    settings: {
      upstreamBase: config.upstreamBase,
      requestTimeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
      cooldownMs: config.cooldownMs,
      robinApp: config.robinApp,
      robinScopes: config.robinScopes,
    },
    initialPassword: store.admin().generated ? store.admin().plaintextOnce || "" : "",
  });
});

function explainRobinImportError(message) {
  const text = String(message || "");
  if (/BadAuthentication|InvalidToken|invalid_token/i.test(text)) {
    return "oauth_token 是一次性的，换出 master token 后就失效；也可能不是从 Android EmbeddedSetup 流程获取，或与填写的邮箱不一致。请重新走 EmbeddedSetup 登录拿一个新 token。";
  }
  if (/RESTRICTED_CLIENT|restricted_client/i.test(text)) {
    return "这个 Android 应用身份被 Google 限制，无法用来换 token。请改走 OAuth 授权导入（面板里的 OAuth 链接）。";
  }
  if (/exchange failed/i.test(text)) {
    return "Google 拒绝了这次 oauth_token 兑换。确认 token 完整（形如 oauth2_4/…）、未过期、且只提交一次。";
  }
  return "";
}

app.post("/admin/api/credentials/import-robin", requireAdmin, async (req, res) => {
  const { email, oauthToken, label, androidId, scopes, app, clientSig } = req.body || {};
  try {
    const result = await provisionRobin({ email, oauthToken, androidId, label, scopes, app, clientSig });
    res.json({ ok: true, ...result });
  } catch (error) {
    logError(`robin import failed (${email || "?"}): ${error.message}`);
    res.status(400).json({ ok: false, error: error.message, hint: explainRobinImportError(error.message) });
  }
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

app.patch("/admin/api/credentials/:id", requireAdmin, (req, res) => {
  const cred = store.rawCredential(req.params.id);
  if (!cred) return res.status(404).json({ ok: false, error: "credential not found" });
  const { label, status, app, clientSig, scopes } = req.body || {};
  if (label !== undefined) cred.label = String(label).slice(0, 120);
  if (cred.type === "robin" && (app !== undefined || clientSig !== undefined || scopes !== undefined)) {
    if (app !== undefined) cred.app = String(app).trim() || cred.app;
    if (clientSig !== undefined) cred.clientSig = String(clientSig).trim() || cred.clientSig;
    if (scopes !== undefined) {
      cred.scopes = Array.isArray(scopes) ? scopes.filter(Boolean) : String(scopes).split(/[\s,]+/).filter(Boolean);
    }
    // Force a fresh mint with the new app/client_sig on the next call.
    cred.accessToken = "";
    cred.accessExpiresAt = 0;
    cred.status = "active";
    cred.lastError = "";
    cred.cooldownUntil = 0;
  }
  if (status !== undefined) {
    if (!["active", "disabled"].includes(status)) {
      return res.status(400).json({ ok: false, error: "status must be active or disabled" });
    }
    cred.status = status;
    if (status === "active") {
      cred.cooldownUntil = 0;
      cred.failures = 0;
    }
  }
  cred.updatedAt = new Date().toISOString();
  store.saveCredential(cred);
  res.json({ ok: true, credential: store.getCredential(cred.id) });
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

app.get("/admin/api/oauth/url", requireAdmin, (req, res) => {
  const origin = `${req.protocol}://${req.get("host")}`;
  const redirectUri = `${origin}/admin/oauth/callback`;
  const { verifier, challenge } = createPkcePair();
  const state = crypto.randomBytes(16).toString("hex");
  pendingOauth.set(state, { verifier, redirectUri, createdAt: Date.now() });
  try {
    const url = buildAuthUrl({ state, redirectUri, codeChallenge: challenge });
    res.json({ url, redirectUri, state });
  } catch (error) {
    pendingOauth.delete(state);
    sendOpenaiError(res, 400, error.message, { type: "invalid_request_error", code: "oauth_client_unconfigured" });
  }
});

const pendingOauth = new Map();

app.get("/admin/oauth/callback", async (req, res) => {
  const { code, state } = req.query;
  const pending = typeof state === "string" ? pendingOauth.get(state) : null;
  if (!code || !pending) return res.status(400).send("invalid OAuth callback (state mismatch or expired)");
  pendingOauth.delete(state);
  try {
    const result = await provisionOAuth({
      code: String(code),
      redirectUri: pending.redirectUri,
      codeVerifier: pending.verifier,
      label: "oauth import",
    });
    return res.redirect(`/admin/?imported=${encodeURIComponent(result.email || "1")}`);
  } catch (error) {
    return res.status(400).send(`OAuth import failed: ${error.message}`);
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
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app, server };
