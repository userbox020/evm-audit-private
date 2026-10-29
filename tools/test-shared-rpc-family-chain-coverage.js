"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const reliability = require("./lib/rpc-provider-reliability");
const shared = require("./shared-rpc");

// Synthetic family classification only: exercise the real parser, ranking and cap
// without naming real providers or reading any endpoint inventory from disk.
function familyOf(value) {
  const host = new URL(value).hostname.toLowerCase();
  return ["host-a.invalid", "host-b.invalid", "host-c.invalid"]
    .find((family) => host === family || host.endsWith(`.${family}`)) || null;
}
function parser(output = []) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "shared-rpc.js"), "utf8"), {
    module, __dirname, URL, Buffer, AbortController, setTimeout, clearTimeout,
    console: { log: (...values) => output.push(...values), error: (...values) => output.push(...values) },
    process: { stdout: { write: (value) => output.push(value) }, stderr: { write: (value) => output.push(value) } },
    require: (name) => name === "./lib/rpc-provider-reliability"
      ? { ...reliability, providerFamily: familyOf }
      : name === "fs" ? { openSync: () => assert.fail("inventory disk reads prohibited") } : require(name)
  });
  return module.exports;
}
const synthetic = parser();
const a1 = "https://eth.host-a.invalid/first";
const a2 = "https://arb.host-a.invalid/second";
const ah = "https://optimism.host-a.invalid/hint-canary-a";
const ah2 = "https://optimistic.host-a.invalid/hint-canary-second";
const b1 = "https://eth.host-b.invalid/first";
const b2 = "https://arb.host-b.invalid/second";
const bh = "https://op-mainnet.host-b.invalid/hint-canary-b";
const c1 = "https://eth.host-c.invalid/first";
function parse(rows, maxCandidates = 52, api = synthetic) {
  return Array.from(api.parseRpcInventory(rows.join("\n"), { maxCandidates }));
}
function baseline(rows, maxCandidates = 52) {
  const ranked = reliability.rankProviderUrls(rows, rows.length);
  return reliability.boundedFamilyCandidates(ranked, {
    maximumFamilies: ranked.length, maximumCandidates: maxCandidates, familyOf
  });
}
function counts(rows) {
  const result = new Map();
  for (const row of rows) result.set(familyOf(row), (result.get(familyOf(row)) || 0) + 1);
  return result;
}

test("a dropped hostname-hinted row replaces only the second kept row of its family", () => {
  const rows = [a1, a2, ah];
  assert.deepEqual(baseline(rows), [a1, a2]);
  assert.deepEqual(parse(rows), [a1, ah]);
  assert.equal(parse(rows).length, baseline(rows).length);
});

test("hint already in either retained position prevents any swap", () => {
  for (const rows of [[ah, a1, ah2], [a1, ah, ah2]]) {
    assert.deepEqual(parse(rows), baseline(rows));
  }
});

test("family without a hinted hostname retains the original rows", () => {
  const rows = [a1, a2, "https://base.host-a.invalid/third"];
  assert.deepEqual(parse(rows), baseline(rows));
});

test("one kept family row never gains a dropped hinted row when the total cap is reached", () => {
  const rows = [a1, ah];
  assert.deepEqual(parse(rows, 1), [a1]);
  assert.equal(parse(rows, 1).includes(ah), false);
  const interleaved = [b1, b2, a1, ah];
  assert.deepEqual(parse(interleaved, 3), [b1, b2, a1]);
});

test("other family rows retain their exact positions, order and per-family counts", () => {
  const rows = [a1, b1, a2, c1, b2, ah, bh];
  const before = baseline(rows), after = parse(rows);
  assert.deepEqual(after, [a1, b1, ah, c1, bh]);
  assert.equal(after.length, before.length);
  assert.deepEqual(counts(after), counts(before));
  assert.deepEqual(after.map(familyOf), before.map(familyOf));
  assert.equal(after[1], before[1]);
  assert.equal(after[3], before[3]);
});

test("every smaller candidate cap keeps the baseline length and only swaps within existing positions", () => {
  const rows = [a1, b1, a2, b2, c1, ah, bh];
  for (let cap = 1; cap <= rows.length; cap += 1) {
    const before = baseline(rows, cap), after = parse(rows, cap);
    assert.equal(after.length, before.length);
    assert.ok(after.length <= cap);
    assert.deepEqual(counts(after), counts(before));
    assert.deepEqual(after.map(familyOf), before.map(familyOf));
  }
  assert.deepEqual(parse(rows, 3), [a1, b1, ah]);
  assert.deepEqual(parse(rows, 2), [a1, b1]);
});

test("only the first dropped hinted row in ranked order is selected", () => {
  const rows = [a1, a2, ah2, ah];
  assert.deepEqual(parse(rows), [a1, ah2]);
  assert.equal(parse(rows).includes(ah), false);
});

test("duplicate URL strings preserve deterministic value-based taken membership", () => {
  assert.deepEqual(parse([a1, a1, a2, ah, ah2, ah]), [a1, ah]);
  assert.deepEqual(parse([a1, ah, ah, ah2]), [a1, ah]);
  assert.deepEqual(parse([a1, a2, ah, ah, b1, b1, bh, bh]), [a1, ah, b1, bh]);
  assert.deepEqual(parse([a1, a1, ah], 1), [a1]);
});

test("parseRpcInventory integration changes one family and leaves another unchanged", () => {
  const text = [`# synthetic inventory`, `primary: ${a1}`, `second: ${a2}`, `hint: ${ah}`,
    `other-primary: ${b1}`, `other-second: ${b2}`, `other-third: https://base.host-b.invalid/third`].join("\r\n");
  assert.deepEqual(Array.from(synthetic.parseRpcInventory(text, { maxCandidates: 52 })), [a1, ah, b1, b2]);
  // The ordinary exported parser is also exercised, using unknown synthetic hosts only.
  const unknown = ["https://host-a.invalid/first", "https://host-a.invalid/second", "https://host-a.invalid/third"];
  assert.deepEqual(shared.parseRpcInventory(unknown.join("\n"), { maxCandidates: 52 }), unknown.slice(0, 2));
  assert.deepEqual(Object.keys(synthetic).sort(), Object.keys(shared).sort());
});

test("parser emits no hostname-hint canary markers, URLs or other output", () => {
  const output = [], api = parser(output);
  assert.deepEqual(parse([a1, a2, ah, b1, b2, bh], 52, api), [a1, ah, b1, bh]);
  assert.equal(output.join("").includes("hint-canary"), false);
  assert.equal(output.join("").includes(ah), false);
  assert.deepEqual(output, []);
});

test("only the specified whole hostname labels qualify, not paths or lookalike labels", () => {
  for (const label of ["optimism", "optimistic", "optimism-mainnet", "op-mainnet", "opt-mainnet"]) {
    const hint = `https://${label}.host-a.invalid/synthetic-hint`;
    assert.deepEqual(parse([a1, a2, hint]), [a1, hint]);
  }
  const upper = "https://OPTIMISM.host-a.invalid/synthetic-hint";
  assert.deepEqual(parse([a1, a2, upper]), [a1, upper]);
  for (const nonHint of ["https://base.host-a.invalid/optimism",
    "https://optimism-mainnets.host-a.invalid/path",
    "https://optimismish.host-a.invalid/path", "https://my-optimism.host-a.invalid/path"]) {
    assert.deepEqual(parse([a1, a2, nonHint]), [a1, a2]);
  }
});
