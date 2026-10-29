#!/usr/bin/env node
"use strict";
// Source-informed, provisional observer; no resolver, file reads, execution or writes.
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const FACTORIES = Object.freeze([
  { kind: "DLMM_V1", address: "0x17Da44dcbdffD8c715be7A368E19F252C2940Fee" },
  { kind: "DLMM_V2", address: "0x9DBB9289d0D75508b5D8EE01FfE4eb7c412F733b" },
  { kind: "DAMM", address: "0xD14322b444415d78DBBF646BB369Ec325a1aCD5c" },
].map(Object.freeze));
const CONFIG_NAMESPACE = "0x39b93213a9c080bcc1f9880cff6026ae325329c9c25f4796845632a83f013600";
const SWAP = new ethers.Interface(["function swap(bool,address) returns(uint256)", "function swap(bool,address,uint256) returns(uint256)",
  "function swap(bool swapForY,address to,uint256 amountIn,uint256 amountOutMin) returns(uint256)"]);
const FACTORY_ABI = new ethers.Interface(["function allPairsLength() view returns(uint256)",
  "function allPairs(uint256) view returns(address)", "function getAllPairsPaginated(uint256,uint256) view returns(address[],uint256)",
  "function isPairRegistered(address) view returns(bool)", "function beacon() view returns(address)"]);
class UmbraeFailure extends Error { constructor(code) { super(code); this.code = code; } }
const FAILURE_CODES = new Set(["SWAP_INPUT_INVALID", "SWAP_SELECTOR_UNKNOWN", "SWAP_CALLDATA_INVALID", "EXTENSION_WORD_INVALID",
  "PAIR_IDENTITY_UNQUALIFIED", "PAIR_RUNTIME_OR_REGISTRATION_UNQUALIFIED", "BEACON_BINDING_MISMATCH", "IMMUTABLE_BEACON_PROOF_MISSING",
  "IMMUTABLE_REFERENCE_INVALID", "IMMUTABLE_BEACON_MISMATCH", "EXTENSION_BINDING_MISMATCH", "COUNTERVENUE_UNQUALIFIED",
  "EXACT_VIEWER_OR_VALIDATED_MODEL_MISSING", "ENUMERATION_CAP_INVALID", "FACTORY_SNAPSHOT_OR_PAGE_INVALID", "FACTORY_DUPLICATE_PAIR",
  "FACTORY_PAIR_CAP", "FACTORY_PAGE_STALL_OR_PARTIAL_END", "READ_CAP", "PIN_DRIFT", "PIN_INVALID", "PAIR_NOT_ENUMERATED",
  "AMOUNT_GRID_INVALID", "QUOTE_FAILED_OR_BINDING_MISMATCH"]);
const knownFailure = error => error instanceof UmbraeFailure && FAILURE_CODES.has(error.code);
const failure = (error, fallback) => knownFailure(error) ? error.code : fallback;
const need = (condition, code) => { if (!condition) throw new UmbraeFailure(code); };
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const address = value => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) && !same(value, ethers.ZeroAddress);
const hash = value => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const uint = value => typeof value === "bigint" && value >= 0n && value < (1n << 256n);
function runtimeMatches(runtime, commitment) {
  return typeof runtime === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(runtime) && runtime.length <= 131074
    && hash(commitment) && same(ethers.keccak256(runtime), commitment);
}
function encodeSwap({ swapForY, to, amountInRaw, minimumOutRaw }) {
  need(typeof swapForY === "boolean" && address(to) && uint(amountInRaw) && amountInRaw > 0n && uint(minimumOutRaw), "SWAP_INPUT_INVALID");
  return { data: SWAP.encodeFunctionData("swap(bool,address,uint256,uint256)", [swapForY, to, amountInRaw, minimumOutRaw]),
    direction: swapForY ? "X_TO_Y" : "Y_TO_X", units: "NATIVE_TOKEN_RAW", requiresOwnPretransferredInput: true,
    callbackAvailable: false, executionPermitted: false, sourceRuntimeBindingQualified: false };
}
function inspectSwap(calldata) {
  try {
    const decoded = SWAP.parseTransaction({ data: calldata });
    need(decoded, "SWAP_SELECTOR_UNKNOWN");
    return { selector: decoded.selector, signature: decoded.signature,
      sourceBehavior: decoded.args.length < 4 ? "UNCONDITIONAL_LEGACY_REVERT" : "EXPLICIT_INPUT_AND_OUTPUT_FLOOR_REQUIRES_OWN_PRETRANSFER",
      executionPermitted: false };
  } catch (_) { throw new UmbraeFailure("SWAP_CALLDATA_INVALID"); }
}
function inspectExtensionWord(word) {
  need(typeof word === "string" && /^0x[0-9a-f]{64}$/i.test(word), "EXTENSION_WORD_INVALID");
  return { namespace: CONFIG_NAMESPACE, candidateOffset: 5,
    candidateSlot: ethers.toBeHex(BigInt(CONFIG_NAMESPACE) + 5n, 32),
    candidateExtension: `0x${word.slice(-40)}`, layoutQualified: false,
    blocker: "PACKING_IMPLIES_NAMESPACE_PLUS_5_NOT_COMMENT_PLUS_6_COMPILER_LAYOUT_PROOF_REQUIRED" };
}
function validatePairBinding(binding, pin) {
  need(binding && binding.chainId === 8453 && same(binding.blockHash, pin.hash) && address(binding.pair)
    && FACTORIES.some(factory => same(factory.address, binding.factory)), "PAIR_IDENTITY_UNQUALIFIED");
  need(binding.registered === true && address(binding.tokenX) && address(binding.tokenY) && !same(binding.tokenX, binding.tokenY)
    && runtimeMatches(binding.pairRuntime, binding.pairRuntimeKeccak256)
    && runtimeMatches(binding.factoryRuntime, binding.factoryRuntimeKeccak256), "PAIR_RUNTIME_OR_REGISTRATION_UNQUALIFIED");
  const beacon = binding.beacon;
  need(beacon && address(beacon.immutableAddress) && same(beacon.immutableAddress, beacon.slotAddress)
    && same(beacon.immutableAddress, beacon.factoryAddress) && address(beacon.implementation)
    && runtimeMatches(beacon.runtime, beacon.runtimeKeccak256)
    && runtimeMatches(beacon.implementationRuntime, beacon.implementationRuntimeKeccak256), "BEACON_BINDING_MISMATCH");
  // A slot read alone cannot qualify an immutable. Check every explicitly supplied
  // immutable reference against the actual proxy bytes, without pretending this
  // supplied reference map is compiler-backed source proof.
  need(Array.isArray(beacon.immutableReferences) && beacon.immutableReferences.length > 0 && beacon.immutableReferences.length <= 16, "IMMUTABLE_BEACON_PROOF_MISSING");
  const offsets = new Set();
  for (const reference of beacon.immutableReferences) {
    need(Number.isSafeInteger(reference.start) && reference.start >= 0 && reference.length === 32 && !offsets.has(reference.start)
      && 2 + (reference.start + 32) * 2 <= binding.pairRuntime.length, "IMMUTABLE_REFERENCE_INVALID");
    offsets.add(reference.start);
    need(same(`0x${binding.pairRuntime.slice(2 + reference.start * 2, 2 + (reference.start + 32) * 2)}`,
      ethers.zeroPadValue(beacon.immutableAddress, 32)), "IMMUTABLE_BEACON_MISMATCH");
  }
  const extension = inspectExtensionWord(binding.extensionWord);
  need(address(binding.extension) && same(extension.candidateExtension, binding.extension)
    && runtimeMatches(binding.extensionRuntime, binding.extensionRuntimeKeccak256), "EXTENSION_BINDING_MISMATCH");
  return { pair: binding.pair, factory: binding.factory, tokenX: binding.tokenX, tokenY: binding.tokenY,
    beacon: beacon.immutableAddress, implementation: beacon.implementation, extension,
    immutableValuesMatchSuppliedReferences: true, immutableReferenceMapCompilerQualified: false,
    sourceRuntimeSemanticsQualified: false };
}
function validateCounter(binding, pair, pin) {
  need(binding && binding.chainId === 8453 && same(binding.blockHash, pin.hash) && address(binding.pool) && address(binding.factory)
    && !same(binding.pool, pair.pair) && same(binding.factory, binding.observedFactory)
    && same(binding.pool, binding.factoryPool) && Number.isInteger(binding.fee) && binding.fee > 0 && binding.fee < 1_000_000
    && binding.fee === binding.observedFee && same(binding.token0, binding.observedToken0) && same(binding.token1, binding.observedToken1)
    && [pair.tokenX, pair.tokenY].every(token => same(token, binding.token0) || same(token, binding.token1))
    && !same(binding.token0, binding.token1) && runtimeMatches(binding.runtime, binding.runtimeKeccak256), "COUNTERVENUE_UNQUALIFIED");
}
function validateViewer(binding, pin) {
  need(binding && binding.kind === "SOURCE_BOUND_VIEWER" && binding.chainId === 8453 && same(binding.blockHash, pin.hash)
    && address(binding.address) && runtimeMatches(binding.runtime, binding.runtimeKeccak256)
    && typeof binding.source === "string" && binding.source.length > 0 && binding.source.length <= 2_000_000
    && /^[0-9a-f]{64}$/i.test(binding.sourceSha256 || "")
    && crypto.createHash("sha256").update(binding.source).digest("hex") === binding.sourceSha256.toLowerCase(), "EXACT_VIEWER_OR_VALIDATED_MODEL_MISSING");
  // Commitment consistency is useful but never independent source/compiler admission.
}
async function enumerateFactories({ readPage, pin, pageSize = 50, maxPagesPerFactory = 8, maxPairsPerFactory = 200 } = {}) {
  const result = { factories: [], reads: { attempted: 0, succeeded: 0, failed: 0, unclassifiedFailures: 0, truncated: false }, complete: false };
  if (typeof readPage !== "function") return result;
  need(Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 200 && Number.isSafeInteger(maxPagesPerFactory)
    && maxPagesPerFactory > 0 && maxPagesPerFactory <= 32 && Number.isSafeInteger(maxPairsPerFactory) && maxPairsPerFactory > 0 && maxPairsPerFactory <= 1000, "ENUMERATION_CAP_INVALID");
  for (const factory of FACTORIES) {
    const record = { ...factory, pairs: [], readsComplete: false, sourceQualified: false, failures: [] }; result.factories.push(record);
    let total = null;
    for (let page = 0; page < maxPagesPerFactory; page++) {
      result.reads.attempted++;
      try {
        const value = await readPage({ factory: factory.address, kind: factory.kind, offset: record.pairs.length, limit: pageSize, chainId: 8453, pin });
        need(value && value.chainId === 8453 && same(value.blockHash, pin.hash) && same(value.factory, factory.address)
          && value.offset === record.pairs.length && Number.isSafeInteger(value.total) && value.total >= 0
          && (total === null || total === value.total) && Array.isArray(value.pairs) && value.pairs.length <= pageSize
          && value.pairs.every(address) && typeof value.end === "boolean", "FACTORY_SNAPSHOT_OR_PAGE_INVALID");
        total = value.total;
        need(new Set([...record.pairs, ...value.pairs].map(pair => pair.toLowerCase())).size === record.pairs.length + value.pairs.length,
          "FACTORY_DUPLICATE_PAIR");
        need(record.pairs.length + value.pairs.length <= maxPairsPerFactory, "FACTORY_PAIR_CAP");
        need(record.pairs.length + value.pairs.length <= total && (value.end
          ? record.pairs.length + value.pairs.length === total : value.pairs.length > 0 && record.pairs.length + value.pairs.length < total), "FACTORY_PAGE_STALL_OR_PARTIAL_END");
        record.pairs.push(...value.pairs); result.reads.succeeded++;
        if (value.end) { record.readsComplete = true; break; }
      } catch (error) {
        result.reads.failed++; if (!knownFailure(error)) result.reads.unclassifiedFailures++;
        const code = failure(error, "FACTORY_READ_FAILED");
        record.failures.push(code); if (["FACTORY_PAIR_CAP", "READ_CAP"].includes(code)) result.reads.truncated = true; break;
      }
    }
    if (!record.readsComplete && !record.failures.length) { result.reads.truncated = true; record.failures.push("FACTORY_PAGE_CAP"); }
  }
  result.allThreeFactoryReadsComplete = result.factories.length === 3 && result.factories.every(factory => factory.readsComplete);
  result.blockers = ["DAMM_ENUMERATION_SOURCE_API_UNQUALIFIED", "PARENT_ADMISSION_REQUIRED_FOR_FACTORY_SOURCE_RUNTIME_BINDINGS"];
  return result;
}
function offline() {
  return { schema: "umbrae-x-observation/v1", chainId: 8453, provisional: true, offline: true, observedAt: null,
    enumeration: null, rows: [], reads: { attempted: 0, succeeded: 0, failed: 0, unclassifiedFailures: 0, truncated: false, transportCalls: 0 },
    readAccounting: "attempted counts validated observation operations (including blocked factory attempts); transportCalls counts actual transport/quote invocations, capped globally",
    classSemantics: { triggerClass: "X", exact: false }, coverage: { complete: false },
    onFire: { economics: false, keylessFixedPinFork: false, alert: false }, dispatchEnabled: false,
    routePositive: "unknown", executableNow: "unknown", blockers: ["NO_ADMITTED_EXACT_VIEWER_OR_BIN_FEE_VOLATILITY_BITMAP_MOVEMENT_MODEL"] };
}
async function observe(options = {}) {
  const result = offline();
  if (typeof options.transport !== "function") return result;
  const input = structuredClone(options.input || {}), nowMs = options.nowMs ?? Date.now(), cap = options.maxReads ?? 256;
  let pinQualified = false;
  const read = async (descriptor, validate) => {
    need(result.reads.transportCalls < cap, "READ_CAP"); result.reads.attempted++;
    try { result.reads.transportCalls++; const value = await options.transport({ ...descriptor, chainId: 8453, pin: structuredClone(input.pin) });
      const decoded = validate(value); result.reads.succeeded++; return decoded;
    } catch (error) { result.reads.failed++; if (!knownFailure(error)) result.reads.unclassifiedFailures++; throw error; }
  };
  const pinCheck = () => read({ kind: "CANONICAL_PIN" }, value => need(value && value.chainId === 8453
    && same(value.hash, input.pin.hash) && value.number === input.pin.number && value.timestamp === input.pin.timestamp && value.canonical === true, "PIN_DRIFT"));
  try {
    need(input.chainId === 8453 && input.pin && hash(input.pin.hash) && Number.isSafeInteger(input.pin.number) && input.pin.number >= 0
      && Number.isSafeInteger(input.pin.timestamp) && input.pin.timestamp > 0 && input.pin.finality === "finalized"
      && nowMs / 1000 - input.pin.timestamp <= 900 && input.pin.timestamp <= nowMs / 1000 + 60
      && Number.isSafeInteger(cap) && cap > 0 && cap <= 1024, "PIN_INVALID");
    await pinCheck(); pinQualified = true; result.offline = false;
    // Enumeration is a distinct operation; unknown DAMM ABI cannot be papered over
    // by a v2 subset. Every factory is attempted even if another one fails.
    result.enumeration = await enumerateFactories({ ...input.enumeration, pin: input.pin,
      readPage: async request => {
        need(result.reads.transportCalls < cap, "READ_CAP"); result.reads.transportCalls++;
        return options.transport({ ...request, kind: "FACTORY_PAGE", factoryKind: request.kind });
      } });
    for (const key of ["attempted", "succeeded", "failed", "unclassifiedFailures"]) result.reads[key] += result.enumeration.reads[key];
    result.reads.truncated ||= result.enumeration.reads.truncated;
    const pair = validatePairBinding(input.pairBinding, input.pin); result.pairBinding = pair;
    need(result.enumeration.factories.some(factory => same(factory.address, pair.factory)
      && factory.pairs.some(address => same(address, pair.pair))), "PAIR_NOT_ENUMERATED");
    validateCounter(input.counterBinding, pair, input.pin);
    validateViewer(input.viewerBinding, input.pin);
    need(typeof options.quote === "function", "EXACT_VIEWER_OR_VALIDATED_MODEL_MISSING");
    const grid = input.amountsByToken || {};
    for (const token of [pair.tokenX, pair.tokenY]) {
      const sizes = grid[token.toLowerCase()];
      need(Array.isArray(sizes) && sizes.length > 0 && sizes.length <= 4 && sizes.every(size => uint(size) && size > 0n)
        && new Set(sizes.map(String)).size === sizes.length, "AMOUNT_GRID_INVALID");
    }
    const quote = async (venue, tokenIn, tokenOut, amount, row) => {
      need(result.reads.transportCalls < cap, "READ_CAP"); result.reads.attempted++; row.quoteReads.attempted++;
      try {
        result.reads.transportCalls++;
        const value = await options.quote({ venue, pool: venue === "UMBRAE" ? pair.pair : input.counterBinding.pool,
          tokenIn, tokenOut, amountInRaw: amount, swapForY: venue === "UMBRAE" ? same(tokenIn, pair.tokenX) : null,
          viewer: input.viewerBinding.address, pin: structuredClone(input.pin), chainId: 8453 });
        need(value && value.chainId === 8453 && same(value.blockHash, input.pin.hash) && same(value.tokenIn, tokenIn)
          && same(value.tokenOut, tokenOut) && value.amountInRaw === amount && uint(value.amountOutRaw) && value.amountOutRaw > 0n
          && same(value.viewer, input.viewerBinding.address), "QUOTE_FAILED_OR_BINDING_MISMATCH");
        result.reads.succeeded++; row.quoteReads.succeeded++;
        row.legs.push({ venue, tokenIn, tokenOut, amountInRaw: amount.toString(), amountOutRaw: value.amountOutRaw.toString(), units: "NATIVE_TOKEN_RAW" });
        return value.amountOutRaw;
      } catch (error) { result.reads.failed++; row.quoteReads.failed++; if (!knownFailure(error)) result.reads.unclassifiedFailures++; throw error; }
    };
    for (const startToken of [pair.tokenX, pair.tokenY]) for (const amount of grid[startToken.toLowerCase()]) for (const firstVenue of ["UMBRAE", "COUNTER"]) {
      const other = same(startToken, pair.tokenX) ? pair.tokenY : pair.tokenX;
      const row = { startToken, amountInRaw: amount.toString(), firstVenue, complete: false, quotesReadComplete: false,
        quoteReads: { required: 2, attempted: 0, succeeded: 0, failed: 0 }, legs: [], routePositive: "unknown", quoteExecutable: false };
      result.rows.push(row);
      try {
        const intermediate = await quote(firstVenue, startToken, other, amount, row);
        const out = await quote(firstVenue === "UMBRAE" ? "COUNTER" : "UMBRAE", other, startToken, intermediate, row);
        Object.assign(row, { quotesReadComplete: true, amountOutRaw: out.toString(), grossDeltaRaw: (out - amount).toString() });
      } catch (error) { row.failure = failure(error, "QUOTE_TRANSPORT_FAILED"); if (row.failure === "READ_CAP") result.reads.truncated = true; }
      row.quoteReads.skipped = 2 - row.quoteReads.attempted;
    }
    result.blockers.push("IMMUTABLE_REFERENCE_MAP_AND_EXTENSION_LAYOUT_NOT_COMPILER_QUALIFIED", "VIEWER_SOURCE_RUNTIME_SEMANTICS_NOT_INDEPENDENTLY_ADMITTED");
  } catch (error) {
    const code = failure(error, "OBSERVATION_FAILED");
    result.blockers.push(code); if (code === "READ_CAP") result.reads.truncated = true;
  }
  if (pinQualified) {
    try {
      await pinCheck();
      result.pin = { number: input.pin.number, hash: input.pin.hash, timestamp: input.pin.timestamp, finality: input.pin.finality };
      result.observedAt = new Date(nowMs).toISOString();
    }
    catch (_) { result.blockers.push("PIN_DRIFT_OR_RECHECK_CAP"); }
  }
  result.blockers = [...new Set(result.blockers)]; return result;
}
function main(argv = process.argv.slice(2)) {
  if (argv.length && (argv.length !== 1 || argv[0] !== "--check")) { process.stderr.write("usage: scan-umbrae-x.js [--check] (offline; injected API only)\n"); process.exitCode = 1; return; }
  process.stdout.write(`${JSON.stringify(offline(), null, 2)}\n`);
}
module.exports = { observe, enumerateFactories, validatePairBinding, inspectExtensionWord, encodeSwap, inspectSwap, FACTORIES, FACTORY_ABI, CONFIG_NAMESPACE, offline, main, UmbraeFailure };
if (require.main === module) main();
