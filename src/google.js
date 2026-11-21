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
