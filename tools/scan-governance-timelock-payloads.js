#!/usr/bin/env node
// Read-only on-chain governance/timelock payload scanner.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "governance-timelock-payloads.json");
const OUT_MD = path.join(WORKSPACE, "reports", "governance-timelock-payloads-triage.md");
const QUIET = process.argv.includes("--quiet");

const TIMEOUT_MS = Number(process.env.GOV_TIMELOCK_TIMEOUT_MS || "15000");
const MAX_LOG_BLOCKS = Number(process.env.GOV_TIMELOCK_MAX_LOG_BLOCKS || "20000");
const LOG_CHUNK_BLOCKS = Number(process.env.GOV_TIMELOCK_LOG_CHUNK_BLOCKS || "5000");
const MAX_LOGS_PER_TARGET = Number(process.env.GOV_TIMELOCK_MAX_LOGS_PER_TARGET || "20");
const LOW_DELAY_SECONDS = Number(process.env.GOV_TIMELOCK_LOW_DELAY_SECONDS || "86400");

const ZERO = "0x0000000000000000000000000000000000000000";
const ROLE_DEFAULT_ADMIN = "0x" + "0".repeat(64);
const ROLE_PROPOSER = ethers.id("PROPOSER_ROLE");
const ROLE_EXECUTOR = ethers.id("EXECUTOR_ROLE");
const ROLE_CANCELLER = ethers.id("CANCELLER_ROLE");

const CHAIN_NAMES = {
  1: "Ethereum",
  10: "Optimism",
  56: "BNB Chain",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum",
};

const TARGETS = [
  {
    protocol: "Compound",
    chainId: 1,
    address: "0x6d903f6003cca6255d85cca4d3b5e5146dc33925",
    governor: "0xc0Da02939E1441F497fd74F78cE7Decb17B66529",
    kind: "compound-bravo-timelock",
    source: "known Compound Timelock/Governor Bravo",
  },
  {
    protocol: "Uniswap",
    chainId: 1,
    address: "0x1a9C8182C09F50C8318d769245beA52c32BE35BC",
    governor: "0x5e4be8Bc9637f0EAA1A755019e06A68ce081D58F",
    kind: "governor-timelock",
    source: "known Uniswap Governor/Timelock",
  },
  {
    protocol: "Aave Governance V3",
    chainId: 1,
    address: "0x9AEE0B04504CeF83A65AC3f0e838D0593BCb2BC7",
    governor: null,
    kind: "governance-controller-or-executor",
    source: "local phase6 governance address inventory",
  },
  {
    protocol: "Sky / Maker",
    chainId: 1,
    address: "0xbE286431454714F511008713973d3B053A2d38f3",
    governor: null,
    kind: "maker-pause",
    source: "local phase6 governance address inventory",
  },
  {
    protocol: "Euler",
    chainId: 1,
    address: "0x4cD6BF1D183264c02Be7748Cb5cd3A47d013351b",
    governor: null,
    kind: "protocol-config-governor",
    source: "local phase6 governance address inventory",
  },
];

const TIMELOCK = new ethers.Interface([
  "function delay() view returns (uint256)",
  "function admin() view returns (address)",
  "function pendingAdmin() view returns (address)",
  "function GRACE_PERIOD() view returns (uint256)",
  "function queuedTransactions(bytes32) view returns (bool)",
  "event QueueTransaction(bytes32 indexed txHash,address indexed target,uint256 value,string signature,bytes data,uint256 eta)",
  "event ExecuteTransaction(bytes32 indexed txHash,address indexed target,uint256 value,string signature,bytes data,uint256 eta)",
  "event CancelTransaction(bytes32 indexed txHash,address indexed target,uint256 value,string signature,bytes data,uint256 eta)",
]);

const OZ_TIMELOCK = new ethers.Interface([
  "function getMinDelay() view returns (uint256)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)",
  "event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)",
  "event Cancelled(bytes32 indexed id)",
]);

const GOVERNOR = new ethers.Interface([
  "function state(uint256 proposalId) view returns (uint8)",
  "function proposalCount() view returns (uint256)",
  "event ProposalCreated(uint256 id,address proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,uint256 startBlock,uint256 endBlock,string description)",
]);

const GOVERNOR_STATES = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"];

const SELECTOR_HINTS = new Map([
  ["0x3659cfe6", "upgradeTo(address)"],
  ["0x4f1ef286", "upgradeToAndCall(address,bytes)"],
  ["0x8f283970", "changeAdmin(address)"],
  ["0x99a88ec4", "setPriceOracle(address)"],
  ["0x4f864cbb", "setReserveInterestRateStrategyAddress(address,address)"],
  ["0x5a3b74b9", "setAssetSources(address[],address[])"],
  ["0x9962c72e", "setBorrowCap(address,uint256)"],
  ["0x7f2053bc", "setSupplyCap(address,uint256)"],
  ["0x3f33f5c5", "setReservePause(address,bool)"],
  ["0xe6a5d7f2", "setReserveBorrowing(address,bool)"],
  ["0x0f31d0d1", "_setCollateralFactor(address,uint256)"],
  ["0xe4028eee", "_setMarketBorrowCaps(address[],uint256[])"],
  ["0xf2fde38b", "transferOwnership(address)"],
  ["0x2f2ff15d", "grantRole(bytes32,address)"],
  ["0xd547741f", "revokeRole(bytes32,address)"],
]);

const CRITICAL_TERMS = [
  "oracle", "price", "source", "feed", "ltv", "lltv", "collateral", "liquidation",
  "borrowcap", "borrow cap", "supplycap", "supply cap", "pause", "unpause", "reserve",
  "market", "supportmarket", "upgrade", "implementation", "admin", "owner", "role",
  "grantrole", "setasset", "setreserve", "setborrow", "setsupply", "setprice",
  "collateralfactor", "emode", "risk", "cap",
];

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function sanitizeError(err) {
  return String(err?.message || err || "")
    .replace(/https?:\/\/[^\s'"<>]+/g, "[redacted-rpc]")
    .slice(0, 240);
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  const n = Number(String(value).replace(/[$,%\s,_]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 6) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function shortAddress(address) {
  const s = String(address || "");
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? `${s.slice(0, 6)}...${s.slice(-4)}` : s || null;
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function fetchJson(url, payload, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcByChain(chainIds) {
  const wanted = new Set(chainIds.map((n) => Number(n)));
  const result = {};
  for (const url of loadRpcUrls()) {
    if (Object.keys(result).length >= wanted.size) break;
    try {
      const hex = await fetchJson(url, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, 5000);
      const chainId = Number(BigInt(hex));
      if (wanted.has(chainId) && !result[chainId]) result[chainId] = url;
    } catch (_) {
      // Try next endpoint without surfacing or storing the URL.
    }
  }
  return result;
}

async function safeContractCall(contract, method, args = []) {
  try {
    return await contract[method](...args);
  } catch (err) {
    return { __error: sanitizeError(err) };
  }
}

async function safeProviderCall(provider, address, iface, functionName, args = []) {
  try {
    const data = iface.encodeFunctionData(functionName, args);
    const raw = await provider.call({ to: address, data });
    return iface.decodeFunctionResult(functionName, raw)[0];
  } catch (err) {
    return { __error: sanitizeError(err) };
  }
}

async function getLogsChunked(provider, filter, fromBlock, toBlock) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_BLOCKS) {
    const end = Math.min(toBlock, start + LOG_CHUNK_BLOCKS - 1);
    try {
      const chunk = await provider.getLogs({ ...filter, fromBlock: start, toBlock: end });
      logs.push(...chunk);
      if (logs.length >= MAX_LOGS_PER_TARGET) return logs.slice(-MAX_LOGS_PER_TARGET);
    } catch (_) {
      // Some providers cap ranges more aggressively. Keep fail-closed and continue.
    }
  }
  return logs.slice(-MAX_LOGS_PER_TARGET);
}

function selectorFromData(data) {
  const s = String(data || "").toLowerCase();
  return /^0x[0-9a-f]{8,}/.test(s) ? s.slice(0, 10) : null;
}

function normalizeSignature(signature, data) {
  const sig = String(signature || "").trim();
  if (sig) return sig;
  const selector = selectorFromData(data);
  return selector ? SELECTOR_HINTS.get(selector) || selector : null;
}

function classifyPayload(signature, data, description = "") {
  const normalized = normalizeSignature(signature, data) || "unknown";
  const selector = selectorFromData(data) || (normalized.includes("(") ? ethers.id(normalized).slice(0, 10) : null);
  const text = `${normalized} ${selector || ""} ${description || ""}`.toLowerCase().replace(/[_-]/g, "");
  const matchedTerms = CRITICAL_TERMS.filter((term) => text.includes(term.replace(/[_-]/g, "")));
  return {
    selector,
    signature: normalized,
    matchedTerms,
    critical: matchedTerms.length > 0,
  };
}

function roleSummary(openExecutor, lowDelay, codePresent, interfaceKind) {
  const out = [];
  if (!codePresent) out.push("no-code");
  if (openExecutor) out.push("open-executor-role");
  if (lowDelay) out.push("low-delay");
  if (!interfaceKind) out.push("timelock-interface-not-detected");
  return out;
}

async function scanTimelock(provider, target, latestBlock, nowTs) {
  const address = ethers.getAddress(target.address);
  const code = await provider.getCode(address).catch(() => "0x");
  const codePresent = code && code !== "0x";
  const compound = new ethers.Contract(address, TIMELOCK, provider);
  const oz = new ethers.Contract(address, OZ_TIMELOCK, provider);
  const row = {
    protocol: target.protocol,
    chainId: target.chainId,
    chain: CHAIN_NAMES[target.chainId] || String(target.chainId),
    address,
    kind: target.kind,
    source: target.source,
    codePresent,
    codeBytes: codePresent ? Math.floor((code.length - 2) / 2) : 0,
    interfaceKind: null,
    delaySeconds: null,
    gracePeriodSeconds: null,
    admin: null,
    pendingAdmin: null,
    openExecutorRole: false,
    lowDelay: false,
    roleChecks: {},
    flags: [],
    errors: [],
  };
  if (!codePresent) {
    row.flags = roleSummary(false, false, false, null);
    return row;
  }

  const delay = await safeContractCall(compound, "delay");
  if (!delay?.__error) {
    row.interfaceKind = "compound-timelock";
    row.delaySeconds = Number(delay);
    const admin = await safeContractCall(compound, "admin");
    const pendingAdmin = await safeContractCall(compound, "pendingAdmin");
    const grace = await safeContractCall(compound, "GRACE_PERIOD");
    if (!admin?.__error) row.admin = admin;
    if (!pendingAdmin?.__error) row.pendingAdmin = pendingAdmin;
    if (!grace?.__error) row.gracePeriodSeconds = Number(grace);
  } else {
    const minDelay = await safeContractCall(oz, "getMinDelay");
    if (!minDelay?.__error) {
      row.interfaceKind = "oz-timelock-controller";
      row.delaySeconds = Number(minDelay);
      for (const [label, role, account] of [
        ["defaultAdminZero", ROLE_DEFAULT_ADMIN, ZERO],
        ["proposerZero", ROLE_PROPOSER, ZERO],
        ["executorZero", ROLE_EXECUTOR, ZERO],
        ["cancellerZero", ROLE_CANCELLER, ZERO],
      ]) {
        const value = await safeContractCall(oz, "hasRole", [role, account]);
        if (!value?.__error) row.roleChecks[label] = Boolean(value);
      }
      row.openExecutorRole = Boolean(row.roleChecks.executorZero);
    } else {
      row.errors.push(`delay(): ${delay.__error}`);
      row.errors.push(`getMinDelay(): ${minDelay.__error}`);
    }
  }
  row.lowDelay = row.delaySeconds !== null && row.delaySeconds < LOW_DELAY_SECONDS;
  row.flags = roleSummary(row.openExecutorRole, row.lowDelay, codePresent, row.interfaceKind);
  row.latestBlock = latestBlock;
  row.generatedAtTs = nowTs;
  return row;
}

async function scanCompoundQueue(provider, target, latestBlock, nowTs) {
  const address = ethers.getAddress(target.address);
  const fromBlock = Math.max(0, latestBlock - MAX_LOG_BLOCKS);
  const logs = await getLogsChunked(provider, { address, topics: [TIMELOCK.getEvent("QueueTransaction").topicHash] }, fromBlock, latestBlock);
  const contract = new ethers.Contract(address, TIMELOCK, provider);
  const rows = [];
  for (const log of logs.slice(-MAX_LOGS_PER_TARGET)) {
    try {
      const parsed = TIMELOCK.parseLog(log);
      const args = parsed.args;
      const classification = classifyPayload(args.signature, args.data);
      const eta = Number(args.eta);
      const queued = await safeContractCall(contract, "queuedTransactions", [args.txHash]);
      const stillQueued = !queued?.__error ? Boolean(queued) : null;
      rows.push({
        protocol: target.protocol,
        chainId: target.chainId,
        chain: CHAIN_NAMES[target.chainId] || String(target.chainId),
        source: "compound-timelock-queue-event",
        txHash: args.txHash,
        target: args.target,
        targetShort: shortAddress(args.target),
        value: args.value.toString(),
        signature: classification.signature,
        selector: classification.selector,
        eta,
        etaIso: eta ? new Date(eta * 1000).toISOString() : null,
        etaInFuture: eta > nowTs,
        readyNow: eta > 0 && eta <= nowTs,
        stillQueued,
        critical: classification.critical,
        matchedTerms: classification.matchedTerms,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        status: stillQueued ? (eta > nowTs ? "queued-waiting" : "queued-ready") : "historical-or-cancelled-executed",
        routePositive: false,
      });
    } catch (_) {
      // Bad event decode should not fail the whole scanner.
    }
  }
  return rows;
}

async function scanOzQueue(provider, target, latestBlock, nowTs) {
  const address = ethers.getAddress(target.address);
  const fromBlock = Math.max(0, latestBlock - MAX_LOG_BLOCKS);
  const logs = await getLogsChunked(provider, { address, topics: [OZ_TIMELOCK.getEvent("CallScheduled").topicHash] }, fromBlock, latestBlock);
  const contract = new ethers.Contract(address, OZ_TIMELOCK, provider);
  const rows = [];
  for (const log of logs.slice(-MAX_LOGS_PER_TARGET)) {
    try {
      const parsed = OZ_TIMELOCK.parseLog(log);
      const args = parsed.args;
      const classification = classifyPayload(null, args.data);
      const [pending, ready, done, timestamp] = await Promise.all([
        safeContractCall(contract, "isOperationPending", [args.id]),
        safeContractCall(contract, "isOperationReady", [args.id]),
        safeContractCall(contract, "isOperationDone", [args.id]),
        safeContractCall(contract, "getTimestamp", [args.id]),
      ]);
      const ts = timestamp?.__error ? null : Number(timestamp);
      rows.push({
        protocol: target.protocol,
        chainId: target.chainId,
        chain: CHAIN_NAMES[target.chainId] || String(target.chainId),
        source: "oz-timelock-call-scheduled",
        operationId: args.id,
        index: args.index.toString(),
        target: args.target,
        targetShort: shortAddress(args.target),
        value: args.value.toString(),
        signature: classification.signature,
        selector: classification.selector,
        delaySeconds: Number(args.delay),
        timestamp: ts,
        etaIso: ts ? new Date(ts * 1000).toISOString() : null,
        etaInFuture: ts ? ts > nowTs : null,
        pending: pending?.__error ? null : Boolean(pending),
        ready: ready?.__error ? null : Boolean(ready),
        done: done?.__error ? null : Boolean(done),
        critical: classification.critical,
        matchedTerms: classification.matchedTerms,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        status: done?.__error ? "unknown" : Boolean(done) ? "done" : ready?.__error ? "unknown" : Boolean(ready) ? "ready" : pending?.__error ? "unknown" : Boolean(pending) ? "pending" : "historical-or-cancelled",
        routePositive: false,
      });
    } catch (_) {
      // Bad event decode should not fail the whole scanner.
    }
  }
  return rows;
}

async function scanGovernorProposals(provider, target, latestBlock) {
  if (!target.governor) return [];
  const governorAddress = ethers.getAddress(target.governor);
  const code = await provider.getCode(governorAddress).catch(() => "0x");
  if (!code || code === "0x") return [];
  const fromBlock = Math.max(0, latestBlock - MAX_LOG_BLOCKS);
  const logs = await getLogsChunked(provider, { address: governorAddress, topics: [GOVERNOR.getEvent("ProposalCreated").topicHash] }, fromBlock, latestBlock);
  const contract = new ethers.Contract(governorAddress, GOVERNOR, provider);
  const rows = [];
  for (const log of logs.slice(-MAX_LOGS_PER_TARGET)) {
    try {
      const parsed = GOVERNOR.parseLog(log);
      const args = parsed.args;
      const stateRaw = await safeContractCall(contract, "state", [args.id]);
      const stateId = stateRaw?.__error ? null : Number(stateRaw);
      const state = stateId === null ? "unknown" : GOVERNOR_STATES[stateId] || String(stateId);
      const targets = Array.from(args.targets || []);
      const signatures = Array.from(args.signatures || []);
      const calldatas = Array.from(args.calldatas || []);
      for (let i = 0; i < targets.length; i++) {
        const classification = classifyPayload(signatures[i], calldatas[i], args.description || "");
        rows.push({
          protocol: target.protocol,
          chainId: target.chainId,
          chain: CHAIN_NAMES[target.chainId] || String(target.chainId),
          source: "governor-proposal-created",
          governor: governorAddress,
          proposalId: args.id.toString(),
          proposalState: state,
          actionIndex: i,
          target: targets[i],
          targetShort: shortAddress(targets[i]),
          signature: classification.signature,
          selector: classification.selector,
          critical: classification.critical,
          matchedTerms: classification.matchedTerms,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          title: String(args.description || "").split("\n")[0].slice(0, 180),
          activeOrQueued: ["Pending", "Active", "Succeeded", "Queued"].includes(state),
          routePositive: false,
        });
      }
    } catch (_) {
      // Bad event decode should not fail the whole scanner.
    }
  }
  return rows;
}

function table(rows, cols) {
  const header = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${cols.map((col) => String(row[col] ?? "").replace(/\|/g, "/")).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

function renderReport(artifact) {
  const s = artifact.summary;
  const topPayloads = artifact.topPayloadRows.slice(0, 12).map((row) => ({
    Protocol: row.protocol,
    Source: row.source,
    State: row.status || row.proposalState || "",
    Target: row.targetShort,
    Action: row.signature,
    Critical: row.critical ? "yes" : "no",
    Blocker: row.blockers?.[0] || "Needs target config diff, consumer join, exact economics, and fork proof",
  }));
  const timelocks = artifact.timelockRows.map((row) => ({
    Protocol: row.protocol,
    Chain: row.chain,
    Kind: row.interfaceKind || row.kind,
    Delay: row.delaySeconds ?? "n/a",
    Flags: row.flags.join(", ") || "none",
    Code: row.codePresent ? "yes" : "no",
  }));
  return [
    "# \uD83D\uDFE2 DORMANT - Governance Timelock Payload Scan",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Scanned ${s.targetsScanned} curated governance/timelock targets and ${s.governorTargetsScanned} governors using read-only RPC calls. The branch remains research-only: queued/on-chain payload rows are not route-positive without decoded target config diffs, consumer joins, exact positive economics, and fork proof. Route gates remain closed: \`activeCriticalPayloadRows=${s.activeCriticalPayloadRows}\`, \`consumerLinkedRows=0\`, \`exactEconomicsRows=0\`, \`forkProofRows=0\`, \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`.`,
    "",
    "## Coverage",
    "",
    table([{
      Targets: s.targetsScanned,
      Timelocks: s.timelockRows,
      Governors: s.governorTargetsScanned,
      QueuedPayloads: s.queuedPayloadRows,
      GovernorPayloads: s.governorPayloadRows,
      CriticalPayloads: s.decodedCriticalPayloadRows,
      ActiveCritical: s.activeCriticalPayloadRows,
      LowDelay: s.lowDelayRows,
      OpenExecutor: s.openExecutorRows,
    }], ["Targets", "Timelocks", "Governors", "QueuedPayloads", "GovernorPayloads", "CriticalPayloads", "ActiveCritical", "LowDelay", "OpenExecutor"]),
    "",
    "## Timelock Rows",
    "",
    timelocks.length ? table(timelocks, ["Protocol", "Chain", "Kind", "Delay", "Flags", "Code"]) : "No code-positive timelock rows decoded.",
    "",
    "## Top Payload Rows",
    "",
    topPayloads.length ? table(topPayloads, ["Protocol", "Source", "State", "Target", "Action", "Critical", "Blocker"]) : "No recent queued/proposal payload rows decoded in the configured lookback.",
    "",
    "## Route-Positive Gate",
    "",
    "Do not fork or build executors until a queued/active payload changes collateral, oracle, LTV/LT, caps, pause state, implementation, or roles; the target asset maps to material live consumers; exact acquisition/borrow/exit economics are positive after gas/slippage; and fork proof demonstrates value extraction.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/governance-timelock-payloads.json`",
    "- Scanner: `tools/scan-governance-timelock-payloads.js`",
    "- Related: `reports/governance-listing-watch-triage.md`, `reports/market-launch-choreography-routes-triage.md`",
    "",
  ].join("\n");
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const chainIds = [...new Set(TARGETS.map((t) => t.chainId))];
  const rpcByChain = await resolveRpcByChain(chainIds);
  const nowTs = Math.floor(Date.now() / 1000);
  const timelockRows = [];
  const payloadRows = [];
  const sourceErrors = [];

  for (const chainId of chainIds) {
    const rpc = rpcByChain[chainId];
    if (!rpc) {
      sourceErrors.push({ chainId, chain: CHAIN_NAMES[chainId] || String(chainId), error: "No RPC endpoint resolved from local inventory" });
      continue;
    }
    const provider = new ethers.JsonRpcProvider(rpc, { chainId, name: CHAIN_NAMES[chainId] || String(chainId) }, { staticNetwork: true });
    const latestBlock = await provider.getBlockNumber();
    for (const target of TARGETS.filter((t) => t.chainId === chainId)) {
      try {
        const timelock = await scanTimelock(provider, target, latestBlock, nowTs);
        timelockRows.push(timelock);
        if (timelock.interfaceKind === "compound-timelock") {
          payloadRows.push(...await scanCompoundQueue(provider, target, latestBlock, nowTs));
        } else if (timelock.interfaceKind === "oz-timelock-controller") {
          payloadRows.push(...await scanOzQueue(provider, target, latestBlock, nowTs));
        }
        payloadRows.push(...await scanGovernorProposals(provider, target, latestBlock));
      } catch (err) {
        sourceErrors.push({ protocol: target.protocol, chainId, error: sanitizeError(err) });
      }
    }
  }

  const enrichedPayloadRows = payloadRows.map((row) => ({
    ...row,
    consumerLinked: false,
    exactEconomics: false,
    forkProof: false,
    blockers: [
      "Payload is decoded/on-chain inventory, not a route-positive exploit proof",
      "No config-diff-to-consumer join is proven for the target",
      "No exact acquisition/borrow/exit economics or fork proof",
    ],
  }));

  const activeCriticalPayloadRows = enrichedPayloadRows.filter((row) => row.critical && (row.stillQueued || row.pending || row.ready || row.activeOrQueued)).length;
  const topPayloadRows = enrichedPayloadRows
    .slice()
    .sort((a, b) => Number(b.critical) - Number(a.critical)
      || Number(Boolean(b.stillQueued || b.pending || b.ready || b.activeOrQueued)) - Number(Boolean(a.stillQueued || a.pending || a.ready || a.activeOrQueued))
      || (b.blockNumber || 0) - (a.blockNumber || 0));

  const summary = {
    targetsScanned: TARGETS.length,
    chainsRequested: chainIds.length,
    chainsWithRpc: Object.keys(rpcByChain).length,
    timelockRows: timelockRows.length,
    codePresentRows: timelockRows.filter((row) => row.codePresent).length,
    timelockInterfaceRows: timelockRows.filter((row) => row.interfaceKind).length,
    lowDelayRows: timelockRows.filter((row) => row.lowDelay).length,
    openExecutorRows: timelockRows.filter((row) => row.openExecutorRole).length,
    governorTargetsScanned: TARGETS.filter((t) => t.governor).length,
    queuedPayloadRows: enrichedPayloadRows.filter((row) => /timelock/.test(row.source || "")).length,
    governorPayloadRows: enrichedPayloadRows.filter((row) => row.source === "governor-proposal-created").length,
    decodedCriticalPayloadRows: enrichedPayloadRows.filter((row) => row.critical).length,
    activeCriticalPayloadRows,
    consumerLinkedRows: 0,
    exactEconomicsRows: 0,
    forkProofRows: 0,
    watchCandidates: activeCriticalPayloadRows,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-governance-timelock-payloads.js",
    scope: "Read-only on-chain governance/timelock payload and role/delay inventory",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    thresholds: {
      maxLogBlocks: MAX_LOG_BLOCKS,
      logChunkBlocks: LOG_CHUNK_BLOCKS,
      maxLogsPerTarget: MAX_LOGS_PER_TARGET,
      lowDelaySeconds: LOW_DELAY_SECONDS,
    },
    summary,
    targets: TARGETS.map((target) => ({ ...target, address: ethers.getAddress(target.address), governor: target.governor ? ethers.getAddress(target.governor) : null })),
    timelockRows,
    topPayloadRows: topPayloadRows.slice(0, 40),
    payloadRows: enrichedPayloadRows,
    sourceErrors,
    requiredForRoutePositive: [
      "queued or active executable payload changes collateral, oracle, LTV/LT, caps, pause state, implementation, roles, or market listing",
      "decoded payload maps to a deployed target and concrete before/after config diff",
      "affected asset maps to material live lending/DEX/redeem consumers",
      "acquisition, borrow/redeem/liquidation, and unwind economics are exact-quoted and positive after gas/slippage/fees",
      "fork extraction proof demonstrates net value before any signed action",
    ],
    nextReadOnlyStep: activeCriticalPayloadRows > 0
      ? "Decode top active/queued payload target configs and join affected assets to consumer/economics artifacts before any fork."
      : "Keep governance payloads in watch mode; add target-specific config-diff decoders before treating proposals as fork-worthy.",
  };

  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  fs.writeFileSync(OUT_MD, renderReport(artifact));

  if (!QUIET) {
    console.log(`Governance timelock payloads: targets=${summary.targetsScanned} payloads=${enrichedPayloadRows.length} critical=${summary.decodedCriticalPayloadRows} activeCritical=${summary.activeCriticalPayloadRows} routePositive=0`);
    console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(sanitizeError(err));
  process.exitCode = 1;
});
