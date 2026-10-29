#!/usr/bin/env node
"use strict";

// Evidence producer only. Default = synthetic dry-run; network requires --once --live.
// No alert dispatch, provider qualification loop, fallback RPCs, or state-changing methods.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { Interface, keccak256 } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const SCHEMA = "a12-h1-watch/v1";
const H1 = "0x3fb49f96338b22cadd9614a51633189d4ce21088";
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const INVENTORY = path.join(ROOT, "reports/raw/fast/dex-hook-fake-vault-capital-gate.json");
const PRICES = path.join(ROOT, "reports/raw/fast/fluid-dex-phase0.json");
const FIXTURES = path.join(__dirname, "a12-h1-watch.fixtures.json");
const OUT = path.join(ROOT, "reports/raw/fast/a12-h1-watch");
const OUTPUT = path.join(ROOT, "reports/monitor/a12-h1-watch.json");
const MAX_REQUESTS = 10, MAX_MS = 120000, RESPONSE_BOUND = 2 * 1024 * 1024;
const NATIVE_THRESHOLD = 10n ** 16n, USD_SCALE = 10n ** 18n, USD_THRESHOLD = 1000n * USD_SCALE;
const ENFORCEMENT = "Standing watch is observation-only. It does not sign, deploy, submit transactions, or move funds. Non-zero observations do not auto-execute. It emits evidence and surfaces findings to the operator; any action requires separate explicit authorization. A12 lane re-opens for review, not for action.";
const METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getBalance", "eth_call"]);
const MC = new Interface(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])"]);
const ERC20 = new Interface(["function balanceOf(address) view returns (uint256)"]);
const CODES = new Set(["INVENTORY_MALFORMED", "RUNTIME_BASELINE_MISSING", "RUNTIME_MISMATCH", "RUNTIME_EMPTY", "CHAIN_NOT_MAINNET", "PIN_INVALID", "PIN_DRIFT", "NATIVE_INVALID", "MULTICALL_INVALID", "RPC_BUDGET_EXCEEDED", "TIME_BUDGET_EXCEEDED", "RPC_FAILURE", "RPC_SHAPE_INVALID", "RESPONSE_BOUND_EXCEEDED", "METHOD_REJECTED", "INVALID_ARGUMENTS", "RPC_UNAVAILABLE", "ARTIFACT_EXISTS", "ARTIFACT_WRITE_FAILURE", "OFFLINE_TEST_FAILED", "SANITIZATION_FAILED"]);
const safeCode = (error) => CODES.has(error && error.message) ? error.message : "RPC_FAILURE";
const fail = (code) => { throw new Error(code); };
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, "/");
const isHash = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const isQuantity = (value) => typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
const isBytes = (value) => typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value);
const isAddress = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
const safety = () => ({ readOnly: true, signing: false, submission: false, deployment: false, stateMutation: false, forkExecution: false, routePositive: false, executableNow: false, signedActionJustified: false, alertDispatch: false, rpcUrlsStored: false, keysRead: false, authMaterialStored: false });

function jsonBytes(value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (/(?:https?|wss?):\/\/|authorization\s*:|bearer\s|[?&](?:key|token)=/i.test(text)) fail("SANITIZATION_FAILED");
  return Buffer.from(text);
}
function validateInventory(value) {
  const tokens = value && value.tokenBalances && value.tokenBalances.unionTokens;
  if (!Array.isArray(tokens) || tokens.length !== 729 || !tokens.every(isAddress)) fail("INVENTORY_MALFORMED");
  const normalized = tokens.map((token) => token.toLowerCase());
  if (new Set(normalized).size !== 729 || normalized.includes(NATIVE) || normalized.includes("0x" + "0".repeat(40))) fail("INVENTORY_MALFORMED");
  return normalized;
}
function readInventory() {
  try {
    const bytes = fs.readFileSync(INVENTORY), value = JSON.parse(bytes);
    const tokens = validateInventory(value);
    const runtimeHash = value.bytecodeSemantics && value.bytecodeSemantics.runtimeKeccak256;
    if (!isHash(runtimeHash) || value.definitions?.h1?.toLowerCase() !== H1) fail("RUNTIME_BASELINE_MISSING");
    return { tokens, sha256: sha(bytes), runtimeHash: runtimeHash.toLowerCase() };
  } catch (error) { fail(CODES.has(error.message) ? error.message : "INVENTORY_MALFORMED"); }
}

// Only existing, chain/address-bound evidence is eligible. Never infer $1 or decimals.
// Prices must be no more than one hour old. Historical prices remain metadata,
// never materiality/route evidence.
function readPrices() {
  try {
    const bytes = fs.readFileSync(PRICES), artifact = JSON.parse(bytes), rows = new Map();
    for (const row of artifact.dexRows || []) for (const key of ["token0Meta", "token1Meta"]) {
      const meta = row[key];
      if (row.chainId !== 1 || meta?.chainId !== 1 || !isAddress(meta.address)
          || typeof meta.priceUsd !== "number" || !Number.isFinite(meta.priceUsd) || meta.priceUsd <= 0
           || meta.codePresent !== true || !Number.isInteger(meta.decimals) || meta.decimals < 0 || meta.decimals > 255) continue;
      const address = meta.address.toLowerCase();
      const record = { priceUsd: String(meta.priceUsd), decimals: meta.decimals };
      if (rows.has(address) && JSON.stringify(rows.get(address)) !== JSON.stringify(record)) rows.set(address, null);
      else if (!rows.has(address)) rows.set(address, record);
    }
    const time = Date.parse(artifact.generatedAt);
    return { rows, sha256: sha(bytes), generatedAt: Number.isFinite(time) ? new Date(time).toISOString() : null };
  } catch (_) { return { rows: new Map(), sha256: null, generatedAt: null }; }
}
function usdDecimal(raw, decimals, price) {
  const match = String(price).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match) return null;
  const fraction = match[2] || "", scale = decimals + fraction.length - Number(match[3] || 0);
  const numerator = BigInt(raw) * BigInt(match[1] + fraction);
  const scaled = scale >= 0 ? numerator * 10n ** 18n / 10n ** BigInt(scale) : numerator * 10n ** BigInt(18 - scale);
  return `${scaled / 10n ** 18n}.${(scaled % 10n ** 18n).toString().padStart(18, "0")}`;
}
function valuation(raw, address, prices, capture) {
  const evidence = prices.rows.get(address);
  const fresh = prices.generatedAt !== null && Date.parse(capture.generatedAt) - Date.parse(prices.generatedAt) <= 3600000
    && Date.parse(prices.generatedAt) <= Date.parse(capture.generatedAt)
    && capture.pin.timestamp !== null && Date.parse(prices.generatedAt) <= capture.pin.timestamp * 1000;
  return {
    priceUsd: evidence?.priceUsd || null, decimals: evidence?.decimals ?? null,
    sourceGeneratedAt: prices.generatedAt, sourceSha256: prices.sha256,
    status: raw === null ? "READ_UNAVAILABLE" : !evidence ? "PRICE_UNAVAILABLE" : !fresh ? "PRICE_STALE_OR_UNBOUND" : "EXISTING_PRICE_EVIDENCE",
    usd: raw !== null && evidence && fresh ? usdDecimal(raw, evidence.decimals, evidence.priceUsd) : null,
    materiality: raw !== null && evidence && fresh ? BigInt(usdDecimal(raw, evidence.decimals, evidence.priceUsd).replace(".", "")) >= USD_THRESHOLD : null,
  };
}

function createTransport({ send, mode, now = () => performance.now(), maxRequests = MAX_REQUESTS, maxMs = MAX_MS }) {
  const started = now(), ledger = [];
  function check() { if (now() - started >= Math.min(maxMs, MAX_MS)) fail("TIME_BUDGET_EXCEEDED"); }
  return {
    ledger, mode, check,
    get elapsedMs() { return Math.max(0, Math.round(now() - started)); },
    async rpc(method, params) {
      check();
      if (!METHODS.has(method)) fail("METHOD_REJECTED");
      if (ledger.length >= Math.min(maxRequests, MAX_REQUESTS)) fail("RPC_BUDGET_EXCEEDED");
      const row = { ordinal: ledger.length + 1, method, status: "PENDING", durationMs: 0 };
      ledger.push(row);
      const start = now();
      try {
        const result = await send(method, params, row.ordinal, Math.min(10000, Math.max(1, maxMs - (now() - started))));
        check(); row.status = "OK"; return result;
      } catch (error) { row.status = safeCode(error); throw new Error(row.status); }
      finally { row.durationMs = Math.max(0, Math.round(now() - start)); }
    },
  };
}
function liveSend(rpcUrl = null) {
  // Loaded only after explicit live consent. No new endpoint or catalog mutation.
  const { loadRpcUrls, getOrigin } = require("./shared-rpc");
  const url = (rpcUrl ? [rpcUrl] : loadRpcUrls({ maxCandidates: 128 })).find((candidate) => {
    try {
      const parsed = new URL(candidate);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password
        && !/(?:arbitrum|optimism|polygon|base|bsc|avalanche|solana|testnet|sepolia)/i.test(parsed.hostname + parsed.pathname);
    } catch (_) { return false; }
  });
  if (!url) fail("RPC_UNAVAILABLE");
  return async (method, params, id, timeoutMs) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { "content-type": "application/json" }, origin = getOrigin(url);
      if (origin) headers.origin = origin;
      const response = await fetch(url, { method: "POST", headers, signal: controller.signal, redirect: "error", body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
      if (!response.ok || !response.body) fail("RPC_FAILURE");
      const reader = response.body.getReader(), chunks = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > RESPONSE_BOUND) { controller.abort(); fail("RESPONSE_BOUND_EXCEEDED"); }
        chunks.push(Buffer.from(value));
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) { fail("RPC_SHAPE_INVALID"); }
      if (!body || Array.isArray(body) || body.jsonrpc !== "2.0" || body.id !== id || body.error || !Object.hasOwn(body, "result")) fail("RPC_SHAPE_INVALID");
      return body.result;
    } catch (error) { throw new Error(safeCode(error)); }
    finally { clearTimeout(timer); }
  };
}

function decodeBalance(token, success, raw) {
  const valid = isBytes(raw), length = valid ? (raw.length - 2) / 2 : null;
  const decoded = success && valid && length >= 32;
  return { asset: token, raw: decoded ? BigInt(`0x${raw.slice(2, 66)}`).toString() : null,
    success: Boolean(decoded), decodeStatus: !success ? "SUBCALL_REVERT" : !valid ? "MALFORMED_RETURN" : length < 32 ? "SHORT_RETURN" : length === 32 ? "UINT256" : "UINT256_NONCANONICAL_EXTRA_DATA",
    returnLength: length, returnSha256: valid ? sha(Buffer.from(raw.slice(2), "hex")) : null };
}
function classify(capture) {
  if (capture.status === "INCOMPLETE") return { status: "INCOMPLETE", reason: capture.reason };
  if (!capture.scope.nonzero) return { status: "SCOPED_ZERO_AT_PIN", reason: null };
  const native = capture.results.native, tokens = capture.results.tokens;
  const positive = [native, ...tokens].filter((row) => row?.raw != null && BigInt(row.raw) > 0n);
  const reasons = [];
  if (native?.raw != null && BigInt(native.raw) >= NATIVE_THRESHOLD) reasons.push("NATIVE_BALANCE_GTE_0.01_ETH");
  if (tokens.some((row) => row.valuation?.materiality === true)) reasons.push("ERC20_USD_GTE_1000");
  const total = positive.reduce((sum, row) => sum + (row.valuation?.usd ? BigInt(row.valuation.usd.replace(".", "")) : 0n), 0n);
  if (total >= USD_THRESHOLD) reasons.push("AGGREGATE_USD_GTE_1000");
  const unknown = positive.some((row) => row.valuation?.usd == null);
  if (unknown) reasons.push("Valuation/semantics unknown");
  return { status: reasons.some((reason) => reason !== "Valuation/semantics unknown") ? "MATERIAL_BALANCE_ALERT"
    : unknown ? "Valuation/semantics unknown" : "NONZERO_OBSERVATION_ONLY", reason: reasons.join("; ") || null };
}
function amountText(raw, decimals) {
  const units = 10n ** BigInt(decimals), value = BigInt(raw);
  const fraction = (value % units).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${(value / units).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}`;
}
function renderVerdict(capture) {
  if (capture.status === "INCOMPLETE") return `${ENFORCEMENT} INCOMPLETE (${capture.reason}); zero capital is not established.`;
  if (!capture.scope.nonzero) return `${ENFORCEMENT} SCOPED_ZERO_AT_PIN. Scoped balances are zero at this pin; uncatalogued/no-event tokens and ERC6909 are not covered.`;
  const pin = `Ethereum block ${capture.pin.number} / ${capture.pin.hash}`;
  const events = [];
  const native = capture.results.native;
  if (native?.raw != null && BigInt(native.raw) > 0n) {
    events.push(`At-rest positive balance event: H1 holds ${amountText(native.raw, 18)} ETH at ${pin}. ${BigInt(native.raw) >= NATIVE_THRESHOLD ? "Native threshold exceeded. " : ""}A12 lane re-opens for review, not for action. No executable route or authorization is established.`);
  }
  for (const row of capture.results.tokens) {
    if (row.raw === null || BigInt(row.raw) === 0n) continue;
    const value = row.valuation;
    const label = row.asset === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" && value.decimals === 6 ? "canonical USDC" : `ERC-20 ${row.asset}`;
    if (value.usd !== null) {
      const evidence = `${capture.provenance.pricePath}, SHA-256 ${value.sourceSha256}, generated ${value.sourceGeneratedAt}, chain 1 / ${row.asset}, price USD ${value.priceUsd}`;
      events.push(`At-rest positive balance event: H1 reports ${amountText(row.raw, value.decimals)} ${label} at ${pin}, approximately $${amountText(BigInt(value.usd.replace(".", "")), 18)} using ${evidence}. A12 lane re-opens for review, not for action. Balance observation is not proof of recoverability.`);
    } else {
      events.push(`At-rest positive balance event: H1 reports ${row.raw} raw units of ERC-20 ${row.asset} at ${pin}. Valuation/semantics unknown. A12 lane re-opens for review, not for action. Balance observation is not proof of recoverability.`);
    }
  }
  if (capture.trigger.reason?.includes("Valuation/semantics unknown") && !events.some((event) => event.includes("Valuation/semantics unknown"))) events.push("Valuation/semantics unknown.");
  return `${ENFORCEMENT} ${events.join(" ")}`;
}
async function capture({ inventory, prices, transport, block = null, fixtureId = null }) {
  const result = {
    schema: SCHEMA, generatedAt: new Date().toISOString(), runId: crypto.randomBytes(8).toString("hex"),
    identity: { producer: "tools/a12-h1-watch.js", chainId: 1, h1: H1, multicall3: MULTICALL3 },
    mode: transport.mode, fixtureId, status: "INCOMPLETE", reason: null,
    timing: { startedAt: new Date().toISOString(), completedAt: null, durationMs: 0, maxMs: MAX_MS },
    pin: { requested: block || "finalized", number: null, hash: null, timestamp: null, rechecked: false, valid: false },
    provenance: { inventoryPath: rel(INVENTORY), inventorySha256: inventory?.sha256 || null,
      inventoryCount: inventory?.tokens?.length ?? null, pricePath: rel(PRICES), priceSha256: prices.sha256,
      fixturePath: fixtureId ? rel(FIXTURES) : null, fixtureSha256: fixtureId ? sha(fs.readFileSync(FIXTURES)) : null,
      provider: transport.mode === "live" ? "workspace-inventory-single-provider" : "synthetic-fixture",
      standingWatchSpec: "ORA9_VERBATIM_ENFORCEMENT_AND_POSITIVE_TEMPLATES", verbatimVerdictStatus: "VERBATIM_ENFORCEMENT_AND_DYNAMIC_POSITIVE_TEMPLATES",
      valuationPolicy: "Verified decimals and chain/address-bound price, at most one hour old and not newer than the pin; no stablecoin peg assumption. Native >= 0.01 ETH, any ERC-20 >= $1,000, or aggregate >= $1,000 is material; unvalued positive balances are Valuation/semantics unknown." },
    runtime: [], scope: { expectedTokens: 729, attempted: 0, successful: 0, zero: 0, nonzero: 0, failed: 0, notAttempted: 730,
      tokenAttempted: 0, tokenSuccessful: 0, tokenZero: 0, tokenNonzero: 0, tokenFailed: 0, nativeIncluded: true, exhaustive: false },
    results: { native: null, tokens: [] }, diagnostics: null,
    trigger: { status: "INCOMPLETE", reason: null }, safety: safety(),
  };
  try {
    if (!inventory) fail("INVENTORY_MALFORMED");
    const tokens = validateInventory({ tokenBalances: { unionTokens: inventory.tokens } });
    if (await transport.rpc("eth_chainId", []) !== "0x1") fail("CHAIN_NOT_MAINNET");
    const header = await transport.rpc("eth_getBlockByNumber", [block || "finalized", false]);
    if (!header || !isQuantity(header.number) || !isHash(header.hash) || !isQuantity(header.timestamp)
        || !Number.isSafeInteger(Number(BigInt(header.number))) || !Number.isSafeInteger(Number(BigInt(header.timestamp)))
        || (block && BigInt(header.number) !== BigInt(block))) fail("PIN_INVALID");
    Object.assign(result.pin, { number: Number(BigInt(header.number)), hash: header.hash.toLowerCase(), timestamp: Number(BigInt(header.timestamp)) });
    const tag = header.number;
    for (const address of [H1, MULTICALL3]) {
      const code = await transport.rpc("eth_getCode", [address, tag]);
      if (!isBytes(code) || code === "0x") fail("RUNTIME_EMPTY");
      const codeHash = keccak256(code);
      result.runtime.push({ address, bytes: (code.length - 2) / 2, keccak256: codeHash,
        expectedKeccak256: address === H1 ? inventory.runtimeHash : null,
        baselineMatched: address === H1 ? codeHash === inventory.runtimeHash : null });
      if (address === H1 && codeHash !== inventory.runtimeHash) fail("RUNTIME_MISMATCH");
    }
    result.scope.attempted += 1;
    const native = await transport.rpc("eth_getBalance", [H1, tag]);
    if (!isQuantity(native) || BigInt(native) >= 2n ** 256n) fail("NATIVE_INVALID");
    result.results.native = { asset: "native", raw: BigInt(native).toString(), success: true,
      decodeStatus: "RPC_QUANTITY", returnLength: (native.length - 2 + 1) >> 1, returnSha256: sha(Buffer.from(native)) };
    for (let start = 0; start < tokens.length; start += 300) {
      const batch = tokens.slice(start, start + 300);
      result.scope.tokenAttempted += batch.length;
      result.scope.attempted += batch.length;
      const calls = batch.map((target) => ({ target, allowFailure: true, callData: ERC20.encodeFunctionData("balanceOf", [H1]) }));
      const raw = await transport.rpc("eth_call", [{ to: MULTICALL3, data: MC.encodeFunctionData("aggregate3", [calls]) }, tag]);
      let decoded;
      try { [decoded] = MC.decodeFunctionResult("aggregate3", raw); } catch (_) { fail("MULTICALL_INVALID"); }
      if (decoded.length !== batch.length) fail("MULTICALL_INVALID");
      decoded.forEach((entry, index) => result.results.tokens.push(decodeBalance(batch[index], entry[0] === true, entry[1])));
    }
    const recheck = await transport.rpc("eth_getBlockByNumber", [tag, false]);
    result.pin.rechecked = true;
    if (!recheck || recheck.number !== tag || typeof recheck.hash !== "string" || recheck.hash.toLowerCase() !== result.pin.hash) fail("PIN_DRIFT");
    result.pin.valid = true;
    transport.check();
    if (result.results.tokens.some((entry) => !entry.success)) result.reason = "ASSET_READ_UNAVAILABLE";
    else result.status = "COMPLETE";
  } catch (error) { result.reason = safeCode(error); }
  const tokenRows = result.results.tokens, rows = [result.results.native, ...tokenRows].filter(Boolean);
  const count = (items, predicate) => items.filter(predicate).length;
  const ok = (entry) => entry.raw !== null;
  const zero = (entry) => ok(entry) && BigInt(entry.raw) === 0n;
  const nonzero = (entry) => ok(entry) && BigInt(entry.raw) > 0n;
  Object.assign(result.scope, { successful: count(rows, ok), zero: count(rows, zero), nonzero: count(rows, nonzero),
    failed: result.scope.attempted - count(rows, ok), notAttempted: 730 - result.scope.attempted,
    tokenSuccessful: count(tokenRows, ok), tokenZero: count(tokenRows, zero), tokenNonzero: count(tokenRows, nonzero),
    tokenFailed: result.scope.tokenAttempted - count(tokenRows, ok) });
  for (const entry of tokenRows) entry.valuation = valuation(entry.raw, entry.asset, prices, result);
  if (result.results.native) result.results.native.valuation = valuation(result.results.native.raw, NATIVE, prices, result);
  result.timing.completedAt = new Date().toISOString();
  result.timing.durationMs = transport.elapsedMs;
  if (result.timing.durationMs >= MAX_MS) { result.status = "INCOMPLETE"; result.reason = "TIME_BUDGET_EXCEEDED"; }
  result.diagnostics = { rpcCount: transport.mode === "live" ? transport.ledger.length : 0, simulatedRpcCount: transport.mode === "live" ? 0 : transport.ledger.length,
    requestCount: transport.ledger.length, maxRpcRequests: MAX_REQUESTS, methodLedger: transport.ledger, retries: 0, budgetExceeded: result.reason === "RPC_BUDGET_EXCEEDED" };
  result.trigger = classify(result);
  result.verdict = renderVerdict(result);
  return result;
}

function fixtureTransport(fixtures, testCase, options = {}) {
  let headerReads = 0, tokenOffset = 0;
  const send = async (method, params) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") {
      headerReads += 1;
      return { ...fixtures.block, number: params[0] === "finalized" ? fixtures.block.number : params[0],
        hash: headerReads > 1 && testCase.drift ? `0x${"22".repeat(32)}` : fixtures.block.hash };
    }
    if (method === "eth_getCode") return fixtures.runtime;
    if (method === "eth_getBalance") return testCase.native;
    if (method === "eth_call") {
      assert.equal(params[0].to, MULTICALL3);
      const [calls] = MC.decodeFunctionData("aggregate3", params[0].data);
      const returned = calls.map((call) => {
        assert.equal(call.allowFailure, true);
        assert.equal(ERC20.decodeFunctionData("balanceOf", call.callData)[0].toLowerCase(), H1);
        const index = tokenOffset++;
        if (index === testCase.revertIndex) return [false, "0x08c379a0"];
        const raw = ERC20.encodeFunctionResult("balanceOf", [index === testCase.nonzeroIndex ? BigInt(testCase.rawValue) : 0n]);
        // Match the known noncanonical ABI-return pattern without treating it as failure.
        return [true, index === 0 ? raw + "00".repeat(4096 - 32) : raw];
      });
      return MC.encodeFunctionResult("aggregate3", [returned]);
    }
    fail("METHOD_REJECTED");
  };
  return createTransport({ send, mode: "dry-run", ...options });
}

function atomicJson(file, value, replace = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  const bytes = jsonBytes(value);
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (replace) fs.renameSync(temporary, file);
    else {
      // Atomic create-if-absent: rename alone could overwrite an immutable capture.
      try { fs.linkSync(temporary, file); } catch (error) { if (error.code === "EEXIST") fail("ARTIFACT_EXISTS"); throw error; }
    }
    return { sha256: sha(bytes), bytes: bytes.length };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (_) { /* renamed or removed */ }
  }
}
function writeEvidence(file, value) {
  const digest = atomicJson(file, value);
  atomicJson(file.replace(/\.json$/, ".manifest.json"), { schema: "a12-h1-watch-manifest/v1", artifact: rel(file), ...digest, safety: safety() });
  return rel(file);
}
function persistCapture(value, latest = false) {
  const stamp = value.generatedAt.replace(/[-:.]/g, "");
  const filename = `${stamp}-b${value.pin.number ?? "unknown"}-${value.pin.hash?.slice(2, 10) || "unbound"}-${value.runId}.json`;
  const artifactPath = writeEvidence(path.join(OUT, filename), value);
  if (latest) {
    const date = new Date(value.generatedAt), nextDue = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
    atomicJson(OUTPUT, { schema: SCHEMA, generatedAt: value.generatedAt, mode: value.mode, status: value.status, reason: value.reason,
      artifactPath, artifactSha256: sha(fs.readFileSync(path.join(ROOT, artifactPath))), pin: value.pin, scope: value.scope,
      trigger: value.trigger, cadence: { utc: "00:00", nextDueAt: nextDue.toISOString() },
      freshness: { validUntil: nextDue.toISOString(), liveObservation: value.mode === "live" },
      verdict: value.verdict, diagnostics: value.diagnostics, safety: safety() }, true);
  }
  return artifactPath;
}
function validateArtifact(value) {
  try {
    return value?.schema === SCHEMA && ["live", "dry-run"].includes(value.mode)
      && ["COMPLETE", "INCOMPLETE"].includes(value.status) && Number.isFinite(Date.parse(value.generatedAt))
      && typeof value.artifactPath === "string" && /^reports\/raw\/fast\/a12-h1-watch\/[^/]+\.json$/.test(value.artifactPath)
      && /^[0-9a-f]{64}$/.test(value.artifactSha256) && JSON.stringify(value.safety) === JSON.stringify(safety())
      && value.diagnostics.rpcCount <= MAX_REQUESTS && value.diagnostics.requestCount <= MAX_REQUESTS
      && value.scope.expectedTokens === 729 && Boolean(jsonBytes(value));
  } catch (_) { return false; }
}
function freshStatus(block) {
  try {
    const value = JSON.parse(fs.readFileSync(OUTPUT));
    if (!validateArtifact(value) || !value.verdict?.startsWith(ENFORCEMENT) || value.mode !== "live" || value.status !== "COMPLETE" || !value.pin.valid
        || value.scope.successful !== 730 || value.generatedAt.slice(0, 10) !== new Date().toISOString().slice(0, 10)
        || Date.parse(value.generatedAt) > Date.now() || (block && BigInt(value.pin.number) !== BigInt(block))
        || (!block && value.pin.requested !== "finalized")) return null;
    const file = path.join(ROOT, value.artifactPath), bytes = fs.readFileSync(file);
    const manifest = JSON.parse(fs.readFileSync(file.replace(/\.json$/, ".manifest.json")));
    return sha(bytes) === value.artifactSha256 && manifest.sha256 === value.artifactSha256 && manifest.artifact === value.artifactPath ? value : null;
  } catch (_) { return null; }
}

async function offlineTest(inventory, prices) {
  const fixtures = JSON.parse(fs.readFileSync(FIXTURES));
  const synthetic = { ...inventory, runtimeHash: keccak256(fixtures.runtime) }, cases = [];
  const networkFetch = globalThis.fetch;
  globalThis.fetch = () => { fail("METHOD_REJECTED"); };
  try {
    for (const testCase of fixtures.cases) {
      const value = await capture({ inventory: synthetic, prices, transport: fixtureTransport(fixtures, testCase), fixtureId: testCase.id });
      let passed = false;
      try {
        assert.equal(value.diagnostics.rpcCount, 0); assert.equal(value.diagnostics.requestCount, 9);
        assert.equal(value.scope.tokenAttempted, 729); assert.equal(value.results.tokens.length, 729);
        assert.equal(value.results.tokens[0].decodeStatus, "UINT256_NONCANONICAL_EXTRA_DATA");
        assert.equal(value.results.tokens[0].returnLength, 4096);
        assert.deepEqual(value.safety, safety());
        assert.ok(value.verdict.startsWith(ENFORCEMENT));
        if (testCase.id === "all-zero") { assert.equal(value.status, "COMPLETE"); assert.equal(value.scope.zero, 730); assert.equal(value.trigger.status, "SCOPED_ZERO_AT_PIN"); }
        if (testCase.id === "one-nonzero") { assert.equal(value.status, "COMPLETE"); assert.equal(value.scope.nonzero, 1); assert.equal(value.results.tokens[301].raw, testCase.rawValue); assert.ok(value.verdict.includes("A12 lane re-opens for review, not for action.")); }
        if (testCase.id === "one-revert") { assert.equal(value.status, "INCOMPLETE"); assert.equal(value.scope.tokenSuccessful, 728); assert.equal(value.results.tokens[302].raw, null); assert.equal(value.results.tokens[302].decodeStatus, "SUBCALL_REVERT"); }
        if (testCase.id === "pin-drift") { assert.equal(value.status, "INCOMPLETE"); assert.equal(value.reason, "PIN_DRIFT"); assert.equal(value.pin.valid, false); }
        assert.deepEqual(JSON.parse(jsonBytes(value)), value);
        passed = true;
      } catch (_) { /* assertions produce only a sanitized fail flag */ }
      cases.push({ id: testCase.id, passed, status: value.status, reason: value.reason, verdict: value.verdict, capture: value });
    }
    async function test(id, fn) {
      try { await fn(); cases.push({ id, passed: true }); } catch (_) { cases.push({ id, passed: false }); }
    }
    await test("malformed-inventory-fails-incomplete", async () => {
      const transport = fixtureTransport(fixtures, fixtures.cases[0]);
      const value = await capture({ inventory: { ...synthetic, tokens: synthetic.tokens.slice(1) }, prices, transport });
      assert.equal(value.status, "INCOMPLETE"); assert.equal(value.reason, "INVENTORY_MALFORMED"); assert.equal(transport.ledger.length, 0);
      assert.equal(value.scope.zero, 0);
    });
    await test("budget-refuses-eleventh-request", async () => {
      const transport = fixtureTransport(fixtures, fixtures.cases[0]);
      await transport.rpc("eth_chainId", []); await transport.rpc("eth_chainId", []);
      const value = await capture({ inventory: synthetic, prices, transport });
      assert.equal(value.status, "INCOMPLETE"); assert.equal(value.reason, "RPC_BUDGET_EXCEEDED"); assert.equal(transport.ledger.length, 10);
    });
    await test("elapsed-budget-fails-incomplete", async () => {
      let clock = 0;
      const transport = createTransport({ mode: "dry-run", now: () => clock, send: async () => { clock = MAX_MS; return "0x1"; } });
      const value = await capture({ inventory: synthetic, prices, transport });
      assert.equal(value.status, "INCOMPLETE"); assert.equal(value.reason, "TIME_BUDGET_EXCEEDED");
    });
    await test("price-rules-no-peg-no-stale-valuation", () => {
      assert.equal(usdDecimal("1000000", 6, "0.97"), "0.970000000000000000");
      const value = { generatedAt: "2026-10-17T01:00:00.000Z", pin: { timestamp: Date.parse("2026-10-17T00:30:00Z") / 1000 } };
      const evidence = { rows: new Map([[H1, { priceUsd: "0.97", decimals: 6 }]]), generatedAt: "2026-10-17T00:00:00.000Z", sha256: null };
      assert.equal(valuation("1000000", H1, evidence, value).usd, "0.970000000000000000");
      assert.equal(valuation("1000000", MULTICALL3, evidence, value).usd, null);
      evidence.generatedAt = "2026-10-17T00:00:00.000Z";
      value.generatedAt = "2026-10-17T01:00:00.001Z";
      assert.equal(valuation("1000000", H1, evidence, value).usd, null);
      value.generatedAt = "2026-10-17T00:30:00.000Z";
      evidence.generatedAt = "2026-10-16T23:45:00.000Z";
      assert.equal(valuation("1000000", H1, evidence, value).usd, "0.970000000000000000");
      evidence.generatedAt = "2026-06-19T00:00:00.000Z";
      assert.equal(valuation("1000000", H1, evidence, value).usd, null);
    });
    await test("verbatim-positive-templates-and-materiality-boundaries", () => {
      const value = { status: "COMPLETE", reason: null, scope: { nonzero: 1 },
        pin: { number: 123, hash: fixtures.block.hash }, provenance: { pricePath: rel(PRICES) },
        results: { native: { raw: "10000000000000000", valuation: { usd: null } }, tokens: [] } };
      assert.equal(classify(value).status, "MATERIAL_BALANCE_ALERT");
      value.results.native.raw = "9999999999999999";
      assert.equal(classify(value).status, "Valuation/semantics unknown");
      value.results.native.raw = "500000000000000000";
      value.trigger = classify(value);
      assert.equal(renderVerdict(value), `${ENFORCEMENT} At-rest positive balance event: H1 holds 0.5 ETH at Ethereum block 123 / ${fixtures.block.hash}. Native threshold exceeded. A12 lane re-opens for review, not for action. No executable route or authorization is established. Valuation/semantics unknown.`);
      value.results.native.raw = "0";
      const token = { asset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", raw: "5000000000",
        valuation: { usd: "5000.000000000000000000", decimals: 6, priceUsd: "1", materiality: true, sourceSha256: "a".repeat(64), sourceGeneratedAt: "2026-10-17T00:00:00.000Z" } };
      value.results.tokens = [token]; value.trigger = classify(value);
      assert.equal(value.trigger.status, "MATERIAL_BALANCE_ALERT");
      assert.ok(renderVerdict(value).includes(`At-rest positive balance event: H1 reports 5,000 canonical USDC at Ethereum block 123 / ${fixtures.block.hash}, approximately $5,000 using `));
      assert.ok(renderVerdict(value).endsWith("A12 lane re-opens for review, not for action. Balance observation is not proof of recoverability."));
      const time = { generatedAt: "2026-10-17T01:00:00.000Z", pin: { timestamp: Date.parse("2026-10-17T00:30:00Z") / 1000 } };
      const evidence = { rows: new Map([[token.asset, { decimals: 6, priceUsd: "1" }]]), generatedAt: "2026-10-17T00:00:00.000Z", sha256: null };
      assert.equal(valuation("1000000000", token.asset, evidence, time).materiality, true);
      assert.equal(valuation("999999999", token.asset, evidence, time).materiality, false);
      token.valuation = { usd: "999.999999000000000000", materiality: false };
      assert.equal(classify(value).status, "NONZERO_OBSERVATION_ONLY");
      value.results.native = { raw: "1", valuation: { usd: "0.000001000000000000", materiality: false } };
      assert.equal(classify(value).status, "MATERIAL_BALANCE_ALERT");
      assert.ok(classify(value).reason.includes("AGGREGATE_USD_GTE_1000"));
      token.valuation = { usd: null, materiality: null };
      assert.equal(classify(value).status, "Valuation/semantics unknown");
    });
    await test("explicit-pin-is-used", async () => {
      const value = await capture({ inventory: synthetic, prices, transport: fixtureTransport(fixtures, fixtures.cases[0]), block: "0x12345" });
      assert.equal(value.status, "COMPLETE"); assert.equal(value.pin.number, 0x12345); assert.equal(value.pin.requested, "0x12345");
    });
    await test("live-needs-two-explicit-flags", () => {
      assert.throws(() => parseArgs(["--live"])); assert.equal(parseArgs([]).live, false);
      assert.throws(() => parseArgs(["--offline-test", "--once", "--live"]));
    });
    const summary = { schema: "a12-h1-watch-offline-test/v1", generatedAt: new Date().toISOString(),
      passed: cases.every((entry) => entry.passed), rpcCount: 0, cases, specGap: null, safety: safety() };
    const fixed = path.join(OUT, "offline-test-r1.json");
    // Re-runs never replace an existing test artifact.
    const target = fs.existsSync(fixed) ? path.join(OUT, `offline-test-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`) : fixed;
    atomicJson(target, summary);
    const artifactPath = rel(target);
    process.stdout.write(JSON.stringify({ passed: summary.passed, artifactPath, rpcCount: 0, cases: cases.map(({ id, passed }) => ({ id, passed })) }) + "\n");
    if (!summary.passed) fail("OFFLINE_TEST_FAILED");
  } finally { globalThis.fetch = networkFetch; }
}
function parseArgs(argv) {
  const options = { live: false, once: false, refresh: false, offlineTest: false, block: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--live") options.live = true;
    else if (arg === "--once") options.once = true;
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "--offline-test") options.offlineTest = true;
    else if (arg === "--rpc-url") { options.rpcUrl = argv[++i]; if (!/^https:\/\//i.test(options.rpcUrl || "")) fail("INVALID_ARGUMENTS"); }
    else if (arg === "--block") {
      const value = argv[++i];
      if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value || "") || BigInt(value) <= 0n || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) fail("INVALID_ARGUMENTS");
      options.block = `0x${BigInt(value).toString(16)}`;
    } else fail("INVALID_ARGUMENTS");
  }
  if ((options.live && !options.once) || (options.offlineTest && options.live)) fail("INVALID_ARGUMENTS");
  return options;
}
async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv), prices = readPrices();
  let inventory = null;
  try { inventory = readInventory(); } catch (_) { /* persisted INCOMPLETE below, never zero */ }
  if (options.offlineTest) {
    if (!inventory) fail("INVENTORY_MALFORMED");
    return offlineTest(inventory, prices);
  }
  if (options.live && !options.refresh && inventory) {
    const cached = freshStatus(options.block);
    if (cached) { process.stdout.write(JSON.stringify({ status: cached.status, reused: true, artifactPath: cached.artifactPath, rpcCount: 0 }) + "\n"); return; }
  }
  let transport, fixtureId = null;
  if (options.live && inventory) {
    try { transport = createTransport({ send: liveSend(options.rpcUrl), mode: "live" }); }
    catch (_) { transport = createTransport({ send: async () => fail("RPC_UNAVAILABLE"), mode: "live" }); }
  } else {
    const fixtures = JSON.parse(fs.readFileSync(FIXTURES));
    transport = fixtureTransport(fixtures, fixtures.cases[0]); fixtureId = "all-zero";
    if (inventory) inventory = { ...inventory, runtimeHash: keccak256(fixtures.runtime) };
    if (options.live) transport = createTransport({ send: async () => fail("INVENTORY_MALFORMED"), mode: "live" });
  }
  const value = await capture({ inventory, prices, transport, block: options.block, fixtureId });
  // Synthetic captures must never replace a live status, including a live failure.
  let prior = null;
  try { prior = JSON.parse(fs.readFileSync(OUTPUT)); } catch (_) { /* first run */ }
  const artifactPath = persistCapture(value, options.live || prior?.mode !== "live");
  process.stdout.write(JSON.stringify({ status: value.status, mode: value.mode, artifactPath, rpcCount: value.diagnostics.rpcCount, verdict: value.verdict }) + "\n");
  if (value.status === "INCOMPLETE") process.exitCode = 1;
}
module.exports = { SCHEMA, OUTPUT, H1, MULTICALL3, MAX_REQUESTS, MAX_MS, validateInventory, readInventory, readPrices, createTransport, capture, decodeBalance, valuation, usdDecimal, renderVerdict, validateArtifact, parseArgs, main };
if (require.main === module) main().catch((error) => {
  process.stdout.write(JSON.stringify({ status: "INCOMPLETE", reason: safeCode(error), safety: safety() }) + "\n");
  process.exitCode = 1;
});
