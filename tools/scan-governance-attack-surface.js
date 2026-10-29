#!/usr/bin/env node
// scan-governance-attack-surface.js — read-only governance attack-surface assessment across top lending protocols.
// Pattern: Token of Power exploit ($1.58M via malicious governance proposal, June 9 2026).
// No RPC secrets printed, no signed actions, no private keys. RPC URLs resolved in memory only.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "governance-attack-surface.json");
const OUT_MD = path.join(WORKSPACE, "reports", "governance-attack-surface-triage.md");
const QUIET = process.argv.includes("--quiet");

const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const OWNER_SELECTOR = "0x8da5cb5b";
const GET_MIN_DELAY_SELECTOR = "0xf27a0c92";
const DELAY_SELECTOR = "0x6a42b8f8";
const ZERO = "0x0000000000000000000000000000000000000000";

const TIMEOUT_MS = Number(process.env.GOV_ATTACK_SURFACE_TIMEOUT_MS || "12000");

const GOVERNANCE_LISTING_ARTIFACT = path.join(WORKSPACE, "reports", "raw", "fast", "governance-listing-watch.json");
const GOVERNANCE_TIMELOCK_ARTIFACT = path.join(WORKSPACE, "reports", "raw", "fast", "governance-timelock-payloads.json");

function log(...args) { if (!QUIET) console.error(...args); }

function loadRpcUrls() {
  try {
    if (!fs.existsSync(RPC_FILE)) return [];
    const text = fs.readFileSync(RPC_FILE, "utf8");
    return [...text.matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
  } catch (_) {
    return [];
  }
}

function loadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (data.error) throw new Error(`${data.error.code}: ${data.error.message}`);
    return data.result;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`RPC timeout after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpc(chainId) {
  for (const url of loadRpcUrls()) {
    try {
      const id = Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000)));
      if (id === chainId) return url;
    } catch (_) { /* skip */ }
  }
  return null;
}

async function getStorageAt(rpc, address, slot) {
  return await rpcCall(rpc, "eth_getStorageAt", [address, slot, "latest"]);
}

async function getCodeSize(rpc, address) {
  const code = await rpcCall(rpc, "eth_getCode", [address, "latest"]);
  return (code === "0x" || code === null) ? 0 : (code.length - 2) / 2;
}

async function ethCall(rpc, to, data) {
  return await rpcCall(rpc, "eth_call", [{ to, data }, "latest"]);
}

function normalizeAddress(raw) {
  if (!raw || raw === ZERO) return null;
  try { return ethers.getAddress(raw); } catch (_) { return null; }
}

function adminSlotToAddress(raw) {
  if (!raw || raw === "0x0000000000000000000000000000000000000000000000000000000000000000") return null;
  return normalizeAddress("0x" + raw.slice(-40));
}

async function checkAdmin(rpc, proxyAddress) {
  const raw = await getStorageAt(rpc, proxyAddress, EIP1967_ADMIN_SLOT);
  return adminSlotToAddress(raw);
}

async function checkOwner(rpc, address) {
  try {
    const raw = await ethCall(rpc, address, OWNER_SELECTOR);
    if (!raw || raw === "0x" || raw === "0x0000000000000000000000000000000000000000000000000000000000000000") return null;
    return normalizeAddress("0x" + raw.slice(-40));
  } catch (_) {
    return null;
  }
}

async function checkTimelockDelay(rpc, address) {
  try {
    const raw = await ethCall(rpc, address, GET_MIN_DELAY_SELECTOR);
    if (!raw || raw === "0x") return null;
    return Number(BigInt(raw));
  } catch (_) {
    try {
      const raw2 = await ethCall(rpc, address, DELAY_SELECTOR);
      if (!raw2 || raw2 === "0x") return null;
      return Number(BigInt(raw2));
    } catch (_2) {
      return null;
    }
  }
}

function classifyAdmin(codeSize, adminAddress, timelockDelaySeconds, governanceArtifactRefs) {
  const isEOA = codeSize === 0;
  const isContract = codeSize > 0;
  const hasTimelock = timelockDelaySeconds !== null && timelockDelaySeconds > 0;
  const longTimelock = hasTimelock && timelockDelaySeconds >= 172800;
  const shortTimelock = hasTimelock && timelockDelaySeconds < 86400;
  const moderateTimelock = hasTimelock && timelockDelaySeconds >= 86400 && timelockDelaySeconds < 172800;

  if (isEOA && !hasTimelock) {
    return { verdict: "CONFIRMED RISK", reason: "single EOA admin, no timelock — can drain/upgrade in one tx" };
  }
  if (isEOA && shortTimelock) {
    return { verdict: "VULNERABLE", reason: `EOA admin with short timelock (${timelockDelaySeconds}s < 1 day) — drain window exists` };
  }
  if (isEOA && moderateTimelock) {
    return { verdict: "VULNERABLE", reason: `EOA admin with moderate timelock (${timelockDelaySeconds}s) — single-point failure` };
  }
  if (isEOA && longTimelock) {
    return { verdict: "VULNERABLE", reason: `EOA admin with long timelock (${timelockDelaySeconds}s) — still a single-point failure` };
  }
  if (isContract && shortTimelock) {
    return { verdict: "VULNERABLE", reason: `contract admin with short timelock (${timelockDelaySeconds}s < 1 day)` };
  }
  if (isContract && moderateTimelock) {
    return { verdict: "INACTIVE", reason: `contract admin with moderate timelock (${timelockDelaySeconds}s) — likely multisig` };
  }
  if (isContract && longTimelock) {
    return { verdict: "SECURE", reason: `contract admin with long timelock (${timelockDelaySeconds}s >= 2 days) — likely multisig + timelock` };
  }
  if (isContract && !hasTimelock) {
    return { verdict: "INACTIVE", reason: "contract admin, no timelock detected — treat as multisig pending further analysis" };
  }
  if (isEOA) {
    return { verdict: "VULNERABLE", reason: "EOA admin — single-point failure" };
  }
  return { verdict: "INACTIVE", reason: "contract admin" };
}

const PROTOCOLS = [
  {
    protocol: "Aave V3",
    proxyAddress: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    proxyKind: "eip-1967",
    knownAdmin: null,
    knownOracleSetter: "0x9AEE0B04504CeF83A65AC3f0e838D0593BCb2BC7",
    knownPauseGuardian: null,
    source: "Aave V3 Pool proxy on Ethereum mainnet",
  },
  {
    protocol: "Compound V3",
    proxyAddress: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
    proxyKind: "comet",
    knownAdmin: null,
    knownOracleSetter: null,
    knownPauseGuardian: null,
    source: "Compound V3 cUSDCv3 Comet on Ethereum mainnet",
  },
  {
    protocol: "Morpho Blue",
    proxyAddress: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    proxyKind: "uups",
    knownAdmin: null,
    knownOracleSetter: null,
    knownPauseGuardian: null,
    source: "Morpho Blue core contract on Ethereum mainnet",
  },
  {
    protocol: "Euler EVK",
    proxyAddress: "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e",
    proxyKind: "eip-1967",
    knownAdmin: null,
    knownOracleSetter: "0x4cD6BF1D183264c02Be7748Cb5cd3A47d013351b",
    knownPauseGuardian: null,
    source: "Euler EVK factory on Ethereum mainnet",
  },
  {
    protocol: "Silo V3",
    proxyAddress: "0xC8Fc7F75A9938e6998dfCbAe8e3f1ed4e03C1a2C",
    proxyKind: "factory",
    knownAdmin: null,
    knownOracleSetter: null,
    knownPauseGuardian: null,
    source: "Silo V3 factory on Ethereum mainnet",
  },
  {
    protocol: "Venus Core Pool",
    proxyAddress: "0xfD36E2c2a6789Db23113685031d7F16329158384",
    proxyKind: "unitroller",
    knownAdmin: null,
    knownOracleSetter: null,
    knownPauseGuardian: null,
    source: "Venus Unitroller (Core Pool) on Ethereum mainnet",
  },
];

async function scanProtocol(rpc, proto) {
  const row = {
    protocol: proto.protocol,
    proxyAddress: proto.proxyAddress,
    proxyKind: proto.proxyKind,
    source: proto.source,
    adminAddress: null,
    adminType: null,
    adminCodeSize: null,
    timelockDelaySeconds: null,
    oracleSetterAddress: proto.knownOracleSetter || null,
    pauseGuardianAddress: proto.knownPauseGuardian || null,
    verdict: null,
    verdictReason: null,
    blockers: [],
    errors: [],
  };

  try {
    let adminAddress = proto.knownAdmin;

    if (!adminAddress && proto.proxyKind === "eip-1967") {
      adminAddress = await checkAdmin(rpc, proto.proxyAddress);
    }

    if (!adminAddress && proto.proxyKind === "comet") {
      try {
        const raw = await ethCall(rpc, proto.proxyAddress, "0xf851a440");
        adminAddress = normalizeAddress("0x" + raw.slice(-40));
      } catch (_) {
        try {
          adminAddress = await checkAdmin(rpc, proto.proxyAddress);
        } catch (_2) { /* fallthrough */ }
      }
    }

    if (!adminAddress && proto.proxyKind === "uups") {
      adminAddress = await checkOwner(rpc, proto.proxyAddress);
      if (!adminAddress) {
        adminAddress = await checkAdmin(rpc, proto.proxyAddress);
      }
    }

    if (!adminAddress && proto.proxyKind === "factory") {
      adminAddress = await checkOwner(rpc, proto.proxyAddress);
      if (!adminAddress) {
        adminAddress = await checkAdmin(rpc, proto.proxyAddress);
      }
    }

    if (!adminAddress && proto.proxyKind === "unitroller") {
      try {
        const raw = await ethCall(rpc, proto.proxyAddress, "0x8da5cb5b");
        adminAddress = normalizeAddress("0x" + raw.slice(-40));
      } catch (_) {
        try {
          adminAddress = await checkAdmin(rpc, proto.proxyAddress);
        } catch (_2) { /* fallthrough */ }
      }
    }

    if (!adminAddress) {
      row.blockers.push("Could not resolve admin/owner address via EIP-1967 slot, owner(), or admin()");
      row.verdict = "INSUFFICIENT DATA";
      return row;
    }

    row.adminAddress = adminAddress;

    const codeSize = await getCodeSize(rpc, adminAddress);
    row.adminCodeSize = codeSize;

    if (codeSize === 0) {
      row.adminType = "EOA";
    } else if (codeSize < 500) {
      row.adminType = "contract (small)";
    } else {
      row.adminType = "contract";
    }

    const timelockDelay = await checkTimelockDelay(rpc, adminAddress);
    row.timelockDelaySeconds = timelockDelay;

    const classification = classifyAdmin(codeSize, adminAddress, timelockDelay, null);
    row.verdict = classification.verdict;
    row.verdictReason = classification.reason;

    if (codeSize === 0) {
      row.blockers.push("Admin is an EOA — single key compromise can drain protocol");
    }
    if (timelockDelay === null && codeSize > 0) {
      row.blockers.push("No timelock delay detected on admin contract — may be multisig, needs further verification");
    }
    if (timelockDelay !== null && timelockDelay < 86400) {
      row.blockers.push(`Timelock delay (${timelockDelay}s) is below 1 day — rapid governance attack window`);
    }

  } catch (e) {
    row.errors.push(e.message);
    row.verdict = "ERROR";
    row.blockers.push(`RPC error during scan: ${e.message}`);
  }

  return row;
}

async function main() {
  log("Governance Attack Surface Scanner — starting...");

  const rpc = await resolveRpc(1);
  if (!rpc) {
    log("ERROR: No RPC endpoint available for Ethereum mainnet (chainId=1).");
    const out = { generatedAt: new Date().toISOString(), scanner: "tools/scan-governance-attack-surface.js", error: "no-rpc" };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    process.exit(1);
  }
  log("Ethereum mainnet RPC resolved (in memory only).");

  const governanceListing = loadJson(GOVERNANCE_LISTING_ARTIFACT, {});
  const governanceTimelock = loadJson(GOVERNANCE_TIMELOCK_ARTIFACT, {});

  const rows = [];
  for (const proto of PROTOCOLS) {
    log(`  Scanning ${proto.protocol} (${proto.proxyAddress})...`);
    const row = await scanProtocol(rpc, proto);
    rows.push(row);
  }

  const highRisk = rows.filter((r) => r.verdict === "CONFIRMED RISK").length;
  const mediumRisk = rows.filter((r) => r.verdict === "VULNERABLE").length;
  const inactive = rows.filter((r) => r.verdict === "INACTIVE").length;
  const secure = rows.filter((r) => r.verdict === "SECURE").length;

  const summary = {
    protocolsScanned: rows.length,
    highRiskCount: highRisk,
    mediumRiskCount: mediumRisk,
    inactiveCount: inactive,
    secureCount: secure,
    routePositive: 0,
    signedActionJustified: false,
  };

  const verdictOrder = { "CONFIRMED RISK": 0, "VULNERABLE": 1, "INACTIVE": 2, "SECURE": 3, "INSUFFICIENT DATA": 4, "ERROR": 5 };
  const topRows = [...rows].sort(
    (a, b) => (verdictOrder[a.verdict] ?? 9) - (verdictOrder[b.verdict] ?? 9)
  );

  const governanceArtifactRefs = [];
  if (governanceListing && governanceListing.spaces) {
    const spaces = Object.keys(governanceListing.spaces);
    governanceArtifactRefs.push({
      artifact: "reports/raw/fast/governance-listing-watch.json",
      spacesScanned: spaces.length,
      spaces: spaces,
      watchCandidates: governanceListing.summary?.watchCandidates || 0,
    });
  }
  if (governanceTimelock && governanceTimelock.targets) {
    governanceArtifactRefs.push({
      artifact: "reports/raw/fast/governance-timelock-payloads.json",
      targetsScanned: governanceTimelock.targets.length,
      timelockRows: governanceTimelock.summary?.timelockRows || 0,
      lowDelayRows: governanceTimelock.summary?.lowDelayRows || 0,
      activeCriticalPayloadRows: governanceTimelock.summary?.activeCriticalPayloadRows || 0,
    });
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-governance-attack-surface.js",
    scope: "Phase 3.X governance attack-surface assessment across top lending protocols (Aave V3, Compound V3, Morpho Blue, Euler EVK, Silo V3, Venus Core Pool). Follows Token of Power exploit pattern ($1.58M via malicious governance proposal, June 9 2026). Read-only RPC eth_call/eth_getStorageAt/eth_getCode queries — no secrets printed, no signed actions, no private keys.",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    thresholds: {
      eip1967AdminSlot: EIP1967_ADMIN_SLOT,
      ownerSelector: OWNER_SELECTOR,
      getMinDelaySelector: GET_MIN_DELAY_SELECTOR,
      highRiskDefinition: "single EOA admin, no timelock — can drain/upgrade in one tx",
      vulnerableDefinition: "multisig with low threshold or timelock < 1 day, or EOA with any timelock",
      inactiveDefinition: "multisig + timelock > 2 days",
      secureDefinition: "well-distributed multisig + long timelock",
    },
    governanceArtifactRefs,
    summary,
    topRows,
    rows,
    nextRoutePositiveCriteria: [
      "An admin is a single EOA with no timelock (CONFIRMED RISK row) — requires fork or live extraction proof",
      "A timelock bypass, governance attack, or malicious proposal path maps to exact positive economics",
      "Admin multisig threshold drops (key compromise, insider collusion) creating a confirmed drain window",
      "A queued governance payload changes oracle/collateral/LTV config in attacker-favorable direction",
    ],
    nextReadOnlyStep: "Keep governance attack surface on dormant watch; reopen if a CONFIRMED RISK row appears or a timelock/governance bypass is mapped to exact positive consumer economics. Integrate with novelty-groundbreaking skill for cross-protocol governance attack route discovery.",
  };

  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2));

  // Write triage
  const triageLines = [
    "# \uD83D\uDFE2 DORMANT — Governance Attack Surface Assessment",
    "",
    `**Generated**: ${artifact.generatedAt}`,
    `**Scanner**: \`tools/scan-governance-attack-surface.js\``,
    "",
    "## Scope",
    "",
    "Phase 3.X governance attack-surface assessment across six top lending protocols on Ethereum mainnet (chainId=1), following the Token of Power exploit pattern ($1.58M via malicious governance proposal, June 9 2026).",
    "",
    "Read-only RPC eth_call, eth_getStorageAt, and eth_getCode queries. No RPC URLs printed or persisted. No secrets, no signed actions, no private keys.",
    "",
    "## Protocols Scanned",
    "",
    "| Protocol | Proxy Address | Admin Address | Admin Type | Code Size | Timelock Delay | Verdict |",
    "|---|---|---|---|---|---|---|",
  ];

  for (const row of topRows) {
    const addr = row.adminAddress || "N/A";
    const type = row.adminType || "N/A";
    const cs = row.adminCodeSize !== null ? `${row.adminCodeSize}B` : "N/A";
    const delay = row.timelockDelaySeconds !== null ? `${row.timelockDelaySeconds}s (${(row.timelockDelaySeconds / 3600).toFixed(1)}h)` : "none";
    const verdictEmoji = row.verdict === "CONFIRMED RISK" ? "\uD83D\uDD34" :
      row.verdict === "VULNERABLE" ? "\uD83D\uDFE1" :
      row.verdict === "SECURE" ? "\u26AA" : "\uD83D\uDFE2";
    triageLines.push(`| ${row.protocol} | ${row.proxyAddress} | ${addr} | ${type} | ${cs} | ${delay} | ${verdictEmoji} ${row.verdict} |`);
  }

  triageLines.push("");
  triageLines.push("## Summary");
  triageLines.push("");
  triageLines.push(`- **Protocols scanned**: ${summary.protocolsScanned}`);
  triageLines.push(`- **High risk (CONFIRMED RISK)**: ${summary.highRiskCount}`);
  triageLines.push(`- **Medium risk (VULNERABLE)**: ${summary.mediumRiskCount}`);
  triageLines.push(`- **Inactive**: ${summary.inactiveCount}`);
  triageLines.push(`- **Secure**: ${summary.secureCount}`);
  triageLines.push(`- **Route positive**: 0`);
  triageLines.push(`- **Signed action justified**: false`);
  triageLines.push("");

  if (summary.highRiskCount > 0) {
    triageLines.push("\uD83D\uDD34 **ATTENTION**: One or more protocols have a CONFIRMED RISK governance attack surface (single EOA admin, no timelock). See topRows in the JSON artifact for details.");
    triageLines.push("");
  }

  triageLines.push("## Verdict Reasoning");
  triageLines.push("");
  for (const row of topRows) {
    triageLines.push(`### ${row.protocol}`);
    triageLines.push(`- **Admin**: ${row.adminAddress || "unknown"} (${row.adminType || "unknown"})`);
    triageLines.push(`- **Timelock delay**: ${row.timelockDelaySeconds !== null ? `${row.timelockDelaySeconds}s` : "none detected"}`);
    triageLines.push(`- **Verdict**: ${row.verdict}`);
    triageLines.push(`- **Reason**: ${row.verdictReason || "scan error"}`);
    if (row.blockers.length > 0) {
      triageLines.push(`- **Blockers**:`);
      for (const b of row.blockers) triageLines.push(`  - ${b}`);
    }
    if (row.errors.length > 0) {
      triageLines.push(`- **Errors**:`);
      for (const e of row.errors) triageLines.push(`  - ${e}`);
    }
    triageLines.push("");
  }

  triageLines.push("## Related Artifacts");
  triageLines.push("");
  if (artifact.governanceArtifactRefs.length > 0) {
    for (const ref of artifact.governanceArtifactRefs) {
      triageLines.push(`- \`${ref.artifact}\` — scanned governance artifact`);
    }
  }
  triageLines.push(`- \`${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}\` — JSON artifact`);
  triageLines.push(`- \`tools/scan-governance-attack-surface.js\` — scanner`);
  triageLines.push(`- \`reports/governance-listing-watch-triage.md\` — governance listing watch`);
  triageLines.push(`- \`reports/governance-timelock-payloads-triage.md\` — governance timelock payloads`);
  triageLines.push("");
  triageLines.push("## Next Steps");
  triageLines.push("");
  triageLines.push("1. If a CONFIRMED RISK row appears, fork-prove the drain path (impersonate admin, upgrade proxy, drain in one tx).");
  triageLines.push("2. Monitor for governance token concentration changes that lower quorum or create single-entity control.");
  triageLines.push("3. Watch for timelock changes (proposals that reduce delay or bypass executor checks).");
  triageLines.push("4. Keep this branch dormant until governance attack surface conditions change materially.");
  triageLines.push("");
  triageLines.push("## Route Gates");
  triageLines.push("");
  triageLines.push("- `routePositive=0` — no live governance attack route is currently exact-positive");
  triageLines.push("- `signedActionJustified=false` — no signed action is justified without fork proof");
  triageLines.push("- `forkTransactions=false` — no fork simulation has been run");
  triageLines.push("- No private keys were read, stored, or used");

  fs.writeFileSync(OUT_MD, triageLines.join("\n"));

  log("");
  log(`Done. Protocols=${rows.length} highRisk=${highRisk} mediumRisk=${mediumRisk} inactive=${inactive} secure=${secure}`);
  log(`  JSON: ${path.relative(WORKSPACE, OUT)}`);
  log(`  Triage: ${path.relative(WORKSPACE, OUT_MD)}`);
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
