#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { Interface, AbiCoder, id } = require("ethers");
const ROOT = path.resolve(__dirname, ".."), OUTPUT = "reports/raw/fast/aave-ethereum-emode-47-48-r12-workflow.json";
const RUNNER = "tools/review-aave-ethereum-emode-47-48-r12.js", TEST = "tools/test-review-aave-ethereum-emode-47-48-r12.js";
const PAGE = "C:/Users/MiPC/.local/share/opencode/tool-output/tool_083f50b95001rN37pjhai1EbJv";
const PAGE_SHA = "822f295bb2cfb1339dae912420e34339492717f8cfa3af9c0a75218c4e073084";
const TX = "0x4def40d727c2e9ebe7c3282f303601217c3a2f717e5aeb666ec42b9150b807b3";
const R11 = "reports/raw/fast/aave-ethereum-emode-47-48-r11-source";
const PINS = Object.freeze({
  "reports/raw/fast/aave-ethereum-emode-47-48-r3.json": "8d92d8ae869e98cd3d4708826cee763dcd34760f627843209e04f4d426e9ae72",
  "tools/run-aave-ethereum-emode-47-48-r3.js": "4a1eee450e7e2f41c873d7d36d4aef8d118f817ba459c1bf88049b80da483d29",
  [`${R11}/report.json`]: "ef98a5a8c6d6bd32110d18e4630e5f414920d318804ae4d13b4f1a9c20bedb36",
  [`${R11}/router/compiler.output.json`]: "0640a63413eeff894efc5391d279516ac31c926337952091b61e81f682b2e278",
  [`${R11}/riskOracle/compiler.output.json`]: "254e82cd49826df0ce89c9ad7bd060cdb776aa10648aafb6ca48e509f2b063d4"
});
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object"
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value);
const check = (condition, code) => { if (!condition) throw Error(code); };
function read(file, hash) {
  const full = path.resolve(ROOT, file), before = fs.lstatSync(full);
  check(before.isFile() && !before.isSymbolicLink() && before.size <= 32 * 1024 * 1024 && path.resolve(fs.realpathSync(full)) === full, "INPUT_PATH_INVALID");
  const bytes = fs.readFileSync(full), after = fs.lstatSync(full);
  check(before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && (!hash || sha(bytes) === hash), "INPUT_HASH_MISMATCH");
  return bytes;
}
function authority() {
  const files = Object.fromEntries(Object.entries(PINS).map(([file, hash]) => [file, read(file, hash)]));
  const r3 = JSON.parse(files["reports/raw/fast/aave-ethereum-emode-47-48-r3.json"]), report = JSON.parse(files[`${R11}/report.json`]);
  check(r3.sha256 === sha(stable(r3.report)) && report.status === "BOTH_EXACT_HISTORICAL_RUNTIME_MATCH" && stable(report.historicalPin) === stable(r3.report.pin), "PRIOR_EVIDENCE_INVALID");
  for (const key of ["router", "riskOracle"]) check(report.results[key].identity.keccak256 === r3.report.observations.current.code[key].keccak256
    && report.results[key].identity.bytes === r3.report.observations.current.code[key].bytes, "SOURCE_IDENTITY_MISMATCH");
  const router = new Interface(JSON.parse(files[`${R11}/router/compiler.output.json`]).contracts[report.results.router.target].LlamaguardRiskOracleRouter.abi);
  const oracle = new Interface(JSON.parse(files[`${R11}/riskOracle/compiler.output.json`]).contracts[report.results.riskOracle.target].RiskOracle.abi);
  const r3Runner = require("./run-aave-ethereum-emode-47-48-r3.js");
  const receipt = r3.report.observations.receipts.find(row => row.transactionHash === TX);
  check(receipt?.receiptStatus === "success" && receipt.block.number === 25915775, "RECEIPT_CONTEXT_INVALID");
  return { r3, receipt, router, oracle, events: r3Runner.EVENTS, addresses: r3Runner.A };
}
function parsePage(html) {
  check(typeof html === "string" && Buffer.byteLength(html) <= 2 * 1024 * 1024, "PAGE_BYTE_CAP");
  const txs = [...html.matchAll(/<span\b[^>]*\bid=['"]spanTxHash['"][^>]*>(0x[0-9a-f]{64})<\/span>/gi)];
  check(txs.length === 1 && txs[0][1].toLowerCase() === TX && /href=['"]\/block\/25915775['"]/.test(html), "PAGE_TRANSACTION_MISMATCH");
  const start = html.indexOf('id="eventlog-tab-content"'), end = html.indexOf('id="accesslist-tab-content"', start);
  check(start >= 0 && end > start, "LOG_SECTION_MISSING");
  const section = html.slice(start, end), markers = [...section.matchAll(/<div\b[^>]*\bid=['"]logI_(\d+)['"][^>]*>/g)];
  check(markers.length > 0 && markers.length <= 64 && new Set(markers.map(m => m[1])).size === markers.length, "LOG_MARKERS_INVALID");
  const logs = [];
  for (let i = 0; i < markers.length; i++) {
    const logIndex = Number(markers[i][1]);
    if (logIndex < 134 || logIndex > 141) continue;
    const block = section.slice(markers[i].index, markers[i + 1]?.index ?? section.length);
    const emitters = [...block.slice(0, block.indexOf("Name</h6>")).matchAll(/<a\s+data-highlight-value\s+data-highlight-target=['"](0x[0-9a-f]{40})['"]/gi)];
    const names = [...block.matchAll(/id=['"]funcname_(\d+)['"][^>]*>([A-Za-z0-9_]+)\s*\(/g)];
    check(emitters.length === 1 && names.length === 1, `LOG_IDENTITY_AMBIGUOUS_${logIndex}_${emitters.length}_${names.length}`);
    const ordinal = names[0][1], name = names[0][2];
    const topicStart = block.indexOf("Topics</h6>"), dataStart = block.indexOf("Data</h6>", topicStart);
    check(topicStart >= 0, "TOPICS_MISSING");
    const topicHTML = block.slice(topicStart, dataStart < 0 ? block.length : dataStart);
    const badges = [...topicHTML.matchAll(/<span\b[^>]*class=['"]badge [^'"]*['"][^>]*>([0-3])(?::[^<]*)?<\/span>/g)];
    check(badges.length >= 1 && badges.length <= 4, "TOPICS_INVALID");
    const topics = badges.map((badge, n) => {
      check(Number(badge[1]) === n, "TOPIC_ORDER_INVALID");
      const part = topicHTML.slice(badge.index + badge[0].length, badges[n + 1]?.index ?? topicHTML.length);
      const hex = [...new Set((part.match(/0x[0-9a-f]{64}\b/gi) || []).map(v => v.toLowerCase()))];
      check(hex.length === 1, "TOPIC_HEX_AMBIGUOUS"); return hex[0];
    });
    const dataMatches = [...block.matchAll(new RegExp(`<[^>]+\\bid=['"]event_raw_data_${Number(ordinal) + 1}['"][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "g"))];
    let data;
    if (dataMatches.length === 0 && name === "AgentHubKickResultSuccess") data = "0x";
    else {
      check(dataMatches.length === 1, "RAW_DATA_MISSING");
      data = dataMatches[0][1].trim().replace(/^0x/, "");
      check(/^(?:[a-f0-9]{2})*$/i.test(data) && data.length <= 16384, "RAW_DATA_INVALID"); data = `0x${data.toLowerCase()}`;
    }
    logs.push({ logIndex, address: emitters[0][1].toLowerCase(), name, topics, data });
  }
  check(logs.length === 8 && logs.every((log, index) => log.logIndex === 134 + index), "SCOPED_LOG_SET_INVALID");
  return logs;
}
function inspect() {
  const bytes = read(PAGE, PAGE_SHA), logs = parsePage(bytes.toString("utf8"));
  return { pageSha256: sha(bytes), logs };
}
function validateEvents(logs, a = authority()) {
  const coder = AbiCoder.defaultAbiCoder(), expected = [{ index: 134, name: "ReportRouted", address: a.addresses.router, iface: a.router }];
  for (const entry of a.receipt.events) for (const [i, name] of ["UpdateInjected", "EModeCategoryAdded", "EModeCategoryIsolationChanged"].entries()) {
    expected.push({ index: entry.logIndices[i], name, address: i === 0 ? a.addresses.hub : a.addresses.configurator, iface: a.events, entry });
  }
  expected.push({ index: 141, name: "AgentHubKickResultSuccess", address: a.addresses.router, iface: a.router });
  check(logs.length === expected.length, "EVENT_SET_MISMATCH");
  let workflowId, publishSelector;
  for (let i = 0; i < expected.length; i++) {
    const spec = expected[i], log = logs[i];
    check(log.logIndex === spec.index && log.address === spec.address && log.name === spec.name, "EVENT_IDENTITY_MISMATCH");
    const fragment = spec.iface.getEvent(spec.name), decoded = spec.iface.decodeEventLog(fragment, log.data, log.topics), values = Array.from(decoded);
    if (spec.name === "ReportRouted") {
      workflowId = decoded.workflowId; publishSelector = decoded.publishSelector;
      check(workflowId !== `0x${"0".repeat(64)}` && decoded.riskOracle.toLowerCase() === a.addresses.riskOracle
        && publishSelector === a.oracle.getFunction("publishBulkRiskParameterUpdates").selector, "ROUTED_TARGET_MISMATCH");
    } else if (spec.name === "AgentHubKickResultSuccess") check(decoded.workflowId === workflowId, "WORKFLOW_DISAGREEMENT");
    else if (spec.name === "UpdateInjected") {
      const e = spec.entry;
      check(decoded.agentId === 6n && BigInt(decoded.market) === BigInt(e.categoryId) && decoded.updateId === BigInt(e.updateId)
        && log.topics[3] === id("EModeCategoryUpdate")
        && decoded.newValue === coder.encode(["uint256", "uint256", "uint256"], [e.ltvBps, e.liquidationThresholdBps, e.liquidationBonusFactorBps - 10000]), "INJECTION_CONTEXT_MISMATCH");
      values[2] = "EModeCategoryUpdate";
    } else if (spec.name === "EModeCategoryAdded") {
      const e = spec.entry;
      check(decoded.categoryId === BigInt(e.categoryId) && decoded.ltv === BigInt(e.ltvBps) && decoded.liquidationThreshold === BigInt(e.liquidationThresholdBps)
        && decoded.liquidationBonus === BigInt(e.liquidationBonusFactorBps) && decoded.oracle === `0x${"0".repeat(40)}` && decoded.label === e.label, "CATEGORY_CONTEXT_MISMATCH");
    } else check(decoded.categoryId === BigInt(spec.entry.categoryId) && decoded.isolated === spec.entry.isolated, "ISOLATION_CONTEXT_MISMATCH");
    const encoded = spec.iface.encodeEventLog(fragment, values);
    check(stable(encoded.topics) === stable(log.topics) && encoded.data === log.data, "NONCANONICAL_EVENT");
  }
  return { workflowId, router: a.addresses.router, riskOracle: a.addresses.riskOracle,
    publishSelector, publishFunction: "publishBulkRiskParameterUpdates", agentId: 6, categories: [47, 48],
    reportRoutedLogIndex: 134, kickSuccessLogIndex: 141, linkedExistingEventCount: 6 };
}
function prepare() {
  const a = authority(), bytes = read(PAGE, PAGE_SHA), logs = parsePage(bytes.toString("utf8")), locator = validateEvents(logs, a);
  const proposedRouterViews = ["owner", "pendingOwner", "updater", "guardian", "paused", "getWorkflowConfig", "routes", "getAgentIds"].map(name => {
    const fn = a.router.getFunction(name); check(fn.stateMutability === "view", "NON_VIEW_IN_PROPOSAL");
    return { target: a.addresses.router, signature: fn.format("sighash"), abi: JSON.parse(fn.format("json")),
      args: fn.inputs.length ? [locator.workflowId] : [] };
  });
  return { schema: "aave-ethereum-emode-47-48-r12-workflow/v1", status: "WORKFLOW_LOCATOR_RECOVERED_SINGLE_EXPLORER", locator, logs,
    provenance: { sourceURL: `https://etherscan.io/tx/${TX}/advanced`, responseRecord: PAGE, responseRecordSha256: PAGE_SHA,
      pageJavaScriptExecuted: false, transactionCalldataOrSignaturesInNormalizedArtifact: false, publicReceiptLookups: 1 },
    executionContext: { transactionHash: TX, block: a.receipt.block, transactionIndex: a.receipt.transactionIndex,
      receiptContextEvidence: "previous R3 provider-corroborated receipt", newWorkflowEventEvidence: "single-explorer; not yet provider-corroborated",
      coemissionOnly: true, causalTraceVerified: false },
    sourceBindingPin: a.r3.report.pin,
    proposedReadScope: { status: "SCOPED_NOT_IMPLEMENTED_OR_RUN", fixedReceipt: TX, corroborateNewEventLogIndices: [134, 141],
      statePin: a.r3.report.pin, routerViews: proposedRouterViews, workflowKeyEnumeration: false, discoveredAddressFollowing: false,
      prerequisite: "A separate reviewed bounded runner must corroborate the new event evidence before accepting this key for configuration evidence.",
      exclusions: ["No repeat source builds or generic R3/R10 capture", "No automatic forwarder calls or controller expansion", "No report submission or replay"] },
    gates: { workflowLocatorRecovered: true, workflowEventsCorroborated: false, workflowConfigurationBound: false,
      completeAuthorityVerification: false, completeRuntimeBinding: false, effectiveRangeSemanticsBound: false,
      routePositive: "unknown", executableNow: "unknown", signedActionJustified: false, fork: false },
    execution: { rpcRequests: 0, inventoryReads: 0, compilerInvocations: 0, transactions: 0 }, inputPins: PINS,
    limitations: ["R3 retained six eMode events, not the new router workflow events; its provider strength cannot be transferred to these new fields.",
      "Router ABI is bound at the later R3 state pin, not independently runtime-bound at this earlier transaction block.",
      "Matching event context supports a fixed locator, not complete workflow membership, intervening history, current configuration or report authentication.",
      "Router workflowId is a configuration key, not the forwarder's distinct workflowExecutionId."] };
}
function validate(report) {
  check(Number.isFinite(Date.parse(report?.generatedAt)), "REPORT_TIME_INVALID");
  const expected = { ...prepare(), generatedAt: report.generatedAt, runnerSha256: sha(read(RUNNER)), testsSha256: sha(read(TEST)) };
  check(stable(report) === stable(expected), "REPORT_MISMATCH"); return true;
}
function publish(root = ROOT) {
  const output = path.join(root, OUTPUT), parent = path.dirname(output);
  check(!fs.existsSync(output), "OUTPUT_EXISTS");
  check(fs.lstatSync(parent).isDirectory() && path.resolve(fs.realpathSync(parent)) === path.resolve(parent), "OUTPUT_PARENT_INVALID");
  const report = { ...prepare(), generatedAt: new Date().toISOString(), runnerSha256: sha(read(RUNNER)), testsSha256: sha(read(TEST)) };
  validate(report);
  const envelope = { sha256: sha(stable(report)), report }, bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`);
  const fd = fs.openSync(output, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  check(fs.readFileSync(output).equals(bytes), "PUBLICATION_MISMATCH"); return envelope;
}
function verify(root = ROOT) {
  const bytes = read(path.join(root, OUTPUT)), envelope = JSON.parse(bytes);
  check(Object.keys(envelope).sort().join() === "report,sha256" && envelope.sha256 === sha(stable(envelope.report)), "COMMITMENT_MISMATCH");
  validate(envelope.report);
  return { status: envelope.report.status, workflowId: envelope.report.locator.workflowId, logCount: envelope.report.logs.length,
    proposedRouterViews: envelope.report.proposedReadScope.routerViews.length, reportCommitment: envelope.sha256, fileSha256: sha(bytes), network: false };
}
function main(argv = process.argv.slice(2)) {
  try {
    check(argv.length === 1 && ["--inspect", "--check", "--publish", "--verify"].includes(argv[0]), "INVOCATION_INVALID");
    if (argv[0] === "--inspect") { authority(); console.log(JSON.stringify(inspect(), null, 2)); return; }
    if (argv[0] === "--check") { const report = prepare(); console.log(JSON.stringify({ status: report.status, locator: report.locator, proposedRouterViews: report.proposedReadScope.routerViews.length, network: false })); return; }
    if (argv[0] === "--publish") { publish(); }
    console.log(JSON.stringify(verify()));
  } catch (error) { console.log(JSON.stringify({ status: "FAILED", code: error.message })); process.exitCode = 2; }
}
if (require.main === module) main();
module.exports = { ROOT, OUTPUT, RUNNER, TEST, PAGE, PAGE_SHA, TX, PINS, sha, stable, read, authority, parsePage, validateEvents, prepare, validate, publish, verify };
