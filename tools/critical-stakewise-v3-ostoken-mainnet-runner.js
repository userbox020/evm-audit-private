#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Interface, getAddress, id, keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "stakewise-v3-core-v5.0.1");
const INVENTORY_PATH = path.join(ROOT, "rpc_endpoints.txt");
const FINDING_ID = "stakewise-v3-ostoken-mainnet-capture";
const CHAIN_ID = 1;
const PREFIX = "critical-stakewise-v3-ostoken-mainnet";
const FIXED_OUTPUT_REL = `reports/raw/fast/${PREFIX}-capture.json`;
const FIXED_APPROVAL_REL = `coordination/decisions/${PREFIX}-approval.json`;
const GLOBAL_LEDGER_REL = `coordination/decisions/${PREFIX}-consumption-ledger.json`;
const MANIFEST_REL = `reports/raw/fast/${PREFIX}-manifest.json`;
const SOURCE_MANIFEST_REL = `reports/raw/fast/${PREFIX}-source-closure-manifest.json`;
const PROPOSAL_REL = `reports/raw/fast/${PREFIX}-approval-proposal.json`;
const REVIEW_MANIFEST_REL = `reports/raw/fast/${PREFIX}-review-material-manifest.json`;
const REVIEW_REPORT_REL = `reports/${PREFIX}-v2-preflight.md`;
const FIXED_OUTPUT_PATH = rel(FIXED_OUTPUT_REL);
const GLOBAL_LEDGER_PATH = rel(GLOBAL_LEDGER_REL);
const MANIFEST_PATH = rel(MANIFEST_REL);
const SOURCE_MANIFEST_PATH = rel(SOURCE_MANIFEST_REL);
const PROPOSAL_PATH = rel(PROPOSAL_REL);
const REVIEW_MANIFEST_PATH = rel(REVIEW_MANIFEST_REL);

const ALLOWED_METHODS = new Set([
  "eth_chainId",
  "eth_getLogs",
  "eth_call",
  "eth_getCode",
  "eth_getBlockByNumber"
]);
const FORBIDDEN_METHODS = new Set([
  "eth_getStorageAt",
  "eth_estimateGas",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_sendRawTransaction",
  "eth_sendTransaction",
  "debug_traceCall",
  "debug_traceTransaction",
  "trace_call",
  "trace_transaction"
]);
const CAPS = Object.freeze({
  chains: 1,
  maxInventoryEntries: 48,
  maxInventoryBytes: 65536,
  maxInventoryLines: 1024,
  maxFamilies: 12,
  minHostnameDistinctFamilies: 2,
  maxTotalRequests: 30000,
  maxLogRequests: 8000,
  maxCallRequests: 18000,
  maxCodeRequests: 4500,
  maxBlockRequests: 2500,
  maxRetries: 48,
  retriesPerRequest: 1,
  maxLogs: 50000,
  maxUniqueEventBlocks: 2000,
  maxChunks: 8000,
  maxLogChunkBlocks: 25000,
  maxScanSpanBlocks: 30000000,
  minPlausiblePin: 1000000,
  maxPlausiblePin: 50000000,
  requestTimeoutMs: 8000,
  maxElapsedMs: 900000,
  maxResponseBytes: 1048576,
  maxAggregateResponseBytes: 67108864,
  maxFactories: 48,
  maxVaults: 1000,
  maxAuxiliaryControllers: 64,
  maxApprovalWindowMs: 600000,
  maxApprovalIssuedAgeMs: 180000,
  maxApprovalFutureSkewMs: 30000
});

const DEPLOYMENT_ROLE_KEYS = Object.freeze({
  token: "OsToken",
  controller: "OsTokenVaultController",
  config: "OsTokenConfig",
  redeemer: "OsTokenRedeemer",
  escrow: "OsTokenVaultEscrow",
  registry: "VaultsRegistry"
});
const FACTORY_KEYS = Object.freeze([
  "VaultFactory", "PrivVaultFactory", "MetaVaultFactory", "PrivMetaVaultFactory", "BlocklistVaultFactory",
  "Erc20VaultFactory", "PrivErc20VaultFactory", "Erc20MetaVaultFactory", "PrivErc20MetaVaultFactory",
  "BlocklistErc20VaultFactory"
]);
const SOURCE_SEEDS = Object.freeze([
  "deployments/mainnet.json",
  "contracts/tokens/OsToken.sol",
  "contracts/tokens/OsTokenVaultController.sol",
  "contracts/tokens/OsTokenConfig.sol",
  "contracts/tokens/OsTokenRedeemer.sol",
  "contracts/tokens/EthOsTokenRedeemer.sol",
  "contracts/tokens/OsTokenVaultEscrow.sol",
  "contracts/tokens/EthOsTokenVaultEscrow.sol",
  "contracts/vaults/modules/VaultOsToken.sol",
  "contracts/libraries/OsTokenUtils.sol"
]);
const PACKAGE_ARTIFACTS = Object.freeze([
  `tools/${PREFIX}-runner.js`,
  `tools/test-${PREFIX}.js`,
  `tools/validate-${PREFIX}.js`,
  `tools/fixtures/${PREFIX}-fixtures.json`,
  SOURCE_MANIFEST_REL
]);

const tokenInterface = new Interface([
  "function totalSupply() view returns (uint256)",
  "function controllers(address) view returns (bool)"
]);
const controllerInterface = new Interface([
  "function capacity() view returns (uint256)",
  "function treasury() view returns (address)",
  "function feePercent() view returns (uint64)",
  "function keeper() view returns (address)",
  "function avgRewardPerSecond() view returns (uint256)",
  "function cumulativeFeePerShare() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function totalAssets() view returns (uint256)"
]);
const configInterface = new Interface([
  "function redeemer() view returns (address)",
  "function getConfig(address) view returns (uint128 liqBonusPercent,uint64 liqThresholdPercent,uint64 ltvPercent)"
]);
const redeemerInterface = new Interface([
  "function exitQueueUpdateDelay() view returns (uint256)",
  "function queuedShares() view returns (uint128)",
  "function unclaimedAssets() view returns (uint128)",
  "function redeemedShares() view returns (uint128)",
  "function redeemedAssets() view returns (uint128)",
  "function swappedShares() view returns (uint128)",
  "function swappedAssets() view returns (uint128)",
  "function exitQueueTimestamp() view returns (uint256)",
  "function positionsManager() view returns (address)",
  "function nonce() view returns (uint256)",
  "function canProcessExitQueue() view returns (bool)",
  "function getExitQueueData() view returns (uint256,uint256,uint256)",
  "function redeemablePositions() view returns (bytes32,string)"
]);
const escrowInterface = new Interface([
  "function liqThresholdPercent() view returns (uint64)",
  "function liqBonusPercent() view returns (uint256)",
  "function authenticator() view returns (address)"
]);

const registryInterface = new Interface([
  "function vaults(address) view returns (bool)",
  "function vaultImpls(address) view returns (bool)",
  "function factories(address) view returns (bool)",
  "event VaultAdded(address indexed caller,address indexed vault)",
  "event VaultImplAdded(address indexed impl)",
  "event VaultImplRemoved(address indexed impl)",
  "event FactoryAdded(address indexed factory)",
  "event FactoryRemoved(address indexed factory)"
]);
const factoryInterface = new Interface([
  "function implementation() view returns (address)",
  "event VaultCreated(address indexed admin,address indexed vault,address ownMevEscrow,bytes params)",
  "event MetaVaultCreated(address indexed caller,address indexed admin,address indexed vault,bytes params)"
]);
const vaultInterface = new Interface([
  "function implementation() view returns (address)",
  "function version() view returns (uint8)",
  "function vaultId() view returns (bytes32)"
]);

function eventSpec(role, label, fragment) {
  const iface = new Interface([fragment]);
  const event = iface.fragments[0];
  return Object.freeze({ role, label, iface, topic: event.topicHash.toLowerCase() });
}

const EVENT_SPECS = Object.freeze([
  eventSpec("token", "ControllerUpdated", "event ControllerUpdated(address indexed controller,bool registered)"),
  eventSpec("controller", "Mint", "event Mint(address indexed vault,address indexed receiver,uint256 assets,uint256 shares)"),
  eventSpec("controller", "Burn", "event Burn(address indexed vault,address indexed owner,uint256 assets,uint256 shares)"),
  eventSpec("controller", "StateUpdated", "event StateUpdated(uint256 profitAccrued,uint256 treasuryShares,uint256 treasuryAssets)"),
  eventSpec("controller", "CapacityUpdated", "event CapacityUpdated(uint256 capacity)"),
  eventSpec("controller", "TreasuryUpdated", "event TreasuryUpdated(address indexed treasury)"),
  eventSpec("controller", "FeePercentUpdated", "event FeePercentUpdated(uint16 feePercent)"),
  eventSpec("controller", "AvgRewardPerSecondUpdated", "event AvgRewardPerSecondUpdated(uint256 avgRewardPerSecond)"),
  eventSpec("controller", "KeeperUpdated", "event KeeperUpdated(address keeper)"),
  eventSpec("config", "ConfigUpdated", "event OsTokenConfigUpdated(address vault,uint128 liqBonusPercent,uint64 liqThresholdPercent,uint64 ltvPercent)"),
  eventSpec("config", "RedeemerUpdated", "event RedeemerUpdated(address newRedeemer)"),
  eventSpec("redeemer", "PositionsManagerUpdated", "event PositionsManagerUpdated(address indexed positionsManager)"),
  eventSpec("redeemer", "PositionsRootUpdated", "event RedeemablePositionsUpdated(bytes32 indexed merkleRoot,string ipfsHash)"),
  eventSpec("redeemer", "ExitEntered", "event ExitQueueEntered(address indexed owner,address indexed receiver,uint256 positionTicket,uint256 shares)"),
  eventSpec("redeemer", "ExitClaimed", "event ExitedAssetsClaimed(address indexed receiver,uint256 prevPositionTicket,uint256 newPositionTicket,uint256 withdrawnAssets)"),
  eventSpec("redeemer", "SharesSwapped", "event OsTokenSharesSwapped(address indexed sender,address indexed receiver,uint256 shares,uint256 assets)"),
  eventSpec("redeemer", "PositionsRedeemed", "event OsTokenPositionsRedeemed(uint256 shares,uint256 assets)"),
  eventSpec("redeemer", "CheckpointCreated", "event CheckpointCreated(uint256 shares,uint256 assets)"),
  eventSpec("escrow", "PositionCreated", "event PositionCreated(address indexed vault,uint256 indexed exitPositionTicket,address owner,uint256 osTokenShares,uint256 cumulativeFeePerShare)"),
  eventSpec("escrow", "ExitedAssetsProcessed", "event ExitedAssetsProcessed(address indexed vault,address indexed caller,uint256 indexed exitPositionTicket,uint256 exitedAssets)"),
  eventSpec("escrow", "PositionLiquidated", "event OsTokenLiquidated(address indexed caller,address indexed vault,uint256 indexed exitPositionTicket,address receiver,uint256 osTokenShares,uint256 receivedAssets)"),
  eventSpec("escrow", "PositionRedeemed", "event OsTokenRedeemed(address indexed caller,address indexed vault,uint256 indexed exitPositionTicket,address receiver,uint256 osTokenShares,uint256 receivedAssets)"),
  eventSpec("escrow", "ExitedAssetsClaimed", "event ExitedAssetsClaimed(address indexed receiver,address indexed vault,uint256 indexed exitPositionTicket,uint256 osTokenShares,uint256 assets)"),
  eventSpec("escrow", "LiqConfigUpdated", "event LiqConfigUpdated(uint64 liqThresholdPercent,uint256 liqBonusPercent)"),
  eventSpec("escrow", "AuthenticatorUpdated", "event AuthenticatorUpdated(address newAuthenticator)"),
  eventSpec("registry", "VaultAdded", "event VaultAdded(address indexed caller,address indexed vault)"),
  eventSpec("registry", "VaultImplAdded", "event VaultImplAdded(address indexed impl)"),
  eventSpec("registry", "VaultImplRemoved", "event VaultImplRemoved(address indexed impl)"),
  eventSpec("registry", "FactoryAdded", "event FactoryAdded(address indexed factory)"),
  eventSpec("registry", "FactoryRemoved", "event FactoryRemoved(address indexed factory)"),
  eventSpec("factory", "VaultCreated", "event VaultCreated(address indexed admin,address indexed vault,address ownMevEscrow,bytes params)"),
  eventSpec("factory", "MetaVaultCreated", "event MetaVaultCreated(address indexed caller,address indexed admin,address indexed vault,bytes params)"),
  eventSpec("vault", "OsTokenMinted", "event OsTokenMinted(address indexed caller,address receiver,uint256 assets,uint256 shares,address referrer)"),
  eventSpec("vault", "OsTokenBurned", "event OsTokenBurned(address indexed caller,uint256 assets,uint256 shares)"),
  eventSpec("vault", "OsTokenLiquidated", "event OsTokenLiquidated(address indexed caller,address indexed user,address receiver,uint256 osTokenShares,uint256 shares,uint256 receivedAssets)"),
  eventSpec("vault", "OsTokenRedeemed", "event OsTokenRedeemed(address indexed caller,address indexed user,address receiver,uint256 osTokenShares,uint256 shares,uint256 assets)")
]);

function rel(value) {
  return path.join(ROOT, ...value.split("/"));
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function bytes32Commitment(value) {
  return `0x${sha256(Buffer.from(canonicalJson(value), "utf8"))}`;
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

function toQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function safeAddress(value) {
  try { return getAddress(value).toLowerCase(); } catch (_) { return null; }
}

function isNonzeroAddress(value) {
  const address = safeAddress(value);
  return address !== null && address !== "0x0000000000000000000000000000000000000000";
}

function parseBlockHeader(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const number = strictQuantity(value.number);
  const hash = strictHex(value.hash, 32);
  const timestamp = strictQuantity(value.timestamp);
  return number === null || !hash || timestamp === null ? null : { number, hash, timestamp };
}

function parseRpcEnvelope(body, expectedId) {
  let parsed;
  try { parsed = JSON.parse(body); } catch (_) { return { ok: false, error: "MALFORMED_JSON", result: null }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.jsonrpc !== "2.0" || parsed.id !== expectedId) {
    return { ok: false, error: "ENVELOPE_MISMATCH", result: null };
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "error")) return { ok: false, error: "RPC_ERROR", result: null };
  if (!Object.prototype.hasOwnProperty.call(parsed, "result")) return { ok: false, error: "MISSING_RESULT", result: null };
  return { ok: true, error: null, result: parsed.result };
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
    this.blocks = 0;
    this.retries = 0;
    this.logsReturned = 0;
    this.chunks = 0;
    this.responseBytes = 0;
    this.uniqueEventBlocks = 0;
    this.exhausted = null;
  }

  fail(reason) {
    this.exhausted = reason;
    throw new Error(`BUDGET_EXHAUSTED_${reason}`);
  }

  consume(method, retry = false) {
    if (this.exhausted) this.fail(this.exhausted);
    if (!ALLOWED_METHODS.has(method) || FORBIDDEN_METHODS.has(method)) throw new Error("METHOD_FORBIDDEN");
    this.checkTime();
    this.total += 1;
    if (method === "eth_getLogs") this.logs += 1;
    if (method === "eth_call") this.calls += 1;
    if (method === "eth_getCode") this.codes += 1;
    if (method === "eth_getBlockByNumber") this.blocks += 1;
    if (retry) this.retries += 1;
    if (this.total > this.caps.maxTotalRequests) this.fail("TOTAL_REQUESTS");
    if (this.logs > this.caps.maxLogRequests) this.fail("LOG_REQUESTS");
    if (this.calls > this.caps.maxCallRequests) this.fail("CALL_REQUESTS");
    if (this.codes > this.caps.maxCodeRequests) this.fail("CODE_REQUESTS");
    if (this.blocks > this.caps.maxBlockRequests) this.fail("BLOCK_REQUESTS");
    if (this.retries > this.caps.maxRetries) this.fail("RETRIES");
  }

  consumeResponse(bytes) {
    this.responseBytes += bytes;
    if (this.responseBytes > this.caps.maxAggregateResponseBytes) this.fail("AGGREGATE_RESPONSE_BYTES");
  }

  consumeLog() {
    this.logsReturned += 1;
    if (this.logsReturned > this.caps.maxLogs) this.fail("LOG_ROWS");
  }

  consumeChunk() {
    this.chunks += 1;
    if (this.chunks > this.caps.maxChunks) this.fail("CHUNKS");
  }

  consumeUniqueEventBlock() {
    this.uniqueEventBlocks += 1;
    if (this.uniqueEventBlocks > this.caps.maxUniqueEventBlocks) this.fail("UNIQUE_EVENT_BLOCKS");
  }

  checkTime() {
    if (this.now() - this.startedAt > this.caps.maxElapsedMs) this.fail("TIME");
  }

  summary() {
    const elapsedWithinCap = this.now() - this.startedAt <= this.caps.maxElapsedMs;
    return {
      total: this.total,
      logs: this.logs,
      calls: this.calls,
      codes: this.codes,
      blocks: this.blocks,
      retries: this.retries,
      logsReturned: this.logsReturned,
      chunks: this.chunks,
      responseBytes: this.responseBytes,
      uniqueEventBlocks: this.uniqueEventBlocks,
      exhausted: this.exhausted,
      elapsedWithinCap,
      allWithinCaps: this.exhausted === null && elapsedWithinCap
    };
  }
}

async function readResponseBodyLimited(response, context, controller) {
  const chunks = [];
  let responseBytes = 0;
  const acceptChunk = async (chunk, cancel) => {
    const bytes = Buffer.from(chunk);
    responseBytes += bytes.length;
    if (responseBytes > context.caps.maxResponseBytes) {
      controller.abort();
      if (cancel) await cancel();
      context.budget.fail("SINGLE_RESPONSE_BYTES");
    }
    try {
      context.budget.consumeResponse(bytes.length);
    } catch (error) {
      controller.abort();
      if (cancel) await cancel();
      throw error;
    }
    chunks.push(bytes);
  };
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    while (true) {
      context.budget.checkTime();
      const row = await reader.read();
      if (row.done) break;
      await acceptChunk(row.value, () => reader.cancel());
    }
  } else {
    controller.abort();
    throw new Error("STREAMING_BODY_REQUIRED");
  }
  return Buffer.concat(chunks);
}

async function rpcRequest(endpoint, method, params, context, fetchImpl = fetch) {
  if (!ALLOWED_METHODS.has(method) || FORBIDDEN_METHODS.has(method)) return { ok: false, error: "METHOD_FORBIDDEN", result: null };
  const requestId = ++context.nextId;
  for (let attempt = 0; attempt <= context.caps.retriesPerRequest; attempt++) {
    context.budget.consume(method, attempt > 0);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), context.caps.requestTimeoutMs);
    try {
      const response = await fetchImpl(endpoint.url, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
        signal: controller.signal
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) return { ok: false, error: "REDIRECT_REJECTED", result: null };
      if (response.status < 200 || response.status >= 300) {
        if (response.status >= 500 && attempt < context.caps.retriesPerRequest) continue;
        return { ok: false, error: "HTTP_STATUS", result: null };
      }
      const declared = response.headers && response.headers.get ? Number(response.headers.get("content-length")) : 0;
      if (declared > context.caps.maxResponseBytes) {
        controller.abort();
        context.budget.fail("SINGLE_RESPONSE_BYTES");
      }
      const bytes = await readResponseBodyLimited(response, context, controller);
      return parseRpcEnvelope(bytes.toString("utf8"), requestId);
    } catch (error) {
      if (/^BUDGET_EXHAUSTED_/u.test(String(error.message || error))) throw error;
      if (attempt >= context.caps.retriesPerRequest) return { ok: false, error: "TRANSPORT_FAILURE", result: null };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: "TRANSPORT_FAILURE", result: null };
}

function resolveImport(fromRelative, imported) {
  if (imported.startsWith(".")) return path.posix.normalize(path.posix.join(path.posix.dirname(fromRelative), imported));
  if (imported.startsWith("@openzeppelin/contracts/")) {
    return `lib/openzeppelin-contracts-upgradeable/lib/openzeppelin-contracts/contracts/${imported.slice("@openzeppelin/contracts/".length)}`;
  }
  if (imported.startsWith("@openzeppelin/contracts-upgradeable/")) {
    return `lib/openzeppelin-contracts-upgradeable/contracts/${imported.slice("@openzeppelin/contracts-upgradeable/".length)}`;
  }
  throw new Error("UNBOUND_IMPORT");
}

function discoverSourceClosure() {
  const pending = SOURCE_SEEDS.filter((value) => value.endsWith(".sol"));
  const seen = new Set(["deployments/mainnet.json"]);
  while (pending.length > 0) {
    const relativePath = pending.pop();
    if (seen.has(relativePath)) continue;
    const absolute = path.join(TARGET, ...relativePath.split("/"));
    if (!fs.existsSync(absolute)) throw new Error("SOURCE_CLOSURE_FILE_MISSING");
    seen.add(relativePath);
    const source = fs.readFileSync(absolute, "utf8");
    const expression = /import\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']\s*;/gu;
    for (const match of source.matchAll(expression)) {
      const resolved = resolveImport(relativePath, match[1]);
      const absoluteResolved = path.resolve(TARGET, ...resolved.split("/"));
      if (!absoluteResolved.startsWith(`${path.resolve(TARGET)}${path.sep}`)) throw new Error("SOURCE_CLOSURE_ESCAPE");
      if (!seen.has(resolved)) pending.push(resolved);
    }
  }
  return [...seen].sort();
}

function localSourceRecords() {
  return discoverSourceClosure().map((relativePath) => {
    const bytes = fs.readFileSync(path.join(TARGET, ...relativePath.split("/")));
    return { path: `targets/stakewise-v3-core-v5.0.1/${relativePath}`, bytes: bytes.length, sha256: sha256(bytes) };
  });
}

function loadLocalBindings() {
  const deploymentBytes = fs.readFileSync(path.join(TARGET, "deployments", "mainnet.json"));
  const deployment = JSON.parse(deploymentBytes.toString("utf8"));
  const roles = {};
  for (const [role, key] of Object.entries(DEPLOYMENT_ROLE_KEYS)) {
    const address = safeAddress(deployment[key]);
    if (!isNonzeroAddress(address)) throw new Error("DEPLOYMENT_SEED_INVALID");
    roles[role] = address;
  }
  const factorySeeds = FACTORY_KEYS.map((key) => safeAddress(deployment[key])).filter(isNonzeroAddress);
  if (factorySeeds.length !== FACTORY_KEYS.length) throw new Error("FACTORY_SEED_INVALID");
  const sourceRecords = localSourceRecords();
  return {
    roles,
    factorySeeds,
    sourceRecords,
    packageSourceBinding: bytes32Commitment(sourceRecords),
    deploymentSeedBinding: bytes32Commitment(Object.keys(roles).sort().map((role) => ({ role, address: roles[role] }))),
    sanitized: {
      targetTag: "v5.0.1",
      mainnetDeploymentSeedBound: true,
      deploymentRoleLabels: Object.keys(roles).sort(),
      deploymentRoleCount: Object.keys(roles).length,
      factorySeedCount: factorySeeds.length,
      sourceClosureComplete: true,
      sourceClosureFileCount: sourceRecords.length,
      packageSourceBinding: bytes32Commitment(sourceRecords)
    }
  };
}

function dryPreflight() {
  const local = loadLocalBindings();
  return {
    schemaVersion: 1,
    findingId: FINDING_ID,
    status: "PREPARED_REVIEW_REQUESTED_NOT_AUTHORIZED_NOT_EXECUTED",
    chain: { name: "ethereum-mainnet", chainId: CHAIN_ID, chains: 1 },
    authorization: {
      captureFlagRequired: "--capture-once",
      checkOnlyFlag: "--check-only",
      modesMutuallyExclusive: true,
      fixedApprovalPath: FIXED_APPROVAL_REL,
      fixedOutputPath: FIXED_OUTPUT_REL,
      globalConsumptionLedger: GLOBAL_LEDGER_REL,
      singleUseFreshApprovalRequired: true,
      proposalState: "REVIEW_REQUESTED",
      proposalAuthorization: "NOT_AUTHORIZED",
      approvalAuthenticityAssumption: "TRUSTED_COORDINATOR_AND_LOCAL_FILESYSTEM",
      authorized: false,
      captureExecuted: false
    },
    localBindings: local.sanitized,
    providerPolicy: {
      inventoryConsumedOnlyAfterApprovalConsumption: true,
      minimumHostnameDistinctFamilies: CAPS.minHostnameDistinctFamilies,
      hostnameDistinctThresholdRequired: true,
      providerIdentityPersisted: false,
      endpointIdentityOrHashPersisted: false
      ,backendIndependenceProven: false
    },
    methods: { allowed: [...ALLOWED_METHODS].sort(), forbidden: [...FORBIDDEN_METHODS].sort() },
    protocolStages: [
      "runtime-and-proxy-lineage",
      "registry-factory-vault-discovery",
      "controller-and-config-state",
      "aggregate-supply-controller-reconciliation",
      "bounded-affected-position-indicators",
      "redeemer-and-escrow-topology",
      "terminal-finalized-pin-recheck"
    ],
    caps: CAPS,
    gates: {
      runtimeLineageComplete: null,
      finalizedCommonPin: null,
      historyComplete: null,
      currentAffectedPositionExposure: null,
      aggregateEconomicExposure: null,
      controllerSupplyReconciled: null,
      signedActionJustified: false,
      fork: false
    },
    networkReads: 0,
    inventoryReads: 0,
    writes: 0
  };
}

function assertExactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) throw new Error(code);
}

function rejectForbiddenMetadata(value) {
  const forbiddenKeys = /^(?:url|hostname|endpointUrl|providerIdentity|providerHash|endpointHash|rawResponse|transactionHash|txHash|calldata|userAddress|vaultAddress)$/iu;
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (forbiddenKeys.test(key)) throw new Error("FORBIDDEN_METADATA_KEY");
      if (typeof child === "string" && (/(?:https?|wss?):\/\//iu.test(child) || /^0x[0-9a-f]{40}$/iu.test(child))) {
        throw new Error("FORBIDDEN_METADATA_VALUE");
      }
      if (child && typeof child === "object") stack.push(child);
    }
  }
}

function parseArgs(argv) {
  const args = { capture: false, checkOnly: false, approvalFile: null };
  for (let index = 2; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--capture-once") args.capture = true;
    else if (value === "--check-only" || value === "--preflight") args.checkOnly = true;
    else if (value === "--approval-file") args.approvalFile = argv[++index] || null;
    else throw new Error("UNKNOWN_ARGUMENT");
  }
  if (args.capture && args.checkOnly) throw new Error("MODE_CONFLICT");
  if (!args.capture) args.checkOnly = true;
  return args;
}

function validatePackageManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts) ||
    !/^[0-9a-f]{64}$/u.test(manifest.aggregateSha256 || "")) throw new Error("PACKAGE_MANIFEST_INVALID");
  if (canonicalJson(manifest.artifacts.map((row) => row.path).sort()) !== canonicalJson([...PACKAGE_ARTIFACTS].sort())) {
    throw new Error("PACKAGE_MANIFEST_PATH_SET_MISMATCH");
  }
  for (const row of manifest.artifacts) {
    const bytes = fs.readFileSync(rel(row.path));
    if (row.bytes !== bytes.length || row.sha256 !== sha256(bytes)) throw new Error("PACKAGE_ARTIFACT_MISMATCH");
  }
  const aggregate = sha256(Buffer.from(manifest.artifacts.map((row) => `${row.path}:${row.sha256}`).sort().join("\n"), "utf8"));
  if (aggregate !== manifest.aggregateSha256) throw new Error("PACKAGE_MANIFEST_AGGREGATE_MISMATCH");
  return true;
}

function validateSourceManifest(manifest) {
  const records = localSourceRecords();
  assertExactKeys(manifest, ["schemaVersion", "findingId", "status", "algorithm", "target", "targetCommit", "targetTag",
    "sourceSeeds", "sourceClosureFileCount", "packageSourceBinding", "deploymentSeedRoles", "rawDeploymentAddressesPersisted"],
  "SOURCE_MANIFEST_SCHEMA_INVALID");
  if (manifest.schemaVersion !== 1 || manifest.findingId !== FINDING_ID || manifest.status !== "LOCAL_SOURCE_CLOSURE_BOUND" ||
    manifest.algorithm !== "sha256-canonical-json" || manifest.sourceClosureFileCount !== records.length ||
    manifest.target !== "stakewise-v3-core-v5.0.1" || manifest.targetCommit !== "fc70cbe1b3d41bc5f78434830d837aa270ca33bc" ||
    manifest.targetTag !== "v5.0.1" || manifest.rawDeploymentAddressesPersisted !== false ||
    canonicalJson(manifest.sourceSeeds) !== canonicalJson([...SOURCE_SEEDS]) ||
    canonicalJson(manifest.deploymentSeedRoles) !== canonicalJson(Object.keys(DEPLOYMENT_ROLE_KEYS).sort()) ||
    manifest.packageSourceBinding !== bytes32Commitment(records)) throw new Error("SOURCE_MANIFEST_MISMATCH");
  return true;
}

function validateReviewManifest(manifest) {
  const expectedPaths = [`reports/raw/fast/${PREFIX}-preflight.json`, REVIEW_REPORT_REL, PROPOSAL_REL,
    MANIFEST_REL, SOURCE_MANIFEST_REL];
  assertExactKeys(manifest, ["schemaVersion", "findingId", "status", "algorithm", "aggregateConstruction", "artifactCount",
    "aggregateSha256", "artifacts"], "REVIEW_MANIFEST_SCHEMA_INVALID");
  if (manifest.schemaVersion !== 1 || manifest.findingId !== FINDING_ID || manifest.status !== "REVIEW_REQUESTED_NOT_AUTHORIZED_NOT_EXECUTED" ||
    manifest.algorithm !== "sha256" || manifest.artifactCount !== expectedPaths.length || !Array.isArray(manifest.artifacts) ||
    canonicalJson(manifest.artifacts.map((row) => row.path).sort()) !== canonicalJson(expectedPaths.sort())) throw new Error("REVIEW_MANIFEST_INVALID");
  for (const row of manifest.artifacts) {
    assertExactKeys(row, ["path", "bytes", "sha256"], "REVIEW_ARTIFACT_SCHEMA_INVALID");
    const bytes = fs.readFileSync(rel(row.path));
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256) throw new Error("REVIEW_ARTIFACT_MISMATCH");
  }
  const aggregate = sha256(Buffer.from(manifest.artifacts.map((row) => `${row.path}:${row.sha256}`).sort().join("\n"), "utf8"));
  if (aggregate !== manifest.aggregateSha256) throw new Error("REVIEW_MANIFEST_AGGREGATE_MISMATCH");
  return true;
}

function validateProposal(proposal) {
  assertExactKeys(proposal, ["schemaVersion", "state", "authorization", "captureExecuted", "proposalPayload", "proposalCommitment",
    "reviewerIssuedApprovalRequirements", "networkReads", "inventoryReads", "approvalCreated"], "PROPOSAL_SCHEMA_INVALID");
  assertExactKeys(proposal.proposalPayload, ["requestedApprovalId", "findingId", "chainId", "authorizedCaptureCount",
    "fixedApprovalPath", "fixedOutputPath", "globalConsumptionLedger", "runnerSha256", "packageManifestSha256",
    "packageAggregateSha256", "packageSourceBinding", "capsCommitment", "allowedMethods", "endpointInventoryReadRequested",
    "transactionsAuthorized", "traceAuthorized", "forkAuthorized", "approvalAuthenticityAssumption"], "PROPOSAL_PAYLOAD_SCHEMA_INVALID");
  assertExactKeys(proposal.reviewerIssuedApprovalRequirements, ["schemaVersion", "state", "requestedApprovalId", "issuedAt", "expiresAt",
    "approvalCommitment", "reviewMaterialManifestSha256", "endpointInventoryReadAuthorized", "transactionsAuthorized",
    "traceAuthorized", "forkAuthorized", "independentReviewRequired"], "PROPOSAL_REVIEW_SCHEMA_INVALID");
  rejectForbiddenMetadata(proposal);
  if (proposal.schemaVersion !== 1 || proposal.state !== "REVIEW_REQUESTED" || proposal.authorization !== "NOT_AUTHORIZED" ||
    proposal.captureExecuted !== false || proposal.networkReads !== 0 || proposal.inventoryReads !== 0 || proposal.approvalCreated !== false ||
    proposal.proposalPayload.approvalAuthenticityAssumption !== "TRUSTED_COORDINATOR_AND_LOCAL_FILESYSTEM" ||
    proposal.proposalCommitment !== bytes32Commitment(proposal.proposalPayload)) throw new Error("PROPOSAL_INVALID");
  return true;
}

function validateApprovalEnvelope(approval, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const payload = approval && approval.approvalPayload;
  assertExactKeys(approval, ["schemaVersion", "state", "approvalPayload", "approvalCommitment"], "APPROVAL_SCHEMA_INVALID");
  assertExactKeys(payload, ["approvalId", "findingId", "chainId", "issuedAt", "expiresAt", "authorizedCaptureCount",
    "fixedApprovalPath", "fixedOutputPath", "globalConsumptionLedger", "endpointInventoryReadAuthorized", "transactionsAuthorized",
    "traceAuthorized", "forkAuthorized", "runnerSha256", "packageManifestSha256", "packageAggregateSha256", "packageSourceBinding",
    "proposalCommitment", "reviewMaterialManifestSha256", "capsCommitment", "allowedMethods", "approvalAuthenticityAssumption"],
  "APPROVAL_PAYLOAD_SCHEMA_INVALID");
  rejectForbiddenMetadata(approval);
  if (approval.schemaVersion !== 2 || approval.state !== "AUTHORIZED" || !payload) throw new Error("APPROVAL_STATE_INVALID");
  if (!/^swv3-ostoken-[0-9a-f]{32}$/u.test(payload.approvalId || "")) throw new Error("APPROVAL_ID_INVALID");
  if (approval.approvalCommitment !== bytes32Commitment(payload)) throw new Error("APPROVAL_COMMITMENT_INVALID");
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt ||
    expiresAt - issuedAt > CAPS.maxApprovalWindowMs || now - issuedAt > CAPS.maxApprovalIssuedAgeMs ||
    issuedAt > now + CAPS.maxApprovalFutureSkewMs || now >= expiresAt) throw new Error("APPROVAL_WINDOW_INVALID");
  const expected = options.expected || {};
  if (payload.findingId !== FINDING_ID || payload.chainId !== CHAIN_ID || payload.authorizedCaptureCount !== 1 ||
    payload.fixedApprovalPath !== FIXED_APPROVAL_REL || payload.fixedOutputPath !== FIXED_OUTPUT_REL ||
    payload.globalConsumptionLedger !== GLOBAL_LEDGER_REL || payload.endpointInventoryReadAuthorized !== true ||
    payload.transactionsAuthorized !== false || payload.traceAuthorized !== false || payload.forkAuthorized !== false ||
    payload.approvalId !== expected.approvalId || payload.runnerSha256 !== expected.runnerSha256 ||
    payload.packageManifestSha256 !== expected.packageManifestSha256 ||
    payload.packageAggregateSha256 !== expected.packageAggregateSha256 ||
    payload.packageSourceBinding !== expected.packageSourceBinding ||
    payload.proposalCommitment !== expected.proposalCommitment ||
    payload.reviewMaterialManifestSha256 !== expected.reviewMaterialManifestSha256 ||
    payload.approvalAuthenticityAssumption !== "TRUSTED_COORDINATOR_AND_LOCAL_FILESYSTEM" ||
    payload.capsCommitment !== bytes32Commitment(CAPS) ||
    canonicalJson(payload.allowedMethods) !== canonicalJson([...ALLOWED_METHODS].sort())) throw new Error("APPROVAL_BINDING_INVALID");
  if (options.consumed === true) throw new Error("APPROVAL_ALREADY_CONSUMED");
  return { approvalId: payload.approvalId, approvalCommitment: approval.approvalCommitment };
}

function validateApproval(args) {
  if (!args.capture || !args.approvalFile) throw new Error("CAPTURE_ARGUMENTS_REQUIRED");
  const approvalPath = path.resolve(ROOT, args.approvalFile);
  if (approvalPath !== rel(FIXED_APPROVAL_REL)) throw new Error("APPROVAL_PATH_FORBIDDEN");
  const manifestBytes = fs.readFileSync(MANIFEST_PATH);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const sourceManifest = JSON.parse(fs.readFileSync(SOURCE_MANIFEST_PATH, "utf8"));
  const proposal = JSON.parse(fs.readFileSync(PROPOSAL_PATH, "utf8"));
  const reviewManifestBytes = fs.readFileSync(REVIEW_MANIFEST_PATH);
  const reviewManifest = JSON.parse(reviewManifestBytes.toString("utf8"));
  const approval = JSON.parse(fs.readFileSync(approvalPath, "utf8"));
  validatePackageManifest(manifest);
  validateSourceManifest(sourceManifest);
  validateProposal(proposal);
  validateReviewManifest(reviewManifest);
  const local = loadLocalBindings();
  const validated = validateApprovalEnvelope(approval, {
    expected: {
      approvalId: proposal.proposalPayload.requestedApprovalId,
      runnerSha256: `0x${sha256(fs.readFileSync(__filename))}`,
      packageManifestSha256: `0x${sha256(manifestBytes)}`,
      packageAggregateSha256: `0x${manifest.aggregateSha256}`,
      packageSourceBinding: local.packageSourceBinding,
      proposalCommitment: proposal.proposalCommitment
      ,reviewMaterialManifestSha256: `0x${sha256(reviewManifestBytes)}`
    },
    consumed: fs.existsSync(GLOBAL_LEDGER_PATH)
  });
  if (fs.existsSync(FIXED_OUTPUT_PATH)) throw new Error("FIXED_OUTPUT_ALREADY_EXISTS");
  return { ...validated, outputPath: FIXED_OUTPUT_PATH, ledgerPath: GLOBAL_LEDGER_PATH };
}

function consumeApprovalAtomically(authorization) {
  const fd = fs.openSync(authorization.ledgerPath, "wx");
  try {
    fs.writeFileSync(fd, `${JSON.stringify({
      schemaVersion: 1,
      findingId: FINDING_ID,
      approvalId: authorization.approvalId,
      approvalCommitment: authorization.approvalCommitment,
      status: "GLOBALLY_CONSUMED_BEFORE_INVENTORY_ACCESS"
    }, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function loadInventoryAuthorized(context, inventoryPath = INVENTORY_PATH) {
  context.budget.checkTime();
  const stat = fs.statSync(inventoryPath);
  if (stat.size > context.caps.maxInventoryBytes) throw new Error("INVENTORY_BYTES_EXCEEDED");
  const content = fs.readFileSync(inventoryPath, "utf8");
  if (Buffer.byteLength(content, "utf8") > context.caps.maxInventoryBytes) throw new Error("INVENTORY_BYTES_EXCEEDED");
  const lines = content.split(/\r?\n/u);
  if (lines.length > context.caps.maxInventoryLines) throw new Error("INVENTORY_LINES_EXCEEDED");
  const endpoints = [];
  const hostnames = new Set();
  for (const line of lines) {
    context.budget.checkTime();
    const match = line.match(/https:\/\/[^\s'"<>\[\]]+/u);
    if (!match) continue;
    let parsed;
    try { parsed = new URL(match[0].replace(/[)\]]+$/u, "")); } catch (_) { continue; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || /testnet|sepolia|hoodi|gnosis|chiado/iu.test(parsed.href)) continue;
    const hostname = parsed.hostname.toLowerCase();
    if (hostnames.has(hostname) || hostnames.size >= CAPS.maxFamilies) continue;
    hostnames.add(hostname);
    endpoints.push({ url: parsed.href, family: `F${hostnames.size}` });
    if (endpoints.length >= CAPS.maxInventoryEntries) break;
  }
  context.budget.checkTime();
  return endpoints;
}

function selectPin(observations, minimum = CAPS.minHostnameDistinctFamilies) {
  const groups = new Map();
  for (const row of observations) {
    if (!row || row.chainId !== CHAIN_ID || !row.header || !/^F[1-9][0-9]*$/u.test(row.family || "")) continue;
    if (row.header.number < BigInt(CAPS.minPlausiblePin) || row.header.number > BigInt(CAPS.maxPlausiblePin)) continue;
    const key = `${row.header.number}:${row.header.hash}`;
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key).set(row.family, row);
  }
  const candidates = [...groups.values()].sort((a, b) => b.size - a.size);
  const bestQualifiedFamilyCount = candidates.length === 0 ? 0 : candidates[0].size;
  const selected = candidates.find((group) => group.size >= minimum);
  if (!selected) return { promotable: false, header: null, rows: [], families: [], bestQualifiedFamilyCount };
  const rows = [...selected.values()].sort((a, b) => a.family.localeCompare(b.family)).slice(0, minimum);
  return { promotable: true, header: rows[0].header, rows, families: rows.map((row) => row.family), bestQualifiedFamilyCount };
}

async function qualifyEndpoints(endpoints, context) {
  const observations = [];
  for (const endpoint of endpoints) {
    const chain = await rpcRequest(endpoint, "eth_chainId", [], context);
    if (!chain.ok || strictQuantity(chain.result) !== 1n) continue;
    const finalized = await rpcRequest(endpoint, "eth_getBlockByNumber", ["finalized", false], context);
    const header = finalized.ok ? parseBlockHeader(finalized.result) : null;
    if (header) observations.push({ family: endpoint.family, endpoint, chainId: CHAIN_ID, header });
  }
  return selectPin(observations);
}

async function callDecoded(endpoint, address, iface, fragment, args, pin, context, fetchImpl = fetch) {
  const data = iface.encodeFunctionData(fragment, args || []);
  const response = await rpcRequest(endpoint, "eth_call", [{ to: address, data }, toQuantity(pin)], context, fetchImpl);
  if (!response.ok || !strictHex(response.result)) return null;
  try { return iface.decodeFunctionResult(fragment, response.result); } catch (_) { return null; }
}

async function readCode(endpoint, address, pin, context) {
  const response = await rpcRequest(endpoint, "eth_getCode", [address, toQuantity(pin)], context);
  const code = response.ok ? strictHex(response.result) : null;
  return code && code !== "0x" ? { present: true, hash: keccak256(code) } : { present: false, hash: null };
}

function decodedBigInt(decoded, index = 0) {
  try { return decoded ? BigInt(decoded[index]) : null; } catch (_) { return null; }
}

async function readProtocolObservation(endpoint, roles, pin, context) {
  const interfaces = { token: tokenInterface, controller: controllerInterface, config: configInterface, redeemer: redeemerInterface,
    escrow: escrowInterface, registry: registryInterface };
  const runtime = [];
  for (const role of Object.keys(interfaces)) {
    const code = await readCode(endpoint, roles[role], pin, context);
    runtime.push({ role, codePresent: code.present, runtimeHash: code.hash, roleIsProxy: false });
  }

  const call = (role, iface, fragment, args = []) => callDecoded(endpoint, roles[role], iface, fragment, args, pin, context);
  const totalSupply = decodedBigInt(await call("token", tokenInterface, "totalSupply"));
  const capacity = decodedBigInt(await call("controller", controllerInterface, "capacity"));
  const totalShares = decodedBigInt(await call("controller", controllerInterface, "totalShares"));
  const totalAssets = decodedBigInt(await call("controller", controllerInterface, "totalAssets"));
  const feePercent = decodedBigInt(await call("controller", controllerInterface, "feePercent"));
  const rewardRate = decodedBigInt(await call("controller", controllerInterface, "avgRewardPerSecond"));
  const feePerShare = decodedBigInt(await call("controller", controllerInterface, "cumulativeFeePerShare"));
  const treasury = await call("controller", controllerInterface, "treasury");
  const keeper = await call("controller", controllerInterface, "keeper");
  const redeemer = await call("config", configInterface, "redeemer");
  const defaultConfig = await call("config", configInterface, "getConfig", ["0x0000000000000000000000000000000000000000"]);
  const queue = await call("redeemer", redeemerInterface, "getExitQueueData");
  const positionsManager = await call("redeemer", redeemerInterface, "positionsManager");
  const redeemable = await call("redeemer", redeemerInterface, "redeemablePositions");
  const redeemerFields = {};
  for (const field of ["exitQueueUpdateDelay", "queuedShares", "unclaimedAssets", "redeemedShares", "redeemedAssets", "swappedShares", "swappedAssets", "exitQueueTimestamp", "nonce"]) {
    redeemerFields[field] = decodedBigInt(await call("redeemer", redeemerInterface, field));
  }
  const canProcess = await call("redeemer", redeemerInterface, "canProcessExitQueue");
  const liqThreshold = decodedBigInt(await call("escrow", escrowInterface, "liqThresholdPercent"));
  const liqBonus = decodedBigInt(await call("escrow", escrowInterface, "liqBonusPercent"));
  const authenticator = await call("escrow", escrowInterface, "authenticator");

  return {
    runtime,
    raw: {
      totalSupply, capacity, totalShares, totalAssets, feePercent, rewardRate, feePerShare,
      treasury: treasury ? safeAddress(treasury[0]) : null,
      keeper: keeper ? safeAddress(keeper[0]) : null,
      redeemer: redeemer ? safeAddress(redeemer[0]) : null,
      defaultConfig: defaultConfig ? [decodedBigInt(defaultConfig, 0), decodedBigInt(defaultConfig, 1), decodedBigInt(defaultConfig, 2)] : null,
      queue: queue ? [decodedBigInt(queue, 0), decodedBigInt(queue, 1), decodedBigInt(queue, 2)] : null,
      positionsManager: positionsManager ? safeAddress(positionsManager[0]) : null,
      redeemableRoot: redeemable ? strictHex(redeemable[0], 32) : null,
      redeemableMetadataPresent: redeemable ? typeof redeemable[1] === "string" && redeemable[1].length > 0 : null,
      redeemerFields,
      canProcess: canProcess ? Boolean(canProcess[0]) : null,
      liqThreshold, liqBonus,
      authenticator: authenticator ? safeAddress(authenticator[0]) : null
    }
  };
}

function sanitizeObservation(observation, roles) {
  const raw = observation.raw;
  const values = [raw.totalSupply, raw.capacity, raw.totalShares, raw.totalAssets, raw.feePercent, raw.rewardRate, raw.feePerShare,
    raw.liqThreshold, raw.liqBonus, ...Object.values(raw.redeemerFields), ...(raw.defaultConfig || []), ...(raw.queue || [])];
  const allStateCallsComplete = values.every((value) => value !== null) && raw.canProcess !== null;
  return {
    runtime: observation.runtime,
    runtimeRoleCount: observation.runtime.length,
    allSeedRuntimeCodePresent: observation.runtime.every((row) => row.codePresent),
    directRolesQueriedWithActualAbi: true,
    sourceRuntimeEquivalenceProven: null,
    partialRuntimeLineageUseful: observation.runtime.every((row) => row.codePresent),
    promotableExactRuntimeLineage: null,
    controllerAndConfig: {
      allStateCallsComplete,
      mainControllerIsImmutableSeparateFromAuxiliaryMapping: true,
      treasuryConfigured: isNonzeroAddress(raw.treasury),
      keeperConfigured: isNonzeroAddress(raw.keeper),
      redeemerMatchesDeploymentRole: raw.redeemer === roles.redeemer,
      defaultConfigPresent: Boolean(raw.defaultConfig && raw.defaultConfig.every((value) => value !== null && value > 0n)),
      capacityNonzero: raw.capacity === null ? null : raw.capacity > 0n,
      feeWithinSourceMaximum: raw.feePercent === null ? null : raw.feePercent <= 10000n
    },
    reconciliation: {
      mainControllerSupplyInputsReadable: raw.totalSupply !== null && raw.totalShares !== null,
      globalSupplyReconciliation: null,
      allAuxiliaryControllersIncluded: null,
      controllerAssetsWithinCapacity: raw.totalAssets === null || raw.capacity === null ? null : raw.totalAssets <= raw.capacity,
      supplyNonzero: raw.totalSupply === null ? null : raw.totalSupply > 0n,
      controllerAssetsNonzero: raw.totalAssets === null ? null : raw.totalAssets > 0n
    },
    topology: {
      configRedeemerRoleMatches: raw.redeemer === roles.redeemer,
      positionsManagerConfigured: isNonzeroAddress(raw.positionsManager),
      escrowAuthenticatorConfigured: isNonzeroAddress(raw.authenticator),
      redeemableRootConfigured: raw.redeemableRoot === null ? null : raw.redeemableRoot !== `0x${"00".repeat(32)}`,
      redeemableMetadataPresent: raw.redeemableMetadataPresent,
      queueStateReadable: Boolean(raw.queue && raw.queue.every((value) => value !== null)),
      queuedSharesNonzero: raw.redeemerFields.queuedShares === null ? null : raw.redeemerFields.queuedShares > 0n,
      unclaimedAssetsNonzero: raw.redeemerFields.unclaimedAssets === null ? null : raw.redeemerFields.unclaimedAssets > 0n,
      canProcessExitQueue: raw.canProcess,
      escrowLiquidationConfigPresent: raw.liqThreshold === null || raw.liqBonus === null ? null : raw.liqThreshold > 0n && raw.liqBonus > 0n
    }
  };
}

function exactComparable(value) {
  if (typeof value === "bigint") return { bigint: value.toString() };
  if (Array.isArray(value)) return value.map(exactComparable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, exactComparable(value[key])]));
  }
  return value;
}

function protocolObservationsExactlyMatch(left, right) {
  return canonicalJson(exactComparable(left)) === canonicalJson(exactComparable(right));
}

function validateLog(log, expectedAddresses, expectedTopics, fromBlock, toBlock) {
  if (!log || typeof log !== "object" || Array.isArray(log)) return null;
  const address = safeAddress(log.address);
  const blockNumber = strictQuantity(log.blockNumber);
  const transactionIndex = strictQuantity(log.transactionIndex);
  const logIndex = strictQuantity(log.logIndex);
  const blockHash = strictHex(log.blockHash, 32);
  const transactionHash = strictHex(log.transactionHash, 32);
  const data = strictHex(log.data);
  if (!address || blockNumber === null || transactionIndex === null || logIndex === null || !blockHash || !transactionHash || !data || log.removed !== false) return null;
  if (blockNumber < BigInt(fromBlock) || blockNumber > BigInt(toBlock) || !expectedAddresses.has(address)) return null;
  if (!Array.isArray(log.topics) || log.topics.length === 0 || !log.topics.every((topic) => strictHex(topic, 32))) return null;
  const topics = log.topics.map((topic) => topic.toLowerCase());
  if (!expectedTopics.has(topics[0])) return null;
  return { address, blockNumber, transactionIndex, logIndex, blockHash, transactionHash, data, topics };
}

function canonicalLogRows(logs) {
  return logs.map((log) => ({
    address: log.address,
    blockNumber: log.blockNumber.toString(),
    transactionIndex: log.transactionIndex.toString(),
    logIndex: log.logIndex.toString(),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    data: log.data,
    topics: log.topics
  })).sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : 1;
    if (a.transactionIndex !== b.transactionIndex) return BigInt(a.transactionIndex) < BigInt(b.transactionIndex) ? -1 : 1;
    return BigInt(a.logIndex) < BigInt(b.logIndex) ? -1 : BigInt(a.logIndex) > BigInt(b.logIndex) ? 1 : 0;
  });
}

function roleSpecs(role) {
  return EVENT_SPECS.filter((row) => row.role === role);
}

function decodeRoleLog(log, role) {
  const spec = roleSpecs(role).find((row) => row.topic === log.topics[0]);
  if (!spec) throw new Error("CROSS_ROLE_TOPIC");
  try {
    const decoded = spec.iface.parseLog({ topics: log.topics, data: log.data });
    if (!decoded || decoded.name !== spec.label && !spec.iface.getEvent(decoded.name)) throw new Error("name");
    return { ...log, role, label: spec.label, decoded };
  } catch (_) {
    throw new Error("MALFORMED_EVENT_DATA");
  }
}

async function verifyCanonicalEventBlocks(endpoint, logs, context, fetchImpl = fetch) {
  if (!context.canonicalHeaders) context.canonicalHeaders = new Map();
  const unique = new Map();
  for (const log of logs) {
    const number = log.blockNumber.toString();
    if (unique.has(number) && unique.get(number) !== log.blockHash) return false;
    unique.set(number, log.blockHash);
  }
  const verified = new Map();
  for (const [number, expectedHash] of unique) {
    const cacheKey = `${endpoint.family}:${number}`;
    let header = context.canonicalHeaders.get(cacheKey);
    if (!header) {
      context.budget.consumeUniqueEventBlock();
      const response = await rpcRequest(endpoint, "eth_getBlockByNumber", [toQuantity(number), false], context, fetchImpl);
      header = response.ok ? parseBlockHeader(response.result) : null;
      if (header) context.canonicalHeaders.set(cacheKey, header);
    }
    if (!header || header.number !== BigInt(number) || header.hash !== expectedHash) return false;
    verified.set(number, header.hash);
  }
  return logs.every((log) => verified.get(log.blockNumber.toString()) === log.blockHash);
}

async function collectRoleHistory(endpoint, targets, pin, context) {
  if (pin < 0n || pin + 1n > BigInt(context.caps.maxScanSpanBlocks)) throw new Error("SCAN_SPAN_IMPLAUSIBLE");
  const roleByAddress = new Map();
  for (const target of targets) {
    if (!isNonzeroAddress(target.address) || roleByAddress.has(target.address)) throw new Error("HISTORY_TARGET_INVALID");
    roleByAddress.set(target.address, target.role);
  }
  const expectedAddresses = new Set(roleByAddress.keys());
  const expectedTopics = new Set(targets.flatMap((target) => roleSpecs(target.role).map((row) => row.topic)));
  const logs = [];
  let complete = true;
  for (let start = 0n; start <= pin; start += BigInt(context.caps.maxLogChunkBlocks)) {
    context.budget.consumeChunk();
    const end = start + BigInt(context.caps.maxLogChunkBlocks - 1) > pin ? pin : start + BigInt(context.caps.maxLogChunkBlocks - 1);
    const response = await rpcRequest(endpoint, "eth_getLogs", [{
      address: [...expectedAddresses],
      topics: [[...expectedTopics]],
      fromBlock: toQuantity(start),
      toBlock: toQuantity(end)
    }], context);
    if (!response.ok || !Array.isArray(response.result)) { complete = false; continue; }
    for (const raw of response.result) {
      const parsed = validateLog(raw, expectedAddresses, expectedTopics, start, end);
      if (!parsed) throw new Error("MALFORMED_OR_OUT_OF_RANGE_LOG");
      logs.push(decodeRoleLog(parsed, roleByAddress.get(parsed.address)));
      context.budget.consumeLog();
    }
  }
  const canonical = await verifyCanonicalEventBlocks(endpoint, logs, context);
  const rows = canonicalLogRows(logs);
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (previous.blockHash === current.blockHash && previous.transactionHash === current.transactionHash && previous.logIndex === current.logIndex) {
      if (canonicalJson(previous) !== canonicalJson(current)) throw new Error("CONFLICTING_DUPLICATE_LOG");
      rows.splice(index, 1);
      index -= 1;
    }
  }
  return { complete: complete && canonical, canonical, rows, decodedLogs: logs };
}

async function collectHistory(endpoint, roles, pin, context) {
  return collectRoleHistory(endpoint, Object.entries(roles).map(([role, address]) => ({ role, address })), pin, context);
}

function summarizeHistory(histories) {
  const counts = {};
  for (const spec of EVENT_SPECS) counts[`${spec.role}:${spec.label}`] = 0;
  let total = 0;
  for (const history of histories) {
    total += history.rows.length;
    for (const log of history.decodedLogs) counts[`${log.role}:${log.label}`] += 1;
  }
  return {
    totalRelevantEventCount: total,
    eventCountsByRoleLabel: Object.keys(counts).sort().map((roleLabel) => ({ roleLabel, count: counts[roleLabel] })),
    affectedPositionIndicators: {
      controllerMintEventCount: counts["controller:Mint"],
      controllerBurnEventCount: counts["controller:Burn"],
      redeemerPositionRedemptionEventCount: counts["redeemer:PositionsRedeemed"],
      escrowPositionCreatedEventCount: counts["escrow:PositionCreated"],
      escrowLiquidationEventCount: counts["escrow:PositionLiquidated"],
      escrowRedemptionEventCount: counts["escrow:PositionRedeemed"],
      vaultMintEventCount: counts["vault:OsTokenMinted"],
      vaultBurnEventCount: counts["vault:OsTokenBurned"],
      vaultLiquidationEventCount: counts["vault:OsTokenLiquidated"],
      vaultRedemptionEventCount: counts["vault:OsTokenRedeemed"],
      anyBoundedPositionActivityObserved: counts["redeemer:PositionsRedeemed"] + counts["escrow:PositionCreated"] +
        counts["escrow:PositionLiquidated"] + counts["escrow:PositionRedeemed"] + counts["vault:OsTokenMinted"] > 0
    }
  };
}

function historiesMatch(left, right) {
  return left.complete === true && right.complete === true && canonicalJson(left.rows) === canonicalJson(right.rows);
}

function discoverRegistry(history, factorySeeds) {
  const factories = new Set(factorySeeds);
  const vaults = new Set();
  const implementations = new Set();
  for (const log of history.decodedLogs) {
    const args = log.decoded.args;
    if (log.label === "FactoryAdded" || log.label === "FactoryRemoved") factories.add(safeAddress(args.factory));
    if (log.label === "VaultAdded") vaults.add(safeAddress(args.vault));
    if (log.label === "VaultImplAdded" || log.label === "VaultImplRemoved") implementations.add(safeAddress(args.impl));
  }
  const clean = (set) => new Set([...set].filter(isNonzeroAddress));
  const result = { factories: clean(factories), vaults: clean(vaults), implementations: clean(implementations) };
  if (result.factories.size > CAPS.maxFactories || result.vaults.size > CAPS.maxVaults) throw new Error("DISCOVERY_CAP_EXCEEDED");
  return result;
}

function discoverFactoryVaults(history) {
  const vaults = new Set();
  for (const log of history.decodedLogs) {
    if (log.label === "VaultCreated" || log.label === "MetaVaultCreated") {
      const vault = safeAddress(log.decoded.args.vault);
      if (!isNonzeroAddress(vault)) throw new Error("FACTORY_EVENT_VAULT_INVALID");
      vaults.add(vault);
    }
  }
  if (vaults.size > CAPS.maxVaults) throw new Error("VAULT_CAP_EXCEEDED");
  return vaults;
}

async function registryMembership(endpoint, registry, fragment, addresses, pin, context) {
  const result = new Map();
  for (const address of addresses) {
    const decoded = await callDecoded(endpoint, registry, registryInterface, fragment, [address], pin, context);
    if (!decoded) throw new Error("REGISTRY_MEMBERSHIP_INCOMPLETE");
    result.set(address, Boolean(decoded[0]));
  }
  return result;
}

function membershipMapsMatch(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (!right.has(key) || right.get(key) !== value) return false;
  return true;
}

function bigintMapsMatch(left, right) {
  if (!left || !right || left.complete !== true || right.complete !== true || left.shares.size !== right.shares.size) return false;
  for (const [key, value] of left.shares) if (!right.shares.has(key) || right.shares.get(key) !== value) return false;
  return true;
}

function replayAuxiliaryControllers(tokenHistory) {
  const current = new Map();
  for (const log of tokenHistory.decodedLogs) {
    if (log.label !== "ControllerUpdated") continue;
    const controller = safeAddress(log.decoded.args.controller);
    if (!isNonzeroAddress(controller)) throw new Error("AUXILIARY_CONTROLLER_INVALID");
    current.set(controller, Boolean(log.decoded.args.registered));
  }
  const candidates = [...current.keys()];
  if (candidates.length > CAPS.maxAuxiliaryControllers) throw new Error("AUXILIARY_CONTROLLER_CAP_EXCEEDED");
  return { candidates, active: candidates.filter((address) => current.get(address)) };
}

async function verifyAuxiliaryControllers(endpoint, token, candidates, pin, context) {
  const current = new Map();
  for (const address of candidates) {
    const decoded = await callDecoded(endpoint, token, tokenInterface, "controllers", [address], pin, context);
    if (!decoded) throw new Error("AUXILIARY_CONTROLLER_STATE_INCOMPLETE");
    current.set(address, Boolean(decoded[0]));
  }
  return current;
}

async function readControllerShares(endpoint, addresses, pin, context) {
  const shares = new Map();
  for (const address of addresses) {
    const decoded = await callDecoded(endpoint, address, controllerInterface, "totalShares", [], pin, context);
    const value = decodedBigInt(decoded);
    if (value === null) return { complete: false, shares };
    shares.set(address, value);
  }
  return { complete: true, shares };
}

function reconcileGlobalSupply(totalSupply, mainShares, auxiliaryShares, allControllersIncluded) {
  if (totalSupply === null || mainShares === null || !allControllersIncluded || !auxiliaryShares.complete) {
    return { allControllersIncluded: false, reconciled: null, controllerCount: null };
  }
  let combined = mainShares;
  for (const value of auxiliaryShares.shares.values()) combined += value;
  return { allControllersIncluded: true, reconciled: combined === totalSupply, controllerCount: auxiliaryShares.shares.size + 1 };
}

function reconcileDualFamilySupply(observations, auxiliarySharesByFamily, allControllersIncluded) {
  if (!Array.isArray(observations) || observations.length !== 2 || !Array.isArray(auxiliarySharesByFamily) ||
    auxiliarySharesByFamily.length !== 2 || !allControllersIncluded ||
    !bigintMapsMatch(auxiliarySharesByFamily[0], auxiliarySharesByFamily[1])) {
    return { dualFamilyAgreement: false, allControllersIncluded: false, reconciled: null, controllerCount: null };
  }
  const left = observations[0] && observations[0].raw;
  const right = observations[1] && observations[1].raw;
  if (!left || !right || left.totalSupply === null || right.totalSupply === null || left.totalShares === null || right.totalShares === null ||
    left.totalSupply !== right.totalSupply || left.totalShares !== right.totalShares) {
    return { dualFamilyAgreement: false, allControllersIncluded: true, reconciled: null, controllerCount: null };
  }
  const result = reconcileGlobalSupply(left.totalSupply, left.totalShares, auxiliarySharesByFamily[0], true);
  return { dualFamilyAgreement: true, ...result };
}

const NATIVE_VAULT_IDS = new Set(["EthVault", "EthPrivVault", "EthMetaVault", "EthPrivMetaVault", "EthBlocklistVault",
  "EthGenesisVault", "EthFoxVault", "EthCommunityVault"].map((name) => id(name).toLowerCase()));

async function readVaultLineage(endpoint, registry, vault, pin, context) {
  const proxyCode = await readCode(endpoint, vault, pin, context);
  const implementationDecoded = await callDecoded(endpoint, vault, vaultInterface, "implementation", [], pin, context);
  const versionDecoded = await callDecoded(endpoint, vault, vaultInterface, "version", [], pin, context);
  const vaultIdDecoded = await callDecoded(endpoint, vault, vaultInterface, "vaultId", [], pin, context);
  const implementation = implementationDecoded ? safeAddress(implementationDecoded[0]) : null;
  const version = versionDecoded ? Number(versionDecoded[0]) : null;
  const vaultId = vaultIdDecoded ? strictHex(vaultIdDecoded[0], 32) : null;
  const implementationCode = implementation ? await readCode(endpoint, implementation, pin, context) : { present: false, hash: null };
  const memberDecoded = implementation
    ? await callDecoded(endpoint, registry, registryInterface, "vaultImpls", [implementation], pin, context)
    : null;
  const implementationMember = memberDecoded ? Boolean(memberDecoded[0]) : null;
  const partialComplete = proxyCode.present && implementationCode.present && implementation !== null && version !== null && vaultId !== null &&
    implementationMember !== null;
  return {
    internal: { vault, implementation, vaultId },
    sanitized: {
      proxyCodePresent: proxyCode.present,
      proxyRuntimeHash: proxyCode.hash,
      implementationCodePresent: implementationCode.present,
      implementationRuntimeHash: implementationCode.hash,
      implementationRegistryMember: implementationMember,
      version,
      nativeVaultIdRecognized: vaultId === null ? null : NATIVE_VAULT_IDS.has(vaultId),
      vaultOsTokenClassification: !partialComplete ? "INCOMPLETE" : version === 5 && NATIVE_VAULT_IDS.has(vaultId)
        ? "AFFECTED_V5_VAULT_OS_TOKEN_CANDIDATE" : version > 5 && NATIVE_VAULT_IDS.has(vaultId)
          ? "NEWER_NATIVE_VAULT_OS_TOKEN" : "OTHER_OR_UNKNOWN",
      partialLineageComplete: partialComplete,
      exactSourceRuntimeEquivalent: null
    }
  };
}

function aggregateVaultLineage(observations) {
  const counts = { AFFECTED_V5_VAULT_OS_TOKEN_CANDIDATE: 0, NEWER_NATIVE_VAULT_OS_TOKEN: 0, OTHER_OR_UNKNOWN: 0, INCOMPLETE: 0 };
  const implementationRuntimeHashes = new Set();
  let partialComplete = 0;
  for (const row of observations) {
    counts[row.sanitized.vaultOsTokenClassification] += 1;
    if (row.sanitized.partialLineageComplete) partialComplete += 1;
    if (row.sanitized.implementationRuntimeHash) implementationRuntimeHashes.add(row.sanitized.implementationRuntimeHash);
  }
  return {
    queriedVaultCount: observations.length,
    partialLineageCompleteCount: partialComplete,
    affectedV5CandidateCount: counts.AFFECTED_V5_VAULT_OS_TOKEN_CANDIDATE,
    newerNativeVaultCount: counts.NEWER_NATIVE_VAULT_OS_TOKEN,
    otherOrUnknownVaultCount: counts.OTHER_OR_UNKNOWN,
    incompleteVaultCount: counts.INCOMPLETE,
    uniqueImplementationRuntimeCount: implementationRuntimeHashes.size,
    implementationRuntimeHashes: [...implementationRuntimeHashes].sort(),
    exactSourceRuntimeEquivalence: null,
    usefulPartialLineage: observations.length > 0 && partialComplete > 0,
    promotableExactLineage: null
  };
}

function vaultLineageExactlyMatches(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return canonicalJson(exactComparable(left.map((row) => ({ internal: row.internal, sanitized: row.sanitized })))) ===
    canonicalJson(exactComparable(right.map((row) => ({ internal: row.internal, sanitized: row.sanitized }))));
}

function terminalPinMatches(expected, observed) {
  return Boolean(expected && observed && expected.number === observed.number && expected.hash === observed.hash);
}

async function terminalRecheck(rows, pin, context) {
  for (const row of rows) {
    const response = await rpcRequest(row.endpoint, "eth_getBlockByNumber", [toQuantity(pin.number), false], context);
    const header = response.ok ? parseBlockHeader(response.result) : null;
    if (!terminalPinMatches(pin, header)) return false;
  }
  return true;
}

function failClosedCapture(reasonCode, budget, facts = {}) {
  return {
    schemaVersion: 1,
    findingId: FINDING_ID,
    status: "INCOMPLETE_ALL_EXPOSURE_AND_ECONOMIC_GATES_NULL",
    reasonCode,
    liveCaptureExecuted: true,
    resultPromoted: false,
    facts,
    promotionGates: {
      runtimeLineageComplete: null,
      finalizedCommonPin: null,
      historyComplete: null,
      currentAffectedPositionExposure: null,
      aggregateEconomicExposure: null,
      controllerSupplyReconciled: null
    },
    operationalGates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false },
    budget
  };
}

function buildCaptureResult(conditions, budget, facts) {
  if (!budget || budget.allWithinCaps !== true) return failClosedCapture("BUDGET_NOT_WITHIN_CAPS", budget, facts);
  if (!conditions.finalityComplete) return failClosedCapture("TERMINAL_PIN_MISMATCH", budget, facts);
  if (!conditions.historyComplete) return failClosedCapture("HISTORY_INCOMPLETE_OR_MISMATCH", budget, facts);
  if (!conditions.stateAgreement) return failClosedCapture("STATE_FAMILY_MISMATCH", budget, facts);
  if (!conditions.registryAgreement) return failClosedCapture("REGISTRY_MEMBERSHIP_MISMATCH", budget, facts);
  if (conditions.exactLineage !== true) {
    const usefulPartial = facts && facts.vaultLineage && facts.vaultLineage.usefulPartialLineage === true &&
      facts.vaultLineage.partialLineageCompleteCount > 0 && facts.discovery &&
      facts.discovery.dualFamilyMembershipAgreement === true;
    if (usefulPartial) {
      const partial = failClosedCapture("SOURCE_RUNTIME_EQUIVALENCE_UNPROVEN", budget, facts);
      partial.status = "PARTIAL_USEFUL_LINEAGE_CAPTURED_EXPOSURE_AND_ECONOMIC_GATES_NULL";
      partial.facts.usefulPartialLineageCaptured = true;
      return partial;
    }
    return failClosedCapture("USEFUL_PARTIAL_LINEAGE_NOT_ESTABLISHED", budget, facts);
  }
  return {
    schemaVersion: 1,
    findingId: FINDING_ID,
    status: "COMPLETE_READ_ONLY_LINEAGE_AND_HISTORY_CAPTURED",
    reasonCode: null,
    liveCaptureExecuted: true,
    resultPromoted: true,
    facts,
    promotionGates: {
      runtimeLineageComplete: true,
      finalizedCommonPin: true,
      historyComplete: true,
      currentAffectedPositionExposure: null,
      aggregateEconomicExposure: null,
      controllerSupplyReconciled: conditions.supplyReconciled
    },
    operationalGates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false },
    budget
  };
}

function sanitizeCapture(value) {
  const serialized = canonicalJson(value);
  if (/(?:https?|wss?):\/\//iu.test(serialized)) throw new Error("OUTPUT_URL_LEAK");
  const forbiddenKey = /^(?:url|hostname|endpointUrl|providerIdentity|providerHash|endpointHash|identityHash|rawResponse|transactionHash|txHash|calldata|callerAddress|receiverAddress|ownerAddress|userAddress|positionTicket|vaultAddress)$/iu;
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (forbiddenKey.test(key) && child !== null && child !== false && child !== "") throw new Error("OUTPUT_IDENTITY_LEAK");
      if (typeof child === "string" && /^0x[0-9a-fA-F]{40}$/u.test(child)) throw new Error("OUTPUT_ADDRESS_LEAK");
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return value;
}

async function runCapture(args, dependencies = {}) {
  const caps = dependencies.caps || CAPS;
  const context = { caps, budget: new Budget(caps, dependencies.now || (() => Date.now())), nextId: 0 };
  const authorization = (dependencies.validateApproval || validateApproval)(args);
  context.budget.checkTime();
  (dependencies.consumeApproval || consumeApprovalAtomically)(authorization);
  let result;
  try {
    const local = (dependencies.loadLocalBindings || loadLocalBindings)();
    context.budget.checkTime();
    const endpoints = (dependencies.loadInventory || loadInventoryAuthorized)(context);
    const selected = await qualifyEndpoints(endpoints, context);
    if (!selected.promotable) {
      result = failClosedCapture("TWO_HOSTNAME_DISTINCT_FINALIZED_PIN_THRESHOLD_NOT_MET", context.budget.summary(), {
        bestQualifiedFamilyCount: selected.bestQualifiedFamilyCount,
        hostnameDiversityThresholdMet: false,
        backendIndependenceProven: false
      });
    } else {
      const observations = [];
      const protocolHistories = [];
      for (const row of selected.rows) {
        observations.push(await readProtocolObservation(row.endpoint, local.roles, selected.header.number, context));
        protocolHistories.push(await collectHistory(row.endpoint, local.roles, selected.header.number, context));
      }
      const publicObservations = observations.map((observation) => sanitizeObservation(observation, local.roles));
      const stateAgreement = protocolObservationsExactlyMatch(observations[0], observations[1]);
      const protocolHistoryAgreement = historiesMatch(protocolHistories[0], protocolHistories[1]);

      const registryHistory = protocolHistories.map((history) => ({
        ...history,
        decodedLogs: history.decodedLogs.filter((log) => log.role === "registry"),
        rows: canonicalLogRows(history.decodedLogs.filter((log) => log.role === "registry"))
      }));
      const registryDiscovery = registryHistory.map((history) => discoverRegistry(history, local.factorySeeds));
      const discoveryAgreement = canonicalJson({
        factories: [...registryDiscovery[0].factories].sort(), vaults: [...registryDiscovery[0].vaults].sort(),
        implementations: [...registryDiscovery[0].implementations].sort()
      }) === canonicalJson({
        factories: [...registryDiscovery[1].factories].sort(), vaults: [...registryDiscovery[1].vaults].sort(),
        implementations: [...registryDiscovery[1].implementations].sort()
      });
      if (!discoveryAgreement) throw new Error("REGISTRY_DISCOVERY_MISMATCH");

      const factories = [...registryDiscovery[0].factories];
      const factoryMembership = [];
      const factoryHistories = [];
      for (const row of selected.rows) {
        factoryMembership.push(await registryMembership(row.endpoint, local.roles.registry, "factories", factories,
          selected.header.number, context));
        factoryHistories.push(await collectRoleHistory(row.endpoint, factories.map((address) => ({ role: "factory", address })),
          selected.header.number, context));
      }
      const factoryMembershipAgreement = membershipMapsMatch(factoryMembership[0], factoryMembership[1]);
      const factoryHistoryAgreement = historiesMatch(factoryHistories[0], factoryHistories[1]);
      const factoryVaults = factoryHistories.map(discoverFactoryVaults);
      if (canonicalJson([...factoryVaults[0]].sort()) !== canonicalJson([...factoryVaults[1]].sort())) {
        throw new Error("FACTORY_DISCOVERY_MISMATCH");
      }
      const vaultSet = new Set([...registryDiscovery[0].vaults, ...factoryVaults[0]]);
      if (vaultSet.size > CAPS.maxVaults) throw new Error("VAULT_CAP_EXCEEDED");
      const vaults = [...vaultSet];
      const vaultMembership = [];
      for (const row of selected.rows) {
        vaultMembership.push(await registryMembership(row.endpoint, local.roles.registry, "vaults", vaults,
          selected.header.number, context));
      }
      const vaultMembershipAgreement = membershipMapsMatch(vaultMembership[0], vaultMembership[1]);
      const currentVaults = vaults.filter((vault) => vaultMembership[0].get(vault) === true && vaultMembership[1].get(vault) === true);

      const vaultLineageByFamily = [[], []];
      for (let familyIndex = 0; familyIndex < selected.rows.length; familyIndex++) {
        for (const vault of currentVaults) {
          vaultLineageByFamily[familyIndex].push(await readVaultLineage(selected.rows[familyIndex].endpoint, local.roles.registry,
            vault, selected.header.number, context));
        }
      }
      const vaultLineageAgreement = vaultLineageExactlyMatches(vaultLineageByFamily[0], vaultLineageByFamily[1]);
      const vaultLineage = aggregateVaultLineage(vaultLineageByFamily[0]);

      const vaultHistories = [];
      for (const row of selected.rows) {
        vaultHistories.push(currentVaults.length === 0
          ? { complete: true, canonical: true, rows: [], decodedLogs: [] }
          : await collectRoleHistory(row.endpoint, currentVaults.map((address) => ({ role: "vault", address })),
            selected.header.number, context));
      }
      const vaultHistoryAgreement = historiesMatch(vaultHistories[0], vaultHistories[1]);

      const tokenHistory = protocolHistories.map((history) => ({
        ...history,
        decodedLogs: history.decodedLogs.filter((log) => log.role === "token"),
        rows: canonicalLogRows(history.decodedLogs.filter((log) => log.role === "token"))
      }));
      const controllerReplay = tokenHistory.map(replayAuxiliaryControllers);
      if (canonicalJson(controllerReplay[0].candidates.sort()) !== canonicalJson(controllerReplay[1].candidates.sort())) {
        throw new Error("AUXILIARY_CONTROLLER_HISTORY_MISMATCH");
      }
      const auxiliaryState = [];
      for (const row of selected.rows) {
        auxiliaryState.push(await verifyAuxiliaryControllers(row.endpoint, local.roles.token, controllerReplay[0].candidates,
          selected.header.number, context));
      }
      const auxiliaryAgreement = membershipMapsMatch(auxiliaryState[0], auxiliaryState[1]);
      const activeAuxiliary = controllerReplay[0].candidates.filter((address) => auxiliaryState[0].get(address) === true &&
        auxiliaryState[1].get(address) === true);
      const auxiliarySharesByFamily = [];
      for (const row of selected.rows) {
        auxiliarySharesByFamily.push(await readControllerShares(row.endpoint, activeAuxiliary, selected.header.number, context));
      }
      const auxiliaryShareAgreement = bigintMapsMatch(auxiliarySharesByFamily[0], auxiliarySharesByFamily[1]);
      const reconciliation = reconcileDualFamilySupply(observations, auxiliarySharesByFamily,
        protocolHistoryAgreement && auxiliaryAgreement && auxiliaryShareAgreement);

      const historyAgreement = protocolHistoryAgreement && factoryHistoryAgreement && vaultHistoryAgreement;
      const finalityComplete = await terminalRecheck(selected.rows, selected.header, context);
      const historySummary = summarizeHistory([protocolHistories[0], factoryHistories[0], vaultHistories[0]]);
      const registryAgreement = factoryMembershipAgreement && vaultMembershipAgreement && vaultLineageAgreement && auxiliaryAgreement &&
        auxiliaryShareAgreement;
      const facts = {
        finalizedPin: { number: Number(selected.header.number), blockHash: selected.header.hash },
        hostnameDiversityFamilyCount: selected.families.length,
        hostnameDiversityThresholdMet: true,
        backendIndependenceProven: false,
        terminalSameNumberAndHashRecheckPassed: finalityComplete,
        dualFamilyStateAgreement: stateAgreement,
        dualFamilyHistoryAgreement: historyAgreement,
        canonicalEventBlockHeadersVerified: historyAgreement,
        sourceClosureBound: true,
        deploymentSeedsBound: true,
        observation: stateAgreement ? publicObservations[0] : null,
        history: historyAgreement ? historySummary : null,
        discovery: {
          historicalFactoryCount: factories.length,
          currentFactoryCount: [...factoryMembership[0].values()].filter(Boolean).length,
          historicalVaultCount: vaults.length,
          currentRegistryVaultCount: currentVaults.length,
          historicalImplementationCount: registryDiscovery[0].implementations.size,
          dualFamilyMembershipAgreement: registryAgreement
        },
        vaultLineage: vaultLineageAgreement ? vaultLineage : null,
        controllers: {
          mainControllerHandledAsImmutable: true,
          auxiliaryControllerCandidateCount: controllerReplay[0].candidates.length,
          activeAuxiliaryControllerCount: activeAuxiliary.length,
          allAuxiliaryControllersTracked: protocolHistoryAgreement && auxiliaryAgreement,
          dualFamilyAuxiliaryShareAgreement: auxiliaryShareAgreement,
          globalSupplyReconciliation: reconciliation.reconciled,
          includedControllerCount: reconciliation.controllerCount
        },
        rawUserIdentityPersisted: false,
        endpointOrProviderIdentityPersisted: false
      };
      context.budget.checkTime();
      result = buildCaptureResult({ finalityComplete, historyComplete: historyAgreement, stateAgreement, registryAgreement,
        exactLineage: vaultLineage.promotableExactLineage, supplyReconciled: reconciliation.reconciled }, context.budget.summary(), facts);
    }
  } catch (error) {
    const message = String(error.message || error);
    result = failClosedCapture(/^BUDGET_EXHAUSTED_/u.test(message) ? "BUDGET_EXHAUSTED" :
      /^INVENTORY_/u.test(message) ? "INVENTORY_PROCESSING_FAILED" : "CAPTURE_VALIDATION_FAILED", context.budget.summary());
  }
  let sanitized;
  try {
    context.budget.checkTime();
  } catch (_) {
    result = failClosedCapture("BUDGET_NOT_WITHIN_CAPS", context.budget.summary());
  }
  if (context.budget.summary().allWithinCaps !== true) {
    result = failClosedCapture("BUDGET_NOT_WITHIN_CAPS", context.budget.summary());
  }
  try {
    sanitized = sanitizeCapture(result);
  } catch (_) {
    sanitized = sanitizeCapture(failClosedCapture("OUTPUT_SANITIZATION_FAILED", context.budget.summary()));
  }
  (dependencies.writeOutput || fs.writeFileSync)(authorization.outputPath, `${JSON.stringify(sanitized, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" });
  return sanitized;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.capture) {
    process.stdout.write(`${JSON.stringify(dryPreflight(), null, 2)}\n`);
    return;
  }
  const result = await runCapture(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ALLOWED_METHODS,
  FORBIDDEN_METHODS,
  CAPS,
  FINDING_ID,
  FIXED_OUTPUT_REL,
  FIXED_APPROVAL_REL,
  GLOBAL_LEDGER_REL,
  MANIFEST_REL,
  SOURCE_MANIFEST_REL,
  PROPOSAL_REL,
  REVIEW_MANIFEST_REL,
  REVIEW_REPORT_REL,
  PACKAGE_ARTIFACTS,
  SOURCE_SEEDS,
  EVENT_SPECS,
  ABI: { tokenInterface, controllerInterface, configInterface, redeemerInterface, escrowInterface, registryInterface,
    factoryInterface, vaultInterface },
  Budget,
  bytes32Commitment,
  canonicalJson,
  buildCaptureResult,
  bigintMapsMatch,
  collectRoleHistory,
  callDecoded,
  collectHistory,
  consumeApprovalAtomically,
  decodeRoleLog,
  discoverFactoryVaults,
  discoverRegistry,
  discoverSourceClosure,
  dryPreflight,
  failClosedCapture,
  historiesMatch,
  isNonzeroAddress,
  loadInventoryAuthorized,
  loadLocalBindings,
  localSourceRecords,
  parseArgs,
  parseBlockHeader,
  parseRpcEnvelope,
  rpcRequest,
  readResponseBodyLimited,
  verifyCanonicalEventBlocks,
  reconcileGlobalSupply,
  reconcileDualFamilySupply,
  replayAuxiliaryControllers,
  protocolObservationsExactlyMatch,
  runCapture,
  sanitizeCapture,
  selectPin,
  summarizeHistory,
  terminalPinMatches,
  validateProposal,
  validateReviewManifest,
  vaultLineageExactlyMatches,
  validateApprovalEnvelope,
  validateLog,
  validatePackageManifest,
  validateSourceManifest
};
