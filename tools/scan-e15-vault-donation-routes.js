#!/usr/bin/env node
// Focused read-only triage for current E15 vault-donation HIGH alerts.
// RPC URLs are read locally and never printed or written.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const ALERT_FILE = path.join(WORKSPACE, "reports", "monitor", "alerts.jsonl");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "e15-vault-donation-routes.json");

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const UNIV3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ETH_USD_FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const CREATE_MARKET_TOPIC = "0x8a41cabf57f8c9e58b85a041c8b6e82af3eb44c2a21833c0f03a639b5bcb1c49";
const FEES = [100, 500, 3000, 10000];

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const FACTORY = new ethers.Interface(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"]);
const MORPHO_IFACE = new ethers.Interface([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
]);
const CHAINLINK = new ethers.Interface([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
]);

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params, timeoutMs = 10_000) {
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
    return json.result || null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function resolveRpc(chainId) {
  for (const url of extractRpcUrls()) {
    const id = await rpcCall(url, "eth_chainId", []);
    if (id && parseInt(id, 16) === chainId) return url;
  }
  return null;
}

function round(n, d = 6) {
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(d));
}

function human(raw, decimals) {
  return Number(ethers.formatUnits(raw || 0n, decimals || 18));
}

async function safeCall(provider, to, data) {
  try { return await provider.call({ to, data }); } catch (_) { return null; }
}

function readAlerts() {
  if (!fs.existsSync(ALERT_FILE)) return [];
  return fs.readFileSync(ALERT_FILE, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch (_) { return null; }
  }).filter(Boolean);
}

function latestHighVaultAlerts() {
  const now = Date.now();
  const recent = readAlerts().filter((a) => {
    if (a.condition !== "vault-donation" || a.severity !== "HIGH" || !a.vault) return false;
    const ts = Date.parse(a.timestamp || "");
    return Number.isFinite(ts) && now - ts <= 24 * 60 * 60 * 1000;
  });
  const byVault = new Map();
  for (const alert of recent) {
    const key = `${alert.chainId || 1}:${String(alert.vault).toLowerCase()}`;
    const prev = byVault.get(key);
    if (!prev || Date.parse(alert.timestamp) > Date.parse(prev.timestamp)) byVault.set(key, alert);
  }
  return [...byVault.values()].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

async function tokenMeta(provider, token) {
  const out = { address: token };
  const [symRaw, nameRaw, decRaw] = await Promise.all([
    safeCall(provider, token, ERC20.encodeFunctionData("symbol", [])),
    safeCall(provider, token, ERC20.encodeFunctionData("name", [])),
    safeCall(provider, token, ERC20.encodeFunctionData("decimals", [])),
  ]);
  try { if (symRaw) out.symbol = ERC20.decodeFunctionResult("symbol", symRaw)[0]; } catch (_) {}
  try { if (nameRaw) out.name = ERC20.decodeFunctionResult("name", nameRaw)[0]; } catch (_) {}
  try { if (decRaw) out.decimals = Number(ERC20.decodeFunctionResult("decimals", decRaw)[0]); } catch (_) {}
  if (out.decimals === undefined) out.decimals = 18;
  return out;
}

async function ethUsd(provider) {
  const [roundRaw, decRaw] = await Promise.all([
    safeCall(provider, ETH_USD_FEED, CHAINLINK.encodeFunctionData("latestRoundData", [])),
    safeCall(provider, ETH_USD_FEED, CHAINLINK.encodeFunctionData("decimals", [])),
  ]);
  try {
    const dec = decRaw ? Number(CHAINLINK.decodeFunctionResult("decimals", decRaw)[0]) : 8;
    const [, answer] = CHAINLINK.decodeFunctionResult("latestRoundData", roundRaw);
    return Number(answer) / 10 ** dec;
  } catch (_) { return null; }
}

function priceForAsset(asset, ethPrice) {
  const a = String(asset || "").toLowerCase();
  if ([USDC, DAI, USDT].map((x) => x.toLowerCase()).includes(a)) return 1;
  if (a === WETH.toLowerCase()) return ethPrice || null;
  return null;
}

async function readVault(provider, address, ethPrice) {
  const [assetRaw, totalAssetsRaw, totalSupplyRaw, shareDecRaw, symbolRaw, nameRaw, maxDepositRaw] = await Promise.all([
    safeCall(provider, address, ERC4626.encodeFunctionData("asset", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("totalAssets", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("totalSupply", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("decimals", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("symbol", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("name", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("maxDeposit", [ethers.ZeroAddress])),
  ]);
  const asset = assetRaw ? ERC4626.decodeFunctionResult("asset", assetRaw)[0] : null;
  const assetMeta = asset ? await tokenMeta(provider, asset) : null;
  const shareDecimals = shareDecRaw ? Number(ERC4626.decodeFunctionResult("decimals", shareDecRaw)[0]) : 18;
  let symbol = null;
  let name = null;
  try { if (symbolRaw) symbol = ERC4626.decodeFunctionResult("symbol", symbolRaw)[0]; } catch (_) {}
  try { if (nameRaw) name = ERC4626.decodeFunctionResult("name", nameRaw)[0]; } catch (_) {}
  const totalAssets = totalAssetsRaw && assetMeta ? human(ERC4626.decodeFunctionResult("totalAssets", totalAssetsRaw)[0], assetMeta.decimals) : null;
  const totalSupply = totalSupplyRaw ? human(ERC4626.decodeFunctionResult("totalSupply", totalSupplyRaw)[0], shareDecimals) : null;
  const oneShareRaw = 10n ** BigInt(Math.min(shareDecimals, 36));
  const oneShareAssetsRaw = await safeCall(provider, address, ERC4626.encodeFunctionData("convertToAssets", [oneShareRaw]));
  const oneShareAssets = oneShareAssetsRaw && assetMeta ? human(ERC4626.decodeFunctionResult("convertToAssets", oneShareAssetsRaw)[0], assetMeta.decimals) : null;
  const maxDeposit = maxDepositRaw && assetMeta ? human(ERC4626.decodeFunctionResult("maxDeposit", maxDepositRaw)[0], assetMeta.decimals) : null;
  const assetPriceUsd = priceForAsset(asset, ethPrice);
  const totalAssetsUsd = totalAssets !== null && assetPriceUsd !== null ? totalAssets * assetPriceUsd : null;
  return {
    address,
    symbol,
    name,
    shareDecimals,
    asset: assetMeta,
    totalAssetsRaw: totalAssetsRaw ? ERC4626.decodeFunctionResult("totalAssets", totalAssetsRaw)[0].toString() : null,
    totalSupplyRaw: totalSupplyRaw ? ERC4626.decodeFunctionResult("totalSupply", totalSupplyRaw)[0].toString() : null,
    totalAssets: round(totalAssets, 12),
    totalSupply: round(totalSupply, 12),
    oneShareAssets: round(oneShareAssets, 12),
    maxDeposit: round(maxDeposit, 6),
    assetPriceUsd: round(assetPriceUsd, 6),
    totalAssetsUsd: round(totalAssetsUsd, 6),
  };
}

function decodeCreateMarket(log) {
  const data = String(log.data || "0x").slice(2);
  if (data.length < 320) return null;
  return {
    id: log.topics?.[1] || null,
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    loanToken: ethers.getAddress("0x" + data.slice(24, 64)),
    collateralToken: ethers.getAddress("0x" + data.slice(88, 128)),
    oracle: ethers.getAddress("0x" + data.slice(152, 192)),
    irm: ethers.getAddress("0x" + data.slice(216, 256)),
    lltvRaw: BigInt("0x" + data.slice(256, 320)).toString(),
  };
}

async function scanMorphoMatches(provider, vault, fromBlock) {
  const latest = await provider.getBlockNumber();
  const matches = [];
  const start = Math.max(1, fromBlock || latest - 200000);
  for (let from = start; from <= latest; from += 10000) {
    const to = Math.min(latest, from + 9999);
    const logs = await provider.getLogs({ address: MORPHO, topics: [CREATE_MARKET_TOPIC], fromBlock: from, toBlock: to }).catch(() => []);
    for (const log of logs) {
      const decoded = decodeCreateMarket(log);
      if (!decoded) continue;
      const side = decoded.collateralToken.toLowerCase() === vault.toLowerCase()
        ? "collateralToken"
        : decoded.loanToken.toLowerCase() === vault.toLowerCase()
          ? "loanToken"
          : null;
      if (!side) continue;
      let market = null;
      try {
        const marketRaw = await provider.call({ to: MORPHO, data: MORPHO_IFACE.encodeFunctionData("market", [decoded.id]) });
        const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares] = MORPHO_IFACE.decodeFunctionResult("market", marketRaw);
        market = {
          totalSupplyAssets: totalSupplyAssets.toString(),
          totalSupplyShares: totalSupplyShares.toString(),
          totalBorrowAssets: totalBorrowAssets.toString(),
          totalBorrowShares: totalBorrowShares.toString(),
        };
      } catch (_) {}
      matches.push({ ...decoded, side, market });
    }
  }
  return matches;
}

async function scanDexPools(provider, vault, asset) {
  const peers = [asset, WETH, USDC].filter(Boolean);
  const uniquePeers = [...new Set(peers.map((x) => ethers.getAddress(x)))].filter((x) => x.toLowerCase() !== vault.toLowerCase());
  const rows = [];
  const vaultMeta = await tokenMeta(provider, vault);
  for (const peer of uniquePeers) {
    const peerMeta = await tokenMeta(provider, peer);
    for (const fee of FEES) {
      const raw = await safeCall(provider, UNIV3_FACTORY, FACTORY.encodeFunctionData("getPool", [vault, peer, fee]));
      let pool = ethers.ZeroAddress;
      try { if (raw) pool = FACTORY.decodeFunctionResult("getPool", raw)[0]; } catch (_) {}
      if (pool === ethers.ZeroAddress) continue;
      const [vaultBalRaw, peerBalRaw] = await Promise.all([
        safeCall(provider, vault, ERC20.encodeFunctionData("balanceOf", [pool])),
        safeCall(provider, peer, ERC20.encodeFunctionData("balanceOf", [pool])),
      ]);
      const vaultBalance = vaultBalRaw ? human(ERC20.decodeFunctionResult("balanceOf", vaultBalRaw)[0], vaultMeta.decimals) : 0;
      const peerBalance = peerBalRaw ? human(ERC20.decodeFunctionResult("balanceOf", peerBalRaw)[0], peerMeta.decimals) : 0;
      rows.push({ pool, peer, peerSymbol: peerMeta.symbol || null, fee, vaultBalance: round(vaultBalance, 9), peerBalance: round(peerBalance, 9) });
    }
  }
  return rows;
}

async function main() {
  const alerts = latestHighVaultAlerts();
  const grouped = new Map();
  for (const alert of alerts) {
    if (!grouped.has(alert.chainId || 1)) grouped.set(alert.chainId || 1, []);
    grouped.get(alert.chainId || 1).push(alert);
  }

  const rows = [];
  for (const [chainId, chainAlerts] of grouped.entries()) {
    const rpc = await resolveRpc(chainId);
    if (!rpc) {
      for (const alert of chainAlerts) rows.push({ alert, rpcResolved: false, routePositive: false });
      continue;
    }
    const provider = new ethers.JsonRpcProvider(rpc);
    const ethPrice = chainId === 1 ? await ethUsd(provider) : null;
    for (const alert of chainAlerts) {
      const vault = ethers.getAddress(alert.vault);
      const vaultData = await readVault(provider, vault, ethPrice);
      const morphoMatches = chainId === 1 ? await scanMorphoMatches(provider, vault, alert.deployBlock) : [];
      const dexPools = chainId === 1 ? await scanDexPools(provider, vault, vaultData.asset?.address) : [];
      const blockers = [];
      if (morphoMatches.length === 0) blockers.push("Vault shares are not referenced by any scanned Morpho Blue market as loan or collateral token");
      if (dexPools.length === 0) blockers.push("No Uniswap V3 share-liquidity pool found against asset/WETH/USDC");
      if (vaultData.maxDeposit === 0) blockers.push("Vault maxDeposit is zero, so fresh public deposit inflation is currently closed");
      if ((vaultData.totalAssetsUsd || 0) < 1000) blockers.push("Corrected live vault TVL is too small for a material direct-drain route");
      blockers.push("Low-TVL ERC4626 donation risk requires a victim/consumer route; no current permissionless borrower route is proven");
      rows.push({
        alert,
        rpcResolved: true,
        chainId,
        chain: chainId === 1 ? "Ethereum" : String(chainId),
        vault: vaultData,
        correctedTotalAssetsUsd: vaultData.totalAssetsUsd,
        alertTotalAssets: alert.totalAssets,
        alertLikelyDecimalCorrect: vaultData.totalAssetsUsd === null ? null : Math.abs((alert.totalAssets || 0) - vaultData.totalAssetsUsd) / Math.max(vaultData.totalAssetsUsd, 1) < 0.2,
        morphoMatches,
        dexPools,
        routePositive: false,
        signedActionJustified: false,
        blockers,
      });
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-e15-vault-donation-routes.js",
    scope: "Read-only route triage for current E15 vault-donation HIGH alerts",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, signedActions: false, exploitExecuteCalls: false, routePositive: false, signedActionJustified: false },
    summary: {
      alertsInput: alerts.length,
      rows: rows.length,
      rowsWithMorphoMarketConsumer: rows.filter((r) => (r.morphoMatches || []).length > 0).length,
      rowsWithDexSharePool: rows.filter((r) => (r.dexPools || []).length > 0).length,
      correctedRowsBelow1000Usd: rows.filter((r) => (r.correctedTotalAssetsUsd || 0) < 1000).length,
      decimalMismatchRows: rows.filter((r) => r.alertLikelyDecimalCorrect === false).length,
      routePositive: 0,
      signedActionJustified: false,
    },
    rows,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`E15 vault-donation routes: rows=${out.summary.rows} morphoConsumers=${out.summary.rowsWithMorphoMarketConsumer} dexPools=${out.summary.rowsWithDexSharePool} decimalMismatch=${out.summary.decimalMismatchRows} routePositive=0`);
  console.log(`Report: ${path.relative(WORKSPACE, OUT_FILE)}`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
