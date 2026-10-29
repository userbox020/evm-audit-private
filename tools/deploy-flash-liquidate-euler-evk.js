#!/usr/bin/env node
"use strict";
// Orchestrator-lane deployment runner for the built FlashLiquidateEulerEVK.
// Gated by coordination/live-execution-batch-euler-executor-deploy.json.
// Private key material is read from gated env files within the approved batch,
// stays in-process, and is never printed, hashed, persisted, or passed on a command line.
// CLI: --dry-run (build + estimate only) | --execute (deploy once).

const fs = require("node:fs");
const path = require("node:path");
const { Wallet, Interface, ContractFactory, getAddress } = require(path.join(__dirname, "node_modules", "ethers"));

const BUNDLE = path.join(__dirname, "..", "coordination", "live-execution-batch-euler-executor-deploy.json");
// Optional second-executor batch override: --batch <path> (fail-closed default above).
const argvEarly = process.argv.slice(2);
const __batchIdx = argvEarly.indexOf("--batch");
const BUNDLE_ACTIVE = __batchIdx !== -1 && argvEarly[__batchIdx + 1]
  ? path.resolve(process.cwd(), argvEarly[__batchIdx + 1])
  : BUNDLE;
const ARTIFACT = path.join(__dirname, "..", "contracts", "flash-liquidate-euler-evk", "out", "FlashLiquidateEulerEVK.sol", "FlashLiquidateEulerEVK.json");
const ENV_FILES = [path.join(__dirname, "..", ".env"), path.join(__dirname, "..", ".env.exploit")];

const MAIN_ACCOUNT = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const CONSTRUCTOR_ARGS = [
  getAddress("0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383"), // Euler EVC (per interface manifest)
].filter(Boolean);

const urls = [
  "https://eth.blockscout.com/api/eth-rpc",
  "https://eth.drpc.org",
  ...[...new Set((fs.readFileSync("rpc_endpoints.txt", "utf8").match(/https?:\/\/[^\s'"<>\[\]]+/gi) || []).map(u => u.replace(/[)\],;]+$/, "")))]
    .filter(u => { try { const p = new URL(u); return p.protocol === "https:" && !p.username && !p.password; } catch (_) { return false; } })
    .slice(0, 24),
];

function fail(code) { console.log(JSON.stringify({ ok: false, reason: code })); process.exit(1); }
function sanitize(v) { return typeof v === "string" ? v.replaceAll(/[0-9a-fA-F]{64}/g, "<64hex>") : v; }

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

function loadBatch() {
  const b = JSON.parse(fs.readFileSync(BUNDLE_ACTIVE, "utf8"));
  if (!b.approved || (typeof b.approved !== "boolean")) fail("batch-not-approved");
  if (Date.parse(b.expiresAt) < Date.now()) fail("batch-expired");
  if (b.account?.address?.toLowerCase() !== MAIN_ACCOUNT) fail("batch-account-mismatch");
  return b;
}

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
  fail("key-file-unavailable");
}

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
  fail("no-qualified-provider");
}

(async () => {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const batch = loadBatch();

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  const creationHex = (artifact.bytecode?.object || artifact.bytecode).replace(/^0x/i, "");
  const abi = artifact.abi;
  const factory = new ContractFactory(abi, "0x" + creationHex, null);

  const walletKey = loadPrivateKey();
  const wallet = new Wallet(walletKey);
  if (wallet.address.toLowerCase() !== MAIN_ACCOUNT.toLowerCase()) fail("key-account-mismatch");

  const provider = await qualify();
  // contract deploy data via ethers (handles constructor args internally)
  const deployTx = await factory.getDeployTransaction(...CONSTRUCTOR_ARGS);
  const data = deployTx.data;

  const [nonce, chainId, latest, priorityFee] = await Promise.all([
    rpcOn(provider, "eth_getTransactionCount", [wallet.address, "pending"]),
    rpcOn(provider, "eth_chainId", []),
    rpcOn(provider, "eth_getBlockByNumber", ["latest", false]),
    rpcOn(provider, "eth_maxPriorityFeePerGas", []).catch(() => null),
  ]);

  const baseFeeWei = latest?.baseFeePerGas ? BigInt(latest.baseFeePerGas) : BigInt(7);
  // priority-fee floor: some archive providers report near-zero tips, which would strand the tx unmined
  const reportedTip = priorityFee ? BigInt(priorityFee) : BigInt(1_000_000_000);
  const tipWei = reportedTip > BigInt(1_000_000_000) ? reportedTip : BigInt(1_000_000_000);
  const gasLimitEst = await rpcOn(provider, "eth_estimateGas", [{ from: wallet.address, data }]);

  const batchMaxGasLimit = BigInt(batch.caps.maxGasLimitPerTransaction ?? 0);
  const batchMaxSpend = BigInt(batch.caps.maxNativeSpendPerTransactionWei ?? 0);
  const gasLimit = BigInt(gasLimitEst);
  if (batchMaxGasLimit > 0n && gasLimit > batchMaxGasLimit) { fail("gas-limit-exceeds-batch-cap"); }

  // maxFeePerGas = maxFeeAfter = min(2*baseFee + 1.25*tip; batch cap / gasLimit)
  const margin = (baseFeeWei * 2n) + (tipWei * 12n) / 10n + 2n;
  const capWeiPerGas = batchMaxSpend > 0n ? batchMaxSpend / gasLimit : BigInt(0);
  let maxFeePerGas = margin;
  if (capWeiPerGas > 0n && margin > capWeiPerGas) { maxFeePerGas = capWeiPerGas; }
  if (maxFeePerGas <= 0n) fail("zero-fee");

  const tx = {
    type: 2,
    chainId: Number(BigInt(chainId)),
    nonce: Number(BigInt(nonce)),
    data,
    gasLimit,
    maxFeePerGas: maxFeePerGas,
    maxPriorityFeePerGas: tipWei,
  };

  const estTotal = (gasLimit * (maxFeePerGas)).toString();
  if (batchMaxSpend > 0n && BigInt(estTotal) > batchMaxSpend) fail("spend-exceeds-batch-cap");
  const estSample = { gasLimit: gasLimit.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: tipWei.toString(), estimatedMaxFeeWei: estTotal, batchCapWei: batchMaxSpend?.toString() || null, mode: execute ? "EXECUTE" : "DRY_RUN" };
  console.log(JSON.stringify({ ok: true, stage: "ESTIMATE", nonce: tx.nonce, chainId: tx.chainId, estSample }, null, 2));

  if (!execute) {
    console.log(JSON.stringify({ ok: true, stage: "DRY_RUN_ONLY_NOT_SENT" }, null, 2));
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
  if (!receipt || receipt.status === null) { console.log(JSON.stringify({ ok: false, reason: "receipt-timeout", txHash }, null, 2)); process.exitCode = 2; return; }
  const deployedAddress = receipt.contractAddress || null;
  const result = {
    ok: receipt.status === "0x1" || receipt.status === "0x01",
    stage: "RECEIPT",
    txHash, contractAddress: deployedAddress,
    blockNumber: Number(BigInt(receipt.blockNumber)),
    gasUsed: BigInt(receipt.gasUsed).toString(),
    effectiveGasPriceWei: BigInt(receipt.effectiveGasPrice || 0).toString(),
  };
  console.log(JSON.stringify(result, null, 2));
  const outDir = path.join(__dirname, "..", "reports", "raw", "fast", "euler-flash-liquidator-deploy");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `deployment-${Date.now()}.json`), JSON.stringify({ schema: "euler-flash-liquidator-deployment/v1", batchId: batch.batchId, ...result, readonly: true, signedActionJustified: false, note: "no liquidate() call performed; verification pending verify-deployed-bytecode.js" }, null, 2) + "\n", "utf8");
})();
