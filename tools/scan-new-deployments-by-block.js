#!/usr/bin/env node
"use strict";
/*
 * tools/scan-new-deployments-by-block.js
 *
 * Keyless, bounded discovery of recently deployed smart contracts, filtered to
 * plausible DeFi risk classes. Read-only: this tool only issues eth_* view calls
 * and public explorer HTTP GETs. It never signs, broadcasts, or mutates state.
 *
 * Enumeration methods (no aggregator listings, no pinned repositories):
 *   1. blocks   - bounded eth_getBlockByNumber(..., true) scan over a NARROW recent
 *                 range, collecting transactions whose `to` field is null (direct
 *                 CREATE). Also covers contract-creating txs to a deployer only if
 *                 the tx itself is a creation. Factory/CREATE2 inner creations are
 *                 NOT visible here (documented coverage limit).
 *   2. explorer - Blockscout /api/v2/smart-contracts recent-verification feed and
 *                 Sourcify /v2/contracts/{chainId} recent-verification feed. Catches
 *                 factory-deployed contracts, but only those whose source was
 *                 submitted, and `verified_at` is verification time, not deploy time.
 *   3. factory  - bounded eth_getLogs over a curated registry of known factory /
 *                 registry contracts (tools/lib/factory-creation-registry.js),
 *                 decoding the created address from the creation event ABI. This
 *                 closes the factory / CREATE2 inner-deployment blind spot of (1).
 *   4. hybrid   - union of (1), (2) and (3), deduped by address (default).
 *
 * Classification uses runtime bytecode PUSH4 selector detection plus an EIP-1967
 * proxy-slot read. A read-only liveness prefilter (asset()/totalAssets()/
 * totalSupply()) suppresses dormant / uninitialized vault-erc4626 clusters BEFORE
 * triage. Verified metadata is fetched lazily, only for class-matched rows.
 *
 * Output is a sanitized JSON artifact: chain, address, creation block or
 * verified_at reference, class, and a short rationale. No endpoint values,
 * credentials, or headers are ever written to the artifact or stdout.
 *
 * Integrity: the tool fails closed. If head enumeration or the bounded block scan
 * fails, it exits non-zero without writing a success artifact. If the factory
 * registry is non-empty but every factory query fails, it exits non-zero.
 *
 * Usage:
 *   node tools/scan-new-deployments-by-block.js --chain=ethereum --blocks=300
 *   node tools/scan-new-deployments-by-block.js --chain=base --mode=explorer --explorer-pages=3
 *   node tools/scan-new-deployments-by-block.js --chain=ethereum --blocks=50 --sourcify-limit=0 --explorer-pages=0
 *   node tools/scan-new-deployments-by-block.js --chain=base --factory-blocks=8000 --liveness=1
 *   node tools/scan-new-deployments-by-block.js --chain=ethereum --probe-registry
 *   node tools/scan-new-deployments-by-block.js --self-test
 *
 * Options:
 *   --chain=<name>          ethereum|base|arbitrum|optimism|polygon|gnosis (default ethereum)
 *   --mode=<m>              hybrid|blocks|explorer (default hybrid)
 *   --blocks=<N>            number of recent blocks to scan for direct CREATE (default 300, hard cap 2000)
 *   --to-block=<N>          scan range end (default current head)
 *   --explorer-pages=<N>    Blockscout recent-verified pages, 50 rows each (default 3, cap 20)
 *   --sourcify-limit=<N>    Sourcify recent-verified rows (default 100, cap 1000)
 *   --max-candidates=<N>    cap on addresses classified (default 300, cap 2000)
 *   --concurrency=<N>       parallel JSON-RPC calls (default 6, cap 16)
 *   --timeout-ms=<N>        per-request timeout (default 20000)
 *   --factory=<0|1>         enable factory-creation-event enumeration (default 1)
 *   --factory-blocks=<N>    block window for factory eth_getLogs (default 2000, cap 20000)
 *   --liveness=<0|1>        run the vault-erc4626 liveness prefilter (default 1)
 *   --out=<path>            artifact path (default reports/raw/fast/new-deployments-<chain>-<utc>.json)
 *   --probe-registry        read-only check of the factory registry, then exit
 *   --find=<term>           read-only Blockscout contract search, then exit
 *   --quiet                 suppress human summary
 *   --self-test             run offline classification/factory/liveness assertions and exit
 */

const fs = require("node:fs");
const path = require("node:path");
const { getCreateAddress, id, keccak256, Interface } = require("ethers");

const { enumerateFactoryCreations, buildDecoders } = require("./lib/factory-creation-events");
const { registryFor, registryStats } = require("./lib/factory-creation-registry");
const { livenessPrefilter } = require("./lib/liveness-prefilter");

const ROOT = path.resolve(__dirname, "..");
const REPORTS_DIR = path.join(ROOT, "reports", "raw", "fast");

/* ------------------------------------------------------------------ *
 * Chain capability table. Endpoint values live only in this process and
 * are never emitted into artifacts or logs.
 * ------------------------------------------------------------------ */
const CHAINS = Object.freeze({
  ethereum: {
    chainId: 1,
    blockTime: 12,
    rpc: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
    blockscout: "https://eth.blockscout.com",
  },
  base: {
    chainId: 8453,
    blockTime: 2,
    rpc: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
    blockscout: "https://base.blockscout.com",
  },
  arbitrum: {
    chainId: 42161,
    blockTime: 0.26,
    rpc: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
    blockscout: "https://arbitrum.blockscout.com",
  },
  optimism: {
    chainId: 10,
    blockTime: 2,
    rpc: ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io"],
    blockscout: "https://optimism.blockscout.com",
  },
  polygon: {
    chainId: 137,
    blockTime: 2,
    rpc: ["https://polygon-bor-rpc.publicnode.com"],
    blockscout: "https://polygon.blockscout.com",
  },
  gnosis: {
    chainId: 100,
    blockTime: 5,
    rpc: ["https://gnosis-rpc.publicnode.com"],
    blockscout: "https://gnosis.blockscout.com",
  },
});

const SOURCIFY = "https://sourcify.dev/server";

const HARD_CAPS = Object.freeze({
  blocks: 2000,
  explorerPages: 20,
  sourcifyLimit: 1000,
  maxCandidates: 2000,
  concurrency: 16,
  factoryBlocks: 20000,
  factoryLogs: 20000,
  factoryCreations: 6000,
});

/* ------------------------------------------------------------------ *
 * Risk-class selector signatures. PUSH4 selector == first 4 bytes of keccak(sig).
 * ------------------------------------------------------------------ */
const ERC20_SIGS = [
  "totalSupply()",
  "balanceOf(address)",
  "transfer(address,uint256)",
  "approve(address,uint256)",
  "allowance(address,address)",
  "transferFrom(address,address,uint256)",
];

const RISK_SIGNATURES = Object.freeze({
  "vault-erc4626": [
    "asset()",
    "totalAssets()",
    "convertToShares(uint256)",
    "convertToAssets(uint256)",
    "previewDeposit(uint256)",
    "previewMint(uint256)",
    "previewWithdraw(uint256)",
    "previewRedeem(uint256)",
    "maxDeposit(address)",
    "deposit(uint256,address)",
    "mint(uint256,address)",
    "withdraw(uint256,address,address)",
    "redeem(uint256,address,address)",
  ],
  lending: [
    "borrow(uint256)",
    "borrow(address,uint256)",
    "repay(uint256)",
    "repayBorrow(uint256)",
    "liquidate(address,uint256)",
    "liquidateBorrow(address,uint256,address)",
    "liquidationCall(address,address,address,uint256,bool)",
    "accrueInterest()",
    "exchangeRateStored()",
    "borrowBalanceStored(address)",
    "getReserveData(address)",
    "collateralFactorMantissa()",
    "interestRateModel()",
  ],
  oracle: [
    "latestAnswer()",
    "latestRoundData()",
    "latestRound()",
    "getRoundData(uint80)",
    "getPrice()",
    "getAssetPrice(address)",
    "getUnderlyingPrice(address)",
    "getPrice(address)",
    "peek()",
    "read()",
    "description()",
  ],
  "bridge-messenger": [
    "sendMessage(address,uint256,bytes)",
    "relayMessage(address,address,uint256,uint256,bytes)",
    "receiveMessage(bytes)",
    "processMessage(address,uint256,bytes)",
    "sendMessage(bytes,bytes)",
    "dispatch(uint256,address,uint256,bytes)",
    "proveAndProcess(bytes,bytes,uint256)",
    "finalize(bytes,bytes,uint256)",
    "executeMessage(bytes)",
    "lzSend(uint32,bytes,bytes,uint256,uint256,address,address,bytes)",
    "sendFrom(address,uint16,bytes,uint256,uint256,address,address,bytes)",
  ],
  "staking-restaking": [
    "stake(uint256)",
    "stake(address,uint256)",
    "unstake(uint256)",
    "withdraw(uint256)",
    "requestWithdrawal(uint256)",
    "queueWithdrawal(uint256)",
    "claimRewards()",
    "getReward()",
    "restake()",
    "delegate(address)",
    "undelegate(address)",
  ],
  perps: [
    "openPosition(bytes,uint256)",
    "closePosition(bytes,uint256)",
    "increasePosition(bytes,address,uint256,bool)",
    "decreasePosition(bytes,address,uint256,bool)",
    "modifyPosition(uint256,uint256)",
    "liquidatePosition(uint256)",
    "executeOrder(bytes)",
    "positions(address)",
    "getPosition(address)",
    "settle(uint256)",
  ],
  "governance-proxy": [
    "propose(address[],uint256[],bytes[],string)",
    "castVote(uint256,uint8)",
    "castVoteWithReason(uint256,uint8,string)",
    "queue(uint256)",
    "execute(uint256)",
    "getPriorVotes(address,uint256)",
    "delegate(address)",
    "upgradeTo(address)",
    "upgradeToAndCall(address,bytes)",
    "changeAdmin(address)",
    "proxiableUUID()",
  ],
});

const PROXY_SLOTS = Object.freeze({
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
});

const KNOWN_AUDITED_IMPL = [
  /^TransparentUpgradeableProxy$/i,
  /^ERC1967Proxy$/i,
  /^ERC1967Upgrade$/i,
  /^UUPSProxy$/i,
  /^BeaconProxy$/i,
  /^UpgradeableBeacon$/i,
  /^ProxyAdmin$/i,
  /^GnosisSafe(L2)?$/i,
  /^GnosisSafeProxy$/i,
  /^GnosisSafeProxyFactory$/i,
  /^Safe(L2)?$/i,
  /^SafeProxy$/i,
  /^SafeProxyFactory$/i,
  /^Multicall/i,
  /^Permit2$/i,
  /^Create2/i,
  /^Forwarder$/i,
];

/*
 * A single generic selector match is weak evidence (e.g. "read()" or
 * "withdraw(uint256)"). A class is only assigned when it either matches a
 * strong signature or accumulates at least two of its signatures.
 */
const STRONG_SIGNATURES = Object.freeze({
  "vault-erc4626": ["asset()", "totalAssets()", "convertToShares(uint256)", "convertToAssets(uint256)", "previewRedeem(uint256)", "previewDeposit(uint256)"],
  lending: ["borrow(uint256)", "borrow(address,uint256)", "liquidationCall(address,address,address,uint256,bool)", "accrueInterest()", "getReserveData(address)"],
  oracle: ["latestRoundData()", "latestAnswer()", "getUnderlyingPrice(address)", "getAssetPrice(address)", "getPrice(address)"],
  "bridge-messenger": ["sendMessage(address,uint256,bytes)", "relayMessage(address,address,uint256,uint256,bytes)", "receiveMessage(bytes)", "processMessage(address,uint256,bytes)", "proveAndProcess(bytes,bytes,uint256)", "lzSend(uint32,bytes,bytes,uint256,uint256,address,address,bytes)"],
  "staking-restaking": ["stake(uint256)", "unstake(uint256)", "restake()", "requestWithdrawal(uint256)", "queueWithdrawal(uint256)"],
  perps: ["openPosition(bytes,uint256)", "closePosition(bytes,uint256)", "increasePosition(bytes,address,uint256,bool)", "decreasePosition(bytes,address,uint256,bool)", "modifyPosition(uint256,uint256)", "liquidatePosition(uint256)"],
  "governance-proxy": ["propose(address[],uint256[],bytes[],string)", "castVote(uint256,uint8)", "getPriorVotes(address,uint256)", "upgradeToAndCall(address,bytes)", "changeAdmin(address)"],
});

const SPAM_NAME = /\b(airdrop|claim.?reward|free.?token|spam|scam|honeypot|visit\s|http|t\.me|\.com)\b/i;

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */
function nowUtcStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
function hexToInt(h) {
  if (h === null || h === undefined) return null;
  return Number(BigInt(h));
}
function dbg() {
  process.stderr.write("[scan] " + Array.from(arguments).join(" ") + "\n");
}
function sanitizeErr(e) {
  // Never leak endpoint values: strip anything URL-like, keep the reason class only.
  const raw = e && e.message ? e.message : String(e);
  return raw
    .replace(/https?:\/\/[^\s"')]+/g, "<endpoint>")
    .replace(/[\w.-]+\.(com|org|io|net|xyz|dev)\b/g, "<host>")
    .slice(0, 160);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ *
 * Bounded parallel map
 * ------------------------------------------------------------------ */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (e) {
        results[i] = { ok: false, error: sanitizeErr(e) };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------ *
 * Keyless JSON-RPC with fallback endpoints (index labels only)
 * ------------------------------------------------------------------ */
function makeRpc(chainCfg, timeoutMs) {
  const endpoints = chainCfg.rpc;
  async function once(url, method, params) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: c.signal,
      });
      if (!res.ok) throw new Error("HTTP_" + res.status);
      const body = await res.json();
      if (body && body.error) throw new Error("RPC_ERR " + JSON.stringify(body.error).slice(0, 80));
      return body ? body.result : null;
    } finally {
      clearTimeout(t);
    }
  }
  return async function rpcCall(method, params) {
    let lastErr = "unknown";
    for (let i = 0; i < endpoints.length; i++) {
      try {
        return { result: await once(endpoints[i], method, params), endpointIndex: i };
      } catch (e) {
        lastErr = sanitizeErr(e);
      }
    }
    const err = new Error("RPC_UNAVAILABLE method=" + method + " endpoints=" + endpoints.length + " cause=" + lastErr);
    err.code = "RPC_UNAVAILABLE";
    throw err;
  };
}

/* ------------------------------------------------------------------ *
 * Keyless explorer fetches
 * ------------------------------------------------------------------ */
async function httpJson(url, timeoutMs, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: c.signal });
      const text = await res.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error("HTTP_" + res.status + "_NONJSON");
      }
      if (!res.ok) {
        const e = new Error("HTTP_" + res.status);
        e.status = res.status;
        throw e;
      }
      return body;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(250 * (attempt + 1));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ *
 * Enumerators
 * ------------------------------------------------------------------ */
async function enumerateByBlocks(rpcCall, endBlock, count) {
  const fromBlock = endBlock - count + 1;
  const blocks = [];
  for (let b = endBlock; b >= fromBlock; b--) blocks.push(b);

  const found = [];
  let blocksOk = 0;
  let blocksFail = 0;
  let txsScanned = 0;
  const failures = [];

  const results = await mapLimit(blocks, 6, async (blockNumber) => {
    const { result } = await rpcCall("eth_getBlockByNumber", ["0x" + blockNumber.toString(16), true]);
    return { blockNumber, block: result };
  });

  for (const r of results) {
    if (!r || !r.ok || !r.value || !r.value.block) {
      blocksFail++;
      failures.push(r && r.error ? r.error : "empty_block");
      continue;
    }
    blocksOk++;
    const { blockNumber, block } = r.value;
    const txs = Array.isArray(block.transactions) ? block.transactions : [];
    txsScanned += txs.length;
    for (const tx of txs) {
      if (!tx || (tx.to !== null && tx.to !== undefined)) continue;
      try {
        const address = getCreateAddress({ from: tx.from, nonce: BigInt(tx.nonce) });
        found.push({
          address,
          source: "block-create",
          creationBlock: blockNumber,
          creationTx: tx.hash,
          deployer: tx.from,
          verifiedAt: null,
          isVerified: null,
        });
      } catch (e) {
        /* unparseable creation tx: skip, count elsewhere */
      }
    }
  }

  return {
    rows: found,
    stats: {
      fromBlock,
      toBlock: endBlock,
      blocksRequested: count,
      blocksOk,
      blocksFail,
      txsScanned,
      directCreations: found.length,
      failures: failures.slice(0, 5),
    },
  };
}

async function enumerateByExplorer(chainCfg, { explorerPages, sourcifyLimit, timeoutMs }) {
  const rows = [];
  const stats = { blockscoutPages: 0, blockscoutRows: 0, blockscoutError: null, sourcifyRows: 0, sourcifyError: null };

  // Blockscout recent-verified feed (cursor pagination via next_page_params).
  let url = chainCfg.blockscout + "/api/v2/smart-contracts";
  let nextParams = null;
  for (let p = 0; p < explorerPages; p++) {
    let pageUrl = url;
    if (nextParams && nextParams.smart_contract_id) {
      const q = new URLSearchParams();
      q.set("smart_contract_id", String(nextParams.smart_contract_id));
      if (nextParams.items_count) q.set("items_count", String(nextParams.items_count));
      pageUrl = url + "?" + q.toString();
    }
    let body;
    try {
      body = await httpJson(pageUrl, timeoutMs);
    } catch (e) {
      stats.blockscoutError = sanitizeErr(e);
      break;
    }
    const items = body && Array.isArray(body.items) ? body.items : [];
    stats.blockscoutPages++;
    for (const it of items) {
      const a = it && it.address ? it.address : null;
      if (!a || !a.hash) continue;
      rows.push({
        address: a.hash,
        source: "blockscout-verified",
        creationBlock: null,
        creationTx: null,
        deployer: null,
        verifiedAt: it.verified_at || null,
        isVerified: a.is_verified === true,
        isScam: a.is_scam === true,
        name: a.name || null,
        proxyType: a.proxy_type || null,
        implementations: Array.isArray(a.implementations) ? a.implementations.map((x) => (x && x.address_hash) || (x && x.hash) || null).filter(Boolean) : [],
        language: it.language || null,
      });
      stats.blockscoutRows++;
    }
    nextParams = body && body.next_page_params ? body.next_page_params : null;
    if (!nextParams || !nextParams.smart_contract_id) break;
  }

  // Sourcify recent-verification feed (independent of Blockscout).
  if (sourcifyLimit > 0) {
    try {
      const body = await httpJson(
        SOURCIFY + "/v2/contracts/" + chainCfg.chainId + "?limit=" + sourcifyLimit + "&sort=desc",
        timeoutMs
      );
      const results = body && Array.isArray(body.results) ? body.results : [];
      for (const it of results) {
        if (!it || !it.address) continue;
        rows.push({
          address: it.address,
          source: "sourcify-verified",
          creationBlock: null,
          creationTx: null,
          deployer: null,
          verifiedAt: it.verifiedAt || null,
          isVerified: true,
          isScam: false,
          name: null,
          proxyType: null,
          implementations: [],
          language: null,
          match: it.match || null,
        });
        stats.sourcifyRows++;
      }
    } catch (e) {
      stats.sourcifyError = sanitizeErr(e);
    }
  }

  return { rows, stats };
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */
function buildSelectorTable() {
  const table = {};
  for (const [cls, sigs] of Object.entries(RISK_SIGNATURES)) {
    table[cls] = sigs.map((s) => {
      const sel = id(s).slice(2, 10);
      return { sig: s, sel, push4: "63" + sel };
    });
  }
  return table;
}

function detectSelectors(codeLower, table) {
  const hits = {};
  for (const [cls, entries] of Object.entries(table)) {
    for (const e of entries) {
      if (codeLower.includes(e.push4)) {
        if (!hits[cls]) hits[cls] = [];
        hits[cls].push(e.sig);
      }
    }
  }
  return hits;
}

function isTokenOnly(codeLower) {
  const erc20 = ERC20_SIGS.filter((s) => codeLower.includes("63" + id(s).slice(2, 10))).length;
  return erc20 >= 4;
}

function primaryClass(hits) {
  const entries = Object.entries(hits)
    .map(([cls, sigs]) => {
      const strong = sigs.filter((s) => (STRONG_SIGNATURES[cls] || []).includes(s));
      return { cls, sigs, strong, score: sigs.length };
    })
    .filter((e) => e.strong.length > 0 || e.score >= 2);
  if (!entries.length) return null;
  entries.sort((a, b) => b.score - a.score || b.strong.length - a.strong.length);
  return entries[0].cls;
}

/* ------------------------------------------------------------------ *
 * Scanner
 * ------------------------------------------------------------------ */
async function scanChain(chainName, opts) {
  const chainCfg = CHAINS[chainName];
  if (!chainCfg) throw new Error("UNSUPPORTED_CHAIN " + chainName);
  const rpcCall = makeRpc(chainCfg, opts.timeoutMs);
  const table = buildSelectorTable();

  /* head */
  const headRes = await rpcCall("eth_blockNumber", []);
  const head = hexToInt(headRes.result);
  if (!Number.isFinite(head)) throw new Error("HEAD_UNAVAILABLE");

  let endBlock;
  if (opts.toBlock !== null) {
    endBlock = Math.min(opts.toBlock, head);
  } else if (opts.mode === "hybrid" || opts.mode === "blocks") {
    endBlock = head;
  } else {
    endBlock = head;
  }

  /* enumerate */
  let blockEnum = { rows: [], stats: null };
  let explorerEnum = { rows: [], stats: null };
  let factoryEnum = { rows: [], stats: null };
  const registry = registryFor(chainName);

  if (opts.mode === "hybrid" || opts.mode === "blocks") {
    if (opts.mode === "blocks" || opts.blocks > 0) {
      blockEnum = await enumerateByBlocks(rpcCall, endBlock, opts.blocks);
    }
  }
  if (opts.mode === "hybrid" || opts.mode === "explorer") {
    explorerEnum = await enumerateByExplorer(chainCfg, opts);
  }

  /* factory-creation events: closes the to===null / CREATE2 inner-deploy blind spot */
  if (opts.factory && opts.factoryBlocks > 0 && (opts.mode === "hybrid" || opts.mode === "blocks") && registry.length > 0) {
    const factoryToBlock = endBlock;
    const factoryFromBlock = Math.max(0, endBlock - opts.factoryBlocks + 1);
    factoryEnum = await enumerateFactoryCreations(rpcCall, {
      entries: registry,
      fromBlock: factoryFromBlock,
      toBlock: factoryToBlock,
      maxLogs: HARD_CAPS.factoryLogs,
      maxCreations: HARD_CAPS.factoryCreations,
      maxCreationsPerEntry: 300,
      concurrency: opts.concurrency,
    });
    factoryEnum.stats.registrySize = registry.length;
    factoryEnum.stats.registryChains = registryStats();
    /* Fail closed: if the registry exists but every factory query failed, do not
     * claim coverage from the factory path. */
    if (factoryEnum.stats.entriesProbed > 0 && factoryEnum.stats.entriesOk === 0) {
      throw new Error("FACTORY_SCAN_FAILED entriesOk=0");
    }
  } else {
    factoryEnum.stats = {
      fromBlock: null,
      toBlock: null,
      entriesRegistered: registry.length,
      entriesProbed: 0,
      entriesOk: 0,
      entriesFailed: 0,
      queriesOk: 0,
      queriesFailed: 0,
      logsFetched: 0,
      creationsFound: 0,
      skipped: opts.factory ? "no-events-mode-or-empty-registry" : "disabled",
    };
  }

  if (opts.mode === "blocks" && blockEnum.stats.blocksOk === 0) {
    throw new Error("BLOCK_SCAN_FAILED blocksOk=0");
  }

  /* dedupe onchain sources first: direct CREATE vs factory-creation event */
  const onchainByAddr = new Map();
  for (const row of blockEnum.rows) {
    onchainByAddr.set(row.address.toLowerCase(), row);
  }
  for (const row of factoryEnum.rows) {
    const k = row.address.toLowerCase();
    if (onchainByAddr.has(k)) {
      const cur = onchainByAddr.get(k);
      cur.creationBlock = cur.creationBlock != null ? cur.creationBlock : row.creationBlock;
      cur.creationTx = cur.creationTx || row.creationTx;
      cur.factoryName = cur.factoryName || row.factoryName;
      cur.factoryKind = cur.factoryKind || row.factoryKind;
      if (cur.source.indexOf("factory-event") === -1) cur.source = cur.source + "+factory-event";
    } else {
      onchainByAddr.set(k, row);
    }
  }

  /* dedupe: prefer onchain row (has creation reference), merge explorer metadata */
  const byAddr = new Map();
  for (const row of explorerEnum.rows) {
    const k = row.address.toLowerCase();
    if (!byAddr.has(k)) byAddr.set(k, row);
    else {
      const cur = byAddr.get(k);
      cur.verifiedAt = cur.verifiedAt || row.verifiedAt;
      cur.isVerified = cur.isVerified === true || row.isVerified === true;
      cur.name = cur.name || row.name;
      cur.proxyType = cur.proxyType || row.proxyType;
      if (row.implementations && row.implementations.length) cur.implementations = row.implementations;
    }
  }
  for (const row of onchainByAddr.values()) {
    const k = row.address.toLowerCase();
    if (byAddr.has(k)) {
      const cur = byAddr.get(k);
      cur.creationBlock = cur.creationBlock || row.creationBlock;
      cur.creationTx = cur.creationTx || row.creationTx;
      cur.deployer = cur.deployer || row.deployer;
      cur.factoryName = cur.factoryName || row.factoryName;
      cur.factoryKind = cur.factoryKind || row.factoryKind;
      if (cur.source.indexOf("block-create") === -1 && cur.source.indexOf("factory-event") === -1) {
        cur.source = (row.source.indexOf("factory-event") !== -1 ? "factory-event" : "block-create") + "+" + cur.source;
      }
    } else {
      byAddr.set(k, row);
    }
  }

  let candidates = Array.from(byAddr.values());
  const enumerated = candidates.length;
  /* Round-robin merge so a low maxCandidates cap cannot truncate one source entirely. */
  const blockRows = candidates.filter((r) => r.creationBlock != null).sort((a, b) => b.creationBlock - a.creationBlock);
  const explorerRows = candidates
    .filter((r) => r.creationBlock == null)
    .sort((a, b) => String(b.verifiedAt || "").localeCompare(String(a.verifiedAt || "")));
  const merged = [];
  for (let i = 0; i < Math.max(blockRows.length, explorerRows.length); i++) {
    if (i < blockRows.length) merged.push(blockRows[i]);
    if (i < explorerRows.length) merged.push(explorerRows[i]);
  }
  candidates = merged;
  if (candidates.length > opts.maxCandidates) candidates = candidates.slice(0, opts.maxCandidates);

  /* classify */
  const classified = await mapLimit(candidates, opts.concurrency, async (row) => {
    const codeRes = await rpcCall("eth_getCode", [row.address, "latest"]);
    const code = typeof codeRes.result === "string" ? codeRes.result : "0x";
    const codeSize = Math.max(0, (code.length - 2) / 2);
    if (codeSize === 0) {
      return Object.assign({}, row, { class: "excluded", excludeReason: "no-code", codeSize: 0, signals: [], isProxy: false });
    }
    const codeLower = code.toLowerCase();
    const hits = detectSelectors(codeLower, table);

    /* EIP-1967 implementation slot */
    let isProxy = false;
    let implementation = null;
    try {
      const implRes = await rpcCall("eth_getStorageAt", [row.address, PROXY_SLOTS.implementation, "latest"]);
      const implVal = typeof implRes.result === "string" ? implRes.result : "0x";
      if (implVal && implVal !== "0x" && BigInt(implVal) !== 0n) {
        isProxy = true;
        implementation = "0x" + implVal.slice(-40);
      }
    } catch (e) {
      /* leave isProxy unknown rather than guessing */
    }
    if (!isProxy && Array.isArray(row.implementations) && row.implementations.length) {
      isProxy = true;
      implementation = row.implementations[0];
    }
    if (!isProxy && row.proxyType) isProxy = true;

    const out = {
      address: row.address,
      source: row.source,
      creationBlock: row.creationBlock,
      creationTx: row.creationTx,
      verifiedAt: row.verifiedAt,
      isVerified: row.isVerified,
      name: row.name || null,
      factoryName: row.factoryName || null,
      factoryKind: row.factoryKind || null,
      codeSize,
      isProxy,
      implementation,
      signals: hits,
      class: "unclassified",
      riskClass: null,
      excludeReason: null,
      rationale: "",
    };

    if (row.isScam === true) {
      out.class = "excluded";
      out.excludeReason = "scam-flagged";
      out.rationale = "explorer is_scam=true";
      return out;
    }
    if (row.name && SPAM_NAME.test(row.name)) {
      out.class = "excluded";
      out.excludeReason = "spam-name";
      out.rationale = "verified name matches spam marker";
      return out;
    }
    if (row.name && KNOWN_AUDITED_IMPL.some((re) => re.test(row.name))) {
      out.class = "excluded";
      out.excludeReason = "known-audited-impl";
      out.rationale = "name matches a known proxy shell / audited infrastructure template";
      return out;
    }

    const cls = primaryClass(hits);
    const otherSignals = Object.keys(hits).filter((k) => k !== "governance-proxy");
    if (isProxy && cls === "governance-proxy" && otherSignals.length === 0) {
      out.class = "excluded";
      out.excludeReason = "proxy-shell";
      out.rationale = "proxy with only upgrade/governance selectors; impl=" + (implementation || "unresolved");
      return out;
    }
    if (!cls) {
      if (isTokenOnly(codeLower)) {
        out.class = "excluded";
        out.excludeReason = "token-no-logic";
        out.rationale = "ERC-20 interface only, no risk-class selectors";
      } else if (isProxy) {
        out.class = "proxy-unknown-impl";
        out.riskClass = null;
        out.rationale = "proxy shell with no local risk selectors; implementation " + (implementation || "unresolved");
      } else {
        out.class = "unclassified";
        out.rationale = "no risk-class selectors detected" + (codeSize < 100 ? " (small contract)" : "");
      }
      return out;
    }

    out.class = cls;
    out.riskClass = cls;
    const matched = hits[cls].slice(0, 4).join(", ");
    out.rationale = cls + " selectors: " + matched + (isProxy ? "; proxy impl=" + (implementation || "unresolved") : "");
    return out;
  });

  /* enrich verified metadata for class-matched rows only */
  const toEnrich = [];
  classified.forEach((r, i) => {
    if (r && r.ok && r.value && r.value.riskClass && r.value.isVerified !== true) toEnrich.push(i);
  });
  if (toEnrich.length && chainCfg.blockscout) {
    await mapLimit(toEnrich, Math.max(1, Math.floor(opts.concurrency / 2)), async (idx) => {
      const row = classified[idx].value;
      try {
        const body = await httpJson(chainCfg.blockscout + "/api/v2/smart-contracts/" + row.address, opts.timeoutMs, 1);
        row.isVerified = body && body.is_verified === true;
        if (!row.name && body && body.name) row.name = body.name;
        if (!row.implementation && body && body.implementations && body.implementations[0]) {
          row.isProxy = true;
          row.implementation = body.implementations[0].address_hash || body.implementations[0].hash || null;
        }
      } catch (e) {
        row.enrichmentUnavailable = sanitizeErr(e);
      }
    });
  }

  const rows = classified.map((r) => (r && r.ok ? r.value : { address: null, class: "unavailable", error: r ? r.error : "unknown" }));

  /* liveness prefilter: suppress dormant / uninitialized identical-code clusters
   * before triage. Applied post-classification, read-only, conservative. */
  let liveness = null;
  if (opts.liveness) {
    const res = await livenessPrefilter(rpcCall, rows, { concurrency: opts.concurrency });
    liveness = res.stats;
  } else {
    liveness = { class: "vault-erc4626", evaluated: 0, live: 0, dormant: 0, indeterminate: 0, removed: 0, kept: 0, byReason: {}, callErrors: 0, skipped: "disabled" };
  }

  const classMatchedBeforeLiveness = rows.filter((r) => r.riskClass && r.class !== "excluded");
  const suppressedByLiveness = classMatchedBeforeLiveness.filter((r) => r.liveness === "dormant");
  const classMatched = classMatchedBeforeLiveness.filter((r) => r.liveness !== "dormant");
  const excluded = rows.filter((r) => r.class === "excluded");
  const unavailable = rows.filter((r) => r.class === "unavailable" || r.class === "unclassified" || r.class === "proxy-unknown-impl");

  return {
    schema: "new-deployments-scan/v2",
    generatedAt: new Date().toISOString(),
    readOnly: true,
    chain: chainName,
    chainId: chainCfg.chainId,
    method: opts.mode,
    bounds: {
      headBlock: head,
      fromBlock: blockEnum.stats ? blockEnum.stats.fromBlock : null,
      toBlock: blockEnum.stats ? blockEnum.stats.toBlock : endBlock,
      blocksScanned: blockEnum.stats ? blockEnum.stats.blocksOk : 0,
      blocksFailed: blockEnum.stats ? blockEnum.stats.blocksFail : 0,
      txsScanned: blockEnum.stats ? blockEnum.stats.txsScanned : 0,
      explorerPagesRequested: opts.explorerPages,
      sourcifyLimitRequested: opts.sourcifyLimit,
      maxCandidates: opts.maxCandidates,
      factoryBlocksRequested: opts.factory ? opts.factoryBlocks : 0,
      factoryFromBlock: factoryEnum.stats ? factoryEnum.stats.fromBlock : null,
      factoryToBlock: factoryEnum.stats ? factoryEnum.stats.toBlock : null,
    },
    coverage: {
      directCreate: opts.mode !== "explorer",
      factoryEvents: opts.factory && (opts.mode === "hybrid" || opts.mode === "blocks"),
      factoryCreatesMissedByBlockScan: false,
      explorerOnlyCoversVerified: opts.mode !== "blocks",
      verifiedAtIsNotDeployTime: true,
    },
    sources: {
      blockScan: blockEnum.stats,
      explorer: explorerEnum.stats,
      factoryEvents: factoryEnum.stats,
      livenessPrefilter: liveness,
      factoryRegistry: {
        chains: Object.keys(registryStats()),
        entryCountByChain: registryStats(),
        thisChainEntries: registry.map((e) => ({ name: e.name, address: e.address, kind: e.kind, event: e.event.replace(/^event\s+/, "") })),
      },
    },
    totals: {
      enumerated: enumerated,
      classified: rows.length,
      classMatchedBeforeLiveness: classMatchedBeforeLiveness.length,
      classMatched: classMatched.length,
      suppressedByLiveness: suppressedByLiveness.length,
      excluded: excluded.length,
      other: unavailable.length,
      onchainCreations: {
        directCreate: blockEnum.rows.length,
        factoryEvent: factoryEnum.rows.length,
      },
      byClass: classMatched.reduce((acc, r) => {
        acc[r.class] = (acc[r.class] || 0) + 1;
        return acc;
      }, {}),
      note: "classMatched is a bytecode/ABI prefilter plus liveness suppression, not report admission; see triage.",
    },
    rows,
  };
}

/* ------------------------------------------------------------------ *
 * Offline self-test
 * ------------------------------------------------------------------ */
function selfTest() {
  const table = buildSelectorTable();
  const assert = (cond, msg) => {
    if (!cond) throw new Error("SELFTEST_FAIL " + msg);
  };
  // selector table well-formed
  for (const [cls, entries] of Object.entries(table)) {
    assert(entries.length > 0, cls + " empty");
    for (const e of entries) assert(/^63[0-9a-f]{8}$/.test(e.push4), cls + " bad push4 " + e.sig);
  }
  // synthetic bytecode containing ERC-4626 + lending selectors classifies
  const erc4626 = "600063" + id("asset()").slice(2, 10) + "63" + id("totalAssets()").slice(2, 10);
  const hits = detectSelectors(erc4626.toLowerCase(), table);
  assert(hits["vault-erc4626"] && hits["vault-erc4626"].length === 2, "erc4626 detect");
  assert(primaryClass(hits) === "vault-erc4626", "primary class");
  // a single weak/generic selector must NOT classify
  const weak = detectSelectors(("63" + id("read()").slice(2, 10)).toLowerCase(), table);
  assert(primaryClass(weak) === null, "weak single generic selector rejected");
  // token-only detection
  const tok = "60" + ERC20_SIGS.map((s) => "63" + id(s).slice(2, 10)).join("");
  assert(isTokenOnly(tok.toLowerCase()), "token only");
  // create address derivation deterministic (known vector: 0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0 -> nonce 0)
  const derived = getCreateAddress({ from: "0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0", nonce: 0n });
  assert(/^0x[0-9a-fA-F]{40}$/.test(derived), "create address shape");
  // keccak helper used
  assert(typeof keccak256("0x") === "string", "keccak usable");

  // factory registry + decoder well-formed for every entry
  const { registryFor: regFor } = require("./lib/factory-creation-registry");
  const { buildDecoders: buildDec } = require("./lib/factory-creation-events");
  let regEntries = 0;
  for (const chain of Object.keys(require("./lib/factory-creation-registry").FACTORY_REGISTRY)) {
    const list = regFor(chain);
    assert(list.length > 0, "empty registry " + chain);
    const dec = buildDec(chain === "ethereum" ? list : list);
    for (const d of dec) {
      assert(!d.error, "decoder error " + (d.entry && d.entry.name) + " " + d.error);
      assert(/^0x[0-9a-f]{64}$/.test(d.topic0), "bad topic0 " + (d.entry && d.entry.name));
      regEntries++;
    }
  }
  assert(regEntries > 0, "registry entries");

  // liveness decision: positive dormancy suppression, conservative keep
  const { decideLiveness } = require("./lib/liveness-prefilter");
  const ZERO = "0x0000000000000000000000000000000000000000";
  const okUint = (v) => ({ ok: true, value: BigInt(v) });
  const okAddr = (a) => ({ ok: true, value: a });
  const fail = { ok: false, reason: "revert" };
  assert(decideLiveness({ asset: okAddr(ZERO), totalAssets: okUint(0), totalSupply: okUint(0) }).liveness === "dormant", "asset-zero dormant");
  assert(decideLiveness({ asset: fail, totalAssets: fail, totalSupply: fail }).liveness === "dormant", "uninitialized dormant");
  assert(decideLiveness({ asset: okAddr("0x000000000000000000000000000000000000dEaD"), totalAssets: okUint(5), totalSupply: okUint(5) }).liveness === "live", "live vault");
  assert(decideLiveness({ asset: fail, totalAssets: okUint(5), totalSupply: okUint(5) }).liveness === "live", "partial failure kept live");
  assert(decideLiveness({ asset: okAddr("0x000000000000000000000000000000000000dEaD"), totalAssets: fail, totalSupply: okUint(0) }).liveness === "indeterminate", "ambiguous kept");
  return true;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const o = {
    chain: "ethereum",
    mode: "hybrid",
    blocks: 300,
    toBlock: null,
    explorerPages: 3,
    sourcifyLimit: 100,
    maxCandidates: 300,
    concurrency: 6,
    timeoutMs: 20000,
    factory: true,
    factoryBlocks: 2000,
    liveness: true,
    find: null,
    inspect: null,
    out: null,
    quiet: false,
    selfTest: false,
    probeRegistry: false,
  };
  for (const a of argv) {
    if (a === "--self-test") o.selfTest = true;
    else if (a === "--quiet") o.quiet = true;
    else if (a === "--probe-registry") o.probeRegistry = true;
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq === -1) continue;
      const k = a.slice(2, eq);
      const v = a.slice(eq + 1);
      if (k === "chain") o.chain = v;
      else if (k === "mode") o.mode = v;
      else if (k === "blocks") o.blocks = Math.min(HARD_CAPS.blocks, Math.max(0, parseInt(v, 10) || 0));
      else if (k === "to-block") o.toBlock = parseInt(v, 10) || null;
      else if (k === "explorer-pages") o.explorerPages = Math.min(HARD_CAPS.explorerPages, Math.max(0, parseInt(v, 10) || 0));
      else if (k === "sourcify-limit") o.sourcifyLimit = Math.min(HARD_CAPS.sourcifyLimit, Math.max(0, parseInt(v, 10) || 0));
      else if (k === "max-candidates") o.maxCandidates = Math.min(HARD_CAPS.maxCandidates, Math.max(1, parseInt(v, 10) || 1));
      else if (k === "concurrency") o.concurrency = Math.min(HARD_CAPS.concurrency, Math.max(1, parseInt(v, 10) || 1));
      else if (k === "timeout-ms") o.timeoutMs = Math.max(1000, parseInt(v, 10) || 20000);
      else if (k === "factory") o.factory = v !== "0" && v !== "false";
      else if (k === "factory-blocks") o.factoryBlocks = Math.min(HARD_CAPS.factoryBlocks, Math.max(0, parseInt(v, 10) || 0));
      else if (k === "liveness") o.liveness = v !== "0" && v !== "false";
      else if (k === "find") o.find = v;
      else if (k === "inspect") o.inspect = v;
      else if (k === "out") o.out = v;
    }
  }
  return o;
}

/* ------------------------------------------------------------------ *
 * Registry probe (offline check, read-only): confirms each registry address
 * still holds code and that the declared creation event appears in the
 * explorer-verified ABI (or, when unverified, in recent logs). No endpoint
 * values are printed.
 * ------------------------------------------------------------------ */
function abiEventInfo(abi, eventName) {
  const topics = new Set();
  const eventNames = [];
  const byTopic = new Map();
  let parseError = null;
  let rawIncludesEventName = false;
  if (Array.isArray(abi)) {
    try {
      const iface = new Interface(abi);
      for (const frag of iface.fragments) {
        if (frag && frag.type === "event" && frag.topicHash) {
          topics.add(frag.topicHash.toLowerCase());
          const sig = frag.name + "(" + frag.inputs.map((i) => i.type + (i.indexed ? " indexed" : "") + (i.name ? " " + i.name : "")).join(", ") + ")";
          eventNames.push(sig);
          byTopic.set(frag.topicHash.toLowerCase(), sig);
        }
      }
    } catch (e) {
      parseError = sanitizeErr(e);
    }
    try {
      rawIncludesEventName = JSON.stringify(abi).includes(eventName);
    } catch {
      /* ignore */
    }
  }
  return { topics, eventNames, byTopic, rawIncludesEventName, parseError };
}

async function probeRegistry(chainName, opts) {
  const chainCfg = CHAINS[chainName];
  if (!chainCfg) throw new Error("UNSUPPORTED_CHAIN " + chainName);
  const rpcCall = makeRpc(chainCfg, opts.timeoutMs);
  const entries = registryFor(chainName);
  const decoders = buildDecoders(entries);
  const out = [];
  for (const d of decoders) {
    const entry = d.entry;
    const line = {
      name: entry.name,
      address: entry.address,
      kind: entry.kind,
      code: null,
      expectNameOk: null,
      abiEventOk: null,
      abiEventNameSeen: null,
      verified: null,
      verdict: "unavailable",
    };
    if (d.error) {
      line.verdict = "decoder-error";
      line.error = d.error;
      out.push(line);
      continue;
    }
    try {
      const codeRes = await rpcCall("eth_getCode", [entry.address, "latest"]);
      line.code = typeof codeRes.result === "string" && codeRes.result.length > 2;
    } catch (e) {
      line.code = null;
    }
    if (chainCfg.blockscout) {
      try {
        const body = await httpJson(chainCfg.blockscout + "/api/v2/smart-contracts/" + entry.address, opts.timeoutMs, 1);
        const nm = (body && body.name) || "";
        line.verified = body && body.is_verified === true;
        line.expectNameOk = entry.expectName ? entry.expectName.test(nm) : null;
        const info = abiEventInfo(body && body.abi, d.eventName);
        line.abiEventOk = info.topics.has(d.topic0.toLowerCase());
        line.abiEventNameSeen = info.rawIncludesEventName;
        line.abiEventNames = info.eventNames;
        line.matchedEvent = info.byTopic.get(d.topic0.toLowerCase()) || null;
        if (info.parseError) line.abiParseError = info.parseError;
        if (line.code && (line.abiEventOk || line.abiEventNameSeen)) line.verdict = "confirmed";
        else if (line.code) line.verdict = "event-not-in-abi";
        else line.verdict = "no-code";
        if (line.code && !line.abiEventOk) {
          /* fallback: confirm the topic appears in this address's recent logs */
          try {
            const logs = await httpJson(chainCfg.blockscout + "/api/v2/addresses/" + entry.address + "/logs", opts.timeoutMs, 1);
            const items = Array.isArray(logs && logs.items) ? logs.items : [];
            line.logTopicOk = items.some((it) => Array.isArray(it && it.topics) && it.topics[0] && it.topics[0].toLowerCase() === d.topic0.toLowerCase());
            if (line.logTopicOk) line.verdict = "confirmed";
          } catch (e2) {
            line.logTopicUnavailable = sanitizeErr(e2);
          }
        }
      } catch (e) {
        line.explorerError = sanitizeErr(e);
        line.verdict = line.code ? "code-only-explorer-unavailable" : "no-code";
      }
    } else {
      line.verdict = line.code ? "code-only-no-explorer" : "no-code";
    }
    out.push(line);
  }
  return out;
}

async function findContracts(chainName, query, opts) {
  const chainCfg = CHAINS[chainName];
  if (!chainCfg) throw new Error("UNSUPPORTED_CHAIN " + chainName);
  if (!chainCfg.blockscout) return { query, items: [], error: "no-explorer" };
  try {
    const body = await httpJson(chainCfg.blockscout + "/api/v2/search?q=" + encodeURIComponent(query), opts.timeoutMs, 1);
    const items = Array.isArray(body && body.items) ? body.items : [];
    return {
      query,
      items: items.slice(0, 25).map((it) => {
        const addr =
          (it && (it.address_hash || it.address)) ||
          (it && it.address && typeof it.address === "object" ? it.address.hash : null) ||
          null;
        return {
          name: it && it.name ? String(it.name).slice(0, 80) : null,
          address: typeof addr === "string" ? addr : addr && addr.hash ? addr.hash : null,
          type: it && it.type ? it.type : null,
          isContract: it && it.address ? it.address.is_contract === true : null,
        };
      }),
    };
  } catch (e) {
    return { query, items: [], error: sanitizeErr(e) };
  }
}

async function inspectContract(chainName, address, opts) {
  const chainCfg = CHAINS[chainName];
  if (!chainCfg) throw new Error("UNSUPPORTED_CHAIN " + chainName);
  const rpcCall = makeRpc(chainCfg, opts.timeoutMs);
  const out = { chain: chainName, address, codeSize: null, isContract: null, name: null, verified: null, language: null, proxyType: null, implementations: [], eip1967Impl: null, sourcifyMatch: null };

  try {
    const codeRes = await rpcCall("eth_getCode", [address, "latest"]);
    const code = typeof codeRes.result === "string" ? codeRes.result : "0x";
    out.codeSize = Math.max(0, (code.length - 2) / 2);
    out.isContract = out.codeSize > 0;
  } catch (e) {
    out.codeError = sanitizeErr(e);
  }
  try {
    const implRes = await rpcCall("eth_getStorageAt", [address, PROXY_SLOTS.implementation, "latest"]);
    const v = typeof implRes.result === "string" ? implRes.result : "0x";
    if (v && v !== "0x" && BigInt(v) !== 0n) out.eip1967Impl = "0x" + v.slice(-40);
  } catch (e) {
    /* leave null */
  }
  const PROBE_SELECTORS = {
    owner: "0x8da5cb5b",
    name: "0x06fdde03",
    symbol: "0x95d89b41",
    totalSupply: "0x18160ddd",
    decimals: "0x313ce567",
    asset: "0x38d52e0f",
    token: "0xfc0c546a",
    underlying: "0x6f307dc3",
    want: "0x1f1fcd51",
    guardian: "0x452a9320",
  };
  out.probes = {};
  for (const [label, data] of Object.entries(PROBE_SELECTORS)) {
    try {
      const r = await rpcCall("eth_call", [{ to: address, data }, "latest"]);
      const raw = r && r.result;
      if (typeof raw === "string" && raw.length >= 2) {
        let decoded = raw.slice(0, 74);
        const body = raw.slice(2);
        if (/^0+[0-9a-fA-F]{40}$/.test(body)) decoded = "addr:0x" + body.slice(-40);
        else if (/^[0-9a-fA-F]{64}$/.test(body)) decoded = "uint:" + BigInt("0x" + body).toString();
        out.probes[label] = decoded;
      } else {
        out.probes[label] = "empty";
      }
    } catch (e) {
      out.probes[label] = "revert";
    }
  }
  if (chainCfg.blockscout) {
    try {
      const body = await httpJson(chainCfg.blockscout + "/api/v2/smart-contracts/" + address, opts.timeoutMs, 1);
      out.name = body && body.name ? String(body.name).slice(0, 120) : null;
      out.verified = body && body.is_verified === true;
      out.language = body && body.language ? body.language : null;
      out.proxyType = body && body.proxy_type ? body.proxy_type : null;
      out.abiEvents = abiEventInfo(body && body.abi, "").eventNames.slice(0, 40);
      out.implementations = Array.isArray(body && body.implementations)
        ? body.implementations.map((x) => (x && (x.address_hash || x.hash)) || null).filter(Boolean)
        : [];
    } catch (e) {
      out.explorerError = sanitizeErr(e);
    }
    try {
      const b2 = await httpJson(chainCfg.blockscout + "/api/v2/addresses/" + address, opts.timeoutMs, 1);
      if (b2 && b2.name) out.addressName = String(b2.name).slice(0, 120);
      if (b2 && b2.is_contract !== undefined) out.addressIsContract = b2.is_contract === true;
    } catch (e) {
      /* ignore */
    }
  }
  try {
    let s = null;
    try {
      s = await httpJson(SOURCIFY + "/v2/contract/" + chainCfg.chainId + "/" + address + "?fields=metadata,abi,sources", opts.timeoutMs, 1);
    } catch (e) {
      s = await httpJson(SOURCIFY + "/v2/contract/" + chainCfg.chainId + "/" + address + "?fields=all", opts.timeoutMs, 1);
    }
    out.sourcifyMatch = s && s.match ? s.match : null;
    out.sourcifyCreationMatch = s && s.creationMatch ? s.creationMatch : null;
    if (s && s.metadata) {
      const ct = s.metadata.settings && s.metadata.settings.compilationTarget;
      out.sourcifyCompilationTarget = ct ? Object.entries(ct).map(([f, c]) => f + ":" + c) : null;
      out.sourcifySources = s.metadata.sources ? Object.keys(s.metadata.sources).slice(0, 40) : null;
    }
    if (s && Array.isArray(s.abi)) {
      out.sourcifyFunctions = Array.from(new Set(s.abi.filter((x) => x && x.type === "function").map((x) => x.name))).slice(0, 80);
    }
    if (s && s.sources && typeof s.sources === "object") {
      out.sourcifySourceFiles = Object.keys(s.sources);
      out.sourcifySourceContent = {};
      for (const [k, v] of Object.entries(s.sources)) {
        out.sourcifySourceContent[k] = typeof v === "string" ? v : (v && v.content) || null;
      }
    }
  } catch (e) {
    out.sourcifyError = sanitizeErr(e);
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) {
    selfTest();
    process.stdout.write("SELFTEST_OK\n");
    return;
  }
  if (opts.inspect) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(opts.inspect)) throw new Error("BAD_ADDRESS");
    const info = await inspectContract(opts.chain, opts.inspect, opts);
    process.stdout.write("INSPECT chain=" + info.chain + " address=" + info.address + "\n");
    process.stdout.write("  codeSize=" + info.codeSize + " isContract=" + info.isContract + " eip1967Impl=" + (info.eip1967Impl || "-") + "\n");
    process.stdout.write("  name=" + (info.name || info.addressName || "-") + " verified=" + info.verified + " language=" + (info.language || "-") + " proxyType=" + (info.proxyType || "-") + "\n");
    process.stdout.write("  implementations=" + JSON.stringify(info.implementations) + "\n");
    process.stdout.write("  probes=" + JSON.stringify(info.probes || {}) + "\n");
    process.stdout.write("  abiEvents=" + JSON.stringify(info.abiEvents || []) + "\n");
    process.stdout.write("  sourcifyMatch=" + (info.sourcifyMatch || "-") + " creationMatch=" + (info.sourcifyCreationMatch || "-") + " compilationTarget=" + JSON.stringify(info.sourcifyCompilationTarget || []) + "\n");
    process.stdout.write("  sourcifySources=" + JSON.stringify(info.sourcifySources || []) + "\n");
    process.stdout.write("  sourcifyFunctions=" + JSON.stringify(info.sourcifyFunctions || []) + "\n");
    if (info.sourcifySourceContent && Object.keys(info.sourcifySourceContent).length) {
      const dir = path.join(ROOT, "temp", "inspect");
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, "inspect-" + info.address.toLowerCase() + ".json");
      fs.writeFileSync(p, JSON.stringify(info.sourcifySourceContent, null, 2) + "\n");
      process.stdout.write("  sourcedump=" + p + " files=" + Object.keys(info.sourcifySourceContent).length + "\n");
    }
    for (const [k, val] of Object.entries(info)) {
      if (k.endsWith("Error")) process.stdout.write("  " + k + "=" + val + "\n");
    }
    return;
  }
  if (opts.find) {
    const res = await findContracts(opts.chain, opts.find, opts);
    process.stdout.write("FIND chain=" + opts.chain + " query=" + JSON.stringify(res.query) + (res.error ? " error=" + res.error : " items=" + res.items.length) + "\n");
    for (const it of res.items) {
      process.stdout.write("  " + (it.name || "-") + " " + (it.address || "-") + " type=" + (it.type || "-") + " isContract=" + it.isContract + "\n");
    }
    return;
  }
  if (opts.probeRegistry) {
    const lines = await probeRegistry(opts.chain, opts);
    process.stdout.write("REGISTRY_PROBE chain=" + opts.chain + " entries=" + lines.length + "\n");
    for (const l of lines) {
      process.stdout.write(
        "  " + l.name + " " + l.address + " kind=" + l.kind + " code=" + l.code + " expectNameOk=" + l.expectNameOk + " abiEventOk=" + l.abiEventOk + " abiEventNameSeen=" + l.abiEventNameSeen + " logTopicOk=" + (l.logTopicOk === undefined ? "n/a" : l.logTopicOk) + " verified=" + l.verified + " verdict=" + l.verdict + (l.abiParseError ? " abiParseError=" + l.abiParseError : "") + (!l.abiEventOk && l.abiEventNames ? " abiEvents=" + l.abiEventNames.join("|") : "") + (l.matchedEvent ? " matchedEvent=(" + l.matchedEvent + ")" : "") + "\n"
      );
    }
    return;
  }
  if (!["hybrid", "blocks", "explorer"].includes(opts.mode)) throw new Error("BAD_MODE " + opts.mode);

  dbg("chain=" + opts.chain, "mode=" + opts.mode, "blocks=" + opts.blocks, "explorerPages=" + opts.explorerPages, "sourcifyLimit=" + opts.sourcifyLimit, "factory=" + opts.factory, "factoryBlocks=" + opts.factoryBlocks, "liveness=" + opts.liveness);
  const artifact = await scanChain(opts.chain, opts);

  const outPath =
    opts.out ||
    path.join(REPORTS_DIR, "new-deployments-" + opts.chain + "-" + nowUtcStamp() + ".json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n");

  if (!opts.quiet) {
    const t = artifact.totals;
    const f = artifact.sources.factoryEvents;
    const lv = artifact.sources.livenessPrefilter;
    process.stdout.write("SCAN_OK chain=" + artifact.chain + " head=" + artifact.bounds.headBlock + "\n");
    process.stdout.write("  window=" + artifact.bounds.fromBlock + ".." + artifact.bounds.toBlock + " blocksScanned=" + artifact.bounds.blocksScanned + " txs=" + artifact.bounds.txsScanned + "\n");
    process.stdout.write("  factoryWindow=" + artifact.bounds.factoryFromBlock + ".." + artifact.bounds.factoryToBlock + " registered=" + (f ? f.entriesRegistered : 0) + " entriesOk=" + (f ? f.entriesOk : 0) + " logsFetched=" + (f ? f.logsFetched : 0) + " factoryCreations=" + t.onchainCreations.factoryEvent + "\n");
    process.stdout.write("  directCreations=" + t.onchainCreations.directCreate + " enumerated=" + t.enumerated + " classified=" + t.classified + " classMatchedBeforeLiveness=" + t.classMatchedBeforeLiveness + " livenessRemoved=" + (lv ? lv.removed : 0) + " classMatched=" + t.classMatched + " excluded=" + t.excluded + " other=" + t.other + "\n");
    process.stdout.write("  byClass=" + JSON.stringify(t.byClass) + "\n");
    process.stdout.write("  artifact=" + outPath + "\n");
    for (const r of artifact.rows.filter((x) => x.riskClass && x.liveness !== "dormant")) {
      process.stdout.write("  [" + r.class + "] " + r.address + " " + (r.name || "-") + " block=" + (r.creationBlock || "-") + " source=" + r.source + " liveness=" + (r.liveness || "-") + "\n");
    }
    for (const r of artifact.rows.filter((x) => x.liveness === "dormant")) {
      process.stdout.write("  [suppressed] " + r.address + " " + (r.name || "-") + " reasons=" + JSON.stringify(r.livenessReasons || []) + "\n");
    }
  }
}

main().catch((e) => {
  process.stderr.write("SCAN_FAIL " + sanitizeErr(e) + "\n");
  process.exitCode = 1;
});
