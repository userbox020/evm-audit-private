#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const runner = require("./beefy-balancer-v3-monad-deployment-binding-r1-runner");

let checks = 0;
function equal(actual, expected, message) { assert.deepStrictEqual(actual, expected, message); checks += 1; }
function check(value, message) { assert.ok(value, message); checks += 1; }
function independentAggregate(value) { const rows = [...value.artifacts.map((x) => `artifacts:${x.path}:${x.sha256}`),
  ...value.runtimeDependencyGraph.map((x) => `runtime:${x.path}:${x.sha256}`),
  ...value.localInputs.map((x) => `localInputs:${x.path}:${x.sha256}`)];
return crypto.createHash("sha256").update(rows.sort().join("\n")).digest("hex"); }
function pin(number = "100", hash = `0x${"a".repeat(64)}`, timestamp = "200") { return { number, hash, timestamp }; }
function header(value = pin()) { return { number: `0x${BigInt(value.number).toString(16)}`, hash: value.hash,
  timestamp: `0x${BigInt(value.timestamp).toString(16)}` }; }
function context(handler) { return { budget: new runner.Budget(() => 0), nextId: 0, rpc: handler }; }

async function main() {
  const fixture = JSON.parse(fs.readFileSync(path.join(runner.ROOT, ...runner.FIXTURE_REL.split("/")), "utf8"));
  equal(fixture.schemaVersion, 1, "fixture schema");
  equal(runner.CHAIN_ID, 143n, "Monad chain");
  equal(runner.STRATEGY, "0x9db4aa152d06206566187b26472583b3e59bd5c5", "strategy constant");
  equal(runner.BEEFY_VAULT, "0xd0331a023c35514c2ef99eb34ed868737e9dcea3", "vault constant");
  equal(runner.METADATA_ID, "balancerv3-monad-usdt0-ausd-usdc", "metadata id");
  const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const runId = `beefybalv3monad-r1-${stamp}-${"b".repeat(32)}`;
  equal(runner.parseArgs(["node", "runner", runner.CAPTURE_FLAG, "--run-id", runId]).runId, runId, "fresh run id");
  assert.throws(() => runner.parseArgs(["node", "runner", "--capture", "--run-id", runId]), /ARGS/u); checks += 1;

  const inventory = `[Monad]\nchainId=143 rpc=https://one.example/rpc [header: X-Key=secret]\n` +
    `{"chainId":143,"url":"https://two.example/rpc","headers":{"Authorization":"opaque"}}\n` +
    `chainId=1 rpc=https://ethereum.example/rpc`;
  const descriptors = runner.parseInventoryText(inventory);
  equal(descriptors.length, 2, "only explicit Monad HTTPS descriptors");
  check(descriptors.every((row) => row.url.protocol === "https:"), "HTTPS only");
  const secrets = runner.secretCorpus(descriptors);
  assert.throws(() => runner.assertNoSecrets({ endpoint: "https://one.example/rpc" }, secrets), /PROVIDER_MATERIAL/u); checks += 1;
  assert.throws(() => runner.assertNoSecrets({ note: "secret" }, secrets), /PROVIDER_MATERIAL/u); checks += 1;
  equal(runner.assertNoSecrets({ selectedFamilyCount: 2 }, secrets), true, "sanitized counts allowed");

  equal(runner.eip1898(pin().hash), { blockHash: pin().hash, requireCanonical: true }, "canonical EIP-1898 pin");
  const qualifyContext = context(async (_endpoint, method) => method === "eth_chainId" ? { ok: true, result: "0x8f" } :
    { ok: true, result: header() });
  const qualification = await runner.qualifyDescriptors(descriptors, qualifyContext);
  equal(qualification.consensus, true, "two-family finalized consensus");
  equal(qualification.selected.length, 2, "two families selected");
  const mismatchContext = context(async (endpoint, method) => method === "eth_chainId" ? { ok: true, result: "0x8f" } :
    { ok: true, result: header(endpoint.family.startsWith("one") ? pin() : pin("101", `0x${"c".repeat(64)}`)) });
  equal((await runner.qualifyDescriptors(descriptors, mismatchContext)).consensus, false, "pin mismatch rejected");
  equal(runner.samePin(pin(), pin()), true, "pin equality");
  equal(runner.samePin(pin(), pin("101")), false, "pin number mismatch");
  const terminalRows = qualification.selected;
  equal(await runner.terminalRecheck(terminalRows, pin(), context(async () => ({ ok: true, result: header() }))), true,
    "terminal exact pin accepted");
  equal(await runner.terminalRecheck(terminalRows, pin(), context(async () => ({ ok: true, result: header(pin("101")) }))), false,
    "terminal pin mismatch rejected");

  const impl = "0x1111111111111111111111111111111111111111", beacon = "0x2222222222222222222222222222222222222222";
  equal(runner.classifyProxySlots(impl, null).kind, "EIP1967_PROXY", "implementation proxy");
  equal(runner.classifyProxySlots(null, beacon).kind, "BEACON_PROXY", "beacon proxy");
  equal(runner.classifyProxySlots(impl, beacon).ambiguity, true, "slot ambiguity blocker");
  equal(runner.codeRecord("0x60016000"), { present: true, bytes: 4,
    sha256: crypto.createHash("sha256").update(Buffer.from("60016000", "hex")).digest("hex") }, "runtime hash and length");
  equal(runner.codeRecord("0x").present, false, "empty runtime absent");

  equal(runner.rewardsBound(16), 16, "rewards cap boundary");
  equal(runner.rewardsBound(17), null, "rewards over cap rejected");
  equal(runner.rewardsBound("bad"), null, "malformed rewards length rejected");
  const t1 = "0x1111111111111111111111111111111111111111", t2 = "0x2222222222222222222222222222222222222222";
  equal(runner.tokenOrderCheck([t1,t2], [t1,t2], t2, ["2","1"]), { sameOrder: true, depositTokenIndex: 1, exactIndex: true }, "token order and index");
  equal(runner.tokenOrderCheck([t2,t1], [t1,t2], t2, ["2","1"]).sameOrder, false, "token order mismatch");

  const stop = runner.deriveStopReasons({ bindings: { bidirectional: true, tokenOrder: { sameOrder: true, exactIndex: true } },
    strategyIdentity: { resolved: true }, vaultIdentity: { resolved: true }, balancer: { identity: { resolved: true },
      explorer: { poolConfig: { value: null }, hooksConfig: { value: null }, tokenRates: { value: null } } },
    strategy: { paused: { value: null, reason: "RPC_REVERT_OR_UNSUPPORTED" } }, allowances: { wantToStaker: { value: null } } });
  equal(stop.paused, null, "missing pause does not classify negative");
  equal(stop.allowanceAbsent, null, "missing allowance does not classify negative");
  equal(stop.unsupportedPoolConfigHooksRates, true, "unsupported explorer selectors block");
  equal(stop.swapRoutesAbsent, null, "absent route getters remain unknown");

  const malformedContext = context(async () => ({ ok: true, result: "0x01" }));
  const malformed = await runner.probeCall(descriptors[0], runner.STRATEGY,
    new (require("./node_modules/ethers").Interface)(["function owner() view returns(address)"]), "owner", [], pin(), malformedContext);
  equal(malformed.value, null, "malformed ABI null"); equal(malformed.reason, "ABI_DECODE_INVALID", "malformed ABI reason");
  const revertContext = context(async () => ({ ok: false, reason: "RPC_REVERT_OR_UNSUPPORTED", result: null }));
  equal((await runner.probeCall(descriptors[0], runner.STRATEGY,
    new (require("./node_modules/ethers").Interface)(["function owner() view returns(address)"]), "owner", [], pin(), revertContext)).reason,
  "RPC_REVERT_OR_UNSUPPORTED", "revert reason explicit");

  const single = runner.parseInventoryText("chainId=143 rpc=https://single.example/rpc"); let written = null;
  const incomplete = await runner.runCapture({ runId }, { inventoryText: "chainId=143 rpc=https://single.example/rpc",
    rpc: async (_endpoint, method) => method === "eth_chainId" ? { ok: true, result: "0x8f" } : { ok: true, result: header() },
    writeOutput: (_file, value) => { written = value; }, outputPath: "unused" });
  equal(single.length, 1, "single family parsed"); equal(incomplete.status, "INCOMPLETE_NONPROMOTABLE", "single family incomplete");
  equal(incomplete.reason, "TWO_HOSTNAME_FAMILY_FINALIZED_CONSENSUS_UNAVAILABLE", "single family terminal reason");
  equal(written.retryAllowed, false, "retry false"); equal(written.conclusions.promotable, false, "nonpromotable");
  equal(written.conclusions.economics, null, "economics null"); equal(written.conclusions.routePositive, null, "route null");
  equal(written.conclusions.executableNow, null, "executable null"); equal(written.conclusions.deploymentApplicability, null, "applicability null");
  equal(written.conclusions.fork, false, "fork false"); equal(written.conclusions.signedActionJustified, false, "signed false");

  equal([...runner.ALLOWED_METHODS].sort(), ["eth_call","eth_chainId","eth_getBlockByNumber","eth_getCode","eth_getStorageAt"].sort(), "read-only method allowlist");
  check(!runner.ALLOWED_METHODS.some((method) => /send|estimate|logs|trace/iu.test(method)), "mutation/log/trace methods absent");
  const preflight = runner.dryPreflight(); equal(preflight.networkReads, 0, "no network during implementation");
  equal(preflight.inventoryReads, 0, "no inventory during implementation"); equal(preflight.captureExecuted, false, "capture not executed");
  equal(preflight.sourceAuthority.deployedEquivalenceClaimed, false, "no deployed equivalence claim");

  const temp = path.join("C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode", `${runner.STEM}-${process.pid}.json`);
  try { runner.atomicExclusiveWrite(temp, { ok: true }); assert.throws(() => runner.atomicExclusiveWrite(temp, { ok: true }), /EEXIST/u); checks += 1; }
  finally { try { fs.unlinkSync(temp); } catch (_) {} }

  equal(runner.verifyRecords(runner.fileRecords(runner.LOCAL_INPUT_RELS), runner.LOCAL_INPUT_RELS), true, "exact local source closure");
  check(runner.loadedDependencyGraph().length > 20, "loaded runtime graph bound");
  equal(runner.verifyRecords(runner.fileRecords(runner.REQUIRED_ARTIFACT_PATHS), runner.REQUIRED_ARTIFACT_PATHS), true, "artifact closure");
  const manifest = JSON.parse(fs.readFileSync(path.join(runner.ROOT, ...runner.MANIFEST_REL.split("/")), "utf8"));
  equal(independentAggregate(manifest), manifest.aggregateSha256, "independent aggregate");
  const tampered = structuredClone(manifest); tampered.artifacts[0].sha256 = "0".repeat(64);
  check(independentAggregate(tampered) !== tampered.aggregateSha256, "aggregate mismatch caught");
  process.stdout.write(`beefy balancer v3 monad binding tests passed: ${checks} checks, ${fixture.fixtureClasses.length} fixtures, zero network/inventory/capture\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
