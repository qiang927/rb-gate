import https from "node:https";
import crypto from "node:crypto";
import { mintBearer } from "./gpsoauth.js";

const OAUTH_LOGIN_SERVICE = "https://www.google.com/accounts/OAuthLogin";
const DEFAULT_WEB_APP = "com.google.android.apps.chromecast.app";
const DEFAULT_WEB_SIG = "24bb24c05e47e0aefa68a58a766179d9b613a600";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

export const WEB_MODELS = {
  "web-gemini-3.7-flash": { mode: 1, think: 4, label: "Gemini 3.7 Flash (Web)" },
  "web-gemini-3.5-flash-thinking": { mode: 2, think: 0, label: "Gemini 3.5 Flash Thinking (Web)" },
  "web-gemini-3.1-pro": { mode: 3, think: 4, label: "Gemini 3.1 Pro (Web)" },
  "web-gemini-auto": { mode: 4, think: 4, label: "Gemini Auto (Web)" },
  "web-gemini-flash-lite": { mode: 6, think: 4, label: "Gemini Flash-Lite (Web)" },
};

export function lookupWebModel(id) {
  return WEB_MODELS[id] || null;
}

export function isWebModel(id) {
  return Boolean(WEB_MODELS[id]);
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

function request(url, { method = "GET", headers = {}, body = null, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
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

export class GoogleWebSession {
  constructor({ email, masterToken, androidId, app = DEFAULT_WEB_APP, clientSig = DEFAULT_WEB_SIG }) {
    this.email = email;
    this.masterToken = masterToken;
    this.androidId = androidId;
    this.app = app;
    this.clientSig = clientSig;
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
      "https://accounts.google.com/MergeSession?service=mail&continue=https://www.google.com&uberauth=" + encodeURIComponent(uberauth)
    );
    const cookies = (merge.headers["set-cookie"] || []).map((c) => c.split(";")[0]);
    if (!cookies.some((c) => c.startsWith("SID="))) {
      throw new WebError(`MergeSession did not return SID cookie (${merge.status})`, { code: "merge_session_failed", retryable: true });
    }
    this.cookies = cookies;
    this.cookiesAt = Date.now();
    return cookies;
  }

  async ensureCookies({ force = false } = {}) {
    if (!force && this.cookies && Date.now() - this.cookiesAt < 6 * 60 * 60 * 1000) return this.cookies;
    return this.#mintCookies();
  }

  async bootstrap({ force = false } = {}) {
    if (!force && this.tokens && Date.now() - this.tokens.at < 30 * 60 * 1000) return this.tokens;
    await this.ensureCookies();
    const cookie = this.cookies.join("; ");
    const page = await request("https://gemini.google.com/app", { headers: { cookie } });
    if (page.status !== 200) {
      await this.ensureCookies({ force: true });
      throw new WebError(`gemini page failed (${page.status})`, { code: "page_failed", retryable: true });
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
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        yield* consume(line);
      }
    }
    if (buffer.trim()) yield* consume(buffer);
  }

  async complete(prompt, options = {}) {
    let out = "";
    for await (const delta of this.chat(prompt, options)) out += delta;
    return out;
  }
}
