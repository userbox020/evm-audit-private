#!/usr/bin/env node
// Phase 1: Kamino Oracle Config Scanner
// Reads Kamino Main Market reserves and decodes oracle configuration:
// Scope/Switchboard/Pyth oracle source addresses, TWAP settings,
// heuristic bounds, max age, and current price status flags.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "kamino-oracle-config.json");
const QUIET = process.argv.includes("--quiet");

const PROGRAM_ID = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const RESERVE_SIZE = 8 + 8616;
const MARKET_OFFSET = 32;

// TokenInfo starts at offset 5032 within raw account data.
// Fields inside TokenInfo (offsets relative to byte 0 of raw data):
const TOKEN_INFO_OFFSET = 5032;
const HEURISTIC_LOWER = 5064;   // u64
const HEURISTIC_UPPER = 5072;   // u64
const HEURISTIC_EXP = 5080;     // u64
const MAX_TWAP_DIV_BPS = 5088;  // u64
const MAX_AGE_PRICE_S = 5096;   // u64
const MAX_AGE_TWAP_S = 5104;    // u64
const SCOPE_FEED = 5112;        // Pubkey (32 bytes)
const SCOPE_CHAIN = 5144;       // [u16;4] (8 bytes)
const SCOPE_TWAP_CHAIN = 5152;  // [u16;4] (8 bytes)
const SWITCHBOARD_PRICE = 5160; // Pubkey (32 bytes)
const SWITCHBOARD_TWAP = 5192;  // Pubkey (32 bytes)
const PYTH_PRICE = 5224;        // Pubkey (32 bytes)
const BLOCK_PRICE_USAGE = 5256; // u8

// Price status flags (offset 25)
const PRICE_LOADED = 0x01;
const PRICE_AGE_CHECKED = 0x02;
const TWAP_CHECKED = 0x04;
const TWAP_AGE_CHECKED = 0x08;
const HEURISTIC_CHECKED = 0x10;
const PRICE_USAGE_ALLOWED = 0x20;
const ALL_CHECKS = PRICE_LOADED | PRICE_AGE_CHECKED | TWAP_CHECKED | TWAP_AGE_CHECKED | HEURISTIC_CHECKED | PRICE_USAGE_ALLOWED;
const LIQUIDATION_CHECKS = PRICE_LOADED | PRICE_AGE_CHECKED | PRICE_USAGE_ALLOWED;

const ZERO_PUBKEY = "11111111111111111111111111111111";

function loadRpcUrl() {
  const candidates = [path.join(WORKSPACE, "rpc_endpoints.txt"), path.join(WORKSPACE, "..", "rpc_endpoints.txt")];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim().toLowerCase();
      if (!t || t.startsWith("#")) continue;
      if (t.includes("solana") && t.includes("http")) {
        const start = t.indexOf("http");
        return line.trim().slice(start).split(/\s+/)[0].replace(/["'`,;]+$/g, "");
      }
    }
  }
  return null;
}

async function rpc(url, method, params = []) {
  const headers = { "content-type": "application/json" };
  if (url.toLowerCase().includes("helius")) headers["Origin"] = "https://helius.xyz";
  const res = await fetch(url, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

function accountData(entry) {
  const raw = entry.account?.data;
  if (!raw) return null;
  if (Array.isArray(raw)) return Buffer.from(raw[0], "base64");
  return Buffer.from(typeof raw === "string" ? raw : raw[0] || "", "base64");
}

function readU64Le(buf, offset) {
  return buf.readBigUInt64LE(offset);
}

function readPubkey(buf, offset) {
  const bytes = buf.slice(offset, offset + 32);
  if (bytes.every(b => b === 0)) return ZERO_PUBKEY;
  return base58Encode(bytes);
}

function asciiAt(buf, offset, length) {
  let s = "";
  for (let i = 0; i < length; i++) {
    const b = buf[offset + i];
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s.trim();
}

function base58Encode(buf) {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let digits = [0];
  for (const b of buf) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let result = "";
  for (const d of digits.reverse()) result += ALPHABET[d];
  for (const b of buf) { if (b === 0) result = "1" + result; else break; }
  return result;
}

function priceStatusLabels(status) {
  const labels = [];
  if (status & PRICE_LOADED) labels.push("loaded");
  if (status & PRICE_AGE_CHECKED) labels.push("age_checked");
  if (status & TWAP_CHECKED) labels.push("twap");
  if (status & TWAP_AGE_CHECKED) labels.push("twap_age");
  if (status & HEURISTIC_CHECKED) labels.push("heuristic");
  if (status & PRICE_USAGE_ALLOWED) labels.push("usage_allowed");
  return labels.join(",");
}

function hasAllChecks(status) { return (status & ALL_CHECKS) === ALL_CHECKS; }
function hasLiquidationChecks(status) { return (status & LIQUIDATION_CHECKS) === LIQUIDATION_CHECKS; }

async function main() {
  const rpcUrl = loadRpcUrl();
  if (!rpcUrl) { console.error("No Solana RPC URL resolved"); process.exit(1); }

  // Fetch all reserves for the Main Market
  const accounts = await rpc(rpcUrl, "getProgramAccounts", [PROGRAM_ID, {
    commitment: "processed",
    encoding: "base64",
    filters: [{ dataSize: RESERVE_SIZE }, { memcmp: { offset: MARKET_OFFSET, bytes: MAIN_MARKET } }],
  }]);

  const reserves = [];
  for (const entry of accounts) {
    const data = accountData(entry);
    if (!data) continue;
    const pubkey = entry.pubkey;

    // Basic fields
    const status = data.readUInt8(25);
    const slot = readU64Le(data, 16);
    const name = asciiAt(data, 4856 + 176, 32);
    const protocolFeePct = data.readUInt8(4856 + 15);
    const minBonusBps = data.readUInt16LE(4856 + 18);

    // Oracle config
    const scopeFeed = readPubkey(data, SCOPE_FEED);
    const switchboardPrice = readPubkey(data, SWITCHBOARD_PRICE);
    const switchboardTwap = readPubkey(data, SWITCHBOARD_TWAP);
    const pythPrice = readPubkey(data, PYTH_PRICE);
    const scopeChain = data.readUInt16LE(SCOPE_CHAIN);
    const scopeTwapChain = data.readUInt16LE(SCOPE_TWAP_CHAIN);
    const heuristicLowerRaw = readU64Le(data, HEURISTIC_LOWER);
    const heuristicUpperRaw = readU64Le(data, HEURISTIC_UPPER);
    const heuristicExp = Number(readU64Le(data, HEURISTIC_EXP));
    const maxTwapDivBps = Number(readU64Le(data, MAX_TWAP_DIV_BPS));
    const maxAgePriceS = Number(readU64Le(data, MAX_AGE_PRICE_S));
    const maxAgeTwapS = Number(readU64Le(data, MAX_AGE_TWAP_S));
    const blockPriceUsage = data.readUInt8(BLOCK_PRICE_USAGE);

    // Determine oracle type
    const oracles = [];
    if (scopeFeed !== ZERO_PUBKEY) oracles.push("scope");
    if (switchboardPrice !== ZERO_PUBKEY) oracles.push("switchboard");
    if (pythPrice !== ZERO_PUBKEY) oracles.push("pyth");

    // Heuristic: compute the heuristic range as ratio
    let heuristicRatio = null;
    if (heuristicExp > 0 && heuristicLowerRaw > 0n) {
      heuristicRatio = Number(heuristicUpperRaw) / Number(heuristicLowerRaw);
    }

    reserves.push({
      pubkey, symbol: name,
      status, status_labels: priceStatusLabels(status),
      all_checks_passed: hasAllChecks(status),
      liquidation_checks_passed: hasLiquidationChecks(status),
      slot: slot.toString(),
      protocol_fee_pct: protocolFeePct,
      min_liquidation_bonus_bps: minBonusBps,
      oracle_types: oracles,
      scope: {
        feed: scopeFeed,
        chain: scopeChain,
        twap_chain: scopeTwapChain,
      },
      switchboard: {
        price_aggregator: switchboardPrice,
        twap_aggregator: switchboardTwap,
      },
      pyth: {
        price_feed: pythPrice,
      },
      twap: {
        max_divergence_bps: maxTwapDivBps,
        max_age_price_seconds: maxAgePriceS,
        max_age_twap_seconds: maxAgeTwapS,
      },
      heuristic: {
        lower_raw: heuristicLowerRaw.toString(),
        upper_raw: heuristicUpperRaw.toString(),
        exp: heuristicExp,
        upper_lower_ratio: heuristicRatio,
      },
      block_price_usage: blockPriceUsage,
      block_price_blocked: blockPriceUsage !== 0,
    });
  }

  const byOracle = {};
  for (const r of reserves) for (const o of r.oracle_types) byOracle[o] = (byOracle[o] || 0) + 1;
  const twapDisabled = reserves.filter(r => r.twap.max_divergence_bps === 0).length;
  const noAllChecks = reserves.filter(r => !r.all_checks_passed).length;
  const reducedLiquidation = reserves.filter(r => !r.all_checks_passed && r.liquidation_checks_passed).length;

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-kamino-oracle-config.js",
    scope: "Read-only Kamino Klend oracle configuration scanner (Phase 1 of 4)",
    safety: {
      rpcInventoryRead: true, rpcUrlsStored: false, envFilesRead: false,
      privateKeysRead: false, signedActions: false, exploitExecuteCalls: false,
      forkTransactions: false, routePositive: false, signedActionJustified: false,
    },
    program: PROGRAM_ID, market: MAIN_MARKET,
    summary: {
      reserves_scanned: reserves.length,
      by_oracle_type: byOracle,
      twap_disabled: twapDisabled,
      no_all_checks: noAllChecks,
      reduced_liquidation_checks: reducedLiquidation,
      scope_reserves: reserves.filter(r => r.oracle_types.includes("scope")).length,
      switchboard_reserves: reserves.filter(r => r.oracle_types.includes("switchboard")).length,
      pyth_reserves: reserves.filter(r => r.oracle_types.includes("pyth")).length,
      route_positive: 0,
    },
    reserves,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  const line = `Kamino oracle config: reserves=${artifact.summary.reserves_scanned} scope=${artifact.summary.scope_reserves} switchboard=${artifact.summary.switchboard_reserves} pyth=${artifact.summary.pyth_reserves} twap_off=${artifact.summary.twap_disabled} reduced_liq=${artifact.summary.reduced_liquidation}`;
  console.log(line);
  if (!QUIET) console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}
main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
