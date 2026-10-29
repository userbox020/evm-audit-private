#!/usr/bin/env node
"use strict";

// Observation only. Network access requires --once --live. No signer/provider SDK.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { Interface } = require("./node_modules/ethers");
const ROOT = path.resolve(__dirname, ".."), SCHEMA = "aave-v3-borrower-watch/v1";
const OUT = path.join(ROOT, "reports/raw/fast/aave-v3-borrower-watch");
const OUTPUT = path.join(ROOT, "reports/monitor/aave-v3-borrower-watch.json");
const FIXTURES = path.join(__dirname, "aave-v3-borrower-watch.fixtures.json");
const SOURCE = path.join(ROOT, "bounded-research/2026-10-17-aave-v3-borrower-hf.json");
const SEED = path.join(ROOT, "bounded-research/2026-10-17-aave-v3-borrower-seed/seed-ethereum.json");
const ARB_SEED = path.join(ROOT, "bounded-research/2026-10-17-aave-v3-borrower-seed/seed-arbitrum.json");
const OPT_SEED = path.join(ROOT, "bounded-research/2026-10-17-aave-v3-borrower-seed/seed-optimism.json");
const POLY_SEED = path.join(ROOT, "bounded-research/2026-10-17-aave-v3-borrower-seed/seed-polygon.json");
const MAX_REQUESTS = 40, MAX_MS = 120000, RESPONSE_BOUND = 2 * 1024 * 1024;
const WAD = 10n ** 18n, MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const ENFORCEMENT = "Observation-only standing watch on Aave V3 borrowers. It does NOT sign, deploy, simulate, or execute liquidations. Outputs are evidence for review; any execution requires separate explicit authorization. **The watch is not fork proof and does not establish an executable liquidation.**";
const CHAINS = {
  1: { name: "Ethereum", pool: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2", rpc: "https://ethereum.publicnode.com/" },
  10: { name: "Optimism", pool: "0x794a61358d6845594f94dc1db02a252b5b4814ad", rpc: "https://optimism-rpc.publicnode.com/" },
  137: { name: "Polygon", pool: "0x794a61358d6845594f94dc1db02a252b5b4814ad", rpc: "https://polygon-bor-rpc.publicnode.com/" },
  8453: { name: "Base", pool: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5", rpc: "https://base-rpc.publicnode.com/" },
  // Finalized-state failures remain incomplete; no proxy, retry or fallback.
  42161: { name: "Arbitrum", pool: "0x794a61358d6845594f94dc1db02a252b5b4814ad", rpc: "https://arbitrum-one-rpc.publicnode.com/" },
};
const ACCOUNT = new Interface(["function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)"]);
// aggregate3 is invoked exclusively through eth_call, with allowlisted nested getters.
const MULTI = new Interface(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)"]);
const CODES = new Set(["INVALID_ARGUMENTS", "CHAIN_MISMATCH", "PIN_INVALID", "PIN_DRIFT", "READ_INVALID", "READ_FAILED", "PARTIAL_READ", "RPC_FAILURE", "RPC_SHAPE_INVALID", "RESPONSE_BOUND_EXCEEDED", "METHOD_REJECTED", "RPC_BUDGET_EXCEEDED", "USER_CALL_CAP_EXCEEDED", "TIME_BUDGET_EXCEEDED", "SANITIZATION_FAILED", "ARTIFACT_EXISTS", "OFFLINE_TEST_FAILED"]);
const fail = (code) => { throw new Error(code); };
const safeCode = (error) => CODES.has(error?.message) ? error.message : "RPC_FAILURE";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, "/");
const isHash = (v) => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
const isQuantity = (v) => typeof v === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v);
const safety = () => ({ readOnly: true, signing: false, submission: false, deployment: false, stateMutation: false, simulation: false, forkExecution: false, routePositive: false, executableNow: false, signedActionJustified: false, alertDispatch: false, rpcUrlsStored: false, endpointUrlsStored: false, keysRead: false, authMaterialStored: false });
function jsonBytes(value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (/(?:https?|wss?):\/\/|authorization\s*:|bearer\s|[?&](?:key|token)=/i.test(text)) fail("SANITIZATION_FAILED");
  return Buffer.from(text);
}
function decimal(value, decimals = 18) {
  value = BigInt(value); const scale = 10n ** BigInt(decimals);
  return `${value / scale}.${(value % scale).toString().padStart(decimals, "0")}`;
}
function validateList(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 108) fail("INVALID_ARGUMENTS");
  const seen = new Set(), perUser = new Map();
  return list.map((row) => {
    const chainId = row?.chainId, chain = CHAINS[chainId];
    if (!chain || !Number.isInteger(chainId) || typeof row.user !== "string" || !/^0x[0-9a-f]{40}$/i.test(row.user)
        || /^0x0{40}$/i.test(row.user) || typeof row.market !== "string" || row.market.toLowerCase() !== chain.pool) fail("INVALID_ARGUMENTS");
    const user = row.user.toLowerCase(), market = row.market.toLowerCase(), key = `${chainId}:${market}:${user}`;
    if (seen.has(key)) fail("INVALID_ARGUMENTS"); seen.add(key);
    perUser.set(user, (perUser.get(user) ?? 0) + 1);
    if (perUser.get(user) > 4) fail("USER_CALL_CAP_EXCEEDED");
    return { chainId, chain: chain.name, market, user };
  });
}
function defaultList() {
  const source = JSON.parse(fs.readFileSync(SOURCE)), seed = JSON.parse(fs.readFileSync(SEED)), arbSeed = JSON.parse(fs.readFileSync(ARB_SEED));
  const list = validateList(source.rows.map((r) => ({ chainId: r.chain_id, market: r.market, user: r.user })));
  if (list.length !== 27 || seed.oracle_base_currency_unit !== "100000000") fail("INVALID_ARGUMENTS");
  const ethereum = list.filter((r) => r.chainId === 1);
  if (ethereum.length !== seed.borrower_market_pairs.length || ethereum.some((r) => !seed.borrower_market_pairs.some((s) => s.borrower.toLowerCase() === r.user && s.market_address.toLowerCase() === r.market))) fail("INVALID_ARGUMENTS");
  const arbitrum = list.filter((r) => r.chainId === 42161);
  if (arbitrum.length !== 2 || arbitrum.length !== arbSeed.borrower_market_pairs.length || arbitrum.some((r) => !arbSeed.borrower_market_pairs.some((s) => s.borrower.toLowerCase() === r.user && s.market_address.toLowerCase() === r.market))) fail("INVALID_ARGUMENTS");
  return list;
}
function allFourChainsList() {
  const selected = defaultList(), users = [...new Set(selected.map((r) => r.user))];
  if (users.length !== 27) fail("INVALID_ARGUMENTS");
  const ethereumUsers = new Set(selected.filter((r) => r.chainId === 1).map((r) => r.user));
  const additional = [[10, OPT_SEED], [137, POLY_SEED]].flatMap(([chainId, file]) => {
    const seed = JSON.parse(fs.readFileSync(file));
    if (seed.chain_id !== chainId || seed.oracle_base_currency_unit !== "100000000" || !Array.isArray(seed.borrower_market_pairs) || seed.borrower_market_pairs.length !== 27) fail("INVALID_ARGUMENTS");
    return seed.borrower_market_pairs.map((r) => ({ chainId, market: r.market_address, user: r.borrower }));
  });
  // Ethereum has 25 discovered seed pairs; retain the two explicit Arbitrum-seed projections.
  return validateList([...selected, ...users.filter((user) => !ethereumUsers.has(user)).map((user) => ({ chainId: 1, market: CHAINS[1].pool, user })),
    ...additional]);
}
function chainRpc(chainId) {
  return CHAINS[chainId].rpc;
}
function classify(hf) {
  hf = BigInt(hf);
  return hf <= WAD ? "LIQUIDATABLE" : hf <= 110n * WAD / 100n ? "NEAR_LIQUIDATION" : hf <= 150n * WAD / 100n ? "ABOVE_WATCH_THRESHOLD" : "HEALTHY";
}
function decodeAccount(raw) {
  if (typeof raw !== "string" || !/^0x[0-9a-f]{384}$/i.test(raw)) fail("READ_INVALID");
  let result;
  try { result = ACCOUNT.decodeFunctionResult("getUserAccountData", raw); } catch (_) { fail("READ_INVALID"); }
  if (ACCOUNT.encodeFunctionResult("getUserAccountData", result).toLowerCase() !== raw.toLowerCase() || result[3] > 10000n || result[4] > 10000n) fail("READ_INVALID");
  const [collateral, debt, available, threshold, ltv, hf] = result;
  return { status: "COMPLETE", reason: null, verdict: classify(hf), hfWad: hf.toString(), hf: decimal(hf),
    debtRaw: debt.toString(), debtBase: decimal(debt, 8), collateralRaw: collateral.toString(), collateralBase: decimal(collateral, 8),
    availableBorrowsRaw: available.toString(), currentLiquidationThresholdBps: threshold.toString(), ltvBps: ltv.toString(),
    noDebt: debt === 0n, protocolLiquidatableAtPin: debt > 0n && hf < WAD,
    read: { returnData: raw, sha256: sha(Buffer.from(raw.slice(2), "hex")) } };
}
function batchData(rows) {
  return MULTI.encodeFunctionData("aggregate3", [rows.map((r) => [r.market, true, ACCOUNT.encodeFunctionData("getUserAccountData", [r.user])])]);
}
function checkCall(params, chainId, rows, pin) {
  const call = params?.[0], block = params?.[1];
  if (params.length !== 2 || !call || Object.keys(call).sort().join(",") !== "data,to" || !pin?.valid
      || block?.blockHash !== pin.hash || block.requireCanonical !== true || Object.keys(block).sort().join(",") !== "blockHash,requireCanonical") fail("METHOD_REJECTED");
  const chainRows = rows.filter((r) => r.chainId === chainId);
  // Exact precomputed calldata binds every nested target, selector and user.
  if (call.to !== MULTICALL3 || call.data !== batchData(chainRows)) fail("METHOD_REJECTED");
}
function liveSend(rpcUrl) {
  let url; try { url = new URL(rpcUrl); } catch (_) { fail("INVALID_ARGUMENTS"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) fail("INVALID_ARGUMENTS");
  return async (method, params, id, timeoutMs) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id }), signal: controller.signal, redirect: "error" });
      if (!response.ok || !response.body) fail("RPC_FAILURE");
      const chunks = [], reader = response.body.getReader(); let length = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength; if (length > RESPONSE_BOUND) { controller.abort(); fail("RESPONSE_BOUND_EXCEEDED"); }
        chunks.push(Buffer.from(value));
      }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) { fail("RPC_SHAPE_INVALID"); }
      if (!body || Array.isArray(body) || body.jsonrpc !== "2.0" || body.id !== id || body.error || !Object.hasOwn(body, "result")) fail("RPC_SHAPE_INVALID");
      return body.result;
    } catch (error) { throw new Error(controller.signal.aborted ? "TIME_BUDGET_EXCEEDED" : safeCode(error)); }
    finally { clearTimeout(timer); }
  };
}
function validHeader(h) {
  return h && isQuantity(h.number) && isHash(h.hash) && isQuantity(h.timestamp)
    && Number.isSafeInteger(Number(BigInt(h.number))) && Number.isSafeInteger(Number(BigInt(h.timestamp)));
}
function rank(borrowers) {
  return borrowers.filter((r) => r.status === "COMPLETE").sort((a, b) => BigInt(a.hfWad) < BigInt(b.hfWad) ? -1 : BigInt(a.hfWad) > BigInt(b.hfWad) ? 1 : a.user.localeCompare(b.user));
}
function rowSummary(r) {
  return { chain: r.chain, chainId: r.chainId, market: r.market, user: r.user, status: r.status, reason: r.reason,
    hfWad: r.hfWad ?? null, hf: r.hf ?? null, verdict: r.verdict, debtRaw: r.debtRaw ?? null, debtBase: r.debtBase ?? null, noDebt: r.noDebt ?? null };
}
async function capture({ watchList = allFourChainsList(), mode = "dry-run", sendByChain = {}, rpcUrl = null, rpcUrls = {}, fixtureId = null, now = () => performance.now() } = {}) {
  watchList = validateList(watchList);
  if (!["live", "dry-run"].includes(mode)) fail("INVALID_ARGUMENTS");
  const started = now(), ledger = [], calledUsers = new Map();
  const value = { schema: SCHEMA, kind: "LiveWatch", generatedAt: new Date().toISOString(), runId: crypto.randomBytes(8).toString("hex"), mode, fixtureId,
    identity: { producer: "tools/aave-v3-borrower-watch.js", protocol: "Aave V3", selection: "seed-addresses-with-per-chain-projections-or-bounded-configured-list", watchListSha256: sha(jsonBytes(watchList)) },
    status: "INCOMPLETE", reason: null, pins: {},
    provenance: { provider: mode === "live" ? "per-chain-public-or-explicit-provider-redacted" : "synthetic-fixture", explicitRpcChainId: null,
      explicitRpcChainIds: Object.keys(rpcUrls).map(Number), sources: [SOURCE, SEED, ARB_SEED, ...(watchList.some((r) => r.chainId === 10) ? [OPT_SEED] : []), ...(watchList.some((r) => r.chainId === 137) ? [POLY_SEED] : [])].map((f) => ({ path: rel(f), sha256: sha(fs.readFileSync(f)) })),
      fixturePath: fixtureId ? rel(FIXTURES) : null, fixtureSha256: fixtureId ? sha(fs.readFileSync(FIXTURES)) : null,
      method: "getUserAccountData(address) via Multicall3 aggregate3 eth_call; one getter per selected user/chain/Pool tuple",
      batching: "one batch per chain, including all same-chain markets for each user; cross-chain calls never share a pin or Multicall",
      baseCurrency: "USD oracle base, 8 decimals for the allowlisted Pools; static metadata, not a per-token debt amount", baseCurrencyDecimals: 8,
      hfDecimals: 18, thresholdPolicy: "HF <= 1: LIQUIDATABLE watch bucket; 1 < HF <= 1.10: NEAR_LIQUIDATION; 1.10 < HF <= 1.50: ABOVE_WATCH_THRESHOLD; HF > 1.50: HEALTHY",
      limitations: "Bounded seed list, not protocol-wide or a refreshed top ranking. Ethereum rows from Arbitrum seeds, and Optimism and Polygon rows restored from prior captures into per-chain seed files, are seed-address projections, not borrower discovery. HF is returned verbatim by Pool. Zero debt is flagged and excluded from closest; even all-zero returns follow the requested HF bucket. Protocol liquidation requires debt and strictly HF < 1; the watch bucket includes equality. No liquidation eligibility, route, fees or profitability proof.",
      callBinding: "independent finalized header per chain; EIP-1898 blockHash + requireCanonical; numbered header hash recheck; no fallback or retry" },
    borrowers: watchList.map((r) => ({ ...r, status: "INCOMPLETE", verdict: "INCOMPLETE", reason: "READ_FAILED" })),
    rankedBorrowerSummary: [], crossSectionSummary: null, closestToLiquidation: null,
    enforcement: ENFORCEMENT, safety: safety(), timing: { maxMs: MAX_MS, durationMs: 0, completedAt: null },
    diagnostics: { rpcCount: 0, networkRequestCount: 0, maxRequests: MAX_REQUESTS, retries: 0, perUserCallCap: 4, perUserGetterCounts: {}, ledger } };
  const check = () => { if (now() - started >= MAX_MS) fail("TIME_BUDGET_EXCEEDED"); };
  async function rpc(send, chainId, method, params) {
    check();
    if (!["eth_chainId", "eth_getBlockByNumber", "eth_call"].includes(method)) fail("METHOD_REJECTED");
    if (method === "eth_chainId" && params.length !== 0) fail("METHOD_REJECTED");
    if (method === "eth_getBlockByNumber" && (params.length !== 2 || params[1] !== false || !(params[0] === "finalized" || params[0] === value.pins[chainId]?.numberHex))) fail("METHOD_REJECTED");
    if (method === "eth_call") {
      checkCall(params, chainId, watchList, value.pins[chainId]);
      for (const r of watchList.filter((r) => r.chainId === chainId)) {
        const count = (calledUsers.get(r.user) ?? 0) + 1; if (count > 4) fail("USER_CALL_CAP_EXCEEDED"); calledUsers.set(r.user, count);
      }
    }
    if (ledger.length >= MAX_REQUESTS) fail("RPC_BUDGET_EXCEEDED");
    const entry = { ordinal: ledger.length + 1, chainId, method, status: "PENDING", durationMs: 0 }; ledger.push(entry);
    const start = now();
    try {
      const result = await send(method, params, entry.ordinal, Math.max(1, Math.min(15000, MAX_MS - (now() - started))));
      check(); entry.status = "OK"; return result;
    } catch (error) { entry.status = safeCode(error); throw new Error(entry.status); }
    finally { entry.durationMs = Math.max(0, Math.round(now() - start)); }
  }
  const sends = new Map(), verified = new Set();
  try {
    if (rpcUrl && mode === "live") {
      const send = liveSend(rpcUrl), id = await rpc(send, null, "eth_chainId", []);
      if (!isQuantity(id) || !CHAINS[Number(BigInt(id))]) fail("CHAIN_MISMATCH");
      const chainId = Number(BigInt(id)); sends.set(chainId, send); verified.add(chainId); value.provenance.explicitRpcChainId = chainId;
    }
    for (const chainId of [...new Set(watchList.map((r) => r.chainId))]) {
      const rows = value.borrowers.filter((r) => r.chainId === chainId);
      const pin = { requested: "finalized", number: null, numberHex: null, hash: null, timestamp: null, valid: false, rechecked: false, chainIdVerified: false };
      value.pins[chainId] = pin;
      try {
        check(); const send = sendByChain[chainId] ?? sends.get(chainId) ?? (mode === "live" ? liveSend(rpcUrls[chainId] ?? chainRpc(chainId)) : null);
        if (!send) fail("READ_FAILED");
        if (!verified.has(chainId)) {
          const id = await rpc(send, chainId, "eth_chainId", []);
          if (!isQuantity(id) || BigInt(id) !== BigInt(chainId)) fail("CHAIN_MISMATCH");
        }
        pin.chainIdVerified = true;
        const header = await rpc(send, chainId, "eth_getBlockByNumber", ["finalized", false]);
        if (!validHeader(header)) fail("PIN_INVALID");
        Object.assign(pin, { number: Number(BigInt(header.number)), numberHex: header.number, hash: header.hash.toLowerCase(), timestamp: Number(BigInt(header.timestamp)), valid: true });
        const raw = await rpc(send, chainId, "eth_call", [{ to: MULTICALL3, data: batchData(rows) }, { blockHash: pin.hash, requireCanonical: true }]);
        let results;
        try {
          if (typeof raw !== "string" || raw.length > RESPONSE_BOUND || !/^0x[0-9a-f]+$/i.test(raw)) fail("READ_INVALID");
          [results] = MULTI.decodeFunctionResult("aggregate3", raw);
          if (results.length !== rows.length || MULTI.encodeFunctionResult("aggregate3", [results]).toLowerCase() !== raw.toLowerCase()) fail("READ_INVALID");
        } catch (_) { fail("READ_INVALID"); }
        for (let i = 0; i < rows.length; i++) {
          try { if (!results[i].success) fail("READ_FAILED"); Object.assign(rows[i], decodeAccount(results[i].returnData)); }
          catch (error) { rows[i].reason = safeCode(error); }
        }
        const recheck = await rpc(send, chainId, "eth_getBlockByNumber", [pin.numberHex, false]);
        if (!validHeader(recheck) || recheck.hash.toLowerCase() !== pin.hash || recheck.number !== pin.numberHex || Number(BigInt(recheck.timestamp)) !== pin.timestamp) fail("PIN_DRIFT");
        pin.rechecked = true;
      } catch (error) {
        const reason = safeCode(error); pin.valid = false;
        for (const row of rows) { row.status = "INCOMPLETE"; row.verdict = "INCOMPLETE"; row.reason = reason; }
      }
    }
    check();
    value.status = value.borrowers.every((r) => r.status === "COMPLETE") ? "COMPLETE" : "INCOMPLETE";
    value.reason = value.status === "COMPLETE" ? null : "PARTIAL_READ";
  } catch (error) { value.reason = safeCode(error); }
  value.rankedBorrowerSummary = [...rank(value.borrowers), ...value.borrowers.filter((r) => r.status !== "COMPLETE")].map(rowSummary);
  const closest = rank(value.borrowers).find((r) => !r.noDebt);
  value.closestToLiquidation = closest ? { ...rowSummary(closest), partialCrossSection: value.status !== "COMPLETE", scope: "selected complete non-zero-debt borrowers only" } : null;
  value.crossSectionSummary = { count: value.borrowers.length, completeCount: value.borrowers.filter((r) => r.status === "COMPLETE").length,
    incompleteCount: value.borrowers.filter((r) => r.status !== "COMPLETE").length, partial: value.status !== "COMPLETE",
    verdictCounts: Object.fromEntries(["LIQUIDATABLE", "NEAR_LIQUIDATION", "ABOVE_WATCH_THRESHOLD", "HEALTHY", "INCOMPLETE"].map((v) => [v, value.borrowers.filter((r) => r.verdict === v).length])),
    nonZeroObservationsForReview: value.borrowers.filter((r) => r.status === "COMPLETE" && !r.noDebt && ["LIQUIDATABLE", "NEAR_LIQUIDATION"].includes(r.verdict)).map(rowSummary) };
  value.diagnostics.rpcCount = ledger.length; value.diagnostics.networkRequestCount = mode === "live" ? ledger.length : 0;
  value.diagnostics.perUserGetterCounts = Object.fromEntries(calledUsers);
  value.timing.durationMs = Math.max(0, Math.round(now() - started)); value.timing.completedAt = new Date().toISOString();
  jsonBytes(value); return value;
}
function atomicJson(file, value, replace = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`, bytes = jsonBytes(value); let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (replace) fs.renameSync(temporary, file);
    else { try { fs.linkSync(temporary, file); } catch (error) { if (error.code === "EEXIST") fail("ARTIFACT_EXISTS"); throw error; } }
    return { sha256: sha(bytes), bytes: bytes.length };
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch (_) { /* renamed/removed */ } }
}
function persist(value, latest = false) {
  const file = path.join(OUT, `${value.generatedAt.replace(/[-:.]/g, "")}-${value.mode ?? "offline-test"}-${value.runId}.json`);
  const digest = atomicJson(file, value), artifactPath = rel(file);
  atomicJson(file.replace(/\.json$/, ".manifest.json"), { schema: "aave-v3-borrower-watch-manifest/v1", artifact: artifactPath, ...digest, enforcement: ENFORCEMENT, safety: safety() });
  if (latest) {
    const date = new Date(value.generatedAt), nextDueAt = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
    atomicJson(OUTPUT, { ...value, artifactPath, artifactSha256: digest.sha256,
      cadence: { utc: "00:00", nextDueAt, registration: "external daily gate required; no scheduler registered by producer" },
      freshness: { validUntil: nextDueAt, liveObservation: value.mode === "live" } }, true);
  }
  return artifactPath;
}
function readPrevious(mode) {
  try {
    const value = JSON.parse(fs.readFileSync(OUTPUT)); jsonBytes(value);
    if (value.schema !== SCHEMA || value.mode !== mode || value.enforcement !== ENFORCEMENT || !/^reports\/raw\/fast\/aave-v3-borrower-watch\/[^/]+\.json$/.test(value.artifactPath)) return null;
    const file = path.join(ROOT, value.artifactPath), bytes = fs.readFileSync(file), manifest = JSON.parse(fs.readFileSync(file.replace(/\.json$/, ".manifest.json")));
    jsonBytes(manifest);
    if (sha(bytes) !== value.artifactSha256 || manifest.sha256 !== value.artifactSha256 || manifest.artifact !== value.artifactPath || manifest.bytes !== bytes.length || manifest.enforcement !== ENFORCEMENT) return null;
    const artifact = JSON.parse(bytes); jsonBytes(artifact);
    if (artifact.schema !== SCHEMA || artifact.mode !== mode || artifact.enforcement !== ENFORCEMENT || Date.parse(artifact.generatedAt) > Date.now()) return null;
    return { ...artifact, artifactPath: value.artifactPath, artifactSha256: value.artifactSha256, freshness: value.freshness };
  } catch (_) { return null; }
}
function freshStatus(watchList = allFourChainsList()) {
  const v = readPrevious("live");
  return v?.status === "COMPLETE" && v.identity.watchListSha256 === sha(jsonBytes(validateList(watchList)))
    && v.generatedAt.slice(0, 10) === new Date().toISOString().slice(0, 10) && Date.parse(v.freshness?.validUntil) > Date.now()
    && Object.values(v.pins).every((p) => p.valid && p.rechecked && p.chainIdVerified) && v.diagnostics.rpcCount <= MAX_REQUESTS
    && JSON.stringify(v.safety) === JSON.stringify(safety()) ? v : null;
}
function parseArgs(argv) {
  const options = { once: false, live: false, refresh: false, offlineTest: false, defaultTop27: false, allFourChains: true, rpcUrl: null, rpcUrls: {} };
  const flags = { "--once": "once", "--live": "live", "--refresh": "refresh", "--offline-test": "offlineTest", "--default-top-27": "defaultTop27", "--all-4-chains": "allFourChains", "--composite-81": "allFourChains", "--composite-83": "allFourChains" };
  const rpcFlags = { "--rpc-url-eth": 1, "--rpc-url-arb": 42161, "--rpc-url-opt": 10, "--rpc-url-poly": 137 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rpc-url") { if (options.rpcUrl || !argv[i + 1]) fail("INVALID_ARGUMENTS"); options.rpcUrl = argv[++i]; liveSend(options.rpcUrl); }
    else if (rpcFlags[arg]) { const chainId = rpcFlags[arg]; if (options.rpcUrls[chainId] || !argv[i + 1]) fail("INVALID_ARGUMENTS"); options.rpcUrls[chainId] = argv[++i]; liveSend(options.rpcUrls[chainId]); }
    else { if (!flags[arg]) fail("INVALID_ARGUMENTS"); options[flags[arg]] = true; }
  }
  if ((options.live && !options.once) || (options.offlineTest && options.live) || (options.defaultTop27 && (argv.includes("--all-4-chains") || argv.includes("--composite-81") || argv.includes("--composite-83"))) || (options.rpcUrl && Object.keys(options.rpcUrls).length)) fail("INVALID_ARGUMENTS");
  if (options.defaultTop27) options.allFourChains = false;
  return options;
}
function fixtureSetup(fixture) {
  const watchList = validateList(fixture.rows.map((r) => ({ chainId: r.chainId, market: CHAINS[r.chainId].pool, user: `0x${r.userNumber.toString(16).padStart(40, "0")}` })));
  const sendByChain = {}, requests = [];
  for (const chainId of new Set(watchList.map((r) => r.chainId))) {
    const header = { number: `0x${(100000 + chainId).toString(16)}`, hash: `0x${chainId.toString(16).padStart(64, "0")}`, timestamp: "0x6ad00000" };
    sendByChain[chainId] = async (method, params) => {
      requests.push({ chainId, method, params });
      if (fixture.failure === "rpc") throw new Error("https://redacted.invalid?key=not-a-real-key");
      if (method === "eth_chainId") return `0x${(fixture.failure === "chain" ? 999 : chainId).toString(16)}`;
      if (method === "eth_getBlockByNumber") {
        if (fixture.failure === "pin") return null;
        return fixture.failure === "drift" && params[0] !== "finalized" ? { ...header, hash: `0x${"f".repeat(64)}` } : header;
      }
      assert.equal(method, "eth_call"); assert.deepEqual(params[1], { blockHash: header.hash, requireCanonical: true });
      assert.equal(params[0].to, MULTICALL3); assert.equal(params[0].data, batchData(watchList.filter((r) => r.chainId === chainId)));
      const results = fixture.rows.filter((r) => r.chainId === chainId).map((r) => [r.success !== false, r.malformed ? "0x12" : ACCOUNT.encodeFunctionResult("getUserAccountData", r.values ?? ["200000000", "100000000", "0", "8000", "7500", r.hf])]);
      return MULTI.encodeFunctionResult("aggregate3", [results]);
    };
  }
  return { watchList, sendByChain, requests };
}
async function offlineTest() {
  const fixtures = JSON.parse(fs.readFileSync(FIXTURES)), cases = [], captures = [], networkFetch = globalThis.fetch; let networkAttempts = 0;
  globalThis.fetch = () => { networkAttempts++; fail("METHOD_REJECTED"); };
  try {
    for (const fixture of fixtures.cases) {
      try {
        const setup = fixtureSetup(fixture), value = await capture({ ...setup, fixtureId: fixture.id }); captures.push(value);
        assert.equal(value.status, fixture.expectedStatus); assert.deepEqual(value.borrowers.map((r) => r.verdict), fixture.expectedVerdicts);
        assert.equal(value.borrowers.length, fixture.rows.length); assert.equal(value.diagnostics.networkRequestCount, 0);
        assert.ok(value.diagnostics.rpcCount <= MAX_REQUESTS); assert.ok(Object.values(value.diagnostics.perUserGetterCounts).every((n) => n <= 4));
        assert.equal(value.enforcement, ENFORCEMENT); assert.deepEqual(value.safety, safety());
        if (fixture.expectedClosestUserNumber !== undefined) assert.equal(value.closestToLiquidation?.user ?? null, fixture.expectedClosestUserNumber === null ? null : `0x${fixture.expectedClosestUserNumber.toString(16).padStart(40, "0")}`);
        if (fixture.expectedStatus === "COMPLETE") {
          assert.equal(value.diagnostics.rpcCount, new Set(setup.watchList.map((r) => r.chainId)).size * 4);
          assert.ok(Object.values(value.pins).every((p) => p.valid && p.rechecked && p.chainIdVerified));
          for (let i = 0; i < fixture.rows.length; i++) {
            const expected = fixture.rows[i].values;
            assert.equal(value.borrowers[i].hfWad, expected ? expected[5] : fixture.rows[i].hf);
            assert.equal(value.borrowers[i].debtRaw, expected ? expected[1] : "100000000");
          }
        }
        assert.ok(!JSON.stringify(value).includes("redacted.invalid"));
        cases.push({ id: fixture.id, passed: true });
      } catch (_) { cases.push({ id: fixture.id, passed: false }); }
    }
    const test = (id, fn) => { try { fn(); cases.push({ id, passed: true }); } catch (_) { cases.push({ id, passed: false }); } };
    test("cli-live-requires-once", () => { assert.throws(() => parseArgs(["--live"])); assert.throws(() => parseArgs(["--once", "--live", "--offline-test"])); assert.throws(() => parseArgs(["--rpc-url", "invalid"])); assert.throws(() => parseArgs(["--sign"])); });
    test("duplicate-and-wrong-market-rejected", () => { const r = fixtureSetup(fixtures.cases[0]).watchList[0]; assert.throws(() => validateList([r, r])); assert.throws(() => validateList([{ ...r, market: CHAINS[8453].pool }])); });
    test("sanitization-and-call-allowlist", () => { assert.throws(() => jsonBytes({ endpoint: "https://private.invalid" }), /SANITIZATION_FAILED/); assert.throws(() => checkCall([{ to: MULTICALL3, data: "0x" }, {}], 1, [], null), /METHOD_REJECTED/); });
    test("default-27-seed-identities", () => { const list = defaultList(); assert.equal(list.length, 27); assert.equal(list.filter((r) => r.chainId === 1).length, 25); assert.equal(list.filter((r) => r.chainId === 42161).length, 2); });
    test("daily-83-seed-projections-and-cli", () => {
      const selected = defaultList(), list = allFourChainsList();
      assert.equal(list.length, 83); assert.deepEqual(list.slice(0, 27), selected);
      for (const chainId of [1, 10, 137]) assert.deepEqual(list.filter((r) => r.chainId === chainId).map((r) => r.user), selected.map((r) => r.user));
      assert.equal(parseArgs([]).allFourChains, true); assert.equal(parseArgs(["--default-top-27"]).allFourChains, false);
      assert.equal(parseArgs(["--all-4-chains"]).allFourChains, true); assert.equal(parseArgs(["--composite-81"]).defaultTop27, false);
      assert.throws(() => parseArgs(["--all-4-chains", "--default-top-27"]));
      assert.throws(() => validateList([...list, { chainId: 8453, market: CHAINS[8453].pool, user: selected[25].user }]), /USER_CALL_CAP_EXCEEDED/);
    });
    test("composite-83-captured-seed-files-and-cli", () => {
      const list = allFourChainsList();
      assert.equal(parseArgs(["--composite-83"]).allFourChains, true);
      assert.throws(() => parseArgs(["--composite-83", "--default-top-27"]));
      for (const [chainId, file] of [[10, OPT_SEED], [137, POLY_SEED]]) {
        const seed = JSON.parse(fs.readFileSync(file));
        assert.deepEqual(list.filter((r) => r.chainId === chainId), validateList(seed.borrower_market_pairs.map((r) => ({ chainId, market: r.market_address, user: r.borrower }))));
      }
    });
    test("per-chain-endpoint-cli-validation", () => {
      const args = ["--rpc-url-eth", CHAINS[1].rpc, "--rpc-url-arb", CHAINS[42161].rpc, "--rpc-url-opt", CHAINS[10].rpc, "--rpc-url-poly", CHAINS[137].rpc];
      assert.deepEqual(parseArgs(args).rpcUrls, Object.fromEntries([1, 42161, 10, 137].map((id) => [id, CHAINS[id].rpc])));
      assert.throws(() => parseArgs(["--rpc-url-opt"]));
      assert.throws(() => parseArgs(["--rpc-url-poly", "invalid"]));
      assert.throws(() => parseArgs([...args, "--rpc-url-eth", CHAINS[1].rpc]));
      assert.throws(() => parseArgs([...args, "--rpc-url", CHAINS[1].rpc]));
    });
    test("hash-canonical-binding-remains-strict", () => {
      const rows = defaultList().filter((r) => r.chainId === 42161), pin = { valid: true, hash: `0x${"a".repeat(64)}`, numberHex: "0x123" };
      const call = { to: MULTICALL3, data: batchData(rows) };
      checkCall([call, { blockHash: pin.hash, requireCanonical: true }], 42161, rows, pin);
      assert.throws(() => checkCall([call, pin.numberHex], 42161, rows, pin), /METHOD_REJECTED/);
      assert.throws(() => checkCall([call, { blockHash: pin.hash, requireCanonical: false }], 42161, rows, pin), /METHOD_REJECTED/);
    });
    try {
      const rows = allFourChainsList().map((r) => ({ chainId: r.chainId, userNumber: BigInt(r.user), hf: "2000000000000000000" }));
      const setup = fixtureSetup({ rows }), value = await capture({ ...setup, fixtureId: "daily-83-bounded-capture" }); captures.push(value);
      assert.equal(value.status, "COMPLETE"); assert.equal(value.crossSectionSummary.completeCount, 83); assert.equal(value.crossSectionSummary.incompleteCount, 0);
      assert.equal(value.diagnostics.rpcCount, 16); assert.equal(value.diagnostics.networkRequestCount, 0);
      assert.equal(Object.values(value.diagnostics.perUserGetterCounts).filter((n) => n === 3).length, 25);
      assert.equal(Object.values(value.diagnostics.perUserGetterCounts).filter((n) => n === 4).length, 2);
      assert.ok(Object.values(value.pins).every((p) => p.valid && p.rechecked && p.chainIdVerified));
      cases.push({ id: "daily-83-bounded-capture", passed: true });
    } catch (_) { cases.push({ id: "daily-83-bounded-capture", passed: false }); }
    // Exercise the actual per-chain resolver and transport, but never the network.
    const blockedFetch = globalThis.fetch;
    for (const scenario of ["defaults", "overrides", "arbitrum-unavailable", "wrong-chain"]) {
      try {
        const fixture = fixtures.cases.find((f) => f.id === "four-chain-native-projections"), setup = fixtureSetup(fixture);
        const rpcUrls = scenario === "defaults" ? {} : Object.fromEntries([1, 42161, 10, 137].map((id) => [id, `${CHAINS[id].rpc}offline-only`]));
        const routes = new Map([1, 42161, 10, 137].map((id) => [rpcUrls[id] ?? chainRpc(id), id]));
        globalThis.fetch = async (url, options) => {
          const chainId = routes.get(String(url)); assert.ok(chainId);
          const request = JSON.parse(options.body); let result;
          if (scenario === "arbitrum-unavailable" && chainId === 42161 && request.method === "eth_call") {
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: CHAINS[chainId].rpc } }));
          }
          if (scenario === "wrong-chain" && chainId === 10 && request.method === "eth_chainId") result = "0x1";
          else result = await setup.sendByChain[chainId](request.method, request.params);
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
        };
        const value = await capture({ watchList: setup.watchList, mode: "live", rpcUrls });
        assert.equal(value.status, ["defaults", "overrides"].includes(scenario) ? "COMPLETE" : "INCOMPLETE");
        assert.ok(value.diagnostics.rpcCount <= 16);
        for (const row of value.borrowers) {
          const reason = scenario === "arbitrum-unavailable" && row.chainId === 42161 ? "RPC_SHAPE_INVALID" : scenario === "wrong-chain" && row.chainId === 10 ? "CHAIN_MISMATCH" : null;
          assert.equal(row.reason, reason); assert.equal(row.status, reason ? "INCOMPLETE" : "COMPLETE");
        }
        assert.doesNotMatch(JSON.stringify(value), /https?:\/\/|offline-only/);
        cases.push({ id: `chain-routing-${scenario}`, passed: true });
      } catch (_) { cases.push({ id: `chain-routing-${scenario}`, passed: false }); }
      finally { globalThis.fetch = blockedFetch; }
    }
    test("zero-network-fetch-attempts", () => assert.equal(networkAttempts, 0));
    const report = { schema: "aave-v3-borrower-watch-offline-test/v1", generatedAt: new Date().toISOString(), runId: crypto.randomBytes(8).toString("hex"), passed: cases.every((c) => c.passed), cases, captures, enforcement: ENFORCEMENT, safety: safety() };
    const artifactPath = persist(report);
    process.stdout.write(JSON.stringify({ passed: report.passed, passCount: cases.filter((c) => c.passed).length, total: cases.length, artifactPath, rpcCount: 0, networkAttempts, cases, enforcement: ENFORCEMENT }) + "\n");
    if (!report.passed) fail("OFFLINE_TEST_FAILED");
  } finally { globalThis.fetch = networkFetch; }
}
async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv); if (options.offlineTest) return offlineTest();
  const watchList = options.allFourChains ? allFourChainsList() : defaultList();
  if (options.live && !options.refresh) {
    const cached = freshStatus(watchList);
    if (cached) { process.stdout.write(JSON.stringify({ status: cached.status, mode: "live", reused: true, artifactPath: cached.artifactPath, rpcCount: 0, crossSectionSummary: cached.crossSectionSummary, closestToLiquidation: cached.closestToLiquidation, enforcement: ENFORCEMENT }) + "\n"); return; }
  }
  let input;
  if (options.live) input = { watchList, mode: "live", rpcUrl: options.rpcUrl, rpcUrls: options.rpcUrls };
  else {
    const fixture = JSON.parse(fs.readFileSync(FIXTURES)).cases.find((f) => f.id === (options.allFourChains ? "four-chain-native-projections" : "multi-chain-separate-pins"));
    input = { ...fixtureSetup(fixture), fixtureId: fixture.id };
  }
  const value = await capture(input), prior = readPrevious("live");
  const artifactPath = persist(value, options.live || !prior);
  process.stdout.write(JSON.stringify({ status: value.status, reason: value.reason, mode: value.mode, artifactPath, rpcCount: value.diagnostics.rpcCount, durationMs: value.timing.durationMs, pins: value.pins, crossSectionSummary: value.crossSectionSummary, closestToLiquidation: value.closestToLiquidation, enforcement: ENFORCEMENT }) + "\n");
  if (value.status !== "COMPLETE") process.exitCode = 1;
}
module.exports = { main, capture, defaultList, allFourChainsList, validateList, classify, decodeAccount, parseArgs, fixtureSetup, offlineTest, persist, readPrevious, freshStatus, OUTPUT, OUT, FIXTURES, SCHEMA, ENFORCEMENT, MAX_MS, MAX_REQUESTS };
if (require.main === module) main().catch((error) => { process.stdout.write(JSON.stringify({ status: "INCOMPLETE", reason: safeCode(error), enforcement: ENFORCEMENT, safety: safety() }) + "\n"); process.exitCode = 1; });
