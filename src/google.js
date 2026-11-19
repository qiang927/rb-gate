import crypto from "node:crypto";
import { config } from "./config.js";

export const DEFAULT_UA =
  process.env.USER_AGENT ||
  "antigravity/hub/2.33.0 (aidev_client; os_type=darwin; arch=arm64; cl=1023160026)";
export const NODE_API_UA = "google-api-nodejs-client/10.3.0";

export class UpstreamError extends Error {
  constructor(message, { status = 0, body = "", retryAfterMs = 0, code = "" } = {}) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
}

async function request(url, { method = "GET", headers = {}, body, timeoutMs = config.requestTimeoutMs } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

export async function fetchJson(url, options = {}) {
  const res = await request(url, options);
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message || parsed?.message || message;
    } catch {
      /* keep raw snippet */
    }
    throw new UpstreamError(`upstream ${res.status}: ${message}`, {
      status: res.status,
      body: text.slice(0, 4000),
      retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError(`upstream returned non-JSON: ${text.slice(0, 200)}`, { status: res.status, body: text });
  }
}

export function parseRetryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return 0;
}

function requireOAuthClient() {
  if (!config.antigravityClientId || !config.antigravityClientSecret) {
    throw new Error("ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET are not configured");
  }
}

export function buildAuthUrl({ state, redirectUri, codeChallenge, loginHint } = {}) {
  requireOAuthClient();
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: config.antigravityClientId,
    prompt: "consent",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/aicode",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ].join(" "),
    state,
  });
  if (codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  if (loginHint) params.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function createPkcePair() {
  const verifier = crypto.randomBytes(64).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function exchangeCode({ code, redirectUri, codeVerifier }) {
  requireOAuthClient();
  const form = new URLSearchParams({
    code,
    client_id: config.antigravityClientId,
    client_secret: config.antigravityClientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (codeVerifier) form.set("code_verifier", codeVerifier);
  return fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    timeoutMs: 30_000,
  });
}

export async function refreshAccessToken(refreshToken) {
  const form = new URLSearchParams({
    client_id: config.antigravityClientId,
    client_secret: config.antigravityClientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const data = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Go-http-client/2.0" },
    body: form.toString(),
    timeoutMs: 30_000,
  });
  if (!data.access_token) throw new UpstreamError("token refresh returned no access_token", { status: 400 });
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: Number(data.expires_in || 3600),
  };
}

export async function fetchUserInfo(accessToken) {
  const data = await fetchJson("https://www.googleapis.com/oauth2/v2/userinfo?alt=json", {
    headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": DEFAULT_UA },
    timeoutMs: 20_000,
  });
  return { email: data.email || "", name: data.name || "", picture: data.picture || "" };
}

export function extractProjectId(data) {
  if (!data || typeof data !== "object") return "";
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object" && typeof value.id === "string" && value.id.trim()) return value.id.trim();
  }
  return "";
}

export function pickTier(loadResponse) {
  const tiers = Array.isArray(loadResponse?.allowedTiers) ? loadResponse.allowedTiers : [];
  const preferred = tiers.find((tier) => tier?.isDefault) || tiers[0];
  if (preferred?.id) return preferred.id;
  if (loadResponse?.currentTier?.id) return loadResponse.currentTier.id;
  return "free-tier";
}

export async function loadCodeAssist(accessToken) {
  return fetchJson(`${config.dailyUpstreamBase}/${config.apiVersion}:loadCodeAssist`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": DEFAULT_UA,
    },
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
    timeoutMs: 30_000,
  });
}

export async function onboardUser(accessToken, tierId) {
  const body = {
    tier_id: tierId,
    metadata: { ide_type: "ANTIGRAVITY", ide_version: "2.33.0", ide_name: "antigravity" },
  };
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const data = await fetchJson(`${config.dailyUpstreamBase}/${config.apiVersion}:onboardUser`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "*/*",
        "Content-Type": "application/json",
        "User-Agent": `${DEFAULT_UA} ${NODE_API_UA}`,
        "X-Goog-Api-Client": "gl-node/22.21.1",
      },
      body: JSON.stringify(body),
      timeoutMs: 30_000,
    });
    if (data?.done === true) {
      return extractProjectId(data.response || {});
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new UpstreamError("onboardUser did not complete after 5 polls", { status: 504 });
}

/**
 * Resolve the Google Cloud project used by Code Assist for this account.
 * Caches the result on the credential record.
 */
export async function ensureProject(accessToken, credential) {
  if (credential?.projectId) return { projectId: credential.projectId, tier: credential.tier || "" };
  const load = await loadCodeAssist(accessToken);
  const project = extractProjectId(load);
  const tier = load?.currentTier?.id || pickTier(load);
  if (project) return { projectId: project, tier };
  const onboarded = await onboardUser(accessToken, pickTier(load));
  if (!onboarded) throw new UpstreamError("could not resolve a Code Assist project id for this account", { status: 400 });
  return { projectId: onboarded, tier };
}
