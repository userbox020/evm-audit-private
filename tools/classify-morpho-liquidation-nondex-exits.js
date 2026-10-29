#!/usr/bin/env node
// Read-only classifier for non-DEX exits on Morpho liquidation collateral rows.
// Uses bytecode selector checks and eth_call probes only. No signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const INPUT = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-high-apy-liquidation-routes.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-high-apy-nondex-exit-classification.json");
const QUIET = process.argv.includes("--quiet");
const FALLBACK_ETHEREUM_RPCS = [
  ["https://", "ethereum-rpc.publicnode.com"].join(""),
  ["https://", "rpc.flashbots.net"].join(""),
];
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const ABI = ethers.AbiCoder.defaultAbiCoder();

const VIEW_PROBES = [
  { group: "erc4626", name: "asset()", signature: "asset() view returns (address)", args: () => [] },
  { group: "erc4626", name: "totalAssets()", signature: "totalAssets() view returns (uint256)", args: () => [] },
  { group: "erc4626", name: "convertToAssets(uint256)", signature: "convertToAssets(uint256) view returns (uint256)", args: (ctx) => [ctx.seizedRaw || 1n] },
  { group: "erc4626", name: "previewRedeem(uint256)", signature: "previewRedeem(uint256) view returns (uint256)", args: (ctx) => [ctx.seizedRaw || 1n] },
  { group: "erc4626", name: "maxRedeem(address)", signature: "maxRedeem(address) view returns (uint256)", args: () => [PROBE_FROM] },
  { group: "pt", name: "expiry()", signature: "expiry() view returns (uint256)", args: () => [] },
  { group: "pt", name: "maturity()", signature: "maturity() view returns (uint256)", args: () => [] },
  { group: "pt", name: "isExpired()", signature: "isExpired() view returns (bool)", args: () => [] },
  { group: "pt", name: "SY()", signature: "SY() view returns (address)", args: () => [] },
  { group: "pt", name: "YT()", signature: "YT() view returns (address)", args: () => [] },
  { group: "receipt", name: "underlying()", signature: "underlying() view returns (address)", args: () => [] },
  { group: "receipt", name: "asset()", signature: "asset() view returns (address)", args: () => [] },
];

const EXIT_PROBES = [
  { group: "erc4626", name: "redeem(uint256,address,address)", signature: "redeem(uint256,address,address) returns (uint256)", args: (ctx) => [ctx.seizedRaw || 1n, PROBE_FROM, PROBE_FROM], sameBlockCandidate: true },
  { group: "erc4626", name: "withdraw(uint256,address,address)", signature: "withdraw(uint256,address,address) returns (uint256)", args: () => [1n, PROBE_FROM, PROBE_FROM], sameBlockCandidate: true },
  { group: "issuer", name: "redeem(uint256)", signature: "redeem(uint256) returns (uint256)", args: (ctx) => [ctx.seizedRaw || 1n], sameBlockCandidate: true },
  { group: "issuer", name: "redeem(uint256,address)", signature: "redeem(uint256,address) returns (uint256)", args: (ctx) => [ctx.seizedRaw || 1n, PROBE_FROM], sameBlockCandidate: true },
  { group: "issuer", name: "withdraw(uint256)", signature: "withdraw(uint256) returns (uint256)", args: () => [1n], sameBlockCandidate: true },
  { group: "queue", name: "requestRedeem(uint256)", signature: "requestRedeem(uint256) returns (uint256)", args: (ctx) => [ctx.seizedRaw || 1n], sameBlockCandidate: false },
  { group: "queue", name: "requestWithdraw(uint256)", signature: "requestWithdraw(uint256) returns (uint256)", args: () => [1n], sameBlockCandidate: false },
  { group: "cooldown", name: "cooldownAssets(uint256)", signature: "cooldownAssets(uint256) returns (uint256)", args: () => [1n], sameBlockCandidate: false },
  { group: "cooldown", name: "cooldownShares(uint256)", signature: "cooldownShares(uint256) returns (uint256)", args: (ctx) => [ctx.seizedRaw || 1n], sameBlockCandidate: false },
  { group: "claim", name: "claim(address)", signature: "claim(address) returns (uint256)", args: () => [PROBE_FROM], sameBlockCandidate: false },
  { group: "claim", name: "claim(uint256,address)", signature: "claim(uint256,address) returns (uint256)", args: () => [0n, PROBE_FROM], sameBlockCandidate: false },
  { group: "unwrap", name: "unwrap(uint256)", signature: "unwrap(uint256) returns (uint256)", args: (ctx) => [ctx.seizedRaw || 1n], sameBlockCandidate: true },
  { group: "unwrap", name: "unstake(address)", signature: "unstake(address) returns (uint256)", args: () => [PROBE_FROM], sameBlockCandidate: false },
];

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function loadRpcUrls() {
  if (process.env.MORPHO_SKIP_RPC_INVENTORY === "1") return [];
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveEthereumRpc() {
  for (const url of [...loadRpcUrls(), ...FALLBACK_ETHEREUM_RPCS]) {
    try {
      if (Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000))) === 1) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function selector(signature) {
  return ethers.id(signature.replace(/\s*(view|pure|returns\s*\(.+\))\s*/g, "").trim()).slice(0, 10).toLowerCase();
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function addressFromWord(word) {
  if (!word || word === "0x") return null;
  try {
    if (BigInt(word) === 0n) return null;
    return ethers.getAddress("0x" + strip0x(word).slice(-40));
  } catch (_) {
    return null;
  }
}

function extractPush4Selectors(bytecode) {
  const hex = strip0x(bytecode);
  const selectors = new Set();
  for (let i = 0; i + 10 <= hex.length; i += 2) {
    if (hex.slice(i, i + 2).toLowerCase() === "63") selectors.add("0x" + hex.slice(i + 2, i + 10).toLowerCase());
  }
  return selectors;
}

function serialize(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === "object" && typeof value.length === "number") return Array.from(value).map(serialize);
  return value;
}

function decodeErrorData(data) {
  if (!data || typeof data !== "string" || !data.startsWith("0x") || data === "0x") return { revertSelector: null, decodedError: null };
  const revertSelector = data.slice(0, 10);
  try {
    if (revertSelector === "0x08c379a0") {
      const [reason] = ABI.decode(["string"], "0x" + strip0x(data).slice(8));
      return { revertSelector, decodedError: `Error(${JSON.stringify(reason)})` };
    }
    if (revertSelector === "0x4e487b71") {
      const [code] = ABI.decode(["uint256"], "0x" + strip0x(data).slice(8));
      return { revertSelector, decodedError: `Panic(${code.toString()})` };
    }
  } catch (_) {}
  return { revertSelector, decodedError: null };
}

function extractErrorData(err) {
  const direct = err?.data || err?.error?.data || err?.info?.error?.data;
  if (typeof direct === "string" && direct !== "0x") return direct;
  if (direct && typeof direct.data === "string" && direct.data !== "0x") return direct.data;
  return null;
}

async function callProbe(provider, to, spec, args, from = PROBE_FROM) {
  const iface = new ethers.Interface([`function ${spec.signature}`]);
  const fragment = iface.fragments[0];
  const data = iface.encodeFunctionData(fragment, args);
  try {
    const raw = await provider.call({ to, from, data });
    return {
      ok: true,
      decodedOutput: serialize(iface.decodeFunctionResult(fragment, raw)),
      dataBytes: strip0x(raw).length / 2,
      error: null,
      revertSelector: null,
      decodedError: null,
    };
  } catch (err) {
    const data = extractErrorData(err);
    const decoded = decodeErrorData(data);
    return {
      ok: false,
      decodedOutput: null,
      dataBytes: 0,
      error: err?.reason || err?.shortMessage || err?.message || "execution reverted",
      revertSelector: decoded.revertSelector,
      decodedError: decoded.decodedError,
    };
  }
}

async function contractMeta(provider, address) {
  const [code, implSlot, adminSlot] = await Promise.all([
    provider.getCode(address).catch(() => "0x"),
    provider.getStorage(address, IMPL_SLOT).catch(() => null),
    provider.getStorage(address, ADMIN_SLOT).catch(() => null),
  ]);
  const implementation = addressFromWord(implSlot);
  let implCode = "0x";
  if (implementation) implCode = await provider.getCode(implementation).catch(() => "0x");
  const selectors = new Set([...extractPush4Selectors(code), ...extractPush4Selectors(implCode)]);
  return {
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    eip1967Implementation: implementation,
    eip1967Admin: addressFromWord(adminSlot),
    implementationCodeBytes: implCode && implCode !== "0x" ? strip0x(implCode).length / 2 : 0,
    selectors: [...selectors].sort(),
  };
}

function bestSize(row) {
  return (row.sizeResults || []).find((s) => !s.seizedExceedsCollateral && BigInt(s.seizedCollateralRaw || 0) > 0n)
    || row.best
    || (row.sizeResults || [])[0]
    || null;
}

function symbolTags(symbol) {
  const s = String(symbol || "");
  const tags = [];
  if (/^PT-/i.test(s)) tags.push("principal-token");
  if (/RLP|LP$/i.test(s)) tags.push("lp-or-protocol-receipt");
  if (/deUSD|USR|lvlUSD|USD/i.test(s)) tags.push("stable-or-rwa-receipt");
  if (/^s[A-Z]|wst|staked|vault/i.test(s)) tags.push("staking-or-vault-receipt");
  return tags.length ? tags : ["unknown-receipt-token"];
}

function hasBalanceLikeError(call) {
  const text = `${call?.decodedError || ""} ${call?.error || ""}`.toLowerCase();
  return /balance|allowance|shares|insufficient|exceeds|not enough/.test(text);
}

async function classifyRow(provider, row) {
  const collateral = row.collateral || {};
  const token = normalizeAddress(collateral.address);
  const size = bestSize(row);
  const seizedRaw = BigInt(size?.seizedCollateralRaw || 0);
  const ctx = { seizedRaw };
  const meta = token ? await contractMeta(provider, token) : { selectors: [] };
  const selectorSet = new Set(meta.selectors || []);
  const allProbes = [...VIEW_PROBES, ...EXIT_PROBES];
  const selectorHits = allProbes
    .map((p) => ({ name: p.name, group: p.group, selector: selector(p.name) }))
    .filter((p) => selectorSet.has(p.selector));

  const viewProbes = [];
  for (const spec of VIEW_PROBES) {
    viewProbes.push({ name: spec.name, group: spec.group, selector: selector(spec.name), call: token ? await callProbe(provider, token, spec, spec.args(ctx)) : null });
  }
  const exitProbes = [];
  for (const spec of EXIT_PROBES) {
    exitProbes.push({ name: spec.name, group: spec.group, selector: selector(spec.name), sameBlockCandidate: spec.sameBlockCandidate, call: token ? await callProbe(provider, token, spec, spec.args(ctx)) : null });
  }

  const erc4626ViewOk = viewProbes.some((p) => p.group === "erc4626" && p.call?.ok);
  const pendleViewOk = viewProbes.some((p) => p.group === "pt" && p.call?.ok);
  const queueOrCooldownObserved = exitProbes.some((p) => ["queue", "cooldown", "claim"].includes(p.group) && (p.call?.ok || hasBalanceLikeError(p.call) || selectorSet.has(p.selector)));
  const sameBlockExitObserved = exitProbes.some((p) => p.sameBlockCandidate && (p.call?.ok || hasBalanceLikeError(p.call) || selectorSet.has(p.selector)));
  const exactSameBlockExitProven = exitProbes.some((p) => p.sameBlockCandidate && p.call?.ok);
  const previewRedeem = viewProbes.find((p) => p.name === "previewRedeem(uint256)" && p.call?.ok)?.call?.decodedOutput?.[0] || null;
  const convertToAssets = viewProbes.find((p) => p.name === "convertToAssets(uint256)" && p.call?.ok)?.call?.decodedOutput?.[0] || null;
  const maturity = viewProbes.find((p) => ["maturity()", "expiry()"].includes(p.name) && p.call?.ok)?.call?.decodedOutput?.[0] || null;
  const now = Math.floor(Date.now() / 1000);
  const maturityStatus = maturity ? (Number(maturity) <= now ? "past-or-at-maturity" : "pre-maturity") : null;

  const tags = [...new Set([
    ...symbolTags(collateral.symbol),
    erc4626ViewOk ? "erc4626-like" : null,
    pendleViewOk || /^PT-/i.test(String(collateral.symbol || "")) ? "pendle-pt-like" : null,
    queueOrCooldownObserved ? "queue-cooldown-or-claim-surface" : null,
    sameBlockExitObserved ? "same-block-exit-selector-observed" : null,
  ].filter(Boolean))];

  const blockers = [
    row.diagnostics?.overSeizeOnly ? "Top scored size is over-seize-only" : null,
    row.loanAsset?.pricingTrusted === false ? "Loan-token price is not trusted for route-positive gating" : null,
    exactSameBlockExitProven ? null : "No exact same-block non-DEX collateral exit is proven by eth_call",
    previewRedeem || convertToAssets ? null : "No ERC4626 redeem/asset conversion output for seized collateral",
    row.best?.best?.netProfitUsd !== undefined && Number(row.best.best.netProfitUsd) < 0 ? "Best exact DEX exit is negative" : null,
    "No fork extraction proof",
  ].filter(Boolean);

  return {
    borrower: row.borrower,
    marketId: row.marketId,
    pair: row.pair,
    healthFactor: row.healthFactor,
    currentLiquidatable: Boolean(row.currentLiquidatable),
    loanAsset: row.loanAsset,
    collateral,
    sizeContext: size ? {
      fraction: size.fraction,
      repayUsd: size.repayUsd,
      seizedCollateralRaw: size.seizedCollateralRaw,
      seizedCollateral: size.seizedCollateral,
      seizedExceedsCollateral: Boolean(size.seizedExceedsCollateral),
      bestDexNetProfitUsd: size.best?.netProfitUsd ?? null,
    } : null,
    classification: {
      tags,
      erc4626ViewOk,
      pendleViewOk,
      maturity,
      maturityStatus,
      queueOrCooldownObserved,
      sameBlockExitObserved,
      exactSameBlockExitProven,
      nonDexRoutePositive: false,
      routePositive: false,
      signedActionJustified: false,
    },
    conversions: { previewRedeem, convertToAssets },
    selectorHits,
    contract: meta,
    viewProbes,
    exitProbes,
    blockers,
  };
}

async function main() {
  const input = readJson(INPUT, null);
  if (!input) throw new Error(`missing input artifact ${path.relative(WORKSPACE, INPUT)}`);
  const rpc = await resolveEthereumRpc();
  if (!rpc) throw new Error("missing ethereum rpc");
  const provider = new ethers.JsonRpcProvider(rpc, 1, { staticNetwork: true });
  const rows = (input.results || []).filter((r) => r.currentLiquidatable);
  const classified = [];
  for (const row of rows) classified.push(await classifyRow(provider, row));

  const summary = {
    inputGeneratedAt: input.generatedAt || null,
    rowsClassified: classified.length,
    uniqueCollaterals: new Set(classified.map((r) => String(r.collateral?.address || "").toLowerCase()).filter(Boolean)).size,
    erc4626LikeRows: classified.filter((r) => r.classification.erc4626ViewOk).length,
    pendleLikeRows: classified.filter((r) => r.classification.tags.includes("pendle-pt-like")).length,
    queueCooldownOrClaimRows: classified.filter((r) => r.classification.queueOrCooldownObserved).length,
    sameBlockExitSelectorRows: classified.filter((r) => r.classification.sameBlockExitObserved).length,
    exactSameBlockExitProvenRows: classified.filter((r) => r.classification.exactSameBlockExitProven).length,
    nonDexRoutePositive: 0,
    routePositive: 0,
    signedActionJustified: false,
    blocker: "No non-DEX collateral exit produced exact same-block loan-asset output; fork proof absent",
  };

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/classify-morpho-liquidation-nondex-exits.js",
    scope: "Read-only non-DEX exit classification for Morpho high-APY liquidation collateral rows",
    safety: {
      rpcInventoryRead: process.env.MORPHO_SKIP_RPC_INVENTORY !== "1" && fs.existsSync(RPC_FILE),
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    input: path.relative(WORKSPACE, INPUT),
    summary,
    rows: classified,
    requiredForRoutePositive: [
      "A currently liquidatable row with non-overseize repay size",
      "Exact non-DEX collateral exit output in loan asset or directly routable asset",
      "Loan-token price trusted by fresh source",
      "Net profit positive after gas/slippage/fees",
      "Fork extraction proof",
    ],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(output, null, 2) + "\n");
  if (!QUIET) {
    console.log(`Morpho non-DEX exit classification: rows=${summary.rowsClassified} exactExit=${summary.exactSameBlockExitProvenRows} routePositive=${summary.routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(String(err?.stack || err?.message || err).replace(/https?:\/\/[^\s'"<>]+/g, "[redacted-rpc]"));
  process.exitCode = 1;
});
