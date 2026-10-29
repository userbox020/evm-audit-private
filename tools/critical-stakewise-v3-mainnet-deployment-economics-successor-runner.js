#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { Interface, getAddress, id } = require("ethers");
const step2 = require("./critical-stakewise-v3-eth-exitqueue-step2-runner.js");
const osToken = require("./critical-stakewise-v3-ostoken-mainnet-runner.js");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "stakewise-v3-core-v5.0.1");
const INVENTORY_PATH = path.join(ROOT, "rpc_endpoints.txt");
const DEPLOYMENT_PATH = path.join(TARGET, "deployments", "mainnet.json");
const PREFIX = "critical-stakewise-v3-mainnet-deployment-economics-successor";
const FINDING_ID = "stakewise-v3-preharvest-queue-checkpoint-shield-deployment-economics";
const CAPTURE_FLAG = "--capture-stakewise-mainnet-once";
const RUN_ID_PATTERN = /^swv3econ-(\d{8}T\d{6}Z)-([0-9a-f]{32})$/u;
const OUTPUT_DIR_REL = "reports/raw/fast";
const PREFLIGHT_REL = `${OUTPUT_DIR_REL}/${PREFIX}-preflight.json`;
const MANIFEST_REL = `${OUTPUT_DIR_REL}/${PREFIX}-manifest.json`;
const REPORT_REL = `reports/${PREFIX}.md`;
const FIXTURE_REL = `tools/fixtures/${PREFIX}-fixtures.json`;

const ALLOWED_METHODS = new Set([
  "eth_call",
  "eth_chainId",
  "eth_getBalance",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs"
]);
const FORBIDDEN_METHODS = new Set([
  "eth_estimateGas", "eth_getStorageAt", "eth_getTransactionByHash", "eth_getTransactionReceipt",
  "eth_sendRawTransaction", "eth_sendTransaction", "debug_traceCall", "debug_traceTransaction", "trace_call",
  "trace_transaction"
]);
const CAPS = Object.freeze({
  chains: 1,
  maxInventoryBytes: 65536,
  maxInventoryLines: 1024,
  maxInventoryEntries: 64,
  maxEndpointFamilies: 16,
  minimumPromotableFamilies: 2,
  maxFactories: 32,
  maxVaults: 1000,
  maxAddressBatch: 64,
  maxLogChunkBlocks: 50000,
  maxScanSpanBlocks: 32000000,
  maxChunks: 4096,
  maxLogs: 100000,
  maxTotalRequests: 60000,
  maxLogRequests: 5000,
  maxCallRequests: 42000,
  maxCodeRequests: 5000,
  maxBalanceRequests: 5000,
  maxBlockRequests: 256,
  retriesPerRequest: 0,
  maxResponseBytes: 2097152,
  maxAggregateResponseBytes: 134217728,
  requestTimeoutMs: 8000,
  maxElapsedMs: 900000,
  minPlausiblePin: 1000000,
  maxPlausiblePin: 50000000,
  maxRunIdAgeMs: 300000,
  maxRunIdFutureSkewMs: 30000,
  maxOutputBytes: 16777216,
  maxPublicDatasetGets: 0,
  maxPublicDatasetBytes: 4194304,
  depositSweepBps: [100, 500, 1000, 2500, 5000, 7500, 10000]
});

const FACTORY_KEYS = Object.freeze([
  "VaultFactory", "PrivVaultFactory", "MetaVaultFactory", "PrivMetaVaultFactory", "BlocklistVaultFactory",
  "Erc20VaultFactory", "PrivErc20VaultFactory", "Erc20MetaVaultFactory", "PrivErc20MetaVaultFactory",
  "BlocklistErc20VaultFactory"
]);
const DIRECT_VAULT_KEYS = Object.freeze(["CommunityVault", "FoxVault", "GenesisVault"]);
const FACTORY_CLASS = Object.freeze({
  VaultFactory: { access: "PUBLIC", meta: false, assetMode: "NATIVE_ETH" },
  PrivVaultFactory: { access: "PRIVATE", meta: false, assetMode: "NATIVE_ETH" },
  MetaVaultFactory: { access: "PUBLIC", meta: true, assetMode: "NATIVE_ETH" },
  PrivMetaVaultFactory: { access: "PRIVATE", meta: true, assetMode: "NATIVE_ETH" },
  BlocklistVaultFactory: { access: "BLOCKLIST", meta: false, assetMode: "NATIVE_ETH" },
  Erc20VaultFactory: { access: "PUBLIC", meta: false, assetMode: "ERC20" },
  PrivErc20VaultFactory: { access: "PRIVATE", meta: false, assetMode: "ERC20" },
  Erc20MetaVaultFactory: { access: "PUBLIC", meta: true, assetMode: "ERC20" },
  PrivErc20MetaVaultFactory: { access: "PRIVATE", meta: true, assetMode: "ERC20" },
  BlocklistErc20VaultFactory: { access: "BLOCKLIST", meta: false, assetMode: "ERC20" }
});
const DIRECT_CLASS = Object.freeze({
  CommunityVault: { access: "PUBLIC", meta: false, assetMode: "NATIVE_ETH", directType: "COMMUNITY" },
  FoxVault: { access: "PUBLIC", meta: false, assetMode: "NATIVE_ETH", directType: "FOX" },
  GenesisVault: { access: "PUBLIC", meta: false, assetMode: "NATIVE_ETH", directType: "GENESIS" }
});

const registryAbi = new Interface([
  "function vaults(address) view returns (bool)",
  "function vaultImpls(address) view returns (bool)",
  "function factories(address) view returns (bool)",
  "event FactoryAdded(address indexed factory)",
  "event FactoryRemoved(address indexed factory)",
  "event VaultAdded(address indexed caller,address indexed vault)",
  "event VaultImplAdded(address indexed impl)",
  "event VaultImplRemoved(address indexed impl)"
]);
const factoryAbi = new Interface([
  "function implementation() view returns (address)",
  "event VaultCreated(address indexed admin,address indexed vault,address ownMevEscrow,bytes params)",
  "event MetaVaultCreated(address indexed caller,address indexed admin,address indexed vault,bytes params)"
]);
const vaultAbi = new Interface([
  "function implementation() view returns (address)",
  "function version() view returns (uint8)",
  "function vaultId() view returns (bytes32)",
  "function capacity() view returns (uint256)",
  "function feePercent() view returns (uint16)",
  "function totalAssets() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function getExitQueueData() view returns (uint128,uint128,uint128,uint128,uint256)",
  "function withdrawableAssets() view returns (uint256)",
  "function isStateUpdateRequired() view returns (bool)",
  "function mevEscrow() view returns (address)"
]);
const keeperAbi = new Interface([
  "function rewardsNonce() view returns (uint64)",
  "function rewards(address) view returns (int192 assets,uint64 nonce)",
  "function unlockedMevRewards(address) view returns (uint192 assets,uint64 nonce)",
  "function canHarvest(address) view returns (bool)",
  "function isHarvestRequired(address) view returns (bool)",
  "function isCollateralized(address) view returns (bool)",
  "function rewardsRoot() view returns (bytes32)",
  "function prevRewardsRoot() view returns (bytes32)",
  "function lastRewardsTimestamp() view returns (uint64)",
  "event RewardsUpdated(address indexed caller,bytes32 indexed rewardsRoot,uint256 avgRewardPerSecond,uint64 updateTimestamp,uint64 nonce,string rewardsIpfsHash)"
]);
const osControllerAbi = new Interface([
  "function capacity() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function feePercent() view returns (uint64)",
  "function avgRewardPerSecond() view returns (uint256)"
]);
const osConfigAbi = new Interface([
  "function getConfig(address) view returns (uint128 liqBonusPercent,uint64 liqThresholdPercent,uint64 ltvPercent)"
]);
const tokenAbi = new Interface(["function totalSupply() view returns (uint256)"]);

function safeAddress(value) {
  try { return getAddress(value).toLowerCase(); } catch (_) { return null; }
}

function strictHex(value, bytes = null) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(value)) return null;
  if (bytes !== null && value.length !== 2 + bytes * 2) return null;
  return value.toLowerCase();
}

function strictQuantity(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u.test(value)) return null;
  try { return BigInt(value); } catch (_) { return null; }
}

function quantity(value) { return `0x${BigInt(value).toString(16)}`; }

function jsonValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]));
  return value;
}

function outputPathForRunId(runId) {
  return path.join(ROOT, ...OUTPUT_DIR_REL.split("/"), `${PREFIX}-${runId}.json`);
}

function parseRunTimestamp(value) {
  const match = RUN_ID_PATTERN.exec(value || "");
  if (!match) return null;
  const stamp = match[1];
  return Date.parse(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
}

function validateFreshRunId(runId, now = Date.now()) {
  const timestamp = parseRunTimestamp(runId);
  if (!Number.isFinite(timestamp)) throw new Error("RUN_ID_FORMAT_INVALID");
  if (timestamp > now + CAPS.maxRunIdFutureSkewMs || now - timestamp > CAPS.maxRunIdAgeMs) throw new Error("RUN_ID_NOT_FRESH");
  if (fs.existsSync(outputPathForRunId(runId))) throw new Error("RUN_ID_ALREADY_USED");
  return true;
}

function parseArgs(argv, now = Date.now()) {
  if (argv.length === 3 && argv[2] === "--check-only") return { checkOnly: true, capture: false, runId: null };
  if (argv.length === 5 && argv[2] === CAPTURE_FLAG && argv[3] === "--run-id") {
    validateFreshRunId(argv[4], now);
    return { checkOnly: false, capture: true, runId: argv[4] };
  }
  throw new Error("EXACT_CAPTURE_FLAG_AND_FRESH_RUN_ID_REQUIRED");
}

class Budget {
  constructor(caps = CAPS, now = () => Date.now()) {
    this.caps = caps;
    this.now = now;
    this.startedAt = now();
    this.total = 0;
    this.logs = 0;
    this.calls = 0;
    this.codes = 0;
    this.balances = 0;
    this.blocks = 0;
    this.logRows = 0;
    this.chunks = 0;
    this.responseBytes = 0;
    this.exhausted = null;
  }
  fail(reason) { this.exhausted = reason; throw new Error(`BUDGET_EXHAUSTED_${reason}`); }
  checkTime() { if (this.now() - this.startedAt > this.caps.maxElapsedMs) this.fail("TIME"); }
  consume(method) {
    if (!ALLOWED_METHODS.has(method) || FORBIDDEN_METHODS.has(method)) throw new Error("METHOD_FORBIDDEN");
    this.checkTime();
    this.total += 1;
    if (method === "eth_getLogs") this.logs += 1;
    if (method === "eth_call") this.calls += 1;
    if (method === "eth_getCode") this.codes += 1;
    if (method === "eth_getBalance") this.balances += 1;
    if (method === "eth_getBlockByNumber") this.blocks += 1;
    if (this.total > this.caps.maxTotalRequests) this.fail("TOTAL_REQUESTS");
    if (this.logs > this.caps.maxLogRequests) this.fail("LOG_REQUESTS");
    if (this.calls > this.caps.maxCallRequests) this.fail("CALL_REQUESTS");
    if (this.codes > this.caps.maxCodeRequests) this.fail("CODE_REQUESTS");
    if (this.balances > this.caps.maxBalanceRequests) this.fail("BALANCE_REQUESTS");
    if (this.blocks > this.caps.maxBlockRequests) this.fail("BLOCK_REQUESTS");
  }
  consumeResponse(bytes) { this.responseBytes += bytes; if (this.responseBytes > this.caps.maxAggregateResponseBytes) this.fail("RESPONSE_BYTES"); }
  consumeChunk() { this.chunks += 1; if (this.chunks > this.caps.maxChunks) this.fail("CHUNKS"); }
  consumeLog() { this.logRows += 1; if (this.logRows > this.caps.maxLogs) this.fail("LOG_ROWS"); }
  summary() {
    const elapsedWithinCap = this.now() - this.startedAt <= this.caps.maxElapsedMs;
    return { total: this.total, logs: this.logs, calls: this.calls, codes: this.codes, balances: this.balances,
      blocks: this.blocks, logRows: this.logRows, chunks: this.chunks, responseBytes: this.responseBytes,
      retries: 0, exhausted: this.exhausted, elapsedWithinCap, allWithinCaps: this.exhausted === null && elapsedWithinCap };
  }
}

async function readBody(response, context, controller) {
  if (!response.body || typeof response.body.getReader !== "function") throw new Error("STREAMING_BODY_REQUIRED");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const row = await reader.read();
    if (row.done) break;
    const bytes = Buffer.from(row.value);
    total += bytes.length;
    if (total > context.caps.maxResponseBytes) {
      controller.abort();
      await reader.cancel();
      context.budget.fail("SINGLE_RESPONSE_BYTES");
    }
    context.budget.consumeResponse(bytes.length);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function rpcRequest(target, method, params, context, fetchImpl = fetch) {
  if (!ALLOWED_METHODS.has(method) || FORBIDDEN_METHODS.has(method)) return { ok: false, error: "METHOD_FORBIDDEN", result: null };
  context.budget.consume(method);
  const requestId = ++context.nextId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.caps.requestTimeoutMs);
  try {
    const response = await fetchImpl(target.url, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }), signal: controller.signal });
    if (response.redirected || response.status < 200 || response.status >= 300) return { ok: false, error: "HTTP_FAILURE", result: null };
    const body = await readBody(response, context, controller);
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) { return { ok: false, error: "MALFORMED_JSON", result: null }; }
    if (!parsed || parsed.jsonrpc !== "2.0" || parsed.id !== requestId || Object.prototype.hasOwnProperty.call(parsed, "error") ||
      !Object.prototype.hasOwnProperty.call(parsed, "result")) return { ok: false, error: "RPC_ENVELOPE_INVALID", result: null };
    return { ok: true, error: null, result: parsed.result };
  } catch (error) {
    if (/^BUDGET_EXHAUSTED_/u.test(String(error.message || error))) throw error;
    return { ok: false, error: "TRANSPORT_FAILURE", result: null };
  } finally { clearTimeout(timer); }
}

function loadOfficialManifest() {
  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));
  const required = ["VaultsRegistry", "Keeper", "SharedMevEscrow", "OsToken", "OsTokenConfig", "OsTokenVaultController", ...FACTORY_KEYS];
  for (const key of required) if (!safeAddress(deployment[key])) throw new Error("OFFICIAL_MANIFEST_INVALID");
  return deployment;
}

function loadInventory() {
  const stat = fs.statSync(INVENTORY_PATH);
  if (stat.size > CAPS.maxInventoryBytes) throw new Error("INVENTORY_BYTES_EXCEEDED");
  const text = fs.readFileSync(INVENTORY_PATH, "utf8");
  const lines = text.split(/\r?\n/u);
  if (lines.length > CAPS.maxInventoryLines) throw new Error("INVENTORY_LINES_EXCEEDED");
  const seen = new Set();
  const rows = [];
  for (const line of lines) {
    const match = line.match(/https:\/\/[^\s'"<>\[\]]+/u);
    if (!match) continue;
    let parsed;
    try { parsed = new URL(match[0].replace(/[)\]]+$/u, "")); } catch (_) { continue; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || /sepolia|hoodi|gnosis|chiado|testnet/iu.test(parsed.href)) continue;
    const familyKey = parsed.hostname.toLowerCase();
    if (seen.has(familyKey) || seen.size >= CAPS.maxEndpointFamilies) continue;
    seen.add(familyKey);
    rows.push({ url: parsed.href, family: `F${seen.size}` });
    if (rows.length >= CAPS.maxInventoryEntries) break;
  }
  return rows;
}

function parseHeader(value) {
  const number = value && strictQuantity(value.number);
  const hash = value && strictHex(value.hash, 32);
  const timestamp = value && strictQuantity(value.timestamp);
  return number === null || !hash || timestamp === null ? null : { number, hash, timestamp };
}

function choosePin(observations) {
  const groups = new Map();
  for (const row of observations) {
    if (!row || row.chainId !== 1 || !row.header || row.header.number < BigInt(CAPS.minPlausiblePin) ||
      row.header.number > BigInt(CAPS.maxPlausiblePin)) continue;
    const key = `${row.header.number}:${row.header.hash}`;
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key).set(row.family, row);
  }
  const ranked = [...groups.values()].sort((left, right) => right.size - left.size ||
    (right.values().next().value.header.number > left.values().next().value.header.number ? 1 : -1));
  const best = ranked[0] ? [...ranked[0].values()].sort((a, b) => a.family.localeCompare(b.family)) : [];
  if (best.length === 0) return { mode: "UNAVAILABLE", promotable: false, rows: [], header: null, qualifiedFamilyCount: 0 };
  const promotable = best.length >= CAPS.minimumPromotableFamilies;
  return { mode: promotable ? "TWO_FAMILY_CONSENSUS" : "SINGLE_FAMILY_DIAGNOSTIC", promotable,
    rows: best.slice(0, promotable ? 2 : 1), header: best[0].header, qualifiedFamilyCount: best.length };
}

async function qualify(rows, context) {
  const observations = [];
  for (const row of rows) {
    const chain = await rpcRequest(row, "eth_chainId", [], context);
    if (!chain.ok || strictQuantity(chain.result) !== 1n) continue;
    const finalized = await rpcRequest(row, "eth_getBlockByNumber", ["finalized", false], context);
    const header = finalized.ok ? parseHeader(finalized.result) : null;
    if (header) observations.push({ ...row, chainId: 1, header });
  }
  return { attemptedFamilyCount: rows.length, qualifyingFamilyCount: observations.length, selected: choosePin(observations) };
}

function parseRpcLog(value, addresses, from, to) {
  const address = value && safeAddress(value.address);
  const blockNumber = value && strictQuantity(value.blockNumber);
  const transactionIndex = value && strictQuantity(value.transactionIndex);
  const logIndex = value && strictQuantity(value.logIndex);
  const blockHash = value && strictHex(value.blockHash, 32);
  const transactionHash = value && strictHex(value.transactionHash, 32);
  const data = value && strictHex(value.data);
  if (!address || !addresses.has(address) || blockNumber === null || blockNumber < from || blockNumber > to ||
    transactionIndex === null || logIndex === null || !blockHash || !transactionHash || !data || value.removed !== false ||
    !Array.isArray(value.topics) || !value.topics.every((topic) => strictHex(topic, 32))) throw new Error("LOG_INVALID");
  return { address, blockNumber, transactionIndex, logIndex, blockHash, transactionHash, data,
    topics: value.topics.map((topic) => topic.toLowerCase()) };
}

async function logsChunked(target, addresses, topics, pin, context) {
  if (pin + 1n > BigInt(CAPS.maxScanSpanBlocks)) throw new Error("SCAN_SPAN_EXCEEDED");
  const addressSet = new Set(addresses.map(safeAddress).filter(Boolean));
  const output = [];
  for (let start = 0n; start <= pin; start += BigInt(CAPS.maxLogChunkBlocks)) {
    context.budget.consumeChunk();
    const end = start + BigInt(CAPS.maxLogChunkBlocks - 1) > pin ? pin : start + BigInt(CAPS.maxLogChunkBlocks - 1);
    const response = await rpcRequest(target, "eth_getLogs", [{ address: [...addressSet], topics,
      fromBlock: quantity(start), toBlock: quantity(end) }], context);
    if (!response.ok || !Array.isArray(response.result)) throw new Error("LOG_SCAN_INCOMPLETE");
    for (const raw of response.result) { output.push(parseRpcLog(raw, addressSet, start, end)); context.budget.consumeLog(); }
  }
  return output;
}

async function call(target, address, abi, fragment, args, pin, context) {
  const data = abi.encodeFunctionData(fragment, args || []);
  const response = await rpcRequest(target, "eth_call", [{ to: address, data }, quantity(pin)], context);
  if (!response.ok || !strictHex(response.result)) return null;
  try { return abi.decodeFunctionResult(fragment, response.result); } catch (_) { return null; }
}

async function codePresent(target, address, pin, context) {
  const response = await rpcRequest(target, "eth_getCode", [address, quantity(pin)], context);
  const code = response.ok ? strictHex(response.result) : null;
  return code === null ? null : code !== "0x";
}

async function nativeBalance(target, address, pin, context) {
  const response = await rpcRequest(target, "eth_getBalance", [address, quantity(pin)], context);
  return response.ok ? strictQuantity(response.result) : null;
}

function valueAt(decoded, index, type = "bigint") {
  if (!decoded) return null;
  try {
    if (type === "address") return safeAddress(decoded[index]);
    if (type === "bool") return Boolean(decoded[index]);
    if (type === "number") return Number(decoded[index]);
    if (type === "hex32") return strictHex(decoded[index], 32);
    return BigInt(decoded[index]);
  } catch (_) { return null; }
}

function versionClass(version) {
  if (version === 5) return "V5";
  if (version === 6) return "V6";
  if (version === 7) return "V7";
  return "UNKNOWN";
}

function factoryClassification(factoryKey) {
  return FACTORY_CLASS[factoryKey] || { access: "UNKNOWN", meta: null, assetMode: "UNKNOWN" };
}

function parseRewardsUpdated(logs) {
  const parsed = [];
  for (const log of logs) {
    let event;
    try { event = keeperAbi.parseLog({ topics: log.topics, data: log.data }); } catch (_) { throw new Error("REWARDS_EVENT_INVALID"); }
    if (!event || event.name !== "RewardsUpdated") continue;
    const cid = String(event.args.rewardsIpfsHash);
    parsed.push({ blockNumber: log.blockNumber, root: String(event.args.rewardsRoot).toLowerCase(),
      avgRewardPerSecond: BigInt(event.args.avgRewardPerSecond), updateTimestamp: BigInt(event.args.updateTimestamp),
      nonce: BigInt(event.args.nonce), cid: /^[A-Za-z0-9]+$/u.test(cid) && cid.length <= 128 ? cid : null });
  }
  parsed.sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0);
  return parsed.length ? parsed[parsed.length - 1] : null;
}

function strictProofRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const vault = safeAddress(row.vault);
  if (!vault || !/^-?\d+$/u.test(String(row.reward)) || !/^\d+$/u.test(String(row.unlockedMevReward)) ||
    !Array.isArray(row.proof) || !row.proof.every((item) => strictHex(item, 32))) return null;
  return { vault, reward: BigInt(row.reward), unlockedMevReward: BigInt(row.unlockedMevReward),
    proof: row.proof.map((item) => item.toLowerCase()) };
}

function parseRewardsDataset(value, expectedRoot, discoveredVaults) {
  if (!value || typeof value !== "object" || Array.isArray(value) || strictHex(value.rewardsRoot, 32) !== strictHex(expectedRoot, 32) ||
    !Array.isArray(value.rewards)) return { available: false, reason: "UNSUPPORTED_OR_ROOT_MISMATCH", rows: new Map() };
  const wanted = new Set(discoveredVaults.map(safeAddress).filter(Boolean));
  const rows = new Map();
  for (const raw of value.rewards) {
    const row = strictProofRow(raw);
    if (!row) return { available: false, reason: "ROW_SCHEMA_INVALID", rows: new Map() };
    if (wanted.has(row.vault)) rows.set(row.vault, row);
  }
  return { available: true, reason: null, rows };
}

function computeEconomics(vault, proofRow, sweepBps = CAPS.depositSweepBps) {
  const preconditions = {
    proofRewardResidualKnown: proofRow !== null && proofRow !== undefined,
    publicAccess: vault.access === "PUBLIC" ? true : vault.access ? false : null,
    reportedVersion5: vault.versionClass === "V5" ? true : vault.versionClass ? false : null,
    vaultRegistryMember: vault.registryMember,
    implementationRegistryMember: vault.implementationRegistryMember,
    oneRewardNonceBehindByKeeperPredicates: vault.canHarvest === null || vault.isHarvestRequired === null
      ? null : vault.canHarvest === true && vault.isHarvestRequired === false,
    stateUpdateRequired: vault.stateUpdateRequired,
    capacityAvailable: vault.capacity !== null && vault.totalAssets !== null ? vault.capacity > vault.totalAssets : null,
    queueReadable: vault.queue === null || vault.queue === undefined ? null : true,
    withdrawableAssetsReadable: vault.withdrawableAssets !== null && vault.withdrawableAssets !== undefined,
    mevEscrowBalanceReadable: vault.mevEscrowBalance !== null && vault.mevEscrowBalance !== undefined
  };
  const unknown = { proofRewardResidualKnown: false, positiveRewardResidual: null, netRewardResidual: null,
    capacityResidual: vault.capacity !== null && vault.totalAssets !== null ? (vault.capacity > vault.totalAssets ? vault.capacity - vault.totalAssets : 0n) : null,
    sweep: [], preconditions, routePositive: null, executableNow: null };
  if (!proofRow || vault.rewardAssets === null || vault.unlockedMevAssets === null || vault.feePercent === null ||
    vault.totalAssets === null || vault.capacity === null || vault.feePercent < 0n || vault.feePercent > 10000n) return unknown;
  const residual = proofRow.reward - vault.rewardAssets + proofRow.unlockedMevReward - vault.unlockedMevAssets;
  const positive = residual > 0n ? residual : 0n;
  const unlockedResidual = proofRow.unlockedMevReward > vault.unlockedMevAssets
    ? proofRow.unlockedMevReward - vault.unlockedMevAssets : 0n;
  const net = positive * (10000n - vault.feePercent) / 10000n;
  const capacityResidual = vault.capacity > vault.totalAssets ? vault.capacity - vault.totalAssets : 0n;
  const sweep = sweepBps.map((bps) => {
    const deposit = capacityResidual * BigInt(bps) / 10000n;
    const denominator = vault.totalAssets + deposit;
    return { capacityBps: bps, deposit, feeBps: vault.feePercent,
      gainUpperBound: denominator === 0n ? null : deposit * net / denominator };
  });
  const exactGates = vault.access === "PUBLIC" && vault.versionClass === "V5" && vault.registryMember === true &&
    vault.implementationRegistryMember === true && vault.canHarvest === true && vault.isHarvestRequired === false &&
    vault.stateUpdateRequired === true && vault.queue !== null && vault.queue !== undefined &&
    vault.withdrawableAssets !== null && vault.withdrawableAssets !== undefined && vault.mevEscrowBalance !== null && capacityResidual > 0n;
  preconditions.unlockedMevLiquiditySufficient = vault.mevEscrowBalance === null || vault.mevEscrowBalance === undefined
    ? null : vault.mevEscrowBalance >= unlockedResidual;
  return { proofRewardResidualKnown: true, positiveRewardResidual: positive, netRewardResidual: net, capacityResidual, sweep,
    preconditions,
    routePositive: exactGates ? sweep.some((row) => row.gainUpperBound !== null && row.gainUpperBound > 0n) : null,
    executableNow: exactGates ? preconditions.unlockedMevLiquiditySufficient : null };
}

async function readGlobal(target, deployment, pin, context) {
  const keeper = safeAddress(deployment.Keeper);
  const controller = safeAddress(deployment.OsTokenVaultController);
  const config = safeAddress(deployment.OsTokenConfig);
  const token = safeAddress(deployment.OsToken);
  const [nonce, root, prevRoot, lastTimestamp, controllerCapacity, controllerAssets, controllerShares, controllerFee,
    avgReward, tokenSupply, defaultConfig, sharedBalance, redeemerBalance] = await Promise.all([
      call(target, keeper, keeperAbi, "rewardsNonce", [], pin, context),
      call(target, keeper, keeperAbi, "rewardsRoot", [], pin, context),
      call(target, keeper, keeperAbi, "prevRewardsRoot", [], pin, context),
      call(target, keeper, keeperAbi, "lastRewardsTimestamp", [], pin, context),
      call(target, controller, osControllerAbi, "capacity", [], pin, context),
      call(target, controller, osControllerAbi, "totalAssets", [], pin, context),
      call(target, controller, osControllerAbi, "totalShares", [], pin, context),
      call(target, controller, osControllerAbi, "feePercent", [], pin, context),
      call(target, controller, osControllerAbi, "avgRewardPerSecond", [], pin, context),
      call(target, token, tokenAbi, "totalSupply", [], pin, context),
      call(target, config, osConfigAbi, "getConfig", ["0x0000000000000000000000000000000000000000"], pin, context),
      nativeBalance(target, safeAddress(deployment.SharedMevEscrow), pin, context),
      nativeBalance(target, safeAddress(deployment.OsTokenRedeemer), pin, context)
    ]);
  return {
    keeper: { address: keeper, rewardsNonce: valueAt(nonce, 0), rewardsRoot: valueAt(root, 0, "hex32"),
      prevRewardsRoot: valueAt(prevRoot, 0, "hex32"), lastRewardsTimestamp: valueAt(lastTimestamp, 0) },
    osToken: { tokenAddress: token, configAddress: config, controllerAddress: controller,
      controllerCapacity: valueAt(controllerCapacity, 0), controllerTotalAssets: valueAt(controllerAssets, 0),
      controllerTotalShares: valueAt(controllerShares, 0), controllerFeePercent: valueAt(controllerFee, 0),
      avgRewardPerSecond: valueAt(avgReward, 0), totalSupply: valueAt(tokenSupply, 0),
      defaultConfig: defaultConfig ? { liqBonusPercent: valueAt(defaultConfig, 0), liqThresholdPercent: valueAt(defaultConfig, 1),
        ltvPercent: valueAt(defaultConfig, 2) } : null,
      liquiditySignals: { sharedMevEscrowAddress: safeAddress(deployment.SharedMevEscrow),
        sharedMevEscrowNativeBalance: sharedBalance, osTokenRedeemerAddress: safeAddress(deployment.OsTokenRedeemer),
        osTokenRedeemerNativeBalance: redeemerBalance, dexQuote: null, dexQuoteStatus: "NOT_REQUESTED_SEPARATE_CAPTURE" } }
  };
}

async function readVault(target, deployment, vault, classification, pin, context) {
  const registry = safeAddress(deployment.VaultsRegistry);
  const keeper = safeAddress(deployment.Keeper);
  const config = safeAddress(deployment.OsTokenConfig);
  const [member, implementationRaw, versionRaw, idRaw, capacityRaw, feeRaw, assetsRaw, sharesRaw, queueRaw,
    withdrawableRaw, updateRaw, escrowRaw, rewardRaw, unlockedRaw, canHarvestRaw, requiredRaw, collateralizedRaw, osConfigRaw,
    vaultCode] = await Promise.all([
      call(target, registry, registryAbi, "vaults", [vault], pin, context),
      call(target, vault, vaultAbi, "implementation", [], pin, context),
      call(target, vault, vaultAbi, "version", [], pin, context),
      call(target, vault, vaultAbi, "vaultId", [], pin, context),
      call(target, vault, vaultAbi, "capacity", [], pin, context),
      call(target, vault, vaultAbi, "feePercent", [], pin, context),
      call(target, vault, vaultAbi, "totalAssets", [], pin, context),
      call(target, vault, vaultAbi, "totalShares", [], pin, context),
      call(target, vault, vaultAbi, "getExitQueueData", [], pin, context),
      call(target, vault, vaultAbi, "withdrawableAssets", [], pin, context),
      call(target, vault, vaultAbi, "isStateUpdateRequired", [], pin, context),
      call(target, vault, vaultAbi, "mevEscrow", [], pin, context),
      call(target, keeper, keeperAbi, "rewards", [vault], pin, context),
      call(target, keeper, keeperAbi, "unlockedMevRewards", [vault], pin, context),
      call(target, keeper, keeperAbi, "canHarvest", [vault], pin, context),
      call(target, keeper, keeperAbi, "isHarvestRequired", [vault], pin, context),
      call(target, keeper, keeperAbi, "isCollateralized", [vault], pin, context),
      call(target, config, osConfigAbi, "getConfig", [vault], pin, context),
      codePresent(target, vault, pin, context)
    ]);
  const implementation = valueAt(implementationRaw, 0, "address");
  const [implementationMember, implementationCode] = implementation ? await Promise.all([
    call(target, registry, registryAbi, "vaultImpls", [implementation], pin, context), codePresent(target, implementation, pin, context)
  ]) : [null, null];
  const escrow = valueAt(escrowRaw, 0, "address");
  const escrowBalance = escrow ? await nativeBalance(target, escrow, pin, context) : null;
  const version = valueAt(versionRaw, 0, "number");
  return {
    address: vault,
    factoryAddress: classification.factoryAddress || null,
    factoryKey: classification.factoryKey || null,
    access: classification.access,
    meta: classification.meta,
    assetMode: classification.assetMode,
    directType: classification.directType || null,
    registryMember: valueAt(member, 0, "bool"),
    codePresent: vaultCode,
    implementation,
    implementationCodePresent: implementationCode,
    implementationRegistryMember: valueAt(implementationMember, 0, "bool"),
    version,
    versionClass: versionClass(version),
    vaultId: valueAt(idRaw, 0, "hex32"),
    capacity: valueAt(capacityRaw, 0),
    feePercent: valueAt(feeRaw, 0),
    totalAssets: valueAt(assetsRaw, 0),
    totalShares: valueAt(sharesRaw, 0),
    queue: queueRaw ? { queuedShares: valueAt(queueRaw, 0), unclaimedAssets: valueAt(queueRaw, 1),
      totalExitingTickets: valueAt(queueRaw, 2), totalExitingAssets: valueAt(queueRaw, 3), totalTickets: valueAt(queueRaw, 4) } : null,
    withdrawableAssets: valueAt(withdrawableRaw, 0),
    stateUpdateRequired: valueAt(updateRaw, 0, "bool"),
    mevEscrow: escrow,
    mevEscrowBalance: escrowBalance,
    keeperRewardsNonce: valueAt(rewardRaw, 1),
    rewardAssets: valueAt(rewardRaw, 0),
    unlockedMevNonce: valueAt(unlockedRaw, 1),
    unlockedMevAssets: valueAt(unlockedRaw, 0),
    canHarvest: valueAt(canHarvestRaw, 0, "bool"),
    isHarvestRequired: valueAt(requiredRaw, 0, "bool"),
    collateralized: valueAt(collateralizedRaw, 0, "bool"),
    osTokenConfig: osConfigRaw ? { liqBonusPercent: valueAt(osConfigRaw, 0), liqThresholdPercent: valueAt(osConfigRaw, 1),
      ltvPercent: valueAt(osConfigRaw, 2) } : null
  };
}

function exactComparable(value) { return osToken.canonicalJson(jsonValue(value)); }

async function discoverAndRead(target, deployment, pin, context) {
  const registry = safeAddress(deployment.VaultsRegistry);
  const registryTopics = [[id("FactoryAdded(address)"), id("FactoryRemoved(address)"), id("VaultAdded(address,address)"),
    id("VaultImplAdded(address)"), id("VaultImplRemoved(address)")]];
  const registryLogs = await logsChunked(target, [registry], registryTopics, pin, context);
  const registryDiscovery = step2.parseRegistryDiscovery(registryLogs);
  if (registryDiscovery.malformed !== 0) throw new Error("REGISTRY_EVENT_DECODE_FAILED");
  const keyByFactory = new Map(FACTORY_KEYS.map((key) => [safeAddress(deployment[key]), key]));
  const factories = new Set([...keyByFactory.keys(), ...registryDiscovery.factories].filter(Boolean));
  if (factories.size > CAPS.maxFactories) throw new Error("FACTORY_CAP_EXCEEDED");
  const activeFactories = [];
  for (const factory of factories) {
    const current = await call(target, registry, registryAbi, "factories", [factory], pin, context);
    if (valueAt(current, 0, "bool") === true) activeFactories.push(factory);
  }
  const factoryLogs = [];
  for (let offset = 0; offset < factories.size; offset += CAPS.maxAddressBatch) {
    const batch = [...factories].slice(offset, offset + CAPS.maxAddressBatch);
    factoryLogs.push(...await logsChunked(target, batch, [[id("VaultCreated(address,address,address,bytes)"),
      id("MetaVaultCreated(address,address,address,bytes)")]], pin, context));
  }
  const created = step2.parseFactoryVaults(factoryLogs);
  if (created.malformed !== 0) throw new Error("FACTORY_EVENT_DECODE_FAILED");
  const directByAddress = new Map(DIRECT_VAULT_KEYS.map((key) => [safeAddress(deployment[key]), { ...DIRECT_CLASS[key] }]));
  const candidates = new Set([...registryDiscovery.vaults, ...created.vaults, ...directByAddress.keys()].filter(Boolean));
  if (candidates.size > CAPS.maxVaults) throw new Error("VAULT_CAP_EXCEEDED");
  const current = [];
  for (const vault of candidates) {
    const member = await call(target, registry, registryAbi, "vaults", [vault], pin, context);
    if (valueAt(member, 0, "bool") === true) current.push(vault);
  }
  const vaults = [];
  for (const vault of current) {
    const factoryAddress = created.lineage.get(vault) || null;
    const factoryKey = factoryAddress ? keyByFactory.get(factoryAddress) || null : null;
    const classification = directByAddress.get(vault) || { ...factoryClassification(factoryKey), factoryAddress, factoryKey };
    if (!classification.factoryAddress && factoryAddress) classification.factoryAddress = factoryAddress;
    if (!classification.factoryKey && factoryKey) classification.factoryKey = factoryKey;
    vaults.push(await readVault(target, deployment, vault, classification, pin, context));
  }
  const rewardsLogs = await logsChunked(target, [safeAddress(deployment.Keeper)], [[id("RewardsUpdated(address,bytes32,uint256,uint64,uint64,string)")]], pin, context);
  const latestRewardsEvent = parseRewardsUpdated(rewardsLogs);
  const global = await readGlobal(target, deployment, pin, context);
  return { discovery: { officialManifestFactoryCount: FACTORY_KEYS.length, historicalFactoryCount: factories.size,
    currentFactoryCount: activeFactories.length, candidateVaultCount: candidates.size, currentVaultCount: current.length,
    registryEventCount: registryLogs.length, factoryCreationEventCount: factoryLogs.length }, global, latestRewardsEvent, vaults };
}

async function terminalCheck(rows, expected, context) {
  for (const row of rows) {
    const response = await rpcRequest(row, "eth_getBlockByNumber", [quantity(expected.number), false], context);
    const observed = response.ok ? parseHeader(response.result) : null;
    if (!observed || observed.number !== expected.number || observed.hash !== expected.hash) return false;
  }
  return true;
}

function sanitizeOutput(value) {
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (/^(?:url|endpoint|endpointUrl|endpointHash|provider|providerHash|hostname|domain|headers|rawResponse|requestBody)$/iu.test(key)) {
        throw new Error("ENDPOINT_MATERIAL_IN_OUTPUT");
      }
      if (typeof child === "string" && /(?:https?|wss?):\/\//iu.test(child)) throw new Error("URL_IN_OUTPUT");
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return value;
}

function atomicWrite(outputPath, value) {
  const bytes = Buffer.from(`${JSON.stringify(jsonValue(sanitizeOutput(value)), null, 2)}\n`, "utf8");
  if (bytes.length > CAPS.maxOutputBytes) throw new Error("OUTPUT_BYTES_EXCEEDED");
  const temporary = `${outputPath}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, "wx");
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    fs.linkSync(temporary, outputPath);
    fs.unlinkSync(temporary);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function dryPreflight() {
  return {
    schemaVersion: 1,
    findingId: FINDING_ID,
    status: "PREPARED_STANDING_DEFENSIVE_AUTH_NOT_EXECUTED",
    scope: { chain: "ethereum-mainnet", chainId: 1, chains: 1 },
    invocation: { exactCaptureFlag: CAPTURE_FLAG, runIdFormat: "swv3econ-YYYYMMDDTHHMMSSZ-32lowerhex",
      freshRunIdRequired: true, outputTemplate: `${OUTPUT_DIR_REL}/${PREFIX}-<run-id>.json`, approvalArtifactConsumed: false,
      priorCaptureOutputConsumed: false, retryPolicy: "NONE" },
    inventory: { file: "rpc_endpoints.txt", onlyEndpointInventoryRead: true, processOnly: true,
      materialPersisted: false, readDuringCheckOnly: false },
    methods: { allowed: [...ALLOWED_METHODS].sort(), forbidden: [...FORBIDDEN_METHODS].sort() },
    consensus: { twoFamilyPromotable: true, singleFamilyDiagnosticAllowed: true, singleFamilyPromotable: false,
      backendIndependenceProven: false },
    dataset: { rewardsEventCidAndRootCaptured: true, publicGetEnabled: false,
      statusWhenNotFetched: "UNAVAILABLE_GATEWAY_NOT_ROBUSTLY_BOUND", parserAvailableForStrictOfflineFixtures: true },
    gates: { routePositive: null, executableNow: null, signedActionJustified: false, fork: false },
    caps: CAPS,
    networkReads: 0,
    inventoryReads: 0,
    writes: 0
  };
}

function failureResult(runId, reasonCode, budget, qualification = null) {
  return { schemaVersion: 1, findingId: FINDING_ID, runId, status: "TERMINAL_NONPROMOTABLE_CAPTURE",
    reasonCode, chain: { chainId: 1, name: "ethereum-mainnet" }, qualification,
    promotable: false, dataset: { status: "UNAVAILABLE", publicGetPerformed: false },
    gates: { routePositive: null, executableNow: null, signedActionJustified: false, fork: false }, budget,
    retryAllowed: false, terminal: true };
}

async function runCapture(args, dependencies = {}) {
  const context = { caps: dependencies.caps || CAPS, budget: new Budget(dependencies.caps || CAPS, dependencies.now || (() => Date.now())), nextId: 0 };
  const outputPath = dependencies.outputPath || outputPathForRunId(args.runId);
  let result;
  let qualification = null;
  try {
    const deployment = (dependencies.loadManifest || loadOfficialManifest)();
    const inventory = (dependencies.loadInventory || loadInventory)();
    qualification = await (dependencies.qualify || qualify)(inventory, context);
    const selected = qualification.selected;
    if (!selected || selected.mode === "UNAVAILABLE") throw new Error("NO_CHAIN1_FINALIZED_ENDPOINT");
    const captures = [];
    for (const row of selected.rows) captures.push(await (dependencies.captureFamily || discoverAndRead)(row, deployment, selected.header.number, context));
    const familyAgreement = captures.length === 2 ? exactComparable(captures[0]) === exactComparable(captures[1]) : null;
    const terminal = await (dependencies.terminalCheck || terminalCheck)(selected.rows, selected.header, context);
    const promotable = selected.promotable && familyAgreement === true && terminal === true;
    const capture = captures[0];
    const proofDataset = { status: "UNAVAILABLE_GATEWAY_NOT_ROBUSTLY_BOUND", publicGetPerformed: false,
      latestEventMetadataAvailable: capture.latestRewardsEvent !== null, matchedProofRows: 0 };
    for (const vault of capture.vaults) vault.economics = computeEconomics(vault, null);
    result = {
      schemaVersion: 1, findingId: FINDING_ID, runId: args.runId,
      status: promotable ? "TERMINAL_PROMOTABLE_TWO_FAMILY_CAPTURE" : "TERMINAL_NONPROMOTABLE_DIAGNOSTIC_CAPTURE",
      reasonCode: promotable ? null : selected.promotable ? "FAMILY_STATE_OR_TERMINAL_MISMATCH" : "SINGLE_FAMILY_ONLY",
      chain: { chainId: 1, name: "ethereum-mainnet", finalizedBlockNumber: selected.header.number },
      qualification: { attemptedFamilyCount: qualification.attemptedFamilyCount,
        qualifyingFamilyCount: qualification.qualifyingFamilyCount, selectedFamilyCount: selected.rows.length,
        mode: selected.mode, twoFamilyConsensus: selected.promotable, familyStateAgreement: familyAgreement,
        terminalPinRecheck: terminal, backendIndependenceProven: false },
      promotable,
      discovery: capture.discovery,
      keeperAndOsToken: capture.global,
      latestRewardsUpdated: capture.latestRewardsEvent,
      dataset: proofDataset,
      vaults: capture.vaults,
      economics: { formula: "floor(D*Rnet/(A+D))", computedVaultCount: 0,
        unavailableVaultCount: capture.vaults.length, proofResidualRequired: true,
        routePositive: null, executableNow: null },
      gates: { routePositive: null, executableNow: null, signedActionJustified: false, fork: false },
      persistence: { publicContractAddresses: true, endpointMaterial: false, rawResponses: false, transactionData: false },
      budget: context.budget.summary(), retryAllowed: false, terminal: true
    };
  } catch (error) {
    result = failureResult(args.runId, /^[A-Z0-9_]{3,96}$/u.test(String(error.message || error)) ? String(error.message || error) :
      "CAPTURE_FAILED", context.budget.summary(), qualification ? { attemptedFamilyCount: qualification.attemptedFamilyCount,
        qualifyingFamilyCount: qualification.qualifyingFamilyCount } : null);
  }
  if (!context.budget.summary().allWithinCaps) result = failureResult(args.runId, "BUDGET_NOT_WITHIN_CAPS", context.budget.summary());
  (dependencies.writeOutput || atomicWrite)(outputPath, result);
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.checkOnly) { process.stdout.write(`${JSON.stringify(dryPreflight(), null, 2)}\n`); return; }
  const result = await runCapture(args);
  process.stdout.write(`${JSON.stringify({ status: result.status, runId: result.runId, terminal: true,
    promotable: result.promotable, routePositive: null, executableNow: null, retryAllowed: false })}\n`);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });

module.exports = {
  ALLOWED_METHODS, FORBIDDEN_METHODS, CAPS, CAPTURE_FLAG, FINDING_ID, PREFIX, PREFLIGHT_REL, MANIFEST_REL, REPORT_REL,
  FIXTURE_REL, FACTORY_KEYS, FACTORY_CLASS, RUN_ID_PATTERN, Budget, atomicWrite, choosePin, computeEconomics,
  dryPreflight, factoryClassification, jsonValue, loadInventory, outputPathForRunId, parseArgs, parseRewardsDataset,
  parseRewardsUpdated, rpcRequest, runCapture, sanitizeOutput, validateFreshRunId, versionClass,
  reused: { step2, osToken }
};
