#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "fluid-contracts-public");
const OUTPUT = path.join(ROOT, "reports", "raw", "fast", "critical-fluid-vaultt2-t4-negative-max-step2-capture.json");
const PARTIAL_ARCHIVE = path.join(ROOT, "reports", "raw", "fast", "critical-fluid-vaultt2-t4-negative-max-step2-partial-r5.json");
const INVENTORIES = ["rpc_endpoints.txt", "graphql_endpoints.txt"];
const ZERO = "0x0000000000000000000000000000000000000000";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const INT_MIN = -(1n << 255n);
const CHAIN_CONFIG = Object.freeze([
  { name: "bnb", deployment: "bnb", chainId: 56, lookbackBlocks: 28800 },
  { name: "plasma", deployment: "plasma", chainId: 9745, lookbackBlocks: 86400 },
  { name: "polygon", deployment: "polygon", chainId: 137, lookbackBlocks: 43200 },
  { name: "base", deployment: "base", chainId: 8453, lookbackBlocks: 43200 },
  { name: "arbitrum", deployment: "arbitrum", chainId: 42161, lookbackBlocks: 345600 },
  { name: "ethereum", deployment: "mainnet", chainId: 1, lookbackBlocks: 7200 }
]);
const LIMITS = Object.freeze({
  endpointProbes: 180,
  endpointProbeConcurrency: 20,
  globalRpcCalls: 24000,
  chainRpcCalls: 5000,
  logQueriesPerFamily: 150,
  logsPerChain: 10000,
  transactionsPerChain: 400,
  tracesPerChain: 50,
  timeoutMs: 4000,
  retries: 0,
  initialLogSpan: 1000000,
  minimumLogSpan: 10000,
  splitLogThreshold: 3000
});

const LOG_OPERATE = new ethers.Interface([
  "event LogOperate(address user_,uint256 nftId_,int256 colAmt_,int256 debtAmt_,address to_)"
]);
const DEX_DEPOSIT = new ethers.Interface([
  "event LogDepositPerfectColLiquidity(uint256 shares,uint256 token0Amt,uint256 token1Amt)"
]);
const ERC20 = new ethers.Interface(["function decimals() view returns (uint8)"]);
const FACTORY_NFT = new ethers.Interface([
  "function ownerOf(uint256) view returns (address)",
  "function getApproved(uint256) view returns (address)",
  "function isApprovedForAll(address,address) view returns (bool)"
]);

class SafeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

function canonical(value) {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeCode(error) {
  if (error instanceof SafeFailure) return error.code;
  return "SANITIZED_FAILURE";
}

function parseInventories() {
  const records = [];
  const seen = new Set();
  const files = {};
  for (const file of INVENTORIES) {
    const full = path.join(ROOT, file);
    files[file === "rpc_endpoints.txt" ? "rpc" : "graphql"] = { available: fs.existsSync(full), candidates: 0 };
    if (!fs.existsSync(full)) continue;
    const lines = fs.readFileSync(full, "utf8").replace(/\\\//g, "/").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const match of lines[i].matchAll(/https?:\/\/[^\s"'`<>{}\[\]]+/giu)) {
        const candidate = match[0].replace(/[)>`,.;\]]+$/gu, "");
        let parsed;
        try { parsed = new URL(candidate); } catch { continue; }
        if (seen.has(parsed.href)) continue;
        seen.add(parsed.href);
        const context = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join("\n");
        const origin = context.match(/\[origin:\s*([^\]\s]+)\]/iu)?.[1] || null;
        const headers = {};
        for (const header of context.matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/giu)) {
          headers[header[1].trim()] = header[2].trim();
        }
        records.push({ url: parsed.href, family: parsed.hostname.toLowerCase(), origin, headers, source: file });
        files[file === "rpc_endpoints.txt" ? "rpc" : "graphql"].candidates++;
      }
    }
  }
  return { records, files };
}

function makeBudget() {
  return {
    global: { max: LIMITS.globalRpcCalls, attempted: 0, succeeded: 0, failed: 0, byMethod: {} },
    chains: Object.fromEntries(CHAIN_CONFIG.map(chain => [chain.name, {
      max: LIMITS.chainRpcCalls,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      byMethod: {}
    }]))
  };
}

function debitBudget(budget, chainName, method) {
  const global = budget.global;
  const chain = chainName ? budget.chains[chainName] : null;
  if (global.attempted >= global.max) throw new SafeFailure("GLOBAL_RPC_BUDGET_EXCEEDED");
  if (chain && chain.attempted >= chain.max) throw new SafeFailure("CHAIN_RPC_BUDGET_EXCEEDED");
  global.attempted++;
  global.byMethod[method] = (global.byMethod[method] || 0) + 1;
  if (chain) {
    chain.attempted++;
    chain.byMethod[method] = (chain.byMethod[method] || 0) + 1;
  }
}

function markBudget(budget, chainName, success) {
  const global = budget.global;
  const chain = chainName ? budget.chains[chainName] : null;
  global[success ? "succeeded" : "failed"]++;
  if (chain) chain[success ? "succeeded" : "failed"]++;
}

async function rpc(record, method, params, budget, chainName = null) {
  let last = "RPC_CALL_FAILED";
  for (let attempt = 0; attempt <= LIMITS.retries; attempt++) {
    debitBudget(budget, chainName, method);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIMITS.timeoutMs);
    const headers = { "content-type": "application/json", ...record.headers };
    if (record.origin) headers.origin = record.origin;
    try {
      const response = await fetch(record.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: budget.global.attempted, method, params }),
        signal: controller.signal
      });
      if (!response.ok) throw new SafeFailure("RPC_HTTP_FAILURE");
      const body = await response.json();
      if (body?.error || body?.result === undefined || body?.result === null) throw new SafeFailure("RPC_RESULT_FAILURE");
      markBudget(budget, chainName, true);
      return body.result;
    } catch (error) {
      last = safeCode(error);
      markBudget(budget, chainName, false);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SafeFailure(last);
}

function comparable(method, value) {
  if (method === "eth_getStorageAt") return ethers.zeroPadValue(value, 32).toLowerCase();
  if (typeof value === "string") return value.toLowerCase();
  return canonical(value);
}

async function observe(providers, method, params, budget, chainName, counters) {
  const successes = [];
  for (const provider of providers) {
    try { successes.push(await rpc(provider, method, params, budget, chainName)); }
    catch {}
  }
  counters.queries++;
  if (!successes.length) {
    counters.nulls++;
    return { value: null, familiesObserved: 0, agreement: null };
  }
  const first = comparable(method, successes[0]);
  const agreement = successes.length > 1 ? successes.every(value => comparable(method, value) === first) : null;
  if (agreement === false) {
    counters.mismatches++;
    return { value: null, familiesObserved: successes.length, agreement: false };
  }
  if (agreement === true) counters.twoFamilyAgreements++;
  else counters.singleFamilyObservations++;
  return { value: successes[0], familiesObserved: successes.length, agreement };
}

async function contractCall(providers, target, iface, fn, args, blockTag, budget, chainName, counters) {
  const data = iface.encodeFunctionData(fn, args);
  const observation = await observe(providers, "eth_call", [{ to: target, data }, blockTag], budget, chainName, counters);
  if (observation.value === null) return { decoded: null, ...observation };
  try { return { decoded: iface.decodeFunctionResult(fn, observation.value), ...observation }; }
  catch { return { decoded: null, familiesObserved: observation.familiesObserved, agreement: observation.agreement }; }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readHeadAddress(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(16384);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const match = buffer.subarray(0, bytes).toString("utf8").match(/"address"\s*:\s*"(0x[0-9a-fA-F]{40})"/u);
    return match ? match[1].toLowerCase() : null;
  } finally { fs.closeSync(fd); }
}

function localChain(chain) {
  const dir = path.join(TARGET, "deployments", chain.deployment);
  const files = fs.readdirSync(dir).filter(file => file.endsWith(".json") && fs.statSync(path.join(dir, file)).isFile());
  const mainVaultFiles = files.filter(file => /^VaultT[24]_.*\.json$/u.test(file) && !file.endsWith("_Operate.json"));
  const localVaults = new Map();
  for (const file of mainVaultFiles) {
    const artifact = readJson(path.join(dir, file));
    if (!artifact.address) continue;
    localVaults.set(artifact.address.toLowerCase(), {
      type: file.startsWith("VaultT2_") ? 2 : 4,
      nativeToken1: String(artifact.args?.[0]?.supplyToken?.token1 || "").toLowerCase() === NATIVE,
      transactionHash: artifact.transactionHash || null
    });
  }
  const knownAddresses = new Set();
  const dexAddresses = new Set();
  for (const file of files) {
    const address = readHeadAddress(path.join(dir, file));
    if (!address) continue;
    knownAddresses.add(address);
    if (/^Dex_/u.test(file) && !/(Admin|Auth|Resolver|Factory|Module|Implementation|Logic)/u.test(file)) dexAddresses.add(address);
  }
  const load = name => readJson(path.join(dir, `${name}.json`));
  const factory = load("VaultFactory");
  const factoryBoundary = Number(factory.receipt?.blockNumber || 0) || null;
  return {
    dir,
    localVaults,
    knownAddresses,
    dexAddresses,
    factoryAddress: factory.address,
    factoryBoundary,
    resolver: load("VaultResolver"),
    liquidity: load("Liquidity"),
    liquidityResolver: load("LiquidityResolver"),
    dexResolver: load("DexResolver"),
    t2Artifact: readJson(path.join(dir, mainVaultFiles.find(file => file.startsWith("VaultT2_")))),
    t4Artifact: readJson(path.join(dir, mainVaultFiles.find(file => file.startsWith("VaultT4_"))))
  };
}

function flattenImmutableReferences(artifact) {
  return Object.values(artifact.deployedBytecode.immutableReferences || {}).flat();
}

function hexBytes(hex) {
  return String(hex).replace(/^0x/u, "").toLowerCase();
}

function maskImmutables(code, references) {
  const chars = hexBytes(code).split("");
  for (const ref of references) {
    const start = Number(ref.start) * 2;
    const length = Number(ref.length) * 2;
    if (start + length > chars.length) return null;
    for (let i = start; i < start + length; i++) chars[i] = "0";
  }
  return chars.join("");
}

function stripSolidityMetadata(code) {
  if (!code || code.length < 4) return code;
  const bytes = Number.parseInt(code.slice(-4), 16);
  const removeChars = (bytes + 2) * 2;
  return removeChars > code.length ? code : code.slice(0, -removeChars);
}

function loadRuntimeTemplates() {
  const rows = {};
  for (const type of [2, 4]) {
    rows[type] = {};
    for (const revision of ["vulnerable", "patched"]) {
      const base = revision === "vulnerable" ? "fluid-vaultt2-t4-r2-vulnerable" : "fluid-vaultt2-t4-r2";
      const file = path.join(ROOT, "remediations", base, "out", "mainOperate.sol", `FluidVaultT${type}Operate.json`);
      const artifact = readJson(file);
      const references = flattenImmutableReferences(artifact);
      const masked = maskImmutables(artifact.deployedBytecode.object, references);
      const body = stripSolidityMetadata(masked);
      rows[type][revision] = {
        file: path.relative(ROOT, file).replace(/\\/gu, "/"),
        fileSha256: fileSha256(file),
        references,
        runtimeBytes: hexBytes(artifact.deployedBytecode.object).length / 2,
        logicalBodySha256: sha256(Buffer.from(body, "hex")),
        body
      };
    }
    if (rows[type].vulnerable.logicalBodySha256 === rows[type].patched.logicalBodySha256) {
      throw new SafeFailure(`T${type}_RUNTIME_TEMPLATES_NOT_DISTINCT`);
    }
  }
  return rows;
}

function classifyRuntime(code, type, templates) {
  if (!/^0x[0-9a-fA-F]+$/u.test(code || "")) return { classification: "unknown", logicalBodySha256: null, method: "none" };
  const source = templates[type];
  for (const revision of ["vulnerable", "patched"]) {
    const template = source[revision];
    if (hexBytes(code).length / 2 !== template.runtimeBytes) continue;
    const masked = maskImmutables(code, template.references);
    const body = stripSolidityMetadata(masked);
    if (body === template.body) return {
      classification: `${revision}-shaped`,
      logicalBodySha256: template.logicalBodySha256,
      method: "exact-masked-logical-body"
    };
  }
  const body = stripSolidityMetadata(hexBytes(code));
  const vulnerableMatches = body.match(/(?:5f|6000)80(?:5f|6000)8413158061[0-9a-f]{4}5750(?:5f|6000)8413155b15/gu) || [];
  const patchedMatches = body.match(/(?:5f|6000)80(?:5f|6000)8413158061[0-9a-f]{4}5750(?:5f|6000)8313155b15/gu) || [];
  if (vulnerableMatches.length === 1 && patchedMatches.length === 0) return {
    classification: "vulnerable-shaped",
    logicalBodySha256: source.vulnerable.logicalBodySha256,
    method: "unique-duplicated-token0-predicate-bytecode-signature"
  };
  if (patchedMatches.length === 1 && vulnerableMatches.length === 0) return {
    classification: "patched-shaped",
    logicalBodySha256: source.patched.logicalBodySha256,
    method: "unique-token0-token1-predicate-bytecode-signature"
  };
  return {
    classification: "unknown",
    logicalBodySha256: sha256(Buffer.from(body, "hex")),
    method: "unmatched"
  };
}

async function qualifyEndpoints(inventory, budget) {
  const grouped = new Map(CHAIN_CONFIG.map(chain => [chain.chainId, []]));
  const familyByChain = new Map(CHAIN_CONFIG.map(chain => [chain.chainId, new Set()]));
  let probed = 0;
  const candidates = inventory.records.slice(0, LIMITS.endpointProbes);
  for (let offset = 0; offset < candidates.length; offset += LIMITS.endpointProbeConcurrency) {
    const batch = candidates.slice(offset, offset + LIMITS.endpointProbeConcurrency);
    const observations = await Promise.all(batch.map(async record => {
      try { return { record, result: await rpc(record, "eth_chainId", [], budget, null) }; }
      catch { return { record, result: null }; }
    }));
    probed += batch.length;
    for (const { record, result } of observations) {
      if (result === null) continue;
      let chainId;
      try { chainId = Number(BigInt(result)); } catch { continue; }
      if (!grouped.has(chainId) || familyByChain.get(chainId).has(record.family)) continue;
      familyByChain.get(chainId).add(record.family);
      grouped.get(chainId).push(record);
    }
    if (CHAIN_CONFIG.every(chain => grouped.get(chain.chainId).length >= 2)) break;
  }
  return { grouped, probed };
}

async function selectPin(chain, candidates, budget) {
  const selected = [];
  const families = new Set();
  for (const candidate of candidates) {
    if (selected.length >= 2) break;
    if (families.has(candidate.family)) continue;
    try {
      const finalized = await rpc(candidate, "eth_getBlockByNumber", ["finalized", false], budget, chain.name);
      if (!/^0x[0-9a-fA-F]{64}$/u.test(finalized?.hash || "") || !finalized?.number) continue;
      selected.push({ ...candidate, finalized });
      families.add(candidate.family);
    } catch {}
  }
  if (!selected.length) return { providers: [], pin: null, error: "FINALIZED_PROVIDER_UNAVAILABLE" };
  const pinNumber = selected.map(row => BigInt(row.finalized.number)).reduce((a, b) => a < b ? a : b);
  const blockTag = ethers.toQuantity(pinNumber);
  const headers = [];
  for (const provider of selected) {
    try { headers.push(await rpc(provider, "eth_getBlockByNumber", [blockTag, false], budget, chain.name)); }
    catch {}
  }
  if (!headers.length) return { providers: selected, pin: null, error: "PIN_HEADER_UNAVAILABLE" };
  const exact = headers.map(header => `${String(header.number).toLowerCase()}:${String(header.hash).toLowerCase()}`);
  if (new Set(exact).size !== 1) return { providers: selected, pin: null, error: "PIN_HEADER_MISMATCH" };
  const header = headers[0];
  return {
    providers: selected,
    pin: {
      finalized: true,
      number: pinNumber.toString(),
      hash: header.hash,
      timestamp: header.timestamp ? BigInt(header.timestamp).toString() : null,
      familiesObserved: headers.length,
      exactNumberHashAgreement: headers.length > 1 ? true : null,
      backendIndependenceClaimed: false,
      terminalRecheck: null
    },
    blockTag,
    error: null
  };
}

async function collectLogs(provider, addresses, topic, fromBlock, toBlock, budget, chainName) {
  const logs = [];
  let queries = 0;
  let complete = true;
  let stoppedReason = null;
  let failedMinimumRanges = 0;
  const queue = [];
  for (let start = fromBlock; start <= toBlock; start += LIMITS.initialLogSpan) {
    queue.push([start, Math.min(toBlock, start + LIMITS.initialLogSpan - 1)]);
  }
  while (queue.length) {
    if (queries >= LIMITS.logQueriesPerFamily) { complete = false; stoppedReason = "LOG_QUERY_BUDGET"; break; }
    if (logs.length >= LIMITS.logsPerChain) { complete = false; stoppedReason = "LOG_COUNT_BUDGET"; break; }
    const [start, end] = queue.shift();
    queries++;
    let result;
    try {
      result = await rpc(provider, "eth_getLogs", [{
        address: addresses,
        topics: [topic],
        fromBlock: ethers.toQuantity(start),
        toBlock: ethers.toQuantity(end)
      }], budget, chainName);
    } catch {
      if (end - start + 1 > LIMITS.minimumLogSpan) {
        const middle = Math.floor((start + end) / 2);
        queue.unshift([middle + 1, end]);
        queue.unshift([start, middle]);
        continue;
      }
      complete = false;
      stoppedReason = "MINIMUM_RANGE_LOG_FAILURE";
      failedMinimumRanges++;
      continue;
    }
    if (result.length > LIMITS.splitLogThreshold && end - start + 1 > LIMITS.minimumLogSpan) {
      const middle = Math.floor((start + end) / 2);
      queue.unshift([middle + 1, end]);
      queue.unshift([start, middle]);
      continue;
    }
    logs.push(...result);
  }
  const unique = new Map();
  for (const log of logs) unique.set(`${log.transactionHash}:${log.logIndex}`, log);
  const ordered = [...unique.values()].sort((a, b) => {
    const block = Number(BigInt(a.blockNumber) - BigInt(b.blockNumber));
    return block || Number(BigInt(a.logIndex) - BigInt(b.logIndex));
  });
  return { logs: ordered.slice(0, LIMITS.logsPerChain), queries, complete, stoppedReason, failedMinimumRanges };
}

function logCommitment(logs) {
  return sha256(Buffer.from(logs.map(log => canonical({
    blockNumber: String(log.blockNumber).toLowerCase(),
    transactionHash: String(log.transactionHash).toLowerCase(),
    logIndex: String(log.logIndex).toLowerCase(),
    address: String(log.address).toLowerCase(),
    topics: (log.topics || []).map(value => String(value).toLowerCase()),
    data: String(log.data).toLowerCase()
  })).join("\n"), "utf8"));
}

function findCallsInDebug(node, vaultSet, out = []) {
  if (!node || typeof node !== "object") return out;
  const to = String(node.to || "").toLowerCase();
  if (vaultSet.has(to) && typeof node.input === "string") {
    out.push({ to, from: String(node.from || "").toLowerCase(), input: node.input, value: node.value || "0x0" });
  }
  for (const child of node.calls || []) findCallsInDebug(child, vaultSet, out);
  return out;
}

function findCallsInParity(rows, vaultSet) {
  const out = [];
  for (const row of rows || []) {
    const to = String(row?.action?.to || "").toLowerCase();
    if (vaultSet.has(to) && typeof row?.action?.input === "string") {
      out.push({
        to,
        from: String(row.action.from || "").toLowerCase(),
        input: row.action.input,
        value: row.action.value || "0x0"
      });
    }
  }
  return out;
}

async function traceCalls(provider, txHash, vaultSet, budget, chainName) {
  try {
    const trace = await rpc(provider, "debug_traceTransaction", [txHash, { tracer: "callTracer", timeout: "10s" }], budget, chainName);
    return { calls: findCallsInDebug(trace, vaultSet), method: "debug_traceTransaction" };
  } catch {}
  try {
    const trace = await rpc(provider, "trace_transaction", [txHash], budget, chainName);
    return { calls: findCallsInParity(trace, vaultSet), method: "trace_transaction" };
  } catch {}
  return { calls: [], method: null };
}

function decodeCall(call, vaultFacts) {
  const fact = vaultFacts.get(call.to);
  if (!fact) return null;
  try {
    const parsed = fact.iface.parseTransaction({ data: call.input, value: BigInt(call.value || 0) });
    if (!parsed) return null;
    if (parsed.name === "operatePerfect") {
      return {
        kind: "operatePerfect",
        type: fact.type,
        nftId: BigInt(parsed.args[0]),
        perfectColShares: BigInt(parsed.args[1]),
        token0MinMax: BigInt(parsed.args[2]),
        token1MinMax: BigInt(parsed.args[3]),
        from: call.from,
        input: call.input,
        value: call.value || "0x0",
        vault: call.to
      };
    }
    if (parsed.name === "operate") return { kind: "operate", type: fact.type, from: call.from, vault: call.to };
    return { kind: "other", type: fact.type, from: call.from, vault: call.to };
  } catch { return null; }
}

function newHistoryAggregate() {
  return {
    eventCount: 0,
    uniqueTransactions: 0,
    transactionsFetched: 0,
    directTransactions: 0,
    indirectTransactions: 0,
    traceTransactionsAttempted: 0,
    traceTransactionsResolved: 0,
    decodedOperatePerfect: 0,
    decodedOperate: 0,
    unresolvedEventCalls: 0,
    perfectDeposits: {
      negative: 0,
      zero: 0,
      positive: 0,
      minusOne: 0,
      int256Min: 0,
      otherNegative: 0,
      erc20Negative: 0,
      nativeNegative: 0
    },
    callerCategories: {
      directEoa: 0,
      contractIntegration: 0,
      knownLocalIntegrationContract: 0,
      unresolved: 0
    },
    negativeCallerAuthority: {
      newPositionCustodialContract: 0,
      nftOwner: 0,
      approvedOperator: 0,
      unapprovedThirdPartyDepositor: 0,
      unresolved: 0
    },
    negativeActualSpend: {
      callsWithExactDexEventToken1: 0,
      callsAmbiguousOrUnavailable: 0,
      heterogeneousTokenRawTotal: null
    },
    exactPreCallReplays: 0,
    exactPreCallReplayMatchesActual: 0,
    exactOverspendObservations: 0,
    overspendRaw: null,
    overspendReason: "A negative sentinel declares no positive quote; no earlier transaction-bound quote is inferred."
  };
}

async function classifyNegativeAuthority(decoded, fact, blockNumber, providers, local, budget, chainName, counters) {
  if (decoded.nftId === 0n) return decoded.from && local.knownAddresses.has(decoded.from)
    ? "newPositionCustodialContract"
    : "unresolved";
  const blockTag = ethers.toQuantity(BigInt(blockNumber) - 1n);
  const owner = await contractCall(providers, local.factoryAddress, FACTORY_NFT, "ownerOf", [decoded.nftId], blockTag, budget, chainName, counters);
  if (!owner.decoded) return "unresolved";
  const ownerAddress = String(owner.decoded[0]).toLowerCase();
  if (ownerAddress === decoded.from) return "nftOwner";
  const approved = await contractCall(providers, local.factoryAddress, FACTORY_NFT, "getApproved", [decoded.nftId], blockTag, budget, chainName, counters);
  const all = await contractCall(providers, local.factoryAddress, FACTORY_NFT, "isApprovedForAll", [ownerAddress, decoded.from], blockTag, budget, chainName, counters);
  if (!approved.decoded || !all.decoded) return "unresolved";
  if (String(approved.decoded[0]).toLowerCase() === decoded.from || Boolean(all.decoded[0])) return "approvedOperator";
  return "unapprovedThirdPartyDepositor";
}

async function analyzeNegativeSpend(decoded, tx, fact, provider, providers, local, budget, chainName, counters, aggregate) {
  let receipt;
  try { receipt = await rpc(provider, "eth_getTransactionReceipt", [tx.hash], budget, chainName); }
  catch { aggregate.negativeActualSpend.callsAmbiguousOrUnavailable++; return; }
  const deposits = [];
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== fact.dex) continue;
    try {
      const parsed = DEX_DEPOSIT.parseLog(log);
      if (parsed?.name === "LogDepositPerfectColLiquidity") deposits.push(BigInt(parsed.args.token1Amt));
    } catch {}
  }
  if (deposits.length !== 1) {
    aggregate.negativeActualSpend.callsAmbiguousOrUnavailable++;
    return;
  }
  aggregate.negativeActualSpend.callsWithExactDexEventToken1++;
  const actual = deposits[0];
  const transactionIndex = Number(BigInt(tx.transactionIndex || "0x0"));
  if (transactionIndex !== 0) return;
  const preBlock = BigInt(tx.blockNumber) - 1n;
  const observation = await observe(providers, "eth_call", [{
    from: decoded.from,
    to: decoded.vault,
    data: decoded.input,
    value: decoded.value
  }, ethers.toQuantity(preBlock)], budget, chainName, counters);
  if (observation.value === null) return;
  try {
    const result = fact.iface.decodeFunctionResult("operatePerfect", observation.value);
    const returned = BigInt(result[1][2]);
    aggregate.exactPreCallReplays++;
    if (returned === actual) aggregate.exactPreCallReplayMatchesActual++;
  } catch {}
}

async function analyzeHistory(chain, providers, local, vaultFacts, pin, budget, counters) {
  const aggregate = newHistoryAggregate();
  if (!local.factoryBoundary || !vaultFacts.size) return {
    ...aggregate,
    fromBlock: local.factoryBoundary,
    toBlock: pin.number,
    logUniverseComplete: false,
    historyFamilyAgreement: null,
    stoppedReason: "DEPLOYMENT_BOUNDARY_OR_VAULT_SET_UNAVAILABLE"
  };
  const addresses = [...vaultFacts.keys()];
  const primary = await collectLogs(
    providers[0], addresses, LOG_OPERATE.getEvent("LogOperate").topicHash,
    local.factoryBoundary, Number(pin.number), budget, chain.name
  );
  let agreement = null;
  let secondary = null;
  if (providers.length > 1 && primary.complete && primary.queries <= 100 && primary.logs.length <= 5000) {
    secondary = await collectLogs(
      providers[1], addresses, LOG_OPERATE.getEvent("LogOperate").topicHash,
      local.factoryBoundary, Number(pin.number), budget, chain.name
    );
    if (secondary.complete) agreement = logCommitment(primary.logs) === logCommitment(secondary.logs);
  }
  const logs = primary.logs;
  aggregate.eventCount = logs.length;
  const byTx = new Map();
  for (const log of logs) {
    const key = String(log.transactionHash).toLowerCase();
    if (!byTx.has(key)) byTx.set(key, []);
    byTx.get(key).push(log);
  }
  aggregate.uniqueTransactions = byTx.size;
  const vaultSet = new Set(vaultFacts.keys());
  let txProcessed = 0;
  let traces = 0;
  for (const [txHash, txLogs] of byTx) {
    if (txProcessed >= LIMITS.transactionsPerChain) break;
    txProcessed++;
    let tx;
    try { tx = await rpc(providers[0], "eth_getTransactionByHash", [txHash], budget, chain.name); }
    catch { aggregate.unresolvedEventCalls += txLogs.length; continue; }
    aggregate.transactionsFetched++;
    tx.hash = txHash;
    const to = String(tx.to || "").toLowerCase();
    let calls = [];
    if (vaultSet.has(to)) {
      aggregate.directTransactions++;
      calls = [{ to, from: String(tx.from || "").toLowerCase(), input: tx.input, value: tx.value || "0x0" }];
    } else {
      aggregate.indirectTransactions++;
      if (traces < LIMITS.tracesPerChain) {
        traces++;
        aggregate.traceTransactionsAttempted++;
        const traced = await traceCalls(providers[0], txHash, vaultSet, budget, chain.name);
        calls = traced.calls;
        if (calls.length) aggregate.traceTransactionsResolved++;
      }
    }
    const decodedCalls = calls.map(call => decodeCall(call, vaultFacts)).filter(Boolean);
    if (!decodedCalls.length) { aggregate.unresolvedEventCalls += txLogs.length; continue; }
    for (const decoded of decodedCalls) {
      const fact = vaultFacts.get(decoded.vault);
      if (decoded.kind === "operate") { aggregate.decodedOperate++; continue; }
      if (decoded.kind !== "operatePerfect") continue;
      aggregate.decodedOperatePerfect++;
      const direct = to === decoded.vault;
      if (direct) {
        aggregate.callerCategories.directEoa++;
      } else if (local.knownAddresses.has(decoded.from)) {
        aggregate.callerCategories.knownLocalIntegrationContract++;
      } else if (decoded.from) {
        aggregate.callerCategories.contractIntegration++;
      } else {
        aggregate.callerCategories.unresolved++;
      }
      if (decoded.perfectColShares <= 0n) continue;
      if (decoded.token1MinMax > 0n) aggregate.perfectDeposits.positive++;
      else if (decoded.token1MinMax === 0n) aggregate.perfectDeposits.zero++;
      else {
        aggregate.perfectDeposits.negative++;
        if (decoded.token1MinMax === -1n) aggregate.perfectDeposits.minusOne++;
        else if (decoded.token1MinMax === INT_MIN) aggregate.perfectDeposits.int256Min++;
        else aggregate.perfectDeposits.otherNegative++;
        if (fact.nativeToken1) aggregate.perfectDeposits.nativeNegative++;
        else aggregate.perfectDeposits.erc20Negative++;
        const authority = await classifyNegativeAuthority(decoded, fact, tx.blockNumber, providers, local, budget, chain.name, counters);
        aggregate.negativeCallerAuthority[authority]++;
        await analyzeNegativeSpend(decoded, tx, fact, providers[0], providers, local, budget, chain.name, counters, aggregate);
      }
    }
  }
  const inputComplete = primary.complete && txProcessed === byTx.size && aggregate.unresolvedEventCalls === 0;
  return {
    ...aggregate,
    fromBlock: local.factoryBoundary,
    toBlock: pin.number,
    logQueriesPrimary: primary.queries,
    logQueriesSecondary: secondary?.queries ?? 0,
    failedMinimumRangesPrimary: primary.failedMinimumRanges,
    failedMinimumRangesSecondary: secondary?.failedMinimumRanges ?? 0,
    logUniverseComplete: primary.complete,
    inputDecodeComplete: inputComplete,
    historyFamilyAgreement: agreement,
    primaryFamilyScanCompleted: primary.complete,
    primaryFamilyScanQualification: primary.complete
      ? "primary-family scan completed; cross-family completeness/agreement unavailable unless separately proven"
      : "primary-family scan partial or unavailable",
    crossFamilyCompletenessAgreement: null,
    crossFamilyCompletenessClaimed: false,
    transactionLevelOperatePerfectDecodes: aggregate.decodedOperatePerfect,
    transactionLevelOperateDecodes: aggregate.decodedOperate,
    transactionLevelPerfectDepositToken1MaxObservations: aggregate.perfectDeposits,
    transactionLevelDecodedCallerCategories: aggregate.callerCategories,
    traceInnerCallSuccessProven: false,
    traceObservationsMayIncludeRevertedInnerCalls: aggregate.traceTransactionsAttempted > 0,
    successfulLogOperateLinkageProven: false,
    stoppedReason: primary.stoppedReason || (txProcessed < byTx.size ? "TRANSACTION_BUDGET" : null),
    rawTransactionsPersisted: false,
    rawLogsPersisted: false,
    callerIdentitiesPersisted: false
  };
}

function reserveRatio(data) {
  const token0 = BigInt(data.colReserves.token0RealReserves);
  const token1 = BigInt(data.colReserves.token1RealReserves);
  if (token0 === 0n || token1 === 0n) return null;
  return token1 * 10n ** 18n / token0;
}

function signedBps(current, prior) {
  if (current === null || prior === null || prior === 0n) return null;
  return (current - prior) * 10000n / prior;
}

async function processChain(chain, candidates, templates, budget) {
  const local = localChain(chain);
  const pinSelection = await selectPin(chain, candidates, budget);
  const base = {
    chain: chain.name,
    chainId: chain.chainId,
    pin: pinSelection.pin,
    endpointCoverage: {
      qualifiedFinalizedFamilies: pinSelection.providers.length,
      twoHostnameFamiliesWhereAvailable: pinSelection.providers.length >= 2,
      backendIndependenceClaimed: false
    },
    localInventory: {
      vaultT2: [...local.localVaults.values()].filter(row => row.type === 2).length,
      vaultT4: [...local.localVaults.values()].filter(row => row.type === 4).length,
      total: local.localVaults.size,
      factoryDeploymentBoundary: local.factoryBoundary
    }
  };
  if (!pinSelection.pin) return {
    ...base,
    status: "coverage-blocked",
    blocker: pinSelection.error,
    vaults: null,
    history: null,
    current: null
  };
  const pinProviders = pinSelection.providers;
  const providers = [pinProviders[0]];
  const blockTag = pinSelection.blockTag;
  const counters = { queries: 0, twoFamilyAgreements: 0, singleFamilyObservations: 0, mismatches: 0, nulls: 0 };
  const resolverIface = new ethers.Interface(local.resolver.abi);
  const allVaultsCall = await contractCall(
    providers, local.resolver.address, resolverIface, "getAllVaultsAddresses", [], blockTag, budget, chain.name, counters
  );
  if (!allVaultsCall.decoded) return {
    ...base,
    status: "coverage-blocked",
    blocker: "RESOLVER_ENUMERATION_FAILED",
    stateAgreement: counters,
    vaults: null,
    history: null,
    current: null
  };
  const allVaults = [...allVaultsCall.decoded[0]].map(address => String(address).toLowerCase());
  const t2Iface = new ethers.Interface(local.t2Artifact.abi);
  const t4Iface = new ethers.Interface(local.t4Artifact.abi);
  const vaultFacts = new Map();
  const runtime = {
    t2: { "vulnerable-shaped": 0, "patched-shaped": 0, unknown: 0 },
    t4: { "vulnerable-shaped": 0, "patched-shaped": 0, unknown: 0 },
    observedOperateRuntimeCodeHashes: new Set(),
    observedVaultCoreRuntimeCodeHashes: new Set(),
    matchMethods: {},
    twoFamilyBound: 0,
    singleFamilyBound: 0,
    codeMissing: 0
  };
  const linkage = {
    localManifestMatched: 0,
    localManifestMissing: 0,
    liquidityMatched: 0,
    factoryMatched: 0,
    dexCodePresent: 0,
    dexMatchedLocalManifest: 0,
    nativeToken1: 0,
    erc20Token1: 0
  };
  for (const vault of allVaults) {
    const typeCall = await contractCall(providers, vault, t2Iface, "TYPE", [], blockTag, budget, chain.name, counters);
    if (!typeCall.decoded) continue;
    const rawType = BigInt(typeCall.decoded[0]);
    const type = rawType === 20000n ? 2 : rawType === 40000n ? 4 : null;
    if (!type) continue;
    const iface = type === 2 ? t2Iface : t4Iface;
    const constantsCall = await contractCall(providers, vault, iface, "constantsView", [], blockTag, budget, chain.name, counters);
    if (!constantsCall.decoded) continue;
    const constants = constantsCall.decoded[0];
    const operate = String(constants.operateImplementation).toLowerCase();
    const dex = String(constants.supply).toLowerCase();
    const token1 = String(constants.supplyToken.token1).toLowerCase();
    const codeObservation = await observe(providers, "eth_getCode", [operate, blockTag], budget, chain.name, counters);
    const vaultCodeObservation = await observe(providers, "eth_getCode", [vault, blockTag], budget, chain.name, counters);
    const dexCodeObservation = await observe(providers, "eth_getCode", [dex, blockTag], budget, chain.name, counters);
    const classification = classifyRuntime(codeObservation.value, type, templates);
    runtime[`t${type}`][classification.classification]++;
    runtime.matchMethods[classification.method] = (runtime.matchMethods[classification.method] || 0) + 1;
    if (codeObservation.value && codeObservation.value !== "0x") {
      runtime.observedOperateRuntimeCodeHashes.add(ethers.keccak256(codeObservation.value));
    }
    if (vaultCodeObservation.value && vaultCodeObservation.value !== "0x") {
      runtime.observedVaultCoreRuntimeCodeHashes.add(ethers.keccak256(vaultCodeObservation.value));
    } else runtime.codeMissing++;
    if (codeObservation.agreement === true && constantsCall.agreement === true) runtime.twoFamilyBound++;
    else runtime.singleFamilyBound++;
    if (local.localVaults.has(vault)) linkage.localManifestMatched++;
    else linkage.localManifestMissing++;
    if (String(constants.liquidity).toLowerCase() === String(local.liquidity.address).toLowerCase()) linkage.liquidityMatched++;
    if (String(constants.factory).toLowerCase() === String(local.factoryAddress).toLowerCase()) linkage.factoryMatched++;
    if (dexCodeObservation.value && dexCodeObservation.value !== "0x") linkage.dexCodePresent++;
    if (local.dexAddresses.has(dex)) linkage.dexMatchedLocalManifest++;
    if (token1 === NATIVE) linkage.nativeToken1++;
    else linkage.erc20Token1++;
    vaultFacts.set(vault, {
      type,
      iface,
      operate,
      dex,
      token1,
      nativeToken1: token1 === NATIVE,
      runtime: classification.classification
    });
  }
  const liquidityResolverIface = new ethers.Interface(local.liquidityResolver.abi);
  const statusCall = await contractCall(
    providers, local.liquidityResolver.address, liquidityResolverIface, "getStatus", [], blockTag, budget, chain.name, counters
  );
  const liquidityStatus = statusCall.decoded ? BigInt(statusCall.decoded[0]).toString() : null;
  const dexIface = new ethers.Interface(local.dexResolver.abi);
  const dexFacts = new Map();
  for (const fact of vaultFacts.values()) dexFacts.set(fact.dex, null);
  const volatility = [];
  let smartCollateralEnabled = 0;
  let smartCollateralDisabled = 0;
  let swapPaused = 0;
  let dexCurrentSnapshots = 0;
  let dexArchiveSnapshots = 0;
  const priorNumber = BigInt(pinSelection.pin.number) > BigInt(chain.lookbackBlocks)
    ? BigInt(pinSelection.pin.number) - BigInt(chain.lookbackBlocks)
    : 0n;
  for (const dex of dexFacts.keys()) {
    const current = await contractCall(providers, local.dexResolver.address, dexIface, "getDexEntireData", [dex], blockTag, budget, chain.name, counters);
    if (!current.decoded) continue;
    dexCurrentSnapshots++;
    const currentData = current.decoded[0];
    if (Boolean(currentData.configs.isSmartCollateralEnabled)) smartCollateralEnabled++;
    else smartCollateralDisabled++;
    if (Boolean(currentData.dexState.isSwapAndArbitragePaused)) swapPaused++;
    const currentRatio = reserveRatio(currentData);
    const prior = await contractCall(
      providers, local.dexResolver.address, dexIface, "getDexEntireData", [dex], ethers.toQuantity(priorNumber), budget, chain.name, counters
    );
    if (!prior.decoded) continue;
    dexArchiveSnapshots++;
    const bps = signedBps(currentRatio, reserveRatio(prior.decoded[0]));
    if (bps !== null) volatility.push(bps < 0n ? -bps : bps);
  }
  volatility.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  let history;
  try { history = await analyzeHistory(chain, pinProviders, local, vaultFacts, pinSelection.pin, budget, counters); }
  catch (error) {
    history = {
      ...newHistoryAggregate(),
      fromBlock: local.factoryBoundary,
      toBlock: pinSelection.pin.number,
      logUniverseComplete: false,
      inputDecodeComplete: false,
      historyFamilyAgreement: null,
      stoppedReason: safeCode(error),
      rawTransactionsPersisted: false,
      rawLogsPersisted: false,
      callerIdentitiesPersisted: false
    };
  }
  const terminalHeaders = [];
  for (const provider of pinProviders) {
    try { terminalHeaders.push(await rpc(provider, "eth_getBlockByNumber", [blockTag, false], budget, chain.name)); }
    catch {}
  }
  const terminalExact = terminalHeaders.length === pinProviders.length && terminalHeaders.every(header =>
    BigInt(header.number).toString() === pinSelection.pin.number && String(header.hash).toLowerCase() === pinSelection.pin.hash.toLowerCase()
  );
  pinSelection.pin.terminalRecheck = {
    familiesObserved: terminalHeaders.length,
    exactNumberHashMatched: terminalExact,
    backendIndependenceClaimed: false
  };
  const vulnerableShaped = runtime.t2["vulnerable-shaped"] + runtime.t4["vulnerable-shaped"];
  const patchedShaped = runtime.t2["patched-shaped"] + runtime.t4["patched-shaped"];
  const operateCommitment = sha256(Buffer.from([...runtime.observedOperateRuntimeCodeHashes].sort().join("\n"), "utf8"));
  const coreCommitment = sha256(Buffer.from([...runtime.observedVaultCoreRuntimeCodeHashes].sort().join("\n"), "utf8"));
  return {
    ...base,
    pin: pinSelection.pin,
    status: terminalExact ? "captured" : "terminal-recheck-incomplete",
    blocker: terminalExact ? null : "TERMINAL_EXACT_NUMBER_HASH_RECHECK_FAILED",
    stateAgreement: counters,
    vaults: {
      resolverEnumeratedAllTypes: allVaults.length,
      t2: [...vaultFacts.values()].filter(fact => fact.type === 2).length,
      t4: [...vaultFacts.values()].filter(fact => fact.type === 4).length,
      totalT2T4: vaultFacts.size,
      architecture: "immutable-selector-router-with-delegatecall-operate-implementation-not-EIP1967",
      runtime: {
        t2: runtime.t2,
        t4: runtime.t4,
        vulnerableShapedPredicateSignatureObserved: vulnerableShaped,
        patchedShapedPredicateSignatureObserved: patchedShaped,
        predicateShapeUnknown: runtime.t2.unknown + runtime.t4.unknown,
        deployedOperatePerfectSemanticsBound: 0,
        deployedOperatePerfectSemanticsUnbound: vaultFacts.size,
        selectorControlFlowAnchoredProofRetained: false,
        observedOperateRuntimeCodeCommitmentSha256: operateCommitment,
        observedOperateRuntimeCodeCommitmentCount: runtime.observedOperateRuntimeCodeHashes.size,
        observedVaultCoreRuntimeCodeCommitmentSha256: coreCommitment,
        observedVaultCoreRuntimeCodeCommitmentCount: runtime.observedVaultCoreRuntimeCodeHashes.size,
        matchMethods: runtime.matchMethods,
        twoFamilyBound: runtime.twoFamilyBound,
        singleFamilyBound: runtime.singleFamilyBound,
        codeMissing: runtime.codeMissing
      },
      linkage
    },
    history,
    current: {
      liquidityStatus,
      liquidityNormal: liquidityStatus === "1" ? true : liquidityStatus === null ? null : false,
      uniqueDexPools: dexFacts.size,
      dexCurrentSnapshots,
      dexArchiveSnapshots,
      archiveLookbackBlocks: chain.lookbackBlocks,
      smartCollateralEnabledPools: smartCollateralEnabled,
      smartCollateralDisabledPools: smartCollateralDisabled,
      swapAndArbitragePausedPools: swapPaused,
      perfectFunctionsRemainUsableWhenSwapAndArbitragePaused: true,
      reserveRatioAbsoluteChangeBps: volatility.length ? {
        observedPools: volatility.length,
        median: volatility[Math.floor(volatility.length / 2)].toString(),
        maximum: volatility[volatility.length - 1].toString()
      } : null,
      accountSpecificOwnerOperatorCustodialAbility: null,
      accountSpecificAbilityReason: "Vulnerable-shaped predicate signature may be observed, but deployed operatePerfect semantics and account-specific invocation remain unbound."
    }
  };
}

function aggregateChains(chains) {
  const available = chains.filter(chain => chain.vaults);
  const sum = getter => available.reduce((total, chain) => total + getter(chain), 0);
  const historyAvailable = chains.filter(chain => chain.history);
  return {
    chainsRequested: CHAIN_CONFIG.length,
    chainsPinned: chains.filter(chain => chain.pin).length,
    chainsTerminalExact: chains.filter(chain => chain.pin?.terminalRecheck?.exactNumberHashMatched).length,
    twoFamilyPinnedChains: chains.filter(chain => chain.pin?.familiesObserved >= 2).length,
    backendIndependenceClaimed: false,
    vaultT2: sum(chain => chain.vaults.t2),
    vaultT4: sum(chain => chain.vaults.t4),
    vaultT2T4: sum(chain => chain.vaults.totalT2T4),
    vulnerableShapedPredicateSignatureObserved: sum(chain => chain.vaults.runtime.vulnerableShapedPredicateSignatureObserved),
    patchedShapedPredicateSignatureObserved: sum(chain => chain.vaults.runtime.patchedShapedPredicateSignatureObserved),
    predicateShapeUnknown: sum(chain => chain.vaults.runtime.predicateShapeUnknown),
    deployedOperatePerfectSemanticsBound: 0,
    deployedOperatePerfectSemanticsUnbound: sum(chain => chain.vaults.totalT2T4),
    primaryFamilyOperateLogRowsObserved: historyAvailable.reduce((total, chain) => total + chain.history.eventCount, 0),
    transactionLevelOperatePerfectDecodes: historyAvailable.reduce((total, chain) => total + chain.history.decodedOperatePerfect, 0),
    transactionLevelPerfectDepositNegative: historyAvailable.reduce((total, chain) => total + chain.history.perfectDeposits.negative, 0),
    transactionLevelPerfectDepositMinusOne: historyAvailable.reduce((total, chain) => total + chain.history.perfectDeposits.minusOne, 0),
    transactionLevelPerfectDepositInt256Min: historyAvailable.reduce((total, chain) => total + chain.history.perfectDeposits.int256Min, 0),
    transactionLevelPerfectDepositZero: historyAvailable.reduce((total, chain) => total + chain.history.perfectDeposits.zero, 0),
    transactionLevelPerfectDepositPositive: historyAvailable.reduce((total, chain) => total + chain.history.perfectDeposits.positive, 0),
    exactOverspendObservations: historyAvailable.reduce((total, chain) => total + chain.history.exactOverspendObservations, 0),
    primaryFamilyScanCompletedChains: historyAvailable.filter(chain => chain.history.logUniverseComplete).length,
    crossFamilyCompletenessAgreementChains: 0,
    completeInputDecodeChains: 0
  };
}

function assertNoLeaks(value) {
  const encoded = JSON.stringify(value);
  if (/https?:\/\//iu.test(encoded)) throw new SafeFailure("LEAK_GUARD_URL");
  if (/\b(?:authorization|x-api-key|api-key|cookie|set-cookie)\b/iu.test(encoded)) throw new SafeFailure("LEAK_GUARD_HEADER");
  if (/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/u.test(encoded)) throw new SafeFailure("LEAK_GUARD_ADDRESS");
  if (/\b(?:providerUrl|endpointUrl|hostname|domain|callerAddress|userAddress)\b/iu.test(encoded)) throw new SafeFailure("LEAK_GUARD_IDENTITY_KEY");
  return true;
}

function sourceBinding(templates) {
  const t2 = path.join(TARGET, "contracts", "protocols", "vault", "vaultT2", "coreModule", "mainOperate.sol");
  const t4 = path.join(TARGET, "contracts", "protocols", "vault", "vaultT4", "coreModule", "mainOperate.sol");
  const patchedT2 = path.join(ROOT, "remediations", "fluid-vaultt2-t4-r2", "contracts", "protocols", "vault", "vaultT2", "coreModule", "mainOperate.sol");
  const patchedT4 = path.join(ROOT, "remediations", "fluid-vaultt2-t4-r2", "contracts", "protocols", "vault", "vaultT4", "coreModule", "mainOperate.sol");
  return {
    commit: "a9949b48ba1247d4f478cd0acb40896b5c8bf3f8",
    vulnerable: {
      vaultT2Sha256: fileSha256(t2),
      vaultT4Sha256: fileSha256(t4),
      duplicatedPredicatePresent: fs.readFileSync(t2, "utf8").includes("(colToken0MinMax_ <= 0) || (colToken0MinMax_ <= 0)") &&
        fs.readFileSync(t4, "utf8").includes("(colToken0MinMax_ <= 0) || (colToken0MinMax_ <= 0)")
    },
    patched: {
      vaultT2Sha256: fileSha256(patchedT2),
      vaultT4Sha256: fileSha256(patchedT4),
      token1PredicatePresent: fs.readFileSync(patchedT2, "utf8").includes("(colToken0MinMax_ <= 0) || (colToken1MinMax_ <= 0)") &&
        fs.readFileSync(patchedT4, "utf8").includes("(colToken0MinMax_ <= 0) || (colToken1MinMax_ <= 0)")
    },
    runtimeTemplates: {
      t2: {
        referenceVulnerableTemplateArtifact: templates[2].vulnerable.file,
        referenceVulnerableTemplateArtifactSha256: templates[2].vulnerable.fileSha256,
        referenceVulnerableTemplateLogicalBodySha256: templates[2].vulnerable.logicalBodySha256,
        referencePatchedTemplateArtifact: templates[2].patched.file,
        referencePatchedTemplateArtifactSha256: templates[2].patched.fileSha256,
        referencePatchedTemplateLogicalBodySha256: templates[2].patched.logicalBodySha256
      },
      t4: {
        referenceVulnerableTemplateArtifact: templates[4].vulnerable.file,
        referenceVulnerableTemplateArtifactSha256: templates[4].vulnerable.fileSha256,
        referenceVulnerableTemplateLogicalBodySha256: templates[4].vulnerable.logicalBodySha256,
        referencePatchedTemplateArtifact: templates[4].patched.file,
        referencePatchedTemplateArtifactSha256: templates[4].patched.fileSha256,
        referencePatchedTemplateLogicalBodySha256: templates[4].patched.logicalBodySha256
      }
    },
    runtimeTemplatesAreReferenceArtifactsNotDeployedRuntimeCommitments: true
  };
}

async function run() {
  const startedAt = new Date().toISOString();
  let reconciliation = {
    resumed: false,
    partialArtifact: null,
    retainedChains: 0,
    newlyQueriedChains: CHAIN_CONFIG.length,
    disposition: "fresh-capture"
  };
  const chains = [];
  if (process.env.FLUID_STEP2_RESUME_PARTIAL === "true" && fs.existsSync(OUTPUT)) {
    const partial = readJson(OUTPUT);
    assertNoLeaks(partial);
    if (partial.findingId !== "fluid-vaultt2-t4-negative-token1-max-step2" || partial.classification !== "CAPTURE_IN_PROGRESS") {
      throw new SafeFailure("RESUME_PARTIAL_SHAPE_INVALID");
    }
    const retained = Array.isArray(partial.chains) ? partial.chains : [];
    const names = new Set(retained.map(row => row.chain));
    if (retained.length !== 5 || names.size !== 5 || names.has("ethereum")) throw new SafeFailure("RESUME_PARTIAL_CHAIN_SET_INVALID");
    if (!fs.existsSync(PARTIAL_ARCHIVE)) fs.copyFileSync(OUTPUT, PARTIAL_ARCHIVE);
    chains.push(...retained);
    reconciliation = {
      resumed: true,
      partialArtifact: "reports/raw/fast/critical-fluid-vaultt2-t4-negative-max-step2-partial-r5.json",
      partialArtifactSha256: fileSha256(PARTIAL_ARCHIVE),
      retainedChains: retained.length,
      retainedTerminalExactChains: retained.filter(row => row.pin?.terminalRecheck?.exactNumberHashMatched).length,
      newlyQueriedChains: CHAIN_CONFIG.length - retained.length,
      disposition: "sanitized-five-chain-checkpoint-archived-and-superseded-by-final-resume"
    };
  }
  const inventory = parseInventories();
  if (!inventory.files.rpc.available && !inventory.files.graphql.available) throw new SafeFailure("AUTHORIZED_INVENTORIES_UNAVAILABLE");
  const templates = loadRuntimeTemplates();
  const budget = makeBudget();
  const qualification = await qualifyEndpoints(inventory, budget);
  const qualificationCheckpoint = {
    schemaVersion: 1,
    findingId: "fluid-vaultt2-t4-negative-token1-max-step2",
    generatedAt: new Date().toISOString(),
    startedAt,
    classification: "CAPTURE_IN_PROGRESS_ENDPOINT_QUALIFICATION_COMPLETE",
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    fork: false,
    safety: {
      readOnlyRpc: true,
      signing: false,
      transactions: false,
      broadcasts: false,
      mutation: false,
      liveExploit: false,
      fork: false,
      endpointIdentitiesPersisted: false,
      endpointDomainsPersisted: false,
      rawResponsesPersisted: false,
      callerOrUserIdentitiesPersisted: false
    },
    candidateProbesCompleted: qualification.probed,
    qualifiedFamilyCountsByChain: Object.fromEntries(CHAIN_CONFIG.map(chain => [
      chain.name,
      qualification.grouped.get(chain.chainId)?.length || 0
    ])),
    reconciliation,
    chains,
    rpcBudget: budget
  };
  assertNoLeaks(qualificationCheckpoint);
  fs.writeFileSync(OUTPUT, `${JSON.stringify(qualificationCheckpoint, null, 2)}\n`, "utf8");
  const retainedNames = new Set(chains.map(row => row.chain));
  for (const chain of CHAIN_CONFIG.filter(row => !retainedNames.has(row.name))) {
    try {
      chains.push(await processChain(chain, qualification.grouped.get(chain.chainId) || [], templates, budget));
    } catch (error) {
      chains.push({
        chain: chain.name,
        chainId: chain.chainId,
        status: "coverage-blocked",
        blocker: safeCode(error),
        pin: null,
        vaults: null,
        history: null,
        current: null
      });
    }
    const checkpoint = {
      schemaVersion: 1,
      findingId: "fluid-vaultt2-t4-negative-token1-max-step2",
      generatedAt: new Date().toISOString(),
      startedAt,
      classification: "CAPTURE_IN_PROGRESS",
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      fork: false,
      safety: {
        readOnlyRpc: true,
        signing: false,
        transactions: false,
        broadcasts: false,
        mutation: false,
        liveExploit: false,
        fork: false,
        endpointIdentitiesPersisted: false,
        endpointDomainsPersisted: false,
        rawResponsesPersisted: false,
        callerOrUserIdentitiesPersisted: false
      },
      completedChains: chains.length,
      reconciliation,
      chains,
      rpcBudget: budget
    };
    assertNoLeaks(checkpoint);
    fs.writeFileSync(OUTPUT, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  }
  const aggregate = aggregateChains(chains);
  const result = {
    schemaVersion: 1,
    findingId: "fluid-vaultt2-t4-negative-token1-max-step2",
    generatedAt: new Date().toISOString(),
    startedAt,
    classification: "CONDITIONAL-LOW/VULNERABLE-SHAPED-PREDICATE-SIGNATURE-OBSERVED/DEPLOYED-OPERATEPERFECT-SEMANTICS-UNBOUND/HISTORY-INCOMPLETE/CALLER-FUNDED/NO-OUTSIDER-THEFT",
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    fork: false,
    safety: {
      readOnlyRpc: true,
      graphqlQueries: 0,
      signing: false,
      transactions: false,
      broadcasts: false,
      mutation: false,
      liveExploit: false,
      fork: false,
      endpointIdentitiesPersisted: false,
      endpointDomainsPersisted: false,
      rawResponsesPersisted: false,
      callerOrUserIdentitiesPersisted: false
    },
    inventoryCoverage: {
      files: inventory.files,
      uniqueCandidatesParsed: inventory.records.length,
      candidatesProbed: qualification.probed,
      endpointOrProviderIdentityPersisted: false
    },
    limits: LIMITS,
    sourceBinding: sourceBinding(templates),
    reconciliation,
    aggregate,
    chains,
    rpcBudget: budget,
    conclusion: {
      permissionlessOutsiderProfitOrForcedThirdPartyLoss: false,
      callerFundedIntegrationImpact: true,
      exactHistoricalOverspendEstablished: aggregate.exactOverspendObservations > 0,
      severity: "conditional-low",
      deploymentExposure: "vulnerable-shaped-predicate-signature-observed-semantics-unbound",
      currentExactAffectedRuntimeClaimed: false,
      strictCaveat: "Zero observed negative sentinels is scoped to retained transaction-level decodes; traces may include reverted inner calls, history is incomplete, and deployed operatePerfect semantics are unbound."
    }
  };
  assertNoLeaks(result);
  fs.writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    status: "SANITIZED_CAPTURE_COMPLETE",
    chainsPinned: aggregate.chainsPinned,
    vaults: aggregate.vaultT2T4,
    vulnerableShapedRuntime: aggregate.vulnerableShapedPredicateSignatureObserved,
    primaryFamilyOperateLogRows: aggregate.primaryFamilyOperateLogRowsObserved,
    negativeTransactionLevelDecodes: aggregate.transactionLevelPerfectDepositNegative,
    exactOverspendObservations: aggregate.exactOverspendObservations,
    rpcCalls: budget.global.attempted
  }));
  return result;
}

async function main() {
  try { await run(); }
  catch (error) {
    const failure = {
      schemaVersion: 1,
      findingId: "fluid-vaultt2-t4-negative-token1-max-step2",
      generatedAt: new Date().toISOString(),
      classification: "CAPTURE_INCOMPLETE",
      errorCode: safeCode(error),
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      fork: false,
      safety: {
        signing: false,
        transactions: false,
        broadcasts: false,
        mutation: false,
        endpointIdentitiesPersisted: false,
        rawResponsesPersisted: false,
        callerOrUserIdentitiesPersisted: false
      }
    };
    assertNoLeaks(failure);
    fs.writeFileSync(OUTPUT, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
    console.error(JSON.stringify({ status: "SANITIZED_CAPTURE_INCOMPLETE", errorCode: failure.errorCode }));
    process.exitCode = 1;
  }
}

module.exports = {
  INT_MIN,
  LIMITS,
  assertNoLeaks,
  canonical,
  classifyRuntime,
  decodeCall,
  flattenImmutableReferences,
  loadRuntimeTemplates,
  maskImmutables,
  parseInventories,
  reserveRatio,
  signedBps,
  stripSolidityMetadata
};

if (require.main === module) main();
