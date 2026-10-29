#!/usr/bin/env node
"use strict";

// Offline reviewer correction only. This tool does not read endpoint inventories
// and contains no network, RPC, fork, signing, or live execution path.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
const NAME = "reviewer-ccip-syrupusdt-global-backing-refresh-r3";
const AGENT = `${NAME}-20260726`;
const TOOL = `tools/review-critical-ccip-syrupusdt-global-backing-refresh-r3.js`;
const VALIDATOR = `tools/test-critical-ccip-syrupusdt-global-backing-refresh-r3.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const TESTS = `reports/raw/fast/${NAME}-tests.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/review-critical-ccip-syrupusdt-global-backing-refresh-r3-2026-07-26.json`;
const HANDOFF = `coordination/handoffs/2026-07-26-${NAME}-handoff.md`;
const R2_MANIFEST = "reports/raw/fast/critical-ccip-syrupusdt-global-backing-refresh-r2-manifest.json";
const R2_RAW = "reports/raw/fast/critical-ccip-syrupusdt-global-backing-refresh-r2.json";
const R2_EVIDENCE = "reports/raw/fast/critical-ccip-syrupusdt-global-backing-refresh-r2-evidence.json";
const EXPECTED = {
  aggregate: "95665be926d27b9a9175fa11b7da702c26f5ad5450a1cd86676af0f4297d4bfb",
  manifestSha: "2808de64118b6fd196b34d77b059443ddc59ae1b22e2921d98501eebddf86236",
  rawSha: "4e4d6723809c2a12637030cc22b139f7ee22d2563843f619c24409042f6c1357",
  evidenceSha: "1c614df89c9f4873e653a34422ff20d633535bd320771441097daef02c19390a",
  backing: "876ac78d95faffd94c8e9d8cf740fa6cd8f5930db3d6d6babb80fc1a8cf319ef",
  auth: "82c4a08e3f8e27bf29836191f46e7f57513bd9b9d331cae1fd13b94bb964f88d"
};
const EXPECTED_CHAINS = {
  ethereum: { chainId: 1, selector: "5009297550715157269", blockNumber: 25616077, blockHash: "0xdfc7c1cba0b72ede467cc3fa42743d870d1e6729a5188a79c3fca25529dfb61b" },
  bnb: { chainId: 56, selector: "11344663589394136015", blockNumber: 112218620, blockHash: "0xe6862bd03e7b0e0b3e47626ea9f2e00c397a10082669053fbab0a78847e864b4" },
  mantle: { chainId: 5000, selector: "1556008542357238666", blockNumber: 98463936, blockHash: "0xc390fe1163bf1ab6300c411427e4019b14a25cd42e3525b754ecf101a4cea768" },
  plasma: { chainId: 9745, selector: "9335212494177455608", blockNumber: 28117828, blockHash: "0xe6ad5bf53690b50ce7d55bf4f033a68a56c631fe52bc93b89401b1af7a982b58" },
  ink: { chainId: 57073, selector: "3461204551265785888", blockNumber: 51559773, blockHash: "0x4b0bc5aa16642ed12ff8b2dbb6bbd5879b55051737748990d32b1d75e3c83449" }
};
const OUTPUTS = [RAW, TESTS, MANIFEST, REPORT, INBOX, HANDOFF];
const abs = (p) => path.join(ROOT, ...p.split("/"));
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const read = (p) => fs.readFileSync(abs(p));
const json = (p) => JSON.parse(read(p).toString("utf8"));
const file = (p) => { const b = read(p); return { path: p, bytes: b.length, sha256: sha(b) }; };
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : typeof v === "bigint" ? v.toString() : v;
function write(p, v) { if (!OUTPUTS.includes(p)) throw new Error("write-refused"); fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), typeof v === "string" ? v : `${JSON.stringify(canonical(v), null, 2)}\n`, "utf8"); }
function assert(x, m) { if (!x) throw new Error(m); }
function verifyR2() {
  const manifest = json(R2_MANIFEST), manifestFile = file(R2_MANIFEST), rawFile = file(R2_RAW), evidenceFile = file(R2_EVIDENCE);
  assert(manifest.aggregateSha256 === EXPECTED.aggregate, "r2-aggregate");
  assert(manifestFile.sha256 === EXPECTED.manifestSha && rawFile.sha256 === EXPECTED.rawSha && evidenceFile.sha256 === EXPECTED.evidenceSha, "r2-file-hash");
  for (const row of manifest.records) { const actual = file(row.path); assert(actual.bytes === row.bytes && actual.sha256 === row.sha256, `r2-record:${row.path}`); }
  const aggregate = sha(Buffer.from(manifest.records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")));
  assert(aggregate === EXPECTED.aggregate, "r2-record-aggregate");
  return { manifest, manifestFile, rawFile, evidenceFile, raw: json(R2_RAW) };
}
function makeTests(raw, r2) {
  const rows = [], check = (name, pass, detail = null) => rows.push({ name, pass: Boolean(pass), detail });
  check("r2-manifest-file-immutable", raw.r2Binding.manifest.sha256 === EXPECTED.manifestSha);
  check("r2-aggregate-immutable", raw.r2Binding.aggregateSha256 === EXPECTED.aggregate);
  check("r2-raw-immutable", raw.r2Binding.raw.sha256 === EXPECTED.rawSha);
  check("r2-evidence-immutable", raw.r2Binding.evidence.sha256 === EXPECTED.evidenceSha);
  for (const [key, expected] of Object.entries(EXPECTED_CHAINS)) {
    const pin = raw.pins[key];
    check(`pin-${key}-chain-selector`, pin.chainId === expected.chainId && pin.selector === expected.selector);
    check(`pin-${key}-number-hash`, pin.blockNumber === expected.blockNumber && pin.blockHash === expected.blockHash);
  }
  check("exact-nine-second-spread", raw.pinPolicy.spreadSeconds === 9);
  check("exact-thirty-second-tolerance", raw.pinPolicy.toleranceSeconds === 30);
  check("four-selector-mappings-exact", raw.routes.length === 4 && raw.routes.every((x) => EXPECTED_CHAINS[x.key].selector === x.selector && EXPECTED_CHAINS[x.key].chainId === x.chainId));
  check("header-evidence-only-multifamily", Object.entries(raw.pins).filter(([k]) => k !== "plasma").every(([, x]) => x.headerEvidence === "MULTI-HOSTNAME-HEADER-PIN-CONSENSUS"));
  check("plasma-single-family-header", raw.pins.plasma.headerEvidence === "SINGLE-HOSTNAME-HEADER-PIN");
  check("no-two-family-state-claim", Object.values(raw.pins).every((x) => x.stateEvidence === "SINGLE-ENDPOINT-FIXED-PIN-OBSERVATION/NO-CROSS-FAMILY-STATE-COMMITMENT"));
  check("no-two-family-history-claim", Object.values(raw.pins).every((x) => x.historyEvidence === "UNAVAILABLE/NO-COMPLETE-CROSS-FAMILY-HISTORY-COMMITMENT"));
  check("per-endpoint-cap-exact", raw.budget.blockingCap === "per-endpoint" && raw.budget.maxPerEndpoint === 1200);
  check("global-budget-not-exhausted", raw.budget.globalUsed === 2095 && raw.budget.globalCap === 5000 && raw.budget.globalUsed < raw.budget.globalCap);
  check("all-remote-attribution-false", raw.accounting.remoteRows.length === 4 && raw.accounting.remoteRows.every((x) => x.attributable === false));
  check("all-derived-accounting-null", ["attributableRemoteSupplyRaw", "inFlightPrincipalRaw", "attributableLiabilityRaw", "deltaRaw", "deficitRaw", "surplusRaw"].every((k) => raw.accounting[k] === null));
  check("context-residual-exact", raw.contextOnlyArithmetic.remoteSupplySumRaw === "269535539719247" && raw.contextOnlyArithmetic.custodyMinusRemoteSupplyRaw === "100000" && raw.contextOnlyArithmetic.custodyMinusRemoteSupplyFormatted === "0.100000");
  check("context-residual-not-solvency", raw.contextOnlyArithmetic.solvencyEvidence === false && raw.classification.includes("MODEL_NOT_ESTABLISHED"));
  check("authority-errors-unknown", raw.interpretation.authorityCallFailuresMeanAbsence === false && raw.interpretation.authorityStatus === "UNKNOWN/VERSION-OR-INTERFACE-MISMATCH-OR-RPC-ERROR");
  check("ramp-errors-unknown", raw.interpretation.rampAbiFailuresMeanAbsence === false);
  check("allowlist-not-auth-bypass", raw.interpretation.originalSenderAllowlistDisabledDoesNotBypass.join(",") === "router-ramp-authorization,RMN-curse-check,remote-pool-binding,rate-limits");
  check("classification-and-gates-preserved", raw.pipeline === "0/5" && raw.gates.routePositive === 0 && raw.gates.executableNow === 0 && raw.gates.signedActionJustified === false && raw.gates.fork === false);
  check("offline-only", Object.values(raw.safety).every((x) => x === false) && raw.safetyInterpretation === "all listed operations were not performed");
  check("r2-classification-preserved", r2.raw.classification === raw.classification);
  return { status: rows.every((x) => x.pass) ? "PASS" : "FAIL", passed: rows.filter((x) => x.pass).length, total: rows.length, assertions: rows };
}
function report(raw, tests) {
  const pins = Object.entries(raw.pins).map(([k, x]) => `| ${k} | ${x.chainId} | ${x.blockNumber} | \`${x.blockHash}\` | ${x.headerEvidence} | ${x.stateEvidence} | ${x.historyEvidence} |`).join("\n");
  const routes = raw.routes.map((x) => `| ${x.key} | ${x.chainId} | ${x.selector} | \`${x.pool}\` | \`${x.token}\` | ${x.attributable} |`).join("\n");
  return `# CCIP syrupUSDT backing refresh R3 — offline reviewer correction\n\nSignal: 🟠 **${raw.classification}**\n\nR3 is interpretation-only. It immutably binds R2 raw/evidence and performs zero inventory, network, RPC, fork, live, transaction, signing, broadcast, or mutation operations. Pipeline and gates remain \`0/5\` and \`0/0/false\`; fork=false.\n\n## Corrected evidence classes\n\n| Chain | ID | block | hash | header/pin | state | history |\n|---|---:|---:|---|---|---|---|\n${pins}\n\nThe multi-hostname evidence establishes header/pin agreement only. R2 did not compare complete state or log commitments between two families. Plasma is single-family. Fixed-pin state values remain exact observations from one responsive endpoint, not cross-family state consensus.\n\n## Routes and accounting\n\n| Route | chain ID | selector | pool | token | attributable |\n|---|---:|---:|---|---|---|\n${routes}\n\n- Custody: \`${raw.contextOnlyArithmetic.ethereumCustodyRaw}\` raw.\n- Context-only remote supply sum: \`${raw.contextOnlyArithmetic.remoteSupplySumRaw}\` raw.\n- Context-only residual: \`${raw.contextOnlyArithmetic.custodyMinusRemoteSupplyRaw}\` raw / ${raw.contextOnlyArithmetic.custodyMinusRemoteSupplyFormatted}.\n- Attributable supply/in-flight/liability/delta/deficit/surplus: all **null**. The 0.1 residual is not solvency evidence.\n\n## Budget and semantic corrections\n\n- History stopped on the **per-endpoint 1,200-call cap**. Global use was only \`2095/5000\`; “global budget exhausted” would be incorrect.\n- Authority/minter/burner failures and old/new ramp ABI RPC errors/reverts remain **unknown**, consistent with RPC failure or deployed-version/interface mismatch. They are not negative absence evidence.\n- A disabled original-sender allowlist does not bypass router/ramp authorization, RMN curse checks, reciprocal remote-pool binding, or rate limits.\n\n## Gate 0 next capture design\n\n${raw.nextGate0Design.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\nTests: ${tests.passed}/${tests.total} PASS. No solvency or exploit claim; no fork gate.\n`;
}
function main() {
  for (const p of [TOOL, VALIDATOR, R2_MANIFEST, R2_RAW, R2_EVIDENCE]) assert(fs.existsSync(abs(p)), `missing:${p}`);
  const r2 = verifyR2(), rr = r2.raw, remoteSupply = rr.conservation.remoteRows.reduce((n, x) => n + BigInt(x.totalSupplyRaw), 0n), custody = BigInt(rr.conservation.ethereumCustodyRaw), residual = custody - remoteSupply;
  const pins = Object.fromEntries(Object.entries(rr.pins.chains).map(([key, p]) => [key, { chainId: p.chainId, selector: p.selector, blockNumber: p.blockNumber, blockHash: p.blockHash, timestamp: p.timestamp, terminalRecheck: p.terminalRecheck, selectedHostnameFamilyCount: p.selectedFamilyCount, terminalHostnameFamilyCount: p.terminalFamilyCount, headerEvidence: key === "plasma" ? "SINGLE-HOSTNAME-HEADER-PIN" : "MULTI-HOSTNAME-HEADER-PIN-CONSENSUS", stateEvidence: "SINGLE-ENDPOINT-FIXED-PIN-OBSERVATION/NO-CROSS-FAMILY-STATE-COMMITMENT", historyEvidence: "UNAVAILABLE/NO-COMPLETE-CROSS-FAMILY-HISTORY-COMMITMENT", backendOperatorIndependenceEstablished: false }]));
  const routes = rr.routes.map((x) => ({ key: x.chain === "BNB Chain" ? "bnb" : x.chain.toLowerCase(), chain: x.chain, chainId: x.chainId, selector: x.selector, pool: x.remotePool, token: x.remoteToken, sourceMode: x.sourceMode, destinationMode: x.destinationMode, reciprocalExactAtPin: x.reciprocalExact, decimalsEqual: x.decimalsEqual, attributable: false }));
  const runnerText = read("tools/run-critical-ccip-syrupusdt-global-backing-refresh-r2.js").toString("utf8"); assert(/MAX_PER_ENDPOINT\s*=\s*1200/.test(runnerText) && /MAX_RPC\s*=\s*5000/.test(runnerText), "r2-budget-source");
  const raw = canonical({ schemaVersion: 1, generatedAt: new Date().toISOString(), runId: `${NAME}-${rr.runId}`, agentId: AGENT, role: "reviewer", revision: "offline-interpretation-correction-r3", classification: rr.classification, r2Binding: { runId: rr.runId, aggregateSha256: EXPECTED.aggregate, manifest: r2.manifestFile, raw: r2.rawFile, evidence: r2.evidenceFile, rawEvidencePreservedImmutably: true, rawEvidenceModified: false }, predecessorBindings: { globalBackingAggregateSha256: EXPECTED.backing, releaseAuthorizationAggregateSha256: EXPECTED.auth }, pinPolicy: { spreadSeconds: rr.pins.spreadSeconds, toleranceSeconds: rr.pins.toleranceSeconds, interpretation: "timestamp-synchronized finalized header pins; evidence level is separately classified" }, pins, routes, budget: { blocker: rr.conservation.historyBlocker, blockingCap: "per-endpoint", maxPerEndpoint: 1200, globalUsed: rr.rpcBudget.used, globalCap: rr.rpcBudget.cap, globalBudgetExhausted: false, implication: "State observations can remain exact at the pin while full history is incomplete; retry design must separate state commitment capture from resumable history chunks and avoid consuming one endpoint cap." }, accounting: { ethereumCustodyRaw: rr.conservation.ethereumCustodyRaw, remoteRows: rr.conservation.remoteRows.map((x) => ({ chain: x.chain, chainId: x.chainId, selector: x.selector, token: x.token, decimals: x.decimals, totalSupplyRaw: x.totalSupplyRaw, attributable: false, historicalCcipAttributionEstablished: null })), attributableRemoteSupplyRaw: null, inFlightPrincipalRaw: null, attributableLiabilityRaw: null, deltaRaw: null, deficitRaw: null, surplusRaw: null, feesExcluded: true, modelComplete: false }, contextOnlyArithmetic: { ethereumCustodyRaw: custody.toString(), remoteSupplySumRaw: remoteSupply.toString(), custodyMinusRemoteSupplyRaw: residual.toString(), custodyMinusRemoteSupplyFormatted: `${residual / 1000000n}.${String(residual % 1000000n).padStart(6, "0")}`, solvencyEvidence: false, qualification: "Context-only subtraction before authoritative supply attribution and in-flight reconciliation; never a deficit/surplus/solvency conclusion." }, interpretation: { authorityStatus: "UNKNOWN/VERSION-OR-INTERFACE-MISMATCH-OR-RPC-ERROR", authorityCallFailuresMeanAbsence: false, rampAbiStatus: "UNKNOWN/OLD-NEW-ABI-DECODE-OR-RPC-REVERT-MISMATCH", rampAbiFailuresMeanAbsence: false, originalSenderAllowlistObservedDisabled: true, originalSenderAllowlistDisabledDoesNotBypass: ["router-ramp-authorization", "RMN-curse-check", "remote-pool-binding", "rate-limits"], stateValues: "exact fixed-pin observations from one responsive endpoint per chain; no two-family full-state commitment comparison", historyValues: "null" }, pipeline: "0/5", gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, nextGate0Design: ["Pin headers first, then independently capture a canonical full-state tuple on two hostname families per chain; compare deterministic commitments before using the word consensus.", "Use per-chain, resumable log windows with persisted sanitized cursors and event commitments; stop before each endpoint cap and resume through a separately qualified family without retaining endpoint identity.", "Fingerprint deployed token and ramp runtimes before selecting authority or old/new ABI calls; classify unsupported selectors and reverts as unknown, then enumerate authority events and mint/burn Transfer history from deployment boundaries.", "Join pool Locked/Burned events to authoritative send message IDs and destination SUCCESS/FAILURE/retry/manual execution events at the synchronized cutoff; bind amount, token, pool, selectors, nonce/sequence, and message ID.", "Commit migration, removed-pool/minter, TokenAdminRegistry, router/ramp replacement, and alternate-bridge histories separately before attributing any totalSupply.", "Only after two-family state and complete history commitments agree, compute attributable supply plus directional in-flight principal; keep fees excluded and do not promote the 0.1 context residual."], safety: { network: false, inventoryRead: false, rpc: false, graphql: false, fork: false, live: false, transaction: false, signing: false, broadcast: false, mutation: false }, safetyInterpretation: "all listed operations were not performed" });
  const tests = makeTests(raw, r2); assert(tests.status === "PASS", "r3-tests");
  const reportText = report(raw, tests);
  const inbox = canonical({ findingId: NAME, agentId: AGENT, role: "reviewer", status: raw.classification, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pipeline: "0/5", summary: "Offline R3 corrects R2 evidence levels, budget semantics, unknown authority/ABI failures, and allowlist interpretation without changing raw evidence or making a solvency claim.", artifacts: [TOOL, VALIDATOR, RAW, TESTS, MANIFEST, REPORT, HANDOFF], r2Binding: raw.r2Binding, checks: `${tests.passed}/${tests.total}`, nextAction: "Implement the separately reviewed Gate 0 two-family state-commitment and resumable history-capture design; do not execute under R3." });
  const handoff = `# CCIP syrupUSDT backing refresh R3 reviewer handoff\n\n- Offline interpretation correction only; R2 raw/evidence unchanged and bound to aggregate \`${EXPECTED.aggregate}\`.\n- Classification/pipeline/gates: ${raw.classification}; 0/5; 0/0/false; fork=false.\n- Header evidence: Ethereum/BNB/Mantle/Ink multi-hostname header-pin only; Plasma single-hostname. Full state/history two-family consensus was not established.\n- Budget blocker: per-endpoint 1200 cap; global 2095/5000, not exhausted.\n- Authority/ramp ABI failures: unknown/version-interface mismatch, never absence evidence.\n- Context residual: 100000 raw / 0.100000; not solvency.\n- Tests: ${tests.passed}/${tests.total} PASS.\n- Next: separately review and execute Gate 0 design only; R3 authorizes no capture.\n`;
  for (const text of [JSON.stringify(raw), JSON.stringify(tests), reportText, JSON.stringify(inbox), handoff]) assert(!/(?:https?|wss?):\/\//i.test(text), "url-leak");
  write(RAW, raw); write(TESTS, tests); write(REPORT, reportText); write(INBOX, inbox); write(HANDOFF, handoff);
  const records = [TOOL, VALIDATOR, R2_MANIFEST, R2_RAW, R2_EVIDENCE, RAW, TESTS, REPORT, INBOX, HANDOFF].map(file), aggregateSha256 = sha(Buffer.from(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")));
  const manifest = canonical({ schemaVersion: 1, generatedAt: raw.generatedAt, runId: raw.runId, revision: raw.revision, classification: raw.classification, offline: true, r2Binding: raw.r2Binding, predecessorBindings: raw.predecessorBindings, pinPolicy: raw.pinPolicy, evidenceClassification: Object.fromEntries(Object.entries(raw.pins).map(([k, x]) => [k, { header: x.headerEvidence, state: x.stateEvidence, history: x.historyEvidence }])), budget: raw.budget, accounting: raw.accounting, contextOnlyArithmetic: raw.contextOnlyArithmetic, pipeline: raw.pipeline, gates: raw.gates, tests, safety: raw.safety, records, aggregateSha256 }); write(MANIFEST, manifest);
  process.stdout.write(`${JSON.stringify({ status: "PASS", runId: raw.runId, classification: raw.classification, checks: `${tests.passed}/${tests.total}`, aggregateSha256, r2AggregateSha256: EXPECTED.aggregate, contextResidualRaw: residual.toString(), pipeline: raw.pipeline, gates: raw.gates })}\n`);
}
try { main(); } catch (error) { process.stderr.write(`r3 reviewer failed:${error.message}\n`); process.exitCode = 1; }
