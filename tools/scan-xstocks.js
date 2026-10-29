#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AbiCoder, id, getAddress } = require("ethers");

const WORKSPACE = path.join(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "xstocks-live.json");
const RPC_TIMEOUT_MS = 20_000;
const API_BASE = "https://api.xstocks.fi/api/v2";
const ADAPTER_URL = "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/xstocks/index.js";

const ABI = AbiCoder.defaultAbiCoder();
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const METAPLEX_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const PDA_MARKER = Buffer.from("ProgramDerivedAddress");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ED25519_P = (1n << 255n) - 19n;
const ED25519_D = mod(-121665n * modInv(121666n), ED25519_P);

const CHAINS = {
  arbitrum: { chainId: 42161, apiNetwork: "Arbitrum", llamaKey: "arbitrum-one", fallbacks: ["https://arb1.arbitrum.io/rpc"] },
};

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const ROLE_CONSTANTS = [
  "DEFAULT_ADMIN_ROLE()",
  "MINTER_ROLE()",
  "BURNER_ROLE()",
  "PAUSER_ROLE()",
  "REBASER_ROLE()",
  "REBASE_ROLE()",
  "MULTIPLIER_ROLE()",
  "BRIDGE_ROLE()",
  "CCIP_BRIDGE_ROLE()",
  "UPGRADER_ROLE()",
  "BLACKLISTER_ROLE()",
  "ORACLE_ROLE()",
];

const INTERESTING_SIGNATURES = [
  "mint(address,uint256)",
  "burn(uint256)",
  "burn(address,uint256)",
  "burnFrom(address,uint256)",
  "rebase(uint256)",
  "setMultiplier(uint256)",
  "updateMultiplier(uint256)",
  "pause()",
  "unpause()",
  "paused()",
  "owner()",
  "transferOwnership(address)",
  "hasRole(bytes32,address)",
  "grantRole(bytes32,address)",
  "revokeRole(bytes32,address)",
  "setBridge(address)",
  "bridgeMint(address,uint256)",
  "bridgeBurn(address,uint256)",
  "blacklist(address)",
  "unBlacklist(address)",
  "isBlacklisted(address)",
];

const MANAGEMENT_CALLS = {
  minter: ["minter()", ["address"]],
  burner: ["burner()", ["address"]],
  pauser: ["pauser()", ["address"]],
  multiplierUpdater: ["multiplierUpdater()", ["address"]],
  isPaused: ["isPaused()", ["bool"]],
  delegateMode: ["delegateMode()", ["bool"]],
  feePerPeriod: ["feePerPeriod()", ["uint256"]],
  periodLength: ["periodLength()", ["uint256"]],
  lastTimeFeeApplied: ["lastTimeFeeApplied()", ["uint256"]],
  lastMultiplier: ["lastMultiplier()", ["uint256"]],
  newMultiplier: ["newMultiplier()", ["uint256"]],
  newMultiplierActivationTime: ["newMultiplierActivationTime()", ["uint256"]],
};

const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";

const TOKEN_2022_EXTENSION_NAMES = {
  0: "Uninitialized",
  1: "TransferFeeConfig",
  2: "TransferFeeAmount",
  3: "MintCloseAuthority",
  4: "ConfidentialTransferMint",
  5: "ConfidentialTransferAccount",
  6: "DefaultAccountState",
  7: "ImmutableOwner",
  8: "MemoTransfer",
  9: "NonTransferable",
  10: "InterestBearingConfig",
  11: "CpiGuard",
  12: "PermanentDelegate",
  13: "NonTransferableAccount",
  14: "TransferHook",
  15: "TransferHookAccount",
  16: "ConfidentialTransferFeeConfig",
  17: "ConfidentialTransferFeeAmount",
  18: "MetadataPointer",
  19: "TokenMetadata",
  20: "GroupPointer",
  21: "TokenGroup",
  22: "GroupMemberPointer",
  23: "TokenGroupMember",
  24: "ConfidentialMintBurn",
  25: "ScaledUiAmountConfig",
  26: "Pausable",
  27: "PausableAccount",
};

function sanitize(text) {
  return String(text || "").replace(/https?:\/\/\S+/g, "[redacted-url]");
}

function selector(signature) {
  return id(signature).slice(0, 10);
}

function encodeCall(signature, args = [], values = []) {
  return selector(signature) + (args.length ? ABI.encode(args, values).slice(2) : "");
}

function decodeOne(data, types) {
  if (!data || data === "0x") return null;
  try {
    return ABI.decode(types, data)[0];
  } catch (_) {
    return null;
  }
}

function decodeString(data) {
  if (!data || data === "0x") return null;
  try {
    return String(ABI.decode(["string"], data)[0]);
  } catch (_) {
    const hex = String(data).replace(/^0x/i, "");
    if (hex.length === 64) return Buffer.from(hex, "hex").toString("utf8").replace(/\u0000+$/g, "") || null;
    return null;
  }
}

function isAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ""));
}

function normalizeAddress(value) {
  if (!isAddress(value)) return null;
  try {
    return getAddress(value);
  } catch (_) {
    return String(value).toLowerCase();
  }
}

function addressFromWord(word) {
  if (!word || word === "0x") return null;
  const hex = String(word).replace(/^0x/i, "").padStart(64, "0");
  const raw = "0x" + hex.slice(-40);
  if (/^0x0{40}$/i.test(raw)) return null;
  return normalizeAddress(raw);
}

function formatUnits(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = value % scale;
  const fracText = frac.toString().padStart(decimals, "0").replace(/0+$/g, "").slice(0, 12);
  return fracText ? `${whole}.${fracText}` : whole.toString();
}

function addBig(a, b) {
  return (BigInt(a || 0) + BigInt(b || 0)).toString();
}

function subBig(a, b) {
  return (BigInt(a || 0) - BigInt(b || 0)).toString();
}

function bigintCompareDesc(a, b) {
  const aa = BigInt(a || 0);
  const bb = BigInt(b || 0);
  return aa > bb ? -1 : aa < bb ? 1 : 0;
}

async function fetchText(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { "user-agent": "evm-audit-xstocks/1.0" }, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${sanitize(text.slice(0, 200))}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, timeoutMs = 20_000) {
  return JSON.parse(await fetchText(url, timeoutMs));
}

async function fetchPaged(pathname, pageSize = 100) {
  const nodes = [];
  let page = 0;
  let lastPage = null;
  while (true) {
    const sep = pathname.includes("?") ? "&" : "?";
    const json = await fetchJson(`${API_BASE}${pathname}${sep}page=${page}&pageSize=${pageSize}`);
    if (Array.isArray(json)) return json;
    if (Array.isArray(json.nodes)) nodes.push(...json.nodes);
    lastPage = json.page || null;
    if (!json.page || !json.page.hasNextPage) break;
    page += 1;
  }
  return { nodes, page: lastPage };
}

function extractAdapterData(adapterText) {
  const start = adapterText.indexOf("const data = ");
  if (start < 0) throw new Error("adapter data array not found");
  const arrayStart = adapterText.indexOf("[", start);
  const marker = "\n]\n\nconst chainMapping";
  const end = adapterText.indexOf(marker, arrayStart);
  if (arrayStart < 0 || end < 0) throw new Error("adapter data array end not found");
  return JSON.parse(adapterText.slice(arrayStart, end + 2));
}

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await response.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveEvmRpc(chainName) {
  const cfg = CHAINS[chainName];
  const candidates = [...extractRpcUrls(), ...(cfg.fallbacks || [])];
  const seen = new Set();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const chainId = Number(BigInt(await rpcCall(url, "eth_chainId", [], 5000)));
      if (chainId === cfg.chainId) return url;
    } catch (_) {
      // Never print or store RPC URLs.
    }
  }
  return null;
}

async function callOptional(rpc, to, data) {
  try {
    const result = await rpcCall(rpc, "eth_call", [{ to, data }, "latest"]);
    return result && result !== "0x" ? result : null;
  } catch (_) {
    return null;
  }
}

async function tokenMeta(rpc, address) {
  const [nameRaw, symbolRaw, decimalsRaw, totalSupplyRaw] = await Promise.all([
    callOptional(rpc, address, encodeCall("name()")),
    callOptional(rpc, address, encodeCall("symbol()")),
    callOptional(rpc, address, encodeCall("decimals()")),
    callOptional(rpc, address, encodeCall("totalSupply()")),
  ]);
  const decimals = decimalsRaw ? Number(decodeOne(decimalsRaw, ["uint8"]) ?? decodeOne(decimalsRaw, ["uint256"])) : null;
  const totalSupply = totalSupplyRaw ? decodeOne(totalSupplyRaw, ["uint256"]) : null;
  return {
    address,
    name: decodeString(nameRaw),
    symbol: decodeString(symbolRaw),
    decimals,
    totalSupplyRaw: totalSupply === null ? null : totalSupply.toString(),
    totalSupply: formatUnits(totalSupply, decimals),
  };
}

async function tokenBalance(rpc, token, account, decimals) {
  const raw = await callOptional(rpc, token, encodeCall("balanceOf(address)", ["address"], [account]));
  const value = raw ? decodeOne(raw, ["uint256"]) : null;
  return { raw: value === null ? null : value.toString(), formatted: formatUnits(value, decimals) };
}

function normalizeDecoded(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && isAddress(value)) return normalizeAddress(value);
  return value;
}

async function managementState(rpc, address) {
  const entries = await Promise.all(Object.entries(MANAGEMENT_CALLS).map(async ([key, [signature, types]]) => {
    const raw = await callOptional(rpc, address, encodeCall(signature));
    const decoded = raw ? decodeOne(raw, types) : null;
    return [key, normalizeDecoded(decoded)];
  }));
  const state = Object.fromEntries(entries);
  const currentRaw = await callOptional(rpc, address, encodeCall("getCurrentMultiplier()"));
  if (currentRaw) {
    try {
      const [currentMultiplier, periodsPassed, currentMultiplierNonce] = ABI.decode(["uint256", "uint256", "uint256"], currentRaw);
      state.currentMultiplier = currentMultiplier.toString();
      state.periodsPassed = periodsPassed.toString();
      state.currentMultiplierNonce = currentMultiplierNonce.toString();
    } catch (_) {
      state.currentMultiplier = null;
    }
  }
  return state;
}

async function stateProbe(rpc, token, signature, args = [], values = []) {
  try {
    const result = await rpcCall(rpc, "eth_call", [{ from: PROBE_FROM, to: token, data: encodeCall(signature, args, values) }, "latest"], 5000);
    return { success: true, result: result && result.length > 66 ? `${result.slice(0, 66)}...` : result };
  } catch (err) {
    return { success: false, error: sanitize(err.message || err).slice(0, 200) };
  }
}

async function permissionlessProbes(rpc, token, state) {
  const oldMultiplier = BigInt(state.lastMultiplier || state.currentMultiplier || "1000000000000000000");
  return {
    from: PROBE_FROM,
    mintOne: await stateProbe(rpc, token, "mint(address,uint256)", ["address", "uint256"], [PROBE_FROM, 1n]),
    burnOne: await stateProbe(rpc, token, "burn(address,uint256)", ["address", "uint256"], [PROBE_FROM, 1n]),
    updateMultiplierValue: await stateProbe(rpc, token, "updateMultiplierValue(uint256,uint256,uint256)", ["uint256", "uint256", "uint256"], [2_000_000_000_000_000_000n, oldMultiplier, 0n]),
    initializeV2: await stateProbe(rpc, token, "initialize_v2(uint256,uint256,uint256)", ["uint256", "uint256", "uint256"], [86400n, 1n, 0n]),
    initializeV3: await stateProbe(rpc, token, "initialize_v3()"),
  };
}

async function readProxySlots(rpc, address) {
  const [implSlot, adminSlot, beaconSlot] = await Promise.all([
    rpcCall(rpc, "eth_getStorageAt", [address, IMPL_SLOT, "latest"]).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [address, ADMIN_SLOT, "latest"]).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [address, BEACON_SLOT, "latest"]).catch(() => null),
  ]);
  return {
    implementation: addressFromWord(implSlot),
    admin: addressFromWord(adminSlot),
    beacon: addressFromWord(beaconSlot),
  };
}

function codeSelectors(code) {
  const lower = String(code || "").toLowerCase();
  return Object.fromEntries(INTERESTING_SIGNATURES.map((sig) => [sig, lower.includes(selector(sig).slice(2).toLowerCase())]));
}

async function roleConstants(rpc, token) {
  const out = { DEFAULT_ADMIN_ROLE: "0x" + "0".repeat(64) };
  for (const sig of ROLE_CONSTANTS) {
    const name = sig.replace(/\(\)$/, "");
    const raw = await callOptional(rpc, token, encodeCall(sig));
    if (raw && /^0x[0-9a-fA-F]{64}$/.test(raw)) out[name] = raw;
  }
  return out;
}

async function positiveRoles(rpc, token, roleMap, accounts) {
  const out = [];
  const uniqueAccounts = [...new Set(accounts.map(normalizeAddress).filter(Boolean))];
  for (const [roleName, role] of Object.entries(roleMap)) {
    for (const account of uniqueAccounts) {
      const raw = await callOptional(rpc, token, encodeCall("hasRole(bytes32,address)", ["bytes32", "address"], [role, account]));
      const has = raw ? decodeOne(raw, ["bool"]) : null;
      if (has === true) out.push({ roleName, role, account });
    }
  }
  return out;
}

async function scanEvmToken(rpc, token, asset, systemWallets) {
  const address = normalizeAddress(token);
  const meta = await tokenMeta(rpc, address);
  const systemBalances = [];
  let systemBalanceRaw = "0";
  for (const wallet of systemWallets) {
    const balance = await tokenBalance(rpc, address, wallet, meta.decimals);
    if (balance.raw && balance.raw !== "0") {
      systemBalances.push({ wallet: normalizeAddress(wallet), ...balance });
      systemBalanceRaw = addBig(systemBalanceRaw, balance.raw);
    }
  }

  const [ownerRaw, pausedRaw, code, proxySlots] = await Promise.all([
    callOptional(rpc, address, encodeCall("owner()")),
    callOptional(rpc, address, encodeCall("paused()")),
    rpcCall(rpc, "eth_getCode", [address, "latest"]).catch(() => "0x"),
    readProxySlots(rpc, address),
  ]);

  let implCode = null;
  if (proxySlots.implementation) implCode = await rpcCall(rpc, "eth_getCode", [proxySlots.implementation, "latest"]).catch(() => null);

  const roleMap = await roleConstants(rpc, address);
  const roleAccounts = [
    ...systemWallets,
    proxySlots.admin,
    proxySlots.implementation,
    addressFromWord(ownerRaw),
  ].filter(Boolean);
  const roles = await positiveRoles(rpc, address, roleMap, roleAccounts);
  const management = await managementState(rpc, address);
  const probes = await permissionlessProbes(rpc, address, management);

  const totalSupplyRaw = meta.totalSupplyRaw || "0";
  const circulatingRaw = subBig(totalSupplyRaw, systemBalanceRaw);
  return {
    asset: asset ? { name: asset.name, symbol: asset.symbol, underlyingSymbol: asset.underlyingSymbol, isTradingHalted: asset.isTradingHalted } : null,
    token: address,
    meta,
    owner: addressFromWord(ownerRaw),
    paused: pausedRaw ? decodeOne(pausedRaw, ["bool"]) : null,
    systemBalances,
    systemBalanceRaw,
    systemBalance: formatUnits(systemBalanceRaw, meta.decimals),
    circulatingRaw,
    circulating: formatUnits(circulatingRaw, meta.decimals),
    code: {
      codeSize: code && code !== "0x" ? (code.length - 2) / 2 : 0,
      codeHash: code && code !== "0x" ? crypto.createHash("sha256").update(Buffer.from(code.slice(2), "hex")).digest("hex") : null,
      selectors: codeSelectors(code),
    },
    management,
    permissionlessProbes: probes,
    proxy: {
      ...proxySlots,
      implementationCodeSize: implCode && implCode !== "0x" ? (implCode.length - 2) / 2 : null,
      implementationCodeHash: implCode && implCode !== "0x" ? crypto.createHash("sha256").update(Buffer.from(implCode.slice(2), "hex")).digest("hex") : null,
      implementationSelectors: implCode ? codeSelectors(implCode) : null,
    },
    roleConstants: Object.keys(roleMap),
    positiveRoles: roles,
  };
}

function mod(value, m = ED25519_P) {
  const result = value % m;
  return result >= 0n ? result : result + m;
}

function modPow(base, exponent, m = ED25519_P) {
  let result = 1n;
  let x = mod(base, m);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = mod(result * x, m);
    x = mod(x * x, m);
    e >>= 1n;
  }
  return result;
}

function modInv(value, m = ED25519_P) {
  return modPow(value, m - 2n, m);
}

function isQuadraticResidue(value) {
  const x = mod(value);
  return x === 0n || modPow(x, (ED25519_P - 1n) / 2n) === 1n;
}

function isOnEd25519CurveBytes(bytes) {
  if (bytes.length !== 32) return false;
  const copy = Buffer.from(bytes);
  copy[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) + BigInt(copy[i]);
  if (y >= ED25519_P) return false;
  const y2 = mod(y * y);
  const numerator = mod(y2 - 1n);
  const denominator = mod(ED25519_D * y2 + 1n);
  if (denominator === 0n) return false;
  return isQuadraticResidue(numerator * modInv(denominator));
}

function base58Decode(value) {
  let x = 0n;
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) throw new Error(`invalid base58 char: ${char}`);
    x = x * 58n + BigInt(digit);
  }
  const bytes = [];
  while (x > 0n) {
    bytes.push(Number(x & 0xffn));
    x >>= 8n;
  }
  for (const char of value) {
    if (char === "1") bytes.push(0);
    else break;
  }
  return Buffer.from(bytes.reverse());
}

function base58Encode(bytes) {
  let x = 0n;
  for (const byte of bytes) x = (x << 8n) + BigInt(byte);
  let out = "";
  while (x > 0n) {
    const digit = Number(x % 58n);
    out = BASE58_ALPHABET[digit] + out;
    x /= 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) out = "1" + out;
    else break;
  }
  return out || "1";
}

function findProgramAddress(seeds, programId) {
  const programBytes = base58Decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const payload = Buffer.concat([...seeds, Buffer.from([bump]), programBytes, PDA_MARKER]);
    const hash = crypto.createHash("sha256").update(payload).digest();
    if (!isOnEd25519CurveBytes(hash)) return { address: base58Encode(hash), bump };
  }
  throw new Error("Could not find PDA");
}

function associatedTokenAddress(owner, mint, tokenProgram) {
  return findProgramAddress([base58Decode(owner), base58Decode(tokenProgram), base58Decode(mint)], ASSOCIATED_TOKEN_PROGRAM_ID);
}

function solRpcCandidates() {
  const candidates = [];
  for (const key of ["SOLANA_RPC_URL", "SOLANA_RPC"]) if (process.env[key]) candidates.push(process.env[key]);
  if (fs.existsSync(RPC_FILE)) {
    for (const line of fs.readFileSync(RPC_FILE, "utf8").split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
      if (/solana/i.test(line)) for (const match of line.matchAll(/https?:\/\/[^\s'"<>]+/g)) candidates.push(match[0]);
    }
  }
  candidates.push("https://api.mainnet-beta.solana.com");
  return [...new Set(candidates)];
}

async function solPostJson(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const headers = { "content-type": "application/json" };
  if (process.env.SOLANA_RPC_ORIGIN) headers.origin = process.env.SOLANA_RPC_ORIGIN;
  try {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${sanitize(text.slice(0, 200))}`);
    const json = JSON.parse(text);
    if (json.error) throw new Error(JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function connectSolanaRpc() {
  let lastError;
  for (const url of solRpcCandidates()) {
    try {
      const version = await solPostJson(url, { jsonrpc: "2.0", id: 1, method: "getVersion", params: [] });
      const slot = await solPostJson(url, { jsonrpc: "2.0", id: 2, method: "getSlot", params: [{ commitment: "confirmed" }] });
      return { url, version, slot };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No working Solana RPC candidate (${lastError ? sanitize(lastError.message || lastError) : "unknown error"})`);
}

function makeSolRpc(url) {
  let id = 10;
  return async function rpc(method, params = []) {
    return solPostJson(url, { jsonrpc: "2.0", id: id++, method, params });
  };
}

async function getMultipleAccounts(rpc, addresses, encoding = "base64") {
  const unique = [...new Set(addresses.filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    const result = await rpc("getMultipleAccounts", [batch, { encoding, commitment: "confirmed" }]);
    result.value.forEach((value, index) => out.set(batch[index], value));
  }
  return out;
}

function dataBuffer(account) {
  if (!account || !Array.isArray(account.data)) return null;
  return Buffer.from(account.data[0], "base64");
}

function cOptionPubkey(data, offset) {
  if (!data || data.length < offset + 36) return null;
  const option = data.readUInt32LE(offset);
  if (option !== 1) return null;
  const bytes = data.subarray(offset + 4, offset + 36);
  if (bytes.every((byte) => byte === 0)) return null;
  return base58Encode(bytes);
}

function optionalPubkey(bytes) {
  if (!bytes || bytes.length !== 32 || bytes.every((byte) => byte === 0)) return null;
  return base58Encode(bytes);
}

function parseToken2022Extensions(account) {
  const data = dataBuffer(account);
  if (!data) return [];
  const out = [];
  for (const start of [82, 83, 165, 166]) {
    let offset = start;
    const current = [];
    while (offset + 4 <= data.length) {
      const type = data.readUInt16LE(offset);
      const length = data.readUInt16LE(offset + 2);
      if (type === 0 && length === 0) break;
      if (length > data.length || offset + 4 + length > data.length) break;
      current.push({ type, name: TOKEN_2022_EXTENSION_NAMES[type] || `Unknown${type}`, length, offset });
      offset += 4 + length;
    }
    if (current.length > out.length) out.splice(0, out.length, ...current);
  }
  return out;
}

function parseToken2022MetadataPointer(account) {
  const data = dataBuffer(account);
  if (!data) return null;
  const ext = parseToken2022Extensions(account).find((entry) => entry.type === 18 && entry.length >= 64);
  if (!ext) return null;
  const start = ext.offset + 4;
  return {
    authority: optionalPubkey(data.subarray(start, start + 32)),
    metadataAddress: optionalPubkey(data.subarray(start + 32, start + 64)),
  };
}

function printable(value) {
  return typeof value === "string" && value.length > 0 && value.length < 300 && /^[\x20-\x7e]+$/.test(value);
}

function parseMetadataPayloadAt(payload, offset) {
  const name = readBorshString(payload, offset);
  const symbol = readBorshString(payload, name.offset);
  const uri = readBorshString(payload, symbol.offset);
  if (!printable(name.value) || !printable(symbol.value)) return null;
  const additionalMetadata = [];
  let next = uri.offset;
  if (next + 4 <= payload.length) {
    const count = payload.readUInt32LE(next);
    next += 4;
    if (count < 100) {
      for (let i = 0; i < count && next < payload.length; i++) {
        const key = readBorshString(payload, next);
        const value = readBorshString(payload, key.offset);
        if (!printable(key.value)) break;
        additionalMetadata.push({ key: key.value, value: value.value });
        next = value.offset;
      }
    }
  }
  return { name: name.value, symbol: symbol.value, uri: uri.value, additionalMetadata };
}

function extractAsciiStrings(buffer) {
  const strings = [];
  let current = [];
  for (const byte of buffer) {
    if (byte >= 0x20 && byte <= 0x7e) current.push(byte);
    else {
      if (current.length >= 3) strings.push(Buffer.from(current).toString("utf8"));
      current = [];
    }
  }
  if (current.length >= 3) strings.push(Buffer.from(current).toString("utf8"));
  return [...new Set(strings)].slice(0, 50);
}

function parseToken2022TokenMetadata(account) {
  const data = dataBuffer(account);
  if (!data) return null;
  const ext = parseToken2022Extensions(account).find((entry) => entry.type === 19 && entry.length >= 70);
  if (!ext) return null;
  const payload = data.subarray(ext.offset + 4, ext.offset + 4 + ext.length);
  let parsed = null;
  for (const offset of [64, 65, 68, 72]) {
    parsed = parseMetadataPayloadAt(payload, offset);
    if (parsed) break;
  }
  return {
    updateAuthority: optionalPubkey(payload.subarray(0, 32)),
    mint: payload.length >= 64 ? base58Encode(payload.subarray(32, 64)) : null,
    parsed,
    asciiStrings: extractAsciiStrings(payload),
    length: ext.length,
    sha256: crypto.createHash("sha256").update(payload).digest("hex"),
  };
}

function parseToken2022ExtensionDetails(account) {
  const data = dataBuffer(account);
  if (!data) return {};
  const details = {};
  for (const ext of parseToken2022Extensions(account)) {
    const start = ext.offset + 4;
    if (ext.type === 4 && ext.length >= 65) {
      details.ConfidentialTransferMint = {
        authority: optionalPubkey(data.subarray(start, start + 32)),
        autoApproveNewAccounts: data.readUInt8(start + 32) === 1,
        auditorElGamalPubkey: data.subarray(start + 33, start + 65).toString("hex"),
      };
    } else if (ext.type === 6 && ext.length >= 1) {
      const state = data.readUInt8(start);
      details.DefaultAccountState = { state, name: state === 1 ? "initialized" : state === 2 ? "frozen" : `state-${state}` };
    } else if (ext.type === 12 && ext.length >= 32) {
      details.PermanentDelegate = { delegate: optionalPubkey(data.subarray(start, start + 32)) };
    } else if (ext.type === 14 && ext.length >= 64) {
      details.TransferHook = {
        authority: optionalPubkey(data.subarray(start, start + 32)),
        programId: optionalPubkey(data.subarray(start + 32, start + 64)),
      };
    } else if (ext.type === 18 && ext.length >= 64) {
      details.MetadataPointer = {
        authority: optionalPubkey(data.subarray(start, start + 32)),
        metadataAddress: optionalPubkey(data.subarray(start + 32, start + 64)),
      };
    } else if (ext.type === 25 && ext.length >= 56) {
      details.ScaledUiAmountConfig = {
        authority: optionalPubkey(data.subarray(start, start + 32)),
        multiplier: data.readDoubleLE(start + 32),
        newMultiplierEffectiveTimestamp: data.readBigInt64LE(start + 40).toString(),
        newMultiplier: data.readDoubleLE(start + 48),
      };
    } else if (ext.type === 26 && ext.length >= 33) {
      details.Pausable = {
        authority: optionalPubkey(data.subarray(start, start + 32)),
        paused: data.readUInt8(start + 32) === 1,
      };
    }
  }
  return details;
}

function parseMintAccount(account) {
  const data = dataBuffer(account);
  if (!data || data.length < 82) return null;
  const decimals = data.readUInt8(44);
  const supplyRaw = data.readBigUInt64LE(36).toString();
  return {
    owner: account.owner,
    dataLength: data.length,
    tokenProgramKind: account.owner === TOKEN_PROGRAM_ID ? "spl-token" : account.owner === TOKEN_2022_PROGRAM_ID ? "token-2022" : account.owner,
    mintAuthority: cOptionPubkey(data, 0),
    supplyRaw,
    supply: formatUnits(supplyRaw, decimals),
    decimals,
    isInitialized: data.readUInt8(45) === 1,
    freezeAuthority: cOptionPubkey(data, 46),
    token2022Extensions: parseToken2022Extensions(account),
    token2022ExtensionDetails: parseToken2022ExtensionDetails(account),
    token2022MetadataPointer: parseToken2022MetadataPointer(account),
    token2022TokenMetadata: parseToken2022TokenMetadata(account),
  };
}

function parseTokenAccount(account, decimals) {
  const data = dataBuffer(account);
  if (!data || data.length < 165) return null;
  const amountRaw = data.readBigUInt64LE(64).toString();
  const state = data.readUInt8(108);
  return {
    mint: base58Encode(data.subarray(0, 32)),
    ownerAuthority: base58Encode(data.subarray(32, 64)),
    ownerAuthorityOnCurve: isOnEd25519CurveBytes(data.subarray(32, 64)),
    amountRaw,
    amount: formatUnits(amountRaw, decimals),
    state: state === 1 ? "initialized" : state === 2 ? "frozen" : `state-${state}`,
  };
}

function readBorshString(data, offset) {
  if (offset + 4 > data.length) return { value: null, offset };
  const len = data.readUInt32LE(offset);
  offset += 4;
  if (len > 1000 || offset + len > data.length) return { value: null, offset };
  const value = data.subarray(offset, offset + len).toString("utf8").replace(/\u0000+$/g, "");
  return { value, offset: offset + len };
}

function parseMetaplexMetadata(account) {
  const data = dataBuffer(account);
  if (!data || data.length < 70) return null;
  let offset = 1;
  const updateAuthority = base58Encode(data.subarray(offset, offset + 32));
  offset += 32;
  const mint = base58Encode(data.subarray(offset, offset + 32));
  offset += 32;
  const name = readBorshString(data, offset);
  offset = name.offset;
  const symbol = readBorshString(data, offset);
  offset = symbol.offset;
  const uri = readBorshString(data, offset);
  offset = uri.offset;
  const sellerFeeBasisPoints = offset + 2 <= data.length ? data.readUInt16LE(offset) : null;
  return {
    updateAuthority,
    mint,
    name: name.value,
    symbol: symbol.value,
    uri: uri.value,
    sellerFeeBasisPoints,
    dataLength: data.length,
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
  };
}

function metadataPda(mint) {
  return findProgramAddress([
    Buffer.from("metadata"),
    base58Decode(METAPLEX_METADATA_PROGRAM_ID),
    base58Decode(mint),
  ], METAPLEX_METADATA_PROGRAM_ID);
}

async function tokenAccountsByOwner(rpc, owner, tokenPrograms) {
  const out = [];
  for (const programId of tokenPrograms) {
    try {
      const result = await rpc("getTokenAccountsByOwner", [owner, { programId }, { encoding: "base64", commitment: "confirmed" }]);
      for (const entry of result.value || []) out.push({ pubkey: entry.pubkey, account: entry.account });
    } catch (_) {
      // Some public RPCs limit token account owner queries; continue with other programs/wallets.
    }
  }
  return out;
}

async function scanSolanaMints(rpc, adapterTokens, svmWallets) {
  const mints = adapterTokens.map((item) => item.p.solana).filter(Boolean);
  const mintAccounts = await getMultipleAccounts(rpc, mints, "base64");
  const metadataAddresses = Object.fromEntries(mints.map((mint) => [mint, metadataPda(mint).address]));
  const metadataAccounts = await getMultipleAccounts(rpc, Object.values(metadataAddresses), "base64");

  const systemTokenBalances = new Map();
  for (const wallet of svmWallets) {
    const accounts = await tokenAccountsByOwner(rpc, wallet, [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);
    for (const entry of accounts) {
      const raw = dataBuffer(entry.account);
      if (!raw || raw.length < 72) continue;
      const mint = base58Encode(raw.subarray(0, 32));
      if (!mints.includes(mint)) continue;
      const mintInfo = parseMintAccount(mintAccounts.get(mint));
      const parsed = parseTokenAccount(entry.account, mintInfo ? mintInfo.decimals : 0);
      if (!parsed || parsed.amountRaw === "0") continue;
      const existing = systemTokenBalances.get(mint) || [];
      existing.push({ wallet, tokenAccount: entry.pubkey, ...parsed });
      systemTokenBalances.set(mint, existing);
    }
  }

  const out = [];
  for (const item of adapterTokens.filter((entry) => entry.p.solana)) {
    const mint = item.p.solana;
    const mintInfo = parseMintAccount(mintAccounts.get(mint));
    const decimals = mintInfo ? mintInfo.decimals : null;
    const largest = await rpc("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]).catch((err) => ({ error: sanitize(err.message || err), value: [] }));
    const largestAddresses = Array.isArray(largest.value) ? largest.value.map((entry) => entry.address) : [];
    const largestAccounts = largestAddresses.length ? await getMultipleAccounts(rpc, largestAddresses, "base64") : new Map();
    const topAccounts = Array.isArray(largest.value) ? largest.value.map((entry) => ({
      tokenAccount: entry.address,
      amountRaw: entry.amount,
      amount: entry.uiAmountString,
      parsed: parseTokenAccount(largestAccounts.get(entry.address), decimals),
    })) : [];
    const systemBalances = systemTokenBalances.get(mint) || [];
    const systemBalanceRaw = systemBalances.reduce((acc, entry) => addBig(acc, entry.amountRaw), "0");
    const circulatingRaw = mintInfo ? subBig(mintInfo.supplyRaw, systemBalanceRaw) : null;
    const metadata = parseMetaplexMetadata(metadataAccounts.get(metadataAddresses[mint]));

    out.push({
      name: item.name,
      mint,
      mintInfo,
      metadataAddress: metadataAddresses[mint],
      metadata,
      systemBalances,
      systemBalanceRaw,
      systemBalance: decimals === null ? null : formatUnits(systemBalanceRaw, decimals),
      circulatingRaw,
      circulating: decimals === null ? null : formatUnits(circulatingRaw, decimals),
      topAccounts,
    });
  }
  return out;
}

async function fetchDefiLlama() {
  try {
    const data = await fetchJson("https://api.llama.fi/protocol/xstocks", 30_000);
    return {
      name: data.name,
      category: data.category,
      symbol: data.symbol,
      chains: data.chains,
      audits: data.audits,
      currentChainTvls: data.currentChainTvls,
      tvlLast: Array.isArray(data.tvl) && data.tvl.length ? data.tvl[data.tvl.length - 1] : null,
    };
  } catch (err) {
    return { error: sanitize(err.message || err) };
  }
}

async function fetchMultipliers(symbols, networks) {
  const out = [];
  for (const symbol of symbols) {
    for (const network of networks) {
      try {
        const value = await fetchJson(`${API_BASE}/public/assets/${encodeURIComponent(symbol)}/multiplier?network=${network}`, 10_000);
        out.push({ symbol, network, ...value });
      } catch (err) {
        out.push({ symbol, network, error: sanitize(err.message || err) });
      }
    }
  }
  return out;
}

function summarizeBridgeConfigs(configs, adapterSymbols) {
  const symbols = new Set(adapterSymbols);
  return (Array.isArray(configs) ? configs : []).map((cfg) => ({
    address: cfg.address,
    network: cfg.network,
    chainId: cfg.chainId,
    managedBy: cfg.managedBy,
    destinationNetworks: cfg.destinationNetworks,
    sourceNetworks: cfg.sourceNetworks,
    productCount: Array.isArray(cfg.products) ? cfg.products.length : 0,
    adapterProductCount: Array.isArray(cfg.products) ? cfg.products.filter((p) => symbols.has(p.symbol)).length : 0,
    sampleProducts: Array.isArray(cfg.products) ? cfg.products.filter((p) => symbols.has(p.symbol)).slice(0, 10).map((p) => ({ symbol: p.symbol, productId: p.productId, deployments: p.deployments })) : [],
  }));
}

function summarizeTokenSet(tokens, chain) {
  const withMintAuthority = chain === "solana" ? tokens.filter((t) => t.mintInfo && t.mintInfo.mintAuthority).length : null;
  const withFreezeAuthority = chain === "solana" ? tokens.filter((t) => t.mintInfo && t.mintInfo.freezeAuthority).length : null;
  const metadataAuthorities = chain === "solana" ? [...new Set(tokens.map((t) => t.mintInfo && t.mintInfo.token2022TokenMetadata && t.mintInfo.token2022TokenMetadata.updateAuthority).filter(Boolean))] : null;
  const proxyImpls = chain === "arbitrum" ? [...new Set(tokens.map((t) => t.proxy.implementationCodeHash || t.code.codeHash).filter(Boolean))] : null;
  const paused = chain === "arbitrum" ? tokens.filter((t) => t.paused === true).length : null;
  const positiveRoleRows = chain === "arbitrum" ? tokens.reduce((acc, t) => acc + (t.positiveRoles || []).length, 0) : null;
  return {
    count: tokens.length,
    withMintAuthority,
    withFreezeAuthority,
    metadataAuthorities,
    proxyImplGroups: proxyImpls ? proxyImpls.length : null,
    paused,
    positiveRoleRows,
    negativeCirculating: tokens.filter((t) => t.circulatingRaw !== null && t.circulatingRaw !== undefined && BigInt(t.circulatingRaw) < 0n).map((t) => t.meta?.symbol || t.metadata?.symbol || t.name),
  };
}

function isPendingMultiplier(m) {
  return !m.error && Number(m.activationDateTime || 0) > 0 && Number(m.newMultiplier || 0) > 0 && Number(m.newMultiplier) !== Number(m.currentMultiplier);
}

function riskResolution(solanaTokens, arbitrumTokens, multipliers, bridges, proofReserves) {
  const pendingMultipliers = multipliers.filter(isPendingMultiplier);
  const solFreeze = solanaTokens.filter((t) => t.mintInfo && t.mintInfo.freezeAuthority);
  const solMintAuths = [...new Set(solanaTokens.map((t) => t.mintInfo && t.mintInfo.mintAuthority).filter(Boolean))];
  const solPermanentDelegates = [...new Set(solanaTokens.map((t) => t.mintInfo?.token2022ExtensionDetails?.PermanentDelegate?.delegate).filter(Boolean))];
  const solTransferHooks = [...new Set(solanaTokens.map((t) => t.mintInfo?.token2022ExtensionDetails?.TransferHook?.programId).filter(Boolean))];
  const solPausable = solanaTokens.filter((t) => t.mintInfo?.token2022ExtensionDetails?.Pausable);
  const solPaused = solPausable.filter((t) => t.mintInfo.token2022ExtensionDetails.Pausable.paused);
  const arProxyImplGroups = [...new Set(arbitrumTokens.map((t) => t.proxy.implementationCodeHash || t.code.codeHash).filter(Boolean))];
  const arPaused = arbitrumTokens.filter((t) => t.paused === true);
  const proofMissing = proofReserves.filter((p) => p.sharesHeld === null || p.sharesHeld === undefined || p.circulatingSupply === null || p.circulatingSupply === undefined);
  const proofUnder = proofReserves.filter((p) => Number(p.sharesHeld || 0) + 1e-9 < Number(p.circulatingSupply || 0));
  return [
    { item: "Solana mint authorities", status: solMintAuths.length ? "present" : "none", evidence: `${solMintAuths.length} unique mint authorities across ${solanaTokens.length} mints` },
    { item: "Solana freeze authorities", status: solFreeze.length ? "present" : "none", evidence: `${solFreeze.length}/${solanaTokens.length} mints have freeze authority` },
    { item: "Solana permanent delegates", status: solPermanentDelegates.length ? "present" : "none", evidence: `${solPermanentDelegates.length} unique permanent delegates across ${solanaTokens.length} mints` },
    { item: "Solana transfer hooks", status: solTransferHooks.length ? "present" : "none", evidence: `${solTransferHooks.length} unique transfer hook programs across ${solanaTokens.length} mints` },
    { item: "Solana pausable extension", status: solPausable.length ? "present" : "none", evidence: `${solPaused.length}/${solPausable.length} pausable mints currently paused` },
    { item: "Arbitrum implementation groups", status: arProxyImplGroups.length <= 2 ? "uniform" : "mixed", evidence: `${arProxyImplGroups.length} code/implementation hashes across ${arbitrumTokens.length} tokens` },
    { item: "Arbitrum paused tokens", status: arPaused.length ? "present" : "none", evidence: `${arPaused.length}/${arbitrumTokens.length} paused()` },
    { item: "Pending multipliers", status: pendingMultipliers.length ? "pending" : "none", evidence: `${pendingMultipliers.length} active pending multiplier updates in scanned Arbitrum/Solana assets` },
    { item: "Proof-of-reserves undercollateralization", status: proofUnder.length ? "present" : "none", evidence: `${proofUnder.length}/${proofReserves.length} public proof rows have sharesHeld < circulatingSupply` },
    { item: "Proof-of-reserves data gaps", status: proofMissing.length ? "present" : "none", evidence: `${proofMissing.length}/${proofReserves.length} public proof rows are missing sharesHeld or circulatingSupply` },
    { item: "Bridge configs", status: bridges.length ? "mapped" : "not-found", evidence: `${bridges.length} public bridge config rows` },
  ];
}

async function main() {
  if (!fs.existsSync(path.dirname(OUT))) fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const [adapterText, assetsPaged, wallets, bridgesRaw, proofPaged, upcomingPaged, defillama] = await Promise.all([
    fetchText(ADAPTER_URL, 30_000),
    fetchPaged("/public/assets", 100),
    fetchJson(`${API_BASE}/public/system/wallets`, 20_000),
    fetchJson(`${API_BASE}/public/bridges`, 30_000).catch((err) => ({ error: sanitize(err.message || err) })),
    fetchPaged("/public/proof-of-reserves", 100),
    fetchPaged("/public/corporate-actions/upcoming", 100).catch((err) => ({ nodes: [], error: sanitize(err.message || err) })),
    fetchDefiLlama(),
  ]);

  const adapterTokens = extractAdapterData(adapterText);
  const apiAssets = assetsPaged.nodes || [];
  const proofReserves = proofPaged.nodes || [];
  const systemWallets = wallets.nodes || [];
  const evmSystemWallets = systemWallets.filter((w) => w.networkType === "Evm" && isAddress(w.address)).map((w) => normalizeAddress(w.address));
  const svmSystemWallets = systemWallets.filter((w) => w.networkType === "Svm").map((w) => w.address);
  const assetByAddress = new Map();
  for (const asset of apiAssets) {
    for (const dep of asset.deployments || []) {
      if (dep.address) assetByAddress.set(String(dep.address).toLowerCase(), asset);
    }
  }

  const adapterSymbols = [...new Set(adapterTokens.flatMap((item) => Object.values(item.p || {}).map((addr) => assetByAddress.get(String(addr).toLowerCase())?.symbol).filter(Boolean)))];
  const multipliers = await fetchMultipliers(adapterSymbols, ["Arbitrum", "Solana"]);
  const bridges = Array.isArray(bridgesRaw) ? summarizeBridgeConfigs(bridgesRaw, adapterSymbols) : [];

  const arbRpc = await resolveEvmRpc("arbitrum");
  if (!arbRpc) throw new Error("No Arbitrum RPC available");
  const arbBlockHex = await rpcCall(arbRpc, "eth_blockNumber", []);
  const arbitrumTokens = [];
  for (const item of adapterTokens.filter((entry) => entry.p["arbitrum-one"])) {
    const token = item.p["arbitrum-one"];
    arbitrumTokens.push(await scanEvmToken(arbRpc, token, assetByAddress.get(token.toLowerCase()), evmSystemWallets));
  }

  const solConnection = await connectSolanaRpc();
  const solRpc = makeSolRpc(solConnection.url);
  const solanaTokens = await scanSolanaMints(solRpc, adapterTokens, svmSystemWallets);

  const out = {
    generatedAt: new Date().toISOString(),
    target: {
      name: "xStocks",
      docs: [
        "https://docs.xstocks.fi/",
        "https://docs.xstocks.fi/docs/dividends-and-stock-splits",
        "https://docs.xstocks.fi/apis/openapi",
        "https://assets.backed.fi/legal-documentation",
      ],
      safety: "read-only RPC and public API calls only; no signed actions",
    },
    defillama,
    adapter: {
      source: ADAPTER_URL,
      tokenCount: adapterTokens.length,
      solanaCount: adapterTokens.filter((item) => item.p.solana).length,
      arbitrumCount: adapterTokens.filter((item) => item.p["arbitrum-one"]).length,
      bothCount: adapterTokens.filter((item) => item.p.solana && item.p["arbitrum-one"]).length,
      tokens: adapterTokens,
    },
    publicApi: {
      assetCount: apiAssets.length,
      proofReserveCount: proofReserves.length,
      systemWallets,
      deploymentNetworkCounts: apiAssets.reduce((acc, asset) => {
        for (const dep of asset.deployments || []) acc[dep.network] = (acc[dep.network] || 0) + 1;
        return acc;
      }, {}),
      bridgeConfigs: bridges,
      upcomingCorporateActions: upcomingPaged.nodes || [],
    },
    multipliers,
    proofReserves: proofReserves.filter((row) => adapterSymbols.includes(row.symbol)),
    arbitrum: {
      chainId: 42161,
      blockNumber: Number(BigInt(arbBlockHex)),
      systemWallets: evmSystemWallets,
      summary: summarizeTokenSet(arbitrumTokens, "arbitrum"),
      tokens: arbitrumTokens,
    },
    solana: {
      slot: solConnection.slot,
      rpcVersion: solConnection.version,
      systemWallets: svmSystemWallets,
      summary: summarizeTokenSet(solanaTokens, "solana"),
      tokens: solanaTokens,
    },
    riskResolution: riskResolution(solanaTokens, arbitrumTokens, multipliers, bridges, proofReserves.filter((row) => adapterSymbols.includes(row.symbol))),
  };

  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Wrote ${OUT}`);
  console.log(`adapterTokens=${out.adapter.tokenCount} solana=${out.adapter.solanaCount} arbitrum=${out.adapter.arbitrumCount} both=${out.adapter.bothCount}`);
  console.log(`arbitrumBlock=${out.arbitrum.blockNumber} implGroups=${out.arbitrum.summary.proxyImplGroups} paused=${out.arbitrum.summary.paused}`);
  console.log(`solanaSlot=${out.solana.slot} mintAuth=${out.solana.summary.withMintAuthority}/${out.solana.summary.count} freezeAuth=${out.solana.summary.withFreezeAuthority}/${out.solana.summary.count}`);
  console.log(`pendingMultipliers=${out.riskResolution.find((x) => x.item === "Pending multipliers").evidence}`);
}

main().catch((err) => {
  console.error(sanitize(err.stack || err.message || err));
  process.exit(1);
});
