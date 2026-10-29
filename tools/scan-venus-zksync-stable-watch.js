#!/usr/bin/env node
// Read-only Venus zkSync stable-feed divergence monitor.
// Resolves RPC in memory only; never stores or prints endpoint URLs.

const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "venus-zksync-stable-watch.json");
const OUT_MD = path.join(WORKSPACE, "reports", "venus-zksync-stable-watch.md");

const CHAIN_ID = 324;
const MAX_STALE_SECONDS = 93_600;
const WATCH_STALE_FRACTION = 0.5;
const DIVERGENCE_GATE_PCT = 5;
const MIN_CASH_USD = 10_000;

const TOKENS = {
  USDT: { address: "0x493257fD37EDB34451f62EDf8D2a0C418852bA4C", decimals: 6 },
  USDC: { address: "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4", decimals: 6 },
  "USDC.e": { address: "0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4", decimals: 6 },
};

const MARKETS = [
  {
    symbol: "vUSDT_Core",
    assetSymbol: "USDT",
    vToken: "0x69cDA960E3b20DFD480866fFfd377Ebe40bd0A46",
    feed: "0xB615075979AE1836B476F651f1eB79f0Cd3956a9",
    collateralFactorPct: 77,
    liquidationThresholdPct: 80,
  },
  {
    symbol: "vUSDC_Core",
    assetSymbol: "USDC",
    vToken: "0x84064c058F2EFea4AB648bB6Bd7e40f83fFDe39a",
    feed: "0x1824D297C6d6D311A204495277B63e943C2D376E",
    collateralFactorPct: 75,
    liquidationThresholdPct: 78,
  },
  {
    symbol: "vUSDC.e_Core",
    assetSymbol: "USDC.e",
    vToken: "0x1aF23bD57c62A99C59aD48236553D0Dd11e49D2D",
    feed: "0x1824D297C6d6D311A204495277B63e943C2D376E",
    collateralFactorPct: 75,
    liquidationThresholdPct: 78,
  },
];

const POOLS = {
  // SyncSwap classic/stable pools previously verified on-chain.
  usdcUsdt: "0x0259d9Dfb638775858B1D072222237E2Ce7111C0",
  usdceUsdt: "0x0E595bfcAfb552F83E25d24e8a383F88c1Ab48A4",
};

const erc20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const vtoken = new ethers.Interface([
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function borrowRatePerBlock() view returns (uint256)",
  "function exchangeRateStored() view returns (uint256)",
]);
const feed = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const syncPool = new ethers.Interface([
  "function getAmountOut(address,uint256,address) view returns (uint256)",
]);

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function pctDiff(accepted, reference) {
  if (!Number.isFinite(accepted) || !Number.isFinite(reference) || reference === 0) return null;
  return ((accepted - reference) / reference) * 100;
}

async function ethCall(rpc, to, ifc, fn, args = [], ms = 8_000) {
  try {
    const data = ifc.encodeFunctionData(fn, args);
    const raw = await rpcCall(rpc, "eth_call", [{ to, data }, "latest"], ms);
    if (!raw) return null;
    return ifc.decodeFunctionResult(fn, raw)[0];
  } catch (_) {
    return null;
  }
}

async function ethCallFull(rpc, to, ifc, fn, args = [], ms = 8_000) {
  try {
    const data = ifc.encodeFunctionData(fn, args);
    const raw = await rpcCall(rpc, "eth_call", [{ to, data }, "latest"], ms);
    if (!raw) return null;
    return ifc.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

async function latestBlock(rpc) {
  const n = await rpcCall(rpc, "eth_blockNumber", [], 8_000);
  if (!n) return null;
  const block = await rpcCall(rpc, "eth_getBlockByNumber", [n, false], 8_000);
  if (!block) return null;
  return { number: parseInt(n, 16), timestamp: parseInt(block.timestamp, 16) };
}

async function quote(rpc, pool, tokenIn, amount, outDecimals) {
  const out = await ethCall(
    rpc,
    pool,
    syncPool,
    "getAmountOut",
    [tokenIn, amount, "0x0000000000000000000000000000000000000001"],
    8_000,
  );
  if (out === null) return null;
  return Number(ethers.formatUnits(out, outDecimals));
}

async function referencePrices(rpc) {
  const amount = ethers.parseUnits("1000", 6);

  const usdtToUsdc = await quote(rpc, POOLS.usdcUsdt, TOKENS.USDT.address, amount, 6);
  const usdcToUsdt = await quote(rpc, POOLS.usdcUsdt, TOKENS.USDC.address, amount, 6);
  const usdceToUsdt = await quote(rpc, POOLS.usdceUsdt, TOKENS["USDC.e"].address, amount, 6);
  const usdtToUsdce = await quote(rpc, POOLS.usdceUsdt, TOKENS.USDT.address, amount, 6);

  const usdtUsd = usdtToUsdc === null ? null : usdtToUsdc / 1000;
  const usdcUsd = usdcToUsdt === null || usdtUsd === null ? 1 : (usdcToUsdt / 1000) * usdtUsd;
  const usdceUsd = usdceToUsdt === null || usdtUsd === null ? null : (usdceToUsdt / 1000) * usdtUsd;

  return {
    USDC: usdcUsd,
    USDT: usdtUsd,
    "USDC.e": usdceUsd,
    quotes: {
      usdtToUsdc,
      usdcToUsdt,
      usdceToUsdt,
      usdtToUsdce,
    },
  };
}

async function scan() {
  const rpc = await resolveRpc(CHAIN_ID);
  const block = await latestBlock(rpc);
  if (!rpc || !block) throw new Error("Unable to resolve zkSync RPC/block");

  const refs = await referencePrices(rpc);
  const rows = [];

  for (const market of MARKETS) {
    const token = TOKENS[market.assetSymbol];
    const [cashRaw, borrowsRaw, feedDecimals, description, latest] = await Promise.all([
      ethCall(rpc, market.vToken, vtoken, "getCash"),
      ethCall(rpc, market.vToken, vtoken, "totalBorrows"),
      ethCall(rpc, market.feed, feed, "decimals"),
      ethCall(rpc, market.feed, feed, "description"),
      ethCallFull(rpc, market.feed, feed, "latestRoundData"),
    ]);

    const cash = cashRaw === null ? null : Number(ethers.formatUnits(cashRaw, token.decimals));
    const borrows = borrowsRaw === null ? null : Number(ethers.formatUnits(borrowsRaw, token.decimals));
    const decimals = feedDecimals === null ? 8 : Number(feedDecimals);
    const answer = latest ? Number(ethers.formatUnits(latest[1], decimals)) : null;
    const updatedAt = latest ? Number(latest[3]) : null;
    const ageSeconds = updatedAt ? block.timestamp - updatedAt : null;
    const reference = refs[market.assetSymbol];
    const divergencePct = pctDiff(answer, reference);
    const cashUsd = cash === null || reference === null ? null : cash * reference;
    const borrowsUsd = borrows === null || reference === null ? null : borrows * reference;
    const staleWatch = ageSeconds !== null && ageSeconds >= MAX_STALE_SECONDS * WATCH_STALE_FRACTION;
    const staleExpired = ageSeconds !== null && ageSeconds >= MAX_STALE_SECONDS;
    const materialDivergence = divergencePct !== null && Math.abs(divergencePct) >= DIVERGENCE_GATE_PCT;
    const materialCash = cashUsd !== null && cashUsd >= MIN_CASH_USD;
    const watchCandidate = staleWatch && materialCash;
    const researchPositive = watchCandidate && materialDivergence;

    rows.push({
      ...market,
      asset: token.address,
      feedDescription: description || null,
      maxStaleSeconds: MAX_STALE_SECONDS,
      feedUpdatedAt: updatedAt,
      feedAgeSeconds: ageSeconds,
      acceptedPriceUsd: answer,
      referencePriceUsd: reference,
      divergencePct,
      cash,
      borrows,
      cashUsd,
      borrowsUsd,
      staleWatch,
      staleExpired,
      materialDivergence,
      watchCandidate,
      researchPositive,
      routePositive: false,
      blockers: researchPositive
        ? ["Needs fork proof and exact borrow/liquidation/exit economics"]
        : [
            staleWatch ? null : "feed is not yet in stale-watch window",
            materialDivergence ? null : `divergence below ${DIVERGENCE_GATE_PCT}% gate`,
            materialCash ? null : `cash below $${MIN_CASH_USD} gate`,
          ].filter(Boolean),
    });
  }

  const summary = {
    rows: rows.length,
    watchCandidates: rows.filter((r) => r.watchCandidate).length,
    staleExpiredRows: rows.filter((r) => r.staleExpired).length,
    materialDivergenceRows: rows.filter((r) => r.materialDivergence).length,
    researchPositiveRows: rows.filter((r) => r.researchPositive).length,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    status: rows.some((r) => r.researchPositive) ? "research-positive-needs-fork" : "watch-only-no-divergence",
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-venus-zksync-stable-watch.js",
    scope: "Venus zkSync high-CF single-source stable-feed divergence monitor",
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
    chain: { id: CHAIN_ID, name: "zkSync Era", block },
    thresholds: {
      maxStaleSeconds: MAX_STALE_SECONDS,
      watchStaleFraction: WATCH_STALE_FRACTION,
      divergenceGatePct: DIVERGENCE_GATE_PCT,
      minCashUsd: MIN_CASH_USD,
    },
    reference: refs,
    summary,
    rows,
  };

  ensureDir(OUT_JSON);
  fs.writeFileSync(OUT_JSON, JSON.stringify(artifact, null, 2));

  const md = [
    `# Venus zkSync Stable Watch`,
    ``,
    `Generated: ${artifact.generatedAt}`,
    ``,
    `## Summary`,
    ``,
    `- Status: \`${summary.status}\``,
    `- Watch candidates: \`${summary.watchCandidates}\``,
    `- Material divergence rows: \`${summary.materialDivergenceRows}\``,
    `- Route-positive: \`0\``,
    ``,
    `## Rows`,
    ``,
    `| Market | Feed age | Accepted | Reference | Divergence | Cash | Borrows | Status |`,
    `|---|---:|---:|---:|---:|---:|---:|---|`,
    ...rows.map((r) => `| \`${r.symbol}\` | ${r.feedAgeSeconds ?? "n/a"}s | ${r.acceptedPriceUsd?.toFixed(6) ?? "n/a"} | ${r.referencePriceUsd?.toFixed(6) ?? "n/a"} | ${r.divergencePct?.toFixed(4) ?? "n/a"}% | $${r.cashUsd?.toFixed(2) ?? "n/a"} | $${r.borrowsUsd?.toFixed(2) ?? "n/a"} | ${r.researchPositive ? "research-positive" : r.watchCandidate ? "watch" : "clean"} |`),
    ``,
    `## Gate`,
    ``,
    `Fork work remains closed unless accepted Venus price diverges by at least ${DIVERGENCE_GATE_PCT}% from on-chain stable references and exact borrow/liquidation/exit economics are positive.`,
  ].join("\n");
  fs.writeFileSync(OUT_MD, md);

  console.log(`Venus zkSync stable watch: rows=${summary.rows} watch=${summary.watchCandidates} materialDivergence=${summary.materialDivergenceRows} routePositive=0 status=${summary.status}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT_JSON)}`);
}

scan().catch((e) => {
  console.error(e.stack || e.message);
  process.exitCode = 1;
});
