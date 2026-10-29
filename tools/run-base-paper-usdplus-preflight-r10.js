"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { Interface, keccak256 } = require("ethers");
const base = require("./run-base-redemption-paper-state-r1");
const { candidatePool } = require("./run-base-paper-cycle-r8");
const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "reports/raw/fast/base-paper-usdplus-preflight-r10.json");
const A = Object.freeze({ exchange: "0x7cb1b38591021309c64f451859d79312d8ca2789", usdPlus: "0xb79dd08ea68a908a97220c76d19a6aa9cbde4376",
  usdc: base.ASSET, usdbc: "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", manager: "0x27b12f3282f1d02682d7d1ad30e45e818b78f7b8",
  m2m: "0x1f4947cd5a5c058dd5ea6fd1ccd5c311ada9e6fb", implementation: "0x10a013eb5d9f23dcd4b8f51321d6ea7d462927d4" });
const SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const CAP = Object.freeze({ candidates: 8, requests: 140, wallMs: 240000, requestMs: 8000, responseBytes: 1048576, totalBytes: 16777216 });
// Read-only ABI reference: ovnstable-core-contracts at the immutable revision recorded below.
const I = Object.freeze({
  exchange: new Interface(["function usdPlus() view returns(address)", "function usdc() view returns(address)", "function portfolioManager() view returns(address)",
    "function mark2market() view returns(address)", "function redeemFee() view returns(uint256)", "function redeemFeeDenominator() view returns(uint256)", "function paused() view returns(bool)"]),
  manager: new Interface(["function cashStrategy() view returns(address)", "function exchanger() view returns(address)"]),
  m2m: new Interface(["function totalNetAssets() view returns(uint256)", "function totalLiquidationAssets() view returns(uint256)"]),
  token: new Interface(["function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)"])
});
class PreflightError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new PreflightError(code); };
const safe = error => error instanceof PreflightError ? error.code : "UNEXPECTED_FAILURE";
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function readCandidates() {
  const file = path.join(ROOT, "rpc_endpoints.txt"), before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1048576) fail("INVENTORY_UNSAFE");
  const bytes = fs.readFileSync(file);
  try {
    const after = fs.lstatSync(file);
    if (before.size !== bytes.length || ["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(k => before[k] !== after[k])) fail("INVENTORY_CHANGED");
    return candidatePool(bytes.toString("utf8"));
  } finally { bytes.fill(0); }
}
async function run(deps = {}) {
  const clock = deps.clock || Date.now, started = clock(), transport = deps.transport || base.requestJSON;
  const out = { schema: "base-paper-usdplus-preflight/v10", chainId: 8453, generatedAt: new Date(started).toISOString(),
    study: "ORDINARY_REDEMPTION_PREFLIGHT_ONLY", status: "INCOMPLETE", code: null, requests: 0, bytes: 0, addresses: A,
    source: { referenceCommit: "24c2c1082cf9404efbaa1174d1df0ba4ffd5ba12", explorerImplementationLocator: A.implementation, sourceRuntimeBound: "unknown" },
    qualification: { attempted: 0, qualified: 0, selectedFamilyCount: 0, failures: {} }, observation: null,
    gates: { quoteEligible: false, payoutCapacity: "unknown", profitabilityClaim: false, executableNow: "unknown", signedActionJustified: false },
    economics: { costsComplete: false, conservativeNetUsdc: null, fills: null, realizedPnl: null },
    safety: { readOnlyRpc: true, inventoryRead: false, endpointMaterialPersisted: false, walletAccess: false, signing: false, transactions: 0, retries: 0 } };
  const budget = () => { if (out.requests >= CAP.requests || clock() - started >= CAP.wallMs) fail("REQUEST_OR_TIME_CAP"); };
  const rpc = async (candidate, method, params) => {
    if (!["eth_chainId", "eth_getBlockByNumber", "eth_getStorageAt", "eth_getCode", "eth_call"].includes(method)) fail("METHOD_FORBIDDEN");
    budget();
    if (!deps.transport) await new Promise(resolve => setTimeout(resolve, 200));
    budget();
    const id = ++out.requests;
    let response;
    try { response = await transport(candidate.url, { jsonrpc: "2.0", id, method, params }, Math.min(CAP.requestMs, CAP.wallMs - (clock() - started))); }
    catch { fail("TRANSPORT_UNAVAILABLE"); }
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
  const block = pin => ({ blockHash: pin.hash, requireCanonical: true });
  const getHeader = async (candidate, tag) => {
    let pin;
    try { pin = base.header(await rpc(candidate, "eth_getBlockByNumber", [tag, false])); }
    catch (e) { if (e instanceof PreflightError) throw e; fail("HEADER_INVALID"); }
    const age = BigInt(Math.floor(clock() / 1000)) - BigInt(pin.timestamp);
    if (age < -60n || age > 3600n) fail("FINALITY_STALE");
    return pin;
  };
  const call = async (candidate, target, type, name, args, pin) => {
    if (!Object.values(A).includes(target)) fail("TARGET_FORBIDDEN");
    const iface = I[type];
    if (iface.getFunction(name).stateMutability !== "view") fail("CALL_FORBIDDEN");
    const raw = await rpc(candidate, "eth_call", [{ to: target, data: iface.encodeFunctionData(name, args), gas: "0x1e8480" }, block(pin)]);
    try {
      const values = iface.decodeFunctionResult(name, raw);
      if (iface.encodeFunctionResult(name, values).toLowerCase() !== raw.toLowerCase()) fail("ABI_INVALID");
      const value = values[0];
      return typeof value === "bigint" ? value.toString() : typeof value === "string" ? value.toLowerCase() : value;
    } catch { fail("ABI_INVALID"); }
  };
  const implementation = async (candidate, pin) => {
    const raw = await rpc(candidate, "eth_getStorageAt", [A.exchange, SLOT, block(pin)]);
    try { return base.address(raw); } catch { fail("IMPLEMENTATION_WORD_INVALID"); }
  };
  try {
    if ((deps.candidates || deps.clock) && !deps.transport) fail("INJECTED_TRANSPORT_REQUIRED");
    if (!deps.candidates) out.safety.inventoryRead = true;
    const candidates = deps.candidates || readCandidates();
    if (!Array.isArray(candidates) || candidates.length > CAP.candidates) fail("CANDIDATE_CAP");
    const qualified = [];
    for (const candidate of candidates) {
      out.qualification.attempted++;
      try {
        if (await rpc(candidate, "eth_chainId", []) !== "0x2105") fail("CHAIN_MISMATCH");
        const pin = await getHeader(candidate, "finalized");
        await implementation(candidate, pin);
        await call(candidate, A.exchange, "exchange", "usdc", [], pin);
        qualified.push({ candidate, pin }); out.qualification.qualified = qualified.length;
      } catch (e) {
        const code = safe(e); out.qualification.failures[code] = (out.qualification.failures[code] || 0) + 1;
        if (["REQUEST_OR_TIME_CAP", "TOTAL_BYTE_CAP"].includes(code)) throw e;
      }
    }
    const selected = [];
    for (const row of qualified) if (row.candidate.family && !selected.some(other => other.candidate.family === row.candidate.family)) selected.push(row);
    if (selected.length < 2) fail("TWO_STATE_CAPABLE_FAMILIES_UNAVAILABLE");
    selected.length = 2; out.qualification.selectedFamilyCount = 2;
    const number = selected.reduce((n, row) => BigInt(row.pin.number) < n ? BigInt(row.pin.number) : n, BigInt(selected[0].pin.number));
    const tag = `0x${number.toString(16)}`, pins = [], views = [];
    for (const { candidate } of selected) pins.push(await getHeader(candidate, tag));
    if (!eq(pins[0], pins[1]) || BigInt(pins[0].number) !== number) fail("PIN_DISAGREEMENT");
    const pin = pins[0];
    for (const { candidate } of selected) {
      const view = { implementation: await implementation(candidate, pin), exchange: {}, runtimeKeccak256: {}, manager: null, valuations: null, balancesRaw: null };
      for (const name of ["usdPlus", "usdc", "portfolioManager", "mark2market", "redeemFee", "redeemFeeDenominator", "paused"])
        view.exchange[name] = await call(candidate, A.exchange, "exchange", name, [], pin);
      if (BigInt(view.exchange.redeemFeeDenominator) === 0n || BigInt(view.exchange.redeemFee) > BigInt(view.exchange.redeemFeeDenominator)) fail("FEE_INVALID");
      for (const target of [A.exchange, ...(view.implementation === A.implementation ? [A.implementation] : [])]) {
        const code = await rpc(candidate, "eth_getCode", [target, block(pin)]);
        if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(code) || code.length > 65538) fail("CODE_INVALID_OR_ABSENT");
        view.runtimeKeccak256[target] = keccak256(code);
      }
      // Unknown pointers are recorded, never followed into an unbounded target graph.
      if (view.exchange.usdPlus === A.usdPlus && view.exchange.portfolioManager === A.manager && view.exchange.mark2market === A.m2m && [A.usdc, A.usdbc].includes(view.exchange.usdc)) {
        view.manager = {};
        for (const name of ["cashStrategy", "exchanger"]) view.manager[name] = await call(candidate, A.manager, "manager", name, [], pin);
        view.valuations = {};
        for (const name of ["totalNetAssets", "totalLiquidationAssets"]) view.valuations[name] = await call(candidate, A.m2m, "m2m", name, [], pin);
        view.assetDecimals = await call(candidate, view.exchange.usdc, "token", "decimals", [], pin);
        view.balancesRaw = {};
        for (const [label, owner] of [["exchange", A.exchange], ["manager", A.manager], ["cashStrategy", view.manager.cashStrategy]])
          view.balancesRaw[label] = await call(candidate, view.exchange.usdc, "token", "balanceOf", [owner], pin);
      }
      views.push(view);
    }
    if (!eq(views[0], views[1])) fail("OBSERVATION_DISAGREEMENT");
    for (const { candidate } of selected) {
      if (!eq(await getHeader(candidate, tag), pin)) fail("TERMINAL_PIN_CHANGED");
      if (BigInt((await getHeader(candidate, "finalized")).number) < number) fail("FINALITY_REGRESSED");
    }
    out.observation = { pin, rpcStrength: "corroborated-operator-families", upstreamIndependenceProven: false,
      ...views[0], valuationsArePayoutCapacity: false, balancesAreTransferProof: false };
    out.status = "OBSERVED_UNPROMOTED";
    const view = views[0];
    out.code = view.exchange.paused ? "EXCHANGE_PAUSED_OBSERVED" : view.exchange.usdc !== A.usdc ? "UNDERLYING_NOT_NATIVE_USDC"
      : "SOURCE_RUNTIME_AND_PAYOUT_CAPACITY_UNPROVEN";
  } catch (e) { out.code = safe(e); }
  out.completedAt = new Date(clock()).toISOString();
  return out;
}
async function main() {
  if (process.argv.slice(2).join(" ") !== "--once") fail("EXPLICIT_ONCE_REQUIRED");
  if (fs.existsSync(OUTPUT)) fail("OUTPUT_EXISTS_NO_RETRY");
  const artifact = await run(), encoded = JSON.stringify(artifact, null, 2) + "\n";
  if (/(?:https?|wss?):\/\//i.test(encoded)) fail("OUTPUT_NOT_SANITIZED");
  fs.writeFileSync(OUTPUT, encoded, { flag: "wx" });
  process.stdout.write(JSON.stringify({ status: artifact.status, code: artifact.code, requests: artifact.requests, artifact: path.relative(ROOT, OUTPUT), quoteEligible: false }) + "\n");
  if (artifact.status === "INCOMPLETE") process.exitCode = 1;
}
module.exports = { run, A, I, SLOT, CAP, OUTPUT };
if (require.main === module) main().catch(() => { process.stderr.write("R10_FAILED_CLOSED\n"); process.exitCode = 1; });
