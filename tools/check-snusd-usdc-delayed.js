#!/usr/bin/env node
"use strict";

// One borrower, one read-only capture. Import and non--run CLI are inert.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const shared = require("./shared-rpc");
const { rpcRead } = require("./lib/aave-v4-pinned-collection");
const { normalizeHeader, stableObservation, createRpcLedger, classifyOperatorFamily } = require("./lib/common-finalized-rpc-preflight");

const WAD = 10n ** 18n, SCALE = 10n ** 36n;
const B = Object.freeze({ morpho: "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb",
  marketId: "0xae60b71b407e0517ead445b7113a7ffa07ea4a9379d526ade541a3e9ec777cb4",
  borrower: "0xaa34d20be3f9623ccf5bff53ef4dfa765c3f5dd5", collateral: "0x08efcc2f3e61185d0ea7f8830b3fec9bfa2ee313",
  loan: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", oracle: "0x28e82e7f25dbcd487af27c80de4f62553260feca",
  irm: "0x870ac11d48b15db9a138cf899d20f13f79ba00bc", lltv: "915000000000000000",
  curve: "0x7e19f0253a564e026c63eeaa9338d6dbddef3b09", weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  factory: "0x1f98431c8ad98523631ae4a59f267346ea31f984", quoter: "0x61ffe014ba17989e743c5f6cb21bf9697530b21e" });
const SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "reports/raw/fast/critical-snusd-usdc-delayed-20261018.json");
const SOURCE_FILES = ["tools/check-snusd-usdc-delayed.js", "tools/test/check-snusd-usdc-delayed.test.js",
  "tools/scan-morpho-blue-l.js", "tools/morpho-unwind-valuation.js", "tools/shared-rpc.js",
  "tools/lib/aave-v4-pinned-collection.js", "targets/morpho-blue/src/Morpho.sol",
  "targets/strata-contracts-2be97f9b/contracts/tranches/strategies/neutrl/IsNUSD.sol",
  "targets/strata-contracts-2be97f9b/contracts/test/neutrl/sNUSD.sol",
  "reports/raw/fast/liquidatable-unwind-triage-20261017.json"];
const iface = new ethers.Interface([
  "function idToMarketParams(bytes32) view returns(address,address,address,address,uint256)",
  "function market(bytes32) view returns(uint128,uint128,uint128,uint128,uint128,uint128)",
  "function position(bytes32,address) view returns(uint256,uint128,uint128)",
  "function borrowRate((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) view returns(uint256)",
  "function price() view returns(uint256)", "function asset() view returns(address)", "function decimals() view returns(uint8)",
  "function paused() view returns(bool)", "function cooldownDuration() view returns(uint24)",
  "function cooldowns(address) view returns(uint104,uint152)", "function silo() view returns(address)",
  "function totalAssets() view returns(uint256)", "function maxRedeem(address) view returns(uint256)",
  "function balanceOf(address) view returns(uint256)", "function previewRedeem(uint256) view returns(uint256)",
  "function redeem(uint256,address,address) returns(uint256)", "function coins(uint256) view returns(address)",
  "function balances(uint256) view returns(uint256)", "function get_dy(int128,int128,uint256) view returns(uint256)",
  "function getPool(address,address,uint24) view returns(address)", "function token0() view returns(address)", "function token1() view returns(address)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)"
]);
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function ceil(a, b) { if (a < 0n || b <= 0n) fail("MATH_INPUT_INVALID"); return (a + b - 1n) / b; }
function accrue(assets, rate, elapsed) {
  if ([assets, rate, elapsed].some(v => v < 0n)) fail("ACCRUAL_INPUT_INVALID");
  const first = rate * elapsed, second = first * first / (2n * WAD), third = second * first / (3n * WAD);
  return assets + assets * (first + second + third) / WAD;
}
function eligibility(row) {
  const debt = ceil(row.borrowerShares * (row.assets + 1n), row.shares + 1000000n);
  const maxBorrow = (row.collateral * row.price / SCALE) * row.lltv / WAD;
  return { debt, maxBorrow, eligible: debt > 0n && debt > maxBorrow };
}
function seizedBranch(row, seized) {
  if (row.assets < 0n || row.shares < row.borrowerShares || row.borrowerShares <= 0n || row.price <= 0n
      || row.lltv < 0n || row.lltv >= WAD || seized <= 0n || seized > row.collateral) fail("SEIZURE_INPUT_INVALID");
  const uncapped = WAD * WAD / (WAD - 300000000000000000n * (WAD - row.lltv) / WAD);
  const lif = uncapped < 1150000000000000000n ? uncapped : 1150000000000000000n;
  const quoted = ceil(seized * row.price, SCALE);
  const discounted = ceil(quoted * WAD, lif);
  const repaidShares = ceil(discounted * (row.shares + 1000000n), row.assets + 1n);
  const repaid = ceil(repaidShares * (row.assets + 1n), row.shares + 1000000n);
  return { seized, quoted, discounted, lif, repaidShares, repaid, feasible: repaidShares <= row.borrowerShares };
}
function sizes(row) {
  let low = 0n, high = row.collateral;
  while (low < high) { const mid = (low + high + 1n) / 2n; if (seizedBranch(row, mid).feasible) low = mid; else high = mid - 1n; }
  return [...new Set([100n, 500n, 1000n, 5000n, 10000n].map(bps => low * bps / 10000n).filter(v => v > 0n))].map(v => seizedBranch(row, v));
}
function pinEqual(a, b) { return !!a && !!b && stableObservation(a) === stableObservation(b); }
function margin({ repaid, quote, slippageBps = 100n, gasUsdc = null, waitSeconds = 604800n, aprBps = 1500n }) {
  if (repaid <= 0n || quote < 0n || slippageBps < 0n || slippageBps > 10000n || waitSeconds < 0n || aprBps < 0n) fail("COST_INPUT_INVALID");
  const gross = quote - repaid, slippage = ceil(quote * slippageBps, 10000n);
  const financing = ceil(repaid * aprBps * waitSeconds, 10000n * 31536000n);
  return { gross, slippage, financing, assumedGasUsdc: gasUsdc, assumedNet: gasUsdc === null ? null : gross - slippage - financing - gasUsdc,
    actualNet: null, waitSeconds, aprBps, slippageBps };
}
function sourceHashes() { return SOURCE_FILES.map(file => ({ file, sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, file))).digest("hex") })); }
function selectEndpoints() {
  const values = shared.loadRpcUrls({ maxCandidates: 96, preferredChainId: 1,
    candidateFilter: h => !!classifyOperatorFamily(h) && !shared.getOrigin(h) });
  const fallback = shared.PUBLIC_FALLBACKS[1], firstFamily = classifyOperatorFamily(fallback).operatorFamily;
  const hint = h => { const u = new URL(h); return /(?:^|[.-])(?:eth|ethereum|mainnet)(?:[.-]|$)/i.test(u.hostname)
    || /\/(?:eth|ethereum)(?:\/|$)/i.test(u.pathname); };
  const rest = values.filter(h => classifyOperatorFamily(h)?.operatorFamily !== firstFamily && hint(h));
  rest.sort((a, b) => Number(classifyOperatorFamily(b).capabilityRank === 2) - Number(classifyOperatorFamily(a).capabilityRank === 2));
  return [fallback, ...rest.slice(0, 1)];
}
function pinnedReader({ handle, pin, call }) {
  const tag = Object.freeze({ blockHash: pin.hash, requireCanonical: true });
  return {
    async view(to, method, args = []) {
      const raw = await call(handle, "eth_call", [{ to, data: iface.encodeFunctionData(method, args) }, tag], 5000, method);
      try { return Array.from(iface.decodeFunctionResult(method, raw)); } catch (_) { fail("ABI_DECODE_FAILED"); }
    },
    // Same eth_call sender context as scan-morpho-blue-l.js:614-628. This
    // simulates the protocol's IRM call; it does not sign or submit anything.
    async irmRate(params, market) {
      const raw = await call(handle, "eth_call", [{ from: B.morpho, to: B.irm,
        data: iface.encodeFunctionData("borrowRate", [params, market]) }, tag], 5000, "borrowRate");
      try { return iface.decodeFunctionResult("borrowRate", raw)[0]; } catch (_) { fail("ABI_DECODE_FAILED"); }
    },
    code: to => call(handle, "eth_getCode", [to, tag], 5000, "code"),
    storage: to => call(handle, "eth_getStorageAt", [to, SLOT, tag], 5000, "implementationSlot")
  };
}
async function capture(options = {}) {
  if (Object.keys(options).some(k => !["rpc", "endpoints", "now"].includes(k)) || options.endpoints && typeof options.rpc !== "function") fail("INVALID_OPTIONS");
  const now = options.now || Date.now, started = now(), before = sourceHashes();
  const result = { schema: "snusd-usdc-delayed-readonly/v1", chainId: 1, bindings: B, startedAt: new Date(started).toISOString(), finishedAt: null,
    status: "INCOMPLETE", blocker: null, pin: null, terminalCanonical: false, sourceCaptureAgeMs: null, finalizedHeaderLagSeconds: null,
    sources: before, sourceFilesUnchanged: false, position: null, vault: {}, curve: {}, runtimes: [], sizes: [], gas: null,
    permissions: "Caller must own seized shares and pass deployed restrictions; no funded liquidator or role suitability verified.",
    settlement: { actualPaidRaw: null, completeSequenceTested: false, totalQueueAndSettlementLatencySeconds: null, execution: "unknown", route: "unknown" },
    limits: { networkCalls: 100, batchMs: 120000, endpoints: 2, sizes: 5, timeoutMs: 5000, maxPinAgeSeconds: 1800 },
    ledger: [], networkCalls: 0, safety: { readOnly: true, transactions: 0, signing: false, broadcast: false, fundsAssumedAvailable: false, forkRun: false } };
  const endpoints = options.endpoints || selectEndpoints();
  let pin, phase = "QUALIFICATION";
  const ledger = createRpcLedger(async (handle, method, params, timeout, label) => {
    const record = { ordinal: result.ledger.length + 1, endpoint: endpoints.indexOf(handle) + 1, phase, method, label: label || method, outcome: "PENDING" };
    result.ledger.push(record);
    try {
      const raw = options.rpc ? await options.rpc(handle, method, params, timeout)
        : method === "eth_gasPrice" ? await shared.rpcCallStrict(handle, method, params, timeout) : await rpcRead(handle, method, params, timeout);
      if (raw === null || raw === undefined) fail("RPC_NULL_RESULT"); record.outcome = "OK"; return raw;
    } catch (e) { const code = ["CALL_EXCEPTION", "RPC_HTTP_REJECTED", "RPC_RATE_LIMITED", "RPC_REJECTED", "RPC_TRANSPORT", "RPC_NULL_RESULT"].includes(e?.code) ? e.code : "RPC_FAILED"; record.outcome = code; fail(code); }
  }, 100);
  async function call(handle, method, params, timeout = 5000, label = method) {
    if (!endpoints.includes(handle) || !["eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_getCode", "eth_getStorageAt", "eth_gasPrice"].includes(method)) fail("METHOD_REJECTED");
    const remaining = 120000 - (now() - started), reserve = phase === "TERMINAL" ? 0 : 11000;
    if (remaining <= reserve || ledger.networkCalls >= 100 - (phase === "TERMINAL" ? 0 : 2)) fail("BATCH_LIMIT");
    // Ledger counts physical requests; labels are local only, never RPC inputs.
    const index = result.ledger.length;
    try { return await ledger.call(handle, method, params, Math.min(timeout, remaining - reserve)); }
    finally { if (result.ledger[index]) result.ledger[index].label = label; }
  }
  try {
    if (endpoints.length !== 2 || new Set(endpoints.map(h => classifyOperatorFamily(h)?.operatorFamily).filter(Boolean)).size !== 2) fail("TWO_REVIEWED_FAMILIES_UNAVAILABLE");
    const finalized = [];
    for (const h of endpoints) {
      if (await call(h, "eth_chainId", []) !== "0x1") fail("WRONG_CHAIN");
      const header = normalizeHeader(await call(h, "eth_getBlockByNumber", ["finalized", false]));
      if (!header || now() / 1000 - Number(header.timestamp) > 1800 || Number(header.timestamp) > now() / 1000 + 60) fail("FINALIZED_HEADER_INVALID_OR_STALE");
      finalized.push(header);
    }
    const height = Math.min(...finalized.map(h => h.number)); const headers = [];
    for (const h of endpoints) headers.push(normalizeHeader(await call(h, "eth_getBlockByNumber", [ethers.toQuantity(height), false])));
    if (!headers[0] || headers[0].number !== height || !pinEqual(headers[0], headers[1])) fail("PIN_MISMATCH");
    pin = headers[0]; result.pin = { chainId: 1, ...pin, finality: "finalized", headerFamilies: 2, economicsStateFamilies: 1 };
    phase = "PINNED_READS";
    const readers = endpoints.map(handle => pinnedReader({ handle, pin, call })); const read = readers[0].view;
    const params = await read(B.morpho, "idToMarketParams", [B.marketId]);
    const tuple = [B.loan, B.collateral, B.oracle, B.irm, BigInt(B.lltv)];
    if (params.slice(0, 4).some((a, i) => a.toLowerCase() !== tuple[i]) || params[4] !== tuple[4]
        || ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "address", "address", "uint256"], params)) !== B.marketId) fail("MARKET_BINDING_MISMATCH");
    const market = await read(B.morpho, "market", [B.marketId]);
    const position = await read(B.morpho, "position", [B.marketId, B.borrower]);
    const price = (await read(B.oracle, "price"))[0];
    for (const [to, method, args, expected] of [[B.morpho, "idToMarketParams", [B.marketId], params], [B.morpho, "market", [B.marketId], market],
      [B.morpho, "position", [B.marketId, B.borrower], position], [B.oracle, "price", [], [price]]]) {
      if (stableObservation(await readers[1].view(to, method, args)) !== stableObservation(expected)) fail("CORE_STATE_DISAGREEMENT");
    }
    if (BigInt(pin.timestamp) < market[4] || price <= 0n) fail("ACCRUAL_OR_ORACLE_INVALID");
    result.coreObservation = { params, market, position, oraclePriceRaw: price, agreedFamilies: 2 };
    const rate = await readers[0].irmRate(params, market), elapsed = BigInt(pin.timestamp) - market[4];
    const row = { assets: accrue(market[2], rate, elapsed), shares: market[3], borrowerShares: position[1], collateral: position[2], price, lltv: params[4] };
    const health = eligibility(row);
    result.position = { market, position, borrowRateRaw: rate, elapsedSeconds: elapsed, ...row, ...health, coreStateFamilies: 2, accruedRateStateFamilies: 1 };
    if (!health.eligible || row.collateral <= 0n || health.debt < 1000000n) { result.status = "STOPPED_NOT_ELIGIBLE_OR_MATERIAL"; return result; }
    const underlying = (await read(B.collateral, "asset"))[0].toLowerCase();
    if (underlying === ethers.ZeroAddress) fail("UNDERLYING_INVALID");
    result.vault = { asset: underlying, shareDecimals: Number((await read(B.collateral, "decimals"))[0]),
      assetDecimals: Number((await read(underlying, "decimals"))[0]), loanDecimals: Number((await read(B.loan, "decimals"))[0]),
      paused: (await read(B.collateral, "paused"))[0], cooldownSeconds: (await read(B.collateral, "cooldownDuration"))[0],
      totalAssetsRaw: (await read(B.collateral, "totalAssets"))[0], maxRedeemMorphoRaw: (await read(B.collateral, "maxRedeem", [B.morpho]))[0],
      morphoCooldown: await read(B.collateral, "cooldowns", [B.morpho]), maxRedeemScope: "Morpho owner only; not a new liquidator cap" };
    if (result.vault.loanDecimals !== 6) fail("USDC_DECIMALS_MISMATCH");
    // Existing local public getter ABI, not an inferred address or exact-runtime source claim.
    try { result.vault.silo = (await read(B.collateral, "silo"))[0].toLowerCase(); }
    catch (e) { if (e.code !== "CALL_EXCEPTION") throw e; result.vault.silo = null; result.vault.siloBlocker = "EXISTING_GETTER_REVERTED"; }
    const coins = [];
    for (let i = 0; i < 2; i++) coins.push((await read(B.curve, "coins", [i]))[0].toLowerCase());
    const input = coins.indexOf(underlying), output = coins.indexOf(B.loan);
    if (input < 0 || output < 0 || input === output) fail("CURVE_COIN_BINDING_MISMATCH");
    result.curve = { address: B.curve, coins, inputIndex: input, outputIndex: output, balancesRaw: [], actualTokenBalancesRaw: [] };
    for (let i = 0; i < 2; i++) {
      result.curve.balancesRaw.push((await read(B.curve, "balances", [i]))[0]);
      result.curve.actualTokenBalancesRaw.push((await read(coins[i], "balanceOf", [B.curve]))[0]);
    }
    result.vault.underlyingAtVaultRaw = (await read(underlying, "balanceOf", [B.collateral]))[0];
    if (result.vault.silo) result.vault.underlyingAtSiloRaw = (await read(underlying, "balanceOf", [result.vault.silo]))[0];
    for (const to of [...new Set([B.morpho, B.collateral, B.loan, B.oracle, B.irm, B.curve, underlying, result.vault.silo].filter(Boolean))]) {
      const code = await readers[0].code(to), slot = await readers[0].storage(to);
      if (!/^0x(?:[a-f0-9]{2})+$/i.test(code) || !/^0x[a-f0-9]{64}$/i.test(slot)) fail("RUNTIME_CAPTURE_INVALID");
      const implementation = ethers.getAddress("0x" + slot.slice(-40));
      const runtime = { address: to, runtimeKeccak256: ethers.keccak256(code), bytes: (code.length - 2) / 2, eip1967Implementation: implementation,
        proxyInterpretation: implementation === ethers.ZeroAddress ? "ZERO_EIP1967_SLOT_NOT_PROOF_NONPROXY" : "EIP1967_IMPLEMENTATION_OBSERVED", exactSourceEquivalent: false };
      if (implementation !== ethers.ZeroAddress) runtime.implementationRuntimeKeccak256 = ethers.keccak256(await readers[0].code(implementation));
      result.runtimes.push(runtime);
    }
    for (const amount of sizes(row)) {
      const preview = (await read(B.collateral, "previewRedeem", [amount.seized]))[0];
      const quote = (await read(B.curve, "get_dy", [input, output, preview]))[0];
      result.sizes.push({ ...amount, previewUnderlyingRaw: preview, quoteUsdcRaw: quote, grossQuoteMarginUsdcRaw: quote - amount.repaid,
        quotePinHash: pin.hash, previewIsPaidCash: false, actualPaidCashRaw: null });
    }
    if (result.vault.cooldownSeconds > 0n && result.sizes.length) {
      try { await read(B.collateral, "redeem", [result.sizes[0].seized, B.morpho, B.morpho]); result.vault.directRedeemModel = "CALL_RETURNED_NOT_CASH_MOVEMENT"; }
      catch (e) { if (e.code !== "CALL_EXCEPTION") throw e; result.vault.directRedeemModel = "EVM_REVERT_NOT_PAID_SETTLEMENT"; }
    }
    result.gas = { observedAt: new Date(now()).toISOString(), gasPriceWei: null, wethUsdcPerEthRaw: null, projectedUsdcRaw: null,
      assumptions: { transactions: 6, totalGasUnits: 1350000, gasPriceMultiplier: 2, includes: "liquidate,cooldown,unstake,sale,two approvals", measuredExecutionGas: false } };
    const gasPrice = BigInt(await call(endpoints[0], "eth_gasPrice", [], 5000)); result.gas.gasPriceWei = gasPrice;
    result.gas.observedAt = new Date(now()).toISOString();
    const wethPool = (await read(B.factory, "getPool", [B.weth, B.loan, 500]))[0].toLowerCase();
    if (wethPool === ethers.ZeroAddress) fail("GAS_CONVERSION_POOL_UNAVAILABLE");
    const wethCoins = [(await read(wethPool, "token0"))[0].toLowerCase(), (await read(wethPool, "token1"))[0].toLowerCase()];
    if (!wethCoins.includes(B.weth) || !wethCoins.includes(B.loan)) fail("GAS_CONVERSION_IDENTITY_MISMATCH");
    const conversion = (await read(B.quoter, "quoteExactInputSingle", [[B.weth, B.loan, WAD, 500, 0]]))[0];
    if (conversion <= 0n || gasPrice <= 0n) fail("GAS_PROJECTION_INVALID");
    result.gas.wethUsdcPerEthRaw = conversion; result.gas.conversionPool = wethPool; result.gas.conversionPinHash = pin.hash;
    result.gas.projectedUsdcRaw = ceil(gasPrice * 1350000n * 2n * conversion, WAD);
    for (const size of result.sizes) {
      size.costSensitivities = [[3600n, 500n], [86400n, 1500n], [604800n, 1500n], [1209600n, 3000n]].map(([waitSeconds, aprBps]) => ({
        scenario: "ASSUMED_WAIT_APR_NOT_MEASURED_LATENCY", ...margin({ repaid: size.repaid, quote: size.quoteUsdcRaw,
          gasUsdc: result.gas.projectedUsdcRaw, waitSeconds: waitSeconds > result.vault.cooldownSeconds ? waitSeconds : result.vault.cooldownSeconds, aprBps }) }));
    }
    result.status = "PINNED_VIEW_ECONOMICS_ONLY";
  } catch (e) { result.blocker = /^[A-Z][A-Z0-9_]{0,70}$/.test(e.code || "") ? e.code : "CAPTURE_FAILED"; }
  finally {
    phase = "TERMINAL";
    if (pin) {
      let terminal = true;
      for (const h of endpoints) { try { const header = normalizeHeader(await call(h, "eth_getBlockByNumber", [ethers.toQuantity(pin.number), false])); if (!pinEqual(pin, header)) terminal = false; } catch (_) { terminal = false; } }
      result.terminalCanonical = terminal;
      if (!terminal) { result.status = "INCOMPLETE"; result.blocker = "TERMINAL_PIN_UNCONFIRMED"; }
      result.finalizedHeaderLagSeconds = Math.floor(now() / 1000) - Number(pin.timestamp);
    }
    result.finishedAt = new Date(now()).toISOString(); result.sourceCaptureAgeMs = now() - started; result.networkCalls = ledger.networkCalls;
    if (result.sourceCaptureAgeMs > 120000 || result.finalizedHeaderLagSeconds > 1800) { result.status = "INCOMPLETE"; result.blocker = "CAPTURE_OR_PIN_STALE"; }
    result.sourceFilesUnchanged = stableObservation(before) === stableObservation(sourceHashes());
    if (!result.sourceFilesUnchanged) { result.status = "INCOMPLETE"; result.blocker = "SOURCE_FILES_CHANGED"; }
  }
  return result;
}
function serialize(value) { return JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n"; }
async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] !== "--run") fail("EXPLICIT_RUN_REQUIRED");
  if (fs.existsSync(OUT)) fail("CAPTURE_ALREADY_EXISTS_NO_SECOND_BATCH");
  const result = await capture(); const bytes = serialize(result);
  if (/(?:https?|wss?):\/\/|authorization\s*:|bearer\s|api[_-]?key|\.env\b/i.test(bytes)) fail("OUTPUT_LEAK_REJECTED");
  fs.writeFileSync(OUT, bytes, { flag: "wx", mode: 0o600 });
  process.stdout.write(serialize({ status: result.status, blocker: result.blocker, networkCalls: result.networkCalls, output: path.relative(ROOT, OUT) }));
}
if (require.main === module) main().catch(e => { process.stderr.write((/^[A-Z][A-Z0-9_]+$/.test(e.code || "") ? e.code : "CHECK_FAILED") + "\n"); process.exitCode = 1; });
module.exports = Object.freeze({ B, iface, ceil, accrue, eligibility, seizedBranch, sizes, margin, pinEqual, pinnedReader, capture, main, serialize });
