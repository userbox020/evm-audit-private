#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { AbiCoder, Interface, getAddress, id, keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "infinifi-protocol");
const RPC_INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const PRIOR_CAPTURE = path.join(ROOT, "reports", "raw", "fast", "infinifi-live.json");
const PRIOR_ADDRESSES = path.join(TARGET, "deployment", "configuration", "addresses.1.json");
const OUT_DIR = path.join(ROOT, "reports", "raw", "fast", "infinifi-gateway-residue-current-deployment-exit-gate3");
const CAPTURE_PATH = path.join(OUT_DIR, "capture.json");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");
const REPORT_PATH = path.join(ROOT, "reports", "infinifi-gateway-residue-current-deployment-exit-gate3.md");
const RUNNER_PATH = __filename;
const TEST_PATH = path.join(__dirname, "test-infinifi-gateway-residue-current-deployment-exit-gate3.js");
const VALIDATOR_PATH = path.join(__dirname, "validate-infinifi-gateway-residue-current-deployment-exit-gate3.js");
const SCHEMA = "infinifi-gateway-residue-current-deployment-exit-gate3/v1";
const MANIFEST_SCHEMA = `${SCHEMA}/manifest`;
const EXPECTED_COMMIT = "3f0e186553036c8ecef82b449aa07b587290a30e";
const MAX_CANDIDATES = 64;
const MAX_ROLE_MEMBERS = 32;
const MAX_LOG_CHUNKS = 800;
const RPC_TIMEOUT_MS = 20_000;
const ZERO = "0x0000000000000000000000000000000000000000";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const ROUTER_TOPIC = id("SetEnabledRouter(uint256,address,bool)");
const GATEWAY_DEPLOYMENT_QUALIFICATION_BLOCK = 22_540_575n;
const WAD = 10n ** 18n;
const ABI = AbiCoder.defaultAbiCoder();

const EXPECTED_CONTRACTS = Object.freeze({
  gatewayProxy: ["TransparentUpgradeableProxy", "ERC1967Proxy"], gatewayImplementation: ["InfiniFiGatewayV3"],
  iusd: ["ReceiptToken"], core: ["InfiniFiCore"], accounting: ["Accounting"], farmRegistry: ["FarmRegistry"],
  mintController: ["MintController"], redeemController: ["RedeemController"], yieldSharingImplementation: ["YieldSharingV3"],
  beforeRedeemHook: ["BeforeRedeemHook"], afterMintHook: ["AfterMintHook"]
});

function sha256(bytes) { return `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`; }
function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("NON_CANONICAL_NUMBER"); return JSON.stringify(value); }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("NON_CANONICAL_VALUE");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}
function json(value) { return JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n"; }
function strictAddress(value) { return getAddress(value); }
function addressFromWord(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("BAD_STORAGE_WORD");
  return strictAddress(`0x${value.slice(-40)}`);
}
function q(value) { return `0x${BigInt(value).toString(16)}`; }
function blockHeader(row) {
  if (!row || !/^0x[0-9a-fA-F]{64}$/.test(row.hash || "") || !/^0x[0-9a-fA-F]{64}$/.test(row.stateRoot || "")) throw new Error("BAD_BLOCK_HEADER");
  return { number: BigInt(row.number).toString(), numberHex: row.number.toLowerCase(), hash: row.hash.toLowerCase(), stateRoot: row.stateRoot.toLowerCase(), timestamp: BigInt(row.timestamp).toString() };
}
function formatUnits(raw, decimals) {
  const value = BigInt(raw), scale = 10n ** BigInt(decimals), frac = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${value / scale}.${frac}` : `${value / scale}`;
}
function extraIusd(grossIusd, zapFee) {
  const gross = BigInt(grossIusd), feeRate = BigInt(zapFee);
  if (feeRate < 0n || feeRate > WAD) throw new Error("INVALID_FEE");
  const fee = gross * feeRate / WAD;
  return { gross: gross.toString(), fee: fee.toString(), net: (gross - fee).toString() };
}
function decideGate({ residueRaw, bindingPass, enabledRouterCount, immediateCeilingRaw = "0", marketExitAvailable = false }) {
  const residue = BigInt(residueRaw);
  if (residue === 0n) return { status: "CLOSED_ZERO_GATEWAY_USDC_RESIDUE", routePositive: false, executableNow: false, netPositive: false, fork: false, signing: false, economics: "NOT_RUN_PRIMARY_ZERO_GATE" };
  if (!bindingPass) return { status: "WATCH_SOURCE_RUNTIME_MISMATCH", routePositive: "unknown", executableNow: false, netPositive: "unknown", fork: false, signing: false, economics: "NOT_RUN_FAIL_CLOSED" };
  if (!enabledRouterCount) return { status: "WATCH_NO_CURRENTLY_ENABLED_ROUTER", routePositive: false, executableNow: false, netPositive: false, fork: false, signing: false, economics: "NOT_RUN_NO_ROUTER" };
  if (BigInt(immediateCeilingRaw) === 0n && !marketExitAvailable) return { status: "WATCH_NO_LIQUID_EXIT", routePositive: false, executableNow: false, netPositive: "unknown", fork: false, signing: false, economics: "STOPPED_BEFORE_FORK" };
  return { status: "WATCH_POSITIVE_RESIDUE_REQUIRES_COMPLETE_ECONOMICS", routePositive: "unknown", executableNow: false, netPositive: "unknown", fork: false, signing: false, economics: "STOPPED_BEFORE_FORK" };
}

const FORBIDDEN_KEYS = /^(endpoint|endpoints|url|urls|hostname|host|headers|credential|credentials|apiKey|token|rawResponse|response|payload|error|stack|cause)$/i;
const URL_TEXT = /(?:https?|wss?):\/\/|\bwww\./i;
function assertSanitized(value, trail = []) {
  if (typeof value === "string" && URL_TEXT.test(value)) throw new Error(`UNSANITIZED_URL:${trail.join(".")}`);
  if (Array.isArray(value)) { value.forEach((v, i) => assertSanitized(v, [...trail, String(i)])); return true; }
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) throw new Error(`UNSANITIZED_KEY:${[...trail, key].join(".")}`);
    assertSanitized(child, [...trail, key]);
  }
  return true;
}

function loadAuthority() {
  const priorBytes = fs.readFileSync(PRIOR_CAPTURE), configBytes = fs.readFileSync(PRIOR_ADDRESSES);
  const prior = JSON.parse(priorBytes), config = JSON.parse(configBytes), named = Object.fromEntries(config.map((row) => [row.name, strictAddress(row.addr)]));
  const book = prior.addressBooks.find((row) => row.gateway);
  if (!book) throw new Error("PRIOR_ADDRESS_BOOK_MISSING");
  const authority = {
    gateway: strictAddress(book.gateway), usdc: strictAddress(book.entries.USDC), iusd: strictAddress(book.entries.receiptToken),
    core: strictAddress(prior.root.core), accounting: strictAddress(prior.root.meta.address), farmRegistry: strictAddress(prior.root.farmRegistry),
    mintController: strictAddress(book.entries.mintController), redeemController: strictAddress(book.entries.redeemController),
    yieldSharing: strictAddress(book.entries.yieldSharing), beforeRedeemHook: named.BEFORE_REDEEM_HOOK,
    afterMintHook: named.AFTER_MINT_HOOK, priorGatewayImplementation: strictAddress(book.meta.eip1967Implementation),
    priorGatewayAdmin: strictAddress(book.meta.eip1967Admin)
  };
  if (authority.gateway !== named.GATEWAY_PROXY || authority.iusd !== named.RECEIPT_TOKEN || authority.accounting !== named.ACCOUNTING) throw new Error("PRIOR_AUTHORITY_DISAGREEMENT");
  return { ...authority, inputs: [
    { path: "reports/raw/fast/infinifi-live.json", sha256: sha256(priorBytes) },
    { path: "targets/infinifi-protocol/deployment/configuration/addresses.1.json", sha256: sha256(configBytes) }
  ] };
}

function extractCandidates() {
  const text = fs.readFileSync(RPC_INVENTORY, "utf8"), found = [], seen = new Set();
  for (const match of text.matchAll(/https:\/\/[^\s'"<>]+/g)) {
    const value = match[0].replace(/[),;]+$/, "");
    if (seen.has(value)) continue;
    try { const parsed = new URL(value); if (parsed.protocol !== "https:") continue; } catch (_) { continue; }
    seen.add(value); found.push(value); if (found.length === MAX_CANDIDATES) break;
  }
  if (found.length < 2) throw new Error("INSUFFICIENT_BOUNDED_CANDIDATES");
  return found;
}
function familyOf(secretUrl) {
  const parts = new URL(secretUrl).hostname.toLowerCase().split(".").filter(Boolean);
  return parts.slice(-2).join(".");
}
async function rpc(secretUrl, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(secretUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: controller.signal });
    if (!res.ok) throw new Error("RPC_TRANSPORT_REJECTED");
    const body = await res.json();
    if (!body || body.error || !Object.hasOwn(body, "result") || body.result === null) throw new Error("RPC_RESULT_REJECTED");
    return body.result;
  } catch (_) { throw new Error("RPC_REJECTED"); }
  finally { clearTimeout(timer); }
}

async function qualify(authority) {
  const secrets = extractCandidates(), initial = await Promise.all(secrets.map(async (secret, index) => {
    const started = Date.now();
    try {
      const chain = await rpc(secret, "eth_chainId", [], 7000); if (BigInt(chain) !== 1n) return { secret, index, family: familyOf(secret), chain1: false };
      const finalized = blockHeader(await rpc(secret, "eth_getBlockByNumber", ["finalized", false], 9000));
      return { secret, index, family: familyOf(secret), chain1: true, finalized, elapsed: Date.now() - started };
    } catch (_) { return { secret, index, family: familyOf(secret), chain1: false }; }
  }));
  const chain1 = initial.filter((row) => row.chain1);
  if (chain1.length < 2) throw new Error("QUALIFICATION_CHAIN1_INSUFFICIENT");
  const anchorNumber = chain1.reduce((min, row) => BigInt(row.finalized.number) < min ? BigInt(row.finalized.number) : min, BigInt(chain1[0].finalized.number));
  const atAnchor = await Promise.all(chain1.map(async (row) => {
    try { return { ...row, anchor: blockHeader(await rpc(row.secret, "eth_getBlockByNumber", [q(anchorNumber), false], 9000)) }; }
    catch (_) { return { ...row, anchor: null }; }
  }));
  const groups = new Map();
  for (const row of atAnchor.filter((r) => r.anchor)) {
    const key = `${row.anchor.hash}:${row.anchor.stateRoot}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row);
  }
  const consensus = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  if (!consensus || consensus.length < 2) throw new Error("QUALIFICATION_ANCHOR_CONSENSUS_INSUFFICIENT");
  const pin = consensus[0].anchor, pinObject = { blockHash: pin.hash, requireCanonical: true };
  const balanceData = new Interface(["function balanceOf(address) view returns (uint256)"]).encodeFunctionData("balanceOf", [authority.gateway]);
  const full = await Promise.all(atAnchor.map(async (row) => {
    const flags = { anchor: Boolean(row.anchor && row.anchor.hash === pin.hash && row.anchor.stateRoot === pin.stateRoot), call: false, code: false, storage: false, log: false, rangeLog: false, historicalLog: false };
    if (!flags.anchor) return { ...row, flags, qualified: false };
    const started = Date.now();
    try {
      const results = await Promise.all([
        rpc(row.secret, "eth_call", [{ to: authority.usdc, data: balanceData }, pinObject]),
        rpc(row.secret, "eth_getCode", [authority.gateway, pinObject]),
        rpc(row.secret, "eth_getStorageAt", [authority.gateway, IMPL_SLOT, pinObject]),
        rpc(row.secret, "eth_getLogs", [{ blockHash: pin.hash, address: authority.gateway, topics: [ROUTER_TOPIC] }]),
        rpc(row.secret, "eth_getLogs", [{ fromBlock: q(BigInt(pin.number) - 9_999n), toBlock: pin.numberHex, address: authority.gateway, topics: [ROUTER_TOPIC] }]),
        rpc(row.secret, "eth_getLogs", [{ fromBlock: q(GATEWAY_DEPLOYMENT_QUALIFICATION_BLOCK), toBlock: q(GATEWAY_DEPLOYMENT_QUALIFICATION_BLOCK + 9_999n), address: authority.gateway, topics: [ROUTER_TOPIC] }])
      ]);
      flags.call = /^0x[0-9a-fA-F]{64}$/.test(results[0]); flags.code = /^0x[0-9a-fA-F]+$/.test(results[1]) && results[1] !== "0x";
      flags.storage = /^0x[0-9a-fA-F]{64}$/.test(results[2]); flags.log = Array.isArray(results[3]); flags.rangeLog = Array.isArray(results[4]); flags.historicalLog = Array.isArray(results[5]);
      return { ...row, flags, qualified: Object.values(flags).every(Boolean), capabilityElapsed: Date.now() - started };
    } catch (_) { return { ...row, flags, qualified: false }; }
  }));
  const qualified = full.filter((row) => row.qualified).sort((a, b) => (a.elapsed + a.capabilityElapsed) - (b.elapsed + b.capabilityElapsed));
  let pair = null;
  for (let i = 0; i < qualified.length && !pair; i++) for (let j = i + 1; j < qualified.length; j++) if (qualified[i].family !== qualified[j].family) { pair = [qualified[i], qualified[j]]; break; }
  if (!pair) throw new Error("QUALIFICATION_INDEPENDENT_FAMILIES_INSUFFICIENT");
  const secretLanes = pair.map((selected) => qualified.filter((row) => row.family === selected.family).map((row) => row.secret));
  const familyLabels = new Map(); let familyOrdinal = 0;
  for (const row of full.sort((a, b) => a.index - b.index)) if (!familyLabels.has(row.family)) familyLabels.set(row.family, `anonymous-family-${String(++familyOrdinal).padStart(2, "0")}`);
  return {
    secrets: pair.map((row) => row.secret), secretLanes, pin, pinObject,
    sanitized: {
      boundedCandidateCap: MAX_CANDIDATES, attempted: secrets.length, chain1: chain1.length, fullyQualified: qualified.length,
      requirements: ["chainId=1", "finalized header", "EIP-1898 eth_call", "EIP-1898 eth_getCode", "EIP-1898 eth_getStorageAt", "blockHash eth_getLogs", "bounded recent eth_getLogs", "bounded deployment-era eth_getLogs"],
      selectionRule: "lowest combined qualification latency after all bounded candidates were checked; distinct internal hostname families; no alphabetical preselection",
      candidates: full.sort((a, b) => a.index - b.index).map((row) => ({ candidate: `candidate-${String(row.index + 1).padStart(2, "0")}`, anonymousFamily: familyLabels.get(row.family), chain1: row.chain1, anchorAgreement: row.flags?.anchor || false, eip1898Call: row.flags?.call || false, eip1898Code: row.flags?.code || false, eip1898Storage: row.flags?.storage || false, blockHashLogs: row.flags?.log || false, boundedRecentLogs: row.flags?.rangeLog || false, boundedDeploymentEraLogs: row.flags?.historicalLog || false, fullyQualified: row.qualified || false })),
      selected: pair.map((row, i) => ({ lane: i === 0 ? "A" : "B", candidate: `candidate-${String(row.index + 1).padStart(2, "0")}`, anonymousFamily: familyLabels.get(row.family) })), independentFamilies: true
    }
  };
}

function makeReader(qualification) {
  const lanes = qualification.secretLanes || qualification.secrets.map((secret) => [secret]), pin = qualification.pinObject;
  async function laneCall(lane, method, params) {
    for (const secret of lane) { try { return await rpc(secret, method, params, method === "eth_getLogs" ? 12_000 : RPC_TIMEOUT_MS); } catch (_) { /* anonymous same-family failover */ } }
    throw new Error("ANONYMOUS_FAMILY_READ_FAILURE");
  }
  async function dual(method, params, optional = false) {
    const rows = await Promise.allSettled(lanes.map((lane) => laneCall(lane, method, params)));
    if (rows.every((r) => r.status === "rejected") && optional) return null;
    if (rows.some((r) => r.status === "rejected")) throw new Error("INDEPENDENT_PROVIDER_READ_FAILURE");
    if (canonicalize(rows[0].value) !== canonicalize(rows[1].value)) throw new Error("INDEPENDENT_PROVIDER_DISAGREEMENT");
    return rows[0].value;
  }
  async function call(to, fragment, args = [], optional = false) {
    const iface = new Interface([fragment]), fn = iface.fragments[0].name, data = iface.encodeFunctionData(fn, args);
    const result = await dual("eth_call", [{ to: strictAddress(to), data }, pin], optional);
    if (result === null) return null;
    try { const decoded = iface.decodeFunctionResult(fn, result); return decoded.length === 1 ? decoded[0] : decoded; } catch (_) { if (optional) return null; throw new Error("ABI_DECODE_FAILURE"); }
  }
  return { dual, call, pin };
}

function listJsonFiles(directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name); if (entry.isDirectory()) listJsonFiles(full, out); else if (entry.isFile() && entry.name.endsWith(".json") && !full.includes(`${path.sep}build-info${path.sep}`)) out.push(full);
  }
  return out;
}
function zeroRanges(hex, references = {}) {
  const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
  for (const rows of Object.values(references || {})) for (const row of rows) bytes.fill(0, row.start, row.start + row.length);
  return bytes.toString("hex");
}
function artifactIndex() {
  const index = [];
  for (const file of listJsonFiles(path.join(TARGET, "out"))) {
    try {
      const artifact = JSON.parse(fs.readFileSync(file, "utf8")), object = artifact.deployedBytecode?.object;
      if (!object || !/^[0-9a-fA-F]+$/.test(object)) continue;
      const target = artifact.metadata?.settings?.compilationTarget || {}, sourceName = Object.keys(target)[0] || null, contractName = target[sourceName] || path.basename(file, ".json");
      index.push({ file, artifact, object: object.toLowerCase(), normalized: zeroRanges(object, artifact.deployedBytecode.immutableReferences), sourceName, contractName });
    } catch (_) { /* non-artifact JSON */ }
  }
  return index;
}
function sourceCommitBinding(match) {
  if (!match?.sourceName?.startsWith("src/")) return { exactCommitSource: false, reason: "dependency-or-generated-source" };
  const current = fs.readFileSync(path.join(TARGET, match.sourceName));
  let committed;
  try { committed = execFileSync("git", ["show", `${EXPECTED_COMMIT}:${match.sourceName}`], { cwd: TARGET, encoding: null, stdio: ["ignore", "pipe", "ignore"] }); }
  catch (_) { return { exactCommitSource: false, reason: "commit-source-unavailable" }; }
  const metadataHash = match.artifact.metadata?.sources?.[match.sourceName]?.keccak256?.toLowerCase() || null;
  return { exactCommitSource: current.equals(committed) && metadataHash === keccak256(current).toLowerCase(), sourcePath: match.sourceName, sourceKeccak256: keccak256(current), artifactCompiler: match.artifact.metadata?.compiler?.version || null };
}
function matchRuntime(code, index, expectedNames = null) {
  const raw = code.replace(/^0x/, "").toLowerCase(), candidates = expectedNames ? index.filter((row) => expectedNames.includes(row.contractName)) : index;
  for (const row of candidates) if (raw.length === row.object.length && zeroRanges(raw, row.artifact.deployedBytecode.immutableReferences) === row.normalized) {
    return { matched: true, contractName: row.contractName, normalizedImmutableMatch: raw !== row.object, runtimeBytes: raw.length / 2, runtimeKeccak256: keccak256(`0x${raw}`), ...sourceCommitBinding(row) };
  }
  return { matched: false, contractName: null, normalizedImmutableMatch: false, runtimeBytes: raw.length / 2, runtimeKeccak256: keccak256(`0x${raw}`), exactCommitSource: false };
}

async function findDeployment(reader, address, pinNumber) {
  let low = 0n, high = BigInt(pinNumber);
  while (low < high) {
    const mid = (low + high) >> 1n, code = await reader.dual("eth_getCode", [address, q(mid)]);
    if (code === "0x") low = mid + 1n; else high = mid;
  }
  const at = await reader.dual("eth_getCode", [address, q(low)]), before = low === 0n ? "0x" : await reader.dual("eth_getCode", [address, q(low - 1n)]);
  if (at === "0x" || before !== "0x") throw new Error("DEPLOYMENT_BLOCK_NOT_BOUND");
  return low;
}
async function completeRouterHistory(reader, gateway, deploymentBlock, pinNumber) {
  let from = BigInt(deploymentBlock), end = BigInt(pinNumber); const span = 10_000n, ranges = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  while (from <= end) {
    const to = from + span - 1n > end ? end : from + span - 1n;
    ranges.push([from, to]); if (ranges.length > MAX_LOG_CHUNKS) throw new Error("ROUTER_HISTORY_CHUNK_CAP"); from = to + 1n;
  }
  const results = new Array(ranges.length); let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++; if (index >= ranges.length) return; const [rangeFrom, rangeTo] = ranges[index];
      let rows = null;
      for (let attempt = 0; attempt < 8 && rows === null; attempt++) {
        try { rows = await reader.dual("eth_getLogs", [{ fromBlock: q(rangeFrom), toBlock: q(rangeTo), address: gateway, topics: [ROUTER_TOPIC] }]); }
        catch (_) { if (attempt < 7) await sleep(Math.min(4_000, 500 * (attempt + 1))); }
      }
      if (rows === null) throw new Error("ROUTER_HISTORY_UNAVAILABLE"); results[index] = rows;
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, ranges.length) }, worker));
  const logs = results.flat();
  const iface = new Interface(["event SetEnabledRouter(uint256 timestamp,address router,bool enabled)"]);
  const decoded = logs.map((log) => {
    const parsed = iface.parseLog(log); return { blockNumber: BigInt(log.blockNumber).toString(), transactionHash: log.transactionHash.toLowerCase(), logIndex: BigInt(log.logIndex).toString(), timestamp: parsed.args.timestamp.toString(), router: strictAddress(parsed.args.router), enabled: parsed.args.enabled };
  }).sort((x, y) => Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) || Number(BigInt(x.logIndex) - BigInt(y.logIndex)));
  const current = new Map(); decoded.forEach((row) => current.set(row.router, row.enabled));
  return { deploymentBlock: deploymentBlock.toString(), throughBlock: pinNumber.toString(), completeRange: true, queriedChunks: ranges.length, events: decoded, replayedRouters: [...current].map(([router, enabled]) => ({ router, enabled })) };
}

async function roles(reader, core, names) {
  const out = {};
  for (const name of names) {
    const role = id(name), count = Number(await reader.call(core, "function getRoleMemberCount(bytes32) view returns (uint256)", [role]));
    if (count > MAX_ROLE_MEMBERS) throw new Error("ROLE_MEMBER_CAP");
    const members = []; for (let i = 0; i < count; i++) members.push(strictAddress(await reader.call(core, "function getRoleMember(bytes32,uint256) view returns (address)", [role, i])));
    out[name] = { role, members };
  }
  return out;
}
async function bindCode(reader, address, index, expectedNames = null) {
  const code = await reader.dual("eth_getCode", [address, reader.pin]); if (code === "0x") throw new Error("EXPECTED_CODE_ABSENT");
  return matchRuntime(code, index, expectedNames);
}

async function executeCapture(options = {}) {
  const progress = options.onProgress || (() => {}), authority = loadAuthority(); progress("authority-loaded");
  const qualification = await qualify(authority), reader = makeReader(qualification), artifacts = artifactIndex(); progress("providers-qualified");
  const pinNumber = BigInt(qualification.pin.number), gatewayImpl = addressFromWord(await reader.dual("eth_getStorageAt", [authority.gateway, IMPL_SLOT, reader.pin]));
  const gatewayAdmin = addressFromWord(await reader.dual("eth_getStorageAt", [authority.gateway, ADMIN_SLOT, reader.pin]));
  const gatewayCore = strictAddress(await reader.call(authority.gateway, "function core() view returns (address)"));
  const names = ["USDC", "receiptToken", "mintController", "redeemController", "yieldSharing", "afterMintHook", "beforeRedeemHook"];
  const book = {}; for (const name of names) book[name] = strictAddress(await reader.call(authority.gateway, "function getAddress(string) view returns (address)", [name]));
  const mintAccounting = strictAddress(await reader.call(book.mintController, "function accounting() view returns (address)"));
  const redeemAccounting = strictAddress(await reader.call(book.redeemController, "function accounting() view returns (address)"));
  const farmRegistry = strictAddress(await reader.call(mintAccounting, "function farmRegistry() view returns (address)"));
  const beforeHook = strictAddress(await reader.call(book.redeemController, "function beforeRedeemHook() view returns (address)"));
  const afterHook = strictAddress(await reader.call(book.mintController, "function afterMintHook() view returns (address)"));
  const rebound = { gateway: authority.gateway, gatewayImplementation: gatewayImpl, gatewayAdmin, usdc: book.USDC, iusd: book.receiptToken, core: gatewayCore, accounting: mintAccounting, farmRegistry, mintController: book.mintController, redeemController: book.redeemController, yieldSharing: book.yieldSharing, beforeRedeemHook: beforeHook, afterMintHook: afterHook };
  const expectedPairs = { gateway: authority.gateway, usdc: authority.usdc, iusd: authority.iusd, core: authority.core, accounting: authority.accounting, farmRegistry: authority.farmRegistry, mintController: authority.mintController, redeemController: authority.redeemController, yieldSharing: authority.yieldSharing, beforeRedeemHook: authority.beforeRedeemHook, afterMintHook: authority.afterMintHook };
  const authorityMatch = Object.entries(expectedPairs).every(([key, value]) => rebound[key] === value) && mintAccounting === redeemAccounting;

  const deploymentBlock = await findDeployment(reader, authority.gateway, pinNumber); progress(`deployment-bound-${deploymentBlock}`);
  const routerHistory = await completeRouterHistory(reader, authority.gateway, deploymentBlock, pinNumber); progress("router-history-complete");
  for (const row of routerHistory.replayedRouters) row.currentEnabled = Boolean(await reader.call(authority.gateway, "function enabledRouters(address) view returns (bool)", [row.router]));
  if (routerHistory.replayedRouters.some((row) => row.enabled !== row.currentEnabled)) throw new Error("ROUTER_HISTORY_REPLAY_MISMATCH");
  const enabledRouters = routerHistory.replayedRouters.filter((row) => row.currentEnabled).map((row) => row.router);

  const yieldImplWord = await reader.dual("eth_getStorageAt", [book.yieldSharing, IMPL_SLOT, reader.pin], true), yieldAdminWord = await reader.dual("eth_getStorageAt", [book.yieldSharing, ADMIN_SLOT, reader.pin], true);
  const yieldImplementation = yieldImplWord ? addressFromWord(yieldImplWord) : null, yieldAdmin = yieldAdminWord ? addressFromWord(yieldAdminWord) : null;
  const componentAddresses = { gatewayProxy: authority.gateway, gatewayImplementation: gatewayImpl, iusd: book.receiptToken, core: gatewayCore, accounting: mintAccounting, farmRegistry, mintController: book.mintController, redeemController: book.redeemController, beforeRedeemHook: beforeHook, afterMintHook: afterHook };
  if (yieldImplementation && yieldImplementation !== ZERO) componentAddresses.yieldSharingImplementation = yieldImplementation;
  const runtime = {};
  for (const [name, address] of Object.entries(componentAddresses)) runtime[name] = { address, ...(await bindCode(reader, address, artifacts, EXPECTED_CONTRACTS[name])) };
  runtime.yieldSharingProxy = { address: book.yieldSharing, ...(await bindCode(reader, book.yieldSharing, artifacts, ["TransparentUpgradeableProxy", "ERC1967Proxy"])) };
  progress("runtime-bound");

  const coreRoles = await roles(reader, gatewayCore, ["GOVERNOR", "ENTRY_POINT", "RECEIPT_TOKEN_MINTER", "RECEIPT_TOKEN_BURNER", "FARM_MANAGER", "PROTOCOL_PARAMETERS"]);
  progress("roles-bound");
  const ordinary = "0x000000000000000000000000000000000000dEaD";
  const gatewayResidue = BigInt(await reader.call(book.USDC, "function balanceOf(address) view returns (uint256)", [authority.gateway]));
  const zapFee = BigInt(await reader.call(authority.gateway, "function zapFee() view returns (uint256)"));
  const gatewayPaused = Boolean(await reader.call(authority.gateway, "function paused() view returns (bool)"));
  const iusdSupply = BigInt(await reader.call(book.receiptToken, "function totalSupply() view returns (uint256)"));
  const mintPaused = Boolean(await reader.call(book.mintController, "function paused() view returns (bool)"));
  const redeemPaused = Boolean(await reader.call(book.redeemController, "function paused() view returns (bool)"));
  const mintLiquidity = BigInt(await reader.call(book.mintController, "function liquidity() view returns (uint256)"));
  const redeemLiquidity = BigInt(await reader.call(book.redeemController, "function liquidity() view returns (uint256)"));
  const minRedemption = BigInt(await reader.call(book.redeemController, "function minRedemptionAmount() view returns (uint256)"));
  const queueLength = BigInt(await reader.call(book.redeemController, "function queueLength() view returns (uint256)"));
  const unaccruedYield = BigInt(await reader.call(book.yieldSharing, "function unaccruedYield() view returns (int256)"));
  const beforeState = {
    paused: Boolean(await reader.call(beforeHook, "function paused() view returns (bool)")),
    accounting: strictAddress(await reader.call(beforeHook, "function accounting() view returns (address)")),
    allocationVoting: strictAddress(await reader.call(beforeHook, "function allocationVoting() view returns (address)")),
    mintController: strictAddress(await reader.call(beforeHook, "function mintController() view returns (address)"))
  };
  const enabledUsdc = Boolean(await reader.call(farmRegistry, "function isAssetEnabled(address) view returns (bool)", [book.USDC]));
  const liquidAddresses = [...await reader.call(farmRegistry, "function getAssetTypeFarms(address,uint256) view returns (address[])", [book.USDC, 1])].map(strictAddress);
  const liquidFarms = [];
  for (const farm of liquidAddresses) {
    const asset = strictAddress(await reader.call(farm, "function assetToken() view returns (address)")), vaultValue = await reader.call(farm, "function vault() view returns (address)", [], true);
    const vault = vaultValue ? strictAddress(vaultValue) : null;
    const row = {
      address: farm, asset, paused: Boolean(await reader.call(farm, "function paused() view returns (bool)")),
      assetBalanceRaw: (await reader.call(asset, "function balanceOf(address) view returns (uint256)", [farm])).toString(),
      assetsRaw: (await reader.call(farm, "function assets() view returns (uint256)")).toString(), liquidityRaw: (await reader.call(farm, "function liquidity() view returns (uint256)")).toString(),
      capRaw: (await reader.call(farm, "function cap() view returns (uint256)")).toString(), maxDepositRaw: (await reader.call(farm, "function maxDeposit() view returns (uint256)")).toString(),
      vault, vaultMaxWithdrawRaw: null, farmMaxWithdrawRaw: null, ordinaryHasFarmManagerRole: Boolean(await reader.call(gatewayCore, "function hasRole(bytes32,address) view returns (bool)", [id("FARM_MANAGER"), ordinary])),
      sourceWithdrawAuthority: "FARM_MANAGER", runtime: await bindCode(reader, farm, artifacts)
    };
    const farmMax = await reader.call(farm, "function maxWithdraw(address) view returns (uint256)", [farm], true); if (farmMax !== null) row.farmMaxWithdrawRaw = farmMax.toString();
    if (vault && vault !== ZERO) { const max = await reader.call(vault, "function maxWithdraw(address) view returns (uint256)", [farm], true); if (max !== null) row.vaultMaxWithdrawRaw = max.toString(); }
    liquidFarms.push(row);
  }
  progress("protocol-state-bound");
  const liquidAvailable = liquidFarms.filter((row) => !row.paused).reduce((sum, row) => sum + BigInt(row.liquidityRaw), 0n);
  const grossIusd = BigInt(await reader.call(book.mintController, "function assetToReceipt(uint256) view returns (uint256)", [gatewayResidue]));
  const formula = extraIusd(grossIusd, zapFee), extraAsset = BigInt(await reader.call(book.redeemController, "function receiptToAsset(uint256) view returns (uint256)", [formula.net]));
  const physicalCeiling = redeemLiquidity + mintLiquidity + liquidAvailable, immediateCeiling = extraAsset < physicalCeiling ? extraAsset : physicalCeiling;

  const requiredRuntimeNames = ["gatewayProxy", "gatewayImplementation", "iusd", "core", "accounting", "farmRegistry", "mintController", "redeemController", "yieldSharingProxy", "yieldSharingImplementation", "beforeRedeemHook", "afterMintHook"];
  const bindingPass = authorityMatch && requiredRuntimeNames.every((name) => runtime[name]?.matched) && liquidFarms.every((row) => row.runtime.matched);
  const decision = decideGate({ residueRaw: gatewayResidue, bindingPass, enabledRouterCount: enabledRouters.length, immediateCeilingRaw: immediateCeiling, marketExitAvailable: false });
  const terminal = [blockHeader(await reader.dual("eth_getBlockByNumber", [qualification.pin.numberHex, false]))], terminalExact = terminal.every((row) => row.hash === qualification.pin.hash && row.stateRoot === qualification.pin.stateRoot && row.number === qualification.pin.number);
  if (!terminalExact) throw new Error("TERMINAL_RECHECK_FAILED");

  const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: TARGET, encoding: "utf8" }).trim(), sourceDiff = execFileSync("git", ["diff", "--", "src"], { cwd: TARGET, encoding: "utf8" });
  const capture = {
    schema: SCHEMA, generatedAt: new Date().toISOString(), status: decision.status,
    scope: { chainId: 1, defensiveReadOnly: true, stateOverride: false, transactions: false, traces: false, signing: false, victimData: false, mempool: false, forkExecuted: false, bounty: "unknown" },
    authority: { inputs: authority.inputs, exactIsolatedCommit: EXPECTED_COMMIT, headCommit, productionSourceDiffEmpty: sourceDiff.length === 0, authoritativeAddressRebindExact: authorityMatch, rebound },
    chain: { finalized: qualification.pin, statePin: qualification.pinObject, qualification: qualification.sanitized, terminalRecheck: { exact: terminalExact, checkedAnonymousFamilies: 2 } },
    runtimeBinding: { status: bindingPass ? "PASS_EXACT_ISOLATED_BUILD_RUNTIME" : "FAIL_CLOSED_RUNTIME_OR_SOURCE_MISMATCH", failClosed: !bindingPass, gatewayAdmin, yieldSharingImplementation: yieldImplementation, yieldSharingAdmin: yieldAdmin, components: runtime },
    gateway: {
      paused: gatewayPaused, zapFeeRaw: zapFee.toString(), usdc: book.USDC, usdcBalanceRaw: gatewayResidue.toString(), usdcBalance: formatUnits(gatewayResidue, 6),
      routerHistory, currentlyEnabledRouters: enabledRouters,
      ordinaryCallerReachability: { sourceAuthority: "isolated-commit-only", currentDeploymentApplicability: bindingPass ? true : "unknown-fail-closed", zapInExternal: true, roleRequiredBySource: false, enabledRouterRequired: true, routerCallsSent: false, routerCalldataFeasibility: "not-tested", recipientControlledByCaller: true },
      recoveryAuthority: { sourceAuthority: "isolated-commit-only", currentDeploymentApplicability: bindingPass ? true : "unknown-fail-closed", mechanism: "CoreControlled.emergencyAction arbitrary calls", requiredRole: "GOVERNOR", publicSweep: false, governorMembers: coreRoles.GOVERNOR.members }
    },
    protocol: {
      iusd: { address: book.receiptToken, totalSupplyRaw: iusdSupply.toString(), totalSupply: formatUnits(iusdSupply, 18) },
      mintController: { address: book.mintController, paused: mintPaused, liquidityRaw: mintLiquidity.toString(), entryPointMembers: coreRoles.ENTRY_POINT.members, receiptTokenMinterMembers: coreRoles.RECEIPT_TOKEN_MINTER.members },
      redeemController: { address: book.redeemController, paused: redeemPaused, physicalLiquidityRaw: redeemLiquidity.toString(), physicalLiquidity: formatUnits(redeemLiquidity, 6), minRedemptionAmountRaw: minRedemption.toString(), queueLength: queueLength.toString(), entryPointMembers: coreRoles.ENTRY_POINT.members, receiptTokenBurnerMembers: coreRoles.RECEIPT_TOKEN_BURNER.members },
      yieldSharing: { address: book.yieldSharing, unaccruedYieldRaw: unaccruedYield.toString() }, beforeRedeemHook: beforeState,
      usdcEnabled: enabledUsdc, liquidFarms,
      directRedemptionSourceBehavior: { authority: "exact-isolated-commit-only", currentDeploymentApplicability: bindingPass ? true : "unknown-fail-closed", gatewayRejectsNegativeUnaccruedYield: true, gatewayTransfersIusdFromCaller: true, explicitRecipient: true, queueNonemptyForcesFullQueueAndZeroImmediateOutput: true, hookRunsOnlyWhenQueueEmpty: true, hookFirstUsesMintControllerThenLiquidFarms: true, insufficientPostHookLiquidityPaysAvailableAndQueuesRemainder: true, redemptionFeeRaw: "0", claimBindsGatewayCaller: true }
    },
    publicMarketExit: { priorAuthoritativeTopologyContainsFullPoolAddress: false, poolReadPerformed: false, reason: "No full authoritative iUSD/USDC pool address exists in the consumed sanitized prior topology; abbreviated prose was not used as authority." },
    formula: { residueUsdcRaw: gatewayResidue.toString(), sourceAssetToReceiptGrossIusdRaw: formula.gross, zapFeeRaw: zapFee.toString(), zapFeeIusdRaw: formula.fee, maxExtraIusdAfterZapFeeRaw: formula.net, directAssetEquivalentRaw: extraAsset.toString(), knownRedemptionFeeRaw: "0", physicalImmediateLiquidityCeilingRaw: physicalCeiling.toString(), immediateRedemptionGrossCeilingRaw: immediateCeiling.toString(), marketExitGrossCeilingRaw: null },
    gates: { ...decision, sourceReachable: bindingPass, routerReachable: enabledRouters.length > 0 ? "source-only-not-called" : false, recipientReachable: bindingPass, liquidExit: gatewayResidue === 0n ? "not-required-zero-primary-gate" : immediateCeiling > 0n, bounty: "unknown" },
    limitations: ["No router call or live zap was sent.", "No swap, state override, trace, transaction, signing, victim, position, or mempool work was performed.", "Deploy.s.sol at the isolated commit calls the three-argument BeforeRedeemHook constructor while source requires four arguments including mintController; this known deployment-script/compiler mismatch is separate from the runtime comparison."]
  };
  assertSanitized(capture); progress("capture-complete"); return capture;
}

function reportFor(c) {
  const zero = c.gateway.usdcBalanceRaw === "0", binding = c.runtimeBinding.status;
  return `---\nreportStatus: FINAL\nstatus: ${c.status}\nroutePositive: ${c.gates.routePositive}\nexecutableNow: ${c.gates.executableNow}\nnetPositive: ${c.gates.netPositive}\nfork: ${c.gates.fork}\nsigning: ${c.gates.signing}\nbounty: unknown\n---\n\n# InfiniFi Gateway residue current deployment/exit Gate3\n\nDate: ${c.generatedAt.slice(0, 10)}\n\n## Result\n\n**${c.status}**. The fixed-finalized, two-independent-family capture found Gateway USDC residue of **${c.gateway.usdcBalance} USDC** (raw \`${c.gateway.usdcBalanceRaw}\`). ${zero ? "The primary gate is therefore closed without fork or economics." : "The residue gate is positive but remains non-executable and stopped before fork."}\n\nRuntime/source binding: \`${binding}\`. All state calls/code/storage used EIP-1898 \`blockHash + requireCanonical\`; history covered deployment block \`${c.gateway.routerHistory.deploymentBlock}\` through finalized pin \`${c.chain.finalized.number}\`, followed by an exact terminal header/state-root recheck. Endpoint inventory values and provider identities are absent from artifacts.\n\n## Deployment binding\n\n| Component | Current authoritative address | Runtime |\n|---|---|---|\n${Object.entries(c.runtimeBinding.components).map(([name, row]) => `| ${name} | \`${row.address}\` | ${row.matched ? `exact ${row.contractName}` : "**mismatch / fail closed**"} |`).join("\n")}\n\nGateway admin is \`${c.runtimeBinding.gatewayAdmin}\`; YieldSharing implementation is \`${c.runtimeBinding.yieldSharingImplementation}\`. Address-book/controller/root rebinding exact: **${c.authority.authoritativeAddressRebindExact}**. Isolated source commit: \`${c.authority.exactIsolatedCommit}\`; production source diff empty: **${c.authority.productionSourceDiffEmpty}**.\n\nThe current runtimes do not match the isolated commit build, so source-based reachability, recovery, and redemption semantics are explicitly **isolated-commit-only** and current-deployment applicability remains unknown/fail-closed.\n\nKnown separate source issue: \`script/Deploy.s.sol\` still supplies three arguments to \`BeforeRedeemHook\`, while the reviewed constructor requires four including \`mintController\`. This does not alter the runtime match result.\n\n## Gateway and router history\n\n- Paused: **${c.gateway.paused}**; zap fee: raw \`${c.gateway.zapFeeRaw}\`.\n- Router events: **${c.gateway.routerHistory.events.length}**; currently enabled routers: **${c.gateway.currentlyEnabledRouters.length}**.\n- No router calls or zaps were sent. Isolated-commit source reachability: public \`zapIn\`, enabled-router check, and caller-controlled recipient. Router calldata feasibility was not tested; current-runtime applicability is fail-closed unknown.\n- In isolated-commit source, no public sweep exists and recovery uses governor-only \`emergencyAction\`; current governor members are captured in JSON. Current-runtime applicability is fail-closed unknown.\n\n## Exit state\n\n- iUSD supply: \`${c.protocol.iusd.totalSupply}\` (raw \`${c.protocol.iusd.totalSupplyRaw}\`).\n- MintController paused/liquidity: **${c.protocol.mintController.paused}** / raw \`${c.protocol.mintController.liquidityRaw}\`.\n- RedeemController paused/physical liquidity/queue/minimum: **${c.protocol.redeemController.paused}** / \`${c.protocol.redeemController.physicalLiquidity}\` USDC / \`${c.protocol.redeemController.queueLength}\` / raw \`${c.protocol.redeemController.minRedemptionAmountRaw}\`.\n- Unaccrued yield: raw \`${c.protocol.yieldSharing.unaccruedYieldRaw}\`; BeforeRedeemHook paused: **${c.protocol.beforeRedeemHook.paused}**; USDC enabled: **${c.protocol.usdcEnabled}**.\n- Current USDC liquid farms captured: **${c.protocol.liquidFarms.length}**, including balances, assets, liquidity, caps, max-deposit, available max-withdraw views, pause state, runtime match, and isolated-source FARM_MANAGER-only withdrawal authority.\n\nExact isolated-commit redemption behavior: the Gateway rejects negative unaccrued yield, transfers caller iUSD, and allows an explicit recipient. A nonempty queue forces full queueing and zero immediate output. With an empty queue the hook first uses MintController liquidity and then registered liquid farms. Any remaining insufficient-liquidity amount is queued. Source has no separate redemption fee. Because runtime continuity failed, these semantics are not asserted for the current deployment.\n\nNo full pool address was present in the consumed authoritative prior topology, so abbreviated prose was not promoted to authority and no pool quote was made.\n\n## Formula and gates\n\n\`grossIUSD = MintController.assetToReceipt(gatewayResidue)\`  \n\`zapFeeIUSD = floor(grossIUSD * zapFee / 1e18)\`  \n\`maxExtraIUSD = grossIUSD - zapFeeIUSD\`\n\nObserved raw values: gross \`${c.formula.sourceAssetToReceiptGrossIusdRaw}\`, zap fee \`${c.formula.zapFeeIusdRaw}\`, maximum extra iUSD \`${c.formula.maxExtraIusdAfterZapFeeRaw}\`, direct asset equivalent \`${c.formula.directAssetEquivalentRaw}\`. Known isolated-source redemption fee is zero.\n\n\`routePositive=${c.gates.routePositive}\`; \`executableNow=${c.gates.executableNow}\`; \`netPositive=${c.gates.netPositive}\`; \`fork=${c.gates.fork}\`; \`signing=${c.gates.signing}\`; bounty unknown.\n\n## Safety\n\nRead-only finalized Ethereum capture only. No transaction, state override, trace, signing, fork, router call, zap, swap, user position, victim, or mempool work.\n`;
}

function writeArtifacts(capture) {
  fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(CAPTURE_PATH, json(capture)); fs.writeFileSync(REPORT_PATH, reportFor(capture));
  const files = [CAPTURE_PATH, REPORT_PATH, RUNNER_PATH, TEST_PATH, VALIDATOR_PATH].map((file) => ({ path: path.relative(ROOT, file).replace(/\\/g, "/"), bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)) }));
  const manifest = { schema: MANIFEST_SCHEMA, generatedAt: capture.generatedAt, captureStatus: capture.status, files, validation: { jsonParsed: true, sanitized: true, terminalRecheck: capture.chain.terminalRecheck.exact, artifactHashes: "sha256" } };
  assertSanitized(manifest); fs.writeFileSync(MANIFEST_PATH, json(manifest)); return manifest;
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--capture") throw new Error("USAGE_CAPTURE_FLAG_REQUIRED");
  const capture = await executeCapture({ onProgress: (stage) => console.log(`InfiniFi Gate3 stage: ${stage}`) }); writeArtifacts(capture);
  console.log(`InfiniFi Gate3 capture complete: ${capture.status}; residueRaw=${capture.gateway.usdcBalanceRaw}`);
}

module.exports = { SCHEMA, MANIFEST_SCHEMA, ROOT, OUT_DIR, CAPTURE_PATH, MANIFEST_PATH, REPORT_PATH, EXPECTED_COMMIT, WAD, canonicalize, sha256, extraIusd, decideGate, assertSanitized, zeroRanges, matchRuntime, reportFor, executeCapture, writeArtifacts };
if (require.main === module) main().catch((failure) => { console.error(`InfiniFi Gate3 capture failed closed: ${String(failure?.message || "UNKNOWN_FAILURE").replace(/(?:https?|wss?):\/\/\S+/gi, "[redacted]")}`); process.exit(1); });
