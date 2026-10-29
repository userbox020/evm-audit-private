#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const target = path.join(root, "targets", "arrakis-v2-core-v1.2.0");
const rel = (file) => path.join(root, ...file.split("/"));
const read = (file) => fs.readFileSync(rel(file));
const text = (file) => read(file).toString("utf8");
const json = (file) => JSON.parse(text(file));
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const prefix = "reports/raw/fast/critical-arrakis-v2-mint-burn-step1";
const manifestPath = `${prefix}-manifest.json`;
const capturePath = "tools/capture-critical-arrakis-v2-mint-burn-step1.js";
const validatorPath = "tools/validate-critical-arrakis-v2-mint-burn-step1.js";
const reportPath = "reports/critical-arrakis-v2-mint-burn-step1.md";
const resultPath = `${prefix}.json`;
const inboxPath =
  "coordination/inbox/critical/20260731-critical-arrakis-v2-mint-burn-step1.json";
const handoffPath =
  "coordination/handoffs/20260731-critical-arrakis-v2-mint-burn-step1-handoff.md";

const artifactPaths = [
  "targets/arrakis-v2-core-v1.2.0/contracts/ArrakisV2.sol",
  "targets/arrakis-v2-core-v1.2.0/contracts/abstract/ArrakisV2Storage.sol",
  "targets/arrakis-v2-core-v1.2.0/contracts/libraries/Underlying.sol",
  "targets/arrakis-v2-core-v1.2.0/audit/arrakis-v2-core-and-palm-statemind-audit.pdf",
  "targets/arrakis-v2-core-v1.2.0/contracts/__mocks__/audit_arrakis_step1/ZeroLiquidityFactoryPoolMock.sol",
  "targets/arrakis-v2-core-v1.2.0/test/audit_arrakis_step1/ArrakisV2MintBurnStep1.test.ts",
  "targets/arrakis-v2-core-v1.2.0/hardhat.arrakis-step1.config.ts",
  capturePath,
  validatorPath,
  reportPath,
  resultPath,
  `${prefix}-focused.stdout.txt`,
  `${prefix}-build.stdout.txt`,
  `${prefix}-audit-excerpt.txt`,
];

if (process.argv[2] === "--write-manifest" && process.argv.length === 3) {
  const output = cp.execFileSync(process.execPath, [rel(capturePath)], {
    cwd: root,
    encoding: "utf8",
  });
  const manifest = JSON.parse(output);
  fs.writeFileSync(rel(manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `WROTE ${manifest.artifactCount} artifacts; aggregate ${manifest.aggregateSha256}`
  );
  process.exit(0);
}

let checks = 0;
function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(`check ${checks} failed: ${message}`);
}
function equal(actual, expected, message) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`
  );
}

check(process.argv.length === 2, "usage: no args or --write-manifest");
const head = cp
  .execFileSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8" })
  .trim();
equal(
  head,
  "77225a1ad4a1bd8bbd5cd2352d2f134309a246a5",
  "exact target commit"
);
cp.execFileSync(
  "git",
  [
    "diff",
    "--exit-code",
    "--",
    "contracts/ArrakisV2.sol",
    "contracts/abstract/ArrakisV2Storage.sol",
    "contracts/libraries/Underlying.sol",
    "test/integration_tests/Rounding.test.ts",
    "test/unit_tests/ArrakisV2.test.ts",
  ],
  { cwd: target, stdio: "ignore" }
);
check(true, "production source and upstream tests unchanged");

const result = json(resultPath);
equal(result.revision, "R2", "result revision");
equal(
  result.classification,
  "KNOWN-ACKNOWLEDGED-INFORMATIONAL/NO-NEW-FINDING/CONDITIONAL-LOW-INTERNAL-RISK-CEILING-ONLY/DEPLOYMENT-UNVERIFIED",
  "final classification"
);
equal(
  [
    result.knownBehavior.newFinding,
    result.knownBehavior.noveltyClaimed,
    result.knownBehavior.severity,
    result.knownBehavior.status,
    result.knownBehavior.internalRiskCeiling,
    result.knownBehavior.internalRiskCeilingIsReportSeverity,
  ],
  [false, false, "informational", "acknowledged", "Conditional Low", false],
  "known acknowledged informational taxonomy"
);
equal(
  [
    result.knownBehavior.auditFinding,
    result.knownBehavior.auditPdfPage,
    result.knownBehavior.auditReportPage,
  ],
  ["Direct token transfers — Acknowledged", 14, 12],
  "exact in-repo audit finding"
);
equal(
  [
    result.knownBehavior.fixture.preSent0,
    result.knownBehavior.fixture.preSent1,
    result.knownBehavior.fixture.attackerNet0,
    result.knownBehavior.fixture.attackerNet1,
  ],
  ["77", "93", "+77", "+93"],
  "retained exact fixture"
);
equal(
  [
    result.gates.sourcePrimitive,
    result.gates.localRoutePositive,
    result.gates.routePositive,
    result.gates.executableNow,
    result.gates.signedActionJustified,
    result.gates.fork,
  ],
  [1, 1, 0, 0, false, false],
  "source/gross and operational gates"
);
equal(
  [
    result.evidence.focusedTests.tests,
    result.evidence.focusedTests.passed,
    result.evidence.focusedTests.fixedSeedCases,
  ],
  [9, 9, 64],
  "retained focused counts"
);
check(
  result.evidence.focusedTests.status ===
    "retained-not-rerun-r2-classification-only",
  "R2 test non-rerun disclosed"
);
equal(
  [
    result.evidence.packageValidator.checks,
    result.evidence.packageValidator.passed,
    result.evidence.packageValidator.manifestHash,
    result.evidence.packageValidator.leak,
    result.evidence.packageValidator.json,
    result.evidence.packageValidator.whitespace,
  ],
  [130, 130, "pass", "pass", "pass", "pass"],
  "validator pass retained"
);
equal(
  [result.scope.localNoForkOnly, result.scope.productionOrUpstreamModified],
  [true, false],
  "offline unchanged scope"
);

const report = text(reportPath);
for (const required of [
  "KNOWN/ACKNOWLEDGED/INFORMATIONAL",
  "NO NEW FINDING",
  "CONDITIONAL LOW INTERNAL RISK CEILING ONLY",
  "Direct token transfers — Acknowledged",
  "PDF page 14 (report page 12)",
  "not a novelty claim",
  "distinct from the fixed first-mint ratio skew",
  "`+77/+93`",
  "`routePositive=0`",
  "`executableNow=0`",
  "`signedActionJustified=false`",
  "`fork=false`",
]) {
  check(report.includes(required), `report includes ${required}`);
}
check(!report.includes("🟠 WATCH"), "prior WATCH label removed");

const excerpt = text(`${prefix}-audit-excerpt.txt`);
const excerptNormalized = excerpt.replace(/\s+/gu, " ");
for (const required of [
  "Direct token transfers Acknowledged",
  "total supply is zero",
  "mint is not restricted",
  "avoid direct transfers to ArrakisV2 vault",
  "No network, RPC, or fork was used",
]) {
  check(
    excerptNormalized.includes(required),
    `audit excerpt includes ${required}`
  );
}

const focused = text(`${prefix}-focused.stdout.txt`);
check(focused.includes("9 passing"), "focused 9/9 retained");
check(focused.includes("64 fixed-seed cases"), "focused 64 cases retained");
const build = text(`${prefix}-build.stdout.txt`);
check(build.includes("Compiled 75 Solidity files successfully"), "build 75 retained");
check(build.includes("Network/fork: none"), "build no fork");

const inbox = json(inboxPath);
equal(inbox.classification, result.classification, "inbox classification");
equal(
  [
    inbox.newFinding,
    inbox.noveltyClaimed,
    inbox.internalRiskCeiling,
    inbox.internalRiskCeilingIsReportSeverity,
    inbox.routePositive,
    inbox.executableNow,
    inbox.signedActionJustified,
    inbox.fork,
  ],
  [false, false, "Conditional Low", false, 0, 0, false, false],
  "inbox classification and gates"
);
const handoff = text(handoffPath);
for (const required of [
  "Known/Acknowledged/Informational / No New Finding",
  "Conditional Low` is only an internal risk ceiling",
  "Direct token transfers — Acknowledged",
  "`0/0/false/false`",
]) {
  check(handoff.includes(required), `handoff includes ${required}`);
}

const packageTextPaths = [
  "targets/arrakis-v2-core-v1.2.0/contracts/__mocks__/audit_arrakis_step1/ZeroLiquidityFactoryPoolMock.sol",
  "targets/arrakis-v2-core-v1.2.0/test/audit_arrakis_step1/ArrakisV2MintBurnStep1.test.ts",
  "targets/arrakis-v2-core-v1.2.0/hardhat.arrakis-step1.config.ts",
  capturePath,
  validatorPath,
  reportPath,
  resultPath,
  `${prefix}-focused.stdout.txt`,
  `${prefix}-build.stdout.txt`,
  `${prefix}-audit-excerpt.txt`,
  inboxPath,
  handoffPath,
  manifestPath,
];
for (const file of packageTextPaths) {
  const content = text(file);
  check(!/[ \t]+$/gmu.test(content), `${file} has no trailing whitespace`);
  check(!content.includes("\r"), `${file} uses LF line endings`);
  check(!content.includes("\t"), `${file} contains no tab characters`);
  if (file !== validatorPath) {
    check(
      !/(https?:\/\/|BEGIN [A-Z ]*PRIVATE KEY|seed phrase|mnemonic\s*[:=]|rpc_endpoints\.txt|graphql_endpoints\.txt)/iu.test(
        content
      ),
      `${file} leak scan`
    );
  }
}
check(true, "package whitespace and leak scan complete");

for (const file of [resultPath, inboxPath, manifestPath]) {
  check(Boolean(json(file)), `${file} parses as JSON`);
}

const manifest = json(manifestPath);
equal(manifest.revision, "R2", "manifest revision");
equal(manifest.artifactCount, artifactPaths.length, "manifest artifact count");
equal(
  manifest.artifacts.map(({ path: artifactPath }) => artifactPath),
  artifactPaths,
  "manifest artifact paths and order"
);
for (const artifact of manifest.artifacts) {
  const bytes = read(artifact.path);
  equal(bytes.length, artifact.bytes, `${artifact.path} bytes`);
  equal(sha256(bytes), artifact.sha256, `${artifact.path} hash`);
}
const aggregateSha256 = sha256(
  Buffer.from(
    manifest.artifacts
      .map(({ path: artifactPath, sha256: hash }) => `${artifactPath}:${hash}`)
      .sort()
      .join("\n"),
    "utf8"
  )
);
equal(aggregateSha256, manifest.aggregateSha256, "manifest aggregate");
equal(inbox.aggregateSha256, aggregateSha256, "inbox aggregate");
check(handoff.includes(aggregateSha256), "handoff aggregate");

console.log(`PASS ${checks}/${checks} checks`);
console.log(`aggregateSha256 ${aggregateSha256}`);
console.log(`manifestSha256 ${sha256(read(manifestPath))}`);
console.log("leakCheck PASS");
console.log("jsonCheck PASS");
console.log("whitespaceCheck PASS");
console.log("network/rpc/fork 0/0/false");
