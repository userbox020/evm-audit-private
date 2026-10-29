#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { Interface, getAddress, id } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const STEM = "beefy-balancer-v3-monad-deployment-binding-r3";
const FINDING_ID = "beefy-balancer-v3-monad-deployment-binding-r3";
const CHAIN_ID = 143n;
const STRATEGY = "0x9db4aa152d06206566187b26472583b3e59bd5c5";
const BEEFY_VAULT = "0xd0331a023c35514c2ef99eb34ed868737e9dcea3";
const METADATA_ID = "balancerv3-monad-usdt0-ausd-usdc";
const CAPTURE_FLAG = "--capture-beefy-balancer-v3-monad-binding-r3-once";
const EXPECTED_PACKAGE_AGGREGATE = "cadda993636b1a6aabf727493f3e940a9848121f0d74d4b2e79d3e7b6e6f317b";
const INVENTORY_REL = "rpc_endpoints.txt";
const PREFLIGHT_REL = `reports/raw/fast/${STEM}-preflight.json`;
const MANIFEST_REL = `reports/raw/fast/${STEM}-manifest.json`;
const REPORT_REL = `reports/${STEM}.md`;
const FIXTURE_REL = `tools/fixtures/${STEM}-fixtures.json`;
const OUTPUT_DIR_REL = "reports/raw/fast";
const CONSUMPTION_MARKER_REL = `reports/raw/fast/${STEM}.consumed`;
const ZERO = `0x${"0".repeat(40)}`;
const ZERO32 = `0x${"0".repeat(64)}`;
const IMPLEMENTATION_SLOT = `0x${(BigInt(id("eip1967.proxy.implementation")) - 1n).toString(16).padStart(64, "0")}`;
const BEACON_SLOT = `0x${(BigInt(id("eip1967.proxy.beacon")) - 1n).toString(16).padStart(64, "0")}`;
const ADMIN_SLOT = `0x${(BigInt(id("eip1967.proxy.admin")) - 1n).toString(16).padStart(64, "0")}`;
const ALLOWED_METHODS = Object.freeze(["eth_call", "eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt"]);
const ALLOWED_SET = new Set(ALLOWED_METHODS);
const CAPS = Object.freeze({ inventoryBytes: 1048576, inventoryRecords: 64, families: 2, rewards: 16,
  calls: 512, responseBytes: 2097152, aggregateResponseBytes: 67108864, requestBytes: 131072,
  requestMs: 10000, wallMs: 600000, retries: 0, outputBytes: 16777216 });

const REQUIRED_ARTIFACT_PATHS = Object.freeze([
  `tools/${STEM}-runner.js`, `tools/test-${STEM}.js`, `tools/validate-${STEM}.js`, FIXTURE_REL, REPORT_REL, PREFLIGHT_REL
]);
const LOCAL_INPUT_RELS = Object.freeze([
  "reports/beefy-4621d2dd-exact-source-acquisition.md", "reports/balancer-v3-exact-source-acquisition.md",
  "tools/profitable-delta-ledger-r5-state-reevaluation-step1c-runner.js",
  "targets/beefy-contracts-4621d2dd/contracts/BIFI/strategies/Balancer/StrategyBalancerV3.sol",
  "targets/beefy-contracts-4621d2dd/contracts/BIFI/strategies/Common/BaseAllToNativeFactoryStrat.sol",
  "targets/beefy-contracts-4621d2dd/contracts/BIFI/vaults/BeefyVaultV7.sol",
  "targets/beefy-contracts-4621d2dd/contracts/BIFI/interfaces/beefy/IBeefySwapper.sol",
  "targets/beefy-contracts-4621d2dd/contracts/BIFI/infra/BeefySwapper.sol",
  "targets/beefy-contracts-4621d2dd/contracts/BIFI/interfaces/beefy/IStrategyFactory.sol",
  "targets/beefy-contracts-4621d2dd/contracts/BIFI/interfaces/common/IFeeConfig.sol",
  "targets/beefy-contracts-4621d2dd/contracts/BIFI/interfaces/beethovenx/IBalancerVaultV3.sol",
  "targets/beefy-contracts-4621d2dd/contracts/BIFI/interfaces/curve/IRewardsGauge.sol",
  "targets/beefy-contracts-4621d2dd/contracts/BIFI/interfaces/aura/IAuraBooster.sol",
  "targets/beefy-contracts-4621d2dd/contracts/BIFI/interfaces/aura/IAuraRewardPool.sol",
  "targets/balancer-v3-monorepo-7861ea27/pkg/interfaces/contracts/vault/IVaultExplorer.sol",
  "targets/balancer-v3-monorepo-7861ea27/pkg/interfaces/contracts/vault/VaultTypes.sol",
  "targets/balancer-v3-monorepo-7861ea27/pkg/interfaces/contracts/pool-utils/IPoolInfo.sol",
  "targets/balancer-v3-monorepo-7861ea27/pkg/interfaces/contracts/pool-weighted/IWeightedPool.sol",
  "targets/balancer-v3-monorepo-7861ea27/pkg/interfaces/contracts/pool-stable/IStablePool.sol",
  "targets/balancer-v3-monorepo-7861ea27/pkg/interfaces/contracts/vault/IBasePoolFactory.sol",
  "targets/balancer-v3-monorepo-7861ea27/pkg/interfaces/contracts/solidity-utils/helpers/IVersion.sol",
  "targets/balancer-v3-monorepo-7861ea27/pkg/vault/contracts/Vault.sol",
  "targets/balancer-v3-monorepo-7861ea27/pkg/vault/contracts/VaultExtension.sol",
  "targets/balancer-v3-monorepo-7861ea27/pkg/vault/contracts/VaultAdmin.sol",
  "targets/balancer-v3-monorepo-7861ea27/pkg/vault/contracts/VaultExplorer.sol",
  "tools/package.json", "tools/package-lock.json"
]);

const scalarAbi = new Interface([
  "function owner() view returns (address)", "function vault() view returns (address)",
  "function factory() view returns (address)", "function want() view returns (address)",
  "function depositToken() view returns (address)", "function native() view returns (address)",
  "function swapper() view returns (address)", "function gauge() view returns (address)",
  "function booster() view returns (address)", "function rewardPool() view returns (address)",
  "function minter() view returns (address)", "function pid() view returns (uint256)",
  "function strategist() view returns (address)", "function lastHarvest() view returns (uint256)",
  "function totalLocked() view returns (uint256)", "function lockDuration() view returns (uint256)",
  "function harvestOnDeposit() view returns (bool)", "function balanceOf() view returns (uint256)",
  "function balanceOfWant() view returns (uint256)", "function balanceOfPool() view returns (uint256)",
  "function lockedProfit() view returns (uint256)", "function rewardsLength() view returns (uint256)",
  "function rewards(uint256) view returns (address)", "function minAmounts(address) view returns (uint256)",
  "function paused() view returns (bool)", "function stratName() view returns (string)",
  "function callReward() view returns (uint256)", "function rewardsAvailable() view returns (uint256)",
  "function getAllFees() view returns (((uint256 total,uint256 beefy,uint256 call,uint256 strategist,string label,bool active) performance,uint256 deposit,uint256 withdraw))",
  "function beacon() view returns (address)", "function implementation() view returns (address)",
  "function strategy() view returns (address)", "function totalSupply() view returns (uint256)",
  "function balance() view returns (uint256)", "function available() view returns (uint256)",
  "function getPricePerFullShare() view returns (uint256)", "function approvalDelay() view returns (uint256)",
  "function stratCandidate() view returns (address implementation,uint256 proposedTime)",
  "function decimals() view returns (uint8)", "function name() view returns (string)", "function symbol() view returns (string)",
  "function keeper() view returns (address)", "function globalPause() view returns (bool)",
  "function strategyPause(string) view returns (bool)", "function beefyFeeConfig() view returns (address)",
  "function beefyFeeRecipient() view returns (address)",
  "function getFees(address) view returns ((uint256 total,uint256 beefy,uint256 call,uint256 strategist,string label,bool active))",
  "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)",
  "function getTokens() view returns (address[])", "function staking_token() view returns (address)", "function stakingToken() view returns (address)",
  "function earned(address) view returns (uint256)", "function getReward(address) view returns (uint256)",
  "function version() view returns (string)", "function getNormalizedWeights() view returns (uint256[])",
  "function getAmplificationParameter() view returns (uint256,bool,uint256)",
  "function poolInfo(uint256) view returns (address,address,address,address,address,bool)",
  "function oracle() view returns (address)", "function slippage() view returns (uint256)",
  "function swapInfo(address,address) view returns (address,bytes,uint256,uint256,int8)",
  "function isPoolFromFactory(address) view returns (bool)"
]);
const explorerAbi = new Interface([
  "function getVaultExtension() view returns (address)",
  "function getVaultAdmin() view returns (address)", "function isPoolRegistered(address) view returns (bool)",
  "function isPoolInitialized(address) view returns (bool)", "function getPoolTokens(address) view returns (address[])",
  "function getPoolTokenCountAndIndexOfToken(address,address) view returns (uint256,uint256)",
  "function getPoolTokenRates(address) view returns (uint256[],uint256[])",
  "function getPoolData(address) view returns ((bytes32,address[],(uint8,address,bool)[],uint256[],uint256[],uint256[],uint256[]))",
  "function getPoolTokenInfo(address) view returns (address[],(uint8,address,bool)[],uint256[],uint256[])",
  "function getCurrentLiveBalances(address) view returns (uint256[])",
  "function getPoolConfig(address) view returns (((bool,bool,bool,bool),uint256,uint256,uint256,uint40,uint32,bool,bool,bool,bool))",
  "function getHooksConfig(address) view returns ((bool,bool,bool,bool,bool,bool,bool,bool,bool,bool,address))",
  "function getStaticSwapFeePercentage(address) view returns (uint256)",
  "function getAggregateSwapFeeAmount(address,address) view returns (uint256)",
  "function getAggregateYieldFeeAmount(address,address) view returns (uint256)",
  "function isPoolPaused(address) view returns (bool)", "function isPoolInRecoveryMode(address) view returns (bool)",
  "function getMinimumTradeAmount() view returns (uint256)", "function totalSupply(address) view returns (uint256)",
  "function getVaultPausedState() view returns (bool,uint32,uint32)", "function getProtocolFeeController() view returns (address)"
]);

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function normalizeAddress(value) { try { return getAddress(value).toLowerCase(); } catch (_) { return null; } }
function jsonValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return /^0x[0-9a-fA-F]{40}$/u.test(value) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^\d+$/u.test(key)).map(([key, item]) => [key, jsonValue(item)]));
  return value;
}
function stable(value) { return JSON.stringify(value, Object.keys(value || {}).sort()); }
function codeRecord(code) {
  if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(code)) return null;
  const bytes = Buffer.from(code.slice(2), "hex"); return { present: bytes.length > 0, bytes: bytes.length,
    sha256: bytes.length ? sha256(bytes) : null };
}
function slotAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(value) || !/^0{24}[0-9a-fA-F]{40}$/u.test(value.slice(2))) return null;
  return normalizeAddress(`0x${value.slice(-40)}`);
}
function classifyProxySlots(implementation, beacon) {
  const impl = implementation && implementation !== ZERO ? implementation : null;
  const beac = beacon && beacon !== ZERO ? beacon : null;
  return { implementationSlot: impl, beaconSlot: beac, ambiguity: Boolean(impl && beac),
    kind: impl && beac ? "AMBIGUOUS" : beac ? "BEACON_PROXY" : impl ? "EIP1967_PROXY" : "DIRECT_OR_UNKNOWN" };
}
function eip1898(hash) { return { blockHash: hash, requireCanonical: true }; }
function parseHeader(value) {
  if (!value || typeof value !== "object" || !/^0x[0-9a-fA-F]{64}$/u.test(value.hash || "")) return null;
  try { return { number: BigInt(value.number).toString(), hash: value.hash.toLowerCase(), timestamp: BigInt(value.timestamp).toString() }; }
  catch (_) { return null; }
}
function samePin(a, b) { return Boolean(a && b && a.number === b.number && a.hash === b.hash && a.timestamp === b.timestamp); }
function endpointFamily(url) { const host = url.hostname.toLowerCase(); return host; }
function parseInventoryText(text) {
  if (Buffer.byteLength(text) > CAPS.inventoryBytes) throw new Error("INVENTORY_CAP");
  const out = [], seen = new Set();
  const add = (raw, headers = {}) => { let url; try { url = new URL(raw); } catch (_) { return; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return;
    const key = `${url.href}\0${JSON.stringify(headers)}`; if (seen.has(key)) return; seen.add(key);
    out.push({ url, headers: { ...headers }, family: endpointFamily(url) }); };
  let parsed = null; try { parsed = JSON.parse(text); } catch (_) { /* annotated text */ }
  const visit = (value, monad = false) => { if (Array.isArray(value)) return value.forEach((item) => visit(item, monad));
    if (!value || typeof value !== "object") return; const explicit = monad || value.chainId === 143 || value.chainId === "143" ||
      /monad/iu.test(value.chain || value.network || value.name || "");
    if (explicit && typeof (value.url || value.endpoint || value.rpcUrl) === "string") add(value.url || value.endpoint || value.rpcUrl, value.headers || {});
    for (const [key, item] of Object.entries(value)) if (key !== "headers") visit(item, explicit); };
  if (parsed !== null) visit(parsed);
  for (const line of String(text).split(/\r?\n/u)) { let row = null; try { row = JSON.parse(line); } catch (_) { /* annotated line */ }
    if (row) { visit(row); continue; }
    if (!/(?:monad|chain(?:id)?\s*[:=]\s*(?:143|0x8f))/iu.test(line)) continue;
    const match = line.match(/https:\/\/[^\s<>'"`\])}]+/iu); if (!match) continue; const headers = {};
    for (const item of line.matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/giu)) headers[item[1]] = item[2]; add(match[0], headers); }
  if (out.length > CAPS.inventoryRecords) throw new Error("INVENTORY_CAP"); return out;
}
function secretCorpus(rows) { const set = new Set(); for (const row of rows) for (const value of [row.url.href, row.url.hostname,
  row.url.pathname, row.url.search, ...Object.keys(row.headers), ...Object.values(row.headers)]) if (String(value).length >= 4) {
  set.add(String(value)); set.add(String(value).toLowerCase()); } return [...set]; }
function assertNoSecrets(value, secrets = []) { const text = JSON.stringify(value), low = text.toLowerCase();
  if (/(?:https?|wss?):\/\//iu.test(text) || /"(?:endpoint|provider|hostname|domain|headers?)"\s*:/iu.test(text)) throw new Error("PROVIDER_MATERIAL_IN_OUTPUT");
  for (const item of secrets) if (text.includes(item) || low.includes(item.toLowerCase())) throw new Error("PROVIDER_MATERIAL_IN_OUTPUT"); return true; }

class Budget { constructor(now = Date.now) { this.now = now; this.start = now(); this.calls = 0; this.bytes = 0; }
  call() { if (++this.calls > CAPS.calls || this.now() - this.start > CAPS.wallMs) throw new Error("BUDGET_EXCEEDED"); }
  body(size) { this.bytes += size; if (size > CAPS.responseBytes || this.bytes > CAPS.aggregateResponseBytes) throw new Error("BUDGET_EXCEEDED"); }
  summary() { return { calls: this.calls, responseBytes: this.bytes, retries: 0, withinCaps: this.calls <= CAPS.calls && this.bytes <= CAPS.aggregateResponseBytes }; } }
function productionRpc(endpoint, method, params, context) {
  if (!ALLOWED_SET.has(method)) return Promise.resolve({ ok: false, reason: "METHOD_NOT_ALLOWED", result: null });
  context.budget.call(); const idValue = ++context.nextId; const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: idValue, method, params }));
  if (body.length > CAPS.requestBytes) throw new Error("BUDGET_EXCEEDED");
  return new Promise((resolve) => { let done = false, request; const finish = (result) => { if (done) return; done = true; clearTimeout(timer); try { request?.destroy(); } catch (_) {} resolve(result); };
    const timer = setTimeout(() => finish({ ok: false, reason: "TIMEOUT", result: null }), CAPS.requestMs);
    const options = { protocol: "https:", hostname: endpoint.url.hostname, port: endpoint.url.port || 443,
      path: `${endpoint.url.pathname}${endpoint.url.search}`, method: "POST", agent: false,
      headers: { ...endpoint.headers, "content-type": "application/json", accept: "application/json", "accept-encoding": "identity", "content-length": body.length } };
    try { request = https.request(options, (response) => { const chunks = []; let size = 0;
      response.on("data", (chunk) => { size += chunk.length; if (size > CAPS.responseBytes) finish({ ok: false, reason: "RESPONSE_CAP", result: null }); else chunks.push(Buffer.from(chunk)); });
      response.on("end", () => { if (done) return; context.budget.body(size); if (response.statusCode !== 200) return finish({ ok: false, reason: "HTTP_STATUS", result: null });
        try { const row = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (row.jsonrpc !== "2.0" || row.id !== idValue || Object.hasOwn(row, "error")) return finish({ ok: false, reason: "RPC_ERROR", result: null });
          finish({ ok: true, reason: null, result: row.result }); } catch (_) { finish({ ok: false, reason: "JSON_INVALID", result: null }); } }); });
      request.on("error", () => finish({ ok: false, reason: "TRANSPORT_ERROR", result: null })); request.end(body);
    } catch (_) { finish({ ok: false, reason: "TRANSPORT_ERROR", result: null }); } });
}
async function rpc(endpoint, method, params, context) { return (context.rpc || productionRpc)(endpoint, method, params, context); }
async function qualifyDescriptors(rows, context) {
  const qualified = []; for (const row of rows) { const chain = await rpc(row, "eth_chainId", [], context); if (!chain.ok) continue;
    let chainId; try { chainId = BigInt(chain.result); } catch (_) { continue; } if (chainId !== CHAIN_ID) continue;
    const block = await rpc(row, "eth_getBlockByNumber", ["finalized", false], context); const pin = block.ok ? parseHeader(block.result) : null; if (pin) qualified.push({ endpoint: row, pin }); }
  if (!qualified.length) return { selected: [], pin: null, familyCount: 0, consensus: false };
  const first = qualified[0].pin, agreeing = qualified.filter((row) => samePin(row.pin, first));
  const byFamily = new Map(); for (const row of agreeing) { if (byFamily.has(row.endpoint.family)) continue;
    const anchors = await qualificationAnchors(row.endpoint, row.pin, context); if (anchors.capable) byFamily.set(row.endpoint.family, { ...row, anchors }); }
  const families = [...byFamily.values()];
  return { selected: families.slice(0, 2), pin: first, familyCount: new Set(qualified.map((row) => row.endpoint.family)).size,
    capableFamilyCount: families.length, hostnameDistinctOnly: true, backendOperatorIndependence: false,
    consensus: families.length >= 2 && samePin(families[0].pin, families[1].pin) };
}
async function probeCall(endpoint, address, iface, fragment, args, pin, context) {
  if (!address) return { value: null, reason: "ADDRESS_UNAVAILABLE" };
  let data; try { data = iface.encodeFunctionData(fragment, args); } catch (_) { return { value: null, reason: "ABI_ENCODE_UNCERTAIN" }; }
  const response = await rpc(endpoint, "eth_call", [{ to: address, data }, eip1898(pin.hash)], context);
  if (!response.ok) return { value: null, reason: response.reason || "RPC_REVERT_OR_UNSUPPORTED" };
  try { const decoded = iface.decodeFunctionResult(fragment, response.result); return { value: jsonValue(decoded.length === 1 ? decoded[0] : [...decoded]), reason: null }; }
  catch (_) { return { value: null, reason: "ABI_DECODE_INVALID" }; }
}
async function readCode(endpoint, address, pin, context) { const row = await rpc(endpoint, "eth_getCode", [address, eip1898(pin.hash)], context);
  return row.ok ? { value: codeRecord(row.result), reason: null } : { value: null, reason: row.reason }; }
async function readSlot(endpoint, address, slot, pin, context) { const row = await rpc(endpoint, "eth_getStorageAt", [address, slot, eip1898(pin.hash)], context);
  if (!row.ok) return { value: null, reason: row.reason || "STORAGE_READ_FAILED" };
  const value = slotAddress(row.result); return value === null ? { value: null, reason: "STORAGE_WORD_MALFORMED" } : { value, reason: null }; }
async function qualificationAnchors(endpoint, pin, context) {
  const strategyCode = await readCode(endpoint, STRATEGY, pin, context), implementationSlot = await readSlot(endpoint, STRATEGY, IMPLEMENTATION_SLOT, pin, context),
    beaconSlot = await readSlot(endpoint, STRATEGY, BEACON_SLOT, pin, context), strategyVault = await probeCall(endpoint, STRATEGY, scalarAbi, "vault", [], pin, context),
    strategyWant = await probeCall(endpoint, STRATEGY, scalarAbi, "want", [], pin, context), vaultStrategy = await probeCall(endpoint, BEEFY_VAULT, scalarAbi, "strategy", [], pin, context),
    vaultWant = await probeCall(endpoint, BEEFY_VAULT, scalarAbi, "want", [], pin, context);
  const capable = strategyCode.value?.present === true && implementationSlot.reason === null && beaconSlot.reason === null &&
    normalizeAddress(valueOf(strategyVault)) === BEEFY_VAULT && normalizeAddress(valueOf(vaultStrategy)) === STRATEGY &&
    normalizeAddress(valueOf(strategyWant)) !== null && normalizeAddress(valueOf(strategyWant)) === normalizeAddress(valueOf(vaultWant));
  return { capable, strategyCode, implementationSlot, beaconSlot,
    fixedAnchors: { strategyVault, strategyWant, vaultStrategy, vaultWant } };
}
async function resolveProxy(endpoint, address, pin, context) {
  const runtime = await readCode(endpoint, address, pin, context), impl = await readSlot(endpoint, address, IMPLEMENTATION_SLOT, pin, context),
    beacon = await readSlot(endpoint, address, BEACON_SLOT, pin, context), admin = await readSlot(endpoint, address, ADMIN_SLOT, pin, context);
  const slotsReadable = impl.reason === null && beacon.reason === null;
  const slots = slotsReadable ? classifyProxySlots(impl.value, beacon.value) :
    { implementationSlot: impl.value, beaconSlot: beacon.value, ambiguity: null, kind: "UNRESOLVED_SLOT_READ" };
  let beaconGetter = { value: null, reason: "OPTIONAL_NOT_ATTEMPTED" }, beaconGetterCorroborates = null,
    beaconCode = { value: null, reason: "NOT_BEACON_PROXY" }, beaconImplementation = { value: null, reason: "NOT_BEACON_PROXY" },
    resolvedImplementation = slots.implementationSlot;
  if (slotsReadable && slots.beaconSlot) { beaconCode = await readCode(endpoint, slots.beaconSlot, pin, context);
    beaconGetter = await probeCall(endpoint, address, scalarAbi, "beacon", [], pin, context);
    beaconGetterCorroborates = valueOf(beaconGetter) === null ? null : normalizeAddress(valueOf(beaconGetter)) === slots.beaconSlot;
    beaconImplementation = await probeCall(endpoint, slots.beaconSlot, scalarAbi, "implementation", [], pin, context);
    resolvedImplementation = normalizeAddress(valueOf(beaconImplementation)); }
  const implementationRuntime = resolvedImplementation ? await readCode(endpoint, resolvedImplementation, pin, context) : { value: null, reason: "IMPLEMENTATION_UNRESOLVED" };
  const direct = slotsReadable && slots.kind === "DIRECT_OR_UNKNOWN";
  const resolved = slotsReadable && !slots.ambiguity && runtime.value?.present === true &&
    (direct || (slots.kind === "EIP1967_PROXY" && resolvedImplementation && implementationRuntime.value?.present === true) ||
      (slots.kind === "BEACON_PROXY" && beaconCode.value?.present === true && resolvedImplementation && implementationRuntime.value?.present === true));
  const unresolvedReason = resolved ? null : !slotsReadable ? "PROXY_SLOT_READ_UNRESOLVED" : slots.ambiguity ? "PROXY_SLOT_AMBIGUITY" :
    runtime.value?.present !== true ? "PROXY_RUNTIME_MISSING" : slots.kind === "BEACON_PROXY" && beaconCode.value?.present !== true ?
      "BEACON_RUNTIME_MISSING" : "IMPLEMENTATION_RUNTIME_MISSING_OR_UNRESOLVED";
  return { address, runtime, slots: { ...slots, implementationRead: impl, beaconRead: beacon, adminRead: admin,
    adminSlot: admin.value }, beaconCode, beaconGetter, beaconGetterCorroborates, beaconImplementation,
    resolvedImplementation, implementationRuntime, resolved, unresolvedReason, sourceRuntimeAttested: null };
}
function valueOf(row) { return row && row.reason === null ? row.value : null; }
async function probeMap(endpoint, address, iface, specs, pin, context) { const out = {};
  for (const [key, fragment, args = []] of specs) out[key] = await probeCall(endpoint, address, iface, fragment, args, pin, context); return out; }
async function tokenSnapshot(endpoint, token, owner, pin, context) {
  if (!token) return { address: null, code: { value: null, reason: "TOKEN_UNAVAILABLE" }, decimals: { value: null, reason: "TOKEN_UNAVAILABLE" }, balance: { value: null, reason: "TOKEN_UNAVAILABLE" } };
  return { address: token, code: await readCode(endpoint, token, pin, context),
    decimals: await probeCall(endpoint, token, scalarAbi, "decimals", [], pin, context),
    balance: await probeCall(endpoint, token, scalarAbi, "balanceOf(address)", [owner], pin, context) };
}
function rewardsBound(length) { const count = Number(length); return Number.isSafeInteger(count) && count >= 0 && count <= CAPS.rewards ? count : null; }
function tokenOrderCheck(wantTokens, vaultTokens, depositToken, indexRow) {
  if (!Array.isArray(wantTokens) || !Array.isArray(vaultTokens) || wantTokens.length !== vaultTokens.length) return null;
  const same = wantTokens.every((token, index) => token === vaultTokens[index]); const index = vaultTokens.indexOf(depositToken);
  const exactIndex = Array.isArray(indexRow) && String(indexRow[0]) === String(vaultTokens.length) && String(indexRow[1]) === String(index);
  return { sameOrder: same, depositTokenIndex: index, exactIndex: same && index >= 0 && exactIndex };
}
function triAnd(values) { return values.some((value) => value === false) ? false : values.every((value) => value === true) ? true : null; }
function triEqual(value, expected) { return value === null || value === undefined ? null : value === expected; }
function triOr(values) { return values.some((value) => value === true) ? true : values.every((value) => value === false) ? false : null; }
function triNot(value) { return value === true ? false : value === false ? true : null; }
function triPresent(value) { return value === null || value === undefined ? null : true; }
function deriveStopReasons(state) {
  const bindingValues = [state.bindings?.bidirectional, state.bindings?.tokenOrder?.sameOrder, state.bindings?.tokenOrder?.exactIndex];
  const mismatch = bindingValues.some((value) => value === false) ? true : bindingValues.every((value) => value === true) ? false : null;
  const identities = [state.strategyIdentity?.resolved, state.vaultIdentity?.resolved, state.balancer?.identity?.resolved];
  const runtimeUnresolved = identities.some((value) => value === false) ? true : identities.some((value) => value === undefined) ? null : false;
  const poolConfig = valueOf(state.balancer?.explorer?.poolConfig), strategyPaused = valueOf(state.strategy?.paused),
    factoryPaused = triOr([valueOf(state.factory?.globalPause), valueOf(state.factory?.strategyPause)]),
    poolPaused = valueOf(state.balancer?.explorer?.poolPaused), vaultPauseRow = valueOf(state.balancer?.explorer?.vaultPausedState),
    vaultPaused = Array.isArray(vaultPauseRow) ? vaultPauseRow[0] : null;
  const allowance = state.allowances?.wantToStaker ? valueOf(state.allowances.wantToStaker) : null;
  const zeroSupply = valueOf(state.vault?.totalSupply) === "0" ? true : valueOf(state.vault?.totalSupply) === null ? null : false;
  return {
    retiredOrMismatch: mismatch,
    zeroSupply,
    negligibleMateriality: null,
    runtimeUnresolved,
    unbalancedDisabled: Array.isArray(poolConfig) && Array.isArray(poolConfig[0]) ? Boolean(poolConfig[0][0]) : null,
    tokenOrIndexMismatch: mismatch,
    strategyPaused: strategyPaused === true ? true : strategyPaused === false ? false : null,
    factoryPaused,
    vaultPaused: vaultPaused === true ? true : vaultPaused === false ? false : null,
    poolPaused: poolPaused === true ? true : poolPaused === false ? false : null,
    notRegistered: triNot(valueOf(state.balancer?.explorer?.registered)),
    notInitialized: triNot(valueOf(state.balancer?.explorer?.initialized)),
    recoveryEnabled: valueOf(state.balancer?.explorer?.recoveryMode) === true ? true :
      valueOf(state.balancer?.explorer?.recoveryMode) === false ? false : null,
    hookRuntimeUnresolved: triNot(state.criticalGates?.hookRuntime),
    rateRuntimeOrTokenTypeUnresolved: triNot(state.criticalGates?.rateProvidersAndTokenTypes),
    poolParamsUnresolved: triNot(state.criticalGates?.poolTypeParametersVersion),
    poolFactoryUnresolved: state.balancer?.pool?.poolFactoryUnresolved === true ? true :
      state.balancer?.pool?.poolFactoryUnresolved === false ? false : null,
    swapRoutesAbsent: triNot(state.reachability?.routeSemanticsResolved),
    allowanceAbsent: allowance === "0" ? true : allowance === null ? null : false,
    unsupportedPoolConfigHooksRates: [state.balancer?.explorer?.poolConfig, state.balancer?.explorer?.hooksConfig,
      state.balancer?.explorer?.tokenRates].some((row) => row?.value === null) ? true : false,
    harvestTooSmall: null
  };
}
async function captureFamily(endpoint, pin, context) {
  const strategyIdentity = await resolveProxy(endpoint, STRATEGY, pin, context);
  const strategy = await probeMap(endpoint, STRATEGY, scalarAbi, [
    ["owner","owner"],["vault","vault"],["factory","factory"],["want","want"],["depositToken","depositToken"],
    ["native","native"],["swapper","swapper"],["gauge","gauge"],["booster","booster"],["rewardPool","rewardPool"],
    ["minter","minter"],["pid","pid"],["strategist","strategist"],["lastHarvest","lastHarvest"],
    ["totalLocked","totalLocked"],["lockDuration","lockDuration"],["harvestOnDeposit","harvestOnDeposit"],
    ["balanceOf","balanceOf()"],["balanceOfWant","balanceOfWant"],["balanceOfPool","balanceOfPool"],
    ["lockedProfit","lockedProfit"],["rewardsLength","rewardsLength"],["paused","paused"],["stratName","stratName"],
    ["getAllFees","getAllFees"],["callReward","callReward"],["rewardsAvailable","rewardsAvailable"]
  ], pin, context);
  const rewardCount = rewardsBound(valueOf(strategy.rewardsLength)); const rewards = [];
  if (rewardCount === null) strategy.rewardsCap = { value: null, reason: "REWARDS_LENGTH_EXCEEDS_16_OR_INVALID" };
  else for (let index = 0; index < rewardCount; index++) rewards.push(await probeCall(endpoint, STRATEGY, scalarAbi, "rewards", [index], pin, context));
  strategy.rewards = rewards;
  const vaultAddress = normalizeAddress(valueOf(strategy.vault)), want = normalizeAddress(valueOf(strategy.want)),
    depositToken = normalizeAddress(valueOf(strategy.depositToken)), native = normalizeAddress(valueOf(strategy.native)),
    factoryAddress = normalizeAddress(valueOf(strategy.factory)), swapper = normalizeAddress(valueOf(strategy.swapper)),
    gauge = normalizeAddress(valueOf(strategy.gauge)), booster = normalizeAddress(valueOf(strategy.booster)), rewardPool = normalizeAddress(valueOf(strategy.rewardPool));
  strategy.minAmounts = { native: await probeCall(endpoint, STRATEGY, scalarAbi, "minAmounts", [native || ZERO], pin, context),
    deposit: await probeCall(endpoint, STRATEGY, scalarAbi, "minAmounts", [depositToken || ZERO], pin, context), rewards: [] };
  for (const reward of rewards) strategy.minAmounts.rewards.push(await probeCall(endpoint, STRATEGY, scalarAbi, "minAmounts", [normalizeAddress(valueOf(reward)) || ZERO], pin, context));
  const vaultIdentity = await resolveProxy(endpoint, BEEFY_VAULT, pin, context);
  const vault = await probeMap(endpoint, BEEFY_VAULT, scalarAbi, [["owner","owner"],["strategy","strategy"],["want","want"],
    ["totalSupply","totalSupply"],["balance","balance"],["available","available"],["pricePerFullShare","getPricePerFullShare"],
    ["approvalDelay","approvalDelay"],["stratCandidate","stratCandidate"],["decimals","decimals"],["name","name"],["symbol","symbol"]], pin, context);
  const factory = await probeMap(endpoint, factoryAddress, scalarAbi, [["runtime","owner"],["native","native"],["keeper","keeper"],
    ["globalPause","globalPause"],["strategyPause","strategyPause",[valueOf(strategy.stratName) || "BalancerV3"]],
    ["beefyFeeConfig","beefyFeeConfig"],["beefyFeeRecipient","beefyFeeRecipient"]], pin, context);
  factory.code = factoryAddress ? await readCode(endpoint, factoryAddress, pin, context) : { value: null, reason: "FACTORY_UNAVAILABLE" };
  const feeConfigAddress = normalizeAddress(valueOf(factory.beefyFeeConfig));
  const feeConfig = { address: feeConfigAddress, code: feeConfigAddress ? await readCode(endpoint, feeConfigAddress, pin, context) : { value: null, reason: "FEE_CONFIG_UNAVAILABLE" },
    fees: feeConfigAddress ? await probeCall(endpoint, feeConfigAddress, scalarAbi, "getFees", [STRATEGY], pin, context) : { value: null, reason: "ABI_OR_ADDRESS_UNCERTAIN" } };
  const rewardAddresses = rewards.map(valueOf).map(normalizeAddress).filter(Boolean), tokenAddresses = [...new Set([native, depositToken, want, ...rewardAddresses].filter(Boolean))];
  const tokens = []; for (const token of tokenAddresses) tokens.push(await tokenSnapshot(endpoint, token, STRATEGY, pin, context));
  const pidValue = valueOf(strategy.pid), useAura = pidValue === null ? null : BigInt(pidValue) !== 1234567n;
  const auraPoolInfo = useAura === true && booster ? await probeCall(endpoint, booster, scalarAbi, "poolInfo", [pidValue], pin, context) :
    { value: null, reason: useAura === false ? "NOT_AURA" : "AURA_IDENTITY_UNRESOLVED" };
  const auraInfo = valueOf(auraPoolInfo);
  const aura = { useAura, poolInfo: auraPoolInfo, lptokenMatchesWant: Array.isArray(auraInfo) ? normalizeAddress(auraInfo[0]) === want : null,
    gaugeMatchesStrategyGetter: Array.isArray(auraInfo) ? normalizeAddress(auraInfo[2]) === gauge : null,
    rewardPoolMatchesStrategyGetter: Array.isArray(auraInfo) ? normalizeAddress(auraInfo[3]) === rewardPool : null,
    shutdown: Array.isArray(auraInfo) ? auraInfo[5] : null };
  const staker = useAura === true ? booster : useAura === false ? gauge : null;
  const allowances = { wantToStaker: want && staker ? await probeCall(endpoint, want, scalarAbi, "allowance", [STRATEGY, staker], pin, context) : { value: null, reason: "STAKER_UNPROVEN" },
    nativeToSwapper: native && swapper ? await probeCall(endpoint, native, scalarAbi, "allowance", [STRATEGY, swapper], pin, context) : { value: null, reason: "SWAPPER_UNAVAILABLE" } };
  const balancerVault = normalizeAddress(valueOf(await probeCall(endpoint, STRATEGY,
    new Interface(["function balancerVault() view returns(address)"]), "balancerVault", [], pin, context)));
  const balancerIdentity = balancerVault ? await resolveProxy(endpoint, balancerVault, pin, context) : null;
  const explorer = balancerVault ? await probeMap(endpoint, balancerVault, explorerAbi, [["extension","getVaultExtension"],
    ["admin","getVaultAdmin"],["protocolFeeController","getProtocolFeeController"],["vaultPausedState","getVaultPausedState"],
    ["registered","isPoolRegistered",[want]],["initialized","isPoolInitialized",[want]],
    ["poolTokens","getPoolTokens",[want]],["tokenCountIndex","getPoolTokenCountAndIndexOfToken",[want,depositToken]],
    ["tokenRates","getPoolTokenRates",[want]],["poolData","getPoolData",[want]],["tokenInfo","getPoolTokenInfo",[want]],
    ["liveBalances","getCurrentLiveBalances",[want]],["poolConfig","getPoolConfig",[want]],
    ["hooksConfig","getHooksConfig",[want]],["staticSwapFee","getStaticSwapFeePercentage",[want]],
    ["poolPaused","isPoolPaused",[want]],["recoveryMode","isPoolInRecoveryMode",[want]],
    ["minimumTradeAmount","getMinimumTradeAmount"],["bptSupply","totalSupply",[want]]], pin, context) : {};
  const components = {}; for (const key of ["extension","admin","protocolFeeController"]) { const address = normalizeAddress(valueOf(explorer[key])); components[key] = address ? await resolveProxy(endpoint, address, pin, context) : null; }
  const observedPoolConfig = valueOf(explorer.poolConfig);
  explorer.unbalancedLiquidityEnabled = Array.isArray(observedPoolConfig) && Array.isArray(observedPoolConfig[0]) ?
    !Boolean(observedPoolConfig[0][0]) : null;
  const hooksValue = valueOf(explorer.hooksConfig), hookAddress = Array.isArray(hooksValue) ? normalizeAddress(hooksValue[10]) : null;
  explorer.hookAddress = hookAddress; explorer.hookCode = hookAddress && hookAddress !== ZERO ? await readCode(endpoint, hookAddress, pin, context) :
    { value: null, reason: hookAddress === ZERO ? "NO_HOOK_CONTRACT" : "HOOK_CONFIG_UNRESOLVED" };
  const wantPool = want ? await probeMap(endpoint, want, scalarAbi, [["tokens","getTokens"],["version","version"],
    ["weightedWeights","getNormalizedWeights"],["stableAmp","getAmplificationParameter"]], pin, context) : {};
  wantPool.factoryRelationship = { value: null, reason: "NO_SOURCE_BACKED_PUBLIC_POOL_FACTORY_GETTER" };
  wantPool.poolFactoryUnresolved = true;
  wantPool.code = want ? await readCode(endpoint, want, pin, context) : { value: null, reason: "WANT_UNAVAILABLE" };
  const weighted = valueOf(wantPool.weightedWeights), stableAmp = valueOf(wantPool.stableAmp);
  wantPool.poolType = weighted && !stableAmp ? "WEIGHTED" : stableAmp && !weighted ? "STABLE" : null;
  wantPool.poolSpecificParameters = wantPool.poolType === "WEIGHTED" ? { normalizedWeights: weighted, amplification: null } :
    wantPool.poolType === "STABLE" ? { normalizedWeights: null, amplification: stableAmp } :
      { normalizedWeights: null, amplification: null, blocker: "POOL_TYPE_OR_PARAMETERS_UNRESOLVED" };
  const wantTokens = valueOf(wantPool.tokens), vaultTokens = valueOf(explorer.poolTokens);
  const tokenOrder = tokenOrderCheck(wantTokens, vaultTokens, depositToken, valueOf(explorer.tokenCountIndex));
  const poolTokens = [], aggregateFees = []; if (Array.isArray(vaultTokens)) for (const token of vaultTokens) {
    const address = normalizeAddress(token); poolTokens.push(await tokenSnapshot(endpoint, address, balancerVault, pin, context));
    aggregateFees.push({ token: address,
      swap: await probeCall(endpoint, balancerVault, explorerAbi, "getAggregateSwapFeeAmount", [want, address], pin, context),
      yield: await probeCall(endpoint, balancerVault, explorerAbi, "getAggregateYieldFeeAmount", [want, address], pin, context) });
  }
  const tokenInfoValue = valueOf(explorer.tokenInfo), ratesValue = valueOf(explorer.tokenRates), poolDataValue = valueOf(explorer.poolData);
  const arrayLengths = [vaultTokens, tokenInfoValue?.[1], tokenInfoValue?.[2], tokenInfoValue?.[3], ratesValue?.[0], ratesValue?.[1],
    poolDataValue?.[1], poolDataValue?.[2], poolDataValue?.[3], poolDataValue?.[4], poolDataValue?.[5], poolDataValue?.[6]];
  explorer.arrayConsistency = arrayLengths.every(Array.isArray) ? arrayLengths.every((row) => row.length === vaultTokens.length) : null;
  explorer.rateProviderCodes = [];
  if (Array.isArray(tokenInfoValue?.[1])) for (const info of tokenInfoValue[1]) { const provider = Array.isArray(info) ? normalizeAddress(info[1]) : null;
    explorer.rateProviderCodes.push({ provider, code: provider && provider !== ZERO ? await readCode(endpoint, provider, pin, context) :
      { value: null, reason: provider === ZERO ? "STANDARD_TOKEN_NO_RATE_PROVIDER" : "RATE_PROVIDER_UNRESOLVED" } }); }
  const holdWant = useAura === false && gauge === ZERO ? true : useAura === null ? null : false;
  const stakingTarget = useAura === true ? rewardPool : useAura === false && holdWant === false ? gauge : null;
  const stakingToken = stakingTarget ? await probeCall(endpoint, stakingTarget, scalarAbi, "stakingToken", [], pin, context) :
    { value: null, reason: useAura === false ? "GAUGE_STAKING_TOKEN_GETTER_NOT_SOURCE_BACKED" : "STAKER_UNPROVEN" };
  const swapperIdentity = swapper ? await resolveProxy(endpoint, swapper, pin, context) : null;
  const swapperOracle = swapper ? await probeCall(endpoint, swapper, scalarAbi, "oracle", [], pin, context) : { value: null, reason: "SWAPPER_UNAVAILABLE" };
  const swapperSlippage = swapper ? await probeCall(endpoint, swapper, scalarAbi, "slippage", [], pin, context) : { value: null, reason: "SWAPPER_UNAVAILABLE" };
  const oracleAddress = normalizeAddress(valueOf(swapperOracle)); const oracleCode = oracleAddress ? await readCode(endpoint, oracleAddress, pin, context) : { value: null, reason: "ORACLE_UNRESOLVED" };
  const routePairs = rewardAddresses.filter((token) => token !== native).map((token) => [token, native]);
  if (native && depositToken && native !== depositToken) routePairs.push([native, depositToken]);
  const swapRoutes = []; for (const [from, to] of routePairs) { const info = await probeCall(endpoint, swapper, scalarAbi, "swapInfo", [from, to], pin, context), decoded = valueOf(info);
    const router = Array.isArray(decoded) ? normalizeAddress(decoded[0]) : null;
    swapRoutes.push({ from, to, swapInfo: info, router, routerCode: router ? await readCode(endpoint, router, pin, context) : { value: null, reason: "ROUTER_UNRESOLVED" } }); }
  const explicitRouteAbsent = swapper === ZERO || oracleAddress === ZERO || swapRoutes.some((row) => row.router === ZERO || row.routerCode.value?.present === false);
  const routeUncertain = swapperIdentity?.resolved !== true || valueOf(swapperOracle) === null || valueOf(swapperSlippage) === null ||
    oracleCode.value?.present !== true || swapRoutes.some((row) => row.swapInfo.value === null || row.router === null || row.routerCode.value?.present !== true);
  const routeEvidence = explicitRouteAbsent ? false : routeUncertain ? null : true;
  const reachability = { aura, holdWant, externalStaker: holdWant === true ? null : stakingTarget,
    gaugeIdentity: useAura === false && holdWant === false ? { address: gauge, sourceBacked: true, stakingIdentity: null } :
    useAura === true && Array.isArray(auraInfo) ? { address: normalizeAddress(auraInfo[2]), sourceBacked: true } : null,
    stakingToken, stakingTokenMatchesWant: valueOf(stakingToken) === null ? null : normalizeAddress(valueOf(stakingToken)) === want,
    stakedBalance: stakingTarget ? await probeCall(endpoint, stakingTarget, scalarAbi, "balanceOf(address)", [STRATEGY], pin, context) :
      { value: null, reason: holdWant === true ? "HOLD_WANT_NO_EXTERNAL_STAKER" : "STAKER_UNAVAILABLE" },
    earned: useAura === true && stakingTarget ? await probeCall(endpoint, stakingTarget, scalarAbi, "earned", [STRATEGY], pin, context) :
      { value: null, reason: holdWant === true ? "HOLD_WANT_NO_EXTERNAL_STAKER" : useAura === false ? "GAUGE_EARNED_NOT_SOURCE_BACKED" : "STAKER_UNAVAILABLE" },
    swapper: swapperIdentity, swapperOracle, swapperSlippage, oracleCode, swapRoutes,
    routeSemanticsResolved: routeEvidence, swapRouteEvidence: routeEvidence };
  const bindings = { strategyAddressExact: STRATEGY, vaultAddressExact: BEEFY_VAULT,
    bidirectional: vaultAddress === BEEFY_VAULT && normalizeAddress(valueOf(vault.strategy)) === STRATEGY &&
      normalizeAddress(valueOf(vault.want)) === want, want, tokenOrder,
    auraInference: useAura,
    holdWantInference: holdWant };
  const state = { strategyIdentity, strategy, vaultIdentity, vault, factory: { address: factoryAddress, ...factory }, feeConfig,
    tokens, allowances, balancer: { address: balancerVault, identity: balancerIdentity, components, explorer, pool: wantPool, poolTokens, aggregateFees },
    reachability, bindings };
  const vaultPauseValue = valueOf(explorer.vaultPausedState);
  const poolConfigValue = valueOf(explorer.poolConfig);
  const hookRuntime = hookAddress === null ? null : hookAddress === ZERO ? true : explorer.hookCode.value?.present === true ? true :
    explorer.hookCode.value?.present === false ? false : null;
  let rateProvidersAndTokenTypes = null;
  if (Array.isArray(tokenInfoValue?.[1]) && tokenInfoValue[1].length === explorer.rateProviderCodes.length) {
    const rateChecks = tokenInfoValue[1].map((info, index) => { if (!Array.isArray(info) || ![0,1,"0","1"].includes(info[0])) return false;
      const type = Number(info[0]), provider = normalizeAddress(info[1]), code = explorer.rateProviderCodes[index]?.code;
      if (type === 0) return provider === ZERO; return provider !== null && provider !== ZERO && code?.value?.present === true; });
    rateProvidersAndTokenTypes = triAnd(rateChecks);
  }
  const feeControllerAddress = normalizeAddress(valueOf(explorer.protocolFeeController));
  const feeControllerRuntime = feeControllerAddress === null ? null : feeControllerAddress === ZERO ? true :
    components.protocolFeeController?.resolved === true ? true : components.protocolFeeController?.resolved === false ? false : null;
  const poolTypeParametersVersion = valueOf(wantPool.version) === null || wantPool.poolType === null ? null :
    wantPool.poolType === "WEIGHTED" ? (Array.isArray(weighted) && weighted.length === (Array.isArray(vaultTokens) ? vaultTokens.length : -1)) :
      (Array.isArray(stableAmp) && stableAmp.length === 3);
  state.criticalGates = {
    strategyRuntimeResolved: strategyIdentity.resolved,
    vaultRuntimeResolved: vaultIdentity.resolved,
    balancerRuntimeResolved: balancerIdentity?.resolved ?? null,
    registered: triEqual(valueOf(explorer.registered), true), initialized: triEqual(valueOf(explorer.initialized), true),
    vaultUnpaused: Array.isArray(vaultPauseValue) ? vaultPauseValue[0] === false : null,
    poolUnpaused: triEqual(valueOf(explorer.poolPaused), false), recoveryDisabled: triEqual(valueOf(explorer.recoveryMode), false),
    unbalancedEnabled: explorer.unbalancedLiquidityEnabled === null ? null : explorer.unbalancedLiquidityEnabled === true,
    configIdentity: Array.isArray(poolConfigValue) ? triAnd([poolConfigValue[6] === true, poolConfigValue[7] === true,
      poolConfigValue[8] === false, poolConfigValue[9] === false]) : null,
    tokenOrderAndIndex: tokenOrder === null ? null : tokenOrder.sameOrder && tokenOrder.exactIndex,
    arraysConsistent: explorer.arrayConsistency,
    hookRuntime, rateProvidersAndTokenTypes, feeControllerRuntime, poolTypeParametersVersion,
    poolFactoryRelationship: wantPool.poolFactoryUnresolved === true ? null : valueOf(wantPool.factoryRelationship),
    swapperRoutesOracleSlippage: reachability.routeSemanticsResolved
  };
  state.criticalGates.all = triAnd(Object.values(state.criticalGates));
  state.rawCriticalComplete = state.criticalGates.all !== null && [valueOf(strategy.vault), valueOf(strategy.want),
    valueOf(vault.strategy), valueOf(vault.want)].every((value) => value !== null);
  state.materiality = { zeroSupply: valueOf(vault.totalSupply) === null ? null : valueOf(vault.totalSupply) === "0",
    definedThreshold: null, negligible: null };
  state.stopReasons = deriveStopReasons(state); return state;
}
async function terminalRecheck(rows, pin, context) { for (const row of rows) { const block = await rpc(row.endpoint, "eth_getBlockByNumber", [`0x${BigInt(pin.number).toString(16)}`, false], context);
  if (!block.ok || !samePin(parseHeader(block.result), pin)) return false; } return true; }
function outputPath(runId) { return path.join(ROOT, OUTPUT_DIR_REL, `${STEM}-${runId}.json`); }
function atomicExclusiveWrite(file, value) { const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); if (bytes.length > CAPS.outputBytes) throw new Error("OUTPUT_CAP");
  fs.writeFileSync(file, bytes, { flag: "wx" }); return sha256(bytes); }
function validateRunId(runId, now = Date.now()) { const match = /^beefybalv3monad-r3-(\d{8}T\d{6}Z)-[0-9a-f]{32}$/u.exec(runId || "");
  if (!match) throw new Error("RUN_ID_INVALID"); const stamp = match[1], parsed = Date.parse(`${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}T${stamp.slice(9,11)}:${stamp.slice(11,13)}:${stamp.slice(13,15)}Z`);
  const roundTrip = Number.isFinite(parsed) ? new Date(parsed).toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z") : null;
  if (roundTrip !== stamp || Math.abs(now - parsed) > 300000) throw new Error("RUN_ID_NOT_FRESH_UTC"); return runId; }
function parseArgs(argv, now = Date.now()) { if (argv.length === 3 && argv[2] === "--check-only") return { checkOnly: true };
  if (argv.length !== 5 || argv[2] !== CAPTURE_FLAG || argv[3] !== "--run-id") throw new Error("ARGS");
  return { checkOnly: false, runId: validateRunId(argv[4], now) }; }
function markerPayload(runId, now) { return Buffer.from(`${JSON.stringify({ schemaVersion: 3, findingId: FINDING_ID,
  packageAggregate: EXPECTED_PACKAGE_AGGREGATE, consumed: true, runId,
  consumedAtUtc: new Date(now).toISOString(), durability: "EXCLUSIVE_CREATE_FILE_FLUSH_CLOSE_REOPEN_EXACT_READBACK" })}\n`); }
function createConsumptionMarker(runId, options = {}) { const fsImpl = options.fsImpl || fs, marker = options.markerPath || workspacePath(CONSUMPTION_MARKER_REL),
  now = options.now === undefined ? Date.now() : options.now, bytes = markerPayload(runId, now);
  let fd; try { fd = fsImpl.openSync(marker, "wx"); fsImpl.writeSync(fd, bytes, 0, bytes.length, 0); fsImpl.fsyncSync(fd); }
  catch (error) { if (error.code === "EEXIST") throw new Error("PACKAGE_ALREADY_CONSUMED"); throw error; }
  finally { if (fd !== undefined) fsImpl.closeSync(fd); }
  let readFd; try { readFd = fsImpl.openSync(marker, "r"); const observed = Buffer.alloc(bytes.length + 1), count = fsImpl.readSync(readFd, observed, 0, observed.length, 0);
    if (count !== bytes.length || !observed.subarray(0, count).equals(bytes)) throw new Error("MARKER_READBACK_MISMATCH");
    const decoded = JSON.parse(observed.subarray(0, count).toString("utf8"));
    if (decoded.packageAggregate !== EXPECTED_PACKAGE_AGGREGATE || decoded.runId !== runId || decoded.consumed !== true) throw new Error("MARKER_READBACK_INVALID"); }
  finally { if (readFd !== undefined) fsImpl.closeSync(readFd); }
  return marker;
}
function terminalIncomplete(runId, reason, budget) { return { schemaVersion: 3, findingId: FINDING_ID, runId,
  status: "INCOMPLETE_NONPROMOTABLE", reason, chainId: "143", metadataId: METADATA_ID,
  conclusions: { currentConfigSnapshot: null, economics: null, routePositive: null, executableNow: null,
    deploymentApplicability: null, promotable: false, fork: false, signedActionJustified: false },
  retryAllowed: false, terminal: true, budget: budget.summary(), providerMaterialPersisted: false }; }
async function runCapture(args, dependencies = {}) {
  const context = { budget: new Budget(dependencies.now || Date.now), nextId: 0, rpc: dependencies.rpc };
  let inventory = null, secrets = [], result;
  try { validateRunId(args.runId, (dependencies.now || Date.now)());
    (dependencies.verifyPackage || verifyPackageBeforeConsumption)();
    (dependencies.consume || createConsumptionMarker)(args.runId, { markerPath: dependencies.markerPath,
      fsImpl: dependencies.fsImpl, now: (dependencies.now || Date.now)() });
    inventory = dependencies.inventoryText !== undefined ? parseInventoryText(dependencies.inventoryText) :
      parseInventoryText((dependencies.readInventory || fs.readFileSync)(path.join(ROOT, INVENTORY_REL), { encoding: "utf8", flag: "r" })); secrets = secretCorpus(inventory);
    const qualification = await (dependencies.qualify || qualifyDescriptors)(inventory, context);
    if (!qualification.consensus || qualification.selected.length !== 2) result = terminalIncomplete(args.runId, "TWO_HOSTNAME_FAMILY_FINALIZED_CONSENSUS_UNAVAILABLE", context.budget);
    else { const captures = []; for (const row of qualification.selected) captures.push(await (dependencies.capture || captureFamily)(row.endpoint, qualification.pin, context));
      const familyAgreement = JSON.stringify(captures[0]) === JSON.stringify(captures[1]);
      const criticalComplete = captures.every((capture) => capture.rawCriticalComplete === true && capture.criticalGates.all !== null);
      const terminalPin = await (dependencies.terminal || terminalRecheck)(qualification.selected, qualification.pin, context);
      if (!familyAgreement || !criticalComplete || !terminalPin) result = terminalIncomplete(args.runId,
        !familyAgreement ? "FAMILY_STATE_MISMATCH" : !criticalComplete ? "CRITICAL_STATE_NULL_OR_INCOMPLETE" : "TERMINAL_PIN_MISMATCH", context.budget);
      else result = { schemaVersion: 3, findingId: FINDING_ID, runId: args.runId, status: "CURRENT_CONFIG_SNAPSHOT_NONPROMOTABLE",
        chainId: "143", metadataId: METADATA_ID, pin: qualification.pin,
        qualification: { selectedFamilyCount: 2, sameFinalizedNumberHashTimestamp: true, terminalExactPinRecheck: true,
          hostnameDistinctOnly: true, backendOperatorIndependence: false },
        sourceAuthority: { beefyCommit: "4621d2dd07fad1e63f060451f32af5e1a43c88a9",
          beefyTree: "15bd1224ff3df7358b97b8c2a9689df3f7586331", balancerCommit: "7861ea2785b96dd10681ff1b8dfe56b36cc202b6",
          deployedEquivalenceClaimed: false }, state: captures[0],
        conclusions: { currentConfigSnapshot: true, economics: null, routePositive: null, executableNow: null,
          deploymentApplicability: null, promotable: false, fork: false, signedActionJustified: false },
        retryAllowed: false, terminal: true, budget: context.budget.summary(), providerMaterialPersisted: false }; }
  } catch (error) { result = terminalIncomplete(args.runId, /^[A-Z0-9_]{3,128}$/u.test(error.message) ? error.message : "CAPTURE_FAILED", context.budget); }
  assertNoSecrets(result, secrets); (dependencies.writeOutput || atomicExclusiveWrite)(dependencies.outputPath || outputPath(args.runId), result); return result;
}
function workspacePath(relative) { return path.join(ROOT, ...relative.split("/")); }
function normalizedBytes(relative, bytes) { if (relative !== `tools/${STEM}-runner.js`) return bytes;
  return Buffer.from(bytes.toString("utf8").replace(/const EXPECTED_PACKAGE_AGGREGATE = "[0-9a-f]{64}";/u,
    `const EXPECTED_PACKAGE_AGGREGATE = "${"0".repeat(64)}";`)); }
function fileRecords(paths, options = {}) { const readFile = options.readFile || fs.readFileSync; return paths.map((item) => { const bytes = readFile(workspacePath(item)), normalized = normalizedBytes(item, bytes);
  return { path: item, bytes: bytes.length, sha256: sha256(normalized), normalization: normalized === bytes ? null : "EXPECTED_PACKAGE_AGGREGATE_ZEROED" }; }); }
function loadedDependencyGraph() { const prefix = `${path.resolve(__dirname, "node_modules")}${path.sep}`; return Object.keys(require.cache)
  .filter((item) => item === __filename || item.startsWith(prefix))
  .map((item) => { const relative = path.relative(ROOT, item).replace(/\\/gu, "/"), bytes = fs.readFileSync(item), normalized = normalizedBytes(relative, bytes);
    return { path: relative, bytes: bytes.length, sha256: sha256(normalized), normalization: normalized === bytes ? null : "EXPECTED_PACKAGE_AGGREGATE_ZEROED" }; })
  .sort((a, b) => a.path.localeCompare(b.path)); }
function verifyRecords(records, expected, options = {}) { const readFile = options.readFile || fs.readFileSync; if (!Array.isArray(records) || records.length !== expected.length) return false;
  const map = new Map(records.map((row) => [row.path, row])); for (const item of expected) { const row = map.get(item); if (!row) return false;
    const bytes = readFile(workspacePath(item)), normalized = normalizedBytes(item, bytes), expectedNormalization = normalized === bytes ? null : "EXPECTED_PACKAGE_AGGREGATE_ZEROED";
    if (row.bytes !== bytes.length || row.sha256 !== sha256(normalized) || row.normalization !== expectedNormalization) return false; } return true; }
function packageAggregate(value) { const rows = [...(value.artifacts || []).map((x) => `artifacts:${x.path}:${x.sha256}`),
  ...(value.runtimeDependencyGraph || []).map((x) => `runtime:${x.path}:${x.sha256}`),
  ...(value.localInputs || []).map((x) => `localInputs:${x.path}:${x.sha256}`)]; return sha256(Buffer.from(rows.sort().join("\n"))); }
function verifyPackageBeforeConsumption(options = {}) { const readFile = options.readFile || fs.readFileSync;
  const manifest = options.manifest || JSON.parse(readFile(workspacePath(MANIFEST_REL), "utf8"));
  if (!/^[0-9a-f]{64}$/u.test(EXPECTED_PACKAGE_AGGREGATE) || EXPECTED_PACKAGE_AGGREGATE === "0".repeat(64) ||
    manifest.aggregateSha256 !== EXPECTED_PACKAGE_AGGREGATE || packageAggregate(manifest) !== EXPECTED_PACKAGE_AGGREGATE) throw new Error("PACKAGE_AGGREGATE_MISMATCH");
  if (!verifyRecords(manifest.artifacts, REQUIRED_ARTIFACT_PATHS, { readFile }) ||
    !verifyRecords(manifest.localInputs, LOCAL_INPUT_RELS, { readFile })) throw new Error("PACKAGE_FILE_MISMATCH");
  const observedGraph = loadedDependencyGraph(); if (JSON.stringify(manifest.runtimeDependencyGraph.map((row) => row.path)) !== JSON.stringify(observedGraph.map((row) => row.path)) ||
    !verifyRecords(manifest.runtimeDependencyGraph, observedGraph.map((row) => row.path), { readFile })) throw new Error("PACKAGE_RUNTIME_GRAPH_MISMATCH");
  return true;
}
function dryPreflight() { return { schemaVersion: 3, findingId: FINDING_ID, status: "R3_OFFLINE_PACKAGE_PREPARED_CAPTURE_NOT_EXECUTED",
  target: { chainId: "143", strategy: STRATEGY, beefyVault: BEEFY_VAULT, metadataId: METADATA_ID },
  sourceAuthority: { beefyCommit: "4621d2dd07fad1e63f060451f32af5e1a43c88a9",
    beefyTree: "15bd1224ff3df7358b97b8c2a9689df3f7586331", balancerCommit: "7861ea2785b96dd10681ff1b8dfe56b36cc202b6",
    deployedEquivalenceClaimed: false }, invocation: { flag: CAPTURE_FLAG,
    command: `node tools/${STEM}-runner.js ${CAPTURE_FLAG} --run-id beefybalv3monad-r3-YYYYMMDDTHHMMSSZ-<32-lowerhex>` },
  oneShot: { packageWideMarker: CONSUMPTION_MARKER_REL, atomicExclusive: true,
    windowsSafeDurability: "EXCLUSIVE_CREATE_FILE_FLUSH_CLOSE_REOPEN_EXACT_READBACK",
    universalPowerLossDurabilityClaimed: false, neverRemovedOnFailure: true, subsequentRunIdsRejected: true, freshUtcRunIdRequired: true },
  endpointPolicy: { inventory: INVENTORY_REL, captureOnlyReadExactlyOnce: true, processOnly: true, directMonadHttpsOnly: true,
    minimumHostnameFamilies: 2, providerMaterialPersisted: false }, pin: { finalizedConsensus: "number/hash/timestamp",
    eip1898: { blockHash: true, requireCanonical: true }, terminalExactRecheck: true }, methods: { allowed: ALLOWED_METHODS, graphql: false, logs: false, publicGets: false },
  caps: CAPS, conclusions: { economics: null, routePositive: null, executableNow: null, deploymentApplicability: null,
    promotable: false, fork: false, signedActionJustified: false }, retryAllowed: false,
  networkReads: 0, inventoryReads: 0, captureExecuted: false } }
async function main() { const args = parseArgs(process.argv); if (args.checkOnly) return process.stdout.write(`${JSON.stringify(dryPreflight(), null, 2)}\n`);
  const result = await runCapture(args); process.stdout.write(`${JSON.stringify({ status: result.status, runId: result.runId, terminal: true, retryAllowed: false })}\n`); }
if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });

module.exports = { ADMIN_SLOT, ALLOWED_METHODS, BEEFY_VAULT, BEACON_SLOT, Budget, CAPS, CAPTURE_FLAG, CHAIN_ID,
  CONSUMPTION_MARKER_REL, EXPECTED_PACKAGE_AGGREGATE, FINDING_ID, FIXTURE_REL, IMPLEMENTATION_SLOT, INVENTORY_REL, LOCAL_INPUT_RELS, MANIFEST_REL, METADATA_ID,
  OUTPUT_DIR_REL, PREFLIGHT_REL, REPORT_REL, REQUIRED_ARTIFACT_PATHS, ROOT, STEM, STRATEGY, ZERO, assertNoSecrets,
  atomicExclusiveWrite, captureFamily, classifyProxySlots, codeRecord, createConsumptionMarker, deriveStopReasons, dryPreflight, eip1898,
  fileRecords, jsonValue, loadedDependencyGraph, normalizeAddress, packageAggregate, parseArgs, parseHeader,
  parseInventoryText, probeCall, qualificationAnchors, qualifyDescriptors, resolveProxy, rewardsBound, runCapture, samePin, secretCorpus, sha256,
  scalarAbi, explorerAbi, slotAddress, terminalRecheck, tokenOrderCheck, triAnd, triEqual, validateRunId, valueOf, verifyPackageBeforeConsumption, verifyRecords };
