"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { Interface, keccak256 } = require("../node_modules/ethers");
const { ExecutionError } = require("../lib/wallet-execution-guard.js");
const proof = require("../lib/rank1-aave-v4-proof.js");
const { TARGET, POLICY, loadRank1SourceProof, verifyRank1Runtime, readRank1Feeds, valueRank1ProfitBeforeGas, valueRank1Profit } = proof;
const ROOT = path.resolve(__dirname, "../.."), SOURCE = "tools/fork-poc/contracts/FlashLiquidateAaveV4.sol";
const COMPILED = "tools/fork-poc/contracts/FlashLiquidateAaveV4.compiled.json";
const BATCH = "coordination/live-execution-batch-aave-v4-executor-deploy-20261019.json";
const AT = 1792807200, W = 10n ** 18n, U = 10n ** 6n, MAX = (1n << 256n) - 1n;
const hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0"), turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const FEES = { gasLimit: 1300000n, maxFeePerGas: 250000000n, maxPriorityFeePerGas: 1000000n };
const ABI = new Interface(["function owner() view returns(address)", "function decimals() view returns(uint8)",
  "function balanceOf(address) view returns(uint256)", "function description() view returns(string)",
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)"]);
function artifacts() { return new Map([SOURCE, COMPILED, BATCH].map(file => [path.join(ROOT, file), fs.readFileSync(path.join(ROOT, file))])); }
function runtime() {
  const a = JSON.parse(fs.readFileSync(path.join(ROOT, COMPILED), "utf8")), bytes = Buffer.from(a.deployedBytecode.slice(2), "hex");
  const owner = Buffer.from(TARGET.owner.slice(2).padStart(64, "0"), "hex");
  for (const range of a.immutableReferences["189"]) owner.copy(bytes, range.start);
  return "0x" + bytes.toString("hex");
}
function fixture({ delay = 0 } = {}) {
  const state = { runtime: runtime(), owner: TARGET.owner, decimals: { [TARGET.usde]: 18n, [TARGET.usdc]: 6n },
    balances: { [TARGET.usde]: 0n, [TARGET.usdc]: 0n }, usable: true, reads: [], active: 0, peak: 0, hook: () => undefined,
    feeds: Object.fromEntries([POLICY.ethUsd, POLICY.usdcUsd].map(config => [config.address,
      { decimals: 8n, description: config.description, round: [7n, config === POLICY.ethUsd ? 2000n * 10n ** 8n : 10n ** 8n,
        BigInt(AT - 60), BigInt(AT - 30), 7n] }])) };
  const read = async (to, method, args = []) => {
    const entry = { to, method, args }; state.reads.push(entry); state.peak = Math.max(state.peak, ++state.active);
    try {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const changed = await state.hook(entry); if (changed !== undefined) return changed;
      if (method === "code") { assert.equal(to, TARGET.executor); return state.runtime; }
      let values;
      if (to === TARGET.executor) { assert.equal(method, "owner"); values = [state.owner]; }
      else if (to === TARGET.usde || to === TARGET.usdc) {
        assert.ok(method === "decimals" || method === "balanceOf");
        if (method === "balanceOf") assert.equal(args[0].toLowerCase(), TARGET.executor);
        values = [method === "decimals" ? state.decimals[to] : state.balances[to]];
      } else {
        assert.ok([POLICY.ethUsd.address, POLICY.usdcUsd.address].includes(to)); const feed = state.feeds[to];
        values = method === "latestRoundData" ? feed.round : [feed[method]];
      }
      return ABI.encodeFunctionResult(method, values);
    } finally { state.active--; }
  };
  const pinned = { pin: { number: 1000, hash: hash(1000), timestamp: AT, chainId: 1 },
    evidence: { strictEvidence: true, independentFamilies: true, fixedProviderPair: true, rawTimestamp: true, codeHashPinnedQualified: true },
    assertUsable() { if (!state.usable) throw new Error("UNTRUSTED_RPC_DETAIL"); },
    code: account => read(account, "code"),
    call: tx => { assert.deepEqual(Object.keys(tx).sort(), ["data", "to"]); const decoded = ABI.parseTransaction({ data: tx.data });
      return read(tx.to, decoded.name, Array.from(decoded.args)); } };
  return { state, pinned };
}
const safe = code => error => {
  assert.ok(error instanceof ExecutionError); assert.equal(error.code, code); assert.equal(error.message, code);
  assert.doesNotMatch(JSON.stringify(error) + error.stack, /UNTRUSTED_RPC_DETAIL|0x6080/); return true;
};
const clone = value => structuredClone(value);
async function freshFeeds() { return readRank1Feeds(fixture().pinned); }

test("import is inert: no artifact/inventory/key reads, network or writes", t => {
  const filename = require.resolve("../lib/rank1-aave-v4-proof.js"), cached = require.cache[filename], reads = [];
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    // The staging preload relocates source bytes, not the module's filename.
    assert.ok(path.resolve(file).replaceAll("\\", "/").endsWith("/tools/lib/rank1-aave-v4-proof.js"), "only this module's source read is permitted during import");
    reads.push(file); return original(file, ...args);
  });
  t.mock.method(fs, "writeFileSync", () => assert.fail("NO_WRITES"));
  t.mock.method(globalThis, "fetch", () => assert.fail("NO_NETWORK"));
  delete require.cache[filename];
  try { assert.equal(typeof require(filename).verifyRank1Runtime, "function"); }
  finally { require.cache[filename] = cached; }
  assert.equal(reads.length, 1);
});

test("actual fixed source/compiled commitments instantiate all five owner ranges without exposing bytecode", () => {
  const source = loadRank1SourceProof();
  assert.equal(source.sourceSha256, "ca2666e360d08f3c755709afde70495906f85a6e76524ed73b73023c44c232ae");
  assert.equal(source.compiledSha256, "ff6e6512eb5aa8adf80f1c4109e5b188e8e65e0b127c9dd3773923832e8dfe46");
  assert.equal(source.runtimeBytes, 7578); assert.equal(keccak256(runtime()), source.runtimeKeccak256);
  assert.equal(source.runtimeKeccak256, "0x9bfeec237d3689863be8dda33148dfecaa28433c115513b2cc211733c593f833");
  assert.deepEqual(source.ownerImmutableRanges.map(r => [r.start, r.length]), [[252, 32], [868, 32], [4524, 32], [4775, 32], [6307, 32]]);
  assert.equal(source.zeroInventorySourceInvariant, false); assert.equal(source.settlementVerified, false);
  assert.ok(Object.isFrozen(source.ownerImmutableRanges[0])); assert.ok(JSON.stringify(source).length < 1800);
  assert.equal(Object.hasOwn(source, "runtime"), false); assert.equal(source.owner, TARGET.owner);
});

test("source test seam reads exactly the fixed three public files", () => {
  const files = artifacts(), seen = [];
  const source = loadRank1SourceProof({ readFile(file) { seen.push(file); assert.ok(files.has(file)); return files.get(file); } });
  assert.deepEqual(seen, [SOURCE, COMPILED, BATCH].map(file => path.join(ROOT, file)));
  assert.equal(source.runtimeBytes, 7578);
});

for (const which of [SOURCE, COMPILED]) test(`changed ${path.extname(which)} bytes cannot be approved with caller-supplied commitments`, () => {
  const files = artifacts(); files.set(path.join(ROOT, which), Buffer.concat([files.get(path.join(ROOT, which)), Buffer.from("\n")]));
  assert.throws(() => loadRank1SourceProof({ readFile: file => files.get(file) }), safe("RANK1_SOURCE_COMMITMENT_MISMATCH"));
  assert.throws(() => loadRank1SourceProof({ sourceSha256: "0".repeat(64) }), safe("RANK1_OPTIONS_INVALID"));
});

for (const mutation of ["approved", "sourceHash", "compiledHash", "owner", "path", "caps", "expiry"])
  test(`batch ${mutation} drift rejects source approval`, () => {
    const files = artifacts(), batch = JSON.parse(files.get(path.join(ROOT, BATCH))), binding = batch.targets[0];
    if (mutation === "approved") batch.approved = false;
    if (mutation === "sourceHash") binding.sourceSha256 = "0".repeat(64);
    if (mutation === "compiledHash") binding.compiledSha256 = "0".repeat(64);
    if (mutation === "owner") binding.expectedOwner = TARGET.executor;
    if (mutation === "path") binding.sourcePath = "UNTRUSTED_RPC_DETAIL";
    if (mutation === "caps") batch.caps.maxExecuteGasLimit++;
    if (mutation === "expiry") batch.expiresAt = "2027-01-01T00:00:00Z";
    files.set(path.join(ROOT, BATCH), Buffer.from(JSON.stringify(batch)));
    assert.throws(() => loadRank1SourceProof({ readFile: file => files.get(file) }), safe("RANK1_SOURCE_APPROVAL_INVALID"));
  });

test("artifact read failure is sanitized and forged source metadata is not runtime authority", async () => {
  assert.throws(() => loadRank1SourceProof({ readFile() { throw new Error("UNTRUSTED_RPC_DETAIL"); } }), safe("RANK1_SOURCE_ARTIFACT_UNAVAILABLE"));
  await assert.rejects(verifyRank1Runtime(fixture().pinned, { sourceProof: clone(loadRank1SourceProof()) }), safe("RANK1_SOURCE_PROOF_REQUIRED"));
});

test("fresh runtime/owner/decimals/zero-inventory proof works before any health path; independent reads are width two", async () => {
  const f = fixture({ delay: 2 }), result = await verifyRank1Runtime(f.pinned);
  assert.equal(f.state.reads.length, 6); assert.equal(f.state.peak, 2); assert.equal(f.state.active, 0);
  assert.equal(result.executor, TARGET.executor); assert.equal(result.inventories.usde.decimals, 18); assert.equal(result.inventories.usdc.decimals, 6);
  assert.equal(result.inventories.usde.balanceRaw, "0"); assert.equal(result.inventories.usdc.balanceRaw, "0");
  assert.equal(result.settlementVerified, false); assert.match(result.zeroOwnPrincipalPolicy, /^RUNNER_/);
  assert.ok(Object.isFrozen(result.inventories.usdc)); assert.ok(Object.isFrozen(result.pin));
  assert.doesNotMatch(JSON.stringify(result), /0x6080/);
  await verifyRank1Runtime(f.pinned, { sourceProof: loadRank1SourceProof() }); assert.equal(f.state.reads.length, 12);
});

for (const mutation of ["runtime", "immutableOwner", "owner", "usdeBalance", "usdcBalance", "usdeDecimals", "usdcDecimals"])
  test(`runtime proof rejects ${mutation}`, async () => {
    const f = fixture(); let code;
    if (mutation === "runtime" || mutation === "immutableOwner") {
      const bytes = Buffer.from(f.state.runtime.slice(2), "hex"); bytes[mutation === "runtime" ? 0 : 283] ^= 1;
      f.state.runtime = "0x" + bytes.toString("hex"); code = "RANK1_RUNTIME_MISMATCH";
    } else if (mutation === "owner") { f.state.owner = TARGET.executor; code = "RANK1_OWNER_MISMATCH"; }
    else if (mutation.endsWith("Balance")) {
      f.state.balances[mutation.startsWith("usde") ? TARGET.usde : TARGET.usdc] = 1n; code = "RANK1_EXECUTOR_INVENTORY_NONZERO";
    } else { f.state.decimals[mutation.startsWith("usde") ? TARGET.usde : TARGET.usdc] = 8n; code = "RANK1_TOKEN_DECIMALS_MISMATCH"; }
    await assert.rejects(verifyRank1Runtime(f.pinned), safe(code));
  });

test("canonical ABI rejects padded/trailing runtime state values", async () => {
  const f = fixture(); f.state.hook = row => row.method === "owner" ? ABI.encodeFunctionResult("owner", [TARGET.owner]) + "00" : undefined;
  await assert.rejects(verifyRank1Runtime(f.pinned), safe("RANK1_ABI_INVALID"));
});

test("started runtime jobs drain after failure without launching token reads", async () => {
  const f = fixture(), gate = deferred(); let done = false;
  f.state.hook = async row => {
    if (row.method === "code") return "0x00";
    if (row.method === "owner") await gate.promise;
  };
  const pending = assert.rejects(verifyRank1Runtime(f.pinned), safe("RANK1_RUNTIME_MISMATCH")).then(() => { done = true; });
  await turn(); assert.equal(done, false); assert.equal(f.state.reads.length, 2); gate.resolve(); await pending;
  assert.equal(f.state.active, 0); assert.equal(f.state.reads.length, 2);
});

for (const kind of ["untrusted", "pin-change", "revoked", "rpc-error"]) test(`runtime proof fails closed on ${kind}`, async () => {
  const f = fixture();
  if (kind === "untrusted") f.pinned.evidence.independentFamilies = false;
  if (kind === "pin-change") f.state.hook = () => { f.pinned.pin.hash = hash(8); };
  if (kind === "revoked") f.state.hook = () => { f.state.usable = false; };
  if (kind === "rpc-error") f.state.hook = () => { throw new Error("UNTRUSTED_RPC_DETAIL"); };
  await assert.rejects(verifyRank1Runtime(f.pinned), safe({ untrusted: "RANK1_STRICT_PIN_REQUIRED", "pin-change": "RANK1_PIN_CHANGED",
    revoked: "RANK1_PIN_INVALID", "rpc-error": "RANK1_RPC_FAILED" }[kind]));
});

test("ETH/USD and USDC/USD use exact addresses/denominations, fresh parent checks and stricter child age", async () => {
  const f = fixture({ delay: 1 }), feeds = await readRank1Feeds(f.pinned, { contextTimestamp: AT + 12 });
  assert.equal(f.state.reads.length, 6); assert.equal(f.state.peak, 2);
  assert.deepEqual([...new Set(f.state.reads.map(row => row.to))].sort(), [POLICY.ethUsd.address, POLICY.usdcUsd.address].sort());
  assert.equal(feeds.ethUsd.description, "ETH / USD"); assert.equal(feeds.usdcUsd.description, "USDC / USD");
  assert.equal(feeds.ethUsd.ageAtPinSeconds, "30"); assert.equal(feeds.ethUsd.ageAtContextSeconds, "42");
  assert.equal(feeds.usdcUsd.maxAgeSeconds, 82800); assert.ok(Object.isFrozen(feeds.ethUsd));
  await readRank1Feeds(f.pinned); assert.equal(f.state.reads.length, 12, "feeds are never cached");
});

for (const feedName of ["ethUsd", "usdcUsd"]) for (const mutation of ["stale", "future", "startedFuture", "zero", "negative", "zeroRound", "incomplete", "startZero", "reversed", "denomination", "decimals", "abi"])
  test(`${feedName} rejects ${mutation}`, async () => {
    const f = fixture(), config = POLICY[feedName], row = f.state.feeds[config.address]; let code;
    if (mutation === "stale") { row.round[2] = row.round[3] = BigInt(AT - config.maxAgeSeconds - 1); code = "RANK1_FEED_STALE"; }
    if (mutation === "future") { row.round[3] = BigInt(AT + 1); code = "RANK1_FEED_FUTURE_TIMESTAMP"; }
    if (mutation === "startedFuture") { row.round[2] = row.round[3] = BigInt(AT + 1); code = "RANK1_FEED_FUTURE_TIMESTAMP"; }
    if (mutation === "zero" || mutation === "negative") { row.round[1] = mutation === "zero" ? 0n : -1n; code = "RANK1_FEED_PRICE_INVALID"; }
    if (mutation === "zeroRound") { row.round[0] = 0n; code = "RANK1_FEED_ROUND_INVALID"; }
    if (mutation === "incomplete") { row.round[4] = 6n; code = "RANK1_FEED_ROUND_INVALID"; }
    if (mutation === "startZero") { row.round[2] = 0n; code = "RANK1_FEED_ROUND_INVALID"; }
    if (mutation === "reversed") { row.round[2] = BigInt(AT - 1); code = "RANK1_FEED_ROUND_INVALID"; }
    if (mutation === "denomination") { row.description = "DAI / USD"; code = "RANK1_FEED_DENOMINATION_MISMATCH"; }
    if (mutation === "decimals") { row.decimals = 18n; code = "RANK1_FEED_CONFIGURATION_INVALID"; }
    if (mutation === "abi") { f.state.hook = call => call.to === config.address && call.method === "description"
      ? ABI.encodeFunctionResult("description", [row.description]) + "00" : undefined; code = "RANK1_ABI_INVALID"; }
    await assert.rejects(readRank1Feeds(f.pinned, { contextTimestamp: AT + 12 }), safe(code));
  });

for (const feedName of ["ethUsd", "usdcUsd"]) test(`${feedName} exact maxAge is accepted, but child timestamp never relaxes it`, async () => {
  const f = fixture(), config = POLICY[feedName], row = f.state.feeds[config.address];
  row.round[2] = row.round[3] = BigInt(AT - config.maxAgeSeconds);
  await readRank1Feeds(f.pinned);
  await assert.rejects(readRank1Feeds(f.pinned, { contextTimestamp: AT + 1 }), safe("RANK1_FEED_STALE"));
  await assert.rejects(readRank1Feeds(f.pinned, { contextTimestamp: AT - 1 }), safe("RANK1_CONTEXT_TIMESTAMP_INVALID"));
});

test("integer valuation passes BEFORE-gas floor to wallet guard, reporting gas exactly once separately", async () => {
  const result = valueRank1Profit({ profitUsdcRaw: 100000000n, fees: FEES, feeds: await freshFeeds() });
  assert.equal(result.profitHaircutUsdcRaw, "10000000"); assert.equal(result.additionalReserveUsdcRaw, "2000000");
  assert.equal(result.conservativeProfitBeforeGasUsdcRaw, "88000000");
  assert.equal(result.conservativeProfitBeforeGasWei, "44000000000000000");
  assert.equal(result.nativeGasBudgetWei, "325000000000000");
  assert.equal(result.afterGas.netNativeWei, "43675000000000000");
  assert.equal(result.afterGas.netUsdcRaw, "87350000"); assert.equal(result.afterGas.netUsdE8, "8735000000");
  assert.equal(BigInt(result.conservativeProfitBeforeGasWei) - FEES.gasLimit * FEES.maxFeePerGas, BigInt(result.afterGas.netNativeWei));
  assert.notEqual(result.conservativeProfitBeforeGasWei, result.afterGas.netNativeWei, "do not pass after-gas net to the wallet guard");
  assert.equal(result.policy.reserveAuthority, "STRICTER_ENGINEERING_RESERVE_NOT_BATCH_AUTHORIZATION");
  assert.equal(result.realizedProfit, "UNKNOWN"); assert.equal(result.settlementVerified, false); assert.ok(Object.isFrozen(result.afterGas));
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("haircut/gas round upward and USDC/native/USD floors round downward with nondivisible prices", async () => {
  const feeds = clone(await freshFeeds()); feeds.ethUsd.answerRaw = "217312345678"; feeds.usdcUsd.answerRaw = "99876543";
  const profit = 100000001n, fees = { gasLimit: 1234567n, maxFeePerGas: 123456789n, maxPriorityFeePerGas: 1n };
  const value = valueRank1Profit({ profitUsdcRaw: profit, fees, feeds }), haircut = (profit * 1000n + 9999n) / 10000n;
  const beforeGas = valueRank1ProfitBeforeGas({ profitUsdcRaw: profit, feeds });
  for (const field of ["profitHaircutUsdcRaw", "additionalReserveUsdcRaw", "conservativeProfitBeforeGasUsdcRaw", "conservativeProfitBeforeGasWei"])
    assert.equal(beforeGas[field], value[field]);
  const conservative = profit - 2000000n - haircut, numerator = conservative * BigInt(feeds.usdcUsd.answerRaw) * W;
  const denominator = U * BigInt(feeds.ethUsd.answerRaw), floor = BigInt(value.conservativeProfitBeforeGasWei);
  assert.equal(value.profitHaircutUsdcRaw, "10000001"); assert.ok(numerator % denominator > 0n);
  assert.ok(floor * denominator <= numerator); assert.ok((floor + 1n) * denominator > numerator);
  const gasNumerator = fees.gasLimit * fees.maxFeePerGas * BigInt(feeds.ethUsd.answerRaw) * U;
  const gasDenominator = W * BigInt(feeds.usdcUsd.answerRaw), gasCeil = BigInt(value.gasCostUsdcRawCeil);
  assert.ok(gasCeil * gasDenominator >= gasNumerator); assert.ok((gasCeil - 1n) * gasDenominator < gasNumerator);
  const net = floor - fees.gasLimit * fees.maxFeePerGas;
  assert.equal(BigInt(value.afterGas.netUsdE8), net * BigInt(feeds.ethUsd.answerRaw) / W);
  assert.equal(BigInt(value.afterGas.netUsdcRaw), net * BigInt(feeds.ethUsd.answerRaw) * U / (W * BigInt(feeds.usdcUsd.answerRaw)));
});

for (const invalid of [undefined, -1n, 0n, 99999999n, 100000000, 1.5, "1e8", "0100000000", MAX + 1n])
  test(`reject malformed/negative/below-floor/Number profit (${String(invalid)})`, async () => {
    const feeds = await freshFeeds();
    assert.throws(() => valueRank1Profit({ profitUsdcRaw: invalid, fees: FEES, feeds }), safe("RANK1_PROFIT_FLOOR_INVALID"));
    assert.throws(() => valueRank1ProfitBeforeGas({ profitUsdcRaw: invalid, feeds }), safe("RANK1_PROFIT_FLOOR_INVALID"));
  });

for (const change of [{ gasLimit: 0n }, { gasLimit: 1300001n }, { maxFeePerGas: 0n }, { maxFeePerGas: 1500000001n },
  { maxPriorityFeePerGas: 250000001n }, { gasLimit: -1n }, { maxFeePerGas: MAX + 1n }, { gasLimit: 1300000 }, { value: 1n }])
  test(`rank-1 competitive fee/value caps reject ${Object.keys(change)[0]} override`, async () => {
    const feeds = await freshFeeds();
    assert.throws(() => valueRank1Profit({ profitUsdcRaw: 100000000n, fees: { ...FEES, ...change }, feeds }), error => {
      assert.ok(error instanceof ExecutionError); assert.match(error.code, /^RANK1_(FEES_INVALID|FEE_CAP_EXCEEDED|VALUE_CAP_EXCEEDED)$/); return true;
    });
  });

test("malformed fees/inputs and missing priority reject without Number coercion", async () => {
  const feeds = await freshFeeds();
  for (const fees of [null, [], {}, { gasLimit: 1000000n, maxFeePerGas: 100000000n }])
    assert.throws(() => valueRank1Profit({ profitUsdcRaw: 100000000n, fees, feeds }), safe("RANK1_FEES_INVALID"));
  assert.throws(() => valueRank1Profit(null), safe("RANK1_ECONOMICS_INPUT_INVALID"));
  for (const input of [null, [], 1]) assert.throws(() => valueRank1ProfitBeforeGas(input), safe("RANK1_ECONOMICS_INPUT_INVALID"));
  assert.throws(() => valueRank1ProfitBeforeGas({ profitUsdcRaw: 100n * U }), safe("RANK1_FEEDS_INVALID"));
});

test("zero/negative net fails, uint256 arithmetic overflow fails, and max authorized fees remain bounded", async () => {
  const feeds = clone(await freshFeeds()), fees = { gasLimit: 1000000n, maxFeePerGas: 100000000n, maxPriorityFeePerGas: 0n };
  feeds.ethUsd.answerRaw = "88000000000000";
  assert.equal(valueRank1ProfitBeforeGas({ profitUsdcRaw: 100n * U, feeds }).conservativeProfitBeforeGasWei, "100000000000000");
  assert.throws(() => valueRank1Profit({ profitUsdcRaw: 100000000n, fees, feeds }), safe("RANK1_NET_NONPOSITIVE"));
  feeds.ethUsd.answerRaw = "88000000000001";
  assert.ok(BigInt(valueRank1ProfitBeforeGas({ profitUsdcRaw: 100n * U, feeds }).conservativeProfitBeforeGasWei) < fees.gasLimit * fees.maxFeePerGas);
  assert.throws(() => valueRank1Profit({ profitUsdcRaw: 100000000n, fees, feeds }), safe("RANK1_NET_NONPOSITIVE"));
  const fresh = await freshFeeds();
  assert.throws(() => valueRank1Profit({ profitUsdcRaw: MAX, fees: FEES, feeds: fresh }), safe("RANK1_ARITHMETIC_OVERFLOW"));
  assert.throws(() => valueRank1ProfitBeforeGas({ profitUsdcRaw: MAX, feeds: fresh }), safe("RANK1_ARITHMETIC_OVERFLOW"));
  const result = valueRank1Profit({ profitUsdcRaw: 100000000n, fees: FEES, feeds: fresh });
  assert.ok(BigInt(result.nativeGasBudgetWei) <= BigInt(POLICY.nativeSpendWeiCap));
});

for (const mutation of ["future", "stale", "round", "description", "decimals", "address", "overflow", "priceNumber", "expiry"])
  test(`pure valuation independently rejects ${mutation} feed evidence`, async () => {
    const feeds = clone(await freshFeeds()); let code;
    if (mutation === "future") { feeds.ethUsd.updatedAt = String(AT + 1); code = "RANK1_FEED_FUTURE_TIMESTAMP"; }
    if (mutation === "stale") { feeds.contextTimestamp = String(AT + 3600); code = "RANK1_FEED_STALE"; }
    if (mutation === "round") { feeds.ethUsd.answeredInRound = "0"; code = "RANK1_FEED_ROUND_INVALID"; }
    if (mutation === "description") { feeds.usdcUsd.description = "DAI / USD"; code = "RANK1_FEED_DENOMINATION_MISMATCH"; }
    if (mutation === "decimals") { feeds.ethUsd.decimals = 18; code = "RANK1_FEED_CONFIGURATION_INVALID"; }
    if (mutation === "address") { feeds.ethUsd.address = TARGET.usdc; code = "RANK1_FEED_DENOMINATION_MISMATCH"; }
    if (mutation === "overflow") { feeds.ethUsd.answerRaw = MAX.toString(); code = "RANK1_FEED_PRICE_INVALID"; }
    if (mutation === "priceNumber") { feeds.ethUsd.answerRaw = 200000000000; code = "RANK1_FEED_PRICE_INVALID"; }
    if (mutation === "expiry") { feeds.contextTimestamp = String(Date.parse(POLICY.expiresAt) / 1000); code = "RANK1_APPROVAL_EXPIRED"; }
    assert.throws(() => valueRank1Profit({ profitUsdcRaw: 100000000n, fees: FEES, feeds }), safe(code));
    assert.throws(() => valueRank1ProfitBeforeGas({ profitUsdcRaw: 100000000n, feeds }), safe(code));
  });

test("before-gas valuation is valid despite negative diagnostic net but never claims final profitability", async () => {
  const feeds = clone(await freshFeeds()); feeds.ethUsd.answerRaw = "80000000000000";
  const input = { profitUsdcRaw: 100n * U, feeds }, beforeGas = valueRank1ProfitBeforeGas(input);
  assert.equal(beforeGas.schema, "rank1-before-gas-valuation/v1");
  assert.equal(beforeGas.contractEnforcedProfitUsdcRaw, "100000000");
  assert.equal(beforeGas.additionalReserveUsdcRaw, "2000000"); assert.equal(beforeGas.profitHaircutUsdcRaw, "10000000");
  assert.equal(beforeGas.conservativeProfitBeforeGasUsdcRaw, "88000000");
  assert.equal(beforeGas.conservativeProfitBeforeGasWei, "110000000000000");
  assert.equal(beforeGas.afterGas, "NOT_EVALUATED"); assert.equal(beforeGas.settlementVerified, false);
  assert.equal(Object.hasOwn(beforeGas, "positive"), false); assert.equal(Object.hasOwn(beforeGas, "nativeGasBudgetWei"), false);
  assert.ok(Object.isFrozen(beforeGas)); assert.ok(Object.isFrozen(beforeGas.pin));
  const diagnostic = { gasLimit: 1300000n, maxFeePerGas: 120986876n, maxPriorityFeePerGas: 50000000n };
  assert.equal(diagnostic.gasLimit * diagnostic.maxFeePerGas, 157282938800000n);
  assert.throws(() => valueRank1Profit({ ...input, fees: diagnostic }), safe("RANK1_NET_NONPOSITIVE"));
  const fees = { gasLimit: 1300000n, maxFeePerGas: 82237810n, maxPriorityFeePerGas: 42307692n };
  const final = valueRank1Profit({ ...input, fees });
  assert.equal(final.conservativeProfitBeforeGasWei, beforeGas.conservativeProfitBeforeGasWei);
  assert.equal(final.nativeGasBudgetWei, "106909153000000"); assert.equal(final.afterGas.netNativeWei, "3090847000000");
  assert.equal(final.positive, true);
});

test("competitive policy changes only fee and native-spend ceilings", () => {
  assert.equal(POLICY.maxFeePerGasWeiCap, "1500000000"); assert.equal(POLICY.nativeSpendWeiCap, "1950000000000000");
  assert.equal(POLICY.gasLimitCap, "1300000"); assert.equal(POLICY.valueWei, "0");
  assert.equal(POLICY.minimumProfitUsdcRaw, "100000000"); assert.equal(POLICY.additionalReserveUsdcRaw, "2000000");
  assert.equal(POLICY.profitHaircutBps, "1000"); assert.equal(POLICY.expiresAt, "2026-10-30T23:59:59Z");
  assert.equal(POLICY.ethUsd.maxAgeSeconds, 3600); assert.equal(POLICY.usdcUsd.maxAgeSeconds, 82800);
});

for (const maxFeePerGas of [250000001n, 1500000000n]) test(`competitive ceiling accepts ${maxFeePerGas} wei without changing before-gas profit`, async () => {
  const feeds = await freshFeeds(), fees = { ...FEES, maxFeePerGas, maxPriorityFeePerGas: maxFeePerGas };
  const original = valueRank1Profit({ profitUsdcRaw: 100n * U, fees: FEES, feeds });
  const result = valueRank1Profit({ profitUsdcRaw: 100n * U, fees, feeds });
  assert.equal(result.conservativeProfitBeforeGasWei, original.conservativeProfitBeforeGasWei);
  assert.equal(result.conservativeProfitBeforeGasWei, "44000000000000000");
  const spend = fees.gasLimit * fees.maxFeePerGas;
  assert.equal(BigInt(result.nativeGasBudgetWei), spend); assert.ok(spend <= 1950000000000000n);
  assert.equal(BigInt(result.afterGas.netNativeWei), 44000000000000000n - spend);
  if (maxFeePerGas === 1500000000n) {
    assert.equal(spend, 1950000000000000n); assert.equal(result.afterGas.netNativeWei, "42050000000000000");
  }
});

for (const field of ["maxFeePerGasWei", "maxNativeSpendPerTransactionWei"]) test(`source proof retains original base-batch ${field}, not the new gas policy`, () => {
  const files = artifacts(), batch = JSON.parse(files.get(path.join(ROOT, BATCH)));
  assert.equal(batch.caps.maxFeePerGasWei, "250000000"); assert.equal(batch.caps.maxNativeSpendPerTransactionWei, "550000000000000");
  assert.equal(loadRank1SourceProof({ readFile: file => files.get(file) }).settlementVerified, false);
  batch.caps[field] = field === "maxFeePerGasWei" ? POLICY.maxFeePerGasWeiCap : POLICY.nativeSpendWeiCap;
  files.set(path.join(ROOT, BATCH), Buffer.from(JSON.stringify(batch)));
  assert.throws(() => loadRank1SourceProof({ readFile: file => files.get(file) }), safe("RANK1_SOURCE_APPROVAL_INVALID"));
});

test("new gas amendment cannot substitute for the original source approval", () => {
  const files = artifacts();
  files.set(path.join(ROOT, BATCH), fs.readFileSync(path.join(ROOT, "coordination/decisions/20261024-rank1-competitive-gas-approval.json")));
  assert.throws(() => loadRank1SourceProof({ readFile: file => files.get(file) }), safe("RANK1_SOURCE_APPROVAL_INVALID"));
});

test("new maximum gas spend still requires strictly positive net", async () => {
  const feeds = clone(await freshFeeds()), fees = { gasLimit: 1300000n, maxFeePerGas: 1500000000n, maxPriorityFeePerGas: 1n };
  feeds.ethUsd.answerRaw = "5000000000000"; // 88 USDC before gas is less than the maximum gas budget.
  assert.throws(() => valueRank1Profit({ profitUsdcRaw: 100n * U, fees, feeds }), safe("RANK1_NET_NONPOSITIVE"));
});

for (const other of ["price", "future", "rpc", "revoked", "pin-change"]) for (const staleFirst of [true, false])
  test(`feed drain: ${other} outranks age-only stale (${staleFirst ? "stale first" : "hard failure first"})`, async () => {
    const f = fixture(), entered = deferred(), gates = [deferred(), deferred()]; let started = 0, done = false;
    const eth = f.state.feeds[POLICY.ethUsd.address], usdc = f.state.feeds[POLICY.usdcUsd.address];
    eth.round[2] = eth.round[3] = BigInt(AT - POLICY.ethUsd.maxAgeSeconds - 1);
    if (other === "price") usdc.round[1] = 0n;
    if (other === "future") usdc.round[3] = BigInt(AT + 1);
    f.state.hook = async row => {
      if (row.method !== "latestRoundData") return;
      const index = row.to === POLICY.ethUsd.address ? 0 : 1;
      if (++started === 2) entered.resolve(); await gates[index].promise;
      if (index === 1 && other === "rpc") throw new Error("UNTRUSTED_RPC_DETAIL");
      if (index === 1 && other === "revoked") f.state.usable = false;
      if (index === 1 && other === "pin-change") f.pinned.pin.hash = hash(999);
    };
    const code = { price: "RANK1_FEED_PRICE_INVALID", future: "RANK1_FEED_FUTURE_TIMESTAMP", rpc: "RANK1_RPC_FAILED",
      revoked: "RANK1_PIN_INVALID", "pin-change": "RANK1_PIN_CHANGED" }[other];
    const rejected = assert.rejects(readRank1Feeds(f.pinned).finally(() => { done = true; }), safe(code));
    await entered.promise; gates[staleFirst ? 0 : 1].resolve(); await turn();
    assert.equal(done, false); assert.equal(f.state.active, 1); assert.equal(f.state.peak, 2);
    assert.equal(f.state.reads.length, 6); gates[staleFirst ? 1 : 0].resolve(); await rejected;
    assert.equal(f.state.active, 0); assert.equal(f.state.reads.length, 6, "drain must not dispatch further reads");
  });

for (const bothStale of [false, true]) test(`age-only feed drain retains stale (${bothStale ? "both feeds" : "one stale, one valid"})`, async () => {
  const f = fixture(), entered = deferred(), release = deferred(); let done = false;
  for (const config of bothStale ? [POLICY.ethUsd, POLICY.usdcUsd] : [POLICY.ethUsd]) {
    const feed = f.state.feeds[config.address]; feed.round[2] = feed.round[3] = BigInt(AT - config.maxAgeSeconds - 1);
  }
  f.state.hook = async row => {
    if (row.to === POLICY.usdcUsd.address && row.method === "latestRoundData") { entered.resolve(); await release.promise; }
  };
  const rejected = assert.rejects(readRank1Feeds(f.pinned).finally(() => { done = true; }), safe("RANK1_FEED_STALE"));
  await entered.promise; await turn(); assert.equal(done, false); assert.equal(f.state.active, 1);
  release.resolve(); await rejected; assert.equal(f.state.active, 0); assert.equal(f.state.reads.length, 6);
});
