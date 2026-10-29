#!/usr/bin/env node
"use strict";
// execute-aave-v3-trigger.js
// Trigger-gated signing runner for the deployed Aave V3 flash liquidator
// 0x1c4bc8d8b5806c1d73b47bc7ae4c2b6552c858a1 (owner 0x24e4...ce0a).
//
// Fail-closed end to end. Every precondition listed in
// coordination/live-execution-batch-aave-trigger.json:triggerGated.requiredBeforeSignedTx
// is verified in order and logged as a gate BEFORE any key read or network call.
// If any gate is not satisfied the runner prints an honest gate table and exits
// {"ok":false,"reason":"execution-needs-live-trigger-state"} without reading a key
// file and without sending. Private key material is read from gated env files only
// in --execute mode, only after every gate passes; it stays in-process and is never
// printed, hashed, persisted, or passed on a command line. Endpoint material
// (URL/host/path) is never printed or persisted.
//
// Mirrors tools/deploy-flash-liquidate-aave-v3.js for batch gating, key loading,
// keyless RPC qualification, nonce/chainId/fee handling, and the receipt poll.
//
// CLI: --dry-run (default) | --execute

const fs = require("node:fs");
const path = require("node:path");
const { Wallet, Interface, getAddress } = require(path.join(__dirname, "node_modules", "ethers"));

const ROOT = path.resolve(__dirname, "..");
const BUNDLE = path.join(ROOT, "coordination", "live-execution-batch-aave-trigger.json");
const TRIGGER_QUOTES = path.join(ROOT, "reports", "raw", "fast", "aave-v3-liquidation-trigger-quotes.json");
const READINESS = path.join(ROOT, "reports", "raw", "fast", "aave-v3-trigger-readiness.json");
// The batch names the rehearsal tool tools/aave-v3-flash-liquidator-rehearsal.js;
// its OUTPUT constant lives under aave-v3-flash-liquidator-fork-rehearsal. Accept
// the spec path first and the tool's real output directory as a bounded fallback.
const REHEARSAL_RESULTS = [
  path.join(ROOT, "reports", "raw", "fast", "aave-v3-flash-liquidator-rehearsal", "result.json"),
  path.join(ROOT, "reports", "raw", "fast", "aave-v3-flash-liquidator-fork-rehearsal", "result.json"),
];
const OUTDIR = path.join(ROOT, "reports", "raw", "fast", "aave-v3-liquidation-execution");
const ENV_FILES = [path.join(ROOT, ".env"), path.join(ROOT, ".env.exploit")];
const RPC_INVENTORY = path.join(ROOT, "rpc_endpoints.txt");

const MAIN_ACCOUNT = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const EXECUTOR = "0x1c4bc8d8b5806c1d73b47bc7ae4c2b6552c858a1";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const WEETH = "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee";
const SWAP_FEE = 500; // Uniswap V3 weETH/WETH pool fee, matching the rehearsal pin

const FRESH_QUOTES_MS = 5 * 60 * 1000;
const FRESH_READINESS_MS = 5 * 60 * 1000;
const FRESH_REHEARSAL_MS = 10 * 60 * 1000;
const MIN_OUT_HAIRCUT_BPS = 98n; // minOut floor = quoted * 0.98

// Exact deployed executor surface, pinned in tools/audit-aave-v3-trigger-readiness.js:43.
const EXEC_IFACE = new Interface([
  "function execute(uint256 debtToCover,uint256 minProfitWei,uint256 minOut,bytes swapPath) external",
]);

function fail(code) { console.log(JSON.stringify({ ok: false, reason: code })); process.exit(1); }
function sanitize(v) { return typeof v === "string" ? v.replaceAll(/[0-9a-fA-F]{64}/g, "<64hex>") : v; }
function rel(file) { return path.relative(ROOT, file).replace(/\\/g, "/"); }
function toBig(value) { try { return value === null || value === undefined ? null : BigInt(value); } catch (_) { return null; } }

function tryReadJson(file) {
  try {
    if (!fs.existsSync(file)) return { exists: false, ok: false, value: null };
    return { exists: true, ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (_) {
    return { exists: true, ok: false, value: null };
  }
}

function ageMs(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Date.now() - t : null;
}

async function rpcOn(url, method, params) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15_000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: c.signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const b = await r.json();
    if (b.error) throw new Error("rpc:" + (b.error.message || "").slice(0, 40));
    if (b.result === undefined) throw new Error("rpc-shape-failure");
    return b.result;
  } finally { clearTimeout(t); }
}

function isQuantity(v) { return typeof v === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v); }
function isHash(v) { return typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v); }

function loadRpcUrls() {
  try {
    const text = fs.readFileSync(RPC_INVENTORY, "utf8");
    return [...new Set((text.match(/https?:\/\/[^\s'"<>\[\]]+/gi) || []).map(u => u.replace(/[)\],;]+$/, "")))]
      .filter(u => { try { const p = new URL(u); return p.protocol === "https:" && !p.username && !p.password; } catch (_) { return false; } })
      .slice(0, 24);
  } catch (_) {
    return [];
  }
}

// Same keyless qualification pattern as the deploy runner: chainId, finalized
// block hash recheck, and live code on the target. The endpoint value is
// process-only and never printed or persisted.
async function qualify() {
  for (const url of loadRpcUrls()) {
    let chainId, finalized, recheck, code;
    try { chainId = await rpcOn(url, "eth_chainId", []); } catch (_) { continue; }
    if (chainId !== "0x1") continue;
    try { finalized = await rpcOn(url, "eth_getBlockByNumber", ["finalized", false]); } catch (_) { continue; }
    if (!finalized || !isHash(finalized.hash) || !isQuantity(finalized.number)) continue;
    try { recheck = await rpcOn(url, "eth_getBlockByNumber", [finalized.number, false]); } catch (_) { continue; }
    if (!recheck || recheck.hash !== finalized.hash) continue;
    try { code = await rpcOn(url, "eth_getCode", [EXECUTOR, "latest"]); } catch (_) { continue; }
    if (typeof code !== "string" || code.length <= 2) continue;
    return url;
  }
  return fail("no-qualified-provider");
}

// Same gated key-file pattern as the deploy runner. Only ever invoked in
// --execute after every gate has passed.
function loadPrivateKey() {
  for (const file of ENV_FILES) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^(?:[A-Z0-9_]+)\s*=\s*(0x[0-9a-fA-F]{64}|[0-9a-fA-F]{64})\s*(?:#.*)?$/);
      if (!m) continue;
      try {
        const wallet = new Wallet(m[1].startsWith("0x") ? m[1] : "0x" + m[1]);
        if (wallet.address.toLowerCase() === MAIN_ACCOUNT.toLowerCase()) return m[1].startsWith("0x") ? m[1] : "0x" + m[1];
      } catch (_) { continue; }
    }
  }
  return fail("key-file-unavailable");
}

// ---- preconditions (all must pass, in order, before any key/network call) ----

function gateBatch() {
  const r = tryReadJson(BUNDLE);
  if (!r.exists) return { ok: false, detail: `batch-missing:${rel(BUNDLE)}` };
  if (!r.ok) return { ok: false, detail: "batch-unreadable-or-invalid-json" };
  const b = r.value;
  if (b.approved !== true) return { ok: false, detail: "batch-not-approved" };
  const exp = Date.parse(b.expiresAt);
  if (!Number.isFinite(exp)) return { ok: false, detail: "batch-expiresAt-unparseable" };
  if (exp < Date.now()) return { ok: false, detail: "batch-expired" };
  if (String(b.account?.address || "").toLowerCase() !== MAIN_ACCOUNT) return { ok: false, detail: "batch-account-mismatch" };
  if (!b.triggerGated || typeof b.triggerGated !== "object" || !Array.isArray(b.triggerGated.requiredBeforeSignedTx)) {
    return { ok: false, detail: "triggerGated-block-missing" };
  }
  return { ok: true, detail: `approved batchId=${b.batchId} expiresAt=${b.expiresAt}`, batch: b };
}

function gateQuotes() {
  const r = tryReadJson(TRIGGER_QUOTES);
  if (!r.exists) return { ok: false, detail: `trigger-quotes-missing:${rel(TRIGGER_QUOTES)}` };
  if (!r.ok) return { ok: false, detail: "trigger-quotes-unreadable-or-invalid-json" };
  const a = r.value;
  const triggerRow = a.state === "TRIGGER_ROW"
    || (Array.isArray(a.scenarios) && a.scenarios.some(s => s && s.scenario === "TRIGGER_ROW"))
    || (Array.isArray(a.netRaw) && a.netRaw.some(x => x && x.scenario === "TRIGGER_ROW"));
  const age = ageMs(a.generatedAt);
  if (age === null) return { ok: false, detail: "trigger-quotes-generatedAt-unparseable" };
  if (age > FRESH_QUOTES_MS) return { ok: false, detail: `trigger-quotes-stale:${Math.round(age / 1000)}s>${FRESH_QUOTES_MS / 1000}s` };
  if (age < -60_000) return { ok: false, detail: "trigger-quotes-generatedAt-in-future" };
  if (!triggerRow) return { ok: false, detail: "trigger-quotes-state-not-TRIGGER_ROW" };
  return { ok: true, detail: `TRIGGER_ROW fresh age=${Math.round(age / 1000)}s`, artifact: a };
}

function gateReadiness() {
  const r = tryReadJson(READINESS);
  if (!r.exists) return { ok: false, detail: `readiness-missing:${rel(READINESS)}` };
  if (!r.ok) return { ok: false, detail: "readiness-unreadable-or-invalid-json" };
  const a = r.value;
  const s = a.summary || {};
  const age = ageMs(a.generatedAt);
  const liquidatable = Number(s.currentLiquidatable);
  const hf = Number(s.currentHealthFactor);
  if (age === null) return { ok: false, detail: "readiness-generatedAt-unparseable" };
  if (age > FRESH_READINESS_MS) return { ok: false, detail: `readiness-stale:${Math.round(age / 1000)}s>${FRESH_READINESS_MS / 1000}s` };
  if (!(liquidatable > 0)) return { ok: false, detail: `readiness-currentLiquidatable-not-positive:${s.currentLiquidatable}` };
  if (!(hf < 1.0)) return { ok: false, detail: `readiness-healthFactor-not-below-1:${s.currentHealthFactor}` };
  return { ok: true, detail: `currentLiquidatable=${liquidatable} hf=${hf} age=${Math.round(age / 1000)}s` };
}

function gateRehearsal() {
  let chosen = null;
  for (const file of REHEARSAL_RESULTS) {
    const r = tryReadJson(file);
    if (r.ok) { chosen = { file, value: r.value }; break; }
  }
  if (!chosen) return { ok: false, detail: `rehearsal-result-missing:${rel(REHEARSAL_RESULTS[0])}` };
  const a = chosen.value;
  if (a.state !== "PASS") return { ok: false, detail: `rehearsal-state-not-PASS:${a.state}` };
  const ages = [ageMs(a.completedAt), ageMs(a.generatedAt)].filter(x => x !== null);
  if (!ages.length) return { ok: false, detail: "rehearsal-timestamps-unparseable" };
  const age = Math.min(...ages);
  if (age > FRESH_REHEARSAL_MS) return { ok: false, detail: `rehearsal-stale:${Math.round(age / 1000)}s>${FRESH_REHEARSAL_MS / 1000}s` };
  return { ok: true, detail: `PASS at ${rel(chosen.file)} age=${Math.round(age / 1000)}s` };
}

function gateEconomics(artifact) {
  if (!artifact || typeof artifact !== "object") return { ok: false, detail: "economics-trigger-quotes-artifact-unavailable" };
  const scenarios = Array.isArray(artifact.scenarios) ? artifact.scenarios : [];
  const netRows = Array.isArray(artifact.netRaw) ? artifact.netRaw : [];
  const trig = scenarios.find(s => s && s.scenario === "TRIGGER_ROW") || scenarios[0] || null;

  const quoteOuts = [];
  for (const s of scenarios) {
    const exitOut = toBig(s?.exit?.exactOutWei);
    if (exitOut !== null) quoteOuts.push(exitOut);
    if (Array.isArray(s?.quotes?.uniswap)) {
      for (const q of s.quotes.uniswap) { const v = toBig(q?.exactOutWei); if (v !== null) quoteOuts.push(v); }
    }
  }
  const quotedOutWei = quoteOuts.reduce((a, b) => (b > a ? b : a), 0n);
  const minOutFloorWei = (quotedOutWei * MIN_OUT_HAIRCUT_BPS) / 100n;

  const chosenNet = netRows.find(r => r && r.scenario === "TRIGGER_ROW") || netRows[0] || null;
  let netWei = chosenNet ? toBig(chosenNet.netWei) : null;
  let gasWei = chosenNet ? toBig(chosenNet.gasCostWei) : null;
  if (gasWei === null) gasWei = toBig(trig?.gasCostWei);
  const minProfitFloorWei = netWei === null ? null : netWei - (gasWei === null ? 0n : gasWei);

  const debtToCoverWei = toBig(trig?.sizing?.repayWeth);
  const feeRaw = Number(trig?.swapPathFee ?? trig?.exit?.swapFee ?? SWAP_FEE);
  const fee = Number.isInteger(feeRaw) && feeRaw > 0 ? feeRaw : SWAP_FEE;

  if (quotedOutWei <= 0n) return { ok: false, detail: "economics-quoted-out-nonpositive" };
  if (minOutFloorWei <= 0n) return { ok: false, detail: "economics-minOut-floor-nonpositive" };
  if (minProfitFloorWei === null || minProfitFloorWei <= 0n) return { ok: false, detail: "economics-minProfit-floor-nonpositive" };
  if (debtToCoverWei === null || debtToCoverWei <= 0n) return { ok: false, detail: "economics-debtToCover-nonpositive" };
  return {
    ok: true,
    detail: `minOutFloorWei=${minOutFloorWei} minProfitFloorWei=${minProfitFloorWei} debtToCoverWei=${debtToCoverWei}`,
    floors: { minOutFloorWei, minProfitFloorWei, debtToCoverWei, quotedOutWei, fee },
  };
}

const GATE_DEFS = [
  { id: "a", name: "batch approved/unexpired/account/triggerGated", fn: gateBatch },
  { id: "b", name: "trigger-quotes TRIGGER_ROW fresh <=5m", fn: gateQuotes },
  { id: "c", name: "readiness currentLiquidatable>0 & HF<1.0 fresh <=5m", fn: gateReadiness },
  { id: "d", name: "rehearsal result PASS fresh <=10m", fn: gateRehearsal },
  { id: "e", name: "economics floors (minOut=quoted*0.98, minProfit=net-gas) nonzero", fn: gateEconomics },
];

function buildSwapPath(fee) {
  const f = Number.isInteger(Number(fee)) && Number(fee) > 0 ? Number(fee) : SWAP_FEE;
  return "0x" + WEETH.toLowerCase().replace(/^0x/, "") + f.toString(16).padStart(6, "0") + WETH.toLowerCase().replace(/^0x/, "");
}

function refuse(mode, gates, firstFailure) {
  console.log(JSON.stringify({
    ok: false,
    reason: "execution-needs-live-trigger-state",
    stage: "PRECONDITION_GATES",
    mode,
    executor: EXECUTOR,
    firstFailure,
    keyRead: false,
    networkWrite: false,
    gates,
  }, null, 2));
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const mode = execute ? "EXECUTE" : "DRY_RUN";

  // ---- step 2: evaluate every gate in order; stop at the first failure ----
  const gates = [];
  const ctx = {};
  for (let i = 0; i < GATE_DEFS.length; i++) {
    const def = GATE_DEFS[i];
    const result = def.id === "e" ? def.fn(ctx.quotesArtifact) : def.fn();
    const ok = result.ok === true;
    gates.push({ order: def.id, id: def.id, name: def.name, ok, status: ok ? "pass" : "fail", detail: result.detail });
    if (!ok) {
      for (let j = i + 1; j < GATE_DEFS.length; j++) {
        gates.push({ order: GATE_DEFS[j].id, id: GATE_DEFS[j].id, name: GATE_DEFS[j].name, ok: null, status: "skipped", detail: "not evaluated: earlier gate failed" });
      }
      return refuse(mode, gates, def.id);
    }
    if (def.id === "a") ctx.batch = result.batch;
    if (def.id === "b") ctx.quotesArtifact = result.artifact;
    if (def.id === "e") ctx.floors = result.floors;
  }

  // ---- step 3: only after every gate passed ----
  const batch = ctx.batch;
  const floors = ctx.floors;

  let wallet = null;
  if (execute) {
    const key = loadPrivateKey();
    wallet = new Wallet(key);
    if (wallet.address.toLowerCase() !== MAIN_ACCOUNT) return fail("key-account-mismatch");
  }
  const from = wallet ? wallet.address : getAddress(MAIN_ACCOUNT);

  const provider = await qualify();
  const [nonce, chainId, latest] = await Promise.all([
    rpcOn(provider, "eth_getTransactionCount", [from, "pending"]),
    rpcOn(provider, "eth_chainId", []),
    rpcOn(provider, "eth_getBlockByNumber", ["latest", false]),
  ]);

  const swapPath = buildSwapPath(floors.fee);
  const data = EXEC_IFACE.encodeFunctionData("execute", [floors.debtToCoverWei, floors.minProfitFloorWei, floors.minOutFloorWei, swapPath]);

  const gasLimitEst = await rpcOn(provider, "eth_estimateGas", [{ from, to: EXECUTOR, data }]);
  const gasLimit = BigInt(gasLimitEst);
  const batchMaxGasLimit = BigInt(batch.caps?.maxGasLimitPerTransaction ?? 0);
  if (batchMaxGasLimit > 0n && gasLimit > batchMaxGasLimit) return fail("gas-limit-exceeds-batch-cap");

  const baseFeeWei = latest?.baseFeePerGas ? BigInt(latest.baseFeePerGas) : BigInt(7);
  const tipWei = BigInt(1_000_000_000);
  const margin = (baseFeeWei * 2n) + (tipWei * 12n) / 10n + 2n;
  const batchMaxSpend = BigInt(batch.caps?.maxNativeSpendPerTransactionWei ?? 0);
  const capWeiPerGas = batchMaxSpend > 0n ? batchMaxSpend / gasLimit : 0n;
  let maxFeePerGas = margin;
  if (capWeiPerGas > 0n && margin > capWeiPerGas) maxFeePerGas = capWeiPerGas;
  if (maxFeePerGas <= 0n) return fail("zero-fee");
  const estTotal = gasLimit * maxFeePerGas;
  if (batchMaxSpend > 0n && estTotal > batchMaxSpend) return fail("spend-exceeds-batch-cap");

  const tx = {
    type: 2,
    chainId: Number(BigInt(chainId)),
    nonce: Number(BigInt(nonce)),
    to: EXECUTOR,
    data,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas: tipWei,
  };

  const estimate = {
    gasLimit: gasLimit.toString(),
    maxFeePerGas: maxFeePerGas.toString(),
    maxPriorityFeePerGas: tipWei.toString(),
    estimatedMaxFeeWei: estTotal.toString(),
    batchCapWei: batchMaxSpend > 0n ? batchMaxSpend.toString() : null,
    summary: `gas<=${gasLimit} maxFee<=${maxFeePerGas}wei estimatedMaxFeeWei=${estTotal}`,
  };
  const calldata = {
    debtToCoverWei: floors.debtToCoverWei.toString(),
    minProfitWei: floors.minProfitFloorWei.toString(),
    minOutWei: floors.minOutFloorWei.toString(),
    swapPathFee: floors.fee,
  };

  if (!execute) {
    console.log(JSON.stringify({
      ok: true,
      stage: "DRY_RUN_ESTIMATE",
      mode,
      executor: EXECUTOR,
      keyRead: false,
      networkWrite: false,
      gates: gates.map(g => ({ id: g.id, status: g.status, detail: g.detail })),
      nonce: tx.nonce,
      chainId: tx.chainId,
      calldata,
      estimate,
    }, null, 2));
    return;
  }

  const signed = await wallet.signTransaction(tx);
  const txHash = await rpcOn(provider, "eth_sendRawTransaction", [signed]);
  console.log(JSON.stringify({ ok: true, stage: "SENT", txHash }, null, 2));

  let receipt = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4_000));
    try {
      receipt = await rpcOn(provider, "eth_getTransactionReceipt", [txHash]);
      if (receipt && receipt.status !== undefined) break;
    } catch (_) { continue; }
  }
  if (!receipt || receipt.status === null) {
    console.log(JSON.stringify({ ok: false, reason: "receipt-timeout", txHash }, null, 2));
    process.exitCode = 2;
    return;
  }

  const out = {
    schema: "aave-v3-liquidation-execution/v1",
    generatedAt: new Date().toISOString(),
    scanner: "tools/execute-aave-v3-trigger.js",
    batchId: batch.batchId,
    executor: EXECUTOR,
    txHash,
    status: receipt.status,
    ok: receipt.status === "0x1" || receipt.status === "0x01",
    blockNumber: Number(BigInt(receipt.blockNumber)),
    gasUsed: BigInt(receipt.gasUsed).toString(),
    effectiveGasPriceWei: BigInt(receipt.effectiveGasPrice || 0).toString(),
    netDeltas: null,
    netDeltasNote: "not fabricated; net WETH/profit deltas require post-execution balance reads and are deliberately not estimated here",
    calldata,
    gates: gates.map(g => ({ id: g.id, status: g.status })),
    readonly: true,
    signedActionJustified: false,
  };
  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.writeFileSync(path.join(OUTDIR, `execution-${Date.now()}.json`), JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(sanitize(err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  });
}

module.exports = { GATE_DEFS, gateBatch, gateQuotes, gateReadiness, gateRehearsal, gateEconomics, buildSwapPath };
