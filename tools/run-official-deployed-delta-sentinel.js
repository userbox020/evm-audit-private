#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const identityModule = require("./deployed-delta-identities.js");

const SCHEMA = "official-deployed-delta-sentinel/v1";
const BASELINE_VERSION = 4;
const V3_BASELINE_VERSION = 3;
const PRIOR_BASELINE_VERSION = 2;
const LEGACY_BASELINE_VERSION = 1;
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_TREE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TREE_ENTRIES = 100_000;
const USER_AGENT = "deployed-delta-sentinel/1.0 (+local-read-only)";
const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";
const GH_CLI_ABSOLUTE_PATH = "C:\\Program Files\\GitHub CLI\\gh.exe";
const GH_TOKEN_TIMEOUT_MS = 5_000;
const MAX_TOKEN_LENGTH = 512;
const TOKEN_ENV_NAMES = Object.freeze(["GH_TOKEN", "GITHUB_TOKEN"]);
const TOKEN_PATTERN = /gh[opsu]_|github_pat_/i;
const WORKSPACE = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT = path.join(WORKSPACE, "reports", "monitor", "official-deployed-delta-sentinel.json");
const DEFAULT_BASELINE = path.join(WORKSPACE, "reports", "monitor", "official-deployed-delta-sentinel-baseline.json");
const DEFAULT_RUNS_DIR = path.join(WORKSPACE, "reports", "monitor", "official-deployed-delta-sentinel-runs");

// Baseline v3 repository set (retained for the v3 -> v4 migration).
const V3_REPOSITORIES = Object.freeze([
  repo("silo-finance/silo-contracts-v3", "implementation"),
  repo("VenusProtocol/venus-protocol", "implementation"),
  repo("aave-dao/aave-v3-origin", "implementation"),
  repo("aave-dao/aave-governance-v3", "governance"),
  repo("aave-dao/aave-address-book", "deployment-registry"),
  repo("morpho-org/morpho-blue", "implementation"),
  repo("yearn/yearn-vaults-v3", "implementation"),
  repo("etherfi-protocol/cash-v3", "implementation"),
  repo("lista-dao/lista-dao-contracts", "historical"),
  repo("AladdinDAO/fx-protocol-contracts", "implementation"),
  repo("compound-finance/comet", "implementation"),
  repo("Instadapp/fluid-contracts-public", "implementation"),
  repo("curvefi/curve-core", "deployment-registry")
]);
const REPOSITORIES = Object.freeze([
  ...V3_REPOSITORIES,
  repo("basalt-vault/basalt-vault", "implementation"),
  repo("Enhanced-Finance/contracts", "implementation"),
  repo("vetro-protocol/vetro-contracts", "implementation"),
  repo("basedollar/basedollar", "implementation")
]);
// Canonical project repositories that GitHub reports as forks. These are the project's own
// home repositories (e.g. a Liquity V2 fork), not mirror forks of another project, so the
// `fork === true` identity rejection is waived only for this explicit allowlist.
const FORK_ALLOWED = Object.freeze(new Set(["basedollar/basedollar"]));
const PRIOR_REPOSITORIES = Object.freeze([
  repo("silo-finance/silo-contracts-v3", "implementation"),
  repo("VenusProtocol/venus-protocol", "implementation"),
  repo("aave-dao/aave-v3-origin", "implementation"),
  repo("aave-dao/aave-governance-v3", "governance"),
  repo("aave-dao/aave-address-book", "deployment-registry"),
  repo("morpho-org/morpho-blue", "implementation"),
  repo("yearn/yearn-vaults-v3", "implementation"),
  repo("etherfi-protocol/cash-v3", "implementation"),
  repo("lista-dao/lista-dao-contracts", "historical"),
  repo("AladdinDAO/fx-protocol-contracts", "implementation")
]);
const LEGACY_REPOSITORIES = Object.freeze([
  repo("silo-finance/silo-contracts-v3", "implementation"),
  repo("VenusProtocol/venus-protocol", "implementation"),
  repo("aave/aave-v3-core", "implementation"),
  repo("aave-dao/aave-governance-v3", "governance"),
  repo("aave-dao/aave-address-book", "deployment-registry"),
  repo("morpho-org/morpho-blue", "implementation"),
  repo("yearn/yearn-vaults-v3", "implementation"),
  repo("etherfi-protocol/cash-contracts", "historical"),
  repo("lista-dao/lista-dao-contracts", "historical"),
  repo("AladdinDAO/fx-protocol-contracts", "implementation")
]);
const CHAIN_IDS = Object.freeze(["10", "100", "137", "146", "43114", "56", "57073"]);
const LEGACY_CHAIN_IDS = Object.freeze(["100", "137", "146", "43114", "56"]);
const MANIFEST_PREFIXES = Object.freeze([
  "contracts/", "src/", "deploy/", "deployments/", "scripts/", "addresses/",
  "config/", "governance/", "proposals/"
]);
const TOP_KEYS = Object.freeze(["schema", "generatedAt", "runId", "status", "baselineCreated", "repositories"]);
const ENTRY_KEYS = Object.freeze([
  "id", "officialUrl", "defaultBranch", "sourceClass", "observedHeadSha", "previousHeadSha",
  "releaseIds", "tags", "configuredManifestPaths", "changedManifestPaths", "changeHints",
  "chainTextHints", "evidenceUrls", "etagByUrl", "pollStatus", "observedAt"
]);
const STATUSES = new Set(["unchanged", "candidate-change", "incomplete", "rate-limited"]);
const HINTS = new Set([
  "implementation", "deployment-manifest", "governance-source", "release", "oracle-config",
  "pause-unpause-config", "unknown"
]);
const FORBIDDEN_FIELD = /^(?:address|addresses|bytecode|abi|rpc|rpcValue|tvl|risk|vulnerability|execution|runtime|route|profit|liquidExit)$/i;
const ADDRESS_TEXT = /0x[0-9a-fA-F]{40}/;

function repo(id, sourceClass) {
  const owner = id.split("/")[0];
  return Object.freeze({ id, owner, sourceClass, officialUrl: `https://github.com/${id}` });
}

class SentinelError extends Error {
  constructor(code) {
    super(code);
    this.name = "SentinelError";
    this.code = code;
  }
}

function fail(code) { throw new SentinelError(code); }
function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function sha(value) { return value === null || (typeof value === "string" && /^[0-9a-f]{40}$/.test(value)); }
function safeText(value, max = 1024) {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value) && !ADDRESS_TEXT.test(value);
}
function safeBranch(value) {
  return safeText(value, 255) && !value.startsWith("/") && !value.endsWith("/")
    && !value.includes("..") && !value.includes("\\") && !value.includes("//");
}
function safePathShape(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..");
}
function safePath(value) {
  return safePathShape(value) && !ADDRESS_TEXT.test(value);
}
function unique(array) { return [...new Set(array)]; }
function headersObject(headers) {
  const out = {};
  if (!headers || typeof headers !== "object") return out;
  for (const [key, value] of Object.entries(headers)) out[String(key).toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  return out;
}
function safeEtag(value) {
  return typeof value === "string" && /^(?:W\/)?"[A-Za-z0-9:._-]{1,200}"$/.test(value) ? value : null;
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(status);
}
function apiUrl(value) {
  if (typeof value !== "string" || value.length > 1000) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.hostname !== "api.github.com" || parsed.port || parsed.username || parsed.password || parsed.hash) return false;
    const endpoint = /^\/repos\/[^/]+\/[^/]+(?:\/git\/ref\/heads\/.+|\/git\/trees\/[0-9a-f]{40}|\/releases|\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40})?$/.test(parsed.pathname);
    if (!endpoint) return false;
    if (parsed.pathname.endsWith("/releases")) return parsed.search === "?per_page=10";
    if (/\/git\/trees\/[0-9a-f]{40}$/.test(parsed.pathname)) return parsed.search === "?recursive=1";
    return parsed.search === "";
  } catch (_) { return false; }
}

function validateEntry(entry, expectedRepo, chainIds = CHAIN_IDS) {
  if (!exactKeys(entry, ENTRY_KEYS) || entry.id !== expectedRepo.id || entry.officialUrl !== expectedRepo.officialUrl
      || entry.sourceClass !== expectedRepo.sourceClass || !(entry.defaultBranch === null || safeBranch(entry.defaultBranch))
      || !sha(entry.observedHeadSha) || !sha(entry.previousHeadSha) || !iso(entry.observedAt)
      || !Array.isArray(entry.releaseIds) || entry.releaseIds.length > 10
      || entry.releaseIds.some((id) => !Number.isSafeInteger(id) || id < 1)
      || unique(entry.releaseIds).length !== entry.releaseIds.length
      || !Array.isArray(entry.tags) || entry.tags.length > 10 || entry.tags.some((tag) => !safeText(tag, 200))
      || unique(entry.tags).length !== entry.tags.length
      || JSON.stringify(entry.configuredManifestPaths) !== JSON.stringify(MANIFEST_PREFIXES)
      || !Array.isArray(entry.changedManifestPaths) || entry.changedManifestPaths.some((item) => !safePath(item) || !isAllowedPath(item))
      || unique(entry.changedManifestPaths).length !== entry.changedManifestPaths.length
      || !Array.isArray(entry.changeHints) || entry.changeHints.some((item) => !HINTS.has(item))
      || unique(entry.changeHints).length !== entry.changeHints.length
      || !Array.isArray(entry.chainTextHints) || entry.chainTextHints.some((item) => !chainIds.includes(item))
      || unique(entry.chainTextHints).length !== entry.chainTextHints.length
      || !Array.isArray(entry.evidenceUrls) || entry.evidenceUrls.some((url) => !apiUrl(url))
      || unique(entry.evidenceUrls).length !== entry.evidenceUrls.length
      || entry.etagByUrl === null || typeof entry.etagByUrl !== "object" || Array.isArray(entry.etagByUrl)
      || Object.entries(entry.etagByUrl).some(([url, etag]) => !apiUrl(url) || safeEtag(etag) !== etag)
      || !STATUSES.has(entry.pollStatus)) return false;
  return true;
}

function hasForbiddenKey(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  return Object.entries(value).some(([key, child]) => FORBIDDEN_FIELD.test(key) || hasForbiddenKey(child));
}

function validateRunArtifact(artifact) {
  if (!exactKeys(artifact, TOP_KEYS) || artifact.schema !== SCHEMA || !iso(artifact.generatedAt)
      || !safeText(artifact.runId, 160) || !STATUSES.has(artifact.status)
      || typeof artifact.baselineCreated !== "boolean" || !Array.isArray(artifact.repositories)
      || artifact.repositories.length !== REPOSITORIES.length || hasForbiddenKey(artifact)) return false;
  return artifact.repositories.every((entry, index) => validateEntry(entry, REPOSITORIES[index]));
}

function validateBaseline(baseline) {
  return exactKeys(baseline, ["version", "repositories"]) && baseline.version === BASELINE_VERSION
    && Array.isArray(baseline.repositories) && baseline.repositories.length === REPOSITORIES.length
    && baseline.repositories.every((entry, index) => validateEntry(entry, REPOSITORIES[index]))
    && !hasForbiddenKey(baseline);
}

function validateV3Baseline(baseline) {
  return exactKeys(baseline, ["version", "repositories"]) && baseline.version === V3_BASELINE_VERSION
    && Array.isArray(baseline.repositories) && baseline.repositories.length === V3_REPOSITORIES.length
    && baseline.repositories.every((entry, index) => validateEntry(entry, V3_REPOSITORIES[index]))
    && !hasForbiddenKey(baseline);
}

function validatePriorBaseline(baseline) {
  return exactKeys(baseline, ["version", "repositories"]) && baseline.version === PRIOR_BASELINE_VERSION
    && Array.isArray(baseline.repositories) && baseline.repositories.length === PRIOR_REPOSITORIES.length
    && baseline.repositories.every((entry, index) => validateEntry(entry, PRIOR_REPOSITORIES[index]))
    && !hasForbiddenKey(baseline);
}

function validateLegacyBaseline(baseline) {
  return exactKeys(baseline, ["version", "repositories"]) && baseline.version === LEGACY_BASELINE_VERSION
    && Array.isArray(baseline.repositories) && baseline.repositories.length === LEGACY_REPOSITORIES.length
    && baseline.repositories.every((entry, index) => validateEntry(entry, LEGACY_REPOSITORIES[index], LEGACY_CHAIN_IDS))
    && !hasForbiddenKey(baseline);
}

function migrateBaseline(baseline) {
  const entriesById = new Map(baseline.repositories.map((entry) => [entry.id, entry]));
  return {
    version: BASELINE_VERSION,
    repositories: REPOSITORIES.map((repository) => entriesById.get(repository.id) || null)
  };
}

function leakScan(value) {
  const text = JSON.stringify(value);
  return !ADDRESS_TEXT.test(text)
    && !TOKEN_PATTERN.test(text)
    && !/(?:authorization|private[_-]?key|client[_-]?secret|access[_-]?token)/i.test(text)
    && !hasForbiddenKey(value);
}

function encodedRef(branch) { return branch.split("/").map(encodeURIComponent).join("/"); }
function urlsFor(repository, branch, oldSha, newSha) {
  const base = `https://api.github.com/repos/${repository.id}`;
  return {
    metadata: base,
    ref: branch ? `${base}/git/ref/heads/${encodedRef(branch)}` : null,
    releases: `${base}/releases?per_page=10`,
    compare: oldSha && newSha ? `${base}/compare/${oldSha}...${newSha}` : null
  };
}
function treeUrlFor(repository, commit) {
  return `https://api.github.com/repos/${repository.id}/git/trees/${commit}?recursive=1`;
}

function normalizeToken(value) {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(token)) return null;
  return token;
}

function tokenFromEnvironment(env = process.env) {
  for (const name of TOKEN_ENV_NAMES) {
    const token = normalizeToken(env ? env[name] : null);
    if (token) return token;
  }
  return null;
}

function tokenFromGhCli() {
  for (const command of ["gh", GH_CLI_ABSOLUTE_PATH]) {
    try {
      const stdout = execFileSync(command, ["auth", "token"], {
        encoding: "utf8", timeout: GH_TOKEN_TIMEOUT_MS, windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024
      });
      const token = normalizeToken(stdout);
      if (token) return token;
    } catch (_) { /* fall through to anonymous */ }
  }
  return null;
}

// Resolved at most once per process. The value is captured in-process only and is never
// logged, persisted, or passed as a command-line argument; failures fall back to anonymous.
//
// No scheduler-daemon restart is required for changes to this sentinel: the trigger-watch
// scheduler spawns this script as a fresh child process on every discovery
// (tools/run-critical-trigger-watch-scheduler.js -> spawn(process.execPath, [commandPath, ...])),
// so a new token-aware build is loaded automatically on the next discovery cycle.
let cachedToken = null;
let tokenResolved = false;
function resolveGitHubToken() {
  if (!tokenResolved) {
    tokenResolved = true;
    let resolved = null;
    try {
      resolved = tokenFromEnvironment() || tokenFromGhCli();
    } catch (_) {
      resolved = null;
    }
    cachedToken = normalizeToken(resolved);
  }
  return cachedToken;
}

function requestHeaders(etag, token) {
  const headers = { "User-Agent": USER_AGENT, Accept: ACCEPT, "X-GitHub-Api-Version": API_VERSION };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers["If-None-Match"] = etag;
  return headers;
}

async function requestJson(transport, url, etag, maxBytes = MAX_RESPONSE_BYTES, token = null) {
  if (!apiUrl(url)) fail("BAD_ENDPOINT");
  let response;
  try {
    response = await transport(url, {
      method: "GET", headers: requestHeaders(etag, token), timeoutMs: TIMEOUT_MS,
      maxBytes, maxRedirects: 1
    });
  } catch (error) {
    if (error instanceof SentinelError) throw error;
    fail(error && error.code === "RATE_LIMITED" ? "RATE_LIMITED" : "TRANSPORT_FAILURE");
  }
  if (!response || !Number.isInteger(response.status)) fail("MALFORMED_RESPONSE");
  const headers = headersObject(response.headers);
  if (response.status === 403 || response.status === 429 || headers["x-ratelimit-remaining"] === "0") fail("RATE_LIMITED");
  if (response.status === 304) {
    if (!etag) fail("UNEXPECTED_NOT_MODIFIED");
    return { notModified: true, value: null, etag };
  }
  if (response.status >= 300 && response.status < 400) fail("BAD_REDIRECT");
  if (response.status === 404) fail("NOT_FOUND");
  if (response.status !== 200) fail("HTTP_FAILURE");
  const contentType = headers["content-type"] || "";
  if (!/^application\/(?:json|vnd\.github\+json)(?:\s*;|$)/i.test(contentType)) fail("BAD_CONTENT_TYPE");
  let raw = response.body;
  if (Buffer.isBuffer(raw)) raw = raw.toString("utf8");
  if (typeof raw === "string" && Buffer.byteLength(raw) > maxBytes) fail("OVERSIZE_RESPONSE");
  if (raw && typeof raw === "object" && Buffer.byteLength(JSON.stringify(raw)) > maxBytes) fail("OVERSIZE_RESPONSE");
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (value === undefined || value === null) fail("MALFORMED_JSON");
    return { notModified: false, value, etag: safeEtag(headers.etag) };
  } catch (error) {
    if (error instanceof SentinelError) throw error;
    fail("MALFORMED_JSON");
  }
}

function parseMetadata(value, repository, previous) {
  if (!value || typeof value !== "object" || value.full_name !== repository.id
      || !value.owner || value.owner.login !== repository.owner || (value.fork !== false && !FORK_ALLOWED.has(repository.id))
      || value.html_url !== repository.officialUrl || !safeBranch(value.default_branch)) fail("INVALID_REPOSITORY_IDENTITY");
  if (previous && previous.defaultBranch !== value.default_branch) fail("BRANCH_RENAME");
  return value.default_branch;
}
function parseRef(value, branch) {
  if (!value || typeof value !== "object" || value.ref !== `refs/heads/${branch}` || !value.object
      || typeof value.object.sha !== "string" || !/^[0-9a-f]{40}$/.test(value.object.sha)) fail("MALFORMED_REF");
  return value.object.sha;
}
function parseReleases(value) {
  if (!Array.isArray(value) || value.length > 10) fail("MALFORMED_RELEASES");
  const releaseIds = [], tags = [];
  for (const release of value) {
    if (!release || !Number.isSafeInteger(release.id) || release.id < 1 || !safeText(release.tag_name, 200)) fail("MALFORMED_RELEASES");
    releaseIds.push(release.id);
    tags.push(release.tag_name);
  }
  if (unique(releaseIds).length !== releaseIds.length || unique(tags).length !== tags.length) fail("MALFORMED_RELEASES");
  return { releaseIds, tags };
}
function ignoredPath(filename) {
  const lower = filename.toLowerCase();
  const parts = lower.split("/");
  if (parts.some((part) => ["docs", "doc", "test", "tests", "__tests__", ".github", ".circleci", "ci"].includes(part))) return true;
  const base = parts[parts.length - 1];
  return /(?:^|[-.])lock(?:\.|$)/.test(base) || [
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "cargo.lock",
    "go.sum", "go.mod", "requirements.txt", "poetry.lock", "pipfile", "pipfile.lock", "remappings.txt"
  ].includes(base);
}
function isAllowedPath(filename) {
  return safePath(filename) && MANIFEST_PREFIXES.some((prefix) => filename.startsWith(prefix)) && !ignoredPath(filename);
}
function parseCompare(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.files)) fail("MALFORMED_COMPARE");
  const paths = [];
  for (const file of value.files) {
    // Compare responses list every changed file, including address-named deployment dumps.
    // Only shape is checked here; the address-rejecting `safePath` is applied by
    // `isAllowedPath` to the allowed manifest paths that are actually retained.
    if (!file || !safePathShape(file.filename)) fail("MALFORMED_COMPARE");
    if (isAllowedPath(file.filename)) paths.push(file.filename);
  }
  return unique(paths).sort();
}
function parseTree(value) {
  if (!value || typeof value !== "object" || value.truncated !== false || !Array.isArray(value.tree)
      || value.tree.length > MAX_TREE_ENTRIES) fail("MALFORMED_TREE");
  const files = new Map();
  for (const entry of value.tree) {
    if (!entry || !["blob", "tree", "commit"].includes(entry.type)
        || typeof entry.mode !== "string" || !/^[0-7]{6}$/.test(entry.mode)
        || typeof entry.sha !== "string" || !/^[0-9a-f]{40}$/.test(entry.sha)) fail("MALFORMED_TREE");
    if (entry.type !== "blob") continue;
    // A bounded complete tree contains the whole repository, so non-manifest and
    // address-named paths must be walkable without tripping the address-rejecting
    // `safePath`; only allowed manifest paths are retained (via `isAllowedPath`).
    if (!safePathShape(entry.path)) fail("MALFORMED_TREE");
    if (isAllowedPath(entry.path)) {
      if (files.has(entry.path)) fail("MALFORMED_TREE");
      files.set(entry.path, `${entry.mode}:${entry.sha}`);
    }
  }
  return files;
}
function changedPathsFromTrees(previousTree, observedTree) {
  return unique([...previousTree.keys(), ...observedTree.keys()])
    .filter((filename) => previousTree.get(filename) !== observedTree.get(filename))
    .sort();
}
function hintsFor(paths, hasRelease, sourceClass) {
  const hints = [];
  const add = (hint) => { if (!hints.includes(hint)) hints.push(hint); };
  for (const filename of paths) {
    const lower = filename.toLowerCase();
    if (/(?:^|[/_.-])oracle(?:[/_.-]|$)/.test(lower)) add("oracle-config");
    if (/(?:pause|unpause)/.test(lower)) add("pause-unpause-config");
    if (lower.startsWith("deploy/") || lower.startsWith("deployments/") || lower.startsWith("addresses/") || sourceClass === "deployment-registry") add("deployment-manifest");
    else if (lower.startsWith("governance/") || lower.startsWith("proposals/") || sourceClass === "governance") add("governance-source");
    else if (lower.startsWith("contracts/") || lower.startsWith("src/")) add("implementation");
    else add("unknown");
  }
  if (hasRelease) add("release");
  return hints;
}
function chainsFor(repositoryId, paths) {
  const exact = new Set(identityModule.exactChainIdsForPaths(repositoryId, paths));
  return CHAIN_IDS.filter((id) => exact.has(id)
    || paths.some((filename) => new RegExp(`(^|[^0-9])${id}([^0-9]|$)`).test(filename)));
}

function fallbackEntry(repository, previous, pollStatus, observedAt) {
  return {
    id: repository.id, officialUrl: repository.officialUrl, defaultBranch: previous ? previous.defaultBranch : null,
    sourceClass: repository.sourceClass, observedHeadSha: previous ? previous.observedHeadSha : null,
    previousHeadSha: previous ? previous.observedHeadSha : null,
    releaseIds: previous ? [...previous.releaseIds] : [], tags: previous ? [...previous.tags] : [],
    configuredManifestPaths: [...MANIFEST_PREFIXES], changedManifestPaths: [], changeHints: [], chainTextHints: [],
    evidenceUrls: [], etagByUrl: previous ? { ...previous.etagByUrl } : {}, pollStatus, observedAt
  };
}

async function pollRepository(repository, previous, transport, observedAt, token = null) {
  const evidenceUrls = [], etagByUrl = {};
  const previousEtags = previous ? previous.etagByUrl : {};
  const initialUrls = urlsFor(repository, previous && previous.defaultBranch, null, null);
  evidenceUrls.push(initialUrls.metadata);
  const metadata = await requestJson(transport, initialUrls.metadata, previousEtags[initialUrls.metadata], MAX_RESPONSE_BYTES, token);
  if (metadata.etag) etagByUrl[initialUrls.metadata] = metadata.etag;
  let branch;
  if (metadata.notModified) {
    if (!previous || !previous.defaultBranch) fail("MISSING_CACHED_METADATA");
    branch = previous.defaultBranch;
  } else branch = parseMetadata(metadata.value, repository, previous);

  const urls = urlsFor(repository, branch, null, null);
  evidenceUrls.push(urls.ref);
  const ref = await requestJson(transport, urls.ref, previousEtags[urls.ref], MAX_RESPONSE_BYTES, token);
  if (ref.etag) etagByUrl[urls.ref] = ref.etag;
  let head;
  if (ref.notModified) {
    if (!previous || !previous.observedHeadSha) fail("MISSING_CACHED_REF");
    head = previous.observedHeadSha;
  } else head = parseRef(ref.value, branch);

  evidenceUrls.push(urls.releases);
  const releases = await requestJson(transport, urls.releases, previousEtags[urls.releases], MAX_RESPONSE_BYTES, token);
  if (releases.etag) etagByUrl[urls.releases] = releases.etag;
  let releaseData;
  if (releases.notModified) {
    if (!previous) fail("MISSING_CACHED_RELEASES");
    releaseData = { releaseIds: [...previous.releaseIds], tags: [...previous.tags] };
  } else releaseData = parseReleases(releases.value);

  let changedManifestPaths = [];
  const headChanged = Boolean(previous && previous.observedHeadSha !== head);
  if (headChanged) {
    const compareUrl = urlsFor(repository, branch, previous.observedHeadSha, head).compare;
    evidenceUrls.push(compareUrl);
    try {
      const compared = await requestJson(transport, compareUrl, previousEtags[compareUrl], MAX_RESPONSE_BYTES, token);
      if (compared.notModified) fail("UNEXPECTED_COMPARE_304");
      if (compared.etag) etagByUrl[compareUrl] = compared.etag;
      changedManifestPaths = parseCompare(compared.value);
    } catch (error) {
      if (!error || !["NOT_FOUND", "OVERSIZE_RESPONSE"].includes(error.code)) throw error;
      const previousTreeUrl = treeUrlFor(repository, previous.observedHeadSha);
      const observedTreeUrl = treeUrlFor(repository, head);
      // Keep the published v1 URL set backward-compatible with already-running scheduler validators.
      // The bounded trees are discovery inputs only; downstream exact-source gates remain authoritative.
      // Tree bodies are not retained in the baseline, so they must never be conditionally fetched.
      const previousTreeResponse = await requestJson(transport, previousTreeUrl, null, MAX_TREE_RESPONSE_BYTES, token);
      const observedTreeResponse = await requestJson(transport, observedTreeUrl, null, MAX_TREE_RESPONSE_BYTES, token);
      if (previousTreeResponse.notModified || observedTreeResponse.notModified) fail("UNEXPECTED_TREE_304");
      changedManifestPaths = changedPathsFromTrees(
        parseTree(previousTreeResponse.value), parseTree(observedTreeResponse.value)
      );
    }
  }
  const newRelease = Boolean(previous && releaseData.releaseIds.some((id) => !previous.releaseIds.includes(id)));
  const candidate = Boolean(previous && (changedManifestPaths.length || newRelease));
  return {
    id: repository.id, officialUrl: repository.officialUrl, defaultBranch: branch, sourceClass: repository.sourceClass,
    observedHeadSha: head, previousHeadSha: previous ? previous.observedHeadSha : null,
    releaseIds: releaseData.releaseIds, tags: releaseData.tags, configuredManifestPaths: [...MANIFEST_PREFIXES],
    changedManifestPaths, changeHints: hintsFor(changedManifestPaths, newRelease, repository.sourceClass),
    chainTextHints: chainsFor(repository.id, changedManifestPaths), evidenceUrls: unique(evidenceUrls), etagByUrl,
    pollStatus: candidate ? "candidate-change" : "unchanged", observedAt
  };
}

async function readBaseline(filename) {
  try {
    const stat = await fs.promises.stat(filename);
    if (stat.size > MAX_RESPONSE_BYTES) fail("INVALID_BASELINE");
    const parsed = JSON.parse(await fs.promises.readFile(filename, "utf8"));
    if (!leakScan(parsed)) fail("INVALID_BASELINE");
    if (validateBaseline(parsed)) return parsed;
    if (validateV3Baseline(parsed) || validatePriorBaseline(parsed) || validateLegacyBaseline(parsed)) return migrateBaseline(parsed);
    fail("INVALID_BASELINE");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    if (error instanceof SentinelError) throw error;
    fail("INVALID_BASELINE");
  }
}

async function atomicWriteJson(filename, value) {
  await fs.promises.mkdir(path.dirname(filename), { recursive: true });
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fs.promises.rename(temporary, filename);
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function appendRun(runsDir, artifact) {
  await fs.promises.mkdir(runsDir, { recursive: true });
  const filename = path.join(runsDir, `${artifact.runId}.json`);
  const temporary = path.join(runsDir, `.${artifact.runId}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fs.promises.link(temporary, filename);
  } catch (error) {
    if (error && error.code === "EEXIST") fail("RUN_ID_COLLISION");
    throw error;
  } finally {
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

function createDefaultTransport() {
  async function request(url, options, redirectsLeft = options.maxRedirects) {
    if (!apiUrl(url)) fail("BAD_ENDPOINT");
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => { if (!settled) { settled = true; callback(value); } };
      const req = https.request(url, { method: "GET", headers: options.headers }, (res) => {
        const status = res.statusCode || 0;
        if (isRedirectStatus(status)) {
          const declared = Number(res.headers["content-length"] || 0);
          if (declared > options.maxBytes) { res.destroy(); return finish(reject, new SentinelError("OVERSIZE_RESPONSE")); }
          let redirectBytes = 0;
          res.on("data", (chunk) => {
            redirectBytes += chunk.length;
            if (redirectBytes > options.maxBytes) { res.destroy(); finish(reject, new SentinelError("OVERSIZE_RESPONSE")); }
          });
          res.on("error", (error) => finish(reject, error));
          res.on("end", () => {
            if (settled) return;
            if (redirectsLeft < 1 || !res.headers.location) return finish(reject, new SentinelError("BAD_REDIRECT"));
            let next;
            try { next = new URL(res.headers.location, url).toString(); } catch (_) { return finish(reject, new SentinelError("BAD_REDIRECT")); }
            if (!apiUrl(next)) return finish(reject, new SentinelError("BAD_REDIRECT"));
            const redirectedOptions = { ...options, headers: { ...options.headers } };
            if (next !== url) delete redirectedOptions.headers["If-None-Match"];
            return request(next, redirectedOptions, redirectsLeft - 1).then((value) => finish(resolve, value), (error) => finish(reject, error));
          });
          res.resume();
          return;
        }
        const chunks = [];
        let bytes = 0;
        const declared = Number(res.headers["content-length"] || 0);
        if (declared > options.maxBytes) { res.destroy(); return finish(reject, new SentinelError("OVERSIZE_RESPONSE")); }
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > options.maxBytes) { res.destroy(); finish(reject, new SentinelError("OVERSIZE_RESPONSE")); }
          else chunks.push(chunk);
        });
        res.on("end", () => finish(resolve, { status, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", (error) => finish(reject, error));
      });
      req.setTimeout(options.timeoutMs, () => { const error = new Error("TIMEOUT"); error.code = "TIMEOUT"; req.destroy(error); });
      req.on("error", (error) => finish(reject, error));
      req.end();
    });
  }
  return request;
}

async function runSentinel(options = {}) {
  const outputPath = options.outputPath || DEFAULT_OUTPUT;
  const baselinePath = options.baselinePath || DEFAULT_BASELINE;
  const runsDir = options.runsDir || DEFAULT_RUNS_DIR;
  const transport = options.transport || createDefaultTransport();
  const tokenProvider = options.tokenProvider || resolveGitHubToken;
  let token = null;
  try {
    token = normalizeToken(tokenProvider());
  } catch (_) {
    token = null;
  }
  const nowValue = options.now ? options.now() : Date.now();
  const generatedAt = new Date(nowValue).toISOString();
  const suffix = options.randomId ? options.randomId() : crypto.randomUUID();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(suffix)) fail("INVALID_RUN_ID");
  const runId = `${generatedAt.replace(/[:.]/g, "-")}_${suffix}`;
  let baseline;
  try { baseline = await readBaseline(baselinePath); } catch (_) {
    baseline = undefined;
  }
  const entries = [];
  const baselineFailure = baseline === undefined;
  let failureStatus = baselineFailure ? "incomplete" : null;
  for (let index = 0; index < REPOSITORIES.length; index += 1) {
    const repository = REPOSITORIES[index];
    const previous = baseline && baseline.repositories[index];
    if (baselineFailure || failureStatus === "rate-limited") {
      entries.push(fallbackEntry(repository, previous, failureStatus, generatedAt));
      continue;
    }
    try {
      entries.push(await pollRepository(repository, previous, transport, generatedAt, token));
    } catch (error) {
      const entryFailure = error && error.code === "RATE_LIMITED" ? "rate-limited" : "incomplete";
      failureStatus = entryFailure === "rate-limited" ? "rate-limited" : (failureStatus || entryFailure);
      entries.push(fallbackEntry(repository, previous, entryFailure, generatedAt));
    }
  }
  const status = failureStatus || (entries.some((entry) => entry.pollStatus === "candidate-change") ? "candidate-change" : "unchanged");
  const artifact = {
    schema: SCHEMA, generatedAt, runId, status,
    baselineCreated: baseline === null && !failureStatus,
    repositories: entries
  };
  if (!validateRunArtifact(artifact) || !leakScan(artifact)) fail("ARTIFACT_VALIDATION_FAILED");
  if (!failureStatus) {
    const nextBaseline = { version: BASELINE_VERSION, repositories: entries };
    if (!validateBaseline(nextBaseline) || !leakScan(nextBaseline)) fail("BASELINE_VALIDATION_FAILED");
    await atomicWriteJson(baselinePath, nextBaseline);
  }
  await appendRun(runsDir, artifact);
  await atomicWriteJson(outputPath, artifact);
  return artifact;
}

async function main(argv = process.argv.slice(2)) {
  if (!(argv.length === 0 || (argv.length === 1 && argv[0] === "--once"))) {
    process.stderr.write("official-deployed-delta-sentinel: unsupported arguments; use --once\n");
    process.exitCode = 2;
    return;
  }
  try {
    const artifact = await runSentinel();
    process.stdout.write(`official-deployed-delta-sentinel: ${artifact.status} ${artifact.runId}\n`);
  } catch (error) {
    process.stderr.write(`official-deployed-delta-sentinel: ${error instanceof SentinelError ? error.code : "FAILED"}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  SCHEMA, BASELINE_VERSION, V3_BASELINE_VERSION, PRIOR_BASELINE_VERSION, TIMEOUT_MS, MAX_RESPONSE_BYTES, MAX_TREE_RESPONSE_BYTES,
  MAX_TREE_ENTRIES, USER_AGENT, ACCEPT, API_VERSION,
  REPOSITORIES, V3_REPOSITORIES, FORK_ALLOWED, MANIFEST_PREFIXES, DEFAULT_OUTPUT, OUTPUT: DEFAULT_OUTPUT, DEFAULT_BASELINE, DEFAULT_RUNS_DIR,
  SentinelError, urlsFor, treeUrlFor, validateRunArtifact, validateBaseline, leakScan, isRedirectStatus, createDefaultTransport,
  resolveGitHubToken, tokenFromEnvironment, normalizeToken, requestHeaders,
  validateArtifact: validateRunArtifact, pollRepository, runSentinel, main
};

if (require.main === module) void main();
