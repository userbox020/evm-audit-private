#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { id } = require("./node_modules/ethers");
const {
  splitInclusive, validateCoverage, projectCaps, classifyRpcError, normalizeLogs,
  setsEqual, verifyCanaries, verifyTerminal, batchEqualsSingleton,
} = require("./capture-unit-hyperunit-upgrade-source-runtime-gate0-r2");

const TOPIC = id("Upgraded(address)").toLowerCase();
const PROXIES = [
  ["UBTC", "0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463", 1513232n, "0x1a7689c3B783EB37550efBB9c81e7F468F7034FC"],
  ["UETH", "0xBe6727B535545C67d5cAa73dEa54865B92CF7907", 1546814n, "0xE60DD45EBa5655e31CA1E61BEad4f983B3C4A83B"],
  ["UFART", "0x3B4575E689DEd21CAAD31d64C4df1f10F3B2CedF", 4131487n, "0xEEE571012C07032907b952714c48c81F8999e96A"],
  ["USOL", "0x068f321Fa8Fb9f0D135f290Ef6a3e2813e1c8A29", 4132417n, "0xaB73C0Ab9E4b931769373bd0C6480c022119D74c"],
  ["UPUMP", "0x27eC642013bcB3D80CA3706599D3cdA04F6f4452", 8415332n, "0xD9d236F9FA38e5aE0c33170a23f09eD50c3E0617"],
];
function word(address) { return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`; }
function rawLog(proxy, block, impl, index = 0) {
  return { address: proxy, blockNumber: `0x${block.toString(16)}`, blockHash: `0x${"11".repeat(32)}`, transactionHash: `0x${(12 + index).toString(16).padStart(2, "0").repeat(32)}`, transactionIndex: "0x0", logIndex: `0x${index.toString(16)}`, topics: [TOPIC, word(impl)], data: "0x", removed: false };
}
let count = 0;
function test(name, fn) { fn(); count += 1; console.log(`ok ${count} - ${name}`); }

test("splitter covers literal inclusive bounds", () => {
  const rows = splitInclusive(25000n, 10000n);
  assert.deepStrictEqual(rows, [
    { fromBlock: "0", toBlock: "9999", inclusiveWidth: "10000" },
    { fromBlock: "10000", toBlock: "19999", inclusiveWidth: "10000" },
    { fromBlock: "20000", toBlock: "25000", inclusiveWidth: "5001" },
  ]);
  assert.strictEqual(validateCoverage(rows, 25000n).ok, true);
});

test("coverage detects gaps", () => {
  const rows = splitInclusive(25000n, 10000n); rows[1].fromBlock = "10001";
  assert.strictEqual(validateCoverage(rows, 25000n).code, "GAP");
});

test("coverage detects overlap ambiguity", () => {
  const rows = splitInclusive(25000n, 10000n); rows[1].fromBlock = "9999";
  assert.strictEqual(validateCoverage(rows, 25000n).code, "OVERLAP");
});

test("numeric ranges use exact width not 500001", () => {
  assert.strictEqual(splitInclusive(500000n, 100000n)[0].inclusiveWidth, "100000");
  assert.strictEqual(splitInclusive(500000n, 100000n)[0].toBlock, "99999");
});

test("error classifier distinguishes range limit", () => {
  assert.strictEqual(classifyRpcError(-32000, "block range too large; maximum 10000 blocks"), "RANGE_LIMIT");
  assert.strictEqual(classifyRpcError(-32000, "execution reverted at block"), "APPLICATION_OTHER");
});

test("error classifier distinguishes block objects", () => {
  assert.strictEqual(classifyRpcError(-32602, "cannot unmarshal object into block parameter; EIP-1898 unsupported"), "BLOCK_OBJECT_UNSUPPORTED");
});

test("cap projection passes exact 10k near maximum", () => {
  const result = projectCaps(43735036n, [10000n, 10000n], [12, 12], 500, 64, 200);
  assert.strictEqual(result.intervals[0], 4374);
  assert.strictEqual(result.perFamily[0], 4386);
  assert.strictEqual(result.pass, true);
});

test("cap projection rejects excessive successful history", () => {
  assert.strictEqual(projectCaps(44000000n, [10000n, 10000n], [12, 12], 500, 64, 200).pass, false);
});

test("normalization and set equality ignore input order", () => {
  const a = normalizeLogs([rawLog(PROXIES[0][1], PROXIES[0][2], PROXIES[0][3], 0), rawLog(PROXIES[1][1], PROXIES[1][2], PROXIES[1][3], 1)]);
  assert.strictEqual(setsEqual(a, [...a].reverse()), true);
});

test("batch equality compares singleton union", () => {
  const a = normalizeLogs([rawLog(PROXIES[0][1], PROXIES[0][2], PROXIES[0][3], 0), rawLog(PROXIES[1][1], PROXIES[1][2], PROXIES[1][3], 1)]);
  assert.strictEqual(batchEqualsSingleton(a, [[a[1]], [a[0]]]), true);
});

test("known deployment canaries require all five", () => {
  const rows = normalizeLogs(PROXIES.map((x, i) => rawLog(x[1], x[2], x[3], i)));
  assert.strictEqual(verifyCanaries(rows).pass, true);
  assert.deepStrictEqual(verifyCanaries(rows.slice(1)).missing, ["UBTC"]);
});

test("terminal event must equal terminal slot", () => {
  const rows = normalizeLogs(PROXIES.map((x, i) => rawLog(x[1], x[2], x[3], i)));
  const slots = Object.fromEntries(PROXIES.map((x) => [x[0], { implementation: x[3] }]));
  assert.strictEqual(verifyTerminal(rows, slots).pass, true);
  slots.UETH.implementation = PROXIES[0][3];
  assert.strictEqual(verifyTerminal(rows, slots).pass, false);
});

test("removed log is rejected", () => {
  const row = rawLog(PROXIES[0][1], PROXIES[0][2], PROXIES[0][3]); row.removed = true;
  assert.throws(() => normalizeLogs([row]), /ADDRESS_OR_REMOVED/);
});

test("out-of-interval log is rejected", () => {
  const row = rawLog(PROXIES[0][1], 11n, PROXIES[0][3]);
  assert.throws(() => normalizeLogs([row], { fromBlock: "12", toBlock: "20" }), /OUTSIDE_INTERVAL/);
});

console.log(`PASS ${count} tests`);
