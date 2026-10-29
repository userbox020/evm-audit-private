#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AbiCoder, getAddress, id } = require("ethers");

const WORKSPACE = path.join(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "bouncebit-cedefi-yield-live.json");
const LLAMA_PROTOCOL_URL = "https://api.llama.fi/protocol/bouncebit-cedefi-yield";
const ADAPTER_BASE = "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/bouncebit-cedefi";
const RPC_TIMEOUT_MS = 20_000;
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = "0x" + "0".repeat(64);
const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
const PDA_MARKER = Buffer.from("ProgramDerivedAddress");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ED25519_P = (1n << 255n) - 19n;
const ED25519_D = mod(-121665n * modInv(121666n), ED25519_P);
const ABI = AbiCoder.defaultAbiCoder();

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const ADDR = {
  BBTC: "0xF5e11df1ebCf78b6b6D26E04FF19cD786a1e81dC",
  stBBTC: "0x7F150c293c97172C75983BD8ac084c187107eA19",
  BBUSD: "0x77776b40C3d75cb07ce54dEA4b2Fd1D07F865222",
  ETH_USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  ETH_USDe: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
  BSC_USDT: "0x55d398326f99059fF775485246999027B3197955",
  BSC_BTCB: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
};

const SOLANA_MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

const CHAINS = {
  ethereum: {
    chainId: 1,
    fallbackRpcs: ["https://ethereum.publicnode.com", "https://rpc.ankr.com/eth"],
    tokens: [ADDR.BBTC, ADDR.ETH_USDT, ADDR.ETH_USDe],
    contracts: [
      { key: "easybtcUsdStake", kind: "simpleStake", address: "0xFe32277D00e57D864B8BC687d0a442D663Aa1dF6", adapterAsset: ADDR.ETH_USDT },
      { key: "premiumOwner1", kind: "ownerBalance", address: "0x1ddD6E5eA766511CC0f348DC8d17578a821B680F", balanceTokens: [ADDR.BBTC] },
      { key: "premiumOwner2", kind: "ownerBalance", address: "0xa2B283e4dbdFEA5461C36a59E3B94b3ef2883085", balanceTokens: [ADDR.BBTC] },
      { key: "ethenaOwner", kind: "ownerBalance", address: "0x96E65d1ae193A15b19500AEA8F7f739989C810ea", balanceTokens: [ADDR.ETH_USDe, ADDR.ETH_USDT] },
    ],
  },
  bsc: {
    chainId: 56,
    fallbackRpcs: ["https://bsc.publicnode.com", "https://bsc-dataseed.binance.org"],
    tokens: [ADDR.BBTC, ADDR.BBUSD, ADDR.BSC_USDT, ADDR.BSC_BTCB],
    contracts: [
      { key: "easybtcUsdStake", kind: "simpleStake", address: "0xF3FB36F32Dad91627f688e7332472d69F6C985c6", adapterAsset: ADDR.BSC_USDT },
      { key: "easybtcBtcStake", kind: "simpleStake", address: "0x38D239a8D33BF7424A1Df6d39cb8523cCc25DE0e", adapterAsset: ADDR.BSC_BTCB },
      { key: "promoSimpleStake", kind: "simpleStake", address: "0x471461A60EC3855DC58E00De81E3510b8945D2f9", adapterAsset: ADDR.BSC_BTCB },
      { key: "premiumOwner1", kind: "ownerBalance", address: "0x55a55e8b08b091bD0529bf1af05b69fF5291867D", balanceTokens: [ADDR.BBTC, ADDR.BBUSD] },
      { key: "premiumOwner2", kind: "ownerBalance", address: "0xdAfd8591402c5E57DCa4B1b9e481c08548a2442E", balanceTokens: [ADDR.BBTC, ADDR.BBUSD] },
    ],
  },
  base: {
    chainId: 8453,
    fallbackRpcs: ["https://base.publicnode.com", "https://mainnet.base.org"],
    tokens: [],
    contracts: [
      { key: "promoPool", kind: "campaignPool", address: "0x131711b38BE467212D328269482EfF626D0Ae586" },
    ],
  },
  bouncebit: {
    chainId: 6001,
    fallbackRpcs: ["https://fullnode-mainnet.bouncebitapi.com"],
    tokens: [ADDR.BBTC, ADDR.BBUSD, ADDR.stBBTC],
    contracts: [
      { key: "stbbtcStake", kind: "simpleStake", address: "0x7F26aB9263E33de947654F44C5AB439090cfAaf7", adapterAsset: ADDR.BBTC },
      { key: "premiumOwner1", kind: "ownerBalance", address: "0xd4def93a10ada7e14cAdc6920b6CDE01148D1813", balanceTokens: [ADDR.BBTC, ADDR.BBUSD] },
      { key: "premiumOwner2", kind: "ownerBalance", address: "0x426CD147ff93f31BB18F1Acd19DAb9c32d934131", balanceTokens: [ADDR.BBTC, ADDR.BBUSD] },
    ],
  },
};

const GRAPH_CONFIGS = [
  {
    key: "ethereum-main",
    chain: "ethereum",
    url: "https://api.studio.thegraph.com/query/96517/bb-defillama-eth/v0.0.4",
    query: "{ tokens { id tvl } _meta { block { number } } }",
  },
  {
    key: "bsc-main",
    chain: "bsc",
    url: "https://api.studio.thegraph.com/query/96517/bb-defillama-bsc/v0.0.2",
    query: "{ tokens { id tvl } _meta { block { number } } }",
  },
  {
    key: "bsc-vip",
    chain: "bsc",
    url: "https://api.studio.thegraph.com/query/96517/bb-vip-defillama-bsc/v0.0.2",
    query: "{ tokens { id tvl } _meta { block { number } } }",
  },
  {
    key: "bouncebit-main",
    chain: "bouncebit",
    url: "https://bitswap-subgraph.bouncebit.io/subgraphs/name/bb-defillama-bb",
    query: "{ tokens { id tvl } _meta { block { number } } }",
  },
  {
    key: "bouncebit-boyya",
    chain: "bouncebit",
    url: "https://bitswap-subgraph.bouncebit.io/subgraphs/name/bb-defillama-boyya-bb",
    query: "{ tokens { id tvl } _meta { block { number } } }",
  },
  {
    key: "v3-ethereum-subscribe",
    chain: "ethereum",
    url: "https://api.studio.thegraph.com/query/109925/portal-eth-v-3/v0.0.1",
    query: "{ tokens(first: 20) { id tvl } _meta { block { number } } }",
  },
  {
    key: "v3-bsc-subscribe",
    chain: "bsc",
    url: "https://api.studio.thegraph.com/query/109925/portal-bsc-v-3/v0.0.1",
    query: "{ tokens(first: 20) { id tvl } _meta { block { number } } }",
  },
  {
    key: "v3-bsc-rewards",
    chain: "bsc",
    url: "https://bitswap-subgraph.bouncebit.io/subgraphs/name/portal-bb-v-3",
    query: "{ tokenRewards(first: 20) { reward tokenMappings { eid oAddress } } _meta { block { number } } }",
  },
  {
    key: "v3-ethereum-eth-reward",
    chain: "ethereum",
    url: "https://bitswap-subgraph.bouncebit.io/subgraphs/name/portal-bb-v-3",
    query: '{ tokenRewards(where: {tokenMappings_: {eid: "30101", oAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}}) { reward } _meta { block { number } } }',
  },
];

const ADAPTER_FILES = ["index.js", "easyBTC.js", "premium.js", "promo.js", "promoFromSolana.js", "cedefiFromSolana.js", "cedefiV3.js"];

const SOLANA_PROGRAMS = {
  cedefiV3: {
    label: "CeDeFi V3",
    programId: "BFVxnJoyUW1xPmaYgsn8NF4GdqPB91Mqqgr7RKaa6YWS",
    accountType: "TokenConfig",
  },
  promo: {
    label: "Promo",
    programId: "5HRzz8VDD9QjpEBBdq6hBUEXcssxW5mPnod4L6Qgnh9g",
    accountType: "PromoVault",
  },
  cedefiV2: {
    label: "CeDeFi V2",
    programId: "65YBWQitcBexwuaBKfAV163xDd4LzVAdytATLbttpgxx",
    accountType: "V2Vault",
  },
};

function sanitize(text) {
  return String(text || "").replace(/https?:\/\/\S+/g, "[redacted-url]");
}

function selector(signature) {
  return id(signature).slice(0, 10);
}

function encodeCall(signature, args = [], types = []) {
  return selector(signature) + (args.length ? ABI.encode(types, args).slice(2) : "");
}

function decodeTuple(data, types) {
  if (!data || data === "0x") return null;
  try {
    return [...ABI.decode(types, data)];
  } catch (_) {
    return null;
  }
}

function decodeOne(data, types) {
  const decoded = decodeTuple(data, types);
  return decoded ? decoded[0] : null;
}

function decodeString(data) {
  if (!data || data === "0x") return null;
  try {
    return String(ABI.decode(["string"], data)[0]);
  } catch (_) {
    try {
      const bytes32 = ABI.decode(["bytes32"], data)[0];
      return Buffer.from(String(bytes32).slice(2), "hex").toString("utf8").replace(/\u0000+$/g, "") || null;
    } catch (_) {
      return null;
    }
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

function bigintJson(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value || "").digest("hex");
}

function extractPush4Selectors(code) {
  const hex = String(code || "").replace(/^0x/i, "").toLowerCase();
  const selectors = new Set();
  for (let i = 0; i + 10 <= hex.length; i += 2) {
    if (hex.slice(i, i + 2) === "63") selectors.add("0x" + hex.slice(i + 2, i + 10));
  }
  return [...selectors].sort();
}

function formatUnits(raw, decimals, maxFrac = 8) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  const value = BigInt(raw);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  const fracText = frac.toString().padStart(Number(decimals), "0").replace(/0+$/g, "").slice(0, maxFrac);
  return fracText ? `${sign}${whole}.${fracText}` : `${sign}${whole}`;
}

function safeNumber(value) {
  if (value === null || value === undefined) return null;
  try {
    return Number(value);
  } catch (_) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const hash = crypto.createHash("sha256");
    for (const seed of [...seeds, Buffer.from([bump])]) hash.update(seed);
    hash.update(programBytes);
    hash.update(PDA_MARKER);
    const digest = hash.digest();
    if (!isOnEd25519CurveBytes(digest)) return { address: base58Encode(digest), bump };
  }
  throw new Error("No valid PDA found");
}

function anchorDiscriminator(name) {
  return crypto.createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function readU64(data, offset) {
  return data.readBigUInt64LE(offset);
}

function readI64(data, offset) {
  return data.readBigInt64LE(offset);
}

function readU128(data, offset) {
  return data.readBigUInt64LE(offset) + (data.readBigUInt64LE(offset + 8) << 64n);
}

function pubkey(data, offset) {
  return base58Encode(data.subarray(offset, offset + 32));
}

function dataBuffer(account) {
  if (!account || !account.data) return null;
  if (Array.isArray(account.data)) return Buffer.from(account.data[0], account.data[1] || "base64");
  if (typeof account.data === "string") return Buffer.from(account.data, "base64");
  return null;
}

function accountSummary(account) {
  if (!account) return null;
  return {
    owner: account.owner || null,
    lamports: account.lamports?.toString?.() || account.lamports || null,
    executable: Boolean(account.executable),
    rentEpoch: account.rentEpoch ?? null,
    dataBytes: dataBuffer(account)?.length || 0,
  };
}

function parseMintAccount(account) {
  const data = dataBuffer(account);
  if (!data || data.length < 82) return null;
  const mintAuthorityOption = data.readUInt32LE(0);
  const freezeAuthorityOption = data.readUInt32LE(46);
  return {
    ownerProgram: account.owner,
    supplyRaw: data.readBigUInt64LE(36).toString(),
    decimals: data.readUInt8(44),
    initialized: Boolean(data.readUInt8(45)),
    mintAuthority: mintAuthorityOption === 1 ? pubkey(data, 4) : null,
    freezeAuthority: freezeAuthorityOption === 1 ? pubkey(data, 50) : null,
  };
}

function parseTokenAccount(account) {
  const data = dataBuffer(account);
  if (!data || data.length < 165) return null;
  return {
    ownerProgram: account.owner,
    mint: pubkey(data, 0),
    owner: pubkey(data, 32),
    amountRaw: data.readBigUInt64LE(64).toString(),
    delegateOption: data.readUInt32LE(72),
    state: data.readUInt8(108),
    delegatedAmountRaw: data.readBigUInt64LE(121).toString(),
    closeAuthorityOption: data.readUInt32LE(129),
  };
}

function parseUpgradeableProgram(programAccount, programDataAccount) {
  const out = {
    account: accountSummary(programAccount),
    expectedOwner: BPF_LOADER_UPGRADEABLE,
    programDataAddress: null,
    programDataSlot: null,
    upgradeAuthority: null,
    elfOffset: null,
    elfSize: null,
    elfSha256: null,
    interestingStrings: [],
  };

  const programData = dataBuffer(programAccount);
  if (programData && programData.length >= 36 && programData.readUInt32LE(0) === 2) out.programDataAddress = base58Encode(programData.subarray(4, 36));

  const data = dataBuffer(programDataAccount);
  if (data) {
    if (data.length >= 48 && data.readUInt32LE(0) === 3) {
      out.programDataSlot = data.readBigUInt64LE(4).toString();
      const optionTag = data.readUInt32LE(12);
      out.upgradeAuthority = optionTag === 1 ? base58Encode(data.subarray(16, 48)) : null;
    }
    const elfOffset = data.indexOf(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    if (elfOffset >= 0) {
      const elf = data.subarray(elfOffset);
      out.elfOffset = elfOffset;
      out.elfSize = elf.length;
      out.elfSha256 = sha256Hex(elf);
      out.interestingStrings = extractInterestingStrings(elf);
    }
  }

  return out;
}

function extractInterestingStrings(buffer) {
  const strings = [];
  let current = [];
  for (const byte of buffer) {
    if (byte >= 32 && byte <= 126) current.push(byte);
    else {
      flush();
    }
  }
  flush();
  return [...new Set(strings)].slice(0, 160);

  function flush() {
    if (current.length >= 5) {
      const value = Buffer.from(current).toString("utf8");
      if (/anchor|bounce|vault|token|config|admin|authority|stake|withdraw|redeem|subscribe|claim|pause|owner|whitelist|seed|error|constraint/i.test(value)) strings.push(value);
    }
    current = [];
  }
}

function parseTokenConfigAccount(address, account) {
  const data = dataBuffer(account);
  if (!data || data.length < 75) return { address, error: "SHORT_DATA", rawBytes: data?.length || 0 };
  let offset = 8;
  const tokenMint = pubkey(data, offset); offset += 32;
  const supported = Boolean(data.readUInt8(offset)); offset += 1;
  const decimals = data.readUInt8(offset); offset += 1;
  const minSubscribeAmount = readU64(data, offset); offset += 8;
  const isNative = Boolean(data.readUInt8(offset)); offset += 1;
  const totalLocked = readU64(data, offset); offset += 8;
  const totalRedeemed = readU64(data, offset); offset += 8;
  const totalClaimed = readU64(data, offset); offset += 8;
  const tvlRaw = totalLocked - totalRedeemed;
  return {
    address,
    account: accountSummary(account),
    tokenMint,
    supported,
    decimals,
    minSubscribeAmountRaw: minSubscribeAmount.toString(),
    isNative,
    totalLockedRaw: totalLocked.toString(),
    totalRedeemedRaw: totalRedeemed.toString(),
    totalClaimedRaw: totalClaimed.toString(),
    tvlRaw: tvlRaw.toString(),
    tvlUi: formatUnits(tvlRaw, decimals),
  };
}

function parsePromoVaultAccount(address, account) {
  const data = dataBuffer(account);
  if (!data || data.length < 123) return { address, error: "SHORT_DATA", rawBytes: data?.length || 0 };
  let offset = 8;
  const isVaultEnable = Boolean(data.readUInt8(offset)); offset += 1;
  const isStakeEnable = Boolean(data.readUInt8(offset)); offset += 1;
  const isWithdrawEnable = Boolean(data.readUInt8(offset)); offset += 1;
  const maxStakeAmount = readU64(data, offset); offset += 8;
  const lockPeriod = readI64(data, offset); offset += 8;
  const fullStakeTimestamp = readI64(data, offset); offset += 8;
  const tokenMint = pubkey(data, offset); offset += 32;
  const tokenEscrow = pubkey(data, offset); offset += 32;
  const totalStaked = readU64(data, offset); offset += 8;
  const totalRewards = readU64(data, offset); offset += 8;
  return {
    address,
    account: accountSummary(account),
    isVaultEnable,
    isStakeEnable,
    isWithdrawEnable,
    maxStakeAmountRaw: maxStakeAmount.toString(),
    lockPeriod: lockPeriod.toString(),
    fullStakeTimestamp: fullStakeTimestamp.toString(),
    tokenMint,
    tokenEscrow,
    totalStakedRaw: totalStaked.toString(),
    totalRewardsRaw: totalRewards.toString(),
  };
}

function parseV2VaultAccount(address, account, expectedTokenMint = null, strategyId = null) {
  const data = dataBuffer(account);
  if (!data || data.length < 155) return { address, error: "SHORT_DATA", rawBytes: data?.length || 0, expectedTokenMint, strategyId };
  let offset = 8;
  const isVaultEnable = Boolean(data.readUInt8(offset)); offset += 1;
  const isOpenEnable = Boolean(data.readUInt8(offset)); offset += 1;
  const isNormalCloseEnable = Boolean(data.readUInt8(offset)); offset += 1;
  const isFastCloseEnable = Boolean(data.readUInt8(offset)); offset += 1;
  const isClaimEnable = Boolean(data.readUInt8(offset)); offset += 1;
  const openCooldownDays = data.readUInt16LE(offset); offset += 2;
  const openDateOffset = data.readUInt16LE(offset); offset += 2;
  const clearingDateNo = data.readUInt16LE(offset); offset += 2;
  const minAmount = readU64(data, offset); offset += 8;
  const totalOpen = readU128(data, offset); offset += 16;
  const totalNormalPrincipalClose = readU128(data, offset); offset += 16;
  const totalNormalSharesClose = readU128(data, offset); offset += 16;
  const totalNormalRewardsClose = readU128(data, offset); offset += 16;
  const totalFastClose = readU128(data, offset); offset += 16;
  const totalFastFee = readU128(data, offset); offset += 16;
  const totalClaimAssets = readU128(data, offset); offset += 16;
  const totalClaimFee = readU128(data, offset); offset += 16;
  const tvlRaw = totalOpen - totalNormalPrincipalClose - totalFastClose;
  return {
    address,
    expectedTokenMint,
    strategyId,
    account: accountSummary(account),
    isVaultEnable,
    isOpenEnable,
    isNormalCloseEnable,
    isFastCloseEnable,
    isClaimEnable,
    openCooldownDays,
    openDateOffset,
    clearingDateNo,
    minAmountRaw: minAmount.toString(),
    totalOpenRaw: totalOpen.toString(),
    totalNormalPrincipalCloseRaw: totalNormalPrincipalClose.toString(),
    totalNormalSharesCloseRaw: totalNormalSharesClose.toString(),
    totalNormalRewardsCloseRaw: totalNormalRewardsClose.toString(),
    totalFastCloseRaw: totalFastClose.toString(),
    totalFastFeeRaw: totalFastFee.toString(),
    totalClaimAssetsRaw: totalClaimAssets.toString(),
    totalClaimFeeRaw: totalClaimFee.toString(),
    tvlRaw: tvlRaw.toString(),
  };
}

async function fetchText(url, timeoutMs = 25_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { "user-agent": "evm-audit-bouncebit/1.0" }, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${sanitize(text.slice(0, 240))}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, timeoutMs = 25_000) {
  return JSON.parse(await fetchText(url, timeoutMs));
}

async function graphQuery(url, query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "evm-audit-bouncebit/1.0" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${sanitize(text.slice(0, 240))}`);
    const json = JSON.parse(text);
    if (json.errors) throw new Error(sanitize(JSON.stringify(json.errors).slice(0, 400)));
    return json.data;
  } finally {
    clearTimeout(timeout);
  }
}

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
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
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${sanitize(text.slice(0, 160))}`);
      const json = JSON.parse(text);
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      return json.result;
    } catch (err) {
      lastError = err;
      const message = String(err.message || err);
      if (!/429|Too Many Requests|rate/i.test(message) || attempt === 4) break;
      await sleep(750 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function resolveEvmRpc(chain) {
  const candidates = [...extractRpcUrls(), ...(chain.fallbackRpcs || [])];
  const seen = new Set();
  let lastError = null;
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const chainId = Number(BigInt(await rpcCall(url, "eth_chainId", [], 5000)));
      if (chainId === chain.chainId) return url;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No chain ${chain.chainId} RPC available (${lastError ? sanitize(lastError.message || lastError) : "unknown"})`);
}

async function callRaw(rpc, to, signature, args = [], types = [], block = "latest", from = undefined) {
  const tx = { to, data: encodeCall(signature, args, types) };
  if (from) tx.from = from;
  return rpcCall(rpc, "eth_call", [tx, block], 10_000);
}

async function callOptional(rpc, to, signature, args = [], types = [], retTypes = null, block = "latest", from = undefined) {
  if (!isAddress(to)) return { ok: false, value: null, raw: null, error: "BAD_ADDRESS" };
  try {
    const raw = await callRaw(rpc, to, signature, args, types, block, from);
    if (!raw || raw === "0x") return { ok: false, value: null, raw, error: "EMPTY" };
    const value = retTypes ? decodeTuple(raw, retTypes) : raw;
    if (retTypes && value === null) return { ok: false, value: null, raw, error: "DECODE" };
    return { ok: true, value, raw, error: null };
  } catch (err) {
    return { ok: false, value: null, raw: null, error: sanitize(err.message || err).slice(0, 180) };
  }
}

async function stateProbe(rpc, to, signature, args = [], types = [], value = undefined) {
  try {
    const tx = { from: PROBE_FROM, to, data: encodeCall(signature, args, types) };
    if (value !== undefined) tx.value = `0x${BigInt(value).toString(16)}`;
    const raw = await rpcCall(rpc, "eth_call", [tx, "latest"], 10_000);
    return { success: true, result: raw && raw.length > 66 ? `${raw.slice(0, 66)}...` : raw };
  } catch (err) {
    return { success: false, error: sanitize(err.message || err).slice(0, 180) };
  }
}

async function getBlock(rpc) {
  const blockNumber = Number(BigInt(await rpcCall(rpc, "eth_blockNumber", [])));
  const block = await rpcCall(rpc, "eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false]);
  return { number: blockNumber, timestamp: Number(BigInt(block.timestamp)) };
}

async function getCodeSummary(rpc, address) {
  if (!isAddress(address)) return { address, codePresent: false, codeBytes: 0, codeHash: null };
  const [code, implSlot, adminSlot, beaconSlot] = await Promise.all([
    rpcCall(rpc, "eth_getCode", [address, "latest"]).catch(() => "0x"),
    rpcCall(rpc, "eth_getStorageAt", [address, IMPL_SLOT, "latest"]).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [address, ADMIN_SLOT, "latest"]).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [address, BEACON_SLOT, "latest"]).catch(() => null),
  ]);
  return {
    address: normalizeAddress(address),
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
    codeHash: code && code !== "0x" ? sha256Hex(code) : null,
    push4Selectors: code && code !== "0x" ? extractPush4Selectors(code).slice(0, 220) : [],
    eip1967Implementation: addressFromWord(implSlot),
    eip1967Admin: addressFromWord(adminSlot),
    eip1967Beacon: addressFromWord(beaconSlot),
  };
}

async function getTokenInfo(rpc, token, owners = []) {
  const address = normalizeAddress(token);
  const code = await getCodeSummary(rpc, address);
  const implementationCode = code.eip1967Implementation ? await getCodeSummary(rpc, code.eip1967Implementation) : null;
  const [nameRaw, symbolRaw, decimalsRaw, totalSupplyRaw, ownerRaw, pausedRaw] = await Promise.all([
    callOptional(rpc, address, "name()", [], [], null),
    callOptional(rpc, address, "symbol()", [], [], null),
    callOptional(rpc, address, "decimals()", [], [], ["uint8"]),
    callOptional(rpc, address, "totalSupply()", [], [], ["uint256"]),
    callOptional(rpc, address, "owner()", [], [], ["address"]),
    callOptional(rpc, address, "paused()", [], [], ["bool"]),
  ]);
  const decimals = decimalsRaw.ok ? Number(decimalsRaw.value[0]) : null;
  const totalSupply = totalSupplyRaw.ok ? totalSupplyRaw.value[0] : null;
  const balances = {};
  for (const owner of [...new Set(owners.filter(isAddress).map(normalizeAddress))]) {
    const balanceRaw = await callOptional(rpc, address, "balanceOf(address)", [owner], ["address"], ["uint256"]);
    balances[owner] = balanceRaw.ok ? {
      raw: balanceRaw.value[0].toString(),
      ui: decimals === null ? null : formatUnits(balanceRaw.value[0], decimals),
    } : { error: balanceRaw.error };
  }
  const roles = {};
  for (const [roleName, role] of Object.entries({ DEFAULT_ADMIN_ROLE: ZERO32, MINTER_ROLE: id("MINTER_ROLE"), BURNER_ROLE: id("BURNER_ROLE"), PAUSER_ROLE: id("PAUSER_ROLE") })) {
    const hasRole = await callOptional(rpc, address, "hasRole(bytes32,address)", [role, PROBE_FROM], ["bytes32", "address"], ["bool"]);
    if (hasRole.ok) roles[roleName] = { probeFromHasRole: Boolean(hasRole.value[0]) };
  }
  const probes = await probeToken(rpc, address);
  return {
    address,
    code,
    implementationCode,
    name: decodeString(nameRaw.raw),
    symbol: decodeString(symbolRaw.raw),
    decimals,
    totalSupplyRaw: totalSupply?.toString?.() || null,
    totalSupplyUi: totalSupply === null || decimals === null ? null : formatUnits(totalSupply, decimals),
    owner: ownerRaw.ok ? normalizeAddress(ownerRaw.value[0]) : null,
    paused: pausedRaw.ok ? Boolean(pausedRaw.value[0]) : null,
    balances,
    roles,
    probes,
  };
}

async function probeToken(rpc, token) {
  const probeDefs = [
    { key: "mint", signature: "mint(address,uint256)", args: [PROBE_FROM, 1n], types: ["address", "uint256"], severity: "critical" },
    { key: "burn", signature: "burn(uint256)", args: [1n], types: ["uint256"], severity: "medium" },
    { key: "burnFrom", signature: "burnFrom(address,uint256)", args: [PROBE_FROM, 1n], types: ["address", "uint256"], severity: "high" },
    { key: "grantMinterRole", signature: "grantRole(bytes32,address)", args: [id("MINTER_ROLE"), PROBE_FROM], types: ["bytes32", "address"], severity: "critical" },
    { key: "grantDefaultAdminRole", signature: "grantRole(bytes32,address)", args: [ZERO32, PROBE_FROM], types: ["bytes32", "address"], severity: "critical" },
    { key: "setMinterBool", signature: "setMinter(address,bool)", args: [PROBE_FROM, true], types: ["address", "bool"], severity: "critical" },
    { key: "addMinter", signature: "addMinter(address)", args: [PROBE_FROM], types: ["address"], severity: "critical" },
    { key: "transferOwnership", signature: "transferOwnership(address)", args: [PROBE_FROM], types: ["address"], severity: "high" },
    { key: "pause", signature: "pause()", args: [], types: [], severity: "medium" },
    { key: "unpause", signature: "unpause()", args: [], types: [], severity: "medium" },
  ];
  const out = [];
  for (const probe of probeDefs) {
    const result = await stateProbe(rpc, token, probe.signature, probe.args, probe.types);
    out.push({ ...probe, ...result });
  }
  return out;
}

async function scanContract(rpc, item) {
  const address = normalizeAddress(item.address);
  const code = await getCodeSummary(rpc, address);
  const implementationCode = code.eip1967Implementation ? await getCodeSummary(rpc, code.eip1967Implementation) : null;
  const views = {};
  for (const [key, signature, retTypes] of [
    ["owner", "owner()", ["address"]],
    ["admin", "admin()", ["address"]],
    ["operator", "operator()", ["address"]],
    ["pendingOwner", "pendingOwner()", ["address"]],
    ["paused", "paused()", ["bool"]],
    ["isPaused", "isPaused()", ["bool"]],
    ["totalStaked", "totalStaked()", ["uint256"]],
    ["totalSupply", "totalSupply()", ["uint256"]],
    ["campaignCount", "campaignCount()", ["uint256"]],
  ]) {
    const value = await callOptional(rpc, address, signature, [], [], retTypes);
    if (value.ok) views[key] = serializeDecoded(value.value[0]);
  }

  const tokenBalances = {};
  const balanceTokens = [...new Set([...(item.balanceTokens || []), item.adapterAsset].filter(Boolean))];
  if (balanceTokens.length) {
    for (const token of balanceTokens) {
      const balance = await callOptional(rpc, token, "balanceOf(address)", [address], ["address"], ["uint256"]);
      tokenBalances[normalizeAddress(token)] = balance.ok ? balance.value[0].toString() : { error: balance.error };
    }
  }

  const campaigns = item.kind === "campaignPool" ? await scanCampaigns(rpc, address, views.campaignCount) : [];
  const probes = await probeContract(rpc, address);
  return { ...item, address, code, implementationCode, views, tokenBalances, campaigns, probes };
}

function serializeDecoded(value) {
  if (typeof value === "bigint") return value.toString();
  if (isAddress(value)) return normalizeAddress(value);
  if (Array.isArray(value)) return value.map(serializeDecoded);
  return value;
}

async function scanCampaigns(rpc, pool, campaignCountValue) {
  const count = Math.min(Number(campaignCountValue || 0), 100);
  const out = [];
  for (let idNum = 1; idNum <= count; idNum++) {
    const result = await callOptional(
      rpc,
      pool,
      "getCampaign(uint256)",
      [BigInt(idNum)],
      ["uint256"],
      ["tuple(address,address,address,uint256,uint256,uint256,uint256,uint256,bool,bool,bool)"]
    );
    if (!result.ok) {
      out.push({ id: idNum, error: result.error });
      continue;
    }
    const c = result.value[0];
    out.push({
      id: idNum,
      token: normalizeAddress(c[0]),
      field1: normalizeAddress(c[1]),
      field2: normalizeAddress(c[2]),
      raw3: c[3].toString(),
      raw4: c[4].toString(),
      totalStakedRaw: c[5].toString(),
      raw6: c[6].toString(),
      raw7: c[7].toString(),
      bool8: Boolean(c[8]),
      bool9: Boolean(c[9]),
      bool10: Boolean(c[10]),
    });
  }
  return out;
}

async function probeContract(rpc, contract) {
  const probeDefs = [
    { key: "transferOwnership", signature: "transferOwnership(address)", args: [PROBE_FROM], types: ["address"], severity: "high", privileged: true },
    { key: "setOwner", signature: "setOwner(address)", args: [PROBE_FROM], types: ["address"], severity: "high", privileged: true },
    { key: "grantDefaultAdminRole", signature: "grantRole(bytes32,address)", args: [ZERO32, PROBE_FROM], types: ["bytes32", "address"], severity: "critical", privileged: true },
    { key: "pause", signature: "pause()", args: [], types: [], severity: "medium", privileged: true },
    { key: "unpause", signature: "unpause()", args: [], types: [], severity: "medium", privileged: true },
    { key: "setPaused", signature: "setPaused(bool)", args: [true], types: ["bool"], severity: "medium", privileged: true },
    { key: "claim", signature: "claim()", args: [], types: [], severity: "info", privileged: false },
    { key: "withdrawZero", signature: "withdraw(uint256)", args: [0n], types: ["uint256"], severity: "info", privileged: false },
    { key: "unstakeZero", signature: "unstake(uint256)", args: [0n], types: ["uint256"], severity: "info", privileged: false },
    { key: "emergencyWithdraw", signature: "emergencyWithdraw()", args: [], types: [], severity: "info", privileged: false },
  ];
  const out = [];
  for (const probe of probeDefs) {
    const result = await stateProbe(rpc, contract, probe.signature, probe.args, probe.types);
    out.push({ ...probe, ...result });
  }
  return out;
}

async function scanEvmChain(chainName, chainConfig) {
  const chain = { chain: chainName, chainId: chainConfig.chainId, rpcResolved: false, error: null };
  try {
    const rpc = await resolveEvmRpc(chainConfig);
    chain.rpcResolved = true;
    chain.block = await getBlock(rpc);
    const ownerSet = new Set(chainConfig.contracts.map((c) => c.address));
    for (const contract of chainConfig.contracts) for (const owner of contract.balanceTokens ? [contract.address] : []) ownerSet.add(owner);
    const extraOwners = chainConfig.contracts.filter((c) => c.kind === "ownerBalance").map((c) => c.address);
    chain.tokens = {};
    const tokenList = [...new Set([...(chainConfig.tokens || []), ...chainConfig.contracts.flatMap((c) => c.balanceTokens || []), ...chainConfig.contracts.map((c) => c.adapterAsset).filter(Boolean)])];
    for (const token of tokenList) {
      chain.tokens[normalizeAddress(token)] = await getTokenInfo(rpc, token, [...ownerSet, ...extraOwners]);
    }
    chain.contracts = [];
    for (const contract of chainConfig.contracts) chain.contracts.push(await scanContract(rpc, contract));
    chain.derived = deriveEvmFindings(chain);
  } catch (err) {
    chain.error = sanitize(err.message || err).slice(0, 240);
  }
  return chain;
}

function deriveEvmFindings(chain) {
  const flags = [];
  for (const [token, info] of Object.entries(chain.tokens || {})) {
    if (!info.code?.codePresent) flags.push({ level: "warn", item: `${chain.chain}:${token}`, reason: "adapter token has no code on resolved chain" });
    for (const probe of info.probes || []) {
      if (probe.success && ["critical", "high"].includes(probe.severity)) flags.push({ level: "critical", item: `${chain.chain}:${token}:${probe.key}`, reason: "privileged token probe succeeded from arbitrary address" });
    }
  }
  for (const contract of chain.contracts || []) {
    if (!contract.code?.codePresent && contract.kind !== "ownerBalance") flags.push({ level: "warn", item: `${chain.chain}:${contract.key}`, reason: "configured contract has no code" });
    for (const probe of contract.probes || []) {
      if (probe.success && probe.privileged) flags.push({ level: "critical", item: `${chain.chain}:${contract.key}:${probe.key}`, reason: "privileged contract probe succeeded from arbitrary address" });
    }
  }
  return {
    flagCount: flags.length,
    flags,
  };
}

function solanaRpcCandidates() {
  const candidates = [];
  for (const key of ["SOLANA_RPC_URL", "SOLANA_RPC"]) if (process.env[key]) candidates.push(process.env[key]);
  if (fs.existsSync(RPC_FILE)) {
    const lines = fs.readFileSync(RPC_FILE, "utf8").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const line of lines) {
      if (/solana/i.test(line)) for (const match of line.matchAll(/https?:\/\/[^\s'"<>]+/g)) candidates.push(match[0]);
    }
  }
  candidates.push("https://api.mainnet-beta.solana.com");
  return [...new Set(candidates)];
}

async function solanaPostJson(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
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
  for (const url of solanaRpcCandidates()) {
    try {
      const version = await solanaPostJson(url, { jsonrpc: "2.0", id: 1, method: "getVersion", params: [] });
      const slot = await solanaPostJson(url, { jsonrpc: "2.0", id: 2, method: "getSlot", params: [{ commitment: "confirmed" }] });
      const epochInfo = await solanaPostJson(url, { jsonrpc: "2.0", id: 3, method: "getEpochInfo", params: [{ commitment: "confirmed" }] });
      return { url, version, slot, epochInfo };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No working Solana RPC candidate (${lastError ? sanitize(lastError.message || lastError) : "unknown"})`);
}

function makeSolanaRpc(url) {
  let requestId = 10;
  return async function rpc(method, params = []) {
    return solanaPostJson(url, { jsonrpc: "2.0", id: requestId++, method, params });
  };
}

async function solanaMaybe(rpc, method, params = []) {
  try {
    return { ok: true, value: await rpc(method, params) };
  } catch (err) {
    return { ok: false, error: sanitize(err.message || err).slice(0, 220) };
  }
}

async function getSolanaAccounts(rpc, addresses, encoding = "base64") {
  const unique = [...new Set(addresses.filter(Boolean))];
  const out = {};
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const result = await solanaMaybe(rpc, "getMultipleAccounts", [chunk, { encoding, commitment: "confirmed" }]);
    if (!result.ok) {
      for (const address of chunk) out[address] = { error: result.error };
      continue;
    }
    result.value.value.forEach((account, idx) => { out[chunk[idx]] = account; });
  }
  return out;
}

async function scanSolanaProgram(rpc, key, config) {
  const programAccountResult = await solanaMaybe(rpc, "getAccountInfo", [config.programId, { encoding: "base64", commitment: "confirmed" }]);
  let program = { error: programAccountResult.error || null };
  if (programAccountResult.ok) {
    program = parseUpgradeableProgram(programAccountResult.value.value, null);
    if (program.programDataAddress) {
      const pd = await solanaMaybe(rpc, "getAccountInfo", [program.programDataAddress, { encoding: "base64", commitment: "confirmed" }]);
      program = parseUpgradeableProgram(programAccountResult.value.value, pd.ok ? pd.value.value : null);
      if (!pd.ok) program.programDataError = pd.error;
    }
  }

  const accountName = config.accountType === "TokenConfig" ? "TokenConfig" : "Vault";
  const discriminator = anchorDiscriminator(accountName);
  const accountsResult = await solanaMaybe(rpc, "getProgramAccounts", [
    config.programId,
    { encoding: "base64", commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: base58Encode(discriminator) } }] },
  ]);
  const accounts = [];
  if (accountsResult.ok) {
    for (const row of accountsResult.value) {
      if (config.accountType === "TokenConfig") accounts.push(parseTokenConfigAccount(row.pubkey, row.account));
      else if (config.accountType === "PromoVault") accounts.push(parsePromoVaultAccount(row.pubkey, row.account));
      else accounts.push(parseV2VaultAccount(row.pubkey, row.account));
    }
  }

  if (config.accountType === "V2Vault") {
    const strategyId = 1;
    for (const tokenMint of Object.values(SOLANA_MINTS)) {
      const pda = findProgramAddress([Buffer.from("vault"), base58Decode(tokenMint), Buffer.from([strategyId & 0xff, (strategyId >> 8) & 0xff])], config.programId);
      const matched = accounts.find((a) => a.address === pda.address);
      if (matched) {
        matched.expectedTokenMint = tokenMint;
        matched.strategyId = strategyId;
      }
    }
  }

  const mintAddresses = [...new Set(accounts.map((a) => a.tokenMint || a.expectedTokenMint).filter(Boolean))];
  const escrowAddresses = [...new Set(accounts.map((a) => a.tokenEscrow).filter(Boolean))];
  const fetched = await getSolanaAccounts(rpc, [...mintAddresses, ...escrowAddresses]);
  const mintAccounts = {};
  const escrowAccounts = {};
  for (const mint of mintAddresses) mintAccounts[mint] = fetched[mint]?.error ? fetched[mint] : parseMintAccount(fetched[mint]);
  for (const escrow of escrowAddresses) escrowAccounts[escrow] = fetched[escrow]?.error ? fetched[escrow] : parseTokenAccount(fetched[escrow]);

  return {
    key,
    label: config.label,
    programId: config.programId,
    program,
    accountType: config.accountType,
    accountCount: accounts.length,
    accountsError: accountsResult.ok ? null : accountsResult.error,
    accounts,
    mintAccounts,
    escrowAccounts,
    derived: deriveSolanaFindings(config, program, accounts, mintAccounts, escrowAccounts),
  };
}

function deriveSolanaFindings(config, program, accounts, mintAccounts, escrowAccounts) {
  const flags = [];
  if (program?.account?.owner && program.account.owner !== BPF_LOADER_UPGRADEABLE) flags.push({ level: "warn", item: `${config.label}:program`, reason: "unexpected program owner" });
  if (program?.upgradeAuthority) flags.push({ level: "info", item: `${config.label}:upgradeAuthority`, reason: "program is upgradeable" });
  for (const account of accounts || []) {
    if (account.error) flags.push({ level: "warn", item: `${config.label}:${account.address}`, reason: account.error });
    if (account.tokenEscrow && escrowAccounts[account.tokenEscrow]?.mint && account.tokenMint && escrowAccounts[account.tokenEscrow].mint !== account.tokenMint) {
      flags.push({ level: "critical", item: `${config.label}:${account.address}`, reason: "escrow token mint does not match vault token mint" });
    }
  }
  for (const [mint, info] of Object.entries(mintAccounts || {})) {
    if (info?.mintAuthority || info?.freezeAuthority) flags.push({ level: "info", item: `${config.label}:${mint}`, reason: "mint has authority configured" });
  }
  return { flagCount: flags.length, flags };
}

async function scanSolana() {
  const out = { chain: "solana", rpcResolved: false, error: null };
  try {
    const conn = await connectSolanaRpc();
    out.rpcResolved = true;
    out.version = conn.version;
    out.slot = conn.slot;
    out.epochInfo = conn.epochInfo;
    const rpc = makeSolanaRpc(conn.url);
    out.programs = {};
    for (const [key, config] of Object.entries(SOLANA_PROGRAMS)) out.programs[key] = await scanSolanaProgram(rpc, key, config);
  } catch (err) {
    out.error = sanitize(err.message || err).slice(0, 260);
  }
  return out;
}

async function fetchMetadata() {
  const [protocolResult, ...adapterResults] = await Promise.allSettled([
    fetchJson(LLAMA_PROTOCOL_URL, 35_000),
    ...ADAPTER_FILES.map((file) => fetchText(`${ADAPTER_BASE}/${file}`, 25_000)),
  ]);
  const protocol = protocolResult.status === "fulfilled" ? summarizeLlama(protocolResult.value) : { error: sanitize(protocolResult.reason?.message || protocolResult.reason) };
  const adapters = {};
  adapterResults.forEach((result, idx) => {
    const file = ADAPTER_FILES[idx];
    adapters[file] = result.status === "fulfilled"
      ? { fetched: true, sha256: sha256Hex(result.value), bytes: result.value.length, urls: [...result.value.matchAll(/https?:\/\/[^'"`\s)]+/g)].map((m) => m[0]) }
      : { fetched: false, error: sanitize(result.reason?.message || result.reason) };
  });
  return { protocol, adapters };
}

function summarizeLlama(protocol) {
  const latest = Array.isArray(protocol.tvl) && protocol.tvl.length ? protocol.tvl[protocol.tvl.length - 1] : null;
  return {
    id: protocol.id,
    name: protocol.name,
    slug: protocol.slug,
    category: protocol.category,
    chains: protocol.chains,
    audits: protocol.audits,
    audit_links: protocol.audit_links,
    url: protocol.url,
    twitter: protocol.twitter,
    github: protocol.github,
    module: protocol.module,
    tvlCodePath: protocol.tvlCodePath,
    methodology: protocol.methodology,
    latestTvlUsd: latest?.totalLiquidityUSD ?? null,
    latestTvlDate: latest?.date ?? null,
    currentChainTvls: protocol.currentChainTvls,
  };
}

async function scanGraphs() {
  const out = {};
  await Promise.all(GRAPH_CONFIGS.map(async (config) => {
    try {
      const data = await graphQuery(config.url, config.query);
      out[config.key] = { ...config, ok: true, data, derived: deriveGraph(config, data) };
    } catch (err) {
      out[config.key] = { ...config, ok: false, error: sanitize(err.message || err).slice(0, 280) };
    }
  }));
  return out;
}

function deriveGraph(config, data) {
  const tokens = Array.isArray(data?.tokens) ? data.tokens : [];
  const rewards = Array.isArray(data?.tokenRewards) ? data.tokenRewards : [];
  const positiveTokens = tokens.filter((t) => Number(t.tvl || 0) > 0).length;
  const positiveRewards = rewards.filter((r) => Number(r.reward || 0) > 0).length;
  return {
    metaBlock: data?._meta?.block?.number ?? null,
    tokenCount: tokens.length,
    positiveTokens,
    rewardCount: rewards.length,
    positiveRewards,
    tokenIds: tokens.map((t) => t.id),
  };
}

function collectGlobalFlags(scan) {
  const flags = [];
  for (const chain of Object.values(scan.evm || {})) {
    for (const flag of chain.derived?.flags || []) flags.push(flag);
  }
  for (const program of Object.values(scan.solana?.programs || {})) {
    for (const flag of program.derived?.flags || []) flags.push(flag);
  }
  return flags;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const [metadata, graphs, evmEntries, solana] = await Promise.all([
    fetchMetadata(),
    scanGraphs(),
    Promise.all(Object.entries(CHAINS).map(async ([name, config]) => [name, await scanEvmChain(name, config)])),
    scanSolana(),
  ]);
  const result = {
    generatedAt,
    target: "BounceBit CeDeFi Yield",
    sources: {
      llamaProtocol: LLAMA_PROTOCOL_URL,
      adapterBase: ADAPTER_BASE,
    },
    metadata,
    graphs,
    evm: Object.fromEntries(evmEntries),
    solana,
  };
  result.flags = collectGlobalFlags(result);
  result.summary = {
    criticalFlags: result.flags.filter((f) => f.level === "critical").length,
    warnFlags: result.flags.filter((f) => f.level === "warn").length,
    infoFlags: result.flags.filter((f) => f.level === "info").length,
    evmChainsResolved: Object.values(result.evm).filter((c) => c.rpcResolved).length,
    solanaResolved: Boolean(result.solana?.rpcResolved),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, bigintJson, 2));
  console.log(JSON.stringify({ out: OUT, summary: result.summary }, null, 2));
}

main().catch((err) => {
  console.error(sanitize(err.stack || err.message || err));
  process.exit(1);
});
