"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");

const NAME = "critical-across-hyperevm-activation-fee-false-premise-step1";
const CLASSIFICATION = "CLOSED/FALSE-PREMISE/PRIVILEGED-AND-STATE-BOUND-ACTIVATION-FEE/NO-PERMISSIONLESS-PROFIT";
const ROOT = path.resolve(__dirname, "..");
const REPO = path.join(ROOT, "targets", "across-contracts");
const TEST = "targets/across-contracts/test/evm/foundry/local/HyperCoreActivationFeeInvariant.t.sol";
const SOURCES = [
  "targets/across-contracts/contracts/periphery/mintburn/HyperCoreFlowExecutor.sol",
  "targets/across-contracts/contracts/libraries/HyperCoreLib.sol",
  "targets/across-contracts/contracts/periphery/mintburn/BaseModuleHandler.sol",
  "targets/across-contracts/contracts/periphery/mintburn/AuthorizedFundedFlow.sol",
  "targets/across-contracts/contracts/chain-adapters/DonationBox.sol",
];
const RAW = `reports/raw/fast/${NAME}.json`;
const TESTS = `reports/raw/fast/${NAME}-tests.json`;
const REPORT = `reports/${NAME}.md`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const INBOX = `coordination/inbox/critical/2026-07-26-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-26-${NAME}-handoff.md`;
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/validate-${NAME}.js`;
const SEED = "0xac71fae";

const read = (relative) => fs.readFileSync(path.join(ROOT, relative));
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
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const run = (command, args, cwd) => {
  const result = cp.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FOUNDRY_PROFILE: "local-test" },
    maxBuffer: 24 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
};

const SHIMS = {
  "oz5/token/ERC20/IERC20.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ninterface IERC20 { event Transfer(address indexed from,address indexed to,uint256 value); event Approval(address indexed owner,address indexed spender,uint256 value); function totalSupply() external view returns(uint256); function balanceOf(address) external view returns(uint256); function transfer(address,uint256) external returns(bool); function allowance(address,address) external view returns(uint256); function approve(address,uint256) external returns(bool); function transferFrom(address,address,uint256) external returns(bool); }\n`,
  "oz5/token/ERC20/extensions/IERC20Metadata.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nimport {IERC20} from "../IERC20.sol";\ninterface IERC20Metadata is IERC20 { function name() external view returns(string memory); function symbol() external view returns(string memory); function decimals() external view returns(uint8); }\n`,
  "oz5/token/ERC20/utils/SafeERC20.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nimport {IERC20} from "../IERC20.sol";\nlibrary SafeERC20 { function safeTransfer(IERC20 token,address to,uint256 amount) internal { require(token.transfer(to,amount),"SafeERC20: transfer failed"); } function forceApprove(IERC20 token,address spender,uint256 amount) internal { require(token.approve(spender,amount),"SafeERC20: approve failed"); } }\n`,
  "oz5/access/AccessControl.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nabstract contract AccessControl { bytes32 public constant DEFAULT_ADMIN_ROLE=0x00; mapping(bytes32=>mapping(address=>bool)) private _roles; mapping(bytes32=>bytes32) private _admins; modifier onlyRole(bytes32 role){require(_roles[role][msg.sender],"AccessControl: unauthorized");_;} function hasRole(bytes32 role,address account) public view returns(bool){return _roles[role][account];} function getRoleAdmin(bytes32 role) public view returns(bytes32){return _admins[role];} function grantRole(bytes32 role,address account) public onlyRole(getRoleAdmin(role)){_grantRole(role,account);} function _grantRole(bytes32 role,address account) internal {_roles[role][account]=true;} function _setRoleAdmin(bytes32 role,bytes32 admin) internal {_admins[role]=admin;} }\n`,
  "oz5up/access/AccessControlUpgradeable.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nabstract contract AccessControlUpgradeable { bytes32 public constant DEFAULT_ADMIN_ROLE=0x00; mapping(bytes32=>mapping(address=>bool)) private _roles; mapping(bytes32=>bytes32) private _admins; modifier onlyRole(bytes32 role){require(_roles[role][msg.sender],"AccessControl: unauthorized");_;} function hasRole(bytes32 role,address account) public view returns(bool){return _roles[role][account];} function getRoleAdmin(bytes32 role) public view returns(bytes32){return _admins[role];} function grantRole(bytes32 role,address account) public onlyRole(getRoleAdmin(role)){_grantRole(role,account);} function _grantRole(bytes32 role,address account) internal {_roles[role][account]=true;} function _setRoleAdmin(bytes32 role,bytes32 admin) internal {_admins[role]=admin;} }\n`,
  "oz4/token/ERC20/IERC20.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ninterface IERC20 { event Transfer(address indexed from,address indexed to,uint256 value); event Approval(address indexed owner,address indexed spender,uint256 value); function totalSupply() external view returns(uint256); function balanceOf(address) external view returns(uint256); function transfer(address,uint256) external returns(bool); function allowance(address,address) external view returns(uint256); function approve(address,uint256) external returns(bool); function transferFrom(address,address,uint256) external returns(bool); }\n`,
  "oz4/token/ERC20/utils/SafeERC20.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nimport {IERC20} from "../IERC20.sol";\nlibrary SafeERC20 { function safeTransfer(IERC20 token,address to,uint256 amount) internal { require(token.transfer(to,amount),"SafeERC20: transfer failed"); } function forceApprove(IERC20 token,address spender,uint256 amount) internal { require(token.approve(spender,amount),"SafeERC20: approve failed"); } }\n`,
  "oz4/security/ReentrancyGuard.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nabstract contract ReentrancyGuard { uint256 private _status=1; modifier nonReentrant(){require(_status!=2,"ReentrancyGuard: reentrant call");_status=2;_;_status=1;} }\n`,
  "oz4/utils/math/SafeCast.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nlibrary SafeCast { function toUint64(uint256 value) internal pure returns(uint64){require(value<=type(uint64).max,"SafeCast overflow"); return uint64(value);} }\n`,
};

function isolatedConfig() {
  const tmp = path.join(os.tmpdir(), "opencode", NAME);
  fs.rmSync(tmp, { recursive: true, force: true });
  const deps = path.join(tmp, "deps");
  const testDir = path.join(tmp, "test");
  const out = path.join(tmp, "out");
  for (const [relative, content] of Object.entries(SHIMS)) {
    const destination = path.join(deps, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  fs.mkdirSync(testDir, { recursive: true });
  const testText = read(TEST).toString("utf8").replaceAll('"../../../../contracts/', '"repo-contracts/');
  fs.writeFileSync(path.join(testDir, "HyperCoreActivationFeeInvariant.t.sol"), testText);
  const configDir = path.join(tmp, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const config = `[profile.local-test]\nsrc = "contracts"\ntest = "${slash(testDir)}"\nlibs = []\ncache_path = "${slash(path.join(tmp, "cache"))}"\nout = "${slash(out)}"\nvia_ir = true\noptimizer_runs = 300\nsolc = "0.8.30"\nevm_version = "prague"\nrevert_strings = "default"\nremappings = [\n  "forge-std/=${slash(path.join(REPO, "lib", "forge-std", "src"))}/",\n  "repo-contracts/=${slash(path.join(REPO, "contracts"))}/",\n  "@openzeppelin/contracts-upgradeable/=${slash(path.join(deps, "oz5up"))}/",\n  "@openzeppelin/contracts-v4/=${slash(path.join(deps, "oz4"))}/",\n  "@openzeppelin/contracts/=${slash(path.join(deps, "oz5"))}/"\n]\n`;
  const configPath = path.join(configDir, "foundry.toml");
  fs.writeFileSync(configPath, config);
  return { tmp, out, configPath };
}

function passLines(output) {
  return output.split(/\r?\n/).filter((line) => line.startsWith("[PASS]")).join("\n");
}

function main() {
  const executor = read(SOURCES[0]).toString("utf8");
  const baseHandler = read(SOURCES[2]).toString("utf8");
  const funded = read(SOURCES[3]).toString("utf8");
  for (const marker of [
    ") external onlyRole(PERMISSIONED_BOT_ROLE) returns (uint256 finalized)",
    "if (!HyperCoreLib.coreUserExists(swap.finalRecipient))",
    "accountActivationFee = finalCoreTokenInfo.accountActivationFeeCore;",
    "swap.finalized = true;",
    "swapHandler.transferFundsToUserOnCore(",
    ") external onlyRole(PERMISSIONED_BOT_ROLE) {",
    "require(!coreUserExists, \"Can't fund account activation for existing user\");",
    "cumulativeSponsoredActivationFee[fundingToken] += evmAmountToSend;",
    "donationBox.withdraw(IERC20(fundingToken), evmAmountToSend);",
  ]) check(executor.includes(marker), `source marker missing: ${marker}`);
  check(baseHandler.includes("fallback(bytes calldata data) external nonReentrant"), "fallback nonReentrant");
  check(funded.includes("revert FundedFlowNotAuthorized();"), "funded-flow authorization");

  const commit = run("git", ["rev-parse", "HEAD"], REPO).trim();
  for (const source of SOURCES) {
    const relative = source.replace("targets/across-contracts/", "");
    check(cp.spawnSync("git", ["diff", "--quiet", "--", relative], { cwd: REPO }).status === 0, `dirty production source: ${relative}`);
  }
  const dirty = run("git", ["status", "--short"], REPO).replace(/\s+$/, "").split(/\r?\n/).filter(Boolean);

  const isolated = isolatedConfig();
  const args = [
    "test", "--root", REPO, "--config-path", isolated.configPath, "--match-contract",
    "HyperCoreActivationFeeInvariantTest", "--fuzz-runs", "256", "--fuzz-seed", SEED, "--offline",
  ];
  const first = run("forge", args, REPO);
  const second = run("forge", args, REPO);
  const firstPass = passLines(first);
  const secondPass = passLines(second);
  check(firstPass === secondPass, "deterministic replay");
  check((firstPass.match(/^\[PASS\]/gm) || []).length === 8, "test count");
  check(firstPass.includes("runs: 256"), "fuzz runs");
  const harnessArtifact = JSON.parse(
    fs.readFileSync(path.join(isolated.out, "HyperCoreActivationFeeInvariant.t.sol", "ActivationFeeHandler.json"))
  );
  const harnessRuntime = Buffer.from(harnessArtifact.deployedBytecode.object.replace(/^0x/, ""), "hex");

  const tests = {
    schemaVersion: 1,
    profile: "local-test",
    command: `FOUNDRY_PROFILE=local-test forge ${args.join(" ")}`,
    seed: SEED,
    network: false,
    fork: false,
    testsPassed: 8,
    testsFailed: 0,
    testsSkipped: 0,
    fixedTests: 7,
    fuzzTestFunctions: 1,
    fuzzCases: 256,
    effectiveCases: 263,
    replayCount: 2,
    deterministicReplay: true,
    normalizedPassOutputSha256: sha(Buffer.from(firstPass)),
    normalizedPassOutput: firstPass.split("\n"),
    exactRepositoryProfileAttempt: {
      passed: false,
      reason: "pre-existing node_modules dependency tree is absent; canonical local-profile compilation is dependency-blocked before scoped execution",
      missingExamples: ["@openzeppelin/contracts", "@openzeppelin/contracts-v4", "@openzeppelin/contracts-upgradeable"],
    },
    isolatedCompile: {
      exactProductionSourcesImported: true,
      minimalLocalDependencyShims: true,
      shimScope: ["IERC20", "SafeERC20", "AccessControl", "AccessControlUpgradeable", "ReentrancyGuard", "SafeCast"],
      harnessRuntimeBytes: harnessRuntime.length,
      harnessRuntimeSha256: sha(harnessRuntime),
      testSource: record(TEST),
    },
  };
  write(TESTS, `${JSON.stringify(tests, null, 2)}\n`);

  const sourceRecords = SOURCES.map(record);
  const raw = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId: `${NAME}-${commit.slice(0, 12)}-${sourceRecords[0].sha256.slice(0, 12)}`,
    agentId: "fixer-across-activation-fee-step1-20260725",
    role: "critical-research",
    classification: CLASSIFICATION,
    pipeline: { branch: 0, total: 5 },
    gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false },
    productionBinding: { commit, sources: sourceRecords, productionSourcesModified: false },
    conclusions: {
      permissionlessObjective: {
        existsAccountActivationFeeCore: 0,
        absentAccountFeeSource: "configured CoreTokenInfo.accountActivationFeeCore",
        absentAccountPayer: "stored user's finalized Core amount",
        finalizeDonationBoxActivationDebit: 0,
        recipientBinding: "stored SwapFlowState.finalRecipient",
        arbitraryCallerFinalize: false,
        arbitraryCallerFallback: false,
        profit: 0,
      },
      privilegedControlPlane: {
        activateUserAccountRole: "PERMISSIONED_BOT_ROLE",
        payer: "DonationBox",
        debit: "minimum EVM amount for accountActivationFeeCore + 1 Core unit",
        repeatForExistingAccount: "reverts before debit",
        permissionless: false,
      },
      atomicity: "handler fallback nonReentrant; finalized/debit/Core-send state reverts atomically on failed transfer",
    },
    tests,
    dirtyTreeDisclosure: {
      dirty: true,
      entries: dirty,
      unrelatedEntriesUntouched: dirty.filter((row) => !row.endsWith("HyperCoreActivationFeeInvariant.t.sol")),
    },
    activityScope: {
      offlineOnly: true,
      endpointInventoryReads: 0,
      rpcCalls: 0,
      httpRequests: 0,
      forkCreated: false,
      liveCalls: 0,
      transactions: 0,
      signing: false,
      broadcasts: 0,
      productionMutation: false,
    },
  };
  write(RAW, `${JSON.stringify(raw, null, 2)}\n`);

  write(REPORT, `# 🟢 CLOSED — Across HyperEVM activation-fee false premise Step 1\n\n**Classification:** \`${CLASSIFICATION}\`  \n**Pipeline:** branch \`0/5\`; gates \`0/0/false\`; fork=false\n\n## Result\n\nThe permissionless activation-fee objective is a false premise in the exact commit-bound source. During \`finalizeSwapFlows\`, an existing stored recipient pays zero activation fee. If that account is absent, the executor loads the configured \`accountActivationFeeCore\` and subtracts it from the amount attributable to that user; finalization does not withdraw that activation fee from the DonationBox. The recipient comes from stored \`SwapFlowState.finalRecipient\` and cannot be supplied or substituted by the finalizer. Finalization is \`PERMISSIONED_BOT_ROLE\`-gated, direct funded fallback is authorization-gated, and the handler fallback is non-reentrant. No arbitrary caller profit or DonationBox capture path is established.\n\n\`activateUserAccount\` is a separate privileged control-plane function. A permissioned bot can debit the DonationBox by the exact EVM amount required for configured activation fee plus one Core unit, but an existing account causes a pre-debit revert. This privileged sponsorship is not a permissionless objective. Callback attempts cannot reenter, and failed downstream Core transfer rolls back finalized state, DonationBox debit, balances, and recorder state.\n\n## Tests and bindings\n\n- PASS: 8/8 functions; 7 fixed and 1 fuzz function.\n- Fuzz: 256 fixed-seed fee/amount/cap/recipient cases; 263 effective cases.\n- Deterministic replay: 2/2; normalized PASS digest \`${tests.normalizedPassOutputSha256}\`.\n- Harness runtime: ${harnessRuntime.length} bytes / \`${tests.isolatedCompile.harnessRuntimeSha256}\`.\n- Production commit: \`${commit}\`; primary executor SHA-256 \`${sourceRecords[0].sha256}\`.\n\nThe canonical repository profile was attempted but the pre-existing dependency tree is absent. The disclosed offline isolated compile imports the exact current production sources and supplies only minimal local dependency API shims; production source is commit-bound and the new harness is local-byte-bound, not full dependency/runtime equivalence. No network, RPC, fork, transaction, signing, broadcast, or production mutation occurred. Unrelated dirty files were not modified. No product documentation change is required because production behavior is unchanged.\n`);

  const inbox = {
    findingId: NAME,
    runId: raw.runId,
    agentId: raw.agentId,
    role: raw.role,
    status: CLASSIFICATION,
    classification: CLASSIFICATION,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    fork: false,
    summary: "Activation fee in finalization is state-bound to the stored recipient and paid from that user's amount; DonationBox activation is a separate bot-only function with atomic rollback.",
    artifacts: [RAW, TESTS, MANIFEST, REPORT, TEST, HANDOFF],
    nextAction: "None; reopen only if a permissionless finalizer/activation path or recipient substitution is introduced.",
  };
  write(INBOX, `${JSON.stringify(inbox, null, 2)}\n`);
  write(HANDOFF, `# Across HyperEVM activation-fee false premise Step 1 handoff\n\n- Classification: \`${CLASSIFICATION}\`; branch 0/5; gates 0/0/false; fork=false.\n- Permissionless objective: existing account fee 0; absent-account configured fee is deducted from stored user's amount; finalize DonationBox activation debit 0; stored recipient cannot be substituted.\n- Privileged plane: \`activateUserAccount\` is bot-only, debits exact configured fee + 1 conversion once, and existing-account repeat reverts before debit.\n- Atomicity: callback blocked; failed Core transfer rolls back finalized flag, debit, balances, and recorder state.\n- Tests: 8/8, fuzz 256, effective 263, deterministic replay 2/2; PASS digest \`${tests.normalizedPassOutputSha256}\`.\n- Harness runtime: ${harnessRuntime.length} bytes / \`${tests.isolatedCompile.harnessRuntimeSha256}\`.\n- Canonical profile dependency-blocked by absent pre-existing node_modules; disclosed isolated exact-source/minimal-shim run. No network/RPC/fork/signing/broadcast; unrelated dirty files untouched.\n`);

  const records = [SCANNER, VALIDATOR, TEST, ...SOURCES, RAW, TESTS, REPORT, INBOX, HANDOFF].map(record);
  const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  const manifest = {
    schemaVersion: 1,
    runId: raw.runId,
    classification: CLASSIFICATION,
    algorithm: "sha256",
    aggregateSha256,
    records,
    productionCommit: commit,
    productionSources: sourceRecords,
    localHarness: tests.isolatedCompile,
    tests: { passed: 8, failed: 0, fuzzCases: 256, effectiveCases: 263, replayCount: 2 },
    gates: raw.gates,
    activityScope: raw.activityScope,
  };
  write(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, runId: raw.runId, classification: CLASSIFICATION, tests: "8/8", fuzzCases: 256, effectiveCases: 263, replayCount: 2, normalizedPassOutputSha256: tests.normalizedPassOutputSha256, harnessRuntimeSha256: tests.isolatedCompile.harnessRuntimeSha256, records: records.length, aggregateSha256 })}\n`);
}

main();
