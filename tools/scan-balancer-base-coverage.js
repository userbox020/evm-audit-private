#!/usr/bin/env node
"use strict";

// Provisional, bounded read collector. Import/default CLI/--check are OFFLINE.
// No resolver, discovery, writer, fork or dispatch. The parent supplies an exact
// public read context; existing disabled-row binders still own monitor outputs.
const { ethers } = require("ethers");
const { accountProportionalBasket } = require("./scan-balancer-v2-join-exit");
const CHAIN_ID = 8453;
const MAX_REQUESTS = 96;
const V2 = Object.freeze({
  pool: "0xc205BA80BFE089f364922c3439Ee952302C3CD9c",
  poolId: "0xc205ba80bfe089f364922c3439ee952302c3cd9c000200000000000000000371",
  vault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
  tokens: Object.freeze(["0x4200000000000000000000000000000000000006", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"]),
});
const ROUTER = "0x3f170631ed9821Ca51A59D996aB095162438DC10";
const FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const ZERO_SLOT = `0x${"0".repeat(64)}`;
const PROXY_SLOTS = [
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
];
const ZOS_SLOT = ethers.keccak256(ethers.toUtf8Bytes("org.zeppelinos.proxy.implementation"));
const hash = value => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const address = value => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) && !same(value, ethers.ZeroAddress);
const uint = value => typeof value === "bigint" && value >= 0n && value < (1n << 256n);
const I = new ethers.Interface([
  "function decimals() view returns(uint8)",
  "function getVault() view returns(address)",
  "function getPoolId() view returns(bytes32)",
  "function getPool(bytes32) view returns(address,uint8)",
  "function getPoolTokens(bytes32) view returns(address[],uint256[],uint256)",
  "function totalSupply() view returns(uint256)",
  "function getPoolTokenInfo(address) view returns(address[],(uint8 tokenType,address rateProvider,bool paysYieldFees)[],uint256[],uint256[])",
  "function getPoolTokenRates(address) view returns(uint256[],uint256[])",
  "function getHooksConfig(address) view returns((bool,bool,bool,bool,bool,bool,bool,bool,bool,bool,address))",
  "function querySwapSingleTokenExactIn(address,address,address,uint256,address,bytes) returns(uint256)",
  "function getPool(address,address,uint24) view returns(address)",
  "function factory() view returns(address)",
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function fee() view returns(uint24)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)",
]);
const ROWS = Object.freeze({
  "base-balancer-v2-x": { family: "Balancer V2", triggerClass: "X", ref: "bounded complete cross-venue round-trip observation" },
  "base-balancer-v2-r": { family: "Balancer V2", triggerClass: "R", ref: "bounded mint/redemption observation" },
  "base-balancer-v3-x": { family: "Balancer V3", triggerClass: "X", ref: "bounded complete cross-venue round-trip observation" },
});
class Incomplete extends Error { constructor(code) { super(code); this.code = code; } }
function requireValue(condition, code) { if (!condition) throw new Incomplete(code); }

function offline(rowId) {
  const row = ROWS[rowId];
  requireValue(row, "ROW_UNSUPPORTED");
  return {
    schema: "trigger-coverage-evidence/v1", rowId, observedAt: null, chainId: CHAIN_ID,
    family: row.family, triggerClass: row.triggerClass, provisional: true,
    enumeration: { kind: "BOUNDED_ARTIFACT", ref: row.ref, boundDeclared: false, successful: false },
    reads: { required: 0, attempted: 0, succeeded: 0, failed: 0, unclassifiedFailures: 0, skipped: 0 },
    readAccountingUnit: "JSON_RPC_REQUEST",
    readAccountingNote: "required counts encountered requests; blocked dependent quotes are listed separately in quoteReadPlan/requiredNextBranch, never counted as successes",
    readResults: [], sourceRuntimeBindings: [],
    classSemantics: { triggerClass: row.triggerClass, exact: false }, coverage: { complete: false },
    onFire: { economics: false, keylessFixedPinFork: false, alert: false }, dispatchEnabled: false,
    routePositive: "unknown", executableNow: "unknown", rows: [],
    ...(rowId === "base-balancer-v2-r" ? { proportionalReference: {
      source: "gyrostable/concentrated-lps@86c6815c61d223f73b202b3709dd65a2b6b86b42",
      poolKind: "GyroECLPPool", joinOperation: "ALL_TOKENS_IN_FOR_EXACT_BPT_OUT",
      exitOperation: "EXACT_BPT_IN_FOR_TOKENS_OUT", unbalancedAlternativesSupported: false,
      numericKindsQualified: false, queryAbiQualified: false, deployedSourceRuntimeBound: false,
      evidenceClass: "OFFICIAL_REFERENCE_SOURCE_ONLY_NOT_SELECTED_POOL_PROOF",
    } } : {}),
    evidence: ["tools/scan-balancer-base-coverage.js: provisional bounded read seam, not monitor admission or live proof"],
    blockers: [row.triggerClass === "R"
      ? "V2_PROPORTIONAL_ENCODING_SOURCE_RUNTIME_UNQUALIFIED: bind selected pool kind and exact proportional join/exit enums before queryJoin/queryExit; no WeightedPool encoding fallback"
      : rowId === "base-balancer-v2-x" ? "USE_EXISTING_V2_X_PRODUCER: qualify exact revert/source/liquidity without pool substitution"
        : "V3_CURRENT_POOL_COUNTERVENUE_HOOK_RATE_SOURCE_BINDING_REQUIRED"],
  };
}

// State requests use EIP-1898 hash pins. Unsupported EIP-1898 is a blocker, not
// permission to silently fall back to latest/number pins or another provider.
function context(input, read, result, nowMs, maxRequests) {
  const pin = input.pin;
  requireValue(input.chainId === CHAIN_ID, "WRONG_CHAIN");
  requireValue(pin && /^0x[0-9a-f]+$/i.test(pin.number || "") && hash(pin.hash)
    && Number.isSafeInteger(pin.timestamp) && pin.timestamp > 0 && pin.finality === "finalized", "PIN_REQUIRED");
  requireValue(nowMs / 1000 - pin.timestamp <= 900 && pin.timestamp <= nowMs / 1000 + 60, "PIN_STALE");
  requireValue(Number.isSafeInteger(maxRequests) && maxRequests > 0 && maxRequests <= MAX_REQUESTS, "READ_CAP_INVALID");
  const blockRef = Object.freeze({ blockHash: pin.hash, requireCanonical: true });
  async function request(id, method, params, validate) {
    result.reads.required++;
    if (result.reads.attempted >= maxRequests) { result.reads.skipped++; throw new Incomplete("READ_CAP_EXCEEDED"); }
    result.reads.attempted++;
    try {
      const value = await read({ method, params });
      if (value?.error) throw new Incomplete("RPC_REVERT_OR_ERROR");
      const output = validate(value);
      result.reads.succeeded++;
      result.readResults.push({ id, method, status: "SUCCESS" });
      return output;
    } catch (error) {
      result.reads.failed++;
      // Never serialize arbitrary provider errors, revert data or endpoint text.
      const code = error instanceof Incomplete ? error.code : "READ_OR_ABI_FAILED";
      result.readResults.push({ id, method, status: "FAILED", failure: code });
      throw new Incomplete(code);
    }
  }
  const call = (id, target, fn, args, validate = value => value) => request(id, "eth_call",
    [{ to: target, data: I.encodeFunctionData(fn, args) }, blockRef], raw => {
      requireValue(typeof raw === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(raw), "CALL_RESULT_INVALID");
      return validate(I.decodeFunctionResult(fn, raw));
    });
  async function bindCode(id, target) {
    const commitment = input.runtimeBindings?.[target.toLowerCase()];
    requireValue(address(target) && commitment && hash(commitment.runtimeKeccak256)
      && hash(commitment.sourceSha256) && commitment.chainId === CHAIN_ID
      && same(commitment.blockHash, pin.hash) && ["DIRECT", "EIP1967", "ZEPPELINOS"].includes(commitment.proxyKind), "SOURCE_RUNTIME_BINDING_REQUIRED");
    await request(`${id}.runtime`, "eth_getCode", [target, blockRef], raw => {
      requireValue(typeof raw === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(raw)
        && same(ethers.keccak256(raw), commitment.runtimeKeccak256), "RUNTIME_MISMATCH");
      requireValue(!/^0x363d3d373d3d3d363d73/i.test(raw), "PROXY_UNQUALIFIED");
    });
    const implementationSlot = commitment.proxyKind === "EIP1967" ? PROXY_SLOTS[0]
      : commitment.proxyKind === "ZEPPELINOS" ? ZOS_SLOT : null;
    for (const [index, slot] of [...PROXY_SLOTS, ZOS_SLOT].entries()) await request(`${id}.proxySlot${index}`, "eth_getStorageAt",
      [target, slot, blockRef], raw => {
        if (slot === implementationSlot) requireValue(address(commitment.implementation)
          && same(raw, ethers.zeroPadValue(commitment.implementation, 32)), "PROXY_IMPLEMENTATION_MISMATCH");
        else requireValue(same(raw, ZERO_SLOT), "PROXY_UNQUALIFIED");
      });
    if (implementationSlot) {
      requireValue(hash(commitment.implementationRuntimeKeccak256) && hash(commitment.implementationSourceSha256), "IMPLEMENTATION_SOURCE_REQUIRED");
      await request(`${id}.implementationRuntime`, "eth_getCode", [commitment.implementation, blockRef], raw => {
        requireValue(typeof raw === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(raw)
          && same(ethers.keccak256(raw), commitment.implementationRuntimeKeccak256), "IMPLEMENTATION_RUNTIME_MISMATCH");
      });
    }
    result.sourceRuntimeBindings.push({ address: target, runtimeKeccak256: commitment.runtimeKeccak256,
      sourceSha256: commitment.sourceSha256, proxyKind: commitment.proxyKind,
      ...(implementationSlot ? { implementation: commitment.implementation,
        implementationRuntimeKeccak256: commitment.implementationRuntimeKeccak256,
        implementationSourceSha256: commitment.implementationSourceSha256 } : {}) });
  }
  const verifyBlock = id => request(id, "eth_getBlockByNumber", [pin.number, false], block => {
    requireValue(block && same(block.hash, pin.hash) && BigInt(block.number) === BigInt(pin.number)
      && Number(BigInt(block.timestamp)) === pin.timestamp, "PIN_MISMATCH");
  });
  return { request, call, bindCode, verifyBlock, pin };
}

async function collectV2Basket(ctx, result) {
  // Deliberately no queries address or Gyro userData guessed from Ethereum.
  for (const [id, target] of [["pool", V2.pool], ["vault", V2.vault], ...V2.tokens.map((token, index) => [`token${index}`, token])]) {
    await ctx.bindCode(id, target);
  }
  await ctx.call("pool.id", V2.pool, "getPoolId", [], ([id]) => requireValue(same(id, V2.poolId), "POOL_ID_MISMATCH"));
  await ctx.call("pool.vault", V2.pool, "getVault", [], ([vault]) => requireValue(same(vault, V2.vault), "VAULT_MISMATCH"));
  await ctx.call("vault.pool", V2.vault, "getPool(bytes32)", [V2.poolId], ([pool]) => requireValue(same(pool, V2.pool), "POOL_MISMATCH"));
  const balances = await ctx.call("vault.basket", V2.vault, "getPoolTokens", [V2.poolId], ([tokens, amounts, changed]) => {
    requireValue(tokens.length === 2 && amounts.length === 2 && tokens.every((token, index) => same(token, V2.tokens[index]))
      && changed <= BigInt(ctx.pin.number), "TOKEN_ORDER_OR_STATE_MISMATCH");
    return Array.from(amounts, String);
  });
  for (const [index, decimals] of [18, 6].entries()) await ctx.call(`token${index}.decimals`, V2.tokens[index], "decimals", [],
    ([value]) => requireValue(Number(value) === decimals, "TOKEN_DECIMALS_MISMATCH"));
  const [supply] = await ctx.call("pool.supply", V2.pool, "totalSupply", []);
  result.basketBinding = { ...V2, balancesRaw: balances, totalSupplyRaw: supply.toString(), poolKind: "UNQUALIFIED" };
  result.requiredNextBranch = "Bind selected pool to exact source/runtime; verify numeric ALL_TOKENS_IN_FOR_EXACT_BPT_OUT / EXACT_BPT_IN_FOR_TOKENS_OUT kinds and Queries ABI/helper; then query full basket and validate post-join state/rounding. Official GyroECLP reference source alone is not the deployed pool proof";
}

function validateV3Input(input) {
  requireValue(address(input.pool) && address(input.vault) && same(input.router, ROUTER)
    && same(input.factory, FACTORY) && same(input.quoter, QUOTER) && address(input.counterPool)
    && !same(input.pool, input.counterPool), "V3_POOL_COUNTERVENUE_REQUIRED");
  requireValue(Array.isArray(input.tokens) && input.tokens.length === 2 && input.tokens.every(address)
    && !same(input.tokens[0], input.tokens[1]) && input.tokens.some(token => same(token, input.base)), "TOKEN_BINDING_REQUIRED");
  requireValue([100, 500, 3000, 10000].includes(input.fee) && address(input.sender)
    && Array.isArray(input.decimals) && input.decimals.length === 2 && input.decimals.every(value => Number.isInteger(value) && value >= 0 && value <= 18), "V3_QUOTE_INPUT_REQUIRED");
  requireValue(Array.isArray(input.sizesRaw) && input.sizesRaw.length > 0 && input.sizesRaw.length <= 4
    && input.sizesRaw.every(value => uint(value) && value > 0n)
    && new Set(input.sizesRaw.map(String)).size === input.sizesRaw.length, "SIZE_ENUMERATION_INVALID");
  // Source commitments are input requirements, not invented current pool proof.
  requireValue(input.poolKind === "BALANCER_V3_STANDARD_NO_HOOKS", "POOL_KIND_UNQUALIFIED");
}

async function collectV3(ctx, input, result) {
  validateV3Input(input);
  result.routeBinding = { pool: input.pool, vault: input.vault, router: ROUTER, factory: FACTORY,
    quoter: QUOTER, counterPool: input.counterPool, tokens: input.tokens, base: input.base,
    fee: input.fee, sender: input.sender, userData: "0x", sizesRaw: input.sizesRaw.map(String),
    poolKindClaim: input.poolKind, poolKindAdmitted: false };
  result.quoteReadPlan = input.sizesRaw.flatMap(amount => ["BALANCER_V3_TO_UNIV3", "UNIV3_TO_BALANCER_V3"].map(direction =>
    ({ direction, amountInRaw: amount.toString(), required: 2, attempted: 0, succeeded: 0, failed: 0, skipped: 2 })));
  for (const [id, target] of [["pool", input.pool], ["vault", input.vault], ["router", ROUTER], ["factory", FACTORY],
    ["quoter", QUOTER], ["counterPool", input.counterPool], ...input.tokens.map((token, index) => [`token${index}`, token])]) await ctx.bindCode(id, target);
  for (const [id, target] of [["pool", input.pool], ["router", ROUTER]]) await ctx.call(`${id}.vault`, target, "getVault", [],
    ([vault]) => requireValue(same(vault, input.vault), "VAULT_MISMATCH"));
  await ctx.call("pool.tokens", input.vault, "getPoolTokenInfo", [input.pool], ([tokens, info, balances, live]) => {
    requireValue(tokens.length === 2 && info.length === 2 && balances.length === 2 && live.length === 2
      && tokens.every((token, index) => same(token, input.tokens[index])), "TOKEN_ORDER_MISMATCH");
    requireValue(info.every(token => token.tokenType === 0n && same(token.rateProvider, ethers.ZeroAddress) && token.paysYieldFees === false), "RATE_BINDING_UNQUALIFIED");
  });
  await ctx.call("pool.hooks", input.vault, "getHooksConfig", [input.pool], ([hooks]) =>
    requireValue(hooks.length === 11 && hooks.slice(0, 10).every(flag => flag === false)
      && same(hooks[10], ethers.ZeroAddress), "HOOK_BINDING_UNQUALIFIED"));
  await ctx.call("pool.rates", input.vault, "getPoolTokenRates", [input.pool], ([scaling, rates]) => {
    requireValue(scaling.length === 2 && rates.length === 2
      && rates.every(rate => rate === 10n ** 18n)
      && scaling.every((scale, index) => scale === 10n ** BigInt(18 - input.decimals[index])), "RATE_BINDING_UNQUALIFIED");
  });
  for (const [index, token] of input.tokens.entries()) await ctx.call(`token${index}.decimals`, token, "decimals", [],
    ([value]) => requireValue(Number(value) === input.decimals[index], "TOKEN_DECIMALS_MISMATCH"));
  await ctx.call("counter.factoryPool", FACTORY, "getPool(address,address,uint24)", [...input.tokens, input.fee],
    ([pool]) => requireValue(same(pool, input.counterPool), "COUNTERVENUE_MISMATCH"));
  const sorted = [...input.tokens].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  for (const [fn, expected] of [["factory", FACTORY], ["token0", sorted[0]], ["token1", sorted[1]]]) await ctx.call(`counter.${fn}`, input.counterPool, fn, [],
    ([value]) => requireValue(same(value, expected), "COUNTERVENUE_MISMATCH"));
  await ctx.call("counter.fee", input.counterPool, "fee", [], ([fee]) => requireValue(fee === BigInt(input.fee), "COUNTERVENUE_MISMATCH"));
  const quoteToken = input.tokens.find(token => !same(token, input.base));
  const quote = async (venue, tokenIn, tokenOut, amount, id, accounting) => {
    const before = result.reads.attempted;
    try {
      const positive = values => { requireValue(values[0] > 0n, "QUOTE_ZERO"); return values; };
      const [out] = venue === "BALANCER_V3" ? await ctx.call(id, ROUTER, "querySwapSingleTokenExactIn",
        [input.pool, tokenIn, tokenOut, amount, input.sender, "0x"], positive)
        : await ctx.call(id, QUOTER, "quoteExactInputSingle", [{ tokenIn, tokenOut, amountIn: amount, fee: input.fee, sqrtPriceLimitX96: 0n }], positive);
      accounting.succeeded++;
      return out;
    } catch (error) {
      if (result.reads.attempted > before) accounting.failed++;
      throw error;
    } finally {
      if (result.reads.attempted > before) { accounting.attempted++; accounting.skipped--; }
    }
  };
  for (const amount of input.sizesRaw) for (const direction of ["BALANCER_V3_TO_UNIV3", "UNIV3_TO_BALANCER_V3"]) {
    const row = { direction, amountInRaw: amount.toString(), complete: false, quotesReadComplete: false,
      routePositive: "unknown", quoteExecutable: false };
    row.quoteReads = result.quoteReadPlan.find(plan => plan.direction === direction && plan.amountInRaw === row.amountInRaw);
    result.rows.push(row);
    try {
      const firstVenue = direction.startsWith("BALANCER") ? "BALANCER_V3" : "UNIV3";
      const mid = await quote(firstVenue, input.base, quoteToken, amount, `${direction}.${amount}.leg1`, row.quoteReads);
      row.intermediateRaw = mid.toString();
      const out = await quote(firstVenue === "BALANCER_V3" ? "UNIV3" : "BALANCER_V3", quoteToken, input.base, mid, `${direction}.${amount}.leg2`, row.quoteReads);
      Object.assign(row, { amountOutRaw: out.toString(), grossDeltaRaw: (out - amount).toString(), quotesReadComplete: true,
        venueFeesIncluded: true, feeDoubleCounting: false, classification: "PROVISIONAL_QUOTES_ONLY" });
    } catch (error) { row.failure = error instanceof Incomplete ? error.code : "QUOTE_FAILED"; }
  }
  // No boolean assertion from an input manifest qualifies pool-specific semantic
  // equivalence or the token transfer path. Parent must admit the exact sources.
  result.observationComplete = result.rows.length === input.sizesRaw.length * 2 && result.rows.every(row => row.quotesReadComplete);
  result.requiredNextBranch = "Admit exact pool/router/vault/token/countervenue source-to-runtime semantics and same-pin execution evidence; wire economics/fork/alert separately";
  result.blockers = ["V3_SOURCE_SEMANTICS_AND_EXECUTION_NOT_ADMITTED", "ECONOMICS_FORK_ALERT_NOT_WIRED"];
}

async function collect(options = {}) {
  const rowId = options.rowId || "base-balancer-v2-r";
  const result = offline(rowId);
  if (typeof options.read !== "function") return result;
  // Snapshot caller configuration before awaiting any I/O; no live discovery.
  const input = structuredClone(options.input || {});
  let ctx;
  let pinQualified = false;
  try {
    ctx = context(input, options.read, result, options.nowMs ?? Date.now(), options.maxRequests ?? MAX_REQUESTS);
    await ctx.request("chain", "eth_chainId", [], value => requireValue(value === "0x2105", "WRONG_CHAIN"));
    await ctx.verifyBlock("pin.before");
    pinQualified = true;
    if (rowId === "base-balancer-v2-r") {
      requireValue((input.pool === undefined || same(input.pool, V2.pool))
        && (input.poolId === undefined || same(input.poolId, V2.poolId))
        && (input.vault === undefined || same(input.vault, V2.vault))
        && (input.tokens === undefined || (input.tokens.length === 2 && input.tokens.every((token, index) => same(token, V2.tokens[index])))), "FIXED_V2_BINDING_MISMATCH");
      result.enumeration.boundDeclared = true;
      await collectV2Basket(ctx, result);
    } else if (rowId === "base-balancer-v3-x") {
      validateV3Input(input);
      result.enumeration.boundDeclared = true;
      await collectV3(ctx, input, result);
    }
  } catch (error) {
    result.blockers.push(error instanceof Incomplete ? error.code : "INPUT_OR_ABI_UNQUALIFIED");
  }
  if (ctx && pinQualified) {
    try {
      await ctx.verifyBlock("pin.after");
      result.pin = { number: input.pin.number, hash: input.pin.hash, timestamp: input.pin.timestamp, finality: input.pin.finality };
      result.observedAt = new Date(options.nowMs ?? Date.now()).toISOString();
    } catch (_) { result.observationComplete = false; result.blockers.push("PIN_RECHECK_FAILED"); }
  }
  result.enumeration.successful = result.enumeration.boundDeclared && result.reads.failed === 0
    && result.reads.skipped === 0 && result.observationComplete === true;
  result.blockers = [...new Set(result.blockers)];
  // Read completion is distinct from semantic qualification and pipeline wiring.
  result.coverage.complete = false;
  return result;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length && (argv.length !== 1 || argv[0] !== "--check")) {
    process.stderr.write("usage: scan-balancer-base-coverage.js [--check] (offline only; injected read API required)\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({ offline: true, provisional: true, rows: Object.keys(ROWS).map(offline) }, null, 2)}\n`);
}
module.exports = { collect, offline, accountProportionalBasket, validateV3Input, V2, ROUTER, FACTORY, QUOTER, I, MAX_REQUESTS, main };
if (require.main === module) main();
