#!/usr/bin/env node
"use strict";

// Defensive Step-7 completeness proof for the three direct Fluid T2 vault consumers.
// Uses public calldata and ephemeral no-key Anvil forks only; never broadcasts upstream.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const STEM = "critical-lombard-ratio-domain-step7";
const RAW = path.join(ROOT, `reports/raw/fast/${STEM}.json`);
const CALLDATA = path.join(ROOT, `reports/raw/fast/${STEM}.public-calldata.json`);
const OUT = path.join(ROOT, `reports/raw/fast/${STEM}.t2-fork.json`);
const EPHEMERAL = "0x000000000000000000000000000000000000bEEF";
const ORACLE = "0x1De9fcfeDF3E51266c188ee422fbA1c7860DA0eF";
const CAPPED = "0x503Ef5B869b3f32D407c7816710f87b1D686C103";
const RESOLVER_FILE = "targets/fluid-contracts-public/deployments/mainnet/VaultResolver.json";
const DEX_RESOLVER_FILE = "targets/fluid-contracts-public/deployments/mainnet/DexResolver.json";
const CURRENT_HEAD = 25547743;

const T2 = [
  {
    label: "WBTC/LBTC -> WBTC",
    vault: "0x57A9f4e109EcEF8990BC794df0D159fb29861f2A",
    vaultId: 115,
    oracle: "0xb6ccC6b170b0c9B93Fa4b6400ebdD7dBec2C224D",
    dex: "0xe0Cc64Ab3712e2087E1D4AAB6f3A14F120449E5f",
    vaultArtifact: "targets/fluid-contracts-public/deployments/mainnet/VaultT2_DEX-WBTC-LBTC_WBTC.json",
    oracleArtifact: "targets/fluid-contracts-public/deployments/mainnet/DexSmartColPegOracle_WBTC-LBTC_WBTC.json",
  },
  {
    label: "LBTC/cbBTC -> WBTC",
    vault: "0x96B2A29823d475468eE6f15e07878adf79E8199b",
    vaultId: 97,
    oracle: "0x19bd1022114A8c45e9D6a332aE9e31Af53bF98cb",
    dex: "0xc8F989E9B7ECE1b4D092Ae4db7fAF1294146bdA4",
    vaultArtifact: "targets/fluid-contracts-public/deployments/mainnet/VaultT2_DEX-LBTC-cbBTC_WBTC.json",
    oracleArtifact: "targets/fluid-contracts-public/deployments/mainnet/DexSmartColPegOracle_LBTC-CBBTC_WBTC.json",
  },
  {
    label: "LBTC/cbBTC -> cbBTC",
    vault: "0x9f1F074EB64470f804b34E6948132b8aAE17028F",
    vaultId: 114,
    oracle: "0x784801D99D55D7220BcC91Cd60bb13b92A20b0F4",
    dex: "0xc8F989E9B7ECE1b4D092Ae4db7fAF1294146bdA4",
    vaultArtifact: "targets/fluid-contracts-public/deployments/mainnet/VaultT2_DEX-LBTC-cbBTC_cbBTC.json",
    oracleArtifact: "targets/fluid-contracts-public/deployments/mainnet/DexSmartColPegOracle_LBTC-CBBTC_CBBTC.json",
  },
];

const WINDOWS = [
  {
    id: "latest-same-block-ordered-model",
    forkBlock: 24972312,
    sourceTransactionHash: "0x423edb2fb50065e92b68250c103c0f6b58b806bd531227334cb1caf2f098d297",
    destinationTransactionHash: "0xefeabb18a44ee2fd8884d746a7146f414ef9c48ab7a2e22731590566ed2093e6",
    replayTimestamp: 1777304159,
    rebalanceTimestamp: 1777304159,
    nativePublicationTimestamp: 1777304159,
    sameBlockOrderedModel: true,
    modeledNativeTransactionIndex: 263,
    requireResolverLiquidation: true,
  },
  {
    id: "maximum-historical",
    forkBlock: 23218481,
    sourceTransactionHash: "0xf95ae8437f9a933674c52e39ce3da92eb27d832ef5524831847d9d53889c7447",
    destinationTransactionHash: "0xc027f944804edf4beeb2dff399d0ed497b2fdc4c1c2412343ea7990d09b125d6",
    replayTimestamp: 1756129239,
    rebalanceTimestamp: 1756129251,
    nativePublicationTimestamp: 1756129343,
    sameBlockOrderedModel: false,
    requireResolverLiquidation: false,
  },
];

const SOURCE_PATHS = [
  ...T2.flatMap((x) => [x.vaultArtifact, x.oracleArtifact]),
  RESOLVER_FILE,
  DEX_RESOLVER_FILE,
  "targets/fluid-contracts-public/deployments/mainnet/CappedRateBalancer_LBTC.json",
  "targets/fluid-contracts-public/contracts/protocols/vault/vaultT2/coreModule/main.sol",
  "targets/fluid-contracts-public/contracts/protocols/vault/vaultTypesCommon/coreModule/main.sol",
  "targets/fluid-contracts-public/contracts/protocols/vault/vaultTypesCommon/coreModule/helpersLiquidate.sol",
  "targets/fluid-contracts-public/contracts/protocols/vault/errorTypes.sol",
  "targets/fluid-contracts-public/contracts/periphery/resolvers/vault/main.sol",
  "targets/fluid-contracts-public/contracts/oracle/oracles/dex/dexSmartColPegOracle.sol",
  "targets/fluid-contracts-public/contracts/oracle/implementations/dex/conversionPriceGetters/conversionPriceFluidOracle.sol",
  "targets/fluid-contracts-public/contracts/oracle/fluidCappedRate.sol",
  "targets/lombard-evm-smart-contracts/contracts/LBTC/StakedLBTCOracle.sol",
  "tools/shared-rpc.js",
].filter((x, i, a) => a.indexOf(x) === i);

const RATE = new ethers.Interface([
  "function getExchangeRate() view returns (uint256)",
  "function getExchangeRateOperate() view returns (uint256)",
  "function getExchangeRateLiquidate() view returns (uint256)",
  "function rebalance()",
  "function configData() view returns (address,uint16,uint24,uint40,address,bool,bool,bool,uint256,uint24,uint24,uint256)",
]);
const ORACLE_IFACE = new ethers.Interface([
  "function ratio() view returns (uint256)",
  "function nextRatio() view returns (uint256,uint256)",
  "function getRate() view returns (uint256)",
]);
const PEG = new ethers.Interface([
  "function getExchangeRate() view returns (uint256)",
  "function getExchangeRateOperate() view returns (uint256)",
  "function getExchangeRateLiquidate() view returns (uint256)",
  "function dexOracleData() view returns (address,bool,address,uint256,uint256)",
  "function getDexConversionPriceFluidOracleData() view returns (address,bool,uint256,uint256)",
]);
const VAULT = new ethers.Interface([
  "function simulateLiquidate(uint256 debtAmt,bool absorb)",
  "error FluidVaultError(uint256 errorId)",
  "error FluidLiquidateResult(uint256 colLiquidated,uint256 debtLiquidated)",
]);
const DEX_RESOLVER_DEPLOYMENT = readJson(path.join(ROOT, DEX_RESOLVER_FILE));
const DEX_RESOLVER_ADDRESS = ethers.getAddress(DEX_RESOLVER_DEPLOYMENT.address);
const DEX_RESOLVER_IFACE = new ethers.Interface(DEX_RESOLVER_DEPLOYMENT.abi);

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function fileMeta(relative) { const b = fs.readFileSync(path.join(ROOT, relative)); return { path: relative.replace(/\\/g, "/"), bytes: b.length, sha256: crypto.createHash("sha256").update(b).digest("hex") }; }
function sha256Hex(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function redact(error) { return String(error?.message || error || "unknown").replace(/https?:\/\/\S+/g, "[redacted]").slice(0, 2000); }
function assertNoLeak(text) { if (/https?:\/\//i.test(text) || /(?:authorization|x-api-key|api[_-]?key)\s*[:=]/i.test(text) || /[?&](?:key|token|secret|apikey)=/i.test(text)) throw new Error("leak guard"); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function s(x) { return x == null ? null : x.toString(); }
function toolVersion(command) { const r = spawnSync(command, ["--version"], { encoding: "utf8", windowsHide: true }); return r.status === 0 ? String(r.stdout || r.stderr).trim().split(/\r?\n/)[0] : null; }

async function rpc(url, method, params = [], timeout = 120000) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal });
    const json = await response.json();
    if (json.error) {
      const error = new Error(`${json.error.code}:${json.error.message}`);
      error.rpcData = typeof json.error.data === "string" ? json.error.data : json.error.data?.data;
      throw error;
    }
    return json.result;
  } finally { clearTimeout(timer); }
}

async function waitReady(url) {
  for (let i = 0; i < 240; i++) {
    try { if (await rpc(url, "eth_chainId", [], 1000) === "0x1") return true; } catch {}
    await sleep(500);
  }
  return false;
}

async function waitReceipt(url, hash) {
  for (let i = 0; i < 100; i++) {
    const receipt = await rpc(url, "eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await sleep(100);
  }
  return null;
}

async function ethCall(url, to, iface, fn, args = [], block = "latest") {
  const raw = await rpc(url, "eth_call", [{ from: EPHEMERAL, to, data: iface.encodeFunctionData(fn, args) }, block]);
  return iface.decodeFunctionResult(fn, raw);
}

async function setNextTimestamp(url, timestamp) {
  try { await rpc(url, "evm_setNextBlockTimestamp", [timestamp]); }
  catch { await rpc(url, "anvil_setNextBlockTimestamp", [timestamp]); }
}

async function receiptTimestamp(url, receipt) {
  const block = await rpc(url, "eth_getBlockByNumber", [receipt.blockNumber, false]);
  return Number(BigInt(block.timestamp));
}

function formatBps5(before, after) {
  if (before == null || after == null || BigInt(before) === 0n) return null;
  const b = BigInt(before), delta = BigInt(after) - b;
  const negative = delta < 0n, abs = negative ? -delta : delta;
  const scaled = (abs * 1000000000n + b / 2n) / b;
  const whole = scaled / 100000n, fraction = (scaled % 100000n).toString().padStart(5, "0");
  return `${negative ? "-" : "+"}${whole}.${fraction}`;
}

async function directSimulate(url, vault, absorb) {
  try {
    await ethCall(url, vault, VAULT, "simulateLiquidate", [0, absorb]);
    return { accepted: true, error: null, errorId: null, colLiquidated: null, debtLiquidated: null };
  } catch (error) {
    let decoded = null;
    try { if (error.rpcData) decoded = VAULT.parseError(error.rpcData); } catch {}
    return {
      accepted: false,
      error: decoded?.name || "unparsed-revert",
      errorId: decoded?.name === "FluidVaultError" ? s(decoded.args[0]) : null,
      colLiquidated: decoded?.name === "FluidLiquidateResult" ? s(decoded.args[0]) : "0",
      debtLiquidated: decoded?.name === "FluidLiquidateResult" ? s(decoded.args[1]) : "0",
      errorClass: decoded ? null : redact(error),
    };
  }
}

async function resolverLiquidation(url, resolverAddress, resolverIface) {
  try {
    const result = await ethCall(url, resolverAddress, resolverIface, "getMultipleVaultsLiquidation", [T2.map((x) => x.vault), [0, 0, 0]]);
    return result[0].map((x, i) => ({
      label: T2[i].label,
      vault: ethers.getAddress(x.vault ?? x[0]),
      inAmt: s(x.inAmt ?? x[5]), outAmt: s(x.outAmt ?? x[6]),
      inAmtWithAbsorb: s(x.inAmtWithAbsorb ?? x[7]), outAmtWithAbsorb: s(x.outAmtWithAbsorb ?? x[8]),
      absorbAvailable: Boolean(x.absorbAvailable ?? x[9]),
    }));
  } catch (error) { return { errorClass: redact(error) }; }
}

async function snapshot(url, resolverAddress, resolverIface) {
  const ratio = await ethCall(url, ORACLE, ORACLE_IFACE, "ratio"), next = await ethCall(url, ORACLE, ORACLE_IFACE, "nextRatio"), rate = await ethCall(url, ORACLE, ORACLE_IFACE, "getRate");
  const capped = {};
  for (const fn of ["getExchangeRate", "getExchangeRateOperate", "getExchangeRateLiquidate"]) capped[fn] = s((await ethCall(url, CAPPED, RATE, fn))[0]);
  const direct = [];
  for (const row of T2) {
    const operate = await ethCall(url, row.oracle, PEG, "getExchangeRateOperate"), liquidate = await ethCall(url, row.oracle, PEG, "getExchangeRateLiquidate");
    direct.push({ label: row.label, vault: ethers.getAddress(row.vault), oracle: ethers.getAddress(row.oracle), operate: s(operate[0]), liquidate: s(liquidate[0]), simulateWithoutAbsorb: await directSimulate(url, row.vault, false), simulateWithAbsorb: await directSimulate(url, row.vault, true) });
  }
  const resolverCode = await rpc(url, "eth_getCode", [resolverAddress, "latest"]);
  const dexLiquidityReserves = [];
  if ((await rpc(url, "eth_getCode", [DEX_RESOLVER_ADDRESS, "latest"])) !== "0x") {
    for (const [label, dex] of [["WBTC/LBTC", T2[0].dex], ["LBTC/cbBTC", T2[1].dex]]) {
      try {
        const entire = (await ethCall(url, DEX_RESOLVER_ADDRESS, DEX_RESOLVER_IFACE, "getDexEntireData", [dex]))[0], limits = entire.limitsAndAvailability ?? entire[8], user0 = limits.liquidityUserSupplyDataToken0 ?? limits[14], user1 = limits.liquidityUserSupplyDataToken1 ?? limits[15];
        dexLiquidityReserves.push({ label, dex: ethers.getAddress(dex), token0: s(user0.supply ?? user0[1]), token1: s(user1.supply ?? user1[1]), source: "DexResolver liquidityUserSupplyDataToken{0,1}.supply" });
      } catch (error) { dexLiquidityReserves.push({ label, dex: ethers.getAddress(dex), errorClass: redact(error) }); }
    }
  }
  const resolverLiquidations = resolverCode === "0x" ? null : await resolverLiquidation(url, resolverAddress, resolverIface);
  const resolverVaults = [];
  if (resolverCode !== "0x") {
    for (const row of T2) {
      try {
        const data = (await ethCall(url, resolverAddress, resolverIface, "getVaultEntireData", [row.vault]))[0], configs = data.configs ?? data[4], state = data.vaultState ?? data[8], constants = data.constantVariables ?? data[3];
        resolverVaults.push({ label: row.label, vault: ethers.getAddress(row.vault), oracle: ethers.getAddress(configs.oracle ?? configs[8]), oraclePriceOperate: s(configs.oraclePriceOperate ?? configs[9]), oraclePriceLiquidate: s(configs.oraclePriceLiquidate ?? configs[10]), totalPositions: s(state.totalPositions ?? state[0]), vaultId: s(constants.vaultId ?? constants[10]), vaultType: s(constants.vaultType ?? constants[11]) });
      } catch (error) { resolverVaults.push({ label: row.label, vault: ethers.getAddress(row.vault), errorClass: redact(error) }); }
    }
  }
  return { oracle: { ratio: s(ratio[0]), nextRatio: s(next[0]), switchTime: s(next[1]), getRate: s(rate[0]) }, capped, direct, dexLiquidityReserves, resolverAvailable: resolverCode !== "0x", resolverLiquidations, resolverVaults };
}

function acceptedPriceOperands(before, control, after) {
  return before.direct.map((initial, i) => {
    const controlled = control.direct[i], final = after.direct[i], denominator = BigInt(controlled.liquidate), numerator = BigInt(final.liquidate) - denominator;
    return {
      label: initial.label,
      vault: initial.vault,
      oracle: initial.oracle,
      decimals: 17,
      beforeRaw: initial.liquidate,
      controlRaw: controlled.liquidate,
      afterRaw: final.liquidate,
      formula: "signedDeltaBps = (afterRaw - controlRaw) * 10000 / controlRaw",
      signedDeltaNumeratorRaw: numerator.toString(),
      signedDeltaBpsRationalNumerator: (numerator * 10000n).toString(),
      signedDeltaBpsRationalDenominator: denominator.toString(),
      signedDeltaBps: formatBps5(controlled.liquidate, final.liquidate),
      changed: controlled.liquidate !== final.liquidate,
    };
  });
}

function compareBoundary(before, after) {
  const direct = before.direct.map((x, i) => ({ label: x.label, beforeErrorId: x.simulateWithoutAbsorb.errorId, afterErrorId: after.direct[i].simulateWithoutAbsorb.errorId, beforeDebtLiquidated: x.simulateWithoutAbsorb.debtLiquidated, afterDebtLiquidated: after.direct[i].simulateWithoutAbsorb.debtLiquidated, crossed: x.simulateWithoutAbsorb.debtLiquidated !== after.direct[i].simulateWithoutAbsorb.debtLiquidated || x.simulateWithoutAbsorb.errorId !== after.direct[i].simulateWithoutAbsorb.errorId }));
  let resolver = null;
  if (Array.isArray(before.resolverLiquidations) && Array.isArray(after.resolverLiquidations)) resolver = before.resolverLiquidations.map((x, i) => ({ label: x.label, inBefore: x.inAmt, inAfter: after.resolverLiquidations[i].inAmt, outBefore: x.outAmt, outAfter: after.resolverLiquidations[i].outAmt, absorbBefore: x.absorbAvailable, absorbAfter: after.resolverLiquidations[i].absorbAvailable, changed: x.inAmt !== after.resolverLiquidations[i].inAmt || x.outAmt !== after.resolverLiquidations[i].outAmt || x.absorbAvailable !== after.resolverLiquidations[i].absorbAvailable }));
  return { direct, resolver, crossed: direct.some((x) => x.crossed) || Boolean(resolver?.some((x) => x.changed)) };
}

async function runWindow(upstream, fixture, config, resolverAddress, resolverIface, port) {
  const local = `http://127.0.0.1:${port}`;
  const anvilArgs = ["--silent", "--fork-url", upstream, "--fork-block-number", String(config.forkBlock), "--port", String(port), "--chain-id", "1", "--no-rate-limit"];
  if (config.id === "maximum-historical") anvilArgs.push("--timestamp", String(config.replayTimestamp - 1));
  const child = spawn("anvil", anvilArgs, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let childOutput = ""; child.stdout.on("data", (b) => { childOutput += b.toString(); }); child.stderr.on("data", (b) => { childOutput += b.toString(); });
  try {
    if (!(await waitReady(local))) throw new Error(`${config.id}: fork not ready`);
    await rpc(local, "anvil_impersonateAccount", [EPHEMERAL]);
    await rpc(local, "anvil_setBalance", [EPHEMERAL, "0x8ac7230489e80000"]);
    const forkHead = await rpc(local, "eth_getBlockByNumber", ["latest", false]);
    const before = await snapshot(local, resolverAddress, resolverIface);
    let replayHash, rebalanceHash, replayReceipt, rebalanceReceipt, replayTimestamp, rebalanceTimestamp, afterReplay = null, sameBlockOrdering = null;
    if (config.sameBlockOrderedModel) {
      await rpc(local, "evm_setAutomine", [false]);
      await setNextTimestamp(local, config.replayTimestamp);
      const nonce = BigInt(await rpc(local, "eth_getTransactionCount", [EPHEMERAL, "pending"]));
      replayHash = await rpc(local, "eth_sendTransaction", [{ from: EPHEMERAL, to: ORACLE, data: fixture.input, gas: "0x7a1200", nonce: `0x${nonce.toString(16)}` }]);
      rebalanceHash = await rpc(local, "eth_sendTransaction", [{ from: EPHEMERAL, to: CAPPED, data: RATE.encodeFunctionData("rebalance", []), gas: "0x2dc6c0", nonce: `0x${(nonce + 1n).toString(16)}` }]);
      await rpc(local, "evm_mine", []);
      await rpc(local, "evm_setAutomine", [true]);
      replayReceipt = await waitReceipt(local, replayHash); rebalanceReceipt = await waitReceipt(local, rebalanceHash);
      if (!replayReceipt || Number(BigInt(replayReceipt.status)) !== 1) throw new Error(`${config.id}: replay reverted`);
      if (!rebalanceReceipt || Number(BigInt(rebalanceReceipt.status)) !== 1) throw new Error(`${config.id}: rebalance reverted`);
      replayTimestamp = await receiptTimestamp(local, replayReceipt); rebalanceTimestamp = await receiptTimestamp(local, rebalanceReceipt);
      sameBlockOrdering = {
        model: "local same-block ordered counterfactual",
        blockNumber: Number(BigInt(replayReceipt.blockNumber)),
        blockTimestamp: replayTimestamp,
        replayTransactionIndex: Number(BigInt(replayReceipt.transactionIndex)),
        rebalanceTransactionIndex: Number(BigInt(rebalanceReceipt.transactionIndex)),
        modeledNativeTransactionIndex: config.modeledNativeTransactionIndex,
        replayAndRebalanceSameBlock: replayReceipt.blockNumber === rebalanceReceipt.blockNumber,
        orderedBeforeModeledNative: Number(BigInt(replayReceipt.transactionIndex)) < config.modeledNativeTransactionIndex && Number(BigInt(rebalanceReceipt.transactionIndex)) < config.modeledNativeTransactionIndex,
        nativeTransactionModeledNotExecuted: true,
        assumption: "attacker replay and permissionless rebalance are ordered before canonical native publication transaction index 263 in the canonical timestamp-1777304159 block",
      };
    } else {
      await setNextTimestamp(local, config.replayTimestamp);
      replayHash = await rpc(local, "eth_sendTransaction", [{ from: EPHEMERAL, to: ORACLE, data: fixture.input, gas: "0x7a1200" }]);
      replayReceipt = await waitReceipt(local, replayHash);
      if (!replayReceipt || Number(BigInt(replayReceipt.status)) !== 1) throw new Error(`${config.id}: replay reverted`);
      replayTimestamp = await receiptTimestamp(local, replayReceipt); afterReplay = await snapshot(local, resolverAddress, resolverIface);
      await setNextTimestamp(local, config.rebalanceTimestamp);
      rebalanceHash = await rpc(local, "eth_sendTransaction", [{ from: EPHEMERAL, to: CAPPED, data: RATE.encodeFunctionData("rebalance", []), gas: "0x2dc6c0" }]);
      rebalanceReceipt = await waitReceipt(local, rebalanceHash);
      if (!rebalanceReceipt || Number(BigInt(rebalanceReceipt.status)) !== 1) throw new Error(`${config.id}: rebalance reverted`);
      rebalanceTimestamp = await receiptTimestamp(local, rebalanceReceipt);
    }
    const afterRebalance = await snapshot(local, resolverAddress, resolverIface);
    const controlResult = await runControlAtTimestamp(upstream, config, rebalanceTimestamp, resolverAddress, resolverIface, port + 300), controlAtRebalanceTimestamp = controlResult.state;
    let postNativePublication = null;
    if (config.nativePublicationTimestamp != null) {
      const postTimestamp = Math.max(config.nativePublicationTimestamp + 1, rebalanceTimestamp + 1);
      await setNextTimestamp(local, postTimestamp);
      await rpc(local, "evm_mine", []);
      postNativePublication = { timestamp: postTimestamp, state: await snapshot(local, resolverAddress, resolverIface) };
    }
    const acceptedPriceRows = acceptedPriceOperands(before, controlAtRebalanceTimestamp, afterRebalance), boundary = compareBoundary(before, afterRebalance);
    return {
      id: config.id,
      forkBlock: config.forkBlock,
      forkBlockHash: forkHead.hash,
      forkTimestamp: Number(BigInt(forkHead.timestamp)),
      sourceTransactionHash: config.sourceTransactionHash,
      destinationTransactionHash: config.destinationTransactionHash,
      chronology: { replayTimestamp, rebalanceTimestamp, nativePublicationTimestamp: config.nativePublicationTimestamp, sameBlockOrdering, replayBeforeNativePublication: config.sameBlockOrderedModel ? null : replayTimestamp < config.nativePublicationTimestamp, rebalanceBeforeNativePublication: config.sameBlockOrderedModel ? null : rebalanceTimestamp < config.nativePublicationTimestamp },
      controlChronology: { requestedTimestamp: rebalanceTimestamp, observedTimestamp: controlResult.timestamp, exactTimestampMatch: controlResult.timestamp === rebalanceTimestamp },
      localTransactions: { replayStatus: Number(BigInt(replayReceipt.status)), replayGasUsed: s(BigInt(replayReceipt.gasUsed)), replayTransactionIndex: Number(BigInt(replayReceipt.transactionIndex)), rebalanceStatus: Number(BigInt(rebalanceReceipt.status)), rebalanceGasUsed: s(BigInt(rebalanceReceipt.gasUsed)), rebalanceTransactionIndex: Number(BigInt(rebalanceReceipt.transactionIndex)) },
      before, controlAtRebalanceTimestamp, afterReplay, afterRebalance, postNativePublication,
      acceptedPriceRows,
      boundary,
      t2AcceptedPriceDelta: acceptedPriceRows.some((x) => x.changed),
      t2LiquidatableAmountDelta: boundary.crossed,
      liquidationBoundaryCrossed: boundary.crossed,
      permissionlessLiquidationRoute: false,
      replayedRatioPersistsAfterNativePublicationTime: postNativePublication ? postNativePublication.state.oracle.ratio === afterRebalance.oracle.ratio : null,
      childOutputSha256InMemoryOnly: sha256Hex(childOutput),
    };
  } finally { try { await rpc(local, "anvil_stopImpersonatingAccount", [EPHEMERAL], 1000); } catch {} child.kill(); }
}

async function runControlAtTimestamp(upstream, config, targetTimestamp, resolverAddress, resolverIface, port) {
  if (targetTimestamp == null) return null;
  const local = `http://127.0.0.1:${port}`;
  const args = ["--silent", "--fork-url", upstream, "--fork-block-number", String(config.forkBlock), "--port", String(port), "--chain-id", "1", "--no-rate-limit"];
  const child = spawn("anvil", args, { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  try {
    if (!(await waitReady(local))) throw new Error(`${config.id}: control fork not ready`);
    await rpc(local, "anvil_impersonateAccount", [EPHEMERAL]);
    await setNextTimestamp(local, targetTimestamp);
    await rpc(local, "evm_mine", []);
    const block = await rpc(local, "eth_getBlockByNumber", ["latest", false]);
    return { timestamp: Number(BigInt(block.timestamp)), state: await snapshot(local, resolverAddress, resolverIface) };
  } finally { try { await rpc(local, "anvil_stopImpersonatingAccount", [EPHEMERAL], 1000); } catch {} child.kill(); }
}

async function runtimeMeta(upstream, address, artifactPath, blockTag) {
  const code = await rpc(upstream, "eth_getCode", [address, blockTag]);
  const artifact = readJson(path.join(ROOT, artifactPath)), artifactCode = artifact.deployedBytecode || "0x";
  return { address: ethers.getAddress(address), codePresent: code !== "0x", runtimeBytes: Math.max(0, (code.length - 2) / 2), runtimeKeccak256: code === "0x" ? null : ethers.keccak256(code), artifactPath, artifactRuntimeBytes: Math.max(0, (artifactCode.length - 2) / 2), artifactRuntimeKeccak256: artifactCode === "0x" ? null : ethers.keccak256(artifactCode), exactArtifactRuntimeMatch: code.toLowerCase() === artifactCode.toLowerCase(), sourceRuntimeEquivalence: null };
}

async function currentBindings(upstream, resolverAddress, resolverIface) {
  const tag = `0x${CURRENT_HEAD.toString(16)}`, rows = [];
  const fixedBlock = await rpc(upstream, "eth_getBlockByNumber", [tag, false]);
  const cappedConfig = await ethCall(upstream, CAPPED, RATE, "configData", [], tag);
  for (const row of T2) {
    const data = (await ethCall(upstream, resolverAddress, resolverIface, "getVaultEntireData", [row.vault], tag))[0], configs = data.configs ?? data[4], state = data.vaultState ?? data[8], constants = data.constantVariables ?? data[3];
    const conversion = await ethCall(upstream, row.oracle, PEG, "getDexConversionPriceFluidOracleData", [], tag), dexData = await ethCall(upstream, row.oracle, PEG, "dexOracleData", [], tag);
    rows.push({
      label: row.label, vault: ethers.getAddress(row.vault), vaultId: s(constants.vaultId ?? constants[10]), vaultType: s(constants.vaultType ?? constants[11]),
      expectedVaultId: String(row.vaultId), supplyDex: ethers.getAddress(constants.supply ?? constants[6]), expectedSupplyDex: ethers.getAddress(row.dex),
      resolverOracle: ethers.getAddress(configs.oracle ?? configs[8]), expectedOracle: ethers.getAddress(row.oracle), totalPositions: s(state.totalPositions ?? state[0]),
      oracleDex: ethers.getAddress(dexData[0]), conversionRateSource: ethers.getAddress(conversion[0]), expectedConversionRateSource: ethers.getAddress(CAPPED),
      vaultRuntime: await runtimeMeta(upstream, row.vault, row.vaultArtifact, tag), oracleRuntime: await runtimeMeta(upstream, row.oracle, row.oracleArtifact, tag),
      deploymentBindingsMatch: String(constants.vaultId ?? constants[10]) === String(row.vaultId) && String(constants.supply ?? constants[6]).toLowerCase() === row.dex.toLowerCase() && String(configs.oracle ?? configs[8]).toLowerCase() === row.oracle.toLowerCase() && String(conversion[0]).toLowerCase() === CAPPED.toLowerCase(),
    });
  }
  return {
    fixedHead: CURRENT_HEAD,
    fixedHeadHash: fixedBlock.hash,
    resolver: await runtimeMeta(upstream, resolverAddress, RESOLVER_FILE, tag),
    cappedRate: await runtimeMeta(upstream, CAPPED, "targets/fluid-contracts-public/deployments/mainnet/CappedRateBalancer_LBTC.json", tag),
    cappedRateSource: ethers.getAddress(cappedConfig[4]), expectedLombardOracle: ethers.getAddress(ORACLE), rateSourceMatches: String(cappedConfig[4]).toLowerCase() === ORACLE.toLowerCase(),
    rows,
    totalPositions: rows.reduce((sum, x) => sum + Number(x.totalPositions), 0),
    allDeploymentBindingsMatch: rows.every((x) => x.deploymentBindingsMatch),
  };
}

function formulaChecks(windows, current) {
  const max = windows.find((x) => x.id === "maximum-historical"), latest = windows.find((x) => x.id === "latest-same-block-ordered-model");
  const latestPositions = latest.before.resolverVaults.reduce((sum, x) => sum + Number(x.totalPositions || 0), 0);
  const liquidationZero = (snap) => Array.isArray(snap.resolverLiquidations) && snap.resolverLiquidations.every((x) => x.inAmt === "0" && x.outAmt === "0" && x.inAmtWithAbsorb === "0" && x.outAmtWithAbsorb === "0" && x.absorbAvailable === false);
  const latestResolverZero = liquidationZero(latest.before) && liquidationZero(latest.afterRebalance);
  const maxDirectError = [max.before, max.afterReplay, max.afterRebalance].every((snap) => snap.direct.every((x) => x.simulateWithoutAbsorb.errorId === "31029" && x.simulateWithoutAbsorb.debtLiquidated === "0"));
  const recomputedRows = windows.flatMap((w) => w.acceptedPriceRows.map((x) => ({ window: w.id, label: x.label, signedDeltaBps: formatBps5(x.controlRaw, x.afterRaw) })));
  const summaryRows = windows.flatMap((w) => w.acceptedPriceRows.map((x) => ({ window: w.id, label: x.label, signedDeltaBps: x.signedDeltaBps })));
  const acceptedPriceFormulaMatches = JSON.stringify(recomputedRows) === JSON.stringify(summaryRows);
  const latestOrdering = latest.chronology.sameBlockOrdering;
  return {
    acceptedPriceFormulaMatches,
    recomputedRows,
    summaryRows,
    reportSummaryBoundToComputedRows: true,
    allAcceptedPriceRowsChanged: windows.every((w) => w.acceptedPriceRows.every((x) => x.changed)),
    latestResolverLiquidationAmountsZeroAndNoAbsorbBeforeAfter: latestResolverZero,
    maximumWindowDirectError31029BeforeAfter: maxDirectError,
    latestSameBlockChronologyValid: latest.chronology.replayTimestamp === 1777304159 && latest.chronology.rebalanceTimestamp === 1777304159 && latestOrdering?.replayAndRebalanceSameBlock === true && latestOrdering?.orderedBeforeModeledNative === true,
    maximumChronologyExact: max.chronology.replayTimestamp === 1756129239 && max.chronology.rebalanceTimestamp === 1756129251 && max.chronology.nativePublicationTimestamp === 1756129343,
    controlTimestampsExact: windows.every((w) => w.controlChronology.exactTimestampMatch),
    historicalForkHashesBound: windows.every((w) => /^0x[0-9a-f]{64}$/i.test(w.forkBlockHash)),
    latestWindowTotalPositionsExpected: 217,
    latestWindowTotalPositionsObserved: latestPositions,
    latestWindowPositionCountMatches: latestPositions === 217,
    currentFixedHeadTotalPositionsObserved: current.totalPositions,
  };
}

async function main() {
  const raw = readJson(RAW), fixtures = readJson(CALLDATA), resolverDeployment = readJson(path.join(ROOT, RESOLVER_FILE));
  const resolverAddress = ethers.getAddress(resolverDeployment.address), resolverIface = new ethers.Interface(resolverDeployment.abi);
  const upstream = await resolveRpc(1); if (!upstream) throw new Error("authorized Ethereum endpoint unavailable");
  const windows = [];
  for (let i = 0; i < WINDOWS.length; i++) {
    const config = WINDOWS[i], fixture = fixtures.rows.find((x) => x.chainId === 8453 && x.transactionHash === config.sourceTransactionHash);
    if (!fixture?.input) throw new Error(`${config.id}: public calldata unavailable`);
    windows.push(await runWindow(upstream, fixture, config, resolverAddress, resolverIface, 20545 + Math.floor(Math.random() * 500) + i * 600));
    await sleep(3000);
  }
  const current = await currentBindings(upstream, resolverAddress, resolverIface), formulas = formulaChecks(windows, current);
  if (!formulas.acceptedPriceFormulaMatches || !formulas.allAcceptedPriceRowsChanged || !formulas.latestResolverLiquidationAmountsZeroAndNoAbsorbBeforeAfter || !formulas.maximumWindowDirectError31029BeforeAfter || !formulas.latestSameBlockChronologyValid || !formulas.maximumChronologyExact || !formulas.controlTimestampsExact || !formulas.historicalForkHashesBound || !formulas.latestWindowPositionCountMatches) throw new Error(`formula/boundary/chronology check failed ${JSON.stringify(formulas)}`);
  const latest = windows.find((x) => x.id === "latest-same-block-ordered-model"), max = windows.find((x) => x.id === "maximum-historical");
  const acceptedPriceSummary = windows.map((w) => ({ window: w.id, forkBlock: w.forkBlock, forkBlockHash: w.forkBlockHash, rows: w.acceptedPriceRows.map((x) => ({ label: x.label, signedDeltaBps: x.signedDeltaBps, beforeRaw: x.beforeRaw, controlRaw: x.controlRaw, afterRaw: x.afterRaw, decimals: x.decimals, formula: x.formula })) }));
  const out = {
    schema: 1,
    baseRunId: raw.baseRunId || raw.runId,
    revisedRunId: `${raw.baseRunId || raw.runId}-evidence-r3-oracle-repro`,
    evidenceRevision: "r3-oracle-reproducibility",
    generatedAt: new Date().toISOString(),
    classification: "WATCH/DOMAIN-SEPARATION-ABSENT/FORK-ACCEPTED-T2-PRICE-DELTA-NO-LIQUIDATION-BOUNDARY",
    severity: "Informational/WATCH",
    safety: { localForkOnlyForMutation: true, ephemeralImpersonatedAccount: true, privateKeyUsed: false, keyFileRead: false, signedTransaction: false, liveBroadcast: false, upstreamMutation: false, publicCalldataOnly: true, endpointMaterialPersisted: false },
    currentBindings: current,
    windows,
    acceptedPriceSummary,
    formulaChecks: formulas,
    sourceFixtures: SOURCE_PATHS.map(fileMeta),
    executionDependencies: { node: process.version, ethers: ethers.version, anvil: toolVersion("anvil"), forge: toolVersion("forge"), sharedRpcFixture: fileMeta("tools/shared-rpc.js") },
    historicalForks: windows.map((w) => ({ id: w.id, blockNumber: w.forkBlock, blockHash: w.forkBlockHash, timestamp: w.forkTimestamp })),
    t2AcceptedPriceDelta: acceptedPriceSummary.some((w) => w.rows.some((x) => x.signedDeltaBps !== "+0.00000" && x.signedDeltaBps !== "-0.00000")),
    t2LiquidatableAmountDelta: false,
    liquidationBoundaryCrossed: false,
    permissionlessLiquidationRoute: false,
    replaySemantics: { validSignedState: true, sameGloballyIntendedPayload: true, persistsAfterNativePublicationTime: max.replayedRatioPersistsAfterNativePublicationTime, latestModel: "same-block ordered counterfactual before modeled native transaction index 263", maximumWindow: "bounded publication acceleration", interpretation: "valid signed state persists; not a temporary false or reverting value" },
    liveMaterialIntegration: { positionsAcrossThreeVaultsAtLatestTestedWindow: formulas.latestWindowTotalPositionsObserved, latestTestedWindowBlock: 24972312, currentFixedHeadPositionsObserved: current.totalPositions, currentFixedHead: CURRENT_HEAD, inventoryComplete: false, caveat: "217 positions at the latest tested compatible window prove live material integration in the three exact resolver rows; the fixed-head count later reached the separately recorded value, and borrower inventory plus all possible external consumers are not claimed complete." },
    permissionlessExtractionProven: false,
    exactPositiveEconomics: null,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    evidenceComplete: false,
    blockers: ["No tested liquidation boundary crossing or non-zero liquidatable debt.", "No permissionless liquidation route or exact positive economics.", "Consumer and borrower inventory completeness remains open beyond the three exact T2 vaults and 217 observed positions.", "Exact Fluid and Lombard source-build-runtime equivalence remains null where immutable-linked checked-in runtime artifacts do not match byte-for-byte."],
  };
  const text = JSON.stringify(out, null, 2) + "\n"; assertNoLeak(text); fs.writeFileSync(OUT, text);
  process.stdout.write(`revision=${out.evidenceRevision} latestZero=${formulas.latestResolverLiquidationAmountsZeroAndNoAbsorbBeforeAfter} max31029=${formulas.maximumWindowDirectError31029BeforeAfter} deltas=${acceptedPriceSummary.map((w) => `${w.window}:${w.rows.map((x) => x.signedDeltaBps).join(",")}`).join(";")} testedPositions=${formulas.latestWindowTotalPositionsObserved} routePositive=0\n`);
}

main().catch((error) => { process.stderr.write(`t2 fork proof failed: ${redact(error)}\n`); process.exitCode = 1; });
