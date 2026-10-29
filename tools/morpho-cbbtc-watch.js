#!/usr/bin/env node
"use strict";

// Observation only. Synthetic unless BOTH --once --live are supplied.
// No signer, transaction API, execution simulation, fallback provider, or scheduler registration.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { Interface, AbiCoder, keccak256 } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const SCHEMA = "morpho-cbbtc-watch/v1";
const MORPHO = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
const MARKET_ID = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
const BORROWER = "0x5b59a62666a9986d422f60b6d5aa9f7db7541e2a";
const ORACLE = "0x663becd10dae6c4a3dcd89f1d76c1174199639b9";
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ZERO = "0x" + "0".repeat(40);
const FIXTURES = path.join(__dirname, "morpho-cbbtc-watch.fixtures.json");
const OUT = path.join(ROOT, "reports/raw/fast/morpho-cbbtc-watch");
const OUTPUT = path.join(ROOT, "reports/monitor/morpho-cbbtc-watch.json");
const MAX_REQUESTS = 10, MAX_MS = 120000, RESPONSE_BOUND = 2 * 1024 * 1024;
const WAD = 10n ** 18n, ORACLE_SCALE = 10n ** 36n;
const ENFORCEMENT = "Observation-only standing watch on the Morpho cbBTC/USDC borrower. It does NOT sign, deploy, simulate, liquidate, or move funds. Outputs are evidence for review; any execution requires separate explicit authorization. **The watch is not fork proof and does not establish an executable route.**";
const PARAMS = "(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)";
const MARKET = "(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)";
const CORE = new Interface([
  "function position(bytes32,address) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)",
  "function market(bytes32) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function idToMarketParams(bytes32) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)",
]);
const PRICE = new Interface(["function price() view returns (uint256)"]);
const IRM = new Interface([`function borrowRateView(${PARAMS},${MARKET}) view returns (uint256)`]);
const METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_call"]);
const CODES = new Set(["INVALID_ARGUMENTS", "CHAIN_NOT_BASE", "PIN_INVALID", "PIN_NOT_FINALIZED", "PIN_DRIFT", "MARKET_PARAMS_INVALID", "READ_INVALID", "MARKET_INVALID", "RPC_UNAVAILABLE", "RPC_FAILURE", "RPC_SHAPE_INVALID", "RESPONSE_BOUND_EXCEEDED", "METHOD_REJECTED", "RPC_BUDGET_EXCEEDED", "TIME_BUDGET_EXCEEDED", "SANITIZATION_FAILED", "ARTIFACT_EXISTS", "ARTIFACT_WRITE_FAILURE", "OFFLINE_TEST_FAILED"]);
const fail = (code) => { throw new Error(code); };
const safeCode = (error) => CODES.has(error?.message) ? error.message : "RPC_FAILURE";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, "/");
const isHash = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const isQuantity = (value) => typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
const safety = () => ({ readOnly: true, signing: false, submission: false, deployment: false, stateMutation: false, simulation: false, forkExecution: false, routePositive: false, executableNow: false, signedActionJustified: false, alertDispatch: false, rpcUrlsStored: false, keysRead: false, authMaterialStored: false });

function jsonBytes(value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (/(?:https?|wss?):\/\/|authorization\s*:|bearer\s|[?&](?:key|token)=/i.test(text)) fail("SANITIZATION_FAILED");
  return Buffer.from(text);
}
function decimal(value, decimals = 18) {
  const scale = 10n ** BigInt(decimals);
  return `${value / scale}.${(value % scale).toString().padStart(decimals, "0")}`;
}
function sourceEvidence() {
  return [
    ["targets/morpho-blue/src/Morpho.sol", "_isHealthy: maxBorrow >= borrowed; _accrueInterest: Taylor-compounded borrow rate"],
    ["targets/morpho-blue/src/interfaces/IOracle.sol", "price raw loan units per raw collateral unit, scaled by 1e36; whole-token precision 36+6-8=34"],
    ["targets/morpho-blue/src/libraries/SharesMathLib.sol", "toAssetsUp: ceil(shares*(assets+1)/(totalShares+1e6))"],
    ["targets/morpho-blue/src/libraries/MathLib.sol", "wTaylorCompounded, wMulDown, mulDivDown"],
    ["targets/morpho-blue-oracles/src/morpho-chainlink/MorphoChainlinkOracleV2.sol", "price adapter normalizes underlying feed decimals; do not use the Chainlink 1e8 feed scale"],
  ].map(([file, interpretation]) => {
    let digest = null;
    try { digest = sha(fs.readFileSync(path.join(ROOT, file))); } catch (_) { /* source availability is metadata */ }
    return { path: file, sha256: digest, interpretation };
  });
}
function createTransport({ send, mode, now = () => performance.now(), maxRequests = MAX_REQUESTS, maxMs = MAX_MS, oracleTargets = new Set([ORACLE]) }) {
  const started = now(), ledger = [];
  const check = () => { if (now() - started >= Math.min(maxMs, MAX_MS)) fail("TIME_BUDGET_EXCEEDED"); };
  return {
    mode, ledger, check, maxRequests: Math.min(maxRequests, 25),
    get elapsedMs() { return Math.max(0, Math.round(now() - started)); },
    async rpc(method, params) {
      check();
      if (!METHODS.has(method)) fail("METHOD_REJECTED");
      // Reject even eth_call unless it is one of the four observation-only getters.
      if (method === "eth_call") {
        const call = params[0], selector = call?.data?.slice(0, 10);
        const allowed = call?.to === MORPHO ? ["position", "market", "idToMarketParams"].map((name) => CORE.getFunction(name).selector)
          : oracleTargets.has(call?.to) ? [PRICE.getFunction("price").selector] : [IRM.getFunction("borrowRateView").selector];
        if (!allowed.includes(selector) || Object.keys(call).some((key) => !["to", "data"].includes(key))) fail("METHOD_REJECTED");
      }
      if (ledger.length >= Math.min(maxRequests, 25)) fail("RPC_BUDGET_EXCEEDED");
      const row = { ordinal: ledger.length + 1, method, status: "PENDING", durationMs: 0 };
      ledger.push(row);
      const start = now();
      try {
        const value = await send(method, params, row.ordinal, Math.min(10000, Math.max(1, Math.min(maxMs, MAX_MS) - (now() - started))));
        check(); row.status = "OK"; return value;
      } catch (error) { row.status = safeCode(error); throw new Error(row.status); }
      finally { row.durationMs = Math.max(0, Math.round(now() - start)); }
    },
  };
}
function liveSend(rpcUrl = "https://base-rpc.publicnode.com") {
  let url;
  try { url = new URL(rpcUrl); } catch (_) { fail("RPC_UNAVAILABLE"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) fail("RPC_UNAVAILABLE");
  // Never print/persist the endpoint or upstream error text. No endpoint inventory or secrets are read.
  return async (method, params, id, timeoutMs) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, redirect: "error", body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
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
function validHeader(header) {
  return header && isQuantity(header.number) && isHash(header.hash) && isQuantity(header.timestamp)
    && Number.isSafeInteger(Number(BigInt(header.number))) && Number.isSafeInteger(Number(BigInt(header.timestamp)));
}
function classify(maxBorrow, debt) {
  if (debt === 0n || maxBorrow * 100n > debt * 105n) return "SCOPED_ABOVE_THRESHOLD";
  return maxBorrow > debt ? "NEAR_LIQUIDATION" : "LIQUIDATABLE";
}
function compute(position, market, params, price, timestamp, rate) {
  const elapsed = BigInt(timestamp) - market[4];
  if (elapsed < 0n || market[4] === 0n || params[4] <= 0n || params[4] >= WAD || price <= 0n
      || position[1] > market[3] || market[5] > WAD) fail("MARKET_INVALID");
  const first = rate * elapsed, second = first * first / (2n * WAD), third = second * first / (3n * WAD);
  const interest = market[2] * (first + second + third) / WAD;
  const assets = market[2] + interest;
  if (assets >= 2n ** 128n || market[0] + interest >= 2n ** 128n) fail("MARKET_INVALID");
  // Same virtual shares/assets and ceiling as Morpho._isHealthy, NOT a naive proportional debt.
  const debt = (position[1] * (assets + 1n) + market[3] + 1000000n - 1n) / (market[3] + 1000000n);
  const collateralValue = position[2] * price / ORACLE_SCALE;
  const maxBorrow = collateralValue * params[4] / WAD;
  const hf = debt === 0n ? null : maxBorrow * WAD / debt;
  const adverse = maxBorrow === 0n ? 0n : maxBorrow > debt ? (maxBorrow - debt) * 100n * WAD / maxBorrow : 0n;
  return {
    collateralRaw: position[2].toString(), collateralCbBTC: decimal(position[2], 8),
    debtRawUsdc: debt.toString(), debtUsdc: decimal(debt, 6), debtWad: (debt * 10n ** 12n).toString(),
    collateralValueRawUsdc: collateralValue.toString(), collateralValueUsdc: decimal(collateralValue, 6),
    maxBorrowRawUsdc: maxBorrow.toString(), lltvWad: params[4].toString(), lltv: decimal(params[4]),
    oraclePriceRaw: price.toString(), oracleScale: ORACLE_SCALE.toString(), wholeTokenPriceDecimals: 34,
    priceUsdcPerCbBTC: decimal(price / 10n ** 16n),
    accruedInterestRawUsdc: interest.toString(), accruedTotalBorrowAssets: assets.toString(),
    elapsedSinceLastUpdateSeconds: elapsed.toString(), borrowRatePerSecondWad: rate.toString(),
    hf: hf === null ? null : decimal(hf), hfWad: hf?.toString() ?? null, noDebt: debt === 0n,
    adverseMoveToLiquidationPct: debt === 0n ? null : decimal(adverse),
    protocolLiquidatableAtPin: debt > maxBorrow,
    verdict: classify(maxBorrow, debt),
  };
}
async function capture({ transport, block = null, fixtureId = null, watch = null }) {
  const marketId = watch?.marketId ?? MARKET_ID, borrower = watch?.borrower ?? BORROWER;
  const oracle = watch?.oracle ?? ORACLE, collateralToken = watch?.collateralToken ?? CBBTC;
  const enforcement = watch ? ENFORCEMENT.replace("Morpho cbBTC/USDC borrower", "configured Morpho/USDC borrower") : ENFORCEMENT;
  const result = {
    schema: SCHEMA, kind: "LiveWatch", generatedAt: new Date().toISOString(), runId: crypto.randomBytes(8).toString("hex"),
    identity: { producer: "tools/morpho-cbbtc-watch.js", chainId: 8453, morpho: MORPHO, marketId: MARKET_ID, borrower: BORROWER, oracle: ORACLE, collateralToken: CBBTC, loanToken: USDC, collateralDecimals: 8, loanDecimals: 6 },
    mode: transport.mode, fixtureId, status: "INCOMPLETE", reason: null,
    pin: { requested: block || "finalized", finalizedNumber: null, finalizedHash: null, number: null, hash: null, timestamp: null, rechecked: false, valid: false, callBinding: "EIP-1898 blockHash + requireCanonical" },
    provenance: { provider: transport.mode === "live" ? "single-explicit-or-default-base-provider-redacted" : "synthetic-fixture", sources: sourceEvidence(),
      fixturePath: fixtureId ? rel(FIXTURES) : null, fixtureSha256: fixtureId ? sha(fs.readFileSync(FIXTURES)) : null,
      formula: "HF = floor(floor(collateralRaw * price / 1e36) * LLTV / 1e18) / ceil(borrowShares * (accruedTotalBorrowAssets + 1) / (totalBorrowShares + 1e6))",
      priceUnits: "Morpho adapter price is loan-raw/collateral-raw * 1e36, not a Chainlink 1e8 answer. cbBTC=8 decimals; USDC=6; whole-token price is price/1e34 USDC per cbBTC. Values are USDC, not an assumed USD peg.",
      debtPolicy: "Local Taylor accrual using pinned read-only borrowRateView; observation arithmetic, not a fork/transaction simulation. Getter failure is INCOMPLETE; no assumed rate or LLTV.",
      equalityPolicy: "Requested LIQUIDATABLE watch bucket includes HF=1; Morpho._isHealthy still accepts equality. Consult protocolLiquidatableAtPin; this is not execution proof." },
    reads: {}, metrics: null, trigger: { status: "INCOMPLETE", reason: null }, enforcement: ENFORCEMENT, safety: safety(),
    timing: { maxMs: MAX_MS, durationMs: 0, completedAt: null }, diagnostics: null,
  };
  if (watch) {
    result.enforcement = enforcement;
    Object.assign(result.identity, { marketId, borrower, oracle, collateralToken, collateralDecimals: watch.collateralDecimals });
    result.provenance.sources[1].interpretation = `price raw loan units per raw collateral unit, scaled by 1e36; whole-token precision 36+6-${watch.collateralDecimals}=${36 + 6 - watch.collateralDecimals}`;
    result.provenance.priceUnits = `Morpho adapter loan-raw/collateral-raw * 1e36; whole-token price decimals=${36 + 6 - watch.collateralDecimals}. Values are USDC, not an assumed USD peg.`;
  }
  try {
    if (await transport.rpc("eth_chainId", []) !== "0x2105") fail("CHAIN_NOT_BASE");
    const finalized = await transport.rpc("eth_getBlockByNumber", ["finalized", false]);
    if (!validHeader(finalized)) fail("PIN_INVALID");
    result.pin.finalizedNumber = Number(BigInt(finalized.number)); result.pin.finalizedHash = finalized.hash.toLowerCase();
    if (block && BigInt(block) > BigInt(finalized.number)) fail("PIN_NOT_FINALIZED");
    const header = block && BigInt(block) !== BigInt(finalized.number) ? await transport.rpc("eth_getBlockByNumber", [block, false]) : finalized;
    if (!validHeader(header) || (block && BigInt(header.number) !== BigInt(block))) fail("PIN_INVALID");
    Object.assign(result.pin, { number: Number(BigInt(header.number)), hash: header.hash.toLowerCase(), timestamp: Number(BigInt(header.timestamp)) });
    const tag = { blockHash: result.pin.hash, requireCanonical: true };
    async function read(name, target, iface, args, names) {
      const raw = await transport.rpc("eth_call", [{ to: target, data: iface.encodeFunctionData(name, args) }, tag]);
      if (typeof raw !== "string" || !/^0x(?:[0-9a-f]{64})+$/i.test(raw) || raw.length !== 2 + names.length * 64) fail("READ_INVALID");
      let decoded;
      try {
        decoded = iface.decodeFunctionResult(name, raw);
        if (iface.encodeFunctionResult(name, decoded).toLowerCase() !== raw.toLowerCase()) fail("READ_INVALID");
      } catch (_) { fail("READ_INVALID"); }
      result.reads[name] = { target, returnData: raw, sha256: sha(Buffer.from(raw.slice(2), "hex")), values: Object.fromEntries(names.map((field, i) => [field, typeof decoded[i] === "bigint" ? decoded[i].toString() : decoded[i].toLowerCase()])) };
      return decoded;
    }
    const params = await read("idToMarketParams", MORPHO, CORE, [marketId], ["loanToken", "collateralToken", "oracle", "irm", "lltv"]);
    const paramsHash = keccak256(AbiCoder.defaultAbiCoder().encode([PARAMS], [params]));
    if (paramsHash !== marketId || params[0].toLowerCase() !== USDC || params[1].toLowerCase() !== collateralToken || params[2].toLowerCase() !== oracle || params[4] <= 0n || params[4] >= WAD) fail("MARKET_PARAMS_INVALID");
    const position = await read("position", MORPHO, CORE, [marketId, borrower], ["supplyShares", "borrowShares", "collateral"]);
    const market = await read("market", MORPHO, CORE, [marketId], ["totalSupplyAssets", "totalSupplyShares", "totalBorrowAssets", "totalBorrowShares", "lastUpdate", "fee"]);
    const [price] = await read("price", oracle, PRICE, [], ["price"]);
    let rate = 0n;
    if (params[3].toLowerCase() !== ZERO && BigInt(result.pin.timestamp) > market[4]) {
      [rate] = await read("borrowRateView", params[3].toLowerCase(), IRM, [params, market], ["borrowRatePerSecondWad"]);
    }
    const recheck = await transport.rpc("eth_getBlockByNumber", [header.number, false]);
    result.pin.rechecked = true;
    if (!validHeader(recheck) || recheck.number !== header.number || recheck.hash.toLowerCase() !== result.pin.hash || recheck.timestamp !== header.timestamp) fail("PIN_DRIFT");
    result.pin.valid = true;
    result.metrics = compute(position, market, params, price, result.pin.timestamp, rate);
    if (watch) {
      delete result.metrics.collateralCbBTC; delete result.metrics.priceUsdcPerCbBTC;
      result.metrics.collateralAmount = decimal(position[2], watch.collateralDecimals);
      result.metrics.wholeTokenPriceDecimals = 36 + 6 - watch.collateralDecimals;
      result.metrics.priceUsdcPerCollateral = decimal(price, result.metrics.wholeTokenPriceDecimals);
    }
    transport.check(); result.status = "COMPLETE";
  } catch (error) { result.reason = safeCode(error); }
  result.timing.durationMs = transport.elapsedMs; result.timing.completedAt = new Date().toISOString();
  if (result.timing.durationMs >= MAX_MS) { result.status = "INCOMPLETE"; result.reason = "TIME_BUDGET_EXCEEDED"; }
  if (result.status === "INCOMPLETE") result.metrics = null;
  result.trigger = { status: result.status === "COMPLETE" ? result.metrics.verdict : "INCOMPLETE", reason: result.reason };
  result.verdict = `${enforcement} ${result.trigger.status}${result.metrics ? `; HF=${result.metrics.hf ?? "unbounded (no debt)"}; adverse move to HF=1: ${result.metrics.adverseMoveToLiquidationPct ?? "not applicable"}%.` : ` (${result.reason}); HF is unknown, never assumed zero.`}`;
  result.diagnostics = { rpcCount: transport.mode === "live" ? transport.ledger.length : 0, simulatedRpcCount: transport.mode === "live" ? 0 : transport.ledger.length, requestCount: transport.ledger.length, maxRpcRequests: transport.maxRequests ?? MAX_REQUESTS, retries: 0, methodLedger: [...transport.ledger] };
  return result;
}

// Fixed market params are fixture INPUT only; live LLTV is always the pinned getter result.
const FIXTURE_PARAMS = [USDC, CBBTC, ORACLE, "0x46415998764c29ab2a25cbea6254146d50d22687", 860000000000000000n];
function fixtureTransport(fixtures, testCase, options = {}) {
  let headerReads = 0;
  const timestamp = BigInt(fixtures.block.timestamp);
  const debt = BigInt(testCase.debtUsdc) * 10n ** 6n;
  const shares = debt * 1000000n;
  const market = [debt + 10n ** 12n, (debt + 10n ** 12n) * 1000000n, debt, shares, timestamp - BigInt(testCase.elapsed || 0), 0n];
  const send = async (method, args) => {
    if (method === "eth_chainId") return testCase.wrongChain ? "0x1" : "0x2105";
    if (method === "eth_getBlockByNumber") {
      headerReads += 1;
      return { ...fixtures.block, number: args[0] === "finalized" ? fixtures.block.number : args[0], hash: headerReads > 1 && testCase.drift ? `0x${"22".repeat(32)}` : fixtures.block.hash };
    }
    if (method !== "eth_call") fail("METHOD_REJECTED");
    assert.deepEqual(args[1], { blockHash: fixtures.block.hash, requireCanonical: true });
    const iface = args[0].to === MORPHO ? CORE : args[0].to === ORACLE ? PRICE : IRM;
    const parsed = iface.parseTransaction({ data: args[0].data });
    const name = parsed.name;
    if (name === testCase.failRead) fail("RPC_FAILURE");
    if (name === testCase.malformedRead) return "0x01";
    if (["position", "market", "idToMarketParams"].includes(name)) assert.equal(parsed.args[0], MARKET_ID);
    if (name === "position") assert.equal(parsed.args[1].toLowerCase(), BORROWER);
    const params = [...FIXTURE_PARAMS];
    if (testCase.wrongOracle) params[2] = ZERO;
    const values = { idToMarketParams: params, position: [0n, shares, 100000000n], market, price: [100000n * 10n ** 34n], borrowRateView: [BigInt(testCase.rate || 0)] };
    return iface.encodeFunctionResult(name, values[name]);
  };
  return createTransport({ send, mode: "dry-run", ...options });
}
function atomicJson(file, value, replace = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`, bytes = jsonBytes(value);
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (replace) fs.renameSync(temporary, file);
    else { try { fs.linkSync(temporary, file); } catch (error) { if (error.code === "EEXIST") fail("ARTIFACT_EXISTS"); throw error; } }
    return { sha256: sha(bytes), bytes: bytes.length };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (_) { /* renamed/removed */ }
  }
}
function writeEvidence(file, value) {
  const digest = atomicJson(file, value);
  atomicJson(file.replace(/\.json$/, ".manifest.json"), { schema: "morpho-cbbtc-watch-manifest/v1", artifact: rel(file), ...digest, enforcement: ENFORCEMENT, safety: safety() });
  return rel(file);
}
function persistCapture(value, latest = false) {
  const filename = `${value.generatedAt.replace(/[-:.]/g, "")}-b${value.pin.number ?? "unknown"}-${value.runId}.json`;
  const artifactPath = writeEvidence(path.join(OUT, filename), value);
  if (latest) {
    const date = new Date(value.generatedAt), nextDue = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
    atomicJson(OUTPUT, { ...value, artifactPath, artifactSha256: sha(fs.readFileSync(path.join(ROOT, artifactPath))), cadence: { utc: "00:00", nextDueAt: nextDue, registration: "follow-on; separate durable due gate; not the 900-second producer loop" }, freshness: { validUntil: nextDue, liveObservation: value.mode === "live" } }, true);
  }
  return artifactPath;
}
function freshStatus(block) {
  try {
    const value = JSON.parse(fs.readFileSync(OUTPUT));
    if (value.schema !== SCHEMA || value.mode !== "live" || value.status !== "COMPLETE" || !value.pin.valid || !value.verdict.startsWith(ENFORCEMENT)
        || value.generatedAt.slice(0, 10) !== new Date().toISOString().slice(0, 10) || Date.parse(value.generatedAt) > Date.now()
        || (block ? BigInt(value.pin.number) !== BigInt(block) : value.pin.requested !== "finalized")
        || !/^reports\/raw\/fast\/morpho-cbbtc-watch\/[^/]+\.json$/.test(value.artifactPath)
        || value.diagnostics.requestCount > MAX_REQUESTS || JSON.stringify(value.safety) !== JSON.stringify(safety())) return null;
    const file = path.join(ROOT, value.artifactPath), bytes = fs.readFileSync(file);
    const manifest = JSON.parse(fs.readFileSync(file.replace(/\.json$/, ".manifest.json")));
    jsonBytes(value);
    return sha(bytes) === value.artifactSha256 && manifest.sha256 === value.artifactSha256 && manifest.artifact === value.artifactPath ? value : null;
  } catch (_) { return null; }
}
async function offlineTest() {
  const fixtures = JSON.parse(fs.readFileSync(FIXTURES)), cases = [];
  const networkFetch = globalThis.fetch;
  globalThis.fetch = () => fail("METHOD_REJECTED");
  async function test(id, fn) {
    try { await fn(); cases.push({ id, passed: true }); } catch (_) { cases.push({ id, passed: false }); }
  }
  try {
    for (const testCase of fixtures.cases) {
      const value = await capture({ transport: fixtureTransport(fixtures, testCase), fixtureId: testCase.id });
      let passed = false;
      try {
        assert.equal(value.trigger.status, testCase.expected);
        assert.equal(value.status, testCase.expected === "INCOMPLETE" ? "INCOMPLETE" : "COMPLETE");
        assert.equal(value.diagnostics.rpcCount, 0); assert.ok(value.diagnostics.requestCount <= MAX_REQUESTS);
        assert.deepEqual(value.safety, safety()); assert.ok(value.verdict.startsWith(ENFORCEMENT));
        if (value.status === "COMPLETE") {
          assert.equal(value.metrics.collateralValueRawUsdc, "100000000000");
          assert.equal(value.metrics.lltvWad, "860000000000000000");
          if (!testCase.elapsed) assert.equal(value.metrics.debtUsdc, `${testCase.debtUsdc}.000000`);
          if (testCase.elapsed) assert.ok(BigInt(value.metrics.accruedInterestRawUsdc) > 0n);
          assert.equal(value.pin.valid, true);
        } else {
          assert.equal(value.metrics, null); assert.equal(value.reason, testCase.reason);
          if (testCase.failRead) assert.equal(value.diagnostics.methodLedger.at(-1).status, "RPC_FAILURE");
        }
        assert.deepEqual(JSON.parse(jsonBytes(value)), value); passed = true;
      } catch (_) { /* sanitized test outcome only */ }
      cases.push({ id: testCase.id, passed, expected: testCase.expected, actual: value.trigger.status, capture: value });
    }
    await test("thresholds-exact-not-rounded", () => {
      assert.equal(classify(106n, 100n), "SCOPED_ABOVE_THRESHOLD");
      assert.equal(classify(105n, 100n), "NEAR_LIQUIDATION");
      assert.equal(classify(101n, 100n), "NEAR_LIQUIDATION");
      assert.equal(classify(100n, 100n), "LIQUIDATABLE");
      assert.equal(classify(99n, 100n), "LIQUIDATABLE");
    });
    await test("correct-hf-and-adverse-move", async () => {
      const value = await capture({ transport: fixtureTransport(fixtures, fixtures.cases[1]) });
      assert.equal(value.metrics.hf, "1.036144578313253012");
      assert.equal(value.metrics.adverseMoveToLiquidationPct, "3.488372093023255813");
    });
    await test("virtual-share-rounding-and-equality", () => {
      const market = [1000000n, 1000000n, 100n, 100n, 100n, 0n];
      const result = compute([0n, 1n, 1n], market, FIXTURE_PARAMS, 2n * ORACLE_SCALE, 100, 0n);
      assert.equal(result.debtRawUsdc, "1"); assert.equal(result.maxBorrowRawUsdc, "1");
      assert.equal(result.verdict, "LIQUIDATABLE"); assert.equal(result.protocolLiquidatableAtPin, false);
    });
    await test("explicit-historical-pin-is-finalized", async () => {
      const block = `0x${(BigInt(fixtures.block.number) - 1n).toString(16)}`;
      const value = await capture({ transport: fixtureTransport(fixtures, fixtures.cases[0]), block });
      assert.equal(value.status, "COMPLETE"); assert.equal(value.pin.number, Number(BigInt(block)));
      const future = await capture({ transport: fixtureTransport(fixtures, fixtures.cases[0]), block: `0x${(BigInt(fixtures.block.number) + 1n).toString(16)}` });
      assert.equal(future.reason, "PIN_NOT_FINALIZED"); assert.equal(future.metrics, null);
    });
    await test("live-requires-both-flags", () => {
      assert.throws(() => parseArgs(["--live"])); assert.throws(() => parseArgs(["--once", "--live", "--offline-test"]));
      assert.equal(parseArgs([]).live, false); assert.equal(parseArgs(["--once"]).live, false);
      assert.equal(parseArgs(["--once", "--live"]).live, true);
    });
    await test("eleventh-request-refused", async () => {
      const transport = fixtureTransport(fixtures, fixtures.cases[0]);
      for (let i = 0; i < 10; i++) await transport.rpc("eth_chainId", []);
      const value = await capture({ transport });
      assert.equal(value.reason, "RPC_BUDGET_EXCEEDED"); assert.equal(transport.ledger.length, 10);
    });
    await test("time-budget-incomplete", async () => {
      let clock = 0;
      const transport = createTransport({ mode: "dry-run", now: () => clock, send: async () => { clock = MAX_MS; return "0x2105"; } });
      const value = await capture({ transport }); assert.equal(value.reason, "TIME_BUDGET_EXCEEDED");
    });
    await test("mutating-methods-and-selectors-refused", async () => {
      const transport = fixtureTransport(fixtures, fixtures.cases[0]);
      for (const method of ["eth_sendTransaction", "eth_sendRawTransaction", "eth_sign", "debug_traceCall"]) await assert.rejects(transport.rpc(method, []), /METHOD_REJECTED/);
      await assert.rejects(transport.rpc("eth_call", [{ to: MORPHO, data: "0x12345678" }, "latest"]), /METHOD_REJECTED/);
      assert.equal(transport.ledger.length, 0);
    });
    await test("endpoint-and-auth-sanitization", async () => {
      assert.throws(() => jsonBytes({ endpoint: "https://secret.invalid/key" }), /SANITIZATION_FAILED/);
      const value = await capture({ transport: createTransport({ mode: "dry-run", send: async () => { throw new Error("https://secret.invalid?key=secret"); } }) });
      assert.equal(value.reason, "RPC_FAILURE"); assert.ok(!JSON.stringify(value).includes("secret"));
    });
    const summary = { schema: "morpho-cbbtc-watch-offline-test/v1", generatedAt: new Date().toISOString(), passed: cases.every((entry) => entry.passed), rpcCount: 0, cases, enforcement: ENFORCEMENT, safety: safety() };
    const artifactPath = writeEvidence(path.join(OUT, `offline-test-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`), summary);
    process.stdout.write(JSON.stringify({ passed: summary.passed, artifactPath, rpcCount: 0, cases: cases.map(({ id, passed, actual }) => ({ id, passed, actual })), enforcement: ENFORCEMENT }) + "\n");
    if (!summary.passed) fail("OFFLINE_TEST_FAILED");
  } finally { globalThis.fetch = networkFetch; }
}
function parseArgs(argv) {
  const options = { live: false, once: false, refresh: false, offlineTest: false, block: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--once") options.once = true;
    else if (arg === "--default-cbbtc") { /* Explicit legacy single-pair default; capture shape is unchanged. */ }
    else if (arg === "--live") options.live = true;
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
  const options = parseArgs(argv);
  if (options.offlineTest) return offlineTest();
  if (options.live && !options.refresh) {
    const cached = freshStatus(options.block);
    if (cached) { process.stdout.write(JSON.stringify({ status: cached.status, mode: "live", reused: true, artifactPath: cached.artifactPath, rpcCount: 0, verdict: cached.verdict }) + "\n"); return; }
  }
  let transport, fixtureId = null;
  if (options.live) {
    try { transport = createTransport({ send: liveSend(options.rpcUrl), mode: "live" }); }
    catch (_) { transport = createTransport({ send: async () => fail("RPC_UNAVAILABLE"), mode: "live" }); }
  } else {
    const fixtures = JSON.parse(fs.readFileSync(FIXTURES));
    fixtureId = fixtures.cases[1].id; transport = fixtureTransport(fixtures, fixtures.cases[1]);
  }
  const value = await capture({ transport, block: options.block, fixtureId });
  let prior = null;
  try { prior = JSON.parse(fs.readFileSync(OUTPUT)); } catch (_) { /* first capture */ }
  // Synthetic evidence never replaces an existing live status, even a live failure.
  const artifactPath = persistCapture(value, options.live || prior?.mode !== "live");
  process.stdout.write(JSON.stringify({ status: value.status, trigger: value.trigger.status, mode: value.mode, artifactPath, rpcCount: value.diagnostics.rpcCount, verdict: value.verdict }) + "\n");
  if (value.status === "INCOMPLETE") process.exitCode = 1;
}
module.exports = { SCHEMA, OUTPUT, MORPHO, MARKET_ID, BORROWER, ORACLE, MAX_REQUESTS, MAX_MS, ENFORCEMENT, createTransport, capture, compute, classify, parseArgs, main };
module.exports.helpers = { ROOT, FIXTURES, OUT, USDC, CBBTC, CORE, PRICE, IRM, PARAMS, FIXTURE_PARAMS, liveSend, validHeader, safeCode, safety, jsonBytes, atomicJson, writeEvidence, sha, rel, decimal, fixtureTransport };
if (require.main === module) main().catch((error) => {
  process.stdout.write(JSON.stringify({ status: "INCOMPLETE", reason: safeCode(error), enforcement: ENFORCEMENT, safety: safety() }) + "\n");
  process.exitCode = 1;
});
