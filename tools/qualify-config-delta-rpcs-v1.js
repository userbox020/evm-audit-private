#!/usr/bin/env node
"use strict";
/**
 * qualify-config-delta-rpcs-v1.js
 *
 * Bounded, read-only endpoint capability qualifier for the config-delta axis
 * cycle-3 coverage restoration. Reads the standing-authorization inventory
 * `rpc_endpoints.txt` via shared-rpc (bounded candidate pool, family-capped,
 * annotation-filtered), then proves the ACTUAL required capability per chain
 * BEFORE any endpoint is selected:
 *
 *   - chain identity (eth_chainId)
 *   - deep canonical header at (tip - window + 1)
 *   - deep archive state: eth_getCode(probe) non-empty AND
 *     eth_getStorageAt(probe, 0x0) 32-byte word at the oldest window block
 *   - deep eth_getLogs over the full window with the tracker's chunk strategy
 *
 * Endpoint material is process-only. The exported `urlMap` carries real URLs
 * for in-process use by the runner; the persisted artifact is sanitized and
 * contains opaque family labels, capability outcomes and counts only.
 *
 * Usage:
 *   node tools/qualify-config-delta-rpcs-v1.js           # qualify + write artifact
 *   module.qualify({ chainIds })                         # programmatic
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parseRpcInventory, getOrigin } = require("./shared-rpc.js");
const { boundedFamilyCandidates, rankProviderUrls } = require("./lib/rpc-provider-reliability.js");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT_FILE = path.join(OUT_DIR, "config-delta-cycle3-rpc-qualification.json");

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");

// Cycle-3 required capability per chain, mirroring the scanner's cycle-1/3
// chunk strategy. `probeAddress` is a tracked registry contract that existed
// well before the oldest window block, so non-empty code there proves archive
// state rather than mere range acceptance.
const CHAINS = {
  1: { name: "ethereum", windowBlocks: 25000, chunkBlocks: 25000, minChunk: 2000, probeAddress: "0x64b761D848206f447Fe2dd461b0c635Ec39EbB27" },
  8453: { name: "base", windowBlocks: 90000, chunkBlocks: 2000, minChunk: 2000, probeAddress: "0x5731a04B1E775f0fdd454Bf70f3335886e9A96be" },
  42161: { name: "arbitrum", windowBlocks: 700000, chunkBlocks: 700000, minChunk: 50000, probeAddress: "0x8145eddDf43f50276641b55bd3AD95944510021E" },
  56: { name: "bnb", windowBlocks: 10000, chunkBlocks: 10000, minChunk: 2000, probeAddress: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" },
};

const MAX_CANDIDATES = 128;
const CONCURRENCY = 5;
const CALL_TIMEOUT_MS = 12000;
const MAX_PROBE_REQUESTS = 120;
const MAX_CANDIDATES_TESTED_PER_CHAIN = 18;
const QUALIFIED_FAMILY_TARGET = 2;
const QUALIFIED_CANDIDATE_TARGET = 3;
const INVENTORY_FILES = ["rpc_endpoints.txt", "base_full_stack_endpoints.md"];

const ZERO_SLOT = "0x" + "0".repeat(64);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hexBlock = (n) => "0x" + BigInt(n).toString(16);

function familyOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    const parts = host.split(".").filter(Boolean);
    const key = parts.length <= 2 ? host : `${parts.at(-2)}.${parts.at(-1)}`;
    return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
  } catch (_) {
    return null;
  }
}

async function rpc(url, method, params, timeoutMs = CALL_TIMEOUT_MS) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  const origin = getOrigin(url);
  if (origin) headers.origin = origin;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, code: "auth-or-origin-rejected" };
    if (res.status === 429) return { ok: false, code: "rate-limited" };
    if (res.status === 503 || res.status === 502) return { ok: false, code: "http-5xx" };
    const json = await res.json();
    if (!json || typeof json !== "object") return { ok: false, code: "non-json" };
    if (json.error) {
      const msg = String(json.error.message || "").toLowerCase();
      if (/prun|historical state|missing trie|state is not available|archive/i.test(msg)) return { ok: false, code: "historical-state-unavailable" };
      if (/limit|too many|range|exceed|large/i.test(msg)) return { ok: false, code: "query-limit" };
      if (/method not found|unsupported|not allowed/i.test(msg)) return { ok: false, code: "method-unsupported" };
      if (/rate/i.test(msg)) return { ok: false, code: "rate-limited" };
      return { ok: false, code: "rpc-rejected" };
    }
    if (!Object.hasOwn(json, "result")) return { ok: false, code: "response-schema-invalid" };
    return { ok: true, result: json.result };
  } catch (_) {
    return { ok: false, code: "transport" };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function isQuantity(value) {
  return typeof value === "string" && /^0x[0-9a-f]+$/i.test(value);
}
function isWord(value) {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
}
function isData(value) {
  return typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value);
}

// Mirror the scanner's fetchLogsBounded chunk strategy, bounded.
async function probeLogs(url, address, from, to, minChunk) {
  const stack = [{ from, to }];
  let requests = 0;
  const errors = [];
  const largestChunks = [];
  while (stack.length) {
    if (requests >= MAX_PROBE_REQUESTS) { errors.push("probe-request-cap"); break; }
    const span = stack.pop();
    if (span.from > span.to) continue;
    requests += 1;
    await sleep(60);
    const res = await rpc(url, "eth_getLogs", [{ address, topics: [], fromBlock: hexBlock(span.from), toBlock: hexBlock(span.to) }]);
    if (res.ok && Array.isArray(res.result)) { largestChunks.push(span.to - span.from + 1); continue; }
    if (res.ok) { errors.push("bad-result"); continue; }
    const width = span.to - span.from + 1;
    if (width > minChunk) {
      const mid = span.from + Math.floor(width / 2);
      stack.push({ from: span.from, to: mid });
      stack.push({ from: mid + 1, to: span.to });
    } else {
      errors.push(res.code);
    }
  }
  return { complete: errors.length === 0 && stack.length === 0, requests, errors, largestChunk: largestChunks.length ? Math.max(...largestChunks) : 0 };
}

async function probeCandidate(url, chainId, cfg, order) {
  const id = await rpc(url, "eth_chainId", []);
  if (!id.ok || Number(BigInt(id.result)) !== chainId) return { probeable: false, reason: id.ok ? "chain-mismatch" : id.code };
  const tipRes = await rpc(url, "eth_blockNumber", []);
  if (!tipRes.ok) return { probeable: false, reason: tipRes.code };
  const tip = Number(BigInt(tipRes.result));
  const fromBlock = Math.max(0, tip - cfg.windowBlocks + 1);
  const deepHex = hexBlock(fromBlock);

  const header = await rpc(url, "eth_getBlockByNumber", [deepHex, false]);
  const headerOk = header.ok && header.result && isQuantity(header.result.number) && isWord(header.result.hash);
  const code = await rpc(url, "eth_getCode", [cfg.probeAddress, deepHex]);
  const codeOk = code.ok && isData(code.result) && code.result !== "0x" && code.result.length > 2;
  const storage = await rpc(url, "eth_getStorageAt", [cfg.probeAddress, ZERO_SLOT, deepHex]);
  const storageOk = storage.ok && isWord(storage.result);
  const logs = await probeLogs(url, cfg.probeAddress, fromBlock, tip, cfg.minChunk);

  const archiveReady = headerOk && codeOk && storageOk;
  const logsReady = logs.complete;
  const qualified = archiveReady && logsReady;
  return {
    probeable: true,
    familyId: familyOf(url),
    order,
    tip,
    fromBlock,
    deepHeader: headerOk,
    deepCodeNonEmpty: codeOk,
    deepStorage: storageOk,
    archiveReady,
    logsReady,
    logsRequests: logs.requests,
    largestLogChunk: logs.largestChunk,
    singleShotWindow: logs.complete && logs.requests === 1,
    failureCategories: [...new Set([...(headerOk ? [] : [header.ok ? "header-schema-invalid" : header.code]), ...(codeOk ? [] : [code.ok ? "code-schema-empty" : code.code]), ...(storageOk ? [] : [storage.ok ? "storage-schema-invalid" : storage.code]), ...logs.errors])].sort(),
    qualified,
  };
}

// Combine the authorized EVM inventories, then re-normalize to the family cap
// across the merged pool so no single operator monopolises the candidates.
function loadCandidatePool() {
  const merged = [];
  const read = [];
  for (const file of INVENTORY_FILES) {
    try {
      const text = fs.readFileSync(path.join(WORKSPACE, file), "utf8");
      read.push(file);
      merged.push(...parseRpcInventory(text, { maxCandidates: MAX_CANDIDATES }));
    } catch (_) {
      // unavailable inventory is recorded, not fatal
    }
  }
  const deduped = [...new Set(merged)];
  const ranked = rankProviderUrls(deduped, deduped.length);
  const capped = boundedFamilyCandidates(ranked, { maximumFamilies: ranked.length, maximumCandidates: MAX_CANDIDATES, familyOf: familyOf });
  return { urls: capped, read };
}

async function qualify(options = {}) {
  const chainIds = Array.isArray(options.chainIds) && options.chainIds.length ? options.chainIds : [1, 8453, 42161, 56];
  const pool = loadCandidatePool();
  const inventory = pool.urls;
  const candidates = inventory.map((url, order) => ({ url, order, familyId: familyOf(url) }));

  // Stage 1: resolve real chain identity across the whole bounded pool once, so
  // per-chain capability budget is spent only on chain-matching candidates.
  const identity = await mapLimit(candidates, CONCURRENCY, async (candidate) => {
    const id = await rpc(candidate.url, "eth_chainId", []);
    if (!id.ok) return { ...candidate, chainId: null, code: id.code };
    try { return { ...candidate, chainId: Number(BigInt(id.result)) }; } catch (_) { return { ...candidate, chainId: null, code: "chain-id-schema-invalid" }; }
  });

  const chainResults = {};
  const urlMap = {};
  const selection = {};
  const identityStats = {
    candidates: identity.length,
    identified: identity.filter((c) => c.chainId !== null).length,
    byChain: chainIds.map((cid) => ({ chainId: cid, candidates: identity.filter((c) => c.chainId === cid).length })),
    failureCodes: [...new Set(identity.filter((c) => c.chainId === null).map((c) => c.code).filter(Boolean))].sort(),
  };

  for (const chainId of chainIds) {
    const cfg = CHAINS[chainId];
    if (!cfg) continue;
    const matching = identity.filter((c) => c.chainId === chainId).sort((a, b) => a.order - b.order);
    const tested = [];
    const qualified = [];
    for (const candidate of matching) {
      if (tested.length >= MAX_CANDIDATES_TESTED_PER_CHAIN) break;
      const result = await probeCandidate(candidate.url, chainId, cfg, candidate.order);
      tested.push({ familyId: candidate.familyId, ...result });
      if (result.qualified) {
        qualified.push({ url: candidate.url, familyId: candidate.familyId, ...result });
        const families = new Set(qualified.map((q) => q.familyId));
        if (qualified.length >= QUALIFIED_CANDIDATE_TARGET && families.size >= QUALIFIED_FAMILY_TARGET) break;
      }
    }
    // Select: primary = fewest log requests (largest single-shot chunk), then lowest order.
    qualified.sort((a, b) => a.logsRequests - b.logsRequests || a.order - b.order);
    const primary = qualified[0] || null;
    const secondary = qualified.find((q) => primary && q.familyId !== primary.familyId) || null;
    if (primary) urlMap[chainId] = primary.url;
    if (secondary) urlMap[`${chainId}_secondary`] = secondary.url;

    const familiesTested = new Set(tested.map((t) => t.familyId));
    const familiesQualified = new Set(qualified.map((q) => q.familyId));
    chainResults[chainId] = {
      chainName: cfg.name,
      windowBlocks: cfg.windowBlocks,
      chunkBlocks: cfg.chunkBlocks,
      minChunk: cfg.minChunk,
      candidatesInPool: candidates.length,
      chainMatchingCandidates: matching.length,
      candidatesTested: tested.length,
      familiesTested: familiesTested.size,
      qualifiedCandidates: qualified.length,
      qualifiedFamilies: familiesQualified.size,
      archiveReadyCount: tested.filter((t) => t.archiveReady).length,
      logsReadyCount: tested.filter((t) => t.logsReady).length,
      singleShotQualifiedCount: tested.filter((t) => t.qualified && t.singleShotWindow).length,
      capability: qualified.length > 0,
      independentFamiliesSelected: primary && secondary ? 2 : primary ? 1 : 0,
      failureCategories: [...new Set(tested.flatMap((t) => t.failureCategories || []).filter(Boolean))].sort(),
    };
    selection[chainId] = {
      primary: primary ? { family: primary.familyId, logsRequests: primary.logsRequests, largestChunk: primary.largestLogChunk } : null,
      secondary: secondary ? { family: secondary.familyId, logsRequests: secondary.logsRequests, largestChunk: secondary.largestLogChunk } : null,
    };
  }

  const artifact = {
    schema: "config-delta-rpc-qualification/v1",
    generatedFor: "config-delta-axis-cycle3-20260915",
    candidatePool: { inventoryCandidates: candidates.length, distinctFamilies: new Set(candidates.map((c) => c.familyId).filter(Boolean)).size, maxCandidates: MAX_CANDIDATES, inventoriesRead: pool.read },
    identity: identityStats,
    perChain: chainResults,
    selection,
    safety: {
      endpointsStored: false,
      endpointStringsPresent: false,
      hostnamesPersisted: false,
      envOrKeyFilesRead: false,
      reads: INVENTORY_FILES,
      artifactContainsCapabilityOutcomesOnly: true,
    },
    poolDigest: sha(inventory.join("\n")),
  };

  // Fail-closed sanitization, same contract as the scanner.
  const text = JSON.stringify(artifact);
  if (/(?:https?|wss?):\/\//i.test(text)) throw new Error("qualification artifact endpoint leak");
  if (/"(?:endpoint|rpc|rpcUrl|providerUrl|headers|header|credential|secret|apiKey|token|host|hostname|domain)"\s*:/i.test(text)) throw new Error("qualification artifact provider-key leak");

  return { urlMap, artifact, selection };
}

async function main() {
  const { artifact, selection } = await qualify();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  console.log(`qualification written ${path.relative(WORKSPACE, OUT_FILE)}`);
  for (const [chainId, row] of Object.entries(artifact.perChain)) {
    console.log(`chain=${chainId} ${row.chainName} window=${row.windowBlocks} tested=${row.candidatesTested} archiveReady=${row.archiveReadyCount} logsReady=${row.logsReadyCount} qualifiedFamilies=${row.qualifiedFamilies} capability=${row.capability} independentSelected=${row.independentFamiliesSelected}`);
  }
  console.log("selection=" + JSON.stringify(selection));
}

module.exports = { qualify, CHAINS, familyOf, OUT_FILE };

if (require.main === module) {
  main().catch((error) => {
    console.error("qualify-config-delta-rpcs failed: " + String(error && error.message ? error.message : "error").replace(/https?:\/\/\S+/g, "[redacted]"));
    process.exitCode = 1;
  });
}
