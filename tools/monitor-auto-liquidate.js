#!/usr/bin/env node
// monitor-auto-liquidate.js — Vector C: WS → Auto-Liquidation Bridge
// Watches Chainlink WS for price drops → scans Morpho for HF<1 → executes E9
// 180x faster than 30min polling: detects in 2s, liquidates in 5-10s

const fs = require("fs"); const path = require("path");
const { ethers } = require("./node_modules/ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");
const { buildE9LiquidationCandidates, executeE9Liquidation, E9_CONTRACT } = require("./monitor-novelty-conditions");

const WORKSPACE = path.resolve(__dirname, "..");
const CL_STATUS = path.join(WORKSPACE, "reports", "monitor", "chainlink-ws-status.json");
const MORPHO_CACHE = path.join(WORKSPACE, "reports", "monitor", "morpho-ws-cache.json");
const LIQ_LOG = path.join(WORKSPACE, "reports", "monitor", "auto-liquidate-log.jsonl");
const LOCK_FILE = path.join(WORKSPACE, "reports", "monitor", "auto-liquidate.lock");
const ENV_EXPLOIT = path.join(WORKSPACE, ".env.exploit");

// Configuration
const PRICE_DROP_THRESHOLD = 0.02; // 2% drop triggers HF scan
const POLL_INTERVAL = 2000; // 2s poll
const EXEC_MODE = process.env.AUTO_LIQUIDATE === "true"; // Fail closed unless explicitly enabled
const DRY_RUN = process.env.AUTO_LIQUIDATE_DRY === "true";  // Dry run mode — simulate profit, don't send tx
const CACHE_MAX_AGE_MS = Number(process.env.AUTO_LIQ_CACHE_MAX_AGE_MS || "900000");
const ONCE_MODE = process.argv.includes("--once");

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

// Chainlink ETH/USD feeds (same as WS monitor)
const CL_FEEDS = {
  ethereum: { key:"ethereum", name:"ETH", id:1, feed:"0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419", morpho:MORPHO },
  base: { key:"base", name:"Base", id:8453, feed:"0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", morpho:MORPHO },
  arbitrum: { key:"arbitrum", name:"Arb", id:42161, feed:"0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", morpho:MORPHO },
  optimism: { key:"optimism", name:"OP", id:10, feed:"0x13e3Ee699D1909E989722E753853AE30b17e08c5", morpho:MORPHO },
};
const CHAIN_ALIASES = { eth: "ethereum", mainnet: "ethereum", arb: "arbitrum", op: "optimism", poly: "polygon" };

// Price history per chain (previous value for drop detection)
const priceHistory = {};
const HF_SCAN_COOLDOWN = 60000; // 1min cooldown between HF scans

function ts() { return new Date().toISOString(); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }
function logEvent(evt) {
  fs.mkdirSync(path.dirname(LIQ_LOG), { recursive: true });
  fs.appendFileSync(LIQ_LOG, JSON.stringify({ time: ts(), ...evt }) + "\n");
}

function normalizeChainKey(feed) {
  const raw = String(feed?.key || feed?.chainKey || feed?.name || "").toLowerCase();
  return CHAIN_ALIASES[raw] || raw;
}

function loadPrivateKey() {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY.trim();
  try {
    if (!fs.existsSync(ENV_EXPLOIT)) return "";
    const m = fs.readFileSync(ENV_EXPLOIT, "utf8").match(/PRIVATE_KEY=([a-fA-F0-9]+)/);
    return m ? m[1] : "";
  } catch (_) { return ""; }
}

function readMorphoCache(chainId) {
  try {
    const raw = JSON.parse(fs.readFileSync(MORPHO_CACHE, "utf8"));
    const now = Date.now();
    const fresh = (row) => {
      const t = row?.updatedAt ? new Date(row.updatedAt).getTime() : 0;
      return Number(row?.chainId) === Number(chainId) && t > 0 && now - t <= CACHE_MAX_AGE_MS;
    };
    return {
      borrowers: (raw.borrowers || []).filter(fresh),
      markets: (raw.markets || []).filter(fresh),
    };
  } catch (_) { return { borrowers: [], markets: [] }; }
}

function buildE9Alert(result, chainId) {
  const profitable = (result.candidates || []).filter(c => c.executable).sort((a, b) => b.netProfit - a.netProfit);
  if (profitable.length === 0) return null;
  const top = profitable[0];
  return {
    condition: "liquidation-hunter",
    severity: "HIGH",
    count: result.count || profitable.length,
    profitableCount: profitable.length,
    topMarket: top.symbol,
    topHF: top.hf,
    topChain: chainId,
    topBorrow: "$" + Math.round(top.borrowUSD || 0).toLocaleString(),
    topNetProfit: "$" + Math.round(top.netProfit || 0).toLocaleString(),
    gasCostUsd: result.gasCostUsd || 0,
    autoExecutable: true,
    routeGuard: "passed",
    profitablePositions: profitable.slice(0, 5).map(p => ({ ...p, chainId })),
  };
}

async function runE9Scan(chainCfg, rpc, trigger) {
  const cache = readMorphoCache(chainCfg.id);
  log(`  ${chainCfg.name}: E9 route scan (cache borrowers=${cache.borrowers.length}, markets=${cache.markets.length})`);

  const provider = new ethers.JsonRpcProvider(rpc, chainCfg.id, { staticNetwork: true });
  const rawGasPrice = await provider.send("eth_gasPrice", []).catch(() => null);
  if (!rawGasPrice) {
    log(`  ${chainCfg.name}: skipped - missing gas price`);
    return { executed: false, reason: "missing gas price" };
  }
  const gasPrice = BigInt(rawGasPrice);
  const result = await buildE9LiquidationCandidates(provider, gasPrice, chainCfg.id);
  const candidates = result.candidates || [];
  const alert = buildE9Alert(result, chainCfg.id);
  const top = candidates[0];

  logEvent({
    type: "E9_SCAN_RESULT",
    chainKey: chainCfg.key,
    chainId: chainCfg.id,
    trigger,
    count: result.count || 0,
    candidates: candidates.length,
    profitableCount: alert?.profitableCount || 0,
    top: top ? { symbol: top.symbol, hf: top.hf, netProfit: top.netProfit, executable: top.executable, reason: top.priceReason || null } : null,
  });

  if (!alert) {
    const topStr = top ? ` top=${top.symbol} HF=${top.hf} net=$${Math.round(top.netProfit || 0)} executable=${top.executable}` : "";
    log(`  ${chainCfg.name}: no executable E9 candidates.${topStr}`);
    return { executed: false, reason: "no executable candidates", result };
  }

  const topPosition = alert.profitablePositions[0];
  log(`  ${chainCfg.name}: E9 executable candidate ${topPosition.symbol} HF=${topPosition.hf} net=$${Math.round(topPosition.netProfit || 0)}`);
  if (!EXEC_MODE || DRY_RUN) {
    log(`  ${chainCfg.name}: ${DRY_RUN ? "DRY RUN" : "MONITOR ONLY"} - would execute E9 ${E9_CONTRACT.slice(0,10)}...`);
    return { executed: false, reason: DRY_RUN ? "dry-run" : "monitor-only", alert };
  }

  const privateKey = loadPrivateKey();
  if (!privateKey) {
    log(`  ${chainCfg.name}: skipped - AUTO_LIQUIDATE=true but PRIVATE_KEY missing`);
    return { executed: false, reason: "missing private key", alert };
  }

  const wallet = new ethers.Wallet(privateKey, provider);
  const execResult = await executeE9Liquidation(wallet, provider, gasPrice, alert, chainCfg.id);
  logEvent({ type: "E9_EXECUTE_RESULT", chainKey: chainCfg.key, chainId: chainCfg.id, result: execResult });
  return { executed: execResult?.result === "executed", result: execResult, alert };
}

// Ensure lock file (prevents duplicate instances)
try {
  if (!ONCE_MODE && fs.existsSync(LOCK_FILE)) {
    const pid = fs.readFileSync(LOCK_FILE, "utf8").trim();
    try { process.kill(parseInt(pid), 0); log("Another instance is running. Exiting."); process.exit(1); }
    catch (_) { fs.unlinkSync(LOCK_FILE); }
  }
  if (!ONCE_MODE) {
    fs.writeFileSync(LOCK_FILE, process.pid.toString());
    process.on("exit", () => { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} });
    process.on("SIGINT", () => { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} process.exit(0); });
  }
} catch (_) {}

// Read actual Chainlink price via eth_call (fallback when no WS events)
async function getActualChainlinkPrice(rpc, feedAddr) {
  const raw = await rpcCall(rpc, "eth_call", [{ to: feedAddr, data: "0xfeaf968c" }, "latest"], 5000);
  if (!raw || raw.length < 258) return null;
  const answer = Number(BigInt("0x" + raw.slice(2+64, 2+128))) / 1e8;
  const updatedAt = Number(BigInt("0x" + raw.slice(2+192, 2+256)));
  return { price: answer, updatedAt, age: Math.floor(Date.now()/1000) - updatedAt };
}

// Read Chainlink WS status (may not have price data if no events received)
function readCLStatus() {
  try {
    const raw = JSON.parse(fs.readFileSync(CL_STATUS, "utf8"));
    return raw;
  } catch (_) { return null; }
}

// Simple Morpho HF check for ETH/USD markets
async function checkHF(rpc, marketId, price) {
  // Read market state
  const stateRaw = await rpcCall(rpc, "eth_call", [{ to:MORPHO, data:"0x5c60e39a"+marketId.slice(2) }, "latest"], 8000);
  if (!stateRaw || stateRaw.length < 386) return null;

  const borrowAssets = BigInt("0x"+stateRaw.slice(130,194));
  const borrowShares = BigInt("0x"+stateRaw.slice(194,258));
  if (borrowShares === 0n) return null;

  // Read market params to get LLTV + oracle
  const paramsRaw = await rpcCall(rpc, "eth_call", [{ to:MORPHO, data:"0x2c3c9157"+marketId.slice(2) }, "latest"], 8000);
  if (!paramsRaw || paramsRaw.length < 322) return null;
  const oracle = "0x"+paramsRaw.slice(154,194);
  const lltv = Number(BigInt("0x"+paramsRaw.slice(258,322))) / 1e18;

  // Check if this market uses ETH/USD (oracle is the feed address)
  const oracleUsesEth = oracle.toLowerCase() === CL_FEEDS.ethereum.feed.toLowerCase() ||
    oracle.toLowerCase() === CL_FEEDS.base.feed.toLowerCase() ||
    oracle.toLowerCase() === CL_FEEDS.arbitrum.feed.toLowerCase() ||
    oracle.toLowerCase() === CL_FEEDS.optimism.feed.toLowerCase();

  if (!oracleUsesEth) return { marketId: marketId.slice(0,18)+"...", ignoreReason:"oracle not ETH/USD" };

  // Get recent Borrow events for this market
  const BORROW_TOPIC = "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43";
  const block = await rpcCall(rpc, "eth_blockNumber", [], 5000);
  if (!block) return null;
  const cur = parseInt(block, 16);
  
  const logs = await rpcCall(rpc, "eth_getLogs", [{
    address: MORPHO,
    fromBlock: "0x"+(cur-500).toString(16),
    toBlock: block,
    topics: [BORROW_TOPIC, marketId]
  }], 10000);

  if (!logs || !Array.isArray(logs)) return null;

  // Check each borrower's HF
  let worstHF = Infinity, worstBorrower = null;
  for (const log of logs.slice(0, 20)) {
    const onBehalf = "0x"+(log.topics[2]||"").slice(26);
    const posRaw = await rpcCall(rpc, "eth_call", [{ to:MORPHO, data:"0x93c52062"+marketId.slice(2)+"0".repeat(24)+onBehalf.slice(2) }, "latest"], 8000);
    if (!posRaw || posRaw.length < 194) continue;

    const bs = BigInt("0x"+posRaw.slice(66,130));
    const coll = BigInt("0x"+posRaw.slice(130,194));
    if (bs === 0n) continue;

    // borrowed = bs * totalBorrowAssets / totalBorrowShares (ceil)
    const tba = borrowAssets, tbs = borrowShares;
    const prod = bs * tba;
    const borrowed = prod / tbs + (prod % tbs !== 0n ? 1n : 0n);

    // maxBorrow = coll * price * lltv (all in appropriate units)
    const priceScaled = BigInt(Math.floor(price * 1e36));
    const maxBorrow = (coll * priceScaled / BigInt(1e36)) * BigInt(Math.floor(lltv * 1e18)) / BigInt(1e18);

    if (maxBorrow < borrowed) {
      const hf = Number(maxBorrow) / Number(borrowed);
      if (hf < worstHF) { worstHF = hf; worstBorrower = onBehalf; }
    }
  }

  if (worstBorrower) {
    return { marketId: marketId.slice(0,18)+"...", worstHF, worstBorrower: worstBorrower.slice(0,10)+"...", lltv, price };
  }
  return { marketId: marketId.slice(0,18)+"...", status:"healthy", positions: logs.length };
}

// Main watch loop
async function watch() {
  log("Auto-Liquidation Bridge STARTED");
  log(`Execution mode: ${EXEC_MODE ? "LIVE" : (DRY_RUN ? "DRY RUN" : "MONITOR ONLY")}`);
  log(`Price drop threshold: ${(PRICE_DROP_THRESHOLD*100).toFixed(0)}%\n`);

  // Wait for WS monitors to produce initial data
  log("Waiting for Chainlink WS status file...");
  let waited = 0;
  while (!fs.existsSync(CL_STATUS) && waited < 60) {
    await new Promise(r => setTimeout(r, 2000));
    waited += 2;
  }
  if (!fs.existsSync(CL_STATUS)) { log("Chainlink WS status not found. Is monitor-chainlink-ws.js running?"); return; }
  log("Chainlink WS status file found.\n");

  const rpcs = {};
  let lastHfScan = {};
  let lastPriceLog = {};

  while (true) {
    try {
      const status = readCLStatus();
      if (!status || !status.feeds) { await new Promise(r => setTimeout(r, POLL_INTERVAL)); continue; }

      for (const feed of status.feeds) {
        let price = feed.price;
        const chainKey = normalizeChainKey(feed);
        const chainCfg = CL_FEEDS[chainKey];
        if (!chainCfg) continue;

        // If WS hasn't received AnswerUpdated yet, read actual Chainlink price
        if (!price || price <= 0) {
          if (!rpcs[chainCfg.id]) rpcs[chainCfg.id] = await resolveRpc(chainCfg.id);
          if (!rpcs[chainCfg.id]) continue;
          const actual = await getActualChainlinkPrice(rpcs[chainCfg.id], chainCfg.feed);
          if (!actual) continue;
          price = actual.price;
        }

        const prev = priceHistory[chainKey];

        // Initialize history
        if (!prev) { priceHistory[chainKey] = price; continue; }

        const drop = (prev - price) / prev;
        const move = (price - prev) / prev;

        // Only log significant moves
        if (Math.abs(move) > 0.0005 && (!lastPriceLog[chainKey] || Date.now() - lastPriceLog[chainKey] > 300000)) {
          log(`${chainCfg.name}: $${prev.toFixed(2)} -> $${price.toFixed(2)} (${(move*100).toFixed(2)}%) age=${feed.age ?? "?"}s`);
          lastPriceLog[chainKey] = Date.now();
        }
        priceHistory[chainKey] = price;

        // Material ETH/USD move triggers an E9 route-guarded rescan.
        if (Math.abs(move) >= PRICE_DROP_THRESHOLD) {
          const cooldownKey = `${chainKey}`;
          if (lastHfScan[cooldownKey] && Date.now() - lastHfScan[cooldownKey] < HF_SCAN_COOLDOWN) continue;
          lastHfScan[cooldownKey] = Date.now();

          const direction = move < 0 ? "drop" : "rise";
          log(`\n${chainCfg.name}: ${(Math.abs(move)*100).toFixed(2)}% price ${direction} -> route-guarded E9 scan...`);

          if (!rpcs[chainCfg.id]) rpcs[chainCfg.id] = await resolveRpc(chainCfg.id);
          if (!rpcs[chainCfg.id]) { log(`  No RPC for ${chainCfg.name}`); continue; }

          await runE9Scan(chainCfg, rpcs[chainCfg.id], {
            price,
            prevPrice: prev,
            movePct: move * 100,
            dropPct: drop * 100,
            feedAge: feed.age,
            feedBlock: feed.block,
            sequence: feed.sequence,
          });
        }
      }
    } catch (e) {
      log(`Error: ${e.message}`);
    }

    if (ONCE_MODE) {
      log("Once mode complete.");
      break;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

log("Auto-Liquidation Bridge architecture:");
log("  Chainlink WS status → poll every 2s → detect >2% drop → scan Morpho HF → execute E9");
log("  Set AUTO_LIQUIDATE=true to enable execution");
log("  Set AUTO_LIQUIDATE_DRY=true for dry run (simulate profit)\n");

watch().catch(e => { console.error(e.message); process.exit(1); });
