#!/usr/bin/env node
"use strict";
/*
 * termdiag-step1-live-views2.js
 * READ-ONLY follow-up binding: runtime identity vs pinned artifacts (pinned tree),
 * diamond storage slots, emitter role chain, facet->source mapping.
 * No transactions/signing/forks/logs; endpoint URLs never printed or persisted.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require(path.join(__dirname, "node_modules", "ethers"));
const sharedRpc = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const PIN = path.join(WORKSPACE, "targets", "term-finance-contracts-v2.1.2");
const OUT = path.join(WORKSPACE, "reports", "raw", "termdiag-step1-live-views2.json");
const TIMEOUT = 7000;

const A = {
  factory: "0x44058C32B154A516F3b9DE2413e6cb938F93c3B4",
  controller: "0xd902EBb8AEb832643af38f43d466a6155cD8Bd5A",
  emitter: "0xf021B31282a60528B2F47D07Ce353da870be78b3",
  diamond: "0xb4B1de03F229220eDbBB31A224b2a004b3c3e47f",
  candidates: [
    "0xa7dE1A7118e2BBE17c0928673966f466b18aDE77",
    "0xc8006dec63d7d2f6b45a0f5de90390a86a6b950d",
    "0x99FE7E977DFE42700f4424Bc4C2bbb3EfcC6E691",
  ],
};
A.candidates = [
  "0xa7dE1A7118e2BBE17c0928673966f466b18aDE77",
  "0xc8006dec63d7d2f6b45a0f5de90390a86a6b950d",
  "0x99FE7E977DFE42700f4424Bc4C2bbb3EfcC6E691",
];

async function rpc(url, method, params) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("http " + res.status);
    const j = await res.json();
    if (j.error) throw new Error("rpc " + (j.error.code || "?") + " " + String(j.error.message || "").slice(0, 80));
    return j.result;
  } finally { clearTimeout(t); }
}

function stripMetadata(hexNo0x) {
  if (hexNo0x.length < 4) return hexNo0x;
  const lenHex = hexNo0x.slice(-4);
  const cborLen = parseInt(lenHex, 16);
  if (!Number.isFinite(cborLen) || cborLen % 2 !== 0) return hexNo0x;
  if (cborLen * 2 + 4 > hexNo0x.length) return hexNo0x;
  return hexNo0x.slice(0, hexNo0x.length - (cborLen * 2 + 4));
}

function zeroRanges(hexNo0x, ranges) {
  const b = Buffer.from(hexNo0x, "hex");
  for (const r of ranges) {
    const start = r.start !== undefined ? r.start : r[0];
    const length = r.length !== undefined ? r.length : r[1];
    for (let i = start; i < start + length && i < b.length; i++) b[i] = 0;
  }
  return b;
}

function artifactFor(relJson) {
  const p = path.join(PIN, relJson);
  if (!fs.existsSync(p)) return null;
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const db = (j.deployedBytecode || "").replace(/^0x/, "");
  const immRanges = [];
  const refs = j.immutableReferences || {};
  for (const astId of Object.keys(refs)) for (const r of refs[astId]) immRanges.push({ start: r.start, length: r.length });
  return { deployedBytecode: db, immRanges, abi: j.abi || [] };
}

/** map selector -> "Contract.fn(sig)" for all pinned facet artifacts */
function buildFacetSelectorMap() {
  const dir = path.join(PIN, "artifacts", "contracts", "facets");
  const map = new Map(); // selector -> [{contract, sig}]
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".json")) continue;
      let j; try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
      if (!Array.isArray(j.abi)) continue;
      const contract = e.name.replace(/\.json$/, "");
      for (const item of j.abi) {
        try {
          const iface = new ethers.Interface([item]);
          for (const frag of iface.fragments) {
            if (!frag.selector) continue;
            const label = `${contract}.${frag.format("sighash")}`;
            const arr = map.get(frag.selector) || [];
            if (!arr.includes(label)) arr.push(label);
            map.set(frag.selector, arr);
          }
        } catch { /* skip non-abi entries */ }
      }
    }
  };
  walk(dir);
  return map;
}

async function main() {
  const endpoint = await sharedRpc.resolveRpc(1, null, { capability: "read" });
  if (!endpoint) { console.log("NO_ENDPOINT"); return; }

  const out = {
    schema: "termdiag-step1-live-views2/v1",
    generatedUtc: new Date().toISOString(),
    network: { chainId: 1, blockNumber: BigInt(await rpc(endpoint, "eth_blockNumber", [])).toString() },
    endpointMaterialPersisted: false,
    readOnly: true,
    identity: {},
    diamondStorage: {},
    emitterRoles: {},
    facetMapping: [],
    unmappedSelectors: [],
    status: "PASS",
  };

  // ---------- runtime identity vs pinned artifacts ----------
  for (const [name, addr, rel] of [
    ["factory", A.factory, "artifacts/contracts/factory/TermRepoDeployerFactory.sol/TermRepoDeployerFactory.json"],
    ["diamond", A.diamond, "artifacts/contracts/TermDiamond.sol/TermDiamond.json"],
  ]) {
    const art = artifactFor(rel);
    const liveHex = (await rpc(endpoint, "eth_getCode", [addr, "latest"])).replace(/^0x/, "");
    const rec = {
      address: addr,
      liveBytes: liveHex.length / 2,
      artifactBytes: art ? art.deployedBytecode.length / 2 : null,
      artifactImmutableRangeCount: art ? art.immRanges.length : null,
    };
    if (art) {
      rec.rawKeccak = ethers.keccak256("0x" + liveHex);
      rec.artifactRawKeccak = ethers.keccak256("0x" + art.deployedBytecode);
      const liveStripped = stripMetadata(liveHex);
      const artStripped = stripMetadata(art.deployedBytecode);
      rec.liveMetadataStrippedBytes = liveStripped.length / 2;
      rec.artifactMetadataStrippedBytes = artStripped.length / 2;
      rec.metadataStrippedKeccak = ethers.keccak256("0x" + liveStripped);
      rec.artifactMetadataStrippedKeccak = ethers.keccak256("0x" + artStripped);
      if (art.immRanges.length > 0 && liveHex.length === art.deployedBytecode.length) {
        rec.immutableNormalizedKeccak = ethers.keccak256(zeroRanges(liveHex, art.immRanges));
        rec.artifactImmutableNormalizedKeccak = ethers.keccak256(zeroRanges(art.deployedBytecode, art.immRanges));
        rec.immutableNormalizedMatch = rec.immutableNormalizedKeccak === rec.artifactImmutableNormalizedKeccak;
      }
      if (liveHex.length === art.deployedBytecode.length) {
        rec.rawByteEqual = liveHex === art.deployedBytecode;
        rec.metadataStrippedByteEqual = liveStripped === artStripped;
      }
    }
    out.identity[name] = rec;
  }

  // ---------- diamond storage ----------
  const base = BigInt(ethers.keccak256(ethers.toUtf8Bytes("term.storage")));
  const slotHex = (n) => "0x" + n.toString(16).padStart(64, "0");
  const readSlot = async (addr, slot) => {
    try {
      const raw = await rpc(endpoint, "eth_getStorageAt", [addr, slot, "latest"]);
      return raw;
    } catch (e) { return "ERR:" + String(e.message || e).slice(0, 60); }
  };
  out.diamondStorage.termStorageBase = "0x" + base.toString(16).padStart(64, "0");
  const s0 = await readSlot(A.diamond, slotHex(base + 0n));
  const s5 = await readSlot(A.diamond, slotHex(base + 5n));
  const s9 = await readSlot(A.diamond, slotHex(base + 9n));
  out.diamondStorage.termIntentInitialized = { raw: s0 };
  out.diamondStorage.eip712DomainSeparator_raw = { raw: s5 };
  out.diamondStorage.emitter_raw = { raw: s9 };
  if (/^0x[0-9a-f]{64}$/i.test(s0)) out.diamondStorage.termIntentInitializedBool = BigInt(s0) !== 0n;
  if (/^0x[0-9a-f]{64}$/i.test(s9)) {
    const emitterStored = "0x" + s9.slice(26);
    out.diamondStorage.emitterStored = emitterStored;
    out.diamondStorage.emitterMatchesFactoryEmitter =
      emitterStored.toLowerCase() === A.emitter.toLowerCase();
  }
  const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const implRaw = await readSlot(A.diamond, EIP1967_IMPL);
  out.diamondStorage.eip1967ImplSlot = implRaw;
  out.diamondStorage.isEip1967Proxy = /^0x[0-9a-f]{64}$/i.test(implRaw) && BigInt(implRaw) !== 0n;

  // ---------- emitter role chain ----------
  const emitterIface = new ethers.Interface(["function hasRole(bytes32 role, address account) view returns (bool)"]);
  const roleHashes = {
    INITIALIZER_ROLE: ethers.id("INITIALIZER_ROLE"),
    TERM_CONTRACT: ethers.id("TERM_CONTRACT"),
    ADMIN_ROLE: ethers.id("ADMIN_ROLE"),
    DEVOPS_ROLE: ethers.id("DEVOPS_ROLE"),
  };
  out.emitterRoles.roleHashes = roleHashes;
  const checkRole = async (roleName, addr) => {
    try {
      const data = emitterIface.encodeFunctionData("hasRole", [roleHashes[roleName], addr]);
      const res = await rpc(endpoint, "eth_call", [{ to: A.emitter, data }, "latest"]);
      return { ok: true, value: emitterIface.decodeFunctionResult("hasRole", res)[0] };
    } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 100) }; }
  };
  out.emitterRoles.INITIALIZER_ROLE_factory = await checkRole("INITIALIZER_ROLE", A.factory);
  out.emitterRoles.TERM_CONTRACT_diamond = await checkRole("TERM_CONTRACT", A.diamond);
  for (const c of A.candidates) out.emitterRoles["TERM_CONTRACT_" + c] = await checkRole("TERM_CONTRACT", c);

  // ---------- facet -> source mapping ----------
  const facetMap = buildFacetSelectorMap();
  const facets = (
    await rpc(endpoint, "eth_call", [{
      to: A.diamond,
      data: new ethers.Interface([
        "function facets() view returns ((address facetAddress, bytes4[] functionSelectors)[])",
      ]).encodeFunctionData("facets", []),
    }, "latest"])
  );
  const decoded = new ethers.Interface([
    "function facets() view returns ((address facetAddress, bytes4[] functionSelectors)[])",
  ]).decodeFunctionResult("facets", facets)[0];

  for (const f of decoded) {
    const sels = f.functionSelectors.map((s) => s);
    const sourceVotes = new Map();
    const unmapped = [];
    for (const sel of sels) {
      const labels = facetMap.get(sel);
      if (!labels || labels.length === 0) { unmapped.push(sel); continue; }
      for (const lbl of labels) {
        const contract = lbl.split(".")[0];
        sourceVotes.set(contract, (sourceVotes.get(contract) || 0) + 1);
      }
    }
    const ranked = [...sourceVotes.entries()].sort((a, b) => b[1] - a[1]);
    out.facetMapping.push({
      facetAddress: f.facetAddress,
      selectorCount: sels.length,
      bestSource: ranked.length ? ranked[0][0] : null,
      bestSourceMatched: ranked.length ? ranked[0][1] : 0,
      runnersUp: ranked.slice(1, 3),
      unmappedCount: unmapped.length,
      unmapped: unmapped.slice(0, 30),
    });
    out.unmappedSelectors.push(...unmapped);
  }
  out.unmappedSelectors = [...new Set(out.unmappedSelectors)];

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({
    status: out.status,
    block: out.network.blockNumber,
    factoryIdentity: out.identity.factory,
    diamondIdentity: out.identity.diamond,
    diamondStorage: out.diamondStorage,
    emitterRoles: out.emitterRoles,
    facetMapping: out.facetMapping.map((f) => ({
      f: f.facetAddress, n: f.selectorCount, src: f.bestSource, m: f.bestSourceMatched, unmapped: f.unmappedCount,
    })),
    unmappedSelectorCount: out.unmappedSelectors.length,
    artifact: path.relative(WORKSPACE, OUT),
  }, null, 2));
}

main().catch((e) => { console.error("FATAL " + String(e.message || e).slice(0, 240)); process.exit(1); });
