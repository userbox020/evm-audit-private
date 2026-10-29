#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const RAW = path.join(ROOT, "reports", "raw", "fast", "critical-eigenlayer-strategybase-steth-deployment-economics-step3.json");
const MANIFEST = path.join(ROOT, "reports", "raw", "fast", "critical-eigenlayer-strategybase-steth-deployment-economics-step3-manifest.json");
const MAX_RPC_CALLS = 320;
const MAX_CANDIDATE_PROBES = 64;
const TIMEOUT_MS = 10_000;

const ADDR = Object.freeze({
  steth: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
  documentedStethImplementation: "0x028271E30a695c0527A0C50cA30603feD004cDb0",
  strategyManager: "0x858646372CC42E1A627fcE94aa7A7033e7CF075A",
  expectedStrategyManagerImplementation: "0xa7536C85898dC424c6BFe8592F983661f830656A",
  stethStrategy: "0x93c4b944D05dfe6df7645A86cd2206016c51564D",
  expectedStethStrategyImplementation: "0xB427E2Eb4Bb33eE3f1ee72dc9e347e8625a72230",
  delegationManager: "0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A",
  expectedDelegationManagerImplementation: "0xE7022a128Acd4C6cad7aFf6FA874D61f984BcE75",
  expectedProxyAdmin: "0x8b9566AdA63B64d1E1dcF1418b43fd1433b72444",
  expectedAllocationManager: "0x948a420b8CC1d6BFd0B6087C2E7c344a2CD0bc39",
  freshDepositor: "0x4d5a7854d68ff104e2a12cbf24a85cc95a89d0e3"
});

const SLOT = Object.freeze({
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50"
});

const EXPECTED_SOURCE = Object.freeze({
  eigenlayerCommit: "ef8f97992241338cb88335b9d74295e33321b780",
  eigenlayerCurrentReadmeSha256: "c6b87df16797584c9ef83117c47586b5c2b6dbd721564c8c9bb677d48b8bd38c",
  lidoCommit: "2a2210baa3939f8079c47e8b45656b9d40e90650",
  lidoStethSha256: "15bec8fa0eaa8ac4131a136e8fd8a81e80ef3fe1713df241d91cc426b4b38c86",
  lidoLidoSha256: "2cf839f69ac3fc00166d92aa48ae70074e9ada8280a2c322eabff18b71565fc4"
});

const BATCH_SIZES = Object.freeze([1, 2, 3, 4, 8, 16, 32, 64, 128, 256, 512, 1024]);
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_WORD = `0x${"0".repeat(64)}`;

const ABI = Object.freeze({
  steth: new ethers.Interface([
    "function kernel() view returns (address)",
    "function appId() view returns (bytes32)",
    "function getTotalShares() view returns (uint256)",
    "function getTotalPooledEther() view returns (uint256)",
    "function getExternalShares() view returns (uint256)",
    "function getExternalEther() view returns (uint256)",
    "function getBufferedEther() view returns (uint256)",
    "function getSharesByPooledEth(uint256) view returns (uint256)",
    "function getPooledEthByShares(uint256) view returns (uint256)",
    "function sharesOf(address) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)"
  ]),
  kernel: new ethers.Interface([
    "function APP_BASES_NAMESPACE() view returns (bytes32)",
    "function getApp(bytes32,bytes32) view returns (address)"
  ]),
  strategyManager: new ethers.Interface([
    "function delegation() view returns (address)",
    "function allocationManager() view returns (address)",
    "function paused() view returns (uint256)",
    "function strategyIsWhitelistedForDeposit(address) view returns (bool)"
  ]),
  strategy: new ethers.Interface([
    "function strategyManager() view returns (address)",
    "function underlyingToken() view returns (address)",
    "function totalShares() view returns (uint256)",
    "function paused() view returns (uint256)",
    "function getTVLLimits() view returns (uint256,uint256)"
  ]),
  delegationManager: new ethers.Interface([
    "function strategyManager() view returns (address)",
    "function allocationManager() view returns (address)",
    "function minWithdrawalDelayBlocks() view returns (uint32)",
    "function paused() view returns (uint256)",
    "function delegatedTo(address) view returns (address)",
    "function depositScalingFactor(address,address) view returns (uint256)"
  ]),
  allocationManager: new ethers.Interface([
    "function getMaxMagnitude(address,address) view returns (uint64)"
  ])
});

class SafeFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalize(value) {
  if (typeof value === "string") return value.toLowerCase();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

function parseInventory(text) {
  const lines = text.replace(/\\\//g, "/").split(/\r?\n/);
  const records = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; ++i) {
    for (const match of lines[i].matchAll(/https?:\/\/[^\s"'`<>{}\[\]]+/gi)) {
      const candidate = match[0].replace(/[)>`,.;\]]+$/g, "");
      let parsed;
      try { parsed = new URL(candidate); } catch { continue; }
      if (seen.has(parsed.href)) continue;
      seen.add(parsed.href);
      const context = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join("\n");
      const headers = {};
      const origin = context.match(/\[origin:\s*([^\]\s]+)\]/i)?.[1] || null;
      for (const h of context.matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/gi)) headers[h[1].trim()] = h[2].trim();
      records.push({ url: parsed.href, family: parsed.hostname.toLowerCase(), origin, headers });
    }
  }
  return records;
}

function slotAddress(word) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(word)) throw new SafeFailure("INVALID_STORAGE_WORD");
  return ethers.getAddress(`0x${word.slice(26)}`);
}

function ceilDiv(a, b) {
  if (b <= 0n) throw new SafeFailure("DIVISION_BY_ZERO");
  return a === 0n ? 0n : ((a - 1n) / b) + 1n;
}

function simulateDustBatch(input) {
  const n = BigInt(input.depositCount);
  const dust = BigInt(input.dustAmount);
  const balance = BigInt(input.strategyBalance);
  const internalEther = BigInt(input.internalEther);
  const internalShares = BigInt(input.internalShares);
  let totalShares = BigInt(input.strategyTotalShares);
  let aggregateMinted = 0n;
  for (let i = 0n; i < n; ++i) {
    const denominator = balance + 1000n - dust;
    if (denominator <= 0n) throw new SafeFailure("INVALID_STRATEGY_DENOMINATOR");
    const minted = dust * (totalShares + 1000n) / denominator;
    if (minted === 0n) return { depositWouldRevert: true, aggregateMinted: "0", amountOut: "0", tokenSharesOut: "0", pooledValueOut: "0" };
    aggregateMinted += minted;
    totalShares += minted;
  }
  const amountOut = (balance + 1000n) * aggregateMinted / (totalShares + 1000n);
  const tokenSharesOut = amountOut * internalShares / internalEther;
  const pooledValueOut = tokenSharesOut * internalEther / internalShares;
  return {
    depositWouldRevert: false,
    aggregateMinted: aggregateMinted.toString(),
    amountOut: amountOut.toString(),
    tokenSharesOut: tokenSharesOut.toString(),
    pooledValueOut: pooledValueOut.toString()
  };
}

function correctedEconomics(input) {
  const dust = BigInt(input.maximumZeroShareAmount);
  const baseFee = BigInt(input.fixedPinBaseFeePerGasWei);
  const currentDustDepositAccepted = Boolean(input.currentDustDepositAccepted);
  const batches = BATCH_SIZES.map(depositCount => ({
    depositCount,
    ...simulateDustBatch({
      depositCount,
      dustAmount: dust,
      strategyBalance: input.strategyBalance,
      strategyTotalShares: input.strategyTotalShares,
      internalEther: input.internalEther,
      internalShares: input.internalShares
    }),
    currentCapturePooledWei: currentDustDepositAccepted ? null : "0"
  }));
  return {
    fixedPinBaseFeePerGasWei: baseFee.toString(),
    fixedPinBaseFeeUsedForHypotheticalClosure: false,
    maximumZeroShareDepositAmountPooledWei: dust.toString(),
    current: {
      dustDepositAccepted: currentDustDepositAccepted,
      rawCapturePooledWei: currentDustDepositAccepted ? null : "0",
      disposition: currentDustDepositAccepted
        ? "CURRENT_ROUTE_REQUIRES_SEPARATE_ANALYSIS"
        : "CURRENT_DUST_DEPOSIT_REVERTS_NEW_SHARES_ZERO_CURRENT_CAPTURE_ZERO",
      batchSimulation: batches
    },
    hypotheticalHelperBatching: {
      helperCanApproveAndSequentiallyCallDepositsThenQueueInOneTransaction: true,
      nonReentrantDoesNotBlockSequentialCalls: true,
      completionRequiresLaterTransactionAfterDelay: true,
      minimumProtocolPathTransactions: 2,
      externalFundingAndApprovalSetupExcludedFromMinimum: true,
      minimumProtocolPathIntrinsicGasUnitsLowerBound: "42000",
      modeledRawCapturePooledWeiUpperBoundExpression: "N * maximumZeroShareDepositAmountPooledWei",
      perDepositExecutionGasLowerBound: null,
      blockGasBatchingCap: null,
      maximumFeasibleDepositCountPerTransaction: null,
      netEconomics: null,
      economicsResolved: false,
      unresolvedReason: "No defensible per-deposit execution-gas lower bound or block-gas batching cap was derived without state-changing execution or a fork."
    },
    exactP0P1: {
      preTotalPooledEther: "3202672159049153736000000000000",
      postTotalPooledEther: "3203007081032019734171080427666",
      totalPooledEtherIncrease: "334921982865998171080427666",
      nominalCapitalStethWei: "84348182397297018634683",
      rawGainTokenShares: "1",
      currentReferencePooledWeiValueOfOneTokenShare: String(input.pooledPerOneTokenShare),
      minimumProtocolPathTransactions: 2,
      minimumProtocolPathIntrinsicGasUnitsLowerBound: "42000",
      transactionPlan: [
        "helper approves, deposits at P0, and queues in transaction 1",
        "exogenous rebase occurs during the queue delay; helper completes at P1 in transaction 2"
      ],
      rebaseOccursDuringWithdrawalQueueDelay: true,
      queueingBurnsStrategyBaseSharesUnderFactorOneModel: false,
      queueingRemovesStethCustodyUnderFactorOneModel: false,
      externalFundingAndApprovalSetupExcludedFromMinimum: true,
      executionBaseFeesUnknown: true,
      intrinsicCostWeiLowerBoundAtExecution: null,
      withdrawalDelayBlocks: String(input.withdrawalDelay),
      requiresExogenousExactRebaseResidue: true,
      conditionalFutureCase: true,
      currentRouteReproducedAtPin: false,
      netEconomics: null,
      economicsResolved: false
    },
    disposition: {
      current: "CURRENT_CAPTURE_ZERO_DEPOSIT_REVERTS",
      hypotheticalHelperBatching: "UNRESOLVED",
      exactP0P1FutureConditional: "UNRESOLVED",
      economicsClosed: false
    }
  };
}

function createRpcBudget() {
  return { max: MAX_RPC_CALLS, attempted: 0, succeeded: 0, failed: 0, byMethod: {}, consensusQueries: 0 };
}

async function rpc(record, method, params, budget) {
  for (let attempt = 0; attempt < 2; ++attempt) {
    await new Promise(resolve => setTimeout(resolve, 125));
    if (budget.attempted >= budget.max) throw new SafeFailure("RPC_BUDGET_EXCEEDED");
    budget.attempted++;
    budget.byMethod[method] = (budget.byMethod[method] || 0) + 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const headers = { "content-type": "application/json", ...record.headers };
    if (record.origin) headers.origin = record.origin;
    try {
      const response = await fetch(record.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: budget.attempted, method, params }),
        signal: controller.signal
      });
      if (!response.ok) throw new SafeFailure("RPC_HTTP_FAILURE");
      const body = await response.json();
      if (body.error || body.result === undefined || body.result === null) throw new SafeFailure("RPC_RESULT_FAILURE");
      budget.succeeded++;
      return body.result;
    } catch {
      budget.failed++;
      if (attempt === 1) throw new SafeFailure("RPC_CALL_FAILURE");
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new SafeFailure("RPC_CALL_FAILURE");
}

async function selectProviders(records, budget) {
  const selected = [];
  const stateSelected = [];
  const families = new Set();
  let scanned = 0;
  let chainMatches = 0;
  for (const record of records) {
    if (scanned >= MAX_CANDIDATE_PROBES || (selected.length >= 2 && stateSelected.length >= 2)) break;
    scanned++;
    if (families.has(record.family)) continue;
    try {
      const chainId = await rpc(record, "eth_chainId", [], budget);
      if (BigInt(chainId) !== 1n) continue;
      chainMatches++;
      const finalized = await rpc(record, "eth_getBlockByNumber", ["finalized", false], budget);
      if (!finalized?.hash || !finalized?.number || !finalized?.baseFeePerGas) continue;
      families.add(record.family);
      const qualified = { ...record, finalized };
      selected.push(qualified);
      try {
        const capabilityWord = await rpc(record, "eth_getStorageAt", [ADDR.strategyManager, SLOT.implementation, finalized.number], budget);
        if (!/^0x[0-9a-fA-F]*$/.test(capabilityWord)) continue;
        if (ethers.zeroPadValue(capabilityWord, 32).toLowerCase() === ZERO_WORD) continue;
        const capabilityCode = await rpc(record, "eth_getCode", [ADDR.strategyManager, finalized.number], budget);
        if (!/^0x[0-9a-fA-F]{4,}$/.test(capabilityCode)) continue;
        const capabilityCall = await rpc(
          record,
          "eth_call",
          [{ to: ADDR.strategyManager, data: ABI.strategyManager.encodeFunctionData("paused", []) }, finalized.number],
          budget
        );
        if (/^0x[0-9a-fA-F]+$/.test(capabilityCall)) stateSelected.push(qualified);
      } catch {}
    } catch {}
  }
  if (selected.length < 2) throw new SafeFailure("TWO_PROVIDER_FAMILIES_UNAVAILABLE");
  if (stateSelected.length < 1) throw new SafeFailure("STATE_CAPABLE_PROVIDER_UNAVAILABLE");
  return { selected: selected.slice(0, 2), stateSelected: stateSelected.slice(0, 1), scanned, chainMatches };
}

async function consensusRpc(providers, method, params, budget) {
  const values = [];
  for (const provider of providers) values.push(await rpc(provider, method, params, budget));
  const comparable = value => {
    if (method === "eth_getStorageAt") return ethers.zeroPadValue(value, 32).toLowerCase();
    if (method === "eth_getCode" || method === "eth_call") return String(value).toLowerCase();
    if (method === "eth_getBlockByNumber") {
      return canonical(normalize({
        number: value.number,
        hash: value.hash,
        timestamp: value.timestamp,
        baseFeePerGas: value.baseFeePerGas
      }));
    }
    return canonical(normalize(value));
  };
  const commitment = comparable(values[0]);
  for (let i = 1; i < values.length; ++i) {
    if (comparable(values[i]) !== commitment) throw new SafeFailure("PROVIDER_CONSENSUS_MISMATCH");
  }
  budget.consensusQueries++;
  return method === "eth_getStorageAt" ? ethers.zeroPadValue(values[0], 32) : values[0];
}

async function contractCall(providers, target, iface, fn, args, blockTag, budget) {
  try {
    const data = iface.encodeFunctionData(fn, args);
    const raw = await consensusRpc(providers, "eth_call", [{ to: target, data }, blockTag], budget);
    return iface.decodeFunctionResult(fn, raw);
  } catch {
    throw new SafeFailure(`ETH_CALL_${fn.replace(/[^a-zA-Z0-9]/g, "_")}_FAILED`);
  }
}

async function one(providers, target, iface, fn, args, blockTag, budget) {
  return (await contractCall(providers, target, iface, fn, args, blockTag, budget))[0];
}

async function proxySlots(providers, address, blockTag, budget) {
  const result = {};
  for (const [name, slot] of Object.entries(SLOT)) {
    let word;
    try { word = await consensusRpc(providers, "eth_getStorageAt", [address, slot, blockTag], budget); }
    catch (error) {
      const suffix = error instanceof SafeFailure && error.code === "PROVIDER_CONSENSUS_MISMATCH" ? "CONSENSUS_MISMATCH" : "FAILED";
      throw new SafeFailure(`STORAGE_${name.toUpperCase()}_${suffix}`);
    }
    result[name] = word === ZERO_WORD ? ZERO : slotAddress(word);
  }
  return result;
}

async function codeFact(providers, address, blockTag, budget) {
  let code;
  try { code = await consensusRpc(providers, "eth_getCode", [address, blockTag], budget); }
  catch { throw new SafeFailure("CODE_READ_FAILED"); }
  return { address: ethers.getAddress(address), bytes: (code.length - 2) / 2, keccak256: ethers.keccak256(code) };
}

function addressEq(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

async function main() {
  if (!fs.existsSync(INVENTORY)) throw new SafeFailure("AUTHORIZED_INVENTORY_UNAVAILABLE");
  const records = parseInventory(fs.readFileSync(INVENTORY, "utf8"));
  const budget = createRpcBudget();
  const qualification = await selectProviders(records, budget);
  const pinProviders = qualification.selected;
  const providers = qualification.stateSelected;
  const pinNumber = pinProviders.map(p => BigInt(p.finalized.number)).reduce((a, b) => a < b ? a : b);
  const blockTag = ethers.toQuantity(pinNumber);
  const pinHeader = await consensusRpc(pinProviders, "eth_getBlockByNumber", [blockTag, false], budget);
  const pin = {
    chainId: 1,
    finalized: true,
    number: pinNumber.toString(),
    hash: pinHeader.hash,
    timestamp: BigInt(pinHeader.timestamp).toString(),
    baseFeePerGasWei: BigInt(pinHeader.baseFeePerGas).toString()
  };

  const stethSlots = await proxySlots(providers, ADDR.steth, blockTag, budget);
  const strategyManagerSlots = await proxySlots(providers, ADDR.strategyManager, blockTag, budget);
  const strategySlots = await proxySlots(providers, ADDR.stethStrategy, blockTag, budget);
  const delegationManagerSlots = await proxySlots(providers, ADDR.delegationManager, blockTag, budget);

  const kernel = ethers.getAddress(await one(providers, ADDR.steth, ABI.steth, "kernel", [], blockTag, budget));
  const appId = await one(providers, ADDR.steth, ABI.steth, "appId", [], blockTag, budget);
  const basesNamespace = await one(providers, kernel, ABI.kernel, "APP_BASES_NAMESPACE", [], blockTag, budget);
  const stethImplementation = ethers.getAddress(await one(providers, kernel, ABI.kernel, "getApp", [basesNamespace, appId], blockTag, budget));

  const implementationAddresses = [
    stethImplementation,
    strategyManagerSlots.implementation,
    strategySlots.implementation,
    delegationManagerSlots.implementation
  ];
  if (implementationAddresses.some(a => a === ZERO)) throw new SafeFailure("IMPLEMENTATION_BINDING_FAILED");

  const code = {};
  for (const [name, address] of Object.entries({
    stethProxy: ADDR.steth,
    stethImplementation,
    strategyManagerProxy: ADDR.strategyManager,
    strategyManagerImplementation: strategyManagerSlots.implementation,
    stethStrategyProxy: ADDR.stethStrategy,
    stethStrategyImplementation: strategySlots.implementation,
    delegationManagerProxy: ADDR.delegationManager,
    delegationManagerImplementation: delegationManagerSlots.implementation
  })) code[name] = await codeFact(providers, address, blockTag, budget);

  const smDelegation = ethers.getAddress(await one(providers, ADDR.strategyManager, ABI.strategyManager, "delegation", [], blockTag, budget));
  const smAllocation = ethers.getAddress(await one(providers, ADDR.strategyManager, ABI.strategyManager, "allocationManager", [], blockTag, budget));
  const smPaused = BigInt(await one(providers, ADDR.strategyManager, ABI.strategyManager, "paused", [], blockTag, budget));
  const whitelisted = Boolean(await one(providers, ADDR.strategyManager, ABI.strategyManager, "strategyIsWhitelistedForDeposit", [ADDR.stethStrategy], blockTag, budget));

  const strategyManagerLink = ethers.getAddress(await one(providers, ADDR.stethStrategy, ABI.strategy, "strategyManager", [], blockTag, budget));
  const underlyingToken = ethers.getAddress(await one(providers, ADDR.stethStrategy, ABI.strategy, "underlyingToken", [], blockTag, budget));
  const strategyTotalShares = BigInt(await one(providers, ADDR.stethStrategy, ABI.strategy, "totalShares", [], blockTag, budget));
  const strategyPaused = BigInt(await one(providers, ADDR.stethStrategy, ABI.strategy, "paused", [], blockTag, budget));
  const tvlLimits = await contractCall(providers, ADDR.stethStrategy, ABI.strategy, "getTVLLimits", [], blockTag, budget);
  const maxPerDeposit = BigInt(tvlLimits[0]);
  const maxTotalDeposits = BigInt(tvlLimits[1]);

  const dmStrategyManager = ethers.getAddress(await one(providers, ADDR.delegationManager, ABI.delegationManager, "strategyManager", [], blockTag, budget));
  const dmAllocation = ethers.getAddress(await one(providers, ADDR.delegationManager, ABI.delegationManager, "allocationManager", [], blockTag, budget));
  const withdrawalDelay = BigInt(await one(providers, ADDR.delegationManager, ABI.delegationManager, "minWithdrawalDelayBlocks", [], blockTag, budget));
  const dmPaused = BigInt(await one(providers, ADDR.delegationManager, ABI.delegationManager, "paused", [], blockTag, budget));
  const freshDelegatedTo = ethers.getAddress(await one(providers, ADDR.delegationManager, ABI.delegationManager, "delegatedTo", [ADDR.freshDepositor], blockTag, budget));
  const freshDsf = BigInt(await one(providers, ADDR.delegationManager, ABI.delegationManager, "depositScalingFactor", [ADDR.freshDepositor, ADDR.stethStrategy], blockTag, budget));
  const freshMaxMagnitude = BigInt(await one(providers, dmAllocation, ABI.allocationManager, "getMaxMagnitude", [ZERO, ADDR.stethStrategy], blockTag, budget));

  const totalTokenShares = BigInt(await one(providers, ADDR.steth, ABI.steth, "getTotalShares", [], blockTag, budget));
  const totalPooledEther = BigInt(await one(providers, ADDR.steth, ABI.steth, "getTotalPooledEther", [], blockTag, budget));
  const externalShares = BigInt(await one(providers, ADDR.steth, ABI.steth, "getExternalShares", [], blockTag, budget));
  const externalEther = BigInt(await one(providers, ADDR.steth, ABI.steth, "getExternalEther", [], blockTag, budget));
  const bufferedEther = BigInt(await one(providers, ADDR.steth, ABI.steth, "getBufferedEther", [], blockTag, budget));
  const strategyTokenShares = BigInt(await one(providers, ADDR.steth, ABI.steth, "sharesOf", [ADDR.stethStrategy], blockTag, budget));
  const strategyBalance = BigInt(await one(providers, ADDR.steth, ABI.steth, "balanceOf", [ADDR.stethStrategy], blockTag, budget));
  const internalShares = totalTokenShares - externalShares;
  const internalEther = totalPooledEther - externalEther;
  if (internalShares <= 0n || internalEther <= 0n) throw new SafeFailure("INVALID_STETH_INTERNAL_RATE");
  const minimumAmountForOneTokenShare = ceilDiv(internalEther, internalShares);
  const maximumZeroShareAmount = minimumAmountForOneTokenShare - 1n;
  const zeroShareCheck = BigInt(await one(providers, ADDR.steth, ABI.steth, "getSharesByPooledEth", [maximumZeroShareAmount], blockTag, budget));
  const oneShareThresholdCheck = BigInt(await one(providers, ADDR.steth, ABI.steth, "getSharesByPooledEth", [minimumAmountForOneTokenShare], blockTag, budget));
  const pooledPerOneTokenShare = BigInt(await one(providers, ADDR.steth, ABI.steth, "getPooledEthByShares", [1n], blockTag, budget));
  const sharesPerEther = BigInt(await one(providers, ADDR.steth, ABI.steth, "getSharesByPooledEth", [10n ** 18n], blockTag, budget));
  const pooledPerEtherShares = BigInt(await one(providers, ADDR.steth, ABI.steth, "getPooledEthByShares", [10n ** 18n], blockTag, budget));
  if (zeroShareCheck !== 0n || oneShareThresholdCheck < 1n) throw new SafeFailure("ZERO_SHARE_THRESHOLD_BINDING_FAILED");

  const implementationContinuity = {
    stethDocumentedImplementationMatched: addressEq(stethImplementation, ADDR.documentedStethImplementation),
    strategyManagerReadmeImplementationMatched: addressEq(strategyManagerSlots.implementation, ADDR.expectedStrategyManagerImplementation),
    stethStrategyReadmeImplementationMatched: addressEq(strategySlots.implementation, ADDR.expectedStethStrategyImplementation),
    delegationManagerReadmeImplementationMatched: addressEq(delegationManagerSlots.implementation, ADDR.expectedDelegationManagerImplementation)
  };
  const linkageContinuity = {
    strategyUnderlyingIsSteth: addressEq(underlyingToken, ADDR.steth),
    strategyManagerLinkMatched: addressEq(strategyManagerLink, ADDR.strategyManager),
    strategyManagerDelegationLinkMatched: addressEq(smDelegation, ADDR.delegationManager),
    delegationManagerStrategyManagerLinkMatched: addressEq(dmStrategyManager, ADDR.strategyManager),
    strategyManagerAllocationLinkMatched: addressEq(smAllocation, ADDR.expectedAllocationManager),
    delegationManagerAllocationLinkMatched: addressEq(dmAllocation, ADDR.expectedAllocationManager)
  };
  const allImplementationAddressesMatched = Object.values(implementationContinuity).every(Boolean);
  const allLinksMatched = Object.values(linkageContinuity).every(Boolean);

  const depositUnpaused = (smPaused & 1n) === 0n && (strategyPaused & 1n) === 0n;
  const withdrawalUnpaused = (strategyPaused & 2n) === 0n;
  const queueEntryUnpaused = (dmPaused & 2n) === 0n;
  const queueExitUnpaused = (dmPaused & 4n) === 0n;
  const tvlAllowsDust = maximumZeroShareAmount <= maxPerDeposit && strategyBalance <= maxTotalDeposits;
  const permissionlessSurfaceBound = allImplementationAddressesMatched && allLinksMatched && whitelisted && depositUnpaused
    && withdrawalUnpaused && queueEntryUnpaused && queueExitUnpaused && tvlAllowsDust
    && freshDelegatedTo === ZERO && freshDsf === 10n ** 18n && freshMaxMagnitude === 10n ** 18n;

  const currentDustMintedStrategyShares = maximumZeroShareAmount * (strategyTotalShares + 1000n)
    / (strategyBalance + 1000n - maximumZeroShareAmount);
  const currentDustDepositAccepted = permissionlessSurfaceBound && currentDustMintedStrategyShares > 0n;

  const economics = correctedEconomics({
    maximumZeroShareAmount,
    fixedPinBaseFeePerGasWei: pin.baseFeePerGasWei,
    currentDustDepositAccepted,
    strategyBalance,
    strategyTotalShares,
    internalEther,
    internalShares,
    pooledPerOneTokenShare,
    withdrawalDelay
  });

  const terminalHeaders = [];
  for (const provider of pinProviders) terminalHeaders.push(await rpc(provider, "eth_getBlockByNumber", [blockTag, false], budget));
  if (terminalHeaders.some(h => h.hash.toLowerCase() !== pin.hash.toLowerCase() || BigInt(h.number) !== pinNumber)) {
    throw new SafeFailure("TERMINAL_PIN_RECHECK_FAILED");
  }

  const providerEvidence = {
    inventoryRecordsParsed: records.length,
    candidatesScanned: qualification.scanned,
    chainIdMatches: qualification.chainMatches,
    anonymousProviderFamiliesRequired: 2,
    anonymousProviderFamiliesUsed: pinProviders.length,
    stateQueryProviderFamiliesUsed: providers.length,
    families: pinProviders.map((p, i) => ({
      anonymousId: `family-${i + 1}`,
      commitment: sha256(`critical-eigenlayer-steth-step3-family-v1|${p.family}`),
      chainIdMatched: true,
      finalizedAvailable: true,
      initialSameNumberHashMatched: true,
      terminalSameNumberHashMatched: true
    })),
    caveat: "Family separation is network-authority-derived in memory and only salted commitments are persisted."
  };

  const sourceFiles = {
    eigenlayerCurrentReadmeSha256: fileSha256(path.join(ROOT, "sources", "eigenlayer-contracts-step3-current", "README.md")),
    eigenlayerAuditTargetReadmeSha256: fileSha256(path.join(ROOT, "targets", "eigenlayer-contracts", "README.md")),
    eigenlayerMainnetAddressesSha256: fileSha256(path.join(ROOT, "targets", "eigenlayer-contracts", "script", "configs", "mainnet", "mainnet-addresses.config.json")),
    eigenlayerMainnetConfigSha256: fileSha256(path.join(ROOT, "targets", "eigenlayer-contracts", "script", "configs", "mainnet.json")),
    lidoStethSha256: fileSha256(path.join(ROOT, "sources", "lido-core-v3.0.2", "contracts", "0.4.24", "StETH.sol")),
    lidoLidoSha256: fileSha256(path.join(ROOT, "sources", "lido-core-v3.0.2", "contracts", "0.4.24", "Lido.sol"))
  };
  if (sourceFiles.lidoStethSha256 !== EXPECTED_SOURCE.lidoStethSha256
      || sourceFiles.lidoLidoSha256 !== EXPECTED_SOURCE.lidoLidoSha256
      || sourceFiles.eigenlayerCurrentReadmeSha256 !== EXPECTED_SOURCE.eigenlayerCurrentReadmeSha256) {
    throw new SafeFailure("SOURCE_HASH_MISMATCH");
  }

  const raw = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    revision: {
      id: "oracle-final-p0p1-helper-two-transaction-r2",
      mode: "FRESH_READ_ONLY_CAPTURE",
      helperBatchingCorrectionApplied: true
    },
    findingId: "eigenlayer-strategybase-steth-deployment-economics-step3",
    agentId: "critical-eigenlayer-steth-step3-20260727",
    role: "critical-research",
    claimNamespace: "target-eigenlayer-strategybase-steth-deployment-economics-step3",
    classification: permissionlessSurfaceBound && !currentDustDepositAccepted
      ? "CLEAN/DEPLOYED-CONTINUITY-BOUND/CURRENT-DUST-DEPOSIT-REVERTS/CURRENT-CAPTURE-ZERO"
      : "BLOCKED/DEPLOYMENT-OR-ECONOMICS-CONTINUITY-INCOMPLETE",
    gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false },
    pin,
    providerEvidence,
    rpcBudget: { ...budget },
    sourceArtifacts: {
      expected: EXPECTED_SOURCE,
      hashes: sourceFiles,
      authoritativeDeploymentArtifactMatch: allImplementationAddressesMatched,
      authoritativeCurrentArtifactCommit: EXPECTED_SOURCE.eigenlayerCommit,
      strategyManagerSourceTag: "v1.12.0",
      delegationManagerSourceTag: "v1.6.0",
      stethStrategySourceTag: "v1.12.0",
      reproducibleRuntimeSourceBytecodeEquivalenceClaimed: false
    },
    deployments: {
      steth: {
        proxy: ADDR.steth,
        proxyPattern: "ARAGON_APP_PROXY_KERNEL_BASE",
        kernel,
        appId,
        basesNamespace,
        implementation: stethImplementation,
        eip1967Slots: stethSlots,
        implementationMatchedDocumentedV302: implementationContinuity.stethDocumentedImplementationMatched,
        proxyCode: code.stethProxy,
        implementationCode: code.stethImplementation
      },
      strategyManager: {
        proxy: ADDR.strategyManager,
        proxyPattern: "EIP1967_TRANSPARENT",
        slots: strategyManagerSlots,
        implementationMatchedReadme: implementationContinuity.strategyManagerReadmeImplementationMatched,
        proxyCode: code.strategyManagerProxy,
        implementationCode: code.strategyManagerImplementation
      },
      stethStrategy: {
        proxy: ADDR.stethStrategy,
        proxyPattern: "EIP1967_TRANSPARENT_PRE_LONGTAIL",
        slots: strategySlots,
        implementationMatchedReadme: implementationContinuity.stethStrategyReadmeImplementationMatched,
        proxyCode: code.stethStrategyProxy,
        implementationCode: code.stethStrategyImplementation
      },
      delegationManager: {
        proxy: ADDR.delegationManager,
        identifiedFromAuthoritativeLocalArtifacts: true,
        proxyPattern: "EIP1967_TRANSPARENT",
        slots: delegationManagerSlots,
        implementationMatchedReadme: implementationContinuity.delegationManagerReadmeImplementationMatched,
        proxyCode: code.delegationManagerProxy,
        implementationCode: code.delegationManagerImplementation
      },
      implementationContinuity,
      linkageContinuity,
      allImplementationAddressesMatched,
      allLinksMatched
    },
    currentState: {
      strategyManager: {
        pausedBitmap: smPaused.toString(),
        depositUnpaused: (smPaused & 1n) === 0n,
        strategyWhitelisted: whitelisted,
        delegation: smDelegation,
        allocationManager: smAllocation
      },
      stethStrategy: {
        strategyManager: strategyManagerLink,
        underlyingToken,
        totalShares: strategyTotalShares.toString(),
        pausedBitmap: strategyPaused.toString(),
        depositUnpaused: (strategyPaused & 1n) === 0n,
        withdrawalUnpaused,
        maxPerDeposit: maxPerDeposit.toString(),
        maxTotalDeposits: maxTotalDeposits.toString(),
        stethBalance: strategyBalance.toString(),
        stethTokenShareCustody: strategyTokenShares.toString(),
        tvlAllowsMaximumZeroShareDust: tvlAllowsDust
      },
      delegationManager: {
        strategyManager: dmStrategyManager,
        allocationManager: dmAllocation,
        pausedBitmap: dmPaused.toString(),
        queueEntryUnpaused,
        queueExitUnpaused,
        minWithdrawalDelayBlocks: withdrawalDelay.toString(),
        freshDepositor: ADDR.freshDepositor,
        freshDelegatedTo,
        freshDepositScalingFactor: freshDsf.toString(),
        undelegatedMaxMagnitude: freshMaxMagnitude.toString()
      },
      stethShareRate: {
        totalPooledEther: totalPooledEther.toString(),
        totalTokenShares: totalTokenShares.toString(),
        externalEther: externalEther.toString(),
        externalShares: externalShares.toString(),
        internalEtherNumerator: internalEther.toString(),
        internalSharesDenominator: internalShares.toString(),
        bufferedEther: bufferedEther.toString(),
        sharesPerOneEther: sharesPerEther.toString(),
        pooledEtherPerOneEtherShares: pooledPerEtherShares.toString(),
        pooledEtherPerOneTokenShare: pooledPerOneTokenShare.toString(),
        minimumPooledAmountForOneTokenShare: minimumAmountForOneTokenShare.toString(),
        maximumPooledAmountMovingZeroTokenShares: maximumZeroShareAmount.toString(),
        thresholdCallsMatched: true
      },
      permissionlessSurface: {
        sourceArtifactContinuityBound: allImplementationAddressesMatched,
        depositPublicBySourceAndCurrentState: permissionlessSurfaceBound,
        queuePublicBySourceAndCurrentState: permissionlessSurfaceBound,
        completionPublicToOriginalWithdrawerAfterDelay: permissionlessSurfaceBound,
        permissionlessSurfaceBound,
        currentMaximumZeroShareDepositMintsStrategyShares: currentDustMintedStrategyShares.toString(),
        currentMaximumZeroShareDepositAccepted: currentDustDepositAccepted,
        currentBlocker: currentDustDepositAccepted ? null : "StrategyBase NewSharesZero"
      }
    },
    economics,
    terminalPinRecheck: {
      providerFamiliesRechecked: pinProviders.length,
      sameNumber: pin.number,
      sameHash: pin.hash,
      allMatched: true
    },
    blockers: [
      "No reproducible runtime-to-source bytecode compilation/equality proof; continuity is authoritative-address-artifact plus live implementation binding.",
      "No state-changing execution, estimateGas, fork, or current-user transaction simulation was performed.",
      "Hypothetical helper batching economics are unresolved because no defensible per-deposit execution-gas lower bound or block-gas batching cap was derived.",
      "Exact P0/P1 gain is a conditional future case depending on an exogenous rebase during the queue delay, large nominal capital, and two attacker protocol-path transactions.",
      "Delegated/non-unit-DSF/slashed depositor variants were not needed to establish the current NewSharesZero blocker."
    ],
    stopAdvance: {
      stop: !currentDustDepositAccepted
        ? "STOP_CURRENT_DUST_BRANCH_DEPOSIT_REVERTS_CURRENT_CAPTURE_ZERO"
        : null,
      advance: !currentDustDepositAccepted
        ? "If StrategyBase one-wei mint becomes nonzero or relevant state/code changes, derive defensible per-deposit execution gas and a block-gas batching cap before any hypothetical economics conclusion."
        : "Resolve failed continuity gates and helper-batching economics."
    },
    safety: {
      authorizedInventoryRead: true,
      endpointMaterialPersisted: false,
      providerIdentityPersisted: false,
      rawInventoryPersisted: false,
      rawResponsesPersisted: false,
      privateKeyReads: false,
      envReads: false,
      rpcReadOnly: true,
      methodsAllowed: ["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call"],
      logsUsed: false,
      transactions: false,
      broadcasts: false,
      stateOverrides: false,
      productionMutation: false,
      fundMovement: false
    }
  };

  fs.writeFileSync(RAW, `${JSON.stringify(raw, null, 2)}\n`);
  const manifestBase = {
    schemaVersion: 2,
    revision: raw.revision,
    rawPath: path.relative(ROOT, RAW).replace(/\\/g, "/"),
    rawSha256: fileSha256(RAW),
    runnerPath: path.relative(ROOT, __filename).replace(/\\/g, "/"),
    runnerSha256: fileSha256(__filename),
    sourceCommitments: {
      eigenlayerCommit: EXPECTED_SOURCE.eigenlayerCommit,
      lidoCommit: EXPECTED_SOURCE.lidoCommit,
      ...sourceFiles
    },
    pinCommitment: sha256(canonical(pin)),
    providerFamilyCommitments: providerEvidence.families.map(f => f.commitment),
    safety: raw.safety
  };
  const manifest = { ...manifestBase, aggregateSha256: sha256(canonical(manifestBase)) };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    pinNumber: pin.number,
    pinHash: pin.hash,
    providerFamilies: pinProviders.length,
    stateQueryProviderFamilies: providers.length,
    rpcCalls: budget.attempted,
    continuityBound: allImplementationAddressesMatched && allLinksMatched,
    permissionlessSurfaceBound,
    currentCaptureZero: !currentDustDepositAccepted,
    hypotheticalBatchingEconomicsResolved: economics.hypotheticalHelperBatching.economicsResolved,
    routePositive: 0
  })}\n`);
}

function reviseRetainedArtifactsOffline() {
  if (!fs.existsSync(RAW) || !fs.existsSync(MANIFEST)) throw new SafeFailure("OFFLINE_PREDECESSOR_UNAVAILABLE");
  const predecessorRawText = fs.readFileSync(RAW, "utf8");
  const predecessorManifestText = fs.readFileSync(MANIFEST, "utf8");
  const retained = JSON.parse(predecessorRawText);
  const retainedManifest = JSON.parse(predecessorManifestText);
  const retainedManifestBase = { ...retainedManifest };
  delete retainedManifestBase.aggregateSha256;
  if (retainedManifest.rawSha256 !== sha256(predecessorRawText)
      || retainedManifest.aggregateSha256 !== sha256(canonical(retainedManifestBase))) {
    throw new SafeFailure("OFFLINE_PREDECESSOR_INTEGRITY_FAILED");
  }
  if (retained.pin?.number !== "25620723"
      || retained.pin?.hash?.toLowerCase() !== "0x494176ccdccc05834402ea4edf771c358390710d357fc3c19cc3a05c8423c814"
      || retained.deployments?.allImplementationAddressesMatched !== true
      || retained.deployments?.allLinksMatched !== true
      || retained.currentState?.permissionlessSurface?.currentMaximumZeroShareDepositAccepted !== false) {
    throw new SafeFailure("OFFLINE_RETAINED_FACTS_FAILED");
  }

  const predecessor = {
    rawSha256: retainedManifest.rawSha256,
    manifestAggregateSha256: retainedManifest.aggregateSha256,
    runnerSha256: retainedManifest.runnerSha256
  };
  const rootPredecessor = retainedManifest.rootPredecessor || retainedManifest.predecessor || null;
  const revised = structuredClone(retained);
  revised.schemaVersion = 2;
  revised.revisedAt = new Date().toISOString();
  revised.revision = {
    id: "oracle-final-p0p1-helper-two-transaction-r2",
    mode: "OFFLINE_REPACKAGE_RETAINED_FIXED_PIN",
    predecessorRawSha256: predecessor.rawSha256,
    predecessorManifestAggregateSha256: predecessor.manifestAggregateSha256,
    supersedesRevision: retained.revision?.id || null,
    fixedPinFactsReused: true,
    networkAccess: false,
    rpcCalls: 0,
    endpointInventoryRead: false,
    fork: false,
    signing: false,
    liveAction: false
  };
  revised.classification = "CLEAN/DEPLOYED-CONTINUITY-BOUND/CURRENT-DUST-DEPOSIT-REVERTS/CURRENT-CAPTURE-ZERO";
  revised.rpcBudget.retainedCaptureOnly = true;
  revised.rpcBudget.revisionRpcCalls = 0;
  revised.economics = correctedEconomics({
    maximumZeroShareAmount: revised.currentState.stethShareRate.maximumPooledAmountMovingZeroTokenShares,
    fixedPinBaseFeePerGasWei: revised.pin.baseFeePerGasWei,
    currentDustDepositAccepted: revised.currentState.permissionlessSurface.currentMaximumZeroShareDepositAccepted,
    strategyBalance: revised.currentState.stethStrategy.stethBalance,
    strategyTotalShares: revised.currentState.stethStrategy.totalShares,
    internalEther: revised.currentState.stethShareRate.internalEtherNumerator,
    internalShares: revised.currentState.stethShareRate.internalSharesDenominator,
    pooledPerOneTokenShare: revised.currentState.stethShareRate.pooledEtherPerOneTokenShare,
    withdrawalDelay: revised.currentState.delegationManager.minWithdrawalDelayBlocks
  });
  revised.blockers = [
    "No reproducible runtime-to-source bytecode compilation/equality proof; continuity is authoritative-address-artifact plus live implementation binding.",
    "No state-changing execution, estimateGas, fork, or current-user transaction simulation was performed.",
    "Hypothetical helper batching economics are unresolved because no defensible per-deposit execution-gas lower bound or block-gas batching cap was derived.",
    "Exact P0/P1 gain is a conditional future case depending on an exogenous rebase during the queue delay, large nominal capital, and two attacker protocol-path transactions.",
    "Delegated/non-unit-DSF/slashed depositor variants were not needed to establish the current NewSharesZero blocker."
  ];
  revised.stopAdvance = {
    stop: "STOP_CURRENT_DUST_BRANCH_DEPOSIT_REVERTS_CURRENT_CAPTURE_ZERO",
    advance: "If StrategyBase one-wei mint becomes nonzero or relevant state/code changes, derive defensible per-deposit execution gas and a block-gas batching cap before any hypothetical economics conclusion."
  };
  revised.safety = {
    ...revised.safety,
    offlineRevisionOnly: true,
    revisionNetworkAccess: false,
    revisionRpcCalls: 0,
    revisionEndpointInventoryRead: false
  };

  fs.writeFileSync(RAW, `${JSON.stringify(revised, null, 2)}\n`);
  const manifestBase = {
    schemaVersion: 2,
    revision: revised.revision,
    predecessor,
    rootPredecessor,
    rawPath: path.relative(ROOT, RAW).replace(/\\/g, "/"),
    rawSha256: fileSha256(RAW),
    runnerPath: path.relative(ROOT, __filename).replace(/\\/g, "/"),
    runnerSha256: fileSha256(__filename),
    sourceCommitments: retainedManifest.sourceCommitments,
    pinCommitment: sha256(canonical(revised.pin)),
    providerFamilyCommitments: revised.providerEvidence.families.map(f => f.commitment),
    safety: revised.safety
  };
  const manifest = { ...manifestBase, aggregateSha256: sha256(canonical(manifestBase)) };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: revised.revision.mode,
    pinNumber: revised.pin.number,
    pinHash: revised.pin.hash,
    revisionRpcCalls: 0,
    continuityBound: true,
    currentCaptureZero: true,
    hypotheticalBatchingEconomicsResolved: false,
    routePositive: 0,
    aggregateSha256: manifest.aggregateSha256
  })}\n`);
}

if (require.main === module) {
  const operation = process.argv.includes("--offline-revise-existing")
    ? Promise.resolve().then(reviseRetainedArtifactsOffline)
    : main();
  operation.catch(error => {
    const code = error instanceof SafeFailure ? error.code : "UNCLASSIFIED_RUNNER_FAILURE";
    process.stderr.write(`RUNNER_FAILED:${code}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  canonical,
  ceilDiv,
  correctedEconomics,
  normalize,
  parseInventory,
  sha256,
  simulateDustBatch,
  slotAddress
};
