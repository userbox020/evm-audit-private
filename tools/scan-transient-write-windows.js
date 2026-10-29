#!/usr/bin/env node
"use strict";

// scan-transient-write-windows.js — bounded OFFLINE static sweep for N1:
// tx-scoped transient / route-registry overwrite across frames & callbacks.
//
// THESIS (intent-preserving):
//   EIP-1153 transient storage and "preset calldata in transient state" route
//   registries live for the WHOLE transaction and are keyed by a contract-global
//   slot, not by caller. The interesting class is a SET -> CALLBACK -> USE window:
//   code A writes a transient/registry slot, control then crosses an untrusted
//   external call frame, and code B reads that slot believing it wrote it. A
//   permissionless setter is only interesting when a reader executes across an
//   attacker-influenced frame in the same transaction (or the same atomic
//   bundle/multicall). A permissioned setter, an internal-only writer, or a
//   simple reentrancy guard (write-then-read with no cross-frame reuse) is
//   classified and noted, NOT flagged.
//
// SCOPE / SAFETY:
//   * Default (and only) mode is fully OFFLINE: reads local Solidity sources
//     only. No network, no sockets, no signing, no broadcast, no fork.
//   * Never touches .env*, *.key, *-keypair.json or any wallet material.
//   * Claimed resource: tools/scan-transient-write-windows.js (new file); it
//     reads shared reports/ targets but never edits another tool.
//
// FAIL-CLOSED: a family whose sources are absent (or that carries no matching
// idiom) is recorded as a MISS gap row, never silently dropped. Exit code is
// ALWAYS 0 (a sweep that cannot read a family is not a scan error).
//
// Usage:
//   node tools/scan-transient-write-windows.js
//   node tools/scan-transient-write-windows.js --quiet

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_DIR = path.join(WORKSPACE, "reports", "raw", "fast", "transient-write-windows");
const OUT = path.join(OUT_DIR, "r1.json");
const QUIET = process.argv.includes("--quiet");

const EXCLUDE_DIRS = new Set([
  "node_modules", "out", "cache", ".git", "broadcast", "artifacts",
  "typechain-types", "coverage", "forge-std", "permit2", "solady",
  "solidity-bytes-utils", "account-abstraction",
]);

// Bounded checkout families. `expectTransient` documents the working hypothesis
// so a MISS is legible (expected-absent vs unexpectedly-absent).
const FAMILIES = [
  {
    id: "hyperlend-looping",
    root: "targets/hyperlend-looping/contracts",
    expectTransient: true,
    note: "GluexAdapter presets raw GlueX router calldata in transient slots (preset-in-tx pattern); Looping whitelists swappers.",
  },
  {
    id: "euler-v4-periphery",
    root: "targets/euler-swap-eulerswap-2.0-81cf6dc98846/lib/v4-periphery",
    expectTransient: true,
    note: "Locker library (v4 flash-accounting lock) + PositionManager transient lock usage.",
  },
  {
    id: "derive-v2-core",
    root: "targets/derive-v2-core",
    expectTransient: true,
    note: "OZ TransientSlot / ERC20TemporaryApproval (ERC-7674) + ReentrancyGuardTransientUpgradeable.",
  },
  {
    id: "fluid-contracts-public",
    root: "targets/fluid-contracts-public",
    expectTransient: true,
    note: "ReentrancyLock library (tstore/tload) + wallet transient allow-hash.",
  },
  { id: "morpho-blue", root: "targets/morpho-blue", expectTransient: false, note: "Morpho Blue: no EIP-1153 transient usage expected." },
  {
    id: "euler-evc",
    root: "targets/euler-evc",
    expectTransient: true,
    note: "EthereumVaultConnector TransientStorage (per-tx status checks / controller isolation) — EXPECTED safe.",
  },
  {
    id: "euler-evk-evc-lib",
    root: "targets/euler-evk/lib/ethereum-vault-connector",
    expectTransient: true,
    note: "Same EVC TransientStorage vendored under euler-evk (task aliases it as euler-evk/evc) — EXPECTED safe.",
  },
  { id: "stargate-v2", root: "targets/stargate-v2", expectTransient: false, note: "Stargate v2: no EIP-1153 transient usage expected." },
  { id: "debridge-contracts-v1", root: "targets/debridge-contracts-v1", expectTransient: false, note: "deBridge v1: no EIP-1153 transient usage expected." },
];

const LIMITS = { filesPerFamily: 6000, hitsPerFamily: 60 };

// --- idiom detectors ----------------------------------------------------------------------
const TRANSIENT_IDIOMS = [
  { re: /(?:^|[^A-Za-z0-9_])tstore\s*\(/, idiom: "inline-yul-tstore" },
  { re: /(?:^|[^A-Za-z0-9_])tload\s*\(/, idiom: "inline-yul-tload" },
  { re: /TransientSlot|SlotDerivation/, idiom: "oz-transient-slot-lib" },
  { re: /TemporaryApproval|temporaryApprove|_temporaryAllowance/, idiom: "erc7674-temporary-approval" },
  { re: /_transientAllowHash|_resetTransientStorage/, idiom: "transient-allow-hash" },
  { re: /TransientStorage|LOCKED_BY_SLOT|REENTRANCY_LOCK_SLOT|ReentrancyGuardTransient/, idiom: "transient-lib/guard" },
];

// Route-registry (non-transient but same tx-scoped-overwrite class).
const ROUTE_IDIOMS = [
  { re: /function\s+setSwapPath\s*\(/, idiom: "route-registry-writer(raw-calldata-preset)" },
  { re: /\.call\s*\(\s*gluexCallData\s*\)|\.call\s*\(\s*[A-Za-z_]*[Cc]all[Dd]ata\s*\)/, idiom: "raw-external-call(arbitrary-calldata)" },
  { re: /swappers\s*\[|swapper not allowed/, idiom: "whitelisted-swapper-gate" },
  { re: /_loadSwapData|getSwapRoute/, idiom: "route-registry-reader" },
];

const LOW_LEVEL_CALL = /\.(?:call|delegatecall|staticcall)\s*[\({]/;
const ACCESS_GATE = /\bonly[A-Z]\w*|\bonlyOwner\b|\binitializer\b|require\s*\(\s*msg\.sender\s*[=!]=|\bonlyRole\b/;

// --- helpers ------------------------------------------------------------------------------
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function rel(p) { return path.relative(WORKSPACE, p).replace(/\\/g, "/"); }

function walkSol(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      walkSol(path.join(dir, e.name), acc);
    } else if (e.isFile() && e.name.endsWith(".sol")) {
      acc.push(path.join(dir, e.name));
    }
    if (acc.length >= LIMITS.filesPerFamily) break;
  }
  return acc;
}

// Find the enclosing function signature for a 1-based line.
function enclosingSignature(lines, lineIndex) {
  for (let i = lineIndex; i >= 0 && i > lineIndex - 80; i--) {
    const m = /(^|\s)(function\s+\w+|constructor|modifier\s+\w+)\b/.exec(lines[i]);
    if (!m) continue;
    let sig = "";
    for (let j = i; j < lines.length && j < i + 12; j++) {
      sig += ` ${lines[j]}`;
      if (/\{/.test(lines[j]) || /;/.test(lines[j])) break;
    }
    return { line: i + 1, text: sig.replace(/\s+/g, " ").trim() };
  }
  return { line: null, text: "" };
}

function classifyWriteAccess(sig, bodyPrefix) {
  const hay = `${sig} ${bodyPrefix}`;
  const visibility = /\b(private|internal)\b/.test(sig) ? "internal"
    : /\b(external|public)\b/.test(sig) ? "external"
    : "unknown";
  const gated = ACCESS_GATE.test(hay);
  if (visibility === "internal") return gated ? "internal-only-gated" : "internal-only";
  if (visibility === "unknown") return gated ? "permissioned-setter" : "unknown";
  return gated ? "permissioned-setter" : "permissionless-writer";
}

function classifyWindow({ relFile, fileHasLowLevelCall, writeAccess, idiom, famId }) {
  if (/LOCKED_BY_SLOT|REENTRANCY_LOCK_SLOT|ReentrancyGuardTransient|reentrancyLock/.test(relFile)) return "guard-only";
  if (idiom === "erc7674-temporary-approval" || /TemporaryApproval/.test(relFile)) return "allowance-scope";
  if (famId === "euler-evc" || famId === "euler-evk-evc-lib" || /TransientStorage/.test(relFile)) return "framework-transient-status";
  if (writeAccess === "permissionless-writer" && fileHasLowLevelCall) return "SET->CALLBACK->USE-candidate";
  if (writeAccess === "permissionless-writer") return "permissionless-write-same-frame";
  if (writeAccess === "permissioned-setter" && fileHasLowLevelCall) return "permissioned-set-call-use";
  return "unclassified";
}

function note(idiom, writeAccess, windowClass) {
  const notes = {
    "SET->CALLBACK->USE-candidate": "permissionless (or un-gated) writer + low-level external call in the same contract: a reader of the same slot in a later/foreign frame would consume attacker-planted state. Verify caller scoping of both the writer and the reader.",
    "permissionless-write-same-frame": "permissionless writer with no low-level call in this file; likely a single-frame register. ESCALATE only if another contract/frame reads the same slot in the same tx.",
    "permissioned-set-call-use": "permissioned setter + external call: cross-frame reuse possible only by the trusted setter; low priority unless the reader is permissionless.",
    "guard-only": "reentrancy/accounting lock written then read then cleared; transient lifetime is the intended invariant — classify, do not flag.",
    "allowance-scope": "ERC-7674 temporary allowance: transient by design, consumed in _spendAllowance; the value is never trusted across an untrusted frame for authorization beyond the declared spender.",
    "framework-transient-status": "EVC per-transaction status/controller isolation; cleared at tx end and re-checked by the EVC itself — EXPECTED safe (recorded as classification, not a finding).",
    unclassified: "no SET->CALLBACK->USE shape matched; recorded for completeness.",
  };
  return `[${idiom} / ${writeAccess}] ${notes[windowClass] || notes.unclassified}`;
}

// --- scan one family ----------------------------------------------------------------------
function scanFamily(fam) {
  const abs = path.join(WORKSPACE, fam.root);
  if (!fs.existsSync(abs)) {
    return { target: fam.id, root: fam.root, present: false, filesScanned: 0, hits: [], note: fam.note };
  }
  const files = walkSol(abs).slice(0, LIMITS.filesPerFamily);
  const hits = [];
  for (const file of files) {
    if (hits.length >= LIMITS.hitsPerFamily) break;
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (_) { continue; }
    const lines = text.split(/\r?\n/);
    const relFile = rel(file);
    const fileHasLowLevelCall = LOW_LEVEL_CALL.test(text);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hit = TRANSIENT_IDIOMS.find((r) => r.re.test(line)) || ROUTE_IDIOMS.find((r) => r.re.test(line));
      if (!hit) continue;
      if (/^\s*(\/\/|\*|\/\*)/.test(line) && !/tstore|tload/.test(line)) continue; // skip doc-only mentions
      const sig = enclosingSignature(lines, i);
      const bodyPrefix = lines.slice(Math.max(0, (sig.line || i + 1) - 1), i + 1).join(" ");
      const isRoute = ROUTE_IDIOMS.includes(hit);
      const writeAccess = isRoute
        ? (hit.idiom === "whitelisted-swapper-gate" ? "gate-read" : classifyWriteAccess(sig.text, bodyPrefix))
        : classifyWriteAccess(sig.text, bodyPrefix);
      const windowClass = isRoute
        ? (hit.idiom === "raw-external-call(arbitrary-calldata)" ? "callback-frame" : "SET->CALLBACK->USE-candidate")
        : classifyWindow({ relFile, fileHasLowLevelCall, writeAccess, idiom: hit.idiom, famId: fam.id });
      hits.push({
        file: relFile,
        line: i + 1,
        idiom: hit.idiom,
        fn: sig.text ? sig.text.slice(0, 120) : null,
        fnLine: sig.line,
        writeAccess,
        windowClass,
        note: note(hit.idiom, writeAccess, windowClass),
      });
      if (hits.length >= LIMITS.hitsPerFamily) break;
    }
  }
  return { target: fam.id, root: fam.root, present: true, filesScanned: files.length, hits, note: fam.note };
}

// --- main ---------------------------------------------------------------------------------
function main() {
  const scannedAt = new Date().toISOString();
  const perTarget = [];
  const gaps = [];

  for (const fam of FAMILIES) {
    const result = scanFamily(fam);
    perTarget.push(result);
    if (!result.present) {
      gaps.push({
        id: `MISS-${fam.id}`, status: "MISS", target: fam.id, root: fam.root,
        note: `checkout family root not found; expectedTransient=${fam.expectTransient}. Recorded fail-closed.`,
      });
    } else if (result.hits.length === 0) {
      gaps.push({
        id: `MISS-${fam.id}-no-idiom`, status: "MISS", target: fam.id, root: fam.root,
        note: fam.expectTransient
          ? `no transient/route idiom matched (unexpected: hypothesis said transient present) — investigate`
          : `no transient/route idiom matched (expected: ${fam.note})`,
      });
    }
  }

  const flat = perTarget.flatMap((t) => t.hits.map((h) => ({ target: t.target, ...h })));
  const flagged = flat.filter((h) => h.windowClass === "SET->CALLBACK->USE-candidate" || h.windowClass === "permissionless-write-same-frame" || h.windowClass === "permissioned-set-call-use");
  const hitCounts = flat.reduce((acc, h) => { acc[h.windowClass] = (acc[h.windowClass] || 0) + 1; return acc; }, {});

  const artifact = {
    scannedAt,
    scanner: "tools/scan-transient-write-windows.js",
    mode: "offline-source",
    semantics: {
      thesis: "SET->CALLBACK->USE across frames: a transient/route slot is written, then an untrusted external call is made, then a reader consumes the slot believing it authored it. Permissionless setter alone is not a finding; the reader executing across an attacker-influenced frame is.",
      windowClasses: ["SET->CALLBACK->USE-candidate", "permissionless-write-same-frame", "permissioned-set-call-use", "guard-only", "allowance-scope", "framework-transient-status", "callback-frame", "unclassified"],
      intentPreservingNotes: [
        "A permissionless setter is only interesting if a reader executes across an attacker-influenced frame (same tx / atomic bundle / multicall).",
        "Reentrancy guards and ERC-7674 temporary allowances are transient BY DESIGN; classified, not flagged.",
        "Euler EVC TransientStorage is EXPECTED safe: per-tx status/controller isolation cleared at tx end and re-checked by the EVC.",
        "tstore lifetime is the whole transaction; the per-block `number()` guard seen in GluexAdapter is redundant for cross-tx leakage but does NOT scope the slot to the caller.",
      ],
    },
    safety: {
      offline: true, networkCalls: false, rpcUrlsStored: false, privateKeysRead: false,
      signedActions: false, broadcast: false, forkTransactions: false,
    },
    perTarget,
    hits: flat,
    hitCounts,
    flaggedCount: flagged.length,
    gaps,
    exitCode: 0,
  };

  ensureDir(OUT);
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);

  if (!QUIET) {
    console.log(
      `transient-write-windows: targets=${perTarget.length} filesScanned=${perTarget.reduce((a, t) => a + t.filesScanned, 0)} ` +
      `hits=${flat.length} flagged(SET->CALLBACK->USE | perm-write | perm-set-call)=${flagged.length} gaps=${gaps.length} ` +
      `artifact=${rel(OUT)}`,
    );
  }
  return artifact;
}

try {
  main();
} catch (err) {
  // Fail-closed: still emit a MISS artifact and exit 0.
  try {
    ensureDir(OUT);
    fs.writeFileSync(OUT, `${JSON.stringify({
      scannedAt: new Date().toISOString(),
      scanner: "tools/scan-transient-write-windows.js",
      mode: "offline-source",
      error: String((err && err.message) || err),
      perTarget: [], hits: [], hitCounts: {},
      gaps: [{ id: "MISS-INTERNAL", status: "MISS", note: "scanner threw before completing a sweep; recorded fail-closed" }],
      exitCode: 0,
    }, null, 2)}\n`);
  } catch (_) { /* best effort */ }
  if (!QUIET) console.log("transient-write-windows: internal error recorded fail-closed (exit 0)");
}
process.exitCode = 0;
