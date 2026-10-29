#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "synapse-contracts");
const MANIFEST = "reports/raw/fast/synapse-cctp-step8.manifest.json";
const SHARED_RPC = "tools/shared-rpc.js";
const TOOLS = [
  "tools/scan-synapse-cctp-step8.js",
  "tools/rank-synapse-cctp-step8-activity.js",
  "tools/prove-synapse-cctp-step8-fork.js",
  "tools/final-check-synapse-cctp-step8.js",
  "tools/manifest-synapse-cctp-step8.js",
];
const GENERATED = [
  "reports/raw/fast/synapse-cctp-step8.json",
  "reports/raw/fast/synapse-cctp-step8.public-calldata.json",
  "reports/raw/fast/synapse-cctp-step8.fork.json",
  "reports/raw/fast/synapse-cctp-step8.final-check.json",
  "reports/raw/fast/synapse-cctp-step8.activity-ranking.json",
  "reports/synapse-cctp-step8.md",
  "reports/synapse-cctp-step8-definitions.md",
  "reports/synapse-cctp-step8-sources.md",
];
const COMPILER_ARTIFACTS = [
  "targets/synapse-contracts/artifacts/SynapseCCTP.sol/SynapseCCTP.json",
  "targets/synapse-contracts/artifacts/SynapseCCTPRouter.sol/SynapseCCTPRouter.json",
];
const DEPLOYMENT_INPUTS = ["mainnet", "arbitrum"].flatMap(chain => [
  `targets/synapse-contracts/deployments/${chain}/SynapseCCTP.json`,
  `targets/synapse-contracts/deployments/${chain}/SynapseCCTP.Implementation.json`,
  `targets/synapse-contracts/deployments/${chain}/TransparentUpgradeableProxy.SynapseCCTP.json`,
  `targets/synapse-contracts/deployments/${chain}/ProxyAdmin.SynapseCCTP.json`,
  `targets/synapse-contracts/deployments/${chain}/SynapseCCTPRouter.json`,
  `targets/synapse-contracts/script/configs/${chain}/SynapseCCTP.dc.json`,
]);
const OTHER_INPUTS = [
  "targets/synapse-contracts/foundry.toml",
  "targets/synapse-contracts/script/configs/SynapseCCTP.chains.json",
  "targets/synapse-sanguine/docs/bridge/docs/05-Routers/CCTP/index.md",
  "targets/synapse-sanguine/services/cctp-relayer/relayer/synapse.go",
  "targets/synapse-contracts/test/cctp/SynapseCCTP.t.sol",
];

function hash(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function artifactSources() {
  const sources = new Set();
  for (const rel of COMPILER_ARTIFACTS) {
    const art = JSON.parse(fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8"));
    for (const source of Object.keys(art.metadata.sources)) {
      const normalized = source.startsWith("@") ? `targets/synapse-contracts/node_modules/${source}` : `targets/synapse-contracts/${source}`;
      if (!fs.existsSync(path.join(ROOT, ...normalized.split("/")))) throw new Error(`missing compiler source input: ${normalized}`);
      sources.add(normalized);
    }
  }
  return [...sources].sort();
}
function syntaxResult(file) {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, ...file.split("/"))], { encoding: "utf8", windowsHide: true });
  return { file, passed: r.status === 0 };
}
function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, GENERATED[0]), "utf8"));
  const fork = JSON.parse(fs.readFileSync(path.join(ROOT, GENERATED[2]), "utf8"));
  const finalCheck = JSON.parse(fs.readFileSync(path.join(ROOT, GENERATED[3]), "utf8"));
  const sourceInputs = artifactSources();
  const files = [...new Set([...TOOLS, SHARED_RPC, ...GENERATED, ...COMPILER_ARTIFACTS, ...DEPLOYMENT_INPUTS, ...OTHER_INPUTS, ...sourceInputs])];
  const entries = [];
  const leakHits = [];
  for (const rel of files) {
    const abs = path.join(ROOT, ...rel.split("/"));
    const buf = fs.readFileSync(abs);
    const hashOnlyRedactedDependency = rel === SHARED_RPC;
    entries.push({ path: rel, bytes: buf.length, sha256: hash(buf), hashOnlyRedactedDependency });
    if (hashOnlyRedactedDependency) continue;
    const text = buf.toString("utf8");
    const isGeneratedStageFile = rel.startsWith("tools/") || rel.startsWith("reports/");
    const urls = isGeneratedStageFile ? (text.match(/https?:\/\/(?!127\.0\.0\.1)[^\s"'<>]+/gi) || []) : [];
    const secretMarkers = text.match(/(?:api[_-]?key|private[_-]?key|seed phrase|mnemonic)\s*[:=]\s*["'][^"']+["']/gi) || [];
    if (urls.length || secretMarkers.length) leakHits.push({ path: rel, externalUrlCount: urls.length, secretAssignmentCount: secretMarkers.length });
  }
  const syntax = TOOLS.map(syntaxResult);
  const adminEvidence = raw.chains.map(c => {
    const f = finalCheck.checks.find(x => x.chain.chainId === c.chain.chainId);
    return { chain: c.chain.name, rawAdmin: c.bindings.proxy.admin, finalAdmin: f?.proxyAdmin || null, nonzero: !!c.bindings.proxy.admin, equal: !!f && c.bindings.proxy.admin === f.proxyAdmin && f.proxyAdminMatchesArtifact === true };
  });
  const validation = {
    toolSyntax: { passed: syntax.every(x => x.passed), results: syntax },
    finalCheckPass: finalCheck.pass === true,
    deterministicFixedHeads: raw.deterministicHeads?.enabled === true && raw.deterministicHeads?.allSelectedChainsExplicitlyPinned === true && finalCheck.checks.every(x => x.fixedHeadExplicitlyRequested),
    rawProxyAdminsNonzeroAndEqualFinal: adminEvidence.every(x => x.nonzero && x.equal),
    proxyAdminEvidence: adminEvidence,
    deterministicForkReplay: fork.determinism?.match === true,
    selectedForkPass: finalCheck.validation?.forkChecksPass === true,
    offlineAllRecordLedgerChecks: finalCheck.validation?.offlineAllRecordLedgerChecksPass === true,
    sourceRuntimeNormalization: finalCheck.validation?.sourceRuntimeNormalizationPass === true,
    corpusDeduplicationAndMinimization: finalCheck.validation?.corpusMinimizationChecksPass === true,
    noPendingOrUnconsumedAttestationsRetained: finalCheck.corpusChecks?.pendingOrUnconsumedAttestationsRetained === 0,
    preWithdrawalEconomicsQualified: fork.economics?.classification === "pre-withdrawal-modeled-net" && fork.economics?.collectorWithdrawalGasIncluded === false && fork.economics?.netUsdc === "0.83318283",
    leakScan: { passed: leakHits.length === 0, externalUrlOrSecretAssignmentHits: leakHits },
  };
  validation.pass = Object.entries(validation).filter(([key]) => !["proxyAdminEvidence", "pass"].includes(key)).every(([, value]) => typeof value === "boolean" ? value : value.passed === true);
  const aggregateHash = hash(Buffer.from(entries.map(x => `${x.path}:${x.sha256}\n`).join("")));
  const manifest = {
    schemaVersion: 2,
    runId: raw.runId,
    revision: raw.revision,
    generatedAt: new Date().toISOString(),
    classification: "INFORMATIONAL/CLOSED; WATCH-ON-SEMANTIC-OR-ACTIVITY-CHANGE",
    selfExcluded: true,
    dependencyPolicy: { sharedRpc: "hash-only/redacted; endpoint inventory and endpoint material are not included" },
    inputGroups: { tools: TOOLS.length, generatedArtifacts: GENERATED.length, exactCompilerArtifacts: COMPILER_ARTIFACTS.length, deploymentAndChainConfigInputs: DEPLOYMENT_INPUTS.length, otherInputs: OTHER_INPUTS.length, transitiveCompilerSources: sourceInputs.length },
    files: entries,
    aggregateHash,
    validation,
    safety: { endpointMaterialPersisted: false, privateKeysUsed: false, signedActions: false, broadcasts: false, liveFundMovement: false },
  };
  if (!validation.pass) throw new Error(`manifest validation failed: ${JSON.stringify(validation)}`);
  fs.writeFileSync(path.join(ROOT, ...MANIFEST.split("/")), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ runId: raw.runId, revision: raw.revision, aggregateHash, files: entries.length, inputGroups: manifest.inputGroups, validationPass: validation.pass, leakScanPassed: validation.leakScan.passed }, null, 2));
}
main();
