"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { keccak256 } = require("ethers");

const { snapshotDirectory } = require("../atomic/ethereum-top-trades-7d-reconstruction/deep-reconstruct");
const { sanitizeBlock, sanitizeReceipt, sanitizeTransaction } = require("../atomic/ethereum-top-trades-7d-reconstruction/forensics");
const { SELECTORS } = require("../atomic/ethereum-top-trades-7d-reconstruction/morpho-funded-arbitrage-v4-claims-binder");
const { atomicBundle } = require("../atomic/ethereum-top-trades-7d-reconstruction/output");
const { argumentsOf, atomicWriteOptions, safeTerminalCode } = require("../atomic/ethereum-top-trades-7d-reconstruction/run");
const { AFTER_SWAP_SELECTOR, DYNAMIC_FEE_FLAG, ERC20_SELECTORS, HOOK, LIMITS, LOCKER, MAX_LP_FEE, POOL_MANAGER, TARGET_BLOCK_HASH, TARGET_HASH, TOKEN, assertMandatoryNonpromotion, assertSanitizedBundle, gate0VerifyFixture, gate0VerifyProduction } = require("../atomic/ethereum-top-trades-7d-reconstruction/v4-native-claim-gate0-verifier");

const ACTOR = "0xa19321f875f53c32169a0e4d081c3a42a44b08e9";
const FEE_RECIPIENT = "0x388c818ca8b9251b393131c08a736a67ccb19297";
const NATIVE = "0x0000000000000000000000000000000000000000";
const PARENT = `0x${"a".repeat(64)}`;
const INPUT = "0x12345678";
const SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const CLAIM_TOPIC = "0x1b3d7edb2e9c0b0e7c525b20aaaef0f5940d2ed71663c7d39266ecafac728859";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const POOL_CODE = "0x60016002556003600455";
const BALANCE_OF = "0x70a08231";

function full(value) { return `0x${value.repeat(64).slice(0, 64)}`; }
function quantity(value) { return `0x${BigInt(value).toString(16)}`; }
function word(value) { return ((BigInt(value) + (1n << 256n)) % (1n << 256n)).toString(16).padStart(64, "0"); }
function signedWord(value, bits) { const number = BigInt(value); const low = (number + (1n << BigInt(bits))) % (1n << BigInt(bits)); return (number < 0n ? (((1n << 256n) - (1n << BigInt(bits))) | low) : low).toString(16).padStart(64, "0"); }
function signed128(value) { return ((BigInt(value) + (1n << 128n)) % (1n << 128n)).toString(16).padStart(32, "0"); }
function packedDelta(amount0, amount1) { return `0x${signed128(amount0)}${signed128(amount1)}`; }
function addressWord(value) { return value.slice(2).padStart(64, "0"); }
function topicAddress(value) { return `0x${addressWord(value)}`; }
function call(selector, words = []) { return `${selector}${words.join("")}`; }
function unlockInput() { return call(SELECTORS.unlock, [word(32), word(0)]); }
function keyFee(options = {}) { return BigInt(options.keyFee ?? (options.dynamicFee ? DYNAMIC_FEE_FLAG : 3000n)); }
function eventFee(options = {}) { return BigInt(options.eventFee ?? (options.dynamicFee ? 500n : keyFee(options))); }
function poolId(options = {}) { return keccak256(`0x${addressWord(NATIVE)}${addressWord(TOKEN)}${word(keyFee(options))}${word(60)}${addressWord(HOOK)}`); }
function swapInput(options = {}) { return call(SELECTORS.swap, [addressWord(NATIVE), addressWord(TOKEN), word(keyFee(options)), word(60), addressWord(HOOK), word(options.zeroForOne ? 1 : 0), word(-200), word(1), word(288), word(0)]); }
function afterSwapInput(coreNative, options = {}) { return call(AFTER_SWAP_SELECTOR, [addressWord(LOCKER), addressWord(NATIVE), addressWord(TOKEN), word(keyFee(options)), word(60), addressWord(HOOK), word(options.zeroForOne ? 1 : 0), word(-200), word(1), packedDelta(coreNative, -200n).slice(2), word(352), word(0)]); }
function afterSwapOutput(delta) { return `0x${AFTER_SWAP_SELECTOR.slice(2).padEnd(64, "0")}${signedWord(delta, 128)}`; }
function frame(from, to, input, calls = [], options = {}) { return { type: options.type || "CALL", from, to, input, output: options.output ?? "0x", value: quantity(options.value ?? 0n), gas: "0x100000", gasUsed: "0x100", ...(options.reverted ? { error: "execution reverted" } : {}), ...(calls.length ? { calls } : {}) }; }

function fixtureNumbers(options = {}) {
  const mint = BigInt(options.mintAmount ?? 100n); const mintOwner = options.mintOwner || options.branch || "locker"; const lockerTake = BigInt(options.lockerTakeAmount ?? options.takeAmount ?? 0n); const hookTake = BigInt(options.hookTakeAmount ?? 0n);
  const lockerCredit = (mintOwner === "locker" ? mint : 0n) + lockerTake; const hookCredit = (mintOwner === "hook" ? mint : 0n) + hookTake;
  return { mint, mintOwner, lockerTake, hookTake, lockerCredit, hookCredit, coreNative: lockerCredit + hookCredit, hookReturn: hookCredit, finalNative: lockerCredit, debt: 200n };
}

function logs(options = {}) {
  const n = fixtureNumbers(options); const eventAmount = BigInt(options.eventMintAmount ?? n.mint); const caller = options.callerMismatch ? ACTOR : n.mintOwner === "hook" ? HOOK : LOCKER; const recipient = options.recipientMismatch ? LOCKER : HOOK;
  const common = { blockHash: TARGET_BLOCK_HASH, blockNumber: quantity(25783844), transactionHash: TARGET_HASH, transactionIndex: quantity(51), removed: false };
  return [
    { ...common, address: POOL_MANAGER, logIndex: quantity(53), topics: [SWAP_TOPIC, poolId(options), topicAddress(LOCKER)], data: `0x${signedWord(n.coreNative, 128)}${signedWord(-n.debt, 128)}${word(79228162514264337593543950336n)}${word(1000000)}${signedWord(0, 24)}${word(eventFee(options))}` },
    { ...common, address: POOL_MANAGER, logIndex: quantity(54), topics: [CLAIM_TOPIC, `0x${word(0)}`, topicAddress(recipient), `0x${word(0)}`], data: `0x${addressWord(caller)}${word(eventAmount)}` },
    { ...common, address: HOOK, logIndex: quantity(55), topics: [full("9"), `0x${word(0)}`], data: options.leakHookData ? `0x${Buffer.from("https://must-not-persist.invalid").toString("hex")}` : "0x1234" },
    { ...common, address: TOKEN, logIndex: quantity(56), topics: [TRANSFER_TOPIC, topicAddress(LOCKER), topicAddress(POOL_MANAGER)], data: `0x${word(options.eventTokenAmount ?? n.debt)}` },
  ];
}

function trace(options = {}) {
  const n = fixtureNumbers(options); const mintCaller = n.mintOwner === "hook" ? HOOK : LOCKER;
  const mint = frame(mintCaller, POOL_MANAGER, call(SELECTORS.mint, [addressWord(HOOK), word(0), word(n.mint)]), [], { reverted: options.revertedMint });
  const hookChildren = [];
  if (n.mintOwner === "hook" && !options.missingMint) hookChildren.push(mint);
  if (n.hookTake > 0n) hookChildren.push(frame(HOOK, POOL_MANAGER, call(SELECTORS.take, [addressWord(NATIVE), addressWord(ACTOR), word(n.hookTake)]), [frame(POOL_MANAGER, ACTOR, "0x", [], { value: options.wrongHookTakeTransferAmount ?? n.hookTake })]));
  if (options.wrongSettlementCaller && !options.missingSync) hookChildren.push(frame(HOOK, POOL_MANAGER, call(SELECTORS.sync, [addressWord(TOKEN)])));
  if (options.claimApproval) hookChildren.push(frame(HOOK, POOL_MANAGER, call(SELECTORS.approve, [addressWord(ACTOR), word(0), word(1)])));
  if (options.claimTransfer) hookChildren.push(frame(HOOK, POOL_MANAGER, call(SELECTORS.transfer, [addressWord(ACTOR), word(0), word(1)])));
  const afterSwap = frame(POOL_MANAGER, HOOK, afterSwapInput(n.coreNative, options), hookChildren, { output: options.missingHookReturn ? "0x" : afterSwapOutput(options.wrongHookDelta ?? n.hookReturn) });
  const swap = frame(LOCKER, POOL_MANAGER, swapInput(options), [afterSwap], { output: packedDelta(options.wrongFinalNative ?? n.finalNative, -n.debt) });
  const callbackCalls = [swap];
  if (n.mintOwner === "locker" && !options.missingMint) callbackCalls.push(mint);
  if (options.multipleMint) callbackCalls.push(frame(LOCKER, POOL_MANAGER, call(SELECTORS.mint, [addressWord(HOOK), word(0), word(0)])));
  if (options.multipleSwap) callbackCalls.push(frame(LOCKER, POOL_MANAGER, swapInput(options), [], { output: packedDelta(n.finalNative, -n.debt) }));
  if (n.lockerTake > 0n) callbackCalls.push(frame(LOCKER, POOL_MANAGER, call(SELECTORS.take, [addressWord(NATIVE), addressWord(ACTOR), word(n.lockerTake)]), [frame(POOL_MANAGER, ACTOR, "0x", [], { value: options.wrongLockerTakeTransferAmount ?? n.lockerTake })]));
  const balanceRead = () => frame(POOL_MANAGER, TOKEN, call(BALANCE_OF, [addressWord(POOL_MANAGER)]), [], { type: "STATICCALL", output: `0x${word(1000000)}` });
  const sync = frame(LOCKER, POOL_MANAGER, call(SELECTORS.sync, [addressWord(TOKEN)]), [balanceRead()]);
  const token = frame(LOCKER, TOKEN, call(ERC20_SELECTORS.transfer, [addressWord(POOL_MANAGER), word(options.tokenCallAmount ?? n.debt)]), [], { output: options.tokenReturn ?? `0x${word(1)}` });
  const settle = frame(LOCKER, POOL_MANAGER, call(SELECTORS.settle), [balanceRead()], { output: options.missingSettleReturn ? "0x" : `0x${word(options.settlePaid ?? n.debt)}` });
  const settlement = [];
  if (!options.missingSync && !options.wrongSettlementCaller) settlement.push(sync);
  if (!options.missingTransfer) settlement.push(token);
  if (!options.missingSettle) settlement.push(settle);
  if (options.reorderedSettlement) settlement.reverse();
  callbackCalls.push(...settlement);
  if (options.unknownManagerAction) callbackCalls.push(frame(LOCKER, POOL_MANAGER, "0xdeadbeef"));
  if (options.unmatchedNativeOutflow) callbackCalls.push(frame(LOCKER, ACTOR, "0x", [], { value: 1n }));
  const callback = frame(POOL_MANAGER, LOCKER, "0xfeedbeef", callbackCalls);
  const unlock = frame(LOCKER, POOL_MANAGER, unlockInput(), [callback], { reverted: options.revertedUnlock });
  return frame(ACTOR, LOCKER, INPUT, [unlock]);
}

function rawObjects(options = {}) {
  const receiptLogs = logs(options); const transaction = { hash: TARGET_HASH, blockHash: TARGET_BLOCK_HASH, blockNumber: quantity(25783844), transactionIndex: quantity(51), from: ACTOR, to: LOCKER, value: "0x0", type: "0x2", nonce: "0x1", gas: quantity(300000), maxFeePerGas: quantity(300000000), maxPriorityFeePerGas: quantity(1000000), chainId: "0x1", v: "0x1", r: full("2"), s: full("3"), accessList: [], input: INPUT };
  const receipt = { transactionHash: TARGET_HASH, blockHash: TARGET_BLOCK_HASH, blockNumber: quantity(25783844), transactionIndex: quantity(51), from: ACTOR, to: LOCKER, status: "0x1", gasUsed: quantity(183611), effectiveGasPrice: quantity(211502492), cumulativeGasUsed: quantity(1), logsBloom: `0x${"0".repeat(512)}`, type: "0x2", logs: receiptLogs };
  const hashes = Array.from({ length: 52 }, (_, index) => index === 51 ? TARGET_HASH : `0x${(index + 1).toString(16).padStart(64, "0")}`);
  const block = { hash: TARGET_BLOCK_HASH, parentHash: PARENT, number: quantity(25783844), timestamp: quantity(1787078615), miner: FEE_RECIPIENT, sha3Uncles: full("4"), stateRoot: full("5"), transactionsRoot: full("6"), receiptsRoot: full("7"), logsBloom: `0x${"0".repeat(512)}`, difficulty: "0x0", gasLimit: quantity(30000000), gasUsed: quantity(1000000), extraData: "0x", mixHash: full("8"), nonce: "0x0000000000000000", baseFeePerGas: quantity(210502492), transactions: hashes };
  return { transaction, receipt, block };
}

function sourceBundle(raw) {
  const transaction = sanitizeTransaction(raw.transaction); const receipt = sanitizeReceipt(raw.receipt); const block = sanitizeBlock(raw.block);
  return { "window.json": { chainId: "1", immutable: true, predecessorBoundary: { number: "25782843", hash: full("a"), timestamp: "1787000000" }, start: { number: "25782844", hash: full("b"), timestamp: "1787000012" }, finalized: { number: "25784843", hash: full("c"), timestamp: "1787099999" } }, "candidates.json": { rows: [{ transaction, receipt, block }] }, "reconciled.json": { rows: [] }, "fork-plan.json": { rows: [] }, "runtime.json": { mode: "fixture" } };
}
function makeSource(parent, options = {}) { const directory = path.join(parent, "synthetic-gate0-source"); const raw = rawObjects(options); atomicBundle(directory, sourceBundle(raw)); return { directory, raw, expectations: { basename: "synthetic-gate0-source", manifestSha256: snapshotDirectory(directory)["manifest.json"].sha256 } }; }
function inventory(shared = false) { return [0, 1].map((index) => ({ url: `http://localhost:${9800 + index}`, lineIndex: index, ethereumHint: true, unsupportedMode: false, declaredGroup: true, groupIdentity: shared ? "same" : Symbol(`gate0-family-${index}`) })); }
function sourceFacts(poolCode = POOL_CODE) { const bytes = Buffer.from(poolCode.slice(2), "hex"); const runtimeHash = crypto.createHash("sha256").update(bytes).digest("hex"); return { poolManagerRuntimeSha256: runtimeHash, poolManagerRuntimeLength: bytes.length, mintDebitsCallerTransientDelta: true, successfulUnlockRequiresAllTransientDeltasZero: true, provenance: { report: { bytes: 1, sha256: "1".repeat(64) }, checkout: { basename: "isolated-fixture", commit: "2".repeat(40), tree: "3".repeat(40) }, artifact: { bytes: 1, sha256: "4".repeat(64) }, compiler: { version: "fixture", optimizer: true }, runtime: { sha256: runtimeHash, length: bytes.length } } }; }
function prestate(options = {}, second = false) { const poolCode = options.runtimeMismatch ? "0x6000" : POOL_CODE; return { [POOL_MANAGER]: { code: poolCode }, [LOCKER]: { code: "0x6001" }, [HOOK]: { code: "0x6002" }, ...(options.missingTokenRuntime ? {} : { [TOKEN]: { code: second && options.prestateFamilyMismatch ? "0x6004" : "0x6003" } }) }; }
function serializer(transaction) { return { bytes: "0x02aabb", hash: TARGET_HASH, from: transaction.from }; }
function transport(made, options = {}) {
  return async ({ provider, method, params }) => {
    const second = provider.ordinal === "provider-02"; let result;
    if (method === "eth_chainId") result = "0x1";
    else if (method === "eth_getBlockByNumber") { const number = BigInt(params[0]).toString(); const boundary = [made.rawSource.predecessorBoundary, made.rawSource.start, made.rawSource.finalized].find((row) => row.number === number); result = { number: quantity(boundary.number), hash: boundary.hash, timestamp: quantity(boundary.timestamp) }; }
    else if (method === "eth_getTransactionByHash") result = structuredClone(made.raw.transaction);
    else if (method === "eth_getTransactionReceipt") { result = structuredClone(made.raw.receipt); if (second && options.rawLogFamilyMismatch) result.logs[0].data = result.logs[0].data.replace(signedWord(-200, 128), signedWord(-201, 128)); }
    else if (method === "eth_getBlockByHash") result = structuredClone(made.raw.block);
    else if (method === "debug_traceTransaction" && params[1].tracer === "callTracer") { result = trace(options); if (second && options.traceFamilyMismatch) result.calls[0].calls[0].calls[0].output = packedDelta(101n, -200n); if (options.oversized) return { result, bytes: LIMITS.responseBytes + 1 }; }
    else if (method === "debug_traceTransaction" && params[1].tracer === "prestateTracer") result = prestate(options, second);
    else throw new Error("unexpected-method");
    return { result, bytes: Buffer.byteLength(JSON.stringify(result)) };
  };
}
function setup(t, sourceOptions = {}, traceOptions = sourceOptions) { const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gate0-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true })); const made = makeSource(parent, sourceOptions); made.rawSource = sourceBundle(made.raw)["window.json"]; const fixture = { sourceExpectations: made.expectations, sourceFacts: sourceFacts() }; const options = { sourceDirectory: made.directory, hash: TARGET_HASH, inventoryEntries: inventory(), transport: transport(made, traceOptions), type2Serializer: serializer }; return { parent, made, options, fixture }; }
function verify(made) { return gate0VerifyFixture(made.options, made.fixture); }

test("Gate0 CLI uses an isolated production wrapper that rejects every fixture or transport injection", async () => {
  assert.equal(argumentsOf(["--v4-native-claim-gate0-verifier", "--source-dir", "source", "--hash", TARGET_HASH]).mode, "v4-native-claim-gate0"); assert.throws(() => argumentsOf(["--v4-native-claim-gate0-verifier", "--source-dir", "source"]), /requires-source-and-hash/); assert.equal(safeTerminalCode(new Error("gate0-source-anchor-mismatch")), "gate0-source-anchor-mismatch");
  const moduleExports = require("../atomic/ethereum-top-trades-7d-reconstruction/v4-native-claim-gate0-verifier"); assert.equal(moduleExports.TEST_HOOK_TOKEN, undefined); assert.equal(moduleExports.createGate0OfflineTestHooks, undefined); assert.equal(moduleExports.gate0Verify, undefined);
  for (const injected of [{ testHooks: {} }, { sourceFacts: {} }, { inventoryEntries: [] }, { transport: async () => null }, { type2Serializer: () => null }, { limits: {} }]) await assert.rejects(() => gate0VerifyProduction({ sourceDirectory: "unused", hash: TARGET_HASH, ...injected }), /gate0-production-options-invalid/);
  const runSource = fs.readFileSync(path.join(__dirname, "../atomic/ethereum-top-trades-7d-reconstruction/run.js"), "utf8"); assert.match(runSource, /const \{ gate0VerifyProduction \} = require\("\.\/v4-native-claim-gate0-verifier"\)/); assert.match(runSource, /await gate0VerifyProduction\(\{ sourceDirectory: options\.sourceDirectory, hash: options\.hash \}\)/);
});

test("locker-caller ordinary mint has exact swap/hook, settlement, provenance, and nonpromotion", async (t) => {
  const made = setup(t, { leakHookData: true }); const result = await verify(made); const verdict = result.bundle["gate0-verdict.json"];
  assert.equal(verdict.terminalStage, "GATE0_ORDINARY_SETTLEMENT_EXACT"); assert.equal(verdict.ordinarySettlementExact, true); assert.equal(verdict.mintBranch, "locker-caller"); assert.equal(verdict.mintCaller, LOCKER); assert.equal(verdict.mintRecipient, HOOK); assert.equal(verdict.swapHookReconciliationExact, true); assert.equal(verdict.finalTokenDebtRaw, "200"); assert.equal(verdict.tokenPaymentExact, true); assert.equal(verdict.fixedRuntimeTargetsComplete, true); assert.equal(verdict.mintDebitsCallerTransientDelta, true); assertMandatoryNonpromotion(verdict);
  const provenance = result.bundle["source-anchor.json"].poolManagerSourceProvenance; assert.equal(provenance.runtime.sha256, sourceFacts().poolManagerRuntimeSha256); assert.equal(result.bundle["runtime-fingerprints.json"].everySuccessfulCodeContextDerived, false); assert.equal(result.bundle["runtime-fingerprints.json"].rows.find((row) => row.address === HOOK).sourceExact, false); assert.equal(JSON.stringify(result.bundle).includes("https://"), false);
  const output = path.join(made.parent, "gate0-positive"); atomicBundle(output, result.bundle, atomicWriteOptions("v4-native-claim-gate0", result)); assert.deepEqual(fs.readdirSync(output).sort(), ["canonical-evidence.json", "gate0-verdict.json", "manifest.json", "runtime-fingerprints.json", "source-anchor.json", "trace-projection.json"]);
});

test("hook-caller mint is backed by exact hook-return native delta", async (t) => { const made = setup(t, { branch: "hook" }); const verdict = (await verify(made)).bundle["gate0-verdict.json"]; assert.equal(verdict.ordinarySettlementExact, true); assert.equal(verdict.mintBranch, "hook-caller"); assert.deepEqual(verdict.hookDelta, { amount0: "100", amount1: "0" }); assert.equal(verdict.hookNativeDeltaWei, "100"); assert.equal(verdict.finalLockerNativeCreditWei, "0"); assert.equal(verdict.ownerNativeAccounting.exact, true); });

test("partial hook fee mint and independent locker take reconcile both native owners", async (t) => {
  const mixed = setup(t, { mintOwner: "hook", mintAmount: 10n, lockerTakeAmount: 90n }); const verdict = (await verify(mixed)).bundle["gate0-verdict.json"];
  assert.equal(verdict.ordinarySettlementExact, true); assert.equal(verdict.finalLockerNativeCreditWei, "90"); assert.equal(verdict.hookNativeDeltaWei, "10"); assert.deepEqual(verdict.ownerNativeAccounting, { exact: true, lockerMintAmount: "0", lockerNativeTakes: "90", hookMintAmount: "10", hookNativeTakes: "0" }); assert.equal(verdict.expectedNativeTakes[0].owner, LOCKER);
  for (const mismatch of [{ wrongFinalNative: 89n }, { wrongHookDelta: 11n }, { wrongLockerTakeTransferAmount: 89n }]) { const made = setup(t, { mintOwner: "hook", mintAmount: 10n, lockerTakeAmount: 90n }, { mintOwner: "hook", mintAmount: 10n, lockerTakeAmount: 90n, ...mismatch }); const bad = (await verify(made)).bundle["gate0-verdict.json"]; assert.equal(bad.ordinarySettlementExact, false); assert.equal(bad.ownerNativeAccounting.exact, false); }
});

test("native takes by both locker and hook are matched to their own credits", async (t) => {
  const made = setup(t, { mintOwner: "hook", mintAmount: 5n, hookTakeAmount: 5n, lockerTakeAmount: 90n }); const verdict = (await verify(made)).bundle["gate0-verdict.json"];
  assert.equal(verdict.ordinarySettlementExact, true); assert.equal(verdict.ownerNativeAccounting.hookMintAmount, "5"); assert.equal(verdict.ownerNativeAccounting.hookNativeTakes, "5"); assert.equal(verdict.ownerNativeAccounting.lockerNativeTakes, "90"); assert.deepEqual(new Set(verdict.expectedNativeTakes.map((row) => row.owner)), new Set([LOCKER, HOOK]));
});

test("static and dynamic PoolKey fees validate with source-correct event rules", async (t) => {
  const staticValid = setup(t, { keyFee: 3000n, eventFee: 3000n }); const staticVerdict = (await verify(staticValid)).bundle["gate0-verdict.json"]; assert.equal(staticVerdict.ordinarySettlementExact, true); assert.equal(staticVerdict.feeMode, "static"); assert.equal(staticVerdict.feeValidationExact, true);
  const dynamicValid = setup(t, { dynamicFee: true, eventFee: 777n }); const dynamicVerdict = (await verify(dynamicValid)).bundle["gate0-verdict.json"]; assert.equal(dynamicVerdict.ordinarySettlementExact, true); assert.equal(dynamicVerdict.feeMode, "dynamic"); assert.equal(dynamicVerdict.feeValidationExact, true);
  for (const fixture of [{ keyFee: 3000n, eventFee: 2999n }, { keyFee: DYNAMIC_FEE_FLAG + 1n, eventFee: 777n }, { dynamicFee: true, eventFee: MAX_LP_FEE + 1n }]) { const made = setup(t, fixture); const bad = (await verify(made)).bundle["gate0-verdict.json"]; assert.equal(bad.ordinarySettlementExact, false); assert.equal(bad.concreteMismatches.feeValidationMismatch, true); }
});

test("an unmodeled hook token delta is an explicit concrete HOLD", async (t) => { const made = setup(t, { zeroForOne: true }, { zeroForOne: true, wrongHookDelta: 10n }); const verdict = (await verify(made)).bundle["gate0-verdict.json"]; assert.equal(verdict.ordinarySettlementExact, false); assert.equal(verdict.hookTokenSettlementModeled, false); assert.equal(verdict.concreteMismatches.hookTokenDeltaUnmodeled, true); });

test("zero mint requires one successful exact mint frame", async (t) => {
  const exact = setup(t, { mintAmount: 0n }); const exactVerdict = (await verify(exact)).bundle["gate0-verdict.json"]; assert.equal(exactVerdict.ordinarySettlementExact, true); assert.equal(exactVerdict.mintAmountRaw, "0");
  const missing = setup(t, { mintAmount: 0n }, { mintAmount: 0n, missingMint: true }); const missingVerdict = (await verify(missing)).bundle["gate0-verdict.json"]; assert.equal(missingVerdict.ordinarySettlementExact, false); assert.equal(missingVerdict.concreteMismatches.mintMissingMultipleRevertedOrEventMismatch, true);
});

test("event amount/caller/recipient, mint status, and unlock status mismatches HOLD", async (t) => { for (const fixture of [{ eventMintAmount: 101n }, { callerMismatch: true }, { recipientMismatch: true }, { revertedMint: true }, { revertedUnlock: true }]) { const made = setup(t, fixture); const verdict = (await verify(made)).bundle["gate0-verdict.json"]; assert.equal(verdict.terminalStage, "HOLD_CONCRETE_MISMATCH"); assert.equal(verdict.ordinarySettlementExact, false); } });

test("sync/transfer/settle missing, reordered, wrong-caller, wrong-amount, wrong-return, and wrong-paid HOLD", async (t) => { for (const fixture of [{ missingSync: true }, { missingTransfer: true }, { missingSettle: true }, { reorderedSettlement: true }, { wrongSettlementCaller: true }, { tokenCallAmount: 199n }, { tokenReturn: `0x${word(0)}` }, { settlePaid: 199n }, { missingSettleReturn: true }]) { const made = setup(t, {}, fixture); const verdict = (await verify(made)).bundle["gate0-verdict.json"]; assert.equal(verdict.ordinarySettlementExact, false); assert.equal(verdict.tokenPaymentExact, false); } });

test("swap/hook delta and final caller return reconciliation mismatches HOLD", async (t) => { for (const fixture of [{ wrongHookDelta: 1n }, { wrongFinalNative: 99n }, { missingHookReturn: true }]) { const made = setup(t, {}, fixture); const verdict = (await verify(made)).bundle["gate0-verdict.json"]; assert.equal(verdict.ordinarySettlementExact, false); assert.notEqual(verdict.terminalStage, "GATE0_ORDINARY_SETTLEMENT_EXACT"); } });

test("claim approval and transfer mutations HOLD", async (t) => { for (const fixture of [{ claimApproval: true }, { claimTransfer: true }]) { const made = setup(t, fixture); const verdict = (await verify(made)).bundle["gate0-verdict.json"]; assert.equal(verdict.ordinarySettlementExact, false); assert.equal(verdict.claimAuthorizationMutationExactZero && verdict.claimTransferMutationExactZero, false); } });

test("expected native take is reconciled and only unmatched outflow is unexplained", async (t) => {
  const expected = setup(t, { takeAmount: 20n }); const verdict = (await verify(expected)).bundle["gate0-verdict.json"]; assert.equal(verdict.ordinarySettlementExact, true); assert.equal(verdict.expectedNativeTakes.length, 1); assert.equal(verdict.expectedNativeTakes[0].matched, true); assert.deepEqual(verdict.unmatchedNativeTransfers, []);
  const unmatched = setup(t, {}, { unmatchedNativeOutflow: true }); const bad = (await verify(unmatched)).bundle["gate0-verdict.json"]; assert.equal(bad.ordinarySettlementExact, false); assert.equal(bad.unmatchedNativeTransfers.length, 1); assert.equal(bad.concreteMismatches.nativeTakeOrTransferMismatch, true);
});

test("unknown and multiple manager actions never classify ordinary", async (t) => { for (const fixture of [{ unknownManagerAction: true }, { multipleMint: true }, { multipleSwap: true }]) { const made = setup(t, {}, fixture); const verdict = (await verify(made)).bundle["gate0-verdict.json"]; assert.equal(verdict.ordinarySettlementExact, false); assert.notEqual(verdict.terminalStage, "GATE0_ORDINARY_SETTLEMENT_EXACT"); } });

test("raw-log, normalized trace, prestate, and declared-family mismatches fail before output", async (t) => {
  const shared = setup(t); await assert.rejects(() => gate0VerifyFixture({ ...shared.options, inventoryEntries: inventory(true) }, shared.fixture), /two-independent-canonical-providers-unavailable/);
  const logsMismatch = setup(t, {}, { rawLogFamilyMismatch: true }); await assert.rejects(() => verify(logsMismatch), /two-independent-canonical-providers-unavailable/);
  const traceMismatch = setup(t, {}, { traceFamilyMismatch: true }); await assert.rejects(() => verify(traceMismatch), /two-family-trace-or-runtime-mismatch/);
  const prestateMismatch = setup(t, {}, { prestateFamilyMismatch: true }); await assert.rejects(() => verify(prestateMismatch), /two-family-trace-or-runtime-mismatch/);
});

test("runtime incompleteness is named fixed-target completeness and mismatch is concrete", async (t) => {
  const incomplete = setup(t, {}, { missingTokenRuntime: true }); const incompleteVerdict = (await verify(incomplete)).bundle["gate0-verdict.json"]; assert.equal(incompleteVerdict.fixedRuntimeTargetsComplete, false); assert.equal(incompleteVerdict.terminalStage, "HOLD_INCOMPLETE_EXACT_EVIDENCE");
  const mismatch = setup(t, {}, { runtimeMismatch: true }); const mismatchVerdict = (await verify(mismatch)).bundle["gate0-verdict.json"]; assert.equal(mismatchVerdict.concreteMismatches.poolManagerRuntimeMismatch, true);
});

test("mandatory nonpromotion independently rejects every forbidden claim", async (t) => {
  const made = setup(t); const verdict = (await verify(made)).bundle["gate0-verdict.json"];
  for (const mutation of [{ globalSolvencyAsserted: true }, { currentBehaviorAsserted: true }, { publicReachabilityAsserted: true }, { controlledClusterExact: true }, { fullPerAddressAssetVectorExact: true }, { scalarHistoricalNetExact: true }, { liquidExtractionAsserted: true }, { routePositive: true }, { currentExecutable: true }, { promotable: true }]) assert.throws(() => assertMandatoryNonpromotion({ ...verdict, ...mutation }), /nonpromotion-invariant/);
});

test("source mutation, leak scan, and atomic cleanup fail closed", async (t) => {
  const made = setup(t); const result = await verify(made); fs.appendFileSync(path.join(made.made.directory, "candidates.json"), " "); const output = path.join(made.parent, "gate0-output"); assert.throws(() => atomicBundle(output, result.bundle, atomicWriteOptions("v4-native-claim-gate0", result)), /source-bytes-changed/); assert.equal(fs.existsSync(output), false);
  assert.throws(() => assertSanitizedBundle({ bad: "https://forbidden.invalid" }), /output-leak/); const rejected = path.join(made.parent, "cleanup"); assert.throws(() => atomicBundle(rejected, { "gate0-verdict.json": { claimAuthorizationMutationExactZero: true } }, { beforeRename: () => { throw new Error("stop"); } }), /stop/); assert.equal(fs.existsSync(rejected), false);
});

test("oversized responses and all invalid Gate0 limits fail closed", async (t) => {
  const oversized = setup(t, {}, { oversized: true }); await assert.rejects(() => verify(oversized), /response-budget-exceeded/);
  const { validateLimits } = require("../atomic/ethereum-top-trades-7d-reconstruction/v4-native-claim-gate0-verifier"); assert.deepEqual(validateLimits({}), LIMITS); assert.throws(() => validateLimits({ unknown: 1 }), /invalid-limits/); for (const field of Object.keys(LIMITS)) for (const value of [NaN, Infinity, 1.5, -1]) assert.throws(() => validateLimits({ [field]: value }), /invalid-limits/);
});
