#!/usr/bin/env node
"use strict";

const crypto = require("crypto"), fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, ".."), TARGET = path.join(ROOT, "targets", "cash-v3"), NAME = "critical-etherfi-debt-manager-repay-value-conservation";
const COMMIT = "e05bda2be27a6a606f3f1b8ff0d0791032fd0ff8", AGENT = "critical-etherfi-repay-differential-20260724";
const CLAIM = "coordination/claims/critical-etherfi-cash-v3-repay-index-decimal-conservation-differential--d8a0d089.json";
const TEST = "targets/cash-v3/test/critical/DebtManagerRepayValueConservation.t.sol", SCANNER = `tools/scan-${NAME}.js`, VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`, CLOSURE = `reports/raw/fast/${NAME}-source-closure.json`, MANIFEST = `reports/raw/fast/${NAME}-manifest.json`, REPORT = `reports/${NAME}.md`, INBOX = `coordination/inbox/critical/2026-07-24-${NAME}.json`, HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const CLASSIFICATION = "WATCH/BOUNDED-REPAY-CONVERSION-DUST/TERMINAL-NORMALIZED-UNIT-UNREPAYABLE/NO-MATERIAL-OR-NET-POSITIVE-ROUTE/LOCAL-EXACT-SOURCE";
const SEED = "0x52455041592d56414c55452d434f4e534552564154494f4e2d56310000000000", FUZZ_RUNS = 256;
const abs = (x) => path.join(ROOT, x), sha = (x) => crypto.createHash("sha256").update(x).digest("hex"), json = (x) => JSON.parse(fs.readFileSync(abs(x), "utf8"));
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
    const row = maps.find(([prefix]) => spec.startsWith(prefix)); if (!row) throw new Error(`UNRESOLVED_IMPORT:${spec}`); file = path.join(row[1], spec.slice(row[0].length));
  }
  if (!path.extname(file)) file += ".sol"; if (!fs.existsSync(file)) throw new Error(`MISSING_IMPORT:${spec}`); return path.resolve(file);
}
function sourceClosure(startRel) {
  const queue = [abs(startRel)], seen = new Set(), records = [];
  while (queue.length) {
    const file = path.resolve(queue.pop()); if (seen.has(file)) continue; seen.add(file);
    const body = fs.readFileSync(file, "utf8"), rel = path.relative(ROOT, file).replace(/\\/g, "/"); if (rel.startsWith("..")) throw new Error("CLOSURE_OUTSIDE_WORKSPACE"); records.push(hashFile(rel));
    const re = /\bimport\s+(?:(?:[^"']*?\sfrom\s*)?)["']([^"']+)["']\s*;/g; let m; while ((m = re.exec(body))) queue.push(resolveImport(file, m[1]));
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
    systematicCases: Number(marker("REPAY_SYSTEMATIC_CASES")), requiredCaseGroups: Number(marker("REPAY_REQUIRED_CASE_GROUPS")),
    maxOverCreditUsd6Raw: marker("REPAY_MAX_OVER_CREDIT_USD6"), maxOverCreditBoundUsd6Raw: marker("REPAY_MAX_OVER_CREDIT_BOUND_USD6"),
    maxCasePaidRaw: marker("REPAY_MAX_CASE_PAID_RAW"), maxCasePaidUsd6Raw: marker("REPAY_MAX_CASE_PAID_USD6"), maxCaseDebtReductionUsd6Raw: marker("REPAY_MAX_CASE_DEBT_REDUCTION_USD6"),
    maxCasePriceUsd6Raw: marker("REPAY_MAX_CASE_PRICE_USD6"), maxCaseIndex: marker("REPAY_MAX_CASE_INDEX"), maxCaseDecimals: Number(marker("REPAY_MAX_CASE_DECIMALS")),
    maxCaseSuppliesDriftUsd6Raw: marker("REPAY_MAX_CASE_SUPPLIES_DRIFT_USD6"), maxCaseSuppliesBoundUsd6Raw: marker("REPAY_MAX_CASE_SUPPLIES_BOUND_USD6"),
    nonIntegralUnderCreditUsd6Raw: marker("REPAY_NONINTEGRAL_UNDER_CREDIT_USD6"), nonIntegralUnderCreditBoundUsd6Raw: marker("REPAY_NONINTEGRAL_UNDER_CREDIT_BOUND_USD6"),
    terminalUnrepayableDebtUsd6Raw: marker("REPAY_TERMINAL_UNREPAYABLE_DEBT_USD6"), terminalNormalizedUnits: marker("REPAY_TERMINAL_NORMALIZED_UNITS"),
    cycleRetainedRaw: marker("REPAY_CYCLE_RETAINED_RAW"), cycleGrossUsd6Raw: marker("REPAY_CYCLE_GROSS_USD6"), cyclePaidRaw: marker("REPAY_CYCLE_PAID_RAW"),
  };
  const evidence = stdout.split(/\r?\n/).filter((x) => /^\[PASS\]|^\s+REPAY_|^Suite result:/.test(x)).join("\n"); summary.evidenceTranscriptSha256 = sha(evidence); return summary;
}
function main() {
  for (const x of [TEST, SCANNER, VALIDATOR, CLAIM]) if (!fs.existsSync(abs(x))) throw new Error(`MISSING:${x}`);
  const claim = json(CLAIM); if (claim.agentId !== AGENT || claim.status !== "active" || Date.parse(claim.expiresAt) <= Date.now()) throw new Error("CLAIM_INVALID");
  if (run("git", ["rev-parse", "HEAD"], TARGET).trim() !== COMMIT) throw new Error("COMMIT_MISMATCH");
  run("git", ["diff", "--exit-code", "--", "src", "lib", "foundry.toml"], TARGET);
  const args = ["test", "--match-path", "test/critical/DebtManagerRepayValueConservation.t.sol", "--match-contract", "DebtManagerRepayValueConservationTest", "--fuzz-runs", String(FUZZ_RUNS), "--fuzz-seed", SEED, "--skip", "SafeAssetRecoveryInvariant", "-vv"];
  const firstOut = run("forge", args, TARGET, 1200000), replayOut = run("forge", args, TARGET, 1200000); leakCheck(firstOut); leakCheck(replayOut);
  const first = parseForge(firstOut), replay = parseForge(replayOut);
  const comparable = (x) => canonical({ ...x, evidenceTranscriptSha256: undefined, tests: x.tests.map((t) => ({ name: t.name, status: t.status, fuzzRunsObserved: t.fuzzRunsObserved })) });
  if (JSON.stringify(comparable(first)) !== JSON.stringify(comparable(replay))) throw new Error("DETERMINISTIC_REPLAY_MISMATCH");
  if (first.testCount !== 11 || first.passCount !== 11 || first.systematicCases !== 42 || first.requiredCaseGroups !== 11 || !first.tests.some((x) => x.name.startsWith("testFuzz_RepayReference") && x.fuzzRunsObserved >= FUZZ_RUNS)) throw new Error("TEST_COVERAGE_GATE");
  if (BigInt(first.maxOverCreditUsd6Raw) > BigInt(first.maxOverCreditBoundUsd6Raw) || BigInt(first.nonIntegralUnderCreditUsd6Raw) > BigInt(first.nonIntegralUnderCreditBoundUsd6Raw) || first.cyclePaidRaw !== "0" || first.cycleRetainedRaw !== "1") throw new Error("CONSERVATION_GATE");
  const closureRecords = sourceClosure(TEST), closureDigest = sha(Buffer.from(closureRecords.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")));
  const closure = canonical({ schemaVersion: 1, exactCommit: COMMIT, root: TEST, recursiveImportClosureComplete: true, recordCount: closureRecords.length, records: closureRecords, aggregateSha256: closureDigest }); write(CLOSURE, `${JSON.stringify(closure, null, 2)}\n`);
  const generatedAt = new Date().toISOString(), runId = `etherfi-debt-manager-repay-differential-${sha(`${COMMIT}\0${hashFile(TEST).sha256}\0${SEED}`).slice(0, 20)}`;
  const result = canonical({
    schemaVersion: 1, revision: "debt-manager-repay-value-conservation-r1", generatedAt, runId, agentId: AGENT, role: "critical-research", classification: CLASSIFICATION,
    source: { repository: "targets/cash-v3", exactCommit: COMMIT, dirtyProductionSource: false, compiler: "0.8.28", optimizer: true, optimizerRuns: 0, evmVersion: "cancun", bytecodeHash: "none", exactSourceDependencyClosure: hashFile(CLOSURE), closureAggregateSha256: closureDigest, closureRecordCount: closureRecords.length },
    execution: { localOnly: true, network: false, rpcInventoryRead: false, fork: false, liveCalls: false, fuzzSeed: SEED, fuzzRunsConfigured: FUZZ_RUNS, deterministicReplay: true, primaryEvidenceSha256: first.evidenceTranscriptSha256, replayEvidenceSha256: replay.evidenceTranscriptSha256 },
    tests: first,
    findings: {
      boundedConversionDust: { preconditions: ["caller controls an EtherFi Safe", "borrow-token USD conversion floors", "repay request exceeds displayed debt so amount is reconverted with floor", "price/decimal pair leaves a nonzero raw-token remainder"], exactLocalCycle: { borrowedRaw: "1", retainedRaw: first.cycleRetainedRaw, repaymentPaidRaw: first.cyclePaidRaw, grossUsd6Raw: first.cycleGrossUsd6Raw }, maximumObservedSystematicOverCreditUsd6Raw: first.maxOverCreditUsd6Raw, conservativePerCallBoundUsd6Raw: first.maxOverCreditBoundUsd6Raw, excessBeyondBoundUsd6Raw: "0", impact: "At most sub-one-raw-token conversion value per cycle in the covered domain; locally attacker-positive gross dust, but no current configured-token route, gas-amortized net profit, or deployed execution is established." },
      terminalNormalizedDust: { preconditions: ["interest index exceeds 1e18", "repayment floor leaves one normalized unit or a one-unit borrow ages"], normalizedUnits: first.terminalNormalizedUnits, displayedDebtUsd6Raw: first.terminalUnrepayableDebtUsd6Raw, impact: "Repay computes zero normalized reduction and reverts, leaving terminal debt that cannot be cleared through repay; bounded accounting/liveness dust, not material asset loss in this harness." }
    },
    conservation: { debtTokenSenderDebitEqualsManagerReceipt: true, userNormalizedDeltaEqualsGlobalNormalizedDelta: true, maximumObservedSupplierAccountingDriftUsd6Raw: first.maxCaseSuppliesDriftUsd6Raw, correspondingBoundUsd6Raw: first.maxCaseSuppliesBoundUsd6Raw, thirdPartyCannotAlterOtherUserDebt: true, failedTinyRepaysAtomic: true },
    coverage: { tokenDecimals: [6, 8, 18], priceBoundariesUsd6Raw: ["1", "999999", "1000000", "1000001", "1234567", "9999999", "10000000000"], modes: ["partial", "exact displayed debt", "overpay cap", "third-party repay", "nonintegral interest index", "index aging", "repeated micro repay", "zero/no-debt", "collateral-only unsupported route", "actual borrow-repay cycle", "terminal normalized unit"] },
    codeReferences: ["targets/cash-v3/src/debt-manager/DebtManagerCore.sol:491-511", "targets/cash-v3/src/debt-manager/DebtManagerCore.sol:595-602", "targets/cash-v3/src/debt-manager/DebtManagerStorageContract.sol:498-501", "targets/cash-v3/src/debt-manager/DebtManagerStorageContract.sol:520-531"],
    assumptions: ["Standard exact-transfer ERC20 behavior", "Nonzero USD6 prices", "Local exact-source mocks provide Safe classification, collateral lens, and settlement dispatch without claiming deployed/current-state token configuration"],
    branchPipeline: { thisBranch: "1/5_LOCAL-SOURCE-PRIMITIVE_BOUNDED_DUST", sourcePrimitivePendingReview: true, globalHighestPreserved: "2/5_WATCH_DEBT_MANAGER_SHARE_DONATION" },
    gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false },
    mitigations: ["For capped repayment, round USD-to-token payment up or reduce debt using the USD value of the actual token amount transferred", "If the caller repays the full displayed debt, explicitly clear the user's remaining normalized dust and reconcile global normalized debt within a documented bound", "Reject unsupported repay tokens before index math and add minimum-effective-repayment previews"],
    nextGate: "Bind active borrow-token price/decimal pairs and repay entry flow read-only before any fork. Escalate only if a configured pair has material one-raw value and bounded repeated-cycle economics exceed gas; otherwise retain as low-value accounting/liveness WATCH.",
  });
  write(RAW, `${JSON.stringify(result, null, 2)}\n`);
  const report = `# 🟡 WATCH — DebtManager repay conversion and normalized-dust differential\n\n**Classification:** \`${CLASSIFICATION}\`  \n**Exact source:** \`${COMMIT}\`  \n**Branch pipeline:** \`1/5_LOCAL-SOURCE-PRIMITIVE_BOUNDED_DUST\`; global highest remains donation \`2/5 WATCH\`.\n\n## Findings\n\n### RPY-01 — Capped repay can clear debt while transferring one raw token less\n\nAt \`DebtManagerCore.sol:499-511\`, an overpayment is capped to displayed USD debt and then converted back to token units with floor rounding in \`DebtManagerStorageContract.sol:498-501\`. Debt reduction still uses the pre-conversion USD amount. The exact local borrow/repay cycle borrowed one raw 6-decimal token, retained that raw token at settlement, paid zero raw on capped repay, and cleared ${first.cycleGrossUsd6Raw} USD6 raw of debt. This is attacker-positive gross conversion dust, bounded below one raw token per cycle. The largest covered systematic over-credit was ${first.maxOverCreditUsd6Raw} USD6 raw ($${(Number(first.maxOverCreditUsd6Raw) / 1e6).toFixed(6)}) versus a ${first.maxOverCreditBoundUsd6Raw} bound; excess beyond bound was zero. No active configured-token match, gas-amortized profit, or current route is established.\n\n### RPY-02 — Terminal normalized unit can be unrepayable\n\nAt \`DebtManagerCore.sol:507-508\`, normalized repayment rounds down. After index growth, a displayed ${first.terminalUnrepayableDebtUsd6Raw}-USD6-raw debt backed by one normalized unit produces zero normalized repayment and reverts. The harness reached this state both directly and through an exact one-raw borrow followed by interest growth. Impact is bounded debt/accounting liveness dust; material loss was not shown.\n\n## Evidence and conservation\n\n${first.passCount}/${first.testCount} tests passed, including ${first.systematicCases} decimal/price cases and ${first.tests.find((x) => x.fuzzRunsObserved)?.fuzzRunsObserved} fixed-seed fuzz executions with deterministic replay. Sender debit equaled manager receipt, user/global normalized deltas matched, other-user debt was unchanged, and failed dust repayments were atomic. Covered decimals 6/8/18 and prices through 10,000 USD.\n\n## Mitigation\n\nRound capped USD-to-token repayment up, or derive debt reduction from the actual transferred token value. On full displayed-debt repayment, explicitly clear and globally reconcile bounded normalized dust. Validate borrow-token support before index math.\n\n## Next gate\n\n${result.nextGate}\n`;
  const inbox = canonical({ findingId: NAME, runId, agentId: AGENT, role: "critical-research", status: CLASSIFICATION, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, sourcePrimitivePendingReview: true, globalHighestPipeline: "2/5_WATCH_DEBT_MANAGER_SHARE_DONATION", summary: `Exact local source confirms one-raw capped-repay conversion dust (max covered ${first.maxOverCreditUsd6Raw} USD6 raw) and an unrepayable terminal normalized unit; no material/current/net-positive route.`, artifacts: [RAW, REPORT, MANIFEST, CLOSURE, TEST, SCANNER, VALIDATOR, INBOX, HANDOFF], nextAction: result.nextGate });
  const handoff = `# DebtManager repay value-conservation handoff\n\n- ${CLASSIFICATION}; exact local commit ${COMMIT}; no network/RPC/fork/live calls.\n- ${first.passCount}/${first.testCount} PASS; ${first.systematicCases} systematic cases; ${first.tests.find((x) => x.fuzzRunsObserved)?.fuzzRunsObserved} fixed-seed fuzz executions; deterministic replay matched.\n- Exact borrow/repay cycle retained one raw token, paid zero raw on capped repay, and cleared ${first.cycleGrossUsd6Raw} USD6 raw; covered maximum over-credit ${first.maxOverCreditUsd6Raw}/${first.maxOverCreditBoundUsd6Raw} observed/bound, no excess beyond bound.\n- One normalized unit after index growth displayed ${first.terminalUnrepayableDebtUsd6Raw} USD6 raw but repay reverted with zero normalized reduction.\n- Branch 1/5 local bounded-dust primitive pending review; global donation remains 2/5 WATCH. Next: read-only configured token/price/decimal binding and gas-amortized economics only.\n`;
  for (const [file, body] of [[REPORT, report], [INBOX, `${JSON.stringify(inbox, null, 2)}\n`], [HANDOFF, handoff]]) { leakCheck(body); write(file, body); }
  const owned = [TEST, SCANNER, VALIDATOR, RAW, CLOSURE, REPORT, INBOX, HANDOFF], records = [...new Map([...owned.map(hashFile), ...closureRecords].map((x) => [x.path, x])).values()].sort((a, b) => a.path.localeCompare(b.path));
  const aggregateSha256 = sha(Buffer.from(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")));
  const manifest = canonical({ schemaVersion: 1, revision: result.revision, generatedAt, runId, classification: CLASSIFICATION, exactCommit: COMMIT, deterministicReplay: true, testSummary: first, findings: result.findings, branchPipeline: result.branchPipeline, gates: result.gates, sourceClosureAggregateSha256: closureDigest, records, aggregateSha256 });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`; leakCheck(manifestText); write(MANIFEST, manifestText);
  process.stdout.write(`${JSON.stringify({ runId, classification: CLASSIFICATION, tests: `${first.passCount}/${first.testCount}`, systematicCases: first.systematicCases, fuzzRunsObserved: first.tests.find((x) => x.fuzzRunsObserved)?.fuzzRunsObserved, maxOverCreditUsd6Raw: first.maxOverCreditUsd6Raw, overCreditBoundUsd6Raw: first.maxOverCreditBoundUsd6Raw, cycleGrossUsd6Raw: first.cycleGrossUsd6Raw, terminalDebtUsd6Raw: first.terminalUnrepayableDebtUsd6Raw, closureRecords: closureRecords.length, aggregateSha256, branchPipeline: result.branchPipeline })}\n`);
}
main();
