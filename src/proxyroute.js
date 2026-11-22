// Runtime switch for the outbound HTTP proxy used by the Gemini web channel.
// Kept dependency-free so googleweb.js can import it from tests.
let target = "";

export function setOutboundProxy(url) {
  target = url || "";
}

export function getOutboundProxy() {
  return target;
}
