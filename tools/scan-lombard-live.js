#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { AbiCoder, Interface, getAddress, id, keccak256 } = require("ethers");

const WORKSPACE = path.join(__dirname, "..");
const TARGET = path.join(WORKSPACE, "targets", "lombard-evm-smart-contracts");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const DEPLOYMENTS = path.join(TARGET, "mainnet.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "lombard-live.json");
const RPC_TIMEOUT_MS = 20_000;
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const CHAINS = {
  mainnet: { chainId: 1, rpcMatch: /ethereum|mainnet/i },
  bsc: { chainId: 56, rpcMatch: /bsc|binance|bnb/i },
  base: { chainId: 8453, rpcMatch: /base/i },
  berachain: { chainId: 80094, rpcMatch: /bera/i },
  sonic: { chainId: 146, rpcMatch: /sonic/i },
  ink: { chainId: 57073, rpcMatch: /ink/i },
  scroll: { chainId: 534352, rpcMatch: /scroll/i },
  avalanche: { chainId: 43114, rpcMatch: /avalanche|avax/i },
};

const ABI = AbiCoder.defaultAbiCoder();
const ZERO32 = "0x" + "0".repeat(64);

const ERC20_IFACE = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function paused() view returns (bool)",
  "function mintBurnPaused() view returns (bool)",
  "function getTreasury() view returns (address)",
  "function getAssetRouter() view returns (address)",
  "function Bascule() view returns (address)",
  "function isRedeemsEnabled() view returns (bool)",
  "function ratio() view returns (uint256)",
  "function getRate() view returns (uint256)",
  "function getRedeemFee() view returns (uint256)",
  "function getRedeemForBtcMinAmount() view returns (uint256)",
  "function getMintFee() view returns (uint256)",
  "function consortium() view returns (address)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function mint(address,uint256)",
  "function burn(address,uint256)",
  "function changeNameAndSymbol(string,string)",
  "function changeAssetRouter(address)",
  "function pauseTransfers()",
  "function pauseMintBurn()",
]);

const ROUTER_IFACE = new Interface([
  "function nativeToken() view returns (address)",
  "function mailbox() view returns (address)",
  "function bascule() view returns (address)",
  "function bitcoinChainId() view returns (bytes32)",
  "function tokenConfig(address) view returns (uint256 redeemFee,uint256 redeemForBtcMinAmount,bool isRedeemEnabled)",
  "function oracle(address) view returns (address)",
  "function maxMintCommission(address) view returns (uint256)",
  "function toNativeCommission(address) view returns (uint64)",
  "function depositMinAmount(address) view returns (uint256)",
  "function ratio(address) view returns (uint256)",
  "function getRate(address) view returns (uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function changeBascule(address)",
  "function changeNativeToken(address)",
  "function changeOracle(address,address)",
  "function setMaxMintCommission(address,uint256)",
  "function mint(bytes,bytes)",
]);

const CONSORTIUM_IFACE = new Interface([
  "function owner() view returns (address)",
  "function curEpoch() view returns (uint256)",
  "function getValidatorSet(uint256) view returns (tuple(address[] validators,uint256[] weights,uint256 weightThreshold))",
  "function setNextValidatorSet(bytes,bytes)",
]);

const BASCULE_IFACE = new Interface([
  "function paused() view returns (bool)",
  "function validateThreshold() view returns (uint256)",
  "function maxDeposits() view returns (uint256)",
  "function maxMints() view returns (uint256)",
  "function trustedSigner() view returns (address)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function updateValidateThreshold(uint256)",
  "function reportDeposits(bytes32,bytes32[])",
]);

const MAILBOX_IFACE = new Interface([
  "function paused() view returns (bool)",
  "function consortium() view returns (address)",
  "function getDefaultMaxPayloadSize() view returns (uint32)",
  "function getSenderConfigWithDefault(address) view returns (tuple(uint32 maxPayloadSize,bool feeDisabled))",
  "function hasRole(bytes32,address) view returns (bool)",
  "function withdrawFee()",
  "function rescueERC20(address,address,uint256)",
]);

const ROLES = {
  DEFAULT_ADMIN_ROLE: ZERO32,
  PAUSER_ROLE: id("PAUSER_ROLE"),
  MINT_BURN_PAUSER_ROLE: id("MINT_BURN_PAUSER_ROLE"),
  MINTER_ROLE: id("MINTER_ROLE"),
  CLAIMER_ROLE: id("CLAIMER_ROLE"),
  OPERATOR_ROLE: id("OPERATOR_ROLE"),
  CALLER_ROLE: id("CALLER_ROLE"),
  TREASURER_ROLE: id("TREASURER_ROLE"),
  DEPOSIT_REPORTER_ROLE: id("DEPOSIT_REPORTER_ROLE"),
  WITHDRAWAL_VALIDATOR_ROLE: id("WITHDRAWAL_VALIDATOR_ROLE"),
  VALIDATION_GUARDIAN_ROLE: id("VALIDATION_GUARDIAN_ROLE"),
  MINT_REPORTER_ROLE: id("MINT_REPORTER_ROLE"),
  MINT_VALIDATOR_ROLE: id("MINT_VALIDATOR_ROLE"),
};

function sanitize(text) {
  return String(text || "").replace(/https?:\/\/\S+/g, "[redacted-url]");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
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
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${sanitize(text.slice(0, 200))}`);
    const json = JSON.parse(text);
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveRpc(chainName, chainId) {
  const cfg = CHAINS[chainName];
  const urls = extractRpcUrls();
  const preferred = urls.filter((url) => cfg?.rpcMatch?.test(url));
  const candidates = [...preferred, ...urls.filter((url) => !preferred.includes(url))];
  const seen = new Set();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const got = Number(BigInt(await rpcCall(url, "eth_chainId", [], 5000)));
      if (got === chainId) return url;
    } catch (_) {
      // Never print RPC URLs.
    }
  }
  return null;
}

function toHexBlock(block) {
  return `0x${BigInt(block).toString(16)}`;
}

function storageAddress(word) {
  if (!word || word === "0x" || BigInt(word) === 0n) return null;
  return normalizeAddress("0x" + word.slice(-40));
}

function normalizeAddress(value) {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(String(value))) return null;
  try {
    return getAddress(value);
  } catch (_) {
    return String(value).toLowerCase();
  }
}

function codeHash(code) {
  if (!code || code === "0x") return null;
  return keccak256(code);
}

function asBool(value) {
  return Boolean(value);
}

function toSerializable(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toSerializable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toSerializable(v)]));
  return value;
}

function formatUnits(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = value % scale;
  const fracText = frac.toString().padStart(Number(decimals), "0").replace(/0+$/g, "").slice(0, 12);
  return fracText ? `${whole}.${fracText}` : whole.toString();
}

async function ethCall(rpc, to, iface, fn, args = [], from = undefined) {
  const data = iface.encodeFunctionData(fn, args);
  const tx = { to, data };
  if (from) tx.from = from;
  const result = await rpcCall(rpc, "eth_call", [tx, "latest"]);
  return iface.decodeFunctionResult(fn, result);
}

async function safeCall(rpc, to, iface, fn, args = [], from = undefined) {
  try {
    return { ok: true, value: [...await ethCall(rpc, to, iface, fn, args, from)] };
  } catch (err) {
    return { ok: false, error: sanitize(err.message || String(err)).slice(0, 180) };
  }
}

async function safeOne(rpc, to, iface, fn, args = []) {
  const result = await safeCall(rpc, to, iface, fn, args);
  return result.ok ? result.value[0] : null;
}

async function probe(rpc, to, iface, fn, args = []) {
  const result = await safeCall(rpc, to, iface, fn, args, PROBE_FROM);
  return { function: fn, success: result.ok, error: result.ok ? null : result.error };
}

async function hasRole(rpc, contract, iface, role, account) {
  const result = await safeOne(rpc, contract, iface, "hasRole", [role, account]);
  return result === null ? null : Boolean(result);
}

async function proxyInfo(rpc, address) {
  const [code, implWord, adminWord] = await Promise.all([
    rpcCall(rpc, "eth_getCode", [address, "latest"]).catch(() => "0x"),
    rpcCall(rpc, "eth_getStorageAt", [address, IMPL_SLOT, "latest"]).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [address, ADMIN_SLOT, "latest"]).catch(() => null),
  ]);
  const implementation = storageAddress(implWord);
  const admin = storageAddress(adminWord);
  const implCode = implementation ? await rpcCall(rpc, "eth_getCode", [implementation, "latest"]).catch(() => "0x") : "0x";
  return {
    exists: code && code !== "0x",
    codeHash: codeHash(code),
    implementation,
    implementationCodeHash: codeHash(implCode),
    admin,
  };
}

async function scanToken(rpc, chainName, label, address) {
  if (!address) return null;
  const info = await proxyInfo(rpc, address);
  const decimals = await safeOne(rpc, address, ERC20_IFACE, "decimals");
  const supply = await safeOne(rpc, address, ERC20_IFACE, "totalSupply");
  const roleChecks = {};
  for (const [name, role] of Object.entries({
    DEFAULT_ADMIN_ROLE: ROLES.DEFAULT_ADMIN_ROLE,
    MINTER_ROLE: ROLES.MINTER_ROLE,
    CLAIMER_ROLE: ROLES.CLAIMER_ROLE,
    PAUSER_ROLE: ROLES.PAUSER_ROLE,
    MINT_BURN_PAUSER_ROLE: ROLES.MINT_BURN_PAUSER_ROLE,
  })) {
    roleChecks[`probe_${name}`] = await hasRole(rpc, address, ERC20_IFACE, role, PROBE_FROM);
  }

  const probes = await Promise.all([
    probe(rpc, address, ERC20_IFACE, "mint", [PROBE_FROM, 1n]),
    probe(rpc, address, ERC20_IFACE, "burn", [PROBE_FROM, 1n]),
    probe(rpc, address, ERC20_IFACE, "changeNameAndSymbol", ["x", "x"]),
    probe(rpc, address, ERC20_IFACE, "changeAssetRouter", [PROBE_FROM]),
    probe(rpc, address, ERC20_IFACE, "pauseTransfers"),
    probe(rpc, address, ERC20_IFACE, "pauseMintBurn"),
  ]);

  const bascule = await safeOne(rpc, address, ERC20_IFACE, "Bascule").then(normalizeAddress);
  const assetRouter = await safeOne(rpc, address, ERC20_IFACE, "getAssetRouter").then(normalizeAddress);

  return {
    label,
    address,
    ...info,
    name: await safeOne(rpc, address, ERC20_IFACE, "name"),
    symbol: await safeOne(rpc, address, ERC20_IFACE, "symbol"),
    decimals,
    totalSupply: supply,
    totalSupplyHuman: decimals === null || supply === null ? null : formatUnits(supply, Number(decimals)),
    paused: await safeOne(rpc, address, ERC20_IFACE, "paused").then((x) => x === null ? null : asBool(x)),
    mintBurnPaused: await safeOne(rpc, address, ERC20_IFACE, "mintBurnPaused").then((x) => x === null ? null : asBool(x)),
    treasury: await safeOne(rpc, address, ERC20_IFACE, "getTreasury").then(normalizeAddress),
    assetRouter,
    bascule,
    isRedeemsEnabled: await safeOne(rpc, address, ERC20_IFACE, "isRedeemsEnabled").then((x) => x === null ? null : asBool(x)),
    ratio: await safeOne(rpc, address, ERC20_IFACE, "ratio"),
    rate: await safeOne(rpc, address, ERC20_IFACE, "getRate"),
    redeemFee: await safeOne(rpc, address, ERC20_IFACE, "getRedeemFee"),
    redeemForBtcMinAmount: await safeOne(rpc, address, ERC20_IFACE, "getRedeemForBtcMinAmount"),
    mintFee: await safeOne(rpc, address, ERC20_IFACE, "getMintFee"),
    consortium: await safeOne(rpc, address, ERC20_IFACE, "consortium").then(normalizeAddress),
    probeRoles: roleChecks,
    arbitrarySenderProbes: probes,
    chain: chainName,
  };
}

async function scanRouter(rpc, address, tokenAddresses) {
  if (!address) return null;
  const info = await proxyInfo(rpc, address);
  const roles = {};
  for (const [name, role] of Object.entries({
    DEFAULT_ADMIN_ROLE: ROLES.DEFAULT_ADMIN_ROLE,
    OPERATOR_ROLE: ROLES.OPERATOR_ROLE,
    CALLER_ROLE: ROLES.CALLER_ROLE,
    CLAIMER_ROLE: ROLES.CLAIMER_ROLE,
  })) {
    roles[`probe_${name}`] = await hasRole(rpc, address, ROUTER_IFACE, role, PROBE_FROM);
  }
  const tokenConfigs = {};
  for (const [label, token] of Object.entries(tokenAddresses)) {
    if (!token) continue;
    const cfg = await safeCall(rpc, address, ROUTER_IFACE, "tokenConfig", [token]);
    tokenConfigs[label] = {
      token,
      tokenConfig: cfg.ok ? { redeemFee: cfg.value[0], redeemForBtcMinAmount: cfg.value[1], isRedeemEnabled: cfg.value[2] } : null,
      oracle: await safeOne(rpc, address, ROUTER_IFACE, "oracle", [token]).then(normalizeAddress),
      maxMintCommission: await safeOne(rpc, address, ROUTER_IFACE, "maxMintCommission", [token]),
      toNativeCommission: await safeOne(rpc, address, ROUTER_IFACE, "toNativeCommission", [token]),
      depositMinAmount: await safeOne(rpc, address, ROUTER_IFACE, "depositMinAmount", [token]),
      ratio: await safeOne(rpc, address, ROUTER_IFACE, "ratio", [token]),
      rate: await safeOne(rpc, address, ROUTER_IFACE, "getRate", [token]),
    };
  }
  return {
    address,
    ...info,
    nativeToken: await safeOne(rpc, address, ROUTER_IFACE, "nativeToken").then(normalizeAddress),
    mailbox: await safeOne(rpc, address, ROUTER_IFACE, "mailbox").then(normalizeAddress),
    bascule: await safeOne(rpc, address, ROUTER_IFACE, "bascule").then(normalizeAddress),
    bitcoinChainId: await safeOne(rpc, address, ROUTER_IFACE, "bitcoinChainId"),
    tokenConfigs,
    probeRoles: roles,
    arbitrarySenderProbes: await Promise.all([
      probe(rpc, address, ROUTER_IFACE, "changeBascule", [PROBE_FROM]),
      probe(rpc, address, ROUTER_IFACE, "changeNativeToken", [PROBE_FROM]),
      probe(rpc, address, ROUTER_IFACE, "changeOracle", [Object.values(tokenAddresses).filter(Boolean)[0] || PROBE_FROM, PROBE_FROM]),
      probe(rpc, address, ROUTER_IFACE, "setMaxMintCommission", [Object.values(tokenAddresses).filter(Boolean)[0] || PROBE_FROM, 1n]),
      probe(rpc, address, ROUTER_IFACE, "mint", ["0x", "0x"]),
    ]),
  };
}

async function scanConsortium(rpc, address) {
  if (!address) return null;
  const info = await proxyInfo(rpc, address);
  const epoch = await safeOne(rpc, address, CONSORTIUM_IFACE, "curEpoch");
  let validatorSet = null;
  if (epoch !== null) {
    const result = await safeCall(rpc, address, CONSORTIUM_IFACE, "getValidatorSet", [epoch]);
    if (result.ok) {
      const set = result.value[0];
      const weights = [...set.weights].map((x) => BigInt(x));
      const weightThreshold = BigInt(set.weightThreshold);
      const totalWeight = weights.reduce((acc, x) => acc + x, 0n);
      validatorSet = {
        validators: [...set.validators].map(normalizeAddress),
        weights,
        weightThreshold,
        totalWeight,
        thresholdBps: totalWeight === 0n ? null : Number(weightThreshold * 10000n / totalWeight),
      };
    }
  }
  return {
    address,
    ...info,
    owner: await safeOne(rpc, address, CONSORTIUM_IFACE, "owner").then(normalizeAddress),
    curEpoch: epoch,
    validatorSet,
    arbitrarySenderProbes: [await probe(rpc, address, CONSORTIUM_IFACE, "setNextValidatorSet", ["0x", "0x"])],
  };
}

async function scanBascule(rpc, label, address) {
  if (!address) return null;
  const info = await proxyInfo(rpc, address);
  const roleChecks = {};
  for (const [name, role] of Object.entries({
    DEFAULT_ADMIN_ROLE: ROLES.DEFAULT_ADMIN_ROLE,
    PAUSER_ROLE: ROLES.PAUSER_ROLE,
    DEPOSIT_REPORTER_ROLE: ROLES.DEPOSIT_REPORTER_ROLE,
    WITHDRAWAL_VALIDATOR_ROLE: ROLES.WITHDRAWAL_VALIDATOR_ROLE,
    VALIDATION_GUARDIAN_ROLE: ROLES.VALIDATION_GUARDIAN_ROLE,
    MINT_REPORTER_ROLE: ROLES.MINT_REPORTER_ROLE,
    MINT_VALIDATOR_ROLE: ROLES.MINT_VALIDATOR_ROLE,
  })) {
    roleChecks[`probe_${name}`] = await hasRole(rpc, address, BASCULE_IFACE, role, PROBE_FROM);
  }
  return {
    label,
    address,
    ...info,
    paused: await safeOne(rpc, address, BASCULE_IFACE, "paused").then((x) => x === null ? null : asBool(x)),
    validateThreshold: await safeOne(rpc, address, BASCULE_IFACE, "validateThreshold"),
    maxDeposits: await safeOne(rpc, address, BASCULE_IFACE, "maxDeposits"),
    maxMints: await safeOne(rpc, address, BASCULE_IFACE, "maxMints"),
    trustedSigner: await safeOne(rpc, address, BASCULE_IFACE, "trustedSigner").then(normalizeAddress),
    probeRoles: roleChecks,
    arbitrarySenderProbes: await Promise.all([
      probe(rpc, address, BASCULE_IFACE, "updateValidateThreshold", [1n]),
      probe(rpc, address, BASCULE_IFACE, "reportDeposits", [ZERO32, []]),
    ]),
  };
}

async function scanMailbox(rpc, address, tokenAddress) {
  if (!address) return null;
  const info = await proxyInfo(rpc, address);
  const roleChecks = {};
  for (const [name, role] of Object.entries({
    DEFAULT_ADMIN_ROLE: ROLES.DEFAULT_ADMIN_ROLE,
    PAUSER_ROLE: ROLES.PAUSER_ROLE,
    TREASURER_ROLE: ROLES.TREASURER_ROLE,
  })) {
    roleChecks[`probe_${name}`] = await hasRole(rpc, address, MAILBOX_IFACE, role, PROBE_FROM);
  }
  const senderCfg = tokenAddress ? await safeCall(rpc, address, MAILBOX_IFACE, "getSenderConfigWithDefault", [tokenAddress]) : { ok: false };
  return {
    address,
    ...info,
    paused: await safeOne(rpc, address, MAILBOX_IFACE, "paused").then((x) => x === null ? null : asBool(x)),
    consortium: await safeOne(rpc, address, MAILBOX_IFACE, "consortium").then(normalizeAddress),
    defaultMaxPayloadSize: await safeOne(rpc, address, MAILBOX_IFACE, "getDefaultMaxPayloadSize"),
    tokenSenderConfig: senderCfg.ok ? { maxPayloadSize: senderCfg.value[0].maxPayloadSize, feeDisabled: senderCfg.value[0].feeDisabled } : null,
    probeRoles: roleChecks,
    arbitrarySenderProbes: await Promise.all([
      probe(rpc, address, MAILBOX_IFACE, "withdrawFee"),
      probe(rpc, address, MAILBOX_IFACE, "rescueERC20", [tokenAddress || PROBE_FROM, PROBE_FROM, 1n]),
    ]),
  };
}

function collectAddresses(config) {
  const lombard = config.lombard || {};
  return {
    StakedLBTC: normalizeAddress(lombard.StakedLBTC),
    NativeLBTC: normalizeAddress(lombard.NativeLBTC),
    AssetRouter: normalizeAddress(lombard.AssetRouter),
    Consortium: normalizeAddress(lombard.Consortium),
    Mailbox: normalizeAddress(lombard.Mailbox),
    StakedLBTCOracle: normalizeAddress(lombard.StakedLBTCOracle),
    GMPBasculeV1: normalizeAddress(lombard.GMPBasculeV1),
    Bascule: normalizeAddress(config.cubist?.Bascule || config.cubist?.BasculeV2),
    ChainlinkPoolStaked: normalizeAddress(config.chainlink?.LombardTokenPoolV2_stakedLBTC),
    ChainlinkPoolNative: normalizeAddress(config.chainlink?.LombardTokenPoolV2_nativeLBTC),
    OFTAdapter: normalizeAddress(config.layerZero?.LBTCBurnMintOFTAdapter || Object.values(config.layerZero || {})[0]),
  };
}

async function fetchLlama() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const response = await fetch("https://api.llama.fi/protocol/lombard", { signal: controller.signal });
    const json = await response.json();
    clearTimeout(timeout);
    const tvl = Array.isArray(json.tvl) && json.tvl.length ? json.tvl[json.tvl.length - 1].totalLiquidityUSD : null;
    return { name: json.name, slug: json.slug, latestTvlUsd: tvl, chains: json.chains || null };
  } catch (err) {
    return { error: sanitize(err.message || String(err)) };
  }
}

async function scanChain(chainName, config) {
  const chainId = Number(BigInt(config.chainId));
  if (!Object.values(CHAINS).some((x) => x.chainId === chainId)) return { chainName, chainId, skipped: "unsupported-local-rpc-chain" };
  const rpc = await resolveRpc(chainName, chainId);
  if (!rpc) return { chainName, chainId, skipped: "no-rpc-in-local-inventory" };

  const blockNumber = Number(BigInt(await rpcCall(rpc, "eth_blockNumber", [])));
  const addresses = collectAddresses(config);
  const present = Object.fromEntries(Object.entries(addresses).filter(([, value]) => value));
  const tokenAddresses = {
    StakedLBTC: addresses.StakedLBTC,
    NativeLBTC: addresses.NativeLBTC,
  };
  const tokens = {};
  if (addresses.StakedLBTC) tokens.StakedLBTC = await scanToken(rpc, chainName, "StakedLBTC", addresses.StakedLBTC);
  if (addresses.NativeLBTC) tokens.NativeLBTC = await scanToken(rpc, chainName, "NativeLBTC", addresses.NativeLBTC);

  const router = await scanRouter(rpc, addresses.AssetRouter, tokenAddresses);
  const consortium = await scanConsortium(rpc, addresses.Consortium);
  const mailbox = await scanMailbox(rpc, addresses.Mailbox, addresses.StakedLBTC || addresses.NativeLBTC);
  const bascules = {};
  if (addresses.Bascule) bascules.Bascule = await scanBascule(rpc, "Bascule", addresses.Bascule);
  if (addresses.GMPBasculeV1) bascules.GMPBasculeV1 = await scanBascule(rpc, "GMPBasculeV1", addresses.GMPBasculeV1);
  if (router?.bascule && !Object.values(bascules).some((b) => b?.address?.toLowerCase() === router.bascule.toLowerCase())) {
    bascules.RouterBascule = await scanBascule(rpc, "RouterBascule", router.bascule);
  }

  const extraContracts = {};
  for (const key of ["StakedLBTCOracle", "ChainlinkPoolStaked", "ChainlinkPoolNative", "OFTAdapter"]) {
    if (addresses[key]) extraContracts[key] = await proxyInfo(rpc, addresses[key]);
  }

  const successfulProbes = [
    ...Object.values(tokens).flatMap((token) => token?.arbitrarySenderProbes || []),
    ...(router?.arbitrarySenderProbes || []),
    ...(consortium?.arbitrarySenderProbes || []),
    ...(mailbox?.arbitrarySenderProbes || []),
    ...Object.values(bascules).flatMap((b) => b?.arbitrarySenderProbes || []),
  ].filter((x) => x.success);

  return {
    chainName,
    chainId,
    blockNumber,
    addresses: present,
    tokens,
    router,
    consortium,
    mailbox,
    bascules,
    extraContracts,
    successfulArbitrarySenderProbes: successfulProbes,
    verdict: successfulProbes.length ? "REVIEW_ARBITRARY_SENDER_SUCCESS" : "NO_ARBITRARY_SENDER_ADMIN_OR_MINT_SUCCESS",
  };
}

async function main() {
  const deployments = readJson(DEPLOYMENTS);
  const sourceCommit = await new Promise((resolve) => {
    const { execFile } = require("child_process");
    execFile("git", ["rev-parse", "HEAD"], { cwd: TARGET }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });

  const chains = {};
  for (const [chainName, config] of Object.entries(deployments)) {
    chains[chainName] = await scanChain(chainName, config).catch((err) => ({
      chainName,
      chainId: config.chainId ? Number(BigInt(config.chainId)) : null,
      error: sanitize(err.message || String(err)),
    }));
  }

  const scanned = Object.values(chains).filter((x) => !x.skipped && !x.error);
  const successfulProbeCount = scanned.reduce((acc, chain) => acc + (chain.successfulArbitrarySenderProbes?.length || 0), 0);
  const output = {
    generatedAt: new Date().toISOString(),
    source: {
      repo: "https://github.com/lombard-finance/evm-smart-contracts",
      path: path.relative(WORKSPACE, TARGET),
      commit: sourceCommit,
      deploymentFile: path.relative(WORKSPACE, DEPLOYMENTS),
    },
    llama: await fetchLlama(),
    scannedChains: scanned.length,
    skippedChains: Object.values(chains).filter((x) => x.skipped).length,
    successfulArbitrarySenderProbeCount: successfulProbeCount,
    verdict: successfulProbeCount ? "REVIEW_ARBITRARY_SENDER_SUCCESS" : "NO_ARBITRARY_SENDER_ADMIN_OR_MINT_SUCCESS",
    chains,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(toSerializable(output), null, 2) + "\n");
  console.log(`Wrote ${path.relative(WORKSPACE, OUT)}`);
  console.log(`scanned=${output.scannedChains} skipped=${output.skippedChains} arbitrarySenderSuccesses=${successfulProbeCount} verdict=${output.verdict}`);
}

main().catch((err) => {
  console.error(sanitize(err.stack || err.message || String(err)));
  process.exit(1);
});
