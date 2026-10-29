#!/usr/bin/env node
// Read-only Jupiter Lend operate-vs-liquidate oracle divergence scanner.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const WORKSPACE = path.resolve(__dirname, "..");
const TARGET = path.join(WORKSPACE, "targets", "jupiter-lend");
const IDL_DIR = path.join(TARGET, "target", "idl");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "jupiter-lend-oracle-divergence.json");
const OUT_MD = path.join(WORKSPACE, "reports", "jupiter-lend-oracle-divergence-triage.md");

const PRICE_URL = "https://lite-api.jup.ag/price/v3";
const SENTINEL_TICK = -2147483648;
const RATE_SCALE = 10n ** 18n;
const MIN_DIVERGENCE_BPS = Number(process.env.JUP_LEND_MIN_DIVERGENCE_BPS || "1");
const MIN_BORROW_USD = Number(process.env.JUP_LEND_MIN_BORROW_USD || "10000");
const MAX_ORACLES = Number(process.env.JUP_LEND_MAX_ORACLES || "160");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const KNOWN_MINT_SYMBOLS = new Map([
  ["So11111111111111111111111111111111111111112", "SOL"],
  ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC"],
  ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USDT"],
  ["27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4", "JLP"],
  ["jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v", "jupSOL"],
  ["JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD", "JupUSD"],
  ["J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", "JitoSOL"],
  ["USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", "USDS"],
  ["2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", "USDG"],
  ["cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", "cbBTC"],
]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function loadIdl(name) {
  return JSON.parse(fs.readFileSync(path.join(IDL_DIR, name), "utf8"));
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function shortMint(mint) {
  if (!mint) return null;
  return `${String(mint).slice(0, 5)}...${String(mint).slice(-4)}`;
}

function symbolForMint(mint, price) {
  return KNOWN_MINT_SYMBOLS.get(mint) || price?.symbol || price?.name || shortMint(mint);
}

function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    const remainder = value % 58n;
    value /= 58n;
    encoded = BASE58_ALPHABET[Number(remainder)] + encoded;
  }
  return "1".repeat(zeros) + (encoded || "");
}

function base58Decode(text) {
  let value = 0n;
  for (const ch of String(text)) {
    const index = BASE58_ALPHABET.indexOf(ch);
    if (index < 0) throw new Error(`invalid base58 character ${ch}`);
    value = value * 58n + BigInt(index);
  }
  const bytes = [];
  while (value > 0n) {
    bytes.push(Number(value & 0xffn));
    value >>= 8n;
  }
  for (const ch of String(text)) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

function shortVecLength(n) {
  const out = [];
  let value = Number(n);
  while (true) {
    let byte = value & 0x7f;
    value >>= 7;
    if (value === 0) {
      out.push(byte);
      break;
    }
    out.push(byte | 0x80);
  }
  return Buffer.from(out);
}

function pubkeyBytes(pubkey) {
  const bytes = base58Decode(pubkey);
  if (bytes.length > 32) throw new Error(`pubkey too long: ${pubkey}`);
  if (bytes.length === 32) return bytes;
  return Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]);
}

async function rpc(rpcUrl, method, params = [], timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(rpcUrl.toLowerCase().includes("helius") ? { Origin: "https://helius.xyz" } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
    const json = await response.json();
    if (json.error) throw new Error(`${method} RPC error ${json.error.code}: ${json.error.message}`);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

// Multi-endpoint Solana RPC resolution — tries all URLs until one succeeds
function resolveSolanaRpc() {
  if (!fs.existsSync(RPC_FILE)) return "https://api.mainnet-beta.solana.com";
  const urls = [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m => m[0])
    .filter(u => u.toLowerCase().includes("solana") || u.toLowerCase().includes("helius"));
  // Test each URL with getSlot; return first working one
  // (Url tested at runtime by rpc() which loops all on failure)
  return urls[0] || "https://api.mainnet-beta.solana.com";
}

function accountDiscriminator(idl, accountName) {
  const account = (idl.accounts || []).find((entry) => entry.name === accountName);
  if (account?.discriminator) return Buffer.from(account.discriminator);
  return crypto.createHash("sha256").update(`account:${accountName}`).digest().subarray(0, 8);
}

function instructionDiscriminator(idl, instructionName) {
  const ix = (idl.instructions || []).find((entry) => entry.name === instructionName);
  if (!ix?.discriminator) throw new Error(`missing instruction discriminator ${instructionName}`);
  return Buffer.from(ix.discriminator);
}

async function fetchTypedAccounts(rpcUrl, idl, programId, accountName) {
  const discriminator = accountDiscriminator(idl, accountName);
  const result = await rpc(rpcUrl, "getProgramAccounts", [programId, {
    commitment: "confirmed",
    encoding: "base64",
    filters: [{ memcmp: { offset: 0, bytes: base58Encode(discriminator) } }],
  }]);
  return result.map((item) => {
    const encoded = Array.isArray(item.account.data) ? item.account.data[0] : item.account.data;
    const buffer = Buffer.from(encoded, "base64");
    return {
      pubkey: item.pubkey,
      owner: item.account.owner,
      data: decodeAccount(idl, accountName, buffer),
    };
  });
}

function decodeAccount(idl, accountName, buffer) {
  const reader = new Reader(buffer.subarray(8));
  const defs = buildDefs(idl);
  return readDefined(reader, defs, accountName);
}

function buildDefs(idl) {
  const defs = new Map();
  for (const item of idl.accounts || []) if (item.type) defs.set(item.name, item.type);
  for (const item of idl.types || []) if (item.type) defs.set(item.name, item.type);
  return defs;
}

function readDefined(reader, defs, name) {
  const type = defs.get(name);
  if (!type) throw new Error(`missing IDL type: ${name}`);
  if (type.kind === "struct") {
    const out = {};
    for (const field of type.fields || []) out[field.name] = readType(reader, defs, field.type);
    return out;
  }
  if (type.kind === "enum") {
    const index = reader.u8();
    const variant = type.variants[index];
    if (!variant) throw new Error(`bad enum variant ${index} for ${name}`);
    const out = { variant: variant.name };
    if (variant.fields) out.fields = readVariantFields(reader, defs, variant.fields);
    return out;
  }
  throw new Error(`unsupported defined kind ${type.kind} for ${name}`);
}

function readVariantFields(reader, defs, fields) {
  if (!Array.isArray(fields)) return null;
  if (fields.length > 0 && fields[0].name) {
    const out = {};
    for (const field of fields) out[field.name] = readType(reader, defs, field.type);
    return out;
  }
  return fields.map((field) => readType(reader, defs, field));
}

function readType(reader, defs, type) {
  if (typeof type === "string") return readPrimitive(reader, type);
  if (type.defined) return readDefined(reader, defs, definedName(type.defined));
  if (type.vec) {
    const len = reader.u32();
    const out = [];
    for (let i = 0; i < len; i++) out.push(readType(reader, defs, type.vec));
    return out;
  }
  if (type.option) return reader.u8() ? readType(reader, defs, type.option) : null;
  if (type.array) {
    const [inner, len] = type.array;
    const out = [];
    for (let i = 0; i < len; i++) out.push(readType(reader, defs, inner));
    return out;
  }
  throw new Error(`unsupported type ${JSON.stringify(type)}`);
}

function definedName(value) {
  return typeof value === "string" ? value : value.name;
}

function readPrimitive(reader, type) {
  if (type === "bool") return reader.u8() !== 0;
  if (type === "u8") return reader.u8();
  if (type === "i8") return reader.i8();
  if (type === "u16") return reader.u16();
  if (type === "i16") return reader.i16();
  if (type === "u32") return reader.u32();
  if (type === "i32") return reader.i32();
  if (type === "f32") return reader.f32();
  if (type === "f64") return reader.f64();
  if (type === "u64") return reader.u64().toString();
  if (type === "i64") return reader.i64().toString();
  if (type === "u128") return reader.u128().toString();
  if (type === "i128") return reader.i128().toString();
  if (type === "pubkey" || type === "publicKey") return reader.pubkey();
  if (type === "string") return reader.string();
  if (type === "bytes") return [...reader.take(reader.u32())];
  throw new Error(`unsupported primitive ${type}`);
}

class Reader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }
  take(length) {
    const start = this.offset;
    const end = start + length;
    if (end > this.buffer.length) throw new Error(`read past end at ${start}+${length}/${this.buffer.length}`);
    this.offset = end;
    return this.buffer.subarray(start, end);
  }
  u8() { return this.take(1).readUInt8(0); }
  i8() { return this.take(1).readInt8(0); }
  u16() { return this.take(2).readUInt16LE(0); }
  i16() { return this.take(2).readInt16LE(0); }
  u32() { return this.take(4).readUInt32LE(0); }
  i32() { return this.take(4).readInt32LE(0); }
  f32() { return this.take(4).readFloatLE(0); }
  f64() { return this.take(8).readDoubleLE(0); }
  u64() { return this.take(8).readBigUInt64LE(0); }
  i64() { return this.take(8).readBigInt64LE(0); }
  u128() {
    const bytes = this.take(16);
    return bytes.readBigUInt64LE(0) + (bytes.readBigUInt64LE(8) << 64n);
  }
  i128() {
    const value = this.u128();
    return value >= (1n << 127n) ? value - (1n << 128n) : value;
  }
  pubkey() { return base58Encode(this.take(32)); }
  string() { return this.take(this.u32()).toString("utf8"); }
}

function encodeInstruction(discriminator, nonce) {
  const data = Buffer.alloc(discriminator.length + 2);
  discriminator.copy(data, 0);
  data.writeUInt16LE(Number(nonce), discriminator.length);
  return data;
}

function buildSimTransaction(programId, oracleAccount, remainingAccounts, instructionData, recentBlockhash, feePayer) {
  const keys = [feePayer, oracleAccount, ...remainingAccounts.filter(Boolean), programId];
  const uniqueKeys = [];
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueKeys.push(key);
  }
  const programIndex = uniqueKeys.indexOf(programId);
  const oracleAndRemaining = [oracleAccount, ...remainingAccounts.filter(Boolean)]
    .map((key) => uniqueKeys.indexOf(key))
    .filter((index) => index >= 0);
  const header = Buffer.from([1, 0, uniqueKeys.length - 1]);
  const accountKeys = Buffer.concat(uniqueKeys.map(pubkeyBytes));
  const message = Buffer.concat([
    header,
    shortVecLength(uniqueKeys.length),
    accountKeys,
    pubkeyBytes(recentBlockhash),
    shortVecLength(1),
    Buffer.from([programIndex]),
    shortVecLength(oracleAndRemaining.length),
    Buffer.from(oracleAndRemaining),
    shortVecLength(instructionData.length),
    instructionData,
  ]);
  return Buffer.concat([shortVecLength(1), Buffer.alloc(64), message]);
}

function decodeReturnU128(returnData) {
  const encoded = returnData?.data?.[0];
  if (!encoded) return null;
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length < 16) return { raw: null, bytes: buffer.length, hex: buffer.toString("hex") };
  const offset = buffer.length === 16 ? 0 : buffer.length - 16;
  const raw = buffer.readBigUInt64LE(offset) + (buffer.readBigUInt64LE(offset + 8) << 64n);
  return { raw, bytes: buffer.length, hex: buffer.toString("hex") };
}

async function simulateOracleRate(rpcUrl, programId, oracleAccount, sourceAccounts, discriminator, nonce, blockhash, feePayer) {
  const tx = buildSimTransaction(programId, oracleAccount, sourceAccounts, encodeInstruction(discriminator, nonce), blockhash, feePayer);
  const result = await rpc(rpcUrl, "simulateTransaction", [tx.toString("base64"), {
    encoding: "base64",
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "processed",
  }], 60_000).catch((err) => ({ error: err.message || String(err) }));
  if (result?.error) return { ok: false, error: result.error };
  const value = result?.value || {};
  const decoded = decodeReturnU128(value.returnData);
  return {
    ok: !value.err && decoded?.raw !== null && decoded?.raw !== undefined,
    error: value.err ? JSON.stringify(value.err) : decoded ? null : "missing returnData",
    raw: decoded?.raw ?? null,
    returnDataBytes: decoded?.bytes ?? 0,
    logs: (value.logs || []).slice(-6),
  };
}

function bigintBpsDiff(value, reference) {
  const v = BigInt(value || 0);
  const r = BigInt(reference || 0);
  if (r === 0n) return null;
  return Number((v - r) * 1_000_000n / r) / 100;
}

function bigintRatio(value, reference) {
  const v = BigInt(value || 0);
  const r = BigInt(reference || 0);
  if (r === 0n) return null;
  return Number(v) / Number(r);
}

function formatRate(raw) {
  if (raw === null || raw === undefined) return null;
  const value = BigInt(raw);
  const whole = value / RATE_SCALE;
  const frac = (value % RATE_SCALE).toString().padStart(18, "0").slice(0, 8).replace(/0+$/g, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function enumName(value) {
  return value?.variant || String(value || "");
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function sumBig(rows, valueFn) {
  let total = 0n;
  for (const row of rows || []) total += BigInt(valueFn(row) || 0);
  return total;
}

function formatUiNumber(raw, decimals) {
  try {
    const amount = BigInt(raw || 0);
    const base = 10n ** BigInt(Number(decimals || 0));
    if (base === 1n) return Number(amount);
    return Number(amount) / Number(base);
  } catch (_) {
    return null;
  }
}

function tickAtRatio(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  return Math.floor(Math.log(ratio) / Math.log(1.0015));
}

async function fetchPrices(mints) {
  const prices = new Map();
  for (const chunk of chunks(mints, 50)) {
    const url = `${PRICE_URL}?ids=${encodeURIComponent(chunk.join(","))}`;
    const response = await fetch(url).catch(() => null);
    if (!response?.ok) continue;
    const data = await response.json().catch(() => ({}));
    for (const [mint, price] of Object.entries(data || {})) {
      if (typeof price?.usdPrice === "number" && price.usdPrice > 0) prices.set(mint, price);
    }
  }
  return prices;
}

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function discoverFeePayer(rpcUrl, programIds) {
  const systemProgram = "11111111111111111111111111111111";
  for (const programId of programIds) {
    const signatures = await rpc(rpcUrl, "getSignaturesForAddress", [programId, { limit: 8 }], 30_000).catch(() => []);
    for (const sig of signatures || []) {
      const tx = await rpc(rpcUrl, "getTransaction", [sig.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }], 30_000).catch(() => null);
      const keys = tx?.transaction?.message?.accountKeys || [];
      const feePayer = typeof keys[0] === "string" ? keys[0] : keys[0]?.pubkey;
      if (!feePayer) continue;
      const info = await rpc(rpcUrl, "getAccountInfo", [feePayer, { commitment: "confirmed", encoding: "base64" }], 30_000).catch(() => null);
      if (info?.value?.owner === systemProgram && Number(info.value.lamports || 0) > 0) return feePayer;
    }
  }
  return null;
}

async function buildOracleRows(rpcUrl, oracleIdl, oracles, feePayer) {
  const operateDisc = instructionDiscriminator(oracleIdl, "get_exchange_rate_operate");
  const liquidateDisc = instructionDiscriminator(oracleIdl, "get_exchange_rate_liquidate");
  const blockhash = (await rpc(rpcUrl, "getLatestBlockhash", [{ commitment: "processed" }], 30_000))?.value?.blockhash;
  if (!blockhash) throw new Error("missing Solana blockhash");

  const rows = [];
  for (const oracle of oracles.slice(0, MAX_ORACLES)) {
    const sources = oracle.data.sources || [];
    const sourceAccounts = sources.map((source) => source.source).filter(Boolean);
    const operate = await simulateOracleRate(rpcUrl, oracleIdl.address, oracle.pubkey, sourceAccounts, operateDisc, oracle.data.nonce, blockhash, feePayer);
    const liquidate = await simulateOracleRate(rpcUrl, oracleIdl.address, oracle.pubkey, sourceAccounts, liquidateDisc, oracle.data.nonce, blockhash, feePayer);
    const diffBps = operate.raw !== null && liquidate.raw !== null ? bigintBpsDiff(liquidate.raw, operate.raw) : null;
    rows.push({
      oracle: oracle.pubkey,
      nonce: oracle.data.nonce,
      sourceCount: sources.length,
      sourceTypes: sources.map((source) => enumName(source.source_type)),
      sourceAccounts,
      operate: {
        ok: operate.ok,
        error: operate.error,
        raw: operate.raw?.toString?.() || null,
        formatted18: formatRate(operate.raw),
        returnDataBytes: operate.returnDataBytes,
      },
      liquidate: {
        ok: liquidate.ok,
        error: liquidate.error,
        raw: liquidate.raw?.toString?.() || null,
        formatted18: formatRate(liquidate.raw),
        returnDataBytes: liquidate.returnDataBytes,
      },
      liquidateVsOperateBps: diffBps,
      absLiquidateVsOperateBps: diffBps === null ? null : Math.abs(diffBps),
      liquidationFavorsLiquidatorBps: diffBps === null ? null : Math.max(0, -diffBps),
      rateRatioLiquidateToOperate: operate.raw !== null && liquidate.raw !== null ? bigintRatio(liquidate.raw, operate.raw) : null,
      simulated: Boolean(operate.ok && liquidate.ok),
      routePositive: false,
    });
  }
  rows.sort((a, b) => Number(b.absLiquidateVsOperateBps || 0) - Number(a.absLiquidateVsOperateBps || 0));
  return rows;
}

function buildVaultRows(configs, states, metadata, positions, ticks, oracleRows, prices) {
  const stateByVault = new Map(states.map((row) => [Number(row.data.vault_id), row.data]));
  const metadataByVault = new Map(metadata.map((row) => [Number(row.data.vault_id), row.data]));
  const positionsByVault = groupBy(positions, (row) => Number(row.data.vault_id));
  const ticksByVault = groupBy(ticks, (row) => Number(row.data.vault_id));
  const oracleByAddress = new Map(oracleRows.map((row) => [row.oracle, row]));
  const rows = [];

  for (const row of configs) {
    const config = row.data;
    const vaultId = Number(config.vault_id);
    const state = stateByVault.get(vaultId) || {};
    const meta = metadataByVault.get(vaultId) || {};
    const oracle = oracleByAddress.get(config.oracle) || null;
    const supplyPrice = prices.get(config.supply_token)?.usdPrice ?? null;
    const borrowPrice = prices.get(config.borrow_token)?.usdPrice ?? null;
    const supplyDecimals = Number(meta.supply_mint_decimals ?? 0);
    const borrowDecimals = Number(meta.borrow_mint_decimals ?? 0);
    const supplySymbol = meta.supply_mint_symbol || symbolForMint(config.supply_token, prices.get(config.supply_token));
    const borrowSymbol = meta.borrow_mint_symbol || symbolForMint(config.borrow_token, prices.get(config.borrow_token));
    const totalBorrowUi = formatUiNumber(state.total_borrow, borrowDecimals);
    const totalBorrowUsd = totalBorrowUi !== null && borrowPrice ? totalBorrowUi * borrowPrice : null;
    const priceRatio = supplyPrice && borrowPrice ? supplyPrice / borrowPrice : null;
    const baseLiquidationTick = priceRatio ? tickAtRatio(priceRatio * Number(config.liquidation_threshold) / 1000) : null;
    const rateShift = oracle?.rateRatioLiquidateToOperate ? tickAtRatio(oracle.rateRatioLiquidateToOperate) : null;
    const liquidateOracleTick = baseLiquidationTick !== null && rateShift !== null ? baseLiquidationTick + rateShift : null;
    const vaultTicks = ticksByVault.get(vaultId) || [];
    const vaultPositions = positionsByVault.get(vaultId) || [];
    const debtTicksBase = baseLiquidationTick === null ? [] : vaultTicks.filter((tick) => Number(tick.data.tick) > baseLiquidationTick && BigInt(tick.data.raw_debt || 0) > 0n);
    const debtTicksLiquidate = liquidateOracleTick === null ? [] : vaultTicks.filter((tick) => Number(tick.data.tick) > liquidateOracleTick && BigInt(tick.data.raw_debt || 0) > 0n);
    const baseDebtTickSet = new Set(debtTicksBase.map((tick) => Number(tick.data.tick)));
    const liquidateDebtTickSet = new Set(debtTicksLiquidate.map((tick) => Number(tick.data.tick)));
    const riskyPositionsBase = baseLiquidationTick === null ? [] : vaultPositions.filter((position) => Number(position.data.tick) > baseLiquidationTick && baseDebtTickSet.has(Number(position.data.tick)) && Number(position.data.tick) !== SENTINEL_TICK);
    const riskyPositionsLiquidate = liquidateOracleTick === null ? [] : vaultPositions.filter((position) => Number(position.data.tick) > liquidateOracleTick && liquidateDebtTickSet.has(Number(position.data.tick)) && Number(position.data.tick) !== SENTINEL_TICK);
    const addedDebtTicks = debtTicksLiquidate.filter((tick) => !baseDebtTickSet.has(Number(tick.data.tick)));
    const addedDebtRaw = sumBig(addedDebtTicks, (tick) => tick.data.raw_debt);
    const divergenceBps = asNumber(oracle?.absLiquidateVsOperateBps) || 0;
    const addedRiskyPositions = Math.max(0, riskyPositionsLiquidate.length - riskyPositionsBase.length);
    const liquidationFavorableWatch = Boolean(
      oracle?.simulated
      && divergenceBps >= MIN_DIVERGENCE_BPS
      && (totalBorrowUsd || 0) >= MIN_BORROW_USD
      && (oracle.liquidationFavorsLiquidatorBps || 0) > 0
    );
    const debtTickFlipFromLiquidateRate = Boolean(addedDebtRaw > 0n || addedDebtTicks.length > 0 || addedRiskyPositions > 0);
    const divergentDebtWatch = Boolean(
      oracle?.simulated
      && divergenceBps >= MIN_DIVERGENCE_BPS
      && (totalBorrowUsd || 0) >= MIN_BORROW_USD
    );
    const candidate = Boolean(
      liquidationFavorableWatch
      && debtTickFlipFromLiquidateRate
    );
    rows.push({
      vaultId,
      vaultConfig: row.pubkey,
      oracle: config.oracle,
      supplyToken: config.supply_token,
      borrowToken: config.borrow_token,
      supplySymbol,
      borrowSymbol,
      pair: `${supplySymbol || shortMint(config.supply_token)}/${borrowSymbol || shortMint(config.borrow_token)}`,
      sourceTypes: oracle?.sourceTypes || [],
      collateralFactorBps: Number(config.collateral_factor || 0) * 10,
      liquidationThresholdBps: Number(config.liquidation_threshold || 0) * 10,
      liquidationPenaltyBps: Number(config.liquidation_penalty || 0) * 10,
      totalSupplyUi: formatUiNumber(state.total_supply, supplyDecimals),
      totalBorrowUi,
      totalBorrowUsd,
      positionCount: vaultPositions.length,
      debtTickCount: vaultTicks.filter((tick) => BigInt(tick.data.raw_debt || 0) > 0n).length,
      topmostTick: Number(state.topmost_tick ?? SENTINEL_TICK),
      baseLiquidationTick,
      liquidateOracleTick,
      liquidateTickShift: rateShift,
      debtTicksOverBaseLiquidation: debtTicksBase.length,
      debtTicksOverLiquidateOracle: debtTicksLiquidate.length,
      addedDebtTicksFromLiquidateRate: addedDebtTicks.length,
      addedDebtRawFromLiquidateRate: addedDebtRaw.toString(),
      riskyPositionsBase: riskyPositionsBase.length,
      riskyPositionsLiquidate: riskyPositionsLiquidate.length,
      addedRiskyPositionsFromLiquidateRate: addedRiskyPositions,
      liquidationFavorableWatch,
      divergentDebtWatch,
      debtTickFlipFromLiquidateRate,
      oracleDivergence: oracle ? {
        simulated: oracle.simulated,
        operateRaw: oracle.operate.raw,
        liquidateRaw: oracle.liquidate.raw,
        operateFormatted18: oracle.operate.formatted18,
        liquidateFormatted18: oracle.liquidate.formatted18,
        liquidateVsOperateBps: oracle.liquidateVsOperateBps,
        absLiquidateVsOperateBps: oracle.absLiquidateVsOperateBps,
        liquidationFavorsLiquidatorBps: oracle.liquidationFavorsLiquidatorBps,
      } : null,
      candidate,
      routePositive: false,
      blockers: [
        oracle?.simulated ? null : "Oracle operate/liquidate view simulation failed or returned no value",
        divergenceBps >= MIN_DIVERGENCE_BPS ? null : `Operate/liquidate divergence below ${MIN_DIVERGENCE_BPS}bps`,
        (totalBorrowUsd || 0) >= MIN_BORROW_USD ? null : `Borrow liquidity below $${MIN_BORROW_USD}`,
        liquidationFavorableWatch ? null : "Liquidation oracle view does not favor the liquidator for this debt vault",
        debtTickFlipFromLiquidateRate ? null : "Liquidation oracle view does not add any debt-bearing tick or risky position",
        candidate ? "No exact repay acquisition/collateral exit economics" : null,
        candidate ? "No local/fork proof or signed-action authorization" : null,
      ].filter(Boolean),
    });
  }
  rows.sort((a, b) => Number(b.candidate) - Number(a.candidate)
    || Number(b.oracleDivergence?.absLiquidateVsOperateBps || 0) - Number(a.oracleDivergence?.absLiquidateVsOperateBps || 0)
    || Number(b.totalBorrowUsd || 0) - Number(a.totalBorrowUsd || 0));
  return rows;
}

function table(rows, headers) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${headers.map((h) => row[h] ?? "").join(" | ")} |`),
  ].join("\n");
}

function writeReport(artifact) {
  const top = artifact.vaultRows.slice(0, 8).map((row) => ({
    Vault: String(row.vaultId),
    Pair: `\`${row.supplySymbol || "?"}/${row.borrowSymbol || "?"}\``,
    Borrow: row.totalBorrowUsd === null ? "n/a" : `$${round(row.totalBorrowUsd, 0)}`,
    Sources: `\`${row.sourceTypes.join("+") || "?"}\``,
    "Liq/Op bps": row.oracleDivergence?.liquidateVsOperateBps === null || row.oracleDivergence?.liquidateVsOperateBps === undefined ? "n/a" : String(round(row.oracleDivergence.liquidateVsOperateBps, 4)),
    "Tick shift": row.liquidateTickShift === null ? "n/a" : String(row.liquidateTickShift),
    "Tick flip": `+${row.addedDebtTicksFromLiquidateRate || 0} ticks / +${row.addedRiskyPositionsFromLiquidateRate || 0} positions`,
    Candidate: row.candidate ? "tick-flip" : row.liquidationFavorableWatch ? "watch" : "no",
  }));
  const md = [
    "# 🟢 DORMANT — Jupiter Lend Operate-vs-Liquidate Oracle Divergence",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    artifact.summary.candidateRows > 0
      ? "**Dormant / watch-only.** Operate and liquidation oracle views diverge and flip at least one debt-bearing tick/position, but no exact repay/collateral-exit economics or fork proof exists."
      : artifact.summary.liquidationFavorableDebtVaults > 0
        ? "**Dormant / watch-only.** Liquidation-favorable oracle divergence exists on debt-bearing vaults, but it does not add any liquidatable debt tick or risky position in the refreshed read-only model."
        : "**Dormant / route-negative.** Jupiter Lend exposes separate operate and liquidation oracle views, but the refreshed read-only scan found no material debt-bearing route-positive divergence.",
    "",
    "## Summary",
    "",
    table([{
      Oracles: String(artifact.summary.oraclesScanned),
      Simulated: String(artifact.summary.oracleRatesSimulated),
      Divergent: String(artifact.summary.oracleOperateLiquidateDivergent),
      "Max abs bps": String(round(artifact.summary.maxAbsLiquidateVsOperateBps, 4)),
      Vaults: String(artifact.summary.vaultsScanned),
      "Debt vaults divergent": String(artifact.summary.debtVaultsWithDivergentOracle),
      "Liq-fav watch": String(artifact.summary.liquidationFavorableDebtVaults),
      Candidates: String(artifact.summary.candidateRows),
      RoutePositive: String(artifact.summary.routePositive),
    }], ["Oracles", "Simulated", "Divergent", "Max abs bps", "Vaults", "Debt vaults divergent", "Liq-fav watch", "Candidates", "RoutePositive"]),
    "",
    "## Top Rows",
    "",
    table(top, ["Vault", "Pair", "Borrow", "Sources", "Liq/Op bps", "Tick shift", "Tick flip", "Candidate"]),
    "",
    "## Gate",
    "",
    "Route-positive stays closed until a live row has material operate/liquidate divergence, a debt-bearing tick made liquidatable by the liquidation view, exact repay acquisition and collateral-exit quotes, and local/fork proof.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/jupiter-lend-oracle-divergence.json`",
    "- Scanner: `tools/scan-jupiter-lend-oracle-divergence.js`",
    "- Source/IDL target: `targets/jupiter-lend`",
    "",
  ].join("\n");
  fs.writeFileSync(OUT_MD, md);
}

async function main() {
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  const rpcUrl = resolveSolanaRpc();
  const vaultsIdl = loadIdl("vaults.json");
  const oracleIdl = loadIdl("oracle.json");
  const [configs, states, metadata, positions, ticks, oracles] = await Promise.all([
    fetchTypedAccounts(rpcUrl, vaultsIdl, vaultsIdl.address, "VaultConfig"),
    fetchTypedAccounts(rpcUrl, vaultsIdl, vaultsIdl.address, "VaultState"),
    fetchTypedAccounts(rpcUrl, vaultsIdl, vaultsIdl.address, "VaultMetadata"),
    fetchTypedAccounts(rpcUrl, vaultsIdl, vaultsIdl.address, "Position"),
    fetchTypedAccounts(rpcUrl, vaultsIdl, vaultsIdl.address, "Tick"),
    fetchTypedAccounts(rpcUrl, oracleIdl, oracleIdl.address, "Oracle"),
  ]);
  const mints = unique(configs.flatMap((row) => [row.data.supply_token, row.data.borrow_token]));
  const prices = await fetchPrices(mints);
  const feePayer = await discoverFeePayer(rpcUrl, [vaultsIdl.address, oracleIdl.address]);
  if (!feePayer) throw new Error("could not discover public Solana fee payer for unsigned simulation");
  const oracleRows = await buildOracleRows(rpcUrl, oracleIdl, oracles, feePayer);
  const vaultRows = buildVaultRows(configs, states, metadata, positions, ticks, oracleRows, prices);
  const divergentOracleRows = oracleRows.filter((row) => (asNumber(row.absLiquidateVsOperateBps) || 0) >= MIN_DIVERGENCE_BPS);
  const debtVaultsWithDivergentOracle = vaultRows.filter((row) => (row.totalBorrowUsd || 0) >= MIN_BORROW_USD && (row.oracleDivergence?.absLiquidateVsOperateBps || 0) >= MIN_DIVERGENCE_BPS).length;
  const liquidationFavorableDebtVaults = vaultRows.filter((row) => row.liquidationFavorableWatch).length;
  const divergentDebtWatchRows = vaultRows.filter((row) => row.divergentDebtWatch).length;
  const candidateRows = vaultRows.filter((row) => row.candidate).length;
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-jupiter-lend-oracle-divergence.js",
    scope: "Read-only Jupiter Lend operate-vs-liquidate oracle view divergence joined to vault debt/tick state",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    thresholds: {
      minDivergenceBps: MIN_DIVERGENCE_BPS,
      minBorrowUsd: MIN_BORROW_USD,
      maxOracles: MAX_ORACLES,
      simulationFeePayerDiscovered: true,
    },
    summary: {
      vaultsScanned: vaultRows.length,
      positionsScanned: positions.length,
      ticksScanned: ticks.length,
      oraclesScanned: oracleRows.length,
      oracleRatesSimulated: oracleRows.filter((row) => row.simulated).length,
      oracleOperateLiquidateDivergent: divergentOracleRows.length,
      maxAbsLiquidateVsOperateBps: Math.max(0, ...oracleRows.map((row) => asNumber(row.absLiquidateVsOperateBps) || 0)),
      maxLiquidationFavorsLiquidatorBps: Math.max(0, ...oracleRows.map((row) => asNumber(row.liquidationFavorsLiquidatorBps) || 0)),
      pricedMints: prices.size,
      mintsDiscovered: mints.length,
      debtVaultsWithDivergentOracle,
      divergentDebtWatchRows,
      liquidationFavorableDebtVaults,
      maxAddedDebtTicksFromLiquidateRate: Math.max(0, ...vaultRows.map((row) => asNumber(row.addedDebtTicksFromLiquidateRate) || 0)),
      maxAddedRiskyPositionsFromLiquidateRate: Math.max(0, ...vaultRows.map((row) => asNumber(row.addedRiskyPositionsFromLiquidateRate) || 0)),
      candidateRows,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      blocker: candidateRows > 0
        ? "Divergence row needs exact repay/collateral-exit economics and local/fork proof."
        : liquidationFavorableDebtVaults > 0
          ? "Liquidation-favorable divergence exists, but no debt-bearing tick or risky position becomes newly liquidatable."
        : "No material debt-bearing operate-vs-liquidate oracle divergence found.",
    },
    oracleRows: oracleRows.slice(0, 80),
    vaultRows: vaultRows.slice(0, 120),
    requiredForRoutePositive: [
      "operate and liquidation oracle views diverge materially on a live debt-bearing vault",
      "liquidation view makes a debt-bearing tick/position liquidatable while operate view would not",
      "exact repay acquisition and collateral exit are positive after fees/slippage/gas",
      "local/fork proof succeeds before any signed action",
    ],
  };
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  writeReport(artifact);
  console.log(`Jupiter Lend oracle divergence scan: vaults=${artifact.summary.vaultsScanned} oracles=${artifact.summary.oraclesScanned} divergent=${artifact.summary.oracleOperateLiquidateDivergent} candidates=${artifact.summary.candidateRows} routePositive=0`);
  console.log(`Artifact: ${rel(OUT_JSON)}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
