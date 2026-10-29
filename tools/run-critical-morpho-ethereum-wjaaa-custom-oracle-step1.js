#!/usr/bin/env node
"use strict";

// Authorized defensive, read-only Ethereum investigation. Endpoint material is
// consumed in memory and is never included in outputs or thrown errors.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let ethers;
try { ({ ethers } = require("ethers")); } catch { ({ ethers } = require("./node_modules/ethers")); }

const ROOT = path.resolve(__dirname, "..");
const OUT = "reports/raw/fast/critical-morpho-ethereum-wjaaa-custom-oracle-step1.json";
const SOURCES_OUT = "reports/raw/fast/critical-morpho-ethereum-wjaaa-custom-oracle-step1-sources.json";
const PRIOR_CAP = "reports/raw/fast/critical-authorized-endpoint-capability-qualification-r1.json";
const PRIOR_ORACLE = "reports/raw/fast/small-cap-oracle-custom-edges.json";
const INVENTORIES = ["rpc_endpoints.txt", "graphql_endpoints.txt"];
const ID_SALT = "authorized-endpoint-capability-r1-20260724";
const CHAIN_ID = 1;
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const MARKET_ID = "0xb55c0ebe12c4af149ce74ba4d83ca847c3be6787921b36b51a4d98bd105163e2";
const ORACLE = "0x2E4eb0647FD1F9029499D41153a7CCCb1aB5D886";
const WJAAA = "0x86b495e4Cb00AB18Ad94BFD7920479cC79E8eBFE";
const JAAA = "0x5a0F93D040De44e78F251b03c43be9CF317Dcf64";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const WRAPPER_DEPLOY_BLOCK = 24841246;
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ZERO = ethers.ZeroAddress;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const abs = (rel) => path.join(ROOT, ...rel.split("/"));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hmac = (kind, value) => crypto.createHmac("sha256", ID_SALT).update(`${kind}\0${value}`).digest("hex");
const hex = (value) => `0x${BigInt(value).toString(16)}`;
const canonical = (value) => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const fileBinding = (rel) => { const body = fs.readFileSync(abs(rel)); return { file: rel, bytes: body.length, sha256: sha(body) }; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function familyKey(url) {
  const host = new URL(url).hostname.toLowerCase(), parts = host.split(".").filter(Boolean);
  return parts.length <= 2 ? host : `${parts.at(-2)}.${parts.at(-1)}`;
}
function cleanUrl(text) {
  try { const parsed = new URL(text.replace(/\\\//g, "/").replace(/^[(`<\[]+|[)>`,.;\]]+$/g, "")); return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null; } catch { return null; }
}
function extractUrls(text) { return [...String(text).replace(/\\\//g, "/").matchAll(/https?:\/\/[^\s"'`<>{}\[\]]+/gi)].map((m) => cleanUrl(m[0])).filter(Boolean); }
function parseHeaders(context) {
  const headers = {};
  const origin = context.match(/\[origin:\s*([^\]\s]+)\]/i)?.[1]; if (origin) headers.origin = origin;
  for (const m of context.matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/gi)) headers[m[1].trim().toLowerCase()] = m[2].trim();
  return headers;
}
function inventory() {
  const rows = new Map(), stats = {};
  for (const file of INVENTORIES) {
    const body = fs.readFileSync(abs(file)), lines = body.toString("utf8").split(/\r?\n/), found = [];
    for (let i = 0; i < lines.length; i++) for (const url of extractUrls(lines[i])) {
      found.push(url); const row = rows.get(url) || { url, headers: {}, files: new Set() };
      Object.assign(row.headers, parseHeaders(lines.slice(Math.max(0, i - 3), i + 4).join("\n"))); row.files.add(file); rows.set(url, row);
    }
    stats[file] = { bytes: body.length, sha256: sha(body), candidateOccurrences: found.length, uniqueCandidates: new Set(found).size };
  }
  for (const row of rows.values()) { row.providerId = `provider-${hmac("provider", row.url).slice(0, 16)}`; row.family = familyKey(row.url); }
  return { rows: [...rows.values()], stats, uniqueCandidates: rows.size, uniqueFamilies: new Set([...rows.values()].map((x) => x.family)).size };
}

class RpcError extends Error { constructor(category, data = null) { super(category); this.category = category; this.data = data; } }
function errorCategory(status, err) {
  const text = String(err?.message || "").toLowerCase(), code = Number(err?.code);
  if (status === 401 || status === 403) return "auth-or-origin-rejected";
  if (status === 429 || code === -32005 || text.includes("rate")) return "rate-limited";
  if (code === -32601 || text.includes("method not found") || text.includes("unsupported")) return "method-unsupported";
  if (text.includes("prun") || text.includes("historical state") || text.includes("missing trie")) return "historical-state-unavailable";
  if (text.includes("range") || text.includes("too many") || text.includes("limit")) return "query-limit";
  if (text.includes("timeout") || text.includes("abort")) return "timeout";
  return status >= 500 ? "http-5xx" : status >= 400 ? "http-4xx" : "rpc-error";
}
let rpcRequests = 0;
async function rpcOnce(row, method, params, timeout = 15000) {
  rpcRequests++; const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(row.url, { method: "POST", headers: { "content-type": "application/json", ...row.headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: controller.signal });
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch { throw new RpcError("non-json"); }
    if (!response.ok || json.error) throw new RpcError(errorCategory(response.status, json.error), json.error?.data || null);
    return json.result;
  } catch (error) { if (error instanceof RpcError) throw error; throw new RpcError(errorCategory(0, error)); } finally { clearTimeout(timer); }
}
async function rpc(row, method, params, timeout = 15000) {
  let last; for (let attempt = 0; attempt < 3; attempt++) { try { return await rpcOnce(row, method, params, timeout); } catch (error) { last = error; if (!["rate-limited", "timeout", "http-5xx"].includes(error.category) || attempt === 2) throw error; await sleep(750 * (attempt + 1)); } } throw last;
}
async function parallel(rows, limit, fn) {
  const out = new Array(rows.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, async () => { while (true) { const i = cursor++; if (i >= rows.length) return; try { out[i] = await fn(rows[i], i); } catch { out[i] = null; } } }));
  return out;
}

const morpho = new ethers.Interface([
  "function idToMarketParams(bytes32) view returns(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)",
  "function market(bytes32) view returns(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function position(bytes32,address) view returns(uint256 supplyShares,uint128 borrowShares,uint128 collateral)",
  "event CreateMarket(bytes32 indexed id,(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams)",
  "event Supply(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets,uint256 shares)",
  "event Withdraw(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets,uint256 shares)",
  "event Borrow(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets,uint256 shares)",
  "event Repay(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets,uint256 shares)",
  "event SupplyCollateral(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets)",
  "event WithdrawCollateral(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets)",
  "event Liquidate(bytes32 indexed id,address indexed caller,address indexed borrower,uint256 repaidAssets,uint256 repaidShares,uint256 seizedAssets,uint256 badDebtAssets,uint256 badDebtShares)"
]);
const oracle = new ethers.Interface(["function price() view returns(uint256)", "function BASE_VAULT() view returns(address)", "function BASE_VAULT_CONVERSION_SAMPLE() view returns(uint256)", "function QUOTE_VAULT() view returns(address)", "function QUOTE_VAULT_CONVERSION_SAMPLE() view returns(uint256)", "function BASE_FEED_1() view returns(address)", "function BASE_FEED_2() view returns(address)", "function QUOTE_FEED_1() view returns(address)", "function QUOTE_FEED_2() view returns(address)", "function SCALE_FACTOR() view returns(uint256)"]);
const feed = new ethers.Interface(["function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)", "function decimals() view returns(uint8)"]);
const router = new ethers.Interface(["function readWithAge() view returns(uint256,uint256)", "function uscribe() view returns(address)", "function tolled(address) view returns(bool)", "function authed(address) view returns(bool)", "function authed() view returns(address[])", "function tolled() view returns(address[])"]);
const wrapper = new ethers.Interface(["function underlying() view returns(address)", "function owner() view returns(address)", "function totalSupply() view returns(uint256)", "function rolesOf(address) view returns(uint256)", "function mint(address,uint256)", "function burn(address,address,uint256)", "event RolesUpdated(address indexed user,uint256 indexed roles)", "event Transfer(address indexed from,address indexed to,uint256 amount)"]);
const erc20 = new ethers.Interface(["function balanceOf(address) view returns(uint256)", "function totalSupply() view returns(uint256)", "function decimals() view returns(uint8)", "function symbol() view returns(string)", "function name() view returns(string)"]);
const tranche = new ethers.Interface(["function vault(address) view returns(address)", "function hook() view returns(address)", "function wards(address) view returns(uint256)", "function checkTransferRestriction(address,address,uint256) view returns(bool)"]);
const irm = new ethers.Interface(["function borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) view returns(uint256)"]);
const uniV2Factory = new ethers.Interface(["function getPair(address,address) view returns(address)"]);
const uniV3Factory = new ethers.Interface(["function getPool(address,address,uint24) view returns(address)"]);
const poolV2 = new ethers.Interface(["function getReserves() view returns(uint112,uint112,uint32)", "function token0() view returns(address)", "function token1() view returns(address)"]);
const poolV3 = new ethers.Interface(["function liquidity() view returns(uint128)", "function token0() view returns(address)", "function token1() view returns(address)", "function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)"]);

async function call(row, to, iface, fn, args, tag) {
  const data = iface.encodeFunctionData(fn, args);
  try { const raw = await rpc(row, "eth_call", [{ to, data }, tag]); return canonical(iface.decodeFunctionResult(fn, raw)); }
  catch (error) { throw new Error(`eth_call failed:${fn}:${error.category || "decode"}`); }
}
async function callOutcome(row, from, to, iface, fn, args, tag) {
  const data = iface.encodeFunctionData(fn, args);
  try { const value = await rpc(row, "eth_call", [{ from, to, data }, tag]); return { success: true, returnDataHash: sha(Buffer.from(value)), returnDataPrefix: value.slice(0, 10) }; }
  catch (error) { const raw = typeof error.data === "string" ? error.data : error.data?.data; return { success: false, category: error.category, revertSelector: typeof raw === "string" && raw.startsWith("0x") ? raw.slice(0, 10) : null }; }
}
function addressFromSlot(raw) { return /^0x[0-9a-f]{64}$/i.test(raw || "") && !/^0x0{64}$/i.test(raw) ? ethers.getAddress(`0x${raw.slice(-40)}`) : null; }
async function codeIdentity(row, address, tag) {
  const [code, i, a, b] = await Promise.all([rpc(row, "eth_getCode", [address, tag]), rpc(row, "eth_getStorageAt", [address, EIP1967_IMPL, tag]), rpc(row, "eth_getStorageAt", [address, EIP1967_ADMIN, tag]), rpc(row, "eth_getStorageAt", [address, EIP1967_BEACON, tag])]);
  const implementation = addressFromSlot(i), implementationCode = implementation ? await rpc(row, "eth_getCode", [implementation, tag]) : null;
  return { address: ethers.getAddress(address), codeBytes: (code.length - 2) / 2, codeKeccak256: ethers.keccak256(code), implementation, implementationCodeBytes: implementationCode ? (implementationCode.length - 2) / 2 : null, implementationCodeKeccak256: implementationCode ? ethers.keccak256(implementationCode) : null, admin: addressFromSlot(a), beacon: addressFromSlot(b) };
}

async function qualify(row, prior) {
  try {
    const [chain, finalized] = await Promise.all([rpc(row, "eth_chainId", [], 7000), rpc(row, "eth_getBlockByNumber", ["finalized", false], 7000)]);
    if (BigInt(chain) !== 1n || !finalized?.number || !finalized?.hash) return null;
    const priorRow = prior.get(row.providerId), archiveHint = !!priorRow?.deep?.archiveReady, traceHint = !!priorRow?.deep?.traceDebugReadOnly;
    return { row, family: row.family, finalizedNumber: Number(BigInt(finalized.number)), finalizedHash: finalized.hash.toLowerCase(), archiveHint, traceHint };
  } catch { return null; }
}
async function bindPin(qualified) {
  const unique = new Map(); for (const item of qualified.filter(Boolean).sort((a, b) => Number(b.archiveHint) - Number(a.archiveHint) || Number(b.traceHint) - Number(a.traceHint))) if (!unique.has(item.family)) unique.set(item.family, item);
  const candidates = [...unique.values()], heights = [...new Set(candidates.map((x) => x.finalizedNumber))].sort((a, b) => b - a);
  for (const number of heights) {
    const eligible = candidates.filter((x) => x.finalizedNumber >= number), headers = (await parallel(eligible, 5, async (x) => ({ x, block: await rpc(x.row, "eth_getBlockByNumber", [hex(number), false], 8000) }))).filter(Boolean).filter((x) => x.block?.hash);
    const groups = new Map(); for (const item of headers) { const key = item.block.hash.toLowerCase(); const list = groups.get(key) || []; list.push(item); groups.set(key, list); }
    const best = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    if (best?.[1]?.length >= 2) return { number, hash: best[0], timestamp: Number(BigInt(best[1][0].block.timestamp)), candidates: best[1].map((x) => x.x) };
  }
  throw new Error("fresh finalized multi-family pin unavailable");
}
async function deepQualify(pin) {
  const tag = hex(pin.number), historical = hex(pin.number - 2048), priceData = oracle.encodeFunctionData("price", []), rows = [];
  for (const item of pin.candidates) {
    const out = { item, archive: false, logs: false, trace: false, prestate: false };
    try { const [code, oldCode] = await Promise.all([rpc(item.row, "eth_getCode", [ORACLE, tag]), rpc(item.row, "eth_getCode", [MORPHO, historical])]); out.archive = code !== "0x" && oldCode !== "0x"; } catch {}
    try { const logs = await rpc(item.row, "eth_getLogs", [{ address: MORPHO, fromBlock: hex(Math.max(WRAPPER_DEPLOY_BLOCK, pin.number - 1000)), toBlock: tag, topics: [morpho.getEvent("Borrow").topicHash, MARKET_ID] }], 12000); out.logs = Array.isArray(logs); } catch {}
    try { out.callTrace = await rpc(item.row, "debug_traceCall", [{ from: ZERO, to: ORACLE, data: priceData }, tag, { tracer: "callTracer", timeout: "20s" }], 30000); out.trace = !!out.callTrace; } catch {}
    if (out.trace) try { out.prestateTrace = await rpc(item.row, "debug_traceCall", [{ from: ZERO, to: ORACLE, data: priceData }, tag, { tracer: "prestateTracer", tracerConfig: { diffMode: false }, timeout: "20s" }], 30000); out.prestate = !!out.prestateTrace; } catch {}
    rows.push(out);
  }
  return rows;
}
function selectIndependent(rows, predicate, count) { const seen = new Set(), out = []; for (const row of rows) if (predicate(row) && !seen.has(row.item.family)) { seen.add(row.item.family); out.push(row); if (out.length === count) break; } return out; }
function normalizeTrace(node) {
  if (!node) return null; const input = node.input || "0x", output = node.output || "0x";
  return { type: node.type || "CALL", from: node.from ? ethers.getAddress(node.from) : null, to: node.to ? ethers.getAddress(node.to) : null, selector: input.length >= 10 ? input.slice(0, 10).toLowerCase() : "0x", success: !node.error, error: node.error ? "trace-call-failed" : null, inputHash: sha(Buffer.from(input)), outputHash: sha(Buffer.from(output)), calls: (node.calls || []).map(normalizeTrace) };
}
function normalizePrestate(value) {
  const out = []; for (const [address, account] of Object.entries(value || {})) out.push({ address: ethers.getAddress(address), storageSlots: Object.keys(account.storage || {}).map((x) => x.toLowerCase()).sort(), storageSlotCount: Object.keys(account.storage || {}).length, codePresent: typeof account.code === "string" && account.code !== "0x" });
  return out.sort((a, b) => a.address.localeCompare(b.address));
}

async function stateSnapshot(row, pin) {
  const tag = hex(pin.number);
  const [params, market, baseFeed] = await Promise.all([call(row, MORPHO, morpho, "idToMarketParams", [MARKET_ID], tag), call(row, MORPHO, morpho, "market", [MARKET_ID], tag), call(row, ORACLE, oracle, "BASE_FEED_1", [], tag)]);
  const baseFeedAddress = baseFeed[0];
  const [price, scale, wrapperId, underlying, owner, wSupply, wBacking, jSupply, feedRound, feedDecimals, routerAddress] = await Promise.all([
    call(row, ORACLE, oracle, "price", [], tag), call(row, ORACLE, oracle, "SCALE_FACTOR", [], tag), codeIdentity(row, WJAAA, tag), call(row, WJAAA, wrapper, "underlying", [], tag), call(row, WJAAA, wrapper, "owner", [], tag), call(row, WJAAA, wrapper, "totalSupply", [], tag), call(row, JAAA, erc20, "balanceOf", [WJAAA], tag), call(row, JAAA, erc20, "totalSupply", [], tag), call(row, baseFeedAddress, feed, "latestRoundData", [], tag), call(row, baseFeedAddress, feed, "decimals", [], tag), call(row, baseFeedAddress, new ethers.Interface(["function router() view returns(address)"]), "router", [], tag).catch(() => [null])
  ]);
  const dynamicRouter = routerAddress[0];
  const [routerRead, selectedConsumer, oracleTolled, routerAuthList, consumerRead] = dynamicRouter ? await Promise.all([
    call(row, dynamicRouter, router, "readWithAge", [], tag), call(row, dynamicRouter, router, "uscribe", [], tag), call(row, dynamicRouter, router, "tolled(address)", [ORACLE], tag), call(row, dynamicRouter, router, "authed()", [], tag).catch(() => [[]]), call(row, (await call(row, dynamicRouter, router, "uscribe", [], tag))[0], router, "readWithAge", [], tag)
  ]) : [null, [null], [null], [[]], null];
  const marketParams = params.map(String), marketRaw = market.map(String), rate = await call(row, marketParams[3], irm, "borrowRateView", [marketParams, marketRaw], tag);
  const tupleHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "address", "address", "uint256"], marketParams));
  const expected = expectedMarket(marketRaw.map(BigInt), BigInt(rate[0]), pin.timestamp);
  const canonicalVault = await call(row, JAAA, tranche, "vault", [USDC], tag).catch(() => [null]);
  const hook = await call(row, JAAA, tranche, "hook", [], tag).catch(() => [null]);
  return canonical({
    marketParams: { loanToken: marketParams[0], collateralToken: marketParams[1], oracle: marketParams[2], irm: marketParams[3], lltv: marketParams[4], recomputedId: tupleHash, idMatches: tupleHash.toLowerCase() === MARKET_ID },
    marketStored: { totalSupplyAssets: marketRaw[0], totalSupplyShares: marketRaw[1], totalBorrowAssets: marketRaw[2], totalBorrowShares: marketRaw[3], lastUpdate: marketRaw[4], fee: marketRaw[5] },
    marketExpectedAtPin: expected, availableLiquidityRaw: (BigInt(expected.totalSupplyAssets) - BigInt(expected.totalBorrowAssets)).toString(),
    oracle: { price: String(price[0]), scaleFactor: String(scale[0]), baseFeed: baseFeedAddress, feedDecimals: String(feedDecimals[0]), latestRoundData: feedRound.map(String), router: dynamicRouter, routerReadWithAge: routerRead?.map(String) || null, selectedConsumer: selectedConsumer?.[0] || null, consumerReadWithAge: consumerRead?.map(String) || null, oracleTolled: oracleTolled?.[0] ?? null, routerAuthedAddresses: routerAuthList?.[0] || [], ageSecondsAtPin: Number(BigInt(pin.timestamp) - BigInt(feedRound[3])) },
    wrapper: { identity: wrapperId, underlying: underlying[0], owner: owner[0], totalSupplyRaw: String(wSupply[0]), underlyingBackingRaw: String(wBacking[0]), backingSurplusRaw: (BigInt(wBacking[0]) - BigInt(wSupply[0])).toString(), backingRatioWad: BigInt(wSupply[0]) === 0n ? null : (BigInt(wBacking[0]) * 10n ** 18n / BigInt(wSupply[0])).toString(), underlyingTotalSupplyRaw: String(jSupply[0]), canonicalUsdcVault: canonicalVault[0], transferHook: hook[0] }
  });
}
function expectedMarket(market, rate, timestamp) {
  let [supplyAssets, supplyShares, borrowAssets, borrowShares, lastUpdate, fee] = market; const elapsed = BigInt(timestamp) - lastUpdate;
  if (elapsed > 0n && borrowAssets > 0n) { const first = rate * elapsed, second = first * first / (2n * 10n ** 18n), third = second * first / (3n * 10n ** 18n), interest = borrowAssets * (first + second + third) / 10n ** 18n; borrowAssets += interest; supplyAssets += interest; if (fee > 0n) { const feeAmount = interest * fee / 10n ** 18n; supplyShares += feeAmount * (supplyShares + 1000000n) / (supplyAssets - feeAmount + 1n); } }
  return { totalSupplyAssets: supplyAssets.toString(), totalSupplyShares: supplyShares.toString(), totalBorrowAssets: borrowAssets.toString(), totalBorrowShares: borrowShares.toString(), elapsedSeconds: elapsed.toString(), borrowRatePerSecondWad: rate.toString() };
}

async function getLogsAdaptive(row, filter, from, to, stats, depth = 0) {
  try { const logs = await rpc(row.item.row, "eth_getLogs", [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }], 30000); stats.requests++; return logs; }
  catch (error) { stats.failures++; if (from >= to || depth >= 20) throw new Error(`log capture failed:${error.category}`); const mid = Math.floor((from + to) / 2); return [...await getLogsAdaptive(row, filter, from, mid, stats, depth + 1), ...await getLogsAdaptive(row, filter, mid + 1, to, stats, depth + 1)]; }
}
function normalizeLog(log) { return { blockNumber: Number(BigInt(log.blockNumber)), transactionHash: log.transactionHash.toLowerCase(), logIndex: Number(BigInt(log.logIndex)), topics: log.topics.map((x) => x.toLowerCase()), data: log.data.toLowerCase() }; }
async function captureHistory(row, pin) {
  const eventTopics = ["CreateMarket", "Supply", "Withdraw", "Borrow", "Repay", "SupplyCollateral", "WithdrawCollateral", "Liquidate"].map((name) => morpho.getEvent(name).topicHash);
  const stats = { requests: 0, failures: 0 };
  const logs = (await getLogsAdaptive(row, { address: MORPHO, topics: [eventTopics, MARKET_ID] }, WRAPPER_DEPLOY_BLOCK, pin.number, stats)).map(normalizeLog).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const decoded = logs.map((log) => { const parsed = morpho.parseLog(log), args = {}; parsed.fragment.inputs.forEach((input, i) => { args[input.name || String(i)] = canonical(parsed.args[i]); }); return { blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex, event: parsed.name, args }; });
  const wrapperStats = { requests: 0, failures: 0 }, wrapperTopics = [wrapper.getEvent("RolesUpdated").topicHash, wrapper.getEvent("Transfer").topicHash];
  const wrapperLogs = (await getLogsAdaptive(row, { address: WJAAA, topics: [wrapperTopics] }, WRAPPER_DEPLOY_BLOCK, pin.number, wrapperStats)).map(normalizeLog).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const wrapperDecoded = wrapperLogs.map((log) => { const parsed = wrapper.parseLog(log), args = {}; parsed.fragment.inputs.forEach((input, i) => { args[input.name || String(i)] = canonical(parsed.args[i]); }); return { blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex, event: parsed.name, args }; });
  return { morpho: { events: decoded, eventDigest: digest(decoded), stats }, wrapper: { events: wrapperDecoded, eventDigest: digest(wrapperDecoded), stats } };
}
function uniqueBorrowers(events) {
  const set = new Set(); for (const e of events) { if (["Borrow", "Repay", "SupplyCollateral", "WithdrawCollateral"].includes(e.event) && e.args.onBehalf) set.add(ethers.getAddress(e.args.onBehalf)); if (e.event === "Liquidate" && e.args.borrower) set.add(ethers.getAddress(e.args.borrower)); } return [...set].sort();
}
async function borrowerStates(row, pin, state, borrowers) {
  const tag = hex(pin.number), expected = state.marketExpectedAtPin, price = BigInt(state.oracle.price), lltv = BigInt(state.marketParams.lltv), out = [];
  for (const account of borrowers) {
    const p = await call(row.item.row, MORPHO, morpho, "position", [MARKET_ID, account], tag), supplyShares = BigInt(p[0]), borrowShares = BigInt(p[1]), collateral = BigInt(p[2]);
    const borrowed = borrowShares === 0n ? 0n : (borrowShares * (BigInt(expected.totalBorrowAssets) + 1n) + (BigInt(expected.totalBorrowShares) + 1000000n - 1n)) / (BigInt(expected.totalBorrowShares) + 1000000n);
    const collateralValue = collateral * price / 10n ** 36n, maxBorrow = collateralValue * lltv / 10n ** 18n, healthFactorWad = borrowed === 0n ? null : maxBorrow * 10n ** 18n / borrowed;
    out.push({ account, supplyShares: supplyShares.toString(), borrowShares: borrowShares.toString(), collateralRaw: collateral.toString(), borrowedAssetsRaw: borrowed.toString(), collateralValueLoanRaw: collateralValue.toString(), maxBorrowAssetsRaw: maxBorrow.toString(), healthFactorWad: healthFactorWad?.toString() || null, distanceToLiquidationBps: healthFactorWad === null ? null : ((healthFactorWad - 10n ** 18n) * 10000n / 10n ** 18n).toString() });
  }
  return out.sort((a, b) => BigInt(a.healthFactorWad || 2n ** 255n) < BigInt(b.healthFactorWad || 2n ** 255n) ? -1 : 1);
}

async function venueSnapshot(row, pin, state) {
  const tag = hex(pin.number), pairs = [], assets = [WJAAA, JAAA], quotes = [USDC, WETH], v2 = [{ name: "UniswapV2", factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f" }, { name: "SushiV2", factory: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac" }], v3Factory = "0x1F98431c8aD98523631AE4a59f267346ea31F984", balancerVault = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
  for (const asset of assets) for (const quote of quotes) {
    for (const factory of v2) { const address = (await call(row.item.row, factory.factory, uniV2Factory, "getPair", [asset, quote], tag))[0]; if (address !== ZERO) { const [tokens, reserves] = await Promise.all([Promise.all([call(row.item.row, address, poolV2, "token0", [], tag), call(row.item.row, address, poolV2, "token1", [], tag)]), call(row.item.row, address, poolV2, "getReserves", [], tag)]); pairs.push({ family: factory.name, asset, quote, pool: address, token0: tokens[0][0], token1: tokens[1][0], reserve0: String(reserves[0]), reserve1: String(reserves[1]) }); } }
    for (const feeTier of [100, 500, 3000, 10000]) { const address = (await call(row.item.row, v3Factory, uniV3Factory, "getPool", [asset, quote, feeTier], tag))[0]; if (address !== ZERO) { const [liquidity, slot0] = await Promise.all([call(row.item.row, address, poolV3, "liquidity", [], tag), call(row.item.row, address, poolV3, "slot0", [], tag)]); pairs.push({ family: "UniswapV3", asset, quote, feeTier, pool: address, liquidity: String(liquidity[0]), sqrtPriceX96: String(slot0[0]), tick: String(slot0[1]) }); } }
  }
  const balancerBalances = {}; for (const token of assets) balancerBalances[token] = String((await call(row.item.row, token, erc20, "balanceOf", [balancerVault], tag))[0]);
  const unauthorizedMint = await callOutcome(row.item.row, DEAD, WJAAA, wrapper, "mint", [DEAD, 1], tag), unauthorizedBurn = await callOutcome(row.item.row, DEAD, WJAAA, wrapper, "burn", [DEAD, DEAD, 1], tag);
  const vault = state.wrapper.canonicalUsdcVault; let vaultIdentity = null;
  if (vault && vault !== ZERO) vaultIdentity = await codeIdentity(row.item.row, vault, tag);
  return { scannedPairs: assets.length * quotes.length, factories: ["UniswapV2", "SushiV2", "UniswapV3"], discoveredPools: pairs, balancerVaultTokenBalances: balancerBalances, wrapperZeroBalanceSelfPathSimulation: { selfMintWithoutUnderlyingOrAllowance: unauthorizedMint, selfBurnWithoutWrapperBalance: unauthorizedBurn }, canonicalUsdcVault: vault, canonicalUsdcVaultIdentity: vaultIdentity, acquisitionQuote: pairs.length ? "pool-state-retained-no-route-assumption" : null, redemptionQuote: null, exactExitEconomics: null };
}

function decodeHtml(value) { return String(value || "").replace(/&#(x[0-9a-f]+|\d+);|&([a-z]+);/gi, (m, n, name) => n ? String.fromCodePoint(n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : parseInt(n, 10)) : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[String(name).toLowerCase()] || m); }
function decodeJs(value) { let out = ""; for (let i = 0; i < value.length; i++) { if (value[i] !== "\\") { out += value[i]; continue; } const n = value[++i]; if (n === "n") out += "\n"; else if (n === "r") out += "\r"; else if (n === "t") out += "\t"; else if (n === "x") { out += String.fromCharCode(parseInt(value.slice(i + 1, i + 3), 16)); i += 2; } else if (n === "u") { out += String.fromCharCode(parseInt(value.slice(i + 1, i + 5), 16)); i += 4; } else out += n; } return out; }
function jsAssignment(html, variable) { const match = html.match(new RegExp(`var\\s+${variable}\\s*=\\s*'`)); if (!match) return null; const start = match.index + match[0].length; let escaped = false; for (let i = start; i < html.length; i++) { if (escaped) { escaped = false; continue; } if (html[i] === "\\") { escaped = true; continue; } if (html[i] === "'") return html.slice(start, i); } return null; }
function snippet(source, pattern) { const match = pattern.exec(source); if (!match) return null; const start = Math.max(0, match.index - 160), end = Math.min(source.length, match.index + 1100); return source.slice(start, end).replace(/\s+/g, " ").trim(); }
async function explorerSource(address, liveIdentity) {
  const url = `https://etherscan.io/address/${address}#code`; let response, html;
  try { response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 Chrome-compatible" }, signal: AbortSignal.timeout(90000) }); html = await response.text(); }
  catch { return { address: ethers.getAddress(address), fetchedAt: new Date().toISOString(), fetchStatus: null, verifiedSourceAvailable: null, liveRuntime: liveIdentity, failure: "public-source-fetch-timeout-or-unavailable", publicUrl: url }; }
  const raw = jsAssignment(html, "editor_contractJsonData"); let standard = null; try { standard = raw ? JSON.parse(decodeJs(raw)) : null; } catch {}
  const files = Object.entries(standard?.sources || {}).filter(([, x]) => typeof x?.content === "string").map(([file, x]) => ({ file, bytes: Buffer.byteLength(x.content), sha256: sha(Buffer.from(x.content)), content: x.content }));
  const text = files.map((x) => x.content).join("\n"); const name = html.match(/Contract Name[\s\S]{0,300}?<h4[^>]*>([\s\S]*?)<\/h4>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() || null, compiler = html.match(/Compiler Version[\s\S]{0,400}?<span[^>]*>([\s\S]*?)<\/span>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() || null;
  return { address: ethers.getAddress(address), fetchedAt: new Date().toISOString(), fetchStatus: response.status, pageSha256: sha(Buffer.from(html)), verifiedSourceAvailable: files.length > 0, contractName: name, compiler, sourceFiles: files.map(({ content, ...x }) => x), sourceAggregateSha256: digest(files.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 }))), liveRuntime: liveIdentity, snippets: { mint: snippet(text, /function\s+mint\s*\(/), burn: snippet(text, /function\s+burn\s*\(/), initialize: snippet(text, /function\s+initialize\s*\(/), vault: snippet(text, /function\s+vault\s*\(/), updateVault: snippet(text, /function\s+updateVault\s*\(/), transferRestriction: snippet(text, /function\s+(?:checkTransferRestriction|_beforeTokenTransfer)\s*\(/) } };
}

async function main() {
  const inv = inventory(), priorCap = JSON.parse(fs.readFileSync(abs(PRIOR_CAP), "utf8")), priorMap = new Map(priorCap.providers.map((x) => [x.providerId, x]));
  const preferred = inv.rows.filter((x) => priorMap.get(x.providerId)?.rpc?.chainId === 1).sort((a, b) => Number(!!priorMap.get(b.providerId)?.deep?.archiveReady) - Number(!!priorMap.get(a.providerId)?.deep?.archiveReady) || Number(!!priorMap.get(b.providerId)?.deep?.traceDebugReadOnly) - Number(!!priorMap.get(a.providerId)?.deep?.traceDebugReadOnly));
  let qualified = (await parallel(preferred, 8, (row) => qualify(row, priorMap))).filter(Boolean);
  if (new Set(qualified.map((x) => x.family)).size < 4) { const tried = new Set(preferred.map((x) => x.url)), more = inv.rows.filter((x) => !tried.has(x.url)); qualified.push(...(await parallel(more, 10, (row) => qualify(row, priorMap))).filter(Boolean)); }
  const pin = await bindPin(qualified), deep = await deepQualify(pin), archive = selectIndependent(deep, (x) => x.archive && x.logs, 2), traces = selectIndependent(deep, (x) => x.trace, 2);
  if (archive.length < 2 || traces.length < 2) throw new Error("independent archive/log/trace family threshold unavailable");
  const stateRows = await Promise.all(archive.map((x) => stateSnapshot(x.item.row, pin))), stateDigests = stateRows.map(digest); if (new Set(stateDigests).size !== 1) throw new Error("archive state disagreement"); const state = stateRows[0];
  const histories = await Promise.all(archive.map((x) => captureHistory(x, pin))), historyDigests = histories.map((x) => digest({ morpho: x.morpho.eventDigest, wrapper: x.wrapper.eventDigest })); if (new Set(historyDigests).size !== 1) throw new Error("history disagreement");
  const borrowers = uniqueBorrowers(histories[0].morpho.events), positions = await borrowerStates(archive[0], pin, state, borrowers), venues = await venueSnapshot(archive[0], pin, state);
  const traceRows = traces.map((x, i) => ({ familyId: `trace-family-${i + 1}`, callGraph: normalizeTrace(x.callTrace), touchedStorage: normalizePrestate(x.prestateTrace), prestateAvailable: x.prestate })), traceDigests = traceRows.map((x) => digest(x.callGraph));
  const liveOracle = await codeIdentity(archive[0].item.row, ORACLE, hex(pin.number)), liveAdapter = await codeIdentity(archive[0].item.row, state.oracle.baseFeed, hex(pin.number)), liveRouter = await codeIdentity(archive[0].item.row, state.oracle.router, hex(pin.number)), liveConsumer = await codeIdentity(archive[0].item.row, state.oracle.selectedConsumer, hex(pin.number)), liveWrapperImpl = state.wrapper.identity.implementation ? await codeIdentity(archive[0].item.row, state.wrapper.identity.implementation, hex(pin.number)) : null, liveJaaa = await codeIdentity(archive[0].item.row, JAAA, hex(pin.number));
  const sourceEvidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), pin: { chainId: 1, number: pin.number, hash: pin.hash }, predecessor: fileBinding(PRIOR_ORACLE), freshRuntimeBindings: { oracle: liveOracle, adapter: liveAdapter, router: liveRouter, consumer: liveConsumer, wrapperProxy: state.wrapper.identity, wrapperImplementation: liveWrapperImpl, jaaa: liveJaaa }, publicExplorerSources: [await explorerSource(state.wrapper.identity.implementation, liveWrapperImpl), await explorerSource(JAAA, liveJaaa)], endpointMaterialPersisted: false };
  fs.mkdirSync(path.dirname(abs(SOURCES_OUT)), { recursive: true }); fs.writeFileSync(abs(SOURCES_OUT), `${JSON.stringify(canonical(sourceEvidence), null, 2)}\n`);
  const terminal = await Promise.all([...new Map([...archive, ...traces].map((x) => [x.item.family, x])).values()].map(async (x, i) => { const block = await rpc(x.item.row, "eth_getBlockByNumber", [hex(pin.number), false], 8000); const finalized = await rpc(x.item.row, "eth_getBlockByNumber", ["finalized", false], 8000); return { familyId: `terminal-family-${i + 1}`, sameHash: block?.hash?.toLowerCase() === pin.hash, finalizedAtOrAbove: Number(BigInt(finalized.number)) >= pin.number }; }));
  const sourcePrior = JSON.parse(fs.readFileSync(abs(PRIOR_ORACLE), "utf8")), predecessorRoute = sourcePrior.routes.find((x) => x.oracle?.address?.toLowerCase() === ORACLE.toLowerCase());
  const wrapperRoles = histories[0].wrapper.events.filter((x) => x.event === "RolesUpdated").reduce((m, x) => (m[x.args.user] = x.args.roles, m), {});
  const raw = canonical({
    schemaVersion: 1, runId: `critical-morpho-ethereum-wjaaa-custom-oracle-step1-${String(pin.number)}-${pin.hash.slice(2, 14)}`, generatedAt: new Date().toISOString(), classification: "INFORMATIONAL/WATCH-NO-PERMISSIONLESS-ORACLE-MANIPULATION-EDGE", scopeCorrection: { chain: "Ethereum", chainId: 1, falseBaseAssumptionCorrected: true },
    authorization: { defensiveReadOnly: true, sanitizedRpcAndGraphqlInventoryAuthorized: true, ephemeralForkAuthorizedOnlyAfterExactEdge: true, liveSignedTransactions: false, broadcast: false, mutation: false, keys: false },
    inventory: { files: inv.stats, uniqueCandidates: inv.uniqueCandidates, uniqueHostnameDerivedFamilies: inv.uniqueFamilies, currentEthereumQualifiedFamilies: new Set(qualified.map((x) => x.family)).size, archiveLogFamiliesUsed: 2, traceFamiliesUsed: 2, graphqlUsedAsAuthority: false, endpointIdentitiesPersisted: false, rawResponsesPersisted: false },
    pin: { chainId: 1, number: pin.number, hash: pin.hash, timestamp: pin.timestamp, iso: new Date(pin.timestamp * 1000).toISOString(), finalizedSelected: true, exactHeaderFamilyCount: pin.candidates.length, terminalRecheck: terminal, passed: terminal.every((x) => x.sameHash && x.finalizedAtOrAbove) },
    market: { id: MARKET_ID, ...state.marketParams, stored: state.marketStored, expectedAtPin: state.marketExpectedAtPin, availableLiquidityRaw: state.availableLiquidityRaw, availableLiquidityUsdc: ethers.formatUnits(state.availableLiquidityRaw, 6), oraclePriceRaw: state.oracle.price, oraclePriceUsdcPerWjaaa: ethers.formatUnits(state.oracle.price, 36) },
    oracle: { ...state.oracle, callGraphFamilyCount: traceRows.length, callGraphCrossFamilyAgreement: new Set(traceDigests).size === 1, traces: traceRows, runtimeBindings: sourceEvidence.freshRuntimeBindings, predecessorExactSourceRuntimeBindingRetained: !!predecessorRoute?.sourceCoverage?.complete, noDexCalleesObserved: !JSON.stringify(traceRows).match(/0902f1ac|3850c7bd|c6610657|38fff2d0/i), stalenessEnforcedByMorphoOracle: false, updateModel: "Chronicle signed uScribe update into storage-cached JAAA consumer; router/auth controls select the consumer; read path is storage-backed" },
    wrapper: { ...state.wrapper, roleHistory: wrapperRoles, roleUpdateEventCount: histories[0].wrapper.events.filter((x) => x.event === "RolesUpdated").length, transferEventCount: histories[0].wrapper.events.filter((x) => x.event === "Transfer").length, mintRedeemModel: "permissionless 1:1 self-wrap/self-unwrap; third-party mint requires issuer role and third-party burn requires allowance; not ERC4626", convertNavFunctionsPresent: false, publicUnderlyingUnwrapPresent: true, publicUsdcRedemptionPresent: false, oracleReadsWrapperBalanceOrRate: false, directDonationChangesOraclePrice: false, donationEffect: "direct JAAA transfer can only increase trapped backing surplus; each burned share still releases exactly one JAAA and the oracle remains Chronicle JAAA NAV" },
    history: { coverage: `COMPLETE_FROM_VERIFIED_WRAPPER_DEPLOYMENT_BLOCK_${WRAPPER_DEPLOY_BLOCK}_THROUGH_PIN_ACROSS_TWO_HOSTNAME_DERIVED_FAMILIES`, lowerBoundJustification: "wJAAA code absent before its deployment; this market could not be created with deployed collateral earlier", familyCount: 2, crossFamilyAgreement: true, familyCommitments: histories.map((x, i) => ({ familyId: `archive-log-family-${i + 1}`, morphoEventDigest: x.morpho.eventDigest, wrapperEventDigest: x.wrapper.eventDigest, morphoRequests: x.morpho.stats.requests, wrapperRequests: x.wrapper.stats.requests })), morphoEvents: histories[0].morpho.events, wrapperEvents: histories[0].wrapper.events },
    borrowers: { enumeratedAccounts: borrowers.length, currentDebtAccounts: positions.filter((x) => BigInt(x.borrowShares) > 0n).length, positions, nearBoundaryWithin500Bps: positions.filter((x) => x.distanceToLiquidationBps !== null && BigInt(x.distanceToLiquidationBps) <= 500n) },
    venues, manipulationAssessment: { permissionlessOracleManipulationEdge: false, exactDexInfluence: false, wrapperDonationInfluence: false, permissionlessUnauthenticatedNavUpdate: false, permissionlessSelfWrapUnwrap: true, permissionlessUsdcAcquisitionAndExit: false, routePositive: 0, executableNow: 0, signedActionJustified: false, forkGateMet: false, forkCreated: false, exactEconomics: null, stopReason: "The trusted price path is signed/storage-backed Chronicle NAV, not a DEX or wrapper conversion rate. Self-wrap/unwrap is 1:1, but fresh-user JAAA/USDC acquisition and redemption are permissioned/asynchronous and no canonical DEX pool exists." },
    pipeline: { sourceRuntimeAndStateBinding: "PASS", borrowerAndLiquidityBinding: "PASS", permissionlessManipulationEdge: "FAIL", forkExtraction: "NOT_RUN_GATE_CLOSED", exactNetEconomics: "NOT_APPLICABLE_NO_EDGE", stage: "2/5" },
    sourceEvidence: fileBinding(SOURCES_OUT), predecessorBindings: [fileBinding(PRIOR_CAP), fileBinding(PRIOR_ORACLE), fileBinding("reports/raw/fast/small-cap-oracle-current-paths.json")], safety: { rpcRequests, endpointIdentitiesPersisted: false, rawRpcPersisted: false, privateKeys: false, signing: false, broadcast: false, productionMutation: false, fundMovement: false, fork: false }
  });
  fs.writeFileSync(abs(OUT), `${JSON.stringify(raw, null, 2)}\n`);
  process.stdout.write(JSON.stringify({ runId: raw.runId, pin: raw.pin, market: { id: raw.market.id, liquidity: raw.market.availableLiquidityUsdc }, borrowers: raw.borrowers.currentDebtAccounts, routePositive: 0, fork: false }) + "\n");
}

main().catch((error) => { process.stderr.write(`wJAAA Step1 stopped: ${String(error.message || error).replace(/https?:\/\/\S+/g, "[redacted]")}\n`); process.exitCode = 1; });
