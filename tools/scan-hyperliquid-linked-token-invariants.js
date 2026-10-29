#!/usr/bin/env node
// Read-only Hyperliquid linked spot-token invariant scanner.
// Uses public Hyperliquid API + public HyperEVM RPC only; no signed calls.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-linked-token-invariants.json");
const HYPERLIQUID_INFO_URL = ["https://", "api.", "hyperliquid.", "xyz/info"].join("");
const HYPEREVM_RPC_URL = ["https://", "rpc.", "hyperliquid.", "xyz/evm"].join("");
const CHAIN_ID = 999;
const TIMEOUT_MS = Number(process.env.HYPERLIQUID_SCAN_TIMEOUT_MS || "15000");
const CONCURRENCY = Number(process.env.HYPERLIQUID_SCAN_CONCURRENCY || "1");
const MAX_TOKENS = Number(process.env.HYPERLIQUID_LINKED_TOKEN_LIMIT || "250");
const RETRIES = Number(process.env.HYPERLIQUID_SCAN_RETRIES || "4");
const RETRY_DELAY_MS = Number(process.env.HYPERLIQUID_SCAN_RETRY_DELAY_MS || "750");
const PROBE_RECIPIENT = "0x000000000000000000000000000000000000dEaD";

const SELECTORS = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
  balanceOf: "0x70a08231",
  transfer: "0xa9059cbb",
};

const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function sanitizeError(error) {
  return String(error?.message || error || "call failed").replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 220);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error) {
  return /429|too many requests|rate limited|rate limit/i.test(String(error?.message || error || ""));
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function normalizeAddress(value) {
  const hex = strip0x(value).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) return null;
  return `0x${hex}`;
}

function isZeroAddress(value) {
  const address = normalizeAddress(value);
  return !address || /^0x0{40}$/.test(address);
}

function addressArg(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) throw new Error(`invalid address ${address}`);
  return strip0x(normalized).padStart(64, "0");
}

function uintArg(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function wordAt(raw, index) {
  const hex = strip0x(raw);
  const start = index * 64;
  if (hex.length < start + 64) return null;
  return `0x${hex.slice(start, start + 64)}`;
}

function addressFromWord(raw) {
  const hex = strip0x(raw).padStart(64, "0");
  if (!hex || /^0+$/.test(hex)) return null;
  return normalizeAddress(`0x${hex.slice(-40)}`);
}

function hexToBigInt(raw) {
  const hex = strip0x(raw);
  if (!hex) return null;
  try { return BigInt(`0x${hex}`); } catch (_) { return null; }
}

function sha256Hex(hex) {
  const clean = strip0x(hex);
  return crypto.createHash("sha256").update(Buffer.from(clean, "hex")).digest("hex");
}

function systemAddress(tokenIndex) {
  const indexHex = BigInt(tokenIndex).toString(16).padStart(38, "0");
  return normalizeAddress(`0x20${indexHex}`);
}

function expectedEvmDecimals(token, evmExtraWeiDecimals) {
  if (!Number.isFinite(Number(token?.weiDecimals)) || !Number.isFinite(Number(evmExtraWeiDecimals))) return null;
  return Number(token.weiDecimals) + Number(evmExtraWeiDecimals);
}

function toDecimalString(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;
  if (decimals === 0) return whole.toString();
  const fracText = fraction.toString().padStart(Number(decimals), "0").replace(/0+$/, "");
  return fracText ? `${whole}.${fracText}` : whole.toString();
}

function numberFromRaw(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  const text = toDecimalString(raw, decimals);
  if (text === null) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function parseDecimalToRaw(value, decimals) {
  if (value === null || value === undefined || decimals === null || decimals === undefined) return null;
  const text = String(value).replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  const padded = frac.padEnd(Number(decimals), "0").slice(0, Number(decimals));
  try { return BigInt(whole || "0") * (10n ** BigInt(decimals)) + BigInt(padded || "0"); } catch (_) { return null; }
}

function bpsFromRaw(aRaw, bRaw) {
  if (aRaw === null || aRaw === undefined || bRaw === null || bRaw === undefined) return null;
  const a = BigInt(aRaw);
  const b = BigInt(bRaw);
  if (b === 0n) return null;
  const scaled = ((a - b) * 1_000_000n) / b;
  return Number(scaled) / 100;
}

function round(value, decimals = 2) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

async function fetchJson(url, options = {}, timeoutMs = TIMEOUT_MS) {
  let lastError = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempt >= RETRIES) throw error;
      await sleep(RETRY_DELAY_MS * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error("fetch failed");
}

async function infoPost(body) {
  return fetchJson(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function rpc(method, params) {
  const data = await fetchJson(HYPEREVM_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (data?.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data?.result ?? null;
}

async function safeRpc(method, params) {
  try { return { ok: true, value: await rpc(method, params) }; } catch (error) { return { ok: false, error: sanitizeError(error) }; }
}

async function ethCall(to, data, from = null) {
  const tx = { to, data };
  if (from) tx.from = from;
  return rpc("eth_call", [tx, "latest"]);
}

async function safeCall(to, data, from = null) {
  try { return { ok: true, raw: await ethCall(to, data, from) }; } catch (error) { return { ok: false, error: sanitizeError(error) }; }
}

function decodeUint(raw) {
  return hexToBigInt(wordAt(raw, 0));
}

function decodeBoolOrNoReturn(raw) {
  const clean = strip0x(raw);
  if (!clean) return true;
  const value = decodeUint(raw);
  return value !== null ? value !== 0n : null;
}

function decodeString(raw) {
  const hex = strip0x(raw);
  if (!hex) return null;
  try {
    if (hex.length === 64) {
      const bytes = Buffer.from(hex, "hex").filter((b) => b !== 0);
      const text = bytes.toString("utf8").trim();
      return text || null;
    }
    const offset = Number(hexToBigInt(wordAt(raw, 0)) || 0n);
    const len = Number(hexToBigInt(wordAt(raw, offset / 32)) || 0n);
    const start = (offset + 32) * 2;
    const bytes = Buffer.from(hex.slice(start, start + len * 2), "hex");
    const text = bytes.toString("utf8").trim();
    return text || null;
  } catch (_) {
    return null;
  }
}

function balanceOfData(address) {
  return `${SELECTORS.balanceOf}${addressArg(address)}`;
}

function transferData(to, amount) {
  return `${SELECTORS.transfer}${addressArg(to)}${uintArg(amount)}`;
}

function minTransferProbeAmount(evmExtraWeiDecimals) {
  const extra = Number(evmExtraWeiDecimals || 0);
  let amount = 1n;
  if (extra > 0 && extra <= 18) amount = 10n ** BigInt(extra);
  return amount;
}

async function tokenDetails(tokenId) {
  if (!tokenId) return null;
  try { return await infoPost({ type: "tokenDetails", tokenId }); } catch (_) { return null; }
}

async function scanToken(token) {
  const evmContract = typeof token.evmContract === "string" ? { address: token.evmContract, evm_extra_wei_decimals: null } : token.evmContract;
  const address = normalizeAddress(evmContract?.address);
  const evmExtraWeiDecimals = Number(evmContract?.evm_extra_wei_decimals ?? evmContract?.evmExtraWeiDecimals ?? 0);
  const expectedDecimals = expectedEvmDecimals(token, evmExtraWeiDecimals);
  const sys = token.name === "HYPE" ? "0x2222222222222222222222222222222222222222" : systemAddress(token.index);
  const codeRaw = await safeRpc("eth_getCode", [address, "latest"]);
  const nameRaw = await safeCall(address, SELECTORS.name);
  const symbolRaw = await safeCall(address, SELECTORS.symbol);
  const decimalsRaw = await safeCall(address, SELECTORS.decimals);
  const totalSupplyRaw = await safeCall(address, SELECTORS.totalSupply);
  const systemBalanceRaw = await safeCall(address, balanceOfData(sys));
  const probeBalanceRaw = await safeCall(address, balanceOfData(PROBE_RECIPIENT));
  const implSlotRaw = await safeRpc("eth_getStorageAt", [address, EIP1967_IMPL_SLOT, "latest"]);
  const adminSlotRaw = await safeRpc("eth_getStorageAt", [address, EIP1967_ADMIN_SLOT, "latest"]);
  const beaconSlotRaw = await safeRpc("eth_getStorageAt", [address, EIP1967_BEACON_SLOT, "latest"]);

  const code = codeRaw.ok ? codeRaw.value : null;
  const codeBytes = codeRaw.ok ? Math.max(0, (strip0x(code).length / 2) | 0) : null;
  const codeHashSha256 = codeBytes > 0 ? sha256Hex(code) : null;
  const decimals = decimalsRaw.ok ? Number(decodeUint(decimalsRaw.raw)) : null;
  const totalSupplyRawValue = totalSupplyRaw.ok ? decodeUint(totalSupplyRaw.raw) : null;
  const systemBalanceRawValue = systemBalanceRaw.ok ? decodeUint(systemBalanceRaw.raw) : null;
  const probeBalanceRawValue = probeBalanceRaw.ok ? decodeUint(probeBalanceRaw.raw) : null;
  const details = await tokenDetails(token.tokenId);
  const maxSupplyRaw = details?.maxSupply && decimals !== null ? parseDecimalToRaw(details.maxSupply, decimals) : null;
  const totalSupplyDetailsRaw = details?.totalSupply && decimals !== null ? parseDecimalToRaw(details.totalSupply, decimals) : null;
  const transferProbeAmount = minTransferProbeAmount(evmExtraWeiDecimals);
  const systemTransferProbeRaw = codeBytes > 0 ? await safeCall(address, transferData(PROBE_RECIPIENT, transferProbeAmount), sys) : { ok: false, error: codeRaw.ok ? "no code at linked EVM contract" : "code read failed" };
  const probeTransferProbeRaw = probeBalanceRawValue && probeBalanceRawValue > 0n ? await safeCall(address, transferData(sys, 1n), PROBE_RECIPIENT) : { ok: false, error: "probe balance is zero" };

  const impl = implSlotRaw.ok ? addressFromWord(implSlotRaw.value) : null;
  const admin = adminSlotRaw.ok ? addressFromWord(adminSlotRaw.value) : null;
  const beacon = beaconSlotRaw.ok ? addressFromWord(beaconSlotRaw.value) : null;
  const flags = [];
  const criticalFlags = [];
  if (!address) flags.push("missing linked EVM contract address");
  if (!codeRaw.ok) flags.push("code read failed");
  if (codeRaw.ok && !codeBytes) flags.push("no code at linked EVM contract");
  if (!decimalsRaw.ok || decimals === null) flags.push("decimals() read failed or unsupported");
  if (!totalSupplyRaw.ok || totalSupplyRawValue === null) flags.push("totalSupply() read failed or unsupported");
  if (!systemBalanceRaw.ok || systemBalanceRawValue === null) flags.push("system balanceOf() read failed or unsupported");
  if (decimals !== null && expectedDecimals !== null && decimals !== expectedDecimals) criticalFlags.push("EVM decimals mismatch HyperCore weiDecimals + evmExtraWeiDecimals");
  if (Number.isFinite(evmExtraWeiDecimals) && (evmExtraWeiDecimals < -2 || evmExtraWeiDecimals > 18)) criticalFlags.push("evmExtraWeiDecimals outside documented range");
  if (totalSupplyRawValue !== null && systemBalanceRawValue !== null && systemBalanceRawValue > totalSupplyRawValue) criticalFlags.push("system address balance exceeds totalSupply");
  if (systemTransferProbeRaw.ok && decodeBoolOrNoReturn(systemTransferProbeRaw.raw) === false) criticalFlags.push("system-address transfer probe returned false");
  if (!systemTransferProbeRaw.ok && isRateLimitError(systemTransferProbeRaw.error)) flags.push("system-address transfer probe rate-limited");
  if (!systemTransferProbeRaw.ok && !isRateLimitError(systemTransferProbeRaw.error) && codeBytes > 0 && systemBalanceRawValue !== null && systemBalanceRawValue >= transferProbeAmount) criticalFlags.push("system-address transfer probe reverted despite sufficient system balance");
  if (!systemTransferProbeRaw.ok && !isRateLimitError(systemTransferProbeRaw.error) && codeBytes > 0 && (systemBalanceRawValue === null || systemBalanceRawValue < transferProbeAmount)) flags.push("system-address transfer probe reverted or unsupported");
  if (impl || admin || beacon) flags.push("EIP-1967 proxy-like storage present");
  if (details?.maxSupply && maxSupplyRaw !== null && totalSupplyRawValue !== null) {
    const diffBps = bpsFromRaw(totalSupplyRawValue, maxSupplyRaw);
    if (diffBps !== null && Math.abs(diffBps) > 1) flags.push("EVM totalSupply differs from tokenDetails maxSupply by >1bps");
  }
  if (details?.totalSupply && totalSupplyDetailsRaw !== null && totalSupplyRawValue !== null) {
    const diffBps = bpsFromRaw(totalSupplyRawValue, totalSupplyDetailsRaw);
    if (diffBps !== null && Math.abs(diffBps) > 100) flags.push("EVM totalSupply differs from tokenDetails totalSupply by >100bps");
  }

  const reviewCandidate = criticalFlags.length > 0 || flags.some((flag) => !flag.includes("read failed or unsupported"));
  const watchCandidate = criticalFlags.length > 0;
  return {
    token: {
      index: token.index,
      name: token.name,
      fullName: token.fullName || null,
      tokenId: token.tokenId || null,
      isCanonical: token.isCanonical ?? null,
      szDecimals: token.szDecimals,
      weiDecimals: token.weiDecimals,
      evmContract: address,
      evmExtraWeiDecimals,
      expectedEvmDecimals: expectedDecimals,
      systemAddress: sys,
    },
    evm: {
      codePresent: codeBytes > 0,
      codeBytes,
      codeHashSha256,
      name: nameRaw.ok ? decodeString(nameRaw.raw) : null,
      symbol: symbolRaw.ok ? decodeString(symbolRaw.raw) : null,
      decimals,
      totalSupplyRaw: totalSupplyRawValue,
      totalSupply: decimals !== null && totalSupplyRawValue !== null ? toDecimalString(totalSupplyRawValue, decimals) : null,
      systemBalanceRaw: systemBalanceRawValue,
      systemBalance: decimals !== null && systemBalanceRawValue !== null ? toDecimalString(systemBalanceRawValue, decimals) : null,
      nonSystemSupplyRaw: totalSupplyRawValue !== null && systemBalanceRawValue !== null && totalSupplyRawValue >= systemBalanceRawValue ? totalSupplyRawValue - systemBalanceRawValue : null,
      nonSystemSupply: decimals !== null && totalSupplyRawValue !== null && systemBalanceRawValue !== null && totalSupplyRawValue >= systemBalanceRawValue ? toDecimalString(totalSupplyRawValue - systemBalanceRawValue, decimals) : null,
      systemSharePct: totalSupplyRawValue && totalSupplyRawValue > 0n && systemBalanceRawValue !== null ? round(Number(systemBalanceRawValue * 10_000n / totalSupplyRawValue) / 100, 4) : null,
      eip1967: { implementation: isZeroAddress(impl) ? null : impl, admin: isZeroAddress(admin) ? null : admin, beacon: isZeroAddress(beacon) ? null : beacon },
    },
    hyperCoreDetails: details ? {
      deployer: details.deployer || null,
      deployTime: details.deployTime || null,
      maxSupply: details.maxSupply || null,
      totalSupply: details.totalSupply || null,
      circulatingSupply: details.circulatingSupply || null,
      midPx: details.midPx || null,
      markPx: details.markPx || null,
      seededUsdc: details.seededUsdc || null,
      futureEmissions: details.futureEmissions || null,
    } : null,
    probes: {
      systemTransferToProbe: {
        amountRaw: transferProbeAmount,
        ok: systemTransferProbeRaw.ok && decodeBoolOrNoReturn(systemTransferProbeRaw.raw) !== false,
        returnedFalse: systemTransferProbeRaw.ok ? decodeBoolOrNoReturn(systemTransferProbeRaw.raw) === false : false,
        error: systemTransferProbeRaw.ok ? null : systemTransferProbeRaw.error,
      },
      probeTransferToSystem: {
        ok: probeTransferProbeRaw.ok && decodeBoolOrNoReturn(probeTransferProbeRaw.raw) !== false,
        skippedReason: probeBalanceRawValue && probeBalanceRawValue > 0n ? null : "probe balance is zero",
        error: probeTransferProbeRaw.ok ? null : probeTransferProbeRaw.error,
      },
    },
    diffs: {
      evmTotalSupplyVsMaxSupplyBps: maxSupplyRaw !== null && totalSupplyRawValue !== null ? round(bpsFromRaw(totalSupplyRawValue, maxSupplyRaw), 4) : null,
      evmTotalSupplyVsCoreTotalSupplyBps: totalSupplyDetailsRaw !== null && totalSupplyRawValue !== null ? round(bpsFromRaw(totalSupplyRawValue, totalSupplyDetailsRaw), 4) : null,
      evmTotalSupplyNumber: decimals !== null && totalSupplyRawValue !== null ? numberFromRaw(totalSupplyRawValue, decimals) : null,
      systemBalanceNumber: decimals !== null && systemBalanceRawValue !== null ? numberFromRaw(systemBalanceRawValue, decimals) : null,
    },
    flags,
    criticalFlags,
    reviewCandidate,
    watchCandidate,
    routePositive: false,
    errors: {
      name: nameRaw.ok ? null : nameRaw.error,
      symbol: symbolRaw.ok ? null : symbolRaw.error,
      decimals: decimalsRaw.ok ? null : decimalsRaw.error,
      totalSupply: totalSupplyRaw.ok ? null : totalSupplyRaw.error,
      systemBalance: systemBalanceRaw.ok ? null : systemBalanceRaw.error,
      probeBalance: probeBalanceRaw.ok ? null : probeBalanceRaw.error,
      code: codeRaw.ok ? null : codeRaw.error,
    },
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const chainIdRaw = await rpc("eth_chainId", []);
  const chainId = Number(BigInt(chainIdRaw));
  if (chainId !== CHAIN_ID) throw new Error(`Unexpected HyperEVM chain id ${chainId}`);
  const blockRaw = await rpc("eth_blockNumber", []);
  const blockNumber = Number(BigInt(blockRaw));
  const metaAndCtx = await infoPost({ type: "spotMetaAndAssetCtxs" });
  const meta = Array.isArray(metaAndCtx) ? metaAndCtx[0] : metaAndCtx;
  const assetCtxs = Array.isArray(metaAndCtx) ? metaAndCtx[1] : [];
  const tokens = Array.isArray(meta?.tokens) ? meta.tokens : [];
  const linked = tokens
    .filter((token) => token?.evmContract && normalizeAddress(typeof token.evmContract === "string" ? token.evmContract : token.evmContract.address))
    .slice(0, MAX_TOKENS);
  const ctxBySpotIndex = new Map((meta?.universe || []).map((spot, i) => [spot.index ?? i, assetCtxs?.[i] || null]));
  const rows = await mapLimit(linked, CONCURRENCY, async (token) => {
    const row = await scanToken(token);
    const spotIndexes = (meta?.universe || []).filter((spot) => Array.isArray(spot.tokens) && spot.tokens.includes(token.index)).map((spot) => spot.index);
    row.spotMarkets = spotIndexes.slice(0, 10).map((spotIndex) => ({ index: spotIndex, ctx: ctxBySpotIndex.get(spotIndex) || null }));
    return row;
  });
  const codeHashCounts = new Map();
  for (const row of rows) {
    const hash = row.evm.codeHashSha256;
    if (!hash) continue;
    codeHashCounts.set(hash, (codeHashCounts.get(hash) || 0) + 1);
  }
  for (const row of rows) {
    row.evm.codeHashPeerCount = row.evm.codeHashSha256 ? codeHashCounts.get(row.evm.codeHashSha256) || 1 : 0;
    row.reviewCandidate = row.reviewCandidate || row.criticalFlags.length > 0 || row.flags.some((flag) => !flag.includes("read failed or unsupported"));
  }

  const watchRows = rows.filter((row) => row.watchCandidate);
  const reviewRows = rows.filter((row) => row.reviewCandidate);
  const out = {
    generatedAt: new Date().toISOString(),
    scope: "Hyperliquid HyperCore spot token <> HyperEVM ERC20 link invariant scan",
    safety: {
      publicApiOnly: true,
      publicRpcOnly: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    chain: {
      name: "HyperEVM",
      chainId,
      blockNumber,
    },
    thresholds: {
      maxTokens: MAX_TOKENS,
      concurrency: CONCURRENCY,
      routePositiveRequiresConsumerJoin: true,
    },
    summary: {
      hyperCoreTokens: tokens.length,
      linkedTokensScanned: rows.length,
      canonicalLinkedTokens: rows.filter((row) => row.token.isCanonical).length,
      codeMissing: rows.filter((row) => !row.evm.codePresent).length,
      decimalsMismatch: rows.filter((row) => row.criticalFlags.includes("EVM decimals mismatch HyperCore weiDecimals + evmExtraWeiDecimals")).length,
      systemBalanceReadFailures: rows.filter((row) => row.flags.includes("system balanceOf() read failed or unsupported")).length,
      systemBalanceExceedsSupply: rows.filter((row) => row.criticalFlags.includes("system address balance exceeds totalSupply")).length,
      systemTransferProbeFailures: rows.filter((row) => row.criticalFlags.includes("system-address transfer probe reverted despite sufficient system balance") || row.criticalFlags.includes("system-address transfer probe returned false")).length,
      proxyLikeRows: rows.filter((row) => row.evm.eip1967.implementation || row.evm.eip1967.admin || row.evm.eip1967.beacon).length,
      uniqueCodeHashes: [...codeHashCounts.values()].filter((count) => count === 1).length,
      reviewCandidates: reviewRows.length,
      watchCandidates: watchRows.length,
      routePositive: 0,
      signedActionJustified: false,
    },
    topWatchRows: watchRows.slice(0, 30).map((row) => ({
      name: row.token.name,
      index: row.token.index,
      evmContract: row.token.evmContract,
      systemAddress: row.token.systemAddress,
      criticalFlags: row.criticalFlags,
      flags: row.flags,
    })),
    rows,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
  console.log(`Wrote ${path.relative(WORKSPACE, OUT_FILE)}`);
  console.log(`Hyperliquid linked tokens: scanned=${out.summary.linkedTokensScanned}; watchCandidates=${out.summary.watchCandidates}; reviewCandidates=${out.summary.reviewCandidates}; routePositive=0`);
  for (const row of watchRows.slice(0, 10)) {
    console.log(`watch ${row.token.name}#${row.token.index}: ${row.criticalFlags.join("; ")}`);
  }
}

main().catch((error) => {
  console.error(sanitizeError(error));
  process.exit(1);
});
