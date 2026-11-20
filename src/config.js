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
  robinApp: process.env.ROBIN_APP || "com.google.android.gms",
  robinClientSig: process.env.ROBIN_CLIENT_SIG || "38918a453d07199354f8b19af05ec6562ced5788",
  // Identity used only for the Gemini web channel (OAuthLogin service mint).
  // The Chromecast app is the one verified to mint an OAuthLogin bearer.
  webApp: process.env.WEB_APP || "com.google.android.apps.chromecast.app",
  webSig: process.env.WEB_SIG || "24bb24c05e47e0aefa68a58a766179d9b613a600",
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

  // Native WAA signer (Go + SpiderMonkey 152) used by the pggo channel.
  // Boxed with the container image; the gateway spawns it lazily on first use.
  waa: {
    enabled: process.env.WAA_DISABLED !== "1",
    signerPath: process.env.WAA_SIGNER_PATH || path.join(ROOT_DIR, "waa-signer", "bin", "waa-signer"),
    stateDir: process.env.WAA_STATE_DIR || path.join(path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, "data")), "waa"),
    proxy: (process.env.WAA_PROXY || "").trim(),
    readyTimeoutMs: int(process.env.WAA_READY_TIMEOUT_MS, 30_000),
    mintTimeoutMs: int(process.env.WAA_MINT_TIMEOUT_MS, 120_000),
    // AI Studio accounts carry a benefit tier; Pro/Ultra get a different
    // X-AIStudio-G1-Tier header. Free accounts need no header.
    defaultTier: (process.env.AI_STUDIO_TIER || "TIER1").trim(),
  },

  // Optional Cloudflare KV backing store: keeps credentials across restarts
  // when the host has no persistent disk (Render free tier and friends).
  kv: {
    accountId: (process.env.CF_ACCOUNT_ID || "").trim(),
    namespaceId: (process.env.CF_KV_NAMESPACE_ID || "").trim(),
    apiToken: (process.env.CF_KV_API_TOKEN || "").trim(),
    baseUrl: (process.env.CF_KV_BASE_URL || "https://api.cloudflare.com/client/v4").replace(/\/+$/, ""),
    // Usage counters (uses/lastUsedAt) are flushed less eagerly to stay well
    // inside the KV free tier write quota (1k writes/day).
    statsFlushMs: int(process.env.KV_STATS_FLUSH_MS, 300_000),
  },
};

export function ensureConfigWarnings() {
  const warnings = [];
  if (!process.env.ENCRYPTION_KEY) {
    warnings.push("ENCRYPTION_KEY not set: a local key file in DATA_DIR is used (fine for a single host, set a stable key on PaaS).");
  }
  if (!config.adminPassword) warnings.push("ADMIN_PASSWORD not set: a random one is generated on first boot and printed to the log.");
  return warnings;
}
