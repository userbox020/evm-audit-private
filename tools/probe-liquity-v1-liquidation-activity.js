#!/usr/bin/env node
"use strict";

// Read-only, bounded probe of Liquity V1 liquidation activity on Ethereum mainnet.
// Reads rpc_endpoints.txt in-process only; never prints or persists endpoint or
// provider identity. Qualifies a bounded candidate pool (chainId 1, finalized
// header consistency, runtime code at the audited addresses) before selecting
// at most two independent declared families for corroboration. Output is
// sanitized evidence only.

const fs = require("node:fs");
const path = require("node:path");
const { id, Interface } = require(path.join(__dirname, "node_modules", "ethers"));

const ROOT = path.resolve(__dirname, "..");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const REPORTS = path.join(ROOT, "reports", "raw", "fast");

const LIMITS = Object.freeze({
  candidatePool: 24,
  requests: 200,
  requestMs: 10_000,
  responseBytes: 2 * 1024 * 1024,
  windowBlocks: 4_000,
  maxWindows: 14,
  receiptSamples: 8,
});

// Candidate contract addresses to corroborate on-chain (deployments are public data).
const TM_CANDIDATE = "0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2"; // Liquity dev repo mainnetDeploymentOutput.json
const BO_CANDIDATE = "0x24179CD81c9e782A4096035f7eC97fB8B783e007"; // Liquity dev repo mainnetDeploymentOutput.json

const TOPIC_CANDIDATES = [
  { event: "TroveLiquidated", sig: "TroveLiquidated(address indexed borrower,uint256 debt,uint256 coll,uint8 operation)" },
  { event: "Liquidation", sig: "Liquidation(uint256 liquidatedDebt,uint256 liquidatedColl,uint256 collGasCompensation,uint256 LUSDGasCompensation)" },
];

const INTERFACES = new Map();
for (const candidate of TOPIC_CANDIDATES) {
  const topic0 = id(candidate.sig);
  if (!INTERFACES.has(topic0)) {
    INTERFACES.set(topic0, { name: candidate.event, iface: new Interface([`event ${candidate.sig}`]) });
  }
}

function fail(code) {
  throw new Error(code);
}

// ---- inventory (process-only) ----

function parseInventory(text) {
  const rows = [];
  let family = null;
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^\s*(?:#{1,6}\s+)?(?:-{3}\s+)?(?:provider|family|service)\s*[:=\-]\s*(.+?)\s*(?:-{3})?\s*$/i);
    if (heading) family = heading[1];
    const match = line.match(/https?:\/\/[^\s'"<>\[\]]+/i);
    if (!match) continue;
    const url = match[0].replace(/[)\],;]+$/, "");
    let parsed;
    try { parsed = new URL(url); } catch (_) { continue; }
    // keyless remote https only; anything credentialed/origin-bound stays unused
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) continue;
    if (parsed.pathname !== "/" && !/^\/(v3|api)?\/?$/.test(parsed.pathname)) continue;
    if (parsed.search || parsed.hash) continue;
    const metadata = line.replace(match[0], " ");
    if (/\b(?:origin|header|auth|bearer|x-api-key|key|token)\s*[:=]/i.test(metadata)) continue;
    const hint = /\bmainnet\b|\bethereum\b|\beth\b/i.test(`${heading ? heading[1] : ""} ${line}`);
    rows.push({ url, lineIndex: index, familyHint: family, ethereumHint: hint ? true : family ? family : null });
  }
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.url)) return false;
    seen.add(row.url);
    return true;
  });
}

function loadPool() {
  if (!fs.existsSync(INVENTORY)) fail("authorized-inventory-unavailable");
  const rows = parseInventory(fs.readFileSync(INVENTORY, "utf8"));
  const eligible = rows
    .filter((row) => row.unsupportedMode !== true)
    .filter((row) => row.ethereumHint !== false)
    .sort((a, b) => a.lineIndex - b.lineIndex)
    .slice(0, LIMITS.candidatePool);
  if (eligible.length === 0) fail("no-eligible-candidates");
  return eligible;
}

// ---- bounded transport ----

let requestCount = 0;

async function rpc(provider, method, params) {
  if (requestCount >= LIMITS.requests) fail("request-budget-exhausted");
  requestCount += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.requestMs);
  try {
    const response = await fetch(provider.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: requestCount, method, params }),
    });
    const raw = await response.arrayBuffer();
    if (raw.byteLength > LIMITS.responseBytes) fail("response-bound-exceeded");
    const body = JSON.parse(Buffer.from(raw).toString("utf8"));
    if (body.error) throw new Error("rpc-error");
    if (Array.isArray(body) || body.result === undefined) throw new Error("rpc-shape-failure");
    return body.result;
  } catch (error) {
    if (error instanceof Error && (error.message === "rpc-error" || error.message === "rpc-shape-failure")) throw error;
    // single polite retry on transport-level failure
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (requestCount >= LIMITS.requests) throw new Error("transport-failure");
    requestCount += 1;
    const retryController = new AbortController();
    const retryTimer = setTimeout(() => retryController.abort(), LIMITS.requestMs);
    try {
      const response = await fetch(provider.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: retryController.signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: requestCount, method, params }),
      });
      const raw = await response.arrayBuffer();
      if (raw.byteLength > LIMITS.responseBytes) fail("response-bound-exceeded");
      const body = JSON.parse(Buffer.from(raw).toString("utf8"));
      if (body.error) throw new Error("rpc-error");
      if (Array.isArray(body) || body.result === undefined) throw new Error("rpc-shape-failure");
      return body.result;
    } finally {
      clearTimeout(retryTimer);
    }
  } finally {
    clearTimeout(timer);
  }
}

function isQuantity(value) {
  return typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
}

function isHash(value) {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
}

async function qualify(provider) {
  const stage = (reason) => { provider.stage = reason; return null; };
  let chainId;
  try {
    chainId = await rpc(provider, "eth_chainId", []);
  } catch (error) {
    return stage(error.message);
  }
  if (chainId !== "0x1") return stage("chain-not-mainnet");
  let finalized;
  try {
    finalized = await rpc(provider, "eth_getBlockByNumber", ["finalized", false]);
  } catch (error) {
    return stage(error.message);
  }
  if (!finalized || !isHash(finalized.hash) || !isQuantity(finalized.number)) return stage("finalized-header-invalid");
  let recheck;
  try {
    recheck = await rpc(provider, "eth_getBlockByNumber", [finalized.number, false]);
  } catch (error) {
    return stage(error.message);
  }
  if (!recheck || recheck.hash !== finalized.hash) return stage("finalized-recheck-mismatch");
  let tmCode;
  let boCode;
  try {
    tmCode = await rpc(provider, "eth_getCode", [TM_CANDIDATE, "latest"]);
    boCode = await rpc(provider, "eth_getCode", [BO_CANDIDATE, "latest"]);
  } catch (error) {
    return stage(error.message);
  }
  if (typeof tmCode !== "string" || tmCode.length <= 2) return stage("tm-code-empty");
  provider.stage = "ok";
  return { tmCodeBytes: (tmCode.length - 2) / 2, boCodePresent: typeof boCode === "string" && boCode.length > 2, finalized };
}

function familyAlias(index) {
  return `f${String.fromCharCode(65 + index)}`;
}

// ---- liquidation event scan ----

function decodeLog(log) {
  const topic0 = (log.topics && log.topics[0]) || "";
  const entry = INTERFACES.get(topic0);
  if (!entry) return null;
  try {
    const parsed = entry.iface.parseLog({ topics: log.topics, data: log.data || "0x" });
    if (entry.name === "TroveLiquidated") {
      return {
        event: "TroveLiquidated",
        borrower: parsed.args.borrower.toLowerCase(),
        debt: parsed.args.debt,
        coll: parsed.args.coll,
        operation: Number(parsed.args.operation),
        blockNumber: Number(log.blockNumber),
        txHash: log.transactionHash,
      };
    }
    return { event: entry.name, liquidatedDebt: parsed.args.liquidatedDebt, liquidatedColl: parsed.args.liquidatedColl, collGasComp: parsed.args.collGasCompensation, lusdGasComp: parsed.args.LUSDGasCompensation, blockNumber: Number(log.blockNumber), txHash: log.transactionHash };
  } catch (_) {
    return null;
  }
}

async function scanWindow(provider, fromBlock, toBlock) {
  const topics = [Object.keys(INTERFACES)];
  const filter = { address: TM_CANDIDATE, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}`, topics };
  const logs = await rpc(provider, "eth_getLogs", [filter]);
  if (!Array.isArray(logs)) fail("logs-shape-failure");
  return logs.map(decodeLog).filter(Boolean);
}

async function scanHistory(provider, latestBlock) {
  const windows = [];
  const span = Math.max(1, Math.min(LIMITS.windowBlocks, Math.ceil((latestBlock - 1) / LIMITS.maxWindows)));
  for (let index = 0; index < LIMITS.maxWindows; index += 1) {
    const toBlock = latestBlock - index * span;
    const fromBlock = Math.max(1, toBlock - span + 1);
    let events;
    let reason = null;
    try {
      events = await scanWindow(provider, fromBlock, toBlock);
    } catch (firstError) {
      // adaptive narrowing: many providers cap log-range size
      const narrow = Math.max(500, Math.floor(span / 4));
      events = [];
      let subReason = firstError.message === "rpc-error" ? "provider-limits" : "transport-or-limit";
      let anyNarrowOk = false;
      for (let start = fromBlock; start <= toBlock && requestCount < LIMITS.requests; start += narrow) {
        const end = Math.min(toBlock, start + narrow - 1);
        try {
          const part = await scanWindow(provider, start, end);
          events = events.concat(part);
          anyNarrowOk = true;
        } catch (_) {
          // skip failed sub-window; keep fail-closed reason
        }
      }
      if (!anyNarrowOk) reason = subReason;
      else if (subReason === "transport-or-limit") reason = "partial";
      if (reason === null) subReason = null;
      windows.push(reason ? { fromBlock, toBlock, error: reason, events: null } : { fromBlock, toBlock, events });
      if (windows.some((window) => Array.isArray(window.events) && window.events.length > 0) && windows.filter((window) => Array.isArray(window.events)).length >= 2) break;
      continue;
    }
    windows.push({ fromBlock, toBlock, events });
    if (windows.some((window) => window.events.length > 0) && windows.filter((window) => Array.isArray(window.events)).length >= 2) break;
  }
  return windows;
}

function summarizeWindow(window) {
  if (!Array.isArray(window.events)) return { ...window, count: null };
  const liquidations = window.events.filter((event) => event.event === "TroveLiquidated");
  const aggregates = window.events.filter((event) => event.event === "Liquidation");
  const debt = liquidations.reduce((sum, event) => sum + event.debt, 0n) + aggregates.reduce((sum, event) => sum + event.liquidatedDebt, 0n);
  const coll = liquidations.reduce((sum, event) => sum + event.coll, 0n) + aggregates.reduce((sum, event) => sum + event.liquidatedColl, 0n);
  const collGasComp = aggregates.reduce((sum, event) => sum + event.collGasComp, 0n);
  const lusdGasComp = aggregates.reduce((sum, event) => sum + event.lusdGasComp, 0n);
  const borrowers = new Set(liquidations.map((event) => event.borrower));
  return {
    fromBlock: window.fromBlock,
    toBlock: window.toBlock,
    count: liquidations.length,
    aggregateEvents: aggregates.length,
    distinctBorrowers: borrowers.size,
    totalLiquidatedDebtWei: debt.toString(),
    totalLiquidatedCollWei: coll.toString(),
    totalCollGasCompWei: collGasComp.toString(),
    totalLusdGasCompWei: lusdGasComp.toString(),
    samples: liquidations.slice(-5).map((event) => ({
      borrower: event.borrower,
      debtWei: event.debt.toString(),
      collWei: event.coll.toString(),
      operation: event.operation,
      blockNumber: event.blockNumber,
    })),
    aggregateSamples: aggregates.slice(-3).map((event) => ({
      debtWei: event.liquidatedDebt.toString(),
      collWei: event.liquidatedColl.toString(),
      collGasCompWei: event.collGasComp.toString(),
      lusdGasCompWei: event.lusdGasComp.toString(),
      blockNumber: event.blockNumber,
      txHash: event.txHash,
    })),
  };
}

async function initiatorSample(provider, events) {
  const receipts = [];
  const targets = events.filter((event) => event.event === "TroveLiquidated").slice(-LIMITS.receiptSamples);
  for (const event of targets) {
    try {
      const receipt = await rpc(provider, "eth_getTransactionReceipt", [event.txHash]);
      if (receipt && typeof receipt.from === "string") {
        receipts.push({ initiator: receipt.from.toLowerCase(), borrower: event.borrower, blockNumber: event.blockNumber });
      }
    } catch (_) {
      receipts.push({ error: "receipt-unavailable" });
    }
  }
  return receipts;
}

// ---- main ----

async function main() {
  const pool = loadPool();
  const qualified = [];
  const attempts = [];
  for (const provider of pool) {
    if (requestCount >= LIMITS.requests * 0.6) break;
    try {
      const result = await qualify(provider);
      attempts.push({ qualified: Boolean(result), stage: provider.stage || (result ? "ok" : "unknown") });
      if (result) qualified.push({ provider, checks: result });
    } catch (error) {
      attempts.push({ qualified: false, stage: error.message });
    }
    if (qualified.length >= 2) break;
  }
  if (qualified.length === 0) {
    if (process.env.PROBE_DEBUG === "1") {
      const stageCounts = {};
      for (const attempt of attempts) {
        stageCounts[attempt.stage || "unknown"] = (stageCounts[attempt.stage || "unknown"] || 0) + 1;
      }
      process.stdout.write(JSON.stringify({ debug: true, poolSize: pool.length, attempts: attempts.length, stageCounts }) + "\n");
    }
    fail("no-qualified-provider");
  }

  const selected = qualified.slice(0, 2);
  const results = [];
  let latest = null;
  for (const [index, entry] of selected.entries()) {
    const alias = familyAlias(index);
    const latestBlock = await rpc(entry.provider, "eth_getBlockByNumber", ["latest", false]);
    if (!latestBlock || !isQuantity(latestBlock.number)) fail("latest-block-failure");
    const latestNumber = Number(latestBlock.number);
    if (latest === null) latest = latestNumber;
    const windows = await scanHistory(entry.provider, latestNumber);
    const recentWindow = windows.find((window) => Array.isArray(window.events));
    const summary = {
      family: alias,
      declaredFamilyIndependent: entry.provider.familyHint != null,
      tmCodeBytes: entry.checks.tmCodeBytes,
      borrowerOpsCodePresent: entry.checks.boCodePresent,
      latestBlock: latestNumber,
      windows: windows.map(summarizeWindow),
    };
    if (recentWindow) {
      summary.initiatorSample = await initiatorSample(entry.provider, recentWindow.events);
    }
    results.push(summary);
  }

  const topicWitness = {};
  for (const result of results) {
    for (const window of result.windows) {
      if (!Array.isArray(window.events)) continue;
      for (const event of window.events) {
        if (!topicWitness[event.event]) topicWitness[event.event] = 0;
        topicWitness[event.event] += 1;
      }
    }
  }

  const artifact = {
    schema: "liquity-v1-liquidation-activity-probe/v1",
    generatedAt: new Date().toISOString(),
    readonly: true,
    endpoints: "process-only",
    families: results.map((result) => result.family),
    candidatesQualified: attempts.length,
    corroboratedAddresses: {
      troveManager: TM_CANDIDATE,
      borrowerOperations: BO_CANDIDATE,
      note: "code-presence + topic-presence corroboration only; exact-source checkout still required",
    },
    topicsWitnessed: topicWitness,
    perFamily: results,
    limitations: [
      "initiator identity comes only from sampled receipts; competition is not fully enumerable from events",
      "gas compensation is gross, not net; initiator gas is paid separately",
      "windows are bounded by provider log-range limits and request budget",
    ],
  };

  const outPath = path.join(REPORTS, `liquity-v1-liquidation-activity-probe-${Date.now()}.json`);
  fs.mkdirSync(REPORTS, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");

  process.stdout.write(JSON.stringify({
    ok: true,
    artifact: path.relative(ROOT, outPath),
    families: artifact.families,
    candidatesQualified: artifact.candidatesQualified,
    topicsWitnessed: topicWitness,
    perFamily: results.map((result) => ({
      family: result.family,
      latestBlock: result.latestBlock,
      windows: result.windows.map((window) => ({
        fromBlock: window.fromBlock,
        toBlock: window.toBlock,
        count: window.count ?? "error",
        totalLusdGasCompWei: window.totalLusdGasCompWei ?? null,
        totalCollGasCompWei: window.totalCollGasCompWei ?? null,
        distinctBorrowers: window.distinctBorrowers ?? null,
      })),
      initiatorSample: result.initiatorSample,
    })),
  }, null, 2) + "\n");
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, reason: error.message }) + "\n");
  process.exitCode = 1;
});
