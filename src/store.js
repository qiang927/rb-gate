import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { decryptString, encryptString, hashPassword, randomId, randomToken, sha256, verifyPassword } from "./crypto.js";
import { kvConfigured, kvGet, kvPut } from "./kv.js";
import { logInfo, logWarn } from "./logger.js";

const FILES = {
  credentials: "credentials.json",
  "api-keys": "api-keys.json",
  admin: "admin.json",
  settings: "settings.json",
};
const KV_KEYS = {
  credentials: "robin/credentials",
  "api-keys": "robin/api-keys",
  admin: "robin/admin",
  settings: "robin/settings",
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Every credential belongs to the robin channel (oauth_token -> master token). */
export function credentialGroup(cred) {
  if (!cred) return "";
  if (cred.group) return cred.group;
  return "robin";
}

function sanitizeCredential(cred, { reveal = false } = {}) {
  if (!cred) return null;
  const copy = { ...cred };
  delete copy.masterTokenEnc;
  delete copy.refreshTokenEnc;
  delete copy.cookieEnc;
  delete copy.accessToken;
  delete copy.webCookieEnc;
  copy.group = credentialGroup(cred);
  copy.hasMasterToken = Boolean(cred.masterTokenEnc);
  copy.hasWebCookie = Boolean(cred.webCookieEnc);
  if (reveal) {
    if (cred.masterTokenEnc) copy.masterToken = decryptString(cred.masterTokenEnc, config.dataDir);
    if (cred.refreshTokenEnc) copy.refreshToken = decryptString(cred.refreshTokenEnc, config.dataDir);
    if (cred.webCookieEnc) copy.webCookie = decryptString(cred.webCookieEnc, config.dataDir);
  }
  return copy;
}

class Store {
  constructor() {
    this.cache = null;
    this.apiKeyCache = null;
    this.adminCache = null;
    this.settingsCache = null;
    this._sessionSecret = "";
    this.remote = false;
    this.pending = {};
    this.timers = {};
  }

  get sessionSecret() {
    if (config.sessionSecret) return config.sessionSecret;
    // Fall back to a value derived from ENCRYPTION_KEY so admin sessions survive
    // container restarts on hosts without a persistent disk (e.g. Render free tier).
    const encryptionKey = process.env.ENCRYPTION_KEY?.trim();
    if (encryptionKey) {
      return crypto.createHmac("sha256", encryptionKey).update("robin/session/v1").digest("hex");
    }
    if (this._sessionSecret) return this._sessionSecret;
    try {
      this._sessionSecret = fs.readFileSync(path.join(config.dataDir, "session.secret"), "utf8").trim();
    } catch {
      this._sessionSecret = "";
    }
    if (!this._sessionSecret) {
      this._sessionSecret = crypto.randomBytes(48).toString("hex");
      try {
        fs.mkdirSync(config.dataDir, { recursive: true });
        fs.writeFileSync(path.join(config.dataDir, "session.secret"), this._sessionSecret + "\n", { mode: 0o600 });
      } catch {
        // ephemeral filesystem — the derived/random value still works for this process
      }
    }
    return this._sessionSecret;
  }

  // ---------- Storage backends ----------

  /**
   * Load state from Cloudflare KV (when configured) and mirror it into the
   * local files. On the first run against an empty KV namespace the current
   * local files are migrated up, so switching a live deployment is painless.
   */
  async init() {
    // Force the file-backed getters to hydrate so we can compare/migrate.
    this.credentials();
    this.apiKeys();
    this.settings();
    const localAdmin = readJson(path.join(config.dataDir, FILES["admin"]), null);
    if (localAdmin) this.adminCache = localAdmin;

    if (!kvConfigured()) {
      logInfo("store: local file mode (set CF_ACCOUNT_ID / CF_KV_NAMESPACE_ID / CF_KV_API_TOKEN to enable Cloudflare KV)");
      return;
    }
    this.remote = true;
    logInfo(`store: Cloudflare KV mode (namespace ${config.kv.namespaceId.slice(0, 8)}…)`);
    for (const name of Object.keys(FILES)) {
      try {
        const raw = await kvGet(KV_KEYS[name]);
        if (raw) {
          const data = JSON.parse(raw);
          this.applyRemote(name, data);
          this.mirrorLocal(name, data);
        } else {
          const local = this.snapshot(name);
          if (local) {
            await kvPut(KV_KEYS[name], JSON.stringify(local));
            logInfo(`store: migrated ${name} to KV`);
          }
        }
      } catch (error) {
        logWarn(`store: KV load failed for ${name}: ${error.message} — keeping local files`);
      }
    }
  }

  applyRemote(name, data) {
    if (name === "credentials") this.cache = Array.isArray(data.credentials) ? data.credentials : [];
    else if (name === "api-keys") this.apiKeyCache = Array.isArray(data.keys) ? data.keys : null;
    else if (name === "admin") this.adminCache = data;
    else if (name === "settings") this.settingsCache = data;
  }

  snapshot(name) {
    if (name === "credentials") return { credentials: this.credentials() };
    if (name === "api-keys") return { keys: this.apiKeys().filter((entry) => entry.source !== "env") };
    if (name === "admin") return this.adminCache || readJson(path.join(config.dataDir, FILES["admin"]), null);
    if (name === "settings") return this.settingsCache || null;
    return null;
  }

  mirrorLocal(name, data) {
    try {
      writeJsonAtomic(path.join(config.dataDir, FILES[name]), data);
    } catch {
      // read-only or missing /data — KV is the source of truth anyway
    }
  }

  /** Write-through: local file mirror + (debounced) KV push. */
  persist(name, data, { immediate = false } = {}) {
    this.mirrorLocal(name, data);
    if (this.remote) this.scheduleRemote(name, data, immediate ? 0 : 400);
  }

  scheduleRemote(name, data, delayMs = 400) {
    this.pending[name] = data;
    const existing = this.timers[name];
    if (existing && delayMs > 0) return;
    if (existing) clearTimeout(existing);
    this.timers[name] = setTimeout(() => {
      this.timers[name] = null;
      void this.flushRemote(name);
    }, delayMs);
    this.timers[name].unref?.();
  }

  async flushRemote(name) {
    const data = this.pending[name];
    if (!data) return;
    this.pending[name] = null;
    try {
      await kvPut(KV_KEYS[name], JSON.stringify(data));
    } catch (error) {
      logWarn(`store: KV write failed for ${name}: ${error.message}`);
    }
  }

  /** Flush every pending write (called on shutdown). */
  async flush() {
    for (const name of Object.keys(this.timers)) {
      if (this.timers[name]) {
        clearTimeout(this.timers[name]);
        this.timers[name] = null;
      }
    }
    await Promise.all(Object.keys(this.pending).map((name) => this.flushRemote(name)));
  }

  listApiKeys() {
    return this.apiKeys().map(({ id, name, key, createdAt, source }) => ({ id, name, key, createdAt, source }));
  }

  // ---------- API keys ----------
  apiKeys() {
    if (this.apiKeyCache) return this.apiKeyCache;
    if (config.apiKeys.length) {
      this.apiKeyCache = config.apiKeys.map((key) => ({
        id: `env_${sha256(key).slice(0, 8)}`,
        name: "environment",
        key,
        hash: sha256(key),
        createdAt: new Date().toISOString(),
        source: "env",
      }));
      return this.apiKeyCache;
    }
    let data = readJson(path.join(config.dataDir, FILES["api-keys"]), null);
    if (!data || !Array.isArray(data.keys) || data.keys.length === 0) {
      const key = `sk-robin-${randomToken(24)}`;
      data = { keys: [{ id: randomId("key"), name: "default", key, hash: sha256(key), createdAt: new Date().toISOString() }] };
      this.persist("api-keys", data, { immediate: true });
    }
    this.apiKeyCache = data.keys;
    return this.apiKeyCache;
  }

  findApiKey(raw) {
    if (!raw) return null;
    const hash = sha256(raw);
    return this.apiKeys().find((entry) => entry.hash === hash) || null;
  }

  addApiKey(name) {
    if (config.apiKeys.length) {
      throw new Error("API keys are managed by the GATEWAY_API_KEYS environment variable");
    }
    const key = `sk-robin-${randomToken(24)}`;
    const entry = { id: randomId("key"), name: name || "new key", key, hash: sha256(key), createdAt: new Date().toISOString() };
    const keys = [...this.apiKeys().filter((item) => item.source !== "env"), entry];
    this.apiKeyCache = keys;
    this.persist("api-keys", { keys }, { immediate: true });
    return entry;
  }

  removeApiKey(id) {
    if (config.apiKeys.length) throw new Error("API keys are managed by the GATEWAY_API_KEYS environment variable");
    const before = this.apiKeys().length;
    this.apiKeyCache = this.apiKeys().filter((entry) => entry.id !== id);
    this.persist("api-keys", { keys: this.apiKeyCache }, { immediate: true });
    return before !== this.apiKeyCache.length;
  }

  // ---------- Admin ----------
  admin() {
    if (config.adminPassword) {
      return { passwordStored: hashPassword(config.adminPassword), generated: false, source: "env" };
    }
    if (this.adminCache) return this.adminCache;
    let data = readJson(path.join(config.dataDir, FILES["admin"]), null);
    if (!data || !data.passwordStored) {
      const password = randomToken(9);
      data = { passwordStored: hashPassword(password), plaintextOnce: password, generated: true };
      this.persist("admin", data, { immediate: true });
    }
    this.adminCache = data;
    return data;
  }

  adminSource() {
    return config.adminPassword ? "env" : "file";
  }

  /** Replace the stored admin password (ignored when ADMIN_PASSWORD is set). */
  setAdminPassword(password) {
    const data = this.adminCache || readJson(path.join(config.dataDir, FILES["admin"]), null) || {};
    const next = { ...data, passwordStored: hashPassword(password), generated: false, updatedAt: Date.now() };
    delete next.plaintextOnce;
    this.adminCache = next;
    this.persist("admin", next, { immediate: true });
    return next;
  }

  verifyAdminPassword(password) {
    if (config.adminPassword) return verifyPassword(password, hashPassword(config.adminPassword));
    const data = this.adminCache || readJson(path.join(config.dataDir, FILES["admin"]), null);
    return verifyPassword(password, data?.passwordStored);
  }

  // ---------- Settings ----------
  settings() {
    if (this.settingsCache) return this.settingsCache;
    this.settingsCache = readJson(path.join(config.dataDir, FILES["settings"]), {
      gatewayModelAliases: {},
      upstreamBase: config.upstreamBase,
      locale: "zh",
    });
    return this.settingsCache;
  }

  updateSettings(patch) {
    const next = { ...this.settings(), ...patch };
    this.settingsCache = next;
    this.persist("settings", next, { immediate: true });
    return next;
  }

  // ---------- Credentials ----------
  credentials() {
    if (!this.cache) {
      const data = readJson(path.join(config.dataDir, FILES["credentials"]), { credentials: [] });
      this.cache = Array.isArray(data.credentials) ? data.credentials : [];
    }
    return this.cache;
  }

  listCredentials({ reveal = false } = {}) {
    return this.credentials().map((cred) => sanitizeCredential(cred, { reveal }));
  }

  getCredential(id, { reveal = false } = {}) {
    return sanitizeCredential(this.credentials().find((cred) => cred.id === id), { reveal });
  }

  rawCredential(id) {
    return this.credentials().find((cred) => cred.id === id) || null;
  }

  saveCredential(cred) {
    const list = this.credentials();
    const index = list.findIndex((item) => item.id === cred.id);
    const stored = { ...cred };
    if (index >= 0) list[index] = stored;
    else list.push(stored);
    this.persist("credentials", { credentials: list }, { immediate: true });
    return sanitizeCredential(stored);
  }

  upsertCredential(input) {
    const sameType = (cred) => !input.type || cred.type === input.type;
    const cohort = this.credentials().filter(sameType);
    const existing = this.credentials().find(
      (cred) =>
        cred.id === input.id ||
        (input.email &&
          cred.email &&
          cred.email.toLowerCase() === input.email.toLowerCase() &&
          sameType(cred)) ||
        // Cookie-only imports often omit the email; reuse the sole credential
        // instead of piling up a new one on every re-import.
        (!input.email && cohort.length === 1 && sameType(cred)),
    );
    const now = new Date().toISOString();
    const cred = {
      id: existing?.id || randomId("cred"),
      email: input.email || existing?.email || "",
      label: input.label || existing?.label || "",
      type: input.type || existing?.type || "robin",
      group: input.group || existing?.group || credentialGroup({ type: input.type || existing?.type || "robin" }),
      androidId: input.androidId || existing?.androidId || randomHex(16),
      app: input.app || existing?.app || config.robinApp,
      clientSig: input.clientSig || existing?.clientSig || config.robinClientSig,
      scopes: input.scopes || existing?.scopes || config.robinScopes,
      projectId: input.projectId ?? existing?.projectId ?? "",
      tier: input.tier ?? existing?.tier ?? "",
      accessToken: input.accessToken ?? existing?.accessToken ?? "",
      accessExpiresAt: input.accessExpiresAt ?? existing?.accessExpiresAt ?? 0,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt || null,
      lastError: input.lastError ?? existing?.lastError ?? null,
      status: input.status || existing?.status || "active",
      cooldownUntil: input.cooldownUntil ?? existing?.cooldownUntil ?? 0,
      uses: existing?.uses || 0,
      failures: input.failures ?? existing?.failures ?? 0,
      // Secrets are only rewritten when explicitly supplied.
      masterTokenEnc: input.masterToken ? encryptString(input.masterToken, config.dataDir) : existing?.masterTokenEnc || "",
      webCookieEnc: input.webCookie ? encryptString(input.webCookie, config.dataDir) : existing?.webCookieEnc || "",
    };
    if (cred.type === "robin" && !cred.masterTokenEnc && !cred.webCookieEnc) {
      throw new Error("robin credential requires a master token or an oauth_token to exchange");
    }
    this.saveCredential(cred);
    return sanitizeCredential(cred);
  }

  deleteCredential(id) {
    const list = this.credentials();
    const index = list.findIndex((cred) => cred.id === id);
    if (index < 0) return false;
    list.splice(index, 1);
    this.persist("credentials", { credentials: list }, { immediate: true });
    return true;
  }

  markUsed(id) {
    const cred = this.rawCredential(id);
    if (!cred) return;
    cred.lastUsedAt = new Date().toISOString();
    cred.uses = (cred.uses || 0) + 1;
    if (this.remote) {
      // Counters are not worth a KV write per request: batch them.
      this.scheduleRemote("credentials", { credentials: this.credentials() }, config.kv.statsFlushMs);
      try {
        writeJsonAtomic(path.join(config.dataDir, FILES["credentials"]), { credentials: this.credentials() });
      } catch {
        // ignore
      }
    } else {
      this.persist("credentials", { credentials: this.credentials() });
    }
  }

  markError(id, message, { cooldownMs = config.cooldownMs } = {}) {
    const cred = this.rawCredential(id);
    if (!cred) return;
    cred.lastError = String(message).slice(0, 2000);
    cred.failures = (cred.failures || 0) + 1;
    cred.status = "error";
    cred.cooldownUntil = Date.now() + cooldownMs;
    this.persist("credentials", { credentials: this.credentials() }, { immediate: true });
  }

  markOk(id) {
    const cred = this.rawCredential(id);
    if (!cred) return;
    cred.lastError = null;
    cred.failures = 0;
    cred.status = "active";
    cred.cooldownUntil = 0;
    this.persist("credentials", { credentials: this.credentials() }, { immediate: true });
  }
}

export function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

export const store = new Store();
