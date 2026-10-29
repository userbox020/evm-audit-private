#!/usr/bin/env node
// Phase 2+3: Kamino Borrow Liquidity + Status-Flag Divergence Scanner
// Fetches all obligations, aggregates per-reserve borrow data,
// cross-references with oracle config, detects reduced-status windows.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "kamino-borrow-divergence.json");
const ORACLE_CONFIG = path.join(WORKSPACE, "reports", "raw", "fast", "kamino-oracle-config.json");
const QUIET = process.argv.includes("--quiet");

const PROGRAM_ID = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const RESERVE_SIZE = 8 + 8616;
const OBLIGATION_SIZE = 8 + 3336;
const MARKET_OFFSET = 32;

// Price status flags
const PRICE_LOADED = 0x01, PRICE_AGE_CHECKED = 0x02, TWAP_CHECKED = 0x04;
const TWAP_AGE_CHECKED = 0x08, HEURISTIC_CHECKED = 0x10, PRICE_USAGE_ALLOWED = 0x20;
const ALL_CHECKS = PRICE_LOADED | PRICE_AGE_CHECKED | TWAP_CHECKED | TWAP_AGE_CHECKED | HEURISTIC_CHECKED | PRICE_USAGE_ALLOWED;
const LIQUIDATION_CHECKS = PRICE_LOADED | PRICE_AGE_CHECKED | PRICE_USAGE_ALLOWED;

// Obligation account offsets
const DEPOSIT_SLOT_SIZE = 136, BORROW_SLOT_SIZE = 200;
const DEPOSITS_OFFSET = 96;
const BORROWS_OFFSET = DEPOSITS_OFFSET + 8 * DEPOSIT_SLOT_SIZE + 8 + 16;
const DEBT_VALUE_OFFSET = BORROWS_OFFSET + 5 * BORROW_SLOT_SIZE + 16;
const UNHEALTHY_VALUE_OFFSET = DEBT_VALUE_OFFSET + 16;

const ZERO_PUBKEY = "11111111111111111111111111111111";

function loadSolanaUrls() {
  const f = path.join(WORKSPACE, "rpc_endpoints.txt");
  if (!fs.existsSync(f)) return [];
  return [...fs.readFileSync(f,"utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m=>m[0]).filter(u=>u.toLowerCase().includes("solana")||u.toLowerCase().includes("helius"));
}

async function tryRpc(method, params = [], ms = 15000) {
  for (const url of loadSolanaUrls()) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
      const h = {"content-type":"application/json"};
      if (url.toLowerCase().includes("helius")) h["Origin"] = "https://helius.xyz";
      const res = await fetch(url, {method:"POST",headers:h,body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),signal:c.signal});
      const j = await res.json();
      clearTimeout(t);
      if (!j.error && j.result !== undefined && j.result !== null) {
        // For getProgramAccounts, require non-empty accounts
        if (method === "getProgramAccounts") {
          const arr = Array.isArray(j.result) ? j.result : j.result?.value;
          if (!arr || arr.length === 0) continue; // skip stale/empty responses
        }
        return j.result;
      }
    } catch (_) { clearTimeout(t); }
  }
  throw new Error("No Solana RPC endpoint available");
}

// Legacy wrapper
async function rpc(_url, method, params = []) { return tryRpc(method, params); }

function adata(entry) {
  const raw = entry.account?.data;
  if (!raw) return null;
  const b = Array.isArray(raw) ? raw[0] : raw;
  return Buffer.from(typeof b === "string" ? b : String(b), "base64");
}

function pubkeyAt(buf, offset) {
  const bytes = buf.slice(offset, offset + 32);
  if (bytes.every(b => b === 0)) return ZERO_PUBKEY;
  return bs58(bytes);
}

function bs58(buf) {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let digits = [0];
  for (const b of buf) { let carry = b; for (let i = 0; i < digits.length; i++) { carry += digits[i] * 256; digits[i] = carry % 58; carry = Math.floor(carry / 58); } while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); } }
  let r = ""; for (const d of digits.reverse()) r += A[d];
  for (const b of buf) { if (b === 0) r = "1" + r; else break; }
  return r;
}

function sfAt(buf, offset) { return Number(buf.readBigInt64LE(offset)) / 2**60; }

function rU64(buf, offset) { return buf.readBigUInt64LE(offset); }

function hasLiquidationChecks(s) { return (s & LIQUIDATION_CHECKS) === LIQUIDATION_CHECKS; }
function hasAllChecks(s) { return (s & ALL_CHECKS) === ALL_CHECKS; }
function isReducedLiquidationStatus(s) { return s !== 0 && hasLiquidationChecks(s) && !hasAllChecks(s); }

async function main() {
  // rpc() uses multi-endpoint tryRpc internally
  const rpcUrl = null;
  const testSlot = await rpc(rpcUrl, "getSlot", []);
  if (testSlot == null) { console.error("No Solana RPC"); process.exit(1); }
  console.error(`Slot: ${testSlot}`);

  // Fetch reserves for price status snapshot
  const reserves = await rpc(rpcUrl, "getProgramAccounts", [PROGRAM_ID, {
    encoding: "base64",
    filters: [{ dataSize: RESERVE_SIZE }, { memcmp: { offset: MARKET_OFFSET, bytes: MAIN_MARKET } }],
  }]);
  console.error(`Reserves raw: ${Array.isArray(reserves) ? reserves.length : "not array"}`);

  const reserveInfo = new Map();
  const curSlot = Number(testSlot);
  console.error(`Current slot: ${curSlot}`);
  let sameSlotReducedReserves = 0;

  for (const entry of reserves) {
    const data = adata(entry);
    if (!data) continue;
    const status = data.readUInt8(25);
    const slot = Number(rU64(data, 16));
    const name = (() => { let s = ""; for (let i = 0; i < 32 && data[4856+176+i]; i++) s += String.fromCharCode(data[4856+176+i]); return s.trim(); })();
    reserveInfo.set(entry.pubkey, { name, status, slot, reduced: isReducedLiquidationStatus(status), slotAge: curSlot - slot });
    if (slot === curSlot && isReducedLiquidationStatus(status)) sameSlotReducedReserves++;
  }

  // Fetch obligations
  const obligations = await rpc(rpcUrl, "getProgramAccounts", [PROGRAM_ID, {
    encoding: "base64",
    filters: [{ dataSize: OBLIGATION_SIZE }, { memcmp: { offset: MARKET_OFFSET, bytes: MAIN_MARKET } }],
  }]);

  const perReserveBorrow = new Map();
  const perReserveDeposit = new Map();
  let debtObligations = 0, reducedStatusObligations = 0, sameSlotLiquidatable = 0, sameSlotReduced = 0;
  const watchCandidates = [];

  for (const entry of obligations) {
    const data = adata(entry);
    if (!data) continue;
    const slot = Number(rU64(data, 16));
    const status = data.readUInt8(25);
    const debt = sfAt(data, DEBT_VALUE_OFFSET);
    const unhealthy = sfAt(data, UNHEALTHY_VALUE_OFFSET);
    if (debt <= 0 || unhealthy <= 0) continue;
    debtObligations++;

    // Collect borrow details
    for (let i = 0; i < 5; i++) {
      const off = BORROWS_OFFSET + i * BORROW_SLOT_SIZE;
      const res = pubkeyAt(data, off);
      if (res === ZERO_PUBKEY) continue;
      const val = sfAt(data, off + 104);
      const cur = perReserveBorrow.get(res) || { count: 0, totalUsd: 0 };
      cur.count++; cur.totalUsd += val;
      perReserveBorrow.set(res, cur);
    }
    // Collect deposit details
    for (let i = 0; i < 8; i++) {
      const off = DEPOSITS_OFFSET + i * DEPOSIT_SLOT_SIZE;
      const res = pubkeyAt(data, off);
      if (res === ZERO_PUBKEY) continue;
      const val = sfAt(data, off + 40);
      const cur = perReserveDeposit.get(res) || { count: 0, totalUsd: 0 };
      cur.count++; cur.totalUsd += val;
      perReserveDeposit.set(res, cur);
    }

    const oblReduced = isReducedLiquidationStatus(status);
    const slotAge = curSlot - slot;
    const sameSlot = slotAge === 0 && hasLiquidationChecks(status);
    const anyReserveReduced = (() => {
      for (let i = 0; i < 5; i++) {
        const r = pubkeyAt(data, BORROWS_OFFSET + i * BORROW_SLOT_SIZE);
        if (r === ZERO_PUBKEY) continue;
        const info = reserveInfo.get(r);
        if (info && (info.slot === curSlot) && isReducedLiquidationStatus(info.status)) return true;
      }
      return false;
    })();
    const thisReduced = sameSlot && (oblReduced || anyReserveReduced);
    const thisLiquidatable = sameSlot && debt > unhealthy;

    if (oblReduced) reducedStatusObligations++;
    if (thisReduced) sameSlotReduced++;
    if (thisLiquidatable) sameSlotLiquidatable++;
    if (thisReduced && thisLiquidatable) {
      watchCandidates.push({
        pubkey: entry.pubkey,
        owner: pubkeyAt(data, 64),
        debt: debt.toFixed(2),
        unhealthy: unhealthy.toFixed(2),
        slot, slotAge,
        obligationStatus: status,
        obligationReduced: oblReduced,
        reserveReduced: anyReserveReduced,
      });
    }
  }

  // Build per-reserve summary
  const borrowSummary = [];
  for (const [pubkey, data] of perReserveBorrow) {
    const info = reserveInfo.get(pubkey);
    const dep = perReserveDeposit.get(pubkey);
    borrowSummary.push({
      pubkey, symbol: info?.name || "?", borrowCount: data.count, borrowUsd: data.totalUsd.toFixed(2),
      depositCount: dep?.count || 0, depositUsd: (dep?.totalUsd || 0).toFixed(2),
      status: info?.status || 0, slotAge: info?.slotAge || null,
      reduced: info?.reduced || false,
    });
  }
  borrowSummary.sort((a, b) => Number(b.borrowUsd) - Number(a.borrowUsd));

  // Cross-reference with oracle config
  let oracleConfig = null;
  try { oracleConfig = JSON.parse(fs.readFileSync(ORACLE_CONFIG, "utf8")); } catch (_) {}
  const configByKey = new Map();
  if (oracleConfig?.reserves) for (const r of oracleConfig.reserves) configByKey.set(r.pubkey, r);

  // Identify reserves with TWAP disabled or stale-age risk
  const twapDisabledReserves = [];
  const staleAgeRiskReserves = [];
  for (const [pubkey, info] of reserveInfo) {
    const cfg = configByKey.get(pubkey);
    if (cfg && cfg.twap.max_divergence_bps === 0) twapDisabledReserves.push({ pubkey, name: info.name });
    if (cfg && info.slotAge > 600) staleAgeRiskReserves.push({ pubkey, name: info.name, age: info.slotAge });
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-kamino-borrow-divergence.js",
    scope: "Read-only Kamino borrow liquidity + status-flag divergence scan (Phases 2+3 of 4)",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, signedActions: false, exploitExecuteCalls: false, routePositive: false },
    summary: {
      currentSlot: curSlot,
      reserves: reserves.length,
      obligations: obligations.length,
      debtObligations,
      reducedStatusObligations,
      sameSlotReduced,
      sameSlotLiquidatable,
      sameSlotReducedReserves,
      watchCandidates: watchCandidates.length,
      twapDisabledReserves: twapDisabledReserves.length,
      staleAgeRiskReserves: staleAgeRiskReserves.length,
      routePositive: 0,
    },
    perReserveBorrow: borrowSummary,
    watchCandidates: watchCandidates.slice(0, 50),
    twapDisabledReserves: twapDisabledReserves.slice(0, 30),
    staleAgeRiskReserves: staleAgeRiskReserves.slice(0, 30),
    nextSteps: [
      "sameSlotLiquidatable>0 with live TWAP-aged reserves = fork/live candidate (Phase 4)",
      "staleAgeRiskReserves = reserves with price refresh older than 600 slots (~4 min) — oracle lag risk",
      "Phase 4: Jupiter quote API modeling of exact liquidation profitability for watch candidates",
    ],
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Kamino borrow+divergence: reserves=${reserves.length} obligations=${obligations.length} debt=${debtObligations} reduced=${sameSlotReduced} liquidatable=${sameSlotLiquidatable} watchCandidates=${watchCandidates.length} twapOff=${twapDisabledReserves.length}`);
}
main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
