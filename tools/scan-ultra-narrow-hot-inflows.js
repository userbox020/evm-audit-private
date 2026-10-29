#!/usr/bin/env node
/**
 * scan-ultra-narrow-hot-inflows.js
 *
 * READ-ONLY SCANNER — Never initiates transactions.
 * Scans last ~100 blocks on Ethereum (1) and Base (8453) for ERC20 Transfer events
 * where value >= $50,000 USD (hardcoded prices) and recipient is a contract.
 *
 * For each hot inflow:
 *   - Retrieves contract bytecode (eth_getCode)
 *   - Checks for EIP-1967 proxy pattern (eth_getStorageAt)
 *   - Checks for known function selectors in bytecode
 *   - Classifies contract type (proxy, multisig, vault, pool, bridge, generic)
 *   - Flags watch candidates: proxy + privileged selectors + value >= $100k
 *
 * Output: reports/raw/fast/ultra-narrow-hot-inflows.json
 *
 * GATE: Requires functioning RPC endpoints for chains 1 and 8453.
 *       Exits cleanly with error message if unavailable.
 *
 * Safety: Only eth_call, eth_getLogs, eth_getCode, eth_getStorageAt,
 *         eth_blockNumber, and eth_chainId RPC methods. No tx submission.
 *
 * Dependencies: node 18+ (global fetch), ./shared-rpc for RPC resolution.
 *               No ethers dependency — uses native fetch for all RPC calls.
 */

const fs = require("fs");
const path = require("path");
const { resolveRpc, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_FILE = path.join(
  WORKSPACE,
  "reports",
  "raw",
  "fast",
  "ultra-narrow-hot-inflows.json"
);

// ─── Constants ────────────────────────────────────────────────────────────────

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SCAN_BLOCKS = 100;
const THRESHOLD_USD = 50000;
const WATCH_THRESHOLD_USD = 100000;

// Hardcoded price map (USD per token)
const PRICES = {
  WETH: 1575,
  WBTC: 29000,
  USDC: 1,
  USDT: 1,
  DAI: 1,
  wstETH: 1850,
  weETH: 1600,
  cbBTC: 29000,
  USDS: 1,
  sUSDe: 1,
  USDe: 1,
};

// Token configurations with per-chain addresses
const TOKENS = [
  {
    symbol: "WETH",
    decimals: 18,
    addresses: {
      1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      8453: "0x4200000000000000000000000000000000000006",
    },
  },
  {
    symbol: "WBTC",
    decimals: 8,
    addresses: {
      1: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    },
  },
  {
    symbol: "USDC",
    decimals: 6,
    addresses: {
      1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
  },
  {
    symbol: "USDT",
    decimals: 6,
    addresses: {
      1: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      8453: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    },
  },
  {
    symbol: "DAI",
    decimals: 18,
    addresses: {
      1: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      8453: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    },
  },
  {
    symbol: "wstETH",
    decimals: 18,
    addresses: {
      1: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
      8453: "0x9Bc7B6Ade80E1CfE78B3b27837E27E10A9E64A3b",
    },
  },
  {
    symbol: "weETH",
    decimals: 18,
    addresses: {
      1: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee",
      8453: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A",
    },
  },
  {
    symbol: "cbBTC",
    decimals: 8,
    addresses: {
      1: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      8453: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    },
  },
  {
    symbol: "USDS",
    decimals: 18,
    addresses: {
      1: "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
    },
  },
  {
    symbol: "sUSDe",
    decimals: 18,
    addresses: {
      1: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
    },
  },
  {
    symbol: "USDe",
    decimals: 18,
    addresses: {
      1: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
    },
  },
];

// Function selector bytecode signatures (without 0x prefix)
const SELECTORS = {
  "execute(address,bytes)": "b61d27f6",
  "multicall(bytes[])": "ac9650d8",
  "withdraw(uint256)": "2e1a7d4d",
  "claim(uint256)": "379607f5",
  "claim(address)": "1e83409a",
  "swap(uint256,uint256,address,bytes)": "128acb08",
  "bridge(uint256,address)": "4d9040cf",
  "deposit(uint256)": "b6b55f25",
  "rebalance()": "7b5b5a32",
  "liquidate(address,uint256,bytes)": "735dee7a",
  "redeem(uint256)": "db006a75",
  "mint(uint256)": "1249c58b",
  "burn(uint256)": "42966c68",
  "execTransaction(address,uint256,bytes,uint8)": "6a761202",
  "confirmTransaction(uint256)": "c01e1bd6",
  "addOwner(address)": "0d582f13",
  "removeOwner(address)": "f8dc5dd9",
  "collectFees()": "1b14ce5b",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Compute minimum raw token amount for the $50k threshold using BigInt
 * arithmetic to avoid precision loss with high-decimal tokens.
 */
function minRawForToken(decimals, price) {
  // rawValue >= THRESHOLD_USD * 10^decimals / price
  // Use 6 decimal precision for price multiplication to avoid BigInt truncation
  const PRICE_PRECISION = 1000000n;
  const priceInt = BigInt(Math.round(price * Number(PRICE_PRECISION)));
  const numerator =
    BigInt(THRESHOLD_USD) * 10n ** BigInt(decimals) * PRICE_PRECISION;
  return numerator / priceInt;
}

/**
 * Parse raw uint256 value from Transfer event log data.
 * data is a 0x-prefixed hex string of 32 bytes (66 chars for non-zero).
 */
function parseRawValue(data) {
  if (!data || data === "0x" || data.length < 66) return 0n;
  return BigInt(data);
}

/**
 * Check if an address is a contract by retrieving its code.
 */
async function getContractCode(rpc, address) {
  return await rpcCall(rpc, "eth_getCode", [address, "latest"], 10000);
}

/**
 * Read the EIP-1967 implementation storage slot.
 * Returns the implementation address or null if no proxy is detected.
 */
async function checkEIP1967Impl(rpc, address) {
  const raw = await rpcCall(
    rpc,
    "eth_getStorageAt",
    [address, EIP1967_IMPL_SLOT, "latest"],
    10000
  );
  if (!raw || raw === "0x" + "0".repeat(64)) return null;
  const impl = "0x" + raw.slice(26);
  if (impl === "0x0000000000000000000000000000000000000000") return null;
  return impl.toLowerCase();
}

/**
 * Scan bytecode for known function selectors.
 * Returns a map of signature -> boolean.
 */
function findSelectors(bytecode) {
  const found = {};
  if (!bytecode || bytecode === "0x" || bytecode.length < 10) return found;
  const bc = bytecode.toLowerCase().replace("0x", "");
  for (const [sig, sel] of Object.entries(SELECTORS)) {
    found[sig] = bc.includes(sel);
  }
  return found;
}

/**
 * Filter selectors to only include the "privileged" public ones.
 */
function findPublicPrivilegedSelectors(selectorsFound) {
  const privileged = [
    "execute(address,bytes)",
    "multicall(bytes[])",
    "withdraw(uint256)",
    "claim(uint256)",
    "claim(address)",
  ];
  const result = {};
  for (const sig of privileged) {
    if (selectorsFound[sig]) result[sig] = true;
  }
  return result;
}

/**
 * Classify a contract based on its proxy status and revealed selectors.
 */
function classifyContract(isProxy, selectorsFound) {
  if (isProxy) return "eip1967-proxy";

  const present = Object.entries(selectorsFound)
    .filter(([, v]) => v)
    .map(([k]) => k);

  // Multisig-like: Gnosis Safe / multisig selectors
  const multiSigs = [
    "execTransaction(address,uint256,bytes,uint8)",
    "confirmTransaction(uint256)",
    "addOwner(address)",
    "removeOwner(address)",
  ];
  if (multiSigs.some((s) => present.includes(s))) return "multisig-like";

  // ERC4626 vault: deposit, mint, redeem, withdraw (need >= 2)
  const vaultSigs = [
    "deposit(uint256)",
    "mint(uint256)",
    "redeem(uint256)",
    "withdraw(uint256)",
  ];
  if (vaultSigs.filter((s) => present.includes(s)).length >= 2)
    return "erc4626-vault";

  // Pool-like: swap, burn, mint, collect fees
  const poolSigs = [
    "swap(uint256,uint256,address,bytes)",
    "burn(uint256)",
    "mint(uint256)",
    "collectFees()",
  ];
  if (poolSigs.some((s) => present.includes(s))) return "pool-like";

  // Bridge or custody: bridge, claim
  const bridgeSigs = [
    "bridge(uint256,address)",
    "claim(uint256)",
    "claim(address)",
  ];
  if (bridgeSigs.some((s) => present.includes(s)))
    return "bridge-or-custody-like";

  return "generic-contract";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Ultra-Narrow Hot Inflow Scanner ===");
  console.log(
    `Scanning last ~${SCAN_BLOCKS} blocks on Ethereum (1) and Base (8453)`
  );
  console.log(`Threshold: >= $${THRESHOLD_USD.toLocaleString()} USD to contract\n`);

  // ── Resolve RPC endpoints ──────────────────────────────────────────────
  const rpc1 = await resolveRpc(1);
  if (!rpc1) {
    console.error("GATE: No RPC available for chain 1. Exiting.");
    process.exit(1);
  }

  const rpc8453 = await resolveRpc(8453);
  if (!rpc8453) {
    console.error("GATE: No RPC available for chain 8453. Exiting.");
    process.exit(1);
  }

  // Mask RPC URLs in output for security
  console.log(`Chain 1 RPC:     ${rpc1.substring(0, 25)}...`);
  console.log(`Chain 8453 RPC:  ${rpc8453.substring(0, 25)}...\n`);

  const chainConfigs = [
    { id: 1, name: "ethereum", rpc: rpc1 },
    { id: 8453, name: "base", rpc: rpc8453 },
  ];

  // ── Phase 1: Fetch logs for all tokens on both chains ──────────────────
  const rawRows = [];
  // Track unique (chainId:recipient) pairs for contract analysis in Phase 2
  const contractTargets = new Map();

  for (const chain of chainConfigs) {
    // Get latest block
    const latestHex = await rpcCall(chain.rpc, "eth_blockNumber", [], 8000);
    if (!latestHex) {
      console.error(
        `  Skipping chain ${chain.id}: cannot get block number`
      );
      continue;
    }
    const latest = parseInt(latestHex, 16);
    const from = Math.max(0, latest - SCAN_BLOCKS);
    const fromHex = "0x" + from.toString(16);
    const toHex = "0x" + latest.toString(16);
    console.log(
      `Chain ${chain.id} (${chain.name}): scanning blocks ${from}..${latest}`
    );

    const chainTokens = TOKENS.filter((t) => t.addresses[chain.id]);

    for (const token of chainTokens) {
      const addr = token.addresses[chain.id];
      const price = PRICES[token.symbol];
      if (!price) continue;

      const minRaw = minRawForToken(token.decimals, price);

      try {
        const logs = await rpcCall(
          chain.rpc,
          "eth_getLogs",
          [
            {
              fromBlock: fromHex,
              toBlock: toHex,
              address: addr,
              topics: [TRANSFER_TOPIC],
            },
          ],
          30000
        );

        if (!logs || !Array.isArray(logs)) {
          console.log(`  ${token.symbol}: no logs returned`);
          continue;
        }

        console.log(
          `  ${token.symbol} (${addr.substring(0, 10)}...): ${logs.length} events`
        );

        for (const log of logs) {
          const rawValue = parseRawValue(log.data);
          if (rawValue < minRaw) continue;

          // Value is safe for Number after filtering by minRaw
          const valueNum = Number(rawValue);
          const valueUsd = (valueNum / Math.pow(10, token.decimals)) * price;
          const topics = log.topics;
          if (!topics || topics.length < 3) continue;

          // Recipient is topic2 (indexed "to" param), last 20 bytes
          const recipient = "0x" + topics[2].slice(26).toLowerCase();

          rawRows.push({
            chain: chain.id,
            blockNumber: parseInt(log.blockNumber, 16),
            txHash: log.transactionHash,
            tokenSymbol: token.symbol,
            valueUsd: Math.round(valueUsd * 100) / 100,
            recipient,
          });

          const key = `${chain.id}:${recipient}`;
          if (!contractTargets.has(key)) {
            contractTargets.set(key, {
              chain: chain.id,
              rpc: chain.rpc,
              address: recipient,
            });
          }
        }
      } catch (err) {
        console.error(`  ${token.symbol}: ERROR — ${err.message}`);
      }

      // Brief delay to avoid rate-limiting
      await sleep(150);
    }
  }

  console.log(
    `\nFound ${rawRows.length} transfers >= $${THRESHOLD_USD.toLocaleString()}`
  );
  console.log(
    `Unique recipient contracts to analyze: ${contractTargets.size}`
  );

  // ── Phase 2: Analyze each unique recipient contract ────────────────────
  const contractAnalyses = new Map();
  let analyzedCount = 0;

  for (const [key, info] of contractTargets) {
    // Get contract bytecode
    const code = await getContractCode(info.rpc, info.address);
    if (!code || code === "0x") {
      // Not a contract — skip analysis, note as EOA
      contractAnalyses.set(key, {
        codeBytes: 0,
        isProxy: false,
        implAddress: null,
        publicSelectorsFound: {},
        classification: "eoa-skip",
      });
      analyzedCount++;
      if (analyzedCount % 20 === 0) process.stdout.write(".");
      continue;
    }

    const codeBytes = (code.length - 2) / 2; // hex chars -> bytes

    // Check EIP-1967 proxy
    const implAddr = await checkEIP1967Impl(info.rpc, info.address);
    const isProxy = implAddr !== null;

    // Scan bytecode for selectors
    const selectorsFound = findSelectors(code);
    const publicSelectors = findPublicPrivilegedSelectors(selectorsFound);
    const classification = classifyContract(isProxy, selectorsFound);

    contractAnalyses.set(key, {
      codeBytes,
      isProxy,
      implAddress: implAddr,
      publicSelectorsFound: publicSelectors,
      classification,
    });

    analyzedCount++;
    if (analyzedCount % 10 === 0) process.stdout.write(".");

    // Brief delay to avoid rate-limiting
    await sleep(50);
  }

  console.log(
    `\nContract analysis complete: ${analyzedCount} contracts checked`
  );

  // ── Phase 3: Assemble output ───────────────────────────────────────────
  const summaryRecipients = new Set();
  let hotContracts = 0;
  let proxyCount = 0;
  let watchCandidates = 0;

  const outputRows = [];

  for (const row of rawRows) {
    const key = `${row.chain}:${row.recipient}`;
    const analysis = contractAnalyses.get(key) || {
      codeBytes: 0,
      isProxy: false,
      implAddress: null,
      publicSelectorsFound: {},
      classification: "generic-contract",
    };

    summaryRecipients.add(key);

    // Watch candidate if: isProxy AND has public privileged selectors
    // AND value >= $100k
    const hasPublicSelectors =
      Object.keys(analysis.publicSelectorsFound).length > 0;
    const isWatch =
      analysis.isProxy &&
      hasPublicSelectors &&
      row.valueUsd >= WATCH_THRESHOLD_USD;

    outputRows.push({
      chain: row.chain,
      blockNumber: row.blockNumber,
      txHash: row.txHash,
      tokenSymbol: row.tokenSymbol,
      valueUsd: row.valueUsd,
      recipient: row.recipient,
      recipientCodeBytes: analysis.codeBytes,
      isProxy: analysis.isProxy,
      implAddress: analysis.implAddress,
      publicSelectorsFound: analysis.publicSelectorsFound,
      classification: analysis.classification,
      watchCandidate: isWatch,
    });

    if (analysis.classification !== "eoa-skip") hotContracts++;
    if (analysis.isProxy) proxyCount++;
    if (isWatch) watchCandidates++;
  }

  // ── Phase 4: Write output file ─────────────────────────────────────────
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "scan-ultra-narrow-hot-inflows.js",
    summary: {
      totalTransfers: outputRows.length,
      uniqueRecipients: summaryRecipients.size,
      hotContracts,
      proxyCount,
      watchCandidates,
      routePositive: 0,
    },
    transfers: outputRows,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

  console.log(`\n=== Scan Complete ===`);
  console.log(`Output: ${path.relative(WORKSPACE, OUT_FILE)}`);
  console.log(`Total transfers:     ${out.summary.totalTransfers}`);
  console.log(`Unique recipients:   ${out.summary.uniqueRecipients}`);
  console.log(`Hot contracts:       ${out.summary.hotContracts}`);
  console.log(`Proxies:             ${out.summary.proxyCount}`);
  console.log(`Watch candidates:    ${out.summary.watchCandidates}`);
}

main().catch((err) => {
  console.error(`\nFatal error: ${err.message}`);
  process.exitCode = 1;
});
