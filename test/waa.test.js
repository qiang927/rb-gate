import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { config } from "../src/config.js";
import { WaaSigner, WaaError } from "../src/waa.js";

const fakeSigner = path.resolve("test/fixtures/fake-signer.mjs");

function withFakeSigner() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webg-gateway-waa-"));
  const previous = { ...config.waa };
  config.waa.enabled = true;
  config.waa.signerPath = fakeSigner;
  config.waa.stateDir = dir;
  config.waa.readyTimeoutMs = 10_000;
  config.waa.mintTimeoutMs = 10_000;
  return {
    restore() {
      Object.assign(config.waa, previous);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("WaaSigner talks NDJSON to the binary", async () => {
  const handle = withFakeSigner();
  const signer = new WaaSigner();
  try {
    await signer.start();
    assert.equal(signer.status().available, true);
    const health = await signer.health();
    assert.equal(health.engine, "spidermonkey-152");
    const minted = await signer.mintProof({
      cookies: "SID=abc; SAPISID=def",
      model: "models/gemini-3.7-flash",
      prompt: "hello",
    });
    assert.equal(minted.proof, "!FAKE_PROOF");
    assert.equal(minted.poolState, "hot");
    assert.equal(minted.headers["X-Goog-Api-Key"], "AIzaFAKE");
  } finally {
    await signer.stop();
    handle.restore();
  }
});

test("WaaSigner surfaces a dead session as waa_session_expired", async () => {
  const handle = withFakeSigner();
  const signer = new WaaSigner();
  try {
    await signer.start();
    await assert.rejects(
      signer.mintProof({ cookies: "SID=abc; SAPISID=bad", model: "models/x", prompt: "hi" }),
      (error) => error instanceof WaaError && error.code === "waa_session_expired",
    );
  } finally {
    await signer.stop();
    handle.restore();
  }
});

test("WaaSigner reports a missing binary instead of crashing", async () => {
  const handle = withFakeSigner();
  config.waa.signerPath = "/nonexistent/waa-signer";
  const signer = new WaaSigner();
  try {
    await assert.rejects(signer.start(), (error) => error instanceof WaaError && error.code === "waa_missing_binary");
  } finally {
    handle.restore();
  }
});
