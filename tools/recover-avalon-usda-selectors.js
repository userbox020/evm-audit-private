#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { getAddress, id, isAddress } = require("ethers");

const WORKSPACE = path.join(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "avalon-usda-selector-recovery.json");
const RPC_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 12_000;
const FOURBYTE_DELAY_MS = 75;

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const CHAINS = {
  ethereum: { chainId: 1, fallbacks: ["https://ethereum-rpc.publicnode.com"], logLookback: 200_000 },
  bsc: { chainId: 56, fallbacks: ["https://bsc-dataseed.binance.org"], logLookback: 200_000 },
  mantle: { chainId: 5000, fallbacks: ["https://rpc.mantle.xyz"], logLookback: 200_000 },
  sonic: { chainId: 146, fallbacks: ["https://rpc.soniclabs.com"], logLookback: 200_000 },
  berachain: { chainId: 80094, fallbacks: ["https://rpc.berachain.com"], logLookback: 100_000 },
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

const KNOWN_SIGNATURES = [
  "acceptOwnership()",
  "accessControlManager()",
  "approve(address,uint256)",
  "allowance(address,address)",
  "asset()",
  "balanceOf(address)",
  "borrow(uint256)",
  "borrow(address,uint256)",
  "borrow(address,uint256,uint256)",
  "borrowBehalf(address,uint256)",
  "burn(uint256)",
  "burn(address,uint256)",
  "claim()",
  "claim(address)",
  "collateral()",
  "collateralToken()",
  "convertToAssets(uint256)",
  "convertToShares(uint256)",
  "decimals()",
  "deposit(uint256)",
  "deposit(uint256,address)",
  "deposit(address,uint256)",
  "exchangeRate()",
  "getAccountLiquidity(address)",
  "getAssetPrice(address)",
  "getPrice(address)",
  "grantRole(bytes32,address)",
  "hasRole(bytes32,address)",
  "initialize(address,address)",
  "liquidate(address)",
  "liquidate(address,uint256)",
  "liquidate(address,address,uint256)",
  "mint(uint256)",
  "mint(address,uint256)",
  "minter()",
  "name()",
  "oracle()",
  "owner()",
  "pause()",
  "paused()",
  "price()",
  "redeem(uint256)",
  "redeem(uint256,address,address)",
  "repay(uint256)",
  "repay(address,uint256)",
  "repayBorrow(uint256)",
  "revokeRole(bytes32,address)",
  "setMinter(address)",
  "symbol()",
  "totalAssets()",
  "totalBorrow()",
  "totalDebt()",
  "totalSupply()",
  "transfer(address,uint256)",
  "transferFrom(address,address,uint256)",
  "unpause()",
  "upgradeTo(address)",
  "upgradeToAndCall(address,bytes)",
  "withdraw(uint256)",
  "withdraw(uint256,address,address)",
  "withdraw(address,uint256)",
];

const KNOWN_SELECTOR_MAP = new Map(KNOWN_SIGNATURES.map((sig) => [selector(sig), sig]));

const HIGH_INTEREST_RE =
  /(mint|burn|borrow|repay|redeem|withdraw|deposit|liquidat|collateral|oracle|price|exchange|convert|claim|harvest|sweep|pause|role|owner|admin|upgrade|set|minter|treasury|vault|router|bridge|permit|whitelist|blacklist|cap|ltv|fee|debt|asset)/i;
const MONEY_PATH_RE = /(mint|borrow|redeem|withdraw|deposit|liquidat|repay|convert|claim|harvest|sweep|debt|collateral)/i;
const ADMIN_RE = /(owner|admin|role|upgrade|pause|set|minter|treasury|whitelist|blacklist|cap|ltv|fee)/i;

const EVENT_TOPIC_MAP = new Map(
  [
    "Transfer(address,address,uint256)",
    "Approval(address,address,uint256)",
    "OwnershipTransferred(address,address)",
    "RoleGranted(bytes32,address,address)",
    "RoleRevoked(bytes32,address,address)",
    "Paused(address)",
    "Unpaused(address)",
    "Upgraded(address)",
    "AdminChanged(address,address)",
    "BeaconUpgraded(address)",
    "Deposit(address,address,uint256,uint256)",
    "Withdraw(address,address,address,uint256,uint256)",
    "Mint(address,address,uint256)",
    "Burn(address,address,uint256)",
  ].map((sig) => [id(sig), sig]),
);

const fourByteCache = new Map();
const eventCache = new Map();

function selector(signature) {
  return id(signature).slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function strip0x(x) {
  return String(x || "").replace(/^0x/i, "");
}

function normalizeAddress(value) {
  if (!isAddress(value)) return null;
  try {
    return getAddress(value);
  } catch (_) {
    return String(value).toLowerCase();
  }
}

function addressFromSlot(slot) {
  if (!slot || slot === "0x") return null;
  try {
    if (BigInt(slot) === 0n) return null;
  } catch (_) {
    return null;
  }
  return normalizeAddress("0x" + strip0x(slot).slice(-40));
}

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

async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
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
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

function extractPush4Selectors(bytecode) {
  const hex = strip0x(bytecode).toLowerCase();
  const selectors = new Set();
  for (let i = 0; i + 10 <= hex.length; i += 2) {
    if (hex.slice(i, i + 2) === "63") selectors.add("0x" + hex.slice(i + 2, i + 10));
  }
  return [...selectors].sort();
}

function selectorInterest(signatures) {
  const all = signatures.join(" | ");
  return {
    highInterest: HIGH_INTEREST_RE.test(all),
    moneyPath: MONEY_PATH_RE.test(all),
    admin: ADMIN_RE.test(all),
  };
}

async function lookupSelector(hexSignature) {
  const key = hexSignature.toLowerCase();
  if (fourByteCache.has(key)) return fourByteCache.get(key);
  const known = KNOWN_SELECTOR_MAP.get(key);
  const url = `https://www.4byte.directory/api/v1/signatures/?hex_signature=${key}`;
  const json = await fetchJson(url);
  await sleep(FOURBYTE_DELAY_MS);
  const textSignatures = [];
  if (known) textSignatures.push(known);
  if (json?.results?.length) {
    for (const row of json.results.slice(0, 8)) {
      if (row?.text_signature && !textSignatures.includes(row.text_signature)) textSignatures.push(row.text_signature);
    }
  }
  const result = { hex: key, textSignatures, ...selectorInterest(textSignatures) };
  fourByteCache.set(key, result);
  return result;
}

async function lookupEventTopic(topic0) {
  const key = topic0.toLowerCase();
  if (eventCache.has(key)) return eventCache.get(key);
  const known = EVENT_TOPIC_MAP.get(key);
  const url = `https://www.4byte.directory/api/v1/event-signatures/?hex_signature=${key}`;
  const json = await fetchJson(url);
  await sleep(FOURBYTE_DELAY_MS);
  const textSignatures = [];
  if (known) textSignatures.push(known);
  if (json?.results?.length) {
    for (const row of json.results.slice(0, 8)) {
      if (row?.text_signature && !textSignatures.includes(row.text_signature)) textSignatures.push(row.text_signature);
    }
  }
  const result = { topic0: key, textSignatures, ...selectorInterest(textSignatures) };
  eventCache.set(key, result);
  return result;
}

async function sourcifyStatus(chainId, address) {
  const base = "https://repo.sourcify.dev/contracts";
  const checksummed = normalizeAddress(address);
  const [full, partial] = await Promise.all([
    fetchJson(`${base}/full_match/${chainId}/${checksummed}/metadata.json`),
    fetchJson(`${base}/partial_match/${chainId}/${checksummed}/metadata.json`),
  ]);
  const metadata = full || partial;
  return {
    fullMatch: Boolean(full),
    partialMatch: Boolean(!full && partial),
    contractName: metadata?.settings?.compilationTarget
      ? Object.values(metadata.settings.compilationTarget)[0]
      : metadata?.output?.devdoc?.title || null,
    compiler: metadata?.compiler?.version || null,
  };
}

async function contractMeta(rpc, chainId, label, address) {
  const [code, implSlot, adminSlot, beaconSlot] = await Promise.all([
    rpcCall(rpc, "eth_getCode", [address, "latest"]),
    rpcCall(rpc, "eth_getStorageAt", [address, IMPL_SLOT, "latest"]).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [address, ADMIN_SLOT, "latest"]).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [address, BEACON_SLOT, "latest"]).catch(() => null),
  ]);
  const selectors = code && code !== "0x" ? extractPush4Selectors(code) : [];
  return {
    label,
    address: normalizeAddress(address),
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    eip1967Implementation: addressFromSlot(implSlot),
    eip1967Admin: addressFromSlot(adminSlot),
    eip1967Beacon: addressFromSlot(beaconSlot),
    push4Selectors: selectors,
    sourcify: await sourcifyStatus(chainId, address),
  };
}

async function enrichContract(contract) {
  const selectorDetails = [];
  for (const sel of contract.push4Selectors) selectorDetails.push(await lookupSelector(sel));
  const highInterestSelectors = selectorDetails.filter((x) => x.highInterest);
  const moneyPathSelectors = selectorDetails.filter((x) => x.moneyPath);
  const adminSelectors = selectorDetails.filter((x) => x.admin);
  return { ...contract, selectorDetails, highInterestSelectors, moneyPathSelectors, adminSelectors };
}

async function recentEventTopics(rpc, chainName, addresses, latestBlock) {
  const fromBlock = `0x${Math.max(0, latestBlock - CHAINS[chainName].logLookback).toString(16)}`;
  const toBlock = `0x${latestBlock.toString(16)}`;
  const out = [];
  for (const [label, address] of addresses) {
    try {
      const logs = await rpcCall(rpc, "eth_getLogs", [{ address, fromBlock, toBlock }], 25_000);
      const counts = new Map();
      for (const log of logs || []) {
        const topic0 = String(log.topics?.[0] || "").toLowerCase();
        if (!topic0 || topic0 === "0x") continue;
        counts.set(topic0, (counts.get(topic0) || 0) + 1);
      }
      const topics = [];
      for (const [topic0, count] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
        topics.push({ ...(await lookupEventTopic(topic0)), count });
      }
      out.push({ label, address: normalizeAddress(address), fromBlock: Number(BigInt(fromBlock)), toBlock: latestBlock, logCount: logs?.length || 0, topics });
    } catch (err) {
      out.push({ label, address: normalizeAddress(address), fromBlock: Number(BigInt(fromBlock)), toBlock: latestBlock, error: err.message || String(err) });
    }
  }
  return out;
}

function uniqueAddressRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const address = normalizeAddress(row.address);
    if (!address || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    out.push({ ...row, address });
  }
  return out;
}

function summarizeChain(chainResult) {
  const contracts = chainResult.contracts || [];
  const moneySelectors = contracts.flatMap((c) =>
    (c.moneyPathSelectors || []).map((s) => ({ contract: c.label, address: c.address, hex: s.hex, signatures: s.textSignatures.slice(0, 4) })),
  );
  const adminSelectors = contracts.flatMap((c) =>
    (c.adminSelectors || []).map((s) => ({ contract: c.label, address: c.address, hex: s.hex, signatures: s.textSignatures.slice(0, 4) })),
  );
  const sourceMatches = contracts.filter((c) => c.sourcify?.fullMatch || c.sourcify?.partialMatch).map((c) => ({ label: c.label, address: c.address, sourcify: c.sourcify }));
  return {
    contractCount: contracts.length,
    sourceMatchCount: sourceMatches.length,
    sourceMatches,
    moneySelectorCount: moneySelectors.length,
    adminSelectorCount: adminSelectors.length,
    moneySelectors: moneySelectors.slice(0, 30),
    adminSelectors: adminSelectors.slice(0, 30),
  };
}

async function scanChain(chainName) {
  const cfg = CONFIG[chainName];
  const chainId = CHAINS[chainName].chainId;
  const rpc = await resolveRpc(chainName);
  if (!rpc) return { chain: chainName, chainId, rpcResolved: false, error: "missing-rpc" };
  const latestBlock = Number(BigInt(await rpcCall(rpc, "eth_blockNumber", [])));

  const initialRows = uniqueAddressRows([
    { label: "poolProxy", address: cfg.poolAddress },
    { label: "usdaToken", address: cfg.usdaAddress },
    ...cfg.tokens.map((t) => ({ label: `token:${t.label}`, address: t.address })),
  ]);

  const initialContracts = [];
  for (const row of initialRows) initialContracts.push(await contractMeta(rpc, chainId, row.label, row.address));

  const implementationRows = uniqueAddressRows(
    initialContracts.flatMap((c) => [
      c.eip1967Implementation ? { label: `${c.label}:implementation`, address: c.eip1967Implementation } : null,
      c.eip1967Beacon ? { label: `${c.label}:beacon`, address: c.eip1967Beacon } : null,
    ]).filter(Boolean),
  );

  const implementationContracts = [];
  for (const row of implementationRows) implementationContracts.push(await contractMeta(rpc, chainId, row.label, row.address));

  const allContracts = [];
  for (const contract of [...initialContracts, ...implementationContracts]) allContracts.push(await enrichContract(contract));

  const eventTargets = [
    ["poolProxy", cfg.poolAddress],
    ["usdaToken", cfg.usdaAddress],
    ...implementationRows.map((r) => [r.label, r.address]),
  ];
  const events = await recentEventTopics(rpc, chainName, eventTargets, latestBlock);

  const chainResult = {
    chain: chainName,
    chainId,
    rpcResolved: true,
    blockNumber: latestBlock,
    contracts: allContracts,
    recentEvents: events,
  };
  return { ...chainResult, summary: summarizeChain(chainResult) };
}

async function main() {
  const results = [];
  for (const chainName of Object.keys(CONFIG)) {
    console.log(`Recovering Avalon selectors on ${chainName}...`);
    results.push(await scanChain(chainName));
  }

  const globalMoneySelectors = results.flatMap((r) => (r.summary?.moneySelectors || []).map((x) => ({ chain: r.chain, ...x })));
  const globalSourceMatches = results.flatMap((r) => (r.summary?.sourceMatches || []).map((x) => ({ chain: r.chain, ...x })));
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/recover-avalon-usda-selectors.js",
    safety: {
      rpcUrlsStored: false,
      signedActions: false,
      stateChangingCalls: false,
      publicApis: ["4byte.directory", "repo.sourcify.dev"],
    },
    sources: [
      "https://www.4byte.directory/",
      "https://repo.sourcify.dev/",
      "reports/raw/fast/avalon-usda-recon.json",
      "reports/raw/fast/avalon-usda-live.json",
    ],
    summary: {
      chainsScanned: results.filter((r) => r.rpcResolved).length,
      chainsMissingRpc: results.filter((r) => !r.rpcResolved).map((r) => r.chain),
      sourceMatchCount: globalSourceMatches.length,
      moneySelectorCount: globalMoneySelectors.length,
      topMoneySelectors: globalMoneySelectors.slice(0, 50),
      sourceMatches: globalSourceMatches,
    },
    results,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");

  console.log(
    `Avalon selector recovery wrote ${path.relative(WORKSPACE, OUT)}; chains=${artifact.summary.chainsScanned}; sourceMatches=${artifact.summary.sourceMatchCount}; moneySelectors=${artifact.summary.moneySelectorCount}`,
  );
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
