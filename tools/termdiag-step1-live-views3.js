#!/usr/bin/env node
"use strict";
/*
 * termdiag-step1-live-views3.js
 * READ-ONLY: byte-diff live runtimes vs pinned artifacts (difference spans),
 * corrected TermStorage packed-slot reads, per-facet runtime fingerprints.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require(path.join(__dirname, "node_modules", "ethers"));
const sharedRpc = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const PIN = path.join(WORKSPACE, "targets", "term-finance-contracts-v2.1.2");
const OUT = path.join(WORKSPACE, "reports", "raw", "termdiag-step1-live-views3.json");
const TIMEOUT = 8000;

const A = {
  factory: "0x44058C32B154A516F3b9DE2413e6cb938F93c3B4",
  emitter: "0xf021B31282a60528B2F47D07Ce353da870be78b3",
  diamond: "0xb4B1de03F229220eDbBB31A224b2a004b3c3e47f",
  facets: {
    "0xc024BE1b35a7271b815125676f30C3EC3BB4463a": "facets/DiamondCutFacet.sol/DiamondCutFacet.json",
    "0xd7f2F42188932513dCAA4F9c9b241F34a1f70e92": "facets/DiamondLoupeFacet.sol/DiamondLoupeFacet.json",
    "0xFF6D0eb2E2BB598B645598CcfD1e81790b8FCa1B": "facets/TermControllerFacet.sol/TermControllerFacet.json",
    "0x3d2E2Dbe93BE3645311713B6Cc980b16F5519390": "facets/MulticallFacet.sol/MulticallFacet.json",
    "0x6626a60C28a796fea0Ea7324A1baC058Fc4c7828": "facets/PermitFacet.sol/PermitFacet.json",
    "0x02d05d3725b540A4B2bA263FdD38c9Cfad6a6347": "facets/Permit2Facet.sol/Permit2Facet.json",
    "0x7045f0945691De1E4f22e9841b77c06020BA3d13": "facets/TransferFacet.sol/TransferFacet.json",
    "0x3c19D13a388798B3b71B215Bb04959CFFAAcEf4B": "facets/flashloan/TermFlashLoanExecutorFacet.sol/TermFlashLoanExecutorFacet.json",
    "0xD77Ada49C5486e1b78867c1E7763E7874aBBBb6F": "facets/TermRouterFacet.sol/TermRouterFacet.json",
    "0xc0081Eca65aA79f10a336D4C60A448302C1e477B": "facets/ERC4626InterfaceFacet.sol/ERC4626InterfaceFacet.json",
    "0x4145fFC9f5f4dCB0aFe05aa78Fa07CAC5ceaB06C": "facets/TermStrategyFacet.sol/TermStrategyFacet.json",
    "0x99894B31F98bC8973eCdE3178D223E979381832B": "facets/external/TermAaveInterfaceFacet.sol/TermAaveInterfaceFacet.json",
    "0x6d5146D09Fe3204224D6dF90d7eFc3de15d9bBf0": "facets/external/TermMorphoInterfaceFacet.sol/TermMorphoInterfaceFacet.json",
    "0x02c7d197D047F687E67504cB9Ac21EADe5ce19bb": "facets/TermLoanIntentFacet.sol/TermLoanIntentFacet.json",
    "0x1fCd8435206605B3107d2D25a8c19FAeC7Ee566F": "facets/TermLoanIntentHookFacet.sol/TermLoanIntentHookFacet.json",
    "0xF1c38D5Cc47B3dDfbE98392199c2488eD0b38D25": "facets/TermRepoTokenIntentFacet.sol/TermRepoTokenIntentFacet.json",
    "0xfdD50c0c1a378b7AF530fE912D4b154dc8980929": "facets/TermSettlementWithHooksFacet.sol/TermSettlementWithHooksFacet.json",
    "0xEc9D4Ac41A9180F88e3eCFe6365A0E265B3485b8": "facets/SwapRouterFacet.sol/SwapRouterFacet.json",
    "0x2c5D7C65f7276190C47C45300E71E93d8401836a": "facets/flashloan/TermFlashLoanCentralReceiverFacet.sol/TermFlashLoanCentralReceiverFacet.json",
  },
};

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

function artifact(rel) {
  const p = path.join(PIN, "artifacts", "contracts", rel);
  if (!fs.existsSync(p)) return null;
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return {
    keys: Object.keys(j),
    deployedBytecode: (j.deployedBytecode || "").replace(/^0x/, ""),
    immutableReferences: j.immutableReferences || null,
  };
}

function stripMeta(h) {
  if (h.length < 4) return h;
  const n = parseInt(h.slice(-4), 16);
  if (!Number.isFinite(n) || n % 2 !== 0 || n * 2 + 4 > h.length) return h;
  return h.slice(0, h.length - (n * 2 + 4));
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

function flattenImmRefs(refs) {
  const out = [];
  if (!refs) return out;
  for (const k of Object.keys(refs)) for (const r of refs[k]) out.push({ start: r.start, length: r.length });
  return out;
}

function diffSpans(aHex, bHex) {
  const n = Math.min(aHex.length, bHex.length);
  const spans = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (aHex[i] !== bHex[i]) { if (start < 0) start = i; }
    else if (start >= 0) { spans.push([start, i - start]); start = -1; }
  }
  if (start >= 0) spans.push([start, n - start]);
  return { spans, lengthDelta: aHex.length - bHex.length, minLengthBytes: n / 2 };
}

async function main() {
  const endpoint = await sharedRpc.resolveRpc(1, null, { capability: "read" });
  if (!endpoint) { console.log("NO_ENDPOINT"); return; }
  const out = {
    schema: "termdiag-step1-live-views3/v1",
    generatedUtc: new Date().toISOString(),
    network: { chainId: 1, blockNumber: BigInt(await rpc(endpoint, "eth_blockNumber", [])).toString() },
    endpointMaterialPersisted: false,
    readOnly: true,
    status: "PASS",
  };

  // ---------- factory + diamond diff vs artifact ----------
  for (const [name, addr, rel] of [
    ["factory", A.factory, "factory/TermRepoDeployerFactory.sol/TermRepoDeployerFactory.json"],
    ["diamond", A.diamond, "TermDiamond.sol/TermDiamond.json"],
  ]) {
    const art = artifact(rel);
    const live = (await rpc(endpoint, "eth_getCode", [addr, "latest"])).replace(/^0x/, "");
    const rec = { liveBytes: live.length / 2, artifactKeys: art ? art.keys : null };
    if (art) {
      rec.artifactBytes = art.deployedBytecode.length / 2;
      const imm = flattenImmRefs(art.immutableReferences);
      rec.artifactImmutableRangeCount = imm.length;
      rec.artifactImmutableRanges = imm.slice(0, 40);
      const diff = diffSpans(live, art.deployedBytecode);
      rec.diffSpanCount = diff.spans.length;
      rec.lengthDeltaHex = diff.lengthDelta;
      rec.diffSpansFirst40 = diff.spans.slice(0, 40);
      const allInsideImm = imm.length > 0 && diff.spans.every(([s, l]) =>
        imm.some((r) => s >= r.start && s + l <= r.start + r.length));
      rec.allDiffSpansInsideImmutableRanges = allInsideImm;
      if (imm.length > 0) {
        rec.immutableNormalizedEqual =
          ethers.keccak256(zeroRanges(live, imm)) === ethers.keccak256(zeroRanges(art.deployedBytecode, imm));
      }
      rec.metadataStrippedEqual = stripMeta(live) === stripMeta(art.deployedBytecode);
      rec.liveMetadataStrippedKeccak = ethers.keccak256("0x" + stripMeta(live));
      rec.artifactMetadataStrippedKeccak = ethers.keccak256("0x" + stripMeta(art.deployedBytecode));
    }
    out[name] = rec;
  }

  // ---------- corrected TermStorage packed slots ----------
  const base = BigInt(ethers.keccak256(ethers.toUtf8Bytes("term.storage")));
  const slot = (off) => "0x" + (base + BigInt(off)).toString(16).padStart(64, "0");
  const read = async (off) => rpc(endpoint, "eth_getStorageAt", [A.diamond, slot(off), "latest"]);
  // packed: [0]=bool+addr, [1]=activeSettlementMaker, [2]=atomicTxInitiatior, [3]=activeAtomicTxSettlementTaker,
  // [4]=eip712DomainSeparator, [5]=approvedTermControllers, [6]=approvedTermControllerList,
  // [7]=approvedFeeRecipients, [8]=emitter
  out.termStorage = {
    baseSlot: slot(0),
    slot0_initializedAndMulticall: await read(0),
    slot4_eip712DomainSeparator: await read(4),
    slot8_emitter: await read(8),
  };
  const s4 = out.termStorage.slot4_eip712DomainSeparator;
  const s8 = out.termStorage.slot8_emitter;
  if (/^0x[0-9a-f]{64}$/i.test(s4)) out.termStorage.eip712MatchesDiamondGetter = s4.slice(2) === "b4f6e3513fbe2bf8c2f522c07fa266d76bd816d05fd1c8358158d844abdf2d67";
  if (/^0x[0-9a-f]{64}$/i.test(s8)) {
    out.termStorage.emitterStored = "0x" + s8.slice(26);
    out.termStorage.emitterMatchesFactoryEmitter = ("0x" + s8.slice(26)).toLowerCase() === A.emitter.toLowerCase();
  }

  // ---------- facet runtimes ----------
  out.facets = [];
  for (const [addr, rel] of Object.entries(A.facets)) {
    const art = artifact(rel);
    const live = (await rpc(endpoint, "eth_getCode", [addr, "latest"])).replace(/^0x/, "");
    const rec = { address: addr, contract: rel.split("/").pop().replace(".json", ""), liveBytes: live.length / 2 };
    if (art) {
      rec.artifactBytes = art.deployedBytecode.length / 2;
      rec.sizeMatch = rec.liveBytes === rec.artifactBytes;
      const imm = flattenImmRefs(art.immutableReferences);
      rec.artifactImmutableRangeCount = imm.length;
      if (rec.sizeMatch) {
        const diff = diffSpans(live, art.deployedBytecode);
        rec.diffSpans = diff.spans.length;
        rec.allDiffInsideImm = imm.length > 0 && diff.spans.every(([s, l]) => imm.some((r) => s >= r.start && s + l <= r.start + r.length));
        rec.immutableNormalizedEqual = imm.length > 0 &&
          ethers.keccak256(zeroRanges(live, imm)) === ethers.keccak256(zeroRanges(art.deployedBytecode, imm));
        rec.metadataStrippedEqual = stripMeta(live) === stripMeta(art.deployedBytecode);
        rec.diffSpansFirst10 = diff.spans.slice(0, 10);
      }
    }
    out.facets.push(rec);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({
    status: out.status,
    block: out.network.blockNumber,
    factory: out.factory,
    diamond: out.diamond,
    termStorage: out.termStorage,
    facets: out.facets.map((f) => ({
      c: f.contract, live: f.liveBytes, art: f.artifactBytes, sizeMatch: f.sizeMatch,
      immRanges: f.artifactImmutableRangeCount, diffSpans: f.diffSpans,
      allDiffInsideImm: f.allDiffInsideImm, immEqual: f.immutableNormalizedEqual, metaEqual: f.metadataStrippedEqual,
    })),
    artifact: path.relative(WORKSPACE, OUT),
  }, null, 2));
}

main().catch((e) => { console.error("FATAL " + String(e.message || e).slice(0, 240)); process.exit(1); });
