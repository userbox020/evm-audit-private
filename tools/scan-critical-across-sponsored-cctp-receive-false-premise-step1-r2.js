"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");
const vm = require("vm");

const NAME = "critical-across-sponsored-cctp-receive-false-premise-step1-r2";
const PREDECESSOR = "critical-across-sponsored-cctp-receive-false-premise-step1";
const CLASSIFICATION = "CLOSED/FALSE-PERMISSIONLESS-PREMISE/SCOPED-EOA-SOURCE-SEMANTICS/PRIVILEGED-EMERGENCY-AND-SWEEPER/CCTP-ATTESTED-FEE-EXECUTED/SIGNED-MAX-FEE/PREEXISTING-BALANCE-PROTECTED";
const ROOT = path.resolve(__dirname, "..");
const REPO = path.join(ROOT, "targets", "across-contracts");
const TEST_R1 = "targets/across-contracts/test/evm/foundry/local/SponsoredCCTPReceiveInvariant.t.sol";
const TEST_R2 = "targets/across-contracts/test/evm/foundry/local/SponsoredCCTPReceiveInvariantR2.t.sol";
const SOURCES = [
  "targets/across-contracts/contracts/periphery/mintburn/sponsored-cctp/SponsoredCCTPDstPeriphery.sol",
  "targets/across-contracts/contracts/libraries/SponsoredCCTPQuoteLib.sol",
  "targets/across-contracts/contracts/periphery/mintburn/BaseModuleHandler.sol",
  "targets/across-contracts/contracts/periphery/mintburn/AuthorizedFundedFlow.sol",
  "targets/across-contracts/contracts/periphery/mintburn/ArbitraryEVMFlowExecutor.sol",
  "targets/across-contracts/contracts/periphery/mintburn/HyperCoreFlowExecutor.sol",
  "targets/across-contracts/contracts/handlers/MulticallHandler.sol",
  "targets/across-contracts/contracts/interfaces/SponsoredCCTPInterface.sol",
  "targets/across-contracts/contracts/external/interfaces/CCTPInterfaces.sol",
];
const PREDECESSOR_SCANNER = `tools/scan-${PREDECESSOR}.js`;
const PREDECESSOR_MANIFEST = `reports/raw/fast/${PREDECESSOR}-manifest.json`;
const RAW = `reports/raw/fast/${NAME}.json`;
const TESTS = `reports/raw/fast/${NAME}-tests.json`;
const REPORT = `reports/${NAME}.md`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const INBOX = `coordination/inbox/critical/2026-07-26-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-26-${NAME}-handoff.md`;
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/validate-${NAME}.js`;
const SEED = "0xaccc7a02";

const read = (relative) => fs.readFileSync(path.join(ROOT, relative));
const json = (relative) => JSON.parse(read(relative));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const slash = (value) => value.replace(/\\/g, "/");
const write = (relative, value) => {
  const output = path.join(ROOT, relative);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, value);
};
const record = (relative) => {
  const value = read(relative);
  return { path: relative, bytes: value.length, sha256: sha(value) };
};
const check = (condition, message) => { if (!condition) throw new Error(message); };
const run = (command, args, cwd) => {
  const result = cp.spawnSync(command, args, {
    cwd, encoding: "utf8", env: { ...process.env, FOUNDRY_PROFILE: "local-test" }, maxBuffer: 40 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
};

function predecessorShims() {
  const source = read(PREDECESSOR_SCANNER).toString("utf8");
  const start = source.indexOf("const SHIMS = {");
  const end = source.indexOf("\n};", start);
  check(start >= 0 && end > start, "predecessor SHIMS block");
  return vm.runInNewContext(`${source.slice(start, end + 3)}\nSHIMS;`, Object.create(null));
}

function isolatedConfig() {
  const tmp = path.join(os.tmpdir(), "opencode", NAME);
  fs.rmSync(tmp, { recursive: true, force: true });
  const deps = path.join(tmp, "deps");
  const testDir = path.join(tmp, "test");
  const out = path.join(tmp, "out");
  for (const [relative, content] of Object.entries(predecessorShims())) {
    const destination = path.join(deps, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  fs.mkdirSync(testDir, { recursive: true });
  for (const test of [TEST_R1, TEST_R2]) {
    fs.writeFileSync(
      path.join(testDir, path.basename(test)),
      read(test).toString("utf8").replaceAll('"../../../../contracts/', '"repo-contracts/')
    );
  }
  const configDir = path.join(tmp, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const config = `[profile.local-test]\nsrc = "contracts"\ntest = "${slash(testDir)}"\nlibs = []\ncache_path = "${slash(path.join(tmp, "cache"))}"\nout = "${slash(out)}"\nvia_ir = true\noptimizer_runs = 300\nsolc = "0.8.30"\nevm_version = "prague"\nrevert_strings = "default"\nremappings = [\n  "forge-std/=${slash(path.join(REPO, "lib", "forge-std", "src"))}/",\n  "repo-contracts/=${slash(path.join(REPO, "contracts"))}/",\n  "@openzeppelin/contracts-upgradeable/=${slash(path.join(deps, "oz5up"))}/",\n  "@openzeppelin/contracts-v4/=${slash(path.join(deps, "oz4"))}/",\n  "@openzeppelin/contracts/=${slash(path.join(deps, "oz5"))}/"\n]\n`;
  const configPath = path.join(configDir, "foundry.toml");
  fs.writeFileSync(configPath, config);
  return { out, configPath };
}

const passLines = (output) => output.split(/\r?\n/).filter((line) => line.startsWith("[PASS]")).join("\n");
const aggregateFor = (records) => sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));

function main() {
  const predecessor = json(PREDECESSOR_MANIFEST);
  const predecessorRecords = predecessor.records.map((item) => record(item.path));
  check(aggregateFor(predecessorRecords) === predecessor.aggregateSha256, "predecessor aggregate replay");
  const predecessorBinding = {
    runId: predecessor.runId,
    manifestPath: PREDECESSOR_MANIFEST,
    manifestSha256: sha(read(PREDECESSOR_MANIFEST)),
    aggregateSha256: predecessor.aggregateSha256,
    recordsVerified: predecessorRecords.length,
  };

  const quoteLib = read(SOURCES[1]).toString("utf8");
  check(quoteLib.includes("quote.maxFee,"), "maxFee included in signed hash1");
  check(!quoteLib.slice(quoteLib.indexOf("function validateSignature"), quoteLib.length).includes("feeExecuted"), "feeExecuted excluded from quote signature");
  const executor = read(SOURCES[5]).toString("utf8");
  check(executor.includes("function sweepErc20(address token, uint256 amount) external onlyRole(FUNDS_SWEEPER_ROLE)"), "funds sweeper role source marker");
  check(executor.includes("IERC20(token).safeTransfer(msg.sender, amount);"), "sweep recipient source marker");

  const commit = run("git", ["rev-parse", "HEAD"], REPO).trim();
  for (const productionSource of SOURCES) {
    const relative = productionSource.replace("targets/across-contracts/", "");
    check(cp.spawnSync("git", ["diff", "--quiet", "--", relative], { cwd: REPO }).status === 0, `dirty production source: ${relative}`);
  }
  const dirty = run("git", ["status", "--short"], REPO).replace(/\s+$/, "").split(/\r?\n/).filter(Boolean);
  const isolated = isolatedConfig();
  const baseArgs = ["test", "--root", REPO, "--config-path", isolated.configPath, "--fuzz-runs", "256", "--fuzz-seed", SEED, "--offline"];
  const r1Args = [...baseArgs, "--match-contract", "SponsoredCCTPReceiveInvariantTest"];
  const r2Args = [...baseArgs, "--match-contract", "SponsoredCCTPReceiveInvariantR2Test"];
  const r1First = run("forge", r1Args, REPO);
  const r2First = run("forge", r2Args, REPO);
  const firstPasses = `${passLines(r1First)}\n${passLines(r2First)}`;
  const secondPasses = `${passLines(run("forge", r1Args, REPO))}\n${passLines(run("forge", r2Args, REPO))}`;
  check(firstPasses === secondPasses, "deterministic replay");
  check((firstPasses.match(/^\[PASS\]/gm) || []).length === 19, "combined test count");
  check((firstPasses.match(/runs: 256/g) || []).length === 2, "combined fuzz count");
  const harnessArtifact = JSON.parse(
    fs.readFileSync(path.join(isolated.out, "SponsoredCCTPReceiveInvariantR2.t.sol", "SponsoredCCTPReceiveInvariantR2Test.json"))
  );
  const harnessRuntime = Buffer.from(harnessArtifact.deployedBytecode.object.replace(/^0x/, ""), "hex");

  const tests = {
    schemaVersion: 2,
    profile: "local-test",
    commands: [
      `FOUNDRY_PROFILE=local-test forge ${r1Args.join(" ")}`,
      `FOUNDRY_PROFILE=local-test forge ${r2Args.join(" ")}`,
    ],
    seed: SEED, network: false, fork: false,
    testsPassed: 19, testsFailed: 0, testsSkipped: 0,
    predecessorTests: 13, r2Tests: 6, fixedTests: 17, fuzzTestFunctions: 2,
    fuzzCases: 512, effectiveCases: 529, replayCount: 2, deterministicReplay: true,
    normalizedPassOutputSha256: sha(Buffer.from(firstPasses)),
    normalizedPassOutput: firstPasses.split("\n"),
    canonicalProfileStatus: {
      passed: false,
      reason: "pre-existing node_modules dependency tree remains absent; exact repository profile is dependency-blocked as recorded by the predecessor",
    },
    isolatedCompile: {
      exactProductionSourcesImported: true,
      predecessorShimSetSha256: sha(Buffer.from(JSON.stringify(predecessorShims()))),
      limitations: "Scoped EOA source-semantic regression only. The local SignatureChecker shim is EOA-only; ERC-1271 is untested. CCTP mocks permit configured mint-recipient overrides for post-mint malformed-message testing and model feeExecuted <= maxFee plus whole-message attestation; they are not Circle code, deployed runtime equivalence, or proof of deployed configuration.",
      deployedRuntimeEquivalence: false,
      erc1271Covered: false,
      r2HarnessRuntimeBytes: harnessRuntime.length,
      r2HarnessRuntimeSha256: sha(harnessRuntime),
      r1TestSource: record(TEST_R1),
      r2TestSource: record(TEST_R2),
    },
  };
  write(TESTS, `${JSON.stringify(tests, null, 2)}\n`);

  const sourceRecords = SOURCES.map(record);
  const raw = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    runId: `${NAME}-${commit.slice(0, 12)}-${record(TEST_R2).sha256.slice(0, 12)}`,
    agentId: "reviewer-across-sponsored-cctp-r2-20260725",
    role: "reviewer",
    classification: CLASSIFICATION,
    predecessor: predecessorBinding,
    pipeline: { branch: 0, total: 5 },
    gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false },
    productionBinding: { commit, sources: sourceRecords, productionSourcesModified: false, deployedRuntimeEquivalence: false },
    conclusions: {
      feeSemantics: {
        quoteSignatureBindsMaxFee: true,
        quoteSignatureBindsFeeExecuted: false,
        feeExecutedBindingInHarness: "whole-message attestation mock",
        freshAttestedFeeExecutedAtOrBelowMaxFeeAccepted: true,
        exactForwarding: "quote.amount - CCTP-attested feeExecuted",
        feeExecutedAboveMaxFee: "rejected by scoped CCTP-enforcement mock assumption",
        staleAttestationFeeMutationFailureLayer: "CCTP transmitter, not quote signature",
        maxFeeMutationWithFreshAttestation: "InvalidSignature",
      },
      authorization: {
        emergency: "PERMISSIONED_BOT_ROLE",
        normalSubmissionPermissionless: true,
        normalExecution: "CCTP-attestation, TokenMessenger/token-link, exact mint delta, EOA quote signature, deadline, and nonce bound",
        strandedFundSweep: "FUNDS_SWEEPER_ROLE",
        arbitraryCallerSweep: false,
      },
      custodyRisk: "A privileged FUNDS_SWEEPER_ROLE holder can transfer stranded ERC20, including pre-existing and newly minted custody, to itself. This is an explicit privileged custody/trust risk, not a permissionless extraction route.",
      preservedRegression: ["pre-existing balance isolation", "CCTP and quote-nonce replay", "normal/emergency/direct reentry block", "under/over mint rejection", "malformed post-mint stranding"],
      scope: tests.isolatedCompile.limitations,
      permissionlessProfit: 0,
    },
    tests,
    dirtyTreeDisclosure: {
      dirty: true, entries: dirty,
      unrelatedEntriesUntouched: dirty.filter((row) => !row.endsWith("SponsoredCCTPReceiveInvariantR2.t.sol")),
    },
    activityScope: {
      offlineOnly: true, endpointInventoryReads: 0, rpcCalls: 0, httpRequests: 0, forkCreated: false,
      liveCalls: 0, transactions: 0, signing: false, broadcasts: 0, productionMutation: false,
    },
  };
  write(RAW, `${JSON.stringify(raw, null, 2)}\n`);

  write(REPORT, `# 🟢 CLOSED — Across Sponsored CCTP receive reviewer-corrected R2\n\n**Classification:** \`${CLASSIFICATION}\`  \n**Pipeline:** branch \`0/5\`; gates \`0/0/false\`; fork=false\n\n## Corrected fee semantics\n\nThe quote signature binds \`quote.maxFee\`; it does **not** bind \`feeExecuted\`. In the scoped harness, \`feeExecuted\` is bound by the mock's whole-message attestation and is accepted at any value \`<= maxFee\`. Fresh valid messages at zero, midpoint, maximum, and 256 fuzzed fees forward exactly \`quote.amount - feeExecuted\`. The mock rejects \`feeExecuted > maxFee\` before mint. A fee mutation carrying the original attestation fails at the CCTP transmitter layer, not at quote-signature validation. Mutating signed \`maxFee\` under a fresh whole-message attestation reaches and fails \`InvalidSignature\`.\n\n## Authorization and custody\n\nEmergency receive remains \`PERMISSIONED_BOT_ROLE\`-only and delta-forwards without consuming prior custody. Normal transaction submission is permissionless, while execution remains CCTP-attestation, TokenMessenger/token-link, exact mint-delta, EOA quote-signature, deadline, and nonce bound. Predecessor tests preserve prior-balance isolation, replay rejection, under/over-mint rejection, malformed post-mint stranding, and callback blocks into normal/emergency/direct paths.\n\nStranded ERC20 is operationally recoverable through delegated \`HyperCoreFlowExecutor.sweepErc20\`, but only a \`FUNDS_SWEEPER_ROLE\` holder can call it. Arbitrary callers cannot sweep. The role can transfer both pre-existing and newly minted custody to itself, which is an explicit privileged custody/trust risk and not a permissionless extraction route.\n\n## Scope and bindings\n\nThis is only a scoped EOA source-semantic regression. The isolated SignatureChecker shim supports EOAs only; ERC-1271 is not covered. The CCTP mocks support configured mint-recipient override for malformed post-mint tests and model whole-message attestation plus \`feeExecuted <= maxFee\`; they are not Circle code, deployed runtime equivalence, or deployed-configuration evidence.\n\n- Combined PASS: 19/19 functions (13 predecessor + 6 R2); 17 fixed and 2 fuzz functions.\n- Fuzz: 512 total fixed-seed cases; 529 effective cases.\n- Deterministic replay: 2/2; normalized PASS digest \`${tests.normalizedPassOutputSha256}\`.\n- R2 harness runtime: ${harnessRuntime.length} bytes / \`${tests.isolatedCompile.r2HarnessRuntimeSha256}\`.\n- Predecessor aggregate: \`${predecessor.aggregateSha256}\`; predecessor manifest SHA-256 \`${predecessorBinding.manifestSha256}\`.\n- Production commit: \`${commit}\`; primary source SHA-256 \`${sourceRecords[0].sha256}\`.\n\nNo network, endpoint inventory, RPC, HTTP, fork, transaction, live signing, broadcast, or production mutation occurred. Unrelated dirty files and production sources were not modified.\n`);

  const inbox = {
    findingId: NAME, runId: raw.runId, agentId: raw.agentId, role: raw.role, status: CLASSIFICATION,
    classification: CLASSIFICATION, predecessor: predecessorBinding, routePositive: 0, executableNow: 0,
    signedActionJustified: false, fork: false,
    summary: "R2 corrects fee semantics: signatures bind maxFee, CCTP attestation binds feeExecuted; privileged sweep recovers stranded custody and is a trust risk, while no arbitrary-caller receive or sweep route exists.",
    artifacts: [RAW, TESTS, MANIFEST, REPORT, TEST_R2, HANDOFF],
    nextAction: "None for scoped EOA source semantics; reopen for exact Circle/deployed runtime and configuration evidence or ERC-1271 signer coverage.",
  };
  write(INBOX, `${JSON.stringify(inbox, null, 2)}\n`);
  write(HANDOFF, `# Across Sponsored CCTP receive reviewer-corrected R2 handoff\n\n- Classification: \`${CLASSIFICATION}\`; branch 0/5; gates 0/0/false; fork=false.\n- Correction: signature binds \`maxFee\`, never \`feeExecuted\`; whole-message attestation mock binds feeExecuted, accepts <= maxFee, and rejects > maxFee. Stale-attestation fee mutation is attributed to CCTP, while fresh-attested maxFee mutation fails quote signature.\n- Custody: malformed post-mint funds can be recovered by \`FUNDS_SWEEPER_ROLE\`; arbitrary callers fail. The sweeper can take prior and new custody, an explicit privileged trust risk.\n- Preserved: prior-balance isolation, replay, under/over mint, malformed stranding, and normal/emergency/direct reentry regressions.\n- Scope: EOA-only source semantics; mint-recipient-flexible/CCTP enforcement mocks are not Circle or deployed-runtime equivalence; ERC-1271 is not covered.\n- Tests: 19/19; 512 fuzz; 529 effective; deterministic replay 2/2; PASS digest \`${tests.normalizedPassOutputSha256}\`.\n- R2 harness: ${harnessRuntime.length} bytes / \`${tests.isolatedCompile.r2HarnessRuntimeSha256}\`. Predecessor aggregate \`${predecessor.aggregateSha256}\`; manifest \`${predecessorBinding.manifestSha256}\`.\n- Offline only; production and unrelated files untouched.\n`);

  const records = [SCANNER, VALIDATOR, TEST_R2, ...SOURCES, RAW, TESTS, REPORT, INBOX, HANDOFF, PREDECESSOR_MANIFEST].map(record);
  const aggregateSha256 = aggregateFor(records);
  const manifest = {
    schemaVersion: 2, runId: raw.runId, classification: CLASSIFICATION, algorithm: "sha256", aggregateSha256,
    predecessor: predecessorBinding, records, productionCommit: commit, productionSources: sourceRecords,
    localHarness: tests.isolatedCompile,
    tests: { passed: 19, failed: 0, predecessor: 13, r2: 6, fuzzCases: 512, effectiveCases: 529, replayCount: 2 },
    gates: raw.gates, activityScope: raw.activityScope,
  };
  write(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, runId: raw.runId, classification: CLASSIFICATION, tests: "19/19", fuzzCases: 512, effectiveCases: 529, replayCount: 2, normalizedPassOutputSha256: tests.normalizedPassOutputSha256, r2HarnessRuntimeSha256: tests.isolatedCompile.r2HarnessRuntimeSha256, predecessorAggregateSha256: predecessor.aggregateSha256, predecessorManifestSha256: predecessorBinding.manifestSha256, records: records.length, aggregateSha256 })}\n`);
}

main();
