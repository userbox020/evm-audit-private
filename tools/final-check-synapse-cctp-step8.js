#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadRpcUrls, rpcCall, PUBLIC_FALLBACKS } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "synapse-contracts");
const RAW_FILE = path.join(ROOT, "reports", "raw", "fast", "synapse-cctp-step8.json");
const PUBLIC_FILE = path.join(ROOT, "reports", "raw", "fast", "synapse-cctp-step8.public-calldata.json");
const FORK_FILE = path.join(ROOT, "reports", "raw", "fast", "synapse-cctp-step8.fork.json");
const OUT = path.join(ROOT, "reports", "raw", "fast", "synapse-cctp-step8.final-check.json");
const PROXY = "0x12715a66773bd9c54534a01abf01d05f6b4bd35e";
const ROUTER = "0xd5a597d6e7ddf373a92c8f477daaa673b0902f48";
const IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const shaHex = x => crypto.createHash("sha256").update(Buffer.from(x.replace(/^0x/, ""), "hex")).digest("hex");
const shaText = x => crypto.createHash("sha256").update(x).digest("hex");
const shaFile = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const address = x => !x || /^0x0*$/.test(x) ? null : "0x" + x.slice(-40).toLowerCase();
const padAddress = a => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

async function chainUrls(chainId) {
  const out = [];
  for (const url of [...new Set([...loadRpcUrls(), PUBLIC_FALLBACKS[chainId]].filter(Boolean))]) {
    const id = await rpcCall(url, "eth_chainId", [], 4000);
    if (id && parseInt(id, 16) === chainId) out.push(url);
  }
  if (!out.length) throw new Error(`no read-only provider for chain ${chainId}`);
  return out;
}
async function any(urls, method, params) {
  for (const u of urls) {
    const v = await rpcCall(u, method, params, 30000);
    if (v != null) return v;
  }
  throw new Error(`${method} unavailable at fixed binding`);
}

function normalizeRuntime(artifactFile, liveCode) {
  const art = JSON.parse(fs.readFileSync(artifactFile, "utf8"));
  const built = art.deployedBytecode.object;
  const refs = art.deployedBytecode.immutableReferences || {};
  const normalize = code => {
    const b = Buffer.from(code.replace(/^0x/, ""), "hex");
    for (const entries of Object.values(refs)) for (const r of entries) b.fill(0, r.start, r.start + r.length);
    return b;
  };
  const a = normalize(built), b = normalize(liveCode);
  return { artifactFile: path.relative(ROOT, artifactFile).replaceAll("\\", "/"), buildSha256: shaHex(built), liveSha256: shaHex(liveCode), buildBytes: a.length, liveBytes: b.length, normalizedImmutableMatch: a.length === b.length && crypto.timingSafeEqual(a, b) };
}

function canonicalLedgerRecord(chainId, record) {
  return shaText(JSON.stringify({
    chainId,
    blockNumber: record.blockNumber,
    blockHash: record.blockHash.toLowerCase(),
    transactionHash: record.transactionHash.toLowerCase(),
    status: record.status,
    inputSha256: record.calldataBinding.inputSha256,
    messageSha256: record.calldataBinding.messageSha256,
    attestationSha256: record.calldataBinding.attestationSha256,
    formattedRequestSha256: record.calldataBinding.formattedRequestSha256,
    requestVersion: record.calldataBinding.requestVersion,
    event: record.event,
  }));
}

function fullPayloadHashCheck(payload) {
  return {
    input: shaHex(payload.input) === payload.calldataBinding.inputSha256,
    message: shaHex(payload.message) === payload.calldataBinding.messageSha256,
    attestation: shaHex(payload.attestation) === payload.calldataBinding.attestationSha256,
    formattedRequest: shaHex(payload.formattedRequest) === payload.calldataBinding.formattedRequestSha256,
  };
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(RAW_FILE, "utf8"));
  const pub = JSON.parse(fs.readFileSync(PUBLIC_FILE, "utf8"));
  const fork = JSON.parse(fs.readFileSync(FORK_FILE, "utf8"));
  const checks = [];
  for (const c of raw.chains) {
    const urls = await chainUrls(c.chain.chainId);
    const tag = "0x" + BigInt(c.fixedHead.number).toString(16);
    const [b, implSlot, adminSlot, proxyCode, implCode, routerCode, messengerCode, transmitterCode, messengerImpl, transmitterImpl] = await Promise.all([
      any(urls, "eth_getBlockByNumber", [tag, false]), any(urls, "eth_getStorageAt", [PROXY, IMPL, tag]), any(urls, "eth_getStorageAt", [PROXY, ADMIN, tag]),
      any(urls, "eth_getCode", [PROXY, tag]), any(urls, "eth_getCode", [c.bindings.implementation.address, tag]), any(urls, "eth_getCode", [ROUTER, tag]),
      any(urls, "eth_getCode", [c.state.tokenMessenger, tag]), any(urls, "eth_getCode", [c.state.messageTransmitter, tag]),
      any(urls, "eth_getStorageAt", [c.state.tokenMessenger, IMPL, tag]), any(urls, "eth_getStorageAt", [c.state.messageTransmitter, IMPL, tag]),
    ]);
    const last = c.history[c.history.length - 1];
    const [tx, receipt] = await Promise.all([any(urls, "eth_getTransactionByHash", [last.transactionHash]), any(urls, "eth_getTransactionReceipt", [last.transactionHash])]);
    const expectedAdminFile = path.join(TARGET, "deployments", c.chain.name, "ProxyAdmin.SynapseCCTP.json");
    const expectedAdmin = JSON.parse(fs.readFileSync(expectedAdminFile, "utf8")).address.toLowerCase();
    const callers = [...new Set(c.history.map(x => x.originalCaller))];
    const callerCollectors = {};
    for (const caller of callers) {
      const r = await any(urls, "eth_call", [{ to: PROXY, data: "0x41f355ee" + padAddress(caller) }, tag]);
      callerCollectors[caller] = address(r) || "0x0000000000000000000000000000000000000000";
    }
    const liveAdmin = address(adminSlot);
    const liveImpl = address(implSlot);
    const implementationNormalization = normalizeRuntime(path.join(TARGET, "artifacts", "SynapseCCTP.sol", "SynapseCCTP.json"), implCode);
    const routerNormalization = normalizeRuntime(path.join(TARGET, "artifacts", "SynapseCCTPRouter.sol", "SynapseCCTPRouter.json"), routerCode);
    checks.push({
      chain: c.chain,
      fixedHead: c.fixedHead,
      fixedHeadHashMatches: b.hash.toLowerCase() === c.fixedHead.hash.toLowerCase(),
      fixedHeadExplicitlyRequested: c.fixedHead.explicitlyRequested === true,
      implementation: liveImpl,
      implementationMatchesCapture: liveImpl === c.bindings.implementation.address,
      proxyAdmin: liveAdmin,
      proxyAdminNonzero: liveAdmin !== null,
      proxyAdminMatchesRaw: liveAdmin === c.bindings.proxy.admin,
      expectedProxyAdminArtifact: expectedAdmin,
      proxyAdminMatchesArtifact: liveAdmin === expectedAdmin,
      rawAdminAssertion: c.bindings.proxy.adminNonzeroAndMatchesArtifact === true && c.fixedHeadStateEvidence.adminSlotNonzero === true && c.fixedHeadStateEvidence.adminMatchesDeploymentArtifact === true,
      runtimeHashes: { proxySha256: shaHex(proxyCode), implementationSha256: shaHex(implCode), routerSha256: shaHex(routerCode) },
      runtimeMatchesCapture: shaHex(proxyCode) === c.bindings.proxy.codeSha256 && shaHex(implCode) === c.bindings.implementation.liveSha256 && shaHex(routerCode) === c.bindings.router.liveSha256,
      sourceRuntimeNormalization: { implementation: implementationNormalization, router: routerNormalization, pass: implementationNormalization.normalizedImmutableMatch && routerNormalization.normalizedImmutableMatch },
      circleContracts: {
        tokenMessenger: c.state.tokenMessenger, tokenMessengerBytes: (messengerCode.length - 2) / 2, tokenMessengerSha256: shaHex(messengerCode), tokenMessengerEip1967Implementation: address(messengerImpl),
        messageTransmitter: c.state.messageTransmitter, messageTransmitterBytes: (transmitterCode.length - 2) / 2, messageTransmitterSha256: shaHex(transmitterCode), messageTransmitterEip1967Implementation: address(transmitterImpl),
        fixedHeadProvenanceStatement: "not EIP-1967 proxies at fixed head; no broader direct-deployment provenance asserted",
      },
      relayerFeeCollectorsAtFixedHead: callerCollectors,
      lastReceipt: { transactionHash: last.transactionHash, status: BigInt(receipt.status).toString(), blockHash: receipt.blockHash, blockHashMatches: receipt.blockHash.toLowerCase() === last.blockHash.toLowerCase(), inputSha256: shaHex(tx.input), calldataMatches: shaHex(tx.input) === last.calldataBinding.inputSha256 },
      historyCount: c.history.length,
    });
  }

  const rawRecords = raw.chains.flatMap(c => c.history.map(h => ({ chainId: c.chain.chainId, record: h })));
  const refs = pub.payloadReferences || [];
  const refMap = new Map(refs.map(r => [`${r.chain.chainId}:${r.transactionHash.toLowerCase()}`, r]));
  const uniqueRefKeys = new Set(refMap.keys());
  const ledgerMismatches = [];
  let rawFullPayloadFieldCount = 0;
  for (const { chainId, record } of rawRecords) {
    if (record.publicCalldata || record._publicPayload || record.input || record.attestation || record.message || record.formattedRequest) rawFullPayloadFieldCount++;
    const key = `${chainId}:${record.transactionHash.toLowerCase()}`;
    const ref = refMap.get(key);
    const canonical = canonicalLedgerRecord(chainId, record);
    if (!ref || canonical !== record.ledgerBinding.canonicalRecordSha256 || canonical !== ref.canonicalRecordSha256 || ref.inputSha256 !== record.calldataBinding.inputSha256 || ref.attestationSha256 !== record.calldataBinding.attestationSha256 || ref.receiptStatus !== record.status || ref.blockHash.toLowerCase() !== record.blockHash.toLowerCase()) ledgerMismatches.push(key);
  }
  const retained = pub.retainedConsumedPayloads || [];
  const retainedHashChecks = retained.map(fullPayloadHashCheck);
  const corpusChecks = {
    rawRecordCount: rawRecords.length,
    referenceCount: refs.length,
    uniqueReferenceCount: uniqueRefKeys.size,
    referencesComplete: refs.length === rawRecords.length && uniqueRefKeys.size === refs.length && ledgerMismatches.length === 0,
    ledgerMismatchCount: ledgerMismatches.length,
    rawFullPayloadFieldCount,
    mainRawMinimized: rawFullPayloadFieldCount === 0 && raw.corpusMinimization.mainRawContainsFullPublicPayloads === false,
    retainedFullPayloadCount: retained.length,
    exactlyOneConsumedPayloadRetained: retained.length === 1,
    retainedPayloadHashesMatch: retainedHashChecks.every(x => Object.values(x).every(Boolean)),
    retainedPayloadLabelsValid: retained.every(x => x.publicChainData === true && x.alreadySuccessful === true && x.nonceConsumed === true && x.pendingOrUnconsumed === false && x.classification === "public-already-successful-nonce-consumed"),
    pendingOrUnconsumedAttestationsRetained: retained.filter(x => x.pendingOrUnconsumed || !x.alreadySuccessful || !x.nonceConsumed).length,
    fullPayloadReferenceCount: refs.filter(x => x.fullPayloadRetained).length,
    deduplicated: retained.length === 1 && refs.filter(x => x.fullPayloadRetained).length === 1,
    rawBytes: fs.statSync(RAW_FILE).size,
    publicCorpusBytes: fs.statSync(PUBLIC_FILE).size,
  };

  const forkBinding = {
    historicalTransactionHash: fork.binding.historicalTransactionHash,
    existsInCapture: rawRecords.some(x => x.record.transactionHash === fork.binding.historicalTransactionHash && x.record.calldataBinding.inputSha256 === fork.binding.calldataSha256),
    retainedPayloadMatchesFork: retained.length === 1 && retained[0].transactionHash === fork.binding.historicalTransactionHash && retained[0].calldataBinding.inputSha256 === fork.binding.calldataSha256,
    sourceRuntimeBound: fork.binding.implementation.normalizedImmutableMatch && fork.binding.router.normalizedImmutableMatch,
    successfulAlternateReplay: fork.replay.status === "1",
    originalRetryFailed: fork.originalRelayerRetry.receiptStatus === "0",
    userOutputMatchesEvent: fork.deltas.recipientToken === fork.expectedHistoricalEvent.userAmountOut,
    feeAccountingMatchesEvent: fork.deltas.alternateCollectorAccumulatedUsdc === fork.expectedHistoricalEvent.fee,
    nonceConsumed: fork.deltas.circleNonceBefore === false && fork.deltas.circleNonceAfter === true,
    deterministicReplay: fork.determinism?.match === true,
    economicsQualified: fork.economics.classification === "pre-withdrawal-modeled-net" && fork.economics.collectorWithdrawalGasIncluded === false && fork.economics.netUsdc === "0.83318283",
  };
  const onlineChecksPass = checks.every(x => x.fixedHeadHashMatches && x.fixedHeadExplicitlyRequested && x.implementationMatchesCapture && x.proxyAdminNonzero && x.proxyAdminMatchesRaw && x.proxyAdminMatchesArtifact && x.rawAdminAssertion && x.runtimeMatchesCapture && x.sourceRuntimeNormalization.pass && x.lastReceipt.status === "1" && x.lastReceipt.blockHashMatches && x.lastReceipt.calldataMatches);
  const corpusChecksPass = corpusChecks.referencesComplete && corpusChecks.mainRawMinimized && corpusChecks.exactlyOneConsumedPayloadRetained && corpusChecks.retainedPayloadHashesMatch && corpusChecks.retainedPayloadLabelsValid && corpusChecks.pendingOrUnconsumedAttestationsRetained === 0 && corpusChecks.deduplicated;
  const result = {
    schemaVersion: 2,
    revision: raw.revision,
    runId: `${raw.runId}-final-check`,
    generatedAt: new Date().toISOString(),
    safety: { readOnly: true, endpointMaterialPersisted: false, privateKeysUsed: false, broadcasts: false },
    checks,
    deterministicHeadConfiguration: raw.deterministicHeads,
    corpusChecks,
    forkBinding,
    validation: { onlineChecksPass, offlineAllRecordLedgerChecksPass: corpusChecks.referencesComplete, corpusMinimizationChecksPass: corpusChecksPass, sourceRuntimeNormalizationPass: checks.every(x => x.sourceRuntimeNormalization.pass), forkChecksPass: Object.values(forkBinding).every(Boolean) },
    artifactHashes: { rawSha256: shaFile(RAW_FILE), publicCalldataSha256: shaFile(PUBLIC_FILE), forkSha256: shaFile(FORK_FILE) },
  };
  result.pass = Object.values(result.validation).every(Boolean);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ runId: result.runId, pass: result.pass, admins: checks.map(x => ({ chain: x.chain.name, raw: raw.chains.find(c => c.chain.chainId === x.chain.chainId).bindings.proxy.admin, final: x.proxyAdmin, artifact: x.expectedProxyAdminArtifact })), corpusChecks, forkBinding }, null, 2));
}

main().catch(e => { console.error(e.message); process.exitCode = 1; });
