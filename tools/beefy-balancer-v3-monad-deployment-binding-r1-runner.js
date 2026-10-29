#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { Interface, getAddress, id } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const STEM = "beefy-balancer-v3-monad-deployment-binding-r1";
const FINDING_ID = "beefy-balancer-v3-monad-deployment-binding-r1";
const CHAIN_ID = 143n;
const STRATEGY = "0x9db4aa152d06206566187b26472583b3e59bd5c5";
const BEEFY_VAULT = "0xd0331a023c35514c2ef99eb34ed868737e9dcea3";
const METADATA_ID = "balancerv3-monad-usdt0-ausd-usdc";
const CAPTURE_FLAG = "--capture-beefy-balancer-v3-monad-binding-r1-once";
const INVENTORY_REL = "rpc_endpoints.txt";
const PREFLIGHT_REL = `reports/raw/fast/${STEM}-preflight.json`;
const MANIFEST_REL = `reports/raw/fast/${STEM}-manifest.json`;
const REPORT_REL = `reports/${STEM}.md`;
const FIXTURE_REL = `tools/fixtures/${STEM}-fixtures.json`;
const OUTPUT_DIR_REL = "reports/raw/fast";
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
  "function getAllFees() view returns ((uint256 total,uint256 beefy,uint256 call,uint256 strategist,string label,bool active) performance,uint256 deposit,uint256 withdraw)",
  "function beacon() view returns (address)", "function implementation() view returns (address)",
  "function strategy() view returns (address)", "function totalSupply() view returns (uint256)",
  "function balance() view returns (uint256)", "function available() view returns (uint256)",
  "function getPricePerFullShare() view returns (uint256)", "function approvalDelay() view returns (uint256)",
  "function stratCandidate() view returns (address implementation,uint256 proposedTime)",
  "function decimals() view returns (uint8)", "function name() view returns (string)", "function symbol() view returns (string)",
  "function keeper() view returns (address)", "function globalPause() view returns (bool)",
  "function strategyPause(string) view returns (bool)", "function beefyFeeConfig() view returns (address)",
  "function beefyFeeRecipient() view returns (address)",
  "function getFees(address) view returns (uint256 total,uint256 beefy,uint256 call,uint256 strategist,string label,bool active)",
  "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)",
  "function getTokens() view returns (address[])", "function staking_token() view returns (address)",
  "function earned(address) view returns (uint256)", "function getReward(address) view returns (uint256)",
  "function version() view returns (string)", "function getPoolVersion() view returns (string)",
  "function getFactory() view returns (address)", "function getNormalizedWeights() view returns (uint256[])",
  "function getAmplificationParameter() view returns (uint256,bool,uint256)"
]);
const explorerAbi = new Interface([
  "function getVault() view returns (address)", "function getVaultExtension() view returns (address)",
  "function getVaultAdmin() view returns (address)", "function isPoolRegistered(address) view returns (bool)",
  "function isPoolInitialized(address) view returns (bool)", "function getPoolTokens(address) view returns (address[])",
  "function getPoolTokenCountAndIndexOfToken(address,address) view returns (uint256,uint256)",
  "function getPoolTokenRates(address) view returns (uint256[],uint256[])",
  "function getPoolData(address) view returns (bytes32,address[],(uint8,address,bool)[],uint256[],uint256[],uint256[],uint256[])",
  "function getPoolTokenInfo(address) view returns (address[],(uint8,address,bool)[],uint256[],uint256[])",
  "function getCurrentLiveBalances(address) view returns (uint256[])",
  "function getPoolConfig(address) view returns ((bool,bool,bool,bool),uint256,uint256,uint256,uint40,uint32,bool,bool,bool,bool)",
  "function getHooksConfig(address) view returns (bool,bool,bool,bool,bool,bool,bool,bool,bool,bool,address)",
  "function getStaticSwapFeePercentage(address) view returns (uint256)",
  "function getAggregateSwapFeeAmount(address,address) view returns (uint256)",
  "function getAggregateYieldFeeAmount(address,address) view returns (uint256)",
  "function isPoolPaused(address) view returns (bool)", "function isPoolInRecoveryMode(address) view returns (bool)",
  "function getMinimumTradeAmount() view returns (uint256)", "function totalSupply(address) view returns (uint256)",
  "function version() view returns (string)"
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
  const byFamily = new Map(); for (const row of qualified) if (!byFamily.has(row.endpoint.family)) byFamily.set(row.endpoint.family, row);
  const families = [...byFamily.values()]; const first = families[0].pin; const agreeing = families.filter((row) => samePin(row.pin, first));
  return { selected: agreeing.slice(0, 2), pin: first, familyCount: families.length,
    consensus: agreeing.length >= 2 && samePin(agreeing[0].pin, agreeing[1].pin) };
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
  return row.ok ? { value: slotAddress(row.result), reason: null } : { value: null, reason: row.reason }; }
async function resolveProxy(endpoint, address, pin, context) {
  const runtime = await readCode(endpoint, address, pin, context), impl = await readSlot(endpoint, address, IMPLEMENTATION_SLOT, pin, context),
    beacon = await readSlot(endpoint, address, BEACON_SLOT, pin, context), admin = await readSlot(endpoint, address, ADMIN_SLOT, pin, context);
  const slots = classifyProxySlots(impl.value, beacon.value); let beaconGetter = { value: null, reason: "NOT_BEACON_PROXY" },
    beaconImplementation = { value: null, reason: "NOT_BEACON_PROXY" }, resolvedImplementation = slots.implementationSlot;
  if (slots.beaconSlot) { beaconGetter = await probeCall(endpoint, address, scalarAbi, "beacon", [], pin, context);
    beaconImplementation = await probeCall(endpoint, slots.beaconSlot, scalarAbi, "implementation", [], pin, context);
    if (normalizeAddress(beaconGetter.value) === slots.beaconSlot) resolvedImplementation = normalizeAddress(beaconImplementation.value); }
  const implementationRuntime = resolvedImplementation ? await readCode(endpoint, resolvedImplementation, pin, context) : { value: null, reason: "IMPLEMENTATION_UNRESOLVED" };
  const resolved = !slots.ambiguity && runtime.value?.present === true && (slots.kind === "DIRECT_OR_UNKNOWN" ||
    (resolvedImplementation && implementationRuntime.value?.present === true));
  return { address, runtime, slots: { ...slots, adminSlot: admin.value }, beaconGetter, beaconImplementation,
    resolvedImplementation, implementationRuntime, resolved, sourceRuntimeAttested: null };
}
function valueOf(row) { return row && row.reason === null ? row.value : null; }
async function probeMap(endpoint, address, iface, specs, pin, context) { const out = {};
  for (const [key, fragment, args = []] of specs) out[key] = await probeCall(endpoint, address, iface, fragment, args, pin, context); return out; }
async function tokenSnapshot(endpoint, token, owner, pin, context) {
  if (!token) return { address: null, code: { value: null, reason: "TOKEN_UNAVAILABLE" }, decimals: { value: null, reason: "TOKEN_UNAVAILABLE" }, balance: { value: null, reason: "TOKEN_UNAVAILABLE" } };
  return { address: token, code: await readCode(endpoint, token, pin, context),
    decimals: await probeCall(endpoint, token, scalarAbi, "decimals", [], pin, context),
    balance: await probeCall(endpoint, token, scalarAbi, "balanceOf", [owner], pin, context) };
}
function rewardsBound(length) { const count = Number(length); return Number.isSafeInteger(count) && count >= 0 && count <= CAPS.rewards ? count : null; }
function tokenOrderCheck(wantTokens, vaultTokens, depositToken, indexRow) {
  if (!Array.isArray(wantTokens) || !Array.isArray(vaultTokens) || wantTokens.length !== vaultTokens.length) return null;
  const same = wantTokens.every((token, index) => token === vaultTokens[index]); const index = vaultTokens.indexOf(depositToken);
  const exactIndex = Array.isArray(indexRow) && String(indexRow[0]) === String(vaultTokens.length) && String(indexRow[1]) === String(index);
  return { sameOrder: same, depositTokenIndex: index, exactIndex: same && index >= 0 && exactIndex };
}
function deriveStopReasons(state) {
  const mismatch = state.bindings?.bidirectional === false || state.bindings?.tokenOrder?.sameOrder === false || state.bindings?.tokenOrder?.exactIndex === false;
  const identities = [state.strategyIdentity?.resolved, state.vaultIdentity?.resolved, state.balancer?.identity?.resolved];
  const runtimeUnresolved = identities.some((value) => value === false) ? true : identities.some((value) => value === undefined) ? null : false;
  const poolConfig = valueOf(state.balancer?.explorer?.poolConfig), pauseValues = [valueOf(state.strategy?.paused),
    valueOf(state.factory?.globalPause), valueOf(state.factory?.strategyPause), valueOf(state.balancer?.explorer?.poolPaused)];
  const paused = pauseValues.some((value) => value === true) ? true : pauseValues.every((value) => value === false) ? false : null;
  const allowance = state.allowances?.wantToStaker ? valueOf(state.allowances.wantToStaker) : null;
  const negligible = valueOf(state.vault?.totalSupply) === "0" ? true : valueOf(state.vault?.totalSupply) === null ? null : false;
  return {
    retiredMismatchOrNegligible: mismatch === true || negligible === true ? true : mismatch === false && negligible === false ? false : null,
    runtimeUnresolved,
    unbalancedDisabled: Array.isArray(poolConfig) && Array.isArray(poolConfig[0]) ? Boolean(poolConfig[0][0]) : null,
    tokenOrIndexMismatch: mismatch === true ? true : mismatch === false ? false : null,
    paused,
    swapRoutesAbsent: null,
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
    ["balanceOf","balanceOf"],["balanceOfWant","balanceOfWant"],["balanceOfPool","balanceOfPool"],
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
  const staker = Number(valueOf(strategy.pid)) === 1234567 ? gauge : booster;
  const allowances = { wantToStaker: want && staker ? await probeCall(endpoint, want, scalarAbi, "allowance", [STRATEGY, staker], pin, context) : { value: null, reason: "STAKER_UNPROVEN" },
    nativeToSwapper: native && swapper ? await probeCall(endpoint, native, scalarAbi, "allowance", [STRATEGY, swapper], pin, context) : { value: null, reason: "SWAPPER_UNAVAILABLE" } };
  const balancerVault = normalizeAddress(valueOf(await probeCall(endpoint, STRATEGY, scalarAbi, "vault", [], pin, context))) === BEEFY_VAULT ?
    normalizeAddress(valueOf(await probeCall(endpoint, STRATEGY, new Interface(["function balancerVault() view returns(address)"]), "balancerVault", [], pin, context))) : null;
  const balancerIdentity = balancerVault ? await resolveProxy(endpoint, balancerVault, pin, context) : null;
  const explorer = balancerVault ? await probeMap(endpoint, balancerVault, explorerAbi, [["vault","getVault"],["extension","getVaultExtension"],
    ["admin","getVaultAdmin"],["version","version"],["registered","isPoolRegistered",[want]],["initialized","isPoolInitialized",[want]],
    ["poolTokens","getPoolTokens",[want]],["tokenCountIndex","getPoolTokenCountAndIndexOfToken",[want,depositToken]],
    ["tokenRates","getPoolTokenRates",[want]],["poolData","getPoolData",[want]],["tokenInfo","getPoolTokenInfo",[want]],
    ["liveBalances","getCurrentLiveBalances",[want]],["poolConfig","getPoolConfig",[want]],
    ["hooksConfig","getHooksConfig",[want]],["staticSwapFee","getStaticSwapFeePercentage",[want]],
    ["poolPaused","isPoolPaused",[want]],["recoveryMode","isPoolInRecoveryMode",[want]],
    ["minimumTradeAmount","getMinimumTradeAmount"],["bptSupply","totalSupply",[want]]], pin, context) : {};
  const components = {}; for (const key of ["extension","admin"]) { const address = normalizeAddress(valueOf(explorer[key])); components[key] = address ? await resolveProxy(endpoint, address, pin, context) : null; }
  const observedPoolConfig = valueOf(explorer.poolConfig);
  explorer.unbalancedLiquidityEnabled = Array.isArray(observedPoolConfig) && Array.isArray(observedPoolConfig[0]) ?
    !Boolean(observedPoolConfig[0][0]) : null;
  const wantPool = want ? await probeMap(endpoint, want, scalarAbi, [["tokens","getTokens"],["version","getPoolVersion"],
    ["factory","getFactory"],["weightedWeights","getNormalizedWeights"],["stableAmp","getAmplificationParameter"]], pin, context) : {};
  wantPool.code = want ? await readCode(endpoint, want, pin, context) : { value: null, reason: "WANT_UNAVAILABLE" };
  wantPool.poolType = valueOf(wantPool.weightedWeights) ? "WEIGHTED" : valueOf(wantPool.stableAmp) ? "STABLE" : null;
  const wantTokens = valueOf(wantPool.tokens), vaultTokens = valueOf(explorer.poolTokens);
  const tokenOrder = tokenOrderCheck(wantTokens, vaultTokens, depositToken, valueOf(explorer.tokenCountIndex));
  const poolTokens = [], aggregateFees = []; if (Array.isArray(vaultTokens)) for (const token of vaultTokens) {
    const address = normalizeAddress(token); poolTokens.push(await tokenSnapshot(endpoint, address, balancerVault, pin, context));
    aggregateFees.push({ token: address,
      swap: await probeCall(endpoint, balancerVault, explorerAbi, "getAggregateSwapFeeAmount", [want, address], pin, context),
      yield: await probeCall(endpoint, balancerVault, explorerAbi, "getAggregateYieldFeeAmount", [want, address], pin, context) });
  }
  const stakingToken = staker ? await probeCall(endpoint, staker, scalarAbi, "staking_token", [], pin, context) : { value: null, reason: "STAKER_UNPROVEN" };
  const reachability = { stakingToken,
    stakingTokenMatchesWant: valueOf(stakingToken) === null ? null : normalizeAddress(valueOf(stakingToken)) === want,
    stakedBalance: staker ? await probeCall(endpoint, staker, scalarAbi, "balanceOf", [STRATEGY], pin, context) : { value: null, reason: "STAKER_UNPROVEN" },
    earned: rewardPool ? await probeCall(endpoint, rewardPool, scalarAbi, "earned", [STRATEGY], pin, context) : { value: null, reason: "REWARD_POOL_UNAVAILABLE" },
    swapper: swapper ? await resolveProxy(endpoint, swapper, pin, context) : null,
    swapRouteEvidence: { value: null, reason: "NO_SOURCE_BACKED_ROUTE_ORACLE_SLIPPAGE_GETTERS" } };
  const bindings = { strategyAddressExact: STRATEGY, vaultAddressExact: BEEFY_VAULT,
    bidirectional: vaultAddress === BEEFY_VAULT && normalizeAddress(valueOf(vault.strategy)) === STRATEGY &&
      normalizeAddress(valueOf(vault.want)) === want, want, tokenOrder,
    auraInference: Number(valueOf(strategy.pid)) === 1234567 ? false : valueOf(strategy.pid) === null ? null : true,
    holdWantInference: valueOf(strategy.pid) === "1234567" && gauge === ZERO ? true : valueOf(strategy.pid) === null ? null : false };
  const state = { strategyIdentity, strategy, vaultIdentity, vault, factory: { address: factoryAddress, ...factory }, feeConfig,
    tokens, allowances, balancer: { address: balancerVault, identity: balancerIdentity, components, explorer, pool: wantPool, poolTokens, aggregateFees },
    reachability, bindings };
  state.stopReasons = deriveStopReasons(state); return state;
}
async function terminalRecheck(rows, pin, context) { for (const row of rows) { const block = await rpc(row.endpoint, "eth_getBlockByNumber", [`0x${BigInt(pin.number).toString(16)}`, false], context);
  if (!block.ok || !samePin(parseHeader(block.result), pin)) return false; } return true; }
function outputPath(runId) { return path.join(ROOT, OUTPUT_DIR_REL, `${STEM}-${runId}.json`); }
function atomicExclusiveWrite(file, value) { const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); if (bytes.length > CAPS.outputBytes) throw new Error("OUTPUT_CAP");
  fs.writeFileSync(file, bytes, { flag: "wx" }); return sha256(bytes); }
function parseArgs(argv) { if (argv.length === 3 && argv[2] === "--check-only") return { checkOnly: true };
  if (argv.length !== 5 || argv[2] !== CAPTURE_FLAG || argv[3] !== "--run-id" || !/^beefybalv3monad-r1-\d{8}T\d{6}Z-[0-9a-f]{32}$/u.test(argv[4])) throw new Error("ARGS");
  return { checkOnly: false, runId: argv[4] }; }
function terminalIncomplete(runId, reason, budget) { return { schemaVersion: 1, findingId: FINDING_ID, runId,
  status: "INCOMPLETE_NONPROMOTABLE", reason, chainId: "143", metadataId: METADATA_ID,
  conclusions: { currentConfigSnapshot: null, economics: null, routePositive: null, executableNow: null,
    deploymentApplicability: null, promotable: false, fork: false, signedActionJustified: false },
  retryAllowed: false, terminal: true, budget: budget.summary(), providerMaterialPersisted: false }; }
async function runCapture(args, dependencies = {}) {
  const context = { budget: new Budget(dependencies.now || Date.now), nextId: 0, rpc: dependencies.rpc };
  let inventory = null, secrets = [], result;
  try { inventory = dependencies.inventoryText !== undefined ? parseInventoryText(dependencies.inventoryText) :
      parseInventoryText(fs.readFileSync(path.join(ROOT, INVENTORY_REL), { encoding: "utf8", flag: "r" })); secrets = secretCorpus(inventory);
    const qualification = await qualifyDescriptors(inventory, context);
    if (!qualification.consensus || qualification.selected.length !== 2) result = terminalIncomplete(args.runId, "TWO_HOSTNAME_FAMILY_FINALIZED_CONSENSUS_UNAVAILABLE", context.budget);
    else { const captures = []; for (const row of qualification.selected) captures.push(await captureFamily(row.endpoint, qualification.pin, context));
      const familyAgreement = JSON.stringify(captures[0]) === JSON.stringify(captures[1]);
      const terminalPin = await terminalRecheck(qualification.selected, qualification.pin, context);
      if (!familyAgreement || !terminalPin) result = terminalIncomplete(args.runId, familyAgreement ? "TERMINAL_PIN_MISMATCH" : "FAMILY_STATE_MISMATCH", context.budget);
      else result = { schemaVersion: 1, findingId: FINDING_ID, runId: args.runId, status: "CURRENT_CONFIG_SNAPSHOT_NONPROMOTABLE",
        chainId: "143", metadataId: METADATA_ID, pin: qualification.pin,
        qualification: { selectedFamilyCount: 2, sameFinalizedNumberHashTimestamp: true, terminalExactPinRecheck: true },
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
function fileRecords(paths) { return paths.map((item) => { const bytes = fs.readFileSync(workspacePath(item)); return { path: item, bytes: bytes.length, sha256: sha256(bytes) }; }); }
function loadedDependencyGraph() { const prefix = `${path.resolve(__dirname, "node_modules")}${path.sep}`; return Object.keys(require.cache)
  .filter((item) => item === __filename || item.startsWith(prefix))
  .map((item) => { const bytes = fs.readFileSync(item); return { path: path.relative(ROOT, item).replace(/\\/gu, "/"), bytes: bytes.length, sha256: sha256(bytes) }; })
  .sort((a, b) => a.path.localeCompare(b.path)); }
function verifyRecords(records, expected) { if (!Array.isArray(records) || records.length !== expected.length) return false;
  const map = new Map(records.map((row) => [row.path, row])); for (const item of expected) { const row = map.get(item); if (!row) return false;
    const bytes = fs.readFileSync(workspacePath(item)); if (row.bytes !== bytes.length || row.sha256 !== sha256(bytes)) return false; } return true; }
function packageAggregate(value) { const rows = [...(value.artifacts || []).map((x) => `artifacts:${x.path}:${x.sha256}`),
  ...(value.runtimeDependencyGraph || []).map((x) => `runtime:${x.path}:${x.sha256}`),
  ...(value.localInputs || []).map((x) => `localInputs:${x.path}:${x.sha256}`)]; return sha256(Buffer.from(rows.sort().join("\n"))); }
function dryPreflight() { return { schemaVersion: 1, findingId: FINDING_ID, status: "OFFLINE_PACKAGE_PREPARED_CAPTURE_NOT_EXECUTED",
  target: { chainId: "143", strategy: STRATEGY, beefyVault: BEEFY_VAULT, metadataId: METADATA_ID },
  sourceAuthority: { beefyCommit: "4621d2dd07fad1e63f060451f32af5e1a43c88a9",
    beefyTree: "15bd1224ff3df7358b97b8c2a9689df3f7586331", balancerCommit: "7861ea2785b96dd10681ff1b8dfe56b36cc202b6",
    deployedEquivalenceClaimed: false }, invocation: { flag: CAPTURE_FLAG,
    command: `node tools/${STEM}-runner.js ${CAPTURE_FLAG} --run-id beefybalv3monad-r1-YYYYMMDDTHHMMSSZ-<32-lowerhex>` },
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
  FINDING_ID, FIXTURE_REL, IMPLEMENTATION_SLOT, INVENTORY_REL, LOCAL_INPUT_RELS, MANIFEST_REL, METADATA_ID,
  OUTPUT_DIR_REL, PREFLIGHT_REL, REPORT_REL, REQUIRED_ARTIFACT_PATHS, ROOT, STEM, STRATEGY, ZERO, assertNoSecrets,
  atomicExclusiveWrite, captureFamily, classifyProxySlots, codeRecord, deriveStopReasons, dryPreflight, eip1898,
  fileRecords, jsonValue, loadedDependencyGraph, normalizeAddress, packageAggregate, parseArgs, parseHeader,
  parseInventoryText, probeCall, qualifyDescriptors, resolveProxy, rewardsBound, runCapture, samePin, secretCorpus, sha256,
  slotAddress, terminalRecheck, tokenOrderCheck, valueOf, verifyRecords };
