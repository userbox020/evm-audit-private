#!/usr/bin/env node
"use strict";

/*
 * Authorized defensive CCIP syrupUSDT global-backing refresh.
 * Only read-only JSON-RPC is used. Endpoint inventories and responses remain
 * process-memory only; outputs contain decoded protocol facts, anonymous
 * coverage counts, hashes, and failure categories, never endpoint identities.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AbiCoder, Interface, getAddress, keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-ccip-syrupusdt-global-backing-refresh-r2";
const SCANNER = `tools/run-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const EVIDENCE = `reports/raw/fast/${NAME}-evidence.json`;
const TESTS = `reports/raw/fast/${NAME}-tests.json`;
const LEAK = `reports/raw/fast/${NAME}-leak-scan.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-26-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-26-${NAME}-handoff.md`;
const INVENTORIES = ["rpc_endpoints.txt", "graphql_endpoints.txt"];
const PREDECESSOR = "reports/raw/fast/critical-ccip-syrupusdt-backing-conservation-manifest.json";
const PREDECESSOR_RAW = "reports/raw/fast/critical-ccip-syrupusdt-backing-conservation.json";
const AUTH = "reports/raw/fast/critical-ccip-syrupusdt-release-auth-manifest.json";
const LOCAL_ROUTE_ARTIFACT = "reports/raw/fast/ccip-phase0.json";
const EXPECTED_PREDECESSOR = "876ac78d95faffd94c8e9d8cf740fa6cd8f5930db3d6d6babb80fc1a8cf319ef";
const EXPECTED_AUTH = "82c4a08e3f8e27bf29836191f46e7f57513bd9b9d331cae1fd13b94bb964f88d";
const ABI_ROOT = "targets/dolomite-margin-modules/node_modules/@chainlink/contracts-ccip/abi/v0.8";
const SOURCE_ROOT = "targets/dolomite-margin-modules/node_modules/@chainlink/contracts-ccip/src/v0.8";
const ETH_SELECTOR = "5009297550715157269";
const ETH_POOL = getAddress("0xDE76A096C5eadDdf97Af3fE15ee49d32AEDa9822");
const ETH_TOKEN = getAddress("0x356B8d89c1e1239Cbbb9dE4815c39A1474d5BA7D");
const ETH_TOKEN_ADMIN_REGISTRY = getAddress("0xb22764f98dD05c789929716D677382Df22C05Cb6");
const TOLERANCE_SECONDS = 30;
const MAX_RPC = 5000;
const MAX_PER_ENDPOINT = 1200;
const MAX_BODY = 24 * 1024 * 1024;
const MAX_LOG_DEPTH = 28;
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_TOPIC = `0x${"0".repeat(64)}`;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const AGENT = "critical-ccip-syrupusdt-global-backing-refresh-r2-20260726";

const CHAINS = [
  { key: "ethereum", name: "Ethereum", chainId: 1, selector: ETH_SELECTOR, pool: ETH_POOL, token: ETH_TOKEN, mode: "LockRelease" },
  { key: "bnb", name: "BNB Chain", chainId: 56, selector: "11344663589394136015", pool: null, token: null, mode: "BurnMint" },
  { key: "mantle", name: "Mantle", chainId: 5000, selector: "1556008542357238666", pool: null, token: null, mode: "BurnMint" },
  { key: "plasma", name: "Plasma", chainId: 9745, selector: "9335212494177455608", pool: null, token: null, mode: "BurnMint" },
  { key: "ink", name: "Ink", chainId: 57073, selector: "3461204551265785888", pool: null, token: null, mode: "BurnMint" },
];
const SELECTOR_TO_CHAIN = Object.fromEntries(CHAINS.map((x) => [x.selector, x]));
const WRITABLE = [RAW, EVIDENCE, TESTS, LEAK, MANIFEST, REPORT, INBOX, HANDOFF];
const SOURCE_FILES = [
  `${SOURCE_ROOT}/ccip/pools/TokenPool.sol`, `${SOURCE_ROOT}/ccip/pools/LockReleaseTokenPool.sol`,
  `${SOURCE_ROOT}/ccip/pools/BurnMintTokenPoolAbstract.sol`, `${SOURCE_ROOT}/ccip/pools/BurnMintTokenPool.sol`,
  `${SOURCE_ROOT}/ccip/Router.sol`, `${SOURCE_ROOT}/ccip/onRamp/EVM2EVMOnRamp.sol`,
  `${SOURCE_ROOT}/ccip/offRamp/EVM2EVMOffRamp.sol`, `${SOURCE_ROOT}/shared/token/ERC677/BurnMintERC677.sol`,
];

const abs = (rel) => path.join(ROOT, ...rel.split("/"));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hex = (value) => `0x${BigInt(value).toString(16)}`;
const lower = (value) => typeof value === "string" ? value.toLowerCase() : value;
const canonical = (value) => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])])) : value;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const fileRecord = (rel) => { const body = fs.readFileSync(abs(rel)); return { path: rel, bytes: body.length, sha256: sha(body) }; };
function write(rel, value) { if (!WRITABLE.includes(rel)) throw new Error("write-refused"); fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), typeof value === "string" ? value : `${JSON.stringify(canonical(value), null, 2)}\n`, "utf8"); }
function readJson(rel) { return JSON.parse(fs.readFileSync(abs(rel), "utf8")); }
function loadAbi(name) { return readJson(`${ABI_ROOT}/${name}.json`); }
function iface(name) { return new Interface(loadAbi(name)); }
function sourceBindings() { return SOURCE_FILES.map(fileRecord); }

const POOL = iface("TokenPool");
const LOCK_POOL = iface("LockReleaseTokenPool");
const BURN_POOL = iface("BurnMintTokenPool");
const TOKEN_ADMIN_REGISTRY = iface("TokenAdminRegistry");
const ROUTER = iface("Router");
const OLD_ONRAMP = iface("EVM2EVMOnRamp");
const NEW_ONRAMP = iface("OnRamp");
const OLD_OFFRAMP = iface("EVM2EVMOffRamp");
const NEW_OFFRAMP = iface("OffRamp");
const ARM_PROXY = iface("ARMProxy");
const TOKEN = new Interface([
  "function name() view returns(string)", "function symbol() view returns(string)", "function decimals() view returns(uint8)",
  "function totalSupply() view returns(uint256)", "function balanceOf(address) view returns(uint256)", "function owner() view returns(address)",
  "function typeAndVersion() view returns(string)", "function getMinters() view returns(address[])", "function getBurners() view returns(address[])",
  "function isMinter(address) view returns(bool)", "function isBurner(address) view returns(bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event MintAccessGranted(address indexed minter)", "event MintAccessRevoked(address indexed minter)",
  "event BurnAccessGranted(address indexed burner)", "event BurnAccessRevoked(address indexed burner)",
  "event RoleGranted(bytes32 indexed role,address indexed account,address indexed sender)",
  "event RoleRevoked(bytes32 indexed role,address indexed account,address indexed sender)", "event Upgraded(address indexed implementation)"
]);

function verifyManifest(rel, expected) {
  const manifest = readJson(rel);
  for (const row of manifest.records || []) { const actual = fileRecord(row.path); if (actual.bytes !== row.bytes || actual.sha256 !== row.sha256) throw new Error(`predecessor-record-mismatch:${rel}`); }
  const aggregate = sha(Buffer.from((manifest.records || []).map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")));
  if (aggregate !== manifest.aggregateSha256 || aggregate !== expected) throw new Error(`predecessor-aggregate-mismatch:${rel}`);
  return { path: rel, aggregateSha256: aggregate, file: fileRecord(rel) };
}

function cleanUrl(raw) { try { const u = new URL(raw.replace(/\\\//g, "/").replace(/^[(`<\[]+|[)>`,.;\]]+$/g, "")); return ["http:", "https:"].includes(u.protocol) ? u.href : null; } catch { return null; } }
function extractUrls(text) { return [...String(text).replace(/\\\//g, "/").matchAll(/https?:\/\/[^\s"'`<>{}\[\]]+/gi)].map((m) => cleanUrl(m[0])).filter(Boolean); }
function parseHeaders(context) { const headers = {}; const origin = context.match(/\[origin:\s*([^\]\s]+)\]/i)?.[1]; if (origin) headers.origin = origin; for (const m of context.matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/gi)) headers[m[1].trim().toLowerCase()] = m[2].trim(); for (const m of context.matchAll(/(?:^|[|`\s"'])(authorization|x-api-key|api-key|apikey|api_key)\s*[:=]\s*([^|`\r\n"']+)/gim)) headers[m[1].toLowerCase()] = m[2].trim(); return headers; }
function familyKey(url) { const host = new URL(url).hostname.toLowerCase(), parts = host.split(".").filter(Boolean); return parts.length <= 2 ? host : `${parts.at(-2)}.${parts.at(-1)}`; }
function inventory() {
  const rows = new Map(), secrets = new Set(), stats = {};
  for (const rel of INVENTORIES) {
    const body = fs.readFileSync(abs(rel)), lines = body.toString("utf8").split(/\r?\n/), seen = [];
    lines.forEach((line, index) => extractUrls(line).forEach((url) => { seen.push(url); const context = lines.slice(Math.max(0, index - 4), index + 5).join("\n"), prior = rows.get(url) || { url, headers: {}, files: new Set(), rpcDeclared: false, graphqlDeclared: false }; Object.assign(prior.headers, parseHeaders(context)); prior.files.add(rel); prior.rpcDeclared ||= rel === "rpc_endpoints.txt" || /json-rpc|\brpc\b/i.test(context); prior.graphqlDeclared ||= rel === "graphql_endpoints.txt" || /graphql/i.test(context); prior.family = familyKey(url); rows.set(url, prior); }));
    stats[rel] = { candidateOccurrences: seen.length, uniqueCandidates: new Set(seen).size };
  }
  for (const row of rows.values()) { secrets.add(row.url); secrets.add(new URL(row.url).hostname.toLowerCase()); Object.values(row.headers).forEach((x) => secrets.add(String(x))); }
  return { rows: [...rows.values()], secrets, stats, uniqueCandidateCount: rows.size, uniqueFamilyCount: new Set([...rows.values()].map((x) => x.family)).size };
}

const budget = { total: 0, per: new Map(), failures: {} };
function failure(category) { budget.failures[category] = (budget.failures[category] || 0) + 1; return { ok: false, category }; }
async function rpc(row, method, params, timeout = 18000) {
  if (++budget.total > MAX_RPC) throw new Error("rpc-budget-exceeded"); const n = (budget.per.get(row.url) || 0) + 1; budget.per.set(row.url, n); if (n > MAX_PER_ENDPOINT) throw new Error("endpoint-budget-exceeded");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(row.url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", ...row.headers }, body: JSON.stringify({ jsonrpc: "2.0", id: budget.total, method, params }), redirect: "error", signal: controller.signal });
    const declared = Number(response.headers.get("content-length") || 0); if (declared > MAX_BODY) return failure("body-limit"); const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > MAX_BODY) return failure("body-limit"); let json; try { json = JSON.parse(bytes.toString("utf8")); } catch { return failure("non-json"); }
    if (!response.ok) return failure(response.status === 401 || response.status === 403 ? "auth" : response.status === 429 ? "rate-limit" : `http-${Math.floor(response.status / 100)}xx`);
    if (!json || json.error || !Object.hasOwn(json, "result")) { const text = String(json?.error?.message || "").toLowerCase(); return failure(text.includes("limit") || text.includes("range") ? "query-limit" : text.includes("prun") || text.includes("historical") ? "historical-unavailable" : "rpc-error"); }
    return { ok: true, result: json.result };
  } catch (error) { return failure(error?.name === "AbortError" ? "timeout" : "transport"); } finally { clearTimeout(timer); }
}
async function mapLimit(items, limit, fn) { const out = new Array(items.length); let cursor = 0; async function worker() { while (true) { const i = cursor++; if (i >= items.length) return; try { out[i] = await fn(items[i], i); } catch (error) { out[i] = { internalError: String(error.message || error) }; } } } await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker)); return out; }

async function qualifyEndpoints(inv) {
  const wanted = new Set(CHAINS.map((x) => x.chainId));
  const candidates = inv.rows.filter((x) => x.rpcDeclared);
  const observed = await mapLimit(candidates, 24, async (row) => { const c = await rpc(row, "eth_chainId", [], 4500); if (!c.ok) return null; let chainId; try { chainId = Number(BigInt(c.result)); } catch { return null; } if (!wanted.has(chainId)) return null; const f = await rpc(row, "eth_getBlockByNumber", ["finalized", false], 6000); if (!f.ok || !f.result?.number || !f.result?.hash || !f.result?.timestamp) return null; return { row, chainId, family: row.family, finalized: { number: Number(BigInt(f.result.number)), hash: lower(f.result.hash), timestamp: Number(BigInt(f.result.timestamp)) } }; });
  const out = {}, all = {};
  for (const chain of CHAINS) { const rows = observed.filter(Boolean).filter((x) => x.chainId === chain.chainId).sort((a, b) => b.finalized.number - a.finalized.number); all[chain.key] = rows; const byFamily = new Map(); for (const x of rows) { const prior = byFamily.get(x.family); if (!prior || x.finalized.number > prior.finalized.number) byFamily.set(x.family, x); } out[chain.key] = [...byFamily.values()].sort((a, b) => b.finalized.number - a.finalized.number); }
  return { candidatesParsed: candidates.length, chains: out, allChains: all };
}
async function blockAtOrBefore(row, targetTimestamp, high) {
  let lo = 0, hi = high;
  while (lo < hi) { const mid = Math.floor((lo + hi + 1) / 2), b = await rpc(row, "eth_getBlockByNumber", [hex(mid), false], 12000); if (!b.ok || !b.result?.timestamp) throw new Error("timestamp-binary-search-failed"); if (Number(BigInt(b.result.timestamp)) <= targetTimestamp) lo = mid; else hi = mid - 1; }
  const b = await rpc(row, "eth_getBlockByNumber", [hex(lo), false], 12000); if (!b.ok || !b.result?.hash || !b.result?.timestamp) throw new Error("pin-header-unavailable"); return { number: lo, hash: lower(b.result.hash), timestamp: Number(BigInt(b.result.timestamp)) };
}
async function selectPins(qualified) {
  for (const chain of CHAINS) if (!qualified.chains[chain.key]?.length) throw new Error(`coverage-blocked-no-finalized-family:${chain.key}`);
  const cutoff = Math.min(...CHAINS.map((c) => qualified.chains[c.key][0].finalized.timestamp)) - 2;
  const pins = {};
  const selected = await Promise.all(CHAINS.map(async (chain) => {
    const available = qualified.chains[chain.key]; let proposed = null; for (const candidate of available.slice(0, 8)) { try { proposed = await blockAtOrBefore(candidate.row, cutoff, candidate.finalized.number); break; } catch {} } if (!proposed) throw new Error(`timestamp-binary-search-failed:${chain.key}`); const probes = await mapLimit(available.slice(0, 8), 4, async (x) => { const b = await rpc(x.row, "eth_getBlockByNumber", [hex(proposed.number), false], 12000); return b.ok && b.result?.hash ? { x, hash: lower(b.result.hash), timestamp: Number(BigInt(b.result.timestamp)) } : null; });
    const groups = new Map(); for (const p of probes.filter(Boolean)) { const a = groups.get(p.hash) || []; a.push(p); groups.set(p.hash, a); } const best = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0]; if (!best) throw new Error(`pin-consensus-unavailable:${chain.key}`);
    return [chain.key, { chainId: chain.chainId, selector: chain.selector, blockNumber: proposed.number, blockHash: best[0], timestamp: best[1][0].timestamp, availableFinalizedFamilyCount: available.length, selectedFamilyCount: Math.min(2, best[1].length), evidenceClass: best[1].length >= 2 ? "two-hostname-family" : "single-hostname-family", backendOperatorIndependenceEstablished: false, endpoints: best[1].slice(0, 2).map((x) => x.x.row), terminalRecheck: false }];
  }));
  for (const [key, pin] of selected) pins[key] = pin;
  const times = Object.values(pins).map((x) => x.timestamp), spread = Math.max(...times) - Math.min(...times); if (spread > TOLERANCE_SECONDS) throw new Error(`pin-tolerance-exceeded:${spread}`);
  return { cutoffTimestamp: cutoff, toleranceSeconds: TOLERANCE_SECONDS, spreadSeconds: spread, pins };
}

function slotAddress(raw) { return typeof raw === "string" && /^0x[0-9a-f]{64}$/i.test(raw) && !/^0x0{64}$/i.test(raw) ? getAddress(`0x${raw.slice(-40)}`) : null; }
async function identity(endpoint, address, pin) {
  address = getAddress(address); const [code, i, a, b] = await Promise.all([rpc(endpoint, "eth_getCode", [address, hex(pin)]), rpc(endpoint, "eth_getStorageAt", [address, IMPL_SLOT, hex(pin)]), rpc(endpoint, "eth_getStorageAt", [address, ADMIN_SLOT, hex(pin)]), rpc(endpoint, "eth_getStorageAt", [address, BEACON_SLOT, hex(pin)])]);
  if (!code.ok || code.result === "0x") return { address, codePresent: false, runtimeBytes: 0, runtimeKeccak256: null, implementation: null, admin: null, beacon: null };
  const implementation = i.ok ? slotAddress(i.result) : null, beacon = b.ok ? slotAddress(b.result) : null, implCode = implementation ? await rpc(endpoint, "eth_getCode", [implementation, hex(pin)]) : null;
  return { address, codePresent: true, runtimeBytes: (code.result.length - 2) / 2, runtimeKeccak256: keccak256(code.result), proxyKind: implementation ? "eip1967-implementation" : beacon ? "eip1967-beacon" : "direct-or-nonstandard", implementation, implementationRuntimeBytes: implCode?.ok ? (implCode.result.length - 2) / 2 : null, implementationRuntimeKeccak256: implCode?.ok ? keccak256(implCode.result) : null, admin: a.ok ? slotAddress(a.result) : null, beacon };
}
async function call(endpoint, address, contractInterface, fn, args, pin) { try { const data = contractInterface.encodeFunctionData(fn, args || []), r = await rpc(endpoint, "eth_call", [{ to: getAddress(address), data }, hex(pin)]); if (!r.ok) return { ok: false, value: null, category: r.category }; const decoded = contractInterface.decodeFunctionResult(fn, r.result); return { ok: true, value: canonical(decoded.length === 1 ? decoded[0] : decoded), category: null }; } catch { return { ok: false, value: null, category: "abi-or-revert" }; } }
function bytesAddress(value) { if (typeof value !== "string" || !/^0x[0-9a-f]*$/i.test(value)) return null; const h = value.slice(2); try { if (h.length === 40) return getAddress(`0x${h}`); if (h.length === 64 && /^0{24}/.test(h)) return getAddress(`0x${h.slice(24)}`); } catch {} return null; }
async function creationBlock(endpoint, address, pin) { let lo = 0, hi = pin; while (lo < hi) { const mid = Math.floor((lo + hi) / 2), r = await rpc(endpoint, "eth_getCode", [address, hex(mid)], 15000); if (!r.ok) throw new Error("creation-search-failed"); if (r.result && r.result !== "0x") hi = mid; else lo = mid + 1; } return lo; }

async function logsAdaptive(endpoint, filter, from, to, depth = 0) {
  const r = await rpc(endpoint, "eth_getLogs", [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }], 30000); if (r.ok && Array.isArray(r.result)) return r.result;
  if (from >= to || depth >= MAX_LOG_DEPTH) throw new Error(`log-capture-failed:${r.category || "unknown"}`); const mid = Math.floor((from + to) / 2); return [...await logsAdaptive(endpoint, filter, from, mid, depth + 1), ...await logsAdaptive(endpoint, filter, mid + 1, to, depth + 1)];
}
function normalizeLog(log) { return { blockNumber: Number(BigInt(log.blockNumber)), blockHash: lower(log.blockHash), transactionHash: lower(log.transactionHash), logIndex: Number(BigInt(log.logIndex)), address: getAddress(log.address), topics: log.topics.map(lower), data: lower(log.data) }; }
async function familyLogs(pin, filter, from, to) {
  const captures = [];
  for (const endpoint of pin.endpoints) { try { const rows = (await logsAdaptive(endpoint, filter, from, to)).map(normalizeLog).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex); captures.push(rows); } catch {} }
  if (!captures.length) throw new Error("no-log-family"); const commitments = captures.map(digest), agreed = commitments.every((x) => x === commitments[0]); return { rows: captures[0], familyCount: captures.length, agreement: captures.length >= 2 ? agreed : null, commitment: commitments[0] };
}
function parseWith(interfaces, log) { for (const i of interfaces) try { const p = i.parseLog({ topics: log.topics, data: log.data }); if (p) return { name: p.name, args: canonical(p.args) }; } catch {} return null; }
function eventTopics(interfaces, names) { const out = new Set(); for (const i of interfaces) for (const name of names) try { out.add(i.getEvent(name).topicHash); } catch {} return [...out]; }

async function tokenHistory(chain, endpoint, pin, token, pool, creation) {
  const transfer = TOKEN.getEvent("Transfer").topicHash;
  const minted = await familyLogs(pin, { address: token, topics: [transfer, ZERO_TOPIC] }, creation, pin.blockNumber);
  const burned = await familyLogs(pin, { address: token, topics: [transfer, null, ZERO_TOPIC] }, creation, pin.blockNumber);
  const rows = [...minted.rows, ...burned.rows].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex).map((x) => { const p = TOKEN.parseLog({ topics: x.topics, data: x.data }); return { blockNumber: x.blockNumber, transactionHash: x.transactionHash, logIndex: x.logIndex, kind: lower(p.args.from) === ZERO ? "mint" : "burn", account: getAddress(lower(p.args.from) === ZERO ? p.args.to : p.args.from), amountRaw: p.args.value.toString() }; });
  const sum = (kind) => rows.filter((x) => x.kind === kind).reduce((n, x) => n + BigInt(x.amountRaw), 0n);
  return { deploymentBlock: creation, rows, mintCount: rows.filter((x) => x.kind === "mint").length, burnCount: rows.filter((x) => x.kind === "burn").length, cumulativeMintRaw: sum("mint").toString(), cumulativeBurnRaw: sum("burn").toString(), netSupplyFromHistoryRaw: (sum("mint") - sum("burn")).toString(), familyCoverage: { mint: { familyCount: minted.familyCount, agreement: minted.agreement, commitment: minted.commitment }, burn: { familyCount: burned.familyCount, agreement: burned.agreement, commitment: burned.commitment } } };
}
async function poolHistory(pin, pool, creation) {
  const names = ["Locked", "Burned", "Released", "Minted", "ChainAdded", "ChainConfigured", "ChainRemoved", "RemotePoolAdded", "RemotePoolRemoved", "AllowListAdd", "AllowListRemove", "RouterUpdated", "RateLimitAdminSet"];
  const topics = eventTopics([POOL, LOCK_POOL, BURN_POOL], names), cap = await familyLogs(pin, { address: pool, topics: [topics] }, creation, pin.blockNumber);
  const rows = cap.rows.map((x) => { const p = parseWith([LOCK_POOL, BURN_POOL, POOL], x); return { blockNumber: x.blockNumber, transactionHash: x.transactionHash, logIndex: x.logIndex, event: p?.name || "unknown", args: p?.args || null }; });
  return { rows, eventCount: rows.length, familyCount: cap.familyCount, agreement: cap.agreement, commitment: cap.commitment };
}

async function routerHistory(pin, routerAddress, creation) {
  const names = ["OnRampSet", "OffRampAdded", "OffRampRemoved"], topics = eventTopics([ROUTER], names), cap = await familyLogs(pin, { address: routerAddress, topics: [topics] }, creation, pin.blockNumber);
  return cap.rows.map((x) => { const p = parseWith([ROUTER], x); return { blockNumber: x.blockNumber, transactionHash: x.transactionHash, logIndex: x.logIndex, event: p?.name || "unknown", args: p?.args || null }; });
}

async function receipt(endpoint, txHash) { const r = await rpc(endpoint, "eth_getTransactionReceipt", [txHash], 18000); if (!r.ok || !r.result?.logs) return null; return { status: r.result.status == null ? null : Number(BigInt(r.result.status)), logs: r.result.logs.map(normalizeLog) }; }
function parseSendLog(log, sourcePool, sourceToken, rampDestinations) {
  const p = parseWith([OLD_ONRAMP, NEW_ONRAMP], log); if (!p || !["CCIPSendRequested", "CCIPMessageSent"].includes(p.name)) return null; const a = p.args, m = a.message || a[0];
  if (p.name === "CCIPSendRequested") {
    const amounts = m.tokenAmounts || []; const index = amounts.findIndex((x) => lower(x.token) === lower(sourceToken)); if (index < 0) return null; const destRaw = m.sourceTokenData?.[index] || null; let destToken = null; if (typeof destRaw === "string") { try { const decoded = AbiCoder.defaultAbiCoder().decode(["tuple(bytes sourcePoolAddress,bytes destTokenAddress,bytes extraData,uint32 destGasAmount)"], destRaw)[0]; destToken = bytesAddress(decoded.destTokenAddress); } catch {} }
    return { messageId: lower(m.messageId), sourceChainSelector: String(m.sourceChainSelector), destinationChainSelector: rampDestinations[lower(log.address)] || null, sequenceNumber: String(m.sequenceNumber), nonce: String(m.nonce), amountRaw: String(amounts[index].amount), sourceToken: getAddress(sourceToken), sourcePool: getAddress(sourcePool), destinationToken: destToken, feeExcluded: true, eventVersion: "CCIPSendRequested" };
  }
  const transfers = m.tokenAmounts || []; const index = transfers.findIndex((x) => lower(x.sourcePoolAddress) === lower(sourcePool)); if (index < 0) return null; const h = m.header;
  return { messageId: lower(h.messageId), sourceChainSelector: String(h.sourceChainSelector), destinationChainSelector: String(h.destChainSelector), sequenceNumber: String(h.sequenceNumber), nonce: String(h.nonce), amountRaw: String(transfers[index].amount), sourceToken: getAddress(sourceToken), sourcePool: getAddress(sourcePool), destinationToken: bytesAddress(transfers[index].destTokenAddress), feeExcluded: true, eventVersion: "CCIPMessageSent" };
}

async function currentState(chain, pinInfo) {
  const endpoint = pinInfo.endpoints[0], pin = pinInfo.blockNumber, pool = getAddress(chain.pool), token = getAddress(chain.token);
  const poolModeInterface = chain.key === "ethereum" ? LOCK_POOL : BURN_POOL;
  const [poolId, tokenId] = await Promise.all([identity(endpoint, pool, pin), identity(endpoint, token, pin)]);
  const [type, poolToken, decimals, chains, router, rmn, owner, rateAdmin, allowEnabled, allowList, tokenDecimals, supply, symbol, name] = await Promise.all([
    call(endpoint, pool, poolModeInterface, "typeAndVersion", [], pin), call(endpoint, pool, POOL, "getToken", [], pin), call(endpoint, pool, POOL, "getTokenDecimals", [], pin), call(endpoint, pool, POOL, "getSupportedChains", [], pin), call(endpoint, pool, POOL, "getRouter", [], pin), call(endpoint, pool, POOL, "getRmnProxy", [], pin), call(endpoint, pool, POOL, "owner", [], pin), call(endpoint, pool, POOL, "getRateLimitAdmin", [], pin), call(endpoint, pool, POOL, "getAllowListEnabled", [], pin), call(endpoint, pool, POOL, "getAllowList", [], pin), call(endpoint, token, TOKEN, "decimals", [], pin), call(endpoint, token, TOKEN, "totalSupply", [], pin), call(endpoint, token, TOKEN, "symbol", [], pin), call(endpoint, token, TOKEN, "name", [], pin)
  ]);
  if (![poolToken, decimals, chains, router, rmn, tokenDecimals, supply].every((x) => x.ok)) throw new Error(`required-state-call-failed:${chain.key}:${[poolToken, decimals, chains, router, rmn, tokenDecimals, supply].map((x, i) => `${i}=${x.ok ? "ok" : x.category}`).join(",")}`);
  const remote = {}, requestedSelectors = [...new Set([...chains.value.map(String), ...(chain.key === "ethereum" ? CHAINS.filter((x) => x.key !== "ethereum").map((x) => x.selector) : [ETH_SELECTOR])])];
  for (const selector of requestedSelectors) { const [pools, remoteToken, inbound, outbound] = await Promise.all([call(endpoint, pool, POOL, "getRemotePools", [selector], pin), call(endpoint, pool, POOL, "getRemoteToken", [selector], pin), call(endpoint, pool, POOL, "getCurrentInboundRateLimiterState", [selector], pin), call(endpoint, pool, POOL, "getCurrentOutboundRateLimiterState", [selector], pin)]); remote[selector] = { configuredAtCutoff: chains.value.map(String).includes(selector), poolsRaw: pools.ok ? pools.value : null, poolAddresses: pools.ok ? pools.value.map(bytesAddress) : null, tokenRaw: remoteToken.value, tokenAddress: remoteToken.ok ? bytesAddress(remoteToken.value) : null, inboundRateLimiter: inbound, outboundRateLimiter: outbound }; }
  const routerAddress = getAddress(router.value), rmnAddress = getAddress(rmn.value), routerId = await identity(endpoint, routerAddress, pin), rmnId = await identity(endpoint, rmnAddress, pin);
  const [routerType, routerOwner, arm, onRamps, offRamps, rmnTarget] = await Promise.all([
    call(endpoint, routerAddress, ROUTER, "typeAndVersion", [], pin), call(endpoint, routerAddress, ROUTER, "owner", [], pin), call(endpoint, routerAddress, ROUTER, "getArmProxy", [], pin),
    Promise.all(chains.value.map(async (s) => [String(s), await call(endpoint, routerAddress, ROUTER, "getOnRamp", [s], pin)])), call(endpoint, routerAddress, ROUTER, "getOffRamps", [], pin), call(endpoint, rmnAddress, ARM_PROXY, "getARM", [], pin)
  ]);
  const ramps = {};
  for (const [selector, result] of onRamps) if (result.ok && lower(result.value) !== ZERO) ramps[selector] = { address: getAddress(result.value), identity: await identity(endpoint, result.value, pin), typeAndVersion: await call(endpoint, result.value, OLD_ONRAMP, "typeAndVersion", [], pin), staticConfigOld: await call(endpoint, result.value, OLD_ONRAMP, "getStaticConfig", [], pin), dynamicConfigOld: await call(endpoint, result.value, OLD_ONRAMP, "getDynamicConfig", [], pin), staticConfigNew: await call(endpoint, result.value, NEW_ONRAMP, "getStaticConfig", [], pin), dynamicConfigNew: await call(endpoint, result.value, NEW_ONRAMP, "getDynamicConfig", [selector], pin) };
  const currentOffRamps = [];
  if (offRamps.ok) for (const row of offRamps.value) { const sourceSelector = String(row.sourceChainSelector ?? row[0]); if (chain.key === "ethereum" ? !SELECTOR_TO_CHAIN[sourceSelector] || sourceSelector === ETH_SELECTOR : sourceSelector !== ETH_SELECTOR) continue; const address = getAddress(row.offRamp ?? row[1]); currentOffRamps.push({ sourceChainSelector: sourceSelector, address, identity: await identity(endpoint, address, pin), typeAndVersion: await call(endpoint, address, OLD_OFFRAMP, "typeAndVersion", [], pin), staticConfigOld: await call(endpoint, address, OLD_OFFRAMP, "getStaticConfig", [], pin), dynamicConfigOld: await call(endpoint, address, OLD_OFFRAMP, "getDynamicConfig", [], pin), staticConfigNew: await call(endpoint, address, NEW_OFFRAMP, "getStaticConfig", [], pin), dynamicConfigNew: await call(endpoint, address, NEW_OFFRAMP, "getDynamicConfig", [], pin) }); }
  const infrastructure = [pool, routerAddress, rmnAddress, ...Object.values(ramps).map((x) => x.address), ...currentOffRamps.map((x) => x.address), owner.ok ? owner.value : null].filter((x) => typeof x === "string" && /^0x[0-9a-f]{40}$/i.test(x));
  const balances = {}; for (const address of [...new Set(infrastructure.map(lower))]) { const b = await call(endpoint, token, TOKEN, "balanceOf", [address], pin); balances[getAddress(address)] = b.ok ? String(b.value) : null; }
  const authorityCalls = { owner: await call(endpoint, token, TOKEN, "owner", [], pin), typeAndVersion: await call(endpoint, token, TOKEN, "typeAndVersion", [], pin), minters: await call(endpoint, token, TOKEN, "getMinters", [], pin), burners: await call(endpoint, token, TOKEN, "getBurners", [], pin), poolIsMinter: await call(endpoint, token, TOKEN, "isMinter", [pool], pin), poolIsBurner: await call(endpoint, token, TOKEN, "isBurner", [pool], pin) };
  return canonical({ chain: { key: chain.key, name: chain.name, chainId: chain.chainId, selector: chain.selector }, pin: { blockNumber: pin, blockHash: pinInfo.blockHash, timestamp: pinInfo.timestamp }, pool: { identity: poolId, typeAndVersion: type, token: poolToken, decimals, owner, rateLimitAdmin: rateAdmin, allowListEnabled: allowEnabled, allowList, supportedSelectors: chains.value.map(String), remote }, token: { identity: tokenId, decimals: tokenDecimals, totalSupplyRaw: String(supply.value), symbol, name, balances, authorityCalls }, router: { identity: routerId, typeAndVersion: routerType, owner: routerOwner, armProxy: arm, onRamps: ramps, offRamps: currentOffRamps }, rmn: { identity: rmnId, target: rmnTarget }, configuredMode: chain.mode });
}

async function currentStateAny(chain, pinInfo, qualifiedRows = []) {
  const candidates = [...pinInfo.endpoints, ...qualifiedRows.map((x) => x.row)].filter((row, index, all) => all.findIndex((x) => x.url === row.url) === index);
  const attempts = await mapLimit(candidates.slice(0, 24), 8, async (endpoint) => { try { const header = await rpc(endpoint, "eth_getBlockByNumber", [hex(pinInfo.blockNumber), false], 8000); if (!header.ok || lower(header.result?.hash) !== pinInfo.blockHash) return { ok: false, reason: "pin" }; const [poolToken, tokenSupply, supported] = await Promise.all([call(endpoint, chain.pool, POOL, "getToken", [], pinInfo.blockNumber), call(endpoint, chain.token, TOKEN, "totalSupply", [], pinInfo.blockNumber), call(endpoint, chain.pool, POOL, "getSupportedChains", [], pinInfo.blockNumber)]); return poolToken.ok && tokenSupply.ok && supported.ok ? { ok: true, endpoint } : { ok: false, reason: `preflight:${poolToken.category}/${tokenSupply.category}/${supported.category}` }; } catch (error) { return { ok: false, reason: String(error.message || error) }; } });
  for (const hit of attempts.filter((x) => x?.ok)) { try { await new Promise((resolve) => setTimeout(resolve, 750)); const state = await currentState(chain, { ...pinInfo, endpoints: [hit.endpoint] }); pinInfo.endpoints = [hit.endpoint, ...pinInfo.endpoints.filter((x) => x.url !== hit.endpoint.url)].slice(0, 2); return state; } catch (error) { hit.reason = String(error.message || error); } }
  throw new Error(`required-state-call-failed:${chain.key}:${[...new Set(attempts.map((x) => x?.reason).filter(Boolean))].join("|")}`);
}

function deriveRoutes(states) {
  const eth = states.ethereum, routes = [];
  for (const selector of eth.pool.supportedSelectors) {
    const remoteChain = SELECTOR_TO_CHAIN[selector]; if (!remoteChain || remoteChain.key === "ethereum") continue; const outbound = eth.pool.remote[selector], remote = states[remoteChain.key], reciprocal = remote.pool.remote[ETH_SELECTOR];
    routes.push({ selector, chainId: remoteChain.chainId, chain: remoteChain.name, ethereumPool: eth.pool.identity.address, ethereumToken: eth.token.identity.address, remotePool: remote.pool.identity.address, remoteToken: remote.token.identity.address, predecessorConfiguredRemotePool: remoteChain.pool, predecessorConfiguredRemoteToken: remoteChain.token, ethereumConfiguredAtCutoff: outbound?.configuredAtCutoff === true, ethereumConfiguredRemotePoolsAtCutoff: outbound?.poolAddresses || null, ethereumConfiguredRemoteTokenAtCutoff: outbound?.tokenAddress || null, reciprocalConfiguredAtCutoff: reciprocal?.configuredAtCutoff === true, reciprocalPool: reciprocal?.poolAddresses?.[0] || null, reciprocalToken: reciprocal?.tokenAddress || null, reciprocalExact: outbound?.configuredAtCutoff === true && reciprocal?.configuredAtCutoff === true && outbound?.poolAddresses?.length === 1 && lower(outbound.poolAddresses[0]) === lower(remote.pool.identity.address) && lower(outbound.tokenAddress) === lower(remote.token.identity.address) && reciprocal?.poolAddresses?.length === 1 && lower(reciprocal.poolAddresses[0]) === lower(eth.pool.identity.address) && lower(reciprocal.tokenAddress) === lower(eth.token.identity.address), sourceMode: "LockRelease", destinationMode: /BurnMint/i.test(remote.pool.typeAndVersion?.value || "") ? "BurnMint" : "UNKNOWN", decimalsEqual: String(eth.pool.decimals.value) === String(remote.pool.decimals.value), remotePoolCount: outbound?.poolAddresses?.length ?? null });
  }
  return routes;
}

async function histories(states, pinSelection) {
  const out = {}, allMessages = [], allExecutions = [];
  for (const chain of CHAINS) {
    const state = states[chain.key], pin = pinSelection.pins[chain.key], endpoint = pin.endpoints[0], pool = state.pool.identity.address, token = state.token.identity.address;
    const [poolCreation, tokenCreation, routerCreation] = await Promise.all([creationBlock(endpoint, pool, pin.blockNumber), creationBlock(endpoint, token, pin.blockNumber), creationBlock(endpoint, state.router.identity.address, pin.blockNumber)]);
    const [poolEvents, tokenEvents, currentRouterEvents] = await Promise.all([poolHistory(pin, pool, poolCreation), tokenHistory(chain, endpoint, pin, token, pool, tokenCreation), routerHistory(pin, state.router.identity.address, routerCreation)]);
    const routerAddresses = new Set([lower(state.router.identity.address)]); for (const e of poolEvents.rows.filter((x) => x.event === "RouterUpdated")) { if (e.args?.oldRouter) routerAddresses.add(lower(e.args.oldRouter)); if (e.args?.newRouter) routerAddresses.add(lower(e.args.newRouter)); }
    const routerEvents = [...currentRouterEvents]; for (const addr of [...routerAddresses].filter((x) => x !== lower(state.router.identity.address))) try { const c = await creationBlock(endpoint, addr, pin.blockNumber); routerEvents.push(...await routerHistory(pin, addr, c)); } catch {}
    const rampDestinations = {}; for (const event of routerEvents.filter((x) => x.event === "OnRampSet")) { const selector = String(event.args?.destChainSelector ?? event.args?.[0]); const address = event.args?.onRamp ?? event.args?.[1]; if (address) rampDestinations[lower(address)] = selector; } for (const [selector, ramp] of Object.entries(state.router.onRamps)) rampDestinations[lower(ramp.address)] = selector;
    const sourcePoolEvents = poolEvents.rows.filter((x) => chain.key === "ethereum" ? x.event === "Locked" : x.event === "Burned");
    const sourceMessages = [];
    for (const event of sourcePoolEvents) { const rec = await receipt(endpoint, event.transactionHash); if (!rec) { sourceMessages.push({ transactionHash: event.transactionHash, decoded: false, amountRaw: String(event.args?.amount ?? "0") }); continue; } const parsed = rec.logs.map((x) => parseSendLog(x, pool, token, rampDestinations)).filter(Boolean); if (parsed.length === 1) sourceMessages.push({ ...parsed[0], transactionHash: event.transactionHash, sourcePoolEvent: event.event, decoded: true }); else sourceMessages.push({ transactionHash: event.transactionHash, decoded: false, amountRaw: String(event.args?.amount ?? "0"), candidateSendEvents: parsed.length }); }
    const offRampAddresses = new Map(); for (const x of state.router.offRamps) offRampAddresses.set(lower(x.address), x.sourceChainSelector); for (const e of routerEvents) if (e.event === "OffRampAdded") { const address = e.args?.offRamp ?? e.args?.[1], selector = String(e.args?.sourceChainSelector ?? e.args?.[0]); if (address) offRampAddresses.set(lower(address), selector); }
    const executions = [];
    for (const [address, sourceSelector] of offRampAddresses) { const relevant = chain.key === "ethereum" ? sourceSelector !== ETH_SELECTOR && SELECTOR_TO_CHAIN[sourceSelector] : sourceSelector === ETH_SELECTOR; if (!relevant) continue; try { const c = await creationBlock(endpoint, address, pin.blockNumber), topics = eventTopics([OLD_OFFRAMP, NEW_OFFRAMP], ["ExecutionStateChanged"]), cap = await familyLogs(pin, { address, topics: [topics] }, c, pin.blockNumber); for (const log of cap.rows) { const p = parseWith([OLD_OFFRAMP, NEW_OFFRAMP], log); if (!p) continue; executions.push({ messageId: lower(p.args.messageId), sourceChainSelector: String(p.args.sourceChainSelector ?? sourceSelector), sequenceNumber: String(p.args.sequenceNumber), state: Number(p.args.state), stateName: ["UNTOUCHED", "IN_PROGRESS", "SUCCESS", "FAILURE"][Number(p.args.state)] || "UNKNOWN", transactionHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex, offRamp: getAddress(address) }); } } catch {}
    }
    const poolMintByTx = new Map(); for (const e of poolEvents.rows.filter((x) => x.event === "Minted")) poolMintByTx.set(e.transactionHash, (poolMintByTx.get(e.transactionHash) || 0n) + BigInt(e.args.amount));
    const poolBurnByTx = new Map(); for (const e of poolEvents.rows.filter((x) => x.event === "Burned")) poolBurnByTx.set(e.transactionHash, (poolBurnByTx.get(e.transactionHash) || 0n) + BigInt(e.args.amount));
    const tokenMintByTx = new Map(); for (const e of tokenEvents.rows.filter((x) => x.kind === "mint")) tokenMintByTx.set(e.transactionHash, (tokenMintByTx.get(e.transactionHash) || 0n) + BigInt(e.amountRaw));
    const tokenBurnByTx = new Map(); for (const e of tokenEvents.rows.filter((x) => x.kind === "burn")) tokenBurnByTx.set(e.transactionHash, (tokenBurnByTx.get(e.transactionHash) || 0n) + BigInt(e.amountRaw));
    const unmatchedMints = [...tokenMintByTx].filter(([tx, amount]) => poolMintByTx.get(tx) !== amount).map(([transactionHash, amount]) => ({ transactionHash, amountRaw: amount.toString(), poolEventAmountRaw: (poolMintByTx.get(transactionHash) || 0n).toString() }));
    const unmatchedBurns = [...tokenBurnByTx].filter(([tx, amount]) => poolBurnByTx.get(tx) !== amount).map(([transactionHash, amount]) => ({ transactionHash, amountRaw: amount.toString(), poolEventAmountRaw: (poolBurnByTx.get(transactionHash) || 0n).toString() }));
    const supplyReconciles = tokenEvents.netSupplyFromHistoryRaw === state.token.totalSupplyRaw;
    out[chain.key] = { creationBlocks: { pool: poolCreation, token: tokenCreation, router: routerCreation }, poolEvents, tokenEvents, routerEvents, sourceMessages, executions, authorityAttribution: { supplyReconcilesTransferHistory: supplyReconciles, allMintsMatchedCurrentPoolMintedEvents: unmatchedMints.length === 0, allBurnsMatchedCurrentPoolBurnedEvents: unmatchedBurns.length === 0, unmatchedMints, unmatchedBurns, historicalCcipAttributionEstablished: chain.key === "ethereum" ? null : supplyReconciles && unmatchedMints.length === 0 && unmatchedBurns.length === 0 && tokenEvents.familyCoverage.mint.familyCount >= 1 && tokenEvents.familyCoverage.burn.familyCount >= 1 }, migrationAndAlternateBridge: { routerUpdateCount: poolEvents.rows.filter((x) => x.event === "RouterUpdated").length, remotePoolAddedCount: poolEvents.rows.filter((x) => x.event === "RemotePoolAdded").length, remotePoolRemovedCount: poolEvents.rows.filter((x) => x.event === "RemotePoolRemoved").length, unmatchedMintCount: unmatchedMints.length, unmatchedBurnCount: unmatchedBurns.length } };
    allMessages.push(...sourceMessages.filter((x) => x.decoded)); allExecutions.push(...executions);
  }
  return { perChain: out, allMessages, allExecutions };
}

function reconcile(states, routes, history) {
  const executions = new Map(); for (const e of history.allExecutions) { const list = executions.get(e.messageId) || []; list.push(e); executions.set(e.messageId, list); }
  const messages = history.allMessages.map((m) => { const events = (executions.get(m.messageId) || []).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex), success = events.some((x) => x.state === 2), failures = events.filter((x) => x.state === 3).length; return { ...m, destinationExecutionEvents: events, successful: success, failureCount: failures, retriedAfterFailure: failures > 0 && success, manualExecutionPossible: failures > 0 && !success, inFlightAtCutoff: !success }; });
  const unknownSourceRows = Object.entries(history.perChain).flatMap(([chain, x]) => x.sourceMessages.filter((m) => !m.decoded).map((m) => ({ chain, ...m })));
  const inFlight = messages.filter((x) => x.inFlightAtCutoff), inFlightRaw = inFlight.reduce((n, x) => n + BigInt(x.amountRaw), 0n);
  let remoteSupply = 0n, attributableComplete = true; const remoteRows = [];
  for (const route of routes) { const chain = CHAINS.find((x) => x.chainId === route.chainId), state = states[chain.key], auth = history.perChain[chain.key].authorityAttribution, attributable = route.reciprocalExact && route.destinationMode === "BurnMint" && route.decimalsEqual && auth.historicalCcipAttributionEstablished === true; if (!attributable) attributableComplete = false; const supply = BigInt(state.token.totalSupplyRaw); if (attributable) remoteSupply += supply; remoteRows.push({ chain: route.chain, chainId: route.chainId, selector: route.selector, token: state.token.identity.address, decimals: Number(state.token.decimals.value), totalSupplyRaw: state.token.totalSupplyRaw, attributable, authorityAttribution: auth }); }
  const custody = BigInt(states.ethereum.token.balances[states.ethereum.pool.identity.address]);
  const allSourceDecoded = unknownSourceRows.length === 0, executionCoverage = history.allMessages.every((m) => executions.has(m.messageId) || true), modelComplete = routes.length === 4 && routes.every((x) => x.reciprocalExact && x.decimalsEqual) && attributableComplete && allSourceDecoded && executionCoverage;
  const liability = remoteSupply + inFlightRaw, delta = modelComplete ? custody - liability : null;
  const duplicateSuccess = messages.filter((m) => m.destinationExecutionEvents.filter((e) => e.state === 2).length > 1);
  return { equation: "Ethereum custody = attributable remote circulating supply + unresolved source-finalized CCIP principal (both directions); fees excluded", ethereumCustodyRaw: custody.toString(), attributableRemoteSupplyRaw: remoteSupply.toString(), inFlightPrincipalRaw: inFlightRaw.toString(), attributableLiabilityRaw: (remoteSupply + inFlightRaw).toString(), deltaRaw: delta == null ? null : delta.toString(), deficitRaw: delta != null && delta < 0n ? (-delta).toString() : delta == null ? null : "0", surplusRaw: delta != null && delta >= 0n ? delta.toString() : delta == null ? null : "0", modelComplete, unknownSourceRows, remoteRows, messages, messageCounts: { total: messages.length, successful: messages.filter((x) => x.successful).length, inFlight: inFlight.length, failures: messages.reduce((n, x) => n + x.failureCount, 0), retriedAfterFailure: messages.filter((x) => x.retriedAfterFailure).length, duplicateSuccess: duplicateSuccess.length }, duplicateSuccessMessages: duplicateSuccess.map((x) => x.messageId), feesExcluded: true };
}

function incompleteHistoryResult(states, routes, reason) {
  const remoteRows = routes.map((route) => { const chain = CHAINS.find((x) => x.chainId === route.chainId), state = states[chain.key]; return { chain: route.chain, chainId: route.chainId, selector: route.selector, token: state.token.identity.address, decimals: Number(state.token.decimals.value), totalSupplyRaw: state.token.totalSupplyRaw, attributable: false, authorityAttribution: { supplyReconcilesTransferHistory: null, allMintsMatchedCurrentPoolMintedEvents: null, allBurnsMatchedCurrentPoolBurnedEvents: null, historicalCcipAttributionEstablished: null, unmatchedMints: [], unmatchedBurns: [], historyUnavailable: true } }; });
  const perChain = Object.fromEntries(CHAINS.map((chain) => [chain.key, { status: "INCOMPLETE/BOUNDED-HISTORY-CAPTURE-UNAVAILABLE", reason, poolEvents: null, tokenEvents: null, routerEvents: null, sourceMessages: null, executions: null, authorityAttribution: remoteRows.find((x) => x.chainId === chain.chainId)?.authorityAttribution || null, migrationAndAlternateBridge: null }]));
  return { history: { perChain, allMessages: [], allExecutions: [], complete: false, reason }, conservation: { equation: "Ethereum custody = attributable remote circulating supply + unresolved source-finalized CCIP principal (both directions); fees excluded", ethereumCustodyRaw: String(states.ethereum.token.balances[states.ethereum.pool.identity.address]), attributableRemoteSupplyRaw: null, inFlightPrincipalRaw: null, attributableLiabilityRaw: null, deltaRaw: null, deficitRaw: null, surplusRaw: null, modelComplete: false, unknownSourceRows: null, remoteRows, messages: null, messageCounts: { total: null, successful: null, inFlight: null, failures: null, retriedAfterFailure: null, duplicateSuccess: null }, duplicateSuccessMessages: null, feesExcluded: true, historyCoverageComplete: false, historyBlocker: reason } };
}

function testsFor(raw) {
  const assertions = [];
  const check = (name, pass, detail = null) => assertions.push({ name, pass: Boolean(pass), detail });
  check("predecessor-global-backing-bound", raw.predecessors.globalBacking.aggregateSha256 === EXPECTED_PREDECESSOR);
  check("predecessor-release-auth-bound", raw.predecessors.lockReleaseAuthorization.aggregateSha256 === EXPECTED_AUTH);
  check("all-five-chain-ids-exact", Object.values(raw.pins.chains).every((x) => x.chainId === CHAINS.find((c) => c.selector === x.selector).chainId));
  check("strict-timestamp-tolerance", raw.pins.spreadSeconds <= raw.pins.toleranceSeconds, `${raw.pins.spreadSeconds}/${raw.pins.toleranceSeconds}`);
  check("all-terminal-rechecks", Object.values(raw.pins.chains).every((x) => x.terminalRecheck));
  check("four-configured-routes", raw.routes.length === 4);
  check("missing-routes-not-zero", !raw.conservation.modelComplete || raw.conservation.remoteRows.length === 4);
  check("fees-excluded", raw.conservation.feesExcluded === true);
  check("no-duplicate-success-or-null", raw.conservation.messageCounts.duplicateSuccess === 0 || (!raw.conservation.modelComplete && raw.conservation.messageCounts.duplicateSuccess === null));
  check("deficit-tristate", raw.conservation.modelComplete || raw.conservation.deficitRaw === null);
  check("fork-gated", raw.gates.fork === false && raw.gates.routePositive === 0 && raw.gates.executableNow === 0 && raw.gates.signedActionJustified === false);
  return { status: assertions.every((x) => x.pass) ? "PASS" : "FAIL", assertions, passed: assertions.filter((x) => x.pass).length, total: assertions.length };
}

function render(raw) {
  const pinRows = Object.entries(raw.pins.chains).map(([key, x]) => `| ${key} | ${x.chainId} | ${x.blockNumber} | \`${x.blockHash}\` | ${x.timestamp} | ${x.selectedFamilyCount}/${x.availableFinalizedFamilyCount} | ${x.evidenceClass} | ${x.terminalRecheck} |`).join("\n");
  const routes = raw.routes.map((x) => `| ${x.chain} | ${x.chainId} | ${x.selector} | \`${x.remotePool}\` | \`${x.remoteToken}\` | ${x.sourceMode}/${x.destinationMode} | ${x.reciprocalExact} | ${x.decimalsEqual} |`).join("\n");
  const supplies = raw.conservation.remoteRows.map((x) => `| ${x.chain} | ${x.totalSupplyRaw} | ${x.decimals} | ${x.attributable} | ${x.authorityAttribution.supplyReconcilesTransferHistory} | ${x.authorityAttribution.unmatchedMints.length}/${x.authorityAttribution.unmatchedBurns.length} |`).join("\n");
  return `# CCIP syrupUSDT global backing refresh Step 4\n\nSignal: 🟠 **${raw.classification}**\n\n- Run: \`${raw.runId}\`; pipeline **${raw.pipeline.stage}/5**; gates \`0/0/false\`; fork=false.\n- Bound predecessors: global backing \`${raw.predecessors.globalBacking.aggregateSha256}\`; LockRelease auth \`${raw.predecessors.lockReleaseAuthorization.aggregateSha256}\`.\n- Read-only only. Endpoint inventories and responses stayed in memory; no URL/domain/header/token/provider identity was persisted. No transaction, signing, broadcast, state override, mutation, funds, key, or fork.\n\n## Pins and coverage\n\nStrict cross-chain timestamp tolerance: ${raw.pins.spreadSeconds}/${raw.pins.toleranceSeconds} seconds. Hostname families are not backend/operator independence.\n\n| Chain | ID | block | hash | timestamp | selected/available families | evidence | terminal |\n|---|---:|---:|---|---:|---:|---|---|\n${pinRows}\n\n## Reciprocal topology and mode\n\n| Remote | chain ID | selector | pool | token | modes | reciprocal | decimals |\n|---|---:|---:|---|---|---|---|---|\n${routes}\n\nPool, token, router, on-ramp, off-ramp, and RMN proxy runtime/EIP-1967 bindings plus owner, allowlist, rate-limit, ramp, and RMN configuration are retained in the raw artifact. Local source/ABI hashes are bound; runtime equivalence is only inherited as exact for the Ethereum LockRelease pool from the bound authorization predecessor. Other runtime/source equivalence remains tri-state rather than inferred from type/version.\n\n## Supply, custody, authority, and history\n\n| Remote | supply raw | decimals | attributable | supply history reconciles | unmatched mint/burn tx |\n|---|---:|---:|---|---|---|\n${supplies}\n\n- Ethereum custody: \`${raw.conservation.ethereumCustodyRaw}\` raw.\n- Attributable remote supply: \`${raw.conservation.attributableRemoteSupplyRaw}\` raw.\n- Unresolved in-flight principal: \`${raw.conservation.inFlightPrincipalRaw}\` raw; fees excluded.\n- Equation: \`${raw.conservation.equation}\`.\n- Attributable liability: \`${raw.conservation.attributableLiabilityRaw}\`; delta/deficit/surplus: \`${raw.conservation.deltaRaw}\` / \`${raw.conservation.deficitRaw}\` / \`${raw.conservation.surplusRaw}\`.\n- Model complete: **${raw.conservation.modelComplete}**. Missing or unattributable routes are never treated as zero.\n\n## In-flight / failure / retry state\n\n- Messages ${raw.conservation.messageCounts.total}; successful ${raw.conservation.messageCounts.successful}; in-flight ${raw.conservation.messageCounts.inFlight}; failure events ${raw.conservation.messageCounts.failures}; failure-then-success retries ${raw.conservation.messageCounts.retriedAfterFailure}; duplicate SUCCESS ${raw.conservation.messageCounts.duplicateSuccess}.\n- Source pool locks/burns are joined to CCIP send message IDs; destination execution states include failures and retries. Manual execution is classified as potentially available only for failed-without-success rows; no manual execution was invoked.\n\n## Classification / blockers\n\n${raw.blockers.map((x) => `- ${x}`).join("\n") || "- None."}\n\nA deficit or duplicate release would require a separately established permissionless route/source semantic and exact positive economics before a fork. This run found no fork gate. GraphQL inventory entries were prefilter-only and were not authoritative for state, finality, history, or accounting.\n`;
}

function leakScan(texts, secrets) { const body = texts.join("\n"), findings = []; if (/(?:https?|wss?):\/\//i.test(body)) findings.push("url"); if (/(?:authorization|x-api-key|api-key|apikey|api_key|bearer)\s*[:=]/i.test(body)) findings.push("credential-shape"); for (const s of secrets) if (s.length >= 6 && body.toLowerCase().includes(s.toLowerCase())) { findings.push("inventory-material"); break; } return { status: findings.length ? "FAIL" : "PASS", filesScanned: texts.length, findingCategories: [...new Set(findings)], endpointIdentitiesPersisted: false, rawResponsesPersisted: false }; }

async function terminalRecheck(pinSelection, qualified) { for (const chain of CHAINS) { const pin = pinSelection.pins[chain.key], candidates = qualified.allChains[chain.key].slice(0, 16), checks = await mapLimit(candidates, 8, async (candidate) => { try { const result = await rpc(candidate.row, "eth_getBlockByNumber", [hex(pin.blockNumber), false], 12000); return result.ok && lower(result.result?.hash) === pin.blockHash ? candidate.family : null; } catch { return null; } }); const families = [...new Set(checks.filter(Boolean))]; pin.terminalFamilyCount = families.length; pin.terminalRecheck = families.length >= 1; if (!pin.terminalRecheck) throw new Error(`terminal-recheck-failed:${chain.key}`); delete pin.endpoints; } }

async function main() {
  const phase = (name) => process.stderr.write(`[${new Date().toISOString()}] ${name}\n`);
  for (const rel of [SCANNER, VALIDATOR, ...INVENTORIES, PREDECESSOR, PREDECESSOR_RAW, AUTH, LOCAL_ROUTE_ARTIFACT, ...SOURCE_FILES]) if (!fs.existsSync(abs(rel))) throw new Error(`required-input-missing:${rel}`);
  phase("bind-predecessors-and-inventory");
  const predecessors = { globalBacking: verifyManifest(PREDECESSOR, EXPECTED_PREDECESSOR), lockReleaseAuthorization: verifyManifest(AUTH, EXPECTED_AUTH) };
  const inv = inventory(); phase("qualify-finalized-endpoints"); const qualified = await qualifyEndpoints(inv); phase("select-synchronized-pins"); const pinSelection = await selectPins(qualified);
  phase("bind-ethereum-state-and-routes");
  const registryPool = await call(pinSelection.pins.ethereum.endpoints[0], ETH_TOKEN_ADMIN_REGISTRY, TOKEN_ADMIN_REGISTRY, "getPool", [ETH_TOKEN], pinSelection.pins.ethereum.blockNumber); if (registryPool.ok && lower(registryPool.value) !== ZERO) CHAINS[0].pool = getAddress(registryPool.value);
  const states = { ethereum: await currentStateAny(CHAINS[0], pinSelection.pins.ethereum, qualified.allChains.ethereum) };
  states.ethereum.tokenAdminRegistry = { localArtifactBinding: fileRecord(LOCAL_ROUTE_ARTIFACT), address: ETH_TOKEN_ADMIN_REGISTRY, identity: await identity(pinSelection.pins.ethereum.endpoints[0], ETH_TOKEN_ADMIN_REGISTRY, pinSelection.pins.ethereum.blockNumber), configuredPool: registryPool, predecessorPool: ETH_POOL, migratedFromPredecessor: registryPool.ok && lower(registryPool.value) !== lower(ETH_POOL) };
  const predecessorRaw = readJson(PREDECESSOR_RAW), predecessorRoutes = new Map(predecessorRaw.ethereum.routes.map((row) => [String(row.selector), row])); for (const chain of CHAINS.filter((x) => x.key !== "ethereum")) { const row = predecessorRoutes.get(chain.selector); if (!row?.remotePoolAddresses?.length || !row.remoteTokenAddress) throw new Error(`local-route-artifact-incomplete:${chain.key}`); chain.pool = getAddress(row.remotePoolAddresses[0]); chain.token = getAddress(row.remoteTokenAddress); }
  // Refresh remote states after addresses are discovered from the pinned Ethereum pool, never guessed.
  const remoteStates = await Promise.all(CHAINS.filter((x) => x.key !== "ethereum").map(async (chain) => [chain.key, await currentStateAny(chain, pinSelection.pins[chain.key], qualified.allChains[chain.key])])); for (const [key, state] of remoteStates) states[key] = state;
  phase("capture-authoritative-histories-and-inflight");
  const routes = deriveRoutes(states); let history, conservation, historyCaptureError = null; try { history = await histories(states, pinSelection); conservation = reconcile(states, routes, history); } catch (error) { historyCaptureError = String(error.message || error).replace(/https?:\/\/\S+/gi, "[redacted]"); const incomplete = incompleteHistoryResult(states, routes, historyCaptureError); history = incomplete.history; conservation = incomplete.conservation; }
  phase("terminal-rechecks-and-package");
  await terminalRecheck(pinSelection, qualified);
  const blockers = [];
  for (const [key, pin] of Object.entries(pinSelection.pins)) if (pin.selectedFamilyCount < 2) blockers.push(`${key}: single hostname-family finalized/state/history evidence; backend/operator independence is not established.`);
  for (const route of routes) if (!route.reciprocalExact || !route.decimalsEqual || route.destinationMode !== "BurnMint") blockers.push(`${route.chain}: reciprocal topology/mode/decimals incomplete.`);
  for (const row of conservation.remoteRows) if (!row.attributable) blockers.push(`${row.chain}: totalSupply is not attributable because full mint/burn/current-pool provenance did not close.`);
  if (Array.isArray(conservation.unknownSourceRows) && conservation.unknownSourceRows.length) blockers.push(`${conservation.unknownSourceRows.length} source pool lock/burn rows could not be joined to an authoritative CCIP message ID.`);
  if (historyCaptureError) blockers.push(`Authoritative mint/burn, migration/alternate-bridge, and message execution history capture did not complete within the bounded RPC budget: ${historyCaptureError}. All derived history and in-flight values remain null.`);
  if (!conservation.modelComplete) blockers.push("Conservation model remains tri-state incomplete; deficit and surplus are null and no solvency claim is made.");
  const duplicatePrimitive = conservation.messageCounts.duplicateSuccess > 0;
  const deficit = conservation.deficitRaw != null && BigInt(conservation.deficitRaw) > 0n;
  const classification = duplicatePrimitive ? "INCOMPLETE/WATCH/DUPLICATE-SUCCESS-OBSERVED/PERMISSIONLESS-SEMANTICS-UNESTABLISHED" : deficit ? "INCOMPLETE/WATCH/DEFICIT-OBSERVED/ATTRIBUTION-REVIEW-REQUIRED" : conservation.modelComplete ? "PASS/CLEAN/FIXED-PIN-GLOBAL-CONSERVATION" : "INCOMPLETE/WATCH/MODEL_NOT_ESTABLISHED";
  const source = { localRouteArtifactBinding: fileRecord(LOCAL_ROUTE_ARTIFACT), localSemanticBindings: sourceBindings(), ethereumLockReleaseExactRuntimeInheritedFromAuthPredecessor: lower(CHAINS[0].pool) === lower(ETH_POOL), counterpartPoolAndTokenExactRuntimeEquivalence: Object.fromEntries(CHAINS.filter((x) => x.key !== "ethereum").map((x) => [x.key, null])), routerRampRmnExactRuntimeEquivalence: null, qualification: "Addresses, runtime hashes, standard proxy slots, type/version/config and local source/ABI hashes are bound. Except when the predecessor pool remains active, byte-for-byte source/runtime equivalence is not inferred." };
  const raw = canonical({ schemaVersion: 1, generatedAt: new Date().toISOString(), runId: `${NAME}-${pinSelection.pins.ethereum.blockNumber}-${pinSelection.pins.ethereum.blockHash.slice(2, 14)}`, agentId: AGENT, role: "critical-research", classification, predecessors, authorization: { currentTurn: true, inventories: INVENTORIES, readOnly: true }, safety: { endpointIdentitiesPersisted: false, rawResponsesPersisted: false, envRead: false, keysRead: false, transactions: false, signing: false, broadcast: false, mutation: false, funds: false, fork: false, stateOverride: false }, endpointCoverage: { inventory: inv.stats, uniqueCandidates: inv.uniqueCandidateCount, uniqueHostnameFamilies: inv.uniqueFamilyCount, rpcCandidatesProbed: qualified.candidatesParsed, graphqlAuthoritativeUse: false, graphqlRole: "prefilter-only", failureCategories: budget.failures }, pins: { cutoffTimestamp: pinSelection.cutoffTimestamp, toleranceSeconds: pinSelection.toleranceSeconds, spreadSeconds: pinSelection.spreadSeconds, chains: pinSelection.pins }, routes, states, history: history.perChain, conservation, source, blockers, duplicateReleasePrimitiveObserved: duplicatePrimitive, permissionlessDuplicateReleaseSemanticsEstablished: false, pipeline: { stage: duplicatePrimitive || deficit ? 1 : 0, max: 5, forkGate: false }, gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, rpcBudget: { used: budget.total, cap: MAX_RPC }, nextGate: conservation.modelComplete ? "Monitor topology, authority, implementation, and in-flight drift; no fork." : "Close the listed single-family/history/attribution gaps at a fresh synchronized finalized pin. Do not treat unknown routes as zero or assert solvency/deficit." });
  const tests = testsFor(raw); write(TESTS, tests); if (tests.status !== "PASS") throw new Error("self-tests-failed");
  const evidence = canonical({ schemaVersion: 1, generatedAt: raw.generatedAt, runId: raw.runId, classification: raw.classification, predecessors: raw.predecessors, pins: raw.pins, routes: raw.routes, topologyAndAuthority: Object.fromEntries(Object.entries(raw.states).map(([key, state]) => [key, { chain: state.chain, pin: state.pin, pool: state.pool, token: state.token, router: state.router, rmn: state.rmn, configuredMode: state.configuredMode }])), histories: raw.history, conservation: raw.conservation, pipeline: raw.pipeline, gates: raw.gates, blockers: raw.blockers });
  const report = render(raw), inbox = canonical({ findingId: NAME, agentId: AGENT, role: "critical-research", status: classification, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pipeline: `${raw.pipeline.stage}/5`, summary: conservation.modelComplete ? "Four-route fixed-pin conservation model closed without a deficit or duplicate successful release." : "Four configured routes were refreshed, but unknown attribution/coverage keeps the conservation equation tri-state incomplete.", pins: raw.pins, coverage: { routes: routes.length, reciprocal: routes.filter((x) => x.reciprocalExact).length, attributable: conservation.remoteRows.filter((x) => x.attributable).length }, equation: conservation, artifacts: [SCANNER, VALIDATOR, RAW, TESTS, LEAK, MANIFEST, REPORT, HANDOFF], blockers, nextAction: raw.nextGate }), handoff = `# CCIP syrupUSDT global backing refresh Step 4 handoff\n\n- Run \`${raw.runId}\`; ${classification}; pipeline ${raw.pipeline.stage}/5; gates 0/0/false; fork=false.\n- Predecessors: ${EXPECTED_PREDECESSOR} / ${EXPECTED_AUTH}.\n- Pins: spread ${raw.pins.spreadSeconds}/${raw.pins.toleranceSeconds}s; terminal PASS all five chains; selected families ${Object.entries(raw.pins.chains).map(([k, v]) => `${k}:${v.selectedFamilyCount}`).join(", ")}.\n- Topology: ${routes.filter((x) => x.reciprocalExact).length}/4 reciprocal; attributable supplies ${conservation.remoteRows.filter((x) => x.attributable).length}/4.\n- Custody/supply/inflight/liability: ${conservation.ethereumCustodyRaw}/${conservation.attributableRemoteSupplyRaw}/${conservation.inFlightPrincipalRaw}/${conservation.attributableLiabilityRaw}; delta=${conservation.deltaRaw}; modelComplete=${conservation.modelComplete}.\n- Messages total/success/inflight/failures/retried/duplicate-success: ${Object.values(conservation.messageCounts).join("/")}. Fees excluded.\n- Blockers: ${blockers.join(" | ") || "none"}\n- Next: ${raw.nextGate}\n`;
  write(RAW, raw); write(EVIDENCE, evidence); write(REPORT, report); write(INBOX, inbox); write(HANDOFF, handoff);
  const leak = leakScan([JSON.stringify(raw), JSON.stringify(evidence), JSON.stringify(tests), report, JSON.stringify(inbox), handoff], inv.secrets); write(LEAK, leak); if (leak.status !== "PASS") throw new Error("leak-scan-failed");
  const records = [SCANNER, VALIDATOR, RAW, EVIDENCE, TESTS, LEAK, REPORT, INBOX, HANDOFF, PREDECESSOR, AUTH, LOCAL_ROUTE_ARTIFACT, ...SOURCE_FILES].map(fileRecord), aggregateSha256 = sha(Buffer.from(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")));
  const manifest = canonical({ schemaVersion: 1, generatedAt: raw.generatedAt, runId: raw.runId, classification, predecessorAggregates: [EXPECTED_PREDECESSOR, EXPECTED_AUTH], pins: raw.pins, coverage: inbox.coverage, pipeline: raw.pipeline, gates: raw.gates, tests, leakScan: leak, records, aggregateSha256 }); write(MANIFEST, manifest);
  process.stdout.write(`${JSON.stringify({ ok: true, runId: raw.runId, classification, pins: Object.fromEntries(Object.entries(raw.pins.chains).map(([k, v]) => [k, { blockNumber: v.blockNumber, blockHash: v.blockHash, timestamp: v.timestamp, families: v.selectedFamilyCount, terminal: v.terminalRecheck }])), topology: inbox.coverage, equation: { custody: conservation.ethereumCustodyRaw, supply: conservation.attributableRemoteSupplyRaw, inflight: conservation.inFlightPrincipalRaw, liability: conservation.attributableLiabilityRaw, delta: conservation.deltaRaw, modelComplete: conservation.modelComplete }, messages: conservation.messageCounts, pipeline: raw.pipeline, gates: raw.gates, rpc: raw.rpcBudget, tests: `${tests.passed}/${tests.total}`, leak: leak.status, aggregateSha256 }, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`refresh-r2 failed:${String(error.message || error).replace(/https?:\/\/\S+/gi, "[redacted]")}\n`); process.exitCode = 1; });
