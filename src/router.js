import { config } from "./config.js";
import { ensureAccessToken } from "./credentials.js";
import { UpstreamError } from "./google.js";
import { store } from "./store.js";
import { streamGenerateContent } from "./upstream.js";
import { logError } from "./logger.js";

const MAX_COOLDOWN_MS = 10 * 60 * 1000;
let roundRobin = 0;

function hasSecret(cred) {
  return cred.type === "oauth" ? Boolean(cred.refreshTokenEnc) : Boolean(cred.masterTokenEnc);
}

export function availableCredentials() {
  const now = Date.now();
  const creds = store
    .credentials()
    .filter((cred) => cred.status !== "disabled" && hasSecret(cred) && (!cred.cooldownUntil || cred.cooldownUntil <= now));
  if (creds.length === 0) return [];
  // Round-robin over the healthy set, but prefer accounts with fewer failures.
  const offset = roundRobin++ % creds.length;
  return [...creds.slice(offset), ...creds.slice(0, offset)].sort((a, b) => {
    const failures = (a.failures || 0) - (b.failures || 0);
    if (failures !== 0) return failures;
    return (a.lastUsedAt || "").localeCompare(b.lastUsedAt || "");
  });
}

export function classifyError(error) {
  const status = Number(error?.status) || 0;
  const message = String(error?.message || error || "");
  const noRetry =
    status === 400 ||
    status === 404 ||
    /INVALID_ARGUMENT|not found|unsupported model|invalid model/i.test(message);
  if (noRetry) return { retry: false, cooldownMs: 0, status, message };
  const retry = status === 0 || status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
  let cooldownMs = config.cooldownMs;
  if (status === 429) {
    cooldownMs = Math.min(MAX_COOLDOWN_MS, Math.max(config.cooldownMs, Number(error?.retryAfterMs) || 60_000));
  } else if (status === 403 || status === 401) {
    cooldownMs = Math.min(MAX_COOLDOWN_MS, config.cooldownMs * 10);
  }
  return { retry, cooldownMs, status, message };
}

function describe(error) {
  return error instanceof UpstreamError ? `${error.status || "?"} ${error.message}` : String(error?.message || error);
}

async function acquire(cred) {
  const token = await ensureAccessToken(cred);
  return token.accessToken;
}

/**
 * Non-streaming call with credential failover.
 * @param {(ctx: {cred: object, accessToken: string}) => Promise<any>} handler
 */
export async function withCredential(handler, { signal, attempts = config.maxRetries } = {}) {
  const candidates = availableCredentials();
  if (candidates.length === 0) {
    throw new UpstreamError("no usable credentials configured; import one in the admin panel", { status: 503 });
  }
  const errors = [];
  for (const cred of candidates.slice(0, Math.max(1, attempts))) {
    if (signal?.aborted) throw new UpstreamError("client disconnected", { status: 499 });
    let accessToken;
    try {
      accessToken = await acquire(cred);
    } catch (error) {
      const info = classifyError(error);
      errors.push({ credential: cred.label || cred.email || cred.id, error: describe(error) });
      if (info.retry) store.markError(cred.id, `token: ${describe(error)}`, { cooldownMs: info.cooldownMs });
      continue;
    }
    try {
      const result = await handler({ cred, accessToken });
      store.markUsed(cred.id);
      store.markOk(cred.id);
      return result;
    } catch (error) {
      const info = classifyError(error);
      errors.push({ credential: cred.label || cred.email || cred.id, error: describe(error) });
      if (info.retry) {
        store.markError(cred.id, describe(error), { cooldownMs: info.cooldownMs });
      }
      if (!info.retry) break;
    }
  }
  const suffix = errors.map((item) => `${item.credential}: ${item.error}`).join(" | ");
  if (suffix) logError(`all credentials failed: ${suffix}`);
  const error = new UpstreamError(errors.length ? `all credentials failed (${suffix})` : "request failed", { status: 502 });
  error.attempts = errors;
  throw error;
}

/**
 * Open a streaming response with credential failover. The first SSE payload is
 * read before returning so that authentication/quota errors surface while we
 * can still switch to another credential and before any bytes are sent.
 */
export async function openStream({ model, request, signal }) {
  const candidates = availableCredentials();
  if (candidates.length === 0) {
    throw new UpstreamError("no usable credentials configured; import one in the admin panel", { status: 503 });
  }
  const errors = [];
  for (const cred of candidates.slice(0, Math.max(1, config.maxRetries))) {
    if (signal?.aborted) throw new UpstreamError("client disconnected", { status: 499 });
    let accessToken;
    try {
      accessToken = await acquire(cred);
    } catch (error) {
      const info = classifyError(error);
      errors.push({ credential: cred.label || cred.email || cred.id, error: describe(error) });
      if (info.retry) store.markError(cred.id, `token: ${describe(error)}`, { cooldownMs: info.cooldownMs });
      continue;
    }
    const generator = streamGenerateContent({ credential: cred, accessToken, model, request, signal });
    let first;
    try {
      first = await generator.next();
    } catch (error) {
      const info = classifyError(error);
      errors.push({ credential: cred.label || cred.email || cred.id, error: describe(error) });
      if (info.retry) {
        store.markError(cred.id, describe(error), { cooldownMs: info.cooldownMs });
        continue;
      }
      const wrapped = new UpstreamError(`all credentials failed (${cred.label || cred.email}: ${describe(error)})`, {
        status: (error && error.status) || 502,
      });
      wrapped.attempts = errors;
      throw wrapped;
    }
    store.markUsed(cred.id);
    store.markOk(cred.id);
    return { cred, generator, first, errors };
  }
  const suffix = errors.map((item) => `${item.credential}: ${item.error}`).join(" | ");
  if (suffix) logError(`all credentials failed: ${suffix}`);
  const error = new UpstreamError(`all credentials failed (${suffix})`, { status: 502 });
  error.attempts = errors;
  throw error;
}
