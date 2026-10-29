#!/usr/bin/env node
"use strict";

// Free Protocol Step1: bounded public GETs and fixed-block Ethereum reads only.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Interface, keccak256, formatUnits } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const LOCAL = path.join(ROOT, "reports/raw/defillama-protocols-full.json");
const OUT = path.join(ROOT, "reports/raw/fast/free-protocol-readonly-discovery.json");
const REPORT = path.join(ROOT, "reports/free-protocol-readonly-discovery.md");
const HANDOFF = path.join(ROOT, "coordination/handoffs/2026-07-13-coordinator-free-step1-handoff.md");
const MANIFEST = path.join(ROOT, "reports/raw/fast/free-protocol-readonly-discovery.manifest.json");
const PACKAGE_JSON = path.join(__dirname, "package.json");
const PACKAGE_LOCK = path.join(__dirname, "package-lock.json");
const ADAPTER_REPO = "DefiLlama/DefiLlama-Adapters";
const ADAPTER_PATH = "projects/free-protocol/index.js";
const CORE_ASSETS_PATH = "projects/helper/coreAssets.json";
const EXPECTED_CHAINS = ["arbitrum", "bsc", "ethereum", "hemi", "kroma", "manta", "merlin", "polygon"];
const PROXY = "0x1b5668ca8edfc8af5dcb9de014b4b08ed5d0615f";
const EXPECTED_IMPL = "0x75ab2abb77c70d6a3592795e7240c3a6ae9ce10e";
const PIN = 25522168;
const PIN_HEX = `0x${PIN.toString(16)}`;
const PIN_HASH = "0xcc5f7bfbb823fbc8732311c011e388dbee7511214dddd04843b42b905976482d";
const FIXED_GENERATED_AT = "2026-07-13T00:00:00.000Z";
const CLASSIFICATION = "INCOMPLETE/WATCH — DEFILLAMA-ATTRIBUTED OWNER/TOKEN CONFIGURATION REPRODUCED; ONE ATTRIBUTED ETHEREUM PROXY CHARACTERIZED AT BLOCK 25,522,168; OFFICIAL IDENTITY AND CROSS-CHAIN TOPOLOGY UNRESOLVED";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e019c3218b98b5e8a84b1b6e8ee1178d6";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const EXPECTED = {
  admin: "0x000039ddcf1f63cf3555e62a8d32a11bd1e7e1e1",
  vault: "0x0014eb4ac6dd1473b258d088e6ef214b2bcdc53c",
  executor: "0x0014eb4ac6dd1473b258d088e6ef214b2bcdc53c",
  threshold: "1",
  tokenIndexes: ["1", "2", "65", "67"],
  tokens: {
    "1": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "2": "0xdac17f958d2ee523a2206206994597c13d831ec7",
    "65": "0x0000000000000000000000000000000000000001",
    "67": "0x7122985656e38bdc0302db86685bb972b145bd3c"
  }
};

// Embedded public fallbacks only. These URLs are never emitted to generated evidence.
const PUBLIC_ETHEREUM_FALLBACKS = [
  "https://ethereum.blockpi.network/v1/rpc/public", "https://eth.drpc.org", "https://rpc.payload.de",
  "https://rpc.mevblocker.io", "https://eth-mainnet.public.blastapi.io", "https://ethereum-rpc.publicnode.com",
  "https://eth.llamarpc.com", "https://1rpc.io/eth", "https://cloudflare-eth.com"
];

const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");
const rel = p => path.relative(ROOT, p).replace(/\\/g, "/");
const isAddress = x => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
const address = x => isAddress(x) ? x.toLowerCase() : null;
const canonical = x => {
  if (typeof x === "bigint") return x.toString();
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])]));
  return x;
};
const canonicalText = x => JSON.stringify(canonical(x));
const hashCanonical = x => sha256(Buffer.from(canonicalText(x)));
const boundedError = e => {
  const code = e && (e.code || e.cause?.code), status = e && (e.status || e.cause?.status);
  return code ? `error:${String(code).slice(0, 40)}` : status ? `http:${status}` : "error:unavailable";
};
function parseJson(raw, label) {
  try { return JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8").replace(/^\uFEFF/, "") : raw); }
  catch { throw new Error(`${label}: invalid JSON`); }
}
async function get(url, cap = 8 * 1024 * 1024, timeout = 30000) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow", headers: { accept: "application/json,text/plain", "user-agent": "evm-audit-free-readonly/2.0" } });
    if (!response.ok) throw Object.assign(new Error("public GET failed"), { status: response.status });
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > cap) throw new Error("response-cap"); chunks.push(chunk); }
    const raw = Buffer.concat(chunks);
    return { raw, bytes, sha256: sha256(raw) };
  } finally { clearTimeout(timer); }
}

function loadIdentity() {
  const raw = fs.readFileSync(LOCAL), root = parseJson(raw, "local DefiLlama inventory");
  const rows = Array.isArray(root) ? root : (root.value || root.protocols || root.data || []);
  const byId = rows.filter(x => String(x.id) === "4593"), bySlug = rows.filter(x => x.slug === "free-protocol");
  if (byId.length !== 1 || bySlug.length !== 1 || byId[0] !== bySlug[0]) throw new Error("IDENTITY_MISMATCH: exact id/slug row required");
  const row = byId[0];
  const checks = {
    uniqueExactRow: true, id: String(row.id) === "4593", slug: row.slug === "free-protocol", name: row.name === "Free Protocol",
    category: row.category === "Bridge", adapter: row.module === "free-protocol/index.js", audits: String(row.audits) === "0",
    social: row.twitter === "FreeLayer2", deadUrl: row.deadUrl === true
  };
  if (!Object.values(checks).every(Boolean)) throw new Error(`IDENTITY_MISMATCH: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(",")}`);
  return {
    input: { file: rel(LOCAL), sha256: sha256(raw), bytes: raw.length, checks },
    identity: { id: "4593", slug: row.slug, name: row.name, category: row.category, adapter: row.module, chains: row.chains,
      audits: String(row.audits), social: row.twitter, website: "free.tech (description reference; unavailable/dead)", deadUrl: true,
      officialGithub: null, officialDeploymentManifest: null, confidence: "exact DeFiLlama identity only; not official bridge identity" }
  };
}

function matchingBrace(source, start) {
  const open = source.indexOf("{", start); if (open < 0) return null;
  let depth = 0, quote = null, escaped = false;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "{") depth++; else if (c === "}" && --depth === 0) return { open, close: i, body: source.slice(open + 1, i) };
  }
  return null;
}
function arrayBody(source, key) {
  const m = new RegExp(`\\b${key}\\s*:\\s*\\[`, "m").exec(source); if (!m) return null;
  const open = source.indexOf("[", m.index), close = source.indexOf("]", open);
  return close < 0 ? null : source.slice(open + 1, close);
}
function parseAdapter(source, coreAssets) {
  const exportAt = source.indexOf("module.exports");
  const object = exportAt >= 0 ? matchingBrace(source, exportAt) : null;
  if (!object) throw new Error("IDENTITY_MISMATCH: module.exports object absent");
  const moduleKeys = [...object.body.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*\{/gm)].map(x => x[1]);
  const rows = [];
  for (const chain of moduleKeys) {
    const m = new RegExp(`^\\s{2}${chain}:\\s*\\{`, "m").exec(object.body), block = m && matchingBrace(object.body, m.index);
    if (!block) throw new Error(`IDENTITY_MISMATCH: adapter chain block ${chain}`);
    const parseList = (key, token) => {
      const value = arrayBody(block.body, key); if (value === null) return [];
      return value.split(",").map(x => x.trim()).filter(Boolean).map(item => {
        const literal = item.match(/^['"](0x[0-9a-fA-F]{40})['"]$/);
        if (literal) return token ? { address: address(literal[1]), provenance: "adapter-literal" } : address(literal[1]);
        const ref = item.match(/^ADDRESSES\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/), resolved = ref && coreAssets?.[ref[1]]?.[ref[2]];
        if (token && ref && isAddress(resolved)) return { address: address(resolved), provenance: `coreAssets:${ref[1]}.${ref[2]}` };
        throw new Error(`IDENTITY_MISMATCH: strict adapter ${key} parse failed for ${chain}`);
      });
    };
    rows.push({ chain, owners: parseList("owners", false), tokens: parseList("tokens", true), classification: "DefiLlama-attributed adapter-owner address/token configuration only" });
  }
  const parsedKeys = rows.map(x => x.chain).sort();
  if (canonicalText(parsedKeys) !== canonicalText([...moduleKeys].sort()) || canonicalText(parsedKeys) !== canonicalText(EXPECTED_CHAINS)) throw new Error("IDENTITY_MISMATCH: parsed/exported/expected chain keys differ");
  const eth = rows.find(x => x.chain === "ethereum");
  if (!eth || eth.owners.length !== 5 || !eth.owners.includes(PROXY) || !eth.owners.includes("0xeea3a032f381ab1e415e82fe08ebeb20f513c42c")) throw new Error("IDENTITY_MISMATCH: exact five Ethereum adapter owners required");
  return { rows: rows.sort((a, b) => a.chain.localeCompare(b.chain)), validation: { parser: "strict validated brace/token parser", moduleExportKeys: moduleKeys.sort(), parsedChainKeys: parsedKeys, expectedChainKeys: EXPECTED_CHAINS, complete: true } };
}
async function fetchAdapter() {
  const commitResponse = await get(`https://api.github.com/repos/${ADAPTER_REPO}/commits?path=${encodeURIComponent(ADAPTER_PATH)}&per_page=1`, 2 * 1024 * 1024);
  const commits = parseJson(commitResponse.raw, "GitHub commits"), commit = commits?.[0]?.sha;
  if (!/^[0-9a-f]{40}$/.test(commit || "")) throw new Error("IDENTITY_MISMATCH: adapter commit unresolved");
  const adapter = await get(`https://raw.githubusercontent.com/${ADAPTER_REPO}/${commit}/${ADAPTER_PATH}`, 1024 * 1024);
  const core = await get(`https://raw.githubusercontent.com/${ADAPTER_REPO}/${commit}/${CORE_ASSETS_PATH}`, 8 * 1024 * 1024);
  const parsed = parseAdapter(adapter.raw.toString("utf8"), parseJson(core.raw, "coreAssets"));
  return { provenance: { repository: ADAPTER_REPO, path: ADAPTER_PATH, commit, adapterResponseSha256: adapter.sha256, adapterBytes: adapter.bytes,
    commitResponseSha256: commitResponse.sha256, coreAssetsPath: CORE_ASSETS_PATH, coreAssetsResponseSha256: core.sha256, resolution: "current path commit resolved; raw inputs pinned to that commit" },
    validation: parsed.validation, inventory: parsed.rows };
}

let rpcId = 1;
async function rpc(url, method, params, timeout = 25000) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json", "user-agent": "evm-audit-free-readonly/2.0" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) });
    if (!response.ok) throw Object.assign(new Error("rpc unavailable"), { status: response.status });
    const json = await response.json(); if (json.error) throw Object.assign(new Error("rpc error"), { code: json.error.code });
    return json.result;
  } finally { clearTimeout(timer); }
}
async function selectProvider() {
  const attempts = [];
  for (let i = 0; i < PUBLIC_ETHEREUM_FALLBACKS.length; i++) {
    const url = PUBLIC_ETHEREUM_FALLBACKS[i];
    try {
      const chainId = await rpc(url, "eth_chainId", []), block = await rpc(url, "eth_getBlockByNumber", [PIN_HEX, false]);
      const chainPass = chainId === "0x1", hashPass = block?.hash?.toLowerCase() === PIN_HASH;
      let historicalPass = false;
      if (chainPass && hashPass) historicalPass = /^0x[0-9a-fA-F]{64}$/.test(await rpc(url, "eth_getStorageAt", [PROXY, IMPL_SLOT, PIN_HEX]));
      attempts.push({ fallbackIndex: i + 1, chainId: chainPass ? "pass" : "fail", pinHash: hashPass ? "pass" : "fail", historicalRead: historicalPass ? "pass" : "fail" });
      if (chainPass && hashPass && historicalPass) return { url, evidence: { selectedFallbackIndex: i + 1, chainId: 1, pinBlock: PIN, pinHash: PIN_HASH, pinTimestamp: Number.parseInt(block.timestamp, 16), validation: "pass", attempts } };
    } catch (e) { attempts.push({ fallbackIndex: i + 1, chainId: "unavailable", pinHash: "unavailable", historicalRead: "unavailable", error: boundedError(e) }); }
  }
  return { url: null, evidence: { selectedFallbackIndex: null, chainId: null, pinBlock: PIN, pinHash: PIN_HASH, validation: "historical-state-unavailable", attempts } };
}
const slotAddress = x => /^0x[0-9a-fA-F]{64}$/.test(x || "") && !/^0x0{64}$/.test(x) ? `0x${x.slice(-40)}`.toLowerCase() : null;

function exactExcerpt(fileMap, spec) {
  const file = fileMap.get(spec.file); if (!file) return { id: spec.id, status: "required-file-missing", file: spec.file };
  const lines = file.text.split("\n"), at = lines.findIndex(x => x.includes(spec.anchor));
  if (at < 0) return { id: spec.id, status: "anchor-not-located", file: spec.file, contract: spec.contract, symbol: spec.symbol };
  const start = Math.max(0, at + (spec.before || 0)), end = Math.min(lines.length - 1, at + (spec.after || 0));
  const excerpt = lines.slice(start, end + 1).join("\n").trimEnd();
  return { id: spec.id, status: "located", file: spec.file, contract: spec.contract, functionOrConstant: spec.symbol,
    startLine: start + 1, endLine: end + 1, normalizedExcerpt: excerpt, normalizedExcerptSha256: sha256(Buffer.from(excerpt)), chars: excerpt.length };
}
async function sourceEvidence() {
  const sourceResponse = await get(`https://eth.blockscout.com/api/v2/smart-contracts/${EXPECTED_IMPL}`, 14 * 1024 * 1024);
  const root = parseJson(sourceResponse.raw, "Blockscout source");
  const providerVerified = root.is_verified === true && root.is_fully_verified === true && root.is_partially_verified !== true && root.is_changed_bytecode === false;
  if (!providerVerified) throw new Error("source provider verification flags failed");
  if (address(EXPECTED_IMPL) !== EXPECTED_IMPL || root.name !== "AtomicLockContract" || root.file_path !== "contracts/lock/AtomicLockContract.sol") throw new Error("source identity mismatch");
  if (!Array.isArray(root.abi)) throw new Error("verified-source response ABI absent");
  const abiResponse = await get(`https://eth.blockscout.com/api?module=contract&action=getabi&address=${EXPECTED_IMPL}`, 3 * 1024 * 1024);
  const abiEnvelope = parseJson(abiResponse.raw, "Blockscout ABI"), abi = parseJson(abiEnvelope.result, "Blockscout ABI result");
  if (abiEnvelope.message !== "OK" || !Array.isArray(abi)) throw new Error("ABI provider response failed");
  const sourceResponseAbiNormalizedSha256 = hashCanonical(root.abi), separateEndpointAbiNormalizedSha256 = hashCanonical(abi);
  const sourceAbiAgreement = canonicalText(root.abi) === canonicalText(abi);
  if (!sourceAbiAgreement) throw new Error("verified-source/separate-endpoint ABI mismatch");
  const rawFiles = [{ name: root.file_path, text: root.source_code }, ...(root.additional_sources || []).map(x => ({ name: x.file_path, text: x.source_code }))];
  const fileMap = new Map();
  for (const f of rawFiles) {
    if (!f.name || typeof f.text !== "string") continue;
    const text = f.text.replace(/\r\n/g, "\n").split("\n").map(x => x.replace(/[ \t]+$/g, "")).join("\n");
    fileMap.set(f.name, { name: f.name, text, sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text) });
  }
  const requiredFiles = ["contracts/lock/AtomicLockContract.sol", "contracts/Permissions.sol", "contracts/ReqHelpers.sol"];
  if (!requiredFiles.every(x => fileMap.has(x))) throw new Error("required named source files absent");
  const fileHashManifest = [...fileMap.values()].map(({ name, sha256: hash, bytes }) => ({ file: name, sha256: hash, bytes })).sort((a, b) => a.file.localeCompare(b.file));
  const settings = root.compiler_settings || {};
  const metadata = {
    implementation: EXPECTED_IMPL, contractName: root.name, primaryFile: root.file_path, language: root.language,
    compilerVersion: root.compiler_version, compilerTarget: settings.compilationTarget || null, compilerSettings: settings,
    providerVerification: { isVerified: root.is_verified, isFullyVerified: root.is_fully_verified, isPartiallyVerified: root.is_partially_verified,
      isVerifiedViaSourcify: root.is_verified_via_sourcify, isVerifiedViaEthBytecodeDb: root.is_verified_via_eth_bytecode_db,
      isChangedBytecode: root.is_changed_bytecode }
  };
  const specs = [
    ["initialize-authority","contracts/lock/AtomicLockContract.sol","AtomicLockContract","initialize","function initialize",0,7],
    ["upgrade-authority","contracts/lock/AtomicLockContract.sol","AtomicLockContract","_authorizeUpgrade","function _authorizeUpgrade",0,0],
    ["per-proxy-request-maps","contracts/lock/AtomicLockContract.sol","AtomicLockContract","proposedLock/proposedUnlock","mapping(bytes32 => address) public proposedLock",-2,1],
    ["lock-proposal-token-resolution","contracts/lock/AtomicLockContract.sol","AtomicLockContract","proposeLock","uint256 amount = _amountFrom(reqId);",0,16],
    ["lock-digest","contracts/lock/AtomicLockContract.sol","AtomicLockContract","executeLock digest","Sign to execute a lock-mint",-3,2],
    ["lock-execution-token-resolution","contracts/lock/AtomicLockContract.sol","AtomicLockContract","executeLock","proposedLock[reqId] = address(1);",0,5],
    ["lock-cancellation-token-resolution","contracts/lock/AtomicLockContract.sol","AtomicLockContract","cancelLock","function cancelLock",0,21],
    ["unlock-recipient-reservation","contracts/lock/AtomicLockContract.sol","AtomicLockContract","proposeUnlock","function proposeUnlock",0,12],
    ["unlock-digest-recipient-use","contracts/lock/AtomicLockContract.sol","AtomicLockContract","executeUnlock","function executeUnlock",0,27],
    ["unlock-cancellation-token-resolution","contracts/lock/AtomicLockContract.sol","AtomicLockContract","cancelUnlock","function cancelUnlock",0,11],
    ["native-lock-proxy-or-vault-custody","contracts/lock/AtomicLockContract.sol","AtomicLockContract","proposeLock native paths","if (tokenAddr == address(1))",0,13],
    ["native-cancel-refund-path","contracts/lock/AtomicLockContract.sol","AtomicLockContract","cancelLock native path","(bool success, ) = proposer.call{value: amount}",-1,2],
    ["native-unlock-release-path","contracts/lock/AtomicLockContract.sol","AtomicLockContract","executeUnlock native path","(bool success, ) = recipient.call{value: amount}",-1,2],
    ["chain-constant","contracts/ReqHelpers.sol","ReqHelpers","CHAIN","uint8 constant CHAIN",0,0],
    ["bridge-channel","contracts/ReqHelpers.sol","ReqHelpers","BRIDGE_CHANNEL","string constant BRIDGE_CHANNEL",0,0],
    ["expiry-constants","contracts/ReqHelpers.sol","ReqHelpers","PROPOSE/EXPIRE constants","uint256 constant PROPOSE_PERIOD",0,2],
    ["reqid-layout","contracts/ReqHelpers.sol","ReqHelpers","reqId layout","version:uint8|createdTime:uint40",0,1],
    ["token-index-resolution","contracts/ReqHelpers.sol","ReqHelpers","_tokenFrom","function _tokenFrom",0,6],
    ["base-unit-resolution","contracts/ReqHelpers.sol","ReqHelpers","_amountFrom","function _amountFrom",0,17],
    ["route-modifiers","contracts/ReqHelpers.sol","ReqHelpers","fromChainOnly/toChainOnly","modifier fromChainOnly",0,8],
    ["executor-update-domain-and-fields","contracts/Permissions.sol","Permissions","updateExecutors digest","Sign to update executors to",-3,4],
    ["executor-update-validation-full","contracts/Permissions.sol","Permissions","updateExecutors full validation surface","function updateExecutors(",0,32],
    ["executor-pending-overwrite","contracts/Permissions.sol","Permissions","updateExecutors overwrite","if (newIndex ==",0,11],
    ["executor-epoch-threshold-duplicates","contracts/Permissions.sol","Permissions","__checkExecutorsForIndex","function __checkExecutorsForIndex",0,23]
  ].map(([id,file,contract,symbol,anchor,before,after]) => ({ id,file,contract,symbol,anchor,before,after }));
  const exactSourceEvidence = specs.map(x => exactExcerpt(fileMap, x));
  const proofTerms = ["light client", "merkle proof", "finality", "block header", "state root", "receipt proof"];
  const targetFilesText = requiredFiles.map(x => fileMap.get(x).text.toLowerCase()).join("\n");
  const proofCounts = Object.fromEntries(proofTerms.map(term => [term, (targetFilesText.match(new RegExp(term.replace(" ", "\\s+"), "g")) || []).length]));
  let solcAvailable = false;
  try { require.resolve("solc", { paths: [__dirname] }); solcAvailable = true; } catch {}
  const compilationReproduction = { attempted: false, safeExactCompilerAvailable: solcAvailable, result: "not-performed",
    reason: solcAvailable ? "exact 0.8.20 standard-json reproduction not implemented in this bounded scanner" : "local solc package matching provider compiler unavailable; no tool download performed" };
  const sourceRuntimeBound = false;
  return {
    abi,
    persisted: {
      provider: "Blockscout", implementation: EXPECTED_IMPL, contractName: root.name, primaryFile: root.file_path,
      providerVerified, providerVerification: metadata.providerVerification, compilerVersion: root.compiler_version,
      compilerTarget: settings.compilationTarget, compilerSettings: settings,
      transport: { sourceResponseSha256: sourceResponse.sha256, sourceResponseBytes: sourceResponse.bytes, abiResponseSha256: abiResponse.sha256, abiResponseBytes: abiResponse.bytes },
      metadataSha256: hashCanonical(metadata), sourceResponseAbiNormalizedSha256, separateEndpointAbiNormalizedSha256,
      sourceAbiAgreement, abiNormalizedSha256: separateEndpointAbiNormalizedSha256, abiEntries: abi.length,
      sourceFiles: fileHashManifest, sourceFileHashManifestSha256: hashCanonical(fileHashManifest), exactSourceEvidence,
      requiredNamedCodeFactsLocated: exactSourceEvidence.every(x => x.status === "located"),
      onchainProofFinalityArchitecture: { scannedFiles: requiredFiles, terms: proofCounts, totalMatches: Object.values(proofCounts).reduce((a,b) => a+b,0),
        assessment: "no onchain source-proof or finality verifier located in the provider-target contract files; offchain procedures were not assessed" },
      compilationReproduction, sourceRuntimeBound,
      sourceBindingStatus: "provider-verified-source-runtime-not-locally-reproduced",
      bindingQualification: "Provider verification metadata is recorded. No cryptographic source-to-runtime claim is made without exact local compilation and executable-runtime comparison."
    }
  };
}

async function queryState(selected, abi) {
  const state = { provider: selected.evidence, attributedAddress: PROXY, independentlyCharacterizedAs: "EIP-1967 UUPS proxy", pin: { blockNumber: PIN, blockHash: PIN_HASH }, slots: {}, code: {}, getters: {}, roleCodeIdentities: [], custodyAndAccounting: [], historicalStateAvailable: false };
  if (!selected.url) return state;
  const url = selected.url, iface = new Interface(abi);
  for (const [name, slot] of [["implementation",IMPL_SLOT],["admin",ADMIN_SLOT],["beacon",BEACON_SLOT]]) {
    try { const raw = await rpc(url,"eth_getStorageAt",[PROXY,slot,PIN_HEX]); state.slots[name] = { status:"success",raw,address:slotAddress(raw) }; }
    catch(e) { state.slots[name] = { status:"failure",error:boundedError(e) }; }
  }
  for (const [name,target] of [["proxy",PROXY],["implementation",state.slots.implementation?.address || EXPECTED_IMPL]]) {
    try { const code = await rpc(url,"eth_getCode",[target,PIN_HEX]); state.code[name] = { status:"success",address:target,bytes:(code.length-2)/2,keccak256:code==="0x"?null:keccak256(code) }; }
    catch(e) { state.code[name] = { status:"failure",address:target,error:boundedError(e) }; }
  }
  const call = async (target, callIface, name, args=[]) => {
    try { const data=callIface.encodeFunctionData(name,args), raw=await rpc(url,"eth_call",[{to:target,data},PIN_HEX]); const d=callIface.decodeFunctionResult(name,raw); return {status:"success",value:canonical(d.length===1?d[0]:[...d])}; }
    catch(e) { return {status:"failure",error:boundedError(e)}; }
  };
  for (const name of ["getAdmin","getVault","getActiveExecutors","getSupportedTokens"]) state.getters[name] = await call(PROXY,iface,name);
  state.getters.proposers = [];
  for (let i=0;i<4;i++) state.getters.proposers.push({index:i,...await call(PROXY,iface,"proposerOfIndex",[i])});
  const active=state.getters.getActiveExecutors.value;
  state.getters.decodedActiveExecutors=Array.isArray(active)?{executors:active[0],activeExecutorCount:active[0].length,threshold:active[1],activeSince:active[2],executorIndex:active[3]}:{status:"unavailable"};
  const supported=state.getters.getSupportedTokens.value;
  state.getters.supportedTokenRows=[];
  if(Array.isArray(supported)&&supported.length===3) for(let i=0;i<supported[0].length;i++){
    const token=address(supported[0][i]),index=String(supported[1][i]),decimals=Number(supported[2][i]),locked=await call(PROXY,iface,"lockedBalanceOf",[token]);
    state.getters.supportedTokenRows.push({index,token,decimals,lockedBalance:locked.status==="success"?{status:"success",raw:String(locked.value),formatted:formatUnits(locked.value,decimals)}:locked});
  }
  const roleMap=new Map(), addRole=(a,role)=>{a=address(a);if(!a)return;if(!roleMap.has(a))roleMap.set(a,new Set());roleMap.get(a).add(role)};
  addRole(state.getters.getAdmin.value,"application-admin"); addRole(state.getters.getVault.value,"vault");
  for(const x of active?.[0]||[])addRole(x,"executor"); for(const x of state.getters.proposers)if(x.status==="success")addRole(x.value,`proposer-index-${x.index}`);
  for(const [a,roles] of roleMap){
    try{const code=await rpc(url,"eth_getCode",[a,PIN_HEX]),bytes=(code.length-2)/2,lower=code.toLowerCase();let codeType="deployed-contract-code",delegationTarget=null;
      if(code==="0x")codeType="no-code-at-pin";else if(bytes===23&&lower.startsWith("0xef0100")){codeType="eip-7702-delegation";delegationTarget=`0x${lower.slice(8)}`;}
      state.roleCodeIdentities.push({address:a,roles:[...roles].sort(),status:"success",codeType,codeBytes:bytes,codeKeccak256:code==="0x"?null:keccak256(code),delegationTarget,qualification:"code classification only; no control identity inferred"});
    }catch(e){state.roleCodeIdentities.push({address:a,roles:[...roles].sort(),status:"failure",error:boundedError(e),qualification:"no control identity inferred"});}
  }
  state.roleCodeIdentities.sort((a,b)=>a.address.localeCompare(b.address));
  const erc20=new Interface(["function balanceOf(address) view returns (uint256)","function allowance(address,address) view returns (uint256)"]);
  const vault=address(state.getters.getVault.value);
  for(const row of state.getters.supportedTokenRows){
    if(row.token===EXPECTED.tokens["65"]){
      const readBalance=async a=>{try{const value=BigInt(await rpc(url,"eth_getBalance",[a,PIN_HEX]));return{status:"success",raw:String(value),formatted:formatUnits(value,18)}}catch(e){return{status:"failure",error:boundedError(e)}}};
      state.custodyAndAccounting.push({index:row.index,token:row.token,kind:"native-sentinel",bridgeLockedAccounting:row.lockedBalance,proxyNativeBalance:await readBalance(PROXY),vaultNativeBalance:await readBalance(vault),vaultAllowanceToProxy:{status:"not-applicable"},qualification:"bridge locked accounting is distinct from native custody; usage history unresolved"});
    }else{
      const pb=await call(row.token,erc20,"balanceOf",[PROXY]),vb=await call(row.token,erc20,"balanceOf",[vault]),al=await call(row.token,erc20,"allowance",[vault,PROXY]);
      const fmt=x=>x.status==="success"?{status:"success",raw:String(x.value),formatted:formatUnits(x.value,row.decimals)}:x;
      state.custodyAndAccounting.push({index:row.index,token:row.token,kind:"erc20",bridgeLockedAccounting:row.lockedBalance,proxyTokenBalance:fmt(pb),vaultTokenBalance:fmt(vb),vaultAllowanceToProxy:fmt(al),qualification:"bridge accounting, token custody balances, and allowance are separate observations; no control identity inferred"});
    }
  }
  const exactTokens=state.getters.supportedTokenRows.length===4&&canonicalText(state.getters.supportedTokenRows.map(x=>x.index).sort())===canonicalText([...EXPECTED.tokenIndexes].sort())&&Object.entries(EXPECTED.tokens).every(([i,a])=>state.getters.supportedTokenRows.some(x=>x.index===i&&x.token===a));
  const custodyReadsComplete=state.custodyAndAccounting.length===4&&state.custodyAndAccounting.every(x=>x.kind==="native-sentinel"
    ? x.proxyNativeBalance?.status==="success"&&x.vaultNativeBalance?.status==="success"&&x.vaultAllowanceToProxy?.status==="not-applicable"
    : x.proxyTokenBalance?.status==="success"&&x.vaultTokenBalance?.status==="success"&&x.vaultAllowanceToProxy?.status==="success");
  const checks={
    pinHash:selected.evidence.validation==="pass",implementation:state.slots.implementation?.address===EXPECTED_IMPL,adminSlotZero:state.slots.admin?.status==="success"&&state.slots.admin.address===null,
    beaconSlotZero:state.slots.beacon?.status==="success"&&state.slots.beacon.address===null,proxyCode:state.code.proxy?.bytes>0,implementationCode:state.code.implementation?.bytes>0,
    applicationAdmin:address(state.getters.getAdmin.value)===EXPECTED.admin,vault:address(state.getters.getVault.value)===EXPECTED.vault,
    soleExecutor:Array.isArray(active?.[0])&&active[0].length===1&&address(active[0][0])===EXPECTED.executor,thresholdOne:String(active?.[1])==="1",executorIndexDecoded:/^\d+$/.test(String(active?.[3])),
    exactPinnedTokenSet:exactTokens,lockedBalanceCalls:state.getters.supportedTokenRows.length===4&&state.getters.supportedTokenRows.every(x=>x.lockedBalance.status==="success"),
    roleCodeTypes:state.roleCodeIdentities.length>=3&&state.roleCodeIdentities.every(x=>x.status==="success"),custodyAllowanceCalls:custodyReadsComplete
  };
  state.verification=Object.fromEntries(Object.entries(checks).map(([k,v])=>[k,{status:v?"pass":"fail"}]));
  state.historicalStateAvailable=Object.values(checks).every(Boolean);
  return state;
}

async function activityEvidence(abi, selected) {
  const result={label:"Ethereum endpoint activity; route association unresolved",fetched:false,records:[],coverage:{deployment:"not-located",upgrade:"not-located",lock:"not-located",unlock:"not-located"}};
  try{
    const txResponse=await get(`https://eth.blockscout.com/api/v2/addresses/${PROXY}/transactions`,5*1024*1024),logResponse=await get(`https://eth.blockscout.com/api/v2/addresses/${PROXY}/logs`,5*1024*1024);
    const txPage=parseJson(txResponse.raw,"activity transactions"),logPage=parseJson(logResponse.raw,"activity logs"),iface=new Interface(abi),pageEvents=new Map();
    const decodeLog=log=>{try{const topics=(log.topics||[]).map(t=>typeof t==="string"?t:(t.value||t.topic)).filter(Boolean),data=typeof log.data==="string"?log.data:(log.data?.data||"0x");return iface.parseLog({topics,data})?.name||null}catch{return null}};
    for(const log of logPage.items||[]){const h=(log.transaction_hash||"").toLowerCase(),name=decodeLog(log);if(name&&/^0x[0-9a-f]{64}$/.test(h)){if(!pageEvents.has(h))pageEvents.set(h,new Set());pageEvents.get(h).add(name)}}
    const seen=new Set();
    for(const tx of txPage.items||[]){
      const hash=(tx.hash||"").toLowerCase(),block=Number(tx.block_number),input=tx.raw_input||tx.input||"0x",creation=tx.to===null||tx.to?.hash===null;
      const selector=!creation&&/^0x[0-9a-fA-F]{8}/.test(input)?input.slice(0,10).toLowerCase():null,key=creation?"creation":selector;
      if(!/^0x[0-9a-f]{64}$/.test(hash)||!Number.isSafeInteger(block)||block>PIN||!key||seen.has(key))continue;
      let methodName=creation?null:null; if(!creation)try{methodName=iface.parseTransaction({data:input,value:tx.value||0})?.name||null}catch{}
      const events=new Set(pageEvents.get(hash)||[]);let receiptStatus="not-queried",receiptResultSha256=null;
      if(selected.url)try{const receipt=await rpc(selected.url,"eth_getTransactionReceipt",[hash]);receiptStatus=receipt?"success":"not-found";receiptResultSha256=receipt?hashCanonical(receipt):null;for(const log of receipt?.logs||[]){if(address(log.address)!==PROXY)continue;const n=decodeLog(log);if(n)events.add(n)}}catch(e){receiptStatus=boundedError(e)}
      result.records.push({txHash:hash,blockNumber:block,activityType:creation?"contract-creation":"call",selector,decodedMethodName:methodName,eventNames:[...events].sort(),receiptStatus,receiptResultSha256});seen.add(key);
      const joined=`${methodName||""} ${[...events].join(" ")}`.toLowerCase();if(creation)result.coverage.deployment="located";if(joined.includes("upgrade"))result.coverage.upgrade="located";if(joined.includes("unlock"))result.coverage.unlock="located";if(/(^|[^a-z])(?:propose|execute|cancel)?lock/.test(joined.replace(/unlock/g,"")))result.coverage.lock="located";if(result.records.length>=12)break;
    }
    result.records.sort((a,b)=>a.blockNumber-b.blockNumber||a.txHash.localeCompare(b.txHash));
    result.provenance={provider:"Blockscout public API",transactionPageResponseSha256:txResponse.sha256,logPageResponseSha256:logResponse.sha256,pageCount:{transactions:1,logs:1},
      complete:false,nextCursorPresent:{transactions:!!txPage.next_page_params,logs:!!logPage.next_page_params},sampleRule:"first pin-or-earlier transaction for each distinct selector plus contract creation, from the first returned transaction page; maximum 12",
      completenessCaveat:"bounded first-page sample, not full history; next cursor is recorded but not traversed"};result.fetched=true;
  }catch(e){result.error=boundedError(e)}
  return result;
}

const bindingMatrix=[
  ["version","yes: raw reqId","semantic version enforcement not located"],["created time","yes: raw reqId","proposal freshness checked"],["action","yes: raw reqId","operation/vault-mode bits interpreted"],
  ["operation text","yes: static digest text","lock and unlock use distinct static operation strings"],["static bridge channel","yes: static digest text","BEVM Bridge constant; not instance-specific"],
  ["token index","yes: raw reqId","index is signed"],["resolved token address","no","resolved from mutable token registry at each lifecycle call"],
  ["encoded uint64 amount","yes: raw reqId","encoded six-decimal-style integer is signed"],["resolved base-unit amount/decimals","no","derived from mutable index/decimals registry; meaning may change"],
  ["from","yes: raw reqId","AtomicLock proposals enforce from==CHAIN (Ethereum)"],["to","yes: raw reqId","no destination semantic check located on AtomicLock path"],["suffix uint112","yes: raw reqId","no semantic validation located"],
  ["recipient","no","onlyProposer stores recipient; execution reads stored value"],["EVM chainid","no","not in EIP-191 digest"],["verifying proxy","no","not in digest"],["implementation","no","not in digest"],
  ["source bridge address","no","not in digest"],["destination bridge address","no","not in digest"],["executor epoch/exeIndex","no","execution argument checked separately"],["activeSince","no","not in operation digest; rotation digest also omits activeSince"],
  ["deadline","no","created time is signed but no separate execution deadline is signed/enforced"],["source proof","absent onchain architecture property","no verifier located in provider-target files; offchain procedures not assessed"],
  ["finality","absent onchain architecture property","no light-client/finality verifier located; offchain procedures not assessed"]
].map(([field,digestBinding,semantics])=>({field,digestBinding,semantics}));

const candidates=[
  {id:"intra-proxy-recipient-substitution",branch:"recipient substitution",sourceProperty:"confirmed",deployedImpact:"unproven",roleRequired:"proposer plus valid executor signatures; signatures do not independently authenticate stored recipient",prerequisites:"Within one proxy, establish a pending unused reqId where proposer-selected stored recipient differs from executor intent and signatures over reqId do not independently authenticate that recipient."},
  {id:"cross-instance-replay",branch:"cross-instance replay",sourceProperty:"confirmed",deployedImpact:"blocked",roleRequired:"target-instance proposer and a signature set accepted by the target executor epoch",prerequisites:"Separately match runtime, channel, route/token semantics, executor set/epoch and unused reqId across instances; compile runtimes first and test only on local forks."},
  {id:"mutable-token-index-lifecycle",branch:"mutable token-index lifecycle/cancellation",sourceProperty:"confirmed",deployedImpact:"unproven",roleRequired:"admin for remove/re-add; pending proposal; valid executor signatures only for execution (cancellation itself is unsigned)",prerequisites:"Recover token reindex history and construct a pending proposal whose execution/cancellation resolves a changed current index; distinguish unsigned cancellation from signed execution."},
  {id:"native-vault-custody",branch:"native vault custody mismatch",sourceProperty:"confirmed",deployedImpact:"blocked",roleRequired:"configuration/admin and relevant proposer/executor or user path",prerequisites:"Index 65 native sentinel is pinned; establish actual vault-mode request usage, proxy/vault custody movement, allowance irrelevance, cancellations and liabilities."},
  {id:"executor-rotation-validation",branch:"executor rotation validation",sourceProperty:"confirmed",deployedImpact:"unproven",roleRequired:"valid current-epoch executor signatures; caller itself is unrestricted",prerequisites:"Test omitted domain and activeSince/epoch binding; empty/zero/duplicate new sets; threshold greater than unique executors; and pending-set overwrite ordering/history."},
  {id:"proposer-liquidity-reservation",branch:"proposer liquidity reservation",sourceProperty:"confirmed",deployedImpact:"unproven",roleRequired:"proposer",prerequisites:"Measure lockedBalance decrement at proposal, cancellation restoration, proposer reachability and custody/liability effects."},
  {id:"execution-expiry",branch:"execution expiry",sourceProperty:"confirmed",deployedImpact:"unproven",roleRequired:"valid executor signatures after a proposer-created request",prerequisites:"Show a proposal executable after cancellation expiry creates a harmful state/value delta; expiry source property alone is not impact."},
  {id:"route-version-semantics",branch:"unchecked route/version semantics",sourceProperty:"confirmed",deployedImpact:"blocked",roleRequired:"proposer/executor and deployment configuration roles as applicable",prerequisites:"Build all-instance CHAIN/channel/version/runtime matrix and demonstrate accepted incompatible semantics with impact."}
].map(x=>({...x,label:"source-candidate-needs-step2",trustedRoleOrConfigIssue:true,vulnerabilityPromoted:false}));

function stagedPlan(adapter){
  const by=Object.fromEntries(adapter.inventory.map(x=>[x.chain,x.owners]));
  return {priority:"P0",ethereumAdapterOwners:by.ethereum.map(x=>({address:x,classification:x===PROXY?"attributed address independently characterized here as proxy":"adapter-owner address; unclassified"})),
    merlinAdapterOwners:by.merlin.map(x=>({address:x,classification:"adapter-owner address; unclassified"})),
    remainingChains:Object.fromEntries(["arbitrum","bsc","hemi","kroma","manta","polygon"].map(c=>[c,by[c].map(x=>({address:x,classification:"adapter-owner address; unclassified"}))]))};
}
function trustBoundaries(state){const a=state.getters.decodedActiveExecutors||{};return[
  {role:"application admin/UUPS authority",address:address(state.getters.getAdmin?.value),assessment:"critical trusted-role/configuration exposure; not permissionless exploit evidence"},
  {role:"vault",address:address(state.getters.getVault?.value),assessment:"custody/configuration boundary; code type does not identify controller"},
  {role:"executor set",addresses:(a.executors||[]).map(address),threshold:a.threshold,assessment:"threshold-1 trusted-role exposure at pin; not permissionless exploit evidence"},
  {role:"proposer",addresses:state.getters.proposers.filter(x=>x.status==="success"&&address(x.value)).map(x=>address(x.value)),assessment:"trusted role selecting stored unlock recipient/reserving accounting"}
]}

function gatesFor(local,adapter,state,source,activity){
  const step={localIdentity:Object.values(local.input.checks).every(Boolean),adapterParseComplete:adapter.validation.complete,adapterChainKeysExact:canonicalText(adapter.validation.parsedChainKeys)===canonicalText(EXPECTED_CHAINS),
    fiveEthereumAdapterOwners:adapter.inventory.find(x=>x.chain==="ethereum")?.owners.length===5,pinHash:state.verification?.pinHash?.status==="pass",expectedImplementation:state.verification?.implementation?.status==="pass",
    requiredSlots:["adminSlotZero","beaconSlotZero"].every(x=>state.verification?.[x]?.status==="pass"),requiredStateAndGetters:["proxyCode","implementationCode","applicationAdmin","vault","soleExecutor","thresholdOne","executorIndexDecoded","lockedBalanceCalls"].every(x=>state.verification?.[x]?.status==="pass"),
    exactPinnedTokenSet:state.verification?.exactPinnedTokenSet?.status==="pass",sourceProviderVerified:source.providerVerified===true,sourceBytecodeUnchanged:source.providerVerification?.isChangedBytecode===false,sourceAbiAgreement:source.sourceAbiAgreement===true,requiredNamedCodeFacts:source.requiredNamedCodeFactsLocated===true,
    roleCodeTypes:state.verification?.roleCodeTypes?.status==="pass",custodyAllowanceReads:state.verification?.custodyAllowanceCalls?.status==="pass",
    activityPaginationProvenance:activity.fetched===true&&!!activity.provenance?.transactionPageResponseSha256&&typeof activity.provenance?.complete==="boolean"&&(activity.provenance.complete===true||typeof activity.provenance?.completenessCaveat==="string")};
  return {...step,requiredStep1GatesPassed:Object.values(step).every(Boolean),sourceRuntimeBound:source.sourceRuntimeBound,candidatePromotionEligible:false,
    routePositive:0,routeEvidenceStatus:"unknown",evidenceComplete:false,executableNow:0,signedActionJustified:false,vulnerabilityPromoted:false};
}

function markdown(a){
  const inv=a.adapter.inventory.map(x=>`| ${x.chain} | ${x.owners.map(y=>`\`${y}\``).join("<br>")||"none"} | ${x.tokens.map(y=>`\`${y.address}\``).join("<br>")||"none"} |`).join("\n");
  const roles=a.ethereumState.roleCodeIdentities.map(x=>`| ${x.roles.join(", ")} | \`${x.address}\` | ${x.codeType||x.status} | ${x.codeBytes??"—"} | ${x.delegationTarget?`\`${x.delegationTarget}\``:"—"} |`).join("\n");
  const custody=a.ethereumState.custodyAndAccounting.map(x=>`| ${x.index} | \`${x.token}\` | ${x.bridgeLockedAccounting.formatted??"unavailable"} | ${(x.proxyTokenBalance||x.proxyNativeBalance)?.formatted??"unavailable"} | ${(x.vaultTokenBalance||x.vaultNativeBalance)?.formatted??"unavailable"} | ${x.vaultAllowanceToProxy?.formatted??x.vaultAllowanceToProxy?.status} |`).join("\n");
  const matrix=a.requestFieldBindingMatrix.map(x=>`| ${x.field} | ${x.digestBinding} | ${x.semantics} |`).join("\n");
  const cand=a.sourceCandidates.map(x=>`| ${x.branch} | ${x.sourceProperty} | ${x.deployedImpact} | ${x.roleRequired} | ${x.prerequisites} |`).join("\n");
  const plan=a.stagedOwnerPlan,planLines=[`Ethereum P0: ${plan.ethereumAdapterOwners.map(x=>`\`${x.address}\` (${x.classification})`).join("; ")}`,`Merlin next: ${plan.merlinAdapterOwners.map(x=>`\`${x.address}\``).join(", ")}`,`Remaining chains staged: ${Object.entries(plan.remainingChains).map(([c,v])=>`${c}=${v.length}`).join("; ")}`];
  return `# Free Protocol Step1 — reviewed read-only discovery\n\n**Classification:** ${a.classification}\n\nDeFiLlama attribution is not official identity or deployment equivalence. Except for \`${PROXY}\`, independently characterized here, inventory entries remain **adapter-owner addresses** and are not called proxies.\n\n## Identity and complete attributed inventory\n\nLocal id/slug/category/adapter gates passed. Adapter commit \`${a.adapter.provenance.commit}\`; adapter response SHA-256 \`${a.adapter.provenance.adapterResponseSha256}\`.\n\n| Adapter chain key | Adapter-owner addresses | Token addresses |\n|---|---|---|\n${inv}\n\n## Characterized Ethereum attributed address\n\nBlock **25,522,168**, hash \`${PIN_HASH}\`; implementation \`${a.ethereumState.slots.implementation.address}\`; admin/beacon slots zero. App admin \`${a.ethereumState.getters.getAdmin.value}\`; vault \`${a.ethereumState.getters.getVault.value}\`; active executor count=${a.ethereumState.getters.decodedActiveExecutors.activeExecutorCount}, threshold=${a.ethereumState.getters.decodedActiveExecutors.threshold}, index=${a.ethereumState.getters.decodedActiveExecutors.executorIndex}. Exact pinned token indexes: ${a.ethereumState.getters.supportedTokenRows.map(x=>x.index).join(", ")}.\n\n### Role code identity at pin\n\nCode classification does not identify control.\n\n| Roles | Address | Code type | Bytes | EIP-7702 target |\n|---|---|---|---:|---|\n${roles}\n\n### Accounting versus custody/allowance\n\n| Index | Token | Bridge locked accounting | Proxy balance | Vault balance | allowance(vault,proxy) |\n|---:|---|---:|---:|---:|---:|\n${custody}\n\nThese are separate fixed-block observations; no control identity or remote liability equality is inferred.\n\n## Source provenance and binding\n\nProvider flags: ${JSON.stringify(a.verifiedSource.providerVerification)}. Implementation=\`${a.verifiedSource.implementation}\`; contract=${a.verifiedSource.contractName}; primary=${a.verifiedSource.primaryFile}; target=${JSON.stringify(a.verifiedSource.compilerTarget)}. Source response=\`${a.verifiedSource.transport.sourceResponseSha256}\`; ABI response=\`${a.verifiedSource.transport.abiResponseSha256}\`; metadata=\`${a.verifiedSource.metadataSha256}\`; source-file manifest=\`${a.verifiedSource.sourceFileHashManifestSha256}\`; ABI normalized=\`${a.verifiedSource.abiNormalizedSha256}\`.\n\n**Source binding:** \`${a.verifiedSource.sourceBindingStatus}\`; sourceRuntimeBound=${a.verifiedSource.sourceRuntimeBound}. Provider verification is not presented as locally reproduced cryptographic runtime binding; promotion remains blocked. Exact line evidence for AtomicLockContract, Permissions and ReqHelpers is in raw evidence.\n\n## Binding matrix\n\n| Field/property | Digest binding | Meaning |\n|---|---|---|\n${matrix}\n\n## Source candidates — no promotion\n\n| Branch | Source property | Deployed impact | Role required | Prerequisite |\n|---|---|---|---|---|\n${cand}\n\nAll are trusted-role/configuration-sensitive source candidates; none is a proven permissionless exploit.\n\n## Activity provenance\n\nLabel: **${a.activity.label}**. Records=${a.activity.records.length}; coverage=${JSON.stringify(a.activity.coverage)}. ${a.activity.provenance.completenessCaveat} Transaction response=\`${a.activity.provenance.transactionPageResponseSha256}\`; log response=\`${a.activity.provenance.logPageResponseSha256}\`. Creation input is never represented as a selector.\n\n## Enforced gates\n\n\`${JSON.stringify(a.gates)}\`\n\n## P0 Step2 plan\n\n${planLines.map(x=>`- ${x}`).join("\n")}\n- Build the fixed-block identity/topology/signature-domain matrix for all five Ethereum adapter-owner addresses, then Merlin A6E0 and all remaining owners.\n- Compile/reproduce executable runtimes before candidate promotion; recover histories, roles, token maps and domains; only then run local-fork replay tests when prerequisites match.\n\n## Safety/integrity\n\nPublic GET and read-only RPC only. No endpoint inventories, env/keys, signing, transaction, fork or external mutation. RPC provider URLs are not emitted. Run/generation ID \`${a.runId}\`; detached manifest is written last.\n`;
}
function handoff(a){return `# Coordinator Free Protocol Step1 handoff — 2026-07-13\n\n## Classification\n\n**${a.classification}**\n\nInventory: chains=${a.metrics.adapterChains}, adapter-owner addresses=${a.metrics.adapterOwners}, Ethereum=${a.metrics.ethereumOwners}, Merlin=${a.metrics.merlinOwners}, token entries=${a.metrics.adapterTokenEntries}. All entries remain adapter-owner addresses except \`${PROXY}\`, independently characterized as an EIP-1967 UUPS proxy at block ${PIN}. The five Ethereum owners include \`0xeea3a032f381ab1e415e82fe08ebeb20f513c42c\`.\n\n## Gates/source binding\n\n\`${JSON.stringify(a.gates)}\`\n\nSource binding=\`${a.verifiedSource.sourceBindingStatus}\`; sourceRuntimeBound=${a.verifiedSource.sourceRuntimeBound}. Source-response ABI=\`${a.verifiedSource.sourceResponseAbiNormalizedSha256}\`; separate-endpoint ABI=\`${a.verifiedSource.separateEndpointAbiNormalizedSha256}\`; agreement=${a.verifiedSource.sourceAbiAgreement}. Candidate promotion remains blocked. Role code classifications: ${a.ethereumState.roleCodeIdentities.map(x=>`${x.roles.join("+")}:${x.codeType}`).join("; ")}.\n\n## P0\n\nFixed-block identity/topology/signature-domain matrix for all five Ethereum adapter-owner addresses; then all four Merlin owners (A6E0 first) and remaining chains. Compile/reproduce runtimes, recover histories/roles/domains and reconcile custody/liabilities before any local-fork replay test. No candidate is promoted.\n\n## Safety/integrity\n\nOnly the declared local handoff/artifact files were written; no claims, inbox, heartbeat, external chain state, or external system state was modified. The run ID is structural; if mutable network transport changes alter raw bytes while that ID remains the same, the detached manifest binds the exact generation bytes. Run ID \`${a.runId}\`.\n`}

function toolchainInputs(){const out={node:process.version,ethersPackage:"tools/package.json dependency"};for(const [id,file] of [["packageJson",PACKAGE_JSON],["packageLock",PACKAGE_LOCK]])if(fs.existsSync(file)){const b=fs.readFileSync(file);out[id]={file:rel(file),sha256:sha256(b),bytes:b.length}}return out}
function writeBundle(artifact){
  const raw=Buffer.from(`${JSON.stringify(artifact,null,2)}\n`),report=Buffer.from(markdown(artifact)),handoffBody=Buffer.from(handoff(artifact)),scanner=fs.readFileSync(__filename);
  const manifestObject={schemaVersion:1,runId:artifact.runId,generationId:artifact.generationId,fixedGenerationDateMarker:FIXED_GENERATED_AT,fixedGenerationDateMarkerQualification:"fixed marker; explicitly not retrieval time",detachedManifest:true,manifestSelfHashIncluded:false,
    files:{scanner:{file:rel(__filename),sha256:sha256(scanner),bytes:scanner.length},raw:{file:rel(OUT),sha256:sha256(raw),bytes:raw.length},report:{file:rel(REPORT),sha256:sha256(report),bytes:report.length},handoff:{file:rel(HANDOFF),sha256:sha256(handoffBody),bytes:handoffBody.length}},toolchain:artifact.inputs.toolchain};
  const manifest=Buffer.from(`${JSON.stringify(manifestObject,null,2)}\n`),entries=[[OUT,raw],[REPORT,report],[HANDOFF,handoffBody],[MANIFEST,manifest]],temps=[];
  try{for(const [file,data] of entries){const temp=`${file}.tmp-${process.pid}`;fs.writeFileSync(temp,data,{flag:"wx"});temps.push([temp,file])}for(const [temp,file] of temps)fs.renameSync(temp,file)}catch(e){for(const [temp] of temps)try{if(fs.existsSync(temp))fs.unlinkSync(temp)}catch{}throw e}
  return manifestObject;
}

async function main(){
  const local=loadIdentity();
  const adapter=await fetchAdapter(); // Identity/adapter gates fail closed before endpoint/source conclusions.
  const [source,selected]=await Promise.all([sourceEvidence(),selectProvider()]);
  const state=await queryState(selected,source.abi),activity=await activityEvidence(source.abi,selected),plan=stagedPlan(adapter),gates=gatesFor(local,adapter,state,source.persisted,activity);
  if(!gates.requiredStep1GatesPassed)throw new Error(`required Step1 evidence gates failed: ${Object.entries(gates).filter(([,v])=>v===false).map(([k])=>k).join(",")}`);
  const networkTransportHashes={adapterCommitResponse:adapter.provenance.commitResponseSha256,adapterResponse:adapter.provenance.adapterResponseSha256,coreAssetsResponse:adapter.provenance.coreAssetsResponseSha256,
    sourceResponse:source.persisted.transport.sourceResponseSha256,abiResponse:source.persisted.transport.abiResponseSha256,activityTransactionPageResponse:activity.provenance.transactionPageResponseSha256,activityLogPageResponse:activity.provenance.logPageResponseSha256};
  const mutableTransportFields=Object.keys(networkTransportHashes).sort().map(k=>`inputs.networkTransportHashes.${k}`);
  const structuralGenerationInputs={scanner:sha256(fs.readFileSync(__filename)),local:local.input.sha256,adapterCommit:adapter.provenance.commit,adapter:adapter.provenance.adapterResponseSha256,
    coreAssets:adapter.provenance.coreAssetsResponseSha256,sourceFileManifest:source.persisted.sourceFileHashManifestSha256,sourceResponseAbiNormalized:source.persisted.sourceResponseAbiNormalizedSha256,separateEndpointAbiNormalized:source.persisted.separateEndpointAbiNormalizedSha256,pin:`${PIN}:${PIN_HASH}`,
    state:hashCanonical({slots:state.slots,code:state.code,getters:state.getters,roles:state.roleCodeIdentities,custody:state.custodyAndAccounting}),
    activityStructure:hashCanonical({records:activity.records,coverage:activity.coverage,sampleRule:activity.provenance.sampleRule,complete:activity.provenance.complete})};
  const runId=`free-step1-${hashCanonical(structuralGenerationInputs).slice(0,20)}`;
  const metrics={adapterChains:adapter.inventory.length,adapterOwners:adapter.inventory.reduce((n,x)=>n+x.owners.length,0),ethereumOwners:adapter.inventory.find(x=>x.chain==="ethereum").owners.length,
    merlinOwners:adapter.inventory.find(x=>x.chain==="merlin").owners.length,remainingChainOwners:adapter.inventory.filter(x=>!["ethereum","merlin"].includes(x.chain)).reduce((n,x)=>n+x.owners.length,0),
    adapterTokenEntries:adapter.inventory.reduce((n,x)=>n+x.tokens.length,0),sourceFiles:source.persisted.sourceFiles.length,exactSourceEvidence:source.persisted.exactSourceEvidence.length,
    candidateCount:candidates.length,pinnedTokenRows:state.getters.supportedTokenRows.length,roleCodeRows:state.roleCodeIdentities.length,activityRecords:activity.records.length};
  const artifact={schemaVersion:2,generatedAt:FIXED_GENERATED_AT,generatedAtQualification:"fixed deterministic run-date marker; not retrieval time",runId,generationId:runId,classification:CLASSIFICATION,
    scanner:rel(__filename),safety:{externalStateMutation:false,publicFallbackUrlsEmbeddedInScanner:true,rpcProviderUrlsEmittedToGeneratedEvidence:false,endpointInventoryFilesRead:false,envFilesRead:false,keysOrSecretsRead:false,
      transactions:false,signing:false,forks:false,wallets:false,readOnlyMethods:["public HTTP GET","eth_chainId","eth_getBlockByNumber","eth_getStorageAt","eth_getCode","eth_call","eth_getBalance","eth_getTransactionReceipt","public explorer transaction/log GET queries"],
      localArtifactWriteScope:[rel(OUT),rel(REPORT),rel(HANDOFF),rel(MANIFEST)]},
    inputs:{localDefiLlama:local.input,toolchain:toolchainInputs(),networkTransportHashes,structuralGenerationInputs},protocolIdentity:local.identity,adapter,stagedOwnerPlan:plan,
    ethereumState:state,verifiedSource:source.persisted,activity,trustBoundaries:trustBoundaries(state),requestFieldBindingMatrix:bindingMatrix,sourceCandidates:candidates,gates,
    next:["P0 fixed-block identity/topology/signature-domain matrix for all five Ethereum adapter-owner addresses, then all four Merlin owners and remaining chains.","Compile/reproduce executable runtimes before promotion; recover deployment/upgrade/token/role/domain histories.","Reconcile bridge accounting with proxy/vault balances, allowances and remote liabilities; establish native index-65 usage.","Only after prerequisites match, test replay hypotheses on local forks."],metrics,
    determinism:{generatedAtFixed:true,structuralGenerationIdExcludesRawTransportHashes:true,structuralRunIdQualification:"the run ID binds normalized structural inputs, not mutable network transport bytes; if transport changes alter generated raw bytes while the structural ID remains the same, the detached manifest binds the exact generation bytes",mutableUpstreamRetrieval:"commit resolution, adapter/core assets, source, ABI, and activity responses are mutable upstream transport inputs",mutableTransportFields,mutableTransportFieldsExhaustive:true,retrievalTimesOmitted:true,detachedManifestWrittenLast:true}};
  const manifest=writeBundle(artifact);
  console.log(`Free Protocol Step1 runId=${runId}`);console.log(`classification=${CLASSIFICATION}`);console.log(`gates=${JSON.stringify(gates)}`);console.log(`sourceBinding=${source.persisted.sourceBindingStatus}`);console.log(`counts=${JSON.stringify(metrics)}`);console.log(`roleCodes=${JSON.stringify(state.roleCodeIdentities.map(x=>({roles:x.roles,type:x.codeType})))}`);console.log(`outputHashes=${JSON.stringify(Object.fromEntries(Object.entries(manifest.files).map(([k,v])=>[k,v.sha256])))}`);
}
main().catch(e=>{console.error(`Free Protocol Step1 failed closed: ${String(e.message||e).slice(0,240)}`);process.exitCode=1});
