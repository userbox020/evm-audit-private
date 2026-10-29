"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

const bnbCapture = require("./capture-venus-psr-bnb-fixed-block.js");
const bnbControls = require("./capture-venus-psr-bnb-controls.js");
const ethereumCapture = require("./capture-venus-psr-ethereum-fixed-block.js");
const arbitrumCapture = require("./capture-venus-psr-arbitrum-fixed-block.js");

const ROOT = path.resolve(__dirname, "..");
const SCHEMA = "venus-psr-state/v1";
const OUTPUT_PATH = path.join(ROOT, "reports", "monitor", "venus-psr-state.json");
const INVENTORY_PATH = path.join(ROOT, "rpc_endpoints.txt");
const LOCK_PATH = path.join(ROOT, "reports", "monitor", ".venus-psr-monitor.lock");
const MAX_STATE_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 190000;
const DEFAULT_INTERVAL_SECONDS = 3600;
const MIN_INTERVAL_SECONDS = 300;
const MAX_INTERVAL_SECONDS = 86400;
const REPARSE_POINT = 0x400;
const CATEGORY_ORDER = [
  "PSR_IDENTITY",
  "PSR_CONFIGURATION",
  "DISTRIBUTION",
  "POSITIVE_DESTINATIONS",
  "DESTINATION_CONTROLS",
  "DESTINATION_POLICY",
  "CONVERTER_NETWORK",
];
const CHAIN_ORDER = ["bnb", "ethereum", "arbitrum"];
const ETHEREUM_KEYLESS_FALLBACK = Object.freeze(["https://ethereum-rpc.publicnode.com"]);
// Reviewed per-entry access provenance (venus-psr-access-provenance/v1). The
// artifact binds the reviewed keyless publicnode endpoints for the gated
// chains; its sha256 is committed here so any content change re-gates.
const ACCESS_PROVENANCE_PATH = path.join(ROOT, "reports", "monitor", "venus-psr-access-provenance.json");
const ACCESS_PROVENANCE_COMMITMENT = Object.freeze({
  schema: "venus-psr-access-provenance/v1",
  sha256: "a6ac845aeb782e68ffbde117348b57ab32b1d10a598e31d20e0da206d41861a7",
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Approved immutable baselines. The normalized digests commit the complete
// reopening-relevant configuration produced by normalizeArtifact below.
const BASELINE_COMMITMENTS = Object.freeze({
  bnb: Object.freeze({
    schema: "venus-psr-fixed-block/v1",
    blockNumber: 114237857,
    blockHash: "0xdda5d07a1099c364086775538094c73b16b0f71f4006de6f963885e39e72a15b",
    rawSha256: "0x56f135445653a7525794e5cf17ea10dda00e0d6d3f157d887504122ef2aa6ad0",
    topologyDigest: "0xa6bba633be71acc0bacaff141d8e1e6b955ea3c2748589f33af9d47ccf6ccdc5",
    normalizedDigest: "0x02a45b9aa3eb957c5e6e712b2f3980f3a2fa79d241fbc57af133a888bebd93d9",
    supplementSha256: null,
    supplementSchema: null,
  }),
  ethereum: Object.freeze({
    schema: "venus-psr-ethereum-fixed-block/v1",
    blockNumber: 25692605,
    blockHash: "0x511a53df1021bc652932d74ade40fc010d87cf86b7502a77debf7c4cdba70157",
    rawSha256: "0x8a954ba0cad23aaae41c9d8f8ca102081410f9adcd89c95809c0fed54258353b",
    normalizedDigest: "0x4b3edd3f7b22552e7a47e75f83b7becada33b1e9f987fd72d760d23a6af3eb89",
    supplementSha256: "0xbeae1828469f64500dc78d00f7a91e187f2660fdd1c66ded599fddd41f0a3f8e",
    supplementSchema: "venus-psr-ethereum-vtreasury-source-binding/v1",
  }),
  arbitrum: Object.freeze({
    schema: "venus-psr-arbitrum-fixed-block/v1",
    blockNumber: 491551672,
    blockHash: "0xd22002f38ea67bbe511af7a329f18de4e70e97f7a31eedfff16c8a7f1f8809ca",
    rawSha256: "0x6e0208c9f9de827c1e622c4509b6591f3a86587545be7c4afa6947045d9e4bcf",
    normalizedDigest: "0x492a1389a8d1763931c60df17ff31ff488fb8c6d5fdd5a521619a4e19941322a",
    supplementSha256: "0xe94508640624e28b6e64e182e578dd55d9d27ef55c9dfac935a7749c3dede777",
    supplementSchema: "venus-psr-arbitrum-vtreasury-source-binding/v1",
  }),
});

// Approved exact BNB controls baseline and combined normalized commitment.
const BNB_CONTROL_COMMITMENT = Object.freeze({
  path: "reports/raw/fast/venus-psr-bnb-controls-fixed-block.json",
  schema: "venus-psr-bnb-controls/v1",
  blockNumber: 114237857,
  blockHash: "0xdda5d07a1099c364086775538094c73b16b0f71f4006de6f963885e39e72a15b",
  rawSha256: "0xa250869da77728f0367ac25d83b7c5b3721a660cc1fa0f54d191ceda7718472a",
  normalizedControlDigest: "0x5335acaf90769337356cdfc80bd198980d5097431239d806cd66d841f9e694ce",
});

const CHAIN_CONFIG = Object.freeze({
  bnb: {
    chainId: 56,
    name: "BNB Smart Chain",
    baseline: "reports/raw/fast/venus-psr-bnb-fixed-block.json",
    supplement: null,
    parser: bnbCapture.parseAuthorizedBnbHttpsInventory,
    executeCapture: bnbCapture.executeCapture,
  },
  ethereum: {
    chainId: 1,
    name: "Ethereum",
    baseline: "reports/raw/fast/venus-psr-ethereum-fixed-block.json",
    supplement: "reports/raw/fast/venus-psr-ethereum-vtreasury-source-binding.json",
    parser: ethereumCapture.parseAuthorizedEthereumHttpsInventory,
    executeCapture: ethereumCapture.executeCapture,
  },
  arbitrum: {
    chainId: 42161,
    name: "Arbitrum One",
    baseline: "reports/raw/fast/venus-psr-arbitrum-fixed-block.json",
    supplement: "reports/raw/fast/venus-psr-arbitrum-vtreasury-source-binding.json",
    parser: arbitrumCapture.parseAuthorizedArbitrumHttpsInventory,
    executeCapture: arbitrumCapture.executeCapture,
  },
});

class MonitorError extends Error {
  constructor(errorClass) {
    super(errorClass);
    this.errorClass = errorClass;
  }
}

function fail(errorClass) {
  throw new MonitorError(errorClass);
}

function isReparse(stats) {
  return Boolean((stats.fileAttributes || 0) & REPARSE_POINT);
}

function isoNow(now) {
  const date = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
  if (!Number.isFinite(date.getTime())) fail("TIME_INVALID");
  return date.toISOString();
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function digest(value) {
  return `0x${crypto.createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : null;
}

function hashValue(value) {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}

function address(value) {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function exactPath(root, relative) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) fail("PATH_INVALID");
  return resolved;
}

async function validateDirectoryChain(root, directory) {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail("PATH_INVALID");
  let current = resolvedRoot;
  const parts = relative ? relative.split(path.sep) : [];
  for (const part of [null, ...parts]) {
    if (part !== null) current = path.join(current, part);
    let stats;
    try { stats = await fsp.lstat(current); } catch { fail("DIRECTORY_UNAVAILABLE"); }
    if (!stats.isDirectory() || stats.isSymbolicLink() || isReparse(stats)) fail("DIRECTORY_UNSAFE");
  }
}

async function readSafeJsonRecord(root, relative, maxBytes = MAX_INPUT_BYTES) {
  const file = exactPath(root, relative);
  await validateDirectoryChain(root, path.dirname(file));
  let before;
  try {
    before = await fsp.lstat(file);
  } catch {
    fail("ARTIFACT_UNAVAILABLE");
  }
  if (!before.isFile() || before.isSymbolicLink() || isReparse(before) || before.nlink !== 1 || before.size > maxBytes) {
    fail("ARTIFACT_UNSAFE");
  }
  let handle;
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const after = await handle.stat();
    if (!after.isFile() || isReparse(after) || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino || after.size > maxBytes) {
      fail("ARTIFACT_UNSAFE");
    }
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) fail("ARTIFACT_TOO_LARGE");
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("ARTIFACT_INVALID");
    return { value, sha256: `0x${crypto.createHash("sha256").update(bytes).digest("hex")}` };
  } catch (error) {
    if (error instanceof MonitorError) throw error;
    fail("ARTIFACT_INVALID");
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function readSafeJson(root, relative, maxBytes = MAX_INPUT_BYTES) {
  return (await readSafeJsonRecord(root, relative, maxBytes)).value;
}

function supplementMap(supplement, chainId, baselineBlock) {
  if (!supplement) return new Map();
  const scope = supplement.scope;
  const runtime = supplement.exactRuntimeBinding;
  if (supplement.classification !== "SOURCE_BOUND_NONPUBLIC_SINK"
    || scope?.chainId !== chainId
    || scope?.blockNumber !== baselineBlock.number
    || lower(scope?.blockHash) !== lower(baselineBlock.hash)
    || !address(scope?.destination)
    || runtime?.capturedLengthAndSha256Exact !== true
    || !Number.isSafeInteger(runtime?.lengthBytes)
    || !hashValue(runtime?.sha256)) fail("SUPPLEMENT_INVALID");
  return new Map([[address(scope.destination), {
    classification: "SOURCE_BOUND_NONPUBLIC_SINK",
    lengthBytes: runtime.lengthBytes,
    sha256: hashValue(runtime.sha256),
  }]]);
}

function normalizeRows(distribution) {
  if (!distribution || distribution.complete !== true || !Array.isArray(distribution.rows)
    || distribution.rows.length !== distribution.capturedTotal || distribution.capturedTotal !== distribution.reportedTotal) {
    fail("DISTRIBUTION_INVALID");
  }
  const rows = distribution.rows.map((row) => {
    if (!Number.isSafeInteger(row?.index) || ![0, 1].includes(row?.schema)
      || !Number.isSafeInteger(row?.percentage) || row.percentage < 0 || row.percentage > 10000
      || !address(row?.destination)) fail("DISTRIBUTION_INVALID");
    return { index: row.index, schema: row.schema, percentage: row.percentage, destination: address(row.destination) };
  }).sort((a, b) => a.index - b.index);
  if (new Set(rows.map((row) => row.index)).size !== rows.length) fail("DISTRIBUTION_INVALID");
  const weights = {};
  const schemaSums = { "0": 0, "1": 0 };
  for (const row of rows) {
    schemaSums[String(row.schema)] += row.percentage;
    if (!weights[row.destination]) weights[row.destination] = { "0": 0, "1": 0 };
    weights[row.destination][String(row.schema)] += row.percentage;
  }
  return { rows, rowsDigest: digest(rows), schemaSums, weights };
}

function normalizedValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return /^0x[0-9a-f]+$/i.test(value) ? value.toLowerCase() : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(normalizedValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizedValue(value[key])]));
  }
  return null;
}

function normalizeCode(code) {
  return {
    present: typeof code?.present === "boolean" ? code.present : null,
    lengthBytes: Number.isSafeInteger(code?.lengthBytes) ? code.lengthBytes : null,
    sha256: hashValue(code?.sha256),
  };
}

function normalizeSlots(slots) {
  return {
    implementation: address(slots?.implementationSlot),
    admin: address(slots?.adminSlot),
    beacon: address(slots?.beaconSlot),
  };
}

function normalizeResolved(row) {
  return {
    address: address(row?.address),
    resolution: typeof row?.resolution === "string" ? row.resolution : null,
    code: normalizeCode(row?.code),
  };
}

function normalizeSourceBinding(binding) {
  const summary = (row) => ({
    status: typeof row?.status === "string" ? row.status : null,
    matched: typeof row?.matched === "boolean" ? row.matched : null,
    allMatched: typeof row?.allMatched === "boolean" ? row.allMatched : null,
    candidateAddress: address(row?.candidateAddress),
    candidateAddressMatch: typeof row?.candidateAddressMatch === "boolean" ? row.candidateAddressMatch : null,
    method: typeof row?.method === "string" ? row.method : null,
    runtimeSha256: hashValue(row?.runtimeSha256),
    templateSha256: hashValue(row?.templateSha256),
  });
  return {
    ...summary(binding),
    proxy: binding?.proxy ? summary(binding.proxy) : null,
    implementation: binding?.implementation ? summary(binding.implementation) : null,
    beacon: binding?.beacon ? summary(binding.beacon) : null,
  };
}

const EXPECTED_GETTERS = [
  "CORE_POOL_COMPTROLLER", "WBNB", "accessControlManager", "maxLoopsLimit",
  "owner", "poolRegistry", "totalDistributions", "vBNB",
];

function normalizeGetters(getters) {
  const source = getters && typeof getters === "object" ? getters : {};
  const keys = [...new Set([...EXPECTED_GETTERS, ...Object.keys(source)])].sort();
  return Object.fromEntries(keys.map((key) => [key, {
    selector: typeof source[key]?.selector === "string" ? lower(source[key].selector) : null,
    available: typeof source[key]?.available === "boolean" ? source[key].available : null,
    value: normalizedValue(source[key]?.value),
  }]));
}

const EXPECTED_PROBES = [
  "MAX_INCENTIVE", "accessControlManager", "baseAsset", "conversionPaused",
  "converterNetwork", "destinationAddress", "minAmountToConvert", "owner", "priceOracle",
];

function normalizeProbes(probes) {
  const source = probes && typeof probes === "object" ? probes : {};
  const keys = [...new Set([...EXPECTED_PROBES, ...Object.keys(source)])].sort();
  return Object.fromEntries(keys.map((key) => {
    const row = source[key];
    const structured = row && typeof row === "object" && !Array.isArray(row);
    return [key, {
      available: structured && typeof row.available === "boolean" ? row.available : null,
      value: normalizedValue(structured ? row.value : row),
    }];
  }));
}

function normalizeDestination(row, supplements) {
  const destination = address(row?.destination);
  if (!destination) fail("DESTINATION_INVALID");
  const resolved = normalizeResolved(row.resolvedRuntime);
  const supplement = supplements.get(destination);
  const supplementMatches = Boolean(supplement
    && resolved.code.lengthBytes === supplement.lengthBytes
    && resolved.code.sha256 === supplement.sha256);
  return {
    identity: {
      destination,
      classification: supplementMatches ? supplement.classification : String(row.classification || "UNKNOWN"),
      sourceBound: supplementMatches ? true : (typeof row.sourceBound === "boolean" ? row.sourceBound : null),
      directCode: normalizeCode(row.code),
      eip1967: normalizeSlots(row.eip1967),
      resolvedRuntime: resolved,
      beacon: normalizedValue(row.beacon),
      binding: normalizeSourceBinding(row.binding),
      localEvidence: normalizeSourceBinding(row.localEvidence),
    },
    controls: {
      destination,
      probes: normalizeProbes(row.probes),
    },
  };
}

function normalizeMembership(membership) {
  const source = membership && typeof membership === "object" ? membership : {};
  return Object.fromEntries(Object.keys(source).map(address).filter(Boolean).sort()
    .map((key) => [key, Boolean(source[key] ?? source[Object.keys(source).find((candidate) => address(candidate) === key)])]));
}

function normalizeArtifact(artifact, chainId, supplements = new Map()) {
  if (!artifact || artifact.chain?.chainId !== chainId) fail("CHAIN_ID_INVALID");
  const block = artifact.chain.selectedFinalizedBlock;
  if (!Number.isSafeInteger(block?.number) || !hashValue(block?.hash)) fail("BLOCK_INVALID");
  const distribution = normalizeRows(artifact.distribution);
  const psrContainer = artifact.psr || {};
  const psr = psrContainer.proxy || artifact.proxy;
  const psrIdentity = {
    address: address(psr?.address),
    directCode: normalizeCode(psr?.proxyCode || psr?.code),
    eip1967: normalizeSlots(psr?.eip1967),
    resolvedImplementation: normalizeResolved(psr?.resolvedImplementation),
    beacon: normalizedValue(psr?.beacon),
    sourceBinding: normalizeSourceBinding(psrContainer.sourceBinding || artifact.sourceBinding),
  };
  if (!psrIdentity.address || !psrIdentity.directCode.sha256
    || !psrIdentity.resolvedImplementation.address || !psrIdentity.resolvedImplementation.code.sha256) {
    fail("PSR_IDENTITY_INVALID");
  }
  const psrConfiguration = { getters: normalizeGetters(psrContainer.getters || artifact.getters) };

  const destinationRows = artifact.destinations || artifact.destinationClassifications;
  if (!Array.isArray(destinationRows)) fail("DESTINATION_INVALID");
  const positive = Object.keys(distribution.weights).filter((item) => {
    const weight = distribution.weights[item];
    return weight["0"] > 0 || weight["1"] > 0;
  }).sort();
  const byDestination = new Map(destinationRows.map((row) => [address(row?.destination), row]));
  const destinationParts = positive.map((item) => {
    const row = byDestination.get(item);
    if (!row) fail("DESTINATION_INVALID");
    return normalizeDestination(row, supplements);
  });

  let converterNetwork = null;
  if (artifact.converterNetwork) {
    const network = artifact.converterNetwork;
    if (!Array.isArray(network.members)) fail("CONVERTER_NETWORK_INVALID");
    const members = network.members.map(address).sort();
    if (members.some((item) => !item) || new Set(members).size !== members.length) fail("CONVERTER_NETWORK_INVALID");
    converterNetwork = {
      address: address(network.address),
      directCode: normalizeCode(network.code),
      eip1967: normalizeSlots(network.eip1967),
      resolvedRuntime: normalizeResolved(network.resolvedRuntime),
      sourceBinding: normalizeSourceBinding(network.sourceBinding),
      members,
      membership: normalizeMembership(network.membership),
      maxLoopsLimit: normalizedValue(network.maxLoopsLimit),
      consistency: normalizedValue(network.consistency),
    };
    if (!converterNetwork.address || !converterNetwork.directCode.sha256
      || !converterNetwork.resolvedRuntime.address || !converterNetwork.resolvedRuntime.code.sha256) {
      fail("CONVERTER_NETWORK_INVALID");
    }
  }

  const configuration = {
    psrIdentity,
    psrConfiguration,
    distribution: {
      rows: distribution.rows,
      derivedSchemaSums: distribution.schemaSums,
      declaredSchemaSums: normalizedValue(artifact.distribution.schemaSums),
      rowsDigest: distribution.rowsDigest,
      terminalRowsDigest: hashValue(artifact.chain?.terminalRecheck?.distributionRowsDigest),
      weights: distribution.weights,
    },
    positiveDestinations: destinationParts.map((row) => row.identity),
    destinationControls: destinationParts.map((row) => row.controls),
    converterNetwork,
  };
  return {
    block: { number: block.number, hash: hashValue(block.hash) },
    configuration,
    digest: digest(configuration),
  };
}

function attachBnbControlPolicy(normalized, artifact, requireHistorical = false) {
  bnbControls.validateArtifact(artifact);
  const expectedMode = requireHistorical ? "HISTORICAL_BASELINE" : "CURRENT_MONITOR";
  if (artifact.chainId !== 56 || artifact.mode !== expectedMode
    || artifact.block.number !== normalized.block.number || artifact.block.hash !== normalized.block.hash) fail("BNB_CONTROL_SUPPLEMENT_INVALID");
  const result = clone(normalized);
  result.configuration.destinationPolicy = clone(artifact.controls);
  result.controlDigest = artifact.normalizedControlDigest;
  result.digest = digest(result.configuration);
  return result;
}

function driftCategories(baseline, current) {
  const comparisons = {
    PSR_IDENTITY: [baseline.psrIdentity, current.psrIdentity],
    PSR_CONFIGURATION: [baseline.psrConfiguration, current.psrConfiguration],
    DISTRIBUTION: [baseline.distribution, current.distribution],
    POSITIVE_DESTINATIONS: [baseline.positiveDestinations, current.positiveDestinations],
    DESTINATION_CONTROLS: [baseline.destinationControls, current.destinationControls],
    DESTINATION_POLICY: [baseline.destinationPolicy ?? null, current.destinationPolicy ?? null],
    CONVERTER_NETWORK: [baseline.converterNetwork, current.converterNetwork],
  };
  const categories = CATEGORY_ORDER.filter((category) => canonicalJson(comparisons[category][0]) !== canonicalJson(comparisons[category][1]));
  if (digest(baseline) !== digest(current) && categories.length === 0) fail("UNCATEGORIZED_DRIFT");
  return categories;
}

function sanitizedErrorClass(value) {
  const candidate = typeof value === "string" ? value.toUpperCase() : "UNEXPECTED";
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate) ? candidate : "UNEXPECTED";
}

function errorClassFromResult(result) {
  return sanitizedErrorClass(result?.summary?.failure?.errorClass || result?.summary?.status || "CAPTURE_FAILED");
}

function isQualificationFailure(result) {
  const stage = result?.summary?.failure?.stage;
  const errorClass = result?.summary?.failure?.errorClass;
  return stage === "qualification" || new Set(["NO_PASSING_CANDIDATE", "ENDPOINT_QUALIFICATION_FAILED"]).has(errorClass);
}

function containsProviderMaterial(value, key = "") {
  if (/^(endpoint|url|uri|provider|headers|inventory|raw|response|request|jsonrpc|runtimeBytecode)$/i.test(key)) return true;
  if (typeof value === "string") return /(?:https?|wss?):\/\/|rpc_endpoints|\.env(?:\.|$)|[A-Za-z]:[\\/]/i.test(value);
  if (Array.isArray(value)) return value.some((item) => containsProviderMaterial(item));
  return Boolean(value && typeof value === "object"
    && Object.entries(value).some(([childKey, child]) => containsProviderMaterial(child, childKey)));
}

function validateSuccessfulObservation(value, requireDrift = false) {
  if (value && Object.hasOwn(value, "rpcStrength") && value.rpcStrength !== "single-provider") fail("STATE_RPC_STRENGTH_INVALID");
  if (!value || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))
    || !new Set(["CLEAR", "DRIFT"]).has(value.status)
    || !Number.isSafeInteger(value.blockNumber) || !hashValue(value.blockHash) || !hashValue(value.digest)
    || !Array.isArray(value.driftCategories) || new Set(value.driftCategories).size !== value.driftCategories.length
    || value.driftCategories.some((category) => !CATEGORY_ORDER.includes(category))
    || (value.status === "CLEAR" && value.driftCategories.length)
    || (value.status === "DRIFT" && !value.driftCategories.length)
    || (requireDrift && value.status !== "DRIFT")) fail("STATE_OBSERVATION_INVALID");
  return true;
}

function validateState(state) {
  if (!state || state.schema !== SCHEMA || !CHAIN_ORDER.includes("bnb")) fail("STATE_SCHEMA_INVALID");
  if (!new Set(["CLEAR", "DRIFT", "DEGRADED", "ERROR"]).has(state.status)
    || typeof state.attemptAt !== "string" || !Number.isFinite(Date.parse(state.attemptAt))
    || !Number.isSafeInteger(state.intervalSeconds) || state.intervalSeconds < MIN_INTERVAL_SECONDS || state.intervalSeconds > MAX_INTERVAL_SECONDS
    || state.readOnly !== true || state.upstreamTransactions !== 0 || state.signedActionJustified !== false
    || state.providerMaterialAbsent !== true || containsProviderMaterial(state)) fail("STATE_INVALID");
  if (!state.chains || Object.keys(state.chains).sort().join(",") !== [...CHAIN_ORDER].sort().join(",")) fail("STATE_CHAINS_INVALID");
  for (const key of CHAIN_ORDER) {
    const row = state.chains[key];
    if (row?.current && Object.hasOwn(row.current, "rpcStrength") && row.current.rpcStrength !== "single-provider") fail("STATE_RPC_STRENGTH_INVALID");
    const expected = CHAIN_CONFIG[key];
    if (!row || row.chainId !== expected.chainId || row.name !== expected.name
      || !new Set(["CLEAR", "DRIFT", "ERROR"]).has(row.status)
      || row.attemptAt !== state.attemptAt || !row.baseline || !Number.isSafeInteger(row.baseline.blockNumber)
      || !hashValue(row.baseline.blockHash) || !hashValue(row.baseline.digest)
      || !Array.isArray(row.driftCategories) || new Set(row.driftCategories).size !== row.driftCategories.length
      || row.driftCategories.some((category) => !CATEGORY_ORDER.includes(category))) fail("STATE_CHAIN_INVALID");
    if (row.lastSuccessfulObservation === null) {
      if (row.lastSuccessfulAt !== null) fail("STATE_CHAIN_INVALID");
    } else {
      validateSuccessfulObservation(row.lastSuccessfulObservation);
      if (row.lastSuccessfulAt !== row.lastSuccessfulObservation.at) fail("STATE_CHAIN_INVALID");
    }
    if (row.unresolvedDrift !== null) validateSuccessfulObservation(row.unresolvedDrift, true);
    if (row.status === "ERROR") {
      const expectedUnresolved = row.lastSuccessfulObservation?.status === "DRIFT" ? row.lastSuccessfulObservation : null;
      if (row.current !== null || !/^[A-Z][A-Z0-9_]{0,63}$/.test(row.errorClass || "") || row.driftCategories.length
        || canonicalJson(row.unresolvedDrift) !== canonicalJson(expectedUnresolved)) fail("STATE_CHAIN_INVALID");
    } else if (!row.current || !Number.isSafeInteger(row.current.blockNumber) || !hashValue(row.current.blockHash)
      || !hashValue(row.current.digest) || row.errorClass !== null
      || (row.status === "CLEAR" && row.driftCategories.length)
      || (row.status === "DRIFT" && !row.driftCategories.length)
      || row.lastSuccessfulObservation?.at !== row.attemptAt
      || row.lastSuccessfulObservation?.status !== row.status
      || row.lastSuccessfulObservation?.blockNumber !== row.current.blockNumber
      || row.lastSuccessfulObservation?.blockHash !== row.current.blockHash
      || row.lastSuccessfulObservation?.digest !== row.current.digest
      || (row.status === "CLEAR" && row.unresolvedDrift !== null)
      || (row.status === "DRIFT" && canonicalJson(row.unresolvedDrift) !== canonicalJson(row.lastSuccessfulObservation))) fail("STATE_CHAIN_INVALID");
  }
  const values = Object.values(state.chains).map((row) => row.status);
  const expectedStatus = values.every((value) => value === "ERROR") ? "ERROR"
    : values.includes("ERROR") ? "DEGRADED"
      : values.includes("DRIFT") ? "DRIFT" : "CLEAR";
  if (state.status !== expectedStatus) fail("STATE_STATUS_INVALID");
  const encoded = Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`);
  if (encoded > MAX_STATE_BYTES) fail("STATE_TOO_LARGE");
  return true;
}

async function deriveBaselines(root = ROOT) {
  const result = {};
  for (const key of CHAIN_ORDER) {
    const config = CHAIN_CONFIG[key];
    const artifactRecord = await readSafeJsonRecord(root, config.baseline);
    const artifact = artifactRecord.value;
    const block = artifact.chain?.selectedFinalizedBlock;
    const supplement = config.supplement
      ? await readSafeJsonRecord(root, config.supplement)
      : null;
    const supplements = supplementMap(supplement?.value, config.chainId, block);
    result[key] = {
      ...normalizeArtifact(artifact, config.chainId, supplements),
      rawSha256: artifactRecord.sha256,
      supplementSha256: supplement?.sha256 || null,
      supplementSchema: supplement?.value?.schema || null,
      supplementFingerprints: supplements,
      schema: artifact.schema,
    };
  }
  return result;
}

async function loadBaselines(root = ROOT) {
  try {
    const derived = await deriveBaselines(root);
    for (const key of CHAIN_ORDER) {
      const expected = BASELINE_COMMITMENTS[key];
      const actual = derived[key];
      if (actual.schema !== expected.schema
        || actual.block.number !== expected.blockNumber
        || actual.block.hash !== expected.blockHash
        || actual.rawSha256 !== expected.rawSha256
        || actual.supplementSha256 !== expected.supplementSha256
        || actual.supplementSchema !== expected.supplementSchema
        || actual.digest !== (key === "bnb" ? expected.topologyDigest : expected.normalizedDigest)) fail("BASELINE_COMMITMENT_FAILED");
    }
    if (!BNB_CONTROL_COMMITMENT.rawSha256 || !BNB_CONTROL_COMMITMENT.normalizedControlDigest
      || !BASELINE_COMMITMENTS.bnb.normalizedDigest) fail("BASELINE_COMMITMENT_FAILED");
    const controlRecord = await readSafeJsonRecord(root, BNB_CONTROL_COMMITMENT.path);
    if (controlRecord.sha256 !== BNB_CONTROL_COMMITMENT.rawSha256
      || controlRecord.value.schema !== BNB_CONTROL_COMMITMENT.schema
      || controlRecord.value.block?.number !== BNB_CONTROL_COMMITMENT.blockNumber
      || controlRecord.value.block?.hash !== BNB_CONTROL_COMMITMENT.blockHash
      || controlRecord.value.normalizedControlDigest !== BNB_CONTROL_COMMITMENT.normalizedControlDigest) fail("BASELINE_COMMITMENT_FAILED");
    derived.bnb = attachBnbControlPolicy(derived.bnb, controlRecord.value, true);
    if (derived.bnb.digest !== BASELINE_COMMITMENTS.bnb.normalizedDigest) fail("BASELINE_COMMITMENT_FAILED");
    return derived;
  } catch {
    fail("BASELINE_COMMITMENT_FAILED");
  }
}

async function readPriorSafeState(root, dependency) {
  try {
    const state = dependency ? await dependency() : await readSafeJson(root, "reports/monitor/venus-psr-state.json", MAX_STATE_BYTES);
    validateState(state);
    return state;
  } catch {
    return null;
  }
}

function topStatus(chains) {
  const statuses = Object.values(chains).map((row) => row.status);
  if (statuses.every((value) => value === "ERROR")) return "ERROR";
  if (statuses.includes("ERROR")) return "DEGRADED";
  if (statuses.includes("DRIFT")) return "DRIFT";
  return "CLEAR";
}

async function parseInventoryOnce(readInventory, parsers) {
  let bytes;
  let text = null;
  try {
    bytes = await readInventory();
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(String(bytes), "utf8");
    if (bytes.length > MAX_INPUT_BYTES) fail("INVENTORY_TOO_LARGE");
    text = bytes.toString("utf8");
    const candidates = {};
    const errors = {};
    for (const key of CHAIN_ORDER) {
      try {
        candidates[key] = validateCandidates(parsers[key](text));
      } catch (error) {
        errors[key] = sanitizedErrorClass(error?.errorClass || "INVENTORY_PARSE_FAILED");
      }
    }
    return { candidates, errors };
  } finally {
    text = null;
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
    bytes = null;
  }
}

function validateCandidates(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) fail("INVENTORY_CANDIDATES_INVALID");
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== "string" || /\s/.test(value)) fail("INVENTORY_CANDIDATES_INVALID");
    let parsed;
    try { parsed = new URL(value); } catch { fail("INVENTORY_CANDIDATES_INVALID"); }
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.hash || parsed.username || parsed.password) {
      fail("INVENTORY_CANDIDATES_INVALID");
    }
    if (!seen.has(parsed.href)) { seen.add(parsed.href); result.push(parsed.href); }
  }
  if (!result.length) fail("INVENTORY_CANDIDATES_INVALID");
  return result;
}

function accessProvenancePathFor(provenanceRoot = ROOT) {
  return path.join(provenanceRoot, "reports", "monitor", "venus-psr-access-provenance.json");
}

function loadAccessProvenanceArtifact(provenanceRoot = ROOT) {
  try {
    const bytes = fs.readFileSync(accessProvenancePathFor(provenanceRoot));
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    if (sha !== ACCESS_PROVENANCE_COMMITMENT.sha256) return null;
    const parsed = JSON.parse(bytes);
    if (!parsed || parsed.schema !== ACCESS_PROVENANCE_COMMITMENT.schema) return null;
    return parsed;
  } catch {
    return null;
  }
}

function validatePublicCandidates(key, candidates, provenanceRoot = ROOT) {
  const normalized = validateCandidates(candidates);
  if (key === "ethereum" && normalized.length === 1
    && normalized[0] === new URL(ETHEREUM_KEYLESS_FALLBACK[0]).href) return normalized;
  // Reviewed per-entry resolver: the frozen provenance artifact supplies the
  // reviewed keyless endpoints for the gated chains. Raw inventory membership
  // still never qualifies — only the committed artifact does.
  const artifact = loadAccessProvenanceArtifact(provenanceRoot);
  const entries = artifact && artifact.entries && artifact.entries[key];
  if (Array.isArray(entries) && entries.length >= 1 && entries.length <= 8) {
    return validateCandidates(entries.slice(0, 8));
  }
  fail("ACCESS_PROVENANCE_REQUIRED");
  return normalized;
}

function createCaptureWorker(key, candidates, options, provenanceRoot = ROOT) {
  candidates = validatePublicCandidates(key, candidates, provenanceRoot);
  return new Worker(__filename, {
    workerData: { kind: "venus-psr-capture", key, candidates, options, accessProvenanceRoot: provenanceRoot },
  });
}

async function captureInWorker(key, candidates, options, dependencies = {}) {
  const factory = dependencies.workerFactory || createCaptureWorker;
  const timeoutMs = dependencies.captureTimeoutMs || CAPTURE_TIMEOUT_MS;
  const worker = factory(key, candidates, options, path.resolve(dependencies.root || ROOT));
  return new Promise((resolve, reject) => {
    let timer;
    let result;
    let workerError = false;
    let timingOut = false;
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    worker.on("message", (message) => { result = message; });
    worker.on("error", () => { workerError = true; });
    worker.on("exit", () => {
      if (timingOut) return;
      if (workerError || !result) settle(reject, new MonitorError("CAPTURE_WORKER_FAILED"));
      else settle(resolve, result);
    });
    timer = setTimeout(async () => {
      if (settled) return;
      timingOut = true;
      try { await worker.terminate(); } catch { /* sanitized below */ }
      settle(reject, new MonitorError("CAPTURE_TIMEOUT"));
    }, timeoutMs);
    timer.unref?.();
  });
}

async function runAttempt(options = {}, dependencies = {}) {
  const root = path.resolve(dependencies.root || ROOT);
  const attemptAt = isoNow(dependencies.now ? dependencies.now() : Date.now());
  const baselines = dependencies.baselines || await (dependencies.loadBaselines || loadBaselines)(root);
  const prior = await readPriorSafeState(root, dependencies.readPriorState);
  const readInventory = dependencies.readInventory || (() => fsp.readFile(exactPath(root, "rpc_endpoints.txt")));
  const parsers = {};
  for (const key of CHAIN_ORDER) {
    parsers[key] = dependencies.parsers?.[key] || CHAIN_CONFIG[key].parser;
  }

  let parsed = { candidates: {}, errors: {} };
  if (options.useAuthorizedInventory) {
    if (dependencies.readInventory && dependencies.parsers && dependencies.workerFactory) {
      // Preserve network-free injected fixtures, never a CLI access override.
      try {
        parsed = await parseInventoryOnce(readInventory, parsers);
      } catch (error) {
        const errorClass = sanitizedErrorClass(error?.errorClass || "INVENTORY_READ_FAILED");
        parsed.errors = Object.fromEntries(CHAIN_ORDER.map((key) => [key, errorClass]));
      }
    } else {
      // Real CLI run. Without the reviewed provenance artifact, chains stay
      // gated; with it, the artifact's committed keyless endpoints are the
      // reviewed per-entry resolver (raw inventory membership never qualifies).
      parsed.errors = Object.fromEntries(CHAIN_ORDER.map((key) => [key, "ACCESS_PROVENANCE_REQUIRED"]));
      const artifact = loadAccessProvenanceArtifact(root);
      if (artifact && artifact.entries) {
        for (const key of CHAIN_ORDER) {
          const entries = artifact.entries[key];
          if (Array.isArray(entries) && entries.length >= 1 && entries.length <= 8) {
            try {
              parsed.candidates[key] = validateCandidates([...entries]);
              delete parsed.errors[key];
            } catch {
              // Provenance entry failed shape validation: keep chain gated.
            }
          }
        }
      }
      if (options.allowPublicEthereumFallback === true) {
        parsed.candidates.ethereum = [...ETHEREUM_KEYLESS_FALLBACK];
        delete parsed.errors.ethereum;
      }
    }
  } else {
    parsed.errors = Object.fromEntries(CHAIN_ORDER.map((key) => [key, "AUTHORIZED_INVENTORY_FLAG_REQUIRED"]));
  }

  const chains = {};
  for (const key of CHAIN_ORDER) {
    const config = CHAIN_CONFIG[key];
    const baseline = baselines[key];
    const priorRow = prior?.chains?.[key];
    const baseRow = {
      chainId: config.chainId,
      name: config.name,
      status: "ERROR",
      attemptAt,
      lastSuccessfulAt: priorRow?.lastSuccessfulAt || null,
      lastSuccessfulObservation: priorRow?.lastSuccessfulObservation ? clone(priorRow.lastSuccessfulObservation) : null,
      unresolvedDrift: priorRow?.unresolvedDrift ? clone(priorRow.unresolvedDrift) : null,
      baseline: { blockNumber: baseline.block.number, blockHash: baseline.block.hash, digest: baseline.digest },
      current: null,
      driftCategories: [],
      errorClass: null,
    };
    if (parsed.errors[key]) {
      baseRow.errorClass = parsed.errors[key];
      chains[key] = baseRow;
      continue;
    }
    try {
      let captureResult = await captureInWorker(key, parsed.candidates[key], { now: Date.parse(attemptAt) }, dependencies);
      if (key === "ethereum" && options.allowPublicEthereumFallback === true
        && !parsed.candidates[key].every((value) => new URL(value).href === new URL(ETHEREUM_KEYLESS_FALLBACK[0]).href)
        && !captureResult?.ok && isQualificationFailure(captureResult)) {
        const fallback = dependencies.ethereumFallbackCandidates || ETHEREUM_KEYLESS_FALLBACK;
        captureResult = await captureInWorker(key, validateCandidates(fallback), { now: Date.parse(attemptAt) }, dependencies);
      }
      if (!captureResult?.ok || !captureResult.artifact) {
        baseRow.errorClass = errorClassFromResult(captureResult);
        chains[key] = baseRow;
        continue;
      }
      let current = normalizeArtifact(captureResult.artifact, config.chainId,
        supplementMapForCurrent(dependencies, key, baselines, captureResult.artifact));
      if (key === "bnb") {
        if (!captureResult.controlArtifact?.complete) fail("BNB_CONTROL_RESULT_MISSING");
        current = attachBnbControlPolicy(current, captureResult.controlArtifact, false);
      }
      const categories = driftCategories(baseline.configuration, current.configuration);
      baseRow.status = categories.length ? "DRIFT" : "CLEAR";
      baseRow.lastSuccessfulAt = attemptAt;
      baseRow.current = { blockNumber: current.block.number, blockHash: current.block.hash, digest: current.digest, rpcStrength: "single-provider" };
      baseRow.driftCategories = categories;
      baseRow.lastSuccessfulObservation = {
        rpcStrength: "single-provider",
        at: attemptAt,
        status: baseRow.status,
        blockNumber: current.block.number,
        blockHash: current.block.hash,
        digest: current.digest,
        driftCategories: [...categories],
      };
      baseRow.unresolvedDrift = baseRow.status === "DRIFT" ? clone(baseRow.lastSuccessfulObservation) : null;
      chains[key] = baseRow;
    } catch (error) {
      baseRow.errorClass = sanitizedErrorClass(error?.errorClass || "CAPTURE_FAILED");
      chains[key] = baseRow;
    }
  }

  const state = {
    schema: SCHEMA,
    attemptAt,
    status: topStatus(chains),
    intervalSeconds: options.intervalSeconds || DEFAULT_INTERVAL_SECONDS,
    chains,
    readOnly: true,
    upstreamTransactions: 0,
    signedActionJustified: false,
    providerMaterialAbsent: true,
  };
  validateState(state);
  if (!options.checkOnly) {
    const publish = dependencies.publishState || ((value) => publishAtomic(root, value));
    await publish(state);
  }
  return state;
}

function supplementMapForCurrent(dependencies, key, baselines, artifact) {
  if (baselines[key].supplementFingerprints instanceof Map) return baselines[key].supplementFingerprints;
  if (!CHAIN_CONFIG[key].supplement) return new Map();
  // The baseline was already validated with its supplement. Reconstruct only the
  // known sink fingerprint from its normalized positive destination row.
  const known = baselines[key].configuration.positiveDestinations
    .filter((row) => row.classification === "SOURCE_BOUND_NONPUBLIC_SINK");
  return new Map(known.map((row) => [row.destination, {
    classification: row.classification,
    lengthBytes: row.runtime.lengthBytes,
    sha256: row.runtime.sha256,
  }]));
}

async function validateOutputTarget(root) {
  const directory = exactPath(root, "reports/monitor");
  let parent;
  try {
    parent = await fsp.lstat(directory);
  } catch {
    await fsp.mkdir(directory, { recursive: true });
    parent = await fsp.lstat(directory);
  }
  await validateDirectoryChain(root, directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || isReparse(parent)) fail("PUBLICATION_TARGET_UNSAFE");
  const output = exactPath(root, "reports/monitor/venus-psr-state.json");
  try {
    const existing = await fsp.lstat(output);
    if (!existing.isFile() || existing.isSymbolicLink() || isReparse(existing) || existing.nlink !== 1) fail("PUBLICATION_TARGET_UNSAFE");
  } catch (error) {
    if (error instanceof MonitorError) throw error;
    if (error?.code !== "ENOENT") fail("PUBLICATION_TARGET_UNSAFE");
  }
  return { directory, output };
}

async function publishAtomic(root, state) {
  validateState(state);
  const encoded = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
  if (encoded.length > MAX_STATE_BYTES) fail("STATE_TOO_LARGE");
  const { directory, output } = await validateOutputTarget(root);
  const temporary = path.join(directory, `.venus-psr-state.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temporary, "wx", 0o600);
    await handle.writeFile(encoded);
    await handle.sync();
    await handle.close();
    handle = null;
    await validateOutputTarget(root);
    await fsp.rename(temporary, output);
  } catch (error) {
    if (error instanceof MonitorError) throw error;
    fail("PUBLICATION_FAILED");
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
    encoded.fill(0);
  }
}

function validateLockOwner(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !UUID.test(owner.nonce || "")) fail("LOCK_OWNER_INVALID");
  return { pid: owner.pid, nonce: owner.nonce.toLowerCase() };
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH means the PID is provably dead. EPERM means the PID exists but we
    // may not signal it, so treat it as live and fail closed.
    return error?.code === "EPERM";
  }
}

async function readLockOwner(root, lockDirectory) {
  try {
    const relative = path.relative(path.resolve(root), path.resolve(lockDirectory));
    const owner = await readSafeJson(root, path.join(relative, "owner.json"), 1024);
    return validateLockOwner(owner);
  } catch {
    // Malformed, unreadable, or partially written owner metadata is not proof
    // of a dead owner, so it can never be reclaimed.
    return null;
  }
}

async function readLockSnapshot(root, lockDirectory) {
  try {
    const stats = await fsp.lstat(lockDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink() || isReparse(stats)) return null;
    const owner = await readLockOwner(root, lockDirectory);
    if (!owner) return null;
    return { owner, dev: stats.dev, ino: stats.ino };
  } catch {
    return null;
  }
}

// Reclaim a lock directory only when its recorded owner is provably dead and
// its metadata is well-formed. The rename is the atomic claim: at most one
// process can move the observed directory aside, so concurrent reclaimers
// cannot both win. The directory is re-read after the claim; if it is not the
// exact stale owner that was observed, it is restored and the caller fails
// closed rather than stealing a live owner's lock.
async function reclaimProvablyDeadLock(root, lockDirectory, liveness = isProcessAlive) {
  const observed = await readLockSnapshot(root, lockDirectory);
  if (!observed || liveness(observed.owner.pid)) return false;
  // Re-verify immediately before the claim so a live owner that replaced the
  // directory mid-flight is never moved aside.
  const confirmed = await readLockSnapshot(root, lockDirectory);
  if (!confirmed
    || confirmed.dev !== observed.dev
    || confirmed.ino !== observed.ino
    || confirmed.owner.pid !== observed.owner.pid
    || confirmed.owner.nonce !== observed.owner.nonce
    || liveness(confirmed.owner.pid)) return false;
  const quarantine = path.join(path.dirname(lockDirectory),
    `.venus-psr-monitor.lock.stale.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
  try {
    await fsp.rename(lockDirectory, quarantine);
  } catch {
    // Another starter or reclaimer already moved or replaced the lock.
    return false;
  }
  const captured = await readLockSnapshot(root, quarantine);
  if (!captured
    || captured.owner.pid !== observed.owner.pid
    || captured.owner.nonce !== observed.owner.nonce
    || liveness(captured.owner.pid)) {
    await fsp.rename(quarantine, lockDirectory).catch(() => {});
    return false;
  }
  await fsp.rm(quarantine, { recursive: true, force: true }).catch(() => {});
  return true;
}

async function createLock(root, lockDirectory, owner) {
  await fsp.mkdir(lockDirectory);
  try {
    await fsp.writeFile(path.join(lockDirectory, "owner.json"), `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await releaseOwnedLock(root, owner).catch(() => {});
    throw error;
  }
}

async function releaseOwnedLock(root = ROOT, ownership) {
  const expected = validateLockOwner(ownership);
  const lock = exactPath(root, "reports/monitor/.venus-psr-monitor.lock");
  const ownerPath = path.join(lock, "owner.json");
  let actual;
  try {
    actual = validateLockOwner(await readSafeJson(root, "reports/monitor/.venus-psr-monitor.lock/owner.json", 1024));
  } catch {
    return false;
  }
  if (actual.pid !== expected.pid || actual.nonce !== expected.nonce) return false;
  try {
    await fsp.unlink(ownerPath);
    await fsp.rmdir(lock);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(root = ROOT, ownership = { pid: process.pid, nonce: crypto.randomUUID() }, dependencies = {}) {
  const owner = validateLockOwner(ownership);
  await validateOutputTarget(root);
  const lock = exactPath(root, "reports/monitor/.venus-psr-monitor.lock");
  await fsp.mkdir(path.dirname(lock), { recursive: true });
  try {
    await createLock(root, lock, owner);
  } catch {
    // The lock directory already exists. Reclaim it only if its recorded owner
    // is provably dead; every other case fails closed.
    const reclaimed = await reclaimProvablyDeadLock(
      root, lock, dependencies.isProcessAlive || isProcessAlive,
    ).catch(() => false);
    if (!reclaimed) fail("MONITOR_ALREADY_RUNNING");
    try {
      await createLock(root, lock, owner);
    } catch {
      fail("MONITOR_ALREADY_RUNNING");
    }
  }
  let released = false;
  return async () => {
    if (released) return false;
    released = true;
    return releaseOwnedLock(root, owner);
  };
}

function parseCli(argv) {
  const options = {
    loop: false,
    checkOnly: false,
    useAuthorizedInventory: false,
    allowPublicEthereumFallback: false,
    lockNonce: null,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--once") options.loop = false;
    else if (arg === "--loop") options.loop = true;
    else if (arg === "--check-only") options.checkOnly = true;
    else if (arg === "--use-authorized-inventory") options.useAuthorizedInventory = true;
    else if (arg === "--allow-public-ethereum-fallback") options.allowPublicEthereumFallback = true;
    else if (arg === "--lock-nonce") {
      const value = argv[++index];
      if (!UUID.test(value || "")) fail("LOCK_NONCE_INVALID");
      options.lockNonce = value.toLowerCase();
    }
    else if (arg === "--interval-seconds") {
      const value = argv[++index];
      if (!/^[0-9]+$/.test(value || "")) fail("INTERVAL_INVALID");
      options.intervalSeconds = Number(value);
      if (!Number.isSafeInteger(options.intervalSeconds)
        || options.intervalSeconds < MIN_INTERVAL_SECONDS || options.intervalSeconds > MAX_INTERVAL_SECONDS) fail("INTERVAL_INVALID");
    } else fail("UNKNOWN_ARGUMENT");
  }
  return options;
}

function publicSummary(state) {
  return {
    schema: SCHEMA,
    status: state.status,
    attemptAt: state.attemptAt,
    chains: Object.fromEntries(CHAIN_ORDER.map((key) => [key, state.chains[key].status])),
    readOnly: true,
    rpcStrength: "single-provider",
    comparisonOnly: true,
    upstreamTransactions: 0,
    signedActionJustified: false,
    providerMaterialAbsent: true,
  };
}

async function runLoop(options, dependencies, releaseLock) {
  const signalTarget = dependencies.signalTarget || process;
  const sleep = dependencies.sleep || ((milliseconds, register) => new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    register(() => { clearTimeout(timer); resolve(); });
  }));
  let stopping = false;
  let wake = () => {};
  const stop = () => { stopping = true; wake(); };
  signalTarget.once("SIGINT", stop);
  signalTarget.once("SIGTERM", stop);
  try {
    while (!stopping) {
      try {
        const state = await runAttempt(options, dependencies);
        (dependencies.writeStdout || ((text) => process.stdout.write(text)))(`${JSON.stringify(publicSummary(state))}\n`);
      } catch {
        (dependencies.writeStdout || ((text) => process.stdout.write(text)))(`${JSON.stringify({ schema: SCHEMA, status: "ERROR", errorClass: "ATTEMPT_FAILED" })}\n`);
      }
      if (stopping) break;
      await sleep(options.intervalSeconds * 1000, (callback) => { wake = callback; });
      wake = () => {};
    }
  } finally {
    signalTarget.removeListener("SIGINT", stop);
    signalTarget.removeListener("SIGTERM", stop);
    await releaseLock();
  }
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const write = dependencies.writeStdout || ((text) => process.stdout.write(text));
  let options;
  try {
    options = parseCli(argv);
  } catch (error) {
    write(`${JSON.stringify({ schema: SCHEMA, status: "CLI_REJECTED", errorClass: sanitizedErrorClass(error?.errorClass) })}\n`);
    return { exitCode: 2 };
  }
  if (!options.useAuthorizedInventory) {
    write(`${JSON.stringify({ schema: SCHEMA, status: "AUTHORIZATION_REQUIRED", errorClass: "AUTHORIZED_INVENTORY_FLAG_REQUIRED" })}\n`);
    return { exitCode: 0 };
  }
  const root = path.resolve(dependencies.root || ROOT);
  try {
    if (!dependencies.baselines) await (dependencies.loadBaselines || loadBaselines)(root);
  } catch {
    write(`${JSON.stringify({ schema: SCHEMA, status: "ERROR", errorClass: "BASELINE_COMMITMENT_FAILED" })}\n`);
    return { exitCode: 1 };
  }
  const ownership = { pid: process.pid, nonce: options.lockNonce || crypto.randomUUID() };
  let releaseLock;
  try {
    releaseLock = options.checkOnly ? async () => true : await (dependencies.acquireLock || acquireLock)(root, ownership);
    if (options.loop) {
      await runLoop(options, dependencies, releaseLock);
      return { exitCode: 0 };
    }
    try {
      const state = await runAttempt(options, dependencies);
      write(`${JSON.stringify(publicSummary(state))}\n`);
      return { exitCode: state.status === "ERROR" ? 1 : 0, state };
    } finally {
      await releaseLock();
    }
  } catch (error) {
    if (releaseLock) await releaseLock().catch(() => {});
    write(`${JSON.stringify({ schema: SCHEMA, status: "ERROR", errorClass: sanitizedErrorClass(error?.errorClass) })}\n`);
    return { exitCode: 1 };
  }
}

async function runCaptureWorker() {
  try {
    if (workerData?.kind !== "venus-psr-capture" || !CHAIN_ORDER.includes(workerData.key)) fail("CAPTURE_WORKER_INPUT_INVALID");
    const candidates = validatePublicCandidates(workerData.key, workerData.candidates, workerData.accessProvenanceRoot || ROOT);
    const result = await CHAIN_CONFIG[workerData.key].executeCapture(candidates, workerData.options || {});
    if (workerData.key === "bnb" && result?.ok) {
      const ordinal = result.summary?.selectedCandidateOrdinal;
      const endpoint = Number.isSafeInteger(ordinal) && ordinal >= 1 ? candidates[ordinal - 1] : null;
      const selected = result.artifact?.chain?.selectedFinalizedBlock;
      const destinations = result.artifact?.destinationClassifications?.map((row) => row.destination);
      if (!endpoint || !selected || !Array.isArray(destinations)) fail("bnb_controls", "CONTROL_INPUT_INVALID");
      const controlProfile = await bnbControls.loadHistoricalProfile(ROOT);
      const controlResult = await bnbControls.executeControlCapture(endpoint, {
        mode: "CURRENT_MONITOR",
        requireZeroActor: false,
        blockNumber: selected.number,
        blockHash: selected.hash,
        destinations,
        destinationBindings: controlProfile.destinationBindings,
        core: result.artifact.getters?.CORE_POOL_COMPTROLLER?.value,
        asset: result.artifact.getters?.WBNB?.value,
      });
      if (!controlResult.ok || !controlResult.artifact?.complete) {
        parentPort.postMessage({
          ok: false,
          artifact: null,
          summary: {
            status: "CAPTURE_REJECTED",
            failure: { stage: "bnb_controls", errorClass: controlResult.summary?.failure?.errorClass || "CONTROL_INCONCLUSIVE" },
          },
        });
        return;
      }
      result.controlArtifact = controlResult.artifact;
    }
    parentPort.postMessage(result);
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      artifact: null,
      summary: { status: "CAPTURE_REJECTED", failure: { errorClass: sanitizedErrorClass(error?.errorClass) } },
    });
  } finally {
    parentPort.close();
  }
}

if (!isMainThread) {
  runCaptureWorker().catch(() => { parentPort.close(); });
} else if (require.main === module) {
  runCli().then(({ exitCode }) => { process.exitCode = exitCode; }).catch(() => {
    process.stdout.write(`${JSON.stringify({ schema: SCHEMA, status: "ERROR", errorClass: "UNEXPECTED" })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  SCHEMA,
  CHAIN_CONFIG,
  BASELINE_COMMITMENTS,
  BNB_CONTROL_COMMITMENT,
  CATEGORY_ORDER,
  DEFAULT_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  MAX_STATE_BYTES,
  CAPTURE_TIMEOUT_MS,
  canonicalJson,
  digest,
  normalizeArtifact,
  driftCategories,
  validateState,
  loadBaselines,
  deriveBaselines,
  parseInventoryOnce,
  parseCli,
  publishAtomic,
  acquireLock,
  releaseOwnedLock,
  isProcessAlive,
  reclaimProvablyDeadLock,
  captureInWorker,
  runAttempt,
  runLoop,
  runCli,
  containsProviderMaterial,
  _test: { clone, readSafeJson, readSafeJsonRecord, publicSummary, sanitizedErrorClass, supplementMap, attachBnbControlPolicy, createCaptureWorker, validatePublicCandidates },
};
