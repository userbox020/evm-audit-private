"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { Interface, AbiCoder, getCreate2Address, keccak256, formatUnits } = require("ethers");
const base = require("./run-base-redemption-paper-state-r1");
const r8 = require("./run-base-paper-cycle-r8");
const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "reports/raw/fast/base-paper-usds-r9.json");
const CAP = r8.CAP, SIZES = r8.SIZES;
const A = Object.freeze({ usdc: r8.A.usdc, usds: r8.A.usds, psm: r8.A.psm, weth: r8.A.weth,
  pool: "0x81057171115672ac7d08bbebb04481e19aa0bfeb",
  quoter: "0xb048bbc1ee6b733fffcfb9e9cef7375518e25997",
  factory: "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865",
  deployer: "0x41ff9aa7e16b8b1a8a8dc4f0efacd93d02d071c9" });
const FEE = 100n;
const INIT_HASH = "0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2";
const MIN_SQRT = 4295128739n, MAX_SQRT = 1461446703485210103287273052203988822378723970342n;
const I = Object.freeze({ token: r8.I.token, psm: r8.I.psm,
  pool: new Interface(["function token0() view returns(address)", "function token1() view returns(address)", "function factory() view returns(address)",
    "function fee() view returns(uint24)", "function tickSpacing() view returns(int24)", "function liquidity() view returns(uint128)",
    "function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)"]),
  factory: new Interface(["function getPool(address,address,uint24) view returns(address)", "function feeAmountTickSpacing(uint24) view returns(int24)"]),
  quoter: new Interface(["function factory() view returns(address)", "function deployer() view returns(address)", "function WETH9() view returns(address)",
    "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)"]),
});
class PaperError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new PaperError(code); };
const safe = error => error instanceof PaperError ? error.code : "UNEXPECTED_FAILURE";
const eq = (a, b) => JSON.stringify(a, (_, v) => typeof v === "bigint" ? v.toString() : v)
  === JSON.stringify(b, (_, v) => typeof v === "bigint" ? v.toString() : v);
const addr = value => {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value)) fail("ADDRESS_INVALID");
  return value.toLowerCase();
};
function computedPool() {
  const salt = keccak256(AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24"], [A.usds, A.usdc, FEE]));
  return getCreate2Address(A.deployer, salt, INIT_HASH).toLowerCase();
}
function quoteArgs(input) { return [[A.usdc, A.usds, input, FEE, 0n]]; }
function validateQuote(values) {
  const [amountOut, sqrtAfter, ticks, gas] = values;
  if (amountOut === 0n || sqrtAfter <= MIN_SQRT + 1n || sqrtAfter >= MAX_SQRT - 1n || gas === 0n || gas > 2000000n) fail("QUOTE_ZERO_LIMIT_OR_RANGE");
  return { usdsRaw: amountOut.toString(), sqrtAfterX96: sqrtAfter.toString(), initializedTicksCrossed: ticks.toString(), quoterGasEstimate: gas.toString() };
}
function readCandidates() {
  const file = path.join(ROOT, "rpc_endpoints.txt"), before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 * 1024) fail("INVENTORY_UNSAFE");
  const bytes = fs.readFileSync(file);
  try {
    const after = fs.lstatSync(file);
    if (before.size !== bytes.length || ["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(k => before[k] !== after[k])) fail("INVENTORY_CHANGED");
    return r8.candidatePool(bytes.toString("utf8"));
  } finally { bytes.fill(0); }
}

async function run(deps = {}) {
  const clock = deps.clock || Date.now, started = clock(), transport = deps.transport || base.requestJSON;
  const out = { schema: "base-paper-usds/v9", chainId: 8453, generatedAt: new Date(started).toISOString(),
    study: "ORDINARY_MARKET_QUOTES_ONLY", status: "INCOMPLETE", code: null, phase: "SOURCE", operation: null,
    addresses: A, inputSizesUsdcRaw: SIZES.map(String), feePips: FEE.toString(), requests: 0, bytes: 0,
    source: { psmCommit: "6a5a579cb503a461df254007064370f732fcd19d", psmPrimarySourceMatches: false,
      pancakeReferenceCommit: "986847948755cba528324d41be19480731c36c2a", poolCreate2Matches: false, sourceRuntimeBound: "unknown" },
    qualification: { attempted: 0, qualified: 0, selectedFamilyCount: 0, failures: {} }, observation: null,
    economics: { costsComplete: false, conservativeNetUsdc: null, conservativeNetUsd: null, conservativeNetNative: null, netBps: null,
      allSizesDisproved: false, fills: null, realizedPnl: null },
    gates: { profitabilityClaim: false, executableNow: "unknown", transferSuccess: "unknown", signedActionJustified: false,
      rateOracleDependency: "n/a", rateOracleRationale: "USDS_TO_USDC_SOURCE_CONVERSION_USES_TOKEN_PRECISIONS_ONLY" },
    safety: { readOnlyRpc: true, quoterUsesEphemeralRevertingSwap: true, inventoryRead: false, endpointMaterialPersisted: false,
      walletAccess: false, signing: false, transactions: 0, retries: 0 } };
  const budget = () => { if (out.requests >= CAP.requests || clock() - started >= CAP.wallMs) fail("REQUEST_OR_TIME_CAP"); };
  const rpc = async (candidate, method, params) => {
    if (!["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"].includes(method)) fail("METHOD_FORBIDDEN");
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
    const body = response.value;
    if (!body || body.jsonrpc !== "2.0" || body.id !== id) fail("RPC_ENVELOPE_INVALID");
    if (Object.hasOwn(body, "error")) fail("RPC_UNAVAILABLE");
    if (!Object.hasOwn(body, "result")) fail("RPC_RESULT_MISSING");
    return body.result;
  };
  const fresh = pin => {
    const age = BigInt(Math.floor(clock() / 1000)) - BigInt(pin.timestamp);
    if (age < -60n || age > BigInt(CAP.maxAgeSeconds)) fail("FINALITY_STALE");
  };
  const getHeader = async (candidate, tag) => {
    const raw = await rpc(candidate, "eth_getBlockByNumber", [tag, false]);
    let pin;
    try { pin = base.header(raw); } catch (_) { fail("HEADER_INVALID"); }
    fresh(pin); return pin;
  };
  const block = pin => ({ blockHash: pin.hash, requireCanonical: true });
  const getCode = async (candidate, target, pin) => {
    if (!Object.values(A).includes(target)) fail("TARGET_FORBIDDEN");
    const code = await rpc(candidate, "eth_getCode", [target, block(pin)]);
    if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(code) || code.length > 65538) fail("CODE_INVALID_OR_ABSENT");
    return keccak256(code);
  };
  const call = async (candidate, target, type, name, args, pin) => {
    out.operation = `${type}.${name}`;
    if (!Object.values(A).includes(target) || !Object.hasOwn(I, type)) fail("CALL_FORBIDDEN");
    const iface = I[type], fragment = iface.getFunction(name);
    const quote = type === "quoter" && name === "quoteExactInputSingle";
    if (fragment.stateMutability !== "view" && !(quote && target === A.quoter && SIZES.includes(args[0][2]) && eq(args, quoteArgs(args[0][2])))) fail("CALL_FORBIDDEN");
    const raw = await rpc(candidate, "eth_call", [{ to: target, data: iface.encodeFunctionData(name, args), gas: "0x1e8480" }, block(pin)]);
    try {
      const values = iface.decodeFunctionResult(name, raw);
      if (iface.encodeFunctionResult(name, values).toLowerCase() !== raw.toLowerCase()) fail("ABI_NONCANONICAL");
      return values;
    } catch (_) { fail("ABI_INVALID"); }
  };
  const scalar = async (...args) => (await call(...args))[0];
  const bindings = async (candidate, pin) => {
    for (const [target, type, getter, expected] of [
      [A.quoter, "quoter", "factory", A.factory], [A.quoter, "quoter", "deployer", A.deployer], [A.quoter, "quoter", "WETH9", A.weth],
      [A.pool, "pool", "token0", A.usds], [A.pool, "pool", "token1", A.usdc], [A.pool, "pool", "factory", A.factory],
      [A.psm, "psm", "usdc", A.usdc], [A.psm, "psm", "usds", A.usds],
    ]) if (addr(await scalar(candidate, target, type, getter, [], pin)) !== expected) fail("CONFIGURATION_MISMATCH");
    if (await scalar(candidate, A.pool, "pool", "fee", [], pin) !== FEE) fail("POOL_FEE_MISMATCH");
    const spacing = await scalar(candidate, A.pool, "pool", "tickSpacing", [], pin);
    if (spacing <= 0n || await scalar(candidate, A.factory, "factory", "feeAmountTickSpacing", [FEE], pin) !== spacing) fail("TICK_SPACING_MISMATCH");
    if (addr(await scalar(candidate, A.factory, "factory", "getPool", [A.usds, A.usdc, FEE], pin)) !== A.pool) fail("FACTORY_POOL_MISMATCH");
    for (const [token, decimals] of [[A.usdc, 6n], [A.usds, 18n]]) if (await scalar(candidate, token, "token", "decimals", [], pin) !== decimals) fail("DECIMALS_MISMATCH");
    return spacing;
  };
  const quote = async (candidate, input, pin) => validateQuote(await call(candidate, A.quoter, "quoter", "quoteExactInputSingle", quoteArgs(input), pin));
  const observe = async (candidate, pin) => {
    const view = { runtimeKeccak256: {}, tickSpacing: (await bindings(candidate, pin)).toString(), slot0: null,
      liquidityRaw: null, poolUsdcBalanceRaw: null, poolUsdsBalanceRaw: null, psm: null, rows: [] };
    for (const target of Object.values(A)) view.runtimeKeccak256[target] = await getCode(candidate, target, pin);
    const slot = await call(candidate, A.pool, "pool", "slot0", [], pin);
    if (!slot[6] || slot[0] <= MIN_SQRT || slot[0] >= MAX_SQRT || slot[1] < -887272n || slot[1] > 887272n) fail("POOL_STATE_INVALID");
    view.slot0 = { sqrtPriceX96: slot[0].toString(), tick: slot[1].toString(), feeProtocol: slot[5].toString(), unlocked: slot[6] };
    view.liquidityRaw = (await scalar(candidate, A.pool, "pool", "liquidity", [], pin)).toString();
    // In-range liquidity and balances are diagnostics, not concentrated-liquidity quote capacity.
    view.poolUsdcBalanceRaw = (await scalar(candidate, A.usdc, "token", "balanceOf", [A.pool], pin)).toString();
    view.poolUsdsBalanceRaw = (await scalar(candidate, A.usds, "token", "balanceOf", [A.pool], pin)).toString();
    const pocket = addr(await scalar(candidate, A.psm, "psm", "pocket", [], pin));
    const balance = await scalar(candidate, A.usdc, "token", "balanceOf", [pocket], pin);
    const allowance = pocket === A.psm ? null : await scalar(candidate, A.usdc, "token", "allowance", [pocket, A.psm], pin);
    const capacity = allowance === null || balance < allowance ? balance : allowance;
    view.psm = { pocket, usdcBalanceRaw: balance.toString(), usdcAllowanceRaw: allowance === null ? null : allowance.toString(),
      balanceAllowanceCapacityRaw: capacity.toString(), capacityIsTransferProof: false };
    for (const input of SIZES) {
      const q = await quote(candidate, input, pin), usds = BigInt(q.usdsRaw);
      if (BigInt(q.sqrtAfterX96) < slot[0]) fail("QUOTE_PRICE_DIRECTION_MISMATCH");
      if (usds > BigInt(view.poolUsdsBalanceRaw)) fail("QUOTE_EXCEEDS_TOKEN_BALANCE");
      const final = await scalar(candidate, A.psm, "psm", "previewSwapExactIn", [A.usds, A.usdc, usds], pin);
      if (final !== usds / 10n ** 12n) fail("PSM_PREVIEW_MODEL_MISMATCH");
      const surplus = final - input;
      view.rows.push({ inputUsdcRaw: input.toString(), ...q, outputUsdcRaw: final.toString(), quotedSurplusUsdcRaw: surplus.toString(),
        quotedSurplusUsdc: formatUnits(surplus, 6), quotedSurplusBps: { numerator: (surplus * 10000n).toString(), denominator: input.toString() },
        pocketBalanceAllowanceSufficient: final <= capacity, quoteIncludesPoolFeesAndImpact: true, quoterGasIsCycleGas: false,
        fullInputExecutionVerified: false, conservativeNetUsdc: null, executable: "unknown" });
    }
    return view;
  };
  try {
    if ((deps.candidates || deps.sourceCheck || deps.clock) && !deps.transport) fail("INJECTED_TRANSPORT_REQUIRED");
    try { if ((deps.sourceCheck || r8.verifyPrimarySource)() !== true) fail("PRIMARY_SOURCE_MISMATCH"); }
    catch (_) { fail("PRIMARY_SOURCE_MISMATCH"); }
    out.source.psmPrimarySourceMatches = true;
    if (computedPool() !== A.pool) fail("POOL_CREATE2_MISMATCH");
    out.source.poolCreate2Matches = true;
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
        await getCode(candidate, A.quoter, pin);
        await bindings(candidate, pin);
        await quote(candidate, SIZES[0], pin);
        qualified.push({ candidate, pin }); out.qualification.qualified = qualified.length;
      } catch (error) {
        const code = safe(error);
        out.qualification.failures[code] = (out.qualification.failures[code] || 0) + 1;
        if (["REQUEST_OR_TIME_CAP", "TOTAL_BYTE_CAP"].includes(code)) throw error;
      }
    }
    const selected = [];
    for (const row of qualified) if (row.candidate.family && !selected.some(other => other.candidate.family === row.candidate.family)) selected.push(row);
    if (selected.length < 2) fail("TWO_QUOTE_CAPABLE_FAMILIES_UNAVAILABLE");
    selected.length = 2; out.qualification.selectedFamilyCount = 2; out.phase = "COMMON_PIN";
    const number = selected.reduce((n, row) => BigInt(row.pin.number) < n ? BigInt(row.pin.number) : n, BigInt(selected[0].pin.number));
    const tag = `0x${number.toString(16)}`, pins = [];
    for (const row of selected) pins.push(await getHeader(row.candidate, tag));
    if (!eq(pins[0], pins[1]) || BigInt(pins[0].number) !== number) fail("PIN_DISAGREEMENT");
    const pin = pins[0], views = []; out.phase = "OBSERVATION";
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
    out.code = views[0].rows.some(row => BigInt(row.quotedSurplusUsdcRaw) > 0n && row.pocketBalanceAllowanceSufficient)
      ? "QUOTED_SURPLUS_REQUIRES_VALIDATION" : "NO_CAPACITY_BACKED_POSITIVE_QUOTE_AT_TESTED_SIZES";
  } catch (error) { out.code = safe(error); }
  out.completedAt = new Date(clock()).toISOString(); return out;
}
async function main() {
  if (process.argv.slice(2).join(" ") !== "--once") fail("EXPLICIT_ONCE_REQUIRED");
  if (fs.existsSync(OUTPUT)) fail("OUTPUT_EXISTS_NO_RETRY");
  const artifact = await run(), encoded = JSON.stringify(artifact, null, 2) + "\n";
  if (/(?:https?|wss?):\/\//i.test(encoded)) fail("OUTPUT_NOT_SANITIZED");
  const temp = `${OUTPUT}.tmp-${process.pid}`;
  try { fs.writeFileSync(temp, encoded, { flag: "wx" }); fs.linkSync(temp, OUTPUT); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  process.stdout.write(JSON.stringify({ status: artifact.status, code: artifact.code, requests: artifact.requests, rows: artifact.observation?.rows.length || 0,
    artifact: path.relative(ROOT, OUTPUT), profitabilityClaim: false }) + "\n");
  if (artifact.status === "INCOMPLETE") process.exitCode = 1;
}
module.exports = { run, A, I, CAP, SIZES, FEE, OUTPUT, computedPool, quoteArgs, validateQuote, MIN_SQRT, MAX_SQRT };
if (require.main === module) main().catch(() => { process.stderr.write("R9_FAILED_CLOSED\n"); process.exitCode = 1; });
