#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const {
  POLICY,
  POLICY_HASH,
  canonical,
} = require("./morpho-pt-27aug2026-post-expiry-r2-production-policy.js");
const PROFILE = require("./morpho-pt-27aug2026-post-expiry-r1-profile.js");
const OFFLINE = require("./validate-morpho-pt-27aug2026-post-expiry-r2.js");
class ValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ValidationError";
    this.code = code;
  }
}
const check = (v, c) => {
    if (!v) throw new ValidationError(c);
  },
  object = (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  exact = (v, k, c) => {
    const keys =
      c === "ACQUISITION_SCHEMA"
        ? [
            ...k,
            "inputMode",
            "nativeSupervisorPipeFifo",
            "hashesVerified",
            "inventoryFallbackUsed",
            "exclusiveWriterFramedGo",
            "windowsPeerEofRequired",
            "linuxWriterClosedAfterGo",
            "bufferedTrailingBytesRejected",
            "postGoChannelMonitored",
            "inventoryReadAfterPermanentLock",
            "goFrameCommitment",
            "executedCapture",
          ]
        : k;
    check(
      object(v) &&
        Object.keys(v).length === keys.length &&
        keys.every((key) => Object.hasOwn(v, key)),
      c,
    );
    if (c === "ACQUISITION_SCHEMA")
      check(
        v.inputMode === POLICY.input.mode &&
          v.nativeSupervisorPipeFifo === true &&
          v.hashesVerified === true &&
          v.inventoryFallbackUsed === false &&
          v.exclusiveWriterFramedGo === true &&
          v.windowsPeerEofRequired === false &&
          v.linuxWriterClosedAfterGo === true &&
          v.bufferedTrailingBytesRejected === true &&
          v.postGoChannelMonitored === true &&
          v.inventoryReadAfterPermanentLock === true &&
          /^[0-9a-f]{64}$/u.test(v.goFrameCommitment) &&
          object(v.executedCapture) &&
          v.executedCapture.path === POLICY.input.capturePath &&
          /^[0-9a-f]{64}$/u.test(v.executedCapture.sha256) &&
          /^\d+$/u.test(v.executedCapture.dev) &&
          /^\d+$/u.test(v.executedCapture.ino),
        "ACQUISITION_BRIDGE",
      );
  },
  sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex"),
  clone = (v) => JSON.parse(JSON.stringify(v)),
  same = (a, b) => canonical(a) === canonical(b);
function validatePermit(permit, bindings, now) {
  exact(
    permit,
    [
      "schema",
      "permitId",
      "mode",
      "approvalNonceCommitment",
      "issuedAt",
      "notBefore",
      "expiresAt",
      "policyHash",
      "productionHashes",
      "offlineHashes",
      "runtime",
      "bridge",
      "policy",
      "limits",
      "schemas",
      "output",
      "hardStops",
    ],
    "PERMIT_SCHEMA",
  );
  check(
    permit.schema === POLICY.permit.schema &&
      /^[0-9a-f]{64}$/u.test(permit.permitId) &&
      permit.mode === POLICY.mode &&
      /^[0-9a-f]{64}$/u.test(permit.approvalNonceCommitment) &&
      permit.policyHash === POLICY_HASH,
    "PERMIT_IDENTITY",
  );
  check(
    Number.isSafeInteger(permit.issuedAt) &&
      Number.isSafeInteger(permit.notBefore) &&
      Number.isSafeInteger(permit.expiresAt) &&
      permit.notBefore >= POLICY.expiryTimestamp * 1000 &&
      permit.issuedAt <= now &&
      permit.notBefore <= now &&
      permit.expiresAt > now &&
      permit.expiresAt - permit.issuedAt <= POLICY.permit.maxLifetimeMs,
    "PERMIT_TIME",
  );
  exact(
    permit.productionHashes,
    [
      "policy",
      "adapter",
      "capture",
      "validator",
      "test",
      "nativeSupervisorSource",
      "nativeSupervisorSourceCandidate",
      "nativeBuildManifest",
      "launcherSource",
      "launcherBinary",
    ],
    "PERMIT_HASH_SCHEMA",
  );
  exact(
    permit.offlineHashes,
    [
      "profile",
      "engine",
      "validator",
      "test",
      "disabledCapture",
      "sharedGate",
      "inventoryParser",
    ],
    "PERMIT_HASH_SCHEMA",
  );
  exact(
    permit.bridge,
    [
      "inputMode",
      "exclusiveWriterFramedGo",
      "windowsPeerEofRequired",
      "linuxWriterClosedAfterGo",
      "bufferedTrailingBytesRejected",
      "postGoChannelMonitored",
      "inventoryReadAfterPermanentLock",
      "goFrameLayout",
      "nativeSupervisorDeadlineMs",
      "preGoDeadlineMs",
      "postGoDeadlineMs",
      "nativeSupervisorSourceSha256",
      "nativeSupervisorRuntimeSha256",
      "nativeSupervisorSourceCandidateSha256",
      "nativeBuildManifestSha256",
      "launcherSourceSha256",
      "launcherBinarySha256",
      "nodeExecutableSha256",
      "nodeExecutablePath",
      "nodeVersion",
      "productionCapturePath",
      "productionCaptureSha256",
      "productionCaptureIdentity",
      "runtimeFilePaths",
      "nativeMountPolicy",
      "nativeMountIdentity",
    ],
    "PERMIT_BRIDGE_SCHEMA",
  );
  exact(
    permit.bridge.productionCaptureIdentity,
    ["dev", "ino"],
    "PERMIT_CAPTURE_IDENTITY_SCHEMA",
  );
  exact(
    permit.bridge.goFrameLayout,
    ["magic", "version", "type", "sequence", "bytes", "terminal", "authCommitment"],
    "PERMIT_GO_LAYOUT_SCHEMA",
  );
  exact(
    permit.bridge.nativeMountPolicy,
    [
      "filesystems",
      "requireSameIdentity",
      "uid",
      "regularFileNlink",
      "forbidGroupOtherWrite",
    ],
    "PERMIT_MOUNT_POLICY_SCHEMA",
  );
  exact(
    permit.bridge.nativeMountIdentity,
    ["mountId", "majorMinor", "root", "mountPoint", "fsType", "source"],
    "PERMIT_MOUNT_IDENTITY_SCHEMA",
  );
  for (const map of [permit.productionHashes, permit.offlineHashes])
    check(
      Object.values(map).every((x) => /^[0-9a-f]{64}$/u.test(x)),
      "PERMIT_HASH_SCHEMA",
    );
  check(
    canonical(permit.productionHashes) ===
      canonical(bindings.productionHashes) &&
      canonical(permit.offlineHashes) === canonical(bindings.offlineHashes) &&
      canonical(permit.bridge) === canonical(bindings.bridge),
    "PERMIT_HASH",
  );
  exact(
    permit.runtime,
    ["nodeVersion", "platform", "arch", "toolchain"],
    "PERMIT_RUNTIME_SCHEMA",
  );
  check(
    permit.runtime.platform === "linux" &&
      canonical(permit.runtime) === canonical(bindings.runtime),
    "PERMIT_RUNTIME",
  );
  check(
    permit.bridge.inputMode === POLICY.input.mode &&
      permit.bridge.exclusiveWriterFramedGo === true &&
      permit.bridge.windowsPeerEofRequired === false &&
      permit.bridge.linuxWriterClosedAfterGo === true &&
      permit.bridge.bufferedTrailingBytesRejected === true &&
      permit.bridge.postGoChannelMonitored === true &&
      permit.bridge.inventoryReadAfterPermanentLock === true &&
      canonical(permit.bridge.goFrameLayout) === canonical({magic:POLICY.input.goMagic,version:POLICY.input.goVersion,type:POLICY.input.goType,sequence:POLICY.input.goSequence,bytes:POLICY.input.goBytes,terminal:POLICY.input.goTerminal,authCommitment:"SHA256_EXACT_PRELUDE"}) &&
      permit.bridge.nativeSupervisorDeadlineMs ===
        POLICY.input.nativeSupervisorDeadlineMs &&
      permit.bridge.preGoDeadlineMs === POLICY.input.preGoDeadlineMs &&
      permit.bridge.postGoDeadlineMs === POLICY.input.postGoDeadlineMs &&
      permit.bridge.nativeSupervisorRuntimeSha256 ===
        permit.bridge.nativeSupervisorSourceCandidateSha256 &&
      canonical(permit.bridge.nativeMountPolicy) ===
        canonical(POLICY.input.mountPolicy) &&
      POLICY.input.mountPolicy.filesystems.includes(
        permit.bridge.nativeMountIdentity.fsType,
      ) &&
      Number.isSafeInteger(permit.bridge.nativeMountIdentity.mountId) &&
      /^\d+:\d+$/u.test(permit.bridge.nativeMountIdentity.majorMinor) &&
      permit.bridge.nodeExecutablePath === POLICY.input.nodePath &&
      permit.bridge.nodeVersion === POLICY.input.nodeVersion &&
      permit.bridge.productionCapturePath === POLICY.input.capturePath &&
      permit.bridge.productionCaptureSha256 === permit.productionHashes.capture &&
      /^\d+$/u.test(permit.bridge.productionCaptureIdentity.dev) &&
      /^\d+$/u.test(permit.bridge.productionCaptureIdentity.ino) &&
      Array.isArray(permit.bridge.runtimeFilePaths) &&
      permit.bridge.runtimeFilePaths.includes(POLICY.input.capturePath) &&
      Object.entries(permit.bridge)
        .filter(([key]) => key.endsWith("Sha256"))
        .every(([, value]) => /^[0-9a-f]{64}$/u.test(value)),
    "PERMIT_BRIDGE",
  );
  check(
    canonical(permit.policy) ===
      canonical({
        hash: POLICY_HASH,
        profileHash: POLICY.profileHash,
        chainId: 1,
        expiryTimestamp: POLICY.expiryTimestamp,
        inputMode: POLICY.input.mode,
      }) &&
      canonical(permit.limits) === canonical(POLICY.limits) &&
      canonical(permit.schemas) === canonical(POLICY.schemas) &&
      canonical(permit.output) === canonical(POLICY.output) &&
      canonical(permit.hardStops) === canonical(POLICY.hardStops),
    "PERMIT_BINDING",
  );
}
function rejectPrivate(v) {
  if (typeof v === "string") {
    check(!/(?:https?|wss):\/\//iu.test(v), "PRIVATE_URL");
    check(
      !/\b(?:bearer|authorization|credential|secret|token|password|operator-family)\b/iu.test(
        v,
      ),
      "PRIVATE_SECRET",
    );
  } else if (Array.isArray(v)) v.forEach(rejectPrivate);
  else if (object(v))
    for (const [k, x] of Object.entries(v)) {
      check(
        !/^(?:endpoint|headers?|family|operatorFamily|transportConfig)$/iu.test(
          k,
        ),
        "PRIVATE_KEY",
      );
      rejectPrivate(x);
    }
}
function acquisitionPreimage(
  capture,
  permit,
  outer,
  transcriptHash,
  selection,
  acquisition,
  ledgerCommitments,
) {
  return {
    domain: "morpho-pt-27aug2026-post-expiry-r2-production-acquisition/v4",
    version: 4,
    policyHash: POLICY_HASH,
    profileHash: POLICY.profileHash,
    capturePayloadHash: capture.integrity.payloadHash,
    permit: {
      permitId: permit.permitId,
      approvalNonceCommitment: permit.approvalNonceCommitment,
      issuedAt: permit.issuedAt,
      notBefore: permit.notBefore,
      expiresAt: permit.expiresAt,
      productionHashes: permit.productionHashes,
      offlineHashes: permit.offlineHashes,
      runtime: permit.runtime,
      bridge: permit.bridge,
    },
    acquisition,
    outer,
    selection,
    transcriptHash,
    ledgerCommitments,
  };
}
function validateHeader(h) {
  exact(
    h,
    ["number", "hash", "parentHash", "stateRoot", "timestamp"],
    "TRANSCRIPT_HEADER_SCHEMA",
  );
  check(
    Number.isSafeInteger(h.number) &&
      h.number >= 0 &&
      Number.isSafeInteger(h.timestamp) &&
      h.timestamp >= 0 &&
      [h.hash, h.parentHash, h.stateRoot].every((x) =>
        /^0x[0-9a-f]{64}$/u.test(x),
      ),
    "TRANSCRIPT_HEADER",
  );
}
function validateTranscriptRows(transcript, count) {
  check(Array.isArray(transcript) && transcript.length > 0, "TRANSCRIPT_COUNT");
  const classes = new Map(),
    counterKeys = [
      "dns",
      "socket",
      "connect",
      "tls",
      "data",
      "requestDestroyed",
      "socketDestroyed",
      "agentDestroyed",
    ];
  for (let i = 0; i < transcript.length; i++) {
    const x = transcript[i];
    exact(
      x,
      [
        "sequence",
        "candidateIndex",
        "stageId",
        "methodKind",
        "blockTag",
        "blockHash",
        "header",
        "outcome",
        "reason",
        "bytes",
        "elapsedMs",
        "transportClass",
        "counters",
      ],
      "TRANSCRIPT_SCHEMA",
    );
    check(
      x.sequence === i + 1 &&
        Number.isSafeInteger(x.candidateIndex) &&
        x.candidateIndex >= 0 &&
        x.candidateIndex < count &&
        typeof x.stageId === "string" &&
        /^[A-Za-z0-9_-]+$/u.test(x.stageId) &&
        ["CHAIN_ID", "HEADER", "CALL", "CODE"].includes(x.methodKind) &&
        ["PASS", "FAIL"].includes(x.outcome) &&
        (x.outcome === "PASS" ? x.reason === null : typeof x.reason === "string") &&
        Number.isSafeInteger(x.bytes) &&
        x.bytes >= 0 &&
        x.bytes <= POLICY.limits.responseBytesPerRequest &&
        Number.isSafeInteger(x.elapsedMs) &&
        x.elapsedMs >= 0 &&
        x.elapsedMs <= (x.outcome === "PASS" ? POLICY.limits.requestMs : POLICY.limits.wallMs) &&
        ["DIRECT_HTTPS", "LOCALHOST_KEYLESS_RELAY"].includes(x.transportClass),
      "TRANSCRIPT_VALUE",
    );
    if (x.header !== null) validateHeader(x.header);
    check(
      (x.methodKind !== "HEADER" || x.outcome === "FAIL" || x.header !== null) &&
        (x.blockTag === null ||
          x.blockTag === "finalized" ||
          Number.isSafeInteger(x.blockTag)) &&
        (x.blockHash === null || /^0x[0-9a-f]{64}$/u.test(x.blockHash)),
      "TRANSCRIPT_BLOCK",
    );
    if (Number.isSafeInteger(x.blockTag) && x.header !== null)
      check(x.header.number === x.blockTag, "TRANSCRIPT_BLOCK_NUMBER");
    if (classes.has(x.candidateIndex))
      check(
        classes.get(x.candidateIndex) === x.transportClass,
        "TRANSCRIPT_CLASS_CHANGED",
      );
    else classes.set(x.candidateIndex, x.transportClass);
    exact(x.counters, counterKeys, "TRANSCRIPT_COUNTER_SCHEMA");
    for (const k of counterKeys)
      check(
        Number.isSafeInteger(x.counters[k]) && x.counters[k] >= 0,
        "TRANSCRIPT_COUNTER",
      );
    if (x.outcome === "PASS") check(
      x.counters.socket === 1 &&
        x.counters.connect === 1 &&
        x.counters.tls === (x.transportClass === "DIRECT_HTTPS" ? 1 : 0) &&
        x.counters.data >= 1 &&
        x.counters.agentDestroyed === 1,
      "TRANSCRIPT_COUNTER_EXPECTED",
    );
  }
  return classes;
}
function reconstruct(capture, transcript, selection, context) {
  exact(
    context,
    ["candidateCount", "engineAttemptLedger", "engineLedgerCommitment", "engineQualification", "familyTokens", "poolAttemptLedger", "poolCandidateCount", "poolLedgerCommitment", "poolOutcomes", "ranking", "selectedPoolIndices"],
    "ENGINE_CONTEXT_SCHEMA",
  );
  const n = context.candidateCount;
  check(
    Number.isSafeInteger(n) &&
      n >= 3 &&
      n <= 4 &&
      Array.isArray(context.familyTokens) &&
      context.familyTokens.length === n &&
      context.familyTokens.every((x) => typeof x === "string") &&
      Array.isArray(context.ranking) &&
      context.ranking.length === n &&
      context.poolCandidateCount === 8 &&
      Array.isArray(context.selectedPoolIndices) && context.selectedPoolIndices.length === n &&
      new Set(context.selectedPoolIndices).size === n &&
      context.selectedPoolIndices.every((x) => Number.isSafeInteger(x) && x >= 0 && x < 8) &&
      Array.isArray(context.poolOutcomes) && context.poolOutcomes.length === 8 &&
      Array.isArray(context.poolAttemptLedger) && context.poolAttemptLedger.length === 32 &&
      Array.isArray(context.engineAttemptLedger) &&
      Array.isArray(context.engineQualification) && context.engineQualification.length === n &&
      context.engineQualification.every((x, i) => object(x) && x.candidateIndex === i && ["PASS", "REJECT"].includes(x.outcome) && [null, "QUALIFICATION", "COMMON_PIN"].includes(x.stage) && (x.outcome === "PASS" ? x.reason === null && x.stage === null : ["HTTP_STATUS", "HTTP_BODY_LIMIT", "RPC_JSON", "RPC_ENVELOPE", "RESULT_SCHEMA", "CHAIN_ID_MISMATCH", "BLOCK_NUMBER_MISMATCH", "BLOCK_HASH_MISMATCH"].includes(x.reason) && x.stage !== null)) &&
      context.poolLedgerCommitment === sha256(canonical(context.poolAttemptLedger)) &&
      context.engineLedgerCommitment === sha256(canonical(context.engineAttemptLedger)),
    "ENGINE_CONTEXT",
  );
  for (const row of context.engineQualification) exact(row, ["candidateIndex", "outcome", "reason", "stage"], "ENGINE_QUALIFICATION_SCHEMA");
  check(context.engineQualification.filter((x) => x.stage !== "QUALIFICATION").length === capture.qualification.qualifiedCandidates, "ENGINE_QUALIFICATION_COUNT");
  const poolMethods = ["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"], poolStages = ["POOL_CHAIN_ID", "POOL_FINALIZED", "POOL_CODE", "POOL_EXPIRY"], localReasons = new Set(["HTTP_STATUS", "HTTP_BODY_LIMIT", "RPC_JSON", "RPC_ENVELOPE", "RESULT_SCHEMA", "CHAIN_ID_MISMATCH", "BLOCK_NUMBER_MISMATCH", "BLOCK_HASH_MISMATCH"]), counterNames = ["dns", "socket", "connect", "tls", "data", "requestDestroyed", "socketDestroyed", "agentDestroyed"];
  for (let i = 0; i < 32; i++) {
    const row = context.poolAttemptLedger[i], poolIndex = Math.floor(i / 4), attemptIndex = i % 4;
    check(object(row) && row.poolIndex === poolIndex && row.attemptIndex === attemptIndex && row.stage === poolStages[attemptIndex] && row.method === poolMethods[attemptIndex] && row.blockTag === (attemptIndex === 1 ? "finalized" : null) && (row.blockHash === null || /^0x[0-9a-f]{64}$/u.test(row.blockHash)) && ["PASS", "FAIL", "SKIP"].includes(row.outcome), "POOL_LEDGER_SCHEMA");
    if (row.outcome === "SKIP") exact(row, ["poolIndex", "attemptIndex", "stage", "method", "blockTag", "blockHash", "outcome", "reason"], "POOL_SKIP_SCHEMA");
    else {
      exact(row, row.outcome === "PASS" ? ["poolIndex", "attemptIndex", "stage", "method", "blockTag", "blockHash", "outcome", "bytes", "elapsedMs", "counters", "transportClass"] : ["poolIndex", "attemptIndex", "stage", "method", "blockTag", "blockHash", "outcome", "reason", "bytes", "elapsedMs", "counters", "transportClass"], "POOL_ATTEMPT_SCHEMA");
      check(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= POLICY.limits.responseBytesPerRequest && Number.isSafeInteger(row.elapsedMs) && row.elapsedMs >= 0 && row.elapsedMs <= (row.outcome === "PASS" ? POLICY.limits.requestMs : POLICY.limits.wallMs) && ["DIRECT_HTTPS", "LOCALHOST_KEYLESS_RELAY"].includes(row.transportClass), "POOL_ATTEMPT_SCHEMA");
      exact(row.counters, counterNames, "POOL_COUNTER_SCHEMA");
      for (const name of counterNames) check(Number.isSafeInteger(row.counters[name]) && row.counters[name] >= 0, "POOL_COUNTER_VALUE");
      if (row.outcome === "FAIL") check(localReasons.has(row.reason), "POOL_FAILURE_REASON");
    }
  }
  for (let i = 0; i < 8; i++) {
    const outcome = context.poolOutcomes[i], rows = context.poolAttemptLedger.slice(i * 4, i * 4 + 4), failures = rows.filter((x) => x.outcome === "FAIL");
    exact(outcome, ["poolIndex", "passed", "reason", "attempts", "operatorFamily"], "POOL_OUTCOME_SCHEMA");
    check(outcome.poolIndex === i && outcome.attempts === 4 && typeof outcome.operatorFamily === "string" && (outcome.passed ? failures.length === 0 && rows.every((x) => x.outcome === "PASS") && outcome.reason === null : failures.length === 1 && outcome.reason === failures[0].reason), "POOL_OUTCOME");
    if (!outcome.passed) { const failureAt = rows.findIndex((x) => x.outcome === "FAIL"); check(rows.slice(0, failureAt).every((x) => x.outcome === "PASS") && rows.slice(failureAt + 1).every((x) => x.outcome === "SKIP" && x.reason === "CANDIDATE_FAILED"), "POOL_SKIP_ORDER"); }
    const materialRows = rows.slice(2).filter((x) => x.outcome !== "SKIP");
    check(rows[0].blockHash === null && rows[1].blockHash === null && (materialRows.length === 0 || materialRows.every((x) => /^0x[0-9a-f]{64}$/u.test(x.blockHash)) && new Set(materialRows.map((x) => x.blockHash)).size === 1), "POOL_BLOCK_PROGRESSION");
  }
  const expectedSelected = [], seenFamilies = new Set(), passingPool = context.poolOutcomes.filter((x) => x.passed === true);
  for (const row of passingPool) if (!seenFamilies.has(row.operatorFamily) && expectedSelected.length < 4) { expectedSelected.push(row.poolIndex); seenFamilies.add(row.operatorFamily); }
  for (const row of passingPool) if (!expectedSelected.includes(row.poolIndex) && expectedSelected.length < 4) expectedSelected.push(row.poolIndex);
  check(same(expectedSelected, context.selectedPoolIndices), "POOL_SELECTION");
  for (let i = 0; i < n; i++) {
    const r = context.ranking[i];
    exact(
      r,
      ["candidateIndex", "capabilityRank", "premium", "inventoryOrder"],
      "ENGINE_RANK_SCHEMA",
    );
    check(
      r.candidateIndex === i &&
        Number.isSafeInteger(r.capabilityRank) &&
        r.capabilityRank >= 0 &&
        r.capabilityRank <= 100 &&
        typeof r.premium === "boolean" &&
        Number.isSafeInteger(r.inventoryOrder) &&
        r.inventoryOrder >= 0,
      "ENGINE_RANK",
    );
  }
  let cursor = 0;
  const take = (idx, stage, kind, tag = null, bh = null) => {
    const row = transcript[cursor++];
    check(
      row &&
        row.candidateIndex === idx &&
        row.stageId === stage &&
        row.methodKind === kind &&
        row.blockTag === tag &&
        row.blockHash === bh,
      "TRANSCRIPT_SCHEDULE",
    );
    return row;
  };
  for (let i = 0; i < n; i++) {
    take(i, "ADAPTER_CHAIN_ID", "CHAIN_ID");
    const finalized = take(
      i,
      "ADAPTER_FINALIZED",
      "HEADER",
      "finalized",
    ).header;
    take(i, "ADAPTER_CODE", "CODE", null, finalized.hash);
    take(i, "ADAPTER_EXPIRY", "CALL", null, finalized.hash);
  }
  const qualified = [];
  for (let i = 0; i < n; i++) {
    const expected = context.engineQualification[i], chain = take(i, "ENGINE_QUAL_CHAIN_ID", "CHAIN_ID");
    if (chain.outcome === "FAIL") { check(expected.outcome === "REJECT" && expected.stage === "QUALIFICATION" && chain.reason === expected.reason, "TRANSCRIPT_QUALIFICATION"); continue; }
    const finalizedRow = take(i, "ENGINE_QUAL_FINALIZED", "HEADER", "finalized");
    if (finalizedRow.outcome === "FAIL") { check(expected.outcome === "REJECT" && expected.stage === "QUALIFICATION" && finalizedRow.reason === expected.reason, "TRANSCRIPT_QUALIFICATION"); continue; }
    const finalized = finalizedRow.header, exactRow = take(i, "ENGINE_QUAL_EXACT", "HEADER", finalized.number);
    if (exactRow.outcome === "FAIL") { check(expected.outcome === "REJECT" && expected.stage === "QUALIFICATION" && exactRow.reason === expected.reason, "TRANSCRIPT_QUALIFICATION"); continue; }
    const exactHeader = exactRow.header;
    if (!same(finalized, exactHeader)) { check(expected.outcome === "REJECT" && expected.stage === "QUALIFICATION" && expected.reason === "BLOCK_HASH_MISMATCH", "TRANSCRIPT_QUALIFICATION"); continue; }
    const multiRow = take(i, "ENGINE_QUAL_MULTICALL", "CALL", null, exactHeader.hash);
    if (multiRow.outcome === "FAIL") { check(expected.outcome === "REJECT" && expected.stage === "QUALIFICATION" && multiRow.reason === expected.reason, "TRANSCRIPT_QUALIFICATION"); continue; }
    check(expected.outcome === "PASS" || expected.stage === "COMMON_PIN", "TRANSCRIPT_QUALIFICATION");
    qualified.push({
      index: i,
      finalized: exactHeader,
      rank: context.ranking[i],
    });
  }
  check(qualified.length >= 3 && new Set(qualified.map((x) => context.familyTokens[x.index])).size >= 2, "TRANSCRIPT_QUALIFICATION");
  exact(
    selection,
    [
      "locatorIndex",
      "evidenceIndices",
      "commonPinSchedule",
      "binarySearch",
      "adapterRequests",
      "engineRequests",
    ],
    "SELECTION_SCHEMA",
  );
  check(
    selection.adapterRequests === 4 * n &&
      selection.engineRequests === capture.budgets.used.requests &&
      selection.adapterRequests + selection.engineRequests ===
        transcript.length,
    "SELECTION_COUNTS",
  );
  const heights = [...new Set(qualified.map((x) => x.finalized.number))].sort(
      (a, b) => b - a,
    ),
    computedSchedule = [];
  let commonIndices = null;
  const activeQualified = new Set(qualified.map((x) => x.index));
  for (const height of heights) {
    const eligible = qualified.filter((x) => activeQualified.has(x.index) && x.finalized.number >= height),
      groups = new Map(),
      observed = [];
    for (const row of eligible) {
      const commonRow = take(
          row.index,
          `ENGINE_COMMON_${height}`,
          "HEADER",
          height,
        );
      if (commonRow.outcome === "FAIL") {
        const expected = context.engineQualification[row.index];
        check(expected.outcome === "REJECT" && expected.stage === "COMMON_PIN" && expected.reason === commonRow.reason, "TRANSCRIPT_COMMON_REJECTION");
        activeQualified.delete(row.index);
        continue;
      }
      const h = commonRow.header,
        key = canonical(h),
        g = groups.get(key) || [];
      g.push(row.index);
      groups.set(key, g);
      observed.push(row.index);
    }
    const viable = [...groups.values()]
      .filter((g) => g.length >= 3 && new Set(g.map((i) => context.familyTokens[i])).size >= 2)
      .sort(
        (a, b) =>
          b.length - a.length ||
          Math.min(...a.map((i) => context.ranking[i].inventoryOrder)) -
            Math.min(...b.map((i) => context.ranking[i].inventoryOrder)),
      )[0];
    computedSchedule.push({
      height,
      eligibleCandidateIndices: eligible.map((x) => x.index),
      observedCandidateIndices: observed,
      agreementCandidateIndices: viable || [],
    });
    if (viable) {
      commonIndices = viable;
      break;
    }
  }
  check(
    commonIndices && same(computedSchedule, selection.commonPinSchedule),
    "SELECTION_COMMON",
  );
  const agreedHeight = computedSchedule.at(-1).height;
  check(
    commonIndices.every((idx) =>
      transcript.some(
        (row) =>
          row.candidateIndex === idx &&
          row.stageId === `ENGINE_COMMON_${agreedHeight}` &&
          same(row.header, capture.pin),
      ),
    ),
    "SELECTION_COMMON_PIN",
  );
  const rank = (indices) =>
      [...indices].sort(
        (a, b) =>
          context.ranking[b].capabilityRank -
            context.ranking[a].capabilityRank ||
          Number(context.ranking[b].premium) -
            Number(context.ranking[a].premium) ||
          context.ranking[a].inventoryOrder - context.ranking[b].inventoryOrder,
      ),
    ranked = rank(commonIndices),
    first = ranked[0],
    second = ranked.find(
      (i) => context.familyTokens[i] !== context.familyTokens[first],
    ),
    evidence = [first, second],
    locator = rank(commonIndices).find(
      (i) => !evidence.includes(i),
    );
  check(
    second !== undefined &&
      locator !== undefined &&
      same(evidence, selection.evidenceIndices) &&
      locator === selection.locatorIndex &&
      new Set([...evidence, locator]).size === 3,
    "SELECTION_INDICES",
  );
  const binary = [];
  let low = 1,
    high = capture.pin.number;
  while (low < high) {
    const middle = Math.floor((low + high) / 2),
      h = take(locator, `ENGINE_LOCATOR_${middle}`, "HEADER", middle).header;
    binary.push({ candidateIndex: locator, height: middle });
    if (h.timestamp >= POLICY.expiryTimestamp) high = middle;
    else low = middle + 1;
  }
  check(
    low === capture.boundary.postBlock.number &&
      same(binary, selection.binarySearch),
    "SELECTION_LOCATOR",
  );
  for (const idx of evidence) {
    check(
      same(
        take(
          idx,
          `ENGINE_EVIDENCE_${idx}_PRE_HEADER`,
          "HEADER",
          capture.boundary.preBlock.number,
        ).header,
        capture.boundary.preBlock,
      ),
      "TRANSCRIPT_BOUNDARY",
    );
    check(
      same(
        take(
          idx,
          `ENGINE_EVIDENCE_${idx}_POST_HEADER`,
          "HEADER",
          capture.boundary.postBlock.number,
        ).header,
        capture.boundary.postBlock,
      ),
      "TRANSCRIPT_BOUNDARY",
    );
    take(
      idx,
      `ENGINE_EVIDENCE_${idx}_PRE_MULTICALL`,
      "CALL",
      null,
      capture.boundary.preBlock.hash,
    );
    take(
      idx,
      `ENGINE_EVIDENCE_${idx}_POST_MULTICALL`,
      "CALL",
      null,
      capture.boundary.postBlock.hash,
    );
    for (const op of PROFILE.profile.operations) {
      take(
        idx,
        `ENGINE_EVIDENCE_${idx}_OP_${op.id}_PRE`,
        op.kind === "call" ? "CALL" : "CODE",
        null,
        capture.boundary.preBlock.hash,
      );
      take(
        idx,
        `ENGINE_EVIDENCE_${idx}_OP_${op.id}_POST`,
        op.kind === "call" ? "CALL" : "CODE",
        null,
        capture.boundary.postBlock.hash,
      );
    }
  }
  for (const idx of evidence)
    take(idx, `ENGINE_POST_COMMON_${idx}`, "CALL", null, capture.pin.hash);
  for (const idx of evidence) {
    check(
      take(idx, `ENGINE_TERMINAL_${idx}_FINALIZED`, "HEADER", "finalized")
        .header.number >= capture.pin.number,
      "TRANSCRIPT_TERMINAL",
    );
    check(
      same(
        take(
          idx,
          `ENGINE_TERMINAL_${idx}_PIN_HEADER`,
          "HEADER",
          capture.pin.number,
        ).header,
        capture.pin,
      ),
      "TRANSCRIPT_TERMINAL",
    );
    take(
      idx,
      `ENGINE_TERMINAL_${idx}_PIN_MULTICALL`,
      "CALL",
      null,
      capture.pin.hash,
    );
    for (const [side, h] of [
      ["PRE", capture.boundary.preBlock],
      ["POST", capture.boundary.postBlock],
    ]) {
      check(
        same(
          take(idx, `ENGINE_TERMINAL_${idx}_${side}_HEADER`, "HEADER", h.number)
            .header,
          h,
        ),
        "TRANSCRIPT_TERMINAL",
      );
      take(
        idx,
        `ENGINE_TERMINAL_${idx}_${side}_MULTICALL`,
        "CALL",
        null,
        h.hash,
      );
    }
  }
  check(cursor === transcript.length, "TRANSCRIPT_TRAILING");
  return {
    locatorIndex: locator,
    evidenceIndices: evidence,
    commonPinSchedule: computedSchedule,
    binarySearch: binary,
  };
}
function validateProduction(
  capture,
  {
    permit,
    bindings,
    outer,
    transcript,
    usage,
    selection,
    engineContext,
    acquisition,
    now = Date.now(),
    offlineValidator = OFFLINE,
  } = {},
) {
  check(offlineValidator === OFFLINE, "OFFLINE_VALIDATOR_IDENTITY");
  OFFLINE.validateArtifact(capture, { now });
  validatePermit(permit, bindings, now);
  exact(
    outer,
    [
      "requests",
      "responseBytes",
      "maxConcurrency",
      "maxPerCandidateRequests",
      "perCandidate",
    ],
    "OUTER_SCHEMA",
  );
  check(
    Array.isArray(outer.perCandidate) &&
      outer.perCandidate.length === 8,
    "OUTER",
  );
  const sum = outer.perCandidate.reduce((total, x, i) => {
      exact(x, ["candidateIndex", "requests"], "OUTER_CANDIDATE_SCHEMA");
      check(
        x.candidateIndex === i &&
          Number.isSafeInteger(x.requests) &&
          x.requests > 0 &&
          x.requests <= POLICY.limits.outerEvidenceRequests,
        "OUTER_CANDIDATE",
      );
      return total + x.requests;
    }, 0),
    max = Math.max(...outer.perCandidate.map((x) => x.requests));
  check(
    outer.requests === sum &&
      outer.requests <= POLICY.limits.outerRequests &&
      Number.isSafeInteger(outer.responseBytes) &&
      outer.responseBytes >= 0 &&
      outer.responseBytes <= POLICY.limits.responseBytes &&
      outer.maxConcurrency === 1 &&
      outer.maxPerCandidateRequests === max,
    "OUTER",
  );
  validateTranscriptRows(transcript, engineContext.candidateCount);
  const poolRows = engineContext.poolAttemptLedger.filter((x) => x.outcome !== "SKIP"),
    adapterCount = selection.adapterRequests,
    engineRows = transcript.slice(adapterCount),
    actualRows = [...poolRows, ...engineRows],
    classes = new Map(poolRows.map((x) => [x.poolIndex, x.transportClass])),
    reconstructed = reconstruct(capture, transcript, selection, engineContext),
    per = Array(outer.perCandidate.length).fill(0),
    counterKeys = [
      "dns",
      "socket",
      "connect",
      "tls",
      "data",
      "requestDestroyed",
      "socketDestroyed",
      "agentDestroyed",
    ],
    counterSums = Object.fromEntries(counterKeys.map((k) => [k, 0]));
  for (let i = 0; i < engineContext.candidateCount; i++) for (let j = 0; j < 4; j++) {
    const poolRow = engineContext.poolAttemptLedger.find((x) => x.poolIndex === engineContext.selectedPoolIndices[i] && x.attemptIndex === j);
    check(poolRow && poolRow.outcome === "PASS" && poolRow.bytes === transcript[i * 4 + j].bytes && poolRow.elapsedMs === transcript[i * 4 + j].elapsedMs && same(poolRow.counters, transcript[i * 4 + j].counters), "OUTER_TRANSCRIPT_ACCOUNTING");
  }
  let bytes = 0,
    direct = 0,
    relay = 0;
  for (const row of actualRows) {
    const poolIndex = Object.hasOwn(row, "poolIndex") ? row.poolIndex : engineContext.selectedPoolIndices[row.candidateIndex];
    per[poolIndex]++;
    bytes += row.bytes;
    if (row.transportClass === "DIRECT_HTTPS") direct++;
    else relay++;
    for (const k of counterKeys) counterSums[k] += row.counters[k];
  }
  check(
    bytes === outer.responseBytes &&
      same(
        per,
        outer.perCandidate.map((x) => x.requests),
      ),
    "OUTER_TRANSCRIPT_ACCOUNTING",
  );
  check(
    engineRows.length === capture.budgets.used.requests &&
      engineRows.reduce((n, x) => n + x.bytes, 0) ===
        capture.budgets.used.responseBytes,
    "ENGINE_ACCOUNTING",
  );
  const projectedEngineLedger = engineRows.map((row, attemptIndex) => ({ attemptIndex, candidateIndex: row.candidateIndex, method: row.methodKind === "CHAIN_ID" ? "eth_chainId" : row.methodKind === "HEADER" ? "eth_getBlockByNumber" : row.methodKind === "CODE" ? "eth_getCode" : "eth_call", stage: row.stageId, outcome: row.outcome, reason: row.reason, bytes: row.bytes, elapsedMs: row.elapsedMs, counters: row.counters, transportClass: row.transportClass }));
  check(same(projectedEngineLedger, engineContext.engineAttemptLedger), "ENGINE_LEDGER");
  exact(
    usage,
    [
      "direct",
      "relay",
      "counters",
      "elapsedMs",
      "retries",
      "dnsQualifications",
    ],
    "USAGE_SCHEMA",
  );
  exact(usage.counters, counterKeys, "USAGE_COUNTER_SCHEMA");
  check(
    usage.direct === direct &&
      usage.relay === relay &&
      same(usage.counters, counterSums) &&
      Number.isSafeInteger(usage.elapsedMs) &&
      usage.elapsedMs >= 0 &&
      usage.elapsedMs <= POLICY.limits.wallMs &&
      usage.retries === 0 &&
      Number.isSafeInteger(usage.dnsQualifications) &&
      usage.dnsQualifications >= 0 &&
      usage.dnsQualifications <= outer.perCandidate.length,
    "USAGE",
  );
  const directCandidates = [...classes.entries()].filter(
    ([, v]) => v === "DIRECT_HTTPS",
  ).length;
  check(
    (direct > 0 &&
      usage.dnsQualifications >= 1 &&
      usage.dnsQualifications <= directCandidates) ||
      (direct === 0 && usage.dnsQualifications === 0),
    "DNS_USAGE",
  );
  exact(
    acquisition,
    [
      "permitId",
      "approvalNonceCommitment",
      "issuedAt",
      "notBefore",
      "expiresAt",
      "acquiredAt",
      "completedAt",
    ],
    "ACQUISITION_SCHEMA",
  );
  exact(
    acquisition.executedCapture,
    ["path", "sha256", "dev", "ino"],
    "ACQUISITION_CAPTURE_SCHEMA",
  );
  check(
    acquisition.permitId === permit.permitId &&
      acquisition.approvalNonceCommitment === permit.approvalNonceCommitment &&
      acquisition.issuedAt === permit.issuedAt &&
      acquisition.notBefore === permit.notBefore &&
      acquisition.expiresAt === permit.expiresAt &&
      Number.isSafeInteger(acquisition.acquiredAt) &&
      Number.isSafeInteger(acquisition.completedAt) &&
      acquisition.acquiredAt >= permit.notBefore &&
      acquisition.acquiredAt >= permit.issuedAt &&
      acquisition.completedAt === now &&
      acquisition.completedAt >= acquisition.acquiredAt &&
      acquisition.completedAt < permit.expiresAt &&
      acquisition.executedCapture.path === permit.bridge.productionCapturePath &&
      acquisition.executedCapture.sha256 === permit.bridge.productionCaptureSha256 &&
      acquisition.executedCapture.dev === permit.bridge.productionCaptureIdentity.dev &&
      acquisition.executedCapture.ino === permit.bridge.productionCaptureIdentity.ino,
    "ACQUISITION",
  );
  const transcriptHash = sha256(canonical(transcript)),
    preimage = acquisitionPreimage(
      capture,
      permit,
      outer,
      transcriptHash,
      reconstructed,
      acquisition,
      { pool: engineContext.poolLedgerCommitment, engine: engineContext.engineLedgerCommitment },
    ),
    payload = {
      schema: POLICY.schemas.validation,
      status: "PASS",
      policyHash: POLICY_HASH,
      profileHash: POLICY.profileHash,
      capturePayloadHash: capture.integrity.payloadHash,
      permitId: permit.permitId,
      selection: reconstructed,
      accounting: {
        outerRequests: outer.requests,
        engineRequests: selection.engineRequests,
        adapterProbeRequests: adapterCount,
        responseBytes: outer.responseBytes,
        maxPerCandidateRequests: outer.maxPerCandidateRequests,
        retries: 0,
      },
      transport: {
        directRequests: direct,
        relayRequests: relay,
        dnsQualifications: usage.dnsQualifications,
        directDnsTlsBound: direct > 0 ? true : "n/a",
        relayLoopbackBound: relay > 0 ? true : "n/a",
        classesImmutable: true,
        counters: clone(counterSums),
      },
      acquisition: clone(acquisition),
      transcriptHash,
      ledgerCommitments: { pool: engineContext.poolLedgerCommitment, engine: engineContext.engineLedgerCommitment },
      acquisitionCommitment: sha256(canonical(preimage)),
      authority: clone(POLICY.hardStops),
    };
  rejectPrivate(payload);
  return {
    ...payload,
    integrity: { algorithm: "sha256", payloadHash: sha256(canonical(payload)) },
  };
}
function buildManifest(capture, validation, permit) {
  const entries = [
      ["capture.json", capture],
      ["validation.json", validation],
    ].map(([name, value]) => {
      const text = `${JSON.stringify(value, null, 2)}\n`;
      return { name, size: Buffer.byteLength(text), sha256: sha256(text) };
    }),
    payload = {
      schema: POLICY.schemas.manifest,
      status: "COMMIT_MARKER_REQUIRED",
      files: entries,
      commitMarker: POLICY.output.commitMarker,
      bridge: {
        inputMode: POLICY.input.mode,
        nativeSupervisorPipeFifo: true,
        hashesVerified: true,
        inventoryFallbackUsed: false,
        exclusiveWriterFramedGo: true,
        windowsPeerEofRequired: false,
        linuxWriterClosedAfterGo: true,
        bufferedTrailingBytesRejected: true,
        postGoChannelMonitored: true,
        inventoryReadAfterPermanentLock: true,
        goFrameCommitment: validation.acquisition.goFrameCommitment,
      },
      lineage: {
        policyHash: POLICY_HASH,
        profileHash: POLICY.profileHash,
        productionHashes: clone(permit.productionHashes),
        offlineHashes: clone(permit.offlineHashes),
        runtime: clone(permit.runtime),
        bridge: clone(permit.bridge),
      },
      authority: clone(POLICY.hardStops),
    };
  rejectPrivate(payload);
  return {
    ...payload,
    integrity: { algorithm: "sha256", payloadHash: sha256(canonical(payload)) },
  };
}
module.exports = {
  ValidationError,
  canonical,
  sha256,
  validatePermit,
  rejectPrivate,
  acquisitionPreimage,
  validateProduction,
  buildManifest,
};
