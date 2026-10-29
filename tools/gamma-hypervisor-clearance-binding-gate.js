#!/usr/bin/env node
"use strict";

// Bounded read-only clearance binding/configuration gate. RPC inventory values
// stay process-only and are rejected from persisted artifacts.
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { Interface, getAddress, id, keccak256 } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const CANONICAL = path.join(ROOT, "targets", "gamma-hypervisor-b4d90b3");
const DEPLOYED = path.join(ROOT, "targets", "gamma-hypervisor-deployed-d5f487");
const OUT = path.join(ROOT, "reports", "raw", "fast", "gamma-hypervisor-clearance-binding-gate");
const CAPTURE = path.join(OUT, "capture.json"), CHECKPOINT = path.join(OUT, "checkpoint.json");
const ARTIFACT = path.join(OUT, "partial-artifact.json"), MANIFEST = path.join(OUT, "manifest.json");
const CLEARANCE = "0x09a8ebb5bf22b1da81835164d6653fa1d57dbbee";
const UNIPROXY = "0x911bfbaca43f117e52197ae62d439d6a645c8886";
const HYPE = "0xd5f4877263b736625ba363385983c2d02b41f35b";
const POOL = "0xd1d5a4c0ea98971894772dcd6d2f1dc71083c44e";
const TOKEN0 = "0x6dea81c8171d0ba574754ef6f8b412f2ed88c54d";
const TOKEN1 = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const ACTOR = "0x57622d4c4be22ab9ad3da104dc281d738e6f5b6a";
const ORDINARY_ACTOR = "0x71e7d05be74ff748c45402c06a941c822d756dc5";
const CHAIN = 1n, ZERO = `0x${"0".repeat(40)}`, ZERO32 = `0x${"0".repeat(64)}`, Q96 = 2n ** 96n, Q192 = 2n ** 192n, PRECISION = 10n ** 36n;
const IMPLEMENTATION_SLOT = `0x${(BigInt(id("eip1967.proxy.implementation")) - 1n).toString(16).padStart(64, "0")}`;
const ADMIN_SLOT = `0x${(BigInt(id("eip1967.proxy.admin")) - 1n).toString(16).padStart(64, "0")}`;
const BEACON_SLOT = `0x${(BigInt(id("eip1967.proxy.beacon")) - 1n).toString(16).padStart(64, "0")}`;
const METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_getLogs"]);
const LIMITS = Object.freeze({ inventoryBytes: 1024 * 1024, candidates: 64, families: 32, calls: 1800, responseBytes: 8 * 1024 * 1024,
  totalResponseBytes: 128 * 1024 * 1024, requestMs: 15000, wallMs: 12 * 60 * 1000, logChunk: 50000n, minLogChunk: 1000n, rows: 10000 });

function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function addr(value) { try { return getAddress(value).toLowerCase(); } catch (_) { return null; } }
function qty(value) { return `0x${BigInt(value).toString(16)}`; }
function pinArg(pin) { return { blockHash: pin.hash, requireCanonical: true }; }
function value(row) { return row?.reason === null ? row.value : null; }
function serial(item) { if (typeof item === "bigint") return item.toString(); if (typeof item === "string") return /^0x[0-9a-fA-F]{40}$/u.test(item) ? item.toLowerCase() : item;
  if (Array.isArray(item)) return item.map(serial); if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).filter(([k]) => !/^\d+$/u.test(k)).map(([k, v]) => [k, serial(v)])); return item; }
function bytes(hex) { return typeof hex === "string" && /^0x(?:[0-9a-fA-F]{2})*$/u.test(hex) ? Buffer.from(hex.slice(2), "hex") : null; }
function codeSummary(code) { const raw = bytes(code); return raw ? { present: raw.length > 0, bytes: raw.length, keccak256: raw.length ? keccak256(code) : null, sha256: raw.length ? sha(raw) : null } : null; }
function header(block) { return block?.hash ? { number: BigInt(block.number).toString(), hash: block.hash.toLowerCase(), timestamp: BigInt(block.timestamp).toString() } : null; }
function slotAddress(word) { return /^0x[0-9a-fA-F]{64}$/u.test(word || "") ? addr(`0x${word.slice(-40)}`) : null; }
function ceilDiv(a, b) { return (a + b - 1n) / b; }
function isqrt(value) { if (value < 0n) throw new Error("negative sqrt"); if (value < 2n) return value; let x0 = value, x1 = (x0 + value / x0) >> 1n;
  while (x1 < x0) { x0 = x1; x1 = (x0 + value / x0) >> 1n; } return x0; }
function decimal(raw, decimals = 18) { const x = BigInt(raw), d = 10n ** BigInt(decimals), whole = x / d, fraction = (x % d).toString().padStart(decimals, "0").replace(/0+$/u, ""); return fraction ? `${whole}.${fraction}` : whole.toString(); }

function parseInventory(text) {
  if (Buffer.byteLength(text) > LIMITS.inventoryBytes) throw new Error("inventory cap"); const rows = [], seen = new Set(), lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) for (const match of lines[i].matchAll(/https:\/\/[^\s<'"`\])}]+/giu)) {
    let url; try { url = new URL(match[0].replace(/[>,.;]+$/u, "")); } catch (_) { continue; } if (url.protocol !== "https:" || url.username || url.password || url.hash) continue;
    const headers = {}; for (const h of lines[i].matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/giu)) headers[h[1].trim()] = h[2].trim();
    const key = `${url.href}\0${JSON.stringify(headers)}`; if (seen.has(key)) continue; seen.add(key); const context = lines.slice(Math.max(0, i - 3), i + 4).join(" ");
    rows.push({ url, headers, family: url.hostname.toLowerCase(), hint: /(?:ethereum|eth-mainnet|chain(?:id)?[^a-z0-9]{0,8}(?:1|0x1))(?!\d)/iu.test(context) });
  } return rows.sort((a, b) => Number(b.hint) - Number(a.hint)).slice(0, LIMITS.candidates).map(({ url, headers, family }) => ({ url, headers, family }));
}
function secretCorpus(rows) { const out = new Set(); for (const row of rows) for (const x of [row.url.href, ...row.url.pathname.split("/"), ...row.url.searchParams.values(), ...Object.values(row.headers)])
  if (String(x).length >= 16) { out.add(String(x)); out.add(String(x).toLowerCase()); } return [...out]; }
function guard(object, secrets) { const text = JSON.stringify(object), low = text.toLowerCase(); if (/(?:https?|wss?):\/\//iu.test(text)) throw new Error("URL in output");
  if (/"(?:endpoint|provider|hostname|domain|headers)"\s*:/iu.test(text)) throw new Error("provider key in output"); for (const s of secrets) if (text.includes(s) || low.includes(s.toLowerCase())) throw new Error("inventory material in output"); }
class Budget { constructor() { this.start = Date.now(); this.calls = 0; this.responseBytes = 0; } use() { if (++this.calls > LIMITS.calls || Date.now() - this.start > LIMITS.wallMs) throw new Error("RPC budget"); }
  add(n) { this.responseBytes += n; if (n > LIMITS.responseBytes || this.responseBytes > LIMITS.totalResponseBytes) throw new Error("response budget"); }
  summary() { return { calls: this.calls, responseBytes: this.responseBytes, elapsedMs: Date.now() - this.start, withinLimits: true, limits: { calls: LIMITS.calls, wallMs: LIMITS.wallMs, responseBytes: LIMITS.totalResponseBytes } }; } }
async function rpc(ep, method, params, budget) { if (!METHODS.has(method)) throw new Error("method blocked"); budget.use(); const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: budget.calls, method, params }));
  return new Promise((resolve) => { let done = false, request; const finish = (x) => { if (done) return; done = true; clearTimeout(timer); try { request?.destroy(); } catch (_) {} resolve(x); };
    const timer = setTimeout(() => finish({ ok: false, reason: "TIMEOUT" }), LIMITS.requestMs); const options = { protocol: "https:", hostname: ep.url.hostname, port: ep.url.port || 443,
      path: `${ep.url.pathname}${ep.url.search}`, method: "POST", agent: false, headers: { ...ep.headers, "content-type": "application/json", accept: "application/json", "accept-encoding": "identity", "content-length": body.length } };
    try { request = https.request(options, (response) => { const chunks = []; let size = 0; response.on("data", (chunk) => { size += chunk.length; if (size > LIMITS.responseBytes) finish({ ok: false, reason: "RESPONSE_CAP" }); else chunks.push(Buffer.from(chunk)); });
      response.on("end", () => { if (done) return; try { budget.add(size); } catch (e) { return finish({ ok: false, reason: e.message }); } if (response.statusCode !== 200) return finish({ ok: false, reason: "HTTP_STATUS" });
        try { const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); finish(parsed.error ? { ok: false, reason: "RPC_ERROR", errorData: typeof parsed.error.data === "string" ? parsed.error.data : null } : { ok: true, result: parsed.result }); }
        catch (_) { finish({ ok: false, reason: "INVALID_JSON" }); } }); }); request.on("error", () => finish({ ok: false, reason: "TRANSPORT_ERROR" })); request.end(body); }
    catch (_) { finish({ ok: false, reason: "TRANSPORT_ERROR" }); } }); }

function compileArtifact() { const solc = require(path.join(CANONICAL, "node_modules", "solc-0.7")); const original = JSON.parse(fs.readFileSync(path.join(DEPLOYED, "sourcify", "standard-json-input.json")));
  original.settings.outputSelection = { "*": { "*": ["abi", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] } };
  const output = JSON.parse(solc.compile(JSON.stringify(original))), errors = (output.errors || []).filter((x) => x.severity === "error"); if (errors.length) throw new Error(errors.map((x) => x.formattedMessage).join(" | "));
  const variants = {}; for (const name of ["ClearingV2", "Clearing"]) { const row = output.contracts?.[`contracts/${name}.sol`]?.[name]; if (row) variants[name] = { abi: row.abi, runtime: `0x${row.evm.deployedBytecode.object}`, immutableReferences: row.evm.deployedBytecode.immutableReferences }; }
  if (!variants.ClearingV2) throw new Error("ClearingV2 compile unavailable"); return { schema: "gamma-clearance-partial-artifact/v1", compiler: solc.version(), settings: original.settings,
    sources: { ClearingV2: { path: "targets/gamma-hypervisor-deployed-d5f487/sources/contracts/ClearingV2.sol", sha256: sha(fs.readFileSync(path.join(DEPLOYED, "sources", "contracts", "ClearingV2.sol"))) },
      canonicalB4: { path: "targets/gamma-hypervisor-b4d90b3/contracts/ClearingV2.sol", sha256: sha(fs.readFileSync(path.join(CANONICAL, "contracts", "ClearingV2.sol"))) } }, variants }; }
function runtimeCompare(code, variants) { const raw = bytes(code); if (!raw) return { matched: null, variants: {} }; const out = {};
  for (const [name, row] of Object.entries(variants)) { const expected = bytes(row.runtime), exact = raw.equals(expected); out[name] = { exact, onchainBytes: raw.length, expectedBytes: expected.length,
    onchainKeccak256: keccak256(code), expectedKeccak256: keccak256(row.runtime), immutableReferenceCount: Object.keys(row.immutableReferences || {}).length }; }
  const matched = Object.entries(out).find(([, row]) => row.exact)?.[0] || null; return { matched, variants: out }; }
async function call(ep, block, target, iface, fragment, args, budget) { let data; try { data = iface.encodeFunctionData(fragment, args || []); } catch (_) { return { value: null, reason: "ENCODE" }; }
  const row = await rpc(ep, "eth_call", [{ to: target, data }, block], budget); if (!row.ok) { let revert = null; try { if (row.errorData?.startsWith("0x08c379a0")) revert = new Interface(["error Error(string)"]).parseError(row.errorData)?.args?.[0] || null; } catch (_) {}
    return { value: null, reason: row.reason, revert }; } try { const decoded = iface.decodeFunctionResult(fragment, row.result); return { value: serial(decoded.length === 1 ? decoded[0] : [...decoded]), reason: null }; }
  catch (_) { return { value: null, reason: "DECODE" }; } }
async function callMap(ep, block, target, iface, specs, budget) { const out = {}; for (const [key, fragment, args = []] of specs) out[key] = await call(ep, block, target, iface, fragment, args, budget); return out; }
async function codeAt(ep, block, target, budget) { const row = await rpc(ep, "eth_getCode", [target, block], budget); return row.ok ? { raw: row.result, summary: codeSummary(row.result), reason: null } : { raw: null, summary: null, reason: row.reason }; }
async function slotAt(ep, block, target, slot, budget) { const row = await rpc(ep, "eth_getStorageAt", [target, slot, block], budget); return row.ok ? { raw: row.result, address: slotAddress(row.result), zero: row.result === ZERO32, reason: null } : { raw: null, address: null, zero: null, reason: row.reason }; }
async function proxyBinding(ep, block, target, budget) { const runtime = await codeAt(ep, block, target, budget), implementation = await slotAt(ep, block, target, IMPLEMENTATION_SLOT, budget), admin = await slotAt(ep, block, target, ADMIN_SLOT, budget), beacon = await slotAt(ep, block, target, BEACON_SLOT, budget);
  const beaconImpl = beacon.address && beacon.address !== ZERO ? await call(ep, block, beacon.address, new Interface(["function implementation() view returns(address)"]), "implementation", [], budget) : null;
  const resolved = addr(value(beaconImpl)) || (implementation.address !== ZERO ? implementation.address : null); const implCode = resolved ? await codeAt(ep, block, resolved, budget) : null;
  return { address: target, runtime: { summary: runtime.summary, reason: runtime.reason }, slots: { implementation, admin, beacon }, beaconImplementation: beaconImpl, resolvedImplementation: resolved,
    implementationRuntime: implCode ? { summary: implCode.summary, reason: implCode.reason } : null, direct: !resolved, rawRuntime: runtime.raw, comparedRuntime: implCode?.raw || runtime.raw };
}

async function qualify(candidates, clearIface, eventTopics, budget, exactPin = null) { const tested = new Set(), capable = []; let count = 0;
  for (const ep of candidates) { if (tested.has(ep.family) || count >= LIMITS.families) continue; tested.add(ep.family); count++; const chain = await rpc(ep, "eth_chainId", [], budget); if (!chain.ok || BigInt(chain.result) !== CHAIN) continue;
    const finalized = await rpc(ep, "eth_getBlockByNumber", ["finalized", false], budget); if (!finalized.ok || !header(finalized.result)) continue;
    const selected = exactPin ? await rpc(ep, "eth_getBlockByNumber", [qty(BigInt(exactPin.number)), false], budget) : finalized;
    const pin = selected.ok ? header(selected.result) : null; if (!pin || (exactPin && pin.hash !== exactPin.hash)) continue; const block = pinArg(pin);
    const code = await codeAt(ep, block, CLEARANCE, budget), storage = await slotAt(ep, block, CLEARANCE, ZERO32, budget), owner = await call(ep, block, CLEARANCE, clearIface, "owner", [], budget);
    const logs = await rpc(ep, "eth_getLogs", [{ address: CLEARANCE, blockHash: pin.hash, topics: [eventTopics] }], budget);
    const observe = await call(ep, block, POOL, poolIface, "observe", [[3600, 0]], budget);
    if (code.summary?.present && storage.reason === null && owner.reason === null && logs.ok && observe.reason === null) capable.push({ ep, pin });
  } return { tested: count, capable, selected: capable[0] || null };
}
async function creationBlock(ep, pin, target, budget) { let low = 0n, high = BigInt(pin.number); while (low < high) { const mid = (low + high) >> 1n, row = await codeAt(ep, qty(mid), target, budget); if (row.reason) throw new Error("creation search"); if (row.summary.present) high = mid; else low = mid + 1n; } return low; }
function decodeLog(log, iface) { const raw = { blockNumber: BigInt(log.blockNumber).toString(), transactionHash: log.transactionHash.toLowerCase(), logIndex: BigInt(log.logIndex).toString(), data: log.data.toLowerCase(), topics: log.topics.map((x) => x.toLowerCase()) };
  try { const parsed = iface.parseLog({ data: log.data, topics: log.topics }), args = Object.fromEntries(parsed.fragment.inputs.map((input, i) => [input.name || String(i), serial(parsed.args[i])])); return { ...raw, event: parsed.name, args }; }
  catch (_) { return { ...raw, event: "UNDECODED", args: null }; } }
function saveCheckpoint(cp, secrets) { guard(cp, secrets); fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(CHECKPOINT, `${JSON.stringify(cp, null, 2)}\n`); }
async function scan(ep, pin, from, iface, topics, budget, secrets) { let cp = { schema: "gamma-clearance-config-history/v1", chainId: "1", target: CLEARANCE, pin, fromBlock: from.toString(), nextBlock: from.toString(), complete: false, events: [] };
  try { const old = JSON.parse(fs.readFileSync(CHECKPOINT)); if (old.pin?.hash === pin.hash && old.target === CLEARANCE) { cp = old; if (cp.complete) return cp; } } catch (_) {} let start = BigInt(cp.nextBlock), chunk = LIMITS.logChunk, end = BigInt(pin.number);
  while (start <= end) { const stop = start + chunk - 1n > end ? end : start + chunk - 1n, row = await rpc(ep, "eth_getLogs", [{ address: CLEARANCE, fromBlock: qty(start), toBlock: qty(stop), topics: [topics] }], budget);
    if (!row.ok) { if (chunk > LIMITS.minLogChunk) { chunk = chunk / 2n < LIMITS.minLogChunk ? LIMITS.minLogChunk : chunk / 2n; continue; } throw new Error(`log scan blocked ${start}`); }
    for (const log of row.result || []) { if (cp.events.length >= LIMITS.rows) throw new Error("event cap"); cp.events.push(decodeLog(log, iface)); } start = stop + 1n; cp.nextBlock = start.toString(); if (cp.events.length % 32 === 0 || start > end) saveCheckpoint(cp, secrets);
  } cp.complete = true; cp.completedAt = new Date().toISOString(); saveCheckpoint(cp, secrets); return cp; }

const poolIface = new Interface(["function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)", "function liquidity() view returns(uint128)", "function fee() view returns(uint24)", "function tickSpacing() view returns(int24)", "function observe(uint32[]) view returns(int56[],uint160[])"]);
const hypeIface = new Interface(["function currentTick() view returns(int24)", "function baseLower() view returns(int24)", "function baseUpper() view returns(int24)", "function limitLower() view returns(int24)", "function limitUpper() view returns(int24)",
  "function totalSupply() view returns(uint256)", "function getTotalAmounts() view returns(uint256,uint256)", "function deposit0Max() view returns(uint256)", "function deposit1Max() view returns(uint256)", "function token0() view returns(address)", "function token1() view returns(address)"]);
const uniIface = new Interface(["function clearance() view returns(address)", "function owner() view returns(address)", "function getDepositAmount(address,address,uint256) view returns(uint256,uint256)"]);

function positionObject(raw) { if (!Array.isArray(raw) || raw.length < 14) return null; const names = ["customRatio", "customTwap", "ratioRemoved", "depositOverride", "twapOverride", "version", "twapInterval", "priceThreshold", "deposit0Max", "deposit1Max", "maxTotalSupply", "fauxTotal0", "fauxTotal1", "customDepositDelta"];
  return Object.fromEntries(names.map((name, i) => [name, raw[i]])); }
function historySummary(events) { const counts = {}, first = {}, last = {}; for (const row of events) { counts[row.event] = (counts[row.event] || 0) + 1; if (!first[row.event]) first[row.event] = row; last[row.event] = row; }
  const trim = (rows) => Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, { blockNumber: v.blockNumber, transactionHash: v.transactionHash, logIndex: v.logIndex }])); return { counts, first: trim(first), last: trim(last) }; }
function listedAddresses(events) { const set = new Set(); for (const row of events) { if (row.event === "ListAppended") for (const x of row.args?.listed || []) { const a = addr(x); if (a) set.add(a); } if (row.event === "ListRemoved") { const a = addr(row.args?.listed); if (a) set.add(a); } } return [...set].sort(); }
function tickFromSqrt(sqrt) { return Math.floor(Math.log((Number(sqrt) / Number(Q96)) ** 2) / Math.log(1.0001)); }

async function optionalSourcifyRecovery() { const checksum = getAddress(CLEARANCE); return new Promise((resolve) => { const req = https.get(`https://sourcify.dev/server/v2/contract/1/${checksum}?fields=all`, { headers: { accept: "application/json", "accept-encoding": "identity" }, agent: false }, (res) => {
    const chunks = []; let size = 0; res.on("data", (c) => { size += c.length; if (size < LIMITS.responseBytes) chunks.push(Buffer.from(c)); }); res.on("end", () => { if (res.statusCode !== 200) return resolve({ attempted: true, available: false, status: res.statusCode });
      try { const data = JSON.parse(Buffer.concat(chunks).toString("utf8")); resolve({ attempted: true, available: true, match: data.match, creationMatch: data.creationMatch, runtimeMatch: data.runtimeMatch, compilerVersion: data.compilation?.compilerVersion,
        metadata: data.metadata, standardJsonInput: data.stdJsonInput, sources: data.sources, runtimeBytecode: data.runtimeBytecode }); } catch (_) { resolve({ attempted: true, available: false, status: "INVALID_JSON" }); } }); }); req.on("error", () => resolve({ attempted: true, available: false, status: "TRANSPORT" })); }); }

async function main() {
  const partial = compileArtifact(), clearIface = new Interface(partial.variants.ClearingV2.abi), eventNames = partial.variants.ClearingV2.abi.filter((x) => x.type === "event").map((x) => x.name), eventTopics = eventNames.map((name) => clearIface.getEvent(name).topicHash);
  const inventory = fs.readFileSync(INVENTORY, "utf8"), candidates = parseInventory(inventory), secrets = secretCorpus(candidates), budget = new Budget();
  let resumePin = null; try { const old = JSON.parse(fs.readFileSync(CHECKPOINT)); if (old.schema === "gamma-clearance-config-history/v1" && old.target === CLEARANCE) resumePin = old.pin; } catch (_) {}
  const qualified = await qualify(candidates, clearIface, eventTopics, budget, resumePin);
  if (!qualified.selected) throw new Error("no full-capability chain-1 family"); const { ep, pin } = qualified.selected, block = pinArg(pin), creation = await creationBlock(ep, pin, CLEARANCE, budget), cp = await scan(ep, pin, creation, clearIface, eventTopics, budget, secrets);
  const binding = await proxyBinding(ep, block, CLEARANCE, budget), comparison = runtimeCompare(binding.comparedRuntime, partial.variants), sourceMatched = comparison.matched !== null;
  let explorerRecovery = { attempted: false, reason: "CANONICAL_VARIANT_MATCH" }; if (!sourceMatched) explorerRecovery = await optionalSourcifyRecovery();
  const global = await callMap(ep, block, CLEARANCE, clearIface, [["owner", "owner"], ["paused", "paused"], ["twapCheck", "twapCheck"], ["twapInterval", "twapInterval"], ["depositDelta", "depositDelta"], ["deltaScale", "deltaScale"], ["priceThreshold", "priceThreshold"]], budget);
  const positionCall = await call(ep, block, CLEARANCE, clearIface, "getPositionInfo", [HYPE], budget), position = positionObject(value(positionCall));
  const hype = await callMap(ep, block, HYPE, hypeIface, [["currentTick", "currentTick"], ["baseLower", "baseLower"], ["baseUpper", "baseUpper"], ["limitLower", "limitLower"], ["limitUpper", "limitUpper"], ["totalSupply", "totalSupply"], ["totals", "getTotalAmounts"], ["deposit0Max", "deposit0Max"], ["deposit1Max", "deposit1Max"], ["token0", "token0"], ["token1", "token1"]], budget);
  const uni = await callMap(ep, block, UNIPROXY, uniIface, [["owner", "owner"], ["clearance", "clearance"]], budget);
  const intervals = position?.twapOverride ? BigInt(position.twapInterval) : BigInt(value(global.twapInterval)), threshold = position?.twapOverride ? BigInt(position.priceThreshold) : BigInt(value(global.priceThreshold));
  const pool = await callMap(ep, block, POOL, poolIface, [["slot0", "slot0"], ["liquidity", "liquidity"], ["fee", "fee"], ["tickSpacing", "tickSpacing"], ["observe", "observe", [[Number(intervals), 0]]]], budget);
  const slot0 = value(pool.slot0), observations = value(pool.observe), spotSqrt = BigInt(slot0[0]), spotTick = BigInt(slot0[1]), cumulatives = observations[0].map(BigInt), twapTick = intervals === 0n ? spotTick : (cumulatives[1] - cumulatives[0]) / intervals;
  const twapSqrtCall = await call(ep, block, CLEARANCE, clearIface, "getSqrtTwapX96", [HYPE, intervals], budget), twapSqrt = BigInt(value(twapSqrtCall));
  const spotPrice = spotSqrt * spotSqrt * PRECISION / Q192, twapPrice = twapSqrt * twapSqrt * PRECISION / Q192;
  const ratioScaled = spotPrice >= twapPrice ? spotPrice * 10000n / twapPrice : twapPrice * 10000n / spotPrice;
  const twapEnabled = value(global.twapCheck) === true || position?.twapOverride === true, twapPass = !twapEnabled || ratioScaled <= threshold;
  const currentTick = BigInt(value(hype.currentTick)), baseLower = BigInt(value(hype.baseLower)), baseUpper = BigInt(value(hype.baseUpper)), limitLower = BigInt(value(hype.limitLower)), limitUpper = BigInt(value(hype.limitUpper));
  const ranges = { currentTick: currentTick.toString(), base: { lower: baseLower.toString(), upper: baseUpper.toString(), width: (baseUpper - baseLower).toString(), inRange: currentTick >= baseLower && currentTick < baseUpper, requiredByClearDeposit: true },
    limit: { lower: limitLower.toString(), upper: limitUpper.toString(), width: (limitUpper - limitLower).toString(), inRange: currentTick >= limitLower && currentTick < limitUpper, requiredByClearDeposit: false }, sourceWidthCheck: false };
  const bounded = [{ label: "oneToken0", token: TOKEN0, amount: 10n ** 18n }, { label: "thousandToken0", token: TOKEN0, amount: 1000n * 10n ** 18n }, { label: "oneToken1", token: TOKEN1, amount: 10n ** 18n }], quotes = {};
  for (const row of bounded) { quotes[row.label] = { inputToken: row.token, inputAmount: row.amount.toString(), clearance: await call(ep, block, CLEARANCE, clearIface, "getDepositAmount", [HYPE, row.token, row.amount], budget),
    uniProxy: await call(ep, block, UNIPROXY, uniIface, "getDepositAmount", [HYPE, row.token, row.amount], budget) }; }
  const oneBounds = value(quotes.oneToken0.clearance), deposit0 = 10n ** 18n, deposit1 = oneBounds ? (BigInt(oneBounds[0]) + BigInt(oneBounds[1])) / 2n : 0n;
  const clearDepositProbe = await call(ep, block, CLEARANCE, clearIface, "clearDeposit", [deposit0, deposit1, ACTOR, ACTOR, HYPE, [0, 0, 0, 0]], budget);
  const ordinaryDepositProbe = await call(ep, block, CLEARANCE, clearIface, "clearDeposit", [deposit0, deposit1, ORDINARY_ACTOR, ORDINARY_ACTOR, HYPE, [0, 0, 0, 0]], budget);
  const clearSharesProbe = await call(ep, block, CLEARANCE, clearIface, "clearShares", [HYPE, BigInt(value(hype.totalSupply))], budget);
  const listed = [...new Set([...listedAddresses(cp.events), ACTOR, ORDINARY_ACTOR, UNIPROXY, addr(value(global.owner))].filter(Boolean))], freeDeposit = {};
  for (const account of listed) freeDeposit[account] = await call(ep, block, CLEARANCE, clearIface, "freeDepositList", [HYPE, account], budget);
  const liquidity = BigInt(value(pool.liquidity)), feePips = BigInt(value(pool.fee)), upperSqrt = isqrt(twapSqrt * twapSqrt * threshold / 10000n), lowerSqrt = isqrt(twapSqrt * twapSqrt * 10000n / threshold);
  const upNet = upperSqrt > spotSqrt ? liquidity * (upperSqrt - spotSqrt) / Q96 : 0n, downNet = lowerSqrt < spotSqrt ? liquidity * (spotSqrt - lowerSqrt) * Q96 / (spotSqrt * lowerSqrt) : 0n;
  const upGross = ceilDiv(upNet * 1000000n, 1000000n - feePips), downGross = ceilDiv(downNet * 1000000n, 1000000n - feePips);
  const totals = value(hype.totals).map(BigInt), supply = BigInt(value(hype.totalSupply));
  const sharesAt = (price) => (deposit1 + deposit0 * price / PRECISION) * supply / (totals[0] * price / PRECISION + totals[1]);
  const shareTwap = sharesAt(twapPrice), shareUpper = sharesAt(upperSqrt * upperSqrt * PRECISION / Q192), shareLower = sharesAt(lowerSqrt * lowerSqrt * PRECISION / Q192);
  const sharesFor = (amount0, amount1, price) => (amount1 + amount0 * price / PRECISION) * supply / (totals[0] * price / PRECISION + totals[1]);
  const upperPrice = upperSqrt * upperSqrt * PRECISION / Q192, lowerPrice = lowerSqrt * lowerSqrt * PRECISION / Q192;
  const oneSided = { token0: { atTwap: sharesFor(10n ** 18n, 0n, twapPrice), atUpper: sharesFor(10n ** 18n, 0n, upperPrice), atLower: sharesFor(10n ** 18n, 0n, lowerPrice) },
    token1: { atTwap: sharesFor(0n, 10n ** 18n, twapPrice), atUpper: sharesFor(0n, 10n ** 18n, upperPrice), atLower: sharesFor(0n, 10n ** 18n, lowerPrice) } };
  const oneSidedDeviationBps = Object.values(oneSided).reduce((max, row) => [row.atUpper, row.atLower].reduce((inner, quote) => {
    const diff = quote > row.atTwap ? quote - row.atTwap : row.atTwap - quote, bps = diff * 10000n / row.atTwap; return bps > inner ? bps : inner;
  }, max), 0n);
  const navUpperDelta = totals[0] * ((upperSqrt * upperSqrt * PRECISION / Q192) - twapPrice) / PRECISION;
  const navLowerDelta = totals[0] * (twapPrice - (lowerSqrt * lowerSqrt * PRECISION / Q192)) / PRECISION;
  const material = totals[0] > 0n || totals[1] > 0n; let corroboration = { triggered: material, available: false };
  if (material && qualified.capable.length > 1) { const second = qualified.capable.find((x) => x.ep.family !== ep.family && x.pin.hash === pin.hash); if (second) {
    const secondBinding = await proxyBinding(second.ep, pinArg(second.pin), CLEARANCE, budget), secondGlobal = await callMap(second.ep, pinArg(second.pin), CLEARANCE, clearIface, [["owner", "owner"], ["paused", "paused"], ["twapInterval", "twapInterval"], ["priceThreshold", "priceThreshold"], ["position", "getPositionInfo", [HYPE]]], budget);
    corroboration = { triggered: true, available: true, samePin: true, runtimeHashMatch: secondBinding.runtime.summary?.keccak256 === binding.runtime.summary?.keccak256,
      configMatch: JSON.stringify(secondGlobal) === JSON.stringify({ owner: global.owner, paused: global.paused, twapInterval: global.twapInterval, priceThreshold: global.priceThreshold, position: positionCall }) }; } }
  const terminal = await rpc(ep, "eth_getBlockByNumber", [qty(BigInt(pin.number)), false], budget), terminalMatch = terminal.ok && terminal.result?.hash?.toLowerCase() === pin.hash;
  const configGate = sourceMatched && position?.version !== "0" && value(global.paused) === false && addr(value(uni.clearance)) === CLEARANCE;
  const accessGate = configGate && ranges.base.inRange && twapPass && ordinaryDepositProbe.reason === null;
  const manipulationGate = ratioScaled > threshold ? true : (upGross > 0n || downGross > 0n ? null : false);
  const history = historySummary(cp.events);
  const capture = { schema: "gamma-hypervisor-clearance-binding-gate/v1", capturedAt: new Date().toISOString(), chainId: "1", pin,
    rpcPolicy: { inventory: "rpc_endpoints.txt", processOnly: true, candidateFamiliesTested: qualified.tested, capableFamilies: qualified.capable.length,
      selectedFamilies: corroboration.available ? 2 : 1, secondIndependentFamilyUsed: corroboration.available, permittedMethods: [...METHODS], terminalPinMatch: terminalMatch },
    addresses: { clearance: CLEARANCE, uniProxy: UNIPROXY, hypervisor: HYPE, pool: POOL, token0: TOKEN0, token1: TOKEN1 },
    source: { recoveredBundle: "targets/gamma-hypervisor-deployed-d5f487", partialArtifact: "partial-artifact.json", binding, comparison, sourceMatched,
      explorerRecovery: explorerRecovery.attempted ? { ...explorerRecovery, sources: explorerRecovery.sources ? Object.fromEntries(Object.entries(explorerRecovery.sources).map(([k, v]) => [k, { contentSha256: sha(v.content || "") }])) : undefined,
        standardJsonInput: explorerRecovery.standardJsonInput ? { sha256: sha(JSON.stringify(explorerRecovery.standardJsonInput)) } : undefined,
        metadata: explorerRecovery.metadata ? { sha256: sha(JSON.stringify(explorerRecovery.metadata)) } : undefined,
        runtimeBytecode: explorerRecovery.runtimeBytecode ? { onchain: codeSummary(explorerRecovery.runtimeBytecode.onchainBytecode), recompiled: codeSummary(explorerRecovery.runtimeBytecode.recompiledBytecode) } : undefined } : explorerRecovery },
    current: { global, position: { call: positionCall, decoded: position }, hypervisor: hype, uniProxy: uni, pool, ranges, freeDeposit },
    twap: { enabled: twapEnabled, intervalSeconds: intervals.toString(), thresholdRatioScaled: threshold.toString(), allowedDeviationBps: (threshold - 10000n).toString(), spotSqrtPriceX96: spotSqrt.toString(),
      twapSqrtPriceX96: twapSqrt.toString(), spotTick: spotTick.toString(), computedTwapTick: twapTick.toString(), twapTickFromSqrt: tickFromSqrt(twapSqrt).toString(), spotPriceX36: spotPrice.toString(), twapPriceX36: twapPrice.toString(),
      ratioScaled: ratioScaled.toString(), deviationBpsFloor: (ratioScaled - 10000n).toString(), passes: twapPass },
    depositClearance: { boundedQuotes: quotes,
      probes: { freeListed: { from: ACTOR, to: ACTOR, deposit0: deposit0.toString(), deposit1: deposit1.toString(), result: clearDepositProbe },
        ordinary: { from: ORDINARY_ACTOR, to: ORDINARY_ACTOR, deposit0: deposit0.toString(), deposit1: deposit1.toString(), result: ordinaryDepositProbe } },
      clearSharesCurrentSupply: clearSharesProbe, passes: ordinaryDepositProbe.reason === null && clearSharesProbe.reason === null,
      noStateChange: true },
    configHistory: { creationBlock: creation.toString(), completeEmittedEventScan: cp.complete, fromBlock: cp.fromBlock, toBlock: pin.number, summary: history, events: cp.events,
      eventlessLimits: ["pause(bool) emits no event", "transferOwnership(address) emits no event", "Current values are finalized calls; complete histories for eventless fields are unavailable from standard logs."] },
    manipulationEstimate: { thresholdAlreadyBreached: ratioScaled > threshold, constantLiquidityApproximation: true, feePips: feePips.toString(), currentLiquidity: liquidity.toString(),
      upward: { targetSqrtPriceX96: upperSqrt.toString(), targetTickApprox: tickFromSqrt(upperSqrt).toString(), token1InputRawGross: upGross.toString(), token1Input: decimal(upGross) },
      downward: { targetSqrtPriceX96: lowerSqrt.toString(), targetTickApprox: tickFromSqrt(lowerSqrt).toString(), token0InputRawGross: downGross.toString(), token0Input: decimal(downGross) },
      caveats: ["Single-current-liquidity-segment estimate; initialized tick crossings and liquidityNet changes can materially change required input.", "No swap quote, call, fork, transaction, or execution was performed."] },
    capacityUpperBound: { currentAssets: { token0: totals[0].toString(), token1: totals[1].toString(), totalSupply: supply.toString() }, testDeposit: { token0: deposit0.toString(), token1: deposit1.toString() },
      sharesAtTwap: shareTwap.toString(), sharesAtUpperThreshold: shareUpper.toString(), sharesAtLowerThreshold: shareLower.toString(),
      maxShareQuoteDeviationFromTwapBps: [shareUpper, shareLower].reduce((m, x) => { const d = x > shareTwap ? x - shareTwap : shareTwap - x; return d * 10000n / shareTwap > m ? d * 10000n / shareTwap : m; }, 0n).toString(),
      maxShareQuoteDeviationPartsPer1e12: [shareUpper, shareLower].reduce((m, x) => { const d = x > shareTwap ? x - shareTwap : shareTwap - x; return d * 1000000000000n / shareTwap > m ? d * 1000000000000n / shareTwap : m; }, 0n).toString(),
      freeListedOneSidedEnvelope: { configCapBypassed: value(freeDeposit[ACTOR]) === true,
        token0OneUnit: Object.fromEntries(Object.entries(oneSided.token0).map(([k, v]) => [k, v.toString()])),
        token1OneUnit: Object.fromEntries(Object.entries(oneSided.token1).map(([k, v]) => [k, v.toString()])),
        maxShareQuoteDeviationFromTwapBps: oneSidedDeviationBps.toString() },
      wholeVaultToken1EquivalentNavShiftUpper: navUpperDelta.toString(), wholeVaultToken1EquivalentNavShiftLower: navLowerDelta.toString(),
      limitation: "Conservative token1-equivalent accounting envelope at configured threshold; not executable profit or loss." },
    independentCorroboration: corroboration,
    gates: { source: sourceMatched, config: configGate, access: accessGate, manipulation: manipulationGate, materialCapacity: material,
      completeEmittedConfigHistory: cp.complete, completeAllConfigHistory: false, routePositive: null, executableNow: false, signedActionJustified: false },
    classification: "WATCH_CLEARANCE_BOUND_NO_EXECUTABLE_ROUTE_PROVEN", budget: budget.summary(),
    boundaries: ["Finalized read-only gate only.", "No state-changing call, endpoint disclosure, fork, signing, broadcast, swap, deposit, or exploit invocation."] };
  delete binding.rawRuntime; delete binding.comparedRuntime; guard(capture, secrets); guard(partial, secrets); fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(ARTIFACT, `${JSON.stringify(partial, null, 2)}\n`); fs.writeFileSync(CAPTURE, `${JSON.stringify(capture, null, 2)}\n`);
  const files = ["capture.json", "checkpoint.json", "partial-artifact.json"].map((name) => { const b = fs.readFileSync(path.join(OUT, name)); return { name, bytes: b.length, sha256: sha(b) }; });
  const manifest = { schema: "gamma-hypervisor-clearance-binding-gate-manifest/v1", pin, files, gates: capture.gates, classification: capture.classification, terminalPinMatch: terminalMatch, secretGuardPassed: true, jsonValidated: true };
  guard(manifest, secrets); fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`); for (const file of [CAPTURE, CHECKPOINT, ARTIFACT, MANIFEST]) JSON.parse(fs.readFileSync(file));
  process.stdout.write(`clearance gate complete: source=${sourceMatched} config=${configGate} access=${accessGate} twapPass=${twapPass} routePositive=unknown\n`);
}

main().catch((error) => { process.stderr.write(`clearance gate failed: ${String(error.message || error).replace(/https?:\/\/\S+/giu, "[redacted]")}\n`); process.exitCode = 1; });
