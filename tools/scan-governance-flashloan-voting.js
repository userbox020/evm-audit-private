#!/usr/bin/env node
// scan-governance-flashloan-voting.js
//
// Artifact-only Phase 1 scanner for Token-of-Power style governance voting risk.
// It intentionally does not read rpc_endpoints.txt, .env, GraphQL inventories,
// key material, or perform eth_call/fork/live transactions. Rows that require
// current chain/indexer reads (selector probes, top-holder concentration) are
// marked unresolved instead of being treated as route-negative proof.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const QUIET = process.argv.includes("--quiet");

const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "governance-flashloan-voting.json");
const OUT_MD = path.join(WORKSPACE, "reports", "governance-flashloan-voting-triage.md");

const INPUTS = {
  listingWatch: path.join(WORKSPACE, "reports", "raw", "fast", "governance-listing-watch.json"),
  timelockPayloads: path.join(WORKSPACE, "reports", "raw", "fast", "governance-timelock-payloads.json"),
  attackSurface: path.join(WORKSPACE, "reports", "raw", "fast", "governance-attack-surface.json"),
};

const SELECTORS = {
  balanceOf: "0x70a08231",
  getVotes: "0x9ab24eb0",
  getPastVotes: "0x3a46b1a8",
  getPriorVotes: "0x782d6fe1",
  delegates: "0x587cde1e",
  numCheckpoints: "0x6fcfff45",
  quorumVotes: "0xf8e6679f",
  quorum: "0xf8d3d60f",
  proposalThreshold: "0x8d80ff0a",
};

const TARGETS = [
  {
    protocol: "Compound",
    chain: "Ethereum",
    governanceToken: "COMP",
    tokenAddress: "0xc00e94Cb662C3520282E6f5717214004A7f26888",
    governorAddress: "0xc0Da02939E1441F497fd74F78cE7Decb17B66529",
    timelockAddress: "0x6d903f6003cca6255d85cca4d3b5e5146dc33925",
    snapshotSpace: "compound-finance.eth",
    votingMechanism: "CHECKPOINT_SAFE",
    votingPowerSource: "Compound COMP-style getPriorVotes(account, blockNumber) checkpoints with delegation.",
    expectedVotingSelectors: ["getPriorVotes", "delegates", "numCheckpoints"],
    damageClass: "HIGH",
    damageMapping: ["Governor/timelock can change Comptroller/market risk parameters and implementations through proposals."],
  },
  {
    protocol: "Aave",
    chain: "Ethereum",
    governanceToken: "AAVE / stkAAVE",
    tokenAddress: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    governorAddress: "local-governance-v3-controller/executors",
    timelockAddress: "0x9AEE0B04504CeF83A65AC3f0e838D0593BCb2BC7",
    snapshotSpace: "aave.eth",
    votingMechanism: "CHECKPOINT_SAFE",
    votingPowerSource: "Aave Governance V3 voting strategy/checkpointed delegated power; not modeled as live balanceOf voting in local artifacts.",
    expectedVotingSelectors: ["getVotes", "getPastVotes", "delegates"],
    damageClass: "CRITICAL",
    damageMapping: ["Governance executors can change risk/oracle/cap/pause/listing parameters and protocol upgrades."],
  },
  {
    protocol: "Uniswap",
    chain: "Ethereum",
    governanceToken: "UNI",
    tokenAddress: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    governorAddress: "0x5e4be8Bc9637f0EAA1A755019e06A68ce081D58F",
    timelockAddress: "0x1a9C8182C09F50C8318d769245beA52c32BE35BC",
    snapshotSpace: "uniswap",
    votingMechanism: "CHECKPOINT_SAFE",
    votingPowerSource: "UNI governance token is checkpoint/delegation based, not current balanceOf voting.",
    expectedVotingSelectors: ["getPriorVotes", "delegates", "numCheckpoints"],
    damageClass: "MEDIUM",
    damageMapping: ["Governance controls treasury/protocol parameters; direct lending-drain impact depends on downstream integrations."],
  },
  {
    protocol: "Sky / Maker",
    chain: "Ethereum",
    governanceToken: "MKR / SKY",
    tokenAddress: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2",
    governorAddress: "DSChief / executive spell system",
    timelockAddress: "0xbE286431454714F511008713973d3B053A2d38f3",
    snapshotSpace: "makerdao-ses.eth",
    votingMechanism: "LOCKED_OR_DELAYED_SAFE",
    votingPowerSource: "Executive voting requires governance-specific locking/spell delay context; not a simple same-tx balanceOf vote in local artifacts.",
    expectedVotingSelectors: ["lock", "vote", "hat"],
    damageClass: "CRITICAL",
    damageMapping: ["Successful governance can change collateral onboarding, oracles, rates, and spell-executed protocol parameters."],
  },
  {
    protocol: "Lido",
    chain: "Ethereum",
    governanceToken: "LDO",
    tokenAddress: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32",
    governorAddress: "Aragon/DAO voting stack",
    timelockAddress: null,
    snapshotSpace: "lido-snapshot.eth",
    votingMechanism: "CHECKPOINT_SAFE",
    votingPowerSource: "Aragon/MiniMe-style historical balance voting in common Lido DAO setup; not classified as current-block balanceOf voting here.",
    expectedVotingSelectors: ["balanceOfAt", "totalSupplyAt"],
    damageClass: "HIGH",
    damageMapping: ["Governance can control DAO agents, protocol modules, permissions, and treasury paths."],
  },
  {
    protocol: "Curve",
    chain: "Ethereum",
    governanceToken: "CRV / veCRV",
    tokenAddress: "0xD533a949740bb3306d119CC777fa900bA034cd52",
    governorAddress: "0x2F50D538606Fa9EDD2B11E2446BEb18C9D5846bB",
    timelockAddress: null,
    snapshotSpace: "curve.eth",
    votingMechanism: "LOCKED_OR_DELAYED_SAFE",
    votingPowerSource: "veCRV locking/escrow voting prevents same-block flash-loan voting power in the normal path.",
    expectedVotingSelectors: ["balanceOf", "balanceOfAt", "create_lock", "increase_amount"],
    damageClass: "HIGH",
    damageMapping: ["DAO and gauge governance can influence gauges/factories/admins; direct drain requires route-specific payload proof."],
  },
  {
    protocol: "Morpho",
    chain: "Ethereum",
    governanceToken: "MORPHO",
    tokenAddress: "0x58D97B57BB95320F9a05dC918Aef65434969c2B2",
    governorAddress: "Morpho DAO/Governor",
    timelockAddress: null,
    snapshotSpace: "morpho.eth",
    votingMechanism: "CHECKPOINT_SAFE",
    votingPowerSource: "MORPHO is treated as ERC20Votes/delegation-checkpoint governed in local artifacts; no live balanceOf voting proof.",
    expectedVotingSelectors: ["getVotes", "getPastVotes", "delegates"],
    damageClass: "MEDIUM",
    damageMapping: ["Core Morpho Blue markets are largely immutable; governance damage is more likely around allocators, wrappers, rewards, and protocol-owned configs."],
  },
  {
    protocol: "Euler",
    chain: "Ethereum",
    governanceToken: "EUL",
    tokenAddress: "0xd9fcd98c322942075a5c3860693e9f4f03aae07b",
    governorAddress: "Euler DAO/Governor",
    timelockAddress: "0x4cD6BF1D183264c02Be7748Cb5cd3A47d013351b",
    snapshotSpace: "eulerdao.eth",
    votingMechanism: "CHECKPOINT_SAFE",
    votingPowerSource: "EUL governance is treated as delegated/checkpointed in local artifacts; no live balanceOf voting proof.",
    expectedVotingSelectors: ["getVotes", "getPastVotes", "delegates"],
    damageClass: "HIGH",
    damageMapping: ["Governance/admin paths can affect EVK factories, vault risk roles, oracle/risk configuration, and protocol settings."],
  },
  {
    protocol: "GMX",
    chain: "Arbitrum/Avalanche",
    governanceToken: "GMX",
    tokenAddress: "0xfc5A1A6EB076a0Afc6aD06eD0d88ba2eD53d0A90",
    governorAddress: "multisig/timelock + off-chain governance context",
    timelockAddress: null,
    snapshotSpace: "gmx.eth",
    votingMechanism: "UNKNOWN_ONCHAIN",
    votingPowerSource: "On-chain Governor contract and token-vote source are not resolved in local artifacts; GMX governance is often multisig/Snapshot/timelock mediated.",
    expectedVotingSelectors: ["unknown"],
    damageClass: "HIGH",
    damageMapping: ["Governance/admins can affect perps parameters, keepers/oracles, fee settings, and upgradeable components depending on deployed module."],
  },
  {
    protocol: "Pendle",
    chain: "Ethereum",
    governanceToken: "PENDLE / vePENDLE",
    tokenAddress: "0x808507121B80c02388fAd14726482e061B8da827",
    governorAddress: "vePENDLE governance / multisig context",
    timelockAddress: "0x4f30A9D41B80ecC5B94306AB4364951AE3170210",
    snapshotSpace: "pendle-finance.eth",
    votingMechanism: "LOCKED_OR_DELAYED_SAFE",
    votingPowerSource: "vePENDLE lock/escrow voting is not same-block flash-loanable in the normal path.",
    expectedVotingSelectors: ["create_lock", "increase_amount", "balanceOf"],
    damageClass: "HIGH",
    damageMapping: ["Governance/admins can affect markets, routers, rewards, oracle/rate integration parameters, and treasury-owned settings."],
  },
];

function loadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function safeObj(v) {
  return v && typeof v === "object" ? v : {};
}

function sameProtocol(a, b) {
  const left = String(a || "").toLowerCase();
  const right = String(b || "").toLowerCase();
  if (!left || !right) return false;
  return left.includes(right) || right.includes(left) || (left.includes("sky") && right.includes("maker")) || (left.includes("maker") && right.includes("sky"));
}

function mechanismBucket(mechanism) {
  if (mechanism === "FLASH_LOANABLE_BALANCEOF") return "FLASH_LOANABLE";
  if (mechanism === "CHECKPOINT_SAFE") return "CHECKPOINT_SAFE";
  if (mechanism === "LOCKED_OR_DELAYED_SAFE") return "LOCKED_OR_DELAYED_SAFE";
  if (mechanism === "DELEGATION_REQUIRED") return "DELEGATION_REQUIRED";
  return "UNKNOWN";
}

function classifyConcentration() {
  return {
    concentrationClass: "UNKNOWN_NO_HOLDER_SNAPSHOT",
    holderRows: [],
    topHolderPct: null,
    top3Pct: null,
    quorumPct: null,
    blocker: "Top-holder/quorum comparison requires a current token-holder snapshot or read-only indexer artifact; no such artifact is present in this artifact-only pass.",
  };
}

function classifyCombined(row) {
  const mechanism = row.votingMechanism;
  const concentration = row.concentration.concentrationClass;
  const damage = row.damageClass;

  if (mechanism === "FLASH_LOANABLE_BALANCEOF" && ["CONCENTRATED", "TOP3"].includes(concentration) && damage === "CRITICAL") {
    return { verdict: "CONFIRMED RISK", routePositive: 1, reason: "flash-loanable live voting plus concentrated quorum and critical governance damage" };
  }
  if (mechanism === "FLASH_LOANABLE_BALANCEOF" && ["CRITICAL", "HIGH"].includes(damage)) {
    return { verdict: "VULNERABLE", routePositive: 1, reason: "flash-loanable live voting with high-impact governance damage" };
  }
  if (["CHECKPOINT_SAFE", "DELEGATION_REQUIRED", "LOCKED_OR_DELAYED_SAFE"].includes(mechanism)) {
    return { verdict: "SECURE_FLASHLOAN_BLOCKED", routePositive: 0, reason: "artifact evidence indicates checkpoints, delegation, locking, or delay blocks same-tx balanceOf flash-loan voting" };
  }
  return { verdict: "UNKNOWN_NEEDS_ONCHAIN_SELECTOR_AND_HOLDER_DATA", routePositive: 0, reason: "on-chain governor/token selector source and holder concentration are unresolved in artifact-only mode" };
}

function findSnapshotSignal(listing, target) {
  const spaces = safeObj(listing?.spaces);
  const bySpace = spaces[target.snapshotSpace];
  if (bySpace) return { space: target.snapshotSpace, proposals: bySpace.proposals || 0, watchCandidates: bySpace.watchCandidates || 0, ok: bySpace.ok === true };
  const match = Object.entries(spaces).find(([, value]) => sameProtocol(value?.protocol, target.protocol));
  if (!match) return null;
  return { space: match[0], proposals: match[1]?.proposals || 0, watchCandidates: match[1]?.watchCandidates || 0, ok: match[1]?.ok === true };
}

function findAttackSurfaceSignal(attackSurface, target) {
  const rows = safeArray(attackSurface?.topRows);
  const row = rows.find((r) => sameProtocol(r.protocol, target.protocol));
  if (!row) return null;
  return {
    adminAddress: row.adminAddress || null,
    adminType: row.adminType || null,
    timelockDelaySeconds: row.timelockDelaySeconds ?? null,
    verdict: row.verdict || null,
    blockers: safeArray(row.blockers).slice(0, 3),
  };
}

function findTimelockSignal(timelock, target) {
  const rows = safeArray(timelock?.topRows).concat(safeArray(timelock?.rows));
  const row = rows.find((r) => sameProtocol(r.protocol, target.protocol) || String(r.address || "").toLowerCase() === String(target.timelockAddress || "").toLowerCase());
  if (!row) return null;
  return {
    protocol: row.protocol || target.protocol,
    address: row.address || target.timelockAddress || null,
    delaySeconds: row.delaySeconds ?? row.minDelaySeconds ?? row.timelockDelaySeconds ?? null,
    activeCriticalPayloadRows: row.activeCriticalPayloadRows || 0,
    lowDelay: row.lowDelay === true,
  };
}

function buildRow(target, artifacts) {
  const concentration = classifyConcentration(target);
  const combined = classifyCombined({ ...target, concentration });
  const snapshot = findSnapshotSignal(artifacts.listingWatch, target);
  const attackSurface = findAttackSurfaceSignal(artifacts.attackSurface, target);
  const timelock = findTimelockSignal(artifacts.timelockPayloads, target);
  const selectorProbeStatus = "not-run-artifact-only";
  const mechanism = mechanismBucket(target.votingMechanism);
  const blockers = [];

  if (selectorProbeStatus !== "proven") blockers.push("On-chain selector read not run in artifact-only mode; voting mechanism uses known/local source classification only.");
  if (concentration.concentrationClass === "UNKNOWN_NO_HOLDER_SNAPSHOT") blockers.push(concentration.blocker);
  if (combined.routePositive === 0) blockers.push("No fork proof or exact malicious-proposal value-delta economics.");
  if (target.votingMechanism === "UNKNOWN_ONCHAIN") blockers.push("On-chain Governor/token vote source unresolved; needs read-only selector probe before closure.");

  return {
    protocol: target.protocol,
    chain: target.chain,
    governanceToken: target.governanceToken,
    tokenAddress: target.tokenAddress,
    governorAddress: target.governorAddress,
    timelockAddress: target.timelockAddress,
    snapshotSpace: target.snapshotSpace,
    votingMechanism: target.votingMechanism,
    votingMechanismBucket: mechanism,
    votingPowerSource: target.votingPowerSource,
    expectedVotingSelectors: target.expectedVotingSelectors,
    selectorIds: Object.fromEntries(target.expectedVotingSelectors.filter((x) => SELECTORS[x]).map((x) => [x, SELECTORS[x]])),
    selectorProbeStatus,
    concentration,
    damageClass: target.damageClass,
    damageMapping: target.damageMapping,
    relatedArtifactSignals: { snapshot, attackSurface, timelock },
    verdict: combined.verdict,
    verdictReason: combined.reason,
    routePositive: combined.routePositive,
    executableNow: false,
    signedActionJustified: false,
    forkGate: "closed-artifact-only-no-route-positive",
    blockers,
  };
}

function summarize(rows) {
  const count = (predicate) => rows.filter(predicate).length;
  const routePositive = rows.reduce((acc, row) => acc + (row.routePositive ? 1 : 0), 0);
  return {
    targetProtocols: rows.length,
    flashLoanableRows: count((r) => r.votingMechanism === "FLASH_LOANABLE_BALANCEOF"),
    checkpointSafeRows: count((r) => r.votingMechanism === "CHECKPOINT_SAFE"),
    delegationRequiredRows: count((r) => r.votingMechanism === "DELEGATION_REQUIRED"),
    lockedOrDelayedRows: count((r) => r.votingMechanism === "LOCKED_OR_DELAYED_SAFE"),
    unknownMechanismRows: count((r) => r.votingMechanism === "UNKNOWN_ONCHAIN"),
    concentrationUnknownRows: count((r) => r.concentration.concentrationClass === "UNKNOWN_NO_HOLDER_SNAPSHOT"),
    criticalDamageRows: count((r) => r.damageClass === "CRITICAL"),
    highDamageRows: count((r) => r.damageClass === "HIGH"),
    confirmedRiskRows: count((r) => r.verdict === "CONFIRMED RISK"),
    vulnerableRows: count((r) => r.verdict === "VULNERABLE"),
    secureFlashloanBlockedRows: count((r) => r.verdict === "SECURE_FLASHLOAN_BLOCKED"),
    needsOnchainDataRows: count((r) => r.verdict === "UNKNOWN_NEEDS_ONCHAIN_SELECTOR_AND_HOLDER_DATA"),
    watchCandidates: count((r) => r.verdict !== "SECURE_FLASHLOAN_BLOCKED" || r.concentration.concentrationClass === "UNKNOWN_NO_HOLDER_SNAPSHOT"),
    exactEconomicsRows: 0,
    forkProofRows: 0,
    routePositive,
    executableNow: 0,
    signedActionJustified: false,
    status: routePositive > 0 ? "governance-flashloan-route-positive-needs-fork" : "governance-flashloan-artifact-only-no-route-positive",
  };
}

function writeMarkdown(artifact) {
  const lines = [];
  lines.push("# 🟢 DORMANT — Governance Flash-Loan Voting Scanner");
  lines.push("");
  lines.push(`Generated: ${artifact.generatedAt}`);
  lines.push(`Scanner: ${artifact.scanner}`);
  lines.push("");
  lines.push("## Scope");
  lines.push("");
  lines.push("Artifact-only Phase 1 classification for Token-of-Power style on-chain governance voting risk across major DeFi governance tokens. No RPC inventory or endpoint file was read; no live/fork/signed action was used.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  for (const [key, value] of Object.entries(artifact.summary)) lines.push(`| ${key} | ${value} |`);
  lines.push("");
  lines.push("## Protocol Classification");
  lines.push("");
  lines.push("| Protocol | Token | Voting mechanism | Concentration | Damage | Verdict | routePositive |");
  lines.push("| --- | --- | --- | --- | --- | --- | ---: |");
  for (const row of artifact.rows) {
    lines.push(`| ${row.protocol} | ${row.governanceToken} | ${row.votingMechanism} | ${row.concentration.concentrationClass} | ${row.damageClass} | ${row.verdict} | ${row.routePositive} |`);
  }
  lines.push("");
  lines.push("## Unresolved Gates");
  lines.push("");
  lines.push("- Top-holder concentration vs quorum is unresolved for all rows because no current holder/quorum snapshot artifact is present in this artifact-only pass.");
  lines.push("- Selector probes are not current on-chain reads; they are known/local-source classifications only.");
  lines.push("- Route-positive requires a proven live-balance voting path, concentration/quorum proof, governance-damage payload, exact economics, and fork/local value-delta proof.");
  lines.push("");
  lines.push("## Per-row blockers");
  for (const row of artifact.rows) {
    lines.push("");
    lines.push(`### ${row.protocol}`);
    lines.push(`- Voting source: ${row.votingPowerSource}`);
    lines.push(`- Damage mapping: ${row.damageMapping.join("; ")}`);
    for (const blocker of row.blockers) lines.push(`- ${blocker}`);
  }
  lines.push("");
  lines.push("## Gate Conclusion");
  lines.push("");
  lines.push("No protocol is route-positive in this artifact-only pass. Phase 2 fork proof remains blocked unless Phase 1 is upgraded with current on-chain selector and holder/quorum data and finds `FLASH_LOANABLE` or `CONFIRMED RISK`/`VULNERABLE` rows.");
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, `${lines.join("\n")}\n`);
}

function main() {
  const artifacts = Object.fromEntries(Object.entries(INPUTS).map(([key, file]) => [key, loadJson(file, {})]));
  const rows = TARGETS.map((target) => buildRow(target, artifacts));
  const summary = summarize(rows);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-governance-flashloan-voting.js",
    scope: "Artifact-only governance flash-loan/live-balance voting risk classification for COMP/AAVE/UNI/MKR-SKY/LDO/CRV/MORPHO/EUL/GMX/PENDLE.",
    safety: {
      artifactOnly: true,
      rpcInventoryRead: false,
      graphqlInventoryRead: false,
      rpcUrlsStored: false,
      rawUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      keyMaterialRead: false,
      signedActions: false,
      liveTransactions: false,
      broadcasts: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: summary.routePositive > 0,
      executableNow: false,
      signedActionJustified: false,
    },
    thresholds: {
      confirmedRisk: "FLASH_LOANABLE_BALANCEOF + (CONCENTRATED or TOP3) + CRITICAL damage",
      vulnerable: "FLASH_LOANABLE_BALANCEOF + CRITICAL/HIGH damage",
      secureFlashloanBlocked: "checkpoint/delegation/locking/delay blocks same-transaction live-balance voting",
      requiredForFork: "confirmedRiskRows or vulnerableRows > 0 plus exact malicious-payload value-delta model",
    },
    sourceArtifacts: [
      "reports/raw/fast/governance-listing-watch.json",
      "reports/raw/fast/governance-timelock-payloads.json",
      "reports/raw/fast/governance-attack-surface.json",
    ],
    summary,
    rows,
    topRows: rows
      .slice()
      .sort((a, b) => {
        const rank = { "CONFIRMED RISK": 4, VULNERABLE: 3, UNKNOWN_NEEDS_ONCHAIN_SELECTOR_AND_HOLDER_DATA: 2, SECURE_FLASHLOAN_BLOCKED: 1 };
        return (rank[b.verdict] || 0) - (rank[a.verdict] || 0) || (b.damageClass === "CRITICAL" ? 1 : 0) - (a.damageClass === "CRITICAL" ? 1 : 0);
      })
      .slice(0, 10),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  writeMarkdown(artifact);
  if (!QUIET) console.log(JSON.stringify({ ok: true, output: path.relative(WORKSPACE, OUT), summary }, null, 2));
}

main();
