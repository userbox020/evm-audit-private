#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RELATIVE_OUTPUT = "reports/raw/fast/40acres-legacy-jit-base-a-state-runtime-v2.json";
const EXPECTED_SHA256 = "78f2fe9cdd470137725fdf932398eceb47a9735c2e8afb8cddbf05be6457458c";
const PACKAGE_ID = "critical-40acres-legacy-jit-deployment-step2-v2";
const SOURCE_COMMIT = "0792fd368635b0f91f7094250d7dfbae7511aaba";
const MANIFEST_SHA256 = "4cd97164240268a500a54dbce17f585cd69a72cc5b7647a551110f56eb13dc4a";
const PROVENANCE_SHA256 = "8f729b401f516fe7b6c585e1197bd143f8b54e862272f99e4c18cf011ae53db7";
const PREDECESSOR_SHA256 = "976adec0d97c166b122e6803f178e4b4314a61ff31e4d8736ff62eecdcb4c612";
let checks = 0;

function check(value, message) {
  checks += 1;
  assert.ok(value, `check ${checks}: ${message}`);
}
function equal(actual, expected, message) {
  checks += 1;
  assert.deepEqual(actual, expected, `check ${checks}: ${message}`);
}
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function assertNoDangerousLeakage(value) {
  const dangerousKeys = new Set([
    "authorization", "calldata", "cookie", "endpoint", "headers", "privatekey", "rawresponse",
    "requestbody", "responsebody", "secret", "secretkey", "session", "signature", "signedtransaction", "url"
  ]);
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (dangerousKeys.has(key.replaceAll("_", "").toLowerCase())) throw new Error(`dangerous output key: ${key}`);
      if (child && typeof child === "object") stack.push(child);
    }
  }
  const text = JSON.stringify(value);
  check(!/(?:https?|wss?):\/\//iu.test(text), "no URL content");
  check(!/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]+|\bBasic\s+[A-Za-z0-9+/=]+)/u.test(text), "no credential content");
  check(!/"(?:password|private[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token)"\s*:/iu.test(text), "no secret-bearing fields");
}

function inspectOwnSource() {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const forbidden = [
    ["node:", "http"].join(""), ["node:", "https"].join(""), ["node:", "net"].join(""),
    ["node:", "tls"].join(""), ["child_", "process"].join(""), ["globalThis.", "fetch"].join(""),
    ["rpc_", "endpoints.txt"].join(""), ["graphql_", "endpoints.txt"].join(""), [".e", "nv"].join("")
  ];
  for (const token of forbidden) check(!source.includes(token), `validator source excludes ${token}`);
}

async function main() {
  check(process.argv.length === 2, "validator accepts no arguments");
  inspectOwnSource();

  const workspaceReal = path.resolve(fs.realpathSync(ROOT));
  const parent = path.resolve(ROOT, "reports", "raw", "fast");
  check(fs.existsSync(parent), "fixed parent exists");
  check(!fs.lstatSync(parent).isSymbolicLink(), "fixed parent is not a symlink");
  const parentReal = path.resolve(fs.realpathSync(parent));
  equal(parentReal.toLowerCase(), parent.toLowerCase(), "fixed parent canonical path");
  check(parentReal.toLowerCase().startsWith(`${workspaceReal.toLowerCase()}${path.sep}`), "fixed parent remains under workspace");

  const outputPath = path.resolve(ROOT, ...RELATIVE_OUTPUT.split("/"));
  check(fs.existsSync(outputPath), "fixed output exists");
  check(!fs.lstatSync(outputPath).isSymbolicLink(), "fixed output is not a symlink");
  const outputReal = path.resolve(fs.realpathSync(outputPath));
  equal(outputReal.toLowerCase(), outputPath.toLowerCase(), "fixed output canonical path");
  check(outputReal.toLowerCase().startsWith(`${parentReal.toLowerCase()}${path.sep}`), "fixed output remains under fixed parent");

  const fd = fs.openSync(outputPath, "r");
  let bytes;
  try { bytes = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
  equal(digest(bytes), EXPECTED_SHA256, "fixed output SHA256");
  const output = JSON.parse(bytes.toString("utf8"));

  const runnerPath = path.join(HERE, "critical-40acres-legacy-jit-deployment-step2-v2-runner.mjs");
  const beforeImport = { outputSha256: digest(fs.readFileSync(outputPath)), outputMtime: fs.statSync(outputPath).mtimeMs };
  const runner = await import(pathToFileURL(runnerPath).href);
  const afterImport = { outputSha256: digest(fs.readFileSync(outputPath)), outputMtime: fs.statSync(outputPath).mtimeMs };
  equal(afterImport, beforeImport, "runner import is side-effect-free for fixed output");
  check(runner.validateOutput(output), "reuse runner schema/internal-consistency validator without invoking main");

  equal([output.schemaVersion, output.packageId, output.stage, output.source?.commit, output.captureExecuted],
    [1, PACKAGE_ID, "STATE_RUNTIME_ONLY", SOURCE_COMMIT, true], "package/schema/stage/source/capture binding");
  equal(output.transport, { mode: "JSON_RPC_SINGLETON_HTTP", automaticMultiRequestFallback: false }, "singleton transport binding");
  equal(output.predecessor, { packageId: "critical-40acres-legacy-jit-deployment-step2", outputSha256: PREDECESSOR_SHA256,
    transportStatus: "V1_TRANSPORT_INCONCLUSIVE", causeInference: false }, "predecessor binding");
  equal(output.validationSeparation,
    "RUNNER_VALIDATES_RAW_IN_PROCESS; POST_OUTPUT_VALIDATOR_CHECKS_SCHEMA_AND_INTERNAL_CONSISTENCY_ONLY", "validation separation");
  equal([output.localProvenance?.verifiedBeforeRpc, output.localProvenance?.manifestSha256,
    output.localProvenance?.provenanceAggregateSha256], [true, MANIFEST_SHA256, PROVENANCE_SHA256], "local provenance binding");
  equal([output.artifacts?.manifestSha256, output.artifacts?.provenanceAggregateSha256, output.artifacts?.sourceCommit],
    [MANIFEST_SHA256, PROVENANCE_SHA256, SOURCE_COMMIT], "artifact provenance binding");

  equal(output.counts, {
    rpcElements: 13,
    httpRequests: 13,
    dispatchedHttpRequests: 13,
    responseBytes: 10724,
    retries: 0,
    concurrency: 1,
    byScope: {
      "chain:base": { rpcElements: 2, httpRequests: 2 },
      "candidate:A": { rpcElements: 11, httpRequests: 11 }
    }
  }, "exact singleton request accounting");

  equal(output.chains?.length, 1, "exactly one chain");
  equal(output.chains[0], {
    label: "base",
    chainId: "8453",
    pin: {
      number: "49504288",
      hash: "0x1a232cc2c0c6cf349cf21252ee661a29126a2be13485450fedb9b06427779741",
      timestamp: "1785797923",
      finalityMethod: "finalized"
    },
    error: null
  }, "exact finalized Base pin");

  equal(output.candidates?.length, 1, "exactly one candidate");
  const candidate = output.candidates[0];
  equal([candidate.id, candidate.chain, candidate.chainId, candidate.loan, candidate.expectedVault, candidate.provenance,
    candidate.applicability, candidate.sourceCommit], ["A", "base", "8453", "0x87f18b377e625b62c708d5f6ea96ec193558efd0",
    null, "OFFICIAL_REPO_LIVE_LEGACY_LOAN", "LEGACY_V2_CLAIM_CANDIDATE", SOURCE_COMMIT], "candidate A identity/provenance");
  equal([candidate.vault, candidate.calls, candidate.code, candidate.slots, candidate.formulas, candidate.terminal],
    [null, null, null, null, null, null], "unexecuted state/runtime fields remain null");
  equal(candidate.runtime, {
    family: "UNKNOWN",
    applicabilityProven: false,
    equivalence: null,
    promotionMode: "EXACT_FULL_RUNTIME_WITH_VERIFIED_REFERENCES",
    rawRuntimeValidatedInProcess: false,
    postOutputValidatorRawCodeAccess: false,
    referenceEvidence: null,
    promotionBlockers: [],
    loanArtifact: null,
    vaultArtifact: null
  }, "unknown runtime classification");
  equal(candidate.rawRuntimeValidatedInProcess, false, "raw runtime validation did not complete");
  equal(candidate.gates, { finality: true, topology: null, runtime: null, linkage: null, accounting: null,
    terminal: null, currentImpactClosed: null, paused: null }, "only finality gate executed");
  equal(candidate.errors, ["HTTP_FAILURE"], "single candidate error");
  equal([candidate.historyEligible, output.historyEligibleCount], [false, 0], "history remains ineligible");

  assertNoDangerousLeakage(output);
  process.stdout.write(`${JSON.stringify({ status: "PASS", checks, artifactPath: RELATIVE_OUTPUT,
    artifactSha256: EXPECTED_SHA256, postValidationMode: "OFFLINE_FIXED_ARTIFACT_INTEGRITY_AND_INTERNAL_CONSISTENCY_ONLY",
    rawHttpEvidenceRecovered: false, deploymentInferenceMade: false, networkReads: 0 }, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
