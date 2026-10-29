#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require(path.join(__dirname, "node_modules", "ethers"));
const sharedRpc = require("./shared-rpc");

const RANGES = [
  [549, 32], [4196, 32], [4494, 32], [4820, 32],
  [10969, 32], [11248, 32], [11971, 32], [12163, 32],
  [1187, 32], [4156, 32], [4454, 32], [4780, 32],
  [11003, 32], [11208, 32], [11541, 32], [11924, 32],
  [12197, 32], [4236, 32], [4534, 32], [6964, 32],
  [11479, 32], [11878, 32], [12231, 32],
];

function findAscii(buf, s) { const n = Buffer.from(s, "utf8"); const out = []; let i = 0; for (;;) { i = buf.indexOf(n, i); if (i < 0) break; out.push(i); i += 1; } return out; }

async function main() {
  const ep = await sharedRpc.resolveRpc(1, null, { capability: "read" });
  const live = Buffer.from((await (await fetch(ep, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: ["0x44058C32B154A516F3b9DE2413e6cb938F93c3B4", "latest"] }),
  })).json()).result.slice(2), "hex");
  const art = Buffer.from(JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "targets", "term-finance-contracts-v2.1.2", "artifacts", "contracts", "factory",
      "TermRepoDeployerFactory.sol", "TermRepoDeployerFactory.json"), "utf8")).deployedBytecode.slice(2), "hex");

  const cborLen = parseInt(live.slice(-2).toString("hex"), 16);
  const codeEnd = live.length - (cborLen + 2);

  const spans = [];
  let start = -1;
  for (let i = 0; i < Math.min(live.length, art.length); i++) {
    if (live[i] !== art[i]) { if (start < 0) start = i; }
    else if (start >= 0) { spans.push([start, i - start]); start = -1; }
  }
  if (start >= 0) spans.push([start, Math.min(live.length, art.length) - start]);

  const inRange = (s, l) => RANGES.some(([rs, rl]) => s >= rs && s + l <= rs + rl);
  const codeSpans = spans.filter(([s, l]) => s + l <= codeEnd);
  const metaSpans = spans.filter(([s]) => s >= codeEnd);
  const codeInside = codeSpans.filter(([s, l]) => inRange(s, l));
  const codeOutside = codeSpans.filter(([s, l]) => !inRange(s, l));

  // zero ranges and metadata, compare code portion
  const zl = Buffer.from(live), za = Buffer.from(art);
  for (const [s, l] of RANGES) for (let i = s; i < s + l && i < zl.length; i++) { zl[i] = 0; za[i] = 0; }
  const codeEqualAfterImmZero = Buffer.compare(zl.subarray(0, codeEnd), za.subarray(0, codeEnd)) === 0;

  const out = {
    codeEnd,
    totalSpans: spans.length,
    codeSpans: codeSpans.length,
    metadataRegionSpans: metaSpans.length,
    codeSpansInsideImmRanges: codeInside.length,
    codeSpansOutsideImmRanges: codeOutside.length,
    codeOutsideSamples: codeOutside.slice(0, 20).map(([s, l]) => ({
      byteOffset: s, len: l,
      live: live.subarray(s, s + Math.min(l, 36)).toString("hex"),
      artifact: art.subarray(s, s + Math.min(l, 36)).toString("hex"),
    })),
    codeEqualAfterImmZero,
    versionLiterals: {
      development_live: findAscii(live, "development"),
      development_art: findAscii(art, "development"),
      v21_live: findAscii(live, "2.1."),
      v21_art: findAscii(art, "2.1."),
      developmentHex_live: findAscii(live, "dev"),
      developmentHex_art: findAscii(art, "dev"),
    },
    metadataEqual: Buffer.compare(live.subarray(codeEnd), art.subarray(codeEnd)) === 0,
    liveMetaTailSample: live.subarray(codeEnd, codeEnd + 64).toString("hex"),
    artMetaTailSample: art.subarray(codeEnd, codeEnd + 64).toString("hex"),
  };
  console.log(JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(__dirname, "..", "reports", "raw", "termdiag-step1-identity-check2.json"),
    JSON.stringify({ schema: "termdiag-step1-identity-check2/v1", generatedUtc: new Date().toISOString(), ...out }, null, 2) + "\n");
}

main().catch((e) => { console.error("FATAL " + String(e.message || e).slice(0, 200)); process.exit(1); });
