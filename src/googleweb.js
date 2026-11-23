import https from "node:https";
import { StringDecoder } from "node:string_decoder";
import crypto from "node:crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "./config.js";
import { getOutboundProxy } from "./proxyroute.js";
import { mintBearer } from "./gpsoauth.js";

const OAUTH_LOGIN_SERVICE = "https://www.google.com/accounts/OAuthLogin";
const DEFAULT_WEB_APP = "com.google.android.apps.chromecast.app";
const DEFAULT_WEB_SIG = "24bb24c05e47e0aefa68a58a766179d9b613a600";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

/** The five chat presets the Gemini web client exposes. */
export const WEB_PRESETS = {
  // Which backend model each preset maps to is decided by Google, so we
  // address them by mode.
  "web-gemini-4-hydrogen": { mode: 1, think: 4, label: "Gemini 4 Hydrogen (Web)" },
  "web-gemini-4-neon": { mode: 2, think: 0, label: "Gemini 4 Neon (Web)" },
  "web-gemini-4-carbon": { mode: 3, think: 4, label: "Gemini 4 Carbon (Web)" },
  "web-gemini-4-auto": { mode: 4, think: 4, label: "Gemini 4 Auto (Web)" },
  "web-gemini-4-flash-lite": { mode: 6, think: 4, label: "Gemini 4 Flash-Lite (Web)" },
};

/** The three thinking strengths the Gemini web client exposes per preset. */
export const THINKING_LEVELS = ["low", "medium", "high"];
const LEVEL_LABELS = { low: "Low", medium: "Medium", high: "High" };

/**
 * Every preset is advertised once per thinking level, so a client that can
 * only pick a model name (no reasoning_effort field) can still choose the
 * strength. IDs look like `web-gemini-4-neon-high`.
 */
export const WEB_MODELS = {};
for (const [presetId, cfg] of Object.entries(WEB_PRESETS)) {
  for (const level of THINKING_LEVELS) {
    WEB_MODELS[`${presetId}-${level}`] = {
      ...cfg,
      preset: presetId,
      level,
      label: `${cfg.label} · ${LEVEL_LABELS[level]}`,
    };
  }
}

/** Bare preset ids stay callable for older clients; they mean "Google default". */
const WEB_MODEL_ALIASES = Object.fromEntries(
  Object.entries(WEB_PRESETS).map(([presetId, cfg]) => [presetId, { ...cfg, preset: presetId, level: null }]),
);

export function lookupWebModel(id) {
  return WEB_MODELS[id] || WEB_MODEL_ALIASES[id] || null;
}

export function isWebModel(id) {
  return Boolean(WEB_MODELS[id] || WEB_MODEL_ALIASES[id]);
}

// Wire values of inner[80]; 1/2/3 is what the web client sends for low/medium/high.
const THINKING_WIRE = { low: 1, medium: 2, high: 3 };

/**
 * Accepts what OpenAI clients actually send for `reasoning_effort` and turns
 * it into one of the three web levels. Unknown values mean "leave it to
 * Google" instead of failing the request.
 */
export function resolveThinkingLevel(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return THINKING_LEVELS[value - 1] || null;
  const key = String(value).trim().toLowerCase();
  if (key === "minimal") return "low";
  if (key === "xhigh" || key === "max") return "high";
  return Object.hasOwn(THINKING_WIRE, key) ? key : null;
}

/**
 * `web-gemini-4-neon@think=high` lets clients that can only set a model name
 * pick a thinking level. Returns the plain model id plus the level (if any).
 */
export function splitWebModelId(id) {
  const value = String(id || "");
  const match = value.match(/^(.*?)@think=(low|medium|high)$/i);
  if (!match) return { model: value, thinking: null };
  return { model: match[1] || value, thinking: match[2].toLowerCase() };
}

/**
 * Thinking level for a chat body: the model-name suffix wins, then
 * `reasoning_effort` / `reasoning.effort`, then a Claude-style token budget.
 */
export function thinkingFromBody(body = {}) {
  const direct = resolveThinkingLevel(body.reasoning_effort ?? body.reasoning?.effort);
  if (direct) return direct;
  const budget = body.thinking?.budget_tokens;
  if (typeof budget === "number" && budget > 0) {
    return budget < 2048 ? "low" : budget < 4096 ? "medium" : "high";
  }
  return null;
}

/**
 * Builds the inner request array. The thinking level rides in inner[80]
 * (1=low, 2=medium, 3=high); when the client did not ask for one the slot
 * stays null and Google applies the preset's own default.
 */
export function buildWebInner(prompt, model, { temporary = false, thinking = null } = {}) {
  const cfg = lookupWebModel(model) || WEB_MODEL_ALIASES["web-gemini-4-hydrogen"];
  const level = thinking ? THINKING_WIRE[thinking] : cfg.level ? THINKING_WIRE[cfg.level] : null;
  const inner = new Array(102).fill(null);
  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[1] = ["zh-CN"];
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[cfg.think]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = temporary ? [1] : [2];
  inner[45] = temporary ? 1 : null;
  inner[53] = 0;
  inner[59] = crypto.randomUUID();
  inner[61] = [];
  inner[68] = 1;
  inner[79] = cfg.mode;
  if (level) inner[80] = level;
  return inner;
}

/**
 * Ask the web endpoint which presets actually answer right now. The web UI has
 * no model-list API, so the only honest check is a tiny prompt per preset.
 */
export async function probeWebModels(session, { timeoutMs = 60000 } = {}) {
  const results = [];
  for (const [id, cfg] of Object.entries(WEB_PRESETS)) {
    const started = Date.now();
    let timer = null;
    try {
      const text = await Promise.race([
        session.complete("ping", { model: id }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new WebError("probe timed out", { status: 504, code: "probe_timeout" })), timeoutMs);
        }),
      ]);
      results.push({ id, label: cfg.label, mode: cfg.mode, ok: true, ms: Date.now() - started, sample: String(text || "").trim().slice(0, 30) });
    } catch (error) {
      results.push({ id, label: cfg.label, mode: cfg.mode, ok: false, ms: Date.now() - started, error: error.message, code: error.code || "probe_failed" });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return results;
}

export class WebError extends Error {
  constructor(message, { status = 502, code = "web_error", retryable = false } = {}) {
    super(message);
    this.name = "WebError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const proxyAgents = new Map();
function outboundAgent() {
  const source = getOutboundProxy() || config.webProxy;
  if (!source) return undefined;
  const target = /^[a-z]+:\/\//i.test(source) ? source : `http://${source}`;
  if (!proxyAgents.has(target)) proxyAgents.set(target, new HttpsProxyAgent(target));
  return proxyAgents.get(target);
}

function request(url, { method = "GET", headers = {}, body = null, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        agent: outboundAgent(),
        maxHeaderSize: 131072,
        headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", "accept-encoding": "identity", ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function openStream(url, { headers = {}, body = null, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "POST",
        agent: outboundAgent(),
        maxHeaderSize: 131072,
        headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", "accept-encoding": "identity", ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        res.setEncoding("utf8");
        resolve(res);
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function extractTexts(line) {
  if (!line.includes('"wrb.fr"') || line.length < 200) return [];
  try {
    const arr = JSON.parse(line);
    const innerStr = arr?.[0]?.[2];
    if (!innerStr || innerStr.length < 50) return [];
    const inner = JSON.parse(innerStr);
    if (!Array.isArray(inner) || inner.length <= 4 || !inner[4]) return [];
    const texts = [];
    for (const part of inner[4]) {
      if (Array.isArray(part) && Array.isArray(part[1])) {
        for (const t of part[1]) if (typeof t === "string" && t) texts.push(t);
      }
    }
    return texts;
  } catch {
    return [];
  }
}

const COOKIE_ATTRIBUTES = new Set([
  "path", "domain", "expires", "max-age", "secure", "httponly", "samesite", "priority", "partitioned", "version",
]);

export function parseCookieJar(raw) {
  const pairs = String(raw || "")
    .split(/[;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const cookies = [];
  for (const pair of pairs) {
    const clean = pair.replace(/^cookie:\s*/i, "");
    const index = clean.indexOf("=");
    if (index <= 0) continue;
    const name = clean.slice(0, index).trim();
    if (!name || COOKIE_ATTRIBUTES.has(name.toLowerCase())) continue;
    cookies.push(clean);
  }
  return cookies;
}

export async function probeWebCookie(rawCookie) {
  const cookies = parseCookieJar(rawCookie);
  const cookie = cookies.join("; ");
  if (!cookie) return { ok: false, error: "empty_cookie" };
  let page = await request("https://gemini.google.com/app", { headers: { cookie } });
  const hops = [];
  for (let i = 0; i < 3 && page.status >= 300 && page.status < 400; i += 1) {
    const location = page.headers.location || "";
    hops.push({ status: page.status, location: location.slice(0, 160) });
    if (!location) break;
    const next = new URL(location, "https://gemini.google.com/app");
    if (next.origin !== "https://gemini.google.com") break;
    page = await request(next.toString(), { headers: { cookie } });
  }
  return {
    ok: page.status === 200,
    status: page.status,
    location: page.headers.location ? page.headers.location.slice(0, 200) : null,
    hops,
    hasAt: /"SNlM0e":\s*"([^"]+)"/.test(page.body),
    hasBl: /"cfb2h":\s*"([^"]+)"/.test(page.body),
    cookieCount: cookies.length,
    names: cookies.map((c) => c.split("=")[0]),
  };
}

const USAGE_URL = "https://gemini.google.com/_/BardChatUi/graphql/schemas/GEMINI_WEB_GRAPHQL/executeQuery";
// Query signature of the public UsagePageSurface bundle (same query the
// gemini.google.com/usage page runs). Kept as a constant; update if it rotates.
const USAGE_SIGNATURE = "2/dWbCvkVB0X16r9NPnxifeOAAqdCqMf0xeWvau9yPy7g=";
const USAGE_VARIABLES = JSON.stringify({
  g1Request: { entrypoints: ["GEMINI_USAGE_SETTINGS_UPGRADE_BANNER"] },
  workspaceRequest: { recommendationsForSurfaceRequests: [] },
});

export const TIER_LABELS = { TIER0: "Plus", TIER1: "Pro", TIER2: "Ultra" };

// What the official Gemini app unlocks at each tier (UI gating). The web
// endpoint does not always enforce this server-side, so treat it as a hint and
// rely on the live per-model probe for actual availability.
export const MODEL_TIER_REQUIREMENTS = {
  "web-gemini-4-hydrogen": "Free",
  "web-gemini-4-neon": "Pro",
  "web-gemini-4-carbon": "Ultra",
  "web-gemini-4-auto": "Free",
  "web-gemini-4-flash-lite": "Free",
};

export function requiredTierForModel(id) {
  const preset = String(id || "").replace(/-(low|medium|high)$/i, "");
  return MODEL_TIER_REQUIREMENTS[preset] || null;
}

export function tierLabel(raw) {
  if (!raw) return "Free";
  return TIER_LABELS[raw] || raw;
}

export function parseUsageBody(raw) {
  const text = String(raw || "").trim().replace(/^\)\]\}'\s*/, "");
  if (!text) return null;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  const list = Array.isArray(payload) ? payload : [payload];
  const viewer = list.map((item) => item?.data?.viewer).find((item) => item && typeof item === "object");
  const info = viewer?.rpcs?.getUsageInfo;
  if (!info || !Array.isArray(info.pools)) return null;
  const readWindow = (poolType, windowMinutes) => {
    const pool = info.pools.find((item) => item && item.poolType === poolType);
    if (!pool || pool.percentageUsed === null || pool.percentageUsed === undefined) return null;
    const used = Number(pool.percentageUsed);
    if (!Number.isFinite(used) || used < 0) return null;
    const usedPercent = Math.max(0, Math.min(100, used * 100));
    const resetsAt = /^\d{4}-\d{2}-\d{2}T/.test(String(pool?.gxu?.windowRefreshesAt || ""))
      ? pool.gxu.windowRefreshesAt
      : null;
    return {
      usedPercent: Math.round(usedPercent * 10) / 10,
      remainingPercent: Math.round((100 - usedPercent) * 10) / 10,
      windowMinutes,
      resetsAt,
    };
  };
  const tierRaw = typeof info.subscriptionTier === "string" ? info.subscriptionTier : "";
  return {
    tier: { raw: tierRaw, label: tierLabel(tierRaw) },
    fiveHour: readWindow("GXU_FIVE_HOURLY", 300),
    weekly: readWindow("GXU_WEEKLY", 10080),
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchWebUsage(session) {
  await session.ensureCookies();
  const cookie = session.cookies.join("; ");
  const url =
    `${USAGE_URL}?query_signature=${encodeURIComponent(USAGE_SIGNATURE)}` +
    `&variables=${encodeURIComponent(USAGE_VARIABLES)}`;
  const res = await request(url, {
    headers: { cookie, accept: "application/json", referer: "https://gemini.google.com/usage" },
    timeoutMs: 30000,
  });
  if (res.status === 401 || res.status === 403) {
    throw new WebError(`usage request rejected (${res.status})`, { status: 401, code: "session_expired", retryable: true });
  }
  if (res.status === 429) {
    throw new WebError("usage request rate limited (429)", { status: 429, code: "usage_rate_limited", retryable: true });
  }
  if (res.status !== 200 || res.body.trimStart().startsWith("<")) {
    throw new WebError(`usage request failed (${res.status})`, { status: 502, code: "usage_failed", retryable: true });
  }
  const usage = parseUsageBody(res.body);
  if (!usage) throw new WebError("usage response changed", { status: 502, code: "usage_parse_failed" });
  // Account fingerprint from the identity cookies: helps spot two credentials that share one session.
  const jar = new Map();
  for (const item of session.cookies) {
    const at = item.indexOf("=");
    if (at > 0) jar.set(item.slice(0, at).trim(), item.slice(at + 1).trim());
  }
  const identity = ["SID", "__Secure-1PSID", "__Secure-3PSID", "SAPISID", "APISID"]
    .map((name) => `${name}=${jar.get(name) || ""}`)
    .join("|");
  usage.accountFingerprint = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 10);
  return usage;
}

export class GoogleWebSession {
  constructor({ email, masterToken, androidId, app = DEFAULT_WEB_APP, clientSig = DEFAULT_WEB_SIG, cookie = "" }) {
    this.email = email;
    this.masterToken = masterToken;
    this.androidId = androidId;
    this.app = app;
    this.clientSig = clientSig;
    this.cookieString = String(cookie || "").trim();
    this.cookies = null;
    this.tokens = null;
    this.cookiesAt = 0;
  }

  async #mintCookies() {
    const bearer = await mintBearer(this.email, this.masterToken, this.androidId, {
      scopes: OAUTH_LOGIN_SERVICE,
      app: this.app,
      clientSig: this.clientSig,
    });
    const login = await request("https://accounts.google.com/OAuthLogin?source=ChromiumBrowser&issueuberauth=1", {
      headers: { authorization: "Bearer " + bearer.token },
    });
    if (login.status !== 200 || !login.body.trim()) {
      throw new WebError(`OAuthLogin failed (${login.status}): ${login.body.slice(0, 120)}`, { code: "oauthlogin_failed", retryable: true });
    }
    const uberauth = login.body.trim();
    const merge = await request(
      "https://accounts.google.com/MergeSession?service=mail&continue=https://gemini.google.com/app&uberauth=" + encodeURIComponent(uberauth)
    );
    let cookies = (merge.headers["set-cookie"] || []).map((c) => c.split(";")[0]);
    if (!cookies.some((c) => c.startsWith("SID="))) {
      throw new WebError(`MergeSession did not return SID cookie (${merge.status})`, { code: "merge_session_failed", retryable: true });
    }
    // MergeSession hands out long-lived SID cookies but not the rotating
    // __Secure-1PSIDTS pair. Google's web apps (gemini.google.com included)
    // treat a session without a fresh PSIDTS as signed-out, so rotate once.
    try {
      const rotate = await request("https://accounts.google.com/RotateCookies", {
        method: "POST",
        headers: {
          cookie: cookies.join("; "),
          "content-type": "application/json",
          origin: "https://accounts.google.com",
        },
        body: '[000,"-0000000000000000000"]',
        timeoutMs: 30000,
      });
      const extra = (rotate.headers["set-cookie"] || []).map((c) => c.split(";")[0]);
      for (const item of extra) {
        const name = item.split("=")[0];
        cookies = cookies.filter((c) => c.split("=")[0] !== name);
        cookies.push(item);
      }
    } catch {
      // Best effort: some accounts do not need the rotation round-trip.
    }
    this.cookies = cookies;
    this.cookiesAt = Date.now();
    if (process.env.WEB_DEBUG === "1") {
      console.error(`[googleweb] merge status=${merge.status} cookies=${cookies.map((c) => c.split("=")[0]).join(",")}`);
    }
    return cookies;
  }

  async ensureCookies({ force = false } = {}) {
    if (!force && this.cookies && Date.now() - this.cookiesAt < 6 * 60 * 60 * 1000) return this.cookies;
    if (this.cookieString) {
      const cookies = this.cookieString
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean);
      if (!cookies.some((c) => c.startsWith("SID=") || c.startsWith("__Secure-1PSID="))) {
        throw new WebError("cookie string has no SID / __Secure-1PSID", { code: "bad_cookie" });
      }
      this.cookies = cookies;
      this.cookiesAt = Date.now();
      return cookies;
    }
    return this.#mintCookies();
  }

  async bootstrap({ force = false } = {}) {
    if (!force && this.tokens && Date.now() - this.tokens.at < 30 * 60 * 1000) return this.tokens;
    await this.ensureCookies();
    const cookie = this.cookies.join("; ");
    let page = await request("https://gemini.google.com/app", { headers: { cookie } });
    // Gemini sometimes answers /app with a same-site locale redirect; follow it
    // instead of treating it as an expired session.
    for (let hop = 0; hop < 3 && page.status >= 300 && page.status < 400; hop += 1) {
      const location = page.headers.location || "";
      if (!location) break;
      const next = new URL(location, "https://gemini.google.com/app");
      if (next.origin !== "https://gemini.google.com") break;
      page = await request(next.toString(), { headers: { cookie } });
    }
    if (page.status !== 200) {
      await this.ensureCookies({ force: true });
      const where = page.headers.location ? ` -> ${page.headers.location.slice(0, 140)}` : "";
      const jar = (this.cookies || []).map((c) => c.split("=")[0]);
      let probe = "";
      for (const target of ["https://myaccount.google.com/", "https://www.google.com/"]) {
        try {
          const check = await request(target, { headers: { cookie: (this.cookies || []).join("; ") } });
          probe += ` [${new URL(target).hostname} ${check.status}${check.headers.location ? " -> " + check.headers.location.slice(0, 80) : ""}]`;
        } catch (error) {
          probe += ` [${new URL(target).hostname} failed: ${error.message}]`;
        }
      }
      throw new WebError(
        `gemini page failed (${page.status})${where} [merge cookies: ${jar.join(",") || "none"}]${probe}`,
        { code: "page_failed", retryable: true },
      );
    }
    const at = page.body.match(/"SNlM0e":\s*"([^"]+)"/)?.[1];
    const bl = page.body.match(/"cfb2h":\s*"([^"]+)"/)?.[1];
    if (!at || !bl) throw new WebError("gemini page missing at/bl tokens", { code: "page_tokens_missing", retryable: true });
    this.tokens = { atToken: at, bl, at: Date.now(), cookie };
    return this.tokens;
  }

  #buildBody(prompt, model, { temporary = false, thinking = null } = {}) {
    const inner = buildWebInner(prompt, model, { temporary, thinking });
    const outer = [null, JSON.stringify(inner)];
    return new URLSearchParams({ "f.req": JSON.stringify(outer) }).toString();
  }

  /**
   * Stream text deltas from Gemini web. Yields plain text chunks.
   */
  async *chat(prompt, { model = "web-gemini-4-hydrogen", temporary = false, thinking = null } = {}) {
    const { atToken: at, bl, cookie } = await this.bootstrap();
    const body = this.#buildBody(prompt, model, { temporary, thinking });
    const url =
      `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate` +
      `?bl=${encodeURIComponent(bl)}&hl=en&_reqid=${Math.floor(Date.now() / 1000) % 1000000}&rt=c`;
    const payload = body + "&at=" + encodeURIComponent(at);
    const res = await openStream(url, {
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://gemini.google.com",
        referer: "https://gemini.google.com/app",
        "x-same-domain": "1",
        cookie,
        "content-length": Buffer.byteLength(payload),
      },
      body: payload,
    });

    if (res.statusCode === 302) {
      res.resume();
      this.cookies = null;
      throw new WebError("gemini session expired (302)", { code: "session_expired", retryable: true });
    }
    if (res.statusCode !== 200) {
      let detail = "";
      for await (const chunk of res) detail += chunk;
      throw new WebError(`StreamGenerate failed (${res.statusCode}): ${detail.slice(0, 200)}`, { code: "upstream_failed", retryable: true });
    }

    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let last = "";
    const consume = function* (line) {
      if (!line.includes('"wrb.fr"')) return;
      if (line.includes("BardErrorInfo")) {
        const m = line.match(/BardErrorInfo\s*\[(\d+)\]/);
        throw new WebError(`Gemini rejected request: BardErrorInfo [${m?.[1] ?? "?"}]`, {
          code: "bard_error",
          status: m?.[1] === "7" ? 429 : 502,
          retryable: true,
        });
      }
      const texts = extractTexts(line);
      if (!texts.length) return;
      const text = texts[texts.length - 1];
      if (text.length > last.length) {
        const delta = text.slice(last.length);
        last = text;
        if (delta) yield delta;
      }
    };

    for await (const chunk of res) {
      buffer += decoder.write(chunk);
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        yield* consume(line);
      }
    }
    buffer += decoder.end();
    if (buffer.trim()) yield* consume(buffer);
  }

  async complete(prompt, options = {}) {
    let out = "";
    for await (const delta of this.chat(prompt, options)) out += delta;
    return out;
  }
}
