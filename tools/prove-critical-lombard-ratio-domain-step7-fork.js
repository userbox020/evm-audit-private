#!/usr/bin/env node
"use strict";

// Defensive local-fork proof only. Uses an impersonated ephemeral address, no key and no broadcast.
// The exact proof calldata is already-public transaction data retained by the Step-7 scanner.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const STEM = "critical-lombard-ratio-domain-step7";
const RAW = path.join(ROOT, `reports/raw/fast/${STEM}.json`);
const CALLDATA = path.join(ROOT, `reports/raw/fast/${STEM}.public-calldata.json`);
const OUT = path.join(ROOT, `reports/raw/fast/${STEM}.fork.json`);
const EPHEMERAL = "0x000000000000000000000000000000000000bEEF";
const ORACLE = "0x1De9fcfeDF3E51266c188ee422fbA1c7860DA0eF";
const LBTC = "0x8236a87084f8B84306f72007F36F2618A5634494";
const CAPPED = "0x503Ef5B869b3f32D407c7816710f87b1D686C103";
const GENERICS = [
  ["LBTC/USDC", "0x5036F1a5c81624A85FBfCfDf5ad2F97f27594801"],
  ["LBTC/USDT", "0x3c868698e83F595CbAB6F9C2463a6494aE6D8C30"],
  ["LBTC/GHO", "0x40Ce87bBaE34D95717Aac2Bc8cA8F936C0d32aa5"],
];
const VAULTS = [
  ["LBTC/USDC", "0x9714427bd5A212EF6779EF46577771A39F55fA3D"],
  ["LBTC/USDT", "0x9f64b16071387bcFD63A1EA7a518e22597575F14"],
  ["LBTC/GHO", "0x6388eEFD6b462662Ac295D7B436cbCa8651BEAf4"],
];

const ORACLE_IFACE = new ethers.Interface([
  "function ratio() view returns (uint256)", "function nextRatio() view returns (uint256,uint256)", "function getRate() view returns (uint256)",
  "event Oracle_RatioChanged(uint256 prevVal,uint256 newVal,uint256 switchTime)",
]);
const ERC20 = new ethers.Interface(["function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);
const RATE = new ethers.Interface([
  "function getExchangeRate() view returns (uint256)", "function getExchangeRateOperate() view returns (uint256)", "function getExchangeRateLiquidate() view returns (uint256)",
  "function configPercentDiff() view returns (uint256)", "function isHeartbeatTrigger() view returns (bool)", "function rebalance()",
]);

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function redact(error) { return String(error?.message || error || "unknown").replace(/https?:\/\/\S+/g, "[redacted]").slice(0, 200); }
function assertNoLeak(text) { if (/https?:\/\//i.test(text) || /(?:authorization|x-api-key|api[_-]?key)\s*[:=]/i.test(text)) throw new Error("leak guard"); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function localRpc(port, method, params = [], timeout = 20000) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const response = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal });
    const json = await response.json();
    if (json.error) throw new Error(`${json.error.code}:${json.error.message}`);
    return json.result;
  } finally { clearTimeout(timer); }
}

async function waitReady(port) {
  for (let i = 0; i < 120; i++) {
    try { const id = await localRpc(port, "eth_chainId", [], 1000); if (id === "0x1") return true; } catch {}
    await sleep(250);
  }
  return false;
}

async function waitReceipt(port, txHash) {
  for (let i = 0; i < 80; i++) {
    const receipt = await localRpc(port, "eth_getTransactionReceipt", [txHash]);
    if (receipt) return receipt;
    await sleep(100);
  }
  return null;
}

async function ethCall(port, to, iface, fn, args = []) {
  const raw = await localRpc(port, "eth_call", [{ to, data: iface.encodeFunctionData(fn, args) }, "latest"]);
  return iface.decodeFunctionResult(fn, raw);
}

async function snapshot(port, resolverAddress, resolverIface) {
  const ratio = await ethCall(port, ORACLE, ORACLE_IFACE, "ratio"), next = await ethCall(port, ORACLE, ORACLE_IFACE, "nextRatio"), rate = await ethCall(port, ORACLE, ORACLE_IFACE, "getRate"), supply = await ethCall(port, LBTC, ERC20, "totalSupply"), ephemeralBalance = await ethCall(port, LBTC, ERC20, "balanceOf", [EPHEMERAL]);
  const capped = {};
  for (const fn of ["getExchangeRate", "getExchangeRateOperate", "getExchangeRateLiquidate", "configPercentDiff", "isHeartbeatTrigger"]) {
    try { const v = await ethCall(port, CAPPED, RATE, fn); capped[fn] = typeof v[0] === "boolean" ? v[0] : v[0].toString(); } catch { capped[fn] = null; }
  }
  const generic = [];
  for (const [label, address] of GENERICS) {
    const rates = {};
    for (const fn of ["getExchangeRate", "getExchangeRateOperate", "getExchangeRateLiquidate"]) { try { rates[fn] = (await ethCall(port, address, RATE, fn))[0].toString(); } catch { rates[fn] = null; } }
    generic.push({ label, address, rates });
  }
  const vaults = [];
  for (const [label, address] of VAULTS) {
    try {
      const data = (await ethCall(port, resolverAddress, resolverIface, "getVaultEntireData", [address]))[0], configs = data.configs ?? data[4], totals = data.totalSupplyAndBorrow ?? data[6], limits = data.limitsAndAvailability ?? data[7];
      vaults.push({ label, address, resolved: true, oracle: ethers.getAddress(configs.oracle ?? configs[8]), oraclePriceOperate: (configs.oraclePriceOperate ?? configs[9]).toString(), oraclePriceLiquidate: (configs.oraclePriceLiquidate ?? configs[10]).toString(), totalBorrowRaw: (totals.totalBorrowVault ?? totals[1]).toString(), borrowableRaw: (limits.borrowable ?? limits[5]).toString() });
    } catch (error) { vaults.push({ label, address, resolved: false, errorClass: redact(error) }); }
  }
  return { oracle: { ratio: ratio[0].toString(), nextRatio: next[0].toString(), switchTime: next[1].toString(), getRate: rate[0].toString() }, lbtc: { totalSupply: supply[0].toString(), ephemeralBalance: ephemeralBalance[0].toString() }, capped, generic, vaults };
}

function compare(before, after) {
  const generic = before.generic.map((x, i) => ({ label: x.label, operateBefore: x.rates.getExchangeRateOperate, operateAfter: after.generic[i].rates.getExchangeRateOperate, changed: x.rates.getExchangeRateOperate !== after.generic[i].rates.getExchangeRateOperate }));
  const vaults = before.vaults.map((x, i) => ({ label: x.label, operateBefore: x.oraclePriceOperate ?? null, operateAfter: after.vaults[i]?.oraclePriceOperate ?? null, changed: x.oraclePriceOperate !== after.vaults[i]?.oraclePriceOperate }));
  return {
    oracleRatioChanged: before.oracle.ratio !== after.oracle.ratio,
    oracleRateChanged: before.oracle.getRate !== after.oracle.getRate,
    lbtcSupplyChanged: before.lbtc.totalSupply !== after.lbtc.totalSupply,
    ephemeralLbtcBalanceChanged: before.lbtc.ephemeralBalance !== after.lbtc.ephemeralBalance,
    cappedOperateChanged: before.capped.getExchangeRateOperate !== after.capped.getExchangeRateOperate,
    cappedLiquidateChanged: before.capped.getExchangeRateLiquidate !== after.capped.getExchangeRateLiquidate,
    generic,
    vaults,
    genericConsumerDeltaPositive: generic.some((x) => x.changed),
    vaultConsumerDeltaPositive: vaults.some((x) => x.changed),
  };
}

async function main() {
  const raw = readJson(RAW), fixtures = readJson(CALLDATA);
  const candidates = raw.compatibility.windows.filter((x) => x.exploitableTimingCandidate).sort((a, b) => b.destinationPreBlock - a.destinationPreBlock || b.effectiveTimingWindowSeconds - a.effectiveTimingWindowSeconds);
  if (!candidates.length) throw new Error("fork gate closed: no effective compatibility window");
  const selected = candidates[0], fixture = fixtures.rows.find((x) => x.chainId === 8453 && x.transactionHash === selected.sourceTransactionHash);
  if (!fixture?.input) throw new Error("public calldata fixture unavailable");
  const resolverDeployment = readJson(path.join(ROOT, "targets/fluid-contracts-public/deployments/mainnet/VaultResolver.json"));
  const resolverAddress = ethers.getAddress(resolverDeployment.address), resolverIface = new ethers.Interface(resolverDeployment.abi);
  const upstream = await resolveRpc(1);
  if (!upstream) throw new Error("authorized Ethereum endpoint unavailable");
  const port = 18545 + Math.floor(Math.random() * 1000);
  const child = spawn("anvil", ["--silent", "--fork-url", upstream, "--fork-block-number", String(selected.destinationPreBlock), "--port", String(port), "--chain-id", "1", "--no-rate-limit"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let childOutput = "";
  child.stdout.on("data", (b) => { childOutput += b.toString(); });
  child.stderr.on("data", (b) => { childOutput += b.toString(); });
  try {
    if (!(await waitReady(port))) throw new Error("local fork did not become ready");
    await localRpc(port, "anvil_impersonateAccount", [EPHEMERAL]);
    await localRpc(port, "anvil_setBalance", [EPHEMERAL, "0x8ac7230489e80000"]);
    const before = await snapshot(port, resolverAddress, resolverIface);
    let localStaticAccepted = false, localStaticError = null, estimatedGas = null;
    try {
      const staticResult = await localRpc(port, "eth_call", [{ from: EPHEMERAL, to: ORACLE, data: fixture.input }, "latest"]);
      localStaticAccepted = staticResult !== null;
      estimatedGas = await localRpc(port, "eth_estimateGas", [{ from: EPHEMERAL, to: ORACLE, data: fixture.input }]);
    } catch (error) { localStaticError = redact(error); }
    const txHash = await localRpc(port, "eth_sendTransaction", [{ from: EPHEMERAL, to: ORACLE, data: fixture.input, gas: "0x7a1200" }]);
    const receipt = await waitReceipt(port, txHash);
    if (!receipt || Number(BigInt(receipt.status)) !== 1) {
      let traceSummary = null;
      try { const trace = await localRpc(port, "debug_traceTransaction", [txHash, { disableMemory: true, disableStack: true, disableStorage: true }]); traceSummary = { failed: trace?.failed ?? null, gas: trace?.gas ?? null, returnValuePrefix: trace?.returnValue ? String(trace.returnValue).slice(0, 18) : null, structLogs: trace?.structLogs?.length ?? null }; } catch (error) { traceSummary = { errorClass: redact(error) }; }
      const failure = { schema: 1, generatedAt: raw.generatedAt, runId: raw.runId, safety: { localForkOnly: true, privateKeyUsed: false, liveBroadcast: false }, justified: true, ran: true, replayAccepted: false, consumerDeltaPositive: null, selectedWindow: { sourceTransactionHash: selected.sourceTransactionHash, destinationTransactionHash: selected.destinationTransactionHash, destinationPreBlock: selected.destinationPreBlock }, localStaticAccepted, localStaticError, estimatedGas, receiptStatus: receipt?.status ? Number(BigInt(receipt.status)) : null, traceSummary, routePositive: 0, executableNow: 0, signedActionJustified: false, reason: "local replay transaction reverted; fork result fail-closed" };
      const failureText = JSON.stringify(failure, null, 2) + "\n"; assertNoLeak(failureText); fs.writeFileSync(OUT, failureText);
      throw new Error(`local replay transaction reverted static=${localStaticAccepted} trace=${JSON.stringify(traceSummary)}`);
    }
    const afterReplay = await snapshot(port, resolverAddress, resolverIface);
    let rebalanceReceipt = null;
    try {
      const rebalanceHash = await localRpc(port, "eth_sendTransaction", [{ from: EPHEMERAL, to: CAPPED, data: RATE.encodeFunctionData("rebalance", []), gas: "0x2dc6c0" }]);
      rebalanceReceipt = await waitReceipt(port, rebalanceHash);
    } catch (error) { rebalanceReceipt = { status: null, errorClass: redact(error) }; }
    const afterRebalance = await snapshot(port, resolverAddress, resolverIface);
    const replayDelta = compare(before, afterReplay), finalDelta = compare(before, afterRebalance);
    const ratioEvents = (receipt.logs || []).filter((x) => String(x.address).toLowerCase() === ORACLE.toLowerCase() && x.topics?.[0]?.toLowerCase() === ORACLE_IFACE.getEvent("Oracle_RatioChanged").topicHash.toLowerCase()).map((x) => { const d = ORACLE_IFACE.decodeEventLog("Oracle_RatioChanged", x.data, x.topics); return { prevVal: d.prevVal.toString(), newVal: d.newVal.toString(), switchTime: d.switchTime.toString() }; });
    const out = {
      schema: 1,
      generatedAt: raw.generatedAt,
      runId: raw.runId,
      safety: { localForkOnly: true, ephemeralImpersonatedAccount: true, privateKeyUsed: false, keyFileRead: false, signedTransaction: false, liveBroadcast: false, upstreamMutation: false, publicCalldataOnly: true, childOutputPersisted: false },
      justified: true,
      ran: true,
      reason: "covered Base proof passed Ethereum historical proof and oracle guards and had an effective post-switchTime pre-publication window",
      selectedWindow: { sourceChainId: selected.sourceChainId, destinationChainId: selected.destinationChainId, sourceTransactionHash: selected.sourceTransactionHash, destinationTransactionHash: selected.destinationTransactionHash, destinationPreBlock: selected.destinationPreBlock, submissionLeadSeconds: selected.submissionLeadSeconds, effectiveTimingWindowSeconds: selected.effectiveTimingWindowSeconds, samePayloadHash: selected.samePayloadHash, sameProofHash: selected.sameProofHash },
      fixtureBinding: { inputHash: fixture.inputHash, inputBytes: fixture.inputBytes, publicDataClass: fixture.dataClass },
      localTransactions: { replayStatus: Number(BigInt(receipt.status)), replayGasUsed: BigInt(receipt.gasUsed).toString(), ratioEvents, rebalanceStatus: rebalanceReceipt?.status ? Number(BigInt(rebalanceReceipt.status)) : null, rebalanceGasUsed: rebalanceReceipt?.gasUsed ? BigInt(rebalanceReceipt.gasUsed).toString() : null },
      localPreflight: { staticAccepted: localStaticAccepted, staticError: localStaticError, estimatedGas: estimatedGas ? BigInt(estimatedGas).toString() : null },
      before,
      afterReplay,
      afterRebalance,
      replayDelta,
      finalDelta,
      replayAccepted: true,
      scope: "t1ControlFork",
      oracleStateDeltaPositive: replayDelta.oracleRatioChanged && replayDelta.oracleRateChanged,
      lbtcAccountingSupplyDelta: replayDelta.lbtcSupplyChanged,
      directCappedRateDeltaPositive: finalDelta.cappedOperateChanged || finalDelta.cappedLiquidateChanged,
      t1ControlFork: {
        genericLendingOracleDeltaPositive: finalDelta.genericConsumerDeltaPositive,
        t1VaultResolverConsumerDeltaPositive: finalDelta.vaultConsumerDeltaPositive,
        consumerDeltaPositive: finalDelta.genericConsumerDeltaPositive || finalDelta.vaultConsumerDeltaPositive,
        reason: "T1 generic lending and T1 VaultResolver control prices did not change; this scope excludes direct Fluid T2 vaults.",
      },
      permissionlessExtractionProven: false,
      exactPositiveEconomics: null,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      childOutputSha256InMemoryOnly: sha256(childOutput),
      blockers: [
        finalDelta.genericConsumerDeltaPositive ? null : "T1 LBTC/USDC, LBTC/USDT and LBTC/GHO generic lending oracle rates did not change.",
        finalDelta.vaultConsumerDeltaPositive ? null : "T1 VaultResolver accepted prices did not change; direct T2 vault evidence is recorded separately.",
        replayDelta.lbtcSupplyChanged ? null : "LBTC total supply and the ephemeral account LBTC balance were unchanged.",
        "No permissionless borrow or liquidation value extraction was demonstrated; economics remain gated off.",
      ].filter(Boolean),
    };
    const text = JSON.stringify(out, null, 2) + "\n"; assertNoLeak(text); fs.writeFileSync(OUT, text);
    process.stdout.write(`forkBlock=${selected.destinationPreBlock} replayAccepted=${out.replayAccepted} oracleDelta=${out.oracleStateDeltaPositive} cappedDelta=${out.directCappedRateDeltaPositive} t1GenericDelta=${out.t1ControlFork.genericLendingOracleDeltaPositive} t1VaultDelta=${out.t1ControlFork.t1VaultResolverConsumerDeltaPositive} routePositive=0\n`);
  } finally {
    try { await localRpc(port, "anvil_stopImpersonatingAccount", [EPHEMERAL], 1000); } catch {}
    child.kill();
  }
}

main().catch((error) => { process.stderr.write(`fork proof failed: ${redact(error)}\n`); process.exitCode = 1; });
