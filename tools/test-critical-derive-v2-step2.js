#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const runnerApi = require("./run-critical-derive-v2-step2.js");

const ROOT = path.resolve(__dirname, "..");
const RAW = "reports/raw/fast/critical-derive-v2-cash-pnl-deployment-economics-step2.json";
const RUNNER = "tools/run-critical-derive-v2-step2.js";
let tests = 0;

function check(condition, message) {
  tests += 1;
  assert.ok(condition, message);
}

function equal(actual, expected, message) {
  tests += 1;
  assert.deepStrictEqual(actual, expected, message);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function mockDeployment() {
  const address = (digit) => `0x${digit.repeat(40)}`;
  return {
    core: { cash: address("1"), rateModel: address("2"), securityModule: address("3"), srm: address("4"), subAccounts: address("5") },
    eth: { perp: address("6"), pmrm: address("7") },
    eth2: { pmrm2: address("8") },
    btc2: { pmrm2: address("9") },
  };
}

function mockStream(chunks) {
  let index = 0;
  let cancelled = false;
  return {
    response: {
      body: {
        getReader() {
          return {
            async read() {
              if (index >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: Uint8Array.from(chunks[index++]) };
            },
            async cancel() { cancelled = true; },
          };
        },
      },
    },
    cancelled: () => cancelled,
  };
}

async function main() {
  const rawText = fs.readFileSync(path.join(ROOT, RAW), "utf8");
  const raw = JSON.parse(rawText);
  const runner = fs.readFileSync(path.join(ROOT, RUNNER), "utf8");

  equal(raw.status, "LEGACY_NO_TARGET_CHAIN_ID_MATCH_STRICT_UNVERIFIED", "corrected status");
  equal(raw.qualification.inventoryEmpty, false, "inventory nonempty");
  equal(raw.qualification.candidatesParsed, 264, "candidate count");
  equal(raw.qualification.candidatesProbed, 264, "probe count");
  equal(raw.qualification.probesReserved, 264, "probe reservations");
  equal(raw.qualification.probesDispatched, 264, "probe dispatches");
  equal(raw.qualification.rpcFailures, 122, "RPC failures");
  equal(raw.qualification.legacyBigIntCoercibleSuccessfulNonTargetResults, 142, "legacy-coercible successes");
  equal(raw.qualification.canonicalSuccessfulChainIds, null, "strict successful count unverified");
  equal(raw.qualification.malformedOrNullChainIdsRejected, null, "strict malformed count unverified");
  equal(raw.qualification.targetChainIdMatchesUnderLegacyParser, 0, "legacy target matches");
  equal(raw.qualification.strictQualificationVerified, false, "strict qualification unverified");
  equal(raw.qualification.finalityAttempted, false, "finality not attempted");
  equal(Object.values(raw.qualification.failureCounts).reduce((sum, value) => sum + value, 0), 122, "failure-class sum");
  equal(raw.qualification.rpcFailures + raw.qualification.legacyBigIntCoercibleSuccessfulNonTargetResults, 264, "legacy outcome conservation");

  equal(runnerApi.classifyQualification({ inventoryCount: 0, rpcFailures: 0, parseableChainIds: 0, targetMatches: 0 }), "EMPTY_INVENTORY", "empty inventory fixture");
  equal(runnerApi.classifyQualification({ inventoryCount: 3, rpcFailures: 3, parseableChainIds: 0, targetMatches: 0 }), "NO_PARSEABLE_RESPONSES", "no response fixture");
  equal(runnerApi.classifyQualification({ inventoryCount: 3, rpcFailures: 0, parseableChainIds: 0, targetMatches: 0 }), "NO_PARSEABLE_RESPONSES", "malformed-only fixture");
  equal(runnerApi.classifyQualification({ inventoryCount: 3, rpcFailures: 1, parseableChainIds: 2, targetMatches: 0 }), "NO_TARGET_CHAIN_ID_MATCH", "wrong chain fixture");
  equal(runnerApi.classifyQualification({ inventoryCount: 3, rpcFailures: 1, parseableChainIds: 2, targetMatches: 1 }), "TARGET_CHAIN_ID_MATCH", "target match fixture");
  equal(runnerApi.classifyFinality(1, 0), "TARGET_MATCH_NO_FINALIZED_PIN", "target match without finalized fixture");
  equal(runnerApi.classifyFinality(1, 1), "TARGET_MATCH_FINALIZED_HEADER_AVAILABLE", "target finalized fixture");

  for (const [value, expected] of [["0x0", 0n], ["0x1", 1n], ["0x385", 901n], ["0x3bd", 957n], ["0xabcdef", 0xabcdefn]]) {
    equal(runnerApi.parseCanonicalQuantity(value), expected, `canonical quantity ${value}`);
  }
  for (const value of [null, undefined, 0, "", "0x", "0x00", "0x01", "0X1", "0xA", "0xaB", "1", "0x-1", "0xg1"]) {
    equal(runnerApi.parseCanonicalQuantity(value), null, `malformed quantity ${String(value)}`);
  }

  for (const [site, parse] of [["gas-estimate", runnerApi.parseGasEstimateResponse], ["gas-price", runnerApi.parseGasPriceResponse]]) {
    equal(parse({ ok: true, result: null }), null, `${site} null fixture`);
    equal(parse({ ok: true, result: "0x00" }), null, `${site} padded-zero fixture`);
    equal(parse({ ok: true, result: "0x01" }), null, `${site} padded-noncanonical fixture`);
    equal(parse({ ok: true, result: "malformed" }), null, `${site} malformed fixture`);
    equal(parse({ ok: false, result: "0x1" }), null, `${site} failed-response fixture`);
    equal(parse({ ok: true, result: "0x0" }), 0n, `${site} canonical-zero fixture`);
    equal(parse({ ok: true, result: "0x5208" }), 21000n, `${site} canonical-positive fixture`);
  }
  const invalidGas = runnerApi.invalidGasPromotionOutcome();
  for (const field of ["grossBorrowerBenefitCash18", "gasEstimate", "gasPriceWei", "gasCostCash18", "attributedGrossCash18", "callerRevenueCash18", "callerNetCash18", "netCash18"]) {
    equal(invalidGas[field], null, `invalid gas null ${field}`);
  }
  check(invalidGas.economicsBindingLiteralTrue === false && invalidGas.beneficiaryControlProofLiteralTrue === false, "invalid gas economics gates false");
  check(invalidGas.operationalPromotionLiteralTrue === false && invalidGas.executableNow === false, "invalid gas promotion gates false");

  const goodHeader = { number: "0x10", hash: `0x${"a".repeat(64)}`, timestamp: "0x20" };
  check(runnerApi.validateBlockHeader(goodHeader).ok, "valid header");
  check(runnerApi.validateBlockHeader(goodHeader, 16n).ok, "requested-number header");
  equal(runnerApi.validateBlockHeader({ ...goodHeader, number: "0x010" }).reason, "NONCANONICAL_BLOCK_NUMBER", "padded header number");
  equal(runnerApi.validateBlockHeader({ ...goodHeader, number: null }).reason, "NONCANONICAL_BLOCK_NUMBER", "null header number");
  equal(runnerApi.validateBlockHeader({ ...goodHeader, timestamp: "0x00" }).reason, "NONCANONICAL_TIMESTAMP", "padded timestamp");
  equal(runnerApi.validateBlockHeader({ ...goodHeader, timestamp: null }).reason, "NONCANONICAL_TIMESTAMP", "null timestamp");
  equal(runnerApi.validateBlockHeader({ ...goodHeader, hash: `0x${"a".repeat(62)}` }).reason, "MALFORMED_BLOCK_HASH", "short hash");
  equal(runnerApi.validateBlockHeader({ ...goodHeader, hash: `0x${"A".repeat(64)}` }).reason, "MALFORMED_BLOCK_HASH", "uppercase hash");
  equal(runnerApi.validateBlockHeader(goodHeader, 17n).reason, "RETURNED_NUMBER_MISMATCH", "common header returned-number mismatch");
  check(runnerApi.terminalHeaderMatches(goodHeader, 16n, goodHeader.hash), "terminal exact match");
  check(!runnerApi.terminalHeaderMatches({ ...goodHeader, number: "0x11" }, 16n, goodHeader.hash), "terminal number mismatch");
  check(!runnerApi.terminalHeaderMatches({ ...goodHeader, hash: `0x${"b".repeat(64)}` }, 16n, goodHeader.hash), "terminal hash mismatch");

  const scheme = `https${"://"}`;
  const inventoryFixture = [
    `label-a [header: x-test=alpha] ${scheme}first.invalid/path`,
    "",
    "metadata-that-must-not-bleed [header: x-test=wrong]",
    "",
    `label-b [header: x-test=beta] ${scheme}second.invalid/path`,
  ].join("\n");
  const key = Buffer.alloc(32, 7);
  const records = runnerApi.parseInventoryText(inventoryFixture, "fixture.txt", key);
  equal(runnerApi.parseInventoryText("", "empty.txt", key).length, 0, "empty parsed inventory fixture");
  equal(records.length, 2, "structural record count");
  equal(records[0].headers["x-test"], "alpha", "first record header");
  equal(records[1].headers["x-test"], "beta", "second record header");
  check(!Object.values(records[0].headers).includes("wrong"), "no adjacent metadata bleed");
  check(!records[0].family.includes("first") && !records[1].family.includes("second"), "opaque family IDs");
  equal(runnerApi.opaqueId("account", "1", key), runnerApi.opaqueId("account", "1", key), "HMAC deterministic within run");
  check(runnerApi.opaqueId("account", "1", key) !== runnerApi.opaqueId("account", "1", Buffer.alloc(32, 8)), "HMAC differs across run keys");

  const budget = runnerApi.createLogicalBudget(3);
  check(budget.reserve(2), "budget reserve before dispatch");
  check(budget.dispatchReserved(2), "budget dispatch reserved");
  check(!budget.reserve(2), "budget rejects over-reservation");
  check(budget.reserve(1), "budget reserves remaining slot");
  check(budget.dispatchReserved(1), "budget dispatches remaining slot");
  check(!budget.dispatchReserved(1), "batch fallback cannot bypass reservation");
  equal({ reserved: budget.reserved, dispatched: budget.dispatched }, { reserved: 3, dispatched: 3 }, "budget conservation");

  const under = mockStream([[1, 2], [3]]);
  const underResult = await runnerApi.readResponseWithCeiling(under.response, 3);
  check(underResult.ok && underResult.bytes.length === 3 && !under.cancelled(), "streaming under ceiling");
  const over = mockStream([[1, 2], [3, 4]]);
  const overResult = await runnerApi.readResponseWithCeiling(over.response, 3);
  equal(overResult.errorClass, "response-cap", "streaming ceiling rejection");
  check(over.cancelled(), "stream cancelled at ceiling");

  check(runner.includes('redirect: "error"'), "redirect rejection configured");
  check(!/\.arrayBuffer\s*\(/.test(runner), "no post-download arrayBuffer path");
  check(runner.includes("readResponseWithCeiling"), "streaming ceiling used");
  check(runner.includes("logicalBudget.reserve"), "logical reservation used");
  check(!/familyCommitment/.test(runner), "hostname commitment removed");
  check(!/derive-v2-step2\|\$\{pin\.chainId\}/.test(runner), "reversible account commitment removed");
  check(!/\|\|\s*0n?\b/.test(runner), "no numeric fallback to zero");
  check(!/gas\.ok\s*\?\s*BigInt/.test(runner), "gas estimate avoids direct BigInt");
  check(!/gasPrice\.ok\s*\?\s*BigInt/.test(runner), "gas price avoids direct BigInt");
  check(runner.includes("...invalidGasPromotionOutcome()"), "invalid gas null outcome wired into economics");

  const blocked = runnerApi.blockedChainResult(957, mockDeployment());
  equal(blocked.reason, "NO_TARGET_CHAIN_ID_MATCH", "blocked reason");
  equal(blocked.finalityAttempted, false, "blocked finality");
  for (const field of ["pin", "runtimeBindings", "currentState", "currentSupply18", "currentBorrow18", "currentAccountCandidateCount", "activeEligiblePositionCount", "orderSensitivePairCount"]) {
    equal(blocked[field], null, `blocked null ${field}`);
  }
  for (const field of ["grossBorrowerBenefitCash18", "gasEstimate", "gasPriceWei", "gasCostCash18", "attributedGrossCash18", "netCash18", "callerRevenueCash18", "callerNetCash18"]) {
    equal(blocked.economics[field], null, `blocked economics null ${field}`);
  }
  check(Object.values(blocked.gates).every((value) => value === false), "blocked post-qualification gates false");

  check(raw.gates.inventoryNonEmptyLiteralTrue === true && raw.gates.strictQualificationCompletedLiteralTrue === false, "retained qualification gates");
  for (const [name, value] of Object.entries(raw.gates)) {
    if (["inventoryNonEmptyLiteralTrue", "strictQualificationCompletedLiteralTrue", "routePositive", "executableNow", "signedActionJustified", "fork"].includes(name)) continue;
    equal(value, false, `retained post-qualification gate ${name}`);
  }
  equal(raw.gates.routePositive, 0, "retained route gate");
  equal(raw.gates.executableNow, 0, "retained executable gate");
  equal(raw.gates.signedActionJustified, false, "retained signing gate");
  equal(raw.gates.fork, false, "retained fork gate");
  for (const chain of raw.chains) {
    equal(chain.reason, "LEGACY_NO_TARGET_CHAIN_ID_MATCH_STRICT_UNVERIFIED", `chain reason ${chain.chainId}`);
    equal(chain.finalityAttempted, false, `chain finality ${chain.chainId}`);
    check(Object.values(chain.gates).every((value) => value === false), `chain gates false ${chain.chainId}`);
    check(Object.values(chain.economics).filter((value) => typeof value !== "boolean").every((value) => value === null), `chain economics null ${chain.chainId}`);
  }

  const safeLeak = runnerApi.leakGuard([["safe", "sanitized artifact"]], new Set(["secret-host.invalid", "token-value"]));
  check(safeLeak.ok, "safe leak fixture");
  check(!runnerApi.leakGuard([["url", `${scheme}secret-host.invalid`]], new Set()).ok, "generic URL leak fixture");
  check(!runnerApi.leakGuard([["host", "family secret-host.invalid"]], new Set(["secret-host.invalid"])).ok, "inventory host leak fixture");
  check(!runnerApi.leakGuard([["header", "token-value"]], new Set(["token-value"])).ok, "header value leak fixture");
  check(!runnerApi.leakGuard([["credential", `Authorization: ${"Bearer"} abc.def`]], new Set()).ok, "credential leak fixture");

  check(!/https?:\/\//i.test(rawText), "raw URL leak");
  check(raw.captureSafety.publishedOpaqueIdentityCount === 0, "no published identities");
  check(raw.authorizationProvenance.scopeId === "derive-v2-step2-readonly-scope-20260728", "scope ID");
  equal(raw.authorizationProvenance.authorizedInventoryFilenames, ["rpc_endpoints.txt", "graphql_endpoints.txt"], "authorized filenames");
  equal(raw.authorizationProvenance.methodsDispatchedInRetainedCapture, ["eth_chainId"], "retained methods");
  check(raw.offlineR2.inventoryReread === false && raw.offlineR2.rpcCalls === 0, "offline R2 purity");

  const step1ManifestPath = path.join(ROOT, raw.predecessor.step1ManifestPath);
  const step1Bytes = fs.readFileSync(step1ManifestPath);
  const step1 = JSON.parse(step1Bytes.toString("utf8"));
  check(sha256(step1Bytes) === raw.predecessor.step1ManifestSha256, "Step1 manifest hash");
  check(step1.aggregateSha256 === raw.predecessor.step1AggregateSha256, "Step1 aggregate");

  const totalBorrow = 8000000000000000000000n;
  const baselineFactor = 712590783931847n;
  const loserFactor = 696908622920140n;
  const baselineInterest = totalBorrow * baselineFactor / 10n ** 18n;
  const loserInterest = totalBorrow * loserFactor / 10n ** 18n;
  check(baselineInterest > loserInterest, "ordering direction fixture");
  equal(baselineInterest - loserInterest, 125457288093656000n, "Step1 gross fixture");

  process.stdout.write(`${JSON.stringify({ ok: true, tests, mode: "offline-fixture", network: 0, inventoryReads: 0, rpc: 0, fork: 0, stateOverride: 0, signing: 0, liveActions: 0 })}\n`);
}

main().catch((error) => {
  process.stderr.write(`fixture failure:${error.message}\n`);
  process.exit(1);
});
