import test from "node:test";
import assert from "node:assert/strict";
import { parseUsageBody, tierLabel } from "../src/googleweb.js";

const BODY = `)]}'
[{"data":{"viewer":{"rpcs":{"getUsageInfo":{"subscriptionTier":"TIER1","pools":[
  {"poolType":"GXU_FIVE_HOURLY","percentageUsed":0.24,"gxu":{"windowRefreshesAt":"2026-10-15T05:43:53.558200Z"}},
  {"poolType":"GXU_WEEKLY","percentageUsed":0.01786011,"gxu":{"windowRefreshesAt":"2026-10-21T04:43:53.558273Z"}}
]}}}},"errors":[{"message":"Unrelated upsell unavailable"}]}]`;

test("parseUsageBody reads 5h/weekly pools and tier", () => {
  const usage = parseUsageBody(BODY);
  assert.equal(usage.tier.raw, "TIER1");
  assert.equal(usage.tier.label, "Pro");
  assert.equal(usage.fiveHour.usedPercent, 24);
  assert.equal(usage.fiveHour.remainingPercent, 76);
  assert.equal(usage.fiveHour.windowMinutes, 300);
  assert.equal(usage.fiveHour.resetsAt, "2026-10-15T05:43:53.558200Z");
  assert.equal(usage.weekly.usedPercent, 1.8);
  assert.equal(usage.weekly.remainingPercent, 98.2);
  assert.equal(usage.weekly.windowMinutes, 10080);
});

test("parseUsageBody keeps reported zero and drops unknown/null windows", () => {
  const body = `[{"data":{"viewer":{"rpcs":{"getUsageInfo":{"subscriptionTier":"UNRECOGNIZED","pools":[
    {"poolType":"GXU_FIVE_HOURLY","percentageUsed":null},
    {"poolType":"GXU_WEEKLY","percentageUsed":0,"gxu":{"windowRefreshesAt":"unknown"}}
  ]}}}}}]`;
  const usage = parseUsageBody(body);
  assert.equal(usage.tier.raw, "UNRECOGNIZED");
  assert.equal(usage.tier.label, "UNRECOGNIZED");
  assert.equal(usage.fiveHour, null);
  assert.equal(usage.weekly.usedPercent, 0);
  assert.equal(usage.weekly.remainingPercent, 100);
  assert.equal(usage.weekly.resetsAt, null);
});

test("parseUsageBody returns null for html, empty pools or bad json", () => {
  assert.equal(parseUsageBody("<html>login</html>"), null);
  assert.equal(parseUsageBody("not json"), null);
  const empty = parseUsageBody(`[{"data":{"viewer":{"rpcs":{"getUsageInfo":{"pools":[]}}}}}]`);
  assert.ok(empty);
  assert.equal(empty.fiveHour, null);
  assert.equal(empty.weekly, null);
  assert.equal(parseUsageBody(`[{"data":{"viewer":null}}]`), null);
});

test("tierLabel names the account tiers", () => {
  assert.equal(tierLabel("TIER2"), "Ultra");
  assert.equal(tierLabel(""), "Free");
});
