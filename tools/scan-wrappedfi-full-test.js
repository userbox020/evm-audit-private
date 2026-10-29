#!/usr/bin/env node
"use strict";

// scan-wrappedfi-full-test.js
// Defensive Wrapped / WrappedFi full-test scanner. Deterministic local/static
// public-context only; no endpoint inventory reads, network calls, RPC, forks,
// signed actions, broadcasts, or wallets.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "wrappedfi-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "wrappedfi-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/wrappedfi-full-test.json";
const OUT_MD_REL = "reports/wrappedfi-full-test-triage.md";
const PREFILTER_JSON_REL = "reports/raw/fast/prefilter-wrappedfi-route-prefilter.json";
const PREFILTER_MD_REL = "reports/prefilter-wrappedfi-route-prefilter.md";

const QUIET = process.argv.includes("--quiet");
const GENERATED_AT = process.env.SCAN_GENERATED_AT || "2026-07-07T00:00:00.000Z";
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_LOCAL_MATCH_ROWS = 820;
const MAX_ROWS_PER_FILE = 40;

const TARGET = {
  slug: "wrappedfi",
  protocolSlug: "wrapped",
  name: "Wrapped / WrappedFi",
  category: "Bridge",
  surface: "bridge-proof-custody-consumer",
  discoveryTvlContext: "$18.662M",
  prefilterTvlContext: "$21.189M",
  primaryChains: ["Ethereum", "Celo"],
  caveatChains: ["Ripple"],
  routeGraph: "custody/backing or proof state -> wrapped asset -> lending/DEX consumer -> borrow/unlock/exit",
  module: "wrappedfi.js",
  adapterFetched: true,
  adapterAddressCount: 2,
  coordinatorClaim: "coordinator-wrappedfi-fulltest-01",
};

const CHAIN_SEEDS = [
  { chain: "Ethereum", chainLabel: "Ethereum", chainId: 1, adapterKey: "ethereum", evmFirst: true, caveat: false, classification: "primary-evm-bridge-chain" },
  { chain: "Celo", chainLabel: "Celo", chainId: 42220, adapterKey: "celo", evmFirst: true, caveat: false, classification: "primary-evm-bridge-chain" },
  { chain: "Ripple", chainLabel: "Ripple", chainId: null, adapterKey: "ripple", evmFirst: false, caveat: true, classification: "non-evm-custody-chain-caveat" },
];

const ADDRESS_ROWS = [
  { role: "adapter fallback custody owner sample", chain: "Ethereum", chainId: 1, address: "0x84d9dcAc2f00F2Cd903E340b5241EB6e5c198572", surface: "custody owner sample from prefilter; no contract code in prior probe", codePresentKnown: false, classification: "prefilter-no-code-static-custody-owner-sample" },
  { role: "adapter fallback custody owner sample", chain: "Celo", chainId: 42220, address: "0x84d9dcAc2f00F2Cd903E340b5241EB6e5c198572", surface: "custody owner sample from prefilter; no contract code in prior probe", codePresentKnown: false, classification: "prefilter-no-code-static-custody-owner-sample" },
  { role: "adapter fallback custody owner sample", chain: "Ethereum", chainId: 1, address: "0xD6873b9592AB601E6cE6a6A781799d54961942F3", surface: "custody owner sample from prefilter; no contract code in prior probe", codePresentKnown: false, classification: "prefilter-no-code-static-custody-owner-sample" },
  { role: "adapter fallback custody owner sample", chain: "Celo", chainId: 42220, address: "0xD6873b9592AB601E6cE6a6A781799d54961942F3", surface: "custody owner sample from prefilter; no contract code in prior probe", codePresentKnown: false, classification: "prefilter-no-code-static-custody-owner-sample" },
  { role: "WXRP token", chain: "Ethereum", chainId: 1, address: "0x39fBBABf11738317a448031930706cd3e612e1B9", implementation: "0x43C3983778Ec88F0c383134E812C0c58A819aDD0", symbol: "WXRP", surface: "public WXRP wrapped token context; code/state not refreshed in this pass", codePresentKnown: null, classification: "public-static-wxrp-token-not-current-state-proof" },
  { role: "WXRP implementation", chain: "Ethereum", chainId: 1, address: "0x43C3983778Ec88F0c383134E812C0c58A819aDD0", symbol: "WXRP", surface: "public implementation context; not proof of active proxy or value path", codePresentKnown: null, classification: "public-static-implementation-not-route-proof" },
  { role: "Ripple custody owner", chain: "Ripple", chainId: null, address: "r4Pr9aBnqN84hbkmJo4HwUtLj63E5vGFyE", surface: "non-EVM custody owner/caveat", codePresentKnown: null, classification: "non-evm-ripple-custody-caveat-not-local-proof" },
];

const CANDIDATE_ROWS = ADDRESS_ROWS.filter((row) => row.role !== "WXRP implementation");

const PUBLIC_DOC_ROWS = [
  "Wrapped / WrappedFi is treated as Bridge category context with Ethereum, Celo, and Ripple chain scope; Ripple remains non-EVM caveat.",
  "TVL methodology context says underlying capital is held in custody; custody/backing reconciliation is required before route-positive status.",
  "Public recon found Ethereum WXRP token and implementation context, plus Ripple custody owner context, but no current local live state was refreshed here.",
  "Current public site context appears RWA/stablecoin-oriented and legacy bridge docs are not obvious; this scanner treats docs as static context only.",
  "X/public context mentions WXRP, SushiSwap, onXRP, and Chainlink; these are watch terms, not consumer/exit proof.",
];

const SURFACE_ROWS = [
  { component: "custody/backing", surface: "underlying capital held in custody", routeRole: "backing/custody proof gap", watchTerms: ["custody", "backing", "underlying", "owner"] },
  { component: "proof/domain/nonce", surface: "proof state, domain binding, nonce/replay", routeRole: "proof bypass or replay route", watchTerms: ["proof", "domain", "nonce", "processedMessages", "claimed", "usedNonces"] },
  { component: "mint/burn/unlock/redeem", surface: "wrapped asset mint, burn, unlock, redeem, withdraw", routeRole: "value-moving selectors", watchTerms: ["mint", "burn", "burnFrom", "redeem", "withdraw", "unlock", "completeTransfer"] },
  { component: "role/admin/proxy/gateway", surface: "owner/admin/minter/pauser/gateway/proxy controls", routeRole: "role/admin blocker", watchTerms: ["owner", "admin", "minter", "pauser", "gateway", "proxy"] },
  { component: "Ripple caveat", surface: "Ripple custody owner and non-EVM proof state", routeRole: "non-EVM coverage caveat", watchTerms: ["Ripple", "r4Pr9aBnqN84hbkmJo4HwUtLj63E5vGFyE"] },
  { component: "WXRP token", surface: "Ethereum WXRP token and implementation", routeRole: "wrapped asset producer", watchTerms: ["WXRP", "0x39fBBABf11738317a448031930706cd3e612e1B9"] },
  { component: "consumer joins", surface: "lending/oracle/DEX consumer acceptance", routeRole: "borrow/unlock/exit", watchTerms: ["Aave", "Compound", "Euler", "Morpho", "Silo", "consumer", "collateral"] },
  { component: "DEX/exit", surface: "SushiSwap/onXRP/Uniswap/Curve/Balancer exit liquidity", routeRole: "sell/redeem/unwind economics", watchTerms: ["SushiSwap", "onXRP", "DEX", "pool", "liquidity", "swap"] },
  { component: "local fork prerequisites", surface: "route-positive candidate, code-present address, value-moving selector, exact positive economics", routeRole: "fork harness gate", watchTerms: ["routePositive", "codePresent", "netLiquidUsd", "valueDelta"] },
];

const BUG_CLASS_ROWS = [
  { label: "custody/backing mismatch", surface: "custody or escrow accounting", classification: "bug-class-context-no-current-backing-proof" },
  { label: "proof/domain/nonce replay or underbinding", surface: "proof/message verification", classification: "bug-class-context-no-deployed-proof-bypass" },
  { label: "permissionless mint/unlock/redeem bypass", surface: "mint/burn/unlock/redeem selectors", classification: "bug-class-context-no-code-present-path" },
  { label: "role/admin/gateway misconfiguration", surface: "owner/admin/minter/pauser/gateway/proxy", classification: "bug-class-context-role-admin-blocked" },
  { label: "wrapped asset accepted by solvent consumer", surface: "lending/DEX consumer", classification: "bug-class-context-no-consumer-join" },
  { label: "DEX/exit value below marked wrapped value", surface: "DEX/redeem exit", classification: "bug-class-context-no-exact-exit-economics" },
  { label: "Ripple custody state divergence", surface: "non-EVM custody", classification: "bug-class-caveat-no-local-ripple-proof" },
  { label: "fork proof attempted before route-positive", surface: "local fork harness", classification: "bug-class-gated-by-route-positive" },
];

const SOURCE_FACTS = [
  { sourceLabel: "target-context:WrappedFi", kind: "target-seed", slug: TARGET.slug, protocolSlug: TARGET.protocolSlug, name: TARGET.name, category: TARGET.category, surface: TARGET.surface, discoveryTvlContext: TARGET.discoveryTvlContext, prefilterTvlContext: TARGET.prefilterTvlContext, chains: [...TARGET.primaryChains, ...TARGET.caveatChains], module: TARGET.module, adapterAddressCount: TARGET.adapterAddressCount, routePositive: 0, classification: "structured-target-seed-route-negative" },
  { sourceLabel: "prior-prefilter-artifact:wrappedfi-route-prefilter", kind: "local-prefilter-context", artifacts: [PREFILTER_JSON_REL, PREFILTER_MD_REL], priorCodePresentRows: 0, priorConsumerJoinRows: 0, priorBridgeProbeRows: 0, priorRoutePositive: 0, classification: "prior-prefilter-context-no-route-positive" },
  { sourceLabel: "public-docs-wrappedfi-model", kind: "public-static-label", model: "Bridge/custody model with wrapped asset and underlying capital held in custody; public docs do not establish deployed proof-bypass route.", classification: "public-docs-context-no-current-route-proof" },
  { sourceLabel: "local-consumer-and-exit-context", kind: "local-artifact-context", artifacts: ["reports/raw/fast/consumer-first-high-ltv-collateral.json", "reports/raw/fast/aave-euler-silo-consumer-graph.json", "reports/raw/fast/dex-consumer-routes.json", "reports/raw/fast/dex-exit-quotes.json", "reports/raw/fast/bridge-nonlossless-collateral-join.json"], classification: "local-consumer-exit-context-only-no-wrappedfi-route-positive" },
];

const STATIC_CONTEXT_ROWS = [
  { sourceLabel: "evm-custody-samples", matched: "Ethereum/Celo custody owner samples", categories: ["custodyBacking", "codeProof", "forkPrereq"], sample: "Prefilter found four EVM address rows across two samples with codePresentRows=0; samples are not deployed bridge contracts in current local proof.", classification: "no-code-static-samples-no-route-positive" },
  { sourceLabel: "wxrp-token-row", matched: "Ethereum WXRP token and implementation", categories: ["wxrpToken", "mintBurnUnlockRedeem", "adminRoleGateway", "consumerJoin", "dexLiquidity"], sample: "WXRP token/implementation are public static context only until active proxy, code, state, consumer, and exit economics are proven.", classification: "wxrp-static-context-no-current-state-proof" },
  { sourceLabel: "ripple-custody-row", matched: "Ripple custody owner", categories: ["rippleCaveat", "custodyBacking", "proofDomainNonce"], sample: "Ripple custody owner is non-EVM; no local EVM fork proof can validate Ripple custody/proof state.", classification: "ripple-non-evm-caveat" },
  { sourceLabel: "proof-domain-row", matched: "proof/domain/nonce selectors", categories: ["proofDomainNonce", "mintBurnUnlockRedeem", "economics"], sample: "No deployed proof verifier, domain binding, nonce replay, processed message, claimed, or used nonce bypass is proven.", classification: "proof-context-no-bypass" },
  { sourceLabel: "consumer-exit-row", matched: "consumer/DEX route", categories: ["consumerJoin", "dexLiquidity", "exitLiquidity", "economics"], sample: "Wrapped asset must be sold/redeemed/accepted by solvent consumer with netLiquidUsd > 0 before route-positive status.", classification: "consumer-exit-context-no-exact-economics" },
  { sourceLabel: "fork-prereq-row", matched: "local fork prerequisites", categories: ["forkPrereq", "codeProof", "economics"], sample: "Fork harness is non-meaningful until code-present value-moving route-positive candidate with exact positive economics exists.", classification: "fork-gated-route-positive-zero" },
].map((row) => ({ rowSource: "static-public-fact", matchType: "static-public-fact", termType: "static", routePositive: 0, sourceRoutePositiveNotPromoted: false, ...row }));

const EXPLICIT_FILES = [
  PREFILTER_JSON_REL,
  PREFILTER_MD_REL,
  "reports/raw/fast/prefilter-deep-new-target-search-2026-06-24.json",
  "reports/raw/fast/consumer-first-high-ltv-collateral.json",
  "reports/raw/fast/aave-euler-silo-consumer-graph.json",
  "reports/raw/fast/euler-v2-phase0.json",
  "reports/raw/fast/silo-v2-phase0.json",
  "reports/raw/fast/morpho-high-apy-liquidation-routes.json",
  "reports/raw/fast/erc4626-consumer-joiner.json",
  "reports/raw/fast/dex-consumer-routes.json",
  "reports/raw/fast/dex-exit-quotes.json",
  "reports/raw/fast/bridge-nonlossless-collateral-join.json",
  "reports/raw/fast/bridge-delta-preflight.json",
  "reports/raw/fast/bridge-synthetic-consumer-exposure.json",
  "reports/raw/fast/bridge-proof-binding.json",
  "reports/raw/fast/fake-asset-pool-validation.json",
  "reports/raw/fast/base-bridge-phase0.json",
  "reports/raw/fast/ccip-phase0.json",
  "reports/raw/fast/uniswap-v2-phase0.json",
  "reports/raw/fast/uniswap-v3-phase0.json",
  "reports/raw/fast/curve-dex-phase0.json",
  "reports/raw/fast/balancer-v3-phase0.json",
];

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

const EVM_ADDRESS_RULES = ADDRESS_ROWS
  .filter((row) => /^0x[0-9a-fA-F]{40}$/.test(row.address))
  .map((row) => ({ label: `${row.role} ${row.address}`, regex: new RegExp(escapeRegExp(row.address), "i") }));

const EXACT_RULES = [
  { label: "wrappedfi", regex: /\bwrappedfi\b/i },
  { label: "wrappedfi.js", regex: /\bwrappedfi\.js\b/i },
  { label: "prefilter-wrappedfi-route-prefilter", regex: /\bprefilter-wrappedfi-route-prefilter\b/i },
  { label: "WXRP", regex: /\bWXRP\b/i },
  { label: "Ripple custody owner", regex: /\br4Pr9aBnqN84hbkmJo4HwUtLj63E5vGFyE\b/i },
  ...EVM_ADDRESS_RULES,
];

const CONTEXT_RULES = [
  { label: "custody/backing", regex: /\b(?:custody|backing|escrow|underlying|reserve|owner)\b/i },
  { label: "proof/domain/nonce", regex: /\b(?:proof|domain|nonce|processedMessages|claimed|usedNonces|message|attestation|signature|replay)\b/i },
  { label: "mint/burn/unlock/redeem", regex: /\b(?:mint|burn|burnFrom|redeem|withdraw|claim|unlock|completeTransfer|finalizeBridgeERC20|executeMessage)\b/i },
  { label: "role/admin/gateway", regex: /\b(?:role|owner|admin|proxy|minter|pauser|guardian|gateway|bridge|verifier|implementation)\b/i },
  { label: "Ripple", regex: /\b(?:Ripple|XRP|onXRP)\b/i },
  { label: "consumer", regex: /\b(?:consumer|collateral|borrow|lending|market|Aave|Compound|Comet|Euler|Morpho|Silo)\b/i },
  { label: "DEX/exit", regex: /\b(?:DEX|swap|pool|liquidity|SushiSwap|Uniswap|Curve|Balancer|exit|sell|slippage)\b/i },
  { label: "fork/value delta", regex: /\b(?:fork|anvil|valueDelta|netLiquidUsd|routePositive|executableNow|codePresent)\b/i },
];

const CATEGORY_RULES = {
  custodyBacking: ["custody", "backing", "escrow", "underlying", "reserve", "owner", "wrapped"],
  proofDomainNonce: ["proof", "domain", "nonce", "processedmessages", "claimed", "usednonces", "message", "attestation", "signature", "replay"],
  mintBurnUnlockRedeem: ["mint", "burn", "burnfrom", "redeem", "withdraw", "claim", "unlock", "completetransfer", "finalizebridgeerc20", "executemessage"],
  adminRoleGateway: ["role", "owner", "admin", "proxy", "minter", "pauser", "guardian", "gateway", "verifier", "implementation"],
  rippleCaveat: ["ripple", "xrp", "onxrp", "r4pr9abnqn84hbkmjo4hwutlj63e5vgfye"],
  wxrpToken: ["wxrp", "0x39fbbabf11738317a448031930706cd3e612e1b9", "0x43c3983778ec88f0c383134e812c0c58a819add0"],
  codeProof: ["codepresent", "codebytes", "empty-code", "no-contract-code", "skipped-no-code", "implementation"],
  consumerJoin: ["consumer", "collateral", "borrow", "lending", "market", "aave", "compound", "comet", "euler", "morpho", "silo", "lltv", "ltv"],
  dexLiquidity: ["dex", "swap", "pool", "liquidity", "sushiswap", "uniswap", "curve", "balancer", "amm"],
  exitLiquidity: ["exit", "sell", "unwind", "redeem", "withdraw", "swap", "liquidity", "burn", "unlock"],
  economics: ["routepositive", "executable", "profit", "positive", "netliquidusd", "valuedelta", "liquidityusd", "exacteconomics", "slippage", "gas"],
  forkPrereq: ["fork", "anvil", "localhost", "codepresent", "routepositive", "valuedelta", "netliquidusd"],
};

const FORK_ROUTE_PREREQUISITES = [
  "routePositive candidate exists in scanner artifact",
  "deployed code-present bridge/wrapper/gateway/escrow/verifier/wrapped ERC20 is identified",
  "permissionless value-moving selector and proof/nonce/domain state are proven reachable",
  "asset linkage to custody/backing or wrapped token is exact",
  "consumer/DEX/redeem exit has exact positive netLiquidUsd > 0",
  "local fork uses ephemeral local accounts only, no privileged impersonation/storage/code edits beyond gas funding, and no broadcast",
];

const BLOCKERS = [
  "Known EVM candidate samples are no-code/static custody owner rows in prior prefilter; no deployed code-present bridge/wrapper/gateway/escrow/verifier route is proven.",
  "WXRP token and implementation rows are public static context only; active proxy/state, custody backing, consumer acceptance, and exit economics are not proven.",
  "Ripple custody owner is non-EVM and remains a caveat; no local EVM fork can validate Ripple custody/proof state.",
  "No proof/domain/nonce/recipient binding bypass, processed-message replay, claim reuse, or used-nonce flaw is proven.",
  "No material lending/DEX consumer accepts a proven WrappedFi wrapped asset with exact positive borrow/unlock/exit economics.",
  "Wrapped token is marked at zero unless sold/redeemed/accepted by a solvent consumer with exact positive netLiquidUsd.",
  "Local fork route harness is intentionally inert because routePositive=0 and code-present value-moving candidate is absent.",
  "No fork/static value-delta proof and no signed action justified.",
];

const REQUIRED_FOR_ROUTE_POSITIVE = [
  "Code-present deployed bridge/wrapper/gateway/escrow/verifier/wrapped ERC20 is mapped for Ethereum or Celo, with Ripple dependency resolved if relevant.",
  "Permissionless mint, burn, burnFrom, redeem, withdraw, claim(bytes), completeTransfer(bytes), finalizeBridgeERC20, unlock, or executeMessage path is reachable without privileged roles.",
  "Proof/domain/nonce/recipient/token binding flaw or custody/backing mismatch is proven for a specific asset and chain pair.",
  "Wrapped asset is accepted by a material solvent lending/DEX/redeem consumer or has exact route-size exit liquidity.",
  "Exact economics show netLiquidUsd > 0 after gas, fees, slippage, bridge costs, and any finality/custody constraints.",
  "Local fork/value-delta harness demonstrates positive attacker-controlled balance movement using only ephemeral local accounts and no broadcast.",
  "Independent defensive review and explicit route-specific authorization before any signed transaction consideration.",
];

const NEXT_READ_ONLY_STEP = "Keep WrappedFi dormant until a code-present bridge/wrapper/gateway/escrow/verifier/wrapped ERC20 maps to a permissionless proof/custody or mint/unlock path plus a solvent consumer/DEX/redeem exit with exact positive economics; then run the local-only fork harness for value-delta proof.";

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

function pickRows(rows, predicate, max = 140) {
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
  if (r === "tools/scan-wrappedfi-full-test.js") return true;
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
  return listFilesRecursive(fast, (file) => /(?:wrappedfi|wrapped|wxrp|ripple|xrp|bridge|proof|consumer|aave|euler|silo|compound|morpho|dex|exit|curve|balancer|uniswap|sushi|custody|gateway|nonce|domain)/i.test(path.basename(file)));
}

function listScanFiles() {
  const files = [];
  for (const file of EXPLICIT_FILES) {
    const full = path.join(WORKSPACE, file);
    if (fs.existsSync(full) && !isExcludedScanPath(full)) files.push(full);
  }
  files.push(...listRelatedReportFiles());
  return uniqBy(files, (file) => path.resolve(file));
}

function firstRuleMatch(text, rules) {
  const raw = String(text || "");
  for (const rule of rules) { rule.regex.lastIndex = 0; if (rule.regex.test(raw)) return rule; }
  return null;
}
function hasRuleMatch(text, rules) { return Boolean(firstRuleMatch(text, rules)); }

function matchForText(line, windowText) {
  const exact = firstRuleMatch(line, EXACT_RULES) || firstRuleMatch(windowText, EXACT_RULES);
  if (exact) return { matchType: "exact-name-address-token-module", matched: exact.label, termType: "text" };
  const context = firstRuleMatch(line, CONTEXT_RULES) || firstRuleMatch(windowText, CONTEXT_RULES);
  if (!context) return null;
  if (hasRuleMatch(windowText, EXACT_RULES)) return { matchType: "context", matched: context.label, termType: "text" };
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
  if (r.includes("prefilter-wrappedfi")) return "prior-prefilter-context-only-no-route-positive";
  if (categories.includes("rippleCaveat")) return "ripple-non-evm-context-caveat-no-local-proof";
  if (categories.includes("proofDomainNonce")) return "proof-domain-context-only-no-deployed-bypass";
  if (categories.includes("custodyBacking")) return "custody-backing-context-only-no-reconciliation";
  if (categories.includes("consumerJoin")) return "consumer-context-only-no-wrappedfi-exact-route";
  if (categories.includes("dexLiquidity") || categories.includes("exitLiquidity")) return "dex-exit-context-only-no-exact-economics";
  if (categories.includes("adminRoleGateway") || categories.includes("mintBurnUnlockRedeem")) return "role-or-selector-context-only-no-permissionless-proof";
  return match.matchType === "exact-name-address-token-module" ? "exact-local-watch-context-only-no-current-positive-economics" : "local-artifact-watch-context-only-no-route-positive";
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
      const match = matchForText(line, windowText);
      if (!match) continue;
      const key = `${rel(file)}:${i + 1}:${match.matchType}:${match.matched}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fileMatched = true;
      if (match.matchType === "exact-name-address-token-module") fileExact = true;
      const categories = categoriesFor(windowText, rel(file));
      for (const category of categories) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      const routeValue = /\broutePositive\b[^\n,}]*\b(?:true|1)\b/i.test(windowText);
      rows.push({ rowSource: "line-scan", file: rel(file), line: i + 1, matchType: match.matchType, termType: match.termType, matched: sanitizeText(match.matched, 140), count: countOccurrences(line, match.matched), categories, sample: sanitizeText(windowText, 520), routePositive: 0, sourceRoutePositiveNotPromoted: Boolean(routeValue), classification: classificationForRow(file, match, categories, routeValue) });
      sampled += 1;
    }
    if (fileMatched) filesWithMatch += 1;
    if (fileExact) filesWithExact += 1;
    if (rows.length >= MAX_LOCAL_MATCH_ROWS) break;
  }
  return { filesScanned, filesWithMatch, filesWithExact, rows, exactRows: rows.filter((row) => row.matchType === "exact-name-address-token-module"), categoryCounts };
}

function exactish(row) { return row.matchType === "exact-name-address-token-module"; }
function sourceForRow(row) { return row.file ? `${row.file}${row.line ? `:${row.line}` : ""}` : (row.sourceLabel || row.rowSource || "static"); }
function includesAnyTerm(text, terms) { const hay = String(text || "").toLowerCase(); return terms.some((term) => term && hay.includes(String(term).toLowerCase())); }
function rowSearchText(row) { return `${row.file || ""} ${row.matched || ""} ${row.sample || ""} ${row.classification || ""}`; }
function firstSources(rows, max = 4) { return uniqBy(rows, sourceForRow).slice(0, max).map(sourceForRow); }
function proofCheck({ key, status, evidenceRows = [], blocker }) { return { key, status, evidenceRows: evidenceRows.length, evidenceSources: firstSources(evidenceRows), routeBlocking: true, blocker }; }

function buildCandidateMatrix(localRows, priorPrefilter) {
  const prefilterRows = Array.isArray(priorPrefilter.addressRows) ? priorPrefilter.addressRows : [];
  const candidates = CANDIDATE_ROWS.map((candidate) => {
    const terms = [candidate.address, candidate.implementation, candidate.symbol, candidate.chain, candidate.role].filter(Boolean);
    const candidateRows = localRows.filter((row) => includesAnyTerm(rowSearchText(row), terms));
    const priorRows = prefilterRows.filter((row) => {
      const sameAddress = String(row.address || "").toLowerCase() === String(candidate.address || "").toLowerCase();
      const sameChain = String(row.chain || "").toLowerCase() === String(candidate.chain || "").toLowerCase();
      return sameAddress && sameChain;
    });
    const codePresent = candidate.codePresentKnown === false ? false : priorRows.some((row) => row.onchainProbe && row.rpcCoverage?.codePresent === true);
    const noCode = candidate.codePresentKnown === false || priorRows.some((row) => row.rpcCoverage?.codePresent === false || (row.notes || []).includes("no-contract-code"));
    const categories = Array.from(new Set(candidateRows.flatMap((row) => row.categories || []))).sort();
    const custodyRows = candidateRows.filter((row) => (row.categories || []).includes("custodyBacking"));
    const proofRows = candidateRows.filter((row) => (row.categories || []).includes("proofDomainNonce"));
    const selectorRows = candidateRows.filter((row) => (row.categories || []).includes("mintBurnUnlockRedeem"));
    const roleRows = candidateRows.filter((row) => (row.categories || []).includes("adminRoleGateway"));
    const rippleRows = candidateRows.filter((row) => (row.categories || []).includes("rippleCaveat"));
    const consumerRows = candidateRows.filter((row) => (row.categories || []).includes("consumerJoin"));
    const dexRows = candidateRows.filter((row) => (row.categories || []).some((cat) => ["dexLiquidity", "exitLiquidity"].includes(cat)));
    const checks = [
      proofCheck({ key: "codePresentDeployedPath", status: noCode ? "skipped-no-code" : codePresent ? "context-code-present-not-route" : candidate.chain === "Ripple" ? "non-evm-caveat" : "missing", evidenceRows: candidateRows.filter((row) => (row.categories || []).includes("codeProof")), blocker: "No deployed code-present value-moving bridge/wrapper/gateway/escrow/verifier path is proven for this candidate." }),
      proofCheck({ key: "custodyBackingProof", status: custodyRows.length ? "context-only-no-reconciliation" : "missing", evidenceRows: custodyRows, blocker: "Underlying custody/backing, escrow balance, or supply reconciliation is not proven at route size." }),
      proofCheck({ key: "proofDomainNonceProof", status: proofRows.length ? "context-only-no-bypass" : "missing", evidenceRows: proofRows, blocker: "No proof/domain/nonce/recipient/token binding bypass or replay is proven." }),
      proofCheck({ key: "mintBurnUnlockRedeemPath", status: selectorRows.length ? "context-only-no-permissionless-selector" : "missing", evidenceRows: selectorRows, blocker: "No permissionless mint/burn/unlock/redeem selector is reachable on a code-present target." }),
      proofCheck({ key: "roleAdminGatewayProof", status: roleRows.length ? "context-only-no-role-bypass" : "missing", evidenceRows: roleRows, blocker: "Owner/admin/minter/pauser/gateway/proxy controls are not proven irrelevant." }),
      proofCheck({ key: "rippleDependencyResolved", status: candidate.chain === "Ripple" ? "non-evm-caveat" : rippleRows.length ? "context-only-caveat" : "not-applicable-or-missing", evidenceRows: rippleRows, blocker: "Ripple custody/proof dependency is unresolved in local EVM-only artifacts." }),
      proofCheck({ key: "consumerOrDexExitProof", status: consumerRows.length || dexRows.length ? "context-only-no-exact-economics" : "missing", evidenceRows: [...consumerRows, ...dexRows], blocker: "No solvent consumer or route-size DEX/redeem exit with exact positive netLiquidUsd is proven." }),
      proofCheck({ key: "forkValueDeltaProof", status: "missing", evidenceRows: [], blocker: "No local fork/static value-delta proof exists; harness should skip until routePositive candidate exists." }),
    ];
    return { role: candidate.role, chain: candidate.chain, address: candidate.address, implementation: candidate.implementation || null, symbol: candidate.symbol || null, codePresentKnown: codePresent, skippedNoCode: Boolean(noCode), nonEvm: candidate.chain === "Ripple", localArtifactRows: candidateRows.length, exactLocalRows: candidateRows.filter(exactish).length, categories, custodyContextRows: custodyRows.length, proofDomainNonceContextRows: proofRows.length, mintBurnUnlockRedeemContextRows: selectorRows.length, roleAdminGatewayContextRows: roleRows.length, rippleCaveatRows: rippleRows.length, consumerContextRows: consumerRows.length, dexExitContextRows: dexRows.length, proofChecks: checks, routeBlockingProofGaps: checks.map((check) => check.key), routePositive: 0, executableNow: 0, signedActionJustified: false, status: candidate.chain === "Ripple" ? "non-evm-caveat-no-local-proof" : noCode ? "skipped-no-code-no-meaningful-fork" : "watch-static-only-needs-code-state-consumer-economics", blocker: noCode ? "Prior prefilter shows no contract code for this EVM sample; selector/fork route is non-meaningful." : "Static/local context only; exact code/state, proof path, consumer/exit, and positive economics are unproven." };
  });
  const proofGapRows = candidates.flatMap((candidate) => candidate.proofChecks.map((check) => ({ role: candidate.role, chain: candidate.chain, gate: check.key, status: check.status, evidenceRows: check.evidenceRows, blocker: check.blocker })));
  return { candidates, proofGapRows, summary: { candidateRows: candidates.length, evmCandidateRows: candidates.filter((c) => !c.nonEvm).length, nonEvmCandidateRows: candidates.filter((c) => c.nonEvm).length, skippedNoCodeRows: candidates.filter((c) => c.skippedNoCode).length, candidatesWithCodePresentProof: candidates.filter((c) => c.codePresentKnown === true).length, candidatesWithConsumerOrDexContext: candidates.filter((c) => c.consumerContextRows > 0 || c.dexExitContextRows > 0).length, candidatesWithExactConsumerJoin: 0, candidatesWithExactEconomics: 0, candidateMatrixProofGapRows: proofGapRows.length, routePositive: 0 } };
}

function selectNotableRows(rows) {
  const priority = [];
  const files = new Set();
  for (const row of rows) {
    const key = row.file || row.sourceLabel || row.matched;
    const cats = row.categories || [];
    if (row.rowSource === "static-public-fact" || exactish(row) || cats.some((cat) => ["custodyBacking", "proofDomainNonce", "mintBurnUnlockRedeem", "adminRoleGateway", "rippleCaveat", "wxrpToken", "codeProof", "consumerJoin", "dexLiquidity", "exitLiquidity", "forkPrereq"].includes(cat))) {
      if (!files.has(key) || exactish(row) || row.rowSource === "static-public-fact") { priority.push(row); files.add(key); }
    }
    if (priority.length >= 50) break;
  }
  return priority.length ? priority : rows.slice(0, 28);
}

function loadPriorPrefilter() {
  const artifact = readJson(path.join(WORKSPACE, PREFILTER_JSON_REL)) || {};
  const summary = artifact.summary || {};
  return { generatedAt: artifact.generatedAt || null, scanner: artifact.scanner || "tools/scan-wrappedfi-prefilter.js", addressRows: Array.isArray(artifact.addressRows) ? artifact.addressRows : [], nonEvmChains: Array.isArray(artifact.nonEvmChains) ? artifact.nonEvmChains : [], addressRowsChecked: Number(summary.addressRowsChecked || 0) || 0, addressRowsCount: Number(summary.addressRowsCount || 0) || 0, localArtifactMatchRows: Number(summary.localArtifactMatchRows || 0) || 0, consumerJoinRows: Number(summary.consumerJoinRows || 0) || 0, onchainRows: Number(summary.onchainRows || 0) || 0, codePresentRows: Number(summary.codePresentRows || 0) || 0, bridgeProbeRows: Number(summary.bridgeProbeRows || 0) || 0, publicDepositRows: Number(summary.publicDepositRows || 0) || 0, publicRedeemRows: Number(summary.publicRedeemRows || 0) || 0, routePositive: Number(summary.routePositive || 0) || 0, executableNow: Number(summary.executableNow || 0) || 0, signedActionJustified: Boolean(summary.signedActionJustified || false), forkJustified: Boolean(summary.forkJustified || false), rpcInventoryRead: Boolean(artifact.safety?.rpcInventoryRead), rpcUrlsStored: Boolean(artifact.safety?.rpcUrlsStored) };
}

function buildPayload({ lineScan, priorPrefilter }) {
  const localRows = lineScan.rows;
  const combinedRows = [...STATIC_CONTEXT_ROWS, ...localRows];
  const exactRows = lineScan.exactRows;
  const categoryRows = {};
  for (const category of Object.keys(CATEGORY_RULES)) categoryRows[`${category}Rows`] = pickRows(combinedRows, (row) => (row.categories || []).includes(category), 220);
  const priorPrefilterRows = pickRows(localRows, (row) => row.file && row.file.includes("prefilter-wrappedfi"), 180);
  const consumerJoinRows = pickRows(combinedRows, (row) => (row.categories || []).includes("consumerJoin"), 220);
  const exactConsumerJoinRows = [];
  const dexExitRows = pickRows(combinedRows, (row) => (row.categories || []).some((cat) => ["dexLiquidity", "exitLiquidity"].includes(cat)), 220);
  const exactEconomicsRows = 0;
  const candidateMatrix = buildCandidateMatrix(localRows, priorPrefilter);
  const notableRows = selectNotableRows(combinedRows);
  const routePositive = 0;
  const executableNow = 0;
  const signedActionJustified = false;
  const forkJustified = false;
  const forkGate = "closed-route-positive-zero";
  const summary = { sourceFactRows: SOURCE_FACTS.length, chainSeedRows: CHAIN_SEEDS.length, addressSeedRows: ADDRESS_ROWS.length, publicDocRows: PUBLIC_DOC_ROWS.length, bugClassRows: BUG_CLASS_ROWS.length, surfaceRows: SURFACE_ROWS.length, staticContextRows: STATIC_CONTEXT_ROWS.length, forkRoutePrerequisiteRows: FORK_ROUTE_PREREQUISITES.length, priorPrefilterRows: priorPrefilterRows.length, priorPrefilterAddressRowsCount: priorPrefilter.addressRowsCount, priorPrefilterLocalArtifactMatchRows: priorPrefilter.localArtifactMatchRows, priorPrefilterConsumerJoinRows: priorPrefilter.consumerJoinRows, priorPrefilterCodePresentRows: priorPrefilter.codePresentRows, priorPrefilterBridgeProbeRows: priorPrefilter.bridgeProbeRows, filesScanned: lineScan.filesScanned, filesWithLocalMatches: lineScan.filesWithMatch, filesWithExactLocalMatches: lineScan.filesWithExact, localArtifactMatchRows: localRows.length, exactLocalArtifactMatchRows: exactRows.length, custodyBackingRows: categoryRows.custodyBackingRows.length, proofDomainNonceRows: categoryRows.proofDomainNonceRows.length, mintBurnUnlockRedeemRows: categoryRows.mintBurnUnlockRedeemRows.length, adminRoleGatewayRows: categoryRows.adminRoleGatewayRows.length, rippleCaveatRows: categoryRows.rippleCaveatRows.length, wxrpTokenRows: categoryRows.wxrpTokenRows.length, codeProofRows: categoryRows.codeProofRows.length, consumerJoinRows: consumerJoinRows.length, exactConsumerJoinRows: exactConsumerJoinRows.length, dexLiquidityRows: categoryRows.dexLiquidityRows.length, exitLiquidityRows: categoryRows.exitLiquidityRows.length, dexExitContextRows: dexExitRows.length, economicsContextRows: categoryRows.economicsRows.length, forkPrereqRows: categoryRows.forkPrereqRows.length, candidateMatrixRows: candidateMatrix.summary.candidateRows, evmCandidateRows: candidateMatrix.summary.evmCandidateRows, nonEvmCandidateRows: candidateMatrix.summary.nonEvmCandidateRows, skippedNoCodeRows: candidateMatrix.summary.skippedNoCodeRows, candidatesWithCodePresentProof: candidateMatrix.summary.candidatesWithCodePresentProof, candidatesWithConsumerOrDexContext: candidateMatrix.summary.candidatesWithConsumerOrDexContext, candidatesWithExactConsumerJoin: 0, candidatesWithExactEconomics: 0, candidateMatrixProofGapRows: candidateMatrix.summary.candidateMatrixProofGapRows, publicFetchRows: 0, rpcInventoryRows: 0, graphqlInventoryRows: 0, ethCallRows: 0, forkRows: 0, exactEconomicsRows, routePositive, executableNow, signedActionJustified, forkJustified, forkGate, fullTestReadOnlyComplete: true };
  return { generatedAt: GENERATED_AT, deterministicOutput: true, scanner: "tools/scan-wrappedfi-full-test.js", target: TARGET, scope: { kind: "bounded defensive/read-only full-test scanner", artifactStaticLocalFirst: true, publicFactsOnly: true, evmFirst: true, evmFirstChains: TARGET.primaryChains, caveatChains: TARGET.caveatChains, routeGraph: TARGET.routeGraph, writesLimitedTo: [OUT_JSON_REL, OUT_MD_REL], coordinatorClaim: TARGET.coordinatorClaim, endpointPolicy: "No endpoint inventory was read by this full-test scanner; no raw endpoints, domains, keys, or tokens are persisted." }, safety: { localArtifactsRead: true, publicSourcesRead: true, publicStaticLabelsUsed: true, publicNetworkFetch: false, endpointInventoryRead: false, rpcInventoryRead: false, rpcInventoryRows: 0, graphqlInventoryRead: false, graphqlInventoryRows: 0, envFilesRead: false, privateKeyEnvRead: false, privateKeysRead: false, keyFilesRead: false, keyMaterialRead: false, pemFilesRead: false, keypairJsonRead: false, rawEndpointUrlsStored: false, rpcUrlsStored: false, graphqlUrlsStored: false, rawUrlsStored: false, rawDomainsStored: false, rawKeysTokensStored: false, signedActions: false, liveTransactions: false, broadcasts: false, walletOperations: false, exploitExecuteCalls: false, forkTransactions: false, ethCallOnly: false, sanitizedOutputOnly: true, secretLikePathsExcluded: true }, sourceFacts: SOURCE_FACTS, publicDocs: PUBLIC_DOC_ROWS, bugClasses: BUG_CLASS_ROWS, discoveredSeeds: { chainSeeds: CHAIN_SEEDS, addressRows: ADDRESS_ROWS, surfaceRows: SURFACE_ROWS }, priorPrefilter: priorPrefilter, staticContextRows: STATIC_CONTEXT_ROWS, forkRoutePrerequisites: FORK_ROUTE_PREREQUISITES, priorPrefilterRows, localArtifacts: { filesScanned: lineScan.filesScanned, filesWithMatch: lineScan.filesWithMatch, filesWithExact: lineScan.filesWithExact, categoryCounts: lineScan.categoryCounts, rows: localRows, exactRows: exactRows.slice(0, 220), notableRows }, categoryRows: { ...categoryRows, consumerJoinRows, exactConsumerJoinRows, dexExitRows }, candidateMatrix, rows: notableRows.slice(0, 16), routeGate: { routePositive, executableNow, signedActionJustified, forkJustified, forkGate, exactPermissionlessValueMovement: false, exactPositiveEconomics: false, localForkStaticProof: false, exactEconomicsRows, status: "dormant-fail-closed", reason: "Static/local scan found WrappedFi custody/backing, proof/domain/nonce, mint/burn/unlock/redeem, role/admin/gateway, Ripple, WXRP, consumer, DEX, economics, and fork-prerequisite context rows only; no code-present permissionless value path, exact positive economics, or fork/static value-delta proof is present." }, blockers: BLOCKERS, requiredForRoutePositive: REQUIRED_FOR_ROUTE_POSITIVE, nextReadOnlyStep: NEXT_READ_ONLY_STEP, summary };
}

function metricRows(summary) {
  const keys = ["sourceFactRows", "chainSeedRows", "addressSeedRows", "publicDocRows", "bugClassRows", "surfaceRows", "staticContextRows", "forkRoutePrerequisiteRows", "priorPrefilterRows", "priorPrefilterAddressRowsCount", "priorPrefilterLocalArtifactMatchRows", "priorPrefilterConsumerJoinRows", "priorPrefilterCodePresentRows", "priorPrefilterBridgeProbeRows", "filesScanned", "filesWithLocalMatches", "filesWithExactLocalMatches", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "custodyBackingRows", "proofDomainNonceRows", "mintBurnUnlockRedeemRows", "adminRoleGatewayRows", "rippleCaveatRows", "wxrpTokenRows", "codeProofRows", "consumerJoinRows", "exactConsumerJoinRows", "dexLiquidityRows", "exitLiquidityRows", "dexExitContextRows", "economicsContextRows", "forkPrereqRows", "candidateMatrixRows", "evmCandidateRows", "nonEvmCandidateRows", "skippedNoCodeRows", "candidatesWithCodePresentProof", "candidatesWithConsumerOrDexContext", "candidatesWithExactConsumerJoin", "candidatesWithExactEconomics", "candidateMatrixProofGapRows", "publicFetchRows", "rpcInventoryRows", "graphqlInventoryRows", "ethCallRows", "forkRows", "exactEconomicsRows", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate", "fullTestReadOnlyComplete"];
  return keys.map((key) => `| ${key} | ${mdEscape(summary[key])} |`).join("\n");
}
function safetyRows(safety) { return ["localArtifactsRead", "publicSourcesRead", "publicStaticLabelsUsed", "publicNetworkFetch", "endpointInventoryRead", "rpcInventoryRead", "graphqlInventoryRead", "envFilesRead", "privateKeysRead", "keyMaterialRead", "rawEndpointUrlsStored", "rpcUrlsStored", "graphqlUrlsStored", "rawUrlsStored", "rawDomainsStored", "rawKeysTokensStored", "signedActions", "liveTransactions", "broadcasts", "walletOperations", "forkTransactions", "sanitizedOutputOnly", "secretLikePathsExcluded"].map((key) => `| ${key} | ${mdEscape(safety[key])} |`).join("\n"); }
function formatAddressRow(row) { return `| ${mdEscape(row.role)} | ${mdEscape(row.chain)} | ${mdEscape(row.address)} | ${mdEscape(row.surface)} | ${mdEscape(row.classification)} |`; }
function formatSurfaceRow(row) { return `| ${mdEscape(row.component)} | ${mdEscape(row.surface)} | ${mdEscape(row.routeRole)} | ${mdEscape((row.watchTerms || []).join(", "))} |`; }
function shortAddress(value) { const text = String(value || ""); return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}...${text.slice(-4)}` : text; }
function formatCandidateRow(row) { const evidence = `local=${row.localArtifactRows}, exact=${row.exactLocalRows}, noCode=${row.skippedNoCode}, consumer=${row.consumerContextRows}, dexExit=${row.dexExitContextRows}`; return `| ${mdEscape(row.role)} | ${mdEscape(row.chain)} | ${mdEscape(shortAddress(row.address))} | ${mdEscape(evidence)} | ${mdEscape(row.routeBlockingProofGaps.join(", "))} | ${mdEscape(row.status)} |`; }
function formatBugClassRow(row) { return `| ${mdEscape(row.label)} | ${mdEscape(row.surface)} | ${mdEscape(row.classification)} |`; }
function formatLocalRow(row) { return `| ${mdEscape(sourceForRow(row))} | ${mdEscape((row.categories || []).join(","))} | ${mdEscape(row.matched)} | ${mdEscape(row.sample || "context-only")} | ${mdEscape(row.routePositive)} | ${mdEscape(row.classification)} |`; }

function buildMarkdown(payload) {
  const notableRows = payload.localArtifacts.notableRows.length ? payload.localArtifacts.notableRows.map(formatLocalRow).join("\n") : "| (none) | n/a | n/a | no local context rows found | 0 | dormant |";
  return `# 🟢 DORMANT - Wrapped / WrappedFi Full Test

Generated: ${payload.generatedAt}

Route remains closed: routePositive=${payload.routeGate.routePositive}, executableNow=${payload.routeGate.executableNow}, signedActionJustified=${payload.routeGate.signedActionJustified}, forkJustified=${payload.routeGate.forkJustified}, forkGate=${payload.routeGate.forkGate}.

## Target Context

- Target: ${payload.target.name} (${payload.target.protocolSlug}/${payload.target.slug}), category=${payload.target.category}, surface=${payload.target.surface}.
- TVL context: discovery≈${payload.target.discoveryTvlContext}; prefilter≈${payload.target.prefilterTvlContext}.
- EVM scope: ${payload.scope.evmFirstChains.join(", ")}; caveat chains: ${payload.scope.caveatChains.join(", ")}.
- Route graph: ${payload.target.routeGraph}.
- Existing coverage: prior prefilter has codePresentRows=${payload.priorPrefilter.codePresentRows}, consumerJoinRows=${payload.priorPrefilter.consumerJoinRows}, bridgeProbeRows=${payload.priorPrefilter.bridgeProbeRows}, routePositive=${payload.priorPrefilter.routePositive}.

## Metrics

| Metric | Value |
|---|---:|
${metricRows(payload.summary)}

## Safety Summary

| Field | Value |
|---|---:|
${safetyRows(payload.safety)}

## Public Static Context

${payload.publicDocs.map((item) => `- ${item}`).join("\n")}

## Address / Candidate Seeds

| Role | Chain | Address | Surface | Classification |
|---|---|---|---|---|
${payload.discoveredSeeds.addressRows.map(formatAddressRow).join("\n")}

## Surface Checklist

| Component | Surface | Route Role | Watch Terms |
|---|---|---|---|
${payload.discoveredSeeds.surfaceRows.map(formatSurfaceRow).join("\n")}

## Candidate Matrix / Fork Gate

| Candidate | Chain | Address | Local Evidence | Missing Current Proofs | Status |
|---|---|---|---|---|---|
${payload.candidateMatrix.candidates.map(formatCandidateRow).join("\n")}

Fork harness gate: routePositive must be >0, code-present value-moving target must exist, and exact netLiquidUsd must be >0 before local fork transactions are meaningful.

## Bug Classes / Proof Gaps

| Class | Surface | Classification |
|---|---|---|
${payload.bugClasses.map(formatBugClassRow).join("\n")}

## Notable Local / Static Rows

| Source | Categories | Match | Detail | Route | Classification |
|---|---|---|---|---:|---|
${notableRows}

## Route Gate

- Status: ${payload.routeGate.status}.
- Required fail-closed conjunction is absent: exactPermissionlessValueMovement=${payload.routeGate.exactPermissionlessValueMovement}, exactPositiveEconomics=${payload.routeGate.exactPositiveEconomics}, localForkStaticProof=${payload.routeGate.localForkStaticProof}.
- No code-present bridge/wrapper/gateway/escrow/verifier route, proof bypass, material consumer acceptance, DEX/redeem exit, or exact positive economics was resolved.
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
  log("Scanning WrappedFi local artifacts (sanitized, no endpoint inventory read)...");
  const files = listScanFiles();
  const lineScan = scanLocalArtifactLines(files);
  const priorPrefilter = loadPriorPrefilter();
  const payload = buildPayload({ lineScan, priorPrefilter });
  writeJson(OUT_JSON, payload);
  writeText(OUT_MD, buildMarkdown(payload));
  log(`Wrote ${OUT_JSON_REL} and ${OUT_MD_REL}`);
  log(`routePositive=${payload.summary.routePositive}; exactEconomicsRows=${payload.summary.exactEconomicsRows}; localArtifactMatchRows=${payload.summary.localArtifactMatchRows}; skippedNoCodeRows=${payload.summary.skippedNoCodeRows}`);
}

main();
