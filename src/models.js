import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "models.json"), "utf8"));

const byId = new Map();
for (const model of [...(catalog.antigravity || []), ...(catalog.geminiCli || [])]) {
  if (!byId.has(model.id)) byId.set(model.id, model);
}

const ALIASES = {
  "gemini-2.5-pro": "gemini-2.5-pro",
  "gemini-2.5-flash": "gemini-2.5-flash",
  "gemini-3-pro": "gemini-3-pro-preview",
  "gemini-3-flash": "gemini-3-flash-preview",
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
  "gemini-3.1-flash": "gemini-3.1-flash-lite-preview",
  "claude-sonnet-4": "claude-sonnet-4-6",
  "claude-opus-4": "claude-opus-4-6-thinking",
};

export function listModels() {
  const seen = new Set();
  const out = [];
  for (const model of catalog.antigravity || []) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push({
      id: model.id,
      object: "model",
      created: model.created || 0,
      owned_by: "antigravity",
      groups: ["webg-gateway"],
      display_name: model.display_name || model.id,
      context_length: model.context_length,
      max_completion_tokens: model.max_completion_tokens,
    });
  }
  return out;
}

export function lookupModel(id) {
  if (!id) return null;
  return byId.get(id) || byId.get(ALIASES[id]) || null;
}

export function resolveModelId(id) {
  if (!id) return id;
  if (byId.has(id)) return id;
  return ALIASES[id] || id;
}

export function isClaudeModel(id) {
  return String(id || "").toLowerCase().includes("claude");
}

export function maxOutputTokens(id) {
  const model = lookupModel(id);
  return model?.max_completion_tokens || 0;
}
