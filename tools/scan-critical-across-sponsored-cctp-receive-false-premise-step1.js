"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");

const NAME = "critical-across-sponsored-cctp-receive-false-premise-step1";
const CLASSIFICATION = "CLOSED/FALSE-PERMISSIONLESS-PREMISE/PRIVILEGED-EMERGENCY/CCTP-AND-SIGNATURE-BOUND-NORMAL/PREEXISTING-BALANCE-PROTECTED";
const ROOT = path.resolve(__dirname, "..");
const REPO = path.join(ROOT, "targets", "across-contracts");
const TEST = "targets/across-contracts/test/evm/foundry/local/SponsoredCCTPReceiveInvariant.t.sol";
const SOURCES = [
  "targets/across-contracts/contracts/periphery/mintburn/sponsored-cctp/SponsoredCCTPDstPeriphery.sol",
  "targets/across-contracts/contracts/libraries/SponsoredCCTPQuoteLib.sol",
  "targets/across-contracts/contracts/periphery/mintburn/BaseModuleHandler.sol",
  "targets/across-contracts/contracts/periphery/mintburn/AuthorizedFundedFlow.sol",
  "targets/across-contracts/contracts/periphery/mintburn/ArbitraryEVMFlowExecutor.sol",
  "targets/across-contracts/contracts/handlers/MulticallHandler.sol",
  "targets/across-contracts/contracts/interfaces/SponsoredCCTPInterface.sol",
  "targets/across-contracts/contracts/external/interfaces/CCTPInterfaces.sol",
];
const RAW = `reports/raw/fast/${NAME}.json`;
const TESTS = `reports/raw/fast/${NAME}-tests.json`;
const REPORT = `reports/${NAME}.md`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const INBOX = `coordination/inbox/critical/2026-07-26-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-26-${NAME}-handoff.md`;
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/validate-${NAME}.js`;
const SEED = "0xaccc7a";

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
const check = (condition, message) => { if (!condition) throw new Error(message); };
const run = (command, args, cwd) => {
  const result = cp.spawnSync(command, args, {
    cwd, encoding: "utf8", env: { ...process.env, FOUNDRY_PROFILE: "local-test" }, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
};

const SHIMS = {
  "oz5/token/ERC20/IERC20.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ninterface IERC20 { event Transfer(address indexed from,address indexed to,uint256 value); event Approval(address indexed owner,address indexed spender,uint256 value); function totalSupply() external view returns(uint256); function balanceOf(address) external view returns(uint256); function transfer(address,uint256) external returns(bool); function allowance(address,address) external view returns(uint256); function approve(address,uint256) external returns(bool); function transferFrom(address,address,uint256) external returns(bool); }\n`,
  "oz5/token/ERC20/extensions/IERC20Metadata.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nimport {IERC20} from "../IERC20.sol";\ninterface IERC20Metadata is IERC20 { function name() external view returns(string memory); function symbol() external view returns(string memory); function decimals() external view returns(uint8); }\n`,
  "oz5/token/ERC20/utils/SafeERC20.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nimport {IERC20} from "../IERC20.sol";\nlibrary SafeERC20 { function safeTransfer(IERC20 token,address to,uint256 amount) internal { require(token.transfer(to,amount),"SafeERC20: transfer failed"); } function forceApprove(IERC20 token,address spender,uint256 amount) internal { require(token.approve(spender,amount),"SafeERC20: approve failed"); } }\n`,
  "oz5/access/AccessControl.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nabstract contract AccessControl { bytes32 public constant DEFAULT_ADMIN_ROLE=0x00; mapping(bytes32=>mapping(address=>bool)) private _roles; mapping(bytes32=>bytes32) private _admins; modifier onlyRole(bytes32 role){require(_roles[role][msg.sender],"AccessControl: unauthorized");_;} function hasRole(bytes32 role,address account) public view returns(bool){return _roles[role][account];} function getRoleAdmin(bytes32 role) public view returns(bytes32){return _admins[role];} function grantRole(bytes32 role,address account) public onlyRole(getRoleAdmin(role)){_grantRole(role,account);} function _grantRole(bytes32 role,address account) internal {_roles[role][account]=true;} function _setRoleAdmin(bytes32 role,bytes32 admin) internal {_admins[role]=admin;} }\n`,
  "oz5/utils/Bytes.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nlibrary Bytes { function slice(bytes memory data,uint256 start,uint256 end) internal pure returns(bytes memory out){require(start<=end&&end<=data.length,"Bytes: out of bounds");out=new bytes(end-start);for(uint256 i;i<out.length;++i)out[i]=data[start+i];} }\n`,
  "oz5up/access/AccessControlUpgradeable.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nabstract contract AccessControlUpgradeable { bytes32 public constant DEFAULT_ADMIN_ROLE=0x00; mapping(bytes32=>mapping(address=>bool)) private _roles; mapping(bytes32=>bytes32) private _admins; modifier onlyRole(bytes32 role){require(_roles[role][msg.sender],"AccessControl: unauthorized");_;} function hasRole(bytes32 role,address account) public view returns(bool){return _roles[role][account];} function getRoleAdmin(bytes32 role) public view returns(bytes32){return _admins[role];} function grantRole(bytes32 role,address account) public onlyRole(getRoleAdmin(role)){_grantRole(role,account);} function _grantRole(bytes32 role,address account) internal {_roles[role][account]=true;} function _setRoleAdmin(bytes32 role,bytes32 admin) internal {_admins[role]=admin;} }\n`,
  "oz4/token/ERC20/IERC20.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ninterface IERC20 { event Transfer(address indexed from,address indexed to,uint256 value); event Approval(address indexed owner,address indexed spender,uint256 value); function totalSupply() external view returns(uint256); function balanceOf(address) external view returns(uint256); function transfer(address,uint256) external returns(bool); function allowance(address,address) external view returns(uint256); function approve(address,uint256) external returns(bool); function transferFrom(address,address,uint256) external returns(bool); }\n`,
  "oz4/token/ERC20/utils/SafeERC20.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nimport {IERC20} from "../IERC20.sol";\nlibrary SafeERC20 { function safeTransfer(IERC20 token,address to,uint256 amount) internal { require(token.transfer(to,amount),"SafeERC20: transfer failed"); } function forceApprove(IERC20 token,address spender,uint256 amount) internal { require(token.approve(spender,amount),"SafeERC20: approve failed"); } }\n`,
  "oz4/security/ReentrancyGuard.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nabstract contract ReentrancyGuard { uint256 private _status=1; modifier nonReentrant(){require(_status!=2,"ReentrancyGuard: reentrant call");_status=2;_;_status=1;} }\n`,
  "oz4/utils/Address.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nlibrary Address { function sendValue(address payable recipient,uint256 amount) internal { (bool ok,)=recipient.call{value:amount}(""); require(ok,"Address: unable to send value"); } }\n`,
  "oz4/utils/math/SafeCast.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nlibrary SafeCast { function toUint64(uint256 value) internal pure returns(uint64){require(value<=type(uint64).max,"SafeCast overflow");return uint64(value);} }\n`,
  "oz4/utils/cryptography/SignatureChecker.sol": `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nlibrary SignatureChecker { function isValidSignatureNow(address signer,bytes32 hash,bytes memory signature) internal view returns(bool){ if(signer.code.length!=0||signature.length!=65)return false; bytes32 r;bytes32 s;uint8 v;assembly{r:=mload(add(signature,32)) s:=mload(add(signature,64)) v:=byte(0,mload(add(signature,96)))} return ecrecover(hash,v,r,s)==signer; } }\n`,
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
  fs.writeFileSync(
    path.join(testDir, "SponsoredCCTPReceiveInvariant.t.sol"),
    read(TEST).toString("utf8").replaceAll('"../../../../contracts/', '"repo-contracts/')
  );
  const configDir = path.join(tmp, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const config = `[profile.local-test]\nsrc = "contracts"\ntest = "${slash(testDir)}"\nlibs = []\ncache_path = "${slash(path.join(tmp, "cache"))}"\nout = "${slash(out)}"\nvia_ir = true\noptimizer_runs = 300\nsolc = "0.8.30"\nevm_version = "prague"\nrevert_strings = "default"\nremappings = [\n  "forge-std/=${slash(path.join(REPO, "lib", "forge-std", "src"))}/",\n  "repo-contracts/=${slash(path.join(REPO, "contracts"))}/",\n  "@openzeppelin/contracts-upgradeable/=${slash(path.join(deps, "oz5up"))}/",\n  "@openzeppelin/contracts-v4/=${slash(path.join(deps, "oz4"))}/",\n  "@openzeppelin/contracts/=${slash(path.join(deps, "oz5"))}/"\n]\n`;
  const configPath = path.join(configDir, "foundry.toml");
  fs.writeFileSync(configPath, config);
  return { out, configPath };
}

const passLines = (output) => output.split(/\r?\n/).filter((line) => line.startsWith("[PASS]")).join("\n");

function main() {
  const source = read(SOURCES[0]).toString("utf8");
  const markers = [
    "external nonReentrant onlyRole(PERMISSIONED_BOT_ROLE)",
    "uint256 mintedAmount = baseBalAfter - baseBalBefore;",
    "safeTransfer(finalRecipient, mintedAmount)",
    "external nonReentrant authorizeFundedFlow",
    "if (baseBalAfter - baseBalBefore != amountAfterFees)",
    "_validateQuoteOrRevert(quote, signature)",
    "if ($.usedNonces[quote.nonce])",
  ];
  for (const marker of markers) check(source.includes(marker), `source marker missing: ${marker}`);
  const quoteLib = read(SOURCES[1]).toString("utf8");
  check(quoteLib.includes("SignatureChecker.isValidSignatureNow(signer, typedDataHash, signature)"), "signature source marker");

  const commit = run("git", ["rev-parse", "HEAD"], REPO).trim();
  for (const productionSource of SOURCES) {
    const relative = productionSource.replace("targets/across-contracts/", "");
    check(cp.spawnSync("git", ["diff", "--quiet", "--", relative], { cwd: REPO }).status === 0, `dirty production source: ${relative}`);
  }
  const dirty = run("git", ["status", "--short"], REPO).replace(/\s+$/, "").split(/\r?\n/).filter(Boolean);

  const isolated = isolatedConfig();
  const args = [
    "test", "--root", REPO, "--config-path", isolated.configPath, "--match-contract",
    "SponsoredCCTPReceiveInvariantTest", "--fuzz-runs", "256", "--fuzz-seed", SEED, "--offline",
  ];
  const first = run("forge", args, REPO);
  const second = run("forge", args, REPO);
  const normalized = passLines(first);
  check(normalized === passLines(second), "deterministic replay");
  check((normalized.match(/^\[PASS\]/gm) || []).length === 13, "test count");
  check(normalized.includes("runs: 256"), "fuzz runs");
  const harnessArtifact = JSON.parse(
    fs.readFileSync(path.join(isolated.out, "SponsoredCCTPReceiveInvariant.t.sol", "SponsoredCCTPReceiveInvariantTest.json"))
  );
  const harnessRuntime = Buffer.from(harnessArtifact.deployedBytecode.object.replace(/^0x/, ""), "hex");

  const tests = {
    schemaVersion: 1,
    profile: "local-test",
    command: `FOUNDRY_PROFILE=local-test forge ${args.join(" ")}`,
    seed: SEED,
    network: false,
    fork: false,
    testsPassed: 13,
    testsFailed: 0,
    testsSkipped: 0,
    fixedTests: 12,
    fuzzTestFunctions: 1,
    fuzzCases: 256,
    effectiveCases: 268,
    replayCount: 2,
    deterministicReplay: true,
    normalizedPassOutputSha256: sha(Buffer.from(normalized)),
    normalizedPassOutput: normalized.split("\n"),
    exactRepositoryProfileAttempt: {
      passed: false,
      reason: "pre-existing node_modules dependency tree is absent; canonical local-profile compilation is dependency-blocked before scoped execution",
      missingExamples: ["@openzeppelin/contracts", "@openzeppelin/contracts-v4", "@openzeppelin/contracts-upgradeable"],
    },
    isolatedCompile: {
      exactProductionSourcesImported: true,
      minimalLocalDependencyShims: true,
      shimScope: ["IERC20", "IERC20Metadata", "SafeERC20", "AccessControl", "AccessControlUpgradeable", "Bytes", "ReentrancyGuard", "Address", "SafeCast", "SignatureChecker EOA-only"],
      limitations: "Shims reproduce only APIs exercised by this local regression. SignatureChecker is EOA-only; ERC-1271 and full OpenZeppelin runtime equivalence are not claimed.",
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
    agentId: "fixer-across-sponsored-cctp-20260725",
    role: "critical-research",
    classification: CLASSIFICATION,
    pipeline: { branch: 0, total: 5 },
    gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false },
    productionBinding: { commit, sources: sourceRecords, productionSourcesModified: false },
    conclusions: {
      emergency: {
        permissionless: false,
        requiredRole: "PERMISSIONED_BOT_ROLE",
        forwardingBasis: "post-receive baseToken balance minus pre-receive baseToken balance",
        preexistingBalanceForwarded: false,
        transmitterFalseBehavior: "return without forwarding",
      },
      normal: {
        submissionPermissionless: true,
        executionBoundBy: ["CCTP message and attestation", "configured TokenMessenger and TokenMinter link", "signed quote", "exact amount-fee mint delta", "used quote nonce"],
        underMintAccepted: false,
        overMintAccepted: false,
        replayAccepted: false,
      },
      operationalStranding: "After a successful CCTP mint, malformed hook data or invalid mintRecipient returns without forwarding; only newly minted funds join custody and prior funds are not redirected.",
      callbacks: "normal, emergency, and direct callback attempts are blocked by nonReentrant with no duplicate forwarding",
      profit: 0,
    },
    tests,
    dirtyTreeDisclosure: {
      dirty: true,
      entries: dirty,
      unrelatedEntriesUntouched: dirty.filter((row) => !row.endsWith("SponsoredCCTPReceiveInvariant.t.sol")),
    },
    activityScope: {
      offlineOnly: true, endpointInventoryReads: 0, rpcCalls: 0, httpRequests: 0, forkCreated: false,
      liveCalls: 0, transactions: 0, signing: false, broadcasts: 0, productionMutation: false,
    },
  };
  write(RAW, `${JSON.stringify(raw, null, 2)}\n`);

  write(REPORT, `# 🟢 CLOSED — Across Sponsored CCTP receive false-permissionless premise Step 1\n\n**Classification:** \`${CLASSIFICATION}\`  \n**Pipeline:** branch \`0/5\`; gates \`0/0/false\`; fork=false\n\n## Result\n\nThe emergency entrypoint is a privileged recovery path, not a permissionless receive route: \`PERMISSIONED_BOT_ROLE\` is checked under \`nonReentrant\`. On CCTP success it forwards only the exact post-call \`baseToken\` balance delta; prior custody is excluded. A false transmitter return exits without forwarding.\n\nThe normal entrypoint permits arbitrary transaction submission, but execution is jointly bound to a valid CCTP message/attestation, configured TokenMessenger and remote-token link, exact \`amount - feeExecuted\` mint delta, signer-authorized quote fields, and an unused quote nonce. Independent routing, token, recipient, amount, fee, and action mutations fail without the corresponding fresh CCTP and signature validity. Under- and over-mint fail even with ample prior custody. CCTP transport replay and local quote-nonce replay are both blocked.\n\nMalformed hook data or an invalid mint recipient can be discovered only after a successful CCTP mint. The function intentionally returns, leaving the newly minted amount stranded in operational custody. Tests distinguish this availability/recovery condition from redirection: prior funds are not forwarded, and neither prior nor new funds are redirected to the malformed recipient. Callback attempts into normal, emergency, and direct paths fail under the shared reentrancy lock with no duplicate forward.\n\n## Tests and bindings\n\n- PASS: 13/13 functions; 12 fixed and 1 fuzz function.\n- Fuzz: 256 fixed-seed prior-balance/mint/fee/malformed-data cases; 268 effective cases.\n- Deterministic replay: 2/2; normalized PASS digest \`${tests.normalizedPassOutputSha256}\`.\n- Harness runtime: ${harnessRuntime.length} bytes / \`${tests.isolatedCompile.harnessRuntimeSha256}\`.\n- Production commit: \`${commit}\`; primary source SHA-256 \`${sourceRecords[0].sha256}\`.\n\nThe canonical repository profile was attempted but the pre-existing dependency tree is absent. The disclosed offline isolated compile imports exact current production sources and supplies only minimal local API shims. The production source is commit-bound and the new harness is local-byte-bound; full OpenZeppelin runtime equivalence and ERC-1271 behavior are not claimed. No network, RPC, fork, transaction, signing, broadcast, or production mutation occurred. Unrelated dirty files were not modified. No product documentation update is required because production behavior is unchanged.\n`);

  const inbox = {
    findingId: NAME, runId: raw.runId, agentId: raw.agentId, role: raw.role, status: CLASSIFICATION,
    classification: CLASSIFICATION, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false,
    summary: "Emergency receive is bot-only and delta-forwarding; normal submission is permissionless but CCTP, exact mint-delta, signature, and nonce bound, with malformed post-mint funds operationally stranded rather than prior custody redirected.",
    artifacts: [RAW, TESTS, MANIFEST, REPORT, TEST, HANDOFF],
    nextAction: "None; operationally recover malformed post-mint custody through the privileged process and reopen only on changed authorization, mint-delta, signature, or nonce semantics.",
  };
  write(INBOX, `${JSON.stringify(inbox, null, 2)}\n`);
  write(HANDOFF, `# Across Sponsored CCTP receive false-permissionless premise Step 1 handoff\n\n- Classification: \`${CLASSIFICATION}\`; branch 0/5; gates 0/0/false; fork=false.\n- Emergency: privileged bot-only path; forwards only CCTP-produced baseToken delta; false return forwards zero; prior custody excluded.\n- Normal: caller is permissionless, execution is CCTP/TokenMessenger/token-link/exact-delta/signature/nonce bound; independent routing/token/recipient/amount/fee/action mutation coverage retained.\n- Malformed post-mint behavior: new funds remain in operational custody; no prior-fund or malformed-recipient redirection.\n- Replay and callbacks: CCTP/local nonce replay blocked; normal/emergency/direct callbacks produce no duplicate forward.\n- Tests: 13/13, fuzz 256, effective 268, deterministic replay 2/2; PASS digest \`${tests.normalizedPassOutputSha256}\`.\n- Harness: ${harnessRuntime.length} bytes / \`${tests.isolatedCompile.harnessRuntimeSha256}\`; exact production source commit \`${commit}\`. Isolated shims are API-scoped and EOA-signature-only, not full dependency/runtime equivalence.\n- Offline only: no endpoint inventory, RPC, HTTP, fork, transaction, live signing, broadcast, or production mutation; unrelated dirty files untouched.\n`);

  const records = [SCANNER, VALIDATOR, TEST, ...SOURCES, RAW, TESTS, REPORT, INBOX, HANDOFF].map(record);
  const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  const manifest = {
    schemaVersion: 1, runId: raw.runId, classification: CLASSIFICATION, algorithm: "sha256", aggregateSha256,
    records, productionCommit: commit, productionSources: sourceRecords, localHarness: tests.isolatedCompile,
    tests: { passed: 13, failed: 0, fuzzCases: 256, effectiveCases: 268, replayCount: 2 },
    gates: raw.gates, activityScope: raw.activityScope,
  };
  write(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, runId: raw.runId, classification: CLASSIFICATION, tests: "13/13", fuzzCases: 256, effectiveCases: 268, replayCount: 2, normalizedPassOutputSha256: tests.normalizedPassOutputSha256, harnessRuntimeSha256: tests.isolatedCompile.harnessRuntimeSha256, records: records.length, aggregateSha256 })}\n`);
}

main();
