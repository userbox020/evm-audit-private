#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const common = require("./polygon-robin-runtime-r2-common");

const ROOT = path.resolve(__dirname, "..");
const PACKAGE_REL = `reports/raw/fast/${common.STEM}`;
const MANIFEST = path.join(ROOT, ...PACKAGE_REL.split("/"), "package-manifest.json");
const PATHS = Object.freeze([
  `${PACKAGE_REL}/authority/artifacts/AccountingLib.json`, `${PACKAGE_REL}/authority/artifacts/IndexCalcLib.json`, `${PACKAGE_REL}/authority/artifacts/PolymarketLib.json`,
  `${PACKAGE_REL}/authority/artifacts/RobinLens.json`, `${PACKAGE_REL}/authority/artifacts/RobinStakingVault.json`, `${PACKAGE_REL}/authority/artifacts/RobinStakingVaultExtension.json`,
  `${PACKAGE_REL}/authority/artifacts/RobinTwapOracle.json`, `${PACKAGE_REL}/authority/artifacts/VaultLib.json`, `${PACKAGE_REL}/authority/build-gate.json`,
  `${PACKAGE_REL}/authority/deployment-broadcast.json`, `${PACKAGE_REL}/authority/source-provenance.json`, `${PACKAGE_REL}/action-bundle-authority.json`, `${PACKAGE_REL}/native-launcher-build-authority.json`, `${PACKAGE_REL}/query-plan.json`, `${PACKAGE_REL}/runtime-model.json`, `${PACKAGE_REL}/source-authority.json`,
  `${PACKAGE_REL}/capability-fixture/payload.txt`,
  "tools/polygon-robin-runtime-r2-broker.js", "tools/polygon-robin-runtime-r2-capability.js", "tools/polygon-robin-runtime-r2-capture.js", "tools/polygon-robin-runtime-r2-collection.js",
  "tools/polygon-robin-runtime-r2-authorities.js", "tools/polygon-robin-runtime-r2-bundle.js", "tools/polygon-robin-runtime-r2-common.js", "tools/polygon-robin-runtime-r2-export.js", "tools/polygon-robin-runtime-r2-launcher.c", "tools/polygon-robin-runtime-r2-lifecycle.js", "tools/polygon-robin-runtime-r2-manifest.js", "tools/polygon-robin-runtime-r2-package.js",
  "tools/polygon-robin-runtime-r2-semantics.js",
  "tools/polygon-robin-runtime-r2-review.js", "tools/polygon-robin-runtime-r2-stage.js", "tools/polygon-robin-runtime-r2-validate.js", "tools/tests/polygon-robin-runtime-r2.test.js",
  "tools/vendor/polygon-robin-runtime-r2-actions.bundle.js", "tools/vendor/polygon-robin-runtime-r2-ethers.umd.min.js", "tools/vendor/polygon-robin-runtime-r2-launcher-linux-x64"
].sort());
function build() {
  const records = PATHS.map((relative) => { const bytes = fs.readFileSync(path.join(ROOT, ...relative.split("/"))); return { path: relative, bytes: bytes.length, sha256: common.sha256(bytes) }; });
  return { schemaVersion: "robin-runtime-r2/package-manifest-v4", claimId: common.STEM, status: "IMMUTABLE_PACKAGE_STATIC_LAUNCHER_SEALED_MEMFD_NODE_PROVISIONED", hashAlgorithm: "sha256", records,
    aggregateSha256: common.sha256(Buffer.from(common.canonical(records))), manifestSelfHashExcluded: true,
    safety: { offlinePackageCheck: true, network: false, inventoryRead: false, lifecycleMutation: false, reviewMutation: false },
    nonclaims: ["No production/native-root staging, capability preflight, review, inventory open, network, capture, validation, export, signing, broadcast, mutation, or fund movement occurred while building this manifest. One disposable ext4 temporary staging fixture was created and removed solely for offline mode-chain testing."] };
}
function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0])) common.fail("ARGUMENTS_INVALID"); const bytes = Buffer.from(`${JSON.stringify(build(), null, 2)}\n`);
  if (argv[0] === "--write") fs.writeFileSync(MANIFEST, Buffer.from(`${common.canonical(build())}\n`), { flag: "w", mode: 0o600 });
  else if (!fs.readFileSync(MANIFEST).equals(Buffer.from(`${common.canonical(build())}\n`))) common.fail("MANIFEST_STALE"); process.stdout.write("ROBIN_RUNTIME_R2_MANIFEST_PASS\n");
}
module.exports = { ROOT, PACKAGE_REL, MANIFEST, PATHS, build, main };
if (require.main === module) { try { main(); } catch (_) { process.stdout.write("ROBIN_RUNTIME_R2_MANIFEST_FAIL\n"); process.exitCode = 1; } }
