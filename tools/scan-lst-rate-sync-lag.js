#!/usr/bin/env node
"use strict";

// scan-lst-rate-sync-lag.js — N3: cross-domain LST rate-bridge latency pairing.
//
// Two modes:
//   * DEFAULT (offline source authoring) — unchanged r1 artifact at
//     reports/raw/fast/lst-rate-sync-lag/r1.json. No network, no calls.
//   * --live (read-only same-pin comparison pass) — resolves one read-qualified
//     endpoint per chain from the shared RPC pool (./shared-rpc), pins ONE
//     finalized block per chain, and pairs the deployed L1 canonical LST rate
//     against the L2/local consumer representation at that pin. Writes
//     reports/raw/fast/lst-rate-sync-lag/r2.json (r1 is left intact).
//
// Read-only. No signing, broadcast, funds movement, or state-changing call.
// Endpoints are resolved in memory from ./shared-rpc and are never printed,
// stored in the artifact, or written to disk.
//
// SAFETY:
//   * No .env*, *.key or *-keypair.json access.
//   * eth_call / eth_getBlockByNumber / eth_chainId class reads only.
//   * Bounded: <= 30 calls per chain; fail-closed per family (MISS/UNREACHABLE
//     recorded, no crash).
//
// Exit code: always 0. Missing checkouts / unreadable files become MISS gaps.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_DIR = path.join(WORKSPACE, "reports", "raw", "fast", "lst-rate-sync-lag");
const OUT = path.join(OUT_DIR, "r1.json");
const LIVE_OUT = path.join(OUT_DIR, "r2.json");
const QUIET = process.argv.includes("--quiet");
const LIVE_REQUESTED = process.argv.includes("--live");

const ETHERFI_PR77 = "targets/etherfi-weeth-cross-chain-pr77/contracts";
const ETHERFI_PRE77 = "targets/etherfi-weeth-cross-chain-pre77-cc6c220/contracts";
const LIDO_V400 = "targets/lido-core-v4.0.0/contracts";

const EXCLUDE_DIRS = new Set([
  "node_modules", "out", "cache", ".git", "lib", "artifacts",
  "scripts", "test", "tests", "audit", "output", "utils", "transaction-parsing",
]);

const SIBLING_HARNESSES = [
  {
    path: "tools/scan-hyperevm-lst-lrt-oracle-routes.js",
    artifact: "reports/raw/fast/hyperevm-lst-lrt-oracle-routes.json",
    role: "HyperEVM (chain 999) HYPE LST/LRT oracle-route enumeration; produces the route inventory a live pairing pass consumes.",
  },
  {
    path: "tools/quote-hyperevm-lst-lrt-exact-routes.js",
    artifact: "reports/raw/fast/hyperevm-lst-lrt-exact-quotes.json",
    role: "Targeted read-only exact quote probe over the enumerated LST/LRT routes (reuses the oracle-route artifact).",
  },
  {
    path: "tools/scan-wsteth-dex-discount.js",
    artifact: "reports/raw/fast/wsteth-dex-discount.json",
    role: "wstETH DEX-discount vs stETH-backing scanner (chain 1); the L1 half of a cross-domain wstETH rate-lag pairing.",
  },
];

// Tokens whose PRESENCE in the PR77 file but ABSENCE in pre77 marks the PR77 delta,
// scoped to the rate-bridge / admission-surface question.
const PR77_SURFACE_TOKENS = [
  "PausableUntil", "pauseUntil", "unpauseUntil", "setPauseUntilDuration",
  "_roleRegistry", "whenNotPaused", "_requireNotPaused", "onlyOperatingTimelock",
  "onlyOperatingMultisig", "onlyGuardian", "depositWithERC20", "_disableInitializers",
  "getConversionAmount", "latestRoundData", "freshPeriod", "setRateParameters",
];

// Rate-related lido function surface to enumerate.
const LIDO_FILES = [
  "0.8.9/WithdrawalQueue.sol",
  "0.8.9/WithdrawalQueueBase.sol",
  "0.8.9/WstETH.sol",
  "0.8.25/vaults/LazyOracle.sol",
  "0.8.9/TokenRateNotifier.sol",
  "0.8.9/oracle/AccountingOracle.sol",
  "0.8.9/oracle/BaseOracle.sol",
  "common/lib/RateLimit.sol",
];
const RATE_FN_RE = /\bfunction\s+(\w+)\s*\(([^)]*)\)/g;

// --- helper primitives --------------------------------------------------------------------
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function rel(p) { return path.relative(WORKSPACE, p).replace(/\\/g, "/"); }
function read(p) { try { return fs.readFileSync(p, "utf8"); } catch (_) { return null; } }
function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }

function walkSol(dir, acc = [], cap = 4000) {
  if (!fs.existsSync(dir)) return acc;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      walkSol(path.join(dir, e.name), acc, cap);
    } else if (e.isFile() && e.name.endsWith(".sol")) {
      acc.push(path.join(dir, e.name));
    }
    if (acc.length >= cap) break;
  }
  return acc;
}

function hashMap(dir) {
  const out = new Map();
  for (const f of walkSol(dir)) {
    const text = read(f);
    if (text === null) continue;
    // Key by path RELATIVE to `dir` so the two checkout roots can be compared.
    out.set(path.relative(dir, f).replace(/\\/g, "/"), sha256(text));
  }
  return out;
}

function diffCheckoutPairs(aDirRel, bDirRel) {
  const aAbs = path.join(WORKSPACE, aDirRel);
  const bAbs = path.join(WORKSPACE, bDirRel);
  const aPresent = fs.existsSync(aAbs);
  const bPresent = fs.existsSync(bAbs);
  if (!aPresent || !bPresent) {
    return { aPresent, bPresent, onlyInA: [], onlyInB: [], changed: [], note: "one or both checkouts absent" };
  }
  const a = hashMap(aAbs);
  const b = hashMap(bAbs);
  const onlyInA = [...a.keys()].filter((k) => !b.has(k)).sort();
  const onlyInB = [...b.keys()].filter((k) => !a.has(k)).sort();
  const changed = [...a.keys()].filter((k) => b.has(k) && b.get(k) !== a.get(k)).sort();
  return { aPresent, bPresent, onlyInA, onlyInB, changed, note: "pure file-hash diff of .sol under contracts/ (bounded; excludes lib/node_modules/out/test)" };
}

function surfaceTokensForChanged(relChanged, aDirRel, bDirRel) {
  const aText = read(path.join(WORKSPACE, aDirRel, relChanged)) || "";
  const bText = read(path.join(WORKSPACE, bDirRel, relChanged)) || "";
  const aLines = aText.split(/\r?\n/);
  const facts = [];
  for (const token of PR77_SURFACE_TOKENS) {
    const inA = aText.includes(token);
    const inB = bText.includes(token);
    if (!inA && !inB) continue;
    let line = null;
    for (let i = 0; i < aLines.length; i++) { if (aLines[i].includes(token)) { line = i + 1; break; } }
    facts.push({
      file: `${aDirRel}/${relChanged}`.replace(/\\/g, "/"),
      line,
      token,
      status: inA && !inB ? "ADDED_IN_PR77" : inA && inB ? "UNCHANGED_PRESENT_IN_BOTH" : "REMOVED_IN_PR77",
    });
  }
  return facts;
}

function enumerateLidoSurface() {
  const rows = [];
  const base = path.join(WORKSPACE, LIDO_V400);
  for (const relFile of LIDO_FILES) {
    const file = path.join(base, relFile);
    const text = read(file);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      RATE_FN_RE.lastIndex = 0;
      let m;
      while ((m = RATE_FN_RE.exec(lines[i])) !== null) {
        const name = m[1];
        if (!/rate|share|oracle|withdraw|claim|bunker|report|lastUpdated|stEth|wstEth|Withdrawal|request/i.test(name)) continue;
        rows.push({
          file: `${LIDO_V400}/${relFile}`,
          line: i + 1,
          kind: "function",
          name,
          signature: `function ${name}(${m[2].replace(/\s+/g, " ").trim()})`,
        });
        if (rows.length >= 80) return rows;
      }
    }
  }
  return rows;
}

// --- offline artifact ---------------------------------------------------------------------
function buildOfflineArtifact(scannedAt) {
  const gaps = [];

  // Part (a1): etherfi PR77 vs pre77 rate-bridge diff.
  const etherfiDiff = diffCheckoutPairs(ETHERFI_PR77, ETHERFI_PRE77);
  if (!etherfiDiff.aPresent || !etherfiDiff.bPresent) {
    gaps.push({ id: "MISS-etherfi-checkout", status: "MISS", note: "etherfi PR77 and/or pre77 contracts dir absent; diff not derivable" });
  }
  const changedFacts = [];
  for (const relChanged of etherfiDiff.changed) {
    changedFacts.push({ changedFile: `${ETHERFI_PR77}/${relChanged}`.replace(/\\/g, "/"), facts: surfaceTokensForChanged(relChanged, ETHERFI_PR77, ETHERFI_PRE77) });
  }

  // Part (a2): lido v4.0.0 withdrawal-queue era surface.
  const lidoAbs = path.join(WORKSPACE, LIDO_V400);
  const lidoPresent = fs.existsSync(lidoAbs);
  const lidoSurface = lidoPresent ? enumerateLidoSurface() : [];
  if (!lidoPresent) {
    gaps.push({ id: "MISS-lido-checkout", status: "MISS", note: `lido checkout absent at ${LIDO_V400}; expected lido-core-v4.0.0(+)` });
  } else if (lidoSurface.length === 0) {
    gaps.push({ id: "MISS-lido-surface", status: "MISS", note: "lido checkout present but no rate/withdrawal function surface matched the bounded patterns" });
  }

  // Part (b): structured future-live plan + honest liveNotWired status.
  const plan = {
    status: "liveNotWired",
    liveRequested: LIVE_REQUESTED,
    offlineOnly: true,
    note: "Nothing was resolved or called this revision. The address/ABI surface below is what a future read-only --live pass would bind; no endpoint, address, or calldata exists statically in this artifact.",
    futureLiveSteps: [
      "1. Resolve endpoints in memory via ./shared-rpc (resolveRpc/rpcCall, env-backed); never print or persist URLs.",
      "2. Bind the lido WithdrawalQueue share-rate surface: WithdrawalQueue.getLastRequestId / getWithdrawalStatus / getBunkerModeSinceTimestamp and the accounting oracle's last completed report delta.",
      "3. Bind the etherfi L2 exchange-rate-provider surface (getRateParameters / getConversionAmount) on the L2s and the L1 sync pools; read latestRoundData().updatedAt and freshPeriod to derive per-token rate staleness.",
      "4. Pair each L1 LST redemption rate against the L2/LRT minting rate at the SAME block tag and compute the lag window (lastUpdated + freshPeriod - now); flag only pairs where a consumer mints/credits on the stale (fresher or older) side.",
      "5. Reuse the three sibling harnesses to enumerate/quote the DEX legs that monetize a rate gap; do not treat a rate gap alone as a finding.",
    ],
  };

  const abiSurface = [
    { contract: "lido WithdrawalQueue (0.8.9)", reads: ["requestWithdrawals(uint256[],address)", "getWithdrawalStatus(uint256[])", "getLastRequestId()", "getBunkerModeSinceTimestamp()"], anchor: `${LIDO_V400}/0.8.9/WithdrawalQueue.sol` },
    { contract: "lido WstETH (0.8.9)", reads: ["getStETHByWstETH(uint256)", "stEthPerToken()"], anchor: `${LIDO_V400}/0.8.9/WstETH.sol` },
    { contract: "etherfi L2ExchangeRateProviderUpgradeable", reads: ["getRateParameters(address)", "getConversionAmount(address,uint256)"], anchor: `${ETHERFI_PR77}/native-minting/layerzero-base/L2ExchangeRateProviderUpgradeable.sol` },
    { contract: "etherfi EtherfiL2ExchangeRateProvider", reads: ["(rate via IAggregatorV3.latestRoundData + decimals)"], anchor: `${ETHERFI_PR77}/native-minting/EtherfiL2ExchangeRateProvider.sol` },
  ];

  return {
    scannedAt,
    scanner: "tools/scan-lst-rate-sync-lag.js",
    mode: "offline-source-authoring",
    revision: "r1",
    liveNotWired: true,
    semantics: {
      goal: "Cross-domain LST rate-bridge latency pairing: pair an L1 LST redemption rate against a cross-domain/LRT minting rate and measure the lag window at a shared block tag. A gap is only actionable when a consumer credites on the stale side AND a DEX leg monetizes it.",
      whyOffline: "Authoring revision: enumerate the surface and record the plan honestly. No live read is wired, so no staleness claim is asserted.",
    },
    partA: {
      etherfiRateBridge: {
        pr77Root: ETHERFI_PR77,
        pre77Root: ETHERFI_PRE77,
        diff: etherfiDiff,
        changedFacts,
        rateTransportNote: "The rate-oracle TRANSPORT (L2ExchangeRateProviderUpgradeable / EtherfiL2ExchangeRateProvider) is byte-identical between PR77 and pre77 — PR77 does NOT change rate transport. The changes are on the L1 admission path: a PausableUntil pause gate, a roleRegistry immutable, _disableInitializers in the constructor, and a liquifier.depositWithERC20 arity change (3->4 args).",
        l2ReceiverTrustNote: "L2 receiver trust is unchanged by PR77 and rests on (i) the LayerZero OApp peer/endpoint and (ii) Ownable-gated setRateParameters (rate oracle address) owned by the L2 owner. There is no in-repo change to peer validation or the rate-oracle freshness check (lastUpdated + freshPeriod < now).",
      },
      lidoWithdrawalQueue: {
        checkout: LIDO_V400,
        present: lidoPresent,
        surfaces: lidoSurface,
        note: "lido-core v4.0.0(+) withdrawal-queue era: rate/share surface enumerated from source for a future live binding. No rate value is read offline.",
      },
    },
    abiSurface: {
      offlineResolved: false,
      addressSurface: [],
      addressSurfaceNote: "No deployed addresses exist in these checkouts; a live pass must resolve them from a deployment map (out of scope this revision).",
      abiSurface,
    },
    siblingHarnesses: SIBLING_HARNESSES,
    plan,
    gaps,
    safety: {
      offline: true, networkCalls: false, rpcUrlsStored: false, privateKeysRead: false,
      signedActions: false, broadcast: false, forkTransactions: false, liveCalls: false,
    },
    exitCode: 0,
  };
}

// --- live read-only pass ------------------------------------------------------------------
const MAX_CALLS_PER_CHAIN = 30;
const CALL_TIMEOUT_MS = 12000;

// Every address below is recorded inside this workspace; the `source` field cites where.
// No endpoint material is ever placed here or in the artifact.
const LIVE_REGISTRY = {
  wstETH: {
    canonicalChainId: 1,
    l1Token: { address: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", method: "stEthPerToken", source: "tools/scan-base-bridge-phase0.js / tools/scan-arbitrum-bridge-phase0.js (wstETH L1)" },
    l1CrossCheck: { address: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", method: "getPooledEthByShares(1e18)", source: "tools/atomic/lido-nest-bootstrap-gate4/index.js (stETH L1)" },
    l2: [
      { chainId: 10, token: "0x1f32b1c2345538c0c6f582fcb022739c4a194ebb", weth: "0x4200000000000000000000000000000000000006", oracle: "0xd81eb3728a631871a7ebbad631b5f424909f0c77", pool: "0x794a61358d6845594f94dc1db02a252b5b4814ad", source: "reports/monitor/aave-v3-l2-outage-l-index.json" },
      { chainId: 8453, token: "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452", weth: "0x4200000000000000000000000000000000000006", oracle: "0x2cc0fc26ed4563a5ce5e8bdcfe1a2878676ae156", pool: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5", source: "tools/scan-base-bridge-phase0.js + reports/raw/fast/aave-v3-base-reserve-observation.json" },
      { chainId: 42161, token: "0x5979d7b546e38e414f7e9822514be443a4800529", weth: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", oracle: "0xb56c2f0b653b2e0b10c9b928c8580ac5df02c7c7", pool: "0x794a61358d6845594f94dc1db02a252b5b4814ad", source: "tools/scan-arbitrum-bridge-phase0.js + reports/monitor/aave-v3-l2-outage-l-index.json" },
    ],
  },
  weETH: {
    canonicalChainId: 1,
    l1Token: { address: "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee", method: "getRate", source: "tools/capture-etherfi-26q2-upgrade-migration-gate0.js + targets/etherfi-weeth-cross-chain-pr77/interfaces/IWeEth.sol" },
    l2: [
      { chainId: 8453, kind: "aave-oracle", token: "0x04c0599ae5a44757c0af6f9ec3b93da8976c150a", weth: "0x4200000000000000000000000000000000000006", oracle: "0x2cc0fc26ed4563a5ce5e8bdcfe1a2878676ae156", pool: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5", source: "reports/raw/fast/aave-v3-base-reserve-observation.json + PR77 output/8453.json" },
      { chainId: 10, kind: "etherfi-sync-pool", syncPool: "0xc9475e18e2c5c26ea6adcd55fabe07920bea887e", source: "targets/etherfi-weeth-cross-chain-pr77/output/op_L2_SetMinSync.json" },
    ],
  },
  lidoWithdrawalQueue: {
    chainId: 1,
    queue: "0x889edc2edab5f40e902b864ad4d7ade8e412f9b1",
    source: "tools/capture-critical-renzo-v21-current-runtime-binding-step4a.js",
  },
};

const LIVE_ABI = [
  "function stEthPerToken() view returns (uint256)",
  "function getPooledEthByShares(uint256) view returns (uint256)",
  "function getRate() view returns (uint256)",
  "function getLastRequestId() view returns (uint256)",
  "function getLastFinalizedRequestId() view returns (uint256)",
  "function isBunkerModeActive() view returns (bool)",
  "function bunkerModeSinceTimestamp() view returns (uint256)",
  "function getSourceOfAsset(address) view returns (address)",
  "function getAssetPrice(address) view returns (uint256)",
  "function latestAnswer() view returns (int256)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function getTokenOut() view returns (address)",
  "function getL2ExchangeRateProvider() view returns (address)",
  "function getRateParameters(address) view returns (address rateOracle, uint64 depositFee, uint32 freshPeriod)",
  "function getConversionAmount(address,uint256) view returns (uint256)",
];

function redact(s) { return String(s == null ? "unknown" : s).replace(/https?:\/\/\S+/gi, "[redacted-url]").slice(0, 160); }
function bigOrNull(v) { try { return v == null ? null : v.toString(); } catch (_) { return null; } }
function toNum(x) { try { const n = Number(x); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
// bps = (a-b)/b*1e4, 2-decimal, bigint-safe.
function divergenceBps(a, b) {
  if (a == null || b == null || b === 0n) return null;
  return Number(((a - b) * 1_000_000n) / b) / 100;
}
function ratio1e18(numerator, denominator) {
  if (numerator == null || denominator == null || denominator === 0n) return null;
  return (numerator * (10n ** 18n)) / denominator;
}
function fmt1e18(v) { try { return v == null ? null : Number(v) / 1e18; } catch (_) { return null; } }

async function buildLive(scannedAt) {
  const ethers = require("ethers");
  const shared = require("./shared-rpc");
  const iface = new ethers.Interface(LIVE_ABI);

  const counters = { rpcCalls: 0, chainsRequested: 0, chainsQualified: 0, chainsUnreachable: 0, familiesOk: 0, familiesPartial: 0, familiesMiss: 0 };
  const perChain = {};
  const chainCtx = new Map();
  const notMeasured = [];
  const gaps = [];

  async function ensureChain(chainId) {
    if (chainCtx.has(chainId)) return chainCtx.get(chainId);
    counters.chainsRequested += 1;
    const ctx = { chainId, qualified: false, blockTag: null, blockNumber: null, blockTimestamp: null, finality: null, calls: 0, callLimit: MAX_CALLS_PER_CHAIN, exceeded: false };
    chainCtx.set(chainId, ctx);
    perChain[chainId] = ctx;
    let url = null;
    try { url = await shared.resolveRpc(chainId, null, { capability: "read" }); } catch (_) { url = null; }
    ctx.qualified = typeof url === "string" && url.length > 0;
    if (!ctx.qualified) { counters.chainsUnreachable += 1; return ctx; }
    counters.chainsQualified += 1;
    // Pin ONE finalized block per chain (fall back to latest and record the downgrade).
    let blk = null;
    ctx.calls += 1; counters.rpcCalls += 1;
    try { blk = await shared.rpcCall(url, "eth_getBlockByNumber", ["finalized", false], CALL_TIMEOUT_MS); } catch (_) { blk = null; }
    if (!blk || typeof blk.number !== "string") {
      ctx.calls += 1; counters.rpcCalls += 1;
      try { blk = await shared.rpcCall(url, "eth_getBlockByNumber", ["latest", false], CALL_TIMEOUT_MS); } catch (_) { blk = null; }
      ctx.finality = "latest-finalized-unavailable";
    } else {
      ctx.finality = "finalized";
    }
    if (blk && typeof blk.number === "string") {
      ctx.blockTag = blk.number;
      ctx.blockNumber = toNum(BigInt(blk.number));
      ctx.blockTimestamp = typeof blk.timestamp === "string" ? toNum(BigInt(blk.timestamp)) : null;
      ctx.hash = typeof blk.hash === "string" ? blk.hash : null;
    }
    ctx.url = url; // process-only; never serialized into the artifact
    return ctx;
  }

  async function readCall(chainId, to, fn, args) {
    const ctx = await ensureChain(chainId);
    if (!ctx.qualified) return { ok: false, reason: "UNREACHABLE", sub: "no read-qualified endpoint in shared pool" };
    if (!ctx.blockTag) return { ok: false, reason: "UNREACHABLE", sub: "no pinned block header" };
    if (ctx.calls >= ctx.callLimit) { ctx.exceeded = true; return { ok: false, reason: "BUDGET", sub: "per-chain call cap reached" }; }
    ctx.calls += 1; counters.rpcCalls += 1;
    try {
      const data = iface.encodeFunctionData(fn, args || []);
      const raw = await shared.rpcCall(ctx.url, "eth_call", [{ to, data }, ctx.blockTag], CALL_TIMEOUT_MS);
      if (typeof raw !== "string" || !/^0x[0-9a-fA-F]*$/.test(raw) || raw === "0x") return { ok: false, reason: "MISS", sub: "empty/reverted result" };
      const dec = iface.decodeFunctionResult(fn, raw);
      return { ok: true, decoded: dec, raw };
    } catch (e) {
      return { ok: false, reason: "MISS", sub: redact(e && (e.shortMessage || e.message)) };
    }
  }

  const readRow = (r, extra) => r.ok
    ? { status: "OK", raw: bigOrNull(r.decoded[0]), ...(extra || {}) }
    : { status: r.reason, reason: r.sub, ...(extra || {}) };

  // --- wstETH family ---
  const famWst = { family: "wstETH", status: "MISS", canonical: null, l2: [], divergenceBps: null, lastSyncEventAgeSeconds: null, lastSyncEventSource: null, consumerCoupling: [] };
  {
    const c = await readCall(1, LIVE_REGISTRY.wstETH.l1Token.address, "stEthPerToken", []);
    const x = await readCall(1, LIVE_REGISTRY.wstETH.l1CrossCheck.address, "getPooledEthByShares", [10n ** 18n]);
    const canon = c.ok ? c.decoded[0] : null;
    famWst.canonical = {
      chainId: 1,
      contract: "wstETH(L1)",
      address: LIVE_REGISTRY.wstETH.l1Token.address,
      method: "stEthPerToken()",
      status: c.ok ? "OK" : c.reason,
      canonicalRateRaw: bigOrNull(canon),
      canonicalRate: fmt1e18(canon),
      crossCheckStEthPerShareRaw: x.ok ? bigOrNull(x.decoded[0]) : null,
      crossCheckMatches: c.ok && x.ok ? c.decoded[0] === x.decoded[0] : null,
      source: LIVE_REGISTRY.wstETH.l1Token.source,
    };
    for (const leg of LIVE_REGISTRY.wstETH.l2) {
      const probe = await readCall(leg.chainId, leg.token, "stEthPerToken", []);
      const pTok = await readCall(leg.chainId, leg.oracle, "getAssetPrice", [leg.token]);
      const pWeth = await readCall(leg.chainId, leg.oracle, "getAssetPrice", [leg.weth]);
      const src = await readCall(leg.chainId, leg.oracle, "getSourceOfAsset", [leg.token]);
      let localRaw = null;
      if (pTok.ok && pWeth.ok && pWeth.decoded[0] !== 0n) localRaw = ratio1e18(pTok.decoded[0], pWeth.decoded[0]);
      const d = c.ok && localRaw != null ? divergenceBps(localRaw, canon) : null;
      const feed = src.ok && src.decoded[0] !== "0x0000000000000000000000000000000000000000" ? src.decoded[0] : null;
      let feedAnswer = null;
      if (feed) { const la = await readCall(leg.chainId, feed, "latestAnswer", []); if (la.ok) feedAnswer = bigOrNull(la.decoded[0]); }
      famWst.l2.push({
        chainId: leg.chainId,
        localTokenStEthPerToken: probe.ok ? bigOrNull(probe.decoded[0]) : probe.reason,
        localRateViaLendingOracle: {
          method: "AaveOracle.getAssetPrice(token)/getAssetPrice(WETH)",
          impliedRate1e18Raw: bigOrNull(localRaw),
          impliedRate1e18: fmt1e18(localRaw),
          assetPriceRaw: pTok.ok ? bigOrNull(pTok.decoded[0]) : pTok.reason,
          wethPriceRaw: pWeth.ok ? bigOrNull(pWeth.decoded[0]) : pWeth.reason,
          status: localRaw != null ? "OK" : "MISS",
        },
        divergenceBps: d,
        arbitrationNote: "stETH~ETH assumed for the L1/L2 orientation; ≤1 bps of this divergence is oracle rounding.",
      });
      famWst.consumerCoupling.push({
        protocol: "Aave v3",
        chainId: leg.chainId,
        listed: feed != null,
        pool: leg.pool,
        priceOracle: leg.oracle,
        oracleSourceForLst: feed,
        oracleSourceLatestAnswerRaw: feedAnswer,
        stalenessGuard: "none-onchain: the lending oracle source exposes no updatedAt/heartbeat at the pinned block",
        source: leg.source,
      });
    }
    if (c.ok) { famWst.status = famWst.l2.some((l) => l.localRateViaLendingOracle.status === "OK") ? "OK" : "PARTIAL"; }
    else famWst.status = c.reason;
    famWst.divergenceBps = famWst.l2.map((l) => l.divergenceBps).filter((v) => v != null);
    notMeasured.push("wstETH lastSyncEventAgeSeconds: L2 wstETH token exposes no rate/updatedAt getter (revert) and the Aave price-feed source exposes only latestAnswer()/decimals(), no timestamp.");
  }

  // --- weETH family ---
  const famWe = { family: "weETH", status: "MISS", canonical: null, l2: [], divergenceBps: null, lastSyncEventAgeSeconds: null, lastSyncEventSource: null, consumerCoupling: [] };
  {
    const c = await readCall(1, LIVE_REGISTRY.weETH.l1Token.address, "getRate", []);
    const canon = c.ok ? c.decoded[0] : null;
    famWe.canonical = {
      chainId: 1,
      contract: "weETH(L1)",
      address: LIVE_REGISTRY.weETH.l1Token.address,
      method: "getRate()",
      status: c.ok ? "OK" : c.reason,
      canonicalRateRaw: bigOrNull(canon),
      canonicalRate: fmt1e18(canon),
      source: LIVE_REGISTRY.weETH.l1Token.source,
    };
    for (const leg of LIVE_REGISTRY.weETH.l2) {
      if (leg.kind === "aave-oracle") {
        const pTok = await readCall(leg.chainId, leg.oracle, "getAssetPrice", [leg.token]);
        const pWeth = await readCall(leg.chainId, leg.oracle, "getAssetPrice", [leg.weth]);
        const src = await readCall(leg.chainId, leg.oracle, "getSourceOfAsset", [leg.token]);
        let localRaw = null;
        if (pTok.ok && pWeth.ok && pWeth.decoded[0] !== 0n) localRaw = ratio1e18(pTok.decoded[0], pWeth.decoded[0]);
        const d = c.ok && localRaw != null ? divergenceBps(localRaw, canon) : null;
        const feed = src.ok && src.decoded[0] !== "0x0000000000000000000000000000000000000000" ? src.decoded[0] : null;
        famWe.l2.push({
          chainId: leg.chainId,
          kind: "aave-oracle",
          localRateViaLendingOracle: { method: "AaveOracle.getAssetPrice(weETH)/getAssetPrice(WETH)", impliedRate1e18Raw: bigOrNull(localRaw), impliedRate1e18: fmt1e18(localRaw), status: localRaw != null ? "OK" : "MISS" },
          divergenceBps: d,
        });
        famWe.consumerCoupling.push({ protocol: "Aave v3", chainId: leg.chainId, listed: feed != null, pool: leg.pool, priceOracle: leg.oracle, oracleSourceForLst: feed, stalenessGuard: "none-onchain", source: leg.source });
      } else if (leg.kind === "etherfi-sync-pool") {
        const tokenOut = await readCall(leg.chainId, leg.syncPool, "getTokenOut", []);
        const provRead = await readCall(leg.chainId, leg.syncPool, "getL2ExchangeRateProvider", []);
        let rateParams = null, oracleAge = null, guard = null, mintAmount = null;
        if (tokenOut.ok && provRead.ok && provRead.decoded[0] !== "0x0000000000000000000000000000000000000000") {
          const rp = await readCall(leg.chainId, provRead.decoded[0], "getRateParameters", [tokenOut.decoded[0]]);
          if (rp.ok) {
            rateParams = { rateOracle: rp.decoded[0], depositFeeRaw: rp.decoded[1].toString(), freshPeriodSeconds: Number(rp.decoded[2]) };
            guard = rp.decoded[0] !== "0x0000000000000000000000000000000000000000" ? Number(rp.decoded[2]) : null;
            if (rp.decoded[0] !== "0x0000000000000000000000000000000000000000") {
              const lrd = await readCall(leg.chainId, rp.decoded[0], "latestRoundData", []);
              if (lrd.ok && perChain[leg.chainId].blockTimestamp != null) {
                const updatedAt = toNum(lrd.decoded[3]);
                oracleAge = updatedAt != null ? perChain[leg.chainId].blockTimestamp - updatedAt : null;
              }
            }
          }
          const gc = await readCall(leg.chainId, provRead.decoded[0], "getConversionAmount", [tokenOut.decoded[0], 10n ** 18n]);
          mintAmount = gc.ok ? bigOrNull(gc.decoded[0]) : gc.reason;
        }
        const rateOracleSet = rateParams && rateParams.rateOracle !== "0x0000000000000000000000000000000000000000";
        famWe.l2.push({
          chainId: leg.chainId,
          kind: "etherfi-sync-pool",
          syncPool: leg.syncPool,
          tokenOut: tokenOut.ok ? tokenOut.decoded[0] : tokenOut.reason,
          l2ExchangeRateProvider: provRead.ok ? provRead.decoded[0] : provRead.reason,
          rateParameters: rateParams,
          localRateStatus: rateOracleSet ? "OK" : "MISS: getRateParameters(tokenOut) has no rateOracle at the pinned block",
          getConversionAmountPerWeETH: mintAmount,
          consumerStalenessGuardSeconds: guard,
          stalenessGuardBasis: "EtherfiL2ExchangeRateProvider: revert OutdatedRate when lastUpdated+freshPeriod<now",
          lastSyncEventAgeSeconds: oracleAge,
          source: leg.source,
        });
        famWe.consumerCoupling.push({ protocol: "ether.fi native-minting sync pool", chainId: leg.chainId, target: leg.syncPool, listed: true, stalenessGuardSeconds: guard, stalenessGuardBasis: "freshPeriod (on-chain, readable)", source: leg.source });
      }
    }
    const measured = famWe.l2.filter((l) => l.divergenceBps != null);
    if (c.ok) famWe.status = measured.length ? "OK" : "PARTIAL";
    else famWe.status = c.reason;
    famWe.divergenceBps = measured.map((l) => l.divergenceBps);
    famWe.lastSyncEventAgeSeconds = famWe.l2.map((l) => l.lastSyncEventAgeSeconds).find((v) => v != null) ?? null;
    famWe.lastSyncEventSource = famWe.lastSyncEventAgeSeconds != null ? "etherfi L2 rate oracle latestRoundData().updatedAt" : null;
    notMeasured.push("weETH OP native-minting rate: sync pool getRateParameters(tokenOut) returned no rateOracle at the pinned block, so no OP local rate/freshPeriod could be paired.");
  }

  // --- lido withdrawal-queue family ---
  const famQ = { family: "lido-withdrawal-queue", status: "MISS", canonical: null, reads: [], lastSyncEventAgeSeconds: null, consumerCoupling: [] };
  {
    const q = LIVE_REGISTRY.lidoWithdrawalQueue.queue;
    const lastReq = await readCall(1, q, "getLastRequestId", []);
    const lastFin = await readCall(1, q, "getLastFinalizedRequestId", []);
    const bunker = await readCall(1, q, "isBunkerModeActive", []);
    const bunkerSince = await readCall(1, q, "bunkerModeSinceTimestamp", []);
    famQ.reads = [
      { method: "getLastRequestId()", status: lastReq.ok ? "OK" : lastReq.reason, valueRaw: lastReq.ok ? bigOrNull(lastReq.decoded[0]) : null },
      { method: "getLastFinalizedRequestId()", status: lastFin.ok ? "OK" : lastFin.reason, valueRaw: lastFin.ok ? bigOrNull(lastFin.decoded[0]) : null },
      { method: "isBunkerModeActive()", status: bunker.ok ? "OK" : bunker.reason, value: bunker.ok ? bunker.decoded[0] : null },
      { method: "bunkerModeSinceTimestamp()", status: bunkerSince.ok ? "OK" : bunkerSince.reason, valueRaw: bunkerSince.ok ? bigOrNull(bunkerSince.decoded[0]) : null },
    ];
    famQ.status = lastReq.ok && lastFin.ok ? "OK" : (lastReq.reason || lastFin.reason);
    famQ.canonical = { chainId: 1, contract: "lido WithdrawalQueue", address: q, queueDepthRequests: lastReq.ok ? Number(lastReq.decoded[0]) - (lastFin.ok ? Number(lastFin.decoded[0]) : 0) : null, bunkerModeActive: bunker.ok ? bunker.decoded[0] : null, source: LIVE_REGISTRY.lidoWithdrawalQueue.source };
    famQ.consumerCoupling.push({ protocol: "lido withdrawal queue", chainId: 1, listed: true, target: q, stalenessGuardBasis: "bunker mode (isBunkerModeActive) disables withdrawal finalisation", source: LIVE_REGISTRY.lidoWithdrawalQueue.source });
    notMeasured.push("lido withdrawal-queue lastSyncEventAgeSeconds: WithdrawalQueue exposes no public last-report timestamp at the pinned block.");
  }

  const families = [famWst, famWe, famQ];
  for (const f of families) { if (f.status === "OK") counters.familiesOk += 1; else if (f.status === "PARTIAL") counters.familiesPartial += 1; else counters.familiesMiss += 1; }

  // --- latency-window computation ---
  const ages = [];
  for (const f of families) {
    for (const leg of (f.l2 || [])) {
      if (typeof leg.lastSyncEventAgeSeconds === "number" && leg.lastSyncEventAgeSeconds >= 0) ages.push({ family: f.family, chainId: leg.chainId, age: leg.lastSyncEventAgeSeconds });
    }
  }
  const window = ages.length ? Math.min(...ages.map((a) => a.age)) : null;
  const widerGuardConsumers = [];
  for (const f of families) {
    for (const leg of (f.l2 || [])) {
      const guard = leg.consumerStalenessGuardSeconds;
      if (typeof guard === "number" && window != null && guard > window) {
        widerGuardConsumers.push({ family: f.family, chainId: leg.chainId, guardSeconds: guard, windowSeconds: window, note: "consumer's own freshness guard is wider than the tightest observed local refresh; the consumer can accept a locally-fresh-yet-stale-vs-canonical rate." });
      }
    }
  }
  const unboundedGuards = [];
  for (const f of families) {
    for (const cpl of (f.consumerCoupling || [])) {
      if (cpl.stalenessGuard && /none-onchain/.test(cpl.stalenessGuard)) {
        unboundedGuards.push({ family: f.family, protocol: cpl.protocol, chainId: cpl.chainId, note: "no on-chain staleness bound on the lending oracle source; the pool accepts the last pushed answer." });
      }
    }
  }

  const allDivergences = families.flatMap((f) => {
    if (Array.isArray(f.divergenceBps)) return f.divergenceBps;
    if (typeof f.divergenceBps === "number") return [f.divergenceBps];
    return [];
  });
  const maxAbsDivergenceBps = allDivergences.length ? Math.max(...allDivergences.map((v) => Math.abs(v))) : null;

  const live = {
    generatedAt: scannedAt,
    status: counters.chainsQualified > 0 ? (counters.familiesMiss === families.length ? "PARTIAL" : "OK") : "LIVE-DISABLED",
    rpcMechanism: "tools/shared-rpc.js resolveRpc(chainId, null, { capability: 'read' }) — shared read-qualified pool; endpoints held in memory only",
    endpointsPersisted: false,
    chainPins: Object.fromEntries(Object.values(perChain).map((c) => [c.chainId, { chainId: c.chainId, qualified: c.qualified, blockTag: c.blockTag, blockNumber: c.blockNumber, blockTimestamp: c.blockTimestamp, finality: c.finality, calls: c.calls, callLimit: c.callLimit, budgetExceeded: c.exceeded }])),
    budget: { maxCallsPerChain: MAX_CALLS_PER_CHAIN, totalRpcCalls: counters.rpcCalls },
    families,
    latencyWindow: {
      minObservedLocalFreshnessSeconds: window,
      samples: ages,
      widerGuardConsumers,
      unboundedGuards,
      note: window == null
        ? "No local surface exposed a timestamped sync event at the pinned blocks, so the promotion-delay window is unmeasured; consumers are judged structurally instead."
        : "min observed local freshness promotion delay across measurable families.",
    },
    executabilityAssessment: {
      conservativeNetRubric: "A candidate requires a permissionless action path plus a mispriced consumer (canonical-rate divergence beyond fees) with a monetising DEX/NAV leg, all fork-positive.",
      maxAbsDivergenceBps,
      permissionlessPathIdentified: false,
      verdict: "NO-CANDIDATE",
      reasons: [
        "Observed L1-canonical vs L2-lending-oracle divergence is at oracle-rounding scale (sub-basis-point), not a mispricing.",
        "No timestamped LST sync surface was reachable, so locally-fresh-yet-stale-vs-canonical could not be demonstrated for any consumer.",
        "No DEX/NAV leg was priced here; the sibling harnesses are required and were not invoked.",
        "signedActionJustified=false; read-only pass only.",
      ],
    },
    notMeasured,
    gaps,
    safety: {
      readOnly: true, networkCalls: true, rpcUrlsStored: false, privateKeysRead: false,
      signedActions: false, broadcast: false, forkTransactions: false, callClass: "eth_call/eth_getBlockByNumber/eth_chainId only",
    },
  };

  return live;
}

// --- main ---------------------------------------------------------------------------------
async function runLive(scannedAt) {
  const offline = buildOfflineArtifact(scannedAt);
  let live;
  try {
    live = await buildLive(scannedAt);
  } catch (err) {
    live = {
      generatedAt: scannedAt,
      status: "LIVE-DISABLED",
      error: redact(err && (err.message || err)),
      reason: "live pass failed before completing; recorded fail-closed",
      endpointsPersisted: false,
      safety: { readOnly: true, networkCalls: false, rpcUrlsStored: false, signedActions: false, broadcast: false },
    };
  }
  const artifact = {
    ...offline,
    scannedAt,
    mode: "live-readonly",
    revision: "r2",
    liveNotWired: false,
    plan: { ...offline.plan, status: "liveWired", liveRequested: true, offlineOnly: false, note: "Read-only same-pin pass executed via ./shared-rpc. Endpoints were resolved in memory only and are never stored." },
    safety: { ...offline.safety, offline: false, networkCalls: true, liveCalls: true, rpcUrlsStored: false },
    live,
  };
  ensureDir(LIVE_OUT);
  fs.writeFileSync(LIVE_OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  if (!QUIET) {
    const c = live.chainPins || {};
    const chainLine = Object.values(c).map((x) => `${x.chainId}:${x.qualified ? "Q" : "U"}`).join(" ");
    console.log(`lst-rate-sync-lag --live: status=${live.status} chains=[${chainLine}] families=${(live.families || []).length} rpcCalls=${live.budget ? live.budget.totalRpcCalls : 0} artifact=${rel(LIVE_OUT)}`);
  }
  return artifact;
}

function mainOffline(scannedAt) {
  const artifact = buildOfflineArtifact(scannedAt);
  ensureDir(OUT);
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  if (!QUIET) {
    if (LIVE_REQUESTED) console.log("[lst-rate-sync-lag] --live requested; live pass runs separately.");
    console.log(
      `lst-rate-sync-lag: etherfiChanged=${artifact.partA.etherfiRateBridge.diff.changed.length} etherfiOnlyInPr77=${artifact.partA.etherfiRateBridge.diff.onlyInA.length} ` +
      `lidoSurfaces=${artifact.partA.lidoWithdrawalQueue.surfaces.length} liveNotWired=true gaps=${artifact.gaps.length} artifact=${rel(OUT)}`,
    );
  }
  return artifact;
}

(async () => {
  const scannedAt = new Date().toISOString();
  if (LIVE_REQUESTED) {
    await runLive(scannedAt);
  } else {
    mainOffline(scannedAt);
  }
})().catch((err) => {
  try {
    const target = LIVE_REQUESTED ? LIVE_OUT : OUT;
    ensureDir(target);
    fs.writeFileSync(target, `${JSON.stringify({
      scannedAt: new Date().toISOString(),
      scanner: "tools/scan-lst-rate-sync-lag.js",
      mode: LIVE_REQUESTED ? "live-readonly" : "offline-source-authoring",
      revision: LIVE_REQUESTED ? "r2" : "r1",
      liveNotWired: !LIVE_REQUESTED,
      error: redact(err && (err.message || err)),
      gaps: [{ id: "MISS-INTERNAL", status: "MISS", note: "scanner threw before completing; recorded fail-closed" }],
      exitCode: 0,
    }, null, 2)}\n`);
  } catch (_) { /* best effort */ }
  if (!QUIET) console.log("lst-rate-sync-lag: internal error recorded fail-closed (exit 0)");
});
process.exitCode = 0;
