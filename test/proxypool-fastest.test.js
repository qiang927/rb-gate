import test from "node:test";
import assert from "node:assert/strict";
import {
  aiRequestsInFlight,
  beginAiRequest,
  endAiRequest,
  ProxyPool,
} from "../src/proxypool.js";

function fakePool() {
  const pool = new ProxyPool();
  Object.defineProperty(pool, "running", { configurable: true, get: () => true });
  pool.nodes = ["node-a", "node-b"];
  pool.current = "node-a";
  pool.testAll = async () => [
    { name: "node-a", ok: true, delay: 320 },
    { name: "node-b", ok: true, delay: 90 },
  ];
  pool.select = async (name) => {
    pool.current = name;
    return {};
  };
  return pool;
}

test("pickFastest never switches while an AI request is in flight", async () => {
  const pool = fakePool();
  let tests = 0;
  const baseTestAll = pool.testAll;
  pool.testAll = async () => {
    tests += 1;
    return baseTestAll();
  };
  const selected = [];
  pool.select = async (name) => {
    selected.push(name);
    pool.current = name;
    return {};
  };

  beginAiRequest();
  try {
    assert.equal(aiRequestsInFlight(), 1);
    assert.equal(await pool.pickFastest(), "");
    assert.equal(tests, 0, "must not even start a speed test while a reply is streaming");
    assert.deepEqual(selected, []);
    assert.ok(pool.fastestDeferredAt > 0);
  } finally {
    endAiRequest();
  }
  assert.equal(aiRequestsInFlight(), 0);

  // Once idle, the next run is free to switch to the fastest node.
  assert.equal(await pool.pickFastest(), "node-b");
  assert.deepEqual(selected, ["node-b"]);
  assert.equal(pool.fastestDeferredAt, 0);
  await pool.stop({ persist: false });
});

test("pickFastest defers when a request starts during the speed test", async () => {
  const pool = fakePool();
  const selected = [];
  pool.select = async (name) => {
    selected.push(name);
    pool.current = name;
    return {};
  };
  pool.testAll = async () => {
    beginAiRequest();
    return [
      { name: "node-a", ok: true, delay: 320 },
      { name: "node-b", ok: true, delay: 90 },
    ];
  };

  try {
    assert.equal(await pool.pickFastest(), "");
    assert.deepEqual(selected, [], "a switch raced by a new AI request must be dropped");
    assert.ok(pool.fastestDeferredAt > 0);
  } finally {
    endAiRequest();
  }
  assert.equal(aiRequestsInFlight(), 0);
  await pool.stop({ persist: false });
});
