#!/usr/bin/env node
// scan-dex-hook-source-gating.js
//
// Focused fail-closed source/callback/value-path gate for the two high-signal
// Uniswap V4/ERC4626 hook rows. This scanner is local-artifact only: it does
// not read RPC inventories, .env files, endpoint lists, keys, or send/fork txs.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const QUIET = process.argv.includes("--quiet");

const INPUT_CFG = path.join(WORKSPACE, "reports", "raw", "fast", "dex-hook-callback-cfg.json");
const OUTPUT = path.join(WORKSPACE, "reports", "raw", "fast", "dex-hook-source-gating.json");
const OUTPUT_TRIAGE = path.join(WORKSPACE, "reports", "dex-hook-source-gating-triage.md");

const FOCUS_HOOKS = [
  "0x3fb49f96338b22cadd9614a51633189d4ce21088",
  "0x3e2e24225cc1b3771677c84afc00a63c470ec088",
];

const SOURCE_LOOKUP = {
  "0x3fb49f96338b22cadd9614a51633189d4ce21088": {
    blockscoutV2: "bytecode-only-no-verified-source-fields",
    sourcify: "unavailable-or-no-match-503-at-lookup-time",
    etherscan: "v1-deprecated-no-source-returned-without-v2-key",
    verifiedSource: false,
    decompileAvailable: false,
    proxyType: null,
    implementations: [],
    creationStatus: "success",
    observedBytecodeSize: 14739,
  },
  "0x3e2e24225cc1b3771677c84afc00a63c470ec088": {
    blockscoutV2: "bytecode-only-no-verified-source-fields",
    sourcify: "unavailable-or-no-match-503-at-lookup-time",
    etherscan: "v1-deprecated-no-source-returned-without-v2-key",
    verifiedSource: false,
    decompileAvailable: false,
    proxyType: null,
    implementations: [],
    creationStatus: "success",
    observedBytecodeSize: 16903,
  },
};

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing input artifact: ${path.relative(WORKSPACE, filePath)}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function boolCount(rows, predicate) {
  return rows.filter(predicate).length;
}

function compactTarget(row) {
  const evidence = row.callFlow?.erc4626OverlapEvidence || null;
  if (!evidence) return [];
  return [
    evidence.vault
      ? {
          kind: "erc4626-vault-pool-currency",
          address: evidence.vault,
          symbol: evidence.erc4626?.symbol || null,
          name: evidence.erc4626?.name || null,
          totalAssets: evidence.erc4626?.totalAssets ?? null,
          blocker: "Vault is observed as a V4 pool currency, not proven as a callback-reached value-moving target.",
        }
      : null,
    evidence.erc4626?.asset
      ? {
          kind: "erc4626-underlying-asset",
          address: evidence.erc4626.asset,
          symbol: evidence.erc4626.assetSymbol || null,
          blocker: "Underlying asset context only; no callback-reached receiver/value flow is proven.",
        }
      : null,
  ].filter(Boolean);
}

function sourceAnswer(row, lookup) {
  const callbackEntrypoints = safeArray(row.callFlow?.callbackEntrypoints);
  const selectorClasses = safeArray(row.callFlow?.selectorClasses);
  const externalValueSelectorClasses = safeArray(row.callFlow?.externalValueSelectorClasses);
  const routeGate = row.callFlow?.routePositionalGates || {};
  const evidence = row.callFlow?.erc4626OverlapEvidence || null;
  const blockers = [
    "Blockscout v2 payload was bytecode-only; no verified source, contract name, compiler metadata, ABI, modifiers, or callback bodies were available.",
    "No source-level onlyPoolManager/msg.sender/lock/NoSelfCall proof is available.",
    "ERC4626 selectors are bytecode selectors only; callback reachability is unproven.",
    "Observed ERC4626 vault is a V4 pool currency context, not the initialized hook or a proven callback-reached external target.",
    "Attacker-created pool/currency reachability remains static-only/unproven.",
    "No exact receiver/value flow, exact-positive economics, or fork/local value-delta proof exists.",
  ];

  return {
    hookAddress: row.hookAddress,
    protocol: row.protocol,
    chain: row.chain,
    chainId: row.chainId,
    codeSize: row.codeSize,
    sourceLookup: lookup,
    verifiedSourceAvailable: lookup.verifiedSource === true,
    decompileAvailable: lookup.decompileAvailable === true,
    callbackFunctionsPresent: callbackEntrypoints,
    callbackFunctionsSourceVerified: false,
    poolManagerBinding: row.callFlow?.poolManagerBinding || "unknown",
    msgSenderOrPoolManagerGate: "unproven-source-unavailable",
    permissionlessCallbackProof: false,
    erc4626SelectorClassesPresent: selectorClasses.includes("erc4626ShareFlow"),
    externalValueSelectorClasses,
    erc4626SelectorsReachableFromCallbacks: false,
    deployedValueMovingTargetProof: false,
    deployedValuePath: row.callFlow?.deployedValuePath || "unknown",
    externalValueTargets: compactTarget(row),
    erc4626OverlapEvidence: evidence
      ? {
          currenciesIncludeVault: evidence.currenciesIncludeVault === true,
          currenciesIncludeAsset: evidence.currenciesIncludeAsset === true,
          vaultIsActualHook: evidence.vaultIsActualHook === true,
          artifactLikelyCurrencyMisclassifiedAsHook: evidence.artifactLikelyCurrencyMisclassifiedAsHook === true,
          initializePoolCount: evidence.initializePoolCount || 0,
          recentSwaps: evidence.recentSwaps || 0,
          recentDonates: evidence.recentDonates || 0,
          blockers: safeArray(evidence.blockers),
        }
      : null,
    attackerCreatedPoolOrCurrencyAllowed: "unproven-static-only",
    exactReceiverValueFlow: "unproven",
    exactEconomicsRows: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    routePositionalGates: {
      callbackBound: routeGate.callbackBound === true,
      permissionlessCallbackProof: false,
      msgSenderGateProof: "unknown",
      attackerPoolCreationReachability: row.callFlow?.attackerPoolCreationReachability || "unknown",
      externalValueMovingSelectorEvidence: routeGate.externalValueMovingSelectorEvidence === true,
      deployedValueMovingTargetProof: false,
      exactPositiveEconomics: false,
      forkOrLocalProof: false,
    },
    blockers,
  };
}

function summarize(rows) {
  return {
    hooksReviewed: rows.length,
    sourceVerifiedRows: boolCount(rows, (r) => r.verifiedSourceAvailable),
    bytecodeOnlyRows: boolCount(rows, (r) => !r.verifiedSourceAvailable),
    decompileAvailableRows: boolCount(rows, (r) => r.decompileAvailable),
    callbackFunctionRows: boolCount(rows, (r) => r.callbackFunctionsPresent.length > 0),
    erc4626SelectorRows: boolCount(rows, (r) => r.erc4626SelectorClassesPresent),
    erc4626CallbackReachableRows: boolCount(rows, (r) => r.erc4626SelectorsReachableFromCallbacks),
    msgSenderGateProvenRows: boolCount(rows, (r) => r.msgSenderOrPoolManagerGate === "proven"),
    deployedValueTargetProofRows: boolCount(rows, (r) => r.deployedValueMovingTargetProof),
    attackerPoolCurrencyAllowedRows: boolCount(rows, (r) => r.attackerCreatedPoolOrCurrencyAllowed === "proven"),
    exactReceiverValueFlowRows: boolCount(rows, (r) => r.exactReceiverValueFlow === "proven"),
    exactEconomicsRows: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    status: "source-gated-blocked-no-route-positive",
  };
}

function writeReport(artifact) {
  const lines = [];
  lines.push("# 🟢 DORMANT - DEX Hook Source-Gating Triage");
  lines.push("");
  lines.push(`Generated: ${artifact.generatedAt}`);
  lines.push(`Scanner: ${artifact.scanner}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  for (const [key, value] of Object.entries(artifact.summary)) {
    lines.push(`| ${key} | ${value} |`);
  }
  lines.push("");
  lines.push("## Source-gating answers");
  lines.push("");
  lines.push("| Hook | Verified source/decompile | Callbacks present | ERC4626 reachable from callbacks | msg.sender/PoolManager gate | Attacker pool/currency allowed | Value target proof | routePositive |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | ---: |");
  for (const row of artifact.hooks) {
    const source = row.verifiedSourceAvailable || row.decompileAvailable ? "yes" : "no";
    lines.push(
      `| \`${row.hookAddress}\` | ${source} | ${row.callbackFunctionsPresent.join(", ") || "unknown"} | ${row.erc4626SelectorsReachableFromCallbacks ? "yes" : "no"} | ${row.msgSenderOrPoolManagerGate} | ${row.attackerCreatedPoolOrCurrencyAllowed} | ${row.deployedValueMovingTargetProof ? "yes" : "no"} | ${row.routePositive} |`,
    );
  }
  lines.push("");
  lines.push("## Per-hook blockers");
  for (const row of artifact.hooks) {
    lines.push("");
    lines.push(`### ${row.hookAddress}`);
    lines.push(`- Source lookup: ${row.sourceLookup.blockscoutV2}; proxy=${row.sourceLookup.proxyType || "none"}; implementations=${row.sourceLookup.implementations.length}.`);
    lines.push(`- PoolManager binding: ${row.poolManagerBinding}.`);
    if (row.externalValueTargets.length) {
      for (const target of row.externalValueTargets) {
        lines.push(`- Context target: ${target.kind} \`${target.address}\`${target.symbol ? ` (${target.symbol})` : ""}; ${target.blocker}`);
      }
    }
    for (const blocker of row.blockers) lines.push(`- ${blocker}`);
  }
  lines.push("");
  lines.push("## Gate conclusion");
  lines.push("");
  lines.push("Both hooks remain source-gated and route-negative. Do not fork or prepare executor/signed-action work unless verified source/decompile or a bounded trace proves callback-reachable value movement plus exact-positive economics.");

  fs.mkdirSync(path.dirname(OUTPUT_TRIAGE), { recursive: true });
  fs.writeFileSync(OUTPUT_TRIAGE, `${lines.join("\n")}\n`);
}

function main() {
  const cfg = loadJson(INPUT_CFG);
  const allRows = safeArray(cfg.allRows);
  const hooks = FOCUS_HOOKS.map((hookAddress) => {
    const row = allRows.find((r) => String(r.hookAddress || "").toLowerCase() === hookAddress);
    if (!row) throw new Error(`Focus hook missing from CFG artifact: ${hookAddress}`);
    return sourceAnswer(row, SOURCE_LOOKUP[hookAddress]);
  });

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-dex-hook-source-gating.js",
    scope: "Local-artifact source/callback/value-path gate for two Uniswap V4 ERC4626 hook rows; no RPC/env/secret reads",
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
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    sourceArtifacts: [
      "reports/raw/fast/dex-hook-callback-cfg.json",
      "reports/dex-hook-callback-cfg-triage.md",
      "external-readonly-blockscout-v2-smart-contract-payloads-bytecode-only-parsed-by-explorer",
    ],
    lookupCaveats: [
      "Blockscout v2 payloads were parsed from saved tool output and contained no verified-source fields.",
      "Sourcify returned unavailable/503 during lookup; this is recorded as source-unavailable, not as a semantic proof of safety.",
      "No endpoint inventory, RPC URL, .env, private key, signer, transaction, or fork path was used.",
    ],
    summary: summarize(hooks),
    hooks,
    topRows: hooks.map((row) => ({
      protocol: row.protocol,
      chain: row.chain,
      hookAddress: row.hookAddress,
      codeSize: row.codeSize,
      sourceStatus: row.verifiedSourceAvailable ? "verified" : "bytecode-only-unverified",
      callbackEntrypoints: row.callbackFunctionsPresent,
      selectorClasses: row.externalValueSelectorClasses,
      routePositive: false,
      blocker: row.blockers[0],
    })),
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(artifact, null, 2)}\n`);
  writeReport(artifact);

  if (!QUIET) {
    console.log(JSON.stringify({ ok: true, output: path.relative(WORKSPACE, OUTPUT), summary: artifact.summary }, null, 2));
  }
}

main();
