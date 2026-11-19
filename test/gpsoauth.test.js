import assert from "node:assert/strict";
import { test } from "node:test";
import { constructSignature } from "../src/gpsoauth.js";

test("signature has the gpsoauth wire format", () => {
  const signature = constructSignature("someone@gmail.com", "oauth2_4/abc");
  const raw = Buffer.from(signature, "base64");
  // 1 byte prefix + 4 byte sha1 head + 128 byte RSA-OAEP block.
  assert.equal(raw.length, 133);
  assert.equal(signature.length, 180);
  assert.equal(raw[0], 0x00);
  // sha1(struct) starts with 571be0a4 for normal accounts (well-known value).
  assert.equal(raw.subarray(1, 5).toString("hex"), "571be0a4");
});

test("signature varies per password (RSA-OAEP padding is randomized)", () => {
  const a = constructSignature("a@b.com", "token-one");
  const c = constructSignature("a@b.com", "token-two");
  assert.notEqual(a, c);
});
