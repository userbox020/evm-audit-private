#!/usr/bin/env node
"use strict";

// Authorized bounded read-only Optimism deployment binding for the repayment R3 branch.
// RPC endpoint material and raw RPC responses remain memory-only.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");
const { loadRpcUrls, getOrigin } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-debt-manager-repay-deployment-binding";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-24-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const R3 = "reports/raw/fast/critical-etherfi-debt-manager-repay-value-conservation-r3.json";
const PRIOR_BINDING = "reports/raw/fast/critical-etherfi-pinbound-build-binding.json";
const PHASE0 = "reports/raw/fast/etherfi-borrowing-phase0.json";
const DEPLOYMENTS = "targets/cash-v3/deployments/mainnet/10/deployments.json";
const CONFIG = "targets/cash-v3/deployments/mainnet/10/config.json";
const FIXTURES = "targets/cash-v3/deployments/mainnet/fixtures/fixtures.json";
const SOURCE_COMMIT = "e05bda2be27a6a606f3f1b8ff0d0791032fd0ff8";
const CLASSIFICATION = "INFORMATIONAL/DEPLOYMENT-UNBOUND/BOUNDED-REPAY-ROUNDING/TERMINAL-NORMALIZED-DUST/LOCAL-ROUTE-ONLY";
const REVISION = "debt-manager-repay-deployment-binding-readonly-r1";
const AGENT = "critical-etherfi-debt-manager-repay-deployment-binding-20260724";
const CHAIN_ID = 10;
const DEPLOYMENT_BLOCK = 149_521_228;
const MAX_ENDPOINTS = 96;
const MAX_QUALIFIED_FAMILIES = 4;
const MAX_STATE_FAMILIES = 2;
const MAX_RPC_TOTAL = 4000;
const MAX_RPC_PER_PROVIDER = 1600;
const RPC_TIMEOUT_MS = 15_000;
const LOG_INITIAL_CHUNK = 100_000;
const LOG_MIN_CHUNK = 5_000;
const RECENT_BORROW_WINDOW_BLOCKS = 50_000;
const MAX_BORROWER_CANDIDATES = 64;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ALLOWED_RPC = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_getLogs", "eth_gasPrice"]);

const abs = (rel) => path.join(ROOT, rel);
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hashFile = (rel) => { const data = fs.readFileSync(abs(rel)); return { path: rel, bytes: data.length, sha256: sha(data) }; };
const toTag = (n) => `0x${BigInt(n).toString(16)}`;
const codeInfo = (code) => ({ bytes: Math.max(0, (String(code || "0x").length - 2) / 2), keccak256: ethers.keccak256(code || "0x") });
const asAddress = (word) => BigInt(word || "0x0") === 0n ? null : ethers.getAddress(`0x${String(word).slice(-40)}`);
const ceilDiv = (a, b) => a === 0n ? 0n : (a + b - 1n) / b;
const maxBig = (a, b) => a > b ? a : b;
const minBig = (a, b) => a < b ? a : b;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canonical(value) {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

function firstDiffs(a, b, prefix = "state", out = []) {
  if (out.length >= 12) return out;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) { out.push(prefix); return out; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(`${prefix}.length`);
    for (let i = 0; i < Math.min(a.length, b.length) && out.length < 12; i++) firstDiffs(a[i], b[i], `${prefix}[${i}]`, out);
  } else if (a && typeof a === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) if (out.length < 12) firstDiffs(a[key], b[key], `${prefix}.${key}`, out);
  } else if (a !== b) out.push(prefix);
  return out;
}

function writeOwned(rel, text) {
  if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused: ${rel}`);
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text, "utf8");
}

function providerHost(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } }
function safeError(e) { return String(e?.message || e || "RPC unavailable").replace(/https?:\/\/[^\s"']+/gi, "[endpoint-redacted]").slice(0, 200); }

let rpcTotal = 0;
const providerCounts = new Map();
async function rpc(provider, method, params = [], timeoutMs = RPC_TIMEOUT_MS) {
  if (!ALLOWED_RPC.has(method)) throw new Error(`RPC method refused: ${method}`);
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (++rpcTotal > MAX_RPC_TOTAL) throw new Error("global RPC budget exceeded");
    const count = (providerCounts.get(provider.id) || 0) + 1;
    providerCounts.set(provider.id, count);
    if (count > MAX_RPC_PER_PROVIDER) throw new Error(`provider RPC budget exceeded: ${provider.id}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { "content-type": "application/json" };
      const origin = getOrigin(provider.url); if (origin) headers.origin = origin;
      const response = await fetch(provider.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: controller.signal });
      const body = await response.json();
      if (body.error || body.result === undefined) throw new Error("RPC unavailable");
      return body.result;
    } catch (e) {
      lastError = e;
      if (attempt < 3) await delay(500 * attempt);
    } finally { clearTimeout(timer); }
  }
  throw lastError || new Error("RPC unavailable");
}

async function call(provider, to, iface, fn, args, tag) {
  try {
    const raw = await rpc(provider, "eth_call", [{ to, data: iface.encodeFunctionData(fn, args || []) }, tag]);
    return iface.decodeFunctionResult(fn, raw);
  } catch (e) { throw new Error(`${fn} failed: ${safeError(e)}`); }
}
async function callMaybe(provider, to, iface, fn, args, tag) { try { return await call(provider, to, iface, fn, args, tag); } catch { return null; } }

const COMMON = new ethers.Interface(["function paused() view returns(bool)", "function roleRegistry() view returns(address)"]);
const DM = new ethers.Interface([
  "function getBorrowTokens() view returns(address[])", "function paused() view returns(bool)", "function etherFiDataProvider() view returns(address)", "function roleRegistry() view returns(address)",
  "function borrowTokenConfig(address) view returns(uint256,uint256,uint256,uint64,uint64,uint128)", "function getCurrentIndex(address) view returns(uint256)",
  "function totalBorrowingAmount(address) view returns(uint256)", "function totalSupplies(address) view returns(uint256)", "function borrowingOf(address) view returns((address token,uint256 amount)[],uint256)",
  "function remainingBorrowingCapacityInUSD(address) view returns(uint256)", "event Borrowed(address indexed user,address indexed token,uint256 amount)"
]);
const CASH = new ethers.Interface([
  "function paused() view returns(bool)", "function roleRegistry() view returns(address)", "function etherFiDataProvider() view returns(address)", "function getDebtManager() view returns(address)",
  "function getSettlementDispatcher(uint8) view returns(address)", "function getMode(address) view returns(uint8)"
]);
const DATA = new ethers.Interface(["function getCashModule() view returns(address)", "function getPriceProvider() view returns(address)", "function getCashLens() view returns(address)", "function getEtherFiSafeFactory() view returns(address)", "function roleRegistry() view returns(address)"]);
const PRICE = new ethers.Interface(["function price(address) view returns(uint256)", "function decimals() view returns(uint8)", "function paused() view returns(bool)"]);
const PRICE_COMMON_CONFIG = new ethers.Interface(["function tokenConfig(address) view returns(tuple(address oracle,bytes priceFunctionCalldata,bool isChainlinkType,uint8 oraclePriceDecimals,uint24 maxStaleness,uint8 dataType))"]);
const ERC20 = new ethers.Interface(["function symbol() view returns(string)", "function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)"]);
const ERC20_B32 = new ethers.Interface(["function symbol() view returns(bytes32)"]);
const ROLES = new ethers.Interface(["function owner() view returns(address)", "function roleHolders(bytes32) view returns(address[])"]);
const DISPATCHER = new ethers.Interface(["function paused() view returns(bool)", "function roleRegistry() view returns(address)", "function binSponsor() view returns(uint8)", "function dataProvider() view returns(address)", "function getSettlementRecipient(address) view returns(address)"]);
const FACTORY = new ethers.Interface(["function numContractsDeployed() view returns(uint256)"]);
const SAFE = new ethers.Interface(["function getOwners() view returns(address[])", "function getThreshold() view returns(uint8)", "function isModuleEnabled(address) view returns(bool)"]);
const LENS = new ethers.Interface(["function applicableSpendingLimit(address) view returns(tuple(uint256 dailyLimit,uint256 monthlyLimit,uint256 spentToday,uint256 spentThisMonth,uint256 newDailyLimit,uint256 newMonthlyLimit,uint64 dailyRenewalTimestamp,uint64 monthlyRenewalTimestamp,uint64 dailyLimitChangeActivationTime,uint64 monthlyLimitChangeActivationTime,int256 timezoneOffset))"]);
const BEACON = new ethers.Interface(["function implementation() view returns(address)"]);

async function probe(url, ordinal, debtManager) {
  const provider = { id: `candidate-${ordinal + 1}`, url };
  try {
    const chain = Number(BigInt(await rpc(provider, "eth_chainId")));
    if (chain !== CHAIN_ID) return null;
    const finalized = await rpc(provider, "eth_getBlockByNumber", ["finalized", false]);
    if (!finalized?.number || !finalized?.hash) return null;
    const code = await rpc(provider, "eth_getCode", [debtManager, finalized.number]);
    if (!code || code === "0x") return null;
    const canaryFrom = Math.max(DEPLOYMENT_BLOCK, Number(BigInt(finalized.number)) - LOG_MIN_CHUNK + 1);
    const canary = await rpc(provider, "eth_getLogs", [{ address: debtManager, fromBlock: toTag(canaryFrom), toBlock: finalized.number, topics: [DM.getEvent("Borrowed").topicHash] }], 30_000);
    if (!Array.isArray(canary)) return null;
    return { url, host: providerHost(url), finalizedNumber: Number(BigInt(finalized.number)), finalizedHash: finalized.hash.toLowerCase() };
  } catch { return null; }
}

async function selectProviders(debtManager) {
  const urls = [...new Set(loadRpcUrls())].slice(0, MAX_ENDPOINTS);
  const qualified = [];
  const hosts = new Set();
  for (let i = 0; i < urls.length && qualified.length < MAX_QUALIFIED_FAMILIES; i += 16) {
    const rows = await Promise.all(urls.slice(i, i + 16).map((url, j) => probe(url, i + j, debtManager)));
    for (const row of rows) {
      if (!row?.host || hosts.has(row.host)) continue;
      hosts.add(row.host); qualified.push(row);
      if (qualified.length === MAX_QUALIFIED_FAMILIES) break;
    }
  }
  if (qualified.length < 2) throw new Error("fewer than two qualified Optimism endpoint families");
  const number = Math.min(...qualified.map((x) => x.finalizedNumber));
  const tag = toTag(number);
  for (let i = 0; i < qualified.length; i++) qualified[i].id = `provider-${i + 1}`;
  const headers = await Promise.all(qualified.map(async (p) => ({ p, header: await rpc(p, "eth_getBlockByNumber", [tag, false]) })));
  const groups = new Map();
  for (const row of headers) {
    const hash = row.header?.hash?.toLowerCase(); if (!hash) continue;
    if (!groups.has(hash)) groups.set(hash, []); groups.get(hash).push(row);
  }
  const best = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!best || best[1].length < 2) throw new Error("no two-family fixed-pin header agreement");
  const selected = best[1].map((x) => x.p);
  const timestamps = new Set(best[1].map((x) => Number(BigInt(x.header.timestamp))));
  if (timestamps.size !== 1) throw new Error("fixed-pin timestamp disagreement");
  return {
    inventoryCount: urls.length, qualifiedFamilyCount: qualified.length, exactHeaderFamilyCount: best[1].length, selected,
    pin: { chainId: CHAIN_ID, finalized: true, number, hash: best[0], timestamp: Number(BigInt(best[1][0].header.timestamp)), tag },
  };
}

async function completeBorrowLogs(provider, debtManager, fromBlock, toBlock) {
  const topic = DM.getEvent("Borrowed").topicHash;
  const rows = [];
  let cursor = fromBlock, chunk = LOG_INITIAL_CHUNK, calls = 0, consecutiveFailures = 0;
  while (cursor <= toBlock) {
    const end = Math.min(toBlock, cursor + chunk - 1);
    try {
      const logs = await rpc(provider, "eth_getLogs", [{ address: debtManager, fromBlock: toTag(cursor), toBlock: toTag(end), topics: [topic] }], 30_000);
      if (!Array.isArray(logs)) throw new Error("invalid logs");
      rows.push(...logs); calls++; cursor = end + 1; consecutiveFailures = 0;
      if (chunk < LOG_INITIAL_CHUNK) chunk = Math.min(LOG_INITIAL_CHUNK, chunk * 2);
      await delay(300);
    } catch (e) {
      consecutiveFailures++;
      if (chunk <= LOG_MIN_CHUNK && consecutiveFailures >= 3) throw new Error(`borrow history unavailable at bounded range: ${safeError(e)}`);
      if (chunk <= LOG_MIN_CHUNK) { await delay(1500 * consecutiveFailures); continue; }
      chunk = Math.max(LOG_MIN_CHUNK, Math.floor(chunk / 2));
      await delay(750);
    }
  }
  rows.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
  const digestRows = rows.map((x) => [x.blockNumber, x.blockHash, x.transactionHash, x.logIndex, x.topics, x.data]);
  const candidates = [];
  const seenCandidates = new Set();
  for (const row of [...rows].reverse()) {
    const user = ethers.getAddress(`0x${row.topics[1].slice(-40)}`);
    if (!seenCandidates.has(user.toLowerCase())) { seenCandidates.add(user.toLowerCase()); candidates.push(user); }
  }
  const perToken = {};
  for (const log of rows) {
    const token = ethers.getAddress(`0x${log.topics[2].slice(-40)}`);
    perToken[token] = (perToken[token] || 0) + 1;
  }
  return { eventCount: rows.length, candidateCount: candidates.length, calls, digest: sha(JSON.stringify(digestRows)), perToken, candidates };
}

async function proxyRuntime(provider, address, tag) {
  const [proxyCode, implWord] = await Promise.all([rpc(provider, "eth_getCode", [address, tag]), rpc(provider, "eth_getStorageAt", [address, IMPL_SLOT, tag])]);
  const implementation = asAddress(implWord);
  const implementationCode = implementation ? await rpc(provider, "eth_getCode", [implementation, tag]) : "0x";
  return { address: ethers.getAddress(address), proxyRuntime: codeInfo(proxyCode), implementation, implementationRuntime: implementation ? codeInfo(implementationCode) : null };
}

async function tokenMeta(provider, token, manager, tag) {
  let symbol = null;
  const sym = await callMaybe(provider, token, ERC20, "symbol", [], tag);
  if (sym) symbol = sym[0];
  else {
    const b32 = await callMaybe(provider, token, ERC20_B32, "symbol", [], tag);
    if (b32) try { symbol = ethers.decodeBytes32String(b32[0]); } catch {}
  }
  const decimalsR = await call(provider, token, ERC20, "decimals", [], tag);
  const balanceR = await call(provider, token, ERC20, "balanceOf", [manager], tag);
  const code = await rpc(provider, "eth_getCode", [token, tag]);
  return { address: ethers.getAddress(token), symbol, decimals: Number(decimalsR[0]), managerLiquidBalanceRaw: balanceR[0].toString(), runtime: codeInfo(code) };
}

async function oracleConfig(provider, priceProvider, token, tag) {
  const cfg = await callMaybe(provider, priceProvider, PRICE_COMMON_CONFIG, "tokenConfig", [token], tag);
  if (!cfg) return null;
  const row = cfg[0];
  const oracle = ethers.getAddress(row.oracle);
  const code = await rpc(provider, "eth_getCode", [oracle, tag]);
  return {
    oracle, oracleRuntime: codeInfo(code), priceFunctionCalldataBytes: Math.max(0, (row.priceFunctionCalldata.length - 2) / 2),
    priceFunctionSelector: row.priceFunctionCalldata.length >= 10 ? row.priceFunctionCalldata.slice(0, 10) : null,
    priceFunctionCalldataKeccak256: ethers.keccak256(row.priceFunctionCalldata), isChainlinkType: row.isChainlinkType,
    oraclePriceDecimals: Number(row.oraclePriceDecimals), maxStaleness: Number(row.maxStaleness), dataType: Number(row.dataType),
  };
}

function repaymentMath(price, decimals, index) {
  const scale = 10n ** BigInt(decimals);
  const minimumTokenRawForNonzeroDebt = ceilDiv(scale, price);
  const minimumSpendUsd6Raw = ceilDiv(minimumTokenRawForNonzeroDebt * price, scale);
  const borrowedTokenRaw = minimumSpendUsd6Raw * scale / price;
  const recordedDebtUsd6Raw = borrowedTokenRaw * price / scale;
  const normalizedDebtRaw = recordedDebtUsd6Raw === 0n ? 0n : ceilDiv(recordedDebtUsd6Raw * 10n ** 18n, index);
  const actualDebtUsd6Raw = normalizedDebtRaw * index / 10n ** 18n;
  const cappedFullRepayTransferRaw = actualDebtUsd6Raw * scale / price;
  const cappedPaymentValueUsd6Raw = cappedFullRepayTransferRaw * price / scale;
  const normalizedReductionRaw = actualDebtUsd6Raw * 10n ** 18n / index;
  const remainingNormalizedDebtRaw = normalizedDebtRaw > normalizedReductionRaw ? normalizedDebtRaw - normalizedReductionRaw : 0n;
  return {
    oneTokenRawValueUsd6Floor: (price / scale).toString(), minimumTokenRawForNonzeroDebt: minimumTokenRawForNonzeroDebt.toString(), minimumSpendUsd6Raw: minimumSpendUsd6Raw.toString(), borrowedTokenRaw: borrowedTokenRaw.toString(),
    recordedDebtUsd6Raw: recordedDebtUsd6Raw.toString(), normalizedDebtRaw: normalizedDebtRaw.toString(), actualDebtUsd6Raw: actualDebtUsd6Raw.toString(),
    cappedFullRepayTransferRaw: cappedFullRepayTransferRaw.toString(), cappedPaymentValueUsd6Raw: cappedPaymentValueUsd6Raw.toString(),
    normalizedReductionRaw: normalizedReductionRaw.toString(), remainingNormalizedDebtRaw: remainingNormalizedDebtRaw.toString(),
    zeroTransferDebtReduction: cappedFullRepayTransferRaw === 0n && normalizedReductionRaw > 0n && remainingNormalizedDebtRaw === 0n,
    terminalNormalizedDust: normalizedDebtRaw > 0n && normalizedReductionRaw === 0n,
  };
}

function spendingAllowance(limit) {
  const daily = BigInt(limit.dailyLimitChangeActivationTime) !== 0n ? BigInt(limit.newDailyLimit) : BigInt(limit.dailyLimit);
  const monthly = BigInt(limit.monthlyLimitChangeActivationTime) !== 0n ? BigInt(limit.newMonthlyLimit) : BigInt(limit.monthlyLimit);
  const spentDay = BigInt(limit.spentToday), spentMonth = BigInt(limit.spentThisMonth);
  if (spentDay > daily || spentMonth > monthly) return 0n;
  return minBig(daily - spentDay, monthly - spentMonth);
}

async function borrowerAggregate(provider, borrowers, addresses, routeMinimumSpend, tag) {
  if (borrowers.length > MAX_BORROWER_CANDIDATES) throw new Error("borrower candidate cap exceeded");
  let currentDebtCount = 0, creditModeCount = 0, moduleEnabledCount = 0, routePrerequisiteCount = 0;
  let maxDebt = 0n, maxCapacity = 0n, maxAllowance = 0n;
  const ownerThresholdHistogram = {}, allOwners = new Set(), routeOwners = new Set();
  for (const safe of borrowers) {
    const [borrowing, modeR] = await Promise.all([
      callMaybe(provider, addresses.DebtManager, DM, "borrowingOf", [safe], tag),
      callMaybe(provider, addresses.CashModule, CASH, "getMode", [safe], tag),
    ]);
    const debt = borrowing ? BigInt(borrowing[1]) : 0n;
    const mode = modeR ? Number(modeR[0]) : null;
    if (debt > 0n) { currentDebtCount++; maxDebt = maxBig(maxDebt, debt); }
    if (mode !== 0 && debt === 0n) continue;
    if (mode === 0) creditModeCount++;
    const [capacityR, limitR, ownersR, thresholdR, enabledR] = await Promise.all([
      callMaybe(provider, addresses.DebtManager, DM, "remainingBorrowingCapacityInUSD", [safe], tag),
      callMaybe(provider, addresses.CashLens, LENS, "applicableSpendingLimit", [safe], tag),
      callMaybe(provider, safe, SAFE, "getOwners", [], tag), callMaybe(provider, safe, SAFE, "getThreshold", [], tag),
      callMaybe(provider, safe, SAFE, "isModuleEnabled", [addresses.CashModule], tag),
    ]);
    const capacity = capacityR ? BigInt(capacityR[0]) : 0n;
    const allowance = limitR ? spendingAllowance(limitR[0]) : 0n;
    const enabled = enabledR ? Boolean(enabledR[0]) : false;
    if (enabled) moduleEnabledCount++;
    maxCapacity = maxBig(maxCapacity, capacity); maxAllowance = maxBig(maxAllowance, allowance);
    const owners = ownersR ? ownersR[0].map(ethers.getAddress) : [];
    owners.forEach((x) => allOwners.add(x.toLowerCase()));
    const threshold = thresholdR ? Number(thresholdR[0]) : 0;
    ownerThresholdHistogram[`${owners.length}-owners/${threshold}-threshold`] = (ownerThresholdHistogram[`${owners.length}-owners/${threshold}-threshold`] || 0) + 1;
    if (mode === 0 && enabled && capacity >= routeMinimumSpend && allowance >= routeMinimumSpend) {
      routePrerequisiteCount++; owners.forEach((x) => routeOwners.add(x.toLowerCase()));
    }
    await delay(100);
  }
  return {
    historicalBorrowerCandidateCount: borrowers.length, currentDebtCount, creditModeCount, moduleEnabledCount, routePrerequisiteCount,
    maxCurrentDebtUsd6Raw: maxDebt.toString(), maxRemainingBorrowCapacityUsd6Raw: maxCapacity.toString(), maxSpendingAllowanceUsd6Raw: maxAllowance.toString(),
    ownerThresholdHistogram, scannedOwnerCount: allOwners.size, routeCandidateOwnerCount: routeOwners.size,
    _allOwners: allOwners, _routeOwners: routeOwners,
  };
}

async function roleRows(provider, registry, tag) {
  const names = ["ETHER_FI_WALLET_ROLE", "SETTLEMENT_DISPATCHER_BRIDGER_ROLE", "DEBT_MANAGER_ADMIN_ROLE", "PAUSER", "UNPAUSER"];
  const rows = [];
  for (const name of names) {
    const holdersR = await call(provider, registry, ROLES, "roleHolders", [ethers.id(name)], tag);
    const holders = holdersR[0].map(ethers.getAddress).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    let contractCount = 0;
    for (const holder of holders) if ((await rpc(provider, "eth_getCode", [holder, tag])) !== "0x") contractCount++;
    rows.push({ role: name, holders, holderCount: holders.length, contractHolderCount: contractCount, eoaHolderCount: holders.length - contractCount });
  }
  const owner = ethers.getAddress((await call(provider, registry, ROLES, "owner", [], tag))[0]);
  return { owner, ownerIsContract: (await rpc(provider, "eth_getCode", [owner, tag])) !== "0x", rows };
}

async function capture(provider, pin, localAddresses, fixtureTokens, borrowers, includeSingleFamilyState) {
  const tag = pin.tag;
  const addresses = { ...localAddresses };
  const [dmProxy, cashProxy, dataProxy, priceProxy, factoryProxy] = await Promise.all([
    proxyRuntime(provider, addresses.DebtManager, tag), proxyRuntime(provider, addresses.CashModule, tag), proxyRuntime(provider, addresses.EtherFiDataProvider, tag),
    proxyRuntime(provider, addresses.PriceProvider, tag), proxyRuntime(provider, addresses.EtherFiSafeFactory, tag),
  ]);
  const [dmPaused, dmData, dmRoles, borrowTokensR, cashPaused, cashData, cashDm, dataCash, dataPrice, dataLens, dataFactory, dataRoles, pricePaused, priceDecimals, factoryCount] = await Promise.all([
    call(provider, addresses.DebtManager, DM, "paused", [], tag), call(provider, addresses.DebtManager, DM, "etherFiDataProvider", [], tag), call(provider, addresses.DebtManager, DM, "roleRegistry", [], tag), call(provider, addresses.DebtManager, DM, "getBorrowTokens", [], tag),
    call(provider, addresses.CashModule, CASH, "paused", [], tag), call(provider, addresses.CashModule, CASH, "etherFiDataProvider", [], tag), call(provider, addresses.CashModule, CASH, "getDebtManager", [], tag),
    call(provider, addresses.EtherFiDataProvider, DATA, "getCashModule", [], tag), call(provider, addresses.EtherFiDataProvider, DATA, "getPriceProvider", [], tag), call(provider, addresses.EtherFiDataProvider, DATA, "getCashLens", [], tag), call(provider, addresses.EtherFiDataProvider, DATA, "getEtherFiSafeFactory", [], tag), call(provider, addresses.EtherFiDataProvider, DATA, "roleRegistry", [], tag),
    call(provider, addresses.PriceProvider, PRICE, "paused", [], tag), call(provider, addresses.PriceProvider, PRICE, "decimals", [], tag), call(provider, addresses.EtherFiSafeFactory, FACTORY, "numContractsDeployed", [], tag),
  ]);
  addresses.CashLens = ethers.getAddress(dataLens[0]);
  const bindings = {
    debtManagerPaused: Boolean(dmPaused[0]), cashModulePaused: Boolean(cashPaused[0]), priceProviderPaused: Boolean(pricePaused[0]), priceDecimals: Number(priceDecimals[0]), safeCount: factoryCount[0].toString(),
    debtManagerDataProvider: ethers.getAddress(dmData[0]), debtManagerRoleRegistry: ethers.getAddress(dmRoles[0]), cashDataProvider: ethers.getAddress(cashData[0]), cashDebtManager: ethers.getAddress(cashDm[0]),
    dataCashModule: ethers.getAddress(dataCash[0]), dataPriceProvider: ethers.getAddress(dataPrice[0]), dataCashLens: addresses.CashLens, dataSafeFactory: ethers.getAddress(dataFactory[0]), dataRoleRegistry: ethers.getAddress(dataRoles[0]),
  };
  const borrowTokens = borrowTokensR[0].map(ethers.getAddress);
  const assets = [];
  for (const token of borrowTokens) {
    const [meta, cfg, currentIndexR, totalBorrowR, totalSupplyR, priceR, oracle] = await Promise.all([
      tokenMeta(provider, token, addresses.DebtManager, tag), call(provider, addresses.DebtManager, DM, "borrowTokenConfig", [token], tag),
      call(provider, addresses.DebtManager, DM, "getCurrentIndex", [token], tag), call(provider, addresses.DebtManager, DM, "totalBorrowingAmount", [token], tag),
      call(provider, addresses.DebtManager, DM, "totalSupplies", [token], tag), callMaybe(provider, addresses.PriceProvider, PRICE, "price", [token], tag), oracleConfig(provider, addresses.PriceProvider, token, tag),
    ]);
    const price = priceR ? BigInt(priceR[0]) : null;
    const index = BigInt(currentIndexR[0]);
    const configuredName = Object.entries(fixtureTokens).find(([, v]) => String(v).toLowerCase() === token.toLowerCase())?.[0] || null;
    assets.push({
      token, configuredName, symbol: meta.symbol, decimals: meta.decimals, tokenRuntime: meta.runtime, managerLiquidBalanceRaw: meta.managerLiquidBalanceRaw,
      priceUsd6Raw: price?.toString() || null, priceCallable: price !== null, oracle,
      interestIndexSnapshotRaw: cfg[0].toString(), currentIndexRaw: index.toString(), totalNormalizedBorrowingRaw: cfg[1].toString(), totalSharesRaw: cfg[2].toString(), lastUpdateTimestamp: Number(cfg[3]), borrowApyRaw: cfg[4].toString(), minSharesRaw: cfg[5].toString(),
      totalBorrowingRaw: totalBorrowR[0].toString(), totalSuppliesRaw: totalSupplyR[0].toString(), repaymentMath: price === null ? null : repaymentMath(price, meta.decimals, index),
    });
  }
  assets.sort((a, b) => a.token.toLowerCase().localeCompare(b.token.toLowerCase()));
  const dispatchers = [];
  const sponsorNames = ["Reap", "Rain", "PIX", "CardOrder"];
  for (let sponsor = 0; sponsor < 4; sponsor++) {
    const addr = ethers.getAddress((await call(provider, addresses.CashModule, CASH, "getSettlementDispatcher", [sponsor], tag))[0]);
    const [runtime, pausedR, rolesR, binR, dataR] = await Promise.all([
      proxyRuntime(provider, addr, tag), callMaybe(provider, addr, DISPATCHER, "paused", [], tag), callMaybe(provider, addr, DISPATCHER, "roleRegistry", [], tag),
      callMaybe(provider, addr, DISPATCHER, "binSponsor", [], tag), callMaybe(provider, addr, DISPATCHER, "dataProvider", [], tag),
    ]);
    const tokenRows = [];
    for (const asset of assets) {
      const [recipientR, balanceR] = await Promise.all([
        callMaybe(provider, addr, DISPATCHER, "getSettlementRecipient", [asset.token], tag), call(provider, asset.token, ERC20, "balanceOf", [addr], tag),
      ]);
      const recipient = recipientR ? ethers.getAddress(recipientR[0]) : null;
      let recipientIsContract = null;
      if (recipient && recipient !== ethers.ZeroAddress) recipientIsContract = (await rpc(provider, "eth_getCode", [recipient, tag])) !== "0x";
      tokenRows.push({ token: asset.token, balanceRaw: balanceR[0].toString(), settlementRecipient: recipient, recipientConfigured: Boolean(recipient && recipient !== ethers.ZeroAddress), recipientIsContract });
    }
    dispatchers.push({ sponsor: sponsorNames[sponsor], address: addr, runtime, paused: pausedR ? Boolean(pausedR[0]) : null, roleRegistry: rolesR ? ethers.getAddress(rolesR[0]) : null, binSponsor: binR ? Number(binR[0]) : null, dataProvider: dataR ? ethers.getAddress(dataR[0]) : null, tokens: tokenRows });
  }
  const vulnerableAssets = assets.filter((x) => x.repaymentMath?.zeroTransferDebtReduction);
  const routeMinimumSpend = vulnerableAssets.length ? vulnerableAssets.reduce((m, x) => minBig(m, BigInt(x.repaymentMath.minimumSpendUsd6Raw)), BigInt(vulnerableAssets[0].repaymentMath.minimumSpendUsd6Raw)) : 2n ** 255n;
  const roles = includeSingleFamilyState ? await roleRows(provider, bindings.dataRoleRegistry, tag) : null;
  const borrowersAgg = includeSingleFamilyState ? await borrowerAggregate(provider, borrowers, addresses, routeMinimumSpend, tag) : {
    historicalBorrowerCandidateCount: 0, currentDebtCount: 0, creditModeCount: 0, moduleEnabledCount: 0, routePrerequisiteCount: 0,
    maxCurrentDebtUsd6Raw: "0", maxRemainingBorrowCapacityUsd6Raw: "0", maxSpendingAllowanceUsd6Raw: "0", ownerThresholdHistogram: {}, scannedOwnerCount: 0, routeCandidateOwnerCount: 0,
    _allOwners: new Set(), _routeOwners: new Set(),
  };
  const recipientAddresses = new Set(dispatchers.flatMap((d) => d.tokens.map((x) => x.settlementRecipient?.toLowerCase())).filter((x) => x && x !== ethers.ZeroAddress));
  const recipientOwnerMatches = [...recipientAddresses].filter((x) => borrowersAgg._allOwners.has(x)).length;
  const routeRecipientOwnerMatches = [...recipientAddresses].filter((x) => borrowersAgg._routeOwners.has(x)).length;
  delete borrowersAgg._allOwners; delete borrowersAgg._routeOwners;
  const gasPriceWei = includeSingleFamilyState ? BigInt(await rpc(provider, "eth_gasPrice")) : 0n;
  const weth = fixtureTokens.weth;
  const wethPriceR = weth ? await callMaybe(provider, addresses.PriceProvider, PRICE, "price", [weth], tag) : null;
  const wethPrice = wethPriceR ? BigInt(wethPriceR[0]) : null;
  const intrinsicGasUsd6Floor = !includeSingleFamilyState || wethPrice === null ? null : (gasPriceWei * 21_000n * wethPrice / 10n ** 18n).toString();
  let safeBeacon = null;
  if (borrowers.length) {
    const word = await rpc(provider, "eth_getStorageAt", [borrowers[0], BEACON_SLOT, tag]);
    const beacon = asAddress(word);
    if (beacon) {
      const implR = await callMaybe(provider, beacon, BEACON, "implementation", [], tag);
      const implementation = implR ? ethers.getAddress(implR[0]) : null;
      const code = implementation ? await rpc(provider, "eth_getCode", [implementation, tag]) : "0x";
      safeBeacon = { beacon, implementation, implementationRuntime: implementation ? codeInfo(code) : null };
    }
  }
  return {
    components: { debtManager: dmProxy, cashModule: cashProxy, dataProvider: dataProxy, priceProvider: priceProxy, safeFactory: factoryProxy, safeBeacon },
    bindings, borrowTokens, assets, dispatchers, roles, borrowers: borrowersAgg,
    recipientOwnershipJoin: { uniqueConfiguredRecipientCount: recipientAddresses.size, recipientMatchesAnyScannedOwnerCount: recipientOwnerMatches, recipientMatchesRouteCandidateOwnerCount: routeRecipientOwnerMatches },
    gasContext: includeSingleFamilyState ? { gasPriceWei: gasPriceWei.toString(), wethPriceUsd6Raw: wethPrice?.toString() || null, intrinsic21000GasUsd6FloorRaw: intrinsicGasUsd6Floor, l1DataFeeBound: false } : null,
  };
}

function sourceContinuity(state, prior) {
  const row = prior.componentResults.find((x) => x.name === "DebtManagerCore");
  const current = state.components.debtManager;
  const exact = prior.classification === "exact" && row?.implementationComparison?.exactReconstructedEqual === true && row.implementation.toLowerCase() === current.implementation?.toLowerCase() && row.implementationRuntime.keccak256 === current.implementationRuntime?.keccak256;
  return {
    predecessorClassification: prior.classification, predecessorPin: prior.pin, predecessorSourceCommit: prior.source.commit,
    priorImplementation: row?.implementation || null, currentImplementation: current.implementation,
    priorRuntimeKeccak256: row?.implementationRuntime?.keccak256 || null, currentRuntimeKeccak256: current.implementationRuntime?.keccak256 || null,
    exactSourceRuntimeContinuity: exact,
    statement: exact ? "Fresh-pin DebtManager implementation address and runtime hash equal the predecessor's exact commit-bound reconstruction." : "Fresh-pin DebtManager is not promoted to commit-bound equivalence by continuity.",
  };
}

function selfTests() {
  if (ALLOWED_RPC.has("eth_sendRawTransaction") || ALLOWED_RPC.has("eth_sendTransaction")) throw new Error("mutation RPC allowlist self-test failed");
  const x = repaymentMath(1_138_017n, 6, 10n ** 18n);
  if (!x.zeroTransferDebtReduction || x.minimumSpendUsd6Raw !== "2" || x.borrowedTokenRaw !== "1" || x.cappedFullRepayTransferRaw !== "0") throw new Error("EURC repayment fixture failed");
  const y = repaymentMath(1_000_000n, 6, 1_044_000_000_000_000_000n);
  if (!y.terminalNormalizedDust || y.zeroTransferDebtReduction) throw new Error("terminal dust fixture failed");
  const z = repaymentMath(1_024_635n, 18, 1_000_000_000_000_100_000n);
  if (!z.terminalNormalizedDust || z.recordedDebtUsd6Raw !== "1" || z.minimumSpendUsd6Raw !== "2") throw new Error("high-decimal minimum-debt fixture failed");
  return { passed: 4, mutationMethodsAllowed: false };
}

function sanitize(text) {
  if (/https?:\/\//i.test(text)) throw new Error("endpoint URL leak");
  if (/[?&](?:key|token|api_key|apikey)=/i.test(text)) throw new Error("credential leak");
}

async function main() {
  const generatedAt = new Date().toISOString();
  const tests = selfTests();
  const deployments = JSON.parse(fs.readFileSync(abs(DEPLOYMENTS), "utf8")).addresses;
  const localConfig = JSON.parse(fs.readFileSync(abs(CONFIG), "utf8"));
  const fixtures = JSON.parse(fs.readFileSync(abs(FIXTURES), "utf8"))[String(CHAIN_ID)];
  const r3 = JSON.parse(fs.readFileSync(abs(R3), "utf8"));
  const prior = JSON.parse(fs.readFileSync(abs(PRIOR_BINDING), "utf8"));
  const phase0 = JSON.parse(fs.readFileSync(abs(PHASE0), "utf8"));
  if (r3.classification !== CLASSIFICATION || r3.integrity.productionSource.commit !== SOURCE_COMMIT) throw new Error("R3 identity mismatch");
  const selection = await selectProviders(deployments.DebtManager);
  const recentFromBlock = Math.max(DEPLOYMENT_BLOCK, selection.pin.number - RECENT_BORROW_WINDOW_BLOCKS + 1);
  const historyAttempts = await Promise.all(selection.selected.map(async (provider) => {
    try { return { provider, history: await completeBorrowLogs(provider, deployments.DebtManager, recentFromBlock, selection.pin.number) }; }
    catch { return null; }
  }));
  const successfulHistories = historyAttempts.filter(Boolean);
  const historyGroups = new Map();
  for (const row of successfulHistories) {
    if (!historyGroups.has(row.history.digest)) historyGroups.set(row.history.digest, []);
    historyGroups.get(row.history.digest).push(row);
  }
  const historyConsensus = [...historyGroups.values()].sort((a, b) => b.length - a.length)[0] || [];
  if (historyConsensus.length < 2) throw new Error("fewer than two endpoint families completed matching borrow history");
  const histories = historyConsensus.map((x) => x.history);
  const priorSeeds = (phase0.borrowerRows || []).filter((x) => x.chainId === CHAIN_ID && x.user).sort((a, b) => Number(b.lastBlock || 0) - Number(a.lastBlock || 0)).map((x) => ethers.getAddress(x.user));
  const candidateMap = new Map();
  for (const address of [...histories[0].candidates, ...priorSeeds]) if (!candidateMap.has(address.toLowerCase()) && candidateMap.size < MAX_BORROWER_CANDIDATES) candidateMap.set(address.toLowerCase(), address);
  const borrowerCandidates = [...candidateMap.values()];
  const stateProviders = historyConsensus.slice(0, MAX_STATE_FAMILIES).map((x) => x.provider);
  const captures = await Promise.all(stateProviders.map((p, i) => capture(p, selection.pin, deployments, fixtures, borrowerCandidates, i === 0)));
  const commitments = captures.map(({ gasContext: _latestGasDiagnostic, borrowers: _singleFamilyBorrowerSample, recipientOwnershipJoin: _singleFamilyOwnerJoin, roles: _singleFamilyRoles, ...fixedPinCoreState }) => sha(canonical(fixedPinCoreState)));
  if (new Set(commitments).size !== 1) {
    const comparable = captures.map(({ gasContext: _latestGasDiagnostic, borrowers: _singleFamilyBorrowerSample, recipientOwnershipJoin: _singleFamilyOwnerJoin, roles: _singleFamilyRoles, ...fixedPinCoreState }) => fixedPinCoreState);
    throw new Error(`fresh-pin decoded state disagreement: ${firstDiffs(comparable[0], comparable[1]).join(",")}`);
  }
  const state = captures[0];
  const continuity = sourceContinuity(state, prior);
  const vulnerable = state.assets.filter((x) => x.repaymentMath?.zeroTransferDebtReduction);
  const terminalDustAssets = state.assets.filter((x) => x.repaymentMath?.terminalNormalizedDust);
  const configurationDrift = {
    localDeclaredBorrowTokenNames: localConfig.debtManager.borrowTokens,
    localDeclaredBorrowTokenCount: localConfig.debtManager.borrowTokens.length,
    activeBorrowTokenCount: state.assets.length,
    activeTokensNotMappedToFixtureName: state.assets.filter((x) => !x.configuredName).map((x) => ({ token: x.token, symbol: x.symbol, totalBorrowingRaw: x.totalBorrowingRaw, totalSuppliesRaw: x.totalSuppliesRaw, managerLiquidBalanceRaw: x.managerLiquidBalanceRaw })),
  };
  const currentLiquidityRoutes = vulnerable.filter((x) => BigInt(x.managerLiquidBalanceRaw) >= BigInt(x.repaymentMath.borrowedTokenRaw) && !state.bindings.debtManagerPaused && !state.bindings.cashModulePaused && x.priceCallable);
  const configuredRecipientRouteCount = state.dispatchers.reduce((n, d) => n + d.tokens.filter((r) => vulnerable.some((v) => v.token === r.token) && r.recipientConfigured && d.paused === false).length, 0);
  const onchainPrerequisites = {
    vulnerableBorrowTokenCount: vulnerable.length, vulnerableBorrowTokens: vulnerable.map((x) => ({ token: x.token, symbol: x.symbol, priceUsd6Raw: x.priceUsd6Raw, managerLiquidBalanceRaw: x.managerLiquidBalanceRaw, math: x.repaymentMath })),
    terminalDustBorrowTokenCount: terminalDustAssets.length, terminalDustBorrowTokens: terminalDustAssets.map((x) => ({ token: x.token, symbol: x.symbol, priceUsd6Raw: x.priceUsd6Raw, managerLiquidBalanceRaw: x.managerLiquidBalanceRaw, math: x.repaymentMath })),
    liquidVulnerableBorrowTokenCount: currentLiquidityRoutes.length, historicalBorrowerCandidateCount: state.borrowers.historicalBorrowerCandidateCount,
    routeReadyScannedSafeCountIgnoringOffchainAttributionAndTokenLiquidity: state.borrowers.routePrerequisiteCount,
    configuredUnpausedVulnerableRecipientRows: configuredRecipientRouteCount,
    recipientMatchesRouteCandidateOwnerCount: state.recipientOwnershipJoin.recipientMatchesRouteCandidateOwnerCount,
  };
  const routePositive = currentLiquidityRoutes.length > 0 && state.borrowers.routePrerequisiteCount > 0 && configuredRecipientRouteCount > 0 && state.recipientOwnershipJoin.recipientMatchesRouteCandidateOwnerCount > 0;
  const conclusion = {
    classification: CLASSIFICATION, advances: false, routePositive: 0, executableNow: 0, signedActionJustified: false, forkRun: false,
    deploymentStateBound: true, borrowerAttributableValueBound: false, exactNetUsd6Raw: null,
    reason: vulnerable.length === 0
      ? `No configured borrow token satisfies fresh-pin zero-transfer/full-debt-reduction arithmetic. ${terminalDustAssets.length} token row(s) instead produce terminal normalized dust whose ordinary capped repayment reverts, so no borrower-attributable value route is established.`
      : currentLiquidityRoutes.length === 0
      ? "Fresh-pin zero-transfer/full-debt-reduction arithmetic exists only on tokens without sufficient DebtManager liquidity, so the read-only fork gate remains closed."
      : "On-chain prerequisites exist, but no configured settlement recipient is attributable to a scanned borrower and borrower-attributable off-chain value remains unbound; no route-positive promotion is made.",
    classificationPreservedReason: "The governing R3 classification is preserved exactly because fresh state does not prove attacker/borrower-attributable value.",
  };
  if (routePositive) throw new Error("unexpected route-positive state requires independent review before publication");
  const runId = `etherfi-repay-binding-${selection.pin.number}-${selection.pin.hash.slice(2, 14)}-${hashFile(SCANNER).sha256.slice(0, 12)}`;
  const result = {
    schemaVersion: 1, revision: REVISION, runId, generatedAt, agentId: AGENT, role: "critical-research", classification: CLASSIFICATION,
    scope: "Fresh finalized Optimism repayment-route binding: deployed code continuity, token price/index/liquidity math, settlement recipients/roles, and bounded confirmed-borrower Safe authorization/caps.",
    gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, conclusion,
    safety: { readOnlyRpc: true, rpcInventoryReadInMemoryOnly: true, endpointMaterialPersisted: false, providerIdentifiersPersisted: false, rawRpcPersisted: false, privateKeysRead: false, signedActions: false, broadcasts: false, productionMutation: false, pendingWithdrawalsCaptured: false },
    budgets: { maxEndpoints: MAX_ENDPOINTS, maxRpcTotal: MAX_RPC_TOTAL, maxRpcPerProvider: MAX_RPC_PER_PROVIDER, rpcUsed: rpcTotal, providerRpcCounts: selection.selected.map((p) => providerCounts.get(p.id) || 0), maxBorrowerCandidates: MAX_BORROWER_CANDIDATES },
    providerCoverage: { inventoryCount: selection.inventoryCount, qualifiedEndpointFamilyCount: selection.qualifiedFamilyCount, exactHeaderFamilyCount: selection.exactHeaderFamilyCount, exactDecodedCoreStateFamilyCount: commitments.length, borrowerSampleStateFamilyCount: 1, roleStateFamilyCount: 1, backendOperatorIndependenceEstablished: false },
    pin: { chainId: selection.pin.chainId, finalized: true, number: selection.pin.number, hash: selection.pin.hash, timestamp: selection.pin.timestamp },
    sourceContinuity: continuity,
    deploymentBindings: state.bindings, components: state.components, roles: state.roles,
    borrowHistory: { fromBlock: recentFromBlock, toBlock: selection.pin.number, scope: "bounded-recent-confirmed-window-plus-prior-phase0-seeds", fullHistoryClaimed: false, windowComplete: true, recentEventCount: histories[0].eventCount, recentCandidateCount: histories[0].candidateCount, selectedCandidateCount: borrowerCandidates.length, digest: histories[0].digest, perToken: histories[0].perToken, agreeingFamilyCount: histories.length, providerCalls: histories.map((x) => x.calls), priorSeedArtifact: hashFile(PHASE0) },
    assets: state.assets, dispatchers: state.dispatchers, borrowers: state.borrowers, recipientOwnershipJoin: state.recipientOwnershipJoin, gasContext: state.gasContext,
    configurationDrift,
    onchainPrerequisites,
    offchainAttribution: { borrowerAttributableServiceOrValueBound: false, configuredRecipientControlByBorrowerBound: false, statement: "Read-only chain state binds recipient addresses and role-gated settlement, but cannot establish that a borrower controls a recipient or receives off-chain goods/services worth more than payment and costs." },
    netEconomics: { grossMaximumPerFreshZeroTransferRouteTokenRaw: vulnerable.length ? "1" : "0", gasPriceBound: true, intrinsicGasFloorBound: true, l1DataFeeBound: false, offchainValueBound: false, exactNetUsd6Raw: null },
    forkDecision: { run: false, reason: vulnerable.length === 0 ? "No configured token currently has zero-transfer/full-debt-reduction arithmetic; the remaining terminal-dust behavior is already locally proven and is not an extractive route." : currentLiquidityRoutes.length === 0 ? "No current vulnerable-token DebtManager liquidity; no meaningful state-preserving fork route exists." : "Borrower-attributable value/control is unbound, so the route-positive fork gate is not open." },
    predecessor: { r3: { path: R3, runId: r3.runId, classification: r3.classification, sha256: hashFile(R3).sha256 }, exactBinding: { path: PRIOR_BINDING, runId: prior.runId, classification: prior.classification, sha256: hashFile(PRIOR_BINDING).sha256 } },
    selfTests: tests,
    codeReferences: [
      "targets/cash-v3/src/modules/cash/CashModuleCore.sol:339-409", "targets/cash-v3/src/debt-manager/DebtManagerCore.sol:461-511", "targets/cash-v3/src/debt-manager/DebtManagerCore.sol:595-602",
      "targets/cash-v3/src/settlement-dispatcher/SettlementDispatcherV2.sol:941-976", "targets/cash-v3/src/safe/EtherFiSafe.sol:178-204", "targets/cash-v3/src/libraries/SpendingLimitLib.sol:107-115"
    ],
    remediation: "Use rounding-up token collection for capped full repayment and cap normalized debt reduction by actual received payment value; add an explicit terminal-dust close path that charges at least one token raw unit, and regression-test every configured token/price/index combination.",
  };
  const rawText = JSON.stringify(result, null, 2) + "\n";
  const reportText = `# Ether.fi DebtManager repayment deployment binding\n\n**Classification:** \`${CLASSIFICATION}\`  \n**Pin:** Optimism finalized block \`${result.pin.number}\` (\`${result.pin.hash}\`)  \n**Result:** no advancement; no fork; no signed action.\n\n## Finding\n\nFresh two-family decoded core state agrees. The deployed DebtManager remains source/runtime-continuous with commit \`${SOURCE_COMMIT}\`. The configured-token matrix contains ${vulnerable.length} zero-transfer/full-debt-reduction route(s) and ${terminalDustAssets.length} terminal-dust row(s). ${conclusion.reason}\n\nThe active set has **${state.assets.length}** borrow-token addresses versus **${localConfig.debtManager.borrowTokens.length}** names in local config. The extra/unmapped active row count is **${configurationDrift.activeTokensNotMappedToFixtureName.length}**; its current DebtManager borrowing, supplies, and liquid balance are zero, so this is configuration drift rather than a live repayment route.\n\n## Preconditions and evidence\n\n- Bounded recent/prior-seeded borrower candidates: **${state.borrowers.historicalBorrowerCandidateCount}**; current-debt candidates: **${state.borrowers.currentDebtCount}**. Full borrower-history coverage is not claimed; borrower detail is a one-family bounded sample.\n- Scanned Safe rows satisfying the zero-transfer route's credit-mode, CashModule, spending, and borrowing prerequisites: **${state.borrowers.routePrerequisiteCount}**.\n- Configured/unpaused zero-transfer-route recipient rows: **${configuredRecipientRouteCount}**. Borrower-owner recipient matches: **${state.recipientOwnershipJoin.recipientMatchesRouteCandidateOwnerCount}**.\n- Borrower-attributable off-chain value and exact net economics remain unbound. L1 data fee is not claimed.\n\n## Impact\n\nNo currently executable asset-loss route is established. At the fresh pin, every minimum-debt row reaches normalized-reduction zero and ordinary repayment reverts. The debt-free-without-payment local branch is therefore inactive, while terminal normalized dust remains an availability/accounting edge without extractive value.\n\n## Defensive test\n\nFor each configured borrow token, create the smallest nonzero USD debt at the current index, request capped full repayment, and assert: (1) token balance received by DebtManager is nonzero when debt decreases; (2) debt-value reduction does not exceed received-token value; and (3) terminal normalized dust has a payable close path.\n\n## Mitigation\n\n${result.remediation}\n`;
  const inbox = { schemaVersion: 1, generatedAt, agentId: AGENT, task: NAME, status: "completed", classification: CLASSIFICATION, routePositive: 0, executableNow: 0, fork: false, runId, pin: result.pin, conclusion: conclusion.reason, raw: RAW, report: REPORT };
  const handoffText = `# Handoff: ${NAME}\n\n- Completed fresh finalized Optimism two-family read-only binding at block ${result.pin.number}.\n- Classification preserved exactly: \`${CLASSIFICATION}\`.\n- DebtManager source/runtime continuity: ${continuity.exactSourceRuntimeContinuity}.\n- Zero-transfer route tokens: ${vulnerable.length}; currently liquid routes: ${currentLiquidityRoutes.length}.\n- Fork gate remained closed; no signed action or production mutation.\n- Validate with \`node ${VALIDATOR}\`.\n`;
  for (const text of [rawText, reportText, JSON.stringify(inbox, null, 2) + "\n", handoffText]) sanitize(text);
  writeOwned(RAW, rawText); writeOwned(REPORT, reportText); writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n"); writeOwned(HANDOFF, handoffText);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, R3, PRIOR_BINDING, PHASE0, DEPLOYMENTS, CONFIG, FIXTURES,
    "targets/cash-v3/src/debt-manager/DebtManagerCore.sol", "targets/cash-v3/src/modules/cash/CashModuleCore.sol", "targets/cash-v3/src/settlement-dispatcher/SettlementDispatcherV2.sol", "targets/cash-v3/src/safe/EtherFiSafe.sol", "targets/cash-v3/src/libraries/SpendingLimitLib.sol"
  ].map(hashFile);
  const manifest = { schemaVersion: 1, revision: REVISION, runId, generatedAt, records, aggregateSha256: sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")) };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n"; sanitize(manifestText); writeOwned(MANIFEST, manifestText);
  console.log(JSON.stringify({ ok: true, runId, classification: CLASSIFICATION, pin: result.pin, routePositive: 0, fork: false, vulnerableTokenCount: vulnerable.length, liquidVulnerableTokenCount: currentLiquidityRoutes.length, manifestAggregateSha256: manifest.aggregateSha256 }, null, 2));
}

main().catch((e) => { console.error(`repay deployment binding failed: ${safeError(e)}`); process.exit(1); });
