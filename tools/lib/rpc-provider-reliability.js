"use strict";

const MAX_ENDPOINTS_PER_FAMILY = 2;
const MAX_TRANSPORT_RETRIES_PER_FAMILY = 1;

function provider(family, domains, capabilityRank, quorumReviewed = false) {
  return Object.freeze({
    family,
    domains: Object.freeze([...domains]),
    capabilityRank,
    quorumReviewed
  });
}

const PROVIDER_CAPABILITY_REGISTRY = Object.freeze([
  provider("alchemy", ["alchemy.com"], 0, true),
  provider("infura", ["infura.io"], 0, true),
  provider("quicknode", ["quiknode.pro", "quicknode.com", "quicknode.pro"], 0, true),
  provider("ankr", ["ankr.com"], 0, true),
  provider("blastapi", ["blastapi.io"], 1),
  provider("chainstack", ["chainstack.com"], 1),
  provider("nodereal", ["nodereal.io"], 1),
  provider("allnodes", ["allnodes.com"], 1),
  provider("onfinality", ["onfinality.io"], 1),
  provider("llamarpc", ["llamarpc.com"], 1),
  provider("blockpi", ["blockpi.network"], 1),
  provider("thirdweb", ["thirdweb.com"], 1),
  provider("tenderly", ["tenderly.co"], 1),
  provider("pokt", ["pokt.network"], 1),
  provider("publicnode", ["publicnode.com"], 2, true),
  provider("1rpc", ["1rpc.io"], 2, true),
  provider("0xrpc", ["0xrpc.io"], 2, true),
  provider("drpc", ["drpc.org"], 2, true)
]);

const PROVIDER_FAMILIES = PROVIDER_CAPABILITY_REGISTRY;
const REVIEWED_PROVIDER_FAMILY_IDS = Object.freeze(
  PROVIDER_CAPABILITY_REGISTRY.filter((row) => row.quorumReviewed).map((row) => row.family)
);
const REVIEWED_PROVIDER_FAMILY_ID_SET = new Set(REVIEWED_PROVIDER_FAMILY_IDS);

const TRANSPORT_FAILURE_CODES = Object.freeze([
  "RPC_DNS_TRANSPORT",
  "RPC_TRANSPORT",
  "RPC_TIMEOUT",
  "TRANSPORT_REJECTED",
  "REQUEST_TIMEOUT",
  "ABORT_ERR",
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET"
]);
const TRANSPORT_FAILURE_CODE_SET = new Set(TRANSPORT_FAILURE_CODES);

function hostnameOf(value) {
  try {
    if (value instanceof URL) return value.hostname.toLowerCase().replace(/\.$/u, "");
    const raw = typeof value === "string" ? value : value && typeof value.url === "string" ? value.url : null;
    if (raw && /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) return new URL(raw).hostname.toLowerCase().replace(/\.$/u, "");
    return String(raw || value || "").toLowerCase().replace(/\.$/u, "");
  } catch (_) {
    return "";
  }
}

function classifyProvider(value, registry = PROVIDER_CAPABILITY_REGISTRY) {
  const host = hostnameOf(value);
  if (!host || !Array.isArray(registry)) return null;
  const matches = registry.filter((row) => row && typeof row.family === "string" && Array.isArray(row.domains)
    && row.domains.some((domain) => host === domain || host.endsWith(`.${domain}`)));
  if (matches.length !== 1) return null;
  const row = matches[0];
  return Object.freeze({
    family: row.family,
    operatorFamily: row.family,
    capabilityRank: Number.isSafeInteger(row.capabilityRank) && row.capabilityRank >= 0 ? row.capabilityRank : 1,
    quorumReviewed: row.quorumReviewed === true
  });
}

function providerFamily(value, registry = PROVIDER_CAPABILITY_REGISTRY) {
  return classifyProvider(value, registry)?.family || null;
}

function providerCapabilityRank(value) {
  return classifyProvider(value)?.capabilityRank ?? 1;
}

function reviewedOperatorFamily(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return REVIEWED_PROVIDER_FAMILY_ID_SET.has(normalized) ? normalized : null;
}

function rankBeforeCap(values, maximum, compare) {
  if (!Array.isArray(values) || !Number.isSafeInteger(maximum) || maximum <= 0 || typeof compare !== "function") {
    throw new TypeError("RPC_CANDIDATE_RANK_INPUT_INVALID");
  }
  return values.map((value, index) => ({ value, index }))
    .sort((left, right) => compare(left.value, right.value) || left.index - right.index)
    .slice(0, maximum)
    .map((row) => row.value);
}

function rankProviderUrls(values, maximum) {
  return rankBeforeCap(values, maximum, (left, right) => providerCapabilityRank(left) - providerCapabilityRank(right));
}

function candidateFamily(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  return typeof candidate.family === "string" ? candidate.family
    : typeof candidate.operatorFamily === "string" ? candidate.operatorFamily
      : providerFamily(candidate.handle || candidate.url);
}

function boundedFamilyCandidates(values, options = {}) {
  if (!Array.isArray(values)) throw new TypeError("RPC_FAMILY_CANDIDATES_INVALID");
  const maximumFamilies = options.maximumFamilies;
  const maximumCandidates = options.maximumCandidates === undefined ? values.length : options.maximumCandidates;
  const endpointsPerFamily = options.endpointsPerFamily === undefined ? MAX_ENDPOINTS_PER_FAMILY : options.endpointsPerFamily;
  const familyOf = typeof options.familyOf === "function" ? options.familyOf : candidateFamily;
  if (!Number.isSafeInteger(maximumFamilies) || maximumFamilies <= 0
      || !Number.isSafeInteger(maximumCandidates) || maximumCandidates <= 0
      || !Number.isSafeInteger(endpointsPerFamily) || endpointsPerFamily <= 0 || endpointsPerFamily > MAX_ENDPOINTS_PER_FAMILY) {
    throw new TypeError("RPC_FAMILY_CANDIDATES_INVALID");
  }
  const counts = new Map(), output = [];
  for (const candidate of values) {
    const family = familyOf(candidate);
    if (typeof family !== "string" || !family) continue;
    if (!counts.has(family)) {
      if (counts.size >= maximumFamilies) continue;
      counts.set(family, 0);
    }
    if (counts.get(family) >= endpointsPerFamily) continue;
    counts.set(family, counts.get(family) + 1);
    output.push(candidate);
    if (output.length >= maximumCandidates) break;
  }
  return output;
}

function errorCode(error) {
  if (!error || typeof error !== "object") return null;
  if (typeof error.code === "string") return error.code.toUpperCase();
  if (typeof error.name === "string" && error.name === "AbortError") return "ABORT_ERR";
  return null;
}

function isTransportFailure(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (TRANSPORT_FAILURE_CODE_SET.has(errorCode(current))) return true;
    current = current && typeof current === "object" ? current.cause : null;
  }
  return false;
}

function createTransportRetryController(options = {}) {
  const familyOf = typeof options.familyOf === "function" ? options.familyOf : candidateFamily;
  const maximumRetries = options.maximumRetriesPerFamily === undefined
    ? MAX_TRANSPORT_RETRIES_PER_FAMILY : options.maximumRetriesPerFamily;
  if (!Number.isSafeInteger(maximumRetries) || maximumRetries < 0
      || maximumRetries > MAX_TRANSPORT_RETRIES_PER_FAMILY) {
    throw new TypeError("RPC_RETRY_LIMIT_INVALID");
  }
  const retriesByFamily = new Map();
  const counters = { transportFailures: 0, automaticRetries: 0, retryExhaustions: 0 };
  async function run(candidate, invoke) {
    if (typeof invoke !== "function") throw new TypeError("RPC_RETRY_INVOKE_INVALID");
    const family = familyOf(candidate);
    let retryIndex = 0;
    while (true) {
      try {
        return await invoke(candidate, retryIndex);
      } catch (error) {
        if (!isTransportFailure(error) || typeof family !== "string" || !family) throw error;
        counters.transportFailures += 1;
        const used = retriesByFamily.get(family) || 0;
        if (used >= maximumRetries) {
          counters.retryExhaustions += 1;
          throw error;
        }
        retriesByFamily.set(family, used + 1);
        counters.automaticRetries += 1;
        retryIndex += 1;
      }
    }
  }
  function snapshot() {
    return Object.freeze({ ...counters });
  }
  return Object.freeze({ run, snapshot });
}

function rotateDnsAnswers(values, retryIndex = 0) {
  if (!Array.isArray(values) || !Number.isSafeInteger(retryIndex) || retryIndex < 0) {
    throw new TypeError("RPC_DNS_ROTATION_INPUT_INVALID");
  }
  if (values.length < 2 || retryIndex === 0) return [...values];
  const offset = retryIndex % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

module.exports = Object.freeze({
  MAX_ENDPOINTS_PER_FAMILY,
  MAX_TRANSPORT_RETRIES_PER_FAMILY,
  PROVIDER_CAPABILITY_REGISTRY,
  PROVIDER_FAMILIES,
  REVIEWED_PROVIDER_FAMILY_IDS,
  TRANSPORT_FAILURE_CODES,
  classifyProvider,
  providerFamily,
  providerCapabilityRank,
  reviewedOperatorFamily,
  rankBeforeCap,
  rankProviderUrls,
  boundedFamilyCandidates,
  isTransportFailure,
  createTransportRetryController,
  rotateDnsAnswers
});
