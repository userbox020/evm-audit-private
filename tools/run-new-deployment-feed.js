#!/usr/bin/env node
"use strict";
/*
 * tools/run-new-deployment-feed.js
 *
 * Bounded, read-only candidate-ACQUISITION feed for freshly deployed contracts.
 * It reads tools/new-deployment-factories.json, resolves RPC endpoints from
 * rpc_endpoints.txt process-only via tools/shared-rpc.js, and issues a bounded
 * eth_getLogs window per configured factory, decoding the address of each newly
 * created child contract from the configured creation event.
 *
 * Properties:
 *   - Read-only. No signing, transactions, broadcast, or state changes.
 *   - Endpoint values are never printed, persisted, or written to artifacts.
 *   - Per-factory fail-closed: one factory failing never aborts the others.
 *   - Bounded: window blocks, total blocks, total RPC calls, and candidate caps.
 *   - CLI is gated behind `--run-once`; without it the tool prints usage and
 *     exits non-zero without touching the network or filesystem.
 *
 * Usage:
 *   node tools/run-new-deployment-feed.js --run-once [--window-blocks=5000]
 *        [--config=path] [--out=path] [--max-candidates=500]
 *
 * Output: reports/monitor/new-deployment-feed.json (schema new-deployment-feed/v1).
 */

const fs = require("node:fs");
const path = require("node:path");
const {
  loadRpcUrls,
  resolveRpc,
  rpcCall: sharedRpcCall,
  sanitizeError,
} = require("./shared-rpc.js");

const SCHEMA = "new-deployment-feed/v1";
const DEFAULT_CONFIG_FILE = path.join(__dirname, "new-deployment-factories.json");
const DEFAULT_OUTPUT_FILE = path.join(__dirname, "..", "reports", "monitor", "new-deployment-feed.json");
const DEFAULT_WINDOW_BLOCKS = 5000;
const MAX_WINDOW_BLOCKS = 5000;
const MAX_RPC_CALLS = 64;
const MAX_TOTAL_BLOCKS = 50_000;
const MAX_CANDIDATES_TOTAL = 500;
const MAX_CANDIDATES_PER_FACTORY = 100;
const MAX_FACTORIES_PER_CHAIN = 32;
const MAX_CONFIG_BYTES = 1024 * 1024;

const USAGE = [
  "new-deployment-feed: read-only candidate acquisition for freshly deployed contracts.",
  "",
  "Usage:",
  "  node tools/run-new-deployment-feed.js --run-once [options]",
  "",
  "Options:",
  "  --run-once                 required; acknowledge running one bounded, read-only pass",
  "  --window-blocks=<N>        recent block window per factory (default 5000, max 5000)",
  "  --max-candidates=<N>       global candidate cap for the run (default 500, max 500)",
  "  --config=<path>            factory config (default tools/new-deployment-factories.json)",
  "  --out=<path>               artifact path (default reports/monitor/new-deployment-feed.json)",
  "",
  "Read-only. Never signs, broadcasts, or persists endpoint values.",
].join("\n");

class FeedError extends Error {
  constructor(code) {
    super(code);
    this.name = "FeedError";
    this.code = code;
  }
}

function fail(code) {
  throw new FeedError(code);
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TOPIC_RE = /^0x[0-9a-fA-F]{64}$/;
const FACTORY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const CHAIN_ID_RE = /^[1-9][0-9]{0,9}$/;
const FORBIDDEN_KEY_RE = /^(?:url|urls|endpoint|endpoints|rpc|rpcUrl|rpcEndpoints|provider|providers|authorization|headers|token|secret|secretValue|apiKey|api_key|privateKey)$/i;
const URL_LIKE_RE = /(?:https?|wss?|ftp):\/\/|\bwww\./i;

function isAddress(value) {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

function normalizeAddress(value) {
  return isAddress(value) ? "0x" + value.slice(2).toLowerCase() : null;
}

function hexToInt(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  let parsed;
  try {
    parsed = Number(BigInt(value));
  } catch (_) {
    return null;
  }
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function nullIfInvalid(value, test) {
  return test(value) ? value : null;
}

function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function safeLabel(value, fallback) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return fallback;
  if (URL_LIKE_RE.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return fallback;
  return value;
}

/* ------------------------------------------------------------------ *
 * Config loading + validation
 * ------------------------------------------------------------------ */
function validateConfig(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) fail("INVALID_CONFIG");
  if (config.version !== 1) fail("UNSUPPORTED_CONFIG_VERSION");
  const chains = config.chains;
  if (chains === null || typeof chains !== "object" || Array.isArray(chains)) fail("INVALID_CONFIG_CHAINS");
  const chainIds = Object.keys(chains);
  if (chainIds.length === 0) fail("EMPTY_CONFIG");
  for (const chainId of chainIds) {
    if (!CHAIN_ID_RE.test(chainId)) fail("INVALID_CHAIN_ID");
    const list = chains[chainId];
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_FACTORIES_PER_CHAIN) {
      fail("INVALID_FACTORY_LIST");
    }
    const seen = new Set();
    for (const entry of list) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail("INVALID_FACTORY");
      if (typeof entry.id !== "string" || !FACTORY_ID_RE.test(entry.id)) fail("INVALID_FACTORY_ID");
      if (seen.has(entry.id)) fail("DUPLICATE_FACTORY_ID");
      seen.add(entry.id);
      if (!isAddress(entry.address)) fail("INVALID_FACTORY_ADDRESS");
      if (typeof entry.topic0 !== "string" || !TOPIC_RE.test(entry.topic0)) fail("INVALID_TOPIC0");
      if (!(entry.createdTopic === undefined || entry.createdTopic === null
        || (Number.isSafeInteger(entry.createdTopic) && entry.createdTopic >= 1 && entry.createdTopic <= 4))) {
        fail("INVALID_CREATED_TOPIC");
      }
      if (!(entry.createdIndex === undefined || entry.createdIndex === null
        || Number.isSafeInteger(entry.createdIndex))) {
        fail("INVALID_CREATED_INDEX");
      }
      if (entry.label !== undefined) {
        if (typeof entry.label !== "string" || entry.label.length === 0 || entry.label.length > 200
          || URL_LIKE_RE.test(entry.label) || /[\u0000-\u001f\u007f]/.test(entry.label)) {
          fail("INVALID_FACTORY_LABEL");
        }
      }
    }
  }
  return config;
}

function loadConfig(configPath, fsImpl = fs) {
  const target = typeof configPath === "string" ? configPath : DEFAULT_CONFIG_FILE;
  let raw;
  try {
    const stat = fsImpl.statSync(target);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) fail("CONFIG_TOO_LARGE");
    raw = fsImpl.readFileSync(target, "utf8");
  } catch (error) {
    if (error instanceof FeedError) throw error;
    fail("CONFIG_UNREADABLE");
  }
  try {
    return JSON.parse(raw);
  } catch (_) {
    fail("CONFIG_INVALID_JSON");
  }
}

/* ------------------------------------------------------------------ *
 * Log decoding
 * ------------------------------------------------------------------ */
function decodeCreatedAddress(log, entry) {
  if (log === null || typeof log !== "object" || Array.isArray(log)) return null;
  const topics = Array.isArray(log.topics) ? log.topics : [];
  const configuredTopic = Number.isSafeInteger(entry.createdTopic) ? entry.createdTopic : 1;
  if (topics.length > configuredTopic && typeof topics[configuredTopic] === "string"
    && TOPIC_RE.test(topics[configuredTopic])) {
    const fromTopic = normalizeAddress("0x" + topics[configuredTopic].slice(-40));
    return fromTopic === "0x0000000000000000000000000000000000000000" ? null : fromTopic;
  }
  if (typeof log.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(log.data)) return null;
  const body = log.data.slice(2);
  for (let offset = 0; offset + 64 <= body.length; offset += 64) {
    const word = body.slice(offset, offset + 64);
    if (!/^0{24}[0-9a-fA-F]{40}$/.test(word)) continue;
    let value;
    try {
      value = BigInt("0x" + word);
    } catch (_) {
      continue;
    }
    // Reject low-order integers (e.g. a packed int24 tick) that merely look like
    // an address-shaped word in the event data.
    if (value < 2n ** 32n) continue;
    const decoded = normalizeAddress("0x" + word.slice(24));
    if (decoded) return decoded;
  }
  return null;
}

function buildCandidate(log, entry) {
  const newAddress = decodeCreatedAddress(log, entry);
  if (!newAddress) return null;
  const blockNumber = hexToInt(log.blockNumber);
  if (blockNumber === null) return null;
  const transactionHash = nullIfInvalid(log.transactionHash, (v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v));
  return {
    factoryId: entry.id,
    label: safeLabel(entry.label, entry.id),
    newAddress,
    blockNumber,
    transactionHash: transactionHash === null ? null : transactionHash.toLowerCase(),
    topic0: entry.topic0.toLowerCase(),
  };
}

/* ------------------------------------------------------------------ *
 * Artifact sanitization (defense in depth: drop endpoint-shaped data)
 * ------------------------------------------------------------------ */
function redactArtifact(value) {
  if (typeof value === "string") return URL_LIKE_RE.test(value) ? "[redacted]" : value;
  if (Array.isArray(value)) return value.map(redactArtifact);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY_RE.test(key)) continue;
    out[key] = redactArtifact(child);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Feed run
 * ------------------------------------------------------------------ */
async function runFeed(options = {}) {
  const fsImpl = options.fs || fs;
  const rpcCall = typeof options.rpcCall === "function" ? options.rpcCall : sharedRpcCall;
  const resolver = typeof options.resolver === "function" ? options.resolver : resolveRpc;
  const now = Number.isSafeInteger(options.now) ? options.now : Date.now();
  const windowBlocks = boundedInteger(options.windowBlocks, DEFAULT_WINDOW_BLOCKS, MAX_WINDOW_BLOCKS);
  const maxRpcCalls = boundedInteger(options.maxRpcCalls, MAX_RPC_CALLS, MAX_RPC_CALLS);
  const maxTotalBlocks = boundedInteger(options.maxTotalBlocks, MAX_TOTAL_BLOCKS, MAX_TOTAL_BLOCKS);
  const maxCandidatesTotal = boundedInteger(options.maxCandidatesTotal, MAX_CANDIDATES_TOTAL, MAX_CANDIDATES_TOTAL);
  const maxCandidatesPerFactory = boundedInteger(
    options.maxCandidatesPerFactory, MAX_CANDIDATES_PER_FACTORY, MAX_CANDIDATES_PER_FACTORY);

  const config = options.config !== undefined
    ? validateConfig(options.config)
    : validateConfig(loadConfig(options.configPath, fsImpl));

  let urls = options.urls;
  if (urls === undefined) {
    try {
      urls = loadRpcUrls();
    } catch (_) {
      urls = [];
    }
  }

  const failures = [];
  const chains = [];
  const seen = new Map();
  const stats = {
    windowBlocks,
    chains: Object.keys(config.chains).length,
    factories: 0,
    factoriesSucceeded: 0,
    factoriesFailed: 0,
    rpcCalls: 0,
    blocksScanned: 0,
    logsReturned: 0,
    decoded: 0,
    duplicates: 0,
    candidates: 0,
    truncated: false,
  };

  for (const [chainIdText, factories] of Object.entries(config.chains)) {
    const chainId = Number(chainIdText);
    stats.factories += factories.length;
    const chainEntry = { chainId, fromBlock: null, toBlock: null, candidates: [] };
    chains.push(chainEntry);

    if (stats.rpcCalls >= maxRpcCalls) {
      for (const entry of factories) {
        failures.push({ chainId, factoryId: entry.id, errorClass: "budget-exhausted" });
        stats.factoriesFailed++;
      }
      continue;
    }

    let rpc = null;
    try {
      rpc = await resolver(chainId, urls, { capability: "logs", rpcCall });
    } catch (_) {
      rpc = null;
    }
    if (typeof rpc !== "string" || rpc.length === 0) {
      for (const entry of factories) {
        failures.push({ chainId, factoryId: entry.id, errorClass: "no-rpc" });
        stats.factoriesFailed++;
      }
      continue;
    }

    let head = null;
    stats.rpcCalls++;
    try {
      head = hexToInt(await rpcCall(rpc, "eth_blockNumber", []));
    } catch (_) {
      head = null;
    }
    if (head === null) {
      for (const entry of factories) {
        failures.push({ chainId, factoryId: entry.id, errorClass: "no-head" });
        stats.factoriesFailed++;
      }
      continue;
    }

    const toBlock = head;
    const fromBlock = Math.max(0, head - windowBlocks + 1);
    chainEntry.fromBlock = fromBlock;
    chainEntry.toBlock = toBlock;
    const chainSeen = new Set();

    for (const entry of factories) {
      if (stats.rpcCalls >= maxRpcCalls) {
        failures.push({ chainId, factoryId: entry.id, errorClass: "budget-exhausted" });
        stats.factoriesFailed++;
        continue;
      }
      if (stats.blocksScanned + windowBlocks > maxTotalBlocks) {
        failures.push({ chainId, factoryId: entry.id, errorClass: "block-budget-exhausted" });
        stats.factoriesFailed++;
        continue;
      }
      if (chainEntry.candidates.length >= maxCandidatesTotal) {
        failures.push({ chainId, factoryId: entry.id, errorClass: "candidate-cap" });
        stats.factoriesFailed++;
        continue;
      }

      stats.rpcCalls++;
      stats.blocksScanned += windowBlocks;
      let logs;
      try {
        logs = await rpcCall(rpc, "eth_getLogs", [{
          address: entry.address,
          topics: [entry.topic0],
          fromBlock: "0x" + fromBlock.toString(16),
          toBlock: "0x" + toBlock.toString(16),
        }]);
      } catch (_) {
        failures.push({ chainId, factoryId: entry.id, errorClass: "logs-unavailable" });
        stats.factoriesFailed++;
        continue;
      }
      if (!Array.isArray(logs)) {
        failures.push({ chainId, factoryId: entry.id, errorClass: "logs-unavailable" });
        stats.factoriesFailed++;
        continue;
      }
      stats.factoriesSucceeded++;
      stats.logsReturned += logs.length;

      let perFactory = 0;
      for (const log of logs) {
        if (log === null || typeof log !== "object") continue;
        if (log.removed === true) continue;
        const logTopic0 = Array.isArray(log.topics) && typeof log.topics[0] === "string" ? log.topics[0].toLowerCase() : null;
        if (logTopic0 !== entry.topic0.toLowerCase()) continue;
        const candidate = buildCandidate(log, entry);
        if (!candidate) continue;
        stats.decoded++;
        const dedupeKey = chainId + ":" + candidate.newAddress;
        if (seen.has(dedupeKey) || chainSeen.has(candidate.newAddress)) {
          stats.duplicates++;
          continue;
        }
        if (perFactory >= maxCandidatesPerFactory) {
          stats.truncated = true;
          continue;
        }
        if (stats.candidates >= maxCandidatesTotal) {
          stats.truncated = true;
          continue;
        }
        seen.set(dedupeKey, { chainId, factoryId: entry.id });
        chainSeen.add(candidate.newAddress);
        chainEntry.candidates.push(candidate);
        perFactory++;
        stats.candidates++;
      }
    }

    chainEntry.candidates.sort((a, b) => a.blockNumber - b.blockNumber
      || a.newAddress.localeCompare(b.newAddress));
  }

  const artifact = redactArtifact({
    schema: SCHEMA,
    generatedAt: new Date(now).toISOString(),
    windowBlocks,
    chains,
    failures,
    stats,
    safety: {
      readOnly: true,
      networkAccess: true,
      signing: false,
      transactions: false,
      broadcast: false,
      endpointValuesPersisted: false,
      candidateAcquisitionOnly: true,
    },
  });

  let outputPath = null;
  if (options.write !== false) {
    outputPath = typeof options.outputPath === "string" && options.outputPath.length > 0
      ? options.outputPath : DEFAULT_OUTPUT_FILE;
    fsImpl.mkdirSync(path.dirname(outputPath), { recursive: true });
    fsImpl.writeFileSync(outputPath, JSON.stringify(artifact, null, 2) + "\n", { mode: 0o600 });
  }

  return { artifact, outputPath, written: outputPath !== null };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const args = {
    runOnce: false,
    configPath: null,
    outputPath: null,
    windowBlocks: null,
    maxCandidatesTotal: null,
  };
  for (const token of Array.isArray(argv) ? argv : []) {
    if (typeof token !== "string") continue;
    if (token === "--run-once") { args.runOnce = true; continue; }
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq === -1) continue;
    const key = token.slice(2, eq);
    const value = token.slice(eq + 1);
    if (key === "config") args.configPath = value;
    else if (key === "out") args.outputPath = value;
    else if (key === "window-blocks") args.windowBlocks = value;
    else if (key === "max-candidates") args.maxCandidatesTotal = value;
  }
  return args;
}

function cliGate(argv) {
  const args = parseArgs(argv);
  return { run: args.runOnce === true, args };
}

async function main(argv) {
  const gate = cliGate(argv);
  if (!gate.run) {
    process.stdout.write(USAGE + "\n");
    process.exitCode = 1;
    return { ran: false };
  }
  const args = gate.args;
  const { artifact, outputPath } = await runFeed({
    configPath: args.configPath || undefined,
    outputPath: args.outputPath || undefined,
    windowBlocks: args.windowBlocks === null ? undefined : Number(args.windowBlocks),
    maxCandidatesTotal: args.maxCandidatesTotal === null ? undefined : Number(args.maxCandidatesTotal),
  });
  const summary = {
    schema: artifact.schema,
    generatedAt: artifact.generatedAt,
    windowBlocks: artifact.windowBlocks,
    chains: artifact.chains.map((c) => ({ chainId: c.chainId, fromBlock: c.fromBlock, toBlock: c.toBlock, candidates: c.candidates.length })),
    failures: artifact.failures.length,
    output: outputPath,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  return { ran: true, artifact, outputPath };
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    const code = error instanceof FeedError ? error.code : sanitizeError(error, "feed-failed");
    process.stderr.write("new-deployment-feed: " + code + "\n");
    process.exitCode = 1;
  });
}

module.exports = {
  SCHEMA,
  USAGE,
  DEFAULT_WINDOW_BLOCKS,
  MAX_WINDOW_BLOCKS,
  MAX_RPC_CALLS,
  MAX_TOTAL_BLOCKS,
  MAX_CANDIDATES_TOTAL,
  MAX_CANDIDATES_PER_FACTORY,
  FeedError,
  validateConfig,
  loadConfig,
  decodeCreatedAddress,
  buildCandidate,
  redactArtifact,
  runFeed,
  parseArgs,
  cliGate,
  main,
};
