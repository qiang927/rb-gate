import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { decryptString, encryptString, hashPassword, randomId, randomToken, sha256, verifyPassword } from "./crypto.js";

const CREDENTIALS_FILE = () => path.join(config.dataDir, "credentials.json");
const API_KEYS_FILE = () => path.join(config.dataDir, "api-keys.json");
const ADMIN_FILE = () => path.join(config.dataDir, "admin.json");
const SETTINGS_FILE = () => path.join(config.dataDir, "settings.json");
const SESSION_SECRET_FILE = () => path.join(config.dataDir, "session.secret");

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

function sanitizeCredential(cred, { reveal = false } = {}) {
  if (!cred) return null;
  const copy = { ...cred };
  delete copy.masterTokenEnc;
  delete copy.refreshTokenEnc;
  delete copy.accessToken;
  if (reveal) {
    if (cred.masterTokenEnc) copy.masterToken = decryptString(cred.masterTokenEnc, config.dataDir);
    if (cred.refreshTokenEnc) copy.refreshToken = decryptString(cred.refreshTokenEnc, config.dataDir);
  }
  return copy;
}

class Store {
  constructor() {
    this.cache = null;
    this.apiKeyCache = null;
    this.settingsCache = null;
    this._sessionSecret = "";
  }

  get sessionSecret() {
    if (config.sessionSecret) return config.sessionSecret;
    if (this._sessionSecret) return this._sessionSecret;
    try {
      this._sessionSecret = fs.readFileSync(SESSION_SECRET_FILE(), "utf8").trim();
    } catch {
      this._sessionSecret = "";
    }
    if (!this._sessionSecret) {
      this._sessionSecret = crypto.randomBytes(48).toString("hex");
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(SESSION_SECRET_FILE(), this._sessionSecret + "\n", { mode: 0o600 });
    }
    return this._sessionSecret;
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
    let data = readJson(API_KEYS_FILE(), null);
    if (!data || !Array.isArray(data.keys) || data.keys.length === 0) {
      const key = `sk-robin-${randomToken(24)}`;
      data = { keys: [{ id: randomId("key"), name: "default", key, hash: sha256(key), createdAt: new Date().toISOString() }] };
      writeJsonAtomic(API_KEYS_FILE(), data);
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
    const key = `sk-robin-${randomToken(24)}`;
    const entry = { id: randomId("key"), name: name || "new key", key, hash: sha256(key), createdAt: new Date().toISOString() };
    const data = readJson(API_KEYS_FILE(), { keys: [] });
    data.keys = data.keys || [];
    if (config.apiKeys.length) {
      throw new Error("API keys are managed by the GATEWAY_API_KEYS environment variable");
    }
    data.keys.push(entry);
    writeJsonAtomic(API_KEYS_FILE(), data);
    this.apiKeyCache = data.keys;
    return entry;
  }

  removeApiKey(id) {
    if (config.apiKeys.length) throw new Error("API keys are managed by the GATEWAY_API_KEYS environment variable");
    const data = readJson(API_KEYS_FILE(), { keys: [] });
    const before = data.keys.length;
    data.keys = (data.keys || []).filter((entry) => entry.id !== id);
    writeJsonAtomic(API_KEYS_FILE(), data);
    this.apiKeyCache = data.keys;
    return before !== data.keys.length;
  }

  // ---------- Admin ----------
  admin() {
    if (config.adminPassword) {
      return { passwordStored: hashPassword(config.adminPassword), generated: false, source: "env" };
    }
    let data = readJson(ADMIN_FILE(), null);
    if (!data || !data.passwordStored) {
      const password = randomToken(9);
      data = { passwordStored: hashPassword(password), plaintextOnce: password, generated: true };
      writeJsonAtomic(ADMIN_FILE(), data);
    }
    return data;
  }

  adminSource() {
    return config.adminPassword ? "env" : "file";
  }

  /** Replace the stored admin password (ignored when ADMIN_PASSWORD is set). */
  setAdminPassword(password) {
    const data = readJson(ADMIN_FILE(), null) || {};
    const next = { ...data, passwordStored: hashPassword(password), generated: false, updatedAt: Date.now() };
    delete next.plaintextOnce;
    writeJsonAtomic(ADMIN_FILE(), next);
    return next;
  }

  verifyAdminPassword(password) {
    const data = readJson(ADMIN_FILE(), null);
    if (config.adminPassword) return verifyPassword(password, hashPassword(config.adminPassword));
    return verifyPassword(password, data?.passwordStored);
  }

  // ---------- Settings ----------
  settings() {
    if (this.settingsCache) return this.settingsCache;
    this.settingsCache = readJson(SETTINGS_FILE(), {
      gatewayModelAliases: {},
      upstreamBase: config.upstreamBase,
      locale: "zh",
    });
    return this.settingsCache;
  }

  updateSettings(patch) {
    const next = { ...this.settings(), ...patch };
    writeJsonAtomic(SETTINGS_FILE(), next);
    this.settingsCache = next;
    return next;
  }

  // ---------- Credentials ----------
  credentials() {
    if (!this.cache) {
      const data = readJson(CREDENTIALS_FILE(), { credentials: [] });
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
    writeJsonAtomic(CREDENTIALS_FILE(), { credentials: list });
    return sanitizeCredential(stored);
  }

  upsertCredential(input) {
    const existing = this.credentials().find(
      (cred) => cred.id === input.id || (input.email && cred.email && cred.email.toLowerCase() === input.email.toLowerCase()),
    );
    const now = new Date().toISOString();
    const cred = {
      id: existing?.id || randomId("cred"),
      email: input.email || existing?.email || "",
      label: input.label ?? existing?.label ?? "",
      type: input.type || existing?.type || "robin",
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
      refreshTokenEnc: input.refreshToken ? encryptString(input.refreshToken, config.dataDir) : existing?.refreshTokenEnc || "",
    };
    if (input.type === "robin" && !cred.masterTokenEnc && !input.masterToken) {
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
    writeJsonAtomic(CREDENTIALS_FILE(), { credentials: list });
    return true;
  }

  markUsed(id) {
    const cred = this.rawCredential(id);
    if (!cred) return;
    cred.lastUsedAt = new Date().toISOString();
    cred.uses = (cred.uses || 0) + 1;
    this.saveCredential(cred);
  }

  markError(id, message, { cooldownMs = config.cooldownMs } = {}) {
    const cred = this.rawCredential(id);
    if (!cred) return;
    cred.lastError = String(message).slice(0, 2000);
    cred.failures = (cred.failures || 0) + 1;
    cred.status = "error";
    cred.cooldownUntil = Date.now() + cooldownMs;
    this.saveCredential(cred);
  }

  markOk(id) {
    const cred = this.rawCredential(id);
    if (!cred) return;
    cred.lastError = null;
    cred.failures = 0;
    cred.status = "active";
    cred.cooldownUntil = 0;
    this.saveCredential(cred);
  }
}

export function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

export const store = new Store();
