#!/usr/bin/env node
"use strict";

// Offline validator. Rebuilds the two targets and replays immutable patching.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cash-v3");
const NAME = "critical-etherfi-cashmodule-source-runtime-continuity-r3";
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const EXPECTED_CLASSIFICATION = "INFORMATIONAL/CLOSED-CURRENT-PIN/REVIEWER-R3/CASHMODULE-SETTERS-IMMUTABLE-PATCHED-EXACT-SOURCE-RUNTIME/ACTIVE-TOKEN-DIRECT-BEHAVIOR-NEGATIVE/NO-ATTACKER-GAIN";
const abs = (rel) => path.join(ROOT, rel);
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const normalized = (data) => Buffer.from(data.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
const refsSignature = (refs) => JSON.stringify(refs.map((row) => [row.start, row.length]));
let validations = 0;
function check(value, message) { if (!value) throw new Error(message); validations++; }
function patch(object, localRefs, mappings) {
  const bytes = Buffer.from(object.replace(/^0x/, ""), "hex");
  for (const refs of Object.values(localRefs)) {
    const mapping = mappings.find((row) => refsSignature(row.references) === refsSignature(refs));
    if (!mapping) throw new Error("immutable mapping unavailable");
    const value = Buffer.from(mapping.value.replace(/^0x/, ""), "hex");
    for (const ref of refs) value.copy(bytes, ref.start);
  }
  return `0x${bytes.toString("hex")}`;
}

const raw = JSON.parse(fs.readFileSync(abs(RAW), "utf8"));
const manifest = JSON.parse(fs.readFileSync(abs(MANIFEST), "utf8"));
check(raw.classification === EXPECTED_CLASSIFICATION, "classification mismatch");
check(raw.correction.exactSourceRuntimeContinuity === true, "continuity gate false");
check(raw.binding.deployedWithdrawalStateMachineSemanticsJoined === true, "deployed semantics not joined");
check(raw.binding.deployedSentinelRecipientBehaviorJoined === true, "sentinel semantics not joined");
check(raw.binding.deployedOptionalReturnConsumptionPrimitiveJoined === true, "optional-return semantics not joined");
check(raw.safety.rpcInventoryRead === false && raw.safety.rpcCalls === 0 && raw.safety.fork === false && raw.safety.transactions === false && raw.safety.signedActions === false, "safety gate mismatch");
check(raw.components.length === 2, "component count mismatch");
for (const row of raw.components) {
  check(row.sourceMatchCount === row.sourceCount && row.sourceBindings.every((binding) => binding.match), `${row.component} source gate failed`);
  for (const binding of row.sourceBindings) {
    const file = path.resolve(TARGET, binding.path);
    check(file.startsWith(`${TARGET}${path.sep}`) && fs.existsSync(file), `source unavailable: ${binding.path}`);
    check(ethers.keccak256(normalized(fs.readFileSync(file))).toLowerCase() === binding.expectedKeccak256.toLowerCase(), `source hash mismatch: ${binding.path}`);
  }
  check(row.compilation.compilerVersion === "0.8.28+commit.7893614a", `${row.component} compiler mismatch`);
  const settings = row.compilation.compilerSettings;
  check(settings.optimizer.enabled === true && settings.optimizer.runs === 0 && settings.evmVersion === "cancun" && settings.viaIR === false && settings.metadata.bytecodeHash === "none" && settings.metadata.appendCBOR === true, `${row.component} settings mismatch`);
  check(row.runtime.patchedEqualsOnchain === true && row.runtime.localArtifactEqualsServiceRecompile === true, `${row.component} retained runtime gate false`);
  check(row.runtime.patchedLocalKeccak256 === row.runtime.onchainKeccak256, `${row.component} retained runtime hash mismatch`);
}
check(raw.currentConfigurationGate.configuredWithdrawalTokens === 20 && raw.currentConfigurationGate.directBehaviorProbes === 60 && raw.currentConfigurationGate.standardBooleanExact === 20, "token gate counts mismatch");
check(raw.currentConfigurationGate.falseReturnObserved === 0 && raw.currentConfigurationGate.feeOrPartialObserved === 0 && raw.currentConfigurationGate.unresolved === 0 && raw.currentConfigurationGate.attackerGainRaw === "0", "token negative gate mismatch");
check(raw.conclusion.routePositive === 0 && raw.conclusion.executableNow === 0 && raw.conclusion.signedActionJustified === false, "route gate mismatch");
for (const record of manifest.records) {
  const data = fs.readFileSync(abs(record.path));
  check(data.length === record.bytes && sha(data) === record.sha256, `manifest record mismatch: ${record.path}`);
}
const aggregate = sha(manifest.records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"));
check(aggregate === manifest.aggregateSha256, "manifest aggregate mismatch");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cashmodule-continuity-r3-validator-"));
try {
  const out = path.join(temp, "out");
  const cache = path.join(temp, "cache");
  const sources = raw.localBuild.targetedSources;
  const build = spawnSync("forge", ["build", ...sources, "--root", TARGET, "--out", out, "--cache-path", cache, "--no-cache", "--offline"], { cwd: ROOT, encoding: "utf8", timeout: 1_200_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  check(build.status === 0, "offline validator build failed");
  for (const row of raw.components) {
    const artifact = JSON.parse(fs.readFileSync(path.join(out, `${row.component}.sol`, `${row.component}.json`), "utf8"));
    const object = artifact.deployedBytecode.object;
    const patched = patch(object, artifact.deployedBytecode.immutableReferences, row.runtime.immutableMappings);
    check(ethers.keccak256(object) === row.runtime.unpatchedLocalKeccak256, `${row.component} local artifact changed`);
    check(ethers.keccak256(patched) === row.runtime.onchainKeccak256, `${row.component} immutable-patched runtime mismatch`);
    check((patched.length - 2) / 2 === row.runtime.bytes, `${row.component} runtime length mismatch`);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, validations, runId: raw.runId, classification: raw.classification, coreRuntime: raw.components[0].runtime.onchainKeccak256, settersRuntime: raw.components[1].runtime.onchainKeccak256, branchPipeline: raw.conclusion.branchPipeline, globalHighestPipeline: raw.conclusion.globalHighestPipeline, manifestAggregateSha256: manifest.aggregateSha256 }, null, 2));
