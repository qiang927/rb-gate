// Renewing a robin (master token) credential without asking for the password.
//
// A web oauth_token is a one-shot provisioning cookie that Google hands out in
// the EmbeddedSetupAndroid flow. It is not refreshable by design, but the flow
// itself only needs a signed-in Google session: if we still hold the account
// cookies (SID / HSID / SAPISID ...), re-running the flow issues a fresh
// oauth_token, which we can exchange for a new master token.
//
// This module performs that bootstrap. It is deliberately best-effort: Google
// may force a password check at any time, in which case the caller falls back
// to asking the user for a fresh oauth_token.

import { config } from "./config.js";
import { decryptString } from "./crypto.js";
import { UpstreamError } from "./google.js";
import { provisionRobin } from "./credentials.js";
import { store } from "./store.js";

const ANDROID_AUTH_URL =
  "https://accounts.google.com/o/android/auth?lang=en&cc=US&langCountry=en_US&xoauth_display_name=Android+Device&tmpl=new_account&source=android&return_user_id=true&flowName=EmbeddedSetupAndroid";

const DEFAULT_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

function findCookie(setCookies, name) {
  for (const line of setCookies) {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    if (index < 0) continue;
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return null;
}

/**
 * Walk the EmbeddedSetupAndroid redirect chain with an existing cookie jar and
 * return the fresh `oauth_token` cookie Google hands out, or null.
 */
export async function extractOauthToken({ cookie, signal }) {
  let url = ANDROID_AUTH_URL;
  let cookieHeader = cookie;
  for (let hop = 0; hop < 6; hop += 1) {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        cookie: cookieHeader,
        "user-agent": DEFAULT_UA,
        "accept-language": "en-US,en;q=0.9",
      },
      signal,
    });
    const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    for (const name of ["oauth_token", "__Secure-oauth_token"]) {
      const value = findCookie(setCookies, name);
      if (value && value.startsWith("oauth2_")) return { oauthToken: value, url };
    }
    const location = response.headers.get("location");
    if (!location) return { oauthToken: null, url, status: response.status };
    url = new URL(location, url).toString();
    const additions = setCookies.map((line) => line.split(";")[0]).filter(Boolean);
    if (additions.length) cookieHeader = `${cookieHeader}; ${additions.join("; ")}`;
  }
  return { oauthToken: null, url, status: 0 };
}

/** Use a pggo credential's cookies (same Google account) as the session jar. */
function sessionCookieFor(email) {
  const wanted = String(email || "").toLowerCase();
  const pggo = store
    .listCredentials()
    .map((item) => store.rawCredential(item.id))
    .filter((cred) => cred && cred.type === "pggo" && cred.cookieEnc && cred.status !== "disabled");
  const match = pggo.find((cred) => cred.email && cred.email.toLowerCase() === wanted);
  return match || pggo[0] || null;
}

/**
 * Try to renew the master token of a robin credential from stored cookies.
 * Returns {ok, reason} or {ok:true, warning, credential}.
 */
export async function renewRobinCredential(credentialId) {
  const cred = credentialId ? store.rawCredential(credentialId) : null;
  if (!cred || cred.type !== "robin") {
    throw new UpstreamError("no robin credential to renew", { status: 404, code: "credential_not_found" });
  }
  const jar = sessionCookieFor(cred.email);
  if (!jar) {
    return {
      ok: false,
      reason: "没有同账号的 pggo Cookie 可用作登录态；请先导入 AI Studio Cookie，或手动重新导入 oauth_token",
    };
  }
  const cookie = decryptString(jar.cookieEnc, config.dataDir);
  let extracted;
  try {
    extracted = await extractOauthToken({ cookie, signal: AbortSignal.timeout(60000) });
  } catch (error) {
    return { ok: false, reason: `访问 Google 登录页失败：${error.message}` };
  }
  if (!extracted.oauthToken) {
    return {
      ok: false,
      reason: "Google 没有下发新的 oauth_token（通常表示需要重新验证密码，或 AI Studio Cookie 已不包含完整登录态）",
    };
  }
  const result = await provisionRobin({
    email: cred.email,
    oauthToken: extracted.oauthToken,
    androidId: cred.androidId,
    label: cred.label,
    app: cred.app,
    clientSig: cred.clientSig,
    scopes: cred.scopes,
  });
  return { ok: true, partial: Boolean(result.partial), warning: result.warning || "", credential: result.credential };
}
