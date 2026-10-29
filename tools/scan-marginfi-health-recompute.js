#!/usr/bin/env node
// Read-only Marginfi maintenance-health recompute over candidate accounts.
// Fetches sliced HealthCache for all accounts, then full data only for top candidates.
// No keys, no simulations, no sends, no RPC URLs stored or printed.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "marginfi-health-recompute.json");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const META_FILE = path.join(WORKSPACE, "targets", "p0", "marginfi-v2", "clients", "rust", "marginfi-cli", "assets", "mainnet_metadata_dump.json");

const PROGRAM = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";
const BANK_SIZE = 8 + 1856;
const ACCOUNT_SIZE = 8 + 2304;
const HEALTH_CACHE_OFFSET = 8 + 1832;
const HEALTH_CACHE_SLICE_LEN = 128;
const ACCOUNT_CANDIDATE_LIMIT = Number(process.env.MARGINFI_RECOMPUTE_CANDIDATES || "200");
const FRESH_SECONDS = Number(process.env.MARGINFI_HEALTH_FRESH_SECONDS || "120");
const RPC_TIMEOUT_MS = Number(process.env.MARGINFI_RECOMPUTE_RPC_TIMEOUT_MS || "45000");

const ZERO_PUBKEY = "11111111111111111111111111111111";
const HEALTHY = 1;
const ENGINE_OK = 2;
const ORACLE_OK = 4;

const OPS = ["Paused", "Operational", "ReduceOnly", "KilledByBankruptcy"];
const RISK = ["Collateral", "Isolated"];
const ORACLE = [
  "None",
  "PythLegacy",
  "SwitchboardV2",
  "PythPushOracle",
  "SwitchboardPull",
  "StakedWithPythPush",
  "KaminoPythPush",
  "KaminoSwitchboardPull",
  "Fixed",
  "DriftPythPull",
  "DriftSwitchboardPull",
  "SolendPythPull",
  "SolendSwitchboardPull",
  "FixedKamino",
  "FixedDrift",
  "JuplendPythPull",
  "JuplendSwitchboardPull",
  "FixedJuplend",
];

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function loadSolanaUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  const urls = [];
  for (const line of fs.readFileSync(RPC_FILE, "utf8").split(/\r?\n/)) {
    const lower = line.toLowerCase();
    if (!lower.includes("http") || (!lower.includes("solana") && !lower.includes("helius"))) continue;
    for (const m of line.matchAll(/https?:\/\/[^\s'"<>]+/g)) urls.push(m[0].replace(/["'`,;]+$/g, ""));
  }
  return [...new Set(urls)];
}

async function rpc(url, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json" };
    if (/helius/i.test(url)) headers.Origin = "https://helius.xyz";
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`${method} RPC ${json.error.code}: ${json.error.message}`);
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function tryRpc(method, params, timeoutMs = RPC_TIMEOUT_MS) {
  let lastError = null;
  for (const url of loadSolanaUrls()) {
    try {
      const result = await rpc(url, method, params, timeoutMs);
      if (result !== null && result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(lastError?.message || `${method} failed on all configured Solana RPC endpoints`);
}

function b58(buf) {
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  let value = 0n;
  for (const byte of buf) value = (value << 8n) + BigInt(byte);
  let out = "";
  while (value > 0n) {
    const rem = value % 58n;
    value /= 58n;
    out = B58[Number(rem)] + out;
  }
  return "1".repeat(zeros) + (out || "");
}

function pubkeyAt(buf, offset) {
  const bytes = buf.subarray(offset, offset + 32);
  if (bytes.every((b) => b === 0)) return ZERO_PUBKEY;
  return b58(bytes);
}

function i80f48(buf, offset) {
  if (!buf || offset < 0 || offset + 16 > buf.length) return null;
  let value = 0n;
  for (let i = offset + 15; i >= offset; i--) value = (value << 8n) | BigInt(buf[i]);
  const negative = ((value >> 127n) & 1n) === 1n;
  const mag = negative ? ((~value + 1n) & ((1n << 128n) - 1n)) : value;
  const out = Number(mag) / 2 ** 48;
  return negative ? -out : out;
}

function u64(buf, offset) {
  return Number(buf.readBigUInt64LE(offset));
}

function i64(buf, offset) {
  return Number(buf.readBigInt64LE(offset));
}

function round(value, decimals = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function loadMetadata() {
  try {
    const rows = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    return new Map(rows.map((row) => [row.bankAddress, row]));
  } catch (_) {
    return new Map();
  }
}

function parseHealthCache(account, data, now) {
  const assetValue = i80f48(data, 0) || 0;
  const liabilityValue = i80f48(data, 16) || 0;
  const assetValueMaint = i80f48(data, 32) || 0;
  const liabilityValueMaint = i80f48(data, 48) || 0;
  const assetValueEquity = i80f48(data, 64) || 0;
  const liabilityValueEquity = i80f48(data, 80) || 0;
  const timestamp = i64(data, 96);
  const flags = data.readUInt32LE(104);
  const mrgnErr = data.readUInt32LE(108);
  const age = now - timestamp;
  const fresh = timestamp > 0 && age >= 0 && age <= FRESH_SECONDS;
  const healthMaint = assetValueMaint - liabilityValueMaint;
  const hasLiabilities = liabilityValueMaint > 0 || liabilityValue > 0 || liabilityValueEquity > 0;
  return {
    account,
    assetValue,
    liabilityValue,
    assetValueMaint,
    liabilityValueMaint,
    assetValueEquity,
    liabilityValueEquity,
    healthMaint,
    timestamp,
    age,
    fresh,
    flags,
    healthyFlag: (flags & HEALTHY) !== 0,
    engineOk: (flags & ENGINE_OK) !== 0,
    oracleOk: (flags & ORACLE_OK) !== 0,
    mrgnErr,
    hasLiabilities,
    observedUnhealthy: hasLiabilities && (flags & HEALTHY) === 0,
  };
}

function parseBank(pubkey, data, metaMap) {
  const base = 8;
  const config = base + 288;
  const cache = base + 1368;
  const meta = metaMap.get(pubkey) || {};
  const oracleKeys = [];
  for (let i = 0; i < 5; i++) oracleKeys.push(pubkeyAt(data, config + 314 + i * 32));
  const bank = {
    pubkey,
    mint: pubkeyAt(data, base),
    mintDecimals: data.readUInt8(base + 32),
    group: pubkeyAt(data, base + 33),
    assetShareValue: i80f48(data, base + 72) || 0,
    liabilityShareValue: i80f48(data, base + 88) || 0,
    totalLiabilityShares: i80f48(data, base + 248) || 0,
    totalAssetShares: i80f48(data, base + 264) || 0,
    lastUpdate: i64(data, base + 280),
    assetWeightInit: i80f48(data, config),
    assetWeightMaint: i80f48(data, config + 16),
    liabilityWeightInit: i80f48(data, config + 32),
    liabilityWeightMaint: i80f48(data, config + 48),
    depositLimit: u64(data, config + 64),
    operationalState: data.readUInt8(config + 312),
    oracleSetup: data.readUInt8(config + 313),
    oracleKeys,
    borrowLimit: u64(data, config + 480),
    riskTier: data.readUInt8(config + 488),
    assetTag: data.readUInt8(config + 489),
    configFlags: data.readUInt8(config + 490),
    totalAssetValueInitLimit: u64(data, config + 496),
    oracleMaxAge: data.readUInt16LE(config + 504),
    oracleMaxConfidence: data.readUInt32LE(config + 508),
    fixedPrice: i80f48(data, config + 512) || 0,
    lastOraclePrice: i80f48(data, cache + 32) || 0,
    lastOraclePriceTimestamp: i64(data, cache + 48),
    lastOraclePriceConfidence: i80f48(data, cache + 56) || 0,
    liquidationPriceRt: i80f48(data, cache + 96) || 0,
    liquidationPriceRtConfidence: i80f48(data, cache + 112) || 0,
    liquidationPriceTwap: i80f48(data, cache + 128) || 0,
    liquidationPriceTwapConfidence: i80f48(data, cache + 144) || 0,
    lendingPositionCount: data.readInt32LE(base + 1528),
    borrowingPositionCount: data.readInt32LE(base + 1532),
    name: meta.bankName || "",
    ticker: String(meta.ticker || "").split("|")[0].trim(),
    description: meta.description || "",
  };
  bank.validDecode = bank.mintDecimals <= 24
    && bank.assetWeightInit >= 0 && bank.assetWeightInit <= 2
    && bank.assetWeightMaint >= 0 && bank.assetWeightMaint <= 2
    && bank.liabilityWeightInit >= 0.5 && bank.liabilityWeightInit <= 10
    && bank.liabilityWeightMaint >= 0.5 && bank.liabilityWeightMaint <= 10
    && bank.operationalState <= 3
    && bank.oracleSetup <= 17
    && bank.riskTier <= 1;
  return bank;
}

function parseBalance(data, index) {
  const off = 8 + 64 + index * 104;
  const active = data.readUInt8(off) !== 0;
  const bank = pubkeyAt(data, off + 1);
  const assetShares = i80f48(data, off + 40) || 0;
  const liabilityShares = i80f48(data, off + 56) || 0;
  const tag = data.readUInt16LE(off + 34);
  const assetTag = data.readUInt8(off + 33);
  return { index, active, bank, assetTag, tag, assetShares, liabilityShares };
}

function healthFromAccount(pubkey, data, bankMap, now) {
  const healthData = data.subarray(HEALTH_CACHE_OFFSET, HEALTH_CACHE_OFFSET + HEALTH_CACHE_SLICE_LEN);
  const cache = parseHealthCache(pubkey, healthData, now);
  const accountFlags = Number(data.readBigUInt64LE(8 + 1792));
  const owner = pubkeyAt(data, 8 + 32);
  const balances = [];
  let assetMaint = 0;
  let liabilityMaint = 0;
  let assetEquity = 0;
  let liabilityEquity = 0;
  let missingBanks = 0;
  let stalePriceBanks = 0;
  let zeroPriceBanks = 0;
  let activeBalances = 0;
  let assetBalances = 0;
  let liabilityBalances = 0;
  const nowSec = now;

  for (let i = 0; i < 16; i++) {
    const balance = parseBalance(data, i);
    if (!balance.active || balance.bank === ZERO_PUBKEY) continue;
    const side = balance.liabilityShares > 1e-9 ? "liability" : balance.assetShares > 1e-9 ? "asset" : "empty";
    if (side === "empty") continue;
    activeBalances += 1;
    const bank = bankMap.get(balance.bank);
    if (!bank?.validDecode) {
      missingBanks += 1;
      balances.push({ ...balance, side, bankDecoded: false });
      continue;
    }

    const oracleAge = bank.lastOraclePriceTimestamp > 0 ? nowSec - bank.lastOraclePriceTimestamp : null;
    const stale = oracleAge === null || oracleAge < 0 || (bank.oracleMaxAge > 0 && oracleAge > bank.oracleMaxAge);
    if (stale) stalePriceBanks += 1;
    if (bank.lastOraclePrice <= 0) zeroPriceBanks += 1;

    const price = Math.max(0, bank.lastOraclePrice || bank.fixedPrice || 0);
    const confidence = Math.max(0, bank.lastOraclePriceConfidence || 0);
    const priceLow = Math.max(0, price - confidence);
    const priceHigh = price + confidence;
    const pow = 10 ** bank.mintDecimals;
    let amount = 0;
    let valueMaint = 0;
    let valueEquity = 0;

    if (side === "asset") {
      assetBalances += 1;
      amount = balance.assetShares * bank.assetShareValue;
      const weight = bank.riskTier === 0 ? bank.assetWeightMaint : 0;
      valueMaint = amount * priceLow / pow * weight;
      valueEquity = amount * price / pow;
      assetMaint += valueMaint;
      assetEquity += valueEquity;
    } else {
      liabilityBalances += 1;
      amount = balance.liabilityShares * bank.liabilityShareValue;
      const weight = bank.liabilityWeightMaint || 1;
      valueMaint = amount * priceHigh / pow * weight;
      valueEquity = amount * price / pow;
      liabilityMaint += valueMaint;
      liabilityEquity += valueEquity;
    }

    balances.push({
      index: balance.index,
      side,
      bank: balance.bank,
      symbol: bank.ticker || bank.name || balance.bank,
      amount: round(amount, 6),
      valueMaintUsd: round(valueMaint, 6),
      valueEquityUsd: round(valueEquity, 6),
      oracleSetup: ORACLE[bank.oracleSetup] || String(bank.oracleSetup),
      oracleAgeSeconds: oracleAge,
      oracleMaxAgeSeconds: bank.oracleMaxAge,
      staleOracleCache: stale,
      priceUsed: round(side === "asset" ? priceLow : priceHigh, 8),
      basePrice: round(price, 8),
      confidence: round(confidence, 8),
      maintWeight: round(side === "asset" ? bank.assetWeightMaint : bank.liabilityWeightMaint, 6),
      riskTier: RISK[bank.riskTier] || String(bank.riskTier),
    });
  }

  const recomputedHealth = assetMaint - liabilityMaint;
  return {
    account: pubkey,
    owner,
    accountFlags,
    activeBalances,
    assetBalances,
    liabilityBalances,
    missingBanks,
    stalePriceBanks,
    zeroPriceBanks,
    cache: {
      ageSeconds: cache.age,
      fresh: cache.fresh,
      flags: cache.flags,
      healthyFlag: cache.healthyFlag,
      engineOk: cache.engineOk,
      oracleOk: cache.oracleOk,
      mrgnErr: cache.mrgnErr,
      assetMaintUsd: round(cache.assetValueMaint, 6),
      liabilityMaintUsd: round(cache.liabilityValueMaint, 6),
      healthMaintUsd: round(cache.healthMaint, 6),
    },
    recompute: {
      assetMaintUsd: round(assetMaint, 6),
      liabilityMaintUsd: round(liabilityMaint, 6),
      healthMaintUsd: round(recomputedHealth, 6),
      assetEquityUsd: round(assetEquity, 6),
      liabilityEquityUsd: round(liabilityEquity, 6),
      conservativeLiquidatable: liabilityMaint > 0 && recomputedHealth < 0,
      cacheDeltaHealthUsd: round(recomputedHealth - cache.healthMaint, 6),
      usableForExecution: false,
    },
    topBalances: balances.sort((a, b) => Math.abs((b.valueMaintUsd || 0)) - Math.abs((a.valueMaintUsd || 0))).slice(0, 8),
  };
}

async function fetchBanks(metaMap) {
  const rows = await tryRpc("getProgramAccounts", [PROGRAM, {
    encoding: "base64",
    filters: [{ dataSize: BANK_SIZE }],
  }], RPC_TIMEOUT_MS);
  const bankMap = new Map();
  for (const row of rows || []) {
    try {
      const raw = row.account?.data;
      const data = Buffer.from(Array.isArray(raw) ? raw[0] : raw, "base64");
      const bank = parseBank(row.pubkey, data, metaMap);
      bankMap.set(row.pubkey, bank);
    } catch (_) {}
  }
  return { rows: rows || [], bankMap };
}

async function fetchHealthSlices(now) {
  const rows = await tryRpc("getProgramAccounts", [PROGRAM, {
    encoding: "base64",
    filters: [{ dataSize: ACCOUNT_SIZE }],
    dataSlice: { offset: HEALTH_CACHE_OFFSET, length: HEALTH_CACHE_SLICE_LEN },
  }], RPC_TIMEOUT_MS);
  const parsed = [];
  for (const row of rows || []) {
    try {
      const raw = row.account?.data;
      const data = Buffer.from(Array.isArray(raw) ? raw[0] : raw, "base64");
      const cache = parseHealthCache(row.pubkey, data, now);
      if (cache.hasLiabilities) parsed.push(cache);
    } catch (_) {}
  }
  return { rows: rows || [], parsed };
}

async function fetchFullAccounts(pubkeys) {
  const out = [];
  for (let i = 0; i < pubkeys.length; i += 100) {
    const chunk = pubkeys.slice(i, i + 100);
    const result = await tryRpc("getMultipleAccounts", [chunk, { encoding: "base64" }], RPC_TIMEOUT_MS);
    const values = result?.value || [];
    for (let j = 0; j < chunk.length; j++) {
      const acc = values[j];
      if (!acc?.data) continue;
      const data = Buffer.from(Array.isArray(acc.data) ? acc.data[0] : acc.data, "base64");
      if (data.length === ACCOUNT_SIZE) out.push({ pubkey: chunk[j], data });
    }
  }
  return out;
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const metaMap = loadMetadata();
  const [{ rows: bankRows, bankMap }, { rows: healthRows, parsed: healthCaches }] = await Promise.all([
    fetchBanks(metaMap),
    fetchHealthSlices(now),
  ]);
  const decodedBanks = [...bankMap.values()].filter((b) => b.validDecode);
  const bankByOracle = {};
  for (const bank of decodedBanks) bankByOracle[ORACLE[bank.oracleSetup] || String(bank.oracleSetup)] = (bankByOracle[ORACLE[bank.oracleSetup] || String(bank.oracleSetup)] || 0) + 1;

  const candidates = healthCaches
    .filter((row) => row.observedUnhealthy || row.healthMaint < 250 || !row.fresh)
    .sort((a, b) => {
      const af = a.fresh ? 0 : 1;
      const bf = b.fresh ? 0 : 1;
      const au = a.observedUnhealthy ? 0 : 1;
      const bu = b.observedUnhealthy ? 0 : 1;
      return au - bu || af - bf || a.healthMaint - b.healthMaint || b.liabilityValueMaint - a.liabilityValueMaint;
    })
    .slice(0, ACCOUNT_CANDIDATE_LIMIT);
  const fullAccounts = await fetchFullAccounts(candidates.map((row) => row.account));
  const recomputed = fullAccounts.map((row) => healthFromAccount(row.pubkey, row.data, bankMap, now));
  recomputed.sort((a, b) => (a.recompute.healthMaintUsd ?? Infinity) - (b.recompute.healthMaintUsd ?? Infinity));

  const freshObservedUnhealthy = healthCaches.filter((row) => row.fresh && row.observedUnhealthy).length;
  const staleUnhealthy = healthCaches.filter((row) => !row.fresh && row.observedUnhealthy).length;
  const conservativeLiquidatable = recomputed.filter((row) => row.recompute.conservativeLiquidatable).length;
  const materialConservativeLiquidatable = recomputed.filter((row) => row.recompute.conservativeLiquidatable && (row.recompute.liabilityMaintUsd || 0) >= 100).length;
  const staleOracleRows = recomputed.filter((row) => row.stalePriceBanks > 0 || row.zeroPriceBanks > 0).length;
  const cleanCachedLiquidatableRows = recomputed.filter((row) => row.recompute.conservativeLiquidatable && row.stalePriceBanks === 0 && row.zeroPriceBanks === 0);
  const materialCleanCachedLiquidatableRows = cleanCachedLiquidatableRows.filter((row) => (row.recompute.liabilityMaintUsd || 0) >= 100);
  const freshCleanCachedLiquidatableRows = cleanCachedLiquidatableRows.filter((row) => row.cache.fresh);

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-marginfi-health-recompute.js",
    scope: "Read-only Marginfi candidate health recompute from full balances and decoded bank cache",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      keypairLoaded: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    methodology: {
      sourceStructs: [
        "type-crate/src/types/user_account.rs",
        "type-crate/src/types/bank.rs",
        "type-crate/src/types/bank_config.rs",
        "type-crate/src/types/bank_cache.rs",
      ],
      accountSelection: "All Marginfi account HealthCache slices are scanned; only top unhealthy/near/stale candidates are fetched as full accounts.",
      recompute: "Maintenance health = asset amount * low cached bank price * asset_weight_maint minus liability amount * high cached bank price * liability_weight_maint.",
      limitations: [
        "Uses bank cached oracle prices, not freshly parsed Pyth/Switchboard/adapter account prices.",
        "Does not apply e-mode intersections, so asset value can be conservative/understated for e-mode accounts.",
        "Does not build liquidation instructions, quotes, simulations, or transactions.",
      ],
    },
    summary: {
      bankAccountsFetched: bankRows.length,
      banksDecoded: decodedBanks.length,
      bankOracleTypes: bankByOracle,
      healthAccountsScanned: healthRows.length,
      debtHealthRows: healthCaches.length,
      freshObservedUnhealthy,
      staleObservedUnhealthy: staleUnhealthy,
      candidateAccountsSelected: candidates.length,
      fullAccountsFetched: fullAccounts.length,
      accountsRecomputed: recomputed.length,
      conservativeLiquidatable,
      materialConservativeLiquidatable,
      recomputedRowsWithStaleOrZeroBankPrice: staleOracleRows,
      cleanCachedConservativeLiquidatable: cleanCachedLiquidatableRows.length,
      materialCleanCachedConservativeLiquidatable: materialCleanCachedLiquidatableRows.length,
      freshCleanCachedConservativeLiquidatable: freshCleanCachedLiquidatableRows.length,
      bestHealthMaintUsd: round(recomputed[0]?.recompute?.healthMaintUsd ?? null, 6),
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
    },
    topRows: recomputed.slice(0, 30),
    cleanCachedRows: cleanCachedLiquidatableRows.slice(0, 20),
    candidateSelectionPreview: candidates.slice(0, 30).map((row) => ({
      account: row.account,
      fresh: row.fresh,
      ageSeconds: row.age,
      healthyFlag: row.healthyFlag,
      engineOk: row.engineOk,
      oracleOk: row.oracleOk,
      assetMaintUsd: round(row.assetValueMaint, 6),
      liabilityMaintUsd: round(row.liabilityValueMaint, 6),
      healthMaintUsd: round(row.healthMaint, 6),
      mrgnErr: row.mrgnErr,
    })),
    blockers: [
      "No fresh executable Marginfi unhealthy account was proven with live oracle-account recompute",
      "Cached-bank recompute is a candidate filter, not a liquidation proof",
      "Exact repay acquisition, seized-collateral exit, and local/fork-equivalent proof are still missing",
    ],
    nextSteps: [
      "If materialConservativeLiquidatable > 0, parse the referenced live oracle accounts for those banks and compare against cached prices.",
      "Only after live oracle recompute agrees, exact-quote repay/collateral exit and build a local/fork-equivalent liquidation proof.",
      "Keep Marginfi rows non-executable until routePositive and proof artifacts exist.",
    ],
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Marginfi recompute: banks=${decodedBanks.length}/${bankRows.length} healthRows=${healthCaches.length} selected=${candidates.length} recomputed=${recomputed.length} conservativeLiquidatable=${conservativeLiquidatable} routePositive=0`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
