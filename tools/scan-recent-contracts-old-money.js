#!/usr/bin/env node
// Read-only scanner for recent blue-chip token inflows into contracts.
// Goal: identify fresh value edges for manual source/bytecode review. No signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");
const { resolveRpc, rpcCall, getImpl } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "recent-contracts-old-money.json");
const OUT_MD = path.join(WORKSPACE, "reports", "recent-contracts-old-money.md");

const LOOKBACK_BLOCKS = Number(process.env.RECENT_OLD_MONEY_BLOCKS || "5000");
const MAX_LOGS_PER_TOKEN = Number(process.env.RECENT_OLD_MONEY_MAX_LOGS || "40000");
const MIN_BALANCE_USD = Number(process.env.RECENT_OLD_MONEY_MIN_USD || "50000");
const MAX_RECIPIENTS_PER_TOKEN = Number(process.env.RECENT_OLD_MONEY_MAX_RECIPIENTS || "250");
const LOG_CHUNK = Number(process.env.RECENT_OLD_MONEY_LOG_CHUNK || "1000");

const CHAINS = [
  {
    id: 1,
    name: "Ethereum",
    tokens: [
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, priceUsd: 1 },
      { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18, priceUsd: 1587 },
      { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8, priceUsd: 62700 },
    ],
  },
  {
    id: 8453,
    name: "Base",
    tokens: [
      { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, priceUsd: 1 },
      { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18, priceUsd: 1587 },
      { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8, priceUsd: 62700 },
    ],
  },
  {
    id: 42161,
    name: "Arbitrum",
    tokens: [
      { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, priceUsd: 1 },
      { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, priceUsd: 1587 },
      { symbol: "WBTC", address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8, priceUsd: 62700 },
    ],
  },
];

const transferTopic = ethers.id("Transfer(address,address,uint256)");
const erc20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
const ownerIface = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function governor() view returns (address)",
  "function governance() view returns (address)",
]);
const poolIface = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
]);

const KNOWN_LABELS = new Map([
  ["42161:0x690e66fc0f8be8964d40e55ede6aebdfcb8a21df", "Allbridge LP token"],
  ["42161:0xb0473ca01e91981623b65daf84ab7bc94a7e4000", "OKX hot-wallet/accounting proxy"],
  ["1:0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc", "Uniswap V2 USDC/WETH pool"],
  ["1:0xbb2b8038a1640196fbe3e38816f3e67cba72d940", "Uniswap V2 WBTC/WETH pool"],
]);

const ECONOMIC_SELECTORS = Object.fromEntries([
  "withdraw()",
  "withdraw(uint256)",
  "withdraw(address,uint256)",
  "redeem(uint256,address,address)",
  "claim()",
  "claimRewards()",
  "harvest()",
  "rebalance()",
  "migrate()",
  "execute(bytes)",
  "execute(address,uint256,bytes)",
  "multicall(bytes[])",
  "sweep(address)",
  "sweepToken(address)",
  "transferFrom(address,address,uint256)",
  "approve(address,uint256)",
].map((sig) => [sig, ethers.id(sig).slice(2, 10)]));

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function topicAddress(topic) {
  return ethers.getAddress("0x" + topic.slice(26));
}

function amountUsd(raw, token) {
  return Number(ethers.formatUnits(raw, token.decimals)) * token.priceUsd;
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

function eip1167Implementation(code) {
  const c = String(code || "").toLowerCase();
  if (c.length !== 92) return null;
  if (!c.startsWith("0x363d3d373d3d3d363d73")) return null;
  if (!c.endsWith("5af43d82803e903d91602b57fd5bf3")) return null;
  return ethers.getAddress("0x" + c.slice(22, 62));
}

async function classifyContract(rpc, chainId, address, code, selectors) {
  const labels = [];
  const reasons = [];
  let noise = false;
  let implementation = null;

  const known = KNOWN_LABELS.get(`${chainId}:${address.toLowerCase()}`);
  if (known) {
    labels.push("known");
    reasons.push(known);
    noise = true;
  }

  const cloneImpl = eip1167Implementation(code);
  if (cloneImpl) {
    labels.push("erc1167-minimal-proxy");
    implementation = cloneImpl;
    // Many AMM pools on Base are 45-byte clones. Keep visible, but down-rank unless a value selector is present.
    if (selectors.length === 0) noise = true;
  }

  const eip1967Impl = await getImpl(rpc, address).catch(() => null);
  if (eip1967Impl) {
    labels.push("eip1967-proxy");
    implementation = eip1967Impl;
  }

  const [token0, token1] = await Promise.all([
    ethCall(rpc, address, poolIface, "token0"),
    ethCall(rpc, address, poolIface, "token1"),
  ]);
  if (token0 && token1 && token0 !== ethers.ZeroAddress && token1 !== ethers.ZeroAddress) {
    labels.push("amm-pool-like");
    reasons.push(`token0=${token0} token1=${token1}`);
    noise = true;
  }

  const codeBytes = code ? (code.length - 2) / 2 : 0;
  if (codeBytes < 250 && selectors.length === 0 && !labels.includes("amm-pool-like")) {
    labels.push("tiny-code-no-economic-selectors");
    reasons.push("small bytecode and no tracked economic selectors");
    noise = true;
  }

  return {
    labels,
    reasons,
    noise,
    implementation,
  };
}

async function getLogsChunked(rpc, token, fromBlock, toBlock) {
  const logs = [];
  for (let from = fromBlock; from <= toBlock; from += LOG_CHUNK) {
    const to = Math.min(toBlock, from + LOG_CHUNK - 1);
    const chunk = await rpcCall(
      rpc,
      "eth_getLogs",
      [{ fromBlock: ethers.toBeHex(from), toBlock: ethers.toBeHex(to), address: token.address, topics: [transferTopic] }],
      20_000,
    );
    if (chunk && Array.isArray(chunk)) {
      logs.push(...chunk);
      if (logs.length > MAX_LOGS_PER_TOKEN) return logs.slice(-MAX_LOGS_PER_TOKEN);
    }
  }
  return logs;
}

async function scanChain(chain) {
  const rpc = await resolveRpc(chain.id);
  if (!rpc) return { chain: chain.name, chainId: chain.id, rpcResolved: false, rows: [] };

  const latestHex = await rpcCall(rpc, "eth_blockNumber", [], 8_000);
  if (!latestHex) return { chain: chain.name, chainId: chain.id, rpcResolved: false, rows: [] };
  const latest = parseInt(latestHex, 16);
  const fromBlock = Math.max(0, latest - LOOKBACK_BLOCKS);
  const rows = [];

  for (const token of chain.tokens) {
    const logs = await getLogsChunked(rpc, token, fromBlock, latest);
    const inbound = new Map();
    for (const log of logs) {
      if (!log.topics || log.topics.length < 3) continue;
      const to = topicAddress(log.topics[2]);
      const value = BigInt(log.data || "0x0");
      const prev = inbound.get(to.toLowerCase()) || { address: to, raw: 0n, count: 0, lastBlock: 0 };
      prev.raw += value;
      prev.count += 1;
      prev.lastBlock = Math.max(prev.lastBlock, parseInt(log.blockNumber, 16));
      inbound.set(to.toLowerCase(), prev);
    }

    const ranked = [...inbound.values()]
      .map((r) => ({ ...r, inboundUsd: amountUsd(r.raw, token) }))
      .filter((r) => r.inboundUsd >= MIN_BALANCE_USD / 4)
      .sort((a, b) => b.inboundUsd - a.inboundUsd)
      .slice(0, MAX_RECIPIENTS_PER_TOKEN);

    for (const rec of ranked) {
      const code = await rpcCall(rpc, "eth_getCode", [rec.address, "latest"], 8_000);
      const codeBytes = code ? (code.length - 2) / 2 : 0;
      if (!code || code === "0x" || codeBytes === 0) continue;

      const balanceRaw = await ethCall(rpc, token.address, erc20, "balanceOf", [rec.address]);
      if (balanceRaw === null) continue;
      const balanceUsd = amountUsd(balanceRaw, token);
      if (balanceUsd < MIN_BALANCE_USD) continue;

      const lowerCode = code.toLowerCase();
      const selectors = Object.entries(ECONOMIC_SELECTORS)
        .filter(([, selector]) => lowerCode.includes(selector))
        .map(([sig]) => sig);
      const classification = await classifyContract(rpc, chain.id, rec.address, code, selectors);

      let owner = null;
      let ownerSource = null;
      for (const fn of ["owner", "admin", "governor", "governance"]) {
        const value = await ethCall(rpc, rec.address, ownerIface, fn);
        if (value && value !== ethers.ZeroAddress) {
          owner = value;
          ownerSource = `${fn}()`;
          break;
        }
      }
      let ownerCodeBytes = null;
      if (owner) {
        const ownerCode = await rpcCall(rpc, "eth_getCode", [owner, "latest"], 8_000);
        ownerCodeBytes = ownerCode ? (ownerCode.length - 2) / 2 : null;
      }

      const rawScore =
        Math.min(40, Math.log10(balanceUsd / MIN_BALANCE_USD + 1) * 30) +
        Math.min(25, selectors.length * 4) +
        (owner && ownerCodeBytes === 0 ? 15 : 0) +
        (codeBytes < 500 ? 10 : 0) +
        (rec.count <= 3 ? 5 : 0);
      const score = Math.max(0, rawScore - (classification.noise ? 30 : 0));

      rows.push({
        chain: chain.name,
        chainId: chain.id,
        token: token.symbol,
        tokenAddress: token.address,
        contract: rec.address,
        codeBytes,
        recentInboundUsd: rec.inboundUsd,
        currentBalanceUsd: balanceUsd,
        transferCount: rec.count,
        lastInboundBlock: rec.lastBlock,
        selectors,
        owner,
        ownerSource,
        ownerCodeBytes,
        classification,
        score: Math.round(score * 100) / 100,
        rawScore: Math.round(rawScore * 100) / 100,
        status: classification.noise ? "known-or-low-signal-value-contract" : "needs-manual-bytecode-or-source-review",
        routePositive: false,
        blocker: "Value-holding contract identified, but no permissionless fund-movement path or fork economics proven",
      });
    }
  }

  return { chain: chain.name, chainId: chain.id, rpcResolved: true, block: latest, fromBlock, rows };
}

async function main() {
  const chainResults = [];
  for (const chain of CHAINS) chainResults.push(await scanChain(chain));
  const rows = chainResults.flatMap((c) => c.rows).sort((a, b) => b.score - a.score || b.currentBalanceUsd - a.currentBalanceUsd);
  const reviewRows = rows.filter((r) => !r.classification.noise);
  const noiseRows = rows.filter((r) => r.classification.noise).sort((a, b) => b.rawScore - a.rawScore || b.currentBalanceUsd - a.currentBalanceUsd);
  const topRows = reviewRows.slice(0, 50);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-recent-contracts-old-money.js",
    scope: "Recent blue-chip token inflows to value-holding contracts",
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
    thresholds: { lookbackBlocks: LOOKBACK_BLOCKS, minBalanceUsd: MIN_BALANCE_USD, maxRecipientsPerToken: MAX_RECIPIENTS_PER_TOKEN },
    summary: {
      chains: chainResults.length,
      contractRows: rows.length,
      reviewRows: reviewRows.length,
      noiseRows: noiseRows.length,
      topRows: topRows.length,
      eoaOwnerRows: rows.filter((r) => r.ownerCodeBytes === 0).length,
      economicSelectorRows: rows.filter((r) => r.selectors.length > 0).length,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      status: rows.length ? "manual-review-candidates" : "no-material-contract-recipients",
    },
    chains: chainResults.map(({ rows: _rows, ...rest }) => ({ ...rest, rows: _rows.length })),
    topRows,
    topNoiseRows: noiseRows.slice(0, 25),
  };

  ensureDir(OUT_JSON);
  fs.writeFileSync(OUT_JSON, JSON.stringify(artifact, null, 2));

  const md = [
    `# ⚪ CLEAN - Recent Contracts With Old Money`,
    ``,
    `Generated: ${artifact.generatedAt}`,
    ``,
    `Signal: No confirmed permissionless value movement or route-positive economics was found; rows are manual review candidates only.`,
    ``,
    `## Summary`,
    ``,
    `- Status: \`${artifact.summary.status}\``,
    `- Contract rows: \`${artifact.summary.contractRows}\``,
    `- Review rows after noise filter: \`${artifact.summary.reviewRows}\``,
    `- Noise-classified rows: \`${artifact.summary.noiseRows}\``,
    `- Economic selector rows: \`${artifact.summary.economicSelectorRows}\``,
    `- EOA-owner rows: \`${artifact.summary.eoaOwnerRows}\``,
    `- Route-positive: \`0\``,
    ``,
    `## Top Rows`,
    ``,
    `| Score | Chain | Token | Contract | Balance | Owner Type | Labels | Selectors |`,
    `|---:|---|---|---|---:|---|---|---|`,
    ...topRows.slice(0, 20).map((r) => `| ${r.score} | ${r.chain} | ${r.token} | \`${r.contract}\` | $${r.currentBalanceUsd.toFixed(0)} | ${r.owner ? (r.ownerCodeBytes === 0 ? "EOA" : "contract") : "unknown"} | ${r.classification.labels.join(", ") || "none"} | ${r.selectors.slice(0, 4).map((s) => `\`${s}\``).join(", ") || "none"} |`),
    ``,
    `## Top Noise Rows`,
    ``,
    `| Raw Score | Chain | Token | Contract | Balance | Labels | Reason |`,
    `|---:|---|---|---|---:|---|---|`,
    ...noiseRows.slice(0, 12).map((r) => `| ${r.rawScore} | ${r.chain} | ${r.token} | \`${r.contract}\` | $${r.currentBalanceUsd.toFixed(0)} | ${r.classification.labels.join(", ") || "none"} | ${r.classification.reasons.slice(0, 2).join("; ").replace(/\|/g, "/") || "n/a"} |`),
    ``,
    `## Gate`,
    ``,
    `These are review candidates only. A row becomes fork-worthy only after a concrete permissionless function can move value or create positive economics under static/fork simulation.`,
  ].join("\n");
  fs.writeFileSync(OUT_MD, md);

  console.log(`Recent old-money contracts: rows=${rows.length} reviewRows=${reviewRows.length} noiseRows=${noiseRows.length} economicSelectorRows=${artifact.summary.economicSelectorRows} eoaOwnerRows=${artifact.summary.eoaOwnerRows} routePositive=0`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT_JSON)}`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exitCode = 1;
});
