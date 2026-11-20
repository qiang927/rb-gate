// Google AI Studio (MakerSuite) private RPC client.
//
// The browser executor (public/pggo-executor.user.js) runs inside a logged-in
// aistudio.google.com tab. It holds the account session and the Web Attestation
// (BotGuard) service, so the gateway never needs the cookie or a headless
// Chromium: it only encodes the request wire, sends it to the executor, and
// decodes the frames that come back.
//
// Wire format (protobuf over sparse JSON arrays, field N <-> index N-1):
//   [0] model "models/<id>"        [1] contents
//   [2] safety settings            [3] generation config
//   [4] fresh WAA proof            [5] system instruction
//
// Response format: root[0] is a growing array of frames,
//   frame[0]        candidates
//   frame[0][0][0]  candidate content  [[parts...], "model"]
//   frame[0][0][1]  finish reason code
//   frame[2]        usage [input, visible, total, cached, ?, ?, ?, tool, ?, thought]

export const AI_STUDIO_RPC =
  "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent";

export const AI_STUDIO_ORIGIN = "https://aistudio.google.com";

/** Public API key the AI Studio page ships with; used when no key was captured. */
export const PUBLIC_WEB_API_KEY = "AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs";

/**
 * Models exposed as `pggo-*`. The upstream id is what goes into wire[0].
 * Kept small on purpose: the AI Studio catalog moves fast, extend via env
 * `AI_STUDIO_MODELS` (comma separated upstream ids) when it does.
 */
export const AI_STUDIO_MODELS = [
  { id: "pggo-gemini-3.7-flash", upstream: "models/gemini-3.7-flash", name: "Gemini 3.7 Flash (AI Studio)" },
  { id: "pggo-gemini-3-pro", upstream: "models/gemini-3-pro-preview", name: "Gemini 3 Pro (AI Studio)" },
  { id: "pggo-gemini-2.5-pro", upstream: "models/gemini-2.5-pro", name: "Gemini 2.5 Pro (AI Studio)" },
  { id: "pggo-gemini-2.5-flash", upstream: "models/gemini-2.5-flash", name: "Gemini 2.5 Flash (AI Studio)" },
];

export function listPggoModels() {
  const extra = String(process.env.AI_STUDIO_MODELS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const seen = new Set(AI_STUDIO_MODELS.map((item) => item.upstream));
  const models = [...AI_STUDIO_MODELS];
  for (const upstream of extra) {
    if (seen.has(upstream)) continue;
    seen.add(upstream);
    const name = upstream.replace(/^models\//, "");
    models.push({ id: `pggo-${name}`, upstream, name: `${name} (AI Studio)` });
  }
  return models;
}

export function lookupPggoModel(id) {
  if (!id) return null;
  const models = listPggoModels();
  const direct = models.find((item) => item.id === id);
  if (direct) return direct;
  const bare = String(id).replace(/^pggo-/, "");
  return (
    models.find((item) => item.upstream === bare) ||
    models.find((item) => item.upstream === `models/${bare}`) ||
    null
  );
}

export function isPggoModel(id) {
  return Boolean(lookupPggoModel(id));
}

/** turn OpenAI chat messages into AI Studio contents [[[parts], role]] */
export function buildContents(messages, { systemInstruction } = {}) {
  const contents = [];
  const systemParts = [];
  for (const message of messages || []) {
    const role = String(message?.role || "user");
    const text = contentToText(message?.content);
    if (!text) continue;
    if (role === "system" || role === "developer") {
      systemParts.push([null, text]);
      continue;
    }
    contents.push([[[null, text]], role === "assistant" ? "model" : "user"]);
  }
  if (!contents.length) throw new Error("messages contain no text content");
  return {
    contents,
    systemInstruction: systemInstruction
      ? String(systemInstruction)
      : systemParts.length
        ? systemParts
        : null,
  };
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** generation config: field 4 max tokens, 5 temperature, 6 topP, 7 topK */
function buildGenerationConfig(body) {
  const maxTokens = clampInt(body?.max_tokens ?? body?.max_completion_tokens, 1, 65536);
  const temperature = clampNumber(body?.temperature, 0, 2);
  const topP = clampNumber(body?.top_p, 0, 1);
  const topK = clampInt(body?.top_k, 0, 1000);
  if (maxTokens == null && temperature == null && topP == null && topK == null) return null;
  return [null, null, null, maxTokens ?? null, temperature ?? null, topP ?? null, topK ?? null];
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function clampInt(value, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/**
 * Build the protected request body. `wire[4]` is left empty; the executor
 * replaces it with a fresh WAA proof bound to `sha256(binding)`.
 */
export function buildGenerateWire(model, body, { includeProof = false } = {}) {
  if (!model || !model.upstream) throw new Error("unknown AI Studio model");
  const { contents, systemInstruction } = buildContents(body?.messages);
  const wire = [
    model.upstream,
    contents,
    null,
    buildGenerationConfig(body),
    includeProof ? "" : null,
  ];
  if (systemInstruction) {
    wire[5] = [systemInstruction, "user"];
  }
  return {
    wire,
    binding: buildBinding(contents),
  };
}

/**
 * WAA proof is bound to the request text. The reference implementation hashes
 * the contents and parts joined by single spaces; keeping the same text is
 * enough for a fresh proof to validate.
 */
export function buildBinding(contents) {
  const pieces = [];
  for (const content of contents || []) {
    for (const part of content?.[0] || []) {
      if (Array.isArray(part) && typeof part[1] === "string") pieces.push(part[1]);
    }
  }
  return pieces.join(" ");
}

/** One decoded upstream frame, tolerant of unknown/extra slots. */
export function parseFrame(frame) {
  const out = { text: "", thoughts: "", finishReason: null, usage: null };
  if (!Array.isArray(frame)) return out;
  const candidates = frame[0];
  const candidate = Array.isArray(candidates) && Array.isArray(candidates[0]) ? candidates[0] : null;
  if (candidate) {
    if (Number.isInteger(candidate[1])) out.finishReason = candidate[1];
    const content = candidate[0];
    const parts = Array.isArray(content) && Array.isArray(content[0]) ? content[0] : [];
    const texts = [];
    const thoughts = [];
    for (const part of parts) {
      if (!Array.isArray(part) || typeof part[1] !== "string") continue;
      if (part[12] === 1 || part[12] === true) thoughts.push(part[1]);
      else if (part[12] !== undefined && part[12] !== 0 && part[12] !== false) continue;
      else texts.push(part[1]);
    }
    out.text = texts.join("");
    out.thoughts = thoughts.join("");
  }
  const usage = frame[2];
  if (Array.isArray(usage)) {
    out.usage = {
      promptTokens: numberOr0(usage[0]),
      completionTokens: numberOr0(usage[1]),
      totalTokens: numberOr0(usage[2]),
      cachedTokens: numberOr0(usage[3]),
      toolTokens: numberOr0(usage[7]),
      reasoningTokens: numberOr0(usage[9]),
    };
  }
  return out;
}

function numberOr0(value) {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Incremental decoder for the streaming JSON+protobuf response.
 * `push(chunk)` returns the frames that became complete with that chunk.
 */
export class FrameStream {
  constructor() {
    this.buffer = "";
    this.started = false;
    this.framesStart = -1;
    this.cursor = 0;
    this.depth = 0;
    this.frameStart = -1;
    this.frames = [];
    this.done = false;
  }

  push(chunk) {
    this.buffer += String(chunk || "");
    if (!this.started) {
      const root = this.buffer.indexOf("[");
      if (root < 0) return [];
      this.started = true;
      this.cursor = root + 1;
    }
    if (this.framesStart < 0) {
      // root[0] is the repeated frames array; skip null/whitespace until it opens.
      const idx = this.buffer.indexOf("[", this.cursor);
      if (idx < 0) return [];
      const before = this.buffer.slice(this.cursor, idx).replace(/[\s,]/g, "");
      if (before !== "") {
        // root[0] was null (no frames at all) — nothing to stream.
        return [];
      }
      this.framesStart = idx;
      this.cursor = idx + 1;
      this.depth = 1;
    }
    let i = this.cursor;
    while (i < this.buffer.length) {
      const ch = this.buffer[i];
      if (ch === "[") {
        if (this.depth === 1) this.frameStart = i;
        this.depth += 1;
      } else if (ch === "]") {
        this.depth -= 1;
        if (this.depth === 1 && this.frameStart >= 0) {
          const raw = this.buffer.slice(this.frameStart, i + 1);
          this.frameStart = -1;
          try {
            const frame = JSON.parse(raw);
            if (Array.isArray(frame)) this.frames.push(parseFrame(frame));
          } catch {
            // incomplete or malformed frame: ignore, the stream can still finish
          }
        } else if (this.depth === 0) {
          this.done = true;
          i += 1;
          break;
        }
      }
      i += 1;
    }
    this.cursor = i;
    const fresh = this.frames;
    this.frames = [];
    return fresh;
  }
}
