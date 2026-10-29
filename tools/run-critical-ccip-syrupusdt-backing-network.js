#!/usr/bin/env node
"use strict";

// Immutable bounded network runner for the authorized CCIP syrupUSDT backing branch.
// Read-only fixed-pin calls only. No endpoint inventories, env files, transactions, logs, forks, or state overrides.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Interface, getAddress, keccak256, id } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const CAPTURE = "reports/raw/fast/critical-ccip-syrupusdt-backing-conservation.capture.json";
const MAX_RPC = 220;
const MAX_METADATA = 20;
const MAX_ROUTES = 8;
const ETH_SELECTOR = "5009297550715157269";
const ETH_POOL = getAddress("0xDE76A096C5eadDdf97Af3fE15ee49d32AEDa9822");
const ETH_TOKEN = getAddress("0x356B8d89c1e1239Cbbb9dE4815c39A1474d5BA7D");
const PRIOR_MANIFEST = "reports/raw/fast/critical-ccip-syrupusdt-release-auth-manifest.json";
const PRIOR_RAW = "reports/raw/fast/critical-ccip-syrupusdt-release-auth.json";
const PRIOR_EXPECTED_REVISION = "oracle-offline-local-exact-build-r2";
const PRIOR_EXPECTED_AGGREGATE = "82c4a08e3f8e27bf29836191f46e7f57513bd9b9d331cae1fd13b94bb964f88d";

// Public no-secret presets are assembled in memory and never emitted.
const RPC = {
  ethereum: ["https://", "ethereum-rpc", ".publicnode", ".com"].join(""),
  bsc: ["https://", "bsc-rpc", ".publicnode", ".com"].join(""),
  mantle: ["https://", "mantle-rpc", ".publicnode", ".com"].join(""),
  ink: ["https://", "ink-rpc", ".publicnode", ".com"].join(""),
  plasma: ["https://", "plasma-rpc", ".publicnode", ".com"].join(""),
};
const SOURCE_REPO = ["https://", "repo", ".sourcify", ".dev"].join("");

const MAPPINGS = {
  "9335212494177455608": {
    key: "plasma", name: "Plasma", chainId: "9745", evm: true,
    provenance: [
      { path: "targets/aave-governance-v3/lib/aave-delivery-infrastructure/src/contracts/adapters/ccip/CCIPAdapter.sol", marker: "nativeChainId == uint64(9335212494177455608)" },
      { path: "targets/aave-governance-v3/lib/aave-delivery-infrastructure/lib/solidity-utils/src/contracts/utils/ChainHelpers.sol", marker: "PLASMA = 9745" },
    ],
  },
  "1556008542357238666": {
    key: "mantle", name: "Mantle", chainId: "5000", evm: true,
    provenance: [{ path: "targets/hyperlane-monorepo/typescript/sdk/src/ccip/consts.ts", marker: "chainSelector: '1556008542357238666'" }],
  },
  "11344663589394136015": {
    key: "bsc", name: "BNB Chain", chainId: "56", evm: true,
    provenance: [{ path: "targets/hyperlane-monorepo/typescript/sdk/src/ccip/consts.ts", marker: "chainSelector: '11344663589394136015'" }],
  },
  "3461204551265785888": {
    key: "ink", name: "Ink", chainId: "57073", evm: true,
    provenance: [{ path: "targets/hyperlane-monorepo/typescript/sdk/src/ccip/consts.ts", marker: "chainSelector: '3461204551265785888'" }],
  },
};

const POOL = new Interface([
  "function typeAndVersion() view returns (string)",
  "function getToken() view returns (address)",
  "function getTokenDecimals() view returns (uint8)",
  "function getSupportedChains() view returns (uint64[])",
  "function getRemotePools(uint64 remoteChainSelector) view returns (bytes[])",
  "function getRemoteToken(uint64 remoteChainSelector) view returns (bytes)",
  "function owner() view returns (address)",
]);
const TOKEN = new Interface([
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function owner() view returns (address)",
  "function typeAndVersion() view returns (string)",
  "function getMinters() view returns (address[])",
  "function getBurners() view returns (address[])",
  "function isMinter(address) view returns (bool)",
  "function isBurner(address) view returns (bool)",
]);

function abs(rel) { return path.join(ROOT, ...rel.split("/")); }
function sha256(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function read(rel) { return fs.readFileSync(abs(rel)); }
function text(rel) { return read(rel).toString("utf8"); }
function json(rel) { return JSON.parse(text(rel)); }
function safe(value) {
  return String(value == null ? "" : value)
    .replace(/https?:\/\/[^\s"']+/gi, "[endpoint-redacted]")
    .replace(/[?&](?:key|token|api_key|apikey)=[^\s&"']+/gi, "[credential-redacted]")
    .slice(0, 500);
}
function hasCode(code) { return typeof code === "string" && /^0x[0-9a-f]+$/i.test(code) && !/^0x0*$/i.test(code); }
function codeInfo(code) { return { bytes: hasCode(code) ? (code.length - 2) / 2 : 0, keccak256: hasCode(code) ? keccak256(code) : null, present: hasCode(code) }; }
function addressFromBytes(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) return null;
  const hex = value.slice(2);
  let candidate = null;
  if (hex.length === 40) candidate = hex;
  else if (hex.length === 64 && /^0{24}[0-9a-fA-F]{40}$/.test(hex)) candidate = hex.slice(24);
  if (!candidate) return null;
  try { return getAddress(`0x${candidate}`); } catch { return null; }
}
function findHex(value, depth = 0) {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value)) return value.toLowerCase();
  if (typeof value !== "object") return null;
  for (const key of ["data", "result", "return", "output", "originalError"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const found = findHex(value[key], depth + 1);
      if (found != null) return found;
    }
  }
  return null;
}

class Budget {
  constructor() { this.rpc = 0; this.metadata = 0; this.rpcTranscript = []; this.metadataTranscript = []; }
  async rpcRead(chain, method, params, label) {
    if (this.rpc >= MAX_RPC) throw new Error(`RPC cap reached before ${chain}.${label}`);
    const requestNumber = ++this.rpc;
    let payload;
    try {
      const response = await fetch(RPC[chain], {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: requestNumber, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`public preset HTTP ${response.status}`);
      payload = await response.json();
    } catch (error) {
      const failure = { kind: "transport", message: safe(error?.message || error) };
      this.rpcTranscript.push({ requestNumber, chain, label, method, params, response: { failure } });
      return { ok: false, failure };
    }
    if (!payload || payload.jsonrpc !== "2.0" || payload.id !== requestNumber) {
      const failure = { kind: "malformed-response", message: "JSON-RPC envelope/id mismatch" };
      this.rpcTranscript.push({ requestNumber, chain, label, method, params, response: { failure } });
      return { ok: false, failure };
    }
    if (payload.error) {
      const error = { code: Number.isInteger(payload.error.code) ? payload.error.code : null, message: safe(payload.error.message), data: findHex(payload.error.data) };
      this.rpcTranscript.push({ requestNumber, chain, label, method, params, response: { error } });
      return { ok: false, error };
    }
    let retained = payload.result;
    if (method === "eth_getBlockByNumber" && retained && typeof retained === "object") {
      retained = { number: retained.number, hash: retained.hash, timestamp: retained.timestamp };
    }
    this.rpcTranscript.push({ requestNumber, chain, label, method, params, response: { result: retained } });
    return { ok: true, result: payload.result };
  }
  async metadataGet(chain, kind, address) {
    if (this.metadata >= MAX_METADATA) throw new Error(`metadata cap reached before ${chain}.${kind}`);
    const requestNumber = ++this.metadata;
    const url = `${SOURCE_REPO}/contracts/full_match/${MAPPINGS_BY_KEY[chain].chainId}/${address}/metadata.json`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      const row = { requestNumber, chain, kind, status: response.status, ok: response.ok, bytes: bytes.length, sha256: sha256(bytes) };
      let summary = null;
      if (response.ok) {
        try {
          const metadata = JSON.parse(bytes.toString("utf8"));
          summary = {
            compilerVersion: metadata.compiler?.version || null,
            compilationTarget: metadata.settings?.compilationTarget || null,
            sourceCount: Object.keys(metadata.sources || {}).length,
            sourceHashes: Object.entries(metadata.sources || {}).map(([sourcePath, value]) => ({ sourcePath, keccak256: value.keccak256 || null })).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
            abiFunctionNames: (metadata.output?.abi || []).filter((x) => x.type === "function").map((x) => x.name).sort(),
          };
        } catch (error) { row.parseFailure = safe(error.message); }
      }
      this.metadataTranscript.push(row);
      return { fullMatch: Boolean(response.ok && summary), summary };
    } catch (error) {
      this.metadataTranscript.push({ requestNumber, chain, kind, status: null, ok: false, bytes: 0, sha256: null, failure: safe(error?.message || error) });
      return { fullMatch: false, summary: null };
    }
  }
}

const MAPPINGS_BY_KEY = Object.fromEntries(Object.values(MAPPINGS).map((x) => [x.key, x]));

function decode(iface, fn, response, map = (x) => x[0]) {
  if (!response.ok) return { ok: false, raw: response.error?.data || null, error: response.error || response.failure || null, decoded: null };
  try { return { ok: true, raw: response.result, error: null, decoded: map(iface.decodeFunctionResult(fn, response.result)) }; }
  catch (error) { return { ok: false, raw: response.result, error: { kind: "decode", message: safe(error.message) }, decoded: null }; }
}
async function call(budget, chain, to, iface, fn, args, pin, label, map) {
  const response = await budget.rpcRead(chain, "eth_call", [{ to, data: iface.encodeFunctionData(fn, args) }, pin], label);
  return decode(iface, fn, response, map);
}
async function pinChain(budget, key, expectedChainId) {
  const chainId = await budget.rpcRead(key, "eth_chainId", [], "pin.chainId");
  if (!chainId.ok) return { reached: false, coverageGap: "eth_chainId unavailable", chainId: null, pin: null };
  let decimal;
  try { decimal = BigInt(chainId.result).toString(); } catch { return { reached: false, coverageGap: "eth_chainId malformed", chainId: chainId.result, pin: null }; }
  if (decimal !== String(expectedChainId)) return { reached: false, coverageGap: `eth_chainId mismatch expected=${expectedChainId} actual=${decimal}`, chainId: decimal, pin: null };
  const finalized = await budget.rpcRead(key, "eth_getBlockByNumber", ["finalized", false], "pin.finalized");
  if (!finalized.ok || !finalized.result?.number || !finalized.result?.hash || !finalized.result?.timestamp) return { reached: false, coverageGap: "finalized block unavailable/incomplete", chainId: decimal, pin: null };
  return {
    reached: true,
    chainId: decimal,
    coverageGap: null,
    pin: {
      blockNumberHex: finalized.result.number.toLowerCase(),
      blockNumberDecimal: BigInt(finalized.result.number).toString(),
      blockHash: finalized.result.hash.toLowerCase(),
      blockTimestampHex: finalized.result.timestamp.toLowerCase(),
      blockTimestampDecimal: BigInt(finalized.result.timestamp).toString(),
      terminalHash: null,
      terminalSameHash: false,
    },
  };
}
async function terminalPin(budget, key, pin) {
  const terminal = await budget.rpcRead(key, "eth_getBlockByNumber", [pin.blockNumberHex, false], "pin.terminalSameNumber");
  pin.terminalHash = terminal.ok && terminal.result?.hash ? terminal.result.hash.toLowerCase() : null;
  pin.terminalSameHash = Boolean(terminal.ok && terminal.result?.number?.toLowerCase() === pin.blockNumberHex && pin.terminalHash === pin.blockHash);
  return pin.terminalSameHash;
}

function bindMappings(selectors) {
  const rows = [];
  for (const selector of selectors) {
    const mapping = MAPPINGS[selector] || null;
    if (!mapping) { rows.push({ selector, resolved: false, evm: null, coverageGap: "selector absent from authoritative/local mappings", mapping: null }); continue; }
    const provenance = mapping.provenance.map((item) => {
      const body = text(item.path);
      if (!body.includes(item.marker)) throw new Error(`mapping marker absent: ${item.path}`);
      return { path: item.path, bytes: Buffer.byteLength(body), sha256: sha256(Buffer.from(body)), marker: item.marker };
    });
    rows.push({ selector, resolved: true, evm: mapping.evm, coverageGap: null, mapping: { key: mapping.key, name: mapping.name, chainId: mapping.chainId }, provenance });
  }
  return rows;
}

async function ethereumInventory(budget) {
  const chain = await pinChain(budget, "ethereum", "1");
  if (!chain.reached) return { chain, coverageGap: chain.coverageGap, routes: [] };
  const pin = chain.pin.blockNumberHex;
  const poolCode = await budget.rpcRead("ethereum", "eth_getCode", [ETH_POOL, pin], "pool.code");
  const tokenCode = await budget.rpcRead("ethereum", "eth_getCode", [ETH_TOKEN, pin], "token.code");
  const typeAndVersion = await call(budget, "ethereum", ETH_POOL, POOL, "typeAndVersion", [], pin, "pool.typeAndVersion", (x) => String(x[0]));
  const poolToken = await call(budget, "ethereum", ETH_POOL, POOL, "getToken", [], pin, "pool.getToken", (x) => getAddress(x[0]));
  const poolDecimals = await call(budget, "ethereum", ETH_POOL, POOL, "getTokenDecimals", [], pin, "pool.getTokenDecimals", (x) => x[0].toString());
  const supported = await call(budget, "ethereum", ETH_POOL, POOL, "getSupportedChains", [], pin, "pool.getSupportedChains", (x) => [...x[0]].map((v) => v.toString()));
  const tokenDecimals = await call(budget, "ethereum", ETH_TOKEN, TOKEN, "decimals", [], pin, "token.decimals", (x) => x[0].toString());
  const custody = await call(budget, "ethereum", ETH_TOKEN, TOKEN, "balanceOf", [ETH_POOL], pin, "token.balanceOf.pool", (x) => x[0].toString());
  const totalSupply = await call(budget, "ethereum", ETH_TOKEN, TOKEN, "totalSupply", [], pin, "token.totalSupply.contextOnly", (x) => x[0].toString());
  const required = [poolCode.ok && hasCode(poolCode.result), tokenCode.ok && hasCode(tokenCode.result), typeAndVersion.ok, poolToken.ok, poolDecimals.ok, supported.ok, tokenDecimals.ok, custody.ok];
  const routes = [];
  if (supported.ok) {
    for (const selector of supported.decoded) {
      const remotePools = await call(budget, "ethereum", ETH_POOL, POOL, "getRemotePools", [selector], pin, `pool.getRemotePools.${selector}`, (x) => [...x[0]].map(String));
      const remoteToken = await call(budget, "ethereum", ETH_POOL, POOL, "getRemoteToken", [selector], pin, `pool.getRemoteToken.${selector}`, (x) => String(x[0]));
      routes.push({
        selector,
        remotePoolsRaw: remotePools.decoded || [],
        remotePoolAddresses: (remotePools.decoded || []).map(addressFromBytes),
        remoteTokenRaw: remoteToken.decoded,
        remoteTokenAddress: addressFromBytes(remoteToken.decoded),
        calls: { remotePools, remoteToken },
      });
    }
  }
  await terminalPin(budget, "ethereum", chain.pin);
  return {
    chain,
    coverageGap: required.every(Boolean) && chain.pin.terminalSameHash ? null : "Ethereum pool/token/custody binding incomplete",
    pool: { address: ETH_POOL, runtime: codeInfo(poolCode.result), typeAndVersion, token: poolToken, tokenDecimals: poolDecimals },
    token: { address: ETH_TOKEN, runtime: codeInfo(tokenCode.result), decimals: tokenDecimals, totalSupplyContextOnly: totalSupply },
    custodyRaw: custody.decoded,
    supportedSelectors: supported.decoded || [],
    routes,
  };
}

async function counterpartRoute(budget, route, mappingRow, chainPins) {
  const mapping = mappingRow.mapping;
  const key = mapping.key;
  if (!chainPins[key]) chainPins[key] = await pinChain(budget, key, mapping.chainId);
  const chain = chainPins[key];
  const base = { selector: route.selector, chain: mapping, chainPin: chain, ethereumRoute: route, coverageGaps: [], topologyComplete: false, sourceRuntimeComplete: false, attributableLiabilityProven: false, attributableLiabilityRaw: null, unknownSupplyRaw: null };
  if (!chain.reached) { base.coverageGaps.push(chain.coverageGap); return base; }
  if (route.remotePoolAddresses.length !== 1 || !route.remotePoolAddresses[0]) base.coverageGaps.push("zero/multiple/non-EVM-decodable remote pools; migration/alternate route UNKNOWN");
  if (!route.remoteTokenAddress) base.coverageGaps.push("remote token is non-EVM-decodable or empty");
  if (base.coverageGaps.length) return base;
  const pool = route.remotePoolAddresses[0];
  const token = route.remoteTokenAddress;
  const pin = chain.pin.blockNumberHex;
  const poolCode = await budget.rpcRead(key, "eth_getCode", [pool, pin], "counterpart.pool.code");
  const tokenCode = await budget.rpcRead(key, "eth_getCode", [token, pin], "counterpart.token.code");
  const typeAndVersion = await call(budget, key, pool, POOL, "typeAndVersion", [], pin, "counterpart.pool.typeAndVersion", (x) => String(x[0]));
  const poolToken = await call(budget, key, pool, POOL, "getToken", [], pin, "counterpart.pool.getToken", (x) => getAddress(x[0]));
  const poolDecimals = await call(budget, key, pool, POOL, "getTokenDecimals", [], pin, "counterpart.pool.getTokenDecimals", (x) => x[0].toString());
  const supported = await call(budget, key, pool, POOL, "getSupportedChains", [], pin, "counterpart.pool.getSupportedChains", (x) => [...x[0]].map((v) => v.toString()));
  const backPools = await call(budget, key, pool, POOL, "getRemotePools", [ETH_SELECTOR], pin, "counterpart.pool.getRemotePools.ethereum", (x) => [...x[0]].map(String));
  const backToken = await call(budget, key, pool, POOL, "getRemoteToken", [ETH_SELECTOR], pin, "counterpart.pool.getRemoteToken.ethereum", (x) => String(x[0]));
  const decimals = await call(budget, key, token, TOKEN, "decimals", [], pin, "counterpart.token.decimals", (x) => x[0].toString());
  const supply = await call(budget, key, token, TOKEN, "totalSupply", [], pin, "counterpart.token.totalSupply", (x) => x[0].toString());
  const symbol = await call(budget, key, token, TOKEN, "symbol", [], pin, "counterpart.token.symbol", (x) => String(x[0]));
  const name = await call(budget, key, token, TOKEN, "name", [], pin, "counterpart.token.name", (x) => String(x[0]));
  const poolOwner = await call(budget, key, pool, POOL, "owner", [], pin, "counterpart.pool.owner", (x) => getAddress(x[0]));
  const tokenOwner = await call(budget, key, token, TOKEN, "owner", [], pin, "counterpart.token.owner", (x) => getAddress(x[0]));
  const tokenType = await call(budget, key, token, TOKEN, "typeAndVersion", [], pin, "counterpart.token.typeAndVersion", (x) => String(x[0]));
  const minters = await call(budget, key, token, TOKEN, "getMinters", [], pin, "counterpart.token.getMinters", (x) => [...x[0]].map(getAddress));
  const burners = await call(budget, key, token, TOKEN, "getBurners", [], pin, "counterpart.token.getBurners", (x) => [...x[0]].map(getAddress));
  const isMinter = await call(budget, key, token, TOKEN, "isMinter", [pool], pin, "counterpart.token.isMinter.pool", (x) => Boolean(x[0]));
  const isBurner = await call(budget, key, token, TOKEN, "isBurner", [pool], pin, "counterpart.token.isBurner.pool", (x) => Boolean(x[0]));
  const poolSource = await budget.metadataGet(key, "pool", pool);
  const tokenSource = await budget.metadataGet(key, "token", token);
  const backPoolAddresses = (backPools.decoded || []).map(addressFromBytes);
  const backTokenAddress = addressFromBytes(backToken.decoded);
  const reciprocal = supported.ok && supported.decoded.includes(ETH_SELECTOR)
    && backPoolAddresses.length === 1 && backPoolAddresses[0]?.toLowerCase() === ETH_POOL.toLowerCase()
    && backTokenAddress?.toLowerCase() === ETH_TOKEN.toLowerCase();
  const identity = poolToken.ok && poolToken.decoded.toLowerCase() === token.toLowerCase()
    && poolDecimals.ok && decimals.ok && poolDecimals.decoded === decimals.decoded;
  base.topologyComplete = Boolean(poolCode.ok && hasCode(poolCode.result) && tokenCode.ok && hasCode(tokenCode.result) && typeAndVersion.ok && reciprocal && identity && chain.pin.terminalSameHash === false);
  base.pool = { address: pool, runtime: codeInfo(poolCode.result), typeAndVersion, token: poolToken, tokenDecimals: poolDecimals, owner: poolOwner, supportedChains: supported, backPools, backPoolAddresses, backToken, backTokenAddress, sourceRuntimeEquivalence: poolSource.fullMatch ? true : null, sourceMetadata: poolSource };
  base.token = { address: token, runtime: codeInfo(tokenCode.result), decimals, totalSupply: supply, symbol, name, owner: tokenOwner, typeAndVersion: tokenType, minters, burners, isMinter, isBurner, sourceRuntimeEquivalence: tokenSource.fullMatch ? true : null, sourceMetadata: tokenSource };
  base.sourceRuntimeComplete = poolSource.fullMatch && tokenSource.fullMatch;
  if (!reciprocal) base.coverageGaps.push("reciprocal Ethereum pool/token route not exact");
  if (!identity) base.coverageGaps.push("counterpart pool/token identity or decimals mismatch");
  if (!typeAndVersion.ok) base.coverageGaps.push("counterpart pool typeAndVersion unavailable");
  if (!base.sourceRuntimeComplete) base.coverageGaps.push("counterpart pool/token source-runtime equivalence incomplete");
  const currentExclusiveMinter = minters.ok && minters.decoded.length === 1 && minters.decoded[0].toLowerCase() === pool.toLowerCase() && isMinter.ok && isMinter.decoded === true;
  const poolBurner = burners.ok && burners.decoded.some((x) => x.toLowerCase() === pool.toLowerCase()) && isBurner.ok && isBurner.decoded === true;
  base.authority = {
    poolTypeBurnMint: typeAndVersion.ok && /Burn.*Mint|BurnMint/i.test(typeAndVersion.decoded),
    currentExclusiveMinter,
    poolBurner,
    alternateCurrentMinters: minters.ok ? minters.decoded.filter((x) => x.toLowerCase() !== pool.toLowerCase()) : null,
    historicalMintProvenanceComplete: false,
    migrationOrRemovedMinterHistoryScanned: false,
    totalSupplyAttributableToCcip: false,
    reason: "No history scan: current minter enumeration cannot exclude prior/removed minters, migration, premint, or alternate bridge provenance.",
  };
  if (supply.ok && decimals.ok) base.unknownSupplyRaw = supply.decoded;
  base.coverageGaps.push("token totalSupply is not CCIP-attributable without exclusive historical mint provenance");
  return base;
}

async function run() {
  if (fs.existsSync(abs(CAPTURE))) throw new Error(`immutable run-once capture already exists: ${CAPTURE}`);
  const startedAt = new Date().toISOString();
  const budget = new Budget();
  const priorManifest = json(PRIOR_MANIFEST);
  const priorRaw = json(PRIOR_RAW);
  if (priorManifest.revision !== PRIOR_EXPECTED_REVISION || priorManifest.aggregateSha256 !== PRIOR_EXPECTED_AGGREGATE) throw new Error("prior r2 manifest binding failed");
  if (priorRaw.revision !== PRIOR_EXPECTED_REVISION || priorRaw.source?.localExactBuildEquivalence !== true || priorRaw.source?.callOrderExact !== true) throw new Error("prior r2 exact-build semantics unavailable");
  const priorBinding = {
    manifestPath: PRIOR_MANIFEST,
    manifestBytes: read(PRIOR_MANIFEST).length,
    manifestSha256: sha256(read(PRIOR_MANIFEST)),
    manifestAggregateSha256: priorManifest.aggregateSha256,
    rawPath: PRIOR_RAW,
    rawBytes: read(PRIOR_RAW).length,
    rawSha256: sha256(read(PRIOR_RAW)),
    revision: priorRaw.revision,
    localExactBuildEquivalence: priorRaw.source.localExactBuildEquivalence,
    callOrderExact: priorRaw.source.callOrderExact,
    acceptLiquidity: false,
  };
  const ethereum = await ethereumInventory(budget);
  const selectors = ethereum.supportedSelectors || [];
  const mappingRows = bindMappings(selectors);
  const routeCount = ethereum.routes.reduce((n, row) => n + Math.max(1, row.remotePoolAddresses.length), 0);
  const coverageGaps = [];
  if (selectors.length > MAX_ROUTES || routeCount > MAX_ROUTES) coverageGaps.push(`route cap exceeded selectors=${selectors.length} poolRoutes=${routeCount} cap=${MAX_ROUTES}`);
  for (const row of mappingRows) {
    if (!row.resolved) coverageGaps.push(`selector ${row.selector}: ${row.coverageGap}`);
    else if (!row.evm) coverageGaps.push(`selector ${row.selector}: non-EVM route`);
  }
  const counterpartRoutes = [];
  const chainPins = {};
  if (!coverageGaps.some((x) => x.startsWith("route cap exceeded"))) {
    for (const route of ethereum.routes) {
      const mapping = mappingRows.find((x) => x.selector === route.selector);
      if (!mapping?.resolved || !mapping.evm) continue;
      const result = await counterpartRoute(budget, route, mapping, chainPins);
      counterpartRoutes.push(result);
    }
  }
  for (const [key, pin] of Object.entries(chainPins)) {
    if (pin.reached) await terminalPin(budget, key, pin.pin);
  }
  for (const row of counterpartRoutes) {
    if (row.chainPin.reached) {
      row.chainPin = chainPins[row.chain.key];
      row.topologyComplete = row.topologyComplete && row.chainPin.pin.terminalSameHash;
      if (!row.chainPin.pin.terminalSameHash) row.coverageGaps.push("terminal same-number hash recheck failed");
    }
    for (const gap of row.coverageGaps) coverageGaps.push(`${row.chain.name}/${row.selector}: ${gap}`);
  }
  if (ethereum.coverageGap) coverageGaps.push(`Ethereum: ${ethereum.coverageGap}`);
  const capture = {
    startedAt,
    completedAt: new Date().toISOString(),
    runner: "tools/run-critical-ccip-syrupusdt-backing-network.js",
    scope: "Ethereum syrupUSDT LockRelease global backing/liability conservation across every currently returned supported selector",
    caps: { maxRpcReads: MAX_RPC, maxMetadataRequests: MAX_METADATA, maxRoutes: MAX_ROUTES, maxConfiguredEvmCounterpartChains: 8 },
    safety: { readOnly: true, endpointInventoriesRead: false, envFilesRead: false, endpointValuesDomainsTokensHeadersStored: false, transactions: false, signing: false, broadcast: false, fork: false, stateOverride: false, historyScan: false },
    priorAuthorizationBinding: priorBinding,
    ethereum,
    selectorMappings: mappingRows,
    routeCount,
    counterpartRoutes,
    coverageGaps: [...new Set(coverageGaps)],
    requestCounts: { jsonRpc: budget.rpc, metadata: budget.metadata },
    rpcTranscript: budget.rpcTranscript,
    metadataTranscript: budget.metadataTranscript,
  };
  fs.mkdirSync(path.dirname(abs(CAPTURE)), { recursive: true });
  fs.writeFileSync(abs(CAPTURE), `${JSON.stringify(capture, null, 2)}\n`, "utf8");
  console.log(`network-run-once complete selectors=${selectors.length} routes=${routeCount} counterparts=${counterpartRoutes.length} rpc=${budget.rpc}/${MAX_RPC} metadata=${budget.metadata}/${MAX_METADATA} gaps=${capture.coverageGaps.length}`);
}

function selfTest() {
  if (POOL.getFunction("getRemotePools").selector.toLowerCase() !== id("getRemotePools(uint64)").slice(0, 10).toLowerCase()) throw new Error("pool ABI selector mismatch");
  if (Object.keys(MAPPINGS).length !== 4 || Object.values(MAPPINGS).some((x) => !x.evm)) throw new Error("mapping inventory invariant failed");
  if (addressFromBytes(`0x${"0".repeat(24)}${ETH_POOL.slice(2)}`) !== ETH_POOL || addressFromBytes(ETH_POOL) !== ETH_POOL) throw new Error("remote address decoder failed");
  const priorManifest = json(PRIOR_MANIFEST);
  const priorRaw = json(PRIOR_RAW);
  if (priorManifest.revision !== PRIOR_EXPECTED_REVISION || priorManifest.aggregateSha256 !== PRIOR_EXPECTED_AGGREGATE || priorRaw.source?.localExactBuildEquivalence !== true) throw new Error("prior artifact binding self-test failed");
  const mappingRows = bindMappings(Object.keys(MAPPINGS));
  if (mappingRows.some((x) => !x.resolved)) throw new Error("mapping provenance self-test failed");
  console.log(`runner self-test PASS mappings=${mappingRows.length} prior=${PRIOR_EXPECTED_REVISION}/${PRIOR_EXPECTED_AGGREGATE} caps=${MAX_RPC}/${MAX_METADATA}/${MAX_ROUTES}`);
}

const mode = process.argv[2];
if (mode === "--self-test") selfTest();
else if (mode === "--run-once") run().catch((error) => { console.error(`runner failed: ${safe(error?.message || error)}`); process.exitCode = 1; });
else throw new Error("mode required: --self-test or --run-once");
