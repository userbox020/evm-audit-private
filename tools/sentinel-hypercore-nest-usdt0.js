#!/usr/bin/env node
"use strict";

// Offline caller-supplied observations only. Neither official spotMeta identity nor
// historical Nest deployment is a current on-chain attestation. No reader, fork,
// execution, signer, price probability, or assumption of atomic Core↔EVM transfer.
// Snapshot contract (canonical unsigned integer strings; quoted USDC is native
// Nest USDC raw6, not Core USDC's different EVM token):
// {schema:"hypercore-nest-usdt0/snapshot-v1", spotMeta:{tokens:[
//   {index:268,tokenId,evmAddress,szDecimals:2,weiDecimals:8,
//     evmExtraWeiDecimals:-2,verified:true},
//   {index:0,tokenId,evmAddress,weiDecimals:8,verified:true}],
//   pair:{index:166,tokens:[268,0]}},
//   book:{coin:"@166",observedAtMs,receivedAtMs,
//     bids:[{priceRaw,qtyLots}],asks:[{priceRaw,qtyLots}]},
//   evm:{chainId:999,block,hash,timestampMs,finalized:true},
//   pool:{address,factory,codePresent:true,verified:true,block,hash,
//     token0:nativeUsdc,token1:usdt0,token0Decimals:6,token1Decimals:6},
//   direction:"CORE_BUY_NEST_SELL"|"NEST_BUY_CORE_SELL",sizeUsdcRaw,
//   quote:{exactInput:true,feeIncluded:true,block,hash,tokenIn,tokenOut,
//     decimalsIn:6,decimalsOut:6,amountInRaw,amountOutRaw}}
// priceRaw is a six-decimal USDC-per-one-USDT0 price; qtyLots are 0.01-USDT0
// Core units. Core USDC weiDecimals=8 is caller-attested, not a known pool
// equivalence. Claims of transfers, inventory, costs and settlement are ignored;
// gross discrepancy can NEVER prove realizable net or produce dispatch authority.
const fs = require("node:fs");
const path = require("node:path");

const USDT = "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb";
const CORE_USDC = "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24";
const NATIVE_USDC = "0xb88339cb7199b77e23db6e890353e22632ba630f";
const USDT_ID = "0x25faedc3f054130dbb4e4203aca63567";
const CORE_USDC_ID = "0x6d1e7cde53ba9467b783cb7c530ce054";
const POOL = "0x613bc619741354a6171692b04228c9640373e54b";
const FACTORY = "0xf77bd082c627aa54591cf2f2eaa811fd1ab3b1f3";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TOKEN_ID = /^0x[0-9a-fA-F]{32}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const RAW = /^(?:0|[1-9][0-9]{0,35})$/;
const UNIT = 1000000n;
const RAW_PER_LOT = 10000n;
const MAX_AGE_MS = 30000;
const MAX_SKEW_MS = 15000;

const obj = x => x !== null && typeof x === "object" && !Array.isArray(x);
const integer = x => Number.isSafeInteger(x) && x >= 0;
const address = x => typeof x === "string" && ADDRESS.test(x);
const same = (a, b) => address(a) && a.toLowerCase() === b;
const raw = x => typeof x === "string" && RAW.test(x);
const amount = x => raw(x) ? BigInt(x) : null;
const checked = (x, n) => Array.isArray(x) && x.length > 0 && x.length <= n;
const pin = (x, evm) => obj(x) && x.block === evm.block && x.hash === evm.hash;
const output = (status, blockers, extra = {}) => ({ schema: "hypercore-nest-usdt0/classification-v1",
  status, blockers, routePositive: "unknown", executableNow: "unknown",
  dispatchAllowed: false, signedActionJustified: false, probabilityPercent: null,
  conservativeNetUsdcRaw: null, ...extra });

function bookFill(levels, inputRaw, buy) {
  let remaining = inputRaw, filled = 0n, spent = 0n, lotResidual = false;
  for (const level of levels) {
    const price = BigInt(level.priceRaw), qty = BigInt(level.qtyLots);
    if (remaining === 0n) continue;
    if (buy) {
      // Core cannot fill fractional 0.01-USDT0 lots. Charge each bought lot
      // UP to raw6 USDC; the actual spend, never the full budget, is compared.
      const perLot = (price + 99n) / 100n;
      const bought = qty < remaining / perLot ? qty : remaining / perLot;
      filled += bought;
      spent += bought * perLot;
      remaining -= bought * perLot;
      if (remaining < perLot) { lotResidual = true; break; } // later asks are no cheaper
    } else {
      const used = remaining < qty ? remaining : qty;
      filled += used * (price / 100n); // round Core USDC proceeds DOWN
      remaining -= used;
    }
  }
  if (buy) {
    return filled > 0n && (remaining === 0n || lotResidual) ?
      { receivedRaw: filled * RAW_PER_LOT, spentRaw: spent } : null;
  }
  return remaining === 0n && filled > 0n ? { receivedRaw: filled } : null;
}

function validLevels(levels, buy) {
  let previous = null;
  return checked(levels, 40) && levels.every(level => {
    if (!obj(level) || !raw(level.priceRaw) || !raw(level.qtyLots)) return false;
    const price = BigInt(level.priceRaw), qty = BigInt(level.qtyLots);
    if (!price || !qty || previous !== null && (buy ? price < previous : price > previous)) return false;
    previous = price;
    return true;
  });
}

function classify(snapshot, { nowMs } = {}) {
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(snapshot)); } catch (_) {
    return output("INCOMPLETE", ["INVALID_SNAPSHOT_SHAPE"]);
  }
  if (bytes > 256 * 1024) return output("INCOMPLETE", ["SNAPSHOT_TOO_LARGE"]);
  if (!obj(snapshot) || snapshot.schema !== "hypercore-nest-usdt0/snapshot-v1" ||
      !integer(nowMs) || !obj(snapshot.spotMeta) || !checked(snapshot.spotMeta.tokens, 8) ||
      !obj(snapshot.spotMeta.pair) || !obj(snapshot.book) || !obj(snapshot.evm) ||
      !obj(snapshot.pool) || !raw(snapshot.sizeUsdcRaw) ||
      !["CORE_BUY_NEST_SELL", "NEST_BUY_CORE_SELL"].includes(snapshot.direction)) {
    return output("INCOMPLETE", ["INVALID_SNAPSHOT_SHAPE"]);
  }
  const { spotMeta, book, evm, pool, quote, direction } = snapshot;
  const tokens = spotMeta.tokens;
  const usdt = tokens.find(t => obj(t) && t.index === 268);
  const usdc = tokens.find(t => obj(t) && t.index === 0);
  if (tokens.filter(t => obj(t) && [0, 268].includes(t.index)).length !== 2 ||
      !usdt || !usdc || !TOKEN_ID.test(usdt.tokenId) || !TOKEN_ID.test(usdc.tokenId) ||
      usdt.tokenId.toLowerCase() !== USDT_ID ||
      usdc.tokenId.toLowerCase() !== CORE_USDC_ID ||
      !same(usdt.evmAddress, USDT) || !same(usdc.evmAddress, CORE_USDC) ||
      usdt.szDecimals !== 2 || usdt.weiDecimals !== 8 || usdt.evmExtraWeiDecimals !== -2 ||
      usdc.weiDecimals !== 8 || usdt.verified !== true || usdc.verified !== true ||
      spotMeta.pair.index !== 166 || !Array.isArray(spotMeta.pair.tokens) ||
      spotMeta.pair.tokens.length !== 2 || spotMeta.pair.tokens[0] !== 268 ||
      spotMeta.pair.tokens[1] !== 0) {
    return output("INCOMPLETE", ["SPOT_IDENTITY_OR_DECIMALS_UNVERIFIED"]);
  }
  if (evm.chainId !== 999 || !integer(evm.block) || evm.block === 0 || !HASH.test(evm.hash) ||
      !integer(evm.timestampMs) || evm.finalized !== true ||
      !same(pool.address, POOL) || !same(pool.factory, FACTORY) ||
      !pool.codePresent || pool.verified !== true || !pin(pool, evm) ||
      !same(pool.token0, NATIVE_USDC) || !same(pool.token1, USDT) ||
      pool.token0Decimals !== 6 || pool.token1Decimals !== 6) {
    return output("INCOMPLETE", ["EVM_POOL_IDENTITY_CODE_OR_PIN_UNVERIFIED"]);
  }
  if (book.coin !== "@166" || !integer(book.observedAtMs) || !integer(book.receivedAtMs) ||
      !validLevels(book.bids, false) || !validLevels(book.asks, true) ||
      book.receivedAtMs < book.observedAtMs || book.receivedAtMs - book.observedAtMs > 5000 ||
      book.bids[0].priceRaw === "0" || book.asks[0].priceRaw === "0") {
    return output("INCOMPLETE", ["MALFORMED_OR_UNBOUND_CORE_BOOK"]);
  }
  if (book.observedAtMs > nowMs || book.receivedAtMs > nowMs || evm.timestampMs > nowMs ||
      nowMs - book.observedAtMs > MAX_AGE_MS || nowMs - evm.timestampMs > MAX_AGE_MS ||
      Math.abs(book.observedAtMs - evm.timestampMs) > MAX_SKEW_MS) {
    return output("NOT_READY", ["STALE_FUTURE_OR_CROSS_SURFACE_PIN"]);
  }
  if (quote == null) return output("NOT_READY", ["NO_CURRENT_EXACT_PUBLIC_NEST_QUOTE"]);
  if (!pin(quote, evm) || quote.exactInput !== true || quote.feeIncluded !== true ||
      quote.decimalsIn !== 6 || quote.decimalsOut !== 6 || !raw(quote.amountInRaw) ||
      !raw(quote.amountOutRaw) || !same(quote.tokenIn, direction === "CORE_BUY_NEST_SELL" ? USDT : NATIVE_USDC) ||
      !same(quote.tokenOut, direction === "CORE_BUY_NEST_SELL" ? NATIVE_USDC : USDT)) {
    return output("INCOMPLETE", ["EXACT_NEST_QUOTE_OR_PIN_MISSING"]);
  }
  const size = amount(snapshot.sizeUsdcRaw);
  if (size === 0n || size > 1000n * UNIT) return output("INCOMPLETE", ["SIZE_OUT_OF_BOUNDS"]);
  let fill, gross;
  if (direction === "CORE_BUY_NEST_SELL") {
    fill = bookFill(book.asks, size, true);
    if (fill === null) return output("NOT_READY", ["CORE_BOOK_CAPACITY_UNAVAILABLE"]);
    if (amount(quote.amountInRaw) !== fill.receivedRaw) {
      return output("INCOMPLETE", ["NEST_QUOTE_SIZE_NOT_CORE_LOT_DERIVED"]);
    }
    gross = amount(quote.amountOutRaw) - fill.spentRaw;
  } else {
    if (amount(quote.amountInRaw) !== size) return output("INCOMPLETE", ["NEST_QUOTE_SIZE_MISMATCH"]);
    // Unsellable EVM raw6 dust cannot contribute to Core proceeds.
    const sellableLots = amount(quote.amountOutRaw) / RAW_PER_LOT;
    if (sellableLots === 0n) return output("NOT_READY", ["NO_SELLABLE_CORE_LOTS"]);
    fill = bookFill(book.bids, sellableLots, false);
    if (fill === null) return output("NOT_READY", ["CORE_BOOK_CAPACITY_UNAVAILABLE"]);
    gross = fill.receivedRaw - size;
  }
  if (gross <= 0n) return output("NOT_READY", ["NONPOSITIVE_QUOTED_GROSS"],
    { quotedGrossUsdcRaw: gross.toString() });
  return output("QUOTED_DISCREPANCY_ONLY", ["CORE_USDC_AND_NEST_NATIVE_USDC_ARE_DISTINCT",
    "PUBLIC_DELIVERY_INVENTORY_SETTLEMENT_AND_ALL_COST_NET_UNPROVEN"],
  { quotedGrossUsdcRaw: gross.toString(),
    ...(direction === "CORE_BUY_NEST_SELL" ? { coreSpentUsdcRaw: fill.spentRaw.toString() } : {}) });
}

function checkFile(file, nowMs = Date.now()) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return output("INCOMPLETE", ["ABSOLUTE_FILE_REQUIRED"]);
  let fd;
  try {
    let current = path.parse(file).root;
    for (const part of path.resolve(file).slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) return output("INCOMPLETE", ["UNSAFE_FILE"]);
    }
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 256 * 1024) return output("INCOMPLETE", ["UNSAFE_FILE"]);
    const buffer = Buffer.alloc(stat.size + 1);
    let received = 0;
    while (received < buffer.length) {
      const n = fs.readSync(fd, buffer, received, buffer.length - received, null);
      if (n === 0) break;
      received += n;
    }
    const after = fs.fstatSync(fd);
    if (received !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      return output("INCOMPLETE", ["UNSAFE_FILE"]);
    }
    return classify(JSON.parse(buffer.subarray(0, received).toString("utf8")), { nowMs });
  } catch (_) { return output("INCOMPLETE", ["UNREADABLE_OR_MALFORMED_FILE"]); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const result = args.length === 2 && args[0] === "--check" ? checkFile(args[1]) :
    output("INCOMPLETE", ["ONLY_ABSOLUTE_CHECK_FILE_ALLOWED"]);
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.status === "INCOMPLETE") process.exitCode = 1;
}

module.exports = { classify, checkFile };
