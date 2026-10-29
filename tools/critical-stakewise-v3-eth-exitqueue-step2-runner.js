#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Interface, AbiCoder, id, keccak256, getAddress, zeroPadValue } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "stakewise-v3-core-v5.0.1");
const MAINNET_MANIFEST = path.join(TARGET, "deployments", "mainnet.json");
const MAINNET_UPGRADES = path.join(TARGET, "deployments", "mainnet-vault-upgrades.json");
const GNOSIS_MANIFEST = path.join(TARGET, "deployments", "gnosis.json");
const INVENTORY_PATH = path.join(ROOT, "rpc_endpoints.txt");
const FIXED_OUTPUT_REL = "reports/raw/fast/critical-stakewise-v3-eth-exitqueue-step2-capture.json";
const FIXED_OUTPUT_PATH = path.join(ROOT, ...FIXED_OUTPUT_REL.split("/"));
const FIXED_APPROVAL_REL = "coordination/decisions/stakewise-v3-eth-exitqueue-step2-r2-approval.json";
const GLOBAL_LEDGER_REL = "coordination/decisions/stakewise-v3-eth-exitqueue-step2-consumption-ledger.json";
const GLOBAL_LEDGER_PATH = path.join(ROOT, ...GLOBAL_LEDGER_REL.split("/"));
const MANIFEST_REL = "reports/raw/fast/critical-stakewise-v3-eth-exitqueue-step2-manifest.json";
const MANIFEST_PATH = path.join(ROOT, ...MANIFEST_REL.split("/"));
const PROPOSAL_REL = "reports/raw/fast/critical-stakewise-v3-eth-exitqueue-step2-approval-proposal.json";
const PROPOSAL_PATH = path.join(ROOT, ...PROPOSAL_REL.split("/"));
const CHAIN_ID = 1;
const FINDING_ID = "stakewise-v3-eth-exitqueue-step2";
const SOURCE_VERSION = 5;
const ALLOWED_METHODS = new Set([
  "eth_chainId",
  "eth_getLogs",
  "eth_call",
  "eth_getCode",
  "eth_getBlockByNumber"
]);
const FORBIDDEN_METHODS = new Set([
  "eth_estimateGas",
  "debug_traceCall",
  "trace_call",
  "eth_sendRawTransaction",
  "eth_sendTransaction",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getStorageAt"
]);
const CAPS = Object.freeze({
  chains: 1,
  maxInventoryEntries: 64,
  maxFamilies: 16,
  minPromotableFamilies: 2,
  maxFactories: 32,
  maxVaults: 5000,
  maxProvenCandidates: 100,
  maxLogChunkBlocks: 100000,
  maxAddressBatch: 100,
  maxLogs: 250000,
  maxUniqueEventBlocks: 2000,
  maxTotalRequests: 150000,
  maxLogRequests: 30000,
  maxCallRequests: 80000,
  maxCodeRequests: 15000,
  maxBlockRequests: 5000,
  maxRetries: 500,
  retriesPerRequest: 1,
  requestTimeoutMs: 10000,
  maxElapsedMs: 1800000,
  maxResponseBytes: 2097152
  ,maxAggregateResponseBytes: 536870912
  ,maxChunks: 4096
  ,maxScanSpanBlocks: 50000000
  ,minPlausiblePin: 1000000
  ,maxPlausiblePin: 50000000
  ,maxTimestampFetches: 2000
  ,maxApprovalWindowMs: 900000
  ,maxApprovalIssuedAgeMs: 300000
  ,maxApprovalFutureSkewMs: 30000
});

const BOUND_FILES = Object.freeze([
  "deployments/mainnet.json",
  "deployments/mainnet-vault-upgrades.json",
  "contracts/interfaces/IVaultsRegistry.sol",
  "contracts/interfaces/IEthVaultFactory.sol",
  "contracts/interfaces/IEthMetaVaultFactory.sol",
  "contracts/interfaces/IVaultEnterExit.sol",
  "contracts/interfaces/IVaultState.sol",
  "contracts/interfaces/IVaultVersion.sol",
  "contracts/libraries/ExitQueue.sol",
  "contracts/vaults/modules/VaultVersion.sol"
]);

const FACTORY_KEYS = [
  "VaultFactory",
  "PrivVaultFactory",
  "MetaVaultFactory",
  "PrivMetaVaultFactory",
  "BlocklistVaultFactory"
];
const DIRECT_VAULT_KEYS = ["CommunityVault", "FoxVault", "GenesisVault"];
const NATIVE_VAULT_IDS = [
  "EthVault",
  "EthPrivVault",
  "EthMetaVault",
  "EthPrivMetaVault",
  "EthBlocklistVault",
  "EthGenesisVault",
  "EthFoxVault",
  "EthCommunityVault"
];

const TOPICS = Object.freeze({
  factoryAdded: id("FactoryAdded(address)"),
  factoryRemoved: id("FactoryRemoved(address)"),
  vaultAdded: id("VaultAdded(address,address)"),
  vaultImplAdded: id("VaultImplAdded(address)"),
  vaultImplRemoved: id("VaultImplRemoved(address)"),
  vaultCreated: id("VaultCreated(address,address,address,bytes)"),
  metaVaultCreated: id("MetaVaultCreated(address,address,address,bytes)"),
  exitEntered: id("ExitQueueEntered(address,address,uint256,uint256)"),
  v2ExitEntered: id("V2ExitQueueEntered(address,address,uint256,uint256,uint256)"),
  checkpoint: id("CheckpointCreated(uint256,uint256)"),
  claimed: id("ExitedAssetsClaimed(address,uint256,uint256,uint256)"),
  upgraded: id("Upgraded(address)")
});

const registryInterface = new Interface([
  "function vaults(address) view returns (bool)",
  "function vaultImpls(address) view returns (bool)",
  "function factories(address) view returns (bool)"
]);
const viewInterface = new Interface([
  "function implementation() view returns (address)",
  "function vaultId() view returns (bytes32)",
  "function version() view returns (uint8)",
  "function totalAssets() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function getExitQueueData() view returns (uint128,uint128,uint128,uint128,uint256)",
  "function withdrawableAssets() view returns (uint256)",
  "function isStateUpdateRequired() view returns (bool)",
  "function convertToAssets(uint256) view returns (uint256)"
]);
const registryEvents = new Interface([
  "event FactoryAdded(address indexed factory)",
  "event FactoryRemoved(address indexed factory)",
  "event VaultAdded(address indexed caller,address indexed vault)",
  "event VaultImplAdded(address indexed impl)",
  "event VaultImplRemoved(address indexed impl)"
]);
const factoryEvents = new Interface([
  "event VaultCreated(address indexed admin,address indexed vault,address ownMevEscrow,bytes params)",
  "event MetaVaultCreated(address indexed caller,address indexed admin,address indexed vault,bytes params)"
]);
const vaultEvents = new Interface([
  "event ExitQueueEntered(address indexed owner,address indexed receiver,uint256 positionTicket,uint256 shares)",
  "event V2ExitQueueEntered(address indexed owner,address indexed receiver,uint256 positionTicket,uint256 shares,uint256 assets)",
  "event CheckpointCreated(uint256 shares,uint256 assets)",
  "event ExitedAssetsClaimed(address indexed receiver,uint256 prevPositionTicket,uint256 newPositionTicket,uint256 withdrawnAssets)",
  "event Upgraded(address indexed implementation)"
]);

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function commitment(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

function bytes32Commitment(value) {
  return `0x${commitment(value)}`;
}

function isBytes32(value) {
  return strictHex(value, 32) !== null;
}

function strictHex(value, bytes = null) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(value)) return null;
  if (bytes !== null && value.length !== 2 + bytes * 2) return null;
  return value.toLowerCase();
}

function strictQuantity(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u.test(value)) return null;
  try {
    return BigInt(value);
  } catch (_) {
    return null;
  }
}

function toQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function safeAddress(value) {
  try {
    return getAddress(value).toLowerCase();
  } catch (_) {
    return null;
  }
}

function topicAddress(topic) {
  const value = strictHex(topic, 32);
  return value ? safeAddress(`0x${value.slice(-40)}`) : null;
}

function encodeTopicAddress(address) {
  return zeroPadValue(address, 32).toLowerCase();
}

function parseBlockHeader(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const number = strictQuantity(block.number);
  const hash = strictHex(block.hash, 32);
  const timestamp = strictQuantity(block.timestamp);
  if (number === null || !hash || timestamp === null) return null;
  return { number, hash, timestamp };
}

function parseRpcEnvelope(body, expectedId) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (_) {
    return { ok: false, error: "MALFORMED_JSON", result: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "INVALID_ENVELOPE", result: null };
  }
  if (parsed.jsonrpc !== "2.0" || parsed.id !== expectedId) {
    return { ok: false, error: "ENVELOPE_MISMATCH", result: null };
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "error")) {
    if (!parsed.error || typeof parsed.error !== "object" || typeof parsed.error.code !== "number") {
      return { ok: false, error: "INVALID_ERROR", result: null };
    }
    return { ok: false, error: "RPC_ERROR", result: null };
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "result")) {
    return { ok: false, error: "MISSING_RESULT", result: null };
  }
  return { ok: true, error: null, result: parsed.result };
}

class Budget {
  constructor(caps = CAPS, now = () => Date.now()) {
    this.caps = caps;
    this.now = now;
    this.startedAt = now();
    this.total = 0;
    this.logs = 0;
    this.logsReturned = 0;
    this.calls = 0;
    this.codes = 0;
    this.blocks = 0;
    this.retries = 0;
    this.responseBytes = 0;
    this.chunks = 0;
    this.timestampFetches = 0;
    this.exhausted = null;
  }

  consume(method, retry = false) {
    if (this.exhausted) throw new Error(`BUDGET_EXHAUSTED_${this.exhausted}`);
    if (!ALLOWED_METHODS.has(method) || FORBIDDEN_METHODS.has(method)) throw new Error("METHOD_FORBIDDEN");
    if (this.now() - this.startedAt > this.caps.maxElapsedMs) this.exhausted = "TIME";
    this.total += 1;
    if (method === "eth_getLogs") this.logs += 1;
    if (method === "eth_call") this.calls += 1;
    if (method === "eth_getCode") this.codes += 1;
    if (method === "eth_getBlockByNumber") this.blocks += 1;
    if (retry) this.retries += 1;
    if (this.total > this.caps.maxTotalRequests) this.exhausted = "TOTAL_REQUESTS";
    if (this.logs > this.caps.maxLogRequests) this.exhausted = "LOG_REQUESTS";
    if (this.calls > this.caps.maxCallRequests) this.exhausted = "CALL_REQUESTS";
    if (this.codes > this.caps.maxCodeRequests) this.exhausted = "CODE_REQUESTS";
    if (this.blocks > this.caps.maxBlockRequests) this.exhausted = "BLOCK_REQUESTS";
    if (this.retries > this.caps.maxRetries) this.exhausted = "RETRIES";
    if (this.exhausted) throw new Error(`BUDGET_EXHAUSTED_${this.exhausted}`);
  }

  consumeResponseBytes(bytes) {
    this.responseBytes += bytes;
    if (this.responseBytes > this.caps.maxAggregateResponseBytes) {
      this.exhausted = "AGGREGATE_RESPONSE_BYTES";
      throw new Error(`BUDGET_EXHAUSTED_${this.exhausted}`);
    }
  }

  consumeChunk() {
    this.chunks += 1;
    if (this.chunks > this.caps.maxChunks) {
      this.exhausted = "CHUNKS";
      throw new Error(`BUDGET_EXHAUSTED_${this.exhausted}`);
    }
  }

  consumeTimestamp() {
    this.timestampFetches += 1;
    if (this.timestampFetches > this.caps.maxTimestampFetches) {
      this.exhausted = "TIMESTAMPS";
      throw new Error(`BUDGET_EXHAUSTED_${this.exhausted}`);
    }
  }

  consumeLogRow() {
    this.logsReturned += 1;
    if (this.logsReturned > this.caps.maxLogs) {
      this.exhausted = "LOG_ROWS";
      throw new Error(`BUDGET_EXHAUSTED_${this.exhausted}`);
    }
  }

  summary() {
    return {
      total: this.total,
      logs: this.logs,
      logsReturned: this.logsReturned,
      calls: this.calls,
      codes: this.codes,
      blocks: this.blocks,
      retries: this.retries,
      responseBytes: this.responseBytes,
      chunks: this.chunks,
      timestampFetches: this.timestampFetches,
      exhausted: this.exhausted,
      elapsedWithinCap: this.now() - this.startedAt <= this.caps.maxElapsedMs,
      allWithinCaps: this.exhausted === null && this.now() - this.startedAt <= this.caps.maxElapsedMs
    };
  }
}

async function rpcRequest(endpoint, method, params, context, fetchImpl = fetch) {
  if (!ALLOWED_METHODS.has(method) || FORBIDDEN_METHODS.has(method)) {
    return { ok: false, error: "METHOD_FORBIDDEN", result: null };
  }
  const idValue = ++context.nextId;
  for (let attempt = 0; attempt <= context.caps.retriesPerRequest; attempt++) {
    try {
      context.budget.consume(method, attempt > 0);
    } catch (error) {
      throw error;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), context.caps.requestTimeoutMs);
    try {
      const response = await fetchImpl(endpoint.url, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: idValue, method, params }),
        signal: controller.signal
      });
      if (response.redirected || response.status < 200 || response.status >= 300) {
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          return { ok: false, error: "REDIRECT_REJECTED", result: null };
        }
        if (attempt < context.caps.retriesPerRequest && response.status >= 500) continue;
        return { ok: false, error: "HTTP_STATUS", result: null };
      }
      const lengthHeader = response.headers && response.headers.get ? response.headers.get("content-length") : null;
      if (lengthHeader && Number(lengthHeader) > context.caps.maxResponseBytes) {
        context.budget.exhausted = "SINGLE_RESPONSE_BYTES";
        throw new Error("BUDGET_EXHAUSTED_SINGLE_RESPONSE_BYTES");
      }
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > context.caps.maxResponseBytes) {
        context.budget.exhausted = "SINGLE_RESPONSE_BYTES";
        throw new Error("BUDGET_EXHAUSTED_SINGLE_RESPONSE_BYTES");
      }
      context.budget.consumeResponseBytes(arrayBuffer.byteLength);
      return parseRpcEnvelope(Buffer.from(arrayBuffer).toString("utf8"), idValue);
    } catch (error) {
      if (/^BUDGET_EXHAUSTED_/u.test(String(error.message || error))) throw error;
      if (attempt >= context.caps.retriesPerRequest) {
        return { ok: false, error: "TRANSPORT_FAILURE", result: null };
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: "TRANSPORT_FAILURE", result: null };
}

function loadLocalMap() {
  const mainnet = JSON.parse(fs.readFileSync(MAINNET_MANIFEST, "utf8"));
  const upgrades = JSON.parse(fs.readFileSync(MAINNET_UPGRADES, "utf8"));
  const gnosisExists = fs.existsSync(GNOSIS_MANIFEST);
  const mainnetFactories = FACTORY_KEYS.map((key) => safeAddress(mainnet[key])).filter(Boolean);
  const mainnetVaults = DIRECT_VAULT_KEYS.map((key) => safeAddress(mainnet[key])).filter(Boolean);
  const upgradeVersions = [...new Set(Object.values(upgrades).flatMap((row) => Object.keys(row)))].sort();
  const boundFiles = BOUND_FILES.map((relativePath) => {
    const bytes = fs.readFileSync(path.join(TARGET, ...relativePath.split("/")));
    return { path: relativePath, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const packageSourceBinding = bytes32Commitment(boundFiles);
  return {
    registry: safeAddress(mainnet.VaultsRegistry),
    factories: mainnetFactories,
    directVaults: mainnetVaults,
    boundFiles,
    packageSourceBinding,
    sanitized: {
      mainnetManifestExists: true,
      gnosisManifestExists: gnosisExists,
      gnosisOutOfScope: true,
      sourceEthVaultVersion: SOURCE_VERSION,
      mainnetUpgradeVersions: upgradeVersions,
      mainnetUpgradeTargetsVersion7: upgradeVersions.includes("7"),
      currentSemanticsInferredFromManifest: false,
      registryPresent: Boolean(mainnet.VaultsRegistry),
      factoryCount: mainnetFactories.length,
      directVaultCount: mainnetVaults.length,
      boundFileCount: boundFiles.length,
      packageSourceBinding
    }
  };
}

function dryPreflight() {
  const local = loadLocalMap();
  return {
    schemaVersion: 1,
    findingId: FINDING_ID,
    status: "PREPARED_NOT_AUTHORIZED_NOT_EXECUTED",
    chain: { name: "ethereum-mainnet", chainId: CHAIN_ID, chains: 1 },
    authorization: {
      captureFlagRequired: "--capture-once",
      checkOnlyFlag: "--check-only",
      modesMutuallyExclusive: true,
      approvalFileRequired: true,
      fixedApprovalPath: FIXED_APPROVAL_REL,
      approvalStateRequired: "AUTHORIZED_AFTER_INDEPENDENT_REVIEW",
      proposalState: "REVIEW_REQUESTED",
      proposalAuthorization: "NOT_AUTHORIZED",
      fixedOutputPath: FIXED_OUTPUT_REL,
      globalConsumptionLedger: GLOBAL_LEDGER_REL,
      singleUseLedgerRequired: true,
      authorized: false,
      captureExecuted: false
    },
    localMap: local.sanitized,
    providerPolicy: {
      inventoriesConsumedOnlyAfterAuthorization: true,
      minimumHostnameDistinctFamilies: CAPS.minPromotableFamilies,
      familyBackendIndependenceProven: false,
      endpointIdentitiesPersisted: false
    },
    methods: {
      allowed: [...ALLOWED_METHODS].sort(),
      forbidden: [...FORBIDDEN_METHODS].sort(),
      traceFollowUp: "PROPOSAL_ONLY_FORBIDDEN_IN_FIRST_CAPTURE"
    },
    caps: CAPS,
    gates: {
      exactAffectedRuntime: null,
      vulnerableShapedSemantics: null,
      currentQueuedExposure: null,
      historicallyProvenTrigger: null,
      currentlyLockedValue: null,
      callerProfit: 0,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      fork: false
    },
    networkReads: 0,
    inventoryReads: 0,
    writes: 0
  };
}

function loadInventoryAuthorized() {
  const content = fs.readFileSync(INVENTORY_PATH, "utf8");
  const urls = [];
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/https?:\/\/[^\s'"<>\[\]]+/u);
    if (!match) continue;
    let parsed;
    try {
      parsed = new URL(match[0].replace(/[)\]]+$/u, ""));
    } catch (_) {
      continue;
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) continue;
    if (/testnet|sepolia|hoodi|gnosis|chiado/iu.test(parsed.href)) continue;
    urls.push(parsed.href);
    if (urls.length >= CAPS.maxInventoryEntries) break;
  }
  const hostnameToFamily = new Map();
  const endpoints = [];
  for (const url of urls) {
    const hostname = new URL(url).hostname.toLowerCase();
    if (!hostnameToFamily.has(hostname)) {
      if (hostnameToFamily.size >= CAPS.maxFamilies) continue;
      hostnameToFamily.set(hostname, `F${hostnameToFamily.size + 1}`);
    }
    endpoints.push({ url, family: hostnameToFamily.get(hostname) });
  }
  return endpoints;
}

function selectPin(observations, minFamilies = CAPS.minPromotableFamilies) {
  const groups = new Map();
  for (const row of observations) {
    if (!row || row.chainId !== CHAIN_ID || !row.header) continue;
    if (row.header.number < BigInt(CAPS.minPlausiblePin) || row.header.number > BigInt(CAPS.maxPlausiblePin)) continue;
    const key = `${row.header.number}:${row.header.hash}`;
    if (!groups.has(key)) groups.set(key, []);
    if (!groups.get(key).some((item) => item.family === row.family)) groups.get(key).push(row);
  }
  const ranked = [...groups.values()].sort((a, b) => b.length - a.length);
  const selected = ranked.find((rows) => rows.length >= minFamilies) || null;
  if (!selected) return { promotable: false, header: null, families: [], familyBackendIndependenceProven: false };
  return {
    promotable: true,
    header: selected[0].header,
    families: selected.map((row) => row.family).sort(),
    familyBackendIndependenceProven: false
  };
}

function validateLog(log, expectedAddressSet = null, fromBlock = null, toBlock = null) {
  if (!log || typeof log !== "object" || Array.isArray(log)) return null;
  const address = safeAddress(log.address);
  const blockNumber = strictQuantity(log.blockNumber);
  const logIndex = strictQuantity(log.logIndex);
  const transactionIndex = strictQuantity(log.transactionIndex);
  const blockHash = strictHex(log.blockHash, 32);
  const transactionHash = strictHex(log.transactionHash, 32);
  const data = strictHex(log.data);
  if (!address || blockNumber === null || logIndex === null || transactionIndex === null || !blockHash || !transactionHash || !data) return null;
  if (log.removed !== false) return null;
  if (fromBlock !== null && blockNumber < BigInt(fromBlock)) return null;
  if (toBlock !== null && blockNumber > BigInt(toBlock)) return null;
  if (!Array.isArray(log.topics) || log.topics.length === 0 || !log.topics.every((topic) => strictHex(topic, 32))) return null;
  if (expectedAddressSet && !expectedAddressSet.has(address)) return null;
  return {
    address,
    blockNumber,
    logIndex,
    transactionIndex,
    blockHash,
    transactionHash,
    data,
    topics: log.topics.map((topic) => topic.toLowerCase())
  };
}

function dedupeLogs(logs) {
  const rows = new Map();
  for (const log of logs) {
    const key = `${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
    const encoded = canonicalJson({
      address: log.address,
      blockNumber: log.blockNumber.toString(),
      transactionIndex: log.transactionIndex.toString(),
      logIndex: log.logIndex.toString(),
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      topics: log.topics,
      data: log.data
    });
    if (rows.has(key) && rows.get(key).encoded !== encoded) return { ok: false, logs: [], duplicateCount: 0 };
    if (!rows.has(key)) rows.set(key, { encoded, log });
  }
  return { ok: true, logs: [...rows.values()].map((row) => row.log), duplicateCount: logs.length - rows.size };
}

function compareCandidateMembership(primary, secondary) {
  if (typeof primary !== "boolean" || typeof secondary !== "boolean" || primary !== secondary) {
    return { complete: false, active: null };
  }
  return { complete: true, active: primary };
}

function canonicalLogsMatchHeaders(logs, headersByNumber) {
  for (const log of logs) {
    const header = headersByNumber.get(log.blockNumber.toString());
    if (!header || header.number !== log.blockNumber || header.hash !== log.blockHash) return false;
  }
  return true;
}

function validateScanRange(fromBlock, toBlock, caps = CAPS) {
  const from = BigInt(fromBlock);
  const to = BigInt(toBlock);
  return to >= from && to - from + 1n <= BigInt(caps.maxScanSpanBlocks);
}

function logsCommitment(logs) {
  return commitment(logs.map((log) => ({
    address: log.address,
    blockNumber: log.blockNumber.toString(),
    transactionIndex: log.transactionIndex.toString(),
    logIndex: log.logIndex.toString(),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    topics: log.topics,
    data: log.data
  })).sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : 1;
    if (a.transactionIndex !== b.transactionIndex) return BigInt(a.transactionIndex) < BigInt(b.transactionIndex) ? -1 : 1;
    if (a.logIndex !== b.logIndex) return BigInt(a.logIndex) < BigInt(b.logIndex) ? -1 : 1;
    return a.address.localeCompare(b.address);
  }));
}

function observationCommitment(runtime, state) {
  return commitment({
    codeHash: runtime ? runtime.observedCodeHash : null,
    proxyCodeHash: runtime ? runtime.observedProxyRuntimeHash : null,
    observedVaultId: runtime ? runtime.observedVaultId : null,
    implementationRegistryMember: runtime ? runtime.implementationRegistryMember : null,
    vaultRegistryMember: runtime ? runtime.vaultRegistryMember : null,
    version: runtime ? runtime.version : null,
    totalAssets: state && state.totalAssets !== null ? state.totalAssets.toString() : null,
    totalShares: state && state.totalShares !== null ? state.totalShares.toString() : null,
    queueData: state && state.queueData ? {
      queuedShares: state.queueData.queuedShares.toString(),
      unclaimedAssets: state.queueData.unclaimedAssets.toString(),
      totalExitingTickets: state.queueData.totalExitingTickets.toString(),
      totalExitingAssets: state.queueData.totalExitingAssets.toString(),
      totalTickets: state.queueData.totalTickets.toString()
    } : null,
    withdrawableAssets: state && state.withdrawableAssets !== null ? state.withdrawableAssets.toString() : null,
    stateUpdateRequired: state ? state.stateUpdateRequired : null,
    rawBalance: state && state.raw.rawBalance !== null ? state.raw.rawBalance.toString() : null,
    rawBalanceUpperBound: state && state.raw.rawBalanceUpperBound !== null ? state.raw.rawBalanceUpperBound.toString() : null
  });
}

async function getLogsChunked(endpoint, fromBlock, toBlock, filter, context) {
  const logs = [];
  let complete = true;
  if (!validateScanRange(fromBlock, toBlock, context.caps)) {
    throw new Error("SCAN_SPAN_IMPLAUSIBLE");
  }
  const expectedAddresses = filter.address
    ? new Set((Array.isArray(filter.address) ? filter.address : [filter.address]).map(safeAddress).filter(Boolean))
    : null;
  for (let start = BigInt(fromBlock); start <= BigInt(toBlock); start += BigInt(context.caps.maxLogChunkBlocks)) {
    context.budget.consumeChunk();
    const end = start + BigInt(context.caps.maxLogChunkBlocks - 1) > BigInt(toBlock)
      ? BigInt(toBlock)
      : start + BigInt(context.caps.maxLogChunkBlocks - 1);
    const response = await rpcRequest(endpoint, "eth_getLogs", [{ ...filter, fromBlock: toQuantity(start), toBlock: toQuantity(end) }], context);
    if (!response.ok || !Array.isArray(response.result)) {
      complete = false;
      continue;
    }
    for (const raw of response.result) {
      const parsed = validateLog(raw, expectedAddresses, start, end);
      if (!parsed) {
        throw new Error("MALFORMED_OR_OUT_OF_RANGE_LOG");
      }
      logs.push(parsed);
      context.budget.consumeLogRow();
    }
  }
  const deduped = dedupeLogs(logs);
  if (!deduped.ok) throw new Error("CONFLICTING_DUPLICATE_LOG");
  return { logs: deduped.logs, complete, duplicateCount: deduped.duplicateCount };
}

async function ethCall(endpoint, to, data, pin, context) {
  const response = await rpcRequest(endpoint, "eth_call", [{ to, data }, toQuantity(pin)], context);
  return response.ok && strictHex(response.result) ? response.result : null;
}

async function callDecoded(endpoint, to, fragment, args, pin, context) {
  const data = viewInterface.encodeFunctionData(fragment, args || []);
  const raw = await ethCall(endpoint, to, data, pin, context);
  if (!raw) return null;
  try {
    return viewInterface.decodeFunctionResult(fragment, raw);
  } catch (_) {
    return null;
  }
}

async function registryBool(endpoint, registry, fragment, address, pin, context) {
  const data = registryInterface.encodeFunctionData(fragment, [address]);
  const raw = await ethCall(endpoint, registry, data, pin, context);
  if (!raw) return null;
  try {
    return Boolean(registryInterface.decodeFunctionResult(fragment, raw)[0]);
  } catch (_) {
    return null;
  }
}

function classifyRuntime(input) {
  const version = Number.isInteger(input.version) ? input.version : null;
  const observedCodeHash = isBytes32(input.observedImplementationRuntimeHash) ? input.observedImplementationRuntimeHash.toLowerCase() : null;
  const observedProxyRuntimeHash = isBytes32(input.observedProxyRuntimeHash) ? input.observedProxyRuntimeHash.toLowerCase() : null;
  let exactRuntime = null;
  if (version === SOURCE_VERSION && input.v5Bundle) {
    const bundle = input.v5Bundle;
    if (
      bundle.constructorImmutablesReconstructed === true &&
      bundle.compiler === "0.8.26" &&
      bundle.evmVersion === "cancun" &&
      bundle.optimizer === true &&
      bundle.optimizerRuns === 200 &&
      bundle.viaIR === true &&
      isBytes32(bundle.expectedImplementationRuntimeHash) &&
      isBytes32(bundle.expectedProxyRuntimeHash) &&
      isBytes32(bundle.expectedNativeVaultId) &&
      observedCodeHash && observedProxyRuntimeHash && isBytes32(input.observedVaultId) &&
      input.implementationViewMatchedSlot === true && input.implementationRegistryMember === true &&
      input.vaultRegistryMember === true && input.factoryLineageComplete === true && input.dualFamilyAgreement === true
    ) {
      exactRuntime = bundle.expectedImplementationRuntimeHash.toLowerCase() === observedCodeHash &&
        bundle.expectedProxyRuntimeHash.toLowerCase() === observedProxyRuntimeHash &&
        bundle.expectedNativeVaultId.toLowerCase() === input.observedVaultId.toLowerCase();
    }
  }
  return {
    version,
    observedCodeHash,
    observedProxyRuntimeHash,
    exactRuntime,
    exactAffectedRuntime: version === SOURCE_VERSION && exactRuntime === true ? true : exactRuntime === false ? false : null,
    vulnerableShapedSemantics: null,
    semantics: version === SOURCE_VERSION && exactRuntime === true ? "EXACT_V5_AFFECTED_SOURCE" : null,
    v5EquivalenceClaimed: version === SOURCE_VERSION && exactRuntime === true,
    newerVersionNonEquivalent: version !== null && version > SOURCE_VERSION ? true : null
  };
}

function calculateExitedAssets(checkpoints, checkpointIndex, positionTicket, positionShares) {
  if (!Number.isInteger(checkpointIndex) || checkpointIndex < 0 || checkpointIndex >= checkpoints.length || positionShares <= 0n) {
    return { ok: true, burnedShares: 0n, exitedAssets: 0n };
  }
  let previousTotal = checkpointIndex === 0 ? 0n : checkpoints[checkpointIndex - 1].totalTickets;
  let checkpoint = checkpoints[checkpointIndex];
  if (positionTicket < previousTotal || checkpoint.totalTickets <= positionTicket) {
    return { ok: false, error: "INVALID_CHECKPOINT", burnedShares: null, exitedAssets: null };
  }
  if (checkpoint.totalTickets > 1n && checkpoint.exitedAssets === 0n && checkpointIndex + 1 < checkpoints.length) {
    const migrationCheckpoint = checkpoints[checkpointIndex + 1];
    const totalShares = migrationCheckpoint.totalTickets - checkpoint.totalTickets;
    if (totalShares <= 0n || positionShares > totalShares) {
      return { ok: false, error: "INVALID_V2_V3_MIGRATION", burnedShares: null, exitedAssets: null, migration: true };
    }
    return {
      ok: true,
      burnedShares: positionShares,
      exitedAssets: (positionShares * migrationCheckpoint.exitedAssets) / totalShares,
      migration: true
    };
  }
  let currentTotal = checkpoint.totalTickets;
  let availableShares = currentTotal - positionTicket;
  let burnedShares = 0n;
  let exitedAssets = 0n;
  let index = checkpointIndex;
  while (true) {
    const checkpointShares = currentTotal - previousTotal;
    if (checkpointShares <= 0n) return { ok: false, error: "INVALID_CHECKPOINT_ORDER", burnedShares: null, exitedAssets: null };
    const remaining = positionShares - burnedShares;
    const sharesDelta = availableShares < remaining ? availableShares : remaining;
    burnedShares += sharesDelta;
    exitedAssets += (sharesDelta * checkpoint.exitedAssets) / checkpointShares;
    index += 1;
    if (burnedShares >= positionShares || index >= checkpoints.length) {
      return { ok: true, burnedShares, exitedAssets };
    }
    previousTotal = currentTotal;
    checkpoint = checkpoints[index];
    currentTotal = checkpoint.totalTickets;
    availableShares = currentTotal - previousTotal;
  }
}

function firstCheckpointIndex(checkpoints, ticket) {
  let low = 0;
  let high = checkpoints.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (checkpoints[middle].totalTickets > ticket) high = middle;
    else low = middle + 1;
  }
  return low < checkpoints.length ? low : -1;
}

function replayHistory(events, options = {}) {
  const completeHistory = options.completeHistory === true;
  const requests = new Map();
  const checkpoints = [];
  const proven = [];
  let cumulativeTickets = 0n;
  let ambiguous = 0;
  let malformed = 0;
  let floorResidual = 0n;
  const blockCounts = new Map();
  const txCounts = new Map();
  const ordered = [...events].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex < b.transactionIndex ? -1 : 1;
    return a.logIndex < b.logIndex ? -1 : a.logIndex > b.logIndex ? 1 : 0;
  });
  for (const event of ordered) {
    const blockKey = event.blockNumber.toString();
    const txKey = `${blockKey}:${event.transactionIndex}`;
    blockCounts.set(blockKey, (blockCounts.get(blockKey) || 0) + 1);
    txCounts.set(txKey, (txCounts.get(txKey) || 0) + 1);
  }
  for (const event of ordered) {
    const sameBlockAmbiguous = (blockCounts.get(event.blockNumber.toString()) || 0) > 1;
    const sameTxAmbiguous = (txCounts.get(`${event.blockNumber}:${event.transactionIndex}`) || 0) > 1;
    if (event.type === "checkpoint") {
      if (event.shares <= 0n || event.assets < 0n) {
        malformed += 1;
        continue;
      }
      cumulativeTickets += event.shares;
      checkpoints.push({ totalTickets: cumulativeTickets, exitedAssets: event.assets });
      continue;
    }
    if (event.type === "enter" || event.type === "enterV2") {
      const key = `${event.receiver}:${event.ticket}`;
      if (requests.has(key) || event.shares <= 0n || event.timestamp === null) {
        ambiguous += 1;
        continue;
      }
      requests.set(key, {
        receiver: event.receiver,
        ticket: event.ticket,
        shares: event.shares,
        timestamp: event.timestamp,
        v2Assets: event.type === "enterV2" ? event.assets : null,
        active: true,
        ambiguous: sameBlockAmbiguous || sameTxAmbiguous
      });
      continue;
    }
    if (event.type === "claim") {
      const key = `${event.receiver}:${event.prevTicket}`;
      const request = requests.get(key);
      if (!request || !request.active) {
        ambiguous += 1;
        continue;
      }
      const index = firstCheckpointIndex(checkpoints, request.ticket);
      if (index < 0) {
        ambiguous += 1;
        request.ambiguous = true;
        continue;
      }
      const calculated = calculateExitedAssets(checkpoints, index, request.ticket, request.shares);
      if (!calculated.ok || calculated.burnedShares === 0n || calculated.exitedAssets !== event.withdrawnAssets) {
        ambiguous += 1;
        request.ambiguous = true;
        continue;
      }
      const rawLeft = request.shares - calculated.burnedShares;
      const expectedNew = rawLeft > 1n ? request.ticket + calculated.burnedShares : 0n;
      if (event.newTicket !== expectedNew) {
        ambiguous += 1;
        request.ambiguous = true;
        continue;
      }
      const checkpoint = checkpoints[index];
      const previous = index === 0 ? 0n : checkpoints[index - 1].totalTickets;
      const denominator = checkpoint.totalTickets - previous;
      const numerator = calculated.burnedShares * checkpoint.exitedAssets;
      if (denominator > 0n) floorResidual += numerator % denominator;
      const candidateAmbiguous = request.ambiguous || sameBlockAmbiguous || sameTxAmbiguous || !completeHistory ||
        ambiguous > 0 || malformed > 0;
      if (rawLeft === 1n) {
        proven.push({
          mathematicallyProven: candidateAmbiguous ? null : true,
          ambiguous: candidateAmbiguous,
          orphanTickets: candidateAmbiguous ? null : 1,
          withdrawnAssets: calculated.exitedAssets,
          migration: calculated.migration === true
        });
      }
      request.active = false;
      requests.delete(key);
      if (rawLeft > 1n) {
        requests.set(`${event.receiver}:${expectedNew}`, {
          ...request,
          ticket: expectedNew,
          shares: rawLeft,
          active: true,
          ambiguous: candidateAmbiguous
        });
      }
    }
  }
  const prefixValid = completeHistory && ambiguous === 0 && malformed === 0;
  const mathematicallyProven = prefixValid ? proven.filter((row) => row.mathematicallyProven === true) : [];
  return {
    completeHistory,
    checkpointCount: checkpoints.length,
    activeRequestCount: requests.size,
    provenCandidateCount: mathematicallyProven.length,
    nullCandidateCount: proven.length - mathematicallyProven.length,
    ambiguousCount: ambiguous,
    malformedCount: malformed,
    floorRemainderNumeratorAggregate: floorResidual,
    prefixValid,
    migrationCandidateCount: mathematicallyProven.filter((row) => row.migration).length,
    candidates: mathematicallyProven.slice(0, CAPS.maxProvenCandidates)
  };
}

function deriveRawBalance(queueData, withdrawableAssets, queuedAssets, rawSemanticsProven = true) {
  if (!rawSemanticsProven || !queueData || withdrawableAssets === null || queuedAssets === null) {
    return { rawBalance: null, rawBalanceUpperBound: null, exact: false };
  }
  const reserved = queuedAssets + queueData.totalExitingAssets + queueData.unclaimedAssets;
  if (withdrawableAssets > 0n) {
    return { rawBalance: withdrawableAssets + reserved, rawBalanceUpperBound: null, exact: true };
  }
  return { rawBalance: null, rawBalanceUpperBound: reserved, exact: false };
}

function parseQueueData(decoded) {
  if (!decoded || decoded.length < 5) return null;
  try {
    return {
      queuedShares: BigInt(decoded[0]),
      unclaimedAssets: BigInt(decoded[1]),
      totalExitingTickets: BigInt(decoded[2]),
      totalExitingAssets: BigInt(decoded[3]),
      totalTickets: BigInt(decoded[4])
    };
  } catch (_) {
    return null;
  }
}

async function readVaultObservation(endpoint, registry, vault, pin, context) {
  const vaultRegistryMember = await registryBool(endpoint, registry, "vaults", vault, pin, context);
  const codeResponse = await rpcRequest(endpoint, "eth_getCode", [vault, toQuantity(pin)], context);
  const proxyCode = codeResponse.ok ? strictHex(codeResponse.result) : null;
  const proxyCodeHash = proxyCode && proxyCode !== "0x" ? keccak256(proxyCode) : null;
  const implementationDecoded = await callDecoded(endpoint, vault, "implementation", [], pin, context);
  const implementation = implementationDecoded ? safeAddress(implementationDecoded[0]) : null;
  const implementationCodeResponse = implementation
    ? await rpcRequest(endpoint, "eth_getCode", [implementation, toQuantity(pin)], context)
    : null;
  const implementationCode = implementationCodeResponse && implementationCodeResponse.ok
    ? strictHex(implementationCodeResponse.result)
    : null;
  const implementationCodeHash = implementationCode && implementationCode !== "0x" ? keccak256(implementationCode) : null;
  const implementationRegistryMember = implementation
    ? await registryBool(endpoint, registry, "vaultImpls", implementation, pin, context)
    : null;
  const versionDecoded = await callDecoded(endpoint, vault, "version", [], pin, context);
  const idDecoded = await callDecoded(endpoint, vault, "vaultId", [], pin, context);
  const version = versionDecoded ? Number(versionDecoded[0]) : null;
  const vaultId = idDecoded ? String(idDecoded[0]).toLowerCase() : null;
  const nativeName = NATIVE_VAULT_IDS.find((name) => id(name).toLowerCase() === vaultId) || null;
  const runtime = {
    ...classifyRuntime({
      version,
      observedImplementationRuntimeHash: implementationCodeHash,
      observedProxyRuntimeHash: proxyCodeHash,
      observedVaultId: vaultId,
      implementationViewMatchedSlot: null,
      implementationRegistryMember,
      vaultRegistryMember,
      factoryLineageComplete: false,
      dualFamilyAgreement: false,
      v5Bundle: null
    }),
    _implementation: implementation,
    implementationRegistryMember,
    vaultRegistryMember,
    implementationViewReturnedAddress: implementation !== null,
    implementationViewMatchedSlot: null,
    observedVaultId: vaultId,
    nativeName
  };

  const totalAssetsDecoded = await callDecoded(endpoint, vault, "totalAssets", [], pin, context);
  const totalSharesDecoded = await callDecoded(endpoint, vault, "totalShares", [], pin, context);
  const queueDecoded = await callDecoded(endpoint, vault, "getExitQueueData", [], pin, context);
  const withdrawableDecoded = await callDecoded(endpoint, vault, "withdrawableAssets", [], pin, context);
  const updateRequiredDecoded = await callDecoded(endpoint, vault, "isStateUpdateRequired", [], pin, context);
  const queueData = parseQueueData(queueDecoded);
  const queuedAssetsDecoded = queueData
    ? await callDecoded(endpoint, vault, "convertToAssets", [queueData.queuedShares], pin, context)
    : null;
  const withdrawable = withdrawableDecoded ? BigInt(withdrawableDecoded[0]) : null;
  const queuedAssets = queuedAssetsDecoded ? BigInt(queuedAssetsDecoded[0]) : null;
  const state = {
    totalAssets: totalAssetsDecoded ? BigInt(totalAssetsDecoded[0]) : null,
    totalShares: totalSharesDecoded ? BigInt(totalSharesDecoded[0]) : null,
    queueData,
    withdrawableAssets: withdrawable,
    stateUpdateRequired: updateRequiredDecoded ? Boolean(updateRequiredDecoded[0]) : null,
    raw: deriveRawBalance(queueData, withdrawable, queuedAssets,
      runtime.exactRuntime === true && nativeName !== "EthGenesisVault"),
    type: null,
    collateralized: null,
    privateOrBlocklist: null
  };
  return { runtime, state };
}

function sanitizeCapture(result) {
  const serialized = canonicalJson(result);
  if (/(?:https?|wss?):\/\//iu.test(serialized)) throw new Error("OUTPUT_URL_LEAK");
  const forbiddenKey = /hostname|providerHash|endpointHash|transactionHash|callerAddress|receiverAddress|positionTicket|prevTicket|newTicket|vaultCommitment|factorySetCommitment|vaultSetCommitment|rawResponse|calldata/iu;
  const stack = [result];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKey.test(key) && child !== false && child !== null && child !== "") {
        throw new Error("OUTPUT_IDENTITY_LEAK");
      }
      if (typeof child === "string" && /^0x[0-9a-fA-F]{40}$/u.test(child)) throw new Error("OUTPUT_ADDRESS_LEAK");
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return result;
}

function parseArgs(argv) {
  const args = { capture: false, checkOnly: false, approvalFile: null };
  for (let index = 2; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--capture-once") args.capture = true;
    else if (value === "--approval-file") args.approvalFile = argv[++index] || null;
    else if (value === "--check-only" || value === "--preflight") args.checkOnly = true;
    else throw new Error("UNKNOWN_ARGUMENT");
  }
  if (args.capture && args.checkOnly) throw new Error("MODE_CONFLICT");
  if (!args.capture) args.checkOnly = true;
  return args;
}

function validateApprovalEnvelope(approval, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const payload = approval && approval.approvalPayload;
  if (!approval || approval.schemaVersion !== 2 || approval.state !== "AUTHORIZED" || !payload) throw new Error("APPROVAL_STATE_INVALID");
  if (!/^swv3-step2-[0-9a-f]{32}$/u.test(payload.approvalId || "")) throw new Error("APPROVAL_ID_INVALID");
  if (!isBytes32(approval.approvalCommitment) || approval.approvalCommitment !== bytes32Commitment(payload)) {
    throw new Error("APPROVAL_COMMITMENT_INVALID");
  }
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt ||
    expiresAt - issuedAt > CAPS.maxApprovalWindowMs || issuedAt > now + CAPS.maxApprovalFutureSkewMs ||
    now - issuedAt > CAPS.maxApprovalIssuedAgeMs || now >= expiresAt) throw new Error("APPROVAL_WINDOW_INVALID");
  const expected = options.expected || {};
  if (payload.findingId !== FINDING_ID || payload.chainId !== CHAIN_ID || payload.authorizedCaptureCount !== 1 ||
    (expected.approvalId !== undefined && payload.approvalId !== expected.approvalId) ||
    payload.fixedOutputPath !== FIXED_OUTPUT_REL || payload.globalConsumptionLedger !== GLOBAL_LEDGER_REL ||
    payload.endpointInventoryReadAuthorized !== true || payload.traceAuthorized !== false ||
    payload.transactionsAuthorized !== false || payload.forkAuthorized !== false ||
    payload.runnerSha256 !== expected.runnerSha256 || payload.packageManifestSha256 !== expected.packageManifestSha256 ||
    payload.packageAggregateSha256 !== expected.packageAggregateSha256 ||
    payload.proposalCommitment !== expected.proposalCommitment ||
    payload.packageSourceBinding !== expected.packageSourceBinding ||
    payload.capsCommitment !== bytes32Commitment(CAPS) ||
    canonicalJson(payload.allowedMethods) !== canonicalJson([...ALLOWED_METHODS].sort())) throw new Error("APPROVAL_BINDING_INVALID");
  if (options.consumed === true) throw new Error("APPROVAL_ALREADY_CONSUMED");
  return { approvalId: payload.approvalId, approvalCommitment: approval.approvalCommitment };
}

function validatePackageManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.artifacts) || !/^[0-9a-f]{64}$/u.test(manifest.aggregateSha256 || "")) {
    throw new Error("PACKAGE_MANIFEST_INVALID");
  }
  const calculatedAggregate = sha256(Buffer.from(manifest.artifacts
    .map((row) => `${row.path}:${row.sha256}`).sort().join("\n"), "utf8"));
  if (calculatedAggregate !== manifest.aggregateSha256) throw new Error("PACKAGE_MANIFEST_AGGREGATE_MISMATCH");
  for (const relativePath of BOUND_FILES) {
    const workspacePath = `targets/stakewise-v3-core-v5.0.1/${relativePath}`;
    const row = manifest.artifacts.find((candidate) => candidate.path === workspacePath);
    const bytes = fs.readFileSync(path.join(TARGET, ...relativePath.split("/")));
    if (!row || row.bytes !== bytes.length || row.sha256 !== sha256(bytes)) throw new Error("BOUND_SOURCE_MISMATCH");
  }
  return true;
}

function validateApproval(args) {
  if (!args.capture || !args.approvalFile) throw new Error("CAPTURE_ARGUMENTS_REQUIRED");
  const approvalPath = path.resolve(ROOT, args.approvalFile);
  if (approvalPath !== path.join(ROOT, ...FIXED_APPROVAL_REL.split("/"))) throw new Error("APPROVAL_PATH_FORBIDDEN");
  const approval = JSON.parse(fs.readFileSync(approvalPath, "utf8"));
  const manifestBytes = fs.readFileSync(MANIFEST_PATH);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const proposal = JSON.parse(fs.readFileSync(PROPOSAL_PATH, "utf8"));
  validatePackageManifest(manifest);
  const local = loadLocalMap();
  if (proposal.state !== "REVIEW_REQUESTED" || proposal.authorization !== "NOT_AUTHORIZED" ||
    !proposal.proposalPayload || proposal.proposalPayload.packageSourceBinding !== local.packageSourceBinding ||
    proposal.proposalCommitment !== bytes32Commitment(proposal.proposalPayload)) {
    throw new Error("PROPOSAL_STATE_OR_SOURCE_BINDING_INVALID");
  }
  const validated = validateApprovalEnvelope(approval, {
    expected: {
      runnerSha256: `0x${sha256(fs.readFileSync(__filename))}`,
      packageManifestSha256: `0x${sha256(manifestBytes)}`,
      packageAggregateSha256: `0x${manifest.aggregateSha256}`,
      proposalCommitment: proposal.proposalCommitment,
      packageSourceBinding: local.packageSourceBinding,
      approvalId: proposal.proposalPayload.requestedApprovalId
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

async function qualifyEndpoints(endpoints, context) {
  const observations = [];
  const familySeen = new Set();
  for (const endpoint of endpoints) {
    if (familySeen.has(endpoint.family)) continue;
    const chain = await rpcRequest(endpoint, "eth_chainId", [], context);
    if (!chain.ok || strictQuantity(chain.result) !== 1n) continue;
    const finalized = await rpcRequest(endpoint, "eth_getBlockByNumber", ["finalized", false], context);
    const header = finalized.ok ? parseBlockHeader(finalized.result) : null;
    if (!header) continue;
    observations.push({ family: endpoint.family, endpoint, chainId: 1, header });
    familySeen.add(endpoint.family);
  }
  const selected = selectPin(observations);
  return { observations, selected };
}

function parseRegistryDiscovery(logs) {
  const factoriesAdded = new Set();
  const factoriesRemoved = new Set();
  const vaults = new Set();
  const implementations = new Set();
  const implementationsRemoved = new Set();
  let malformed = 0;
  for (const log of logs) {
    try {
      const parsed = registryEvents.parseLog({ topics: log.topics, data: log.data });
      if (!parsed) continue;
      if (parsed.name === "FactoryAdded") factoriesAdded.add(safeAddress(parsed.args.factory));
      if (parsed.name === "FactoryRemoved") factoriesRemoved.add(safeAddress(parsed.args.factory));
      if (parsed.name === "VaultAdded") vaults.add(safeAddress(parsed.args.vault));
      if (parsed.name === "VaultImplAdded") implementations.add(safeAddress(parsed.args.impl));
      if (parsed.name === "VaultImplRemoved") implementationsRemoved.add(safeAddress(parsed.args.impl));
    } catch (_) {
      malformed += 1;
    }
  }
  return {
    factories: new Set([...factoriesAdded, ...factoriesRemoved].filter(Boolean)),
    factoriesAdded: new Set([...factoriesAdded].filter(Boolean)),
    factoriesRemoved: new Set([...factoriesRemoved].filter(Boolean)),
    vaults: new Set([...vaults].filter(Boolean)),
    implementations: new Set([...implementations, ...implementationsRemoved].filter(Boolean)),
    implementationsRemoved: new Set([...implementationsRemoved].filter(Boolean)),
    malformed
  };
}

function parseFactoryVaults(logs) {
  const vaults = new Set();
  const lineage = new Map();
  let malformed = 0;
  let vaultCreatedCount = 0;
  let metaVaultCreatedCount = 0;
  for (const log of logs) {
    try {
      const parsed = factoryEvents.parseLog({ topics: log.topics, data: log.data });
      if (!parsed || !["VaultCreated", "MetaVaultCreated"].includes(parsed.name)) continue;
      const vault = safeAddress(parsed.args.vault);
      if (!vault) {
        malformed += 1;
        continue;
      }
      vaults.add(vault);
      lineage.set(vault, log.address);
      if (parsed.name === "VaultCreated") vaultCreatedCount += 1;
      if (parsed.name === "MetaVaultCreated") metaVaultCreatedCount += 1;
    } catch (_) {
      malformed += 1;
    }
  }
  return { vaults, lineage, malformed, vaultCreatedCount, metaVaultCreatedCount };
}

async function collectBlockTimestamps(endpoint, logs, pin, context) {
  const numbers = [...new Set(logs.map((log) => log.blockNumber.toString()))];
  if (numbers.length > CAPS.maxUniqueEventBlocks) return { complete: false, timestamps: new Map(), capExceeded: true };
  const timestamps = new Map();
  const hashesByNumber = new Map();
  for (const log of logs) {
    const number = log.blockNumber.toString();
    if (!hashesByNumber.has(number)) hashesByNumber.set(number, new Set());
    hashesByNumber.get(number).add(log.blockHash);
  }
  let complete = true;
  for (const number of numbers) {
    context.budget.consumeTimestamp();
    const response = await rpcRequest(endpoint, "eth_getBlockByNumber", [toQuantity(number), false], context);
    const header = response.ok ? parseBlockHeader(response.result) : null;
    if (!header || header.number > pin) {
      complete = false;
      continue;
    }
    if (!hashesByNumber.get(number) || hashesByNumber.get(number).size !== 1 || !hashesByNumber.get(number).has(header.hash)) {
      complete = false;
      continue;
    }
    timestamps.set(number, header.timestamp);
  }
  return { complete, timestamps, capExceeded: false };
}

function parseVaultHistory(logs, timestamps) {
  const byVault = new Map();
  let malformed = 0;
  for (const log of logs) {
    let parsed;
    try {
      parsed = vaultEvents.parseLog({ topics: log.topics, data: log.data });
    } catch (_) {
      malformed += 1;
      continue;
    }
    if (!parsed) continue;
    if (!byVault.has(log.address)) byVault.set(log.address, []);
    const common = {
      blockNumber: log.blockNumber,
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash
    };
    if (parsed.name === "ExitQueueEntered") {
      byVault.get(log.address).push({
        ...common,
        type: "enter",
        receiver: safeAddress(parsed.args.receiver),
        ticket: BigInt(parsed.args.positionTicket),
        shares: BigInt(parsed.args.shares),
        timestamp: timestamps.get(log.blockNumber.toString()) ?? null
      });
    } else if (parsed.name === "V2ExitQueueEntered") {
      byVault.get(log.address).push({
        ...common,
        type: "enterV2",
        receiver: safeAddress(parsed.args.receiver),
        ticket: BigInt(parsed.args.positionTicket),
        shares: BigInt(parsed.args.shares),
        assets: BigInt(parsed.args.assets),
        timestamp: timestamps.get(log.blockNumber.toString()) ?? null
      });
    } else if (parsed.name === "CheckpointCreated") {
      byVault.get(log.address).push({
        ...common,
        type: "checkpoint",
        shares: BigInt(parsed.args.shares),
        assets: BigInt(parsed.args.assets)
      });
    } else if (parsed.name === "ExitedAssetsClaimed") {
      byVault.get(log.address).push({
        ...common,
        type: "claim",
        receiver: safeAddress(parsed.args.receiver),
        prevTicket: BigInt(parsed.args.prevPositionTicket),
        newTicket: BigInt(parsed.args.newPositionTicket),
        withdrawnAssets: BigInt(parsed.args.withdrawnAssets)
      });
    } else if (parsed.name === "Upgraded") {
      byVault.get(log.address).push({
        ...common,
        type: "upgraded",
        implementation: safeAddress(parsed.args.implementation)
      });
    }
  }
  return { byVault, malformed };
}

function failClosedCapture(reasonCode, budget) {
  return sanitizeCapture({
    schemaVersion: 2,
    findingId: FINDING_ID,
    status: "INCOMPLETE_ALL_PROMOTION_GATES_NULL",
    reasonCode,
    promotionGates: {
      exactAffectedRuntime: null,
      vulnerableShapedSemantics: null,
      currentQueuedExposure: null,
      historicallyProvenTrigger: null,
      currentlyLockedValue: null,
      callerProfit: null
    },
    operationalGates: {
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      fork: false
    },
    budget,
    liveCaptureExecuted: true,
    resultPromoted: false
  });
}

function safeReasonCode(error) {
  const value = String(error && (error.message || error));
  return /^[A-Z0-9_]{3,96}$/u.test(value) ? value : "UNCLASSIFIED_CAPTURE_FAILURE";
}

async function runCapture(args) {
  const authorization = validateApproval(args);
  consumeApprovalAtomically(authorization);

  const context = { budget: new Budget(), caps: CAPS, nextId: 0 };
  const local = loadLocalMap();
  try {
    const endpoints = loadInventoryAuthorized();
    const qualified = await qualifyEndpoints(endpoints, context);
    if (!qualified.selected.promotable) throw new Error("TWO_FAMILY_PIN_THRESHOLD_NOT_MET");
    const pin = qualified.selected.header.number;
    const primary = qualified.observations.find((row) => row.family === qualified.selected.families[0]).endpoint;
    const secondary = qualified.observations.find((row) => row.family === qualified.selected.families[1]).endpoint;

    const registryDiscoveryRaw = await getLogsChunked(primary, 0n, pin, {
      address: local.registry,
      topics: [[TOPICS.factoryAdded, TOPICS.factoryRemoved, TOPICS.vaultAdded, TOPICS.vaultImplAdded, TOPICS.vaultImplRemoved]]
    }, context);
    const registryDiscoverySecondary = await getLogsChunked(secondary, 0n, pin, {
      address: local.registry,
      topics: [[TOPICS.factoryAdded, TOPICS.factoryRemoved, TOPICS.vaultAdded, TOPICS.vaultImplAdded, TOPICS.vaultImplRemoved]]
    }, context);
    const registryLogsAgree = registryDiscoveryRaw.complete && registryDiscoverySecondary.complete &&
      logsCommitment(registryDiscoveryRaw.logs) === logsCommitment(registryDiscoverySecondary.logs);
    const registryDiscovery = parseRegistryDiscovery(registryDiscoveryRaw.logs);
    const registryDiscoveryOther = parseRegistryDiscovery(registryDiscoverySecondary.logs);
    const registryBlocksPrimary = await collectBlockTimestamps(primary, registryDiscoveryRaw.logs, pin, context);
    const registryBlocksSecondary = await collectBlockTimestamps(secondary, registryDiscoverySecondary.logs, pin, context);
    if (!registryLogsAgree || !registryBlocksPrimary.complete || !registryBlocksSecondary.complete ||
      registryDiscovery.malformed !== 0 || registryDiscoveryOther.malformed !== 0) throw new Error("REGISTRY_HISTORY_INCOMPLETE");
    const factories = new Set([...local.factories, ...registryDiscovery.factories]);
    if (factories.size > CAPS.maxFactories) throw new Error("FACTORY_CAP_EXHAUSTED");
    let implementationMembershipFamiliesAgree = true;
    let activeImplementationCount = 0;
    for (const implementation of registryDiscovery.implementations) {
      const member = await registryBool(primary, local.registry, "vaultImpls", implementation, pin, context);
      const secondaryMember = await registryBool(secondary, local.registry, "vaultImpls", implementation, pin, context);
      const membership = compareCandidateMembership(member, secondaryMember);
      if (!membership.complete) implementationMembershipFamiliesAgree = false;
      if (membership.active === true) activeImplementationCount += 1;
    }
    if (!implementationMembershipFamiliesAgree) throw new Error("ASYMMETRIC_IMPLEMENTATION_MEMBERSHIP");

    const confirmedFactories = [];
    const factoryImpls = new Map();
    let factoryCurrentFamiliesAgree = true;
    for (const factory of factories) {
      const member = await registryBool(primary, local.registry, "factories", factory, pin, context);
      const secondaryMember = await registryBool(secondary, local.registry, "factories", factory, pin, context);
      const membership = compareCandidateMembership(member, secondaryMember);
      if (!membership.complete) factoryCurrentFamiliesAgree = false;
      if (membership.active === true) confirmedFactories.push(factory);
      const decoded = member === true ? await callDecoded(primary, factory, "implementation", [], pin, context) : null;
      const implementation = decoded ? safeAddress(decoded[0]) : null;
      if (implementation) {
        const implMember = await registryBool(primary, local.registry, "vaultImpls", implementation, pin, context);
        factoryImpls.set(factory, { implementation, registryMember: implMember });
      } else {
        factoryImpls.set(factory, { implementation: null, registryMember: null });
      }
    }
    for (const factory of confirmedFactories) {
      const secondaryMember = await registryBool(secondary, local.registry, "factories", factory, pin, context);
      const secondaryDecoded = await callDecoded(secondary, factory, "implementation", [], pin, context);
      const secondaryImplementation = secondaryDecoded ? safeAddress(secondaryDecoded[0]) : null;
      const primaryRow = factoryImpls.get(factory);
      const secondaryImplMember = secondaryImplementation
        ? await registryBool(secondary, local.registry, "vaultImpls", secondaryImplementation, pin, context)
        : null;
      if (secondaryMember !== true || !primaryRow || secondaryImplementation !== primaryRow.implementation ||
        secondaryImplMember !== primaryRow.registryMember) factoryCurrentFamiliesAgree = false;
    }
    if (!factoryCurrentFamiliesAgree) throw new Error("ASYMMETRIC_FACTORY_MEMBERSHIP");

    const historicalFactories = [...factories];
    const factoryLogRaw = historicalFactories.length === 0
      ? { logs: [], complete: true }
      : await getLogsChunked(primary, 0n, pin, {
        address: historicalFactories,
        topics: [[TOPICS.vaultCreated, TOPICS.metaVaultCreated]]
      }, context);
    const factoryLogSecondary = historicalFactories.length === 0
      ? { logs: [], complete: true }
      : await getLogsChunked(secondary, 0n, pin, {
        address: historicalFactories,
        topics: [[TOPICS.vaultCreated, TOPICS.metaVaultCreated]]
      }, context);
    const factoryLogsAgree = factoryLogRaw.complete && factoryLogSecondary.complete &&
      logsCommitment(factoryLogRaw.logs) === logsCommitment(factoryLogSecondary.logs);
    const factoryVaults = parseFactoryVaults(factoryLogRaw.logs);
    const factoryVaultsOther = parseFactoryVaults(factoryLogSecondary.logs);
    const factoryBlocksPrimary = await collectBlockTimestamps(primary, factoryLogRaw.logs, pin, context);
    const factoryBlocksSecondary = await collectBlockTimestamps(secondary, factoryLogSecondary.logs, pin, context);
    if (!factoryLogsAgree || !factoryBlocksPrimary.complete || !factoryBlocksSecondary.complete ||
      factoryVaults.malformed !== 0 || factoryVaultsOther.malformed !== 0) throw new Error("FACTORY_HISTORY_INCOMPLETE");
    const vaults = new Set([...local.directVaults, ...registryDiscovery.vaults, ...factoryVaults.vaults]);
    if (vaults.size > CAPS.maxVaults) throw new Error("VAULT_CAP_EXHAUSTED");

    const confirmedVaults = [];
    for (const vault of vaults) {
      const member = await registryBool(primary, local.registry, "vaults", vault, pin, context);
      const secondaryMember = await registryBool(secondary, local.registry, "vaults", vault, pin, context);
      const membership = compareCandidateMembership(member, secondaryMember);
      if (!membership.complete) throw new Error("ASYMMETRIC_VAULT_MEMBERSHIP");
      if (membership.active === true) confirmedVaults.push(vault);
    }

    const runtimeRows = new Map();
    const stateRows = new Map();
    const nativeVaults = [];
    for (const vault of confirmedVaults) {
      const observed = await readVaultObservation(primary, local.registry, vault, pin, context);
      const lineageFactory = factoryVaults.lineage.get(vault) || null;
      const lineageImplementation = lineageFactory && factoryImpls.get(lineageFactory)
        ? factoryImpls.get(lineageFactory).implementation
        : null;
      observed.runtime.factoryLineagePresent = Boolean(lineageFactory);
      observed.runtime.factoryLineageComplete = Boolean(lineageFactory && factoryImpls.has(lineageFactory));
      observed.runtime.factoryImplementationMatchesCurrent = lineageImplementation
        ? lineageImplementation === observed.runtime._implementation
        : null;
      runtimeRows.set(vault, observed.runtime);
      if (!observed.runtime.nativeName) continue;
      nativeVaults.push(vault);
      observed.state.type = factoryVaults.lineage.has(vault) ? "FACTORY_LINEAGE_PRESENT_TYPE_UNPROVEN" : null;
      stateRows.set(vault, observed.state);
    }

    let runtimeStateFamiliesAgree = true;
    for (const vault of nativeVaults) {
      const secondaryObserved = await readVaultObservation(secondary, local.registry, vault, pin, context);
      if (observationCommitment(runtimeRows.get(vault), stateRows.get(vault)) !==
        observationCommitment(secondaryObserved.runtime, secondaryObserved.state)) {
        runtimeStateFamiliesAgree = false;
      }
      const runtime = runtimeRows.get(vault);
      if (runtime) runtime.dualFamilyAgreement = runtimeStateFamiliesAgree;
    }
    if (!runtimeStateFamiliesAgree) throw new Error("RUNTIME_STATE_FAMILY_MISMATCH");

    const allVaultLogs = [];
    let vaultHistoryComplete = registryDiscoveryRaw.complete && factoryLogRaw.complete;
    for (let offset = 0; offset < nativeVaults.length; offset += CAPS.maxAddressBatch) {
      const addresses = nativeVaults.slice(offset, offset + CAPS.maxAddressBatch);
      const batch = await getLogsChunked(primary, 0n, pin, {
        address: addresses,
        topics: [[TOPICS.exitEntered, TOPICS.v2ExitEntered, TOPICS.checkpoint, TOPICS.claimed, TOPICS.upgraded]]
      }, context);
      allVaultLogs.push(...batch.logs);
      if (!batch.complete) vaultHistoryComplete = false;
    }
    const secondaryVaultLogs = [];
    let secondaryHistoryComplete = true;
    for (let offset = 0; offset < nativeVaults.length; offset += CAPS.maxAddressBatch) {
      const addresses = nativeVaults.slice(offset, offset + CAPS.maxAddressBatch);
      const batch = await getLogsChunked(secondary, 0n, pin, {
        address: addresses,
        topics: [[TOPICS.exitEntered, TOPICS.v2ExitEntered, TOPICS.checkpoint, TOPICS.claimed, TOPICS.upgraded]]
      }, context);
      secondaryVaultLogs.push(...batch.logs);
      if (!batch.complete) secondaryHistoryComplete = false;
    }
    const vaultLogsAgree = vaultHistoryComplete && secondaryHistoryComplete &&
      logsCommitment(allVaultLogs) === logsCommitment(secondaryVaultLogs);
    if (!registryLogsAgree || !factoryLogsAgree || !vaultLogsAgree || !runtimeStateFamiliesAgree) {
      vaultHistoryComplete = false;
    }
    const blockData = await collectBlockTimestamps(primary, allVaultLogs, pin, context);
    const secondaryBlockData = await collectBlockTimestamps(secondary, secondaryVaultLogs, pin, context);
    if (!blockData.complete || !secondaryBlockData.complete) vaultHistoryComplete = false;
    const parsedHistory = parseVaultHistory(allVaultLogs, blockData.timestamps);
    if (parsedHistory.malformed !== 0 || !vaultHistoryComplete) throw new Error("VAULT_HISTORY_INCOMPLETE_OR_MALFORMED");

    let provenCount = 0;
    let nullCandidateCount = 0;
    let ambiguousHistoryCount = parsedHistory.malformed;
    let migrationCandidateCount = 0;
    let invalidPrefixCount = 0;
    for (const [vault, events] of parsedHistory.byVault) {
      const replayable = events.filter((event) => event.type !== "upgraded");
      const replay = replayHistory(replayable, { completeHistory: vaultHistoryComplete });
      ambiguousHistoryCount += replay.ambiguousCount + replay.malformedCount;
      provenCount += replay.provenCandidateCount;
      nullCandidateCount += replay.nullCandidateCount;
      migrationCandidateCount += replay.migrationCandidateCount;
      if (!replay.prefixValid) invalidPrefixCount += 1;
      const upgrades = events.filter((event) => event.type === "upgraded");
      const latestUpgrade = upgrades.length ? upgrades[upgrades.length - 1].implementation : null;
      const runtime = runtimeRows.get(vault);
      if (runtime) runtime.latestUpgradeEventObserved = latestUpgrade !== null;
    }
    if (ambiguousHistoryCount !== 0 || invalidPrefixCount !== 0) throw new Error("AMBIGUOUS_REPLAY_PREFIX");

    let terminalMatch = true;
    for (const family of qualified.selected.families) {
      const observation = qualified.observations.find((row) => row.family === family);
      const terminal = await rpcRequest(observation.endpoint, "eth_getBlockByNumber", [toQuantity(pin), false], context);
      const header = terminal.ok ? parseBlockHeader(terminal.result) : null;
      if (!header || header.number !== qualified.selected.header.number || header.hash !== qualified.selected.header.hash) terminalMatch = false;
    }
    if (!terminalMatch) throw new Error("TERMINAL_PIN_MISMATCH");

    const runtimeValues = [...runtimeRows.values()];
    const nativeRuntimeValues = nativeVaults.map((vault) => runtimeRows.get(vault)).filter(Boolean);
    const stateValues = [...stateRows.values()];
    const exactAffectedCount = nativeRuntimeValues.filter((row) => row.exactAffectedRuntime === true).length;
    const v5Count = nativeRuntimeValues.filter((row) => row.version === 5).length;
    const newerCount = nativeRuntimeValues.filter((row) => row.version !== null && row.version > 5).length;
    const queuedPositive = stateValues.filter((row) => row.queueData && row.queueData.queuedShares > 0n).length;
    const unclaimedPositive = stateValues.filter((row) => row.queueData && row.queueData.unclaimedAssets > 0n).length;
    const crossFamilyAgreement = registryLogsAgree && factoryLogsAgree && factoryCurrentFamiliesAgree &&
      vaultLogsAgree && runtimeStateFamiliesAgree;
    if (!crossFamilyAgreement) throw new Error("CROSS_FAMILY_MISMATCH");
    if (!context.budget.summary().allWithinCaps) throw new Error("BUDGET_NOT_COMPLETE");

    const output = sanitizeCapture({
      schemaVersion: 2,
      findingId: FINDING_ID,
      status: "CAPTURE_COMPLETE_PROMOTION_GATES_FAIL_CLOSED",
      chain: { chainId: 1, ethereumOnly: true },
      pin: {
        number: pin.toString(),
        hash: qualified.selected.header.hash,
        familyCount: 2,
        families: qualified.selected.families.slice(0, 2),
        qualifyingFinalizedFamilyCount: qualified.selected.families.length,
        terminalSameNumberHashMatch: terminalMatch,
        crossFamilyLogsCodeStateAgreement: crossFamilyAgreement,
        familyBackendIndependenceProven: false
      },
      localMap: local.sanitized,
      discovery: {
        registryHistoryComplete: registryDiscoveryRaw.complete,
        registryLogsFamiliesAgree: registryLogsAgree,
        factoryHistoryComplete: factoryLogRaw.complete,
        factoryLogsFamiliesAgree: factoryLogsAgree,
        factoryCurrentStateFamiliesAgree: factoryCurrentFamiliesAgree,
        implementationMembershipFamiliesAgree,
        implementationsHistoricallyDiscovered: registryDiscovery.implementations.size,
        implementationsHistoricallyRemoved: registryDiscovery.implementationsRemoved.size,
        implementationsRegistryConfirmed: activeImplementationCount,
        factoriesDiscovered: factories.size,
        factoriesHistoricallyRemoved: registryDiscovery.factoriesRemoved.size,
        factoriesRegistryConfirmed: confirmedFactories.length,
        vaultsDiscovered: vaults.size,
        vaultsRegistryConfirmed: confirmedVaults.length,
        nativeVaultsByVaultId: nativeVaults.length,
        vaultCreatedEvents: factoryVaults.vaultCreatedCount,
        metaVaultCreatedEvents: factoryVaults.metaVaultCreatedCount,
        malformedDiscoveryLogs: registryDiscovery.malformed + factoryVaults.malformed
      },
      runtime: {
        version5Count: v5Count,
        newerVersionCount: newerCount,
        exactAffectedRuntimeCount: exactAffectedCount,
        exactRuntimeNullCount: nativeRuntimeValues.filter((row) => row.exactRuntime === null).length,
        implementationViewReturnedAddressCount: nativeRuntimeValues.filter((row) => row.implementationViewReturnedAddress).length,
        implementationViewMatchedSlotCount: nativeRuntimeValues.filter((row) => row.implementationViewMatchedSlot === true).length,
        implementationRegistryConfirmedCount: nativeRuntimeValues.filter((row) => row.implementationRegistryMember === true).length,
        factoryImplementationCurrentMatchCount: nativeRuntimeValues.filter((row) => row.factoryImplementationMatchesCurrent === true).length,
        vulnerableShapedClassifierUsed: false,
        vulnerableShapedSemantics: null,
        runtimeStateFamiliesAgree,
        v6V7V5EquivalenceClaimed: false
      },
      currentState: {
        rowsAttempted: nativeVaults.length,
        rowsWithQueueData: stateValues.filter((row) => row.queueData).length,
        queuedSharesPositiveVaults: queuedPositive,
        unclaimedAssetsPositiveVaults: unclaimedPositive,
        rawBalanceExactlyDerivedVaults: stateValues.filter((row) => row.raw.exact).length,
        unknownCollateralizationRows: stateValues.filter((row) => row.collateralized === null).length,
        unknownPrivateBlocklistRows: stateValues.filter((row) => row.privateOrBlocklist === null).length,
        unclaimedPositiveProvesOrphan: false,
        aggregateShapeCommitment: bytes32Commitment({
          rows: stateValues.length,
          queuedPositive,
          unclaimedPositive,
          queueRows: stateValues.filter((row) => row.queueData).length
        })
      },
      history: {
        complete: vaultHistoryComplete,
        vaultLogsFamiliesAgree: vaultLogsAgree,
        uniqueEventBlocks: blockData.timestamps.size,
        mathematicallyProvenLeftOneTransitions: provenCount,
        affectedRuntimeBoundTransitions: 0,
        migrationShapeCandidates: migrationCandidateCount,
        nullCandidates: nullCandidateCount,
        ambiguousRows: ambiguousHistoryCount,
        invalidReplayPrefixes: invalidPrefixCount,
        aggregateEventShapeCommitment: bytes32Commitment({
          eventCount: allVaultLogs.length,
          provenCount,
          nullCandidateCount,
          migrationCandidateCount
        }),
        currentInternalMappingProven: false,
        currentLockedValue: null,
        traceFollowUp: "PROPOSAL_ONLY_FORBIDDEN_IN_FIRST_CAPTURE"
      },
      gates: {
        exactAffectedRuntime: exactAffectedCount > 0
          ? true
          : nativeRuntimeValues.length === 0 || nativeRuntimeValues.some((row) => row.exactAffectedRuntime === null)
            ? null
            : false,
        vulnerableShapedSemantics: null,
        currentQueuedExposure: exactAffectedCount > 0 ? queuedPositive > 0 : null,
        historicallyProvenTrigger: null,
        currentlyLockedValue: null,
        callerProfit: 0,
        routePositive: 0,
        executableNow: 0,
        signedActionJustified: false,
        fork: false
      },
      budgets: context.budget.summary(),
      capCompletion: { allCapsPresent: true, allWithinCaps: context.budget.summary().allWithinCaps, configured: CAPS },
      persistence: {
        rawResponses: false,
        calldata: false,
        callerIdentities: false,
        endpointIdentities: false,
        providerIdentityHashes: false,
        runtimeHashesPersisted: false
      }
    });
    fs.writeFileSync(authorization.outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
    return output;
  } catch (error) {
    const output = failClosedCapture(safeReasonCode(error), context.budget.summary());
    fs.writeFileSync(authorization.outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
    return output;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.capture) {
    process.stdout.write(`${JSON.stringify(dryPreflight(), null, 2)}\n`);
    return;
  }
  const result = await runCapture(args);
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    findingId: result.findingId,
    outputWritten: true,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    fork: false
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "FAILED_CLOSED", reasonCode: String(error.message || error) })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ALLOWED_METHODS,
  FORBIDDEN_METHODS,
  CAPS,
  BOUND_FILES,
  FIXED_OUTPUT_REL,
  FIXED_APPROVAL_REL,
  GLOBAL_LEDGER_REL,
  TOPICS,
  Budget,
  calculateExitedAssets,
  canonicalLogsMatchHeaders,
  canonicalJson,
  bytes32Commitment,
  classifyRuntime,
  compareCandidateMembership,
  commitment,
  deriveRawBalance,
  dedupeLogs,
  dryPreflight,
  firstCheckpointIndex,
  failClosedCapture,
  parseArgs,
  parseBlockHeader,
  parseRpcEnvelope,
  parseFactoryVaults,
  parseRegistryDiscovery,
  replayHistory,
  rpcRequest,
  safeAddress,
  sanitizeCapture,
  selectPin,
  strictHex,
  strictQuantity,
  validateApprovalEnvelope,
  validatePackageManifest,
  validateScanRange,
  validateLog
};
