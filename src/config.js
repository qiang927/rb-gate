import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "..");

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: int(process.env.PORT, 8787),
  host: process.env.HOST || "0.0.0.0",
  dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, "data")),
  publicDir: path.join(ROOT_DIR, "public"),

  // Admin console password. Empty => generated on first boot into data/admin.json.
  adminPassword: process.env.ADMIN_PASSWORD || "",
  // Session secret for admin cookies. Empty => generated into data/secret.key.
  sessionSecret: process.env.SESSION_SECRET || "",

  // Gateway API keys (OpenAI-style). Empty => generated into data/api-keys.json.
  apiKeys: (process.env.GATEWAY_API_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  upstreamBase: (process.env.UPSTREAM_BASE || "https://cloudcode-pa.googleapis.com").replace(/\/+$/, ""),
  dailyUpstreamBase: (process.env.DAILY_UPSTREAM_BASE || "https://daily-cloudcode-pa.googleapis.com").replace(/\/+$/, ""),
  apiVersion: process.env.UPSTREAM_API_VERSION || "v1internal",

  // gpsoauth client identity used to mint a bearer from a master token.
  // Defaults mirror the Chromecast identity used by notebooklm-py's master-token flow.
  robinApp: process.env.ROBIN_APP || "com.google.android.apps.chromecast.app",
  robinClientSig: process.env.ROBIN_CLIENT_SIG || "24bb24c05e47e0aefa68a58a766179d9b613a600",
  robinScopes: (process.env.ROBIN_SCOPES || [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/aicode",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ].join(" ")),
  // Optional extra: convert the minted bearer into a durable refresh_token via OAuth.
  autoRefreshToken: bool(process.env.ROBIN_AUTO_REFRESH, true),

  // The Antigravity OAuth client is only needed for the OAuth-code import path;
  // robin (oauth_token) import does not use it. Keep them out of git and set
  // them in your deployment environment instead.
  antigravityClientId: (process.env.ANTIGRAVITY_CLIENT_ID || "").trim(),
  antigravityClientSecret: (process.env.ANTIGRAVITY_CLIENT_SECRET || "").trim(),

  requestTimeoutMs: int(process.env.REQUEST_TIMEOUT_MS, 180_000),
  tokenRefreshSkewMs: 5 * 60_000,
  cooldownMs: int(process.env.CREDENTIAL_COOLDOWN_MS, 30_000),
  maxRetries: int(process.env.MAX_RETRIES, 3),

  defaultUserAgent:
    process.env.USER_AGENT ||
    "antigravity/hub/2.33.0 (aidev_client; os_type=darwin; arch=arm64; cl=1023160026)",
  logRequests: bool(process.env.LOG_REQUESTS, false),
};

export function ensureConfigWarnings() {
  const warnings = [];
  if (!process.env.ENCRYPTION_KEY) {
    warnings.push("ENCRYPTION_KEY not set: a local key file in DATA_DIR is used (fine for a single host, set a stable key on PaaS).");
  }
  if (!config.adminPassword) warnings.push("ADMIN_PASSWORD not set: a random one is generated on first boot and printed to the log.");
  return warnings;
}
