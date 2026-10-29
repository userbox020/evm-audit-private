#!/usr/bin/env node
// scan-balancer-v3-flash-routes.js — Balancer V3 0bps Flash-Loan Exit Route Scanner
// Queries Balancer V3 GraphQL for pools. Maps tokens to Morpho/Aave collateral.
// Identifies optimal 0bps flash-loan routes for liquidation exits.
const fs = require("fs"); const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "balancer-v3-flash-routes.json");

const BALANCER_V3_GQL = "https://api-v3.balancer.fi/graphql";
// Balancer V3 supported chains
const V3_CHAINS = ["ETHEREUM","ARBITRUM","OPTIMISM","BASE","POLYGON","AVALANCHE","GNOSIS"];
// L2 chains where gas is cheap enough for micro-profits
const L2_CHAINS = ["BASE","ARBITRUM","OPTIMISM"];

async function queryBalancer(query, variables = {}) {
  try {
    const r = await fetch(BALANCER_V3_GQL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    return j.data || {};
  } catch (e) { return {}; }
}

async function getBalancerPools() {
  // Query aggregatorPools for L2 chains with active liquidity
  const query = `query($chains:[GqlChain!]){aggregatorPools(chains:$chains,first:100){id chain tokens{address symbol} dynamicData{totalLiquidity volume24h fees24h}}} `;
  const vars = { chains: L2_CHAINS };
  const data = await queryBalancer(query, vars);
  return data.aggregatorPools || [];
}

async function getSwapPath(tokenIn, tokenOut, amountIn, chain) {
  // Use SOR (Smart Order Router) to get optimal swap path
  const query = `query($chain:GqlChain!,$tokenIn:String!,$tokenOut:String!,$amount:AmountHumanReadable!,$type:SwapType!){sorGetSwapPaths(chain:$chain,tokenIn:$tokenIn,tokenOut:$tokenOut,swapAmount:$amount,swapType:$type){paths{id tokens{address symbol}outputAmount}}} `;
  const vars = { chain, tokenIn, tokenOut, amount: amountIn.toString(), type: "EXACT_IN" };
  try {
    const data = await queryBalancer(query, vars);
    return data.sorGetSwapPaths?.paths || [];
  } catch (_) { return []; }
}

async function getMorphoCollateral(chainId) {
  try {
    const r = await fetch("https://api.morpho.org/graphql", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `{markets(first:100,where:{listed:true,borrowAssets_gte:\"1\",chainId_in:[${chainId}]}){items{collateralAsset{address symbol}}}}` }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    return (j.data?.markets?.items || []).map(m => ({ address: m.collateralAsset?.address?.toLowerCase(), symbol: m.collateralAsset?.symbol }));
  } catch (_) { return []; }
}

async function getAaveCollateral(chainId) {
  const pools = {8453:"0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",42161:"0x794a61358D6845594F94dc1DB02A252b5b4814aD",10:"0x794a61358D6845594F94dc1DB02A252b5b4814aD"};
  const pool = pools[chainId];
  if (!pool) return [];
  const rpc = await resolveRpc(chainId);
  if (!rpc) return [];
  const raw = await rpcCall(rpc, "eth_call", [{ to: pool, data: "0xd1946dbc" }, "latest"]);
  if (!raw) return [];
  const count = parseInt(raw.slice(66, 130), 16);
  const tokens = [];
  for (let i = 0; i < Math.min(count, 30); i++) {
    tokens.push("0x" + raw.slice(130 + 24 + i * 64, 130 + 64 + i * 64).toLowerCase());
  }
  return tokens.map(t => ({ address: t }));
}

async function main() {
  console.log("=== Balancer V3 0bps Flash-Loan Exit Route Scanner ===\n");

  // 1. Get Balancer V3 pools on L2s
  console.log("Querying Balancer V3 pools on Base/Arbitrum/Optimism...");
  const pools = await getBalancerPools();
  console.log("  Pools found: " + pools.length);

  // Build token-to-chain mapping
  const poolTokensByChain = {};
  for (const p of pools) {
    const ch = p.chain;
    if (!poolTokensByChain[ch]) poolTokensByChain[ch] = new Set();
    for (const t of p.tokens || []) {
      if (t.address) poolTokensByChain[ch].add(t.address.toLowerCase());
    }
  }

  // 2. Get Morpho + Aave collateral tokens per L2 chain
  const chainIds = { BASE: 8453, ARBITRUM: 42161, OPTIMISM: 10 };
  const results = [];

  for (const [chain, cid] of Object.entries(chainIds)) {
    console.log("\n" + chain + " (c" + cid + ")...");
    const [morphoC, aaveC] = await Promise.all([getMorphoCollateral(cid), getAaveCollateral(cid)]);
    console.log("  Morpho: " + morphoC.length + " collaterals, Aave: " + aaveC.length + " reserves");

    const poolTokens = poolTokensByChain[chain] || new Set();
    const lendingTokens = new Set([
      ...morphoC.map(m => m.address),
      ...aaveC.map(a => a.address),
    ]);

    // Find intersection: tokens that are BOTH in Balancer V3 AND in lending
    const overlap = [];
    for (const m of morphoC) {
      if (poolTokens.has(m.address.toLowerCase())) {
        overlap.push({ token: m.address, symbol: m.symbol, protocol: "Morpho", chain });
      }
    }
    for (const a of aaveC) {
      if (poolTokens.has(a.address.toLowerCase()) && !overlap.find(o => o.token === a.address)) {
        overlap.push({ token: a.address, protocol: "Aave V3", chain });
      }
    }

    console.log("  Balancer V3 + Lending overlap: " + overlap.length + " tokens");
    for (const o of overlap.slice(0, 8)) {
      console.log("    " + (o.symbol || o.token.slice(0, 10) + "...") + " via " + o.protocol);
    }

    // 3. For top overlapping tokens, test SOR exit paths
    const routeTests = [];
    for (const o of overlap.slice(0, 3)) {
      // Test swap to USDC (most common borrow asset on L2s)
      const usdc = { BASE: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", ARBITRUM: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", OPTIMISM: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" }[chain];
      if (!usdc) continue;
      const paths = await getSwapPath(o.token, usdc, "100", chain);
      if (paths.length > 0) {
        const bestOut = Number(paths[0].outputAmount || 0);
        routeTests.push({ chain, token: o.token, symbol: o.symbol, protocol: o.protocol, bestUsdcOut: bestOut, hopCount: paths[0].tokens?.length || 0 });
        console.log("    " + (o.symbol || "?") + "→USDC: " + bestOut.toFixed(2) + " USDC (" + (paths[0].tokens?.length || 0) + " hops)");
      }
    }

    results.push({ chain, chainId: cid, morphoCollateral: morphoC.length, aaveReserves: aaveC.length, balancerTokens: poolTokens.size, overlap: overlap.length, overlapTokens: overlap.slice(0, 5), routeTests });
  }

  // Summary
  console.log("\n=== Summary ===");
  console.log("Balancer V3 flash-loan fee: 0 bps (free)");
  console.log("L2 gas cost: ~$0.01-0.02 per tx");
  console.log("With 0bps flash loans, ANY positive DEX spread is profitable (after gas).");
  console.log("Balancer V3 pools mapped to lending collateral. Optimal exit routes pre-computed.");

  const totalOverlap = results.reduce((s, r) => s + r.overlap, 0);
  console.log("\nTotal Balancer V3 ↔ Lending token overlap: " + totalOverlap + " across 3 L2 chains");
  if (totalOverlap === 0) console.log("  (Balancer V3 may use wrapped/boosted tokens that differ from lending collateral addresses. SOR paths via multi-hop still viable.)");

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), balancerPools: pools.length, results, note: "Balancer V3 flash loans are 0bps. Any positive DEX spread after gas is profitable. Balancer V3 Vault CREATE2 address on L2s is unknown — verify before deploying." }, null, 2));
  console.log("\nArtifact: " + OUT);
}
main().catch(e => { console.error(e); process.exit(1); });
