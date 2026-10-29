#!/usr/bin/env node
// No-key Solana liquidation watcher for E47.
// Writes reports/monitor/solana-status.json without loading or printing key material.

const fs = require("fs");
const path = require("path");
const {
  loadDotEnv,
  resolveRpcUrls,
  scanOnce: scanKaminoOnce,
  formatNumber,
} = require("../targets/kamino-klend/live-liquidation-executor.js");

const WORKSPACE = path.resolve(__dirname, "..");
const STATUS_FILE = path.join(WORKSPACE, "reports", "monitor", "solana-status.json");
const MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const MARGINFI_PROGRAM = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";

const INTERVAL_MS = Number(process.env.SOLANA_WATCH_INTERVAL_MS || "15000");
const MARGINFI_SAMPLE_LIMIT = Number(process.env.MARGINFI_SAMPLE_LIMIT || "50000");
const MARGINFI_HEALTH_MAX_AGE_SECONDS = Number(process.env.MARGINFI_HEALTH_MAX_AGE_SECONDS || "120");
const ONCE_MODE = process.argv.includes("--once");
const SKIP_MARGINFI = process.argv.includes("--skip-marginfi");

function ts() { return new Date().toISOString(); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function jsonOutPath() {
  const idx = process.argv.indexOf("--json-out");
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : STATUS_FILE;
}

function rpcHeaders(url) {
  const headers = { "content-type": "application/json" };
  if (/helius/i.test(url)) headers.Origin = "https://helius.xyz";
  return headers;
}

async function rpc(url, method, params, timeoutMs = 30000) {
  const resp = await fetch(url, {
    method: "POST",
    headers: rpcHeaders(url),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`${method} HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.error) throw new Error(`${method} RPC ${json.error.code}: ${json.error.message}`);
  return json.result;
}

async function tryRpc(urls, method, params, timeoutMs = 30000) {
  let lastError = null;
  for (const url of urls) {
    try { return await rpc(url, method, params, timeoutMs); }
    catch (error) { lastError = error; }
  }
  throw lastError || new Error(`${method} failed on all RPCs`);
}

function i80f48(data, offset) {
  let v = 0n;
  for (let i = offset + 15; i >= offset; i--) v = (v << 8n) | BigInt(data[i]);
  const negative = ((v >> 127n) & 1n) === 1n;
  const magnitude = negative ? ((~v + 1n) & ((1n << 128n) - 1n)) : v;
  return Number(magnitude) / 2 ** 48 * (negative ? -1 : 1);
}

function sanitizeKaminoCandidate(row) {
  return {
    obligation: row.pubkey,
    owner: row.owner,
    collateral: row.collateral,
    debtAsset: row.debtAsset,
    repayValueApproxUsd: Number(formatNumber(row.repayValue)),
    bonusBps: row.bonusBps,
    protocolFeePct: row.protocolFeePct,
    approxBonusValueUsd: Number(formatNumber(row.approxBonusValue)),
    slotAge: row.slotAge,
  };
}

async function scanKamino(urls, market) {
  let lastError = null;
  for (const url of urls) {
    try {
      const scan = await scanKaminoOnce(url, market);
      return {
        status: "ok",
        checkedAt: ts(),
        currentSlot: scan.currentSlot,
        reserves: scan.reserves,
        obligations: scan.obligations,
        debtRows: scan.debtRows,
        sameSlotReducedReserves: scan.sameSlotReducedReserves,
        staleReducedRows: scan.staleReducedRows,
        sameSlotReducedRows: scan.sameSlotReducedRows,
        sameSlotLiquidatableRows: scan.sameSlotLiquidatableRows,
        liquidatable: scan.candidates.length,
        executableCandidates: scan.candidates.slice(0, 5).map(sanitizeKaminoCandidate),
        historicalReducedLiquidatableRows: scan.historicalReducedLiquidatableRows || 0,
      };
    } catch (error) {
      lastError = error;
    }
  }
  return { status: "error", checkedAt: ts(), error: lastError?.message || "Kamino scan failed", liquidatable: 0, executableCandidates: [] };
}

async function scanMarginfiObserved(urls) {
  if (SKIP_MARGINFI) {
    return {
      status: "skipped",
      checkedAt: ts(),
      banks: 0,
      accounts: 0,
      decoded: 0,
      observedUnhealthy: 0,
      recomputedLiquidatable: 0,
      executableCandidates: [],
      note: "Skipped by --skip-marginfi",
    };
  }

  const [banks, accounts] = await Promise.all([
    tryRpc(urls, "getProgramAccounts", [MARGINFI_PROGRAM, {
      encoding: "base64",
      filters: [{ dataSize: 1864 }],
      dataSlice: { offset: 0, length: 0 },
    }], 30000).catch(() => []),
    tryRpc(urls, "getProgramAccounts", [MARGINFI_PROGRAM, {
      encoding: "base64",
      filters: [{ dataSize: 2312 }],
      dataSlice: { offset: 1840, length: 128 },
    }], 45000).catch(() => []),
  ]);

  const now = Math.floor(Date.now() / 1000);
  let decoded = 0;
  let observedUnhealthy = 0;
  let staleUnhealthy = 0;
  const rows = [];

  for (const acct of accounts.slice(0, MARGINFI_SAMPLE_LIMIT)) {
    try {
      const raw = acct.account?.data;
      const data = Buffer.from(Array.isArray(raw) ? raw[0] : raw, "base64");
      if (data.length < 110) continue;
      decoded += 1;
      const timestamp = Number(data.readBigInt64LE(96));
      const flags = data.readUInt32LE(104);
      const healthy = (flags & 1) !== 0;
      const engineOk = (flags & 2) !== 0;
      const age = now - timestamp;
      if (healthy) continue;
      if (timestamp <= 0 || age < 0 || age > MARGINFI_HEALTH_MAX_AGE_SECONDS) {
        staleUnhealthy += 1;
        continue;
      }
      observedUnhealthy += 1;
      const assetVal = i80f48(data, 32);
      const liabVal = i80f48(data, 48);
      rows.push({
        account: acct.pubkey,
        assetVal: Number(assetVal.toFixed(4)),
        liabVal: Number(liabVal.toFixed(4)),
        health: Number((assetVal - liabVal).toFixed(4)),
        age,
        engineOk,
      });
    } catch (_) {}
  }

  rows.sort((a, b) => a.health - b.health);
  return {
    status: "observed-only",
    checkedAt: ts(),
    banks: banks.length || 0,
    accounts: accounts.length || 0,
    decoded,
    observedUnhealthy,
    staleUnhealthy,
    recomputedLiquidatable: 0,
    executableCandidates: [],
    topObserved: rows.slice(0, 5),
    note: "HealthCache observation only; not counted as executable until full bank/oracle recompute is implemented.",
  };
}

function writeStatus(file, status) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(status, null, 2) + "\n");
}

async function runOnce(urls, market) {
  const [kamino, marginfi] = await Promise.all([
    scanKamino(urls, market),
    scanMarginfiObserved(urls).catch(error => ({
      status: "error",
      checkedAt: ts(),
      error: error.message,
      observedUnhealthy: 0,
      recomputedLiquidatable: 0,
      executableCandidates: [],
    })),
  ]);

  const status = {
    updatedAt: ts(),
    source: "tools/monitor-solana-liquidations.js",
    safety: {
      keypairLoaded: false,
      signedActions: false,
      rpcUrlsStored: false,
      marginfiHealthCacheIsExecutable: false,
    },
    kamino,
    marginfi,
    crossProtocol: {
      totalLiquidatable: (kamino.liquidatable || 0) + (marginfi.recomputedLiquidatable || 0),
      executableCandidates: (kamino.executableCandidates?.length || 0) + (marginfi.executableCandidates?.length || 0),
      observedOnlyUnhealthy: marginfi.observedUnhealthy || 0,
    },
  };
  writeStatus(jsonOutPath(), status);
  return status;
}

async function main() {
  loadDotEnv(path.join(WORKSPACE, ".env"));
  const marketArg = process.argv.find((arg, i) => i > 1 && !arg.startsWith("-") && process.argv[i - 1] !== "--json-out") || process.env.KAMINO_MARKET || MAIN_MARKET;
  const urls = resolveRpcUrls();
  log(`Solana no-key watcher started: rpcCount=${urls.length}, intervalMs=${INTERVAL_MS}, marginfi=${SKIP_MARGINFI ? "skipped" : "observed-only"}`);

  do {
    const status = await runOnce(urls, marketArg);
    log(`Kamino liq=${status.kamino.liquidatable || 0}; Marginfi observed=${status.marginfi.observedUnhealthy || 0}, recomputed=${status.marginfi.recomputedLiquidatable || 0}`);
    if (ONCE_MODE) break;
    await sleep(INTERVAL_MS);
  } while (true);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { runOnce, scanKamino, scanMarginfiObserved };
