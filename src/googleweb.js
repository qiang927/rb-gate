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

export const WEB_MODELS = {
  // The Gemini web client only exposes these five chat presets. Which backend
  // model each preset maps to is decided by Google, so we address them by mode.
  "web-gemini-4-hydrogen": { mode: 1, think: 4, label: "Gemini 4 Hydrogen (Web)" },
  "web-gemini-4-neon": { mode: 2, think: 0, label: "Gemini 4 Neon (Web)" },
  "web-gemini-4-carbon": { mode: 3, think: 4, label: "Gemini 4 Carbon (Web)" },
  "web-gemini-4-auto": { mode: 4, think: 4, label: "Gemini 4 Auto (Web)" },
  "web-gemini-4-flash-lite": { mode: 6, think: 4, label: "Gemini 4 Flash-Lite (Web)" },
};

export function lookupWebModel(id) {
  return WEB_MODELS[id] || null;
}

export function isWebModel(id) {
  return Boolean(WEB_MODELS[id]);
}

/**
 * Ask the web endpoint which presets actually answer right now. The web UI has
 * no model-list API, so the only honest check is a tiny prompt per preset.
 */
export async function probeWebModels(session, { timeoutMs = 60000 } = {}) {
  const results = [];
  for (const [id, cfg] of Object.entries(WEB_MODELS)) {
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

  #buildBody(prompt, model, { temporary = false } = {}) {
    const cfg = lookupWebModel(model) || WEB_MODELS["web-gemini-3.7-flash"];
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
    const outer = [null, JSON.stringify(inner)];
    return new URLSearchParams({ "f.req": JSON.stringify(outer) }).toString();
  }

  /**
   * Stream text deltas from Gemini web. Yields plain text chunks.
   */
  async *chat(prompt, { model = "web-gemini-3.7-flash", temporary = false } = {}) {
    const { atToken: at, bl, cookie } = await this.bootstrap();
    const body = this.#buildBody(prompt, model, { temporary });
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
