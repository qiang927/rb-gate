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
