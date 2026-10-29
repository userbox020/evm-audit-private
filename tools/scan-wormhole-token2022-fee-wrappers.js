#!/usr/bin/env node
// Read-only Wormhole Portal Solana Token-2022 transfer-fee wrapper refresh.
// Reads Solana/EVM RPC endpoints in memory only, never prints or stores RPC URLs,
// and only performs read-only RPC/API calls.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "wormhole-token2022-fee-wrappers.json");

const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKEN_BRIDGE_PROGRAM_ID = "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb";
const CUSTODY_SIGNER = "GugU1tP7doLeTw9hQP51xRJyS8Da1fWxuiy2rVrnMD2m"; // PDA(["custody_signer"], Token Bridge)
const SOLANA_WORMHOLE_CHAIN_ID = 1;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MATERIAL_LIQUIDITY_USD = Number(process.env.WORMHOLE_TOKEN2022_MIN_LIQUIDITY_USD || "10000");

const TOKEN_2022_EXTENSION_NAMES = {
  1: "TransferFeeConfig",
  2: "TransferFeeAmount",
  14: "TransferHook",
  16: "ConfidentialTransferFeeConfig",
  17: "ConfidentialTransferFeeAmount",
  18: "MetadataPointer",
  19: "TokenMetadata",
  25: "ScaledUiAmountConfig",
  26: "Pausable",
};

const PRIORITY_EVM_BRIDGES = [
  { key: "ethereum", chainId: 1, dexChain: "ethereum", tokenBridge: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585" },
  { key: "base", chainId: 8453, dexChain: "base", tokenBridge: "0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627" },
  { key: "arbitrum", chainId: 42161, dexChain: "arbitrum", tokenBridge: "0x0b2402144Bb366A632D14B83F244D2e0e21bD39c" },
  { key: "optimism", chainId: 10, dexChain: "optimism", tokenBridge: "0x1D68124e65faFC907325e3EDbF8c4d84499DAa8b" },
  { key: "polygon", chainId: 137, dexChain: "polygon", tokenBridge: "0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE" },
  { key: "bsc", chainId: 56, dexChain: "bsc", tokenBridge: "0xB6F6D86a8f9879A9c87f643768d9efc38c1Da6E7" },
];

const PORTAL = new ethers.Interface([
  "function wrappedAsset(uint16 tokenChainId, bytes32 tokenAddress) view returns (address)",
]);

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function sanitize(text) {
  return String(text || "").replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 300);
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function evmRpcCall(url, method, params = [], timeoutMs = 12_000) {
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

async function resolveEvmRpcs(chainIds) {
  const pool = {};
  const urls = extractRpcUrls();
  for (const url of urls) {
    try {
      const idHex = await evmRpcCall(url, "eth_chainId", [], 5000);
      const chainId = Number(BigInt(idHex));
      if (chainIds.includes(chainId) && !pool[chainId]) pool[chainId] = url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return pool;
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

async function solPostJson(url, body, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { "content-type": "application/json" };
  if (process.env.SOLANA_RPC_ORIGIN) headers.origin = process.env.SOLANA_RPC_ORIGIN;
  try {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${sanitize(text)}`);
    const json = JSON.parse(text);
    if (json.error) throw new Error(JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function connectSolanaRpc() {
  let lastError = null;
  for (const url of solRpcCandidates()) {
    try {
      const version = await solPostJson(url, { jsonrpc: "2.0", id: 1, method: "getVersion", params: [] }, 8000);
      const slot = await solPostJson(url, { jsonrpc: "2.0", id: 2, method: "getSlot", params: [{ commitment: "confirmed" }] }, 8000);
      const epochInfo = await solPostJson(url, { jsonrpc: "2.0", id: 3, method: "getEpochInfo", params: [{ commitment: "confirmed" }] }, 8000);
      return { url, version, slot, epochInfo };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No working Solana RPC candidate (${lastError ? sanitize(lastError.message || lastError) : "unknown"})`);
}

function makeSolRpc(url) {
  let id = 10;
  return async function rpc(method, params = []) {
    return solPostJson(url, { jsonrpc: "2.0", id: id++, method, params });
  };
}

function base58Decode(value) {
  let n = 0n;
  for (const char of String(value)) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) throw new Error(`invalid base58 char: ${char}`);
    n = n * 58n + BigInt(digit);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const char of String(value)) {
    if (char === "1") bytes.unshift(0);
    else break;
  }
  return Buffer.from(bytes);
}

function base58Encode(bytes) {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) + BigInt(byte);
  let out = "";
  while (n > 0n) {
    const mod = Number(n % 58n);
    out = BASE58_ALPHABET[mod] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) out = "1" + out;
    else break;
  }
  return out || "1";
}

function dataBuffer(account) {
  if (!account || !Array.isArray(account.data)) return null;
  return Buffer.from(account.data[0], "base64");
}

function optionalPubkey(bytes) {
  if (!bytes || bytes.length !== 32 || bytes.every((byte) => byte === 0)) return null;
  return base58Encode(bytes);
}

function formatUnits(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  const value = BigInt(raw);
  const d = Number(decimals);
  const scale = 10n ** BigInt(d);
  const whole = value / scale;
  const frac = value % scale;
  const fracText = frac.toString().padStart(d, "0").slice(0, 8).replace(/0+$/, "");
  return `${whole.toString()}${fracText ? "." + fracText : ""}`;
}

function parseToken2022ExtensionsFromBuffer(data) {
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

function parseTransferFeeConfig(data, currentEpoch) {
  const ext = parseToken2022ExtensionsFromBuffer(data).find((entry) => entry.type === 1 && entry.length >= 108);
  if (!ext) return null;
  const start = ext.offset + 4;
  const older = parseTransferFee(data, start + 72);
  const newer = parseTransferFee(data, start + 90);
  const current = BigInt(currentEpoch || 0) >= BigInt(newer.epoch || 0) ? newer : older;
  return {
    configAuthority: optionalPubkey(data.subarray(start, start + 32)),
    withdrawWithheldAuthority: optionalPubkey(data.subarray(start + 32, start + 64)),
    withheldAmountRaw: data.readBigUInt64LE(start + 64).toString(),
    older,
    newer,
    active: current,
  };
}

function parseTransferFee(data, offset) {
  return {
    epoch: data.readBigUInt64LE(offset).toString(),
    maximumFeeRaw: data.readBigUInt64LE(offset + 8).toString(),
    transferFeeBasisPoints: data.readUInt16LE(offset + 16),
  };
}

function parseTransferFeeAmount(data) {
  const ext = parseToken2022ExtensionsFromBuffer(data).find((entry) => entry.type === 2 && entry.length >= 8);
  if (!ext) return null;
  return { withheldAmountRaw: data.readBigUInt64LE(ext.offset + 4).toString() };
}

function parseMintAccount(account, currentEpoch) {
  const data = dataBuffer(account);
  if (!data || data.length < 82) return null;
  const decimals = data.readUInt8(44);
  const supplyRaw = data.readBigUInt64LE(36).toString();
  const extensions = parseToken2022ExtensionsFromBuffer(data);
  const transferFeeConfig = parseTransferFeeConfig(data, currentEpoch);
  return {
    owner: account.owner,
    dataLength: data.length,
    decimals,
    supplyRaw,
    supply: formatUnits(supplyRaw, decimals),
    isInitialized: data.readUInt8(45) === 1,
    extensions,
    transferFeeConfig,
  };
}

function parseTokenAccount(account) {
  const data = dataBuffer(account);
  if (!data || data.length < 165) return null;
  const amountRaw = data.readBigUInt64LE(64).toString();
  const state = data.readUInt8(108);
  return {
    mint: base58Encode(data.subarray(0, 32)),
    ownerAuthority: base58Encode(data.subarray(32, 64)),
    amountRaw,
    state: state === 1 ? "initialized" : state === 2 ? "frozen" : `state-${state}`,
    transferFeeAmount: parseTransferFeeAmount(data),
  };
}

async function getMultipleAccounts(rpc, addresses) {
  const out = new Map();
  const unique = [...new Set(addresses.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    const result = await rpc("getMultipleAccounts", [batch, { encoding: "base64", commitment: "confirmed" }]);
    result.value.forEach((value, index) => out.set(batch[index], value));
  }
  return out;
}

async function scanCustodyAccounts(rpc) {
  const result = await rpc("getProgramAccounts", [TOKEN_2022_PROGRAM_ID, {
    encoding: "base64",
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 32, bytes: CUSTODY_SIGNER } }],
  }]);
  return result.map((row) => ({ pubkey: row.pubkey, account: row.account, parsed: parseTokenAccount(row.account) }));
}

function solanaMintBytes32(mint) {
  const bytes = base58Decode(mint);
  if (bytes.length !== 32) throw new Error(`unexpected mint length for ${mint}`);
  return `0x${bytes.toString("hex")}`;
}

async function wrappedAsset(provider, bridge, mint) {
  try {
    const data = PORTAL.encodeFunctionData("wrappedAsset", [SOLANA_WORMHOLE_CHAIN_ID, solanaMintBytes32(mint)]);
    const raw = await provider.call({ to: bridge, data });
    const [address] = PORTAL.decodeFunctionResult("wrappedAsset", raw);
    return String(address);
  } catch (err) {
    return { error: sanitize(err.message || err) };
  }
}

async function dexLiquidity(dexChain, token) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = await res.json();
    const pairs = (json.pairs || []).filter((p) => String(p.chainId || "").toLowerCase() === dexChain);
    const top = pairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0];
    if (!top) return { pairCount: 0, topLiquidityUsd: 0 };
    return {
      pairCount: pairs.length,
      topLiquidityUsd: Number(top.liquidity?.usd || 0),
      topDexId: top.dexId || null,
      topPair: top.pairAddress || null,
      priceUsd: top.priceUsd ? Number(top.priceUsd) : null,
    };
  } catch (_) {
    return null;
  }
}

async function checkEvmWrappers(feeMints, evmRpcs) {
  const out = [];
  for (const chain of PRIORITY_EVM_BRIDGES) {
    const rpc = evmRpcs[chain.chainId];
    if (!rpc) {
      out.push({ chain: chain.key, chainId: chain.chainId, status: "no-rpc", wrappers: [] });
      continue;
    }
    const provider = new ethers.JsonRpcProvider(rpc);
    const wrappers = [];
    for (const mint of feeMints) {
      const value = await wrappedAsset(provider, chain.tokenBridge, mint.mint);
      const address = typeof value === "string" ? value : null;
      const nonzero = address && address.toLowerCase() !== ZERO_ADDRESS;
      const liquidity = nonzero ? await dexLiquidity(chain.dexChain, address.toLowerCase()) : null;
      wrappers.push({
        mint: mint.mint,
        wrapper: address,
        error: value && typeof value === "object" ? value.error : null,
        nonzero: Boolean(nonzero),
        liquidity,
        routePositive: Boolean(nonzero && liquidity && Number(liquidity.topLiquidityUsd || 0) >= MATERIAL_LIQUIDITY_USD && mint.activeFeeBps > 0),
      });
    }
    out.push({ chain: chain.key, chainId: chain.chainId, status: "scanned", wrappers });
  }
  return out;
}

async function main() {
  const sol = await connectSolanaRpc();
  const rpc = makeSolRpc(sol.url);
  const custodyRows = await scanCustodyAccounts(rpc);
  const mints = [...new Set(custodyRows.map((row) => row.parsed?.mint).filter(Boolean))];
  const mintAccounts = await getMultipleAccounts(rpc, mints);
  const currentEpoch = sol.epochInfo?.epoch || 0;
  const mintInfos = mints.map((mint) => ({ mint, info: parseMintAccount(mintAccounts.get(mint), currentEpoch) }));
  const feeMints = mintInfos
    .filter((row) => row.info?.transferFeeConfig)
    .map((row) => {
      const custody = custodyRows.find((item) => item.parsed?.mint === row.mint);
      const active = row.info.transferFeeConfig.active || {};
      return {
        mint: row.mint,
        custodyAccount: custody?.pubkey || null,
        custodyAmountRaw: custody?.parsed?.amountRaw || null,
        custodyAmount: formatUnits(custody?.parsed?.amountRaw || "0", row.info.decimals),
        custodyState: custody?.parsed?.state || null,
        decimals: row.info.decimals,
        supplyRaw: row.info.supplyRaw,
        supply: row.info.supply,
        activeFeeBps: Number(active.transferFeeBasisPoints || 0),
        activeMaxFeeRaw: active.maximumFeeRaw || null,
        activeMaxFee: formatUnits(active.maximumFeeRaw || "0", row.info.decimals),
        transferFeeConfig: row.info.transferFeeConfig,
        extensions: row.info.extensions,
      };
    });
  const evmRpcs = await resolveEvmRpcs(PRIORITY_EVM_BRIDGES.map((c) => c.chainId));
  const wrapperChecks = await checkEvmWrappers(feeMints, evmRpcs);
  const nonzeroWrappers = wrapperChecks.flatMap((chain) => chain.wrappers.map((w) => ({ chain: chain.chain, ...w }))).filter((w) => w.nonzero);
  const routePositive = nonzeroWrappers.filter((w) => w.routePositive);

  const out = {
    generatedAt: new Date().toISOString(),
    scope: "Read-only Wormhole Portal Solana Token-2022 fee-mint wrapper refresh",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      signedActionJustified: false,
    },
    solana: {
      tokenBridgeProgram: TOKEN_BRIDGE_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      custodySigner: CUSTODY_SIGNER,
      slot: sol.slot,
      epoch: currentEpoch,
      version: sol.version,
    },
    summary: {
      custodyAccounts: custodyRows.length,
      uniqueMints: mints.length,
      transferFeeConfigMints: feeMints.length,
      activeFeeMints: feeMints.filter((m) => m.activeFeeBps > 0).length,
      priorityEvmChains: PRIORITY_EVM_BRIDGES.length,
      nonzeroWrappers: nonzeroWrappers.length,
      routePositive: routePositive.length,
      signedActionJustified: false,
    },
    feeMints,
    wrapperChecks,
    routePositive,
    blockers: routePositive.length > 0 ? [] : [
      "No active-fee Token-2022 mint has a material priority EVM Portal wrapper/liquidity route in this refresh",
      "Fork/local PoC remains blocked until wrapper and liquidity become nonzero/material",
    ],
  };

  ensureDir(OUT);
  fs.writeFileSync(OUT, JSON.stringify(out, jsonReplacer, 2) + "\n");
  console.log(`wormhole-token2022: custody=${out.summary.custodyAccounts} feeMints=${out.summary.transferFeeConfigMints} activeFee=${out.summary.activeFeeMints} wrappers=${out.summary.nonzeroWrappers} routePositive=${out.summary.routePositive}`);
  console.log(`wrote ${path.relative(WORKSPACE, OUT)}`);
}

main().catch((error) => {
  console.error(sanitize(error.message || error));
  process.exit(1);
});
