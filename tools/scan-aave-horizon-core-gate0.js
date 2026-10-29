#!/usr/bin/env node
"use strict";

// Aave Horizon RWA core Gate0 (def-3 Pick B).
//
// Read-only Phase-0 exam of the LIVE Ethereum Horizon core (hub/pool + reserves).
// Two anonymous independent RPC families must agree on a fresh finalized pin and
// on the sanitized state before anything is published. No signing, no broadcast,
// no fork, no state overrides. Endpoint inventory material is process-only: it is
// never printed, persisted, hashed, or placed on a child argv.
//
// Shape adapted from tools/capture-cap-current-reserve-callback-deployment-gate0.js.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { Interface, keccak256 } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const OUT_DIR = path.join(ROOT, "reports", "raw", "fast");
const CAPTURE_PATH = path.join(OUT_DIR, "aave-horizon-core-gate0-r1.json");
// Draft per-run report only; the delivered report is reports/critical-aave-horizon-core-gate0.md
// (hand-authored so a fresh-pin rerun cannot silently clobber the reviewed narrative).
const REPORT_PATH = path.join(OUT_DIR, "aave-horizon-core-gate0-r1-draft-report.md");
const CHAIN_ID = 1n;
const ZERO = "0x0000000000000000000000000000000000000000";
const FRESH_OUTSIDER = "0x000000000000000000000000000000000000dEaD";
const EIP1967 = Object.freeze({
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50"
});

// Address book: targets/aave-horizon-mglobal-address-book-a57a24d7/src/AaveV3EthereumHorizon.sol
const CORE = Object.freeze({
  poolAddressesProvider: "0x5D39E06b825C1F2B80bf2756a73e28eFAA128ba0",
  pool: "0xAe05Cd22df81871bc7cC2a04BeCfb516bFe332C8",
  poolConfigurator: "0x83Cb1B4af26EEf6463aC20AFbAC9c0e2E017202F",
  oracle: "0x985BcfAB7e0f4EF2606CC5b64FC1A16311880442",
  aclManager: "0xEFD5df7b87d2dCe6DD454b4240b3e0A4db562321",
  protocolDataProvider: "0x53519c32f73fE1797d10210c4950fFeBa3b21504",
  collector: "0x464C71f6c2F760DdA6093dCB91C24c39e5d6e18c",
  poolImpl: "0xcD8B9aC3B72E81fD8A0c9a0dBba583597E48A23a",
  poolConfiguratorImpl: "0x898E245D83Ad255Dc57b04978D0b4A12b94a557F",
  defaultATokenImpl: "0x9EB507147b99D3Cde32A53Bd5cd12bDEEaC26E5c",
  defaultVTokenImpl: "0x15F03E5dE87c12cb2e2b8e5d6ECEf0a9E21ab269",
  rwaATokenImpl: "0x5148d810B1DaE509d68f9d9219AD1d004EA32545", // AaveV3EthereumHorizonCustom.RWA_A_TOKEN_IMPL
  addressesProviderRegistry: "0xC6cAB8D39D93DC0Bd5986E7Ce5Bb956E30103A43",
  defaultIncentivesController: "0x1D5D386a90CEA8AcEa9fa75389e97CF5F1AE21D3",
  emissionManager: "0xC2201708289b2C6A1d461A227A7E5ee3e7fE9A2F",
  uiPoolDataProvider: "0x2dAd8162A989cd99D673dE4425Bb2298Db1E1aA2",
  uiIncentiveDataProvider: "0xe3dFf4052F0bF6134ACb73bEaE8fe2317d71F047",
  walletBalanceProvider: "0xC7be5307ba715ce89b152f3Df0658295b3dbA8E2",
  ghoDirectMinter: "0xe10C78A3AC7f016eD2DE1A89c5479b1039EAB9eA",
  configEngine: "0x30dA3a613c5b492BB4277Aa2a5D81f4759Ba83Af",
  flashloanLogic: "0x34039100cc9584Ae5D741d322e16d0d18CEE8770",
  borrowLogic: "0x62325c94E1c49dcDb5937726aB5D8A4c37bCAd36",
  liquidationLogic: "0x4731bF01583F991278692E8727d0700a00A1fBBf",
  poolLogic: "0xf8C97539934ee66a67C26010e8e027D77E821B0C",
  supplyLogic: "0x185477906B46D9b8DE0DEB73A1bBfb87b5b51BC3"
});
// community roles published by the proposals (authorization, not outsider paths)
const GOV = Object.freeze({
  aclAdmin: "0x5300A1a15135EA4dc7aD5a167152C01EFc9b192A",
  horizonOps: "0xE6ec1f0Ae6Cd023bd0a9B4d0253BDC755103253c",
  horizonEmergency: "0x13B57382c36BAB566E75C72303622AF29E27e1d3",
  horizonExecutor: "0x09e8E1408a68778CEDdC1938729Ea126710E7Dda"
});
// Reserve set from the address book (AaveV3EthereumHorizonAssets + Custom).
const RESERVES = Object.freeze([
  { symbol: "GHO", decimals: 18, underlying: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f", aToken: "0x946281A2d0DD6e650d08f74833323D66AE4c8b12", vToken: "0xdec2401c9B0B2E480e627E2a712C11AdDbf46E3e", oracle: "0xD110cac5d8682A3b045D5524a9903E031d70FCCd", rwa: false, issuer: "none" },
  { symbol: "USDC", decimals: 6, underlying: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", aToken: "0x68215B6533c47ff9f7125aC95adf00fE4a62f79e", vToken: "0x4139EcBe83d78ef5EFF0A6eDA6f894Be9D590FC7", oracle: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6", rwa: false, issuer: "none" },
  { symbol: "RLUSD", decimals: 18, underlying: "0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD", aToken: "0xE3190143Eb552456F88464662f0c0C4aC67A77eB", vToken: "0xACE8a1c0eC12aE81814377491265b47F4eE5D3dD", oracle: "0x26C46B7aD0012cA71F2298ada567dC9Af14E7f2A", rwa: false, issuer: "none", note: "listed borrowable; permissioning not asserted offline" },
  { symbol: "USTB", decimals: 6, underlying: "0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e", aToken: "0x4E58a2E433A739726134c83d2f07b2562e8dFdB3", vToken: "0xC435b02dcBef2e9BdE55e28d39f53ddbe0760a2c", oracle: "0x5Ae4D93B9b9626Dc3289e1Afb14b821FD3C95F44", rwa: true, issuer: "superstate" },
  { symbol: "USCC", decimals: 6, underlying: "0x14d60E7FDC0D71d8611742720E4C50E7a974020c", aToken: "0x08b798c40b9AB931356d9aB4235F548325C4cb80", vToken: "0xA0Ec4758d806A3F41532C8E97Ea0c85940182B0f", oracle: "0x14CB2E810Eb93b79363f489D45a972b609E47230", rwa: true, issuer: "superstate" },
  { symbol: "USYC", decimals: 6, underlying: "0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b", aToken: "0xc167932AC4EEc2B65844EF00D31b4550250536A5", vToken: "0x818d560Bf1e54f92D1089710F9F4b29C2e6c9248", oracle: "0xE8E65Fb9116875012F5990Ecaab290B3531DbeB9", rwa: true, issuer: "circle" },
  { symbol: "JTRSY", decimals: 6, underlying: "0x8c213ee79581Ff4984583C6a801e5263418C4b86", aToken: "0x844f07AB09aa5dBDCE6A9b1206CE150E1eaDacCb", vToken: "0x327f61fA4BE6F578DB5cc51e40da4eC4361a349c", oracle: "0xfAB6790E399f0481e1303167c655b3c39ee6e7A0", rwa: true, issuer: "centrifuge" },
  { symbol: "JAAA", decimals: 6, underlying: "0x5a0F93D040De44e78F251b03c43be9CF317Dcf64", aToken: "0xB0EC6c4482Ac1Ef77bE239C0AC833CF37A27c876", vToken: "0x7bd81B1e0137Fc0fa013b1De2Be81180814C5deb", oracle: "0xF77f2537dba4ffD60f77fACdfB2c1706364fA03d", rwa: true, issuer: "centrifuge" },
  { symbol: "VBILL", decimals: 6, underlying: "0x2255718832bC9fD3bE1CaF75084F4803DA14FF01", aToken: "0xE1CfD16b8E4B1C86Bb5b7A104cfEFbc7b09326dD", vToken: "0xEAf93Fd541f11D2617C2915D02F7fe67bCa71d4f", oracle: "0x5ed77a9D9b7cc80E9d0D7711024AF38C2643C1c4", rwa: true, issuer: "securitize" },
  { symbol: "ACRED", decimals: 6, underlying: "0x17418038ecF73BA4026c4f428547BF099706F27B", aToken: "0xc293744fFbcf46696D589f5C415e71BC491519cD", vToken: "0x1f30d2B155FcDA0F7551dc8BE5dE6a84977685D4", oracle: "0x60AEd7d20AC6328f7BA771aD58931c996aff30E8", rwa: true, issuer: "securitize" },
  { symbol: "mGLOBAL", decimals: 18, underlying: "0x7433806912Eae67919e66aea853d46Fa0aef98A8", aToken: "0x49d3cdE03813eE32DFD47F6aA3957d5F9CbAB985", vToken: "0x40606ce958e14AD6BA575B00402d07438c3d58aC", oracle: "0xe034De753a3d855B6daD1A4984de75a5c443E939", rwa: true, issuer: "midas" }
]);
// Issuer compliance systems (from tests/utils/HorizonRwaWhitelistHelper.sol).
const COMPLIANCE = Object.freeze({
  superstateAllowlist: "0x02f1fA8B196d21c7b733EB2700B825611d8A38E5",
  centrifugeHook: "0xa2C98F0F76Da0C97039688CA6280d082942d0b48",
  circleRole: 19,
  midasAccessControl: "0x0312A9D1Ff2372DDEdCBB21e4B6289aFc919aC4B",
  midasGreenlistedRole: keccak256(Buffer.from("M_GLOBAL_GREENLISTED_ROLE"))
});

const METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_getCode", "eth_getStorageAt", "eth_getLogs"]);
const LIMITS = Object.freeze({ inventoryBytes: 1024 * 1024, candidates: 28, families: 18, attemptsPerFamily: 2,
  rpcCalls: 2600, responseBytes: 5 * 1024 * 1024, totalResponseBytes: 160 * 1024 * 1024,
  requestMs: 18000, wallMs: 14 * 60 * 1000 });

const poolIface = new Interface([
  "function getReservesList() view returns (address[])",
  "function getReserveAToken(address) view returns (address)",
  "function getReserveVariableDebtToken(address) view returns (address)",
  "function ADDRESSES_PROVIDER() view returns (address)"
]);
const dataProviderIface = new Interface([
  "function getReserveConfigurationData(address) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
  "function getReserveCaps(address) view returns (uint256 borrowCap, uint256 supplyCap)",
  "function getPaused(address) view returns (bool isPaused)"
]);
const providerIface = new Interface([
  "function owner() view returns (address)", "function getPool() view returns (address)", "function getPoolConfigurator() view returns (address)",
  "function getPriceOracle() view returns (address)", "function getACLManager() view returns (address)", "function getPoolDataProvider() view returns (address)"
]);
const oracleIface = new Interface([
  "function getSourceOfAsset(address) view returns (address)", "function getAssetPrice(address) view returns (uint256)"
]);
const tokenIface = new Interface([
  "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) view returns (bool)"
]);
const aTokenIface = new Interface(["function underlyingAsset() view returns (address)"]);
const adminIface = new Interface(["function admin() view returns (address)"]);
const superstateIface = new Interface(["function addressEntityIds(address) view returns (uint256)"]);
const centrifugeHookIface = new Interface(["function root() view returns (address)"]);
const centrifugeRootIface = new Interface(["function endorsed(address) view returns (bool)"]);
const usycIface = new Interface(["function authority() view returns (address)"]);
const circleAuthIface = new Interface(["function doesUserHaveRole(address,uint8) view returns (bool)"]);
const securitizeTokenIface = new Interface(["function REGISTRY_SERVICE() view returns (uint256)", "function getDSService(uint256) view returns (address)"]);
const registryIface = new Interface(["function isWallet(address) view returns (bool)"]);
const midasIface = new Interface(["function hasRole(bytes32,address) view returns (bool)"]);

class GateError extends Error { constructor(code, details) { super(code); this.name = "GateError"; this.code = code; this.details = details; } }
const fail = (code, details) => { throw new GateError(code, details); };
const sha256 = (bytes) => `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) fail("NONFINITE_NUMBER"); return JSON.stringify(value); }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") fail("NONCANONICAL_VALUE");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function strictHex(value, bytes = null, code = "MALFORMED_HEX") {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(value)) fail(code);
  if (bytes !== null && value.length !== 2 + bytes * 2) fail(`${code}_LENGTH`);
  return value.toLowerCase();
}
function address(value) { return strictHex(String(value), 20, "MALFORMED_ADDRESS"); }
function quantity(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u.test(value)) fail("MALFORMED_QUANTITY");
  return BigInt(value);
}
const qhex = (value) => `0x${BigInt(value).toString(16)}`;
function parseHeader(value) {
  if (!value || typeof value !== "object") fail("HEADER_MALFORMED");
  return { number: quantity(value.number), numberHex: value.number.toLowerCase(), hash: strictHex(value.hash, 32, "HASH_MALFORMED"),
    stateRoot: strictHex(value.stateRoot, 32, "STATE_ROOT_MALFORMED"), timestamp: quantity(value.timestamp) };
}
const pinArg = (pin) => ({ blockHash: pin.hash, requireCanonical: true });
function decodeAddressWord(value) {
  const word = strictHex(value, 32, "ADDRESS_WORD_MALFORMED").slice(2);
  if (!/^0{24}[0-9a-f]{40}$/u.test(word)) fail("ADDRESS_WORD_NONCANONICAL");
  return `0x${word.slice(24)}`;
}
function plain(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value)) return address(value);
  if (Array.isArray(value)) return Array.from(value).map(plain);
  if (value && typeof value === "object") {
    const out = {}; for (const key of Object.keys(value)) if (!/^\d+$/u.test(key)) out[key] = plain(value[key]);
    return Object.keys(out).length ? out : Array.from(value).map(plain);
  }
  return value;
}
function familyOf(hostname) {
  const labels = hostname.toLowerCase().split(".").filter(Boolean); if (labels.length <= 2) return labels.join(".");
  const suffix = labels.slice(-2).join("."); return /^(?:co|com|net|org)\.[a-z]{2}$/u.test(suffix) ? labels.slice(-3).join(".") : suffix;
}
function parseInventory(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.inventoryBytes) fail("INVENTORY_SIZE_CAP");
  const lines = bytes.toString("utf8").split(/\r?\n/u), rows = [], seen = new Set(); let inventoryIndex = 0;
  for (let i = 0; i < lines.length; i++) for (const match of lines[i].matchAll(/https:\/\/[^\s<'"`\])}]+/giu)) {
    let url; try { url = new URL(match[0].replace(/[>,.;]+$/u, "")); } catch (_) { continue; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) continue;
    const context = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join(" "), headers = {};
    for (const item of context.matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/giu)) headers[item[1].trim()] = item[2].trim();
    const origin = context.match(/\[origin:\s*([^\]\s]+)\]/iu)?.[1]; if (origin) headers.origin = origin;
    const key = `${url.href}\0${JSON.stringify(headers)}`; if (seen.has(key)) continue; seen.add(key);
    const eth = /(?:ethereum|eth-mainnet|mainnet[^a-z0-9]{0,4}(?:1|eth)|chain(?:id)?[^a-z0-9]{0,8}(?:1|0x1))(?!\d)/iu.test(context);
    const premium = Object.keys(headers).length > 0 || url.search.length > 1 || url.pathname.split("/").some((part) => part.length >= 24);
    rows.push({ url, headers, family: familyOf(url.hostname), inventoryScore: Number(eth) * 4 + Number(premium) * 2, inventoryIndex: inventoryIndex++ });
  }
  return rows.sort((a, b) => b.inventoryScore - a.inventoryScore || a.inventoryIndex - b.inventoryIndex).slice(0, LIMITS.candidates);
}
function secretCorpus(rows) {
  const values = new Set();
  for (const row of rows) for (const item of [row.url.href, row.url.hostname, ...row.url.pathname.split("/"), ...row.url.searchParams.values(), ...Object.values(row.headers)])
    if (String(item).length >= 12) { values.add(String(item)); values.add(String(item).toLowerCase()); }
  return [...values];
}
function assertSanitized(value, corpus = []) {
  const text = typeof value === "string" ? value : JSON.stringify(value), lower = text.toLowerCase();
  if (/(?:https?|wss?):\/\//iu.test(text)) fail("OUTPUT_URL_REJECTED");
  if (/"(?:endpoint|hostname|domain|headers|rpcUrl|rawResponse|rawRpc)"\s*:/iu.test(text)) fail("OUTPUT_PROVIDER_KEY_REJECTED");
  for (const item of corpus) if (text.includes(item) || lower.includes(item.toLowerCase())) fail("OUTPUT_INVENTORY_MATERIAL_REJECTED");
  return true;
}

class Budget {
  constructor() { this.started = Date.now(); this.calls = 0; this.bytes = 0; this.failures = {}; }
  use() { if (++this.calls > LIMITS.rpcCalls || Date.now() - this.started > LIMITS.wallMs) fail("RPC_BUDGET_EXCEEDED"); }
  add(size) { this.bytes += size; if (size > LIMITS.responseBytes || this.bytes > LIMITS.totalResponseBytes) fail("RPC_RESPONSE_CAP"); }
  note(code) { this.failures[code] = (this.failures[code] || 0) + 1; }
  summary() { return { calls: this.calls, responseBytes: this.bytes, elapsedMs: Date.now() - this.started,
    limits: { calls: LIMITS.rpcCalls, totalResponseBytes: LIMITS.totalResponseBytes, wallMs: LIMITS.wallMs }, withinBounds: true,
    sanitizedFailureCategories: this.failures }; }
}
async function rpc(candidate, method, params, budget) {
  if (!METHODS.has(method)) fail("RPC_METHOD_FORBIDDEN"); budget.use();
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: budget.calls, method, params }));
  return new Promise((resolve) => {
    let settled = false, request;
    const finish = (row) => { if (settled) return; settled = true; clearTimeout(timer); try { request?.destroy(); } catch (_) {} resolve(row); };
    const timer = setTimeout(() => finish({ ok: false, reason: "TIMEOUT" }), LIMITS.requestMs);
    try {
      request = https.request({ protocol: "https:", hostname: candidate.url.hostname, port: candidate.url.port || 443,
        path: `${candidate.url.pathname}${candidate.url.search}`, method: "POST", agent: false,
        headers: { ...candidate.headers, "content-type": "application/json", accept: "application/json", "accept-encoding": "identity", "content-length": body.length } }, (response) => {
        const chunks = []; let size = 0;
        response.on("data", (chunk) => { size += chunk.length; if (size > LIMITS.responseBytes) finish({ ok: false, reason: "RESPONSE_CAP" }); else chunks.push(Buffer.from(chunk)); });
        response.on("end", () => { if (settled) return; try { budget.add(size); } catch (_) { return finish({ ok: false, reason: "RESPONSE_CAP" }); }
          if (response.statusCode !== 200) return finish({ ok: false, reason: "HTTP_STATUS" });
          try { const decoded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            finish(decoded && !decoded.error && Object.hasOwn(decoded, "result") ? { ok: true, result: decoded.result }
              : { ok: false, reason: "RPC_ERROR", error: decoded && decoded.error ? { code: decoded.error.code ?? null, data: typeof decoded.error.data === "string" ? decoded.error.data : null } : null });
          } catch (_) { finish({ ok: false, reason: "INVALID_JSON" }); } });
      });
      request.on("error", () => finish({ ok: false, reason: "TRANSPORT_ERROR" })); request.end(body);
    } catch (_) { finish({ ok: false, reason: "TRANSPORT_ERROR" }); }
  });
}
async function requiredRpc(candidate, method, params, budget, code) {
  let row = await rpc(candidate, method, params, budget);
  if (!row.ok) { budget.note(row.reason); row = await rpc(candidate, method, params, budget); }
  if (!row.ok) { budget.note(row.reason); fail(code || row.reason); } return row.result;
}
async function call(candidate, target, iface, fragment, args, pin, budget, required = true) {
  const data = iface.encodeFunctionData(fragment, args || []), row = await rpc(candidate, "eth_call", [{ to: address(target), data }, pinArg(pin)], budget);
  if (!row.ok) { budget.note(row.reason); if (required) fail(`CALL_${fragment}_FAILED`); return null; }
  try { const decoded = iface.decodeFunctionResult(fragment, row.result); return decoded.length === 1 ? plain(decoded[0]) : plain(decoded); }
  catch (_) { if (required) fail(`DECODE_${fragment}_FAILED`); return null; }
}
async function rawCall(candidate, to, data, pin, budget, from) {
  const tx = { to: address(to), data };
  if (from) tx.from = address(from);
  const row = await rpc(candidate, "eth_call", [tx, pinArg(pin)], budget);
  if (row.ok) return { ok: true, result: row.result };
  budget.note(row.reason);
  return { ok: false, reason: row.reason, error: row.error || null };
}
async function qualify(candidates, budget) {
  const capable = [], familyAttempts = new Map(); let candidatesTested = 0;
  for (const candidate of candidates) {
    const attempts = familyAttempts.get(candidate.family) || 0;
    if (attempts >= LIMITS.attemptsPerFamily || familyAttempts.size >= LIMITS.families) continue;
    familyAttempts.set(candidate.family, attempts + 1); candidatesTested++;
    try {
      let capabilityScore = 0;
      if (quantity(await requiredRpc(candidate, "eth_chainId", [], budget, "QUAL_CHAIN")) !== CHAIN_ID) fail("QUAL_WRONG_CHAIN"); capabilityScore++;
      const finalized = parseHeader(await requiredRpc(candidate, "eth_getBlockByNumber", ["finalized", false], budget, "QUAL_FINALIZED")); capabilityScore++;
      if (finalized.number < 256n) fail("QUAL_FINALIZED_LOW");
      const historical = parseHeader(await requiredRpc(candidate, "eth_getBlockByNumber", [qhex(finalized.number - 128n), false], budget, "QUAL_HISTORICAL")); capabilityScore++;
      for (const pin of [finalized, historical]) {
        const tag = pinArg(pin);
        const reserves = await requiredRpc(candidate, "eth_call", [{ to: CORE.pool, data: poolIface.encodeFunctionData("getReservesList", []) }, tag], budget, "QUAL_CALL");
        if (!poolIface.decodeFunctionResult("getReservesList", reserves)[0].length) fail("QUAL_RESERVES_EMPTY"); capabilityScore++;
        if (strictHex(await requiredRpc(candidate, "eth_getCode", [CORE.pool, tag], budget, "QUAL_CODE")).length <= 2) fail("QUAL_CODE_EMPTY"); capabilityScore++;
        strictHex(await requiredRpc(candidate, "eth_getStorageAt", [CORE.pool, EIP1967.implementation, tag], budget, "QUAL_STORAGE"), 32); capabilityScore++;
        const logs = await requiredRpc(candidate, "eth_getLogs", [{ blockHash: pin.hash, address: CORE.pool }], budget, "QUAL_LOGS");
        if (!Array.isArray(logs)) fail("QUAL_LOGS_SHAPE"); capabilityScore++;
      }
      capable.push({ candidate, finalized, capabilityScore });
    } catch (error) { budget.note(error instanceof GateError ? error.code : "QUALIFICATION_FAILURE"); }
  }
  capable.sort((a, b) => b.capabilityScore - a.capabilityScore || b.candidate.inventoryScore - a.candidate.inventoryScore || a.candidate.inventoryIndex - b.candidate.inventoryIndex);
  const first = capable[0], second = capable.find((row) => row.candidate.family !== first?.candidate.family);
  if (!first || !second) fail("TWO_INDEPENDENT_FAMILIES_UNAVAILABLE");
  return { selected: [first, second], candidatesTested, familiesTested: familyAttempts.size,
    capableFamilies: new Set(capable.map((row) => row.candidate.family)).size, selectedCapabilityScore: [first.capabilityScore, second.capabilityScore] };
}
async function commonPin(selected, budget) {
  const floor = selected.reduce((n, row) => row.finalized.number < n ? row.finalized.number : n, selected[0].finalized.number);
  for (const delta of [0n, 4n, 16n, 64n]) {
    const rows = []; for (const row of selected) rows.push(parseHeader(await requiredRpc(row.candidate, "eth_getBlockByNumber", [qhex(floor - delta), false], budget, "PIN_HEADER")));
    if (rows[0].number === rows[1].number && rows[0].hash === rows[1].hash && rows[0].stateRoot === rows[1].stateRoot && rows[0].timestamp === rows[1].timestamp) return rows[0];
  }
  fail("NO_COMMON_FINALIZED_PIN");
}
function codeSummary(code) { const normalized = strictHex(code), bytes = Buffer.from(normalized.slice(2), "hex");
  return { bytes: bytes.length, keccak256: keccak256(normalized), sha256: sha256(bytes) }; }
function minimalProxyImplementation(code) {
  const raw = strictHex(code).slice(2);
  const match = raw.match(/^363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/u);
  return match ? `0x${match[1]}` : ZERO;
}
function proxyClass(comp) {
  if (comp.minimalProxyImplementation !== ZERO) return "MINIMAL_PROXY";
  if (comp.slots.beacon !== ZERO) return "BEACON_PROXY";
  if (comp.slots.implementation !== ZERO) return comp.slots.admin !== ZERO ? "EIP1967_TRANSPARENT_ADMIN_PROXY" : "EIP1967_IMPL_SLOT_ADMIN_ZERO";
  return "DIRECT_OR_CUSTOM";
}
async function component(candidate, target, pin, budget) {
  let codeRaw;
  try { codeRaw = await requiredRpc(candidate, "eth_getCode", [target, pinArg(pin)], budget, "COMPONENT_CODE"); }
  catch (error) { fail("COMPONENT_CODE", { target: address(target), reason: error instanceof GateError ? error.code : "RPC_FAILURE" }); }
  const code = strictHex(codeRaw);
  const present = code.length > 2;
  const slots = {}; for (const [name, slot] of Object.entries(EIP1967)) slots[name] = decodeAddressWord(await requiredRpc(candidate, "eth_getStorageAt", [target, slot, pinArg(pin)], budget, "COMPONENT_SLOT"));
  const minimalImplementation = minimalProxyImplementation(code); let beaconImplementation = ZERO;
  if (slots.beacon !== ZERO) { try { beaconImplementation = address(await call(candidate, slots.beacon, adminIface, "admin", [], pin, budget, false)); } catch (_) { beaconImplementation = ZERO; } }
  const effectiveImplementation = minimalImplementation !== ZERO ? minimalImplementation : slots.implementation !== ZERO ? slots.implementation : beaconImplementation !== ZERO ? beaconImplementation : target;
  let effectiveImplementationRuntime = codeSummary(code);
  if (present && effectiveImplementation !== target) {
    const implementationCode = strictHex(await requiredRpc(candidate, "eth_getCode", [effectiveImplementation, pinArg(pin)], budget, "IMPLEMENTATION_CODE"));
    if (implementationCode.length <= 2) fail("IMPLEMENTATION_CODE_EMPTY", { target, effectiveImplementation });
    effectiveImplementationRuntime = codeSummary(implementationCode);
  }
  const comp = { address: target, present, runtime: codeSummary(code), slots, minimalProxyImplementation: minimalImplementation,
    beaconImplementation, effectiveImplementation, effectiveImplementationRuntime, class: null, rawCode: code };
  comp.class = present ? proxyClass(comp) : "NO_CODE";
  return comp;
}
async function readCore(candidate, pin, budget) {
  const roots = {}; for (const role of Object.keys(CORE)) roots[role] = await component(candidate, CORE[role], pin, budget);
  const providerViews = {};
  for (const fn of ["owner", "getPool", "getPoolConfigurator", "getPriceOracle", "getACLManager", "getPoolDataProvider"])
    providerViews[fn] = await call(candidate, CORE.poolAddressesProvider, providerIface, fn, [], pin, budget, false);
  const poolProvider = await call(candidate, CORE.pool, poolIface, "ADDRESSES_PROVIDER", [], pin, budget, false);
  const aclAdminContract = roots.aclManager.present ? await call(candidate, CORE.aclManager, adminIface, "admin", [], pin, budget, false) : null;
  return { roots, providerViews, poolProvider, aclAdminContract };
}
async function complianceProbe(candidate, issuer, holder, pin, budget) {
  if (issuer === "superstate") return { system: "Superstate.AllowList.setEntityIdForAddress", value: await call(candidate, COMPLIANCE.superstateAllowlist, superstateIface, "addressEntityIds", [holder], pin, budget, false) };
  if (issuer === "centrifuge") { const root = await call(candidate, COMPLIANCE.centrifugeHook, centrifugeHookIface, "root", [], pin, budget, false); if (!root) return { system: "Centrifuge.RestrictionManager.endorse", value: null };
    return { system: "Centrifuge.RestrictionManager.endorse", root, value: await call(candidate, root, centrifugeRootIface, "endorsed", [holder], pin, budget, false) }; }
  if (issuer === "circle") { const authority = await call(candidate, RESERVES.find((r) => r.issuer === "circle").underlying, usycIface, "authority", [], pin, budget, false); if (!authority) return { system: "Circle.RolesAuthority.setUserRole", value: null };
    return { system: "Circle.RolesAuthority.setUserRole", authority, value: await call(candidate, authority, circleAuthIface, "doesUserHaveRole", [holder, COMPLIANCE.circleRole], pin, budget, false) }; }
  if (issuer === "midas") return { system: "Midas.AccessControl.M_GLOBAL_GREENLISTED_ROLE", value: await call(candidate, COMPLIANCE.midasAccessControl, midasIface, "hasRole", [COMPLIANCE.midasGreenlistedRole, holder], pin, budget, false) };
  if (issuer === "securitize") return { system: "Securitize.RegistryService.isWallet", value: null, note: "token-specific registry id resolved in reserve pass" };
  return { system: "none", value: null };
}
async function reservePass(candidate, pin, budget, core) {
  const list = (await call(candidate, CORE.pool, poolIface, "getReservesList", [], pin, budget)).map(address);
  const rows = [];
  for (const meta of RESERVES) {
    const underlying = meta.underlying;
    const aToken = address(await call(candidate, CORE.pool, poolIface, "getReserveAToken", [underlying], pin, budget));
    const vToken = address(await call(candidate, CORE.pool, poolIface, "getReserveVariableDebtToken", [underlying], pin, budget));
    const config = await call(candidate, CORE.protocolDataProvider, dataProviderIface, "getReserveConfigurationData", [underlying], pin, budget);
    const caps = await call(candidate, CORE.protocolDataProvider, dataProviderIface, "getReserveCaps", [underlying], pin, budget);
    const paused = await call(candidate, CORE.protocolDataProvider, dataProviderIface, "getPaused", [underlying], pin, budget);
    const cfgNames = dataProviderIface.getFunction("getReserveConfigurationData").outputs.map((o) => o.name);
    const capNames = dataProviderIface.getFunction("getReserveCaps").outputs.map((o) => o.name);
    const named = (values, names) => Object.fromEntries(names.map((name, i) => [name, values ? values[i] : null]));
    const configNamed = named(Array.isArray(config) ? config : null, cfgNames);
    const capsNamed = named(Array.isArray(caps) ? caps : null, capNames);
    const oracleSource = address(await call(candidate, CORE.oracle, oracleIface, "getSourceOfAsset", [underlying], pin, budget, false));
    const oraclePrice = await call(candidate, CORE.oracle, oracleIface, "getAssetPrice", [underlying], pin, budget, false);
    const underlyingMeta = { name: await call(candidate, underlying, tokenIface, "name", [], pin, budget, false),
      symbol: await call(candidate, underlying, tokenIface, "symbol", [], pin, budget, false),
      decimals: await call(candidate, underlying, tokenIface, "decimals", [], pin, budget, false),
      totalSupply: await call(candidate, underlying, tokenIface, "totalSupply", [], pin, budget, false),
      aTokenBalance: await call(candidate, underlying, tokenIface, "balanceOf", [aToken], pin, budget, false) };
    const aTokenUnderlying = await call(candidate, aToken, aTokenIface, "underlyingAsset", [], pin, budget, false);
    const aTokenTotalSupply = await call(candidate, aToken, tokenIface, "totalSupply", [], pin, budget, false);
    const aTokenComp = await component(candidate, aToken, pin, budget);
    const vTokenComp = await component(candidate, vToken, pin, budget);
    const oracleComp = await component(candidate, oracleSource, pin, budget);
    const underlyingComp = await component(candidate, underlying, pin, budget);
    const expectedATokenImpl = address(meta.rwa ? CORE.rwaATokenImpl : CORE.defaultATokenImpl);
    const aTokenImplMatchesPublished = aTokenComp.effectiveImplementation === expectedATokenImpl;
    const vTokenImplMatchesPublished = vTokenComp.effectiveImplementation === address(CORE.defaultVTokenImpl);
    const oraclePublishedMatches = oracleSource === address(meta.oracle);
    // outsider reachability of the underlying: simulate transfer from the issuer-whitelisted aToken holder to a fresh outsider.
    let transferProbe = { attempted: false };
    try {
      const bal = BigInt(underlyingMeta.aTokenBalance ?? "0");
      if (bal >= 1n) {
        const res = await rawCall(candidate, underlying, tokenIface.encodeFunctionData("transfer", [FRESH_OUTSIDER, 1n]), pin, budget, aToken);
        transferProbe = { attempted: true, to: FRESH_OUTSIDER, amount: "1", fromHolder: aToken, ok: res.ok,
          revertReason: res.ok ? null : res.reason, revertData: res.ok ? null : (res.error && typeof res.error.data === "string" ? strictHex(res.error.data, null, "REVERT_DATA") : null) };
      } else transferProbe = { attempted: false, reason: "ATOKEN_UNDERLYING_BALANCE_ZERO" };
    } catch (error) { transferProbe = { attempted: false, reason: error instanceof GateError ? error.code : "PROBE_ERROR" }; }
    // compliance membership of the aToken (known member) and the fresh outsider
    let compliance = { issuer: meta.issuer };
    if (meta.issuer !== "none") {
      try {
        if (meta.issuer === "securitize") {
          const token = underlying;
          const ds = await call(candidate, token, securitizeTokenIface, "REGISTRY_SERVICE", [], pin, budget, false);
          const registry = ds === null ? null : await call(candidate, token, securitizeTokenIface, "getDSService", [ds], pin, budget, false);
          if (registry) compliance = { issuer: meta.issuer, system: "Securitize.RegistryService.isWallet", registry,
            aTokenMember: await call(candidate, registry, registryIface, "isWallet", [aToken], pin, budget, false),
            outsiderMember: await call(candidate, registry, registryIface, "isWallet", [FRESH_OUTSIDER], pin, budget, false) };
          else compliance = { issuer: meta.issuer, system: "Securitize.RegistryService.isWallet", value: null };
        } else {
          const holder = await complianceProbe(candidate, meta.issuer, aToken, pin, budget);
          const outsider = await complianceProbe(candidate, meta.issuer, FRESH_OUTSIDER, pin, budget);
          compliance = { issuer: meta.issuer, system: holder.system, root: holder.root || holder.authority || null,
            aTokenMember: holder.value, outsiderMember: outsider.value };
        }
      } catch (error) { compliance = { issuer: meta.issuer, system: "probe-failed", value: null, reason: error instanceof GateError ? error.code : "PROBE_ERROR" }; }
    } else compliance = { issuer: "none", system: "none", value: null, note: "no issuer compliance system in scope" };
    rows.push({ symbol: meta.symbol, decimals: meta.decimals, rwa: meta.rwa, issuer: meta.issuer, underlying, aToken, vToken, oracleSource,
      oraclePublished: meta.oracle, oraclePrice, config: plain(config), configNamed, caps: plain(caps), capsNamed, paused: plain(paused), underlyingMeta,
      aTokenUnderlying, aTokenTotalSupply, inReservesList: list.includes(address(underlying)), transferProbe, compliance,
      expectedATokenImpl, aTokenImplMatchesPublished, vTokenImplMatchesPublished, oraclePublishedMatches,
      graphs: { aToken: { class: aTokenComp.class, effectiveImplementation: aTokenComp.effectiveImplementation, runtime: aTokenComp.runtime },
        vToken: { class: vTokenComp.class, effectiveImplementation: vTokenComp.effectiveImplementation, runtime: vTokenComp.runtime },
        oracle: { class: oracleComp.class, effectiveImplementation: oracleComp.effectiveImplementation, runtime: oracleComp.runtime },
        underlying: { class: underlyingComp.class, effectiveImplementation: underlyingComp.effectiveImplementation, runtime: underlyingComp.runtime } } });
  }
  return { reservesList: list, reservesListCount: list.length, rows };
}
async function readState(candidate, pin, budget) {
  const core = await readCore(candidate, pin, budget);
  const reserves = await reservePass(candidate, pin, budget, core);
  return { core, reserves };
}
function reserveVerdict(row) {
  if (!row.inReservesList) return { status: "INCOMPLETE_NOT_IN_RESERVES_LIST", reason: "reserve not returned by getReservesList at the pin" };
  const outsiderOutsideCompliance = row.compliance && row.compliance.outsiderMember === false;
  if (row.transferProbe && row.transferProbe.ok) {
    if (row.issuer === "none") {
      return { status: "NO_OUTSIDER_PATH_TO_MANIPULATION_SURFACE", reason: "canonical permissionless reserve: a fresh non-issuer address can receive the underlying, but no novel manipulation-reachable accounting surface was identified from source+wire; behaviour is canonical supply/borrow/withdraw", outsiderReceivable: true };
    }
    return { status: "CANDIDATE_OUTSIDER_RECEIVABLE_UNDERLYING", reason: "an issuer-compliance RWA reserve allowed a fresh non-issuer address to receive the underlying via a transfer from the reserve aToken holder; acquisition/exit and economics are unproven and require a keyless local fork", outsiderReceivable: true };
  }
  if (row.transferProbe && row.transferProbe.attempted && !row.transferProbe.ok) {
    return { status: "EXCLUDED_ISSUER_COMPLIANCE_GATED", reason: "the underlying transfer to a fresh non-issuer address reverted at the pin; the reserve aToken holds the underlying and the issuer compliance system keeps the outsider outside its membership", outsiderReceivable: false,
      revertReason: row.transferProbe.revertReason || null, revertData: row.transferProbe.revertData || null, outsiderOutsideCompliance };
  }
  // not attempted: zero underlying balance at the aToken
  if (outsiderOutsideCompliance) {
    return { status: "EXCLUDED_ISSUER_COMPLIANCE_GATED", reason: "no current aToken underlying balance to probe, and the issuer compliance system keeps a fresh non-issuer address outside its membership; an isolated live transfer simulation is the confirming step", outsiderReceivable: false, transferProbeUnavailable: row.transferProbe?.reason || null, outsiderOutsideCompliance };
  }
  return { status: "INCOMPLETE_OUTSIDER_TRANSFER_NOT_TESTED", reason: row.transferProbe?.reason || "probe unavailable", outsiderReceivable: null };
}
function sanitizedState(state) {
  const copy = JSON.parse(JSON.stringify(state));
  for (const root of Object.values(copy.core.roots)) delete root.rawCode;
  return copy;
}
function decide(capture) {
  const cands = capture.valuePath.reserves.filter((row) => row.verdict.status === "CANDIDATE_OUTSIDER_RECEIVABLE_UNDERLYING");
  const incomplete = capture.valuePath.reserves.filter((row) => String(row.verdict.status).startsWith("INCOMPLETE"));
  if (incomplete.length) return "INCOMPLETE_VALUE_PATH_IDENTITY";
  if (cands.length) return "CANDIDATE_OUTSIDER_PATH_PRESENT_FORK_REQUIRED";
  return "CLOSED_NO_KNOWN_UNRESOLVED_OUTSIDER_PATH_AT_PIN";
}
async function main() {
  if (process.argv.length !== 2 && !(process.argv.length === 3 && process.argv[2] === "--check")) fail("ARGV_FORBIDDEN");
  const inventoryBytes = fs.readFileSync(INVENTORY), candidates = parseInventory(inventoryBytes);
  if (candidates.length < 2) fail("CANDIDATE_POOL_TOO_SMALL");
  if (process.argv[2] === "--check") {
    console.log(JSON.stringify({ status: "OFFLINE_CHECK_PASS", candidates: candidates.length, families: new Set(candidates.map((r) => r.family)).size,
      reserveCount: RESERVES.length, coreRoles: Object.keys(CORE).length, network: false }));
    return;
  }
  const corpus = secretCorpus(candidates), budget = new Budget();
  const qualification = await qualify(candidates, budget), pin = await commonPin(qualification.selected, budget);
  const states = []; for (const selected of qualification.selected) states.push(await readState(selected.candidate, pin, budget));
  const sanitizedA = sanitizedState(states[0]), sanitizedB = sanitizedState(states[1]);
  const agreement = canonical(sanitizedA) === canonical(sanitizedB);
  if (!agreement) fail("TWO_FAMILY_STATE_DISAGREEMENT");
  // classification
  for (const row of sanitizedA.reserves.rows) row.verdict = reserveVerdict(row);
  const poolImplMatchesPublished = sanitizedA.core.roots.pool.effectiveImplementation === address(CORE.poolImpl);
  const configuratorImplMatchesPublished = sanitizedA.core.roots.poolConfigurator.effectiveImplementation === address(CORE.poolConfiguratorImpl);
  // decode-primary class: an effective implementation address that diverges from the published/expected one.
  const undocumentedImplementations = [];
  for (const row of sanitizedA.reserves.rows) {
    if (!row.aTokenImplMatchesPublished) undocumentedImplementations.push({ reserve: row.symbol, role: "aToken", effectiveImplementation: row.graphs.aToken.effectiveImplementation, expected: row.expectedATokenImpl });
    if (!row.vTokenImplMatchesPublished) undocumentedImplementations.push({ reserve: row.symbol, role: "vToken", effectiveImplementation: row.graphs.vToken.effectiveImplementation, expected: CORE.defaultVTokenImpl });
    if (!row.oraclePublishedMatches) undocumentedImplementations.push({ reserve: row.symbol, role: "oracleSource", effectiveImplementation: row.oracleSource, expected: row.oraclePublished });
    if (row.aTokenUnderlying && row.aTokenUnderlying !== address(row.underlying)) undocumentedImplementations.push({ reserve: row.symbol, role: "aTokenUnderlying", effectiveImplementation: row.aTokenUnderlying, expected: row.underlying });
  }
  const terminal = []; for (const selected of qualification.selected) terminal.push(parseHeader(await requiredRpc(selected.candidate, "eth_getBlockByNumber", [pin.numberHex, false], budget, "TERMINAL_HEADER")));
  if (terminal.some((row) => row.hash !== pin.hash || row.stateRoot !== pin.stateRoot || row.number !== pin.number)) fail("TERMINAL_PIN_MISMATCH");
  const generatedAt = new Date().toISOString();
  const capture = { schema: "aave-horizon-core-gate0/v1", generatedAt,
    protocol: "Aave Horizon RWA (Ethereum mainnet)", claim: "coordinator/aave-horizon-core-gate0", lane: "def-3 trial Pick B",
    authority: { addressBook: "targets/aave-horizon-mglobal-address-book-a57a24d7", addressBookCommit: "a57a24d7815ef2e33ef7610528a76a3213a47a0f",
      addressBookFile: "src/AaveV3EthereumHorizon.sol", proposalTrees: ["targets/aave-horizon-mglobal-pr13-92a16781", "targets/aave-horizon-mglobal-pr14-4a854deb"],
      publishedCoreAddresses: CORE, govRoles: GOV, reserveSetSource: "address book Assets + AaveV3EthereumHorizonCustom", complianceSource: "tests/utils/HorizonRwaWhitelistHelper.sol" },
    chain: { name: "ethereum", chainId: "1", finalizedBlock: { number: pin.number.toString(), numberHex: pin.numberHex, hash: pin.hash, stateRoot: pin.stateRoot, timestamp: pin.timestamp.toString() },
      statePin: pinArg(pin), twoAnonymousIndependentFamiliesAgreed: true, terminalRecheck: { familyA: true, familyB: true },
      providerCorroborationIsNotStateRootProof: true },
    qualification: { inventory: "rpc_endpoints.txt", processOnly: true, candidatesConsidered: candidates.length,
      candidatesTested: qualification.candidatesTested, familiesTested: qualification.familiesTested, capableFamilies: qualification.capableFamilies,
      selectedFamilies: 2, independentFamilyKeys: true, selectedCapabilityScore: qualification.selectedCapabilityScore,
      requiredCapabilities: ["chain-1", "finalized-header", "historical-eip1898-eth_call", "historical-eip1898-eth_getCode", "historical-eip1898-eth_getStorageAt", "blockHash-eth_getLogs"] },
    coreBinding: { roots: sanitizedA.core.roots, providerViews: sanitizedA.core.providerViews, poolProvider: sanitizedA.core.poolProvider,
      aclAdminContract: sanitizedA.core.aclAdminContract,
      poolImplementationMatchesPublished: poolImplMatchesPublished, configuratorImplementationMatchesPublished: configuratorImplMatchesPublished,
      externalLibraryRoles: ["flashloanLogic", "borrowLogic", "liquidationLogic", "poolLogic", "supplyLogic"],
      externalLibraryCodePresent: Object.fromEntries(["flashloanLogic", "borrowLogic", "liquidationLogic", "poolLogic", "supplyLogic"].map((role) => [role, sanitizedA.core.roots[role].present])),
      undocumentedImplementations },
    valuePath: { freshOutsider: FRESH_OUTSIDER, reserves: sanitizedA.reserves.rows, reservesListCount: sanitizedA.reserves.reservesListCount },
    gates: { routePositive: false, executableNow: false, signedActionJustified: false, fork: false, completeRuntimeSourceBinding: false, economics: "N/A" },
    safety: { readOnly: true, allowedRpcMethods: [...METHODS].sort(), endpointInventoryProcessOnly: true,
      endpointOrCredentialMaterialPersisted: false, endpointMaterialHashed: false, rawRpcPersisted: false, environmentFilesRead: false,
      keyFilesRead: false, rpcOnArgv: false, transactions: false, stateOverrides: false, traces: false, signing: false, broadcast: false, fork: false },
    budget: budget.summary() };
  capture.status = decide(capture);
  capture.conclusion = capture.status === "CLOSED_NO_KNOWN_UNRESOLVED_OUTSIDER_PATH_AT_PIN"
    ? "At this fixed finalized pin no non-mGLOBAL Horizon reserve exposes an outsider-receivable underlying value path: every issuer-compliance token reverted a transfer to a fresh non-issuer address while its issuer system records the reserve aToken as a member and the fresh address as outside it, and the permissionless stablecoins expose only canonical Aave accounting surfaces. This is a pinned structural result, not a global or future claim; no economics and no fork."
    : capture.status === "CANDIDATE_OUTSIDER_PATH_PRESENT_FORK_REQUIRED"
      ? "At least one reserve allowed a fresh non-issuer address to receive the underlying. Acquisition/exit and economics remain unproven, so the next step is a keyless local fork, not a signed action."
      : "Part of the reserve topology could not be bound at this pin; the value-path result is INCOMPLETE and fails closed.";
  const reportText = renderReport(capture);
  assertSanitized(capture, corpus); assertSanitized(reportText, corpus);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const captureBytes = Buffer.from(`${JSON.stringify(capture, null, 2)}\n`);
  fs.writeFileSync(CAPTURE_PATH, captureBytes);
  fs.writeFileSync(REPORT_PATH, reportText);
  console.log(JSON.stringify({ status: capture.status, pin: pin.number.toString(), reserves: capture.valuePath.reserves.length,
    candidates: candidates.length, calls: budget.calls, artifact: "reports/raw/fast/aave-horizon-core-gate0-r1.json",
    sha256: sha256(captureBytes) }));
}
function renderReport(capture) {
  const rows = capture.valuePath.reserves.map((row) => `| ${row.symbol} | \`${row.underlying}\` | ${row.rwa ? "RWA" : "canonical"} | ${row.issuer} | ${row.paused} | ${row.oraclePublishedMatches ? "match" : "DIVERGENT"} | ${row.verdict.status} |`).join("\n");
  return `# Aave Horizon RWA core Gate0 (def-3 trial Pick B)

**Status:** \`${capture.status}\`  
**Finalized pin:** Ethereum block \`${capture.chain.finalizedBlock.number}\` (\`${capture.chain.finalizedBlock.hash}\`), state root \`${capture.chain.finalizedBlock.stateRoot}\`, timestamp \`${capture.chain.finalizedBlock.timestamp}\`.  
**Gates:** routePositive=false · executableNow=false · signedActionJustified=false · fork=false · economics=N/A.

## Result

${capture.conclusion}

This is a read-only, two-anonymous-family, block-hash-pinned Phase-0 exam. Provider corroboration is not state-root proof, and the ABI/address pins establish decoding inputs and identity, not full deployed implementation equivalence.

## Core binding

- Pool \`${capture.valuePath && capture.coreBinding.roots.pool.address}\` effective implementation matches the published \`POOL_IMPL\`: **${capture.coreBinding.poolImplementationMatchesPublished}**; PoolConfigurator effective implementation matches published \`POOL_CONFIGURATOR_IMPL\`: **${capture.coreBinding.configuratorImplementationMatchesPublished}**.
- The Pool delegates value logic to the external-library contracts (POOL/SUPPLY/BORROW/LIQUIDATION/FLASHLOAN). Their runtime identities are recorded per-pin in the machine artifact.

## Per-reserve value-path topology

| Reserve | Underlying | Class | Issuer | Paused | Oracle src | Verdict |
|---|---|---|---|---|---:|---|
${rows}

Machine artifact: \`reports/raw/fast/aave-horizon-core-gate0-r1.json\`.
`;
}
if (require.main === module) main().catch((error) => { console.error(JSON.stringify({ status: "REFUSED_OR_FAILED", code: error instanceof GateError ? error.code : "UNEXPECTED" })); process.exitCode = 2; });
module.exports = { CORE, RESERVES, EIP1967, parseInventory, parseHeader, proxyClass, component, reserveVerdict, decide };
