#!/usr/bin/env node
"use strict";

const child = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const target = path.join(root, "targets", "ostium");
const parent = path.join(root, "reports", "raw", "fast");
const name = "ostium-settlement-boundary-conservation-r2";
const finalDir = path.join(parent, name), stageDir = path.join(parent, `.${name}.staging`);
const validator = path.join(root, "tools", "validate-ostium-settlement-boundary-conservation-r2.py");
const r1Validator = path.join(root, "tools", "validate-ostium-settlement-boundary-conservation-r1.py");
const hardhatCli = path.join(target, "node_modules", "hardhat", "internal", "cli", "cli.js");
const LONG = "0.8.24+commit.e11b9ed9";
const IDS = [
  "A_DEADLINE_MINUS_1", "A_DEADLINE_EXACT", "A_DEADLINE_PLUS_1", "B_OPEN_PNL_ZERO_DELTA", "B_OPEN_PNL_POSITIVE_BELOW_CAP", "B_OPEN_PNL_EXACT_CONFIGURED_CAP",
  "B_OPEN_PNL_ONE_ABOVE_CONFIGURED_CAP", "B_OPEN_PNL_VAULT_VALUE_CAP", "B_OPEN_PNL_EQUAL_CAPS", "B_OPEN_PNL_LARGE_NEGATIVE_NONDIVISIBLE", "B_OPEN_PNL_ZERO_SUPPLY_POSITIVE",
  "B_OPEN_PNL_ZERO_SUPPLY_NEGATIVE", "C_MIXED_WITHDRAWAL_FIRST_PINNED_PRICE", "C_FULL_WITHDRAWAL_REJECT_RECLAIM", "C_DEPOSIT_BLOCKED_RECLAIM", "C_CAPPED_MULTI_USER_PRORATA_DUST",
  "D_MM_POSITIVE_BEFORE_REFRESH", "D_MM_NEGATIVE_AFTER_REFRESH_FLOOR", "D_MM_NON_MM_REJECTION", "D_MM_OVER_BUFFER_ROLLBACK", "D_MM_INSUFFICIENT_BALANCE_ROLLBACK", "E_NONZERO_THRESHOLD_DERIVATIONS",
];
const flags = { classification: "LOCAL_SOURCE_BEHAVIOR_CONFIRMED", runtimeAssertion: false, deploymentAssertion: false, currentStateAssertion: false, economicsAssertion: false, routePositive: null, fork: false };
const Q = (n, unit = "count") => ({ value: String(n), unit });

function fail(message, code = 1) { process.stderr.write(`FAIL CLOSED: ${message}\n`); process.exit(code); }
function shaFile(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function shaText(text) { return crypto.createHash("sha256").update(text).digest("hex"); }
function rel(file) { return path.relative(root, file).split(path.sep).join("/"); }
function bind(file) { return { path: rel(file), sha256: shaFile(file) }; }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" }); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function spawn(exe, args, cwd = target, env = process.env) { return child.spawnSync(exe, args, { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true, shell: false }); }
function git(args) { const x = spawn("git", args, target); if (x.status !== 0) fail(`git ${args.join(" ")} failed`); return (x.stdout || "").trim(); }
function commandResult(x, command, counts = {}) {
  const out = x.stdout || "", err = x.stderr || "";
  return { command, exitCode: Q(x.status), signal: x.signal, stdoutBytes: Q(Buffer.byteLength(out)), stdoutSha256: shaText(out), stderrBytes: Q(Buffer.byteLength(err)), stderrSha256: shaText(err), ...counts };
}

if ((process.env.PYTHONOPTIMIZE || "") !== "") fail("nonempty PYTHONOPTIMIZE is forbidden");
if (!fs.existsSync(parent)) fail("publication parent missing");
if (fs.existsSync(finalDir)) fail("R2 final directory already exists; no overwrite permitted", 2);
if (fs.existsSync(stageDir)) fail("exclusive R2 staging directory already exists", 2);
if (fs.readdirSync(parent).some((x) => x.startsWith(`.${name}.staging`))) fail("R2 sibling staging collision", 2);

const r1Final = path.join(parent, "ostium-settlement-boundary-conservation-r1");
const r1Files = ["model.json", "observations.json", "test-result.json", "manifest.json"].map((x) => path.join(r1Final, x));
if (!r1Files.every(fs.existsSync)) fail("immutable R1 final package missing");
const r1Before = Object.fromEntries(r1Files.map((x) => [rel(x), shaFile(x)]));
const productionDiff = git(["diff", "--", "src/OstiumVault.sol", "src/OstiumRegistry.sol", "src/interfaces/IOstiumVault.sol", "src/interfaces/IOstiumRegistry.sol"]);
if (productionDiff !== "") fail("tracked production diff is nonempty");

const cacheRoot = path.join(process.env.LOCALAPPDATA || "", "hardhat-nodejs", "Cache", "compilers-v2", "windows-amd64");
const compilerList = readJson(path.join(cacheRoot, "list.json"));
const compilerBuild = compilerList.builds.find((x) => x.version === "0.8.24" && x.longVersion === LONG);
if (!compilerBuild) fail("exact cached compiler absent");
const compilerPath = path.join(cacheRoot, compilerBuild.path);
if (!fs.existsSync(compilerPath)) fail("exact cached compiler executable absent");
const version = spawn(compilerPath, ["--version"], target);
if (version.status !== 0 || !(version.stdout || "").includes(LONG)) fail("compiler executable identity mismatch");

const env = { ...process.env, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", all_proxy: "http://127.0.0.1:9", NO_PROXY: "", no_proxy: "", PYTHONDONTWRITEBYTECODE: "1" };
delete env.PYTHONOPTIMIZE;
const pycache = path.join(process.env.LOCALAPPDATA || root, "Temp", "opencode", "ostium-r2-pycache");
env.PYTHONPYCACHEPREFIX = pycache;
const pycompile = spawn("python", ["-m", "py_compile", validator], root, env);
if (pycompile.status !== 0) fail(`R2 validator pycompile failed: ${pycompile.stderr || "unknown"}`);

fs.mkdirSync(stageDir, { recursive: false });
const compile = spawn(process.execPath, [hardhatCli, "compile", "--force"], target, env);
if (compile.status !== 0) fail("exact offline Hardhat compile failed; staging retained");
const artifactPath = path.join(target, "artifacts", "src", "OstiumVault.sol", "OstiumVault.json");
const dbg = readJson(path.join(target, "artifacts", "src", "OstiumVault.sol", "OstiumVault.dbg.json"));
const buildInfoPath = path.resolve(path.dirname(artifactPath), dbg.buildInfo);
const build = readJson(buildInfoPath), artifact = readJson(artifactPath);
if (build.solcVersion !== "0.8.24" || build.solcLongVersion !== LONG) fail("build-info compiler mismatch");
const expectedSettings = { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "evm.methodIdentifiers", "metadata"], "": ["ast"] } } };
if (JSON.stringify(build.input.settings) !== JSON.stringify(expectedSettings)) fail("compiler settings/output selection mismatch");

const test = spawn(process.execPath, [hardhatCli, "test", "--no-compile", "test/audit/OstiumSettlementBoundaryR2.test.js"], target, env);
if (test.status !== 0) fail("bounded R2 Hardhat test failed; staging retained");
const plain = `${test.stdout || ""}${test.stderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
const passing = Number((plain.match(/([0-9]+) passing/) || [0, 0])[1]), failing = Number((plain.match(/([0-9]+) failing/) || [0, 0])[1]);
if (passing !== 4 || failing !== 0) fail(`unexpected test count ${passing}/${failing}`);
const observationsPath = path.join(stageDir, "observations.json");
if (!fs.existsSync(observationsPath)) fail("fixed-path R2 observations absent");
const observations = readJson(observationsPath);
if (observations.cases.map((x) => x.caseId).join("\0") !== IDS.join("\0") || !observations.cases.every((x) => x.status === "PASS")) fail("R2 case matrix/status mismatch");

const inputFiles = [
  path.join(target, "src", "OstiumVault.sol"), path.join(target, "src", "interfaces", "IOstiumVault.sol"), path.join(target, "src", "OstiumRegistry.sol"), path.join(target, "src", "interfaces", "IOstiumRegistry.sol"),
  path.join(target, "src", "test", "audit", "OstiumStaleMarkSettlementStep1Harness.sol"), path.join(target, "src", "test", "audit", "OstiumSettlementBoundaryR1Mocks.sol"),
  path.join(target, "test", "audit", "ostium-settlement-boundary-r1-oracle.js"), path.join(target, "test", "audit", "OstiumSettlementBoundaryR1.test.js"),
  path.join(root, "tools", "run-ostium-settlement-boundary-conservation-r1.js"), r1Validator,
  path.join(target, "hardhat.config.ts"), path.join(target, "package.json"), path.join(target, "package-lock.json"),
];
const overlays = [path.join(target, "test", "audit", "ostium-settlement-boundary-r2-oracle.js"), path.join(target, "test", "audit", "OstiumSettlementBoundaryR2.test.js"), __filename, validator];
for (const file of [...inputFiles, ...overlays]) if (!fs.existsSync(file)) fail(`binding missing ${rel(file)}`);
const sourceClosure = Object.fromEntries(Object.entries(build.input.sources).map(([name, source]) => [name, shaText(source.content)]).sort(([a], [b]) => a.localeCompare(b)));
const r1Authority = r1Files.map((file) => ({ path: rel(file), sha256: shaFile(file), preserved: true, authority: "SUPERSEDED_BY_R2_FOR_CURRENT_PACKAGE_AUTHORITY" }));
const model = {
  schema: "ostium-settlement-boundary-conservation-r2-model/v2", ...flags, scope: "OFFLINE_LOCAL_EPHEMERAL_HARDHAT_SOURCE_BEHAVIOR_ONLY",
  caseCount: Q(22), caseIds: IDS,
  repository: { path: "targets/ostium", commit: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]), trackedProductionDiff: "EMPTY", trackedProductionDiffSha256: shaText(productionDiff) },
  compiler: { module: "hardhat/native-solc", version: "0.8.24", longVersion: LONG, platform: "windows-amd64", executable: compilerBuild.path, executableSha256: shaFile(compilerPath), downloadAllowed: false, networkDenialGuard: "LOOPBACK_PORT_9_ALL_HTTP_HTTPS_PROXY_CASES" },
  build: { fqn: "src/OstiumVault.sol:OstiumVault", buildInfoPath: rel(buildInfoPath), buildInfoSha256: shaFile(buildInfoPath), artifactPath: rel(artifactPath), artifactSha256: shaFile(artifactPath), artifactRuntimeBytecodeSha256: shaText(artifact.deployedBytecode),
    compilerSettings: { optimizerEnabled: true, optimizerRuns: "200", viaIR: true, evmVersion: "paris", outputSelection: expectedSettings.outputSelection }, sourceClosure,
    astTripwires: ["OstiumVault", "tryNewSettlement", "_getOpenPnlDelta", "_executeAsyncDepositWithdraw", "_applyMMCashflow", "mmDeposit", "mmWithdraw"].map((name, i) => ({ nodeType: i === 0 ? "ContractDefinition" : "FunctionDefinition", name })) },
  systemUnderTest: { vault: "UNCHANGED_PRODUCTION_OSTIUM_VAULT", transport: "UNCHANGED_AUDIT_ERC1967_PROXY", registry: "PRODUCTION_OSTIUM_REGISTRY", asset: "UNCHANGED_AUDIT_USDC", openPnl: "UNCHANGED_R1_REFERENCE_SETUP_RESTRICTED_DIRECT_VALUE", marketMaker: "SIGNER_PRODUCTION_API" },
  inputBindings: inputFiles.map(bind), overlays: overlays.map(bind), r1Authority, historicalContext: [],
  insufficientCustodyClassification: { kind: "DIAGNOSTIC_LIVENESS", panicCode: "0x11", conservationLoss: false, route: false },
};
writeJson(path.join(stageDir, "model.json"), model);
const result = { schema: "ostium-settlement-boundary-conservation-r2-test-result/v2", ...flags,
  compile: commandResult(compile, "hardhat compile --force (network denied)"), test: commandResult(test, "hardhat test --no-compile test/audit/OstiumSettlementBoundaryR2.test.js", { passing: Q(passing), failing: Q(failing) }),
  caseCount: Q(22), observationsSha256: shaFile(observationsPath) };
writeJson(path.join(stageDir, "test-result.json"), result);
const manifest = { schema: "ostium-settlement-boundary-conservation-r2-manifest/v2", ...flags, packageDirectory: name,
  authoritativeFileSha256: { "model.json": shaFile(path.join(stageDir, "model.json")), "observations.json": shaFile(observationsPath), "test-result.json": shaFile(path.join(stageDir, "test-result.json")) }, r1Authority };
writeJson(path.join(stageDir, "manifest.json"), manifest);

const stagedValidation = spawn("python", [validator, stageDir], root, env);
if (stagedValidation.status !== 0) { process.stderr.write(stagedValidation.stdout || ""); process.stderr.write(stagedValidation.stderr || ""); fail("strict staged validator failed; staging retained"); }
const r1Validation = spawn("python", [r1Validator, r1Final], root, env);
if (r1Validation.status !== 0) fail(`original R1 validator regression: ${r1Validation.stdout || ""}${r1Validation.stderr || ""}`);
const r1After = Object.fromEntries(r1Files.map((x) => [rel(x), shaFile(x)]));
if (JSON.stringify(r1Before) !== JSON.stringify(r1After)) fail("R1 final package changed");

fs.renameSync(stageDir, finalDir);
const finalValidation = spawn("python", [validator, finalDir], root, env);
if (finalValidation.status !== 0) { process.stderr.write(finalValidation.stdout || ""); process.stderr.write(finalValidation.stderr || ""); fail("strict final validator failed"); }
const finalHashes = Object.fromEntries(fs.readdirSync(finalDir).sort().map((x) => [x, shaFile(path.join(finalDir, x))]));
const rerun = spawn(process.execPath, [__filename], root, env);
if (rerun.status !== 2 || !(rerun.stderr || "").includes("no overwrite permitted")) fail("R2 no-overwrite rerun assertion failed");
const afterProbe = Object.fromEntries(fs.readdirSync(finalDir).sort().map((x) => [x, shaFile(path.join(finalDir, x))]));
if (JSON.stringify(finalHashes) !== JSON.stringify(afterProbe)) fail("R2 no-overwrite probe mutated final package");
const checkMatch = (finalValidation.stdout || "").match(/checks=([0-9]+)/);
process.stdout.write(JSON.stringify({ status: "PASS", classification: flags.classification, cases: "22", testFunctionsPassing: "4", validatorChecks: checkMatch ? checkMatch[1] : "UNKNOWN", sourceClosureCount: String(Object.keys(sourceClosure).length), inputBindings: String(inputFiles.length), overlays: String(overlays.length), compiler: LONG,
  buildInfoSha256: shaFile(buildInfoPath), artifactSha256: shaFile(artifactPath), finalFiles: finalHashes, stagedValidation: (stagedValidation.stdout || "").trim(), finalValidation: (finalValidation.stdout || "").trim(), r1Validation: (r1Validation.stdout || "").trim(), noOverwriteRerunExitCode: String(rerun.status) }, null, 2) + "\n");
