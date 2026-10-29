#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  AbiCoder, Interface, concat, getAddress, id, keccak256, version: ethersVersion
} = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY_PATH = path.join(ROOT, "rpc_endpoints.txt");
const PREFIX = "critical-stakewise-v3-mainnet-deployment-economics-successor-r9";
const FINDING_ID = "stakewise-v3-direct-vault-global-state-diagnostic-r9";
const CAPTURE_FLAG = "--capture-stakewise-mainnet-r9-once";
const RUN_ID_PATTERN = /^swv3diag9-(\d{8}T\d{6}Z)-([0-9a-f]{32})$/u;
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
const FLASH_LOAN_SOURCE_CAP_SHARES = 100_000n * 10n ** 18n;
const NULL_CONCLUSIONS = Object.freeze({ economics: null, applicability: null, capacitySweeps: null,
  exactAffectedSemantics: null });
const REQUIRED_ARTIFACT_PATHS = Object.freeze([
  "tools/critical-stakewise-v3-mainnet-deployment-economics-successor-r9-runner.js",
  "tools/test-critical-stakewise-v3-mainnet-deployment-economics-successor-r9.js",
  "tools/validate-critical-stakewise-v3-mainnet-deployment-economics-successor-r9.js",
  "tools/fixtures/critical-stakewise-v3-mainnet-deployment-economics-successor-r9-fixtures.json",
  "reports/critical-stakewise-v3-mainnet-deployment-economics-successor-r9.md",
  "reports/raw/fast/critical-stakewise-v3-mainnet-deployment-economics-successor-r9-preflight.json"
]);
const LOCAL_INPUT_RELS = Object.freeze([
  "targets/stakewise-v3-core-v5.0.1/deployments/mainnet.json",
  "tools/package.json", "tools/package-lock.json",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IVaultsRegistry.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IVaultVersion.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IVaultState.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IVaultAdmin.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IVaultBlocklist.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IVaultFee.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IVaultEnterExit.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IVaultMev.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IKeeper.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IEthCommunityVault.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IEthFoxVault.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IOsTokenConfig.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IOsTokenVaultController.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IOsToken.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IOsTokenRedeemer.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IOsTokenVaultEscrow.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/interfaces/IOsTokenFlashLoans.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/tokens/OsToken.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/tokens/OsTokenFlashLoans.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/vaults/modules/VaultImmutables.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/vaults/ethereum/custom/EthCommunityVault.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/vaults/ethereum/custom/EthFoxVault.sol",
  "targets/stakewise-v3-core-v5.0.1/contracts/vaults/ethereum/EthGenesisVault.sol"
]);

const ALLOWED_METHODS = new Set(["eth_call", "eth_chainId", "eth_getBalance", "eth_getBlockByNumber", "eth_getCode"]);
const FORBIDDEN_METHODS = new Set([
  "eth_estimateGas", "eth_getLogs", "eth_getStorageAt", "eth_getTransactionByHash", "eth_getTransactionReceipt",
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
  publicDatasetTimeoutMs: 10000,
  maxDescriptorHeaders: 16,
  maxHeaderNameBytes: 64,
  maxHeaderValueBytes: 2048,
  maxHeaderBytes: 8192,
  maxUrlsPerRecord: 16
});

const FACTORY_KEYS = Object.freeze([
  "VaultFactory", "PrivVaultFactory", "MetaVaultFactory", "PrivMetaVaultFactory", "BlocklistVaultFactory",
  "Erc20VaultFactory", "PrivErc20VaultFactory", "Erc20MetaVaultFactory", "PrivErc20MetaVaultFactory",
  "BlocklistErc20VaultFactory"
]);
const DIRECT_VAULT_KEYS = Object.freeze(["CommunityVault", "FoxVault", "GenesisVault"]);
const GLOBAL_ROLE_KEYS = Object.freeze(["VaultsRegistry", "Keeper", "SharedMevEscrow", "OsToken", "OsTokenConfig",
  "OsTokenVaultController", "OsTokenRedeemer", "OsTokenVaultEscrow", "OsTokenFlashLoans", "LegacyPoolEscrow"]);
const ROLE_KEYS = Object.freeze([...GLOBAL_ROLE_KEYS, ...DIRECT_VAULT_KEYS]);

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
  "function vaultId() view returns (bytes32)", "function admin() view returns (address)",
  "function blocklistManager() view returns (address)", "function capacity() view returns (uint256)",
  "function feePercent() view returns (uint16)", "function totalAssets() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function getShares(address) view returns (uint256)",
  "function getExitQueueData() view returns (uint128,uint128,uint128,uint128,uint256)",
  "function withdrawableAssets() view returns (uint256)", "function isStateUpdateRequired() view returns (bool)",
  "function mevEscrow() view returns (address)", "function convertToShares(uint256) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)"
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
  "function avgRewardPerSecond() view returns (uint256)", "function cumulativeFeePerShare() view returns (uint256)",
  "function keeper() view returns (address)", "function convertToShares(uint256) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)"
]);
const configAbi = new Interface([
  "function redeemer() view returns (address)",
  "function getConfig(address) view returns (uint128 liqBonusPercent,uint64 liqThresholdPercent,uint64 ltvPercent)"
]);
const tokenAbi = new Interface(["function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)", "function controllers(address) view returns (bool)",
  "function vaultController() view returns (address)"]);
const redeemerAbi = new Interface([
  "function getExitQueueData() view returns (uint256,uint256,uint256)", "function canProcessExitQueue() view returns (bool)"
]);
const vaultEscrowAbi = new Interface(["function liqThresholdPercent() view returns (uint64)",
  "function liqBonusPercent() view returns (uint256)", "function authenticator() view returns (address)"]);
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
  throw new Error("EXACT_R9_FLAG_AND_FRESH_RUN_ID_REQUIRED");
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
async function cancelResponseBody(response) {
  try {
    if (response && response.body && typeof response.body.cancel === "function") await response.body.cancel();
    else if (response && response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader(); if (typeof reader.cancel === "function") await reader.cancel();
    }
  } catch (_) {}
}
function sanitizedTransportReason(error, canceled = false) {
  if (canceled) return "REQUEST_CANCELED";
  const reason = String(error && error.message || error);
  return new Set(["REDIRECT_REJECTED", "HTTP_4XX", "HTTP_5XX", "HTTP_OTHER", "MALFORMED_JSON",
    "RPC_ENVELOPE_INVALID", "STREAMING_BODY_REQUIRED", "BUDGET_EXHAUSTED_SINGLE_RESPONSE_BYTES"])
    .has(reason) ? reason : "TRANSPORT_FAILURE";
}

function rpcRequest(target, method, params, context, group, fetchImpl = fetch) {
  if (!ALLOWED_METHODS.has(method) || FORBIDDEN_METHODS.has(method)) return Promise.resolve({ ok: false, reason: "METHOD_FORBIDDEN", result: null });
  context.budget.consume(method); context.accounting.start(method);
  const requestId = ++context.nextId; const controller = new AbortController();
  const promise = (async () => {
    const timer = setTimeout(() => controller.abort(), context.caps.requestTimeoutMs);
    try {
      const response = await fetchImpl(target.url, { method: "POST", redirect: "error",
        headers: { ...(target.headers || {}), "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }), signal: controller.signal });
      if (response.redirected || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
        const reason = response.redirected || response.status >= 300 && response.status < 400 ? "REDIRECT_REJECTED" :
          response.status >= 400 && response.status < 500 ? "HTTP_4XX" :
            response.status >= 500 && response.status < 600 ? "HTTP_5XX" : "HTTP_OTHER";
        await cancelResponseBody(response); throw new Error(reason);
      }
      const body = await readBodyLimited(response, context, controller, false);
      let parsed; try { parsed = JSON.parse(body); } catch (_) { throw new Error("MALFORMED_JSON"); }
      if (!parsed || parsed.jsonrpc !== "2.0" || parsed.id !== requestId || Object.prototype.hasOwnProperty.call(parsed, "error") ||
        !Object.prototype.hasOwnProperty.call(parsed, "result")) throw new Error("RPC_ENVELOPE_INVALID");
      context.accounting.finish(method, "succeeded"); return { ok: true, reason: null, result: parsed.result };
    } catch (error) {
      const canceled = controller.signal.aborted;
      const reason = sanitizedTransportReason(error, canceled);
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
  if (context && typeof context.decodedCall === "function") {
    try { return await context.decodedCall({ target, address, abi, fragment, args: args || [], pin }); }
    catch (_) { return null; }
  }
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
  if (context && typeof context.codeRecord === "function") {
    try { return await context.codeRecord({ target, address, pin }); } catch (_) { return null; }
  }
  const response = await request(target, "eth_getCode", [address, quantity(pin)], context, group);
  const code = response.ok ? strictHex(response.result) : null;
  if (code === null) return null;
  return code !== "0x" ? { present: true, runtimeCodeHash: keccak256(code), byteLength: (code.length - 2) / 2 } :
    { present: false, runtimeCodeHash: null, byteLength: 0 };
}
async function requiredBalance(target, address, pin, context, group) {
  if (context && typeof context.balance === "function") {
    try { return await context.balance({ target, address, pin }); } catch (_) { return null; }
  }
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
const FORBIDDEN_DESCRIPTOR_HEADERS = new Set(["host", "content-length", "connection", "keep-alive",
  "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authenticate",
  "proxy-authorization"]);
function normalizeEscapedSlashes(value) { return String(value).replace(/\\\//gu, "/"); }
function cleanUrlToken(value) {
  let token = normalizeEscapedSlashes(value).trim().replace(/^[<({\["']+/u, "");
  while (/[>)}\],.;!?"']$/u.test(token)) token = token.slice(0, -1);
  return token;
}
function validateEndpointUrl(value) {
  const token = cleanUrlToken(value); let parsed;
  try { parsed = new URL(token); } catch (_) { throw new Error("ENDPOINT_URL_INVALID"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || !parsed.hostname) {
    throw new Error("ENDPOINT_URL_UNSAFE");
  }
  return parsed.href;
}
function validateDescriptorHeaders(input) {
  const entries = Array.isArray(input) ? input : input && typeof input === "object" && !Array.isArray(input) ?
    Object.entries(input) : [];
  if (entries.length > CAPS.maxDescriptorHeaders) throw new Error("DESCRIPTOR_HEADER_COUNT_CAP");
  const output = {}; let total = 0;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
      throw new Error("DESCRIPTOR_HEADER_INVALID");
    }
    const rawName = entry[0].trim(); const value = entry[1].trim(); const name = rawName.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(rawName) || /[\0\r\n]/u.test(rawName) || /[\0\r\n]/u.test(value) ||
      FORBIDDEN_DESCRIPTOR_HEADERS.has(name)) throw new Error("DESCRIPTOR_HEADER_UNSAFE");
    if (Object.prototype.hasOwnProperty.call(output, name)) throw new Error("DESCRIPTOR_HEADER_DUPLICATE");
    const nameBytes = Buffer.byteLength(name); const valueBytes = Buffer.byteLength(value);
    if (nameBytes > CAPS.maxHeaderNameBytes || valueBytes > CAPS.maxHeaderValueBytes) throw new Error("DESCRIPTOR_HEADER_SIZE_CAP");
    total += nameBytes + valueBytes; if (total > CAPS.maxHeaderBytes) throw new Error("DESCRIPTOR_HEADER_AGGREGATE_CAP");
    output[name] = value;
  }
  if (output.origin) {
    let origin; try { origin = new URL(output.origin); } catch (_) { throw new Error("DESCRIPTOR_ORIGIN_INVALID"); }
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.hash) throw new Error("DESCRIPTOR_ORIGIN_UNSAFE");
    output.origin = origin.origin;
  }
  return Object.freeze(Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b))));
}
function descriptorKey(value) { return JSON.stringify([value.url, Object.entries(value.headers)]); }
function makeDescriptor(urlValue, headerEntries = [], suppliedFamily = null) {
  const url = validateEndpointUrl(urlValue); const headers = validateDescriptorHeaders(headerEntries);
  const family = new URL(url).hostname.toLowerCase();
  if (suppliedFamily !== null && (typeof suppliedFamily !== "string" || suppliedFamily.toLowerCase() !== family)) {
    throw new Error("DESCRIPTOR_FAMILY_MISMATCH");
  }
  return Object.freeze({ url, headers, family });
}
function chainAssignment(value) {
  const text = String(value).toLowerCase().replace(/[_-]+/gu, " ");
  if (/\b(?:ethereum|ethereum mainnet|eth mainnet)\b/u.test(text) ||
    /\b(?:chain(?:\s*id)?|network(?:\s*id)?)\s*[:=|]?\s*(?:1|0x1)\b/u.test(text) ||
    /^\s*(?:1|0x1)\s*$/u.test(text)) return "ETHEREUM";
  if (/\b(?:sepolia|hoodi|holesky|goerli|gnosis|chiado|arbitrum|optimism|base|polygon|bsc|binance|avalanche|fantom|scroll|linea|mantle|blast|hyperevm)\b/u.test(text) ||
    /\b(?:chain(?:\s*id)?|network(?:\s*id)?)\s*[:=|]?\s*(?!1\b)[0-9]+\b/u.test(text)) return "OTHER";
  if (/\b(?:chain|network)\s*[:=|]\s*[a-z][a-z0-9 ]*\b/u.test(text)) return "OTHER";
  return null;
}
function metadataFromLine(rawLine) {
  const entries = []; let line = rawLine; let invalid = false;
  line = line.replace(/\[origin:\s*([^\]\r\n]+)\]/giu, (_all, value) => {
    entries.push(["origin", value.trim()]); return " ";
  });
  line = line.replace(/\[header:\s*([^=\]\r\n]+)=([^\]\r\n]*)\]/giu, (_all, name, value) => {
    entries.push([name.trim(), value.trim()]); return " ";
  });
  if (/\[(?:origin|header):/iu.test(line)) invalid = true;
  return { line, entries, invalid };
}
function urlTokens(value) {
  const normalized = normalizeEscapedSlashes(value).replace(/[,;](?=https:\/\/)/giu, " ");
  return (normalized.match(/https:\/\/[^\s<>"'{}\[\]|]+/giu) || [])
    .slice(0, CAPS.maxUrlsPerRecord).map(cleanUrlToken).filter(Boolean);
}
function exactDescriptorObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return JSON.stringify(keys) === JSON.stringify(["headers", "url"]) ||
    JSON.stringify(keys) === JSON.stringify(["family", "headers", "url"]);
}
function collectJsonDescriptors(value, assignment, output, seen, depth = 0) {
  if (depth > 12 || output.length >= CAPS.maxInventoryEntries) return;
  if (Array.isArray(value)) { for (const item of value) collectJsonDescriptors(item, assignment, output, seen, depth + 1); return; }
  if (!value || typeof value !== "object") return;
  if (exactDescriptorObject(value)) {
    if (assignment !== "OTHER") {
      try {
        const descriptor = makeDescriptor(value.url, value.headers, Object.prototype.hasOwnProperty.call(value, "family") ? value.family : null);
        const key = descriptorKey(descriptor); if (!seen.has(key)) { seen.add(key); output.push(descriptor); }
      } catch (_) {}
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const next = chainAssignment(key) || assignment; collectJsonDescriptors(child, next, output, seen, depth + 1);
  }
}
function enforceDescriptorCaps(rows) {
  const families = new Set(); const output = [];
  for (const row of rows) {
    if (!families.has(row.family) && families.size >= CAPS.maxEndpointFamilies) continue;
    families.add(row.family); output.push(row); if (output.length >= CAPS.maxInventoryEntries) break;
  }
  return output;
}
function parseInventoryText(rawText) {
  if (typeof rawText !== "string" || Buffer.byteLength(rawText) > CAPS.maxInventoryBytes) throw new Error("INVENTORY_BYTES_EXCEEDED");
  const text = normalizeEscapedSlashes(rawText); const lines = text.split(/\r?\n/u);
  if (lines.length > CAPS.maxInventoryLines) throw new Error("INVENTORY_LINES_EXCEEDED");
  const output = []; const seen = new Set();
  try {
    const parsed = JSON.parse(text); collectJsonDescriptors(parsed, null, output, seen);
    return enforceDescriptorCaps(output);
  } catch (_) {}
  let section = null; let pendingEntries = [];
  for (const rawLine of lines) {
    if (output.length >= CAPS.maxInventoryEntries) break;
    const normalizedLine = normalizeEscapedSlashes(rawLine).trim();
    if (/^[{[]/u.test(normalizedLine)) {
      try {
        const parsedLine = JSON.parse(normalizedLine);
        collectJsonDescriptors(parsedLine, section, output, seen); pendingEntries = []; continue;
      } catch (_) {}
    }
    const metadata = metadataFromLine(rawLine); const line = metadata.line; const tokens = urlTokens(line);
    const withoutUrls = tokens.reduce((current, token) => current.replace(token, " "), line);
    const lineAssignment = chainAssignment(withoutUrls);
    const heading = /^\s*(?:#{1,6}\s+|\[[^\]]+\]\s*$|[A-Za-z0-9 _-]{2,80}:\s*$)/u.test(withoutUrls);
    if (heading) {
      if (lineAssignment) section = lineAssignment;
      else if (!/\b(?:rpc|endpoints?|providers?|urls?)\b/iu.test(withoutUrls)) section = null;
    }
    if (!tokens.length) {
      if (metadata.entries.length) pendingEntries = metadata.invalid ? [] : metadata.entries;
      continue;
    }
    const assignment = lineAssignment || section;
    if (assignment === "OTHER" || metadata.invalid) { pendingEntries = []; continue; }
    const structured = assignment === "ETHEREUM" || /\b(?:rpc|endpoint|provider|url)\b/iu.test(withoutUrls) ||
      /[|=,:\t]/u.test(withoutUrls);
    if (tokens.length > 1 && !structured) { pendingEntries = []; continue; }
    const entries = [...pendingEntries, ...metadata.entries]; pendingEntries = [];
    for (const token of tokens) {
      try {
        const descriptor = makeDescriptor(token, entries); const key = descriptorKey(descriptor);
        if (!seen.has(key)) { seen.add(key); output.push(descriptor); }
      } catch (_) {}
      if (output.length >= CAPS.maxInventoryEntries) break;
    }
  }
  return enforceDescriptorCaps(output);
}
function loadInventory() {
  const stat = fs.statSync(INVENTORY_PATH); if (stat.size > CAPS.maxInventoryBytes) throw new Error("INVENTORY_BYTES_EXCEEDED");
  return parseInventoryText(fs.readFileSync(INVENTORY_PATH, "utf8"));
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
async function qualify(targets, context, request = rpcRequest) {
  const observations = []; const buckets = {};
  const bucket = (name) => { buckets[name] = (buckets[name] || 0) + 1; };
  const seen = new Set(); const descriptors = [];
  for (const target of targets) { const key = descriptorKey(target); if (!seen.has(key)) { seen.add(key); descriptors.push(target); } }
  for (const target of descriptors) {
    const chainRow = await request(target, "eth_chainId", [], context, null);
    if (!chainRow.ok) { bucket(`CHAIN_ID_${chainRow.reason}`); continue; }
    const chainId = strictQuantity(chainRow.result);
    if (chainId !== 1n) { bucket(chainId === null ? "CHAIN_ID_INVALID" : "CHAIN_ID_MISMATCH"); continue; }
    const finalizedRow = await request(target, "eth_getBlockByNumber", ["finalized", false], context, null);
    if (!finalizedRow.ok) { bucket(`FINALIZED_${finalizedRow.reason}`); continue; }
    const header = parseHeader(finalizedRow.result);
    if (!header) { bucket("FINALIZED_INVALID"); continue; }
    bucket("QUALIFIED"); observations.push({ ...target, chainId: 1, header });
  }
  return { attemptedDescriptorCount: descriptors.length, attemptedFamilyCount: new Set(descriptors.map((row) => row.family)).size,
    qualifyingDescriptorCount: observations.length, qualifyingFamilyCount: new Set(observations.map((row) => row.family)).size,
    statusBuckets: Object.fromEntries(Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b))), selected: choosePin(observations) };
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

const DIRECT_VAULT_SPECS = Object.freeze([
  Object.freeze({ key: "CommunityVault", type: "EthCommunityVault", access: "PUBLIC", osTokenApplicable: true }),
  Object.freeze({ key: "FoxVault", type: "EthFoxVault", access: "BLOCKLIST", osTokenApplicable: false }),
  Object.freeze({ key: "GenesisVault", type: "EthGenesisVault", access: "PUBLIC", osTokenApplicable: true })
]);
function recordMissingRequired(context, fieldPath, reason) {
  if (!context || typeof fieldPath !== "string") return;
  if (!Array.isArray(context.missingRequiredFields)) context.missingRequiredFields = [];
  if (!context.missingRequiredFields.includes(fieldPath)) context.missingRequiredFields.push(fieldPath);
  if (!context.missingReadReasons) context.missingReadReasons = {};
  if (!context.missingReadReasons[fieldPath]) context.missingReadReasons[fieldPath] = reason;
  if (!context.reasonCode) context.reasonCode = "REQUIRED_READS_MISSING";
}
async function diagnosticBatch(fieldPath, tasks, context, options = {}) {
  const optional = new Set(options.optional || []);
  const rows = await Promise.all(Object.entries(tasks).map(async ([key, task]) => {
    let value; let reason = "NULL_OR_DECODE_FAILED";
    try { value = await task(); } catch (_) { value = null; reason = "CALL_REVERTED"; }
    if ((value === null || value === undefined) && !optional.has(key)) {
      recordMissingRequired(context, `${fieldPath}.${key}`, reason);
    }
    return [key, value === undefined ? null : value];
  }));
  return Object.fromEntries(rows);
}
function decodedQueue(value) {
  if (!value) return null;
  const row = { queuedShares: at(value, 0), unclaimedAssets: at(value, 1), totalExitingTickets: at(value, 2),
    totalExitingAssets: at(value, 3), totalTickets: at(value, 4) };
  return Object.values(row).some((item) => item === null) ? null : row;
}
function decodedConfig(value) {
  if (!value) return null;
  const row = { liqBonusPercent: at(value, 0), liqThresholdPercent: at(value, 1), ltvPercent: at(value, 2) };
  return Object.values(row).some((item) => item === null) ? null : row;
}
function decodedRewards(value) {
  if (!value) return null; const assets = at(value, 0); const nonce = at(value, 1);
  return assets === null || nonce === null ? null : { assets, nonce };
}
function valuesPresent(values) { return values.every((value) => value !== null && value !== undefined); }
function deriveOneBehind(keeperState, stateUpdateRequired, globalRewardsNonce) {
  if (!keeperState || !keeperState.rewards || !valuesPresent([keeperState.canHarvest,
    keeperState.harvestRequired, stateUpdateRequired, keeperState.rewards.nonce, globalRewardsNonce])) return null;
  return keeperState.canHarvest === true && keeperState.harvestRequired === false && stateUpdateRequired === false &&
    keeperState.rewards.nonce + 1n === globalRewardsNonce;
}
function dedupBalanceReader(target, pin, context, read = requiredBalance) {
  const cache = new Map();
  return (address) => { if (!address) return Promise.resolve(null); if (!cache.has(address)) {
    cache.set(address, read(target, address, pin, context, null));
  } return cache.get(address); };
}
async function readDirectVault(target, roles, spec, pin, context, balanceOf, globalRewardsNonce, familyPath) {
  const address = roles[spec.key];
  const vaultPath = `${familyPath}.vaults.${spec.key}`;
  const identityTasks = {
    registryMember: async () => at(await decodedCall(target, roles.VaultsRegistry, registryAbi, "vaults", [address], pin, context, null), 0, "bool"),
    code: () => requiredCodeRecord(target, address, pin, context, null),
    implementation: async () => at(await decodedCall(target, address, vaultAbi, "implementation", [], pin, context, null), 0, "address"),
    vaultId: async () => at(await decodedCall(target, address, vaultAbi, "vaultId", [], pin, context, null), 0, "hex32"),
    version: async () => at(await decodedCall(target, address, vaultAbi, "version", [], pin, context, null), 0, "number"),
    admin: async () => at(await decodedCall(target, address, vaultAbi, "admin", [], pin, context, null), 0, "address")
  };
  if (spec.access === "BLOCKLIST") identityTasks.blocklistManager = async () => at(await decodedCall(target, address,
    vaultAbi, "blocklistManager", [], pin, context, null), 0, "address");
  const identity = await diagnosticBatch(`${vaultPath}.identity`, identityTasks, context);
  const implementation = identity.implementation ? await diagnosticBatch(`${vaultPath}.implementation`, {
    code: () => requiredCodeRecord(target, identity.implementation, pin, context, null),
    registryMember: async () => at(await decodedCall(target, roles.VaultsRegistry, registryAbi, "vaultImpls",
      [identity.implementation], pin, context, null), 0, "bool")
  }, context) : { code: null, registryMember: null };
  if (!identity.implementation) {
    recordMissingRequired(context, `${vaultPath}.implementation.code`, "DEPENDENCY_ADDRESS_MISSING");
    recordMissingRequired(context, `${vaultPath}.implementation.registryMember`, "DEPENDENCY_ADDRESS_MISSING");
  }
  const state = await diagnosticBatch(`${vaultPath}.state`, {
    capacity: async () => at(await decodedCall(target, address, vaultAbi, "capacity", [], pin, context, null), 0),
    feePercent: async () => at(await decodedCall(target, address, vaultAbi, "feePercent", [], pin, context, null), 0),
    totalAssets: async () => at(await decodedCall(target, address, vaultAbi, "totalAssets", [], pin, context, null), 0),
    totalShares: async () => at(await decodedCall(target, address, vaultAbi, "totalShares", [], pin, context, null), 0),
    withdrawableAssets: async () => at(await decodedCall(target, address, vaultAbi, "withdrawableAssets", [], pin, context, null), 0),
    stateUpdateRequired: async () => at(await decodedCall(target, address, vaultAbi, "isStateUpdateRequired", [], pin, context, null), 0, "bool"),
    queue: async () => decodedQueue(await decodedCall(target, address, vaultAbi, "getExitQueueData", [], pin, context, null)),
    mevEscrow: async () => at(await decodedCall(target, address, vaultAbi, "mevEscrow", [], pin, context, null), 0, "address"),
    nativeBalance: () => balanceOf(address)
  }, context);
  const mev = state.mevEscrow ? await diagnosticBatch(`${vaultPath}.mevEscrow`, {
    code: () => requiredCodeRecord(target, state.mevEscrow, pin, context, null),
    balance: () => balanceOf(state.mevEscrow) }, context) : { code: null, balance: null };
  if (!state.mevEscrow) {
    recordMissingRequired(context, `${vaultPath}.mevEscrow.code`, "DEPENDENCY_ADDRESS_MISSING");
    recordMissingRequired(context, `${vaultPath}.mevEscrow.balance`, "DEPENDENCY_ADDRESS_MISSING");
  }
  const keeper = await diagnosticBatch(`${vaultPath}.keeper`, {
    rewards: async () => decodedRewards(await decodedCall(target, roles.Keeper, keeperAbi, "rewards", [address], pin, context, null)),
    unlocked: async () => decodedRewards(await decodedCall(target, roles.Keeper, keeperAbi, "unlockedMevRewards", [address], pin, context, null)),
    canHarvest: async () => at(await decodedCall(target, roles.Keeper, keeperAbi, "canHarvest", [address], pin, context, null), 0, "bool"),
    harvestRequired: async () => at(await decodedCall(target, roles.Keeper, keeperAbi, "isHarvestRequired", [address], pin, context, null), 0, "bool"),
    collateralized: async () => at(await decodedCall(target, roles.Keeper, keeperAbi, "isCollateralized", [address], pin, context, null), 0, "bool")
  }, context);
  const osTokenConfig = spec.osTokenApplicable ? (await diagnosticBatch(`${vaultPath}.osToken`, {
    config: async () => decodedConfig(await decodedCall(target, roles.OsTokenConfig, configAbi,
      "getConfig", [address], pin, context, null)) }, context)).config : null;
  const genesis = spec.key === "GenesisVault" ? await diagnosticBatch(`${vaultPath}.legacyPoolEscrow`, {
    code: () => requiredCodeRecord(target, roles.LegacyPoolEscrow, pin, context, null),
    balance: () => balanceOf(roles.LegacyPoolEscrow),
    owner: async () => at(await decodedCall(target, roles.LegacyPoolEscrow, poolEscrowAbi, "owner", [], pin, context, null), 0, "address")
  }, context) : null;
  const expectedId = id(spec.type).toLowerCase();
  const required = [identity.registryMember, identity.code, identity.implementation, identity.vaultId, identity.version,
    identity.admin, implementation.code, implementation.registryMember, state.capacity, state.feePercent, state.totalAssets,
    state.totalShares, state.withdrawableAssets, state.stateUpdateRequired, state.queue, state.mevEscrow,
    state.nativeBalance, mev.code, mev.balance, keeper.rewards, keeper.unlocked, keeper.canHarvest,
    keeper.harvestRequired, keeper.collateralized];
  if (spec.access === "BLOCKLIST") required.push(identity.blocklistManager);
  if (spec.osTokenApplicable) required.push(osTokenConfig);
  if (genesis) required.push(genesis.code, genesis.balance, genesis.owner);
  const readsPresent = valuesPresent(required);
  const codeAndMembership = identity.code?.present === true && implementation.code?.present === true && mev.code?.present === true &&
    identity.registryMember === true && implementation.registryMember === true && identity.vaultId === expectedId &&
    (genesis === null || genesis.code?.present === true);
  for (const [pathSuffix, ok] of [["identity.code.present", identity.code?.present === true],
    ["identity.registryMember", identity.registryMember === true],
    ["identity.vaultIdMatchesExpected", identity.vaultId === expectedId],
    ["implementation.code.present", implementation.code?.present === true],
    ["implementation.registryMember", implementation.registryMember === true],
    ["mevEscrow.code.present", mev.code?.present === true],
    ["legacyPoolEscrow.code.present", genesis === null || genesis.code?.present === true]]) {
    if (!ok) recordMissingRequired(context, `${vaultPath}.${pathSuffix}`, "REQUIRED_INVARIANT_FALSE");
  }
  return { key: spec.key, address, expectedType: spec.type, expectedVaultId: expectedId, access: spec.access,
    osTokenApplicable: spec.osTokenApplicable, identity: { ...identity, vaultIdMatchesExpected: identity.vaultId === null ? null : identity.vaultId === expectedId,
      implementationCode: implementation.code, implementationRegistryMember: implementation.registryMember },
    state: { ...state, mevEscrowCode: mev.code, mevEscrowBalance: mev.balance }, keeper,
    oneBehind: deriveOneBehind(keeper, state.stateUpdateRequired, globalRewardsNonce),
    osTokenConfig, genesis: genesis ? { ...genesis, ownerMatchesVault: genesis.owner === null ? null : genesis.owner === address } : null,
    complete: readsPresent && codeAndMembership };
}
async function captureFamily(target, bundle, pin, context, familyPath = "families.unindexed") {
  const { roles } = bundle; const balanceOf = dedupBalanceReader(target, pin, context);
  const roleTasks = Object.fromEntries(GLOBAL_ROLE_KEYS.map((key) => [key,
    () => requiredCodeRecord(target, roles[key], pin, context, null)]));
  const roleCode = await diagnosticBatch(`${familyPath}.roles`, roleTasks, context);
  const keeper = await diagnosticBatch(`${familyPath}.keeper`, {
    rewardsNonce: async () => at(await decodedCall(target, roles.Keeper, keeperAbi, "rewardsNonce", [], pin, context, null), 0),
    rewardsRoot: async () => at(await decodedCall(target, roles.Keeper, keeperAbi, "rewardsRoot", [], pin, context, null), 0, "hex32"),
    prevRewardsRoot: async () => at(await decodedCall(target, roles.Keeper, keeperAbi, "prevRewardsRoot", [], pin, context, null), 0, "hex32"),
    lastRewardsTimestamp: async () => at(await decodedCall(target, roles.Keeper, keeperAbi, "lastRewardsTimestamp", [], pin, context, null), 0)
  }, context);
  const configState = await diagnosticBatch(`${familyPath}.osTokenConfig`, {
    default: async () => decodedConfig(await decodedCall(target, roles.OsTokenConfig, configAbi, "getConfig", [ZERO], pin, context, null)),
    redeemer: async () => at(await decodedCall(target, roles.OsTokenConfig, configAbi, "redeemer", [], pin, context, null), 0, "address")
  }, context);
  const defaultConfig = configState.default; const configRedeemer = configState.redeemer;
  const controller = await diagnosticBatch(`${familyPath}.controller`, {
    capacity: async () => at(await decodedCall(target, roles.OsTokenVaultController, controllerAbi, "capacity", [], pin, context, null), 0),
    totalAssets: async () => at(await decodedCall(target, roles.OsTokenVaultController, controllerAbi, "totalAssets", [], pin, context, null), 0),
    totalShares: async () => at(await decodedCall(target, roles.OsTokenVaultController, controllerAbi, "totalShares", [], pin, context, null), 0),
    feePercent: async () => at(await decodedCall(target, roles.OsTokenVaultController, controllerAbi, "feePercent", [], pin, context, null), 0),
    avgRewardPerSecond: async () => at(await decodedCall(target, roles.OsTokenVaultController, controllerAbi, "avgRewardPerSecond", [], pin, context, null), 0),
    cumulativeFeePerShare: async () => at(await decodedCall(target, roles.OsTokenVaultController, controllerAbi, "cumulativeFeePerShare", [], pin, context, null), 0),
    keeper: async () => at(await decodedCall(target, roles.OsTokenVaultController, controllerAbi, "keeper", [], pin, context, null), 0, "address"),
    sharesPerWad: async () => at(await decodedCall(target, roles.OsTokenVaultController, controllerAbi, "convertToShares", [10n ** 18n], pin, context, null), 0),
    assetsPerWad: async () => at(await decodedCall(target, roles.OsTokenVaultController, controllerAbi, "convertToAssets", [10n ** 18n], pin, context, null), 0)
  }, context);
  const token = await diagnosticBatch(`${familyPath}.token`, {
    totalSupply: async () => at(await decodedCall(target, roles.OsToken, tokenAbi, "totalSupply", [], pin, context, null), 0),
    vaultController: async () => at(await decodedCall(target, roles.OsToken, tokenAbi, "vaultController", [], pin, context, null), 0, "address"),
    vaultControllerMappingEnabled: async () => at(await decodedCall(target, roles.OsToken, tokenAbi, "controllers", [roles.OsTokenVaultController], pin, context, null), 0, "bool"),
    flashLoansAuthorized: async () => at(await decodedCall(target, roles.OsToken, tokenAbi, "controllers", [roles.OsTokenFlashLoans], pin, context, null), 0, "bool")
  }, context, { optional: ["vaultController", "vaultControllerMappingEnabled"] });
  token.immutableAuthorization = { getterAvailable: token.vaultController !== null,
    value: token.vaultController, expected: roles.OsTokenVaultController,
    matchesManifest: token.vaultController === null ? null : token.vaultController === roles.OsTokenVaultController };
  if (token.immutableAuthorization.getterAvailable && token.immutableAuthorization.matchesManifest !== true) {
    recordMissingRequired(context, `${familyPath}.token.immutableAuthorization.matchesManifest`,
      "IMMUTABLE_CONTROLLER_MISMATCH");
  }
  token.mappingAuthorization = { diagnosticOnly: true, value: token.vaultControllerMappingEnabled };
  const redeemer = await diagnosticBatch(`${familyPath}.redeemer`, {
    queue: async () => { const value = await decodedCall(target, roles.OsTokenRedeemer, redeemerAbi, "getExitQueueData", [], pin, context, null);
      if (!value) return null; const row = { queuedShares: at(value, 0), unclaimedAssets: at(value, 1), totalTickets: at(value, 2) };
      return valuesPresent(Object.values(row)) ? row : null; },
    canProcess: async () => at(await decodedCall(target, roles.OsTokenRedeemer, redeemerAbi, "canProcessExitQueue", [], pin, context, null), 0, "bool"),
    nativeBalance: () => balanceOf(roles.OsTokenRedeemer),
    osTokenBalance: async () => at(await decodedCall(target, roles.OsToken, tokenAbi, "balanceOf", [roles.OsTokenRedeemer], pin, context, null), 0)
  }, context);
  const vaultEscrow = await diagnosticBatch(`${familyPath}.vaultEscrow`, {
    liqThresholdPercent: async () => at(await decodedCall(target, roles.OsTokenVaultEscrow, vaultEscrowAbi, "liqThresholdPercent", [], pin, context, null), 0),
    liqBonusPercent: async () => at(await decodedCall(target, roles.OsTokenVaultEscrow, vaultEscrowAbi, "liqBonusPercent", [], pin, context, null), 0),
    authenticator: async () => at(await decodedCall(target, roles.OsTokenVaultEscrow, vaultEscrowAbi, "authenticator", [], pin, context, null), 0, "address"),
    nativeBalance: () => balanceOf(roles.OsTokenVaultEscrow),
    osTokenBalance: async () => at(await decodedCall(target, roles.OsToken, tokenAbi, "balanceOf", [roles.OsTokenVaultEscrow], pin, context, null), 0)
  }, context);
  const sharedEscrow = await diagnosticBatch(`${familyPath}.sharedEscrow`, {
    nativeBalance: () => balanceOf(roles.SharedMevEscrow) }, context);
  const flashRead = await diagnosticBatch(`${familyPath}.flashLoans`, {
    sourceCapAssets: async () => at(await decodedCall(target, roles.OsTokenVaultController, controllerAbi,
      "convertToAssets", [FLASH_LOAN_SOURCE_CAP_SHARES], pin, context, null), 0)
  }, context);
  const flashLoans = { label: "SOURCE_CAP_SENSITIVITY_ONLY", sourceCapShares: FLASH_LOAN_SOURCE_CAP_SHARES,
    sourceCapAssets: flashRead.sourceCapAssets, controllerAuthorized: token.flashLoansAuthorized,
    flashContractCode: roleCode.OsTokenFlashLoans, tokenCode: roleCode.OsToken, flashFeasibility: null };
  const vaults = [];
  for (const spec of DIRECT_VAULT_SPECS) vaults.push(await readDirectVault(target, roles, spec, pin, context, balanceOf,
    keeper.rewardsNonce, familyPath));
  const globalRequired = [...Object.values(roleCode), ...Object.values(keeper), defaultConfig, configRedeemer,
    ...Object.values(controller), token.totalSupply, token.flashLoansAuthorized,
    ...Object.values(redeemer), ...Object.values(vaultEscrow),
    sharedEscrow.nativeBalance, flashLoans.sourceCapAssets, flashLoans.controllerAuthorized,
    flashLoans.flashContractCode, flashLoans.tokenCode];
  const immutableControllerValid = token.immutableAuthorization.getterAvailable ?
    token.immutableAuthorization.matchesManifest === true : true;
  for (const [fieldPath, ok] of Object.entries({
    [`${familyPath}.controller.keeperMatchesManifest`]: controller.keeper === roles.Keeper,
    [`${familyPath}.osTokenConfig.redeemerMatchesManifest`]: configRedeemer === roles.OsTokenRedeemer,
    [`${familyPath}.token.flashLoansAuthorized`]: token.flashLoansAuthorized === true
  })) if (!ok) recordMissingRequired(context, fieldPath, "REQUIRED_INVARIANT_FALSE");
  for (const [key, row] of Object.entries(roleCode)) if (row?.present !== true) {
    recordMissingRequired(context, `${familyPath}.roles.${key}.present`, "REQUIRED_CODE_ABSENT");
  }
  const complete = valuesPresent(globalRequired) && Object.values(roleCode).every((row) => row?.present === true) &&
    controller.keeper === roles.Keeper && configRedeemer === roles.OsTokenRedeemer && immutableControllerValid &&
    token.flashLoansAuthorized === true && vaults.every((row) => row.complete === true);
  return { scope: { officialManifestDirectVaultsOnly: true, fullVaultUniverse: false,
    directVaultKeys: DIRECT_VAULT_KEYS, factoryDiscovery: false, eventDiscovery: false, publicDataset: false },
  roleCode, keeper, osTokenConfig: { redeemer: configRedeemer, default: defaultConfig }, controller, token,
  redeemer, vaultEscrow, sharedEscrow, flashLoans, vaults, complete };
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
  return { schemaVersion: 9, findingId: FINDING_ID, status: "R9_DIRECT_DIAGNOSTIC_PREPARED_NOT_EXECUTED_R1_THROUGH_R8_UNCHANGED",
    nullConclusions: NULL_CONCLUSIONS,
    scope: { chain: "ethereum-mainnet", chainId: 1, chains: 1, officialMainnetManifestDirectVaultsOnly: true,
      directVaultKeys: DIRECT_VAULT_KEYS, globalRoleKeys: GLOBAL_ROLE_KEYS, fullVaultUniverse: false,
      factoryDiscovery: false, eventDiscovery: false, publicDataset: false },
    invocation: { exactCaptureFlag: CAPTURE_FLAG, runIdFormat: "swv3diag9-YYYYMMDDTHHMMSSZ-32lowerhex",
      freshOneShotRunIdRequired: true, outputTemplate: `${OUTPUT_DIR_REL}/${PREFIX}-<run-id>.json`, retries: 0 },
    providerPolicy: { inventoryFile: "rpc_endpoints.txt", processOnly: true, materialPersisted: false,
      descriptorShape: "{url,headers,family}", descriptorDedupe: "EXACT_URL_AND_HEADERS",
      strictHttps: true, redirects: "ERROR", retries: 0, qualification: "SEQUENTIAL_CHAIN_ID_THEN_FINALIZED",
      hostnameConsensusPromotable: false, backendIndependenceProven: false, allResultsNonpromotable: true,
      twoFamilyFinalizedConsensusRequired: true, singleFamilyDiagnosticAllowed: false },
    methods: { allowed: [...ALLOWED_METHODS].sort(), forbidden: [...FORBIDDEN_METHODS].sort() },
    correctness: { membershipNullFatal: true, requiredCodeUsesRecordPresent: true,
      oracleAdapterCorrections: true, originAndHeaderUrlsNeverCandidates: true,
      non2xxBodiesCanceledWithoutRead: true, sanitizedStatusBuckets: true,
      verifiedDeploymentBufferReusedWithoutReread: true, immutableRequiredArtifactPathSet: true,
      localInputsVerifiedBeforeInventory: true, upgradesAndGovernorInputsUsed: false,
      exactDirectVaultCardinality: 3, completeDualFamilyReadsRequired: true,
      missingReadValuesAreNull: true, balanceReadsDeduplicated: true,
      fullyQualifiedMissingReadPaths: true, missingReadReasonCodes: true,
      vaultControllerMappingDiagnosticOnly: true, immutableVaultControllerGetterCheckedWhenAvailable: true,
      flashLoanSourceCapShares: FLASH_LOAN_SOURCE_CAP_SHARES.toString(),
      flashLoanMetric: "SOURCE_CAP_SENSITIVITY_ONLY", flashFeasibility: null,
      allCriticalReadsRequired: true, concurrentRequestsSettled: true,
      oneBehindPredicate: "canHarvest&& !isHarvestRequired && !stateUpdateRequired && vaultNonce+1==globalNonce",
      foxBlocklistAndNoOsToken: true, economics: null, applicability: null, exactAffectedSemantics: null,
      routePositiveCanBeTrue: null },
    runtime: runtimeBinding(), rolesRequired: ROLE_KEYS, caps: CAPS,
    gates: { deploymentApplicabilityCandidate: null, routePositive: null, executableNow: null,
      promotable: false, signedActionJustified: false, fork: false }, networkReads: 0, inventoryReads: 0, writes: 0 };
}

function terminalFailure(runId, reasonCode, context, qualification = null) {
  return { schemaVersion: 9, findingId: FINDING_ID, runId, status: "R9_TERMINAL_NONPROMOTABLE_FAILURE",
    nullConclusions: NULL_CONCLUSIONS,
    reasonCode, chain: { chainId: 1, name: "ethereum-mainnet" }, qualification,
    scope: { officialMainnetManifestDirectVaultsOnly: true, fullVaultUniverse: false,
      factoryDiscovery: false, eventDiscovery: false, publicDataset: false },
    completeness: { allCriticalReadsPresent: false, missingRequiredFields: context.missingRequiredFields,
      missingReadReasons: Object.fromEntries(Object.entries(context.missingReadReasons || {}).sort(([a], [b]) => a.localeCompare(b))) },
    accounting: context.accounting.snapshot(), budget: context.budget.summary(),
    gates: { deploymentApplicabilityCandidate: null, routePositive: null, executableNow: null, promotable: false,
      signedActionJustified: false, fork: false }, retryAllowed: false, terminal: true };
}

async function runCapture(args, dependencies = {}) {
  const caps = dependencies.caps || CAPS;
  const context = { caps, budget: new Budget(caps, dependencies.now || (() => Date.now())), accounting: new Accounting(),
    nextId: 0, missingRequiredFields: [], missingReadReasons: {}, reasonCode: null };
  const outputPath = dependencies.outputPath || outputPathForRunId(args.runId); let result; let qualification = null;
  try {
    const bundle = (dependencies.verifyRuntimeBeforeInventory || verifyRuntimeBeforeInventory)();
    if (!bundle || !bundle.deployment || !bundle.roles || !bundle.localConfig) throw new Error("VERIFIED_BUNDLE_INVALID");
    const inventory = (dependencies.loadInventory || loadInventory)();
    qualification = await (dependencies.qualify || qualify)(inventory, context);
    if (!qualification.selected || qualification.selected.mode === "UNAVAILABLE" ||
      qualification.selected.hostnameConsensus !== true || qualification.selected.rows.length !== 2) {
      throw new Error("TWO_FAMILY_FINALIZED_CONSENSUS_REQUIRED");
    }
    const selected = qualification.selected; const familyCaptures = [];
    for (let index = 0; index < selected.rows.length; index++) familyCaptures.push(await
      (dependencies.captureFamily || captureFamily)(selected.rows[index], bundle, selected.header.number, context,
        `families.${index}`));
    const familyAgreement = familyCaptures.length === 2 ? exactComparable(familyCaptures[0]) === exactComparable(familyCaptures[1]) : null;
    if (familyAgreement !== true) recordMissingRequired(context, "families.stateAgreement", "FAMILY_STATE_MISMATCH");
    const terminalPin = await (dependencies.terminalCheck || terminalCheck)(selected.rows, selected.header, context);
    if (terminalPin !== true) recordMissingRequired(context, "families.terminalPin", "TERMINAL_PIN_MISMATCH");
    const capture = familyCaptures[0];
    const account = context.accounting.snapshot();
    const dualReadsComplete = familyCaptures.length === 2 && familyCaptures.every((row) => row.complete === true);
    const currentStateComplete = terminalPin && familyAgreement === true && dualReadsComplete &&
      account.allStartedSettled && account.counterEquationValid && context.budget.summary().allWithinCaps;
    const allComplete = currentStateComplete;
    result = { schemaVersion: 9, findingId: FINDING_ID, runId: args.runId,
      status: "R9_DIRECT_VAULT_GLOBAL_DIAGNOSTIC_NONPROMOTABLE",
      nullConclusions: NULL_CONCLUSIONS, reasonCode: allComplete ? null :
        familyAgreement !== true ? "FAMILY_STATE_MISMATCH" : terminalPin !== true ? "TERMINAL_PIN_MISMATCH" :
          context.reasonCode || "REQUIRED_READS_MISSING",
      scope: { officialMainnetManifestDirectVaultsOnly: true, directVaultKeys: DIRECT_VAULT_KEYS,
        globalRoleKeys: GLOBAL_ROLE_KEYS, fullVaultUniverse: false, factoryDiscovery: false,
        eventDiscovery: false, publicDataset: false },
      chain: { chainId: 1, name: "ethereum-mainnet", finalizedBlockNumber: selected.header.number,
        finalizedBlockHash: selected.header.hash, finalizedBlockTimestamp: selected.header.timestamp },
      qualification: { attemptedDescriptorCount: qualification.attemptedDescriptorCount,
        attemptedFamilyCount: qualification.attemptedFamilyCount,
        qualifyingDescriptorCount: qualification.qualifyingDescriptorCount,
        qualifyingFamilyCount: qualification.qualifyingFamilyCount, statusBuckets: qualification.statusBuckets,
        selectedFamilyCount: selected.rows.length,
        mode: selected.mode, hostnameConsensus: selected.hostnameConsensus, backendIndependenceProven: false,
        familyStateAgreement: familyAgreement, terminalPinNumberHashTimestampMatch: terminalPin },
      completeness: { allComplete, currentStateComplete, dualReadsComplete,
        twoFamilyFinalizedConsensus: selected.rows.length === 2 && selected.hostnameConsensus === true,
        familyAgreement: familyAgreement === true, terminalPin: terminalPin === true,
        missingRequiredFields: context.missingRequiredFields,
        missingReadReasons: Object.fromEntries(Object.entries(context.missingReadReasons).sort(([a], [b]) => a.localeCompare(b))),
        incompleteVaultCount: capture.vaults.filter((vault) => vault.complete !== true).length },
      state: familyAgreement === true ? capture : null,
      diagnosticPolicy: { fullVaultUniverse: false, exactAffectedSemantics: null, economics: null,
        upperBounds: null, capacitySweeps: null,
        deploymentApplicabilityCandidate: null, applicability: null, routePositive: null, executableNow: null },
      accounting: account, budget: context.budget.summary(), runtime: runtimeBinding(bundle.localConfig),
      gates: { deploymentApplicabilityCandidate: null, applicability: null, economics: null,
        routePositive: null, executableNow: null, promotable: false, promotionBlocker: "BACKEND_INDEPENDENCE_UNPROVEN",
        signedActionJustified: false, fork: false },
      persistence: { publicContractAddresses: true, providerMaterial: false, rawResponses: false }, retryAllowed: false, terminal: true };
  } catch (error) {
    const reason = String(error.message || error);
    result = terminalFailure(args.runId, /^[A-Z0-9_]{3,128}$/u.test(reason) ? reason : "CAPTURE_FAILED", context,
      qualification ? { attemptedDescriptorCount: qualification.attemptedDescriptorCount,
        attemptedFamilyCount: qualification.attemptedFamilyCount,
        qualifyingDescriptorCount: qualification.qualifyingDescriptorCount,
        qualifyingFamilyCount: qualification.qualifyingFamilyCount, statusBuckets: qualification.statusBuckets } : null);
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
  FLASH_LOAN_SOURCE_CAP_SHARES, INT160_MAX, INT160_MIN, LOCAL_INPUT_RELS, MANIFEST_REL, NULL_CONCLUSIONS, PREFIX, PREFLIGHT_REL,
  REPORT_REL, REQUIRED_ARTIFACT_PATHS, ROLE_KEYS, GLOBAL_ROLE_KEYS, DIRECT_VAULT_KEYS, DIRECT_VAULT_SPECS,
  RUN_ID_PATTERN, TRUSTED_IDS, UINT160_MAX, RequestGroup, assertArtifactPathSet, at, atomicWrite,
  cancelResponseBody, captureFamily, chainAssignment, choosePin, cleanUrlToken,
  deepFreeze, dependencyGraphAggregate, deriveOneBehind, descriptorKey, dryPreflight, fileRecords, hashPair,
  identityDiagnosticRow, loadedDependencyGraph, makeDescriptor, metadataFromLine, normalizeEscapedSlashes,
  outputPathForRunId,
  decodedConfig, decodedQueue, decodedRewards, dedupBalanceReader, diagnosticBatch, globalIntegrity,
  orderedRewardsEvent, packageAggregate, parseArgs, parseRewardsDataset, proofForIndex,
  parseDeploymentBuffer, parseInventoryText, qualify, readDirectVault, readVault, recordMissingRequired,
  requiredBatch, requiredCode, requiredCodeRecord,
  rewardsEventAligns, rpcRequest, runCapture, runtimeBinding, sanitizeOutput, sanitizedTransportReason,
  stagedReadPlan, standardLeaf, trustedClassification, validateDescriptorHeaders, validateEndpointUrl,
  validateFreshRunId,
  valuesPresent, verifyDependencyGraph, verifyFileRecords, verifyProof, verifyRuntimeBeforeInventory };
