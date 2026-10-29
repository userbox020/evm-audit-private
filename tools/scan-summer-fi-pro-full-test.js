#!/usr/bin/env node
"use strict";

// scan-summer-fi-pro-full-test.js
// Defensive Summer.fi Pro / Oasis full-test scanner. Deterministic local/static
// artifacts only; no endpoint inventory reads, network calls, RPC, forks,
// signed actions, broadcasts, or wallets.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "summer-fi-pro-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "summer-fi-pro-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/summer-fi-pro-full-test.json";
const OUT_MD_REL = "reports/summer-fi-pro-full-test-triage.md";
const PREFILTER_JSON_REL = "reports/raw/fast/prefilter-summer-fi-pro-route-prefilter.json";
const PREFILTER_MD_REL = "reports/prefilter-summer-fi-pro-route-prefilter.md";

const QUIET = process.argv.includes("--quiet");
const GENERATED_AT = process.env.SCAN_GENERATED_AT || "2026-07-07T00:00:00.000Z";
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_LOCAL_MATCH_ROWS = 820;
const MAX_ROWS_PER_FILE = 38;

const TARGET = {
  slug: "summer-fi-pro",
  protocolSlug: "summer-fi",
  name: "Summer.fi Pro / Oasis",
  category: "CDP Manager / Oracle / Liquidation",
  surface: "automation-cdp-manager-oracle-liquidation",
  tvlContext: "$11.7M",
  prefilterTvlContext: "$11.666M",
  chains: ["Ethereum", "Arbitrum", "Optimism", "Base"],
  routeGraph: "automation/CDP manager -> MakerDAO/Aave/Spark/Morpho managed position -> oracle/liquidation/borrow/unwind",
  module: "summer-fi/index.js",
  adapterFetched: true,
  coordinatorClaim: "coordinator-summer-fi-pro-fulltest-01",
};

const CHAIN_SEEDS = [
  { chain: "Ethereum", chainLabel: "Ethereum", chainId: 1, adapterKey: "ethereum", evmFirst: true, caveat: false, classification: "makerdao-aave-spark-morpho-automation-chain" },
  { chain: "Arbitrum", chainLabel: "Arbitrum", chainId: 42161, adapterKey: "arbitrum", evmFirst: true, caveat: false, classification: "aave-automation-chain" },
  { chain: "Optimism", chainLabel: "Optimism", chainId: 10, adapterKey: "optimism", evmFirst: true, caveat: false, classification: "aave-automation-chain-trigger-attribution-recompute-needed" },
  { chain: "Base", chainLabel: "Base", chainId: 8453, adapterKey: "base", evmFirst: true, caveat: false, classification: "aave-morpho-automation-chain-trigger-attribution-recompute-needed" },
];

const CONTRACT_CONFIG_ROWS = [
  { role: "AutomationV1", chain: "Ethereum", chainId: 1, address: "0x6E87a7A0A03E51A741075fDf4D1FCce39a4Df01b", surface: "MakerDAO CDP trigger management", protocolLayer: "automation", source: "prefilter-config" },
  { role: "AutomationBotV2", chain: "Ethereum", chainId: 1, address: "0x5743b5606e94fb534a31e1cefb3242c8a9422e5e", surface: "Aave/Spark/Morpho trigger management", protocolLayer: "automation", source: "prefilter-config" },
  { role: "McdMonitorV2", chain: "Ethereum", chainId: 1, address: null, addressHint: "unresolved-non-address-prefilter-seed", surface: "MakerDAO vault monitor", protocolLayer: "monitor", source: "prefilter-config", knownInconsistency: "prior markdown says code=yes while raw prefilter says codePresent=false and the configured prefilter seed is not a valid 20-byte EVM address" },
  { role: "AaveProtocolDataProvider", chain: "Ethereum", chainId: 1, address: "0x497a1994c46d4f6C864904A9f1fac6328Cb7C8a6", surface: "Aave V3 data provider", protocolLayer: "data-provider", source: "prefilter-config" },
  { role: "SparkProtocolDataProvider", chain: "Ethereum", chainId: 1, address: "0xFc21d6d146E6086B8359705C8b28512a983db0cb", surface: "Spark data provider", protocolLayer: "data-provider", source: "prefilter-config" },
  { role: "MorphoBlue", chain: "Ethereum", chainId: 1, address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", surface: "Morpho Blue underlying protocol", protocolLayer: "underlying-protocol", source: "prefilter-config" },
  { role: "AutomationBotV2", chain: "Arbitrum", chainId: 42161, address: "0xE018AeA83728a037D8B6f76cCA0E8331cDAb937a", surface: "Arbitrum trigger management", protocolLayer: "automation", source: "prefilter-config" },
  { role: "AaveProtocolDataProvider", chain: "Arbitrum", chainId: 42161, address: "0x14496b405D62c24F91f04Cda1c69Dc526D56fDE5", surface: "Arbitrum Aave V3 data provider", protocolLayer: "data-provider", source: "prefilter-config" },
  { role: "AutomationBotV2", chain: "Optimism", chainId: 10, address: "0xb2e2a088d9705cd412CE6BF94e765743Ec26b1e4", surface: "Optimism trigger management", protocolLayer: "automation", source: "prefilter-config" },
  { role: "AaveProtocolDataProvider", chain: "Optimism", chainId: 10, address: "0x14496b405D62c24F91f04Cda1c69Dc526D56fDE5", surface: "Optimism Aave V3 data provider", protocolLayer: "data-provider", source: "prefilter-config" },
  { role: "AutomationBotV2", chain: "Base", chainId: 8453, address: "0x96D494b4544Bb7c3CB687ef7a9886Ed469e01ed8", surface: "Base trigger management", protocolLayer: "automation", source: "prefilter-config" },
  { role: "AaveProtocolDataProvider", chain: "Base", chainId: 8453, address: "0xC4Fcf9893072d61Cc2899C0054877Cb752587981", surface: "Base Aave V3 data provider", protocolLayer: "data-provider", source: "prefilter-config" },
  { role: "MorphoBlue", chain: "Base", chainId: 8453, address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", surface: "Base Morpho Blue underlying protocol", protocolLayer: "underlying-protocol", source: "prefilter-config" },
];

const WATCH_FUNCTION_ROWS = [
  { component: "trigger registry", signature: "activeTriggers", selectorOrEvent: "watch-function", routeRole: "decoded active trigger/position prerequisite" },
  { component: "record management", signature: "addRecord", selectorOrEvent: "watch-function", routeRole: "permissioned trigger-record mutation" },
  { component: "record management", signature: "removeRecord", selectorOrEvent: "watch-function", routeRole: "permissioned trigger-record mutation" },
  { component: "trigger management", signature: "addTriggers", selectorOrEvent: "watch-function", routeRole: "trigger install / takeover proof gap" },
  { component: "trigger management", signature: "removeTriggers", selectorOrEvent: "watch-function", routeRole: "trigger removal / grief proof gap" },
  { component: "bot execution", signature: "automationBot", selectorOrEvent: "watch-function", routeRole: "authorized bot mapping" },
  { component: "lock", signature: "clearLock", selectorOrEvent: "watch-function", routeRole: "position lock / grief proof gap" },
  { component: "executor", signature: "execute(bytes,bytes,address,uint256,uint256,address)", selectorOrEvent: "watch-function", routeRole: "value-moving command execution prerequisite" },
  { component: "registry", signature: "getAdapterAddress", selectorOrEvent: "watch-function", routeRole: "adapter mapping / stale binding proof gap" },
  { component: "registry", signature: "getCommandAddress", selectorOrEvent: "watch-function", routeRole: "deprecated command mapping proof gap" },
  { component: "registry", signature: "getValidatorAddress", selectorOrEvent: "watch-function", routeRole: "validator mapping / stale binding proof gap" },
  { component: "trigger records", signature: "getTriggerRecord", selectorOrEvent: "watch-function", routeRole: "decoded current trigger owner/position prerequisite" },
  { component: "service registry", signature: "serviceRegistry", selectorOrEvent: "watch-function", routeRole: "service address ownership/mapping proof gap" },
  { component: "counter", signature: "triggersCounter", selectorOrEvent: "watch-function", routeRole: "trigger enumeration context only" },
  { component: "ownership", signature: "owner", selectorOrEvent: "watch-function", routeRole: "ownership/admin blocker" },
  { component: "pause", signature: "paused", selectorOrEvent: "watch-function", routeRole: "execution availability blocker" },
  { component: "command approvals", signature: "approvedCommands", selectorOrEvent: "watch-function", routeRole: "deprecated/approved command proof gap" },
  { component: "delete flag", signature: "isAutomationDeleted", selectorOrEvent: "watch-function", routeRole: "sunset/deprecated route context" },
  { component: "gas guard", signature: "MAX_GAS_PRICE", selectorOrEvent: "watch-function", routeRole: "automation execution feasibility context" },
  { component: "event", signature: "TriggerAdded", selectorOrEvent: "event", routeRole: "event-only trigger estimate; not decoded position proof" },
  { component: "event", signature: "TriggerExecuted", selectorOrEvent: "event", routeRole: "event-only execution context; not attacker profit proof" },
  { component: "event", signature: "TriggerRemoved", selectorOrEvent: "event", routeRole: "event-only trigger estimate; not decoded position proof" },
  { component: "registry", signature: "ServiceRegistry / OperationsRegistry ownership and service mappings", selectorOrEvent: "watch-surface", routeRole: "stale/misbound action mapping proof gap" },
];

const AUTOMATION_SURFACE_ROWS = [
  { component: "automation trigger state", surface: "activeTriggers/getTriggerRecord/trigger events", routeRole: "decoded current trigger and managed-position prerequisite", watchTerms: ["activeTriggers", "getTriggerRecord", "TriggerAdded", "TriggerExecuted", "TriggerRemoved"] },
  { component: "record and trigger mutation", surface: "addRecord/removeRecord/addTriggers/removeTriggers/clearLock", routeRole: "permissionless takeover/removal proof gap", watchTerms: ["addRecord", "removeRecord", "addTriggers", "removeTriggers", "clearLock"] },
  { component: "bot command execution", surface: "execute(bytes,bytes,address,uint256,uint256,address), approvedCommands, automationBot", routeRole: "deprecated command and permissioned execution proof gap", watchTerms: ["execute(bytes,bytes,address,uint256,uint256,address)", "approvedCommands", "automationBot"] },
  { component: "service/operations registry", surface: "serviceRegistry, getAdapterAddress, getCommandAddress, getValidatorAddress, OperationsRegistry", routeRole: "stale/misbound adapter/command/validator proof gap", watchTerms: ["serviceRegistry", "getAdapterAddress", "getCommandAddress", "getValidatorAddress", "OperationsRegistry"] },
  { component: "ownership/proxy/pause", surface: "owner, paused, proxy/admin, isAutomationDeleted, MAX_GAS_PRICE", routeRole: "role/admin/sunset execution blocker", watchTerms: ["owner", "paused", "proxy", "isAutomationDeleted", "MAX_GAS_PRICE"] },
  { component: "underlying position", surface: "MakerDAO CDP / Aave / Spark / Morpho managed positions", routeRole: "current position/liquidation health prerequisite", watchTerms: ["CDP", "MakerDAO", "Aave", "Spark", "Morpho", "health factor", "liquidatable"] },
  { component: "oracle/liquidation/borrow/unwind", surface: "underlying oracle value, liquidation condition, borrow/unwind/exit", routeRole: "exact positive economics prerequisite", watchTerms: ["oracle", "liquidation", "borrow", "unwind", "netLiquidUsd", "valueDelta"] },
  { component: "fork/value-delta", surface: "local-only fork harness gate", routeRole: "fork non-meaningful until route-positive candidate exists", watchTerms: ["fork", "anvil", "routePositive", "valueDelta", "executableNow"] },
];

const BUG_CLASS_ROWS = [
  { label: "permissionless trigger takeover/removal", surface: "trigger records and add/remove functions", routeBlockingGap: "missing decoded active trigger/position ownership and permission proof", classification: "bug-class-context-no-takeover-proof" },
  { label: "deprecated command/bot still holds authority", surface: "approvedCommands, getCommandAddress, automationBot, execute", routeBlockingGap: "missing command balance/allowance/proxy authority proof", classification: "bug-class-context-no-deprecated-command-value" },
  { label: "stale or misbound adapter/validator/action", surface: "ServiceRegistry / OperationsRegistry / adapter-command-validator mappings", routeBlockingGap: "missing stale mapping to attacker-positive action", classification: "bug-class-context-no-stale-binding-profit" },
  { label: "underlying position currently liquidatable", surface: "MakerDAO/Aave/Spark/Morpho managed position", routeBlockingGap: "missing decoded position, HF/collateral/debt, and current liquidation condition", classification: "bug-class-context-no-current-liquidation" },
  { label: "oracle value mismatch", surface: "underlying oracle feeds/action pricing", routeBlockingGap: "missing stale/misbound oracle/action and exact exit value", classification: "bug-class-context-no-oracle-profit-proof" },
  { label: "DEX/redeem/borrow/unwind positive economics", surface: "liquidation, borrow, DEX/unwind", routeBlockingGap: "missing exact route-size net positive economics", classification: "bug-class-context-no-exact-economics" },
  { label: "fork attempted before route-positive", surface: "local fork harness", routeBlockingGap: "missing route-positive candidate and value-delta proof", classification: "bug-class-gated-by-route-positive-zero" },
  { label: "artifact inconsistency", surface: "prior prefilter raw vs markdown", routeBlockingGap: "trigger chain attribution and McdMonitor code status need recompute", classification: "data-quality-fail-closed" },
];

const SOURCE_FACTS = [
  { sourceLabel: "target-context:Summer.fi Pro", kind: "target-seed", slug: TARGET.slug, protocolSlug: TARGET.protocolSlug, name: TARGET.name, category: TARGET.category, surface: TARGET.surface, tvlContext: TARGET.tvlContext, chains: TARGET.chains, module: TARGET.module, routePositive: 0, classification: "structured-target-seed-route-negative" },
  { sourceLabel: "prior-prefilter-artifact:summer-fi-pro-route-prefilter", kind: "local-prefilter-context", artifacts: [PREFILTER_JSON_REL, PREFILTER_MD_REL], priorStatus: "dormant-route-negative", priorRoutePositive: 0, classification: "prior-prefilter-context-no-route-positive" },
  { sourceLabel: "route-model:automation-cdp-manager", kind: "route-graph", model: TARGET.routeGraph, routePositiveOnlyIf: "attacker can permissionlessly take over/execute another position, deprecated command/bot has exploitable balance/allowance/proxy authority, current underlying position is liquidatable with exact positive economics, or stale/misbound oracle/action creates attacker-positive value", classification: "route-model-fail-closed" },
  { sourceLabel: "local-consumer-liquidation-context", kind: "local-artifact-context", artifacts: ["Aave/Spark/Morpho", "consumer", "DEX", "liquidation/economics"], classification: "local-context-only-no-summer-specific-route-positive" },
];

const STATIC_CONTEXT_ROWS = [
  { sourceLabel: "prior-dormant-result", matched: "dormant route-negative prefilter", categories: ["automation", "triggerState", "exactEconomics"], sample: "Prior prefilter found no own token/oracle, no Summer.fi-specific consumer joins, no DEX liquidity, exactEconomicsRows=0, routePositive=0, executableNow=0, signedActionJustified=false.", classification: "prior-prefilter-dormant-no-route-positive" },
  { sourceLabel: "active-trigger-caveat", matched: "estimated active triggers", categories: ["triggerState", "underlyingPosition", "inconsistency"], sample: "Estimated trigger event counts are context only; active triggers do not equal exploitable positions and require decoded owner/position/health attribution before promotion.", classification: "trigger-estimate-not-exploit-proof" },
  { sourceLabel: "trigger-attribution-inconsistency", matched: "raw vs markdown trigger attribution", categories: ["triggerState", "inconsistency"], sample: "Prior markdown attributes all 80 estimated active triggers to Base, while raw prefilter data places the 80 estimate on Optimism; trigger attribution must be recomputed fail-closed.", classification: "data-quality-trigger-attribution-recompute-needed" },
  { sourceLabel: "mcd-monitor-code-mismatch", matched: "McdMonitorV2 code-present mismatch", categories: ["monitor", "codeProof", "inconsistency"], sample: "Prior markdown table lists McdMonitorV2 code=yes, but raw prefilter row has codePresent=false/codeBytes=0; monitor code status must be recomputed before any route decision.", classification: "data-quality-mcd-monitor-code-status-recompute-needed" },
  { sourceLabel: "automation-data-provider-context", matched: "code-present automation/data-provider rows", categories: ["automation", "dataProvider", "codeProof"], sample: "Automation bots and protocol data providers being code-present is context only; it is not proof of permissionless value movement or attacker-positive economics.", classification: "code-present-context-only" },
  { sourceLabel: "underlying-protocol-context", matched: "MakerDAO/Aave/Spark/Morpho underlying positions", categories: ["underlyingPosition", "oracleLiquidation", "consumerJoin"], sample: "Summer.fi Pro manages positions in underlying protocols; route proof must identify a current underlying position and exact liquidation/borrow/unwind value path, not just underlying protocol presence.", classification: "underlying-context-no-exact-position" },
  { sourceLabel: "sunset-wind-down-caveat", matched: "sunset/wind-down", categories: ["automation", "deprecatedCommandBalanceAllowance"], sample: "Protocol wind-down/sunset is a caveat and a reason to check deprecated authority, but it is not itself a route-positive proof.", classification: "sunset-context-no-value-proof" },
  { sourceLabel: "fork-prereq-row", matched: "local fork prerequisites", categories: ["forkPrereq", "exactEconomics"], sample: "Fork harness remains inert until routePositive > 0, code-present value-moving candidate, exact current liquidation/exit economics, and static value-delta proof exist.", classification: "fork-gated-route-positive-zero" },
].map((row) => ({ rowSource: "static-public-fact", matchType: "static-public-fact", termType: "static", routePositive: 0, sourceRoutePositiveNotPromoted: false, ...row }));

const EXPLICIT_FILES = [
  PREFILTER_JSON_REL,
  PREFILTER_MD_REL,
  "reports/raw/fast/aave-euler-silo-consumer-graph.json",
  "reports/raw/fast/aave-v3-emode-escalation.json",
  "reports/raw/fast/aave-v3-trigger-readiness.json",
  "reports/raw/fast/aave-v3-route-distance.json",
  "reports/raw/fast/aave-v3-multichain-borrowers.json",
  "reports/raw/fast/aave-v3-l2-borrowers.json",
  "reports/raw/fast/aave-v3-hf-preview.json",
  "reports/raw/fast/aave-v3-liquidation-watch-status.json",
  "reports/raw/fast/aave-compound-liquidatable-2026-06-28.json",
  "reports/raw/fast/spark-ssr-psm-live.json",
  "reports/raw/fast/phase6-spark-sky-lending.json",
  "reports/raw/fast/morpho-high-apy-liquidation-routes.json",
  "reports/raw/fast/morpho-liquidatable-marketability.json",
  "reports/raw/fast/morpho-liq-borrowers.json",
  "reports/raw/fast/morpho-onchain-liq.json",
  "reports/raw/fast/morpho-l2-borrowers.json",
  "reports/raw/fast/morpho-l2-lrt-markets.json",
  "reports/raw/fast/morpho-wrapper-exit-proof-gaps.json",
  "reports/raw/fast/morpho-exit-liquidity-stress.json",
  "reports/raw/fast/consumer-first-high-ltv-collateral.json",
  "reports/raw/fast/erc4626-consumer-joiner.json",
  "reports/raw/fast/dex-consumer-routes.json",
  "reports/raw/fast/dex-exit-quotes.json",
  "reports/raw/fast/current-liquidatable-exit-routes.json",
  "reports/raw/fast/stale-oracle-liquidity-candidates.json",
  "reports/raw/fast/validation-differential-liquidations.json",
  "reports/raw/fast/derive-v2-trusted-risk-economics.json",
  "reports/raw/fast/mev-sandwich-order-economics.json",
];

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function normalizeAddress(value) {
  const raw = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return `0x${raw.slice(2).toLowerCase()}`;
}

function addressStatusFor(value) {
  if (normalizeAddress(value)) return "valid-evm-address";
  if (value === null || value === undefined || String(value).trim() === "") return "unresolved-non-address";
  return "invalid-non-address";
}

function assertCandidateAddressSchema(rows, contextLabel) {
  const invalid = [];
  let validRows = 0;
  let unresolvedRows = 0;
  for (const row of rows || []) {
    const status = addressStatusFor(row.address);
    if (status === "valid-evm-address") validRows += 1;
    else if (status === "unresolved-non-address") unresolvedRows += 1;
    else invalid.push({ role: row.role, chain: row.chain, addressStatus: status });
  }
  if (invalid.length) {
    const sample = invalid.slice(0, 3).map((row) => `${row.role}/${row.chain}/${row.addressStatus}`).join(", ");
    throw new Error(`${contextLabel} contains malformed non-empty candidate address rows; refuse to emit candidate matrix: ${sample}`);
  }
  return {
    context: contextLabel,
    totalRows: (rows || []).length,
    validRows,
    unresolvedNonAddressRows: unresolvedRows,
    excludedFromCandidateAddressValidationRows: unresolvedRows,
    invalidNonAddressRows: invalid.length,
    assertion: invalid.length === 0 ? "pass" : "fail",
    rule: "Candidate rows may contain valid 20-byte EVM addresses or explicit unresolved null/non-address sentinels; malformed non-empty address strings are rejected before matrix emission.",
  };
}

const ADDRESS_RULES = CONTRACT_CONFIG_ROWS
  .filter((row) => normalizeAddress(row.address))
  .map((row) => ({ label: `${row.role} ${row.chain} ${row.address}`, regex: new RegExp(escapeRegExp(row.address), "i") }));

const EXACT_RULES = [
  { label: "summer-fi-pro", regex: /\bsummer[-_\s.]?fi[-_\s]?pro\b/i },
  { label: "Summer.fi Pro", regex: /\bSummer\.fi\s+Pro\b/i },
  { label: "Oasis", regex: /\bOasis(?:\.app)?\b/i },
  { label: "summer-fi/index.js", regex: /\bsummer-fi[\\/]index\.js\b/i },
  { label: "AutomationV1", regex: /\bAutomationV1\b/i },
  { label: "AutomationBotV2", regex: /\bAutomationBotV2\b/i },
  { label: "McdMonitorV2", regex: /\bMcdMonitorV2\b/i },
  { label: "AaveProtocolDataProvider", regex: /\bAave(?:Protocol)?DataProvider\b/i },
  { label: "SparkProtocolDataProvider", regex: /\bSpark(?:Protocol)?DataProvider\b/i },
  { label: "MorphoBlue", regex: /\bMorpho(?:Blue)?\b/i },
  { label: "activeTriggers", regex: /\bactiveTriggers\b/i },
  { label: "getTriggerRecord", regex: /\bgetTriggerRecord\b/i },
  { label: "execute(bytes,bytes,address,uint256,uint256,address)", regex: /\bexecute\s*\(\s*bytes\s*,\s*bytes\s*,\s*address\s*,\s*uint256\s*,\s*uint256\s*,\s*address\s*\)/i },
  { label: "TriggerAdded/Executed/Removed", regex: /\bTrigger(?:Added|Executed|Removed)\b/i },
  ...ADDRESS_RULES,
];

const CONTEXT_RULES = [
  { label: "automation/trigger", regex: /\b(?:automation|trigger|triggered|bot|monitor|record|addTriggers|removeTriggers|clearLock)\b/i },
  { label: "service/operations registry", regex: /\b(?:serviceRegistry|OperationsRegistry|getAdapterAddress|getCommandAddress|getValidatorAddress|approvedCommands)\b/i },
  { label: "ownership/proxy/permission", regex: /\b(?:owner|admin|proxy|implementation|paused|permission|role|authority|allowance|approval|balance)\b/i },
  { label: "underlying position", regex: /\b(?:CDP|vault|MakerDAO|Maker|Aave|Spark|Morpho|position|collateral|debt|borrower|health\s*factor|HF)\b/i },
  { label: "oracle/liquidation/borrow/unwind", regex: /\b(?:oracle|price|feed|stale|liquidation|liquidatable|borrow|repay|unwind|close|exit)\b/i },
  { label: "DEX/economics", regex: /\b(?:DEX|swap|pool|liquidity|quote|slippage|netLiquidUsd|valueDelta|profit|exactEconomics|routePositive|executableNow)\b/i },
  { label: "data-provider", regex: /\b(?:DataProvider|getUserAccountData|getReserveData|getUserReserveData)\b/i },
  { label: "fork/value delta", regex: /\b(?:fork|anvil|localhost|value-delta|valueDelta|txAttempts)\b/i },
];

const CATEGORY_RULES = {
  automation: ["summer", "oasis", "automation", "bot", "trigger", "triggeradded", "triggerexecuted", "triggerremoved", "automationv1", "automationbotv2"],
  triggerState: ["activetriggers", "gettriggerrecord", "triggerscounter", "trigger", "activeTriggerEstimate", "triggerAddedCount", "triggerRemovedCount"],
  monitor: ["mcdmonitor", "mcdmonitorv2", "cdp", "makerdao", "maker vault", "vault monitor"],
  dataProvider: ["dataprovider", "aaveprotocoldataprovider", "sparkprotocoldataprovider", "getuseraccountdata", "getreservedata"],
  morpho: ["morpho", "morphoblue", "bbbbbbbb", "market params", "lltv"],
  serviceRegistry: ["serviceregistry", "service registry", "getadapteraddress", "getcommandaddress", "getvalidatoraddress"],
  operationsRegistry: ["operationsregistry", "operations registry", "command", "adapter", "validator"],
  ownershipProxyPermission: ["owner", "admin", "proxy", "implementation", "paused", "role", "permission", "authority"],
  deprecatedCommandBalanceAllowance: ["approvedcommands", "isautomationdeleted", "deprecated", "balance", "allowance", "approval", "proxy authority"],
  underlyingPosition: ["position", "collateral", "debt", "borrower", "health factor", "hf", "maker", "aave", "spark", "morpho", "cdp"],
  oracleLiquidation: ["oracle", "price", "feed", "stale", "liquidation", "liquidatable", "maxliquidatable", "seize"],
  consumerJoin: ["consumer", "join", "collateral", "borrow", "lending", "market", "reserve", "ltv", "lltv"],
  dexExit: ["dex", "swap", "pool", "liquidity", "quote", "slippage", "exit", "unwind"],
  exactEconomics: ["routepositive", "executable", "profit", "netliquidusd", "valuedelta", "exacteconomics", "positive", "gas"],
  forkPrereq: ["fork", "anvil", "localhost", "txattempts", "valueDelta", "routepositive"],
  codeProof: ["codepresent", "codebytes", "sourceStatus", "sourcify", "implementation", "proxy"],
  inconsistency: ["mismatch", "inconsistent", "recompute", "attribution", "code=yes", "codepresent=false"],
};

const BLOCKERS = [
  "Summer.fi Pro is an automation/management layer over MakerDAO/Aave/Spark/Morpho; code-present automation/data-provider rows are context only and do not prove an attacker-positive route.",
  "Prior prefilter remains dormant: no own token/oracle, no Summer.fi-specific consumer joins, no DEX liquidity, exactEconomicsRows=0, routePositive=0, executableNow=0, signedActionJustified=false.",
  "Estimated active triggers are not exploitable positions; each trigger must be decoded to current owner, position, collateral/debt, health, permissions, and command/action mappings before route promotion.",
  "Prior markdown/raw inconsistencies are fail-closed blockers: trigger chain attribution needs recompute, and McdMonitorV2 markdown code=yes conflicts with raw codePresent=false.",
  "No permissionless takeover/removal/execute path against another managed position is proven through addRecord/addTriggers/removeTriggers/removeRecord/clearLock/execute.",
  "No deprecated command/bot is proven to retain exploitable balance, allowance, proxy authority, or stale approval.",
  "No stale/misbound ServiceRegistry or OperationsRegistry adapter/command/validator/action creates attacker-positive value in current local artifacts.",
  "No current MakerDAO/Aave/Spark/Morpho managed position is proven liquidatable with exact positive liquidation/borrow/unwind economics.",
  "No local static/fork value-delta proof and no signed action justified.",
];

const REQUIRED_FOR_ROUTE_POSITIVE = [
  "Decode a current active trigger/record to exact owner, managed position, chain, underlying protocol, collateral, debt, health factor, command, adapter, and validator mapping.",
  "Prove a permissionless Summer.fi-specific takeover, remove, lock-clear, or execute path that can affect another user's managed position without privileged roles.",
  "Or prove a deprecated AutomationBot/command/adapter/validator still has exploitable token balance, allowance, proxy authority, or stale approval reachable by an attacker.",
  "Or prove a current underlying MakerDAO/Aave/Spark/Morpho position is liquidatable now and Summer.fi automation/action state creates attacker-positive value.",
  "Or prove stale/misbound oracle/action/service mapping creates accepted value above realizable exit value for a specific route.",
  "Calculate exact route-size economics: liquidation bonus, debt repayment, collateral acquisition, borrow/unwind/DEX/redeem exit, slippage, fees, gas, and timing all net positive.",
  "Run local-only fork/static value-delta proof with ephemeral accounts, localhost-only RPC if any, no endpoint inventory, no private keys, and no broadcast.",
  "Independent defensive review and explicit route-specific authorization before any signed transaction consideration.",
];

const NEXT_READ_ONLY_STEP = "Fail closed and recompute trigger attribution/code-status from sanitized read-only state only if needed: decode getTriggerRecord/activeTriggers for current records, map ServiceRegistry/OperationsRegistry command/adapter/validator ownership, then join to exact MakerDAO/Aave/Spark/Morpho position health and exit economics before enabling the inert fork harness.";

function log(...args) { if (!QUIET) console.log(...args); }
function ensureDir(filePath) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); }
function rel(filePath) { return path.relative(WORKSPACE, filePath).replace(/\\/g, "/"); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }

function sanitizeText(value, max = 420) {
  let text = String(value ?? "").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  text = text
    .replace(/\brpc_endpoints\.txt\b/gi, "[redacted-endpoint-inventory]")
    .replace(/\bgraphql_endpoints\.txt\b/gi, "[redacted-endpoint-inventory]")
    .replace(/\bhttps?:\/\/[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\bwww\.[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|fi|app|xyz|finance|protocol|dev|co|so|network|tech|exchange|build|money|info|ai|eth|gg)\b/gi, "[redacted-domain]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/= -]+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|api[-_]?key|access[-_]?key|private[-_]?key|secret[-_]?key|secret|token|password|pwd)\s*[:=]\s*["']?[^\s"',}\]]{8,}/gi, "$1=[redacted]")
    .replace(/\b0x[0-9a-fA-F]{64}\b/g, "[redacted-hex-key]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}\b/g, "[redacted-jwt]");
  return text.slice(0, max) || null;
}

function mdEscape(value) { return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim(); }

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const norm = String(key).toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(item);
  }
  return out;
}

function pickRows(rows, predicate, max = 160) {
  const out = [];
  for (const row of rows) {
    if (!predicate(row)) continue;
    out.push(row);
    if (out.length >= max) break;
  }
  return out;
}

function isSecretLikePath(filePath) {
  const r = rel(filePath).replace(/\\/g, "/").toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base === "rpc_endpoints.txt" || base === "graphql_endpoints.txt") return true;
  if (/\.(pem|key|p12|pfx|keystore)$/i.test(base)) return true;
  if (/(^|[\/\\])(?:private|secret|secrets|mnemonic|seed|wallet|keypair|keystore|api[-_]?key|access[-_]?key)(?:[\/\\._-]|$)/i.test(r)) return true;
  return false;
}

function isExcludedScanPath(filePath) {
  const r = rel(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (r === OUT_JSON_REL.toLowerCase() || r === OUT_MD_REL.toLowerCase()) return true;
  if (r === "tools/scan-summer-fi-pro-full-test.js" || r === "tools/fork-test-summer-fi-pro-routes.js") return true;
  if (isSecretLikePath(filePath)) return true;
  if (base.includes("endpoint")) return true;
  if (r.includes("/node_modules/") || r.includes("/.git/")) return true;
  if (r.includes("/cache/") || r.includes("/out/") || r.includes("/broadcast/") || r.includes("/artifacts/")) return true;
  if (r.startsWith(".opencode/") || r.startsWith("coordination/")) return true;
  if (/(?:handoff|shared_context|state\.md|audit-completion-gates|route-positive-sweep|low-fund-executable-route-filter|exploit-findings-summary|full-test|fork-route-test)/i.test(r)) return true;
  return false;
}

function isUnsafeSampleText(text) {
  return /\b(?:rpc_endpoints\.txt|graphql_endpoints\.txt|private[-_]?key|secret[-_]?key|mnemonic|seed\s+phrase|bearer\s+|authorization\s*[:=]|password\s*[:=]|pwd\s*[:=])\b/i.test(String(text || ""));
}

function readText(filePath) {
  try {
    if (isSecretLikePath(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch (_error) { return null; }
}

function readJson(filePath) {
  const text = readText(filePath);
  if (!text) return null;
  try { return JSON.parse(text); } catch (_error) { return null; }
}

function writeJson(filePath, value) { ensureDir(filePath); fs.writeFileSync(filePath, `${JSON.stringify(value, jsonReplacer, 2)}\n`, "utf8"); }
function writeText(filePath, value) { ensureDir(filePath); fs.writeFileSync(filePath, value, "utf8"); }

function listFilesRecursive(rootDir, filterFn = null) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_error) { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/^(?:node_modules|\.git|cache|out|broadcast|artifacts|lib)$/i.test(entry.name)) continue;
        if (rel(full).toLowerCase().startsWith("coordination/")) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(json|md|txt|js|ts|sol|yaml|yml|toml|csv)$/i.test(entry.name)) continue;
      if (isExcludedScanPath(full)) continue;
      if (filterFn && !filterFn(full)) continue;
      out.push(full);
    }
  }
  walk(rootDir);
  return out;
}

function listRelatedReportFiles() {
  const fast = path.join(WORKSPACE, "reports", "raw", "fast");
  return listFilesRecursive(fast, (file) => /(?:summer|oasis|automation|mcd|cdp|maker|aave|spark|morpho|consumer|dex|exit|liquid|econom|oracle|borrow|unwind|data-provider|stale)/i.test(path.basename(file)));
}

function listScanFiles() {
  const files = [];
  for (const file of EXPLICIT_FILES) {
    const full = path.join(WORKSPACE, file);
    if (fs.existsSync(full) && !isExcludedScanPath(full)) files.push(full);
  }
  files.push(...listRelatedReportFiles());
  return uniqBy(files, (file) => path.resolve(file)).sort((a, b) => rel(a).localeCompare(rel(b)));
}

function firstRuleMatch(text, rules) {
  const raw = String(text || "");
  for (const rule of rules) { rule.regex.lastIndex = 0; if (rule.regex.test(raw)) return rule; }
  return null;
}
function hasRuleMatch(text, rules) { return Boolean(firstRuleMatch(text, rules)); }
function isContextualFile(filePath) { return /(?:aave|spark|morpho|consumer|dex|exit|liquid|econom|oracle|borrow|unwind|summer|oasis|prefilter)/i.test(path.basename(filePath)); }

function matchForText(line, windowText, filePath) {
  const exact = firstRuleMatch(line, EXACT_RULES) || firstRuleMatch(windowText, EXACT_RULES);
  if (exact) return { matchType: "exact-name-address-selector", matched: exact.label, termType: "text" };
  const context = firstRuleMatch(line, CONTEXT_RULES) || firstRuleMatch(windowText, CONTEXT_RULES);
  if (!context) return null;
  if (hasRuleMatch(windowText, EXACT_RULES) || isContextualFile(filePath)) return { matchType: "context", matched: context.label, termType: "text" };
  return null;
}

function categoriesFor(text, filePath = "") {
  const hay = `${filePath} ${String(text || "")}`.toLowerCase();
  const categories = [];
  for (const [category, terms] of Object.entries(CATEGORY_RULES)) {
    if (terms.some((term) => hay.includes(term.toLowerCase()))) categories.push(category);
  }
  return categories.length ? categories : ["context"];
}

function countOccurrences(text, term) {
  if (!text || !term) return 0;
  let count = 0;
  let cursor = 0;
  const hay = String(text).toLowerCase();
  const needle = String(term).toLowerCase();
  while (needle && cursor <= hay.length) {
    const pos = hay.indexOf(needle, cursor);
    if (pos < 0) break;
    count += 1;
    cursor = pos + Math.max(needle.length, 1);
  }
  return count;
}

function classificationForRow(file, match, categories, routeValue) {
  const r = rel(file).toLowerCase();
  if (routeValue === true || routeValue === "true" || routeValue === 1) return "prior-positive-or-watch-signal-not-promoted-without-current-exact-economics";
  if (r.includes("prefilter-summer-fi-pro")) return "prior-prefilter-context-only-no-route-positive";
  if (categories.includes("inconsistency")) return "data-quality-context-fail-closed-recompute-needed";
  if (categories.includes("triggerState")) return "trigger-context-only-needs-decoded-position-attribution";
  if (categories.includes("serviceRegistry") || categories.includes("operationsRegistry")) return "registry-context-only-no-stale-misbinding-profit";
  if (categories.includes("ownershipProxyPermission") || categories.includes("deprecatedCommandBalanceAllowance")) return "permission-authority-context-only-no-bypass-proof";
  if (categories.includes("underlyingPosition") || categories.includes("oracleLiquidation")) return "underlying-position-or-liquidation-context-only-no-current-positive-economics";
  if (categories.includes("consumerJoin")) return "consumer-context-only-no-summer-specific-route";
  if (categories.includes("dexExit") || categories.includes("exactEconomics")) return "dex-economics-context-only-no-exact-positive-route";
  if (categories.includes("forkPrereq")) return "fork-context-only-gated-by-route-positive-zero";
  return match.matchType === "exact-name-address-selector" ? "exact-local-watch-context-only-no-route-positive" : "local-artifact-watch-context-only-no-route-positive";
}

function scanLocalArtifactLines(files) {
  const rows = [];
  let filesScanned = 0;
  let filesWithMatch = 0;
  let filesWithExact = 0;
  const categoryCounts = {};
  for (const file of files) {
    const text = readText(file);
    if (!text) continue;
    filesScanned += 1;
    const fileHasExact = hasRuleMatch(text, EXACT_RULES);
    if (!fileHasExact && !hasRuleMatch(text, CONTEXT_RULES)) continue;
    const lines = text.split(/\r?\n/);
    let sampled = 0;
    let fileMatched = false;
    let fileExact = false;
    const seen = new Set();
    for (let i = 0; i < lines.length && rows.length < MAX_LOCAL_MATCH_ROWS && sampled < MAX_ROWS_PER_FILE; i += 1) {
      const line = String(lines[i] || "");
      if (!line.trim()) continue;
      const windowText = [lines[i - 2], lines[i - 1], lines[i], lines[i + 1], lines[i + 2]].map((x) => String(x || "")).join(" ");
      if (isUnsafeSampleText(line) || isUnsafeSampleText(windowText)) continue;
      const match = matchForText(line, windowText, file);
      if (!match) continue;
      const key = `${rel(file)}:${i + 1}:${match.matchType}:${match.matched}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fileMatched = true;
      if (match.matchType === "exact-name-address-selector") fileExact = true;
      const categories = categoriesFor(windowText, rel(file));
      for (const category of categories) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      const routeValue = /\broutePositive\b[^\n,}]*\b(?:true|1)\b/i.test(windowText);
      rows.push({ rowSource: "line-scan", file: rel(file), line: i + 1, matchType: match.matchType, termType: match.termType, matched: sanitizeText(match.matched, 160), count: countOccurrences(line, match.matched), categories, sample: sanitizeText(windowText, 540), routePositive: 0, sourceRoutePositiveNotPromoted: Boolean(routeValue), classification: classificationForRow(file, match, categories, routeValue) });
      sampled += 1;
    }
    if (fileMatched) filesWithMatch += 1;
    if (fileExact) filesWithExact += 1;
    if (rows.length >= MAX_LOCAL_MATCH_ROWS) break;
  }
  return { filesScanned, filesWithMatch, filesWithExact, rows, exactRows: rows.filter((row) => row.matchType === "exact-name-address-selector"), categoryCounts };
}

function exactish(row) { return row.matchType === "exact-name-address-selector"; }
function sourceForRow(row) { return row.file ? `${row.file}${row.line ? `:${row.line}` : ""}` : (row.sourceLabel || row.rowSource || "static"); }
function includesAnyTerm(text, terms) { const hay = String(text || "").toLowerCase(); return terms.some((term) => term && hay.includes(String(term).toLowerCase())); }
function rowSearchText(row) { return `${row.file || ""} ${row.matched || ""} ${row.sample || ""} ${row.classification || ""}`; }
function firstSources(rows, max = 4) { return uniqBy(rows, sourceForRow).slice(0, max).map(sourceForRow); }
function proofCheck({ key, status, evidenceRows = [], blocker }) { return { key, status, evidenceRows: evidenceRows.length, evidenceSources: firstSources(evidenceRows), routeBlocking: true, blocker }; }

function priorContractLookup(priorPrefilter) {
  const map = new Map();
  for (const chain of priorPrefilter.rawChainResults || []) {
    for (const [role, row] of Object.entries(chain.contracts || {})) {
      const key = `${chain.chainId}:${role}:${normalizeAddress(row.address) || String(row.address || "").toLowerCase()}`.toLowerCase();
      map.set(key, { ...row, role, chain: chain.chain, chainId: chain.chainId });
    }
  }
  return map;
}

function buildContractSeedRows(priorPrefilter) {
  const lookup = priorContractLookup(priorPrefilter);
  return CONTRACT_CONFIG_ROWS.map((seed) => {
    const normalizedSeedAddress = normalizeAddress(seed.address);
    const addressStatus = addressStatusFor(seed.address);
    const key = `${seed.chainId}:${seed.role}:${normalizedSeedAddress || String(seed.address || "").toLowerCase()}`.toLowerCase();
    const prior = lookup.get(key) || {};
    const classification = addressStatus !== "valid-evm-address"
      ? "unresolved-non-address-excluded-from-candidate-address-validation"
      : prior.codePresent === false
        ? "prefilter-raw-no-code-fail-closed"
        : prior.codePresent === true
          ? "prefilter-code-present-context-only"
          : "configured-seed-no-current-state-proof";
    return {
      ...seed,
      address: normalizedSeedAddress || null,
      normalizedAddress: normalizedSeedAddress,
      addressStatus,
      candidateAddressValidation: addressStatus === "valid-evm-address" ? "included-valid-evm-address" : "excluded-unresolved-non-address",
      codePresentKnown: prior.codePresent ?? null,
      codeBytes: Number(prior.codeBytes || 0) || 0,
      sourceStatus: prior.sourceStatus ? { verified: Boolean(prior.sourceStatus.verified), source: sanitizeText(prior.sourceStatus.source, 80) } : null,
      ownerKnown: sanitizeText(prior.owner, 120),
      pausedKnown: prior.paused ?? null,
      triggersCountKnown: prior.triggersCount ?? null,
      triggerEvents: prior.triggerEvents ? {
        triggerAddedCount: Number(prior.triggerEvents.triggerAddedCount || 0) || 0,
        triggerRemovedCount: Number(prior.triggerEvents.triggerRemovedCount || 0) || 0,
        activeTriggerEstimate: Number(prior.triggerEvents.activeTriggerEstimate || 0) || 0,
      } : null,
      localMatchRowsFromPrefilter: Array.isArray(prior.localMatches) ? prior.localMatches.length : 0,
      classification,
    };
  });
}

function buildInconsistencyRows(priorPrefilter, priorMdText) {
  const md = String(priorMdText || "");
  const optimismActive = (priorPrefilter.rawChainResults || []).find((row) => row.chain === "Optimism")?.contracts?.AutomationBotV2?.triggerEvents?.activeTriggerEstimate || 0;
  const baseActive = (priorPrefilter.rawChainResults || []).find((row) => row.chain === "Base")?.contracts?.AutomationBotV2?.triggerEvents?.activeTriggerEstimate || 0;
  const mdSaysBase80 = /Base\s+chain\s+holds\s+all\s+80\s+estimated\s+active\s+triggers/i.test(md) || /\|\s*Base\s+\(V2\)\s*\|\s*324\s*\|\s*244\s*\|\s*80\s*\|/i.test(md);
  const rawMcd = (priorPrefilter.rawChainResults || []).find((row) => row.chain === "Ethereum")?.contracts?.McdMonitorV2;
  const mdMcdCodeYes = /McdMonitorV2[^\n]+\|\s*`?0x[^\n]+\|\s*yes\s*\|/i.test(md);
  const rows = [];
  if (mdSaysBase80 || Number(optimismActive) !== Number(baseActive)) {
    rows.push({ kind: "trigger-chain-attribution", rawOptimismActiveTriggerEstimate: Number(optimismActive || 0), rawBaseActiveTriggerEstimate: Number(baseActive || 0), priorMarkdownSaysBaseHoldsAll80: Boolean(mdSaysBase80), routeImpact: "fail-closed; active trigger attribution must be recomputed and decoded before route promotion", classification: "inconsistency-trigger-attribution-recompute-needed" });
  }
  if (mdMcdCodeYes || rawMcd?.codePresent === false) {
    rows.push({ kind: "mcd-monitor-code-status", rawCodePresent: rawMcd?.codePresent ?? null, rawCodeBytes: Number(rawMcd?.codeBytes || 0) || 0, priorMarkdownCodeYes: Boolean(mdMcdCodeYes), routeImpact: "fail-closed; McdMonitorV2 code status cannot be used as route proof without recompute", classification: "inconsistency-mcd-monitor-code-status-recompute-needed" });
  }
  return rows;
}

function buildCandidateMatrix(contractRows, localRows) {
  const addressSchema = assertCandidateAddressSchema(contractRows, "summer-fi-pro-contract-seed-candidates");
  const candidates = contractRows.map((candidate) => {
    const terms = [candidate.address, candidate.role, candidate.chain, candidate.protocolLayer].filter(Boolean);
    const candidateRows = localRows.filter((row) => includesAnyTerm(rowSearchText(row), terms));
    const categories = Array.from(new Set(candidateRows.flatMap((row) => row.categories || []))).sort();
    const codeRows = candidateRows.filter((row) => (row.categories || []).includes("codeProof"));
    const triggerRows = candidateRows.filter((row) => (row.categories || []).includes("triggerState"));
    const registryRows = candidateRows.filter((row) => (row.categories || []).some((cat) => ["serviceRegistry", "operationsRegistry"].includes(cat)));
    const permissionRows = candidateRows.filter((row) => (row.categories || []).includes("ownershipProxyPermission"));
    const deprecatedRows = candidateRows.filter((row) => (row.categories || []).includes("deprecatedCommandBalanceAllowance"));
    const positionRows = candidateRows.filter((row) => (row.categories || []).includes("underlyingPosition"));
    const liquidationRows = candidateRows.filter((row) => (row.categories || []).includes("oracleLiquidation"));
    const exitRows = candidateRows.filter((row) => (row.categories || []).some((cat) => ["dexExit", "exactEconomics"].includes(cat)));
    const activeEstimate = Number(candidate.triggerEvents?.activeTriggerEstimate || 0) || 0;
    const isAutomation = candidate.protocolLayer === "automation";
    const isMonitor = candidate.protocolLayer === "monitor";
    const isDataProvider = candidate.protocolLayer === "data-provider";
    const isMorpho = candidate.role === "MorphoBlue";
    const codeStatus = candidate.codePresentKnown === true ? "context-code-present-not-route" : candidate.codePresentKnown === false ? "raw-no-code-or-mismatch" : "missing-current-code-proof";
    const checks = [
      proofCheck({ key: "codePresentContextOnly", status: codeStatus, evidenceRows: codeRows, blocker: "Code presence is context only; it does not establish permissionless value movement or attacker-positive economics." }),
      proofCheck({ key: "decodedActiveTriggerPosition", status: activeEstimate > 0 ? "estimated-trigger-context-needs-decode" : triggerRows.length ? "trigger-context-needs-current-decode" : "missing-or-zero", evidenceRows: triggerRows, blocker: "No decoded active trigger/record maps to exact owner, position, command, collateral, debt, and health." }),
      proofCheck({ key: "ownershipProxyPermission", status: permissionRows.length ? "context-only-no-bypass-proof" : "missing", evidenceRows: permissionRows, blocker: "Owner/proxy/paused/permission constraints are not proven bypassed or irrelevant." }),
      proofCheck({ key: "serviceRegistryOperationsMapping", status: registryRows.length ? "context-only-no-stale-misbinding-profit" : "missing", evidenceRows: registryRows, blocker: "No stale/misbound service, adapter, command, or validator mapping creates attacker-positive value." }),
      proofCheck({ key: "deprecatedCommandBalanceAllowance", status: deprecatedRows.length ? "context-only-no-exploitable-balance-allowance" : "missing", evidenceRows: deprecatedRows, blocker: "No deprecated bot/command retains exploitable balance, allowance, proxy authority, or approval." }),
      proofCheck({ key: "currentUnderlyingLiquidationCondition", status: positionRows.length || liquidationRows.length ? "context-only-no-current-liquidatable-position" : "missing", evidenceRows: [...positionRows, ...liquidationRows], blocker: "No current MakerDAO/Aave/Spark/Morpho managed position is proven liquidatable now." }),
      proofCheck({ key: "exactExitEconomics", status: exitRows.length ? "context-only-no-exact-net-positive-economics" : "missing", evidenceRows: exitRows, blocker: "No exact borrow/liquidation/unwind/DEX/redeem route-size economics are net positive after costs." }),
      proofCheck({ key: "forkValueDeltaProof", status: "missing", evidenceRows: [], blocker: "No local fork/static value-delta proof exists; harness must skip while routePositive=0." }),
    ];
    const status = candidate.codePresentKnown === false
      ? "fail-closed-raw-no-code-or-mismatch"
      : activeEstimate > 0
        ? "watch-estimated-trigger-not-exploit-proof"
        : isDataProvider
          ? "context-data-provider-not-summer-route"
          : isMorpho
            ? "context-underlying-protocol-not-summer-route"
            : isMonitor
              ? "context-monitor-needs-code-and-position-recompute"
              : isAutomation
                ? "automation-context-needs-decoded-position-permission-economics"
                : "context-only-no-route-positive";
    return {
      role: candidate.role,
      chain: candidate.chain,
      chainId: candidate.chainId,
      address: candidate.address,
      normalizedAddress: candidate.normalizedAddress || null,
      addressStatus: candidate.addressStatus,
      candidateAddressValidation: candidate.candidateAddressValidation,
      addressHint: candidate.addressHint || null,
      protocolLayer: candidate.protocolLayer,
      surface: candidate.surface,
      codePresentKnown: candidate.codePresentKnown,
      codeBytes: candidate.codeBytes,
      activeTriggerEstimate: activeEstimate,
      triggerAddedCount: Number(candidate.triggerEvents?.triggerAddedCount || 0) || 0,
      triggerRemovedCount: Number(candidate.triggerEvents?.triggerRemovedCount || 0) || 0,
      ownerKnown: candidate.ownerKnown || null,
      pausedKnown: candidate.pausedKnown ?? null,
      localArtifactRows: candidateRows.length,
      exactLocalRows: candidateRows.filter(exactish).length,
      categories,
      codeContextRows: codeRows.length,
      triggerContextRows: triggerRows.length,
      registryContextRows: registryRows.length,
      permissionContextRows: permissionRows.length,
      deprecatedCommandContextRows: deprecatedRows.length,
      underlyingPositionContextRows: positionRows.length,
      oracleLiquidationContextRows: liquidationRows.length,
      exactEconomicsContextRows: exitRows.length,
      proofChecks: checks,
      routeBlockingProofGaps: checks.map((check) => check.key),
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: false,
      status,
      blocker: "Missing decoded active trigger/position, ownership/proxy permission proof, deprecated command balance/allowance proof, current liquidation condition, exact exit economics, and fork value-delta proof.",
    };
  });
  const proofGapRows = candidates.flatMap((candidate) => candidate.proofChecks.map((check) => ({ role: candidate.role, chain: candidate.chain, gate: check.key, status: check.status, evidenceRows: check.evidenceRows, blocker: check.blocker })));
  return {
    addressSchema,
    candidates,
    proofGapRows,
    summary: {
      candidateRows: candidates.length,
      automationRows: candidates.filter((c) => c.protocolLayer === "automation").length,
      monitorRows: candidates.filter((c) => c.protocolLayer === "monitor").length,
      dataProviderRows: candidates.filter((c) => c.protocolLayer === "data-provider").length,
      morphoRows: candidates.filter((c) => c.role === "MorphoBlue").length,
      codePresentContextRows: candidates.filter((c) => c.codePresentKnown === true).length,
      rawNoCodeOrMismatchRows: candidates.filter((c) => c.codePresentKnown === false).length,
      candidatesWithEstimatedActiveTriggers: candidates.filter((c) => c.activeTriggerEstimate > 0).length,
      activeTriggerEstimateTotal: candidates.reduce((sum, c) => sum + c.activeTriggerEstimate, 0),
      candidatesWithDecodedActiveTriggerPosition: 0,
      candidatesWithPermissionlessTakeoverProof: 0,
      candidatesWithDeprecatedCommandValueProof: 0,
      candidatesWithCurrentLiquidationCondition: 0,
      candidatesWithExactExitEconomics: 0,
      candidatesWithForkValueDeltaProof: 0,
      candidateMatrixProofGapRows: proofGapRows.length,
      validCandidateAddressRows: addressSchema.validRows,
      unresolvedCandidateAddressRows: addressSchema.unresolvedNonAddressRows,
      invalidCandidateAddressRows: addressSchema.invalidNonAddressRows,
      routePositive: 0,
    },
  };
}

function selectNotableRows(rows) {
  const priority = [];
  const files = new Set();
  for (const row of rows) {
    const key = row.file || row.sourceLabel || row.matched;
    const cats = row.categories || [];
    if (row.rowSource === "static-public-fact" || exactish(row) || cats.some((cat) => ["automation", "triggerState", "monitor", "dataProvider", "morpho", "serviceRegistry", "operationsRegistry", "ownershipProxyPermission", "deprecatedCommandBalanceAllowance", "underlyingPosition", "oracleLiquidation", "consumerJoin", "dexExit", "exactEconomics", "forkPrereq", "inconsistency"].includes(cat))) {
      if (!files.has(key) || exactish(row) || row.rowSource === "static-public-fact") { priority.push(row); files.add(key); }
    }
    if (priority.length >= 56) break;
  }
  return priority.length ? priority : rows.slice(0, 28);
}

function loadPriorPrefilter() {
  const artifact = readJson(path.join(WORKSPACE, PREFILTER_JSON_REL)) || {};
  const summary = artifact.summary || {};
  return {
    generatedAt: artifact.generatedAt || null,
    scanner: artifact.scanner || "tools/scan-summer-fi-pro-prefilter.js",
    rawChainResults: Array.isArray(artifact.chainResults) ? artifact.chainResults : [],
    adapter: artifact.adapter ? { source: sanitizeText(artifact.adapter.source, 140), methodology: sanitizeText(artifact.adapter.methodology, 280) } : null,
    hallmark: sanitizeText(artifact.hallmark, 240),
    metadataOk: Boolean(artifact.metadata?.ok),
    contractRows: Number(summary.contractRows || 0) || 0,
    codePresentRows: Number(summary.codePresentRows || 0) || 0,
    localArtifactMatchRows: Number(summary.localArtifactMatchRows || 0) || 0,
    consumerJoinRows: Number(summary.consumerJoinRows || 0) || 0,
    dexLiquidityRows: Number(summary.dexLiquidityRows || 0) || 0,
    maxDexLiquidityUsd: Number(summary.maxDexLiquidityUsd || 0) || 0,
    totalTriggerAdded: Number(summary.totalTriggerAdded || 0) || 0,
    totalTriggerRemoved: Number(summary.totalTriggerRemoved || 0) || 0,
    totalActiveTriggers: Number(summary.totalActiveTriggers || 0) || 0,
    exactEconomicsRows: Number(summary.exactEconomicsRows || 0) || 0,
    rpcBlockedRows: Number(summary.rpcBlockedRows || 0) || 0,
    routePositive: Number(summary.routePositive || 0) || 0,
    executableNow: Number(summary.executableNow || 0) || 0,
    signedActionJustified: Boolean(summary.signedActionJustified || false),
    forkJustified: Boolean(summary.forkJustified || false),
    priorSafetyRpcInventoryRead: Boolean(artifact.safety?.rpcInventoryRead),
    priorSafetyRpcUrlsStored: Boolean(artifact.safety?.rpcUrlsStored),
    blockers: Array.isArray(artifact.blockers) ? artifact.blockers.map((x) => sanitizeText(x, 260)).filter(Boolean) : [],
    nextRoutePositiveCriteria: Array.isArray(artifact.nextRoutePositiveCriteria) ? artifact.nextRoutePositiveCriteria.map((x) => sanitizeText(x, 260)).filter(Boolean) : [],
  };
}

function summarizedPriorPrefilter(priorPrefilter) {
  const { rawChainResults: _rawChainResults, ...safe } = priorPrefilter;
  return safe;
}

function buildPayload({ lineScan, priorPrefilter, priorMdText }) {
  const contractRows = buildContractSeedRows(priorPrefilter);
  const contractAddressSchema = assertCandidateAddressSchema(contractRows, "summer-fi-pro-contract-seed-pre-matrix");
  const inconsistencyRows = buildInconsistencyRows(priorPrefilter, priorMdText);
  const localRows = lineScan.rows;
  const combinedRows = [...STATIC_CONTEXT_ROWS, ...localRows];
  const exactRows = lineScan.exactRows;
  const categoryRows = {};
  for (const category of Object.keys(CATEGORY_RULES)) categoryRows[`${category}Rows`] = pickRows(combinedRows, (row) => (row.categories || []).includes(category), 220);
  const priorPrefilterRows = pickRows(localRows, (row) => row.file && row.file.includes("prefilter-summer-fi-pro"), 220);
  const automationRows = pickRows(combinedRows, (row) => (row.categories || []).includes("automation"), 240);
  const triggerRows = pickRows(combinedRows, (row) => (row.categories || []).includes("triggerState"), 240);
  const consumerJoinRows = pickRows(combinedRows, (row) => (row.categories || []).includes("consumerJoin"), 240);
  const dexExitRows = pickRows(combinedRows, (row) => (row.categories || []).some((cat) => ["dexExit", "exactEconomics"].includes(cat)), 240);
  const exactEconomicsRows = 0;
  const candidateMatrix = buildCandidateMatrix(contractRows, localRows);
  const notableRows = selectNotableRows(combinedRows);
  const priorArtifactPositiveRowsNotPromoted = localRows.filter((row) => row.sourceRoutePositiveNotPromoted).length;
  const routePositive = 0;
  const executableNow = 0;
  const signedActionJustified = false;
  const forkJustified = false;
  const forkGate = "closed-route-positive-zero";
  const summary = {
    sourceFactRows: SOURCE_FACTS.length,
    chainSeedRows: CHAIN_SEEDS.length,
    contractSeedRows: contractRows.length,
    watchFunctionRows: WATCH_FUNCTION_ROWS.length,
    automationSurfaceRows: AUTOMATION_SURFACE_ROWS.length,
    bugClassRows: BUG_CLASS_ROWS.length,
    staticContextRows: STATIC_CONTEXT_ROWS.length,
    inconsistencyRows: inconsistencyRows.length,
    priorPrefilterRows: priorPrefilterRows.length,
    priorPrefilterContractRows: priorPrefilter.contractRows,
    priorPrefilterCodePresentRows: priorPrefilter.codePresentRows,
    priorPrefilterLocalArtifactMatchRows: priorPrefilter.localArtifactMatchRows,
    priorPrefilterConsumerJoinRows: priorPrefilter.consumerJoinRows,
    priorPrefilterDexLiquidityRows: priorPrefilter.dexLiquidityRows,
    priorPrefilterTotalActiveTriggers: priorPrefilter.totalActiveTriggers,
    priorPrefilterExactEconomicsRows: priorPrefilter.exactEconomicsRows,
    filesScanned: lineScan.filesScanned,
    filesWithLocalMatches: lineScan.filesWithMatch,
    filesWithExactLocalMatches: lineScan.filesWithExact,
    localArtifactMatchRows: localRows.length,
    exactLocalArtifactMatchRows: exactRows.length,
    automationRows: automationRows.length,
    triggerStateRows: triggerRows.length,
    monitorRows: categoryRows.monitorRows.length,
    dataProviderRows: categoryRows.dataProviderRows.length,
    morphoRows: categoryRows.morphoRows.length,
    serviceRegistryRows: categoryRows.serviceRegistryRows.length,
    operationsRegistryRows: categoryRows.operationsRegistryRows.length,
    ownershipProxyPermissionRows: categoryRows.ownershipProxyPermissionRows.length,
    deprecatedCommandBalanceAllowanceRows: categoryRows.deprecatedCommandBalanceAllowanceRows.length,
    underlyingPositionRows: categoryRows.underlyingPositionRows.length,
    oracleLiquidationRows: categoryRows.oracleLiquidationRows.length,
    consumerJoinRows: consumerJoinRows.length,
    exactConsumerJoinRows: 0,
    dexExitContextRows: dexExitRows.length,
    exactEconomicsContextRows: categoryRows.exactEconomicsRows.length,
    codeProofRows: categoryRows.codeProofRows.length,
    forkPrereqRows: categoryRows.forkPrereqRows.length,
    candidateMatrixRows: candidateMatrix.summary.candidateRows,
    candidateAutomationRows: candidateMatrix.summary.automationRows,
    candidateMonitorRows: candidateMatrix.summary.monitorRows,
    candidateDataProviderRows: candidateMatrix.summary.dataProviderRows,
    candidateMorphoRows: candidateMatrix.summary.morphoRows,
    candidatesWithCodePresentContext: candidateMatrix.summary.codePresentContextRows,
    rawNoCodeOrMismatchRows: candidateMatrix.summary.rawNoCodeOrMismatchRows,
    candidatesWithEstimatedActiveTriggers: candidateMatrix.summary.candidatesWithEstimatedActiveTriggers,
    activeTriggerEstimateTotal: candidateMatrix.summary.activeTriggerEstimateTotal,
    candidatesWithDecodedActiveTriggerPosition: candidateMatrix.summary.candidatesWithDecodedActiveTriggerPosition,
    candidatesWithPermissionlessTakeoverProof: candidateMatrix.summary.candidatesWithPermissionlessTakeoverProof,
    candidatesWithDeprecatedCommandValueProof: candidateMatrix.summary.candidatesWithDeprecatedCommandValueProof,
    candidatesWithCurrentLiquidationCondition: candidateMatrix.summary.candidatesWithCurrentLiquidationCondition,
    candidatesWithExactExitEconomics: candidateMatrix.summary.candidatesWithExactExitEconomics,
    candidatesWithForkValueDeltaProof: candidateMatrix.summary.candidatesWithForkValueDeltaProof,
    candidateMatrixProofGapRows: candidateMatrix.summary.candidateMatrixProofGapRows,
    priorArtifactPositiveRowsNotPromoted,
    publicFetchRows: 0,
    rpcInventoryRows: 0,
    graphqlInventoryRows: 0,
    ethCallRows: 0,
    forkRows: 0,
    exactEconomicsRows,
    routePositive,
    executableNow,
    signedActionJustified,
    forkJustified,
    forkGate,
    fullTestReadOnlyComplete: true,
    validCandidateAddressRows: candidateMatrix.summary.validCandidateAddressRows,
    unresolvedCandidateAddressRows: candidateMatrix.summary.unresolvedCandidateAddressRows,
    invalidCandidateAddressRows: candidateMatrix.summary.invalidCandidateAddressRows,
  };
  return {
    generatedAt: GENERATED_AT,
    deterministicOutput: true,
    scanner: "tools/scan-summer-fi-pro-full-test.js",
    target: TARGET,
    scope: { kind: "bounded defensive/read-only full-test scanner", artifactStaticLocalFirst: true, publicFactsOnly: true, evmFirst: true, evmFirstChains: TARGET.chains, routeGraph: TARGET.routeGraph, writesLimitedTo: [OUT_JSON_REL, OUT_MD_REL], coordinatorClaim: TARGET.coordinatorClaim, aggregatePromotionStateHandoffEdited: false, endpointPolicy: "No endpoint inventory was read by this full-test scanner; no raw endpoints, domains, keys, or tokens are persisted." },
    safety: { localArtifactsRead: true, publicSourcesRead: false, publicStaticLabelsUsed: true, publicNetworkFetch: false, endpointInventoryRead: false, rpcInventoryRead: false, rpcInventoryRows: 0, graphqlInventoryRead: false, graphqlInventoryRows: 0, envFilesRead: false, privateKeyEnvRead: false, privateKeysRead: false, keyFilesRead: false, keyMaterialRead: false, pemFilesRead: false, keypairJsonRead: false, rawEndpointUrlsStored: false, rpcUrlsStored: false, graphqlUrlsStored: false, rawUrlsStored: false, rawDomainsStored: false, rawKeysTokensStored: false, signedActions: false, liveTransactions: false, broadcasts: false, walletOperations: false, exploitExecuteCalls: false, forkTransactions: false, ethCallOnly: false, sanitizedOutputOnly: true, secretLikePathsExcluded: true },
    sourceFacts: SOURCE_FACTS,
    discoveredSeeds: { chainSeeds: CHAIN_SEEDS, contractRows, watchFunctionRows: WATCH_FUNCTION_ROWS, automationSurfaceRows: AUTOMATION_SURFACE_ROWS },
    addressSchema: { contractSeeds: contractAddressSchema, candidateMatrix: candidateMatrix.addressSchema },
    bugClasses: BUG_CLASS_ROWS,
    priorPrefilter: summarizedPriorPrefilter(priorPrefilter),
    inconsistencyRows,
    staticContextRows: STATIC_CONTEXT_ROWS,
    priorPrefilterRows,
    localArtifacts: { filesScanned: lineScan.filesScanned, filesWithMatch: lineScan.filesWithMatch, filesWithExact: lineScan.filesWithExact, categoryCounts: lineScan.categoryCounts, rows: localRows, exactRows: exactRows.slice(0, 240), notableRows },
    categoryRows: { ...categoryRows, automationRows, triggerRows, consumerJoinRows, exactConsumerJoinRows: [], dexExitRows },
    candidateMatrix,
    rows: notableRows.slice(0, 20),
    routeGate: { routePositive, executableNow, signedActionJustified, forkJustified, forkGate, exactPermissionlessValueMovement: false, decodedActiveTriggerPositionProof: false, ownershipProxyPermissionProof: false, deprecatedCommandBalanceAllowanceProof: false, currentLiquidationConditionProof: false, exactPositiveEconomics: false, localForkStaticProof: false, exactEconomicsRows, status: "dormant-fail-closed", reason: "Static/local scan found automation, bot, monitor, data-provider, Morpho, trigger, registry, permission, underlying-position, liquidation, DEX/economics context only; no decoded active trigger/position, permissionless takeover/execute path, deprecated authority value, current liquidatable position, exact positive economics, or fork value-delta proof is present." },
    blockers: BLOCKERS,
    requiredForRoutePositive: REQUIRED_FOR_ROUTE_POSITIVE,
    nextReadOnlyStep: NEXT_READ_ONLY_STEP,
    summary,
  };
}

function metricRows(summary) {
  const keys = ["sourceFactRows", "chainSeedRows", "contractSeedRows", "watchFunctionRows", "automationSurfaceRows", "bugClassRows", "staticContextRows", "inconsistencyRows", "priorPrefilterRows", "priorPrefilterContractRows", "priorPrefilterCodePresentRows", "priorPrefilterLocalArtifactMatchRows", "priorPrefilterConsumerJoinRows", "priorPrefilterDexLiquidityRows", "priorPrefilterTotalActiveTriggers", "priorPrefilterExactEconomicsRows", "filesScanned", "filesWithLocalMatches", "filesWithExactLocalMatches", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "automationRows", "triggerStateRows", "monitorRows", "dataProviderRows", "morphoRows", "serviceRegistryRows", "operationsRegistryRows", "ownershipProxyPermissionRows", "deprecatedCommandBalanceAllowanceRows", "underlyingPositionRows", "oracleLiquidationRows", "consumerJoinRows", "exactConsumerJoinRows", "dexExitContextRows", "exactEconomicsContextRows", "codeProofRows", "forkPrereqRows", "candidateMatrixRows", "candidateAutomationRows", "candidateMonitorRows", "candidateDataProviderRows", "candidateMorphoRows", "validCandidateAddressRows", "unresolvedCandidateAddressRows", "invalidCandidateAddressRows", "candidatesWithCodePresentContext", "rawNoCodeOrMismatchRows", "candidatesWithEstimatedActiveTriggers", "activeTriggerEstimateTotal", "candidatesWithDecodedActiveTriggerPosition", "candidatesWithPermissionlessTakeoverProof", "candidatesWithDeprecatedCommandValueProof", "candidatesWithCurrentLiquidationCondition", "candidatesWithExactExitEconomics", "candidatesWithForkValueDeltaProof", "candidateMatrixProofGapRows", "priorArtifactPositiveRowsNotPromoted", "publicFetchRows", "rpcInventoryRows", "graphqlInventoryRows", "ethCallRows", "forkRows", "exactEconomicsRows", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate", "fullTestReadOnlyComplete"];
  return keys.map((key) => `| ${key} | ${mdEscape(summary[key])} |`).join("\n");
}
function safetyRows(safety) { return ["localArtifactsRead", "publicSourcesRead", "publicStaticLabelsUsed", "publicNetworkFetch", "endpointInventoryRead", "rpcInventoryRead", "graphqlInventoryRead", "envFilesRead", "privateKeysRead", "keyMaterialRead", "rawEndpointUrlsStored", "rpcUrlsStored", "graphqlUrlsStored", "rawUrlsStored", "rawDomainsStored", "rawKeysTokensStored", "signedActions", "liveTransactions", "broadcasts", "walletOperations", "forkTransactions", "sanitizedOutputOnly", "secretLikePathsExcluded"].map((key) => `| ${key} | ${mdEscape(safety[key])} |`).join("\n"); }
function shortAddress(value) { const text = String(value || ""); return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}...${text.slice(-4)}` : text; }
function displayAddress(row) { return normalizeAddress(row?.address) ? shortAddress(row.address) : (row?.addressHint || row?.addressStatus || "unresolved-non-address"); }
function formatContractRow(row) { return `| ${mdEscape(row.role)} | ${mdEscape(row.chain)} | ${mdEscape(displayAddress(row))} | ${mdEscape(row.protocolLayer)} | ${mdEscape(row.codePresentKnown)} | ${mdEscape(row.activeTriggerEstimate || row.triggerEvents?.activeTriggerEstimate || 0)} | ${mdEscape(row.classification)} |`; }
function formatSurfaceRow(row) { return `| ${mdEscape(row.component)} | ${mdEscape(row.surface)} | ${mdEscape(row.routeRole)} | ${mdEscape((row.watchTerms || []).join(", "))} |`; }
function formatWatchRow(row) { return `| ${mdEscape(row.component)} | ${mdEscape(row.signature)} | ${mdEscape(row.selectorOrEvent)} | ${mdEscape(row.routeRole)} |`; }
function formatCandidateRow(row) { const evidence = `local=${row.localArtifactRows}, exact=${row.exactLocalRows}, code=${row.codePresentKnown}, activeEst=${row.activeTriggerEstimate}, trigger=${row.triggerContextRows}, liquidation=${row.oracleLiquidationContextRows}, econ=${row.exactEconomicsContextRows}`; return `| ${mdEscape(row.role)} | ${mdEscape(row.chain)} | ${mdEscape(displayAddress(row))} | ${mdEscape(evidence)} | ${mdEscape(row.routeBlockingProofGaps.join(", "))} | ${mdEscape(row.status)} |`; }
function formatBugClassRow(row) { return `| ${mdEscape(row.label)} | ${mdEscape(row.surface)} | ${mdEscape(row.routeBlockingGap)} | ${mdEscape(row.classification)} |`; }
function formatInconsistencyRow(row) { return `| ${mdEscape(row.kind)} | ${mdEscape(row.rawOptimismActiveTriggerEstimate ?? row.rawCodePresent)} | ${mdEscape(row.rawBaseActiveTriggerEstimate ?? row.rawCodeBytes)} | ${mdEscape(row.priorMarkdownSaysBaseHoldsAll80 ?? row.priorMarkdownCodeYes)} | ${mdEscape(row.routeImpact)} |`; }
function formatLocalRow(row) { return `| ${mdEscape(sourceForRow(row))} | ${mdEscape((row.categories || []).join(","))} | ${mdEscape(row.matched)} | ${mdEscape(row.sample || "context-only")} | ${mdEscape(row.routePositive)} | ${mdEscape(row.classification)} |`; }

function buildMarkdown(payload) {
  const notableRows = payload.localArtifacts.notableRows.length ? payload.localArtifacts.notableRows.map(formatLocalRow).join("\n") : "| (none) | n/a | n/a | no local context rows found | 0 | dormant |";
  const inconsistencyRows = payload.inconsistencyRows.length ? payload.inconsistencyRows.map(formatInconsistencyRow).join("\n") : "| (none) | n/a | n/a | false | no prior inconsistency detected |";
  return `# 🟢 DORMANT - Summer.fi Pro / Oasis Full Test

Generated: ${payload.generatedAt}

Route remains closed: routePositive=${payload.routeGate.routePositive}, executableNow=${payload.routeGate.executableNow}, signedActionJustified=${payload.routeGate.signedActionJustified}, forkJustified=${payload.routeGate.forkJustified}, forkGate=${payload.routeGate.forkGate}.

## Target Context

- Target: ${payload.target.name} (${payload.target.protocolSlug}/${payload.target.slug}), category=${payload.target.category}, surface=${payload.target.surface}, TVL context≈${payload.target.tvlContext}.
- EVM scope: ${payload.scope.evmFirstChains.join(", ")}.
- Route graph: ${payload.target.routeGraph}.
- Existing coverage: prior prefilter has contractRows=${payload.priorPrefilter.contractRows}, codePresentRows=${payload.priorPrefilter.codePresentRows}, totalActiveTriggers=${payload.priorPrefilter.totalActiveTriggers}, consumerJoinRows=${payload.priorPrefilter.consumerJoinRows}, dexLiquidityRows=${payload.priorPrefilter.dexLiquidityRows}, exactEconomicsRows=${payload.priorPrefilter.exactEconomicsRows}, routePositive=${payload.priorPrefilter.routePositive}.
- Fail-closed caveat: active trigger estimates are not exploitable positions; trigger attribution and McdMonitorV2 code status require recompute before any promotion.
- Address schema: candidate-address assertion=${payload.addressSchema.candidateMatrix.assertion}; valid=${payload.addressSchema.candidateMatrix.validRows}, unresolved=${payload.addressSchema.candidateMatrix.unresolvedNonAddressRows}, invalid=${payload.addressSchema.candidateMatrix.invalidNonAddressRows}. Unresolved non-address seeds are explicit sentinels and excluded from candidate-address validation.

## Metrics

| Metric | Value |
|---|---:|
${metricRows(payload.summary)}

## Safety Summary

| Field | Value |
|---|---:|
${safetyRows(payload.safety)}

## Contract Seeds From Prior Prefilter / Config

| Role | Chain | Address | Layer | Code Present | Active Trigger Estimate | Classification |
|---|---|---|---|---:|---:|---|
${payload.discoveredSeeds.contractRows.map(formatContractRow).join("\n")}

## Automation Surface Checklist

| Component | Surface | Route Role | Watch Terms |
|---|---|---|---|
${payload.discoveredSeeds.automationSurfaceRows.map(formatSurfaceRow).join("\n")}

## Watch Functions / Selectors / Events

| Component | Signature/Event | Selector/Event | Route Role |
|---|---|---|---|
${payload.discoveredSeeds.watchFunctionRows.map(formatWatchRow).join("\n")}

## Static Candidate Matrix (fail-closed)

| Candidate | Chain | Address | Local Evidence | Missing Current Proofs | Status |
|---|---|---|---|---|---|
${payload.candidateMatrix.candidates.map(formatCandidateRow).join("\n")}

Code-present rows remain context only. Route-positive status requires decoded active trigger/position, permission/proxy proof, deprecated command balance/allowance proof if applicable, current liquidation condition, exact exit economics, and local fork/static value-delta proof.

## Prior Artifact Inconsistencies To Preserve / Recompute

| Kind | Raw A | Raw B | Prior Markdown Flag | Route Impact |
|---|---:|---:|---:|---|
${inconsistencyRows}

## Bug Classes / Proof Gaps

| Class | Surface | Route-Blocking Gap | Classification |
|---|---|---|---|
${payload.bugClasses.map(formatBugClassRow).join("\n")}

## Notable Local / Static Rows

| Source | Categories | Match | Detail | Route | Classification |
|---|---|---|---|---:|---|
${notableRows}

## Route Gate

- Status: ${payload.routeGate.status}.
- Required fail-closed conjunction is absent: decodedActiveTriggerPositionProof=${payload.routeGate.decodedActiveTriggerPositionProof}, ownershipProxyPermissionProof=${payload.routeGate.ownershipProxyPermissionProof}, deprecatedCommandBalanceAllowanceProof=${payload.routeGate.deprecatedCommandBalanceAllowanceProof}, currentLiquidationConditionProof=${payload.routeGate.currentLiquidationConditionProof}, exactPositiveEconomics=${payload.routeGate.exactPositiveEconomics}, localForkStaticProof=${payload.routeGate.localForkStaticProof}.
- No attacker-positive automation takeover/execute, deprecated command/bot value, current underlying liquidation, stale/misbound oracle/action profit, exact economics, or fork value-delta proof was resolved.
- Fork gate: ${payload.routeGate.forkGate}.

## Blockers

${payload.blockers.map((item) => `- ${item}`).join("\n")}

## Required For RoutePositive

${payload.requiredForRoutePositive.map((item) => `- ${item}`).join("\n")}

## Next Read-Only Step

${payload.nextReadOnlyStep}
`;
}

function main() {
  log("Scanning Summer.fi Pro local artifacts (sanitized, no endpoint inventory read)...");
  const files = listScanFiles();
  const lineScan = scanLocalArtifactLines(files);
  const priorPrefilter = loadPriorPrefilter();
  const priorMdText = readText(path.join(WORKSPACE, PREFILTER_MD_REL)) || "";
  const payload = buildPayload({ lineScan, priorPrefilter, priorMdText });
  writeJson(OUT_JSON, payload);
  writeText(OUT_MD, buildMarkdown(payload));
  log(`Wrote ${OUT_JSON_REL} and ${OUT_MD_REL}`);
  log(`routePositive=${payload.summary.routePositive}; exactEconomicsRows=${payload.summary.exactEconomicsRows}; localArtifactMatchRows=${payload.summary.localArtifactMatchRows}; candidateMatrixRows=${payload.summary.candidateMatrixRows}; inconsistencies=${payload.summary.inconsistencyRows}`);
}

main();
