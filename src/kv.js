import { config } from "./config.js";

/**
 * Minimal Cloudflare KV client over the REST API.
 *
 * This lets the gateway keep credentials across restarts on hosts with an
 * ephemeral filesystem (Render free tier, Fly Machines, etc.): the local
 * JSON files become a write-through cache, KV is the source of truth.
 */
export function kvConfigured() {
  const { accountId, namespaceId, apiToken } = config.kv;
  return Boolean(accountId && namespaceId && apiToken);
}

function baseUrl() {
  const { accountId, namespaceId } = config.kv;
  return `${config.kv.baseUrl}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`;
}

async function request(pathname, init = {}) {
  return fetch(`${baseUrl()}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.kv.apiToken}`,
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
}

export async function kvGet(key) {
  const res = await request(`/values/${encodeURIComponent(key)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`kv get ${key} failed: ${res.status} ${body}`);
  }
  return res.text();
}

export async function kvPut(key, value) {
  const res = await request(`/values/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: String(value),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`kv put ${key} failed: ${res.status} ${body}`);
  }
  return true;
}

export async function kvDelete(key) {
  const res = await request(`/values/${encodeURIComponent(key)}`, { method: "DELETE" });
  if (res.status !== 404 && !res.ok) {
    throw new Error(`kv delete ${key} failed: ${res.status}`);
  }
  return true;
}
