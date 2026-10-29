#!/usr/bin/env node
"use strict";

// Bounded local-only exact-source defensive analysis. This runner refuses RPC,
// endpoint inventory, web, fork, broadcast, live calls, signing, and economics.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cash-v3");
const NAME = "critical-etherfi-debt-manager-share-differential";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const SOL_TEST = "targets/cash-v3/test/critical/DebtManagerShareDonationDifferential.t.sol";
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-23-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-23-${NAME}-handoff.md`;
const SELECTION = "coordination/inbox/critical/2026-07-23-critical-etherfi-debt-manager-share-accounting-selection.json";
const SOURCE_COMMIT = "e05bda2be27a6a606f3f1b8ff0d0791032fd0ff8";
const REVISION = "debt-manager-share-differential-local-exact-source-r1";
const AGENT = "critical-etherfi-debt-manager-share-diff-20260723";
const FUZZ_RUNS = 512;
const FUZZ_SEED = "0xd3b7a2026072300000000000000000000000000000000000000000000000001";
const SOURCE_FILES = [
  "src/debt-manager/DebtManagerCore.sol",
  "src/debt-manager/DebtManagerStorageContract.sol",
  "src/interfaces/IDebtManager.sol",
  "src/interfaces/IEtherFiDataProvider.sol",
  "src/interfaces/ICashLens.sol",
  "src/interfaces/ICashModule.sol",
  "src/interfaces/IPriceProvider.sol",
  "src/utils/UpgradeableProxy.sol",
  "foundry.toml",
  "remappings.txt",
];

const abs = (x) => path.join(ROOT, x);
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const hashFile = (rel) => { const b = fs.readFileSync(abs(rel)); return { path: rel, bytes: b.length, sha256: sha(b) }; };
const sanitize = (x) => String(x || "").replace(/https?:\/\/\S+/gi, "[redacted]");
const asString = (x) => x.toString(10);

function writeOwned(rel, text) {
  if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused ${rel}`);
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text, "utf8");
}

function git(args) {
  const r = spawnSync("git", args, { cwd: TARGET, encoding: "utf8", timeout: 180_000, maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr || "").slice(-1200)}`);
  return r.stdout;
}

const sourceAt = (rel) => git(["show", `${SOURCE_COMMIT}:${rel}`]);
const gitBlob = (rel) => git(["rev-parse", `${SOURCE_COMMIT}:${rel}`]).trim();

function unlinkLibraries(work) {
  const lib = path.join(work, "lib");
  if (!fs.existsSync(lib)) return;
  for (const name of fs.readdirSync(lib)) {
    const p = path.join(lib, name);
    try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch {}
  }
}

function cleanup(temp, work) {
  unlinkLibraries(work);
  try { git(["worktree", "remove", "--force", work]); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
}

function prepareWorktree() {
  const temp = path.join(os.tmpdir(), "opencode", "etherfi-debt-manager-share-differential");
  const work = path.join(temp, "source");
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  git(["worktree", "add", "--detach", work, SOURCE_COMMIT]);
  try {
    const sourceLib = path.join(TARGET, "lib");
    const destLib = path.join(work, "lib");
    for (const name of fs.readdirSync(sourceLib)) {
      const dst = path.join(destLib, name);
      fs.rmSync(dst, { recursive: true, force: true });
      fs.symlinkSync(path.join(sourceLib, name), dst, "junction");
    }
    const dst = path.join(work, "test", "critical", path.basename(SOL_TEST));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(abs(SOL_TEST), dst);
    return { temp, work, out: path.join(temp, "out"), cache: path.join(temp, "cache") };
  } catch (e) {
    cleanup(temp, work);
    throw e;
  }
}

function forge(work, args, timeout = 1_200_000) {
  const r = spawnSync("forge", args, { cwd: work, encoding: "utf8", timeout, maxBuffer: 256 * 1024 * 1024 });
  const output = `${r.stdout || ""}\n${r.stderr || ""}`;
  return { status: r.status, timedOut: Boolean(r.error?.code === "ETIMEDOUT"), output, outputBytes: Buffer.byteLength(output), outputSha256: sha(output) };
}

function passRows(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\[PASS\]\s+([^\s(]+)(?:\([^)]*\))?(?:\s+\(runs:\s*(\d+),[^)]*\))?/);
    if (m) rows.push({ name: m[1], fuzzRuns: m[2] ? Number(m[2]) : 1 });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function testFunctions(source) {
  return [...source.matchAll(/function\s+(test(?:Fuzz)?_[A-Za-z0-9_]+)\s*\(/g)].map((x) => x[1]).sort();
}

function ceilDiv(a, b) { return a === 0n ? 0n : (a - 1n) / b + 1n; }
function preview(amount, shares, assets) { return shares === 0n ? amount : amount * shares / assets; }
function minimalZeroDonation(initialShares, victimAmount) { return initialShares * (victimAmount - 1n) + 1n; }
function simulate(initial, donation, victim) {
  const victimShares = preview(victim, initial, initial + donation);
  let assets = initial + donation + victim;
  let shares = initial + victimShares;
  const attackerOut = initial * assets / shares;
  const attackerBurn = ceilDiv(attackerOut * shares, assets);
  assets -= attackerOut;
  shares -= attackerBurn;
  const victimOut = victimShares === 0n ? 0n : victimShares * assets / shares;
  return {
    victimShares,
    attackerOut,
    victimOut,
    attackerNet: attackerOut - initial - donation,
    victimNet: victimOut - victim,
    residualAssets: assets - victimOut,
  };
}

function boundedModel() {
  const genericRows = [];
  let maximum = null;
  for (const initial of [1n, 2n, 10n, 100n, 1000n]) {
    for (let victim = 1n; victim <= 1000n; victim++) {
      const boundary = minimalZeroDonation(initial, victim);
      for (const donation of [0n, boundary === 0n ? 0n : boundary - 1n, boundary]) {
        const row = { initial, victim, donation, ...simulate(initial, donation, victim) };
        genericRows.push(row);
        if (!maximum || row.attackerNet > maximum.attackerNet) maximum = row;
      }
    }
  }
  const cap = 1_000_000_000_000n;
  const maxAtCap = (initial) => {
    const victim = (cap - 1n) / initial;
    const donation = minimalZeroDonation(initial, victim);
    return { initial, capitalCap: cap, victim, donation, attackerCapital: initial + donation, attackerNet: victim, profitToCapitalNumerator: victim, profitToCapitalDenominator: initial + donation };
  };
  const genericCap = maxAtCap(1n);
  const productionLike = maxAtCap(10_000_000n);
  const serialize = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" ? asString(v) : v]));
  return {
    exactFormula: {
      victimShares: "q = floor(v*s/(s+d))",
      zeroShares: "q=0 iff v*s < s+d",
      minimalDonationForZeroShares: "d_min = s*(v-1)+1 for integer raw units and v>=1",
      soleIncumbentNetAtZeroShares: "attackerNet = v; attackerCapital = s+d_min = s*v+1",
      capitalEfficiencyAtBoundary: "attackerNet/attackerCapital = v/(s*v+1), asymptotically 1/s",
    },
    enumeratedDomain: { initialShares: ["1", "2", "10", "100", "1000"], victimAmountInclusive: ["1", "1000"], donationsPerPair: ["0", "d_min-1", "d_min"], rows: genericRows.length },
    maximumEnumeratedNet: serialize(maximum),
    boundedCapitalScenarios: { genericMinSharesOne: serialize(genericCap), sixDecimalMinSharesTenTokens: serialize(productionLike) },
    practicalInterpretation: "A bounded positive sole-incumbent source sequence exists. With minShares=10,000,000 raw and attacker capital capped at 1,000,000,000,000 raw, the maximum zero-share victim/net is 99,999 raw; no current deployed configuration, victim order flow, atomic funding, or practical cycle is established.",
  };
}

function matrix() {
  return [
    { id: "FIRST", invariant: "first supplier receives one-for-one shares", tests: ["test_firstSupplierReceivesOneForOneShares"] },
    { id: "DONATION", invariant: "unsolicited balance must not silently change mint denominator", tests: ["test_directDonationIncreasesDenominatorWithoutMintingShares", "test_positiveRebaseIsCountedLikeDonation"] },
    { id: "BOUNDARY", invariant: "zero-share boundary and minimal donation formula", tests: ["test_boundaryDonationMinusOneMintsExactlyOneShare", "test_minimalBoundaryDonationMintsZeroAndIncumbentRealizesVictimAmount", "testFuzz_zeroShareBoundaryFormulaAndExactNet", "testFuzz_boundaryMinusOneMintsOneShare"] },
    { id: "REFERENCE", invariant: "safe reference requires nonzero and caller minimum shares", tests: ["test_safeReferenceRejectsZeroAndCallerMinimum", "test_zeroAmountSupplySucceedsInSourceButSafeReferenceRejects"] },
    { id: "REALIZATION", invariant: "separate donation capital from exact incumbent net", tests: ["test_partialThenFullWithdrawalRealizesSameZeroShareProfit", "test_supplyOnBehalfCanAssignPayerAssetsToZeroShareBeneficiary"] },
    { id: "REPEAT", invariant: "repeated zero-share victims do not compound unaccounted loss", tests: ["test_repeatedZeroShareVictimsIncreaseIncumbentNetLinearly"] },
    { id: "CONCENTRATION", invariant: "multiple incumbents expose donation socialization and concentration precondition", tests: ["test_multipleIncumbentsMakeDonorUnprofitableAndSplitVictimLoss"] },
    { id: "CONSERVATION", invariant: "all raw assets and participant net deltas conserve", tests: ["test_nonzeroVictimSharesAllWithdrawalsConserveRawAssets", "testFuzz_allWithdrawalsConserveAndNetSumsToZero"] },
    { id: "DEBT-INTEREST", invariant: "borrowed principal and accrued debt stay in the exact denominator", tests: ["test_realBorrowKeepsPrincipalInAccountedAssets", "test_interestIndexChangesMintDenominatorAndRepayRestoresLiquidity"] },
    { id: "TOKEN-SEMANTICS", invariant: "nominal supply credit equals actual received assets for supported tokens", tests: ["test_feeOnTransferSupportCreditsNominalNotBalanceDelta"] },
    { id: "CALLBACK", invariant: "token callback cannot reenter share mint after effects", tests: ["test_transferFromCallbackCannotReenterSupply"] },
    { id: "ARITHMETIC", invariant: "withdraw and full-precision arithmetic do not overflow or underflow", tests: ["test_overWithdrawalRevertsWithoutShareUnderflow", "test_extremeValuesUseFullPrecisionWithoutOverflow", "testFuzz_extremeMulDivRangeMatchesReference"] },
  ].map((x) => ({ ...x, result: "PASS" }));
}

function main() {
  const generatedAt = new Date().toISOString();
  const scannerHash = hashFile(SCANNER).sha256;
  const selection = JSON.parse(fs.readFileSync(abs(SELECTION), "utf8"));
  if (selection.selectedSurface?.name !== "debt-manager-supplier-share-donation-and-zero-share-rounding") throw new Error("selection mismatch");
  if (git(["cat-file", "-t", SOURCE_COMMIT]).trim() !== "commit") throw new Error("source commit unavailable");

  const sources = SOURCE_FILES.map((file) => {
    const text = sourceAt(file);
    return { path: `targets/cash-v3/${file}`, gitPath: file, gitBlob: gitBlob(file), bytes: Buffer.byteLength(text), sha256: sha(text) };
  });
  const core = sourceAt("src/debt-manager/DebtManagerCore.sol");
  const storage = sourceAt("src/debt-manager/DebtManagerStorageContract.sol");
  const exactFacts = {
    permissionlessSupply: core.includes("function supply(address user, address borrowToken, uint256 amount) external whenNotPaused nonReentrant"),
    supplyRoundsSharesDown: core.includes("amount.mulDiv($.borrowTokenConfig[borrowToken].totalSharesOfBorrowTokens, _getTotalBorrowTokenAmount(borrowToken), Math.Rounding.Floor)"),
    sourceHasNoSupplyZeroShareRevert: !core.slice(core.indexOf("function supply("), core.indexOf("function withdrawBorrowToken(")).includes("SharesCannotBeZero"),
    aggregateNotUserMinimumCheck: core.includes("totalSharesOfBorrowTokens < $.borrowTokenConfig[borrowToken].minShares"),
    transferOccursAfterShareEffects: core.indexOf("$.sharesOfBorrowTokens[user][borrowToken] += shares") < core.indexOf("IERC20(borrowToken).safeTransferFrom(msg.sender, address(this), amount)"),
    withdrawalRoundsBurnUp: core.includes("Math.Rounding.Ceil"),
    unsolicitedBalanceIncluded: storage.includes("convertUsdToCollateralToken(borrowToken, totalBorrowingAmount(borrowToken)) + IERC20(borrowToken).balanceOf(address(this))"),
  };
  if (Object.values(exactFacts).some((x) => x !== true)) throw new Error("exact source fact mismatch");

  const sol = fs.readFileSync(abs(SOL_TEST), "utf8");
  if (/create(?:Select)?Fork|fork-url|rpc_endpoints|graphql_endpoints|eth_call|broadcast|startBroadcast|vm\.env|https?:\/\//.test(sol)) throw new Error("forbidden external primitive in harness");
  const functions = testFunctions(sol);
  const invariantMatrix = matrix();
  const required = [...new Set(invariantMatrix.flatMap((x) => x.tests))];
  const missing = required.filter((x) => !functions.includes(x));
  if (missing.length) throw new Error(`matrix tests missing: ${missing.join(",")}`);

  const work = prepareWorktree();
  let build, first, replay;
  try {
    build = forge(work.work, ["build", "--root", work.work, "--out", work.out, "--cache-path", work.cache, "--no-cache", "--offline"]);
    if (build.status !== 0) throw new Error(`offline build failed: ${sanitize(build.output.slice(-8000))}`);
    const args = ["test", "--root", work.work, "--out", work.out, "--cache-path", work.cache, "--match-path", `test/critical/${path.basename(SOL_TEST)}`, "--fuzz-runs", String(FUZZ_RUNS), "--fuzz-seed", FUZZ_SEED, "--no-cache", "--offline", "-vv"];
    first = forge(work.work, args);
    if (first.status !== 0) throw new Error(`first test failed: ${sanitize(first.output.slice(-12000))}`);
    replay = forge(work.work, args);
    if (replay.status !== 0) throw new Error(`replay test failed: ${sanitize(replay.output.slice(-12000))}`);
  } finally {
    cleanup(work.temp, work.work);
  }

  const firstRows = passRows(first.output);
  const replayRows = passRows(replay.output);
  if (JSON.stringify(firstRows) !== JSON.stringify(replayRows)) throw new Error("fixed-seed semantic replay mismatch");
  const names = firstRows.map((x) => x.name);
  if (functions.length !== names.length || functions.some((x) => !names.includes(x))) throw new Error(`test enumeration mismatch source=${functions.length} pass=${names.length}`);
  const fuzzRows = firstRows.filter((x) => x.name.startsWith("testFuzz_"));
  if (fuzzRows.length !== 4 || fuzzRows.some((x) => x.fuzzRuns !== FUZZ_RUNS)) throw new Error("fuzz count mismatch");
  const deterministicRows = firstRows.filter((x) => x.fuzzRuns === 1);
  const model = boundedModel();

  const classification = "WATCH/SOURCE-LEVEL PRIMITIVE CANDIDATE PENDING REVIEW/PERMISSIONLESS-ZERO-SHARE-DONATION/CAPITAL-AND-STATE-PRECONDITIONS-UNBOUND";
  const runId = `etherfi-debt-manager-share-differential-${SOURCE_COMMIT.slice(0, 12)}-${scannerHash.slice(0, 12)}`;
  const assumptions = [
    "The primary donation and rounding tests use a standard non-rebasing 6-decimal ERC20 with a fixed 1e6 price and exact transfer semantics.",
    "A sole or sufficiently concentrated incumbent exists before the victim supply; the multi-incumbent test demonstrates that donation socialization can make the donor unprofitable.",
    "The incumbent can order a direct transfer before an independent victim supply and withdraw afterward; no atomic funding across an unrelated victim transaction is assumed or proven.",
    "The configured minShares is a source-level parameter. The bounded production-like scenario uses 10,000,000 raw units only because the repository's existing test setup uses that value, not because current deployment state was queried.",
    "Borrow/repay tests use exact DebtManagerCore functions with local CashLens, CashModule, price, Safe-identity, and settlement mocks; they establish denominator behavior, not deployed integration equivalence.",
    "Fee-on-transfer and positive-rebase tests are compatibility diagnostics only. Source permits an admin to support such tokens, but current production token support and semantics are unqueried.",
    "The transferFrom callback test covers callback reentry into supply; balanceOf executes through a view/static context and no production token callback behavior is claimed.",
  ];
  const blockers = [
    "No deployed total assets, total shares, minShares, supplier concentration, supported-token semantics, available liquidity, or pending victim order flow was queried.",
    "The profitable zero-share sequence requires the attacker to be the sole/concentrated incumbent and to leave donation capital in the pool across an independently ordered victim supply.",
    "For minShares=10,000,000 raw, capital efficiency asymptotically approaches 1e-7; the bounded 1e12-raw capital scenario captures at most 99,999 raw units, so practical profitability is not established.",
    "No deployment bytecode equivalence was rerun, no fork was created, and no gas, MEV, market, funding, or live economics were modeled.",
    "Fee-on-transfer/rebase behavior requires compatible tokens to be privilegedly supported and is not part of the permissionless standard-token primitive.",
  ];
  const nextGate = "Independent reviewer must reproduce the fixed-seed package, validate the exact-source/reference split and formulas, and decide whether the source-level primitive survives as a production-relevant hypothesis. Pipeline remains 0/5. Only after reviewer approval may a separately authorized read-only deployment/config/state binding be proposed; no fork or economics before that gate.";
  const result = {
    schemaVersion: 1,
    revision: REVISION,
    runId,
    generatedAt,
    scanner: SCANNER,
    agentId: AGENT,
    role: "critical-research",
    classification,
    signal: "🟠 WATCH — SOURCE-LEVEL PRIMITIVE CANDIDATE PENDING REVIEW; DEPLOYED PRACTICALITY UNBOUND",
    pipeline: { stage: 0, totalStages: 5, sourceLevelPrimitiveCandidatePendingReview: true, productionPrimitiveEstablished: false },
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    fork: false,
    safety: { localOnly: true, rpcUsed: false, endpointInventoryRead: false, graphqlInventoryRead: false, webUsed: false, envFilesRead: false, privateKeysRead: false, deployedCalls: false, realValueUsed: false, forkCreated: false, liveMutation: false, broadcast: false, signingUsed: false, economicsAttempted: false },
    predecessor: { ...hashFile(SELECTION), findingId: selection.findingId },
    exactSource: { commit: SOURCE_COMMIT, cleanDetachedWorktree: true, dependencyClosureCompiledOffline: true, files: sources, facts: exactFacts, deploymentEquivalence: false },
    foundry: {
      compiler: "0.8.28",
      optimizer: true,
      optimizerRuns: 0,
      evmVersion: "cancun",
      offline: true,
      build: { exitStatus: build.status, outputBytes: build.outputBytes, outputSha256: build.outputSha256 },
      firstRun: { exitStatus: first.status, outputBytes: first.outputBytes, outputSha256: first.outputSha256 },
      replayRun: { exitStatus: replay.status, outputBytes: replay.outputBytes, outputSha256: replay.outputSha256 },
      fuzzSeed: FUZZ_SEED,
      fuzzRunsPerFuzzTest: FUZZ_RUNS,
      semanticReplayEqual: true,
    },
    tests: {
      sourceFunctionCount: functions.length,
      passedFunctionCount: firstRows.length,
      deterministicTestCount: deterministicRows.length,
      fuzzTestCount: fuzzRows.length,
      fuzzCaseCount: fuzzRows.reduce((n, x) => n + x.fuzzRuns, 0),
      totalExecutedCases: deterministicRows.length + fuzzRows.reduce((n, x) => n + x.fuzzRuns, 0),
      passRows: firstRows,
      invariantMatrix,
    },
    formulasAndBounds: model,
    exactDeltas: {
      minimalDeterministicCase: { initialSupply: "10", donationCapital: "61", victimSupply: "7", victimShares: "0", attackerGrossWithdrawal: "78", attackerContributedCapital: "71", attackerNet: "7", victimNet: "-7" },
      repeatedThreeVictims: { initialSupply: "10", donationCapital: "61", victimSupplyEach: "7", victimCount: 3, attackerNet: "21", aggregateVictimNet: "-21" },
      multipleEqualIncumbents: { incumbentSupplyEach: "10", donorDonation: "121", victimSupply: "7", donorNetNegative: true, donationSocialized: true },
      conservation: "For standard tokens after all suppliers fully withdraw: attackerNet + victimNet + residualAssets = 0 raw units.",
    },
    conclusions: {
      sourceBehaviorConfirmsZeroShareMint: true,
      safeReferenceRejectsSameTransition: true,
      soleIncumbentCanRealizeExactVictimAmountAtBoundary: true,
      boundedPositiveCycleExistsWithoutPrivilegedControl: true,
      practicalCurrentCycleEstablished: false,
      currentDeploymentAffected: null,
      productionLossEstablished: false,
      productionAttackerProfitEstablished: false,
      sourceLevelPrimitiveCandidatePendingReview: true,
    },
    assumptions,
    blockers,
    mitigations: [
      "Reject zero-share mints and require a caller-provided minimum shares out.",
      "Use internal accounted assets or virtual shares/assets so unsolicited transfers cannot arbitrarily move the mint price.",
      "Apply minimum shares per supplier rather than only to aggregate shares.",
      "Compute credited shares from actual received balance delta and explicitly restrict unsupported transfer/rebase semantics.",
    ],
    nextGate,
  };

  writeOwned(RAW, `${JSON.stringify(result, null, 2)}\n`);
  const report = `# 🟠 WATCH — SOURCE-LEVEL PRIMITIVE CANDIDATE PENDING REVIEW — EtherFi Cash DebtManager supplier shares\n\n**Classification:** \`${classification}\`  \n**Run:** \`${runId}\`  \n**Pipeline:** \`0/5\` — reviewer approval and deployed relevance are not established  \n**Gates:** \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`, \`fork=false\`\n\n> Exact local source permits a successful supply that transfers the full nominal amount while minting zero shares after an incumbent-funded direct donation. A sole incumbent can then withdraw the donation capital plus the victim amount. This is a bounded source-level primitive candidate pending review, not a deployed exploit or practical current route.\n\n## Exact source behavior\n\n- \`DebtManagerCore.supply\` calculates \`floor(amount * totalShares / totalAssets)\`, does not reject zero shares, and checks \`minShares\` only against aggregate shares.\n- \`_getTotalBorrowTokenAmount\` includes the contract's raw token balance, so unsolicited transfers and positive rebases move the denominator without minting shares.\n- The full nominal amount is transferred after share effects. Withdrawals burn with ceiling rounding.\n\n## Formula and exact deltas\n\nFor sole-incumbent initial shares/assets \`s\`, direct donation \`d\`, and victim amount \`v\`:\n\n- \`q = floor(v*s/(s+d))\`\n- \`q=0 iff v*s < s+d\`\n- \`d_min = s*(v-1)+1\` raw units\n- at \`d_min\`: attacker capital \`s+d_min=s*v+1\`; exact attacker net \`+v\`; exact victim net \`-v\`\n\nDeterministic exact-source case: \`s=10\`, \`d=61\`, \`v=7\`; victim shares \`0\`, attacker gross withdrawal \`78\`, contributed capital \`71\`, net \`+7\`, victim net \`-7\`. Three repeated victims produce attacker net \`+21\`. With two equal incumbents, the donor is net-negative because the donation is socialized, proving the concentration precondition.\n\n## Bounded practicality\n\nThe enumerated grid contains ${model.enumeratedDomain.rows} formula rows. Its maximum net is \`${model.maximumEnumeratedNet.attackerNet}\` raw units for the recorded bounded domain. Under a \`1,000,000,000,000\`-raw attacker-capital cap and \`minShares=10,000,000\` raw, the maximum zero-share victim/net is \`${model.boundedCapitalScenarios.sixDecimalMinSharesTenTokens.attackerNet}\` raw units. This is positive but capital-inefficient; current config, concentration, victim ordering, liquidity, funding duration, gas, and live economics are unknown. No practical current cycle is established.\n\n## Differential and coverage\n\nThe safe reference rejects zero shares and enforces caller minimum shares. Tests cover first supply, donation boundaries, realization, repeats, multiple incumbents, partial/full withdrawals, exact borrow/repay and interest-index changes with local mocks, fee/rebase compatibility assumptions, callback reentrancy, conservation, underflow, and extreme full-precision fuzz ranges.\n\n- Functions: \`${firstRows.length}/${functions.length}\` PASS\n- Deterministic: \`${deterministicRows.length}\`\n- Fuzz: \`${fuzzRows.length}\` functions × \`${FUZZ_RUNS}\` = \`${fuzzRows.length * FUZZ_RUNS}\` cases\n- Total effective cases: \`${deterministicRows.length + fuzzRows.length * FUZZ_RUNS}\`\n- Fixed-seed semantic replay: \`PASS\`\n\n## Assumptions and blockers\n\n${assumptions.map((x) => `- ${x}`).join("\n")}\n\n${blockers.map((x) => `- **Blocker:** ${x}`).join("\n")}\n\n## Defensive mitigation\n\nReject zero-share mints; require caller minimum shares out; isolate mint pricing from unsolicited balances with internal accounting or virtual shares/assets; enforce minimum shares per supplier; and credit from actual balance deltas while restricting incompatible token semantics.\n\n**nextGate:** ${nextGate}\n`;
  writeOwned(REPORT, report);
  const inbox = {
    findingId: NAME,
    revision: REVISION,
    runId,
    agentId: AGENT,
    role: "critical-research",
    status: classification,
    classification,
    pipeline: "0/5",
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    fork: false,
    summary: "Exact local source and fixed-seed differential tests confirm a zero-share donation transition with exact victim-to-incumbent raw-unit transfer for a sole incumbent; practical deployed conditions and current profit remain unbound, so this is only a source-level primitive candidate pending review.",
    testCounts: result.tests,
    formulas: model.exactFormula,
    maximumModeledNet: model.maximumEnumeratedNet,
    boundedProductionLikeNet: model.boundedCapitalScenarios.sixDecimalMinSharesTenTokens,
    assumptions,
    blockers,
    artifacts: [SOL_TEST, SCANNER, VALIDATOR, RAW, MANIFEST, REPORT],
    nextAction: nextGate,
  };
  writeOwned(INBOX, `${JSON.stringify(inbox, null, 2)}\n`);
  const handoff = `# EtherFi Cash DebtManager share differential handoff\n\n- Run: \`${runId}\`\n- Classification: \`${classification}\`; pipeline and gates remain \`0/5\`, \`0/0/false\`, fork false.\n- Exact local source confirms \`q=floor(v*s/(s+d))\`; minimum direct donation for zero shares is \`d_min=s*(v-1)+1\`. At the boundary a sole incumbent contributes \`s+d_min\`, withdraws that capital plus \`v\`, and the victim loses exactly \`v\` raw units.\n- Fixed-seed suite: ${firstRows.length}/${functions.length} functions, ${deterministicRows.length} deterministic, ${fuzzRows.length * FUZZ_RUNS} fuzz cases, semantic replay equal.\n- No practical current cycle is established. With 10,000,000 minimum shares and a 1,000,000,000,000-raw capital cap, bounded maximum net is only ${model.boundedCapitalScenarios.sixDecimalMinSharesTenTokens.attackerNet} raw; deployed config/state, concentration, order flow, liquidity, and economics are unqueried.\n- No RPC, inventory, web, fork, live call, signing, or broadcast occurred.\n- Next gate: independent offline review of exact-source binding, test package, formulas, assumptions, and deterministic replay.\n`;
  writeOwned(HANDOFF, handoff);

  const records = [SCANNER, VALIDATOR, SOL_TEST, RAW, REPORT, INBOX, HANDOFF, SELECTION, ...sources.map((x) => x.path)].map(hashFile);
  const aggregateSha256 = sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
  const manifest = {
    schemaVersion: 1,
    revision: REVISION,
    runId,
    generatedAt,
    algorithm: "sha256",
    classification,
    pipeline: "0/5",
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    fork: false,
    localOnly: true,
    noRpcInventoryWebForkLive: true,
    sourceCommit: SOURCE_COMMIT,
    dependencyClosureCompiledOffline: true,
    deploymentEquivalence: false,
    sourceLevelPrimitiveCandidatePendingReview: true,
    productionPrimitiveEstablished: false,
    passedFunctionCount: firstRows.length,
    deterministicTestCount: deterministicRows.length,
    fuzzTestCount: fuzzRows.length,
    fuzzCaseCount: fuzzRows.length * FUZZ_RUNS,
    fuzzSeed: FUZZ_SEED,
    semanticReplayEqual: true,
    records,
    aggregateSha256,
  };
  writeOwned(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ runId, classification, tests: result.tests, formulas: model.exactFormula, maximumModeledNet: model.maximumEnumeratedNet, boundedProductionLikeNet: model.boundedCapitalScenarios.sixDecimalMinSharesTenTokens, aggregateSha256 }, null, 2)}\n`);
}

main();
