#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
const MANIFEST_REL = "reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2-manifest.json";
const CHAINS = ["mainnet", "optimism", "xdc", "bnb", "sonic", "okx", "injective", "megaeth", "mantle", "base", "arbitrum_one", "avalanche", "ink"];
const PACKAGE_FILES = [
  "reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2.json",
  "reports/critical-silo-v3-public-allocator-deployment-economics-step2.md",
  "coordination/inbox/critical/20260729-critical-silo-v3-public-allocator-step2.json",
  "coordination/handoffs/20260729-critical-silo-v3-public-allocator-step2-handoff.md",
  "tools/run-critical-silo-v3-public-allocator-step2.js",
  "tools/test-critical-silo-v3-public-allocator-step2.js",
  "tools/validate-critical-silo-v3-public-allocator-step2.js",
  "tools/generate-critical-silo-v3-public-allocator-step2-manifest.js",
  "tools/correct-critical-silo-v3-public-allocator-step2-oracle-r2.js",
  "reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2-retained-r1.json",
  "reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2-manifest-retained-r1.json"
];
const MATERIAL_INPUTS = [
  ...CHAINS.flatMap(chain => [`targets/silo-contracts-v2/silo-vaults/deployments/${chain}/PublicAllocator.sol.json`, `targets/silo-contracts-v2/silo-vaults/deployments/${chain}/SiloVaultsFactory.sol.json`]),
  "targets/silo-contracts-v2/silo-vaults/broadcast/MainnetDeploy.s.sol/1/run-latest.json",
  "targets/silo-contracts-v2/silo-vaults/broadcast/MainnetDeploy.s.sol/56/run-latest.json",
  "targets/silo-contracts-v2/silo-vaults/broadcast/MainnetDeploy.s.sol/8453/run-latest.json",
  "targets/silo-contracts-v2/silo-vaults/broadcast/MainnetDeploy.s.sol/42161/run-latest.json",
  "targets/silo-contracts-v2/silo-vaults/contracts/PublicAllocator.sol",
  "targets/silo-contracts-v2/silo-vaults/contracts/SiloVault.sol",
  "targets/silo-contracts-v2/silo-vaults/contracts/SiloVaultsFactory.sol",
  "targets/silo-contracts-v2/silo-vaults/contracts/interfaces/IPublicAllocator.sol",
  "targets/silo-contracts-v2/silo-vaults/contracts/interfaces/ISiloVault.sol",
  "targets/silo-contracts-v2/silo-vaults/contracts/libraries/EventsLib.sol",
  "targets/silo-contracts-v2/silo-vaults/contracts/libraries/PendingLib.sol",
  "targets/silo-contracts-v2/silo-vaults/contracts/libraries/SiloVaultActionsLib.sol",
  "targets/silo-contracts-v2/foundry.toml",
  "targets/silo-contracts-v2/package.json",
  "targets/silo-contracts-v2/yarn.lock",
  "targets/silo-contracts-v2/silo-vaults/package.json",
  "targets/silo-contracts-v2/.git/HEAD",
  "targets/silo-contracts-v2/.git/refs/heads/develop",
  "tools/package.json",
  "tools/package-lock.json",
  "tools/node_modules/ethers/package.json",
  "tools/node_modules/ethers/lib.commonjs/index.js"
];
const FILES = [...PACKAGE_FILES, ...MATERIAL_INPUTS];
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`; return JSON.stringify(value); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel)); }
function generate() {
  const raw = JSON.parse(read(PACKAGE_FILES[0])), files = FILES.map((rel, index) => ({ path: rel, role: index < PACKAGE_FILES.length ? "package" : "material-input", bytes: read(rel).length, sha256: sha(read(rel)) }));
  const manifest = { schemaVersion: 2, findingId: raw.findingId, runId: raw.runId, classification: raw.classification, generatedAt: raw.generatedAt, generator: "tools/generate-critical-silo-v3-public-allocator-step2-manifest.js", validatorMode: "check-only", deterministicAggregate: true, runtimeContext: raw.materialContext, targetCommit: raw.materialContext.targetCommit, packageFileCount: PACKAGE_FILES.length, materialInputCount: MATERIAL_INPUTS.length, files };
  manifest.aggregateSha256 = sha(canonical(files.map(x => ({ path: x.path, role: x.role, bytes: x.bytes, sha256: x.sha256 }))));
  fs.writeFileSync(path.join(ROOT, MANIFEST_REL), `${JSON.stringify(manifest, null, 2)}\n`); return manifest;
}
if (require.main === module) { const manifest = generate(); process.stdout.write(`${JSON.stringify({ status: "GENERATED", files: manifest.files.length, materialInputs: manifest.materialInputCount, aggregateSha256: manifest.aggregateSha256 })}\n`); }
module.exports = { ROOT, MANIFEST_REL, PACKAGE_FILES, MATERIAL_INPUTS, FILES, sha, canonical, generate };
