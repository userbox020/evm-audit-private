#!/usr/bin/env node
// probe-aave-v4-oracle-influence.js - read-only Aave V4 oracle influence gate.
// RPC URLs are resolved in memory only and are never printed or written.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-oracle-influence-proof.json");
const BORROWERS_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-spoke-borrowers.json");
const WATCH_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-watch.json");
const STABLE_PAIR_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-stable-pair-route-probe.json");

const CHAIN_ID = 1;
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const SPOKE_VIEWS = new ethers.Interface([
  "function ORACLE() view returns (address)",
  "function getUserAccountData(address user) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getUserSuppliedAssets(uint256 reserveId,address user) view returns (uint256)",
  "function getUserTotalDebt(uint256 reserveId,address user) view returns (uint256)",
]);

const AAVE_ORACLE_VIEWS = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function spoke() view returns (address)",
  "function getReserveSource(uint256 reserveId) view returns (address)",
  "function getReservePrice(uint256 reserveId) view returns (uint256)",
]);

const SOURCE_CALLS = [
  { key: "decimals", sig: "function decimals() view returns (uint8)" },
  { key: "description", sig: "function description() view returns (string)" },
  { key: "version", sig: "function version() view returns (uint256)" },
  { key: "typeAndVersion", sig: "function typeAndVersion() view returns (string)" },
  { key: "latestRoundData", sig: "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)" },
  { key: "latestAnswer", sig: "function latestAnswer() view returns (int256)" },
  { key: "latestTimestamp", sig: "function latestTimestamp() view returns (uint256)" },
  { key: "latestRound", sig: "function latestRound() view returns (uint256)" },
  { key: "aggregator", sig: "function aggregator() view returns (address)" },
  { key: "proposedAggregator", sig: "function proposedAggregator() view returns (address)" },
  { key: "accessController", sig: "function accessController() view returns (address)" },
  { key: "requesterAccessController", sig: "function requesterAccessController() view returns (address)" },
  { key: "owner", sig: "function owner() view returns (address)" },
  { key: "authority", sig: "function authority() view returns (address)" },
  { key: "ASSET_TO_USD_AGGREGATOR", sig: "function ASSET_TO_USD_AGGREGATOR() view returns (address)" },
  { key: "BASE_TO_USD_AGGREGATOR", sig: "function BASE_TO_USD_AGGREGATOR() view returns (address)" },
  { key: "BASE_TO_USD_SOURCE", sig: "function BASE_TO_USD_SOURCE() view returns (address)" },
  { key: "RATIO_PROVIDER", sig: "function RATIO_PROVIDER() view returns (address)" },
  { key: "PRICE_SOURCE", sig: "function PRICE_SOURCE() view returns (address)" },
];

const CONTROL_SIGNATURES = [
  "transferOwnership(address)",
  "acceptOwnership()",
  "setAuthority(address)",
  "setReserveSource(uint256,address)",
  "setReserveSources(uint256[],address[])",
  "setAssetSources(address[],address[])",
  "setSource(address,address)",
  "setSources(address[],address[])",
  "updateSource(uint256,address)",
  "setOracle(address)",
  "proposeAggregator(address)",
  "confirmAggregator(address)",
  "setAggregator(address)",
  "updateAssetConfig(uint256,(address,uint16,address,address),bytes)",
];

const PERMISSIONLESS_UPDATE_CANDIDATES = [
  "updateAnswer(int256)",
  "setPrice(uint256)",
  "setPrice(int256)",
  "updatePrice()",
  "poke()",
  "sync()",
];

const DEX_OR_TWAP_SIGNATURES = [
  "slot0()",
  "observe(uint32[])",
  "getReserves()",
  "price0CumulativeLast()",
  "price1CumulativeLast()",
  "currentCumulativePrices(address)",
  "consult(address,uint256)",
  "get_dy(int128,int128,uint256)",
  "get_dy(uint256,uint256,uint256)",
  "get_virtual_price()",
  "coins(uint256)",
  "balances(uint256)",
];

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function loadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeArtifact(out) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function sameAddress(a, b) {
  const aa = normalizeAddress(a);
  const bb = normalizeAddress(b);
  return Boolean(aa && bb && aa.toLowerCase() === bb.toLowerCase());
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 6) {
  const n = asNumber(value);
  if (n === null) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function slotToAddress(value) {
  const hex = String(value || "0x").replace(/^0x/i, "").padStart(64, "0");
  const tail = `0x${hex.slice(-40)}`;
  return tail === ethers.ZeroAddress ? null : normalizeAddress(tail);
}

async function proxySlots(provider, address) {
  const [implementationRaw, adminRaw, beaconRaw] = await Promise.all([
    provider.getStorage(address, EIP1967_IMPLEMENTATION_SLOT).catch(() => null),
    provider.getStorage(address, EIP1967_ADMIN_SLOT).catch(() => null),
    provider.getStorage(address, EIP1967_BEACON_SLOT).catch(() => null),
  ]);
  return {
    implementation: slotToAddress(implementationRaw),
    admin: slotToAddress(adminRaw),
    beacon: slotToAddress(beaconRaw),
  };
}

async function callDecoded(provider, target, iface, name, args = []) {
  try {
    const data = iface.encodeFunctionData(name, args);
    const raw = await provider.call({ to: target, data });
    const decoded = iface.decodeFunctionResult(name, raw);
    return { ok: true, value: decoded.length === 1 ? decoded[0] : Array.from(decoded) };
  } catch (e) {
    return { ok: false, error: e?.shortMessage || e?.message || "call failed" };
  }
}

async function callView(provider, target, signature, args = []) {
  const iface = new ethers.Interface([signature]);
  const name = iface.fragments[0].name;
  return callDecoded(provider, target, iface, name, args);
}

function resultAddress(call) {
  const address = call?.ok ? normalizeAddress(call.value) : null;
  return address && address !== ethers.ZeroAddress ? address : null;
}

function resultNumber(call) {
  if (!call?.ok) return null;
  const n = Number(call.value);
  return Number.isFinite(n) ? n : null;
}

function resultString(call) {
  return call?.ok && typeof call.value === "string" ? call.value : null;
}

function extractPush4Selectors(code) {
  const out = new Set();
  if (!code || code === "0x") return [];
  const re = /63([0-9a-fA-F]{8})/g;
  let match;
  while ((match = re.exec(code))) out.add(`0x${match[1].toLowerCase()}`);
  return [...out].sort();
}

function selectorPresence(selectors, signatures) {
  const set = new Set(selectors.map((selector) => selector.toLowerCase()));
  return signatures.map((signature) => {
    const selector = ethers.id(signature).slice(0, 10).toLowerCase();
    return { signature, selector, present: set.has(selector) };
  }).filter((row) => row.present);
}

function parseLatestRoundData(call, decimals, blockTimestamp) {
  if (!call?.ok || !Array.isArray(call.value) || call.value.length < 5) return null;
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = call.value;
  const d = Number.isInteger(decimals) ? decimals : 8;
  let answerFormatted = null;
  try { answerFormatted = Number(ethers.formatUnits(answer, d)); } catch (_) { answerFormatted = null; }
  const updated = Number(updatedAt || 0n);
  return {
    roundId,
    answer,
    answerFormatted: Number.isFinite(answerFormatted) ? answerFormatted : null,
    startedAt: Number(startedAt || 0n),
    updatedAt: updated,
    answeredInRound,
    ageSeconds: updated > 0 && blockTimestamp ? Math.max(0, blockTimestamp - updated) : null,
  };
}

function classifySource({ calls, selectorHits, childAggregators }) {
  const hasLatestRound = Boolean(calls.latestRoundData?.ok);
  const hasLatestAnswer = Boolean(calls.latestAnswer?.ok);
  const description = resultString(calls.description);
  const typeAndVersion = resultString(calls.typeAndVersion);
  const hasProxyAggregator = Boolean(resultAddress(calls.aggregator));
  const dexHits = selectorHits.dexOrTwap.length > 0;
  const childChainlink = (childAggregators || []).some((child) => child.classification?.chainlinkCompatible);
  const cappedChainlinkAdapter = childChainlink && hasLatestAnswer && /capped/i.test(String(description || ""));
  const chainlinkCompatible = cappedChainlinkAdapter || (hasLatestRound && (Boolean(description) || hasProxyAggregator || /chainlink/i.test(String(typeAndVersion || "")) || childChainlink));

  let kind = "unknown-source";
  if (dexHits) kind = "dex-or-twap-like";
  else if (cappedChainlinkAdapter) kind = "capped-chainlink-adapter";
  else if (chainlinkCompatible && hasProxyAggregator) kind = "chainlink-proxy-compatible";
  else if (chainlinkCompatible) kind = "chainlink-compatible";
  else if (hasLatestRound) kind = "aggregator-v3-compatible";

  return {
    kind,
    chainlinkCompatible,
    dexOrTwapLike: dexHits,
    description,
    typeAndVersion,
    reason: dexHits
      ? "Bytecode contains known DEX/TWAP selectors."
      : cappedChainlinkAdapter
        ? "Capped adapter returns latestAnswer and references a Chainlink-compatible child feed."
      : chainlinkCompatible
        ? "Contract answers AggregatorV3 latestRoundData with Chainlink-style metadata or proxy aggregator."
        : hasLatestRound
          ? "Contract answers AggregatorV3 latestRoundData but metadata/proxy identity is not conclusive."
          : "No recognized price-feed or DEX/TWAP interface was confirmed by read-only calls.",
  };
}

async function addressKind(provider, address) {
  if (!address) return null;
  const code = await provider.getCode(address).catch(() => "0x");
  return { address, type: code && code !== "0x" ? "contract" : "eoa", codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0 };
}

async function probeContract(provider, address, label, blockTimestamp, depth = 0) {
  const normalized = normalizeAddress(address);
  if (!normalized) return { label, address, error: "invalid address" };
  const [code, slots] = await Promise.all([
    provider.getCode(normalized).catch(() => "0x"),
    proxySlots(provider, normalized),
  ]);
  const selectors = extractPush4Selectors(code);
  const calls = Object.fromEntries(await Promise.all(SOURCE_CALLS.map(async (item) => [item.key, await callView(provider, normalized, item.sig)])));
  const childAggregatorAddresses = [
    resultAddress(calls.aggregator),
    resultAddress(calls.proposedAggregator),
    resultAddress(calls.ASSET_TO_USD_AGGREGATOR),
    resultAddress(calls.BASE_TO_USD_AGGREGATOR),
    resultAddress(calls.BASE_TO_USD_SOURCE),
    resultAddress(calls.PRICE_SOURCE),
  ].filter((addr, idx, arr) => addr && !sameAddress(addr, normalized) && arr.findIndex((x) => sameAddress(x, addr)) === idx);
  const childAggregators = [];
  if (depth < 1) {
    for (const child of childAggregatorAddresses.slice(0, 4)) {
      childAggregators.push(await probeContract(provider, child, `${label}.child`, blockTimestamp, depth + 1));
    }
  }
  const selectorHits = {
    control: selectorPresence(selectors, CONTROL_SIGNATURES),
    permissionlessUpdateCandidates: selectorPresence(selectors, PERMISSIONLESS_UPDATE_CANDIDATES),
    dexOrTwap: selectorPresence(selectors, DEX_OR_TWAP_SIGNATURES),
  };
  const decimals = resultNumber(calls.decimals);
  const latestRoundData = parseLatestRoundData(calls.latestRoundData, decimals, blockTimestamp);
  const classification = classifySource({ calls, selectorHits, childAggregators });
  const controlAddresses = {
    owner: resultAddress(calls.owner),
    authority: resultAddress(calls.authority),
    accessController: resultAddress(calls.accessController),
    requesterAccessController: resultAddress(calls.requesterAccessController),
    eip1967Admin: slots.admin,
  };
  const controlAddressTypes = Object.fromEntries(await Promise.all(Object.entries(controlAddresses).map(async ([key, value]) => [key, await addressKind(provider, value)])));
  const permissionlessLikely = classification.dexOrTwapLike || (selectorHits.permissionlessUpdateCandidates.length > 0 && !controlAddresses.owner && !controlAddresses.authority && !slots.admin);
  const manipulability = {
    permissionlessLikely,
    verdict: permissionlessLikely
      ? "potentially-permissionless-or-market-manipulable"
      : classification.chainlinkCompatible
        ? "not-permissionless-chainlink-or-admin-controlled"
        : "unknown-no-permissionless-update-identified",
    reason: permissionlessLikely
      ? "A DEX/TWAP selector or unauthenticated-looking update selector was found; fork proof would be required."
      : classification.chainlinkCompatible
        ? "AggregatorV3/Chainlink-style feed path; no DEX pool dependency or public price-update surface was identified."
        : "The source is not fully classified, but no permissionless manipulation surface was identified by selectors/calls.",
  };

  return {
    label,
    address: normalized,
    codePresent: code !== "0x",
    codeBytes: code === "0x" ? 0 : (code.length - 2) / 2,
    eip1967: slots,
    calls: {
      decimals: calls.decimals?.ok ? decimals : null,
      description: resultString(calls.description),
      version: calls.version?.ok ? String(calls.version.value) : null,
      typeAndVersion: resultString(calls.typeAndVersion),
      aggregator: resultAddress(calls.aggregator),
      proposedAggregator: resultAddress(calls.proposedAggregator),
      accessController: resultAddress(calls.accessController),
      requesterAccessController: resultAddress(calls.requesterAccessController),
      owner: controlAddresses.owner,
      authority: controlAddresses.authority,
      latestRoundData,
      latestAnswer: calls.latestAnswer?.ok ? calls.latestAnswer.value : null,
      latestTimestamp: calls.latestTimestamp?.ok ? Number(calls.latestTimestamp.value) : null,
      underlyingSources: childAggregatorAddresses,
    },
    classification,
    selectorHits,
    controlAddresses,
    controlAddressTypes,
    manipulability,
    childAggregators,
  };
}

function chooseTarget() {
  const stable = loadJson(STABLE_PAIR_FILE, {});
  const watch = loadJson(WATCH_FILE, {});
  const borrowers = loadJson(BORROWERS_FILE, {});
  const stableTarget = stable?.target || null;
  const stableLive = stable?.live || null;
  const watchTop = watch?.latest?.topRows?.[0] || watch?.latest?.closestRows?.[0] || null;
  const user = stableLive?.user || watchTop?.user || null;
  const spoke = stableLive?.spoke || watchTop?.spoke || null;
  if (!user || !spoke) return { error: "no target user/spoke found", borrowers, stable, watch };

  let detailedUser = null;
  let detailedSpoke = null;
  for (const spokeRow of borrowers?.spokes || []) {
    if (!sameAddress(spokeRow.spoke, spoke)) continue;
    const found = (spokeRow.topUsers || []).find((row) => sameAddress(row.user, user));
    if (found) {
      detailedUser = found;
      detailedSpoke = spokeRow;
      break;
    }
  }
  if (!detailedUser) {
    detailedUser = (borrowers?.topUsers || []).find((row) => sameAddress(row.user, user)) || null;
  }
  const reserves = Array.isArray(detailedUser?.reserves) ? detailedUser.reserves : [];
  const collateralReserveId = stableTarget?.collateral?.reserveId ?? watchTop?.topCollateral?.reserveId ?? null;
  const debtReserveId = stableTarget?.repay?.reserveId ?? watchTop?.topDebt?.reserveId ?? null;
  const artifactCollateral = reserves.find((row) => Number(row.reserveId) === Number(collateralReserveId)) || null;
  const artifactDebt = reserves.find((row) => Number(row.reserveId) === Number(debtReserveId)) || null;
  const collateral = artifactCollateral ? { ...stableTarget?.collateral, ...artifactCollateral, address: stableTarget?.collateral?.address || artifactCollateral.address || null } : stableTarget?.collateral || null;
  const debt = artifactDebt ? { ...stableTarget?.repay, ...artifactDebt, address: stableTarget?.repay?.address || artifactDebt.address || null } : stableTarget?.repay || null;

  return {
    user,
    spoke,
    hub: detailedSpoke?.hub || watchTop?.hub || null,
    hubAddress: detailedSpoke?.hubAddress || null,
    healthFactor: asNumber(stableLive?.healthFactor) ?? asNumber(detailedUser?.account?.healthFactor) ?? asNumber(watchTop?.healthFactor),
    bpsToLiquidation: asNumber(stableLive?.bpsToLiquidation) ?? asNumber(watchTop?.bpsToLiquidation),
    collateral,
    debt,
    detailedUser,
  };
}

function decodeAccountData(result) {
  if (!result?.ok || !Array.isArray(result.value)) return null;
  const [riskPremium, avgCollateralFactor, healthFactor, totalCollateralValue, totalDebtValueRay, activeCollateralCount, borrowCount] = result.value;
  return {
    riskPremiumBps: Number(riskPremium),
    avgCollateralFactor: Number(ethers.formatUnits(avgCollateralFactor, 18)),
    healthFactorRaw: healthFactor,
    healthFactor: healthFactor === ethers.MaxUint256 ? Number.POSITIVE_INFINITY : Number(ethers.formatUnits(healthFactor, 18)),
    totalCollateralValueRaw: totalCollateralValue,
    totalDebtValueRayRaw: totalDebtValueRay,
    activeCollateralCount: Number(activeCollateralCount),
    borrowCount: Number(borrowCount),
  };
}

function priceMoveRequirements(healthFactor) {
  const hf = asNumber(healthFactor);
  if (!(hf > 0) || !Number.isFinite(hf)) return null;
  return {
    healthFactor: round(hf, 12),
    collateralDropPctToReachOne: round((1 - (1 / hf)) * 100, 6),
    collateralDropBpsToReachOne: round((1 - (1 / hf)) * 10_000, 2),
    debtPriceIncreasePctToReachOne: round((hf - 1) * 100, 6),
    debtPriceIncreaseBpsToReachOne: round((hf - 1) * 10_000, 2),
    combinedCondition: `collateralPriceMultiplier / debtPriceMultiplier < ${round(1 / hf, 12)}`,
  };
}

async function readOracleReserve(provider, oracle, reserve) {
  const reserveId = Number(reserve?.reserveId);
  if (!Number.isFinite(reserveId)) return { error: "reserve id unavailable" };
  const [decimalsCall, spokeCall, sourceCall, priceCall] = await Promise.all([
    callDecoded(provider, oracle, AAVE_ORACLE_VIEWS, "decimals"),
    callDecoded(provider, oracle, AAVE_ORACLE_VIEWS, "spoke"),
    callDecoded(provider, oracle, AAVE_ORACLE_VIEWS, "getReserveSource", [reserveId]),
    callDecoded(provider, oracle, AAVE_ORACLE_VIEWS, "getReservePrice", [reserveId]),
  ]);
  const decimals = resultNumber(decimalsCall);
  const priceRaw = priceCall.ok ? priceCall.value : null;
  let price = null;
  if (priceRaw !== null && decimals !== null) {
    try { price = Number(ethers.formatUnits(priceRaw, decimals)); } catch (_) { price = null; }
  }
  return {
    reserveId,
    symbol: reserve?.symbol || null,
    token: normalizeAddress(reserve?.address) || null,
    oracle,
    oracleSpoke: resultAddress(spokeCall),
    oracleDecimals: decimals,
    source: resultAddress(sourceCall),
    priceRaw,
    price: Number.isFinite(price) ? price : null,
    artifactPrice: asNumber(reserve?.oracleData?.price) ?? asNumber(reserve?.priceUsd),
    artifactReferencePriceUsd: asNumber(reserve?.oracleData?.referencePriceUsd) ?? asNumber(reserve?.priceUsd),
    artifactPriceVsReferenceBps: asNumber(reserve?.oracleData?.priceVsReferenceBps),
  };
}

function sourceInfluenceVerdict(reserves) {
  const permissionlessRows = reserves.filter((row) => row.sourceProbe?.manipulability?.permissionlessLikely);
  if (permissionlessRows.length) {
    return {
      permissionlessOracleInfluence: true,
      verdict: "oracle-influence-needs-fork-proof",
      reason: "At least one reserve source has a DEX/TWAP or unauthenticated-looking price-update surface. This needs a fork proof before any executor work.",
    };
  }
  const unknownRows = reserves.filter((row) => row.sourceProbe?.classification?.kind === "unknown-source");
  if (unknownRows.length) {
    return {
      permissionlessOracleInfluence: false,
      verdict: "no-permissionless-oracle-influence-identified-unknown-source-present",
      reason: "No DEX/TWAP or permissionless price-update surface was identified, but at least one source is not fully classified by read-only ABI calls.",
    };
  }
  return {
    permissionlessOracleInfluence: false,
    verdict: "conditional-only-no-current-oracle-influence",
    reason: "Both target reserve sources are Chainlink/AggregatorV3-compatible or admin-controlled sources with no permissionless DEX/TWAP influence identified.",
  };
}

async function main() {
  const target = chooseTarget();
  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) throw new Error("No Ethereum RPC endpoint resolved from local inventory");
  const provider = new ethers.JsonRpcProvider(rpc, { chainId: CHAIN_ID, name: "ethereum" }, { staticNetwork: true });
  const [blockNumber, block] = await Promise.all([provider.getBlockNumber(), provider.getBlock("latest")]);
  const blockTimestamp = Number(block?.timestamp || 0);

  if (target.error) {
    const out = {
      generatedAt: new Date().toISOString(),
      scanner: "tools/probe-aave-v4-oracle-influence.js",
      safety: { rpcInventoryRead: true, rpcUrlsStored: false, signedActions: false, exploitExecuteCalls: false, routePositive: false, executableNow: false, signedActionJustified: false },
      error: target.error,
    };
    writeArtifact(out);
    console.log(`Aave V4 oracle influence: ${target.error}`);
    return;
  }

  const oracleCall = await callDecoded(provider, target.spoke, SPOKE_VIEWS, "ORACLE");
  const oracle = resultAddress(oracleCall) || normalizeAddress(target.collateral?.oracleData?.address) || normalizeAddress(target.debt?.oracleData?.address);
  const account = decodeAccountData(await callDecoded(provider, target.spoke, SPOKE_VIEWS, "getUserAccountData", [target.user]));
  const liveHealthFactor = account?.healthFactor ?? target.healthFactor;
  const reserveInputs = [
    { role: "collateral", reserve: target.collateral },
    { role: "debt", reserve: target.debt },
  ].filter((row) => row.reserve && row.reserve.reserveId !== null && row.reserve.reserveId !== undefined);

  const oracleProbe = oracle ? await probeContract(provider, oracle, "aave-spoke-oracle", blockTimestamp) : null;
  const reserves = [];
  for (const item of reserveInputs) {
    const liveReserve = await readOracleReserve(provider, oracle, item.reserve);
    const source = liveReserve.source || normalizeAddress(item.reserve?.oracleData?.source);
    const sourceProbe = source ? await probeContract(provider, source, `${item.role}-${item.reserve?.symbol || item.reserve?.reserveId}-source`, blockTimestamp) : null;
    const [balanceOrDebtCall] = item.role === "collateral"
      ? [await callDecoded(provider, target.spoke, SPOKE_VIEWS, "getUserSuppliedAssets", [Number(item.reserve.reserveId), target.user])]
      : [await callDecoded(provider, target.spoke, SPOKE_VIEWS, "getUserTotalDebt", [Number(item.reserve.reserveId), target.user])];
    reserves.push({
      role: item.role,
      reserveId: Number(item.reserve.reserveId),
      symbol: item.reserve.symbol || null,
      token: normalizeAddress(item.reserve.address) || null,
      userAmountRaw: balanceOrDebtCall.ok ? balanceOrDebtCall.value : null,
      artifact: {
        suppliedUsd: asNumber(item.reserve.suppliedUsd),
        debtUsd: asNumber(item.reserve.debtUsd) ?? asNumber(item.reserve.amountUsd),
        oracleData: item.reserve.oracleData || null,
        dynamicConfig: item.reserve.dynamicConfig || null,
      },
      liveOracle: liveReserve,
      sourceProbe,
    });
  }

  const influence = sourceInfluenceVerdict(reserves);
  const requirements = priceMoveRequirements(liveHealthFactor);
  const liquidatableNow = Number.isFinite(liveHealthFactor) && liveHealthFactor < 1;
  const executableNow = Boolean(liquidatableNow && influence.permissionlessOracleInfluence);
  const routePositive = executableNow ? 1 : 0;
  const blocker = liquidatableNow
    ? influence.permissionlessOracleInfluence
      ? "Oracle influence needs fork proof before any route-positive classification."
      : "Borrower is liquidatable but no permissionless oracle influence path is identified by this probe."
    : influence.permissionlessOracleInfluence
      ? "Borrower is still above HF 1.0; manipulation route must be fork-proven before executor work."
      : "Borrower is above HF 1.0 and no permissionless oracle influence path was identified. Stable-pair liquidation remains conditional-only.";

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/probe-aave-v4-oracle-influence.js",
    scope: "Read-only Aave V4 frxUSD/USDC oracle influence proof gate",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive > 0,
      executableNow,
      signedActionJustified: false,
    },
    sourceArtifacts: {
      borrowers: path.relative(WORKSPACE, BORROWERS_FILE),
      watch: path.relative(WORKSPACE, WATCH_FILE),
      stablePairRouteProbe: path.relative(WORKSPACE, STABLE_PAIR_FILE),
    },
    chain: { id: CHAIN_ID, name: "Ethereum", blockNumber, timestamp: blockTimestamp },
    target: {
      user: target.user,
      spoke: target.spoke,
      hub: target.hub,
      hubAddress: target.hubAddress,
      oracle,
      healthFactor: round(liveHealthFactor, 12),
      bpsToLiquidation: Number.isFinite(liveHealthFactor) ? round(Math.max(0, liveHealthFactor - 1) * 10_000, 2) : target.bpsToLiquidation,
      liquidatableNow,
    },
    oracle: oracleProbe,
    reserves,
    requiredOracleMove: requirements,
    summary: {
      verdict: influence.verdict,
      permissionlessOracleInfluence: influence.permissionlessOracleInfluence,
      routePositive,
      executableNow: executableNow ? 1 : 0,
      signedActionJustified: false,
      borrowerLiquidatableNow: liquidatableNow,
      collateralDropBpsToLiquidation: requirements?.collateralDropBpsToReachOne ?? null,
      debtPriceIncreaseBpsToLiquidation: requirements?.debtPriceIncreaseBpsToReachOne ?? null,
      blocker,
      reason: influence.reason,
      nextReadOnlyStep: influence.permissionlessOracleInfluence
        ? "Fork-proof oracle movement plus liquidation plus exact USDC/frxUSD route before any executor work."
        : "Demote Aave V4 stable-pair branch to conditional-only; keep watcher but do not build executor unless HF < 1 or a new permissionless oracle path is proven.",
    },
    gates: {
      routePositiveRequires: [
        "borrower HF < 1 or fork-proven same-transaction oracle influence that pushes HF < 1",
        "permissionless oracle influence, not admin/governance/Chainlink operator control",
        "exact repay-token acquisition and collateral-exit route positive after gas/slippage",
        "fork liquidation proof without state overrides",
      ],
    },
  };
  writeArtifact(out);
  console.log(`Aave V4 oracle influence: verdict=${out.summary.verdict} HF=${out.target.healthFactor} move=${out.summary.collateralDropBpsToLiquidation}bps routePositive=${out.summary.routePositive}`);
  console.log(`Report: ${path.relative(WORKSPACE, OUT)}`);
}

main().catch((e) => {
  console.error(`probe-aave-v4-oracle-influence failed: ${e?.message || String(e)}`);
  process.exitCode = 1;
});
