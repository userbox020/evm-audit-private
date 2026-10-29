#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.join(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "avalon-usda-live.json");
const RPC_TIMEOUT_MS = 15_000;

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const CHAINS = {
  ethereum: { chainId: 1, fallbacks: ["https://ethereum-rpc.publicnode.com"] },
  bsc: { chainId: 56, fallbacks: ["https://bsc-dataseed.binance.org"] },
  mantle: { chainId: 5000, fallbacks: ["https://rpc.mantle.xyz"] },
  sonic: { chainId: 146, fallbacks: ["https://rpc.soniclabs.com"] },
  berachain: { chainId: 80094, fallbacks: ["https://rpc.berachain.com"] },
};

const CONFIG = {
  ethereum: {
    poolAddress: "0x3f390dD6EF69f68f9877aACC086856a200808693",
    usdaAddress: "0x0b4D6DA52dF60D44Ce7140F1044F2aD5fabd6316",
    owners: ["0x3f390dD6EF69f68f9877aACC086856a200808693", "0x5A79311083dC82aBc2DE1E5639673C876cc6757e"],
    tokens: [
      { label: "FBTC", address: "0xc96de26018a54d51c097160568752c4e3bd6c364" },
      { label: "LFBTC", address: "0x3119a1AD5B63A000aB9CA3F2470611eB997B93B9" },
      { label: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7" },
      { label: "USDe", address: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3" },
      { label: "sUSDe", address: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" },
    ],
  },
  bsc: {
    poolAddress: "0xC757E47d6bC20FEab54e16F2939F51Aa4826deF7",
    usdaAddress: "0x8a4bA6C340894B7B1De0F6A03F25Aa6afb7f0224",
    owners: ["0xC757E47d6bC20FEab54e16F2939F51Aa4826deF7"],
    tokens: [
      { label: "FBTC", address: "0xc96de26018a54d51c097160568752c4e3bd6c364" },
      { label: "LFBTC", address: "0x3119a1AD5B63A000aB9CA3F2470611eB997B93B9" },
    ],
  },
  mantle: {
    poolAddress: "0x8f778806CBea29F0f64BA6A4B7724BCD5EEd543E",
    usdaAddress: "0x2BDC204b6d192921605c66B7260cFEF7bE34Eb2E",
    owners: ["0x8f778806CBea29F0f64BA6A4B7724BCD5EEd543E"],
    tokens: [
      { label: "FBTC", address: "0xC96dE26018A54D51c097160568752c4E3BD6C364" },
      { label: "LFBTC", address: "0x3119a1AD5B63A000aB9CA3F2470611eB997B93B9" },
    ],
  },
  sonic: {
    poolAddress: "0x74476697b5FFd19c8CD9603C01527Dcb987C7418",
    usdaAddress: "0xff12470a969dd362eb6595ffb44c82c959fe9acc",
    owners: ["0x74476697b5FFd19c8CD9603C01527Dcb987C7418"],
    tokens: [
      { label: "FBTC", address: "0xC96dE26018A54D51c097160568752c4E3BD6C364" },
      { label: "LFBTC", address: "0x040c10f8238e4689c5e549ef5e07478b738b2ba5" },
    ],
  },
  berachain: {
    poolAddress: "0x02feDCff97942fe28e8936Cdc3D7A480fdD248f0",
    usdaAddress: "0xff12470a969dd362eb6595ffb44c82c959fe9acc",
    owners: ["0x0c3616027b7d7AC8BA6FA2a1540a5e6A728cebA5"],
    tokens: [{ label: "WFBTC", address: "0xA18717e22dfAbB36f0242259df4e9E563b6Ec70a" }],
  },
};

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveRpc(chainName) {
  const target = CHAINS[chainName];
  const candidates = [...extractRpcUrls(), ...(target.fallbacks || [])];
  const seen = new Set();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const chainId = Number(BigInt(await rpcCall(url, "eth_chainId", [], 5000)));
      if (chainId === target.chainId) return url;
    } catch (_) {
      // Ignore bad endpoints. Never print or store RPC URLs.
    }
  }
  return null;
}

function strip0x(x) {
  return String(x || "").replace(/^0x/i, "");
}

function padAddress(address) {
  return strip0x(address).toLowerCase().padStart(64, "0");
}

function hexToBigInt(hex) {
  if (!hex || hex === "0x") return null;
  return BigInt(hex);
}

function formatUnits(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const frac = raw % scale;
  const fracText = frac.toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 8);
  return fracText ? `${whole}.${fracText}` : whole.toString();
}

function decodeString(data) {
  if (!data || data === "0x") return null;
  const hex = strip0x(data);
  try {
    if (hex.length === 64) {
      const bytes = Buffer.from(hex, "hex");
      return bytes.toString("utf8").replace(/\u0000+$/g, "") || null;
    }
    const offset = Number(BigInt("0x" + hex.slice(0, 64))) * 2;
    const len = Number(BigInt("0x" + hex.slice(offset, offset + 64))) * 2;
    return Buffer.from(hex.slice(offset + 64, offset + 64 + len), "hex").toString("utf8") || null;
  } catch (_) {
    return null;
  }
}

async function callOptional(rpc, to, data) {
  try {
    return await rpcCall(rpc, "eth_call", [{ to, data }, "latest"]);
  } catch (_) {
    return null;
  }
}

function addressFromSlot(slot) {
  if (!slot || slot === "0x" || BigInt(slot) === 0n) return null;
  return "0x" + strip0x(slot).slice(-40);
}

async function tokenMeta(rpc, token) {
  const [symbolRaw, nameRaw, decimalsRaw, totalSupplyRaw] = await Promise.all([
    callOptional(rpc, token.address, "0x95d89b41"),
    callOptional(rpc, token.address, "0x06fdde03"),
    callOptional(rpc, token.address, "0x313ce567"),
    callOptional(rpc, token.address, "0x18160ddd"),
  ]);
  const decimals = decimalsRaw ? Number(hexToBigInt(decimalsRaw)) : null;
  const totalSupply = hexToBigInt(totalSupplyRaw);
  return {
    label: token.label,
    address: token.address,
    symbol: decodeString(symbolRaw),
    name: decodeString(nameRaw),
    decimals,
    totalSupplyRaw: totalSupply?.toString() || null,
    totalSupply: formatUnits(totalSupply, decimals),
  };
}

async function balanceOf(rpc, token, owner, decimals) {
  const data = "0x70a08231" + padAddress(owner);
  const raw = hexToBigInt(await callOptional(rpc, token, data));
  return { owner, raw: raw?.toString() || null, amount: formatUnits(raw, decimals) };
}

async function contractMeta(rpc, address) {
  const [code, implSlot, adminSlot] = await Promise.all([
    rpcCall(rpc, "eth_getCode", [address, "latest"]),
    rpcCall(rpc, "eth_getStorageAt", [address, IMPL_SLOT, "latest"]).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [address, ADMIN_SLOT, "latest"]).catch(() => null),
  ]);
  return {
    address,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? (strip0x(code).length / 2) : 0,
    eip1967Implementation: addressFromSlot(implSlot),
    eip1967Admin: addressFromSlot(adminSlot),
  };
}

async function scanChain(chainName) {
  const cfg = CONFIG[chainName];
  const rpc = await resolveRpc(chainName);
  if (!rpc) return { chain: chainName, rpcResolved: false, error: "missing-rpc" };

  const blockNumber = Number(BigInt(await rpcCall(rpc, "eth_blockNumber", [])));
  const contracts = {
    pool: await contractMeta(rpc, cfg.poolAddress),
    usda: await contractMeta(rpc, cfg.usdaAddress),
  };

  const tokens = [];
  for (const token of [...cfg.tokens, { label: "USDa", address: cfg.usdaAddress }]) {
    const meta = await tokenMeta(rpc, token);
    const owners = new Set(cfg.owners);
    owners.add(cfg.poolAddress);
    const balances = [];
    for (const owner of owners) {
      balances.push(await balanceOf(rpc, token.address, owner, meta.decimals));
    }
    tokens.push({ ...meta, balances });
  }

  return { chain: chainName, chainId: CHAINS[chainName].chainId, rpcResolved: true, blockNumber, contracts, tokens };
}

async function main() {
  const results = [];
  for (const chainName of Object.keys(CONFIG)) {
    console.log(`Scanning ${chainName}...`);
    results.push(await scanChain(chainName));
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-avalon-usda.js",
    safety: { rpcUrlsStored: false, signedActions: false },
    result: results,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");

  const scanned = results.filter((r) => r.rpcResolved).length;
  const missing = results.length - scanned;
  console.log(`wrote ${OUT}`);
  console.log(`scanned=${scanned} missingRpc=${missing}`);
}

main().catch((e) => {
  console.error(e.stack || e.message || String(e));
  process.exitCode = 1;
});
