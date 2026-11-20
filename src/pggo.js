// pggo channel: AI Studio (MakerSuite) over a server-side WAA signer.
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
export async function* streamPggoChat({ cookie, model, body, signal, tier, authUser = 0 }) {
  const prepared = prepareCookies(cookie);
  if (!prepared.ok) {
    throw new WaaError(
      `AI Studio Cookie 缺少必要字段（${prepared.missing.join(", ")}）：请从已登录的 aistudio.google.com 复制完整 Cookie。`,
      { code: "pggo_cookie_invalid", status: 400 },
    );
  }

  const { wire } = buildGenerateWire(model, body);
  const prompt = buildBinding(wire[1]);

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
    throw new WaaError(`could not reach AI Studio: ${error.message}`, { code: "pggo_transport_error", status: 502 });
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
    throw new WaaError(`AI Studio returned HTTP ${response.status}: ${detail || "no body"}`, {
      code: "pggo_upstream_error",
      status: response.status === 429 ? 429 : 502,
    });
  }
  if (!response.body) {
    throw new WaaError("AI Studio returned an empty body", { code: "pggo_empty_response", status: 502 });
  }

  const decoder = new FrameStream();
  for await (const chunk of response.body) {
    for (const frame of decoder.push(Buffer.from(chunk).toString("utf8"))) {
      yield frame;
      if (frame.finishReason !== null && frame.finishReason !== undefined && frame.finishReason !== 0) {
        // Keep draining: the trailing frame may carry usage metadata.
      }
    }
  }
}

/** Aggregate a pggo chat into `{text, thoughts, usage, finishReason}`. */
export async function completePggoChat(options) {
  let text = "";
  let thoughts = "";
  let usage = null;
  let finishReason = null;
  for await (const frame of streamPggoChat(options)) {
    if (frame.text) text += frame.text;
    if (frame.thoughts) thoughts += frame.thoughts;
    if (frame.usage) usage = frame.usage;
    if (frame.finishReason !== null && frame.finishReason !== undefined) finishReason = frame.finishReason;
  }
  return { text, thoughts, usage, finishReason };
}

/** Signer health for the admin panel. */
export async function pggoSelfTest() {
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
