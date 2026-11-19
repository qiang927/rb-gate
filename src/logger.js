const MAX_ENTRIES = 400;
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

export function recentLogs(limit = 200) {
  const count = Math.min(Math.max(Number(limit) || 200, 1), MAX_ENTRIES);
  return buffer.slice(-count);
}
