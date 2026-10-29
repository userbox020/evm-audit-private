#!/usr/bin/env node
"use strict";

// Authorized defensive, read-only Optimism review of EtherFi Cash default modules.
// Endpoint inventory values are used only in memory and are never printed or persisted.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { Interface, getAddress, id, keccak256, toQuantity } = require("ethers");
const { loadRpcUrls, getOrigin, PUBLIC_FALLBACKS } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const SCANNER = "tools/scan-critical-etherfi-default-module-capability.js";
const TEST = "tools/test-critical-etherfi-default-module-capability.js";
const RAW = "reports/raw/fast/critical-etherfi-default-module-capability.json";
const MANIFEST = "reports/raw/fast/critical-etherfi-default-module-capability-manifest.json";
const REPORT = "reports/critical-etherfi-default-module-capability.md";
const INBOX = "coordination/inbox/critical/2026-07-21-critical-etherfi-default-module-capability.json";
const HANDOFF = "coordination/handoffs/2026-07-21-critical-etherfi-default-module-capability-handoff.md";
const TARGET = "targets/cash-v3";
const REVISION = "audit-reviewer-corrections-r1";
const RETAINED_CAPTURE_SCANNER_SHA256 = "d610736791d4293ed67dcf3ae40b1868e847c5a944f6778756a1fab2dacbc4e5";
const CHAIN_ID = 10;
const MAX_PROVIDER_PROBES = 40;
const PROVIDER_TIMEOUT_MS = 5_000;
const MAX_RPC_READS = 210;
const RPC_TIMEOUT_MS = 18_000;
const OUTSIDER = getAddress("0x000000000000000000000000000000000000dEaD");
const ZERO = "0x0000000000000000000000000000000000000000";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const ADDR = {
  EtherFiDataProvider: "0xDC515Cb479a64552c5A11a57109C314E40A1A778",
  EtherFiSafeFactory: "0xF4e147Db314947fC1275a8CbB6Cde48c510cd8CF",
  CashModule: "0x7Ca0b75E67E33c0014325B739A8d019C4FE445F0",
  EtherFiHook: "0x5D3c4f5CF2208bB54e8fd129730d01D82d4611b3",
  DebtManager: "0x0078C5a459132e279056B2371fE8A8eC973A9553",
  EtherFiLiquidModule: "0x9008d1987A6aE5d3fFD9109967F85E631191E7A5",
  EtherFiLiquidModuleWithReferrer: "0x80D4B367659bb925A3790C76bC4da0B4f02d8613",
  FraxModule: "0x6742AF68E4f45715480E06B81775Cdb5Ba167088",
  StargateModule: "0xee77DEB6991f5d5CcAE5a327debA32d292E85c1c",
  EtherFiStakeModule: "0xD908117461378323C68257d522DC2De5D7890A1B",
  LiquidUSDLiquifierModule: "0x39161A44588ec2327a18D4707EA5216C721ba539",
};
const SCOPED_MODULE_NAMES = ["EtherFiLiquidModule", "EtherFiLiquidModuleWithReferrer", "FraxModule", "StargateModule", "EtherFiStakeModule", "LiquidUSDLiquifierModule"];
const TOKEN = {
  USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  WETH: "0x4200000000000000000000000000000000000006",
  weETH: "0x5A7fACB970D094B6C7FF1df0eA68D99E6e73CBFF",
  liquidETH: "0xf0bb20865277aBd641a307eCe5Ee04E79073416C",
  liquidBTC: "0x5f46d540b6eD704C3c8789105F30E075AA900726",
  liquidUSD: "0x08c6F91e2B681FaF5e17227F2a44C307b3C1364C",
  eBTC: "0x657e8C867D8B37dCC18fA4Caead9C45EB088C642",
  sETHFI: "0x86B5780b606940Eb59A062aA85a07959518c0161",
  frxUSD: "0x80Eede496655FB9047dd39d9f418d5483ED600df",
  ETHFI: "0xe0080d2F853ecDdbd81A643dC10DA075Df26fD3f",
  wHYPE: "0xd83E3d560bA6F05094d9D8B3EB8aaEA571D1864E",
  beHYPE: "0xA519AfBc91986c0e7501d7e34968FEE51CD901aC",
  EURC: "0xDCB612005417Dc906fF72c87DF732e5a90D49e11",
};

const DP = new Interface([
  "function getDefaultModules() view returns (address[])", "function getWhitelistedModules() view returns (address[])",
  "function getCashModule() view returns (address)", "function getHookAddress() view returns (address)",
  "function getEtherFiSafeFactory() view returns (address)", "function isDefaultModule(address) view returns (bool)",
  "function isWhitelistedModule(address) view returns (bool)",
]);
const FACTORY = new Interface([
  "function numContractsDeployed() view returns (uint256)", "function getDeployedAddresses(uint256,uint256) view returns (address[])",
  "function beacon() view returns (address)", "function paused() view returns (bool)",
]);
const SAFE = new Interface([
  "function isModuleEnabled(address) view returns (bool)", "function getModules() view returns (address[])",
  "function nonce() view returns (uint256)", "function execTransactionFromModule(address[],uint256[],bytes[])",
]);
const CASH = new Interface([
  "function getWhitelistedWithdrawAssets() view returns (address[])", "function getWhitelistedModulesCanRequestWithdraw() view returns (address[])",
  "function getDelays() view returns (uint64,uint64,uint64)", "function paused() view returns (bool)",
  "function processWithdrawal(address)", "function getDebtManager() view returns (address)", "function getCashModuleSetters() view returns (address)",
]);
const COMMON = new Interface([
  "function paused() view returns (bool)", "function etherFiDataProvider() view returns (address)", "function cashModule() view returns (address)",
  "function roleRegistry() view returns (address)", "function implementation() view returns (address)",
]);
const LIQUID = new Interface([
  "function weth() view returns (address)", "function liquidAssetToTeller(address) view returns (address)",
  "function liquidWithdrawQueue(address) view returns (address)", "function getNonce(address) view returns (uint256)",
  "function deposit(address,address,address,uint256,uint256,address,bytes)",
  "function withdraw(address,address,address,uint128,uint128,uint16,uint24,address,bytes)",
  "function requestBridge(address,uint32,address,uint256,address,address[],bytes[]) payable", "function executeBridge(address) payable",
]);
const FRAX = new Interface([
  "function fraxusd() view returns (address)", "function custodian() view returns (address)", "function remoteHop() view returns (address)",
  "function deposit(address,address,uint256,uint256,address,bytes)", "function withdraw(address,uint128,address,uint256,address,bytes)",
  "function requestAsyncWithdraw(address,address,uint256,address,bytes) payable", "function executeAsyncWithdraw(address) payable", "function getNonce(address) view returns (uint256)",
]);
const STARGATE = new Interface([
  "function getAssetConfig(address) view returns (bool isOFT,address pool)", "function getNonce(address) view returns (uint256)",
  "function requestBridge(address,uint32,address,uint256,address,uint256,address[],bytes[]) payable", "function executeBridge(address) payable",
]);
const STAKE = new Interface([
  "function syncPool() view returns (address)", "function weth() view returns (address)", "function weETH() view returns (address)",
  "function getNonce(address) view returns (uint256)", "function deposit(address,address,uint256,uint256,address,bytes)",
]);
const LIQUIFIER = new Interface([
  "function debtManager() view returns (address)", "function etherFiDataProvider() view returns (address)", "function cashModule() view returns (address)",
  "function roleRegistry() view returns (address)", "function paused() view returns (bool)", "function repayUsingLiquidUSD(address,uint256)",
]);

const ERRORS = Object.fromEntries([
  "OnlySafeAdmin()", "InvalidSignature()", "InvalidSignatures()", "OnlyEtherFiWallet()", "OnlyModules()",
  "EmptySigners()", "InsufficientSigners()",
  "NoWithdrawalQueuedForLiquid()", "NoWithdrawalQueuedForStargate()", "NoAsyncWithdrawalQueued()", "WithdrawalDoesNotExist()",
  "OnlyEtherFiSafe()", "OnlyWhitelistedModuleCanRequestWithdraw()", "AccountUnhealthy()",
].map((sig) => [id(sig).slice(0, 10).toLowerCase(), sig.slice(0, -2)]));

const MATRIX = [
  ["EtherFiLiquidModule", "deposit", "any relayer; victim-Safe admin EIP-191 signature", "module nonce keyed by safe; digest binds chainId,module,safe,input token,liquid token,amount,minReturn", "Safe batch; output remains Safe", "hook postOp ensureHealth"],
  ["EtherFiLiquidModule", "withdraw", "any relayer; victim-Safe admin EIP-191 signature", "module nonce keyed by safe; binds chainId,module,safe,liquidAsset,assetOut,amount,minReturn,discount,deadline", "Safe approves and queues to configured vault", "hook postOp ensureHealth"],
  ["EtherFiLiquidModule", "requestBridge", "any relayer; victim-Safe owner quorum", "Safe nonce; binds chainId,module,safe,asset,destEid,recipient,amount", "Cash withdrawal recipient forced to module; pending keyed by safe", "Cash request and final process each ensureHealth"],
  ["EtherFiLiquidModule", "executeBridge", "permissionless only for supplied valid Safe", "no new signature; exact safe-keyed module queue matched to exact Cash recipient/token/amount", "Cash transfers Safe->module, then configured teller bridges to stored recipient", "Cash final transfer ensureHealth; no later Safe mutation"],
  ["EtherFiLiquidModule", "cancelBridge", "any relayer; victim-Safe owner quorum", "Safe nonce; binds chainId,module,safe and cancel operation", "only same-safe queue/Cash request", "no collateral reduction"],
  ["EtherFiLiquidModuleWithReferrer", "deposit", "any relayer; victim-Safe admin EIP-191 signature", "module nonce keyed by safe; full fields and chain/module/safe bound", "Safe batch; referrer fixed zero", "hook postOp ensureHealth"],
  ["EtherFiLiquidModuleWithReferrer", "withdraw", "any relayer; victim-Safe admin EIP-191 signature", "module nonce keyed by safe; full fields and chain/module/safe bound", "configured queue; output remains attributable to Safe request", "hook postOp ensureHealth"],
  ["EtherFiLiquidModuleWithReferrer", "requestBridge", "any relayer; victim-Safe owner quorum", "Safe nonce; chain/module/safe/token/amount/destination bound", "Cash recipient forced module; queue keyed safe", "Cash request/final ensureHealth"],
  ["EtherFiLiquidModuleWithReferrer", "executeBridge", "permissionless after same-safe queue matures", "stored safe-keyed request exactly matched to Cash token/amount/recipient", "stored target/recipient only", "Cash final transfer ensureHealth; no later Safe mutation"],
  ["EtherFiLiquidModuleWithReferrer", "cancelBridge", "any relayer; victim-Safe owner quorum", "Safe nonce and operation/module/chain/safe bound", "same-safe state", "no collateral reduction"],
  ["FraxModule", "deposit", "any relayer; victim-Safe admin signature", "module nonce keyed safe; chain/module/safe/token/amount/minReturn bound", "custodian immutable; recipient Safe", "hook postOp ensureHealth"],
  ["FraxModule", "withdraw", "any relayer; victim-Safe admin signature", "module nonce keyed safe; chain/module/safe/amount/output/minReturn bound", "immutable custodian; recipient Safe", "hook postOp ensureHealth"],
  ["FraxModule", "requestAsyncWithdraw", "any relayer; victim-Safe admin signature", "module nonce keyed safe; chain/module/safe/frxUSD/recipient/amount bound", "Cash recipient forced module; pending keyed safe", "Cash request/final ensureHealth"],
  ["FraxModule", "executeAsyncWithdraw", "permissionless after same-safe queue matures", "stored safe-keyed amount/recipient matched to exact Cash module/token/amount", "immutable remoteHop; stored recipient", "Cash final transfer ensureHealth; no later Safe mutation"],
  ["FraxModule", "cancelAsyncWithdraw", "any relayer; victim-Safe owner quorum", "Safe nonce and chain/module/safe/cancel operation bound", "same-safe queue only", "no collateral reduction"],
  ["StargateModule", "requestBridge", "any relayer; victim-Safe owner quorum", "Safe nonce; chain/module/safe/destEid/token/amount/recipient/slippage bound", "Cash recipient forced module; pending keyed safe", "Cash request/final ensureHealth"],
  ["StargateModule", "executeBridge", "permissionless after same-safe queue matures", "stored safe-keyed full bridge tuple; exact Cash recipient/token/amount match", "configured pool only; stored recipient", "Cash final transfer ensureHealth; no later Safe mutation"],
  ["StargateModule", "cancelBridge", "any relayer; victim-Safe owner quorum", "Safe nonce and chain/module/safe/cancel operation bound", "same-safe queue only", "no collateral reduction"],
  ["EtherFiStakeModule", "deposit", "any relayer; victim-Safe admin signature", "module nonce keyed safe; chain/module/safe/asset/amount/minReturn bound", "immutable syncPool; output checked at Safe", "hook postOp ensureHealth"],
  ["LiquidUSDLiquifierModule", "repayUsingLiquidUSD", "ETHER_FI_WALLET_ROLE only; user must be deployed Safe", "role authorization; no user signature", "module USDC repays same user, then exact liquidUSD approval/transfer from same user", "repay improves debt; Safe approval batch still hook-checked"],
  ["LiquidUSDLiquifierModule", "withdrawLiquidUSD", "SETTLEMENT_DISPATCHER_BRIDGER_ROLE only", "role authorization", "module-owned inventory to fixed queue", "not Safe collateral path"],
  ["LiquidUSDLiquifierModule", "withdrawFunds", "RoleRegistry owner only", "owner authorization", "module-owned inventory; caller chooses token/recipient/amount", "privileged/excluded"],
].map(([module, entrypoint, callerRestriction, binding, executionPath, healthEnforcement]) => ({ module, entrypoint, callerRestriction, binding, executionPath, healthEnforcement }));

const SOURCE_SEEDS = [
  "src/safe/EtherFiSafe.sol", "src/hook/EtherFiHook.sol", "src/data-provider/EtherFiDataProvider.sol",
  "src/debt-manager/DebtManagerCore.sol", "src/modules/ModuleBase.sol", "src/modules/ModuleCheckBalance.sol",
  "src/modules/cash/CashModuleCore.sol", "src/modules/cash/CashModuleStorageContract.sol", "src/modules/cash/CashModuleSetters.sol",
  "src/modules/etherfi/EtherFiLiquidModule.sol", "src/modules/etherfi/EtherFiLiquidModuleWithReferrer.sol",
  "src/modules/frax/FraxModule.sol", "src/modules/stargate/StargateModule.sol", "src/modules/etherfi/EtherFiStakeModule.sol",
  "src/modules/etherfi/LiquidUSDLiquifierOP.sol",
];

function abs(rel) { return path.join(ROOT, rel); }
function sha(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function hashFile(rel) { const b = fs.readFileSync(abs(rel)); return { path: rel, bytes: b.length, sha256: sha(b) }; }
function jsonSafe(_k, v) { return typeof v === "bigint" ? v.toString() : v; }
function safeMessage(v) {
  return String(v == null ? "" : v).replace(/https?:\/\/[^\s"']+/gi, "[endpoint-redacted]")
    .replace(/[?&](?:key|token|api_key|apikey)=[^\s&"']+/gi, "[credential-redacted]").slice(0, 600);
}
function writeOwned(rel, text) {
  if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused: ${rel}`);
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text, "utf8");
}
function revertData(x, depth = 0) {
  if (depth > 6 || x == null) return null;
  if (typeof x === "string" && /^0x[0-9a-fA-F]*$/.test(x)) return x.toLowerCase();
  if (typeof x !== "object") return null;
  for (const k of ["data", "result", "return", "output", "originalError", "error"]) {
    const found = revertData(x[k], depth + 1); if (found != null) return found;
  }
  return null;
}
function decodeRevert(data) { return data && data.length >= 10 ? (ERRORS[data.slice(0, 10)] || `Unknown(${data.slice(0, 10)})`) : null; }
function slotAddress(word) {
  if (typeof word !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(word) || /^0x0{64}$/.test(word)) return null;
  try { return getAddress(`0x${word.slice(-40)}`); } catch { return null; }
}
function codeInfo(code) {
  const present = typeof code === "string" && /^0x[0-9a-fA-F]+$/.test(code) && !/^0x0*$/.test(code);
  return { present, bytes: present ? (code.length - 2) / 2 : 0, keccak256: present ? keccak256(code) : null };
}

function sourceImportClosure() {
  const targetRoot = abs(TARGET);
  const remapFile = path.join(targetRoot, "remappings.txt");
  const remappings = fs.readFileSync(remapFile, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line.includes("=")).map((line) => {
    const at = line.indexOf("="); return { prefix: line.slice(0, at), replacement: line.slice(at + 1) };
  }).sort((a, b) => b.prefix.length - a.prefix.length);
  const queue = SOURCE_SEEDS.map((x) => path.resolve(targetRoot, x));
  const seen = new Set(); const unresolved = [];
  while (queue.length) {
    const file = queue.shift();
    const canonical = path.resolve(file);
    if (seen.has(canonical)) continue;
    if (!canonical.startsWith(targetRoot + path.sep) || !fs.existsSync(canonical) || !fs.statSync(canonical).isFile()) {
      unresolved.push(path.relative(targetRoot, canonical).replace(/\\/g, "/")); continue;
    }
    seen.add(canonical);
    const text = fs.readFileSync(canonical, "utf8");
    const imports = [...text.matchAll(/import\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']\s*;/g)].map((m) => m[1]);
    for (const specifier of imports) {
      let resolved = null;
      if (specifier.startsWith(".")) resolved = path.resolve(path.dirname(canonical), specifier);
      else {
        const remap = remappings.find((x) => specifier.startsWith(x.prefix));
        resolved = remap ? path.resolve(targetRoot, remap.replacement, specifier.slice(remap.prefix.length)) : path.resolve(targetRoot, specifier);
      }
      if (resolved && fs.existsSync(resolved)) queue.push(resolved);
      else unresolved.push(`${path.relative(targetRoot, canonical).replace(/\\/g, "/")} -> ${specifier}`);
    }
  }
  const paths = [...seen].map((x) => `${TARGET}/${path.relative(targetRoot, x).replace(/\\/g, "/")}`).sort();
  const files = paths.map(hashFile);
  const unresolvedUnique = [...new Set(unresolved)].sort();
  return { method: "deterministic-recursive-solidity-import-resolution-with-remappings", seeds: [...SOURCE_SEEDS], complete: unresolvedUnique.length === 0, unresolved: unresolvedUnique, files, aggregateSha256: sha(files.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")) };
}

async function rpcFetch(url, method, params, timeout, origin) {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { code: response.status });
  const body = await response.json(); if (body.error) throw body.error; return body.result;
}
async function selectProvider() {
  const inventory = loadRpcUrls();
  const candidates = inventory.slice(0, MAX_PROVIDER_PROBES);
  let attempts = 0; let calls = 0;
  for (let i = 0; i < candidates.length; i++) {
    attempts++;
    try {
      calls++;
      const cid = await rpcFetch(candidates[i], "eth_chainId", [], PROVIDER_TIMEOUT_MS, getOrigin(candidates[i]));
      if (Number(BigInt(cid)) === CHAIN_ID) {
        calls++;
        const finalized = await rpcFetch(candidates[i], "eth_getBlockByNumber", ["finalized", false], PROVIDER_TIMEOUT_MS, getOrigin(candidates[i]));
        if (finalized?.hash) return { url: candidates[i], origin: getOrigin(candidates[i]), inventoryCount: inventory.length, attempts, calls, selectedFromInventory: true, fallbackUsed: false, selectedOrdinal: i };
      }
    } catch (_) { /* sanitized below */ }
  }
  const fallback = PUBLIC_FALLBACKS[CHAIN_ID];
  if (!fallback) return { url: null, origin: null, inventoryCount: inventory.length, attempts, calls, selectedFromInventory: false, fallbackUsed: false, selectedOrdinal: null };
  attempts++;
  try {
    calls++;
    const cid = await rpcFetch(fallback, "eth_chainId", [], PROVIDER_TIMEOUT_MS, null);
    if (Number(BigInt(cid)) === CHAIN_ID) {
      calls++;
      const finalized = await rpcFetch(fallback, "eth_getBlockByNumber", ["finalized", false], PROVIDER_TIMEOUT_MS, null);
      if (finalized?.hash) return { url: fallback, origin: null, inventoryCount: inventory.length, attempts, calls, selectedFromInventory: false, fallbackUsed: true, selectedOrdinal: null };
    }
  } catch (_) { /* fail closed */ }
  return { url: null, origin: null, inventoryCount: inventory.length, attempts, calls, selectedFromInventory: false, fallbackUsed: true, selectedOrdinal: null };
}

class Reader {
  constructor(selection) { this.selection = selection; this.count = 0; this.transcript = []; }
  async read(method, params, label, timeout = RPC_TIMEOUT_MS) {
    if (this.count >= MAX_RPC_READS) throw new Error(`RPC read cap reached before ${label}`);
    const number = ++this.count;
    try {
      const result = await rpcFetch(this.selection.url, method, params, timeout, this.selection.origin);
      this.transcript.push({ number, label, method, ok: true }); return { ok: true, result };
    } catch (e) {
      const data = revertData(e);
      this.transcript.push({ number, label, method, ok: false, errorCode: Number.isInteger(e?.code) ? e.code : null, revertData: data, decodedRevert: decodeRevert(data), error: safeMessage(e?.message || e) });
      return { ok: false, errorCode: Number.isInteger(e?.code) ? e.code : null, data, decodedRevert: decodeRevert(data), error: safeMessage(e?.message || e) };
    }
  }
  async call(to, iface, fn, args, blockTag, label, from = null) {
    const tx = { to, data: iface.encodeFunctionData(fn, args || []), ...(from ? { from } : {}) };
    const r = await this.read("eth_call", [tx, blockTag], label);
    if (!r.ok) return { ok: false, outcome: typeof r.data === "string" && /^0x[0-9a-f]+$/i.test(r.data) && r.data.length >= 10 ? "revert" : "provider-error", decodedRevert: r.decodedRevert, revertData: r.data, errorCode: r.errorCode, error: r.error };
    try {
      const out = iface.decodeFunctionResult(fn, r.result);
      return { ok: true, outcome: "success", value: out.length === 1 ? normalize(out[0]) : normalize(Array.from(out)) };
    } catch (e) { return { ok: false, outcome: "malformed-success", error: safeMessage(e.message) }; }
  }
}
function normalize(v) {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !/^\d+$/.test(k)).map(([k, x]) => [k, normalize(x)]));
  return v;
}
async function bindCode(reader, name, address, blockTag) {
  const [code, impl, admin, beacon] = await Promise.all([
    reader.read("eth_getCode", [address, blockTag], `${name}.runtime`),
    reader.read("eth_getStorageAt", [address, IMPL_SLOT, blockTag], `${name}.implementationSlot`),
    reader.read("eth_getStorageAt", [address, ADMIN_SLOT, blockTag], `${name}.adminSlot`),
    reader.read("eth_getStorageAt", [address, BEACON_SLOT, blockTag], `${name}.beaconSlot`),
  ]);
  const implementation = impl.ok ? slotAddress(impl.result) : null;
  const implementationCode = implementation ? await reader.read("eth_getCode", [implementation, blockTag], `${name}.implementationRuntime`) : null;
  return { name, address: getAddress(address), runtime: code.ok ? codeInfo(code.result) : null, implementation, implementationRuntime: implementationCode?.ok ? codeInfo(implementationCode.result) : null, admin: admin.ok ? slotAddress(admin.result) : null, beacon: beacon.ok ? slotAddress(beacon.result) : null };
}
async function view(reader, address, iface, fn, args, tag, label) { return reader.call(address, iface, fn, args, tag, label); }
function val(r) { return r?.ok ? r.value : null; }

function sourceEvidence() {
  const closure = sourceImportClosure();
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: abs(TARGET), encoding: "utf8", timeout: 15_000 });
  return { commit: git.status === 0 ? git.stdout.trim() : null, closure };
}
function localDeploymentNameMap() {
  const file = abs(`${TARGET}/deployments/mainnet/10/deployments.json`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return new Map(Object.entries(parsed.addresses || {}).map(([name, address]) => [String(address).toLowerCase(), name]));
}
function runLocalVerification(rpcUrl) {
  if (process.argv.includes("--skip-local-build")) return { attempted: false, pinBound: false, authoritativeForFixedPinEquality: false, reason: "explicitly skipped", localSourceRuntimeMatch: null };
  const run = spawnSync("forge", ["test", "--match-contract", "VerifyOPMainnetBytecode", "-vv"], {
    cwd: abs(TARGET), encoding: "utf8", timeout: 600_000, env: { ...process.env, OPTIMISM_RPC: rpcUrl }, maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${run.stdout || ""}\n${run.stderr || ""}`;
  const fullSuccess = (output.match(/Full Bytecode Match: Success/g) || []).length;
  const fullFail = (output.match(/Full Bytecode Match: Fail/g) || []).length;
  const partialFail = (output.match(/Partial Bytecode Match: Fail/g) || []).length;
  const testPass = (output.match(/\[PASS\]/g) || []).length;
  const comparisons = [];
  let currentName = null;
  for (const line of output.split(/\r?\n/)) {
    const heading = line.match(/------\s+(.+?)\s+------/);
    if (heading) currentName = heading[1].trim();
    const marker = line.match(/Full Bytecode Match:\s+(Success|Fail)/);
    if (marker && currentName) {
      comparisons.push({ contract: currentName, fullBytecodeMatch: marker[1] === "Success" });
      currentName = null;
    }
  }
  const scopedContracts = ["EtherFiDataProvider", "EtherFiSafeFactory", "EtherFiSafe", "EtherFiHook", "CashModuleCore", "DebtManagerCore", "EtherFiLiquidModule", "EtherFiLiquidModuleWithReferrer", "FraxModule", "StargateModule", "EtherFiStakeModule", "LiquidUSDLiquifierModule"];
  const scopedComparisons = scopedContracts.map((contract) => comparisons.find((x) => x.contract === contract) || { contract, fullBytecodeMatch: null });
  const scopedMatch = scopedComparisons.every((x) => x.fullBytecodeMatch === true);
  return {
    attempted: true, pinBound: false, authoritativeForFixedPinEquality: false, method: "repository VerifyOPMainnetBytecode test; internal vm.createSelectFork(rpc) selects provider latest and ignores the scanner fixed block", referenceBlock: "latest-dynamic", exitStatus: run.status, timedOut: Boolean(run.error && run.error.code === "ETIMEDOUT"), outputBytes: Buffer.byteLength(output), outputSha256: sha(output),
    fullBytecodeSuccessMarkers: fullSuccess, fullBytecodeFailMarkers: fullFail, partialBytecodeFailMarkers: partialFail, passMarkers: testPass,
    comparisons, scopedComparisons,
    localSourceRuntimeMatch: run.status === 0 && scopedMatch,
    fixedPinSourceRuntimeEquality: null,
    caveat: "Non-pin-bound and non-authoritative for fixed-pin equality. The repository verifier deploys local contracts with production constructor arguments, but internally forks provider latest. Its checker logs rather than asserts same-length byte mismatches, so success/fail markers are parsed explicitly. Pinned runtime hashes are authoritative only for deployed bytes, not source semantics.",
    sanitizedFailure: run.status === 0 ? null : safeMessage(run.error?.message || "forge verification failed"),
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const scannerHash = hashFile(SCANNER).sha256;
  const selection = await selectProvider();
  if (!selection.url) throw new Error("No authorized Optimism read-only provider resolved");
  const reader = new Reader(selection);
  const chain = await reader.read("eth_chainId", [], "pin.chainId");
  const finalized = await reader.read("eth_getBlockByNumber", ["finalized", false], "pin.finalized");
  if (!chain.ok || Number(BigInt(chain.result)) !== CHAIN_ID || !finalized.ok || !finalized.result?.hash) throw new Error("Unable to establish finalized Optimism pin");
  const blockNumber = Number(BigInt(finalized.result.number)); const blockTag = toQuantity(blockNumber);
  const pinned = await reader.read("eth_getBlockByNumber", [blockTag, false], "pin.exactNumber");
  const pin = { chainId: CHAIN_ID, blockNumber, blockHash: finalized.result.hash, timestamp: Number(BigInt(finalized.result.timestamp)), finalizedSelected: true, exactNumberHashMatch: pinned.ok && pinned.result?.hash === finalized.result.hash, terminalSameNumberHashMatch: null };

  const bindings = [];
  for (const [name, address] of Object.entries(ADDR)) bindings.push(await bindCode(reader, name, address, blockTag));
  const beaconR = await view(reader, ADDR.EtherFiSafeFactory, FACTORY, "beacon", [], blockTag, "factory.beacon");
  const beacon = val(beaconR);
  const safeImplR = beacon ? await view(reader, beacon, COMMON, "implementation", [], blockTag, "safeBeacon.implementation") : null;
  const safeImplementation = val(safeImplR);
  const safeImplCode = safeImplementation ? await reader.read("eth_getCode", [safeImplementation, blockTag], "safeImplementation.runtime") : null;

  const defaultsR = await view(reader, ADDR.EtherFiDataProvider, DP, "getDefaultModules", [], blockTag, "dataProvider.defaultModules");
  const whitelistR = await view(reader, ADDR.EtherFiDataProvider, DP, "getWhitelistedModules", [], blockTag, "dataProvider.whitelistedModules");
  const returnedDefaults = val(defaultsR) || [];
  const returnedDefaultSet = new Set(returnedDefaults.map((x) => x.toLowerCase()));
  const deploymentNames = localDeploymentNameMap();
  const predicateAddresses = [...new Set([...returnedDefaults, ...SCOPED_MODULE_NAMES.map((name) => ADDR[name])].map((x) => getAddress(x)))];
  const modulePredicateRows = [];
  for (const address of predicateAddresses) {
    const isDefault = val(await view(reader, ADDR.EtherFiDataProvider, DP, "isDefaultModule", [address], blockTag, `dataProvider.isDefault.${address}`));
    const isWhitelisted = val(await view(reader, ADDR.EtherFiDataProvider, DP, "isWhitelistedModule", [address], blockTag, `dataProvider.isWhitelisted.${address}`));
    const name = deploymentNames.get(address.toLowerCase()) || Object.entries(ADDR).find(([, value]) => value.toLowerCase() === address.toLowerCase())?.[0] || null;
    const scoped = SCOPED_MODULE_NAMES.some((scopedName) => ADDR[scopedName].toLowerCase() === address.toLowerCase());
    modulePredicateRows.push({ address, name, returnedDefault: returnedDefaultSet.has(address.toLowerCase()), scoped, isDefault, isWhitelisted, reviewStatus: scoped ? "scoped-six-reviewed" : "outside-six-not-reviewed" });
  }
  const identifiedDefaults = modulePredicateRows.filter((row) => row.returnedDefault && row.name != null);
  const unidentifiedDefaults = modulePredicateRows.filter((row) => row.returnedDefault && row.name == null);
  const unreviewedDefaults = modulePredicateRows.filter((row) => row.returnedDefault && !row.scoped);
  const cashAddrR = await view(reader, ADDR.EtherFiDataProvider, DP, "getCashModule", [], blockTag, "dataProvider.cashModule");
  const hookAddrR = await view(reader, ADDR.EtherFiDataProvider, DP, "getHookAddress", [], blockTag, "dataProvider.hook");
  const factoryAddrR = await view(reader, ADDR.EtherFiDataProvider, DP, "getEtherFiSafeFactory", [], blockTag, "dataProvider.factory");
  const withdrawAssetsR = await view(reader, ADDR.CashModule, CASH, "getWhitelistedWithdrawAssets", [], blockTag, "cash.withdrawAssets");
  const withdrawModulesR = await view(reader, ADDR.CashModule, CASH, "getWhitelistedModulesCanRequestWithdraw", [], blockTag, "cash.withdrawModules");
  const delaysR = await view(reader, ADDR.CashModule, CASH, "getDelays", [], blockTag, "cash.delays");
  const numR = await view(reader, ADDR.EtherFiSafeFactory, FACTORY, "numContractsDeployed", [], blockTag, "factory.numSafes");
  const numSafes = val(numR) == null ? null : Number(val(numR));
  const samples = [];
  if (numSafes && numSafes > 0) {
    const first = await view(reader, ADDR.EtherFiSafeFactory, FACTORY, "getDeployedAddresses", [0, 1], blockTag, "factory.firstSafe");
    const tail = await view(reader, ADDR.EtherFiSafeFactory, FACTORY, "getDeployedAddresses", [Math.max(0, numSafes - 2), 2], blockTag, "factory.tailSafes");
    for (const a of [...(val(first) || []), ...(val(tail) || [])]) if (!samples.includes(a)) samples.push(a);
  }
  const safeRows = [];
  for (const safe of samples) {
    const enabled = {};
    for (const name of SCOPED_MODULE_NAMES) {
      enabled[name] = val(await view(reader, safe, SAFE, "isModuleEnabled", [ADDR[name]], blockTag, `safe.${safe}.enabled.${name}`));
    }
    safeRows.push({ safe, enabled, locallyConfiguredModules: val(await view(reader, safe, SAFE, "getModules", [], blockTag, `safe.${safe}.localModules`)), nonce: val(await view(reader, safe, SAFE, "nonce", [], blockTag, `safe.${safe}.nonce`)) });
  }

  const pauses = {};
  for (const name of ["EtherFiSafeFactory", "CashModule", "EtherFiHook", "DebtManager", "EtherFiDataProvider", "LiquidUSDLiquifierModule"]) {
    pauses[name] = val(await view(reader, ADDR[name], COMMON, "paused", [], blockTag, `${name}.paused`));
  }
  const dependencies = {
    cash: { debtManager: val(await view(reader, ADDR.CashModule, CASH, "getDebtManager", [], blockTag, "cash.debtManager")), setters: val(await view(reader, ADDR.CashModule, CASH, "getCashModuleSetters", [], blockTag, "cash.setters")) },
    liquid: {}, liquidWithReferrer: {}, frax: {}, stargate: {}, stake: {}, liquifier: {}, hook: {}, safeFactory: { beacon, safeImplementation, safeImplementationRuntime: safeImplCode?.ok ? codeInfo(safeImplCode.result) : null },
  };
  for (const [key, address] of [["liquid", ADDR.EtherFiLiquidModule], ["liquidWithReferrer", ADDR.EtherFiLiquidModuleWithReferrer]]) {
    dependencies[key] = {
      dataProvider: val(await view(reader, address, COMMON, "etherFiDataProvider", [], blockTag, `${key}.dataProvider`)), cashModule: val(await view(reader, address, COMMON, "cashModule", [], blockTag, `${key}.cashModule`)), weth: val(await view(reader, address, LIQUID, "weth", [], blockTag, `${key}.weth`)),
      assets: {},
    };
    const assets = key === "liquid" ? [TOKEN.liquidETH, TOKEN.liquidBTC, TOKEN.liquidUSD, TOKEN.eBTC] : [TOKEN.sETHFI];
    for (const asset of assets) dependencies[key].assets[asset] = { teller: val(await view(reader, address, LIQUID, "liquidAssetToTeller", [asset], blockTag, `${key}.teller.${asset}`)), withdrawQueue: val(await view(reader, address, LIQUID, "liquidWithdrawQueue", [asset], blockTag, `${key}.queue.${asset}`)) };
  }
  dependencies.frax = {
    dataProvider: val(await view(reader, ADDR.FraxModule, COMMON, "etherFiDataProvider", [], blockTag, "frax.dataProvider")), cashModule: val(await view(reader, ADDR.FraxModule, COMMON, "cashModule", [], blockTag, "frax.cashModule")),
    fraxusd: val(await view(reader, ADDR.FraxModule, FRAX, "fraxusd", [], blockTag, "frax.fraxusd")), custodian: val(await view(reader, ADDR.FraxModule, FRAX, "custodian", [], blockTag, "frax.custodian")), remoteHop: val(await view(reader, ADDR.FraxModule, FRAX, "remoteHop", [], blockTag, "frax.remoteHop")),
  };
  dependencies.stargate = { dataProvider: val(await view(reader, ADDR.StargateModule, COMMON, "etherFiDataProvider", [], blockTag, "stargate.dataProvider")), cashModule: val(await view(reader, ADDR.StargateModule, COMMON, "cashModule", [], blockTag, "stargate.cashModule")), assetConfigs: {} };
  for (const asset of [TOKEN.USDC, TOKEN.weETH, TOKEN.ETHFI, TOKEN.wHYPE, TOKEN.beHYPE, TOKEN.EURC]) dependencies.stargate.assetConfigs[asset] = val(await view(reader, ADDR.StargateModule, STARGATE, "getAssetConfig", [asset], blockTag, `stargate.config.${asset}`));
  dependencies.stake = { dataProvider: val(await view(reader, ADDR.EtherFiStakeModule, COMMON, "etherFiDataProvider", [], blockTag, "stake.dataProvider")), cashModule: val(await view(reader, ADDR.EtherFiStakeModule, COMMON, "cashModule", [], blockTag, "stake.cashModule")), syncPool: val(await view(reader, ADDR.EtherFiStakeModule, STAKE, "syncPool", [], blockTag, "stake.syncPool")), weth: val(await view(reader, ADDR.EtherFiStakeModule, STAKE, "weth", [], blockTag, "stake.weth")), weETH: val(await view(reader, ADDR.EtherFiStakeModule, STAKE, "weETH", [], blockTag, "stake.weETH")) };
  dependencies.liquifier = { dataProvider: val(await view(reader, ADDR.LiquidUSDLiquifierModule, LIQUIFIER, "etherFiDataProvider", [], blockTag, "liquifier.dataProvider")), cashModule: val(await view(reader, ADDR.LiquidUSDLiquifierModule, LIQUIFIER, "cashModule", [], blockTag, "liquifier.cashModule")), debtManager: val(await view(reader, ADDR.LiquidUSDLiquifierModule, LIQUIFIER, "debtManager", [], blockTag, "liquifier.debtManager")), roleRegistry: val(await view(reader, ADDR.LiquidUSDLiquifierModule, LIQUIFIER, "roleRegistry", [], blockTag, "liquifier.roleRegistry")) };
  dependencies.hook.dataProvider = val(await view(reader, ADDR.EtherFiHook, new Interface(["function dataProvider() view returns (address)"]), "dataProvider", [], blockTag, "hook.dataProvider"));

  const victimA = samples[0] || ZERO; const victimB = samples[1] || samples[0] || ZERO;
  const probeDefs = [
    { name: "safe.direct-outsider-module-exec", to: victimB, iface: SAFE, fn: "execTransactionFromModule", args: [[], [], []], expected: ["OnlyModules()"], interpretation: "outsider is not an enabled module" },
    { name: "liquid.deposit-no-admin", to: ADDR.EtherFiLiquidModule, iface: LIQUID, fn: "deposit", args: [victimB, TOKEN.USDC, TOKEN.liquidETH, 1, 1, ZERO, "0x"], expected: ["OnlySafeAdmin()"], interpretation: "zero signer is not victim-Safe admin" },
    { name: "liquid.requestBridge-altered-safe-recipient", to: ADDR.EtherFiLiquidModule, iface: LIQUID, fn: "requestBridge", args: [victimB, 30101, TOKEN.liquidETH, 1, OUTSIDER, [], []], expected: ["EmptySigners()"], interpretation: "empty-signature outsider rejection only; does not prove valid-signature tuple isolation" },
    { name: "liquid.executeBridge-no-queue", to: ADDR.EtherFiLiquidModule, iface: LIQUID, fn: "executeBridge", args: [victimB], expected: ["NoWithdrawalQueuedForLiquid()"], interpretation: "no same-Safe queued bridge" },
    { name: "liquidRef.deposit-no-admin", to: ADDR.EtherFiLiquidModuleWithReferrer, iface: LIQUID, fn: "deposit", args: [victimB, TOKEN.USDC, TOKEN.sETHFI, 1, 1, ZERO, "0x"], expected: ["OnlySafeAdmin()"], interpretation: "zero signer is not victim-Safe admin" },
    { name: "liquidRef.requestBridge-altered-safe-recipient", to: ADDR.EtherFiLiquidModuleWithReferrer, iface: LIQUID, fn: "requestBridge", args: [victimB, 30101, TOKEN.sETHFI, 1, OUTSIDER, [], []], expected: ["EmptySigners()"], interpretation: "empty-signature outsider rejection only; does not prove valid-signature tuple isolation" },
    { name: "frax.deposit-no-admin", to: ADDR.FraxModule, iface: FRAX, fn: "deposit", args: [victimB, TOKEN.USDC, 1, 1, ZERO, "0x"], expected: ["OnlySafeAdmin()"], interpretation: "zero signer is not victim-Safe admin" },
    { name: "frax.requestAsync-altered-safe-recipient", to: ADDR.FraxModule, iface: FRAX, fn: "requestAsyncWithdraw", args: [victimB, OUTSIDER, 1_000_000_000_000n, ZERO, "0x"], expected: ["OnlySafeAdmin()"], interpretation: "empty-signature outsider rejection only; does not prove valid-signature tuple isolation" },
    { name: "frax.executeAsync-no-queue", to: ADDR.FraxModule, iface: FRAX, fn: "executeAsyncWithdraw", args: [victimB], expected: ["NoAsyncWithdrawalQueued()"], interpretation: "no same-Safe queued async withdrawal" },
    { name: "stargate.requestBridge-altered-safe-recipient", to: ADDR.StargateModule, iface: STARGATE, fn: "requestBridge", args: [victimB, 30101, TOKEN.USDC, 1, OUTSIDER, 100, [], []], expected: ["EmptySigners()"], interpretation: "empty-signature outsider rejection only; does not prove valid-signature tuple isolation" },
    { name: "stargate.executeBridge-no-queue", to: ADDR.StargateModule, iface: STARGATE, fn: "executeBridge", args: [victimB], expected: ["NoWithdrawalQueuedForStargate()"], interpretation: "no same-Safe queued bridge" },
    { name: "stake.deposit-no-admin", to: ADDR.EtherFiStakeModule, iface: STAKE, fn: "deposit", args: [victimB, TOKEN.WETH, 1, 1, ZERO, "0x"], expected: ["OnlySafeAdmin()"], interpretation: "zero signer is not victim-Safe admin" },
    { name: "liquifier.repay-outsider", to: ADDR.LiquidUSDLiquifierModule, iface: LIQUIFIER, fn: "repayUsingLiquidUSD", args: [victimB, 1], expected: ["OnlyEtherFiWallet()"], interpretation: "outsider lacks wallet role" },
    { name: "cash.processWithdrawal-no-queue", to: ADDR.CashModule, iface: CASH, fn: "processWithdrawal", args: [victimB], expected: ["WithdrawalDoesNotExist()"], interpretation: "infrastructure control probe; CashModule is outside the 22-row six-module matrix" },
  ];
  const probes = [];
  if (victimB !== ZERO) for (const def of probeDefs) {
    const response = await reader.call(def.to, def.iface, def.fn, def.args, blockTag, `probe.${def.name}`, OUTSIDER);
    const expectedSelectors = def.expected.map((signature) => id(signature).slice(0, 10).toLowerCase());
    const actualSelector = typeof response.revertData === "string" && response.revertData.length >= 10 ? response.revertData.slice(0, 10).toLowerCase() : null;
    const strictFailedClosed = response.outcome === "revert" && actualSelector != null && expectedSelectors.includes(actualSelector);
    probes.push({ name: def.name, target: def.to, function: def.fn, from: OUTSIDER, expectedRevertSignatures: def.expected, expectedRevertSelectors: expectedSelectors, actualRevertSelector: actualSelector, strictFailedClosed, interpretation: def.interpretation, ...response });
  }

  const terminal = await reader.read("eth_getBlockByNumber", [blockTag, false], "pin.terminalSameNumber");
  pin.terminalSameNumberHashMatch = terminal.ok && terminal.result?.hash === pin.blockHash;
  const source = sourceEvidence();
  const localVerification = runLocalVerification(selection.url);
  const defaultNames = identifiedDefaults.map((row) => row.name);
  const expectedDefaults = SCOPED_MODULE_NAMES;
  const strictProbeCount = probes.filter((x) => x.strictFailedClosed).length;
  const revertedProbeCount = probes.filter((x) => x.outcome === "revert").length;
  const allProbeBlocked = probes.length === probeDefs.length && strictProbeCount === probeDefs.length;
  const allSampleEnabled = safeRows.length > 0 && safeRows.every((r) => expectedDefaults.every((n) => r.enabled[n] === true));
  const bindingsComplete = bindings.every((b) => b.runtime?.present && (!b.implementation || b.implementationRuntime?.present));
  const allReturnedPredicatesExact = modulePredicateRows.filter((row) => row.returnedDefault).every((row) => row.isDefault === true && row.isWhitelisted === true);
  const unreviewedDefaultPhrase = unreviewedDefaults.length === 5 ? "five live defaults including CashModule" : `${unreviewedDefaults.length} live defaults including CashModule`;
  const cashAndOtherDefaultsPhrase = unreviewedDefaults.length === 5 ? "CashModule and four other live defaults" : `CashModule and ${Math.max(0, unreviewedDefaults.length - 1)} other live defaults`;
  const classification = "INCOMPLETE/WATCH/SCOPED-SIX-RUNTIME-AND-TUPLE-COVERAGE-OPEN";
  const runId = `etherfi-default-module-reviewer-r1-${blockNumber}-${pin.blockHash.slice(2, 14)}-${scannerHash.slice(0, 12)}`;
  const requiredForRoutePositive = [
    "an exact permissionless call that reaches victim-Safe value movement without victim admin/owner authorization",
    "a demonstrated cross-Safe/domain/nonce/queue field mismatch on the deployed runtime",
    "a collateral-reducing traced Safe/Cash transfer that commits despite the deployed fixed-pin solvency controls",
    "valid-signature altered-Safe/recipient tuple-isolation evidence, not merely empty-signature rejection",
    "a local pinned positive attacker value delta with exact current liquidity/economics",
  ];
  const blockers = [
    allProbeBlocked ? `All ${strictProbeCount} probes matched their concrete expected revert selectors.` : "One or more probes lacked an exact expected-selector revert and is not counted failed-closed.",
    "No permissionless positive value path or economics was established; exploit fork gate remains closed.",
    "The repository verifier is non-pin-bound and non-authoritative for fixed-pin source equality; core and Liquifier comparisons also mismatch at its dynamic latest reference.",
    "DataProvider, Hook, CashModule, DebtManager, SafeFactory and Liquifier deployed semantics remain source-consistent hypotheses only where their local verifier comparisons mismatch.",
    "Empty-signature altered-Safe/recipient probes establish outsider rejection only; valid-signature tuple isolation remains unproven.",
    `The review covers only six named non-Cash modules. ${unreviewedDefaultPhrase[0].toUpperCase()}${unreviewedDefaultPhrase.slice(1)} are outside the matrix and broad-negative conclusion; ${unidentifiedDefaults.length} remain unidentified.`,
    "Bounded Safe sampling is not proof over every deployed Safe; exact DataProvider predicates are retained separately.",
  ];
  const result = {
    schemaVersion: 2, revision: REVISION, reviewerCorrectionStatus: "APPLIED", runId, generatedAt: startedAt, scanner: SCANNER, agentId: "critical-etherfi-default-module-capability-20260721", role: "critical-research",
    captureProvenance: { captureRunId: runId, captureScannerSha256: scannerHash, captureTimestamp: startedAt, capturePin: pin, runIdSuffix: scannerHash.slice(0, 12), runIdSuffixBindsCaptureScannerHash: true },
    publicationProvenance: { currentPublicationScannerSha256: scannerHash, mode: "network-capture-and-initial-publication", laterCorrectionsOfflineNoNetwork: false, byteIdenticalCaptureReproductionClaimed: false, statement: "This scanner created this network capture. If edited later, an offline repackage must preserve capture identity and record the later publication scanner hash separately." },
    scope: "Optimism authorization and traced Safe/Cash solvency behavior for exactly six named non-Cash modules: EtherFiLiquidModule, EtherFiLiquidModuleWithReferrer, FraxModule, StargateModule, EtherFiStakeModule, LiquidUSDLiquifierModule",
    classification, signal: "🟠 WATCH", routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false,
    safety: { readOnlyRpc: true, endpointInventoryRead: true, endpointValuesPersisted: false, graphqlInventoryRead: false, envFilesRead: false, privateKeysRead: false, walletsUsed: false, signedActions: false, broadcasts: false, productionMutation: false, exploitFork: false, localSourceVerificationFork: localVerification.attempted },
    budgets: { providerSelection: { inventoryCandidateCount: selection.inventoryCount, maxProviderProbes: MAX_PROVIDER_PROBES, attempts: selection.attempts, calls: selection.calls, maxCalls: (MAX_PROVIDER_PROBES * 2) + 2, timeoutMs: PROVIDER_TIMEOUT_MS, selectedFromInventory: selection.selectedFromInventory, fallbackUsed: selection.fallbackUsed, selectedOrdinal: selection.selectedOrdinal }, rpc: { maxReads: MAX_RPC_READS, readsUsed: reader.count, timeoutMs: RPC_TIMEOUT_MS }, localVerificationTimeoutMs: 600_000 },
    pin, source, localVerification,
    reviewCoverage: { onlySixNamedNonCashModules: true, scopedModuleNames: SCOPED_MODULE_NAMES, cashModuleIncludedInAuthorizationMatrix: false, otherLiveDefaultsReviewed: false, broadAllDefaultsConclusion: false, caveat: "CashModule and every returned default not among the six scoped names are outside the 22-row user-path matrix. Unidentified defaults remain unreviewed." },
    deployment: { addresses: ADDR, bindings, safeBeacon: dependencies.safeFactory, dataProviderRuntimeSourceMismatchCaveat: true, defaultModules: val(defaultsR), observedDefaultModuleCount: returnedDefaults.length, modulePredicateRows, returnedDefaultPredicateCount: modulePredicateRows.filter((row) => row.returnedDefault).length, scopedPredicateCount: modulePredicateRows.filter((row) => row.scoped).length, allReturnedPredicatesExact, identifiedDefaults, unidentifiedDefaults, unreviewedDefaults, defaultModuleNames: defaultNames, allSixScopedDefaultsPresent: SCOPED_MODULE_NAMES.every((n) => modulePredicateRows.some((row) => row.scoped && row.name === n && row.isDefault === true && row.isWhitelisted === true)), whitelistedModules: val(whitelistR), cashModule: val(cashAddrR), hook: val(hookAddrR), factory: val(factoryAddrR) },
    liveState: { pauses, delays: val(delaysR), whitelistedWithdrawAssets: val(withdrawAssetsR), modulesCanRequestWithdraw: val(withdrawModulesR), numSafes, sampledSafes: safeRows, allExpectedDefaultsEnabledInSample: allSampleEnabled },
    dependencies, authorizationMatrix: MATRIX, authorizationMatrixScope: "six named non-Cash modules only", cashModuleIncludedInAuthorizationMatrix: false, authorizationMatrixCompleteForScopedEnumeratedUserAndModuleValuePaths: MATRIX.length === 22,
    finalStateSolvency: {
      conclusionScope: "traced Safe/Cash transfers for the six scoped modules only; conditional on deployed implementations whose fixed-pin source equivalence is unproven",
      directScopedModuleSafeCalls: "Local source shows EtherFiSafe module batches followed by Hook health enforcement, but fixed-pin Hook/DataProvider/DebtManager source equivalence is unproven. Treat this as source-consistent traced behavior, not broad deployed-runtime closure.",
      cashWithdrawalPath: "Local source shows Cash request and post-transfer health checks for scoped async flows. CashModule and DebtManager mismatch in the non-pin-bound verifier, so deployed fixed-pin semantics remain unproven.",
      approvalsAndCallbacks: "No broad final-health closure. Persistent approvals, integration-side later pulls, callback/reentrancy behavior, and state changes after the traced call batch remain residual risks unless independently runtime-traced.",
      residual: "Shared module balances are not per-Safe escrow accounting. Non-standard, rebasing, fee-on-transfer, false-return, or callback-capable assets can invalidate nominal transfer and final-balance assumptions. No current permissionless prerequisite was proven.",
    },
    outsiderProbes: probes, probeSemantics: { total: probes.length, reverted: revertedProbeCount, strictExpectedSelectorMatches: strictProbeCount, providerErrors: probes.filter((x) => x.outcome === "provider-error").length, malformedSuccesses: probes.filter((x) => x.outcome === "malformed-success").length, unknownOrEmptySelectors: probes.filter((x) => x.outcome === "revert" && !x.strictFailedClosed).length, allStrictlyFailedClosed: allProbeBlocked, alteredTupleLimitation: "Altered Safe/recipient calls with empty signatures prove outsider rejection only. They do not prove isolation under a valid signature from A replayed or mutated toward B." }, allOutsiderProbesFailedClosed: allProbeBlocked, transcript: reader.transcript, blockers, requiredForRoutePositive,
    nextReadOnlyStep: "Recover pin-bound verified source/build inputs for the mismatched core/Liquifier implementations, then read one real pending scoped-module withdrawal and compare its module tuple to CashModule.getData at the same finalized pin without execution.",
  };

  writeOwned(RAW, JSON.stringify(result, jsonSafe, 2) + "\n");
  const report = `# ${result.signal} — EtherFi six-module capability corrected revision\n\n` +
    `**Revision:** \`${REVISION}\` — audit-reviewer corrections \`APPLIED\`  \n**Classification:** \`${classification}\`  \n**Run:** \`${runId}\`  \n**Pin:** Optimism \`${blockNumber}\` / \`${pin.blockHash}\` (finalized; terminal recheck \`${pin.terminalSameNumberHashMatch}\`)  \n**Capture scanner SHA-256:** \`${scannerHash}\`  \n**Publication scanner SHA-256:** \`${scannerHash}\` (initial publication)  \n**Gates:** \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`, \`fork=false\`\n\n` +
    `## Scope and result\n\nThis revision covers exactly six named non-Cash modules: ${SCOPED_MODULE_NAMES.map((x) => `\`${x}\``).join(", ")}. CashModule is not in the 22-row user-path matrix. ${unreviewedDefaultPhrase[0].toUpperCase()}${unreviewedDefaultPhrase.slice(1)} are outside this branch conclusion (${cashAndOtherDefaultsPhrase}); ${unidentifiedDefaults.length} remain unidentified from the authoritative local deployment map.\n\nNo exact permissionless cross-Safe authority was established for the six scoped modules. All ${strictProbeCount}/${probeDefs.length} probes returned concrete expected revert selectors. Empty-signature altered-Safe/recipient probes prove outsider rejection only, not valid-signature tuple isolation.\n\nNo broad final-health conclusion is made. Source tracing is limited to Safe/Cash transfers and is conditional because core and Liquifier fixed-pin source/runtime equality is unproven. Persistent approvals, later integration pulls/callbacks, and non-standard asset behavior remain open.\n\n` +
    `## Key evidence\n\n- Live default set: ${returnedDefaults.length}; predicate rows: ${modulePredicateRows.filter((x) => x.returnedDefault).length}; exact \`isDefaultModule=true\` and \`isWhitelistedModule=true\` for all returned defaults: \`${allReturnedPredicatesExact}\`.\n- Identified defaults: ${identifiedDefaults.length}; unidentified defaults: ${unidentifiedDefaults.length}; scoped predicates: ${modulePredicateRows.filter((x) => x.scoped).length}.\n- Six scoped modules enabled in ${safeRows.length} sampled Safes; samples are corroboration only, not global proof.\n- Cash withdrawal-capable set count: ${(val(withdrawModulesR) || []).length}; withdrawal delay: ${(val(delaysR) || [null])[0] ?? "unknown"}.\n- Authorization matrix: ${MATRIX.length} rows, six modules only; CashModule excluded.\n- Strict probes: ${strictProbeCount}/${probeDefs.length}; reverted ${revertedProbeCount}; provider errors ${probes.filter((x) => x.outcome === "provider-error").length}; unknown/empty selector ${probes.filter((x) => x.outcome === "revert" && !x.strictFailedClosed).length}.\n- Repository verifier: \`pinBound=${localVerification.pinBound}\`, fixed-pin authoritative \`${localVerification.authoritativeForFixedPinEquality}\`, dynamic-latest scoped match \`${localVerification.localSourceRuntimeMatch}\`.\n- Transitive source/import closure: \`complete=${source.closure.complete}\`, files ${source.closure.files.length}, unresolved ${source.closure.unresolved.length}.\n- RPC budget: ${reader.count}/${MAX_RPC_READS} state reads plus ${selection.calls}/${(MAX_PROVIDER_PROBES * 2) + 2} provider-selection calls across ${selection.attempts} endpoint attempts.\n\n` +
    `## Blockers\n\n${blockers.map((x) => `- ${x}`).join("\n")}\n\n` +
    `## requiredForRoutePositive\n\n${requiredForRoutePositive.map((x) => `- ${x}`).join("\n")}\n\n` +
    `## nextReadOnlyStep\n\n${result.nextReadOnlyStep}\n\n` +
    `## Defensive tests and mitigations\n\n- Add valid-signature A-to-B mutation tests for every signed tuple; empty signatures are insufficient isolation evidence.\n- Property-test that each scoped module consumes only same-Safe nonce/queue state.\n- Runtime-trace persistent approvals, callbacks, and later pulls after the traced Safe/Cash transfer.\n- Reset approvals where integrations permit and reject non-standard/rebasing/fee-on-transfer assets unless accounting supports them.\n`;
  writeOwned(REPORT, report);
  const inbox = { findingId: "etherfi-default-module-capability", revision: REVISION, reviewerCorrectionStatus: "APPLIED", runId, agentId: result.agentId, role: result.role, status: "blocked", routePositive: 0, executableNow: 0, signedActionJustified: false, summary: "Corrected WATCH revision covers only six named non-Cash modules; exact predicate and expected-selector probes reject outsiders, while valid-signature tuple isolation and pin-bound core/Liquifier source equivalence remain open.", artifacts: [RAW, MANIFEST, REPORT], nextAction: result.nextReadOnlyStep };
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  writeOwned(HANDOFF, `# 2026-07-21 EtherFi default-module capability corrected handoff\n\n- Revision: \`${REVISION}\`; reviewer corrections \`APPLIED\`.\n- Run: \`${runId}\`; classification: \`${classification}\`.\n- Pin: Optimism \`${blockNumber}\` / \`${pin.blockHash}\`; terminal recheck \`${pin.terminalSameNumberHashMatch}\`.\n- Gates: route/executable/signing \`0/0/false\`; exploit fork \`false\`.\n- Publication count correction: ${returnedDefaults.length} observed minus ${SCOPED_MODULE_NAMES.length} scoped equals ${unreviewedDefaults.length} unreviewed: ${cashAndOtherDefaultsPhrase}.\n- Scope: six named non-Cash modules only; ${unreviewedDefaultPhrase} are outside the 22-row matrix.\n- Predicates: ${modulePredicateRows.filter((x) => x.returnedDefault).length} returned defaults checked; identified/unidentified ${identifiedDefaults.length}/${unidentifiedDefaults.length}.\n- Probes: strict expected-selector matches ${strictProbeCount}/${probeDefs.length}; empty-signature altered tuples do not prove valid-signature isolation.\n- Verifier: \`pinBound=${localVerification.pinBound}\`; fixed-pin equality remains unknown. Source closure complete: \`${source.closure.complete}\`.\n- Next: ${result.nextReadOnlyStep}\n`);
  const records = [...new Set([SCANNER, TEST, RAW, REPORT, INBOX, HANDOFF, `${TARGET}/remappings.txt`, `${TARGET}/deployments/mainnet/10/deployments.json`, ...source.closure.files.map((x) => x.path)])].map(hashFile);
  const aggregateSha256 = sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
  const manifest = { schemaVersion: 2, revision: REVISION, reviewerCorrectionStatus: "APPLIED", runId, generatedAt: new Date().toISOString(), algorithm: "sha256", captureProvenance: result.captureProvenance, publicationProvenance: result.publicationProvenance, sourceClosureComplete: source.closure.complete, records, aggregateSha256, routePositive: 0, executableNow: 0, signedActionJustified: false };
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ runId, revision: REVISION, pin, classification, routePositive: 0, executableNow: 0, signedActionJustified: false, rpcReads: reader.count, strictProbes: `${strictProbeCount}/${probeDefs.length}`, identifiedDefaults: identifiedDefaults.length, unidentifiedDefaults: unidentifiedDefaults.length, verifierPinBound: localVerification.pinBound, sourceClosureComplete: source.closure.complete, manifestAggregateSha256: aggregateSha256 }) + "\n");
}

function repackageExisting() {
  const raw = JSON.parse(fs.readFileSync(abs(RAW), "utf8"));
  const priorManifest = JSON.parse(fs.readFileSync(abs(MANIFEST), "utf8"));
  const publicationScannerSha256 = hashFile(SCANNER).sha256;
  const captureRunId = raw.runId;
  const captureSuffix = captureRunId.split("-").at(-1);
  if (captureSuffix !== RETAINED_CAPTURE_SCANNER_SHA256.slice(0, 12)) throw new Error("capture runId suffix does not bind retained capture scanner hash");
  const captureTimestamp = raw.captureProvenance?.captureTimestamp || raw.generatedAt;
  const capturePin = raw.captureProvenance?.capturePin || raw.pin;
  const provenanceStatement = "The runId is retained capture identity; its suffix binds to the capture scanner hash. Later reviewer/publication corrections were offline with no network calls. The current scanner is the publication/replay implementation, not a byte-identical reproduction of the capture scanner; any new network run would derive a new runId.";
  const observed = Number(raw.deployment?.observedDefaultModuleCount ?? raw.deployment?.defaultModules?.length ?? 0);
  const scoped = Number(raw.deployment?.scopedPredicateCount ?? raw.reviewCoverage?.scopedModuleNames?.length ?? 0);
  const unreviewed = Number(raw.deployment?.unreviewedDefaults?.length ?? 0);
  const otherThanCash = unreviewed - 1;
  if (unreviewed !== observed - scoped || otherThanCash < 0) throw new Error("derived default counts are inconsistent");
  raw.publicationCorrectionStatus = "APPLIED";
  raw.captureProvenance = { captureRunId, captureScannerSha256: RETAINED_CAPTURE_SCANNER_SHA256, captureTimestamp, capturePin, runIdSuffix: captureSuffix, runIdSuffixBindsCaptureScannerHash: true };
  raw.publicationProvenance = { currentPublicationScannerSha256: publicationScannerSha256, mode: "offline-publication-repackage", laterCorrectionsOfflineNoNetwork: true, networkCallsForPublicationCorrections: 0, byteIdenticalCaptureReproductionClaimed: false, newNetworkRunWouldDeriveNewRunId: true, statement: provenanceStatement };
  raw.reviewCoverage.observedDefaultCount = observed;
  raw.reviewCoverage.scopedDefaultCount = scoped;
  raw.reviewCoverage.unreviewedDefaultCount = unreviewed;
  raw.reviewCoverage.otherUnreviewedDefaultCountExcludingCashModule = otherThanCash;
  raw.deployment.unreviewedDefaultCount = unreviewed;
  raw.deployment.otherUnreviewedDefaultCountExcludingCashModule = otherThanCash;
  raw.blockers = (raw.blockers || []).map((line) => String(line)
    .replace(/5 other live defaults, including CashModule/g, "five live defaults including CashModule")
    .replace(/CashModule and 5 non-scoped live defaults/g, "CashModule and four other live defaults")
    .replace(/The review covers only six named non-Cash modules\. five live defaults including CashModule and unidentified rows, are outside the matrix and broad-negative conclusion\./g, "The review covers only six named non-Cash modules. Five live defaults including CashModule are outside the matrix and broad-negative conclusion; two remain unidentified."));
  writeOwned(RAW, JSON.stringify(raw, jsonSafe, 2) + "\n");

  let report = fs.readFileSync(abs(REPORT), "utf8");
  report = report
    .replace(/The other 5 live defaults are outside this branch conclusion;/g, "Five live defaults including CashModule (CashModule and four other live defaults) are outside this branch conclusion;")
    .replace(/5 other live defaults, including CashModule/g, "five live defaults including CashModule")
    .replace(/CashModule and 5 non-scoped live defaults/g, "CashModule and four other live defaults")
    .replace(/The review covers only six named non-Cash modules\. five live defaults including CashModule and unidentified rows, are outside the matrix and broad-negative conclusion\./g, "The review covers only six named non-Cash modules. Five live defaults including CashModule are outside the matrix and broad-negative conclusion; two remain unidentified.");
  const reportProvenance = `## Capture and publication provenance\n\n- Capture runId: \`${captureRunId}\`.\n- Capture scanner SHA-256: \`${RETAINED_CAPTURE_SCANNER_SHA256}\`; runId suffix \`${captureSuffix}\` binds to its prefix.\n- Capture timestamp/pin: \`${captureTimestamp}\`; Optimism \`${capturePin.blockNumber}\` / \`${capturePin.blockHash}\`.\n- Current publication scanner SHA-256: \`${publicationScannerSha256}\`.\n- ${provenanceStatement}\n\n`;
  if (/## Capture and publication provenance/.test(report)) report = report.replace(/## Capture and publication provenance[\s\S]*?(?=## Scope and result)/, reportProvenance);
  else report = report.replace("## Scope and result", `${reportProvenance}## Scope and result`);
  writeOwned(REPORT, report);

  const inbox = JSON.parse(fs.readFileSync(abs(INBOX), "utf8"));
  inbox.publicationCorrectionStatus = "APPLIED";
  inbox.observedDefaultCount = observed;
  inbox.scopedDefaultCount = scoped;
  inbox.unreviewedDefaultCount = unreviewed;
  inbox.otherUnreviewedDefaultCountExcludingCashModule = otherThanCash;
  inbox.captureProvenance = raw.captureProvenance;
  inbox.publicationProvenance = raw.publicationProvenance;
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");

  let handoff = fs.readFileSync(abs(HANDOFF), "utf8");
  handoff = handoff
    .replace(/CashModule and 5 non-scoped live defaults/g, "CashModule and four other live defaults")
    .replace(/5 other live defaults, including CashModule/g, "five live defaults including CashModule");
  if (!handoff.includes("Publication count correction:")) {
    handoff = handoff.replace("- Scope:", `- Publication count correction: ${observed} observed minus ${scoped} scoped equals ${unreviewed} unreviewed: CashModule and ${otherThanCash === 4 ? "four" : otherThanCash} other live defaults.\n- Scope:`);
  }
  const handoffProvenance = `- Capture provenance: runId \`${captureRunId}\`; scanner SHA-256 \`${RETAINED_CAPTURE_SCANNER_SHA256}\`; timestamp \`${captureTimestamp}\`; pin Optimism \`${capturePin.blockNumber}\` / \`${capturePin.blockHash}\`.\n- Publication provenance: current scanner SHA-256 \`${publicationScannerSha256}\`; later corrections offline/no-network. The retained runId suffix \`${captureSuffix}\` binds the capture scanner, not the current publication scanner; a new network run would derive a new runId. No byte-identical reproduction by the current scanner is claimed.\n`;
  if (/^- Capture provenance:/m.test(handoff)) handoff = handoff.replace(/^- Capture provenance:.*\n- Publication provenance:.*\n/m, handoffProvenance);
  else handoff = handoff.replace("- Gates:", `${handoffProvenance}- Gates:`);
  writeOwned(HANDOFF, handoff);

  const records = priorManifest.records.map((record) => hashFile(record.path));
  const aggregateSha256 = sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
  const manifest = { ...priorManifest, publicationCorrectionStatus: "APPLIED", captureProvenance: raw.captureProvenance, publicationProvenance: raw.publicationProvenance, observedDefaultCount: observed, scopedDefaultCount: scoped, unreviewedDefaultCount: unreviewed, otherUnreviewedDefaultCountExcludingCashModule: otherThanCash, records, aggregateSha256 };
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ mode: "offline-repackage", runId: raw.runId, pin: raw.pin, classification: raw.classification, routePositive: raw.routePositive, executableNow: raw.executableNow, signedActionJustified: raw.signedActionJustified, observed, scoped, unreviewed, otherThanCash, manifestAggregateSha256: aggregateSha256 }) + "\n");
}

const action = process.argv.includes("--repackage-existing") ? Promise.resolve().then(repackageExisting) : main();
action.catch((e) => { process.stderr.write(`scan failed: ${safeMessage(e?.message || e)}\n`); process.exitCode = 1; });
