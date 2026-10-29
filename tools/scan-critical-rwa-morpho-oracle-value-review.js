#!/usr/bin/env node
// Read-only critical review for RWA/NAV tokens accepted by Morpho Blue.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const IN = path.join(WORKSPACE, "reports", "raw", "fast", "critical-rwa-nav-consumer-route-review.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "critical-rwa-morpho-oracle-value-review.json");
const REPORT = path.join(WORKSPACE, "reports", "critical-rwa-morpho-oracle-value-review.md");

const CHAIN = { chainId: 1, name: "Ethereum", coinSlug: "ethereum" };
const PRICE_IFACE = new ethers.Interface(["function price() view returns (uint256)"]);
const TIMEOUT_MS = 15_000;
const DIVERGENCE_BPS = Number(process.env.RWA_MORPHO_DIVERGENCE_BPS || "100");
const MIN_LIQUIDITY_USD = Number(process.env.RWA_MORPHO_MIN_LIQUIDITY_USD || "10000");

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function normalizeAddress(value) {
  try {
    return ethers.getAddress(value);
  } catch (_) {
    return null;
  }
}

function lowerAddress(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveEthereumRpc() {
  for (const url of loadRpcUrls()) {
    try {
      const chainIdHex = await rpcCall(url, "eth_chainId", [], 6000);
      if (Number(BigInt(chainIdHex)) === CHAIN.chainId) return url;
    } catch (_) {
      // Never print RPC URLs.
    }
  }
  return null;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAddressPrices(addresses) {
  const keys = [...new Set((addresses || []).map(lowerAddress).filter(Boolean).map((a) => `${CHAIN.coinSlug}:${a}`))];
  const out = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const batch = keys.slice(i, i + 50);
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${batch.join(",")}?searchWidth=6h`).catch(() => ({ coins: {} }));
    for (const [key, row] of Object.entries(json.coins || {})) {
      const address = lowerAddress(key.slice(`${CHAIN.coinSlug}:`.length));
      const price = Number(row?.price || 0);
      if (address && Number.isFinite(price) && price > 0) out.set(address, price);
    }
  }
  return out;
}

function formatUnitsNumber(raw, decimals) {
  try {
    return Number(ethers.formatUnits(raw, decimals));
  } catch (_) {
    return null;
  }
}

function bpsDiff(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / b) * 10000;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function asNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function marketKey(row) {
  return `${row?.market?.marketId || "unknown"}:${row?.producer?.address || "unknown"}`.toLowerCase();
}

async function main() {
  const source = readJson(IN, null);
  if (!source) throw new Error(`missing input artifact: ${path.relative(WORKSPACE, IN)}`);

  const candidates = [];
  for (const result of source.results || []) {
    for (const row of result.topMatches || []) {
      if (row.protocol !== "Morpho Blue") continue;
      if (!row.reviewCandidate) continue;
      if (row.side !== "collateralAsset") continue;
      if (!normalizeAddress(row?.market?.oracle?.address)) continue;
      candidates.push(row);
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const row of candidates) {
    const key = marketKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  const rpcUrl = await resolveEthereumRpc();
  const loanPriceMap = await fetchAddressPrices(deduped.map((row) => row?.market?.loanAsset?.address));
  const rows = [];
  let rpcResolved = Boolean(rpcUrl);

  for (const row of deduped) {
    const oracle = normalizeAddress(row.market.oracle.address);
    const loanAddress = normalizeAddress(row.market.loanAsset.address);
    const loanDecimals = Number(row.market.loanAsset.decimals);
    const collateralDecimals = Number(row.market.collateralAsset.decimals);
    const collateralPublicUsd = asNumber(row.producer.tokenPriceUsd);
    const loanPublicUsd = loanPriceMap.get(loanAddress?.toLowerCase()) || null;
    const lltv = asNumber(row.market.lltv, 0);
    const liquidityUsd = asNumber(row.market.liquidityAssetsUsd, 0);
    let oraclePriceRaw = null;
    let callOk = false;
    let acceptedLoanPerCollateral = null;
    let acceptedCollateralUsd = null;
    let acceptedVsPublicBps = null;
    let borrowEdgeUsdPerCollateral = null;
    let borrowEdgeBpsAfterLltv = null;

    if (rpcUrl && oracle) {
      const raw = await rpcCall(rpcUrl, "eth_call", [{ to: oracle, data: PRICE_IFACE.encodeFunctionData("price", []) }, "latest"]).catch(() => null);
      if (raw && raw !== "0x") {
        try {
          const [decoded] = PRICE_IFACE.decodeFunctionResult("price", raw);
          oraclePriceRaw = decoded.toString();
          callOk = true;
          const scaleDecimals = 36 + loanDecimals - collateralDecimals;
          acceptedLoanPerCollateral = formatUnitsNumber(decoded, scaleDecimals);
          if (acceptedLoanPerCollateral !== null && loanPublicUsd !== null) {
            acceptedCollateralUsd = acceptedLoanPerCollateral * loanPublicUsd;
            acceptedVsPublicBps = bpsDiff(acceptedCollateralUsd, collateralPublicUsd);
            borrowEdgeUsdPerCollateral = acceptedCollateralUsd * lltv - collateralPublicUsd;
            borrowEdgeBpsAfterLltv = bpsDiff(acceptedCollateralUsd * lltv, collateralPublicUsd);
          }
        } catch (_) {
          // Keep row as call failed.
        }
      }
    }

    const overvalued = acceptedVsPublicBps !== null && acceptedVsPublicBps >= DIVERGENCE_BPS;
    const borrowEdgePositive = borrowEdgeUsdPerCollateral !== null && borrowEdgeUsdPerCollateral > 0;
    const liquid = liquidityUsd >= MIN_LIQUIDITY_USD;
    const routePositive = Boolean(callOk && overvalued && borrowEdgePositive && liquid);

    rows.push({
      protocol: row.protocol,
      chain: "Ethereum",
      marketId: row.market.marketId,
      oracle,
      producer: {
        protocol: row.producer.protocol,
        symbol: row.producer.symbol,
        address: row.producer.address,
        tokenPriceUsd: round(collateralPublicUsd, 8),
        tags: row.producer.tags || [],
      },
      loanAsset: row.market.loanAsset,
      collateralAsset: row.market.collateralAsset,
      lltv,
      liquidityAssetsUsd: round(liquidityUsd, 6),
      borrowAssetsUsd: round(asNumber(row.market.borrowAssetsUsd, 0), 6),
      supplyAssetsUsd: round(asNumber(row.market.supplyAssetsUsd, 0), 6),
      oracleCall: {
        callOk,
        priceRaw: oraclePriceRaw,
        acceptedLoanPerCollateral: round(acceptedLoanPerCollateral, 10),
        loanPublicUsd: round(loanPublicUsd, 8),
        acceptedCollateralUsd: round(acceptedCollateralUsd, 8),
        acceptedVsPublicBps: round(acceptedVsPublicBps, 4),
        borrowEdgeUsdPerCollateral: round(borrowEdgeUsdPerCollateral, 8),
        borrowEdgeBpsAfterLltv: round(borrowEdgeBpsAfterLltv, 4),
      },
      routePositive,
      executableNow: false,
      signedActionJustified: false,
      blockers: [
        ...(callOk ? [] : ["Morpho oracle price() call failed or RPC unavailable"]),
        ...(overvalued ? [] : ["Accepted oracle value is not above public value by threshold"]),
        ...(borrowEdgePositive ? [] : ["Accepted value after LLTV haircut does not exceed public acquisition value"]),
        ...(liquid ? [] : ["Borrow-side liquidity below threshold"]),
        "RWA mint/redeem/transfer may be permissioned or restricted",
        "No exact acquisition, borrow, unwind, gas, slippage, or fork proof",
      ],
    });
  }

  rows.sort((a, b) => (b.oracleCall.borrowEdgeBpsAfterLltv ?? -1e18) - (a.oracleCall.borrowEdgeBpsAfterLltv ?? -1e18));
  const routePositiveRows = rows.filter((row) => row.routePositive);
  const acceptedOverThresholdRows = rows.filter((row) => (row.oracleCall.acceptedVsPublicBps ?? -Infinity) >= DIVERGENCE_BPS);
  const positiveAfterLltvRows = rows.filter((row) => (row.oracleCall.borrowEdgeUsdPerCollateral ?? -Infinity) > 0);

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-critical-rwa-morpho-oracle-value-review.js",
    scope: "Read-only Morpho oracle accepted-value review for RWA/NAV consumer candidates",
    sourceArtifact: path.relative(WORKSPACE, IN).replace(/\\/g, "/"),
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      liveTransactions: false,
      routePositive: routePositiveRows.length > 0,
      signedActionJustified: false,
    },
    thresholds: {
      divergenceBps: DIVERGENCE_BPS,
      minLiquidityUsd: MIN_LIQUIDITY_USD,
    },
    summary: {
      rpcResolved,
      candidatesReviewed: rows.length,
      oracleCallRows: rows.filter((row) => row.oracleCall.callOk).length,
      acceptedOverThresholdRows: acceptedOverThresholdRows.length,
      positiveAfterLltvRows: positiveAfterLltvRows.length,
      routePositive: routePositiveRows.length,
      executableNow: 0,
      signedActionJustified: false,
      bestBorrowEdgeBpsAfterLltv: round(rows[0]?.oracleCall.borrowEdgeBpsAfterLltv, 4),
      bestAcceptedVsPublicBps: round(rows[0]?.oracleCall.acceptedVsPublicBps, 4),
      blocker: routePositiveRows.length
        ? "Read-only value edge found; needs exact acquisition/borrow/unwind and fork proof before any escalation."
        : "No RWA Morpho candidate has accepted oracle value after LLTV haircut above public acquisition value.",
    },
    rows,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2));

  const lines = [];
  lines.push("No confirmed permissionless route-positive RWA Morpho accepted-value edge.");
  lines.push("");
  lines.push("# Critical RWA Morpho Oracle Value Review");
  lines.push("");
  lines.push(`Generated: ${artifact.generatedAt}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Candidates reviewed: ${artifact.summary.candidatesReviewed}`);
  lines.push(`- Oracle calls decoded: ${artifact.summary.oracleCallRows}`);
  lines.push(`- Accepted-over-public rows: ${artifact.summary.acceptedOverThresholdRows}`);
  lines.push(`- Positive-after-LLTV rows: ${artifact.summary.positiveAfterLltvRows}`);
  lines.push(`- Route-positive rows: ${artifact.summary.routePositive}`);
  lines.push(`- Blocker: ${artifact.summary.blocker}`);
  lines.push("");
  lines.push("## Top Rows");
  lines.push("");
  lines.push("| Producer | Loan | LLTV | Liquidity USD | Accepted/Public bps | Borrow Edge bps after LLTV | Blocker |");
  lines.push("|---|---:|---:|---:|---:|---:|---|");
  for (const row of rows.slice(0, 10)) {
    lines.push(`| ${row.producer.symbol} | ${row.loanAsset.symbol} | ${round(row.lltv * 100, 2)}% | ${round(row.liquidityAssetsUsd, 2)} | ${row.oracleCall.acceptedVsPublicBps ?? "n/a"} | ${row.oracleCall.borrowEdgeBpsAfterLltv ?? "n/a"} | ${row.blockers[0] || "none"} |`);
  }
  lines.push("");
  lines.push("## Safety");
  lines.push("");
  lines.push("- Read-only RPC calls only.");
  lines.push("- No private keys, signed actions, live transactions, or exploit execution calls.");
  lines.push("- RPC URLs were resolved in memory only and not printed or persisted.");
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, `${lines.join("\n")}\n`);

  console.log(`critical-rwa-morpho-oracle-value-review: candidates=${rows.length}; oracleCalls=${artifact.summary.oracleCallRows}; acceptedOver=${artifact.summary.acceptedOverThresholdRows}; positiveAfterLltv=${artifact.summary.positiveAfterLltvRows}; routePositive=${artifact.summary.routePositive}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
  console.log(`Report: ${path.relative(WORKSPACE, REPORT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
