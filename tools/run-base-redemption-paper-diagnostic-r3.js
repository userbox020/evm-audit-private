"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const base = require("./run-base-redemption-paper-state-r1");
const previous = require("./run-base-redemption-paper-quote-r2");
const { VAULT, ASSET, SELECTORS, PaperError, uint, address, header } = base;
const { QUOTER, POOL, QUOTE_DATA } = previous;
const MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const STATE_VIEW = "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71";
const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "reports/raw/fast/base-redemption-paper-diagnostic-r3.json");
const CAP = Object.freeze({ candidates: 3, requests: 64, wallMs: 180000, paceMs: 1100, bytes: 16 * 1024 * 1024 });
const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, "0");
const fail = (code) => { throw new PaperError(code); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const value = (row) => row.kind === "OK" ? row.value : fail("REQUIRED_READ_FAILED");
const safeCode = (error) => error instanceof PaperError ? error.code : "UNEXPECTED_FAILURE";

// Only fixed classifications leave the process, never error messages or raw revert bytes.
function classifyError(error) {
  const rpcCategory = Number.isInteger(error?.code)
    ? ({ "-32602": "INVALID_PARAMS", "-32601": "METHOD_UNAVAILABLE", "3": "EXECUTION_ERROR", "-32000": "SERVER_ERROR", "-32005": "LIMIT_ERROR" })[error.code] || "OTHER_RPC_ERROR"
    : "OTHER_RPC_ERROR";
  const message = typeof error?.message === "string" ? error.message.slice(0, 2048) : "";
  const hint = /out of gas|gas required exceeds allowance/i.test(message) ? "GAS_LIMIT_REPORTED"
    : /insufficient funds/i.test(message) ? "CALLER_BALANCE_CHECK_REPORTED"
    : /invalid opcode/i.test(message) ? "VM_OPCODE_ERROR_REPORTED"
    : /missing trie node|historical state|state .* unavailable|pruned/i.test(message) ? "HISTORICAL_STATE_ERROR_REPORTED"
    : /header not found|unknown block|block .* not found/i.test(message) ? "BLOCK_UNAVAILABLE_REPORTED"
    : /cannot unmarshal object|unsupported.*(?:block|eip.?1898)/i.test(message) ? "BLOCK_SELECTOR_REJECTED_REPORTED"
    : /execution reverted/i.test(message) ? "REVERT_REPORTED" : "NONE";
  let data = typeof error?.data === "string" ? error.data : error?.data?.data;
  let revert = "UNKNOWN_OR_MISSING";
  if (typeof data === "string" && data.length <= 2050 && /^0x(?:[0-9a-f]{2})*$/i.test(data)) {
    data = data.toLowerCase();
    for (let depth = 0; depth < 2 && data.startsWith("0x6190b2b0"); depth++) {
      if (data.length < 138 || BigInt(`0x${data.slice(10, 74)}`) !== 32n) break;
      const length = BigInt(`0x${data.slice(74, 138)}`);
      if (length > 512n || data.length !== 138 + Math.ceil(Number(length) / 32) * 64) break;
      const end = 138 + Number(length) * 2;
      if (!/^0*$/.test(data.slice(end))) break;
      data = `0x${data.slice(138, end)}`;
    }
    if (data === `0x7a5ed734${POOL.slice(2)}`) revert = "NOT_ENOUGH_LIQUIDITY_FOR_POOL";
    else if (data === "0x486aa307") revert = "POOL_NOT_INITIALIZED";
    else if (/^0xecbd9804[0-9a-f]{64}$/.test(data)) revert = "UNEXPECTED_TOP_LEVEL_QUOTE_REVERT";
  }
  return { kind: "RPC_ERROR", rpcCategory, hint, revert };
}

function decodeSlot0(data) {
  if (typeof data !== "string" || !/^0x[0-9a-f]{256}$/i.test(data)) fail("SLOT0_SHAPE_INVALID");
  const words = data.slice(2).match(/.{64}/g).map((w) => BigInt(`0x${w}`));
  const [sqrt, , protocolFee, lpFee] = words;
  const tick = BigInt.asIntN(24, words[1]);
  if (sqrt >= 1n << 160n || words[1] !== BigInt.asUintN(256, tick) || tick < -887272n || tick > 887272n
    || protocolFee >= 1n << 24n || lpFee > 1000000n) fail("SLOT0_RANGE_INVALID");
  if (sqrt !== 0n && lpFee !== 899000n) fail("POOL_FEE_MISMATCH");
  return { sqrtPriceX96: sqrt.toString(), tick: tick.toString(), protocolFee: protocolFee.toString(), lpFee: lpFee.toString() };
}

function priceScreen(slot0, previewRaw) {
  const sqrt = BigInt(slot0.sqrtPriceX96);
  const fee = BigInt(slot0.lpFee);
  if (sqrt === 0n || fee >= 1000000n) return null;
  const numerator = (1n << 192n) * 10n ** 18n;
  const denominator = sqrt * sqrt;
  const costNumerator = numerator * 1000000n;
  const costDenominator = denominator * (1000000n - fee);
  return {
    unit: "USDC_RAW_PER_WHOLE_SHARE",
    spot: { numerator: numerator.toString(), denominator: denominator.toString() },
    lpFeeOnlyCost: { numerator: costNumerator.toString(), denominator: costDenominator.toString() },
    previewBelowLpFeeOnlyCost: BigInt(previewRaw) * costDenominator < costNumerator,
    allSizesDisproved: false, protocolFeeAndImpactIncluded: false,
  };
}

async function run(deps = {}) {
  const now = deps.clock || Date.now;
  const started = now();
  const result = { schema: "base-redemption-paper-diagnostic/v3", generatedAt: new Date(started).toISOString(), chainId: 8453,
    vault: VAULT, poolId: POOL, status: "INCOMPLETE", code: null, phase: "QUALIFICATION", requests: 0, bytes: 0,
    qualification: { attempted: 0, qualified: 0, selectedHostnameGroups: 0 }, failures: [], observation: null,
    safety: { readOnly: true, inventoryRead: false, credentialedAccess: false, walletAccess: false, signing: false, transactions: 0, retries: 0 },
    sourceRuntimeBound: false, redeemCapacityVerified: false, profitabilityClaim: false, conservativeNetUsd: null, conservativeNetNative: null, netBps: null, fills: null };
  let operation = "NONE";
  const transport = deps.transport || base.requestJSON;
  const rpc = async (candidate, method, params, label) => {
    operation = label;
    if (!["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"].includes(method)) fail("METHOD_FORBIDDEN");
    if (!deps.transport) await new Promise((resolve) => setTimeout(resolve, CAP.paceMs));
    if (result.requests >= CAP.requests || now() - started >= CAP.wallMs) fail("REQUEST_OR_TIME_CAP");
    const id = ++result.requests;
    let response;
    try { response = await transport(candidate.url, { jsonrpc: "2.0", id, method, params }, Math.min(8000, CAP.wallMs - (now() - started))); }
    catch (error) {
      const code = ["HTTP_REJECTED", "CONTENT_TYPE_INVALID", "RESPONSE_CAP", "TRANSPORT_ERROR", "REQUEST_TIMEOUT", "JSON_INVALID"].includes(error?.code) ? error.code : "UNEXPECTED_TRANSPORT_FAILURE";
      const failure = { kind: "TRANSPORT_ERROR", code };
      result.failures.push({ phase: result.phase, operation, ...failure });
      return failure;
    }
    if (!response || !Number.isSafeInteger(response.bytes) || response.bytes < 0 || response.bytes > 1024 * 1024) fail("RESPONSE_CAP");
    result.bytes += response.bytes;
    if (result.bytes > CAP.bytes || now() - started > CAP.wallMs) fail("TOTAL_CAP");
    const row = response.value;
    if (!row || row.jsonrpc !== "2.0" || row.id !== id || Object.hasOwn(row, "error") === Object.hasOwn(row, "result")) fail("RPC_ENVELOPE_INVALID");
    if (Object.hasOwn(row, "result")) return { kind: "OK", value: row.result };
    const failure = classifyError(row.error);
    result.failures.push({ phase: result.phase, operation, ...failure });
    return failure;
  };
  const block = async (candidate, tag) => header(value(await rpc(candidate, "eth_getBlockByNumber", [tag, false], "BLOCK")));
  const fresh = (pin) => {
    const age = BigInt(Math.floor(now() / 1000)) - BigInt(pin.timestamp);
    if (age < -60n || age > 3600n) fail("PIN_STALE");
  };
  const call = (candidate, pin, to, data, label) => rpc(candidate, "eth_call", [{ to, data, gas: "0x1e8480" }, { blockHash: pin.hash, requireCanonical: true }], label);
  const poolState = async (candidate, pin) => {
    if (address(value(await call(candidate, pin, STATE_VIEW, "0xdc4c90d3", "STATE_VIEW_MANAGER"))) !== MANAGER) fail("MANAGER_MISMATCH");
    const slot0 = decodeSlot0(value(await call(candidate, pin, STATE_VIEW, `0xc815641c${POOL.slice(2)}`, "SLOT0")));
    const liquidity = uint(value(await call(candidate, pin, STATE_VIEW, `0xfa6793d5${POOL.slice(2)}`, "ACTIVE_LIQUIDITY")));
    if (liquidity >= 1n << 128n) fail("LIQUIDITY_RANGE_INVALID");
    return { slot0, activeLiquidity: liquidity.toString() };
  };
  const quote = async (candidate, pin, amount) => {
    const data = QUOTE_DATA.slice(0, 458) + word(amount) + QUOTE_DATA.slice(522);
    const row = await call(candidate, pin, QUOTER, data, "EXACT_INPUT_QUOTE");
    if (row.kind !== "OK") return { inputRaw: amount.toString(), ...row };
    const decoded = previous.decodeQuote(row.value);
    const preview = await call(candidate, pin, VAULT, SELECTORS.previewRedeem + word(decoded.shares), "QUOTED_SHARES_PREVIEW");
    return { kind: "OK", inputRaw: amount.toString(), quotedSharesRaw: decoded.shares.toString(),
      redemptionPreview: preview.kind === "OK" ? { kind: "OK", assetsRaw: uint(preview.value).toString() } : preview };
  };
  try {
    if (deps.candidates && !deps.transport) fail("INJECTED_TRANSPORT_REQUIRED");
    result.safety.inventoryRead = !deps.candidates;
    const candidates = deps.candidates || base.readCandidates().slice(0, CAP.candidates);
    if (!Array.isArray(candidates) || candidates.length > CAP.candidates) fail("CANDIDATE_CAP");
    const qualified = [];
    for (const candidate of candidates) {
      result.qualification.attempted++;
      try {
        if (typeof candidate.family !== "string" || !candidate.family) fail("FAMILY_MISSING");
        if (value(await rpc(candidate, "eth_chainId", [], "CHAIN")) !== "0x2105") fail("CHAIN_MISMATCH");
        const pin = await block(candidate, "finalized");
        fresh(pin);
        qualified.push({ candidate, pin, pool: await poolState(candidate, pin) });
      } catch (error) {
        result.failures.push({ phase: result.phase, operation, code: safeCode(error) });
        if (["REQUEST_OR_TIME_CAP", "TOTAL_CAP"].includes(error?.code)) throw error;
      }
    }
    result.qualification.qualified = qualified.length;
    const selected = [];
    for (const row of qualified) if (!selected.some((s) => s.candidate.family === row.candidate.family)) selected.push(row);
    if (selected.length < 2) fail("TWO_STATE_CAPABLE_GROUPS_UNAVAILABLE");
    selected.length = 2;
    result.qualification.selectedHostnameGroups = 2;
    result.phase = "COMMON_PIN";
    const number = selected.reduce((min, row) => BigInt(row.pin.number) < min ? BigInt(row.pin.number) : min, BigInt(selected[0].pin.number));
    const tag = `0x${number.toString(16)}`;
    const pins = [];
    for (const row of selected) pins.push(await block(row.candidate, tag));
    if (!equal(pins[0], pins[1]) || BigInt(pins[0].number) !== number) fail("PIN_DISAGREEMENT");
    const pin = pins[0];
    fresh(pin);
    result.phase = "OBSERVATION";
    const observations = [];
    for (const row of selected) {
      const { candidate } = row;
      const pool = equal(row.pin, pin) ? row.pool : await poolState(candidate, pin);
      const hashes = {};
      for (const [name, to] of [["quoter", QUOTER], ["stateView", STATE_VIEW], ["vault", VAULT]]) {
        const code = value(await rpc(candidate, "eth_getCode", [to, { blockHash: pin.hash, requireCanonical: true }], "RUNTIME"));
        if (typeof code !== "string" || code.length > 65538 || !/^0x(?:[0-9a-f]{2})+$/i.test(code)) fail("RUNTIME_INVALID");
        hashes[name] = crypto.createHash("sha256").update(Buffer.from(code.slice(2), "hex")).digest("hex");
      }
      if (address(value(await call(candidate, pin, QUOTER, "0xdc4c90d3", "QUOTER_MANAGER"))) !== MANAGER) fail("MANAGER_MISMATCH");
      if (address(value(await call(candidate, pin, VAULT, SELECTORS.asset, "ASSET"))) !== ASSET) fail("ASSET_MISMATCH");
      if (uint(value(await call(candidate, pin, ASSET, SELECTORS.decimals, "ASSET_DECIMALS"))) !== 6n
        || uint(value(await call(candidate, pin, VAULT, SELECTORS.decimals, "SHARE_DECIMALS"))) !== 18n) fail("DECIMALS_MISMATCH");
      const oneSharePreviewRaw = uint(value(await call(candidate, pin, VAULT, SELECTORS.previewRedeem + word(10n ** 18n), "ONE_SHARE_PREVIEW"))).toString();
      const controls = {};
      for (const name of ["receiveSharesGate", "sendSharesGate", "receiveAssetsGate", "liquidityAdapter"]) {
        const control = await call(candidate, pin, VAULT, SELECTORS[name], "CONTROL_VIEW");
        controls[name] = control.kind === "OK" ? { kind: "OK", address: address(control.value) } : control;
      }
      observations.push({ ...pool, runtimeSha256: hashes, oneSharePreviewRaw, controls, quote100: await quote(candidate, pin, 100000000n) });
    }
    if (!equal(observations[0], observations[1])) fail("OBSERVATION_DISAGREEMENT");
    const observation = observations[0];
    observation.priceScreen = priceScreen(observation.slot0, observation.oneSharePreviewRaw);
    observation.quote1 = null;
    // One smaller diagnostic only if the agreed full-input liquidity error has a promising price screen.
    if (observation.quote100.revert === "NOT_ENOUGH_LIQUIDITY_FOR_POOL" && observation.priceScreen?.previewBelowLpFeeOnlyCost === false) {
      const small = [];
      for (const row of selected) small.push(await quote(row.candidate, pin, 1000000n));
      if (!equal(small[0], small[1])) fail("SMALL_QUOTE_DISAGREEMENT");
      observation.quote1 = small[0];
    }
    result.phase = "TERMINAL";
    for (const row of selected) {
      if (!equal(await block(row.candidate, tag), pin)) fail("TERMINAL_PIN_CHANGED");
      const final = await block(row.candidate, "finalized");
      fresh(final);
      if (BigInt(final.number) < number || BigInt(final.number) === number && !equal(final, pin)) fail("FINALITY_REGRESSED_OR_CHANGED");
    }
    fresh(pin);
    result.observation = { pin, evidenceStrength: "CORROBORATED_HOSTNAME_GROUPS_NOT_UPSTREAM_PROOF", ...observation };
    result.status = "DIAGNOSTIC_CAPTURE_COMPLETE";
    result.code = "NO_EXECUTION_OR_PROFIT_CLAIM";
    result.phase = "COMPLETE";
  } catch (error) { result.code = safeCode(error); result.lastOperation = operation; }
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
  process.stdout.write(JSON.stringify({ status: result.status, code: result.code, requests: result.requests, artifact: path.relative(ROOT, OUTPUT) }) + "\n");
  if (result.status === "INCOMPLETE") process.exitCode = 1;
}

module.exports = { run, classifyError, decodeSlot0, priceScreen, MANAGER, STATE_VIEW, OUTPUT, CAP };
if (require.main === module) main().catch((error) => { process.stderr.write(safeCode(error) + "\n"); process.exitCode = 1; });
