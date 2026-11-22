// Google AI Studio (MakerSuite) private RPC wire codec.
//
// AI Studio's web client talks to a private JSON-over-Protobuf RPC:
//
//   POST https://alkalimakersuite-pa.clients6.google.com/$rpc/...MakerSuiteService/GenerateContent
//
// The body is a sparse JSON array ("JSPB") where field N maps to index N-1:
//   [0] model "models/<id>"     [1] contents        [2] safety settings
//   [3] generation config       [4] WAA proof       [5] system instruction
//   [6] tools                   [10] request flag   [13] request context
//
// A Content is [[part, ...], role]; a Part is a sparse array with text at
// index 1, inlineData at 2, functionCall at 3, thought flag at 12.
//
// The WAA (BotGuard) proof in slot [4] must be minted by the native signer for
// the exact text of the request, so this module also owns the digest/binding
// logic shared with the signer.

import { createHash } from "node:crypto";

export const AI_STUDIO_RPC =
  "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent";

export const AI_STUDIO_ORIGIN = "https://aistudio.google.com";

/** Public API key the AI Studio page ships with; used when no key was captured. */
export const PUBLIC_WEB_API_KEY = "AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs";

/** Static client hint the web bundle sends with every RPC. */
export const EXT_BIN_HEADER = "CAASAUIwATgEQABQBFgDYgJKUHAAeAGQAQCYAQE=";

/**
 * Models exposed as `studio-*`. The upstream id is what goes into wire[0].
 * Kept small on purpose: the AI Studio catalog moves fast, extend via env
 * `AI_STUDIO_MODELS` (comma separated upstream ids) when it does.
 */
export const AI_STUDIO_MODELS = [
  { id: "studio-gemini-4-neon", upstream: "models/gemini-4-neon", name: "Gemini 4 Neon (AI Studio)" },
  { id: "studio-gemini-4-hydrogen", upstream: "models/gemini-4-hydrogen", name: "Gemini 4 Hydrogen (AI Studio)" },
  { id: "studio-gemini-4-carbon", upstream: "models/gemini-4-carbon", name: "Gemini 4 Carbon (AI Studio)" },
  { id: "studio-gemini-4-argon", upstream: "models/gemini-4-argon", name: "Gemini 4 Argon (AI Studio)" },
  { id: "studio-gemini-3.8-flash", upstream: "models/gemini-3.8-flash", name: "Gemini 3.8 Flash (AI Studio)" },
  { id: "studio-gemini-3.6-flash", upstream: "models/gemini-3.6-flash", name: "Gemini 3.6 Flash (AI Studio)" },
  { id: "studio-gemini-3.1-pro-preview", upstream: "models/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview (AI Studio)" },
  { id: "studio-gemini-3-flash-preview", upstream: "models/gemini-3-flash-preview", name: "Gemini 3 Flash Preview (AI Studio)" },
  { id: "studio-gemini-3.5-flash-lite", upstream: "models/gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite (AI Studio)" },
  { id: "studio-gemini-3.1-flash-lite", upstream: "models/gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite (AI Studio)" },
  { id: "studio-gemini-pro-latest", upstream: "models/gemini-pro-latest", name: "Gemini Pro Latest (AI Studio)" },
  { id: "studio-gemini-flash-latest", upstream: "models/gemini-flash-latest", name: "Gemini Flash Latest (AI Studio)" },
];

export function listStudioModels() {
  const extra = String(process.env.AI_STUDIO_MODELS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const seen = new Set(AI_STUDIO_MODELS.map((item) => item.upstream));
  const models = [...AI_STUDIO_MODELS];
  for (const upstream of extra) {
    if (seen.has(upstream)) continue;
    seen.add(upstream);
    const name = upstream.replace(/^models\//, "");
    models.push({ id: `studio-${name}`, upstream, name: `${name} (AI Studio)` });
  }
  return models;
}

export function lookupStudioModel(id) {
  if (!id) return null;
  const models = listStudioModels();
  const direct = models.find((item) => item.id === id);
  if (direct) return direct;
  const bare = String(id).replace(/^studio-/, "");
  return (
    models.find((item) => item.upstream === bare) ||
    models.find((item) => item.upstream === `models/${bare}`) ||
    null
  );
}

export function isStudioModel(id) {
  return Boolean(lookupStudioModel(id));
}

/** Cookies that carry the AI Studio session; everything else is noise. */
export const MINIMAL_COOKIES = new Set([
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "__Secure-1PSID",
  "__Secure-3PSID",
  "__Secure-1PAPISID",
  "__Secure-3PAPISID",
  "__Secure-1PSIDTS",
  "__Secure-3PSIDTS",
  "SIDCC",
  "__Secure-1PSIDCC",
  "__Secure-3PSIDCC",
]);

/** Parse a raw Cookie header (or a `name=value` blob) into an object. */
export function parseCookieHeader(raw) {
  const out = {};
  const text = String(raw || "")
    .replace(/^\s*Cookie:\s*/i, "")
    .trim();
  for (const chunk of text.split(/[;\n\r]+/)) {
    const item = chunk.trim();
    if (!item) continue;
    const index = item.indexOf("=");
    if (index <= 0) continue;
    const name = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (!name || !value) continue;
    out[name] = value;
  }
  return out;
}

export function minimalCookies(cookies) {
  const parsed = typeof cookies === "string" ? parseCookieHeader(cookies) : cookies || {};
  const out = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (MINIMAL_COOKIES.has(name) && value) out[name] = value;
  }
  return out;
}

/**
 * Split a credential cookie into what the signer needs.
 * Returns `{cookies, header, ok, missing}`.
 */
export function prepareCookies(raw) {
  const all = parseCookieHeader(raw);
  const cookies = minimalCookies(raw);
  const missing = [];
  if (!cookies.SID && !cookies["__Secure-1PSID"]) missing.push("SID");
  if (!cookies.SAPISID && !cookies["__Secure-1PAPISID"] && !cookies["__Secure-3PAPISID"]) missing.push("SAPISID");
  // The signer replays the whole browser session (it loads aistudio.google.com
  // itself), so it needs every cookie the browser had - NID/PSIDTS included.
  // The RPC only needs the minimal set; both strings are returned.
  const encode = (dict) =>
    Object.entries(dict)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  return { cookies, header: encode(all), minimalHeader: encode(cookies), ok: missing.length === 0, missing };
}

/**
 * Build the RPC headers from the signer's dynamic session headers.
 * The signer owns UA / Authorization / Cookie / visit-id so the proof and the
 * HTTP fingerprint describe the same client.
 */
export function buildRpcHeaders({ cookieHeader = "", signerHeaders = {}, authUser = 0 } = {}) {
  const dynamic = {};
  for (const [name, value] of Object.entries(signerHeaders || {})) {
    if (value === undefined || value === null) continue;
    dynamic[String(name).toLowerCase()] = String(value);
  }
  const headers = {
    "content-type": "application/json+protobuf",
    "x-user-agent": "grpc-web-javascript/0.1",
    "x-goog-api-key": dynamic["x-goog-api-key"] || PUBLIC_WEB_API_KEY,
    "x-goog-authuser": String(authUser ?? 0),
    "x-goog-ext-519733851-bin": dynamic["x-goog-ext-519733851-bin"] || EXT_BIN_HEADER,
    origin: AI_STUDIO_ORIGIN,
    referer: `${AI_STUDIO_ORIGIN}/`,
    ...dynamic,
  };
  if (!headers.cookie && cookieHeader) headers.cookie = cookieHeader;
  return headers;
}

/** turn OpenAI chat messages into AI Studio contents [[[parts], role]] */
export function buildContents(messages) {
  const contents = [];
  const systemParts = [];
  for (const message of messages || []) {
    const role = String(message?.role || "user");
    const text = contentToText(message?.content);
    if (!text) continue;
    if (role === "system" || role === "developer") {
      systemParts.push([null, text]);
      continue;
    }
    contents.push([[[null, text]], role === "assistant" ? "model" : "user"]);
  }
  if (!contents.length) throw new Error("messages contain no text content");
  return {
    contents,
    systemInstruction: systemParts.length ? systemParts : null,
  };
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** generation config: field 4 max tokens, 5 temperature, 6 topP, 7 topK */
function buildGenerationConfig(body) {
  const maxTokens = clampInt(body?.max_tokens ?? body?.max_completion_tokens, 1, 65536);
  const temperature = clampNumber(body?.temperature, 0, 2);
  const topP = clampNumber(body?.top_p, 0, 1);
  const topK = clampInt(body?.top_k, 0, 1000);
  if (maxTokens == null && temperature == null && topP == null && topK == null) return null;
  return [null, null, null, maxTokens ?? null, temperature ?? null, topP ?? null, topK ?? null];
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function clampInt(value, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/**
 * Build the request wire. `wire[4]` stays empty until the signer returns a
 * proof bound to `binding` (= sha256 input).
 */
export function buildGenerateWire(model, body, { proof = null } = {}) {
  if (!model || !model.upstream) throw new Error("unknown AI Studio model");
  const { contents, systemInstruction } = buildContents(body?.messages);
  const wire = [model.upstream, contents, null, buildGenerationConfig(body), proof];
  if (systemInstruction) wire[5] = [systemInstruction, "user"];
  return { wire, binding: buildBinding(contents) };
}

/** WAA digest input: all part texts joined by single spaces. */
export function buildBinding(contents) {
  const pieces = [];
  for (const content of contents || []) {
    for (const part of content?.[0] || []) {
      if (Array.isArray(part) && typeof part[1] === "string") pieces.push(part[1]);
    }
  }
  return pieces.join(" ");
}

/** One decoded upstream frame, tolerant of unknown/extra slots. */
export function parseFrame(frame) {
  const out = { text: "", thoughts: "", finishReason: null, usage: null };
  if (!Array.isArray(frame)) return out;
  const candidates = frame[0];
  const candidate = Array.isArray(candidates) && Array.isArray(candidates[0]) ? candidates[0] : null;
  if (candidate) {
    if (Number.isInteger(candidate[1])) out.finishReason = candidate[1];
    const content = candidate[0];
    const parts = Array.isArray(content) && Array.isArray(content[0]) ? content[0] : [];
    const texts = [];
    const thoughts = [];
    for (const part of parts) {
      if (!Array.isArray(part) || typeof part[1] !== "string") continue;
      if (part[10] === 1 || part[10] === true) thoughts.push(part[1]);
      else texts.push(part[1]);
    }
    out.text = texts.join("");
    out.thoughts = thoughts.join("");
  }
  const usage = frame[2];
  if (Array.isArray(usage)) {
    out.usage = {
      promptTokens: numberOr0(usage[0]),
      completionTokens: numberOr0(usage[1]),
      totalTokens: numberOr0(usage[2]),
      cachedTokens: numberOr0(usage[3]),
      toolTokens: numberOr0(usage[7]),
      reasoningTokens: numberOr0(usage[9]),
    };
  }
  return out;
}

function numberOr0(value) {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Incremental decoder for the streaming JSON array response.
 * The upstream may prefix the payload with `)]}'`; frames arrive as items of
 * `root[0]`, and each frame is a complete JSON array once its closing bracket
 * lands. `push(chunk)` returns the frames completed by that chunk.
 */
export class FrameStream {
  constructor() {
    this.buffer = "";
    this.started = false;
    this.framesStart = -1;
    this.cursor = 0;
    this.depth = 0;
    this.frameStart = -1;
    this.frames = [];
    this.done = false;
    this.inString = false;
    this.escaped = false;
  }

  push(chunk) {
    this.buffer += String(chunk || "");
    if (!this.started) {
      const root = this.buffer.indexOf("[");
      if (root < 0) return [];
      this.started = true;
      this.cursor = root + 1;
    }
    if (this.framesStart < 0) {
      const idx = this.buffer.indexOf("[", this.cursor);
      if (idx < 0) return [];
      const before = this.buffer.slice(this.cursor, idx).replace(/[\s,]/g, "");
      if (before !== "") return [];
      this.framesStart = idx;
      this.cursor = idx + 1;
      this.depth = 0;
    }
    let i = this.cursor;
    while (i < this.buffer.length) {
      const ch = this.buffer[i];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === "\\") this.escaped = true;
        else if (ch === '"') this.inString = false;
        i += 1;
        continue;
      }
      if (ch === '"') {
        this.inString = true;
        i += 1;
        continue;
      }
      if (ch === "[") {
        if (this.depth === 0) this.frameStart = i;
        this.depth += 1;
      } else if (ch === "]") {
        this.depth -= 1;
        if (this.depth === 0 && this.frameStart >= 0) {
          const raw = this.buffer.slice(this.frameStart, i + 1);
          this.frameStart = -1;
          try {
            const frame = JSON.parse(raw);
            if (Array.isArray(frame)) this.frames.push(parseFrame(frame));
          } catch {
            // incomplete or malformed frame: ignore, the stream can still finish
          }
        } else if (this.depth < 0) {
          this.done = true;
          i += 1;
          break;
        }
      }
      i += 1;
    }
    this.cursor = i;
    const fresh = this.frames;
    this.frames = [];
    return fresh;
  }
}

// ---------------------------------------------------------------------------
// Account probing: tier + catalog from a signed-in AI Studio browser session.
// These two RPCs only need the SAPISIDHASH cookie auth, not a WAA proof.
// ---------------------------------------------------------------------------

export const LIST_MODELS_RPC =
  "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ListModels";
export const BENEFIT_TIER_RPC =
  "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GetAiStudioBenefitTier";

/** Build `SAPISIDHASH ...` from the browser cookies (origin aistudio.google.com). */
export function sapisidHeader(cookieString, { origin = AI_STUDIO_ORIGIN } = {}) {
  const cookies = typeof cookieString === "string" ? parseCookieHeader(cookieString) : cookieString || {};
  const sapisid = cookies.SAPISID || cookies["__Secure-1PAPISID"] || cookies["__Secure-3PAPISID"] || "";
  if (!sapisid) return "";
  return sapisidHashes(sapisid, origin, cookies).join(" ");
}

function sapisidHashes(sapisid, origin, cookies) {
  const ts = Math.floor(Date.now() / 1000);
  const hex = createHash("sha1").update(`${ts} ${sapisid} ${origin}`).digest("hex");
  const parts = [`SAPISIDHASH ${ts}_${hex}`];
  if (cookies["__Secure-1PAPISID"]) {
    const hash1 = createHash("sha1").update(`${ts} ${cookies["__Secure-1PAPISID"]} ${origin}`).digest("hex");
    parts.push(`SAPISID1PHASH ${ts}_${hash1}`);
  }
  if (cookies["__Secure-3PAPISID"]) {
    const hash3 = createHash("sha1").update(`${ts} ${cookies["__Secure-3PAPISID"]} ${origin}`).digest("hex");
    parts.push(`SAPISID3PHASH ${ts}_${hash3}`);
  }
  return parts;
}

const BENEFIT_TIERS = {
  0: { label: "Free", tier: "" },
  1: { label: "Pro", tier: "TIER1" },
  2: { label: "Ultra", tier: "TIER2" },
  3: { label: "Plus", tier: "TIER0" },
};

export function tierFromBenefit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !(n in BENEFIT_TIERS)) return { raw: "", label: "", tier: "" };
  const hit = BENEFIT_TIERS[n];
  return { raw: n, label: hit.label, tier: hit.tier };
}

/** Tier gate for a few paid upstream ids (Free can still try, upstream decides). */
export function studioRequiredTier(upstream) {
  const id = String(upstream || "").toLowerCase();
  if (/carbon|veo|imagen|omni/.test(id)) return "Ultra";
  if (/neon|argon|3\.1-pro|-pro/.test(id)) return "Pro";
  return "Free";
}

async function postRpc(url, body, headers, { signal, timeoutMs = 25000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: combined,
  });
  const text = await response.text();
  return { status: response.status, text };
}

function collectModelNames(value, out = new Set()) {
  if (typeof value === "string") {
    if (/^models\//.test(value)) out.add(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectModelNames(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectModelNames(item, out);
  }
  return out;
}

function isChatModel(upstream) {
  const id = upstream.toLowerCase();
  return /gemini/.test(id) && !/embedding|aqa|imagen|veo|tts|live|audio|image/.test(id);
}

function firstInteger(value, depth = 0) {
  if (depth > 6) return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = firstInteger(item, depth + 1);
      if (hit != null) return hit;
    }
  }
  return null;
}

/**
 * Validate an AI Studio cookie and return `{ok, models, benefit, tier, tierLabel, error?}`.
 * `models` is the list of `models/...` upstream ids visible to this account.
 */
export async function fetchAiStudioAccount({ cookie, signal } = {}) {
  const auth = sapisidHeader(cookie);
  if (!auth) return { ok: false, models: [], error: "Cookie 里没有 SAPISID，无法校验 AI Studio 登录态" };
  const headers = {
    authorization: auth,
    "content-type": "application/json",
    "x-user-agent": "grpc-web-javascript/0.1",
    "x-goog-api-key": PUBLIC_WEB_API_KEY,
    origin: AI_STUDIO_ORIGIN,
    referer: `${AI_STUDIO_ORIGIN}/`,
    cookie: String(cookie || ""),
  };
  const looksLikeLogin = (text) =>
    /<!doctype html/i.test(String(text).slice(0, 200)) || /accounts\.google\.com\/v3\/signin/.test(String(text));
  const rpc = (url) => postRpc(url, [null], headers, { signal, timeoutMs: 20000 });
  let listed;
  let tierRes;
  try {
    [listed, tierRes] = await Promise.all([
      rpc(LIST_MODELS_RPC).catch((error) => ({ status: 0, text: "", transport: error.message })),
      rpc(BENEFIT_TIER_RPC).catch((error) => ({ status: 0, text: "", transport: error.message })),
    ]);
  } catch (error) {
    return { ok: false, models: [], error: `连接 AI Studio 失败：${error.message}` };
  }
  for (const response of [listed, tierRes]) {
    if (response.status === 401 || response.status === 403) {
      return { ok: false, models: [], error: `AI Studio Cookie 无效或已过期（HTTP ${response.status}）` };
    }
    if (response.status === 200 && looksLikeLogin(response.text)) {
      return { ok: false, models: [], error: "AI Studio Cookie 无效或已过期（被重定向到 Google 登录页）" };
    }
  }
  let models = [];
  let benefit = null;
  if (listed.status === 200) {
    try {
      models = [...collectModelNames(JSON.parse(listed.text.replace(/^\)\]\}'/, "")))].filter(isChatModel);
    } catch {
      models = [];
    }
  }
  if (tierRes.status === 200) {
    try {
      benefit = firstInteger(JSON.parse(tierRes.text.replace(/^\)\]\}'/, "")));
    } catch {
      benefit = null;
    }
  }
  if (!models.length && benefit == null) {
    const detail = listed.transport || tierRes.transport;
    return {
      ok: false,
      models: [],
      error: detail
        ? `连接 AI Studio 失败：${detail}`
        : "Cookie 有效但读不到账号信息（ListModels/BenefitTier 均为空），请重新登录 aistudio.google.com 后再试",
    };
  }
  const tier = tierFromBenefit(benefit);
  return {
    ok: true,
    models,
    benefit,
    tier: tier.tier,
    tierLabel: tier.label,
  };
}
