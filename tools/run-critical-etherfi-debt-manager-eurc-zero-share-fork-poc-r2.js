#!/usr/bin/env node
"use strict";

// Reviewer R2 execution-evidence runner. It reruns only the authorized
// ephemeral local Optimism fork at the reviewed fixed pin. Endpoint inventory
// stays in memory; upstream URLs, provider identities, and raw RPC are omitted.
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const net = require("net");
const path = require("path");
const { loadRpcUrls, rpcCall, PUBLIC_FALLBACKS } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cash-v3");
const R1_RUNNER = path.join(ROOT, "tools", "run-critical-etherfi-debt-manager-eurc-zero-share-fork-poc.js");
const PIN = 154624560, PIN_HEX = `0x${PIN.toString(16)}`;
const PIN_HASH = "0x99e06b23d27f439a7567f5e193d94f517eb5d54e97230713d1795abb2fa1867a";
const MANAGER = "0x0078C5a459132e279056B2371fE8A8eC973A9553";
const EXPECTED_TESTS = [
  "testBoundaryMinusOneVersusExactAndSafeReference()",
  "testEURCLocalDealSlotDiscovery()",
  "testExactThresholdMatrixAndConservation()",
  "testForkBindingsAndPermissionlessSurface()",
  "testRepeatedVictimsFeasible()",
  "testSnapshotRollbackDeterminism()",
];
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const fail = (code) => { const e = new Error(code); e.code = code; throw e; };
const sanitize = (text) => String(text).replace(/(?:https?|wss?):\/\/[^\s"']+/gi, "[REDACTED_URL]").replace(/(?:authorization|x-api-key|api-key|apikey|api_key|bearer|cookie)\s*[:=]\s*[^\s,}\]]+/gi, "[REDACTED_SECRET]");
const assertSafe = (text) => { if (/(?:https?|wss?):\/\//i.test(text) || /\[REDACTED_(?:URL|SECRET)\]/.test(text)) fail("SANITIZATION_REQUIRED"); };

async function freePort() {
  for (let port = 28645; port < 28745; port++) {
    const ok = await new Promise((resolve) => { const server = net.createServer(); server.once("error", () => resolve(false)); server.once("listening", () => server.close(() => resolve(true))); server.listen(port, "127.0.0.1"); });
    if (ok) return port;
  }
  fail("NO_LOCAL_PORT");
}

async function localRpc(port, method, params = [], timeoutMs = 8000) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: controller.signal });
    const body = await response.json(); if (body.error) fail(`LOCAL_RPC_${method}`); return body.result;
  } finally { clearTimeout(timer); }
}

async function waitLocal(port, child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) return false;
    try { if (await localRpc(port, "eth_chainId", [], 500) === "0xa") return true; } catch (_) { }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function startFork() {
  const candidates = [...new Set([...loadRpcUrls(), PUBLIC_FALLBACKS[10]].filter(Boolean))];
  for (const url of candidates) {
    if (await rpcCall(url, "eth_chainId", [], 3500) !== "0xa") continue;
    const header = await rpcCall(url, "eth_getBlockByNumber", [PIN_HEX, false], 6000);
    if (!header || String(header.hash).toLowerCase() !== PIN_HASH) continue;
    const code = await rpcCall(url, "eth_getCode", [MANAGER, PIN_HEX], 6000); if (!code || code === "0x") continue;
    const port = await freePort();
    const child = spawn("anvil", ["--fork-url", url, "--fork-block-number", String(PIN), "--port", String(port), "--host", "127.0.0.1", "--silent"], { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let diagnostics = ""; child.stdout.on("data", (x) => { diagnostics += x.toString(); }); child.stderr.on("data", (x) => { diagnostics += x.toString(); });
    if (await waitLocal(port, child)) {
      const localHeader = await localRpc(port, "eth_getBlockByNumber", [PIN_HEX, false]);
      if (localHeader && String(localHeader.hash).toLowerCase() === PIN_HASH) return { child, port, startupDiagnosticSha256: sha(diagnostics) };
    }
    child.kill();
  }
  fail("NO_FORK_CAPABLE_CHAIN10_ENDPOINT");
}

function runR1() {
  const run = spawnSync(process.execPath, [R1_RUNNER], { cwd: ROOT, encoding: "utf8", timeout: 1_200_000, maxBuffer: 32 * 1024 * 1024 });
  if (run.status !== 0) fail(`R1_RUN_FAILED:${sanitize(run.stderr)}`);
  assertSafe(run.stdout);
  const parsed = JSON.parse(run.stdout.trim());
  if (!parsed.deploymentRelevantPoCSucceeds || parsed.forge.testCount !== 6 || parsed.fork.pinNumber !== PIN || parsed.fork.pinHash !== PIN_HASH) fail("R1_RESULT_INVALID");
  return { stdout: run.stdout, parsed };
}

async function runForgeJson() {
  const fork = await startFork();
  try {
    const displayCommand = ["forge", "test", "--fork-url", "<EPHEMERAL_LOCAL_ANVIL>", "--fork-block-number", String(PIN), "--match-path", "test/critical/DebtManagerEURCZeroShareForkR2.t.sol", "--match-contract", "DebtManagerEURCZeroShareForkR2Test", "--skip", "SafeAssetRecoveryInvariant", "-vv"];
    const args = ["test", "--fork-url", `http://127.0.0.1:${fork.port}`, "--fork-block-number", String(PIN), "--match-path", "test/critical/DebtManagerEURCZeroShareForkR2.t.sol", "--match-contract", "DebtManagerEURCZeroShareForkR2Test", "--skip", "SafeAssetRecoveryInvariant", "-vv"];
    const run = spawnSync("forge", args, { cwd: TARGET, encoding: "utf8", timeout: 600_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    if (run.status !== 0) fail(`FORGE_JSON_FAILED:${sanitize(run.stderr || run.stdout)}`);
    assertSafe(run.stdout);
    const safeOutput = sanitize(run.stdout);
    const rows = [...safeOutput.matchAll(/\[PASS\]\s+([^\r\n]+?)\s+\(gas:\s*(\d+)\)/g)].map((m) => ({ name: m[1].trim(), status: "PASS", gas: Number(m[2]) })).filter((row) => EXPECTED_TESTS.includes(row.name)).sort((a, b) => a.name.localeCompare(b.name));
    if (rows.length !== 6 || new Set(rows.map((x) => x.name)).size !== 6) fail("FORGE_JSON_TEST_COUNT");
    for (const row of rows) if (row.status !== "PASS" || !Number.isInteger(row.gas) || row.gas <= 0) fail(`FORGE_JSON_TEST_FAILURE:${JSON.stringify(rows)}`);
    const boundedTranscriptLines = safeOutput.split(/\r?\n/).map((x) => x.trim()).filter((x) => /^(?:Compiling |Solc |Compiler run successful|No files changed|Ran \d+ tests? for |\[PASS\]|Suite result:|Ran \d+ test suite)/.test(x) && !/FORK_BALANCE_LOCATION/.test(x));
    const header = await localRpc(fork.port, "eth_getBlockByNumber", [PIN_HEX, false]);
    return canonical({ schemaVersion: 1, format: "SANITIZED_COMPLETE_FORGE_JSON_TEST_TRANSCRIPT_R2", command: displayCommand, chainId: 10, pinNumber: PIN, pinHash: header.hash, suite: "test/critical/DebtManagerEURCZeroShareForkR2.t.sol:DebtManagerEURCZeroShareForkR2Test", testCount: rows.length, passCount: rows.filter((x) => x.status === "PASS").length, failCount: rows.filter((x) => x.status !== "PASS").length, tests: rows, boundedTranscriptLines, rawForgeOutputSha256: sha(run.stdout), rawForgeOutputPersisted: false, decodedLogsPersisted: false, tracesPersisted: false, endpointArgumentPersisted: false, startupDiagnosticSha256: fork.startupDiagnosticSha256 });
  } finally { fork.child.kill(); }
}

function version(command, args) {
  const run = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", timeout: 120_000, windowsHide: true });
  if (run.status !== 0) fail(`VERSION_FAILED:${command}`);
  const lines = String(run.stdout || run.stderr).trim().split(/\r?\n/).filter(Boolean);
  return lines;
}

async function main() {
  const primary = runR1(), replay = runR1();
  const primaryCanonical = JSON.stringify(canonical(primary.parsed)), replayCanonical = JSON.stringify(canonical(replay.parsed));
  const projection = (value) => { const x = JSON.parse(JSON.stringify(value)); if (x.forge) delete x.forge.transcriptSha256; return canonical(x); };
  const primaryProjection = JSON.stringify(projection(primary.parsed)), replayProjection = JSON.stringify(projection(replay.parsed));
  const replayResult = canonical({ schemaVersion: 1, format: "DETERMINISTIC_REPLAY_R2", primaryStdoutSha256: sha(primary.stdout), replayStdoutSha256: sha(replay.stdout), primaryCanonicalSha256: sha(primaryCanonical), replayCanonicalSha256: sha(replayCanonical), primaryDeterministicProjectionSha256: sha(primaryProjection), replayDeterministicProjectionSha256: sha(replayProjection), stdoutByteEqual: primary.stdout === replay.stdout, canonicalResultEqual: primaryCanonical === replayCanonical, deterministicProjectionEqual: primaryProjection === replayProjection, excludedTransientFields: ["forge.transcriptSha256"], structuredProofEqual: JSON.stringify(canonical(primary.parsed.proof)) === JSON.stringify(canonical(replay.parsed.proof)), gasEqual: JSON.stringify(primary.parsed.proof.scenarios.map((x) => x.gas)) === JSON.stringify(replay.parsed.proof.scenarios.map((x) => x.gas)), snapshotRollbackDeterministic: primary.parsed.proof.rollbackSnapshotDeterministic && replay.parsed.proof.rollbackSnapshotDeterministic });
  if (!replayResult.deterministicProjectionEqual || !replayResult.structuredProofEqual || !replayResult.gasEqual || !replayResult.snapshotRollbackDeterministic) fail("DETERMINISTIC_REPLAY_FAILED");
  const forgeTranscript = await runForgeJson();
  const structuredProof = canonical({ schemaVersion: 1, format: "STRUCTURED_PROOF_PREIMAGE_R2", classification: primary.parsed.classification, deploymentRelevantPoCSucceeds: primary.parsed.deploymentRelevantPoCSucceeds, pipelineRecommendation: primary.parsed.pipelineRecommendation, fork: primary.parsed.fork, bindings: primary.parsed.bindings, proof: primary.parsed.proof, gates: primary.parsed.gates, safety: primary.parsed.safety });
  const tools = canonical({ schemaVersion: 1, format: "TOOL_VERSIONS_AND_COMMAND_R2", commandsContainEndpointArgument: false, node: version(process.execPath, ["--version"]), forge: version("forge", ["--version"]), anvil: version("anvil", ["--version"]), executionCommand: ["node", "tools/run-critical-etherfi-debt-manager-eurc-zero-share-fork-poc-r2.js"], forgeCommand: forgeTranscript.command });
  const bundle = { schemaVersion: 1, classification: primary.parsed.classification, primaryRunnerStdout: primary.stdout, replayRunnerStdout: replay.stdout, structuredProof, forgeTranscript, replayResult, tools, cacheSnapshot: { retained: false, reason: "No portable bounded local-only fork snapshot was retained; an anvil fork snapshot remains upstream-dependent and may include implementation-specific cache data. Independent review relies on hash-bound execution preimages, not an offline fork rerun." }, safety: { inventoryReadInMemoryOnly: true, endpointUrlPersisted: false, providerIdentifierPersisted: false, rawRpcPersisted: false, rawForgeJsonPersisted: false, privateKeyPersisted: false, ephemeralSecretPersisted: false, unboundedTracePersisted: false, broadcast: false, productionMutation: false, realFunds: false } };
  const text = JSON.stringify(bundle);
  assertSafe(text);
  process.stdout.write(`${text}\n`);
}

main().catch((error) => { process.stderr.write(`DebtManager EURC R2 evidence runner stopped: ${sanitize(error.code || error.message || "INTERNAL_FAILURE")}\n`); process.exit(1); });
