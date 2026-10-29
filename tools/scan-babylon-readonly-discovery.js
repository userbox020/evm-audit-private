#!/usr/bin/env node
"use strict";

// Babylon Protocol step-1 deterministic, offline, read-only discovery.
// This reducer reads only the three declared local evidence files. It performs no
// network/RPC/API calls and exposes no transaction, calldata, fork, wallet, or signing path.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "babylon-readonly-discovery.json");
const OUT_MD = path.join(WORKSPACE, "reports", "babylon-readonly-discovery-triage.md");
const SCANNER = "tools/scan-babylon-readonly-discovery.js";
const RESEARCHED_DATE = "2026-07-10";
const GENERATED_AT = "2026-07-10T00:00:00.000Z";

const ALLOWED_WRITES = new Set([
  "reports/raw/fast/babylon-readonly-discovery.json",
  "reports/babylon-readonly-discovery-triage.md",
]);

const LOCAL_INPUTS = [
  {
    id: "local-next-top5",
    path: "reports/next-top5-audit-targets.md",
    format: "markdown",
    evidenceClass: "loaded-local-artifact",
    requiredMarkers: [
      "### 2. Babylon Protocol ($2.59B, Bitcoin)",
      "Promotion bucket: Babylon direct coverage gap.",
    ],
    relevance: "Queue lines 26-33 provide $2.59B discovery context and Restaking/Bitcoin identity; queue status is intentionally allowed to advance after later audit stages.",
  },
  {
    id: "local-deep-research-report",
    path: "reports/deep-research-exploit-target-discovery-2026-07-09.md",
    format: "markdown",
    evidenceClass: "loaded-local-artifact",
    requiredMarkers: [
      "Babylon Protocol | WATCH / non-evm-caveat",
      "Discovery scores are prioritization signals, not exploit proof or route-positive evidence.",
    ],
    relevance: "Generic discovery/scoring report; its donation, rounding, callback, and BTC-restaking labels are hypotheses only.",
  },
  {
    id: "local-deep-research-raw",
    path: "reports/raw/fast/deep-research-exploit-target-discovery-2026-07-09.json",
    format: "json",
    evidenceClass: "loaded-local-artifact",
    requiredMarkers: [],
    relevance: "Raw generic scoring counterpart used only to recover the Babylon discovery row and fail-closed route fields.",
  },
];

const RECORDED_PUBLIC_FACTS = [
  {
    id: "babylon-core-repository",
    statement: "The official Babylon Genesis core repository is babylonlabs-io/babylon.",
    sourceUrl: "https://github.com/babylonlabs-io/babylon",
    sourceClass: "official-github-repository",
  },
  {
    id: "mainnet-network-metadata",
    statement: "Official mainnet network metadata identifies chain ID bbn-1.",
    sourceUrl: "https://github.com/babylonlabs-io/networks/tree/main/bbn-1",
    sourceClass: "official-network-metadata-repository",
  },
  {
    id: "observed-public-release-v4.3.0",
    statement: "Public release v4.3.0 was recorded as observed; the scanner did not independently fetch or establish that it is currently latest.",
    sourceUrl: "https://github.com/babylonlabs-io/babylon/releases/tag/v4.3.0",
    sourceClass: "official-github-release",
  },
  {
    id: "core-module-set",
    statement: "Recorded core modules are x/btcstaking, x/finality, x/btclightclient, x/btccheckpoint, x/checkpointing, and x/incentive.",
    sourceUrl: "https://github.com/babylonlabs-io/babylon/tree/main/x",
    sourceClass: "official-core-source-tree",
  },
  {
    id: "zoneconcierge-integration-module",
    statement: "x/zoneconcierge is an in-repository Babylon core module. Relayers, consumer chains, channels, and counterparties beyond that module remain integration boundaries.",
    sourceUrl: "https://github.com/babylonlabs-io/babylon/tree/main/x/zoneconcierge",
    sourceClass: "official-core-source-tree",
  },
  {
    id: "official-staking-script-spec",
    statement: "The recorded staking design uses Taproot script-path spending with a NUMS internal key; staker CSV withdrawal; staker plus covenant quorum early unbonding; and slashing based on pre-signed staker authorization, finality-provider/EOTS material, and covenant quorum, producing a burn output plus CSV-timelocked unbonding remainder. Participant keys are recorded as unique and sorted. Exact transaction and signature bindings remain unverified.",
    sourceUrl: "https://github.com/babylonlabs-io/babylon/tree/main/x/btcstaking",
    sourceClass: "official-core-source-and-staking-spec",
  },
  {
    id: "delegation-registration-lifecycle",
    statement: "Registration centers on MsgCreateBTCDelegation, supports optional pre-registration before inclusion proof, collects covenant signatures, activates after inclusion and k-depth, and selects the parameter version by BTC activation height.",
    sourceUrl: "https://github.com/babylonlabs-io/babylon/tree/main/x/btcstaking",
    sourceClass: "official-core-source-and-protocol-documentation",
  },
  {
    id: "covenant-emulator-threshold-liveness",
    statement: "The covenant emulator is recorded as M-of-N and affects activation and unbonding liveness; documented paths require staker-authorized signature material, while slashing may rely on pre-signed rather than fresh staker authorization.",
    sourceUrl: "https://github.com/babylonlabs-io/covenant-emulator",
    sourceClass: "official-integration-repository",
  },
  {
    id: "finality-eots-model",
    statement: "Finality providers use BIP340/EOTS keys and randomness; finality requires greater than two-thirds voting power; conflicting signatures expose key/evidence and lead to zero/tombstoned voting power with a Bitcoin slashing workflow.",
    sourceUrl: "https://github.com/babylonlabs-io/babylon/tree/main/x/finality",
    sourceClass: "official-core-source-and-protocol-documentation",
  },
  {
    id: "btc-verification-and-availability-assumptions",
    statement: "The recorded model relies on Bitcoin PoW canonical-chain/depth and inclusion verification, BLS checkpoint aggregation, and honest relayer/reporter/monitor availability across the BTC light client, checkpoint, and vigilante boundaries.",
    sourceUrl: "https://github.com/babylonlabs-io/vigilante",
    sourceClass: "official-integration-repository-and-core-module-context",
  },
  {
    id: "no-native-transferable-btc-receipt",
    statement: "Babylon Genesis core does not mint a native transferable BTC receipt/LST. Lombard, Solv, Bedrock, and similar products are third-party integrations; TBV/vaultBTC is a separate testnet product.",
    sourceUrl: "https://docs.babylonlabs.io/",
    sourceClass: "official-product-documentation",
  },
  {
    id: "historical-bls-key-overwrite-fix",
    statement: "The recorded v1.0.1 release description reports a prior BLS-key overwrite issue and a fix before the stated validator BLS-registration impact. Severity and remediation were not independently substantiated by this scanner.",
    sourceUrl: "https://github.com/babylonlabs-io/babylon/releases/tag/v1.0.1",
    sourceClass: "official-github-release-security-context",
  },
  {
    id: "official-security-policy",
    statement: "The recorded official security policy says there was no official bounty at publication and forbids public production/testnet testing; this scanner therefore remains local and static.",
    sourceUrl: "https://github.com/babylonlabs-io/babylon/security/policy",
    sourceClass: "official-github-security-policy",
  },
].map((fact) => ({
  ...fact,
  observedOrResearchedDate: RESEARCHED_DATE,
  evidenceClass: "static-recorded-public-fact",
  fetchedByScanner: false,
  verificationStatus: "recorded-unverified",
}));

const MODULE_ROWS = [
  ["x/btcstaking", "BTC delegation registration, parameter-version selection, covenant signatures, activation, unbonding, and slashing coordination."],
  ["x/finality", "Finality-provider voting, EOTS evidence/equivocation handling, and finality state."],
  ["x/btclightclient", "Bitcoin header/PoW canonical-chain and depth basis used by proof consumers."],
  ["x/btccheckpoint", "Bitcoin checkpoint submission and verification boundary."],
  ["x/checkpointing", "BLS checkpoint aggregation and epoch checkpoint lifecycle."],
  ["x/incentive", "Reward and incentive accounting boundary; exact source formulas are not loaded locally."],
  ["x/zoneconcierge", "In-repository core module for consumer-chain packet/channel integration; external relayers, chains, channels, and counterparties are integration scope."],
].map(([module, role]) => ({ module, role, evidenceStatus: "recorded-unverified", implementationValidated: false, sourceFactId: module === "x/zoneconcierge" ? "zoneconcierge-integration-module" : "core-module-set" }));

const ARCHITECTURE_ROWS = [
  { component: "Bitcoin staking output", boundary: "Bitcoin Taproot", description: "Recorded design uses script-path UTXOs and pre-signed staker authorization for slashing; exact spend bindings and outcomes are unverified.", evidenceStatus: "recorded-unverified" },
  { component: "CometBFT/validator consensus", boundary: "bbn-1 validator consensus", description: "Orders and commits Babylon application state; distinct from BTC-stake finality voting in x/finality.", evidenceStatus: "recorded-unverified" },
  { component: "BTC-stake finality", boundary: "x/finality", description: "Finality providers vote using EOTS material and BTC-derived voting power; snapshot and epoch binding are unverified.", evidenceStatus: "recorded-unverified" },
  { component: "BTC light client", boundary: "x/btclightclient", description: "Recorded PoW/canonical-chain/depth basis; Bitcoin network, bootstrap, difficulty, and reorg rules are unverified.", evidenceStatus: "recorded-unverified" },
  { component: "Checkpoint pipeline", boundary: "x/checkpointing and x/btccheckpoint", description: "Recorded BLS aggregation and Bitcoin checkpoint path; fragment/tag/version/domain/epoch bindings are unverified.", evidenceStatus: "recorded-unverified" },
  { component: "Covenant emulator", boundary: "external signer integration", description: "Recorded M-of-N availability role; unauthorized-spend resistance versus failed-slash/permanent-lock behavior is unverified.", evidenceStatus: "recorded-unverified" },
  { component: "Zone concierge", boundary: "in-repository x/zoneconcierge core module", description: "Packet/channel state is core-module scope; external relayers, consumer chains, and counterparties are integration scope.", evidenceStatus: "recorded-unverified" },
  { component: "Relayers/reporters/monitors", boundary: "external submission and availability", description: "Malicious-submission safety is distinct from honest-relayer liveness; neither is source-validated here.", evidenceStatus: "recorded-unverified" },
];

const SCRIPT_ROWS = [
  { path: "Taproot commitment", authorization: "recorded script-path design with NUMS internal key", condition: "Exact NUMS derivation, Taproot leaves, leaf versions, control blocks, and key-path exclusion are unverified.", evidenceStatus: "recorded-unverified" },
  { path: "Timelock withdrawal", authorization: "recorded staker authorization", condition: "Exact outpoint, outputs, amounts, fees, sequence, CSV, locktime, and SIGHASH binding are unverified.", evidenceStatus: "recorded-unverified" },
  { path: "Early unbonding", authorization: "recorded staker authorization plus covenant quorum", condition: "Exact quorum, transaction-template, output, fee, parameter-version, and timelock bindings are unverified.", evidenceStatus: "recorded-unverified" },
  { path: "Slashing", authorization: "recorded pre-signed staker authorization plus FP/EOTS-derived material and covenant quorum; not a fresh staker approval", condition: "Exact SIGHASH, outpoint, output, amount, fee, sequence, CSV, locktime, Taproot leaf/control block/NUMS, adaptor-signature/EOTS-decryption, and parameter-version bindings are unverified.", evidenceStatus: "recorded-unverified" },
  { path: "Slashing outcomes", authorization: "recorded burn plus timelocked remainder", condition: "Dust, rounding, malleability, unauthorized spend, failed slash, and permanent lock outcomes are unverified.", evidenceStatus: "recorded-unverified" },
  { path: "Key construction", authorization: "recorded unique, sorted participant keys", condition: "Duplicate/ordering/rogue-key checks require a pinned local source snapshot; no defect is claimed.", evidenceStatus: "recorded-unverified" },
];

const LIFECYCLE_ROWS = [
  { order: "1", stage: "Create delegation", trigger: "MsgCreateBTCDelegation", state: "Delegation metadata and staking transaction registered; optional pre-registration may precede BTC inclusion." },
  { order: "2", stage: "Covenant signature collection", trigger: "M-of-N covenant signatures", state: "Authorization material collected; quorum availability affects liveness." },
  { order: "3", stage: "Inclusion proof", trigger: "BTC inclusion against canonical light-client chain", state: "Proof acceptance is necessary but not alone sufficient for activation." },
  { order: "4", stage: "Depth activation", trigger: "k-depth reached", state: "Delegation activates using the parameter version selected by BTC activation height." },
  { order: "5", stage: "Active/finality participation", trigger: "Finality-provider voting and randomness", state: "Voting power/finality and incentive paths become relevant." },
  { order: "6", stage: "Unbond/withdraw/slash", trigger: "Recorded script/state path", state: "Slashing uses recorded pre-signed authorization; exact transaction bindings and rollback/propagation behavior are unverified." },
].map((row) => ({ ...row, evidenceStatus: "recorded-unverified" }));

const SECURITY_ASSUMPTION_ROWS = [
  { assumption: "CometBFT validator consensus safely orders/commits application state independently of BTC-stake finality.", boundary: "CometBFT/validators", failureModeToTest: "Boundary confusion, stale validator sets, epoch transitions, and application rollback semantics." },
  { assumption: "Bitcoin headers are validated against the intended network/bootstrap/difficulty rules and canonical chain.", boundary: "btclightclient", failureModeToTest: "Wrong network/genesis, bootstrap mismatch, invalid difficulty/work, stale branch, and deep/shallow reorg handling." },
  { assumption: "Finality-provider voting power is snapshotted and epoch-bound consistently.", boundary: "x/finality/x/btcstaking", failureModeToTest: "Stake activation/unbond/slash at snapshot boundaries, stale power, tombstone power, and epoch rollover." },
  { assumption: "BIP340/EOTS randomness, domains, and adaptor-signature decryption are bound to the intended vote and slashing template.", boundary: "finality provider/x/finality", failureModeToTest: "Randomness reuse, domain confusion, conflicting votes, evidence replay, wrong-template decryption, and permanent-lock outcomes." },
  { assumption: "BLS checkpoint keys and aggregates resist rogue keys and malformed participants.", boundary: "x/checkpointing", failureModeToTest: "PoP, subgroup, bitmap, threshold, signer-set, epoch, and aggregate-domain binding." },
  { assumption: "Checkpoint fragments bind tag, version, domain, payload, epoch, and Bitcoin placement.", boundary: "x/btccheckpoint", failureModeToTest: "Fragment reorder/duplication, mixed versions/domains, malformed tags, and cross-epoch assembly." },
  { assumption: "Covenant M-of-N behavior preserves safety while signer availability preserves liveness.", boundary: "covenant emulator", failureModeToTest: "Separate unauthorized-spend attempts from failed-slash, failed-unbonding, and permanent-lock outcomes." },
  { assumption: "Malicious submissions are rejected even if external submitters are adversarial.", boundary: "relayer/reporter input validation", failureModeToTest: "Invalid, replayed, reordered, cross-network, and contradictory headers/proofs/checkpoints/evidence." },
  { assumption: "At least one honest relayer/reporter/monitor remains available.", boundary: "external liveness", failureModeToTest: "Omission and delay without treating availability failure as proof of malicious-submission acceptance." },
  { assumption: "Reorg rollback is atomic and consistent across stake, finality, checkpoint, and reward state.", boundary: "cross-module state", failureModeToTest: "Rollback/reapply at each lifecycle stage with no orphan voting power, finality, checkpoint, or reward residue." },
].map((row) => ({ ...row, evidenceStatus: "recorded-unverified" }));

const COVERAGE_MATRIX = [
  ["script construction and exact transaction bindings", "unknown-needs-pinned-source", "SIGHASH/outpoint/output/amount/fee/sequence/CSV/locktime/Taproot leaf/control-block/NUMS bindings are not locally validated."],
  ["duplicate/sorted keys", "unknown-needs-pinned-source", "Recorded requirement only; duplicate, ordering, PoP, and rogue-key enforcement are unverified."],
  ["parameter-version and activation-height boundary", "unknown-needs-pinned-source", "Recorded selection rule is not source-validated at before/at/after boundaries."],
  ["pre-signed slashing/EOTS-adaptor binding", "unknown-needs-pinned-source", "No fresh staker approval is implied; exact adaptor-signature, EOTS-decryption, and slashing-template binding is unverified."],
  ["dust/rounding/malleability and spend outcomes", "unknown-needs-pinned-source", "Unauthorized spend, failed slash, fee/dust loss, transaction malleability, and permanent lock must be distinguished."],
  ["BTC network/bootstrap/difficulty/inclusion", "unknown-needs-pinned-source", "Network identity, bootstrap, PoW/difficulty, proof, depth, and canonical-branch validation are unverified."],
  ["cross-module reorg rollback", "unknown-needs-pinned-source", "Stake/finality/checkpoint/reward rollback and reapply atomicity are unverified."],
  ["CometBFT validator consensus boundary", "unknown-needs-pinned-source", "Validator consensus is separated from x/finality but neither implementation boundary is locally traced."],
  ["FP voting-power snapshot/epoch", "unknown-needs-pinned-source", "Activation, unbonding, slashing, tombstone, and epoch transition snapshots are unverified."],
  ["finality/EOTS domain/randomness/equivocation", "unknown-needs-pinned-source", "Domain, randomness, evidence replay, vote conflict, power-zeroing, and tombstone invariants need source tests."],
  ["BLS PoP/rogue-key/subgroup/bitmap/threshold/epoch", "unknown-needs-pinned-source", "Recorded BLS aggregation context is not cryptographic or implementation validation."],
  ["checkpoint fragment/tag/version/domain", "unknown-needs-pinned-source", "Fragment assembly, ordering, version/tag/domain/payload/epoch binding is unverified."],
  ["malicious submission safety", "unknown-needs-pinned-source", "Adversarial header/proof/checkpoint/evidence rejection is not established by recorded relayer context."],
  ["honest-relayer liveness", "unknown-needs-pinned-source", "Omission/delay availability is a distinct liveness question, not submission-safety evidence."],
  ["covenant quorum safety/liveness", "unknown-needs-pinned-source", "M-of-N is recorded only; unauthorized spend versus failed-slash/unbond/permanent-lock outcomes need tests."],
  ["delegation and pre-registration state machine", "unknown-needs-pinned-source", "Expiry/cleanup, duplicate UTXO, PoP/ownership, idempotence, replay, reorg, parameter changes, storage, and gas are unverified."],
  ["slashing propagation", "unknown-needs-pinned-source", "Evidence-to-power-to-Bitcoin-slash propagation, replay, retries, and rollback need local tests."],
  ["incentive/reward accounting", "unknown-needs-pinned-source", "Snapshot timing, commission, claim replay, rounding/conservation, rollback, and cross-module atomicity are unverified."],
  ["zoneconcierge packet/channel boundary", "unknown-needs-pinned-source", "Packet/channel authentication, replay, ordering, timeout, counterpart identity, and migration handling are unverified."],
  ["governance/upgrades/store migrations", "unknown-needs-pinned-source", "Authorities, parameter changes, software upgrades, compatibility, and store-migration invariants are unverified."],
  ["third-party receipt/oracle/consumer risks", "out-of-core-third-party", "Babylon core has no native transferable BTC receipt/LST; third-party LST, oracle, vault, and consumer paths require separate target scopes."],
].map(([exploitClass, status, basis]) => ({ exploitClass, status, basis, vulnerabilityClaim: false }));

const SAFE_LOCAL_TEST_PLAN = [
  { priority: 1, test: "Read-only pinned source trace and build manifest", method: "After an immutable user-supplied source/dependency snapshot is locally present, trace module boundaries, commit/dependency checksums, supported toolchain, build/test entrypoints, and generated artifacts before executing tests.", sourceAlignment: "recorded repository/release anchors" },
  { priority: 2, test: "Golden script and transaction-binding vectors", method: "Validate SIGHASH, outpoints, outputs, amounts, fees, sequence, CSV, locktime, Taproot leaves/control blocks/NUMS, and parameter-version binding for withdrawal, unbonding, and slashing.", sourceAlignment: "recorded staking design" },
  { priority: 3, test: "Pre-signed slashing outcome matrix", method: "Validate adaptor-signature/EOTS decryption and distinguish unauthorized spend, correct slash, failed slash, dust/rounding/fee loss, malleability, and permanent lock.", sourceAlignment: "recorded slashing design" },
  { priority: 4, test: "Activation-height and parameter-change matrix", method: "Exercise before/at/after activation boundaries, k-depth, governance parameter changes, stale signatures, and in-flight delegations using string-safe heights.", sourceAlignment: "recorded btcstaking lifecycle" },
  { priority: 5, test: "BTC light-client/checkpoint negative corpus", method: "Test Bitcoin network/bootstrap/difficulty, invalid work, branches, inclusion/depth, fragment/tag/version/domain, and bounded reorg cases.", sourceAlignment: "recorded btclightclient/btccheckpoint context" },
  { priority: 6, test: "Consensus/BLS boundary properties", method: "Separate CometBFT consensus from x/finality; test BLS PoP, rogue keys, subgroup, bitmap, threshold, signer set, epoch, and aggregate-domain binding.", sourceAlignment: "recorded checkpoint/finality context" },
  { priority: 7, test: "Delegation/pre-registration state machine", method: "Test expiry/cleanup, duplicate UTXO, PoP/ownership, idempotence, replay, reorg, parameter changes, storage growth, and gas bounds.", sourceAlignment: "recorded MsgCreateBTCDelegation lifecycle" },
  { priority: 8, test: "EOTS/finality and FP-power invariants", method: "Test snapshot/epoch power, randomness/domain uniqueness, conflicting votes, evidence replay, tombstone/zero-power transitions, and slash-template decryption binding.", sourceAlignment: "recorded finality/EOTS model" },
  { priority: 9, test: "Cross-module reorg rollback", method: "Rollback/reapply stake, FP power, finality, checkpoints, slashing, and rewards atomically at every lifecycle boundary.", sourceAlignment: "recorded cross-module architecture" },
  { priority: 10, test: "Incentive/reward accounting", method: "Test snapshot timing, commission, claim replay/idempotence, integer rounding/conservation, reorg reversal, and cross-module atomicity.", sourceAlignment: "recorded x/incentive module" },
  { priority: 11, test: "Zoneconcierge packet/channel boundary", method: "Test packet/channel authentication, counterparty identity, replay, ordering, timeout, acknowledgement, version negotiation, and migration compatibility; mock external relayers/consumer chains.", sourceAlignment: "recorded x/zoneconcierge module" },
  { priority: 12, test: "Governance/upgrade/store-migration invariants", method: "Trace authorities and test parameter updates, software upgrades, store migrations, restart compatibility, partial failure, and rollback behavior.", sourceAlignment: "recorded Babylon application scope" },
  { priority: 13, test: "Parser/rounding/gas fuzz", method: "Fuzz BTC/proof/checkpoint/packet parsers, integer and dust boundaries, reward conservation, storage cleanup, and gas bounds without JS Number protocol arithmetic.", sourceAlignment: "recorded core-module boundaries" },
].map((row) => ({ ...row, status: "blocked-needs-local-source-snapshot", prerequisite: "immutable user-supplied/pinned source and dependency snapshot present locally", networkRequired: false, immediatelyExecutable: false }));

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function assertAllowedWrite(file) {
  const target = rel(path.resolve(file));
  if (!ALLOWED_WRITES.has(target)) throw new Error(`Refusing write outside Babylon step-1 ownership: ${target}`);
}

function writeAllowed(file, content) {
  assertAllowedWrite(file);
  if (!fs.existsSync(path.dirname(file))) throw new Error(`Required output directory is missing: ${rel(path.dirname(file))}`);
  fs.writeFileSync(file, content, "utf8");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function collectNamedRows(value, name, rows = [], location = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectNamedRows(item, name, rows, `${location}[${index}]`));
  } else if (value && typeof value === "object") {
    if (value.name === name) rows.push({ location, row: value });
    for (const [key, child] of Object.entries(value)) collectNamedRows(child, name, rows, `${location}.${key}`);
  }
  return rows;
}

function loadLocalInputs() {
  const loaded = {};
  const manifest = [];
  for (const spec of LOCAL_INPUTS) {
    const absolute = path.join(WORKSPACE, spec.path);
    if (!fs.existsSync(absolute)) throw new Error(`Missing required local input: ${spec.path}`);
    const buffer = fs.readFileSync(absolute);
    const text = buffer.toString("utf8");
    for (const marker of spec.requiredMarkers) {
      if (!text.includes(marker)) throw new Error(`Required evidence marker missing from ${spec.path}: ${marker}`);
    }
    let parsed = null;
    if (spec.format === "json") parsed = JSON.parse(text);
    loaded[spec.id] = { text, parsed };
    manifest.push({
      id: spec.id,
      path: spec.path,
      format: spec.format,
      evidenceClass: spec.evidenceClass,
      required: true,
      present: true,
      loaded: true,
      parseOk: spec.format === "json" ? true : null,
      bytes: buffer.length,
      sha256: sha256(buffer),
      relevance: spec.relevance,
      fetchedByScanner: false,
    });
  }
  return { loaded, manifest };
}

function presentString(row, field) {
  return Object.prototype.hasOwnProperty.call(row, field) && row[field] != null ? String(row[field]) : null;
}

function normalizedScoreContext(row) {
  if (!Object.prototype.hasOwnProperty.call(row, "score") || row.score == null) return null;
  if (typeof row.score === "object" && row.score.total != null) return String(row.score.total);
  return String(row.score);
}

function normalizeGate(row, field) {
  if (!Object.prototype.hasOwnProperty.call(row, field)) return null;
  if (row[field] === false || row[field] === 0) return 0;
  if (row[field] === true || row[field] === 1) return 1;
  throw new Error(`Babylon duplicate has non-boolean/non-binary ${field}`);
}

function reconcileLocalBabylonEvidence(loaded) {
  const matches = collectNamedRows(loaded["local-deep-research-raw"].parsed, "Babylon Protocol");
  if (matches.length === 0) throw new Error("Babylon Protocol row missing from raw deep-research artifact");
  const rows = matches.map(({ location, row }, index) => ({
    representation: index + 1,
    location,
    name: presentString(row, "name"),
    slug: presentString(row, "slug"),
    category: presentString(row, "category"),
    coverageStatus: presentString(row, "coverageStatus"),
    promotionBucket: presentString(row, "promotionBucket"),
    scoreContext: normalizedScoreContext(row),
    tvlUsdContext: presentString(row, "tvlUsd"),
    rpcCoverageStatus: presentString(row, "rpcCoverageStatus"),
    routePositive: normalizeGate(row, "routePositive"),
    executableNow: normalizeGate(row, "executableNow"),
    signedActionJustified: normalizeGate(row, "signedActionJustified"),
    genericHypothesisLabels: Array.isArray(row.exploitClasses) ? row.exploitClasses.map(String) : null,
  }));
  const agreementFields = ["name", "slug", "category", "coverageStatus", "promotionBucket", "scoreContext", "tvlUsdContext", "rpcCoverageStatus"];
  const canonical = {};
  for (const field of agreementFields) {
    const available = rows.map((row) => row[field]).filter((value) => value != null);
    const unique = [...new Set(available)];
    if (unique.length > 1) throw new Error(`Contradictory Babylon duplicate field ${field}: ${unique.join(" | ")}`);
    canonical[field] = unique[0] ?? null;
  }
  for (const field of ["routePositive", "executableNow", "signedActionJustified"]) {
    const available = rows.map((row) => row[field]);
    if (available.some((value) => value == null)) throw new Error(`Babylon duplicate missing required gate ${field}`);
    const unique = [...new Set(available)];
    if (unique.length !== 1 || unique[0] !== 0) throw new Error(`Contradictory or positive Babylon duplicate gate ${field}: ${unique.join(" | ")}`);
    canonical[field] = 0;
  }
  const hypothesisSets = rows.filter((row) => row.genericHypothesisLabels).map((row) => JSON.stringify(row.genericHypothesisLabels));
  if (new Set(hypothesisSets).size > 1) throw new Error("Contradictory Babylon duplicate exploit-class labels");
  canonical.genericHypothesisLabels = hypothesisSets.length ? JSON.parse(hypothesisSets[0]) : [];
  canonical.chains = ["Bitcoin"];
  return {
    status: "agreed-all-representations",
    representationsObserved: rows.length,
    representationsReconciled: rows.length,
    contradictionCount: 0,
    agreementFields: [...agreementFields, "routePositive", "executableNow", "signedActionJustified"],
    rows,
    canonicalDiscoveryIdentity: canonical,
    interpretation: "Every local raw Babylon representation agrees on all available identity/scoring fields and all fail-closed gates. This is duplicate integrity only, not architecture, source, deployment, or current-state validation.",
  };
}

function md(value) {
  return String(value == null ? "" : value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderTable(lines, headers, rows) {
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`|${headers.map(() => "---").join("|")}|`);
  for (const row of rows) lines.push(`| ${row.map(md).join(" | ")} |`);
  lines.push("");
}

function renderReport(raw) {
  const lines = [];
  lines.push("# Babylon Protocol Step-1 Read-Only Discovery Triage", "");
  lines.push(`Signal: 🟠 WATCH — auditClassification=${raw.auditClassification}, routeEvidenceStatus=${raw.routeEvidenceStatus}, routePositiveOperational=${raw.routePositiveOperational}, evidenceComplete=${raw.evidenceComplete}, closureEligible=${raw.closureEligible}, executableNow=${raw.executableNow}, signedActionJustified=${raw.signedActionJustified}.`, "");
  lines.push("## Scope and Safety", "");
  lines.push(`- Scanner: \`${raw.scanner}\`; deterministic research timestamp \`${raw.generatedAt}\`.`);
  lines.push("- Offline/local-static reduction only. No network, RPC, API, endpoint inventory, secrets, transaction, simulation, signing, broadcast, calldata, fork, wallet, exploit execution, or current-chain-state query was performed.");
  lines.push(`- Architecture validation: \`${raw.architectureValidationStatus}\`. No implementation/source validation or architecture closure is claimed.`);
  lines.push("- Recorded public facts below were supplied as research context, retain `fetchedByScanner=false`, and are `recorded-unverified`; URLs are provenance anchors, not evidence of an offline fetch.");
  lines.push("- No exact Babylon contracts, addresses, assets, finality providers, consumer joins, or economics exist in the loaded local evidence.");
  lines.push("- All protocol heights, depths, thresholds, satoshi values, and vote fractions are represented symbolically or as strings; the scanner performs no JS Number arithmetic on protocol integers.", "");

  lines.push("## Provenance Manifest — Loaded Local Artifacts", "");
  renderTable(lines, ["ID", "Path", "Class", "Loaded", "SHA-256", "Relevance"], raw.provenance.localInputs.map((row) => [row.id, `\`${row.path}\``, row.evidenceClass, row.loaded, `\`${row.sha256}\``, row.relevance]));
  lines.push(`Local conclusion: raw TVL=${raw.localEvidenceSummary.canonicalDiscoveryIdentity.tvlUsdContext ?? "unavailable"} and score=${raw.localEvidenceSummary.canonicalDiscoveryIdentity.scoreContext ?? "unavailable"} are normalized generic discovery context only; there is no exact route or deployed-state proof.`, "");

  lines.push("## Duplicate Raw-Evidence Reconciliation", "");
  lines.push(`- Status: \`${raw.localEvidenceSummary.status}\`; observed=${raw.localEvidenceSummary.representationsObserved}; reconciled=${raw.localEvidenceSummary.representationsReconciled}; contradictions=${raw.localEvidenceSummary.contradictionCount}.`);
  renderTable(lines, ["Representation", "Raw location", "Name", "Slug", "Category", "Coverage", "Promotion", "Score", "TVL context", "Route", "Execute", "Signed"], raw.localEvidenceSummary.rows.map((row) => [row.representation, row.location, row.name, row.slug, row.category, row.coverageStatus, row.promotionBucket, row.scoreContext, row.tvlUsdContext, row.routePositive, row.executableNow, row.signedActionJustified]));
  lines.push(raw.localEvidenceSummary.interpretation, "");

  lines.push("## Provenance Manifest — Static Recorded Public Facts", "");
  renderTable(lines, ["Fact", "Recorded statement", "Verification", "Source class", "Observed/researched", "Fetched", "URL"], raw.provenance.recordedPublicFacts.map((fact) => [fact.id, fact.statement, fact.verificationStatus, fact.sourceClass, fact.observedOrResearchedDate, fact.fetchedByScanner, fact.sourceUrl]));

  lines.push("## Not-Queried Current State", "");
  for (const item of raw.provenance.notQueriedCurrentState) lines.push(`- ${item}`);
  lines.push("");

  lines.push("## Scope / Identity Separation", "");
  renderTable(lines, ["Scope", "Identity", "Included as Babylon core coverage?", "Treatment"], raw.scopeIdentity.map((row) => [row.scope, row.identity, row.countedAsBabylonCoreCoverage, row.treatment]));

  lines.push("## Architecture", "");
  renderTable(lines, ["Component", "Boundary", "Recorded description", "Status"], raw.architectureRows.map((row) => [row.component, row.boundary, row.description, row.evidenceStatus]));
  lines.push("## Modules", "");
  renderTable(lines, ["Module", "Role", "Status"], raw.moduleRows.map((row) => [row.module, row.role, row.evidenceStatus]));
  lines.push("## Recorded-Unverified Staking-Script Context", "");
  renderTable(lines, ["Path", "Recorded authorization", "Unverified bindings/outcomes", "Status"], raw.scriptRows.map((row) => [row.path, row.authorization, row.condition, row.evidenceStatus]));
  lines.push("## Registration / Delegation Lifecycle", "");
  renderTable(lines, ["Order", "Stage", "Trigger", "Recorded context", "Status"], raw.lifecycleRows.map((row) => [row.order, row.stage, row.trigger, row.state, row.evidenceStatus]));
  lines.push("## Security Assumptions", "");
  renderTable(lines, ["Recorded assumption", "Boundary", "Pinned-source test need", "Status"], raw.securityAssumptionRows.map((row) => [row.assumption, row.boundary, row.failureModeToTest, row.evidenceStatus]));

  lines.push("## Exploit-Class Coverage Matrix", "");
  renderTable(lines, ["Class", "Status", "Basis"], raw.coverageMatrix.map((row) => [row.exploitClass, row.status, row.basis]));
  lines.push("No row is a vulnerability claim. `recorded-unverified` and `unknown-needs-pinned-source` do not establish implementation behavior, architectural correctness, remediation, or closure.", "");

  lines.push("## Hypothesis Correction", "");
  lines.push("Generic donation/first-depositor/ERC4626/share-rounding labels from the local discovery scorer are **not Babylon Genesis core findings**. Babylon core does not mint a native transferable BTC receipt/share/LST token. PumpBTC, SolvBTC, Lombard, Bedrock, and other receipt/vault/oracle/consumer designs remain separate third-party target scopes and do not count as Babylon core coverage.", "");

  lines.push("## Historical / Policy Context", "");
  lines.push("- The v1.0.1 BLS-key overwrite description is `recorded-unverified-historical-context`. The scanner did not independently substantiate severity, affected behavior, or remediation; it is not reported as a current vulnerability.");
  lines.push("- The recorded security policy had no official bounty at publication and forbids public production/testnet testing. This step remained local/static and did not test any public network.", "");

  lines.push("## Prioritized Safe Local Test Plan", "");
  renderTable(lines, ["Priority", "Test", "Method", "Official-source alignment", "Status"], raw.safeLocalTestPlan.map((row) => [row.priority, row.test, row.method, row.sourceAlignment, row.status]));

  lines.push("## Gate Status", "");
  lines.push("- `auditClassification=INCOMPLETE/WATCH`");
  lines.push("- `architectureValidationStatus=unknown-no-local-source-snapshot`");
  lines.push("- `routePositiveOperational=0`; `routeEvidenceStatus=unknown`; `evidenceComplete=false`; `closureEligible=false`");
  lines.push("- `executableNow=0`; `signedActionJustified=false`");
  lines.push("- No fork, executor, aggregate gate promotion, signed action, or transaction work is justified.");
  lines.push(`- Highest next bounded step: ${raw.nextBoundedStep}`);
  lines.push("- Source build/tests remain blocked until an immutable local source/dependency snapshot exists; current deployed state and economics remain not queried.", "");
  return lines.join("\n");
}

function deterministicSelfCheck(raw) {
  const allowedEvidenceStatuses = new Set(["recorded-unverified", "unknown-needs-pinned-source", "out-of-core-third-party"]);
  if (raw.provenance.localInputs.length !== LOCAL_INPUTS.length || raw.provenance.localInputs.length !== 3) throw new Error("Self-check failed: local provenance count");
  if (raw.provenance.recordedPublicFacts.length !== RECORDED_PUBLIC_FACTS.length || raw.provenance.recordedPublicFacts.length !== 13) throw new Error("Self-check failed: recorded fact count");
  if (!raw.provenance.recordedPublicFacts.every((fact) => fact.fetchedByScanner === false && fact.verificationStatus === "recorded-unverified")) throw new Error("Self-check failed: public-fact verification honesty");
  if (raw.architectureValidationStatus !== "unknown-no-local-source-snapshot") throw new Error("Self-check failed: architecture validation status");
  const evidenceRows = [...raw.moduleRows, ...raw.architectureRows, ...raw.scriptRows, ...raw.lifecycleRows, ...raw.securityAssumptionRows, ...raw.coverageMatrix];
  if (!evidenceRows.every((row) => allowedEvidenceStatuses.has(row.evidenceStatus || row.status))) throw new Error("Self-check failed: disallowed evidence status");
  if (JSON.stringify(raw).includes("covered-static-context")) throw new Error("Self-check failed: stale covered-static-context claim");
  if (raw.localEvidenceSummary.status !== "agreed-all-representations" || raw.localEvidenceSummary.representationsObserved < 2 || raw.localEvidenceSummary.representationsObserved !== raw.localEvidenceSummary.representationsReconciled || raw.localEvidenceSummary.contradictionCount !== 0) throw new Error("Self-check failed: duplicate reconciliation");
  const requiredDuplicateFields = ["name", "slug", "category", "coverageStatus", "promotionBucket", "scoreContext", "tvlUsdContext"];
  if (!raw.localEvidenceSummary.rows.every((row) => requiredDuplicateFields.every((field) => row[field] != null))) throw new Error("Self-check failed: incomplete duplicate identity/scoring reconciliation");
  if (!raw.localEvidenceSummary.rows.every((row) => row.routePositive === 0 && row.executableNow === 0 && row.signedActionJustified === 0)) throw new Error("Self-check failed: duplicate gate agreement");
  if (!raw.safeLocalTestPlan.every((row) => row.status === "blocked-needs-local-source-snapshot" && row.immediatelyExecutable === false && row.prerequisite)) throw new Error("Self-check failed: source-test blocking");
  const gatesOk = raw.auditClassification === "INCOMPLETE/WATCH"
    && raw.evidenceComplete === false
    && raw.closureEligible === false
    && raw.routeEvidenceStatus === "unknown"
    && raw.routePositiveOperational === 0
    && raw.routePositive === 0
    && raw.executableNow === 0
    && raw.signedActionJustified === false
    && raw.forkPromotion === false
    && raw.executorPromotion === false
    && raw.aggregatePromotion === false;
  if (!gatesOk) throw new Error("Self-check failed: gate consistency");
  return {
    status: "passed",
    provenanceCounts: { localInputs: raw.provenance.localInputs.length, recordedPublicFacts: raw.provenance.recordedPublicFacts.length },
    duplicateAgreement: raw.localEvidenceSummary.status,
    duplicateRepresentations: raw.localEvidenceSummary.representationsReconciled,
    allowedEvidenceStatuses: [...allowedEvidenceStatuses],
    gateConsistency: "passed-fail-closed",
  };
}

function main() {
  const { loaded, manifest } = loadLocalInputs();
  const localEvidenceSummary = reconcileLocalBabylonEvidence(loaded);
  const raw = {
    generatedAt: GENERATED_AT,
    researchedDate: RESEARCHED_DATE,
    scanner: SCANNER,
    signal: "🟠 WATCH",
    auditClassification: "INCOMPLETE/WATCH",
    architectureValidationStatus: "unknown-no-local-source-snapshot",
    scope: "Babylon Protocol step-1 deterministic offline read-only discovery from three declared local artifacts plus recorded-unverified public assertions",
    safety: {
      deterministicOfflineReduction: true,
      readOnlyResearch: true,
      networkCalls: false,
      rpcCalls: false,
      apiCalls: false,
      endpointInventoriesRead: false,
      secretsRead: false,
      currentStateQueried: false,
      transactions: false,
      simulations: false,
      signedActions: false,
      broadcasts: false,
      calldataConstructedOrExecuted: false,
      forks: false,
      walletOps: false,
      exploitExecution: false,
      aggregateGatePromoted: false,
      otherScannersModified: false,
    },
    numericHandling: {
      protocolIntegerJsNumberArithmetic: false,
      satoshiArithmetic: "not-performed",
      heightAndDepthRepresentation: "symbolic/string-only",
      thresholdRepresentation: "M-of-N and >2/3 strings; no floating-point threshold arithmetic",
    },
    provenance: {
      policy: "loaded-local-artifact, static-recorded-public-fact/recorded-unverified, and not-queried-current-state are distinct evidence classes; rerunning does not refresh or validate public/source/chain state",
      localInputs: manifest,
      recordedPublicFacts: RECORDED_PUBLIC_FACTS,
      notQueriedCurrentState: [
        "Current bbn-1 chain tip, app hash, validator/finality-provider set, voting power, and liveness.",
        "Current BTC tip, canonical branch, inclusion depth, delegation UTXOs, covenant signatures, and slashing transactions.",
        "Current module parameters, parameter versions/activation heights, governance proposals, authorities, and upgrade state.",
        "Exact deployed contracts, addresses, assets, finality providers, delegations, consumer-zone joins, and integration deployments.",
        "Current rewards, incentive balances, fee/gas behavior, third-party LST supply/backing/oracles/consumers, and exact economics.",
        "Whether v4.3.0 remains the latest release or whether the recorded security-policy publication state has changed.",
      ],
    },
    localEvidenceSummary,
    scopeIdentity: [
      { scope: "Babylon Genesis core", identity: "babylonlabs-io/babylon; bbn-1; core x/ modules including x/zoneconcierge", countedAsBabylonCoreCoverage: true, treatment: "Primary recorded-unverified architecture scope; no local source snapshot, implementation validation, or current state." },
      { scope: "External integrations", identity: "covenant emulator, vigilante/relayers/reporters/monitors, finality-provider operators, consumer chains/channels/counterparties", countedAsBabylonCoreCoverage: false, treatment: "External safety/liveness/authentication boundaries; separate from the in-repository x/zoneconcierge module." },
      { scope: "Third-party BTC LSTs/receipts", identity: "PumpBTC, SolvBTC, Lombard LBTC, Bedrock and similar", countedAsBabylonCoreCoverage: false, treatment: "Separate products and target scopes; no receipt/oracle/consumer finding is attributed to Babylon core." },
      { scope: "TBV / vaultBTC", identity: "Separate testnet vault product", countedAsBabylonCoreCoverage: false, treatment: "Not Babylon Genesis core and not production-state coverage in this artifact." },
    ],
    architectureRows: ARCHITECTURE_ROWS,
    moduleRows: MODULE_ROWS,
    scriptRows: SCRIPT_ROWS,
    lifecycleRows: LIFECYCLE_ROWS,
    securityAssumptionRows: SECURITY_ASSUMPTION_ROWS,
    coverageMatrix: COVERAGE_MATRIX,
    safeLocalTestPlan: SAFE_LOCAL_TEST_PLAN,
    hypothesesNotFindings: {
      donationInflation: false,
      firstDepositor: false,
      erc4626ShareRounding: false,
      explanation: "Generic discovery labels do not apply as Babylon core findings because core has no native transferable BTC receipt/share token.",
    },
    historicalContext: {
      item: "v1.0.1 recorded BLS-key overwrite description",
      classification: "recorded-unverified-historical-context",
      severityIndependentlySubstantiated: false,
      remediationIndependentlySubstantiated: false,
      currentVulnerabilityClaim: false,
    },
    summary: {
      localInputsLoaded: manifest.length,
      recordedPublicFacts: RECORDED_PUBLIC_FACTS.length,
      modulesMapped: MODULE_ROWS.length,
      architectureRows: ARCHITECTURE_ROWS.length,
      scriptRows: SCRIPT_ROWS.length,
      lifecycleRows: LIFECYCLE_ROWS.length,
      securityAssumptions: SECURITY_ASSUMPTION_ROWS.length,
      coverageClasses: COVERAGE_MATRIX.length,
      safeLocalTestsPlanned: SAFE_LOCAL_TEST_PLAN.length,
      vulnerabilityClaims: 0,
      exactBabylonRoutes: 0,
      exactContractsOrAddresses: 0,
      exactCurrentFinalityProviders: 0,
      exactConsumerJoins: 0,
      exactEconomicsRows: 0,
    },
    nextBoundedStep: "After an immutable user-supplied/pinned source and dependency snapshot is locally present, perform a read-only source trace before any build or test execution.",
    evidenceComplete: false,
    closureEligible: false,
    routeEvidenceStatus: "unknown",
    routePositiveOperational: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    forkPromotion: false,
    executorPromotion: false,
    aggregatePromotion: false,
  };

  raw.selfChecks = deterministicSelfCheck(raw);

  writeAllowed(OUT_JSON, `${JSON.stringify(raw, null, 2)}\n`);
  writeAllowed(OUT_MD, `${renderReport(raw)}\n`);
  console.log(`wrote ${rel(OUT_JSON)} and ${rel(OUT_MD)}`);
  console.log(`localInputs=${raw.summary.localInputsLoaded} recordedFacts=${raw.summary.recordedPublicFacts} duplicateRepresentations=${raw.localEvidenceSummary.representationsReconciled} duplicateStatus=${raw.localEvidenceSummary.status} modules=${raw.summary.modulesMapped} coverageClasses=${raw.summary.coverageClasses} testsBlocked=${raw.summary.safeLocalTestsPlanned} vulnerabilities=${raw.summary.vulnerabilityClaims}`);
  console.log(`architectureValidationStatus=${raw.architectureValidationStatus} selfChecks=${raw.selfChecks.status}`);
  console.log(`auditClassification=${raw.auditClassification} routePositiveOperational=${raw.routePositiveOperational} routeEvidenceStatus=${raw.routeEvidenceStatus} evidenceComplete=${raw.evidenceComplete} closureEligible=${raw.closureEligible} executableNow=${raw.executableNow} signedActionJustified=${raw.signedActionJustified}`);
}

try {
  main();
} catch (error) {
  console.error(`scan-babylon-readonly-discovery failed: ${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
}
