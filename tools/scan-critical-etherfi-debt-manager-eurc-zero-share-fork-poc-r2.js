#!/usr/bin/env node
"use strict";

const crypto = require("crypto"), fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, ".."), NAME = "critical-etherfi-debt-manager-eurc-zero-share-fork-poc-r2";
const REVISION = "debt-manager-eurc-zero-share-ephemeral-local-fork-reviewer-r2";
const CLASSIFICATION = "DEPLOYMENT_RELEVANT_LOCAL_FORK_POC_R2/PENDING_REVIEW/BOUND_EXECUTION_PREIMAGES/NO_MARKET_PROFIT_CLAIM";
const AGENT = "critical-etherfi-debt-manager-eurc-fork-poc-r2-20260724";
const CLAIM = "coordination/claims/critical-etherfi-debt-manager-eurc-zero-share-fork-poc-r2--72811b7c.json";
const SCANNER = `tools/scan-${NAME}.js`, VALIDATOR = `tools/test-${NAME}.js`, RUNNER = `tools/run-${NAME}.js`, TEST = "targets/cash-v3/test/critical/DebtManagerEURCZeroShareForkR2.t.sol";
const R1_MANIFEST = "reports/raw/fast/critical-etherfi-debt-manager-eurc-zero-share-fork-poc-manifest.json", R1_RAW = "reports/raw/fast/critical-etherfi-debt-manager-eurc-zero-share-fork-poc.json";
const R1_AGGREGATE = "fb334e6bc8046c72f1a8f870082460c3d4ff9636b9584487365da7ecab173b3e";
const FORGE = `reports/raw/fast/${NAME}-forge-transcript.json`, STDOUT1 = `reports/raw/fast/${NAME}-runner-stdout-primary.json`, STDOUT2 = `reports/raw/fast/${NAME}-runner-stdout-replay.json`, PROOF = `reports/raw/fast/${NAME}-structured-proof.json`, REPLAY = `reports/raw/fast/${NAME}-deterministic-replay.json`, TOOLS = `reports/raw/fast/${NAME}-tool-versions.json`;
const RAW = `reports/raw/fast/${NAME}.json`, MANIFEST = `reports/raw/fast/${NAME}-manifest.json`, REPORT = `reports/${NAME}.md`, INBOX = `coordination/inbox/critical/2026-07-24-${NAME}.json`, HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const PREIMAGES = [FORGE, STDOUT1, STDOUT2, PROOF, REPLAY, TOOLS], OWNED = [SCANNER, VALIDATOR, RUNNER, TEST, ...PREIMAGES, RAW, REPORT, INBOX, HANDOFF];
const abs = (x) => path.join(ROOT, x), read = (x) => fs.readFileSync(abs(x), "utf8"), json = (x) => JSON.parse(read(x));
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex"), hashFile = (x) => { const b = fs.readFileSync(abs(x)); return { path: x, bytes: b.length, sha256: sha(b) }; };
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const write = (x, body) => { if (![...PREIMAGES, RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(x)) throw new Error("WRITE_REFUSED"); fs.mkdirSync(path.dirname(abs(x)), { recursive: true }); fs.writeFileSync(abs(x), body, "utf8"); };
function leakCheck(text) { if (/(?:https?|wss?):\/\//i.test(text) || /\[REDACTED_(?:URL|SECRET)\]/.test(text)) throw new Error("ENDPOINT_OR_SECRET_LEAK"); if (/(?:authorization|x-api-key|api-key|apikey|api_key|bearer|cookie)\s*[:=]\s*[^\s,}\]]+/i.test(text)) throw new Error("SECRET_LEAK"); }
function verifyManifest(rel, expected) { const m = json(rel); for (const row of m.records) { const a = hashFile(row.path); if (a.bytes !== row.bytes || a.sha256 !== row.sha256) throw new Error(`R1_RECORD_MISMATCH:${row.path}`); } const aggregate = sha(Buffer.from(m.records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"))); if (aggregate !== m.aggregateSha256 || aggregate !== expected) throw new Error("R1_AGGREGATE_MISMATCH"); return m; }
const eurc = (raw) => { const x = BigInt(raw); return `${x / 1_000_000n}.${(x % 1_000_000n).toString().padStart(6, "0")}`; };

function validateBundle(bundle) {
  const primary = JSON.parse(bundle.primaryRunnerStdout), replay = JSON.parse(bundle.replayRunnerStdout), proof = bundle.structuredProof, forge = bundle.forgeTranscript, deterministic = bundle.replayResult;
  if (!primary.deploymentRelevantPoCSucceeds || primary.fork.pinNumber !== 154624560 || primary.forge.testCount !== 6 || !replay.deploymentRelevantPoCSucceeds) throw new Error("RUNNER_PREIMAGE_INVALID");
  if (proof.format !== "STRUCTURED_PROOF_PREIMAGE_R2" || !proof.deploymentRelevantPoCSucceeds || proof.fork.pinHash !== "0x99e06b23d27f439a7567f5e193d94f517eb5d54e97230713d1795abb2fa1867a") throw new Error("PROOF_PREIMAGE_INVALID");
  if (forge.format !== "SANITIZED_COMPLETE_FORGE_JSON_TEST_TRANSCRIPT_R2" || forge.testCount !== 6 || forge.passCount !== 6 || forge.failCount !== 0 || forge.tests.length !== 6 || forge.tests.some((x) => x.status !== "PASS" || !Number.isInteger(x.gas) || x.gas <= 0)) throw new Error("FORGE_PREIMAGE_INVALID");
  if (!deterministic.deterministicProjectionEqual || !deterministic.structuredProofEqual || !deterministic.gasEqual || !deterministic.snapshotRollbackDeterministic) throw new Error("REPLAY_INVALID");
  if (bundle.cacheSnapshot.retained !== false || !/hash-bound execution preimages/.test(bundle.cacheSnapshot.reason)) throw new Error("CACHE_POLICY_INVALID");
  if (!bundle.tools || bundle.tools.commandsContainEndpointArgument !== false || bundle.tools.forgeCommand.includes("http")) throw new Error("TOOLS_INVALID");
  for (const row of proof.proof.scenarios) { const v = BigInt(row.victimAmountRaw), d = 10_000_000n * (v - 1n) + (row.mode === "d_min" ? 1n : 0n); if (BigInt(row.donationRaw) !== d || BigInt(row.attackerCapitalRaw) !== 10_000_000n + d || row.conservationExcludingDealRaw !== "0") throw new Error("ARITHMETIC_INVALID"); }
  return { primary, replay, proof, forge, deterministic };
}

function main() {
  for (const rel of [SCANNER, VALIDATOR, RUNNER, TEST, CLAIM, R1_MANIFEST, R1_RAW]) if (!fs.existsSync(abs(rel))) throw new Error(`MISSING:${rel}`);
  const claim = json(CLAIM); if (claim.resource !== "critical/etherfi-debt-manager-eurc-zero-share-fork-poc-r2" || claim.agentId !== AGENT || claim.status !== "active" || Date.parse(claim.expiresAt) <= Date.now()) throw new Error("CLAIM_INVALID");
  const r1Manifest = verifyManifest(R1_MANIFEST, R1_AGGREGATE), r1 = json(R1_RAW);
  if (!r1.deploymentRelevantPoCSucceeds || r1.pipeline.recommendation !== "2/5_PENDING_INDEPENDENT_REVIEW") throw new Error("R1_INVALID");
  let bundle;
  if (process.argv.includes("--offline-repackage")) {
    for (const rel of PREIMAGES) if (!fs.existsSync(abs(rel))) throw new Error(`OFFLINE_PREIMAGE_MISSING:${rel}`);
    const priorRaw = fs.existsSync(abs(RAW)) ? json(RAW) : null;
    bundle = { forgeTranscript: json(FORGE), primaryRunnerStdout: read(STDOUT1), replayRunnerStdout: read(STDOUT2), structuredProof: json(PROOF), replayResult: json(REPLAY), tools: json(TOOLS), cacheSnapshot: priorRaw && priorRaw.cacheSnapshot, safety: priorRaw && priorRaw.safety };
  } else {
    const run = spawnSync(process.execPath, [abs(RUNNER)], { cwd: ROOT, encoding: "utf8", timeout: 2_400_000, maxBuffer: 64 * 1024 * 1024 });
    if (run.status !== 0) throw new Error(`R2_RUN_FAILED:${String(run.stderr).replace(/(?:https?|wss?):\/\/[^\s"']+/gi, "[REDACTED_URL]")}`);
    leakCheck(run.stdout); bundle = JSON.parse(run.stdout.trim());
  }
  const checked = validateBundle(bundle);
  const preimageBodies = {
    [FORGE]: JSON.stringify(bundle.forgeTranscript, null, 2) + "\n",
    [STDOUT1]: bundle.primaryRunnerStdout,
    [STDOUT2]: bundle.replayRunnerStdout,
    [PROOF]: JSON.stringify(bundle.structuredProof, null, 2) + "\n",
    [REPLAY]: JSON.stringify(bundle.replayResult, null, 2) + "\n",
    [TOOLS]: JSON.stringify(bundle.tools, null, 2) + "\n",
  };
  for (const [rel, body] of Object.entries(preimageBodies)) { leakCheck(body); write(rel, body); }
  const generatedAt = new Date().toISOString(), preimageRecords = PREIMAGES.map(hashFile);
  const runId = `etherfi-debt-manager-eurc-fork-r2-154624560-${hashFile(RUNNER).sha256.slice(0, 12)}-${hashFile(PROOF).sha256.slice(0, 12)}`;
  const fixtureNames = ["r1-recursive-closure", "forge-six-names", "forge-six-pass", "forge-per-test-gas", "primary-stdout-preimage", "replay-stdout-preimage", "deterministic-projection", "scenario-arithmetic", "repeated-victims", "safe-reference", "report-proof-crosscheck", "secret-and-cache-policy"];
  const nextEconomicsGate = "After independent review accepts pipeline 2/5, establish a current permissionless victim/order-flow route and complete capital availability/cost, gas, fees, slippage, ordering, competition, liquidity/unwind, and positive net-return analysis; do not open executable or live-action gates before then.";
  const exact = checked.proof.proof.scenarios.filter((x) => x.mode === "d_min");
  const raw = canonical({ schemaVersion: 1, revision: REVISION, generatedAt, runId, agentId: AGENT, role: "critical-research", classification: CLASSIFICATION, predecessorR1: { aggregateSha256: R1_AGGREGATE, manifest: hashFile(R1_MANIFEST), raw: hashFile(R1_RAW), recursiveRecordCount: r1Manifest.records.length, allRecordsValidated: true }, deploymentRelevantPoCSucceeds: true, fork: checked.proof.fork, bindings: checked.proof.bindings, testSummary: { testCount: 6, passCount: 6, failCount: 0, tests: checked.forge.tests }, fixtureSummary: { fixtureCount: fixtureNames.length, fixtureNames }, evidencePreimages: Object.fromEntries(preimageRecords.map((x) => [path.basename(x.path, ".json"), x])), deterministicReplay: checked.deterministic, cacheSnapshot: bundle.cacheSnapshot, exactScenarioSummary: exact.map((x) => ({ victimRaw: x.victimAmountRaw, victimEURC: eurc(x.victimAmountRaw), dMinRaw: x.donationRaw, attackerCapitalRaw: x.attackerCapitalRaw, attackerCapitalEURC: eurc(x.attackerCapitalRaw), victimSharesRaw: x.victimSharesMintedRaw, attackerDeltaRaw: x.attackerTokenDeltaRaw, victimDeltaRaw: x.victimAggregateTokenDeltaRaw, managerDeltaRaw: x.managerTokenDeltaRaw, conservationRaw: x.conservationExcludingDealRaw, transactionGas: x.gas })), repeatedVictims: checked.proof.proof.repeatedVictims, safeReferenceDifferential: checked.proof.proof.safeReferenceDifferential, permissionless: checked.proof.proof.permissionless, pipeline: { prior: "1/5", recommendation: "2/5_PENDING_INDEPENDENT_REVIEW", promoted: false, reviewerRequired: true }, gates: checked.proof.gates, safety: bundle.safety, nextEconomicsGate });
  const testRows = checked.forge.tests.map((x) => `| \`${x.name}\` | ${x.status} | ${x.gas} |`).join("\n"), scenarioRows = raw.exactScenarioSummary.map((x) => `| ${x.victimEURC} | ${x.dMinRaw} | ${x.attackerCapitalEURC} | ${x.victimSharesRaw} | ${x.attackerDeltaRaw} | ${x.victimDeltaRaw} | ${x.conservationRaw} |`).join("\n");
  const report = `# 🟡 VULNERABLE — DebtManager EURC zero-share local fork PoC reviewer R2\n\n**Classification:** \`${CLASSIFICATION}\`  \n**Run:** \`${runId}\`  \n**Pipeline recommendation:** \`2/5_PENDING_INDEPENDENT_REVIEW\`  \n**Gates:** route/executable/signing \`0/0/false\`; fork is ephemeral local only.\n\nR2 preserves the R1 test logic unchanged through inheritance and adds complete bounded evidence preimages. Exact pin/runtime/config/state, scenario arithmetic, per-transaction receipt gas, repeated victims, safe reference, and rollback determinism remain unchanged. No market-profit route is claimed.\n\n## Forge transcript — 6/6 PASS\n\n| Test | Status | Forge gas |\n|---|---:|---:|\n${testRows}\n\nThe sanitized Forge JSON transcript retains all six names/status/gas and bounded summary lines, but no decoded logs or traces. Primary and replay runner stdout are retained byte-for-byte as sanitized JSON preimages. The structured proof preimage retains pin, runtimes, empty EURC state, all six boundary/exact scenarios, repeated victims, safe-reference result, deltas, receipt gas, and conservation.\n\n## Exact d_min scenarios\n\n| Victim EURC | d_min raw | Capital EURC | Victim shares | Attacker delta raw | Victim delta raw | Conservation |\n|---:|---:|---:|---:|---:|---:|---:|\n${scenarioRows}\n\nReplay deterministic projection, structured proof, gas, and snapshot rollback all match. Raw runner stdout may differ only in its separately excluded transient \`forge.transcriptSha256\`; both preimages and hashes are retained rather than concealed.\n\n## Cache and safety\n\n${bundle.cacheSnapshot.reason}\n\nNo endpoint URL/provider identifier/raw RPC/private key/ephemeral secret/unbounded trace was retained. Commands and exact tool versions are bound with the endpoint argument replaced by \`<EPHEMERAL_LOCAL_ANVIL>\`. No broadcast, production mutation, or real funds occurred.\n\n## Next economics gate\n\n${nextEconomicsGate}\n`;
  const inbox = canonical({ findingId: NAME, revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: CLASSIFICATION, classification: CLASSIFICATION, deploymentRelevantPoCSucceeds: true, testCount: 6, fixtureCount: fixtureNames.length, pipelineRecommendation: "2/5_PENDING_INDEPENDENT_REVIEW", routePositive: 0, executableNow: 0, signedActionJustified: false, fork: true, forkScope: "EPHEMERAL_LOCAL_ONLY", predecessorAggregate: R1_AGGREGATE, evidencePreimages: raw.evidencePreimages, artifacts: [RAW, MANIFEST, REPORT, INBOX, HANDOFF, RUNNER, TEST, VALIDATOR, ...PREIMAGES], nextAction: nextEconomicsGate });
  const handoff = `# DebtManager EURC fork PoC reviewer R2 handoff\n\n- Run \`${runId}\`; ${CLASSIFICATION}.\n- R1 aggregate \`${R1_AGGREGATE}\` recursively validated and bound. Test logic inherited unchanged.\n- 6/6 Forge tests PASS with names/status/gas retained; 12/12 evidence fixtures expected.\n- Primary/replay runner stdout, structured proof, Forge transcript, deterministic replay, and exact tool/command preimages are explicit manifest records.\n- Projection/proof/gas/snapshot replay deterministic. No portable fork cache retained; review relies on bound execution preimages.\n- Pipeline recommendation 2/5 pending independent reviewer; route/executable/signing 0/0/false; fork ephemeral local only.\n- No endpoint/provider/raw RPC/key/secret/trace persisted; no broadcast, production mutation, or real funds.\n- Next: ${nextEconomicsGate}\n`;
  for (const [rel, body] of [[RAW, JSON.stringify(raw, null, 2) + "\n"], [REPORT, report], [INBOX, JSON.stringify(inbox, null, 2) + "\n"], [HANDOFF, handoff]]) { leakCheck(body); write(rel, body); }
  const closure = [...new Set([...OWNED, R1_MANIFEST, ...r1Manifest.records.map((x) => x.path)])], records = closure.map(hashFile), aggregateSha256 = sha(Buffer.from(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")));
  const manifest = canonical({ schemaVersion: 1, revision: REVISION, generatedAt, runId, classification: CLASSIFICATION, predecessorR1: raw.predecessorR1, deploymentRelevantPoCSucceeds: true, testSummary: raw.testSummary, fixtureSummary: raw.fixtureSummary, evidencePreimages: raw.evidencePreimages, deterministicReplay: raw.deterministicReplay, cacheSnapshot: raw.cacheSnapshot, pipeline: raw.pipeline, gates: raw.gates, safety: raw.safety, nextEconomicsGate, records, aggregateSha256 });
  const manifestText = JSON.stringify(manifest, null, 2) + "\n"; leakCheck(manifestText); write(MANIFEST, manifestText);
  process.stdout.write(JSON.stringify({ runId, classification: CLASSIFICATION, testCount: 6, passCount: 6, fixtureCount: fixtureNames.length, rawSha256: hashFile(RAW).sha256, reportSha256: hashFile(REPORT).sha256, manifestSha256: hashFile(MANIFEST).sha256, manifestAggregateSha256: aggregateSha256, preimages: Object.fromEntries(PREIMAGES.map((x) => [x, hashFile(x).sha256])), pipelineRecommendation: "2/5_PENDING_INDEPENDENT_REVIEW", nextEconomicsGate }) + "\n");
}

main();
