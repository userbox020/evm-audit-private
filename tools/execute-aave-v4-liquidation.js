#!/usr/bin/env node
"use strict";

// Import-inert. CLI execution requires approved scope, exact two-family pin and the shared wallet lock.
const fs = require("node:fs");
const path = require("node:path");
const { Interface } = require("./node_modules/ethers");
const guard = require("./lib/wallet-execution-guard.js");
const { createPinnedRpc, loadRpcCandidates, httpRpc, MULTICALL3 } = require("./lib/executor-pinned-rpc.js");
const { MAIN_ACCOUNT, requireThat, uint, safeError, atomicJson } = guard;
const ROOT = path.resolve(__dirname, "..");
const BUNDLE = path.join(ROOT, "coordination/live-execution-batch-aave-v4-executor-deploy-20261019.json");
const COMPILED = path.join(__dirname, "fork-poc/contracts/FlashLiquidateAaveV4.compiled.json");
const STATUS_FILE = path.join(ROOT, "reports/raw/fast/aave-v4-executor-live-watch.json");
const DEPLOYED_EXECUTOR = "0x3c02c96bbb423d0109b823c23a05fcf0bf91ecb7";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const MULTICALL_IFACE = new Interface(["function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns(tuple(bool success,bytes returnData)[] returnData)"]);
const TARGET_PLANS = Object.freeze([
  { id: "spokeA-candidate1-usde-usdc", spoke: "0xba1b3d55d249692b669a164024a838309b7508af", collateralReserveId: 3, debtReserveId: 4,
    borrower: "0x1cb432f80416f07db4420b8c20447924a0658894", debtAsset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    collateralAsset: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", flashLoanAmount: 360000000000n, debtToCover: (1n << 256n) - 1n,
    minSwapOut: 348000000000n, minProfit: 100000000n, venueType: 0, swapTarget: "0x0000000000000000000000000000000000000000",
    uniV3Fee: 100, curveIndexIn: 0, curveIndexOut: 0, customSwapData: "0x" },
  ...[
    { id: "spokeC-c1-weeth-weth-0x4053", borrower: "0x40534e513df8277870b81e97b5107b3f39de4f15", flashLoanAmount: 130000000000000000000n, minSwapOut: 120000000000000000000n },
    { id: "spokeC-c2-weeth-weth-0xafbf", borrower: "0xafbf278e06d2269aba2a4898afbab2ecb2584924", flashLoanAmount: 110000000000000000000n, minSwapOut: 100000000000000000000n },
    { id: "spokeC-candidate3-weeth-weth", borrower: "0x1a557354c5b8d7df38ea914209e416dc7065b158", flashLoanAmount: 1200000000000000000000n, minSwapOut: 1120000000000000000000n },
    { id: "spokeC-c4-weeth-weth-0xfcc8", borrower: "0xfcc83b338ba980f501e51110c7f51791a21d4a28", flashLoanAmount: 150000000000000000000n, minSwapOut: 138000000000000000000n },
    { id: "spokeC-candidate4-weeth-weth", borrower: "0x7231eaeea108e3ea05c993cbee21f23ddd7a44bf", flashLoanAmount: 360000000000000000000n, minSwapOut: 330000000000000000000n },
    { id: "spokeC-c6-weeth-weth-0xba48", borrower: "0xba482cae263659b3226c919b9229a27c76217d7d", flashLoanAmount: 165000000000000000000n, minSwapOut: 152000000000000000000n },
    { id: "spokeC-c7-weeth-weth-0xc99f", borrower: "0xc99f25ac2404f6cf35bd6fe5ccb7f88f0625a8be", flashLoanAmount: 225000000000000000000n, minSwapOut: 210000000000000000000n },
    { id: "spokeC-c8-weeth-weth-0x4b98", borrower: "0x4b9859df9ba9b428328c05eea63b51c3b36fd2bb", flashLoanAmount: 120000000000000000000n, minSwapOut: 110000000000000000000n }
  ].map(t => ({ spoke: "0xbf10bdfe177de0336afd7fccf80a904e15386219", collateralReserveId: 0, debtReserveId: 1, debtAsset: WETH,
    collateralAsset: "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee", debtToCover: (1n << 256n) - 1n, minProfit: 50000000000000000n,
    venueType: 1, swapTarget: "0xdb74dfdd3bb46be8ce6c33dc9d82777bcfc3ded5", uniV3Fee: 0, curveIndexIn: 1, curveIndexOut: 0, customSwapData: "0x", ...t }))
].map(Object.freeze));
const REQUIRED_TARGETS = [...new Set(TARGET_PLANS.map(t => t.spoke)), "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb",
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", "0xdb74dfdd3bb46be8ce6c33dc9d82777bcfc3ded5"];
function validateAuthorization(batch, now) {
  const caps = guard.validateBatch(batch, { kind: "v4", requiredTargets: REQUIRED_TARGETS, now });
  for (const t of TARGET_PLANS) requireThat(t.minSwapOut > 0n && t.minProfit >= (t.debtAsset === WETH ? caps.minProfitWeth : caps.minProfitUsdc), "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
  return caps;
}
function buildPlanVariants(template, deadline) {
  return [
    { ...template, deadline },
    { ...template, flashLoanAmount: (template.flashLoanAmount * 28n) / 10n, deadline },
    { ...template, debtToCover: template.flashLoanAmount, deadline },
  ];
}
function planPriorityScore(template) {
  // Fixed sizing heuristic only; this is not a live price or profit estimate.
  return template.debtAsset === WETH ? template.flashLoanAmount : template.flashLoanAmount * 10n ** 12n / 2400n;
}
async function readHealthBatch(pinned, execIface) {
  const data = MULTICALL_IFACE.encodeFunctionData("aggregate3", [TARGET_PLANS.map(t => ({ target: DEPLOYED_EXECUTOR,
    allowFailure: true, callData: execIface.encodeFunctionData("previewHealthFactor", [t.spoke, t.borrower]) }))]);
  const raw = await pinned.call({ to: MULTICALL3, data });
  const rows = MULTICALL_IFACE.decodeFunctionResult("aggregate3", raw)[0];
  requireThat(rows.length === TARGET_PLANS.length && MULTICALL_IFACE.encodeFunctionResult("aggregate3", [rows]).toLowerCase() === raw.toLowerCase(), "HEALTH_BATCH_INVALID");
  return rows.map((r, index) => {
    const t = TARGET_PLANS[index];
    if (!r.success) return { id: t.id, spoke: t.spoke, borrower: t.borrower, healthFactorRaw: null, isLiquidatableBothProviders: false };
    const d = execIface.decodeFunctionResult("previewHealthFactor", r.returnData);
    requireThat(execIface.encodeFunctionResult("previewHealthFactor", d).toLowerCase() === r.returnData.toLowerCase(), "HEALTH_ABI_INVALID");
    return { id: t.id, spoke: t.spoke, borrower: t.borrower, healthFactorRaw: d[0].toString(),
      healthFactorFormatted: (Number(d[0]) / 1e18).toFixed(9), bpsToLiquidation: ((Number(d[0]) / 1e18 - 1) * 10000).toFixed(3),
      isLiquidatableBothProviders: d[1] === true && d[0] < 10n ** 18n };
  });
}
async function runOnce({ execute = false, argv = [], pinned, execIface, batch, loadBatch = () => batch, now = Date.now, writeOut = false, statusFile = STATUS_FILE,
  signTransaction = guard.signWithProcessKey, secondarySendRawTransaction, executionOptions = {} }) {
  writeOut = writeOut && !argv.includes("--no-write");
  const sendRawTransaction = async signed => {
    const sentHash = await pinned.send(signed);
    if (typeof secondarySendRawTransaction === "function") {
      void (async () => {
        try { await secondarySendRawTransaction(signed); } catch (_) {}
      })();
    }
    return sentHash;
  };
  try {
    guard.parseMode([...argv, ...(execute ? ["--execute-if-liquidatable"] : [])], "--execute-if-liquidatable");
    const caps = execute ? validateAuthorization(batch, now()) : null;
    const targets = await readHealthBatch(pinned, execIface); await pinned.recheck();
    if (execute) {
      await guard.reconcileWallet({ ...executionOptions, account: MAIN_ACCOUNT, receiptRpc: hash => pinned.receipt(hash) });
      validateAuthorization(loadBatch(), now());
    }
    const fired = targets.filter(t => t.isLiquidatableBothProviders);
    const snapshot = { ok: true, armed: execute, checkedAt: new Date(now()).toISOString(), mode: execute ? "EXECUTE_IF_LIQUIDATABLE" : "CHECK_ONLY",
      owner: MAIN_ACCOUNT, deployedExecutor: DEPLOYED_EXECUTOR, pin: pinned.pin, blockNumber: pinned.pin.number, evidence: pinned.evidence,
      firedCount: fired.length, targets, partition: "DEDICATED_V4_ONLY", profitConvention: "TOKEN_PROFIT_BEFORE_NATIVE_GAS; REALIZED_NET_UNKNOWN" };
    if (writeOut) atomicJson(statusFile, snapshot);
    if (!execute || !fired.length) return snapshot;
    const preflightFailures = [];
    const orderedFired = [...fired].sort((a, b) => {
      const sa = planPriorityScore(TARGET_PLANS.find(t => t.id === a.id));
      const sb = planPriorityScore(TARGET_PLANS.find(t => t.id === b.id));
      return sb === sa ? 0 : sb > sa ? 1 : -1;
    });
    for (const firedTarget of orderedFired) {
      const template = TARGET_PLANS.find(t => t.id === firedTarget.id);
      const deadline = BigInt(Math.floor(now() / 1000)) + 120n;
      let plan, data, profit, fees, lastError;
      for (const candidatePlan of buildPlanVariants(template, deadline)) {
        try {
          const candidateData = execIface.encodeFunctionData("execute", [candidatePlan]), call = { from: MAIN_ACCOUNT, to: DEPLOYED_EXECUTOR, data: candidateData };
          const raw = await pinned.call(call), decoded = execIface.decodeFunctionResult("execute", raw);
          requireThat(execIface.encodeFunctionResult("execute", decoded).toLowerCase() === raw.toLowerCase(), "EXECUTION_ABI_INVALID");
          profit = uint(decoded[0]); requireThat(profit >= candidatePlan.minProfit, "SIMULATED_PROFIT_BELOW_MIN");
          fees = guard.buildFees(await pinned.estimateGas(call), pinned.pin.baseFeePerGas, caps);
          if (candidatePlan.debtAsset === WETH) requireThat(candidatePlan.minProfit > fees.gasLimit * fees.maxFeePerGas, "PROFIT_FLOOR_BELOW_GAS_BUDGET");
          plan = candidatePlan; data = candidateData; break;
        } catch (error) {
          pinned.assertUsable(); lastError = error;
        }
      }
      if (!plan) {
        preflightFailures.push({ targetId: template.id, reason: safeError(lastError) }); continue;
      }
      const validate = async () => {
        validateAuthorization(loadBatch(), now()); await pinned.recheck();
        requireThat(BigInt(Math.floor(now() / 1000)) < plan.deadline, "PLAN_EXPIRED"); return validateAuthorization(loadBatch(), now());
      };
      const receipt = await guard.executeGuarded({ ...executionOptions, now, account: MAIN_ACCOUNT,
        intent: { targetId: plan.id, to: DEPLOYED_EXECUTOR, profitToken: plan.debtAsset, pinHash: pinned.pin.hash,
          simulatedProfitBeforeGasRaw: profit.toString(), minProfitBeforeGasRaw: plan.minProfit.toString() },
        prepare: async () => { await validate(); const nonce = Number(uint(await pinned.nonce(MAIN_ACCOUNT)));
          return { transaction: { type: 2, chainId: 1, nonce, to: DEPLOYED_EXECUTOR, data, value: 0n, ...fees }, caps: validateAuthorization(loadBatch(), now()) }; },
        validate, signTransaction, sendRawTransaction, receiptRpc: (hash, timeoutMs) => pinned.receipt(hash, timeoutMs) });
      const out = { ...snapshot, armed: !["PREPARED", "SENT", "UNCERTAIN"].includes(receipt.stage), execution: receipt };
      if (writeOut) atomicJson(statusFile, out); return out;
    }
    const out = { ...snapshot, armed: false, reason: "NO_FIRED_TARGET_PASSED_PREFLIGHT", preflightFailures };
    if (writeOut) atomicJson(statusFile, out); return out;
  } catch (error) {
    let keepPrev = false;
    if (argv.includes("--loop") && writeOut && fs.existsSync(statusFile)) {
      try {
        const prev = JSON.parse(fs.readFileSync(statusFile, "utf8"));
        if (prev?.ok === true && now() - Date.parse(prev.checkedAt) <= 600000) keepPrev = true;
      } catch (_) {}
    }
    if (writeOut && !keepPrev) atomicJson(statusFile, { ok: false, armed: false, mode: "BLOCKED", checkedAt: new Date(now()).toISOString(), reason: safeError(error) });
    throw error;
  }
}
function shouldImmediateFollowUp(summary) {
  return Boolean(summary?.execution?.stage === "RECEIPT_VERIFIED" && summary?.armed === true);
}
function computeEthPollIntervalMs(summary, baseIntervalMs) {
  if (shouldImmediateFollowUp(summary)) return 0;
  const near = Object.values(summary?.targets || {}).flat()
    .some(t => Number(t?.bpsToLiquidation) <= 5.0);
  return near ? Math.min(baseIntervalMs, 6000) : baseIntervalMs;
}
async function main(argv = process.argv.slice(2), dependencies = {}) {
  if (argv.includes("--target1-v2")) {
    const result = await require("./lib/rank1-aave-v4-runner.js").main(argv, dependencies);
    if (require.main === module) process.exitCode = result.exitCode;
    return result;
  }
  const { execute, writeOut } = guard.parseMode(argv, "--execute-if-liquidatable"), loop = argv.includes("--loop");
  const interval = Math.max(6000, Number(argv.find(a => a.startsWith("--interval-ms="))?.split("=")[1]) || 12000);
  const secondarySendRawTransaction = signed => httpRpc({ handle: "https://rpc.flashbots.net/fast" }, "eth_sendRawTransaction", [signed], 3500);
  do {
    let out;
    try {
      const batch = JSON.parse(fs.readFileSync(BUNDLE, "utf8")); if (execute) validateAuthorization(batch, Date.now());
      const execIface = new Interface(JSON.parse(fs.readFileSync(COMPILED, "utf8")).abi);
      const pinned = await createPinnedRpc({ candidates: loadRpcCandidates(), rpc: httpRpc });
      out = await runOnce({ execute, argv, writeOut, pinned, execIface, batch, loadBatch: () => JSON.parse(fs.readFileSync(BUNDLE, "utf8")), secondarySendRawTransaction }); console.log(JSON.stringify(out));
    } catch (error) {
      out = { ok: false, armed: false, mode: "BLOCKED", checkedAt: new Date().toISOString(), reason: safeError(error) };
      let keepPrev = false;
      if (loop && writeOut && fs.existsSync(STATUS_FILE)) {
        try {
          const prev = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
          if (prev?.ok === true && Date.now() - Date.parse(prev.checkedAt) <= 600000) keepPrev = true;
        } catch (_) {}
      }
      if (writeOut && !keepPrev) atomicJson(STATUS_FILE, out); console.log(JSON.stringify(out)); if (!loop) process.exitCode = 1;
    }
    if (loop) {
      const pollIntervalMs = computeEthPollIntervalMs(out, interval);
      if (pollIntervalMs > 0) await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  } while (loop); // Receipt completion never exits the monitoring loop; pending journals still block signing.
}
if (require.main === module) main().catch(error => {
  const rank1 = process.argv.includes("--target1-v2"), code = safeError(error);
  const identity = rank1 ? require("./lib/rank1-aave-v4-proof.js").TARGET : null;
  console.error(JSON.stringify(rank1 ? { ok: false, armed: false, proofReady: false, executionReady: false, scheduled: false, terminal: true,
    checkedAt: new Date().toISOString(), targetId: "target1_AaveV4_USDe_USDC", collectionScope: "RANK1_ONLY", mode: "HOLD",
    borrower: identity.borrower, spoke: identity.spoke, owner: identity.owner, deployedExecutor: identity.executor,
    reason: /^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? code : "EXECUTION_FAILED" } : { ok: false, armed: false, reason: code }));
  process.exitCode = rank1 ? 2 : 1;
});
module.exports = { TARGET_PLANS, REQUIRED_TARGETS, DEPLOYED_EXECUTOR, MULTICALL_IFACE, validateAuthorization, buildPlanVariants, readHealthBatch, runOnce, shouldImmediateFollowUp, computeEthPollIntervalMs, main };
