#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  AbiCoder,
  Interface,
  getAddress,
  id,
  zeroPadValue
} = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "symbiotic-core-83a3a9ab");
const INVENTORY_PATH = path.join(ROOT, "rpc_endpoints.txt");
const FINDING_ID = "symbiotic-vaultv2-donation-step2";
const CHAIN_ID = 1;
const SOURCE_COMMIT = "83a3a9ab8febe868896780a68345dbf820d843ff";
const RAW_PREFIX = "reports/raw/fast/critical-symbiotic-vaultv2-donation-step2";
const FIXED_OUTPUT_REL = `${RAW_PREFIX}/capture.json`;
const FIXED_APPROVAL_REL = "coordination/decisions/symbiotic-vaultv2-donation-step2-approval.json";
const GLOBAL_LEDGER_REL = "coordination/decisions/symbiotic-vaultv2-donation-step2-consumption-ledger.json";
const PROPOSAL_REL = `${RAW_PREFIX}/proposal.json`;
const MANIFEST_REL = `${RAW_PREFIX}/manifest.json`;
const PROPOSAL_ID = "symv2-step2-complete-allnull-r4-63a9d20f74be481c";
const REQUESTED_APPROVAL_ID = "symv2-step2-approval-r4-e18c57a32bd6490f";
const DOCS_URL = "https://docs.symbiotic.fi/get-started/resources/addresses";
const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const CANONICAL = Object.freeze({
  VaultFactory: "0xaeb6bdd95c502390db8f52c8909f703e9af6a346",
  WithdrawalQueueFactory: "0x6f80fd397120164e44d23b9334910c8de41ce4ce",
  ProtocolFeeRegistry: "0x9983edcd02f57b8b94bd8de9d18e614dfb964d6d",
  UniversalDelegatorFactory: "0xb5eff01403c0dd3ada1010919791d6eb82f6a84c"
});

const ALLOWED_METHODS = new Set([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_call",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getLogs"
]);
const FORBIDDEN_METHODS = new Set([
  "eth_sendTransaction",
  "eth_sendRawTransaction",
  "eth_estimateGas",
  "eth_createAccessList",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "debug_traceCall",
  "trace_call",
  "trace_replayTransaction",
  "eth_simulateV1"
]);

const CAPS = Object.freeze({
  chains: 1,
  minDistinctFamilies: 2,
  maxInventoryBytes: 1048576,
  maxInventoryEntries: 96,
  maxFamilies: 16,
  maxEntities: 5000,
  maxVersions: 64,
  maxUniqueHeaders: 50000,
  maxLogs: 300000,
  maxChunks: 10000,
  maxScanSpanBlocks: 40000000,
  maxLogChunkBlocks: 50000,
  maxResponseBytes: 2097152,
  maxAggregateResponseBytes: 536870912,
  maxTotalRequests: 150000,
  maxCallRequests: 50000,
  maxCodeRequests: 20000,
  maxStorageRequests: 20000,
  maxLogRequests: 30000,
  maxBlockRequests: 15000,
  maxRetries: 500,
  retriesPerRequest: 1,
  requestTimeoutMs: 12000,
  maxElapsedMs: 1800000,
  maxTimestampFetches: 10000,
  maxApprovalWindowMs: 900000,
  maxApprovalIssuedAgeMs: 300000,
  maxApprovalFutureSkewMs: 30000
});

const BOUND_FILES = Object.freeze([
  "foundry.toml",
  "src/contracts/VaultFactory.sol",
  "src/contracts/WithdrawalQueueFactory.sol",
  "src/contracts/UniversalDelegatorFactory.sol",
  "src/contracts/ProtocolFeeRegistry.sol",
  "src/contracts/common/MigratablesFactory.sol",
  "src/contracts/common/MigratableEntityProxy.sol",
  "src/contracts/common/MigratableEntity.sol",
  "src/contracts/common/Registry.sol",
  "src/contracts/vault/VaultV2.sol",
  "src/contracts/vault/WithdrawalQueue.sol",
  "src/interfaces/common/IRegistry.sol",
  "src/interfaces/common/IMigratablesFactory.sol",
  "src/interfaces/common/IMigratableEntity.sol",
  "src/interfaces/vault/IVaultV2.sol",
  "src/interfaces/vault/IWithdrawalQueue.sol",
  "out/VaultV2.sol/VaultV2.json",
  "out/MigratableEntity.sol/MigratableEntity.json",
  "out/MigratableEntityProxy.sol/MigratableEntityProxy.json",
  "out/VaultFactory.sol/VaultFactory.json",
  "out/WithdrawalQueueFactory.sol/WithdrawalQueueFactory.json",
  "out/UniversalDelegatorFactory.sol/UniversalDelegatorFactory.json",
  "out/ProtocolFeeRegistry.sol/ProtocolFeeRegistry.json"
]);

const factoryInterface = new Interface([
  "function totalEntities() view returns (uint256)",
  "function entity(uint256) view returns (address)",
  "function isEntity(address) view returns (bool)",
  "function lastVersion() view returns (uint64)",
  "function implementation(uint64) view returns (address)",
  "function blacklisted(uint64) view returns (bool)",
  "event AddEntity(address indexed entity)",
  "event Whitelist(address indexed implementation)",
  "event Blacklist(uint64 indexed version)",
  "event Migrate(address indexed entity,uint64 newVersion)"
]);
const vaultInterface = new Interface([
  "function FACTORY() view returns (address)",
  "function version() view returns (uint64)",
  "function owner() view returns (address)",
  "function asset() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function freeAssets() view returns (uint256)",
  "function withdrawable() returns (uint256)",
  "function redeemable() returns (uint256)",
  "function withdrawalQueue() view returns (address)",
  "function delegator() view returns (address)",
  "function getAccrueInterest() view returns (uint256,uint256,uint256,uint256)",
  "function depositWhitelist() view returns (bool)",
  "function isDepositLimit() view returns (bool)",
  "function depositLimit() view returns (uint256)",
  "function managementFee() view returns (uint96)",
  "function performanceFee() view returns (uint96)",
  "function lastProtocolManagementFee() view returns (uint96)",
  "function lastProtocolPerformanceFee() view returns (uint96)",
  "event Initialize((string name,string symbol,address asset,bool depositWhitelist,address depositorToWhitelist,uint256 depositLimit,bool isDepositLimit,address defaultAdminRoleHolder,address managementFeeRoleHolder,address performanceFeeRoleHolder,address depositLimitSetRoleHolder,address depositorWhitelistRoleHolder,address isDepositLimitSetRoleHolder,address depositWhitelistSetRoleHolder,bytes delegatorParams) params)",
  "event Initialized(uint64 version)",
  "event Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares)",
  "event Transfer(address indexed from,address indexed to,uint256 value)"
]);
const queueInterface = new Interface([
  "function FACTORY() view returns (address)",
  "function vault() view returns (address)",
  "event RequestRedeem(address indexed requester,address indexed receiver,uint256 shares,uint256 indexed tokenId)",
  "event Fill(uint256 assets,uint256 shares)",
  "event Claim(uint256 indexed tokenId,address indexed receiver,uint256 assetsClaimed,uint256 sharesClaimed)"
]);
const erc20Interface = new Interface([
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from,address indexed to,uint256 value)"
]);
const abi = AbiCoder.defaultAbiCoder();

const TOPICS = Object.freeze({
  addEntity: id("AddEntity(address)"),
  whitelist: id("Whitelist(address)"),
  blacklist: id("Blacklist(uint64)"),
  migrate: id("Migrate(address,uint64)"),
  initialized: id("Initialized(uint64)"),
  vaultInitialize: vaultInterface.getEvent("Initialize").topicHash,
  deposit: id("Deposit(address,address,uint256,uint256)"),
  transfer: id("Transfer(address,address,uint256)"),
  requestRedeem: id("RequestRedeem(address,address,uint256,uint256)"),
  fill: id("Fill(uint256,uint256)"),
  claim: id("Claim(uint256,address,uint256,uint256)")
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function commitment(value) {
  return `0x${sha256(Buffer.from(canonicalJson(value), "utf8"))}`;
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

function topicAddress(value) {
  const topic = strictHex(value, 32);
  return topic ? safeAddress(`0x${topic.slice(-40)}`) : null;
}

function parseBlockHeader(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const number = strictQuantity(value.number);
  const hash = strictHex(value.hash, 32);
  const parentHash = strictHex(value.parentHash, 32);
  const stateRoot = strictHex(value.stateRoot, 32);
  const receiptsRoot = strictHex(value.receiptsRoot, 32);
  const timestamp = strictQuantity(value.timestamp);
  if (number === null || timestamp === null || !hash || !parentHash || !stateRoot || !receiptsRoot) return null;
  return { number, hash, parentHash, stateRoot, receiptsRoot, timestamp };
}

function headerFingerprint(header) {
  return canonicalJson({
    number: header.number.toString(),
    hash: header.hash,
    parentHash: header.parentHash,
    stateRoot: header.stateRoot,
    receiptsRoot: header.receiptsRoot,
    timestamp: header.timestamp.toString()
  });
}

function selectCommonMinimumPin(finalizedReports, pinHeaders, minimumFamilies = CAPS.minDistinctFamilies) {
  if (!Array.isArray(finalizedReports) || !Array.isArray(pinHeaders)) {
    return { promotable: false, reason: "MALFORMED_PIN_INPUT", pin: null, blockHash: null, familyCount: 0 };
  }
  const families = new Set();
  const hosts = new Set();
  for (const row of finalizedReports) {
    if (!row || typeof row.family !== "string" || typeof row.hostname !== "string" || !row.header) {
      return { promotable: false, reason: "MALFORMED_FINALIZED_REPORT", pin: null, blockHash: null, familyCount: 0 };
    }
    if (families.has(row.family) || hosts.has(row.hostname.toLowerCase())) {
      return { promotable: false, reason: "FAMILY_NOT_HOSTNAME_DISTINCT", pin: null, blockHash: null, familyCount: 0 };
    }
    families.add(row.family);
    hosts.add(row.hostname.toLowerCase());
  }
  if (families.size < minimumFamilies) {
    return { promotable: false, reason: "TWO_FAMILY_THRESHOLD_NOT_MET", pin: null, blockHash: null, familyCount: families.size };
  }
  const pin = finalizedReports.reduce((minimum, row) => row.header.number < minimum ? row.header.number : minimum,
    finalizedReports[0].header.number);
  if (pinHeaders.length !== finalizedReports.length) {
    return { promotable: false, reason: "PIN_HEADER_COVERAGE_INCOMPLETE", pin: null, blockHash: null, familyCount: families.size };
  }
  let fingerprint = null;
  let blockHash = null;
  for (const row of finalizedReports) {
    if (row.header.number < pin) {
      return { promotable: false, reason: "FINALIZED_BELOW_COMMON_PIN", pin: null, blockHash: null, familyCount: families.size };
    }
    const observed = pinHeaders.find((entry) => entry.family === row.family);
    if (!observed || !observed.header || observed.header.number !== pin) {
      return { promotable: false, reason: "COMMON_PIN_NUMBER_MISMATCH", pin: null, blockHash: null, familyCount: families.size };
    }
    const current = headerFingerprint(observed.header);
    if (fingerprint !== null && current !== fingerprint) {
      return { promotable: false, reason: "COMMON_PIN_HEADER_DISAGREEMENT", pin: null, blockHash: null, familyCount: families.size };
    }
    fingerprint = current;
    blockHash = observed.header.hash;
  }
  return { promotable: true, reason: null, pin, blockHash, familyCount: families.size };
}

function terminalPinRecheck(selection, terminalHeaders) {
  if (!selection || !selection.promotable || !Array.isArray(terminalHeaders) ||
    terminalHeaders.length !== selection.familyCount) return false;
  return terminalHeaders.every((row) => row && row.header && row.header.number === selection.pin &&
    row.header.hash === selection.blockHash);
}

function parseRpcEnvelope(body, expectedId) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (_) {
    return { ok: false, error: "MALFORMED_JSON", result: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.jsonrpc !== "2.0" ||
    parsed.id !== expectedId) return { ok: false, error: "ENVELOPE_MISMATCH", result: null };
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
    this.calls = 0;
    this.codes = 0;
    this.storage = 0;
    this.logs = 0;
    this.blocks = 0;
    this.retries = 0;
    this.returnedLogs = 0;
    this.responseBytes = 0;
    this.chunks = 0;
    this.timestampFetches = 0;
    this.uniqueHeaders = new Set();
    this.exhausted = null;
  }

  stop(reason) {
    if (!this.exhausted) this.exhausted = reason;
    throw new Error(`BUDGET_EXHAUSTED_${this.exhausted}`);
  }

  checkTime() {
    if (this.now() - this.startedAt > this.caps.maxElapsedMs) this.stop("TIME");
  }

  consume(method, retry = false) {
    if (this.exhausted) throw new Error(`BUDGET_EXHAUSTED_${this.exhausted}`);
    if (!ALLOWED_METHODS.has(method) || FORBIDDEN_METHODS.has(method)) throw new Error("METHOD_FORBIDDEN");
    this.checkTime();
    this.total += 1;
    if (method === "eth_call") this.calls += 1;
    if (method === "eth_getCode") this.codes += 1;
    if (method === "eth_getStorageAt") this.storage += 1;
    if (method === "eth_getLogs") this.logs += 1;
    if (method === "eth_getBlockByNumber") {
      this.blocks += 1;
      this.consumeTimestampFetch();
    }
    if (retry) this.retries += 1;
    if (this.total > this.caps.maxTotalRequests) this.exhausted = "TOTAL_REQUESTS";
    if (this.calls > this.caps.maxCallRequests) this.exhausted = "CALL_REQUESTS";
    if (this.codes > this.caps.maxCodeRequests) this.exhausted = "CODE_REQUESTS";
    if (this.storage > this.caps.maxStorageRequests) this.exhausted = "STORAGE_REQUESTS";
    if (this.logs > this.caps.maxLogRequests) this.exhausted = "LOG_REQUESTS";
    if (this.blocks > this.caps.maxBlockRequests) this.exhausted = "BLOCK_REQUESTS";
    if (this.retries > this.caps.maxRetries) this.exhausted = "RETRIES";
    if (this.exhausted) throw new Error(`BUDGET_EXHAUSTED_${this.exhausted}`);
  }

  consumeResponseChunk(bytes, responseBytes) {
    this.checkTime();
    if (responseBytes > this.caps.maxResponseBytes) this.stop("SINGLE_RESPONSE_BYTES");
    this.responseBytes += bytes;
    if (this.responseBytes > this.caps.maxAggregateResponseBytes) this.stop("AGGREGATE_RESPONSE_BYTES");
  }

  consumeLog() {
    this.returnedLogs += 1;
    if (this.returnedLogs > this.caps.maxLogs) {
      this.exhausted = "RETURNED_LOGS";
      throw new Error(`BUDGET_EXHAUSTED_${this.exhausted}`);
    }
  }

  consumeChunk() {
    this.checkTime();
    this.chunks += 1;
    if (this.chunks > this.caps.maxChunks) {
      this.exhausted = "CHUNKS";
      throw new Error(`BUDGET_EXHAUSTED_${this.exhausted}`);
    }
  }

  consumeTimestampFetch() {
    this.timestampFetches += 1;
    if (this.timestampFetches > this.caps.maxTimestampFetches) this.stop("TIMESTAMP_FETCHES");
  }

  observeHeader(number) {
    const key = BigInt(number).toString();
    this.uniqueHeaders.add(key);
    if (this.uniqueHeaders.size > this.caps.maxUniqueHeaders) this.stop("UNIQUE_HEADERS");
  }

  summary() {
    return {
      total: this.total,
      calls: this.calls,
      codes: this.codes,
      storage: this.storage,
      logs: this.logs,
      blocks: this.blocks,
      retries: this.retries,
      returnedLogs: this.returnedLogs,
      responseBytes: this.responseBytes,
      chunks: this.chunks,
      timestampFetches: this.timestampFetches,
      uniqueHeaders: this.uniqueHeaders.size,
      exhausted: this.exhausted,
      allWithinCaps: this.exhausted === null && this.now() - this.startedAt <= this.caps.maxElapsedMs
    };
  }
}

function enforceNumericCap(value, maximum, reason, budget) {
  if (BigInt(value) > BigInt(maximum)) budget.stop(reason);
  return true;
}

async function readResponseBodyCapped(response, context, controller) {
  if (!response.body) throw new Error("BODY_STREAM_REQUIRED");
  const chunks = [];
  let responseBytes = 0;
  async function accept(value) {
    const chunk = Buffer.from(value);
    const prospective = responseBytes + chunk.length;
    try {
      context.budget.consumeResponseChunk(chunk.length, prospective);
    } catch (error) {
      controller.abort();
      throw error;
    }
    responseBytes = prospective;
    chunks.push(chunk);
  }
  if (typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    while (true) {
      context.budget.checkTime();
      const row = await reader.read();
      if (row.done) break;
      await accept(row.value);
    }
  } else if (response.body[Symbol.asyncIterator]) {
    for await (const chunk of response.body) await accept(chunk);
  } else throw new Error("BODY_STREAM_REQUIRED");
  return Buffer.concat(chunks, responseBytes);
}

async function rpcRequest(endpoint, method, params, context, fetchImpl = fetch) {
  if (!ALLOWED_METHODS.has(method) || FORBIDDEN_METHODS.has(method)) {
    return { ok: false, error: "METHOD_FORBIDDEN", result: null };
  }
  const rpcId = ++context.nextId;
  for (let attempt = 0; attempt <= context.caps.retriesPerRequest; attempt++) {
    context.budget.consume(method, attempt > 0);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), context.caps.requestTimeoutMs);
    try {
      const response = await fetchImpl(endpoint.url, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
        signal: controller.signal
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        return { ok: false, error: "REDIRECT_REJECTED", result: null };
      }
      if (response.status < 200 || response.status >= 300) {
        if (attempt < context.caps.retriesPerRequest && response.status >= 500) continue;
        return { ok: false, error: "HTTP_STATUS", result: null };
      }
      const length = response.headers && response.headers.get ? response.headers.get("content-length") : null;
      if (length && Number(length) > context.caps.maxResponseBytes) {
        controller.abort();
        context.budget.stop("SINGLE_RESPONSE_BYTES");
      }
      const body = await readResponseBodyCapped(response, context, controller);
      return parseRpcEnvelope(body.toString("utf8"), rpcId);
    } catch (error) {
      if (/^BUDGET_EXHAUSTED_/u.test(String(error.message || error))) throw error;
      if (attempt >= context.caps.retriesPerRequest) return { ok: false, error: "TRANSPORT_FAILURE", result: null };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: "TRANSPORT_FAILURE", result: null };
}

function validateLog(row, expectedAddresses, fromBlock, toBlock) {
  if (!row || typeof row !== "object" || row.removed !== false) return null;
  const address = safeAddress(row.address);
  const blockNumber = strictQuantity(row.blockNumber);
  const transactionIndex = strictQuantity(row.transactionIndex);
  const logIndex = strictQuantity(row.logIndex);
  const blockHash = strictHex(row.blockHash, 32);
  const transactionHash = strictHex(row.transactionHash, 32);
  const data = strictHex(row.data);
  if (!address || !expectedAddresses.has(address) || blockNumber === null || transactionIndex === null ||
    logIndex === null || !blockHash || !transactionHash || data === null || !Array.isArray(row.topics) ||
    row.topics.some((topic) => !strictHex(topic, 32)) || blockNumber < fromBlock || blockNumber > toBlock) return null;
  return { address, blockNumber, transactionIndex, logIndex, blockHash, transactionHash, data,
    topics: row.topics.map((topic) => topic.toLowerCase()) };
}

function sortLogs(logs) {
  return [...logs].sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 :
    a.transactionIndex < b.transactionIndex ? -1 : a.transactionIndex > b.transactionIndex ? 1 :
      a.logIndex < b.logIndex ? -1 : a.logIndex > b.logIndex ? 1 : 0);
}

function dedupeLogs(logs) {
  const map = new Map();
  let duplicates = 0;
  for (const row of sortLogs(logs)) {
    const key = `${row.blockHash}:${row.transactionHash}:${row.logIndex}`;
    const encoded = canonicalJson(row);
    if (map.has(key)) {
      if (map.get(key).encoded !== encoded) return { ok: false, logs: [], duplicateCount: duplicates };
      duplicates += 1;
    } else map.set(key, { encoded, row });
  }
  return { ok: true, logs: [...map.values()].map((entry) => entry.row), duplicateCount: duplicates };
}

function canonicalLogsMatchHeaders(logs, headers) {
  return logs.every((row) => headers.has(row.blockNumber.toString()) &&
    headers.get(row.blockNumber.toString()).hash === row.blockHash);
}

function compareAuthoritativeEntities(enumerated, addEntityLogs) {
  const a = new Set(enumerated.map(safeAddress));
  const b = new Set(addEntityLogs.map((row) => safeAddress(row.entity)));
  if (a.has(null) || b.has(null) || a.size !== enumerated.length || b.size !== addEntityLogs.length) {
    return { complete: false, reason: "MALFORMED_OR_DUPLICATE_ENTITY", count: null };
  }
  if (a.size !== b.size || [...a].some((value) => !b.has(value))) {
    return { complete: false, reason: "REGISTRY_LOG_MISMATCH", count: null };
  }
  return { complete: true, reason: null, count: a.size };
}

const VAULT_IMMUTABLE_ARGUMENTS = Object.freeze({
  FACTORY: Object.freeze({ artifactAstId: "136538", constructorArgument: "vaultFactory", source: "src/contracts/common/MigratableEntity.sol" }),
  DELEGATOR_FACTORY: Object.freeze({ artifactAstId: "151525", constructorArgument: "delegatorFactory", source: "src/contracts/vault/VaultV2.sol" }),
  PROTOCOL_FEE_REGISTRY: Object.freeze({ artifactAstId: "151528", constructorArgument: "protocolFeeRegistry", source: "src/contracts/vault/VaultV2.sol" }),
  WITHDRAWAL_QUEUE_FACTORY: Object.freeze({ artifactAstId: "151531", constructorArgument: "withdrawalQueueFactory", source: "src/contracts/vault/VaultV2.sol" })
});
const PROXY_IMMUTABLE_ARGUMENTS = Object.freeze({
  _admin: Object.freeze({ artifactAstId: "136696", constructorArgument: "msg.sender (VaultFactory)",
    source: "src/contracts/common/MigratableEntityProxy.sol" })
});

function normalizeRuntimeArtifact(artifact, namedImmutableValues = {}, immutablePlan = VAULT_IMMUTABLE_ARGUMENTS) {
  const object = artifact && artifact.deployedBytecode && artifact.deployedBytecode.object;
  const references = artifact && artifact.deployedBytecode && artifact.deployedBytecode.immutableReferences;
  if (typeof object !== "string" || !/^(?:0x)?[0-9a-fA-F]+$/u.test(object) || !references ||
    typeof references !== "object") return null;
  const base = object.replace(/^0x/u, "").toLowerCase();
  const expectedNames = Object.keys(namedImmutableValues).sort();
  const observedNames = [];
  const bytes = base.split("");
  for (const [astId, group] of Object.entries(references)) {
    const entry = Object.entries(immutablePlan).find(([, plan]) => plan.artifactAstId === String(astId));
    if (!entry || !Object.prototype.hasOwnProperty.call(namedImmutableValues, entry[0]) || !Array.isArray(group)) return null;
    const [name] = entry;
    const value = safeAddress(namedImmutableValues[name]);
    if (!value) return null;
    observedNames.push(name);
    const encoded = value.slice(2).padStart(64, "0");
    for (const reference of group) {
      const start = Number(reference.start) * 2;
      const length = Number(reference.length) * 2;
      if (!Number.isSafeInteger(start) || length !== 64 || start + length > bytes.length) return null;
      bytes.splice(start, length, ...encoded);
    }
  }
  if (canonicalJson([...new Set(observedNames)].sort()) !== canonicalJson(expectedNames)) return null;
  return `0x${bytes.join("")}`;
}

function vaultImmutableBinding() {
  const vaultSource = fs.readFileSync(path.join(TARGET, "src", "contracts", "vault", "VaultV2.sol"), "utf8");
  const entitySource = fs.readFileSync(path.join(TARGET, "src", "contracts", "common", "MigratableEntity.sol"), "utf8");
  const sourceChecks = [
    /constructor\(\s*address vaultFactory,\s*address delegatorFactory,\s*address protocolFeeRegistry,\s*address withdrawalQueueFactory\s*\)\s*MigratableEntity\(vaultFactory\)/su,
    /DELEGATOR_FACTORY\s*=\s*delegatorFactory\s*;/u,
    /PROTOCOL_FEE_REGISTRY\s*=\s*protocolFeeRegistry\s*;/u,
    /WITHDRAWAL_QUEUE_FACTORY\s*=\s*withdrawalQueueFactory\s*;/u,
    /constructor\(address factory\)[\s\S]*FACTORY\s*=\s*factory\s*;/u
  ];
  if (!sourceChecks.slice(0, 4).every((pattern) => pattern.test(vaultSource)) || !sourceChecks[4].test(entitySource)) {
    throw new Error("IMMUTABLE_SOURCE_ARGUMENT_BINDING_INVALID");
  }
  const declarations = {
    FACTORY: entitySource.indexOf("address public immutable FACTORY;"),
    DELEGATOR_FACTORY: vaultSource.indexOf("address internal immutable DELEGATOR_FACTORY;"),
    PROTOCOL_FEE_REGISTRY: vaultSource.indexOf("address internal immutable PROTOCOL_FEE_REGISTRY;"),
    WITHDRAWAL_QUEUE_FACTORY: vaultSource.indexOf("address internal immutable WITHDRAWAL_QUEUE_FACTORY;")
  };
  if (Object.values(declarations).some((offset) => offset < 0)) throw new Error("IMMUTABLE_SOURCE_AST_SLOT_MISSING");
  return {
    plan: Object.fromEntries(Object.entries(VAULT_IMMUTABLE_ARGUMENTS).map(([name, row]) =>
      [name, { ...row, sourceDeclarationByteOffset: declarations[name] }])),
    values: {
      FACTORY: CANONICAL.VaultFactory,
      DELEGATOR_FACTORY: CANONICAL.UniversalDelegatorFactory,
      PROTOCOL_FEE_REGISTRY: CANONICAL.ProtocolFeeRegistry,
      WITHDRAWAL_QUEUE_FACTORY: CANONICAL.WithdrawalQueueFactory
    }
  };
}

function proxyImmutableBinding() {
  const source = fs.readFileSync(path.join(TARGET, "src", "contracts", "common", "MigratableEntityProxy.sol"), "utf8");
  const offset = source.indexOf("address private immutable _admin;");
  if (offset < 0 || !/constructor\(address logic, bytes memory data\)[\s\S]*_admin\s*=\s*msg\.sender\s*;/u.test(source)) {
    throw new Error("PROXY_IMMUTABLE_SOURCE_BINDING_INVALID");
  }
  return { plan: { _admin: { ...PROXY_IMMUTABLE_ARGUMENTS._admin, sourceDeclarationByteOffset: offset } },
    values: { _admin: CANONICAL.VaultFactory } };
}

function loadArtifact(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(TARGET, ...relativePath.split("/")), "utf8"));
}

function exactArtifactRuntime(artifact) {
  const references = artifact?.deployedBytecode?.immutableReferences;
  if (references && Object.keys(references).length !== 0) return null;
  const object = artifact?.deployedBytecode?.object;
  if (typeof object !== "string" || !/^(?:0x)?[0-9a-fA-F]+$/u.test(object)) return null;
  return `0x${object.replace(/^0x/u, "").toLowerCase()}`;
}

function classifyRuntime(input) {
  const identity = [
    input.dualFamilyAgreement,
    input.proxySlotBound,
    input.proxyRuntimeExact,
    input.versionBound,
    input.versionImplementationMatchesSlot,
    input.currentImplementationCodeBound,
    input.localRuntimeExact,
    input.canonicalDependencyRuntimesExact,
    input.immutableDependenciesReconstructed,
    input.factoryGetterMatches,
    input.migrationHistoryComplete
  ];
  if (identity.some((value) => value === false)) return { exactVaultV2: false, reason: "RUNTIME_BINDING_NEGATIVE" };
  if (identity.some((value) => value === null || value === undefined)) {
    return { exactVaultV2: null, reason: "RUNTIME_BINDING_INCOMPLETE" };
  }
  const requiredReads = [input.requiredReadsComplete, input.selectorClosure, input.immutableGetterAgreement];
  if (requiredReads.some((value) => value === null || value === undefined)) {
    return { exactVaultV2: null, reason: "REQUIRED_READ_INCOMPLETE" };
  }
  return requiredReads.every(Boolean) ? { exactVaultV2: true, reason: null } :
    { exactVaultV2: false, reason: "REQUIRED_READ_NEGATIVE" };
}

function classifyZeroShareDepositEvidence(deposit, inboundTransfers, standardTokenSemantics) {
  const nominal = Boolean(deposit && deposit.type === "deposit" && deposit.assets > 0n && deposit.shares === 0n);
  if (!nominal) return { nominalZeroShareDeposit: false, actualAssetLoss: null };
  if (standardTokenSemantics !== true || !Array.isArray(inboundTransfers)) {
    return { nominalZeroShareDeposit: true, actualAssetLoss: null };
  }
  const matched = inboundTransfers.some((row) => row.transactionHash === deposit.transactionHash &&
    row.logIndex < deposit.logIndex && row.to === deposit.vault && row.value === deposit.assets);
  return { nominalZeroShareDeposit: true, actualAssetLoss: matched ? true : null };
}

function aggregateZeroShareDeposits(events, completeHistory) {
  if (!completeHistory) return { complete: false, nominalCount: null, actualLossCount: null, nominalAssetMagnitude: null };
  const affected = events.filter((row) => row.evidence?.nominalZeroShareDeposit === true);
  const actual = affected.filter((row) => row.evidence.actualAssetLoss === true);
  return {
    complete: true,
    nominalCount: affected.length,
    actualLossCount: affected.length && actual.length !== affected.length ? null : actual.length,
    nominalAssetMagnitude: affected.reduce((sum, row) => sum + row.assets, 0n)
  };
}

function replayShareTransfers(events, completeHistory) {
  if (!completeHistory) return { complete: false, currentSupply: null, currentHolderCount: null,
    zeroSupplyWindowCount: null, soleHolderWindowCount: null, reason: "INCOMPLETE_PREFIX" };
  const balances = new Map();
  let supply = 0n;
  let zeroSupplyWindowCount = 0;
  let soleHolderWindowCount = 0;
  let previousZero = true;
  let previousSole = false;
  for (const event of sortLogs(events)) {
    if (event.type !== "transfer" || event.value < 0n) return { complete: false, currentSupply: null,
      currentHolderCount: null, zeroSupplyWindowCount: null, soleHolderWindowCount: null,
      reason: "MALFORMED_TRANSFER" };
    if (event.from === "0x0000000000000000000000000000000000000000") supply += event.value;
    else {
      const balance = balances.get(event.from) || 0n;
      if (balance < event.value) return { complete: false, currentSupply: null, currentHolderCount: null,
        zeroSupplyWindowCount: null, soleHolderWindowCount: null, reason: "NEGATIVE_BALANCE_PREFIX" };
      balances.set(event.from, balance - event.value);
    }
    if (event.to === "0x0000000000000000000000000000000000000000") {
      if (supply < event.value) return { complete: false, currentSupply: null, currentHolderCount: null,
        zeroSupplyWindowCount: null, soleHolderWindowCount: null, reason: "NEGATIVE_SUPPLY_PREFIX" };
      supply -= event.value;
    } else balances.set(event.to, (balances.get(event.to) || 0n) + event.value);
    const holders = [...balances.values()].filter((value) => value > 0n).length;
    const zero = supply === 0n;
    const sole = holders === 1 && supply > 0n;
    if (zero && !previousZero) zeroSupplyWindowCount += 1;
    if (sole && !previousSole) soleHolderWindowCount += 1;
    previousZero = zero;
    previousSole = sole;
  }
  return { complete: true, currentSupply: supply, currentHolderCount: [...balances.values()].filter((value) => value > 0n).length,
    zeroSupplyWindowCount, soleHolderWindowCount, reason: null };
}

function reconcileStoredShareSupply(replay, totalSupplyView, pendingFeeShares) {
  if (!replay || !replay.complete || typeof totalSupplyView !== "bigint" || typeof pendingFeeShares !== "bigint" ||
    totalSupplyView < pendingFeeShares || replay.currentSupply !== totalSupplyView - pendingFeeShares) {
    return { ...replay, complete: false, currentSupply: null, currentHolderCount: null,
      zeroSupplyWindowCount: null, soleHolderWindowCount: null, reason: "STORED_SUPPLY_REPLAY_MISMATCH" };
  }
  return { ...replay, pendingFeeShares, reason: null };
}

function classifyDonationCandidate(input) {
  if (!input || !input.historyComplete || !input.transactionOrderingComplete) {
    return { candidate: null, confirmedDonation: null, attackerProfit: null, reason: "HISTORY_OR_ORDERING_INCOMPLETE" };
  }
  const candidate = Boolean(input.transferToVault && !input.matchedDeposit && !input.knownInternalMovement);
  return {
    candidate,
    confirmedDonation: input.traceAvailable ? Boolean(candidate && input.traceProvesDirectDonation) : null,
    attackerProfit: input.traceAvailable && input.fullCashflowAttribution ? input.attributedProfit : null,
    reason: input.traceAvailable ? null : "TRACE_NOT_AUTHORIZED_FIRST_PASS"
  };
}

function countBucket(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return null;
  if (number === 0) return "0";
  if (number <= 2) return "1-2";
  if (number <= 9) return "3-9";
  return "10+";
}

function magnitudeBucket(value) {
  if (value === null || value === undefined) return null;
  let number;
  try { number = BigInt(value); } catch (_) { return null; }
  if (number < 0n) return null;
  if (number === 0n) return "0";
  const digits = number.toString().length;
  return digits === 1 ? "1-9" : `1e${digits - 1}-<1e${digits}`;
}

function privacyBudgetSummary(summary) {
  if (!summary || typeof summary !== "object") return { allWithinCaps: false, exhausted: "UNKNOWN" };
  return {
    totalRequestCountBucket: countBucket(summary.total),
    callRequestCountBucket: countBucket(summary.calls),
    codeRequestCountBucket: countBucket(summary.codes),
    storageRequestCountBucket: countBucket(summary.storage),
    logRequestCountBucket: countBucket(summary.logs),
    blockRequestCountBucket: countBucket(summary.blocks),
    retryCountBucket: countBucket(summary.retries),
    returnedLogCountBucket: countBucket(summary.returnedLogs),
    responseByteMagnitudeBucket: magnitudeBucket(summary.responseBytes),
    chunkCountBucket: countBucket(summary.chunks),
    timestampFetchCountBucket: countBucket(summary.timestampFetches),
    uniqueHeaderCountBucket: countBucket(summary.uniqueHeaders),
    exhausted: summary.exhausted,
    allWithinCaps: summary.allWithinCaps === true
  };
}

function nullPromotionGates() {
  return {
    exactSourceRuntime: null,
    affectedZeroShareSemantics: null,
    current18PlusUnrestrictedConfig: null,
    currentFirstSoleRestartState: null,
    historicalNominalZeroShareDeposits: null,
    historicalActualAssetLoss: null,
    confirmedDonationSequence: null,
    attackerRedemptionProfit: null,
    currentNetEconomics: null
  };
}

const FIXED_REASON_CODES = Object.freeze([
  "DEPENDENCY_SOURCE_RECONSTRUCTION_FAILED",
  "DEPENDENCY_DUAL_FAMILY_RUNTIME_UNBOUND",
  "DEPENDENCY_RUNTIME_EMPTY_OR_MALFORMED",
  "DEPENDENCY_RUNTIME_MISMATCH",
  "INVENTORY_INCOMPLETE",
  "QUALIFICATION_INCOMPLETE",
  "PIN_VALIDATION_INCOMPLETE",
  "TERMINAL_PIN_INCOMPLETE",
  "FACTORY_HISTORY_INCOMPLETE",
  "ENTITY_LIFECYCLE_INCOMPLETE",
  "ENTITY_MALFORMED_INCOMPLETE",
  "PROXY_RUNTIME_INCOMPLETE",
  "RUNTIME_BINDING_INCOMPLETE",
  "CONFIG_READ_INCOMPLETE",
  "CANONICAL_LOG_INCOMPLETE",
  "HISTORY_INCOMPLETE",
  "STORED_SUPPLY_INCOMPLETE",
  "COMPLETENESS_GATE_FAILED",
  "TRANSPORT_INCOMPLETE",
  "BUDGET_EXHAUSTED",
  "PRIVACY_SANITIZATION_FAILED",
  "INTERNAL_FAILURE_REDACTED"
]);
const FIXED_REASON_SET = new Set(FIXED_REASON_CODES);

function mapPostLedgerFailure(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  if (FIXED_REASON_SET.has(message)) return message;
  if (/^BUDGET_EXHAUSTED_/u.test(message) || /_CAP_EXHAUSTED$/u.test(message) ||
    /SCAN_SPAN_EXHAUSTED/u.test(message)) return "BUDGET_EXHAUSTED";
  if (/^INVENTORY_|^FAMILY_CAP_/u.test(message)) return "INVENTORY_INCOMPLETE";
  if (/TWO_FAMILY|WRONG_CHAIN|FINALIZED|QUALIF/u.test(message)) return "QUALIFICATION_INCOMPLETE";
  if (/COMMON_PIN|PIN_HEADER|PIN_NUMBER/u.test(message)) return "PIN_VALIDATION_INCOMPLETE";
  if (/TERMINAL/u.test(message)) return "TERMINAL_PIN_INCOMPLETE";
  if (/CANONICAL|LOG_BLOCK_HASH/u.test(message)) return "CANONICAL_LOG_INCOMPLETE";
  if (/WHITELIST|BLACKLIST|REGISTRY|ADD_ENTITY|FACTORY_LOG|MIGRATE_ENTITY/u.test(message)) {
    return "FACTORY_HISTORY_INCOMPLETE";
  }
  if (/LIFECYCLE|INITIALIZED|CREATION_INITIALIZE|MIGRATION_/u.test(message)) return "ENTITY_LIFECYCLE_INCOMPLETE";
  if (/RUNTIME|IMPLEMENTATION|IMMUTABLE|PROXY|STORAGE/u.test(message)) return "RUNTIME_BINDING_INCOMPLETE";
  if (/CONFIG|REQUIRED_READ|SELECTOR|INCOMPLETE_eth_call/u.test(message)) return "CONFIG_READ_INCOMPLETE";
  if (/HISTORY|DEPOSIT|TRANSFER|QUEUE|STORED_SUPPLY|LOG_SCAN/u.test(message)) return "HISTORY_INCOMPLETE";
  if (/TRANSPORT|HTTP_STATUS|BODY_STREAM|REDIRECT|MALFORMED_JSON|ENVELOPE|RPC_ERROR/u.test(message)) {
    return "TRANSPORT_INCOMPLETE";
  }
  return "INTERNAL_FAILURE_REDACTED";
}

function failClosedCapture(reason, budget = new Budget().summary()) {
  const reasonCode = FIXED_REASON_SET.has(reason) ? reason : "INTERNAL_FAILURE_REDACTED";
  return {
    schemaVersion: 1,
    findingId: FINDING_ID,
    proposalId: PROPOSAL_ID,
    status: "INCOMPLETE_ALL_PROMOTION_GATES_NULL",
    reasonCode,
    chain: { name: "ethereum-mainnet", chainId: CHAIN_ID },
    canonicalManifest: canonicalManifestEvidence(),
    promotionGates: nullPromotionGates(),
    operationalGates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false },
    budget: privacyBudgetSummary(budget),
    sanitized: true,
    directIdentifiersPersisted: false,
    directRowsPersisted: false,
    rawResponsesPersisted: false
  };
}

function canonicalManifestEvidence() {
  return {
    evidenceClass: "MUTABLE_DOCUMENT_DISCOVERY_ONLY_NOT_RUNTIME_PROOF",
    chainId: CHAIN_ID,
    documentation: DOCS_URL,
    sourceCommit: SOURCE_COMMIT,
    contracts: { ...CANONICAL },
    configuratorAddressClaimed: false,
    proxyAddressClaimed: false,
    versionRegistryAddressClaimed: false
  };
}

function loadSourceBinding() {
  const files = BOUND_FILES.map((relative) => {
    const bytes = fs.readFileSync(path.join(TARGET, ...relative.split("/")));
    return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
  });
  return { files, commitment: commitment(files) };
}

function sanitizeCapture(value) {
  const forbiddenKeys = new Set(["endpoint", "endpointUrl", "hostname", "provider", "providerUrl", "caller", "sender",
    "ownerAddress", "vaultAddress", "assetAddress", "transactionHash", "blockHash", "blockNumber", "rawResponse",
    "calldata", "userRow", "rowCommitment", "rows", "entities"].map((key) => key.toLowerCase()));
  const canonicalAddresses = new Set(Object.values(CANONICAL).map((address) => address.toLowerCase()));
  const allowedBare40 = new Set([SOURCE_COMMIT.toLowerCase(), ...[...canonicalAddresses].map((address) => address.slice(2))]);
  function walk(current, key = "") {
    if (forbiddenKeys.has(String(key).toLowerCase())) throw new Error("OUTPUT_IDENTITY_LEAK");
    if (typeof current === "string") {
      const urlMatches = current.match(/(?:https?|wss?):\/\/[^\s"'<>]+/giu) || [];
      if (urlMatches.some((url) => url !== DOCS_URL)) throw new Error("OUTPUT_NETWORK_IDENTIFIER_LEAK");
      const prefixed = current.match(/0x[0-9a-f]+/giu) || [];
      for (const token of prefixed) {
        const normalized = token.toLowerCase();
        if (normalized.length === 42 && canonicalAddresses.has(normalized)) continue;
        throw new Error("OUTPUT_HEX_IDENTIFIER_LEAK");
      }
      const bare64 = current.match(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/giu) || [];
      if (bare64.length) throw new Error("OUTPUT_HASH_LEAK");
      const bare40 = current.match(/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/giu) || [];
      if (bare40.some((token) => !allowedBare40.has(token.toLowerCase()))) throw new Error("OUTPUT_ADDRESS_LEAK");
      return current;
    }
    if (Array.isArray(current)) return current.map((entry) => walk(entry, key));
    if (current && typeof current === "object") {
      const result = {};
      for (const [childKey, childValue] of Object.entries(current)) result[childKey] = walk(childValue, childKey);
      return result;
    }
    return current;
  }
  return walk(value);
}

function writeSanitizedCaptureAtomically(value, outputPath = path.join(ROOT, ...FIXED_OUTPUT_REL.split("/"))) {
  let sanitized;
  try {
    sanitized = sanitizeCapture(value);
  } catch (_) {
    sanitized = sanitizeCapture(failClosedCapture("PRIVACY_SANITIZATION_FAILED", value?.budget || new Budget().summary()));
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (fs.existsSync(outputPath)) throw new Error("CAPTURE_OUTPUT_ALREADY_EXISTS");
  const temporary = `${outputPath}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const descriptor = fs.openSync(temporary, "wx");
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(sanitized, (_, current) => typeof current === "bigint" ? current.toString() : current, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, outputPath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
  return sanitized;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === "--check-only")) {
    return { capture: false, checkOnly: true, approvalFile: null };
  }
  if (args.includes("--check-only") && args.includes("--capture-once")) throw new Error("MODE_CONFLICT");
  if (args[0] !== "--capture-once") throw new Error("UNKNOWN_ARGUMENT");
  if (args.length !== 3 || args[1] !== "--approval-file" || args[2] !== FIXED_APPROVAL_REL) {
    throw new Error("APPROVAL_PATH_INVALID");
  }
  return { capture: true, checkOnly: false, approvalFile: args[2] };
}

function dryPreflight() {
  const sourceBinding = loadSourceBinding();
  return {
    schemaVersion: 1,
    findingId: FINDING_ID,
    proposalId: PROPOSAL_ID,
    status: "PREPARED_NOT_AUTHORIZED_NOT_EXECUTED",
    chain: { name: "ethereum-mainnet", chainId: CHAIN_ID, chains: 1 },
    canonicalManifest: canonicalManifestEvidence(),
    authorization: {
      defaultMode: "CHECK_ONLY",
      captureFlagRequired: "--capture-once",
      fixedApprovalPath: FIXED_APPROVAL_REL,
      fixedOutputPath: FIXED_OUTPUT_REL,
      globalConsumptionLedger: GLOBAL_LEDGER_REL,
      requestedApprovalId: REQUESTED_APPROVAL_ID,
      proposalState: "REVIEW_REQUESTED",
      proposalAuthorization: "NOT_AUTHORIZED",
      authorized: false,
      captureExecuted: false,
      oneShot: true
    },
    discovery: {
      authoritativeFactoryEnumeration: ["totalEntities", "entity", "isEntity"],
      completeAddEntityHistoryCrossCheck: true,
      allVersions: ["lastVersion", "implementation", "blacklisted", "Whitelist", "Blacklist", "AddEntity", "Initialized", "Migrate"],
      orderedVersionImplementationReconciliation: true,
      perEntityImplementationIntervals: true,
      depositHistoryRestrictedToProvenExactV2Interval: true,
      vaultConfiguratorExcluded: true,
      versionOrAddressAloneSufficient: false
    },
    pinPolicy: {
      minimumHostnameDistinctFamilies: CAPS.minDistinctFamilies,
      commonMinimumFinalizedHeight: true,
      identicalReportedFinalizedHeadsRequired: false,
      exactCommonPinHeaderAgreement: true,
      terminalSameNumberHashRecheck: true
    },
    runtimePolicy: { exactCanonicalDependencyRuntimes: true, exactProxyRuntime: true,
      canonicalDependencyGateBeforeEntityEnumeration: true, dependencyMismatchForcesAllNull: true,
      namedImmutableAstSlotsNoPermutations: true, requiredReadFailureIsNull: true,
      productionCompleteOrAllNull: true,
      conclusiveNonV2RequiresExactProxyVersionLifecycleCodeAndCompletedV2Comparator: true },
    historyPolicy: { canonicalHeaderForEveryLogBlock: true, dedupeAllLogClasses: true,
      storedSupplyEqualsViewMinusPendingFeeShares: true, nominalZeroShareIsNotActualLoss: true },
    methods: { allowed: [...ALLOWED_METHODS].sort(), forbidden: [...FORBIDDEN_METHODS].sort(), traceFirstPass: false },
    caps: CAPS,
    capsCommitment: commitment(CAPS),
    sourceBinding,
    sourceBindingCommitment: sourceBinding.commitment,
    outputPolicy: {
      canonicalManifestContractsOnly: true,
      endpointIdentities: false,
      callerVaultAssetRows: false,
      rawResponses: false,
      calldata: false,
      transactionHashes: false,
      deterministicUserRowCommitments: false,
      fixedPostLedgerReasonCodes: [...FIXED_REASON_CODES],
      unknownErrorsRedacted: true,
      recursiveCaseInsensitiveKeyIndependentHexDetection: true,
      kAnonymity: { threshold: 3, countBuckets: ["0", "1-2", "3-9", "10+"], valueMagnitudeBuckets: true }
    },
    promotionGates: nullPromotionGates(),
    operationalGates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false },
    networkReads: 0,
    inventoryReads: 0,
    captureExecuted: false,
    writes: 0
  };
}

function validateApprovalEnvelope(envelope, context) {
  if (!envelope || envelope.schemaVersion !== 1 || envelope.state !== "AUTHORIZED" || !envelope.approvalPayload) {
    throw new Error("APPROVAL_ENVELOPE_INVALID");
  }
  const payload = envelope.approvalPayload;
  if (envelope.approvalCommitment !== commitment(payload)) throw new Error("APPROVAL_COMMITMENT_INVALID");
  const required = context.expected;
  for (const [key, expected] of Object.entries(required)) {
    if (payload[key] !== expected) throw new Error("APPROVAL_BINDING_INVALID");
  }
  if (payload.approvalId !== REQUESTED_APPROVAL_ID || payload.proposalId !== PROPOSAL_ID ||
    payload.findingId !== FINDING_ID || payload.chainId !== CHAIN_ID ||
    payload.authorizedCaptureCount !== 1 || payload.endpointInventoryReadAuthorized !== true ||
    payload.transactionsAuthorized !== false || payload.traceAuthorized !== false || payload.forkAuthorized !== false ||
    canonicalJson(payload.allowedMethods) !== canonicalJson([...ALLOWED_METHODS].sort())) {
    throw new Error("APPROVAL_SCOPE_INVALID");
  }
  const issued = Date.parse(payload.issuedAt);
  const expires = Date.parse(payload.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > context.now + CAPS.maxApprovalFutureSkewMs ||
    context.now - issued > CAPS.maxApprovalIssuedAgeMs || expires <= context.now ||
    expires - issued > CAPS.maxApprovalWindowMs) throw new Error("APPROVAL_WINDOW_INVALID");
  if (context.consumed) throw new Error("APPROVAL_ALREADY_CONSUMED");
  return { approvalId: payload.approvalId, approvalCommitment: envelope.approvalCommitment, payload };
}

function packageValidationContext() {
  const proposal = JSON.parse(fs.readFileSync(path.join(ROOT, ...PROPOSAL_REL.split("/")), "utf8"));
  const manifestBytes = fs.readFileSync(path.join(ROOT, ...MANIFEST_REL.split("/")));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const runnerBytes = fs.readFileSync(__filename);
  const sourceBinding = loadSourceBinding();
  if (proposal.schema !== "symbiotic-vaultv2-donation-step2-proposal-v1" || proposal.proposalId !== PROPOSAL_ID ||
    proposal.state !== "REVIEW_REQUESTED_NOT_AUTHORIZED" || proposal.authorizesExecution !== false ||
    proposal.proposalCommitment !== commitment(proposal.payload)) throw new Error("PROPOSAL_INTEGRITY_INVALID");
  if (manifest.schema !== "symbiotic-vaultv2-donation-step2-package-v1" || manifest.revision !== 4 ||
    manifest.proposalId !== PROPOSAL_ID ||
    manifest.approvalIssued !== false || manifest.captureExecuted !== false || !Array.isArray(manifest.entries) ||
    manifest.aggregateSha256 !== sha256(Buffer.from(canonicalJson(manifest.entries)))) {
    throw new Error("PACKAGE_MANIFEST_INVALID");
  }
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.path !== "string" || !/^[A-Za-z0-9._/-]+$/.test(entry.path) ||
      entry.path.startsWith("/") || entry.path.split("/").includes("..") ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error("PACKAGE_ENTRY_INVALID");
    }
    const absolute = path.resolve(ROOT, ...entry.path.split("/"));
    const relative = path.relative(ROOT, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("PACKAGE_PATH_INVALID");
    const bytes = fs.readFileSync(absolute);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error("PACKAGE_ENTRY_HASH_MISMATCH");
  }
  if (proposal.payload?.runner?.path !== "tools/critical-symbiotic-vaultv2-donation-step2-runner.js" ||
    proposal.payload.runner.sha256 !== sha256(runnerBytes) || proposal.payload?.source?.commitment !== sourceBinding.commitment ||
    proposal.payload?.caps?.commitment !== commitment(CAPS) || proposal.payload?.proposalId !== PROPOSAL_ID ||
    proposal.payload?.requestedApprovalId !== REQUESTED_APPROVAL_ID ||
    proposal.payload?.fixedPaths?.approval !== FIXED_APPROVAL_REL || proposal.payload?.fixedPaths?.output !== FIXED_OUTPUT_REL ||
    proposal.payload?.fixedPaths?.globalLedger !== GLOBAL_LEDGER_REL ||
    canonicalJson(proposal.payload?.policy?.strictMethods) !== canonicalJson([...ALLOWED_METHODS].sort())) {
    throw new Error("PROPOSAL_BINDING_INVALID");
  }
  return {
    proposal,
    manifest,
    expected: {
      fixedApprovalPath: FIXED_APPROVAL_REL,
      proposalId: PROPOSAL_ID,
      fixedOutputPath: FIXED_OUTPUT_REL,
      globalConsumptionLedger: GLOBAL_LEDGER_REL,
      runnerSha256: `0x${sha256(runnerBytes)}`,
      packageManifestSha256: `0x${sha256(manifestBytes)}`,
      packageAggregateSha256: `0x${manifest.aggregateSha256}`,
      proposalCommitment: proposal.proposalCommitment,
      packageSourceBinding: sourceBinding.commitment,
      capsCommitment: commitment(CAPS)
    }
  };
}

function consumeApprovalAtomically(authorization, ledgerPath = path.join(ROOT, ...GLOBAL_LEDGER_REL.split("/"))) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const descriptor = fs.openSync(ledgerPath, "wx");
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify({
      schemaVersion: 1,
      findingId: FINDING_ID,
      approvalId: authorization.approvalId,
      approvalCommitment: authorization.approvalCommitment,
      status: "GLOBALLY_CONSUMED_BEFORE_INVENTORY_ACCESS"
    }, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseInventoryText(text, caps = CAPS) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > caps.maxInventoryBytes) {
    throw new Error("INVENTORY_BYTE_CAP_EXHAUSTED");
  }
  const candidates = [];
  try {
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : Object.values(parsed).flat();
    for (const row of rows) {
      if (typeof row === "string") candidates.push(row);
      else if (row && typeof row === "object" && Number(row.chainId) === CHAIN_ID && typeof row.url === "string") {
        candidates.push(row.url);
      }
    }
  } catch (_) {
    for (const line of text.split(/\r?\n/u)) {
      const match = line.match(/https?:\/\/[^\s,;]+/u);
      if (match) candidates.push(match[0]);
    }
  }
  const unique = [];
  for (const url of candidates) {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) continue;
      if (!unique.some((entry) => entry.url === parsed.href)) unique.push({ url: parsed.href, hostname: parsed.hostname.toLowerCase() });
    } catch (_) {}
  }
  if (unique.length > caps.maxInventoryEntries) throw new Error("INVENTORY_ENTRY_CAP_EXHAUSTED");
  if (new Set(unique.map((entry) => entry.hostname)).size > caps.maxFamilies) {
    throw new Error("FAMILY_CAP_EXHAUSTED");
  }
  return unique;
}

function loadInventoryAuthorized() {
  const before = fs.statSync(INVENTORY_PATH);
  if (before.size > CAPS.maxInventoryBytes) throw new Error("INVENTORY_BYTE_CAP_EXHAUSTED");
  const bytes = fs.readFileSync(INVENTORY_PATH);
  if (bytes.length > CAPS.maxInventoryBytes) throw new Error("INVENTORY_BYTE_CAP_EXHAUSTED");
  return parseInventoryText(bytes.toString("utf8"));
}

async function dualRpc(selected, method, params, context) {
  const results = [];
  for (const endpoint of selected) {
    const response = await (context.rpcRequest || rpcRequest)(endpoint, method, params, context);
    if (!response.ok) throw new Error(`INCOMPLETE_${method}`);
    results.push(response.result);
  }
  const first = canonicalJson(results[0]);
  if (results.some((result) => canonicalJson(result) !== first)) throw new Error(`FAMILY_DISAGREEMENT_${method}`);
  return results[0];
}

async function qualifyFamilies(inventory, context) {
  if (inventory.length > context.caps.maxInventoryEntries) context.budget.stop("INVENTORY_ENTRIES");
  if (new Set(inventory.map((entry) => entry.hostname)).size > context.caps.maxFamilies) context.budget.stop("FAMILIES");
  const byHost = new Map();
  for (const endpoint of inventory) {
    context.budget.checkTime();
    if (byHost.has(endpoint.hostname)) continue;
    const chain = await (context.rpcRequest || rpcRequest)(endpoint, "eth_chainId", [], context);
    if (!chain.ok || strictQuantity(chain.result) !== 1n) continue;
    const finalized = await (context.rpcRequest || rpcRequest)(endpoint, "eth_getBlockByNumber", ["finalized", false], context);
    const header = finalized.ok ? parseBlockHeader(finalized.result) : null;
    if (!header) continue;
    context.budget.observeHeader(header.number);
    byHost.set(endpoint.hostname, { ...endpoint, family: `F${byHost.size + 1}`, finalized: header });
  }
  if (byHost.size < CAPS.minDistinctFamilies) throw new Error("TWO_FAMILY_THRESHOLD_NOT_MET");
  return [...byHost.values()];
}

async function selectPinnedFamilies(qualified, context) {
  const reports = qualified.map((row) => ({ family: row.family, hostname: row.hostname, header: row.finalized }));
  const common = reports.reduce((minimum, row) => row.header.number < minimum ? row.header.number : minimum,
    reports[0].header.number);
  const pinHeaders = [];
  for (const endpoint of qualified) {
    const response = await (context.rpcRequest || rpcRequest)(endpoint, "eth_getBlockByNumber", [toQuantity(common), false], context);
    const header = response.ok ? parseBlockHeader(response.result) : null;
    if (!header) throw new Error("COMMON_PIN_HEADER_MISSING");
    context.budget.observeHeader(header.number);
    pinHeaders.push({ family: endpoint.family, header });
  }
  const selection = selectCommonMinimumPin(reports, pinHeaders);
  if (!selection.promotable) throw new Error(selection.reason);
  return { selected: qualified, selection };
}

async function callDecoded(selected, target, iface, method, args, pin, context) {
  const data = iface.encodeFunctionData(method, args);
  const result = await dualRpc(selected, "eth_call", [{ to: target, data }, toQuantity(pin)], context);
  return iface.decodeFunctionResult(method, result);
}

async function scanLogs(selected, filter, fromBlock, toBlock, context) {
  if (toBlock < fromBlock || toBlock - fromBlock + 1n > BigInt(context.caps.maxScanSpanBlocks)) {
    context.budget.stop("SCAN_SPAN");
  }
  const familyResults = [];
  for (const endpoint of selected) {
    const rows = [];
    for (let start = fromBlock; start <= toBlock; start += BigInt(context.caps.maxLogChunkBlocks)) {
      context.budget.checkTime();
      context.budget.consumeChunk();
      const end = start + BigInt(context.caps.maxLogChunkBlocks - 1) > toBlock ? toBlock :
        start + BigInt(context.caps.maxLogChunkBlocks - 1);
      const response = await (context.rpcRequest || rpcRequest)(endpoint, "eth_getLogs", [{ ...filter, fromBlock: toQuantity(start),
        toBlock: toQuantity(end) }], context);
      if (!response.ok || !Array.isArray(response.result)) throw new Error("LOG_SCAN_INCOMPLETE");
      for (const row of response.result) {
        context.budget.consumeLog();
        rows.push(row);
      }
    }
    familyResults.push(rows);
  }
  const normalized = familyResults.map((rows) => canonicalJson(rows));
  if (normalized.some((value) => value !== normalized[0])) throw new Error("LOG_FAMILY_DISAGREEMENT");
  return familyResults[0];
}

async function validateCanonicalLogBlocks(selected, logs, context) {
  const observed = new Map();
  for (const row of logs) {
    const key = row.blockNumber.toString();
    if (observed.has(key) && observed.get(key) !== row.blockHash) throw new Error("LOG_BLOCK_HASH_CONFLICT");
    observed.set(key, row.blockHash);
  }
  if (observed.size > context.caps.maxUniqueHeaders) context.budget.stop("UNIQUE_HEADERS");
  for (const [number, expectedHash] of observed) {
    context.budget.checkTime();
    const result = await dualRpc(selected, "eth_getBlockByNumber", [toQuantity(BigInt(number)), false], context);
    const header = parseBlockHeader(result);
    if (!header) throw new Error("LOG_CANONICAL_HEADER_MISSING");
    context.budget.observeHeader(header.number);
    if (header.hash !== expectedHash) throw new Error("LOG_CANONICAL_HASH_MISMATCH");
  }
  return true;
}

function parseFactoryAddEntities(logs) {
  const rows = [];
  for (const row of logs) {
    if (row.topics[0] !== TOPICS.addEntity || row.topics.length !== 2) continue;
    const entity = topicAddress(row.topics[1]);
    if (!entity) throw new Error("MALFORMED_ADD_ENTITY");
    rows.push({ entity, blockNumber: row.blockNumber, transactionHash: row.transactionHash,
      transactionIndex: row.transactionIndex, logIndex: row.logIndex });
  }
  return rows;
}

function decodeUint64Word(value) {
  const word = strictHex(value, 32);
  if (!word) return null;
  const number = BigInt(word);
  return number <= 0xffffffffffffffffn ? number : null;
}

function reconcileFactoryVersionHistory(versions, logs) {
  const ordered = sortLogs(logs);
  const whitelist = ordered.filter((row) => row.topics[0] === TOPICS.whitelist).map((row, index) => ({
    version: BigInt(index + 1), implementation: row.topics.length === 2 && row.data === "0x" ? topicAddress(row.topics[1]) : null
  }));
  if (whitelist.length !== versions.length || whitelist.some((row, index) => !row.implementation ||
    row.version !== versions[index].version || row.implementation !== versions[index].implementation)) {
    return { complete: false, reason: "ORDERED_WHITELIST_IMPLEMENTATION_MISMATCH", migrations: [] };
  }
  const blacklistVersions = [];
  for (const row of ordered.filter((entry) => entry.topics[0] === TOPICS.blacklist)) {
    const version = row.topics.length === 2 && row.data === "0x" ? decodeUint64Word(row.topics[1]) : null;
    if (version === null || version === 0n || version > BigInt(versions.length) || blacklistVersions.includes(version)) {
      return { complete: false, reason: "BLACKLIST_HISTORY_MALFORMED", migrations: [] };
    }
    blacklistVersions.push(version);
  }
  if (versions.some((row) => Boolean(row.blacklisted) !== blacklistVersions.includes(row.version))) {
    return { complete: false, reason: "BLACKLIST_STATE_HISTORY_MISMATCH", migrations: [] };
  }
  const migrations = [];
  for (const row of ordered.filter((entry) => entry.topics[0] === TOPICS.migrate)) {
    const entity = row.topics.length === 2 ? topicAddress(row.topics[1]) : null;
    const decoded = row.topics.length === 2 ? abi.decode(["uint64"], row.data) : null;
    const newVersion = decoded ? BigInt(decoded[0]) : null;
    if (!entity || newVersion === null || newVersion === 0n || newVersion > BigInt(versions.length)) {
      return { complete: false, reason: "MIGRATE_HISTORY_MALFORMED", migrations: [] };
    }
    migrations.push({ entity, newVersion, blockNumber: row.blockNumber, transactionHash: row.transactionHash,
      transactionIndex: row.transactionIndex, logIndex: row.logIndex });
  }
  return { complete: true, reason: null, whitelist, blacklistVersions, migrations };
}

function buildEntityImplementationIntervals(input) {
  const { addEntity, initialized, vaultInitializes, migrations, currentVersion, pin } = input;
  if (!addEntity || !Array.isArray(initialized) || !Array.isArray(vaultInitializes) || !Array.isArray(migrations)) {
    return { complete: false, reason: "LIFECYCLE_INPUT_MALFORMED", intervals: [], exactV2Interval: null };
  }
  const orderedInitialized = sortLogs(initialized);
  const initial = orderedInitialized.find((row) => row.transactionHash === addEntity.transactionHash &&
    row.logIndex > addEntity.logIndex);
  const vaultInitialize = vaultInitializes.find((row) => row.transactionHash === addEntity.transactionHash &&
    row.logIndex > addEntity.logIndex && initial && row.logIndex < initial.logIndex);
  if (!initial || orderedInitialized.filter((row) => row.transactionHash === addEntity.transactionHash).length !== 1) {
    return { complete: false, reason: "CREATION_INITIALIZE_CORRELATION_GAP", intervals: [], exactV2Interval: null };
  }
  const intervals = [];
  let activeVersion = initial.version;
  let startBlock = initial.blockNumber;
  let previousOrder = { blockNumber: initial.blockNumber, transactionIndex: initial.transactionIndex, logIndex: initial.logIndex };
  const usedInitialized = new Set([`${initial.transactionHash}:${initial.logIndex}`]);
  for (const migration of sortLogs(migrations)) {
    if (migration.newVersion <= activeVersion) return { complete: false, reason: "MIGRATION_VERSION_NOT_INCREASING", intervals: [], exactV2Interval: null };
    const correlated = orderedInitialized.find((row) => row.transactionHash === migration.transactionHash &&
      row.logIndex < migration.logIndex && row.version === migration.newVersion);
    if (!correlated || usedInitialized.has(`${correlated.transactionHash}:${correlated.logIndex}`)) {
      return { complete: false, reason: "MIGRATION_INITIALIZED_CORRELATION_GAP", intervals: [], exactV2Interval: null };
    }
    if (sortLogs([previousOrder, migration])[1] !== migration) {
      return { complete: false, reason: "MIGRATION_ORDER_INVALID", intervals: [], exactV2Interval: null };
    }
    intervals.push({ version: activeVersion, fromBlock: startBlock, toBlock: migration.blockNumber });
    activeVersion = migration.newVersion;
    startBlock = migration.blockNumber;
    previousOrder = migration;
    usedInitialized.add(`${correlated.transactionHash}:${correlated.logIndex}`);
  }
  if (usedInitialized.size !== orderedInitialized.length || activeVersion !== currentVersion) {
    return { complete: false, reason: "INITIALIZED_OR_CURRENT_VERSION_MISMATCH", intervals: [], exactV2Interval: null };
  }
  intervals.push({ version: activeVersion, fromBlock: startBlock, toBlock: pin });
  const directV2 = initial.version === 3n && currentVersion === 3n && migrations.length === 0;
  return { complete: true, reason: null, initialVersion: initial.version, intervals,
    migrationCount: migrations.length, vaultV2InitializeAtCreation: Boolean(vaultInitialize),
    exactV2Interval: directV2 && vaultInitialize ? intervals[0] : null,
    noSuccessfulMigrateIntoOrDuringV2: directV2 };
}

async function captureFactory(selected, pin, context) {
  const [total] = await callDecoded(selected, CANONICAL.VaultFactory, factoryInterface, "totalEntities", [], pin, context);
  enforceNumericCap(total, context.caps.maxEntities, "ENTITIES", context.budget);
  const entities = [];
  for (let index = 0n; index < total; index++) {
    const [entity] = await callDecoded(selected, CANONICAL.VaultFactory, factoryInterface, "entity", [index], pin, context);
    const normalized = safeAddress(entity);
    const [member] = await callDecoded(selected, CANONICAL.VaultFactory, factoryInterface, "isEntity", [normalized], pin, context);
    if (!normalized || !member) throw new Error("AUTHORITATIVE_ENTITY_INVALID");
    entities.push(normalized);
  }
  const [lastVersion] = await callDecoded(selected, CANONICAL.VaultFactory, factoryInterface, "lastVersion", [], pin, context);
  enforceNumericCap(lastVersion, context.caps.maxVersions, "VERSIONS", context.budget);
  const versions = [];
  for (let version = 1n; version <= lastVersion; version++) {
    const [implementation] = await callDecoded(selected, CANONICAL.VaultFactory, factoryInterface, "implementation", [version], pin, context);
    const [blacklisted] = await callDecoded(selected, CANONICAL.VaultFactory, factoryInterface, "blacklisted", [version], pin, context);
    versions.push({ version, implementation: safeAddress(implementation), blacklisted });
  }
  const rawLogs = await scanLogs(selected, { address: CANONICAL.VaultFactory,
    topics: [[TOPICS.addEntity, TOPICS.whitelist, TOPICS.blacklist, TOPICS.migrate]] }, 0n, pin, context);
  const expected = new Set([CANONICAL.VaultFactory]);
  const validated = rawLogs.map((row) => validateLog(row, expected, 0n, pin));
  if (validated.some((row) => row === null)) throw new Error("MALFORMED_FACTORY_LOG");
  const deduped = dedupeLogs(validated);
  if (!deduped.ok) throw new Error("CONFLICTING_FACTORY_LOG");
  await validateCanonicalLogBlocks(selected, deduped.logs, context);
  const addEntities = parseFactoryAddEntities(deduped.logs);
  const registry = compareAuthoritativeEntities(entities, addEntities);
  if (!registry.complete) throw new Error(registry.reason);
  const versionHistory = reconcileFactoryVersionHistory(versions, deduped.logs);
  if (!versionHistory.complete) throw new Error(versionHistory.reason);
  if (versionHistory.migrations.some((row) => !entities.includes(row.entity))) throw new Error("MIGRATE_ENTITY_NOT_REGISTERED");
  return { entities, versions, addEntities, factoryLogs: deduped.logs, versionHistory };
}

async function captureCanonicalDependencyRuntimes(selected, pin, context) {
  const bindings = context.dependencyBindings || [
    ["VaultFactory", "out/VaultFactory.sol/VaultFactory.json"],
    ["WithdrawalQueueFactory", "out/WithdrawalQueueFactory.sol/WithdrawalQueueFactory.json"],
    ["UniversalDelegatorFactory", "out/UniversalDelegatorFactory.sol/UniversalDelegatorFactory.json"],
    ["ProtocolFeeRegistry", "out/ProtocolFeeRegistry.sol/ProtocolFeeRegistry.json"]
  ];
  const results = {};
  for (const [name, artifactPath] of bindings) {
    let expected;
    try { expected = exactArtifactRuntime((context.artifactLoader || loadArtifact)(artifactPath)); }
    catch (_) { throw new Error("DEPENDENCY_SOURCE_RECONSTRUCTION_FAILED"); }
    if (!expected || expected === "0x") throw new Error("DEPENDENCY_SOURCE_RECONSTRUCTION_FAILED");
    let raw;
    try { raw = await dualRpc(selected, "eth_getCode", [CANONICAL[name], toQuantity(pin)], context); }
    catch (error) {
      if (/^BUDGET_EXHAUSTED_/u.test(String(error?.message || ""))) throw error;
      throw new Error("DEPENDENCY_DUAL_FAMILY_RUNTIME_UNBOUND");
    }
    const observed = strictHex(raw);
    if (!observed || observed === "0x") throw new Error("DEPENDENCY_RUNTIME_EMPTY_OR_MALFORMED");
    if (observed !== expected) throw new Error("DEPENDENCY_RUNTIME_MISMATCH");
    results[name] = true;
  }
  return { exact: true, results };
}

async function captureEntityLifecycle(selected, pin, entity, addEntity, factoryMigrations, currentVersion, context) {
  const raw = await scanLogs(selected, { address: entity, topics: [[TOPICS.initialized, TOPICS.vaultInitialize]] },
    addEntity.blockNumber, pin, context);
  const validated = raw.map((row) => validateLog(row, new Set([entity]), addEntity.blockNumber, pin));
  if (validated.some((row) => row === null)) throw new Error("MALFORMED_ENTITY_LIFECYCLE_LOG");
  const deduped = dedupeLogs(validated);
  if (!deduped.ok) throw new Error("CONFLICTING_ENTITY_LIFECYCLE_LOG");
  await validateCanonicalLogBlocks(selected, deduped.logs, context);
  const initialized = [];
  const vaultInitializes = [];
  for (const row of deduped.logs) {
    if (row.topics[0] === TOPICS.initialized) {
      if (row.topics.length !== 1) throw new Error("MALFORMED_INITIALIZED_EVENT");
      const [version] = abi.decode(["uint64"], row.data);
      initialized.push({ ...row, version: BigInt(version) });
    } else if (row.topics[0] === TOPICS.vaultInitialize) vaultInitializes.push(row);
  }
  return buildEntityImplementationIntervals({ addEntity, initialized, vaultInitializes,
    migrations: factoryMigrations.filter((row) => row.entity === entity), currentVersion, pin });
}

function decodeAddressWord(value) {
  const hex = strictHex(value, 32);
  return hex ? safeAddress(`0x${hex.slice(-40)}`) : null;
}

async function captureEntityCurrent(selected, pin, entity, versions, currentVersion, lifecycle, dependencyRuntimes, context) {
  const slot = await dualRpc(selected, "eth_getStorageAt", [entity, ERC1967_IMPLEMENTATION_SLOT, toQuantity(pin)], context);
  const implementation = decodeAddressWord(slot);
  if (!implementation) throw new Error("ENTITY_MALFORMED_INCOMPLETE");
  const version = currentVersion;
  const versionRow = versions.find((row) => row.version === version);
  const versionMatches = Boolean(versionRow && versionRow.implementation === implementation);
  if (version <= 0n || !versionMatches) throw new Error("ENTITY_MALFORMED_INCOMPLETE");
  const code = strictHex(await dualRpc(selected, "eth_getCode", [implementation, toQuantity(pin)], context));
  const proxyCode = strictHex(await dualRpc(selected, "eth_getCode", [entity, toQuantity(pin)], context));
  if (!code || code === "0x") throw new Error("ENTITY_MALFORMED_INCOMPLETE");
  if (!proxyCode || proxyCode === "0x") throw new Error("PROXY_RUNTIME_INCOMPLETE");
  const artifact = loadArtifact("out/VaultV2.sol/VaultV2.json");
  const immutableBinding = vaultImmutableBinding();
  const expectedRuntime = normalizeRuntimeArtifact(artifact, immutableBinding.values, immutableBinding.plan);
  if (!expectedRuntime) throw new Error("RUNTIME_BINDING_INCOMPLETE");
  const localRuntimeExact = Boolean(code && expectedRuntime && code === expectedRuntime);
  const proxyArtifact = loadArtifact("out/MigratableEntityProxy.sol/MigratableEntityProxy.json");
  const proxyBinding = proxyImmutableBinding();
  const expectedProxy = normalizeRuntimeArtifact(proxyArtifact, proxyBinding.values, proxyBinding.plan);
  const proxyRuntimeExact = Boolean(proxyCode && expectedProxy && proxyCode === expectedProxy);
  if (!expectedProxy || !proxyRuntimeExact) throw new Error("PROXY_RUNTIME_INCOMPLETE");
  let factoryGetter = null;
  if (localRuntimeExact) {
    try { [factoryGetter] = await callDecoded(selected, implementation, vaultInterface, "FACTORY", [], pin, context); }
    catch (_) { factoryGetter = null; }
  }
  let config = null;
  if (localRuntimeExact) try {
    const [asset] = await callDecoded(selected, entity, vaultInterface, "asset", [], pin, context);
    const [decimals] = await callDecoded(selected, safeAddress(asset), erc20Interface, "decimals", [], pin, context);
    const [totalSupply] = await callDecoded(selected, entity, vaultInterface, "totalSupply", [], pin, context);
    const [totalAssets] = await callDecoded(selected, entity, vaultInterface, "totalAssets", [], pin, context);
    const [freeAssets] = await callDecoded(selected, entity, vaultInterface, "freeAssets", [], pin, context);
    const [withdrawable] = await callDecoded(selected, entity, vaultInterface, "withdrawable", [], pin, context);
    const [redeemable] = await callDecoded(selected, entity, vaultInterface, "redeemable", [], pin, context);
    const [queue] = await callDecoded(selected, entity, vaultInterface, "withdrawalQueue", [], pin, context);
    const [delegator] = await callDecoded(selected, entity, vaultInterface, "delegator", [], pin, context);
    const feePreview = await callDecoded(selected, entity, vaultInterface, "getAccrueInterest", [], pin, context);
    const [depositWhitelist] = await callDecoded(selected, entity, vaultInterface, "depositWhitelist", [], pin, context);
    const [isDepositLimit] = await callDecoded(selected, entity, vaultInterface, "isDepositLimit", [], pin, context);
    const [depositLimit] = await callDecoded(selected, entity, vaultInterface, "depositLimit", [], pin, context);
    const [owner] = await callDecoded(selected, entity, vaultInterface, "owner", [], pin, context);
    const [entityFactory] = await callDecoded(selected, entity, vaultInterface, "FACTORY", [], pin, context);
    const queueAddress = safeAddress(queue);
    const delegatorAddress = safeAddress(delegator);
    const assetAddress = safeAddress(asset);
    const ownerAddress = safeAddress(owner);
    const [queueVault] = await callDecoded(selected, queueAddress, queueInterface, "vault", [], pin, context);
    const [queueFactory] = await callDecoded(selected, queueAddress, queueInterface, "FACTORY", [], pin, context);
    config = {
      assetAddress,
      decimals: Number(decimals),
      totalSupply,
      totalAssets,
      freeAssets,
      withdrawable,
      redeemable,
      queueAddress,
      delegatorAddress,
      ownerAddress,
      entityFactory: safeAddress(entityFactory),
      queueFactory: safeAddress(queueFactory),
      queueVault: safeAddress(queueVault),
      feePreview: { totalAssets: feePreview[0], managementShares: feePreview[1], performanceShares: feePreview[2],
        protocolShares: feePreview[3] },
      depositWhitelist,
      isDepositLimit,
      depositLimit,
      standardTokenSemantics: null,
      requiredReadsComplete: Boolean(assetAddress && queueAddress && delegatorAddress && ownerAddress &&
        safeAddress(entityFactory) && safeAddress(queueFactory) && safeAddress(queueVault))
    };
  } catch (_) {
    config = null;
  }
  const classification = classifyRuntime({
    dualFamilyAgreement: true,
    proxySlotBound: Boolean(implementation),
    proxyRuntimeExact,
    versionBound: version > 0n,
    versionImplementationMatchesSlot: versionMatches,
    currentImplementationCodeBound: Boolean(code && code !== "0x"),
    localRuntimeExact,
    canonicalDependencyRuntimesExact: dependencyRuntimes.exact,
    immutableDependenciesReconstructed: expectedRuntime !== null,
    factoryGetterMatches: localRuntimeExact ? (factoryGetter === null ? null :
      safeAddress(factoryGetter) === CANONICAL.VaultFactory) : true,
    requiredReadsComplete: localRuntimeExact ? (config ? config.requiredReadsComplete : null) : true,
    selectorClosure: localRuntimeExact ? (config ? config.entityFactory === CANONICAL.VaultFactory &&
      config.queueFactory === CANONICAL.WithdrawalQueueFactory && config.queueVault === entity : null) : true,
    immutableGetterAgreement: localRuntimeExact ? safeAddress(factoryGetter) === CANONICAL.VaultFactory : true,
    migrationHistoryComplete: lifecycle.complete ? (!localRuntimeExact ? true :
      (lifecycle.noSuccessfulMigrateIntoOrDuringV2 ? (lifecycle.vaultV2InitializeAtCreation ? true : null) : false)) : null
  });
  const conclusiveNonV2 = classification.exactVaultV2 === false && Boolean(implementation) && proxyRuntimeExact &&
    version > 0n && versionMatches && Boolean(code && code !== "0x") && expectedRuntime !== null &&
    localRuntimeExact === false && dependencyRuntimes.exact === true && lifecycle.complete === true;
  return { implementation, version, classification, conclusiveNonV2, config, lifecycle,
    completeness: { implementationAddress: Boolean(implementation), proxyRuntimeExact,
      implementationCodeCanonicalNonempty: Boolean(code && code !== "0x"), runtimeComparisonComplete: expectedRuntime !== null,
      lifecycleComplete: lifecycle.complete === true, versionImplementationBound: version > 0n && versionMatches } };
}

async function captureEntityHistory(selected, pin, entity, exactV2Interval, config, context) {
  if (!exactV2Interval) throw new Error("EXACT_V2_INTERVAL_UNPROVEN");
  const creationBlock = exactV2Interval.fromBlock;
  const rawVaultLogs = await scanLogs(selected, { address: entity, topics: [[TOPICS.deposit, TOPICS.transfer]] },
    exactV2Interval.fromBlock, exactV2Interval.toBlock, context);
  const expected = new Set([entity]);
  const validated = rawVaultLogs.map((row) => validateLog(row, expected, creationBlock, pin));
  if (validated.some((row) => row === null)) throw new Error("MALFORMED_VAULT_HISTORY");
  const deduped = dedupeLogs(validated);
  if (!deduped.ok) throw new Error("CONFLICTING_VAULT_HISTORY");
  await validateCanonicalLogBlocks(selected, deduped.logs, context);
  const deposits = [];
  const transfers = [];
  for (const row of deduped.logs) {
    if (row.topics[0] === TOPICS.deposit) {
      if (row.topics.length !== 3) throw new Error("MALFORMED_DEPOSIT_EVENT");
      const [assets, shares] = abi.decode(["uint256", "uint256"], row.data);
      deposits.push({ type: "deposit", assets, shares, vault: entity, blockNumber: row.blockNumber,
        transactionIndex: row.transactionIndex, logIndex: row.logIndex, transactionHash: row.transactionHash, evidence: null });
    } else if (row.topics[0] === TOPICS.transfer) {
      if (row.topics.length !== 3) throw new Error("MALFORMED_TRANSFER_EVENT");
      const [value] = abi.decode(["uint256"], row.data);
      transfers.push({ type: "transfer", from: topicAddress(row.topics[1]), to: topicAddress(row.topics[2]), value,
        blockNumber: row.blockNumber, transactionIndex: row.transactionIndex, logIndex: row.logIndex });
    }
  }
  let inboundTransfers = [];
  let donationCandidates = 0;
  if (config && config.assetAddress) {
    const inbound = await scanLogs(selected, { address: config.assetAddress,
      topics: [TOPICS.transfer, null, zeroPadValue(entity, 32)] }, creationBlock, pin, context);
    const assetExpected = new Set([config.assetAddress]);
    const validatedAsset = inbound.map((raw) => validateLog(raw, assetExpected, creationBlock, pin));
    if (validatedAsset.some((row) => row === null)) throw new Error("MALFORMED_ASSET_TRANSFER_HISTORY");
    const dedupedAsset = dedupeLogs(validatedAsset);
    if (!dedupedAsset.ok) throw new Error("CONFLICTING_ASSET_TRANSFER_HISTORY");
    await validateCanonicalLogBlocks(selected, dedupedAsset.logs, context);
    inboundTransfers = dedupedAsset.logs.map((row) => {
      if (row.topics[0] !== TOPICS.transfer || row.topics.length !== 3) throw new Error("MALFORMED_ASSET_TRANSFER_EVENT");
      const [value] = abi.decode(["uint256"], row.data);
      return { from: topicAddress(row.topics[1]), to: topicAddress(row.topics[2]), value,
        transactionHash: row.transactionHash, logIndex: row.logIndex };
    });
    for (const row of inboundTransfers) {
      const matchedDeposit = deposits.some((deposit) => deposit.transactionHash === row.transactionHash &&
        row.logIndex < deposit.logIndex && row.value === deposit.assets);
      const knownInternalMovement = row.from === config.queueAddress || row.from === config.delegatorAddress;
      const candidate = classifyDonationCandidate({ transferToVault: true, matchedDeposit, knownInternalMovement,
        historyComplete: true, transactionOrderingComplete: true, traceAvailable: false });
      if (candidate.candidate) donationCandidates += 1;
    }
  }
  for (const deposit of deposits) {
    deposit.evidence = classifyZeroShareDepositEvidence(deposit, inboundTransfers, config?.standardTokenSemantics);
  }
  const zero = aggregateZeroShareDeposits(deposits, true);
  let shares = replayShareTransfers(transfers, true);
  if (shares.complete) {
    const pendingFeeShares = config.feePreview.managementShares + config.feePreview.performanceShares +
      config.feePreview.protocolShares;
    shares = reconcileStoredShareSupply(shares, config.totalSupply, pendingFeeShares);
  }
  let queueContext = { requestCount: 0, fillCount: 0, claimCount: 0 };
  if (config && config.queueAddress) {
    const queueLogs = await scanLogs(selected, { address: config.queueAddress,
      topics: [[TOPICS.requestRedeem, TOPICS.fill, TOPICS.claim]] }, creationBlock, pin, context);
    const validatedQueue = queueLogs.map((row) => validateLog(row, new Set([config.queueAddress]), creationBlock, pin));
    if (validatedQueue.some((row) => row === null)) throw new Error("MALFORMED_QUEUE_HISTORY");
    const dedupedQueue = dedupeLogs(validatedQueue);
    if (!dedupedQueue.ok) throw new Error("CONFLICTING_QUEUE_HISTORY");
    await validateCanonicalLogBlocks(selected, dedupedQueue.logs, context);
    queueContext = {
      requestCount: dedupedQueue.logs.filter((row) => row.topics[0] === TOPICS.requestRedeem).length,
      fillCount: dedupedQueue.logs.filter((row) => row.topics[0] === TOPICS.fill).length,
      claimCount: dedupedQueue.logs.filter((row) => row.topics[0] === TOPICS.claim).length
    };
  }
  return { zero, shares, donationCandidates, queueContext,
    storedSupplyReconciled: shares.complete === true && typeof shares.pendingFeeShares === "bigint" };
}

function assertFactoryCaptureComplete(factory) {
  if (!factory || !Array.isArray(factory.entities) || !Array.isArray(factory.versions) ||
    !Array.isArray(factory.addEntities) || !factory.versionHistory || factory.versionHistory.complete !== true) {
    throw new Error("ENTITY_MALFORMED_INCOMPLETE");
  }
  const entities = factory.entities.map(safeAddress);
  if (entities.some((entity) => !entity) || new Set(entities).size !== entities.length ||
    entities.some((entity) => !factory.addEntities.some((row) => row && row.entity === entity))) {
    throw new Error("ENTITY_MALFORMED_INCOMPLETE");
  }
  return true;
}

function assertEntityCaptureComplete(current, history) {
  if (!current || !current.completeness || current.completeness.implementationAddress !== true ||
    current.completeness.implementationCodeCanonicalNonempty !== true ||
    current.completeness.versionImplementationBound !== true) throw new Error("ENTITY_MALFORMED_INCOMPLETE");
  if (current.completeness.proxyRuntimeExact !== true) throw new Error("PROXY_RUNTIME_INCOMPLETE");
  if (current.completeness.lifecycleComplete !== true || current.lifecycle?.complete !== true) {
    throw new Error("ENTITY_LIFECYCLE_INCOMPLETE");
  }
  if (current.completeness.runtimeComparisonComplete !== true ||
    current.classification?.exactVaultV2 === null || current.classification?.exactVaultV2 === undefined) {
    throw new Error("RUNTIME_BINDING_INCOMPLETE");
  }
  if (current.classification.exactVaultV2 === false) {
    if (current.conclusiveNonV2 !== true) throw new Error("RUNTIME_BINDING_INCOMPLETE");
    if (history !== null) throw new Error("HISTORY_INCOMPLETE");
    return "CONCLUSIVE_NON_V2";
  }
  if (current.classification.exactVaultV2 !== true) throw new Error("RUNTIME_BINDING_INCOMPLETE");
  if (!current.config || current.config.requiredReadsComplete !== true) throw new Error("CONFIG_READ_INCOMPLETE");
  if (!history || history.zero?.complete !== true || history.shares?.complete !== true) throw new Error("HISTORY_INCOMPLETE");
  if (history.storedSupplyReconciled !== true || typeof history.shares.currentSupply !== "bigint" ||
    typeof history.shares.currentHolderCount !== "number") throw new Error("STORED_SUPPLY_INCOMPLETE");
  return "EXACT_V2_COMPLETE";
}

function aggregateCaptureRows(rows) {
  const exactRows = rows.filter((row) => row.current.classification.exactVaultV2 === true);
  const historyRows = exactRows.filter((row) => row.history !== null);
  const exactRuntimeComplete = rows.every((row) => row.current.classification.exactVaultV2 !== null);
  const historyComplete = exactRows.every((row) => row.history !== null && row.history.zero.complete && row.history.shares.complete);
  const eligibleRows = historyRows.filter((row) => {
    const config = row.current.config;
    const shares = row.history.shares;
    if (!config || !shares.complete) return false;
    const decimals = config.decimals >= 18;
    const unrestricted = !config.depositWhitelist && !config.isDepositLimit;
    const feeState = config.feePreview.managementShares === 0n && config.feePreview.performanceShares === 0n &&
      config.feePreview.protocolShares === 0n;
    const zero = shares.currentSupply === 0n;
    const sole = shares.currentHolderCount === 1;
    const restart = zero && config.totalAssets > 0n;
    return decimals && unrestricted && feeState && (zero || sole || restart);
  });
  const historicalNominalCount = historyRows.reduce((sum, row) => sum + row.history.zero.nominalCount, 0);
  const historicalActualCountsKnown = historyRows.every((row) => row.history.zero.actualLossCount !== null);
  const historicalActualCount = historicalActualCountsKnown ?
    historyRows.reduce((sum, row) => sum + row.history.zero.actualLossCount, 0) : null;
  const historicalNominalAssets = historyRows.reduce((sum, row) => sum + row.history.zero.nominalAssetMagnitude, 0n);
  const donationCandidateCount = historyRows.reduce((sum, row) => sum + row.history.donationCandidates, 0);
  const queue = historyRows.reduce((sum, row) => ({
    requestCount: sum.requestCount + row.history.queueContext.requestCount,
    fillCount: sum.fillCount + row.history.queueContext.fillCount,
    claimCount: sum.claimCount + row.history.queueContext.claimCount
  }), { requestCount: 0, fillCount: 0, claimCount: 0 });
  return {
    coverage: { entityCountBucket: countBucket(rows.length), exactVaultV2CountBucket: countBucket(exactRows.length),
      legacyOrOtherCountBucket: countBucket(rows.length - exactRows.length),
      exactRuntimeComplete, historyComplete },
    currentConjunctiveEligibility: { eligibleVaultCountBucket: historyComplete ? countBucket(eligibleRows.length) : null,
      requiresSameVaultRuntimeDecimalsUnrestrictedFeeAndState: true, standardTokenSemantics: null },
    history: { nominalZeroShareDepositCountBucket: historyComplete ? countBucket(historicalNominalCount) : null,
      nominalAssetMagnitudeBucket: historyComplete ? magnitudeBucket(historicalNominalAssets) : null,
      actualAssetLossCountBucket: historyComplete && historicalActualCount !== null ? countBucket(historicalActualCount) : null,
      donationCandidateCountBucket: historyComplete ? countBucket(donationCandidateCount) : null,
      confirmedDonationSequence: null, attackerRedemptionProfit: null, directIdentifiersPersisted: false },
    queueContext: { requestCountBucket: countBucket(queue.requestCount), fillCountBucket: countBucket(queue.fillCount),
      claimCountBucket: countBucket(queue.claimCount) },
    promotionGates: exactRuntimeComplete && historyComplete ? {
      exactSourceRuntime: exactRows.length > 0,
      affectedZeroShareSemantics: exactRows.length > 0,
      current18PlusUnrestrictedConfig: eligibleRows.length > 0,
      currentFirstSoleRestartState: eligibleRows.length > 0,
      historicalNominalZeroShareDeposits: historicalNominalCount > 0,
      historicalActualAssetLoss: historicalActualCount === null ? null : historicalActualCount > 0,
      confirmedDonationSequence: null,
      attackerRedemptionProfit: null,
      currentNetEconomics: null
    } : nullPromotionGates()
  };
}

async function performNetworkCapture(context) {
    const adapters = context.adapters || {};
    const inventory = await (adapters.loadInventory || context.inventoryLoader || loadInventoryAuthorized)();
    const qualified = await (adapters.qualifyFamilies || qualifyFamilies)(inventory, context);
    const pinned = await (adapters.selectPinnedFamilies || selectPinnedFamilies)(qualified, context);
    const dependencyRuntimes = await (adapters.captureCanonicalDependencyRuntimes || captureCanonicalDependencyRuntimes)(
      pinned.selected, pinned.selection.pin, context);
    if (!dependencyRuntimes || dependencyRuntimes.exact !== true) throw new Error("DEPENDENCY_RUNTIME_MISMATCH");
    const factory = await (adapters.captureFactory || captureFactory)(pinned.selected, pinned.selection.pin, context);
    assertFactoryCaptureComplete(factory);
    const rows = [];
    for (const entity of factory.entities) {
      context.budget.checkTime();
      const add = factory.addEntities.find((row) => row.entity === entity);
      if (!add) throw new Error("ENTITY_CREATION_BLOCK_MISSING");
      const currentVersion = adapters.readCurrentVersion ? await adapters.readCurrentVersion(pinned.selected, entity,
        pinned.selection.pin, context) : (await callDecoded(pinned.selected, entity, vaultInterface, "version", [],
          pinned.selection.pin, context))[0];
      const lifecycle = await (adapters.captureEntityLifecycle || captureEntityLifecycle)(pinned.selected,
        pinned.selection.pin, entity, add, factory.versionHistory.migrations, currentVersion, context);
      if (!lifecycle || lifecycle.complete !== true) throw new Error("ENTITY_LIFECYCLE_INCOMPLETE");
      const current = await (adapters.captureEntityCurrent || captureEntityCurrent)(pinned.selected,
        pinned.selection.pin, entity, factory.versions, currentVersion, lifecycle, dependencyRuntimes, context);
      let history = null;
      if (current?.classification?.exactVaultV2 === true) {
        history = await (adapters.captureEntityHistory || captureEntityHistory)(pinned.selected, pinned.selection.pin,
          entity, lifecycle.exactV2Interval, current.config, context);
      }
      assertEntityCaptureComplete(current, history);
      rows.push({ current, history });
    }
    const terminalHeaders = [];
    for (const endpoint of pinned.selected) {
      let header;
      if (adapters.readTerminalHeader) header = await adapters.readTerminalHeader(endpoint, pinned.selection.pin, context);
      else {
        const response = await (context.rpcRequest || rpcRequest)(endpoint, "eth_getBlockByNumber",
          [toQuantity(pinned.selection.pin), false], context);
        header = response.ok ? parseBlockHeader(response.result) : null;
      }
      if (!header) throw new Error("TERMINAL_HEADER_MISSING");
      context.budget.observeHeader(header.number);
      terminalHeaders.push({ family: endpoint.family, header });
    }
    if (!terminalPinRecheck(pinned.selection, terminalHeaders)) throw new Error("TERMINAL_PIN_MISMATCH");
    const budget = context.budget.summary();
    if (!budget.allWithinCaps) context.budget.stop("FINAL_BUDGET");
    const aggregate = aggregateCaptureRows(rows);
    if (aggregate.coverage.exactRuntimeComplete !== true || aggregate.coverage.historyComplete !== true ||
      rows.length !== factory.entities.length) throw new Error("COMPLETENESS_GATE_FAILED");
    return {
      schemaVersion: 1,
      findingId: FINDING_ID,
      status: "SANITIZED_CAPTURE_COMPLETE",
      chain: { name: "ethereum-mainnet", chainId: CHAIN_ID },
      canonicalManifest: canonicalManifestEvidence(),
      pin: { identifiersPersisted: false, familyCountBucket: countBucket(pinned.selection.familyCount),
        commonMinimumFinalized: true, terminalRechecked: true },
      ...aggregate,
      operationalGates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false },
      budget: privacyBudgetSummary(budget),
      captureAttempted: true,
      sanitized: true
    };
}

async function orchestrateApprovedCapture(options) {
  const { approval, expected, ledgerPath, outputPath, captureOperation, context, now = Date.now() } = options;
  if (fs.existsSync(outputPath)) throw new Error("CAPTURE_OUTPUT_ALREADY_EXISTS");
  const authorization = validateApprovalEnvelope(approval, { now, expected, consumed: fs.existsSync(ledgerPath) });
  consumeApprovalAtomically(authorization, ledgerPath);
  let output;
  try {
    output = await captureOperation();
    if (!output || typeof output !== "object" || Array.isArray(output) || output.status !== "SANITIZED_CAPTURE_COMPLETE" ||
      !output.promotionGates || typeof output.promotionGates !== "object") throw new Error("CAPTURE_RESULT_INVALID");
  } catch (error) {
    output = failClosedCapture(mapPostLedgerFailure(error), context.budget.summary());
    output.captureAttempted = true;
  }
  return writeSanitizedCaptureAtomically(output, outputPath);
}

async function runCapture(options = {}) {
  const packageContext = options.packageContext || packageValidationContext();
  const approvalPath = path.join(ROOT, ...FIXED_APPROVAL_REL.split("/"));
  const ledgerPath = options.ledgerPath || path.join(ROOT, ...GLOBAL_LEDGER_REL.split("/"));
  const outputPath = options.outputPath || path.join(ROOT, ...FIXED_OUTPUT_REL.split("/"));
  const approval = options.approvalLoader ? await options.approvalLoader(approvalPath) :
    JSON.parse(fs.readFileSync(approvalPath, "utf8"));
  const context = options.context || { caps: CAPS, budget: new Budget(), nextId: 0 };
  if (options.adapters) context.adapters = options.adapters;
  return orchestrateApprovedCapture({ approval, expected: packageContext.expected, ledgerPath, outputPath, context,
    now: options.now || Date.now(),
    captureOperation: () => performNetworkCapture(context) });
}

async function executeCaptureCli(argv, options = {}) {
  const args = parseArgs(argv);
  if (!args.capture) return dryPreflight();
  return runCapture(options);
}

async function main() {
  const result = await executeCaptureCli(process.argv);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write("RUNNER_FAILURE_REDACTED\n");
    process.exitCode = 1;
  });
}

module.exports = {
  ALLOWED_METHODS,
  BOUND_FILES,
  CANONICAL,
  CAPS,
  CHAIN_ID,
  DOCS_URL,
  ERC1967_IMPLEMENTATION_SLOT,
  FINDING_ID,
  FIXED_APPROVAL_REL,
  FIXED_OUTPUT_REL,
  FIXED_REASON_CODES,
  GLOBAL_LEDGER_REL,
  MANIFEST_REL,
  PROPOSAL_ID,
  PROPOSAL_REL,
  REQUESTED_APPROVAL_ID,
  SOURCE_COMMIT,
  Budget,
  aggregateCaptureRows,
  aggregateZeroShareDeposits,
  assertEntityCaptureComplete,
  assertFactoryCaptureComplete,
  buildEntityImplementationIntervals,
  captureCanonicalDependencyRuntimes,
  canonicalJson,
  canonicalLogsMatchHeaders,
  canonicalManifestEvidence,
  classifyDonationCandidate,
  classifyRuntime,
  classifyZeroShareDepositEvidence,
  commitment,
  compareAuthoritativeEntities,
  consumeApprovalAtomically,
  countBucket,
  dedupeLogs,
  dryPreflight,
  enforceNumericCap,
  exactArtifactRuntime,
  executeCaptureCli,
  failClosedCapture,
  headerFingerprint,
  loadSourceBinding,
  mapPostLedgerFailure,
  magnitudeBucket,
  normalizeRuntimeArtifact,
  nullPromotionGates,
  orchestrateApprovedCapture,
  packageValidationContext,
  performNetworkCapture,
  parseArgs,
  parseBlockHeader,
  parseInventoryText,
  parseRpcEnvelope,
  privacyBudgetSummary,
  proxyImmutableBinding,
  qualifyFamilies,
  readResponseBodyCapped,
  reconcileFactoryVersionHistory,
  reconcileStoredShareSupply,
  replayShareTransfers,
  rpcRequest,
  runCapture,
  safeAddress,
  sanitizeCapture,
  scanLogs,
  selectCommonMinimumPin,
  selectPinnedFamilies,
  strictHex,
  strictQuantity,
  terminalPinRecheck,
  topicAddress,
  toQuantity,
  validateApprovalEnvelope,
  validateCanonicalLogBlocks,
  validateLog,
  vaultImmutableBinding,
  writeSanitizedCaptureAtomically
};
