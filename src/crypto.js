import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

let cachedKey = null;
let cachedDataDir = null;

function loadOrCreateSecretFile(dataDir, name, bytes = 32) {
  const file = path.join(dataDir, name);
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (raw) return raw;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const value = crypto.randomBytes(bytes).toString("hex");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, value + "\n", { mode: 0o600 });
  return value;
}

/**
 * Derive/load the data-encryption key. ENCRYPTION_KEY wins; otherwise a stable
 * local key file is generated inside DATA_DIR.
 */
export function getEncryptionKey(dataDir) {
  if (cachedKey && cachedDataDir === dataDir) return cachedKey;
  const source = process.env.ENCRYPTION_KEY?.trim();
  if (source) {
    // Accept hex, base64 or an arbitrary passphrase; normalize through scrypt.
    const material = /^[0-9a-f]{64}$/i.test(source) ? Buffer.from(source, "hex") : Buffer.from(source, "utf8");
    cachedKey = crypto.scryptSync(material, "robin-gateway-v1", 32);
  } else {
    const secret = loadOrCreateSecretFile(dataDir, "secret.key", 32);
    cachedKey = crypto.scryptSync(secret, "robin-gateway-v1", 32);
  }
  cachedDataDir = dataDir;
  return cachedKey;
}

export function encryptString(plain, dataDir) {
  if (plain === undefined || plain === null || plain === "") return "";
  const key = getEncryptionKey(dataDir);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptString(value, dataDir) {
  if (!value) return "";
  if (!String(value).startsWith("enc:v1:")) return String(value);
  const parts = String(value).split(":");
  if (parts.length !== 5) throw new Error("malformed encrypted value");
  const [, , ivB64, tagB64, ctB64] = parts;
  const key = getEncryptionKey(dataDir);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(String(password), salt, 32).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    // Plaintext legacy value (e.g. explicitly configured ADMIN_PASSWORD).
    const a = Buffer.from(String(password));
    const b = Buffer.from(String(stored));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const [, salt, expected] = parts;
  const actual = crypto.scryptSync(String(password), salt, 32).toString("hex");
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function randomId(prefix = "cred") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
