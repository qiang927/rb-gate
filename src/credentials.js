import crypto from "node:crypto";
import { config } from "./config.js";
import { decryptString, encryptString } from "./crypto.js";
import { exchangeToken, mintBearer } from "./gpsoauth.js";
import {
  UpstreamError,
  ensureProject,
  exchangeCode,
  fetchUserInfo,
  loadCodeAssist,
  pickTier,
  refreshAccessToken,
  extractProjectId,
} from "./google.js";
import { store } from "./store.js";

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

  if (cred.type === "oauth") {
    if (!cred.refreshTokenEnc) throw fail("oauth credential has no refresh token; re-import it");
    const refreshToken = decryptString(cred.refreshTokenEnc, config.dataDir);
    const refreshed = await refreshAccessToken(refreshToken);
    const expiresAt = Date.now() + (refreshed.expiresIn || 3600) * 1000;
    const next = { ...cred, ...(refreshed.refreshToken !== refreshToken ? { refreshTokenEnc: encryptString(refreshed.refreshToken, config.dataDir) } : {}) };
    const result = storeToken(next, refreshed.accessToken, expiresAt);
    return { ...result, minted: true };
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

async function resolveEmail(accessToken, fallback) {
  try {
    const info = await fetchUserInfo(accessToken);
    return info?.email || fallback || "";
  } catch {
    return fallback || "";
  }
}

/**
 * Import a credential from the Robin flow: the browser-side oauth_token is
 * exchanged for a long-lived master token, then minted into an access token.
 */
/**
 * Import a credential from an already-known master token (aas_et/... / oauth2rt/...).
 * Useful when an oauth_token was already exchanged elsewhere and we only
 * need to (re)register the resulting master token, e.g. moving a credential
 * between deployments.
 */
export async function importMaster({ email, masterToken, androidId, label, scopes, app, clientSig }) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) throw fail("email is required");
  const token = String(masterToken || "").trim();
  if (!token) throw fail("masterToken is required");
  if (token.length < 20 || /\s/.test(token)) {
    throw fail("masterToken does not look like a Google master token");
  }
  const deviceId = androidId || crypto.randomBytes(8).toString("hex");
  const credential = store.upsertCredential({
    email: normalized,
    label,
    type: "robin",
    masterToken: token,
    androidId: deviceId,
    scopes: scopes || config.robinScopes,
    app: app || config.robinApp,
    clientSig: clientSig || config.robinClientSig,
    status: "active",
  });
  return { ok: true, credential: store.getCredential(credential.id) };
}

export async function provisionRobin({ email, oauthToken, androidId, label, scopes, app, clientSig }) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) throw fail("email is required");
  const token = String(oauthToken || "").trim();
  if (!token) throw fail("oauth_token is required");
  const deviceId = androidId || crypto.randomBytes(8).toString("hex");

  let exchange;
  try {
    exchange = await exchangeToken(normalized, token, deviceId);
  } catch (error) {
    throw fail(`oauth_token exchange failed: ${error.message}`, error);
  }
  const masterToken = exchange.Token;
  if (!masterToken) throw fail(`oauth_token exchange returned no master token (Error=${exchange.Error || "unknown"})`);

  const draft = {
    id: "",
    email: normalized,
    androidId: deviceId || "",
    scopes: scopes || config.robinScopes,
    app: app || config.robinApp,
    clientSig: clientSig || config.robinClientSig,
  };

  let minted;
  try {
    minted = await mintBearer(normalized, masterToken, draft.androidId, robinOptions(draft));
  } catch (error) {
    // Keep the master token: the account may still work with a different
    // app/client_sig combination later.
    const credential = store.upsertCredential({
      email: normalized,
      label,
      type: "robin",
      masterToken,
      androidId: draft.androidId,
      scopes: draft.scopes,
      app: draft.app,
      clientSig: draft.clientSig,
      status: "error",
      lastError: `bearer mint failed: ${error.message}`,
    });
    throw fail(
      `master token stored, but minting an access token failed: ${error.message}. ` +
        "The credential is saved; try a different app/client_sig or re-run the test.",
      error,
    );
  }

  const expiresAt = minted.expiryEpochSeconds
    ? Math.max(Date.now() + 60_000, minted.expiryEpochSeconds * 1000 - TOKEN_SKEW_MS)
    : Date.now() + 55 * 60 * 1000;
  let credential = store.upsertCredential({
    email: normalized,
    label,
    type: "robin",
    masterToken,
    androidId: draft.androidId,
    scopes: draft.scopes,
    app: draft.app,
    clientSig: draft.clientSig,
    accessToken: minted.token,
    accessExpiresAt: expiresAt,
    status: "active",
    lastError: null,
  });

  const project = await resolveProjectForToken(minted.token, credential);
  credential = store.getCredential(credential.id);
  return {
    credential,
    email: normalized,
    projectId: project.projectId,
    tier: project.tier,
    warning: project.warning,
  };
}

/**
 * Import a credential from a standard Google OAuth authorization-code flow
 * (the same flow the Antigravity / Gemini CLI clients use).
 */
export async function provisionOAuth({ code, redirectUri, codeVerifier, label }) {
  if (!code) throw fail("authorization code is required");
  let tokens;
  try {
    tokens = await exchangeCode({ code, redirectUri, codeVerifier });
  } catch (error) {
    throw fail(`OAuth code exchange failed: ${error.message}`, error);
  }
  const accessToken = tokens.access_token;
  const expiresAt = Date.now() + (Number(tokens.expires_in) || 3600) * 1000;
  const email = await resolveEmail(accessToken, "");
  const credential = store.upsertCredential({
    email,
    label,
    type: "oauth",
    refreshToken: tokens.refresh_token,
    accessToken,
    accessExpiresAt: expiresAt,
    status: "active",
    lastError: null,
  });
  const project = await resolveProjectForToken(accessToken, credential);
  return {
    credential: store.getCredential(credential.id),
    email,
    projectId: project.projectId,
    tier: project.tier,
    warning: project.warning,
  };
}

/**
 * Force a token refresh and a Code Assist probe, updating cached metadata.
 */
export async function testCredential(id) {
  const cred = store.rawCredential(id);
  if (!cred) throw fail("credential not found");
  const forced = { ...cred, accessToken: "", accessExpiresAt: 0 };
  let token;
  try {
    token = await ensureAccessToken(forced);
  } catch (error) {
    store.markError(id, error.message);
    throw error;
  }

  let load;
  try {
    load = await loadCodeAssist(token.accessToken);
  } catch (error) {
    store.markError(id, error.message);
    throw error;
  }
  const projectId = extractProjectId(load) || "";
  const tier = load?.currentTier?.id || pickTier(load) || "";
  const next = { ...store.rawCredential(id), projectId, tier, status: "active", lastError: null, failures: 0, cooldownUntil: 0 };
  store.saveCredential(next);
  return { credential: store.getCredential(id), projectId, tier, tiers: load?.allowedTiers || [] };
}

export { UpstreamError };
