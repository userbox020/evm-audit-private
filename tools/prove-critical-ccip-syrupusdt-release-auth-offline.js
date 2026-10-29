#!/usr/bin/env node
"use strict";

// Offline-only exact-build proof and package revision for the authorized CCIP syrupUSDT review.
// This tool intentionally contains no fetch/provider/RPC implementation.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Interface, getAddress, keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const TARGET = "targets/dolomite-margin-modules";
const PACKAGE_ROOT = `${TARGET}/node_modules/@chainlink/contracts-ccip`;
const MAIN_SOURCE = "src/v0.8/ccip/pools/LockReleaseTokenPool.sol";
const TOKEN_POOL_SOURCE = "src/v0.8/ccip/pools/TokenPool.sol";
const ABI_FILE = `${PACKAGE_ROOT}/abi/v0.8/LockReleaseTokenPool.json`;
const PACKAGE_FILE = `${PACKAGE_ROOT}/package.json`;
const LOCK_FILE = `${TARGET}/yarn.lock`;
const COMPILER_FILE = `${TARGET}/node_modules/hardhat/node_modules/solc/soljson.js`;
const COMPILER_MODULE = `${TARGET}/node_modules/hardhat/node_modules/solc`;

const TOOL = "tools/prove-critical-ccip-syrupusdt-release-auth-offline.js";
const SCANNER = "tools/scan-critical-ccip-syrupusdt-release-auth.js";
const RAW = "reports/raw/fast/critical-ccip-syrupusdt-release-auth.json";
const PROOF = "reports/raw/fast/critical-ccip-syrupusdt-release-auth-offline-build.json";
const MANIFEST = "reports/raw/fast/critical-ccip-syrupusdt-release-auth-manifest.json";
const REPORT = "reports/critical-ccip-syrupusdt-release-auth.md";
const INBOX = "coordination/inbox/critical/2026-07-18-critical-ccip-syrupusdt-release-auth.json";
const HANDOFF = "coordination/handoffs/2026-07-18-critical-ccip-syrupusdt-release-auth-handoff.md";
const REVISION = "oracle-offline-local-exact-build-r2";
const PREDECESSOR_CLASSIFICATION = "INCOMPLETE/WATCH/AUTHORIZATION-SUBBRANCH-NOT-CLOSEABLE";
const CLEAN_CLASSIFICATION = "CLEAN/AUTHORIZATION-SUBBRANCH-CLOSED";

const EXPECTED_PACKAGE_VERSION = "1.5.1-beta.2";
const EXPECTED_COMPILER = "0.8.26+commit.8a97fa7a";
const EXPECTED_RUNTIME_BYTES = 19030;
const EXPECTED_RUNTIME_HASH = "0x35b0c29a6df7d079a232f2d36da03cd46876c7b6c3ea8b974479df8474c2d09f";
const EXPECTED_RELEASE_SELECTOR = "0x39077537";
const POOL = getAddress("0xDE76A096C5eadDdf97Af3fE15ee49d32AEDa9822");
const TOKEN = getAddress("0x356B8d89c1e1239Cbbb9dE4815c39A1474d5BA7D");
const RMN = getAddress("0x411dE17f12D1A34ecC7F45f49844626267c75e81");

const SETTINGS_BASE = {
  optimizer: { enabled: true, runs: 1000000 },
  viaIR: true,
  metadata: { bytecodeHash: "none", appendCBOR: true },
};
const IMMUTABLE_VALUES = {
  i_acceptLiquidity: { type: "bool", value: false },
  i_token: { type: "address", value: TOKEN },
  i_tokenDecimals: { type: "uint8", value: 6 },
  i_rmnProxy: { type: "address", value: RMN },
  i_allowlistEnabled: { type: "bool", value: false },
};

function abs(rel) { return path.join(ROOT, ...rel.split("/")); }
function read(rel) { return fs.readFileSync(abs(rel)); }
function text(rel) { return read(rel).toString("utf8"); }
function json(rel) { return JSON.parse(text(rel)); }
function sha256(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function record(rel) { const data = read(rel); return { path: rel, bytes: data.length, sha256: sha256(data) }; }
function write(rel, value) {
  const allowed = new Set([RAW, PROOF, MANIFEST, REPORT, INBOX, HANDOFF]);
  if (!allowed.has(rel)) throw new Error(`write outside owned offline package refused: ${rel}`);
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), value, "utf8");
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function stableJson(value) { return JSON.stringify(stable(value)); }
function predecessorClassification(raw) {
  const retained = raw?.offlineRevision?.priorClassification;
  if (typeof retained === "string" && retained && retained !== CLEAN_CLASSIFICATION) return retained;
  if (typeof raw?.classification === "string" && raw.classification && raw.classification !== CLEAN_CLASSIFICATION) return raw.classification;
  return PREDECESSOR_CLASSIFICATION;
}
function encodeWord(spec) {
  if (spec.type === "address") return Buffer.from(spec.value.slice(2).padStart(64, "0"), "hex");
  if (spec.type === "bool") return Buffer.from((spec.value ? "1" : "0").padStart(64, "0"), "hex");
  if (spec.type === "uint8") return Buffer.from(BigInt(spec.value).toString(16).padStart(64, "0"), "hex");
  throw new Error(`unsupported immutable type ${spec.type}`);
}
function normalizeSource(content) {
  const needle = "pragma solidity 0.8.24;";
  const replacement = "pragma solidity ^0.8.24;";
  let count = 0;
  const normalized = content.replace(/pragma solidity 0\.8\.24;/g, () => { count++; return replacement; });
  return { normalized, count, needle, replacement };
}
function importsOf(content) {
  return [...content.matchAll(/import\s+(?:[^"']*?from\s+)?["']([^"']+)["']\s*;/g)].map((m) => m[1]);
}
function sourceClosure() {
  const queue = [MAIN_SOURCE];
  const seen = new Set();
  const sources = {};
  const records = [];
  while (queue.length) {
    const unit = queue.shift().replace(/\\/g, "/");
    if (seen.has(unit)) continue;
    seen.add(unit);
    const rel = `${PACKAGE_ROOT}/${unit}`;
    if (!fs.existsSync(abs(rel))) throw new Error(`missing imported source ${unit}`);
    const original = text(rel);
    const normalized = normalizeSource(original);
    sources[unit] = { content: normalized.normalized };
    const imports = importsOf(original);
    for (const imported of imports) {
      if (!imported.startsWith(".")) throw new Error(`non-relative import outside shipped package closure: ${unit} -> ${imported}`);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(unit), imported));
      if (resolved.startsWith("../")) throw new Error(`import escapes shipped package: ${unit} -> ${imported}`);
      queue.push(resolved);
    }
    records.push({
      path: rel,
      sourceUnit: unit,
      bytes: Buffer.byteLength(original),
      originalSha256: sha256(Buffer.from(original)),
      normalizedBytes: Buffer.byteLength(normalized.normalized),
      normalizedSha256: sha256(Buffer.from(normalized.normalized)),
      normalizationCount: normalized.count,
      imports,
    });
  }
  records.sort((a, b) => a.sourceUnit.localeCompare(b.sourceUnit));
  const sortedSources = Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)));
  return { sources: sortedSources, records, normalizationCount: records.reduce((n, row) => n + row.normalizationCount, 0) };
}
function astNames(output) {
  const names = new Map();
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.nodeType === "VariableDeclaration" && Number.isInteger(node.id) && node.name) names.set(String(node.id), node.name);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  }
  for (const row of Object.values(output.sources || {})) walk(row.ast);
  return names;
}
function compile(solc, closure, evmVersion) {
  const input = {
    language: "Solidity",
    sources: closure.sources,
    settings: {
      ...SETTINGS_BASE,
      evmVersion,
      outputSelection: {
        "*": {
          "": ["ast"],
          "*": ["abi", "metadata", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"],
        },
      },
    },
  };
  const inputText = JSON.stringify(input);
  const outputText = solc.compile(inputText);
  const output = JSON.parse(outputText);
  const errors = (output.errors || []).filter((row) => row.severity === "error");
  const warnings = (output.errors || []).filter((row) => row.severity === "warning");
  if (errors.length) throw new Error(`solc ${evmVersion} failed: ${errors.map((x) => x.formattedMessage || x.message).join(" | ")}`);
  const artifact = output.contracts?.[MAIN_SOURCE]?.LockReleaseTokenPool;
  if (!artifact) throw new Error(`LockReleaseTokenPool artifact absent for ${evmVersion}`);
  const object = artifact.evm.deployedBytecode.object;
  if (!/^[0-9a-fA-F]+$/.test(object)) throw new Error(`invalid deployed bytecode object for ${evmVersion}`);
  const names = astNames(output);
  const refs = artifact.evm.deployedBytecode.immutableReferences || {};
  const filled = Buffer.from(object, "hex");
  const immutableReferences = [];
  for (const [astId, locations] of Object.entries(refs).sort(([a], [b]) => Number(a) - Number(b))) {
    const name = names.get(astId) || null;
    const spec = name ? IMMUTABLE_VALUES[name] : null;
    if (!spec) throw new Error(`unmapped compiler immutable astId=${astId} name=${name}`);
    const word = encodeWord(spec);
    for (const location of locations) {
      const length = Number(location.length);
      const start = Number(location.start);
      if (!Number.isInteger(start) || !Number.isInteger(length) || length <= 0 || start + length > filled.length || length > word.length) throw new Error(`bad immutable reference ${name}@${start}+${length}`);
      word.subarray(word.length - length).copy(filled, start);
      immutableReferences.push({ astId, name, type: spec.type, value: String(spec.value), start, length });
    }
  }
  const metadata = Buffer.from(artifact.metadata || "", "utf8");
  return {
    evmVersion,
    inputSha256: sha256(Buffer.from(inputText)),
    outputSha256: sha256(Buffer.from(outputText)),
    compilerErrors: 0,
    compilerWarnings: warnings.length,
    warningTypes: [...new Set(warnings.map((x) => x.errorCode || x.type || "warning"))].sort(),
    unfilledRuntimeBytes: object.length / 2,
    unfilledRuntimeKeccak256: keccak256(`0x${object}`),
    filledRuntimeBytes: filled.length,
    filledRuntimeKeccak256: keccak256(`0x${filled.toString("hex")}`),
    metadataBytes: metadata.length,
    metadataSha256: sha256(metadata),
    immutableReferences,
    immutableAstIds: Object.keys(refs).length,
    immutableReferenceCount: immutableReferences.length,
    abiEntries: artifact.abi.length,
    object,
    filled,
    refs,
  };
}
function stripBuild(row) {
  const { object, filled, refs, ...out } = row;
  return out;
}
function exactLine(content, needle) {
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`source marker absent: ${needle}`);
  return { line: index + 1, text: lines[index].trim() };
}
function exactLineScoped(content, start, end, needle) {
  if (start < 0 || end <= start) throw new Error(`invalid source scope for marker: ${needle}`);
  const index = content.indexOf(needle, start);
  if (index < start || index >= end) throw new Error(`scoped source marker absent: ${needle}`);
  const line = content.slice(0, index).split(/\r?\n/).length;
  const lineEnd = content.indexOf("\n", index);
  return { line, text: content.slice(index, lineEnd < 0 ? content.length : lineEnd).trim() };
}
function callOrderProof(closure) {
  const lock = closure.sources[MAIN_SOURCE]?.content || "";
  const token = closure.sources[TOKEN_POOL_SOURCE]?.content || "";
  const releaseStart = lock.indexOf("function releaseOrMint(");
  const releaseEnd = lock.indexOf("/// @inheritdoc IERC165", releaseStart);
  const release = lock.slice(releaseStart, releaseEnd);
  const validateStart = token.indexOf("function _validateReleaseOrMint(");
  const validateEnd = token.indexOf("// ================================================================", validateStart);
  const validate = token.slice(validateStart, validateEnd);
  const offRampStart = token.indexOf("function _onlyOffRamp(");
  const offRampEnd = token.indexOf("// ================================================================", offRampStart);
  const offRamp = token.slice(offRampStart, offRampEnd);
  const indexes = {
    release: {
      validate: release.indexOf("_validateReleaseOrMint(releaseOrMintIn)"),
      convert: release.indexOf("_calculateLocalAmount(releaseOrMintIn.amount"),
      transfer: release.indexOf("safeTransfer(releaseOrMintIn.receiver, localAmount)"),
    },
    validate: {
      token: validate.indexOf("isSupportedToken(releaseOrMintIn.localToken)"),
      rmn: validate.indexOf("isCursed(bytes16(uint128(releaseOrMintIn.remoteChainSelector)))"),
      offRamp: validate.indexOf("_onlyOffRamp(releaseOrMintIn.remoteChainSelector)"),
      sourcePool: validate.indexOf("isRemotePool(releaseOrMintIn.remoteChainSelector, releaseOrMintIn.sourcePoolAddress)"),
      rateLimit: validate.indexOf("_consumeInboundRateLimit(releaseOrMintIn.remoteChainSelector, releaseOrMintIn.amount)"),
    },
    offRamp: {
      supportedChain: offRamp.indexOf("isSupportedChain(remoteChainSelector)"),
      routerIsOffRamp: offRamp.indexOf("s_router.isOffRamp(remoteChainSelector, msg.sender)"),
    },
  };
  const allPresent = Object.values(indexes).every((group) => Object.values(group).every((x) => x >= 0));
  const exact = allPresent
    && indexes.release.validate < indexes.release.convert && indexes.release.convert < indexes.release.transfer
    && indexes.validate.token < indexes.validate.rmn && indexes.validate.rmn < indexes.validate.offRamp
    && indexes.validate.offRamp < indexes.validate.sourcePool && indexes.validate.sourcePool < indexes.validate.rateLimit
    && indexes.offRamp.supportedChain < indexes.offRamp.routerIsOffRamp;
  const references = {
    lockRelease: [
      exactLine(lock, "function releaseOrMint("),
      exactLine(lock, "_validateReleaseOrMint(releaseOrMintIn);"),
      exactLine(lock, "_calculateLocalAmount(releaseOrMintIn.amount"),
      exactLine(lock, "getToken().safeTransfer(releaseOrMintIn.receiver, localAmount);"),
    ],
    tokenPool: [
      exactLine(token, "function _validateReleaseOrMint("),
      exactLine(token, "isSupportedToken(releaseOrMintIn.localToken)"),
      exactLine(token, "isCursed(bytes16(uint128(releaseOrMintIn.remoteChainSelector)))"),
      exactLine(token, "_onlyOffRamp(releaseOrMintIn.remoteChainSelector);"),
      exactLine(token, "isRemotePool(releaseOrMintIn.remoteChainSelector, releaseOrMintIn.sourcePoolAddress)"),
      exactLine(token, "_consumeInboundRateLimit(releaseOrMintIn.remoteChainSelector, releaseOrMintIn.amount);"),
      exactLine(token, "function _onlyOffRamp("),
      exactLineScoped(token, offRampStart, offRampEnd, "if (!isSupportedChain(remoteChainSelector)) revert ChainNotAllowed(remoteChainSelector);"),
      exactLine(token, "if (!s_router.isOffRamp(remoteChainSelector, msg.sender))"),
    ],
  };
  return {
    exact,
    sequence: ["releaseOrMint", "_validateReleaseOrMint", "token check", "RMN curse check", "_onlyOffRamp", "supported-chain check", "router.isOffRamp", "source-pool validation", "inbound rate limit", "amount conversion", "token transfer"],
    indexes,
    references,
  };
}
function renderReport(raw, proof) {
  const call = raw.releaseOrMintProbe;
  const build = proof.build;
  const exactVersions = build.attempts.filter((x) => x.exactDeployedRuntime).map((x) => x.evmVersion).join(", ");
  return `# CCIP Ethereum syrupUSDT LockRelease Authorization Boundary — Offline Exact-Build Revision\n\nSignal: ⚪ CLEAN — **CLEAN/AUTHORIZATION-SUBBRANCH-CLOSED**.\n\nOverall CCIP classification remains **INCOMPLETE/WATCH/COVERAGE_OPEN**; this clean result is limited to the outsider \`releaseOrMint\` authorization subbranch. Global route/executable/signing remains \`0/0/false\`.\n\n## Revision and fixed evidence\n\n- Revision: \`${REVISION}\`; run ID: \`${raw.runId}\`.\n- Preserved predecessor classification: \`${raw.offlineRevision.priorClassification}\` (idempotent across same-revision reruns).\n- Existing finalized-selected pin retained without network access: Ethereum configured chain ID \`1\`, block \`${raw.pin.blockNumberDecimal}\` / \`${raw.pin.blockHash}\`; terminal same-number hash recheck from the original transcript: \`${raw.pin.terminalSameHash}\`.\n- Chain ID \`1\` is configuration context only and was not queried or transcript-bound. Offline revision network requests: \`0\`.\n- Pool runtime: \`${raw.pool.runtime.bytes}\` bytes / \`${raw.pool.runtime.keccak256}\`; direct deployment with zero implementation/admin/beacon slots.\n\n## Local exact-build proof\n\n- Package: \`@chainlink/contracts-ccip@${proof.package.version}\`; package manifest SHA-256 \`${proof.package.packageJson.sha256}\`; yarn lock SHA-256 \`${proof.package.lock.sha256}\`.\n- Shipped ABI: \`${ABI_FILE}\`; SHA-256 \`${proof.package.abi.sha256}\`; canonical \`releaseOrMint((bytes,uint64,address,uint256,address,bytes,bytes,bytes))\` selector \`${proof.package.abi.releaseOrMintSelector}\`.\n- Compiler: \`${proof.compiler.version}\`; soljson SHA-256 \`${proof.compiler.soljson.sha256}\`; bytes \`${proof.compiler.soljson.bytes}\`.\n- Settings retained: optimizer enabled / runs \`1000000\`, \`viaIR=true\`, \`metadata.bytecodeHash=none\`, \`appendCBOR=true\`; exact EVM-version builds: \`${exactVersions}\`.\n- Semantically inert in-memory normalization: \`pragma solidity 0.8.24;\` → \`pragma solidity ^0.8.24;\`; ${proof.sourceClosure.normalizationCount} replacement(s) across ${proof.sourceClosure.fileCount} complete recursively imported source files. Package files were not modified.\n- Compiler-reported immutable references: ${build.immutableAstIds} AST IDs / ${build.immutableReferenceCount} placements. Filled values: acceptLiquidity=false, token=${TOKEN}, decimals=6, RMN=${RMN}, allowlistEnabled=false.\n- Exact result: filled runtime \`${build.deployedRuntimeBytes}\` bytes / \`${build.deployedRuntimeKeccak256}\`; byte-for-byte equality with the retained deployed runtime: \`${build.exactDeployedRuntime}\`. Deterministic repeat: \`${build.deterministicRepeat}\`.\n- External verified-source provenance remains \`null\`; the conclusion relies on the hash-bound local shipped package closure and exact compiler reproduction, not an external explorer/source attestation.\n\n## Exact call-order binding\n\nThe exact-build-equivalent source proves:\n\n\`releaseOrMint → _validateReleaseOrMint → token check → RMN → _onlyOffRamp → supported chain → router.isOffRamp → source pool validation → rate limit → amount conversion → transfer\`.\n\nRelevant shipped-source lines: \`LockReleaseTokenPool.sol:64-74\`, \`TokenPool.sol:223-235\`, and \`TokenPool.sol:598-602\`. The supported-chain reference is the scoped \`_onlyOffRamp\` line \`601\`: \`if (!isSupportedChain(remoteChainSelector)) revert ChainNotAllowed(remoteChainSelector);\`. Authorization therefore precedes source-pool validation, rate-limit consumption, conversion, and transfer.\n\n## Retained outsider probe\n\n- Returned supported uncursed selector: \`${raw.selectedChain.selector}\`; router: \`${raw.selectedChain.routerAddress}\`; \`isOffRamp(selector, outsider)=${raw.selectedChain.outsiderIsOffRamp}\`.\n- Exact calldata selector: \`${call.selector}\`; one outsider \`eth_call\` only.\n- Exact revert bytes: \`${call.rawReturnOrRevertBytes}\`.\n- Decoded: \`CallerIsNotARampOnRouter(0x000000000000000000000000000000000000dEaD)\`.\n- Classification: \`${call.classification}\`; authorizationSubbranchClosed=\`${call.authorizationSubbranchClosed}\`.\n\n## Legacy supersession\n\n\`reports/raw/fast/full-attack-test-ccip.json\` remains superseded, not deleted. Its wrong \`releaseOrMint(bytes)\` ABI and null/error-swallowing RPC logic cannot support POTENTIAL_DRAIN, pause, or unpause claims.\n\n## Remaining overall CCIP gaps\n\n${raw.overallCcipGaps.map((x) => `- ${x}`).join("\n")}\n\n## Defensive next action\n\nMonitor pool runtime, router, RMN, supported-chain configuration, and package/build drift. Reopen this subbranch only on drift or contradictory evidence; continue separate CCIP coverage for the listed gaps. No fork, transaction, or signed action is justified.\n`;
}
function makeInbox(raw, proof) {
  return {
    findingId: "ccip-ethereum-syrupusdt-release-auth-boundary",
    agentId: "critical-ccip-syrupusdt-auth-20260718",
    role: "critical-research",
    status: "route-negative",
    runId: raw.runId,
    revision: REVISION,
    classification: raw.classification,
    overallCcipClassification: raw.overallCcipClassification,
    signal: "CLEAN",
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    summary: "Offline local exact build reproduces the retained deployed runtime byte-for-byte after compiler-reported immutable filling; exact source order places router off-ramp authorization before source-pool validation and value motion, and the outsider call returned the canonical caller error.",
    fixedBlock: { number: raw.pin.blockNumberDecimal, hash: raw.pin.blockHash, finalizedSelected: true, terminalSameHash: raw.pin.terminalSameHash, chainIdConfigured: 1, chainIdTranscriptBound: false },
    selectedSelector: raw.selectedChain,
    exactCallClassification: raw.releaseOrMintProbe.classification,
    predecessorClassification: raw.offlineRevision.priorClassification,
    localExactBuildEquivalence: true,
    callOrderExact: true,
    externalVerifiedSourceProvenance: null,
    build: { runtimeBytes: proof.build.deployedRuntimeBytes, runtimeKeccak256: proof.build.deployedRuntimeKeccak256, exactEvmVersions: proof.build.attempts.filter((x) => x.exactDeployedRuntime).map((x) => x.evmVersion), immutableAstIds: proof.build.immutableAstIds, immutableReferenceCount: proof.build.immutableReferenceCount },
    requestCounts: raw.requestCounts,
    supersedesWithoutDeletion: ["reports/raw/fast/full-attack-test-ccip.json"],
    artifacts: [SCANNER, TOOL, RAW, PROOF, MANIFEST, REPORT, INBOX, HANDOFF],
    overallCcipGaps: raw.overallCcipGaps,
    nextAction: raw.nextAction,
  };
}
function renderHandoff(raw, proof) {
  return `# CCIP syrupUSDT release authorization handoff — offline exact-build revision\n\n- Agent/role: \`critical-ccip-syrupusdt-auth-20260718\` / \`critical-research\`\n- Run/revision: \`${raw.runId}\` / \`${REVISION}\`\n- Subbranch: **CLEAN/AUTHORIZATION-SUBBRANCH-CLOSED** (⚪ CLEAN)\n- Preserved predecessor: \`${raw.offlineRevision.priorClassification}\`\n- Overall CCIP: **INCOMPLETE/WATCH/COVERAGE_OPEN**\n- Gates: \`0/0/false\`; offline revision network requests: \`0\`\n- Pin retained: block \`${raw.pin.blockNumberDecimal}\` / \`${raw.pin.blockHash}\`; chain ID \`1\` configured, not transcript-bound\n- Build: ${proof.build.deployedRuntimeBytes} bytes / \`${proof.build.deployedRuntimeKeccak256}\`, exact=${proof.build.exactDeployedRuntime}, deterministic=${proof.build.deterministicRepeat}\n- Closure/compiler: ${proof.sourceClosure.fileCount} source files, ${proof.sourceClosure.normalizationCount} pragma normalizations, ${proof.build.immutableAstIds} immutable AST IDs / ${proof.build.immutableReferenceCount} placements, solc \`${proof.compiler.version}\`\n- Corrected scoped supported-chain reference: \`TokenPool.sol:601 if (!isSupportedChain(remoteChainSelector)) revert ChainNotAllowed(remoteChainSelector);\`\n- Exact call: \`${raw.releaseOrMintProbe.classification}\`; revert \`${raw.releaseOrMintProbe.rawReturnOrRevertBytes}\`\n- Local exact-build equivalence/call order: \`true/true\`; external verified-source provenance: \`null\`\n\n## Artifacts\n\n- \`${TOOL}\`\n- \`${SCANNER}\`\n- \`${RAW}\`\n- \`${PROOF}\`\n- \`${MANIFEST}\`\n- \`${REPORT}\`\n- \`${INBOX}\`\n- \`${HANDOFF}\`\n\n## Remaining scope\n\n${raw.overallCcipGaps.map((x) => `- ${x}`).join("\n")}\n\nThe legacy full-attack artifact remains superseded without deletion. No coordinator file was edited and the claim was not released.\n`;
}
function manifestFor(raw, proof, closure) {
  const owned = [TOOL, SCANNER, RAW, PROOF, REPORT, INBOX, HANDOFF];
  const external = [PACKAGE_FILE, ABI_FILE, LOCK_FILE, COMPILER_FILE, ...closure.records.map((x) => x.path)];
  const paths = [...new Set([...owned, ...external])];
  const records = paths.map(record);
  const aggregateSha256 = sha256(Buffer.from(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"), "utf8"));
  return {
    generatedAt: raw.generatedAt,
    runId: raw.runId,
    revision: REVISION,
    manifestVersion: 2,
    hashAlgorithm: "sha256",
    records,
    aggregateSha256,
    ownedArtifactCount: owned.length,
    externalProofInputCount: external.length,
    sourceClosureFileCount: closure.records.length,
    compilerVersion: proof.compiler.version,
    deployedRuntimeBytes: proof.build.deployedRuntimeBytes,
    deployedRuntimeKeccak256: proof.build.deployedRuntimeKeccak256,
    immutableAstIds: proof.build.immutableAstIds,
    immutableReferenceCount: proof.build.immutableReferenceCount,
    localExactBuildEquivalence: true,
    callOrderExact: true,
    externalVerifiedSourceProvenance: null,
    offlineRevisionNetworkRequests: 0,
    retainedRpcReadCount: raw.requestCounts.jsonRpc,
    retainedSourceMetadataRequestCount: raw.requestCounts.sourceMetadata,
    classification: raw.classification,
    overallCcipClassification: raw.overallCcipClassification,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
  };
}

function buildAndApply() {
  const raw = json(RAW);
  const preservedPredecessorClassification = predecessorClassification(raw);
  const deployed = Buffer.from(raw.pool.runtime.exact.slice(2), "hex");
  if (deployed.length !== EXPECTED_RUNTIME_BYTES || keccak256(`0x${deployed.toString("hex")}`) !== EXPECTED_RUNTIME_HASH) throw new Error("retained deployed runtime invariant failed");
  if (getAddress(raw.pool.getters.rmnProxy.decoded) !== RMN) throw new Error("retained RMN differs from immutable input");
  if (raw.requestCounts.jsonRpc !== 18 || raw.requestCounts.sourceMetadata !== 2) throw new Error("retained request counts changed");
  const packageJson = json(PACKAGE_FILE);
  if (packageJson.version !== EXPECTED_PACKAGE_VERSION) throw new Error("unexpected CCIP package version");
  const lock = text(LOCK_FILE);
  if (!lock.includes('version "1.5.1-beta.2"') || !lock.includes("contracts-ccip-1.5.1-beta.2.tgz#ccdaf0e74887db74f0b95acec26ac3cf440b7cda")) throw new Error("package lock binding absent");
  const shippedAbi = json(ABI_FILE);
  const iface = new Interface(shippedAbi);
  if (iface.getFunction("releaseOrMint").selector.toLowerCase() !== EXPECTED_RELEASE_SELECTOR) throw new Error("shipped ABI selector mismatch");
  const solc = require(abs(COMPILER_MODULE));
  const version = solc.version();
  if (!version.startsWith(EXPECTED_COMPILER)) throw new Error(`unexpected compiler ${version}`);
  const closure = sourceClosure();
  const order = callOrderProof(closure);
  if (!order.exact) throw new Error("exact source call-order proof failed");
  const london = compile(solc, closure, "london");
  const paris = compile(solc, closure, "paris");
  const repeat = compile(solc, closure, "london");
  const attemptsRaw = [london, paris];
  for (const attempt of attemptsRaw) {
    attempt.exactDeployedRuntime = attempt.filled.equals(deployed);
    if (attempt.filledRuntimeBytes !== EXPECTED_RUNTIME_BYTES || attempt.filledRuntimeKeccak256 !== EXPECTED_RUNTIME_HASH || !attempt.exactDeployedRuntime) throw new Error(`${attempt.evmVersion} runtime mismatch`);
  }
  const deterministicRepeat = london.inputSha256 === repeat.inputSha256
    && london.outputSha256 === repeat.outputSha256
    && london.filled.equals(repeat.filled)
    && stableJson(london.immutableReferences) === stableJson(repeat.immutableReferences);
  if (!deterministicRepeat) throw new Error("compiler determinism repeat failed");
  const immutableNames = [...new Set(london.immutableReferences.map((x) => x.name))].sort();
  if (stableJson(immutableNames) !== stableJson(Object.keys(IMMUTABLE_VALUES).sort())) throw new Error(`immutable coverage mismatch: ${immutableNames.join(",")}`);
  const proof = {
    generatedAt: raw.generatedAt,
    runId: raw.runId,
    revision: REVISION,
    mode: "offline-only",
    networkRequests: 0,
    sourceArtifact: RAW,
    chain: { configuredChainId: 1, chainIdQueried: false, chainIdTranscriptBound: false, qualification: "Ethereum chain ID is configured context; the retained transcript did not query eth_chainId" },
    package: {
      name: packageJson.name,
      version: packageJson.version,
      packageJson: record(PACKAGE_FILE),
      lock: { ...record(LOCK_FILE), exactVersionEntryPresent: true, tarballCommitFragment: "ccdaf0e74887db74f0b95acec26ac3cf440b7cda" },
      abi: { ...record(ABI_FILE), entries: shippedAbi.length, releaseOrMintSelector: EXPECTED_RELEASE_SELECTOR, canonicalSignature: "releaseOrMint((bytes,uint64,address,uint256,address,bytes,bytes,bytes))" },
    },
    compiler: {
      modulePath: COMPILER_MODULE,
      soljson: record(COMPILER_FILE),
      version,
      expectedVersion: EXPECTED_COMPILER,
      settings: { ...SETTINGS_BASE, evmVersionsVerified: ["london", "paris"] },
    },
    normalization: { from: "pragma solidity 0.8.24;", to: "pragma solidity ^0.8.24;", semanticallyInertForCompiler: true, inMemoryOnly: true, packageFilesModified: false },
    sourceClosure: {
      rootSource: MAIN_SOURCE,
      completeRecursiveRelativeImportClosure: true,
      fileCount: closure.records.length,
      normalizationCount: closure.normalizationCount,
      aggregateOriginalSha256: sha256(Buffer.from(closure.records.map((x) => `${x.sourceUnit}\0${x.originalSha256}`).join("\n"))),
      aggregateNormalizedSha256: sha256(Buffer.from(closure.records.map((x) => `${x.sourceUnit}\0${x.normalizedSha256}`).join("\n"))),
      files: closure.records,
    },
    immutableValues: IMMUTABLE_VALUES,
    build: {
      attempts: attemptsRaw.map(stripBuild),
      compileInvocationCount: 3,
      exactEvmVersions: attemptsRaw.filter((x) => x.exactDeployedRuntime).map((x) => x.evmVersion),
      deterministicRepeat,
      deterministicRepeatEvmVersion: "london",
      deployedRuntimeBytes: deployed.length,
      deployedRuntimeKeccak256: keccak256(`0x${deployed.toString("hex")}`),
      exactDeployedRuntime: true,
      immutableAstIds: london.immutableAstIds,
      immutableReferenceCount: london.immutableReferenceCount,
      immutableReferences: london.immutableReferences,
      filledRuntimeSha256: sha256(london.filled),
    },
    callOrder: order,
    provenance: {
      localPackageAndLockBound: true,
      shippedAbiBound: true,
      completeSourceClosureBound: true,
      compilerBinaryBound: true,
      localExactBuildEquivalence: true,
      externalVerifiedSourceProvenance: null,
      predecessorClassification: preservedPredecessorClassification,
      predecessorClassificationIdempotent: true,
    },
    result: { localExactBuildEquivalence: true, callOrderExact: true, authorizationBeforeSourcePoolValidationAndTransfer: true },
  };
  write(PROOF, `${JSON.stringify(proof, null, 2)}\n`);

  raw.revision = REVISION;
  raw.offlineRevision = {
    applied: true,
    networkRequests: 0,
    priorClassification: preservedPredecessorClassification,
    proofArtifact: PROOF,
    packageVersion: EXPECTED_PACKAGE_VERSION,
    compilerVersion: version,
    compilerSettings: proof.compiler.settings,
    normalization: proof.normalization,
    sourceClosureFileCount: closure.records.length,
    sourceClosureAggregateOriginalSha256: proof.sourceClosure.aggregateOriginalSha256,
    sourceClosureAggregateNormalizedSha256: proof.sourceClosure.aggregateNormalizedSha256,
    immutableAstIds: proof.build.immutableAstIds,
    immutableReferenceCount: proof.build.immutableReferenceCount,
    exactRuntimeBytes: proof.build.deployedRuntimeBytes,
    exactRuntimeKeccak256: proof.build.deployedRuntimeKeccak256,
    exactEvmVersions: proof.build.exactEvmVersions,
    deterministicRepeat: true,
  };
  raw.chain = { configuredChainId: 1, chainIdQueried: false, chainIdTranscriptBound: false, qualification: "configured Ethereum context only; no eth_chainId read exists in the retained transcript" };
  raw.signal = "⚪ CLEAN";
  raw.classification = "CLEAN/AUTHORIZATION-SUBBRANCH-CLOSED";
  raw.overallCcipClassification = "INCOMPLETE/WATCH/COVERAGE_OPEN";
  raw.source = {
    availability: "complete-local-shipped-package-closure",
    package: `@chainlink/contracts-ccip@${EXPECTED_PACKAGE_VERSION}`,
    packageLockBound: true,
    shippedAbiBound: true,
    completeImportedSourceClosure: true,
    sourceClosureFileCount: closure.records.length,
    sourceClosureAggregateOriginalSha256: proof.sourceClosure.aggregateOriginalSha256,
    sourceClosureAggregateNormalizedSha256: proof.sourceClosure.aggregateNormalizedSha256,
    normalization: proof.normalization,
    compiler: proof.compiler,
    sourceRuntimeEquivalence: null,
    externalVerifiedSourceProvenance: null,
    localExactBuildEquivalence: true,
    localExactBuildBasis: "byte-for-byte equality of compiler output after compiler-reported immutable-reference filling against retained 19,030-byte deployed runtime",
    callOrderExact: true,
    callOrder: order,
    proofArtifact: PROOF,
  };
  const closedCallClassification = "EXPECTED_AUTHORIZATION_REVERT_SUBBRANCH_CLOSED_BY_LOCAL_EXACT_BUILD";
  if (!raw.releaseOrMintProbe.priorClassification || raw.releaseOrMintProbe.priorClassification === closedCallClassification) {
    raw.releaseOrMintProbe.priorClassification = "EXPECTED_REVERT_BUT_SOURCE_RUNTIME_OR_ORDER_UNPROVEN_WATCH";
  }
  raw.releaseOrMintProbe.classification = closedCallClassification;
  raw.releaseOrMintProbe.authorizationSubbranchClosed = true;
  raw.releaseOrMintProbe.escalation = false;
  raw.blockers = [];
  raw.overallCcipGaps = [
    "No exhaustive router/off-ramp/RMN configuration or upgrade-authority review beyond the retained selected-selector outsider check.",
    "No cross-chain message/proof/domain/nonce conservation review across every supported selector and remote pool.",
    "No global LockRelease backing/liability reconciliation across remote representations.",
    "No complete privileged owner/rebalancer/rate-limit/admin/governance control assessment.",
    "External explorer/Sourcify verified-source provenance remains null; exact equivalence is local-build based.",
    "No history scan, fork, state override, transaction, signing, broadcast, or real-fund test was performed.",
  ];
  raw.nextAction = "Close only this outsider release authorization subbranch; monitor pool/router/RMN/runtime drift and continue separate read-only CCIP proof, backing, privilege, and cross-chain coverage. No fork or live action is justified.";
  raw.routePositive = 0;
  raw.executableNow = 0;
  raw.signedActionJustified = false;
  raw.safety.offlineRevisionNetworkRequests = 0;
  raw.safety.targetClaimReleased = false;
  write(RAW, `${JSON.stringify(raw, null, 2)}\n`);
  write(REPORT, renderReport(raw, proof));
  write(INBOX, `${JSON.stringify(makeInbox(raw, proof), null, 2)}\n`);
  write(HANDOFF, renderHandoff(raw, proof));
  const manifest = manifestFor(raw, proof, closure);
  write(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`offline-build PASS revision=${REVISION} closure=${closure.records.length} normalizations=${closure.normalizationCount} compiles=3 immutables=${proof.build.immutableAstIds}/${proof.build.immutableReferenceCount} runtime=${deployed.length}/${proof.build.deployedRuntimeKeccak256} evm=${proof.build.exactEvmVersions.join(",")} aggregate=${manifest.aggregateSha256}`);
}

function selfTest() {
  if (normalizeSource("pragma solidity 0.8.24;").normalized !== "pragma solidity ^0.8.24;") throw new Error("normalization self-test failed");
  const addr = encodeWord({ type: "address", value: TOKEN });
  if (addr.length !== 32 || `0x${addr.subarray(12).toString("hex")}`.toLowerCase() !== TOKEN.toLowerCase()) throw new Error("address immutable encoding failed");
  if (encodeWord({ type: "uint8", value: 6 }).at(-1) !== 6 || encodeWord({ type: "bool", value: false }).some((x) => x !== 0)) throw new Error("scalar immutable encoding failed");
  const closure = sourceClosure();
  if (!closure.records.length || !closure.sources[MAIN_SOURCE] || !closure.sources[TOKEN_POOL_SOURCE]) throw new Error("source closure self-test failed");
  const order = callOrderProof(closure);
  if (!order.exact) throw new Error("call-order self-test failed");
  const supported = order.references.tokenPool.find((row) => row.text.includes("isSupportedChain(remoteChainSelector)"));
  if (!supported || supported.line !== 601 || !supported.text.includes("ChainNotAllowed") || supported.text.includes("NonExistentChain")) throw new Error("scoped supported-chain reference self-test failed");
  if (predecessorClassification({ classification: CLEAN_CLASSIFICATION, offlineRevision: { priorClassification: PREDECESSOR_CLASSIFICATION } }) !== PREDECESSOR_CLASSIFICATION) throw new Error("retained predecessor self-test failed");
  if (predecessorClassification({ classification: CLEAN_CLASSIFICATION, offlineRevision: { priorClassification: CLEAN_CLASSIFICATION } }) !== PREDECESSOR_CLASSIFICATION) throw new Error("clean predecessor repair self-test failed");
  const iface = new Interface(json(ABI_FILE));
  if (iface.getFunction("releaseOrMint").selector.toLowerCase() !== EXPECTED_RELEASE_SELECTOR) throw new Error("ABI self-test failed");
  console.log(`self-test PASS: closure=${closure.records.length}, normalization=${closure.normalizationCount}, ABI, immutable encoding, scoped ChainNotAllowed line 601, exact call order, and idempotent predecessor`);
}
function verify() {
  const raw = json(RAW);
  const proof = json(PROOF);
  const manifest = json(MANIFEST);
  if (raw.revision !== REVISION || proof.revision !== REVISION || manifest.revision !== REVISION) throw new Error("revision mismatch");
  for (const expected of manifest.records) {
    const actual = record(expected.path);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`manifest mismatch: ${expected.path}`);
  }
  const aggregate = sha256(Buffer.from(manifest.records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"), "utf8"));
  if (aggregate !== manifest.aggregateSha256) throw new Error("manifest aggregate mismatch");
  if (!proof.result.localExactBuildEquivalence || !proof.result.callOrderExact || !proof.build.exactDeployedRuntime || !proof.build.deterministicRepeat) throw new Error("build proof flags failed");
  if (proof.build.deployedRuntimeBytes !== EXPECTED_RUNTIME_BYTES || proof.build.deployedRuntimeKeccak256 !== EXPECTED_RUNTIME_HASH) throw new Error("runtime proof mismatch");
  if (raw.classification !== "CLEAN/AUTHORIZATION-SUBBRANCH-CLOSED" || raw.overallCcipClassification !== "INCOMPLETE/WATCH/COVERAGE_OPEN") throw new Error("classification mismatch");
  if (raw.offlineRevision.priorClassification !== PREDECESSOR_CLASSIFICATION || proof.provenance.predecessorClassification !== PREDECESSOR_CLASSIFICATION || proof.provenance.predecessorClassificationIdempotent !== true) throw new Error("predecessor provenance mismatch");
  const supported = proof.callOrder.references.tokenPool.find((row) => row.text.includes("isSupportedChain(remoteChainSelector)"));
  if (!supported || supported.line !== 601 || supported.text !== "if (!isSupportedChain(remoteChainSelector)) revert ChainNotAllowed(remoteChainSelector);" || proof.callOrder.references.tokenPool.some((row) => row.text.includes("NonExistentChain"))) throw new Error("scoped supported-chain reference mismatch");
  if (!raw.releaseOrMintProbe.authorizationSubbranchClosed || !raw.source.localExactBuildEquivalence || !raw.source.callOrderExact || raw.source.externalVerifiedSourceProvenance !== null) throw new Error("source/call closure mismatch");
  if (raw.chain.configuredChainId !== 1 || raw.chain.chainIdQueried || raw.chain.chainIdTranscriptBound) throw new Error("chain-ID qualification mismatch");
  if (raw.offlineRevision.networkRequests !== 0 || proof.networkRequests !== 0 || manifest.offlineRevisionNetworkRequests !== 0) throw new Error("offline request invariant failed");
  if (raw.routePositive !== 0 || raw.executableNow !== 0 || raw.signedActionJustified !== false) throw new Error("global gate invariant failed");
  const artifacts = [RAW, PROOF, MANIFEST, REPORT, INBOX, HANDOFF].map(text).join("\n");
  if (/https?:\/\//i.test(artifacts)) throw new Error("URL/endpoint leak in generated artifacts");
  if (/(?:api[_-]?key|bearer|authorization)\s*[:=]/i.test(artifacts)) throw new Error("credential/header leak in generated artifacts");
  if (!text(REPORT).includes("Signal: ⚪ CLEAN")) throw new Error("report signal missing");
  console.log(`verify PASS revision=${REVISION} records=${manifest.records.length} aggregate=${manifest.aggregateSha256} runtime=${proof.build.deployedRuntimeBytes}/${proof.build.deployedRuntimeKeccak256} closure=${proof.sourceClosure.fileCount} immutables=${proof.build.immutableAstIds}/${proof.build.immutableReferenceCount} network=0 leak=false signal=true gates=0/0/false`);
}

const mode = process.argv[2];
if (mode === "--self-test") selfTest();
else if (mode === "--verify") verify();
else buildAndApply();
