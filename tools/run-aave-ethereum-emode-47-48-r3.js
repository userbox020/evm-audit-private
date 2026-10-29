#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const { performance } = require("node:perf_hooks");
const { Interface, AbiCoder, id, keccak256, version: ethersVersion } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const SCHEMA = "aave-ethereum-emode-47-48-r3/v1";
const OUTPUT = "reports/raw/fast/aave-ethereum-emode-47-48-r3.json";
const ATTEMPT = "reports/raw/fast/aave-ethereum-emode-47-48-r3-attempt.json";
const R2 = "reports/raw/fast/aave-ethereum-emode-47-48-r2-explorer.json";
const BASELINE = "reports/raw/fast/aave-v37-same-reserve-accrual-deployment-gate0/capture.json";
const PF_FILE = "tools/lib/common-finalized-rpc-preflight.js";
const INVENTORY_HELPER = "tools/preflight-all-chain-endpoints-v4.js";
const V37 = "targets/aave-v3-origin-v3.7-cff15de/src/contracts/";
const AGENT_INTERFACES = "targets/aave-horizon-mglobal-pr14-4a854deb/src/interfaces/";
const PINS = Object.freeze({
  [PF_FILE]: "febeb98a013e652afda6196f9173823b02c2e5c88ebb7a1ac6bb6bd6e5b86673",
  [INVENTORY_HELPER]: "171590a0ab5bc204a9a0fa8a750ba8adbe74684bd68e756e99a7e29b29067558",
  [`${V37}interfaces/IPool.sol`]: "ee58bacafc0b033adeaf673da3b08130d9f3a9a3eb563f7f19a03240e488eba7",
  [`${V37}interfaces/IPoolConfigurator.sol`]: "e84bcade8ae8bd981db571c25cab4f20f313b6e4800c4e0d8e9fff216b518da8",
  [`${V37}interfaces/IPoolAddressesProvider.sol`]: "6a44f3a913093d62dd072d1691cf605a76262f56da42cbecdcf80607d8aeef94",
  [`${V37}interfaces/IAaveOracle.sol`]: "e55953dba6daa0883e7fb5776c6939cf6d28060e4d7733809a90bf454b31224b",
  [`${V37}interfaces/IACLManager.sol`]: "079fec6a41263f1794fe150ef72afe3a91206a0e747b08e089a68241054c556a",
  [`${V37}protocol/libraries/types/DataTypes.sol`]: "fe0d923f73941f9dd674bbad4533379e2451fd04518bcd7bb6b3c14e57c49db1",
  [`${AGENT_INTERFACES}IAgentConfigurator.sol`]: "b5fdc303dbeb0dbcda95b8295c31de984a5ec5b006508f00631fbbe6f3ca69c4",
  [`${AGENT_INTERFACES}IRangeValidationModule.sol`]: "5551417369078f9565889719e391bd279ae1ab36496a7f7ebb844c9cdde306bb",
  [R2]: "50fba494697196515a73ccd52b2bb82b23d407ad8dff08daa78a638d871a6773",
  [BASELINE]: "2efff97dcb7371e25959963357aaf8b951e997435b8f5156050e5da10b7ed012"
});
const LIMITS = Object.freeze({ candidates: 8, calls: 256, probeCalls: 70, reserveCalls: 16,
  responseBytes: 262144, totalBytes: 8388608, requestMs: 10000, wallMs: 180000,
  logs: 64, callBytes: 8192, outputBytes: 262144, maxPinAgeSeconds: 3600, freshnessSeconds: 900 });
const A = Object.freeze({
  pool: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
  historicalPoolImplementation: "0x728a138a4823392c2efa55e028d434f526fe03cf",
  configurator: "0x64b761d848206f447fe2dd461b0c635ec39ebb27",
  registryConfiguratorImplementation: "0xff42ce30054dce7dc7c1282a9a497aa58eabce99",
  provider: "0x2f39d218133afab8f2b819b1066c7e434ad94e9e",
  oracle: "0x54586be62e3c3580375ae3723c145253060ca0c2",
  acl: "0xc2aacf6553d20d1e9d78e365aaba8032af9c85b0",
  agent: "0xbe2840440d4f77cd98cec2de09913e6851907744",
  hub: "0x95e3015c67ef62b866cc28ca5a9ab5017a55e336",
  range: "0x9240a6669cc4782fc98620212862df5cb2e0df10",
  engine: "0xeafaefa93c6aabd5ab7e76f4c37aebe9da1e8318",
  riskOracle: "0x683d1a91599f971252ef171ef1f987172be8369a",
  router: "0x1d85000d54ea1185c43e4f2b32833524d3cf3507"
});
const FORWARDER = "0x0b93082d9b3c7c97facd250082899bacf3af3885";
const ZERO = `0x${"0".repeat(40)}`, ZERO32 = `0x${"0".repeat(64)}`;
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const TX_HASHES = Object.freeze([
  "0x7b52312890b527c1cd597b090fa85c23292f48187fa6e3fa72d18008f0f13745",
  "0x4def40d727c2e9ebe7c3282f303601217c3a2f717e5aeb666ec42b9150b807b3"
]);
const ASSETS = Object.freeze([
  [3, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
  [8, "0xdac17f958d2ee523a2206206994597c13d831ec7"],
  [30, "0x4c9edd5852cd905f086c759e8383e09bff1e68b3"],
  [32, "0x9d39a5de30e57443bff2a8307a4256c8797a3497"],
  [66, "0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34"]
].map(Object.freeze));
const EVENTS = new Interface([
  "event EModeCategoryAdded(uint8 indexed categoryId,uint256 ltv,uint256 liquidationThreshold,uint256 liquidationBonus,address oracle,string label)",
  "event EModeCategoryIsolationChanged(uint8 indexed categoryId,bool isolated)",
  "event UpdateInjected(uint256 indexed agentId,address indexed market,string indexed updateType,uint256 updateId,bytes newValue)"
]);
const CODER = AbiCoder.defaultAbiCoder();
const CODES = new Set(["SOURCE_PIN_MISMATCH", "INPUT_INVALID", "INVOCATION_INVALID", "INVENTORY_INVALID",
  "REQUEST_FORBIDDEN", "RPC_UNAVAILABLE", "RPC_ENVELOPE_INVALID", "BYTE_CAP", "WALL_CAP", "NETWORK_CALL_CAP",
  "TWO_FAMILIES_UNAVAILABLE", "PIN_CONSENSUS_UNAVAILABLE", "STATE_CONSENSUS_UNAVAILABLE", "PROBE_CAPABILITY_UNAVAILABLE",
  "INVALID_PREFLIGHT_INPUT", "RECEIPT_INVALID", "HEADER_INVALID", "PIN_STALE", "CALL_INVALID", "SCOPE_CHANGED",
  "TERMINAL_RECHECK_FAILED", "OUTPUT_INVALID", "ATTEMPT_CONSUMED", "UNEXPECTED"]);
class CheckError extends Error {
  constructor(code) { super(CODES.has(code) ? code : "UNEXPECTED"); this.code = this.message; }
}
function fail(code) { throw new CheckError(code); }
function safeCode(error) { return error instanceof CheckError ? error.code : "UNEXPECTED"; }
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const hex32 = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const address = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
const hex = (value, max) => typeof value === "string" && value.length <= 2 + max * 2 && /^0x(?:[0-9a-f]{2})*$/i.test(value);
const market = (category) => `0x${category.toString(16).padStart(40, "0")}`;
const quantity = (number) => `0x${number.toString(16)}`;
function number(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) fail("HEADER_INVALID");
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) fail("HEADER_INVALID");
  return Number(parsed);
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function pinnedRead(relative, expected, root = ROOT) {
  try {
    const file = path.join(root, relative), before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 1048576 || path.resolve(fs.realpathSync(file)) !== path.resolve(file)) fail("SOURCE_PIN_MISMATCH");
    const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || sha256(bytes) !== expected) fail("SOURCE_PIN_MISMATCH");
    return bytes;
  } catch (_) { fail("SOURCE_PIN_MISMATCH"); }
}
function readAuthority() {
  const contents = Object.fromEntries(Object.entries(PINS).map(([file, hash]) => [file, pinnedRead(file, hash).toString("utf8")]));
  const evidence = JSON.parse(contents[R2]), baseline = JSON.parse(contents[BASELINE]);
  if (stable(evidence.transactions.map((tx) => tx.transactionHash)) !== stable(TX_HASHES)) fail("INPUT_INVALID");
  for (const v of VIEWS) if (!contents[v.source].includes(`function ${v.fn}(`)) fail("SOURCE_PIN_MISMATCH");
  return { evidence, baseline, pins: { ...PINS }, ethersVersion };
}
function loadPreflight() {
  pinnedRead(PF_FILE, PINS[PF_FILE]);
  return require(`./lib/common-finalized-rpc-preflight.js`);
}

function buildViews() {
  const views = [];
  const add = (key, target, signature, args, kind, source, expected = null) => {
    const iface = new Interface([`function ${signature}`]), fragment = iface.fragments[0];
    if (fragment.stateMutability !== "view") fail("INPUT_INVALID");
    views.push(Object.freeze({ key, target, iface, fn: fragment.name, data: iface.encodeFunctionData(fragment, args), args, kind, source, expected }));
  };
  for (const category of [47, 48]) {
    const prefix = `category${category}`, source = `${V37}interfaces/IPool.sol`;
    add(`${prefix}.risk`, A.pool, "getEModeCategoryCollateralConfig(uint8) view returns ((uint16,uint16,uint16))", [category], "tuple", source);
    for (const suffix of ["CollateralBitmap", "BorrowableBitmap", "LtvzeroBitmap"])
      add(`${prefix}.${suffix}`, A.pool, `getEModeCategory${suffix}(uint8) view returns (uint128)`, [category], "scalar", source);
    add(`${prefix}.isolated`, A.pool, "getIsEModeCategoryIsolated(uint8) view returns (bool)", [category], "scalar", source);
    add(`${prefix}.label`, A.pool, "getEModeCategoryLabel(uint8) view returns (string)", [category], "knownString", source,
      category === 47 ? "PT-srUSDe Stablecoins" : "PT-srUSDe USDe");
  }
  for (const [reserveId, token] of ASSETS) {
    add(`reserve${reserveId}.asset`, A.pool, "getReserveAddressById(uint16) view returns (address)", [reserveId], "scalar", `${V37}interfaces/IPool.sol`, token);
    add(`reserve${reserveId}.oracleSource`, A.oracle, "getSourceOfAsset(address) view returns (address)", [token], "scalar", `${V37}interfaces/IAaveOracle.sol`);
  }
  for (const [name, expected] of Object.entries({ getPool: A.pool, getPoolConfigurator: A.configurator, getPriceOracle: A.oracle, getACLManager: A.acl }))
    add(`provider.${name}`, A.provider, `${name}() view returns (address)`, [], "scalar", `${V37}interfaces/IPoolAddressesProvider.sol`, expected);
  add("agent.isRiskAdmin", A.acl, "isRiskAdmin(address) view returns (bool)", [A.agent], "scalar", `${V37}interfaces/IACLManager.sol`);
  const hubSource = `${AGENT_INTERFACES}IAgentConfigurator.sol`;
  for (const [name, expected] of Object.entries({ getAgentAddress: A.agent, getAgentAdmin: null, getRiskOracle: A.riskOracle }))
    add(`hub.${name}`, A.hub, `${name}(uint256) view returns (address)`, [6], "scalar", hubSource, expected);
  for (const name of ["isAgentEnabled", "isAgentPermissioned", "isMarketsFromAgentEnabled"])
    add(`hub.${name}`, A.hub, `${name}(uint256) view returns (bool)`, [6], "scalar", hubSource);
  for (const name of ["getMinimumDelay", "getExpirationPeriod"])
    add(`hub.${name}`, A.hub, `${name}(uint256) view returns (uint256)`, [6], "scalar", hubSource);
  for (const name of ["getAllowedMarkets", "getRestrictedMarkets"])
    add(`hub.${name}`, A.hub, `${name}(uint256) view returns (address[])`, [6], "markets", hubSource);
  add("hub.getUpdateType", A.hub, "getUpdateType(uint256) view returns (string)", [6], "knownString", hubSource, "EModeCategoryUpdate");
  add("hub.getAgentContext", A.hub, "getAgentContext(uint256) view returns (bytes)", [6], "context", hubSource);
  add("hub.routerPermissioned", A.hub, "isPermissionedSender(uint256,address) view returns (bool)", [6, A.router], "scalar", hubSource);
  for (const updateType of ["EModeLTV", "EModeLiquidationThreshold", "EModeLiquidationBonus"]) {
    const source = `${AGENT_INTERFACES}IRangeValidationModule.sol`;
    add(`range.${updateType}.default`, A.range, "getDefaultRangeConfig(address,uint256,string) view returns ((uint120,uint120,bool,bool))", [A.hub, 6, updateType], "tuple", source);
    for (const category of [47, 48])
      add(`range.${updateType}.${category}`, A.range, "getRangeConfigByMarket(address,uint256,address,string) view returns ((uint120,uint120,bool,bool))", [A.hub, 6, market(category), updateType], "tuple", source);
  }
  return Object.freeze(views);
}
const VIEWS = buildViews();
const CALLS = new Set(VIEWS.map((v) => `${v.target}:${v.data}`));
function exactKeys(object, keys) { return object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).sort().join() === [...keys].sort().join(); }
function canonicalPin(pin) { return exactKeys(pin, ["blockHash", "requireCanonical"]) && hex32(pin.blockHash) && pin.requireCanonical === true; }
function allowRequest(method, params) {
  let ok = Array.isArray(params);
  if (!ok) fail("REQUEST_FORBIDDEN");
  if (method === "eth_chainId") ok = params.length === 0;
  else if (method === "eth_getBlockByNumber") ok = params.length === 2 && params[1] === false && (params[0] === "finalized" || /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(params[0]));
  else if (method === "eth_getTransactionReceipt") ok = params.length === 1 && TX_HASHES.includes(params[0]);
  else if (method === "eth_getCode") ok = params.length === 2 && Object.values(A).includes(params[0]) && canonicalPin(params[1]);
  else if (method === "eth_getStorageAt") ok = params.length === 3 && [A.pool, A.configurator].includes(params[0]) && params[1] === IMPLEMENTATION_SLOT && canonicalPin(params[2]);
  else if (method === "eth_call") ok = params.length === 2 && exactKeys(params[0], ["to", "data"]) && CALLS.has(`${params[0].to}:${params[0].data}`) && canonicalPin(params[1]);
  else if (method === "eth_getLogs") ok = params.length === 1 && exactKeys(params[0], ["address", "topics", "blockHash"]) && params[0].address === ZERO && stable(params[0].topics) === stable([ZERO32]) && hex32(params[0].blockHash);
  else ok = false;
  if (!ok) fail("REQUEST_FORBIDDEN");
}
function decodeView(view, raw) {
  try {
    if (!hex(raw, LIMITS.callBytes)) fail("CALL_INVALID");
    const decoded = view.iface.decodeFunctionResult(view.fn, raw);
    if (view.iface.encodeFunctionResult(view.fn, decoded).toLowerCase() !== raw.toLowerCase()) fail("CALL_INVALID");
    const value = decoded[0];
    if (view.kind === "knownString") {
      if (value !== view.expected) fail("SCOPE_CHANGED");
      return view.expected;
    }
    if (view.kind === "context") {
      if (value.toLowerCase() !== CODER.encode(["address"], [A.engine])) fail("SCOPE_CHANGED");
      return A.engine;
    }
    if (view.kind === "markets") {
      if (value.length > 2 || new Set(value.map((a) => a.toLowerCase())).size !== value.length || value.some((a) => ![market(47), market(48)].includes(a.toLowerCase()))) fail("SCOPE_CHANGED");
      return value.map((a) => a.toLowerCase()).sort();
    }
    const normalize = (v) => typeof v === "bigint" ? v.toString() : typeof v === "string" && address(v) ? v.toLowerCase() : v;
    const normalized = view.kind === "tuple" ? Array.from(value, normalize) : normalize(value);
    if (view.expected !== null && stable(normalized) !== stable(view.expected)) fail("SCOPE_CHANGED");
    return normalized;
  } catch (error) { if (error instanceof CheckError) throw error; fail("CALL_INVALID"); }
}

function expectedReceiptEvents(expected) {
  return expected.events.map((e) => ({ categoryId: e.categoryId, updateId: e.updateId, ltvBps: e.ltvBps,
    liquidationThresholdBps: e.liquidationThresholdBps, liquidationBonusFactorBps: e.liquidationBonusFactorBps,
    label: e.label, isolated: e.emittedIsolated, logIndices: [e.reportedInjectionLogIndex, e.reportedConfigurationLogIndex, e.reportedIsolationLogIndex] }));
}
function matchesHistoricalPool(current, baseline) {
  return current.implementationSlots.pool === A.historicalPoolImplementation
    && current.code.historicalPoolImplementation.keccak256 === baseline.materialState.code.implementation.keccak256
    && current.code.pool.keccak256 === baseline.materialState.code.proxy.keccak256;
}
function decodeReceipt(raw, expected, header) {
  try {
    if (!raw || raw.status !== "0x1" || raw.transactionHash?.toLowerCase() !== expected.transactionHash || raw.blockHash?.toLowerCase() !== header.hash
      || number(raw.blockNumber) !== expected.reportedBlockNumber || raw.to?.toLowerCase() !== FORWARDER
      || !Array.isArray(raw.logs) || raw.logs.length > LIMITS.logs) fail("RECEIPT_INVALID");
    const txIndex = number(raw.transactionIndex), seen = new Set(), selected = [];
    const names = ["EModeCategoryAdded", "EModeCategoryIsolationChanged", "UpdateInjected"];
    const topics = names.map((name) => EVENTS.getEvent(name).topicHash);
    let previous = -1;
    for (const log of raw.logs) {
      const index = number(log.logIndex);
      if (seen.has(index) || index <= previous || log.removed === true || log.transactionHash?.toLowerCase() !== expected.transactionHash
        || log.blockHash?.toLowerCase() !== header.hash || number(log.blockNumber) !== header.number || number(log.transactionIndex) !== txIndex
        || !address(log.address) || !Array.isArray(log.topics) || log.topics.length > 4 || log.topics.some((v) => !hex32(v)) || !hex(log.data, LIMITS.callBytes)) fail("RECEIPT_INVALID");
      seen.add(index); previous = index;
      const which = topics.indexOf(log.topics[0]?.toLowerCase());
      if (which < 0) continue;
      const name = names[which], emitter = name === "UpdateInjected" ? A.hub : A.configurator;
      if (log.address.toLowerCase() !== emitter) fail("RECEIPT_INVALID");
      const fragment = EVENTS.getEvent(name);
      if (log.topics.length !== fragment.inputs.filter((v) => v.indexed).length + 1) fail("RECEIPT_INVALID");
      const r = EVENTS.decodeEventLog(name, log.data, log.topics);
      const category = name === "UpdateInjected" ? Number(BigInt(r.market)) : Number(r.categoryId);
      const e = expected.events.find((row) => row.categoryId === category);
      if (!e) fail("RECEIPT_INVALID");
      if (name === "EModeCategoryAdded") {
        if (r.ltv !== BigInt(e.ltvBps) || r.liquidationThreshold !== BigInt(e.liquidationThresholdBps) || r.liquidationBonus !== BigInt(e.liquidationBonusFactorBps)
          || r.oracle.toLowerCase() !== ZERO || r.label !== e.label || index !== e.reportedConfigurationLogIndex) fail("RECEIPT_INVALID");
        if (EVENTS.encodeEventLog(fragment, Array.from(r)).data !== log.data.toLowerCase()) fail("RECEIPT_INVALID");
      } else if (name === "UpdateInjected") {
        if (r.agentId !== 6n || r.updateId !== BigInt(e.updateId) || log.topics[3].toLowerCase() !== id("EModeCategoryUpdate")
          || r.newValue.toLowerCase() !== CODER.encode(["uint256", "uint256", "uint256"], [e.ltvBps, e.liquidationThresholdBps, e.liquidationBonusFactorBps - 10000])
          || index !== e.reportedInjectionLogIndex
          || log.data.toLowerCase() !== CODER.encode(["uint256", "bytes"], [r.updateId, r.newValue])) fail("RECEIPT_INVALID");
      } else if (r.isolated !== e.emittedIsolated || index !== e.reportedIsolationLogIndex || log.data.toLowerCase() !== CODER.encode(["bool"], [r.isolated])) fail("RECEIPT_INVALID");
      selected.push({ name, category, logIndex: index });
    }
    for (const e of expected.events) {
      const rows = selected.filter((r) => r.category === e.categoryId);
      if (rows.length !== 3 || stable(rows.map((r) => r.name)) !== stable(["UpdateInjected", "EModeCategoryAdded", "EModeCategoryIsolationChanged"])) fail("RECEIPT_INVALID");
    }
    return { transactionHash: expected.transactionHash, block: header, transactionIndex: txIndex, receiptStatus: "success",
      events: expectedReceiptEvents(expected) };
  } catch (_) { fail("RECEIPT_INVALID"); }
}

function selectCandidates(records) {
  const pf = loadPreflight();
  const eligible = records.filter((r) => r.protocol === "EVM" && r.normalizedChain === "1" && r.networkTier === "MAINNET"
    && r.role === "RPC" && r.requestShape === "JSON_RPC" && r.eligibility === "PRIMARY_PROBE" && r.evidence === "OPERATIONAL_DECLARATION"
    && r.url?.protocol === "https:" && !r.url.username && !r.url.password && !r.url.hash)
    .map((row) => ({ row, family: pf.classifyOperatorFamily(row.url.href) }))
    .filter((r) => r.family)
    .sort((a, b) => (a.row.premium ? 0 : a.family.capabilityRank + 1) - (b.row.premium ? 0 : b.family.capabilityRank + 1) || a.row.order - b.row.order);
  const candidates = [], seen = new Set();
  // This is a candidate pool, not a preselected consensus pair. Capability checks follow.
  for (const item of eligible) {
    if (seen.has(item.family.operatorFamily)) continue;
    seen.add(item.family.operatorFamily);
    candidates.push({ handle: item.row, operatorFamily: item.family.operatorFamily, inventoryOrder: item.row.order });
    if (candidates.length === LIMITS.candidates) break;
  }
  return candidates;
}
function createTransport(candidates, options = {}) {
  const requestFn = options.request || https.request, monotonic = options.monotonic || (() => performance.now());
  const deadline = monotonic() + LIMITS.wallMs, handles = new Set(candidates.map((c) => c.handle));
  let calls = 0, bytes = 0, exhausted = null;
  return {
    get stats() { return { calls, responseBytes: bytes }; },
    async call(handle, method, params, requestedMs = LIMITS.requestMs) {
      allowRequest(method, params);
      if (exhausted) fail(exhausted);
      if (!handles.has(handle)) fail("REQUEST_FORBIDDEN");
      if (calls >= LIMITS.calls) fail("NETWORK_CALL_CAP");
      if (monotonic() >= deadline) fail("WALL_CAP");
      const url = handle.url;
      if (!(url instanceof URL) || url.protocol !== "https:" || url.username || url.password || url.hash) fail("REQUEST_FORBIDDEN");
      const requestId = ++calls, body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
      if (body.length > 16384) fail("BYTE_CAP");
      return new Promise((resolve, reject) => {
        let req, done = false, size = 0;
        const chunks = [];
        const finish = (code, value) => {
          if (done) return;
          done = true; clearTimeout(timer);
          if (["BYTE_CAP", "WALL_CAP"].includes(code)) exhausted = code;
          try { req?.destroy(); } catch (_) {}
          chunks.length = 0;
          if (code) reject(new CheckError(code)); else resolve(value);
        };
        const timer = setTimeout(() => finish("RPC_UNAVAILABLE"), Math.max(1, Math.min(requestedMs, LIMITS.requestMs, deadline - monotonic())));
        try {
          req = requestFn({ protocol: "https:", hostname: url.hostname, port: url.port || 443, path: `${url.pathname}${url.search}`,
            method: "POST", agent: false, rejectUnauthorized: true,
            headers: { ...(handle.headers || {}), ...(handle.origin ? { origin: handle.origin } : {}),
              "content-type": "application/json", accept: "application/json", "accept-encoding": "identity", "content-length": body.length } }, (res) => {
            res.on("error", () => finish("RPC_UNAVAILABLE"));
            res.on("aborted", () => finish("RPC_UNAVAILABLE"));
            res.on("data", (chunk) => {
              if (done) return;
              size += chunk.length; bytes += chunk.length;
              if (size > LIMITS.responseBytes || bytes > LIMITS.totalBytes) return finish("BYTE_CAP");
              if (monotonic() >= deadline) return finish("WALL_CAP");
              chunks.push(Buffer.from(chunk));
            });
            res.on("end", () => {
              if (done) return;
              if (monotonic() >= deadline) return finish("WALL_CAP");
              if (res.statusCode !== 200) return finish("RPC_UNAVAILABLE");
              try {
                const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (!raw || Array.isArray(raw) || raw.jsonrpc !== "2.0" || raw.id !== requestId || Object.hasOwn(raw, "error") || !Object.hasOwn(raw, "result")) return finish("RPC_ENVELOPE_INVALID");
                finish(null, raw.result);
              } catch (_) { finish("RPC_ENVELOPE_INVALID"); }
            });
          });
          req.on("error", () => finish("RPC_UNAVAILABLE"));
          req.end(body);
        } catch (_) { finish("RPC_UNAVAILABLE"); }
      });
    }
  };
}

async function collect({ candidates, rawCall, authority, now = Date.now }) {
  const pf = loadPreflight(), startedAt = new Date(now()).toISOString(), failures = {};
  let fatal = null;
  const rpc = pf.createRpcLedger(async (handle, method, params, timeout) => {
    if (fatal) fail(fatal);
    allowRequest(method, params);
    try { return await rawCall(handle, method, params, timeout); }
    catch (error) {
      if (error instanceof CheckError && ["BYTE_CAP", "WALL_CAP", "NETWORK_CALL_CAP"].includes(error.code)) fatal = error.code;
      throw error;
    }
  }, LIMITS.calls);
  const report = { schema: SCHEMA, executionMode: "injected", status: "INCOMPLETE", code: "UNEXPECTED", startedAt,
    completedAt: null, observedAt: null, freshnessExpiresAt: null, rpcStrength: null, pin: null, observations: null,
    selectedFamilyCount: 0, callsUsed: 0, failures, gates: { routePositive: "unknown", executableNow: "unknown", signedActionJustified: false,
      fork: false, completeRuntimeBinding: false, completeAuthorityVerification: false, stressModelEligible: false } };
  const readHeader = async (handle, tag) => {
    const h = pf.normalizeHeader(await rpc.call(handle, "eth_getBlockByNumber", [tag, false], 6000));
    if (!h || (tag !== "finalized" && h.number !== number(tag))) fail("HEADER_INVALID");
    return h;
  };
  const fresh = (pin) => {
    const age = now() / 1000 - Number(pin.timestamp);
    if (pin.number < authority.evidence.transactions[1].reportedBlockNumber || age < 0 || age > LIMITS.maxPinAgeSeconds) fail("PIN_STALE");
  };
  try {
    const result = await pf.qualifyCommonFinalized({ chainId: 1, candidates, rpc, minimumFamilies: 2, preferredFamilies: 3,
      limits: { maxCandidates: LIMITS.candidates, maxProbeCallsPerCandidate: LIMITS.probeCalls, reserveRequests: LIMITS.reserveCalls, retries: 0 },
      probe: async ({ reader, candidate, pin }) => {
        try {
          fresh(pin);
          const receipts = [];
          for (const expected of authority.evidence.transactions) {
            const header = await readHeader(candidate.handle, quantity(expected.reportedBlockNumber));
            if (header.number > pin.number || header.timestamp !== String(Date.parse(expected.reportedTimestamp) / 1000)) fail("HEADER_INVALID");
            const receipt = await rpc.call(candidate.handle, "eth_getTransactionReceipt", [expected.transactionHash], LIMITS.requestMs);
            receipts.push(decodeReceipt(receipt, expected, header));
          }
          const code = {}, slots = {}, views = {};
          for (const [name, target] of Object.entries(A)) {
            const raw = await reader.getCode(target);
            if (!hex(raw, 65536) || raw === "0x") fail("CALL_INVALID");
            code[name] = { address: target, bytes: (raw.length - 2) / 2, keccak256: keccak256(raw) };
          }
          for (const name of ["pool", "configurator"]) {
            const raw = await reader.getStorageAt(A[name], IMPLEMENTATION_SLOT);
            if (!/^0x0{24}[0-9a-f]{40}$/i.test(raw)) fail("CALL_INVALID");
            slots[name] = `0x${raw.slice(-40).toLowerCase()}`;
          }
          for (const view of VIEWS) views[view.key] = decodeView(view, await reader.call({ to: view.target, data: view.data }));
          return { receipts, current: { code, implementationSlots: slots, views } };
        } catch (error) {
          const code = error instanceof CheckError ? error.code : error instanceof pf.PreflightError && CODES.has(error.code) ? error.code : "RPC_UNAVAILABLE";
          failures[code] = (failures[code] || 0) + 1;
          throw new CheckError(code);
        }
      } });
    if (fatal) fail(fatal);
    const observation = result.selected[0].normalizedObservation;
    for (const selected of result.selected) {
      const handle = selected.candidate.handle;
      if (stable(await readHeader(handle, quantity(result.pin.number))) !== stable(result.pin)) fail("TERMINAL_RECHECK_FAILED");
      for (const receipt of observation.receipts)
        if (stable(await readHeader(handle, quantity(receipt.block.number))) !== stable(receipt.block)) fail("TERMINAL_RECHECK_FAILED");
      const finalized = await readHeader(handle, "finalized");
      if (finalized.number < result.pin.number || (finalized.number === result.pin.number && stable(finalized) !== stable(result.pin))) fail("TERMINAL_RECHECK_FAILED");
    }
    fresh(result.pin);
    const completedAt = new Date(now()).toISOString();
    Object.assign(report, { status: "CORROBORATED_OBSERVATIONS", code: "NONE", completedAt, observedAt: completedAt,
      freshnessExpiresAt: new Date(Date.parse(completedAt) + LIMITS.freshnessSeconds * 1000).toISOString(), rpcStrength: "corroborated",
      pin: result.pin, observations: observation, selectedFamilyCount: result.selected.length,
      diagnostics: result.diagnostics, terminalHeadersRechecked: true,
      historicalPoolBaselineMatches: matchesHistoricalPool(observation.current, authority.baseline) });
  } catch (error) {
    report.code = fatal || (error instanceof pf.PreflightError && CODES.has(error.code) ? error.code : safeCode(error));
    report.completedAt = new Date(now()).toISOString();
  }
  report.callsUsed = rpc.networkCalls;
  report.limitations = ["Provider corroboration is not receipt/state-root proof or proof of independent backends.",
    "The ABI pins establish decoding inputs, not full deployed implementation equivalence.",
    "Agent interfaces are pinned local interface copies; the new agent/authority/oracle runtime chain is not rebuilt or proven.",
    "Matching the historical Pool byte hashes does not bind every current dependency.",
    "Two receipts are not complete intervening governance or configuration history.",
    "No positions, transactions, stress model, profitability or protocol-safety conclusion."];
  return report;
}

function validateReport(report) {
  if (!report || report.schema !== SCHEMA || !["INCOMPLETE", "CORROBORATED_OBSERVATIONS"].includes(report.status)
    || !["production", "injected"].includes(report.executionMode) || !Number.isInteger(report.callsUsed) || report.callsUsed < 0 || report.callsUsed > LIMITS.calls
    || !Number.isFinite(Date.parse(report.startedAt)) || !Number.isFinite(Date.parse(report.completedAt)) || Date.parse(report.completedAt) < Date.parse(report.startedAt)
    || stable(report.gates) !== stable({ routePositive: "unknown", executableNow: "unknown", signedActionJustified: false, fork: false,
      completeRuntimeBinding: false, completeAuthorityVerification: false, stressModelEligible: false })) fail("OUTPUT_INVALID");
  if (report.status === "INCOMPLETE") {
    if (!CODES.has(report.code) || report.observations !== null || report.pin !== null || report.rpcStrength !== null || report.selectedFamilyCount !== 0
      || report.observedAt !== null || report.freshnessExpiresAt !== null || report.terminalHeadersRechecked === true) fail("OUTPUT_INVALID");
  } else if (report.code !== "NONE" || !report.pin || !hex32(report.pin.hash) || !report.observations
    || !Number.isInteger(report.selectedFamilyCount) || report.selectedFamilyCount < 2 || report.selectedFamilyCount > 3 || report.rpcStrength !== "corroborated"
    || report.terminalHeadersRechecked !== true || !Number.isFinite(Date.parse(report.observedAt)) || !Number.isFinite(Date.parse(report.freshnessExpiresAt))
    || Date.parse(report.freshnessExpiresAt) <= Date.parse(report.observedAt)) fail("OUTPUT_INVALID");
  if (report.status === "CORROBORATED_OBSERVATIONS") {
    try {
      const validHeader = (h) => exactKeys(h, ["number", "hash", "parentHash", "stateRoot", "timestamp"])
        && Number.isSafeInteger(h.number) && h.number >= 0 && hex32(h.hash) && hex32(h.parentHash) && hex32(h.stateRoot)
        && typeof h.timestamp === "string" && /^(0|[1-9][0-9]*)$/.test(h.timestamp) && Number.isSafeInteger(Number(h.timestamp));
      // Check age against collection time rather than the time an archived artifact is revalidated.
      if (!validHeader(report.pin) || report.observedAt !== report.completedAt
        || Date.parse(report.observedAt) / 1000 - Number(report.pin.timestamp) < 0
        || Date.parse(report.observedAt) / 1000 - Number(report.pin.timestamp) > LIMITS.maxPinAgeSeconds
        || Date.parse(report.freshnessExpiresAt) - Date.parse(report.observedAt) !== LIMITS.freshnessSeconds * 1000) fail("OUTPUT_INVALID");
      const expectedTransactions = JSON.parse(pinnedRead(R2, PINS[R2]).toString("utf8")).transactions;
      const { current, receipts } = report.observations;
      if (!exactKeys(report.observations, ["current", "receipts"]) || !exactKeys(current, ["code", "implementationSlots", "views"])
        || !exactKeys(current.code, Object.keys(A)) || !exactKeys(current.implementationSlots, ["pool", "configurator"])
        || !exactKeys(current.views, VIEWS.map((v) => v.key)) || !Array.isArray(receipts) || receipts.length !== 2) fail("OUTPUT_INVALID");
      for (const [name, target] of Object.entries(A)) {
        const code = current.code[name];
        if (!exactKeys(code, ["address", "bytes", "keccak256"]) || code.address !== target || !Number.isInteger(code.bytes)
          || code.bytes <= 0 || code.bytes > 65536 || !hex32(code.keccak256)) fail("OUTPUT_INVALID");
      }
      if (Object.values(current.implementationSlots).some((v) => !address(v))) fail("OUTPUT_INVALID");
      for (const view of VIEWS) {
        const value = current.views[view.key], abiValue = view.kind === "context" ? CODER.encode(["address"], [value]) : value;
        if (stable(decodeView(view, view.iface.encodeFunctionResult(view.fn, [abiValue]))) !== stable(value)) fail("OUTPUT_INVALID");
      }
      for (let index = 0; index < receipts.length; index += 1) {
        const receipt = receipts[index], expected = expectedTransactions[index];
        if (receipt.transactionHash !== TX_HASHES[index] || receipt.receiptStatus !== "success" || !Number.isSafeInteger(receipt.transactionIndex)
          || receipt.transactionIndex < 0 || !validHeader(receipt.block) || receipt.block.number > report.pin.number
          || receipt.block.number !== expected.reportedBlockNumber || receipt.block.timestamp !== String(Date.parse(expected.reportedTimestamp) / 1000)
          || stable(receipt.events) !== stable(expectedReceiptEvents(expected))) fail("OUTPUT_INVALID");
      }
      if (typeof report.historicalPoolBaselineMatches !== "boolean") fail("OUTPUT_INVALID");
      if (report.executionMode === "production"
        && report.historicalPoolBaselineMatches !== matchesHistoricalPool(current, JSON.parse(pinnedRead(BASELINE, PINS[BASELINE]).toString("utf8")))) fail("OUTPUT_INVALID");
    } catch (_) { fail("OUTPUT_INVALID"); }
  }
  const text = stable(report);
  if (Buffer.byteLength(text) > LIMITS.outputBytes || /https?:\/\/|authorization|bearer\s|api[_-]?key/i.test(text)) fail("OUTPUT_INVALID");
  return true;
}
function writeExclusive(file, value) {
  let fd;
  try {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    if (bytes.length > LIMITS.outputBytes) fail("OUTPUT_INVALID");
    fd = fs.openSync(file, "wx", 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (!fs.readFileSync(file).equals(bytes)) fail("OUTPUT_INVALID");
  } catch (error) { if (error instanceof CheckError) throw error; if (error?.code === "EEXIST") fail("ATTEMPT_CONSUMED"); fail("OUTPUT_INVALID"); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
async function runOnce(options = {}) {
  const injected = Object.keys(options).length > 0;
  if (injected && (typeof options.readInventory !== "function" || typeof options.transport?.call !== "function")) fail("INPUT_INVALID");
  if (!injected && require.main !== module) fail("INVOCATION_INVALID");
  const root = options.root || ROOT, authority = readAuthority();
  pinnedRead(INVENTORY_HELPER, PINS[INVENTORY_HELPER]);
  const inventory = require("./preflight-all-chain-endpoints-v4.js");
  try { inventory.safeParent(root, OUTPUT, { create: false }); } catch (_) { fail("OUTPUT_INVALID"); }
  if (fs.existsSync(path.join(root, OUTPUT)) || fs.existsSync(path.join(root, ATTEMPT))) fail("ATTEMPT_CONSUMED");
  const now = options.now || Date.now;
  const sourceHashes = { ...authority.pins, "tools/run-aave-ethereum-emode-47-48-r3.js": sha256(fs.readFileSync(__filename)),
    "tools/test-run-aave-ethereum-emode-47-48-r3.js": sha256(fs.readFileSync(path.join(__dirname, "test-run-aave-ethereum-emode-47-48-r3.js"))) };
  writeExclusive(path.join(root, ATTEMPT), { schema: `${SCHEMA}/attempt`, startedAt: new Date(now()).toISOString(), sourceHashes,
    executionMode: injected ? "injected" : "production", allowedRuns: 1, automaticRetries: 0 });
  let report, transport, inventoryReads = 0, inventoryReadAttempts = 0;
  try {
    inventoryReadAttempts += 1;
    let parsed;
    if (injected) { parsed = options.readInventory(); inventoryReads += 1; }
    else {
      const source = inventory.readSource("rpc_endpoints.txt", { root: ROOT });
      inventoryReads += 1;
      parsed = inventory.parsePrimaryRpcGrammar(source.text);
    }
    const candidates = selectCandidates(parsed.records);
    transport = options.transport || createTransport(candidates);
    report = await collect({ candidates, rawCall: transport.call.bind(transport), authority, now });
  } catch (_) {
    report = { schema: SCHEMA, executionMode: "injected", status: "INCOMPLETE", code: "INVENTORY_INVALID", startedAt: new Date(now()).toISOString(),
      completedAt: new Date(now()).toISOString(), observedAt: null, freshnessExpiresAt: null, pin: null, observations: null, rpcStrength: null,
      selectedFamilyCount: 0, callsUsed: transport?.stats?.calls || 0,
      gates: { routePositive: "unknown", executableNow: "unknown", signedActionJustified: false, fork: false,
        completeRuntimeBinding: false, completeAuthorityVerification: false, stressModelEligible: false } };
  }
  report.executionMode = injected ? "injected" : "production";
  report.inventoryReads = inventoryReads;
  report.inventoryReadAttempts = inventoryReadAttempts;
  report.transportRequestAttempts = transport?.stats?.calls ?? null;
  report.responseBytes = transport?.stats?.responseBytes ?? null;
  report.sourceHashes = sourceHashes;
  report.ethersVersion = ethersVersion;
  // Do not publish if source or runner inputs changed during the bounded capture.
  for (const [file, hash] of Object.entries(sourceHashes)) pinnedRead(file, hash);
  validateReport(report);
  const envelope = { sha256: sha256(stable(report)), report };
  writeExclusive(path.join(root, OUTPUT), envelope);
  return envelope;
}
async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 1 || !["--check", "--run-once"].includes(argv[0]) || process.execArgv.length
      || ["NODE_OPTIONS", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_ENV_PROXY", "SSLKEYLOGFILE"].some((name) => process.env[name])) fail("INVOCATION_INVALID");
    if (argv[0] === "--check") {
      readAuthority();
      process.stdout.write(`${JSON.stringify({ status: "OFFLINE_INPUT_CHECK_PASS", views: VIEWS.length, sourcePins: Object.keys(PINS).length, network: false })}\n`);
      return;
    }
    const envelope = await runOnce();
    process.stdout.write(`${JSON.stringify({ status: envelope.report.status, code: envelope.report.code, callsUsed: envelope.report.callsUsed, output: OUTPUT, sha256: envelope.sha256 })}\n`);
    if (envelope.report.status === "INCOMPLETE") process.exitCode = 2;
  } catch (error) { process.stdout.write(`${JSON.stringify({ status: "REFUSED_OR_FAILED", code: safeCode(error) })}\n`); process.exitCode = 2; }
}
if (require.main === module) main();
module.exports = { A, ROOT, SCHEMA, OUTPUT, ATTEMPT, PINS, LIMITS, VIEWS, ASSETS, EVENTS, ZERO, ZERO32, FORWARDER,
  IMPLEMENTATION_SLOT, TX_HASHES, CheckError, stable, sha256, quantity, market, readAuthority, allowRequest,
  decodeView, decodeReceipt, selectCandidates, createTransport, collect, validateReport, writeExclusive, runOnce };
