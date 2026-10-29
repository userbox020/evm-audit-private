"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");
const { Interface } = require("ethers");
const { buildRegistry, decodeStudyLog } = require("../strategy-study/registry");

const ROOT = path.resolve(__dirname, "../..");
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const D = "0x4444444444444444444444444444444444444444";
const HASH = `0x${"ab".repeat(32)}`;
const COMET = "targets/compound-comet-f766f515-provenance-bootstrap/deployments";
const EULER_INDEX = "reports/monitor/euler-l-index.json";
const EULER_OBSERVATION = "reports/raw/fast/euler-l.json";
const SILO_INDEX = "reports/monitor/silo-l-index.json";
const SILO_OBSERVATION = "reports/raw/fast/silo-l.json";
const SPOKES = "reports/raw/fast/aave-v4-spoke-borrowers.json";

function seeds() {
  return {
    [SPOKES]: { chain: { id: 1 }, spokes: [{ spoke: B }, { spoke: A }, { spoke: B }] },
    [EULER_INDEX]: { chainId: 1, proxyCreated: { vaults: { [D]: {}, [C]: {} } } },
    [SILO_INDEX]: { chains: {
      1: { chainId: 1, structural: { [D]: { silo0: C, silo1: D, hookReceiver: B, sides: { [C]: { hookReceiver: B }, [D]: { hookReceiver: A } } } } },
      8453: { chainId: 8453, structural: {} },
    } },
    [`${COMET}/mainnet/usdc/roots.json`]: { comet: "0xc3d688B66703497DAA19211EEdff47f25384cdc3" },
    [`${COMET}/mainnet/weth/roots.json`]: { comet: A },
    [`${COMET}/base/usdc/roots.json`]: { comet: "0xb125E6687d4313864e53df431d5425969c15Eb2F" },
  };
}
function fixture(files = seeds()) {
  const reads = [];
  return { reads, readFile(absolute) {
    const ref = path.relative(ROOT, absolute).replace(/\\/g, "/");
    reads.push(ref);
    if (!(ref in files)) { const err = new Error("missing public fixture"); err.code = "ENOENT"; throw err; }
    return typeof files[ref] === "string" || Buffer.isBuffer(files[ref]) ? files[ref] : JSON.stringify(files[ref]);
  } };
}
function registry(chainId = 1, files = seeds()) {
  const reader = fixture(files);
  return buildRegistry({ chainId, root: ROOT, readFile: reader.readFile });
}
function source(id, chainId = 1) { return registry(chainId).sources.find(row => row.id === id); }
function logFor(src, event, values) {
  const encoded = new Interface(src.abi).encodeEventLog(event, values);
  return { chainId: src.chainId, address: src.addresses[0], ...encoded, transactionHash: HASH, logIndex: "0x1" };
}
function decode(id, event, values) {
  const src = source(id);
  const result = decodeStudyLog(src, logFor(src, event, values));
  assert.equal(result.status, "decoded");
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal("profit" in result, false);
  assert.equal("realizedProfit" in result, false);
  return result;
}

test("fixed roots are identities, Comet roots are local markets, output is deterministic and deduplicated", () => {
  const files = seeds(), reader = fixture(files);
  const first = buildRegistry({ chainId: 1, root: ROOT, readFile: reader.readFile });
  const second = registry(1, { ...files, [SPOKES]: { chain: { id: 1 }, spokes: [{ spoke: A }, { spoke: B }] } });
  assert.equal(first.sources.length, 8);
  assert.deepEqual(first.sources.map(s => s.id), [...first.sources.map(s => s.id)].sort());
  assert.equal(first.sources.find(s => s.id === "aave-v3").addresses.length, 1);
  assert.equal(first.sources.find(s => s.id === "morpho-blue").addresses.length, 1);
  assert.equal(first.sources.find(s => s.id === "compound-iii").addresses.length, 2);
  assert.equal(first.sources.find(s => s.id === "euler-evk").addresses.length, 2);
  assert.deepEqual(first.sources.find(s => s.id === "aave-v4").addresses, [A, B]);
  assert.deepEqual(first.sources.find(s => s.id === "aave-v4").rootRefs, second.sources.find(s => s.id === "aave-v4").rootRefs);
  assert.deepEqual(first, registry());
  assert.equal(new Set(reader.reads).size, reader.reads.length, "same file read once per build");
  for (const row of first.sources) {
    assert.deepEqual(row.addresses, [...new Set(row.addresses)].sort());
    assert.ok(row.addresses.every(a => /^0x[0-9a-f]{40}$/.test(a)));
    assert.ok(row.topic0.every(t => /^0x[0-9a-f]{64}$/.test(t)));
    assert.ok(row.coverageNotes.some(n => n.startsWith("SEED_UNIVERSE_ONLY")));
    assert.ok(row.coverageNotes.some(n => n.startsWith("HISTORICAL_VALIDITY_UNVERIFIED")));
  }
  const expectedHash = crypto.createHash("sha256").update(JSON.stringify(files[EULER_INDEX])).digest("hex");
  assert.equal(first.sources.find(s => s.id === "euler-evk").sourceHashes[EULER_INDEX], expectedHash);
  assert.ok(first.coverageNotes.some(n => n.startsWith("DUAL_RPC_EVENT_CORROBORATION_REQUIRED")));
});

test("all fixed checkout Comet markets are loaded, rather than only USDC", () => {
  for (const [chainId, folder, names] of [
    [1, "mainnet", ["usdc", "usds", "usdt", "wbtc", "weth", "wsteth"]],
    [8453, "base", ["aero", "usdbc", "usdc", "usds", "weth"]],
  ]) {
    const files = seeds();
    names.forEach((name, i) => { if (name !== "usdc") files[`${COMET}/${folder}/${name}/roots.json`] = { comet: `0x${(i + 10).toString(16).padStart(40, "0")}` }; });
    const comet = registry(chainId, files).sources.find(s => s.id === "compound-iii");
    assert.equal(comet.addresses.length, names.length);
    assert.equal(comet.rootRefs.length, names.length);
    assert.ok(comet.coverageNotes.some(n => n.startsWith("LOCAL_DEPLOYMENT_MARKETS_ONLY")));
  }
});

test("Base does not inherit Ethereum vaults or hooks; factory and hub metadata are not liquidation emitters", () => {
  const reader = fixture(), manifest = buildRegistry({ chainId: 8453, root: ROOT, readFile: reader.readFile });
  const get = id => manifest.sources.find(s => s.id === id);
  assert.equal(get("aave-v4").addresses.length, 1);
  assert.equal(get("aave-v4").addresses[0], "0x17905db0e4a3514467539956c084180616ae7b8d");
  assert.equal(get("aave-v4").addresses.includes(get("aave-v4").rootRefs.find(r => r.role.startsWith("hub")).address), false);
  assert.deepEqual(get("euler-evk").addresses, []);
  assert.deepEqual(get("silo-v3").addresses, []);
  assert.ok(get("euler-evk").coverageNotes.some(n => n.startsWith("BASE_VAULT_REGISTRY_MISSING")));
  assert.equal(reader.reads.includes(EULER_INDEX), false);
  assert.equal(reader.reads.includes(EULER_OBSERVATION), false);
  assert.equal(get("euler-evk-factory").kind, "deployment-discovery");
  assert.equal(get("euler-evk-factory").addresses[0], "0x7f321498a801a191a93c840750ed637149ddf8d0");
  assert.equal(get("euler-evk").addresses.includes(get("euler-evk-factory").addresses[0]), false);
});

test("missing local indexes are explicit gaps, not fabricated empty historical coverage", () => {
  const manifest = registry(1, {});
  for (const id of ["aave-v4", "euler-evk", "silo-v3", "compound-iii"]) {
    const row = manifest.sources.find(s => s.id === id);
    assert.deepEqual(row.addresses, []);
    assert.ok(row.coverageNotes.some(n => n.startsWith("MISSING_LOCAL_FILE:")));
    assert.ok(row.coverageNotes.some(n => n.startsWith("EMPTY_EMITTER_SEED:")));
  }
  assert.equal(manifest.sources.find(s => s.id === "aave-v3").addresses.length, 1);
});

test("offline observation fallbacks preserve chain scoping and extract only hookReceiver", () => {
  const files = {
    [EULER_OBSERVATION]: { chainId: 1, vaults: [{ vault: C }, { vault: C }] },
    [SILO_OBSERVATION]: { chains: [
      { chainId: 1, markets: [{ silo0: C, silo1: D, hookReceiver: B, sides: [{ hookReceiver: B }] }] },
      { chainId: 8453, markets: [{ silo0: C, silo1: D, hookReceiver: A, sides: [] }] },
    ] },
  };
  assert.deepEqual(registry(1, files).sources.find(s => s.id === "euler-evk").addresses, [C]);
  assert.deepEqual(registry(1, files).sources.find(s => s.id === "silo-v3").addresses, [B]);
  assert.deepEqual(registry(8453, files).sources.find(s => s.id === "silo-v3").addresses, [A]);
});

test("invalid chains, index chain bindings, addresses, JSON and schemas fail closed", () => {
  for (const chainId of [undefined, "1", 0, 10, 42161]) assert.throws(() => buildRegistry({ chainId }), /UNSUPPORTED_CHAIN/);
  assert.throws(() => registry(1, { [SPOKES]: { chain: { id: 8453 }, spokes: [] } }), /INDEX_CHAIN_MISMATCH/);
  assert.throws(() => registry(1, { [EULER_INDEX]: { chainId: 8453, proxyCreated: { vaults: {} } } }), /INDEX_CHAIN_MISMATCH/);
  assert.throws(() => registry(1, { [SPOKES]: { chain: { id: 1 }, spokes: [{ spoke: "bad" }] } }), /INVALID_ADDRESS/);
  assert.throws(() => registry(1, { [SPOKES]: { chain: { id: 1 }, spokes: {} } }), /INVALID_SCHEMA/);
  assert.throws(() => registry(1, { [EULER_INDEX]: "{" }), SyntaxError);
  assert.throws(() => registry(1, { [SILO_INDEX]: { chains: { 1: { chainId: 8453, structural: {} } } } }), /INDEX_CHAIN_MISMATCH/);
});

test("bounded reads stay on fixed public paths and accept indexes above 8 MiB but reject over 64 MiB", () => {
  const reader = fixture({ [EULER_INDEX]: `${JSON.stringify(seeds()[EULER_INDEX])}${" ".repeat(9 * 1024 * 1024)}` });
  assert.equal(buildRegistry({ chainId: 1, root: ROOT, readFile: reader.readFile }).sources.find(s => s.id === "euler-evk").addresses.length, 2);
  assert.ok(reader.reads.every(ref => ref.startsWith("targets/") || ref.startsWith("reports/") || ref.startsWith("tools/")));
  assert.ok(reader.reads.every(ref => !/\.env|endpoints|keypair|\.pem/.test(ref)));
  assert.throws(() => registry(1, { [EULER_INDEX]: Buffer.alloc(64 * 1024 * 1024 + 1) }), /FILE_TOO_LARGE/);
});

test("Euler vault lists are not limited to 64 emitters", () => {
  const vaults = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`0x${(i + 1).toString(16).padStart(40, "0")}`, {}]));
  const result = registry(1, { [EULER_INDEX]: { chainId: 1, proxyCreated: { vaults } } });
  assert.equal(result.sources.find(s => s.id === "euler-evk").addresses.length, 100);
});

test("source event topics match the known Aave V3, Morpho and Euler signatures", () => {
  assert.deepEqual(source("aave-v3").topic0, ["0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286"]);
  assert.deepEqual(source("morpho-blue").topic0, ["0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41"]);
  assert.deepEqual(source("euler-evk").topic0, ["0x8246cc71ab01533b5bebc672a636df812f10637ad720797319d5741d5ebb3962"]);
});

test("Aave V3 decodes raw amounts, canonical addresses and share flags; same-asset needs actual matching addresses", () => {
  const raw = 2n ** 200n;
  const result = decode("aave-v3", "LiquidationCall", [A, B, C, raw, raw + 1n, D, true]);
  assert.equal(result.fields.debtToCover, raw.toString());
  assert.equal(result.borrower, C);
  assert.equal(result.actor, D);
  assert.equal(result.assetRelationship, "cross-asset");
  assert.equal(result.sharesFlags.receiveAToken, true);
  assert.equal(decode("aave-v3", "LiquidationCall", [A, A, C, 1, 2, D, false]).assetRelationship, "same-asset");
  const zero = `0x${"0".repeat(40)}`;
  assert.equal(decode("aave-v3", "LiquidationCall", [zero, zero, C, 1, 2, D, false]).assetRelationship, "unknown");
});

test("Aave V4 preserves signed PremiumDelta tuple and never equates reserve IDs to resolved assets", () => {
  const result = decode("aave-v4", "LiquidationCall", [5, 5, C, D, true, 100, 90, [-7, -8, 9], 110, 109, 105]);
  assert.deepEqual(result.fields.premiumDelta, { sharesDelta: "-7", offsetRayDelta: "-8", restoredPremiumRay: "9" });
  assert.equal(result.assetRelationship, "unknown");
  assert.equal(result.sharesFlags.receiveShares, true);
  assert.equal(result.fields.collateralAmountRemoved, "110");
  assert.equal(result.fields.collateralSharesToLiquidator, "105");
});

test("Morpho decodes repayment, seized assets and bad-debt fields without inventing market assets", () => {
  const result = decode("morpho-blue", "Liquidate", [HASH, A, B, 10, 11, 12, 13, 14]);
  assert.equal(result.actor, A);
  assert.equal(result.borrower, B);
  assert.equal(result.fields.id, HASH);
  assert.equal(result.fields.badDebtAssets, "13");
  assert.equal(result.fields.badDebtShares, "14");
  assert.equal(result.assetRelationship, "unknown");
});

test("Compound absorption and purchases are distinct actions, never immediate reward or proven recipient", () => {
  const debt = decode("compound-iii", "AbsorbDebt", [A, B, 100, 1000]);
  const collateral = decode("compound-iii", "AbsorbCollateral", [A, B, C, 200, 2000]);
  const buy = decode("compound-iii", "BuyCollateral", [A, C, 300, 400]);
  assert.equal(debt.actionType, "absorb-debt");
  assert.equal(collateral.actionType, "absorb-collateral");
  assert.equal(buy.actionType, "buy-collateral");
  assert.equal(debt.actorRole, "absorber-not-payee");
  assert.equal(buy.actorRole, "buyer-not-proven-recipient");
  assert.equal(buy.borrower, null);
  assert.equal(debt.fields.basePaidOut, "100");
  assert.ok(debt.accountingNotes[0].includes("not immediate absorber reward"));
  assert.equal("recipient" in buy, false);
});

test("Euler liquidation decodes collateral vault shares; factory creation remains discovery", () => {
  const result = decode("euler-evk", "Liquidate", [A, B, C, 100, 200]);
  assert.equal(result.borrower, B);
  assert.equal(result.actor, A);
  assert.equal(result.sharesFlags.yieldBalanceIsCollateralVaultShares, true);
  assert.equal(result.assetRelationship, "unknown");
  const created = decode("euler-evk-factory", "ProxyCreated", [A, true, B, "0x123456"]);
  assert.equal(created.actionType, "deployment-discovery");
  assert.equal(created.actor, null);
  assert.equal(created.borrower, null);
  assert.equal(created.fields.trailingData, "0x123456");
});

test("Silo hook companion is not a second liquidation or keeper proceeds", () => {
  const primary = decode("silo-v3", "LiquidationCall", [A, C, D, 100, 200, true]);
  const companion = decode("silo-v3", "DefaultingLiquidationData", [C, D, 150, 50, 100]);
  assert.equal(primary.sharesFlags.receiveSToken, true);
  assert.equal(primary.grouping.countAsStandaloneLiquidation, true);
  assert.equal(companion.grouping.countAsStandaloneLiquidation, false);
  assert.equal(companion.grouping.family, primary.grouping.family);
  assert.equal(companion.actor, null);
  assert.equal(companion.fields.withdrawAssetsFromCollateral, "150");
  assert.equal(companion.fields.withdrawAssetsFromProtected, "50");
  assert.match(primary.grouping.match, /call-context-required/);
  const src = source("silo-v3-defaulting-accounting");
  assert.deepEqual(src.addresses, []);
  assert.ok(src.coverageNotes.some(n => n.startsWith("SILO_ACCOUNTING_EMITTER_GAP")));
  // A synthetic explicit silo source checks the ABI without silently enrolling silo emitters.
  const scoped = { ...src, addresses: [C] };
  const accounting = decodeStudyLog(scoped, logFor(scoped, "DefaultingLiquidation", [100, 80]));
  assert.deepEqual(accounting.fields, { canceledDebt: "100", deductedFromCollateral: "80" });
  assert.equal(accounting.grouping.countAsStandaloneLiquidation, false);
  assert.equal(accounting.actor, null);
});

test("emitter membership and chain are checked before decoding", () => {
  const src = source("aave-v3"), log = logFor(src, "LiquidationCall", [A, B, C, 1, 2, D, false]);
  assert.equal(decodeStudyLog(src, { ...log, address: A }).reason, "EMITTER_NOT_IN_SOURCE");
  assert.equal(decodeStudyLog(src, { ...log, chainId: 8453 }).reason, "LOG_CHAIN_MISMATCH");
  assert.equal(decodeStudyLog(src, { ...log, address: "bad" }).reason, "INVALID_LOG_ADDRESS");
});

test("malformed known ABI fails loudly; malformed logs stay unresolved with raw topics/data", () => {
  const src = source("aave-v3"), log = logFor(src, "LiquidationCall", [A, B, C, 1, 2, D, false]);
  assert.throws(() => decodeStudyLog({ ...src, abi: ["event malformed("] }, log));
  assert.throws(() => decodeStudyLog({ ...src, topic0: ["0x1234"] }, log), /INVALID_TOPIC/);
  assert.throws(() => decodeStudyLog({ ...src, topic0: [HASH] }, log), /ABI_TOPIC_MISMATCH/);
  assert.throws(() => decodeStudyLog({ ...src, addresses: ["invalid"] }, log), /INVALID_ADDRESS/);
  for (const changed of [
    { ...log, data: "0x12" },
    { ...log, data: `${log.data}${"00".repeat(32)}` },
    { ...log, topics: [HASH, ...log.topics.slice(1)] },
    { ...log, topics: ["not-a-topic"] },
    { ...log, data: "0xxyz" },
  ]) {
    const result = decodeStudyLog(src, changed);
    assert.equal(result.status, "unresolved");
    assert.deepEqual(result.raw.topics, changed.topics);
    assert.equal(result.raw.data, changed.data);
    assert.equal("fields" in result, false);
  }
});
