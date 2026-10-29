#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  AbiCoder, Interface, concat, getAddress, id, keccak256, version: ethersVersion
} = require("ethers");
const step2 = require("./critical-stakewise-v3-eth-exitqueue-step2-runner.js");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY_PATH = path.join(ROOT, "rpc_endpoints.txt");
const PREFIX = "critical-stakewise-v3-mainnet-deployment-economics-successor-r6";
const FINDING_ID = "stakewise-v3-current-deployment-state-diagnostic-r6";
const CAPTURE_FLAG = "--capture-stakewise-mainnet-r6-once";
const RUN_ID_PATTERN = /^swv3diag6-(\d{8}T\d{6}Z)-([0-9a-f]{32})$/u;
const OUTPUT_DIR_REL = "reports/raw/fast";
const PREFLIGHT_REL = `${OUTPUT_DIR_REL}/${PREFIX}-preflight.json`;
const MANIFEST_REL = `${OUTPUT_DIR_REL}/${PREFIX}-manifest.json`;
const REPORT_REL = `reports/${PREFIX}.md`;
const FIXTURE_REL = `tools/fixtures/${PREFIX}-fixtures.json`;
const CHAIN_ID = 1;
const ZERO = "0x0000000000000000000000000000000000000000";
const INT160_MIN = -(1n << 159n);
const INT160_MAX = (1n << 159n) - 1n;
const UINT160_MAX = (1n << 160n) - 1n;
const NULL_CONCLUSIONS = Object.freeze({ economics: null, applicability: null, capacitySweeps: null,
  exactAffectedSemantics: null });
const REQUIRED_ARTIFACT_PATHS = Object.freeze([
  "tools/critical-stakewise-v3-mainnet-deployment-economics-successor-r6-runner.js",
  "tools/test-critical-stakewise-v3-mainnet-deployment-economics-successor-r6.js",
  "tools/validate-critical-stakewise-v3-mainnet-deployment-economics-successor-r6.js",
  "tools/fixtures/critical-stakewise-v3-mainnet-deployment-economics-successor-r6-fixtures.json",
  "reports/critical-stakewise-v3-mainnet-deployment-economics-successor-r6.md",
  "reports/raw/fast/critical-stakewise-v3-mainnet-deployment-economics-successor-r6-preflight.json"
]);
const LOCAL_INPUT_RELS = Object.freeze([
  "targets/stakewise-v3-core-v5.0.1/deployments/mainnet.json",
  "tools/package.json", "tools/package-lock.json",
  "tools/critical-stakewise-v3-eth-exitqueue-step2-runner.js",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IVaultsRegistry.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IEthVaultFactory.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IEthMetaVaultFactory.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IVaultVersion.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IVaultState.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IVaultFee.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IVaultEnterExit.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IVaultMev.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IKeeper.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IEthMetaVault.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IEthErc20MetaVault.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/ISubVaultsRegistry.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IOsTokenConfig.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IOsTokenVaultController.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IOsToken.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IOsTokenRedeemer.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/vaults/ethereum/EthGenesisVault.sol"
]);

const ALLOWED_METHODS = new Set([
  "eth_call", "eth_chainId", "eth_getBalance", "eth_getBlockByNumber", "eth_getCode", "eth_getLogs"
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
  minimumConsensusFamilies: 2,
  maxFactories: 32,
  maxVaults: 1000,
  maxSubVaultsPerMeta: 50,
  maxAddressBatch: 64,
  maxLogChunkBlocks: 50000,
  maxScanSpanBlocks: 32000000,
  maxChunks: 4096,
  maxLogs: 100000,
  maxTreeNodes: 200000,
  maxTreeValues: 100000,
  maxTotalRequests: 65000,
  maxLogRequests: 5000,
  maxCallRequests: 45000,
  maxCodeRequests: 7000,
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
  maxPublicDatasetGets: 1,
  maxPublicDatasetBytes: 4194304,
  publicDatasetTimeoutMs: 10000
});

const FACTORY_KEYS = Object.freeze([
  "VaultFactory", "PrivVaultFactory", "MetaVaultFactory", "PrivMetaVaultFactory", "BlocklistVaultFactory",
  "Erc20VaultFactory", "PrivErc20VaultFactory", "Erc20MetaVaultFactory", "PrivErc20MetaVaultFactory",
  "BlocklistErc20VaultFactory"
]);
const DIRECT_VAULT_KEYS = Object.freeze(["CommunityVault", "FoxVault", "GenesisVault"]);
const ROLE_KEYS = Object.freeze([
  "VaultsRegistry", "Keeper", "SharedMevEscrow", "OsToken", "OsTokenConfig", "OsTokenVaultController",
  "OsTokenRedeemer", "LegacyPoolEscrow", ...FACTORY_KEYS, ...DIRECT_VAULT_KEYS
]);

const TRUSTED_IDS = Object.freeze({
  EthVault: { access: "PUBLIC", meta: false, assetMode: "NATIVE_ETH", factoryKey: "VaultFactory", ownMevUnsupported: false },
  EthPrivVault: { access: "PRIVATE", meta: false, assetMode: "NATIVE_ETH", factoryKey: "PrivVaultFactory", ownMevUnsupported: false },
  EthMetaVault: { access: "PUBLIC", meta: true, assetMode: "NATIVE_ETH", factoryKey: "MetaVaultFactory", ownMevUnsupported: false },
  EthPrivMetaVault: { access: "PRIVATE", meta: true, assetMode: "NATIVE_ETH", factoryKey: "PrivMetaVaultFactory", ownMevUnsupported: false },
  EthBlocklistVault: { access: "BLOCKLIST", meta: false, assetMode: "NATIVE_ETH", factoryKey: "BlocklistVaultFactory", ownMevUnsupported: false },
  EthErc20Vault: { access: "PUBLIC", meta: false, assetMode: "ERC20", factoryKey: "Erc20VaultFactory", ownMevUnsupported: false },
  EthPrivErc20Vault: { access: "PRIVATE", meta: false, assetMode: "ERC20", factoryKey: "PrivErc20VaultFactory", ownMevUnsupported: false },
  EthErc20MetaVault: { access: "PUBLIC", meta: true, assetMode: "ERC20", factoryKey: "Erc20MetaVaultFactory", ownMevUnsupported: false },
  EthPrivErc20MetaVault: { access: "PRIVATE", meta: true, assetMode: "ERC20", factoryKey: "PrivErc20MetaVaultFactory", ownMevUnsupported: false },
  EthBlocklistErc20Vault: { access: "BLOCKLIST", meta: false, assetMode: "ERC20", factoryKey: "BlocklistErc20VaultFactory", ownMevUnsupported: false },
  EthFoxVault: { access: "BLOCKLIST", meta: false, assetMode: "NATIVE_ETH", directKey: "FoxVault", ownMevUnsupported: true },
  EthCommunityVault: { access: "PUBLIC", meta: false, assetMode: "ERC20", directKey: "CommunityVault", ownMevUnsupported: false },
  EthGenesisVault: { access: "PUBLIC", meta: false, assetMode: "NATIVE_ETH", directKey: "GenesisVault", ownMevUnsupported: false }
});
const TRUSTED_ID_BY_HASH = new Map(Object.entries(TRUSTED_IDS).map(([name, value]) => [id(name).toLowerCase(), { name, ...value }]));

const registryAbi = new Interface([
  "function vaults(address) view returns (bool)", "function vaultImpls(address) view returns (bool)",
  "function factories(address) view returns (bool)", "event FactoryAdded(address indexed factory)",
  "event FactoryRemoved(address indexed factory)", "event VaultAdded(address indexed caller,address indexed vault)",
  "event VaultImplAdded(address indexed impl)", "event VaultImplRemoved(address indexed impl)"
]);
const factoryAbi = new Interface([
  "function implementation() view returns (address)",
  "event VaultCreated(address indexed admin,address indexed vault,address ownMevEscrow,bytes params)",
  "event MetaVaultCreated(address indexed caller,address indexed admin,address indexed vault,bytes params)"
]);
const vaultAbi = new Interface([
  "function implementation() view returns (address)", "function version() view returns (uint8)",
  "function vaultId() view returns (bytes32)", "function capacity() view returns (uint256)",
  "function feePercent() view returns (uint16)", "function totalAssets() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function getShares(address) view returns (uint256)",
  "function getExitQueueData() view returns (uint128,uint128,uint128,uint128,uint256)",
  "function withdrawableAssets() view returns (uint256)", "function isStateUpdateRequired() view returns (bool)",
  "function mevEscrow() view returns (address)"
]);
const metaVaultAbi = new Interface(["function subVaultsRegistry() view returns (address)"]);
const subVaultsAbi = new Interface([
  "function metaVault() view returns (address)", "function getSubVaults() view returns (address[])",
  "function subVaultsRewardsNonce() view returns (uint128)", "function subVaultsTotalAssets() view returns (uint128)",
  "function isStateUpdateRequired() view returns (bool)", "function isCollateralized() view returns (bool)",
  "function subVaultsStates(address) view returns (uint128 stakedShares,uint128 queuedShares)"
]);
const keeperAbi = new Interface([
  "function rewardsNonce() view returns (uint64)", "function rewards(address) view returns (int192 assets,uint64 nonce)",
  "function unlockedMevRewards(address) view returns (uint192 assets,uint64 nonce)",
  "function canHarvest(address) view returns (bool)", "function isHarvestRequired(address) view returns (bool)",
  "function isCollateralized(address) view returns (bool)", "function rewardsRoot() view returns (bytes32)",
  "function prevRewardsRoot() view returns (bytes32)", "function lastRewardsTimestamp() view returns (uint64)",
  "event RewardsUpdated(address indexed caller,bytes32 indexed rewardsRoot,uint256 avgRewardPerSecond,uint64 updateTimestamp,uint64 nonce,string rewardsIpfsHash)"
]);
const controllerAbi = new Interface([
  "function capacity() view returns (uint256)", "function totalAssets() view returns (uint256)",
  "function totalShares() view returns (uint256)", "function feePercent() view returns (uint64)",
  "function avgRewardPerSecond() view returns (uint256)", "function keeper() view returns (address)"
]);
const configAbi = new Interface([
  "function redeemer() view returns (address)",
  "function getConfig(address) view returns (uint128 liqBonusPercent,uint64 liqThresholdPercent,uint64 ltvPercent)"
]);
const tokenAbi = new Interface(["function totalSupply() view returns (uint256)"]);
const redeemerAbi = new Interface([
  "function getExitQueueData() view returns (uint256,uint256,uint256)", "function canProcessExitQueue() view returns (bool)"
]);
const poolEscrowAbi = new Interface(["function owner() view returns (address)"]);

function safeAddress(value) { try { return getAddress(value).toLowerCase(); } catch (_) { return null; } }
function strictHex(value, bytes = null) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(value)) return null;
  if (bytes !== null && value.length !== 2 + 2 * bytes) return null;
  return value.toLowerCase();
}
function strictQuantity(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u.test(value)) return null;
  try { return BigInt(value); } catch (_) { return null; }
}
function quantity(value) { return `0x${BigInt(value).toString(16)}`; }
function exactKeys(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}
function jsonValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]));
  return value;
}
function workspacePath(value) { return path.join(ROOT, ...value.split("/")); }

function outputPathForRunId(runId) { return path.join(ROOT, ...OUTPUT_DIR_REL.split("/"), `${PREFIX}-${runId}.json`); }
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
  if (argv.length === 3 && argv[2] === "--check-only") return { capture: false, checkOnly: true, runId: null };
  if (argv.length === 5 && argv[2] === CAPTURE_FLAG && argv[3] === "--run-id") {
    validateFreshRunId(argv[4], now);
    return { capture: true, checkOnly: false, runId: argv[4] };
  }
  throw new Error("EXACT_R6_FLAG_AND_FRESH_RUN_ID_REQUIRED");
}

class Accounting {
  constructor() {
    this.methods = Object.fromEntries([...ALLOWED_METHODS].sort().map((method) => [method,
      { attempted: 0, succeeded: 0, failed: 0, canceled: 0 }]));
    this.reasons = {};
    this.concurrentStarted = 0;
    this.concurrentSettled = 0;
    this.cancelSignals = 0;
  }
  start(method) { this.methods[method].attempted += 1; }
  finish(method, status, reason = null) {
    this.methods[method][status] += 1;
    if (reason) this.reasons[reason] = (this.reasons[reason] || 0) + 1;
  }
  note(reason) { this.reasons[reason] = (this.reasons[reason] || 0) + 1; }
  snapshot() {
    const totals = Object.values(this.methods).reduce((out, row) => ({ attempted: out.attempted + row.attempted,
      succeeded: out.succeeded + row.succeeded, failed: out.failed + row.failed, canceled: out.canceled + row.canceled }),
    { attempted: 0, succeeded: 0, failed: 0, canceled: 0 });
    return { methods: this.methods, reasons: Object.fromEntries(Object.entries(this.reasons).sort()), totals,
      concurrentStarted: this.concurrentStarted, concurrentSettled: this.concurrentSettled,
      cancelSignals: this.cancelSignals, allStartedSettled: this.concurrentStarted === this.concurrentSettled,
      counterEquationValid: totals.attempted === totals.succeeded + totals.failed + totals.canceled };
  }
}

class Budget {
  constructor(caps = CAPS, now = () => Date.now()) {
    this.caps = caps; this.now = now; this.startedAt = now(); this.total = 0; this.logs = 0; this.calls = 0;
    this.codes = 0; this.balances = 0; this.blocks = 0; this.logRows = 0; this.chunks = 0; this.responseBytes = 0;
    this.publicGets = 0; this.publicBytes = 0; this.exhausted = null;
  }
  fail(reason) { this.exhausted = reason; throw new Error(`BUDGET_EXHAUSTED_${reason}`); }
  checkTime() { if (this.now() - this.startedAt > this.caps.maxElapsedMs) this.fail("TIME"); }
  consume(method) {
    if (!ALLOWED_METHODS.has(method) || FORBIDDEN_METHODS.has(method)) throw new Error("METHOD_FORBIDDEN");
    this.checkTime(); this.total += 1;
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
  response(bytes) { this.responseBytes += bytes; if (this.responseBytes > this.caps.maxAggregateResponseBytes) this.fail("RESPONSE_BYTES"); }
  chunk() { this.chunks += 1; if (this.chunks > this.caps.maxChunks) this.fail("CHUNKS"); }
  log() { this.logRows += 1; if (this.logRows > this.caps.maxLogs) this.fail("LOG_ROWS"); }
  publicGet() { this.publicGets += 1; if (this.publicGets > this.caps.maxPublicDatasetGets) this.fail("PUBLIC_GETS"); }
  publicResponse(bytes) { this.publicBytes += bytes; if (this.publicBytes > this.caps.maxPublicDatasetBytes) this.fail("PUBLIC_BYTES"); }
  summary() {
    const elapsedWithinCap = this.now() - this.startedAt <= this.caps.maxElapsedMs;
    return { total: this.total, logs: this.logs, calls: this.calls, codes: this.codes, balances: this.balances,
      blocks: this.blocks, logRows: this.logRows, chunks: this.chunks, responseBytes: this.responseBytes,
      publicGets: this.publicGets, publicBytes: this.publicBytes, retries: 0, exhausted: this.exhausted,
      elapsedWithinCap, allWithinCaps: this.exhausted === null && elapsedWithinCap };
  }
}

class RequestGroup {
  constructor(accounting) { this.accounting = accounting; this.controllers = new Set(); this.promises = new Set(); }
  track(controller, promise) {
    this.controllers.add(controller); this.promises.add(promise); this.accounting.concurrentStarted += 1;
    promise.finally(() => { this.controllers.delete(controller); this.promises.delete(promise); this.accounting.concurrentSettled += 1; }).catch(() => {});
  }
  cancel() { for (const controller of this.controllers) { this.accounting.cancelSignals += 1; controller.abort(); } }
  async settle() { await Promise.allSettled([...this.promises]); }
}

async function readBodyLimited(response, context, controller, publicDataset = false) {
  if (!response.body || typeof response.body.getReader !== "function") throw new Error("STREAMING_BODY_REQUIRED");
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  while (true) {
    const row = await reader.read(); if (row.done) break;
    const chunk = Buffer.from(row.value); bytes += chunk.length;
    const cap = publicDataset ? context.caps.maxPublicDatasetBytes : context.caps.maxResponseBytes;
    if (bytes > cap) { controller.abort(); await reader.cancel(); throw new Error(publicDataset ? "PUBLIC_DATASET_BYTES_EXCEEDED" : "BUDGET_EXHAUSTED_SINGLE_RESPONSE_BYTES"); }
    if (publicDataset) context.budget.publicResponse(chunk.length); else context.budget.response(chunk.length);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function rpcRequest(target, method, params, context, group, fetchImpl = fetch) {
  if (!ALLOWED_METHODS.has(method) || FORBIDDEN_METHODS.has(method)) return Promise.resolve({ ok: false, reason: "METHOD_FORBIDDEN", result: null });
  context.budget.consume(method); context.accounting.start(method);
  const requestId = ++context.nextId; const controller = new AbortController();
  const promise = (async () => {
    const timer = setTimeout(() => controller.abort(), context.caps.requestTimeoutMs);
    try {
      const response = await fetchImpl(target.url, { method: "POST", redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }), signal: controller.signal });
      if (response.redirected || response.status < 200 || response.status >= 300) throw new Error("HTTP_FAILURE");
      const body = await readBodyLimited(response, context, controller, false);
      let parsed; try { parsed = JSON.parse(body); } catch (_) { throw new Error("MALFORMED_JSON"); }
      if (!parsed || parsed.jsonrpc !== "2.0" || parsed.id !== requestId || Object.prototype.hasOwnProperty.call(parsed, "error") ||
        !Object.prototype.hasOwnProperty.call(parsed, "result")) throw new Error("RPC_ENVELOPE_INVALID");
      context.accounting.finish(method, "succeeded"); return { ok: true, reason: null, result: parsed.result };
    } catch (error) {
      const canceled = controller.signal.aborted;
      const reason = canceled ? "REQUEST_CANCELED" : String(error.message || error);
      context.accounting.finish(method, canceled ? "canceled" : "failed", reason);
      return { ok: false, reason, result: null };
    } finally { clearTimeout(timer); }
  })();
  if (group) group.track(controller, promise);
  return promise;
}

async function requiredBatch(taskMap, context) {
  const group = new RequestGroup(context.accounting);
  const entries = Object.entries(taskMap);
  const promises = entries.map(async ([name, task]) => {
    const value = await task(group);
    if (value === null || value === undefined) {
      context.accounting.note(`REQUIRED_${name}_MISSING`);
      if (Array.isArray(context.missingRequiredFields) && !context.missingRequiredFields.includes(name)) context.missingRequiredFields.push(name);
      throw new Error(`REQUIRED_${name}_MISSING`);
    }
    return [name, value];
  });
  try {
    return Object.fromEntries(await Promise.all(promises));
  } catch (error) {
    group.cancel(); await Promise.allSettled(promises); await group.settle(); throw error;
  } finally { await group.settle(); }
}

async function decodedCall(target, address, abi, fragment, args, pin, context, group) {
  const response = await rpcRequest(target, "eth_call", [{ to: address, data: abi.encodeFunctionData(fragment, args || []) }, quantity(pin)], context, group);
  if (!response.ok || !strictHex(response.result)) return null;
  try { return abi.decodeFunctionResult(fragment, response.result); } catch (_) { context.accounting.note(`DECODE_${fragment}_FAILED`); return null; }
}
function at(decoded, index, kind = "bigint") {
  if (!decoded) return null;
  try {
    if (kind === "address") return safeAddress(decoded[index]);
    if (kind === "bool") return Boolean(decoded[index]);
    if (kind === "number") return Number(decoded[index]);
    if (kind === "hex32") return strictHex(decoded[index], 32);
    return BigInt(decoded[index]);
  } catch (_) { return null; }
}
async function requiredCode(target, address, pin, context, group, request = rpcRequest) {
  const record = await requiredCodeRecord(target, address, pin, context, group, request);
  return record ? record.present : null;
}
async function requiredCodeRecord(target, address, pin, context, group, request = rpcRequest) {
  const response = await request(target, "eth_getCode", [address, quantity(pin)], context, group);
  const code = response.ok ? strictHex(response.result) : null;
  if (code === null) return null;
  return code !== "0x" ? { present: true, runtimeCodeHash: keccak256(code), byteLength: (code.length - 2) / 2 } :
    { present: false, runtimeCodeHash: null, byteLength: 0 };
}
async function requiredBalance(target, address, pin, context, group) {
  const response = await rpcRequest(target, "eth_getBalance", [address, quantity(pin)], context, group);
  return response.ok ? strictQuantity(response.result) : null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
function parseDeploymentBuffer(bytes) {
  const deployment = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!exactKeys(deployment, Object.keys(deployment))) throw new Error("MANIFEST_OBJECT_INVALID");
  const roles = {};
  for (const key of ROLE_KEYS) {
    const address = safeAddress(deployment[key]);
    if (!address) throw new Error(`MANIFEST_ROLE_${key}_MISSING`);
    roles[key] = address;
  }
  return deepFreeze({ deployment, roles });
}
function loadInventory() {
  const stat = fs.statSync(INVENTORY_PATH); if (stat.size > CAPS.maxInventoryBytes) throw new Error("INVENTORY_BYTES_EXCEEDED");
  const text = fs.readFileSync(INVENTORY_PATH, "utf8"); const lines = text.split(/\r?\n/u);
  if (lines.length > CAPS.maxInventoryLines) throw new Error("INVENTORY_LINES_EXCEEDED");
  const hosts = new Set(); const rows = [];
  for (const line of lines) {
    const match = line.match(/https:\/\/[^\s'"<>\[\]]+/u); if (!match) continue;
    let parsed; try { parsed = new URL(match[0].replace(/[)\]]+$/u, "")); } catch (_) { continue; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || /sepolia|hoodi|gnosis|chiado|testnet/iu.test(parsed.href)) continue;
    const host = parsed.hostname.toLowerCase(); if (hosts.has(host) || hosts.size >= CAPS.maxEndpointFamilies) continue;
    hosts.add(host); rows.push({ url: parsed.href, family: `F${hosts.size}` });
    if (rows.length >= CAPS.maxInventoryEntries) break;
  }
  return rows;
}
function parseHeader(value) {
  const number = value && strictQuantity(value.number); const hash = value && strictHex(value.hash, 32);
  const timestamp = value && strictQuantity(value.timestamp);
  return number === null || !hash || timestamp === null ? null : { number, hash, timestamp };
}
function choosePin(observations) {
  const groups = new Map();
  for (const row of observations) {
    if (!row || row.chainId !== CHAIN_ID || !row.header || row.header.number < BigInt(CAPS.minPlausiblePin) ||
      row.header.number > BigInt(CAPS.maxPlausiblePin)) continue;
    const key = `${row.header.number}:${row.header.hash}`; if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key).set(row.family, row);
  }
  const ranked = [...groups.values()].sort((a, b) => b.size - a.size);
  const best = ranked[0] ? [...ranked[0].values()].sort((a, b) => a.family.localeCompare(b.family)) : [];
  if (!best.length) return { mode: "UNAVAILABLE", rows: [], header: null, hostnameConsensus: false };
  const consensus = best.length >= CAPS.minimumConsensusFamilies;
  return { mode: consensus ? "HOSTNAME_CONSENSUS_DIAGNOSTIC" : "SINGLE_FAMILY_DIAGNOSTIC",
    rows: best.slice(0, consensus ? 2 : 1), header: best[0].header, hostnameConsensus: consensus,
    backendIndependenceProven: false, promotable: false };
}
async function qualify(targets, context) {
  const observations = [];
  for (const target of targets) {
    const group = new RequestGroup(context.accounting);
    const values = await requiredBatch({
      chainId: async (g) => { const row = await rpcRequest(target, "eth_chainId", [], context, g); return row.ok ? strictQuantity(row.result) : null; },
      finalized: async (g) => { const row = await rpcRequest(target, "eth_getBlockByNumber", ["finalized", false], context, g); return row.ok ? parseHeader(row.result) : null; }
    }, context).catch(() => null);
    await group.settle();
    if (values && values.chainId === 1n) observations.push({ ...target, chainId: 1, header: values.finalized });
  }
  return { attemptedFamilyCount: targets.length, qualifyingFamilyCount: observations.length, selected: choosePin(observations) };
}

function parseRpcLog(value, addresses, from, to) {
  const address = value && safeAddress(value.address); const blockNumber = value && strictQuantity(value.blockNumber);
  const transactionIndex = value && strictQuantity(value.transactionIndex); const logIndex = value && strictQuantity(value.logIndex);
  const blockHash = value && strictHex(value.blockHash, 32); const transactionHash = value && strictHex(value.transactionHash, 32);
  const data = value && strictHex(value.data);
  if (!address || !addresses.has(address) || blockNumber === null || blockNumber < from || blockNumber > to ||
    transactionIndex === null || logIndex === null || !blockHash || !transactionHash || !data || value.removed !== false ||
    !Array.isArray(value.topics) || !value.topics.every((topic) => strictHex(topic, 32))) throw new Error("LOG_INVALID");
  return { address, blockNumber, transactionIndex, logIndex, blockHash, transactionHash, data,
    topics: value.topics.map((topic) => topic.toLowerCase()) };
}
async function logsChunked(target, addresses, topics, pin, context) {
  if (pin + 1n > BigInt(CAPS.maxScanSpanBlocks)) throw new Error("SCAN_SPAN_EXCEEDED");
  const set = new Set(addresses.map(safeAddress).filter(Boolean)); const logs = [];
  for (let start = 0n; start <= pin; start += BigInt(CAPS.maxLogChunkBlocks)) {
    context.budget.chunk(); const end = start + BigInt(CAPS.maxLogChunkBlocks - 1) > pin ? pin : start + BigInt(CAPS.maxLogChunkBlocks - 1);
    const row = await rpcRequest(target, "eth_getLogs", [{ address: [...set], topics, fromBlock: quantity(start),
      toBlock: quantity(end) }], context, null);
    if (!row.ok || !Array.isArray(row.result)) throw new Error("LOG_SCAN_INCOMPLETE");
    for (const raw of row.result) { logs.push(parseRpcLog(raw, set, start, end)); context.budget.log(); }
  }
  return logs;
}

function trustedClassification(vaultId, version, lineage, implementationMember, implementationCodePresent) {
  const trusted = TRUSTED_ID_BY_HASH.get(String(vaultId).toLowerCase()) || null;
  if (!trusted) return { trusted: false, reason: "VAULT_ID_UNKNOWN", vaultType: "UNKNOWN", numericVersion: version,
    access: "UNKNOWN", meta: null, assetMode: "UNKNOWN", ownMevUnsupported: null };
  const lineageMatches = trusted.factoryKey ? lineage.factoryKey === trusted.factoryKey : lineage.directKey === trusted.directKey;
  const complete = lineageMatches && implementationMember === true && implementationCodePresent === true;
  return { trusted: complete, reason: complete ? null : "IMPL_OR_LINEAGE_MISMATCH", vaultType: trusted.name,
    numericVersion: version, access: trusted.access, meta: trusted.meta, assetMode: trusted.assetMode,
    ownMevUnsupported: trusted.ownMevUnsupported, lineageMatches };
}

function stagedReadPlan(classification) {
  if (!classification || classification.trusted !== true) return { stage: "IDENTITY_ONLY", keeper: false, vaultMev: false,
    subVaults: false };
  return classification.meta === true ? { stage: "META_SUBVAULTS", keeper: false, vaultMev: false, subVaults: true } :
    { stage: "NON_META_KEEPER_MEV", keeper: true, vaultMev: true, subVaults: false };
}

function identityDiagnosticRow(base, identity, impl, classification) {
  return { ...base, readPath: "IDENTITY_ONLY", identityReadsComplete: true,
    unsupportedStateReadsSkipped: true, requiredReadsComplete: false, stageError: null,
    access: classification.access, meta: classification.meta, assetMode: classification.assetMode, classification,
    registryMember: identity.registryMember, codePresent: identity.codeRecord.present,
    proxyRuntimeCodeHash: identity.codeRecord.runtimeCodeHash, implementation: identity.implementation,
    implementationCodePresent: impl.implementationCodeRecord.present,
    implementationRuntimeCodeHash: impl.implementationCodeRecord.runtimeCodeHash,
    implementationRegistryMember: impl.implementationRegistryMember, numericVersion: identity.version,
    vaultId: identity.vaultId, capacity: null, feePercent: null, totalAssets: null, totalShares: null,
    currentSupply: null, securityShares: null, queue: null, withdrawableAssets: null,
    stateUpdateRequired: null, nativeBalance: null, osTokenConfig: null, metaState: null, mevEscrow: null,
    mevEscrowBalance: null, rewardAssets: null, keeperRewardsNonce: null, unlockedMevAssets: null,
    unlockedMevNonce: null, canHarvest: null, isHarvestRequired: null, collateralized: null };
}

function standardLeaf(vault, reward, unlockedMevReward) {
  const encoded = AbiCoder.defaultAbiCoder().encode(["address", "int160", "uint160"], [vault, reward, unlockedMevReward]);
  return keccak256(concat([keccak256(encoded)]));
}
function hashPair(left, right) {
  const pair = left.toLowerCase() < right.toLowerCase() ? [left, right] : [right, left];
  return keccak256(concat(pair));
}
function proofForIndex(tree, index) {
  const proof = []; let current = index;
  while (current > 0) {
    const sibling = current % 2 === 0 ? current - 1 : current + 1;
    if (sibling >= tree.length) return null;
    proof.push(tree[sibling]); current = Math.floor((current - 1) / 2);
  }
  return proof;
}
function verifyProof(leaf, proof, root) { return proof.reduce((node, sibling) => hashPair(node, sibling), leaf) === root; }

function parseRewardsDataset(dataset, acceptedRoots, discoveredVaults, storedByVault) {
  const unavailable = (reason) => ({ verified: false, completeForDiscovered: false, reason, root: null, rows: new Map(),
    rowCount: 0, missingDiscoveredVaults: [] });
  if (!exactKeys(dataset, ["format", "leafEncoding", "tree", "values"]) || dataset.format !== "standard-v1" ||
    JSON.stringify(dataset.leafEncoding) !== JSON.stringify(["address", "int160", "uint160"]) ||
    !Array.isArray(dataset.values) || dataset.values.length === 0 || dataset.values.length > CAPS.maxTreeValues ||
    !Array.isArray(dataset.tree) || dataset.tree.length !== 2 * dataset.values.length - 1 ||
    dataset.tree.length > CAPS.maxTreeNodes || !dataset.tree.every((node) => strictHex(node, 32))) {
    return unavailable("STANDARD_TREE_SCHEMA_INVALID");
  }
  const tree = dataset.tree.map((node) => node.toLowerCase()); const root = tree[0];
  const roots = new Set(acceptedRoots.map((value) => strictHex(value, 32)).filter(Boolean));
  if (!roots.has(root)) return unavailable("TREE_ROOT_NOT_CURRENT_OR_PREVIOUS");
  const wanted = new Set(discoveredVaults.map(safeAddress).filter(Boolean)); const addresses = new Set(); const indexes = new Set();
  const rows = new Map(); const proofChecks = [];
  const firstLeafIndex = dataset.values.length - 1;
  for (const item of dataset.values) {
    if (!exactKeys(item, ["value", "treeIndex"]) || !Number.isSafeInteger(item.treeIndex) || item.treeIndex < 0 ||
      item.treeIndex >= tree.length || item.treeIndex < firstLeafIndex || !Array.isArray(item.value) ||
      item.value.length !== 3) return unavailable("TREE_VALUE_SCHEMA_INVALID");
    const vault = safeAddress(item.value[0]);
    let reward; let unlocked;
    try { reward = BigInt(item.value[1]); unlocked = BigInt(item.value[2]); } catch (_) { return unavailable("TREE_VALUE_INTEGER_INVALID"); }
    if (!vault || reward < INT160_MIN || reward > INT160_MAX || unlocked < 0n || unlocked > UINT160_MAX) return unavailable("TREE_VALUE_BOUNDS_INVALID");
    if (addresses.has(vault) || indexes.has(item.treeIndex)) return unavailable("TREE_DUPLICATE_REJECTED");
    addresses.add(vault); indexes.add(item.treeIndex);
    const leaf = standardLeaf(vault, reward, unlocked);
    if (tree[item.treeIndex] !== leaf) return unavailable("TREE_LEAF_MISMATCH");
    const proof = proofForIndex(tree, item.treeIndex);
    if (!proof) return unavailable("MERKLE_PROOF_INVALID");
    proofChecks.push({ leaf, proof });
    if (wanted.has(vault)) {
      const stored = storedByVault.get(vault);
      if (!stored) return unavailable("DISCOVERED_STORED_REWARD_MISSING");
      if (unlocked < stored.unlockedMevAssets) return unavailable("UNLOCKED_MEV_NONMONOTONIC");
      rows.set(vault, { vault, reward, unlockedMevReward: unlocked, proof, root, rootKind: root === strictHex(acceptedRoots[0], 32) ? "CURRENT" : "PREVIOUS" });
    }
  }
  for (let index = firstLeafIndex; index < tree.length; index++) {
    if (!indexes.has(index)) return unavailable("TREE_LEAF_INDEX_COVERAGE_INCOMPLETE");
  }
  for (let index = firstLeafIndex - 1; index >= 0; index--) {
    if (tree[index] !== hashPair(tree[2 * index + 1], tree[2 * index + 2])) return unavailable("TREE_PARENT_RECOMPUTE_MISMATCH");
  }
  if (proofChecks.some((row) => !verifyProof(row.leaf, row.proof, root))) return unavailable("MERKLE_PROOF_INVALID");
  const missingDiscoveredVaults = [...wanted].filter((vault) => !rows.has(vault)).sort();
  return { verified: true, completeForDiscovered: missingDiscoveredVaults.length === 0,
    reason: missingDiscoveredVaults.length ? "DISCOVERED_VAULT_ROWS_MISSING" : null, root, rows,
    rowCount: dataset.values.length, missingDiscoveredVaults };
}

function orderedRewardsEvent(logs) {
  const events = logs.map((log) => {
    let parsed; try { parsed = keeperAbi.parseLog({ topics: log.topics, data: log.data }); } catch (_) { throw new Error("REWARDS_EVENT_DECODE_FAILED"); }
    if (!parsed || parsed.name !== "RewardsUpdated") throw new Error("REWARDS_EVENT_NAME_INVALID");
    const cid = String(parsed.args.rewardsIpfsHash);
    if (!/^[A-Za-z0-9]{32,128}$/u.test(cid)) throw new Error("REWARDS_CID_INVALID");
    return { blockNumber: log.blockNumber, transactionIndex: log.transactionIndex, logIndex: log.logIndex,
      root: String(parsed.args.rewardsRoot).toLowerCase(), avgRewardPerSecond: BigInt(parsed.args.avgRewardPerSecond),
      updateTimestamp: BigInt(parsed.args.updateTimestamp), nonce: BigInt(parsed.args.nonce), cid };
  }).sort((a, b) => a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) :
    a.transactionIndex !== b.transactionIndex ? (a.transactionIndex < b.transactionIndex ? -1 : 1) :
      a.logIndex < b.logIndex ? -1 : a.logIndex > b.logIndex ? 1 : 0);
  return events.length ? events[events.length - 1] : null;
}

function rewardsEventAligns(event, keeper) {
  return Boolean(event && keeper && event.root === keeper.rewardsRoot && event.nonce + 1n === keeper.rewardsNonce);
}

function globalIntegrity(values, roles) {
  return { allRoleCodePresent: ROLE_KEYS.every((key) => values[`code_${key}`] === true),
    controllerKeeperMatches: values.controllerKeeper === roles.Keeper,
    configRedeemerMatches: values.configRedeemer === roles.OsTokenRedeemer };
}

async function readGlobal(target, roles, pin, context) {
  const tasks = {};
  for (const [key, address] of Object.entries(roles)) tasks[`code_${key}`] = (g) => requiredCode(target, address, pin, context, g);
  Object.assign(tasks, {
    rewardsNonce: async (g) => at(await decodedCall(target, roles.Keeper, keeperAbi, "rewardsNonce", [], pin, context, g), 0),
    rewardsRoot: async (g) => at(await decodedCall(target, roles.Keeper, keeperAbi, "rewardsRoot", [], pin, context, g), 0, "hex32"),
    prevRewardsRoot: async (g) => at(await decodedCall(target, roles.Keeper, keeperAbi, "prevRewardsRoot", [], pin, context, g), 0, "hex32"),
    lastRewardsTimestamp: async (g) => at(await decodedCall(target, roles.Keeper, keeperAbi, "lastRewardsTimestamp", [], pin, context, g), 0),
    controllerCapacity: async (g) => at(await decodedCall(target, roles.OsTokenVaultController, controllerAbi, "capacity", [], pin, context, g), 0),
    controllerAssets: async (g) => at(await decodedCall(target, roles.OsTokenVaultController, controllerAbi, "totalAssets", [], pin, context, g), 0),
    controllerShares: async (g) => at(await decodedCall(target, roles.OsTokenVaultController, controllerAbi, "totalShares", [], pin, context, g), 0),
    controllerFee: async (g) => at(await decodedCall(target, roles.OsTokenVaultController, controllerAbi, "feePercent", [], pin, context, g), 0),
    avgRewardPerSecond: async (g) => at(await decodedCall(target, roles.OsTokenVaultController, controllerAbi, "avgRewardPerSecond", [], pin, context, g), 0),
    controllerKeeper: async (g) => at(await decodedCall(target, roles.OsTokenVaultController, controllerAbi, "keeper", [], pin, context, g), 0, "address"),
    configRedeemer: async (g) => at(await decodedCall(target, roles.OsTokenConfig, configAbi, "redeemer", [], pin, context, g), 0, "address"),
    defaultConfig: async (g) => decodedCall(target, roles.OsTokenConfig, configAbi, "getConfig", [ZERO], pin, context, g),
    tokenSupply: async (g) => at(await decodedCall(target, roles.OsToken, tokenAbi, "totalSupply", [], pin, context, g), 0),
    redeemerQueue: async (g) => decodedCall(target, roles.OsTokenRedeemer, redeemerAbi, "getExitQueueData", [], pin, context, g),
    redeemerCanProcess: async (g) => at(await decodedCall(target, roles.OsTokenRedeemer, redeemerAbi, "canProcessExitQueue", [], pin, context, g), 0, "bool"),
    sharedMevBalance: (g) => requiredBalance(target, roles.SharedMevEscrow, pin, context, g),
    redeemerBalance: (g) => requiredBalance(target, roles.OsTokenRedeemer, pin, context, g)
  });
  const values = await requiredBatch(tasks, context);
  const integrity = globalIntegrity(values, roles);
  if (!integrity.allRoleCodePresent || !integrity.controllerKeeperMatches || !integrity.configRedeemerMatches) throw new Error("GLOBAL_ROLE_INTEGRITY_FAILED");
  return { keeper: { address: roles.Keeper, rewardsNonce: values.rewardsNonce, rewardsRoot: values.rewardsRoot,
    prevRewardsRoot: values.prevRewardsRoot, lastRewardsTimestamp: values.lastRewardsTimestamp },
  osToken: { tokenAddress: roles.OsToken, controllerAddress: roles.OsTokenVaultController, configAddress: roles.OsTokenConfig,
    redeemerAddress: roles.OsTokenRedeemer, controllerCapacity: values.controllerCapacity,
    controllerTotalAssets: values.controllerAssets, controllerTotalShares: values.controllerShares,
    controllerFeePercent: values.controllerFee, avgRewardPerSecond: values.avgRewardPerSecond, totalSupply: values.tokenSupply,
    defaultConfig: { liqBonusPercent: at(values.defaultConfig, 0), liqThresholdPercent: at(values.defaultConfig, 1),
      ltvPercent: at(values.defaultConfig, 2) }, redeemerQueue: { queuedShares: at(values.redeemerQueue, 0),
      unclaimedAssets: at(values.redeemerQueue, 1), totalTickets: at(values.redeemerQueue, 2) },
    redeemerCanProcess: values.redeemerCanProcess, sharedMevEscrowAddress: roles.SharedMevEscrow,
    sharedMevEscrowBalance: values.sharedMevBalance, redeemerNativeBalance: values.redeemerBalance }, integrity };
}

async function readMetaStage(target, roles, vault, pin, context) {
  const registryAddress = await requiredBatch({ subVaultsRegistry: async (g) => at(await decodedCall(target, vault,
    metaVaultAbi, "subVaultsRegistry", [], pin, context, g), 0, "address") }, context);
  const meta = await requiredBatch({
    registryCodePresent: (g) => requiredCode(target, registryAddress.subVaultsRegistry, pin, context, g),
    metaVault: async (g) => at(await decodedCall(target, registryAddress.subVaultsRegistry, subVaultsAbi, "metaVault", [], pin, context, g), 0, "address"),
    subVaults: async (g) => { const decoded = await decodedCall(target, registryAddress.subVaultsRegistry,
      subVaultsAbi, "getSubVaults", [], pin, context, g); return decoded ? decoded[0].map(safeAddress) : null; },
    rewardsNonce: async (g) => at(await decodedCall(target, registryAddress.subVaultsRegistry, subVaultsAbi,
      "subVaultsRewardsNonce", [], pin, context, g), 0),
    totalAssets: async (g) => at(await decodedCall(target, registryAddress.subVaultsRegistry, subVaultsAbi,
      "subVaultsTotalAssets", [], pin, context, g), 0),
    stateUpdateRequired: async (g) => at(await decodedCall(target, registryAddress.subVaultsRegistry, subVaultsAbi,
      "isStateUpdateRequired", [], pin, context, g), 0, "bool"),
    collateralized: async (g) => at(await decodedCall(target, registryAddress.subVaultsRegistry, subVaultsAbi,
      "isCollateralized", [], pin, context, g), 0, "bool")
  }, context);
  if (meta.metaVault !== vault || !Array.isArray(meta.subVaults) || meta.subVaults.some((address) => !address) ||
    meta.subVaults.length > CAPS.maxSubVaultsPerMeta) throw new Error("META_SUBVAULT_TOPOLOGY_INVALID");
  const subVaults = [];
  for (const subVault of meta.subVaults) {
    const state = await requiredBatch({
      codeRecord: (g) => requiredCodeRecord(target, subVault, pin, context, g),
      nativeBalance: (g) => requiredBalance(target, subVault, pin, context, g),
      registryMember: async (g) => at(await decodedCall(target, roles.VaultsRegistry, registryAbi, "vaults",
        [subVault], pin, context, g), 0, "bool"),
      registryState: (g) => decodedCall(target, registryAddress.subVaultsRegistry, subVaultsAbi, "subVaultsStates",
        [subVault], pin, context, g),
      totalAssets: async (g) => at(await decodedCall(target, subVault, vaultAbi, "totalAssets", [], pin, context, g), 0),
      totalShares: async (g) => at(await decodedCall(target, subVault, vaultAbi, "totalShares", [], pin, context, g), 0),
      withdrawableAssets: async (g) => at(await decodedCall(target, subVault, vaultAbi, "withdrawableAssets", [], pin, context, g), 0),
      stateUpdateRequired: async (g) => at(await decodedCall(target, subVault, vaultAbi, "isStateUpdateRequired", [], pin, context, g), 0, "bool")
    }, context);
    subVaults.push({ address: subVault, codePresent: state.codeRecord.present,
      runtimeCodeHash: state.codeRecord.runtimeCodeHash, nativeBalance: state.nativeBalance,
      registryMember: state.registryMember,
      stakedShares: at(state.registryState, 0), queuedShares: at(state.registryState, 1), totalAssets: state.totalAssets,
      totalShares: state.totalShares, withdrawableAssets: state.withdrawableAssets,
      stateUpdateRequired: state.stateUpdateRequired });
  }
  return { subVaultsRegistry: registryAddress.subVaultsRegistry, registryCodePresent: meta.registryCodePresent,
    metaVaultMatches: true, rewardsNonce: meta.rewardsNonce, totalAssets: meta.totalAssets,
    stateUpdateRequired: meta.stateUpdateRequired, collateralized: meta.collateralized, subVaults };
}

async function readVault(target, roles, vault, lineage, pin, context, dependencies = {}) {
  const base = { address: vault, factoryAddress: lineage.factoryAddress || null, factoryKey: lineage.factoryKey || null,
    directKey: lineage.directKey || null, requiredReadsComplete: false, stageError: null,
    runtimeBuildBinding: false, exactAffectedSemantics: null, genesisState: null };
  try {
    const identity = dependencies.identity || await requiredBatch({
      registryMember: async (g) => at(await decodedCall(target, roles.VaultsRegistry, registryAbi, "vaults", [vault], pin, context, g), 0, "bool"),
      codeRecord: (g) => requiredCodeRecord(target, vault, pin, context, g),
      implementation: async (g) => at(await decodedCall(target, vault, vaultAbi, "implementation", [], pin, context, g), 0, "address"),
      version: async (g) => at(await decodedCall(target, vault, vaultAbi, "version", [], pin, context, g), 0, "number"),
      vaultId: async (g) => at(await decodedCall(target, vault, vaultAbi, "vaultId", [], pin, context, g), 0, "hex32")
    }, context);
    const impl = dependencies.implementationState || await requiredBatch({
      implementationCodeRecord: (g) => requiredCodeRecord(target, identity.implementation, pin, context, g),
      implementationRegistryMember: async (g) => at(await decodedCall(target, roles.VaultsRegistry, registryAbi,
        "vaultImpls", [identity.implementation], pin, context, g), 0, "bool")
    }, context);
    const classification = trustedClassification(identity.vaultId, identity.version, lineage,
      impl.implementationRegistryMember, impl.implementationCodeRecord.present);
    const readPlan = stagedReadPlan(classification);
    if (readPlan.stage === "IDENTITY_ONLY") return identityDiagnosticRow(base, identity, impl, classification);
    const common = await requiredBatch({
      capacity: async (g) => at(await decodedCall(target, vault, vaultAbi, "capacity", [], pin, context, g), 0),
      feePercent: async (g) => at(await decodedCall(target, vault, vaultAbi, "feePercent", [], pin, context, g), 0),
      totalAssets: async (g) => at(await decodedCall(target, vault, vaultAbi, "totalAssets", [], pin, context, g), 0),
      totalShares: async (g) => at(await decodedCall(target, vault, vaultAbi, "totalShares", [], pin, context, g), 0),
      securityShares: async (g) => at(await decodedCall(target, vault, vaultAbi, "getShares", [vault], pin, context, g), 0),
      queue: (g) => decodedCall(target, vault, vaultAbi, "getExitQueueData", [], pin, context, g),
      withdrawableAssets: async (g) => at(await decodedCall(target, vault, vaultAbi, "withdrawableAssets", [], pin, context, g), 0),
      stateUpdateRequired: async (g) => at(await decodedCall(target, vault, vaultAbi, "isStateUpdateRequired", [], pin, context, g), 0, "bool"),
      nativeBalance: (g) => requiredBalance(target, vault, pin, context, g),
      osTokenConfig: (g) => decodedCall(target, roles.OsTokenConfig, configAbi, "getConfig", [vault], pin, context, g)
    }, context);
    const row = { ...base, access: classification.access, meta: classification.meta, assetMode: classification.assetMode,
      classification, registryMember: identity.registryMember, codePresent: identity.codeRecord.present,
      proxyRuntimeCodeHash: identity.codeRecord.runtimeCodeHash,
      implementation: identity.implementation, implementationCodePresent: impl.implementationCodeRecord.present,
      implementationRuntimeCodeHash: impl.implementationCodeRecord.runtimeCodeHash,
      implementationRegistryMember: impl.implementationRegistryMember, numericVersion: identity.version,
      vaultId: identity.vaultId, capacity: common.capacity, feePercent: common.feePercent,
      totalAssets: common.totalAssets, totalShares: common.totalShares, currentSupply: common.totalShares,
      securityShares: common.securityShares, queue: { queuedShares: at(common.queue, 0),
        unclaimedAssets: at(common.queue, 1), totalExitingTickets: at(common.queue, 2),
        totalExitingAssets: at(common.queue, 3), totalTickets: at(common.queue, 4) },
      withdrawableAssets: common.withdrawableAssets, stateUpdateRequired: common.stateUpdateRequired,
      nativeBalance: common.nativeBalance, osTokenConfig: { liqBonusPercent: at(common.osTokenConfig, 0),
        liqThresholdPercent: at(common.osTokenConfig, 1), ltvPercent: at(common.osTokenConfig, 2) } };
    if (readPlan.stage === "META_SUBVAULTS") {
      row.readPath = "META_SUBVAULTS"; row.metaState = await readMetaStage(target, roles, vault, pin, context);
      row.mevEscrow = null; row.mevEscrowBalance = null; row.rewardAssets = null; row.keeperRewardsNonce = null;
      row.unlockedMevAssets = null; row.unlockedMevNonce = null; row.canHarvest = null;
      row.isHarvestRequired = null; row.collateralized = row.metaState.collateralized;
    } else if (readPlan.stage === "NON_META_KEEPER_MEV") {
      row.readPath = "NON_META_KEEPER_MEV";
      const state = await requiredBatch({
        mevEscrow: async (g) => at(await decodedCall(target, vault, vaultAbi, "mevEscrow", [], pin, context, g), 0, "address"),
        rewards: (g) => decodedCall(target, roles.Keeper, keeperAbi, "rewards", [vault], pin, context, g),
        unlocked: (g) => decodedCall(target, roles.Keeper, keeperAbi, "unlockedMevRewards", [vault], pin, context, g),
        canHarvest: async (g) => at(await decodedCall(target, roles.Keeper, keeperAbi, "canHarvest", [vault], pin, context, g), 0, "bool"),
        isHarvestRequired: async (g) => at(await decodedCall(target, roles.Keeper, keeperAbi, "isHarvestRequired", [vault], pin, context, g), 0, "bool"),
        collateralized: async (g) => at(await decodedCall(target, roles.Keeper, keeperAbi, "isCollateralized", [vault], pin, context, g), 0, "bool")
      }, context);
      const escrow = await requiredBatch({
        codeRecord: (g) => requiredCodeRecord(target, state.mevEscrow, pin, context, g),
        balance: (g) => requiredBalance(target, state.mevEscrow, pin, context, g)
      }, context);
      Object.assign(row, { mevEscrow: state.mevEscrow, mevEscrowCodePresent: escrow.codeRecord.present,
        mevEscrowRuntimeCodeHash: escrow.codeRecord.runtimeCodeHash,
        mevEscrowBalance: escrow.balance, sharedMevEscrow: roles.SharedMevEscrow,
        rewardAssets: at(state.rewards, 0), keeperRewardsNonce: at(state.rewards, 1),
        unlockedMevAssets: at(state.unlocked, 0), unlockedMevNonce: at(state.unlocked, 1),
        canHarvest: state.canHarvest, isHarvestRequired: state.isHarvestRequired,
        collateralized: state.collateralized, metaState: null });
    } else throw new Error("TRUSTED_TYPE_REQUIRED_FOR_STATE_STAGE");
    row.genesisState = null;
    if (classification.vaultType === "EthGenesisVault") {
      const genesis = await requiredBatch({
        poolEscrowCodeRecord: (g) => requiredCodeRecord(target, roles.LegacyPoolEscrow, pin, context, g),
        poolEscrowBalance: (g) => requiredBalance(target, roles.LegacyPoolEscrow, pin, context, g),
        poolEscrowOwner: async (g) => at(await decodedCall(target, roles.LegacyPoolEscrow, poolEscrowAbi,
          "owner", [], pin, context, g), 0, "address")
      }, context);
      row.genesisState = { label: "GENESIS_SPECIAL_LEGACY_POOL", poolEscrowAddress: roles.LegacyPoolEscrow,
        poolEscrowCodePresent: genesis.poolEscrowCodeRecord.present,
        poolEscrowRuntimeCodeHash: genesis.poolEscrowCodeRecord.runtimeCodeHash,
        poolEscrowBalance: genesis.poolEscrowBalance, poolEscrowOwner: genesis.poolEscrowOwner,
        poolEscrowOwnerMatchesVault: genesis.poolEscrowOwner === vault, economics: null };
    }
    row.runtimeBuildBinding = false; row.exactAffectedSemantics = null;
    row.requiredReadsComplete = true; return row;
  } catch (error) {
    return { ...base, readPath: "STAGED_DIAGNOSTIC", stageError: String(error.message || error),
      classification: null, access: "UNKNOWN", meta: null, assetMode: "UNKNOWN" };
  }
}

async function captureFamily(target, bundle, pin, context) {
  const { roles } = bundle; const registryTopics = [[id("FactoryAdded(address)"), id("FactoryRemoved(address)"),
    id("VaultAdded(address,address)"), id("VaultImplAdded(address)"), id("VaultImplRemoved(address)")]];
  const registryLogs = await logsChunked(target, [roles.VaultsRegistry], registryTopics, pin, context);
  const registryDiscovery = step2.parseRegistryDiscovery(registryLogs);
  if (registryDiscovery.malformed) throw new Error("REGISTRY_EVENT_DECODE_FAILED");
  const keyByFactory = new Map(FACTORY_KEYS.map((key) => [roles[key], key]));
  const factories = new Set([...keyByFactory.keys(), ...registryDiscovery.factories].filter(Boolean));
  if (factories.size > CAPS.maxFactories) throw new Error("FACTORY_CAP_EXCEEDED");
  const factoryState = new Map();
  for (const factory of factories) {
    const state = await requiredBatch({
      member: async (g) => at(await decodedCall(target, roles.VaultsRegistry, registryAbi, "factories", [factory], pin, context, g), 0, "bool"),
      code: (g) => requiredCode(target, factory, pin, context, g),
      implementation: async (g) => at(await decodedCall(target, factory, factoryAbi, "implementation", [], pin, context, g), 0, "address")
    }, context);
    const impl = await requiredBatch({
      implementationCode: (g) => requiredCode(target, state.implementation, pin, context, g),
      implementationMember: async (g) => at(await decodedCall(target, roles.VaultsRegistry, registryAbi, "vaultImpls",
        [state.implementation], pin, context, g), 0, "bool")
    }, context);
    factoryState.set(factory, { ...state, ...impl, key: keyByFactory.get(factory) || null });
  }
  const factoryLogs = [];
  const factoryArray = [...factories];
  for (let offset = 0; offset < factoryArray.length; offset += CAPS.maxAddressBatch) {
    factoryLogs.push(...await logsChunked(target, factoryArray.slice(offset, offset + CAPS.maxAddressBatch),
      [[id("VaultCreated(address,address,address,bytes)"), id("MetaVaultCreated(address,address,address,bytes)")]], pin, context));
  }
  const created = step2.parseFactoryVaults(factoryLogs); if (created.malformed) throw new Error("FACTORY_EVENT_DECODE_FAILED");
  const directMap = new Map(DIRECT_VAULT_KEYS.map((key) => [roles[key], key]));
  const candidates = new Set([...registryDiscovery.vaults, ...created.vaults, ...directMap.keys()].filter(Boolean));
  if (candidates.size > CAPS.maxVaults) throw new Error("VAULT_CAP_EXCEEDED");
  const current = [];
  for (const vault of candidates) {
    const member = await requiredBatch({ membership: async (g) => at(await decodedCall(target, roles.VaultsRegistry,
      registryAbi, "vaults", [vault], pin, context, g), 0, "bool") }, context);
    if (member.membership === true) current.push(vault);
  }
  const vaults = [];
  for (const vault of current) {
    const factoryAddress = created.lineage.get(vault) || null;
    const lineage = factoryAddress ? { factoryAddress, factoryKey: keyByFactory.get(factoryAddress) || null, directKey: null } :
      { factoryAddress: null, factoryKey: null, directKey: directMap.get(vault) || null };
    vaults.push(await readVault(target, roles, vault, lineage, pin, context));
  }
  const donationLogs = [];
  for (let offset = 0; offset < current.length; offset += CAPS.maxAddressBatch) {
    donationLogs.push(...await logsChunked(target, current.slice(offset, offset + CAPS.maxAddressBatch),
      [[id("AssetsDonated(address,uint256)"), id("SharesDonated(address,uint256)")]], pin, context));
  }
  const assetDonationTopic = id("AssetsDonated(address,uint256)").toLowerCase();
  for (const vault of vaults) {
    const ownLogs = donationLogs.filter((log) => log.address === vault.address);
    vault.donations = { assetsDonatedEventCount: ownLogs.filter((log) => log.topics[0] === assetDonationTopic).length,
      sharesDonatedEventCount: ownLogs.filter((log) => log.topics[0] !== assetDonationTopic).length,
      pendingDonationObservable: false, pendingDonation: null, economics: null };
  }
  const rewardLogs = await logsChunked(target, [roles.Keeper],
    [[id("RewardsUpdated(address,bytes32,uint256,uint64,uint64,string)")]], pin, context);
  const latestEvent = orderedRewardsEvent(rewardLogs);
  const global = await readGlobal(target, roles, pin, context);
  if (!rewardsEventAligns(latestEvent, global.keeper)) {
    throw new Error("LATEST_REWARDS_EVENT_KEEPER_MISMATCH");
  }
  return { discovery: { historicalFactoryCount: factories.size,
    currentFactoryCount: [...factoryState.values()].filter((row) => row.member).length,
    candidateVaultCount: candidates.size, currentVaultCount: current.length, registryEventCount: registryLogs.length,
    factoryCreationEventCount: factoryLogs.length, donationEventCount: donationLogs.length }, global,
  latestRewardsUpdated: latestEvent, vaults };
}

function exactComparable(value) { return JSON.stringify(jsonValue(value)); }
async function terminalCheck(rows, header, context) {
  for (const target of rows) {
    const response = await rpcRequest(target, "eth_getBlockByNumber", [quantity(header.number), false], context, null);
    const observed = response.ok ? parseHeader(response.result) : null;
    if (!observed || observed.number !== header.number || observed.hash !== header.hash || observed.timestamp !== header.timestamp) return false;
  }
  return true;
}

async function fetchDataset(cid, context, fetchImpl = fetch) {
  context.budget.publicGet(); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.caps.publicDatasetTimeoutMs);
  try {
    const response = await fetchImpl(`https://ipfs.io/ipfs/${cid}`, { method: "GET", redirect: "error",
      headers: { accept: "application/json" }, signal: controller.signal });
    if (response.redirected || response.status < 200 || response.status >= 300) return { available: false, reason: "PUBLIC_GET_HTTP_FAILURE", value: null };
    const body = await readBodyLimited(response, context, controller, true);
    try { return { available: true, reason: null, value: JSON.parse(body) }; }
    catch (_) { return { available: false, reason: "PUBLIC_GET_JSON_INVALID", value: null }; }
  } catch (error) { return { available: false, reason: controller.signal.aborted ? "PUBLIC_GET_CANCELED" : "PUBLIC_GET_FAILURE", value: null }; }
  finally { clearTimeout(timer); }
}

function sanitizeOutput(value) {
  const stack = [value];
  while (stack.length) {
    const current = stack.pop(); if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (/^(?:url|endpoint|endpointUrl|endpointHash|provider|providerHash|hostname|domain|headers|rawResponse|requestBody)$/iu.test(key)) throw new Error("PROVIDER_MATERIAL_IN_OUTPUT");
      if (typeof child === "string" && /(?:https?|wss?):\/\//iu.test(child)) throw new Error("URL_IN_OUTPUT");
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return value;
}
function atomicWrite(outputPath, value) {
  const bytes = Buffer.from(`${JSON.stringify(jsonValue(sanitizeOutput(value)), null, 2)}\n`, "utf8");
  if (bytes.length > CAPS.maxOutputBytes) throw new Error("OUTPUT_BYTES_EXCEEDED");
  const temporary = `${outputPath}.${process.pid}.tmp`; const fd = fs.openSync(temporary, "wx");
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.linkSync(temporary, outputPath); fs.unlinkSync(temporary); }
  catch (error) { try { fs.unlinkSync(temporary); } catch (_) {} throw error; }
}

function isBoundDependencyPath(absolutePath) {
  const normalized = absolutePath.replace(/\\/gu, "/").toLowerCase();
  return /\/node_modules\/(?:ethers\/|@noble\/|@adraffy\/|ws\/)/u.test(normalized) && /\.(?:js|json)$/u.test(normalized);
}

function loadedDependencyGraph() {
  return Object.values(require.cache).map((module) => module && module.filename).filter((filename) =>
    typeof filename === "string" && isBoundDependencyPath(filename)).map((filename) => {
    const bytes = fs.readFileSync(filename);
    return { path: path.relative(ROOT, filename).replace(/\\/gu, "/"), bytes: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function dependencyGraphAggregate(records) {
  return crypto.createHash("sha256").update(records.map((row) => `${row.path}:${row.sha256}`).sort().join("\n")).digest("hex");
}

function fileRecords(paths, readFile = fs.readFileSync) {
  return paths.map((relative) => { const bytes = readFile(workspacePath(relative));
    return { path: relative, bytes: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function verifyFileRecords(expected, requiredPaths, options = {}) {
  const readFile = options.readFile || fs.readFileSync;
  if (!Array.isArray(expected) || JSON.stringify(expected.map((row) => row.path).sort()) !==
    JSON.stringify([...requiredPaths].sort())) throw new Error(options.pathError || "LOCAL_INPUT_PATH_SET_MISMATCH");
  const buffers = new Map();
  for (const row of expected) {
    const bytes = readFile(workspacePath(row.path));
    if (bytes.length !== row.bytes || crypto.createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
      throw new Error(options.fileError || "LOCAL_INPUT_FILE_MISMATCH");
    }
    buffers.set(row.path, Buffer.from(bytes));
  }
  return options.returnBuffers === true ? buffers : true;
}

function assertArtifactPathSet(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length !== REQUIRED_ARTIFACT_PATHS.length ||
    JSON.stringify(artifacts.map((row) => row.path).sort()) !== JSON.stringify([...REQUIRED_ARTIFACT_PATHS].sort())) {
    throw new Error("ARTIFACT_PATH_SET_MISMATCH");
  }
  return true;
}

function packageAggregate(value) {
  const records = [
    ...(value.artifacts || []).map((row) => `artifacts:${row.path}:${row.sha256}`),
    ...(value.runtimeDependencyGraph || []).map((row) => `runtime:${row.path}:${row.sha256}`),
    ...(value.localInputs || []).map((row) => `localInputs:${row.path}:${row.sha256}`)
  ];
  return crypto.createHash("sha256").update(records.sort().join("\n")).digest("hex");
}

function verifyDependencyGraph(expected, options = {}) {
  const observed = options.observed || loadedDependencyGraph(); const readFile = options.readFile || fs.readFileSync;
  if (!Array.isArray(expected) || JSON.stringify(expected.map((row) => row.path).sort()) !==
    JSON.stringify(observed.map((row) => row.path).sort())) throw new Error("DEPENDENCY_GRAPH_PATH_SET_MISMATCH");
  for (const row of expected) {
    const bytes = readFile(workspacePath(row.path));
    if (bytes.length !== row.bytes || crypto.createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
      throw new Error("DEPENDENCY_FILE_MISMATCH");
    }
  }
  if (dependencyGraphAggregate(expected) !== dependencyGraphAggregate(observed)) throw new Error("DEPENDENCY_GRAPH_AGGREGATE_MISMATCH");
  return true;
}

function verifyRuntimeBeforeInventory(options = {}) {
  const readFile = options.readFile || fs.readFileSync;
  const manifest = options.manifest || JSON.parse(readFile(workspacePath(MANIFEST_REL), "utf8"));
  assertArtifactPathSet(manifest.artifacts);
  if (packageAggregate(manifest) !== manifest.aggregateSha256) throw new Error("PACKAGE_AGGREGATE_MISMATCH");
  verifyDependencyGraph(manifest.runtimeDependencyGraph, { readFile });
  const localBuffers = verifyFileRecords(manifest.localInputs, LOCAL_INPUT_RELS, { readFile, returnBuffers: true });
  verifyFileRecords(manifest.artifacts, REQUIRED_ARTIFACT_PATHS, { readFile,
    pathError: "ARTIFACT_PATH_SET_MISMATCH", fileError: "ARTIFACT_FILE_MISMATCH" });
  const parsedDeployment = parseDeploymentBuffer(localBuffers.get("targets/stakewise-v3-core-v5.0.1/deployments/mainnet.json"));
  const packageLock = deepFreeze(JSON.parse(localBuffers.get("tools/package-lock.json").toString("utf8")));
  const packageJson = deepFreeze(JSON.parse(localBuffers.get("tools/package.json").toString("utf8")));
  return deepFreeze({ deployment: parsedDeployment.deployment, roles: parsedDeployment.roles,
    localConfig: { packageLock, packageJson } });
}

function runtimeBinding(verifiedLocalConfig = null) {
  const lock = verifiedLocalConfig ? verifiedLocalConfig.packageLock :
    JSON.parse(fs.readFileSync(path.join(__dirname, "package-lock.json"), "utf8"));
  const packages = lock.packages || {};
  const closureNames = ["ethers", "@adraffy/ens-normalize", "@noble/curves", "@noble/hashes", "@types/node", "aes-js", "tslib", "undici-types", "ws"];
  const loadedEntryAbsolute = require.resolve("ethers"); const loadedEntryBytes = fs.readFileSync(loadedEntryAbsolute);
  const graph = loadedDependencyGraph();
  return { nodeVersion: process.version, ethersVersion,
    loadedEntry: { path: path.relative(__dirname, loadedEntryAbsolute).replace(/\\/gu, "/"),
      bytes: loadedEntryBytes.length, sha256: crypto.createHash("sha256").update(loadedEntryBytes).digest("hex") },
    loadedDependencyGraphCount: graph.length, loadedDependencyGraphAggregate: dependencyGraphAggregate(graph),
    dependencyClosure: closureNames.map((name) => { const row = packages[`node_modules/${name}`];
      return { name, version: row.version, integrity: row.integrity || null,
        packageJsonPath: `node_modules/${name}/package.json` }; }) };
}

function dryPreflight() {
  return { schemaVersion: 6, findingId: FINDING_ID, status: "R6_CURRENT_STATE_DIAGNOSTIC_PREPARED_NOT_EXECUTED_R1_R2_R3_R4_R5_UNCHANGED",
    nullConclusions: NULL_CONCLUSIONS,
    scope: { chain: "ethereum-mainnet", chainId: 1, chains: 1 },
    invocation: { exactCaptureFlag: CAPTURE_FLAG, runIdFormat: "swv3diag6-YYYYMMDDTHHMMSSZ-32lowerhex",
      freshOneShotRunIdRequired: true, outputTemplate: `${OUTPUT_DIR_REL}/${PREFIX}-<run-id>.json`, retries: 0 },
    providerPolicy: { inventoryFile: "rpc_endpoints.txt", processOnly: true, materialPersisted: false,
      hostnameConsensusPromotable: false, backendIndependenceProven: false, allResultsNonpromotable: true,
      singleFamilyDiagnosticAllowed: true },
    methods: { allowed: [...ALLOWED_METHODS].sort(), forbidden: [...FORBIDDEN_METHODS].sort() },
    correctness: { membershipNullFatal: true, requiredCodeUsesRecordPresent: true,
      verifiedDeploymentBufferReusedWithoutReread: true, immutableRequiredArtifactPathSet: true,
      stagedTypeAwareReads: true, identityOnlyPreservesIdentityAndSkipsUnsupportedState: true,
      metaSkipsVaultMevAndKeeper: true, localInputsVerifiedBeforeInventory: true,
      upgradesAndGovernorInputsUsed: false,
      allCriticalReadsRequired: true, concurrentRequestsSettled: true,
      oneBehindPredicate: "canHarvest&& !isHarvestRequired && !stateUpdateRequired && vaultNonce+1==globalNonce",
      datasetSchema: "complete-openzeppelin-standard-v1[address,int160,uint160]", merkleProofRequired: true,
      datasetCompleteCoverageRequired: true, economics: null, applicability: null, exactAffectedSemantics: null,
      ownMevSupported: false, latestEventKeeperAlignmentRequired: true,
      routePositiveCanBeTrue: null },
    runtime: runtimeBinding(), rolesRequired: ROLE_KEYS, caps: CAPS,
    gates: { deploymentApplicabilityCandidate: null, routePositive: null, executableNow: null,
      promotable: false, signedActionJustified: false, fork: false }, networkReads: 0, inventoryReads: 0, writes: 0 };
}

function terminalFailure(runId, reasonCode, context, qualification = null) {
  return { schemaVersion: 6, findingId: FINDING_ID, runId, status: "R6_TERMINAL_NONPROMOTABLE_FAILURE",
    nullConclusions: NULL_CONCLUSIONS,
    reasonCode, chain: { chainId: 1, name: "ethereum-mainnet" }, qualification,
    completeness: { allCriticalReadsPresent: false, missingRequiredFields: context.missingRequiredFields },
    accounting: context.accounting.snapshot(), budget: context.budget.summary(),
    gates: { deploymentApplicabilityCandidate: null, routePositive: null, executableNow: null, promotable: false,
      signedActionJustified: false, fork: false }, retryAllowed: false, terminal: true };
}

async function runCapture(args, dependencies = {}) {
  const caps = dependencies.caps || CAPS;
  const context = { caps, budget: new Budget(caps, dependencies.now || (() => Date.now())), accounting: new Accounting(),
    nextId: 0, missingRequiredFields: [] };
  const outputPath = dependencies.outputPath || outputPathForRunId(args.runId); let result; let qualification = null;
  try {
    const bundle = (dependencies.verifyRuntimeBeforeInventory || verifyRuntimeBeforeInventory)();
    if (!bundle || !bundle.deployment || !bundle.roles || !bundle.localConfig) throw new Error("VERIFIED_BUNDLE_INVALID");
    const inventory = (dependencies.loadInventory || loadInventory)();
    qualification = await (dependencies.qualify || qualify)(inventory, context);
    if (!qualification.selected || qualification.selected.mode === "UNAVAILABLE") throw new Error("NO_CHAIN1_FINALIZED_FAMILY");
    const selected = qualification.selected; const familyCaptures = [];
    for (const target of selected.rows) familyCaptures.push(await (dependencies.captureFamily || captureFamily)(target, bundle, selected.header.number, context));
    const familyAgreement = familyCaptures.length === 2 ? exactComparable(familyCaptures[0]) === exactComparable(familyCaptures[1]) : null;
    const terminalPin = await (dependencies.terminalCheck || terminalCheck)(selected.rows, selected.header, context);
    const capture = familyCaptures[0];
    const datasetFetch = await (dependencies.fetchDataset || fetchDataset)(capture.latestRewardsUpdated.cid, context);
    const eligibleDatasetVaults = capture.vaults.filter((vault) => vault.requiredReadsComplete === true && vault.meta === false);
    const stored = new Map(eligibleDatasetVaults.map((vault) => [vault.address,
      { rewardAssets: vault.rewardAssets, unlockedMevAssets: vault.unlockedMevAssets }]));
    const parsedDataset = datasetFetch.available ? parseRewardsDataset(datasetFetch.value,
      [capture.global.keeper.rewardsRoot, capture.global.keeper.prevRewardsRoot], eligibleDatasetVaults.map((vault) => vault.address), stored) :
      { verified: false, completeForDiscovered: false, reason: datasetFetch.reason, root: null, rows: new Map(),
        rowCount: 0, missingDiscoveredVaults: eligibleDatasetVaults.map((vault) => vault.address) };
    const account = context.accounting.snapshot();
    const requiredReadsComplete = capture.vaults.every((vault) => vault.requiredReadsComplete === true);
    const currentStateComplete = terminalPin && familyAgreement === true && requiredReadsComplete &&
      account.allStartedSettled && account.counterEquationValid && context.budget.summary().allWithinCaps;
    const allComplete = currentStateComplete && parsedDataset.verified === true &&
      parsedDataset.completeForDiscovered === true;
    for (const vault of capture.vaults) {
      const proofRow = parsedDataset.verified ? parsedDataset.rows.get(vault.address) || null : null;
      vault.oneBehind = vault.requiredReadsComplete === true && vault.meta === false ?
        vault.canHarvest === true && vault.isHarvestRequired === false && vault.stateUpdateRequired === false &&
          vault.keeperRewardsNonce + 1n === capture.global.keeper.rewardsNonce : null;
      vault.datasetProof = proofRow ? { verified: true, rootKind: proofRow.rootKind,
        reward: proofRow.reward, unlockedMevReward: proofRow.unlockedMevReward } : null;
      vault.applicability = null; vault.deploymentApplicabilityCandidate = null;
      vault.economics = null; vault.routePositive = null; vault.executableNow = null;
    }
    result = { schemaVersion: 6, findingId: FINDING_ID, runId: args.runId,
      status: "R6_CURRENT_STATE_DIAGNOSTIC_NONPROMOTABLE_BACKEND_INDEPENDENCE_UNPROVEN",
      nullConclusions: NULL_CONCLUSIONS, reasonCode: null,
      chain: { chainId: 1, name: "ethereum-mainnet", finalizedBlockNumber: selected.header.number,
        finalizedBlockHash: selected.header.hash, finalizedBlockTimestamp: selected.header.timestamp },
      qualification: { attemptedFamilyCount: qualification.attemptedFamilyCount,
        qualifyingFamilyCount: qualification.qualifyingFamilyCount, selectedFamilyCount: selected.rows.length,
        mode: selected.mode, hostnameConsensus: selected.hostnameConsensus, backendIndependenceProven: false,
        familyStateAgreement: familyAgreement, terminalPinNumberHashTimestampMatch: terminalPin },
      completeness: { allComplete, currentStateComplete, requiredReadsComplete, familyAgreement: familyAgreement === true,
        terminalPin: terminalPin === true, datasetComplete: parsedDataset.completeForDiscovered === true,
        missingRequiredFields: context.missingRequiredFields, incompleteVaultCount:
          capture.vaults.filter((vault) => vault.requiredReadsComplete !== true).length, membershipNullFatal: true },
      discovery: capture.discovery, keeperAndOsToken: capture.global,
      latestRewardsUpdated: capture.latestRewardsUpdated,
      dataset: { fetchAvailable: datasetFetch.available, verified: parsedDataset.verified, reason: parsedDataset.reason,
        root: parsedDataset.root, rootKind: parsedDataset.root === capture.global.keeper.rewardsRoot ? "CURRENT" :
          parsedDataset.root === capture.global.keeper.prevRewardsRoot ? "PREVIOUS" : null,
        completeForDiscovered: parsedDataset.completeForDiscovered, totalRows: parsedDataset.rowCount,
        discoveredVerifiedRows: parsedDataset.rows.size, missingDiscoveredVaults: parsedDataset.missingDiscoveredVaults },
      vaults: capture.vaults, diagnosticPolicy: { pendingDonationObservable: false,
        exactAffectedSemantics: null, economics: null, upperBounds: null, capacitySweeps: null,
        deploymentApplicabilityCandidate: null, applicability: null, routePositive: null, executableNow: null },
      accounting: account, budget: context.budget.summary(), runtime: runtimeBinding(bundle.localConfig),
      gates: { deploymentApplicabilityCandidate: null, applicability: null, economics: null,
        routePositive: null, executableNow: null, promotable: false, promotionBlocker: "BACKEND_INDEPENDENCE_UNPROVEN",
        signedActionJustified: false, fork: false },
      persistence: { publicContractAddresses: true, providerMaterial: false, rawResponses: false }, retryAllowed: false, terminal: true };
  } catch (error) {
    const reason = String(error.message || error);
    result = terminalFailure(args.runId, /^[A-Z0-9_]{3,128}$/u.test(reason) ? reason : "CAPTURE_FAILED", context,
      qualification ? { attemptedFamilyCount: qualification.attemptedFamilyCount,
        qualifyingFamilyCount: qualification.qualifyingFamilyCount } : null);
  }
  const accounting = context.accounting.snapshot();
  if (!accounting.allStartedSettled || !accounting.counterEquationValid || !context.budget.summary().allWithinCaps) {
    result = terminalFailure(args.runId, !accounting.allStartedSettled ? "REQUESTS_NOT_SETTLED" :
      !accounting.counterEquationValid ? "ACCOUNTING_COUNTER_MISMATCH" : "BUDGET_NOT_WITHIN_CAPS", context);
  }
  (dependencies.writeOutput || atomicWrite)(outputPath, result); return result;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.checkOnly) { process.stdout.write(`${JSON.stringify(dryPreflight(), null, 2)}\n`); return; }
  const result = await runCapture(args);
  process.stdout.write(`${JSON.stringify({ status: result.status, runId: result.runId, terminal: true, promotable: false,
    routePositive: null, executableNow: null, retryAllowed: false })}\n`);
}
if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });

module.exports = { Accounting, ALLOWED_METHODS, FORBIDDEN_METHODS, Budget, CAPS, CAPTURE_FLAG, FINDING_ID, FIXTURE_REL,
  INT160_MAX, INT160_MIN, LOCAL_INPUT_RELS, MANIFEST_REL, NULL_CONCLUSIONS, PREFIX, PREFLIGHT_REL,
  REPORT_REL, REQUIRED_ARTIFACT_PATHS, ROLE_KEYS, RUN_ID_PATTERN, TRUSTED_IDS, UINT160_MAX, RequestGroup,
  assertArtifactPathSet, atomicWrite, choosePin, deepFreeze, dependencyGraphAggregate, dryPreflight,
  fileRecords, hashPair, identityDiagnosticRow, loadedDependencyGraph, outputPathForRunId,
  globalIntegrity, orderedRewardsEvent, packageAggregate, parseArgs, parseRewardsDataset, proofForIndex,
  parseDeploymentBuffer, readVault, requiredBatch, requiredCode, requiredCodeRecord, rewardsEventAligns,
  rpcRequest, runCapture, runtimeBinding, sanitizeOutput, stagedReadPlan, standardLeaf, trustedClassification, validateFreshRunId,
  verifyDependencyGraph, verifyFileRecords, verifyProof, verifyRuntimeBeforeInventory, reused: { step2 } };
