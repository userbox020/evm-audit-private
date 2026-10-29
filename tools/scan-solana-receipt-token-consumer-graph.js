#!/usr/bin/env node
// Read-only Solana receipt-token / Token-2022 consumer graph scanner.
// Joins protocol accepted-asset inventories to mint semantics; never stores RPC URLs.

const fs = require("fs");
const path = require("path");

const { scanOnce: scanKaminoOnce } = require("../targets/kamino-klend/live-liquidation-executor.js");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "solana-receipt-token-consumer-graph.json");

const XSTOCKS_LIVE = path.join(WORKSPACE, "reports", "raw", "fast", "xstocks-live.json");
const KAMINO_BORROW_DIVERGENCE = path.join(WORKSPACE, "reports", "raw", "fast", "kamino-borrow-divergence.json");
const JUPITER_LEND_DIVERGENCE = path.join(WORKSPACE, "reports", "raw", "fast", "jupiter-lend-oracle-divergence.json");
const DRIFT_LIVE_MAP = path.join(WORKSPACE, "reports", "raw", "drift-live-map.json");
const DRIFT_TOKEN2022_ANALYSIS = path.join(WORKSPACE, "reports", "raw", "fast", "drift-liquidation-swap-analysis.json");
const MARGINFI_META = path.join(WORKSPACE, "targets", "p0", "marginfi-v2", "clients", "rust", "marginfi-cli", "assets", "mainnet_metadata_dump.json");

const QUIET = process.argv.includes("--quiet");
const MAIN_KAMINO_MARKET = process.env.KAMINO_MARKET || "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const RPC_TIMEOUT_MS = Number(process.env.SOLANA_RECEIPT_GRAPH_RPC_TIMEOUT_MS || "45000");

const MARGINFI_PROGRAM = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";
const MARGINFI_BANK_SIZE = 8 + 1856;

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ZERO_PUBKEY = "11111111111111111111111111111111";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const MARGINFI_ORACLE = [
  "None",
  "PythLegacy",
  "SwitchboardV2",
  "PythPushOracle",
  "SwitchboardPull",
  "StakedWithPythPush",
  "KaminoPythPush",
  "KaminoSwitchboardPull",
  "Fixed",
  "DriftPythPull",
  "DriftSwitchboardPull",
  "SolendPythPull",
  "SolendSwitchboardPull",
  "FixedKamino",
  "FixedDrift",
  "JuplendPythPull",
  "JuplendSwitchboardPull",
  "FixedJuplend",
];

const MARGINFI_OPS = ["Paused", "Operational", "ReduceOnly", "KilledByBankruptcy"];
const MARGINFI_RISK = ["Collateral", "Isolated"];

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

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function asNumber(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const parsed = Number(String(value).replace(/[$,%_\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, decimals = 6) {
  const n = asNumber(value, null);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function loadSolanaUrls() {
  const urls = [];
  if (fs.existsSync(RPC_FILE)) {
    for (const line of fs.readFileSync(RPC_FILE, "utf8").split(/\r?\n/)) {
      const lower = line.toLowerCase();
      if (!lower.includes("http") || (!lower.includes("solana") && !lower.includes("helius"))) continue;
      for (const match of line.matchAll(/https?:\/\/[^\s'"<>]+/g)) urls.push(match[0].replace(/["'`,;]+$/g, ""));
    }
  }
  urls.push("https://api.mainnet-beta.solana.com");
  return unique(urls);
}

async function rpc(url, method, params = [], timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json" };
    if (/helius/i.test(url)) headers.Origin = process.env.SOLANA_RPC_ORIGIN || "https://helius.xyz";
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`${method} RPC ${json.error.code}: ${json.error.message}`);
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function connectSolanaRpc() {
  let lastError = null;
  for (const url of loadSolanaUrls()) {
    try {
      const [version, slot, epochInfo] = await Promise.all([
        rpc(url, "getVersion", []),
        rpc(url, "getSlot", [{ commitment: "confirmed" }]),
        rpc(url, "getEpochInfo", [{ commitment: "confirmed" }]),
      ]);
      return { url, version, slot, epochInfo };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(lastError?.message || "No working Solana RPC endpoint");
}

function base58Encode(buf) {
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  let value = 0n;
  for (const byte of buf) value = (value << 8n) + BigInt(byte);
  let out = "";
  while (value > 0n) {
    const remainder = value % 58n;
    value /= 58n;
    out = BASE58_ALPHABET[Number(remainder)] + out;
  }
  return "1".repeat(zeros) + (out || "");
}

function pubkeyAt(buf, offset) {
  const bytes = buf.subarray(offset, offset + 32);
  if (bytes.length !== 32 || bytes.every((b) => b === 0)) return ZERO_PUBKEY;
  return base58Encode(bytes);
}

function optionalPubkey(bytes) {
  if (!bytes || bytes.length !== 32 || bytes.every((byte) => byte === 0)) return null;
  return base58Encode(bytes);
}

function cOptionPubkey(data, offset) {
  if (!data || offset + 36 > data.length) return null;
  const tag = data.readUInt32LE(offset);
  return tag === 0 ? null : optionalPubkey(data.subarray(offset + 4, offset + 36));
}

function i80f48(buf, offset) {
  if (!buf || offset < 0 || offset + 16 > buf.length) return null;
  let value = 0n;
  for (let i = offset + 15; i >= offset; i--) value = (value << 8n) | BigInt(buf[i]);
  const negative = ((value >> 127n) & 1n) === 1n;
  const mag = negative ? ((~value + 1n) & ((1n << 128n) - 1n)) : value;
  const out = Number(mag) / 2 ** 48;
  return negative ? -out : out;
}

function u64(buf, offset) {
  if (!buf || offset < 0 || offset + 8 > buf.length) return 0;
  return Number(buf.readBigUInt64LE(offset));
}

function i64(buf, offset) {
  if (!buf || offset < 0 || offset + 8 > buf.length) return 0;
  return Number(buf.readBigInt64LE(offset));
}

function formatUnits(raw, decimals) {
  try {
    const value = BigInt(raw || 0);
    const d = BigInt(decimals || 0);
    const scale = 10n ** d;
    const whole = value / scale;
    const frac = value % scale;
    if (d === 0n) return whole.toString();
    const fracText = frac.toString().padStart(Number(d), "0").replace(/0+$/g, "");
    return fracText ? `${whole}.${fracText}` : whole.toString();
  } catch (_) {
    return null;
  }
}

function dataBuffer(account) {
  if (!account?.data) return null;
  const raw = Array.isArray(account.data) ? account.data[0] : account.data;
  return Buffer.from(raw || "", "base64");
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

function parseToken2022ExtensionDetails(account, epoch) {
  const data = dataBuffer(account);
  if (!data) return {};
  const details = {};
  for (const ext of parseToken2022Extensions(account)) {
    const start = ext.offset + 4;
    if (ext.type === 1 && ext.length >= 108) {
      const older = {
        epoch: data.readBigUInt64LE(start + 72).toString(),
        maximumFee: data.readBigUInt64LE(start + 80).toString(),
        transferFeeBasisPoints: data.readUInt16LE(start + 88),
      };
      const newer = {
        epoch: data.readBigUInt64LE(start + 90).toString(),
        maximumFee: data.readBigUInt64LE(start + 98).toString(),
        transferFeeBasisPoints: data.readUInt16LE(start + 106),
      };
      const active = BigInt(epoch || 0) >= BigInt(newer.epoch) ? newer : older;
      details.TransferFeeConfig = {
        transferFeeConfigAuthority: optionalPubkey(data.subarray(start, start + 32)),
        withdrawWithheldAuthority: optionalPubkey(data.subarray(start + 32, start + 64)),
        withheldAmount: data.readBigUInt64LE(start + 64).toString(),
        older,
        newer,
        active,
      };
    } else if (ext.type === 3 && ext.length >= 32) {
      details.MintCloseAuthority = { authority: optionalPubkey(data.subarray(start, start + 32)) };
    } else if (ext.type === 4 && ext.length >= 65) {
      details.ConfidentialTransferMint = {
        authority: optionalPubkey(data.subarray(start, start + 32)),
        autoApproveNewAccounts: data.readUInt8(start + 32) === 1,
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

function parseMintAccount(account, epoch) {
  const data = dataBuffer(account);
  if (!data || data.length < 82) return null;
  const decimals = data.readUInt8(44);
  const supplyRaw = data.readBigUInt64LE(36).toString();
  const extensions = parseToken2022Extensions(account);
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
    token2022Extensions: extensions,
    token2022ExtensionDetails: parseToken2022ExtensionDetails(account, epoch),
  };
}

async function fetchMintInfos(rpcUrl, mints, epoch) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    const result = await rpc(rpcUrl, "getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }]);
    const values = result?.value || [];
    for (let j = 0; j < chunk.length; j++) {
      const account = values[j];
      out.set(chunk[j], account ? parseMintAccount(account, epoch) : null);
    }
  }
  return out;
}

function loadMarginfiMetadata() {
  const rows = readJson(MARGINFI_META, []);
  return new Map((Array.isArray(rows) ? rows : []).map((row) => [row.bankAddress, row]));
}

function parseMarginfiBank(pubkey, data, metaMap) {
  const base = 8;
  const config = base + 288;
  const cache = base + 1368;
  const meta = metaMap.get(pubkey) || {};
  const bank = {
    pubkey,
    mint: pubkeyAt(data, base),
    mintDecimals: data.readUInt8(base + 32),
    assetShareValue: i80f48(data, base + 72) || 0,
    liabilityShareValue: i80f48(data, base + 88) || 0,
    totalLiabilityShares: i80f48(data, base + 248) || 0,
    totalAssetShares: i80f48(data, base + 264) || 0,
    lastUpdate: i64(data, base + 280),
    assetWeightInit: i80f48(data, config),
    assetWeightMaint: i80f48(data, config + 16),
    liabilityWeightInit: i80f48(data, config + 32),
    liabilityWeightMaint: i80f48(data, config + 48),
    depositLimit: u64(data, config + 64),
    operationalState: data.readUInt8(config + 312),
    oracleSetup: data.readUInt8(config + 313),
    borrowLimit: u64(data, config + 480),
    riskTier: data.readUInt8(config + 488),
    oracleMaxAge: data.readUInt16LE(config + 504),
    fixedPrice: i80f48(data, config + 512) || 0,
    lastOraclePrice: i80f48(data, cache + 32) || 0,
    lastOraclePriceTimestamp: i64(data, cache + 48),
    name: meta.bankName || "",
    ticker: String(meta.ticker || "").split("|")[0].trim(),
    description: meta.description || "",
  };
  bank.totalDepositsUi = bank.totalAssetShares * bank.assetShareValue / (10 ** bank.mintDecimals);
  bank.totalBorrowsUi = bank.totalLiabilityShares * bank.liabilityShareValue / (10 ** bank.mintDecimals);
  const price = Math.max(0, bank.lastOraclePrice || bank.fixedPrice || 0);
  bank.totalDepositUsd = bank.totalDepositsUi * price;
  bank.totalBorrowUsd = bank.totalBorrowsUi * price;
  bank.validDecode = bank.mint !== ZERO_PUBKEY
    && bank.mintDecimals <= 24
    && bank.assetWeightInit >= 0 && bank.assetWeightInit <= 2
    && bank.assetWeightMaint >= 0 && bank.assetWeightMaint <= 2
    && bank.liabilityWeightInit >= 0.5 && bank.liabilityWeightInit <= 10
    && bank.liabilityWeightMaint >= 0.5 && bank.liabilityWeightMaint <= 10
    && bank.operationalState <= 3
    && bank.oracleSetup <= 17
    && bank.riskTier <= 1;
  return bank;
}

async function fetchMarginfiConsumers(rpcUrl) {
  const metaMap = loadMarginfiMetadata();
  const rows = await rpc(rpcUrl, "getProgramAccounts", [MARGINFI_PROGRAM, {
    encoding: "base64",
    commitment: "confirmed",
    filters: [{ dataSize: MARGINFI_BANK_SIZE }],
  }]);
  const consumers = [];
  for (const row of rows || []) {
    try {
      const raw = row.account?.data;
      const data = Buffer.from(Array.isArray(raw) ? raw[0] : raw, "base64");
      const bank = parseMarginfiBank(row.pubkey, data, metaMap);
      if (!bank.validDecode) continue;
      consumers.push({
        protocol: "Marginfi",
        chain: "Solana",
        role: bank.riskTier === 0 ? "collateral-and-borrow" : "isolated-bank",
        mint: bank.mint,
        symbol: bank.ticker || bank.name || shortMint(bank.mint),
        market: bank.pubkey,
        ltvBps: round((bank.assetWeightInit || 0) * 10_000, 0),
        liquidationThresholdBps: round((bank.assetWeightMaint || 0) * 10_000, 0),
        totalDepositUsd: round(bank.totalDepositUsd, 2),
        totalBorrowUsd: round(bank.totalBorrowUsd, 2),
        oracle: MARGINFI_ORACLE[bank.oracleSetup] || String(bank.oracleSetup),
        operationalState: MARGINFI_OPS[bank.operationalState] || String(bank.operationalState),
        riskTier: MARGINFI_RISK[bank.riskTier] || String(bank.riskTier),
        source: "rpc:marginfi-bank",
      });
    } catch (_) {}
  }
  return consumers;
}

async function fetchKaminoConsumers(rpcUrl) {
  const scan = await scanKaminoOnce(rpcUrl, MAIN_KAMINO_MARKET);
  const borrow = readJson(KAMINO_BORROW_DIVERGENCE, {});
  const borrowByReserve = new Map((borrow?.perReserveBorrow || []).map((row) => [row.pubkey, row]));
  const consumers = [];
  for (const reserve of scan.reserveInfoByKey.values()) {
    const borrowRow = borrowByReserve.get(reserve.pubkey) || {};
    consumers.push({
      protocol: "Kamino Klend",
      chain: "Solana",
      role: "reserve-liquidity-collateral",
      mint: reserve.liquidityMint,
      symbol: reserve.name || borrowRow.symbol || shortMint(reserve.liquidityMint),
      market: reserve.pubkey,
      reserve: reserve.pubkey,
      ltvBps: null,
      liquidationThresholdBps: reserve.liquidationThresholdPct != null ? reserve.liquidationThresholdPct * 100 : null,
      borrowFactorPct: reserve.borrowFactorPct,
      totalDepositUsd: round(borrowRow.depositUsd, 2),
      totalBorrowUsd: round(borrowRow.borrowUsd, 2),
      status: reserve.status,
      source: "rpc:kamino-reserve",
    });
  }
  return consumers;
}

function jupiterConsumers() {
  const artifact = readJson(JUPITER_LEND_DIVERGENCE, {});
  const rows = [];
  for (const vault of artifact?.vaultRows || []) {
    if (vault.supplyToken) {
      rows.push({
        protocol: "Jupiter Lend",
        chain: "Solana",
        role: "supply-collateral",
        mint: vault.supplyToken,
        symbol: vault.supplySymbol || shortMint(vault.supplyToken),
        market: vault.vaultConfig,
        vaultId: vault.vaultId,
        ltvBps: vault.collateralFactorBps ?? null,
        liquidationThresholdBps: vault.liquidationThresholdBps ?? null,
        liquidationPenaltyBps: vault.liquidationPenaltyBps ?? null,
        totalDepositUsd: null,
        totalBorrowUsd: round(vault.totalBorrowUsd, 2),
        oracle: vault.oracle,
        oracleSourceTypes: vault.sourceTypes || [],
        pair: vault.pair,
        source: "artifact:jupiter-lend-vaultRows",
      });
    }
    if (vault.borrowToken) {
      rows.push({
        protocol: "Jupiter Lend",
        chain: "Solana",
        role: "borrow-debt",
        mint: vault.borrowToken,
        symbol: vault.borrowSymbol || shortMint(vault.borrowToken),
        market: vault.vaultConfig,
        vaultId: vault.vaultId,
        ltvBps: null,
        liquidationThresholdBps: null,
        totalDepositUsd: null,
        totalBorrowUsd: round(vault.totalBorrowUsd, 2),
        oracle: vault.oracle,
        oracleSourceTypes: vault.sourceTypes || [],
        pair: vault.pair,
        source: "artifact:jupiter-lend-vaultRows",
      });
    }
  }
  return rows;
}

function driftConsumers() {
  const liveMap = readJson(DRIFT_LIVE_MAP, {});
  const token2022Analysis = readJson(DRIFT_TOKEN2022_ANALYSIS, {});
  const token2022ByMint = new Map((token2022Analysis?.token2022 || []).map((row) => [row.mint, row]));
  const rows = [];
  for (const market of liveMap?.spotMarkets || []) {
    if (!market.mint) continue;
    const token2022 = token2022ByMint.get(market.mint) || {};
    rows.push({
      protocol: "Drift v2",
      chain: "Solana",
      role: "spot-collateral-margin",
      mint: market.mint,
      symbol: market.symbol || token2022.symbol || shortMint(market.mint),
      market: market.pda?.address || null,
      marketIndex: market.marketIndex,
      poolId: market.poolId,
      ltvBps: null,
      liquidationThresholdBps: null,
      totalDepositUsd: null,
      totalBorrowUsd: null,
      oracle: market.oracle,
      oracleSource: market.oracleSource,
      tokenProgramKind: market.tokenProgramKind,
      artifactExtensions: (market.token2022Extensions || token2022.extensions || []).map((ext) => typeof ext === "string" ? ext : ext.name).filter(Boolean),
      source: "artifact:drift-live-map",
    });
  }
  return rows;
}

function xstocksProducerRows() {
  const artifact = readJson(XSTOCKS_LIVE, {});
  const rows = [];
  for (const token of artifact?.solana?.tokens || []) {
    if (!token?.mint) continue;
    const details = token?.mintInfo?.token2022ExtensionDetails || {};
    rows.push({
      mint: token.mint,
      symbol: token?.mintInfo?.token2022TokenMetadata?.parsed?.symbol || token.symbol || null,
      name: token?.name || token?.mintInfo?.token2022TokenMetadata?.parsed?.name || null,
      source: "artifact:xstocks-live",
      supply: asNumber(token?.mintInfo?.supply),
      circulating: asNumber(token?.circulating),
      mintAuthority: token?.mintInfo?.mintAuthority || null,
      freezeAuthority: token?.mintInfo?.freezeAuthority || null,
      permanentDelegate: details?.PermanentDelegate?.delegate || null,
      defaultAccountState: details?.DefaultAccountState?.name || null,
      pausableAuthority: details?.Pausable?.authority || null,
      paused: details?.Pausable?.paused ?? null,
      scaledUiMultiplier: asNumber(details?.ScaledUiAmountConfig?.multiplier),
      scaledUiNewMultiplier: asNumber(details?.ScaledUiAmountConfig?.newMultiplier),
      transferHookProgramId: details?.TransferHook?.programId || null,
      extensions: (token?.mintInfo?.token2022Extensions || []).map((ext) => ext.name).filter(Boolean),
    });
  }
  return rows;
}

function shortMint(mint) {
  if (!mint) return null;
  return `${String(mint).slice(0, 5)}...${String(mint).slice(-4)}`;
}

function symbolFromConsumers(consumers, producer) {
  return producer?.symbol || consumers.find((row) => row.symbol)?.symbol || shortMint(consumers[0]?.mint || producer?.mint);
}

function hasReceiptLikeLabel(symbol, name, consumers) {
  const text = [symbol, name, ...(consumers || []).flatMap((row) => [row.symbol, row.pair, ...(row.oracleSourceTypes || [])])]
    .filter(Boolean)
    .join(" ");
  return /\b(jlp|jupsol|msol|bsol|dsol|jsol|hsol|vsol|psol|bbsol|adrasol|lst|lrt|lp|vault|share|receipt|stake\s*pool|staking|staked|wrapped|yield|pt-|yt-|xstock|xbtc|xsol)\b/i.test(text)
    || /^jup/i.test(symbol || "");
}

function maxConsumerMetric(consumers, field) {
  const values = consumers.map((row) => asNumber(row[field], null)).filter((n) => n !== null);
  return values.length ? Math.max(...values) : null;
}

function sumConsumerMetric(consumers, field) {
  return consumers.reduce((acc, row) => acc + (asNumber(row[field], 0) || 0), 0);
}

function classifyMint(mint, consumers, mintInfo, producer) {
  const details = mintInfo?.token2022ExtensionDetails || {};
  const extensionNames = unique([
    ...(mintInfo?.token2022Extensions || []).map((ext) => ext.name).filter(Boolean),
    ...(producer?.extensions || []),
    ...(consumers || []).flatMap((row) => row.artifactExtensions || []),
  ]);
  const symbol = symbolFromConsumers(consumers, producer);
  const name = producer?.name || null;
  const receiptLike = hasReceiptLikeLabel(symbol, name, consumers);
  const activeFeeBps = asNumber(details?.TransferFeeConfig?.active?.transferFeeBasisPoints, null);
  const scheduledFeeBps = asNumber(details?.TransferFeeConfig?.newer?.transferFeeBasisPoints, null);
  const scaledMultiplier = asNumber(details?.ScaledUiAmountConfig?.multiplier ?? producer?.scaledUiMultiplier, null);
  const scaledNewMultiplier = asNumber(details?.ScaledUiAmountConfig?.newMultiplier ?? producer?.scaledUiNewMultiplier, null);
  const defaultState = details?.DefaultAccountState?.name || producer?.defaultAccountState || null;
  const paused = details?.Pausable?.paused ?? producer?.paused ?? null;
  const maxLtvBps = maxConsumerMetric(consumers, "ltvBps");
  const maxLiquidationThresholdBps = maxConsumerMetric(consumers, "liquidationThresholdBps");
  const totalBorrowUsd = sumConsumerMetric(consumers, "totalBorrowUsd");
  const totalDepositUsd = sumConsumerMetric(consumers, "totalDepositUsd");
  const collateralConsumers = consumers.filter((row) => /collateral|supply|margin|reserve/i.test(row.role || ""));
  const protocols = unique(consumers.map((row) => row.protocol));
  const riskSignals = [];

  if (mintInfo?.tokenProgramKind === "token-2022" || extensionNames.length) riskSignals.push("token-2022-mint");
  if (receiptLike) riskSignals.push("receipt-or-vault-like-label");
  if (details.TransferFeeConfig || extensionNames.includes("TransferFeeConfig")) riskSignals.push(activeFeeBps > 0 || scheduledFeeBps > 0 ? "nonzero-transfer-fee-config" : "transfer-fee-config-present");
  if (details.TransferHook?.programId || producer?.transferHookProgramId || extensionNames.includes("TransferHook")) riskSignals.push("transfer-hook-present");
  if (details.PermanentDelegate?.delegate || producer?.permanentDelegate || extensionNames.includes("PermanentDelegate")) riskSignals.push("permanent-delegate-present");
  if (details.MintCloseAuthority?.authority || extensionNames.includes("MintCloseAuthority")) riskSignals.push("mint-close-authority-present");
  if (mintInfo?.mintAuthority || producer?.mintAuthority) riskSignals.push("mint-authority-present");
  if (mintInfo?.freezeAuthority || producer?.freezeAuthority) riskSignals.push("freeze-authority-present");
  if (defaultState && defaultState !== "initialized") riskSignals.push(`default-account-state-${defaultState}`);
  if (paused === true) riskSignals.push("currently-paused");
  if (paused === false || details.Pausable?.authority || producer?.pausableAuthority || extensionNames.includes("Pausable")) riskSignals.push("pausable-authority-present");
  if (extensionNames.includes("NonTransferable")) riskSignals.push("non-transferable-mint");
  if (extensionNames.includes("InterestBearingConfig")) riskSignals.push("interest-bearing-config-present");
  if (scaledMultiplier !== null && Math.abs(scaledMultiplier - 1) > 1e-12) riskSignals.push("scaled-ui-current-multiplier-not-one");
  if (scaledNewMultiplier !== null && Math.abs(scaledNewMultiplier - 1) > 1e-12) riskSignals.push("scaled-ui-scheduled-multiplier-not-one");
  if (protocols.length > 1) riskSignals.push("multi-protocol-consumer");
  if ((maxLtvBps || 0) >= 7500) riskSignals.push("high-ltv-consumer");
  if (totalBorrowUsd >= 10_000) riskSignals.push("material-borrow-liquidity");

  const riskScore = Math.round(
    (mintInfo?.tokenProgramKind === "token-2022" || extensionNames.length ? 14 : 0)
    + (receiptLike ? 14 : 0)
    + (details.TransferFeeConfig || extensionNames.includes("TransferFeeConfig") ? (activeFeeBps > 0 || scheduledFeeBps > 0 ? 24 : 8) : 0)
    + (details.TransferHook?.programId || producer?.transferHookProgramId || extensionNames.includes("TransferHook") ? 14 : 0)
    + (details.PermanentDelegate?.delegate || producer?.permanentDelegate || extensionNames.includes("PermanentDelegate") ? 12 : 0)
    + (mintInfo?.mintAuthority || producer?.mintAuthority ? 8 : 0)
    + (mintInfo?.freezeAuthority || producer?.freezeAuthority ? 8 : 0)
    + (paused === true ? 16 : paused === false || details.Pausable?.authority || producer?.pausableAuthority || extensionNames.includes("Pausable") ? 8 : 0)
    + (scaledMultiplier !== null && Math.abs(scaledMultiplier - 1) > 1e-12 ? 12 : 0)
    + (scaledNewMultiplier !== null && Math.abs(scaledNewMultiplier - 1) > 1e-12 ? 10 : 0)
    + (protocols.length > 1 ? 8 : 0)
    + ((maxLtvBps || 0) >= 7500 ? 10 : 0)
    + (Math.min(12, Math.log10(Math.max(1, totalBorrowUsd)) * 2))
  );

  const hasMaterialConsumer = totalBorrowUsd >= 10_000 || totalDepositUsd >= 10_000 || (maxLtvBps || 0) >= 7500 || protocols.length > 1;
  const watch = consumers.length > 0 && riskSignals.length > 0 && collateralConsumers.length > 0 && hasMaterialConsumer;

  return {
    mint,
    symbol,
    name,
    tokenProgramKind: mintInfo?.tokenProgramKind || consumers.find((row) => row.tokenProgramKind)?.tokenProgramKind || null,
    decimals: mintInfo?.decimals ?? null,
    supply: mintInfo?.supply || producer?.supply || null,
    protocols,
    consumerCount: consumers.length,
    collateralConsumerCount: collateralConsumers.length,
    maxLtvBps,
    maxLiquidationThresholdBps,
    totalBorrowUsd: round(totalBorrowUsd, 2),
    totalDepositUsd: round(totalDepositUsd, 2),
    extensionNames,
    token2022Details: {
      activeTransferFeeBps: activeFeeBps,
      scheduledTransferFeeBps: scheduledFeeBps,
      transferHookProgramId: details.TransferHook?.programId || producer?.transferHookProgramId || null,
      permanentDelegate: details.PermanentDelegate?.delegate || producer?.permanentDelegate || null,
      pausableAuthority: details.Pausable?.authority || producer?.pausableAuthority || null,
      paused,
      scaledUiMultiplier: scaledMultiplier,
      scaledUiNewMultiplier: scaledNewMultiplier,
      defaultAccountState: defaultState,
    },
    mintAuthorities: {
      mintAuthority: mintInfo?.mintAuthority || producer?.mintAuthority || null,
      freezeAuthority: mintInfo?.freezeAuthority || producer?.freezeAuthority || null,
      mintCloseAuthority: details.MintCloseAuthority?.authority || null,
    },
    receiptLike,
    riskSignals,
    riskScore,
    watchCandidate: watch,
    routePositive: false,
    topConsumers: consumers
      .sort((a, b) => (asNumber(b.totalBorrowUsd, 0) || 0) - (asNumber(a.totalBorrowUsd, 0) || 0) || (asNumber(b.ltvBps, 0) || 0) - (asNumber(a.ltvBps, 0) || 0))
      .slice(0, 8),
    blocker: watch
      ? "Consumer-linked risky receipt/Token-2022 traits found, but no exact producer-side exploit, positive economics, or local/fork proof."
      : "No material route-positive consumer join in current graph.",
  };
}

function buildArtifact({ connection, rpcError, consumerRows, mintRows, producerRows, sourceErrors }) {
  const consumersByMint = new Map();
  for (const row of consumerRows.filter((row) => row.mint && row.mint !== ZERO_PUBKEY)) {
    if (!consumersByMint.has(row.mint)) consumersByMint.set(row.mint, []);
    consumersByMint.get(row.mint).push(row);
  }
  const producerByMint = new Map(producerRows.map((row) => [row.mint, row]));
  const allMints = unique([...consumersByMint.keys(), ...producerByMint.keys()]);
  const classified = allMints.map((mint) => classifyMint(mint, consumersByMint.get(mint) || [], mintRows.get(mint) || null, producerByMint.get(mint) || null));
  classified.sort((a, b) => b.riskScore - a.riskScore || (b.totalBorrowUsd || 0) - (a.totalBorrowUsd || 0));

  const riskyConsumerMatches = classified.filter((row) => row.consumerCount > 0 && row.riskSignals.length > 0);
  const watchCandidates = classified.filter((row) => row.watchCandidate);
  const currentValueChangingProducerRows = 0;
  const accountingDivergenceRows = 0;
  const exactEconomicsRows = 0;
  const localProofRows = 0;
  const routePositive = 0;
  const byProtocol = {};
  for (const row of consumerRows) byProtocol[row.protocol] = (byProtocol[row.protocol] || 0) + 1;
  const token2022ConsumerMints = classified.filter((row) => row.consumerCount > 0 && (row.tokenProgramKind === "token-2022" || row.extensionNames.length > 0)).length;
  const receiptLikeConsumerMints = classified.filter((row) => row.consumerCount > 0 && row.receiptLike).length;

  return {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-solana-receipt-token-consumer-graph.js",
    scope: "Read-only Solana accepted-asset graph for receipt-like, Token-2022, and authority-controlled mints across Kamino, Marginfi, Jupiter Lend, and Drift",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      keypairLoaded: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routePositive > 0,
      executableNow: false,
      signedActionJustified: false,
    },
    rpcStatus: rpcError
      ? { connected: false, error: String(rpcError).slice(0, 180) }
      : { connected: true, slot: connection?.slot || null, version: connection?.version?.["solana-core"] || null, epoch: connection?.epochInfo?.epoch ?? null },
    inputs: {
      xstocksLive: rel(XSTOCKS_LIVE),
      kaminoBorrowDivergence: rel(KAMINO_BORROW_DIVERGENCE),
      jupiterLendOracleDivergence: rel(JUPITER_LEND_DIVERGENCE),
      driftLiveMap: rel(DRIFT_LIVE_MAP),
      driftToken2022Analysis: rel(DRIFT_TOKEN2022_ANALYSIS),
      marginfiMetadata: rel(MARGINFI_META),
    },
    sourceErrors,
    summary: {
      protocolInventories: byProtocol,
      consumerRows: consumerRows.length,
      uniqueConsumerMints: consumersByMint.size,
      producerMints: producerRows.length,
      mintsClassified: classified.length,
      mintAccountsDecoded: [...mintRows.values()].filter(Boolean).length,
      token2022ConsumerMints,
      receiptLikeConsumerMints,
      riskyConsumerMatches: riskyConsumerMatches.length,
      materialRiskyConsumerMatches: watchCandidates.length,
      watchCandidates: watchCandidates.length,
      currentValueChangingProducerRows,
      accountingDivergenceRows,
      exactEconomicsRows,
      localProofRows,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      status: watchCandidates.length ? "consumer-graph-research-only-no-exact-route" : "no-material-risky-consumer-route",
      closedReason: watchCandidates.length
        ? "Risky receipt/Token-2022 traits map to consumers, but no current value-changing producer impact, exact positive economics, or proof exists."
        : "No material risky receipt/Token-2022 consumer join is route-positive in current artifacts.",
    },
    topRows: classified.slice(0, 50),
    watchCandidates: watchCandidates.slice(0, 50),
    riskyConsumerMatches: riskyConsumerMatches.slice(0, 100),
    consumerRows: consumerRows.slice(0, 500),
    requiredForRoutePositive: [
      "accepted mint has a current producer-side exploit signal, not just an authority or Token-2022 extension",
      "the protocol consumes the mint as borrowable collateral or margin with material liquidity",
      "accepted oracle/accounting value diverges from exact acquisition, transfer, redeem, or unwind value",
      "exact repay/acquisition and exit route is positive after fees, slippage, priority fees, and protocol costs",
      "local/fork-equivalent Solana proof demonstrates extractable net value",
      "explicit authorization before any signed action",
    ],
    blockers: watchCandidates.length
      ? [
        "Watch rows are consumer-linked risk surfaces, not proven exploitable routes",
        "No current value-changing producer impact is proven for any accepted mint",
        "No exact DEX/redeem/borrow/liquidation economics are positive in this scanner",
        "No local/fork-equivalent Solana extraction proof exists",
        "Signed action remains fail-closed",
      ]
      : [
        "No material risky receipt/Token-2022 mint currently maps to an executable consumer route",
        "No exact positive economics or local/fork-equivalent proof exists",
        "Signed action remains fail-closed",
      ],
    nextReadOnlyStep: watchCandidates.length
      ? "Treat current consumer-linked rows as research-only; verify current producer-side value impact before exact-quoting borrow/liquidation and exit economics."
      : "Refresh after new Solana asset listings or Token-2022 extension changes; fork/local-proof only after a material row has exact positive economics.",
  };
}

async function main() {
  const sourceErrors = [];
  let connection = null;
  let rpcError = null;
  const producerRows = xstocksProducerRows();
  const consumerRows = [...jupiterConsumers(), ...driftConsumers()];
  let mintRows = new Map();

  try {
    connection = await connectSolanaRpc();
  } catch (error) {
    rpcError = error?.message || String(error);
  }

  if (connection?.url) {
    try {
      consumerRows.push(...await fetchKaminoConsumers(connection.url));
    } catch (error) {
      sourceErrors.push({ source: "Kamino", error: String(error?.message || error).slice(0, 180) });
    }

    try {
      consumerRows.push(...await fetchMarginfiConsumers(connection.url));
    } catch (error) {
      sourceErrors.push({ source: "Marginfi", error: String(error?.message || error).slice(0, 180) });
    }

    try {
      const mints = unique([...consumerRows.map((row) => row.mint), ...producerRows.map((row) => row.mint)]).filter((mint) => mint && mint !== ZERO_PUBKEY);
      mintRows = await fetchMintInfos(connection.url, mints, connection.epochInfo?.epoch || 0);
    } catch (error) {
      sourceErrors.push({ source: "Mint accounts", error: String(error?.message || error).slice(0, 180) });
    }
  } else {
    sourceErrors.push({ source: "Solana RPC", error: String(rpcError || "unavailable").slice(0, 180) });
  }

  const artifact = buildArtifact({ connection, rpcError, consumerRows, mintRows, producerRows, sourceErrors });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");

  if (!QUIET) {
    console.log(`Solana receipt graph: consumers=${artifact.summary.consumerRows} uniqueMints=${artifact.summary.uniqueConsumerMints} token2022Consumers=${artifact.summary.token2022ConsumerMints} receiptLike=${artifact.summary.receiptLikeConsumerMints} watch=${artifact.summary.watchCandidates} routePositive=0`);
    console.log(`Artifact: ${rel(OUT)}`);
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
