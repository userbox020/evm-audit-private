#!/usr/bin/env node
"use strict";

const child = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const target = path.join(root, "targets", "ostium");
const parent = path.join(root, "reports", "raw", "fast");
const name = "ostium-settlement-boundary-conservation-r1";
const finalDir = path.join(parent, name);
const stageName = `.${name}.staging`;
const stageDir = path.join(parent, stageName);
const exactLongVersion = "0.8.24+commit.e11b9ed9";
const hardhatCli = path.join(target, "node_modules", "hardhat", "internal", "cli", "cli.js");
const validator = path.join(root, "tools", "validate-ostium-settlement-boundary-conservation-r1.py");
const flags = {
  classification: "LOCAL_SOURCE_BEHAVIOR_CONFIRMED",
  runtimeAssertion: false,
  deploymentAssertion: false,
  currentStateAssertion: false,
  economicsAssertion: false,
  routePositive: null,
  fork: false,
};
const caseIds = [
  "A_DEADLINE_MINUS_1", "A_DEADLINE_EXACT", "A_DEADLINE_PLUS_1",
  "B_OPEN_PNL_ZERO_DELTA", "B_OPEN_PNL_POSITIVE_BELOW_CAP", "B_OPEN_PNL_EXACT_CONFIGURED_CAP",
  "B_OPEN_PNL_ONE_ABOVE_CONFIGURED_CAP", "B_OPEN_PNL_VAULT_VALUE_CAP", "B_OPEN_PNL_EQUAL_CAPS",
  "B_OPEN_PNL_LARGE_NEGATIVE_NONDIVISIBLE", "B_OPEN_PNL_ZERO_SUPPLY_POSITIVE", "B_OPEN_PNL_ZERO_SUPPLY_NEGATIVE",
  "C_MIXED_WITHDRAWAL_FIRST_PINNED_PRICE", "C_FULL_WITHDRAWAL_REJECT_RECLAIM",
  "C_DEPOSIT_BLOCKED_RECLAIM", "C_CAPPED_MULTI_USER_PRORATA_DUST",
  "D_MM_POSITIVE_BEFORE_REFRESH", "D_MM_NEGATIVE_AFTER_REFRESH_FLOOR", "D_MM_NON_MM_REJECTION",
  "D_MM_OVER_BUFFER_ROLLBACK", "D_MM_INSUFFICIENT_BALANCE_ROLLBACK", "E_NONZERO_THRESHOLD_DERIVATIONS",
];

function fail(message, code = 1) {
  process.stderr.write(`FAIL CLOSED: ${message}\n`);
  process.exit(code);
}
function shaFile(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function shaText(text) { return crypto.createHash("sha256").update(text).digest("hex"); }
function rel(file) { return path.relative(root, file).split(path.sep).join("/"); }
function json(file, value, flag = "wx") { fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag }); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function bind(file) { return { path: rel(file), sha256: shaFile(file) }; }
function git(args) {
  const run = child.spawnSync("git", args, { cwd: target, encoding: "utf8", windowsHide: true });
  if (run.status !== 0) fail(`git ${args.join(" ")} failed`);
  return (run.stdout || "").trim();
}
function run(executable, args, options = {}) {
  return child.spawnSync(executable, args, {
    cwd: options.cwd || target,
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    shell: false,
  });
}
function commandResult(runResult, command) {
  const stdout = runResult.stdout || "";
  const stderr = runResult.stderr || "";
  return {
    command,
    exitCode: runResult.status,
    signal: runResult.signal,
    stdoutBytes: Buffer.byteLength(stdout), stdoutSha256: shaText(stdout),
    stderrBytes: Buffer.byteLength(stderr), stderrSha256: shaText(stderr),
  };
}

if (!fs.existsSync(parent)) fail("publication parent is missing");
if (fs.existsSync(finalDir)) fail("final directory already exists; no overwrite permitted", 2);
if (fs.existsSync(stageDir)) fail("exclusive staging directory already exists", 2);
const stagingSiblings = fs.readdirSync(parent).filter((x) => x.startsWith(`.${name}.staging`));
if (stagingSiblings.length !== 0) fail("another sibling staging directory exists", 2);

const productionDiff = git(["diff", "--", "src/OstiumVault.sol", "src/OstiumRegistry.sol", "src/interfaces/IOstiumVault.sol", "src/interfaces/IOstiumRegistry.sol"]);
if (productionDiff !== "") fail("tracked production diff is not empty");

const cacheRoot = path.join(process.env.LOCALAPPDATA || "", "hardhat-nodejs", "Cache", "compilers-v2", "windows-amd64");
const listPath = path.join(cacheRoot, "list.json");
if (!fs.existsSync(listPath)) fail("Hardhat native compiler cache list is absent");
const compilerList = readJson(listPath);
const compilerBuild = compilerList.builds.find((x) => x.version === "0.8.24" && x.longVersion === exactLongVersion);
if (!compilerBuild) fail(`cached compiler ${exactLongVersion} is absent from list.json`);
const compilerPath = path.join(cacheRoot, compilerBuild.path);
if (!fs.existsSync(compilerPath)) fail(`cached compiler executable ${exactLongVersion} is absent`);
const versionRun = run(compilerPath, ["--version"], { cwd: target });
if (versionRun.status !== 0 || !(versionRun.stdout || "").includes(exactLongVersion)) fail("cached compiler executable identity mismatch");

fs.mkdirSync(stageDir, { recursive: false });
const deniedEnv = {
  ...process.env,
  HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9",
  http_proxy: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", all_proxy: "http://127.0.0.1:9",
  NO_PROXY: "", no_proxy: "",
};
const compileRun = run(process.execPath, [hardhatCli, "compile", "--force"], { cwd: target, env: deniedEnv });
if (compileRun.status !== 0) fail("offline-denied Hardhat compile failed; no package published");

const artifactPath = path.join(target, "artifacts", "src", "OstiumVault.sol", "OstiumVault.json");
const dbgPath = path.join(target, "artifacts", "src", "OstiumVault.sol", "OstiumVault.dbg.json");
if (!fs.existsSync(artifactPath) || !fs.existsSync(dbgPath)) fail("OstiumVault artifact/debug provenance missing");
const dbg = readJson(dbgPath);
const buildInfoPath = path.resolve(path.dirname(dbgPath), dbg.buildInfo);
const buildInfo = readJson(buildInfoPath);
if (buildInfo.solcLongVersion !== exactLongVersion || buildInfo.solcVersion !== "0.8.24") fail("build-info compiler is not exact 0.8.24+commit.e11b9ed9");
const artifact = readJson(artifactPath);
if (artifact.sourceName !== "src/OstiumVault.sol" || artifact.contractName !== "OstiumVault") fail("unexpected OstiumVault artifact identity");

const testRun = run(process.execPath, [hardhatCli, "test", "--no-compile", "test/audit/OstiumSettlementBoundaryR1.test.js"], { cwd: target, env: deniedEnv });
if (testRun.status !== 0) fail("bounded Hardhat R1 test failed; staging retained for diagnosis");
const plainOutput = `${testRun.stdout || ""}${testRun.stderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
const passing = Number((plainOutput.match(/([0-9]+) passing/) || [0, 0])[1]);
const failing = Number((plainOutput.match(/([0-9]+) failing/) || [0, 0])[1]);
if (passing !== 4 || failing !== 0) fail(`unexpected bounded test count: passing=${passing}, failing=${failing}`);
const observationsPath = path.join(stageDir, "observations.json");
if (!fs.existsSync(observationsPath)) fail("test did not create fixed-path observations");
const observations = readJson(observationsPath);
if (observations.caseCount !== caseIds.length || observations.cases.map((x) => x.caseId).join("\0") !== caseIds.join("\0")) fail("test observation case matrix mismatch");

const closure = {};
for (const [sourceName, source] of Object.entries(buildInfo.input.sources)) closure[sourceName] = shaText(source.content);
const overlayFiles = [
  path.join(target, "src", "test", "audit", "OstiumSettlementBoundaryR1Mocks.sol"),
  path.join(target, "test", "audit", "ostium-settlement-boundary-r1-oracle.js"),
  path.join(target, "test", "audit", "OstiumSettlementBoundaryR1.test.js"),
  path.join(root, "tools", "run-ostium-settlement-boundary-conservation-r1.js"),
  validator,
];
const inputFiles = [
  path.join(target, "src", "OstiumVault.sol"),
  path.join(target, "src", "interfaces", "IOstiumVault.sol"),
  path.join(target, "src", "OstiumRegistry.sol"),
  path.join(target, "src", "interfaces", "IOstiumRegistry.sol"),
  path.join(target, "src", "test", "audit", "OstiumStaleMarkSettlementStep1Harness.sol"),
  path.join(target, "hardhat.config.ts"), path.join(target, "package.json"), path.join(target, "package-lock.json"),
];
for (const file of [...overlayFiles, ...inputFiles]) if (!fs.existsSync(file)) fail(`bound input missing: ${rel(file)}`);

const model = {
  schema: "ostium-settlement-boundary-conservation-r1-model/v1",
  ...flags,
  scope: "OFFLINE_LOCAL_EPHEMERAL_HARDHAT_SOURCE_BEHAVIOR_ONLY",
  caseCount: caseIds.length,
  caseIds,
  arithmetic: {
    signedGeneralDivision: "TRUNCATE_TOWARD_ZERO",
    mmNegativeCashflowDivision: "FLOOR_TOWARD_NEGATIVE_INFINITY",
    unsignedDivision: "FLOOR",
    assetDecimals: "6", shareDecimals: "6", pnlDecimals: "18", perShareDecimals: "18",
    positiveOpenPnlCapOnly: true, zeroSupplyAsymmetryCovered: true, perUserAllocationFloorsAndDustCovered: true,
  },
  repository: {
    path: "targets/ostium", commit: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]),
    trackedProductionDiff: "EMPTY", trackedProductionDiffSha256: shaText(productionDiff),
  },
  compiler: {
    module: "hardhat/native-solc", version: "0.8.24", longVersion: exactLongVersion,
    platform: "windows-amd64", executable: compilerBuild.path, executableSha256: shaFile(compilerPath),
    downloadAllowed: false, networkDenialGuard: "loopback-port-9-proxy-for-uppercase-and-lowercase-http-https-all-proxy",
  },
  build: {
    fqn: "src/OstiumVault.sol:OstiumVault", buildInfoPath: rel(buildInfoPath), buildInfoSha256: shaFile(buildInfoPath),
    artifactPath: rel(artifactPath), artifactSha256: shaFile(artifactPath),
    artifactRuntimeBytecodeSha256: shaText(artifact.deployedBytecode), compilerSettings: buildInfo.input.settings,
    sourceClosure: Object.fromEntries(Object.entries(closure).sort(([a], [b]) => a.localeCompare(b))),
    astTripwires: [
      { nodeType: "ContractDefinition", name: "OstiumVault" },
      { nodeType: "FunctionDefinition", name: "tryNewSettlement" },
      { nodeType: "FunctionDefinition", name: "_getOpenPnlDelta" },
      { nodeType: "FunctionDefinition", name: "_executeAsyncDepositWithdraw" },
      { nodeType: "FunctionDefinition", name: "_applyMMCashflow" },
      { nodeType: "FunctionDefinition", name: "mmDeposit" },
      { nodeType: "FunctionDefinition", name: "mmWithdraw" },
    ],
  },
  systemUnderTest: {
    vault: "UNCHANGED_PRODUCTION_OSTIUM_VAULT", transport: "AUDIT_ERC1967_PROXY",
    registry: "PRODUCTION_OSTIUM_REGISTRY", asset: "EXISTING_AUDIT_USDC",
    openPnl: "R1_FIXTURE_ONLY_REFERENCE_SETUP_RESTRICTED_DIRECT_INT256_VALUE",
    marketMakerAccess: "SIGNER_AND_PRODUCTION_APIS",
  },
  inputBindings: inputFiles.map(bind),
  overlays: overlayFiles.map(bind),
  historicalContext: [],
  assertionBoundary: "No deployed-source, deployment, current-state, route, economics, or runtime assertion is made.",
};
json(path.join(stageDir, "model.json"), model);

const testResult = {
  schema: "ostium-settlement-boundary-conservation-r1-test-result/v1",
  ...flags,
  compile: commandResult(compileRun, "hardhat compile --force (network denied)"),
  test: { ...commandResult(testRun, "hardhat test --no-compile test/audit/OstiumSettlementBoundaryR1.test.js"), passing, failing },
  caseCount: caseIds.length,
  observationsSha256: shaFile(observationsPath),
};
json(path.join(stageDir, "test-result.json"), testResult);

const manifest = {
  schema: "ostium-settlement-boundary-conservation-r1-manifest/v1",
  ...flags,
  packageDirectory: name,
  authoritativeFileSha256: {
    "model.json": shaFile(path.join(stageDir, "model.json")),
    "observations.json": shaFile(observationsPath),
    "test-result.json": shaFile(path.join(stageDir, "test-result.json")),
  },
};
json(path.join(stageDir, "manifest.json"), manifest);

const validateStage = run("python", [validator, stageDir], { cwd: root, env: deniedEnv });
if (validateStage.status !== 0) {
  process.stderr.write(validateStage.stdout || ""); process.stderr.write(validateStage.stderr || "");
  fail("check-only staged validation failed; staging retained");
}
fs.renameSync(stageDir, finalDir);
const validateFinal = run("python", [validator, finalDir], { cwd: root, env: deniedEnv });
if (validateFinal.status !== 0) {
  process.stderr.write(validateFinal.stdout || ""); process.stderr.write(validateFinal.stderr || "");
  fail("check-only final validation failed after atomic publish");
}

const beforeProbe = Object.fromEntries(fs.readdirSync(finalDir).sort().map((x) => [x, shaFile(path.join(finalDir, x))]));
const rerun = run(process.execPath, [__filename], { cwd: root, env: deniedEnv });
if (rerun.status !== 2 || !(rerun.stderr || "").includes("final directory already exists")) fail("no-overwrite rerun assertion did not fail closed");
const afterProbe = Object.fromEntries(fs.readdirSync(finalDir).sort().map((x) => [x, shaFile(path.join(finalDir, x))]));
if (JSON.stringify(beforeProbe) !== JSON.stringify(afterProbe)) fail("no-overwrite probe changed final artifacts");

process.stdout.write(JSON.stringify({
  status: "PASS", classification: flags.classification, caseCount: caseIds.length,
  testFunctionsPassing: passing, sourceClosureCount: Object.keys(closure).length,
  inputBindingCount: inputFiles.length, overlayCount: overlayFiles.length,
  compiler: exactLongVersion, buildInfoSha256: shaFile(buildInfoPath), artifactSha256: shaFile(artifactPath),
  finalFiles: beforeProbe, stagedValidation: (validateStage.stdout || "").trim(), finalValidation: (validateFinal.stdout || "").trim(),
  noOverwriteRerunExitCode: rerun.status,
}, null, 2) + "\n");
