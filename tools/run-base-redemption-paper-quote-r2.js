"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const base = require("./run-base-redemption-paper-state-r1");
const { VAULT, ASSET, SELECTORS, PaperError, header, uint, address } = base;
const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "reports/raw/fast/base-redemption-paper-quote-r2.json");
const QUOTER = "0x0d5e0f971ed27fbff6c2837bf31316121532048d";
const POOL = "0x19c86ba18d2dced8eae3547d3d670c01846c77ce308d284be71dbcc978c5d208";
const INPUT = 100000000n;
const CAP = { candidates: 3, requests: 56, bytes: 16 * 1024 * 1024, wallMs: 180000, paceMs: 1100 };
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
// Encoding independently checked with cast calldata; hook data is empty, hooks=0.
const QUOTE_DATA = "0xaa9d21cb" + [32, ASSET, VAULT, 899000, 17980, 0, 1, INPUT, 256, 0].map(word).join("");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code) => { throw new PaperError(code); };
const codeHash = (value) => {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(value) || value.length > 65538) fail("CODE_INVALID");
  return crypto.createHash("sha256").update(Buffer.from(value.slice(2), "hex")).digest("hex");
};
function decodeQuote(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{128}$/i.test(value)) fail("QUOTE_SHAPE_INVALID");
  return { shares: BigInt(`0x${value.slice(2, 66)}`), gas: BigInt(`0x${value.slice(66)}`) };
}

async function run(deps = {}) {
  const now = deps.clock || Date.now;
  const started = now();
  const result = { schema: "base-redemption-paper-quote/v2", generatedAt: new Date(started).toISOString(), chainId: 8453, vault: VAULT, poolId: POOL, inputAsset: ASSET, inputRaw: INPUT.toString(),
    status: "INCOMPLETE", code: null, phase: "QUALIFICATION", requests: 0, bytes: 0,
    qualification: { attempted: 0, qualified: 0, selectedHostnameGroups: 0, failureCounts: {} }, observation: null,
    economics: { grossPreviewDeltaRaw: null, conservativeNetUsd: null, conservativeNetNative: null, exactNetBps: null, complete: false },
    safety: { readOnly: true, transactions: 0, signing: false, walletAccess: false, credentialedAccess: false, retries: 0, inventoryRead: false },
    profitabilityClaim: false, paperEligible: false, sourceRuntimeBound: false, redeemCapacityVerified: false, fills: null };
  let lastOperation = "NONE";
  const transport = deps.transport || base.requestJSON;
  const sleep = deps.transport ? async () => {} : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rpc = async (candidate, method, params, label = method) => {
    if (!["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"].includes(method)) fail("METHOD_FORBIDDEN");
    lastOperation = label;
    await sleep(CAP.paceMs);
    if (result.requests >= CAP.requests || now() - started >= CAP.wallMs) fail("REQUEST_OR_TIME_CAP");
    const id = ++result.requests;
    const response = await transport(candidate.url, { jsonrpc: "2.0", id, method, params }, Math.min(8000, CAP.wallMs - (now() - started)));
    if (!response || !Number.isSafeInteger(response.bytes) || response.bytes < 0 || response.bytes > 1024 * 1024) fail("RESPONSE_CAP");
    result.bytes += response.bytes;
    if (result.bytes > CAP.bytes || now() - started > CAP.wallMs) fail("TOTAL_CAP");
    const row = response.value;
    if (!row || row.jsonrpc !== "2.0" || row.id !== id) fail("RPC_ENVELOPE_INVALID");
    if (Object.hasOwn(row, "error")) fail("RPC_ERROR");
    if (!Object.hasOwn(row, "result")) fail("RPC_RESULT_MISSING");
    return row.result;
  };
  const fresh = (pin) => {
    const age = BigInt(Math.floor(now() / 1000)) - BigInt(pin.timestamp);
    if (age < -60n || age > 3600n) fail("PIN_STALE");
  };
  const observe = async (candidate, pin) => {
    const selector = { blockHash: pin.hash, requireCanonical: true };
    const view = async (to, data, label) => rpc(candidate, "eth_call", [{ to, data, gas: "0x1e8480" }, selector], label);
    const quoterCodeHash = codeHash(await rpc(candidate, "eth_getCode", [QUOTER, selector], "QUOTER_CODE"));
    const vaultCodeHash = codeHash(await rpc(candidate, "eth_getCode", [VAULT, selector], "VAULT_CODE"));
    if (address(await view(VAULT, SELECTORS.asset, "VAULT_ASSET")) !== ASSET) fail("ASSET_MISMATCH");
    if (uint(await view(ASSET, SELECTORS.decimals, "ASSET_DECIMALS")) !== 6n
      || uint(await view(VAULT, SELECTORS.decimals, "SHARE_DECIMALS")) !== 18n) fail("DECIMALS_MISMATCH");
    const quote = decodeQuote(await view(QUOTER, QUOTE_DATA, "EXACT_INPUT_QUOTE"));
    if (quote.shares === 0n) fail("ZERO_QUOTED_OUTPUT");
    const assets = uint(await view(VAULT, SELECTORS.previewRedeem + word(quote.shares), "REDEMPTION_PREVIEW"));
    return { quoterCodeHash, vaultCodeHash, quotedSharesRaw: quote.shares.toString(), redemptionPreviewAssetsRaw: assets.toString(), quoteGasEstimateRaw: quote.gas.toString() };
  };
  try {
    if (deps.candidates && !deps.transport) fail("INJECTED_TRANSPORT_REQUIRED");
    if (!deps.candidates) result.safety.inventoryRead = true;
    const pool = deps.candidates || base.readCandidates().slice(0, CAP.candidates);
    if (!Array.isArray(pool) || pool.length > CAP.candidates) fail("CANDIDATE_CAP");
    const qualified = [];
    for (const candidate of pool) {
      result.qualification.attempted += 1;
      try {
        if (await rpc(candidate, "eth_chainId", []) !== "0x2105") fail("CHAIN_MISMATCH");
        const pin = header(await rpc(candidate, "eth_getBlockByNumber", ["finalized", false]));
        fresh(pin);
        const observation = await observe(candidate, pin);
        qualified.push({ candidate, pin, observation });
      } catch (error) {
        if (!(error instanceof PaperError)) throw error;
        const key = `${lastOperation}_${error.code}`;
        result.qualification.failureCounts[key] = (result.qualification.failureCounts[key] || 0) + 1;
        if (["REQUEST_OR_TIME_CAP", "TOTAL_CAP"].includes(error.code)) throw error;
      }
    }
    result.qualification.qualified = qualified.length;
    const selected = [];
    for (const row of qualified) if (!selected.some((other) => other.candidate.family === row.candidate.family)) selected.push(row);
    if (selected.length < 2) fail("TWO_QUOTE_CAPABLE_GROUPS_UNAVAILABLE");
    selected.length = 2;
    result.qualification.selectedHostnameGroups = 2;
    result.phase = "AGREEMENT";
    const number = selected.reduce((min, row) => BigInt(row.pin.number) < min ? BigInt(row.pin.number) : min, BigInt(selected[0].pin.number));
    const tag = `0x${number.toString(16)}`;
    const pins = [];
    for (const row of selected) pins.push(header(await rpc(row.candidate, "eth_getBlockByNumber", [tag, false])));
    if (!equal(pins[0], pins[1]) || BigInt(pins[0].number) !== number) fail("PIN_DISAGREEMENT");
    fresh(pins[0]);
    const views = [];
    for (const row of selected) views.push(equal(row.pin, pins[0]) ? row.observation : await observe(row.candidate, pins[0]));
    const material = ({ quoteGasEstimateRaw, ...values }) => values;
    if (!equal(material(views[0]), material(views[1]))) fail("QUOTE_OR_PREVIEW_DISAGREEMENT");
    result.phase = "TERMINAL";
    for (const row of selected) {
      if (!equal(header(await rpc(row.candidate, "eth_getBlockByNumber", [tag, false])), pins[0])) fail("TERMINAL_PIN_CHANGED");
      const final = header(await rpc(row.candidate, "eth_getBlockByNumber", ["finalized", false]));
      fresh(final);
      if (BigInt(final.number) < number) fail("FINALITY_REGRESSED");
    }
    const delta = BigInt(views[0].redemptionPreviewAssetsRaw) - INPUT;
    result.observation = { pin: pins[0], rpcStrength: "CORROBORATED_HOSTNAME_GROUPS_NOT_UPSTREAM_PROOF", ...material(views[0]), quoteGasEstimatesRaw: views.map((v) => v.quoteGasEstimateRaw), executableRedemption: false };
    result.economics.grossPreviewDeltaRaw = delta.toString();
    result.status = delta <= 0n ? "NONPOSITIVE_QUOTE_PREVIEW_SCREEN" : "POSITIVE_PREVIEW_REQUIRES_CAPACITY_AND_COSTS";
    result.code = "NOT_A_PROFIT_OR_EXECUTION_CLAIM";
    result.phase = "COMPLETE";
  } catch (error) { result.code = error instanceof PaperError ? error.code : "UNEXPECTED_FAILURE"; result.lastOperation = lastOperation; }
  result.completedAt = new Date(now()).toISOString();
  return result;
}

async function main() {
  if (process.argv.slice(2).join(" ") !== "--once") fail("EXPLICIT_ONCE_REQUIRED");
  if (fs.existsSync(OUTPUT)) fail("OUTPUT_EXISTS_NO_RETRY");
  const result = await run();
  const encoded = JSON.stringify(result, null, 2) + "\n";
  if (/(?:https?|wss?):\/\//i.test(encoded)) fail("OUTPUT_NOT_SANITIZED");
  const temporary = `${OUTPUT}.tmp-${process.pid}`;
  try { fs.writeFileSync(temporary, encoded, { flag: "wx" }); fs.linkSync(temporary, OUTPUT); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  process.stdout.write(JSON.stringify({ status: result.status, code: result.code, phase: result.phase, requests: result.requests, artifact: path.relative(ROOT, OUTPUT) }) + "\n");
  if (result.status === "INCOMPLETE") process.exitCode = 1;
}
module.exports = { run, decodeQuote, QUOTE_DATA, QUOTER, POOL, INPUT, OUTPUT, CAP };
if (require.main === module) main().catch((error) => { process.stderr.write((error instanceof PaperError ? error.code : "UNEXPECTED_FAILURE") + "\n"); process.exitCode = 1; });
