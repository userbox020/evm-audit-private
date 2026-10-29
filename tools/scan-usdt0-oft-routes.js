#!/usr/bin/env node
// Read-only USDT0 LayerZero OFT/OFTAdapter inventory and route config probe.
// RPC URLs are read in memory only and are never printed or written.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "usdt0-oft-routes.json");
const DEPLOYMENTS_URL = process.env.USDT0_DEPLOYMENTS_URL || "https://docs.usdt0.to/api/deployments";
const FETCH_TIMEOUT_MS = Number(process.env.USDT0_FETCH_TIMEOUT_MS || "15000");
const RPC_TIMEOUT_MS = Number(process.env.USDT0_RPC_TIMEOUT_MS || "10000");
const ROUTE_CONFIG_LIMIT = Number(process.env.USDT0_ROUTE_CONFIG_LIMIT || "0");
const SKIP_ROUTE_CONFIGS = process.env.USDT0_SKIP_ROUTE_CONFIGS === "1";

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ZERO32 = `0x${"0".repeat(64)}`;

const SELECTORS = {
  endpoint: "0x5e280f11",
  owner: "0x8da5cb5b",
  token: "0xfc0c546a",
  approvalRequired: "0x9f68b964",
  sharedDecimals: "0x857749b0",
  decimalConversionRate: "0x963efcaa",
  peers: "0xbb0b6a53",
  isPeer: "0x5a0dfe4d",
  oAppVersion: "0x17442b70",
  oftVersion: "0x156a0d0f",
  enforcedOptions: "0x5535d461",
  msgInspector: "0x111ecdad",
  preCrime: "0xb731ea0a",
  eid: "0x416ecebf",
  delegates: "0x587cde1e",
  getSendLibrary: "0xb96a277f",
  getReceiveLibrary: "0x402f8468",
  isDefaultSendLibrary: "0xdc93c8a2",
  isValidReceiveLibrary: "0x9d7f9775",
  receiveLibraryTimeout: "0xef667aa1",
  getConfig: "0x2b3197b9",
  lzToken: "0xe4fe1d94",
  balanceOf: "0x70a08231",
  symbol: "0x95d89b41",
  name: "0x06fdde03",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
};

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function normalizeAddress(value) {
  if (!EVM_ADDRESS_RE.test(String(value || ""))) return null;
  return `0x${strip0x(value).toLowerCase()}`;
}

function sameAddress(a, b) {
  const aa = normalizeAddress(a);
  const bb = normalizeAddress(b);
  return Boolean(aa && bb && aa === bb);
}

function encodeUint(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function encodeAddress(value) {
  return strip0x(value).toLowerCase().padStart(64, "0");
}

function encodeBytes32Address(value) {
  const address = normalizeAddress(value);
  if (!address) return null;
  return `0x${strip0x(address).padStart(64, "0")}`.toLowerCase();
}

function word(hex, index) {
  const clean = strip0x(hex);
  return clean.slice(index * 64, index * 64 + 64);
}

function decodeUint(raw) {
  if (!raw || raw === "0x") return null;
  try {
    return BigInt(raw).toString();
  } catch (_) {
    return null;
  }
}

function decodeNumber(raw) {
  const value = decodeUint(raw);
  if (value === null) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function decodeBool(raw) {
  const value = decodeUint(raw);
  if (value === null) return null;
  return BigInt(value) !== 0n;
}

function decodeAddress(raw) {
  if (!raw || raw === "0x") return null;
  const clean = strip0x(raw).padStart(64, "0");
  if (/^0+$/.test(clean)) return null;
  return normalizeAddress(`0x${clean.slice(-40)}`);
}

function decodeBytes32(raw) {
  if (!raw || raw === "0x") return null;
  const clean = strip0x(raw).padStart(64, "0");
  return `0x${clean.slice(0, 64)}`.toLowerCase();
}

function decodeString(raw) {
  if (!raw || raw === "0x") return null;
  try {
    const hex = strip0x(raw);
    if (hex.length === 64) {
      const text = Buffer.from(hex, "hex").toString("utf8").replace(/\0+$/g, "").trim();
      return text || null;
    }
    const offset = Number(BigInt(`0x${hex.slice(0, 64)}`));
    const lenStart = offset * 2;
    const len = Number(BigInt(`0x${hex.slice(lenStart, lenStart + 64)}`));
    if (!Number.isFinite(len) || len < 0 || len > 2048) return null;
    return Buffer.from(hex.slice(lenStart + 64, lenStart + 64 + len * 2), "hex").toString("utf8").replace(/\0/g, "").trim() || null;
  } catch (_) {
    return null;
  }
}

function decodeAddressBool(raw) {
  if (!raw || raw === "0x") return { address: null, flag: null };
  return {
    address: decodeAddress(`0x${word(raw, 0)}`),
    flag: decodeBool(`0x${word(raw, 1)}`),
  };
}

function decodeAddressUint(raw) {
  if (!raw || raw === "0x") return { address: null, value: null };
  return {
    address: decodeAddress(`0x${word(raw, 0)}`),
    value: decodeUint(`0x${word(raw, 1)}`),
  };
}

function decodeAbiBytes(raw) {
  if (!raw || raw === "0x") return null;
  try {
    const hex = strip0x(raw);
    if (hex.length < 128) return null;
    const offset = Number(BigInt(`0x${hex.slice(0, 64)}`));
    const lenStart = offset * 2;
    const len = Number(BigInt(`0x${hex.slice(lenStart, lenStart + 64)}`));
    if (!Number.isFinite(len) || len < 0 || len > 100000) return null;
    return `0x${hex.slice(lenStart + 64, lenStart + 64 + len * 2)}`;
  } catch (_) {
    return null;
  }
}

function sha256Hex(hex) {
  if (!hex || hex === "0x") return null;
  return crypto.createHash("sha256").update(Buffer.from(strip0x(hex), "hex")).digest("hex");
}

function humanAmount(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try {
    const value = BigInt(raw);
    const d = Number(decimals);
    if (!Number.isFinite(d) || d < 0 || d > 77) return null;
    const scale = 10n ** BigInt(d);
    const whole = value / scale;
    const frac = value % scale;
    const fracText = frac.toString().padStart(d, "0").slice(0, 8).replace(/0+$/g, "");
    return `${whole.toString()}${fracText ? "." + fracText : ""}`;
  } catch (_) {
    return null;
  }
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error("rpc error");
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function ethCall(rpc, to, data) {
  if (!rpc || !EVM_ADDRESS_RE.test(String(to || ""))) return null;
  try {
    return await rpcCall(rpc, "eth_call", [{ to, data }, "latest"]);
  } catch (_) {
    return null;
  }
}

async function getCode(rpc, address) {
  try {
    const code = await rpcCall(rpc, "eth_getCode", [address, "latest"]);
    return code && code !== "0x" ? code : null;
  } catch (_) {
    return null;
  }
}

async function resolveRpcPool(chainIds) {
  const wanted = new Set(chainIds.map(Number));
  const pool = {};
  for (const url of loadRpcUrls()) {
    try {
      const chainIdHex = await rpcCall(url, "eth_chainId", [], 5000);
      const chainId = Number(BigInt(chainIdHex));
      if (wanted.has(chainId) && !pool[chainId]) pool[chainId] = url;
      if (Object.keys(pool).length >= wanted.size) break;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return pool;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "user-agent": "opencode-usdt0-readonly-scanner" }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function contractByName(contracts, names) {
  const set = new Set(names.map((x) => x.toLowerCase()));
  return (contracts || []).find((contract) => set.has(String(contract.name || "").toLowerCase())) || null;
}

function flattenDeployments(registry) {
  const groups = [];
  for (const group of ["native", "legacyMesh"]) {
    for (const row of registry?.usdt0?.[group] || []) {
      if (!row.chainId || !row.lzEid) continue;
      const oapp = contractByName(row.contracts, ["OFT Adapter", "OFT"]);
      const token = contractByName(row.contracts, ["Token"]);
      const safe = contractByName(row.contracts, ["Safe"]);
      const composer = contractByName(row.contracts, ["MultiHop Composer", "Composer", "HyperCore Composer", "TempoOFTWrapper"]);
      if (!oapp || !EVM_ADDRESS_RE.test(oapp.address || "")) continue;
      groups.push({
        group,
        name: row.name,
        chainId: Number(row.chainId),
        lzEid: Number(row.lzEid),
        isSource: Boolean(row.isSource),
        oappName: oapp.name,
        oapp: oapp.address,
        token: token?.address || null,
        safe: safe?.address || null,
        composer: composer?.address || null,
        explorer: oapp.explorer || null,
      });
    }
  }
  return groups;
}

async function readErc20(rpc, token, holder = null) {
  if (!rpc || !EVM_ADDRESS_RE.test(String(token || ""))) return null;
  const [code, nameRaw, symbolRaw, decimalsRaw, supplyRaw, balanceRaw] = await Promise.all([
    getCode(rpc, token),
    ethCall(rpc, token, SELECTORS.name),
    ethCall(rpc, token, SELECTORS.symbol),
    ethCall(rpc, token, SELECTORS.decimals),
    ethCall(rpc, token, SELECTORS.totalSupply),
    holder && EVM_ADDRESS_RE.test(holder) ? ethCall(rpc, token, SELECTORS.balanceOf + encodeAddress(holder)) : Promise.resolve(null),
  ]);
  const decimals = decodeNumber(decimalsRaw);
  const supply = decodeUint(supplyRaw);
  const balance = decodeUint(balanceRaw);
  return {
    codePresent: Boolean(code),
    codeBytes: code ? strip0x(code).length / 2 : 0,
    name: decodeString(nameRaw),
    symbol: decodeString(symbolRaw),
    decimals,
    totalSupplyRaw: supply,
    totalSupply: humanAmount(supply, decimals),
    holderBalanceRaw: balance,
    holderBalance: humanAmount(balance, decimals),
  };
}

function decodeUlnConfig(configBytes) {
  if (!configBytes || configBytes === "0x") return null;
  try {
    const hex = strip0x(configBytes);
    if (hex.length < 64 * 6) return null;
    const hasTopLevelOffset = BigInt(`0x${word(hex, 0)}`) === 32n && hex.length >= 64 * 7;
    const baseWord = hasTopLevelOffset ? 1 : 0;
    const baseByteOffset = hasTopLevelOffset ? 32 : 0;
    const confirmations = decodeUint(`0x${word(hex, baseWord)}`);
    const requiredDVNCount = decodeNumber(`0x${word(hex, baseWord + 1)}`);
    const optionalDVNCount = decodeNumber(`0x${word(hex, baseWord + 2)}`);
    const optionalDVNThreshold = decodeNumber(`0x${word(hex, baseWord + 3)}`);
    const requiredOffset = Number(BigInt(`0x${word(hex, baseWord + 4)}`));
    const optionalOffset = Number(BigInt(`0x${word(hex, baseWord + 5)}`));
    const readAddressArray = (offset) => {
      const start = (baseByteOffset + offset) * 2;
      if (start < 0 || start + 64 > hex.length) return null;
      const len = Number(BigInt(`0x${hex.slice(start, start + 64)}`));
      if (!Number.isFinite(len) || len < 0 || len > 64) return null;
      const out = [];
      for (let i = 0; i < len; i++) out.push(decodeAddress(`0x${hex.slice(start + 64 + i * 64, start + 128 + i * 64)}`));
      return out.filter(Boolean);
    };
    const requiredDVNs = readAddressArray(requiredOffset);
    const optionalDVNs = readAddressArray(optionalOffset);
    if (!requiredDVNs || !optionalDVNs) return null;
    return { confirmations, requiredDVNCount, optionalDVNCount, optionalDVNThreshold, requiredDVNs, optionalDVNs };
  } catch (_) {
    return null;
  }
}

function decodeExecutorConfig(configBytes) {
  if (!configBytes || configBytes === "0x") return null;
  try {
    const hex = strip0x(configBytes);
    if (hex.length < 128) return null;
    return {
      maxMessageSize: decodeUint(`0x${word(hex, 0)}`),
      executor: decodeAddress(`0x${word(hex, 1)}`),
    };
  } catch (_) {
    return null;
  }
}

function configSummary(raw, decoder) {
  const bytes = decodeAbiBytes(raw);
  return {
    present: Boolean(bytes && bytes !== "0x"),
    bytesLength: bytes ? strip0x(bytes).length / 2 : 0,
    sha256: sha256Hex(bytes),
    decoded: bytes ? decoder(bytes) : null,
  };
}

function weakDvnHint(decoded) {
  if (!decoded) return null;
  const required = Number(decoded.requiredDVNCount ?? decoded.requiredDVNs?.length ?? 0);
  const threshold = Number(decoded.optionalDVNThreshold ?? 0);
  const effective = required + threshold;
  if (effective <= 0) return "zero-effective-dvn";
  if (effective === 1) return "single-effective-dvn";
  return null;
}

async function getEndpointConfig(rpc, endpoint, local, remote) {
  const localOapp = local.oapp;
  const remoteEid = remote.lzEid;
  const remotePeer = encodeBytes32Address(remote.oapp);
  const sendLibRaw = await ethCall(rpc, endpoint, SELECTORS.getSendLibrary + encodeAddress(localOapp) + encodeUint(remoteEid));
  const receiveLibRaw = await ethCall(rpc, endpoint, SELECTORS.getReceiveLibrary + encodeAddress(localOapp) + encodeUint(remoteEid));
  const sendLib = decodeAddress(sendLibRaw);
  const receiveLibTuple = decodeAddressBool(receiveLibRaw);
  const receiveLib = receiveLibTuple.address;
  const [isDefaultSendRaw, receiveTimeoutRaw, isValidReceiveRaw, sendUlnRaw, receiveUlnRaw, executorRaw, enforcedSendRaw] = await Promise.all([
    ethCall(rpc, endpoint, SELECTORS.isDefaultSendLibrary + encodeAddress(localOapp) + encodeUint(remoteEid)),
    ethCall(rpc, endpoint, SELECTORS.receiveLibraryTimeout + encodeAddress(localOapp) + encodeUint(remoteEid)),
    receiveLib ? ethCall(rpc, endpoint, SELECTORS.isValidReceiveLibrary + encodeAddress(localOapp) + encodeUint(remoteEid) + encodeAddress(receiveLib)) : Promise.resolve(null),
    sendLib ? ethCall(rpc, endpoint, SELECTORS.getConfig + encodeAddress(localOapp) + encodeAddress(sendLib) + encodeUint(remoteEid) + encodeUint(2)) : Promise.resolve(null),
    receiveLib ? ethCall(rpc, endpoint, SELECTORS.getConfig + encodeAddress(localOapp) + encodeAddress(receiveLib) + encodeUint(remoteEid) + encodeUint(2)) : Promise.resolve(null),
    sendLib ? ethCall(rpc, endpoint, SELECTORS.getConfig + encodeAddress(localOapp) + encodeAddress(sendLib) + encodeUint(remoteEid) + encodeUint(1)) : Promise.resolve(null),
    ethCall(rpc, localOapp, SELECTORS.enforcedOptions + encodeUint(remoteEid) + encodeUint(1)),
  ]);
  const receiveTimeout = decodeAddressUint(receiveTimeoutRaw);
  const sendUln = configSummary(sendUlnRaw, decodeUlnConfig);
  const receiveUln = configSummary(receiveUlnRaw, decodeUlnConfig);
  const executor = configSummary(executorRaw, decodeExecutorConfig);
  return {
    remote: remote.name,
    remoteChainId: remote.chainId,
    remoteLzEid: remoteEid,
    expectedPeer: remotePeer,
    sendLibrary: sendLib,
    receiveLibrary: receiveLib,
    receiveLibraryIsDefault: receiveLibTuple.flag,
    isDefaultSendLibrary: decodeBool(isDefaultSendRaw),
    isValidReceiveLibrary: decodeBool(isValidReceiveRaw),
    receiveLibraryTimeout: receiveTimeout,
    enforcedSendOptionsBytes: enforcedSendRaw && enforcedSendRaw !== "0x" ? strip0x(decodeAbiBytes(enforcedSendRaw) || enforcedSendRaw).length / 2 : 0,
    sendUln,
    receiveUln,
    executor,
    weakDvnHints: [weakDvnHint(sendUln.decoded), weakDvnHint(receiveUln.decoded)].filter(Boolean),
  };
}

async function scanRow(row, rows, rpc, rpcResolvedRows) {
  const oapp = row.oapp;
  const code = await getCode(rpc, oapp);
  const [endpointRaw, ownerRaw, tokenRaw, approvalRaw, sharedDecimalsRaw, rateRaw, oAppVersionRaw, oftVersionRaw, inspectorRaw, preCrimeRaw] = await Promise.all([
    ethCall(rpc, oapp, SELECTORS.endpoint),
    ethCall(rpc, oapp, SELECTORS.owner),
    ethCall(rpc, oapp, SELECTORS.token),
    ethCall(rpc, oapp, SELECTORS.approvalRequired),
    ethCall(rpc, oapp, SELECTORS.sharedDecimals),
    ethCall(rpc, oapp, SELECTORS.decimalConversionRate),
    ethCall(rpc, oapp, SELECTORS.oAppVersion),
    ethCall(rpc, oapp, SELECTORS.oftVersion),
    ethCall(rpc, oapp, SELECTORS.msgInspector),
    ethCall(rpc, oapp, SELECTORS.preCrime),
  ]);
  const endpoint = decodeAddress(endpointRaw);
  const adapterToken = decodeAddress(tokenRaw);
  const tokenAddress = adapterToken || row.token || null;
  const [tokenMeta, escrowTokenMeta, endpointCode, endpointEidRaw, lzTokenRaw, delegateRaw] = await Promise.all([
    tokenAddress ? readErc20(rpc, tokenAddress, null) : Promise.resolve(null),
    adapterToken ? readErc20(rpc, adapterToken, oapp) : Promise.resolve(null),
    endpoint ? getCode(rpc, endpoint) : Promise.resolve(null),
    endpoint ? ethCall(rpc, endpoint, SELECTORS.eid) : Promise.resolve(null),
    endpoint ? ethCall(rpc, endpoint, SELECTORS.lzToken) : Promise.resolve(null),
    endpoint ? ethCall(rpc, endpoint, SELECTORS.delegates + encodeAddress(oapp)) : Promise.resolve(null),
  ]);

  const peers = [];
  for (const remote of rows.filter((candidate) => candidate.group === row.group && candidate.lzEid !== row.lzEid)) {
    const expectedPeer = encodeBytes32Address(remote.oapp);
    const raw = await ethCall(rpc, oapp, SELECTORS.peers + encodeUint(remote.lzEid));
    const actualPeer = decodeBytes32(raw);
    peers.push({
      remote: remote.name,
      remoteChainId: remote.chainId,
      remoteLzEid: remote.lzEid,
      expectedPeer,
      actualPeer,
      matchesExpected: Boolean(expectedPeer && actualPeer && expectedPeer === actualPeer),
      missing: !actualPeer || actualPeer === ZERO32,
    });
  }

  const routeConfigs = [];
  const routeRemotes = rpcResolvedRows.filter((remote) => remote.group === row.group && remote.lzEid !== row.lzEid);
  const limitedRemotes = ROUTE_CONFIG_LIMIT > 0 ? routeRemotes.slice(0, ROUTE_CONFIG_LIMIT) : routeRemotes;
  if (!SKIP_ROUTE_CONFIGS && endpoint) {
    for (const remote of limitedRemotes) routeConfigs.push(await getEndpointConfig(rpc, endpoint, row, remote));
  }

  const endpointEid = decodeNumber(endpointEidRaw);
  const peerMismatches = peers.filter((peer) => !peer.missing && !peer.matchesExpected);
  const peerMissing = peers.filter((peer) => peer.missing);
  const weakRouteConfigs = routeConfigs.filter((route) => route.weakDvnHints.length > 0);
  const endpointEidMatches = endpointEid === row.lzEid;
  const issues = [];
  if (!code) issues.push("oapp-no-code");
  if (endpoint && !endpointCode) issues.push("endpoint-no-code");
  if (endpointEid !== null && !endpointEidMatches) issues.push("endpoint-eid-mismatch");
  if (peerMismatches.length > 0) issues.push("peer-mismatch");
  if (weakRouteConfigs.length > 0) issues.push("weak-dvn-config-hint");

  return {
    docs: row,
    rpcResolved: true,
    oapp: {
      address: oapp,
      codePresent: Boolean(code),
      codeBytes: code ? strip0x(code).length / 2 : 0,
      endpoint,
      owner: decodeAddress(ownerRaw),
      token: adapterToken,
      approvalRequired: decodeBool(approvalRaw),
      sharedDecimals: decodeUint(sharedDecimalsRaw),
      decimalConversionRate: decodeUint(rateRaw),
      oAppVersionRaw,
      oftVersionRaw,
      msgInspector: decodeAddress(inspectorRaw),
      preCrime: decodeAddress(preCrimeRaw),
    },
    token: tokenAddress ? { address: tokenAddress, ...tokenMeta } : null,
    escrowToken: adapterToken ? { address: adapterToken, balanceHolder: oapp, ...escrowTokenMeta } : null,
    endpoint: endpoint
      ? {
          address: endpoint,
          codePresent: Boolean(endpointCode),
          codeBytes: endpointCode ? strip0x(endpointCode).length / 2 : 0,
          eid: endpointEid,
          eidMatchesDocs: endpointEidMatches,
          lzToken: decodeAddress(lzTokenRaw),
          delegate: decodeAddress(delegateRaw),
        }
      : null,
    peers,
    routeConfigs,
    issueSummary: {
      issues,
      peerMismatches: peerMismatches.length,
      peerMissing: peerMissing.length,
      weakRouteConfigs: weakRouteConfigs.length,
    },
    routePositive: false,
  };
}

function bigintSum(values) {
  let total = 0n;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    try {
      total += BigInt(value);
    } catch (_) {
      // skip malformed values
    }
  }
  return total.toString();
}

async function main() {
  ensureDir(OUT);
  const registry = await fetchJson(DEPLOYMENTS_URL);
  const rows = flattenDeployments(registry);
  const rpcPool = await resolveRpcPool([...new Set(rows.map((row) => row.chainId))]);
  const rpcResolvedRows = rows.filter((row) => rpcPool[row.chainId]);
  const scans = [];
  for (const row of rows) {
    const rpc = rpcPool[row.chainId];
    if (!rpc) {
      scans.push({ docs: row, rpcResolved: false, routePositive: false });
      continue;
    }
    scans.push(await scanRow(row, rows, rpc, rpcResolvedRows));
  }

  const sourceRows = scans.filter((scan) => scan.rpcResolved && scan.docs?.isSource && scan.escrowToken?.holderBalanceRaw);
  const scannedRemoteSupplies = scans
    .filter((scan) => scan.rpcResolved && !scan.docs?.isSource && scan.docs?.group === "native" && scan.token?.totalSupplyRaw)
    .map((scan) => scan.token.totalSupplyRaw);
  const nativeRemoteSupplyRaw = bigintSum(scannedRemoteSupplies);
  const sourceEscrowRaw = bigintSum(sourceRows.map((scan) => scan.escrowToken.holderBalanceRaw));
  const sourceDecimals = sourceRows.find((scan) => scan.escrowToken?.decimals !== null)?.escrowToken?.decimals ?? 6;
  const supplyEscrowCheck = {
    sourceEscrowRaw,
    sourceEscrow: humanAmount(sourceEscrowRaw, sourceDecimals),
    scannedNativeRemoteSupplyRaw: nativeRemoteSupplyRaw,
    scannedNativeRemoteSupply: humanAmount(nativeRemoteSupplyRaw, sourceDecimals),
    scannedRemoteSupplyExceedsSourceEscrow: BigInt(nativeRemoteSupplyRaw || "0") > BigInt(sourceEscrowRaw || "0"),
    note: "Compares only scanned EVM native remote token supplies against scanned source escrow balances; unscanned chains and legacy mesh are excluded.",
  };

  const peerChecks = scans.flatMap((scan) => scan.peers || []);
  const routeConfigs = scans.flatMap((scan) => scan.routeConfigs || []);
  const reviewCandidates = scans.filter((scan) => scan.issueSummary?.issues?.length > 0);
  const routePositive = supplyEscrowCheck.scannedRemoteSupplyExceedsSourceEscrow ? 1 : 0;
  const out = {
    generatedAt: new Date().toISOString(),
    scope: "Read-only USDT0 LayerZero OFT/OFTAdapter route inventory",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    sources: [DEPLOYMENTS_URL, "https://docs.usdt0.to/technical-documentation/deployments", "https://docs.usdt0.to/technical-documentation/security"],
    summary: {
      docsRows: rows.length,
      nativeRows: rows.filter((row) => row.group === "native").length,
      legacyMeshRows: rows.filter((row) => row.group === "legacyMesh").length,
      rpcResolvedRows: rpcResolvedRows.length,
      scannedRows: scans.filter((scan) => scan.rpcResolved).length,
      codePresentRows: scans.filter((scan) => scan.oapp?.codePresent).length,
      endpointEidMismatches: scans.filter((scan) => scan.endpoint && scan.endpoint.eidMatchesDocs === false).length,
      peerChecks: peerChecks.length,
      peerMissing: peerChecks.filter((peer) => peer.missing).length,
      peerMismatches: peerChecks.filter((peer) => !peer.missing && !peer.matchesExpected).length,
      routeConfigChecks: routeConfigs.length,
      weakDvnConfigHints: routeConfigs.filter((route) => route.weakDvnHints?.length > 0).length,
      reviewCandidates: reviewCandidates.length,
      routePositive,
      signedActionJustified: false,
    },
    supplyEscrowCheck,
    scans,
    routePositiveCriteria: [
      "Documented OApp has code on both route endpoints",
      "Reciprocal peers match documented remote OApp addresses",
      "Endpoint EID and libraries match the documented chain/EID",
      "ULN/DVN config is decodable and not weak for a high-value route",
      "Source escrow and remote minted supply show a material mismatch",
      "A lending/DEX consumer route can extract value after gas and slippage",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`USDT0 OFT scan: rows=${out.summary.docsRows} scanned=${out.summary.scannedRows} peerMissing=${out.summary.peerMissing} peerMismatch=${out.summary.peerMismatches} weakDvn=${out.summary.weakDvnConfigHints} routePositive=${out.summary.routePositive}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(`USDT0 OFT scan failed: ${err.message}`);
  process.exitCode = 1;
});
