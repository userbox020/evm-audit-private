#!/usr/bin/env node
"use strict";

// One borrower, <=5 exact seizure sizes, one retained exit route. No transaction
// builder, state override, executor or discovery service. Import is inert.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const shared = require("./shared-rpc");
const preflight = require("./lib/common-finalized-rpc-preflight");
const { rpcRead } = require("./lib/aave-v4-pinned-collection");
const { accruedBorrowAssets, toAssetsUp, maxBorrowAssets } = require("./scan-morpho-blue-l");

const B = Object.freeze({ chainId: 1,
  morpho: "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb",
  marketId: "0xd2630c0ebf33ba83c82e8cd400a8e6345370238ca695ce58773b2d3e43de1b0a",
  borrower: "0x14bcd9da052cdc6fe0b9446d5a616d5b7b4d4550",
  collateral: "0x657d9aba1dbb59e53f9f3ecaa878447dcfc96dcb",
  loan: "0x64351fc9810adad17a690e4e1717df5e7e085160",
  oracle: "0xc28f86c86f79282e2d2a1f45442339c55f7eb22d",
  irm: "0x870ac11d48b15db9a138cf899d20f13f79ba00bc",
  lltv: 915000000000000000n,
  weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  curve: "0xa4c567c662349bec3d0fb94c4e7f85ba95e208e4",
  diagnosticOwner: "0x0000000000000000000000000000000000000001",
});
const LIMITS = Object.freeze({ requests: 100, endpoints: 2, maxMs: 120000, timeoutMs: 4000,
  terminalRequests: 2, terminalMs: 10000, maxPinAgeMs: 1800000, sizes: 5 });
const WAD = 10n ** 18n, SCALE = 10n ** 36n, VIRTUAL_SHARES = 1000000n;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const I = Object.freeze({
  morpho: new ethers.Interface([
    "function idToMarketParams(bytes32) view returns(address,address,address,address,uint256)",
    "function market(bytes32) view returns(uint128,uint128,uint128,uint128,uint128,uint128)",
    "function position(bytes32,address) view returns(uint256,uint128,uint128)",
  ]),
  irm: new ethers.Interface(["function borrowRate((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) returns(uint256)"]),
  oracle: new ethers.Interface(["function price() view returns(uint256)"]),
  token: new ethers.Interface(["function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)"]),
  vault: new ethers.Interface(["function asset() view returns(address)", "function totalAssets() view returns(uint256)",
    "function totalSupply() view returns(uint256)", "function maxRedeem(address) view returns(uint256)",
    "function maxWithdraw(address) view returns(uint256)", "function previewRedeem(uint256) view returns(uint256)",
    "function cooldownDuration() view returns(uint256)", "function redeem(uint256,address,address) returns(uint256)"]),
  curve: new ethers.Interface(["function coins(uint256) view returns(address)",
    "function get_dy(int128,int128,uint256) view returns(uint256)",
    "function get_dy(uint256,uint256,uint256) view returns(uint256)"]),
});
class CheckError extends Error {
  constructor(code) { const safe = /^[A-Z][A-Z0-9_]{0,70}$/.test(code || "") ? code : "CHECK_UNAVAILABLE"; super(safe); this.code = safe; }
}
function fail(code) { throw new CheckError(code); }
function address(value) { try { return ethers.getAddress(value).toLowerCase(); } catch (_) { fail("ADDRESS_INVALID"); } }
const ceil = (a, b) => { if (a < 0n || b <= 0n) fail("ARITHMETIC_INVALID"); return (a + b - 1n) / b; };
function lif(lltv) {
  if (lltv < 0n || lltv >= WAD) fail("LLTV_INVALID");
  const value = WAD * WAD / (WAD - 300000000000000000n * (WAD - lltv) / WAD);
  return value < 1150000000000000000n ? value : 1150000000000000000n;
}
function partialAmounts(state, seized) {
  const { collateral, borrowerShares, assets, shares, price, lltv } = state;
  if (seized <= 0n || seized > collateral || price <= 0n || assets < 0n || shares < borrowerShares || borrowerShares <= 0n) fail("SEIZURE_NOT_FEASIBLE");
  const incentive = lif(lltv);
  // Morpho.sol:371-381, each ceil is separate; NEVER scale a full repayment.
  const collateralValueUp = ceil(seized * price, SCALE);
  const repaymentValueUp = ceil(collateralValueUp * WAD, incentive);
  const repaidShares = ceil(repaymentValueUp * (shares + VIRTUAL_SHARES), assets + 1n);
  if (repaidShares > borrowerShares) fail("SEIZURE_EXCEEDS_BORROWER_SHARES");
  return { seizedRaw: seized, collateralValueUpRaw: collateralValueUp,
    repaymentValueUpRaw: repaymentValueUp, repaidSharesRaw: repaidShares,
    repayRaw: ceil(repaidShares * (assets + 1n), shares + VIRTUAL_SHARES), lifRaw: incentive };
}
function feasibleSeizure(state) {
  if (state.price <= 0n || state.shares < state.borrowerShares || state.assets < 0n) fail("ARITHMETIC_INVALID");
  // Exact inverse of the three ceil constraints in the seizedAssets branch.
  const debtDown = state.borrowerShares * (state.assets + 1n) / (state.shares + VIRTUAL_SHARES);
  const cap = (debtDown * lif(state.lltv) / WAD) * SCALE / state.price;
  return cap < state.collateral ? cap : state.collateral;
}
function chooseSizes(state, ownerCap) {
  const maximum = feasibleSeizure(state);
  const anchors = ownerCap !== null && ownerCap > 0n
    ? [["half_observed_morpho_owner_cap", ownerCap / 2n], ["observed_morpho_owner_cap", ownerCap],
      ["one_percent_feasible", maximum / 100n], ["ten_percent_feasible", maximum / 10n], ["maximum_feasible", maximum]]
    : [["one_per_mille_feasible", maximum / 1000n], ["one_percent_feasible", maximum / 100n],
      ["ten_percent_feasible", maximum / 10n], ["half_feasible", maximum / 2n], ["maximum_feasible", maximum]];
  const seen = new Set(), accepted = [], rejected = [];
  for (const [anchor, size] of anchors) {
    if (size <= 0n || size > maximum || seen.has(size.toString())) { rejected.push({ anchor, seizedRaw: size, reason: size <= 0n ? "ZERO" : size > maximum ? "EXCEEDS_PROTOCOL_CAP" : "DUPLICATE" }); continue; }
    seen.add(size.toString()); accepted.push({ anchor, ...partialAmounts(state, size) });
  }
  return { maximumRaw: maximum, ownerCapHeuristicOnly: true, accepted, rejected };
}
function verifyMarket(params) {
  const normalized = [address(params[0]), address(params[1]), address(params[2]), address(params[3]), BigInt(params[4])];
  const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "address", "address", "uint256"], normalized));
  if (id !== B.marketId || normalized[0] !== B.loan || normalized[1] !== B.collateral
    || normalized[2] !== B.oracle || normalized[3] !== B.irm || normalized[4] !== B.lltv) fail("MARKET_BINDING_MISMATCH");
  return normalized;
}
function defaultCandidates() {
  const families = new Set();
  return shared.loadRpcUrls({ maxCandidates: 2, preferredChainId: 1, candidateFilter: handle => {
    const family = preflight.classifyOperatorFamily(handle);
    if (!family || shared.getOrigin(handle) || families.has(family.operatorFamily)) return false;
    families.add(family.operatorFamily); return true;
  } }).map(handle => ({ handle, operatorFamily: preflight.classifyOperatorFamily(handle).operatorFamily }));
}
async function defaultRpc(handle, method, params, timeout) {
  if (method === "eth_gasPrice") {
    const value = await shared.rpcCallStrict(handle, method, params, timeout);
    if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) fail("GAS_PROJECTION_UNAVAILABLE");
    return value;
  }
  return rpcRead(handle, method, params, timeout, { maxBytes: 1024 * 1024 });
}

async function check(options = {}) {
  const now = options.now || Date.now, started = now();
  const requestLedger = [], failures = [], contracts = [], rows = [];
  let pin = null, admitted = null, sealed = false, phase = "QUALIFICATION", transportFailed = false, budgetFailed = false;
  let projection = null, gasConversion = null, eligibility = null, sizing = null, observations = {};
  const candidates = (options.candidates || defaultCandidates()).slice(0, LIMITS.endpoints);
  const rpc = options.rpc || defaultRpc;
  const ledger = preflight.createRpcLedger(async (handle, method, params, requestedTimeout) => {
    const remaining = LIMITS.maxMs - (now() - started);
    if (remaining <= 0) fail("READ_BATCH_DEADLINE");
    const entry = { sequence: requestLedger.length + 1, endpoint: candidates.findIndex(row => row.handle === handle) + 1,
      method, phase, at: new Date(now()).toISOString(), status: "PENDING" };
    requestLedger.push(entry);
    try {
      const result = await rpc(handle, method, params, Math.min(LIMITS.timeoutMs, requestedTimeout || LIMITS.timeoutMs, remaining));
      entry.status = "RETURNED"; return result;
    } catch (error) {
      entry.status = error?.code === "CALL_EXCEPTION" ? "EVM_REVERT" : "UNAVAILABLE";
      if (error?.code !== "CALL_EXCEPTION" && phase === "OBSERVATION") transportFailed = true;
      throw new CheckError(error?.code === "CALL_EXCEPTION" ? "CALL_EXCEPTION" : "RPC_UNAVAILABLE");
    } finally { entry.elapsedMs = now() - Date.parse(entry.at); }
  }, LIMITS.requests);
  const ensure = () => {
    if (sealed) fail("READ_CONTEXT_CLOSED");
    if (transportFailed) fail("TRANSPORT_FAILURE_RETAINED");
    if (ledger.networkCalls >= LIMITS.requests - LIMITS.terminalRequests || now() - started >= LIMITS.maxMs - LIMITS.terminalMs) { budgetFailed = true; fail("OBSERVATION_BUDGET_EXHAUSTED"); }
  };
  const stateRead = async (method, params) => { ensure(); return ledger.call(admitted.selected[0].candidate.handle, method, params, LIMITS.timeoutMs); };
  const call = async (target, iface, name, args = [], from) => {
    const transaction = { to: address(target), data: iface.encodeFunctionData(name, args), ...(from ? { from: address(from) } : {}) };
    const raw = await stateRead("eth_call", [transaction, { blockHash: pin.hash, requireCanonical: true }]);
    try { return iface.decodeFunctionResult(name, raw); } catch (_) { fail("VIEW_DECODE_FAILED"); }
  };
  const optional = async operation => {
    try { return { status: "OBSERVED", value: await operation() }; }
    catch (error) { return { status: error?.code === "CALL_EXCEPTION" ? "REVERT" : "UNAVAILABLE", value: null, reason: error?.code || "VIEW_UNAVAILABLE" }; }
  };
  const runtime = async target => {
    const to = address(target), at = { blockHash: pin.hash, requireCanonical: true };
    const code = await stateRead("eth_getCode", [to, at]);
    if (!/^0x(?:[0-9a-f]{2})+$/i.test(code || "")) fail("RUNTIME_UNAVAILABLE");
    const slot = await stateRead("eth_getStorageAt", [to, IMPL_SLOT, at]);
    if (!/^0x[0-9a-f]{64}$/i.test(slot || "")) fail("PROXY_BINDING_UNAVAILABLE");
    const record = { address: to, codeHash: ethers.keccak256(code), eip1967Implementation: null, implementationCodeHash: null,
      reviewedSourceEquivalence: "UNKNOWN", otherProxyForms: "UNKNOWN" };
    if (!/^0x0{64}$/i.test(slot)) {
      record.eip1967Implementation = address(`0x${slot.slice(-40)}`);
      const impl = await stateRead("eth_getCode", [record.eip1967Implementation, at]);
      if (!/^0x(?:[0-9a-f]{2})+$/i.test(impl || "")) fail("IMPLEMENTATION_CODE_UNAVAILABLE");
      record.implementationCodeHash = ethers.keccak256(impl);
    }
    contracts.push(record);
  };
  let curveIndices = null;
  const curveQuote = async amount => {
    ensure();
    if (!curveIndices || amount <= 0n) return { status: "UNBOUND_OR_ZERO_INPUT", value: null };
    for (const signature of ["get_dy(int128,int128,uint256)", "get_dy(uint256,uint256,uint256)"]) {
      const result = await optional(async () => (await call(B.curve, I.curve, signature, [...curveIndices, amount]))[0]);
      if (result.status === "OBSERVED") return result.value > 0n ? result : { status: "ZERO_QUOTE", value: null };
      if (result.status !== "REVERT") return result;
    }
    return { status: "REVERT", value: null };
  };
  try {
    admitted = await preflight.qualifyCommonFinalized({ chainId: 1, candidates, minimumFamilies: 2, preferredFamilies: 2, rpc: ledger,
      logCanaryAddress: B.morpho, limits: { maxCandidates: 2, maxProbeCallsPerCandidate: 4, reserveRequests: 70, retries: 0 },
      probe: async ({ reader }) => {
        const code = await reader.getCode(B.morpho), slot = await reader.getStorageAt(B.morpho, IMPL_SLOT);
        const value = await reader.call({ to: B.morpho, data: I.morpho.encodeFunctionData("idToMarketParams", [B.marketId]) });
        if (code === "0x") fail("MORPHO_CODE_UNAVAILABLE");
        verifyMarket(I.morpho.decodeFunctionResult("idToMarketParams", value));
        return { codeHash: ethers.keccak256(code), slot, value };
      } });
    pin = admitted.pin; phase = "OBSERVATION";
    if (now() - Number(pin.timestamp) * 1000 < 0 || now() - Number(pin.timestamp) * 1000 > LIMITS.maxPinAgeMs) fail("FINALIZED_PIN_STALE");
    // Retain every successful core view immediately, even if a later required
    // rate/accrual read fails. Unavailable accrual is not a zero-rate estimate.
    observations.params = [...await call(B.morpho, I.morpho, "idToMarketParams", [B.marketId])];
    const params = verifyMarket(observations.params);
    const market = [...await call(B.morpho, I.morpho, "market", [B.marketId])];
    observations.marketStored = market;
    const position = [...await call(B.morpho, I.morpho, "position", [B.marketId, B.borrower])];
    observations.position = position;
    if (market[4] === 0n || market[4] > BigInt(pin.timestamp)) fail("MARKET_TIMESTAMP_INVALID");
    const [price] = await call(B.oracle, I.oracle, "price");
    observations.oraclePriceRaw = price;
    observations.oracleFreshnessAndDenomination = "UNKNOWN_PROTOCOL_HEALTH_ONLY";
    if (price <= 0n) fail("ORACLE_PRICE_INVALID");
    const elapsed = BigInt(pin.timestamp) - market[4];
    observations.elapsedSeconds = elapsed;
    observations.borrowRateRead = { caller: B.morpho, status: "NOT_REQUIRED" };
    let rate = 0n;
    if (elapsed > 0n && market[2] > 0n) {
      try {
        // AdaptiveCurveIRM is Morpho-caller gated, just as in the existing scanner.
        rate = (await call(B.irm, I.irm, "borrowRate", [params, market], B.morpho))[0];
        observations.borrowRateRead.status = "OBSERVED";
      } catch (error) {
        observations.borrowRateRead.status = error?.code === "CALL_EXCEPTION" ? "REVERT" : "UNAVAILABLE";
        if (error?.code === "CALL_EXCEPTION") fail("IRM_BORROW_RATE_REVERT");
        throw error;
      }
    }
    observations.ratePerSecondRaw = rate;
    const accrued = accruedBorrowAssets({ totalBorrowAssets: market[2], borrowRate: rate, elapsedSeconds: elapsed });
    observations.totalBorrowAssetsAccruedRaw = accrued;
    const state = { collateral: position[2], borrowerShares: position[1], assets: accrued, shares: market[3], price, lltv: params[4] };
    const debt = toAssetsUp(position[1], accrued, market[3]), maxBorrow = maxBorrowAssets(position[2], price, params[4]);
    eligibility = { eligible: position[1] > 0n && debt > maxBorrow, settled: position[1] === 0n,
      zeroCollateral: position[2] === 0n, debtRaw: debt, maxBorrowRaw: maxBorrow };
    // Healthy/settled: no exit/funding economics dispatch for this borrower.
    if (eligibility.eligible && !eligibility.zeroCollateral) {
      for (const target of [B.morpho, B.collateral, B.loan, B.oracle, B.irm, B.weth, B.curve]) await runtime(target);
      const [asset] = await call(B.collateral, I.vault, "asset");
      if (address(asset) !== B.weth) fail("UNDERLYING_BINDING_MISMATCH");
      observations.decimals = {};
      for (const [name, target] of [["collateral", B.collateral], ["loan", B.loan], ["underlying", B.weth]]) observations.decimals[name] = Number((await call(target, I.token, "decimals"))[0]);
      if (observations.decimals.underlying !== 18) fail("WETH_DECIMALS_MISMATCH");
      observations.totalAssets = await optional(async () => (await call(B.collateral, I.vault, "totalAssets"))[0]);
      observations.totalSupply = await optional(async () => (await call(B.collateral, I.vault, "totalSupply"))[0]);
      observations.freeUnderlyingAtVault = await optional(async () => (await call(B.weth, I.token, "balanceOf", [B.collateral]))[0]);
      observations.fundingBalanceAtMorpho = await optional(async () => (await call(B.loan, I.token, "balanceOf", [B.morpho]))[0]);
      observations.cooldown = await optional(async () => (await call(B.collateral, I.vault, "cooldownDuration"))[0]);
      observations.ownerContexts = [];
      for (const [label, owner] of [["existing_morpho_holder", B.morpho], ["borrower_address", B.borrower], ["unfunded_diagnostic_not_executor", B.diagnosticOwner]]) {
        const balance = await optional(async () => (await call(B.collateral, I.token, "balanceOf", [owner]))[0]);
        const maxRedeem = await optional(async () => (await call(B.collateral, I.vault, "maxRedeem", [owner], owner))[0]);
        const maxWithdraw = await optional(async () => (await call(B.collateral, I.vault, "maxWithdraw", [owner], owner))[0]);
        observations.ownerContexts.push({ label, owner, balance, maxRedeem, maxWithdraw });
      }
      const coin0 = address((await call(B.curve, I.curve, "coins", [0]))[0]);
      const coin1 = address((await call(B.curve, I.curve, "coins", [1]))[0]);
      if (coin0 === B.weth && coin1 === B.loan) curveIndices = [0, 1];
      else if (coin1 === B.weth && coin0 === B.loan) curveIndices = [1, 0];
      else fail("CURVE_IDENTITY_MISMATCH");
      observations.curve = { address: B.curve, coins: [coin0, coin1], indices: curveIndices };
      const observedCap = observations.ownerContexts[0].maxRedeem.value;
      sizing = chooseSizes(state, observedCap); // Freeze/dedupe all sizes BEFORE amount-specific quotes.
      const gas = await optional(async () => {
        ensure(); const at = new Date(now()).toISOString();
        const value = await ledger.call(admitted.selected[0].candidate.handle, "eth_gasPrice", [], LIMITS.timeoutMs);
        if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value) || BigInt(value) <= 0n) fail("GAS_PROJECTION_UNAVAILABLE");
        return { observedAt: at, method: "eth_gasPrice", priceWei: BigInt(value), gasUnitsAssumption: 1500000n, pinned: false };
      });
      projection = gas.value;
      if (projection) gasConversion = await curveQuote(projection.priceWei * projection.gasUnitsAssumption);
      for (const size of sizing.accepted) {
        const preview = await optional(async () => (await call(B.collateral, I.vault, "previewRedeem", [size.seizedRaw]))[0]);
        const quote = preview.status === "OBSERVED" && preview.value > 0n ? await curveQuote(preview.value) : { status: "PREVIEW_UNAVAILABLE", value: null };
        // Read-only eth_call in the existing holder/caller context, no overrides.
        // A return value is NOT a token transfer receipt or future-owner proof.
        const directCall = await optional(async () => (await call(B.collateral, I.vault, "redeem", [size.seizedRaw, B.morpho, B.morpho], B.morpho))[0]);
        const margin = quote.value === null ? null : quote.value - size.repayRaw;
        const slippage = quote.value === null ? null : ceil(quote.value * 100n, 10000n);
        rows.push({ ...size, route: "ERC4626_preview_to_WETH_then_retained_Curve_to_msETH",
          previewUnderlying: preview, exitQuote: quote, exitQuoteRaw: quote.value, rawMargin: margin,
          slippageAssumptionBps: 100, slippageAllowanceRaw: slippage,
          gasAllowanceLoanRaw: gasConversion?.value ?? null,
          estimatedNetBeforeUnknownFundingFeesRaw: margin === null || gasConversion?.value == null ? null : margin - slippage - gasConversion.value,
          netRaw: null, netStatus: "UNKNOWN_UNMEASURED_FULL_PATH_AND_FUNDING_FEES",
          directRedeemEthCall: { ...directCall, owner: B.morpho, receiver: B.morpho, caller: B.morpho, transferReceipt: false },
          withinObservedMorphoOwnerCap: observedCap === null ? "UNKNOWN" : size.seizedRaw <= observedCap,
          newOwnerCapacity: "UNKNOWN_NOT_TESTED_BY_UNFUNDED_OWNER_LIMIT",
          freeVaultBalanceCoversPreview: preview.value === null || observations.freeUnderlyingAtVault.value === null ? "UNKNOWN" : observations.freeUnderlyingAtVault.value >= preview.value,
          fundingBalanceCoversPrincipal: observations.fundingBalanceAtMorpho.value === null ? "UNKNOWN" : observations.fundingBalanceAtMorpho.value >= size.repayRaw,
          fundingExecutionAndFeeProof: "UNKNOWN", redemptionCashProof: "UNKNOWN", routePositive: "unknown", executableNow: "unknown", signedActionJustified: false });
      }
    }
  } catch (error) { failures.push(error instanceof CheckError || error instanceof preflight.PreflightError ? error.code : "CHECK_UNAVAILABLE"); }
  finally {
    sealed = true; phase = "TERMINAL";
    if (admitted) for (const selected of admitted.selected) {
      const result = await optional(async () => {
        const header = preflight.normalizeHeader(await ledger.call(selected.candidate.handle, "eth_getBlockByNumber", [`0x${pin.number.toString(16)}`, false], LIMITS.timeoutMs));
        if (!header || JSON.stringify(header) !== JSON.stringify(pin)) fail("TERMINAL_PIN_MISMATCH");
        return true;
      });
      if (result.value !== true) failures.push("TERMINAL_CANONICALITY_UNAVAILABLE");
    }
  }
  const published = now(), pinAgeMs = pin ? published - Number(pin.timestamp) * 1000 : null;
  if (pin && (pinAgeMs < 0 || pinAgeMs > LIMITS.maxPinAgeMs)) failures.push("FINALIZED_PIN_STALE");
  if (published - started > LIMITS.maxMs) failures.push("READ_BATCH_DEADLINE");
  if (transportFailed) failures.push("TRANSPORT_FAILURE_RETAINED");
  if (budgetFailed) failures.push("OBSERVATION_BUDGET_EXHAUSTED");
  if (projection && (published - Date.parse(projection.observedAt) < 0 || published - Date.parse(projection.observedAt) > 60000)) {
    for (const row of rows) { row.estimatedNetBeforeUnknownFundingFeesRaw = null; row.gasAllowanceLoanRaw = null; }
    gasConversion = { status: "GAS_PROJECTION_STALE", value: null };
  }
  const plausible = failures.length ? null : rows.find(row => row.rawMargin !== null && row.rawMargin > 0n
    && (row.estimatedNetBeforeUnknownFundingFeesRaw === null || row.estimatedNetBeforeUnknownFundingFeesRaw > 0n)
    && row.directRedeemEthCall.status === "OBSERVED" && row.freeVaultBalanceCoversPreview === true
    && row.fundingBalanceCoversPrincipal === true);
  const forkProposal = plausible ? { status: "PROPOSED_ONLY_PARENT_APPROVAL_REQUIRED", chainId: 1, pin,
    marketId: B.marketId, borrower: B.borrower, seizedRaw: plausible.seizedRaw, expectedRepayRaw: plausible.repayRaw,
    exitRoute: [B.collateral, B.weth, B.loan], retainedPool: B.curve,
    scope: "One normal permissionless liquidation, actual-owner redemption and retained-pool swap on an untouched-state local fork; measure real token deltas and total costs",
    constraints: "No state overrides, no source changes, no upstream mutation; new-owner capacity/funding fees still unknown; build/run not authorized here" } : null;
  return { schema: "ynethx-mseth-partial/v1", agentId: "ynethx-economics-20261018", validationOwner: "orchestrator",
    signal: "ORDINARY_PERMISSIONLESS_LIQUIDATION_ECONOMICS_READ_ONLY", evidenceStage: "VIEW_OBSERVATION_NOT_EXECUTION",
    status: failures.length ? "UNAVAILABLE" : eligibility?.eligible ? "PINNED_CONDITIONAL_OBSERVATIONS" : "PINNED_NOT_CURRENTLY_ELIGIBLE",
    captureStartedAt: new Date(started).toISOString(), generatedAt: new Date(published).toISOString(),
    pin: pin ? { chainId: 1, ...pin, finality: "finalized", ageMs: pinAgeMs } : null,
    currentValidated: Boolean(admitted) && failures.length === 0, terminalCanonicality: admitted && !failures.includes("TERMINAL_CANONICALITY_UNAVAILABLE") ? "CONFIRMED_TWO_HEADERS" : "UNKNOWN",
    stateStrength: "SINGLE_PRIMARY_TWO_HEADER_AND_MARKET_PROBE_FAMILIES", bindings: B, eligibility, observations, sizing, projection, gasConversion, rows,
    failures: [...new Set(failures)], contracts, limits: LIMITS,
    requestLedger, networkRequests: ledger.networkCalls, elapsedMs: published - started,
    directDexRoute: { status: "NOT_IDENTIFIED_NOT_QUOTED", reason: "No retained ynETHx/WETH pool identity; no invented pool or discovery sweep" },
    limitations: ["MaxRedeem(Morpho) is owner-specific, not proven global/new-liquidator capacity",
      "Seized collateral transfers to liquidator before callback; diagnostic unfunded-owner zero limit is not universal disproof",
      "ERC4626 preview and redeem eth_call return do not prove executable cash receipt or full-path settlement",
      "Code hashes/proxy slot observations do not establish reviewed-source equivalence; cooldown/global liquidity remain unqualified",
      "Funding balance is principal coverage only, not flash capacity/callback/fee proof; no own-wallet capital inquiry",
      "Gas units and slippage are unmeasured assumptions; no USD valuation or realized/executable profit claim",
      "At most five fixed sizes and one retained exit route; failed quotes are unavailable, not zero proceeds"],
    forkProposal,
    nextValidation: forkProposal ? "Single bounded normal-flow local validation proposed, NOT built/run; parent gates dependent lane"
      : "STOP: no tested size combines plausible margin/cost with observed holder-context redemption and identified cash/funding; other owners/routes remain unknown",
    routePositive: "unknown", routeDisposition: "UNKNOWN", executableNow: "unknown", signedActionJustified: false,
    historicalEvidence: { path: "reports/raw/fast/liquidatable-unwind-triage-20261017.json", pin: 26216409,
      hash: "0x27b0bd844b1c28f1c2b2f2f0c2d0c745b4eacd42a3588b9eb640d752e79666e5", role: "HISTORICAL_ONLY_NOT_RESTAMPED" } };
}

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "reports/raw/fast/atomic-ynethx-mseth-partial-20261018.json");
const REPORT = path.join(ROOT, "reports/atomic-ynethx-mseth-partial-20261018.md");
const stringify = value => JSON.stringify(value, (_key, child) => typeof child === "bigint" ? child.toString() : child, 2);
function report(artifact) {
  const lines = ["# ynETHx/msETH partial-size economics", "", "Signal: ordinary permissionless liquidation economics; read-only, not vulnerability exploitation.",
    `Status: **${artifact.status}**. Route/executable UNKNOWN; no realized or executable-profit claim.`,
    `Capture: ${artifact.generatedAt}; pin: ${artifact.pin?.number ?? "unknown"} / ${artifact.pin?.hash ?? "unknown"}.`,
    `Requests: ${artifact.networkRequests}/100; elapsed ${artifact.elapsedMs} ms; terminal ${artifact.terminalCanonicality}.`,
    `Eligibility: ${artifact.eligibility?.eligible ?? "unknown"}; debt raw ${artifact.eligibility?.debtRaw ?? "unknown"}.`, "",
    "| Anchor | Exact seizure | Exact msETH repayment | View exit msETH | Raw margin | Redeem eth_call |",
    "|---|---:|---:|---:|---:|---|",
    ...artifact.rows.map(row => `| ${row.anchor} | ${row.seizedRaw} | ${row.repayRaw} | ${row.exitQuoteRaw ?? "UNKNOWN"} | ${row.rawMargin ?? "UNKNOWN"} | ${row.directRedeemEthCall.status} |`),
    "", "Owner-cap anchors are heuristics. Future-owner/global redemption capacity remains UNKNOWN. Preview output is not cash.",
    "", "## Limits and unresolved evidence", ...artifact.limitations.map(text => `- ${text}`),
    `- Required failures: ${artifact.failures.join(", ") || "none"}.`,
    "- All size rejections, owner contexts, raw capacity/funding observations, cost assumptions, code hashes and full request ledger are in the JSON.",
    `- ${artifact.nextValidation}`, ""];
  return lines.join("\n");
}
async function main(argv = process.argv.slice(2), options = {}) {
  if (!argv.includes("--run")) return { status: "NOT_RUN_EXPLICIT_GATE_REQUIRED" };
  if (fs.existsSync(OUTPUT) || fs.existsSync(REPORT)) fail("OUTPUT_ALREADY_EXISTS_NO_RERUN");
  const artifact = await check(options);
  artifact.sourceSha256 = crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex");
  fs.writeFileSync(OUTPUT, stringify(artifact) + "\n", { flag: "wx" });
  fs.writeFileSync(REPORT, report(artifact), { flag: "wx" });
  console.log(`ynETHx/msETH: ${artifact.status}; requests=${artifact.networkRequests}; rows=${artifact.rows.length}; no execution`);
  return artifact;
}
if (require.main === module) main().catch(() => { console.error("ynETHx/msETH checker: unavailable (sanitized)"); process.exitCode = 1; });
module.exports = { B, I, LIMITS, partialAmounts, feasibleSeizure, chooseSizes, verifyMarket, check, main, stringify };
