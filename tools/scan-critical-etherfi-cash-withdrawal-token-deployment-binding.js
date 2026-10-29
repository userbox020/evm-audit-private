#!/usr/bin/env node
"use strict";

// Authorized bounded read-only fixed-pin Optimism binding. Endpoint material and
// raw RPC responses remain memory-only. The fork test mutates only ephemeral local state.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("./node_modules/ethers");
const { loadRpcUrls, getOrigin } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-cash-withdrawal-token-deployment-binding";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-24-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const FORK_TEST = "targets/cash-v3/test/critical/CashWithdrawalTokenDeploymentBindingFork.t.sol";
const PREDECESSOR = "reports/raw/fast/critical-etherfi-cash-withdrawal-exactly-once.json";
const PREDECESSOR_MANIFEST = "reports/raw/fast/critical-etherfi-cash-withdrawal-exactly-once-manifest.json";
const DEPLOYMENTS = "targets/cash-v3/deployments/mainnet/10/deployments.json";
const CONFIG = "targets/cash-v3/deployments/mainnet/10/config.json";
const FIXTURES = "targets/cash-v3/deployments/mainnet/fixtures/fixtures.json";
const SOURCE_COMMIT = "e05bda2be27a6a606f3f1b8ff0d0791032fd0ff8";
const REVISION = "cash-withdrawal-token-deployment-binding-r1";
const AGENT = "critical-etherfi-cash-withdrawal-token-binding-20260724";
const CHAIN_ID = 10;
const MAX_ENDPOINTS = 96;
const MAX_QUALIFIED_FAMILIES = 4;
const MAX_STATE_FAMILIES = 2;
const MAX_RPC_TOTAL = 1800;
const MAX_RPC_PER_PROVIDER = 800;
const RPC_TIMEOUT_MS = 15_000;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ALLOWED_RPC = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call"]);

const abs = (rel) => path.join(ROOT, rel);
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hashFile = (rel) => { const data = fs.readFileSync(abs(rel)); return { path: rel, bytes: data.length, sha256: sha(data) }; };
const toTag = (n) => `0x${BigInt(n).toString(16)}`;
const codeInfo = (code) => ({ bytes: Math.max(0, (String(code || "0x").length - 2) / 2), keccak256: ethers.keccak256(code || "0x") });
const asAddress = (word) => !word || BigInt(word) === 0n ? null : ethers.getAddress(`0x${word.slice(-40)}`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canonical(value) {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function writeOwned(rel, text) { if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused: ${rel}`); fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text, "utf8"); }
function providerHost(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } }
function safeError(error) { return String(error?.message || error || "RPC unavailable").replace(/https?:\/\/[^\s"']+/gi, "[endpoint-redacted]").slice(0, 1200); }
function sanitize(text) {
  if (/https?:\/\//i.test(text)) throw new Error("endpoint leak");
  const assignment = /(?:private[_ -]?key|seed[_ -]?phrase|mnemonic|authorization|cookie)["']?\s*[:=]\s*["']?([^\s,"'}]+)/ig;
  for (const match of text.matchAll(assignment)) if (!/^(?:false|null|none|never|not-used)$/i.test(match[1])) throw new Error("secret-pattern leak");
}

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
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(350 * attempt);
    } finally { clearTimeout(timer); }
  }
  throw lastError || new Error("RPC unavailable");
}

async function call(provider, to, iface, fn, args, tag) {
  const raw = await rpc(provider, "eth_call", [{ to, data: iface.encodeFunctionData(fn, args || []) }, tag]);
  return iface.decodeFunctionResult(fn, raw);
}
async function callMaybe(provider, to, iface, fn, args, tag) { try { return await call(provider, to, iface, fn, args, tag); } catch { return null; } }

const CASH = new ethers.Interface([
  "function getWhitelistedWithdrawAssets() view returns(address[])", "function getWhitelistedModulesCanRequestWithdraw() view returns(address[])",
  "function etherFiDataProvider() view returns(address)", "function roleRegistry() view returns(address)", "function getCashModuleSetters() view returns(address)",
  "function getDebtManager() view returns(address)", "function paused() view returns(bool)", "function getDelays() view returns(uint64,uint64,uint64)"
]);
const DATA = new ethers.Interface(["function getCashModule() view returns(address)", "function getEtherFiSafeFactory() view returns(address)", "function roleRegistry() view returns(address)", "function isDefaultModule(address) view returns(bool)"]);
const FACTORY = new ethers.Interface(["function beacon() view returns(address)"]);
const BEACON = new ethers.Interface(["function implementation() view returns(address)"]);
const IMPLEMENTATION_GETTER = new ethers.Interface(["function implementation() view returns(address)", "function getImplementation() view returns(address)"]);
const TOKEN = new ethers.Interface(["function name() view returns(string)", "function symbol() view returns(string)", "function decimals() view returns(uint8)", "function totalSupply() view returns(uint256)"]);
const TOKEN_B32 = new ethers.Interface(["function name() view returns(bytes32)", "function symbol() view returns(bytes32)"]);

async function probe(url, ordinal, cashModule) {
  const provider = { id: `candidate-${ordinal + 1}`, url };
  try {
    if (Number(BigInt(await rpc(provider, "eth_chainId"))) !== CHAIN_ID) return null;
    const finalized = await rpc(provider, "eth_getBlockByNumber", ["finalized", false]);
    if (!finalized?.number || !finalized?.hash) return null;
    const code = await rpc(provider, "eth_getCode", [cashModule, finalized.number]);
    if (!code || code === "0x") return null;
    const host = providerHost(url); if (!host) return null;
    return { url, host, familyFingerprint: sha(host).slice(0, 16), finalizedNumber: Number(BigInt(finalized.number)), finalizedHash: finalized.hash.toLowerCase() };
  } catch { return null; }
}

async function selectProviders(cashModule) {
  const urls = [...new Set(loadRpcUrls())].slice(0, MAX_ENDPOINTS);
  const qualified = [], hosts = new Set();
  for (let i = 0; i < urls.length && qualified.length < MAX_QUALIFIED_FAMILIES; i += 16) {
    const rows = await Promise.all(urls.slice(i, i + 16).map((url, j) => probe(url, i + j, cashModule)));
    for (const row of rows) {
      if (!row || hosts.has(row.host)) continue;
      hosts.add(row.host); qualified.push(row);
      if (qualified.length === MAX_QUALIFIED_FAMILIES) break;
    }
  }
  if (qualified.length < 2) throw new Error("fewer than two qualified Optimism provider families");
  const number = Math.min(...qualified.map((x) => x.finalizedNumber));
  const tag = toTag(number);
  for (let i = 0; i < qualified.length; i++) qualified[i].id = `provider-${i + 1}`;
  const headers = await Promise.all(qualified.map(async (provider) => ({ provider, header: await rpc(provider, "eth_getBlockByNumber", [tag, false]) })));
  const groups = new Map();
  for (const row of headers) {
    const hash = row.header?.hash?.toLowerCase(); if (!hash) continue;
    if (!groups.has(hash)) groups.set(hash, []); groups.get(hash).push(row);
  }
  const best = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!best || best[1].length < 2) throw new Error("no two-family fixed-pin header agreement");
  const timestamps = new Set(best[1].map((x) => Number(BigInt(x.header.timestamp))));
  if (timestamps.size !== 1) throw new Error("fixed-pin timestamp disagreement");
  const selected = best[1].slice(0, MAX_STATE_FAMILIES).map((x) => x.provider);
  return {
    inventoryCount: urls.length,
    qualifiedFamilyCount: qualified.length,
    exactHeaderFamilyCount: best[1].length,
    selected,
    pin: { chainId: CHAIN_ID, finalized: true, number, hash: best[0], timestamp: Number(BigInt(best[1][0].header.timestamp)), tag },
  };
}

async function runtimeBinding(provider, address, tag) {
  const [proxyCode, implWord, beaconWord] = await Promise.all([
    rpc(provider, "eth_getCode", [address, tag]),
    rpc(provider, "eth_getStorageAt", [address, IMPL_SLOT, tag]),
    rpc(provider, "eth_getStorageAt", [address, BEACON_SLOT, tag]),
  ]);
  const implementation = asAddress(implWord), beacon = asAddress(beaconWord);
  let effectiveImplementation = implementation, beaconImplementation = null;
  if (!effectiveImplementation && beacon) {
    const result = await callMaybe(provider, beacon, BEACON, "implementation", [], tag);
    if (result) { beaconImplementation = ethers.getAddress(result[0]); effectiveImplementation = beaconImplementation; }
  }
  let customImplementationGetter = null;
  if (!effectiveImplementation && !beacon) {
    for (const fn of ["implementation", "getImplementation"]) {
      const result = await callMaybe(provider, address, IMPLEMENTATION_GETTER, fn, [], tag);
      if (!result) continue;
      const candidate = ethers.getAddress(result[0]);
      const candidateCode = await rpc(provider, "eth_getCode", [candidate, tag]);
      if (candidateCode && candidateCode !== "0x") { effectiveImplementation = candidate; customImplementationGetter = fn; break; }
    }
  }
  const effectiveCode = effectiveImplementation ? await rpc(provider, "eth_getCode", [effectiveImplementation, tag]) : proxyCode;
  return {
    address: ethers.getAddress(address),
    proxyRuntime: codeInfo(proxyCode),
    standardProxy: implementation ? "EIP1967" : beacon ? "EIP1967_BEACON" : customImplementationGetter ? "CUSTOM_IMPLEMENTATION_GETTER" : "NONE_OR_CUSTOM",
    implementation,
    beacon,
    beaconImplementation,
    customImplementationGetter,
    effectiveRuntime: codeInfo(effectiveCode),
  };
}

async function stringMeta(provider, token, fn, tag) {
  const standard = await callMaybe(provider, token, TOKEN, fn, [], tag);
  if (standard) return standard[0];
  const bytes = await callMaybe(provider, token, TOKEN_B32, fn, [], tag);
  if (bytes) try { return ethers.decodeBytes32String(bytes[0]); } catch {}
  return null;
}

async function tokenState(provider, token, tag, fixtureNames) {
  const [name, symbol, decimalsResult, supplyResult, runtime] = await Promise.all([
    stringMeta(provider, token, "name", tag),
    stringMeta(provider, token, "symbol", tag),
    callMaybe(provider, token, TOKEN, "decimals", [], tag),
    callMaybe(provider, token, TOKEN, "totalSupply", [], tag),
    runtimeBinding(provider, token, tag),
  ]);
  return {
    address: ethers.getAddress(token),
    fixtureName: fixtureNames[token.toLowerCase()] || null,
    name,
    symbol,
    decimals: decimalsResult ? Number(decimalsResult[0]) : null,
    totalSupplyRaw: supplyResult ? supplyResult[0].toString() : null,
    runtime,
    localExactTokenSourceAvailable: false,
    sourceQualification: "runtime-bound; no exact token implementation source/build claimed from the local Cash v3 repository",
  };
}

async function captureState(provider, addresses, tag, fixtureNames) {
  const cashModule = addresses.CashModule;
  const [withdrawTokensR, modulesR, dataProviderR, roleRegistryR, settersR, debtManagerR, pausedR, delaysR] = await Promise.all([
    call(provider, cashModule, CASH, "getWhitelistedWithdrawAssets", [], tag),
    call(provider, cashModule, CASH, "getWhitelistedModulesCanRequestWithdraw", [], tag),
    call(provider, cashModule, CASH, "etherFiDataProvider", [], tag),
    call(provider, cashModule, CASH, "roleRegistry", [], tag),
    call(provider, cashModule, CASH, "getCashModuleSetters", [], tag),
    call(provider, cashModule, CASH, "getDebtManager", [], tag),
    call(provider, cashModule, CASH, "paused", [], tag),
    call(provider, cashModule, CASH, "getDelays", [], tag),
  ]);
  const dataProvider = ethers.getAddress(dataProviderR[0]);
  const [dpCashR, factoryR, dpRoleR, defaultR, cashRuntime, settersRuntime] = await Promise.all([
    call(provider, dataProvider, DATA, "getCashModule", [], tag),
    call(provider, dataProvider, DATA, "getEtherFiSafeFactory", [], tag),
    call(provider, dataProvider, DATA, "roleRegistry", [], tag),
    call(provider, dataProvider, DATA, "isDefaultModule", [cashModule], tag),
    runtimeBinding(provider, cashModule, tag),
    runtimeBinding(provider, ethers.getAddress(settersR[0]), tag),
  ]);
  const factory = ethers.getAddress(factoryR[0]);
  const beaconR = await call(provider, factory, FACTORY, "beacon", [], tag);
  const beacon = ethers.getAddress(beaconR[0]);
  const safeImplR = await call(provider, beacon, BEACON, "implementation", [], tag);
  const safeImplementation = ethers.getAddress(safeImplR[0]);
  const safeRuntime = await runtimeBinding(provider, safeImplementation, tag);
  const withdrawTokens = withdrawTokensR[0].map(ethers.getAddress);
  const tokens = [];
  for (const token of withdrawTokens) tokens.push(await tokenState(provider, token, tag, fixtureNames));
  return {
    cashModule: {
      address: ethers.getAddress(cashModule), dataProvider, roleRegistry: ethers.getAddress(roleRegistryR[0]), setters: ethers.getAddress(settersR[0]), debtManager: ethers.getAddress(debtManagerR[0]),
      paused: pausedR[0], withdrawalDelay: delaysR[0].toString(), spendLimitDelay: delaysR[1].toString(), modeDelay: delaysR[2].toString(), runtime: cashRuntime,
    },
    dataProvider: { address: dataProvider, getCashModule: ethers.getAddress(dpCashR[0]), roleRegistry: ethers.getAddress(dpRoleR[0]), cashIsDefaultModule: defaultR[0], safeFactory: factory },
    safeLinkage: { factory, beacon, implementation: safeImplementation, implementationRuntime: safeRuntime.effectiveRuntime },
    modulesCanRequestWithdraw: modulesR[0].map(ethers.getAddress),
    withdrawTokens,
    tokens,
  };
}

function runForkTest(providerUrl, pin) {
  const temp = path.join(ROOT, ".tmp-withdrawal-token-binding");
  fs.rmSync(temp, { recursive: true, force: true }); fs.mkdirSync(temp, { recursive: true });
  try {
    const args = ["test", "--root", path.join(ROOT, "targets", "cash-v3"), "--out", path.join(temp, "out"), "--cache-path", path.join(temp, "cache"), "--no-cache", "--offline", "--match-path", "test/critical/CashWithdrawalTokenDeploymentBindingFork.t.sol", "--match-contract", "CashWithdrawalTokenDeploymentBindingForkTest", "--skip", "SafeAssetRecoveryInvariant", "-vvv"];
    const result = spawnSync("forge", args, { cwd: ROOT, encoding: "utf8", timeout: 1_200_000, maxBuffer: 128 * 1024 * 1024, windowsHide: true, env: { ...process.env, WITHDRAWAL_BINDING_RPC: providerUrl, WITHDRAWAL_BINDING_BLOCK: String(pin) } });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.status !== 0) {
      const diagnostic = output.replaceAll(providerUrl, "[endpoint-redacted]").replace(/https?:\/\/[^\s"']+/gi, "[endpoint-redacted]").slice(-1200);
      throw new Error(`sanitized local fork test failed: ${diagnostic}`);
    }
    const suite = output.match(/Suite result:\s+ok\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) skipped/);
    const transfers = [], transferFrom = [], runtimeComparisons = [];
    for (const line of output.split(/\r?\n/)) {
      const text = line.trim();
      if (text.includes("BINDING_RUNTIME|")) {
        const row = text.slice(text.indexOf("BINDING_RUNTIME|")).split("|");
        if (row.length === 4) runtimeComparisons.push({ component: row[1], fullRuntimeMatch: row[2] === "true", metadataNormalizedRuntimeMatch: row[3] === "true" });
      } else if (text.includes("WITHDRAW_TRANSFER|")) {
        const row = text.slice(text.indexOf("WITHDRAW_TRANSFER|")).split("|");
        if (row.length === 10) transfers.push({ token: ethers.getAddress(row[1]), amount: row[2], setup: row[3] === "true", callOk: row[4] === "true", returnClass: Number(row[5]), holderBefore: row[6], holderAfter: row[7], receiverBefore: row[8], receiverAfter: row[9] });
      } else if (text.includes("WITHDRAW_TRANSFER_FROM|")) {
        const row = text.slice(text.indexOf("WITHDRAW_TRANSFER_FROM|")).split("|");
        if (row.length === 12) transferFrom.push({ token: ethers.getAddress(row[1]), amount: row[2], setup: row[3] === "true", approveOk: row[4] === "true", approveReturnClass: Number(row[5]), callOk: row[6] === "true", returnClass: Number(row[7]), holderBefore: row[8], holderAfter: row[9], receiverBefore: row[10], receiverAfter: row[11] });
      }
    }
    return { exitStatus: result.status, passCount: suite ? Number(suite[1]) : null, failCount: suite ? Number(suite[2]) : null, skippedCount: suite ? Number(suite[3]) : null, outputBytes: Buffer.byteLength(output), outputSha256: sha(output), runtimeComparisons, transfers, transferFrom, endpointMaterialPersisted: false, productionMutation: false, dealtEphemeralBalancesOnly: true };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function delta(before, after, decreasing) {
  const a = BigInt(before), b = BigInt(after);
  if (decreasing) return a >= b ? (a - b).toString() : null;
  return b >= a ? (b - a).toString() : null;
}

function behaviorMatrix(tokens, fork) {
  return tokens.map((token) => {
    const transfers = fork.transfers.filter((x) => x.token.toLowerCase() === token.address.toLowerCase()).map((row) => ({ ...row, senderSpentRaw: delta(row.holderBefore, row.holderAfter, true), receiverGainRaw: delta(row.receiverBefore, row.receiverAfter, false) }));
    const transferFrom = fork.transferFrom.filter((x) => x.token.toLowerCase() === token.address.toLowerCase()).map((row) => ({ ...row, senderSpentRaw: delta(row.holderBefore, row.holderAfter, true), receiverGainRaw: delta(row.receiverBefore, row.receiverAfter, false) }));
    const testedTransfer = transfers.filter((x) => x.setup);
    const exactTransfer = testedTransfer.length > 0 && testedTransfer.every((x) => x.callOk && x.returnClass !== 2 && x.returnClass !== 3 && x.senderSpentRaw === x.amount && x.receiverGainRaw === x.amount);
    const testedTransferFrom = transferFrom.filter((x) => x.setup);
    const exactTransferFrom = testedTransferFrom.length > 0 && testedTransferFrom.every((x) => x.approveOk && x.callOk && x.approveReturnClass !== 2 && x.approveReturnClass !== 3 && x.returnClass !== 2 && x.returnClass !== 3 && x.senderSpentRaw === x.amount && x.receiverGainRaw === x.amount);
    const falseReturnObserved = transfers.some((x) => x.callOk && x.returnClass === 2);
    const noReturnObserved = transfers.some((x) => x.callOk && x.returnClass === 0);
    const incompleteDeliveryObserved = transfers.some((x) => x.setup && x.callOk && (x.receiverGainRaw === null || BigInt(x.receiverGainRaw) < BigInt(x.amount)));
    const feeOrPartialObserved = transfers.some((x) => x.setup && x.callOk && (x.senderSpentRaw !== x.amount || x.receiverGainRaw !== x.amount));
    const unresolved = testedTransfer.length === 0 || testedTransfer.some((x) => !x.callOk || x.returnClass === 3) || testedTransferFrom.length === 0 || testedTransferFrom.some((x) => !x.approveOk || !x.callOk || x.returnClass === 3);
    let classification = "standard-bool-return-exact-on-tested-paths";
    if (incompleteDeliveryObserved) classification = "nonstandard-incomplete-delivery-observed";
    else if (falseReturnObserved) classification = "false-return-observed-without-incomplete-delivery";
    else if (noReturnObserved && exactTransfer) classification = "no-return-exact-on-tested-paths";
    else if (unresolved) classification = "coverage-unresolved";
    return {
      ...token,
      behavior: {
        classification,
        standardBoolReturn: exactTransfer && !noReturnObserved && !falseReturnObserved,
        noReturnObserved,
        falseReturnObserved,
        feeOrPartialObserved,
        incompleteDeliveryObserved,
        exactTransferAllTestedAmounts: exactTransfer,
        exactTransferFromTestedAmount: exactTransferFrom,
        rebasingAssessment: "no within-probe balance anomaly observed when exact; global rebasing behavior not inferred",
        canConsumeWithdrawalWithFalseOrPartialDeliveryAtTestedPath: incompleteDeliveryObserved,
        attackerGainRaw: "0",
        transfers,
        transferFrom,
      },
    };
  });
}

async function terminalRecheck(providers, pin) {
  const rows = [];
  for (const provider of providers) {
    const header = await rpc(provider, "eth_getBlockByNumber", [pin.tag, false]);
    rows.push({ providerId: provider.id, sameNumberHashMatch: header?.hash?.toLowerCase() === pin.hash, number: header?.number ? Number(BigInt(header.number)) : null });
  }
  return rows;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const deployments = JSON.parse(fs.readFileSync(abs(DEPLOYMENTS), "utf8"));
  const declaredConfig = JSON.parse(fs.readFileSync(abs(CONFIG), "utf8"));
  const fixtures = JSON.parse(fs.readFileSync(abs(FIXTURES), "utf8"))[String(CHAIN_ID)];
  const fixtureNames = {};
  for (const [name, value] of Object.entries(fixtures)) if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) fixtureNames[value.toLowerCase()] = name;
  const cashModule = ethers.getAddress(deployments.addresses.CashModule);
  const selected = await selectProviders(cashModule);
  const states = [];
  for (const provider of selected.selected) states.push(await captureState(provider, deployments.addresses, selected.pin.tag, fixtureNames));
  const stateDigests = states.map((state) => sha(canonical(state)));
  if (new Set(stateDigests).size !== 1) throw new Error("decoded fixed-pin state disagreement");
  const state = states[0];
  if (state.cashModule.dataProvider.toLowerCase() !== deployments.addresses.EtherFiDataProvider.toLowerCase() || state.dataProvider.getCashModule.toLowerCase() !== cashModule.toLowerCase()) throw new Error("CashModule/DataProvider linkage mismatch");
  const fork = runForkTest(selected.selected[0].url, selected.pin.number);
  if (fork.passCount !== 5 || fork.failCount !== 0) throw new Error("fork coverage gate failed");
  if (fork.runtimeComparisons.length !== 3) throw new Error("runtime comparison matrix incomplete");
  const runtimeByComponent = Object.fromEntries(fork.runtimeComparisons.map((row) => [row.component, row]));
  const sourceRuntimeContinuity = fork.runtimeComparisons.every((row) => row.metadataNormalizedRuntimeMatch);
  const tokens = behaviorMatrix(state.tokens, fork);
  if (tokens.length !== state.withdrawTokens.length || tokens.some((x) => x.behavior.transfers.length === 0 || x.behavior.transferFrom.length === 0)) throw new Error("fork behavior matrix incomplete");
  const incomplete = tokens.filter((x) => x.behavior.incompleteDeliveryObserved);
  const unresolved = tokens.filter((x) => x.behavior.classification === "coverage-unresolved");
  const nonstandardExact = tokens.filter((x) => x.behavior.classification === "no-return-exact-on-tested-paths");
  const declaredNames = declaredConfig.cashModule?.withdrawAssets || [];
  const declaredAddresses = declaredNames.map((name) => fixtures[name]).filter((value) => typeof value === "string").map((value) => ethers.getAddress(value));
  const declaredSet = new Set(declaredAddresses.map((value) => value.toLowerCase()));
  const activeSet = new Set(state.withdrawTokens.map((value) => value.toLowerCase()));
  const activeNotDeclared = state.withdrawTokens.filter((value) => !declaredSet.has(value.toLowerCase()));
  const declaredNotActive = declaredAddresses.filter((value) => !activeSet.has(value.toLowerCase()));
  const terminal = await terminalRecheck(selected.selected, selected.pin);
  if (terminal.some((x) => !x.sameNumberHashMatch)) throw new Error("terminal fixed-pin hash recheck failed");

  let classification, branchDisposition;
  if (incomplete.length) {
    classification = "INFORMATIONAL/WATCH/ACTIVE-WITHDRAWAL-TOKEN-INCOMPLETE-DELIVERY-OBSERVED/NO-ATTACKER-GAIN/FIXED-PIN";
    branchDisposition = "WATCH_CONDITIONAL_INTEGRATION_ACTIVE_NO_EXTRACTION";
  } else if (unresolved.length || !sourceRuntimeContinuity) {
    classification = "INFORMATIONAL/WATCH/COVERAGE-OPEN-NO-INCOMPLETE-DELIVERY-OBSERVED/NO-ATTACKER-GAIN/FIXED-PIN";
    branchDisposition = "WATCH_COVERAGE_OPEN_NO_EXTRACTION";
  } else {
    classification = "INFORMATIONAL/CLOSED-CURRENT-PIN/ALL-ACTIVE-WITHDRAWAL-TOKENS-EXACT-DELIVERY-ON-TESTED-PATHS/NO-ATTACKER-GAIN";
    branchDisposition = "CLOSED_CURRENT_PIN_REOPEN_ON_CONFIG_OR_RUNTIME_CHANGE";
  }
  const providerCoverage = {
    inventoryCount: selected.inventoryCount,
    qualifiedFamilyCount: selected.qualifiedFamilyCount,
    exactHeaderFamilyCount: selected.exactHeaderFamilyCount,
    exactDecodedStateFamilyCount: states.length,
    selectedFamilies: selected.selected.map((provider) => ({ providerId: provider.id, familyFingerprint: provider.familyFingerprint, rpcCalls: providerCounts.get(provider.id) || 0 })),
    stateDigestSha256: stateDigests[0],
    endpointUrlsPersisted: false,
    endpointDomainsPersisted: false,
  };
  const result = {
    schemaVersion: 1,
    revision: REVISION,
    runId: `etherfi-cash-withdrawal-token-binding-${selected.pin.number}-${selected.pin.hash.slice(2, 14)}`,
    generatedAt,
    agentId: AGENT,
    role: "critical-research",
    classification,
    conclusion: {
      status: branchDisposition,
      advances: false,
      branchPipeline: incomplete.length ? "1/5_CONDITIONAL-INTEGRATION-BEHAVIOR_ACTIVE_NO_ATTACKER_VALUE" : !sourceRuntimeContinuity ? "0/5_DEPLOYED-SOURCE-CONTINUITY-OPEN_TOKEN-BEHAVIOR-GATE-CLOSED" : "1/5_SOURCE-PRIMITIVE_CURRENT-CONFIG-BLOCKED",
      extractionPipeline: "0/5_NO_ATTACKER_VALUE_PATH",
      globalHighestPipeline: "DebtManager donation 2/5 WATCH unchanged",
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      reason: incomplete.length ? `${incomplete.length} configured token(s) showed incomplete delivery in dealt local fork probes, but caller gain remains zero and undelivered value remains Safe-owned.` : unresolved.length ? `No false/partial delivery was observed, but ${unresolved.length} configured token(s) remain behavior-unresolved in the bounded dealt-balance probes.` : !sourceRuntimeContinuity ? `Token probes found no incomplete delivery, but metadata-normalized runtime continuity is not exact for every CashModule/Safe component; deployment semantics remain coverage-open.` : `All ${tokens.length} configured withdrawal tokens delivered exact raw amounts on tested transfer and transferFrom paths; no false-return, fee, or partial delivery was observed. This is current-pin/path-bounded, not global token-safety proof.`,
    },
    safety: { authorizedCurrentTurn: true, readOnlyRpc: true, localFork: true, dealtEphemeralBalancesOnly: true, liveTransactions: false, signedActions: false, broadcasts: false, productionMutation: false, realFunds: false, keysRead: false, endpointMaterialPersisted: false, rawRpcResponsesPersisted: false },
    pin: selected.pin,
    providerCoverage,
    terminalRecheck: terminal,
    source: { commit: SOURCE_COMMIT, productionSourceDiffAgainstCommit: spawnSync("git", ["diff", "--name-only", SOURCE_COMMIT, "--", "src"], { cwd: path.join(ROOT, "targets", "cash-v3"), encoding: "utf8", windowsHide: true }).stdout.trim().split(/\r?\n/).filter(Boolean), cashModuleCoreExactRuntime: runtimeByComponent.CashModuleCore?.metadataNormalizedRuntimeMatch === true, cashModuleSettersExactRuntime: runtimeByComponent.CashModuleSetters?.metadataNormalizedRuntimeMatch === true, etherFiSafeExactRuntime: runtimeByComponent.EtherFiSafe?.metadataNormalizedRuntimeMatch === true, allMetadataNormalizedRuntimeContinuity: sourceRuntimeContinuity, runtimeComparisons: fork.runtimeComparisons, exactRuntimeEvidence: "5/5 local fork tests include local source deployments compared to fixed-pin implementation code; exact booleans are metadata-normalized and full-runtime results are retained separately" },
    deployment: { cashModule: state.cashModule, dataProvider: state.dataProvider, safeLinkage: state.safeLinkage, modulesCanRequestWithdraw: state.modulesCanRequestWithdraw },
    configurationDrift: { localDeclaredTokenNames: declaredNames, localDeclaredResolvableTokenCount: declaredAddresses.length, activeTokenCount: state.withdrawTokens.length, activeTokensNotDeclaredLocally: activeNotDeclared, locallyDeclaredTokensNotActive: declaredNotActive, localConfigExactMatch: activeNotDeclared.length === 0 && declaredNotActive.length === 0 },
    configuredWithdrawalTokenCount: tokens.length,
    behaviorSummary: {
      standardBoolExactCount: tokens.filter((x) => x.behavior.classification === "standard-bool-return-exact-on-tested-paths").length,
      noReturnExactCount: nonstandardExact.length,
      falseReturnObservedCount: tokens.filter((x) => x.behavior.falseReturnObserved).length,
      feeOrPartialObservedCount: tokens.filter((x) => x.behavior.feeOrPartialObserved).length,
      incompleteDeliveryObservedCount: incomplete.length,
      behaviorUnresolvedCount: unresolved.length,
      rebasingGlobalSafetyClaimed: false,
      anyActiveTokenCanConsumeWithFalseOrPartialDeliveryOnTestedPath: incomplete.length > 0,
      attackerGainRaw: "0",
    },
    tokens,
    forkTests: { passCount: fork.passCount, failCount: fork.failCount, skippedCount: fork.skippedCount, runtimeComparisonCount: fork.runtimeComparisons.length, transferProbeCount: fork.transfers.length, transferFromProbeCount: fork.transferFrom.length, totalBehaviorProbeCount: fork.transfers.length + fork.transferFrom.length, outputBytes: fork.outputBytes, outputSha256: fork.outputSha256, dealtEphemeralBalancesOnly: true, productionMutation: false },
    limitations: [
      "Token conclusions are limited to fixed-pin runtime/config plus dealt ephemeral same-block transfer and transferFrom paths at one raw unit and/or one decimal unit.",
      "Exact token implementation source/build is not claimed where unavailable in the local Cash v3 repository; runtime hashes and standard proxy slots are bound instead.",
      "No global fee, rebase, blacklist, hook, upgrade, amount-tier, holder-tier, timestamp, or governance safety inference is made beyond tested paths.",
      "No real Safe request was created or processed; the predecessor exact-source harness supplies withdrawal state-machine semantics.",
    ],
    nextGate: incomplete.length ? "Independent offline review, then source/runtime-specific explanation of the observed token behavior; no attacker-value route or signed action." : unresolved.length ? "Reopen only the unresolved token rows with a separately reviewed token-specific local simulation; no live action." : !sourceRuntimeContinuity ? "Recover and independently review the exact active CashModuleCore/CashModuleSetters source-build pair; token-behavior gate is currently negative and no fork or signed action is justified." : "Close current branch and reopen only on CashModule withdrawal-token membership, token implementation/runtime, or CashModule/Safe runtime change.",
  };
  if (result.source.productionSourceDiffAgainstCommit.length) throw new Error("production source drift");

  const rawText = JSON.stringify(result, null, 2) + "\n";
  const rows = tokens.map((token) => `| ${token.fixtureName || token.symbol || "unmapped"} | \`${token.address}\` | ${token.decimals ?? "null"} | ${token.runtime.standardProxy} | ${token.behavior.classification} | ${token.behavior.incompleteDeliveryObserved ? "YES" : "no"} |`).join("\n");
  const reportText = `# Ether.fi Cash withdrawal-token deployment/config binding\n\n**Signal:** ${incomplete.length || unresolved.length || !sourceRuntimeContinuity ? "🟢 DORMANT" : "⚪ CLEAN"} — no permissionless extraction or caller gain.  \n**Classification:** \`${classification}\`  \n**Pin:** finalized Optimism \`${selected.pin.number}\` / \`${selected.pin.hash}\`.\n\n## Binding\n\nCashModule, its DataProvider link, CashModuleSetters, Safe factory/beacon/implementation, pause/delay configuration, and all active withdrawal tokens were decoded identically across **${states.length}** anonymous independent provider families. Local source deployments were compared to CashModuleCore, CashModuleSetters, and EtherFiSafe fixed-pin runtimes in **5/5** local fork tests; metadata-normalized continuity across all three is **${sourceRuntimeContinuity}**. Active configuration contains **${state.withdrawTokens.length}** tokens versus **${declaredAddresses.length}** locally declared/resolvable tokens; active-not-local count is **${activeNotDeclared.length}**.\n\n## Token matrix\n\n| Token | Address | Decimals | Proxy | Tested behavior | Incomplete delivery |\n|---|---|---:|---|---|---|\n${rows}\n\n## Result\n\nConfigured withdrawal tokens: **${tokens.length}**. Standard-bool exact: **${result.behaviorSummary.standardBoolExactCount}**; no-return exact: **${result.behaviorSummary.noReturnExactCount}**; false-return observed: **${result.behaviorSummary.falseReturnObservedCount}**; fee/partial observed: **${result.behaviorSummary.feeOrPartialObservedCount}**; unresolved: **${result.behaviorSummary.behaviorUnresolvedCount}**. Local fork probes used dealt ephemeral balances only and executed **${result.forkTests.totalBehaviorProbeCount}** bounded transfer/transferFrom cases. Attacker gain remains **0 raw**.\n\n${incomplete.length ? "At least one active configured token reproduced incomplete delivery, so the conditional request-consumption behavior remains WATCH but not an extraction finding." : unresolved.length ? "No incomplete delivery was observed, but unresolved token behavior keeps the branch coverage-open WATCH." : !sourceRuntimeContinuity ? "No incomplete delivery was observed, but protocol source/runtime continuity remains coverage-open WATCH." : "No active configured token reproduced false or partial delivery on the tested paths. The conditional source primitive is blocked by current tested configuration and the branch closes at this pin."}\n\n## Scope limits\n\nThese results do not establish global token safety. They cover the exact fixed-pin runtimes and specific dealt-balance, same-block transfer paths only. Fee tiers, rebases, blacklists, hooks, upgrades, holder classes, and untested amounts remain outside the conclusion. Exact token source/build is not claimed where unavailable locally.\n\n## Pipeline\n\nBranch: \`${result.conclusion.branchPipeline}\`; extraction \`0/5\`; route/executable/signing \`0/0/false\`. Global highest remains **DebtManager donation 2/5 WATCH**.\n`;
  const inbox = { findingId: NAME, agentId: AGENT, role: "critical-research", status: branchDisposition.toLowerCase(), classification, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: true, summary: `${tokens.length} active CashModule withdrawal tokens fixed-pin bound; incomplete-delivery observed=${incomplete.length}, unresolved=${unresolved.length}, attacker gain zero; global donation pipeline unchanged.`, artifacts: [RAW, REPORT, MANIFEST], nextAction: result.nextGate };
  const handoffText = `# Handoff: ${NAME}\n\n- Finalized Optimism pin: \`${selected.pin.number}\` / \`${selected.pin.hash}\`.\n- Two-family exact decoded deployment/config/token-state agreement and terminal hash recheck.\n- Active withdrawal tokens: ${tokens.length}; standard bool exact ${result.behaviorSummary.standardBoolExactCount}; no-return exact ${result.behaviorSummary.noReturnExactCount}; false-return ${result.behaviorSummary.falseReturnObservedCount}; fee/partial ${result.behaviorSummary.feeOrPartialObservedCount}; unresolved ${result.behaviorSummary.behaviorUnresolvedCount}.\n- Fork tests: 5/5; ${result.forkTests.totalBehaviorProbeCount} dealt-ephemeral transfer semantics cases; no production mutation or real balances.\n- Classification: \`${classification}\`; attacker gain zero.\n- Branch ${result.conclusion.branchPipeline}, extraction 0/5; global DebtManager donation remains 2/5 WATCH.\n- Validate with \`node ${VALIDATOR}\`.\n`;
  for (const text of [rawText, reportText, JSON.stringify(inbox), handoffText]) sanitize(text);
  writeOwned(RAW, rawText);
  writeOwned(REPORT, reportText);
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  writeOwned(HANDOFF, handoffText);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, FORK_TEST, PREDECESSOR, PREDECESSOR_MANIFEST, DEPLOYMENTS, CONFIG, FIXTURES,
    "targets/cash-v3/src/modules/cash/CashModuleCore.sol", "targets/cash-v3/src/modules/cash/CashModuleSetters.sol", "targets/cash-v3/src/modules/cash/CashModuleStorageContract.sol", "targets/cash-v3/src/safe/EtherFiSafe.sol"
  ].map(hashFile);
  const manifest = { schemaVersion: 1, revision: REVISION, runId: result.runId, generatedAt, records, aggregateSha256: sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")) };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  sanitize(manifestText); writeOwned(MANIFEST, manifestText);
  console.log(JSON.stringify({ ok: true, runId: result.runId, classification, pin: result.pin, providerFamilies: states.length, tokenCount: tokens.length, standardBoolExact: result.behaviorSummary.standardBoolExactCount, noReturnExact: result.behaviorSummary.noReturnExactCount, falseReturnObserved: result.behaviorSummary.falseReturnObservedCount, feeOrPartialObserved: result.behaviorSummary.feeOrPartialObservedCount, unresolved: result.behaviorSummary.behaviorUnresolvedCount, forkTests: `${fork.passCount}/5`, behaviorProbes: result.forkTests.totalBehaviorProbeCount, branchPipeline: result.conclusion.branchPipeline, globalHighestPipeline: result.conclusion.globalHighestPipeline, manifestAggregateSha256: manifest.aggregateSha256 }, null, 2));
}

main().catch((error) => { console.error(`cash withdrawal token binding failed: ${safeError(error)}`); process.exit(1); });
