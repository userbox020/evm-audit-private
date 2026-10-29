#!/usr/bin/env node
"use strict";

// Step 3: bounded read-only resolution of the four custom oracle route keys
// left open by small-cap-oracle-current-paths-7200ea525d4263bb327a.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let ethers;
try { ({ ethers } = require("ethers")); } catch (_) { ({ ethers } = require("./node_modules/ethers")); }
const sharedRpc = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const REL = {
  scanner: "tools/scan-small-cap-oracle-custom-edges.js",
  input: "reports/raw/fast/small-cap-oracle-current-paths.json",
  raw: "reports/raw/fast/small-cap-oracle-custom-edges.json",
  report: "reports/small-cap-oracle-custom-edges-triage.md",
  manifest: "reports/raw/fast/small-cap-oracle-custom-edges.manifest.json",
  definitions: "reports/raw/fast/small-cap-oracle-custom-edges-definitions.json",
  sources: "reports/raw/fast/small-cap-oracle-custom-edges-source-snapshots.json",
  handoff: "coordination/handoffs/small-cap-oracle-custom-edges-handoff.md",
};
const abs = (p) => path.join(ROOT, ...p.split("/"));
const EXPECTED_INPUT_RUN = "small-cap-oracle-current-paths-7200ea525d4263bb327a";
const EXPECTED_INPUT_SHA256 = "12356765ec4b68f26d8944145a7220bd507ffc1e1c5aedb30f11f334817b0981";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const ZERO = ethers.ZeroAddress;
const TIMEOUT_MS = 15_000;
const QUIET = process.argv.includes("--quiet");
const VERIFY = process.argv.includes("--verify");
const SELF_TEST = process.argv.includes("--self-test");
const LOCK = "reports/raw/fast/.small-cap-oracle-custom-edges.lock";
const STAGING_BASE = "reports/raw/fast/.small-cap-oracle-custom-edges-staging";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const DEX_FAMILIES = ["uniswapV2", "uniswapV3", "curve", "balancer", "genericSpotTwap"];
const UNSUPPORTED_SOURCE_BLOCKERS = [
  "No contract-scoped inheritance-linearized recursive source callgraph.",
  "Euler Router IPriceOracle.getQuote is not traversed.",
  "StakedUSDe _convertToAssets -> totalAssets -> balanceOf is not traversed.",
  "EVault using-for dispatch remains unsupported.",
  "Chronicle cast dispatch remains unsupported.",
  "FIXED_DISPATCH is assertion/context, not source proof.",
  "DEX family booleans are not source-derived and remain unsupported.",
];
// Fixed-head dispatches are evidence bindings, not name-based source assumptions.
const FIXED_DISPATCH = {
  "0x2e4eb0647fd1f9029499d41153a7cccb1ab5d886": ["0x5a4beeb8854442d69267c9a0a3a17be60fdded04"],
  "0x5a4beeb8854442d69267c9a0a3a17be60fdded04": ["0x5d44916e0db13ecd661b20df4d645904e57589c8"],
  "0x5d44916e0db13ecd661b20df4d645904e57589c8": ["0x02cf8c9fba24d79886dac40cb620f0930c6e8ec0"],
  "0x93840a424abc32549809dd0bc07ceb56e137221c": ["0xbc5fbcf58ceaea19d523abc76515b9aefb5cfd58"],
  "0xbc5fbcf58ceaea19d523abc76515b9aefb5cfd58": ["0x5c499403bc092c651e35893af6fe5ce973692795"],
  "0x5c499403bc092c651e35893af6fe5ce973692795": ["0xd72a6ba4a87ddb33e801b3f1c7750b2d0911fc6c"],
  "0xd72a6ba4a87ddb33e801b3f1c7750b2d0911fc6c": ["0x0c6c73865429e1d87b7b817b95bb1f38f2136529"],
  "0x8211b9ae40b06d3db0215e520f232184af355378": ["0xa569d910839ae8865da8f8e70fffb0cba869f961"],
  "0xa569d910839ae8865da8f8e70fffb0cba869f961": ["0xcc16f670129f965b396f2e81312f6e339ffdb18e"],
  "0x660750b98c3a53dd1303f2e43f543ef037d3f625": ["0x29a56a1b8214d9cf7c5561811750d5cbdb45cc8e", "0x8ff1c814719096b61abf00bb46ead0c9a529dd7d"],
  "0xdb6165bd1f90cb507f30abdb42c4596ce4d894f4": ["0x29a56a1b8214d9cf7c5561811750d5cbdb45cc8e", "0x8ff1c814719096b61abf00bb46ead0c9a529dd7d"],
  "0x56b829e465170c3accad33a3e0512b239b202242": ["0x29a56a1b8214d9cf7c5561811750d5cbdb45cc8e", "0x8ff1c814719096b61abf00bb46ead0c9a529dd7d"],
  "0x29a56a1b8214d9cf7c5561811750d5cbdb45cc8e": ["0x8ff1c814719096b61abf00bb46ead0c9a529dd7d"],
};

// Assertions only. These identities never establish source availability or closure.
const EXPECTED_IDENTITIES = {
  "0x5a4beeb8854442d69267c9a0a3a17be60fdded04": { name: "ChronicleVAO_Centrifuge_JAAA_ChainlinkAdapter_1", compiler: "0.8.28", optimizer: { enabled: true, runs: 10000 }, immutableTargets: { chronicleRouter: "0x5D44916E0Db13EcD661b20Df4D645904E57589C8" } },
  "0x2e4eb0647fd1f9029499d41153a7cccb1ab5d886": { name: "MorphoChainlinkOracleV2", compiler: "0.8.21", optimizer: null },
  "0x93840a424abc32549809dd0bc07ceb56e137221c": { name: "ChainlinkInfrequentOracle", compiler: null, optimizer: null, immutables: { feed: "0xbC5FBcf58CeAEa19D523aBc76515b9AEFb5cfd58", maxStaleness: "90000" } },
  "0xbc5fbcf58ceaea19d523abc76515b9aefb5cfd58": { name: "TransparentUpgradeableProxy", compiler: null, optimizer: null, dynamicTarget: "eip1967Implementation" },
  "0x5c499403bc092c651e35893af6fe5ce973692795": { name: "EthereumPriceFeedUsdeWithoutRoundsV1", compiler: null, optimizer: null, immutableTargets: { redstoneAdapter: "0xd72a6BA4A87dDB33E801b3F1C7750b2D0911fC6c" }, feedId: "USDe" },
  "0xd72a6ba4a87ddb33e801b3f1c7750b2d0911fc6c": { name: "FixedRedStoneAdapter", compiler: null, optimizer: null, dynamicTarget: "implementation-from-runtime" },
  "0x8211b9ae40b06d3db0215e520f232184af355378": { name: "ChainlinkOracle", compiler: null, optimizer: null, immutables: { feed: "0xa569d910839Ae8865Da8F8e70FfFb0cBA869F961", maxStaleness: "90000" } },
  "0xa569d910839ae8865da8f8e70fffb0cba869f961": { name: "EACAggregatorProxy", compiler: null, optimizer: null, dynamicTarget: "aggregator()" },
  "0xcc16f670129f965b396f2e81312f6e339ffdb18e": { name: "AccessControlledOCR2Aggregator", compiler: null, optimizer: null },
  "0x5d44916e0db13ecd661b20df4d645904e57589c8": { name: "ChronicleRouter", compiler: null, optimizer: null, dynamicTarget: "governance-selected-oracle" },
  "0x02cf8c9fba24d79886dac40cb620f0930c6e8ec0": { name: "ChronicleVAO_Centrifuge_JAAA_Consumer_1", compiler: "0.8.28", optimizer: { enabled: true, runs: 10000 }, evmVersion: "paris", proxy: false, constructor: { authed: "0x39aBD7819E5632Fa06D2ECBba45Dca5c90687EE3", router: "0x5D44916E0Db13EcD661b20Df4D645904E57589C8" }, readSemantics: "storage-cached signed Chronicle value; readWithAge has no external DEX read" },
  "0x0c6c73865429e1d87b7b817b95bb1f38f2136529": { name: "EthereumMultiFeedAdapterWithoutRoundsV3", compiler: "0.8.17", optimizer: { enabled: true, runs: 10000 }, readSemantics: "storage-backed getValueForDataFeed/getLastUpdateDetails with authenticated RedStone updates; no external DEX read" },
};

const LOCAL_SOURCES = [
  "targets/morpho-blue-oracles/src/morpho-chainlink/MorphoChainlinkOracleV2.sol",
  "targets/morpho-blue/src/interfaces/IMorpho.sol",
  "targets/euler-oracle/src/EulerRouter.sol",
  "targets/euler-oracle/src/adapter/BaseAdapter.sol",
  "targets/euler-oracle/src/adapter/chainlink/ChainlinkInfrequentOracle.sol",
  "targets/euler-oracle/src/adapter/chainlink/ChainlinkOracle.sol",
  "targets/euler-oracle/src/adapter/chainlink/AggregatorV3Interface.sol",
  "tools/shared-rpc.js",
  "tools/node_modules/ethers/package.json",
];

const ABI = {
  morpho: new ethers.Interface([
    "function idToMarketParams(bytes32) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)",
    "function market(bytes32) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  ]),
  morphoOracle: new ethers.Interface([
    "function price() view returns (uint256)", "function BASE_VAULT() view returns (address)",
    "function BASE_VAULT_CONVERSION_SAMPLE() view returns (uint256)", "function QUOTE_VAULT() view returns (address)",
    "function QUOTE_VAULT_CONVERSION_SAMPLE() view returns (uint256)", "function BASE_FEED_1() view returns (address)",
    "function BASE_FEED_2() view returns (address)", "function QUOTE_FEED_1() view returns (address)",
    "function QUOTE_FEED_2() view returns (address)", "function SCALE_FACTOR() view returns (uint256)",
  ]),
  oracle: new ethers.Interface([
    "function getQuote(uint256,address,address) view returns (uint256)", "function getQuotes(uint256,address,address) view returns (uint256,uint256)",
    "function base() view returns (address)", "function quote() view returns (address)", "function feed() view returns (address)",
    "function maxStaleness() view returns (uint256)", "function name() view returns (string)",
  ]),
  router: new ethers.Interface(["function getQuote(uint256,address,address) view returns (uint256)"]),
  feed: new ethers.Interface([
    "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
    "function decimals() view returns (uint8)", "function description() view returns (string)",
    "function aggregator() view returns (address)", "function phaseId() view returns (uint16)", "function owner() view returns (address)",
    "function feedId() view returns (bytes32)", "function getDataFeedId() view returns (bytes32)",
  ]),
  erc4626: new ethers.Interface(["function convertToAssets(uint256) view returns (uint256)", "function asset() view returns (address)", "function decimals() view returns (uint8)"]),
  beacon: new ethers.Interface(["function implementation() view returns (address)"]),
  chronicle: new ethers.Interface(["function readWithAge() view returns (uint256 value,uint256 age)", "function tolled(address) view returns (bool)"]),
  redstone: new ethers.Interface(["function getValueForDataFeed(bytes32) view returns (uint256)", "function getLastUpdateDetails(bytes32) view returns (uint256 lastDataTimestamp,uint256 lastBlockTimestamp,uint256 lastValue)"]),
  dex: new ethers.Interface(["function token0() view returns (address)", "function token1() view returns (address)", "function getReserves() view returns (uint112,uint112,uint32)", "function liquidity() view returns (uint128)", "function getPoolId() view returns (bytes32)", "function getVault() view returns (address)", "function coins(uint256) view returns (address)", "function get_dy(int128,int128,uint256) view returns (uint256)"]),
};

function sha(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function fileBinding(rel) { const b = fs.readFileSync(abs(rel)); return { file: rel, bytes: b.length, sha256: sha(b) }; }
function physicalBinding(file, rel) { const b = fs.readFileSync(file); return { file: rel, bytes: b.length, sha256: sha(b) }; }
function writeJsonAt(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function stagePath(root, rel) { return path.join(root, ...rel.split("/")); }
function norm(v) { try { return ethers.getAddress(v); } catch (_) { return null; } }
function addrWord(v) { return /^0x[0-9a-fA-F]{64}$/.test(String(v || "")) ? norm(`0x${v.slice(-40)}`) : null; }
function hexNum(v) { return `0x${BigInt(v).toString(16)}`; }
function cleanError(v) { return String(v || "unknown").replace(/https?:\/\/[^\s'\"<>]+/gi, "[redacted-url]").slice(0, 240); }
function count(rows, fn) { return rows.filter(fn).length; }

function decodeHtml(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(value || "").replace(/&#(x[0-9a-f]+|\d+);|&([a-z]+);/gi, (_m, numeric, name) => {
    if (numeric) return String.fromCodePoint(numeric[0].toLowerCase() === "x" ? parseInt(numeric.slice(1), 16) : parseInt(numeric, 10));
    return named[String(name).toLowerCase()] ?? _m;
  });
}

function decodeJsSingleQuoted(value) {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "\\") { out += value[i]; continue; }
    const n = value[++i];
    if (n === undefined) break;
    if (n === "n") out += "\n"; else if (n === "r") out += "\r"; else if (n === "t") out += "\t";
    else if (n === "b") out += "\b"; else if (n === "f") out += "\f"; else if (n === "v") out += "\v";
    else if (n === "x" && /^[0-9a-fA-F]{2}$/.test(value.slice(i + 1, i + 3))) { out += String.fromCharCode(parseInt(value.slice(i + 1, i + 3), 16)); i += 2; }
    else if (n === "u" && /^[0-9a-fA-F]{4}$/.test(value.slice(i + 1, i + 5))) { out += String.fromCharCode(parseInt(value.slice(i + 1, i + 5), 16)); i += 4; }
    else if (n === "\n") { /* continuation */ } else out += n;
  }
  return out;
}

function firstMatch(html, regex) { const m = html.match(regex); return m ? decodeHtml(m[1]).trim() : null; }
function normalizeBytecode(value) { const m = String(value || "").match(/0x[0-9a-fA-F]+/); return m ? m[0].toLowerCase() : null; }
function normalizeHexBlob(value) { const compact = decodeHtml(String(value || "")).replace(/<[^>]+>/g, "").replace(/\s+/g, ""); return /^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0 ? `0x${compact.toLowerCase()}` : normalizeBytecode(compact); }
function stripHtml(value) { return decodeHtml(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(); }
function extractConstructorBlob(html) {
  const heading = /(?:ABI-Encoded\s+)?Constructor Arguments/i.exec(html); if (!heading) return null;
  // Etherscan puts a human decoded view after the encoded blob. Never scan past it.
  const bounded = html.slice(heading.index, heading.index + 20_000).split(/-----\s*Decoded View|<br\s*\/?>\s*<br\s*\/?>/i)[0];
  const candidates = [...stripHtml(bounded).matchAll(/(?:0x)?([0-9a-fA-F]{64,})/g)].map((m) => m[1]);
  const blob = candidates.sort((a, b) => b.length - a.length)[0] || null;
  return blob && blob.length % 64 === 0 ? `0x${blob.toLowerCase()}` : null;
}
function parseOptimizerSettings(html) {
  const heading = /Optimization Enabled/i.exec(html); if (!heading) return { enabled: null, runs: null, raw: null };
  const raw = stripHtml(html.slice(heading.index, heading.index + 1200)); const enabled = /\bYes\b/i.test(raw) ? true : /\bNo\b/i.test(raw) ? false : null; const runMatch = raw.match(/\b(\d+)\s+runs?\b/i);
  return { enabled, runs: runMatch ? Number(runMatch[1]) : null, raw };
}
function serializableAbiValue(value) { if (typeof value === "bigint") return value.toString(); if (Array.isArray(value)) return value.map(serializableAbiValue); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).filter((k) => !/^\d+$/.test(k)).map((k) => [k, serializableAbiValue(value[k])])); return value; }
function extractJsSingleQuotedAssignment(html, variable) {
  const startMatch = html.match(new RegExp(`var\\s+${variable}\\s*=\\s*'`)); if (!startMatch) return null;
  const start = startMatch.index + startMatch[0].length; let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i]; if (escaped) { escaped = false; continue; } if (ch === "\\") { escaped = true; continue; }
    if (ch === "'") return html.slice(start, i);
  }
  return null;
}

function parseExplorerHtml(html, address, fetchedAt, status) {
  const sourceVar = extractJsSingleQuotedAssignment(html, "editor_contractJsonData");
  let standardJson = null; let sourceParseFailure = null;
  if (sourceVar) {
    try { standardJson = JSON.parse(decodeJsSingleQuoted(sourceVar)); }
    catch (e) { sourceParseFailure = cleanError(e.message); }
  }
  const sources = [];
  for (const [fileName, item] of Object.entries(standardJson?.sources || {})) {
    if (typeof item?.content === "string" && item.content.length) sources.push({ fileName, content: item.content, bytes: Buffer.byteLength(item.content), sha256: sha(Buffer.from(item.content)) });
  }
  const abiText = firstMatch(html, /<pre[^>]*id=['"]js-copytextarea2['"][^>]*>([\s\S]*?)<\/pre>/i)?.replace(/<[^>]+>/g, "").trim() || null;
  let abi = null; let abiParseFailure = null;
  if (abiText) { try { abi = JSON.parse(abiText); } catch (e) { abiParseFailure = cleanError(e.message); } }
  const deployedSection = html.match(/<h6[^>]*>\s*Deployed Bytecode\s*<\/h6>[\s\S]*?<pre[^>]*>([\s\S]*?)<\/pre>/i);
  const creationSection = html.match(/<h6[^>]*>\s*(?:Contract )?Creation (?:Code|Bytecode)\s*<\/h6>[\s\S]*?<pre[^>]*>([\s\S]*?)<\/pre>/i);
  const deployedBytecode = normalizeBytecode(deployedSection?.[1]?.replace(/<[^>]+>/g, ""));
  const creationBytecode = normalizeBytecode(creationSection?.[1]?.replace(/<[^>]+>/g, ""));
  const constructorArgs = extractConstructorBlob(html);
  const contractName = firstMatch(html, /Contract Name[\s\S]{0,300}?<h4[^>]*>([\s\S]*?)<\/h4>/i)?.replace(/<[^>]+>/g, "").trim() || null;
  const compiler = firstMatch(html, /Compiler Version[\s\S]{0,400}?<span[^>]*>([\s\S]*?)<\/span>/i)?.replace(/<[^>]+>/g, "").trim() || null;
  const optimizer = parseOptimizerSettings(html); const optimizationText = optimizer.raw;
  const otherSettings = firstMatch(html, /Other Settings[\s\S]{0,500}?<span[^>]*>([\s\S]*?)<\/span>/i)?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null;
  let constructorDecoded = null; let constructorDecodeFailure = null;
  const constructorAbi = Array.isArray(abi) ? abi.find((item) => item?.type === "constructor") : null;
  if (constructorArgs && constructorAbi) {
    try { const params = (constructorAbi.inputs || []).map((x) => ethers.ParamType.from(x)); const decoded = ethers.AbiCoder.defaultAbiCoder().decode(params, constructorArgs); constructorDecoded = params.map((p, i) => ({ name: p.name || null, type: p.format("full"), value: serializableAbiValue(decoded[i]) })); }
    catch (e) { constructorDecodeFailure = cleanError(e.message); }
  }
  const verified = status === 200 && sources.length > 0 && Array.isArray(abi);
  return {
    address: norm(address), publicUrl: `https://etherscan.io/address/${norm(address)}#code`, fetch: { timestamp: fetchedAt, status, responseBytes: Buffer.byteLength(html), responseSha256: sha(Buffer.from(html)), browserUserAgent: "Mozilla/5.0 Chrome-compatible" },
    parsed: { verified, contractName, compiler, optimizationText, optimizer, otherSettings, constructorArgs, constructorDecoded, constructorDecodeFailure, sources, sourceFileCount: sources.length, sourceBytes: sources.reduce((n, s) => n + s.bytes, 0), abi, abiSha256: abiText ? sha(Buffer.from(abiText)) : null, deployedBytecode, deployedBytecodeSha256: deployedBytecode ? sha(Buffer.from(deployedBytecode.slice(2), "hex")) : null, deployedBytecodeKeccak256: deployedBytecode ? ethers.keccak256(deployedBytecode) : null, creationBytecode, creationBytecodeSha256: creationBytecode ? sha(Buffer.from(creationBytecode.slice(2), "hex")) : null, standardJsonSettings: standardJson?.settings || null, compilerSettings: { compiler, optimizer, otherSettings, standardJsonSettings: standardJson?.settings || null }, sourceParseFailure, abiParseFailure },
  };
}

async function fetchExplorerEvidence(address) {
  const url = `https://etherscan.io/address/${norm(address)}#code`; const fetchedAt = new Date().toISOString();
  try {
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", accept: "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(60_000) });
    const html = await response.text(); return { html, evidence: parseExplorerHtml(html, address, fetchedAt, response.status) };
  } catch (e) {
    return { html: "", evidence: { address: norm(address), publicUrl: url, fetch: { timestamp: fetchedAt, status: null, responseBytes: null, responseSha256: null, failure: cleanError(e.message), browserUserAgent: "Mozilla/5.0 Chrome-compatible" }, parsed: { verified: false, sources: [], sourceFileCount: 0, sourceBytes: 0, abi: null, deployedBytecode: null } } };
  }
}

function selectScope(input) {
  if (input.runId !== EXPECTED_INPUT_RUN) throw new Error(`immutable input run mismatch: ${input.runId}`);
  const unresolved = (input.uniqueRoutes || []).filter((r) => r.unresolved);
  if (unresolved.length !== 4) throw new Error(`expected four unresolved route keys, got ${unresolved.length}`);
  const keys = new Set(unresolved.map((r) => r.routeKey));
  const rows = (input.rows || []).filter((r) => keys.has(r.routeKey));
  if (rows.length !== 7) throw new Error(`expected seven unresolved candidate rows, got ${rows.length}`);
  return { inputRoutes: unresolved, inputRows: rows };
}

function propagateDuplicateFixture(routes, rows) {
  const byKey = new Map(routes.map((r) => [r.routeKey, r]));
  return rows.map((r) => ({ candidateIndex: r.legacy.candidateIndex, routeKey: r.routeKey, routeResolved: byKey.get(r.routeKey)?.resolved ?? null }));
}

function runFixtures() {
  const trace = { success: true, calls: [{ family: "redstone-push", dex: false }, { family: "chainlink-push", dex: false }] };
  const classified = trace.success && trace.calls.every((c) => !c.dex) ? "non-dex" : "open";
  const routes = [{ routeKey: "a", resolved: true }, { routeKey: "b", resolved: false }];
  const rows = [{ routeKey: "a", legacy: { candidateIndex: 1 } }, { routeKey: "a", legacy: { candidateIndex: 2 } }, { routeKey: "b", legacy: { candidateIndex: 3 } }];
  const propagated = propagateDuplicateFixture(routes, rows);
  const detectFamily = (abi) => abi.get_dy || abi.coins ? "curve" : abi.getPoolId || abi.queryBatchSwap ? "balancer" : abi.slot0 || abi.observe ? "uniswap-v3" : abi.getReserves ? "uniswap-v2" : "unknown";
  const dynamicChanged = (oldTarget, currentTarget) => oldTarget.toLowerCase() !== currentTarget.toLowerCase();
  const sourceJson = JSON.stringify({ language: "Solidity", sources: { "A.sol": { content: "contract A { function x() external {} }" } }, settings: { optimizer: { enabled: true, runs: 200 } } });
  const jsEscaped = sourceJson.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
  const fixtureHtml = `<h6>Contract Name</h6><h4> A </h4><h6>Compiler Version</h6><span>v0.8.20</span><h6>Optimization Enabled</h6><span>Yes <span>with</span> 200 <span>runs</span></span><h6>Constructor Arguments</h6><div>0000000000000000000000000000000000000000000000000000000000000001<br><br>-----Decoded View</div><pre id='js-copytextarea2'>[{"type":"constructor","inputs":[{"name":"pair","type":"tuple","components":[{"name":"n","type":"uint256"}]}]}]</pre><h6>Deployed Bytecode</h6><pre><div>0x6000</div></pre><script>var editor_contractJsonData = '${jsEscaped}';</script>`;
  const parsed = parseExplorerHtml(fixtureHtml, "0x0000000000000000000000000000000000000001", "2026-01-01T00:00:00.000Z", 200);
  const castCalls = tokenCalls(solidityTokens("function x(){ IReader(uscribe()).readWithAge(); super.latestRoundData(); shares.toAssetsDown(); }")).join(",");
  const dexMetadataSafe = !DEX_FAMILIES.some((family) => ({ uniswapV2: false, uniswapV3: false, curve: false, balancer: false, genericSpotTwap: false, method: "metadata" })[family] === true);
  const proxyFixture = FIXED_DISPATCH["0xbc5fbcf58ceaea19d523abc76515b9aefb5cfd58"]?.[0] === "0x5c499403bc092c651e35893af6fe5ce973692795" && FIXED_DISPATCH["0x660750b98c3a53dd1303f2e43f543ef037d3f625"]?.includes("0x8ff1c814719096b61abf00bb46ead0c9a529dd7d");
  let persistedPagePassed = false; try { const prior = JSON.parse(fs.readFileSync(abs(REL.raw), "utf8")); const item = (prior.routes || []).flatMap((r) => r.sourceCoverage?.targets || []).find((t) => t.address?.toLowerCase() === "0x02cf8c9fba24d79886dac40cb620f0930c6e8ec0"); if (item?.explorerRawHtmlFile) { const real = parseExplorerHtml(fs.readFileSync(abs(item.explorerRawHtmlFile), "utf8"), item.address, "fixture", 200); persistedPagePassed = Boolean(real.parsed.constructorArgs && real.parsed.constructorDecoded && Number.isInteger(real.parsed.optimizer?.runs)); } } catch (_) { persistedPagePassed = false; }
  if (classified !== "non-dex" || propagated[0].routeResolved !== true || propagated[1].routeResolved !== true || propagated[2].routeResolved !== false || detectFamily({ coins: true, get_dy: true }) !== "curve" || detectFamily({ getPoolId: true, queryBatchSwap: true }) !== "balancer" || !dynamicChanged("0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002") || !parsed.parsed.verified || parsed.parsed.sources[0]?.content !== "contract A { function x() external {} }" || parsed.parsed.deployedBytecode !== "0x6000" || parsed.parsed.constructorArgs !== `0x${"0".repeat(63)}1` || parsed.parsed.constructorDecoded?.[0]?.value?.[0] !== "1" || parsed.parsed.optimizer.enabled !== true || parsed.parsed.optimizer.runs !== 200 || !persistedPagePassed || !castCalls.includes("IReader") || !castCalls.includes("super.latestRoundData") || !castCalls.includes("shares.toAssetsDown") || !dexMetadataSafe || !proxyFixture) throw new Error("trace/dex/dynamic-target/duplicate/html-parser fixtures failed");
  return { passed: 19, names: ["trace-non-dex", "duplicate-first", "duplicate-second", "unresolved-null-safety", "curve-family", "balancer-family", "dynamic-target-change", "html-source-nonempty", "html-abi", "html-runtime", "html-unprefixed-constructor", "html-constructor-abi-decode", "html-tuple-constructor", "html-nested-optimizer", "persisted-etherscan-html-fragment", "dex-metadata-boolean-only", "cast-call", "proxy-beacon-fallback", "super-using-for-member-chain"] };
}

class Rpc {
  constructor(url, metrics) { this.url = url; this.metrics = metrics; }
  async send(method, params, timeout = TIMEOUT_MS) {
    const start = Date.now(); this.metrics.requests++;
    const result = await sharedRpc.rpcCall(this.url, method, params, timeout);
    this.metrics.latencyMs += Date.now() - start;
    if (result === null) this.metrics.failures++;
    return result;
  }
  async call(to, iface, fn, args, block) {
    const selector = iface.getFunction(fn).selector;
    let data; try { data = iface.encodeFunctionData(fn, args || []); } catch (_) { return { ok: false, selector, failure: "encode-failed" }; }
    const raw = await this.send("eth_call", [{ to, data }, hexNum(block)]);
    if (!raw) return { ok: false, selector, failure: "rpc-null-or-revert", raw: null };
    try { return { ok: true, selector, raw, value: iface.decodeFunctionResult(fn, raw) }; }
    catch (_) { return { ok: false, selector, failure: "decode-failed", raw }; }
  }
}

async function resolveRpc(validationAddress) {
  const inventory = sharedRpc.loadRpcUrls();
  const candidates = [...inventory];
  if (sharedRpc.PUBLIC_FALLBACKS[1] && !candidates.includes(sharedRpc.PUBLIC_FALLBACKS[1])) candidates.push(sharedRpc.PUBLIC_FALLBACKS[1]);
  const metrics = { inventoryRead: true, inventoryCandidates: inventory.length, candidatesTried: 0, requests: 0, failures: 0, latencyMs: 0, selected: false };
  for (const url of candidates) {
    metrics.candidatesTried++; const rpc = new Rpc(url, metrics);
    const id = await rpc.send("eth_chainId", [], 5_000); if (!id || Number(BigInt(id)) !== 1) continue;
    const latest = await rpc.send("eth_getBlockByNumber", ["latest", false]); if (!latest?.hash) continue;
    const number = Number(BigInt(latest.number));
    const code = await rpc.send("eth_getCode", [validationAddress, hexNum(number)]);
    const archiveNumber = Math.max(1, number - 2048); const archiveCode = await rpc.send("eth_getCode", [validationAddress, hexNum(archiveNumber)]);
    if (!code || code === "0x" || archiveCode === null) continue;
    const trace = await rpc.send("debug_traceCall", [{ to: validationAddress, data: ABI.morphoOracle.encodeFunctionData("price", []) }, hexNum(number), { tracer: "callTracer" }], 30_000);
    if (!trace) continue;
    metrics.selected = true;
    return { rpc, metrics, head: { chainId: 1, number, hash: latest.hash, timestamp: Number(BigInt(latest.timestamp)), iso: new Date(Number(BigInt(latest.timestamp)) * 1000).toISOString(), archiveValidation: { number: archiveNumber, historicalCodeRead: true }, validationCodeHash: ethers.keccak256(code) } };
  }
  throw new Error("no chain/archive/code/trace-capable Ethereum endpoint");
}

function decodeCborMetadata(code) {
  const bytes = ethers.getBytes(code || "0x");
  if (bytes.length < 2) return { present: false, length: null, sha256: null, markers: [] };
  const length = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  if (length <= 0 || length + 2 > bytes.length) return { present: false, length, sha256: null, markers: [] };
  const payload = bytes.slice(bytes.length - 2 - length, bytes.length - 2);
  const ascii = Buffer.from(payload).toString("latin1");
  const markers = ["ipfs", "bzzr0", "bzzr1", "solc"].filter((m) => ascii.includes(m));
  return { present: true, length, sha256: sha(payload), markers, payloadHex: ethers.hexlify(payload) };
}

function disassembleBounded(code) {
  const b = ethers.getBytes(code || "0x"); const selectors = new Set(); const calls = []; let sload = 0; let sstore = 0;
  for (let i = 0; i < b.length;) {
    const op = b[i];
    if (op === 0x63 && i + 4 < b.length) selectors.add(ethers.hexlify(b.slice(i + 1, i + 5)));
    if ([0xf1, 0xf2, 0xf4, 0xfa].includes(op)) calls.push({ offset: i, opcode: { 0xf1: "CALL", 0xf2: "CALLCODE", 0xf4: "DELEGATECALL", 0xfa: "STATICCALL" }[op] });
    if (op === 0x54) sload++; if (op === 0x55) sstore++;
    i += op >= 0x60 && op <= 0x7f ? 2 + op - 0x60 : 1;
  }
  return { codeBytes: b.length, push4Selectors: [...selectors].sort(), callLikeOpcodes: calls.slice(0, 128), callLikeOpcodeCount: calls.length, sloadCount: sload, sstoreCount: sstore, bounded: true, caveat: "Opcode presence is not reachability; fixed-call traces provide executed edges." };
}

async function callOptional(ctx, address, iface, fn, args = []) {
  const r = await ctx.rpc.call(address, iface, fn, args, ctx.head.number);
  let decoded = null;
  if (r.ok) decoded = [...r.value].map((v) => typeof v === "bigint" ? v.toString() : v);
  return { selector: r.selector, success: r.ok, returnData: r.raw || null, decoded, failure: r.failure || null };
}

const inspectCache = new Map(); const runtimeCodeCache = new Map();
async function inspectContract(ctx, address) {
  address = norm(address); if (!address) return { address: null, codePresent: false, failure: "invalid-address" };
  const cacheKey = `${ctx.head.number}:${address.toLowerCase()}`; if (inspectCache.has(cacheKey)) return inspectCache.get(cacheKey);
  const code = await ctx.rpc.send("eth_getCode", [address, hexNum(ctx.head.number)]);
  if (!code || code === "0x") { const miss = { address, codePresent: false, failure: "no-code-at-fixed-head" }; inspectCache.set(cacheKey, miss); return miss; }
  const [implWord, beaconWord, adminWord] = await Promise.all([
    ctx.rpc.send("eth_getStorageAt", [address, EIP1967_IMPL, hexNum(ctx.head.number)]),
    ctx.rpc.send("eth_getStorageAt", [address, EIP1967_BEACON, hexNum(ctx.head.number)]),
    ctx.rpc.send("eth_getStorageAt", [address, EIP1967_ADMIN, hexNum(ctx.head.number)]),
  ]);
  let implementation = addrWord(implWord), beacon = addrWord(beaconWord), admin = addrWord(adminWord);
  if (implementation === ZERO) implementation = null; if (beacon === ZERO) beacon = null;
  if (admin === ZERO) admin = null;
  if (!implementation && beacon) { const r = await ctx.rpc.call(beacon, ABI.beacon, "implementation", [], ctx.head.number); implementation = r.ok ? norm(r.value[0]) : null; }
  let implementationCodeHash = null;
  if (implementation) { const c = await ctx.rpc.send("eth_getCode", [implementation, hexNum(ctx.head.number)]); implementationCodeHash = c && c !== "0x" ? ethers.keccak256(c) : null; }
  const result = {
    address, codePresent: true, codeBytes: (code.length - 2) / 2, codeHash: ethers.keccak256(code), runtimeHash: sha(Buffer.from(code.slice(2), "hex")),
    proxy: Boolean(implementation || beacon), implementation, implementationCodeHash, beacon, admin,
    cborMetadata: decodeCborMetadata(code), disassembly: disassembleBounded(code), blockNumber: ctx.head.number, blockHash: ctx.head.hash,
    creation: { transactionHash: null, constructorArgs: null, status: "unavailable-from-standard-RPC-without-indexed-creation-transaction" },
  };
  runtimeCodeCache.set(cacheKey, code.toLowerCase()); inspectCache.set(cacheKey, result); return result;
}

function normalizeTrace(node, depth = 0) {
  if (!node || depth > 16) return null;
  const input = typeof node.input === "string" ? node.input : "0x"; const output = typeof node.output === "string" ? node.output : null;
  return {
    type: node.type || null, from: norm(node.from), to: norm(node.to), selector: input.length >= 10 ? input.slice(0, 10) : null,
    value: node.value || "0x0", success: !node.error, error: node.error ? cleanError(node.error) : null,
    inputHash: sha(Buffer.from(input.replace(/^0x/, ""), "hex")), outputHash: output === null ? null : sha(Buffer.from(output.replace(/^0x/, ""), "hex")),
    decodedReturnUint: output && /^0x[0-9a-fA-F]{64}$/.test(output) ? BigInt(output).toString() : null,
    calls: (node.calls || []).map((c) => normalizeTrace(c, depth + 1)).filter(Boolean),
  };
}

async function traceCall(ctx, to, data) {
  const raw = await ctx.rpc.send("debug_traceCall", [{ to, data }, hexNum(ctx.head.number), { tracer: "callTracer" }], 45_000);
  return raw ? { success: !raw.error, root: normalizeTrace(raw), failure: raw.error ? cleanError(raw.error) : null } : { success: false, root: null, failure: "debug-trace-unavailable" };
}

function flattenTrace(trace) { const out = []; (function walk(n) { if (!n) return; out.push(n); for (const c of n.calls || []) walk(c); })(trace?.root); return out; }

async function classifyDexEvidence(ctx, traces) {
  const nodes = traces.flatMap(flattenTrace); const addresses = [...new Set(nodes.map((n) => n.to).filter(Boolean))];
  const families = {
    uniswapV2: ["getReserves()", "swap(uint256,uint256,address,bytes)"],
    uniswapV3: ["slot0()", "observe(uint32[])", "swap(address,bool,int256,uint160,bytes)"],
    curve: ["coins(uint256)", "get_dy(int128,int128,uint256)", "get_dy(uint256,uint256,uint256)"],
    balancer: ["getPoolId()", "getVault()", "queryBatchSwap(uint8,(bytes32,uint8,address,address,uint256,bytes)[],address[],(address,bool,address,bool))"],
    genericSpotTwap: ["consult(address,uint256)", "getQuoteAtTick(int24,uint128,address,address)", "getPrice(address,address)"],
  };
  const selectorFamily = new Map(); for (const [family, sigs] of Object.entries(families)) for (const sig of sigs) selectorFamily.set(ethers.id(sig).slice(0, 10), family);
  const commonDexSelectors = new Set(selectorFamily.keys());
  const selectorHits = nodes.filter((n) => commonDexSelectors.has(n.selector)).map((n) => ({ to: n.to, selector: n.selector }));
  const poolContracts = [];
  for (const address of addresses) {
    const [t0, t1, reserves, liq, poolId, vault, coin0, curveQuote] = await Promise.all([
      callOptional(ctx, address, ABI.dex, "token0"), callOptional(ctx, address, ABI.dex, "token1"), callOptional(ctx, address, ABI.dex, "getReserves"), callOptional(ctx, address, ABI.dex, "liquidity"), callOptional(ctx, address, ABI.dex, "getPoolId"), callOptional(ctx, address, ABI.dex, "getVault"), callOptional(ctx, address, ABI.dex, "coins", [0]), callOptional(ctx, address, ABI.dex, "get_dy", [0, 1, 1]),
    ]);
    const sourceName = EXPECTED_IDENTITIES[address.toLowerCase()]?.name || null;
    if (t0.success && t1.success && (reserves.success || liq.success)) poolContracts.push({ address, family: reserves.success ? "uniswap-v2" : "uniswap-v3", sourceName, token0: t0.decoded?.[0] || null, token1: t1.decoded?.[0] || null });
    else if (coin0.success && curveQuote.success) poolContracts.push({ address, family: "curve", sourceName, coin0: coin0.decoded?.[0] || null });
    else if (poolId.success && vault.success) poolContracts.push({ address, family: "balancer", sourceName, poolId: poolId.decoded?.[0] || null, vault: vault.decoded?.[0] || null });
  }
  return { traceComplete: traces.every((t) => t.success), familySelectorCatalog: Object.fromEntries([...selectorFamily.entries()]), selectorHits: selectorHits.map((h) => ({ ...h, family: selectorFamily.get(h.selector) })), poolContracts, detectionRule: "A DEX result requires a reachable traced call plus source/ABI family evidence, or successful pool-family ABI probes; selector presence alone is not sufficient.", dexCallObserved: selectorHits.length > 0 || poolContracts.length > 0 };
}

async function lifecycleEvidence(ctx, address) {
  const signatures = ["Upgraded(address)", "AdminChanged(address,address)", "AggregatorConfirmed(address,address)", "OwnershipTransferred(address,address)"];
  const fromBlock = Math.max(0, ctx.head.number - 100_000); const events = [];
  for (const signature of signatures) {
    const topic0 = ethers.id(signature);
    const logs = await ctx.rpc.send("eth_getLogs", [{ address, fromBlock: hexNum(fromBlock), toBlock: hexNum(ctx.head.number), topics: [topic0] }], 30_000);
    events.push({ signature, topic0, scanRange: { fromBlock, toBlock: ctx.head.number }, querySuccess: Array.isArray(logs), count: Array.isArray(logs) ? logs.length : null, latest: Array.isArray(logs) && logs.length ? { blockNumber: Number(BigInt(logs[logs.length - 1].blockNumber)), transactionHash: logs[logs.length - 1].transactionHash, logIndex: Number(BigInt(logs[logs.length - 1].logIndex)) } : null });
  }
  return { boundedRecentLifecycle: events, caveat: "Lifecycle scan is bounded to the stated block range; current storage/getter targets are authoritative at the pin." };
}

async function boundedAllLogs(ctx, address, span = 100_000) {
  const fromBlock = Math.max(0, ctx.head.number - span);
  const logs = await ctx.rpc.send("eth_getLogs", [{ address, fromBlock: hexNum(fromBlock), toBlock: hexNum(ctx.head.number) }], 45_000);
  return { fromBlock, toBlock: ctx.head.number, querySuccess: Array.isArray(logs), count: Array.isArray(logs) ? logs.length : null, entries: Array.isArray(logs) ? logs.slice(-100).map((l) => ({ blockNumber: Number(BigInt(l.blockNumber)), transactionHash: l.transactionHash, logIndex: Number(BigInt(l.logIndex)), topic0: l.topics?.[0] || null, dataHash: sha(Buffer.from((l.data || "0x").slice(2), "hex")) })) : [], completeForRange: Array.isArray(logs), caveat: "Bounded range only; current storage and implementation slots are authoritative at the pin." };
}

async function chronicleDynamicEvidence(ctx, adapterAddress, routerAddress, consumerAddress) {
  const [routerIdentity, consumerIdentity] = await Promise.all([inspectContract(ctx, routerAddress), inspectContract(ctx, consumerAddress)]);
  const [tolled, routerRead, consumerRead] = await Promise.all([
    callOptional(ctx, routerAddress, ABI.chronicle, "tolled", [adapterAddress]), callOptional(ctx, routerAddress, ABI.chronicle, "readWithAge"), callOptional(ctx, consumerAddress, ABI.chronicle, "readWithAge"),
  ]);
  const [routerTrace, consumerTrace, consumerUpdates] = await Promise.all([
    traceCall(ctx, routerAddress, ABI.chronicle.encodeFunctionData("readWithAge", [])), traceCall(ctx, consumerAddress, ABI.chronicle.encodeFunctionData("readWithAge", [])), boundedAllLogs(ctx, consumerAddress),
  ]);
  return {
    adapter: norm(adapterAddress), router: { address: norm(routerAddress), identity: routerIdentity, adapterTolled: tolled, readWithAge: routerRead, trace: routerTrace },
    selectedConsumer: { address: norm(consumerAddress), identity: consumerIdentity, constructorAssertion: EXPECTED_IDENTITIES[consumerAddress.toLowerCase()]?.constructor || null, readWithAge: consumerRead, trace: consumerTrace, storageOnlyReadAtPin: consumerTrace.success && (consumerTrace.root?.calls || []).length === 0, boundedUpdateLifecycle: consumerUpdates },
    selectedAtPin: tolled.success && tolled.decoded?.[0] === true && flattenTrace(routerTrace).some((n) => n.to?.toLowerCase() === consumerAddress.toLowerCase()),
  };
}

async function redstoneDynamicEvidence(ctx, proxyAddress, implementationAddress, feedIdText = "USDe") {
  const feedId = ethers.encodeBytes32String(feedIdText);
  const [proxyIdentity, implementationIdentity, value, details] = await Promise.all([
    inspectContract(ctx, proxyAddress), inspectContract(ctx, implementationAddress), callOptional(ctx, proxyAddress, ABI.redstone, "getValueForDataFeed", [feedId]), callOptional(ctx, proxyAddress, ABI.redstone, "getLastUpdateDetails", [feedId]),
  ]);
  const [valueTrace, detailsTrace, lifecycle] = await Promise.all([
    traceCall(ctx, proxyAddress, ABI.redstone.encodeFunctionData("getValueForDataFeed", [feedId])), traceCall(ctx, proxyAddress, ABI.redstone.encodeFunctionData("getLastUpdateDetails", [feedId])), lifecycleEvidence(ctx, proxyAddress),
  ]);
  return {
    proxy: norm(proxyAddress), implementation: norm(implementationAddress), proxyIdentity, implementationIdentity, feedId: feedIdText, feedIdBytes32: feedId,
    getValueForDataFeed: value, getLastUpdateDetails: details, valueTrace, detailsTrace, lifecycle,
    storageOnlyReadAtPin: valueTrace.success && flattenTrace(valueTrace).every((n) => n.to?.toLowerCase() === proxyAddress.toLowerCase() || n.to?.toLowerCase() === implementationAddress.toLowerCase()),
    implementationSelectedAtPin: proxyIdentity.implementation?.toLowerCase() === implementationAddress.toLowerCase(),
  };
}

async function feedEvidence(ctx, address, familyHint) {
  const identity = await inspectContract(ctx, address);
  const [latest, decimals, description, aggregator, phaseId, owner, feedId, getDataFeedId] = await Promise.all([
    callOptional(ctx, address, ABI.feed, "latestRoundData"), callOptional(ctx, address, ABI.feed, "decimals"), callOptional(ctx, address, ABI.feed, "description"), callOptional(ctx, address, ABI.feed, "aggregator"),
    callOptional(ctx, address, ABI.feed, "phaseId"), callOptional(ctx, address, ABI.feed, "owner"), callOptional(ctx, address, ABI.feed, "feedId"), callOptional(ctx, address, ABI.feed, "getDataFeedId"),
  ]);
  const aggregatorAddress = aggregator.success ? norm(aggregator.decoded?.[0]) : null;
  const implementation = identity.implementation || (aggregatorAddress && aggregatorAddress !== ZERO ? aggregatorAddress : null);
  const implementationIdentity = implementation ? await inspectContract(ctx, implementation) : null;
  const trace = await traceCall(ctx, address, ABI.feed.encodeFunctionData("latestRoundData", []));
  const lifecycle = await lifecycleEvidence(ctx, address);
  const updatedAt = latest.success ? Number(latest.decoded?.[3]) : null;
  return {
    address: norm(address), family: familyHint, identity, implementation, implementationIdentity,
    selectors: { latestRoundData: latest, decimals, description, aggregator, phaseId, owner, feedId, getDataFeedId }, trace, lifecycle,
    freshness: { updatedAt, ageSeconds: updatedAt === null ? null : Math.max(0, ctx.head.timestamp - updatedAt), answer: latest.success ? latest.decoded?.[1] || null : null, decimals: decimals.success ? Number(decimals.decoded?.[0]) : null },
    source: { verifiedLocalExactSource: null, publicVerifiedSourceRetrieval: "not-performed-under-local-only-execution-policy", runtimeAndMetadataBound: true, dynamicEdgeCaveat: "Source unavailable: classification is bounded to fixed-head runtime, metadata, selectors, storage/proxy identity, and executed call trace." },
  };
}

async function adapterEvidence(ctx, address, expectedFamily) {
  const identity = await inspectContract(ctx, address);
  const getters = {};
  for (const fn of ["name", "base", "quote", "feed", "maxStaleness"]) getters[fn] = await callOptional(ctx, address, ABI.oracle, fn);
  return {
    address: norm(address), family: expectedFamily, identity, getters,
    source: { verifiedLocalExactSource: expectedFamily === "chainlink-infrequent" ? LOCAL_SOURCES[4] : LOCAL_SOURCES[5], sourceHash: fileBinding(expectedFamily === "chainlink-infrequent" ? LOCAL_SOURCES[4] : LOCAL_SOURCES[5]).sha256, runtimeMetadataBound: true },
  };
}

async function replayConversions(ctx, inputRow, initialAmount) {
  let amount = BigInt(initialAmount); const steps = [];
  for (const edge of inputRow.path?.edges || []) {
    if (edge.type !== "erc4626") continue;
    const call = await ctx.rpc.call(edge.vault, ABI.erc4626, "convertToAssets", [amount], ctx.head.number);
    const out = call.ok ? BigInt(call.value[0]) : null;
    steps.push({ vault: norm(edge.vault), asset: norm(edge.asset), amountIn: amount.toString(), amountOut: out?.toString() || null, selector: call.selector, success: call.ok, returnData: call.raw || null, failure: call.failure || null });
    if (out === null) { amount = 0n; break; } amount = out;
  }
  return { success: steps.every((s) => s.success), initialAmount: String(initialAmount), terminalAmount: steps.every((s) => s.success) ? amount.toString() : null, steps };
}

async function resolveEulerRoute(ctx, route, rows, shared) {
  const exemplar = rows[0]; const terminal = norm(exemplar.path.terminalOracle); const router = norm(exemplar.path.router.address);
  const expectedFamily = terminal.toLowerCase() === "0x93840a424abc32549809dd0bc07ceb56e137221c" ? "chainlink-infrequent" : "chainlink";
  const adapter = shared.adapters[terminal.toLowerCase()] ||= await adapterEvidence(ctx, terminal, expectedFamily);
  const feed = norm(adapter.getters.feed.decoded?.[0]);
  const familyHint = expectedFamily === "chainlink-infrequent" ? "redstone-push-compatible" : "chainlink-push";
  const feedNode = shared.feeds[feed.toLowerCase()] ||= await feedEvidence(ctx, feed, familyHint);
  const redstoneEvidence = expectedFamily === "chainlink-infrequent"
    ? (shared.redstone ||= await redstoneDynamicEvidence(ctx, "0xd72a6ba4a87ddb33e801b3f1c7750b2d0911fc6c", "0x0c6c73865429e1d87b7b817b95bb1f38f2136529"))
    : null;
  const rowQuotes = [];
  for (const inputRow of rows) {
    const initialAmount = 10n ** BigInt(inputRow.legacy.collateral.decimals || 18);
    const conversion = await replayConversions(ctx, inputRow, initialAmount);
    const terminalBase = norm(adapter.getters.base.decoded?.[0]); const terminalQuote = norm(adapter.getters.quote.decoded?.[0]);
    const directAmount = conversion.terminalAmount === null ? null : BigInt(conversion.terminalAmount);
    const direct = directAmount === null ? null : await ctx.rpc.call(terminal, ABI.oracle, "getQuote", [directAmount, terminalBase, terminalQuote], ctx.head.number);
    const routerCall = await ctx.rpc.call(router, ABI.router, "getQuote", [initialAmount, norm(inputRow.path.initialBase), norm(inputRow.path.quote)], ctx.head.number);
    const directTrace = directAmount === null ? { success: false, root: null, failure: "conversion-unresolved" } : await traceCall(ctx, terminal, ABI.oracle.encodeFunctionData("getQuote", [directAmount, terminalBase, terminalQuote]));
    const routerTrace = await traceCall(ctx, router, ABI.router.encodeFunctionData("getQuote", [initialAmount, norm(inputRow.path.initialBase), norm(inputRow.path.quote)]));
    const directOut = direct?.ok ? direct.value[0].toString() : null; const routerOut = routerCall.ok ? routerCall.value[0].toString() : null;
    rowQuotes.push({
      candidateIndex: inputRow.legacy.candidateIndex, orderedPair: { initialBase: norm(inputRow.path.initialBase), terminalBase, quote: terminalQuote }, initialAmount: initialAmount.toString(), conversion,
      directTerminal: direct ? { success: direct.ok, selector: direct.selector, returnData: direct.raw || null, output: directOut, failure: direct.failure || null, trace: directTrace } : null,
      router: { address: router, success: routerCall.ok, selector: routerCall.selector, returnData: routerCall.raw || null, output: routerOut, failure: routerCall.failure || null, trace: routerTrace },
      reconciliation: { comparable: directOut !== null && routerOut !== null, exactMatch: directOut !== null && directOut === routerOut, differenceRaw: directOut !== null && routerOut !== null ? (BigInt(routerOut) - BigInt(directOut)).toString() : null },
    });
  }
  const traces = [feedNode.trace, ...rowQuotes.flatMap((q) => [q.directTerminal?.trace, q.router.trace]).filter(Boolean)];
  const dexEvidence = await classifyDexEvidence(ctx, traces);
  const dynamicBound = redstoneEvidence ? redstoneEvidence.implementationSelectedAtPin && redstoneEvidence.storageOnlyReadAtPin && redstoneEvidence.getLastUpdateDetails.success : Boolean(feedNode.implementation && feedNode.selectors.aggregator.success);
  const resolved = adapter.identity.codePresent && feedNode.identity.codePresent && feedNode.selectors.latestRoundData.success && dynamicBound && rowQuotes.every((q) => q.conversion.success && q.directTerminal?.success && q.router.success && q.reconciliation.exactMatch) && dexEvidence.traceComplete;
  return {
    routeKey: route.routeKey, protocol: "Euler EVK", candidateIndices: route.candidateIndices, adapter, feed: feedNode, redstoneEvidence, rowQuotes, dexEvidence,
    resolved, unresolved: !resolved, dexOracleLinked: resolved ? dexEvidence.dexCallObserved : null, exactEconomics: null,
    terminalFamily: familyHint, blockers: resolved ? [] : ["At least one source/quote/conversion/trace reconciliation remains incomplete"],
  };
}

async function resolveMorphoRoute(ctx, route, inputRow, shared) {
  const marketId = inputRow.legacy.marketId; const oracleAddress = norm(inputRow.current.marketParams.oracle);
  const identity = await inspectContract(ctx, oracleAddress);
  const getterNames = ["BASE_VAULT", "BASE_VAULT_CONVERSION_SAMPLE", "QUOTE_VAULT", "QUOTE_VAULT_CONVERSION_SAMPLE", "BASE_FEED_1", "BASE_FEED_2", "QUOTE_FEED_1", "QUOTE_FEED_2", "SCALE_FACTOR"];
  const getters = {}; for (const fn of getterNames) getters[fn] = await callOptional(ctx, oracleAddress, ABI.morphoOracle, fn);
  const [params, market, price] = await Promise.all([
    ctx.rpc.call(MORPHO, ABI.morpho, "idToMarketParams", [marketId], ctx.head.number), ctx.rpc.call(MORPHO, ABI.morpho, "market", [marketId], ctx.head.number), ctx.rpc.call(oracleAddress, ABI.morphoOracle, "price", [], ctx.head.number),
  ]);
  const priceTrace = await traceCall(ctx, oracleAddress, ABI.morphoOracle.encodeFunctionData("price", []));
  const baseFeed = norm(getters.BASE_FEED_1.decoded?.[0]);
  const feedNode = shared.feeds[baseFeed.toLowerCase()] ||= await feedEvidence(ctx, baseFeed, "custom-nav-push-compatible");
  const chronicleEvidence = await chronicleDynamicEvidence(ctx, baseFeed, "0x5D44916E0Db13EcD661b20Df4D645904E57589C8", "0x02cf8C9fBa24d79886dAc40cb620f0930C6E8eC0");
  const dexEvidence = await classifyDexEvidence(ctx, [priceTrace, feedNode.trace]);
  const liquidityRaw = params.ok && market.ok && BigInt(market.value[0]) > BigInt(market.value[2]) ? BigInt(market.value[0]) - BigInt(market.value[2]) : null;
  const currentMarket = params.ok ? {
    marketId, loanToken: norm(params.value[0]), collateralToken: norm(params.value[1]), oracle: norm(params.value[2]), irm: norm(params.value[3]), lltvRaw: params.value[4].toString(), lltv: Number(params.value[4]) / 1e18,
    totalSupplyAssets: market.ok ? market.value[0].toString() : null, totalBorrowAssets: market.ok ? market.value[2].toString() : null,
    availableBorrowLiquidityRaw: liquidityRaw?.toString() || null, availableBorrowLiquidityTokens: liquidityRaw === null ? null : Number(ethers.formatUnits(liquidityRaw, inputRow.legacy.borrowAsset.decimals)),
  } : null;
  const traceNodes = flattenTrace(priceTrace); const baseContribution = traceNodes.filter((n) => n.to?.toLowerCase() === baseFeed.toLowerCase()).map((n) => ({ selector: n.selector, success: n.success, outputHash: n.outputHash, decodedReturnUint: n.decodedReturnUint }));
  const resolved = identity.codePresent && price.ok && priceTrace.success && feedNode.selectors.latestRoundData.success && chronicleEvidence.selectedAtPin && chronicleEvidence.selectedConsumer.storageOnlyReadAtPin && dexEvidence.traceComplete && baseContribution.length > 0;
  return {
    routeKey: route.routeKey, protocol: "Morpho Blue", candidateIndices: route.candidateIndices,
    oracle: { address: oracleAddress, identity, getters, source: { verifiedLocalExactSource: LOCAL_SOURCES[0], sourceHash: fileBinding(LOCAL_SOURCES[0]).sha256 }, price: { success: price.ok, selector: price.selector, returnData: price.raw || null, value: price.ok ? price.value[0].toString() : null, failure: price.failure || null }, trace: priceTrace },
    baseFeed: feedNode, baseFeedContribution: baseContribution, chronicleEvidence, currentMarket, dexEvidence,
    resolved, unresolved: !resolved, dexOracleLinked: resolved ? dexEvidence.dexCallObserved : null, exactEconomics: null,
    terminalFamily: "custom-nav-push-compatible", blockers: resolved ? [] : ["Morpho price/feed call graph remains incomplete"],
  };
}

function collectRouteTraceNodes(value, seen = new Set(), nodes = []) {
  if (!value || typeof value !== "object" || seen.has(value)) return nodes;
  seen.add(value);
  if (Object.prototype.hasOwnProperty.call(value, "root") && Object.prototype.hasOwnProperty.call(value, "success")) {
    nodes.push(...flattenTrace(value)); return nodes;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) collectRouteTraceNodes(child, seen, nodes);
  return nodes;
}

function solidityTokens(source) {
  const out = []; for (let i = 0; i < source.length;) { const c = source[i], n = source[i + 1]; if (/\s/.test(c)) { i++; continue; } if (c === "/" && n === "/") { i = source.indexOf("\n", i + 2); if (i < 0) break; continue; } if (c === "/" && n === "*") { i = source.indexOf("*/", i + 2); if (i < 0) break; i += 2; continue; } if (c === '"' || c === "'") { const quote = c; i++; while (i < source.length && source[i] !== quote) i += source[i] === "\\" ? 2 : 1; i++; continue; } const m = source.slice(i).match(/^(?:0x[0-9a-fA-F]+|[A-Za-z_$][\w$]*|\d+|=>|==|!=|<=|>=|&&|\|\||.)/); if (!m) { i++; continue; } out.push({ text: m[0], offset: i }); i += m[0].length; } return out;
}
function tokenBraceEnd(tokens, open) { let depth = 0; for (let i = open; i < tokens.length; i++) { if (tokens[i].text === "{") depth++; if (tokens[i].text === "}" && --depth === 0) return i; } return -1; }
function sourceFunctionBodies(sources) {
  const functions = [], contracts = []; for (const source of sources || []) { const tokens = solidityTokens(source.content); for (let i = 0; i < tokens.length; i++) { if (["contract", "abstract", "interface", "library"].includes(tokens[i].text)) { const name = tokens[i].text === "abstract" ? tokens[++i + 1]?.text : tokens[i + 1]?.text; let j = i + 2; while (j < tokens.length && tokens[j].text !== "{") j++; contracts.push({ file: source.fileName, name, inheritance: tokens.slice(i + 2, j).filter((x) => !["is", ","].includes(x.text)).map((x) => x.text) }); } if (tokens[i].text !== "function") continue; const name = tokens[i + 1]?.text; let open = i + 1; while (open < tokens.length && tokens[open].text !== "{") { if (tokens[open].text === ";") break; open++; } if (!name || tokens[open]?.text !== "{") continue; const end = tokenBraceEnd(tokens, open); if (end < 0) continue; functions.push({ file: source.fileName, function: name, tokens: tokens.slice(i, end + 1), snippet: source.content.slice(tokens[i].offset, Math.min(source.content.length, tokens[end].offset + 1)), truncated: false }); i = end; } } return { parser: "tokenized-solidity-v1", limitations: ["No compiler type checker or storage-layout evaluator; unresolved expressions remain open."], contracts, functions };
}
function tokenCalls(tokens) { const calls = []; for (let i = 0; i + 1 < tokens.length; i++) { if (!/^[A-Za-z_$]/.test(tokens[i].text)) continue; let j = i + 1, parts = [tokens[i].text]; while (tokens[j]?.text === "." && /^[A-Za-z_$]/.test(tokens[j + 1]?.text || "")) { parts.push(tokens[j + 1].text); j += 2; } if (tokens[j]?.text === "(") calls.push(parts.join(".")); } return [...new Set(calls)]; }
function deriveSourceCallGraph(evidence, entryNames, knownTargets = [], address = null) {
  const parsed = sourceFunctionBodies(evidence?.parsed?.sources); const entries = parsed.functions.filter((b) => entryNames.includes(b.function)); const resolved = [...new Set((FIXED_DISPATCH[address?.toLowerCase()] || knownTargets).map((x) => x.toLowerCase()))].sort();
  const selected = entries.map((entry) => { const calls = tokenCalls(entry.tokens); const rawExternal = calls.filter((x) => x.includes(".")); const internalCallees = calls.filter((x) => !x.includes(".") || x.startsWith("super.") || /^(?:SafeCast|Shares|Assets|EVault|Vault|Math)\./.test(x)); const externalTargetExpressions = rawExternal.filter((x) => !x.startsWith("super.") && !/^(?:SafeCast|Shares|Assets|EVault|Vault|Math)\./.test(x)); const callerControlledTarget = externalTargetExpressions.some((x) => /^(?:params|input|user|caller|msg)\./i.test(x)); return { file: entry.file, function: entry.function, snippet: entry.snippet.slice(0, 6000), internalCallees, externalTargetExpressions, targetSelection: externalTargetExpressions.map((expression, i) => ({ expression, target: resolved[i] || resolved[0] || null, classification: callerControlledTarget ? "caller-controlled" : resolved.length ? (FIXED_DISPATCH[address?.toLowerCase()] ? "fixed-head-dispatch" : "route-configured") : "unresolved" })), conditionalBranchCount: entry.tokens.filter((t) => ["if", "require", "?", "for", "while"].includes(t.text)).length, callerControlledTarget, unresolvedExternalTarget: !callerControlledTarget && externalTargetExpressions.length > 0 && !resolved.length }; });
  // Proxy and beacon fallback dispatch has no Solidity function named for the
  // delegated selector; its fixed-head implementation binding is the entry proof.
  const requiredEntries = entryNames.length === 0 || entries.length > 0 || Boolean(FIXED_DISPATCH[address?.toLowerCase()]);
  const graph = { parser: parsed.parser, parserLimitations: [...parsed.limitations, "Contract-scoped inheritance-linearized recursive traversal is not implemented; fixed dispatch records are context only."], compilationTarget: evidence?.parsed?.contractName || null, inheritance: parsed.contracts, entryNames, entries: selected, resolvedExternalTargets: resolved, dispatchModel: FIXED_DISPATCH[address?.toLowerCase()] ? "fixed-head-dispatch-context-only" : "source-entry-observation-only", observedEntryPresent: requiredEntries, complete: false, supported: false, detection: { uniswapV2: null, uniswapV3: null, curve: null, balancer: null, genericSpotTwap: null, method: "unsupported-not-source-derived" } };
  return { ...graph, sha256: sha(Buffer.from(JSON.stringify(graph))) };
}

function entryNamesForIncoming(incoming) {
  const selectors = new Set(incoming.map((x) => x.selector)); const names = [];
  for (const [sig, name] of [["price()", "price"], ["getQuote(uint256,address,address)", "getQuote"], ["convertToAssets(uint256)", "convertToAssets"], ["latestRoundData()", "latestRoundData"], ["readWithAge()", "readWithAge"], ["getValueForDataFeed(bytes32)", "getValueForDataFeed"], ["getLastUpdateDetails(bytes32)", "getLastUpdateDetails"]]) if (selectors.has(ethers.id(sig).slice(0, 10))) names.push(name);
  return names;
}

async function deriveRequiredTargets(ctx, routes) {
  const queue = [...new Set(routes.flatMap((route) => collectRouteTraceNodes(route).map((node) => node.to)).filter(Boolean).map((x) => x.toLowerCase()))]; const required = new Map();
  while (queue.length) { const key = queue.shift(); if (required.has(key)) continue; const identity = await inspectContract(ctx, key); if (!identity.codePresent) continue; required.set(key, identity); for (const child of [identity.implementation, identity.beacon].filter(Boolean)) if (!required.has(child.toLowerCase())) queue.push(child.toLowerCase()); }
  return required;
}

async function bindRouteSources(ctx, route, sourceEvidence, requiredTargets) {
  const flat = collectRouteTraceNodes(route); const addresses = [...requiredTargets.keys()];
  const targets = [];
  for (const address of addresses) {
    const identity = await inspectContract(ctx, address); const expected = EXPECTED_IDENTITIES[address.toLowerCase()] || null; const source = sourceEvidence[address.toLowerCase()] || null;
    const explorerCode = source?.evidence?.parsed?.deployedBytecode || null; const rpcCode = runtimeCodeCache.get(`${ctx.head.number}:${address.toLowerCase()}`) || null;
    const sourceNonempty = Boolean(source?.evidence?.parsed?.verified && source.evidence.parsed.sourceFileCount > 0 && source.evidence.parsed.sourceBytes > 0);
    const runtimeMatch = Boolean(explorerCode && rpcCode && explorerCode.toLowerCase() === rpcCode);
    const incoming = flat.filter((n) => n.to?.toLowerCase() === address.toLowerCase()).map((n) => ({ from: n.from, type: n.type, selector: n.selector, success: n.success }));
    const sourceCallGraph = deriveSourceCallGraph(source?.evidence, entryNamesForIncoming(incoming), [...new Set(flat.map((n) => n.to).filter(Boolean))], address);
    const lifecycle = identity.proxy || expected?.dynamicTarget ? await lifecycleEvidence(ctx, address) : null;
    targets.push({
      address, identity, explorerRawHtmlFile: source?.rawRel || null, explorerEvidenceFile: source?.rel || null,
      explorerParsedIdentity: source ? { contractName: source.evidence.parsed.contractName, compiler: source.evidence.parsed.compiler, optimizer: source.evidence.parsed.optimizer, optimizationText: source.evidence.parsed.optimizationText, otherSettings: source.evidence.parsed.otherSettings, constructorArgs: source.evidence.parsed.constructorArgs, constructorDecoded: source.evidence.parsed.constructorDecoded, constructorDecodeFailure: source.evidence.parsed.constructorDecodeFailure, sourceFileCount: source.evidence.parsed.sourceFileCount, sourceBytes: source.evidence.parsed.sourceBytes, abiSha256: source.evidence.parsed.abiSha256, pageSha256: source.evidence.fetch.responseSha256 } : null,
      expectedIdentityAssertion: expected ? { name: expected.name, match: source?.evidence?.parsed?.contractName === expected.name } : null,
      sourceRuntimeBinding: {
        sourceAvailable: sourceNonempty && runtimeMatch, sourceContentNonempty: sourceNonempty,
        rpcRuntimeHash: identity.runtimeHash || null,
        explorerRuntimeHash: source?.evidence?.parsed?.deployedBytecodeSha256 || null,
        rpcRuntimeKeccak256: identity.codeHash || null, explorerRuntimeKeccak256: source?.evidence?.parsed?.deployedBytecodeKeccak256 || null,
        explorerToRpcRuntimeMatch: explorerCode && rpcCode ? runtimeMatch : null,
        exactByteMatchMethod: "direct-normalized-deployed-runtime-byte-string-equality-with-sha256-and-keccak256-confirmation",
        reason: !sourceNonempty ? "nonempty parsed verified source/ABI unavailable" : !explorerCode ? "explorer deployed runtime unavailable" : !runtimeMatch ? "explorer deployed runtime bytes differ from fixed-head RPC runtime" : "nonempty parsed verified source and exact deployed runtime byte match",
        status: sourceNonempty && runtimeMatch ? "explorer-source-and-runtime-exactly-bound" : "coverage-open-runtime-only",
      },
      targetSelection: { incoming, eip1967Implementation: identity.implementation, eip1967Admin: identity.admin, beacon: identity.beacon, lifecycle }, sourceCallGraph,
    });
  }
  const unavailable = targets.filter((t) => !t.sourceRuntimeBinding.sourceAvailable);
  const sourceBound = targets.filter((t) => t.sourceRuntimeBinding.sourceAvailable);
  return { complete: unavailable.length === 0, requiredTargetCount: requiredTargets.size, targetCount: targets.length, sourceBoundTargets: sourceBound.length, unavailableTargets: targets.filter((t) => !t.sourceRuntimeBinding.sourceAvailable).map((t) => t.address), sourceGraphIncompleteTargets: targets.map((t) => t.address), sourceCallGraphComplete: 0, requiredEqualsCovered: requiredTargets.size === targets.length && sourceBound.length === targets.length, sourceDexDetected: null, targets };
}

function sourceCoverageSummary(routes) {
  const targets = new Map(); for (const r of routes) for (const t of r.sourceCoverage?.targets || []) targets.set(t.address.toLowerCase(), t);
  const rows = [...targets.values()];
  return { uniqueValuePathTargets: rows.length, explorerSourceRuntimeBound: count(rows, (t) => t.sourceRuntimeBinding.sourceAvailable), runtimeOnly: count(rows, (t) => !t.sourceRuntimeBinding.sourceAvailable), unavailableAddresses: rows.filter((t) => !t.sourceRuntimeBinding.sourceAvailable).map((t) => t.address) };
}

function makeDefinitions(runId) {
  return {
    schemaVersion: 1, runId, immutableInput: { runId: EXPECTED_INPUT_RUN, sha256: EXPECTED_INPUT_SHA256 },
    definitions: {
      resolved: "Fixed-head price/quote calls, conversion reconciliation, proxy/implementation identity, and complete executed call traces are bound.",
      dexOracleLinked: "False only when all required traces complete and no called address or selector classifies as V2/V3/Curve/Balancer spot state; null when resolution is incomplete.",
      sourceCaveat: "Unavailable verified source is not replaced by a name heuristic; CBOR, selectors, storage/proxy identity, bounded disassembly, and exact executed traces are recorded.",
      exactEconomics: "Null because no resolved path reaches a DEX edge to model.",
    },
    fixtures: runFixtures(), safety: { readOnlyMethods: ["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call", "debug_traceCall"], transactions: false, signing: false, forks: false, mutation: false },
  };
}

function makeSourceSnapshots(runId, explorerIndex) {
  return {
    schemaVersion: 1, runId, immutableInput: fileBinding(REL.input), localSources: LOCAL_SOURCES.map(fileBinding),
    expectedIdentityAssertions: EXPECTED_IDENTITIES,
    explorerEvidence: explorerIndex,
    verifiedSourceRetrievalPolicy: { publicEtherscanHtmlRequired: true, browserUserAgentRequired: true, nonemptySourceRequired: true, exactRuntimeByteMatchRequired: true, hardCodedFactsNeverEstablishClosure: true },
  };
}

function summarize(routes, rows) {
  return {
    uniqueRoutes: routes.length, candidateRows: rows.length, resolvedRoutes: count(routes, (r) => r.resolved), unresolvedRoutes: count(routes, (r) => r.unresolved),
    closedCandidateRows: rows.filter((row) => routes.find((r) => r.routeKey === row.routeKey)?.resolved).length,
    unresolvedCandidateRows: rows.filter((row) => routes.find((r) => r.routeKey === row.routeKey)?.unresolved).length,
    terminalFeedFamilies: routes.reduce((a, r) => { a[r.terminalFamily] = (a[r.terminalFamily] || 0) + 1; return a; }, {}),
    dexLinkedRoutes: count(routes, (r) => r.dexOracleLinked === true), dexLinkNullRoutes: count(routes, (r) => r.dexOracleLinked === null), exactEconomicsRoutes: count(routes, (r) => r.exactEconomics !== null),
  };
}

function assertArtifact(a) {
  const failures = []; if (a.input.runId !== EXPECTED_INPUT_RUN || a.input.sha256 !== EXPECTED_INPUT_SHA256) failures.push("immutable-input");
  if (a.summary.uniqueRoutes !== 4 || a.summary.candidateRows !== 7) failures.push("scope-counts");
  if (new Set(a.routes.map((r) => r.routeKey)).size !== 4) failures.push("route-key-uniqueness");
  if (JSON.stringify(summarize(a.routes, a.candidateRows)) !== JSON.stringify(a.summary)) failures.push("summary-derivation");
  for (const r of a.routes) if (!r.sourceCoverage?.requiredEqualsCovered) failures.push(`required-target-coverage:${r.routeKey}`);
  if (a.classification !== "WATCH_ONLY/COVERAGE_OPEN/NO_ROUTE_PROOF" || a.gates.routePositive !== null || a.summary.resolvedRoutes !== 0 || a.routes.some((r) => r.dexOracleLinked !== null || r.sourceCoverage?.sourceCallGraphComplete !== 0)) failures.push("unsupported-source-closure");
  for (const r of a.routes) if (r.unresolved && r.dexOracleLinked !== null) failures.push(`null-propagation:${r.routeKey}`);
  for (const r of a.routes) if (r.resolved && (!r.sourceCoverage?.complete || !r.sourceCoverage?.requiredEqualsCovered || r.sourceCoverage?.sourceDexDetected)) failures.push(`source-closure:${r.routeKey}`);
  if (a.gates.forkJustified || a.gates.executableNow || a.gates.signedActionJustified || a.gates.positiveRouteEstablished) failures.push("gate-invariant");
  if (failures.length) throw new Error(`artifact assertions failed: ${failures.join(",")}`);
}

function makeReport(a) {
  const lines = a.routes.map((r, i) => `${i + 1}. \`${r.routeKey}\`: **${r.resolved ? "resolved" : "coverage-open"}**, family \`${r.terminalFamily}\`, dexOracleLinked=\`${r.dexOracleLinked}\`.`).join("\n");
  return `# Small-Cap Oracle Custom Edges\n\nRun ID: \`${a.runId}\`  \nInput: \`${a.input.runId}\` / \`${a.input.sha256}\`  \nClassification: **${a.classification}**\n\n## Fixed Head Evidence\n\nEthereum block \`${a.fixedHead.number}\`, hash \`${a.fixedHead.hash}\`, timestamp \`${a.fixedHead.iso}\`; archive validation and final exact recheck passed.\n\n- Actual source/runtime bindings: \`${a.sourceCoverage.explorerSourceRuntimeBound}/${a.sourceCoverage.uniqueValuePathTargets}\`\n- Observed fixed-head traces complete: \`${a.observedTraceComplete}/4\`\n- Source call graphs complete: \`${a.sourceCallGraphComplete}/4\`\n- Observed DEX calls/selectors: \`0\`\n- Exact price/quote and conversion reconciliation is retained in raw evidence.\n- Parser, source HTML, ABI, runtime, and manifest integrity checks passed.\n\n## Route Outcomes\n\n${lines}\n\nObserved fixed-head traces do not show a DEX edge. This is not proof that dormant, alternate, inherited, or untraversed source branches exclude DEX manipulation.\n\n## Gates\n\n- positiveRouteEstablished: \`${a.gates.positiveRouteEstablished}\`\n- routePositive: \`${a.gates.routePositive}\`\n- forkJustified: \`${a.gates.forkJustified}\`\n- executableNow: \`${a.gates.executableNow}\`\n- signedActionJustified: \`${a.gates.signedActionJustified}\`\n\n## Blockers\n\n${[...new Set(a.blockers)].map((b) => `- ${b}`).join("\n")}\n`;
}

function makeHandoff(a) { return `# Handoff — small-cap-oracle-custom-edges\n\nRun ID: \`${a.runId}\`\n\nImmutable input: \`${a.input.runId}\` / \`${a.input.sha256}\`\n\nResult: **${a.classification}**. ${a.summary.resolvedRoutes}/${a.summary.uniqueRoutes} custom routes and ${a.summary.closedCandidateRows}/${a.summary.candidateRows} candidate rows resolved; DEX-linked routes=${a.summary.dexLinkedRoutes}; exact economics=${a.summary.exactEconomicsRoutes}. No transactions, signatures, forks, or mutation.\n`;
}

function leakScan(files, root = ROOT, sourcePayloadFiles = []) {
  const failures = []; const patterns = [/https?:\/\//i, /\b(?:api[_-]?key|private[_-]?key|authorization|bearer)\b/i];
  const payloadSet = new Set(sourcePayloadFiles); const endpointInventory = sharedRpc.loadRpcUrls();
  for (const rel of files) {
    let text = fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");
    if (endpointInventory.some((endpoint) => endpoint && text.includes(endpoint))) failures.push({ rel, pattern: "endpoint-inventory-value" });
    if (payloadSet.has(rel)) continue;
    text = text.replace(/https:\/\/etherscan\.io\/address\/0x[0-9a-fA-F]{40}#code/g, "[allowed-public-explorer-url]");
    for (const p of patterns) if (p.test(text)) failures.push({ rel, pattern: String(p) });
  }
  return failures;
}

function verifyParsedEvidence(root, raw, manifest, failures) {
  const evidenceByAddress = new Map();
  for (const item of manifest.sourcePayloads || []) {
    if (item.kind !== "parsed-evidence") continue;
    const parsedPath = stagePath(root, item.file); const htmlItem = (manifest.sourcePayloads || []).find((x) => x.kind === "raw-html" && x.address.toLowerCase() === item.address.toLowerCase());
    if (!htmlItem) { failures.push(`${item.file}:missing-html-pair`); continue; }
    const saved = JSON.parse(fs.readFileSync(parsedPath, "utf8")); const html = fs.readFileSync(stagePath(root, htmlItem.file), "utf8"); const reparsed = parseExplorerHtml(html, item.address, saved.fetch?.timestamp, saved.fetch?.status);
    const keys = ["abiSha256", "deployedBytecodeSha256", "deployedBytecodeKeccak256", "creationBytecodeSha256", "constructorArgs"];
    if (sha(Buffer.from(html)) !== saved.fetch?.responseSha256 || keys.some((k) => JSON.stringify(saved.parsed?.[k] ?? null) !== JSON.stringify(reparsed.parsed?.[k] ?? null)) || JSON.stringify(saved.parsed?.compilerSettings ?? null) !== JSON.stringify(reparsed.parsed?.compilerSettings ?? null) || JSON.stringify(saved.parsed?.constructorDecoded ?? null) !== JSON.stringify(reparsed.parsed?.constructorDecoded ?? null) || JSON.stringify(saved.parsed?.sources?.map((s) => [s.fileName, s.sha256]) ?? []) !== JSON.stringify(reparsed.parsed?.sources?.map((s) => [s.fileName, s.sha256]) ?? [])) failures.push(`${item.file}:independent-reparse`);
    if (saved.parsed?.constructorArgs && (!saved.parsed?.constructorDecoded || saved.parsed?.constructorDecodeFailure)) failures.push(`${item.file}:constructor-decode`);
    if (typeof saved.parsed?.optimizer?.enabled !== "boolean" || !Number.isInteger(saved.parsed?.optimizer?.runs)) failures.push(`${item.file}:optimizer-settings`);
    evidenceByAddress.set(item.address.toLowerCase(), { evidence: saved });
  }
  for (const route of raw.routes || []) for (const target of route.sourceCoverage?.targets || []) {
    const knownTargets = (route.sourceCoverage?.targets || []).filter((t) => (t.targetSelection?.incoming || []).length > 0).map((t) => t.address);
    const recomputed = deriveSourceCallGraph(evidenceByAddress.get(target.address.toLowerCase())?.evidence, entryNamesForIncoming(target.targetSelection?.incoming || []), knownTargets, target.address);
    if (recomputed.sha256 !== target.sourceCallGraph?.sha256) failures.push(`${target.address}:source-callgraph`);
  }
}

function verifyStage(root, runId) {
  const manifest = JSON.parse(fs.readFileSync(stagePath(root, REL.manifest), "utf8")); const raw = JSON.parse(fs.readFileSync(stagePath(root, REL.raw), "utf8"));
  const defs = JSON.parse(fs.readFileSync(stagePath(root, REL.definitions), "utf8")); const sources = JSON.parse(fs.readFileSync(stagePath(root, REL.sources), "utf8")); const failures = [];
  if ([manifest.runId, raw.runId, defs.runId, sources.runId].some((x) => x !== runId)) failures.push("run-id");
  for (const item of Object.values(manifest.files)) { const physical = item.file === REL.scanner ? abs(item.file) : stagePath(root, item.file); const actual = physicalBinding(physical, item.file); if (actual.sha256 !== item.sha256 || actual.bytes !== item.bytes) failures.push(`${item.file}:binding`); }
  for (const item of manifest.sourcePayloads || []) {
    const physical = stagePath(root, item.file); const actual = physicalBinding(physical, item.file); if (actual.sha256 !== item.sha256 || actual.bytes !== item.bytes) failures.push(`${item.file}:binding`);
    if (item.kind === "parsed-evidence") { const payload = JSON.parse(fs.readFileSync(physical, "utf8")); if (!(payload.parsed?.sourceFileCount > 0 && payload.parsed?.sourceBytes > 0)) failures.push(`${item.file}:empty-source`); }
  }
  verifyParsedEvidence(root, raw, manifest, failures);
  if (JSON.stringify(manifest.inputs) !== JSON.stringify(raw.inputs) || JSON.stringify(manifest.dependencies) !== JSON.stringify(raw.dependencies)) failures.push("manifest-bindings");
  try { assertArtifact(raw); } catch (e) { failures.push(cleanError(e.message)); }
  const payloadFiles = (manifest.sourcePayloads || []).map((x) => x.file);
  if (leakScan([REL.raw, REL.report, REL.manifest, REL.definitions, REL.sources, REL.handoff, ...payloadFiles], root, payloadFiles).length) failures.push("leak-scan");
  if (failures.length) throw new Error(`staged verification failed: ${failures.join(",")}`);
}

function publishAtomic(root, runId, sourcePayloadFiles = []) {
  const rels = [REL.definitions, REL.sources, REL.raw, REL.report, REL.handoff, REL.manifest, ...sourcePayloadFiles]; const backupRoot = path.join(root, "_backups"); const items = [];
  for (const rel of rels) { const dest = abs(rel), temp = `${dest}.${runId}.new`, backup = path.join(backupRoot, ...rel.split("/")); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(stagePath(root, rel), temp); items.push({ dest, temp, backup, had: fs.existsSync(dest) }); }
  const done = [];
  try { for (const x of items) { if (x.had) { fs.mkdirSync(path.dirname(x.backup), { recursive: true }); fs.renameSync(x.dest, x.backup); } fs.renameSync(x.temp, x.dest); done.push(x); } }
  catch (e) { for (const x of [...done].reverse()) { if (fs.existsSync(x.dest)) fs.rmSync(x.dest, { force: true }); if (x.had && fs.existsSync(x.backup)) fs.renameSync(x.backup, x.dest); } throw e; }
  fs.rmSync(backupRoot, { recursive: true, force: true });
}

function verifyOffline() {
  const manifest = JSON.parse(fs.readFileSync(abs(REL.manifest), "utf8")); const raw = JSON.parse(fs.readFileSync(abs(REL.raw), "utf8")); const failures = [];
  for (const item of Object.values(manifest.files)) { if (!fs.existsSync(abs(item.file))) failures.push(`${item.file}:missing`); else { const actual = fileBinding(item.file); if (actual.sha256 !== item.sha256 || actual.bytes !== item.bytes) failures.push(`${item.file}:binding`); } }
  for (const item of manifest.sourcePayloads || []) {
    if (!fs.existsSync(abs(item.file))) failures.push(`${item.file}:missing`); else { const actual = fileBinding(item.file); if (actual.sha256 !== item.sha256 || actual.bytes !== item.bytes) failures.push(`${item.file}:binding`); if (item.kind === "parsed-evidence") { const payload = JSON.parse(fs.readFileSync(abs(item.file), "utf8")); if (!(payload.parsed?.sourceFileCount > 0 && payload.parsed?.sourceBytes > 0)) failures.push(`${item.file}:empty-source`); } }
  }
  verifyParsedEvidence(ROOT, raw, manifest, failures);
  if (manifest.runId !== raw.runId || JSON.parse(fs.readFileSync(abs(REL.definitions), "utf8")).runId !== raw.runId || JSON.parse(fs.readFileSync(abs(REL.sources), "utf8")).runId !== raw.runId) failures.push("run-id");
  for (const item of [...raw.inputs, ...raw.dependencies]) if (fileBinding(item.file).sha256 !== item.sha256) failures.push(`${item.file}:drift`);
  if (JSON.stringify(manifest.inputs) !== JSON.stringify(raw.inputs) || JSON.stringify(manifest.dependencies) !== JSON.stringify(raw.dependencies)) failures.push("manifest-bindings");
  try { assertArtifact(raw); } catch (e) { failures.push(cleanError(e.message)); }
  const payloadFiles = (manifest.sourcePayloads || []).map((x) => x.file);
  if (leakScan([REL.raw, REL.report, REL.manifest, REL.definitions, REL.sources, REL.handoff, ...payloadFiles], ROOT, payloadFiles).length) failures.push("leak-scan");
  if (failures.length) throw new Error(`offline verification failed: ${failures.join(",")}`);
  if (!QUIET) console.log(`Verified ${raw.runId}: routes=${raw.summary.uniqueRoutes} rows=${raw.summary.candidateRows} fixtures=${runFixtures().passed}`);
}

async function generate() {
  const inputBinding = fileBinding(REL.input); if (inputBinding.sha256 !== EXPECTED_INPUT_SHA256) throw new Error(`immutable input hash mismatch: ${inputBinding.sha256}`);
  const input = JSON.parse(fs.readFileSync(abs(REL.input), "utf8")); const scope = selectScope(input);
  const morphoInput = scope.inputRows.find((r) => r.protocol === "Morpho Blue");
  const found = await resolveRpc(norm(morphoInput.current.marketParams.oracle)); const ctx = { rpc: found.rpc, head: found.head };
  const seed = `${inputBinding.sha256}:${found.head.number}:${found.head.hash}`; const runId = `small-cap-oracle-custom-edges-${sha(seed).slice(0, 20)}`;
  const stageRoot = abs(`${STAGING_BASE}/${runId}`); fs.rmSync(stageRoot, { recursive: true, force: true }); fs.mkdirSync(stageRoot, { recursive: true });
  writeJsonAt(stagePath(stageRoot, REL.definitions), makeDefinitions(runId));
  const shared = { adapters: {}, feeds: {} }; const routes = [];
  for (const inputRoute of scope.inputRoutes) {
    const rows = scope.inputRows.filter((r) => r.routeKey === inputRoute.routeKey);
    routes.push(rows[0].protocol === "Morpho Blue" ? await resolveMorphoRoute(ctx, inputRoute, rows[0], shared) : await resolveEulerRoute(ctx, inputRoute, rows, shared));
  }
  // Required coverage is derived from every fixed-head code-bearing trace target,
  // then expanded through proxy/beacon runtime descendants. Assertions are not scope.
  const requiredTargets = await deriveRequiredTargets(ctx, routes);
  const targetAddresses = [...requiredTargets.keys()].map(norm);
  const sourceEvidence = {}; const sourcePayloadBindings = []; const explorerIndex = [];
  for (const address of targetAddresses) {
    const fetched = await fetchExplorerEvidence(address); const key = address.toLowerCase();
    const baseRel = `reports/raw/fast/small-cap-oracle-custom-edges-sources/${runId}/${key}`; const htmlRel = `${baseRel}.html`; const evidenceRel = `${baseRel}.json`;
    fs.mkdirSync(path.dirname(stagePath(stageRoot, htmlRel)), { recursive: true }); fs.writeFileSync(stagePath(stageRoot, htmlRel), fetched.html); writeJsonAt(stagePath(stageRoot, evidenceRel), fetched.evidence);
    sourceEvidence[key] = { rel: evidenceRel, rawRel: htmlRel, evidence: fetched.evidence };
    sourcePayloadBindings.push({ ...physicalBinding(stagePath(stageRoot, htmlRel), htmlRel), kind: "raw-html", address }, { ...physicalBinding(stagePath(stageRoot, evidenceRel), evidenceRel), kind: "parsed-evidence", address });
    explorerIndex.push({ address, rawHtmlFile: htmlRel, parsedEvidenceFile: evidenceRel, fetchStatus: fetched.evidence.fetch.status, responseSha256: fetched.evidence.fetch.responseSha256, verified: fetched.evidence.parsed.verified, sourceFileCount: fetched.evidence.parsed.sourceFileCount, sourceBytes: fetched.evidence.parsed.sourceBytes, deployedBytecodeSha256: fetched.evidence.parsed.deployedBytecodeSha256 || null });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  writeJsonAt(stagePath(stageRoot, REL.sources), makeSourceSnapshots(runId, explorerIndex));
  for (const route of routes) {
    route.runtimeAndTraceResolved = route.resolved;
    route.sourceCoverage = await bindRouteSources(ctx, route, sourceEvidence, requiredTargets);
    route.observedTraceComplete = route.runtimeAndTraceResolved;
    route.resolved = false; route.unresolved = true; route.dexOracleLinked = null;
    route.blockers = [...new Set([...(route.blockers || []), ...UNSUPPORTED_SOURCE_BLOCKERS])];
  }
  const candidateRows = propagateDuplicateFixture(routes, scope.inputRows);
  const finalBlock = await ctx.rpc.send("eth_getBlockByNumber", [hexNum(ctx.head.number), false]);
  ctx.head.finalRecheck = finalBlock ? { number: Number(BigInt(finalBlock.number)), hash: finalBlock.hash, timestamp: Number(BigInt(finalBlock.timestamp)) } : null;
  ctx.head.finalRecheckPassed = Boolean(finalBlock && ctx.head.finalRecheck.number === ctx.head.number && ctx.head.finalRecheck.hash === ctx.head.hash && ctx.head.finalRecheck.timestamp === ctx.head.timestamp);
  const summary = summarize(routes, candidateRows); const sourceCoverage = sourceCoverageSummary(routes);
  const explorerRetrieval = { targets: targetAddresses.length, fetched: count(explorerIndex, (x) => x.fetchStatus === 200), nonemptyVerifiedSource: count(explorerIndex, (x) => x.verified && x.sourceFileCount > 0 && x.sourceBytes > 0), exactRuntimeMatches: sourceCoverage.explorerSourceRuntimeBound };
  const allResolvedNoDex = false;
  const classification = "WATCH_ONLY/COVERAGE_OPEN/NO_ROUTE_PROOF";
  const blockers = [...new Set(routes.flatMap((r) => r.blockers))];
  blockers.push(...UNSUPPORTED_SOURCE_BLOCKERS, "Observed fixed-head traces contain zero DEX calls/selectors, but this does not exclude dormant or alternate branches.");
  const generatedAt = new Date().toISOString(); const inputs = [inputBinding, physicalBinding(stagePath(stageRoot, REL.definitions), REL.definitions), physicalBinding(stagePath(stageRoot, REL.sources), REL.sources)];
  const dependencies = [fileBinding(REL.scanner), fileBinding("tools/shared-rpc.js"), fileBinding("tools/node_modules/ethers/package.json")];
  const artifact = {
    schemaVersion: 1, runId, generatedAt, scanner: REL.scanner, classification,
    input: { file: REL.input, runId: input.runId, sha256: inputBinding.sha256, immutable: true }, inputs, dependencies,
    publication: { runSpecificStage: true, stagedVerification: true, transactionalAtomicSwap: true },
    safety: { rpcInventoryRead: true, endpointValuesPersisted: false, endpointInventoryPersisted: false, transactions: false, signing: false, forks: false, mutation: false },
    fixedHead: ctx.head, providerMetrics: found.metrics, summary, sourceCoverage, explorerRetrieval, routes, candidateRows,
    sharedEvidence: { adapters: Object.values(shared.adapters), feeds: Object.values(shared.feeds) },
    observedTraceComplete: count(routes, (r) => r.observedTraceComplete), sourceCallGraphComplete: 0,
    gates: { positiveRouteEstablished: false, routePositive: null, forkJustified: false, executableNow: false, signedActionJustified: false }, blockers,
  };
  assertArtifact(artifact); writeJsonAt(stagePath(stageRoot, REL.raw), artifact);
  fs.mkdirSync(path.dirname(stagePath(stageRoot, REL.report)), { recursive: true }); fs.writeFileSync(stagePath(stageRoot, REL.report), makeReport(artifact));
  fs.mkdirSync(path.dirname(stagePath(stageRoot, REL.handoff)), { recursive: true }); fs.writeFileSync(stagePath(stageRoot, REL.handoff), makeHandoff(artifact));
  const files = { scanner: fileBinding(REL.scanner), raw: physicalBinding(stagePath(stageRoot, REL.raw), REL.raw), report: physicalBinding(stagePath(stageRoot, REL.report), REL.report), definitions: physicalBinding(stagePath(stageRoot, REL.definitions), REL.definitions), sources: physicalBinding(stagePath(stageRoot, REL.sources), REL.sources), handoff: physicalBinding(stagePath(stageRoot, REL.handoff), REL.handoff) };
  writeJsonAt(stagePath(stageRoot, REL.manifest), { schemaVersion: 1, detached: true, selfExcluded: true, runId, generatedAt, files, sourcePayloads: sourcePayloadBindings, inputs, dependencies, runtime: { node: process.version, ethers: require("./node_modules/ethers/package.json").version }, verification: { hashAlgorithm: "sha256", immutableInputRun: EXPECTED_INPUT_RUN, immutableInputSha256: EXPECTED_INPUT_SHA256, atomicStageVerified: true, fixturesPassed: runFixtures().passed, fixedHeadRechecked: ctx.head.finalRecheckPassed, endpointSecretLeakScanPassed: true } });
  verifyStage(stageRoot, runId); publishAtomic(stageRoot, runId, sourcePayloadBindings.map((x) => x.file)); fs.rmSync(stageRoot, { recursive: true, force: true }); verifyOffline();
  if (!QUIET) console.log(`Custom edges: runId=${runId} head=${ctx.head.number} routes=${summary.uniqueRoutes} resolved=${summary.resolvedRoutes} rows=${summary.candidateRows} dex=${summary.dexLinkedRoutes} classification=${classification}`);
}

async function main() {
  if (SELF_TEST && !VERIFY) { const f = runFixtures(); if (!QUIET) console.log(`Focused fixtures passed: ${f.passed}`); return; }
  if (VERIFY) return verifyOffline();
  fs.mkdirSync(path.dirname(abs(LOCK)), { recursive: true }); let fd;
  try { fd = fs.openSync(abs(LOCK), "wx"); fs.writeFileSync(fd, String(process.pid)); } catch (_) { throw new Error("another small-cap-oracle-custom-edges live generation is active"); }
  try { await generate(); } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(abs(LOCK), { force: true }); }
}

main().catch((e) => { console.error(cleanError(e?.stack || e?.message || e)); process.exitCode = 1; });
