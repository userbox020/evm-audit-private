#!/usr/bin/env node
"use strict";

// Observation-only sibling. Importing this module performs no IO or RPC resolution.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Interface, keccak256 } = require("./node_modules/ethers");
const ROOT = path.resolve(__dirname, "..");
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const RAY = 10n ** 27n;
const MAX_UINT256 = (1n << 256n) - 1n;
const GATES = { routePositive: "unknown", executableNow: "unknown", signedActionJustified: false };
const LIMITS = Object.freeze({ requests: 160, wallMs: 240000, candidates: 6,
  endpoints: 16, chunk: 48, gas: 12000000, calldataBytes: 65536, returnBytes: 262144 });
const ABI = new Interface([
  "function version() view returns (uint256)", "function asset() view returns (address)",
  "function intermediateVault() view returns (address)", "function targetVault() view returns (address)",
  "function underlyingAsset() view returns (address)", "function aToken() view returns (address)",
  "function targetAsset() view returns (address)", "function aaveDebtToken() view returns (address)",
  "function categoryId() view returns (uint8)",
  "function totalAssetsDepositedOrReserved() view returns (uint256)",
  "function maxRelease() view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)", "function POOL() view returns (address)",
  "function POOL_ADDRESSES_PROVIDER() view returns (address)", "function RAY() view returns (uint256)",
  "function totalSupply() view returns (uint256)", "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)", "function latestAnswer() view returns (int256)",
  "function UNDERLYING_ASSET_ADDRESS() view returns (address)",
  "function scaledBalanceOf(address) view returns (uint256)", "function debtOf(address) view returns (uint256)",
  "function getReserveNormalizedIncome(address) view returns (uint256)",
  "function getReserveNormalizedVariableDebt(address) view returns (uint256)",
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getUserEMode(address) view returns (uint256)",
]);
const MC = new Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
]);
const ACCOUNT_KEYS = ["totalCollateralBase", "totalDebtBase", "availableBorrowsBase",
  "currentLiquidationThresholdBps", "ltvBps", "healthFactor"];
const SOURCES = ["targets/twyne-aToken-wrapper/src/AaveV3ATokenWrapper.sol",
  "targets/twyne-aToken-wrapper/src/CustomERC4626StataTokenUpgradeable.sol",
  "targets/twyne-contracts-v1/src/twyne/AaveV3CollateralVault.sol",
  "targets/twyne-contracts-v1/src/twyne/CollateralVaultBase.sol",
  "targets/twyne-contracts-v1/lib/aave-v3-origin/src/contracts/interfaces/IPool.sol"];

function address(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
    && !/^0x0{40}$/i.test(value) ? value.toLowerCase() : null;
}
function sanitize(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    // Never serialize untrusted transport messages, hosts, credentials or URIs.
    if (/(?:[a-z][a-z0-9+.-]*:(?:[\/\\]|%2f)|www\.|%3a%2f|\b(?:bearer|password|secret|credential|api[_-]?key|authorization)\b|[^\s@]+@[^\s@]+|\b[a-z0-9-]+\.(?:com|net|org|io|xyz|dev)(?:\b|\/))/i.test(value)) return "REDACTED";
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [/url|endpoint|credential|password|secret|authorization|api.?key/i.test(k) ? "redacted" : sanitize(k),
      /url|endpoint|credential|password|secret|authorization|api.?key/i.test(k) ? "REDACTED" : sanitize(v)]));
  return value;
}
function serialize(value) { return `${JSON.stringify(sanitize(value), null, 2)}\n`; }
function selectCandidates(surface) {
  const selected = [], rejected = [], seen = new Set();
  for (const item of surface.vaults || []) {
    const vault = address(item.vault);
    let reason = null;
    if (Number(item.chainId ?? surface.chainId) !== 1) reason = "UNSUPPORTED_CHAIN";
    else if (String(item.version) !== "3") reason = "UNSUPPORTED_VERSION";
    else if (item.profile && !["aave", "AAVE_V3", "AAVE_CANDIDATE_UNBOUND", "AAVE_V3_IDENTITY_BOUND"].includes(item.profile)) reason = "UNSUPPORTED_PROFILE";
    else if (!vault) reason = "INVALID_ADDRESS";
    else if (seen.has(vault)) reason = "DUPLICATE";
    if (reason) rejected.push({ vault, reason });
    else { selected.push({ vault, chainId: 1, version: "3" }); seen.add(vault); }
  }
  return { selected, rejected };
}
function descriptor(id, target, signature, args = [], unit = "raw") {
  return { id, target: address(target), signature, args, required: true, unit };
}
function round1(vault) {
  const reads = ["version", "asset", "intermediateVault", "targetVault", "underlyingAsset", "aToken",
    "targetAsset", "aaveDebtToken", "categoryId", "totalAssetsDepositedOrReserved", "maxRelease"];
  return [...reads.map((name) => descriptor(`cv.${name}`, vault, `${name}()`)),
    descriptor("cv.balanceOfSelf", vault, "balanceOf(address)", [vault], "wrapperShares")];
}
function valueOf(fields, id) { return fields[id]?.status === "OK" ? fields[id].value : null; }
function round2(vault, fields) {
  const cv = (key) => valueOf(fields, `cv.${key}`);
  const reads = [];
  const add = (group, target, names, args = []) => {
    for (const name of names) reads.push(descriptor(`${group}.${name}`, target, `${name}(${args.length ? "address" : ""})`, args));
  };
  add("wrapper", cv("asset"), ["version", "decimals", "asset", "aToken", "POOL", "POOL_ADDRESSES_PROVIDER",
    "RAY", "totalSupply", "totalAssets", "latestAnswer"]);
  add("wrapper", cv("asset"), ["balanceOf"], [vault]);
  add("aToken", cv("aToken"), ["UNDERLYING_ASSET_ADDRESS", "POOL"]);
  add("aToken", cv("aToken"), ["scaledBalanceOf", "balanceOf"], [vault]);
  add("iv", cv("intermediateVault"), ["asset"]);
  add("iv", cv("intermediateVault"), ["debtOf"], [vault]);
  add("debtToken", cv("aaveDebtToken"), ["UNDERLYING_ASSET_ADDRESS"]);
  add("debtToken", cv("aaveDebtToken"), ["scaledBalanceOf", "balanceOf"], [vault]);
  add("pool", cv("targetVault"), ["getReserveNormalizedIncome"], [cv("underlyingAsset")]);
  add("pool", cv("targetVault"), ["getReserveNormalizedVariableDebt"], [cv("targetAsset")]);
  add("pool", cv("targetVault"), ["getUserAccountData", "getUserEMode"], [vault]);
  return reads;
}
function conversionReads(fields) {
  const wrapper = valueOf(fields, "cv.asset");
  const decimals = valueOf(fields, "wrapper.decimals");
  const balance = valueOf(fields, "wrapper.balanceOf");
  const probe = decimals != null && BigInt(decimals) <= 77n ? (10n ** BigInt(decimals)).toString() : null;
  return [descriptor("wrapper.convertToAssets", wrapper, "convertToAssets(uint256)", [probe], "underlyingUnits"),
    descriptor("wrapper.previewRedeem", wrapper, "previewRedeem(uint256)", [balance], "underlyingUnits")];
}
function decodeField(read, success, data) {
  const base = { value: null, status: "SUBCALL_FAILED", target: read.target,
    signature: read.signature, args: read.args, unit: read.unit };
  if (!success) return base;
  try {
    const result = ABI.decodeFunctionResult(read.signature, data);
    // All requested outputs are fixed-width; reject trailing bytes and non-canonical layouts.
    if (ABI.encodeFunctionResult(read.signature, result).toLowerCase() !== data.toLowerCase()) throw new Error("LAYOUT");
    let value;
    if (read.signature === "getUserAccountData(address)") {
      value = Object.fromEntries(ACCOUNT_KEYS.map((key, i) => [key, result[i].toString()]));
    } else if (typeof result[0] === "bigint") value = result[0].toString();
    else value = address(result[0]);
    if (value == null) throw new Error("VALUE");
    return { ...base, value, status: "OK" };
  } catch (_) { return { ...base, status: "MALFORMED_RETURN" }; }
}
function decodeAggregate(reads, data) {
  try {
    const result = MC.decodeFunctionResult("aggregate3", data)[0];
    if (result.length !== reads.length || MC.encodeFunctionResult("aggregate3", [result]).toLowerCase() !== data.toLowerCase()) throw new Error("VECTOR");
    return Object.fromEntries(reads.map((read, i) => [read.id, decodeField(read, result[i].success, result[i].returnData)]));
  } catch (_) {
    return Object.fromEntries(reads.map((read) => [read.id, { ...decodeField(read, false, "0x"), status: "MALFORMED_AGGREGATE" }]));
  }
}
function bindIdentities(fields) {
  const groups = {
    wrapper: ["cv.asset", "iv.asset"],
    underlying: ["cv.underlyingAsset", "wrapper.asset", "aToken.UNDERLYING_ASSET_ADDRESS"],
    aToken: ["cv.aToken", "wrapper.aToken"],
    pool: ["cv.targetVault", "wrapper.POOL", "aToken.POOL"],
    targetUnderlying: ["cv.targetAsset", "debtToken.UNDERLYING_ASSET_ADDRESS"],
    category: ["cv.categoryId", "pool.getUserEMode"],
  };
  const checks = Object.fromEntries(Object.entries(groups).map(([key, ids]) => {
    const values = ids.map((id) => valueOf(fields, id));
    return [key, values.some((v) => v == null) ? "UNRESOLVED" : new Set(values).size === 1 ? "PASS" : "MISMATCH"];
  }));
  checks.versions = ["cv.version", "wrapper.version"].some((id) => valueOf(fields, id) == null)
    ? "UNRESOLVED" : ["cv.version", "wrapper.version"].every((id) => valueOf(fields, id) === "3") ? "PASS" : "MISMATCH";
  checks.ray = valueOf(fields, "wrapper.RAY") == null ? "UNRESOLVED"
    : valueOf(fields, "wrapper.RAY") === RAY.toString() ? "PASS" : "MISMATCH";
  return { status: Object.values(checks).includes("MISMATCH") ? "MISMATCH"
    : Object.values(checks).every((v) => v === "PASS") ? "PASS" : "UNRESOLVED", checks };
}
function conservationLens(input, bound = false) {
  const keys = ["T", "I", "S", "balance"];
  const empty = { state: "UNKNOWN", sameUnitDelta: null, scaledBackingDelta: null, ledgerIdentityResidual: null, crossAssetIdentityComputed: false };
  if (!bound || keys.some((key) => input[key] == null)) return empty;
  const [T, I, S, balance] = keys.map((key) => BigInt(input[key]));
  return { ...empty, state: S >= T ? "SAME_UNIT_LENS_ONLY" : "EXTERNAL_LIQUIDATION_BRANCH",
    sameUnitDelta: (T - I).toString(), scaledBackingDelta: (S - T).toString(),
    ledgerIdentityResidual: S >= T ? (T - (I < T ? I : T) - balance).toString() : null };
}
function floorAssets(shares, index) { return (BigInt(shares) * BigInt(index) / RAY).toString(); }
function healthDiagnostics(account, bound = false) {
  const out = Object.fromEntries([...ACCOUNT_KEYS, "requestedConservationIndex", "borrowHeadroom", "liquidationHeadroom", "netExternalCollateralValue"].map((key) => [key, null]));
  out.healthFactorNoDebtSentinel = null;
  out.status = "DEPENDENCY_UNRESOLVED";
  out.unit = "AAVE_ACCOUNT_BASE_UNITS";
  out.thresholdProductRounding = "FLOOR";
  if (!account || !bound || ACCOUNT_KEYS.some((key) => account[key] == null)) return out;
  const [C, D, , LT, LTV, HF] = ACCOUNT_KEYS.map((key) => BigInt(account[key]));
  if (LT > 10000n || LTV > 10000n) return { ...out, status: "INVALID_THRESHOLDS" };
  return { ...out, ...account, status: "ACCOUNT_TUPLE_DIAGNOSTIC_ONLY",
    healthFactorNoDebtSentinel: HF === MAX_UINT256,
    requestedConservationIndex: (C - D - C * LTV / 10000n).toString(),
    borrowHeadroom: (C * LTV / 10000n - D).toString(),
    liquidationHeadroom: (C * LT / 10000n - D).toString(),
    netExternalCollateralValue: (C - D).toString() };
}
function deriveRow(row, pinVerified) {
  const f = row.fields;
  row.identities = bindIdentities(f);
  const bound = pinVerified && row.identities.status === "PASS";
  row.profile = bound ? "AAVE_V3_IDENTITY_BOUND" : "AAVE_CANDIDATE_UNBOUND";
  row.conservationIdentity = conservationLens({ T: valueOf(f, "cv.totalAssetsDepositedOrReserved"),
    I: valueOf(f, "iv.debtOf"), S: valueOf(f, "aToken.scaledBalanceOf"), balance: valueOf(f, "cv.balanceOfSelf") }, bound);
  row.aaveHealth = healthDiagnostics(valueOf(f, "pool.getUserAccountData"), bound);
  const index = valueOf(f, "pool.getReserveNormalizedIncome");
  row.wrapperConversions = { rounding: "FLOOR", ray: RAY.toString(),
    probeShares: f["wrapper.convertToAssets"]?.args[0] ?? null,
    redeemShares: f["wrapper.previewRedeem"]?.args[0] ?? null,
    expectedProbeAssets: null, expectedRedeemAssets: null, status: "DEPENDENCY_UNRESOLVED" };
  const c = row.wrapperConversions;
  if (bound && index != null && BigInt(index) > 0n && c.probeShares != null && c.redeemShares != null) {
    c.expectedProbeAssets = floorAssets(c.probeShares, index);
    c.expectedRedeemAssets = floorAssets(c.redeemShares, index);
    c.status = valueOf(f, "wrapper.convertToAssets") == null || valueOf(f, "wrapper.previewRedeem") == null
      ? "DEPENDENCY_UNRESOLVED" : c.expectedProbeAssets === valueOf(f, "wrapper.convertToAssets")
        && c.expectedRedeemAssets === valueOf(f, "wrapper.previewRedeem") ? "PASS" : "MISMATCH";
  }
  row.observationState = !pinVerified ? "PIN_INVALID" : row.identities.status === "MISMATCH" ? "IDENTITY_MISMATCH"
    : bound && Object.values(f).every((field) => field.status === "OK" || field.status === "UNSUPPORTED_IN_SOURCE")
      && c.status === "PASS" ? "COMPLETE_REQUESTED_SURFACE" : "PARTIAL";
  return row;
}
function budget({ now = Date.now, limits = {} } = {}) {
  const caps = { ...LIMITS, ...limits }, start = now();
  let attempts = 0;
  return { caps, now, assert() {
    if (attempts >= caps.requests) throw new Error("REQUEST_CAP");
    if (now() - start >= caps.wallMs) throw new Error("WALL_CAP");
  }, take() { this.assert(); attempts++; }, snapshot() { return { attempts, elapsedMs: now() - start, limits: caps }; } };
}
function guardedTransport(transport, meter) {
  return async (method, params) => {
    if (!["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"].includes(method)) throw new Error("METHOD_NOT_ALLOWED");
    meter.take();
    return transport(method, params);
  };
}
function blockPin(header) {
  if (!header || !/^0x[0-9a-f]+$/i.test(header.number) || !/^0x[0-9a-f]{64}$/i.test(header.hash)
    || !/^0x[0-9a-f]+$/i.test(header.timestamp)) throw new Error("INVALID_FINALIZED_HEADER");
  const number = Number(BigInt(header.number)), seconds = Number(BigInt(header.timestamp));
  if (!Number.isSafeInteger(number) || number <= 0 || !Number.isSafeInteger(seconds)) throw new Error("INVALID_FINALIZED_HEADER");
  return { chainId: 1, number, hash: header.hash.toLowerCase(), timestamp: new Date(seconds * 1000).toISOString(), finality: "finalized" };
}
function pinArg(pin) { return { blockHash: pin.hash, requireCanonical: true }; }
async function qualify(rpc, caps) {
  if (await rpc("eth_chainId", []) !== "0x1") throw new Error("WRONG_CHAIN");
  const pin = blockPin(await rpc("eth_getBlockByNumber", ["finalized", false]));
  const code = await rpc("eth_getCode", [MULTICALL3, pinArg(pin)]);
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(code) || code.length > caps.returnBytes * 2 + 2) throw new Error("MULTICALL_CODE_MISSING");
  const data = await rpc("eth_call", [{ to: MULTICALL3, data: MC.encodeFunctionData("aggregate3", [[]]), gas: `0x${caps.gas.toString(16)}` }, pinArg(pin)]);
  if (MC.decodeFunctionResult("aggregate3", data)[0].length !== 0) throw new Error("MULTICALL_QUALIFICATION_FAILED");
  return { pin, multicallCodeHash: keccak256(code) };
}
async function executeReads(reads, fields, rpc, pin, caps, direct = false) {
  const ready = [];
  for (const read of reads) {
    if (!read.target || read.args.some((arg) => arg == null)) fields[read.id] = { ...decodeField(read, false, "0x"), status: "DEPENDENCY_UNRESOLVED", sent: "NOT_SENT" };
    else ready.push(read);
  }
  const chunkSize = direct ? 1 : caps.chunk;
  for (let i = 0; i < ready.length; i += chunkSize) {
    const chunk = ready.slice(i, i + chunkSize);
    try {
      const calls = chunk.map((read) => ({ target: read.target, allowFailure: true, callData: ABI.encodeFunctionData(read.signature, read.args) }));
      const data = direct ? calls[0].callData : MC.encodeFunctionData("aggregate3", [calls]);
      if ((data.length - 2) / 2 > caps.calldataBytes) throw new Error("CALLDATA_CAP");
      const response = await rpc("eth_call", [{ to: direct ? chunk[0].target : MULTICALL3, data, gas: `0x${caps.gas.toString(16)}` }, pinArg(pin)]);
      if (typeof response !== "string" || response.length > caps.returnBytes * 2 + 2) throw new Error("RETURN_CAP");
      Object.assign(fields, direct ? { [chunk[0].id]: decodeField(chunk[0], true, response) } : decodeAggregate(chunk, response));
    } catch (error) {
      const status = ["REQUEST_CAP", "WALL_CAP", "CALLDATA_CAP", "RETURN_CAP"].includes(error.message) ? error.message : "TRANSPORT_FAILED";
      for (const read of chunk) fields[read.id] = { ...decodeField(read, false, "0x"), status };
    }
  }
}
async function scan({ surface, candidates, transport, qualified = null, meter = budget(), mode = "OFFLINE_INJECTED" }) {
  if (typeof transport !== "function") throw new Error("TRANSPORT_REQUIRED");
  const rpc = guardedTransport(transport, meter);
  const qualification = qualified || await qualify(rpc, meter.caps);
  const selection = selectCandidates(candidates ? { chainId: 1, vaults: candidates } : surface);
  const rows = [];
  for (const candidate of selection.selected.slice(0, meter.caps.candidates)) {
    const fields = Object.fromEntries(["eulerAccount", "initialization"].map((key) => [`cv.${key}`,
      { value: null, status: "UNSUPPORTED_IN_SOURCE", sent: "NOT_SENT" }]));
    await executeReads(round1(candidate.vault), fields, rpc, qualification.pin, meter.caps);
    // Never send Aave target selectors to a discovered non-v3 implementation.
    if (valueOf(fields, "cv.version") === "3") {
      await executeReads(round2(candidate.vault, fields), fields, rpc, qualification.pin, meter.caps);
      // Dependent substage: these arguments only exist after wrapper decimals/balance discovery.
      await executeReads(conversionReads(fields), fields, rpc, qualification.pin, meter.caps, true);
    }
    rows.push({ ...candidate, observationPin: qualification.pin, fields, ...GATES,
      deploymentBinding: "UNVERIFIED_SOURCE_RUNTIME_PROXY_IMPLEMENTATIONS",
      singleReserveReconciliation: "NOT_PERFORMED", crossAssetRevaluation: null });
  }
  let pinVerified = false;
  try {
    const end = blockPin(await rpc("eth_getBlockByNumber", [`0x${qualification.pin.number.toString(16)}`, false]));
    pinVerified = end.number === qualification.pin.number && end.hash === qualification.pin.hash
      && end.timestamp === qualification.pin.timestamp && await rpc("eth_chainId", []) === "0x1";
  } catch (_) { /* Retain raw reads, suppress every dependent diagnostic on invalid pin. */ }
  rows.forEach((row) => deriveRow(row, pinVerified));
  const identityBound = rows.filter((row) => row.profile === "AAVE_V3_IDENTITY_BOUND").length;
  const requestedComplete = rows.filter((row) => row.observationState === "COMPLETE_REQUESTED_SURFACE").length;
  return sanitize({ schema: "twyne-v3-aave-l-observation/v1", scanner: "tools/scan-twyne-v3-aave-l.js",
    scannedAt: new Date(meter.now()).toISOString(), mode, chainId: 1, pin: qualification.pin, pinVerified,
    inventoryPin: surface?.pin ?? null, multicall3: { address: MULTICALL3, codeHash: qualification.multicallCodeHash,
      binding: "PRESENT_AT_OBSERVATION_HASH_NOT_SOURCE_ATTESTED" },
    ...GATES, safety: { readOnly: true, signing: false, broadcast: false, protectedFilesRead: false },
    abiSha256: crypto.createHash("sha256").update(ABI.formatJson()).digest("hex"),
    limitations: ["IDENTITY_BINDING_IS_NOT_DEPLOYED_SOURCE_EQUIVALENCE", "NO_PROXY_IMPLEMENTATION_ATTESTATION",
      "NO_RESERVE_PRICE_OR_EMODE_BITMAP_RECONCILIATION", "NO_HISTORY_REPLAY_OR_NEW_ENUMERATION",
      "ACCOUNT_HEALTH_DIAGNOSTICS_NOT_PROFIT_OR_BORROWER_EQUITY", "NO_DEPLOYED_TOKEN_ROUNDING_INFERRED"],
    coverage: { inventoryRows: (surface?.vaults ?? candidates ?? []).length,
      version3Candidates: selection.selected.length, observed: rows.length, identityBound,
      admittedAaveSourceBound: 0, completeRequestedSurface: requestedComplete,
      partial: rows.filter((row) => row.observationState === "PARTIAL").length,
      mismatched: rows.filter((row) => row.observationState === "IDENTITY_MISMATCH").length,
      unsupported: selection.rejected.length, capped: Math.max(0, selection.selected.length - rows.length),
      requestedSurfaceComplete: pinVerified && rows.length === selection.selected.length && requestedComplete === rows.length,
      complete: false, enumerationComplete: false, historicalCoverageComplete: false },
    rejected: selection.rejected, budget: meter.snapshot(), vaults: rows });
}
function httpTransport(url) {
  let id = 0;
  const parsed = new URL(url);
  const headers = { "content-type": "application/json" };
  // Match the workspace's reviewed public-application Origin rules without
  // importing shared-rpc (or its global state/configuration) into this sibling.
  if (["app.aave.com", "app.morpho.org"].includes(parsed.hostname)) headers.origin = parsed.origin;
  if (["proxy.sky.money", "gateway.tenderly.co"].includes(parsed.hostname)) headers.origin = ["https:", "", "app.sky.money"].join("/");
  if (parsed.hostname.endsWith("nodereal.io")) headers.origin = ["https:", "", "pancakeswap.finance"].join("/");
  return async (method, params) => {
    try {
      const response = await fetch(url, { method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(8000), redirect: "error" });
      if (!response.ok) throw new Error("RPC_HTTP_FAILED");
      const reader = response.body.getReader();
      const parts = []; let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > LIMITS.returnBytes * 2 + 8192) { await reader.cancel(); throw new Error("RPC_RESPONSE_CAP"); }
        parts.push(Buffer.from(value));
      }
      const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (body.error || body.id !== id || body.jsonrpc !== "2.0" || !("result" in body)) throw new Error("RPC_RESULT_FAILED");
      return body.result;
    } catch (error) {
      throw new Error(["RPC_HTTP_FAILED", "RPC_RESULT_FAILED", "RPC_RESPONSE_CAP"].includes(error.message)
        ? error.message : "RPC_TRANSPORT_FAILED");
    }
  };
}
function endpointCandidates(text) {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("INVENTORY_CAP");
  const urls = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/https?:\/\/[^\s'"<>\[\]]+/);
    if (!match) continue;
    try {
      const url = new URL(match[0].replace(/[),;]+$/, ""));
      if (/testnet|sepolia|hoodi|solana|sui|aptos|stellar|tron/i.test(url.hostname)) continue;
      const applicationRpc = (url.hostname === "app.aave.com" && url.pathname.startsWith("/api/rpc-proxy"))
        || (url.hostname === "app.morpho.org" && url.pathname.startsWith("/api/rpc"))
        || url.hostname === "proxy.sky.money";
      if (!applicationRpc && !/eth|ethereum|mainnet/i.test(url.hostname + url.pathname)) continue;
      if (!urls.includes(url.href)) urls.push(url.href);
    } catch (_) { /* Inventory material stays process-only. */ }
  }
  // Avoid letting many stale credentials from one provider consume the cap
  // before known application RPCs with an explicit mainnet path are tried.
  const rank = (raw) => {
    const url = new URL(raw);
    if (/\/1\/?$/.test(url.pathname) && /morpho|sky/.test(url.hostname)) return 0;
    if (/aave|morpho|sky/.test(url.hostname)) return 1;
    if (/alchemy|infura/.test(url.hostname)) return 3;
    return 2;
  };
  return urls.sort((left, right) => rank(left) - rank(right));
}
const CSV_COLUMNS = ["vault", "profile", "observationState", "sameUnitDelta", "scaledBackingDelta", "ledgerIdentityResidual",
  ...ACCOUNT_KEYS, "requestedConservationIndex", "borrowHeadroom", "liquidationHeadroom", "routePositive", "executableNow", "signedActionJustified"];
function csv(report) {
  const cell = (value) => value == null ? "" : `"${String(sanitize(value)).replace(/"/g, '""')}"`;
  return [CSV_COLUMNS.join(","), ...report.vaults.map((row) => {
    const flat = { ...row, ...row.conservationIdentity, ...row.aaveHealth };
    return CSV_COLUMNS.map((key) => cell(flat[key])).join(",");
  })].join("\n") + "\n";
}
function publish(report) {
  if (report.mode !== "LIVE_READ_ONLY") throw new Error("OFFLINE_PUBLICATION_FORBIDDEN");
  // Exact-file write scope excludes temporary siblings. Publish the hash-bearing
  // index last; readers must verify both hashes before accepting this generation.
  // This detects interrupted/mixed publication, but is not a filesystem transaction.
  const write = (relative, text) => {
    fs.writeFileSync(path.join(ROOT, relative), text);
  };
  const json = serialize(report), csvText = csv(report);
  write("reports/raw/fast/twyne-v3-aave-l.json", json);
  write("reports/raw/fast/twyne-v3-aave-l.csv", csvText);
  write("reports/monitor/twyne-v3-aave-l-index.json", serialize({ schema: "twyne-v3-aave-l-index/v1",
    scannedAt: report.scannedAt, pin: report.pin, pinVerified: report.pinVerified, coverage: report.coverage, ...GATES,
    publication: "HASH_VERIFIED_INDEX_LAST_NOT_FILESYSTEM_ATOMIC",
    artifacts: { json: "reports/raw/fast/twyne-v3-aave-l.json", csv: "reports/raw/fast/twyne-v3-aave-l.csv" },
    sha256: { json: crypto.createHash("sha256").update(json).digest("hex"), csv: crypto.createHash("sha256").update(csvText).digest("hex") } }));
}
async function main(args) {
  if (args.length !== 2 || !args.includes("--once") || !args.includes("--live")) throw new Error("REQUIRE_ONCE_AND_LIVE");
  const surface = JSON.parse(fs.readFileSync(path.join(ROOT, "reports/raw/fast/twyne-l.json"), "utf8"));
  const meter = budget();
  const urls = endpointCandidates(fs.readFileSync(path.join(ROOT, "rpc_endpoints.txt"), "utf8"));
  let chosen = null, qualification = null;
  const failures = {};
  for (const url of urls.slice(0, meter.caps.endpoints)) {
    meter.assert();
    const transport = httpTransport(url);
    try { qualification = await qualify(guardedTransport(transport, meter), meter.caps); chosen = transport; break; }
    catch (error) {
      // Only local, enumerated codes are retained, never provider messages.
      const code = ["WRONG_CHAIN", "INVALID_FINALIZED_HEADER", "MULTICALL_CODE_MISSING", "MULTICALL_QUALIFICATION_FAILED",
        "RPC_HTTP_FAILED", "RPC_RESULT_FAILED", "RPC_RESPONSE_CAP", "RPC_TRANSPORT_FAILED"].includes(error.message)
        ? error.message : "QUALIFICATION_FAILED";
      failures[code] = (failures[code] || 0) + 1;
    }
  }
  if (!chosen) {
    process.stderr.write(serialize({ status: "NO_QUALIFIED_MAINNET_RPC", failures, budget: meter.snapshot() }));
    throw new Error("NO_QUALIFIED_MAINNET_RPC");
  }
  const report = await scan({ surface, transport: chosen, qualified: qualification, meter, mode: "LIVE_READ_ONLY" });
  report.sourceAuthority = SOURCES.map((file) => ({ path: file,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, file))).digest("hex"), deployedEquivalence: "UNVERIFIED" }));
  publish(report);
  process.stdout.write(serialize({ pin: report.pin, pinVerified: report.pinVerified, coverage: report.coverage, budget: report.budget }));
}
if (require.main === module) main(process.argv.slice(2)).catch((error) => {
  const code = ["NO_QUALIFIED_MAINNET_RPC", "REQUEST_CAP", "WALL_CAP", "INVENTORY_CAP", "REQUIRE_ONCE_AND_LIVE"].includes(error.message)
    ? error.message : "TWYNE_V3_AAVE_SCAN_FAILED_REDACTED";
  process.stderr.write(`${code}\n`); process.exitCode = 1;
});
module.exports = { ABI, MC, MULTICALL3, RAY, MAX_UINT256, ACCOUNT_KEYS, LIMITS, selectCandidates,
  round1, round2, conversionReads, decodeField, decodeAggregate, bindIdentities, conservationLens,
  floorAssets, healthDiagnostics, deriveRow, budget, scan, sanitize, serialize, csv, publish };
