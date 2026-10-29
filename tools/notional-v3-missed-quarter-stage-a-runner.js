#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { Interface, getAddress, id } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const STEM = "notional-v3-missed-quarter-stage-a";
const FINDING_ID = "notional-v3-missed-quarter-market-initialization";
const SOURCE_ROOT = "targets/notional-contracts-v3-6e7907e";
const SOURCE_COMMIT = "6e7907e68ec99959144a0c939684a6da076f63c1";
const SOURCE_TREE = "b04475d3d783362b4da3e11e6f90f0fdedb42aa4";
const CAPTURE_FLAG = "--capture-notional-v3-missed-quarter-stage-a-once";
const EXPECTED_PACKAGE_AGGREGATE = "d716e1e08d83b1b51116e9c4f6d214ce74f1b4a9c6d29873ea8a8b40a976b13e";
const INVENTORY_REL = "rpc_endpoints.txt";
const FIXTURE_REL = `tools/fixtures/${STEM}-fixtures.json`;
const RUNTIME_MANIFEST_REL = `tools/fixtures/${STEM}-runtime-manifest.json`;
const PREFLIGHT_REL = `reports/raw/fast/${STEM}-preflight.json`;
const MANIFEST_REL = `reports/raw/fast/${STEM}-manifest.json`;
const REPORT_REL = `reports/${STEM}-package.md`;
const CONSUMPTION_MARKER_REL = `reports/raw/fast/${STEM}.consumed`;
const OUTPUT_DIR_REL = "reports/raw/fast";
const QUARTER = 7776000n;
const MARKET_OFFSETS = Object.freeze([1n, 2n, 4n, 8n, 20n, 40n, 80n].map((x) => x * QUARTER));
const CURRENCY_IDS = Object.freeze([1, 2, 3, 5, 6, 7, 8, 9, 11]);
const CLASSIFICATIONS = Object.freeze(["CURRENT_HEALTHY", "DUE_BUT_RECOVERABLE", "MISSED_QUARTER_TRIGGER_PRESENT", "NOT_APPLICABLE", "STATE_INCONSISTENT_UNKNOWN"]);
const SOURCE_STATES = Object.freeze(["SOURCE_BOUND", "SOURCE_MISMATCH", "BINDING_UNKNOWN", "CONFIG_DRIFT_BOUND"]);
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const CAPS = Object.freeze({ poolInstances: 6, poolFamilies: 4, rejectedQualificationCalls: 8, selectedBaseCalls: 77,
  selectedConditionalCalls: 9, batch: 24, runtimeBytes: 32768, callResultBytes: 262144, responseBytes: 1048576,
  endpointResponseBytes: 8388608, aggregateResponseBytes: 4194304, requestBytes: 262144, outputBytes: 4194304,
  inventoryBytes: 16777216, inventoryRecordBytes: 262144, inventoryDepth: 32, requestMs: 12000, wallMs: 300000,
  markets: 7, liquidityTokens: 7, netfCashAssets: 256, cborBytes: 4096, cborDepth: 16, cborItems: 256, retries: 0 });

const config = JSON.parse(fs.readFileSync(path.join(ROOT, SOURCE_ROOT, "v3.mainnet.json"), "utf8"));
const ADDRESSES = Object.freeze({ proxy: config.notional.toLowerCase(), router: config.routers.Router.toLowerCase(),
  initializeMarkets: config.actions.InitializeMarketsAction.toLowerCase(), views: config.actions.Views.toLowerCase(),
  nTokenMint: config.libs.nTokenMintAction.toLowerCase(), freeCollateral: config.libs.FreeCollateralExternal.toLowerCase(),
  settleAssets: config.libs.SettleAssetsExternal.toLowerCase() });

const proxyAbi = new Interface(["function getImplementation() view returns(address)"]);
const routerAbi = new Interface(["function INITIALIZE_MARKET() view returns(address)", "function VIEWS() view returns(address)", "function getRouterImplementation(bytes4) view returns(address)"]);
const libAbi = new Interface(["function getLibInfo() pure returns(address)"]);
const errorAbi = new Interface(["error Error(string)"]);
const viewsAbi = new Interface([
  "function getCurrency(uint16) view returns((address tokenAddress,bool hasTransferFee,int256 decimals,uint8 tokenType,uint256 deprecated_maxCollateralBalance) assetToken,(address tokenAddress,bool hasTransferFee,int256 decimals,uint8 tokenType,uint256 deprecated_maxCollateralBalance) underlyingToken)",
  "function getCashGroup(uint16) view returns((uint8 maxMarketIndex,uint8 rateOracleTimeWindow5Min,uint8 maxDiscountFactor5BPS,uint8 reserveFeeShare,uint8 debtBuffer25BPS,uint8 fCashHaircut25BPS,uint8 minOracleRate25BPS,uint8 liquidationfCashHaircut25BPS,uint8 liquidationDebtBuffer25BPS,uint8 maxOracleRate25BPS))",
  "function getActiveMarketsAtBlockTime(uint16,uint32) view returns((bytes32 storageSlot,uint256 maturity,int256 totalfCash,int256 totalPrimeCash,int256 totalLiquidity,uint256 lastImpliedRate,uint256 oracleRate,uint256 previousTradeTime)[])",
  "function nTokenAddress(uint16) view returns(address)",
  "function getNTokenAccount(address) view returns(uint16 currencyId,uint256 totalSupply,uint256 incentiveAnnualEmissionRate,uint256 lastInitializedTime,bytes6 nTokenParameters,int256 cashBalance,uint256 accumulatedNOTEPerNToken,uint256 lastAccumulatedTime)",
  "function getNTokenPortfolio(address) view returns((uint16 currencyId,uint256 maturity,uint256 assetType,int256 notional,uint256 storageSlot,uint8 storageState)[] liquidityTokens,(uint16 currencyId,uint256 maturity,uint256 assetType,int256 notional,uint256 storageSlot,uint8 storageState)[] netfCashAssets)"
]);
const INITIALIZE_SELECTOR = id("initializeMarkets(uint16,bool)").slice(0, 10).toLowerCase();
const VIEW_NAMES = Object.freeze(["getCurrency", "getCashGroup", "getActiveMarketsAtBlockTime", "nTokenAddress", "getNTokenAccount", "getNTokenPortfolio"]);
const ROUTED_SELECTORS = Object.freeze([INITIALIZE_SELECTOR, ...VIEW_NAMES.map((name) => viewsAbi.getFunction(name).selector.toLowerCase())]);
const PROXY_SELECTORS = new Set([proxyAbi.getFunction("getImplementation").selector, ...VIEW_NAMES.map((name) => viewsAbi.getFunction(name).selector)].map((x) => x.toLowerCase()));
const ROUTER_SELECTORS = new Set([routerAbi.getFunction("INITIALIZE_MARKET").selector, routerAbi.getFunction("VIEWS").selector, routerAbi.getFunction("getRouterImplementation").selector].map((x) => x.toLowerCase()));
const LIB_SELECTOR = libAbi.getFunction("getLibInfo").selector.toLowerCase();
const DENIED_METHOD_PATTERN = /(?:send|sign|wallet|nonce|mempool|trace|fork|estimate|transaction|rawtransaction)/iu;

const REQUIRED_ARTIFACT_PATHS = Object.freeze([`tools/${STEM}-runner.js`, `tools/test-${STEM}.js`, `tools/validate-${STEM}.js`,
  `tools/build-${STEM}-runtime-manifest.js`, `tools/build-${STEM}-package-manifest.js`, `tools/${STEM}.cmd`, FIXTURE_REL, RUNTIME_MANIFEST_REL, REPORT_REL, PREFLIGHT_REL]);
const LOCAL_INPUT_RELS = Object.freeze([`${SOURCE_ROOT}/v3.mainnet.json`, `${SOURCE_ROOT}/contracts/proxy/nProxy.sol`, `${SOURCE_ROOT}/contracts/external/Router.sol`,
  `${SOURCE_ROOT}/contracts/external/Views.sol`, `${SOURCE_ROOT}/contracts/external/actions/InitializeMarketsAction.sol`, `${SOURCE_ROOT}/contracts/external/actions/nTokenMintAction.sol`,
  `${SOURCE_ROOT}/contracts/external/FreeCollateralExternal.sol`, `${SOURCE_ROOT}/contracts/global/Types.sol`, `${SOURCE_ROOT}/interfaces/notional/NotionalViews.sol`,
  `${SOURCE_ROOT}/interfaces/notional/IRouter.sol`, "reports/medium-notional-v3-missed-quarter-market-initialization-step1.md",
  "reports/medium-notional-v3-missed-quarter-market-initialization-step1.json", "tools/package.json", "tools/package-lock.json"]);

function workspacePath(relative) { return path.join(ROOT, ...relative.split("/")); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function stable(value) { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])); return value; }
function normalizeAddress(value) { try { return getAddress(value).toLowerCase(); } catch (_) { return null; } }
function numericTag(value) { if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/u.test(value)) throw new Error("NUMERIC_BLOCK_TAG_REQUIRED"); return value; }
function hexQuantity(value) { const number = BigInt(value); if (number < 0n) throw new Error("NEGATIVE_QUANTITY"); return `0x${number.toString(16)}`; }
function parseHeader(value) { try { if (!value || !/^0x[0-9a-fA-F]{64}$/u.test(value.hash || "") || !/^0x[0-9a-fA-F]{64}$/u.test(value.stateRoot || "")) return null;
  return { number: BigInt(value.number).toString(), hash: value.hash.toLowerCase(), stateRoot: value.stateRoot.toLowerCase(), timestamp: BigInt(value.timestamp).toString() }; } catch (_) { return null; } }
function samePin(a, b) { return Boolean(a && b && JSON.stringify(a) === JSON.stringify(b)); }
function storageAddress(word) { return typeof word === "string" && /^0x0{24}[0-9a-fA-F]{40}$/u.test(word) ? normalizeAddress(`0x${word.slice(-40)}`) : null; }
function codeRecord(code) { if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(code)) return null; const bytes = Buffer.from(code.slice(2), "hex");
  if (bytes.length > CAPS.runtimeBytes) throw new Error("RUNTIME_CAP_EXCEEDED"); return { present: bytes.length > 0, bytes: bytes.length, sha256: bytes.length ? sha256(bytes) : null }; }
function timing(lastInitializedTime, blockTimestamp) { const L = BigInt(lastInitializedTime), T = BigInt(blockTimestamp), R = T - T % QUARTER, I = L - L % QUARTER;
  return { blockTimestamp: T.toString(), lastInitializedTime: L.toString(), referenceTime: R.toString(), initializedReferenceTime: I.toString(), timingValid: L <= T, lagQuarters: L <= T && I <= R ? ((R - I) / QUARTER).toString() : null }; }
function expectedMaturities(reference, count) { const value = BigInt(reference); return MARKET_OFFSETS.slice(0, count).map((offset) => (value + offset).toString()); }
function isValidBitmapMaturity(blockTime, maturity) { const DAY = 86400n, WEEK = DAY * 6n, MONTH = WEEK * 5n, value = BigInt(maturity), utc0 = BigInt(blockTime) - BigInt(blockTime) % DAY;
  if (value % DAY !== 0n || utc0 >= value) return false; const days = (value - utc0) / DAY; if (days <= 90n) return true;
  if (days <= 360n) return (days - 90n + (utc0 % WEEK) / DAY) % 6n === 0n; if (days <= 2160n) return (days - 360n + (utc0 % MONTH) / DAY) % 30n === 0n;
  if (days <= 7650n) return (days - 2160n + (utc0 % QUARTER) / DAY) % 90n === 0n; return false; }
function encodeNoNTokenError() { return errorAbi.encodeErrorResult("Error", ["No nToken for currency"]); }
function normalizeRpcError(error) { const data = error?.data; if (typeof data === "string" && data.length <= 1026 && /^0x(?:[0-9a-fA-F]{2})*$/u.test(data)) { try { const decoded = errorAbi.decodeErrorResult("Error", data);
    if (decoded[0] === "No nToken for currency" && data.toLowerCase() === encodeNoNTokenError().toLowerCase()) return "NO_NTOKEN_REVERT"; } catch (_) {} } return "RPC_UNAVAILABLE"; }
function normalizeRpcResponse(row) { if (row?.ok === true) return row; if (row?.error) return { ok: false, reason: normalizeRpcError(row.error), result: null }; return { ok: false, reason: row?.reason || "RPC_UNAVAILABLE", result: null }; }

function seedPolicy() { return { allowFinalized: true, code: new Set([ADDRESSES.proxy]), storage: new Set([ADDRESSES.proxy]), calls: new Map([[ADDRESSES.proxy, new Set(PROXY_SELECTORS)]]) }; }
function clonePolicy(policy) { return { allowFinalized: policy.allowFinalized, code: new Set(policy.code), storage: new Set(policy.storage), calls: new Map([...policy.calls].map(([key, value]) => [key, new Set(value)])) }; }
function admit(policy, address, kind, selectors = []) { const normalized = normalizeAddress(address); if (!normalized) throw new Error("DYNAMIC_ADDRESS_INVALID"); if (kind === "code") policy.code.add(normalized);
  if (kind === "call") { if (!policy.calls.has(normalized)) policy.calls.set(normalized, new Set()); for (const selector of selectors) policy.calls.get(normalized).add(selector.toLowerCase()); } return normalized; }
function ensureAllowedRequest(method, params, policy = seedPolicy()) {
  if (DENIED_METHOD_PATTERN.test(method) || !["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call"].includes(method)) throw new Error("METHOD_NOT_ALLOWED");
  if (method === "eth_chainId") { if (!Array.isArray(params) || params.length) throw new Error("PARAMETERS_NOT_ALLOWED"); return true; }
  if (method === "eth_getBlockByNumber") { if (!Array.isArray(params) || params.length !== 2 || params[1] !== false) throw new Error("PARAMETERS_NOT_ALLOWED"); if (params[0] === "finalized") { if (!policy.allowFinalized) throw new Error("FINALIZED_NOT_ALLOWED"); } else numericTag(params[0]); return true; }
  if (method === "eth_getCode") { numericTag(params?.[1]); if (!policy.code.has(normalizeAddress(params?.[0]))) throw new Error("CODE_ADDRESS_NOT_ALLOWED"); return true; }
  if (method === "eth_getStorageAt") { numericTag(params?.[2]); if (!policy.storage.has(normalizeAddress(params?.[0])) || String(params?.[1]).toLowerCase() !== EIP1967_IMPLEMENTATION_SLOT) throw new Error("STORAGE_SLOT_NOT_ALLOWED"); return true; }
  const call = params?.[0]; numericTag(params?.[1]); if (!call || Object.keys(call).some((key) => !["to", "data"].includes(key))) throw new Error("CALL_SHAPE_NOT_ALLOWED");
  const selector = String(call.data || "").slice(0, 10).toLowerCase(), to = normalizeAddress(call.to); if (selector === INITIALIZE_SELECTOR || !policy.calls.get(to)?.has(selector)) throw new Error("CALL_TARGET_OR_SELECTOR_NOT_ALLOWED");
  if ((String(call.data || "").length - 2) / 2 > CAPS.callResultBytes) throw new Error("CALL_DATA_CAP_EXCEEDED"); return true;
}
function assertBatchSize(rows) { if (!Array.isArray(rows) || rows.length < 1 || rows.length > CAPS.batch) throw new Error("BATCH_CAP_EXCEEDED"); return true; }

function parseInventoryText(text) {
  if (Buffer.byteLength(text) > CAPS.inventoryBytes) throw new Error("INVENTORY_TOTAL_CAP_EXCEEDED"); const secrets = new Set(), found = [];
  const register = (raw, headers = {}, meta = {}) => { secrets.add(String(raw)); for (const [key, value] of Object.entries(headers || {})) { secrets.add(String(key)); secrets.add(String(value)); }
    let url; try { url = new URL(raw); } catch (_) { return; } if (url.protocol !== "https:" || url.username || url.password || url.hash) return;
    const mapping = meta.providerMapping; if (!mapping || mapping.status !== "sealed" || typeof mapping.operatorFamily !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(mapping.operatorFamily)) return;
    const tier = String(meta.serviceTier || meta.tier || "").toLowerCase(); if (!["premium", "enterprise", "archive"].includes(tier)) return;
    const family = mapping.operatorFamily; secrets.add(url.href); secrets.add(url.hostname.toLowerCase()); secrets.add(family); if (found.some((row) => row.url.href === url.href)) return;
    const chain = meta.chainId ?? meta.chain_id; if (chain !== undefined && ![1, "1", "0x1"].includes(chain)) return;
    found.push({ url, headers: Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [String(key), String(value)])), family, order: found.length }); };
  let parsed = null; try { parsed = JSON.parse(text); } catch (_) {}
  const visit = (value, inherited = {}, depth = 0) => { if (depth > CAPS.inventoryDepth) throw new Error("INVENTORY_DEPTH_CAP_EXCEEDED"); if (Array.isArray(value)) return value.forEach((item) => visit(item, inherited, depth + 1));
    if (!value || typeof value !== "object") return; const meta = { ...inherited, ...value }; for (const key of ["url", "endpoint", "rpcUrl"]) if (typeof value[key] === "string") register(value[key], value.headers, meta);
    for (const [key, item] of Object.entries(value)) if (!["url", "endpoint", "rpcUrl", "headers", "providerMapping"].includes(key) && item && typeof item === "object") visit(item, meta, depth + 1); };
  if (parsed !== null) visit(parsed); else for (const line of text.split(/\r?\n/u)) { if (Buffer.byteLength(line) > CAPS.inventoryRecordBytes) throw new Error("INVENTORY_RECORD_CAP_EXCEEDED"); let row; try { row = JSON.parse(line); } catch (_) { row = null; } if (row) visit(row); }
  const rows = [], families = new Set(), perFamily = new Map(); for (const row of found) { if (rows.length >= CAPS.poolInstances) break; if (!families.has(row.family) && families.size >= CAPS.poolFamilies) continue;
    const count = perFamily.get(row.family) || 0; if (count >= 2) continue; families.add(row.family); perFamily.set(row.family, count + 1); rows.push({ ...row, budgetKey: `candidate-${rows.length + 1}` }); }
  return { rows, secrets: [...secrets].filter((value) => value.length >= 4) };
}
async function parseInventoryStream(stream) { const chunks = []; let bytes = 0; try { for await (const chunk of stream) { const part = Buffer.from(chunk); bytes += part.length; if (bytes > CAPS.inventoryBytes) throw new Error("INVENTORY_TOTAL_CAP_EXCEEDED"); chunks.push(part); }
  return parseInventoryText(Buffer.concat(chunks).toString("utf8")); } finally { try { stream.destroy?.(); } catch (_) {} } }
function assertNoSecrets(value, secrets = []) { const text = JSON.stringify(value), lower = text.toLowerCase(); if (/(?:https?|wss?):\/\//iu.test(text)) throw new Error("PROVIDER_MATERIAL_IN_OUTPUT_URL");
  for (const key of ["endpoint", "provider", "hostname", "domain", "headers", "authorization"]) if (new RegExp(`"${key}"\\s*:`, "iu").test(text)) throw new Error("PROVIDER_MATERIAL_IN_OUTPUT_KEY");
  for (const secret of secrets) if (text.includes(secret) || lower.includes(secret.toLowerCase())) throw new Error("PROVIDER_MATERIAL_IN_OUTPUT_CORPUS"); return true; }

class Budget {
  constructor(now = Date.now, caps = CAPS) { this.now = now; this.caps = caps; this.start = now(); this.calls = 0; this.bytes = 0; this.byKey = new Map(); this.byPhase = {}; }
  row(key) { if (!this.byKey.has(key)) this.byKey.set(key, { calls: 0, responseBytes: 0, phases: {} }); return this.byKey.get(key); }
  call(key, phase) { if (this.now() - this.start > this.caps.wallMs) throw new Error("WALL_CLOCK_CAP_EXCEEDED"); const row = this.row(key); this.calls += 1; row.calls += 1; row.phases[phase] = (row.phases[phase] || 0) + 1; this.byPhase[phase] = (this.byPhase[phase] || 0) + 1;
    const fixed = ["qualificationChainId", "qualificationFinalized", "qualificationNumericPin", "qualificationCapability", "evidenceBase", "terminal"].reduce((sum, name) => sum + (row.phases[name] || 0), 0);
    if (fixed > this.caps.selectedBaseCalls) throw new Error("SELECTED_BASE_CALL_CAP_EXCEEDED"); if ((row.phases.evidenceConditional || 0) > this.caps.selectedConditionalCalls) throw new Error("SELECTED_CONDITIONAL_CALL_CAP_EXCEEDED"); }
  body(key, bytes) { if (bytes > this.caps.responseBytes) throw new Error("RESPONSE_BODY_CAP_EXCEEDED"); const row = this.row(key), nextEndpoint = row.responseBytes + bytes, nextAggregate = this.bytes + bytes;
    if (nextEndpoint > this.caps.endpointResponseBytes) throw new Error("ENDPOINT_RESPONSE_CAP_EXCEEDED"); if (nextAggregate > this.caps.aggregateResponseBytes) throw new Error("AGGREGATE_RESPONSE_CAP_EXCEEDED");
    row.responseBytes = nextEndpoint; this.bytes = nextAggregate; }
  summary() { return { calls: this.calls, responseBytes: this.bytes, byPhase: this.byPhase, retries: 0, withinCaps: true }; }
}
function productionPost(endpoint, payload, context) { const body = Buffer.from(JSON.stringify(payload)); if (body.length > CAPS.requestBytes) throw new Error("REQUEST_CAP_EXCEEDED");
  return new Promise((resolve) => { let settled = false, overCap = false, request, responseRef; const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); try { request?.destroy(); } catch (_) {} resolve(value); };
    const failBody = () => { if (overCap) return; overCap = true; try { responseRef?.destroy?.(); } catch (_) {} try { request?.destroy(); } catch (_) {} finish(null); };
    const timer = setTimeout(() => finish(null), CAPS.requestMs), options = { protocol: "https:", hostname: endpoint.url.hostname, port: endpoint.url.port || 443, path: `${endpoint.url.pathname}${endpoint.url.search}`,
      method: "POST", agent: false, headers: { ...endpoint.headers, "content-type": "application/json", accept: "application/json", "accept-encoding": "identity", "content-length": body.length } };
    try { request = (context.httpsRequest || https.request)(options, (response) => { responseRef = response; const chunks = []; let size = 0; response.on("data", (chunk) => { if (settled || overCap) return; try { const part = Buffer.from(chunk), nextSize = size + part.length;
          if (nextSize > CAPS.responseBytes) return failBody(); context.budget.body(endpoint.budgetKey, part.length); size = nextSize; chunks.push(part); } catch (_) { failBody(); } });
        response.on("error", () => failBody()); response.on("end", () => { if (overCap || settled) return; try { finish(response.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null); } catch (_) { finish(null); } }); }); request.on("error", () => finish(null)); request.end(body); } catch (_) { finish(null); } }); }
async function productionRpc(endpoint, method, params, context) { const request = { jsonrpc: "2.0", id: ++context.nextId, method, params }, row = await productionPost(endpoint, request, context);
  if (row?.jsonrpc !== "2.0" || row.id !== request.id) return { ok: false, reason: "RPC_UNAVAILABLE", result: null }; return Object.hasOwn(row, "error") ? { ok: false, reason: normalizeRpcError(row.error), result: null } : { ok: true, result: row.result }; }
async function productionRpcBatch(endpoint, requests, context) { const payload = requests.map((request) => ({ jsonrpc: "2.0", id: ++context.nextId, method: request.method, params: request.params })), rows = await productionPost(endpoint, payload, context);
  if (!Array.isArray(rows)) return requests.map(() => ({ ok: false, reason: "RPC_BATCH_UNAVAILABLE", result: null })); const byId = new Map(rows.map((row) => [row.id, row]));
  return payload.map((request) => { const row = byId.get(request.id); if (row?.jsonrpc !== "2.0") return { ok: false, reason: "RPC_BATCH_ITEM_UNAVAILABLE", result: null }; return Object.hasOwn(row, "error") ? { ok: false, reason: normalizeRpcError(row.error), result: null } : { ok: true, result: row.result }; }); }
async function rpc(endpoint, method, params, context) { ensureAllowedRequest(method, params, context.policy); context.budget.call(endpoint.budgetKey, context.phase); return normalizeRpcResponse(await (context.rpc || productionRpc)(endpoint, method, params, context)); }
async function rpcBatch(endpoint, requests, context) { assertBatchSize(requests); for (const request of requests) { ensureAllowedRequest(request.method, request.params, context.policy); context.budget.call(endpoint.budgetKey, context.phase); }
  return (await (context.rpcBatch || (context.rpc ? async (ep, rows, ctx) => Promise.all(rows.map((row) => context.rpc(ep, row.method, row.params, ctx))) : productionRpcBatch))(endpoint, requests, context)).map(normalizeRpcResponse); }
async function requiredRpc(endpoint, method, params, context) { const row = await rpc(endpoint, method, params, context); if (!row?.ok) throw new Error(row?.reason || "RPC_CALL_FAILED"); return row.result; }
function decodeResult(iface, name, raw) { if (typeof raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(raw) || (raw.length - 2) / 2 > CAPS.callResultBytes) throw new Error("CALL_RESULT_CAP_EXCEEDED");
  try { const decoded = iface.decodeFunctionResult(name, raw); return decoded.length === 1 ? decoded[0] : decoded; } catch (_) { throw new Error(`ABI_DECODE_INVALID_${name}`); } }
async function callDecoded(endpoint, address, iface, name, args, tag, context) { const raw = await requiredRpc(endpoint, "eth_call", [{ to: address, data: iface.encodeFunctionData(name, args) }, numericTag(tag)], context); return decodeResult(iface, name, raw); }

function capabilityRequests(tag) { return [
  { method: "eth_getCode", params: [ADDRESSES.proxy, tag] },
  { method: "eth_getStorageAt", params: [ADDRESSES.proxy, EIP1967_IMPLEMENTATION_SLOT, tag] },
  { method: "eth_call", params: [{ to: ADDRESSES.proxy, data: proxyAbi.encodeFunctionData("getImplementation", []) }, tag] },
  { method: "eth_call", params: [{ to: ADDRESSES.proxy, data: viewsAbi.encodeFunctionData("nTokenAddress", [1]) }, tag] }
]; }
function parseCapability(rows, pin) { try { if (!Array.isArray(rows) || rows.length !== 4 || rows.some((row) => !row.ok)) return null; const proxyCode = rows[0].result, code = codeRecord(proxyCode), slot = storageAddress(rows[1].result),
    getter = normalizeAddress(decodeResult(proxyAbi, "getImplementation", rows[2].result)), nToken1 = normalizeAddress(decodeResult(viewsAbi, "nTokenAddress", rows[3].result));
    if (!code?.present || !slot || slot !== getter || !nToken1) return null; return { pin, proxyCode, proxyCodeRecord: code, router: getter, slot, nToken1 }; } catch (_) { return null; } }
function capabilityKey(value) { return value ? `${JSON.stringify(value.pin)}:${value.proxyCodeRecord.sha256}:${value.router}:${value.nToken1}` : ""; }
async function qualifyDescriptors(rows, context) {
  const pool = rows.slice(0, CAPS.poolInstances), finalized = []; context.policy = seedPolicy();
  for (const endpoint of pool) { context.phase = "qualificationChainId"; const chain = await rpc(endpoint, "eth_chainId", [], context); let chainOne = false; try { chainOne = chain.ok && BigInt(chain.result) === 1n; } catch (_) {}
    if (!chainOne) continue; context.phase = "qualificationFinalized"; const row = await rpc(endpoint, "eth_getBlockByNumber", ["finalized", false], context), pin = row.ok ? parseHeader(row.result) : null; if (pin) finalized.push({ endpoint, finalized: pin }); }
  if (finalized.length < 2) return { ok: false, reason: "CAPABILITY_POOL_INSUFFICIENT", selected: [], rejectedCalls: 0, counts: { poolInstances: pool.length, finalizedCapable: finalized.length } };
  const p = finalized.reduce((min, row) => BigInt(row.finalized.number) < min ? BigInt(row.finalized.number) : min, BigInt(finalized[0].finalized.number)), tag = hexQuantity(p), accepted = [], rejected = [];
  for (const candidate of finalized) { if (rejected.reduce((sum, row) => sum + row.calls, 0) + 4 > CAPS.rejectedQualificationCalls) break;
    context.phase = "qualificationNumericPin"; const headerRow = await rpc(candidate.endpoint, "eth_getBlockByNumber", [tag, false], context), pin = headerRow.ok ? parseHeader(headerRow.result) : null;
    context.phase = "qualificationCapability"; const batchRows = await rpcBatch(candidate.endpoint, capabilityRequests(tag), context), capability = pin?.number === p.toString() ? parseCapability(batchRows, pin) : null;
    if (!capability) { rejected.push({ calls: 4 }); continue; } accepted.push({ ...candidate, pin, capability });
    const groups = new Map(); for (const row of accepted) { const key = capabilityKey(row.capability); if (!groups.has(key)) groups.set(key, []); if (!groups.get(key).some((item) => item.endpoint.family === row.endpoint.family)) groups.get(key).push(row); }
    const group = [...groups.values()].find((value) => value.length >= 2); if (group) { const selected = group.slice(0, 2), replacements = accepted.indexOf(selected[1]) - 1 + rejected.length;
      selected.forEach((row) => { row.endpoint.qualificationFixedCalls = 7; }); return { ok: true, selected, pin: selected[0].pin, tag, rejectedCalls: rejected.reduce((sum, row) => sum + row.calls, 0),
        counts: { poolInstances: pool.length, poolFamilies: new Set(pool.map((row) => row.family)).size, finalizedCapable: finalized.length, capabilityAccepted: accepted.length, selectedFamilies: 2, replacements } }; }
  }
  return { ok: false, reason: "TWO_CAPABILITY_CONSENSUS_FAMILIES_UNAVAILABLE", selected: [], rejectedCalls: rejected.reduce((sum, row) => sum + row.calls, 0), counts: { poolInstances: pool.length, finalizedCapable: finalized.length } };
}

function runtimeManifest() { return JSON.parse(fs.readFileSync(workspacePath(RUNTIME_MANIFEST_REL), "utf8")); }
function wordFor(value, length) { const address = normalizeAddress(value); if (!address) return null; const hex = address.slice(2); return length === 20 ? hex : length === 32 ? hex.padStart(64, "0") : null; }
function validateLibrarySelfReference(model) { if (model.contractKind !== "library") return model.librarySelfReference === null; const expected = `73${"00".repeat(20)}3014`, reference = model.librarySelfReference;
  if (!reference || reference.start !== 1 || reference.length !== 20 || reference.exactPrefix !== expected || !model.runtimeTemplate.startsWith(expected)) throw new Error("LIBRARY_SELF_REFERENCE_INVALID"); return true; }
function declaredRanges(model) { const out = []; for (const item of model.linkReferences) for (const range of item.ranges) out.push({ kind: "link", name: item.libraryName, start: range.start, length: range.length });
  for (const item of model.immutableReferences) for (const range of item.ranges) out.push({ kind: "immutable", name: item.name || item.astId, start: range.start, length: range.length });
  validateLibrarySelfReference(model); if (model.librarySelfReference) out.push({ kind: "librarySelf", name: model.contractName, start: model.librarySelfReference.start, length: model.librarySelfReference.length }); return out.sort((a, b) => a.start - b.start); }
function substituteRuntime(model, links = {}, immutables = {}, librarySelf = {}) { const chars = model.runtimeTemplate.split(""); let complete = true; for (const range of declaredRanges(model)) { const value = range.kind === "link" ? links[range.name] : range.kind === "immutable" ? immutables[range.name] : librarySelf[range.name], word = wordFor(value, range.length);
    if (!word) { complete = false; continue; } chars.splice(range.start * 2, range.length * 2, ...word); } const value = chars.join(""); return { complete: complete && /^[0-9a-fA-F]*$/u.test(value), code: complete && /^[0-9a-fA-F]*$/u.test(value) ? `0x${value.toLowerCase()}` : null }; }
function cborLength(buffer, state, ai) { if (ai < 24) return ai; const widths = { 24: 1, 25: 2, 26: 4, 27: 8 }, width = widths[ai]; if (!width || state.at + width > buffer.length) throw new Error("CBOR_LENGTH_INVALID");
  let value = 0n; for (let i = 0; i < width; i += 1) value = (value << 8n) | BigInt(buffer[state.at++]); if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR_LENGTH_INVALID"); return Number(value); }
function consumeCbor(buffer, state, depth = 0) { if (depth > CAPS.cborDepth || ++state.items > CAPS.cborItems || state.at >= buffer.length) throw new Error("CBOR_BOUNDS_INVALID"); const first = buffer[state.at++], major = first >> 5, ai = first & 31;
  if (ai === 31) { if (![2, 3, 4, 5].includes(major)) throw new Error("CBOR_INDEFINITE_INVALID"); if (major === 2 || major === 3) { while (buffer[state.at] !== 0xff) { const before = state.at; consumeCbor(buffer, state, depth + 1); if ((buffer[before] >> 5) !== major) throw new Error("CBOR_CHUNK_INVALID"); } state.at += 1; return; }
    while (buffer[state.at] !== 0xff) { consumeCbor(buffer, state, depth + 1); if (major === 5) consumeCbor(buffer, state, depth + 1); } state.at += 1; return; }
  const length = cborLength(buffer, state, ai); if (major <= 1 || major === 7) return; if (major === 2 || major === 3) { state.at += length; if (state.at > buffer.length) throw new Error("CBOR_BOUNDS_INVALID"); return; }
  if (major === 4) { for (let i = 0; i < length; i += 1) consumeCbor(buffer, state, depth + 1); return; } if (major === 5) { for (let i = 0; i < length; i += 1) { consumeCbor(buffer, state, depth + 1); consumeCbor(buffer, state, depth + 1); } return; }
  if (major === 6) { consumeCbor(buffer, state, depth + 1); return; } throw new Error("CBOR_MAJOR_INVALID"); }
function cborBoundary(code) { try { if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/u.test(code) || code.length < 6) return null; const bytes = Buffer.from(code.slice(2), "hex"), payload = bytes.readUInt16BE(bytes.length - 2), start = bytes.length - payload - 2;
    if (payload < 1 || payload > CAPS.cborBytes || start < 0) return null; const body = bytes.subarray(start, bytes.length - 2), state = { at: 0, items: 0 }; if ((body[0] >> 5) !== 5) return null; consumeCbor(body, state); if (state.at !== body.length) return null;
    return { start, bytes: payload + 2, payloadBytes: payload, items: state.items, fullyConsumed: true, sha256: sha256(body) }; } catch (_) { return null; } }
function normalizedExecutable(code, boundary, ranges) { const bytes = Buffer.from(code.slice(2, 2 + boundary.start * 2), "hex"); for (const range of ranges) if (range.start + range.length <= bytes.length) bytes.fill(0, range.start, range.start + range.length); return bytes; }
function compareRuntime(actual, model, bindings = {}) { let record; try { record = codeRecord(actual); } catch (error) { return { level: "unknown", reason: error.message, code: null, rawRuntimeHex: null }; }
  const ranges = declaredRanges(model), actualCbor = cborBoundary(actual), expectedTemplate = model.runtimeTemplate, expectedHex = expectedTemplate.split(""); for (const range of ranges) expectedHex.splice(range.start * 2, range.length * 2, ..."00".repeat(range.length));
  const expectedCode = /^[0-9a-fA-F]+$/u.test(expectedHex.join("")) ? `0x${expectedHex.join("")}` : null, expectedCbor = expectedCode ? cborBoundary(expectedCode) : null;
  const base = { code: record, rawRuntimeHex: record?.bytes <= CAPS.runtimeBytes ? actual.toLowerCase() : null, cbor: actualCbor, recognizedRanges: ranges,
    reconstruction: { sourceName: model.sourceName, contractName: model.contractName, contractKind: model.contractKind, templateSha256: model.templateSha256, links: Object.keys(bindings.links || {}).sort(), immutables: Object.keys(bindings.immutables || {}).sort(), librarySelf: Object.keys(bindings.librarySelf || {}).sort() } };
  if (!record?.present) return { ...base, level: "mismatch", reason: "RUNTIME_EMPTY", firstDiffOffset: 0 };
  if (!actualCbor || !expectedCbor) return { ...base, level: "unknown", reason: "CBOR_INVALID_OR_UNCONSUMED", firstDiffOffset: null };
  const actualExec = Buffer.from(actual.slice(2, 2 + actualCbor.start * 2), "hex"), expectedExec = Buffer.from(expectedCode.slice(2, 2 + expectedCbor.start * 2), "hex"), covered = new Set(); for (const range of ranges) for (let i = range.start; i < range.start + range.length; i += 1) covered.add(i);
  let firstDiff = null; const max = Math.max(actualExec.length, expectedExec.length); for (let i = 0; i < max; i += 1) if (!covered.has(i) && actualExec[i] !== expectedExec[i]) { firstDiff = i; break; }
  base.normalizedExecutableSha256 = sha256(normalizedExecutable(actual, actualCbor, ranges)); base.expectedNormalizedExecutableSha256 = sha256(normalizedExecutable(expectedCode, expectedCbor, ranges)); base.firstDiffOffset = firstDiff;
  if (firstDiff !== null || actualExec.length !== expectedExec.length) return { ...base, level: "mismatch", reason: "BYTE_MISMATCH_OUTSIDE_DECLARED_RANGES" };
  for (const range of ranges) { const value = range.kind === "link" ? bindings.links?.[range.name] : range.kind === "immutable" ? bindings.immutables?.[range.name] : bindings.librarySelf?.[range.name], word = wordFor(value, range.length); if (word && actualExec.subarray(range.start, range.start + range.length).toString("hex") !== word) {
    return { ...base, level: "mismatch", reason: "KNOWN_BINDING_RANGE_MISMATCH", firstDiffOffset: range.start }; } }
  const built = substituteRuntime(model, bindings.links || {}, bindings.immutables || {}, bindings.librarySelf || {}); if (built.complete) { const builtBoundary = cborBoundary(built.code); if (!builtBoundary) return { ...base, level: "unknown", reason: "RECONSTRUCTION_CBOR_INVALID" };
    const builtExec = built.code.slice(0, 2 + builtBoundary.start * 2).toLowerCase(); if (actual.slice(0, 2 + actualCbor.start * 2).toLowerCase() !== builtExec) return { ...base, level: "mismatch", reason: "KNOWN_BINDING_RANGE_MISMATCH" };
    return actual.toLowerCase() === built.code ? { ...base, level: "full", reason: null } : { ...base, level: "executable", reason: "METADATA_DIFFERENT" }; }
  return { ...base, level: "structural", reason: "DECLARED_RANGES_PARTIALLY_UNBOUND" };
}
function executable(binding) { return ["full", "executable"].includes(binding?.level); }

function capDecoded(name, value) { if (name === "getActiveMarketsAtBlockTime" && value.length > CAPS.markets) throw new Error("MARKET_ARRAY_CAP_EXCEEDED"); if (name === "getNTokenPortfolio") {
  if (value[0].length > CAPS.liquidityTokens) throw new Error("LIQUIDITY_ARRAY_CAP_EXCEEDED"); if (value[1].length > CAPS.netfCashAssets) throw new Error("NET_FCASH_ARRAY_CAP_EXCEEDED"); } return value; }
function compactToken(value) { return { tokenAddress: normalizeAddress(value.tokenAddress), hasTransferFee: value.hasTransferFee, decimals: value.decimals.toString(), tokenType: Number(value.tokenType), deprecatedMaxCollateralBalance: value.deprecated_maxCollateralBalance.toString() }; }
function compactMarket(value) { return { maturity: value.maturity.toString(), totalfCash: value.totalfCash.toString(), totalPrimeCash: value.totalPrimeCash.toString(), totalLiquidity: value.totalLiquidity.toString(), lastImpliedRate: value.lastImpliedRate.toString(), oracleRate: value.oracleRate.toString(), previousTradeTime: value.previousTradeTime.toString() }; }
function compactAsset(value) { return { currencyId: Number(value.currencyId), maturity: value.maturity.toString(), assetType: value.assetType.toString(), notional: value.notional.toString(), storageState: Number(value.storageState) }; }
function allPositiveMarkets(markets) { return markets.length > 0 && markets.every((market) => BigInt(market.totalLiquidity) > 0n && BigInt(market.lastImpliedRate) > 0n && BigInt(market.oracleRate) > 0n); }
function zeroNamespace(markets) { return markets.length > 0 && markets.every((market) => BigInt(market.totalfCash) === 0n && BigInt(market.totalPrimeCash) === 0n && BigInt(market.totalLiquidity) === 0n &&
  BigInt(market.lastImpliedRate) === 0n && BigInt(market.oracleRate) === 0n && BigInt(market.previousTradeTime) === 0n); }
function currencyCoherent(idValue, state) {
  const errors = state.baseErrors || {}, currencyAndCashSuccess = errors.getCurrency === null && errors.getCashGroup === null && state.cashGroup;
  if (currencyAndCashSuccess && state.cashGroup.maxMarketIndex < 2) return { applicable: false, coherent: true, reason: "NOT_LISTED_OR_TOO_FEW_MARKETS" };
  if (currencyAndCashSuccess && errors.nTokenAddress === "NO_NTOKEN_REVERT") return { applicable: false, coherent: true, reason: "NO_NTOKEN_REVERT" };
  if (Object.values(errors).some((value) => value !== null)) return { applicable: null, coherent: false, reason: "BASE_VIEW_UNAVAILABLE" };
  if (!state.timingValid) return { applicable: true, coherent: false, reason: "LAST_INITIALIZED_AFTER_BLOCK" };
  if (!state.nToken || state.nToken === ZERO_ADDRESS) return { applicable: null, coherent: false, reason: "ZERO_NTOKEN_WITHOUT_RECOGNIZED_REVERT" };
  const max = state.cashGroup.maxMarketIndex; if (max > CAPS.markets) return { applicable: true, coherent: false, reason: "MAX_MARKET_INVALID" };
  if (state.nTokenAccount.currencyId !== idValue || state.liquidityTokens.length !== max || state.liquidityTokens.length > max || state.netfCashAssets.length > CAPS.netfCashAssets) return { applicable: true, coherent: false, reason: "IDENTITY_OR_LIQUIDITY_COUNT" };
  const storedExpected = expectedMaturities(state.initializedReferenceTime, max), currentExpected = expectedMaturities(state.referenceTime, max);
  for (let i = 0; i < state.liquidityTokens.length; i += 1) { const asset = state.liquidityTokens[i]; if (asset.currencyId !== idValue || asset.assetType !== String(2 + i) || asset.maturity !== storedExpected[i] || asset.storageState !== 0 || BigInt(asset.notional) <= 0n || (i && BigInt(asset.maturity) <= BigInt(state.liquidityTokens[i - 1].maturity))) return { applicable: true, coherent: false, reason: "STORED_PORTFOLIO_SHAPE" }; }
  for (let i = 0; i < state.netfCashAssets.length; i += 1) { const asset = state.netfCashAssets[i]; if (asset.currencyId !== idValue || asset.assetType !== "1" || asset.storageState !== 0 || BigInt(asset.notional) === 0n || !isValidBitmapMaturity(state.lastInitializedTime, asset.maturity) || (i && BigInt(asset.maturity) <= BigInt(state.netfCashAssets[i - 1].maturity))) return { applicable: true, coherent: false, reason: "NET_FCASH_SHAPE" }; }
  if (state.markets.length !== max) return { applicable: true, coherent: false, reason: "CURRENT_MARKET_COUNT" };
  for (let i = 0; i < state.markets.length; i += 1) if (state.markets[i].maturity !== currentExpected[i]) return { applicable: true, coherent: false, reason: "CURRENT_MARKET_MATURITY" };
  return { applicable: true, coherent: true, reason: null }; }
function classifyCurrency(input) { if (!input || !["SOURCE_BOUND", "CONFIG_DRIFT_BOUND"].includes(input.sourceState) || !input.coherence?.coherent) return "STATE_INCONSISTENT_UNKNOWN"; if (input.coherence.applicable === false) return "NOT_APPLICABLE";
  const lag = input.lagQuarters === null ? null : BigInt(input.lagQuarters); if (lag === null || lag < 0n) return "STATE_INCONSISTENT_UNKNOWN";
  if (lag === 0n) return allPositiveMarkets(input.markets) ? "CURRENT_HEALTHY" : "STATE_INCONSISTENT_UNKNOWN";
  if (lag === 1n) { const first = input.liquidityTokens[0]; return first && first.maturity === input.referenceTime && input.liquidityTokens.every((asset) => BigInt(asset.notional) > 0n) && zeroNamespace(input.markets) ? "DUE_BUT_RECOVERABLE" : "STATE_INCONSISTENT_UNKNOWN"; }
  const oldStored = input.liquidityTokens[0] && BigInt(input.liquidityTokens[0].maturity) < BigInt(input.referenceTime) && input.liquidityTokens.every((asset) => BigInt(asset.notional) > 0n),
    historical = input.historicalMarkets || [], historicalExpected = expectedMaturities(input.initializedReferenceTime, input.cashGroup.maxMarketIndex),
    oldHistorical = historical.length === input.cashGroup.maxMarketIndex && historical.every((market, index) => market.maturity === historicalExpected[index]) && BigInt(historical[0].maturity) < BigInt(input.referenceTime) && allPositiveMarkets(historical);
  return lag >= 2n && oldStored && zeroNamespace(input.markets) && oldHistorical ? "MISSED_QUARTER_TRIGGER_PRESENT" : "STATE_INCONSISTENT_UNKNOWN"; }

async function captureTopology(endpoint, qualification, tag, context) {
  const manifest = runtimeManifest(), anchor = qualification.capability, policy = seedPolicy(); policy.allowFinalized = false; admit(policy, anchor.router, "code"); admit(policy, anchor.router, "call", [...ROUTER_SELECTORS]); context.policy = policy; context.phase = "evidenceBase";
  const rawCode = { proxy: anchor.proxyCode, router: await requiredRpc(endpoint, "eth_getCode", [anchor.router, tag], context) };
  const initialize = normalizeAddress(await callDecoded(endpoint, anchor.router, routerAbi, "INITIALIZE_MARKET", [], tag, context)), views = normalizeAddress(await callDecoded(endpoint, anchor.router, routerAbi, "VIEWS", [], tag, context));
  for (const address of [initialize, views]) { admit(policy, address, "code"); admit(policy, address, "call", [LIB_SELECTOR]); }
  const nTokenMint = normalizeAddress(await callDecoded(endpoint, initialize, libAbi, "getLibInfo", [], tag, context)), freeCollateral = normalizeAddress(await callDecoded(endpoint, views, libAbi, "getLibInfo", [], tag, context));
  for (const address of [nTokenMint, freeCollateral]) admit(policy, address, "code");
  rawCode.initializeMarkets = await requiredRpc(endpoint, "eth_getCode", [initialize, tag], context); rawCode.views = await requiredRpc(endpoint, "eth_getCode", [views, tag], context);
  rawCode.nTokenMint = await requiredRpc(endpoint, "eth_getCode", [nTokenMint, tag], context); rawCode.freeCollateral = await requiredRpc(endpoint, "eth_getCode", [freeCollateral, tag], context);
  const routes = {}; for (const selector of ROUTED_SELECTORS) routes[selector] = normalizeAddress(await callDecoded(endpoint, anchor.router, routerAbi, "getRouterImplementation", [selector], tag, context));
  const bindings = { proxy: compareRuntime(rawCode.proxy, manifest.contracts.proxy), router: compareRuntime(rawCode.router, manifest.contracts.router, { immutables: { INITIALIZE_MARKET: initialize, VIEWS: views } }),
    initializeMarkets: compareRuntime(rawCode.initializeMarkets, manifest.contracts.initializeMarkets, { links: { nTokenMintAction: nTokenMint }, librarySelf: { InitializeMarketsAction: initialize } }), views: compareRuntime(rawCode.views, manifest.contracts.views, { links: { FreeCollateralExternal: freeCollateral } }),
    nTokenMint: compareRuntime(rawCode.nTokenMint, manifest.contracts.nTokenMint, { librarySelf: { nTokenMintAction: nTokenMint } }), freeCollateral: compareRuntime(rawCode.freeCollateral, manifest.contracts.freeCollateral, { librarySelf: { FreeCollateralExternal: freeCollateral } }) };
  const routeAgreement = routes[INITIALIZE_SELECTOR] === initialize && VIEW_NAMES.every((name) => routes[viewsAbi.getFunction(name).selector.toLowerCase()] === views), slotGetterAgreement = anchor.slot === anchor.router;
  const configDrift = { router: anchor.router !== ADDRESSES.router, initializeMarkets: initialize !== ADDRESSES.initializeMarkets, views: views !== ADDRESSES.views, nTokenMint: nTokenMint !== ADDRESSES.nTokenMint, freeCollateral: freeCollateral !== ADDRESSES.freeCollateral };
  const required = [bindings.proxy, bindings.router, bindings.initializeMarkets, bindings.nTokenMint, bindings.views], unknown = required.some((row) => row.level === "unknown"), mismatch = !slotGetterAgreement || !routeAgreement || required.some((row) => row.level === "mismatch"),
    bound = !unknown && !mismatch && executable(bindings.proxy) && ["full", "executable", "structural"].includes(bindings.router.level) && executable(bindings.initializeMarkets) && executable(bindings.nTokenMint) && executable(bindings.views);
  const sourceState = mismatch ? "SOURCE_MISMATCH" : unknown || !bound ? "BINDING_UNKNOWN" : Object.values(configDrift).some(Boolean) ? "CONFIG_DRIFT_BOUND" : "SOURCE_BOUND";
  return { actual: { proxy: ADDRESSES.proxy, router: anchor.router, initializeMarkets: initialize, views, nTokenMint, freeCollateral }, proxy: { implementationGetter: anchor.router, implementationSlot: anchor.slot, upperTwelveBytesZero: true, agreement: slotGetterAgreement },
    routes, routeAgreement, configDrift, runtimes: bindings, sourceState };
}
async function safeView(label, fn, errors) { try { const value = await fn(); errors[label] = null; return value; } catch (error) { errors[label] = String(error?.message || "VIEW_UNAVAILABLE").replace(/[^A-Z0-9_]/giu, "_").slice(0, 64); return null; } }
async function captureCurrency(endpoint, tag, timestamp, idValue, sourceState, context, cachedNToken) {
  context.phase = "evidenceBase"; const errors = {}, currency = await safeView("getCurrency", () => callDecoded(endpoint, ADDRESSES.proxy, viewsAbi, "getCurrency", [idValue], tag, context), errors),
    cash = await safeView("getCashGroup", () => callDecoded(endpoint, ADDRESSES.proxy, viewsAbi, "getCashGroup", [idValue], tag, context), errors),
    marketsRaw = await safeView("getActiveMarketsAtBlockTime", async () => capDecoded("getActiveMarketsAtBlockTime", await callDecoded(endpoint, ADDRESSES.proxy, viewsAbi, "getActiveMarketsAtBlockTime", [idValue, Number(timestamp)], tag, context)), errors),
    nTokenValue = cachedNToken !== undefined ? (errors.nTokenAddress = null, cachedNToken) : await safeView("nTokenAddress", () => callDecoded(endpoint, ADDRESSES.proxy, viewsAbi, "nTokenAddress", [idValue], tag, context), errors), nToken = normalizeAddress(nTokenValue) || ZERO_ADDRESS,
    account = await safeView("getNTokenAccount", () => callDecoded(endpoint, ADDRESSES.proxy, viewsAbi, "getNTokenAccount", [nToken], tag, context), errors),
    portfolio = await safeView("getNTokenPortfolio", async () => capDecoded("getNTokenPortfolio", await callDecoded(endpoint, ADDRESSES.proxy, viewsAbi, "getNTokenPortfolio", [nToken], tag, context)), errors);
  const fallbackTiming = timing(0, timestamp), accountTiming = account ? timing(account.lastInitializedTime, timestamp) : fallbackTiming;
  const state = { currencyId: idValue, baseErrors: errors, assetToken: currency ? compactToken(currency[0]) : null, underlyingToken: currency ? compactToken(currency[1]) : null,
    cashGroup: cash ? { maxMarketIndex: Number(cash.maxMarketIndex), rateOracleTimeWindow5Min: Number(cash.rateOracleTimeWindow5Min) } : null,
    markets: marketsRaw ? marketsRaw.map(compactMarket) : [], nToken, nTokenAccount: account ? { currencyId: Number(account.currencyId), totalSupply: account.totalSupply.toString(), lastInitializedTime: account.lastInitializedTime.toString() } : null,
    liquidityTokens: portfolio ? portfolio[0].map(compactAsset) : [], netfCashAssets: portfolio ? portfolio[1].map(compactAsset) : [], ...accountTiming, historicalMarkets: [] };
  const coherence = currencyCoherent(idValue, state); const triggerCandidate = coherence.coherent && coherence.applicable && state.lagQuarters !== null && BigInt(state.lagQuarters) >= 2n && state.liquidityTokens[0] && BigInt(state.liquidityTokens[0].maturity) < BigInt(state.referenceTime) && zeroNamespace(state.markets);
  if (triggerCandidate) { context.phase = "evidenceConditional"; const historical = await safeView("historicalMarkets", async () => capDecoded("getActiveMarketsAtBlockTime", await callDecoded(endpoint, ADDRESSES.proxy, viewsAbi, "getActiveMarketsAtBlockTime", [idValue, Number(BigInt(state.initializedReferenceTime))], tag, context)), errors);
    state.historicalMarkets = historical ? historical.map(compactMarket) : []; }
  state.coherence = currencyCoherent(idValue, state); state.classification = classifyCurrency({ ...state, sourceState }); return state;
}
async function captureFamily(selected, pin, tag, context) { const topology = await captureTopology(selected.endpoint, selected, tag, context), currencies = [];
  for (const idValue of CURRENCY_IDS) currencies.push(await captureCurrency(selected.endpoint, tag, BigInt(pin.timestamp), idValue, topology.sourceState, context, idValue === 1 ? selected.capability.nToken1 : undefined)); return { topology, currencies }; }
function capturesEqual(a, b) { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)); }
async function terminalRecheck(selected, pin, tag, context) { const rows = []; for (const selectedRow of selected) { context.policy = seedPolicy(); context.policy.allowFinalized = false; context.phase = "terminal"; const row = await rpc(selectedRow.endpoint, "eth_getBlockByNumber", [tag, false], context); rows.push(row.ok ? parseHeader(row.result) : null); }
  return rows.length === 2 && rows.every((row) => samePin(row, pin)); }

function fileRecord(relative, normalizeRunner = false) { let bytes = fs.readFileSync(workspacePath(relative)); let normalization = null; if (normalizeRunner) { bytes = Buffer.from(bytes.toString("utf8").replace(/const EXPECTED_PACKAGE_AGGREGATE = "[0-9a-f]{64}";/u, `const EXPECTED_PACKAGE_AGGREGATE = "${"0".repeat(64)}";`)); normalization = "EXPECTED_PACKAGE_AGGREGATE_ZEROED"; }
  return { path: relative, bytes: bytes.length, sha256: sha256(bytes), normalization }; }
function loadedDependencyGraph() { return Object.keys(require.cache).map((file) => path.resolve(file)).filter((file) => file.includes(`${path.sep}tools${path.sep}node_modules${path.sep}`)).map((file) => fileRecord(path.relative(ROOT, file).replace(/\\/gu, "/"))).sort((a, b) => a.path.localeCompare(b.path)); }
function verifyRecords(records, paths) { return records.length === paths.length && records.every((record, index) => { if (record.path !== paths[index]) return false; const actual = fileRecord(record.path, record.normalization === "EXPECTED_PACKAGE_AGGREGATE_ZEROED"); return actual.bytes === record.bytes && actual.sha256 === record.sha256; }); }
function packageAggregate(manifest) { const rows = [...manifest.artifacts.map((row) => `artifacts:${row.path}:${row.sha256}`), ...manifest.runtimeDependencyGraph.map((row) => `runtime:${row.path}:${row.sha256}`), ...manifest.localInputs.map((row) => `localInputs:${row.path}:${row.sha256}`)]; return sha256(rows.sort().join("\n")); }
function verifyPackageBeforeConsumption() { const manifest = JSON.parse(fs.readFileSync(workspacePath(MANIFEST_REL), "utf8")); if (!/^[0-9a-f]{64}$/u.test(EXPECTED_PACKAGE_AGGREGATE) || EXPECTED_PACKAGE_AGGREGATE === "0".repeat(64) || manifest.aggregateSha256 !== EXPECTED_PACKAGE_AGGREGATE || packageAggregate(manifest) !== EXPECTED_PACKAGE_AGGREGATE) throw new Error("PACKAGE_AGGREGATE_MISMATCH");
  if (!verifyRecords(manifest.artifacts, REQUIRED_ARTIFACT_PATHS) || !verifyRecords(manifest.localInputs, LOCAL_INPUT_RELS)) throw new Error("PACKAGE_FILE_MISMATCH"); const graph = loadedDependencyGraph(); if (!verifyRecords(manifest.runtimeDependencyGraph, graph.map((row) => row.path))) throw new Error("PACKAGE_RUNTIME_GRAPH_MISMATCH"); return true; }
function validateRunId(value, now = Date.now()) { const match = /^notional-v3-stage-a-(\d{8}T\d{6}Z)-([0-9a-f]{32})$/u.exec(value || ""); if (!match) throw new Error("RUN_ID_INVALID");
  const date = new Date(`${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)}T${match[1].slice(9, 11)}:${match[1].slice(11, 13)}:${match[1].slice(13, 15)}Z`); if (!Number.isFinite(date.getTime()) || Math.abs(now - date.getTime()) > 900000) throw new Error("RUN_ID_NOT_FRESH"); return value; }
function writeDurableExclusive(file, bytes) { const fd = fs.openSync(file, "wx"); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function reservePublication(runId, now = Date.now(), outputRoot = workspacePath(OUTPUT_DIR_REL)) { const directory = path.join(outputRoot, `${STEM}-${runId}`); fs.mkdirSync(directory);
  const fallback = { schemaVersion: 2, findingId: FINDING_ID, status: "NOTIONAL_STAGE_A_REJECTED", terminal: true, fallbackPreallocated: true, runId, reason: "CAPTURE_DID_NOT_PUBLISH_FINAL_RESULT", reservedAt: new Date(now).toISOString() }, bytes = Buffer.from(`${JSON.stringify(fallback, null, 2)}\n`);
  const fallbackPath = path.join(directory, "fallback-terminal-rejected.json"), hashPath = path.join(directory, "fallback-terminal-rejected.sha256"); writeDurableExclusive(fallbackPath, bytes); writeDurableExclusive(hashPath, Buffer.from(`${sha256(bytes)}  fallback-terminal-rejected.json\n`));
  return { directory, fallbackPath, fallbackSha256: sha256(bytes), resultPath: path.join(directory, "result.json"), resultHashPath: path.join(directory, "result.sha256"), publicationPath: path.join(directory, "publication.json") }; }
function consumeOnce(markerPath, runId, reservation, now = Date.now()) { const payload = { schemaVersion: 2, findingId: FINDING_ID, packageAggregate: EXPECTED_PACKAGE_AGGREGATE, consumed: true, runId,
    fallbackArtifact: path.basename(reservation.fallbackPath), fallbackSha256: reservation.fallbackSha256, consumedAt: new Date(now).toISOString() }, value = `${JSON.stringify(payload)}\n`; writeDurableExclusive(markerPath, Buffer.from(value));
  let decoded; try { decoded = JSON.parse(fs.readFileSync(markerPath, "utf8")); } catch (_) { throw new Error("MARKER_READBACK_INVALID"); } if (decoded.packageAggregate !== EXPECTED_PACKAGE_AGGREGATE || decoded.runId !== runId || decoded.fallbackSha256 !== reservation.fallbackSha256) throw new Error("MARKER_READBACK_INVALID"); return true; }
function publishReserved(reservation, value) { const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); if (bytes.length > CAPS.outputBytes) throw new Error("OUTPUT_CAP_EXCEEDED"); const resultSha256 = sha256(bytes);
  writeDurableExclusive(reservation.resultPath, bytes); writeDurableExclusive(reservation.resultHashPath, Buffer.from(`${resultSha256}  result.json\n`));
  writeDurableExclusive(reservation.publicationPath, Buffer.from(`${JSON.stringify({ schemaVersion: 1, activeArtifact: "result.json", resultSha256 })}\n`)); return { resultSha256 }; }
function exclusiveJson(file, value) { const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); if (bytes.length > CAPS.outputBytes) throw new Error("OUTPUT_CAP_EXCEEDED"); writeDurableExclusive(file, bytes); return true; }
function reasonCode(error) { return String(error?.message || error || "UNKNOWN").toUpperCase().replace(/[^A-Z0-9_]/gu, "_").slice(0, 96) || "UNKNOWN"; }
function dryPreflight() { return { schemaVersion: 2, findingId: FINDING_ID, status: "STAGE_A_OFFLINE_PACKAGE_VALIDATED_CAPTURE_NOT_EXECUTED", source: { commit: SOURCE_COMMIT, tree: SOURCE_TREE }, networkReads: 0, inventoryReads: 0, captureExecuted: false,
  oneShot: { order: ["package-verify", "exclusive-output-reservation-with-durable-fallback", "durable-consumed-marker", "single-inventory-open"], atomicFinalPublication: true, fallbackHashInMarker: true, retryInPlace: false },
  qualification: { maximumInstances: 6, maximumOperatorFamilies: 4, operatorFamilyMapping: "explicit-sealed-only", hostnameFallback: false, premiumInference: false, chainAndFinalizedOnce: true, commonP: "minimum-finalized-height-of-qualified-pool",
    numericHeaderAndOneFourItemCapabilityBatchPerAttempt: true, capability: ["proxy-code", "implementation-slot", "proxy-getImplementation", "harmless-nTokenAddress-1"], finalSelectionAfterCapabilityConsensus: true, replacementOnlyDuringQualification: true },
  dynamicAllowlist: { publicSeed: "factory/proxy", routerFromSlotGetterConsensus: true, modulesFromActualImmutableAndLibraryGetters: true, configuredAddressesNotRequiredForSourceBinding: true },
  evidence: { numericPOnly: true, currencyIds: CURRENCY_IDS, exactBaseViews: VIEW_NAMES, selectedFixedCallsPerFamily: 77, conditionalMaximum: 9, initializeMarketsCall: false }, caps: CAPS,
  runtimeBinding: { selectorOnlyStructural: false, bytewiseOutsideCompilerDeclaredRanges: true, cborFullyParsedAndConsumed: true, recognizedRangeNormalizationOnly: true, rawRuntimeHexPublished: true, firstDiffOffset: true,
    librarySelfReference: "AST-library plus exact solc-0.7.6 PUSH20-zero20-ADDRESS-EQ prefix; offset 1 length 20", dynamicallyBoundLibraries: ["InitializeMarketsAction", "nTokenMintAction", "FreeCollateralExternal"] },
  timing: { preserveBlockTimestampT: true, initializedReference: "I=floor(L/Q)*Q", currentReference: "R=floor(T/Q)*Q", lag: "(R-I)/Q", rawLastInitializedAfterBlock: "invalid", historicalQueryTime: "I" },
  noNToken: { recognizedRevert: "exact bounded ABI Error(No nToken for currency)", rawErrorPersisted: false, notApplicableRequiresCurrencyAndCashGroupSuccess: true, allOtherReverts: "STATE_INCONSISTENT_UNKNOWN" },
  coherence: { exactCurrentMarketCount: true, fullyZeroLagOneAndTriggerNamespace: true, liquidityStorageStateZeroAndAllPositive: true, netfCashTypeOneStorageStateZeroNonzeroStrictOrder: true, bitmapMaturity: "DateTime.getBitNumFromMaturity lines 98-159 relative raw L" }, classifications: CLASSIFICATIONS, sourceStates: SOURCE_STATES,
  httpResponseCaps: { cumulativeAcrossChunks: true, exactBoundaryAccepted: true, crossingChunkPermanentlyRejected: true, validPrefixNeverParsedAfterOverflow: true, requestAndResponseDestroyed: true, transactionalEndpointAndAggregateCounters: true, overflowUsesDurableFallback: true },
  offlineValidation: { checks: 148, fixtureClasses: 16, fullMockedTwoFamilyCapture: true }, conclusions: { deploymentApplicability: null, economics: null, valueExtraction: null, promotable: false, fork: false, signing: false, mutation: false } }; }

async function runCapture(options, deps = {}) {
  const now = deps.now || Date.now, runId = validateRunId(options.runId, now()), markerPath = deps.markerPath || workspacePath(CONSUMPTION_MARKER_REL), outputRoot = deps.outputRoot || workspacePath(OUTPUT_DIR_REL);
  (deps.verifyPackage || verifyPackageBeforeConsumption)(); const reservation = (deps.reserve || reservePublication)(runId, now(), outputRoot); (deps.consume || consumeOnce)(markerPath, runId, reservation, now());
  let secrets = [], context = { budget: deps.budget || new Budget(now), nextId: 0, rpc: deps.rpc, rpcBatch: deps.rpcBatch, httpsRequest: deps.httpsRequest, policy: seedPolicy(), phase: "start" };
  const publish = deps.publish || publishReserved;
  try { const stream = (deps.createInventoryStream || (() => fs.createReadStream(workspacePath(INVENTORY_REL), { highWaterMark: 65536 })))(), inventory = await parseInventoryStream(stream); secrets = inventory.secrets;
    const qualification = await (deps.qualify || qualifyDescriptors)(inventory.rows, context); if (!qualification.ok) throw new Error(qualification.reason); const captures = [];
    for (const selected of qualification.selected) captures.push(await (deps.captureFamily || captureFamily)(selected, qualification.pin, qualification.tag, context)); if (!capturesEqual(captures[0], captures[1])) throw new Error("CROSS_FAMILY_EVIDENCE_DISAGREEMENT");
    if (!await (deps.terminalRecheck || terminalRecheck)(qualification.selected, qualification.pin, qualification.tag, context)) throw new Error("TERMINAL_PIN_RECHECK_FAILED");
    const result = { schemaVersion: 2, findingId: FINDING_ID, status: "NOTIONAL_STAGE_A_COMPLETE", terminal: true, runId, source: { commit: SOURCE_COMMIT, tree: SOURCE_TREE }, pin: qualification.pin,
      qualification: { ...qualification.counts, rejectedCalls: qualification.rejectedCalls, comparableRoles: ["source-1", "source-2"] }, evidence: captures[0], familyAgreement: true, budget: context.budget.summary(), limitations: { readOnly: true, noInitializeMarketsCall: true, noDeploymentInferenceOnMismatch: true } };
    assertNoSecrets(result, secrets); publish(reservation, result); return result;
  } catch (error) { const result = { schemaVersion: 2, findingId: FINDING_ID, status: "NOTIONAL_STAGE_A_REJECTED", terminal: true, runId, reason: reasonCode(error), evidence: null, budget: context.budget.summary(), limitations: { readOnly: true, noDeploymentInference: true } };
    try { assertNoSecrets(result, secrets); publish(reservation, result); } catch (_) { result.reason = "FINAL_PUBLICATION_FAILED_FALLBACK_ACTIVE"; result.fallbackActive = true; } return result; }
}
function parseArgs(argv) { if (argv.length !== 3 || argv[0] !== CAPTURE_FLAG || argv[1] !== "--run-id" || !argv[2]) throw new Error("EXACT_CAPTURE_COMMAND_REQUIRED"); return { runId: argv[2] }; }

module.exports = { ROOT, STEM, FINDING_ID, SOURCE_ROOT, SOURCE_COMMIT, SOURCE_TREE, CAPTURE_FLAG, EXPECTED_PACKAGE_AGGREGATE, INVENTORY_REL, FIXTURE_REL, RUNTIME_MANIFEST_REL, PREFLIGHT_REL, MANIFEST_REL, REPORT_REL, CONSUMPTION_MARKER_REL,
  REQUIRED_ARTIFACT_PATHS, LOCAL_INPUT_RELS, CAPS, QUARTER, MARKET_OFFSETS, CURRENCY_IDS, CLASSIFICATIONS, SOURCE_STATES, ADDRESSES, EIP1967_IMPLEMENTATION_SLOT, INITIALIZE_SELECTOR, VIEW_NAMES, ROUTED_SELECTORS,
  proxyAbi, routerAbi, libAbi, viewsAbi, errorAbi, sha256, stable, normalizeAddress, numericTag, hexQuantity, parseHeader, samePin, storageAddress, codeRecord, timing, expectedMaturities, isValidBitmapMaturity, encodeNoNTokenError, normalizeRpcError, normalizeRpcResponse, seedPolicy, clonePolicy, admit, ensureAllowedRequest, assertBatchSize,
  parseInventoryText, parseInventoryStream, assertNoSecrets, Budget, productionPost, rpc, rpcBatch, decodeResult, callDecoded, capabilityRequests, parseCapability, qualifyDescriptors, runtimeManifest, declaredRanges, substituteRuntime, cborBoundary, normalizedExecutable,
  validateLibrarySelfReference, compareRuntime, executable, capDecoded, compactToken, compactMarket, compactAsset, allPositiveMarkets, zeroNamespace, currencyCoherent, classifyCurrency, captureTopology, captureCurrency, captureFamily, capturesEqual, terminalRecheck,
  fileRecord, loadedDependencyGraph, verifyRecords, packageAggregate, verifyPackageBeforeConsumption, validateRunId, reservePublication, consumeOnce, publishReserved, exclusiveJson, reasonCode, dryPreflight, runCapture, parseArgs };
if (require.main === module) runCapture(parseArgs(process.argv.slice(2))).then((result) => process.stdout.write(`${result.status}\n`)).catch((error) => { process.stderr.write(`${reasonCode(error)}\n`); process.exitCode = 1; });
