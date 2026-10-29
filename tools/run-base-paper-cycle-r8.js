"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Interface, keccak256, formatUnits } = require("ethers");
const { requestJSON, header } = require("./run-base-redemption-paper-state-r1");
const { parseRpcInventory, getOrigin } = require("./shared-rpc");
const { classifyOperatorFamily } = require("./lib/common-finalized-rpc-preflight");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "reports/raw/fast/base-paper-cycle-r8.json");
const A = Object.freeze({
  usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  weth: "0x4200000000000000000000000000000000000006",
  susds: "0x5875eee11cf8398102fdad704c9e96607675467a",
  usds: "0x820c137fa70c8691f0e44dc420a5e53c168921dc",
  psm: "0x1601843c5e9bc251a3272907010afa41fa18347e",
  rate: "0x65d946e533748a998b1f0e430803e39a6388f7a1",
  pool: "0xaa9780e54843013ff2ee957d103e96f4777a54e7",
  factory: "0x420dd381b31aef6683db6b902084cb0ffece40da",
});
const CAP = Object.freeze({ candidates: 8, requests: 240, wallMs: 360000, requestMs: 8000, paceMs: 200,
  responseBytes: 1024 * 1024, totalBytes: 16 * 1024 * 1024, maxAgeSeconds: 3600 });
const SIZES = Object.freeze([1n, 5n, 10n, 25n, 50n, 100n].map(n => n * 1000000n));
const PSM_COMMIT = "6a5a579cb503a461df254007064370f732fcd19d";
const AERO_REFERENCE_COMMIT = "1ba30815bba620f7e9faa34769ffd00c214c9b82";
const SOURCE_BLOBS = Object.freeze({
  "src/PSM3.sol": "3298e9734a5012220e0e6ed0bff17df89285ef27",
  "src/interfaces/IPSM3.sol": "4fae68a1343c824d1332c30f506d8961383705ad",
  "src/interfaces/IRateProviderLike.sol": "75137d255f006ba9b95a7d91f187e9749309fc35",
});
const I = Object.freeze({
  token: new Interface(["function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)"]),
  pool: new Interface(["function tokens() view returns(address,address)", "function factory() view returns(address)", "function stable() view returns(bool)",
    "function getReserves() view returns(uint256,uint256,uint256)", "function getAmountOut(uint256,address) view returns(uint256)"]),
  factory: new Interface(["function getPool(address,address,bool) view returns(address)", "function getFee(address,bool) view returns(uint256)",
    "function isPool(address) view returns(bool)", "function isPaused() view returns(bool)", "function implementation() view returns(address)"]),
  psm: new Interface(["function usdc() view returns(address)", "function usds() view returns(address)", "function susds() view returns(address)",
    "function rateProvider() view returns(address)", "function pocket() view returns(address)", "function previewSwapExactIn(address,address,uint256) view returns(uint256)"]),
  rate: new Interface(["function getConversionRate() view returns(uint256)"]),
});
class CycleError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new CycleError(code); };
const safeCode = error => error instanceof CycleError ? error.code : "UNEXPECTED_FAILURE";
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const addr = value => {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value)) fail("ADDRESS_INVALID");
  return value.toLowerCase();
};
const psmOutput = (amount, rate) => amount * rate / 10n ** 27n * 10n ** 6n / 10n ** 18n;
function volatileOutput(amount, reserveIn, reserveOut, fee) {
  const afterFee = amount - amount * fee / 10000n;
  return afterFee * reserveOut / (reserveIn + afterFee);
}

function verifyPrimarySource() {
  for (const [file, expected] of Object.entries(SOURCE_BLOBS)) {
    const filename = path.join(ROOT, "targets/spark-psm", file);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) fail("PRIMARY_SOURCE_UNSAFE");
    const bytes = Buffer.from(fs.readFileSync(filename, "utf8").replace(/\r\n/g, "\n"), "utf8");
    const blob = crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (blob !== expected) fail("PRIMARY_SOURCE_MISMATCH");
  }
  return true;
}

// Selection metadata and all endpoint material stay in process, never in the artifact.
function candidatePool(text) {
  const seen = new Set();
  const rows = [];
  // The shared parser drops trailing annotations; reject origin-marked rows first.
  const unannotated = text.split(/\r?\n/).filter(line => !/\[\s*origin\s*:/i.test(line)).join("\n");
  for (const value of parseRpcInventory(unannotated, { maxCandidates: 128 })) {
    try {
      const url = new URL(value), family = classifyOperatorFamily(value);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || getOrigin(value) || !family || seen.has(value)) continue;
      seen.add(value);
      rows.push({ url, family: family.operatorFamily, rank: family.capabilityRank, baseHint: /base|8453/i.test(url.hostname + url.pathname + url.search) ? 0 : 1 });
    } catch (_) { /* Invalid inventory rows are never reflected. */ }
  }
  rows.sort((a, b) => a.baseHint - b.baseHint || a.rank - b.rank);
  const counts = new Map();
  return rows.filter(row => {
    const count = counts.get(row.family) || 0;
    counts.set(row.family, count + 1);
    return count < 2;
  }).slice(0, CAP.candidates);
}
function readCandidates() {
  const file = path.join(ROOT, "rpc_endpoints.txt");
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 * 1024) fail("INVENTORY_UNSAFE");
  const bytes = fs.readFileSync(file);
  try {
    const after = fs.lstatSync(file);
    if (before.size !== bytes.length || ["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(k => before[k] !== after[k])) fail("INVENTORY_CHANGED");
    return candidatePool(bytes.toString("utf8"));
  } finally { bytes.fill(0); }
}

async function run(deps = {}) {
  const clock = deps.clock || Date.now, started = clock();
  const out = { schema: "base-paper-cycle/v8", chainId: 8453, generatedAt: new Date(started).toISOString(),
    study: "ORDINARY_MARKET_QUOTES_ONLY", status: "INCOMPLETE", code: null, phase: "SOURCE", operation: null,
    addresses: A, inputSizesUsdcRaw: SIZES.map(String), requests: 0, bytes: 0,
    source: { psmCommit: PSM_COMMIT, psmPrimarySourceMatches: false, normalization: "CRLF_TO_LF",
      aerodromeReferenceCommit: AERO_REFERENCE_COMMIT, dependencyBuildClosure: "unknown", sourceRuntimeBound: "unknown" },
    qualification: { attempted: 0, qualified: 0, selectedFamilyCount: 0, failures: {} }, observation: null,
    economics: { conservativeNetUsdc: null, conservativeNetUsd: null, conservativeNetNative: null, netBps: null,
      costsComplete: false, allSizesDisproved: false, fills: null, realizedPnl: null },
    gates: { profitabilityClaim: false, executableNow: "unknown", rateFreshness: "unknown", transferSuccess: "unknown", signedActionJustified: false },
    safety: { readOnly: true, inventoryRead: false, endpointMaterialPersisted: false, walletAccess: false, signing: false, transactions: 0, retries: 0 },
  };
  const transport = deps.transport || requestJSON;
  const allowed = new Set(Object.values(A));
  const methods = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"]);
  const budget = () => {
    if (clock() - started >= CAP.wallMs || out.requests >= CAP.requests) fail("REQUEST_OR_TIME_CAP");
  };
  const rpc = async (candidate, method, params) => {
    if (!methods.has(method)) fail("METHOD_FORBIDDEN");
    budget();
    if (!deps.transport) await new Promise(resolve => setTimeout(resolve, CAP.paceMs));
    budget();
    const id = ++out.requests;
    let response;
    try { response = await transport(candidate.url, { jsonrpc: "2.0", id, method, params }, Math.min(CAP.requestMs, CAP.wallMs - (clock() - started))); }
    catch (_) { fail("TRANSPORT_UNAVAILABLE"); }
    if (clock() - started >= CAP.wallMs) fail("REQUEST_OR_TIME_CAP");
    if (!response || !Number.isSafeInteger(response.bytes) || response.bytes < 0 || response.bytes > CAP.responseBytes) fail("RESPONSE_CAP");
    out.bytes += response.bytes;
    if (out.bytes > CAP.totalBytes) fail("TOTAL_BYTE_CAP");
    const data = response.value;
    if (!data || data.jsonrpc !== "2.0" || data.id !== id) fail("RPC_ENVELOPE_INVALID");
    if (Object.hasOwn(data, "error")) fail("RPC_UNAVAILABLE");
    if (!Object.hasOwn(data, "result")) fail("RPC_RESULT_MISSING");
    return data.result;
  };
  const fresh = pin => {
    const age = BigInt(Math.floor(clock() / 1000)) - BigInt(pin.timestamp);
    if (age < -60n || age > BigInt(CAP.maxAgeSeconds)) fail("FINALITY_STALE");
  };
  const getHeader = async (candidate, tag) => {
    let pin;
    try { pin = header(await rpc(candidate, "eth_getBlockByNumber", [tag, false])); }
    catch (error) { if (error instanceof CycleError) throw error; fail("HEADER_INVALID"); }
    fresh(pin);
    return pin;
  };
  const block = pin => ({ blockHash: pin.hash, requireCanonical: true });
  const getCode = async (candidate, target, pin) => {
    if (!allowed.has(target)) fail("TARGET_FORBIDDEN");
    const code = await rpc(candidate, "eth_getCode", [target, block(pin)]);
    if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(code) || code.length > 65538) fail("CODE_INVALID_OR_ABSENT");
    return code.toLowerCase();
  };
  const call = async (candidate, target, type, name, args, pin) => {
    out.operation = `${type}.${name}`;
    if (!allowed.has(target) || !Object.hasOwn(I, type)) fail("CALL_FORBIDDEN");
    const iface = I[type], fragment = iface.getFunction(name);
    if (fragment.stateMutability !== "view") fail("CALL_FORBIDDEN");
    const raw = await rpc(candidate, "eth_call", [{ to: target, data: iface.encodeFunctionData(name, args), gas: "0x1e8480" }, block(pin)]);
    try {
      const values = iface.decodeFunctionResult(name, raw);
      if (iface.encodeFunctionResult(name, values).toLowerCase() !== raw.toLowerCase()) fail("ABI_NONCANONICAL");
      return values;
    } catch (_) { fail("ABI_INVALID"); }
  };
  const scalar = async (...args) => (await call(...args))[0];
  const observe = async (candidate, pin) => {
    const view = { runtimeKeccak256: {}, pools: [], psm: {}, rows: [] };
    const implementation = addr(await scalar(candidate, A.factory, "factory", "implementation", [], pin));
    const first = addr(await scalar(candidate, A.factory, "factory", "getPool", [A.usdc, A.weth, false], pin));
    if (first === A.pool || Object.values(A).includes(first)) fail("FIRST_POOL_INVALID");
    allowed.add(first); allowed.add(implementation);
    if (await scalar(candidate, A.factory, "factory", "isPaused", [], pin)) fail("FACTORY_PAUSED");
    for (const target of [...Object.values(A), implementation]) view.runtimeKeccak256[target] = keccak256(await getCode(candidate, target, pin));
    for (const [target, expected] of [[A.usdc, 6n], [A.weth, 18n], [A.susds, 18n], [A.usds, 18n]]) {
      if (await scalar(candidate, target, "token", "decimals", [], pin) !== expected) fail("DECIMALS_MISMATCH");
    }
    for (const [target, input, output] of [[first, A.usdc, A.weth], [A.pool, A.weth, A.susds]]) {
      const code = await getCode(candidate, target, pin);
      view.runtimeKeccak256[target] = keccak256(code);
      if (code !== `0x363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`) fail("POOL_CLONE_MISMATCH");
      const tokens = (await call(candidate, target, "pool", "tokens", [], pin)).map(addr);
      if (!eq([...tokens].sort(), [input, output].sort())) fail("POOL_TOKENS_MISMATCH");
      if (addr(await scalar(candidate, target, "pool", "factory", [], pin)) !== A.factory) fail("POOL_FACTORY_MISMATCH");
      const stable = await scalar(candidate, target, "pool", "stable", [], pin);
      if (target === first && stable) fail("FIRST_POOL_TYPE_MISMATCH");
      if (!await scalar(candidate, A.factory, "factory", "isPool", [target], pin)
        || addr(await scalar(candidate, A.factory, "factory", "getPool", [input, output, stable], pin)) !== target) fail("FACTORY_RECOGNITION_MISMATCH");
      const fee = await scalar(candidate, A.factory, "factory", "getFee", [target, stable], pin);
      if (fee > 300n) fail("FEE_OUTSIDE_REVIEWED_RANGE");
      const reserves = await call(candidate, target, "pool", "getReserves", [], pin);
      if (reserves[0] === 0n || reserves[1] === 0n || reserves[2] > BigInt(pin.timestamp)) fail("RESERVES_INVALID");
      const balances = [];
      for (const token of tokens) balances.push(await scalar(candidate, token, "token", "balanceOf", [target], pin));
      view.pools.push({ address: target, implementation, token0: tokens[0], token1: tokens[1], stable, feeBps: fee.toString(),
        reserve0Raw: reserves[0].toString(), reserve1Raw: reserves[1].toString(), reserveTimestamp: reserves[2].toString(),
        balance0Raw: balances[0].toString(), balance1Raw: balances[1].toString(), balancesMatchReserves: balances[0] === reserves[0] && balances[1] === reserves[1] });
    }
    for (const [getter, expected] of [["usdc", A.usdc], ["usds", A.usds], ["susds", A.susds], ["rateProvider", A.rate]]) {
      if (addr(await scalar(candidate, A.psm, "psm", getter, [], pin)) !== expected) fail("PSM_CONFIGURATION_MISMATCH");
    }
    const pocket = addr(await scalar(candidate, A.psm, "psm", "pocket", [], pin));
    const rate = await scalar(candidate, A.rate, "rate", "getConversionRate", [], pin);
    if (rate === 0n) fail("RATE_ZERO");
    const balance = await scalar(candidate, A.usdc, "token", "balanceOf", [pocket], pin);
    const allowance = pocket === A.psm ? null : await scalar(candidate, A.usdc, "token", "allowance", [pocket, A.psm], pin);
    const capacity = allowance === null || balance < allowance ? balance : allowance;
    view.psm = { pocket, rateRay: rate.toString(), usdcBalanceRaw: balance.toString(), usdcAllowanceRaw: allowance === null ? null : allowance.toString(),
      balanceAllowanceCapacityRaw: capacity.toString(), capacityIsTransferProof: false };
    for (const input of SIZES) {
      let amount = input;
      const outputs = [];
      for (let index = 0; index < view.pools.length; index++) {
        const pool = view.pools[index], tokenIn = index === 0 ? A.usdc : A.weth;
        const amountOut = await scalar(candidate, pool.address, "pool", "getAmountOut", [amount, tokenIn], pin);
        const in0 = pool.token0 === tokenIn;
        const reserveIn = BigInt(in0 ? pool.reserve0Raw : pool.reserve1Raw), reserveOut = BigInt(in0 ? pool.reserve1Raw : pool.reserve0Raw);
        if (amountOut === 0n || amountOut >= reserveOut) fail("QUOTE_ZERO_OR_OUTSIDE_RESERVES");
        if (!pool.stable && amountOut !== volatileOutput(amount, reserveIn, reserveOut, BigInt(pool.feeBps))) fail("POOL_QUOTE_MODEL_MISMATCH");
        outputs.push(amountOut); amount = amountOut;
      }
      const final = await scalar(candidate, A.psm, "psm", "previewSwapExactIn", [A.susds, A.usdc, amount], pin);
      if (final !== psmOutput(amount, rate)) fail("PSM_PREVIEW_MODEL_MISMATCH");
      const surplus = final - input;
      view.rows.push({ inputUsdcRaw: input.toString(), wethRaw: outputs[0].toString(), susdsRaw: outputs[1].toString(), outputUsdcRaw: final.toString(),
        quotedSurplusUsdcRaw: surplus.toString(), quotedSurplusUsdc: formatUnits(surplus, 6),
        quotedSurplusBps: { numerator: (surplus * 10000n).toString(), denominator: input.toString() },
        pocketBalanceAllowanceSufficient: final <= capacity, poolsBalancesMatchReserves: view.pools.every(p => p.balancesMatchReserves),
        quoteIncludesPoolFeesAndImpact: true, conservativeNetUsdc: null, executable: "unknown" });
    }
    return view;
  };
  try {
    if ((deps.candidates || deps.sourceCheck || deps.clock) && !deps.transport) fail("INJECTED_TRANSPORT_REQUIRED");
    if ((deps.sourceCheck || verifyPrimarySource)() !== true) fail("PRIMARY_SOURCE_MISMATCH");
    out.source.psmPrimarySourceMatches = true;
    out.phase = "QUALIFICATION";
    if (!deps.candidates) out.safety.inventoryRead = true;
    const candidates = deps.candidates || readCandidates();
    if (!Array.isArray(candidates) || candidates.length > CAP.candidates) fail("CANDIDATE_CAP");
    const qualified = [];
    for (const candidate of candidates) {
      out.qualification.attempted++;
      try {
        if (await rpc(candidate, "eth_chainId", []) !== "0x2105") fail("CHAIN_MISMATCH");
        const pin = await getHeader(candidate, "finalized");
        await getCode(candidate, A.psm, pin);
        if (addr(await scalar(candidate, A.psm, "psm", "susds", [], pin)) !== A.susds) fail("PSM_CONFIGURATION_MISMATCH");
        const tokens = (await call(candidate, A.pool, "pool", "tokens", [], pin)).map(addr);
        if (!eq([...tokens].sort(), [A.weth, A.susds].sort())) fail("POOL_TOKENS_MISMATCH");
        qualified.push({ candidate, pin });
        out.qualification.qualified = qualified.length;
      } catch (error) {
        const code = safeCode(error);
        out.qualification.failures[code] = (out.qualification.failures[code] || 0) + 1;
        if (["REQUEST_OR_TIME_CAP", "TOTAL_BYTE_CAP"].includes(code)) throw error;
      }
    }
    const selected = [];
    for (const row of qualified) if (row.candidate.family && !selected.some(other => other.candidate.family === row.candidate.family)) selected.push(row);
    if (selected.length < 2) fail("TWO_STATE_CAPABLE_FAMILIES_UNAVAILABLE");
    selected.length = 2;
    out.qualification.selectedFamilyCount = 2;
    out.phase = "COMMON_PIN";
    const number = selected.reduce((n, row) => BigInt(row.pin.number) < n ? BigInt(row.pin.number) : n, BigInt(selected[0].pin.number));
    const tag = `0x${number.toString(16)}`;
    const pins = [];
    for (const row of selected) pins.push(await getHeader(row.candidate, tag));
    if (!eq(pins[0], pins[1]) || BigInt(pins[0].number) !== number) fail("PIN_DISAGREEMENT");
    const pin = pins[0], views = [];
    out.phase = "OBSERVATION";
    for (const row of selected) views.push(await observe(row.candidate, pin));
    if (!eq(views[0], views[1])) fail("OBSERVATION_DISAGREEMENT");
    out.phase = "TERMINAL";
    for (const row of selected) {
      if (!eq(await getHeader(row.candidate, tag), pin)) fail("TERMINAL_PIN_CHANGED");
      if (BigInt((await getHeader(row.candidate, "finalized")).number) < number) fail("FINALITY_REGRESSED");
    }
    fresh(pin);
    out.observation = { pin, rpcStrength: "corroborated-operator-families", upstreamIndependenceProven: false, ...views[0] };
    out.status = "OBSERVED_UNPROMOTED";
    out.code = views[0].rows.some(row => BigInt(row.quotedSurplusUsdcRaw) > 0n && row.pocketBalanceAllowanceSufficient && row.poolsBalancesMatchReserves)
      ? "QUOTED_SURPLUS_REQUIRES_VALIDATION" : "NO_CAPACITY_BACKED_POSITIVE_QUOTE_AT_TESTED_SIZES";
  } catch (error) { out.code = safeCode(error); }
  out.completedAt = new Date(clock()).toISOString();
  return out;
}

async function main() {
  if (process.argv.slice(2).join(" ") !== "--once") fail("EXPLICIT_ONCE_REQUIRED");
  if (fs.existsSync(OUTPUT)) fail("OUTPUT_EXISTS_NO_RETRY");
  const artifact = await run();
  const encoded = JSON.stringify(artifact, null, 2) + "\n";
  if (/(?:https?|wss?):\/\//i.test(encoded)) fail("OUTPUT_NOT_SANITIZED");
  const temporary = `${OUTPUT}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, encoded, { flag: "wx" });
    fs.linkSync(temporary, OUTPUT);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  process.stdout.write(JSON.stringify({ status: artifact.status, code: artifact.code, requests: artifact.requests,
    rows: artifact.observation?.rows.length || 0, artifact: path.relative(ROOT, OUTPUT), profitabilityClaim: false }) + "\n");
  if (artifact.status === "INCOMPLETE") process.exitCode = 1;
}
module.exports = { run, A, I, CAP, SIZES, SOURCE_BLOBS, OUTPUT, candidatePool, verifyPrimarySource, psmOutput, volatileOutput };
if (require.main === module) main().catch(() => { process.stderr.write("R8_FAILED_CLOSED\n"); process.exitCode = 1; });
