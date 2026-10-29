#!/usr/bin/env node
"use strict";
/*
 * termdiag-step1-live-views4.js
 * READ-ONLY identity reconciliation:
 *  - fixed metadata strip
 *  - version-string literal offsets ("development" vs "2.1.2"/"2.1.0")
 *  - diff-span classification vs R1 fixture immutable ranges
 *  - artifact build settings (hardhat compiler config) for context
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require(path.join(__dirname, "node_modules", "ethers"));
const sharedRpc = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const PIN = path.join(WORKSPACE, "targets", "term-finance-contracts-v2.1.2");
const OUT = path.join(WORKSPACE, "reports", "raw", "termdiag-step1-live-views4.json");
const TIMEOUT = 8000;

const FIXTURE_RANGES = [
  [549, 32], [4196, 32], [4494, 32], [4820, 32],
  [10969, 32], [11248, 32], [11971, 32], [12163, 32],
  [1187, 32], [4156, 32], [4454, 32], [4780, 32],
  [11003, 32], [11208, 32], [11541, 32], [11924, 32],
  [12197, 32], [4236, 32], [4534, 32], [6964, 32],
  [11479, 32], [11878, 32], [12231, 32],
];
const FIXTURE_FACTORY = {
  raw: "0x85533fd16302e835cdaa807bd12ed7fb45b7bdb1faac8009acf689de5d0bf72a",
  meta: "0xda979c6a74071a6b118a0cc068f1f9f86df379a6b08be3b706b1c27466408ec8",
};

const A = {
  factory: "0x44058C32B154A516F3b9DE2413e6cb938F93c3B4",
  diamond: "0xb4B1de03F229220eDbBB31A224b2a004b3c3e47f",
};

async function rpc(url, method, params) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("http " + res.status);
    const j = await res.json();
    if (j.error) throw new Error("rpc " + (j.error.code || "?"));
    return j.result;
  } finally { clearTimeout(t); }
}

function stripMetaFixed(h) {
  if (h.length < 4) return { stripped: h, strippedBytes: 0, parsed: false };
  const n = parseInt(h.slice(-4), 16);
  if (!Number.isFinite(n) || n * 2 + 4 > h.length) return { stripped: h, strippedBytes: 0, parsed: false };
  return { stripped: h.slice(0, h.length - (n * 2 + 4)), strippedBytes: n + 2, parsed: true };
}

function zeroRanges(hexNo0x, ranges) {
  const b = Buffer.from(hexNo0x, "hex");
  for (const [s, l] of ranges) for (let i = s; i < s + l && i < b.length; i++) b[i] = 0;
  return b;
}

function diffSpans(a, b) {
  const n = Math.min(a.length, b.length);
  const spans = []; let start = -1;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) { if (start < 0) start = i; }
    else if (start >= 0) { spans.push([start, i - start]); start = -1; }
  }
  if (start >= 0) spans.push([start, n - start]);
  return spans;
}

function findAll(buf, needleHex) {
  const idx = [];
  let i = 0;
  for (;;) {
    i = buf.indexOf(needleHex, i, "hex");
    if (i < 0) break;
    idx.push(i);
    i += 1;
  }
  return idx;
}

async function main() {
  const endpoint = await sharedRpc.resolveRpc(1, null, { capability: "read" });
  if (!endpoint) { console.log("NO_ENDPOINT"); return; }
  const out = {
    schema: "termdiag-step1-live-views4/v1",
    generatedUtc: new Date().toISOString(),
    block: BigInt(await rpc(endpoint, "eth_blockNumber", [])).toString(),
    endpointMaterialPersisted: false,
    readOnly: true,
    status: "PASS",
    factory: {},
    diamond: {},
    buildSettingsNote: "see hardhat.config.ts in pinned tree",
  };

  for (const [name, addr, rel] of [
    ["factory", A.factory, "factory/TermRepoDeployerFactory.sol/TermRepoDeployerFactory.json"],
    ["diamond", A.diamond, "TermDiamond.sol/TermDiamond.json"],
  ]) {
    const art = JSON.parse(fs.readFileSync(path.join(PIN, "artifacts", "contracts", rel), "utf8"));
    const artHex = art.deployedBytecode.replace(/^0x/, "");
    const liveHex = (await rpc(endpoint, "eth_getCode", [addr, "latest"])).replace(/^0x/, "");
    const rec = { liveBytes: liveHex.length / 2, artifactBytes: artHex.length / 2 };

    const lm = stripMetaFixed(liveHex), am = stripMetaFixed(artHex);
    rec.liveMetaStripParsed = lm.parsed; rec.liveMetaStripBytes = lm.strippedBytes;
    rec.artifactMetaStripParsed = am.parsed; rec.artifactMetaStripBytes = am.strippedBytes;
    rec.metaStrippedEqual = lm.stripped === am.stripped;
    rec.liveMetaStrippedKeccak = ethers.keccak256("0x" + lm.stripped);
    rec.artifactMetaStrippedKeccak = ethers.keccak256("0x" + am.stripped);
    rec.artifactMetaStrippedMatchesFixture = rec.artifactMetaStrippedKeccak === FIXTURE_FACTORY.meta;

    // immutable zeroing with fixture ranges on both
    if (liveHex.length === artHex.length) {
      rec.zeroedLiveVsZeroedArtifactEqual =
        ethers.keccak256(zeroRanges(liveHex, FIXTURE_RANGES)) === ethers.keccak256(zeroRanges(artHex, FIXTURE_RANGES));
      rec.zeroedLiveKeccak = ethers.keccak256(zeroRanges(liveHex, FIXTURE_RANGES));
      rec.zeroedArtifactKeccak = ethers.keccak256(zeroRanges(artHex, FIXTURE_RANGES));
      rec.artifactRawMatchesFixtureRaw = ethers.keccak256("0x" + artHex) === FIXTURE_FACTORY.raw;
      rec.liveRawMatchesFixtureRaw = ethers.keccak256("0x" + liveHex) === FIXTURE_FACTORY.raw;
    }

    // version literal offsets
    const dev = Buffer.from("development", "utf8").toString("hex");
    const v212 = Buffer.from("2.1.2", "utf8").toString("hex");
    const v210 = Buffer.from("2.1.0", "utf8").toString("hex");
    rec.artifactDevLiteralOffsets = findAll(artHex, dev).map((i) => i / 2);
    rec.liveDevLiteralOffsets = findAll(liveHex, dev).map((i) => i / 2);
    rec.liveV212Offsets = findAll(liveHex, v212).map((i) => i / 2);
    rec.liveV210Offsets = findAll(liveHex, v210).map((i) => i / 2);

    // diff spans vs fixture ranges
    const spans = diffSpans(liveHex, artHex);
    rec.diffSpanCount = spans.length;
    rec.diffSpans = spans;
    rec.diffOutsideFixtureRanges = spans.filter(([s, l]) =>
      !FIXTURE_RANGES.some(([rs, rl]) => s >= rs && s + l <= rs + rl));
    rec.diffInsideFixtureRanges = spans.filter(([s, l]) =>
      FIXTURE_RANGES.some(([rs, rl]) => s >= rs && s + l <= rs + rl));
    // show first 12 diffs with live/artifact bytes
    rec.diffSamples = spans.slice(0, 12).map(([s, l]) => ({
      byteOffset: s / 2, lenBytes: l / 2,
      live: liveHex.slice(s, s + Math.min(l, 48)),
      artifact: artHex.slice(s, s + Math.min(l, 48)),
    }));
    out[name] = rec;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({
    status: out.status,
    block: out.block,
    factory: {
      liveBytes: out.factory.liveBytes, artifactBytes: out.factory.artifactBytes,
      metaStrippedEqual: out.factory.metaStrippedEqual,
      artifactMetaStripParsed: out.factory.artifactMetaStripParsed,
      liveMetaStripParsed: out.factory.liveMetaStripParsed,
      zeroedEqual: out.factory.zeroedLiveVsZeroedArtifactEqual,
      artifactRawMatchesFixtureRaw: out.factory.artifactRawMatchesFixtureRaw,
      artifactMetaStrippedMatchesFixture: out.factory.artifactMetaStrippedMatchesFixture,
      devOffsets: out.factory.artifactDevLiteralOffsets,
      liveV212: out.factory.liveV212Offsets, liveV210: out.factory.liveV210Offsets,
      diffSpanCount: out.factory.diffSpanCount,
      diffOutside: out.factory.diffOutsideFixtureRanges.length,
      diffInside: out.factory.diffInsideFixtureRanges.length,
      diffSamples: out.factory.diffSamples,
    },
    diamond: {
      liveBytes: out.diamond.liveBytes, artifactBytes: out.diamond.artifactBytes,
      metaStrippedEqual: out.diamond.metaStrippedEqual,
      diffSpanCount: out.diamond.diffSpanCount,
      diffSamples: out.diamond.diffSamples,
      devOffsets: out.diamond.artifactDevLiteralOffsets,
      liveV212: out.diamond.liveV212Offsets, liveV210: out.diamond.liveV210Offsets,
    },
    artifact: path.relative(WORKSPACE, OUT),
  }, null, 2));
}

main().catch((e) => { console.error("FATAL " + String(e.message || e).slice(0, 240)); process.exit(1); });
