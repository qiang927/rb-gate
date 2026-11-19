import crypto from "node:crypto";
import https from "node:https";

/**
 * A dependency-free port of gpsoauth 3.0.1 (simon-weber/gpsoauth, MIT).
 *
 * Two flows are used by Robin-style credential import:
 *   1. exchangeToken(email, oauthToken, androidId)
 *        Single-use web oauth_token (accounts.google.com EmbeddedSetup cookie,
 *        value starts with "oauth2_4/") -> durable master token ("oauth2rt_1/...").
 *   2. performOauth(email, masterToken, androidId, { service: "oauth2:<scopes>", app, clientSig })
 *        master token -> short-lived OAuth access token ("ya29...") usable as
 *        "Authorization: Bearer <Auth>".
 *
 * The Android auth endpoint is picky: no ALPN, default TLS 1.3 ciphers and a
 * plain "GoogleAuth/1.4" user agent. node:https with default options matches
 * (it does not offer ALPN unless asked).
 */

const AUTH_URL = "https://android.clients.google.com/auth";
const USER_AGENT = "GoogleAuth/1.4";

// Google Play Services 7.3.29 public key (same constant as gpsoauth).
const B64_KEY_7_3_29 =
  "AAAAgMom/1a/v0lblO2Ubrt60J2gcuXSljGFQXgcyZWveWLEwo6prwgi3iJIZdodyhKZQrNWp5nKJ3srRXcUW+F1BD3baEVGcmEgqaLZUNBjm057pKRI16kB0YppeGx5qIQ5QjKzsR8ETQbKLNWgRY0QRNVz34kMJR3P/LgHax/6rmf5AAAAAwEAAQ==";

let cachedKey = null;

function parsePublicKey() {
  if (cachedKey) return cachedKey;
  const binary = Buffer.from(B64_KEY_7_3_29, "base64");
  const modLen = binary.readUInt32BE(0);
  const modulus = binary.subarray(4, 4 + modLen);
  const expLen = binary.readUInt32BE(4 + modLen);
  const exponent = binary.subarray(8 + modLen, 8 + modLen + expLen);
  const key = crypto.createPublicKey({
    key: {
      kty: "RSA",
      n: modulus.toString("base64url"),
      e: exponent.toString("base64url"),
    },
    format: "jwk",
  });
  const struct = Buffer.concat([
    Buffer.from([0, 0, 0, 0x80]),
    modulus,
    Buffer.from([0, 0, 0, 0x03]),
    exponent,
  ]);
  cachedKey = { key, struct };
  return cachedKey;
}

/**
 * gpsoauth's EncryptedPasswd field: 0x00 + sha1(key struct)[:4] + RSA-OAEP(SHA1)
 * of "<email>\0<password>", base64 encoded.
 */
export function constructSignature(email, password) {
  const { key, struct } = parsePublicKey();
  const digest = crypto.createHash("sha1").update(struct).digest().subarray(0, 4);
  const encrypted = crypto.publicEncrypt(
    { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    Buffer.from(`${email}\u0000${password}`, "utf8"),
  );
  return Buffer.concat([Buffer.from([0x00]), digest, encrypted]).toString("base64");
}

function postForm(fields, { timeoutMs = 30_000 } = {}) {
  const body = new URLSearchParams(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== null),
  ).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      AUTH_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": USER_AGENT,
          "Accept-Encoding": "identity",
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          const parsed = parseAuthResponse(raw);
          if (res.statusCode !== 200 || parsed.Error) {
            const error = new Error(`google auth failed (${res.statusCode}): ${parsed.Error || raw.slice(0, 300)}`);
            error.statusCode = res.statusCode;
            error.googleError = parsed.Error;
            error.codes = parsed;
            reject(error);
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("google auth request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

export function parseAuthResponse(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    if (!line) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

export async function exchangeToken(email, oauthToken, androidId, { timeoutMs } = {}) {
  const data = {
    accountType: "HOSTED_OR_GOOGLE",
    Email: email,
    has_permission: 1,
    add_account: 1,
    ACCESS_TOKEN: 1,
    Token: oauthToken,
    service: "ac2dm",
    source: "android",
    androidId,
    device_country: "us",
    operatorCountry: "us",
    lang: "en",
    sdk_version: 17,
    google_play_services_version: 240913000,
    client_sig: "38918a453d07199354f8b19af05ec6562ced5788",
    callerSig: "38918a453d07199354f8b19af05ec6562ced5788",
    droidguard_results: "dummy123",
  };
  const result = await postForm(data, { timeoutMs });
  if (!result.Token) {
    throw new Error(`No Token in google response (services=${result.services || "n/a"})`);
  }
  return result;
}

export async function performOauth(email, masterToken, androidId, { service, app, clientSig, timeoutMs } = {}) {
  if (!service) throw new Error("performOauth requires a service identifier");
  const data = {
    accountType: "HOSTED_OR_GOOGLE",
    Email: email,
    has_permission: 1,
    EncryptedPasswd: masterToken,
    service,
    source: "android",
    androidId,
    app,
    client_sig: clientSig,
    device_country: "us",
    operatorCountry: "us",
    lang: "en",
    sdk_version: 17,
    google_play_services_version: 240913000,
  };
  return postForm(data, { timeoutMs });
}

/**
 * Mint a bearer for the given scopes from a durable master token.
 * Returns { token, expiryEpochSeconds }.
 */
export async function mintBearer(email, masterToken, androidId, { scopes, app, clientSig } = {}) {
  const scopeList = scopes
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const service = `oauth2:${scopeList.join(" ")}`;
  const result = await performOauth(email, masterToken, androidId, { service, app, clientSig });
  const token = result.Auth;
  if (!token) {
    throw new Error("google did not return an Auth token for the requested scopes");
  }
  const expiry = Number.parseInt(result.Expiry || "0", 10);
  return { token, expiryEpochSeconds: Number.isFinite(expiry) && expiry > 0 ? expiry : null };
}
