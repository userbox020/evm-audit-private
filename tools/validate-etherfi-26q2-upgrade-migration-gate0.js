"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const HEAD_ROOT = path.join(ROOT, "targets", "etherfi-smart-contracts-1d3eba9");
const BASE_ROOT = path.join(ROOT, "targets", "etherfi-smart-contracts-preupgrade-a816695");
const L1_ROOT = path.join(ROOT, "targets", "etherfi-weeth-cross-chain-pr77");
const L1_BASE_ROOT = path.join(ROOT, "targets", "etherfi-weeth-cross-chain-pre77-cc6c220");
const AVS_ROOT = path.join(ROOT, "targets", "etherfi-avs-smart-contracts-security-upgrade");
const AVS_BASE_ROOT = path.join(ROOT, "targets", "etherfi-avs-smart-contracts-preupgrade-50b2217");
const OUT_DIR = path.join(ROOT, "reports", "raw", "fast", "etherfi-26q2-upgrade-migration-gate0");
const OUT = path.join(OUT_DIR, "source-build-storage.json");

const EXPECTED = Object.freeze({
  head: "1d3eba9fe43799e62ad6a491a105f734a85a7a18",
  headTree: "2262b42b979a26b34c4700035441ac5d970b7e26",
  parent: "fe899e7878f7971af049204ba3a03f9bca8fccb5",
  mergeBase: "a816695891126b56d0cbe81d5b139ec2a5ccdd89",
  mergeBaseTree: "4123d68e8b731612aa793f30b39bb0cbb9801e02",
  releaseCommitDeclaredByScripts: "0f1e8d966c85bcd3b352d94da15fe2eae61f897c",
  l1Release: "c6997994314a62143a923fdd61c9a11b068d8092",
  l1PreUpgrade: "cc6c220847217df8f9dcc4ba19c1c349106a002c",
  avsRelease: "c40319be0ede648041130376608b39fca11c6ecd",
  avsPreUpgrade: "50b221736873a75ed03cebde884aa8cf519cf3cc",
  solc: "0.8.27",
  optimizerRuns: 1500,
  bytecodeHash: "none",
  foundry: "1.5.1-stable",
});

// The 23 UUPS proxies returned by transactions.s.sol::_upgradedProxies().
const CONTRACTS = Object.freeze([
  "EETH", "LiquidityPool", "WeETH", "DepositAdapter", "Liquifier",
  "EtherFiRateLimiter", "MembershipManager", "MembershipNFT", "EtherFiAdmin",
  "EtherFiOracle", "EtherFiRestaker", "RestakingRewardsRouter",
  "CumulativeMerkleRewardsDistributor", "EtherFiRewardsRouter", "AuctionManager",
  "EtherFiNodesManager", "NodeOperatorManager", "StakingManager",
  "EtherFiRedemptionManager", "PriorityWithdrawalQueue", "WeETHWithdrawAdapter",
  "WithdrawRequestNFT", "RoleRegistry",
]);

const OTHER_SURFACES = Object.freeze([
  { contract: "EtherFiNode", kind: "BEACON_IMPLEMENTATION", beforeRoot: BASE_ROOT, afterRoot: HEAD_ROOT },
  { contract: "EtherfiL1SyncPoolETH", kind: "EXTERNAL_TRANSPARENT_PROXY", beforeRoot: L1_BASE_ROOT, afterRoot: L1_ROOT },
  { contract: "AvsOperatorManager", kind: "EXTERNAL_UUPS_PROXY", beforeRoot: AVS_BASE_ROOT, afterRoot: AVS_ROOT },
]);

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function run(file, args, cwd) {
  const r = cp.spawnSync(file, args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`${file} ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  return (r.stdout || "").trim();
}

function git(root, ...args) {
  return run("git", args, root);
}

function findArtifact(root, name) {
  const p = path.join(root, "out", `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(p)) throw new Error(`missing artifact ${p}`);
  return p;
}

function readArtifact(root, name) {
  const file = findArtifact(root, name);
  const raw = fs.readFileSync(file);
  const json = JSON.parse(raw.toString("utf8"));
  if (!json.storageLayout || !Array.isArray(json.storageLayout.storage)) {
    throw new Error(`artifact lacks storage layout: ${file}`);
  }
  return { file, raw, json };
}

function typeFingerprint(typeId, types, seen = new Set()) {
  const t = types[typeId];
  if (!t) return `missing:${typeId}`;
  if (seen.has(typeId)) return `recursive:${t.label || typeId}`;
  const next = new Set(seen);
  next.add(typeId);
  const members = (t.members || []).map((m) => ({
    label: m.label,
    slot: String(m.slot),
    offset: Number(m.offset),
    type: typeFingerprint(m.type, types, next),
  }));
  let normalizedLabel = t.label;
  if (t.encoding === "mapping") normalizedLabel = "mapping";
  else if ((t.members || []).length > 0 && /^struct /u.test(t.label || "")) normalizedLabel = "struct";
  else if (/^contract /u.test(t.label || "")) normalizedLabel = "address";
  return JSON.stringify({
    encoding: t.encoding,
    label: normalizedLabel,
    numberOfBytes: String(t.numberOfBytes),
    base: t.base ? typeFingerprint(t.base, types, next) : null,
    key: t.key ? typeFingerprint(t.key, types, next) : null,
    value: t.value ? typeFingerprint(t.value, types, next) : null,
    members,
  });
}

function normalizeLayout(layout) {
  return layout.storage.map((s) => {
    const t = layout.types[s.type];
    const bytes = Number(t.numberOfBytes);
    const start = BigInt(s.slot) * 32n + BigInt(s.offset);
    return {
      astId: s.astId,
      contract: s.contract,
      label: s.label,
      slot: String(s.slot),
      offset: Number(s.offset),
      bytes,
      start: start.toString(),
      endExclusive: (start + BigInt(bytes)).toString(),
      typeLabel: t.label,
      typeFingerprint: typeFingerprint(s.type, layout.types),
    };
  });
}

function overlaps(a, b) {
  return BigInt(a.start) < BigInt(b.endExclusive) && BigInt(b.start) < BigInt(a.endExclusive);
}

function isGap(label) {
  return /(^|_)gap($|_)/i.test(label) || /deprecated/i.test(label);
}

function compareLayouts(oldLayout, newLayout) {
  const oldRows = normalizeLayout(oldLayout);
  const newRows = normalizeLayout(newLayout);
  const preservation = [];
  const collisionCandidates = [];

  for (const oldRow of oldRows) {
    const hits = newRows.filter((n) => overlaps(oldRow, n));
    const exact = hits.find((n) => n.start === oldRow.start && n.endExclusive === oldRow.endExclusive);
    let disposition;
    if (exact && exact.label === oldRow.label && exact.typeFingerprint === oldRow.typeFingerprint) {
      disposition = "EXACT_PRESERVED";
    } else if (hits.length > 0 && hits.every((n) => isGap(n.label))) {
      disposition = "DEPRECATED_TO_GAP_REVIEW";
    } else if (isGap(oldRow.label)) {
      disposition = "OLD_GAP_REUSED_REVIEW";
    } else if (exact && exact.typeFingerprint === oldRow.typeFingerprint) {
      disposition = "RENAMED_SAME_TYPE_REVIEW";
    } else {
      disposition = "COLLISION_CANDIDATE";
      collisionCandidates.push({ old: oldRow, overlaps: hits });
    }
    preservation.push({ old: oldRow, overlaps: hits, disposition });
  }

  const newOnly = newRows.filter((n) => !oldRows.some((o) => overlaps(o, n)));
  return {
    oldEntryCount: oldRows.length,
    newEntryCount: newRows.length,
    dispositions: preservation.reduce((a, r) => {
      a[r.disposition] = (a[r.disposition] || 0) + 1;
      return a;
    }, {}),
    collisionCandidateCount: collisionCandidates.length,
    collisionCandidates,
    newNonOverlappingEntries: newOnly,
    preservation,
  };
}

function settingsFromArtifact(a) {
  const m = typeof a.json.metadata === "string" ? JSON.parse(a.json.metadata) : (a.json.metadata || null);
  return {
    compilerVersion: m?.compiler?.version || null,
    optimizer: m?.settings?.optimizer || null,
    evmVersion: m?.settings?.evmVersion || null,
    metadata: m?.settings?.metadata || null,
    viaIR: m?.settings?.viaIR ?? false,
  };
}

function treeState(root) {
  const head = git(root, "rev-parse", "HEAD");
  const tree = git(root, "rev-parse", "HEAD^{tree}");
  const status = git(root, "status", "--porcelain");
  const subs = git(root, "submodule", "status", "--recursive").split(/\r?\n/u).filter(Boolean).map((line) => {
    const clean = line.trim();
    const [commit, subPath] = clean.replace(/^[-+ U]/u, "").split(/\s+/u);
    return { path: subPath, commit, initializedClean: !/^[-+U]/u.test(line) };
  });
  return { head, tree, clean: status.length === 0, submodules: subs };
}

function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const headState = treeState(HEAD_ROOT);
  const baseState = treeState(BASE_ROOT);
  const l1State = treeState(L1_ROOT);
  const l1BaseState = treeState(L1_BASE_ROOT);
  const avsState = treeState(AVS_ROOT);
  const avsBaseState = treeState(AVS_BASE_ROOT);
  const forgeVersion = run("forge", ["--version"], HEAD_ROOT).split(/\r?\n/u)[0];
  const rows = [];
  for (const name of CONTRACTS) {
    const before = readArtifact(BASE_ROOT, name);
    const after = readArtifact(HEAD_ROOT, name);
    rows.push({
      contract: name,
      kind: "LOCAL_UUPS_PROXY",
      beforeArtifact: path.relative(ROOT, before.file).replace(/\\/gu, "/"),
      afterArtifact: path.relative(ROOT, after.file).replace(/\\/gu, "/"),
      beforeArtifactSha256: sha256(before.raw),
      afterArtifactSha256: sha256(after.raw),
      beforeSettings: settingsFromArtifact(before),
      afterSettings: settingsFromArtifact(after),
      layout: compareLayouts(before.json.storageLayout, after.json.storageLayout),
    });
  }
  for (const surface of OTHER_SURFACES) {
    const before = readArtifact(surface.beforeRoot, surface.contract);
    const after = readArtifact(surface.afterRoot, surface.contract);
    rows.push({
      contract: surface.contract,
      kind: surface.kind,
      beforeArtifact: path.relative(ROOT, before.file).replace(/\\/gu, "/"),
      afterArtifact: path.relative(ROOT, after.file).replace(/\\/gu, "/"),
      beforeArtifactSha256: sha256(before.raw),
      afterArtifactSha256: sha256(after.raw),
      beforeSettings: settingsFromArtifact(before),
      afterSettings: settingsFromArtifact(after),
      layout: compareLayouts(before.json.storageLayout, after.json.storageLayout),
    });
  }

  const output = {
    schemaVersion: "etherfi-26q2-gate0-source-build-storage/v1",
    generatedAt: new Date().toISOString(),
    claimId: "critical/etherfi-26q2-upgrade-migration-gate0",
    expected: EXPECTED,
    source: {
      head: headState,
      preUpgradeMergeBase: baseState,
      l1SyncPoolRelease: l1State,
      l1SyncPoolPreUpgrade: l1BaseState,
      avsRelease: avsState,
      avsPreUpgrade: avsBaseState,
    },
    toolchain: { forgeVersion },
    upgradedProxyCountInOfficialScript: CONTRACTS.length,
    additionalUpgradeSurfaces: OTHER_SURFACES.length,
    contracts: rows,
    summary: {
      contractsCompared: rows.length,
      rawCollisionCandidateCount: rows.reduce((n, r) => n + r.layout.collisionCandidateCount, 0),
      localArtifactsCompilerPinned: rows.filter((r) => r.kind === "LOCAL_UUPS_PROXY" || r.kind === "BEACON_IMPLEMENTATION").every((r) =>
        r.beforeSettings.compilerVersion?.startsWith(`${EXPECTED.solc}+`) &&
        r.afterSettings.compilerVersion?.startsWith(`${EXPECTED.solc}+`)),
      allOptimizerProfilesMatchDeclared: rows.every((r) => {
        const runs = r.kind === "LOCAL_UUPS_PROXY" || r.kind === "BEACON_IMPLEMENTATION" ? 1500 : 200;
        return r.beforeSettings.optimizer?.runs === runs && r.afterSettings.optimizer?.runs === runs;
      }),
      sourceCheckoutsClean: headState.clean && baseState.clean && l1State.clean && l1BaseState.clean && avsState.clean && avsBaseState.clean,
      commitPinsMatch: headState.head === EXPECTED.head && headState.tree === EXPECTED.headTree &&
        baseState.head === EXPECTED.mergeBase && baseState.tree === EXPECTED.mergeBaseTree &&
        l1State.head === EXPECTED.l1Release && l1BaseState.head === EXPECTED.l1PreUpgrade &&
        avsState.head === EXPECTED.avsRelease && avsBaseState.head === EXPECTED.avsPreUpgrade,
      adjudicationRequired: true,
      status: "RAW_LAYOUT_COMPARISON_REQUIRES_ADJUDICATION_AND_RUNTIME_BINDING",
    },
    limitations: [
      "A raw overlap candidate is not itself a storage collision; intentional deprecated-gap replacements require source adjudication.",
      "This file covers the 23 UUPS proxies in _upgradedProxies(), the EtherFiNode beacon implementation, and the external AVS/L1 Sync Pool upgrade surfaces.",
      "The L1 Sync Pool package.json has no lockfile and uses semver ranges plus an unpinned Solady Git dependency; the currently resolved dependency tree is not accepted as deployment provenance until exact runtime equivalence is independently established.",
      "No RPC, fork, transaction, signing, broadcast, deployment, or production mutation is performed by this validator.",
    ],
  };
  fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, output: path.relative(ROOT, OUT).replace(/\\/gu, "/"), summary: output.summary })}\n`);
}

main();
