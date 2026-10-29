#!/usr/bin/env node
// scan-insurance-fund-drain.js — Pattern #4: Insurance Fund Drain Detection
// Scans stability pools, GLP-style vaults, safety modules for undercollateralization
//
// UNIT-INTEGRITY FIX (2026-09-17)
// ------------------------------
// The previous coverage ratio compared
//     (native ETH balance x hardcoded ethPrice=$1600)  /  (debt-token balance treated as $1)
// i.e. an ETH-USD figure divided by a debt-token amount. That is not a like-for-like
// comparison: different asset, different price basis, and a hardcoded ETH price, which
// produced a standing CRITICAL (Liquity SP coverageRatio=0.1252, also present in the
// frozen 2026-07-03 artifact) purely because the pool holds far more LUSD than ETH.
//
// A coverage ratio now exists only when both sides are the SAME asset with the SAME
// decimals, read from the pool contract itself:
//     debtToken.balanceOf(pool)  /  getTotalLUSDDeposits()   (both LUSD, 18 decimals)
// If the pool cannot report same-asset liabilities (Gravita/Prisma revert on this
// getter), the row is emitted as UNVERIFIED and cannot promote to CRITICAL/HIGH.
//
// Native ETH held by a stability pool is seizure collateral that belongs to
// depositors; it is reported natively as `ethCollateral` and is deliberately NOT
// mixed into any coverage figure. No USD value is invented anywhere in this scanner.
const { rpcCall, resolveRpc } = require("./shared-rpc");
const fs = require("fs"); const path = require("path");

const OUT = path.join(__dirname, "..", "reports", "raw", "fast", "insurance-fund-drain.json");

// === Insurance Fund Registry ===
// (chain, address, type, label)
const FUNDS = [
  // Liquity Stability Pools
  { chain:1, addr:"0x66017D22b0f8556afDd19FC67041899Eb65a21bb", type:"StabilityPool", label:"Liquity SP (WETH)", debtToken:"0x5f98805A4E8be255a32880FDeC7F6728C6568bA0" },
  { chain:1, addr:"0x4F39F12064D83F6Dd7A2BDb0D53aF8be560356A6", type:"StabilityPool", label:"Gravita SP (WETH)", debtToken:"0x15f74458aE0bFdAA1a96CA1aa779D715Cc1Eefe4" },
  { chain:1, addr:"0xed8B26D99834540C5013701bB3715faFD39993Ba", type:"StabilityPool", label:"Prisma SP (mkUSD)", debtToken:"0x4591DBfF62656E7859Afe5e45f6f47D3669fBB28" },

  // GMX GLP — Arbitrum
  { chain:42161, addr:"0x4277f8F2c384827B5273592FF7CeBd9f2C1ac258", type:"GLP", label:"GMX GLP (Arbitrum)", debtToken:null },

  // Aave Safety Module
  { chain:1, addr:"0x4da27a545c0c5B758a6BA77e3a2C27c6fdbB896f", type:"SafetyModule", label:"Aave stkAAVE", debtToken:null },
  { chain:1, addr:"0xa1116930326D21fb917d5A27F1E9943A9595fB47", type:"SafetyModule", label:"Aave stkABPT", debtToken:null },
];

// Compound Reserve
const COMPOUND_RESERVES = [
  { chain:1, addr:"0x2775b1c31B66cCC01DdCfd4C2Ccb6E49ad5301AD", label:"Comp cUSDC Reserve" },
  { chain:1, addr:"0xe5d7c2a44FfdD6a295fE15c8A9d299f2815cDAEF", label:"Comp cETH Reserve" },
];

// Same-asset liability getters (read-only eth_call selectors, verified 2026-09-17).
//   0x9bf2f1ac = getTotalLUSDDeposits()  — Liquity StabilityPool and Liquity forks
//                 (Gravita/Prisma inherit the ABI but revert on this getter, which is
//                  recorded as UNVERIFIED rather than replaced with a guessed figure).
const LIABILITY_READ = {
  StabilityPool: { selector: "0x9bf2f1ac", name: "getTotalLUSDDeposits()" },
};

function encodeAddr(a) { return "0".repeat(24) + a.slice(2).toLowerCase(); }

async function getETHBalance(rpc, addr) {
  const raw = await rpcCall(rpc, "eth_getBalance", [addr, "latest"], 5000);
  return raw ? Number(BigInt(raw)) / 1e18 : 0;
}

async function getTokenBalance(rpc, token, holder) {
  const raw = await rpcCall(rpc, "eth_call", [{ to: token, data: "0x70a08231" + encodeAddr(holder) }, "latest"], 5000);
  if (raw && raw.length >= 66) { try { return BigInt("0x" + raw.slice(2, 66)); } catch (_) { return 0n; } }
  return 0n;
}

// uint256 view call byte-prefix read. Returns null when the call reverts or is unavailable.
async function readUint(rpc, to, selector, ms = 5000) {
  const raw = await rpcCall(rpc, "eth_call", [{ to, data: selector }, "latest"], ms);
  if (!raw || raw.length < 66) return null;
  try { return BigInt("0x" + raw.slice(2, 66)); } catch (_) { return null; }
}

async function getERC20Decimals(rpc, token) {
  const raw = await rpcCall(rpc, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"], 3000);
  // uint8 is ABI-encoded right-aligned in a 32-byte word: the value byte is hex body
  // chars [64,66) (index 0 is "0x"). The previous slice(130,132) read past the end of
  // the 66-char result, returned NaN and silently coerced every token to 18 decimals.
  if (raw && raw.length >= 66) {
    const d = parseInt(raw.slice(64, 66), 16);
    if (Number.isInteger(d) && d >= 0 && d <= 36) return d;
  }
  return null; // unknown — caller must not assume 18
}

function scale(raw, decimals) {
  if (decimals === null || raw === undefined) return null;
  return Number(raw) / 10 ** decimals;
}

async function getGLPTotalAssets(rpc, glp) {
  // GLP: totalAssets() or aum() — common selectors; result is 18-decimal USD
  const sels = ["0x0aae7a28", "0xe1b1e3c0", "0x01e1d114"];
  for (const sel of sels) {
    const raw = await rpcCall(rpc, "eth_call", [{ to: glp, data: sel }, "latest"], 5000);
    if (raw && raw.length >= 66 && raw.slice(2, 66) !== "0".repeat(64)) {
      return Number(BigInt("0x" + raw.slice(2, 66))) / 1e18;
    }
  }
  return null;
}

async function scanFund(rpc, fund) {
  const r = {
    ...fund,
    ethCollateral: null,          // native ETH held by the fund (units: ETH) — informational only
    tokenBals: {},                // whole-token balances, only when decimals are known
    tokenBalsRaw: {},
    debtDecimals: null,
    reportedLiabilities: null,    // same-asset liability figure read from the fund contract
    reportedLiabilitiesRaw: null,
    liabilitySource: null,
    coverageRatio: null,
    coverageVerified: false,
    coverageBasis: "not-evaluated",
    usdValuation: "not-computed (no in-scanner price oracle)",
    risk: "UNKNOWN",
  };

  // 1. Native ETH balance (collateral the pool holds; never used as an ETH-vs-LUSD ratio)
  r.ethCollateral = await getETHBalance(rpc, fund.addr);

  // 2. Debt-token balance held by the fund, scaled with the token's real decimals
  if (fund.type === "StabilityPool" && fund.debtToken) {
    r.debtDecimals = await getERC20Decimals(rpc, fund.debtToken);
    const balRaw = await getTokenBalance(rpc, fund.debtToken, fund.addr);
    r.tokenBalsRaw.debtToken = balRaw.toString();
    r.tokenBals.debtToken = scale(balRaw, r.debtDecimals);
  }

  // 3. GLP: read total AUM (already a USD figure reported by the vault itself)
  if (fund.type === "GLP") {
    const aum = await getGLPTotalAssets(rpc, fund.addr);
    r.glpAumUsd = aum && aum < 1e12 ? aum : null;
  }

  // 4. Safety Modules: read the staked underlying in native units (no hardcoded price)
  if (fund.type === "SafetyModule") {
    const underlying = await rpcCall(rpc, "eth_call", [{ to: fund.addr, data: "0x82e37f49" }, "latest"], 5000);
    if (underlying && underlying.length >= 66) {
      const uAddr = "0x" + underlying.slice(26, 66);
      if (uAddr !== "0x" + "0".repeat(40)) {
        const uDec = await getERC20Decimals(rpc, uAddr);
        const uBalRaw = await getTokenBalance(rpc, uAddr, fund.addr);
        r.tokenBalsRaw.stakedUnderlying = uBalRaw.toString();
        r.tokenBals.stakedUnderlying = scale(uBalRaw, uDec);
      } else {
        r.underlyingReadStatus = "zero-address";
      }
    } else {
      r.underlyingReadStatus = "no-response";
    }
    r.risk = "INFO — safety-module backing not compared (no same-asset liability getter in registry)";
  }

  // 5. Coverage check — same asset, same decimals, or no coverage claim at all.
  if (fund.type === "StabilityPool" && fund.debtToken) {
    const spec = LIABILITY_READ.StabilityPool;
    const liabilitiesRaw = await readUint(rpc, fund.addr, spec.selector);
    const balRaw = r.tokenBalsRaw.debtToken !== undefined ? BigInt(r.tokenBalsRaw.debtToken) : null;

    if (liabilitiesRaw !== null && liabilitiesRaw > 0n && balRaw !== null) {
      r.reportedLiabilitiesRaw = liabilitiesRaw.toString();
      r.liabilitySource = spec.name;
      r.reportedLiabilities = scale(liabilitiesRaw, r.debtDecimals);
      // Integer milli-ratio to avoid float drift on 18-decimal balances.
      r.coverageRatio = Number((balRaw * 1_000_000n) / liabilitiesRaw) / 1e6;
      r.coverageVerified = true;
      r.coverageBasis = "debtToken.balanceOf(pool) / " + spec.name + " — same token, same decimals";
      r.risk = r.coverageRatio >= 0.999 ? "LOW — same-asset liabilities fully backed"
             : r.coverageRatio >= 0.99  ? "MEDIUM — small same-asset shortfall vs reported liabilities"
             : r.coverageRatio >= 0.95  ? "HIGH — pool debt-token balance below reported liabilities"
             : "CRITICAL — pool debt-token balance materially below reported liabilities";
    } else {
      r.risk = "UNVERIFIED — same-asset liability read (" + spec.name + ") unavailable; no coverage claim made";
    }
  }

  return r;
}

async function main() {
  console.log("=== Insurance Fund Drain Scanner (Pattern #4) ===\n");

  const results = [];
  // Cache RPCs per chain
  const rpcs = {};

  for (const fund of FUNDS) {
    if (!rpcs[fund.chain]) {
      rpcs[fund.chain] = await resolveRpc(fund.chain);
      if (!rpcs[fund.chain]) { results.push({ ...fund, error:"no-rpc" }); continue; }
    }
    console.log(fund.label + " (" + fund.addr.slice(0,10) + "..." + ")...");
    const r = await scanFund(rpcs[fund.chain], fund);
    results.push(r);

    const eth = r.ethCollateral ? r.ethCollateral.toFixed(4) + " ETH collateral" : "0 ETH collateral";
    const tok = r.tokenBals.debtToken !== undefined && r.tokenBals.debtToken !== null
      ? " | debtToken=" + r.tokenBals.debtToken.toFixed(2) : "";
    console.log("  " + eth + tok + " | usd=" + r.usdValuation);
    console.log("  Coverage: " + (r.coverageRatio !== null ? r.coverageRatio.toFixed(6) : "N/A")
      + " | verified=" + r.coverageVerified + " | Risk: " + r.risk);
  }

  // Compound reserves
  if (!rpcs[1]) rpcs[1] = await resolveRpc(1);
  if (rpcs[1]) {
    for (const cr of COMPOUND_RESERVES) {
      const eth = await getETHBalance(rpcs[1], cr.addr);
      results.push({
        ...cr,
        ethCollateral: eth,
        type: "CompoundReserve",
        coverageVerified: false,
        coverageBasis: "not-evaluated (reserve size only)",
        risk: "INFO — reserve size only; no coverage comparison performed",
      });
      console.log(cr.label + ": " + eth.toFixed(4) + " ETH");
    }
  }

  // Summary
  const critical = results.filter(r => r.risk?.startsWith("CRITICAL"));
  const high = results.filter(r => r.risk?.startsWith("HIGH"));
  const unverified = results.filter(r => r.risk?.startsWith("UNVERIFIED"));
  console.log("\n=== Summary ===");
  console.log("CRITICAL: " + critical.length + " | HIGH: " + high.length + " | UNVERIFIED: " + unverified.length);
  console.log("Funds scanned: " + results.length);

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), results, critical, high, unverified }, null, 2));
  console.log("Artifact: " + OUT);
}
main().catch(e => { console.error(e.message); process.exit(1); });
