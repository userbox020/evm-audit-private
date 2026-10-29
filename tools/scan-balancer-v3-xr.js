#!/usr/bin/env node
"use strict";

// Bounded, read-only Balancer V3 X (cross-venue round trip) and R (mint/redeem)
// observations.
//
// X: for a declared V3 pool and a declared Uniswap V3 pool of the same pair, this
// quotes a complete two-leg round trip in both directions at one finalized pin,
// using the V3 Router's `querySwapSingleTokenExactIn` view and the Uniswap V3
// QuoterV2 view. (No Uniswap V3 venue leg exists for any enumerated Base V3 pool
// pair, so Base X stays a recognized BLOCKED gap.)
//
// R: for a declared V3 pool, this quotes a single-token add/remove round trip with
// the V3 Router's `queryAddLiquidityUnbalanced` and
// `queryRemoveLiquiditySingleTokenExactIn` views: deposit one pool token, receive
// BPT, redeem that BPT for the same token, and compare the output to the input.
//
// The Router address is bound from the authoritative Balancer V3 deployment
// (`20250307-v3-router-v2`) and re-verified on-chain each run (non-empty code plus
// the exact query selectors). RPC endpoint material stays process-only.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, getOrigin } = require("./shared-rpc");
const { resolveWorkingRpc } = require("./scan-morpho-blue-l");
const audit = require("./audit-trigger-coverage-universe.js");

const WORKSPACE = path.resolve(__dirname, "..");
const COVERAGE_DIR = path.join(WORKSPACE, "reports", "monitor", "trigger-coverage");
const RAW_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "balancer-v3-xr-roundtrips.json");
const TIMEOUT_MS = 15_000;
const SCANNER = "tools/scan-balancer-v3-xr.js";
const BINDER_SCHEMA = "trigger-coverage-evidence/v1";
const RAW_SCHEMA = "balancer-v3-xr-roundtrips/v1";
const X_REF = "bounded complete cross-venue round-trip observation";
const R_REF = "bounded mint/redemption observation";

const VAULT = "0xbA1333333333a1BA1108E8412f11850A5C319bA9";
const ROUTERS = Object.freeze({
  1: "0xAE563E3f8219521950555F5962419C8919758Ea2",
  8453: "0x3f170631ed9821Ca51A59D996aB095162438DC10",
});

const WETH = Object.freeze({ symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 });
const ALCX = Object.freeze({ symbol: "ALCX", address: "0xdBdb4d16EdA451D0503b854CF79D55697F90c8DF", decimals: 18 });
const USDC_BASE = Object.freeze({ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 });
const USDP_BASE = Object.freeze({ symbol: "USDp", address: "0x76A9A0062ec6712b99B4f63bD2b4270185759dd5", decimals: 18 });

// X routes (cross-venue). Only Ethereum has a Uniswap V3 venue leg for its V3 pair.
const X_ROUTES = Object.freeze({
  1: Object.freeze({
    chain: "Ethereum",
    pool: "0x1535D7CA00323Aa32BD62AEDdf7ca651e4b95966",
    tokens: Object.freeze([WETH, ALCX]),
    uniswap: Object.freeze({ factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", fee: 3000 }),
    sizes: Object.freeze([10n ** 18n, 5n * 10n ** 18n]),
    binderPath: path.join(COVERAGE_DIR, "balancer-v3-ethereum-x.json"),
  }),
});

// R routes (single-venue mint/redeem).
const R_ROUTES = Object.freeze({
  1: Object.freeze({
    chain: "Ethereum",
    pool: "0x1535D7CA00323Aa32BD62AEDdf7ca651e4b95966",
    tokens: Object.freeze([WETH, ALCX]),
    deposits: Object.freeze([
      Object.freeze({ token: WETH, amount: 10n ** 18n }),
      Object.freeze({ token: ALCX, amount: 10n ** 18n }),
    ]),
    binderPath: path.join(COVERAGE_DIR, "balancer-v3-ethereum-r.json"),
  }),
  8453: Object.freeze({
    chain: "Base",
    pool: "0x3bCf4e84c32D90bb309eAB58D97b70372c84BC2C",
    tokens: Object.freeze([USDP_BASE, USDC_BASE]),
    deposits: Object.freeze([
      Object.freeze({ token: USDP_BASE, amount: 10n ** 18n }),
      Object.freeze({ token: USDC_BASE, amount: 10n ** 6n }),
    ]),
    binderPath: path.join(COVERAGE_DIR, "balancer-v3-base-r.json"),
  }),
});

const VAULT_I = new ethers.Interface(["function getVault() view returns (address)"]);
const ROUTER_I = new ethers.Interface([
  "function querySwapSingleTokenExactIn(address pool,address tokenIn,address tokenOut,uint256 exactAmountIn,address sender,bytes userData) returns (uint256)",
  "function queryAddLiquidityUnbalanced(address pool,uint256[] exactAmountsIn,address sender,bytes userData) returns (uint256)",
  "function queryRemoveLiquiditySingleTokenExactIn(address pool,uint256 exactBptAmountIn,address tokenOut,address sender,bytes userData) returns (uint256)",
  "function queryAddLiquidityProportional(address pool,uint256 exactBptAmountOut,address sender,bytes userData) returns (uint256[])",
  "function queryRemoveLiquidityProportional(address pool,uint256 exactBptAmountIn,address sender,bytes userData) returns (uint256[])",
]);
const FACTORY_I = new ethers.Interface(["function getPool(address,address,uint24) view returns (address)"]);
const QUOTER_I = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const SENDER = "0x000000000000000000000000000000000000dEaD";
const ZERO = "0x0000000000000000000000000000000000000000";

// Balancer Vault errors emitted when a pool hook's after-add/after-remove callback
// returns `success == false` (e.g. the StableSurgeHook imbalance guard). They are a
// pool-state signal, not a transport failure, so they get their own reason code.
const HOOK_GUARD_SELECTORS = Object.freeze({
  "0xe1249165": "AfterAddLiquidityHookFailed",
  "0x1d3391d8": "AfterRemoveLiquidityHookFailed",
});
// Bounded proportional round-trip size used by the hook-compatible R fallback.
const PROPORTIONAL_BPT_RAW = 10n ** 18n;

class ScanFailure extends Error {
  constructor(code) { super(code); this.name = "ScanFailure"; this.code = code; }
}
function fail(code) { throw new ScanFailure(code); }
function sameAddress(a, b) { return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase(); }
function sanitizeFailure(error) {
  const allowed = new Set(["RPC_UNAVAILABLE", "BLOCK_UNAVAILABLE", "CALL_FAILED", "EMPTY_CODE", "ABI_DECODE_FAILED", "VAULT_PROVENANCE_MISMATCH", "UNISWAP_POOL_MISSING", "HOOK_GUARD"]);
  return allowed.has(error && error.code) ? error.code : "CALL_FAILED";
}
function revertSelector(data) {
  const match = typeof data === "string" ? /^0x[0-9a-fA-F]{8}/u.exec(data.trim()) : null;
  return match ? match[0].toLowerCase() : null;
}
function hookGuardSelector(data) {
  const selector = revertSelector(data);
  return selector && Object.hasOwn(HOOK_GUARD_SELECTORS, selector) ? selector : null;
}
function revertDataFromError(error) {
  const candidates = [
    error && error.data,
    error && error.error && error.error.data,
    error && error.info && error.info.error && error.info.error.data,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") return candidate;
    if (candidate && typeof candidate.data === "string") return candidate.data;
  }
  return null;
}
function relPosix(target) { return path.relative(WORKSPACE, target).split(path.sep).join("/"); }
function formatRaw(value, decimals) { return ethers.formatUnits(value, decimals); }
function grossBps(deltaRaw, inputRaw) { return Number((deltaRaw * 10_000n * 1_000_000n) / inputRaw) / 1_000_000; }

// Direct, bounded `eth_call` used only to capture the raw revert data the shared
// transport hides (it collapses any JSON-RPC error to null). Endpoint stays
// process-only; the raw response is never persisted.
async function strictEthCallCapture(url, tx, blockTag, ms = TIMEOUT_MS, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const headers = { "content-type": "application/json" };
    const origin = getOrigin(url);
    if (origin) headers.origin = origin;
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [tx, blockTag] }),
      signal: controller.signal,
    });
    if (!response || response.ok !== true) return null;
    const body = await response.json();
    if (!body || !body.error) return null;
    const data = body.error.data;
    if (typeof data === "string") return data;
    return data && typeof data.data === "string" ? data.data : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function callDecoded(rpc, target, iface, fn, args, blockTag, rpcCallImpl, revertCapture = strictEthCallCapture) {
  const data = iface.encodeFunctionData(fn, args);
  const tx = { to: target, data };
  let raw;
  try {
    raw = await rpcCallImpl(rpc, "eth_call", [tx, blockTag], TIMEOUT_MS);
  } catch (error) {
    if (hookGuardSelector(revertDataFromError(error))) fail("HOOK_GUARD");
    throw error;
  }
  if (typeof raw !== "string" || !/^0x[0-9a-f]*$/i.test(raw) || raw === "0x") {
    // The transport collapsed the call (revert or empty); re-probe to classify the cause.
    if (typeof revertCapture === "function") {
      let captured = null;
      try { captured = await revertCapture(rpc, tx, blockTag); } catch (_) { captured = null; }
      if (hookGuardSelector(captured)) fail("HOOK_GUARD");
    }
    fail("CALL_FAILED");
  }
  try {
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    if (hookGuardSelector(raw)) fail("HOOK_GUARD");
    fail("ABI_DECODE_FAILED");
  }
}
async function requireCode(rpc, address, blockTag, rpcCallImpl) {
  const code = await rpcCallImpl(rpc, "eth_getCode", [address, blockTag], TIMEOUT_MS);
  if (typeof code !== "string" || !/^0x[0-9a-f]+$/i.test(code) || code === "0x") fail("EMPTY_CODE");
}
async function selectPin(rpc, rpcCallImpl) {
  const block = await rpcCallImpl(rpc, "eth_getBlockByNumber", ["finalized", false], TIMEOUT_MS);
  if (!block || !/^0x[0-9a-f]+$/i.test(block.number || "") || !/^0x[0-9a-f]{64}$/i.test(block.hash || "")) fail("BLOCK_UNAVAILABLE");
  return { block, blockTag: block.number, finality: "finalized" };
}
async function verifyVault(rpc, pool, blockTag, rpcCallImpl) {
  const [vault] = await callDecoded(rpc, pool, VAULT_I, "getVault", [], blockTag, rpcCallImpl);
  if (!sameAddress(vault, VAULT)) fail("VAULT_PROVENANCE_MISMATCH");
}

async function scanX(chainId, options = {}) {
  const route = X_ROUTES[chainId];
  if (!route) fail("ROUTE_ABSENT");
  const rpcCallImpl = options.rpcCall || rpcCall;
  const resolveRpcImpl = options.resolveRpc || resolveWorkingRpc;
  const rpc = await resolveRpcImpl(chainId);
  if (!rpc) fail("RPC_UNAVAILABLE");
  const { block, blockTag, finality } = await selectPin(rpc, rpcCallImpl);
  const router = ROUTERS[chainId];
  for (const address of [router, route.pool, route.tokens[0].address, route.tokens[1].address, route.uniswap.factory, route.uniswap.quoter]) {
    await requireCode(rpc, address, blockTag, rpcCallImpl);
  }
  await verifyVault(rpc, route.pool, blockTag, rpcCallImpl);
  const [uniPool] = await callDecoded(rpc, route.uniswap.factory, FACTORY_I, "getPool", [route.tokens[0].address, route.tokens[1].address, route.uniswap.fee], blockTag, rpcCallImpl);
  if (sameAddress(uniPool, ZERO)) fail("UNISWAP_POOL_MISSING");
  await requireCode(rpc, uniPool, blockTag, rpcCallImpl);

  const quoteV3 = async (tokenIn, tokenOut, amountInRaw) => {
    const [amountOutRaw] = await callDecoded(rpc, router, ROUTER_I, "querySwapSingleTokenExactIn", [route.pool, tokenIn, tokenOut, amountInRaw, SENDER, "0x"], blockTag, rpcCallImpl);
    return BigInt(amountOutRaw);
  };
  const quoteUni = async (tokenIn, tokenOut, amountInRaw) => {
    const [amountOutRaw] = await callDecoded(rpc, route.uniswap.quoter, QUOTER_I, "quoteExactInputSingle", [{ tokenIn, tokenOut, amountIn: amountInRaw, fee: route.uniswap.fee, sqrtPriceLimitX96: 0n }], blockTag, rpcCallImpl);
    return BigInt(amountOutRaw);
  };

  const rows = [];
  let attempted = 1, succeeded = 1, failed = 0;
  const errors = [];
  const directions = [
    { id: "V3_TO_UNIV3", first: { venue: "Balancer V3", fn: quoteV3 }, second: { venue: "Uniswap V3", fn: quoteUni } },
    { id: "UNIV3_TO_V3", first: { venue: "Uniswap V3", fn: quoteUni }, second: { venue: "Balancer V3", fn: quoteV3 } },
  ];
  for (const size of route.sizes) {
    for (const direction of directions) {
      const legs = [];
      let amount = size;
      let rowFailed = false;
      for (const leg of [direction.first, direction.second]) {
        attempted += 1;
        const tokenIn = leg === direction.first ? route.tokens[0] : route.tokens[1];
        const tokenOut = leg === direction.first ? route.tokens[1] : route.tokens[0];
        try {
          const out = await leg.fn(tokenIn.address, tokenOut.address, amount);
          if (out <= 0n) fail("CALL_FAILED");
          legs.push({ venue: leg.venue, tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol, amountInRaw: amount.toString(), amountOutRaw: out.toString() });
          succeeded += 1;
          amount = out;
        } catch (error) {
          failed += 1;
          errors.push(`${direction.id}/${leg.venue}: ${sanitizeFailure(error)}`);
          rowFailed = true;
          break;
        }
      }
      const delta = rowFailed ? null : amount - size;
      rows.push({
        direction: direction.id,
        amountInRaw: size.toString(),
        amountIn: formatRaw(size, route.tokens[0].decimals),
        amountOutRaw: rowFailed ? null : amount.toString(),
        amountOut: rowFailed ? null : formatRaw(amount, route.tokens[0].decimals),
        grossDeltaRaw: rowFailed ? null : delta.toString(),
        grossBps: rowFailed ? null : grossBps(delta, size),
        legs,
        classification: rowFailed ? "INCOMPLETE" : delta > 0n ? "GROSS_EDGE_FORK_REQUIRED" : "NO_CROSS_VENUE_EDGE",
        routePositive: "unknown",
      });
    }
  }
  const recheck = await rpcCallImpl(rpc, "eth_getBlockByHash", [block.hash, false], TIMEOUT_MS);
  if (!recheck || String(recheck.hash).toLowerCase() !== String(block.hash).toLowerCase()) fail("BLOCK_UNAVAILABLE");
  return {
    chainId, chain: route.chain, router, vault: VAULT, pool: route.pool,
    uniswap: { pool: ethers.getAddress(uniPool), factory: route.uniswap.factory, quoter: route.uniswap.quoter, fee: route.uniswap.fee },
    sizes: route.sizes.map(String), rows,
    reads: { attempted, succeeded, failed, unclassifiedFailures: 0 },
    errors,
    complete: failed === 0 && rows.every((row) => row.classification !== "INCOMPLETE"),
    pin: { number: Number(BigInt(block.number)), hash: block.hash, timestamp: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(), finality },
  };
}

async function scanR(chainId, options = {}) {
  const route = R_ROUTES[chainId];
  if (!route) fail("ROUTE_ABSENT");
  const rpcCallImpl = options.rpcCall || rpcCall;
  const resolveRpcImpl = options.resolveRpc || resolveWorkingRpc;
  const rpc = await resolveRpcImpl(chainId);
  if (!rpc) fail("RPC_UNAVAILABLE");
  const { block, blockTag, finality } = await selectPin(rpc, rpcCallImpl);
  const router = ROUTERS[chainId];
  for (const address of [router, route.pool, ...route.tokens.map((token) => token.address)]) {
    await requireCode(rpc, address, blockTag, rpcCallImpl);
  }
  await verifyVault(rpc, route.pool, blockTag, rpcCallImpl);

  const revertCapture = options.revertCapture || strictEthCallCapture;
  const rows = [];
  let attempted = 1, succeeded = 1;
  const errors = [];
  const hookGuard = [];
  const call = (iface, fn, args) => callDecoded(rpc, router, iface, fn, args, blockTag, rpcCallImpl, revertCapture);

  // Unbalanced single-token round trip. A hook-guard revert on either leg is
  // returned as `HOOK_GUARD` so the caller can fall back to PROPORTIONAL.
  const probeUnbalanced = async (deposit, index) => {
    const amounts = route.tokens.map((token, i) => (i === index ? deposit.amount : 0n));
    let bptOut;
    try {
      const [bpt] = await call(ROUTER_I, "queryAddLiquidityUnbalanced", [route.pool, amounts, SENDER, "0x"]);
      if (BigInt(bpt) <= 0n) fail("CALL_FAILED");
      bptOut = BigInt(bpt);
    } catch (error) {
      return { ok: false, rejectedLeg: "ADD", error: sanitizeFailure(error) };
    }
    try {
      const [amountOut] = await call(ROUTER_I, "queryRemoveLiquiditySingleTokenExactIn", [route.pool, bptOut, deposit.token.address, SENDER, "0x"]);
      if (BigInt(amountOut) <= 0n) fail("CALL_FAILED");
      return { ok: true, bptOut, amountOut: BigInt(amountOut) };
    } catch (error) {
      return { ok: false, rejectedLeg: "REMOVE", error: sanitizeFailure(error), bptOut };
    }
  };

  // PROPORTIONAL round trip (StableSurge always allows PROPORTIONAL): mint a bounded
  // BPT amount, then redeem the same BPT amount proportionally. Both legs return the
  // full token vector so the round trip stays complete.
  const probeProportional = async () => {
    let amountsIn;
    try {
      const [inAmounts] = await call(ROUTER_I, "queryAddLiquidityProportional", [route.pool, PROPORTIONAL_BPT_RAW, SENDER, "0x"]);
      amountsIn = inAmounts.map((value) => BigInt(value));
    } catch (error) {
      return { ok: false, succeededLegs: 0, error: sanitizeFailure(error) };
    }
    let amountsOut;
    try {
      const [outAmounts] = await call(ROUTER_I, "queryRemoveLiquidityProportional", [route.pool, PROPORTIONAL_BPT_RAW, SENDER, "0x"]);
      amountsOut = outAmounts.map((value) => BigInt(value));
    } catch (error) {
      return { ok: false, succeededLegs: 1, error: sanitizeFailure(error) };
    }
    if (amountsIn.some((value) => value <= 0n) || amountsOut.some((value) => value <= 0n)) {
      return { ok: false, succeededLegs: 2, error: "CALL_FAILED" };
    }
    return { ok: true, succeededLegs: 2, amountsIn, amountsOut };
  };

  for (const deposit of route.deposits) {
    const index = route.tokens.findIndex((token) => sameAddress(token.address, deposit.token.address));
    const unbalanced = await probeUnbalanced(deposit, index);
    if (unbalanced.ok) {
      attempted += 2; succeeded += 2;
      const delta = unbalanced.amountOut - deposit.amount;
      rows.push({
        direction: `ADD_REMOVE_${deposit.token.symbol}`,
        token: deposit.token.symbol,
        legType: "unbalanced",
        amountInRaw: deposit.amount.toString(),
        amountIn: formatRaw(deposit.amount, deposit.token.decimals),
        bptOutRaw: unbalanced.bptOut.toString(),
        amountOutRaw: unbalanced.amountOut.toString(),
        amountOut: formatRaw(unbalanced.amountOut, deposit.token.decimals),
        grossDeltaRaw: delta.toString(),
        grossBps: grossBps(delta, deposit.amount),
        classification: delta > 0n ? "GROSS_EDGE_FORK_REQUIRED" : "NO_JOIN_EXIT_EDGE",
        routePositive: "unknown",
      });
      continue;
    }
    if (unbalanced.error === "HOOK_GUARD") {
      const guard = { direction: `ADD_REMOVE_${deposit.token.symbol}`, rejectedLeg: unbalanced.rejectedLeg, legType: "unbalanced", fallback: "proportional", fallbackUsed: false };
      hookGuard.push(guard);
      const proportional = await probeProportional();
      if (proportional.ok) {
        attempted += 2; succeeded += 2;
        guard.fallbackUsed = true;
        const input = proportional.amountsIn[index];
        const output = proportional.amountsOut[index];
        const delta = output - input;
        const anyTokenPositive = proportional.amountsOut.some((value, i) => value > proportional.amountsIn[i]);
        rows.push({
          direction: `ADD_REMOVE_${deposit.token.symbol}`,
          token: deposit.token.symbol,
          legType: "proportional",
          bptAmountRaw: PROPORTIONAL_BPT_RAW.toString(),
          amountInRaw: input.toString(),
          amountIn: formatRaw(input, deposit.token.decimals),
          amountOutRaw: output.toString(),
          amountOut: formatRaw(output, deposit.token.decimals),
          grossDeltaRaw: delta.toString(),
          grossBps: input > 0n ? grossBps(delta, input) : 0,
          tokensInRaw: proportional.amountsIn.map(String),
          tokensOutRaw: proportional.amountsOut.map(String),
          classification: !anyTokenPositive && delta <= 0n ? "NO_JOIN_EXIT_EDGE" : "GROSS_EDGE_FORK_REQUIRED",
          routePositive: "unknown",
        });
        continue;
      }
      attempted += 2; succeeded += proportional.succeededLegs;
      errors.push(`PROPORTIONAL_${deposit.token.symbol}: ${proportional.error}`);
      continue;
    }
    attempted += 1;
    errors.push(`ADD_${deposit.token.symbol}: ${unbalanced.error}`);
  }

  const recheck = await rpcCallImpl(rpc, "eth_getBlockByHash", [block.hash, false], TIMEOUT_MS);
  if (!recheck || String(recheck.hash).toLowerCase() !== String(block.hash).toLowerCase()) fail("BLOCK_UNAVAILABLE");
  return {
    chainId, chain: route.chain, router, vault: VAULT, pool: route.pool,
    tokens: route.tokens.map((token) => token.symbol), rows, hookGuard,
    reads: { attempted, succeeded, failed: attempted - succeeded, unclassifiedFailures: 0 },
    errors,
    complete: rows.length === route.deposits.length && attempted === succeeded,
    pin: { number: Number(BigInt(block.number)), hash: block.hash, timestamp: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(), finality },
  };
}

function xEvidence(chain, artifact) {
  const covered = chain.complete === true;
  return {
    schema: BINDER_SCHEMA,
    observedAt: artifact.scannedAt,
    chainId: chain.chainId,
    family: "Balancer V3",
    triggerClass: "X",
    enumeration: { kind: "BOUNDED_ARTIFACT", ref: X_REF, boundDeclared: true, successful: covered },
    reads: chain.reads,
    classSemantics: { triggerClass: "X", exact: true },
    coverage: { complete: covered },
    onFire: { economics: true, keylessFixedPinFork: true, alert: true },
    dispatchEnabled: covered,
    evidence: [
      `${relPosix(RAW_PATH)}#x.${chain.chainId}`,
      `finalized pin ${chain.pin.number} hash ${chain.pin.hash}`,
      `Balancer V3 Router ${chain.router} re-verified on-chain with the querySwapSingleTokenExactIn selector; V3 pool ${chain.pool} (getVault=${chain.vault})`,
      `Uniswap V3 pool ${chain.uniswap.pool} fee ${chain.uniswap.fee}; ${chain.sizes.length} sizes in both directions`,
      `round trips: ${chain.rows.map((row) => `${row.direction} ${row.amountIn}->${row.amountOut ?? "incomplete"} (${row.classification})`).join("; ")}`,
    ],
    blockers: covered ? [] : [`cross-venue round trip incomplete (${chain.reads.failed} failed legs)`, ...chain.errors],
  };
}

function hookGuardLines(chain) {
  return (chain.hookGuard || []).map((guard) =>
    `surge-hook guard: imbalance-increasing direction rejected (${guard.direction} ${guard.rejectedLeg}); proportional fallback ${guard.fallbackUsed ? "used" : "failed"}`);
}

function rEvidence(chain, artifact) {
  const covered = chain.complete === true;
  const guardLines = hookGuardLines(chain);
  return {
    schema: BINDER_SCHEMA,
    observedAt: artifact.scannedAt,
    chainId: chain.chainId,
    family: "Balancer V3",
    triggerClass: "R",
    enumeration: { kind: "BOUNDED_ARTIFACT", ref: R_REF, boundDeclared: true, successful: covered },
    reads: chain.reads,
    classSemantics: { triggerClass: "R", exact: true },
    coverage: { complete: covered },
    onFire: { economics: true, keylessFixedPinFork: true, alert: true },
    dispatchEnabled: covered,
    evidence: [
      `${relPosix(RAW_PATH)}#r.${chain.chainId}`,
      `finalized pin ${chain.pin.number} hash ${chain.pin.hash}`,
      `Balancer V3 Router ${chain.router} re-verified on-chain with the add/remove-liquidity query selectors; V3 pool ${chain.pool} (getVault=${chain.vault})`,
      `add/remove round trips: ${chain.rows.map((row) => `${row.token}[${row.legType || "unbalanced"}] ${row.amountIn}->${row.amountOut} (${row.classification})`).join("; ")}`,
      ...guardLines,
    ],
    // A classified hook guard is never reported as a bare CALL_FAILED.
    blockers: covered ? [] : [`mint/redeem round trip incomplete (${chain.reads.failed} failed reads)`, ...guardLines, ...chain.errors],
  };
}

async function scan(options = {}) {
  const scannedAt = new Date(options.now || Date.now()).toISOString();
  const x = [];
  for (const chainId of Object.keys(X_ROUTES)) {
    try { x.push(await scanX(Number(chainId), options)); } catch (error) { x.push({ chainId: Number(chainId), failed: sanitizeFailure(error) }); }
  }
  const r = [];
  for (const chainId of Object.keys(R_ROUTES)) {
    try { r.push(await scanR(Number(chainId), options)); } catch (error) { r.push({ chainId: Number(chainId), failed: sanitizeFailure(error) }); }
  }
  return {
    schema: RAW_SCHEMA,
    scanner: SCANNER,
    scannedAt,
    safety: { readOnly: true, signedActions: false, transactions: false, approvals: false, swaps: false, liquidity: false, endpointMaterialPersisted: false },
    x, r,
    routePositive: 0,
    executableNow: 0,
  };
}

function publish(artifact, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const rawPath = options.rawPath || RAW_PATH;
  fsImpl.mkdirSync(path.dirname(rawPath), { recursive: true });
  fsImpl.writeFileSync(rawPath, `${JSON.stringify(artifact, null, 2)}\n`);
  const written = [];
  for (const chain of artifact.x) {
    if (chain.failed) continue;
    const target = X_ROUTES[chain.chainId].binderPath;
    audit.atomicWriteJson(target, xEvidence(chain, artifact), { fsImpl });
    written.push(relPosix(target));
  }
  for (const chain of artifact.r) {
    if (chain.failed) continue;
    const target = R_ROUTES[chain.chainId].binderPath;
    audit.atomicWriteJson(target, rEvidence(chain, artifact), { fsImpl });
    written.push(relPosix(target));
  }
  return { rawPath, written };
}

async function refresh(options = {}) {
  const artifact = await scan(options);
  const result = publish(artifact, options);
  return Object.freeze({ scannedAt: artifact.scannedAt, x: artifact.x.filter((chain) => !chain.failed).length, r: artifact.r.filter((chain) => !chain.failed).length, written: result.written });
}

async function main(argv = process.argv.slice(2)) {
  try {
    const unknown = argv.filter((arg) => arg !== "--check");
    if (unknown.length) throw new Error("usage: scan-balancer-v3-xr.js [--check]");
    if (argv.includes("--check")) {
      process.stdout.write(`balancer-v3-xr check ok: xRoutes=${Object.keys(X_ROUTES).length} rRoutes=${Object.keys(R_ROUTES).length}\n`);
      return;
    }
    const result = await refresh({});
    process.stdout.write(`balancer-v3-xr scanned: x=${result.x} r=${result.r} written=${result.written.length} scannedAt=${result.scannedAt}\n`);
    for (const file of result.written) process.stdout.write(`balancer-v3-xr wrote ${file}\n`);
  } catch (error) {
    process.stderr.write(`balancer-v3-xr failed closed: ${sanitizeFailure(error)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = {
  WORKSPACE, COVERAGE_DIR, RAW_PATH, VAULT, ROUTERS, X_ROUTES, R_ROUTES, X_REF, R_REF, SCANNER,
  BINDER_SCHEMA, RAW_SCHEMA, SENDER, HOOK_GUARD_SELECTORS, PROPORTIONAL_BPT_RAW,
  ScanFailure, sameAddress, sanitizeFailure, revertSelector, hookGuardSelector, revertDataFromError,
  strictEthCallCapture, callDecoded, requireCode,
  selectPin, verifyVault, scanX, scanR, scan, xEvidence, hookGuardLines, rEvidence, publish, refresh, main,
};
