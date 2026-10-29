#!/usr/bin/env node
"use strict";

// Read-only adapter runner. Adapters are trusted local code, never downloaded.
// Required adapter methods (invoked with a pair-local `this` context):
//   readMarketTotal(marketId, EIP1898Block) -> { lltv, ...protocolFields }
//   readPosition(marketId, borrower, EIP1898Block) -> { debt, collateral }
//   readOraclePrice(marketId, EIP1898Block) -> protocol-normalized price
//   computeHF(debt, collateral, price, lltv) -> JSON-safe metrics containing
//     hf (decimal string|null), hfWad (integer string|null), noDebt, verdict.
// Context: { config, transport, pin, reads }. Optional createAdapter(context)
// can bind ABI helpers; allowCall(call, config) must whitelist read selectors
// for eth_call. Optional fixtureSend(config) enables synthetic CLI captures.
// Config: { chainId, watchList: [{marketId, borrower, label}], ...adapterFields }.
// A legacy array watch-list is merged with adapter.default without schema changes.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const ROOT = path.resolve(__dirname, ".."), MAX_MS = 120000;
const SCHEMA = "multi-borrower-watch/v1";
const ENFORCEMENT = "Observation only. No signing, deployment, simulation, transactions, or fund movement. Not execution proof.";
const fail = (code) => { throw new Error(code); };
const CODES = new Set(["INVALID_ARGUMENTS", "ADAPTER_INVALID", "CHAIN_MISMATCH", "PIN_INVALID", "PIN_NOT_FINALIZED", "PIN_DRIFT", "MARKET_PARAMS_INVALID", "READ_INVALID", "MARKET_INVALID", "RPC_UNAVAILABLE", "RPC_FAILURE", "RPC_SHAPE_INVALID", "RESPONSE_BOUND_EXCEEDED", "METHOD_REJECTED", "RPC_BUDGET_EXCEEDED", "TIME_BUDGET_EXCEEDED", "SANITIZATION_FAILED", "ARTIFACT_EXISTS", "OFFLINE_TEST_FAILED"]);
const safeCode = (error) => CODES.has(error?.message) ? error.message : "RPC_FAILURE";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, "/");
const safety = () => ({ readOnly: true, signing: false, submission: false, deployment: false, stateMutation: false, simulation: false, forkExecution: false, routePositive: false, executableNow: false, signedActionJustified: false, alertDispatch: false, rpcUrlsStored: false, keysRead: false, authMaterialStored: false });
const quantity = (v) => typeof v === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v);
const validHeader = (v) => v && quantity(v.number) && /^0x[0-9a-f]{64}$/i.test(v.hash) && quantity(v.timestamp) && Number.isSafeInteger(Number(BigInt(v.number))) && Number.isSafeInteger(Number(BigInt(v.timestamp)));
function jsonBytes(value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (/(?:https?|wss?):\/\/|authorization\s*:|bearer\s|[?&](?:key|token)=/i.test(text)) fail("SANITIZATION_FAILED");
  return Buffer.from(text);
}
function atomicJson(file, value, replace = false) {
  const bytes = jsonBytes(value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (replace) fs.renameSync(temporary, file);
    else { try { fs.linkSync(temporary, file); } catch (error) { if (error.code === "EEXIST") fail("ARTIFACT_EXISTS"); throw error; } }
    return { sha256: sha(bytes), bytes: bytes.length };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (_) { /* renamed/removed */ }
  }
}
function createTransport({ send, mode, allowCall, maxRequests = 20, maxMs = MAX_MS, now = () => performance.now() }) {
  const started = now(), ledger = [];
  maxMs = Math.min(maxMs, MAX_MS); maxRequests = Math.min(maxRequests, 25);
  const check = () => { if (now() - started >= maxMs) fail("TIME_BUDGET_EXCEEDED"); };
  return { mode, ledger, check, maxRequests, get elapsedMs() { return Math.max(0, Math.round(now() - started)); },
    async rpc(method, params) {
      check();
      if (!["eth_chainId", "eth_getBlockByNumber", "eth_call"].includes(method)) fail("METHOD_REJECTED");
      if (method === "eth_call") {
        const call = params[0], tag = params[1];
        if (!call || Object.keys(call).some((k) => !["to", "data"].includes(k)) || !/^0x[0-9a-f]{40}$/i.test(call.to)
            || !/^0x(?:[0-9a-f]{2})+$/i.test(call.data) || !tag || tag.requireCanonical !== true || !/^0x[0-9a-f]{64}$/i.test(tag.blockHash)
            || !allowCall?.(call)) fail("METHOD_REJECTED");
      }
      if (ledger.length >= maxRequests) fail("RPC_BUDGET_EXCEEDED");
      const row = { ordinal: ledger.length + 1, method, status: "PENDING", durationMs: 0 }, start = now(); ledger.push(row);
      try { const value = await send(method, params, row.ordinal, Math.min(10000, Math.max(1, maxMs - (now() - started)))); check(); row.status = "OK"; return value; }
      catch (error) { row.status = safeCode(error); throw new Error(row.status); }
      finally { row.durationMs = Math.max(0, Math.round(now() - start)); }
    } };
}
function liveSend(endpoint) {
  let url; try { url = new URL(endpoint); } catch (_) { fail("RPC_UNAVAILABLE"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) fail("RPC_UNAVAILABLE");
  return async (method, params, id, timeoutMs) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, redirect: "error", body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
      if (!response.ok || !response.body) fail("RPC_FAILURE");
      const reader = response.body.getReader(), chunks = []; let length = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 2 * 1024 * 1024) { controller.abort(); fail("RESPONSE_BOUND_EXCEEDED"); } chunks.push(Buffer.from(value)); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) { fail("RPC_SHAPE_INVALID"); }
      if (!body || Array.isArray(body) || body.jsonrpc !== "2.0" || body.id !== id || body.error || !Object.hasOwn(body, "result")) fail("RPC_SHAPE_INVALID");
      return body.result;
    } catch (error) { throw new Error(safeCode(error)); } finally { clearTimeout(timer); }
  };
}
// Share immutable calls, never canonical rechecks. Also used by the legacy adapter.
function sharedTransport(transport, block, maxRequests) {
  const cache = new Map(); let historicalHeaderRead = false, finalizedNumber = null;
  return { mode: transport.mode, ledger: transport.ledger, maxRequests, check: transport.check,
    get elapsedMs() { return transport.elapsedMs; }, resetPair() { historicalHeaderRead = false; },
    async rpc(method, params) {
      transport.check();
      const historicalHeader = block && finalizedNumber && BigInt(block) !== BigInt(finalizedNumber)
        && method === "eth_getBlockByNumber" && params[0] === block && !historicalHeaderRead;
      if (historicalHeader) historicalHeaderRead = true;
      const reusable = method === "eth_chainId" || method === "eth_call" || (method === "eth_getBlockByNumber" && params[0] === "finalized") || historicalHeader;
      const key = JSON.stringify([method, params]);
      if (reusable && cache.has(key)) return cache.get(key);
      const value = await transport.rpc(method, params);
      if (method === "eth_getBlockByNumber" && params[0] === "finalized" && validHeader(value)) finalizedNumber = value.number;
      if (reusable) cache.set(key, value);
      return value;
    } };
}
function rowSummary(entry, label) {
  const m = entry.metrics;
  return { label, marketId: entry.identity.marketId, borrower: entry.identity.borrower, status: entry.status,
    verdict: entry.trigger.status, reason: entry.reason, hf: m?.hf ?? null, hfWad: m?.hfWad ?? null,
    distancePct: m?.distancePct ?? null, oraclePriceRaw: m?.oraclePriceRaw ?? null,
    thresholdOraclePriceRaw: m?.thresholdOraclePriceRaw ?? null,
    thresholdOraclePricePerCollateral: m?.thresholdOraclePricePerCollateral ?? null,
    protocolLiquidatableAtPin: m?.protocolLiquidatableAtPin ?? null };
}
function crossPairSummary(entries, watchList, summarize = rowSummary, thresholdPolicy = "Health, equality, and threshold semantics are defined by the adapter; no-debt entries are not ranked.") {
  const pairs = entries.map((entry, i) => summarize(entry, watchList[i].label));
  const ranked = pairs.filter((row) => row.status === "COMPLETE" && row.hfWad !== null).sort((a, b) => BigInt(a.hfWad) < BigInt(b.hfWad) ? -1 : BigInt(a.hfWad) > BigInt(b.hfWad) ? 1 : 0);
  const complete = entries.every((entry) => entry.status === "COMPLETE");
  return { configured: pairs.length, captured: pairs.filter((row) => row.status === "COMPLETE").length,
    incomplete: pairs.filter((row) => row.status !== "COMPLETE").length, closestToLiquidation: ranked[0] ?? null,
    closestScope: complete ? "all-configured-pairs" : "complete-pairs-only; incomplete-pair-health-unknown", pairs, thresholdPolicy };
}
async function captureMulti({ transport, watchList, block = null, fixtureId = null, adapter }) {
  const generatedAt = new Date().toISOString(), entries = [], maxRequests = adapter.maxRequests ?? 20;
  const shared = sharedTransport(transport, block, maxRequests);
  for (const row of watchList) {
    shared.resetPair();
    entries.push(await adapter.captureEntry({ transport: shared, row, block, fixtureId }));
  }
  // A canonical drift invalidates every result, not just the pair that detected it.
  if (entries.some((entry) => entry.reason === "PIN_DRIFT")) for (const entry of entries) {
    entry.status = "INCOMPLETE"; entry.reason = "PIN_DRIFT"; entry.metrics = null; entry.pin.valid = false;
    entry.trigger = { status: "INCOMPLETE", reason: "PIN_DRIFT" }; entry.verdict = `${entry.enforcement} INCOMPLETE (PIN_DRIFT); HF unknown.`;
  }
  const complete = entries.every((entry) => entry.status === "COMPLETE");
  return { schema: adapter.schema ?? SCHEMA, kind: "MultiWatch", generatedAt, runId: crypto.randomBytes(8).toString("hex"), mode: transport.mode,
    fixtureId, status: complete ? "COMPLETE" : "INCOMPLETE", reason: entries.find((entry) => entry.reason)?.reason ?? null,
    pin: { ...entries[0].pin, valid: complete && entries.every((entry) => entry.pin.valid && entry.pin.hash === entries[0].pin.hash) },
    watchList, entries, crossPairSummary: crossPairSummary(entries, watchList, adapter.rowSummary, adapter.thresholdPolicy),
    timing: { durationMs: transport.elapsedMs, maxMs: MAX_MS },
    diagnostics: { rpcCount: transport.mode === "live" ? transport.ledger.length : 0, requestCount: transport.ledger.length, maxRpcRequests: maxRequests, retries: 0, methodLedger: [...transport.ledger] },
    enforcement: adapter.enforcement ?? ENFORCEMENT, safety: safety() };
}
function createPersistence({ root = ROOT, out, output, schema = SCHEMA, manifestSchema = "multi-borrower-watch-manifest/v1", prefix = "multi-", artifactPattern, identity = null }) {
  const relative = (file) => path.relative(root, file).replace(/\\/g, "/");
  function persist(value, latest = false) {
    const file = path.join(out, `${prefix}${value.generatedAt.replace(/[-:.]/g, "")}-b${value.pin?.number ?? "test"}-${value.runId}.json`);
    const digest = atomicJson(file, value), artifactPath = relative(file);
    atomicJson(file.replace(/\.json$/, ".manifest.json"), { schema: manifestSchema, artifact: artifactPath, ...digest, safety: safety() });
    if (latest) {
      const d = new Date(value.generatedAt), nextDueAt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
      atomicJson(output, { ...value, artifactPath, artifactSha256: digest.sha256,
        cadence: { utc: "00:00", nextDueAt, registration: "external daily gate required; no scheduler registered by producer" },
        freshness: { validUntil: nextDueAt, liveObservation: value.mode === "live" } }, true);
    }
    return artifactPath;
  }
  function freshStatus(options) {
    try {
      const value = JSON.parse(fs.readFileSync(output));
      if (value.schema !== schema || value.mode !== "live" || value.status !== "COMPLETE" || !value.pin.valid
          || (identity !== null && value.adapterIdentity !== identity)
          || JSON.stringify(value.watchList) !== JSON.stringify(options.watchList) || value.generatedAt.slice(0, 10) !== new Date().toISOString().slice(0, 10)
          || Date.parse(value.generatedAt) > Date.now() || Date.parse(value.freshness.validUntil) <= Date.now()
          || (options.block ? BigInt(value.pin.number) !== BigInt(options.block) : value.pin.requested !== "finalized")
          || !artifactPattern.test(value.artifactPath) || value.diagnostics.requestCount > (options.maxRequests ?? 20)
          || JSON.stringify(value.safety) !== JSON.stringify(safety())) return null;
      jsonBytes(value);
      const file = path.resolve(root, value.artifactPath), bytes = fs.readFileSync(file), digest = sha(bytes);
      if (path.dirname(file) !== path.resolve(out)) return null;
      const manifest = JSON.parse(fs.readFileSync(file.replace(/\.json$/, ".manifest.json")));
      return digest === value.artifactSha256 && manifest.sha256 === digest && manifest.artifact === value.artifactPath ? value : null;
    } catch (_) { return null; }
  }
  return { persist, freshStatus };
}
function parseArgs(argv) {
  const options = { live: false, once: false, refresh: false, offlineTest: false, block: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["--once", "--live", "--refresh", "--offline-test"].includes(arg)) options[{ "--once": "once", "--live": "live", "--refresh": "refresh", "--offline-test": "offlineTest" }[arg]] = true;
    else if (["--adapter", "--adapter-config", "--rpc-url"].includes(arg)) {
      const key = { "--adapter": "adapterPath", "--adapter-config": "configPath", "--rpc-url": "rpcUrl" }[arg];
      if (options[key] || !argv[i + 1] || argv[i + 1].startsWith("--")) fail("INVALID_ARGUMENTS");
      options[key] = argv[++i];
      if (key === "rpcUrl" && !/^https:\/\//i.test(options[key])) fail("INVALID_ARGUMENTS");
    } else if (arg === "--block") {
      const v = argv[++i]; if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(v || "") || BigInt(v) <= 0n || BigInt(v) > BigInt(Number.MAX_SAFE_INTEGER)) fail("INVALID_ARGUMENTS");
      options.block = `0x${BigInt(v).toString(16)}`;
    } else fail("INVALID_ARGUMENTS");
  }
  if (!options.adapterPath || !options.configPath || (options.live && !options.once) || (options.offlineTest && options.live)) fail("INVALID_ARGUMENTS");
  return options;
}
function resolveAdapter(adapterPath, configPath) {
  let adapter, supplied, modulePath, configBytes;
  try {
    modulePath = require.resolve(path.resolve(adapterPath));
    if (!/\.js$/i.test(modulePath)) fail("ADAPTER_INVALID");
    adapter = require(modulePath); configBytes = fs.readFileSync(path.resolve(configPath)); supplied = JSON.parse(configBytes);
  } catch (_) { fail("ADAPTER_INVALID"); }
  for (const name of ["readPosition", "readMarketTotal", "readOraclePrice", "computeHF"]) if (typeof adapter[name] !== "function") fail("ADAPTER_INVALID");
  if (!Array.isArray(supplied) && (!supplied || typeof supplied !== "object" || !Array.isArray(supplied.watchList))) fail("ADAPTER_INVALID");
  const defaults = adapter.default ?? {};
  const config = Array.isArray(supplied) ? { ...defaults, watchList: supplied } : { ...defaults, ...supplied };
  if (!config || !Number.isSafeInteger(config.chainId) || config.chainId <= 0 || !Array.isArray(config.watchList) || config.watchList.length < 1 || config.watchList.length > 4
      || !Number.isInteger(config.maxRequests ?? 20) || (config.maxRequests ?? 20) < 1 || (config.maxRequests ?? 20) > 25) fail("ADAPTER_INVALID");
  jsonBytes(config);
  if (adapter.validateConfig) adapter.validateConfig(config);
  const seen = new Set();
  for (const row of config.watchList) {
    if (!row || typeof row.marketId !== "string" || !row.marketId || typeof row.borrower !== "string" || !row.borrower
        || typeof row.label !== "string" || !/^[a-z0-9 _.-]{1,80}$/i.test(row.label)) fail("ADAPTER_INVALID");
    const key = JSON.stringify([row.marketId, row.borrower]); if (seen.has(key)) fail("ADAPTER_INVALID"); seen.add(key);
  }
  return { adapter, config, identity: sha(Buffer.concat([fs.readFileSync(modulePath), jsonBytes(config)])) };
}
function makeEntryAdapter(adapter, config) {
  return { maxRequests: config.maxRequests ?? 20, rowSummary: adapter.summarizePair, thresholdPolicy: adapter.thresholdPolicy,
    async captureEntry({ transport, row, block, fixtureId }) {
      const entry = { schema: "multi-borrower-watch-pair/v1", kind: "LiveWatch", identity: { chainId: config.chainId, marketId: row.marketId, borrower: row.borrower },
        mode: transport.mode, fixtureId, status: "INCOMPLETE", reason: null, reads: {}, metrics: null,
        pin: { requested: block || "finalized", finalizedNumber: null, finalizedHash: null, number: null, hash: null, timestamp: null, rechecked: false, valid: false, callBinding: "EIP-1898 blockHash + requireCanonical" }, enforcement: ENFORCEMENT };
      try {
        const chain = await transport.rpc("eth_chainId", []);
        if (!quantity(chain) || BigInt(chain) !== BigInt(config.chainId)) fail("CHAIN_MISMATCH");
        const finalized = await transport.rpc("eth_getBlockByNumber", ["finalized", false]); if (!validHeader(finalized)) fail("PIN_INVALID");
        entry.pin.finalizedNumber = Number(BigInt(finalized.number)); entry.pin.finalizedHash = finalized.hash.toLowerCase();
        if (block && BigInt(block) > BigInt(finalized.number)) fail("PIN_NOT_FINALIZED");
        const header = block && BigInt(block) !== BigInt(finalized.number) ? await transport.rpc("eth_getBlockByNumber", [block, false]) : finalized;
        if (!validHeader(header) || (block && BigInt(header.number) !== BigInt(block))) fail("PIN_INVALID");
        Object.assign(entry.pin, { number: Number(BigInt(header.number)), hash: header.hash.toLowerCase(), timestamp: Number(BigInt(header.timestamp)) });
        const tag = { blockHash: entry.pin.hash, requireCanonical: true };
        // Optional factory binds protocol helpers to a run/pair-local read-only context.
        const context = { config, transport, pin: entry.pin, reads: entry.reads };
        const bound = adapter.createAdapter ? adapter.createAdapter(context) : Object.assign(Object.create(adapter), context);
        const market = await bound.readMarketTotal(row.marketId, tag);
        const position = await bound.readPosition(row.marketId, row.borrower, tag);
        const price = await bound.readOraclePrice(row.marketId, tag);
        const metrics = await bound.computeHF(position.debt, position.collateral, price, market.lltv);
        if (!metrics || !["SCOPED_ABOVE_THRESHOLD", "NEAR_LIQUIDATION", "LIQUIDATABLE"].includes(metrics.verdict)
            || (metrics.hfWad !== null && !/^[0-9]+$/.test(metrics.hfWad)) || (metrics.hfWad === null && metrics.noDebt !== true)
            || (metrics.hfWad !== null && typeof metrics.hf !== "string")) fail("READ_INVALID");
        jsonBytes(metrics);
        const recheck = await transport.rpc("eth_getBlockByNumber", [header.number, false]); entry.pin.rechecked = true;
        if (!validHeader(recheck) || recheck.number !== header.number || recheck.hash.toLowerCase() !== entry.pin.hash || recheck.timestamp !== header.timestamp) fail("PIN_DRIFT");
        transport.check(); entry.pin.valid = true; entry.metrics = metrics; entry.status = "COMPLETE";
      } catch (error) { entry.reason = safeCode(error); }
      entry.trigger = { status: entry.status === "COMPLETE" ? entry.metrics.verdict : "INCOMPLETE", reason: entry.reason };
      entry.verdict = `${ENFORCEMENT} ${entry.trigger.status}; HF=${entry.metrics?.hf ?? "unknown or no debt"}.`;
      return entry;
    } };
}
async function runResolved({ adapter, config, identity }, options, send) {
  const transport = createTransport({ send, mode: options.live ? "live" : "dry-run", maxRequests: config.maxRequests ?? 20, allowCall: (call) => adapter.allowCall?.(call, config) === true });
  const value = await captureMulti({ transport, watchList: config.watchList, block: options.block, fixtureId: options.live ? null : "adapter-synthetic", adapter: makeEntryAdapter(adapter, config) });
  value.adapterIdentity = identity; return value;
}
async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv), resolved = resolveAdapter(options.adapterPath, options.configPath);
  if (options.offlineTest) return require("./multi-borrower-watch.offline-test").main(resolved);
  // Hash-scoped status prevents one adapter/config from reusing another's evidence.
  const id = resolved.identity, out = path.join(__dirname, "multi-borrower-watch-captures", id);
  const store = createPersistence({ out, output: path.join(out, "latest-status.json"), identity: id, artifactPattern: /^tools\/multi-borrower-watch-captures\/[a-f0-9]{64}\/multi-[^/]+\.json$/ });
  if (options.live && !options.refresh) {
    const cached = store.freshStatus({ ...options, watchList: resolved.config.watchList, maxRequests: resolved.config.maxRequests });
    if (cached) { process.stdout.write(JSON.stringify({ status: cached.status, reused: true, artifactPath: cached.artifactPath, rpcCount: 0, crossPairSummary: cached.crossPairSummary }) + "\n"); return cached; }
  }
  let send;
  if (options.live) send = liveSend(options.rpcUrl ?? resolved.adapter.defaultRpcUrl);
  else { if (typeof resolved.adapter.fixtureSend !== "function") fail("ADAPTER_INVALID"); send = resolved.adapter.fixtureSend(resolved.config); }
  const value = await runResolved(resolved, options, send);
  let prior = null; try { prior = JSON.parse(fs.readFileSync(path.join(out, "latest-status.json"))); } catch (_) { /* first capture */ }
  const artifactPath = store.persist(value, options.live || prior?.mode !== "live");
  process.stdout.write(JSON.stringify({ status: value.status, mode: value.mode, artifactPath, rpcCount: value.diagnostics.rpcCount, pin: value.pin, crossPairSummary: value.crossPairSummary }) + "\n");
  if (value.status !== "COMPLETE") process.exitCode = 1;
  return value;
}
module.exports = { main, parseArgs, resolveAdapter, runResolved, makeEntryAdapter, captureMulti, rowSummary, crossPairSummary, createPersistence, createTransport,
  helpers: { sha, rel, validHeader, jsonBytes, atomicJson, safety, safeCode, liveSend }, SCHEMA, MAX_MS };
if (require.main === module) main().catch((error) => { process.stdout.write(JSON.stringify({ status: "INCOMPLETE", reason: safeCode(error), enforcement: ENFORCEMENT, safety: safety() }) + "\n"); process.exitCode = 1; });
