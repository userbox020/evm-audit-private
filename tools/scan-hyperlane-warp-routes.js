#!/usr/bin/env node
// Read-only Hyperlane warp route inventory and token-behavior classifier.
// Uses source configs, optional public Hyperlane registry YAML, and optional
// live read-only RPC balance probes. RPC URLs are read in memory only and are
// never printed or written.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const WARP_DIR = path.join(WORKSPACE, "targets", "hyperlane-monorepo", "typescript", "infra", "config", "environments", "mainnet3", "warp");
const CONFIG_GETTERS = path.join(WARP_DIR, "configGetters");
const WARP_IDS = path.join(WARP_DIR, "warpIds.ts");
const COMMON_TOKENS = path.join(WORKSPACE, "targets", "hyperlane-monorepo", "typescript", "infra", "src", "config", "warp.ts");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "hyperlane-warp-routes.json");

const REGISTRY_BASE = process.env.HYPERLANE_REGISTRY_RAW_BASE || "https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/main/deployments/warp_routes";
const FETCH_REGISTRY = process.env.HYPERLANE_WARP_NO_REGISTRY !== "1";
const FETCH_TIMEOUT_MS = Number(process.env.HYPERLANE_WARP_FETCH_TIMEOUT_MS || "12000");
const FETCH_CONCURRENCY = Number(process.env.HYPERLANE_WARP_FETCH_CONCURRENCY || "8");
const MAX_ROUTES = Number(process.env.HYPERLANE_WARP_MAX_ROUTES || "0");
const LIVE_RPC_PROBES = process.env.HYPERLANE_WARP_NO_RPC !== "1";
const LIVE_TOP_ROUTES = Number(process.env.HYPERLANE_WARP_LIVE_TOP_ROUTES || "25");
const LIVE_CONCURRENCY = Number(process.env.HYPERLANE_WARP_LIVE_CONCURRENCY || "8");

const NONLOSSLESS_RE = /fee|tax|reflect|rebase|rebasing|elastic|deflat|burn|transfer[-_\s]?fee|token[-_\s]?2022|scaled[-_\s]?ui|withheld/i;
const VALUE_BEARING_RE = /(?:^|\b)(staked|restaked|staking|liquid staking|lst|lrt|vault|share|receipt|yield|wrapped liquid|interest bearing|savings|reward|p?zeth|ezeth|re7lrt|rsteth|weeths|stbtc|sttia|jitosol|kysol|lrtsol|ssol|susd|susde|susds)(?:\b|$)/i;
const STABLE_OR_CANONICAL_RE = /^(USDC|USDT|DAI|ETH|WETH|WBTC|CBBTC|OP|BNB|SOL|TIA)$/i;
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const CHAIN_IDS = {
  ethereum: 1,
  optimism: 10,
  bsc: 56,
  gnosis: 100,
  unichain: 130,
  polygon: 137,
  mantle: 5000,
  base: 8453,
  arbitrum: 42161,
  avalanche: 43114,
  ink: 57073,
  blast: 81457,
  berachain: 80094,
  scroll: 534352,
  linea: 59144,
  worldchain: 480,
  hyperevm: 999,
};

const SELECTORS = {
  balanceOf: "0x70a08231",
  asset: "0x38d52e0f",
  convertToAssets: "0x07a2d13a",
  decimals: "0x313ce567",
  exchangeRate: "0x3ba0b9a9",
  name: "0x06fdde03",
  rateUpdateNonce: "0x750e63ae",
  symbol: "0x95d89b41",
  totalShares: "0x3a98ef39",
  totalSupply: "0x18160ddd",
  vault: "0xfbfa77cf",
  wrappedToken: "0x996c6cc3",
};

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (_) {
    return "";
  }
}

function stripQuotes(value) {
  return String(value || "").trim().replace(/^['"]|['"]$/g, "");
}

function uniq(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function loadRpcUrls() {
  if (!LIVE_RPC_PROBES || !fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error("rpc error");
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcPool(chainIds) {
  if (!LIVE_RPC_PROBES) return {};
  const wanted = new Set(chainIds);
  const pool = {};
  for (const url of loadRpcUrls()) {
    try {
      const chainIdHex = await rpcCall(url, "eth_chainId", [], 5000);
      const chainId = Number(BigInt(chainIdHex));
      if (wanted.has(chainId) && !pool[chainId]) pool[chainId] = url;
      if (Object.keys(pool).length >= wanted.size) break;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return pool;
}

function encodeAddressArg(address) {
  return String(address).replace(/^0x/i, "").padStart(64, "0");
}

async function ethCall(rpc, to, data) {
  try {
    return await rpcCall(rpc, "eth_call", [{ to, data }, "latest"], 10_000);
  } catch (_) {
    return null;
  }
}

function decodeUint(raw) {
  if (!raw || raw === "0x") return null;
  try {
    return BigInt(raw).toString();
  } catch (_) {
    return null;
  }
}

function decodeAddress(raw) {
  if (!raw || raw === "0x") return null;
  const hex = raw.replace(/^0x/i, "").padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  const address = `0x${hex.slice(-40)}`;
  return EVM_ADDRESS_RE.test(address) ? address : null;
}

function decodeString(raw) {
  if (!raw || raw === "0x") return null;
  try {
    const hex = raw.slice(2);
    if (hex.length === 64) {
      const buf = Buffer.from(hex, "hex");
      const text = buf.toString("utf8").replace(/\0+$/g, "").trim();
      return text || null;
    }
    const offset = Number(BigInt(`0x${hex.slice(0, 64)}`));
    const lenStart = offset * 2;
    const len = Number(BigInt(`0x${hex.slice(lenStart, lenStart + 64)}`));
    if (!Number.isFinite(len) || len < 0 || len > 1024) return null;
    return Buffer.from(hex.slice(lenStart + 64, lenStart + 64 + len * 2), "hex").toString("utf8").replace(/\0/g, "").trim() || null;
  } catch (_) {
    return null;
  }
}

function humanAmount(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try {
    const value = BigInt(raw);
    const d = Number(decimals);
    const scale = 10n ** BigInt(Math.max(0, d));
    const whole = value / scale;
    const frac = value % scale;
    const fracText = frac.toString().padStart(d, "0").slice(0, 8).replace(/0+$/, "");
    return `${whole.toString()}${fracText ? "." + fracText : ""}`;
  } catch (_) {
    return null;
  }
}

async function readErc20(rpc, token, holder = null) {
  if (!rpc || !EVM_ADDRESS_RE.test(token || "")) return null;
  const [code, symbolRaw, nameRaw, decimalsRaw, totalSupplyRaw, balanceRaw] = await Promise.all([
    rpcCall(rpc, "eth_getCode", [token, "latest"], 10_000).catch(() => null),
    ethCall(rpc, token, SELECTORS.symbol),
    ethCall(rpc, token, SELECTORS.name),
    ethCall(rpc, token, SELECTORS.decimals),
    ethCall(rpc, token, SELECTORS.totalSupply),
    holder && EVM_ADDRESS_RE.test(holder) ? ethCall(rpc, token, SELECTORS.balanceOf + encodeAddressArg(holder)) : Promise.resolve(null),
  ]);
  const decimals = decodeUint(decimalsRaw);
  const totalSupply = decodeUint(totalSupplyRaw);
  const balance = decodeUint(balanceRaw);
  return {
    hasCode: Boolean(code && code !== "0x"),
    symbol: decodeString(symbolRaw),
    name: decodeString(nameRaw),
    decimals,
    totalSupplyRaw: totalSupply,
    totalSupply: humanAmount(totalSupply, decimals),
    balanceRaw: balance,
    balance: humanAmount(balance, decimals),
  };
}

async function readRebaseState(rpc, token) {
  if (!rpc || !EVM_ADDRESS_RE.test(token.addressOrDenom || "")) return null;
  const standard = token.standard || "";
  if (/SyntheticRebase/i.test(standard)) {
    const [exchangeRateRaw, totalSharesRaw] = await Promise.all([
      ethCall(rpc, token.addressOrDenom, SELECTORS.exchangeRate),
      ethCall(rpc, token.addressOrDenom, SELECTORS.totalShares),
    ]);
    return {
      kind: "synthetic-rebase",
      exchangeRateRaw: decodeUint(exchangeRateRaw),
      totalSharesRaw: decodeUint(totalSharesRaw),
      totalShares: humanAmount(decodeUint(totalSharesRaw), 18),
    };
  }
  if (/RebaseCollateral/i.test(standard)) {
    const [vaultRaw, wrappedRaw, nonceRaw] = await Promise.all([
      ethCall(rpc, token.addressOrDenom, SELECTORS.vault),
      ethCall(rpc, token.addressOrDenom, SELECTORS.wrappedToken),
      ethCall(rpc, token.addressOrDenom, SELECTORS.rateUpdateNonce),
    ]);
    const vault = decodeAddress(vaultRaw) || token.collateralAddressOrDenom || null;
    const wrappedToken = decodeAddress(wrappedRaw);
    const [assetRaw, convertRaw, vaultErc20] = vault && EVM_ADDRESS_RE.test(vault)
      ? await Promise.all([
          ethCall(rpc, vault, SELECTORS.asset),
          ethCall(rpc, vault, SELECTORS.convertToAssets + BigInt(10_000_000_000).toString(16).padStart(64, "0")),
          readErc20(rpc, vault, token.addressOrDenom),
        ])
      : [null, null, null];
    return {
      kind: "collateral-rebase",
      vault,
      wrappedToken,
      vaultAsset: decodeAddress(assetRaw),
      rateUpdateNonce: decodeUint(nonceRaw),
      convertToAssetsPrecisionRaw: decodeUint(convertRaw),
      vaultBalanceRaw: vaultErc20?.balanceRaw || null,
      vaultBalance: vaultErc20?.balance || null,
      vaultTotalSupplyRaw: vaultErc20?.totalSupplyRaw || null,
      vaultTotalSupply: vaultErc20?.totalSupply || null,
    };
  }
  return null;
}

async function liveProbeToken(pool, token) {
  const chainId = CHAIN_IDS[token.chainName];
  if (!chainId) return { ...token, liveProbeStatus: "unsupported-chain" };
  const rpc = pool[chainId];
  if (!rpc) return { ...token, chainId, liveProbeStatus: "missing-rpc" };
  if (!EVM_ADDRESS_RE.test(token.addressOrDenom || "")) return { ...token, chainId, liveProbeStatus: "non-evm-address" };

  const wrapped = await readErc20(rpc, token.addressOrDenom, null);
  const collateral = EVM_ADDRESS_RE.test(token.collateralAddressOrDenom || "")
    ? await readErc20(rpc, token.collateralAddressOrDenom, token.addressOrDenom)
    : null;
  const rebaseState = await readRebaseState(rpc, token);

  return {
    routeId: token.routeId,
    chainName: token.chainName,
    chainId,
    symbol: token.symbol || null,
    name: token.name || null,
    standard: token.standard || null,
    addressOrDenom: token.addressOrDenom || null,
    collateralAddressOrDenom: token.collateralAddressOrDenom || null,
    riskClass: token.riskClass || null,
    liveProbeStatus: wrapped?.hasCode ? "ok" : "no-token-code",
    wrapped,
    collateral,
    rebaseState,
    positiveWrappedSupply: Boolean(wrapped?.totalSupplyRaw && BigInt(wrapped.totalSupplyRaw) > 0n),
    positiveCollateralBalance: Boolean(collateral?.balanceRaw && BigInt(collateral.balanceRaw) > 0n),
  };
}

function buildRebaseRouteChecks(rows) {
  const byRoute = new Map();
  for (const row of rows) {
    if (!row.rebaseState) continue;
    if (!byRoute.has(row.routeId)) byRoute.set(row.routeId, []);
    byRoute.get(row.routeId).push(row);
  }
  const checks = [];
  for (const [routeId, routeRows] of byRoute.entries()) {
    const syntheticShares = routeRows
      .filter((row) => row.rebaseState?.kind === "synthetic-rebase" && row.rebaseState.totalSharesRaw)
      .reduce((sum, row) => sum + BigInt(row.rebaseState.totalSharesRaw), 0n);
    const collateralShares = routeRows
      .filter((row) => row.rebaseState?.kind === "collateral-rebase" && row.rebaseState.vaultBalanceRaw)
      .reduce((sum, row) => sum + BigInt(row.rebaseState.vaultBalanceRaw), 0n);
    const delta = syntheticShares - collateralShares;
    const absDelta = delta < 0n ? -delta : delta;
    const deltaBps = collateralShares > 0n ? Number((absDelta * 10000n) / collateralShares) : null;
    checks.push({
      routeId,
      syntheticSharesRaw: syntheticShares.toString(),
      collateralSharesRaw: collateralShares.toString(),
      syntheticShares: humanAmount(syntheticShares.toString(), 18),
      collateralShares: humanAmount(collateralShares.toString(), 18),
      deltaRaw: delta.toString(),
      deltaBps,
      shareMatched: collateralShares > 0n && deltaBps !== null && deltaBps <= 1,
      routePositive: false,
      blocker: "Share check alone is not an exit route; requires exploitable mismatch plus material liquidity.",
    });
  }
  return checks.sort((a, b) => (b.deltaBps || 0) - (a.deltaBps || 0));
}

function parseWarpIds() {
  const text = readText(WARP_IDS);
  const routes = [];
  for (const match of text.matchAll(/^\s*([A-Za-z0-9_]+)\s*=\s*['"]([^'"]+)['"]/gm)) {
    const routeId = match[2];
    const [symbol, slug] = routeId.split("/");
    if (!symbol || !slug) continue;
    routes.push({ key: match[1], routeId, symbol, slug });
  }
  return MAX_ROUTES > 0 ? routes.slice(0, MAX_ROUTES) : routes;
}

function parseCommonTokens() {
  const text = readText(COMMON_TOKENS);
  const out = {};
  let currentChain = null;
  for (const line of text.split(/\r?\n/)) {
    const chainMatch = line.match(/^\s{2}([A-Za-z0-9_]+):\s*\{/);
    if (chainMatch) {
      currentChain = chainMatch[1];
      out[currentChain] = out[currentChain] || {};
      continue;
    }
    if (currentChain && /^\s{2}\}/.test(line)) {
      currentChain = null;
      continue;
    }
    if (!currentChain) continue;
    const tokenMatch = line.match(/^\s{4}['"]?([A-Za-z0-9_+-]+)['"]?:\s*['"]([^'"]+)['"]/);
    if (tokenMatch) out[currentChain][tokenMatch[1]] = tokenMatch[2];
  }
  return out;
}

function extractObject(text, start) {
  const open = text.indexOf("{", start);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return "";
}

function parseSourceConfigFiles(commonTokens) {
  const files = fs.existsSync(CONFIG_GETTERS)
    ? fs.readdirSync(CONFIG_GETTERS).filter((f) => f.endsWith(".ts")).map((f) => path.join(CONFIG_GETTERS, f))
    : [];
  const sourceRoutes = [];
  const sourceLegs = [];

  for (const file of files) {
    const text = readText(file);
    const routeRefs = uniq([...text.matchAll(/WarpRouteIds\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
    const directTypes = [...text.matchAll(/type:\s*TokenType\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    const helperCollateral = /getCollateralTokenConfigForChain|getRebalancingUSDCConfigForChain|getRebalancingUSDTConfigForChain/.test(text);
    const helperSynthetic = /getSyntheticTokenConfigForChain/.test(text);
    sourceRoutes.push({ file: rel(file), routeRefs, tokenTypeRefs: uniq(directTypes), helperCollateral, helperSynthetic });

    const constObjectNames = new Set([...text.matchAll(/const\s+([A-Za-z0-9_]+)\s*:[^=]+?=\s*\{/g)].map((m) => m[1]));
    for (const match of text.matchAll(/const\s+([A-Za-z0-9_]+)\s*:[^=]+?=\s*\{/g)) {
      const name = match[1];
      if (!constObjectNames.has(name)) continue;
      const obj = extractObject(text, match.index);
      const type = obj.match(/type:\s*TokenType\.([A-Za-z0-9_]+)/)?.[1] || null;
      const tokenRef = obj.match(/token:\s*tokens\.([A-Za-z0-9_]+)\.([A-Za-z0-9_+-]+)/);
      const tokenLiteral = obj.match(/token:\s*['"](0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})['"]/);
      const symbol = tokenRef?.[2] || null;
      const chain = tokenRef?.[1] || name;
      const token = tokenRef ? commonTokens[tokenRef[1]]?.[tokenRef[2]] || null : tokenLiteral?.[1] || null;
      if (!type && !token) continue;
      sourceLegs.push({ file: rel(file), object: name, chain, type, tokenRef: tokenRef ? `tokens.${tokenRef[1]}.${tokenRef[2]}` : null, token, symbol });
    }
  }

  return { sourceRoutes, sourceLegs };
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "opencode-hyperlane-readonly-scanner" } });
    if (!res.ok) return { ok: false, status: res.status, text: "" };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (err) {
    return { ok: false, status: "error", error: String(err && err.message ? err.message : err), text: "" };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

function parseRegistryTokens(yaml) {
  const tokens = [];
  let current = null;
  for (const rawLine of String(yaml || "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (/^\s{2}-\s+/.test(line)) {
      if (current) tokens.push(current);
      current = {};
      const inline = line.replace(/^\s{2}-\s+/, "");
      const m = inline.match(/^([A-Za-z0-9_]+):\s*(.+)$/);
      if (m) current[m[1]] = stripQuotes(m[2]);
      continue;
    }
    if (!current) continue;
    const field = line.match(/^\s{4}([A-Za-z0-9_]+):\s*(.*)$/);
    if (!field) continue;
    if (field[1] === "connections") continue;
    current[field[1]] = stripQuotes(field[2]);
  }
  if (current) tokens.push(current);
  return tokens.filter((token) => token.chainName || token.addressOrDenom || token.standard || token.symbol);
}

async function fetchRegistryRoute(route) {
  if (!FETCH_REGISTRY) return { ...route, registryFetched: false, registryStatus: "disabled", tokens: [] };
  const configUrl = `${REGISTRY_BASE}/${encodeURIComponent(route.symbol)}/${encodeURIComponent(route.slug)}-config.yaml`;
  const config = await fetchText(configUrl);
  if (!config.ok) return { ...route, registryFetched: false, registryStatus: config.status, tokens: [] };
  return {
    ...route,
    registryFetched: true,
    registryStatus: config.status,
    registryPath: `deployments/warp_routes/${route.symbol}/${route.slug}-config.yaml`,
    tokens: parseRegistryTokens(config.text),
  };
}

function classifyToken(token) {
  const text = [token.symbol, token.name, token.standard, token.chainName].filter(Boolean).join(" ");
  const reasons = [];
  let riskClass = "canonical-or-lossless";

  if (/Rebase/i.test(token.standard || "")) {
    riskClass = "rebase-specific-standard-review";
    reasons.push("route uses Hyperlane rebase-specific standard; review focuses on ERC4626 share accounting and rate-update ordering");
  } else if (NONLOSSLESS_RE.test(text)) {
    riskClass = "nonlossless-transfer-hint";
    reasons.push("symbol/name/standard contains fee, rebase, elastic, scaled, Token-2022, or deflationary hint");
  } else if (VALUE_BEARING_RE.test(text) && !STABLE_OR_CANONICAL_RE.test(token.symbol || "")) {
    riskClass = "value-bearing-review";
    reasons.push("symbol/name suggests staking, restaking, vault-share, or receipt behavior");
  }

  if (/Collateral|Lockbox/i.test(token.standard || "") || token.collateralAddressOrDenom) reasons.push("route has collateral or lockbox leg");
  if (/XERC20/i.test(token.standard || "")) reasons.push("xERC20 route; bridge accounting depends on lockbox/minter configuration");
  if (/synthetic/i.test(token.standard || "")) reasons.push("synthetic remote leg");
  if (!token.collateralAddressOrDenom && /Collateral|Lockbox/i.test(token.standard || "")) reasons.push("registry did not expose collateralAddressOrDenom for this collateral-like standard");

  return { riskClass, reasons: uniq(reasons) };
}

function summarizeRoute(route) {
  const tokens = route.tokens.map((token) => ({ ...token, classification: classifyToken(token) }));
  const collateralLegs = tokens.filter((token) => /Collateral|Lockbox/i.test(token.standard || "") || token.collateralAddressOrDenom);
  const nonLossless = tokens.filter((token) => token.classification.riskClass === "nonlossless-transfer-hint");
  const rebaseSpecific = tokens.filter((token) => token.classification.riskClass === "rebase-specific-standard-review");
  const valueBearing = tokens.filter((token) => token.classification.riskClass === "value-bearing-review");
  const sourceChains = uniq(tokens.map((token) => token.chainName));
  const standards = uniq(tokens.map((token) => token.standard));
  const riskScore = nonLossless.length ? 80 : rebaseSpecific.length ? 66 : valueBearing.length && collateralLegs.length ? 62 : collateralLegs.length ? 35 : 15;

  return {
    routeId: route.routeId,
    symbol: route.symbol,
    slug: route.slug,
    registryFetched: route.registryFetched,
    registryStatus: route.registryStatus,
    registryPath: route.registryPath || null,
    tokenCount: tokens.length,
    chainCount: sourceChains.length,
    sourceChains,
    standards,
    collateralLegs: collateralLegs.length,
    nonLosslessHints: nonLossless.length,
    rebaseSpecificHints: rebaseSpecific.length,
    valueBearingReviewHints: valueBearing.length,
    riskScore,
    routePositive: false,
    blocker: nonLossless.length
      ? "Non-lossless hint requires balance-delta proof plus locked-vs-remote supply and liquidity join before fork."
      : rebaseSpecific.length
        ? "Route uses rebase-specific ERC4626/share accounting; needs a concrete share/rate mismatch plus liquidity before fork."
      : valueBearing.length
        ? "Value-bearing token is not a transfer-loss proof; needs live transfer-delta or rebase evidence plus route liquidity."
        : "No non-lossless collateral evidence from registry/source classifier.",
    topTokens: tokens
      .filter((token) => token.classification.riskClass !== "canonical-or-lossless" || /Collateral|Lockbox/i.test(token.standard || ""))
      .slice(0, 12)
      .map((token) => ({
        chainName: token.chainName || null,
        symbol: token.symbol || null,
        name: token.name || null,
        standard: token.standard || null,
        addressOrDenom: token.addressOrDenom || null,
        collateralAddressOrDenom: token.collateralAddressOrDenom || null,
        riskClass: token.classification.riskClass,
        reasons: token.classification.reasons,
      })),
  };
}

function summarizeSourceLegs(sourceLegs) {
  return sourceLegs.map((leg) => {
    const token = { symbol: leg.symbol, name: leg.symbol, standard: leg.type, chainName: leg.chain, collateralAddressOrDenom: leg.token };
    return { ...leg, classification: classifyToken(token) };
  });
}

async function main() {
  const routeIds = parseWarpIds();
  const commonTokens = parseCommonTokens();
  const { sourceRoutes, sourceLegs } = parseSourceConfigFiles(commonTokens);
  const registryRoutes = await mapLimit(routeIds, FETCH_CONCURRENCY, fetchRegistryRoute);
  const routeSummaries = registryRoutes.map(summarizeRoute).sort((a, b) => b.riskScore - a.riskScore || b.tokenCount - a.tokenCount);
  const sourceLegSummaries = summarizeSourceLegs(sourceLegs);

  const liveTargets = [];
  const seenLiveTarget = new Set();
  for (const route of routeSummaries.slice(0, LIVE_TOP_ROUTES)) {
    for (const token of route.topTokens || []) {
      if (token.riskClass === "canonical-or-lossless" && !/Collateral|Lockbox|Rebase/i.test(token.standard || "")) continue;
      const key = `${route.routeId}:${token.chainName}:${token.addressOrDenom}:${token.collateralAddressOrDenom}`.toLowerCase();
      if (seenLiveTarget.has(key)) continue;
      seenLiveTarget.add(key);
      liveTargets.push({ ...token, routeId: route.routeId });
    }
  }
  const liveChainIds = uniq(liveTargets.map((token) => CHAIN_IDS[token.chainName]).filter(Boolean));
  const rpcPool = await resolveRpcPool(liveChainIds);
  const liveBalanceRows = LIVE_RPC_PROBES && liveTargets.length
    ? await mapLimit(liveTargets, LIVE_CONCURRENCY, (token) => liveProbeToken(rpcPool, token))
    : [];

  const registryFetched = routeSummaries.filter((r) => r.registryFetched).length;
  const registryTokenCount = routeSummaries.reduce((sum, r) => sum + r.tokenCount, 0);
  const collateralLegs = routeSummaries.reduce((sum, r) => sum + r.collateralLegs, 0);
  const nonLosslessRoutes = routeSummaries.filter((r) => r.nonLosslessHints > 0);
  const rebaseSpecificRoutes = routeSummaries.filter((r) => r.rebaseSpecificHints > 0);
  const valueBearingRoutes = routeSummaries.filter((r) => r.valueBearingReviewHints > 0);
  const reviewCandidates = routeSummaries.filter((r) => (r.nonLosslessHints > 0 || r.rebaseSpecificHints > 0 || r.valueBearingReviewHints > 0) && r.collateralLegs > 0);
  const routePositive = routeSummaries.filter((r) => r.routePositive).length;
  const liveOkRows = liveBalanceRows.filter((row) => row.liveProbeStatus === "ok");
  const positiveSupplyRows = liveBalanceRows.filter((row) => row.positiveWrappedSupply);
  const positiveCollateralRows = liveBalanceRows.filter((row) => row.positiveCollateralBalance);
  const rebaseRouteChecks = buildRebaseRouteChecks(liveBalanceRows);
  const rebaseShareMismatchRows = rebaseRouteChecks.filter((row) => row.deltaBps !== null && row.deltaBps > 1);

  const out = {
    generatedAt: new Date().toISOString(),
    scope: "Read-only Hyperlane warp route registry/source inventory and token-behavior classifier",
    safety: {
      rpcInventoryRead: LIVE_RPC_PROBES,
      rpcUrlsStored: false,
      publicRegistryFetch: FETCH_REGISTRY,
      signedActions: false,
      exploitExecuteCalls: false,
      signedActionJustified: false,
    },
    inputs: {
      warpIds: rel(WARP_IDS),
      commonTokens: rel(COMMON_TOKENS),
      configGetters: rel(CONFIG_GETTERS),
      rpcInventory: LIVE_RPC_PROBES && fs.existsSync(RPC_FILE) ? rel(RPC_FILE) : null,
      publicRegistryRawBase: FETCH_REGISTRY ? REGISTRY_BASE.replace(/^https?:\/\//, "https://") : null,
    },
    thresholds: {
      routePositiveRequires: [
        "live non-lossless transfer/rebase evidence",
        "collateral router balance-delta mismatch vs nominal dispatch",
        "locked-vs-remote supply mismatch or mint/release over-credit",
        "material DEX/lending exit liquidity and positive gas-adjusted economics",
      ],
    },
    summary: {
      routeIds: routeIds.length,
      registryFetched,
      registryMissing: routeIds.length - registryFetched,
      registryTokenCount,
      sourceConfigFiles: sourceRoutes.length,
      sourceTokenLegs: sourceLegSummaries.length,
      collateralLegs,
      nonLosslessHintRoutes: nonLosslessRoutes.length,
      rebaseSpecificRoutes: rebaseSpecificRoutes.length,
      valueBearingReviewRoutes: valueBearingRoutes.length,
      reviewCandidates: reviewCandidates.length,
      liveProbeTargets: liveTargets.length,
      liveProbeOk: liveOkRows.length,
      liveProbeChainsResolved: Object.keys(rpcPool).length,
      positiveWrappedSupplyRows: positiveSupplyRows.length,
      positiveCollateralBalanceRows: positiveCollateralRows.length,
      rebaseRouteChecks: rebaseRouteChecks.length,
      rebaseShareMismatchRows: rebaseShareMismatchRows.length,
      watchCandidates: 0,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      topRoute: routeSummaries[0]?.routeId || null,
    },
    blockers: [
      "Registry/source classification is not balance-delta proof.",
      "No live locked-collateral vs remote-supply join is present in this artifact.",
      "No DEX/lending liquidity or gas-adjusted exit route is attached to any Hyperlane route.",
      "Fork PoC is gated until a route has a concrete transfer-delta mismatch and material liquidity.",
    ],
    topRoutes: routeSummaries.slice(0, 25),
    rebaseRouteChecks,
    liveBalanceRows: liveBalanceRows.slice(0, 160),
    sourceTokenLegs: sourceLegSummaries
      .filter((leg) => leg.classification.riskClass !== "canonical-or-lossless" || /collateral|lockbox|native/i.test(leg.type || ""))
      .slice(0, 80),
    registryFailures: registryRoutes
      .filter((r) => !r.registryFetched)
      .slice(0, 80)
      .map((r) => ({ routeId: r.routeId, status: r.registryStatus })),
  };

  ensureDir(OUT);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`hyperlane-warp: routes=${routeIds.length} fetched=${registryFetched} tokens=${registryTokenCount} review=${reviewCandidates.length} routePositive=${routePositive}`);
  console.log(`wrote ${rel(OUT)}`);
}

main().catch((err) => {
  console.error(`hyperlane-warp: failed: ${String(err && err.message ? err.message : err)}`);
  process.exitCode = 1;
});
