import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWebInner,
  catalogFromRpc,
  hydrateCatalog,
  parseBatchexecute,
  parseCookieJar,
  parseWebFrame,
  resolveCatalogModel,
  resolveThinkingLevel,
  serializeCatalog,
  splitWebModelId,
  thinkingFromBody,
  webModelHeaders,
} from "../src/googleweb.js";

const HASH = {
  auto: "8c46e95b1a07cecc",
  hydrogen: "56fdd199312815e2",
  neon: "e6fa609c3fa255c0",
  carbon: "95a4c0abcba24364",
};

function rawModel(hash, display, base, number) {
  const raw = new Array(20).fill(null);
  raw[0] = hash;
  raw[1] = display;
  raw[2] = base;
  raw[9] = number;
  raw[10] = display;
  raw[17] = number;
  raw[19] = base;
  return raw;
}

const LEVELS = [
  [1, "Low", "Fast and efficient", false, "Gemini", "Hydrogen", "Hydrogen"],
  [4, "Medium", "Balanced depth", false, "Gemini", "Hydrogen", "Hydrogen"],
  [2, "High", "Extra thorough", false, "Gemini", "Hydrogen", "Hydrogen"],
];

function catalogBody() {
  const body = new Array(25).fill(null);
  body[15] = [
    rawModel(HASH.auto, "Auto", "Auto", 6),
    rawModel(HASH.hydrogen, "4 Hydrogen", "4 Hydrogen", 1),
    rawModel(HASH.neon, "Neon", "4 Neon", 3),
    rawModel(HASH.carbon, "Carbon", "4 Carbon", 8),
  ];
  body[16] = [8, 0, 38];
  body[17] = [4, 5, 6, 8];
  body[24] = [
    "neon_pro_policy",
    [
      [["", 6, false, null, "Auto", "Adapts to your needs"], null],
      [["", 1, false, null, "4 Hydrogen", "Everyday help"], LEVELS],
      [["", 3, false, null, "Neon", "Deeper analysis"], LEVELS],
    ],
  ];
  return body;
}

function buildCatalog() {
  return catalogFromRpc(catalogBody());
}

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

test("catalogFromRpc trusts the picker, not the advertised model list", () => {
  const catalog = buildCatalog();
  assert.equal(catalog.tierLabel, "Pro");
  assert.equal(catalog.capacity, 2);
  assert.equal(catalog.capacityField, 12);
  assert.deepEqual(
    catalog.models.map((spec) => spec.id),
    [
      "web-gemini-4-auto",
      "web-gemini-4-hydrogen-low",
      "web-gemini-4-hydrogen-medium",
      "web-gemini-4-hydrogen-high",
      "web-gemini-4-neon-low",
      "web-gemini-4-neon-medium",
      "web-gemini-4-neon-high",
    ],
  );
  assert.equal(catalog.byId.has("web-gemini-4-carbon"), false);
});

test("catalogFromRpc models the picker levels and served names", () => {
  const catalog = buildCatalog();
  const auto = catalog.byId.get("web-gemini-4-auto");
  assert.equal(auto.isAuto, true);
  assert.deepEqual(auto.levels, []);
  assert.equal(auto.expectedServed, "Auto");
  assert.equal(auto.modelNumber, 6);

  const low = catalog.byId.get("web-gemini-4-hydrogen-low");
  assert.equal(low.hash, HASH.hydrogen);
  assert.equal(low.modelNumber, 1);
  assert.equal(low.level.id, 1);
  assert.deepEqual(low.levels.map((level) => level.id), [1, 4, 2]);
  assert.deepEqual(low.levels.map((level) => level.name), ["low", "medium", "high"]);
  assert.equal(low.expectedServed, "4 Hydrogen");
  assert.equal(catalog.byId.get("web-gemini-4-hydrogen-medium").expectedServed, "4 Hydrogen Medium");
  assert.equal(catalog.byId.get("web-gemini-4-hydrogen-high").expectedServed, "4 Hydrogen High");
});

test("resolveCatalogModel resolves exact ids, bare ids and thinking aliases", () => {
  const catalog = buildCatalog();
  assert.equal(resolveCatalogModel(catalog, "web-gemini-4-hydrogen-low").level.id, 1);
  assert.equal(resolveCatalogModel(catalog, "web-gemini-4-hydrogen").level.id, 1);
  assert.equal(resolveCatalogModel(catalog, "web-gemini-4-hydrogen", "high").level.id, 2);
  assert.equal(resolveCatalogModel(catalog, "web-gemini-4-hydrogen", "max").level.id, 2);
  assert.equal(resolveCatalogModel(catalog, "web-gemini-4-hydrogen", "4").level.id, 4);
});

test("resolveCatalogModel refuses Auto thinking and unavailable models", () => {
  const catalog = buildCatalog();
  assert.throws(
    () => resolveCatalogModel(catalog, "web-gemini-4-auto", "low"),
    (error) => error.code === "thinking_not_supported" && error.status === 400,
  );
  assert.throws(
    () => resolveCatalogModel(catalog, "web-gemini-4-hydrogen", "banana"),
    (error) => error.code === "thinking_not_available" && error.status === 400,
  );
  assert.throws(
    () => resolveCatalogModel(catalog, "web-gemini-4-carbon"),
    (error) => error.code === "model_not_available" && error.status === 404,
  );
});

test("buildWebInner sends model number and picker level id", () => {
  const catalog = buildCatalog();
  const medium = resolveCatalogModel(catalog, "web-gemini-4-hydrogen", "medium");
  const inner = buildWebInner("hi", medium);
  assert.equal(inner[79], 1);
  assert.equal(inner[80], 4);
  assert.deepEqual(inner[17], [[0]]);
  assert.deepEqual(inner[41], [2]);
  assert.equal(inner[45], null);

  const auto = buildWebInner("hi", catalog.byId.get("web-gemini-4-auto"));
  assert.equal(auto[79], 6);
  assert.equal(auto[80], 0);
});

test("buildWebInner keeps the temporary-chat flags in sync", () => {
  const catalog = buildCatalog();
  const inner = buildWebInner("hi", catalog.byId.get("web-gemini-4-auto"), { temporary: true });
  assert.deepEqual(inner[41], [1]);
  assert.equal(inner[45], 1);
});

test("buildWebInner rejects a missing spec", () => {
  assert.throws(
    () => buildWebInner("hi", null),
    (error) => error.code === "bad_model_spec" && error.status === 500,
  );
});

test("webModelHeaders carries the real model hash, number and thinking", () => {
  const catalog = buildCatalog();
  const spec = resolveCatalogModel(catalog, "web-gemini-4-neon", "high");
  const headers = webModelHeaders(spec, "uuid-1");
  const header = JSON.parse(headers["x-goog-ext-525001261-jspb"]);
  assert.equal(header[4], HASH.neon);
  assert.equal(header[11], 2);
  assert.equal(header[14], 3);
  assert.equal(header[15], 2);
  assert.equal(header[16], "uuid-1");
  assert.equal(headers["x-goog-ext-73010989-jspb"], "[0]");
  assert.equal(headers["x-goog-ext-73010990-jspb"], "[0,0,0]");
  assert.deepEqual(JSON.parse(headers["x-goog-ext-525005358-jspb"]), ["uuid-1", 1]);

  const ultra = webModelHeaders({ ...spec, capacity: 2, capacityField: 13 }, "uuid-2");
  assert.deepEqual(JSON.parse(ultra["x-goog-ext-525001261-jspb"])[11], [null, 2]);
});

test("serializeCatalog and hydrateCatalog round-trip the picker", () => {
  const catalog = buildCatalog();
  const restored = hydrateCatalog(JSON.parse(JSON.stringify(serializeCatalog(catalog))));
  assert.equal(restored.tierLabel, "Pro");
  assert.equal(restored.byId.get("web-gemini-4-neon-high").level.id, 2);
  assert.equal(restored.byBaseId.get("web-gemini-4-hydrogen").level.id, 1);
  assert.equal(restored.models.length, 7);
});

test("parseBatchexecute finds the otAQ7b frame", () => {
  const payload = catalogBody();
  const raw = `)]}'\n\n${JSON.stringify([
    ["wrb.fr", "otAQ7b", JSON.stringify(payload), null, null, null, "generic"],
  ])}`;
  const parsed = parseBatchexecute(raw, "otAQ7b");
  assert.ok(parsed);
  assert.equal(parsed[15].length, 4);
});

test("resolveThinkingLevel accepts the aliases clients send", () => {
  assert.equal(resolveThinkingLevel("low"), "low");
  assert.equal(resolveThinkingLevel(" HIGH "), "high");
  assert.equal(resolveThinkingLevel("minimal"), "low");
  assert.equal(resolveThinkingLevel("xhigh"), "high");
  assert.equal(resolveThinkingLevel(2), "medium");
  assert.equal(resolveThinkingLevel(4), null);
  assert.equal(resolveThinkingLevel("banana"), null);
  assert.equal(resolveThinkingLevel(undefined), null);
});

test("splitWebModelId peels the @think suffix off a model id", () => {
  assert.deepEqual(splitWebModelId("web-gemini-4-neon@think=high"), { model: "web-gemini-4-neon", thinking: "high" });
  assert.deepEqual(splitWebModelId("web-gemini-4-neon"), { model: "web-gemini-4-neon", thinking: null });
  assert.deepEqual(splitWebModelId(""), { model: "", thinking: null });
});

test("thinkingFromBody reads reasoning_effort, reasoning.effort and a token budget", () => {
  assert.equal(thinkingFromBody({ reasoning_effort: "high" }), "high");
  assert.equal(thinkingFromBody({ reasoning: { effort: "medium" } }), "medium");
  assert.equal(thinkingFromBody({ thinking: { budget_tokens: 1024 } }), "low");
  assert.equal(thinkingFromBody({ thinking: { budget_tokens: 3000 } }), "medium");
  assert.equal(thinkingFromBody({ thinking: { budget_tokens: 8192 } }), "high");
  assert.equal(thinkingFromBody({}), null);
});

test("parseWebFrame reads served model and text from one frame", () => {
  const inner = new Array(60).fill(null);
  inner[4] = [[null, ["hello", " world"]]];
  inner[39] = "95a4c0abcba24364";
  inner[42] = "4 Hydrogen";
  const line = JSON.stringify([["wrb.fr", null, JSON.stringify(inner), null, null, null, "generic"]]);
  const frame = parseWebFrame(line);
  assert.deepEqual(frame.texts, ["hello", " world"]);
  assert.equal(frame.servedModel, "4 Hydrogen");
  assert.equal(frame.echoModel, "95a4c0abcba24364");
});

test("parseWebFrame keeps served model even when a frame has no text", () => {
  const inner = new Array(60).fill(null);
  inner[42] = "4 Neon";
  const line = JSON.stringify([["wrb.fr", null, JSON.stringify(inner), null, null, null, "generic"]]);
  const frame = parseWebFrame(line);
  assert.deepEqual(frame.texts, []);
  assert.equal(frame.servedModel, "4 Neon");
});
