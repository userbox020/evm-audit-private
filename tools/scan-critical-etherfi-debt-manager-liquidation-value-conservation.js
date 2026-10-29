#!/usr/bin/env node
"use strict";

const crypto = require("crypto"), fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, ".."), TARGET = path.join(ROOT, "targets", "cash-v3"), NAME = "critical-etherfi-debt-manager-liquidation-value-conservation";
const COMMIT = "e05bda2be27a6a606f3f1b8ff0d0791032fd0ff8", AGENT = "critical-etherfi-liquidation-differential-20260724";
const CLAIM = "coordination/claims/critical-etherfi-cash-v3-liquidation-value-conservation-differential--0060849e.json";
const TEST = "targets/cash-v3/test/critical/DebtManagerLiquidationValueConservation.t.sol", SCANNER = `tools/scan-${NAME}.js`, VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`, CLOSURE = `reports/raw/fast/${NAME}-source-closure.json`, MANIFEST = `reports/raw/fast/${NAME}-manifest.json`, REPORT = `reports/${NAME}.md`, INBOX = `coordination/inbox/critical/2026-07-24-${NAME}.json`, HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const CLASSIFICATION = "CLEAN/BOUNDED-LIQUIDATION-VALUE-CONSERVATION/NO-EXCESS-BEYOND-ROUNDING-DUST/LOCAL-EXACT-SOURCE";
const SEED = "0x4c49515549444154494f4e2d56414c55452d434f4e534552564154494f4e0000", FUZZ_RUNS = 256;
const abs = (x) => path.join(ROOT, x), sha = (x) => crypto.createHash("sha256").update(x).digest("hex"), read = (x) => fs.readFileSync(abs(x), "utf8"), json = (x) => JSON.parse(read(x));
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const hashFile = (x) => { const b = fs.readFileSync(abs(x)); return { path: x.replace(/\\/g, "/"), bytes: b.length, sha256: sha(b) }; };
const write = (x, body) => { const allowed = new Set([RAW, CLOSURE, MANIFEST, REPORT, INBOX, HANDOFF]); if (!allowed.has(x)) throw new Error("WRITE_REFUSED"); fs.mkdirSync(path.dirname(abs(x)), { recursive: true }); fs.writeFileSync(abs(x), body, "utf8"); };
function run(command, args, cwd = ROOT, timeout = 600000) { const r = spawnSync(command, args, { cwd, encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }); if (r.status !== 0) throw new Error(`${command.toUpperCase()}_FAILED:${r.stderr || r.stdout}`); return r.stdout; }
function leakCheck(x) { if (/(?:https?|wss?):\/\//i.test(x) || /(?:authorization|x-api-key|api-key|apikey|api_key|bearer|cookie)\s*[:=]\s*[^\s,}\]]+/i.test(x)) throw new Error("OUTPUT_LEAK"); }

function resolveImport(importer, spec) {
  let file;
  if (spec.startsWith(".")) file = path.resolve(path.dirname(importer), spec);
  else {
    const maps = [
      ["@openzeppelin/contracts-upgradeable/", path.join(TARGET, "lib", "openzeppelin-contracts-upgradeable", "contracts")],
      ["@openzeppelin/contracts/", path.join(TARGET, "lib", "openzeppelin-contracts", "contracts")],
      ["forge-std/", path.join(TARGET, "lib", "forge-std", "src")],
      ["solady/", path.join(TARGET, "lib", "solady", "src")],
    ];
    const row = maps.find(([prefix]) => spec.startsWith(prefix)); if (!row) throw new Error(`UNRESOLVED_IMPORT:${spec}`);
    file = path.join(row[1], spec.slice(row[0].length));
  }
  if (!path.extname(file)) file += ".sol";
  if (!fs.existsSync(file)) throw new Error(`MISSING_IMPORT:${spec}`);
  return path.resolve(file);
}

function sourceClosure(startRel) {
  const queue = [abs(startRel)], seen = new Set(), records = [];
  while (queue.length) {
    const file = path.resolve(queue.pop()); if (seen.has(file)) continue; seen.add(file);
    const body = fs.readFileSync(file, "utf8"), rel = path.relative(ROOT, file).replace(/\\/g, "/");
    if (rel.startsWith("..")) throw new Error("CLOSURE_OUTSIDE_WORKSPACE");
    records.push(hashFile(rel));
    const re = /\bimport\s+(?:(?:[^"']*?\sfrom\s*)?)["']([^"']+)["']\s*;/g; let m;
    while ((m = re.exec(body))) queue.push(resolveImport(file, m[1]));
  }
  records.sort((a, b) => a.path.localeCompare(b.path)); return records;
}

function parseForge(stdout) {
  const tests = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\[PASS\]\s+(.+?)(?:\s+\(gas:\s*(\d+)\)|\s+\(runs:\s*(\d+),[^)]*\))$/);
    if (m) tests.push({ name: m[1], gas: m[2] ? Number(m[2]) : null, fuzzRunsObserved: m[3] ? Number(m[3]) : null, status: "PASS" });
  }
  const marker = (key) => { const m = stdout.match(new RegExp(`${key}\\s+(\\d+)`)); if (!m) throw new Error(`MARKER_MISSING:${key}`); return m[1]; };
  const summary = {
    testCount: tests.length, passCount: tests.length, tests,
    systematicCases: Number(marker("LIQ_SYSTEMATIC_CASES")), requiredCaseGroups: Number(marker("LIQ_REQUIRED_CASE_GROUPS")),
    maxExcessUsd6Raw: marker("LIQ_MAX_EXCESS_USD6"), maxDustBoundUsd6Raw: marker("LIQ_MAX_DUST_BOUND_USD6"), maxCaseDustUsd6Raw: marker("LIQ_MAX_CASE_DUST_USD6"),
    maxCasePaidRaw: marker("LIQ_MAX_CASE_PAID_RAW"), maxCasePaidUsd6Raw: marker("LIQ_MAX_CASE_PAID_USD6"), maxCasePrincipalUsd6Raw: marker("LIQ_MAX_CASE_PRINCIPAL_USD6"), maxCaseBonusUsd6Raw: marker("LIQ_MAX_CASE_BONUS_USD6"),
    maxCaseDebtPriceUsd6Raw: marker("LIQ_MAX_CASE_DEBT_PRICE_USD6"), maxCaseCollateralPriceUsd6Raw: marker("LIQ_MAX_CASE_COLLATERAL_PRICE_USD6"), maxCaseDebtDecimals: Number(marker("LIQ_MAX_CASE_DEBT_DECIMALS")), maxCaseCollateralDecimals: Number(marker("LIQ_MAX_CASE_COLLATERAL_DECIMALS")),
    maxCaseAccountDriftUsd6Raw: marker("LIQ_MAX_CASE_ACCOUNT_DRIFT_USD6"), maxCaseAccountDustBoundUsd6Raw: marker("LIQ_MAX_CASE_ACCOUNT_DUST_BOUND_USD6"),
  };
  const evidenceLines = stdout.split(/\r?\n/).filter((x) => /^\[PASS\]|^\s+LIQ_|^Suite result:/.test(x)).join("\n");
  summary.evidenceTranscriptSha256 = sha(evidenceLines); return summary;
}

function main() {
  for (const x of [TEST, SCANNER, VALIDATOR, CLAIM]) if (!fs.existsSync(abs(x))) throw new Error(`MISSING:${x}`);
  const claim = json(CLAIM); if (claim.agentId !== AGENT || claim.status !== "active" || Date.parse(claim.expiresAt) <= Date.now()) throw new Error("CLAIM_INVALID");
  const head = run("git", ["rev-parse", "HEAD"], TARGET).trim(); if (head !== COMMIT) throw new Error("COMMIT_MISMATCH");
  run("git", ["diff", "--exit-code", "--", "src", "lib", "foundry.toml"], TARGET);
  const args = ["test", "--match-path", "test/critical/DebtManagerLiquidationValueConservation.t.sol", "--match-contract", "DebtManagerLiquidationValueConservationTest", "--fuzz-runs", String(FUZZ_RUNS), "--fuzz-seed", SEED, "--skip", "SafeAssetRecoveryInvariant", "-vv"];
  const firstOut = run("forge", args, TARGET, 1200000), replayOut = run("forge", args, TARGET, 1200000); leakCheck(firstOut); leakCheck(replayOut);
  const first = parseForge(firstOut), replay = parseForge(replayOut);
  const comparable = (x) => canonical({ ...x, evidenceTranscriptSha256: undefined, tests: x.tests.map((t) => ({ name: t.name, status: t.status, fuzzRunsObserved: t.fuzzRunsObserved })) });
  if (JSON.stringify(comparable(first)) !== JSON.stringify(comparable(replay))) throw new Error("DETERMINISTIC_REPLAY_MISMATCH");
  if (first.testCount !== 12 || first.passCount !== 12 || first.systematicCases !== 28 || first.requiredCaseGroups !== 11 || !first.tests.some((x) => x.name.startsWith("testFuzz_ValueConservation") && x.fuzzRunsObserved >= FUZZ_RUNS)) throw new Error("TEST_COVERAGE_GATE");
  if (BigInt(first.maxExcessUsd6Raw) > BigInt(first.maxCaseDustUsd6Raw) || BigInt(first.maxCaseAccountDriftUsd6Raw) > BigInt(first.maxCaseAccountDustBoundUsd6Raw)) throw new Error("CONSERVATION_GATE");
  const closureRecords = sourceClosure(TEST), closureDigest = sha(Buffer.from(closureRecords.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")));
  const closure = canonical({ schemaVersion: 1, exactCommit: COMMIT, root: TEST, recursiveImportClosureComplete: true, recordCount: closureRecords.length, records: closureRecords, aggregateSha256: closureDigest });
  write(CLOSURE, `${JSON.stringify(closure, null, 2)}\n`);
  const generatedAt = new Date().toISOString(), runId = `etherfi-debt-manager-liquidation-differential-${sha(`${COMMIT}\0${hashFile(TEST).sha256}\0${SEED}`).slice(0, 20)}`;
  const formula = {
    collateralPrincipal: "principalRaw=floor(L*10^collateralDecimals/collateralPrice); principalUsd=floor(principalRaw*collateralPrice/10^collateralDecimals)<=L",
    payment: "paidRaw=floor(L*10^debtDecimals/debtPrice); paidUsd=floor(paidRaw*debtPrice/10^debtDecimals)",
    dust: "0 <= L-paidUsd < ceil(debtPrice/10^debtDecimals) per liquidation leg; harness uses conservative (eventCount+1)*ceil(debtPrice/10^debtDecimals)",
  };
  const result = canonical({
    schemaVersion: 1, revision: "debt-manager-liquidation-value-conservation-r1", generatedAt, runId, agentId: AGENT, role: "critical-research", classification: CLASSIFICATION,
    source: { repository: "targets/cash-v3", exactCommit: COMMIT, dirtyProductionSource: false, compiler: "0.8.28", optimizer: true, optimizerRuns: 0, evmVersion: "cancun", bytecodeHash: "none", exactSourceDependencyClosure: hashFile(CLOSURE), closureAggregateSha256: closureDigest, closureRecordCount: closureRecords.length },
    execution: { localOnly: true, network: false, rpcInventoryRead: false, fork: false, liveCalls: false, fuzzSeed: SEED, fuzzRunsConfigured: FUZZ_RUNS, deterministicReplay: true, primaryEvidenceSha256: first.evidenceTranscriptSha256, replayEvidenceSha256: replay.evidenceTranscriptSha256 },
    tests: first,
    coverage: { decimalPairs: ["6/18", "18/6", "6/6", "18/18"], exactUsdPriceScaleDecimals: 6, priceBoundaryValuesUsd6Raw: ["1", "999999", "1000000", "1000001", "1234567", "9999999", "10000000000"], requiredCases: ["half-debt threshold", "maximum two-pass liquidation", "multi-collateral ordering", "duplicate preferences", "insufficient first collateral", "zero and tiny debt", "interest before and after update", "normalized debt floor and ceil", "remaining normalized unit", "bonus boundaries", "repeated liquidation", "self-liquidation", "standard supported-token exact transfer"], adversarialTokenSemantics: { executed: false, reason: "Existing configured-token behavior coverage establishes exact-transfer active borrow tokens; unsupported fee/rebase/callback semantics were not treated as supported production behavior." } },
    differential: { intendedBonusSeparated: true, maxConfiguredBonusInMaxCaseUsd6Raw: first.maxCaseBonusUsd6Raw, maxPrincipalValueUsd6Raw: first.maxCasePrincipalUsd6Raw, maxActualPaymentValueUsd6Raw: first.maxCasePaidUsd6Raw, maxExcessBeyondBonusUsd6Raw: first.maxExcessUsd6Raw, maxExcessUsd: Number(first.maxExcessUsd6Raw) / 1e6, maxCaseDebtTokenPaidRaw: first.maxCasePaidRaw, maxCaseDebtDecimals: first.maxCaseDebtDecimals, maxCaseCollateralDecimals: first.maxCaseCollateralDecimals, maxCaseDebtPriceUsd6Raw: first.maxCaseDebtPriceUsd6Raw, maxCaseCollateralPriceUsd6Raw: first.maxCaseCollateralPriceUsd6Raw, explicitRoundingDustBoundUsd6Raw: first.maxCaseDustUsd6Raw, maxSystematicDustBoundUsd6Raw: first.maxDustBoundUsd6Raw, excessBeyondDustUsd6Raw: "0", attackerPositivePrimitiveBeyondDust: false, formula },
    conservation: { debtTokenSenderDebitEqualsManagerReceipt: true, safeCollateralDecreaseEqualsLiquidatorReceipt: true, userNormalizedDeltaEqualsGlobalNormalizedDelta: true, maxTotalSuppliesDriftUsd6Raw: first.maxCaseAccountDriftUsd6Raw, correspondingAccountDustBoundUsd6Raw: first.maxCaseAccountDustBoundUsd6Raw, duplicateInsufficientPreferenceAtomicRevert: true, repeatedLiquidationBounded: true, selfLiquidationNoCollateralGain: true },
    rootCause: `The observed ${first.maxExcessUsd6Raw}-unit USD6 excess is bounded conversion dust, not an additional liquidation reward. Each liquidation leg floors debt-token payment conversion after collateral principal has been valued in USD; splitting across up to two legs can leave sub-raw-debt-token payment dust. Collateral principal never exceeded the leg's USD debt target, intended bonus was measured separately, normalized debt deltas matched globally, and account drift stayed inside the derived token/index rounding bound.`,
    assumptions: ["Standard exact-transfer ERC20 semantics for configured production borrow and collateral tokens", "PriceProvider returns nonzero USD prices with 6 decimals", "Local mocks reproduce CashModuleCore.postLiquidate movement through Safe.execTransactionFromModule while exact DebtManagerCore performs all liquidation arithmetic and state transitions", "No deployment/current-state exploit claim is made from this local source harness"],
    branchPipeline: { thisBranch: "0/5_CLOSED_BOUNDED", sourcePrimitivePendingReview: false, globalHighestPreserved: "2/5_WATCH_DEBT_MANAGER_SHARE_DONATION" },
    gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false },
    nextGate: "No network or fork escalation. Reopen only if supported token semantics, deployed price/decimal configuration, or source changes invalidate the exact-transfer and bounded-conversion assumptions; otherwise rotate to the repayment/index differential candidate.",
  });
  write(RAW, `${JSON.stringify(result, null, 2)}\n`);
  const report = `# ⚪ CLEAN — DebtManager liquidation value-conservation differential\n\n**Classification:** \`${CLASSIFICATION}\`  \n**Exact source:** \`${COMMIT}\`  \n**Branch pipeline:** \`0/5_CLOSED_BOUNDED\`; global highest remains DebtManager donation \`2/5 WATCH\`.\n\n## Result\n\nThe exact local DebtManager liquidation path and exact CashModuleCore collateral movement passed ${first.passCount}/${first.testCount} tests, ${first.systematicCases} systematic decimal/price cases, and ${first.tests.find((x) => x.fuzzRunsObserved)?.fuzzRunsObserved} fixed-seed fuzz executions with deterministic replay. No attacker-positive excess beyond explicitly bounded rounding dust was found.\n\nThe largest observed value above actual debt-token payment after removing the configured bonus was **${first.maxExcessUsd6Raw} USD6 raw = $${(Number(first.maxExcessUsd6Raw) / 1e6).toFixed(6)}**. The same case's conservative dust bound was ${first.maxCaseDustUsd6Raw} USD6 raw. It used debt/collateral decimals ${first.maxCaseDebtDecimals}/${first.maxCaseCollateralDecimals}, debt price ${first.maxCaseDebtPriceUsd6Raw} USD6, paid ${first.maxCasePaidRaw} debt-token raw (${first.maxCasePaidUsd6Raw} USD6), received ${first.maxCasePrincipalUsd6Raw} USD6 principal plus ${first.maxCaseBonusUsd6Raw} USD6 intended bonus. Excess beyond dust was zero.\n\n## Formula and root cause\n\n- Collateral principal: \`principalRaw=floor(L*10^dc/Pc)\`, so \`principalUsd<=L\`.\n- Payment: \`paidRaw=floor(L*10^dd/Pd)\`; converting it back can undershoot \`L\` by less than one raw debt-token unit per liquidation leg.\n- The implementation can execute at most two legs in one call. The harness conservatively attributes \`(eventCount+1)*ceil(Pd/10^dd)\` USD6 raw as payment-conversion dust.\n\nThe observed ${first.maxExcessUsd6Raw} units arise from this debt-payment floor, not from bonus duplication or collateral overvaluation. Intended bonus is reported separately and is ordinary liquidation reward.\n\n## Conservation and coverage\n\nCovered 6/18, 18/6, 6/6 and 18/18 decimals; exact USD6 price boundaries; half and maximum liquidation; multi-collateral order; duplicates; insufficient first collateral; zero/tiny debt; index updates; normalization floor/ceil; bonus boundaries; repeated and self-liquidation. Debt-token debit equaled manager receipt, Safe collateral decrease equaled liquidator receipt, user/global normalized changes matched, duplicate insufficient preferences reverted atomically, and total-supply drift remained ${first.maxCaseAccountDriftUsd6Raw}/${first.maxCaseAccountDustBoundUsd6Raw} USD6 raw observed/bound in the maximum-excess case.\n\nAdversarial fee/rebase/callback tokens were excluded because existing active configured-token coverage establishes standard exact-transfer semantics; adding such a token would reopen this assumption.\n\n## Next gate\n\nNo network or fork escalation. Rotate to the repayment/index differential unless supported token semantics, deployed decimal/price configuration, or source changes invalidate these bounds.\n`;
  const inbox = canonical({ findingId: NAME, runId, agentId: AGENT, role: "critical-research", status: CLASSIFICATION, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, sourcePrimitivePendingReview: false, globalHighestPipeline: "2/5_WATCH_DEBT_MANAGER_SHARE_DONATION", summary: `No excess beyond bounded rounding dust; maximum observed excess ${first.maxExcessUsd6Raw} USD6 raw versus ${first.maxCaseDustUsd6Raw} bound.`, artifacts: [RAW, REPORT, MANIFEST, CLOSURE, TEST, SCANNER, VALIDATOR, INBOX, HANDOFF], nextAction: result.nextGate });
  const handoff = `# DebtManager liquidation value-conservation handoff\n\n- ${CLASSIFICATION}; local exact commit ${COMMIT}; no network/fork/live calls.\n- ${first.passCount}/${first.testCount} tests PASS; ${first.systematicCases} systematic cases; fixed-seed fuzz observed ${first.tests.find((x) => x.fuzzRunsObserved)?.fuzzRunsObserved} executions; deterministic replay matched.\n- Maximum excess beyond configured bonus: ${first.maxExcessUsd6Raw} USD6 raw ($${(Number(first.maxExcessUsd6Raw) / 1e6).toFixed(6)}), inside ${first.maxCaseDustUsd6Raw} USD6 raw bound; excess beyond dust 0.\n- Exact transfer/account conservation, normalized user/global equality, duplicate atomicity, repeat and self-liquidation checks PASS.\n- Branch 0/5 closed bounded; global donation branch remains 2/5 WATCH. No network/fork escalation; rotate to repayment/index differential.\n`;
  for (const [file, body] of [[REPORT, report], [INBOX, `${JSON.stringify(inbox, null, 2)}\n`], [HANDOFF, handoff]]) { leakCheck(body); write(file, body); }
  const owned = [TEST, SCANNER, VALIDATOR, RAW, CLOSURE, REPORT, INBOX, HANDOFF], records = [...new Map([...owned.map(hashFile), ...closureRecords].map((x) => [x.path, x])).values()].sort((a, b) => a.path.localeCompare(b.path));
  const aggregateSha256 = sha(Buffer.from(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")));
  const manifest = canonical({ schemaVersion: 1, revision: result.revision, generatedAt, runId, classification: CLASSIFICATION, exactCommit: COMMIT, deterministicReplay: result.execution.deterministicReplay, testSummary: first, differential: result.differential, conservation: result.conservation, branchPipeline: result.branchPipeline, gates: result.gates, sourceClosureAggregateSha256: closureDigest, records, aggregateSha256 });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`; leakCheck(manifestText); write(MANIFEST, manifestText);
  process.stdout.write(`${JSON.stringify({ runId, classification: CLASSIFICATION, tests: `${first.passCount}/${first.testCount}`, systematicCases: first.systematicCases, fuzzRunsObserved: first.tests.find((x) => x.fuzzRunsObserved)?.fuzzRunsObserved, maxExcessUsd6Raw: first.maxExcessUsd6Raw, dustBoundUsd6Raw: first.maxCaseDustUsd6Raw, excessBeyondDustUsd6Raw: "0", closureRecords: closureRecords.length, aggregateSha256, branchPipeline: result.branchPipeline })}\n`);
}
main();
