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

/** Thinking strength names exposed by the account picker. */
export const THINKING_LEVELS = ["low", "medium", "high"];

/** Stable slug for a display name such as "4 Hydrogen". */
function modelSlug(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

/**
 * Model ids are derived from the account's own picker, not from a static
 * table: `web-gemini-4-hydrogen-low`. Auto has no thinking levels and is
 * therefore a single id (`web-gemini-4-auto`).
 */
export function webModelId(baseName) {
  const slug = modelSlug(baseName);
  return `web-gemini-${/^\d/.test(slug) ? slug : `4-${slug}`}`;
}

/** Account capacity used by the web client's model header. */
export function computeCapacity(tierFlags = [], capabilityFlags = []) {
  const tiers = new Set((Array.isArray(tierFlags) ? tierFlags : []).filter(Number.isInteger));
  const caps = new Set((Array.isArray(capabilityFlags) ? capabilityFlags : []).filter(Number.isInteger));
  if (tiers.has(21)) return { capacity: 1, capacityField: 13 };
  if (tiers.has(22)) return { capacity: 2, capacityField: 13 };
  if (caps.has(115)) return { capacity: 4, capacityField: 12 };
  if (tiers.has(16) || caps.has(106)) return { capacity: 3, capacityField: 12 };
  if (tiers.has(8) || tiers.has(19)) return { capacity: 2, capacityField: 12 };
  return { capacity: 1, capacityField: 12 };
}

/**
 * Turns the `otAQ7b` user-status response into the gateway's model catalog.
 * The picker (`body[24]`) is the availability authority; the model list in
 * `body[15]` is only a catalog and may contain models the account cannot use
 * (Carbon on Pro, for example).
 */
export function catalogFromRpc(body) {
  const source = Array.isArray(body) ? body : [];
  const rawModels = Array.isArray(source[15]) ? source[15] : [];
  const tierFlags = Array.isArray(source[16]) ? source[16] : [];
  const capabilityFlags = Array.isArray(source[17]) ? source[17] : [];
  const { capacity, capacityField } = computeCapacity(tierFlags, capabilityFlags);
  const tierLabel = capacity >= 4 ? "Plus" : capacity >= 2 ? "Pro" : "Free";
  const catalog = {
    capacity,
    capacityField,
    tierLabel,
    tierFlags,
    capabilityFlags,
    checkedAt: Date.now(),
    models: [],
    byId: new Map(),
    byBaseId: new Map(),
  };
  const byNumber = new Map();
  for (const raw of rawModels) {
    if (!Array.isArray(raw)) continue;
    const number = Number.isInteger(raw[17]) ? raw[17] : Number.isInteger(raw[9]) ? raw[9] : null;
    if (number !== null) byNumber.set(number, raw);
  }

  const addModel = (raw, levelsRaw) => {
    const hash = String(raw[0] || "");
    if (!hash) return;
    const isAuto = /auto/i.test(String(raw[1] || "")) || /auto/i.test(String(raw[10] || ""));
    const displayName = String(raw[1] || raw[10] || raw[2] || hash);
    const baseName = isAuto ? "Auto" : String(raw[2] || raw[19] || raw[1] || hash).trim();
    const modelNumber = Number.isInteger(raw[17]) ? raw[17] : Number.isInteger(raw[9]) ? raw[9] : 1;
    const levels = (isAuto ? [] : Array.isArray(levelsRaw) ? levelsRaw : [])
      .filter((item) => Array.isArray(item) && Number.isInteger(item[0]) && item[1])
      .map((item) => ({
        id: item[0],
        label: String(item[1]),
        name: String(item[1]).trim().toLowerCase(),
        description: String(item[2] || ""),
      }));
    const baseId = webModelId(baseName);
    const preset = baseId.replace(/^web-gemini-/, "");
    const makeSpec = (level, isDefault) => {
      const suffix = level ? `-${modelSlug(level.name)}` : "";
      return {
        id: `${baseId}${suffix}`,
        baseId,
        preset,
        displayName,
        baseName,
        hash,
        modelNumber,
        capacity,
        capacityField,
        isAuto,
        levels,
        level,
        isDefault: Boolean(isDefault),
        expectedServed: level ? (isDefault ? baseName : `${baseName} ${level.label}`) : baseName,
        label: level ? `${displayName} · ${level.label}` : displayName,
      };
    };
    const specs = levels.length ? levels.map((level, index) => makeSpec(level, index === 0)) : [makeSpec(null, true)];
    for (const spec of specs) {
      if (catalog.byId.has(spec.id)) continue;
      catalog.models.push(spec);
      catalog.byId.set(spec.id, spec);
      if (spec.isDefault) catalog.byBaseId.set(baseId, spec);
    }
  };

  const picker = Array.isArray(source[24]) ? source[24] : null;
  const groups = picker && Array.isArray(picker[1]) ? picker[1] : [];
  const seen = new Set();
  for (const group of groups) {
    // Each picker group is [info, levels]; `info` is the model descriptor
    // (`info[1]` is model_number) and `levels` is null for Auto.
    const info = Array.isArray(group?.[0]) ? group[0] : null;
    const number = info && Number.isInteger(info[1]) ? info[1] : null;
    const raw = number === null ? null : byNumber.get(number);
    if (!raw || seen.has(number)) continue;
    seen.add(number);
    addModel(raw, Array.isArray(group[1]) ? group[1] : []);
  }
  // Older/atypical accounts may not expose the picker; fall back to the
  // advertised model list so the gateway still has something to offer.
  if (!catalog.models.length && !groups.length) for (const raw of rawModels) addModel(raw, []);
  return catalog;
}

export function serializeCatalog(catalog) {
  return {
    capacity: catalog.capacity,
    capacityField: catalog.capacityField,
    tierLabel: catalog.tierLabel,
    tierFlags: [...(catalog.tierFlags || [])],
    capabilityFlags: [...(catalog.capabilityFlags || [])],
    checkedAt: catalog.checkedAt || Date.now(),
    models: (catalog.models || []).map((spec) => ({
      ...spec,
      levels: (spec.levels || []).map((level) => ({ ...level })),
      level: spec.level ? { ...spec.level } : null,
    })),
  };
}

export function hydrateCatalog(raw) {
  if (!raw || typeof raw !== "object") return null;
  const catalog = {
    capacity: Number(raw.capacity) || 1,
    capacityField: Number(raw.capacityField) || 12,
    tierLabel: raw.tierLabel || "Free",
    tierFlags: Array.isArray(raw.tierFlags) ? raw.tierFlags : [],
    capabilityFlags: Array.isArray(raw.capabilityFlags) ? raw.capabilityFlags : [],
    checkedAt: Number(raw.checkedAt) || Date.now(),
    models: Array.isArray(raw.models) ? raw.models : [],
    byId: new Map(),
    byBaseId: new Map(),
  };
  for (const spec of catalog.models) {
    catalog.byId.set(spec.id, spec);
    if (spec.isDefault) catalog.byBaseId.set(spec.baseId, spec);
  }
  return catalog;
}

/** Resolve a requested id (exact, bare base, or base + thinking) to a spec. */
export function resolveCatalogModel(catalog, id, thinking = null) {
  const value = String(id || "");
  const spec = catalog?.byId?.get(value) || catalog?.byBaseId?.get(value);
  if (!spec) {
    throw new WebError(`model ${value || "(missing)"} is not available for this account`, {
      status: 404,
      code: "model_not_available",
    });
  }
  if (spec.isAuto) {
    if (thinking) {
      throw new WebError("Gemini 4 Auto does not expose thinking levels", {
        status: 400,
        code: "thinking_not_supported",
      });
    }
    return spec;
  }
  const requested = String(thinking || "").trim().toLowerCase();
  if (!requested) return spec;
  const normalized = resolveThinkingLevel(requested) || requested;
  const level = (spec.levels || []).find((item) => item.name === normalized || String(item.id) === requested);
  if (!level) {
    throw new WebError(`thinking level ${thinking} is not available for ${spec.baseId}`, {
      status: 400,
      code: "thinking_not_available",
    });
  }
  const nextId = `${spec.baseId}-${modelSlug(level.name)}`;
  const next = catalog.byId.get(nextId);
  if (next) return next;
  return {
    ...spec,
    id: nextId,
    level,
    isDefault: false,
    expectedServed: level.name === "low" ? spec.baseName : `${spec.baseName} ${level.label}`,
    label: `${spec.displayName} · ${level.label}`,
  };
}

/**
 * `web-gemini-4-neon@think=high` lets clients that can only set a model name
 * pick a thinking level. Returns the plain model id plus the level (if any).
 */
export function splitWebModelId(id) {
  const value = String(id || "");
  const match = value.match(/^(.*?)@think=([a-z0-9_-]+)$/i);
  if (!match) return { model: value, thinking: null };
  return { model: match[1] || value, thinking: match[2].toLowerCase() };
}

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
  return THINKING_LEVELS.includes(key) ? key : null;
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
 * Builds the inner request array for a catalog spec. The real model rides in
 * the x-goog-ext-525001261-jspb header; inner[79] is the model number and
 * inner[80] is the picker's thinking level id (0 for Auto).
 */
export function buildWebInner(prompt, spec, { temporary = false } = {}) {
  if (!spec || typeof spec !== "object" || !spec.hash) {
    throw new WebError("missing Gemini web model spec", { status: 500, code: "bad_model_spec" });
  }
  const inner = new Array(102).fill(null);
  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[1] = ["zh-CN"];
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[0]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = temporary ? [1] : [2];
  inner[45] = temporary ? 1 : null;
  inner[53] = 0;
  inner[59] = crypto.randomUUID();
  inner[61] = [];
  inner[68] = 1;
  inner[79] = spec.modelNumber;
  inner[80] = spec.isAuto ? 0 : spec.level?.id ?? 0;
  return inner;
}

/** Headers that actually select the model on the Gemini web backend. */
export function webModelHeaders(spec, uuid) {
  const capacityField = Number.isInteger(spec.capacityField) ? spec.capacityField : 12;
  const capacity = Number.isInteger(spec.capacity) ? spec.capacity : 1;
  const tail = capacityField === 13 ? [null, capacity] : capacity;
  const thinking = spec.isAuto ? 0 : spec.level?.id ?? 0;
  const header = [
    1,
    null,
    null,
    null,
    spec.hash,
    null,
    null,
    0,
    [4, 5, 6, 8],
    null,
    null,
    tail,
    null,
    null,
    spec.modelNumber,
    thinking,
    uuid,
  ];
  return {
    "x-goog-ext-525001261-jspb": JSON.stringify(header),
    "x-goog-ext-73010989-jspb": "[0]",
    "x-goog-ext-73010990-jspb": "[0,0,0]",
    "x-goog-ext-525005358-jspb": JSON.stringify([uuid, 1]),
  };
}

export function parseBatchexecute(raw, rpcid) {
  const text = String(raw || "").replace(/^\)\]\}'\s*/, "").trim();
  if (!text) return null;
  const frames = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue;
    try {
      const value = JSON.parse(trimmed);
      if (Array.isArray(value)) frames.push(...value);
    } catch {
      // batchexecute can split a frame across lines; the fallback below still
      // handles the common single-frame response.
    }
  }
  if (!frames.length) {
    try {
      const value = JSON.parse(text);
      if (Array.isArray(value)) frames.push(...value);
    } catch {
      return null;
    }
  }
  for (const part of frames) {
    if (!Array.isArray(part) || part[1] !== rpcid) continue;
    if (Array.isArray(part[5]) && part[5][0] === 7) return null;
    if (typeof part[2] === "string") {
      try {
        return JSON.parse(part[2]);
      } catch {
        return null;
      }
    }
    if (part[2] && typeof part[2] === "object") return part[2];
  }
  return null;
}

/**
 * Reads the account's real model list from the same `otAQ7b` RPC the Gemini
 * web client uses. The picker only contains models the account can use.
 */
export async function fetchWebModelCatalog(session, { timeoutMs = 30000 } = {}) {
  const { atToken: at, bl, cookie } = await session.bootstrap();
  const reqid = Math.floor(Date.now() / 1000) % 1000000;
  const url =
    `https://gemini.google.com/_/BardChatUi/data/batchexecute` +
    `?rpcids=otAQ7b&hl=en&_reqid=${reqid}&rt=c&source-path=%2Fapp&bl=${encodeURIComponent(bl)}`;
  const freq = JSON.stringify([[["otAQ7b", "[]", null, "generic"]]]);
  const body = new URLSearchParams({ at, "f.req": freq }).toString();
  const res = await request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
      origin: "https://gemini.google.com",
      referer: "https://gemini.google.com/app",
      "x-same-domain": "1",
      cookie,
      "content-length": Buffer.byteLength(body),
    },
    body,
    timeoutMs,
  });
  if (res.status === 302) {
    session.cookies = null;
    throw new WebError("gemini session expired (302)", { code: "session_expired", retryable: true });
  }
  if (res.status !== 200) {
    throw new WebError(`model catalog request failed (${res.status})`, {
      code: "catalog_failed",
      retryable: true,
    });
  }
  const parsed = parseBatchexecute(res.body, "otAQ7b");
  if (!parsed) {
    throw new WebError("model catalog response changed", { code: "catalog_parse_failed", retryable: true });
  }
  const catalog = catalogFromRpc(parsed);
  if (!catalog.models.length) {
    throw new WebError("model catalog is empty", { code: "catalog_empty", retryable: true });
  }
  return catalog;
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

export function parseWebFrame(line) {
  if (!line.includes('"wrb.fr"') || line.length < 200) return null;
  try {
    const arr = JSON.parse(line);
    const innerStr = arr?.[0]?.[2];
    if (!innerStr || innerStr.length < 50) return null;
    const inner = JSON.parse(innerStr);
    if (!Array.isArray(inner) || inner.length <= 4) return null;
    const texts = [];
    for (const part of Array.isArray(inner[4]) ? inner[4] : []) {
      if (Array.isArray(part) && Array.isArray(part[1])) {
        for (const text of part[1]) if (typeof text === "string" && text) texts.push(text);
      }
    }
    const name = (value) =>
      typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
    return {
      texts,
      servedModel: name(inner[42]),
      echoModel: name(inner[39]),
    };
  } catch {
    return null;
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

  /**
   * Stream text deltas from Gemini web. Yields plain text chunks.
   *
   * `spec` comes from the account catalog. The model is selected by the
   * x-goog-ext-525001261-jspb header, not by the inner array. Gemini reports the
   * model it actually used in inner[42]; an explicit model that was silently
   * downgraded (Carbon on Pro, for example) fails before any text is yielded.
   */
  async *chat(prompt, { spec, temporary = false, onStart } = {}) {
    if (!spec || typeof spec !== "object" || !spec.hash) {
      throw new WebError("missing Gemini web model spec", { status: 500, code: "bad_model_spec" });
    }
    const { atToken: at, bl, cookie } = await this.bootstrap();
    this.lastServedModel = null;
    const inner = buildWebInner(prompt, spec, { temporary });
    const uuid = inner[59];
    const body = new URLSearchParams({ "f.req": JSON.stringify([null, JSON.stringify(inner)]) }).toString();
    const url =
      `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate` +
      `?bl=${encodeURIComponent(bl)}&hl=en&_reqid=${Math.floor(Date.now() / 1000) % 1000000}&rt=c`;
    const payload = body + "&at=" + encodeURIComponent(at);
    const res = await openStream(url, {
      headers: {
        ...webModelHeaders(spec, uuid),
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
    const session = this;
    const expected = spec.isAuto ? null : spec.expectedServed;
    let buffer = "";
    let last = "";
    let pending = [];
    let verified = spec.isAuto;
    let started = false;
    const markStart = () => {
      if (started) return;
      started = true;
      onStart?.();
    };
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
      const frame = parseWebFrame(line);
      if (!frame) return;
      if (frame.servedModel) {
        session.lastServedModel = frame.servedModel;
        if (!verified) {
          if (expected && frame.servedModel !== expected) {
            throw new WebError(`model downgraded: requested ${spec.id}, Gemini served ${frame.servedModel}`, {
              status: 502,
              code: "model_downgraded",
            });
          }
          verified = true;
          for (const delta of pending) {
            markStart();
            yield delta;
          }
          pending = [];
        }
      }
      if (!frame.texts.length) return;
      const text = frame.texts[frame.texts.length - 1];
      if (text.length <= last.length) return;
      const delta = text.slice(last.length);
      last = text;
      if (!delta) return;
      if (verified) {
        markStart();
        yield delta;
      } else {
        pending.push(delta);
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
    if (!spec.isAuto && !verified) {
      throw new WebError(`Gemini did not report which model served ${spec.id}`, {
        status: 502,
        code: "model_unverified",
      });
    }
  }

  async complete(prompt, options = {}) {
    let out = "";
    for await (const delta of this.chat(prompt, options)) out += delta;
    return out;
  }
}
