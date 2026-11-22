import crypto from "node:crypto";
import { config } from "./config.js";
import { decryptString, encryptString } from "./crypto.js";
import { exchangeToken, mintBearer } from "./gpsoauth.js";
import {
  UpstreamError,
  ensureProject,
  extractProjectId,
  loadCodeAssist,
  pickTier,
} from "./google.js";
import { store } from "./store.js";
import { parseCookieJar, probeWebCookie } from "./googleweb.js";
import { fetchAiStudioAccount, prepareCookies } from "./aistudio.js";

const TOKEN_SKEW_MS = 5 * 60 * 1000;

function fail(message, cause) {
  const error = new Error(message);
  if (cause) error.cause = cause;
  return error;
}

function robinOptions(cred) {
  return {
    scopes: cred.scopes || config.robinScopes,
    app: cred.app || config.robinApp,
    clientSig: cred.clientSig || config.robinClientSig,
  };
}

function storeToken(cred, accessToken, expiresAt) {
  const next = { ...cred, accessToken, accessExpiresAt: expiresAt };
  store.saveCredential(next);
  return { accessToken, expiresAt };
}

/**
 * Returns a valid access token for a stored credential, refreshing or minting
 * it when it is missing or about to expire.
 *
 * @param {object} cred raw credential record (from store.rawCredential)
 * @returns {Promise<{accessToken: string, expiresAt: number, minted: boolean}>}
 */
export async function ensureAccessToken(cred) {
  if (!cred) throw fail("credential not found");
  if (cred.accessToken && cred.accessExpiresAt && cred.accessExpiresAt > Date.now() + TOKEN_SKEW_MS) {
    return { accessToken: cred.accessToken, expiresAt: cred.accessExpiresAt, minted: false };
  }

  if (!cred.masterTokenEnc) {
    throw fail("robin credential has no master token; import it again with an oauth_token");
  }
  const masterToken = decryptString(cred.masterTokenEnc, config.dataDir);
  const minted = await mintBearer(cred.email, masterToken, cred.androidId, robinOptions(cred));
  const expiresAt = minted.expiryEpochSeconds
    ? Math.max(Date.now() + 60_000, minted.expiryEpochSeconds * 1000 - TOKEN_SKEW_MS)
    : Date.now() + 55 * 60 * 1000;
  const result = storeToken(cred, minted.token, expiresAt);
  return { ...result, minted: true };
}

async function resolveProjectForToken(accessToken, cred) {
  try {
    const { projectId, tier } = await ensureProject(accessToken, { ...cred, projectId: "" });
    const next = { ...store.rawCredential(cred.id), projectId, tier };
    store.saveCredential(next);
    return { projectId, tier };
  } catch (error) {
    return { projectId: "", tier: "", warning: `project lookup failed: ${error.message}` };
  }
}

/**
 * Force a token refresh and a Code Assist probe, updating cached metadata.
 */
export async function testCredential(id) {
  const cred = store.rawCredential(id);
  if (!cred) throw fail("credential not found");
  if (cred.type === "aistudio") {
    const cookie = decryptString(cred.cookieEnc, config.dataDir);
    const account = await fetchAiStudioAccount({ cookie });
    if (!account.ok) {
      store.markError(id, account.error);
      throw new UpstreamError(account.error, { status: 400, code: "cookie_rejected" });
    }
    store.saveCredential({
      ...cred,
      tier: account.tier,
      tierLabel: account.tierLabel,
      benefit: account.benefit,
      models: account.models,
      lastError: null,
    });
    store.markOk(id);
    return {
      ok: true,
      credential: store.getCredential(id),
      probe: { tier: account.tierLabel || "Free", models: account.models.length },
    };
  }
  if (!cred.webCookieEnc) {
    throw new UpstreamError("这条凭证没有 Gemini 网页版 Cookie，请重新导入", { status: 400, code: "no_cookie" });
  }
  const probe = await probeWebCookie(decryptString(cred.webCookieEnc, config.dataDir));
  if (!probe.ok) {
    const message = `Cookie 未被 Gemini 接受（HTTP ${probe.status}${probe.location ? ` -> ${probe.location.slice(0, 120)}` : ""}）`;
    store.markError(id, message);
    throw new UpstreamError(message, { status: 400, code: "cookie_rejected" });
  }
  store.markOk(id);
  return { ok: true, credential: store.getCredential(id), probe: { status: probe.status, cookies: probe.cookieCount } };
}

/**
 * Import a Gemini web session straight from the browser. The server never sees
 * the account password; it only stores the cookie jar the browser already has.
 * This is the only credential source this deployment accepts: Google refuses
 * web sessions minted from a master token.
 */
export async function importWebCookie({ email = "", cookie, label = "" }) {
  const raw = String(cookie || "").trim();
  if (!raw) throw new UpstreamError("缺少 Cookie 内容", { status: 400, code: "empty_cookie" });
  const jar = parseCookieJar(raw);
  const names = jar.map((item) => item.split("=")[0]);
  if (!names.some((n) => n === "SID" || n === "__Secure-1PSID")) {
    throw new UpstreamError("Cookie 里缺少 SID / __Secure-1PSID，不是有效的 Google 登录态", { status: 400, code: "cookie_no_sid" });
  }
  const probe = await probeWebCookie(raw);
  if (!probe.ok) {
    throw new UpstreamError(
      `Cookie 未被 Gemini 接受（HTTP ${probe.status}${probe.location ? ` -> ${probe.location}` : ""}）`,
      { status: 400, code: "cookie_rejected" },
    );
  }
  const credential = store.upsertCredential({
    type: "robin",
    group: "robin",
    email,
    label,
    webCookie: raw,
    status: "active",
    lastError: null,
  });
  return { ok: true, credential, probe: { status: probe.status, cookies: probe.cookieCount } };
}

/**
 * Import an AI Studio session (email + aistudio.google.com cookie). The cookie
 * is validated against ListModels/GetAiStudioBenefitTier before it is stored;
 * the returned catalog is what `/v1/models` advertises for this account.
 */
export async function importAistudio({ email = "", cookie, label = "" }) {
  const raw = String(cookie || "").trim();
  if (!raw) throw new UpstreamError("缺少 Cookie 内容", { status: 400, code: "empty_cookie" });
  const prepared = prepareCookies(raw);
  if (!prepared.ok) {
    throw new UpstreamError(
      `Cookie 缺少必要字段（${prepared.missing.join(", ")}）：请从已登录的 aistudio.google.com 复制完整 Cookie`,
      { status: 400, code: "cookie_incomplete" },
    );
  }
  const account = await fetchAiStudioAccount({ cookie: prepared.header });
  if (!account.ok) {
    throw new UpstreamError(account.error || "AI Studio Cookie 校验失败", { status: 400, code: "cookie_rejected" });
  }
  const credential = store.upsertCredential({
    type: "aistudio",
    group: "aistudio",
    email,
    label,
    cookie: prepared.header,
    tier: account.tier,
    tierLabel: account.tierLabel,
    benefit: account.benefit,
    models: account.models,
    projectId: "aistudio",
    status: "active",
    lastError: null,
  });
  return {
    ok: true,
    credential,
    account: { tier: account.tierLabel || "Free", models: account.models },
  };
}
