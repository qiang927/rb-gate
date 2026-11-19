import crypto from "node:crypto";
import { config } from "./config.js";
import { DEFAULT_UA, UpstreamError, parseRetryAfterMs } from "./google.js";
import { isClaudeModel } from "./models.js";
import { unwrapPayload } from "./translate.js";

export function buildUpstreamBody({ credential, model, request, stream }) {
  const body = {
    model,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: `agent-${crypto.randomUUID()}`,
  };
  if (credential?.projectId) body.project = credential.projectId;
  const inner = { ...request };
  if (stream === false) delete inner.stream;
  inner.sessionId = inner.sessionId || `-${crypto.randomBytes(8).readBigUInt64BE() % 9000000000000000000n}`;
  body.request = inner;
  return body;
}

function upstreamHeaders(credential, accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": credential?.userAgent || DEFAULT_UA,
    Accept: "text/event-stream, application/json",
  };
}

async function toUpstreamError(res) {
  const text = await res.text().catch(() => "");
  let message = text.slice(0, 600);
  try {
    const parsed = JSON.parse(text);
    message = parsed?.error?.message || parsed?.message || message;
  } catch {
    /* keep raw */
  }
  return new UpstreamError(`upstream ${res.status}: ${message}`, {
    status: res.status,
    body: text.slice(0, 4000),
    retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
  });
}

/**
 * Non-streaming generateContent. Returns the unwrapped Gemini payload.
 */
export async function generateContent({ credential, accessToken, model, request, signal, timeoutMs = config.requestTimeoutMs }) {
  const body = buildUpstreamBody({ credential, model, request, stream: false });
  const res = await fetch(`${config.upstreamBase}/${config.apiVersion}:generateContent`, {
    method: "POST",
    headers: upstreamHeaders(credential, accessToken),
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw await toUpstreamError(res);
  let data;
  try {
    data = await res.json();
  } catch (error) {
    throw new UpstreamError(`upstream returned invalid JSON: ${error.message}`, { status: 502 });
  }
  const payload = unwrapPayload(data);
  if (!payload) throw new UpstreamError("upstream returned an empty payload", { status: 502 });
  if (payload.error) {
    throw new UpstreamError(`upstream error: ${payload.error.message || JSON.stringify(payload.error)}`, {
      status: Number(payload.error.code) || 502,
      body: JSON.stringify(payload.error).slice(0, 4000),
    });
  }
  return payload;
}

/**
 * Streaming generateContent. Yields unwrapped SSE payloads as they arrive.
 */
export async function* streamGenerateContent({
  credential,
  accessToken,
  model,
  request,
  signal,
  timeoutMs = config.requestTimeoutMs,
}) {
  const body = buildUpstreamBody({ credential, model, request, stream: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("upstream request timed out")), timeoutMs);
  const abort = () => controller.abort(signal?.reason || new Error("client disconnected"));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const res = await fetch(`${config.upstreamBase}/${config.apiVersion}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: upstreamHeaders(credential, accessToken),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw await toUpstreamError(res);
    if (!res.body) throw new UpstreamError("upstream returned an empty stream", { status: 502 });

    const decoder = new TextDecoder();
    let buffer = "";
    let pending = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const candidate = pending ? `${pending}\n${data}` : data;
        let parsed;
        try {
          parsed = JSON.parse(candidate);
        } catch {
          pending = candidate;
          if (pending.length > 8 * 1024 * 1024) throw new UpstreamError("upstream SSE payload too large", { status: 502 });
          continue;
        }
        pending = "";
        const payload = unwrapPayload(parsed);
        if (payload?.error) {
          throw new UpstreamError(`upstream stream error: ${payload.error.message || JSON.stringify(payload.error)}`, {
            status: Number(payload.error.code) || 502,
            body: JSON.stringify(payload.error).slice(0, 4000),
          });
        }
        if (payload) yield payload;
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export { isClaudeModel };
