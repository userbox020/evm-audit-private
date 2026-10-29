#!/usr/bin/env node
// scan-staleness-gaps.js — Cross-protocol oracle staleness gap detector
// For every protocol in the inventory, maps shared Chainlink feeds and flags
// pairs where one protocol rejects stale data while another blindly accepts it.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "staleness-gaps.json");

// Known Chainlink feeds shared across protocols
const FEEDS = {
  "ETH/USD": {
    feed: "0x5f4eC3Df9cbd43714FE2740f5e3616155c5b8419",
    consumers: {
      "Fluid": { chain: "ethereum", enforcement: "NONE" },
      "Silo V3": { chain: "ethereum", enforcement: "NONE" },
      "Curve crvUSD": { chain: "ethereum", enforcement: "NONE" },
      "Compound V3": { chain: "ethereum", enforcement: "NONE" },
      "Venus Ethereum": { chain: "ethereum", enforcement: "6000s" },
      "Venus Base": { chain: "ethereum", enforcement: "1800s" },
      "Aave V3": { chain: "ethereum", enforcement: "86400s" },
      "Gearbox": { chain: "ethereum", enforcement: "0s (skipCheck)" },
    },
  },
  "stETH/USD": {
    feed: "0xCfE54B5cD566aB89272946F602D76Ea879CAb4a8",
    consumers: {
      "Liquity Bold": { chain: "ethereum", enforcement: "NONE" },
      "Gearbox": { chain: "ethereum", enforcement: "0s (skipCheck)" },
    },
  },
  "USDC/USD": {
    feed: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
    consumers: {
      "Gearbox": { chain: "ethereum", enforcement: "0s (skipCheck)" },
      "Venus Ethereum": { chain: "ethereum", enforcement: "93600s" },
      "Venus Arbitrum": { chain: "ethereum", enforcement: "93600s" },
    },
  },
  "wstETH/ETH": {
    feed: "0xb5c7b40a1edfD91Fd897f5bC6C6D8B5577f073A9",
    consumers: {
      "Compound V3": { chain: "ethereum", enforcement: "NONE (CAPO)" },
      "Morpho Blue": { chain: "ethereum", enforcement: "Configurable per market" },
    },
  },
};

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m => m[0]);
}

async function tryRpc(url, method, params, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal });
    return (await res.json()).result;
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}

async function checkFeedFreshness(rpc, feedAddr) {
  const data = await tryRpc(rpc, "eth_call", [{ to: feedAddr, data: "0xfeaf968c" }, "latest"]);
  if (!data || data === "0x") return null;
  const w = data.slice(2);
  const answer = BigInt("0x" + w.slice(64, 128) || "0");
  const updatedAt = BigInt("0x" + w.slice(128, 192) || "0");
  return { answer: answer.toString(), updatedAt: updatedAt.toString() };
}

function toNumber(n) {
  try { return Number(n); } catch { return null; }
}

async function main() {
  const urls = extractRpcUrls();
  let rpc = null;
  for (const u of urls) {
    const id = await tryRpc(u, "eth_chainId", []);
    if (id === "0x1") { rpc = u; break; }
  }
  if (!rpc) { console.error("No Ethereum RPC found"); process.exit(1); }

  const block = await tryRpc(rpc, "eth_blockNumber", []);
  const blockTs = await tryRpc(rpc, "eth_getBlockByNumber", [block, false]);
  const ts = blockTs ? parseInt(blockTs.timestamp, 16) : null;

  const results = { scannedAt: new Date().toISOString(), block: parseInt(block, 16), timestamp: ts, feeds: {}, gaps: [] };

  for (const [name, feed] of Object.entries(FEEDS)) {
    const data = await checkFeedFreshness(rpc, feed.feed);
    if (!data) continue;
    const age = ts ? ts - toNumber(data.updatedAt) : null;
    
    const consumers = [];
    for (const [protocol, cfg] of Object.entries(feed.consumers)) {
      let effectiveMax = null;
      if (cfg.enforcement === "NONE") effectiveMax = Infinity;
      else if (cfg.enforcement === "NONE (CAPO)") effectiveMax = Infinity;
      else if (cfg.enforcement.startsWith("0s")) effectiveMax = 0;
      else effectiveMax = parseInt(cfg.enforcement.replace("s", ""));
      
      const isStale = effectiveMax !== null && effectiveMax !== Infinity && age !== null && age > effectiveMax;
      
      consumers.push({
        protocol,
        chain: cfg.chain,
        enforcement: cfg.enforcement,
        effectiveMaxStale: effectiveMax === Infinity ? "unlimited" : effectiveMax,
        wouldRejectNow: isStale,
      });
    }

    // Find divergent pairs
    const maxEnforcers = consumers.filter(c => c.effectiveMaxStale !== "unlimited" && c.effectiveMaxStale !== 0);
    const noEnforcers = consumers.filter(c => c.effectiveMaxStale === "unlimited");
    const skipCheckers = consumers.filter(c => c.effectiveMaxStale === 0);

    for (const strict of maxEnforcers) {
      for (const loose of [...noEnforcers, ...skipCheckers]) {
        if (strict.protocol === loose.protocol) continue;
        results.gaps.push({
          feed: name,
          feedAddress: feed.feed,
          feedAge: age,
          strict: { protocol: strict.protocol, maxStale: strict.effectiveMaxStale, wouldRejectNow: strict.wouldRejectNow },
          loose: { protocol: loose.protocol, maxStale: loose.effectiveMaxStale },
          gap: strict.effectiveMaxStale === 0 ? "skipCheck vs enforced" : strict.effectiveMaxStale + "s vs unlimited",
          severity: age && age > strict.effectiveMaxStale ? "ACTIVE" : "dormant",
        });
      }
    }

    results.feeds[name] = {
      feed: feed.feed,
      answer: data.answer,
      updatedAt: data.updatedAt,
      age,
      consumers,
    };
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));

  console.log(`Scanned ${Object.keys(FEEDS).length} feeds at block ${parseInt(block, 16)}`);
  console.log(`Gaps found: ${results.gaps.length} (${results.gaps.filter(g => g.severity === "ACTIVE").length} ACTIVE)`);
  for (const g of results.gaps) {
    console.log(`  [${g.severity}] ${g.feed}: ${g.strict.protocol} (${g.strict.maxStale}s) vs ${g.loose.protocol} (${g.loose.maxStale}) — gap=${g.gap}`);
  }
  console.log(`Wrote ${path.relative(WORKSPACE, OUT)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
