"use strict";
// aave-v4-family-candidates.js — env-gated family-injected candidate pool for
// the Aave V4 scanner mains. Activation: AAVE_V4_FAMILY_INJECTION=1 (or any
// truthy value). Without the env var, build() returns null and callers fall
// back to their identical legacy default behavior.
//
// Pool source: rpc_endpoints.txt (the single credential source; URL material
// stays process-only, printed nowhere) + the freshest serve-scan artifact
// (serving hosts per chain). Canonical reviewed operator-family IDs are
// derived from the root domain; hosts outside the reviewed list carry no
// operatorFamily (loop-skipped by the preflight by design).
const fs = require("fs");
const path = require("path");

const SERVE_SCAN_CANDIDATES = [
  path.resolve(__dirname, "../../reports/raw/fast/op-curve-getdy-20261012-r8/serve-scan.json"),
  path.resolve(__dirname, "../../reports/raw/fast/serve-scan.json"),
];
const RPC_FILE = path.resolve(__dirname, "../../rpc_endpoints.txt");

const FAMILY_BY_ROOT = new Map([
  ["infura.io", "infura"],
  ["quiknode.pro", "quicknode"],
  ["quicknode.com", "quicknode"],
  ["publicnode.com", "publicnode"],
  ["drpc.org", "drpc"],
  ["drpc.live", "drpc"],
  ["alchemy.com", "alchemy"],
  ["alchemy.g.alchemy.com", "alchemy"],
  ["ankr.com", "ankr"],
  ["1rpc.io", "1rpc"],
  ["0xrpc.io", "0xrpc"],
]);

function activationEnabled(env) {
  const raw = String((env && env.AAVE_V4_FAMILY_INJECTION) || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function loadServeScan() {
  for (const candidate of SERVE_SCAN_CANDIDATES) {
    try {
      const scan = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (scan && scan.chains && scan.chains.chain1) return scan;
    } catch (_) { /* try the next candidate path */ }
  }
  return null;
}

function buildCandidates(env) {
  if (!activationEnabled(env)) return null;
  const scan = loadServeScan();
  if (!scan) throw new Error("family-injection-serve-scan-missing");
  const chain1 = (scan.chains && scan.chains.chain1) || {};
  const serveScanAt = scan.generatedAt || null;
  const pool = [];
  for (const fam of chain1.hosts || []) {
    for (const host of fam.hosts || []) pool.push({ root: fam.family, host });
  }
  const urlByHost = new Map();
  for (const line of fs.readFileSync(RPC_FILE, "utf8").split(/\r?\n/)) {
    for (const token of line.match(/https?:\/\/[^\s'"<>]+/gi) || []) {
      try {
        const u = new URL(token);
        const hostname = u.hostname.toLowerCase();
        if (!urlByHost.has(hostname)) urlByHost.set(hostname, u);
      } catch (_) { /* non-URL token */ }
    }
  }
  const candidates = [];
  for (const entry of pool) {
    const u = urlByHost.get(entry.host.toLowerCase());
    if (!u) continue;
    const family = FAMILY_BY_ROOT.get(entry.root) || null;
    candidates.push({
      handle: u,
      inventoryOrder: candidates.length,
      ...(family ? { operatorFamily: family } : {}),
      capabilityRank: 1,
    });
  }
  const families = [...new Set(candidates.map((c) => c.operatorFamily).filter(Boolean))];
  if (candidates.length < 4 || families.length < 2) throw new Error("family-injection-pool-too-weak");
  return { candidates, families, serveScanAt, resolver: createResolver(candidates) };
}

function createResolver(candidates) {
  let rotation = 0;
  return async (preferred) => {
    if (preferred) return preferred;
    const next = candidates[rotation % candidates.length];
    rotation += 1;
    return next.handle;
  };
}

module.exports = { buildCandidates, activationEnabled, FAMILY_BY_ROOT };
