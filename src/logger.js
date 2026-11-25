const MAX_ENTRIES = 30;
const buffer = [];

export function log(level, message) {
  const text = String(message ?? "").slice(0, 4000);
  const entry = { t: Date.now(), level, message: text };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  const line = `[${new Date(entry.t).toISOString()}] ${level.toUpperCase()} ${text}`;
  if (level === "error") console.error(line);
  else console.log(line);
  return entry;
}

export const logInfo = (message) => log("info", message);
export const logWarn = (message) => log("warn", message);
export const logError = (message) => log("error", message);

/**
 * One AI request produces three entries: request -> response -> done/failed.
 * Prompts, messages and model output are deliberately never included.
 */
export function logAi(event, fields = {}) {
  const parts = [`ai ${event}`, `#${fields.id || "-"}`, `model=${fields.model || "-"}`];
  if (fields.stream !== undefined) parts.push(`stream=${Boolean(fields.stream)}`);
  if (fields.messages !== undefined) parts.push(`messages=${fields.messages}`);
  if (fields.phase) parts.push(`phase=${fields.phase}`);
  if (fields.ms !== undefined) parts.push(`ms=${fields.ms}`);
  if (fields.status !== undefined) parts.push(`status=${fields.status}`);
  if (fields.code) parts.push(`code=${fields.code}`);
  if (fields.chars !== undefined) parts.push(`chars=${fields.chars}`);
  if (fields.error) parts.push(`error=${String(fields.error).replace(/\s+/g, " ").slice(0, 300)}`);
  const level = event === "failed" ? "error" : event === "aborted" ? "warn" : "info";
  return log(level, parts.join(" "));
}

export function recentLogs(limit = 30) {
  const count = Math.min(Math.max(Number(limit) || 30, 1), MAX_ENTRIES);
  return buffer.slice(-count);
}
