#!/usr/bin/env node
// Read-only Compound V3 Comet accounting invariant drift scanner.
// Checks basic accounting invariants for known Compound V3 Comet contracts
// on Ethereum and Base via direct RPC eth_call (no ethers dependency).
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { resolveRpc, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "compound-invariant-drift.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "compound-invariant-drift.md");
const QUIET = process.argv.includes("--quiet");

// Known Compound V3 Comet addresses
const COMETS = {
  1: [
    "0xc3d688B66703497DAA19211EEdff47f25384cdc3", // cUSDCv3
    "0xA17581A9E3356d9A858b789D68B4d866e593aE94", // cWETHv3
  ],
  8453: [
    "0xb125E6687d4313864e53df431d5425969c15Eb2F", // cUSDCv3
    "0x46e6b214b524310239732D51387075E0e70970bf", // cWETHv3
  ],
};

// Chain names
const CHAIN_NAMES = {
  1: "Ethereum",
  8453: "Base",
};

// Known base token address -> metadata mapping
const KNOWN_TOKENS = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", decimals: 18 },
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6 },
  "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
};

// Function selectors (keccak256 first 4 bytes, hardcoded)
// Selectors verified via ethers.id() from keccak256 of function signatures:
//   totalSupply()     -> 0x18160ddd  (matches spec)
//   totalBorrow()     -> 0x8285ef40  (spec had 0x98ad795a — corrected)
//   getReserves()     -> 0x0902f1ac  (spec had 0x658f5d69 — corrected)
//   baseToken()       -> 0xc55dae63  (matches spec)
//   balanceOf(address) -> 0x70a08231 (matches spec)
const TOTAL_SUPPLY_SEL = "0x18160ddd";
const TOTAL_BORROW_SEL = "0x8285ef40";
const GET_RESERVES_SEL = "0x0902f1ac";
const BASE_TOKEN_SEL = "0xc55dae63";
const BALANCE_OF_SEL = "0x70a08231";

const RPC_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanHex(str) {
  if (!str) return str;
  str = String(str).trim().toLowerCase();
  if (str.startsWith("0x")) return str;
  return "0x" + str;
}

function padTo32Bytes(hexStr) {
  hexStr = hexStr.replace(/^0x/, "");
  return hexStr.padStart(64, "0");
}

function encodeCall(selector, args) {
  let data = cleanHex(selector);
  for (const arg of args) {
    data += padTo32Bytes(arg.replace(/^0x/, ""));
  }
  return data;
}

function decodeWords(resultHex) {
  if (!resultHex || resultHex === "0x") return [];
  const hex = resultHex.replace(/^0x/, "");
  const words = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) {
    words.push("0x" + hex.slice(i, i + 64));
  }
  return words;
}

function wordToAddress(word) {
  const hex = word.replace(/^0x/, "");
  return "0x" + hex.slice(24);
}

// Convert a BigInt from unsigned 256-bit hex decoding to signed int256
function fromSigned256(val) {
  if (val >> 255n) {
    return val - (1n << 256n);
  }
  return val;
}

function fmtBigInt(bn) {
  if (bn === null || bn === undefined) return "0";
  return bn.toString();
}

function round(value, decimals) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = Math.pow(10, decimals ?? 4);
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// RPC calls
// ---------------------------------------------------------------------------

// Generic eth_call to a Comet that returns a raw hex value (for uint256)
async function callComet(rpc, cometAddr, selector) {
  const raw = await rpcCall(rpc, "eth_call", [{ to: cometAddr, data: selector }, "latest"], RPC_TIMEOUT_MS);
  if (!raw || raw === "0x") return null;
  return BigInt(raw);
}

// eth_call to a Comet that returns an address (like baseToken())
async function callCometAddress(rpc, cometAddr, selector) {
  const raw = await rpcCall(rpc, "eth_call", [{ to: cometAddr, data: selector }, "latest"], RPC_TIMEOUT_MS);
  if (!raw || raw === "0x") return null;
  const words = decodeWords(raw);
  if (words.length < 1) return null;
  return wordToAddress(words[0]);
}

// Read ERC20 balanceOf(ownerAddr) on the token contract
async function readTokenBalance(rpc, tokenAddr, ownerAddr) {
  const data = BALANCE_OF_SEL + padTo32Bytes(ownerAddr.replace(/^0x/, ""));
  const raw = await rpcCall(rpc, "eth_call", [{ to: tokenAddr, data }, "latest"], RPC_TIMEOUT_MS);
  if (!raw || raw === "0x") return null;
  return BigInt(raw);
}

// Resolve token metadata from known addresses
function getTokenInfo(baseToken) {
  const key = baseToken.toLowerCase();
  const known = KNOWN_TOKENS[key];
  if (known) return known;
  return { symbol: "?", decimals: 18 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const chainIds = Object.keys(COMETS).map(Number);

  if (!QUIET) console.log("Resolving RPC endpoints...");
  const rpcPool = {};
  for (const chainId of chainIds) {
    const rpc = await resolveRpc(chainId);
    if (!rpc) {
      console.error(`WARN: No RPC available for chainId ${chainId} (${CHAIN_NAMES[chainId] || "?"})`);
      continue;
    }
    rpcPool[chainId] = rpc;
  }

  if (Object.keys(rpcPool).length === 0) {
    console.error("FATAL: No RPC available for any chain");
    process.exit(1);
  }

  const rows = [];

  for (const [chainIdStr, rpc] of Object.entries(rpcPool)) {
    const chainId = Number(chainIdStr);
    const comets = COMETS[chainId];
    const chainName = CHAIN_NAMES[chainId] || `Chain ${chainId}`;

    if (!QUIET) console.log(`\nScanning ${chainName} (${comets.length} Comets)...`);

    for (const cometAddr of comets) {
      const addr = cleanHex(cometAddr);
      if (!QUIET) console.log(`  ${addr.slice(0, 10)}...`);

      // Read all Comet state via eth_call
      const totalSupply = await callComet(rpc, addr, TOTAL_SUPPLY_SEL);
      const totalBorrow = await callComet(rpc, addr, TOTAL_BORROW_SEL);
      const reservesRaw = await callComet(rpc, addr, GET_RESERVES_SEL);
      const baseToken = await callCometAddress(rpc, addr, BASE_TOKEN_SEL);

      if (totalSupply === null) {
        if (!QUIET) console.log(`    SKIP: totalSupply() failed`);
        continue;
      }

      // getReserves() returns int256 — convert from unsigned BigInt to signed
      const reserves = reservesRaw !== null ? fromSigned256(reservesRaw) : null;

      // Read Comet's token balance from the base token contract
      const cometTokenBalance = (baseToken && totalSupply !== null)
        ? await readTokenBalance(rpc, baseToken, addr)
        : null;

      const tokenInfo = getTokenInfo(baseToken || "0x");

      // ------------------------------------------------------------------
      // Invariant checks
      // ------------------------------------------------------------------

      // Check 1: totalSupply >= totalBorrow
      const supplyGteBorrow = (totalSupply !== null && totalBorrow !== null)
        ? totalSupply >= totalBorrow
        : null;

      // Check 2: balanceOf(Comet) >= (totalSupply - totalBorrow) within 0.5% tolerance
      let tokenBalCoversNetSupply = null;
      if (cometTokenBalance !== null && totalSupply !== null && totalBorrow !== null) {
        const netSupply = totalSupply - totalBorrow;
        if (netSupply > 0n) {
          const shortfall = netSupply > cometTokenBalance ? netSupply - cometTokenBalance : 0n;
          const pct = Number(shortfall) / Number(netSupply);
          tokenBalCoversNetSupply = pct <= 0.005;
        } else {
          // No net supply to cover, vacuously true
          tokenBalCoversNetSupply = true;
        }
      }

      // Check 3: reserves >= 0
      const reservesNonNegative = reserves !== null ? reserves >= 0n : null;

      // Check 4 (informational): totalSupply > 0
      const nonZeroSupply = totalSupply > 0n;

      // Aggregate
      const checks = {
        supplyGteBorrow,
        tokenBalCoversNetSupply,
        reservesNonNegative,
        nonZeroSupply,
      };

      const invariantViolation = supplyGteBorrow === false
        || tokenBalCoversNetSupply === false
        || reservesNonNegative === false;

      const row = {
        chain: chainName,
        chainId,
        comet: addr,
        baseToken: baseToken || null,
        baseTokenSymbol: baseToken ? tokenInfo.symbol : "?",
        totalSupply: fmtBigInt(totalSupply),
        totalBorrow: fmtBigInt(totalBorrow),
        reserves: fmtBigInt(reserves),
        cometTokenBalance: fmtBigInt(cometTokenBalance),
        checks,
        invariantViolation,
      };

      rows.push(row);

      if (!QUIET) {
        const status = invariantViolation ? "⚠️  VIOLATION" : "✅ OK";
        console.log(`    ${status} supply=${row.totalSupply} borrow=${row.totalBorrow} reserves=${row.reserves} tokenBal=${row.cometTokenBalance}`);
      }
    }
  }

  // Summary statistics
  const supplyBorrowViolations = rows.filter(r => r.checks.supplyGteBorrow === false).length;
  const tokenBalanceViolations = rows.filter(r => r.checks.tokenBalCoversNetSupply === false).length;
  const negativeReserves = rows.filter(r => r.checks.reservesNonNegative === false).length;
  const totalViolations = rows.filter(r => r.invariantViolation).length;

  const summary = {
    cometsChecked: rows.length,
    supplyBorrowViolations,
    tokenBalanceViolations,
    negativeReserves,
    routePositive: 0,
    executableNow: false,
    signedActionJustified: false,
    status: totalViolations > 0 ? "violations-detected" : "all-invariants-pass",
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-compound-v3-invariant-drift.js",
    scope: "Read-only Compound V3 Comet accounting invariant drift scanner",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    summary,
    rows,
  };

  // Write JSON report
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");

  // Write Markdown report
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));

  if (!QUIET) {
    console.log(`\nCompound V3 Invariant Drift: cometsChecked=${summary.cometsChecked} supplyBorrowViolations=${summary.supplyBorrowViolations} tokenBalanceViolations=${summary.tokenBalanceViolations} negativeReserves=${summary.negativeReserves}`);
    console.log(`JSON: ${path.relative(WORKSPACE, OUT)}`);
    console.log(`MD:   ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

function renderReport(artifact) {
  const s = artifact.summary;
  const rows = artifact.rows;

  const violationRows = rows.filter(r => r.invariantViolation);

  let tableBody = "";
  if (rows.length === 0) {
    tableBody = "| No comets inspected | - | - | - | - | - | - | - |";
  } else {
    tableBody = rows.map(row => {
      const flags = [];
      if (row.checks.supplyGteBorrow === false) flags.push("🚨 SUPPLY<BORROW");
      if (row.checks.tokenBalCoversNetSupply === false) flags.push("🚨 BAL<NET");
      if (row.checks.reservesNonNegative === false) flags.push("🚨 NEG_RESERVES");
      if (row.checks.supplyGteBorrow === null) flags.push("⚠️  NO_SUPPLY");
      if (row.checks.tokenBalCoversNetSupply === null) flags.push("⚠️  NO_BAL");
      if (row.checks.reservesNonNegative === null) flags.push("⚠️  NO_RESERVES");
      const flagStr = flags.length > 0 ? flags.join(" ") : "✅";
      return `| ${row.chain} | ${row.comet.slice(0, 10)}... | ${row.baseTokenSymbol} | ${row.totalSupply} | ${row.totalBorrow} | ${row.reserves} | ${row.cometTokenBalance} | ${row.invariantViolation ? "⚠️" : "✅"} | ${flagStr} |`;
    }).join("\n");
  }

  let violationSection = "";
  if (violationRows.length > 0) {
    violationSection = [
      "",
      "## Violations",
      "",
      "| Chain | Comet | Base Token | Issue |",
      "| --- | --- | --- | --- |",
      ...violationRows.slice(0, 50).map(row => {
        const issues = [];
        if (row.checks.supplyGteBorrow === false) issues.push("Supply < Borrow (invariant broken)");
        if (row.checks.tokenBalCoversNetSupply === false) issues.push("Token balance < net supply (0.5% tolerance breached)");
        if (row.checks.reservesNonNegative === false) issues.push("Negative reserves (bad debt > reserves)");
        return `| ${row.chain} | ${row.comet.slice(0, 10)}... | ${row.baseTokenSymbol} | ${issues.join("; ")} |`;
      }).join("\n"),
    ].join("\n");
  }

  return [
    "# 🟢 DORMANT — Compound V3 Comet Accounting Invariant Drift",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    s.supplyBorrowViolations > 0 || s.tokenBalanceViolations > 0 || s.negativeReserves > 0
      ? "**⚠️ Violations detected.** Invariant breaks or token balance gaps found. See table below."
      : "**✅ All invariants pass.** No accounting drift or token balance shortfall found.",
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Comets checked | ${s.cometsChecked} |`,
    `| Supply < Borrow violations | ${s.supplyBorrowViolations} |`,
    `| Token balance coverage violations | ${s.tokenBalanceViolations} |`,
    `| Negative reserves | ${s.negativeReserves} |`,
    `| Route-positive | ${s.routePositive} |`,
    "",
    "## Invariant Checks",
    "",
    "| # | Check | Description | Severity |",
    "| --- | --- | --- | --- |",
    "| 1 | Supply >= Borrow | totalSupply >= totalBorrow | VIOLATION if false |",
    "| 2 | Token balance covers net supply | balanceOf(Comet) >= (totalSupply - totalBorrow) within 0.5% | VIOLATION if false |",
    "| 3 | Reserves non-negative | getReserves >= 0 | VIOLATION if false |",
    "",
    violationSection,
    "",
    "## Comet Inspection Table",
    "",
    "| Chain | Comet | Base | Supply | Borrow | Reserves | Token Balance | Status | Flags |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    tableBody,
    "",
    "## Gate",
    "",
    "Escalation from watch to active requires:",
    "",
    "1. **An invariant break** — a supply/borrow violation, negative reserves, or token balance shortfall confirmed on-chain",
    "2. **Material borrow liquidity** — the affected comet has >$10k extractable borrow-side value",
    "3. **Exact extractive economics** — a concrete route (borrow + swap + repay) shows positive net value after gas and slippage",
    "4. **Fork proof** — a local fork simulation reproduces the invariant break and shows extractable value with no revert",
    "",
    "Until all four gates pass, the finding remains dormant / route-negative.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/compound-invariant-drift.json`",
    "- Scanner: `tools/scan-compound-v3-invariant-drift.js`",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
