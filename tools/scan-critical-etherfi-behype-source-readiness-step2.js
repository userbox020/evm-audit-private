#!/usr/bin/env node
"use strict";

// Exhaustive local-workspace source-readiness search. This scanner performs no
// network, RPC, endpoint-inventory, fork, live-call, signing, or state action.
// Secret-bearing paths are excluded without reading or persisting their names.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-source-readiness-step2";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-23-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-23-${NAME}-handoff.md`;
const STEP1 = "reports/raw/fast/critical-etherfi-behype-destination-fee-amplification-step1.json";
const STEP4 = "reports/raw/fast/critical-etherfi-behype-staker-layerzero-binding.json";
const STEP4_MANIFEST = "reports/raw/fast/critical-etherfi-behype-staker-layerzero-binding-manifest.json";
const CASH_INTERFACE = "targets/cash-v3/src/interfaces/IL2BeHYPEOAppStaker.sol";
const CASH_MODULE = "targets/cash-v3/src/modules/hype/BeHYPEStakeModule.sol";
const REVISION = "behype-source-readiness-step2-offline-exhaustive-r1";
const AGENT = "critical-etherfi-behype-source-readiness-step2-20260723";
const OWN_OUTPUTS = new Set([RAW, MANIFEST, REPORT, INBOX, HANDOFF].map((x) => x.toLowerCase()));
const TEXT_EXTENSIONS = new Set([".sol", ".json", ".js", ".cjs", ".mjs", ".ts", ".tsx", ".md", ".txt", ".toml", ".yaml", ".yml", ".lock", ".html", ".xml", ".csv", ".hex"]);
const CONTRACT_NAMES = ["L1BeHYPEOAppStaker", "L2BeHYPEOAppStaker", "WHYPEOFT", "BeHYPEOFT", "wHYPEOFTAdapter"];
const ADDRESSES = [
  "0x3f1bdae959ced680e434fe201861e97976ea4a8f", "0x18c814ec6d034a7fc62eeab64939a8b786381383",
  "0xe6a3bcd93e9d56e5252db47ff512629fd3cc9b54", "0xa86a273542cf89b56acdab454b5cb2b8b3dbc7a3",
  "0xd83e3d560ba6f05094d9d8b3eb8aaea571d1864e", "0xa519afbc91986c0e7501d7e34968fee51cd901ac",
  "0xb9dd8a0f0a1f879f168a476aec5cdc3022f826f1", "0x2b7e48511ea616101834f09945c11f7d78d9136d",
  "0x637de4a55cdd37700f9b54451b709b01040d48df",
];
const HASHES = [
  "b5e2a67ec9caf9a10169f6cbce8878f02132f661d89bb093d893e32097d10368",
  "37ff6d26dc3c4cdc7a923ede4e2e04c55f8001b2a67a4dfeda86688f9691aa17",
  "9026141acf6017d5ecd467e40c8e52edcd5beb4b094596ddf691d172fa435cec",
  "1e091ea06dc7c8704b7c8ab3c42aef690069435345748319f35b0431e94c11f3",
  "6adabcfe374c6f033ef14575487d4a407f309b151afb0440268d068a23b77795",
  "4a32c1ac0bd365e2a0ed68ab13229f5052c9f119c9e12e5093160dc718cf3baf",
  "4e8ae554a95d106448d612a9bcec49969d89f44cc2169c473a3f0888446ec887",
  "ca0e553a8ee4c56d978156ed3bd6dda4a99f2a798c40e654c9144483ae4bdff7",
  "9faac4c285ba607b1f9b717ca1aac48b37d95abd3041950e716ec0ff6f3aab4a",
  "4965139a366efebd923fad66fec0016123625f6fe67f23427107e59515319290",
  "7b6401f8fb3d35f0290f34848873073ff1d71cf54c2e9d749161668433c583ba",
];
const SEARCH_TERMS = [...CONTRACT_NAMES, ...ADDRESSES, ...HASHES].map((x) => x.toLowerCase());
const SECRET_FILE = /(^|\/)(?:\.env(?:\..*)?|rpc_endpoints\.txt|graphql_endpoints\.txt|[^/]*(?:private[-_]?key|keypair|keystore|mnemonic|seed[-_]?phrase)[^/]*|[^/]+\.(?:pem|p12|pfx|key))$/i;
const CACHE_DIR = /(^|\/)(?:node_modules|\.npm|npm-cache|package-cache|\.cache|cache)(\/|$)/i;
const BUILD_PATH = /(^|\/)(?:out|artifacts?|build-info|cache|broadcast|deployments?|release)(\/|$)/i;
const METADATA_PATH = /(metadata|standard[-_]?json|build[-_]?info|creation|bytecode|cbor|ipfs|explorer|source[-_]?dump|artifact)/i;

const abs = (x) => path.join(ROOT, x);
const rel = (x) => path.relative(ROOT, x).replace(/\\/g, "/");
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const hashFile = (p) => { const b = fs.readFileSync(abs(p)); return { path: p, bytes: b.length, sha256: sha(b) }; };
function writeOwned(p, text) {
  if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(p)) throw new Error(`write refused ${p}`);
  fs.mkdirSync(path.dirname(abs(p)), { recursive: true });
  fs.writeFileSync(abs(p), text, "utf8");
}
function git(cwd, args, timeout = 180_000) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout, maxBuffer: 512 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "", timedOut: Boolean(r.error?.code === "ETIMEDOUT") };
}
function isTextCandidate(file, relative) {
  const ext = path.extname(file).toLowerCase();
  const lower = relative.toLowerCase();
  const targetPath = /(behype|whype|oappstaker|layerzero-binding|destination-fee|etherfi)/i.test(relative) || ADDRESSES.some((x) => lower.includes(x.slice(2))) || HASHES.some((x) => lower.includes(x));
  const buildObject = (METADATA_PATH.test(relative) || BUILD_PATH.test(relative)) && [".json", ".sol", ".hex", ".txt", ".js"].includes(ext);
  const packageObject = CACHE_DIR.test(relative) && (ext === ".sol" || /(?:package\.json|soljson|solc(?:\.exe)?$)/i.test(path.basename(file)));
  return ext === ".sol" || targetPath || buildObject || packageObject || CONTRACT_NAMES.some((x) => path.basename(file).toLowerCase().includes(x.toLowerCase()));
}
function classify(relative, text, matchedTerms) {
  const lower = text.toLowerCase();
  const bodies = CONTRACT_NAMES.filter((name) => new RegExp(`\\b(?:contract|library)\\s+${name}\\b`, "i").test(text));
  const interfaces = CONTRACT_NAMES.filter((name) => new RegExp(`\\binterface\\s+I?${name}\\b`, "i").test(text));
  const standardJson = /"language"\s*:\s*"Solidity"/i.test(text) && /"sources"\s*:/i.test(text) && /"settings"\s*:/i.test(text);
  const buildInfo = /hh-sol-build-info/i.test(text) || (/"input"\s*:/i.test(text) && /"output"\s*:/i.test(text) && standardJson);
  const bytecodePayload = /"(?:deployed_?bytecode|deployedBytecode|runtimeBytecode|creationBytecode|bytecode)"\s*:\s*"(?:0x)?[0-9a-f]{512,}"/i.test(text);
  const sourcePayload = bodies.length > 0 || /"source_code"\s*:\s*"[^"].{100,}/is.test(text) || /"content"\s*:\s*"[^"].{100,}/is.test(text);
  const metadataReference = /(ipfs|bzzr|cbor|metadatahash|metadata_hash)/i.test(text);
  let category = "context-reference";
  if (bodies.length) category = "exact-name-source-body";
  else if (standardJson) category = "standard-json-or-build-info";
  else if (bytecodePayload) category = "bytecode-payload";
  else if (interfaces.length) category = "interface-source";
  else if (/explorer|source[-_]?dump/i.test(relative)) category = "explorer-or-source-dump-context";
  else if (BUILD_PATH.test(relative)) category = "build-deployment-context";
  else if (CACHE_DIR.test(relative)) category = "package-cache-context";
  return { category, bodies, interfaces, standardJson, buildInfo, bytecodePayload, sourcePayload, metadataReference, matchedTerms, containsCompilerSettings: /compiler_(?:version|settings)|"compiler"\s*:|"optimizer"\s*:/i.test(text), containsCreationContext: /creation(?:code|bytecode|input)|constructorarguments/i.test(lower) };
}
function readAndSearch(file, relative, size) {
  const maxFull = 128 * 1024 * 1024;
  let text = "";
  let fileSha;
  if (size <= maxFull) {
    const data = fs.readFileSync(file);
    fileSha = sha(data);
    text = data.toString("utf8");
  } else {
    const hash = crypto.createHash("sha256");
    const fd = fs.openSync(file, "r");
    const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
    let offset = 0;
    let tail = "";
    const excerpts = [];
    try {
      while (offset < size) {
        const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
        if (!n) break;
        const b = chunk.subarray(0, n);
        hash.update(b);
        const s = tail + b.toString("utf8");
        const low = s.toLowerCase();
        if (SEARCH_TERMS.some((term) => low.includes(term))) excerpts.push(s);
        tail = s.slice(-512);
        offset += n;
      }
    } finally { fs.closeSync(fd); }
    fileSha = hash.digest("hex");
    text = excerpts.join("\n");
  }
  const lower = text.toLowerCase();
  const matchedTerms = SEARCH_TERMS.filter((term) => lower.includes(term));
  if (!matchedTerms.length && !CONTRACT_NAMES.some((x) => relative.toLowerCase().includes(x.toLowerCase()))) return null;
  return { path: relative, bytes: size, sha256: fileSha, ...classify(relative, text, matchedTerms) };
}
function findGitObjectHits(repos) {
  const results = [];
  const repoRows = [];
  const pathNeedle = /(L1BeHYPEOAppStaker|L2BeHYPEOAppStaker|BeHYPEOFT|WHYPEOFT|wHYPEOFTAdapter|UUPSProxy\.sol)/i;
  for (const repo of repos) {
    const listing = git(repo, ["rev-list", "--all", "--objects"], 300_000);
    const row = { repo: rel(repo), revListOk: listing.ok, timedOut: listing.timedOut, objectPathRows: 0, historyContentSearchExecuted: false, historyContentHits: 0 };
    if (listing.ok) {
      for (const line of listing.stdout.split(/\r?\n/)) {
        const m = line.match(/^([0-9a-f]{40,64})\s+(.+)$/i);
        if (!m || !pathNeedle.test(m[2])) continue;
        const object = m[1];
        const p = m[2];
        const sizeR = git(repo, ["cat-file", "-s", object]);
        const bodyR = git(repo, ["cat-file", "-p", object]);
        const body = bodyR.ok ? bodyR.stdout : "";
        const bodies = CONTRACT_NAMES.filter((name) => new RegExp(`\\b(?:contract|library)\\s+${name}\\b`, "i").test(body));
        results.push({ repo: rel(repo), object, path: p.replace(/\\/g, "/"), bytes: sizeR.ok ? Number(sizeR.stdout.trim()) : null, contentSha256: bodyR.ok ? sha(body) : null, bodies, interfaceOnly: /interface\s+IL2BeHYPEOAppStaker/i.test(body) && !/contract\s+L2BeHYPEOAppStaker/i.test(body) });
        row.objectPathRows++;
      }
    }
    if (/(cash|etherfi)/i.test(row.repo)) {
      row.historyContentSearchExecuted = true;
      for (const needle of CONTRACT_NAMES) {
        const history = git(repo, ["log", "--all", "--format=%H", "--name-only", `-S${needle}`, "--", "*.sol", "*.json", "*.js", "*.ts", "*.md"], 300_000);
        if (!history.ok) continue;
        const lines = history.stdout.split(/\r?\n/).filter(Boolean);
        const commits = lines.filter((x) => /^[0-9a-f]{40,64}$/i.test(x));
        const paths = lines.filter((x) => !/^[0-9a-f]{40,64}$/i.test(x));
        if (commits.length || paths.length) {
          results.push({ repo: row.repo, historyNeedle: needle, commits: [...new Set(commits)].sort(), paths: [...new Set(paths.map((x) => x.replace(/\\/g, "/")))].sort() });
          row.historyContentHits += commits.length + paths.length;
        }
      }
    }
    repoRows.push(row);
  }
  return { repoRows, results: results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}
function compilerInventory(files) {
  const rows = files.filter((x) => /^(?:soljson(?:[-_.].*)?\.js|solc(?:\.exe)?)$/i.test(path.basename(x.path)) || /node_modules\/solc\/package\.json$/i.test(x.path));
  return rows.map((x) => {
    let version = null;
    const packagePath = /package\.json$/i.test(x.path) ? abs(x.path) : path.join(path.dirname(abs(x.path)), "package.json");
    try { version = JSON.parse(fs.readFileSync(packagePath, "utf8")).version || null; } catch {}
    if (!version) version = x.path.match(/solc(?:@|-npm-)(\d+\.\d+\.\d+)/i)?.[1] || null;
    let digest = x.sha256;
    if (!digest) { try { digest = sha(fs.readFileSync(abs(x.path))); } catch {} }
    return { path: x.path, bytes: x.bytes, sha256: digest, version };
  });
}
function componentMatrix(step4, search) {
  const sourceByKey = Object.fromEntries(step4.sourceEvidence.contracts.map((x) => [x.key, x]));
  const buildByName = Object.fromEntries(step4.sourceBuilds.contracts.map((x) => [x.contractName, x]));
  const anyExactBody = search.hits.some((x) => x.bodies.length && !x.path.startsWith("tools/") && !x.path.startsWith("reports/") && !x.path.startsWith("coordination/") && !x.path.includes("/test/"));
  if (anyExactBody) throw new Error("unexpected exact custom source body requires manual component remap");
  const row = (id, role, key, buildName, missingExtra = []) => {
    const source = sourceByKey[key] || {};
    const locallyBuiltKeys = new Set(["l2Proxy", "l2Implementation", "destinationProxy", "destinationImplementation"]);
    const build = locallyBuiltKeys.has(key) ? (buildByName[buildName] || null) : null;
    const shortCompilerVersion = String(source.compilerVersion || build?.compilerVersion || "").match(/v?(\d+\.\d+\.\d+)/)?.[1] || null;
    const compilerCandidates = search.compilerRows.filter((x) => x.version === shortCompilerVersion && /soljson/i.test(path.basename(x.path)));
    const runtime = source.onchainRuntimeKeccak256 || source.deployedBytecodeKeccak256 || build?.deployedKeccak256 || null;
    const exactProxyCandidate = source.name === "UUPSProxy";
    return {
      id, role, chainId: source.chainId ?? null, address: source.address ?? null, contractName: source.name || buildName || null,
      compilerVersion: source.compilerVersion || build?.compilerVersion || null,
      sourceCountReported: source.sourceCount ?? build?.sourceCount ?? null,
      sourceAggregateSha256: source.sourcesAggregateSha256 || null,
      standardJsonInputSha256: build?.standardJsonInputSha256 || null,
      runtimeKeccak256: runtime,
      exactCustomSourceBodyPresent: false,
      genericUupsProxySourceCandidatesPresent: exactProxyCandidate,
      exactStandardJsonPresent: false,
      exactBuildInfoPresent: false,
      creationBytecodePresent: false,
      deployedRuntimeBytesPresent: false,
      cborOrIpfsMetadataSnapshotPresent: false,
      exactCompilerBinaryPresentInWorkspace: compilerCandidates.length > 0,
      exactCompilerCandidates: compilerCandidates,
      deterministicLocalCompilationAttempted: false,
      deterministicLocalCompilationReason: "not-attempted-exact-inputs-absent",
      reproducibleBuildPossibleNow: false,
      predecessorExplorerRuntimeExact: source.explorerRuntimeExact === true,
      predecessorLocalExactBuildRuntime: build?.exactRuntime === true,
      currentRunIndependentRuntimeEquivalence: false,
      abiFunctionNamesAvailable: Array.isArray(source.abiFunctionNames) && source.abiFunctionNames.length > 0,
      evidenceClass: build?.exactRuntime === true ? "retained-step4-exact-build-runtime-proof-not-reproducible-now" : source.explorerRuntimeExact === true ? "retained-explorer-runtime-equality-plus-abi-metadata" : "abi-or-metadata-only",
      missingObjects: [
        source.sourcesAggregateSha256 ? `source bundle matching aggregate sha256 ${source.sourcesAggregateSha256}` : "complete source bundle with per-file paths and hashes",
        build?.standardJsonInputSha256 ? `canonical standard-json input matching sha256 ${build.standardJsonInputSha256}` : "canonical standard-json compiler input",
        runtime ? `deployed runtime bytes matching keccak256 ${runtime}` : "deployed runtime bytes and hash",
        "creation bytecode/input with constructor arguments and deployment transaction provenance",
        ...(compilerCandidates.length ? [] : ["compiler executable/soljson with content hash and exact version"]),
        "compiler metadata JSON plus runtime CBOR/IPFS/BZZ reference snapshot",
        ...missingExtra,
      ],
    };
  };
  return [
    row("l2-staker-proxy", "Optimism UUPS proxy", "l2Proxy", "UUPSProxy"),
    row("l2-staker-implementation", "public source-chain staker", "l2Implementation", "L2BeHYPEOAppStaker"),
    row("destination-receiver-proxy", "HyperEVM UUPS compose receiver proxy", "destinationProxy", "UUPSProxy"),
    row("destination-receiver-implementation", "HyperEVM compose/stake/return receiver", "destinationImplementation", "L1BeHYPEOAppStaker"),
    row("source-whype-oft", "Optimism WHYPE OFT", "sourceWhype", "WHYPEOFT"),
    row("destination-whype-adapter", "HyperEVM wHYPE OFT adapter", "destinationWhypeAdapter", "wHYPEOFTAdapter"),
    row("source-behype-proxy", "Optimism beHYPE OFT proxy", "sourceBehype", "UUPSProxy"),
    row("source-behype-implementation", "Optimism beHYPE OFT implementation", "sourceBehypeImplementation", "BeHYPEOFT"),
    row("destination-behype-adapter-proxy", "HyperEVM beHYPE OFT adapter proxy", "destinationBehypeAdapter", "UUPSProxy", ["EIP-1967 implementation identity and its source/runtime/build inputs were not retained in Step 4"]),
  ];
}

function main() {
  const generatedAt = new Date().toISOString();
  const scannerSha256 = hashFile(SCANNER).sha256;
  const step1 = JSON.parse(fs.readFileSync(abs(STEP1), "utf8"));
  const step4 = JSON.parse(fs.readFileSync(abs(STEP4), "utf8"));
  if (step1.revision !== "behype-destination-fee-amplification-step1-local-model-r1" || step1.pipeline?.stage !== 0) throw new Error("Step 1 mismatch");
  if (step4.revision !== "behype-staker-layerzero-binding-step4-reviewer-r2") throw new Error("Step 4 mismatch");

  const counters = { directoriesVisited: 0, filesVisited: 0, textFilesScanned: 0, bytesContentScanned: 0, secretFilesSkippedWithoutRead: 0, symlinksSkipped: 0, readErrors: 0, packageCacheDirectoriesVisited: 0, buildArtifactFilesVisited: 0 };
  const hits = [];
  const allTextFiles = [];
  const gitRepos = [];
  const visitedDirs = new Set();
  function walk(dir) {
    let real;
    try { real = fs.realpathSync(dir).toLowerCase(); } catch { counters.readErrors++; return; }
    if (visitedDirs.has(real)) return;
    visitedDirs.add(real);
    counters.directoriesVisited++;
    const relativeDir = rel(dir);
    if (/(^|\/)(?:target|test-ledger|coverage|\.next|dist)(\/|$)/i.test(relativeDir)) return;
    if (CACHE_DIR.test(relativeDir)) counters.packageCacheDirectoriesVisited++;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { counters.readErrors++; return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = rel(full);
      if (entry.name === ".git" && (entry.isDirectory() || entry.isFile())) { gitRepos.push(dir); continue; }
      let stat;
      try { stat = fs.lstatSync(full); } catch { counters.readErrors++; continue; }
      if (stat.isSymbolicLink()) { counters.symlinksSkipped++; continue; }
      if (stat.isDirectory()) { walk(full); continue; }
      if (!stat.isFile()) continue;
      counters.filesVisited++;
      if (SECRET_FILE.test(relative)) { counters.secretFilesSkippedWithoutRead++; continue; }
      if (OWN_OUTPUTS.has(relative.toLowerCase())) continue;
      if (BUILD_PATH.test(relative)) counters.buildArtifactFilesVisited++;
      if (!isTextCandidate(full, relative)) continue;
      counters.textFilesScanned++;
      counters.bytesContentScanned += stat.size;
      let hit;
      try { hit = readAndSearch(full, relative, stat.size); } catch { counters.readErrors++; continue; }
      const fileRow = hit || { path: relative, bytes: stat.size, sha256: null };
      allTextFiles.push(fileRow);
      if (hit) hits.push(hit);
    }
  }
  walk(ROOT);
  hits.sort((a, b) => a.path.localeCompare(b.path));
  const uniqueRepos = [...new Set(gitRepos.map((x) => fs.realpathSync(x)))].sort();
  const protocolRepos = uniqueRepos.filter((x) => /(cash|etherfi)/i.test(rel(x)));
  const gitSearch = findGitObjectHits(protocolRepos);
  const compilerRows = compilerInventory(allTextFiles);
  const exactCompilerRows = compilerRows.filter((x) => ["0.8.24", "0.8.28", "0.8.31"].includes(x.version) && /soljson/i.test(path.basename(x.path)));
  const search = { counters, hits, gitRepos: gitSearch.repoRows, gitObjectAndHistoryHits: gitSearch.results, compilerRows, exactCompilerRows };
  const matrix = componentMatrix(step4, search);

  const customBodyHits = hits.filter((x) => x.bodies.length > 0);
  const standardJsonContextHits = hits.filter((x) => x.standardJson);
  const buildInfoContextHits = hits.filter((x) => x.buildInfo);
  const exactStandardJsonHits = standardJsonContextHits.filter((x) => x.bodies.length > 0 && x.sourcePayload);
  const exactBuildInfoHits = buildInfoContextHits.filter((x) => x.bodies.length > 0 && x.sourcePayload);
  const bytecodePayloadHits = hits.filter((x) => x.bytecodePayload);
  const targetPackageCacheHits = hits.filter((x) => x.category === "package-cache-context");
  const gitCustomBodies = gitSearch.results.filter((x) => Array.isArray(x.bodies) && x.bodies.length > 0);
  const exactCustomSourceFound = customBodyHits.some((x) => !x.path.includes("/test/") && !x.path.startsWith("tools/") && !x.path.startsWith("reports/")) || gitCustomBodies.length > 0;
  if (exactCustomSourceFound) throw new Error("exact custom source unexpectedly found; rerun requires compile branch implementation");
  const compileAttempts = matrix.map((x) => ({ componentId: x.id, attempted: false, reason: "exact standard-json/source bundle/runtime bytes and compiler content hash are not jointly present" }));
  const classification = "INCOMPLETE/WATCH/SOURCE-READINESS-BLOCKED/RETAINED-STEP4-BINDINGS-NOT-LOCALLY-REPRODUCIBLE";
  const runId = `etherfi-behype-source-readiness-step2-${scannerSha256.slice(0, 12)}`;
  const acquisitionRequirements = matrix.map((x) => ({ componentId: x.id, address: x.address, contentAddressedObjects: x.missingObjects }));
  const nextGate = "Acquire the missing content-addressed source bundles, canonical standard-json inputs, compiler binaries, runtime/creation bytes, metadata snapshots, and destination beHYPE adapter implementation identity into a separately reviewed local evidence package. Re-run this scanner and compile only when each component's exact inputs and expected runtime hash are present; keep model/pipeline at 0/5 until independent deterministic runtime equivalence succeeds.";
  const result = {
    schemaVersion: 1, revision: REVISION, runId, generatedAt, scanner: SCANNER, agentId: AGENT, role: "critical-research", step: 2,
    classification, signal: "🟠 WATCH — SOURCE READINESS BLOCKED; STEP 4 PROOF RETAINED BUT NOT LOCALLY REPRODUCIBLE",
    pipeline: { stage: 0, totalStages: 5, upgraded: false }, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false,
    safety: { localWorkspaceOnly: true, rpcUsed: false, endpointInventoryRead: false, graphqlInventoryRead: false, webUsed: false, forkCreated: false, liveCalls: false, stateMutation: false, signingUsed: false, envOrSecretFilesRead: false, secretPathsSkippedWithoutRead: counters.secretFilesSkippedWithoutRead },
    predecessors: [STEP1, STEP4, STEP4_MANIFEST].map(hashFile),
    searchMethod: { deterministicSortedTraversal: true, relevantTextAndMetadataExtensions: [...TEXT_EXTENSIONS].sort(), largeFilesStreamScanned: true, filesystemSourceAndBuildSearchAllWorkspace: true, gitRepositoriesDiscovered: uniqueRepos.length, gitObjectPathsProtocolRelatedRepos: protocolRepos.map(rel), gitContentHistoryProtocolRepos: protocolRepos.map(rel), prunedGeneratedBinaryDirectories: ["target", "test-ledger", "coverage", ".next", "dist"], symlinksNotFollowed: true, secretPathPolicy: "count-only; names and contents not retained", ownOutputsExcluded: true },
    search,
    summaryCounts: { customSourceBodyHits: customBodyHits.length, standardJsonHits: exactStandardJsonHits.length, buildInfoHits: exactBuildInfoHits.length, exactStandardJsonHits: exactStandardJsonHits.length, exactBuildInfoHits: exactBuildInfoHits.length, standardJsonContextHits: standardJsonContextHits.length, buildInfoContextHits: buildInfoContextHits.length, bytecodePayloadHits: bytecodePayloadHits.length, targetPackageCacheHits: targetPackageCacheHits.length, gitCustomBodyHits: gitCustomBodies.length, compilerCacheObjects: compilerRows.length, exactCompilerCandidates: exactCompilerRows.length, componentCount: matrix.length, reproducibleComponentsNow: matrix.filter((x) => x.reproducibleBuildPossibleNow).length, predecessorLocalExactRuntimeComponents: matrix.filter((x) => x.predecessorLocalExactBuildRuntime).length, predecessorExplorerRuntimeExactComponents: matrix.filter((x) => x.predecessorExplorerRuntimeExact).length },
    componentMatrix: matrix,
    compileAttempts,
    retainedProofQualification: "Step 4 reported exact local build/runtime equality for the L2 staker and destination receiver proxy/implementation pairs and explorer-runtime equality for several OFT/proxy components. This run preserves those hashes as predecessor evidence but cannot reproduce them because source bodies/standard-json/runtime bytes/compiler objects were not retained.",
    exactSourceReadiness: { exactCustomSourceFound: false, exactStandardJsonFound: false, exactBuildInfoFound: false, targetCreationBytecodeFound: false, targetRuntimeBytesFound: false, targetCborIpfsSnapshotFound: false, exactCompilerBinaryFound: exactCompilerRows.length > 0, deterministicCompilationPossible: false, runtimeEquivalenceEstablishedByCurrentRun: false },
    acquisitionRequirements,
    findings: { modelCandidateUpgraded: false, pipelineUpgraded: false, productionPrimitiveEstablished: false, permissionlessLossEstablished: false, attackerProfitEstablished: false },
    blockers: [
      "No exact custom L1/L2 staker, destination receiver, WHYPEOFT, BeHYPEOFT, or wHYPEOFTAdapter source body was found in workspace files or matching Git-history objects.",
      "No target canonical standard-json input/build-info object was found; Step 4 retains only input/source aggregate hashes for exact-built components.",
      "No target runtime bytes, creation bytecode/input, constructor arguments, or CBOR/IPFS metadata snapshot was found; retained artifacts contain hashes and semantic summaries only.",
      "Compiler package caches were inventoried by version and content hash, but compiler availability alone cannot compensate for missing exact source/standard-json/runtime objects.",
      "Generic UUPSProxy source candidates and dependency libraries exist locally, but without the exact source bundle paths/hashes and standard-json they cannot establish production proxy equivalence independently.",
      "The destination beHYPE adapter proxy implementation identity and implementation source/runtime build package were not retained in Step 4.",
    ],
    nextGate,
  };
  writeOwned(RAW, JSON.stringify(result, null, 2) + "\n");

  const matrixRows = matrix.map((x) => `| ${x.id} | ${x.contractName || "unknown"} | ${x.exactCustomSourceBodyPresent} | ${x.standardJsonInputSha256 ? "hash-only" : "absent"} | ${x.reproducibleBuildPossibleNow} | ${x.predecessorLocalExactBuildRuntime ? "Step4 exact-build" : x.predecessorExplorerRuntimeExact ? "Step4 explorer-runtime" : "metadata/ABI"} |`).join("\n");
  const report = `# ${result.signal} — EtherFi BeHYPE source readiness Step 2\n\n**Classification:** \`${classification}\`  \n**Run:** \`${runId}\`  \n**Pipeline:** \`0/5\`  \n**Gates:** \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`, \`fork=false\`\n\n> The local workspace was traversed deterministically, including relevant build/artifact/package-cache files and Git object paths. No exact custom production source bundle or canonical compiler input was found. Step 4 runtime/build hashes remain valid predecessor evidence but cannot be independently reproduced from retained local objects. No compilation was attempted because exact inputs were absent.\n\n## Search coverage\n\n- Directories/files/text files: \`${counters.directoriesVisited}/${counters.filesVisited}/${counters.textFilesScanned}\`; bytes content-scanned: \`${counters.bytesContentScanned}\`.\n- Local Git repositories/object histories: \`${uniqueRepos.length}/${gitSearch.repoRows.filter((x) => x.revListOk).length}\`; protocol-repo content history searched for all five contract names.\n- Build/artifact files visited: \`${counters.buildArtifactFilesVisited}\`; package/cache directories visited: \`${counters.packageCacheDirectoriesVisited}\`.\n- Secret-bearing files skipped without read: \`${counters.secretFilesSkippedWithoutRead}\`; names and contents are not retained. Symlinks skipped: \`${counters.symlinksSkipped}\`; read errors: \`${counters.readErrors}\`.\n- Target custom bodies/exact standard-json/exact build-info/bytecode payload/exact compiler candidates: \`${result.summaryCounts.customSourceBodyHits}/${result.summaryCounts.exactStandardJsonHits}/${result.summaryCounts.exactBuildInfoHits}/${result.summaryCounts.bytecodePayloadHits}/${result.summaryCounts.exactCompilerCandidates}\`. Generic/context standard-json and build-info hits were \`${result.summaryCounts.standardJsonContextHits}/${result.summaryCounts.buildInfoContextHits}\` and did not contain the custom production bodies.\n\n## Component matrix\n\n| Component | Reported contract | Exact body | Standard JSON | Reproducible now | Strongest retained evidence |\n|---|---|---:|---|---:|---|\n${matrixRows}\n\n` +
  `\nThe four \`Step4 exact-build\` rows preserve prior exact compilation/runtime equality for both proxies and the L2/L1 implementations. This Step 2 does not downgrade that proof; it records that the source bodies, canonical inputs, runtime bytes, and compiler content objects required to reproduce it are absent. Explorer-runtime rows bind reported explorer bytecode to retained on-chain runtime hashes but are not local compilations.\n\n## Local candidates that are insufficient\n\n- Exact Cash-module source and \`IL2BeHYPEOAppStaker\` interface are present; the interface proves function shape only.\n- Generic \`UUPSProxy.sol\` and OpenZeppelin/LayerZero dependency trees exist locally. Their presence does not prove file-path/content/settings identity with the Step 4 source aggregates.\n- Deployment manifests contain surrounding Cash deployments but not the production staker/receiver/OFT build inputs.\n- Prior raw artifacts contain addresses, ABI names, compiler summaries, source/input hashes, immutable placements, and runtime hashes; no raw explorer source response, full standard-json, creation input, runtime bytes, or metadata CBOR was retained.\n- Filesystem source/build classes were searched workspace-wide; local Git object/content history was additionally searched for every protocol-related repository discovered under paths containing \`cash\` or \`etherfi\`. Generated binary directories were pruned because they cannot contain retained Solidity/compiler JSON objects not also represented by their build paths.\n\n## Precise acquisition gate\n\nEach matrix row in the raw artifact lists content-addressed missing objects. At minimum, acquire: source files with exact paths and aggregate hash; canonical standard-json matching the retained SHA-256 where known; compiler executable/soljson with its own hash; deployed runtime and creation input; constructor/immutable/link values; and metadata JSON plus CBOR/IPFS/BZZ reference. For the destination beHYPE adapter proxy, first acquire the implementation identity and runtime hash.\n\nNo guessed proxy/dependency rebuild was attempted because it could produce a coincidental runtime without proving the retained source bundle.\n\n**nextGate:** ${nextGate}\n`;
  writeOwned(REPORT, report);
  const inbox = { findingId: NAME, revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: classification, classification, pipeline: "0/5", routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: "Exhaustive local search found no exact custom source/standard-json/runtime/creation/metadata package; Step 4 bindings are retained but not locally reproducible.", searchCounts: result.summaryCounts, componentMatrix: matrix, exactSourceReadiness: result.exactSourceReadiness, blockers: result.blockers, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT], nextAction: nextGate };
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  writeOwned(HANDOFF, `# EtherFi BeHYPE source readiness Step 2 handoff\n\n- Run \`${runId}\`; classification \`${classification}\`; pipeline remains \`0/5\`.\n- Exhaustive sorted workspace traversal covered ${counters.directoriesVisited} directories, ${counters.filesVisited} files, ${counters.textFilesScanned} relevant text/metadata files, ${uniqueRepos.length} local Git repositories, build/artifact paths, and package/cache paths.\n- No exact custom production source body, canonical standard-json/build-info, target runtime/creation bytes, CBOR/IPFS snapshot, or exact compiler binary was found.\n- Step 4 exact-build/runtime proof for four staker/receiver rows is retained, not reproduced or downgraded. Explorer-runtime/ABI evidence remains qualified for OFT/proxy rows.\n- Generic UUPS/dependency sources and the exact Cash interface are insufficient for production equivalence. Destination beHYPE adapter implementation identity remains missing.\n- No compile was attempted because exact inputs were absent. No model/pipeline/gate promotion and no network/RPC/inventory/fork/live activity occurred.\n- Next: ${nextGate}\n`);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, STEP1, STEP4, STEP4_MANIFEST, CASH_INTERFACE, CASH_MODULE].map(hashFile);
  const aggregateSha256 = sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
  const manifest = { schemaVersion: 1, revision: REVISION, runId, generatedAt, algorithm: "sha256", classification, pipeline: "0/5", routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, offlineOnly: true, exhaustiveWorkspaceTraversal: true, localGitObjectSearch: true, secretFilesRead: false, exactCustomSourceFound: false, exactStandardJsonFound: false, targetRuntimeOrCreationBytesFound: false, deterministicCompilationAttempted: false, currentRunRuntimeEquivalenceEstablished: false, modelCandidateUpgraded: false, componentCount: matrix.length, searchCounters: counters, records, aggregateSha256 };
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ runId, revision: REVISION, classification, pipeline: "0/5", componentMatrix: matrix, searchCounts: result.summaryCounts, searchCounters: counters, exactSourceReadiness: result.exactSourceReadiness, compileAttempts, gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, manifestAggregateSha256: aggregateSha256, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF], nextGate }) + "\n");
}

try { main(); } catch (e) { process.stderr.write(`scan failed: ${String(e?.message || e).replace(/https?:\/\/\S+/gi, "[redacted]")}\n`); process.exitCode = 1; }
