#!/usr/bin/env node
"use strict";

// Step 5 defensive stage: one finalized, read-only Kamino Main Market observation.
// It never signs, simulates, sends, broadcasts, or persists endpoint information.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const NAME = "kamino-reduced-status-liquidation-recertification";
const TARGET = path.join(ROOT, "targets", "kamino-klend");
const DEFINITIONS = path.join(ROOT, "definitions", `${NAME}.json`);
const OUT = {
  raw: path.join(ROOT, "reports", "raw", "fast", `${NAME}.json`),
  manifest: path.join(ROOT, "reports", "raw", "fast", `${NAME}.manifest.json`),
  report: path.join(ROOT, "reports", `${NAME}.md`),
  handoff: path.join(ROOT, "coordination", "handoffs", `2026-07-16-${NAME}.md`),
  sources: path.join(ROOT, "sources", NAME),
};
const SOURCE_FILES = {
  lastUpdate: "targets/kamino-klend/programs/klend/src/state/last_update.rs",
  checks: "targets/kamino-klend/programs/klend/src/utils/prices/checks.rs",
  operations: "targets/kamino-klend/programs/klend/src/lending_market/lending_operations.rs",
  liquidationOperations: "targets/kamino-klend/programs/klend/src/state/liquidation_operations.rs",
  refreshHandler: "targets/kamino-klend/programs/klend/src/handlers/handler_refresh_obligation.rs",
  liquidateHandler: "targets/kamino-klend/programs/klend/src/handlers/handler_liquidate_obligation_and_redeem_reserve_collateral.rs",
  market: "targets/kamino-klend/programs/klend/src/state/lending_market.rs",
  permissioning: "targets/kamino-klend/programs/klend/src/utils/permissioning.rs",
  test: "targets/kamino-klend/programs/klend/tests/liquidation_price_status.rs",
  cargo: "targets/kamino-klend/programs/klend/Cargo.toml",
  lock: "targets/kamino-klend/Cargo.lock",
};

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ZERO_PUBKEY = "11111111111111111111111111111111";
const PERMISSION_LIQUIDATE = 1n << 2n;
const URL_RE = /https?:\/\/[^\s'"<>]+/gi;
const SECRET_RE = /(api[_-]?key|authorization|bearer|x-api-key|private[_-]?key|secret|token=)[^\s,;]*/gi;
const SECRET_VALUE_RE = /(?:^|[\s{,])["']?(?:api[_-]?key|authorization|x-api-key|private[_-]?key|secret|access[_-]?token)["']?\s*[:=]\s*["']?(?!false\b|null\b|\[redacted\])([^\s"',;}]{8,})/gim;
const BEARER_VALUE_RE = /\bbearer\s+[A-Za-z0-9._~-]{8,}/gi;
const USER_HOME_RE = /\b[A-Za-z]:\\Users\\[^\\\s]+/gi;
const canonical = (v) => typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const stable = (v) => JSON.stringify(canonical(v));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");
const now = () => new Date().toISOString();

function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { flag: "wx" });
  fs.renameSync(tmp, file);
}
function writeJson(file, value) { atomic(file, `${JSON.stringify(canonical(value), null, 2)}\n`); }
function record(file) { const b = fs.readFileSync(file); return { file: rel(file), bytes: b.length, sha256: sha(b) }; }
function sanitize(s) { return String(s || "").replace(URL_RE, "[redacted-url]").replace(SECRET_RE, "$1[redacted]").replace(USER_HOME_RE, "%USERPROFILE%"); }
function readRel(p) { return fs.readFileSync(path.join(ROOT, p)); }
function sourceRecord(p) { const b = readRel(p); return { file: p, bytes: b.length, sha256: sha(b) }; }
function lines(p, start, end) { return readRel(p).toString("utf8").split(/\r?\n/).slice(start - 1, end).map((x, i) => `${start + i}: ${x}`).join("\n"); }

function b58(bytes) {
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n; for (const x of bytes) n = (n << 8n) + BigInt(x);
  let out = ""; while (n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  return "1".repeat(zeros) + (out || "");
}
function pubkeyAt(data, offset) { return b58(data.subarray(offset, offset + 32)); }
function u128(data, offset) { let n = 0n; for (let i = 15; i >= 0; i--) n = (n << 8n) + BigInt(data[offset + i]); return n; }
function sf(data, offset) { return Number(u128(data, offset)) / 2 ** 60; }
function ascii(data, offset, len) { const b = data.subarray(offset, offset + len); const z = b.indexOf(0); return b.subarray(0, z < 0 ? b.length : z).toString("utf8"); }
function decodeData(account) { const x = account?.data; const s = Array.isArray(x) ? x[0] : x; return Buffer.from(s || "", "base64"); }

let rpcId = 1;
async function rpc(url, method, params, timeout = 60000) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
      signal: ac.signal,
    });
    const j = await r.json();
    if (!r.ok || j.error) throw Error(`${method}:${j?.error?.code ?? r.status}`);
    return j.result;
  } finally { clearTimeout(timer); }
}
async function rpcBatch(url, calls, timeout = 600000) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeout);
  const payload = calls.map((x, i) => ({ jsonrpc: "2.0", id: i + 1, method: x.method, params: x.params }));
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: ac.signal });
    const j = await r.json();
    if (!r.ok || !Array.isArray(j)) throw Error(`batch:${r.status}`);
    const byId = new Map(j.map(x => [x.id, x]));
    return payload.map(x => { const row = byId.get(x.id); if (!row || row.error) throw Error(`${x.method}:${row?.error?.code ?? "missing"}`); return row.result; });
  } finally { clearTimeout(timer); }
}
function loadCandidateUrls() {
  const file = path.join(ROOT, "rpc_endpoints.txt");
  if (!fs.existsSync(file)) throw Error("authorized endpoint inventory missing");
  const all = [...fs.readFileSync(file, "utf8").matchAll(URL_RE)].map(m => m[0]);
  const preferred = all.filter(u => /solana|helius|mainnet-beta|rpcpool|quicknode/i.test(u));
  if (!preferred.length) throw Error("no Solana-like endpoint candidate in authorized inventory");
  return [...new Set(preferred)];
}
async function chooseRpc(defs) {
  const urls = loadCandidateUrls();
  for (const url of urls) {
    try {
      const x = await rpc(url, "getAccountInfo", [defs.programId, { commitment: "finalized", encoding: "base64" }], 12000);
      if (x?.value?.executable && x.value.owner === defs.upgradeableLoader) return url;
    } catch (_) {}
  }
  throw Error("no authorized Solana endpoint validated the target program");
}
async function findFinalizedBlock(url) {
  const head = Number(await rpc(url, "getSlot", [{ commitment: "finalized" }]));
  for (let slot = head; slot >= Math.max(0, head - 32); slot--) {
    const block = await rpc(url, "getBlock", [slot, { commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }]);
    if (block?.blockhash) return { slot, blockhash: block.blockhash, blockHeight: block.blockHeight ?? null, blockTime: block.blockTime ?? null, parentSlot: block.parentSlot ?? null };
  }
  throw Error("unable to bind a recent finalized block");
}
async function deploymentEvidence(url, defs, minContextSlot) {
  const p = await rpc(url, "getAccountInfo", [defs.programId, { commitment: "finalized", encoding: "base64", minContextSlot }]);
  const value = p?.value; if (!value) throw Error("program account unavailable");
  const programData = decodeData(value);
  const tag = programData.length >= 4 ? programData.readUInt32LE(0) : null;
  const linkedProgramData = tag === 2 && programData.length >= 36 ? b58(programData.subarray(4, 36)) : null;
  let pd = null;
  if (linkedProgramData) {
    const r = await rpc(url, "getAccountInfo", [linkedProgramData, { commitment: "finalized", encoding: "base64", minContextSlot }]);
    const a = r?.value; const data = decodeData(a);
    const pdTag = data.length >= 4 ? data.readUInt32LE(0) : null;
    const authorityTag = data.length >= 13 ? data.readUInt8(12) : null;
    const authority = authorityTag === 1 && data.length >= 45 ? b58(data.subarray(13, 45)) : authorityTag === 0 ? null : null;
    const payload = data.length >= 45 ? data.subarray(45) : Buffer.alloc(0);
    let trim = payload.length; while (trim && payload[trim - 1] === 0) trim--;
    const trimmed = payload.subarray(0, trim);
    pd = {
      address: linkedProgramData,
      owner: a?.owner || null,
      executable: !!a?.executable,
      loaderStateTag: pdTag,
      deployedSlot: pdTag === 3 && data.length >= 12 ? data.readBigUInt64LE(4).toString() : null,
      upgradeAuthority: authority,
      authorityOptionTag: authorityTag,
      accountDataBytes: data.length,
      accountDataSha256: sha(data),
      executablePayloadOffset: 45,
      executablePayloadBytes: payload.length,
      executablePayloadSha256: sha(payload),
      zeroTrimmedPayloadBytes: trimmed.length,
      zeroTrimmedPayloadSha256: sha(trimmed),
      elfMagicPresentAtPayloadStart: trimmed.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
    };
  }
  return {
    program: defs.programId,
    accountOwner: value.owner,
    executable: !!value.executable,
    lamports: String(value.lamports),
    accountDataBytes: programData.length,
    accountDataSha256: sha(programData),
    loaderStateTag: tag,
    programDataLink: linkedProgramData,
    programData: pd,
    linkageValid: value.owner === defs.upgradeableLoader && !!value.executable && tag === 2 && !!pd && pd.owner === defs.upgradeableLoader && pd.loaderStateTag === 3,
  };
}

const D = {
  DEPOSIT_SLOT: 136, BORROW_SLOT: 200, DEPOSITS: 96,
  LOWEST: 96 + 8 * 136,
};
D.DEPOSITED = D.LOWEST + 8;
D.BORROWS = D.DEPOSITED + 16;
D.DEBT = D.BORROWS + 5 * D.BORROW_SLOT;
D.BORROWED = D.DEBT + 16;
D.ALLOWED = D.BORROWED + 16;
D.UNHEALTHY = D.ALLOWED + 16;
const RESERVE_CONFIG = 4856;

function contains(status, mask) { return (status & mask) === mask; }
function missingFlags(status, flags) { return Object.entries(flags).filter(([k, v]) => /^[A-Z_]+$/.test(k) && !["LIQUIDATION_CHECKS", "ALL_CHECKS"].includes(k) && !contains(status, v)).map(([k]) => k); }
function parseReserve(pubkey, data, defs) {
  if (data.length !== defs.accountLayout.reserveSize) throw Error(`reserve-size:${data.length}`);
  const status = data.readUInt8(defs.accountLayout.lastUpdatePriceStatusOffset); const slot = Number(data.readBigUInt64LE(defs.accountLayout.lastUpdateSlotOffset));
  const stale = data.readUInt8(defs.accountLayout.lastUpdateStaleOffset) !== 0;
  return {
    pubkey, slot, stale, status, statusHex: `0x${status.toString(16).padStart(2, "0")}`,
    liquidationChecksAccepted: contains(status, defs.priceStatusFlags.LIQUIDATION_CHECKS),
    allChecksAccepted: contains(status, defs.priceStatusFlags.ALL_CHECKS),
    missingFlags: missingFlags(status, defs.priceStatusFlags),
    name: ascii(data, RESERVE_CONFIG + 176, 32),
    protocolLiquidationFeePct: data.readUInt8(RESERVE_CONFIG + 15),
    minLiquidationBonusBps: data.readUInt16LE(RESERVE_CONFIG + 18),
  };
}
function parseObligation(pubkey, data, reserves, contextSlot, defs) {
  // The obligation slice must cover highest_borrow_factor_pct (offset 2328, u64);
  // the legacy 2272-byte slice stopped short of it and could not evaluate the
  // debt-priority predicate. The configured slice is now the full 3344-byte account.
  const highestBorrowFactorPctOffset = defs.accountLayout.highestBorrowFactorPctOffset;
  const minimumLength = Math.max(defs.accountLayout.obligationDataSliceLength, highestBorrowFactorPctOffset + 8);
  if (data.length < minimumLength) throw Error(`obligation-slice:${data.length}`);
  const slot = Number(data.readBigUInt64LE(defs.accountLayout.lastUpdateSlotOffset));
  const stale = data.readUInt8(defs.accountLayout.lastUpdateStaleOffset) !== 0;
  const status = data.readUInt8(defs.accountLayout.lastUpdatePriceStatusOffset);
  const deposits = [], borrows = [], missingReserves = [];
  for (let i = 0; i < 8; i++) {
    const off = D.DEPOSITS + i * D.DEPOSIT_SLOT, reserve = pubkeyAt(data, off); if (reserve === ZERO_PUBKEY) continue;
    if (!reserves.has(reserve)) missingReserves.push(reserve);
    deposits.push({ reserve, marketValueUsd: sf(data, off + 40) });
  }
  for (let i = 0; i < 5; i++) {
    const off = D.BORROWS + i * D.BORROW_SLOT, reserve = pubkeyAt(data, off); if (reserve === ZERO_PUBKEY) continue;
    if (!reserves.has(reserve)) missingReserves.push(reserve);
    borrows.push({ reserve, marketValueUsd: sf(data, off + 104), borrowFactorAdjustedMarketValueUsd: sf(data, off + 120) });
  }
  const refs = [...new Set([...deposits, ...borrows].map(x => x.reserve))].map(k => reserves.get(k)).filter(Boolean);
  const allRefsSameSlot = missingReserves.length === 0 && refs.every(r => r.slot === contextSlot);
  const allRefsNotStale = missingReserves.length === 0 && refs.every(r => !r.stale);
  const allRefsLiquidationAccepted = refs.length > 0 && refs.every(r => r.liquidationChecksAccepted);
  const anyReducedReserve = refs.some(r => r.liquidationChecksAccepted && !r.allChecksAccepted);
  const debtRaw = u128(data, defs.accountLayout.borrowFactorAdjustedDebtU128Offset);
  const unhealthyRaw = u128(data, defs.accountLayout.unhealthyBorrowValueU128Offset);
  const sameSlot = slot === contextSlot;
  const reducedObligation = contains(status, defs.priceStatusFlags.LIQUIDATION_CHECKS) && !contains(status, defs.priceStatusFlags.ALL_CHECKS);
  const conservativeAggregateLtvCandidate = sameSlot && !stale && reducedObligation && allRefsSameSlot && allRefsNotStale && allRefsLiquidationAccepted && debtRaw >= unhealthyRaw && debtRaw > 0n && unhealthyRaw > 0n;
  return {
    pubkey, owner: pubkeyAt(data, 64), slot, stale, slotAgeFromContext: contextSlot - slot,
    status, statusHex: `0x${status.toString(16).padStart(2, "0")}`,
    liquidationChecksAccepted: contains(status, defs.priceStatusFlags.LIQUIDATION_CHECKS),
    allChecksAccepted: contains(status, defs.priceStatusFlags.ALL_CHECKS),
    missingFlags: missingFlags(status, defs.priceStatusFlags),
    highestBorrowFactorPct: Number(data.readBigUInt64LE(highestBorrowFactorPctOffset)),
    sameSlot, reducedObligation, anyReducedReserve, allRefsSameSlot, allRefsNotStale, allRefsLiquidationAccepted,
    borrowFactorAdjustedDebtRawU128: debtRaw.toString(), unhealthyBorrowValueRawU128: unhealthyRaw.toString(),
    depositedValueUsd: sf(data, D.DEPOSITED), borrowedValueUsd: sf(data, D.BORROWED), allowedBorrowValueUsd: sf(data, D.ALLOWED),
    conservativeAggregateLtvCandidate,
    exactOnchainEligibility: null,
    referenceHealthProven: false,
    currentDifferentialTrigger: false,
    missingReferencedReserves: [...new Set(missingReserves)], deposits, borrows,
  };
}

async function oneWindow(url, defs, minContextSlot) {
  const cfg = (size, slice) => ({ commitment: "finalized", minContextSlot, withContext: true, encoding: "base64", filters: [{ dataSize: size }, { memcmp: { offset: defs.accountLayout.marketOffset, bytes: defs.mainMarket } }], ...(slice ? { dataSlice: { offset: 0, length: slice } } : {}) });
  const calls = [
    { method: "getProgramAccounts", params: [defs.programId, cfg(defs.accountLayout.reserveSize, null)] },
    { method: "getProgramAccounts", params: [defs.programId, cfg(defs.accountLayout.obligationSize, defs.accountLayout.obligationDataSliceLength)] },
    { method: "getAccountInfo", params: [defs.mainMarket, { commitment: "finalized", minContextSlot, encoding: "base64" }] },
  ];
  const startedAt = now();
  const [rr, oo, mm] = await rpcBatch(url, calls, 900000);
  const reserveContextSlot = Number(rr?.context?.slot ?? -1), obligationContextSlot = Number(oo?.context?.slot ?? -1), marketContextSlot = Number(mm?.context?.slot ?? -1);
  const sameContext = reserveContextSlot >= 0 && reserveContextSlot === obligationContextSlot && reserveContextSlot === marketContextSlot;
  const contextSlot = sameContext ? reserveContextSlot : null;
  const reserveErrors = [], obligationErrors = [], reserves = new Map();
  for (const x of rr?.value || []) { try { reserves.set(x.pubkey, parseReserve(x.pubkey, decodeData(x.account), defs)); } catch (e) { reserveErrors.push({ pubkey: x.pubkey, reason: e.message }); } }
  const obligations = [];
  for (const x of oo?.value || []) { try { obligations.push(parseObligation(x.pubkey, decodeData(x.account), reserves, contextSlot ?? -1, defs)); } catch (e) { obligationErrors.push({ pubkey: x.pubkey, reason: e.message }); } }
  const marketData = decodeData(mm?.value);
  const authOff = defs.accountLayout.marketPermissioningAuthorityOffset, opsOff = defs.accountLayout.marketPermissionedOpsOffset;
  const permissioningAuthority = marketData.length >= authOff + 32 ? pubkeyAt(marketData, authOff) : null;
  const permissionedOps = marketData.length >= opsOff + 8 ? marketData.readBigUInt64LE(opsOff) : null;
  const isPermissionedMarket = permissioningAuthority === null ? null : permissioningAuthority !== ZERO_PUBKEY;
  const liquidateRequiresPermission = isPermissionedMarket === null || permissionedOps === null ? null : isPermissionedMarket && (permissionedOps & PERMISSION_LIQUIDATE) !== 0n;
  const debtRows = obligations.filter(x => x.borrows.length && BigInt(x.borrowFactorAdjustedDebtRawU128) > 0n);
  const sameSlotReduced = obligations.filter(x => x.sameSlot && x.reducedObligation);
  const aggregateCandidates = obligations.filter(x => x.conservativeAggregateLtvCandidate);
  const missingRefs = obligations.reduce((n, x) => n + x.missingReferencedReserves.length, 0);
  const coverageComplete = sameContext && reserveErrors.length === 0 && obligationErrors.length === 0 && missingRefs === 0 && (rr?.value || []).length > 0 && (oo?.value || []).length > 0 && marketData.length === defs.accountLayout.marketSize;
  return {
    startedAt, completedAt: now(), calls: { getProgramAccountsBatches: 1, reserveQueries: 1, obligationQueries: 1, marketQueries: 1 },
    contexts: { reserve: reserveContextSlot, obligation: obligationContextSlot, market: marketContextSlot, sameContext, contextSlot },
    coverage: {
      reserveRowsReturned: (rr?.value || []).length, reserveRowsParsed: reserves.size, reserveParseErrors: reserveErrors,
      obligationRowsReturned: (oo?.value || []).length, obligationRowsParsed: obligations.length, obligationParseErrors: obligationErrors,
      debtRows: debtRows.length, missingReferencedReserveCount: missingRefs, marketDataBytes: marketData.length,
      rpcSnapshotCompleteForReturnedProgramAccounts: coverageComplete,
      independentCompletenessCrossCheck: null,
      complete: coverageComplete,
    },
    marketPermissioning: { authority: permissioningAuthority, permissionedOps: permissionedOps?.toString() ?? null, isPermissionedMarket, liquidateRequiresPermission, permissionlessLiquidation: liquidateRequiresPermission === false },
    counts: {
      sameSlotReducedStatusObligations: sameSlotReduced.length,
      sameSlotReducedStatusReserves: [...reserves.values()].filter(x => contextSlot !== null && x.slot === contextSlot && x.liquidationChecksAccepted && !x.allChecksAccepted).length,
      reducedStatusAcceptedRows: sameSlotReduced.filter(x => x.liquidationChecksAccepted).length,
      fullStatusRejectedRows: sameSlotReduced.filter(x => !x.allChecksAccepted).length,
      conservativeAggregateLtvCandidateRows: aggregateCandidates.length,
      exactOnchainEligibilityRows: null,
      referenceHealthProvenRows: 0,
      reducedVsFullDifferentialLiquidatableRows: 0,
    },
    sameSlotReducedStatusObligations: sameSlotReduced,
    conservativeAggregateLtvCandidateRows: aggregateCandidates,
    exactOnchainEligibilityRows: null,
    currentDifferentialRows: [],
    stopPolicyActivated: sameSlotReduced.length === 0,
    stopReason: sameSlotReduced.length === 0 ? "no same-slot reduced-status obligation in the single finalized observation" : "same-slot reduced status observed; reference-health proof remains required",
  };
}

function run(cmd, args, cwd, timeout) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 50 * 1024 * 1024 });
  return { command: `${cmd} ${args.join(" ")}`, exitCode: r.status, signal: r.signal || null, error: r.error ? sanitize(r.error.message) : null, output: sanitize(`${r.stdout || ""}${r.stderr || ""}`) };
}
function localEvidence() {
  const test = run("cargo", ["test", "-p", "kamino_lending", "--test", "liquidation_price_status", "--locked", "--offline", "--features", "no-entrypoint"], TARGET, 900000);
  const rustc = run("rustc", ["--version", "--verbose"], TARGET, 30000);
  const cargo = run("cargo", ["--version"], TARGET, 30000);
  const sbf = run("cargo-build-sbf", ["--version"], TARGET, 30000);
  const solana = run("solana", ["--version"], TARGET, 30000);
  const gitHead = run("git", ["rev-parse", "HEAD"], TARGET, 30000);
  const gitStatus = run("git", ["status", "--porcelain"], TARGET, 30000);
  const passedTests = [...test.output.matchAll(/test ([^ ]+) \.\.\. ok/g)].map(m => m[1]);
  return {
    test: { ...test, passed: test.exitCode === 0 && /test result: ok/i.test(test.output), passedTestNames: passedTests, expectedTestCount: 5 },
    toolchain: { rustc: rustc.exitCode === 0 ? rustc.output.trim() : null, cargo: cargo.exitCode === 0 ? cargo.output.trim() : null, cargoBuildSbfAvailable: sbf.exitCode === 0, cargoBuildSbfVersion: sbf.exitCode === 0 ? sbf.output.trim() : null, solanaCliAvailable: solana.exitCode === 0, solanaCliVersion: solana.exitCode === 0 ? solana.output.trim() : null },
    git: { head: gitHead.exitCode === 0 ? gitHead.output.trim() : null, clean: gitStatus.exitCode === 0 ? gitStatus.output.trim() === "" : null, status: gitStatus.exitCode === 0 ? gitStatus.output.trim().split(/\r?\n/).filter(Boolean) : null },
  };
}

function buildSourceEvidence(local) {
  const records = Object.fromEntries(Object.entries(SOURCE_FILES).map(([k, p]) => [k, sourceRecord(p)]));
  return {
    generatedAt: now(), stage: NAME, sourceRecords: records,
    cargoLock: { ...records.lock, packageEntries: (readRel(SOURCE_FILES.lock).toString("utf8").match(/^\[\[package\]\]$/gm) || []).length },
    exactFinding: {
      liquidationChecks: "0x23: PRICE_LOADED | PRICE_AGE_CHECKED | PRICE_USAGE_ALLOWED",
      allChecks: "0x3f",
      omitted: ["TWAP_CHECKED", "TWAP_AGE_CHECKED", "HEURISTIC_CHECKED"],
      priceValidation: "TWAP age/divergence and heuristic failures leave flags unset but get_validated_price still returns Some with the spot price/status.",
      refreshPropagation: "refresh_obligation intersects deposit and borrow price states and writes the reduced intersection to obligation.last_update.",
      liquidationUse: "assert_obligation_liquidatable checks repay reserve, withdraw reserve, and obligation with LIQUIDATION_CHECKS rather than ALL_CHECKS.",
      fullCheckContrast: "check_obligation_fully_refreshed_and_not_null requires ALL_CHECKS.",
      lastUpdateFreshness: "LastUpdate::is_stale rejects stale!=false, slot age >= 1, or missing minimum price-status flags.",
      aggregateLtvBoundary: "The LTV-exceeded path rejects only user_ltv < max_allowed_ltv, so equality is eligible at this predicate; raw u128 comparison must use borrow_factor_adjusted_debt_value_sf >= unhealthy_borrow_value_sf without Number conversion.",
      exactEligibilityConstraints: "Exact LTV-exceeded eligibility also requires price-triggered liquidation enabled, highest-borrow-factor debt-reserve priority, lowest-liquidation-LTV collateral-reserve priority, and the complete instruction/liquidation-reason constraints.",
      accountConstraints: "refresh_obligation has no signer account; liquidation requires the caller-controlled liquidator signer and may additionally require the market permissioning authority only when LIQUIDATE is configured as permissioned.",
    },
    excerpts: {
      flags: lines(SOURCE_FILES.lastUpdate, 27, 49),
      validation: lines(SOURCE_FILES.checks, 40, 101),
      refreshPropagation: lines(SOURCE_FILES.operations, 1917, 1924),
      fullAndLiquidationChecks: lines(SOURCE_FILES.operations, 4044, 4125),
      lastUpdateFreshness: lines(SOURCE_FILES.lastUpdate, 55, 113),
      liquidationPriorityAndDisablement: lines(SOURCE_FILES.liquidationOperations, 223, 273),
      refreshAccounts: lines(SOURCE_FILES.refreshHandler, 70, 78),
      liquidatorAccounts: lines(SOURCE_FILES.liquidateHandler, 274, 345),
      permissionCheck: lines(SOURCE_FILES.market, 503, 531),
    },
    localTest: { command: local.test.command, exitCode: local.test.exitCode, passed: local.test.passed, passedTestNames: local.test.passedTestNames, expectedTestCount: local.test.expectedTestCount },
  };
}

function leakScan(files) {
  const rows = files.map(file => {
    const s = fs.readFileSync(file, "utf8");
    return { file: rel(file), urlHits: (s.match(URL_RE) || []).length, secretTokenHits: (s.match(SECRET_VALUE_RE) || []).length + (s.match(BEARER_VALUE_RE) || []).length };
  });
  return { rows, passed: rows.every(x => x.urlHits === 0 && x.secretTokenHits === 0) };
}
function reportMd(a) {
  const s = a.scan, d = a.deployment, h = s.historicalObservation, cov = s.coverage;
  return `# 🟠 WATCH — Kamino Reduced-Price-Status Liquidation Recertification\n\n` +
`Evidence revision: \`${a.runId}\`  \nOriginal observation run: \`${a.observationRunId}\`  \nFinalized observation: slot \`${a.fixedObservation.slot}\`, blockhash \`${a.fixedObservation.blockhash}\`\n\n` +
`## Classification\n\n**${a.classification}**\n\n- route/fork/executable/signing: \`${a.gates.routePositive} / ${a.gates.forkJustified} / ${a.gates.executableNow} / ${a.gates.signedActionJustified}\`\n- route-negative closure: \`${a.gates.routeNegativeClosure}\`\n- reference pricing / economics: \`${a.referencePricing} / ${a.economics}\`\n\nThe original scanner observed zero same-slot reduced-status obligations in **one** finalized window. This is a historical observation only, not independently replayable chain-wide completeness and not route-negative closure. Null policy therefore keeps the branch WATCH/COVERAGE_OPEN. No second live window was run.\n\n` +
`## Deployment and source binding\n\n| Check | Result |\n|---|---|\n| Program executable | \`${d.executable}\` |\n| UpgradeableLoader linkage | \`${d.linkageValid}\` |\n| ProgramData | \`${d.programDataLink}\` |\n| Deployment slot | \`${d.programData?.deployedSlot ?? "null"}\` |\n| ProgramData hash | \`${d.programData?.accountDataSha256 ?? "null"}\` |\n| Zero-trimmed payload hash | \`${d.programData?.zeroTrimmedPayloadSha256 ?? "null"}\` |\n| Source/runtime equivalence | \`${a.binding.sourceRuntimeEquivalence}\` |\n| Binding strength | **${a.binding.strength}** |\n\nDeployment hashes are preserved, but exact source/runtime equality remains null without a reproducible byte-matched SBF artifact.\n\n` +
`## Source semantics and eligibility correction\n\nThe reviewed source still proves the reduced-status semantic: \`LIQUIDATION_CHECKS=0x23\` omits TWAP, TWAP-age, and heuristic flags while full validation requires \`ALL_CHECKS=0x3f\` (\`last_update.rs:27-49\`, \`lending_operations.rs:4044-4125\`). The 5/5 offline regression output remains manifest-bound.\n\nThe prior “reduced-check liquidatable” label was too strong. The corrected model is **conservative aggregate-LTV candidate** only. It requires same slot, \`LastUpdate.stale == false\` for the obligation and referenced reserves, reduced status, and raw-u128 \`borrow_factor_adjusted_debt_value_sf >= unhealthy_borrow_value_sf\` (equality included; no lossy Number conversion). Exact onchain eligibility additionally depends on price-trigger disablement and selected debt/collateral priority checks (\`liquidation_operations.rs:223-239,260-273\`). Those account/market predicates were not retained, so exact onchain eligibility is \`null\`; exact differential is \`null\`.\n\nMain Market permissioning in retained decoded metadata: \`liquidateRequiresPermission=${s.marketPermissioning.liquidateRequiresPermission}\`.\n\n` +
`## Retained one-window evidence\n\n| Item | Retained value | Evidentiary status |\n|---|---:|---|\n| Shared provider context | \`${s.contexts.contextSlot}\` | historical RPC metadata |\n| Reserves returned / parsed | \`${h.providerRows.reservesReturned} / ${h.providerRows.reservesParsed}\` | original scanner aggregate |\n| Obligations returned / parsed | \`${h.providerRows.obligationsReturned} / ${h.providerRows.obligationsParsed}\` | original scanner aggregate |\n| Debt rows | \`${h.aggregateCounts.debtRows}\` | historical count; exact offline replayability null |\n| Same-slot reduced obligations | \`${h.aggregateCounts.sameSlotReducedStatusObligations}\` | observed once; per-account replay null |\n| Provider-returned rows parsed | \`${cov.providerReturnedRowsParsedInOriginalObservation}\` | observed, not chain-wide completeness |\n| Independently proven chain-wide completeness | \`${cov.independentlyProvenChainWideCompleteness}\` | null |\n| Per-account transcript retained | \`${cov.perAccountTranscriptAvailable}\` | no |\n| Exact onchain eligibility | \`${s.eligibility.exactOnchainEligibility}\` | null |\n| Reference-health differential | \`${s.eligibility.exactDifferential}\` | null |\n\nNo raw account bytes or compact per-account transcript were retained. Accordingly, \`complete\`, exact debt-row replayability, stale predicates, raw-u128 comparisons, price-trigger disablement, and reserve-priority predicates are all null for this historical observation.\n\n` +
`## Blockers\n\n- ${a.blockers.join("\n- ")}\n\nNo endpoint output, transaction, simulation, signing, wallet, key, broadcast, fork, executor, mutation, or fund movement occurred during this evidence-only revision.\n`;
}

function handoffMd(a) {
  const h = a.scan.historicalObservation;
  return `# ${NAME} handoff\n\nEvidence revision \`${a.runId}\` reuses original finalized slot \`${a.fixedObservation.slot}\` / \`${a.fixedObservation.blockhash}\`; no second live window was run.\n\nClassification: **${a.classification}**. The original scanner aggregate observed same-slot reduced obligations=${h.aggregateCounts.sameSlotReducedStatusObligations} once, but raw account bytes/transcript were not retained, independent chain-wide completeness is null, exact onchain eligibility is null, reference pricing is null, and economics is null. This is not route-negative closure. Source semantics and 5/5 test output remain manifest-bound; ProgramData evidence is preserved with source/runtime equivalence null. Route/fork/executable/signing=false/false/false/false.\n\nBlockers: ${a.blockers.join(" ")} No aggregate/state files were modified.\n`;
}

function generatedFiles() {
  return [DEFINITIONS, __filename, path.join(OUT.sources, "test-output.txt"), path.join(OUT.sources, "source-evidence.json"), path.join(OUT.sources, "deployment-evidence.json"), path.join(OUT.sources, "live-window.json"), OUT.raw, OUT.report, OUT.handoff];
}

function nullPolicyChecks(artifact) {
  const checks = {
    classificationWatchCoverageOpen: artifact.classification === "WATCH/COVERAGE_OPEN/NO_CURRENT_DIFFERENTIAL_OBSERVED",
    sourceRuntimeEquivalenceNull: artifact.binding.sourceRuntimeEquivalence === null,
    independentCompletenessNull: artifact.scan.coverage.independentlyProvenChainWideCompleteness === null,
    coverageCompleteNull: artifact.scan.coverage.complete === null,
    exactEligibilityNull: artifact.scan.eligibility.exactOnchainEligibility === null,
    exactDifferentialNull: artifact.scan.eligibility.exactDifferential === null,
    referencePricingNull: artifact.referencePricing === null,
    economicsNull: artifact.economics === null,
    noRouteClosure: artifact.gates.routeNegativeClosure === false,
    actionGatesClosed: [artifact.gates.routePositive, artifact.gates.forkJustified, artifact.gates.executableNow, artifact.gates.signedActionJustified].every(x => x === false),
    oneWindowOnly: artifact.scan.calls.getProgramAccountsBatches === 1,
    rawAccountTranscriptAbsent: artifact.scan.coverage.perAccountTranscriptAvailable === false && artifact.scan.coverage.rawAccountDataRetained === false,
  };
  return { checks, passed: Object.values(checks).every(Boolean) };
}

function verifySourceRecords(source) {
  const rows = Object.values(source.sourceRecords).map(expected => {
    const actual = sourceRecord(expected.file);
    return { file: expected.file, expectedSha256: expected.sha256, actualSha256: actual.sha256, matches: expected.bytes === actual.bytes && expected.sha256 === actual.sha256 };
  });
  return { rows, passed: rows.every(x => x.matches) };
}

function writeManifest(artifact, generatedBeforeManifest, offlineRebuild = false) {
  const leak = leakScan(generatedBeforeManifest);
  const syntax = run(process.execPath, ["--check", __filename], ROOT, 30000);
  const nullPolicy = nullPolicyChecks(artifact);
  const sourceInputs = verifySourceRecords(artifact.source);
  const manifest = {
    schemaVersion: 2, generatedAt: now(), runId: artifact.runId, observationRunId: artifact.observationRunId, stage: NAME,
    files: generatedBeforeManifest.map(record),
    verification: {
      syntaxCheckPassed: syntax.exitCode === 0,
      deterministicOfflineSourceInputs: sourceInputs,
      sourceTestBound: artifact.local.test.passed && artifact.local.test.passedTestNames.length === artifact.local.test.expectedTestCount,
      deploymentLinkage: artifact.deployment.linkageValid,
      finalPinRecheck: !!artifact.fixedObservation.finalRecheck?.sameBlockhash && !!artifact.fixedObservation.finalRecheck?.stillFinalized,
      exactlyOneLiveWindow: artifact.scan.calls.getProgramAccountsBatches === 1,
      offlineArtifactRebuild: offlineRebuild,
      noLiveCallsDuringRevision: offlineRebuild,
      nullPolicy,
      leakScan: leak,
    },
  };
  writeJson(OUT.manifest, manifest);
  return record(OUT.manifest).sha256;
}

function rebuildExisting() {
  if (!fs.existsSync(OUT.raw)) throw Error("existing stage artifact unavailable for offline rebuild");
  const artifact = JSON.parse(fs.readFileSync(OUT.raw, "utf8"));
  const observationRunId = artifact.observationRunId || artifact.runId.replace(/-evidence-r2$/, "");
  const oldScan = artifact.scan;
  const oldCoverage = oldScan.coverage;
  const oldCounts = oldScan.historicalObservation?.aggregateCounts || oldScan.counts;
  const mp = artifact.scan?.marketPermissioning;
  if (!mp) throw Error("existing market permissioning evidence unavailable");
  const isPermissionedMarket = mp.authority === null ? null : mp.authority !== ZERO_PUBKEY;
  const permissionedOps = mp.permissionedOps === null ? null : BigInt(mp.permissionedOps);
  const liquidateRequiresPermission = isPermissionedMarket === null || permissionedOps === null ? null : isPermissionedMarket && (permissionedOps & PERMISSION_LIQUIDATE) !== 0n;
  const historicalObservation = oldScan.historicalObservation || {
    evidentiaryStatus: "retained aggregate output from the original one finalized provider window; no per-account transcript",
    providerRows: {
      reservesReturned: oldCoverage.reserveRowsReturned,
      reservesParsed: oldCoverage.reserveRowsParsed,
      obligationsReturned: oldCoverage.obligationRowsReturned,
      obligationsParsed: oldCoverage.obligationRowsParsed,
    },
    aggregateCounts: {
      debtRows: oldCoverage.debtRows,
      missingReferencedReserveCount: oldCoverage.missingReferencedReserveCount,
      sameSlotReducedStatusObligations: oldCounts.sameSlotReducedStatusObligations,
      sameSlotReducedStatusReserves: oldCounts.sameSlotReducedStatusReserves,
      reducedStatusAcceptedRows: oldCounts.reducedStatusAcceptedRows,
      fullStatusRejectedRows: oldCounts.fullStatusRejectedRows,
      priorModeledEligibilityRows: oldCounts.onchainReducedCheckLiquidatableRows ?? null,
      referenceHealthProvenRows: oldCounts.referenceHealthProvenRows,
      differentialRows: oldCounts.reducedVsFullDifferentialLiquidatableRows,
    },
  };
  artifact.observationRunId = observationRunId;
  artifact.runId = `${observationRunId}-evidence-r2`;
  artifact.evidenceRevision = 2;
  artifact.revisionReason = "Independent oracle remediation using retained artifacts only; no second live window.";
  artifact.generatedAt = now();
  artifact.classification = "WATCH/COVERAGE_OPEN/NO_CURRENT_DIFFERENTIAL_OBSERVED";
  artifact.referencePricing = null;
  artifact.economics = null;
  artifact.gates = {
    routePositive: false, forkJustified: false, executableNow: false, signedActionJustified: false,
    currentDifferentialProven: false, localReplayRecommended: false, routeNegativeClosure: false,
    zeroSameSlotReducedStatusObservedInSingleWindow: historicalObservation.aggregateCounts.sameSlotReducedStatusObligations === 0,
  };
  artifact.scan = {
    startedAt: oldScan.startedAt,
    completedAt: oldScan.completedAt,
    calls: oldScan.calls,
    contexts: oldScan.contexts,
    marketPermissioning: { ...mp, isPermissionedMarket, liquidateRequiresPermission, permissionlessLiquidation: liquidateRequiresPermission === false },
    historicalObservation,
    coverage: {
      providerReturnedRowsParsedInOriginalObservation: oldCoverage.providerReturnedRowsParsedInOriginalObservation ?? (historicalObservation.providerRows.reservesReturned === historicalObservation.providerRows.reservesParsed && historicalObservation.providerRows.obligationsReturned === historicalObservation.providerRows.obligationsParsed),
      providerSnapshotCompletenessClaim: null,
      independentlyProvenChainWideCompleteness: null,
      independentCompletenessCrossCheck: null,
      rawAccountDataRetained: false,
      perAccountTranscriptAvailable: false,
      exactOfflineReplayAvailable: false,
      exactDebtRowCountReplayable: null,
      complete: null,
    },
    eligibility: {
      modeledName: "conservative aggregate-LTV candidate",
      modeledDefinition: "same context/slot; obligation and referenced reserve LastUpdate.stale=false; LIQUIDATION_CHECKS accepted; at least one ALL_CHECKS omission; raw borrow_factor_adjusted_debt_value_sf >= raw unhealthy_borrow_value_sf",
      conservativeAggregateLtvCandidateCount: null,
      exactOnchainEligibility: null,
      exactDifferential: null,
      predicateEvidence: {
        lastUpdateStaleFalse: null,
        rawU128DebtGteUnhealthyIncludingEquality: null,
        priceTriggeredLiquidationEnabled: null,
        selectedDebtHighestBorrowFactor: null,
        selectedCollateralLowestLiquidationLtv: null,
        fullReferencePriceHealthyOrNonLiquidatable: null,
      },
    },
    replayedCounts: {
      sameSlotReducedStatusObligations: null,
      conservativeAggregateLtvCandidates: null,
      exactOnchainEligibleRows: null,
      exactDifferentialRows: null,
    },
    sameSlotReducedStatusObligations: null,
    conservativeAggregateLtvCandidateRows: null,
    exactOnchainEligibilityRows: null,
    currentDifferentialRows: null,
    stopPolicyActivated: true,
    stopReason: "the original scanner aggregate observed no same-slot reduced-status obligation in one finalized window; no retained per-account transcript permits exact offline replay",
  };
  artifact.local.test.output = sanitize(artifact.local.test.output);
  artifact.source = buildSourceEvidence(artifact.local);
  artifact.blockers = [
    "Exact deployed SBF build reproduction is unavailable; source/runtime equivalence remains null.",
    "No raw account bytes or compact per-account transcript were retained, so independent chain-wide completeness, LastUpdate.stale predicates, raw-u128 comparisons, exact debt-row replay, and exact zero-trigger replay remain null.",
    "The retained market/account evidence does not reproduce price-trigger disablement or selected debt/collateral priority predicates; exact onchain eligibility remains null.",
    "No same-observation external reference pricing was retained; reference health and exact differential remain null.",
    "Economics remain null under the one-shot stop policy; the single observed zero is not route-negative closure.",
  ];
  atomic(path.join(OUT.sources, "test-output.txt"), `${artifact.local.test.output}\n`);
  writeJson(path.join(OUT.sources, "source-evidence.json"), artifact.source);
  writeJson(path.join(OUT.sources, "deployment-evidence.json"), { evidenceRevision: artifact.evidenceRevision, runId: artifact.runId, observationRunId: artifact.observationRunId, preservedFromOriginalObservation: true, fixedObservation: artifact.fixedObservation, deployment: artifact.deployment, binding: artifact.binding });
  writeJson(path.join(OUT.sources, "live-window.json"), artifact.scan);
  writeJson(OUT.raw, artifact);
  atomic(OUT.report, reportMd(artifact));
  atomic(OUT.handoff, handoffMd(artifact));
  const generatedBeforeManifest = generatedFiles();
  const manifestSha256 = writeManifest(artifact, generatedBeforeManifest, true);
  console.log(JSON.stringify({ runId: artifact.runId, observationRunId, slot: artifact.fixedObservation.slot, classification: artifact.classification, testsPassed: artifact.local.test.passed, historicalObservedSameSlotReducedObligations: historicalObservation.aggregateCounts.sameSlotReducedStatusObligations, replayedSameSlotReducedObligations: artifact.scan.replayedCounts.sameSlotReducedStatusObligations, exactOnchainEligibility: artifact.scan.eligibility.exactOnchainEligibility, exactDifferential: artifact.scan.eligibility.exactDifferential, referencePricing: artifact.referencePricing, economics: artifact.economics, manifestSha256, offlineRebuild: true, changedFiles: [...generatedBeforeManifest.map(rel), rel(OUT.manifest)] }, null, 2));
}

function verifyExisting() {
  const manifest = JSON.parse(fs.readFileSync(OUT.manifest, "utf8"));
  const artifact = JSON.parse(fs.readFileSync(OUT.raw, "utf8"));
  const fileRows = manifest.files.map(expected => {
    const actual = record(path.join(ROOT, expected.file));
    return { file: expected.file, matches: actual.bytes === expected.bytes && actual.sha256 === expected.sha256 };
  });
  const result = {
    runId: artifact.runId,
    manifestSha256: record(OUT.manifest).sha256,
    manifestFileHashesPassed: fileRows.every(x => x.matches),
    manifestFileRows: fileRows,
    nullPolicy: nullPolicyChecks(artifact),
    leakScan: leakScan(manifest.files.map(x => path.join(ROOT, x.file))),
    sourceRecords: verifySourceRecords(artifact.source),
    noLiveCalls: true,
  };
  const passed = result.manifestFileHashesPassed && result.nullPolicy.passed && result.leakScan.passed && result.sourceRecords.passed;
  console.log(JSON.stringify({ ...result, passed }, null, 2));
  if (!passed) process.exitCode = 1;
}

async function main() {
  if (process.argv.includes("--verify-existing")) return verifyExisting();
  if (process.argv.includes("--rebuild-existing") || process.argv.includes("--revise-existing")) return rebuildExisting();
  throw Error("one-shot live window already consumed; only offline --revise-existing is permitted");
  /* istanbul ignore next -- retained solely as provenance for the already-consumed one-shot collector. */
  const defs = JSON.parse(fs.readFileSync(DEFINITIONS, "utf8"));
  const startedAt = now();
  const local = localEvidence();
  fs.mkdirSync(OUT.sources, { recursive: true });
  atomic(path.join(OUT.sources, "test-output.txt"), `${local.test.output}\n`);
  const source = buildSourceEvidence(local);
  writeJson(path.join(OUT.sources, "source-evidence.json"), source);

  const url = await chooseRpc(defs);
  const initialPin = await findFinalizedBlock(url);
  const deployment = await deploymentEvidence(url, defs, initialPin.slot);
  const scan = await oneWindow(url, defs, initialPin.slot); // exactly one Main Market GPA batch
  const observationSlot = scan.contexts.contextSlot;
  let observedBlock = null, finalRecheck = null;
  if (observationSlot !== null) {
    observedBlock = await rpc(url, "getBlock", [observationSlot, { commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }]);
    const again = await rpc(url, "getBlock", [observationSlot, { commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }]);
    const finalSlot = Number(await rpc(url, "getSlot", [{ commitment: "finalized" }]));
    finalRecheck = { slot: observationSlot, blockhash: again?.blockhash || null, finalizedHeadAtRecheck: finalSlot, sameBlockhash: !!observedBlock?.blockhash && observedBlock.blockhash === again?.blockhash, stillFinalized: finalSlot >= observationSlot };
  }
  const fixedObservation = { slot: observationSlot, blockhash: observedBlock?.blockhash || null, blockHeight: observedBlock?.blockHeight ?? null, blockTime: observedBlock?.blockTime ?? null, parentSlot: observedBlock?.parentSlot ?? null, commitment: "finalized", finalRecheck };
  const sourceRuntimeEquivalence = local.toolchain.cargoBuildSbfAvailable ? null : null;
  const bindingStrength = deployment.linkageValid && deployment.programData?.elfMagicPresentAtPayloadStart ? "DEPLOYMENT_HASH_BOUND/SOURCE_SEMANTICS_SEPARATE" : "WATCH/DEPLOYMENT_BINDING_INCOMPLETE";
  const coverageOpen = !scan.coverage.complete || !fixedObservation.blockhash || !finalRecheck?.sameBlockhash || !finalRecheck?.stillFinalized || !deployment.linkageValid;
  const noCurrent = scan.counts.sameSlotReducedStatusObligations === 0 && scan.counts.reducedVsFullDifferentialLiquidatableRows === 0;
  const classification = coverageOpen ? "WATCH/COVERAGE_OPEN/NO_CURRENT_ROUTE_PROOF" : noCurrent ? "DORMANT/NO_CURRENT_DIFFERENTIAL" : "WATCH/REDUCED_STATUS_PRESENT/REFERENCE_GATE_OPEN";
  const blockers = [];
  if (sourceRuntimeEquivalence === null) blockers.push("Exact deployed SBF build reproduction is unavailable; source/runtime equivalence remains null.");
  if (!scan.coverage.complete) blockers.push("Single-snapshot RPC/account coverage is incomplete; missing coverage is not treated as zero.");
  if (noCurrent) blockers.push("The one finalized observation contains no same-slot reduced-status obligation, so the mandated stop policy blocks economics and local replay.");
  if (!noCurrent) blockers.push("Any reduced-status row still requires same-observation external reference pricing proving healthy/non-liquidatable status under full checks before it can be a differential trigger.");
  const runId = `${NAME}-${fixedObservation.slot ?? "no-slot"}-${sha(Buffer.from(stable({ fixedObservation, deployment: deployment.programData?.zeroTrimmedPayloadSha256, counts: scan.counts }))).slice(0, 16)}`;
  const artifact = {
    generatedAt: now(), startedAt, runId, stage: NAME, definitions: rel(DEFINITIONS),
    safety: { readOnly: true, authorizedEndpointInventoryUsedInMemory: true, endpointValuesPersisted: false, endpointDomainsPersisted: false, endpointHeadersPersisted: false, transactions: false, simulationSend: false, signing: false, wallet: false, privateKeys: false, broadcast: false, fork: false, executor: false, fundMovement: false },
    fixedObservation, deployment,
    binding: { strength: bindingStrength, sourceRuntimeEquivalence, exactDeployedBuildReproduced: false, reason: "No exact local SBF artifact was produced and compared; current ProgramData linkage and payload hashes are recorded separately from reviewed source semantics." },
    source, local, scan,
    economics: noCurrent ? null : null,
    classification,
    gates: { routePositive: false, forkJustified: false, executableNow: false, signedActionJustified: false, currentDifferentialProven: false, localReplayRecommended: false },
    blockers,
  };
  writeJson(path.join(OUT.sources, "deployment-evidence.json"), { fixedObservation, deployment, binding: artifact.binding });
  writeJson(path.join(OUT.sources, "live-window.json"), scan);
  writeJson(OUT.raw, artifact);
  atomic(OUT.report, reportMd(artifact));
  atomic(OUT.handoff, handoffMd(artifact));

  const generatedBeforeManifest = generatedFiles();
  const manifestSha256 = writeManifest(artifact, generatedBeforeManifest, false);
  console.log(JSON.stringify({ runId, slot: fixedObservation.slot, classification, bindingStrength, testsPassed: local.test.passed, reserves: scan.coverage.reserveRowsParsed, obligations: scan.coverage.obligationRowsParsed, sameSlotReducedObligations: scan.counts.sameSlotReducedStatusObligations, differentialRows: scan.counts.reducedVsFullDifferentialLiquidatableRows, economics: artifact.economics, manifestSha256, changedFiles: [...generatedBeforeManifest.map(rel), rel(OUT.manifest)] }, null, 2));
}

main().catch(e => { console.error(`${NAME}: ${sanitize(e.message)}`); process.exitCode = 1; });
