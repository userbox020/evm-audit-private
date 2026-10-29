#!/usr/bin/env node
// scan-stale-oracle-liquidity.js — generic stale-feed + market-liquidity groundwork.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "stale-oracle-liquidity-candidates.json");
const RPC_TIMEOUT_MS = 15_000;

const FEEDS = {
  "ETH/USD": { chainId: 1, feed: "0x5f4eC3Df9cbd43714FE2740f5e3616155c5b8419", decimals: 8, live: "ETHUSDT" },
  "stETH/USD": { chainId: 1, feed: "0xCfE54B5cD566aB89272946F602D76Ea879CAb4a8", decimals: 8, live: "ETHUSDT" },
  "USDC/USD": { chainId: 1, feed: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6", decimals: 8, live: null },
};

const CANDIDATES = [
  {
    id: "compound-cwethv3-wsteth",
    chainId: 1,
    feed: "ETH/USD",
    protocol: "Compound V3 cWETHv3",
    route: "E1",
    minAgeSeconds: 1800,
    minDivergencePct: 5,
    check: "compound-wsteth-collateral",
    note: "Fork-proven route exists on Ethereum; active contract is artifact-verified.",
  },
  {
    id: "fluid-wsteth-usdc",
    chainId: 1,
    feed: "ETH/USD",
    protocol: "Fluid Vault_wstETH_USDC",
    route: "E8",
    minAgeSeconds: 1800,
    minDivergencePct: 30,
    check: "route-threshold-only",
    note: "Fork-proven route exists on Ethereum; active contract is artifact-verified.",
  },
  {
    id: "silo-v3-stale-feed-liquidity",
    chainId: 1,
    feed: "ETH/USD",
    protocol: "Silo V3",
    route: "manual",
    minAgeSeconds: 1800,
    minDivergencePct: 5,
    check: "report-blocked-until-liquidity",
    note: "Report found accepted stale feeds but no borrowable opposite liquidity; rerun Silo live scanners if this flags.",
  },
  {
    id: "benqi-avalanche-latestanswer",
    chainId: 43114,
    feed: null,
    protocol: "BenQi Avalanche",
    route: "manual",
    minAgeSeconds: 3600,
    minDivergencePct: 5,
    check: "mapped-clean",
    note: "Mapped by tools/scan-benqi-avalanche.js: live oracle is BenqiDualOracle, staleFeeds=0, actionable=0.",
  },
  {
    id: "tectonic-cronos-custom-oracle",
    chainId: 25,
    feed: null,
    protocol: "Tectonic Cronos",
    route: "manual",
    minAgeSeconds: 1800,
    minDivergencePct: 1,
    check: "mapped-clean",
    note: "Mapped by tools/scan-tectonic-cronos.js: 33 markets, staleFeeds=0, actionable=0; only divergent market is paused.",
  },
];

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m => m[0]);
}

async function rpcCall(url, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const json = await res.json();
    return json.result ?? null;
  } catch (_) { return null; }
  finally { clearTimeout(t); }
}

async function resolveRpcPool() {
  const pool = {};
  for (const url of extractRpcUrls()) {
    const id = await rpcCall(url, "eth_chainId", [], 8000);
    if (!id) continue;
    const chainId = parseInt(id, 16);
    if (!pool[chainId]) pool[chainId] = url;
  }
  return pool;
}

function uint256(hex) { try { return BigInt(`0x${hex || "0"}`); } catch (_) { return 0n; } }

function int256(hex) {
  const v = uint256(hex);
  const signBit = 1n << 255n;
  return v >= signBit ? v - (1n << 256n) : v;
}

async function getBlock(rpc) {
  const block = await rpcCall(rpc, "eth_getBlockByNumber", ["latest", false]);
  return block ? { number: parseInt(block.number, 16), timestamp: parseInt(block.timestamp, 16) } : null;
}

async function queryFeed(rpc, cfg) {
  const data = await rpcCall(rpc, "eth_call", [{ to: cfg.feed, data: "0xfeaf968c" }, "latest"]);
  if (!data || data === "0x") return null;
  const w = data.slice(2);
  const answer = int256(w.slice(64, 128));
  const updatedAt = Number(uint256(w.slice(128, 192)));
  if (answer <= 0n || !updatedAt) return null;
  return { price: Number(answer) / (10 ** cfg.decimals), updatedAt };
}

async function getLivePrice(pair) {
  if (!pair) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const json = await res.json();
    const price = Number(json.price);
    return price > 0 ? price : null;
  } catch (_) { return null; }
}

async function compoundWstethCollateral(rpc) {
  const comet = "0xA17581A9E3356d9A858b789D68B4d866e593aE94";
  const wsteth = "0000000000000000000000007f39c581f595B53c5cb19bD0b3f8dA6c935E2Ca0".toLowerCase();
  const result = await rpcCall(rpc, "eth_call", [{ to: comet, data: `0x98e26959${wsteth}` }, "latest"]);
  if (!result || result === "0x") return null;
  return Number(BigInt(result)) / 1e18;
}

async function scoreCandidate(candidate, feeds, rpcPool) {
  const out = { ...candidate, status: "not-scored", severity: "INFO", reasons: [] };
  if (candidate.check === "mapped-clean") {
    out.status = "mapped-clean";
    out.reasons.push(candidate.note);
    return out;
  }
  if (!candidate.feed) {
    out.status = "needs-market-map";
    out.reasons.push(candidate.note);
    return out;
  }
  const feed = feeds[candidate.feed];
  if (!feed) {
    out.status = "feed-unavailable";
    out.reasons.push("feed query failed");
    return out;
  }
  out.feedAge = feed.age;
  out.stalePrice = feed.price;
  out.livePrice = feed.livePrice;
  out.divergencePct = feed.divergencePct;
  if (candidate.check === "compound-wsteth-collateral") {
    const rpc = rpcPool[candidate.chainId];
    const collateral = rpc ? await compoundWstethCollateral(rpc).catch(() => null) : null;
    out.wstethCollateral = collateral;
    if (collateral && collateral > 0) out.reasons.push(`wstETH collateral=${collateral.toFixed(0)}`);
  }
  if (feed.age >= candidate.minAgeSeconds && Number(feed.divergencePct || 0) >= candidate.minDivergencePct) {
    out.status = "actionable-for-fork-proof";
    out.severity = "CRITICAL";
    out.reasons.push(`age ${feed.age}s >= ${candidate.minAgeSeconds}s`, `divergence ${feed.divergencePct.toFixed(2)}% >= ${candidate.minDivergencePct}%`);
  } else if (feed.age >= candidate.minAgeSeconds) {
    out.status = "stale-but-flat";
    out.severity = "DORMANT";
    out.reasons.push(`age ${feed.age}s >= ${candidate.minAgeSeconds}s`, `divergence below ${candidate.minDivergencePct}%`);
  } else {
    out.status = "waiting-for-stale-window";
    out.reasons.push(`age ${feed.age}s < ${candidate.minAgeSeconds}s`);
  }
  return out;
}

async function main() {
  const rpcPool = await resolveRpcPool();
  const feeds = {};
  for (const [name, cfg] of Object.entries(FEEDS)) {
    const rpc = rpcPool[cfg.chainId];
    if (!rpc) continue;
    const [block, data, livePrice] = await Promise.all([getBlock(rpc), queryFeed(rpc, cfg), getLivePrice(cfg.live)]);
    if (!block || !data) continue;
    const age = block.timestamp - data.updatedAt;
    const divergencePct = livePrice ? ((data.price - livePrice) / livePrice) * 100 : null;
    feeds[name] = { chainId: cfg.chainId, feed: cfg.feed, price: data.price, updatedAt: data.updatedAt, age, livePrice, divergencePct };
  }

  const candidates = [];
  for (const candidate of CANDIDATES) candidates.push(await scoreCandidate(candidate, feeds, rpcPool));
  const out = {
    generatedAt: new Date().toISOString(),
    feeds,
    actionableCount: candidates.filter(c => c.status === "actionable-for-fork-proof").length,
    staleButFlatCount: candidates.filter(c => c.status === "stale-but-flat").length,
    needsMarketMapCount: candidates.filter(c => c.status === "needs-market-map").length,
    candidates,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Stale-oracle liquidity scan: actionable=${out.actionableCount} staleButFlat=${out.staleButFlatCount} needsMap=${out.needsMarketMapCount}`);
  for (const c of candidates) console.log(`  ${c.id}: ${c.status} ${c.divergencePct === null || c.divergencePct === undefined ? "" : `div=${c.divergencePct.toFixed(2)}%`} ${c.feedAge ? `age=${c.feedAge}s` : ""}`.trim());
  console.log(`Report: ${path.relative(WORKSPACE, OUT)}`);
}

main().catch((err) => {
  console.error(String(err && (err.stack || err.message) || err).replace(/https?:\/\/[^\s'"<>]+/g, "[redacted-url]"));
  process.exit(1);
});
