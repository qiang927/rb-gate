// studio channel: AI Studio (MakerSuite) over a server-side WAA signer.
//
// A pggo credential is an email plus the AI Studio browser cookies. The native
// signer replays the account session in a Firefox 152 profile, mints a fresh
// BotGuard proof bound to the request text, and returns the session headers
// that must accompany the RPC. The gateway then streams the private
// GenerateContent response and decodes its JSON frames.
//
// This replaces the earlier "browser executor" design: no tab has to stay
// open, no cookie is shipped to a page, and the container only pays for a
// ~40MB idle Go process once pggo is used.

import { StringDecoder } from "node:string_decoder";

import { config } from "./config.js";
import {
  AI_STUDIO_RPC,
  FrameStream,
  buildBinding,
  buildGenerateWire,
  buildRpcHeaders,
  prepareCookies,
} from "./aistudio.js";
import { WaaError, explainWaaError, waaSigner } from "./waa.js";

/**
 * Mint a proof for the request and open the upstream stream.
 * Yields decoded frames as soon as they are complete.
 */
export async function* streamStudioChat({ cookie, model, body, signal, tier, authUser = 0 }) {
  const prepared = prepareCookies(cookie);
  if (!prepared.ok) {
    throw new WaaError(
      `AI Studio Cookie 缺少必要字段（${prepared.missing.join(", ")}）：请从已登录的 aistudio.google.com 复制完整 Cookie。`,
      { code: "pggo_cookie_invalid", status: 400 },
    );
  }

  const { wire } = buildGenerateWire(model, body);
  const prompt = buildBinding(wire[1]);
  const response = await openUpstream({ prepared, wire, prompt, model, tier, authUser, signal });

  // Decode UTF-8 across chunk boundaries: a single Chinese character can be
  // split between two network chunks, and per-chunk toString() would corrupt it.
  const utf8 = new StringDecoder("utf8");
  const decoder = new FrameStream();
  let raw = "";
  let frames = 0;
  let textLength = 0;
  let finishReason = null;
  let usage = null;
  for await (const chunk of response.body) {
    const piece = utf8.write(Buffer.from(chunk));
    if (raw.length < 4000) raw += piece;
    for (const frame of decoder.push(piece)) {
      frames += 1;
      if (frame.text) textLength += frame.text.length;
      if (frame.finishReason !== null && frame.finishReason !== undefined) finishReason = frame.finishReason;
      if (frame.usage) usage = frame.usage;
      yield frame;
    }
  }
  if (textLength === 0) {
    // The RPC can answer 200 with frames that carry no text (max tokens spent
    // on thoughts, safety block, or an error frame). Keep enough of the raw
    // body in the logs to tell those cases apart.
    console.error(
      `[studio] empty response model=${model.id} frames=${frames} finish=${finishReason} usage=${JSON.stringify(usage)} raw=${JSON.stringify(raw.slice(0, 600))}`,
    );
  }
}

/**
 * Mint a proof and open the MakerSuite stream. AI Studio occasionally drops the
 * connection or reports transient "high demand" errors, so transport failures
 * and 429/5xx before the body starts are retried a couple of times.
 */
async function openUpstream({ prepared, wire, prompt, model, tier, authUser, signal, attempts = 2 }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let minted;
    try {
      minted = await waaSigner.mintProof({
        cookies: prepared.header,
        authUser,
        tier: tier || config.waa.defaultTier,
        model: model.upstream,
        prompt,
        wireContents: wire[1],
      });
    } catch (error) {
      throw new WaaError(explainWaaError(error), {
        code: error.code || "pggo_mint_failed",
        status: error.status || 502,
        retryable: error.retryable,
      });
    }

    const payload = wire.slice();
    payload[4] = minted.proof;
    const headers = buildRpcHeaders({
      cookieHeader: prepared.header,
      signerHeaders: minted.headers,
      authUser,
    });

    const timeoutSignal = AbortSignal.timeout(config.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await fetch(AI_STUDIO_RPC, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: combined,
      });
    } catch (error) {
      const cause = error.cause?.code || error.cause?.message || "";
      lastError = new WaaError(
        `could not reach AI Studio: ${error.message}${cause ? ` (${cause})` : ""}`,
        { code: "pggo_transport_error", status: 502 },
      );
      if (attempt < attempts && !signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        continue;
      }
      throw lastError;
    }

    if (response.ok) return response;

    const detail = (await response.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
    const retryable = response.status === 429 || response.status >= 500;
    lastError = new WaaError(`AI Studio returned HTTP ${response.status}: ${detail || "no body"}`, {
      code: response.status === 429 ? "pggo_rate_limited" : retryable ? "pggo_unavailable" : "pggo_upstream_error",
      status: response.status === 429 ? 429 : retryable ? 503 : 502,
    });
    if (retryable && attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
      continue;
    }
    throw lastError;
  }
  throw lastError || new WaaError("AI Studio request failed", { code: "pggo_failed", status: 502 });
}

/** Aggregate a pggo chat into `{text, thoughts, usage, finishReason}`. */
export async function completeStudioChat(options) {
  let text = "";
  let thoughts = "";
  let usage = null;
  let finishReason = null;
  let started = false;
  for await (const frame of streamStudioChat(options)) {
    if (!started) {
      started = true;
      options.onStart?.();
    }
    if (frame.text) text += frame.text;
    if (frame.thoughts) thoughts += frame.thoughts;
    if (frame.usage) usage = frame.usage;
    if (frame.finishReason !== null && frame.finishReason !== undefined) finishReason = frame.finishReason;
  }
  return { text, thoughts, usage, finishReason };
}

/** Signer health for the admin panel. */
export async function studioSelfTest() {
  const status = waaSigner.status();
  if (!status.enabled || !status.binaryExists) return { ...status, ok: false };
  try {
    const health = await waaSigner.health();
    return { ...status, ok: true, health };
  } catch (error) {
    return { ...status, ok: false, error: explainWaaError(error) };
  }
}

export { explainWaaError, waaSigner };
