import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("admin inline script parses", () => {
  const html = fs.readFileSync(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, "admin page should contain an inline script");
  for (const [, code] of scripts) {
    assert.doesNotThrow(() => new vm.Script(code), "admin script must be valid JavaScript");
  }
});

test("admin OpenAI base URL is derived from the current page URL", () => {
  const html = fs.readFileSync(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const match = html.match(/function openAiBaseUrl\(\) \{[\s\S]*?\n  \}/);
  assert.ok(match, "admin page should define openAiBaseUrl");
  const context = { location: { origin: "https://example.com", pathname: "/admin/" } };
  vm.runInNewContext(`${match[0]}\nthis.openAiBaseUrl = openAiBaseUrl;`, context);
  const base = (pathname) => {
    context.location.pathname = pathname;
    return context.openAiBaseUrl();
  };
  assert.equal(base("/admin/"), "https://example.com/v1");
  assert.equal(base("/admin"), "https://example.com/v1");
  assert.equal(base("/admin/index.html"), "https://example.com/v1");
  assert.equal(base("/gateway/admin/"), "https://example.com/gateway/v1");
  assert.equal(base("/"), "https://example.com/v1");
});

test("admin API key form supports custom values and copying", () => {
  const html = fs.readFileSync(new URL("../public/admin/index.html", import.meta.url), "utf8");
  assert.match(html, /id="newKeyValue"/);
  assert.match(html, /data-copy=/);
});
