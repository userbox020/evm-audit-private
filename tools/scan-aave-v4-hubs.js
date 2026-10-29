#!/usr/bin/env node
// Read-only Aave V4 hub mapper.
// RPC URLs are resolved in memory only and are never printed or written.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { MAX_RPC_CANDIDATES, resolveRpc, sanitizeError } = require("./shared-rpc");
const { buildAaveSourceCoverage } = require("./aave-source-coverage");
const { openPinnedCollection, CollectionError, LIMITS: COLLECTION_LIMITS } = require("./lib/aave-v4-pinned-collection");
const aaveFamilyCandidates = require("./lib/aave-v4-family-candidates");
const baseRoles = require("./lib/aave-v4-base-role-evidence");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-hubs.json");
const FAILURE_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-hubs-last-failure.json");
const TIMEOUT_MS = 15_000;
const RPC_QUALIFICATION_TIMEOUT_MS = 6_000;
const RPC_QUALIFICATION_CONCURRENCY = 4;
const MAX_ASSETS_PER_HUB = Number(process.env.AAVE_V4_MAX_ASSETS_PER_HUB || "80");
const MAX_SPOKES_PER_ASSET = Number(process.env.AAVE_V4_MAX_SPOKES_PER_ASSET || "12");
const REVIEW_BORROWED_USD = Number(process.env.AAVE_V4_REVIEW_BORROWED_USD || "10000");
const REVIEW_CASH_USD = Number(process.env.AAVE_V4_REVIEW_CASH_USD || "1000000");
const ETHEREUM_CHAIN_ID = 1;
const BASE_CHAIN_ID = 8453;
const QUIET = process.argv.includes("--quiet");
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

// ---------------------------------------------------------------------------
// Pinned, vendored Aave V4 Ethereum registry extract.
//
// Provenance: aave-dao/aave-address-book release tag v4.68.2 (commit
// 56b926e4ed27e96aeb72f2d5a8e0aaebb50548ff), files scripts/configs/v4/
// ethereum.ts + src/AaveV4Ethereum.ts. The extract is vendored so scans never
// fetch GitHub at runtime (unauthenticated budget is 60 req/hr). Captured
// diffs and the read-only eth_getCode pin evidence (pinBlock 0x18cfd59 /
// 26,017,113) live in reports/raw/fast/aave-address-book-triage-20260920/.
// ---------------------------------------------------------------------------
const AAVE_V4_ETHEREUM_REGISTRY = Object.freeze({
  registryId: "aave-dao/aave-address-book",
  version: "v4.68.2",
  commit: "56b926e4ed27e96aeb72f2d5a8e0aaebb50548ff",
  source: "scripts/configs/v4/ethereum.ts + src/AaveV4Ethereum.ts",
  pinBlock: "0x18cfd59",
  pinBlockNumber: 26017113,
  admins: Object.freeze({
    ACCESS_MANAGER: "0x08aE3BE30958cDd1847ec58fFfd4C451a87fDF01",
    HUB_CONFIGURATOR: "0x1F0753480bB03EaA00863224602267B7E0525C3d",
    SPOKE_CONFIGURATOR: "0x9BFFf48BFb5A7AE70c348d4d4cb97E8DEFa5389a",
    TREASURY_SPOKE: "0xB9B0b8616f6Bf6841972a52058132BE08d723155",
    CONFIG_ENGINE: "0xa1673fbD457747A05e91D9ef904Cb12827916B1E",
  }),
  hubs: Object.freeze([
    Object.freeze({ key: "CORE", name: "Core Hub", address: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9" }),
    Object.freeze({ key: "PLUS", name: "Plus Hub", address: "0x06002e9c4412CB7814a791eA3666D905871E536A" }),
    Object.freeze({ key: "PRIME", name: "Prime Hub", address: "0x943827DCA022D0F354a8a8c332dA1e5Eb9f9F931" }),
    Object.freeze({ key: "GLOBAL_DOLLAR", name: "Global Dollar Hub", address: "0x62d63197660c080236193CA60b70E49A08E90368" }),
  ]),
  spokes: Object.freeze({
    BLUECHIP: "0x973a023A77420ba610f06b3858aD991Df6d85A08",
    ETHENA_CORRELATED: "0x58131E79531caB1d52301228d1f7b842F26B9649",
    ETHENA_ECOSYSTEM: "0xba1B3D55D249692b669A164024A838309B7508AF",
    FOREX: "0xD8B93635b8C6d0fF98CbE90b5988E3F2d1Cd9da1",
    GOLD: "0x65407b940966954b23dfA3caA5C0702bB42984DC",
    LOMBARD_BTC: "0x7EC68b5695e803e98a21a9A05d744F28b0a7753D",
    MAIN: "0x94e7A5dCbE816e498b89aB752661904E2F56c485",
    PAXG_GOLD: "0xAD75cE6354f87F3135cE10621d385d8D1e2562C2",
    USDG_PENDLE: "0x956d8e0A89cfa3744428C4641b5a53B56167a7f9",
  }),
  eSpokes: Object.freeze({
    ETHERFI: "0xbF10BDfE177dE0336aFD7fcCF80A904E15386219",
    KELP: "0x3131FE68C4722e726fe6B2819ED68e514395B9a4",
    LIDO: "0xe1900480ac69f0B296841Cd01cC37546d92F35Cd",
    USDG_MAPLE: "0x774b9655413c34809c1f1b16b654465A89EBE989",
  }),
  tokenizationSpokes: Object.freeze({
    CORE_WETH: "0x7320CF22Ac095bA2a2e0a652F77efB836c2E751b",
    CORE_wstETH: "0xcb0E7dA9c635628f6d4827355AeCa75aB8d3560f",
    CORE_weETH: "0x559cEc2C840D9DBB18936Afc5E5341D78bfC7Cbe",
    CORE_rsETH: "0x45a04Ca1A5cbEeA4B44356c75EDd29b33eB2527a",
    CORE_USDT: "0x5eC44a70F309854fe04d495cFE1B5dA63DD1cc73",
    CORE_USDC: "0x531E90a2376902DE8915789Fcc1075e3B0c153E7",
    CORE_GHO: "0x58C14a5E061c9bC6926c5b853445290F296C2F7B",
    CORE_RLUSD: "0xC8a125AE4275a78AADc53B46Ca10566Bc9B249E0",
    CORE_USDG: "0xAC2435E3C25e8246870D33ce0a26988A46d5DB68",
    CORE_frxUSD: "0x2226749630775ee20230Ad65214fB339087eF30D",
    CORE_EURC: "0x6D9e2Cdd61CaF69af99b275704B6e272C41c6718",
    CORE_WBTC: "0x82A9CC4656784E55Ef2E78F704028B5E1Bfc1732",
    CORE_cbBTC: "0x33B41B74366F55327d959FfF6D6b6fBc2853dbB1",
    CORE_LBTC: "0x7961F140B570490849DB878AE222570ea838799d",
    CORE_XAUt: "0x4E712562fcb5337011398B6C630f55b60641cd5e",
    CORE_AAVE: "0x0A65197b16C5969F92672051c9C9C0C75B369135",
    CORE_LINK: "0xE69C2045095C8Ab3E2a7d77de2328faE5baF797c",
    PLUS_PT_sUSDE_7MAY2026: "0x90774889c22D2F2Adf44da1f04C7c95542590df4",
    PLUS_PT_USDe_7MAY2026: "0xdd2Eb78BF9e6aC5068B95aD2d451e8c9Af10ac81",
    PLUS_sUSDe: "0x24f8c062e1E0451736C1D6E023510DA262a41df4",
    PLUS_USDe: "0x502Cd81da6a8F1785eb2eEE72713B7388E16A854",
    PLUS_USDC: "0xc94bdd83D2c7655C280655D60954e79E88D4F949",
    PLUS_GHO: "0xA54382db40EC602c0a173A08f9E86Ed40F9D4D10",
    PLUS_USDT: "0x80835EB50694EE0e519743f67e5401e6FD300006",
    PRIME_WETH: "0x2087513383330B961A3753B47627Bbf149F31c70",
    PRIME_WBTC: "0x5AE3d87De89CA6Ce501e8317887F71EABED69E18",
    PRIME_cbBTC: "0xD38098faf52D8E915EdED84fBF30F81C17906938",
    PRIME_wstETH: "0xFCD3D3C69cd032DE0cc78fE529B7447D2fe7F666",
    PRIME_USDC: "0x486415fb1F8b062c89ED548f871cf64304AACb31",
    PRIME_USDT: "0x46c588DD8453aC259c1f6a54b4C9A93C2aC3762D",
    PRIME_GHO: "0x900fD46d565d1ac8995928c0179052ec02a6D0E1",
    GLOBAL_DOLLAR_PT_USDG_24SEP2026: "0x7Df10B4A01350D2A1d95cFbE7c9207d7210A2663",
    GLOBAL_DOLLAR_USDC: "0xaed7c529bD2878170B61C758DfAa215AC7a4FD07",
    GLOBAL_DOLLAR_USDT: "0xa0e97e45C2f89003730E467Bd484fA3eEcE5B4Cf",
    GLOBAL_DOLLAR_USDG: "0x378B4a7c394E22bd562F66eB612165893533c124",
    GLOBAL_DOLLAR_PAXG: "0x6493a23874b506D5Bb6038ea44aE9CC74cD00849",
  }),
  positionManagers: Object.freeze({
    GIVER_POSITION_MANAGER: "0x17A54b8d6D9C68e7fa1C7112AC998EA1BA51d11e",
    TAKER_POSITION_MANAGER: "0x6c044c0D3801499bCAbfAd458B70880bc518e9F7",
    CONFIG_POSITION_MANAGER: "0x51305839CE822a7b4b12AA7D86eA7005052d575c",
    NATIVE_TOKEN_GATEWAY: "0xe68ab4F90Fe026B9873F5F276eD2d7efBbbE42Be",
    SIGNATURE_GATEWAY: "0xfbC184337Dc6595D8bf62968Bda46e7De7AF9c3d",
  }),
  externalLibraries: Object.freeze({
    LIQUIDATION_LOGIC: "0x88dF535473C5adf1f57789734A05E555F7Deb8DB",
  }),
});

const HUB = new ethers.Interface([
  "function getAssetCount() view returns (uint256)",
  "function getAssetUnderlyingAndDecimals(uint256 assetId) view returns (address,uint8)",
  "function getAssetLiquidity(uint256 assetId) view returns (uint256)",
  "function getAssetOwed(uint256 assetId) view returns (uint256 drawnAssets,uint256 premiumAssets)",
  "function getAssetTotalOwed(uint256 assetId) view returns (uint256)",
  "function getAssetDrawnShares(uint256 assetId) view returns (uint256)",
  "function getAssetDrawnIndex(uint256 assetId) view returns (uint256)",
  "function getAssetDrawnRate(uint256 assetId) view returns (uint256)",
  "function getAssetDeficitRay(uint256 assetId) view returns (uint256)",
  "function getAssetPremiumRay(uint256 assetId) view returns (uint256)",
  "function getAssetAccruedFees(uint256 assetId) view returns (uint256)",
  "function getAssetSwept(uint256 assetId) view returns (uint256)",
  "function isUnderlyingListed(address underlying) view returns (bool)",
  "function getSpokeCount(uint256 assetId) view returns (uint256)",
  "function getSpokeAddress(uint256 assetId,uint256 index) view returns (address)",
  "function isSpokeListed(uint256 assetId,address spoke) view returns (bool)",
  "function getSpokeConfig(uint256 assetId,address spoke) view returns (uint40,uint40,uint24,bool,bool)",
  "function getSpokeAddedAssets(uint256 assetId,address spoke) view returns (uint256)",
  "function getSpokeAddedShares(uint256 assetId,address spoke) view returns (uint256)",
  "function getSpokeDrawnShares(uint256 assetId,address spoke) view returns (uint256)",
  "function getSpokeOwed(uint256 assetId,address spoke) view returns (uint256 drawnAssets,uint256 premiumAssets)",
  "function getSpokeTotalOwed(uint256 assetId,address spoke) view returns (uint256)",
  "function getSpokeDeficitRay(uint256 assetId,address spoke) view returns (uint256)",
  "function getSpokePremiumRay(uint256 assetId,address spoke) view returns (uint256)",
]);
const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
const DEPENDENCY = new ethers.Interface([
  "function HUB() view returns (address)",
  "function authority() view returns (address)",
  "function owner() view returns (address)",
]);
const TREASURY = new ethers.Interface([
  "function getSuppliedAssets(address hub,address underlying) view returns (uint256)",
  "function getSuppliedShares(address hub,address underlying) view returns (uint256)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
]);
const TOKENIZATION = new ethers.Interface([
  "function hub() view returns (address)",
  "function assetId() view returns (uint256)",
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const SPOKE = new ethers.Interface([
  "function ORACLE() view returns (address)",
  "function MAX_USER_RESERVES_LIMIT() view returns (uint16)",
  "function getLiquidationConfig() view returns (uint128,uint64,uint16)",
  "function getReserveId(address hub,uint256 assetId) view returns (uint256)",
  "function getReserve(uint256 reserveId) view returns (address,address,uint16,uint8,uint24,uint8,uint32)",
  "function getReserveConfig(uint256 reserveId) view returns (uint24,bool,bool,bool,bool)",
  "function getDynamicReserveConfig(uint256 reserveId,uint32 dynamicConfigKey) view returns (uint16,uint32,uint16)",
  "function getReserveSuppliedAssets(uint256 reserveId) view returns (uint256)",
  "function getReserveDebt(uint256 reserveId) view returns (uint256,uint256)",
  "function getReserveTotalDebt(uint256 reserveId) view returns (uint256)",
]);
const AAVE_ORACLE = new ethers.Interface([
  "function spoke() view returns (address)",
  "function decimals() view returns (uint8)",
  "function getReserveSource(uint256 reserveId) view returns (address)",
  "function getReservePrice(uint256 reserveId) view returns (uint256)",
]);

const KNOWN_SIGNATURES = [
  "HUB()",
  "MAX_ALLOWED_SPOKE_CAP()",
  "MAX_ALLOWED_UNDERLYING_DECIMALS()",
  "MAX_RISK_PREMIUM_THRESHOLD()",
  "MIN_ALLOWED_UNDERLYING_DECIMALS()",
  "HUB_REVISION()",
  "SPOKE_REVISION()",
  "MAX_USER_RESERVES_LIMIT()",
  "ORACLE()",
  "acceptOwnership()",
  "add(uint256,uint256)",
  "authority()",
  "draw(uint256,uint256,address)",
  "getAddedAssets(uint256)",
  "getAddedShares(uint256)",
  "getAssetAccruedFees(uint256)",
  "getAsset(uint256)",
  "getAssetCount()",
  "getAssetDeficitRay(uint256)",
  "getAssetDrawnIndex(uint256)",
  "getAssetDrawnRate(uint256)",
  "getAssetDrawnShares(uint256)",
  "getAssetId(address)",
  "getAssetLiquidity(uint256)",
  "getAssetOwed(uint256)",
  "getAssetPremiumData(uint256)",
  "getAssetPremiumRay(uint256)",
  "getAssetSwept(uint256)",
  "getAssetUnderlyingAndDecimals(uint256)",
  "getAssetTotalOwed(uint256)",
  "getDynamicReserveConfig(uint256,uint32)",
  "getLiquidationConfig()",
  "getLiquidationLogic()",
  "getReserve(uint256)",
  "getReserveConfig(uint256)",
  "getReserveCount()",
  "getReserveDebt(uint256)",
  "getReserveId(address,uint256)",
  "getReserveSuppliedAssets(uint256)",
  "getReserveSuppliedShares(uint256)",
  "getReserveTotalDebt(uint256)",
  "getSpoke(uint256,address)",
  "getSpokeAddedAssets(uint256,address)",
  "getSpokeAddedShares(uint256,address)",
  "getSpokeAddress(uint256,uint256)",
  "getSpokeConfig(uint256,address)",
  "getSpokeCount(uint256)",
  "getSpokeDeficitRay(uint256,address)",
  "getSpokeDrawnShares(uint256,address)",
  "getSpokeOwed(uint256,address)",
  "getSpokePremiumData(uint256,address)",
  "getSpokePremiumRay(uint256,address)",
  "getSpokeTotalOwed(uint256,address)",
  "initialize(address)",
  "isConsumingScheduledOp()",
  "isSpokeListed(uint256,address)",
  "isUnderlyingListed(address)",
  "mintFeeShares(uint256)",
  "pendingOwner()",
  "payFeeShares(uint256,uint256)",
  "previewAddByAssets(uint256,uint256)",
  "previewAddByShares(uint256,uint256)",
  "previewDrawByAssets(uint256,uint256)",
  "previewDrawByShares(uint256,uint256)",
  "previewRemoveByAssets(uint256,uint256)",
  "previewRemoveByShares(uint256,uint256)",
  "previewRestoreByAssets(uint256,uint256)",
  "previewRestoreByShares(uint256,uint256)",
  "reclaim(uint256,uint256)",
  "remove(uint256,uint256,address)",
  "renounceOwnership()",
  "setAuthority(address)",
  "supply(uint256,uint256,address)",
  "supply(address,address,uint256)",
  "transfer(address,address,uint256)",
  "transferShares(uint256,uint256,address)",
  "transferOwnership(address)",
  "updateAssetConfig(uint256,(address,uint16,address,address),bytes)",
  "updateSpokeConfig(uint256,address,(uint40,uint40,uint24,bool,bool))",
  "sweep(uint256,uint256)",
  "withdraw(uint256,uint256,address)",
  "withdraw(address,address,uint256)",
  "borrow(uint256,uint256,address)",
  "repay(uint256,uint256,address)",
  "liquidate(address,uint256,uint256)",
  "getUserAccountData(address)",
  "getAssetPrice(uint256)",
  "getAssetConfig(uint256)",
  "getAssetLtv(uint256)",
  "getAssetLiquidationThreshold(uint256)",
  "getAssetLiquidationBonus(uint256)",
  "getAssetBorrowable(uint256)",
  "getAssetCollateralizable(uint256)",
  "paused()",
  "owner()",
];
const KNOWN_SELECTORS = Object.fromEntries(KNOWN_SIGNATURES.map((sig) => [ethers.id(sig).slice(0, 10), sig]));
const GET_ASSET_CONFIG_SELECTOR = ethers.id("getAssetConfig(uint256)").slice(0, 10);
const RECOVERED_SELECTOR_SOURCE = "4byte.directory lookup of implementation PUSH4 selectors; labels are candidates unless calls decode successfully";
const OPTIONAL_ASSET_UINT_VIEWS = [
  { name: "getAssetLiquidity", unitHint: "underlying" },
  { name: "getAssetOwed", unitHint: "underlying" },
  { name: "getAssetDrawnShares", unitHint: "shares" },
  { name: "getAssetDrawnIndex", unitHint: "raw-index" },
  { name: "getAssetDrawnRate", unitHint: "raw-rate" },
  { name: "getAssetDeficitRay", unitHint: "ray" },
  { name: "getAssetPremiumRay", unitHint: "ray" },
  { name: "getAssetAccruedFees", unitHint: "underlying" },
  { name: "getAssetSwept", unitHint: "underlying" },
];
const OPTIONAL_SPOKE_UINT_VIEWS = [
  { name: "getSpokeAddedAssets", unitHint: "underlying" },
  { name: "getSpokeAddedShares", unitHint: "shares" },
  { name: "getSpokeDrawnShares", unitHint: "shares" },
  { name: "getSpokeOwed", unitHint: "underlying" },
  { name: "getSpokeTotalOwed", unitHint: "underlying" },
  { name: "getSpokeDeficitRay", unitHint: "ray" },
  { name: "getSpokePremiumRay", unitHint: "ray" },
];

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function normalizeAddress(value) {
  try {
    return ethers.getAddress(value);
  } catch (_) {
    return null;
  }
}

function slotToAddress(value) {
  const hex = String(value || "0x").replace(/^0x/i, "").padStart(64, "0");
  const tail = `0x${hex.slice(-40)}`;
  return tail === ethers.ZeroAddress ? null : normalizeAddress(tail);
}

function validateRegistryExtract(extract, { chainId = ETHEREUM_CHAIN_ID } = {}) {
  if (chainId !== ETHEREUM_CHAIN_ID && chainId !== BASE_CHAIN_ID) return "chain-unsupported";
  if (!extract || typeof extract !== "object" || Array.isArray(extract)) return "not-an-object";
  if ((chainId === BASE_CHAIN_ID || Object.hasOwn(extract, "chainId")) && extract.chainId !== chainId) return "chain-id-mismatch";
  if (typeof extract.registryId !== "string" || !extract.registryId.trim()) return "registry-id-missing";
  if (typeof extract.version !== "string" || !/^v\d+\.\d+\.\d+$/.test(extract.version.trim())) return "version-invalid";
  if (typeof extract.commit !== "string" || !/^[0-9a-f]{40}$/i.test(extract.commit.trim())) return "commit-invalid";
  if (typeof extract.source !== "string" || !extract.source.trim()) return "source-missing";
  if (!(typeof extract.pinBlock === "string" || Number.isSafeInteger(extract.pinBlock))) return "pin-block-missing";
  if (!Array.isArray(extract.hubs) || extract.hubs.length === 0) return "hubs-missing";
  const seen = new Set();
  for (const hub of extract.hubs) {
    if (!hub || typeof hub.name !== "string" || !hub.name.trim()) return "hub-name-invalid";
    const address = normalizeAddress(hub.address);
    if (!address) return `hub-address-invalid:${typeof hub.key === "string" && hub.key ? hub.key : hub.name}`;
    if (seen.has(address.toLowerCase())) return "hub-address-duplicate";
    seen.add(address.toLowerCase());
  }
  if (chainId === ETHEREUM_CHAIN_ID && !extract.hubs.some((hub) => hub?.key === "GLOBAL_DOLLAR")) return "global-dollar-hub-missing";
  if (chainId === BASE_CHAIN_ID) {
    if (!extract.hubs.some((hub) => hub?.key === "EQUITIES_HUB")) return "equities-hub-missing";
    if (extract.hubs.some((hub) => hub?.key === "GLOBAL_DOLLAR")) return "global-dollar-hub-unexpected";
    if (!/^(?:0x[0-9a-f]+|[1-9][0-9]*)$/i.test(String(extract.pinBlock))
      || !Number.isSafeInteger(Number(extract.pinBlock)) || Number(extract.pinBlock) <= 0) return "pin-block-invalid";
  }
  return null;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function registryInventoryDigest(extract) {
  return crypto.createHash("sha256").update(canonicalJson(extract)).digest("hex");
}

// Loads the pinned vendored extract. The binding only succeeds when the extract
// passes structural validation (registry id, version, commit, pin, unique hubs
// and the GLOBAL_DOLLAR hub). On any failure the caller keeps scanning the
// declared hubs but must report `topologyUniverse.bound:false` plus the reason.
function loadAaveV4EthereumRegistry(dependencies = {}) {
  const extract = Object.hasOwn(dependencies, "registryExtract") ? dependencies.registryExtract : AAVE_V4_ETHEREUM_REGISTRY;
  const invalidReason = validateRegistryExtract(extract);
  if (invalidReason) {
    const fallbackHubs = AAVE_V4_ETHEREUM_REGISTRY.hubs.map((hub) => ({ key: hub.key, name: hub.name, address: normalizeAddress(hub.address) }));
    return {
      bound: false,
      registry: null,
      version: null,
      commit: null,
      source: null,
      pinBlock: null,
      inventoryDigest: null,
      failureReason: `registry-extract-invalid:${invalidReason}`,
      hubs: fallbackHubs,
      hubsDeclared: fallbackHubs.length,
    };
  }
  return normalizeRegistryExtract(extract);
}

function normalizeRegistryExtract(extract) {
  const hubs = extract.hubs.map((hub) => ({
    key: typeof hub.key === "string" && hub.key ? hub.key : null,
    name: hub.name,
    address: normalizeAddress(hub.address),
  }));
  return {
    bound: true,
    registry: extract.registryId,
    version: extract.version,
    commit: extract.commit,
    source: extract.source,
    pinBlock: typeof extract.pinBlock === "string" ? extract.pinBlock : `0x${Number(extract.pinBlock).toString(16)}`,
    inventoryDigest: registryInventoryDigest(extract),
    failureReason: null,
    hubs,
    hubsDeclared: hubs.length,
  };
}

// Base is explicit-only: missing/invalid registry data never falls back to Ethereum.
function loadAaveV4Registry(dependencies = {}) {
  const chainId = Object.hasOwn(dependencies, "chainId") ? dependencies.chainId : ETHEREUM_CHAIN_ID;
  if (chainId !== ETHEREUM_CHAIN_ID && chainId !== BASE_CHAIN_ID) throw new Error("topology-chain-unsupported");
  if (chainId === ETHEREUM_CHAIN_ID) return loadAaveV4EthereumRegistry(dependencies);
  const invalidReason = validateRegistryExtract(dependencies.registryExtract, { chainId });
  if (invalidReason) throw new Error(`topology-registry-invalid:${invalidReason}`);
  return normalizeRegistryExtract(dependencies.registryExtract);
}

function buildTopologyUniverse(registry, hubsDeclared) {
  const bound = registry?.bound === true;
  return {
    type: "DECLARED_STATIC_HUB_SET",
    bound,
    registry: bound ? registry.registry : null,
    version: bound ? registry.version : null,
    commit: bound ? registry.commit : null,
    source: bound ? registry.source : null,
    pinBlock: bound ? registry.pinBlock : null,
    inventoryDigest: bound ? registry.inventoryDigest : null,
    hubsDeclared,
    failureReason: bound ? null : (registry?.failureReason || "registry-unavailable"),
  };
}

async function resolveTopologyRpc(dependencies = {}) {
  const resolver = typeof dependencies.resolver === "function" ? dependencies.resolver : resolveRpc;
  const options = {
    capability: "read",
    maxCandidates: dependencies.maxCandidates ?? MAX_RPC_CANDIDATES,
    concurrency: dependencies.concurrency ?? RPC_QUALIFICATION_CONCURRENCY,
    timeoutMs: dependencies.timeoutMs ?? RPC_QUALIFICATION_TIMEOUT_MS,
  };
  if (typeof dependencies.transport === "function") options.rpcCall = dependencies.transport;
  if (Object.hasOwn(dependencies, "publicFallbacks")) options.publicFallbacks = dependencies.publicFallbacks;
  try {
    const selected = await resolver(
      ETHEREUM_CHAIN_ID,
      Object.hasOwn(dependencies, "urls") ? dependencies.urls : null,
      options,
    );
    if (typeof selected !== "string" || !/^https?:\/\//i.test(selected)) {
      throw new Error("ethereum-rpc-unavailable");
    }
    return selected;
  } catch (error) {
    throw new Error(sanitizeError(error, "ethereum-rpc-unavailable"));
  }
}

// Deterministic on-chain reverts (CALL_EXCEPTION) are a definitive answer from
// the node, unlike transport/rate-limit failures. Keep the two distinguishable
// in sanitized artifacts without ever surfacing raw provider text.
function providerCallErrorCode(error) {
  if (error instanceof CollectionError && ["COLLECTION_BUDGET_EXHAUSTED", "COLLECTION_DEADLINE"].includes(error.code)) {
    return error.code === "COLLECTION_DEADLINE" ? "collection-deadline" : "collection-budget-exhausted";
  }
  const code = typeof error?.code === "string" ? error.code : "";
  return /CALL_EXCEPTION|REVERT/i.test(code) ? "call-reverted" : "provider-call-failed";
}

async function safeProviderCall(provider, to, data) {
  try {
    return await provider.call({ to, data });
  } catch (error) {
    return { error: sanitizeError(error, providerCallErrorCode(error)) };
  }
}

function decodeResult(raw, iface, name) {
  if (!raw || typeof raw !== "string") return null;
  try {
    return iface.decodeFunctionResult(name, raw);
  } catch (_) {
    return null;
  }
}

async function callDecoded(provider, target, iface, name, args = []) {
  const data = iface.encodeFunctionData(name, args);
  const raw = await safeProviderCall(provider, target, data);
  if (raw?.error) return { error: raw.error };
  const decoded = decodeResult(raw, iface, name);
  return decoded ? { value: decoded } : { error: "decode failed" };
}

function extractPush4Selectors(code) {
  const clean = String(code || "").replace(/^0x/i, "").toLowerCase();
  const selectors = new Set();
  for (let i = 0; i + 10 <= clean.length; i += 2) {
    if (clean.slice(i, i + 2) === "63") selectors.add(`0x${clean.slice(i + 2, i + 10)}`);
  }
  return [...selectors].sort();
}

function selectorMatches(selectors) {
  return selectors.filter((s) => KNOWN_SELECTORS[s]).map((selector) => ({ selector, signature: KNOWN_SELECTORS[selector] }));
}

async function proxySlots(provider, address) {
  const out = {};
  for (const [name, slot] of Object.entries({ implementation: EIP1967_IMPLEMENTATION_SLOT, admin: EIP1967_ADMIN_SLOT, beacon: EIP1967_BEACON_SLOT })) {
    try {
      out[name] = slotToAddress(await provider.getStorage(address, slot));
    } catch (_) {
      out[name] = null;
    }
  }
  return out;
}

async function tokenMeta(provider, token) {
  const [symbol, name, decimals] = await Promise.all([
    callDecoded(provider, token, ERC20, "symbol"),
    callDecoded(provider, token, ERC20, "name"),
    callDecoded(provider, token, ERC20, "decimals"),
  ]);
  return {
    symbol: symbol.value ? String(symbol.value[0]) : null,
    name: name.value ? String(name.value[0]) : null,
    decimals: decimals.value ? Number(decimals.value[0]) : null,
    errors: {
      symbol: symbol.error || null,
      name: name.error || null,
      decimals: decimals.error || null,
    },
  };
}

async function tokenBalance(provider, token, holder) {
  const result = await callDecoded(provider, token, ERC20, "balanceOf", [holder]);
  if (!result.value) return { raw: null, error: result.error || "balance unavailable" };
  return { raw: result.value[0], error: null };
}

async function rawAssetConfig(provider, hub, assetId) {
  const encodedId = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [assetId]).slice(2);
  const raw = await safeProviderCall(provider, hub, `${GET_ASSET_CONFIG_SELECTOR}${encodedId}`);
  if (raw?.error) return { error: raw.error, rawLengthBytes: 0, words: [] };
  const clean = String(raw || "0x").replace(/^0x/i, "");
  const words = [];
  for (let i = 0; i + 64 <= clean.length; i += 64) words.push(`0x${clean.slice(i, i + 64)}`);
  return {
    rawLengthBytes: clean.length / 2,
    words: words.slice(0, 12),
    truncated: words.length > 12,
  };
}

async function decodeAssetConfig(provider, assetConfig) {
  const words = assetConfig?.words || [];
  if (words.length < 4) return null;
  const firstAddress = slotToAddress(words[0]);
  const secondAddress = slotToAddress(words[2]);
  const [firstCode, secondCode] = await Promise.all([
    firstAddress ? provider.getCode(firstAddress).catch(() => "0x") : Promise.resolve("0x"),
    secondAddress ? provider.getCode(secondAddress).catch(() => "0x") : Promise.resolve("0x"),
  ]);
  return {
    word0AsAddress: firstAddress,
    word0CodeBytes: firstCode === "0x" ? 0 : (firstCode.length - 2) / 2,
    word1AsUint: words[1] ? BigInt(words[1]).toString() : null,
    word2AsAddress: secondAddress,
    word2CodeBytes: secondCode === "0x" ? 0 : (secondCode.length - 2) / 2,
    word3AsUint: words[3] ? BigInt(words[3]).toString() : null,
  };
}

function formatUnits(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try {
    return ethers.formatUnits(raw, decimals);
  } catch (_) {
    return null;
  }
}

function toNumberAmount(raw, decimals) {
  const formatted = formatUnits(raw, decimals);
  if (formatted === null) return null;
  const n = Number(formatted);
  return Number.isFinite(n) ? n : null;
}

function toNumberRay(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    const n = Number(ethers.formatUnits(raw, 27));
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

function usd(amount, priceUsd) {
  if (!Number.isFinite(amount) || !Number.isFinite(priceUsd)) return null;
  return amount * priceUsd;
}

async function readOptionalAssetViews(provider, hub, assetId, decimals, priceUsd) {
  const entries = await Promise.all(OPTIONAL_ASSET_UINT_VIEWS.map(async (view) => {
    const result = await callDecoded(provider, hub, HUB, view.name, [assetId]);
    if (!result.value) return [view.name, { unitHint: view.unitHint, raw: null, error: result.error || "unavailable" }];
    const components = view.name === "getAssetOwed" ? owedComponents(result.value, decimals, priceUsd) : null;
    const raw = components ? components.totalRaw : result.value[0];
    const amount = view.unitHint === "underlying" ? toNumberAmount(raw, decimals) : null;
    const ray = view.unitHint === "ray" ? toNumberRay(raw) : null;
    return [view.name, {
      unitHint: view.unitHint,
      raw,
      amount,
      amountUsd: usd(amount, priceUsd),
      ray,
      ...(components ? { components } : {}),
      error: null,
    }];
  }));
  return Object.fromEntries(entries);
}

async function readOptionalSpokeViews(provider, hub, assetId, role, spoke, decimals, priceUsd) {
  if (!spoke) return null;
  const entries = await Promise.all(OPTIONAL_SPOKE_UINT_VIEWS.map(async (view) => {
    const result = await callDecoded(provider, hub, HUB, view.name, [assetId, spoke]);
    if (!result.value) return [view.name, { unitHint: view.unitHint, raw: null, error: result.error || "unavailable" }];
    const components = view.name === "getSpokeOwed" ? owedComponents(result.value, decimals, priceUsd) : null;
    const raw = components ? components.totalRaw : result.value[0];
    const amount = view.unitHint === "underlying" ? toNumberAmount(raw, decimals) : null;
    const ray = view.unitHint === "ray" ? toNumberRay(raw) : null;
    return [view.name, {
      unitHint: view.unitHint,
      raw,
      amount,
      amountUsd: usd(amount, priceUsd),
      ray,
      ...(components ? { components } : {}),
      error: null,
    }];
  }));
  return { role, address: spoke, views: Object.fromEntries(entries) };
}

function owedComponents(values, decimals, priceUsd) {
  const drawnRaw = values[0], premiumRaw = values[1], totalRaw = drawnRaw + premiumRaw;
  return { unitHint: "underlying", drawnRaw, premiumRaw, totalRaw,
    drawn: toNumberAmount(drawnRaw, decimals), premium: toNumberAmount(premiumRaw, decimals),
    drawnUsd: usd(toNumberAmount(drawnRaw, decimals), priceUsd), premiumUsd: usd(toNumberAmount(premiumRaw, decimals), priceUsd) };
}

function decodeSpokeConfig(result) {
  if (!result.value) return { error: result.error || "unavailable" };
  const [word0, word1, word2, flag3, flag4] = result.value;
  const maxUint40 = (1n << 40n) - 1n;
  return {
    word0Uint40: word0.toString(),
    word1Uint40: word1.toString(),
    word2Uint24: word2.toString(),
    flag3: Boolean(flag3),
    flag4: Boolean(flag4),
    word0IsMaxUint40: word0 === maxUint40,
    error: null,
  };
}

function decodeReserve(result) {
  if (!result.value) return { error: result.error || "unavailable" };
  const [underlying, hub, assetId, decimals, collateralRisk, flags, dynamicConfigKey] = result.value;
  return {
    underlying: normalizeAddress(underlying),
    hub: normalizeAddress(hub),
    assetId: assetId.toString(),
    decimals: Number(decimals),
    collateralRiskBps: Number(collateralRisk),
    flags: Number(flags),
    dynamicConfigKey: Number(dynamicConfigKey),
    error: null,
  };
}

function decodeReserveConfig(result) {
  if (!result.value) return { error: result.error || "unavailable" };
  const [collateralRisk, paused, frozen, borrowable, receiveSharesEnabled] = result.value;
  return {
    collateralRiskBps: Number(collateralRisk),
    paused: Boolean(paused),
    frozen: Boolean(frozen),
    borrowable: Boolean(borrowable),
    receiveSharesEnabled: Boolean(receiveSharesEnabled),
    error: null,
  };
}

function decodeDynamicReserveConfig(result) {
  if (!result.value) return { error: result.error || "unavailable" };
  const [collateralFactor, maxLiquidationBonus, liquidationFee] = result.value;
  return {
    collateralFactorBps: Number(collateralFactor),
    maxLiquidationBonusBps: Number(maxLiquidationBonus),
    liquidationFeeBps: Number(liquidationFee),
    error: null,
  };
}

function decodeLiquidationConfig(result) {
  if (!result.value) return { error: result.error || "unavailable" };
  const [targetHealthFactor, healthFactorForMaxBonus, liquidationBonusFactor] = result.value;
  return {
    targetHealthFactorRaw: targetHealthFactor.toString(),
    targetHealthFactor: Number(ethers.formatUnits(targetHealthFactor, 18)),
    healthFactorForMaxBonusRaw: healthFactorForMaxBonus.toString(),
    healthFactorForMaxBonus: Number(ethers.formatUnits(healthFactorForMaxBonus, 18)),
    liquidationBonusFactorBps: Number(liquidationBonusFactor),
    error: null,
  };
}

async function readTypedNonLendingReserve(provider, binding, hub, assetId, underlying, decimals) {
  if (String(hub).toLowerCase() !== binding.hub) throw new Error("base-non-lending-hub-mismatch");
  const errors = {};
  async function read(iface, name, args = []) {
    const result = await callDecoded(provider, binding.address, iface, name, args);
    if (!result.value) errors[name] = result.error || "unavailable";
    return result.value?.[0] ?? null;
  }
  let typed;
  if (binding.role === "treasury") {
    const [suppliedAssetsRaw, suppliedSharesRaw, owner, pendingOwner] = await Promise.all([
      read(TREASURY, "getSuppliedAssets", [hub, underlying]), read(TREASURY, "getSuppliedShares", [hub, underlying]),
      read(TREASURY, "owner"), read(TREASURY, "pendingOwner"),
    ]);
    typed = { hub, underlying, suppliedAssetsRaw, suppliedSharesRaw, sharesUnit: "supply-shares", owner, pendingOwner };
  } else {
    const [returnedHub, returnedAssetId, asset, totalAssetsRaw, tokenDecimals] = await Promise.all([
      read(TOKENIZATION, "hub"), read(TOKENIZATION, "assetId"), read(TOKENIZATION, "asset"),
      read(TOKENIZATION, "totalAssets"), read(TOKENIZATION, "decimals"),
    ]);
    const expected = binding.expectedLink;
    if (!expected || String(returnedHub).toLowerCase() !== expected.hub || String(hub).toLowerCase() !== expected.hub
      || returnedAssetId !== BigInt(expected.assetId) || Number(assetId) !== expected.assetId
      || String(asset).toLowerCase() !== expected.asset || String(underlying).toLowerCase() !== expected.asset
      || Number(tokenDecimals) !== expected.decimals || decimals !== expected.decimals) errors.identity = "non-lending-link-identity-mismatch";
    typed = { hub: returnedHub, assetId: returnedAssetId, asset, totalAssetsRaw, decimals: tokenDecimals };
  }
  return { reserveId: null, reserveIdError: null, reserveBearing: false, reason: "NON_LENDING_INTERFACE",
    interfaceKind: binding.role, roleBinding: binding, typed, errors };
}

async function readSpokeReserve(provider, spoke, hub, assetId, decimals, priceUsd, options = {}, underlying = null) {
  if (options.chainId === BASE_CHAIN_ID) {
    const binding = options.roleBindings ? baseRoles.bindingFor(options.roleBindings, spoke) : null;
    if (!binding || !["treasury", "tokenization", "lending"].includes(binding.role)) throw new Error("base-spoke-role-unbound");
    if (binding.role !== "lending") return readTypedNonLendingReserve(provider, binding, hub, assetId, underlying, decimals);
  }
  const [reserveIdResult, oracleResult, maxUserReservesResult, liquidationConfigResult] = await Promise.all([
    callDecoded(provider, spoke, SPOKE, "getReserveId", [hub, assetId]),
    callDecoded(provider, spoke, SPOKE, "ORACLE"),
    callDecoded(provider, spoke, SPOKE, "MAX_USER_RESERVES_LIMIT"),
    callDecoded(provider, spoke, SPOKE, "getLiquidationConfig"),
  ]);
  if (!reserveIdResult.value) {
    return {
      reserveId: null,
      reserveIdError: reserveIdResult.error || "reserve id unavailable",
      // Retain legacy Ethereum handling. Base never interprets a revert as role
      // evidence: only independently bound typed interfaces can exclude a link.
      reserveBearing: options.chainId !== BASE_CHAIN_ID && reserveIdResult.error === "call-reverted" ? false : null,
      oracle: oracleResult.value ? normalizeAddress(oracleResult.value[0]) : null,
      maxUserReservesLimit: maxUserReservesResult.value ? Number(maxUserReservesResult.value[0]) : null,
      liquidationConfig: decodeLiquidationConfig(liquidationConfigResult),
    };
  }
  const reserveId = reserveIdResult.value[0];
  const reserveIdNumber = Number(reserveId);
  const parallelReserveOracle = options.chainId === ETHEREUM_CHAIN_ID;
  // On Ethereum only, drain every launched read (including unexpected decode/
  // encoding failures) before a branch or its caller can advance to metadata or
  // terminal confirmation. The pinned transport still owns physical admission.
  async function joinReads(reads) {
    if (!parallelReserveOracle) return Promise.all(reads);
    const settled = await Promise.allSettled(reads);
    const failed = settled.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    return settled.map(result => result.value);
  }
  async function readReserveState() {
    const [reserveResult, reserveConfigResult, suppliedResult, debtResult, totalDebtResult] = await joinReads([
      callDecoded(provider, spoke, SPOKE, "getReserve", [reserveId]),
      callDecoded(provider, spoke, SPOKE, "getReserveConfig", [reserveId]),
      callDecoded(provider, spoke, SPOKE, "getReserveSuppliedAssets", [reserveId]),
      callDecoded(provider, spoke, SPOKE, "getReserveDebt", [reserveId]),
      callDecoded(provider, spoke, SPOKE, "getReserveTotalDebt", [reserveId]),
    ]);
    const reserve = decodeReserve(reserveResult);
    const dynamicConfigKey = Number.isFinite(reserve.dynamicConfigKey) ? reserve.dynamicConfigKey : 0;
    const dynamicConfigResult = await callDecoded(provider, spoke, SPOKE, "getDynamicReserveConfig", [reserveId, dynamicConfigKey]);
    return { reserveResult, reserveConfigResult, suppliedResult, debtResult, totalDebtResult, reserve, dynamicConfigResult };
  }
  let oracle;
  async function readOracleState() {
    oracle = oracleResult.value ? normalizeAddress(oracleResult.value[0]) : null;
    let oracleData = null;
    if (oracle) {
      const [oracleDecimalsResult, oracleSpokeResult, oracleSourceResult, oraclePriceResult] = await joinReads([
        callDecoded(provider, oracle, AAVE_ORACLE, "decimals"),
        callDecoded(provider, oracle, AAVE_ORACLE, "spoke"),
        callDecoded(provider, oracle, AAVE_ORACLE, "getReserveSource", [reserveId]),
        callDecoded(provider, oracle, AAVE_ORACLE, "getReservePrice", [reserveId]),
      ]);
      const oracleDecimals = oracleDecimalsResult.value ? Number(oracleDecimalsResult.value[0]) : null;
      const oraclePriceRaw = oraclePriceResult.value ? oraclePriceResult.value[0] : null;
      const oraclePrice = oraclePriceRaw !== null && oracleDecimals !== null ? Number(ethers.formatUnits(oraclePriceRaw, oracleDecimals)) : null;
      oracleData = {
        address: oracle,
        decimals: oracleDecimals,
        spoke: oracleSpokeResult.value ? normalizeAddress(oracleSpokeResult.value[0]) : null,
        source: oracleSourceResult.value ? normalizeAddress(oracleSourceResult.value[0]) : null,
        priceRaw: oraclePriceRaw,
        price: Number.isFinite(oraclePrice) ? oraclePrice : null,
        referencePriceUsd: priceUsd,
        priceVsReferenceBps: Number.isFinite(oraclePrice) && Number.isFinite(priceUsd) && priceUsd > 0 ? ((oraclePrice / priceUsd) - 1) * 10000 : null,
        errors: {
          decimals: oracleDecimalsResult.error || null,
          spoke: oracleSpokeResult.error || null,
          source: oracleSourceResult.error || null,
          price: oraclePriceResult.error || null,
        },
      };
    }
    return oracleData;
  }
  const [reserveState, oracleData] = parallelReserveOracle
    ? await joinReads([readReserveState(), readOracleState()])
    : [await readReserveState(), await readOracleState()];
  const { reserveResult, reserveConfigResult, suppliedResult, debtResult, totalDebtResult, reserve, dynamicConfigResult } = reserveState;
  const suppliedRaw = suppliedResult.value ? suppliedResult.value[0] : null;
  const totalDebtRaw = totalDebtResult.value ? totalDebtResult.value[0] : null;
  const drawnDebtRaw = debtResult.value ? debtResult.value[0] : null;
  const premiumDebtRaw = debtResult.value ? debtResult.value[1] : null;
  return {
    reserveId: reserveIdNumber,
    reserveIdError: null,
    reserveBearing: true,
    oracle,
    maxUserReservesLimit: maxUserReservesResult.value ? Number(maxUserReservesResult.value[0]) : null,
    liquidationConfig: decodeLiquidationConfig(liquidationConfigResult),
    reserve,
    reserveConfig: decodeReserveConfig(reserveConfigResult),
    dynamicConfig: decodeDynamicReserveConfig(dynamicConfigResult),
    suppliedRaw,
    supplied: toNumberAmount(suppliedRaw, decimals),
    suppliedUsd: usd(toNumberAmount(suppliedRaw, decimals), priceUsd),
    drawnDebtRaw,
    drawnDebt: toNumberAmount(drawnDebtRaw, decimals),
    drawnDebtUsd: usd(toNumberAmount(drawnDebtRaw, decimals), priceUsd),
    premiumDebtRaw,
    premiumDebt: toNumberAmount(premiumDebtRaw, decimals),
    premiumDebtUsd: usd(toNumberAmount(premiumDebtRaw, decimals), priceUsd),
    totalDebtRaw,
    totalDebt: toNumberAmount(totalDebtRaw, decimals),
    totalDebtUsd: usd(toNumberAmount(totalDebtRaw, decimals), priceUsd),
    oracleData,
    errors: {
      oracle: oracleResult.error || null,
      maxUserReservesLimit: maxUserReservesResult.error || null,
      liquidationConfig: liquidationConfigResult.error || null,
      reserve: reserveResult.error || null,
      reserveConfig: reserveConfigResult.error || null,
      dynamicConfig: dynamicConfigResult.error || null,
      supplied: suppliedResult.error || null,
      debt: debtResult.error || null,
      totalDebt: totalDebtResult.error || null,
    },
  };
}

async function readSpokeDirectory(provider, hub, assetId, decimals, priceUsd, options = {}, underlying = null) {
  const countResult = await callDecoded(provider, hub, HUB, "getSpokeCount", [assetId]);
  if (!countResult.value) {
    return { count: null, truncated: false, rows: [], error: countResult.error || "spoke count unavailable" };
  }
  const count = Number(countResult.value[0]);
  const rows = [];
  for (let index = 0; index < Math.min(count, MAX_SPOKES_PER_ASSET); index++) {
    const addressResult = await callDecoded(provider, hub, HUB, "getSpokeAddress", [assetId, index]);
    const spoke = addressResult.value ? normalizeAddress(addressResult.value[0]) : null;
    if (!spoke) {
      rows.push({ index, address: null, error: addressResult.error || "spoke address unavailable" });
      continue;
    }
    const [listedResult, configResult, accounting, reserve] = await Promise.all([
      callDecoded(provider, hub, HUB, "isSpokeListed", [assetId, spoke]),
      callDecoded(provider, hub, HUB, "getSpokeConfig", [assetId, spoke]),
      readOptionalSpokeViews(provider, hub, assetId, "listed", spoke, decimals, priceUsd),
       readSpokeReserve(provider, spoke, hub, assetId, decimals, priceUsd, options, underlying),
    ]);
    rows.push({
      index,
      address: spoke,
      listed: listedResult.value ? Boolean(listedResult.value[0]) : null,
      listedError: listedResult.error || null,
      config: decodeSpokeConfig(configResult),
      reserve,
      accounting,
    });
  }
  return { count, truncated: count > MAX_SPOKES_PER_ASSET, rows, error: null };
}

async function readOptionalAddressViews(provider, target, options = {}) {
  if (options.chainId === BASE_CHAIN_ID) {
    const binding = options.roleBindings ? baseRoles.bindingFor(options.roleBindings, target) : null;
    if (!binding) return { deploymentSemantics: { status: "UNKNOWN_DEPLOYMENT_SEMANTICS", error: "deployment-semantics-unresolved" } };
    const iface = binding.role === "treasury" ? TREASURY : binding.role === "tokenization" ? TOKENIZATION : DEPENDENCY;
    const names = binding.role === "treasury" ? ["owner", "pendingOwner"]
      : binding.role === "tokenization" ? ["hub", "assetId", "asset", "totalAssets", "decimals"]
        : binding.role === "strategy" ? ["HUB"] : ["authority"];
    const views = await Promise.all(names.map(async name => {
      const result = await callDecoded(provider, target, iface, name);
      if (binding.role === "strategy" && result.value && String(result.value[0]).toLowerCase() !== binding.hub) {
        return [name, { value: result.value[0], error: "dependency-hub-identity-mismatch" }];
      }
      return [name, { value: result.value?.[0] ?? null, error: result.error || null }];
    }));
    return { interfaceKind: binding.role, roleBinding: binding, ...Object.fromEntries(views) };
  }
  const names = ["HUB", "owner", "authority"];
  if (options.chainId === ETHEREUM_CHAIN_ID && Array.isArray(options.deferredMetadata)) {
    const views = Object.fromEntries(names.map(name => [name, { address: null, status: "UNKNOWN", error: "metadata-deferred" }]));
    options.deferredMetadata.push({ target, views });
    return views;
  }
  const entries = await Promise.all(names.map(async (name) => {
    const result = await callDecoded(provider, target, DEPENDENCY, name);
    if (!result.value) return [name, { address: null, error: result.error || "unavailable" }];
    return [name, { address: normalizeAddress(result.value[0]), error: null }];
  }));
  return Object.fromEntries(entries);
}

// Only the three generic Ethereum metadata views are deferrable. Unknown legacy
// contexts without a numeric budget snapshot produce UNKNOWN, never unlimited IO.
async function collectDeferredMetadata(context, jobs) {
  const counts = { declared: jobs.length * 3, attempted: 0, succeeded: 0, failed: 0,
    viewsSkippedForBudget: 0, viewsSkippedForUnknownBudget: 0, metadataIncomplete: false };
  for (const { target, views } of jobs) {
    views.viewsSkippedForBudget = 0;
    views.metadataIncomplete = false;
    for (const name of ["HUB", "owner", "authority"]) {
      let budget;
      try { budget = context.budgetStatus?.(); } catch (_) { /* no admission capability */ }
      const known = budget && [budget.ordinaryRequestsRemaining, budget.ordinaryTimeRemainingMs, budget.activeRequests,
        budget.queuedRequests, budget.outstandingRequests, budget.effectiveLimits?.timeoutMs]
        .every(value => Number.isSafeInteger(value) && value >= 0) && budget.effectiveLimits.timeoutMs > 0;
      const admitted = known && budget.outstandingRequests === 0 && budget.activeRequests === 0 && budget.queuedRequests === 0
        && budget.ordinaryRequestsRemaining >= 1 && budget.ordinaryTimeRemainingMs > budget.effectiveLimits.timeoutMs;
      if (!admitted) {
        views[name] = { address: null, status: "UNKNOWN", error: known ? "metadata-budget-skipped" : "metadata-budget-unavailable" };
        counts.viewsSkippedForBudget += 1;
        views.viewsSkippedForBudget += 1;
        if (!known) counts.viewsSkippedForUnknownBudget += 1;
        views.metadataIncomplete = counts.metadataIncomplete = true;
        continue;
      }
      counts.attempted += 1;
      const result = await callDecoded(context.provider, target, DEPENDENCY, name);
      if (!result.value) {
        counts.failed += 1;
        views.metadataIncomplete = counts.metadataIncomplete = true;
        views[name] = { address: null, status: "UNKNOWN", error: result.error || "unavailable" };
      } else {
        counts.succeeded += 1;
        views[name] = { address: normalizeAddress(result.value[0]), error: null };
      }
    }
  }
  return counts;
}

async function summarizeImplementation(provider, address) {
  if (!address) return null;
  const code = await provider.getCode(address).catch(() => "0x");
  const selectors = extractPush4Selectors(code);
  return {
    address,
    codePresent: code !== "0x",
    codeBytes: code === "0x" ? 0 : (code.length - 2) / 2,
    selectorMatches: selectorMatches(selectors),
    push4SelectorsSample: selectors.slice(0, 120),
  };
}

async function summarizeConfigDependencies(provider, assets, options = {}) {
  const byAddress = new Map();
  for (const asset of assets) {
    const decoded = asset.assetConfig?.decoded || {};
    for (const [word, address] of [["word0", decoded.word0AsAddress], ["word2", decoded.word2AsAddress]]) {
      if (!address) continue;
      const key = address.toLowerCase();
      if (!byAddress.has(key)) byAddress.set(key, { address, roles: new Set(), linkedAssets: [] });
      const entry = byAddress.get(key);
      entry.roles.add(word);
      if (entry.linkedAssets.length < 30) entry.linkedAssets.push({ assetId: asset.assetId, symbol: asset.symbol, word });
    }
  }
  const out = [];
  for (const entry of byAddress.values()) {
    const [code, slots] = await Promise.all([
      provider.getCode(entry.address).catch(() => "0x"),
      proxySlots(provider, entry.address),
    ]);
    const selectors = extractPush4Selectors(code);
    out.push({
      address: entry.address,
      roles: [...entry.roles].sort(),
      linkedAssets: entry.linkedAssets,
      codePresent: code !== "0x",
      codeBytes: code === "0x" ? 0 : (code.length - 2) / 2,
      eip1967: slots,
      views: await readOptionalAddressViews(provider, entry.address, options),
      implementation: slots.implementation ? await summarizeImplementation(provider, slots.implementation) : null,
      selectorMatches: selectorMatches(selectors),
      push4SelectorsSample: selectors.slice(0, 80),
    });
  }
  return out.sort((a, b) => a.address.localeCompare(b.address));
}

async function summarizeListedSpokeDependencies(provider, assets, options = {}) {
  const byAddress = new Map();
  for (const asset of assets) {
    for (const row of asset.spokeDirectory?.rows || []) {
      if (!row.address) continue;
      const key = row.address.toLowerCase();
      if (!byAddress.has(key)) byAddress.set(key, { address: row.address, linkedAssets: [], totalAddedAssetsUsd: 0, totalOwedUsd: 0 });
      const entry = byAddress.get(key);
      const views = row.accounting?.views || {};
      const addedAssetsUsd = views.getSpokeAddedAssets?.amountUsd ?? null;
      const owedUsd = views.getSpokeOwed?.amountUsd ?? null;
      if (Number.isFinite(addedAssetsUsd)) entry.totalAddedAssetsUsd += addedAssetsUsd;
      if (Number.isFinite(owedUsd)) entry.totalOwedUsd += owedUsd;
      if (entry.linkedAssets.length < 30) {
        entry.linkedAssets.push({
          assetId: asset.assetId,
          symbol: asset.symbol,
          spokeIndex: row.index,
          listed: row.listed,
          addedAssetsUsd,
          owedUsd,
          config: row.config,
          reserve: row.reserve ? {
            reserveId: row.reserve.reserveId,
            reserveConfig: row.reserve.reserveConfig || null,
            dynamicConfig: row.reserve.dynamicConfig || null,
            oracleData: row.reserve.oracleData ? {
              address: row.reserve.oracleData.address,
              source: row.reserve.oracleData.source,
              price: row.reserve.oracleData.price,
              referencePriceUsd: row.reserve.oracleData.referencePriceUsd,
              priceVsReferenceBps: row.reserve.oracleData.priceVsReferenceBps,
            } : null,
          } : null,
        });
      }
    }
  }
  const out = [];
  for (const entry of byAddress.values()) {
    const [code, slots] = await Promise.all([
      provider.getCode(entry.address).catch(() => "0x"),
      proxySlots(provider, entry.address),
    ]);
    const selectors = extractPush4Selectors(code);
    out.push({
      address: entry.address,
      linkedAssets: entry.linkedAssets,
      totalAddedAssetsUsd: entry.totalAddedAssetsUsd,
      totalOwedUsd: entry.totalOwedUsd,
      codePresent: code !== "0x",
      codeBytes: code === "0x" ? 0 : (code.length - 2) / 2,
      eip1967: slots,
      views: await readOptionalAddressViews(provider, entry.address, options),
      implementation: slots.implementation ? await summarizeImplementation(provider, slots.implementation) : null,
      selectorMatches: selectorMatches(selectors),
      push4SelectorsSample: selectors.slice(0, 80),
    });
  }
  return out.sort((a, b) => Math.max(b.totalAddedAssetsUsd || 0, b.totalOwedUsd || 0) - Math.max(a.totalAddedAssetsUsd || 0, a.totalOwedUsd || 0));
}

function compactSpokeDirectoryMetrics(asset) {
  const rows = asset.spokeDirectory?.rows || [];
  return rows.reduce((acc, row) => {
    const views = row.accounting?.views || {};
    const addedUsd = views.getSpokeAddedAssets?.amountUsd;
    const owedUsd = views.getSpokeOwed?.amountUsd;
    const totalOwedUsd = views.getSpokeTotalOwed?.amountUsd;
    if (Number.isFinite(addedUsd)) acc.addedAssetsUsd += addedUsd;
    if (Number.isFinite(owedUsd)) acc.owedUsd += owedUsd;
    if (Number.isFinite(totalOwedUsd)) acc.totalOwedUsd += totalOwedUsd;
    if (row.listed === true) acc.listed += 1;
    return acc;
  }, { listed: 0, addedAssetsUsd: 0, owedUsd: 0, totalOwedUsd: 0 });
}

function compactAssetRow(hub, asset) {
  const decoded = asset.assetConfig?.decoded || {};
  const spokeAccounting = Array.isArray(asset.spokeAccounting) ? asset.spokeAccounting : [];
  const word0SpokeViews = spokeAccounting.find((entry) => entry.role === "word0")?.views || {};
  const word2SpokeViews = spokeAccounting.find((entry) => entry.role === "word2")?.views || {};
  const spokeDirectoryMetrics = compactSpokeDirectoryMetrics(asset);
  return {
    hub: hub.name,
    hubAddress: hub.address,
    assetId: asset.assetId,
    underlying: asset.underlying,
    symbol: asset.symbol,
    cashUsd: asset.cashUsd,
    totalOwedUsd: asset.totalOwedUsd,
    utilizationPct: asset.utilizationPct,
    accountingLiquidityUsd: asset.accountingViews?.getAssetLiquidity?.amountUsd ?? null,
    accountingOwedUsd: asset.accountingViews?.getAssetOwed?.amountUsd ?? null,
    configWord0AsAddress: decoded.word0AsAddress || null,
    configWord1AsUint: decoded.word1AsUint || null,
    configWord2AsAddress: decoded.word2AsAddress || null,
    configWord3AsUint: decoded.word3AsUint || null,
    word0SpokeAddedAssetsUsd: word0SpokeViews.getSpokeAddedAssets?.amountUsd ?? null,
    word0SpokeOwedUsd: word0SpokeViews.getSpokeOwed?.amountUsd ?? null,
    word2SpokeAddedAssetsUsd: word2SpokeViews.getSpokeAddedAssets?.amountUsd ?? null,
    word2SpokeOwedUsd: word2SpokeViews.getSpokeOwed?.amountUsd ?? null,
    listedSpokeCount: asset.spokeDirectory?.count ?? null,
    listedSpokeRowsScanned: asset.spokeDirectory?.rows?.length ?? 0,
    listedSpokeAddedAssetsUsd: spokeDirectoryMetrics.addedAssetsUsd,
    listedSpokeOwedUsd: spokeDirectoryMetrics.owedUsd,
    listedSpokeTotalOwedUsd: spokeDirectoryMetrics.totalOwedUsd,
    blockers: asset.blockers,
  };
}

async function fetchCoinPrices(addresses) {
  const prices = {};
  const unique = [...new Set(addresses.map((a) => normalizeAddress(a)).filter(Boolean))];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const coins = chunk.map((a) => `ethereum:${a}`).join(",");
    try {
      const res = await fetch(`https://coins.llama.fi/prices/current/${coins}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) continue;
      const json = await res.json();
      for (const addr of chunk) prices[addr.toLowerCase()] = json.coins?.[`ethereum:${addr}`]?.price ?? null;
    } catch (_) {
      for (const addr of chunk) prices[addr.toLowerCase()] = null;
    }
  }
  return prices;
}

async function scanHub(provider, hub, priceByAddress, options = {}) {
  const address = normalizeAddress(hub.address);
  const code = await provider.getCode(address);
  const selectors = extractPush4Selectors(code);
  const directSelectorMatches = selectorMatches(selectors);
  const slots = await proxySlots(provider, address);
  let implementation = null;
  if (slots.implementation) {
    const implCode = await provider.getCode(slots.implementation);
    const implSelectors = extractPush4Selectors(implCode);
    implementation = {
      address: slots.implementation,
      codePresent: implCode !== "0x",
      codeBytes: implCode === "0x" ? 0 : (implCode.length - 2) / 2,
      selectorMatches: selectorMatches(implSelectors),
      push4SelectorsSample: implSelectors.slice(0, 160),
    };
  }
  const assetCountResult = await callDecoded(provider, address, HUB, "getAssetCount");
  const assetCount = assetCountResult.value ? Number(assetCountResult.value[0]) : 0;
  const assets = [];
  for (let assetId = 0; assetId < Math.min(assetCount, MAX_ASSETS_PER_HUB); assetId++) {
    const underlyingResult = await callDecoded(provider, address, HUB, "getAssetUnderlyingAndDecimals", [assetId]);
    if (!underlyingResult.value) {
      assets.push({ assetId, status: "unreadable", routePositive: false, error: underlyingResult.error || "asset decode failed" });
      continue;
    }
    const underlying = normalizeAddress(underlyingResult.value[0]);
    const hubDecimals = Number(underlyingResult.value[1]);
    const [owedResult, meta, balance, assetConfig, underlyingListedResult] = await Promise.all([
      callDecoded(provider, address, HUB, "getAssetTotalOwed", [assetId]),
      tokenMeta(provider, underlying),
      tokenBalance(provider, underlying, address),
      rawAssetConfig(provider, address, assetId),
      callDecoded(provider, address, HUB, "isUnderlyingListed", [underlying]),
    ]);
    const decimals = meta.decimals ?? hubDecimals;
    const owedRaw = owedResult.value ? owedResult.value[0] : null;
    const cashRaw = balance.raw;
    const decodedAssetConfig = await decodeAssetConfig(provider, assetConfig);
    const owed = toNumberAmount(owedRaw, decimals);
    const cash = toNumberAmount(cashRaw, decimals);
    const priceUsd = priceByAddress[underlying.toLowerCase()] ?? null;
    const owedUsd = usd(owed, priceUsd);
    const cashUsd = usd(cash, priceUsd);
    const accountingViews = await readOptionalAssetViews(provider, address, assetId, decimals, priceUsd);
    const spokeAccountingInputs = [
      ["word0", decodedAssetConfig?.word0AsAddress],
      ["word2", decodedAssetConfig?.word2AsAddress],
    ].filter(([, spoke], index, rows) => spoke && rows.findIndex(([, other]) => other?.toLowerCase() === spoke.toLowerCase()) === index);
    const spokeAccounting = (await Promise.all(spokeAccountingInputs.map(([role, spoke]) => (
      readOptionalSpokeViews(provider, address, assetId, role, spoke, decimals, priceUsd)
    )))).filter(Boolean);
    const spokeDirectory = await readSpokeDirectory(provider, address, assetId, decimals, priceUsd, options, underlying);
    const utilizationPct = Number.isFinite(owed) && Number.isFinite(cash) && owed + cash > 0 ? (owed / (owed + cash)) * 100 : null;
    const reviewCandidate = (Number.isFinite(owedUsd) && owedUsd >= REVIEW_BORROWED_USD) || (Number.isFinite(cashUsd) && cashUsd >= REVIEW_CASH_USD);
    const blockers = [
      "Recovered hub selectors expose add/remove/draw/restore and spoke accounting, but no borrower/oracle/liquidation route is mapped",
      "No route-positive fork proof",
      "No route-specific executor or artifact execution gate",
    ];
    if (priceUsd === null) blockers.unshift("No live USD reference price from public coin data");
    if (owedResult.error) blockers.unshift("Asset owed total could not be read");
    assets.push({
      assetId,
      underlying,
      symbol: meta.symbol,
      name: meta.name,
      decimals,
      hubReportedDecimals: hubDecimals,
      underlyingListed: underlyingListedResult.value ? Boolean(underlyingListedResult.value[0]) : null,
      underlyingListedError: underlyingListedResult.error || null,
      priceUsd,
      cashRaw,
      cash,
      cashUsd,
      totalOwedRaw: owedRaw,
      totalOwed: owed,
      totalOwedUsd: owedUsd,
      utilizationPct,
      accountingViews,
      spokeAccounting,
      spokeDirectory,
      assetConfig: { ...assetConfig, decoded: decodedAssetConfig },
      reviewCandidate,
      watchCandidate: false,
      routePositive: false,
      blockers,
    });
  }
  const totals = assets.reduce((acc, asset) => {
    if (Number.isFinite(asset.cashUsd)) acc.cashUsd += asset.cashUsd;
    if (Number.isFinite(asset.totalOwedUsd)) acc.totalOwedUsd += asset.totalOwedUsd;
    if (asset.reviewCandidate) acc.reviewCandidates += 1;
    if (asset.watchCandidate) acc.watchCandidates += 1;
    if (asset.routePositive) acc.routePositive += 1;
    return acc;
  }, { cashUsd: 0, totalOwedUsd: 0, reviewCandidates: 0, watchCandidates: 0, routePositive: 0 });
  const configDependencies = await summarizeConfigDependencies(provider, assets, options);
  const listedSpokeDependencies = await summarizeListedSpokeDependencies(provider, assets, options);
  return {
    name: hub.name,
    address,
    codePresent: code !== "0x",
    codeBytes: code === "0x" ? 0 : (code.length - 2) / 2,
    sourceVerified: false,
    publicSourceStatus: "No Sourcify/Codeslaw match; Etherscan source API requires key",
    eip1967: slots,
    implementation,
    selectorMatches: directSelectorMatches,
    push4SelectorsSample: selectors.slice(0, 120),
    configDependencies,
    listedSpokeDependencies,
    assetCountReadOk: Boolean(assetCountResult.value),
    assetCount,
    assetScanTruncated: assetCount > MAX_ASSETS_PER_HUB,
    assets,
    totals,
  };
}

function requiredSpokeRowError(row, requested = {}) {
  if (!row?.address || row.listedError || row.config?.error || row.reserve?.reserveId === null || row.reserve?.reserveIdError) return "reserve-state-read-failed";
  if (row.listed !== true) return "reserve-link-not-listed";
  if (Object.values(row.reserve?.errors || {}).some(Boolean)) return "reserve-state-read-failed";
  if (Object.values(row.reserve?.oracleData?.errors || {}).some(Boolean)) return "reserve-state-read-failed";
  const expectedHub = normalizeAddress(requested.hubAddress);
  const expectedSpoke = normalizeAddress(requested.spoke);
  const expectedAssetId = Number(requested.assetId);
  const returned = row.reserve?.reserve;
  if (!expectedHub || !expectedSpoke || !Number.isSafeInteger(expectedAssetId)
    || normalizeAddress(returned?.hub) !== expectedHub
    || Number(returned?.assetId) !== expectedAssetId
    || normalizeAddress(row.reserve?.oracleData?.spoke) !== expectedSpoke) return "reserve-link-identity-mismatch";
  const expectedUnderlying = normalizeAddress(requested.underlying);
  if (expectedUnderlying && normalizeAddress(returned?.underlying) !== expectedUnderlying) return "reserve-link-identity-mismatch";
  return null;
}

function requiredSpokeRowOk(row, requested = {}) {
  return requiredSpokeRowError(row, requested) === null;
}

// Base exclusions require the in-memory binding itself, not a registry label,
// boolean supplied by an untrusted row, or a deterministic lending revert.
function isNonReserveSpokeRow(row, options = {}) {
  if (options.chainId === BASE_CHAIN_ID) {
    const binding = options.roleBindings && row?.address ? baseRoles.bindingFor(options.roleBindings, row.address) : null;
    return binding && ["treasury", "tokenization"].includes(binding.role) && row.reserve?.roleBinding === binding
      && row.reserve?.reason === "NON_LENDING_INTERFACE" && row.reserve?.reserveBearing === false;
  }
  return row?.reserve?.reserveBearing === false;
}

function buildTopologySourceCoverage(hubs, registry = null, options = {}) {
  const requiredHubCount = Number.isInteger(registry?.hubsDeclared) && registry.hubsDeclared > 0 ? registry.hubsDeclared : hubs.length;
  const topologyUniverse = buildTopologyUniverse(registry, requiredHubCount);
  const blocker = topologyUniverse.bound === true
    ? `The V4 topology hub set is bound to ${topologyUniverse.registry}@${topologyUniverse.version}; the sampled reserve/spoke state remains an observational bound, not an exhaustive-position proof.`
    : `The V4 topology is a declared static hub set without a bound authoritative registry/version (${topologyUniverse.failureReason}); it is observational only.`;
  const perSpokeReserveLinkCap = MAX_ASSETS_PER_HUB * requiredHubCount;
  const reserveLinksCap = perSpokeReserveLinkCap * MAX_SPOKES_PER_ASSET;
  const assetsExpected = hubs.reduce((sum, hub) => sum + (Number.isInteger(hub.assetCount) ? hub.assetCount : 0), 0);
  const assetsObserved = hubs.reduce((sum, hub) => sum + (hub.assets || []).length, 0);
  let reserveLinksDeclared = 0;
  let nonReserveSpokesExcluded = 0;
  let stateReadsAttempted = hubs.length;
  let stateReadsSucceeded = hubs.filter((hub) => hub.assetCountReadOk).length;
  const errors = [];
  if (options.chainId === BASE_CHAIN_ID && options.roleBindings?.unresolved?.length) errors.push("deployment-semantics-unresolved");
  const reserveLinksBySpoke = new Map();
  const expectedLinks = new Set();
  const observedLinks = new Map();
  const consumedLinks = new Map();
  for (const hub of hubs) {
    if (!hub.assetCountReadOk) errors.push("hub-state-read-failed");
    if (hub.assetScanTruncated) errors.push("topology-truncated");
    for (const asset of hub.assets || []) {
      stateReadsAttempted += 2;
      const assetOk = asset.status !== "unreadable";
      if (assetOk) stateReadsSucceeded += 1;
      else errors.push("asset-state-read-failed");
      const directory = asset.spokeDirectory;
      const directoryOk = Number.isInteger(directory?.count) && !directory.error;
      if (directoryOk) stateReadsSucceeded += 1;
      else errors.push("spoke-directory-read-failed");
      if (directory?.truncated) errors.push("topology-truncated");
      const directoryRows = directory?.rows || [];
      const nonReserveInDirectory = directoryRows.filter(row => isNonReserveSpokeRow(row, options)).length;
      if (Number.isInteger(directory?.count)) reserveLinksDeclared += directory.count - nonReserveInDirectory;
      for (const row of directoryRows) {
        if (isNonReserveSpokeRow(row, options)) {
          nonReserveSpokesExcluded += 1;
          if (options.chainId === BASE_CHAIN_ID) {
            stateReadsAttempted += 1;
            if (row.listed === true && !row.listedError && !row.config?.error && !Object.values(row.reserve.errors || {}).some(Boolean)) stateReadsSucceeded += 1;
            else errors.push("non-lending-dependency-read-failed");
          }
          continue;
        }
        stateReadsAttempted += 1;
        const spokeKey = row?.address?.toLowerCase?.() || null;
        const aggregate = spokeKey ? reserveLinksBySpoke.get(spokeKey) || {
          spoke: row.address, expected: 0, observed: 0, consumed: 0,
          cap: perSpokeReserveLinkCap, wasTruncated: false, links: [],
        } : null;
        const expectedKey = spokeKey && Number.isInteger(asset.assetId) && asset.assetId >= 0
          ? `${hub.address.toLowerCase()}:${Number(asset.assetId)}:${spokeKey}` : null;
        if (aggregate && expectedKey && !expectedLinks.has(expectedKey)) {
          expectedLinks.add(expectedKey);
          aggregate.expected += 1;
        } else if (expectedKey) errors.push("duplicate-reserve-link");
        // `Number(null)` is 0, so the previous Number.isSafeInteger(Number(...))
        // check counted every unreadable reserve as an observed link with
        // reserveId 0. Require a genuine non-negative integer instead.
        const reserveIdValue = row?.reserve?.reserveId;
        const exactLink = spokeKey && Number.isInteger(asset.assetId) && asset.assetId >= 0
          && Number.isInteger(reserveIdValue) && reserveIdValue >= 0 ? {
          hubAddress: hub.address,
          assetId: Number(asset.assetId),
          spoke: row.address,
          reserveId: Number(row.reserve.reserveId),
        } : null;
        const exactKey = exactLink
          ? `${exactLink.hubAddress.toLowerCase()}:${exactLink.assetId}:${spokeKey}:${exactLink.reserveId}`
          : null;
        if (exactKey && !observedLinks.has(exactKey)) {
          observedLinks.set(exactKey, exactLink);
          aggregate.observed += 1;
        } else if (exactKey) errors.push("duplicate-reserve-link");
        const rowError = requiredSpokeRowError(row, {
          hubAddress: hub.address,
          assetId: asset.assetId,
          underlying: asset.underlying,
          spoke: row.address,
        });
        if (!rowError) {
          stateReadsSucceeded += 1;
          if (exactKey && !consumedLinks.has(exactKey)) {
            consumedLinks.set(exactKey, exactLink);
            aggregate.consumed += 1;
            aggregate.links.push(exactLink);
          }
        } else errors.push(rowError);
        if (aggregate) reserveLinksBySpoke.set(spokeKey, aggregate);
      }
    }
  }
  const wasTruncated = errors.includes("topology-truncated");
  const spokeReserveLinks = [...reserveLinksBySpoke.values()]
    .map(row => ({ ...row, wasTruncated }))
    .sort((a, b) => a.spoke.toLowerCase().localeCompare(b.spoke.toLowerCase()));
  const spokesExpected = spokeReserveLinks.length;
  const spokesObserved = spokeReserveLinks.filter(row => row.expected === row.consumed).length;
  const reserveLinksObserved = observedLinks.size;
  const reserveLinksConsumed = consumedLinks.size;
  const reserveLinksExpected = expectedLinks.size;
  const stateReadsFailed = stateReadsAttempted - stateReadsSucceeded;
  if (hubs.length !== requiredHubCount) errors.push("required-hub-failed");
  if (assetsObserved !== assetsExpected) errors.push("required-asset-failed");
  if (reserveLinksDeclared !== reserveLinksExpected || reserveLinksObserved !== reserveLinksExpected || reserveLinksConsumed !== reserveLinksExpected || spokesObserved !== spokesExpected) errors.push("required-spoke-failed");
  if (stateReadsFailed > 0) errors.push("topology-state-read-failed");
  const uniqueErrors = [...new Set(errors)];
  const sampleComplete = uniqueErrors.length === 0 && !wasTruncated;
  return buildAaveSourceCoverage("V4", "topology", {
    complete: false,
    sampleComplete,
    fullHistoryProven: false,
    exhaustiveProof: null,
    blocker,
    topologyUniverse,
    chainsExpected: 1,
    chainsObserved: hubs.length === requiredHubCount ? 1 : 0,
    hubsExpected: requiredHubCount,
    hubsObserved: hubs.length,
    assetsExpected,
    assetsObserved,
    spokesExpected,
    spokesObserved,
    spokeReserveLinks,
    consumedReserveLinks: [...consumedLinks.values()],
    reserveLinksExpected,
    reserveLinksDeclared,
    reserveLinksObserved,
    reserveLinksConsumed,
    reserveLinksCap,
    reserveLinksTruncated: wasTruncated,
    nonReserveSpokesExcluded,
    stateReadsAttempted,
    stateReadsSucceeded,
    stateReadsFailed,
    truncationLimit: reserveLinksCap,
    topologyCaps: { assetsPerHub: MAX_ASSETS_PER_HUB, spokesPerAsset: MAX_SPOKES_PER_ASSET, reserveLinks: reserveLinksCap, reserveLinksPerSpoke: perSpokeReserveLinkCap },
    wasTruncated,
    errors: uniqueErrors,
  });
}

const FAILURE_CODES = new Set(["COLLECTION_BUDGET_EXHAUSTED", "COLLECTION_DEADLINE", "TERMINAL_PIN_MISMATCH",
  "PIN_STALE_OR_FUTURE", "RPC_TRANSPORT", "RPC_RATE_LIMITED", "RPC_HTTP_REJECTED", "RPC_RESPONSE_TOO_LARGE",
  "RPC_INVALID_JSON", "RPC_INVALID_ENVELOPE", "RPC_REJECTED", "RPC_INVALID_RESULT", "RPC_INVALID_HEADER",
  "CALL_EXCEPTION", "LOG_RANGE_LIMIT", "INVALID_CHAIN_ID", "INVALID_LIMITS", "INVALID_PROBE_ADDRESS",
  "INVALID_CANDIDATES", "INVALID_HISTORY_PROBE", "HISTORY_CAPABILITY_UNAVAILABLE", "PREFLIGHT_FAILED",
  "TWO_FAMILIES_UNAVAILABLE", "INDEPENDENT_FAMILIES_UNAVAILABLE", "COMMON_PIN_UNAVAILABLE",
  "PIN_CONSENSUS_UNAVAILABLE", "STATE_CONSENSUS_UNAVAILABLE", "REQUESTED_PIN_INVALID", "REQUESTED_PIN_MISMATCH",
  "NETWORK_CALL_CAP", "PROBE_DECODE_FAILED", "INVALID_MULTICALL_RESULT", "MULTICALL_EQUIVALENCE_FAILED"]);
const FAILURE_STAGES = new Set(["START", "REGISTRY", "PIN_QUALIFICATION", "ASSET_ENUMERATION", "PRICE_LOOKUP",
  "DEPENDENCY_METADATA", "COVERAGE_VALIDATION", "PIN_CONFIRMATION", "COMPLETE"]);
const FAILURE_COUNTERS = ["dispatchedRequests", "stateRequests", "stateReadOperations", "stateCacheHits",
  "stateTransportFailures", "revertedStateReads", "rejectedRequests", "viewBatchCalls", "viewBatchSplits",
  "viewBatchSubcalls", "viewBatchComparisons", "viewBatchVerifiedSelectors", "networkCalls", "headerFamilies",
  "stateFamilies", "automaticRetries"];
// Read only own data properties: never invoke injected getters or copy toJSON,
// provider objects, error payloads, handles, params, headers or arbitrary text.
function diagnosticValue(value, key) {
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch (_) { return undefined; }
}
function diagnosticNumber(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}
function diagnosticTime(now) {
  try { const n = now(); return diagnosticNumber(n, 8640000000000000) === null ? null : new Date(n).toISOString(); }
  catch (_) { return null; }
}
function diagnosticPhase(value) {
  return FAILURE_STAGES.has(value) || (typeof value === "string" && /^HUB_[1-9][0-9]{0,3}$/.test(value)
    && Number(value.slice(4)) <= 1024) ? value : "UNKNOWN";
}
function diagnosticBudget(value) {
  const inputLimits = diagnosticValue(value, "effectiveLimits"), effectiveLimits = {};
  for (const key of Object.keys(COLLECTION_LIMITS)) {
    const n = diagnosticNumber(diagnosticValue(inputLimits, key), COLLECTION_LIMITS[key]);
    if (n === null || n === 0) return null;
    effectiveLimits[key] = n;
  }
  const out = { effectiveLimits };
  for (const [key, maximum] of [["elapsedMs", Number.MAX_SAFE_INTEGER], ["ordinaryRequestsRemaining", effectiveLimits.maxRequests],
    ["ordinaryTimeRemainingMs", effectiveLimits.maxMs], ["activeRequests", effectiveLimits.concurrency],
    ["queuedRequests", effectiveLimits.maxRequests], ["outstandingRequests", effectiveLimits.maxRequests]]) {
    const n = diagnosticNumber(diagnosticValue(value, key), maximum);
    if (n === null) return null;
    out[key] = n;
  }
  if (out.outstandingRequests !== out.activeRequests + out.queuedRequests) return null;
  if (effectiveLimits.maxRequests < 160 || effectiveLimits.reserveRequests < 4
    || out.ordinaryRequestsRemaining > effectiveLimits.maxRequests - effectiveLimits.reserveRequests
    || out.ordinaryTimeRemainingMs > Math.max(0, effectiveLimits.maxMs - 3 * effectiveLimits.timeoutMs)) return null;
  return out;
}
function failureSnapshot(error, { now, startedAt, stage, context, firstRejectedStage }) {
  let code = "UNKNOWN_FAILURE", statistics;
  try { const candidate = diagnosticValue(error, "code"); if (error instanceof CollectionError && FAILURE_CODES.has(candidate)) code = candidate; } catch (_) { /* unknown error */ }
  try { const read = diagnosticValue(context, "statistics"); if (typeof read === "function") statistics = read.call(context); } catch (_) { /* telemetry unavailable */ }
  let collection = null;
  if (statistics && typeof statistics === "object") {
    const rejected = diagnosticValue(statistics, "firstRejectedDispatch");
    const method = diagnosticValue(rejected, "method"), reason = diagnosticValue(rejected, "reason");
    const rejectedBudget = diagnosticBudget(diagnosticValue(rejected, "budget"));
    const first = ["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_getLogs"].includes(method)
      && ["REQUEST_THRESHOLD", "TIME_THRESHOLD", "BOTH"].includes(reason) && rejectedBudget ? { method, reason, budget: rejectedBudget } : null;
    collection = { counters: Object.fromEntries(FAILURE_COUNTERS.map(key => [key, diagnosticNumber(diagnosticValue(statistics, key))])),
      budget: diagnosticBudget(diagnosticValue(statistics, "budget")), firstRejectedDispatch: first,
      firstRejectedStage: first ? diagnosticPhase(firstRejectedStage || stage) : null };
  }
  const pin = diagnosticValue(context, "pin"), number = diagnosticNumber(diagnosticValue(pin, "number")), hash = diagnosticValue(pin, "hash");
  const contextChain = diagnosticValue(context, "chainId");
  const pinIdentity = contextChain === ETHEREUM_CHAIN_ID && number !== null && typeof hash === "string"
    && /^0x[0-9a-f]{64}$/i.test(hash) && !/^0x0{64}$/i.test(hash) ? { chainId: ETHEREUM_CHAIN_ID, blockNumber: number, blockHash: hash.toLowerCase() } : null;
  const out = { schema: "aave-v4-hubs-cli-failure/v1", chainId: ETHEREUM_CHAIN_ID, startedAt, failedAt: diagnosticTime(now),
    stage: diagnosticPhase(stage), code, pinIdentity, collection };
  const freeze = object => { if (object && typeof object === "object") { Object.values(object).forEach(freeze); Object.freeze(object); } return object; };
  return freeze(out);
}

async function collectTopology(dependencies = {}) {
  const chainId = Object.hasOwn(dependencies, "chainId") ? dependencies.chainId : ETHEREUM_CHAIN_ID;
  if (chainId !== ETHEREUM_CHAIN_ID && chainId !== BASE_CHAIN_ID) throw new Error("topology-chain-unsupported");
  if (Object.hasOwn(dependencies.collectionOptions || {}, "chainId") && dependencies.collectionOptions.chainId !== chainId) {
    throw new Error("topology-collection-chain-mismatch");
  }
  // Diagnostic-only, opt-in progress signal. Never pass collector state to the hook.
  let currentStage, context, firstRejectedStage = null;
  const failureHook = chainId === ETHEREUM_CHAIN_ID && typeof dependencies.onFailureDiagnostics === "function" ? dependencies.onFailureDiagnostics : null;
  const startedAt = failureHook ? diagnosticTime(dependencies.now || Date.now) : null;
  const diagnosticStage = (code) => {
    try {
      const read = diagnosticValue(context, "statistics");
      if (context && !firstRejectedStage && typeof read === "function" && diagnosticValue(read.call(context), "firstRejectedDispatch")) firstRejectedStage = currentStage;
    } catch (_) { /* diagnostic sampling cannot affect collection */ }
    currentStage = code;
    if (typeof dependencies.onDiagnosticStage === "function") {
      try { dependencies.onDiagnosticStage(code); } catch (_) { /* instrumentation cannot affect collection */ }
    }
  };
  try {
  diagnosticStage("REGISTRY");
  const registry = loadAaveV4Registry(dependencies);
  const hubSet = registry.hubs;
  if (!registry.bound) throw new Error("topology-registry-unbound");
  diagnosticStage("PIN_QUALIFICATION");
  context = await (dependencies.openCollection || openPinnedCollection)({
    ...(dependencies.collectionOptions || {}), chainId, now: dependencies.now || Date.now, probeAddress: hubSet[0].address,
  });
  if ((chainId === BASE_CHAIN_ID || context.chainId !== undefined) && context.chainId !== chainId) {
    throw new Error("topology-context-chain-mismatch");
  }
  if (chainId === BASE_CHAIN_ID && Number(registry.pinBlock) !== context.pin.number) {
    throw new Error("topology-registry-pin-mismatch");
  }
  const deferredMetadata = [];
  const scanOptions = { chainId, roleBindings: dependencies.roleBindings,
    ...(chainId === ETHEREUM_CHAIN_ID ? { deferredMetadata } : {}) };
  if (chainId === BASE_CHAIN_ID && dependencies.roleBindings) baseRoles.assertBindings(dependencies.roleBindings, {
    chainId, pin: context.pin, registry: dependencies.registryExtract,
  });
  const provider = context.provider;
  const blockNumber = context.pin.number;

  diagnosticStage("ASSET_ENUMERATION");
  const allAssets = [];
  for (const hub of hubSet) {
    const countResult = await callDecoded(provider, hub.address, HUB, "getAssetCount");
    if (countResult.value) {
      const count = Number(countResult.value[0]);
      for (let assetId = 0; assetId < Math.min(count, MAX_ASSETS_PER_HUB); assetId++) {
        const result = await callDecoded(provider, hub.address, HUB, "getAssetUnderlyingAndDecimals", [assetId]);
        if (result.value) allAssets.push(normalizeAddress(result.value[0]));
      }
    }
  }
  diagnosticStage("PRICE_LOOKUP");
  const priceByAddress = dependencies.fetchPrices
    ? await dependencies.fetchPrices(allAssets)
    : chainId === BASE_CHAIN_ID ? {} : await fetchCoinPrices(allAssets);
  const hubs = [];
  for (const [index, hub] of hubSet.entries()) {
    diagnosticStage(`HUB_${index + 1}`);
    hubs.push(await (dependencies.scanHub || scanHub)(provider, hub, priceByAddress, scanOptions));
  }
  let metadata;
  if (chainId === ETHEREUM_CHAIN_ID) {
    diagnosticStage("DEPENDENCY_METADATA");
    metadata = await collectDeferredMetadata(context, deferredMetadata);
  }
  const collectionStatistics = () => ({ ...context.statistics(), diagnosticStage: currentStage, firstRejectedStage, ...(metadata ? { metadata } : {}) });

  const summary = hubs.reduce((acc, hub) => {
    acc.hubsScanned += 1;
    acc.totalAssets += hub.assetCount || 0;
    acc.assetsScanned += hub.assets.length;
    acc.totalCashUsd += hub.totals.cashUsd;
    acc.totalOwedUsd += hub.totals.totalOwedUsd;
    acc.reviewCandidates += hub.totals.reviewCandidates;
    acc.watchCandidates += hub.totals.watchCandidates;
    acc.routePositive += hub.totals.routePositive;
    if (!hub.sourceVerified) acc.unverifiedHubs += 1;
    return acc;
  }, { hubsScanned: 0, totalAssets: 0, assetsScanned: 0, totalCashUsd: 0, totalOwedUsd: 0, reviewCandidates: 0, watchCandidates: 0, routePositive: 0, unverifiedHubs: 0 });
  summary.signedActionJustified = false;

  const flatAssets = hubs.flatMap((hub) => hub.assets.map((asset) => ({ hub, asset })));
  const topReviewRows = flatAssets
    .filter(({ asset }) => asset.reviewCandidate)
    .sort((a, b) => Math.max(b.asset.cashUsd || 0, b.asset.totalOwedUsd || 0) - Math.max(a.asset.cashUsd || 0, a.asset.totalOwedUsd || 0))
    .slice(0, 12)
    .map(({ hub, asset }) => compactAssetRow(hub, asset));
  const topSpokeRows = flatAssets
    .flatMap(({ hub, asset }) => (asset.spokeDirectory?.rows || []).map((row) => {
      const views = row.accounting?.views || {};
      return {
        hub: hub.name,
        hubAddress: hub.address,
        assetId: asset.assetId,
        symbol: asset.symbol,
        spokeIndex: row.index,
        spoke: row.address,
        listed: row.listed,
        config: row.config,
        reserve: row.reserve ? {
          reserveId: row.reserve.reserveId,
          reserveConfig: row.reserve.reserveConfig || null,
          dynamicConfig: row.reserve.dynamicConfig || null,
          oracleData: row.reserve.oracleData ? {
            address: row.reserve.oracleData.address,
            source: row.reserve.oracleData.source,
            price: row.reserve.oracleData.price,
            referencePriceUsd: row.reserve.oracleData.referencePriceUsd,
            priceVsReferenceBps: row.reserve.oracleData.priceVsReferenceBps,
          } : null,
        } : null,
        addedAssetsUsd: views.getSpokeAddedAssets?.amountUsd ?? null,
        owedUsd: views.getSpokeOwed?.amountUsd ?? null,
        totalOwedUsd: views.getSpokeTotalOwed?.amountUsd ?? null,
      };
    }))
    .sort((a, b) => Math.max(b.addedAssetsUsd || 0, b.owedUsd || 0) - Math.max(a.addedAssetsUsd || 0, a.owedUsd || 0))
    .slice(0, 20);
  const configWord1Counts = flatAssets.reduce((acc, { asset }) => {
    const key = asset.assetConfig?.decoded?.word1AsUint || "unavailable";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const accountingViewSuccessCounts = flatAssets.reduce((acc, { asset }) => {
    for (const [name, view] of Object.entries(asset.accountingViews || {})) {
      if (!acc[name]) acc[name] = { success: 0, error: 0 };
      if (view?.error) acc[name].error += 1;
      else acc[name].success += 1;
    }
    return acc;
  }, {});
  const spokeAccountingSuccessCounts = flatAssets.reduce((acc, { asset }) => {
    for (const candidate of asset.spokeAccounting || []) {
      for (const [name, view] of Object.entries(candidate.views || {})) {
        const key = `${candidate.role}.${name}`;
        if (!acc[key]) acc[key] = { success: 0, error: 0 };
        if (view?.error) acc[key].error += 1;
        else acc[key].success += 1;
      }
    }
    return acc;
  }, {});
  const spokeAccountingTotals = flatAssets.reduce((acc, { asset }) => {
    for (const candidate of asset.spokeAccounting || []) {
      const role = candidate.role || "unknown";
      if (!acc[role]) acc[role] = { addedAssetsUsd: 0, owedUsd: 0, totalOwedUsd: 0, owedCompared: 0, owedMatchesAssetTotal: 0, totalOwedCompared: 0, totalOwedMatchesAssetTotal: 0 };
      const views = candidate.views || {};
      const owedRaw = views.getSpokeOwed?.raw;
      const totalOwedRaw = views.getSpokeTotalOwed?.raw;
      const addedUsd = views.getSpokeAddedAssets?.amountUsd;
      const owedUsd = views.getSpokeOwed?.amountUsd;
      const totalOwedUsd = views.getSpokeTotalOwed?.amountUsd;
      if (Number.isFinite(addedUsd)) acc[role].addedAssetsUsd += addedUsd;
      if (Number.isFinite(owedUsd)) acc[role].owedUsd += owedUsd;
      if (Number.isFinite(totalOwedUsd)) acc[role].totalOwedUsd += totalOwedUsd;
      if (owedRaw !== null && owedRaw !== undefined && asset.totalOwedRaw !== null && asset.totalOwedRaw !== undefined) {
        acc[role].owedCompared += 1;
        if (String(owedRaw) === String(asset.totalOwedRaw)) acc[role].owedMatchesAssetTotal += 1;
      }
      if (totalOwedRaw !== null && totalOwedRaw !== undefined && asset.totalOwedRaw !== null && asset.totalOwedRaw !== undefined) {
        acc[role].totalOwedCompared += 1;
        if (String(totalOwedRaw) === String(asset.totalOwedRaw)) acc[role].totalOwedMatchesAssetTotal += 1;
      }
    }
    return acc;
  }, {});
  const spokeDirectoryTotals = flatAssets.reduce((acc, { asset }) => {
    const directory = asset.spokeDirectory || {};
    if (Number.isFinite(directory.count)) {
      acc.assetsWithSpokeDirectory += 1;
      acc.spokeCount += directory.count;
    }
    if (directory.truncated) acc.truncatedAssets += 1;
    for (const row of directory.rows || []) {
      if (row.listed === true) acc.listedRows += 1;
      if (row.reserve?.reserveConfig?.borrowable === true) acc.borrowableRows += 1;
      if ((row.reserve?.dynamicConfig?.collateralFactorBps || 0) > 0) acc.collateralRows += 1;
      const oracleBps = row.reserve?.oracleData?.priceVsReferenceBps;
      if (Number.isFinite(oracleBps) && Math.abs(oracleBps) > Math.abs(acc.maxOracleReferenceBps || 0)) {
        acc.maxOracleReferenceBps = oracleBps;
      }
      const views = row.accounting?.views || {};
      const addedUsd = views.getSpokeAddedAssets?.amountUsd;
      const owedUsd = views.getSpokeOwed?.amountUsd;
      const totalOwedUsd = views.getSpokeTotalOwed?.amountUsd;
      if (Number.isFinite(addedUsd)) acc.addedAssetsUsd += addedUsd;
      if (Number.isFinite(owedUsd)) acc.owedUsd += owedUsd;
      if (Number.isFinite(totalOwedUsd)) acc.totalOwedUsd += totalOwedUsd;
    }
    return acc;
  }, { assetsWithSpokeDirectory: 0, spokeCount: 0, listedRows: 0, borrowableRows: 0, collateralRows: 0, truncatedAssets: 0, addedAssetsUsd: 0, owedUsd: 0, totalOwedUsd: 0, maxOracleReferenceBps: 0 });
  summary.topCashUsd = topReviewRows.reduce((max, row) => Math.max(max, Number(row.cashUsd || 0)), 0);
  summary.topOwedUsd = topReviewRows.reduce((max, row) => Math.max(max, Number(row.totalOwedUsd || 0)), 0);
  summary.configWord1Counts = configWord1Counts;
  summary.accountingViewSuccessCounts = accountingViewSuccessCounts;
  summary.spokeAccountingSuccessCounts = spokeAccountingSuccessCounts;
  summary.configWordAccountingTotals = spokeAccountingTotals;
  summary.spokeDirectoryTotals = spokeDirectoryTotals;
  diagnosticStage("COVERAGE_VALIDATION");
  const sourceCoverage = buildTopologySourceCoverage(hubs, registry, scanOptions);

  const out = {
    generatedAt: new Date((dependencies.now || Date.now)()).toISOString(),
    scanner: "tools/scan-aave-v4-hubs.js",
    scope: chainId === BASE_CHAIN_ID ? "Aave V4 Base explicit registry hub mapping and read-only admission observation" : "Aave V4 public DefiLlama hub mapping and read-only route gate",
    sourceCoverage,
    declaredTopology: {
      bound: registry.bound === true,
      registry: registry.bound === true ? registry.registry : null,
      version: registry.bound === true ? registry.version : null,
      commit: registry.bound === true ? registry.commit : null,
      source: registry.bound === true ? registry.source : null,
      pinBlock: registry.bound === true ? registry.pinBlock : null,
      inventoryDigest: registry.bound === true ? registry.inventoryDigest : null,
      hubsDeclared: registry.hubsDeclared,
      failureReason: registry.bound === true ? null : (registry.failureReason || "registry-unavailable"),
    },
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    sources: chainId === BASE_CHAIN_ID ? [registry.source] : [
      "https://api.llama.fi/protocol/aave-v4",
      "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/aave-v4/index.js",
      "Sourcify/Codeslaw source checks returned no verified hub source",
    ],
    chain: { id: chainId, name: chainId === BASE_CHAIN_ID ? "Base" : "Ethereum", blockNumber, blockHash: context.pin.hash, stateRoot: context.pin.stateRoot, timestamp: Number(context.pin.timestamp), finality: "finalized" },
    collection: collectionStatistics(),
    gates: {
      routePositiveRequires: [
        "verified or otherwise decoded borrower/oracle/liquidation semantics",
        "specific live borrower or over-borrow path",
        "material route liquidity and fresh DEX quote",
        "gas-adjusted positive economics",
        "fork-positive extraction proof",
      ],
    },
    selectorRecovery: {
      source: RECOVERED_SELECTOR_SOURCE,
      recoveredSelectors: KNOWN_SIGNATURES
        .filter((sig) => !["supply(uint256,uint256,address)", "withdraw(uint256,uint256,address)", "borrow(uint256,uint256,address)", "repay(uint256,uint256,address)", "liquidate(address,uint256,uint256)", "getUserAccountData(address)", "getAssetPrice(uint256)", "getAssetLtv(uint256)", "getAssetLiquidationThreshold(uint256)", "getAssetLiquidationBonus(uint256)", "getAssetBorrowable(uint256)", "getAssetCollateralizable(uint256)", "paused()", "owner()"].includes(sig))
        .map((signature) => ({ selector: ethers.id(signature).slice(0, 10), signature })),
    },
    summary,
    hubs,
    topReviewRows,
    topSpokeRows,
    watchCandidates: [],
    positiveRoutes: [],
  };
  if (typeof dependencies.onProvisionalTopology === "function") {
    // A detached, sanitized snapshot cannot attest or mutate the collection.
    const { sanitizeTopology } = require("./admit-aave-v4-base");
    const snapshot = sanitizeTopology(JSON.parse(JSON.stringify(out, jsonReplacer)));
    snapshot.provisional = true;
    snapshot.incomplete = true;
    snapshot.sourceCoverage.complete = false;
    snapshot.sourceCoverage.sampleComplete = false;
    snapshot.sourceCoverage.classification = "SOURCE_INCOMPLETE";
    snapshot.sourceCoverage.observationPin = null;
    try { await dependencies.onProvisionalTopology(snapshot); } catch (_) { /* never replace the terminal failure */ }
  }
  diagnosticStage("PIN_CONFIRMATION");
  await context.confirmPin();
  sourceCoverage.observationPin = context.observationPin(sourceCoverage);
  diagnosticStage("COMPLETE");
  out.collection = collectionStatistics();
  return out;
  } catch (error) {
    if (failureHook) {
      try { await failureHook(failureSnapshot(error, { now: dependencies.now || Date.now, startedAt,
        stage: currentStage, context, firstRejectedStage })); } catch (_) { /* diagnostic failure never replaces the original error */ }
    }
    throw error;
  }
}

let cliStage = "START";
async function main(options = {}) {
  cliStage = "START";
  const io = options.fs || fs, argv = options.argv || process.argv, quiet = options.quiet ?? QUIET;
  const now = options.dependencies?.now || Date.now, startedAt = diagnosticTime(now);
  let receipt;
  try {
  const familyInjection = options.dependencies ? null : aaveFamilyCandidates.buildCandidates(process.env);
  const dependencies = options.dependencies || (familyInjection ? { resolver: familyInjection.resolver, collectionOptions: { candidates: familyInjection.candidates } } : {});
  // The native CLI remains Ethereum-only; Base admission calls the collector directly.
  if (dependencies.chainId !== undefined && dependencies.chainId !== ETHEREUM_CHAIN_ID) throw new Error("ethereum-cli-only");
  const out = await collectTopology({
    ...dependencies,
    onDiagnosticStage: code => { cliStage = code; if (typeof dependencies.onDiagnosticStage === "function") dependencies.onDiagnosticStage(code); },
    onFailureDiagnostics: snapshot => { receipt = snapshot; },
  });
  const outputIndex = argv.indexOf("--out");
  const output = outputIndex >= 0 ? path.resolve(argv[outputIndex + 1]) : OUT_FILE;
  io.mkdirSync(path.dirname(output), { recursive: true });
  io.writeFileSync(output, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
  if (!quiet) {
    console.log(`Aave V4 hubs: hubs=${out.summary.hubsScanned} assets=${out.summary.assetsScanned} review=${out.summary.reviewCandidates} watch=${out.summary.watchCandidates} routePositive=${out.summary.routePositive}`);
    console.log(`Report: ${path.relative(WORKSPACE, output)}`);
  }
  return out;
  } catch (error) {
    try {
      const diagnostic = receipt || failureSnapshot(error, { now, startedAt, stage: cliStage });
      const temporary = `${FAILURE_FILE}.tmp-${process.pid}`;
      try {
        io.mkdirSync(path.dirname(FAILURE_FILE), { recursive: true });
        io.writeFileSync(temporary, `${JSON.stringify(diagnostic, null, 2)}\n`);
        io.renameSync(temporary, FAILURE_FILE);
      } catch (_) { try { io.unlinkSync(temporary); } catch (_) { /* best effort diagnostic cleanup */ } }
    } catch (_) { /* diagnostic construction/writing cannot mask the CLI failure */ }
    throw error;
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error(`scan-aave-v4-hubs failed: scanner-failed stage=${cliStage}`);
    process.exitCode = 1;
  });
}

module.exports = {
  AAVE_V4_ETHEREUM_REGISTRY,
  main,
  collectTopology,
  buildTopologySourceCoverage,
  buildTopologyUniverse,
  loadAaveV4EthereumRegistry,
  loadAaveV4Registry,
  registryInventoryDigest,
  requiredSpokeRowError,
  requiredSpokeRowOk,
  readSpokeReserve,
  readOptionalAddressViews,
  readOptionalAssetViews,
  readOptionalSpokeViews,
  summarizeListedSpokeDependencies,
  resolveTopologyRpc,
  validateRegistryExtract,
};
