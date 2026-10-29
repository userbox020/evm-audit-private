#!/usr/bin/env node
// finalize-across-spoke-decode-step2.js
// Adds the closest-artifact comparison (out-local Ethereum_SpokePool), honest gaps,
// and gate flags to reports/raw/fast/across-spoke-decode-r2.json. Offline.
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const ART = path.join(ROOT, "reports/raw/fast/across-spoke-decode-r2.json");
const CAP = path.join(__dirname, "across-spoke-decode-step2.live.json");
const OL = path.join(ROOT, "targets/across-contracts/out-local/Ethereum_SpokePool.sol/Ethereum_SpokePool.json");

function strip(hex) {
  const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
  const n = b.readUInt16BE(b.length - 2);
  return { body: b.slice(0, b.length - 2 - n), meta: b.slice(b.length - 2 - n) };
}
const cap = JSON.parse(fs.readFileSync(CAP, "utf8"));
const art = JSON.parse(fs.readFileSync(ART, "utf8"));
const liveBody = strip(cap.impl.code).body;
const olArt = JSON.parse(fs.readFileSync(OL, "utf8"));
const ol = strip(olArt.deployedBytecode.object);

const overlap = Math.min(liveBody.length, ol.body.length);
let diffCount = 0, firstDiff = -1, zeroToAddrSpans = 0, run = 0, runStart = -1;
for (let i = 0; i < overlap; i++) {
  if (liveBody[i] !== ol.body[i]) {
    diffCount++;
    if (firstDiff < 0) firstDiff = i;
    if (ol.body[i] === 0x00 && liveBody[i] !== 0x00) { if (run === 0) runStart = i; run++; } else run = 0;
  } else {
    if (run >= 20) zeroToAddrSpans++;
    run = 0;
  }
}
if (run >= 20) zeroToAddrSpans++;

art.closestCheckoutArtifactComparison = {
  artifact: "targets/across-contracts/out-local/Ethereum_SpokePool.sol (local-test profile: inherit default 0.8.30/optimizer800/viaIR/prague + revert_strings=default)",
  liveBodyBytes: liveBody.length, artifactBodyBytes: ol.body.length, lengthDeltaLiveMinusArtifact: liveBody.length - ol.body.length,
  liveMetadataBytes: strip(cap.impl.code).meta.length, artifactMetadataBytes: ol.meta.length,
  alignedOverlapBytes: overlap, alignedDiffBytes: diffCount,
  byteAgreementPercent: Number((100 * (overlap - diffCount) / overlap).toFixed(2)),
  firstDiffByteOffset: firstDiff,
  zeroToAddress20BSpans: zeroToAddrSpans,
  singleInsertionShiftAlignment: "NONE (no shift offset yields a contiguous tail match; divergence is codegen-level, not a single insertion)",
  verdict: "DIFFERENT_REVISION_OR_BUILD",
};

art.evidenceProvenance = {
  liveCapture: "tools/across-spoke-decode-step2.live.json (eth_getCode/eth_getStorageAt/eth_call, finalized pin, two independent provider families agreed)",
  offlineBuild: "retained build present in the pinned checkout (targets/across-contracts/out + out-local); compiler profile verified from artifact metadata (solc 0.8.30, optimizer 800, viaIR, evmVersion prague)",
  freshCompileLeg: "NOT_RUN: the checkout has no node_modules (dependency tree absent); a fresh offline rebuild is not reproducible without a network dependency restore, which is outside the read-only posture. Footprint uses the retained pinned-checkout build instead; if that retained build were absent the compile leg would be INCONCLUSIVE_BUILD_BLOCKED.",
  selectorDictionary: "61 checkout Ethereum_SpokePool methodIdentifiers + 5,816 signatures parsed from the checkout .sol sources (1190 files)",
};

art.honestGaps = [
  { id: "GAP-1", status: "INCOMPLETE_FRESH_RECOMPILE", note: "No fresh local compile (node_modules absent). Verdict rests on the retained pinned-checkout build (out/ and out-local/). Exact cause of the +97 B / 4-selector delta not byte-pinned." },
  { id: "GAP-2", status: "INCOMPLETE_UNRESOLVED_SIGNATURE", note: "3 extra dispatcher selectors (0x339ac427, 0x55448bc2, 0xb6934805) do not match any of 5,816 checkout source signatures nor any checkout ABI; their ABI names are not resolvable offline." },
  { id: "GAP-3", status: "INCOMPLETE_NO_MANIFEST_JOIN", note: "Live impl 0x456ac26e is absent from every manifest/audit artifact in the workspace (decode-primary); no published source revision to join against." },
  { id: "GAP-4", status: "OBSERVED_NOT_AUDITED", note: "Selector classification uses empty calldata only; functions requiring arguments revert and cannot be semantically decoded from the wire without their ABI." },
];

art.decodeAuthority = {
  owner: "0xc186fA914353c44b2E33eBE05f21846F1048bEda (HubPool, L1)",
  crossDomainAdmin: "0xc186fA914353c44b2E33eBE05f21846F1048bEda",
  withdrawalRecipient: "0xc186fA914353c44b2E33eBE05f21846F1048bEda",
  proxyPattern: "ERC-1967 UUPS (EIP-1967 admin slot = 0, beacon slot = 0); proxiableUUID() succeeds only on the impl and returns the EIP-1967 impl slot constant; upgradeTo/upgradeToAndCall revert from a non-owner caller",
  extraGatewaySelectorReturn: "0x998d7c178A1F9607b47eA3A8e22426451b3ce707 (return of selector 0x116191b6 on the proxy)",
};

art.gates = {
  routePositive: "false",
  executableNow: "false",
  signedActionJustified: false,
  authorizationState: "ABSENT",
  noFindingSentence: "No finding promoted: this is a read-only decode of an undocumented live implementation; no value-moving path was established, no route is profitable or reachable with an unprivileged actor, and no signed action is justified.",
};

fs.writeFileSync(ART, JSON.stringify(art, null, 2) + "\n");
console.log(JSON.stringify(art.closestCheckoutArtifactComparison, null, 2));
