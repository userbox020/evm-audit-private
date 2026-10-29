#!/usr/bin/env node
"use strict";

// Part 1 (read-only) for the Kamino Klend reduced-price-status liquidation bypass.
//
// Determines the live Main Market reserve `LastUpdate.price_status` distribution at one
// finalized slot, decodes the reduced/full flags, and reports whether any reserve is
// currently in (or recently was in) the LIQUIDATION_CHECKS-accepted / ALL_CHECKS-rejected
// state that the bypass needs.
//
// SECRETS CONTRACT:
//   * Reads rpc_endpoints.txt in-process under standing authorization.
//   * The endpoint value is never printed, logged, summarized, hashed, or persisted.
//   * No signing, no transaction, no mutation. getGenesisHash/getSlot/getAccountInfo/
//     getProgramAccounts/getBlockTime only.
//
// Output: reports/raw/fast/kamino-klend-fork/current-state.json

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "reports", "raw", "fast", "kamino-klend-fork");
const OUT_FILE = path.join(OUT_DIR, "current-state.json");

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const PROGRAM_ID = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const ZERO_PUBKEY = "11111111111111111111111111111111";
const URL_RE = /https?:\/\/[^\s'"<>]+/gi;

// Account layout (Anchor discriminator inclusive; verified against klend v1.22 / v1.25
// `Reserve` + `LastUpdate` + `ReserveConfig` layouts).
const LAYOUT = {
  reserveSize: 8624,
  marketOffset: 32, // discriminator(8)+version(8)+last_update(16) -> lending_market
  lastUpdateSlotOffset: 16,
  lastUpdateStaleOffset: 24,
  lastUpdatePriceStatusOffset: 25,
  reserveConfigOffset: 4856, // discriminator(8)+offset_of(config)
  configProtocolLiquidationFeePct: 15,
  configMinLiquidationBonusBps: 18,
  tokenInfoOffset: 176,
};

const FLAGS = {
  PRICE_LOADED: 0x01,
  PRICE_AGE_CHECKED: 0x02,
  TWAP_CHECKED: 0x04,
  TWAP_AGE_CHECKED: 0x08,
  HEURISTIC_CHECKED: 0x10,
  PRICE_USAGE_ALLOWED: 0x20,
  LIQUIDATION_CHECKS: 0x23,
  ALL_CHECKS: 0x3f,
};

const CAPS = { maxCandidates: 10, smallMs: 15000, gpaMs: 120000 };

// Single source of truth for the Main Market reserve enumeration filter.
const RESERVE_FILTER = [
  { dataSize: LAYOUT.reserveSize },
  { memcmp: { offset: LAYOUT.marketOffset, bytes: MAIN_MARKET } },
];

// The predicate under watch. `reduced` is the LIQUIDATION_CHECKS-accepted / ALL_CHECKS-rejected
// status; the same-slot window (ageSlots == 0) is the live bypass window.
const RESERVE_STATE = Object.freeze({
  IN_STATE: "in-state",
  NEAR_STATE: "near-state",
  REDUCED: "reduced",
  CLEAN: "clean",
});

function classifyReserve(r) {
  if (!r || !r.reduced) return RESERVE_STATE.CLEAN;
  if (r.ageSlots === 0) return RESERVE_STATE.IN_STATE;
  if (r.ageSlots !== null && r.ageSlots !== undefined && r.ageSlots < 5) return RESERVE_STATE.NEAR_STATE;
  return RESERVE_STATE.REDUCED;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const x of bytes) n = (n << 8n) + BigInt(x);
  let out = "";
  while (n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  return "1".repeat(zeros) + (out || "");
}
function sha256(b) { return crypto.createHash("sha256").update(b).digest("hex"); }
function ascii(data, off, len) {
  const b = data.subarray(off, off + len);
  const z = b.indexOf(0);
  return b.subarray(0, z < 0 ? b.length : z).toString("utf8").replace(/[^\x20-\x7e]/g, ".");
}
function decodeData(account) {
  const x = account && account.data;
  const s = Array.isArray(x) ? x[0] : x;
  return Buffer.from(s || "", "base64");
}
function missingFlags(status) {
  const names = ["PRICE_LOADED", "PRICE_AGE_CHECKED", "TWAP_CHECKED", "TWAP_AGE_CHECKED", "HEURISTIC_CHECKED", "PRICE_USAGE_ALLOWED"];
  return names.filter((n) => (status & FLAGS[n]) === 0);
}

function readCandidates() {
  const file = path.join(ROOT, "rpc_endpoints.txt");
  const text = fs.readFileSync(file, "utf8");
  const seen = new Set();
  const urls = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/solana|helius|mainnet-beta|rpcpool|quicknode/i.test(line)) continue;
    const m = line.match(URL_RE);
    if (!m) continue;
    for (const u of m) {
      const clean = u.replace(/[.,;]+$/, "");
      if (seen.has(clean)) continue;
      seen.add(clean);
      urls.push(clean);
    }
  }
  return urls.slice(0, CAPS.maxCandidates);
}

let rpcId = 1;
async function rpc(url, method, params, timeoutMs = CAPS.smallMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
      signal: ac.signal,
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(`${method}:${j && j.error ? j.error.code : r.status}`);
    return j.result;
  } finally {
    clearTimeout(timer);
  }
}

async function qualify() {
  const urls = readCandidates();
  let tested = 0;
  for (const u of urls) {
    tested += 1;
    try {
      const g = await rpc(u, "getGenesisHash", [], 8000);
      if (g === MAINNET_GENESIS) return { url: u, tested };
    } catch (_) { /* next */ }
  }
  throw new Error("no-qualified-solana-mainnet-endpoint");
}

function parseReserve(pubkey, data) {
  const status = data.readUInt8(LAYOUT.lastUpdatePriceStatusOffset);
  const slot = Number(data.readBigUInt64LE(LAYOUT.lastUpdateSlotOffset));
  const stale = data.readUInt8(LAYOUT.lastUpdateStaleOffset) !== 0;
  const cfg = LAYOUT.reserveConfigOffset;
  const tokenName = ascii(data, cfg + LAYOUT.tokenInfoOffset, 32);
  const ti = cfg + LAYOUT.tokenInfoOffset;
  const twapBps = Number(data.readBigUInt64LE(ti + 56));
  const maxAgePriceSeconds = Number(data.readBigUInt64LE(ti + 64));
  const maxAgeTwapSeconds = Number(data.readBigUInt64LE(ti + 72));
  const scopeFeedNonZero = !data.subarray(ti + 80, ti + 112).equals(Buffer.alloc(32)) && data.subarray(ti + 80, ti + 112).some((b) => b !== 0);
  const scopePriceFeed = scopeFeedNonZero ? b58(data.subarray(ti + 80, ti + 112)) : null;
  const pythRaw = data.subarray(ti + 192, ti + 224);
  const pythPrice = pythRaw.some((b) => b !== 0) ? b58(pythRaw) : null;
  const sbAggRaw = data.subarray(ti + 128, ti + 160);
  const sbPriceAggregator = sbAggRaw.some((b) => b !== 0) ? b58(sbAggRaw) : null;
  const priceChain = [0, 1, 2, 3].map((i) => data.readUInt16LE(ti + 112 + i * 2));
  const twapChain = [0, 1, 2, 3].map((i) => data.readUInt16LE(ti + 120 + i * 2));
  const blockPriceUsage = data.readUInt8(ti + 224);
  const heuristicLower = data.readBigUInt64LE(cfg + LAYOUT.tokenInfoOffset + 32);
  const heuristicUpper = data.readBigUInt64LE(cfg + LAYOUT.tokenInfoOffset + 40);
  const heuristicExp = data.readBigUInt64LE(cfg + LAYOUT.tokenInfoOffset + 48);
  const u128At = (off) => { let n = 0n; for (let i = 15; i >= 0; i--) n = (n << 8n) + BigInt(data[off + i]); return n; };
  const addrAt = (off) => { const b = data.subarray(off, off + 32); return b.some((x) => x !== 0) ? b58(b) : null; };
  const raw = {
    version: data.readBigUInt64LE(8).toString(),
    farmCollateral: addrAt(64),
    farmDebt: addrAt(96),
    liquidityMint: addrAt(128),
    liquiditySupplyVault: addrAt(160),
    liquidityFeeVault: addrAt(192),
    totalAvailableAmount: data.readBigUInt64LE(224).toString(),
    borrowedAmountSf: u128At(232).toString(),
    marketPriceSf: u128At(248).toString(),
    marketPriceLastUpdatedTs: data.readBigUInt64LE(264).toString(),
    mintDecimals: data.readBigUInt64LE(272).toString(),
    cumulativeBorrowRateBsf: [0, 1, 2, 3].map((i) => data.readBigUInt64LE(296 + i * 8).toString()),
    liquidityTokenProgram: addrAt(408),
    collateralMint: addrAt(2560),
    collateralSupplyVault: addrAt(2600),
    configStatus: data.readUInt8(cfg + 0),
    emergencyMode: data.readUInt8(cfg + 8),
    protocolLiquidationFeePct: data.readUInt8(cfg + 15),
    loanToValuePct: data.readUInt8(cfg + 16),
    liquidationThresholdPct: data.readUInt8(cfg + 17),
    minLiquidationBonusBps: data.readUInt16LE(cfg + 18),
    maxLiquidationBonusBps: data.readUInt16LE(cfg + 20),
    badDebtLiquidationBonusBps: data.readUInt16LE(cfg + 22),
    borrowFactorPct: data.readBigUInt64LE(cfg + 152).toString(),
  };
  return {
    pubkey,
    raw,
    status,
    statusHex: `0x${status.toString(16).padStart(2, "0")}`,
    lastUpdateSlot: slot,
    stale,
    liquidationChecksAccepted: (status & FLAGS.LIQUIDATION_CHECKS) === FLAGS.LIQUIDATION_CHECKS,
    allChecksAccepted: (status & FLAGS.ALL_CHECKS) === FLAGS.ALL_CHECKS,
    reduced: (status & FLAGS.LIQUIDATION_CHECKS) === FLAGS.LIQUIDATION_CHECKS && (status & FLAGS.ALL_CHECKS) !== FLAGS.ALL_CHECKS,
    missingFlags: missingFlags(status),
    tokenName,
    oracle: {
      scopePriceFeed,
      scopePriceChain: priceChain,
      scopeTwapChain: twapChain,
      pythPrice,
      switchboardPriceAggregator: sbPriceAggregator,
      blockPriceUsage,
    },
    maxTwapDivergenceBps: twapBps,
    maxAgePriceSeconds,
    maxAgeTwapSeconds,
    heuristicLower: heuristicLower.toString(),
    heuristicUpper: heuristicUpper.toString(),
    heuristicExp: heuristicExp.toString(),
    protocolLiquidationFeePct: data.readUInt8(cfg + LAYOUT.configProtocolLiquidationFeePct),
    minLiquidationBonusBps: data.readUInt16LE(cfg + LAYOUT.configMinLiquidationBonusBps),
  };
}

// Enumerate + parse every Main Market reserve at one finalized context.
// Reused by main() (snapshot) and by tools/monitor-kamino-reduced-status.js (durable watch)
// so the predicate and enumeration are never duplicated.
async function fetchReserves(url, head) {
  const gpa = await rpc(url, "getProgramAccounts", [
    PROGRAM_ID,
    {
      commitment: "finalized",
      minContextSlot: head,
      withContext: true,
      encoding: "base64",
      filters: RESERVE_FILTER,
    },
  ], CAPS.gpaMs);

  const contextSlot = Number(gpa && gpa.context ? gpa.context.slot : -1);
  const reserveErrors = [];
  const reserves = [];
  for (const row of (gpa && gpa.value) || []) {
    try {
      const raw = decodeData(row.account);
      const r = parseReserve(row.pubkey, raw);
      r.marketMatches = raw.length >= LAYOUT.marketOffset + 32
        && b58(raw.subarray(LAYOUT.marketOffset, LAYOUT.marketOffset + 32)) === MAIN_MARKET;
      reserves.push(r);
    } catch (e) {
      reserveErrors.push({ pubkey: row.pubkey, reason: e.message });
    }
  }
  for (const r of reserves) r.ageSlots = contextSlot >= 0 ? contextSlot - r.lastUpdateSlot : null;
  return {
    contextSlot,
    reserves,
    reserveErrors,
    rowsReturned: gpa && gpa.value ? gpa.value.length : 0,
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const { url, tested } = await qualify();

  const head = Number(await rpc(url, "getSlot", [{ commitment: "finalized" }]));
  const programAcct = await rpc(url, "getAccountInfo", [PROGRAM_ID, { encoding: "base64", commitment: "finalized", minContextSlot: head }]);
  const programBytes = decodeData(programAcct && programAcct.value);
  const programDataAddr = programBytes.length >= 36 && programBytes.readUInt32LE(0) === 2 ? b58(programBytes.subarray(4, 36)) : null;
  let deployment = null;
  if (programDataAddr) {
    const pda = await rpc(url, "getAccountInfo", [programDataAddr, { encoding: "base64", commitment: "finalized", minContextSlot: head }], CAPS.gpaMs);
    const pd = decodeData(pda && pda.value);
    const deploymentSlot = pd.length >= 12 && pd.readUInt32LE(0) === 3 ? Number(pd.readBigUInt64LE(4)) : null;
    let deploymentBlockTime = null;
    if (deploymentSlot !== null) {
      try { deploymentBlockTime = await rpc(url, "getBlockTime", [deploymentSlot], CAPS.smallMs); } catch (_) { deploymentBlockTime = null; }
    }
    let payloadTrim = pd.length - 45;
    while (payloadTrim > 0 && pd[45 + payloadTrim - 1] === 0) payloadTrim--;
    deployment = {
      programDataAddress: programDataAddr,
      owner: pda && pda.value ? pda.value.owner : null,
      executable: !!(pda && pda.value && pda.value.executable),
      stateTag: pd.length >= 4 ? pd.readUInt32LE(0) : null,
      deploymentSlot,
      deploymentBlockTime,
      deploymentBlockTimeUtc: deploymentBlockTime ? new Date(deploymentBlockTime * 1000).toISOString() : null,
      accountBytes: pd.length,
      accountSha256: sha256(pd),
      payloadSha256: pd.length >= 45 ? sha256(pd.subarray(45)) : null,
      zeroTrimmedPayloadSha256: pd.length >= 45 ? sha256(pd.subarray(45, 45 + payloadTrim)) : null,
      elfMagic: pd.length >= 49 ? pd.subarray(45, 49).toString("hex") : null,
    };
  }

  const marketAcct = await rpc(url, "getAccountInfo", [MAIN_MARKET, { encoding: "base64", commitment: "finalized", minContextSlot: head }]);
  const marketData = decodeData(marketAcct && marketAcct.value);

  const { contextSlot, reserves, reserveErrors, rowsReturned } = await fetchReserves(url, head);

  const byStatus = {};
  for (const r of reserves) byStatus[r.statusHex] = (byStatus[r.statusHex] || 0) + 1;
  const reduced = reserves.filter((r) => r.reduced);
  const reducedSameSlot = reduced.filter((r) => r.ageSlots === 0);
  const reducedFresh = reduced.filter((r) => r.ageSlots !== null && r.ageSlots < 5);
  const noneStatus = reserves.filter((r) => r.status === 0);
  const notLiquidationUsable = reserves.filter((r) => !r.liquidationChecksAccepted);

  const evidence = {
    schema: "kamino-klend-current-status/1",
    generatedAt: new Date().toISOString(),
    startedAt,
    gitCheckout: {
      sourceTree: "targets/kamino-klend (release/v1.22.0, 4c7653a)",
      newestReleasedSourceChecked: "targets/kamino-klend-v1.25.0 (release/v1.25.0, a0876090)",
      newestTagOnOrigin: "release/v1.25.0",
      liquidationChecksInV1_22: "0x23 (PRICE_LOADED|PRICE_AGE_CHECKED|PRICE_USAGE_ALLOWED)",
      liquidationChecksInV1_25_0: "0x23 (PRICE_LOADED|PRICE_AGE_CHECKED|PRICE_USAGE_ALLOWED)",
      v1_25_0StillStoresPartialStatus: true,
      v1_25_0LiquidationGateUsesLiquidationChecks: true,
    },
    endpoint: { qualified: true, candidatesTested: tested },
    finalizedHeadAtStart: head,
    program: {
      programId: PROGRAM_ID,
      executable: !!(programAcct && programAcct.value && programAcct.value.executable),
      owner: programAcct && programAcct.value ? programAcct.value.owner : null,
      programDataLink: programDataAddr,
    },
    deployment,
    market: {
      address: MAIN_MARKET,
      dataBytes: marketData.length,
      permissioningAuthority: marketData.length >= 3432 ? b58(marketData.subarray(3400, 3432)) : null,
      permissionedOps: marketData.length >= 3440 ? marketData.readBigUInt64LE(3432).toString() : null,
    },
    observation: {
      contextSlot,
      commitment: "finalized",
      reserveFilter: { dataSize: LAYOUT.reserveSize, memcmpOffset: LAYOUT.marketOffset, bytes: MAIN_MARKET },
      reserveRowsReturned: rowsReturned,
      reserveRowsParsed: reserves.length,
      reserveParseErrors: reserveErrors,
      predicate: {
        reducedStatus: "((status & 0x23)==0x23) && ((status & 0x3f)!=0x3f)  [LIQUIDATION_CHECKS accepted, ALL_CHECKS rejected]",
        fresh: "contextSlot - lastUpdateSlot (ageSlots)",
        inState: "reduced && ageSlots == 0",
        nearState: "reduced && ageSlots < 5",
      },
      statusHistogram: byStatus,
      counts: {
        reserves: reserves.length,
        reducedStatusReserves: reduced.length,
        reducedAndSameSlot: reducedSameSlot.length,
        reducedAndAgeLt5: reducedFresh.length,
        zeroStatusReserves: noneStatus.length,
        notLiquidationUsableReserves: notLiquidationUsable.length,
      },
      reducedReserves: reduced.map((r) => ({
        pubkey: r.pubkey, tokenName: r.tokenName, statusHex: r.statusHex, missingFlags: r.missingFlags,
        lastUpdateSlot: r.lastUpdateSlot, ageSlots: r.ageSlots, stale: r.stale,
        maxTwapDivergenceBps: r.maxTwapDivergenceBps,
        oracle: r.oracle,
        heuristic: { lower: r.heuristicLower, upper: r.heuristicUpper, exp: r.heuristicExp },
      })),
      allReserves: reserves.map((r) => ({
        pubkey: r.pubkey, tokenName: r.tokenName, statusHex: r.statusHex, missingFlags: r.missingFlags,
        lastUpdateSlot: r.lastUpdateSlot, ageSlots: r.ageSlots, stale: r.stale,
        allChecksAccepted: r.allChecksAccepted,
        oracle: r.oracle,
        raw: r.raw,
        maxTwapDivergenceBps: r.maxTwapDivergenceBps,
        maxAgePriceSeconds: r.maxAgePriceSeconds,
        maxAgeTwapSeconds: r.maxAgeTwapSeconds,
        heuristic: { lower: r.heuristicLower, upper: r.heuristicUpper, exp: r.heuristicExp },
      })),
    },
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  try { fs.writeFileSync(path.join(OUT_DIR, `current-state-${contextSlot}.json`), JSON.stringify(evidence, null, 2) + "\n", "utf8"); } catch (_) { /* non-fatal */ }

  const oracleKinds = reserves.reduce((acc, r) => {
    const k = r.oracle.pythPrice ? "pyth" : r.oracle.scopePriceFeed ? "scope" : r.oracle.switchboardPriceAggregator ? "switchboard" : "none";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const summary = {
    contextSlot,
    reserves: reserves.length,
    statusHistogram: byStatus,
    oracleKinds,
    reducedStatusReserves: reduced.length,
    reducedAndSameSlot: reducedSameSlot.length,
    reducedAndAgeLt5: reducedFresh.length,
    reducedNames: reduced.slice(0, 20).map((r) => `${r.tokenName || r.pubkey.slice(0, 6)}:${r.statusHex}:age=${r.ageSlots}`),
    deploymentSlot: deployment && deployment.deploymentSlot,
    deploymentBlockTimeUtc: deployment && deployment.deploymentBlockTimeUtc,
    programDataSha256: deployment && deployment.accountSha256,
    outFile: path.relative(ROOT, OUT_FILE).replace(/\\/g, "/"),
  };
  console.log(JSON.stringify(summary, null, 2));
}

module.exports = {
  MAINNET_GENESIS,
  PROGRAM_ID,
  MAIN_MARKET,
  LAYOUT,
  FLAGS,
  CAPS,
  RESERVE_FILTER,
  RESERVE_STATE,
  classifyReserve,
  readCandidates,
  rpc,
  qualify,
  decodeData,
  parseReserve,
  fetchReserves,
  b58,
  sha256,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(`[current-status] ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  });
}
