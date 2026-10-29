#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const OUTPUT = path.join(ROOT, "reports", "raw", "fast", "critical-lista-v52-mbtc-auction-incentive-step2-passa.json");
const OLD_OUTPUT = path.join(ROOT, "reports", "raw", "fast", "critical-lista-v52-auction-incentive-step2-passa.json");
const DESIGN_REL = "tools/critical-lista-v52-mbtc-auction-incentive-step2-passa.design.json";
const DESIGN_SHA256 = "8d3ca12dc9f56d94f01f05d2c03fda379c4fdb7ba88395cc04aa1c22011488e3";
const FINDING_ID = "critical-lista-v52-mbtc-auction-incentive-step2-passa";
const SCHEMA_VERSION = "lista-v52-mbtc-auction-incentive-step2-passa/v1";
const LOGIC_COMMIT = "fe0fe823a245db35452a17c203801653cabb0148";
const REGISTRY_COMMIT = "2b7dee0bf8c98208f1761758641fce3e4ae6aa67";
const SOURCE_LABEL = "Lista DAO v5.2 source logic with official post-tag mBTC deployment registry";
const CHAIN_ID = 56n, WAD = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000";

const ROOTS = Object.freeze({
  interaction: "0xb68443ee3e828bad1526b3e0bdf2dfc6b1975ec4",
  vat: "0x33a34eab3ee892d40420507b820347b1ca2201c4",
  dog: "0xd57e7b53a1572d27a04d9c1de2c4d423f1926d0b",
  spotter: "0x49bc2c4e5b035341b7d92da4e6b267f7426f3038",
  jug: "0x787bdeaa29a253e40feb35026c3d05c18cbca7b3",
  vow: "0x2078a1969ea581d618fdbea2c0dc13fc15cb9fa7",
  calc: "0xc1359ed77e6b0cbf9a8130a4c28fbbb87b9501b7",
  token: "0x7c1cca5b25fa0bc9af9275fb53cba89dc172b878",
  joinProxy: "0xe95eaf5b61558bf73195550149759ce53a82a0c6",
  joinImplementation: "0x3e75d7edacc97645033ef8073d025069b0a0976d",
  clipProxy: "0x117b4a02d1bb3a32f4bf5cd6103e633b2b651063",
  clipImplementation: "0x9b878823cf06fac1edb02b44eada8bb4274ab7ea",
  oracleProxy: "0xd5e1b35d7dfb1b20546d3bb63aee3d8b7cc66870",
  oracleImplementation: "0x8be9583e729ca39d3d50458fb59e4fe5ba222345",
});
const ILK = "0x6d42544300000000000000000000000000000000000000000000000000000000";
const FIXED_ROOTS = Object.freeze(Object.values(ROOTS));
const SLOTS = Object.freeze({ implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103", beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" });
const SELECTORS = Object.freeze({
  interaction: Object.freeze({ vat: "36569e77", spotter: "2e77468d", dog: "c3b3ad7f", hay: "b02d1e9e", hayJoin: "4d608102", jug: "84718d89", dutyCalculator: "ebb95c5d", borrowLisUSDListaDistributor: "e68d57cf", whitelistMode: "70c757ec", auctionWhitelistMode: "1e9990ff", collaterals: "eeb97d3b", tokensBlacklist: "293e10ad", helioProviders: "1ef0bb94", providerCompatibilityMode: "e107f49b" }),
  vat: Object.freeze({ ilks: "d9638d36", live: "957aa58c", debt: "0dca59c1", Line: "babe8a3f" }),
  dog: Object.freeze({ ilks: "d9638d36", live: "957aa58c", Dirt: "eda6e121", Hole: "af7cfeb1", vow: "626cb3c5" }),
  spotter: Object.freeze({ ilks: "d9638d36", par: "495d32cb" }),
  join: Object.freeze({ vat: "36569e77", ilk: "c5ce281e", gem: "7bd2bea7", live: "957aa58c" }),
  clip: Object.freeze({ tip: "2755cd2d", chip: "b61500e4", tail: "13d8c840", cusp: "49ed5931", stopped: "75f12b21", chost: "ba2cdc75", vow: "626cb3c5", dog: "c3b3ad7f", vat: "36569e77", spotter: "2e77468d", ilk: "c5ce281e", buf: "15232515", calc: "96f1b6be" }),
  auth: Object.freeze({ wards: "bf353dbb" }), oracle: Object.freeze({ peek: "59e02dd7" }), calc: Object.freeze({ tau: "cfc4af55" }), token: Object.freeze({ decimals: "313ce567" }),
});
const CAPS = Object.freeze({ candidates: 1, fixedRoots: 14, rpcRequests: 128, endpointQualification: 5, callsPerBatch: 12, concurrency: 2, requestBytes: 32768, calldataBytes: 4096, responseBytesPerItem: 262144, responseBytesPerBatch: 1048576, sanitizedOutputBytes: 4194304, timeoutMs: 12000, maxTransportRetriesTotal: 1, retryDelayMs: 750, codeBytes: 262144, abiBytes: 4096 });
const PLAN = Object.freeze({ fixedRootCount: 14, stateCalls: 52, codeAndSlotCalls: 56, captureLogicalRequests: 111, maximumQualificationRequests: 5, reservedRetryElements: 12, trueWorstCaseRequests: 128 });
const EQUATIONS = Object.freeze({ requiredArtWad: "ceil(dustRad/rateRay) [WAD], rateRay>0", requiredDebtRad: "requiredArtWad*rateRay [RAD]", requiredTabRad: "floor(requiredDebtRad*chopWad/1e18) [RAD]", chostExpectedRad: "floor(dustRad*chopWad/1e18) [RAD]", penaltyCapacity: "requiredTabRad-requiredDebtRad", kickReward: "tipRad+floor(requiredTabRad*chipWad/1e18)", signedResidual: "kickReward-penaltyCapacity", resetReward: "tipRad+floor(requiredTabRad*chipWad/1e18)", globalVatAvailable: "LineRad>=debtRad ? LineRad-debtRad : 0", ilkDebt: "ArtWad*rateRay [RAD]", ilkVatAvailable: "ilkLineRad>=ilkDebtRad ? ilkLineRad-ilkDebtRad : 0", globalDogHeadroom: "HoleRad>=DirtRad ? HoleRad-DirtRad : 0", ilkDogHeadroom: "ilkHoleRad>=ilkDirtRad ? ilkHoleRad-ilkDirtRad : 0" });
const RETRY_SCOPE = "same endpoint and identical request; numeric-tagged calls retain the same block; pre-pin eth_chainId/eth_blockNumber calls have no block assertion";
const INVENTORY_SELECTION_POLICY = Object.freeze({ version: "bsc-direct-https-line-label/v2", lineScoped: true, standaloneLabel: "BSC", protocol: "https:", preserveOrder: true, exactUrlDedupe: true, maximumRows: 5, rejectOtherChainLabels: true, rejectBscAdjacentAndNonMainnetLabels: true, percentDecodeBeforeTemplateCheck: true, decodeErrorsFailClosed: true, rejectTemplatesPlaceholdersAndCustomEnvelopes: true, memoryOnlySecrets: true });
const ALLOWED_METHODS = Object.freeze(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call"]);
const ALLOWED_SET = new Set(ALLOWED_METHODS), FIXED_SET = new Set(FIXED_ROOTS);

class Stop extends Error { constructor(code) { super(code); this.code = code; } }
class TransportFailure extends Error { constructor() { super("RPC_TRANSPORT_FAILURE"); this.code = "RPC_TRANSPORT_FAILURE"; } }
const stop = (code) => { throw new Stop(code); };
const lower = (x) => String(x).toLowerCase();
const sha256 = (x) => crypto.createHash("sha256").update(x).digest("hex");
const canonical = (x) => Array.isArray(x) ? x.map(canonical) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canonical(x[k])])) : typeof x === "bigint" ? x.toString() : x;
const canonicalJson = (x) => JSON.stringify(canonical(x));
function specDescriptor() { return canonical({ schemaVersion: SCHEMA_VERSION, logicCommit: LOGIC_COMMIT, registryCommit: REGISTRY_COMMIT, sourceLabel: SOURCE_LABEL, designSha256: DESIGN_SHA256, chainId: 56, roots: ROOTS, ilk: ILK, slots: SLOTS, selectors: SELECTORS, caps: CAPS, plan: PLAN, equations: EQUATIONS, retryScope: RETRY_SCOPE, inventorySelectionPolicy: INVENTORY_SELECTION_POLICY, allowedMethods: ALLOWED_METHODS, sourceRuntimeAttested: false, promotion: false, executable: false }); }
const SPEC_SHA256 = sha256(Buffer.from(canonicalJson(specDescriptor())));

function strictHex(v, max = CAPS.abiBytes, code = "ABI_HEX_INVALID") { if (typeof v !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(v)) stop(code); const bytes = (v.length - 2) / 2; if (bytes > max) stop(`${code}_OVERSIZED`); return { hex: lower(v), bytes }; }
function words(v, count, code) { const x = strictHex(v); if (x.bytes !== count * 32) stop(code); return Array.from({ length: count }, (_, i) => x.hex.slice(2 + i * 64, 2 + (i + 1) * 64)); }
const uintWord = (w) => BigInt(`0x${w}`);
function addressWordDecode(w) { if (!/^0{24}[0-9a-f]{40}$/.test(w)) stop("ABI_ADDRESS_PADDING_INVALID"); return `0x${w.slice(24)}`; }
const decodeUint = (v) => uintWord(words(v, 1, "ABI_UINT_LENGTH_INVALID")[0]);
const decodeAddress = (v) => addressWordDecode(words(v, 1, "ABI_ADDRESS_LENGTH_INVALID")[0]);
const decodeBytes32 = (v) => `0x${words(v, 1, "ABI_BYTES32_LENGTH_INVALID")[0]}`;
function decodeBoolWord(w) { const n = uintWord(w); if (n !== 0n && n !== 1n) stop("ABI_BOOL_INVALID"); return n === 1n; }
function decodePeek(v) { const w = words(v, 2, "ABI_PEEK_TUPLE_INVALID"); return { value: `0x${w[0]}`, valid: decodeBoolWord(w[1]) }; }
function decodeCollateral(v) { const w = words(v, 4, "ABI_COLLATERAL_TUPLE_INVALID"), live = uintWord(w[2]); if (live > 0xffffffffn) stop("ABI_UINT32_PADDING_INVALID"); return { join: addressWordDecode(w[0]), ilk: `0x${w[1]}`, live, clip: addressWordDecode(w[3]) }; }
function decodeVatIlk(v) { const w = words(v, 5, "ABI_VAT_ILK_TUPLE_INVALID"); return { art: uintWord(w[0]), rate: uintWord(w[1]), spot: uintWord(w[2]), line: uintWord(w[3]), dust: uintWord(w[4]) }; }
function decodeDogIlk(v) { const w = words(v, 4, "ABI_DOG_ILK_TUPLE_INVALID"); return { clip: addressWordDecode(w[0]), chop: uintWord(w[1]), hole: uintWord(w[2]), dirt: uintWord(w[3]) }; }
function decodeSpotIlk(v) { const w = words(v, 2, "ABI_SPOT_ILK_TUPLE_INVALID"); return { oracle: addressWordDecode(w[0]), mat: uintWord(w[1]) }; }
const addressArg = (a) => lower(a).slice(2).padStart(64, "0"), bytes32Arg = (b) => lower(b).slice(2);
function calldata(selector, args = []) { const x = `0x${selector}${args.join("")}`; if ((x.length - 2) / 2 > CAPS.calldataBytes) stop("CALLDATA_CAP_EXCEEDED"); return x; }
function canonicalQuantity(v) { if (typeof v !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(lower(v))) return null; try { return BigInt(v); } catch { return null; } }
const quantity = (v) => `0x${BigInt(v).toString(16)}`;
function strictHeader(v) { if (!v || typeof v !== "object" || Array.isArray(v)) stop("HEADER_MALFORMED"); const number = canonicalQuantity(v.number), timestamp = canonicalQuantity(v.timestamp); if (number === null || timestamp === null || !/^0x[0-9a-fA-F]{64}$/.test(v.hash || "") || !/^0x[0-9a-fA-F]{64}$/.test(v.stateRoot || "")) stop("HEADER_MALFORMED"); return { number, timestamp, hash: lower(v.hash), stateRoot: lower(v.stateRoot) }; }
function terminalHeaderConsistency(pin, raw) { try { const h = strictHeader(raw); return h.number.toString() === pin.number && h.timestamp.toString() === pin.timestamp && h.hash === pin.hash && h.stateRoot === pin.stateRoot; } catch { return false; } }
function slotAddress(v) { const w = words(v, 1, "EIP1967_SLOT_INVALID")[0]; if (uintWord(w) === 0n) return null; return addressWordDecode(w); }
function classifyProxy(s) { const implementation = slotAddress(s.implementation), admin = slotAddress(s.admin), beacon = slotAddress(s.beacon); if (implementation && beacon) stop("EIP1967_SLOT_CONFLICT"); return { kind: implementation ? "IMPLEMENTATION" : beacon ? "BEACON" : "DIRECT", implementation, beacon, admin }; }
function summarizeCode(v) { const x = strictHex(v, CAPS.codeBytes, "CODE_INVALID"); if (x.bytes === 0) stop("FIXED_ROOT_CODE_EMPTY"); return { bytes: x.bytes, keccak256: keccak256(x.hex) }; }
function ceilDiv(x, y) { if (typeof x !== "bigint" || typeof y !== "bigint" || x < 0n || y <= 0n) stop("CEIL_DIV_INPUT_INVALID"); return x === 0n ? 0n : (x - 1n) / y + 1n; }
function arithmetic(dust, rate, chop, tip, chip) {
  for (const x of [dust, rate, chop, tip, chip]) if (typeof x !== "bigint" || x < 0n) stop("ARITHMETIC_INPUT_INVALID");
  const chostExpected = dust * chop / WAD;
  if (rate === 0n) return { dustRad: dust, rateRay: rate, requiredArtWad: null, requiredDebtRad: null, chopWad: chop, requiredTabRad: null, chostExpectedRad: chostExpected, tipRad: tip, chipWad: chip, penaltyCapacityRad: null, kickRewardRad: null, signedResidualRad: null, resetRewardRad: null, ratePositive: false, dustPositive: dust > 0n, chopAtLeastWad: chop >= WAD, tabPositive: false, rewardExceedsPenaltyCapacity: false };
  const art = ceilDiv(dust, rate), debt = art * rate, tab = debt * chop / WAD, capacity = tab - debt, reward = tip + tab * chip / WAD;
  return { dustRad: dust, rateRay: rate, requiredArtWad: art, requiredDebtRad: debt, chopWad: chop, requiredTabRad: tab, chostExpectedRad: chostExpected, tipRad: tip, chipWad: chip, penaltyCapacityRad: capacity, kickRewardRad: reward, signedResidualRad: reward - capacity, resetRewardRad: reward, ratePositive: true, dustPositive: dust > 0n, chopAtLeastWad: chop >= WAD, tabPositive: tab > 0n, rewardExceedsPenaltyCapacity: reward > capacity };
}

class Budget { constructor(caps = CAPS) { this.caps = caps; this.requests = 0; this.batches = 0; this.retryElements = 0; this.retryUsed = false; this.byMethod = {}; } reserve(method) { if (!ALLOWED_SET.has(method)) stop("RPC_METHOD_NOT_ALLOWED"); if (++this.requests > this.caps.rpcRequests) stop("RPC_REQUEST_CAP_EXCEEDED"); this.byMethod[method] = (this.byMethod[method] || 0) + 1; } summary() { return canonical({ requests: this.requests, batches: this.batches, retryElements: this.retryElements, retries: this.retryUsed ? 1 : 0, byMethod: this.byMethod }); } }
function enforceBatch(x) { if (!Array.isArray(x) || x.length < 1 || x.length > CAPS.callsPerBatch) stop("BATCH_CAP_EXCEEDED"); }
function parseInventoryText(text, capture) {
  if (capture !== true) stop("INVENTORY_REQUIRES_CAPTURE");
  const rows = [], secrets = new Set(), seen = new Set(), lines = String(text).split(/\r?\n/);
  const standaloneBsc = /(^|[^a-z0-9_])bsc([^a-z0-9_]|$)/i;
  const otherChain = /(^|[^a-z0-9_])(ethereum|eth|base|arbitrum|optimism|polygon|avalanche|fantom|gnosis|linea|scroll|zksync|solana)([^a-z0-9_]|$)/i;
  const adjacentOrNonMainnet = /(^|[^a-z0-9_])(testnet|chapel|op\s*bnb|bnb(?:[-_ ]+smart)?[-_ ]+chain)([^a-z0-9_]|$)/i;
  const indirect = /(url[-_ ]?pattern|template|placeholder|\bproxy\b|aave|chain\s*id.{0,24}(body|request)|custom.{0,24}(envelope|body|request))/i;
  const placeholder = /[<>{}\[\]$]|\b(your|replace|placeholder|template|example|invalid|localhost)\b|127\.0\.0\.1/i;
  const decodedTemplate = /[{}<>\[\]]|(^|[\/?&=]):[a-z_][a-z0-9_-]*(?=\/|&|$)|\$\{?[a-z_][a-z0-9_-]*\}?|__[a-z][a-z0-9_-]*__|%(?:s|d)(?=$|[\/?&=])/i;
  for (const line of lines) {
    if (rows.length === CAPS.endpointQualification) break;
    const trimmed = line.trim(); if (!trimmed || /^(#|\/\/|;)/.test(trimmed)) continue;
    const tokens = [...line.matchAll(/https:\/\/[^\s"'`]+/gi)].map((m) => m[0].replace(/[)>`,.;]+$/g, ""));
    if (tokens.length === 0) continue;
    let labels = line; for (const token of tokens) labels = labels.replace(token, " ");
    if (!standaloneBsc.test(labels) || otherChain.test(labels) || adjacentOrNonMainnet.test(labels) || indirect.test(labels)) continue;
    for (const token of tokens) {
      if (rows.length === CAPS.endpointQualification) break;
      if (placeholder.test(token) || seen.has(token)) continue;
      let parsed; try { parsed = new URL(token); } catch { continue; }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) continue;
      let decodedComponents; try { const query = parsed.search.length > 1 ? parsed.search.slice(1).split("&").flatMap((pair) => pair.split("=").map((part) => decodeURIComponent(part.replace(/\+/g, "%20")))) : []; decodedComponents = [decodeURIComponent(parsed.pathname), ...query].join("&"); } catch { continue; }
      if (adjacentOrNonMainnet.test(`${labels} ${parsed.hostname} ${decodedComponents}`) || decodedTemplate.test(decodedComponents)) continue;
      seen.add(token); rows.push({ url: parsed.href, headers: {} });
      for (const secret of [token, parsed.href, parsed.hostname, ...parsed.searchParams.values(), ...parsed.pathname.split("/").filter(Boolean)]) if (String(secret).length >= 4) secrets.add(lower(secret));
    }
  }
  return { rows, secrets };
}
async function fetchTransport(endpoint, body) { const c = new AbortController(), timer = setTimeout(() => c.abort(), CAPS.timeoutMs); try { const r = await fetch(endpoint.url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", accept: "application/json", ...endpoint.headers }, body, signal: c.signal }); if (!r.ok || !r.body?.getReader) throw new TransportFailure(); const reader = r.body.getReader(), chunks = []; let size = 0; while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > CAPS.responseBytesPerBatch) { await reader.cancel(); stop("RESPONSE_BATCH_CAP_EXCEEDED"); } chunks.push(Buffer.from(value)); } return Buffer.concat(chunks, size); } catch (e) { if (e instanceof Stop) throw e; throw new TransportFailure(); } finally { clearTimeout(timer); } }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); let rpcId = 1;
async function rpcBatch(endpoint, calls, budget, options = {}) { enforceBatch(calls); const req = calls.map((c) => { budget.reserve(c.method); return { jsonrpc: "2.0", id: rpcId++, method: c.method, params: c.params || [] }; }), body = Buffer.from(JSON.stringify(req.length === 1 ? req[0] : req)); if (body.length > CAPS.requestBytes) stop("REQUEST_CAP_EXCEEDED"); budget.batches++; let raw; try { raw = await (options.transport || fetchTransport)(endpoint, body); } catch (e) { if (!(e instanceof TransportFailure) || budget.retryUsed || options.retry === false) throw e; budget.retryUsed = true; budget.retryElements = calls.length; for (const c of calls) budget.reserve(c.method); budget.batches++; await (options.sleep || sleep)(CAPS.retryDelayMs); raw = await (options.transport || fetchTransport)(endpoint, body); } if (!Buffer.isBuffer(raw) || raw.length > CAPS.responseBytesPerBatch) stop("RESPONSE_BATCH_INVALID"); let parsed; try { parsed = JSON.parse(raw.toString("utf8")); } catch { stop("RPC_JSON_INVALID"); } const rows = Array.isArray(parsed) ? parsed : [parsed], byId = new Map(rows.map((r) => [r?.id, r])); if (rows.length !== req.length) stop("RPC_COUNT_MISMATCH"); return req.map((q) => { const r = byId.get(q.id); if (!r || r.jsonrpc !== "2.0" || r.error || !Object.hasOwn(r, "result") || r.result === null) stop("RPC_SEMANTIC_FAILURE"); if (Buffer.byteLength(JSON.stringify(r)) > CAPS.responseBytesPerItem) stop("RESPONSE_ITEM_CAP_EXCEEDED"); return r.result; }); }
async function mapLimit(items, limit, fn) { const out = new Array(items.length); let next = 0; async function worker() { while (true) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); } } await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)); return out; }
async function qualify(inventory, budget, transport) { let selected = null; await mapLimit(inventory.rows, CAPS.concurrency, async (endpoint) => { if (selected) return; try { const [id] = await rpcBatch(endpoint, [{ method: "eth_chainId" }], budget, { transport }); if (canonicalQuantity(id) === CHAIN_ID && !selected) selected = endpoint; } catch (e) { if (!(e instanceof Stop || e instanceof TransportFailure)) throw e; } }); if (!selected) stop("BSC_ENDPOINT_UNAVAILABLE"); return selected; }
const spec = (label, method, params, decode) => ({ label, method, params, decode });
function assertFixedTarget(to) { if (!FIXED_SET.has(lower(to))) stop("DYNAMIC_TRAVERSAL_REJECTED"); return lower(to); }
const callSpec = (label, to, selector, decode, args, tag) => spec(label, "eth_call", [{ to: assertFixedTarget(to), data: calldata(selector, args) }, tag], decode);
async function executeSpecs(endpoint, specs, budget, transport) { const out = {}; for (let i = 0; i < specs.length; i += CAPS.callsPerBatch) { const chunk = specs.slice(i, i + CAPS.callsPerBatch), values = await rpcBatch(endpoint, chunk.map((x) => ({ method: x.method, params: x.params })), budget, { transport }); chunk.forEach((x, j) => { out[x.label] = x.decode(values[j]); }); } return out; }

async function capture(endpoint, budget, transport) {
  const [numberRaw] = await rpcBatch(endpoint, [{ method: "eth_blockNumber" }], budget, { transport }), number = canonicalQuantity(numberRaw); if (number === null) stop("BLOCK_NUMBER_INVALID"); const tag = quantity(number);
  const [headerRaw] = await rpcBatch(endpoint, [{ method: "eth_getBlockByNumber", params: [tag, false] }], budget, { transport }), header = strictHeader(headerRaw); if (header.number !== number) stop("PIN_HEADER_MISMATCH");
  const specs = [];
  FIXED_ROOTS.forEach((root, i) => { specs.push(spec(`code${i}`, "eth_getCode", [root, tag], summarizeCode)); for (const [name, slot] of Object.entries(SLOTS)) specs.push(spec(`slot${i}_${name}`, "eth_getStorageAt", [root, slot, tag], (v) => v)); });
  const I = SELECTORS.interaction, aa = [addressArg(ROOTS.token)], bb = [bytes32Arg(ILK)];
  for (const [name, sel] of Object.entries(I)) specs.push(callSpec(`i_${name}`, ROOTS.interaction, sel, name === "collaterals" ? decodeCollateral : ["whitelistMode", "auctionWhitelistMode", "tokensBlacklist", "providerCompatibilityMode"].includes(name) ? decodeUint : decodeAddress, ["collaterals", "tokensBlacklist", "helioProviders", "providerCompatibilityMode"].includes(name) ? aa : [], tag));
  for (const [name, sel] of Object.entries(SELECTORS.vat)) specs.push(callSpec(`vat_${name}`, ROOTS.vat, sel, name === "ilks" ? decodeVatIlk : decodeUint, name === "ilks" ? bb : [], tag));
  for (const [name, sel] of Object.entries(SELECTORS.dog)) specs.push(callSpec(`dog_${name}`, ROOTS.dog, sel, name === "ilks" ? decodeDogIlk : name === "vow" ? decodeAddress : decodeUint, name === "ilks" ? bb : [], tag));
  specs.push(callSpec("spot_ilks", ROOTS.spotter, SELECTORS.spotter.ilks, decodeSpotIlk, bb, tag), callSpec("spot_par", ROOTS.spotter, SELECTORS.spotter.par, decodeUint, [], tag));
  for (const [name, sel] of Object.entries(SELECTORS.join)) specs.push(callSpec(`join_${name}`, ROOTS.joinProxy, sel, ["vat", "gem"].includes(name) ? decodeAddress : name === "ilk" ? decodeBytes32 : decodeUint, [], tag));
  for (const [name, sel] of Object.entries(SELECTORS.clip)) specs.push(callSpec(`clip_${name}`, ROOTS.clipProxy, sel, ["vow", "dog", "vat", "spotter", "calc"].includes(name) ? decodeAddress : name === "ilk" ? decodeBytes32 : decodeUint, [], tag));
  specs.push(callSpec("oracle_peek", ROOTS.oracleProxy, SELECTORS.oracle.peek, decodePeek, [], tag), callSpec("calc_tau", ROOTS.calc, SELECTORS.calc.tau, decodeUint, [], tag), callSpec("token_decimals", ROOTS.token, SELECTORS.token.decimals, decodeUint, [], tag));
  specs.push(
    callSpec("auth_dog_interaction", ROOTS.dog, SELECTORS.auth.wards, decodeUint, [addressArg(ROOTS.interaction)], tag),
    callSpec("auth_clip_dog", ROOTS.clipProxy, SELECTORS.auth.wards, decodeUint, [addressArg(ROOTS.dog)], tag),
    callSpec("auth_clip_interaction", ROOTS.clipProxy, SELECTORS.auth.wards, decodeUint, [addressArg(ROOTS.interaction)], tag),
    callSpec("auth_vat_dog", ROOTS.vat, SELECTORS.auth.wards, decodeUint, [addressArg(ROOTS.dog)], tag),
    callSpec("auth_vat_clip", ROOTS.vat, SELECTORS.auth.wards, decodeUint, [addressArg(ROOTS.clipProxy)], tag),
    callSpec("auth_vat_spotter", ROOTS.vat, SELECTORS.auth.wards, decodeUint, [addressArg(ROOTS.spotter)], tag),
    callSpec("auth_vat_jug", ROOTS.vat, SELECTORS.auth.wards, decodeUint, [addressArg(ROOTS.jug)], tag)
  );
  if (specs.length !== PLAN.codeAndSlotCalls + PLAN.stateCalls) stop("INTERNAL_PLAN_MISMATCH");
  const x = await executeSpecs(endpoint, specs, budget, transport), contracts = FIXED_ROOTS.map((address, i) => ({ address, runtime: x[`code${i}`], proxy: classifyProxy({ implementation: x[`slot${i}_implementation`], admin: x[`slot${i}_admin`], beacon: x[`slot${i}_beacon`] }) }));
  const [terminalRaw] = await rpcBatch(endpoint, [{ method: "eth_getBlockByNumber", params: [tag, false] }], budget, { transport });
  const values = { interaction: Object.fromEntries(Object.keys(I).map((k) => [k, typeof x[`i_${k}`] === "bigint" ? x[`i_${k}`].toString() : x[`i_${k}`]])), vat: Object.fromEntries(Object.keys(SELECTORS.vat).map((k) => [k, k === "ilks" ? Object.fromEntries(Object.entries(x.vat_ilks).map(([a, b]) => [a, b.toString()])) : x[`vat_${k}`].toString()])), dog: Object.fromEntries(Object.keys(SELECTORS.dog).map((k) => [k, k === "ilks" ? Object.fromEntries(Object.entries(x.dog_ilks).map(([a, b]) => [a, typeof b === "bigint" ? b.toString() : b])) : typeof x[`dog_${k}`] === "bigint" ? x[`dog_${k}`].toString() : x[`dog_${k}`]])), spotter: { ilks: { oracle: x.spot_ilks.oracle, mat: x.spot_ilks.mat.toString() }, par: x.spot_par.toString() }, join: Object.fromEntries(Object.keys(SELECTORS.join).map((k) => [k, typeof x[`join_${k}`] === "bigint" ? x[`join_${k}`].toString() : x[`join_${k}`]])), clip: Object.fromEntries(Object.keys(SELECTORS.clip).map((k) => [k, typeof x[`clip_${k}`] === "bigint" ? x[`clip_${k}`].toString() : x[`clip_${k}`]])), oracle: x.oracle_peek, calc: { tau: x.calc_tau.toString() }, token: { decimals: x.token_decimals.toString() }, auth: { dogInteraction: x.auth_dog_interaction.toString(), clipDog: x.auth_clip_dog.toString(), clipInteraction: x.auth_clip_interaction.toString(), vatDog: x.auth_vat_dog.toString(), vatClip: x.auth_vat_clip.toString(), vatSpotter: x.auth_vat_spotter.toString(), vatJug: x.auth_vat_jug.toString() } };
  return canonical({ chainId: 56, pin: { number: header.number.toString(), timestamp: header.timestamp.toString(), hash: header.hash, stateRoot: header.stateRoot, terminalHeaderConsistent: terminalHeaderConsistency({ number: header.number.toString(), timestamp: header.timestamp.toString(), hash: header.hash, stateRoot: header.stateRoot }, terminalRaw) }, contracts, values });
}

const same = (a, b) => lower(a) === lower(b), positiveDiff = (a, b) => BigInt(a) > BigInt(b) ? BigInt(a) - BigInt(b) : 0n;
function evaluate(chain) {
  const kills = [], inconclusive = ["SOURCE_RUNTIME_UNATTESTED", "POST_TAG_REGISTRY_IS_PROVENANCE_NOT_RUNTIME_ATTESTATION", "ACTIVE_AUCTION_EXISTENCE_NOT_QUERIED", "INTERACTION_HAY_HAYJOIN_DUTY_DISTRIBUTOR_RUNTIME_RECORD_ONLY"];
  if (!chain || chain.chainId !== 56) kills.push("CHAIN_ID_MISMATCH"); if (!chain?.pin?.terminalHeaderConsistent) kills.push("TERMINAL_HEADER_INCONSISTENT"); if (!chain?.values) return canonical({ classification: "KILLED/PASS_B_NOT_WARRANTED", passBWarranted: false, killReasons: [...new Set(kills)].sort(), inconclusiveReasons: inconclusive, analysis: null });
  const v = chain.values, i = v.interaction, vat = v.vat, dog = v.dog, join = v.join, clip = v.clip, coll = i.collaterals;
  const contractMap = new Map(chain.contracts.map((x) => [x.address, x]));
  const expectedImpls = [[ROOTS.joinProxy, ROOTS.joinImplementation], [ROOTS.clipProxy, ROOTS.clipImplementation], [ROOTS.oracleProxy, ROOTS.oracleImplementation]];
  for (const [proxy, impl] of expectedImpls) { const p = contractMap.get(proxy)?.proxy; if (!p || p.kind !== "IMPLEMENTATION" || !same(p.implementation, impl) || p.beacon !== null) kills.push(`PROXY_IMPLEMENTATION_MISMATCH_${proxy.slice(2, 8)}`); }
  if (![i.vat, vat && ROOTS.vat].every((x) => same(x, ROOTS.vat)) || !same(i.dog, ROOTS.dog) || !same(i.spotter, ROOTS.spotter) || !same(i.jug, ROOTS.jug)) kills.push("INTERACTION_CORE_LINK_MISMATCH");
  if ([i.hay, i.hayJoin, i.dutyCalculator, i.borrowLisUSDListaDistributor].some((x) => !x || same(x, ZERO))) kills.push("INTERACTION_REQUIRED_LINK_ZERO");
  if (!same(coll.join, ROOTS.joinProxy) || !same(coll.clip, ROOTS.clipProxy) || !same(coll.ilk, ILK)) kills.push("MBTC_COLLATERAL_MAPPING_MISMATCH");
  if (!same(join.vat, ROOTS.vat) || !same(join.gem, ROOTS.token) || !same(join.ilk, ILK) || join.live !== "1") kills.push("MBTC_JOIN_WIRING_MISMATCH");
  if (!same(dog.ilks.clip, ROOTS.clipProxy) || !same(dog.vow, ROOTS.vow)) kills.push("DOG_WIRING_MISMATCH");
  if (!same(v.spotter.ilks.oracle, ROOTS.oracleProxy)) kills.push("ORACLE_WIRING_MISMATCH");
  if (!same(clip.vat, ROOTS.vat) || !same(clip.dog, ROOTS.dog) || !same(clip.spotter, ROOTS.spotter) || !same(clip.vow, ROOTS.vow) || !same(clip.calc, ROOTS.calc) || !same(clip.ilk, ILK)) kills.push("CLIP_WIRING_MISMATCH");
  if (vat.live !== "1") kills.push("VAT_NOT_LIVE"); if (dog.live !== "1") kills.push("DOG_NOT_LIVE"); if (coll.live !== "1") kills.push("COLLATERAL_NOT_ACTIVE");
  if (v.token.decimals !== "18") kills.push("MBTC_DECIMALS_NOT_18"); if (v.calc.tau === "0") kills.push("CALC_TAU_ZERO");
  if (v.spotter.par === "0") kills.push("SPOTTER_PAR_ZERO"); if (v.spotter.ilks.mat === "0") kills.push("SPOTTER_MAT_ZERO"); if (!v.oracle.valid || BigInt(v.oracle.value) === 0n) kills.push("ORACLE_PEEK_INVALID_OR_ZERO"); if (clip.buf === "0") kills.push("CLIP_BUF_ZERO");
  const requiredAuth = ["dogInteraction", "clipDog", "clipInteraction", "vatDog", "vatClip", "vatSpotter", "vatJug"];
  for (const edge of requiredAuth) if (v.auth?.[edge] !== "1") kills.push(`AUTH_EDGE_MISSING_${edge}`);
  const econ = arithmetic(BigInt(vat.ilks.dust), BigInt(vat.ilks.rate), BigInt(dog.ilks.chop), BigInt(clip.tip), BigInt(clip.chip));
  if (!econ.ratePositive) kills.push("RATE_ZERO"); if (!econ.dustPositive) kills.push("DUST_ZERO"); if (!econ.chopAtLeastWad) kills.push("CHOP_BELOW_WAD"); if (!econ.tabPositive) kills.push("REQUIRED_TAB_ZERO"); if (BigInt(clip.chost) !== econ.chostExpectedRad) kills.push("CHOST_MISMATCH"); if (!econ.rewardExceedsPenaltyCapacity) kills.push("NONPOSITIVE_REWARD_RESIDUAL");
  const requiredDebtRad = econ.requiredDebtRad === null ? 0n : econ.requiredDebtRad, requiredTabRad = econ.requiredTabRad === null ? 0n : econ.requiredTabRad, ilkDebtRad = BigInt(vat.ilks.art) * BigInt(vat.ilks.rate);
  const capacity = { requiredDebtRad, ilkDebtRad, globalVatAvailableRad: positiveDiff(vat.Line, vat.debt), ilkVatAvailableRad: positiveDiff(vat.ilks.line, ilkDebtRad), dogHeadroomRad: positiveDiff(dog.Hole, dog.Dirt), ilkHeadroomRad: positiveDiff(dog.ilks.hole, dog.ilks.dirt), vatDebtWithinLine: BigInt(vat.debt) <= BigInt(vat.Line), ilkDebtWithinLine: ilkDebtRad <= BigInt(vat.ilks.line), dogDirtWithinHole: BigInt(dog.Dirt) <= BigInt(dog.Hole), ilkDirtWithinHole: BigInt(dog.ilks.dirt) <= BigInt(dog.ilks.hole), globalVatMinimumDebtAvailable: BigInt(vat.debt) <= BigInt(vat.Line) && BigInt(vat.Line) - BigInt(vat.debt) >= requiredDebtRad, ilkVatMinimumDebtAvailable: ilkDebtRad <= BigInt(vat.ilks.line) && BigInt(vat.ilks.line) - ilkDebtRad >= requiredDebtRad };
  if (!capacity.vatDebtWithinLine) kills.push("VAT_DEBT_EXCEEDS_LINE"); if (!capacity.ilkDebtWithinLine) kills.push("ILK_DEBT_EXCEEDS_LINE"); if (!capacity.dogDirtWithinHole) kills.push("DOG_DIRT_EXCEEDS_HOLE"); if (!capacity.ilkDirtWithinHole) kills.push("ILK_DIRT_EXCEEDS_HOLE");
  const staticHealthy = kills.length === 0, auctionPublic = i.auctionWhitelistMode === "0", borrowerPublic = i.whitelistMode === "0", notBlacklisted = i.tokensBlacklist === "0", providerZero = same(i.helioProviders, ZERO), providerCompatible = i.providerCompatibilityMode !== "0";
  const capacityForKick = econ.ratePositive && capacity.globalVatMinimumDebtAvailable && capacity.ilkVatMinimumDebtAvailable && capacity.dogDirtWithinHole && capacity.ilkDirtWithinHole && capacity.dogHeadroomRad >= requiredTabRad && capacity.ilkHeadroomRad >= requiredTabRad;
  const routes = { simpleAttackerNewVaultPermissionless: staticHealthy && borrowerPublic && notBlacklisted && (providerZero || providerCompatible) && capacityForKick, existingUnsafeVaultPublicKickConfigEligible: staticHealthy && auctionPublic && BigInt(clip.stopped) < 1n && capacityForKick, existingUnsafeVaultPublicRedoConfigEligible: staticHealthy && auctionPublic && BigInt(clip.stopped) < 2n && requiredTabRad >= BigInt(clip.chost), providerConfigured: !providerZero, providerCallRequiredForKick: !providerZero, borrowerWhitelistAffectsNewVaultOnly: !borrowerPublic, blacklistAffectsDepositBorrowNotStartAuction: !notBlacklisted };
  const passBWarranted = kills.length === 0 && (routes.existingUnsafeVaultPublicKickConfigEligible || routes.existingUnsafeVaultPublicRedoConfigEligible);
  if (!auctionPublic) kills.push("PUBLIC_AUCTION_CALLER_WHITELISTED"); if (BigInt(clip.stopped) >= 2n) kills.push("KICK_AND_REDO_STOPPED");
  return canonical({ classification: passBWarranted ? "PASS_B_WARRANTED/MBTC_DEPLOYMENT_EVIDENCE_ONLY" : "KILLED/PASS_B_NOT_WARRANTED", passBWarranted, killReasons: [...new Set(kills)].sort(), inconclusiveReasons: [...new Set(inconclusive)].sort(), analysis: { economics: econ, capacity, routes, controls: { whitelistMode: i.whitelistMode, auctionWhitelistMode: i.auctionWhitelistMode, blacklist: i.tokensBlacklist, provider: i.helioProviders, providerCompatibilityMode: i.providerCompatibilityMode, stopped: clip.stopped }, sourceRuntimeAttested: false, promotion: false, executable: false } });
}

function leakScan(v, secrets = []) { const text = JSON.stringify(v), low = lower(text), findings = []; if (/(?:https?|wss?):\/\//i.test(text)) findings.push("URL"); if (/"(?:url|headers|authorization|apiKey|secret|raw|rawRpc|rawResponse|bytecode|privateKey)"\s*:/i.test(text)) findings.push("FORBIDDEN_FIELD"); if (/0x[0-9a-f]{66,}/i.test(text)) findings.push("RAW_HEX"); for (const s of secrets) if (s.length >= 4 && low.includes(lower(s))) findings.push("INVENTORY"); return { passed: findings.length === 0, findings: [...new Set(findings)].sort() }; }
async function executeCapture(options) { if (options?.captureMode !== true) stop("CAPTURE_REQUIRED"); const inventory = parseInventoryText(options.inventoryText, true), budget = new Budget(), endpoint = await qualify(inventory, budget, options.transport), chain = await capture(endpoint, budget, options.transport), outcome = evaluate(chain); const output = canonical({ schemaVersion: SCHEMA_VERSION, findingId: FINDING_ID, provenance: { sourceLabel: SOURCE_LABEL, logicCommit: LOGIC_COMMIT, registryCommit: REGISTRY_COMMIT, designSha256: DESIGN_SHA256 }, specSha256: SPEC_SHA256, sourceRuntimeAttested: false, promotion: false, executable: false, captureMode: "BSC_NUMERIC_PIN_TERMINAL_HASH_STATE_ROOT_RECHECK", classification: outcome.classification, passBWarranted: outcome.passBWarranted, killReasons: outcome.killReasons, inconclusiveReasons: outcome.inconclusiveReasons, chain, analysis: outcome.analysis, policy: { allowedMethods: ALLOWED_METHODS, caps: CAPS, plan: PLAN, equations: EQUATIONS, inventorySelection: INVENTORY_SELECTION_POLICY, fixedTargetsOnly: true, dynamicTraversal: false, retry: { maximumTotal: 1, transportOnly: true, delayMs: 750, scope: RETRY_SCOPE }, logs: false, traces: false, transactions: false, signing: false, arbitraryAccounts: false, storageScans: false }, rpc: budget.summary(), safety: { inventoryMemoryOnly: true, endpointMaterialPersisted: false, rawRpcPersisted: false, rawBytecodePersisted: false, networkOnlyWithExplicitCapture: true } }); const bytes = Buffer.from(JSON.stringify(output)); if (bytes.length > CAPS.sanitizedOutputBytes) stop("OUTPUT_CAP_EXCEEDED"); const leak = leakScan(output, inventory.secrets); if (!leak.passed) stop(`OUTPUT_LEAK_${leak.findings[0]}`); return output; }
function staticCheck() { return { status: "PASS", mode: "offline-check-only", packageId: FINDING_ID, sourceLabel: SOURCE_LABEL, logicCommit: LOGIC_COMMIT, registryCommit: REGISTRY_COMMIT, designSha256: DESIGN_SHA256, candidate: "mBTC", candidateCount: 1, fixedRoots: FIXED_ROOTS.length, trueWorstCaseRequests: PLAN.trueWorstCaseRequests, outputCreated: false, oldGenericDisabled: true, sourceRuntimeAttested: false, promotion: false, executable: false, specSha256: SPEC_SHA256 }; }
async function main(argv = process.argv.slice(2)) { if (argv.length === 0 || (argv.length === 1 && argv[0] === "--check-only")) { process.stdout.write(`${JSON.stringify(staticCheck())}\n`); return; } if (argv.length !== 1 || argv[0] !== "--capture") stop("CLI_ARGUMENTS_INVALID"); if (fs.existsSync(OUTPUT) || fs.existsSync(OLD_OUTPUT)) stop("CAPTURE_OUTPUT_ALREADY_EXISTS"); const output = await executeCapture({ captureMode: true, inventoryText: fs.readFileSync(INVENTORY, "utf8") }); fs.mkdirSync(path.dirname(OUTPUT), { recursive: true }); fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" }); process.stdout.write(`${JSON.stringify({ status: "PASS", classification: output.classification, output: path.relative(ROOT, OUTPUT).replace(/\\/g, "/") })}\n`); }
if (require.main === module) main().catch((e) => { process.stderr.write(`${JSON.stringify({ status: "STOPPED", reason: e instanceof Stop || e instanceof TransportFailure ? e.code : "INTERNAL_FAILURE" })}\n`); process.exitCode = 1; });
module.exports = { ROOT, OUTPUT, OLD_OUTPUT, DESIGN_REL, DESIGN_SHA256, FINDING_ID, SCHEMA_VERSION, LOGIC_COMMIT, REGISTRY_COMMIT, SOURCE_LABEL, CHAIN_ID, WAD, ZERO, ROOTS, ILK, FIXED_ROOTS, SLOTS, SELECTORS, CAPS, PLAN, EQUATIONS, RETRY_SCOPE, INVENTORY_SELECTION_POLICY, ALLOWED_METHODS, SPEC_SHA256, Stop, TransportFailure, canonical, canonicalJson, specDescriptor, strictHex, words, decodeUint, decodeAddress, decodeBytes32, decodePeek, decodeCollateral, decodeVatIlk, decodeDogIlk, decodeSpotIlk, calldata, canonicalQuantity, strictHeader, terminalHeaderConsistency, slotAddress, classifyProxy, summarizeCode, ceilDiv, arithmetic, Budget, enforceBatch, parseInventoryText, rpcBatch, mapLimit, qualify, assertFixedTarget, evaluate, leakScan, executeCapture, staticCheck };
