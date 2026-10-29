"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Interface } = require("ethers");
const observer = require("../scan-aave-v4-base-borrowers");
const contract = require("../lib/aave-v4-base-observation-contract");
const history = require("../lib/aave-v4-borrower-history");
const { makeFixture, fabricatedCreationProof, A, H, USER, CALLER } = require("./aave-v4-base-observation-contract.test");
test.beforeEach(t => t.mock.method(global, "fetch", () => assert.fail("network forbidden")));

test("Borrow USER, not CALLER, is indexed; all eight reserves use each USER's stored dynamic key", async () => {
  const f = makeFixture(); const out = await observer.collectBaseBorrowers(f.topology, f.deps);
  assert.equal(out.componentObservationComplete, true); assert.equal(out.fullHistoryProven, true);
  assert.deepEqual(out.users.map(row => row.user), [USER]); assert.notEqual(USER, CALLER);
  assert.equal(out.users[0].reserves.length, 8); assert.deepEqual(out.linksConsumed.map(row => row.reserveId), [0, 1, 2, 3, 4, 5, 6, 7]);
  const dynamic = f.state.calls.filter(row => row.name === "getDynamicReserveConfig");
  assert.equal(dynamic.length, 8); assert.ok(dynamic.every(row => row.args[1] === 7n));
  assert.equal(out.users[0].reserves[7].position.premiumOffsetRay, "-3");
  assert.equal(out.observationPin.stateReadsPinned, 65); assert.deepEqual(f.state.events, ["CONFIRM", "SAVE"]);
  assert.equal(out.debtAccounting, "PASS");
  assert.equal(out.coverage.complete, false); assert.equal(out.classSemantics.exact, false);
  assert.equal(out.liveAdmission, false); assert.equal(out.dispatchEnabled, false); assert.equal(out.usdQualification, "UNKNOWN");
});
test("positive USDC aggregate debt with zero indexed borrowers is never complete", async () => {
  const f = makeFixture({ users: [], aggregateDebtRaw: "3973538732497" });
  f.state.aggregateComponents = { 7: [3973538732497n, 0n, 0n] };
  const out = await observer.collectBaseBorrowers(f.topology, f.deps);
  assert.equal(out.fullHistoryProven, true); assert.equal(out.componentObservationComplete, false);
  assert.ok(out.errors.includes("BORROWER_DEBT_UNACCOUNTED")); assert.equal(out.linksConsumed.length, 8);
  assert.equal(out.debtAccounting, "FAIL");
});
test("treasury/tokenization remain dependencies, not borrower spokes or extra per-user targets", async () => {
  const f = makeFixture();
  for (const asset of f.topology.hubs[0].assets) {
    asset.spokeDirectory.rows.unshift({ address: "0x5f8d0102f5b51fae6de9d2f2561bda63fb5db674",
      reserve: { reserveBearing: false, reason: "NON_LENDING_INTERFACE" } });
    if (asset.assetId === 7) asset.spokeDirectory.rows.push({ address: "0x7081ce7eb1282c53cf38ea9b622f6269cb8fefdc",
      reserve: { reserveBearing: false, reason: "NON_LENDING_INTERFACE" } });
    asset.spokeDirectory.count = asset.spokeDirectory.rows.length;
  }
  const out = await observer.collectBaseBorrowers(f.topology, f.deps);
  assert.equal(out.componentObservationComplete, true);
  assert.ok(f.state.calls.every(row => [contract.SPOKE, contract.HUB].includes(row.to)));
  assert.equal(f.state.calls.filter(row => row.to === contract.HUB).length, 24);
  assert.equal(out.linksConsumed.length, 8);
});
test("Ethereum identity serialization remains exact; Base chain/registry/start/binding identities cannot share membership", () => {
  const digest = "a".repeat(64), eth = history.historyIdentity([contract.SPOKE], digest);
  assert.equal(JSON.stringify(eth), JSON.stringify({ chainId: 1, fromBlock: 0, borrowTopic: history.TOPIC, registryDigest: digest, spokes: [contract.SPOKE] }));
  const options = { chainId: 8453, namespace: "aave-v4-base-borrower-history/v1", reserveIds: [0, 1, 2, 3, 4, 5, 6, 7],
    deploymentBindings: [{ spoke: contract.SPOKE, implementation: contract.IMPLEMENTATION, implementationCodeKeccak256: contract.IMPL_HASH }],
    startProof: { kind: "GENESIS", fromBlock: 0, evidenceDigest: "b".repeat(64) } };
  const base = history.historyIdentity([contract.SPOKE], digest, options);
  assert.notEqual(history.indexFile("fixture", eth), history.indexFile("fixture", base));
  for (const other of [history.historyIdentity([contract.SPOKE], "c".repeat(64), options),
    history.historyIdentity([contract.SPOKE], digest, { ...options, startProof: { kind: "SNAPSHOT", fromBlock: 2, evidenceDigest: "d".repeat(64) } }),
    history.historyIdentity([contract.SPOKE], digest, { ...options, deploymentBindings: [{ ...options.deploymentBindings[0], implementation: A(999) }] })]) {
    assert.throws(() => history.validateHistory(history.emptyHistory(base), other), { code: "HISTORY_INDEX_INVALID" });
  }
});
test("snapshot starts stay bounded partial; incomplete proxy-publication/creation records do not invent a creation bound", async () => {
  const f = makeFixture({ users: [], aggregateDebtRaw: "0" });
  const out = await observer.collectBaseBorrowers(f.topology, { ...f.deps, startProof: { kind: "SNAPSHOT", fromBlock: 5, blockHash: H(5) } });
  assert.deepEqual(f.state.ranges, [[5, 9]]); assert.equal(out.history.rangeComplete, true);
  assert.equal(out.fullHistoryProven, false); assert.equal(out.componentObservationComplete, false);
  const g = makeFixture();
  const invalid = await observer.collectBaseBorrowers(g.topology, { ...g.deps, startProof: { kind: "CREATION", fromBlock: 5, sourceBound: true } });
  assert.ok(invalid.errors.includes("CREATION_PROOF_UNQUALIFIED")); assert.equal(g.state.ranges.length, 0); assert.equal(g.state.saves, 0);
});
test("removed/malformed/duplicate logs fail whole-chunk membership before persistence", async () => {
  for (const mutate of [logs => { logs[0].removed = true; }, logs => { logs[0].data = "0x00"; }, logs => { logs.push({ ...logs[0] }); },
    logs => { logs[0].topics[1] = H(8); }]) {
    const f = makeFixture(); const logs = structuredClone(f.logs); mutate(logs); f.state.logs = logs;
    const out = await observer.collectBaseBorrowers(f.topology, f.deps);
    assert.equal(out.componentObservationComplete, false); assert.equal(out.history.throughBlock, -1);
    assert.equal(out.users.length, 0); assert.equal(f.state.saves, 0);
  }
});
test("chunk gaps and caps remain incomplete; range splitting preserves complete contiguous membership", async () => {
  const gap = makeFixture(); gap.state.logFailureAt = 3;
  const a = await observer.collectBaseBorrowers(gap.topology, { ...gap.deps, historyOptions: { chunkSize: 3 } });
  assert.equal(a.history.throughBlock, 2); assert.equal(a.fullHistoryProven, false); assert.equal(gap.state.saves, 0);
  const capped = makeFixture();
  const b = await observer.collectBaseBorrowers(capped.topology, { ...capped.deps, historyOptions: { chunkSize: 3, maxChunks: 1 } });
  assert.equal(b.history.throughBlock, 2); assert.equal(b.fullHistoryProven, false); assert.equal(capped.state.saves, 1);
  const split = makeFixture(); split.state.maxRange = 3;
  const c = await observer.collectBaseBorrowers(split.topology, split.deps);
  assert.equal(c.fullHistoryProven, true); assert.ok(split.state.ranges.length > 4);
});
test("user limits, cached reorgs, read budget and terminal failures cannot claim complete or persist unconfirmed history", async () => {
  const limited = makeFixture({ users: [USER, A(43)] });
  const first = await observer.collectBaseBorrowers(limited.topology, { ...limited.deps, maxUsers: 1 });
  assert.equal(first.componentObservationComplete, false); assert.ok(first.errors.includes("USER_CAP_REACHED"));
  limited.state.badAnchor = true;
  const reorg = await observer.collectBaseBorrowers(limited.topology, limited.deps);
  assert.ok(reorg.errors.includes("HISTORY_INVALID")); assert.equal(limited.state.saves, 1);
  for (const configure of [s => { s.terminalFailure = true; }, s => { s.maxOperations = 35; }]) {
    const f = makeFixture(); configure(f.state);
    const out = await observer.collectBaseBorrowers(f.topology, f.deps);
    assert.equal(out.componentObservationComplete, false); assert.equal(f.state.saves, 0);
    if (f.state.terminalFailure) { assert.equal(out.observationPin, null); assert.equal(out.fullHistoryProven, false); assert.ok(out.errors.includes("TERMINAL_CONFIRMATION_FAILED")); }
  }
});
test("Base cache byte/log ceilings are checked without persisting oversized or incomplete chunks", async () => {
  const huge = makeFixture();
  huge.deps.historyStore.load = async identity => {
    const index = history.emptyHistory(identity);
    index.throughBlock = 9; index.throughBlockHash = H(9); index.committedChunks = 1; index.logs = 80000;
    index.users[contract.SPOKE] = Array.from({ length: 80000 }, (_, i) => ({ user: A(i + 1000), firstBorrowBlock: 1, lastBorrowBlock: 1, borrowEvents: 1 }));
    assert.ok(Buffer.byteLength(JSON.stringify(index)) > history.MAX_BYTES);
    return index;
  };
  const a = await observer.collectBaseBorrowers(huge.topology, huge.deps);
  assert.ok(a.errors.includes("HISTORY_INVALID")); assert.equal(huge.state.calls.length, 0); assert.equal(huge.state.saves, 0);
  const capped = makeFixture();
  const b = await observer.collectBaseBorrowers(capped.topology, { ...capped.deps, historyOptions: { maxLogs: 1 } });
  assert.equal(b.componentObservationComplete, false); assert.equal(capped.state.saves, 0);
});

test("source-correct asymmetric status tuples distinguish collateral-only from debt-only", async () => {
  const f = makeFixture();
  const out = await observer.collectBaseBorrowers(f.topology, f.deps);
  const collateral = out.users[0].reserves[0], debt = out.users[0].reserves[7];
  assert.equal(collateral.collateral, true); assert.equal(collateral.borrowing, false);
  assert.equal(collateral.totalDebtRaw, "0"); assert.equal(collateral.suppliedAssetsRaw, "1");
  assert.equal(debt.collateral, false); assert.equal(debt.borrowing, true);
  assert.equal(debt.totalDebtRaw, "10"); assert.equal(debt.suppliedAssetsRaw, "0");
  assert.equal(out.componentObservationComplete, true);
});

function roundedFixture(userCount, aggregateDebtRaw) {
  const users = Array.from({ length: userCount }, (_, i) => A(42 + i));
  const f = makeFixture({ users, aggregateDebtRaw });
  f.state.drawnIndexRay = 15n * 10n ** 26n;
  f.state.positionsByUser = Object.fromEntries(users.map(user => [user, { 7: [1, 0, 0, 0, 7] }]));
  f.state.userDebtByUser = Object.fromEntries(users.map(user => [user, { 7: 2 }]));
  f.state.aggregateComponents = { 7: [BigInt(userCount), 0n, 0n] };
  return f;
}

test("two one-share users at 1.5 RAY reconcile exactly although rounded debts sum to four, not three", async () => {
  const f = roundedFixture(2, "3");
  const out = await observer.collectBaseBorrowers(f.topology, f.deps), debt = out.debtReconciliation[7];
  assert.equal(out.fullHistoryProven, true); assert.equal(out.componentObservationComplete, true);
  assert.equal(out.debtAccounting, "PASS");
  assert.deepEqual(out.users.map(user => user.reserves[7].totalDebtRaw), ["2", "2"]);
  assert.equal(debt.indexedUserDebtRaw, "4"); assert.equal(debt.aggregateDebtRaw, "3");
  assert.equal(debt.roundingOverhangRaw, "1"); assert.equal(debt.underlyingDebtAdditive, false);
  assert.deepEqual(debt.aggregateComponents, { drawnShares: "2", premiumShares: "0", premiumOffsetRay: "0" });
  assert.deepEqual(debt.indexedUserComponents, debt.aggregateComponents);
  assert.equal(debt.equal, true); assert.equal(debt.userDebtReadsConsistent, true);
  assert.equal(out.observationPin.stateReadsPinned, 106);
  assert.equal(out.coverage.complete, false); assert.equal(out.classSemantics.exact, false); assert.equal(out.coveragePromotion, false);
});

test("rounding overhang cannot hide an omitted borrower even when rounded indexed sum equals aggregate", async () => {
  const f = roundedFixture(4, "6");
  // The injected history response omits the fourth debtor. Three rounded debts
  // total 6, exactly the rounded aggregate for FOUR shares at index 1.5 RAY.
  f.state.logs = f.logs.slice(0, 3);
  const out = await observer.collectBaseBorrowers(f.topology, f.deps), debt = out.debtReconciliation[7];
  assert.equal(out.fullHistoryProven, true, "contiguous indexed-history evidence is a separate axis");
  assert.equal(debt.indexedUserDebtRaw, "6"); assert.equal(debt.aggregateDebtRaw, "6");
  assert.equal(debt.indexedUserComponents.drawnShares, "3"); assert.equal(debt.aggregateComponents.drawnShares, "4");
  assert.equal(debt.componentsEqual, false); assert.equal(debt.equal, false);
  assert.equal(out.debtAccounting, "FAIL"); assert.equal(out.componentObservationComplete, false);
  assert.ok(out.errors.includes("BORROWER_DEBT_UNACCOUNTED"));
});

test("premium shares, signed offsets and inconsistent per-user debt reads cannot be hidden by rounded totals", async () => {
  for (const configure of [
    f => { f.state.aggregateComponents = { 7: [8, 2, 10n ** 27n - 3n] }; },
    f => { f.state.userDebtByUser = { [USER]: { 7: 9 } }; },
  ]) {
    const f = makeFixture(); configure(f);
    const out = await observer.collectBaseBorrowers(f.topology, f.deps);
    assert.equal(out.componentObservationComplete, false); assert.equal(out.debtAccounting, "FAIL");
    assert.ok(out.errors.includes("BORROWER_DEBT_UNACCOUNTED"));
  }
});

test("unavailable aggregate component/index views stay UNKNOWN and never become complete", async () => {
  for (const name of ["getSpokeDrawnShares", "getSpokePremiumData", "getAssetDrawnIndex"]) {
    const f = makeFixture(); f.state.failName = name;
    const out = await observer.collectBaseBorrowers(f.topology, f.deps);
    assert.equal(out.fullHistoryProven, true); assert.equal(out.debtAccounting, "UNKNOWN");
    assert.equal(out.componentObservationComplete, false); assert.equal(out.observationPin, null);
    assert.ok(out.errors.includes("OBSERVATION_READ_FAILED")); assert.equal(f.state.saves, 0);
    assert.doesNotMatch(JSON.stringify(out), /SYNTHETIC_SECRET/);
  }
});

test("well-shaped invented creation proof is unqualified before history or user reads", async () => {
  const f = makeFixture();
  const out = await observer.collectBaseBorrowers(f.topology, { ...f.deps, startProof: fabricatedCreationProof() });
  assert.deepEqual(out.errors, ["CREATION_PROOF_UNQUALIFIED"]);
  assert.equal(out.fullHistoryProven, false); assert.equal(out.componentObservationComplete, false);
  assert.equal(out.debtAccounting, "UNKNOWN"); assert.equal(f.state.ranges.length, 0); assert.equal(f.state.calls.length, 0);
  assert.equal(f.state.saves, 0); assert.equal(out.coverage.complete, false); assert.equal(out.liveAdmission, false);
});

test("new aggregate getters and component identities are checked against archived Hub/Spoke API and source", () => {
  const root = path.resolve(__dirname, "../..");
  const hub = require("../../reports/base-aave-v4-admission-20261018/public-sources/0xf912a34a97e78eb2b68c602701aaf06226e0d2f6.basescan.json");
  const iface = new Interface(hub.abi);
  for (const [name, inputs, outputs] of [["getSpokeDrawnShares", "uint256,address", "uint256"],
    ["getSpokePremiumData", "uint256,address", "uint256,int256"], ["getAssetDrawnIndex", "uint256", "uint256"]]) {
    const published = iface.getFunction(name), used = observer.ABI.getFunction(name);
    assert.equal(published.inputs.map(row => row.type).join(), inputs);
    assert.equal(published.outputs.map(row => row.type).join(), outputs);
    assert.equal(used.format(), published.format());
  }
  const page = fs.readFileSync(path.join(root, "reports/base-aave-v4-admission-20261018/public-sources/0xf912a34a97e78eb2b68c602701aaf06226e0d2f6.basescan.html"), "utf8");
  for (const code of ["return _spokes[assetId][spoke].drawnShares;", "return (spokeData.premiumShares, spokeData.premiumOffsetRay);",
    "spoke.drawnShares += drawnShares;", "spoke.drawnShares -= drawnShares;", "spoke.premiumOffsetRay"]) assert.ok(page.includes(code));
  const spoke = require("../../reports/base-aave-v4-admission-20261018/public-sources/0x81a73c282faa932de3b2541cee19549f4bf13b19.json");
  const source = spoke.sources["src/spoke/Spoke.sol"].content;
  assert.ok(source.includes("return (positionStatus.isUsingAsCollateral(reserveId), positionStatus.isBorrowing(reserveId));"));
  assert.ok(source.includes("return (drawnDebt + premiumDebtRay.fromRayUp());"));
  assert.ok(source.includes("userPosition.drawnShares += drawnShares.toUint120();"));
  assert.ok(source.includes("userPosition.drawnShares -= restoredShares.toUint120();"));
});
