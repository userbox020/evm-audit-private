"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");

const NAME = "critical-across-forwarder-single-use-false-premise-step1";
const CLASSIFICATION = "CLOSED/FALSE-PREMISE/NO-BASE-FORWARDER/ADMIN-CREATION/NONREENTRANT-CEI/SINGLE-USE";
const ROOT = path.resolve(__dirname, "..");
const REPO = path.join(ROOT, "targets", "across-contracts");
const TEST = "targets/across-contracts/test/evm/foundry/local/ForwarderSingleUseInvariant.t.sol";
const SOURCE = "targets/across-contracts/contracts/chain-adapters/ForwarderBase.sol";
const RAW = `reports/raw/fast/${NAME}.json`;
const TESTS = `reports/raw/fast/${NAME}-tests.json`;
const REPORT = `reports/${NAME}.md`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const INBOX = `coordination/inbox/critical/2026-07-25-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-25-${NAME}-handoff.md`;
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/validate-${NAME}.js`;
const SEED = "0xac1055";

const slash = (value) => value.replace(/\\/g, "/");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative));
const json = (relative) => JSON.parse(read(relative));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const write = (relative, value) => {
  const output = path.join(ROOT, relative);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, value);
};
const fileRecord = (relative) => {
  const value = read(relative);
  return { path: relative, bytes: value.length, sha256: sha(value) };
};
const requireTrue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const run = (command, args, cwd) => {
  const result = cp.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FOUNDRY_PROFILE: "local-test" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
};

function writeIsolatedConfig() {
  const tmp = path.join(os.tmpdir(), "opencode", NAME);
  const deps = path.join(tmp, "contracts-upgradeable-v4");
  const testDir = path.join(tmp, "test");
  const configDir = path.join(tmp, "config");
  const out = path.join(tmp, "out");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(deps, "proxy", "utils"), { recursive: true });
  fs.mkdirSync(path.join(deps, "security"), { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  fs.writeFileSync(
    path.join(deps, "proxy", "utils", "Initializable.sol"),
    `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nabstract contract Initializable { uint8 private _initialized; bool private _initializing; modifier initializer() { require(!_initializing && _initialized == 0, "Initializable: already initialized"); _initialized = 1; _initializing = true; _; _initializing = false; } modifier onlyInitializing() { require(_initializing, "Initializable: contract is not initializing"); _; } function _disableInitializers() internal { require(!_initializing, "Initializable: contract is initializing"); _initialized = type(uint8).max; } }\n`
  );
  fs.writeFileSync(
    path.join(deps, "proxy", "utils", "UUPSUpgradeable.sol"),
    `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nimport { Initializable } from "./Initializable.sol";\nabstract contract UUPSUpgradeable is Initializable { bytes32 private constant SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1); function __UUPSUpgradeable_init() internal onlyInitializing {} function upgradeTo(address implementation) external { _authorizeUpgrade(implementation); bytes32 slot = SLOT; assembly { sstore(slot, implementation) } } function _authorizeUpgrade(address) internal virtual; }\n`
  );
  fs.writeFileSync(
    path.join(deps, "security", "ReentrancyGuardUpgradeable.sol"),
    `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nimport { Initializable } from "../proxy/utils/Initializable.sol";\nabstract contract ReentrancyGuardUpgradeable is Initializable { uint256 private _status; function __ReentrancyGuard_init() internal onlyInitializing { _status = 1; } modifier nonReentrant() { require(_status != 2, "ReentrancyGuard: reentrant call"); _status = 2; _; _status = 1; } }\n`
  );

  const isolatedTest = read(TEST).toString("utf8").replaceAll('"../../../../contracts/', '"repo-contracts/');
  fs.writeFileSync(path.join(testDir, "ForwarderSingleUseInvariant.t.sol"), isolatedTest);
  const config = `[profile.local-test]\nsrc = "contracts"\ntest = "${slash(testDir)}"\nlibs = []\ncache_path = "${slash(path.join(tmp, "cache"))}"\nout = "${slash(out)}"\nvia_ir = true\noptimizer_runs = 800\nsolc = "0.8.30"\nevm_version = "prague"\nrevert_strings = "default"\nremappings = [\n  "forge-std/=${slash(path.join(REPO, "lib", "forge-std", "src"))}/",\n  "repo-contracts/=${slash(path.join(REPO, "contracts"))}/",\n  "@openzeppelin/contracts-upgradeable-v4/=${slash(deps)}/"\n]\n`;
  const configPath = path.join(configDir, "foundry.toml");
  fs.writeFileSync(configPath, config);
  return { tmp, configPath, out };
}

function normalizedPasses(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("[PASS]"))
    .join("\n");
}

function main() {
  const sourceText = read(SOURCE).toString("utf8");
  for (const marker of [
    ") external payable override onlyAdmin {",
    "function executeRelayTokens(uint32 tokenRelayId) external payable nonReentrant",
    "if (tokenRelay.executed) revert TokenRelayExecuted();",
    "tokenRelay.executed = true;",
    "adapter.delegatecall(",
    "if (!success) revert RelayTokensFailed(tokenRelay.l2Token);",
  ]) requireTrue(sourceText.includes(marker), `source marker missing: ${marker}`);

  const commit = run("git", ["rev-parse", "HEAD"], REPO).trim();
  requireTrue(cp.spawnSync("git", ["diff", "--quiet", "--", "contracts/chain-adapters/ForwarderBase.sol"], { cwd: REPO }).status === 0, "production source is dirty");
  const dirty = run("git", ["status", "--short"], REPO).replace(/\s+$/, "").split(/\r?\n/).filter(Boolean);
  const deployed = json("targets/across-contracts/broadcast/deployed-addresses.json");
  const mainnet = deployed["1"] || deployed.mainnet || deployed;
  const findNamed = (node, name) => {
    if (!node || typeof node !== "object") return null;
    if (Object.prototype.hasOwnProperty.call(node, name)) return node[name];
    for (const value of Object.values(node)) {
      const found = findNamed(value, name);
      if (found) return found;
    }
    return null;
  };
  const baseAdapter = findNamed(mainnet, "Base_Adapter");
  requireTrue(baseAdapter && baseAdapter.address === "0x799BDC55d91864b14B2eD63A34DeF5d502AA897f", "Base_Adapter binding");
  const baseLegacy = json("targets/across-contracts/deployments/mainnet/Base_Adapter.json");
  const functions = baseLegacy.abi.filter((row) => row.type === "function");
  const abiNames = functions.map((row) => row.name);
  const relay = functions.find((row) => row.name === "relayTokens");
  requireTrue(relay && relay.inputs.length === 4, "Base_Adapter four-argument relayTokens ABI");
  requireTrue(!abiNames.includes("executeRelayTokens") && !abiNames.includes("tokenRelays"), "Base_Adapter is not Forwarder ABI");

  const sourceInheritors = [];
  const walkSources = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walkSources(absolute);
      else if (entry.name.endsWith(".sol")) {
        const text = fs.readFileSync(absolute, "utf8");
        for (const match of text.matchAll(/contract\s+(\w+)\s+is\s+ForwarderBase/g)) sourceInheritors.push(match[1]);
      }
    }
  };
  walkSources(path.join(REPO, "contracts"));
  sourceInheritors.sort();
  requireTrue(JSON.stringify(sourceInheritors) === JSON.stringify(["Arbitrum_Forwarder", "Ovm_Forwarder"]), "concrete ForwarderBase inheritors");
  const canonicalForwarderEntries = [];
  const collectForwarderKeys = (node, lineage = []) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (/Forwarder/i.test(key)) canonicalForwarderEntries.push([...lineage, key].join("."));
      collectForwarderKeys(value, [...lineage, key]);
    }
  };
  collectForwarderKeys(deployed);
  requireTrue(canonicalForwarderEntries.length === 0, "unexpected canonical Forwarder entry");
  const deploymentForwarders = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (/Forwarder.*\.json$/i.test(entry.name)) deploymentForwarders.push(slash(path.relative(REPO, absolute)));
    }
  };
  walk(path.join(REPO, "deployments"));
  requireTrue(deploymentForwarders.length === 0, "unexpected local Forwarder deployment artifact");

  const isolated = writeIsolatedConfig();
  const args = [
    "test", "--root", REPO, "--config-path", isolated.configPath, "--match-contract",
    "ForwarderSingleUseInvariantTest", "--fuzz-runs", "256", "--fuzz-seed", SEED, "--offline",
  ];
  const first = run("forge", args, REPO);
  const second = run("forge", args, REPO);
  const firstPasses = normalizedPasses(first);
  const secondPasses = normalizedPasses(second);
  requireTrue(firstPasses === secondPasses, "deterministic replay mismatch");
  requireTrue((firstPasses.match(/^\[PASS\]/gm) || []).length === 5, "test count");
  requireTrue(firstPasses.includes("runs: 256"), "fuzz count");

  const harnessArtifact = JSON.parse(
    fs.readFileSync(path.join(isolated.out, "ForwarderSingleUseInvariant.t.sol", "ForwarderSingleUseHarness.json"))
  );
  const harnessRuntime = Buffer.from(harnessArtifact.deployedBytecode.object.replace(/^0x/, ""), "hex");
  const testEvidence = {
    schemaVersion: 1,
    profile: "local-test",
    command: `FOUNDRY_PROFILE=local-test forge ${args.join(" ")}`,
    network: false,
    fork: false,
    seed: SEED,
    testsPassed: 5,
    testsFailed: 0,
    testsSkipped: 0,
    fixedTests: 4,
    fuzzTestFunctions: 1,
    fuzzCases: 256,
    effectiveCases: 260,
    replayCount: 2,
    deterministicReplay: true,
    normalizedPassOutputSha256: sha(Buffer.from(firstPasses)),
    normalizedPassOutput: firstPasses.split("\n"),
    exactRepositoryProfileAttempt: {
      passed: false,
      reason: "pre-existing node_modules dependency tree is absent; canonical scoped compile fails before test execution",
      missingExamples: ["@openzeppelin/contracts-v4", "@openzeppelin/contracts-upgradeable-v4", "@eth-optimism/contracts"],
    },
    isolatedCompile: {
      exactProductionSourceImported: true,
      minimalLocalDependencyShims: true,
      shimScope: ["Initializable", "UUPSUpgradeable", "ReentrancyGuardUpgradeable"],
      harnessRuntimeBytes: harnessRuntime.length,
      harnessRuntimeSha256: sha(harnessRuntime),
      testSource: fileRecord(TEST),
    },
  };
  write(TESTS, `${JSON.stringify(testEvidence, null, 2)}\n`);

  const sourceRecord = fileRecord(SOURCE);
  const raw = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId: `${NAME}-${commit.slice(0, 12)}-${sourceRecord.sha256.slice(0, 12)}`,
    agentId: "fixer-across-forwarder-step1-20260725",
    role: "critical-research",
    classification: CLASSIFICATION,
    pipeline: { branch: 0, total: 5 },
    gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false },
    productionBinding: { commit, source: sourceRecord, productionSourceModified: false },
    sourceSemantics: {
      creation: "onlyAdmin",
      execution: "public nonReentrant",
      checksEffectsInteractions: "executed=true before adapter delegatecall",
      rollback: "adapter revert reverts executed flag and balances",
      singleUse: "executed relay reverts TokenRelayExecuted",
    },
    baseArtifactBinding: {
      canonicalGeneratedName: "Base_Adapter",
      canonicalGeneratedAddress: baseAdapter.address,
      canonicalGeneratedBlock: baseAdapter.block_number,
      legacyAbiArtifact: fileRecord("targets/across-contracts/deployments/mainnet/Base_Adapter.json"),
      legacyArtifactAddress: baseLegacy.address,
      relayTokensInputCount: relay.inputs.length,
      forwarderSelectorsPresent: false,
      concreteSourceInheritors: sourceInheritors,
      baseNamedConcreteInheritor: false,
      canonicalForwarderEntries,
      localForwarderDeploymentArtifacts: deploymentForwarders,
      conclusionScope: "local source, ABI, canonical generated-address, and deployment artifacts only",
    },
    tests: testEvidence,
    dirtyTreeDisclosure: {
      dirty: true,
      entries: dirty,
      unrelatedEntriesUntouched: dirty.filter((row) => !row.endsWith("ForwarderSingleUseInvariant.t.sol")),
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

  write(REPORT, `# 🟢 CLOSED — Across Forwarder single-use false premise Step 1\n\n**Classification:** \`${CLASSIFICATION}\`  \n**Pipeline:** branch \`0/5\`; gates \`0/0/false\`; fork=false\n\n## Result\n\nThe hypothesized Base Forwarder route is a false premise in the local commit-bound package. The canonical generated Base entry is \`Base_Adapter\` at \`${baseAdapter.address}\`; its local ABI exposes the four-argument adapter \`relayTokens\` and no Forwarder relay queue/executor ABI. The only concrete local \`ForwarderBase\` inheritors are Arbitrum and OVM; no local Base-named concrete inheritor or Forwarder deployment artifact exists. This is a local-artifact conclusion, not an onchain query.\n\nExact \`ForwarderBase.sol\` at commit \`${commit}\` permits only admin relay creation, permits public execution, sets \`executed=true\` before adapter interaction, uses \`nonReentrant\`, and rolls all state/balance effects back if the adapter reverts. The new regression covers outsider append rejection, public exactly-once execution, WETH and adapter callbacks into both entrypoints, one transfer only, revert rollback, and fuzzed relay IDs/callback modes.\n\n## Tests\n\n- PASS: 5/5 test functions; 4 fixed and 1 fuzz function.\n- Fuzz: 256 fixed-seed cases; 260 effective cases.\n- Deterministic replay: 2/2 with normalized PASS digest \`${testEvidence.normalizedPassOutputSha256}\`.\n- Harness runtime: ${harnessRuntime.length} bytes, SHA-256 \`${testEvidence.isolatedCompile.harnessRuntimeSha256}\`.\n- Canonical repository profile was attempted but the pre-existing dependency tree is absent. An offline isolated compile imported the exact production source and used disclosed minimal local OpenZeppelin API shims; therefore the production source is commit-bound and the new harness is local-byte-bound, not a claim of full dependency/runtime equivalence.\n\n## Safety and workspace\n\nNo network, RPC, endpoint inventory, fork, transaction, signing, broadcast, or production mutation occurred. The repository was already dirty; all unrelated modified and untracked files were left untouched and are enumerated in the raw artifact. No product documentation update is required because this adds regression/audit evidence only and changes no production behavior.\n`);

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
    summary: "Local artifacts contain Base_Adapter, not a Base Forwarder; exact source and 256-case regression confirm admin-only creation, nonReentrant CEI, rollback, and single use.",
    artifacts: [RAW, TESTS, MANIFEST, REPORT, TEST, HANDOFF],
    nextAction: "None for Base Forwarder; reopen only on a new concrete Base Forwarder source/deployment artifact.",
  };
  write(INBOX, `${JSON.stringify(inbox, null, 2)}\n`);
  write(HANDOFF, `# Across Forwarder single-use false premise Step 1 handoff\n\n- Classification: \`${CLASSIFICATION}\`; branch 0/5; gates 0/0/false; fork=false.\n- Canonical local Base listing: \`Base_Adapter\` ${baseAdapter.address}; four-argument adapter ABI, no Forwarder selectors.\n- Concrete local ForwarderBase inheritors: Arbitrum and OVM only; local Forwarder deployment artifacts: 0.\n- Tests: 5/5, fuzz 256, effective 260, deterministic replay 2/2; PASS digest \`${testEvidence.normalizedPassOutputSha256}\`.\n- Harness runtime: ${harnessRuntime.length} bytes / \`${testEvidence.isolatedCompile.harnessRuntimeSha256}\`.\n- Exact repository profile compile is dependency-blocked by the pre-existing absent node_modules tree; disclosed offline isolated compile imported exact production source with minimal API shims.\n- No network/RPC/fork/transaction/signing/broadcast; unrelated dirty files untouched.\n`);

  const records = [SCANNER, VALIDATOR, TEST, SOURCE, RAW, TESTS, REPORT, INBOX, HANDOFF].map(fileRecord);
  const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  const manifest = {
    schemaVersion: 1,
    runId: raw.runId,
    classification: CLASSIFICATION,
    algorithm: "sha256",
    aggregateSha256,
    records,
    productionCommit: commit,
    productionSource: sourceRecord,
    localHarness: testEvidence.isolatedCompile,
    tests: { passed: 5, failed: 0, fuzzCases: 256, effectiveCases: 260, replayCount: 2 },
    gates: raw.gates,
    activityScope: raw.activityScope,
  };
  write(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, runId: raw.runId, classification: CLASSIFICATION, tests: "5/5", fuzzCases: 256, effectiveCases: 260, replayCount: 2, normalizedPassOutputSha256: testEvidence.normalizedPassOutputSha256, harnessRuntimeSha256: testEvidence.isolatedCompile.harnessRuntimeSha256, records: records.length, aggregateSha256 })}\n`);
}

main();
