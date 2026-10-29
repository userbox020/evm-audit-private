#!/usr/bin/env node
// scan-dex-hook-callback-cfg.js
//
// Artifact-only CFG enrichment for DEX hook callback candidates.
// Ingests prior scan rows and augments with Uniswap V4 inventory,
// ERC4626 overlap, Balancer V3 pools, PancakeSwap Infinity pools,
// and fake-asset static context.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const QUIET = process.argv.includes("--quiet");

const INPUT_PRIOR = path.join(WORKSPACE, "reports", "raw", "fast", "dex-hook-callback-abuse.json");
const INPUT_V4 = path.join(WORKSPACE, "reports", "raw", "fast", "uniswap-v4-hooks.json");
const INPUT_ERC4626 = path.join(WORKSPACE, "reports", "raw", "fast", "erc4626-v4-hook-overlaps.json");
const INPUT_BALANCER = path.join(WORKSPACE, "reports", "raw", "fast", "balancer-v3-phase0.json");
const INPUT_PANCAKE = path.join(WORKSPACE, "reports", "raw", "fast", "pancakeswap-infinity-phase0.json");
const INPUT_FAKE = path.join(WORKSPACE, "reports", "raw", "fast", "fake-asset-pool-validation.json");
const INPUT_FAKE_CRIT = path.join(WORKSPACE, "reports", "raw", "fast", "critical-fake-asset-deployed-value-review.json");

const OUTPUT = path.join(WORKSPACE, "reports", "raw", "fast", "dex-hook-callback-cfg.json");
const OUTPUT_TRIAGE = path.join(WORKSPACE, "reports", "dex-hook-callback-cfg-triage.md");

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const SELECTOR_GROUPS = {
  erc4626ShareFlow: new Set([
    "6e553f65", // deposit(uint256,address)
    "b460af94", // mint(uint256,address)
    "94bf804d", // withdraw(uint256,address,address)
    "ba087652", // redeem(uint256,address,address)
  ]),
  lendingCore: new Set([
    // Aave V3 Pool
    "617ba037", // supply(address,uint256,address,uint16)
    "e8eda9df", // supplyWithPermit
    "c5ebeaec", // borrow(address,uint256,uint256,uint16,address)
    "573ade81", // repay(address,uint256,uint256,address)
    "69328dec", // withdraw(address,uint256,address)
    "5cffe9de", // flashLoanSimple
    "ab9c4b5d", // flashLoan
    "a415bcad", // setUserUseReserveAsCollateral
    // Compound-like
    "f2b9fdb8", // supplyTo
    "c37f68e2", // borrow
    "0e752702", // repayBorrow
    "db006a75", // redeem
    // Morpho Blue
    "238d6579", // supply
    "a99aad89", // repay
    "50d8cd4b", // borrow
    "7c3a00fd", // withdraw
    "f3fef3a3", // supplyCollateral
    "872fdd02", // withdrawCollateral
  ]),
  bridge: new Set([
    "8b477adb", // bridge/send
    "9b3b0de5", // relay/execute
    "0b6d125f", // crossChain
  ]),
  erc20Only: new Set([
    "a9059cbb", // transfer
    "23b872dd", // transferFrom
    "095ea7b3", // approve
    "dd62ed3e", // allowance
    "18160ddd", // totalSupply
    "70a08231", // balanceOf
    "06fdde03", // name
    "95d89b41", // symbol
    "313ce567", // decimals
  ]),
};

const SELECTOR_SIGNATURES = {
  erc4626ShareFlow: {
    "6e553f65": "deposit",
    "b460af94": "mint",
    "94bf804d": "withdraw",
    "ba087652": "redeem",
  },
  lendingCore: {
    "617ba037": "AaveV3.supply",
    "e8eda9df": "AaveV3.supplyWithPermit",
    "c5ebeaec": "AaveV3.borrow",
    "573ade81": "AaveV3.repay",
    "69328dec": "AaveV3.withdraw",
    "5cffe9de": "AaveV3.flashLoanSimple",
    "ab9c4b5d": "AaveV3.flashLoan",
    "a415bcad": "AaveV3.setUserUseReserveAsCollateral",
    "f2b9fdb8": "Compound.supplyTo",
    "c37f68e2": "Compound.borrow",
    "0e752702": "Compound.repayBorrow",
    "db006a75": "Compound.redeem",
    "238d6579": "Morpho.supply",
    "a99aad89": "Morpho.repay",
    "50d8cd4b": "Morpho.borrow",
    "7c3a00fd": "Morpho.withdraw",
    "f3fef3a3": "Morpho.supplyCollateral",
    "872fdd02": "Morpho.withdrawCollateral",
  },
  bridge: {
    "8b477adb": "bridge/send",
    "9b3b0de5": "bridge/execute",
    "0b6d125f": "bridge/crossChain",
  },
  erc20Only: {
    "a9059cbb": "ERC20.transfer",
    "23b872dd": "ERC20.transferFrom",
    "095ea7b3": "ERC20.approve",
    "dd62ed3e": "ERC20.allowance",
    "18160ddd": "ERC20.totalSupply",
    "70a08231": "ERC20.balanceOf",
    "06fdde03": "ERC20.name",
    "95d89b41": "ERC20.symbol",
    "313ce567": "ERC20.decimals",
  },
};

const CALLBACK_MARKERS = [
  "beforeInitialize",
  "afterInitialize",
  "beforeAddLiquidity",
  "afterAddLiquidity",
  "beforeRemoveLiquidity",
  "afterRemoveLiquidity",
  "beforeSwap",
  "afterSwap",
  "beforeDonate",
  "afterDonate",
  "dynamicFee",
];

function logInfo(...args) {
  if (!QUIET) {
    console.log(...args);
  }
}

function normalizeAddress(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed.startsWith("0x") || trimmed.length !== 42) return null;
  return trimmed;
}

function normalizeChainName(v) {
  if (!v) return "unknown";
  if (typeof v !== "string") return String(v);
  if (v.toLowerCase() === "ethereum") return "Ethereum";
  if (v.toLowerCase() === "binance") return "BNB Chain";
  return v
    .split(/[-_\s]+/)
    .map((x) => x.charAt(0).toUpperCase() + x.slice(1))
    .join(" ");
}

function chainNameFromId(chainId) {
  const map = {
    1: "Ethereum",
    10: "Optimism",
    56: "BNB Chain",
    42161: "Arbitrum",
    43114: "Avalanche",
    8453: "Base",
    100: "Gnosis",
  };
  return map[chainId] || `Chain ${chainId}`;
}

function toInt(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toNumber(v, fallback = 0) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function uniqueStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    if (!item) continue;
    const k = String(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

function normalizeSelector(input) {
  if (!input || typeof input !== "string") return null;
  const t = input.trim().toLowerCase();
  return t.startsWith("0x") ? t.slice(2) : t;
}

function loadJson(filePath, warnBag, optionalLabel) {
  try {
    if (!fs.existsSync(filePath)) {
      if (warnBag) warnBag.push(`Missing source artifact: ${path.relative(WORKSPACE, filePath)}`);
      return null;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw || !raw.trim()) {
      if (warnBag) warnBag.push(`Empty source artifact: ${path.relative(WORKSPACE, filePath)}`);
      return null;
    }

    return JSON.parse(raw);
  } catch (err) {
    const label = optionalLabel || path.relative(WORKSPACE, filePath);
    if (warnBag) {
      warnBag.push(`Failed to parse ${label}: ${err.message}`);
    }
    return null;
  }
}

function classifySelectors(selectors) {
  const normalized = uniqueStrings(
    safeArray(selectors).map((s) => normalizeSelector(s)).filter((s) => !!s && s.length === 8),
  );

  const selectorClasses = [];
  const externalValueSelectorClasses = [];
  const byClass = {
    erc4626ShareFlow: [],
    lendingCore: [],
    bridge: [],
    erc20Only: [],
    other: [],
  };

  const addClass = (cls, sel) => {
    if (!selectorClasses.includes(cls)) selectorClasses.push(cls);
    byClass[cls].push(sel);

    if (cls !== "erc20Only" && cls !== "other" && !externalValueSelectorClasses.includes(cls)) {
      externalValueSelectorClasses.push(cls);
    }
  };

  for (const sel of normalized) {
    let hit = false;
    for (const [cls, set] of Object.entries(SELECTOR_GROUPS)) {
      if (set.has(sel)) {
        addClass(cls, sel);
        hit = true;
      }
    }
    if (!hit) {
      addClass("other", sel);
      if (!selectorClasses.includes("other")) selectorClasses.push("other");
    }
  }

  // Keep only meaningful classes for CFG value flow.
  const primary = selectorClasses.filter((c) => c !== "other");

  const selectorNames = {};
  for (const cls of Object.keys(SELECTOR_SIGNATURES)) {
    selectorNames[cls] = byClass[cls].map((sel) => SELECTOR_SIGNATURES[cls][sel] || sel);
  }

  return {
    selectorList: normalized,
    selectorClasses: uniqueStrings(primary),
    externalValueSelectorClasses: uniqueStrings(externalValueSelectorClasses),
    byClass,
    selectorNames,
  };
}

function isZeroAddress(address) {
  return normalizeAddress(address) === ZERO_ADDR;
}

function buildUniswapIndex(v4) {
  const map = new Map();
  if (!v4 || typeof v4 !== "object") return map;

  for (const [chainKey, chainData] of Object.entries(v4)) {
    if (!chainData || typeof chainData !== "object") continue;
    const chainId = toInt(chainData.chainId);
    if (!chainId) continue;
    const chain = normalizeChainName(chainKey);
    const poolManager = chainData.poolManager || null;
    const block = chainData.block || null;
    for (const h of safeArray(chainData.hooks)) {
      const addr = normalizeAddress(h.address);
      if (!addr) continue;
      const key = `${chainId}:${addr}`;
      map.set(key, {
        chainId,
        chain,
        hookAddress: addr,
        flags: h.flags ?? null,
        enabledFlags: uniqueStrings(safeArray(h.enabledFlags).map((x) => String(x))),
        poolCount: h.poolCount ?? null,
        samplePoolIds: uniqueStrings(safeArray(h.samplePoolIds).map((x) => String(x))).slice(0, 12),
        poolManager: normalizeAddress(poolManager),
        block,
      });
    }
  }

  return map;
}

function buildBalancerIndex(balancer) {
  const map = new Map();
  if (!balancer || typeof balancer !== "object") return map;

  for (const row of safeArray(balancer.poolRows)) {
    const chainId = toInt(row.chainId);
    const hook = row.hook || {};
    const hookAddress = normalizeAddress(hook.address);
    if (!chainId || !hookAddress) continue;

    const key = `${chainId}:${hookAddress}`;
    const prev = map.get(key) || {
      chainId,
      chain: row.chain || chainNameFromId(chainId),
      hookAddress,
      hookType: hook.type || null,
      poolRows: [],
      tvlSamples: [],
      tokenSymbols: [],
      swapEnabledSamples: [],
      liquidityManagement: null,
      hasErc4626: false,
      routePoolCount: 0,
    };

    prev.routePoolCount += 1;
    prev.poolRows.push(row.pool || null);
    prev.tvlSamples.push(toNumber(row.totalLiquidityUsd, 0));

    if (row.tokenSymbols) prev.tokenSymbols.push(String(row.tokenSymbols));
    if (typeof row.swapEnabled === "boolean") prev.swapEnabledSamples.push(row.swapEnabled);
    if (row.liquidityManagement && typeof row.liquidityManagement === "object") {
      prev.liquidityManagement = row.liquidityManagement;
    }
    if (row.hasErc4626 === true) prev.hasErc4626 = true;
    if (hook.type) prev.hookType = hook.type;

    map.set(key, prev);
  }

  return map;
}

function buildErc4626Index(erxFile) {
  const map = new Map();
  if (!erxFile || typeof erxFile !== "object") return map;

  const rows = safeArray(erxFile.rows);
  for (const row of rows) {
    const chainId = toInt(row.chainId);
    const analysis = row.analysis || {};
    const hooks = uniqueStrings(safeArray(analysis.actualHookAddresses).map((x) => normalizeAddress(x)).filter(Boolean));
    if (!chainId || hooks.length === 0) continue;

    const evidence = {
      chainId,
      chain: row.chain || chainNameFromId(chainId),
      vault: normalizeAddress(row.vault),
      hookFlags: row.hook?.flags || null,
      hookEnabledFlags: uniqueStrings(safeArray(row.hook?.enabledFlags).map((x) => String(x))),
      currenciesIncludeVault: !!analysis.currenciesIncludeVault,
      currenciesIncludeAsset: !!analysis.currenciesIncludeAsset,
      vaultIsActualHook: !!analysis.vaultIsActualHook,
      artifactLikelyCurrencyMisclassifiedAsHook: !!(analysis.artifactLikelyCurrencyMisclassifiedAsHook || analysis.artifactLikelyCurrencyMisclassification),
      recentSwaps: toInt(analysis.recentSwaps),
      recentDonates: toInt(analysis.recentDonates),
      initializePools: safeArray(row.pools).map((p) => {
        const initLog = Array.isArray(p.initializeLogs) && p.initializeLogs.length > 0 ? p.initializeLogs[p.initializeLogs.length - 1] : null;
        return {
          poolId: p.poolId || null,
          initializeLogCount: safeArray(p.initializeLogs).length,
          recentSwaps: toInt(p.recentSwaps),
          recentDonates: toInt(p.recentDonates),
          initializeLookupBlocks: p.initializeLookupBlocks || null,
          sampleLog: initLog,
        };
      }),
      erc4626: row.erc4626 || null,
      blockers: safeArray(analysis.blockers),
      routePositive: !!analysis.routePositive,
      signedActionJustified: !!analysis.signedActionJustified,
      source: {
        sources: safeArray(row.sources),
        inventoryFlag: row.inventory || null,
      },
    };

    for (const addr of hooks) {
      const key = `${chainId}:${addr}`;
      const arr = map.get(key) || [];
      arr.push(evidence);
      map.set(key, arr);
    }
  }

  // Keep most relevant evidence per hook-key for scoring and human readability.
  const pruned = new Map();
  for (const [key, list] of map.entries()) {
    if (!Array.isArray(list) || list.length === 0) continue;
    const sorted = list.slice().sort((a, b) => {
      if (a.vaultIsActualHook !== b.vaultIsActualHook) return Number(b.vaultIsActualHook) - Number(a.vaultIsActualHook);
      const aScore = toNumber(a.erc4626?.totalAssets, 0) + 0.25 * toInt(a.recentSwaps || 0) + 0.1 * toInt(a.recentDonates || 0);
      const bScore = toNumber(b.erc4626?.totalAssets, 0) + 0.25 * toInt(b.recentSwaps || 0) + 0.1 * toInt(b.recentDonates || 0);
      return bScore - aScore;
    });
    pruned.set(key, sorted);
  }

  return pruned;
}

function buildPancakeIndex(pancake, warnings) {
  const map = new Map();
  if (!pancake || typeof pancake !== "object") return map;

  const rows = safeArray(pancake.poolRows);
  for (const row of rows) {
    const chainId = toInt(row.chainId);
    const hookAddress = normalizeAddress(row.hook);
    if (!chainId || !hookAddress || isZeroAddress(hookAddress)) continue;

    const key = `${chainId}:${hookAddress}`;
    const prev = map.get(key) || {
      chainId,
      chain: row.chain || chainNameFromId(chainId),
      hookAddress,
      poolCount: 0,
      hookCodePresentCount: 0,
      poolIds: [],
      maxCurrencyBalanceUsd: 0,
      tokenContext: new Set(),
      routeRows: 0,
    };

    prev.poolCount += 1;
    prev.routeRows += 1;
    if (row.hookCodePresent === true) prev.hookCodePresentCount += 1;
    if (typeof row.maxCurrencyBalanceUsd === "number" && Number.isFinite(row.maxCurrencyBalanceUsd)) {
      prev.maxCurrencyBalanceUsd = Math.max(prev.maxCurrencyBalanceUsd, row.maxCurrencyBalanceUsd);
    }
    if (row.poolId) {
      if (prev.poolIds.length < 25) prev.poolIds.push(String(row.poolId));
    }
    if (row.currency0Symbol) prev.tokenContext.add(String(row.currency0Symbol));
    if (row.currency1Symbol) prev.tokenContext.add(String(row.currency1Symbol));

    map.set(key, prev);
  }

  if (warnings && map.size === 0 && !Array.isArray(pancake.poolRows) && !Array.isArray(pancake.contractRows)) {
    warnings.push("Pancake Scan artifact had no parsed rows; skipping pool-based enrichment");
  }

  return map;
}

function buildFakeAssetContext(fake, fakeCrit) {
  const context = {
    available: false,
    summary: {
      validationRows: 0,
      routePositive: 0,
      executableAggregateRows: 0,
      deployedAcceptanceRows: 0,
      staticRows: 0,
      targetRows: 0,
      summaryBlocker: null,
    },
    targetReviews: [],
    blockers: [],
    hasInitializeOrUnlockStaticRows: false,
    routePositive: false,
    deployedAcceptance: false,
    attackerPoolCreationReachability: "unknown",
    fakeAssetReachability: "unknown",
  };

  if (fake && typeof fake === "object") {
    const s = fake.summary || fake;
    context.available = true;
    context.summary.validationRows = toInt(s.validationRows) || toInt(s.rows) || 0;
    context.summary.routePositive = toInt(s.routePositive || 0);
    context.summary.executableAggregateRows = toInt(s.executableAggregateRows || s.executableNow || 0);
    context.summary.deployedAcceptanceRows = toInt(s.deployedAcceptanceRows || 0);
    context.summary.staticRows = toInt(s.staticSourceRows || s.staticRows || s.staticSourceRows || 0);
    context.summary.targetRows = toInt(s.targetRowsReviewed || 0);
    context.summary.summaryBlocker = s.blocker || null;
  }

  function absorbStaticRows(targetName, rows, blockers = []) {
    const topSourceRows = safeArray(rows).map((r) => ({
      function: r.function || null,
      file: r.file || null,
      line: r.line || null,
      surfaces: safeArray(r.surfaceKinds || r.surfaces),
      missingValidation: safeArray(r.missingValidation),
      blocker: r.blocker || null,
    }));

    const targetLower = String(targetName || "").toLowerCase();
    const isHookTarget = /cork|uniswap|hook|v4/.test(targetLower);
    for (const r of topSourceRows) {
      const fn = String(r.function || "").toLowerCase();
      const file = String(r.file || "").toLowerCase();
      if (isHookTarget && (fn === "initialize" || fn === "unlock" || file.includes("poolmanager.sol"))) {
        context.hasInitializeOrUnlockStaticRows = true;
      }
      if (r.blocker) context.blockers.push(r.blocker);
      for (const mv of r.missingValidation) context.blockers.push(String(mv));
    }

    if (targetName || topSourceRows.length || blockers.length) {
      context.targetReviews.push({
        target: targetName || null,
        blockers: uniqueStrings(safeArray(blockers).concat(topSourceRows.map((r) => r.blocker).filter(Boolean)).map(String)),
        topSourceRows: topSourceRows.slice(0, 8),
      });
    }
  }

  if (fake && Array.isArray(fake.topRows)) {
    absorbStaticRows("topRows", fake.topRows, []);
  }
  if (fake && Array.isArray(fake.sourceTargets)) {
    context.summary.targetRows = Math.max(context.summary.targetRows || 0, fake.sourceTargets.length);
    for (const target of fake.sourceTargets) {
      const rows = safeArray(target.topRows);
      const blockers = [];
      if (target.blocker) blockers.push(target.blocker);
      absorbStaticRows(target.name || target.target || null, rows, blockers);
    }
  }
  if (fake && Array.isArray(fake.targetReviews)) {
    for (const tr of fake.targetReviews) {
      absorbStaticRows(tr.target || null, tr.topSourceRows, tr.blockers);
      if (Array.isArray(tr.blockers) && tr.blockers.length > 0) {
        context.blockers.push(...tr.blockers);
      }
    }
  }

  if (fakeCrit && Array.isArray(fakeCrit.targetReviews)) {
    for (const tr of fakeCrit.targetReviews) {
      context.targetReviews.push({
        target: tr.target || null,
        blockers: uniqueStrings(safeArray(tr.blockers).map(String)),
      });
      if (Array.isArray(tr.blockers) && tr.blockers.length > 0) context.blockers.push(...tr.blockers);
    }
  }

  if (context.summary.summaryBlocker) {
    context.blockers.unshift(context.summary.summaryBlocker);
  }

  context.blockers = uniqueStrings(context.blockers);

  if (context.summary.deployedAcceptanceRows > 0) {
    context.deployedAcceptance = true;
  }
  context.routePositive = context.summary.routePositive > 0;
  if (context.hasInitializeOrUnlockStaticRows) {
    context.attackerPoolCreationReachability = "static-only-unproven";
    context.fakeAssetReachability = "static-only-unproven";
  }

  return context;
}

function makeRouteGateBlockers(callFlow, overlapEvidence) {
  const blockers = [];

  if (!callFlow.callbackEntrypoints || callFlow.callbackEntrypoints.length === 0 || callFlow.callbackEntrypoints.includes("unknown")) {
    blockers.push("No callback entrypoint inventory binding in artifacts");
  }

  if (callFlow.externalCallCapability !== "present") {
    blockers.push("External-call opcode evidence missing or unknown");
  }

  if (!callFlow.msgSenderGateProof || callFlow.msgSenderGateProof === "unknown") {
    blockers.push("msg.sender/callback-gating proof absent in local artifacts");
  }

  blockers.push("No permissionless callback/permission model proof in local artifacts");

  if (callFlow.externalValueSelectorClasses.length === 0) {
    blockers.push("No selector-only external value flow evidence");
  } else {
    blockers.push("Selectors only; no deployed value-moving target proof");
  }

  if (overlapEvidence && callFlow.deployedValuePath === "selector-only-unproven") {
    blockers.push("ERC4626 overlap proves pool/currency context, not an extractable deployed target");
  }

  blockers.push("No exact-positive economics proof in artifacts");
  blockers.push("No fork/local proof of extraction path");

  if (callFlow.fakeAssetReachability === "blocked") {
    blockers.push("Fake-asset route context shows no attacker-created asset acceptance evidence");
  }

  return uniqueStrings(blockers);
}

function buildCallFlowEdges(callbackEntrypoints, selectorInfo) {
  const edges = [];

  if (Array.isArray(callbackEntrypoints)) {
    for (const ep of callbackEntrypoints) {
      if (!ep || ep === "unknown") continue;
      edges.push(`PoolManager -> hook.${ep}`);
    }
  }

  const byClass = selectorInfo?.byClass || {};
  const names = selectorInfo?.selectorNames || {};

  for (const cls of ["erc4626ShareFlow", "lendingCore", "bridge"]) {
    const sels = uniqueStrings(byClass[cls] || []);
    if (sels.length === 0) continue;
    const human = uniqueStrings(sels.map((s) => names[cls]?.[s] || s)).join(", ");
    edges.push(`hook bytecode -> ${cls} selectors [${human}] [selector-only]`);
  }

  if (edges.length === 0) {
    edges.push("No robust callback or value-flow edge proven locally");
  }

  return edges;
}

function hasCallbackBoundMarker(callbackEntrypoints = []) {
  if (!Array.isArray(callbackEntrypoints)) return false;
  return callbackEntrypoints.some((x) => CALLBACK_MARKERS.includes(x));
}

function buildCfgRow(base, enrichment, fakeContext) {
  const { uniswap, erc4626Overlap, balancer, pancake } = enrichment;
  const chain = base.chain || (uniswap ? uniswap.chain : chainNameFromId(base.chainId));

  let callbackEntrypoints = [];
  let poolManagerBinding = "unknown";

  if (uniswap && uniqueStrings(uniswap.enabledFlags).length > 0) {
    callbackEntrypoints = uniqueStrings(uniswap.enabledFlags);
    poolManagerBinding = "inventory-sample-only";
  }

  if (erc4626Overlap && Array.isArray(erc4626Overlap.hookEnabledFlags) && erc4626Overlap.hookEnabledFlags.length > 0) {
    callbackEntrypoints = callbackEntrypoints.length ? callbackEntrypoints : uniqueStrings(erc4626Overlap.hookEnabledFlags);
    if (erc4626Overlap.initializePools && erc4626Overlap.initializePools.length > 0) {
      poolManagerBinding = "proven-initialized-pool";
    }
  }

  if (balancer && balancer.hookType && poolManagerBinding === "unknown") {
    poolManagerBinding = "balancer-pool-row";
    if (callbackEntrypoints.length === 0) callbackEntrypoints = [balancer.hookType];
  }

  if (pancake && poolManagerBinding === "unknown") {
    poolManagerBinding = "infinity-pool-row";
    if (callbackEntrypoints.length === 0) callbackEntrypoints = ["infinity-pool"];
  }

  if (callbackEntrypoints.length === 0) {
    callbackEntrypoints = [base.protocol || "unknown"];
  }

  const selectorInfo = classifySelectors(uniqueStrings([...(safeArray(base.lendingSelectors)), ...(safeArray(base.erc20Selectors))]));

  const erc4626OverlapEvidence = erc4626Overlap
    ? {
        currenciesIncludeVault: erc4626Overlap.currenciesIncludeVault,
        currenciesIncludeAsset: erc4626Overlap.currenciesIncludeAsset,
        vaultIsActualHook: erc4626Overlap.vaultIsActualHook,
        artifactLikelyCurrencyMisclassifiedAsHook: erc4626Overlap.artifactLikelyCurrencyMisclassifiedAsHook,
        recentSwaps: toInt(erc4626Overlap.recentSwaps),
        recentDonates: toInt(erc4626Overlap.recentDonates),
        initializePoolCount: safeArray(erc4626Overlap.initializePools).length,
        vault: erc4626Overlap.vault,
        erc4626: erc4626Overlap.erc4626
          ? {
              symbol: erc4626Overlap.erc4626.symbol || null,
              name: erc4626Overlap.erc4626.name || null,
              totalAssets: toNumber(erc4626Overlap.erc4626.totalAssets, null),
              totalSupply: toNumber(erc4626Overlap.erc4626.totalSupply, null),
              asset: erc4626Overlap.erc4626.asset || null,
              assetSymbol: erc4626Overlap.erc4626.assetMeta?.symbol || null,
              hasCode: !!erc4626Overlap.erc4626.hasCode,
              codeSize: toInt(erc4626Overlap.erc4626.codeSize),
            }
          : null,
        blockers: safeArray(erc4626Overlap.blockers).slice(0, 4),
        source: {
          chain: erc4626Overlap.chain,
          chainId: erc4626Overlap.chainId,
          sources: safeArray(erc4626Overlap.source?.sources),
        },
      }
    : null;

  const callFlowEdges = buildCallFlowEdges(callbackEntrypoints, selectorInfo);

  const deployedValuePath =
    selectorInfo.externalValueSelectorClasses.length > 0
      ? "selector-only-unproven"
      : balancer || pancake
        ? "pool-token-context-only"
        : "none";

  const isUniswapLike = !!uniswap || /uniswap|erc4626 consumer/i.test(String(base.protocol || ""));
  const fakeAssetReachability = fakeContext && isUniswapLike ? fakeContext.fakeAssetReachability : "unknown";
  const attackerPoolCreationReachability = fakeContext && isUniswapLike ? fakeContext.attackerPoolCreationReachability : "unknown";

  const callFlow = {
    callbackEntrypoints,
    poolManagerBinding,
    externalCallCapability: base.hasCallOps === true ? "present" : base.hasCallOps === false ? "absent" : "unknown",
    selectorClasses: selectorInfo.selectorClasses,
    externalValueSelectorClasses: selectorInfo.externalValueSelectorClasses,
    erc4626OverlapEvidence,
    fakeAssetReachability,
    msgSenderGateProof: fakeContext ? "unknown" : "unknown",
    attackerPoolCreationReachability,
    deployedValuePath,
    callFlowEdges,
  };

  callFlow.blockers = makeRouteGateBlockers(callFlow, erc4626OverlapEvidence);
  callFlow.routeGatePassed = false;
  callFlow.routePositionalGates = {
    callbackBound: hasCallbackBoundMarker(callbackEntrypoints),
    permissionlessCallbackProof: false,
    msgSenderGateProof: callFlow.msgSenderGateProof,
    attackerPoolCreationReachability,
    externalValueMovingSelectorEvidence: selectorInfo.externalValueSelectorClasses.length > 0,
    deployedValueMovingTargetProof: false,
    exactPositiveEconomics: false,
    forkOrLocalProof: false,
  };

  const summaryPoolTvl =
    (toNumber(base.tvlUsd) || 0) +
    toNumber(balancer && balancer.tvlMax) +
    toNumber(pancake && pancake.maxCurrencyBalanceUsd);

  const score = computeRowScore({
    uniswap,
    balancer,
    pancake,
    erc4626OverlapEvidence,
    selectorInfo,
    callbackEntrypoints,
    callFlow,
    tvlUsd: summaryPoolTvl,
  });

  return {
    protocol: base.protocol || "Unknown",
    chain,
    chainId: base.chainId,
    poolAddress: base.poolAddress || null,
    samplePoolIds: base.samplePoolIds || null,
    poolCount: base.poolCount || null,
    hookAddress: base.hookAddress,
    hookType: base.hookType || (uniswap ? "Uniswap V4 hook" : balancer?.hookType || (pancake ? "Infinity hook" : null)),
    tvlUsd: summaryPoolTvl || null,
    tokens: base.tokens || null,
    flags: uniswap?.flags || base.flags || null,
    enabledFlags: uniqueStrings((uniswap?.enabledFlags || []).concat(base.enabledFlags || [])),
    hasCode: base.hasCode ?? null,
    codeSize: toInt(base.codeSize),
    hasCallOps: base.hasCallOps ?? null,
    risk: base.risk || null,
    routePositive: false,
    riskScore: base.risk === "HIGH" ? 85 : base.risk === "MEDIUM" ? 45 : 5,
    note: base.note || null,
    callFlow,
    score,
    externalCallEvidence: {
      uniswapHookMetadata: uniswap || null,
      balancerHookContext: balancer || null,
      pancakeInfinityHookContext: pancake || null,
      selectorInfo: {
        selectors: selectorInfo.selectorList,
        selectorClasses: selectorInfo.selectorClasses,
      },
    },
    executableNow: false,
    signedActionJustified: false,
  };
}

function computeRowScore(ctx) {
  let score = 0;

  if (!ctx) return score;

  const poolBinding = ctx.callFlow?.poolManagerBinding;
  if (poolBinding === "proven-initialized-pool") score += 80;
  else if (poolBinding === "balancer-pool-row") score += 52;
  else if (poolBinding === "infinity-pool-row") score += 44;
  else if (poolBinding === "inventory-sample-only") score += 28;

  if (ctx.selectorInfo?.externalValueSelectorClasses.includes("erc4626ShareFlow")) score += 58;
  if (ctx.selectorInfo?.externalValueSelectorClasses.includes("lendingCore")) score += 36;
  if (ctx.selectorInfo?.externalValueSelectorClasses.includes("bridge")) score += 24;

  if (ctx.uniswap && ctx.uniswap.enabledFlags?.length) score += 10;
  if (ctx.balancer && ctx.balancer.routePoolCount > 0) score += 12;
  if (ctx.pancake && ctx.pancake.poolCount > 0) score += 10;

  const tvl = toNumber(ctx.tvlUsd, 0);
  if (tvl >= 1_000_000) score += 24;
  else if (tvl >= 100_000) score += 12;
  else if (tvl > 0) score += 4;

  if (ctx.erc4626OverlapEvidence) {
    score += 25;
    score += Math.min(30, toInt(ctx.erc4626OverlapEvidence.recentSwaps) * 6);
    score += Math.min(15, toInt(ctx.erc4626OverlapEvidence.recentDonates) * 4);
  }

  if (ctx.callFlow?.externalCallCapability === "present") score += 8;
  if (ctx.callFlow?.externalValueSelectorClasses?.length > 0) score += 6;
  if (ctx.callFlow?.fakeAssetReachability === "static-only-unproven") score += 3;

  if (ctx.callFlow?.msgSenderGateProof === "unknown") score -= 1;

  return score;
}

function summarizeRows(rows, topBlockedCandidates, warnings) {
  const summary = {
    rows: rows.length,
    callbackBoundRows: rows.filter((r) => r.callFlow && hasCallbackBoundMarker(r.callFlow.callbackEntrypoints)).length,
    erc4626SelectorRows: rows.filter((r) => r.callFlow?.selectorClasses?.includes("erc4626ShareFlow")).length,
    lendingCoreSelectorRows: rows.filter((r) => r.callFlow?.selectorClasses?.includes("lendingCore")).length,
    bridgeSelectorRows: rows.filter((r) => r.callFlow?.selectorClasses?.includes("bridge")).length,
    erc4626OverlapRows: rows.filter((r) => !!r.callFlow?.erc4626OverlapEvidence).length,
    fakeAssetStaticOnlyRows: rows.filter((r) => r.callFlow?.fakeAssetReachability === "static-only-unproven").length,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    topBlockedCandidates,
  };

  if (warnings && warnings.length > 0) {
    summary.warnings = warnings;
  }

  return summary;
}

function writeTriage(artifact) {
  const summary = artifact.summary || {};
  const lines = [];
  const source = artifact.sourceArtifacts || [];
  const top = artifact.topRows || [];
  const topBlocked = summary.topBlockedCandidates || [];

  lines.push("# 🟢 DORMANT - DEX Hook Callback CFG / Call-Flow Triage");
  lines.push("");
  lines.push(`Generated: ${artifact.generatedAt}`);
  lines.push(`Scanner: ${artifact.scanner}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Rows | ${summary.rows ?? 0} |`);
  lines.push(`| Callback-bound rows | ${summary.callbackBoundRows ?? 0} |`);
  lines.push(`| ERC4626 selector rows | ${summary.erc4626SelectorRows ?? 0} |`);
  lines.push(`| Lending-core selector rows | ${summary.lendingCoreSelectorRows ?? 0} |`);
  lines.push(`| Bridge selector rows | ${summary.bridgeSelectorRows ?? 0} |`);
  lines.push(`| ERC4626 overlap rows | ${summary.erc4626OverlapRows ?? 0} |`);
  lines.push(`| Fake-asset static-only rows | ${summary.fakeAssetStaticOnlyRows ?? 0} |`);
  lines.push(`| routePositive | ${summary.routePositive ?? 0} |`);
  lines.push(`| executableNow | ${summary.executableNow ?? 0} |`);
  lines.push(`| signedActionJustified | ${summary.signedActionJustified ? "true" : "false"} |`);
  lines.push("");

  lines.push("## Source artifacts");
  lines.push("");
  for (const row of source) {
    lines.push(`- \`${row}\``);
  }
  lines.push("");

  lines.push("## Fail-closed route-gate requirement");
  lines.push("");
  lines.push("Route-positive requires ALL of the following currently-missing gates:");
  lines.push("1. Callback/trigger proof (permissionless and permission model) from local sources.");
  lines.push("2. msg.sender / callback gating proof in source and/or deployed artifact.");
  lines.push("3. Attacker-controlled pool/currency creation provenance (not static-only).");
  lines.push("4. Deployed value-moving target proof (not selector-only).");
  lines.push("5. Exact positive economics and fork/local extractability proof.");
  lines.push("");
  lines.push("**All gates are currently closed; no row is route-positive.**");
  lines.push("");

  lines.push("## Top blocked candidates");
  lines.push("");
  if (!topBlocked.length) {
    lines.push("No candidates found.");
  } else {
    lines.push("| Hook | Protocol | Chain | Binding | Selector Classes | Overlap | Score | Top Blockers |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const row of topBlocked) {
      const blockers = (row.topBlockers || []).slice(0, 2).join("; ");
      lines.push(`| \`${row.hookAddress}\` | ${row.protocol} | ${row.chain} | ${row.binding} | ${row.selectorClasses} | ${row.overlap} | ${row.score} | ${blockers.replace(/\|/g, "\\|")} |`);
    }
  }
  lines.push("");

  lines.push("## Source snippets (top 10 by score)");
  lines.push("\n| Rank | Hook | Protocol | Binding | Callback Entrypoints | Deployed Value Path |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  top.slice(0, 10).forEach((r, i) => {
    const cbs = (r.callFlow?.callbackEntrypoints || []).join(", ");
    lines.push(`| ${i + 1} | \`${r.hookAddress}\` | ${r.protocol} | ${r.callFlow?.poolManagerBinding || "unknown"} | ${cbs || "unknown"} | ${r.callFlow?.deployedValuePath || "none"} |`);
  });

  lines.push("");
  lines.push("## Top call-flow edge patterns");
  lines.push("");
  top.slice(0, 5).forEach((r) => {
    lines.push(`### ${r.hookAddress}`);
    const edges = safeArray(r.callFlow?.callFlowEdges);
    if (edges.length) {
      lines.push("- " + edges.slice(0, 5).join("<br/>- "));
    } else {
      lines.push("- No proven edges");
    }
    lines.push("");
  });

  lines.push("## Next steps");
  lines.push("");
  lines.push("- Source-review `fakeAsset` route blockers and fake-asset static summaries for any hard gate violations.");
  lines.push("- For rows with ERC4626/lending selectors, add precise PoolManager callback permission proof plus exact positive economics.");
  lines.push("- If gate-relevant selectors are present, add fork or local static-call proof before considering execution claims.");

  if (artifact.fakeAssetContext?.blockers?.length) {
    lines.push("");
    lines.push("### Fake-asset artifact context");
    lines.push("");
    const blockers = artifact.fakeAssetContext.blockers.slice(0, 14);
    for (const b of blockers) {
      lines.push(`- ${b}`);
    }
    const omitted = artifact.fakeAssetContext.blockers.length - blockers.length;
    if (omitted > 0) lines.push(`- ... ${omitted} additional artifact blockers omitted from this concise report`);
  }

  if (artifact.warnings && artifact.warnings.length) {
    lines.push("");
    lines.push("### Warnings");
    lines.push("");
    for (const w of artifact.warnings) {
      lines.push(`- ${w}`);
    }
  }

  fs.mkdirSync(path.dirname(OUTPUT_TRIAGE), { recursive: true });
  fs.writeFileSync(OUTPUT_TRIAGE, lines.join("\n") + "\n");
}

function main() {
  const start = Date.now();
  const warnings = [];

  const prior = loadJson(INPUT_PRIOR, warnings, "dex-hook-callback-abuse.json");
  const priorRows = Array.isArray(prior?.allRows) && prior.allRows.length > 0 ? prior.allRows : Array.isArray(prior?.topRows) ? prior.topRows : [];

  if (!Array.isArray(priorRows) || priorRows.length === 0) {
    throw new Error("No prior rows found in reports/raw/fast/dex-hook-callback-abuse.json");
  }

  const uniswapData = loadJson(INPUT_V4, warnings, "uniswap-v4-hooks.json");
  const balancerData = loadJson(INPUT_BALANCER, warnings, "balancer-v3-phase0.json");
  const fakeData = loadJson(INPUT_FAKE, warnings, "fake-asset-pool-validation.json");
  const fakeCritData = loadJson(INPUT_FAKE_CRIT, warnings, "critical-fake-asset-deployed-value-review.json");
  const fakeContext = buildFakeAssetContext(fakeData, fakeCritData);

  const v4Index = buildUniswapIndex(uniswapData);
  const balancerIndex = buildBalancerIndex(balancerData);
  const erc4626Data = loadJson(INPUT_ERC4626, warnings, "erc4626-v4-hook-overlaps.json");
  const erc4626Index = buildErc4626Index(erc4626Data);

  let pancakeIndex = new Map();
  try {
    // This artifact can be very large; fail-closed on parse failure.
    const pancakeData = loadJson(INPUT_PANCAKE, warnings, "pancakeswap-infinity-phase0.json");
    if (pancakeData) {
      pancakeIndex = buildPancakeIndex(pancakeData, warnings);
    } else {
      warnings.push("PancakeSwap Infinity artifact could not be parsed/enriched (fail-closed).\n");
    }
  } catch (err) {
    warnings.push(`PancakeSwap Infinity artifact parse fallback triggered: ${err.message}`);
    pancakeIndex = new Map();
  }

  const seen = new Set();
  const rows = [];

  for (const raw of priorRows) {
    if (!raw || typeof raw !== "object") continue;
    const chainId = toInt(raw.chainId);
    const hookAddress = normalizeAddress(raw.hookAddress || raw.hook || "");
    if (!chainId || !hookAddress) continue;

    const key = `${chainId}:${hookAddress}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const row = {
      protocol: raw.protocol || "Unknown",
      chain: raw.chain || null,
      chainId,
      hookAddress,
      poolAddress: normalizeAddress(raw.poolAddress),
      samplePoolIds: safeArray(raw.samplePoolIds).map((v) => String(v)),
      poolCount: toInt(raw.poolCount),
      hookType: raw.hookType || null,
      tvlUsd: toNumber(raw.tvlUsd, null),
      flags: raw.flags || null,
      enabledFlags: safeArray(raw.enabledFlags).map((v) => String(v)),
      tokens: typeof raw.tokens === "string" || Array.isArray(raw.tokens) ? raw.tokens : null,
      hasCode: raw.hasCode ?? null,
      codeSize: toInt(raw.codeSize),
      hasCallOps: raw.hasCallOps ?? null,
      lendingSelectors: safeArray(raw.lendingSelectors).map(String),
      erc20Selectors: safeArray(raw.erc20Selectors).map(String),
      risk: raw.risk || "unknown",
      note: raw.note || null,
    };

    const enrichment = {
      uniswap: v4Index.get(key),
      balancer: balancerIndex.get(key),
      erc4626Overlap: erc4626Index.get(key) ? erc4626Index.get(key)[0] : null,
      pancake: pancakeIndex.get(key),
    };

    rows.push(buildCfgRow(row, enrichment, fakeContext));
  }

  const scored = rows
    .sort((a, b) => {
      if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
      const aTvl = toNumber(a.tvlUsd, 0);
      const bTvl = toNumber(b.tvlUsd, 0);
      if (bTvl !== aTvl) return bTvl - aTvl;
      return (b.callFlow?.externalValueSelectorClasses?.length || 0) - (a.callFlow?.externalValueSelectorClasses?.length || 0);
    });

  const topBlockedCandidates = scored.slice(0, 10).map((r) => ({
    hookAddress: r.hookAddress,
    protocol: r.protocol,
    chain: r.chain,
    binding: r.callFlow?.poolManagerBinding || "unknown",
    selectorClasses: (r.callFlow?.selectorClasses || []).join(", ") || "none",
    overlap: r.callFlow?.erc4626OverlapEvidence ? "yes" : "no",
    score: r.score,
    topBlockers: (r.callFlow?.blockers || []).slice(0, 3),
  }));

  const summary = summarizeRows(scored, topBlockedCandidates, warnings);

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: path.relative(WORKSPACE, path.join(__dirname, path.basename(__filename))).replace(/\\/g, "/"),
    scope: "Artifact-only DEX hook callback CFG enrichment; no RPC/env calls",
    safety: {
      artifactOnly: true,
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    sourceArtifacts: [
      "reports/raw/fast/dex-hook-callback-abuse.json",
      "reports/raw/fast/uniswap-v4-hooks.json",
      "reports/raw/fast/erc4626-v4-hook-overlaps.json",
      "reports/raw/fast/balancer-v3-phase0.json",
      "reports/raw/fast/pancakeswap-infinity-phase0.json",
      "reports/raw/fast/fake-asset-pool-validation.json",
      "reports/raw/fast/critical-fake-asset-deployed-value-review.json",
    ],
    sourceArtifactsParsed: {
      uniswapV4Hooks: !!uniswapData,
      erc4626Overlaps: !!erc4626Data,
      balancer: !!balancerData,
      pancake: pancakeIndex.size > 0,
      fakeAssetValidation: !!fakeData,
      fakeAssetCritical: !!fakeCritData,
    },
    fakeAssetContext: {
      available: fakeContext.available,
      summary: fakeContext.summary,
      routePositive: fakeContext.routePositive,
      blockers: fakeContext.blockers,
      attackerPoolCreationReachability: fakeContext.attackerPoolCreationReachability,
      fakeAssetReachability: fakeContext.fakeAssetReachability,
      hasInitializeOrUnlockStaticRows: fakeContext.hasInitializeOrUnlockStaticRows,
      targetReviews: fakeContext.targetReviews,
    },
    fakeAssetContextSummary: {
      targetReviewsCount: fakeContext.targetReviews.length,
      hasStaticRows: fakeContext.summary.staticRows || 0,
    },
    summary,
    topRows: scored.slice(0, 20),
    allRows: scored,
    blockers: [
      "all rows are fail-closed on route gates",
      "no deployed callback permission proof in local static artifacts",
      "no exact-positive economics or fork proof in route artifacts",
    ],
    routeGate: {
      requiredForRoutePositive: [
        "bound callback",
        "permissionless callback proof",
        "open msg.sender gate",
        "attacker-created pool/currency proof",
        "deployed value-moving proof",
        "exact positive economics",
        "fork/local execution proof",
      ],
      routePositiveNow: false,
      executableNow: false,
      signedActionJustified: false,
    },
    warnings: warnings.length ? warnings : undefined,
    elapsedMs: Date.now() - start,
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(artifact, null, 2) + "\n");
  writeTriage(artifact);

  logInfo(`Wrote artifact: ${path.relative(WORKSPACE, OUTPUT)}`);
  logInfo(`Wrote triage: ${path.relative(WORKSPACE, OUTPUT_TRIAGE)}`);
  logInfo(`Rows: ${scored.length} | selector rows (ERC4626/Lending/Bridge): ${summary.erc4626SelectorRows}/${summary.lendingCoreSelectorRows}/${summary.bridgeSelectorRows}`);
  logInfo(`Route-positive: ${summary.routePositive} | executableNow: ${summary.executableNow}`);
  if (warnings.length > 0) {
    logInfo("Warnings:");
    for (const w of warnings) logInfo(`- ${w}`);
  }
}

try {
  main();
} catch (err) {
  console.error("FATAL:", err.message || err);
  process.exit(1);
}
