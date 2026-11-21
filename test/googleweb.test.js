import test from "node:test";
import assert from "node:assert/strict";
import { parseCookieJar } from "../src/googleweb.js";

test("parseCookieJar accepts a raw request-header string", () => {
  const jar = parseCookieJar("SID=abc; __Secure-1PSID=def; HSID=ghi");
  assert.deepEqual(jar, ["SID=abc", "__Secure-1PSID=def", "HSID=ghi"]);
});

test("parseCookieJar strips attributes and the Cookie: prefix", () => {
  const jar = parseCookieJar("Cookie: SID=abc; Path=/; Domain=.google.com; Secure; SameSite=None; NID=xyz");
  assert.deepEqual(jar, ["SID=abc", "NID=xyz"]);
});

test("parseCookieJar accepts newline separated pairs and ignores junk", () => {
  const jar = parseCookieJar("SID=abc\nAPISID=def\nnonsense\n=empty\n__Secure-3PSID=ghi");
  assert.deepEqual(jar, ["SID=abc", "APISID=def", "__Secure-3PSID=ghi"]);
});
