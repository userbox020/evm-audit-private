#!/usr/bin/env node
"use strict";
// execute-euler-evk-fleet.js
// FLEET deployment runner for the built FlashLiquidateEulerEVK.
// Gated by coordination/live-execution-batch-euler-fleet.json (DRAFT:
// approved:false until the user flips it). Mirrors the gate ladder of
// tools/deploy-flash-liquidate-euler-evk.js and the fail-closed posture of
// tools/execute-euler-evk-trigger.js.
//
// Deploys target.fleetSize fresh executor instances, one signed execution per
// deploy, SEQUENTIALLY, nonce-managed (each iteration re-reads the pending
// nonce). Per-tx caps are enforced PER INSTANCE (no cap pooling). A single
// fresh fork-rehearsal PASS (<=30min) is required pre-deploy; the per-deploy
// freshness timestamp is re-recorded for every iteration.
//
// Fail-closed while DRAFT: with approved !== true the runner refuses BEFORE any
// key read or network call and, in --dry-run, exits 0 with a named reason
// (batch-missing-ok | APPROVED_FALSE | ...). Private key material is read from
// gated env files only in --execute after every gate passed; it stays
// in-process and is never printed, hashed, persisted, or passed on a command
// line. Endpoint material (URL/host/path) is never printed or persisted.
//
// CLI: --dry-run (default) | --execute   [--batch <path>]

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Wallet, Interface, ContractFactory, getAddress } = require(path.join(__dirname, "node_modules", "ethers"));

const ROOT = path.resolve(__dirname, "..");
const ARGV = process.argv.slice(2);
function arg(flag, fallback) {
  const i = ARGV.indexOf(flag);
  return i !== -1 && ARGV[i + 1] ? ARGV[i + 1] : fallback;
}
const BUNDLE = path.resolve(ROOT, arg("--batch", "coordination/live-execution-batch-euler-fleet.json"));
const ARTIFACT = path.join(ROOT, "contracts", "flash-liquidate-euler-evk", "out", "FlashLiquidateEulerEVK.sol", "FlashLiquidateEulerEVK.json");
const REHEARSAL = path.join(ROOT, "reports", "raw", "fast", "euler-fork-rehearsal", "result.json");
const STATUS_OUT = path.join(ROOT, "reports", "raw", "fast", "euler-fleet-deploy-status.json");
const VERIFY_TOOL = path.join(ROOT, "tools", "verify-deployed-bytecode.js");
const ENV_FILES = [path.join(ROOT, ".env"), path.join(ROOT, ".env.exploit")];

const MAIN_ACCOUNT = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const CONSTRUCTOR_ARGS = [
  getAddress("0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383"), // Euler EVC (per interface manifest)
];
const FRESH_REHEARSAL_MS = 30 * 60 * 1000;

const urls = (() => {
  const out = ["https://eth.blockscout.com/api/eth-rpc", "https://eth.drpc.org"];
  try {
    const txt = fs.readFileSync(path.join(ROOT, "rpc_endpoints.txt"), "utf8");
    for (const u of (txt.match(/https?:\/\/[^\s'"<>\[\]]+/gi) || []).map((x) => x.replace(/[)\],;]+$/, ""))) {
      try { const p = new URL(u); if (p.protocol === "https:" && !p.username && !p.password) out.push(u); } catch (_) {}
    }
  } catch (_) {}
  return [...new Set(out)].slice(0, 26);
})();

function sanitize(v) { return typeof v === "string" ? v.replaceAll(/[0-9a-fA-F]{64}/g, "<64hex>") : v; }
function rel(file) { return path.relative(ROOT, file).replace(/\\/g, "/"); }
function tryReadJson(file) {
  try {
    if (!fs.existsSync(file)) return { exists: false, ok: false, value: null };
    return { exists: true, ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (_) { return { exists: true, ok: false, value: null }; }
}
function ageMs(iso) { const t = Date.parse(iso); return Number.isFinite(t) ? Date.now() - t : null; }

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

// ---- gate ladder (all evaluated in order, in-process, before any key read) ----

// a. batch present + approved + unexpired + account matches. Refuse BEFORE any
//    network/key access while approved !== true (fail-closed DRAFT posture).
function gateBatch() {
  const r = tryReadJson(BUNDLE);
  if (!r.exists) return { ok: false, reason: "batch-missing-ok", detail: `batch-missing-ok:${rel(BUNDLE)} (expected while DRAFT; deploy path fail-closed)` };
  if (!r.ok) return { ok: false, reason: "batch-unreadable-or-invalid-json", detail: "batch-unreadable-or-invalid-json" };
  const b = r.value;
  if (b.approved !== true) return { ok: false, reason: "APPROVED_FALSE", detail: `APPROVED_FALSE: batch approved=${JSON.stringify(b.approved)} — awaiting user approval; deploy path fail-closed` };
  const exp = Date.parse(b.expiresAt);
  if (!Number.isFinite(exp)) return { ok: false, reason: "batch-expiresAt-unparseable", detail: "batch-expiresAt-unparseable" };
  if (exp < Date.now()) return { ok: false, reason: "batch-expired", detail: "batch-expired" };
  if (String(b.account?.address || "").toLowerCase() !== MAIN_ACCOUNT) return { ok: false, reason: "batch-account-mismatch", detail: "batch-account-mismatch" };
  return { ok: true, detail: `approved batchId=${b.batchId} expiresAt=${b.expiresAt}`, batch: b };
}

// b. fleet target present; fleetSize positive integer; caps cover the fleet.
function gateFleet(b) {
  const t = Array.isArray(b.targets) ? b.targets.find((x) => x && x.kind === "contract-deployment") : null;
  if (!t) return { ok: false, reason: "fleet-target-missing", detail: "fleet-target-missing: no contract-deployment target" };
  const fleetSize = Number(t.fleetSize);
  if (!Number.isInteger(fleetSize) || fleetSize <= 0) return { ok: false, reason: "fleet-size-invalid", detail: `fleet-size-invalid:${t.fleetSize}` };
  const signedTotal = Number(b.caps?.signedExecutionsTotal ?? b.caps?.signedExecutions ?? 0);
  if (!Number.isInteger(signedTotal) || signedTotal < fleetSize) {
    return { ok: false, reason: "fleet-caps-insufficient", detail: `fleet-caps-insufficient: signedExecutionsTotal=${signedTotal} < fleetSize=${fleetSize} (one signed execution per deploy, no reuse)` };
  }
  return { ok: true, detail: `fleetSize=${fleetSize} signedExecutionsTotal=${signedTotal}`, fleetSize, target: t };
}

// c. single fresh fork-rehearsal PASS (<=30min), read once pre-deploy. The
//    per-deploy timestamp re-check is recorded for every iteration in the loop.
function gateRehearsal() {
  const r = tryReadJson(REHEARSAL);
  if (!r.exists) return { ok: false, reason: "rehearsal-result-missing", detail: `rehearsal-result-missing:${rel(REHEARSAL)}` };
  if (!r.ok) return { ok: false, reason: "rehearsal-result-unreadable", detail: "rehearsal-result-unreadable-or-invalid-json" };
  const a = r.value;
  if (a.state !== "PASS") return { ok: false, reason: "rehearsal-state-not-PASS", detail: `rehearsal-state-not-PASS:${a.state}` };
  const ages = [ageMs(a.generatedAt), ageMs(a.completedAt)].filter((x) => x !== null);
  if (!ages.length) return { ok: false, reason: "rehearsal-timestamps-unparseable", detail: "rehearsal-timestamps-unparseable" };
  const age = Math.min(...ages);
  if (age > FRESH_REHEARSAL_MS) return { ok: false, reason: "rehearsal-stale", detail: `rehearsal-stale:${Math.round(age / 1000)}s>${FRESH_REHEARSAL_MS / 1000}s` };
  return { ok: true, detail: `PASS at ${rel(REHEARSAL)} age=${Math.round(age / 1000)}s`, rehearsal: a, age };
}

const GATE_DEFS = [
  { id: "a", name: "batch present/approved/unexpired/account", fn: () => gateBatch() },
  { id: "b", name: "fleet target + fleetSize + caps cover fleet", fn: () => gateFleet(gateBatch().batch) },
  { id: "c", name: "fresh fork-rehearsal PASS <=30m (read once pre-deploy)", fn: () => gateRehearsal() },
];

async function qualify() {
  for (const url of urls) {
    let chainId, finalized, recheck, code;
    try { chainId = await rpcOn(url, "eth_chainId", []); } catch (_) { continue; }
    if (chainId !== "0x1") continue;
    try { finalized = await rpcOn(url, "eth_getBlockByNumber", ["finalized", false]); } catch (_) { continue; }
    if (!finalized || !isHash(finalized.hash) || !isQuantity(finalized.number)) continue;
    try { recheck = await rpcOn(url, "eth_getBlockByNumber", [finalized.number, false]); } catch (_) { continue; }
    if (!recheck || recheck.hash !== finalized.hash) continue;
    try { code = await rpcOn(url, "eth_getCode", ["0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383", "latest"]); } catch (_) { continue; }
    if (typeof code !== "string" || code.length <= 2) continue;
    return url;
  }
  return null;
}

// Only ever invoked in --execute after EVERY gate passed.
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
  return null;
}

// Post-deploy verification slurp. verify-deployed-bytecode.js currently exposes
// NO per-instance CLI (its TARGETS table is static), so the honest path is a
// fail-closed DEFERRED note: add EULER-LIQ-V3-F{n} entries to its TARGETS and
// run it. If a future revision adds a CLI intake, spawn it through child_process.
function verifyInstance(address, label) {
  try {
    const src = fs.readFileSync(VERIFY_TOOL, "utf8");
    const hasCli = /process\.argv/.test(src) && /--address/.test(src);
    if (!hasCli) {
      return {
        label,
        address,
        status: "DEFERRED_VERIFICATION",
        reason: "verify-deployed-bytecode.js exposes no per-instance CLI (static TARGETS); add an EULER-LIQ-V3-F{n} entry and run it",
        expectedPostCondition: "bytecode MATCH_IMMUTABLES_MASKED",
      };
    }
    const r = spawnSync(process.execPath, [VERIFY_TOOL, "--address", address, "--label", label], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
    return { label, address, status: r.status === 0 ? "VERIFIED" : "VERIFY_TOOL_FAILED", exitCode: r.status, stdoutTail: sanitize((r.stdout || "").slice(-400)) };
  } catch (err) {
    return { label, address, status: "DEFERRED_VERIFICATION", reason: "verify-tool-unavailable:" + sanitize(String(err && err.message)) };
  }
}

function writeStatus(payload) {
  try {
    fs.mkdirSync(path.dirname(STATUS_OUT), { recursive: true });
    fs.writeFileSync(STATUS_OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  } catch (_) { /* status write is best-effort; never fatal */ }
}

function refuse(mode, gates, firstFailure, reason) {
  const payload = {
    schema: "euler-fleet-deploy-status/v1",
    generatedAt: new Date().toISOString(),
    scanner: "tools/execute-euler-evk-fleet.js",
    mode,
    batchId: (tryReadJson(BUNDLE).value || {}).batchId || null,
    decision: "FAIL_CLOSED",
    firstFailure,
    reason,
    keyRead: false,
    networkWrite: false,
    gates: gates.map((g) => ({ id: g.id, status: g.status, detail: g.detail })),
    deploys: [],
    totals: { requested: null, deployed: 0, signedExecutionsUsed: 0, nativeSpendWei: "0" },
  };
  writeStatus(payload);
  console.log(JSON.stringify({ ok: false, stage: "PRECONDITION_GATES", ...payload }, null, 2));
  // DRAFT/dry-run refusals are non-fatal (exit 0); an --execute refusal is fatal.
  process.exitCode = mode === "EXECUTE" ? 1 : 0;
}

async function deployOne(index, provider, from, wallet, batch, fleetSize, rehearsalAge) {
  const label = `EULER-LIQ-V3-F${index}`;
  const row = { index, label, nonce: null, nonceManaged: true, gasLimit: null, maxFeePerGas: null, estimatedMaxFeeWei: null, status: "PENDING", txHash: null, contractAddress: null, rehearsedAgeMs: rehearsalAge };

  const nonce = await rpcOn(provider, "eth_getTransactionCount", [from, "pending"]);
  const [chainId, latest, priorityFee] = await Promise.all([
    rpcOn(provider, "eth_chainId", []),
    rpcOn(provider, "eth_getBlockByNumber", ["latest", false]),
    rpcOn(provider, "eth_maxPriorityFeePerGas", []).catch(() => null),
  ]);
  row.nonce = Number(BigInt(nonce));

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  const creationHex = (artifact.bytecode?.object || artifact.bytecode).replace(/^0x/i, "");
  const factory = new ContractFactory(artifact.abi, "0x" + creationHex, null);
  const deployTx = await factory.getDeployTransaction(...CONSTRUCTOR_ARGS);
  const data = deployTx.data;

  const gasLimitEst = await rpcOn(provider, "eth_estimateGas", [{ from, data }]);
  const batchMaxGasLimit = BigInt(batch.caps?.maxGasLimitPerTransaction ?? 0);
  const batchMaxSpend = BigInt(batch.caps?.maxNativeSpendPerTransactionWei ?? 0);
  const gasLimit = BigInt(gasLimitEst);
  if (batchMaxGasLimit > 0n && gasLimit > batchMaxGasLimit) { row.status = "FAIL_CAP_GAS"; row.detail = `gas-limit-exceeds-batch-cap:${gasLimit}>${batchMaxGasLimit}`; return row; }

  const baseFeeWei = latest?.baseFeePerGas ? BigInt(latest.baseFeePerGas) : BigInt(7);
  const reportedTip = priorityFee ? BigInt(priorityFee) : BigInt(1_000_000_000);
  const tipWei = reportedTip > BigInt(1_000_000_000) ? reportedTip : BigInt(1_000_000_000);
  const margin = (baseFeeWei * 2n) + (tipWei * 12n) / 10n + 2n;
  const capWeiPerGas = batchMaxSpend > 0n ? batchMaxSpend / gasLimit : BigInt(0);
  let maxFeePerGas = margin;
  if (capWeiPerGas > 0n && margin > capWeiPerGas) maxFeePerGas = capWeiPerGas;
  if (maxFeePerGas <= 0n) { row.status = "FAIL_ZERO_FEE"; row.detail = "zero-fee"; return row; }

  row.gasLimit = gasLimit.toString();
  row.maxFeePerGas = maxFeePerGas.toString();
  row.maxPriorityFeePerGas = tipWei.toString();
  row.estimatedMaxFeeWei = (gasLimit * maxFeePerGas).toString();
  if (batchMaxSpend > 0n && BigInt(row.estimatedMaxFeeWei) > batchMaxSpend) { row.status = "FAIL_CAP_SPEND"; row.detail = `spend-exceeds-batch-cap:${row.estimatedMaxFeeWei}>${batchMaxSpend}`; return row; }

  const tx = {
    type: 2,
    chainId: Number(BigInt(chainId)),
    nonce: row.nonce,
    data,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas: tipWei,
  };

  if (!wallet) { row.status = "DRY_RUN_ESTIMATE"; row.detail = "not sent"; return row; }

  const signed = await wallet.signTransaction(tx);
  row.txHash = await rpcOn(provider, "eth_sendRawTransaction", [signed]);
  let receipt = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4_000));
    try { receipt = await rpcOn(provider, "eth_getTransactionReceipt", [row.txHash]); if (receipt && receipt.status !== undefined) break; } catch (_) { continue; }
  }
  if (!receipt || receipt.status === null) { row.status = "RECEIPT_TIMEOUT"; return row; }
  row.ok = receipt.status === "0x1" || receipt.status === "0x01";
  row.status = row.ok ? "DEPLOYED" : "TX_FAILED";
  row.contractAddress = receipt.contractAddress || null;
  row.blockNumber = Number(BigInt(receipt.blockNumber));
  row.gasUsed = BigInt(receipt.gasUsed).toString();
  row.effectiveGasPriceWei = BigInt(receipt.effectiveGasPrice || 0).toString();
  return row;
}

async function main() {
  const execute = ARGV.includes("--execute");
  const mode = execute ? "EXECUTE" : "DRY_RUN";

  // ---- step 1: evaluate every gate in order; stop at the first failure ----
  const gates = [];
  const ctx = {};
  for (let i = 0; i < GATE_DEFS.length; i++) {
    const def = GATE_DEFS[i];
    const result = def.fn();
    const ok = result.ok === true;
    gates.push({ id: def.id, name: def.name, ok, status: ok ? "pass" : "fail", detail: result.detail });
    if (!ok) {
      for (let j = i + 1; j < GATE_DEFS.length; j++) {
        gates.push({ id: GATE_DEFS[j].id, name: GATE_DEFS[j].name, ok: null, status: "skipped", detail: "not evaluated: earlier gate failed" });
      }
      // Fail-closed: no key read, no network call, no bytes sent.
      return refuse(mode, gates, def.id, result.reason);
    }
    if (def.id === "a") ctx.batch = result.batch;
    if (def.id === "b") { ctx.fleetSize = result.fleetSize; ctx.target = result.target; }
    if (def.id === "c") { ctx.rehearsal = result.rehearsal; ctx.rehearsalAge = result.age; }
  }

  // ---- step 2: only after every gate passed (approved === true) ----
  const batch = ctx.batch;
  const fleetSize = ctx.fleetSize;

  let wallet = null;
  if (execute) {
    const key = loadPrivateKey();
    if (!key) return refuse(mode, gates, "a", "key-file-unavailable");
    wallet = new Wallet(key);
    if (wallet.address.toLowerCase() !== MAIN_ACCOUNT) return refuse(mode, gates, "a", "key-account-mismatch");
  }
  const from = wallet ? wallet.address : getAddress(MAIN_ACCOUNT);

  const provider = await qualify();
  if (!provider) return refuse(mode, gates, "a", "no-qualified-provider");

  const deploys = [];
  let signedUsed = 0;
  let nativeSpendWei = 0n;
  let failClosed = false;
  for (let n = 1; n <= fleetSize; n++) {
    // per-deploy freshness re-check of the single pre-deploy rehearsal (the cap honored)
    const ageNow = [ageMs(ctx.rehearsal.generatedAt), ageMs(ctx.rehearsal.completedAt)].filter((x) => x !== null);
    const rehearsalAge = ageNow.length ? Math.min(...ageNow) : null;
    if (rehearsalAge === null || rehearsalAge > FRESH_REHEARSAL_MS) {
      deploys.push({ index: n, label: `EULER-LIQ-V3-F${n}`, status: "FAIL_REHEARSAL_STALE", detail: `rehearsal-stale-at-deploy:${rehearsalAge}` });
      failClosed = true;
      break;
    }
    const row = await deployOne(n, provider, from, wallet, batch, fleetSize, rehearsalAge);
    if (wallet && row.status === "DEPLOYED") signedUsed++;
    if (row.estimatedMaxFeeWei && (row.status === "DEPLOYED" || row.status === "RECEIPT_TIMEOUT")) nativeSpendWei += BigInt(row.estimatedMaxFeeWei);
    deploys.push(row);
    if (row.status.startsWith("FAIL") || row.status === "TX_FAILED" || row.status === "RECEIPT_TIMEOUT") { failClosed = true; break; }
  }

  const verification = deploys.filter((d) => d.status === "DEPLOYED" && d.contractAddress).map((d) => verifyInstance(d.contractAddress, d.label));

  const payload = {
    schema: "euler-fleet-deploy-status/v1",
    generatedAt: new Date().toISOString(),
    scanner: "tools/execute-euler-evk-fleet.js",
    mode,
    batchId: batch.batchId,
    decision: failClosed ? "FAIL_CLOSED" : (execute ? "COMPLETE" : "DRY_RUN_ESTIMATE"),
    keyRead: execute,
    networkWrite: execute && signedUsed > 0,
    gates: gates.map((g) => ({ id: g.id, status: g.status, detail: g.detail })),
    rehearsal: { artifact: rel(REHEARSAL), state: ctx.rehearsal.state, readOncePreDeploy: true, perDeployFreshnessRecheck: true },
    deploys,
    verification,
    verificationNote: verification.every((v) => v.status === "DEFERRED_VERIFICATION")
      ? "post-deploy BYTECODE MATCH_IMMUTABLES_MASKED deferred: verify-deployed-bytecode.js has no per-instance CLI; add EULER-LIQ-V3-F{n} entries and run it"
      : "see per-instance verification rows",
    totals: { requested: fleetSize, attempted: deploys.length, deployed: deploys.filter((d) => d.status === "DEPLOYED").length, signedExecutionsUsed: signedUsed, nativeSpendWei: nativeSpendWei.toString() },
  };
  writeStatus(payload);
  console.log(JSON.stringify({ ok: !failClosed, stage: execute ? "EXECUTE" : "DRY_RUN_ESTIMATE", ...payload }, null, 2));
  if (failClosed) process.exitCode = mode === "EXECUTE" ? 2 : 0;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(sanitize(err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  });
}

module.exports = { GATE_DEFS, gateBatch, gateFleet, gateRehearsal, verifyInstance };
