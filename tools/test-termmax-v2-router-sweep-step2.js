#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CAPTURE_R1 = path.join(ROOT, "reports", "raw", "fast", "critical-termmax-v2-router-sweep-step2-capture.json");
const CAPTURE = path.join(ROOT, "reports", "raw", "fast", "critical-termmax-v2-router-sweep-step2-capture-r2.json");
const ECON = path.join(ROOT, "reports", "raw", "fast", "critical-termmax-v2-router-sweep-step2-economics.json");
let checks = 0;
function check(condition, message) { if (!condition) throw new Error(message); checks++; }
function json(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function address(x) { return typeof x === "string" && /^0x[0-9a-f]{40}$/.test(x); }
function hash(x) { return typeof x === "string" && /^0x[0-9a-f]{64}$/.test(x); }
function noLeaks(value, key = "") {
  check(!/^(?:url|urls|domain|domains|provider|providers|credential|credentials|header|headers|inventory|rawresponse|rawresponses)$/i.test(key), `forbidden key ${key}`);
  if (typeof value === "string") {
    check(!/https?:\/\//i.test(value), "URL leak");
    check(!/[a-z0-9-]+\.(?:com|io|org|net|xyz|app|dev|cloud)\b/i.test(value), "domain leak");
  } else if (Array.isArray(value)) for (const item of value) noLeaks(item, key);
  else if (value && typeof value === "object") for (const [k, item] of Object.entries(value)) noLeaks(item, k);
}
function main() {
  const predecessor = json(CAPTURE_R1);
  const capture = json(CAPTURE);
  const econ = json(ECON);
  noLeaks(predecessor); noLeaks(capture); noLeaks(econ);
  check(capture.schema === "termmax-v2-router-sweep-step2-capture/v1", "capture schema");
  check(capture.lineage.economicsInterpretationStatus === "superseded-non-governing" && capture.lineage.technicalObservationsAlteredByPackagingCleanup === false, "capture economics lineage");
  check(capture.authorization.rpcUsed && !capture.authorization.graphqlUsed, "read-only RPC mode");
  for (const key of ["networkWrites", "transactions", "signing", "broadcasts", "mutations", "forks"]) check(capture.authorization[key] === 0, `zero ${key}`);
  check(capture.authorization.privateOwnersEnumerated === false, "no private owner enumeration");
  check(capture.authorization.persistedRpcPayloads === false, "no RPC payload persistence");
  check(capture.localEnumeration.mainnetCoreV2Manifests === 9, "nine mainnet manifests");
  check(capture.localEnumeration.nonzeroRouterCandidates === 8, "eight routers");
  check(capture.localEnumeration.envFilesRead === false, "no env reads");
  check(capture.chains.length === 8, "eight chain rows");
  check(new Set(capture.chains.map((x) => x.chainId)).size === 8, "unique chains");
  const valid = capture.chains.filter((x) => x.pin?.terminalRecheck?.passed);
  check(valid.length === 4, "four terminal-valid pins");
  for (const chain of capture.chains) {
    check(address(chain.router), `router address ${chain.chainId}`);
    check(chain.qualification.backendIndependenceClaimed === false, "no backend independence claim");
    for (const family of chain.qualification.familyIds) check(/^[0-9a-f]{16}$/.test(family), "sanitized family id");
    if (chain.pin) {
      check(/^\d+$/.test(chain.pin.number) && hash(chain.pin.hash), "canonical pin");
      check(chain.runtime?.exactRepositoryArtifactMatch === false, "exact artifact unbound");
    }
    for (const row of chain.tokenRows) {
      check(address(row.token), "token address");
      check(Number.isInteger(row.decimals) && row.decimals >= 0 && row.decimals <= 255, "token decimals");
      check(/^\d+$/.test(row.balance), "token balance");
    }
    for (const row of chain.staleAllowances) {
      check(BigInt(row.allowance) > 0n, "retained allowances nonzero");
      check(address(row.market) && address(row.gt) && address(row.token), "allowance addresses");
    }
  }
  const aggregate = capture.aggregate;
  check(aggregate.routerCandidates === 8, "aggregate routers");
  check(aggregate.strictPinnedRouters === capture.chains.filter((x) => x.pin).length, "aggregate pins");
  check(aggregate.twoFamilyPins === capture.chains.filter((x) => x.qualification.agreeingStateFamilies >= 2).length, "aggregate families");
  check(aggregate.runtimeFamilyBound === capture.chains.filter((x) => x.runtime?.stateFamilyAgreement).length, "aggregate runtimes");
  check(aggregate.tokenRows === capture.chains.reduce((n, x) => n + x.tokenRows.length, 0), "aggregate tokens");
  check(aggregate.nonzeroTokenRows === capture.chains.reduce((n, x) => n + x.nonzeroBalances.length, 0), "aggregate nonzero");
  check(aggregate.successfulSimulations === capture.chains.reduce((n, x) => n + x.simulations.filter((s) => s.callSucceeded).length, 0), "aggregate simulations");
  check(aggregate.staleAllowanceRows === capture.chains.reduce((n, x) => n + x.staleAllowances.length, 0), "aggregate allowances");
  check(aggregate.tokenRows === 70 && aggregate.nonzeroTokenRows === 1 && aggregate.successfulSimulations === 1, "observed counts");
  check(aggregate.staleAllowanceRows === 0, "zero bounded stale allowance rows");
  check(aggregate.operationalRoutePositive === 0 && aggregate.executableNow === 0 && aggregate.signedActionJustified === false && aggregate.fork === false, "closed operational gates");
  const eth = capture.chains.find((x) => x.chainId === 1);
  const bnb = capture.chains.find((x) => x.chainId === 56);
  const base = capture.chains.find((x) => x.chainId === 8453);
  const arb = capture.chains.find((x) => x.chainId === 42161);
  check([eth, bnb, base, arb].every((x) => x.pin.terminalRecheck.passed && x.pause.paused === false && x.nativeBalance === "0"), "four valid unpaused zero-native rows");
  check(eth.tokenUniverse.inboundTransferEventComplete && eth.tokenUniverse.inboundTransferHistoryFamilies === 1, "Ethereum event scope");
  check(base.tokenUniverse.inboundTransferEventComplete && base.tokenUniverse.inboundTransferHistoryFamilies === 1, "Base event scope");
  check(!bnb.tokenUniverse.inboundTransferEventComplete && !arb.tokenUniverse.inboundTransferEventComplete, "BNB/Arb bounded-history caveat");
  check(eth.tokenRows.length === 35 && base.tokenRows.length === 29 && arb.tokenRows.length === 6 && bnb.tokenRows.length === 0, "per-chain token counts");
  check(bnb.economics.routePositive === null && bnb.economics.executableNow === null && bnb.economics.positiveRows === null && bnb.economics.reason.includes("not an all-zero"), "BNB no-row status is unknown, not all-zero");
  const blocked = capture.chains.filter((x) => [196, 223, 80094, 688688].includes(x.chainId));
  check(blocked.length === 4 && blocked.every((x) => x.economics.routePositive === null && x.economics.executableNow === null && x.economics.assessment === "coverage-blocked"), "blocked-chain route/economics null");
  const baseMarketFts = base.tokenRows.filter((x) => x.sources.includes("market-tokens-call") && x.symbol?.startsWith("FT:"));
  check(baseMarketFts.length === 9, "at least nine Base markets represented by unique FT rows");
  const sim = base.simulations[0];
  check(base.nonzeroBalances.length === 1 && sim.token === base.nonzeroBalances[0].token, "Base dust row");
  check(sim.openingRouterBalance === "1" && sim.callerAtomicFunding === "0" && sim.simulatedRecipientAmount === "1" && sim.sourceImpliedRouterResidue === "0", "exact sweep deltas");
  check(sim.estimateGas === "76604" && sim.gasPriceWei === "6000000" && sim.executionGasCostWei === "459624000000", "historical observed estimate scenario values");
  check(sim.estimateGasStatus === "historical-observation-not-a-minimum-non-governing" && sim.estimateBasedExecutionGasCostStatus === "superseded-non-governing", "capture estimate interpretation superseded");
  check(sim.standardTokenExecutable && !sim.operationalRoutePositive, "simulation operational gate remains closed independently of superseded estimate interpretation");
  check(econ.schema === "termmax-v2-router-sweep-step2-economics/v1", "economics schema");
  check(econ.artifactStatus === "superseded-non-governing" && econ.governing === false && econ.classification.startsWith("SUPERSEDED/NON-GOVERNING/"), "predecessor economics explicitly non-governing");
  check(econ.supersededBy === capture.lineage.governingEconomics, "governing economics reference");
  check(econ.pin.number === base.pin.number && econ.pin.hash === base.pin.hash && econ.pin.agreeingStateFamilies === 2 && econ.pin.terminalRecheck, "economics pin binding");
  check(econ.token.balance === "1" && econ.token.address === sim.token, "economics token binding");
  const grossN = BigInt(econ.token.balance) * BigInt(econ.token.price);
  const grossD = 10n ** BigInt(econ.token.decimals + econ.token.priceDecimals);
  const gasN = BigInt(econ.simulation.historicalEstimateBasedL2CostWei) * BigInt(econ.nativePrice.price);
  const gasD = 10n ** BigInt(18 + econ.nativePrice.priceDecimals);
  check(grossN * gasD - gasN * grossD < 0n, "historical estimate-based scenario is numerically negative without minimum claim");
  check(econ.simulation.estimateGasObserved === "76604" && econ.simulation.estimateGasUsedAsMinimum === false, "estimate observation not minimum");
  check(econ.economics.historicalEstimateBasedNetUsdBeforeAdditionalFees === "-0.00023754679457" && econ.economics.calculationStatus.includes("non-governing"), "historical scenario labeled non-governing");
  check(econ.economics.routePositive === null && econ.economics.executableNow === null && !econ.economics.additionalL1FeeIncluded, "predecessor has no governing gates");
  check(econ.authorization.rpcCallsUsed === 9, "economics budget");
  for (const key of ["networkWrites", "transactions", "signing", "broadcasts", "mutations", "forks"]) check(econ.authorization[key] === 0, `economics zero ${key}`);
  console.log(JSON.stringify({ status: "PASS", checksPassed: checks, captureTokenRows: aggregate.tokenRows, nonzeroRows: aggregate.nonzeroTokenRows, simulations: aggregate.successfulSimulations, staleAllowances: aggregate.staleAllowanceRows, blockedChainsNull: blocked.length, predecessorEconomicsGoverning: econ.governing }));
}
try { main(); } catch (error) { console.error(JSON.stringify({ status: "FAIL", reason: String(error.message || "unknown") })); process.exit(1); }
